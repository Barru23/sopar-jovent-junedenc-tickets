/**
 * Cloud Functions for Catalunya Event Ticket Sales — v2
 *
 * Endpoints:
 *   POST /api/create-checkout-session — Initiates a Stripe Checkout Session
 *   POST /api/webhook                — Handles Stripe webhook events + sends confirmation email
 *   GET  /api/tickets-remaining      — Returns the current remaining ticket count
 *   GET  /api/session-status         — Returns session details for the success page
 *   POST /api/admin/login            — Admin: exchange the password for a signed session token
 *   POST /api/admin/transfers        — Admin: list purchases (session token)
 *   POST /api/admin/update-event     — Admin: update event configuration (session token)
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

// ── Firebase Admin ──────────────────────────────────────────────────────────
admin.initializeApp();
const db = admin.firestore();

// ── Secrets (stored via: firebase functions:secrets:set <NAME>) ─────────────
// Restricted key (rk_live_…) with Checkout Sessions: Write and Refunds: Write (oversold orders)
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");
const adminPassword = defineSecret("ADMIN_PASSWORD"); // Password for the admin dashboard
const appsScriptWebAppUrl = defineSecret("APPS_SCRIPT_WEB_APP_URL");
const appsScriptSecretToken = defineSecret("APPS_SCRIPT_SECRET_TOKEN");

// ── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: true }));

// ── Helpers ─────────────────────────────────────────────────────────────────
function getStripe() {
  const Stripe = require("stripe");
  return new Stripe(stripeSecretKey.value());
}

const EVENT_CONFIG_REF = db.collection("config").doc("event");

// Allowed origins for Stripe redirect URLs. Anything else falls back to the default Hosting domain.
const PROJECT_ID = process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || "{}").projectId;
const ALLOWED_ORIGINS = [
  `https://${PROJECT_ID}.web.app`,
  `https://${PROJECT_ID}.firebaseapp.com`,
  "http://localhost:5000",
];

// Input limits for public checkout payloads
const MAX_LEN = { email: 254, fullName: 100, town: 80, shirtSize: 40, proposals: 450 };
const SHIRT_SIZES = ["S", "M", "L", "XL", "XXL"];

// Admin brute-force protection. The password is only checked at /admin/login, which hands back a
// signed session token; the dashboard works with that token. A flood of wrong passwords can therefore
// block NEW logins for one window, but never an admin who is already in.
// Per-client counting is best-effort: behind Firebase Hosting the client address comes from
// X-Forwarded-For, which a script can forge. The global ceiling is what bounds a forged-header attack.
const LIMIT_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGINS_PER_CLIENT = 10;
const ADMIN_LOGINS_GLOBAL = 100;
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;

// Checkout sessions one client may open per window. Stops naive scripts from filling Firestore and
// Stripe with abandoned sessions; a GCP budget alert is the backstop for anything that forges headers.
const CHECKOUTS_PER_CLIENT = 10;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanString(value, maxLen) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest();
}

/**
 * Best-effort client key: a hash of the first X-Forwarded-For hop. A script can forge it, so it only
 * ever feeds per-client limits that sit under a global ceiling or a budget alert.
 * @param {object} req Express request
 * @return {string} opaque key, never the raw address
 */
function clientKey(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return crypto.createHash("sha256").update(`client:${forwarded || req.ip || "unknown"}`).digest("hex").slice(0, 32);
}

/**
 * Fixed-window counter in Firestore. Records one hit and returns true while `name` is under `limit`
 * hits in the current window; a blocked hit writes nothing. `expireAt` lets a TTL policy purge old docs.
 * @param {string} name counter id
 * @param {number} limit hits allowed per window
 * @return {Promise<boolean>} true when the request may proceed
 */
async function consumeLimit(name, limit) {
  const ref = db.collection("rateLimits").doc(name);
  return db.runTransaction(async (transaction) => {
    const doc = await transaction.get(ref);
    const data = doc.exists ? doc.data() : {};
    const now = Date.now();
    const inWindow = data.windowStart && now - data.windowStart < LIMIT_WINDOW_MS;
    const count = inWindow ? data.count || 0 : 0;
    if (count >= limit) return false;
    const windowStart = inWindow ? data.windowStart : now;
    transaction.set(ref, {
      count: count + 1,
      windowStart,
      expireAt: admin.firestore.Timestamp.fromMillis(windowStart + LIMIT_WINDOW_MS),
    });
    return true;
  });
}

// Session tokens are `<expiresAt>.<HMAC>`, keyed by a value derived from ADMIN_PASSWORD: rotating the
// password logs everyone out, and a leaked token reveals nothing about the password.
function signSession(expiresAt) {
  const key = crypto.createHmac("sha256", adminPassword.value()).update("admin-session-v1").digest();
  return crypto.createHmac("sha256", key).update(String(expiresAt)).digest("base64url");
}

function validSession(token) {
  if (typeof token !== "string") return false;
  const [rawExpiry, signature] = token.split(".");
  const expiresAt = Number(rawExpiry);
  if (!signature || !Number.isSafeInteger(expiresAt) || expiresAt < Date.now()) return false;
  const expected = Buffer.from(signSession(expiresAt));
  const given = Buffer.from(signature);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/**
 * Guard for admin data endpoints: requires a valid `Authorization: Bearer <session token>`.
 * Sends the error response itself and returns false when the request must stop.
 * @param {object} req Express request
 * @param {object} res Express response
 * @return {boolean} true when the caller may proceed
 */
function requireAdmin(req, res) {
  if (!adminPassword.value()) {
    res.status(500).json({ error: "El codi d'accés de l'administrador no està configurat." });
    return false;
  }
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (validSession(token)) return true;
  res.status(401).json({ error: "La sessió ha caducat. Torna a entrar." });
  return false;
}

// ── Email HTML Template ─────────────────────────────────────────────────────
function buildConfirmationEmail({ attendees, email, eventTitle, eventDate, eventLocation, proposals, amountEur }) {
  // Normalize attendees to array
  const attList = Array.isArray(attendees) ? attendees : [];
  email = escapeHtml(email);
  eventTitle = escapeHtml(eventTitle);
  eventDate = escapeHtml(eventDate);
  eventLocation = escapeHtml(eventLocation);
  proposals = escapeHtml(proposals);

  const attendeesTableRows = attList.map((a) => {
    const veganText = a.vegan === "true" || a.vegan === true ? "Sí 🌱" : "No";
    return `
      <tr style="border-bottom: 1px solid #2a0a0a;">
        <td style="padding: 12px 8px; color: #fff; font-weight: 600; font-size: 14px;">${escapeHtml(a.fullName) || "—"}</td>
        <td style="padding: 12px 8px; color: #ccc; font-size: 13px;">${escapeHtml(a.town) || "—"} (${escapeHtml(a.birthYear) || "—"})</td>
        <td style="padding: 12px 8px; color: #ccc; font-size: 13px; text-align: center;">${a.kinta ? "Kinta " + escapeHtml(a.kinta) : "Sense Kinta"}</td>
        <td style="padding: 12px 8px; color: #e2c97e; font-size: 13px; text-align: center; font-weight: 700;">👕 ${escapeHtml(a.shirtSize) || "—"}</td>
        <td style="padding: 12px 8px; color: #fff; font-size: 13px; text-align: right;">${veganText}</td>
      </tr>
    `;
  }).join("");

  const proposalsSection = proposals ?
    `<tr>
        <td colspan="5" style="padding: 15px 8px; border-top: 1px solid #3d1515; color: #aaa; font-size: 13px; line-height: 1.5;">
          <strong style="color: #fff; display: block; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 1px; font-size: 11px;">Propostes i suggeriments:</strong>
          ${proposals}
        </td>
      </tr>` :
    "";

  return `<!DOCTYPE html>
<html lang="ca">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Entrada confirmada — World Cup Edition</title>
</head>
<body style="margin:0;padding:0;background:#0d0505;font-family:'Segoe UI',Arial,sans-serif;">
  <div style="max-width:580px;margin:40px auto;background:#1a0a0a;border-radius:16px;overflow:hidden;border:1px solid #c9a84c33;box-shadow:0 20px 40px rgba(0,0,0,0.8);">

    <!-- Header World Cup Theme -->
    <div style="background:linear-gradient(135deg,#dc2626 0%,#991b1b 60%,#580c0c 100%);padding:40px 32px;text-align:center;position:relative;">
      <div style="width:68px;height:68px;background:rgba(201,168,76,0.2);border:2px solid #c9a84c;border-radius:50%;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;">
        <span style="font-size:36px;">🏆</span>
      </div>
      <span style="display:inline-block;padding:3px 12px;background:rgba(201,168,76,0.25);border:1px solid #c9a84c;border-radius:20px;color:#e2c97e;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">WORLD CUP EDITION</span>
      <h1 style="color:white;margin:4px 0 8px;font-size:26px;font-weight:800;">Entrada confirmada!</h1>
      <p style="color:rgba(255,255,255,0.85);margin:0;font-size:15px;">El teu pagament s'ha processat correctament</p>
    </div>

    <!-- Body -->
    <div style="padding:32px;">
      <p style="color:#e5e5e5;font-size:16px;margin:0 0 24px;">
        Gràcies per registrar-te a <strong>${eventTitle}</strong>.
        A continuació trobaràs el resum de la teva reserva.
      </p>

      <!-- Event details -->
      <div style="background:#2a0a0a;border-radius:12px;padding:20px;margin-bottom:24px;border:1px solid #3d1515;">
        <p style="margin:0 0 4px;color:#e2c97e;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Esdeveniment</p>
        <p style="margin:0 0 12px;color:white;font-size:18px;font-weight:700;">${eventTitle}</p>
        <p style="margin:0 0 4px;color:#aaa;font-size:14px;">📅 ${eventDate}</p>
        <p style="margin:0;color:#aaa;font-size:14px;">📍 ${eventLocation}</p>
      </div>

      <!-- Attendees Table -->
      <div style="background:#2a0a0a;border-radius:12px;padding:20px;margin-bottom:24px;border:1px solid #3d1515;">
        <p style="margin:0 0 12px;color:#e2c97e;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Resum d'assistents (${attList.length})</p>
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="border-bottom:1px solid #3d1515;text-align:left;">
              <th style="padding:8px;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Nom</th>
              <th style="padding:8px;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;">Dades</th>
              <th style="padding:8px;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;text-align:center;">Grup</th>
              <th style="padding:8px;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;text-align:center;">Talla 👕</th>
              <th style="padding:8px;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;text-align:right;">Vegà</th>
            </tr>
          </thead>
          <tbody>
            ${attendeesTableRows}
          </tbody>
        </table>
      </div>

      <!-- Detail table -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #2a0a0a;color:#aaa;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Correu de contacte</td>
          <td style="padding:10px 0;border-bottom:1px solid #2a0a0a;color:#fff;font-weight:600;text-align:right;">${email}</td>
        </tr>
        ${proposalsSection}
        <tr>
          <td style="padding:15px 0;color:#aaa;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Import total pagat (gestió inclosa)</td>
          <td style="padding:15px 0;color:#4ade80;font-weight:700;font-size:18px;text-align:right;">${amountEur} €</td>
        </tr>
      </table>

      <p style="color:#888;font-size:13px;text-align:center;margin:0;">
        Prepara la samarreta i vine a gaudir! ⚽🏆<br>
        Si tens qualsevol dubte, respon directament a aquest correu.
      </p>
    </div>

    <!-- Footer -->
    <div style="padding:20px 32px;border-top:1px solid #2a0a0a;text-align:center;background:#140707;">
      <p style="margin:0;color:#666;font-size:12px;">Sopar del Jovent Junedenc — World Cup Edition 2026</p>
      <p style="margin:4px 0 0;color:#444;font-size:11px;">Pagament processat de forma segura per Stripe.</p>
    </div>
  </div>
</body>
</html>`;
}

// ── GET /tickets-remaining ──────────────────────────────────────────────────
const router = express.Router();

router.get("/tickets-remaining", async (_req, res) => {
  try {
    const doc = await EVENT_CONFIG_REF.get();
    if (!doc.exists) {
      return res.status(500).json({ error: "Event configuration not found. Run the seed script first." });
    }
    const data = doc.data();
    // Let the Hosting CDN absorb bursts instead of hitting Firestore on every page view
    res.set("Cache-Control", "public, max-age=30, s-maxage=30");
    return res.json({
      ticketsRemaining: data.ticketsRemaining,
      totalTickets: data.totalTickets,
      eventTitle: data.eventTitle,
      eventDate: data.eventDate,
      eventLocation: data.eventLocation,
      ticketPriceEur: data.ticketPriceEur,
    });
  } catch (err) {
    console.error("Error fetching ticket count:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── POST /create-checkout-session ───────────────────────────────────────────
router.post("/create-checkout-session", express.json(), async (req, res) => {
  try {
    const { attendees: rawAttendees } = req.body || {};
    const email = cleanString(req.body?.email, MAX_LEN.email);
    const rawProposals = req.body?.proposals ?? "";
    const proposals = typeof rawProposals === "string" ? rawProposals.trim() : null;

    // ── Validate required fields ──────────────────────────────────────────
    if (!Array.isArray(rawAttendees) || rawAttendees.length === 0 || rawAttendees.length > 3) {
      return res.status(400).json({ error: "Dades de la reserva no vàlides. Selecciona entre 1 i 3 entrades." });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      return res.status(400).json({ error: "Adreça de correu electrònic no vàlida." });
    }

    if (proposals === null || proposals.length > MAX_LEN.proposals) {
      return res.status(400).json({ error: `Les propostes no poden superar els ${MAX_LEN.proposals} caràcters.` });
    }

    // Validate each attendee and keep only known fields
    const attendees = [];
    for (let i = 0; i < rawAttendees.length; i++) {
      const att = rawAttendees[i] || {};
      const fullName = cleanString(att.fullName, MAX_LEN.fullName);
      const town = cleanString(att.town, MAX_LEN.town);
      const kinta = cleanString(String(att.kinta ?? ""), 4);
      const shirtSize = cleanString(att.shirtSize, MAX_LEN.shirtSize);
      if (!fullName || !town || !kinta || !shirtSize) {
        return res.status(400).json({ error: `Si us plau, omple tots els camps per a l'assistent ${i + 1} (revisa també la llargada).` });
      }
      const year = parseInt(att.birthYear, 10);
      if (isNaN(year) || year < 1920 || year > new Date().getFullYear()) {
        return res.status(400).json({ error: `Any de naixement no vàlid per a l'assistent ${i + 1}.` });
      }
      if (!/^\d{4}$/.test(kinta)) {
        return res.status(400).json({ error: `Kinta no vàlida per a l'assistent ${i + 1}.` });
      }
      const customSize = shirtSize.startsWith("Altra:") && shirtSize.slice(6).trim().length > 0;
      if (!SHIRT_SIZES.includes(shirtSize) && !customSize) {
        return res.status(400).json({ error: `Talla de samarreta no vàlida per a l'assistent ${i + 1}.` });
      }
      attendees.push({
        fullName,
        birthYear: String(year),
        town,
        kinta,
        shirtSize,
        vegan: att.vegan === true || att.vegan === "true",
      });
    }

    // ── Check ticket availability ─────────────────────────────────────────
    const eventDoc = await EVENT_CONFIG_REF.get();
    if (!eventDoc.exists) {
      return res.status(500).json({ error: "Event configuration not found." });
    }

    const eventData = eventDoc.data();
    if (eventData.ticketsRemaining < attendees.length) {
      return res.status(409).json({ error: `Ho sentim, només queden ${eventData.ticketsRemaining} entrades disponibles.` });
    }

    // Counted only once the booking is valid, so a typo never uses up a buyer's attempts.
    if (!(await consumeLimit(`checkout:${clientKey(req)}`, CHECKOUTS_PER_CLIENT))) {
      return res.status(429).json({ error: "Massa intents de compra seguits. Espera uns minuts i torna-ho a provar." });
    }

    // ── Create Stripe Checkout Session ────────────────────────────────────
    const stripe = getStripe();
    const priceInCents = Math.round((eventData.ticketPriceEur + 0.75) * 100);
    const siteOrigin = ALLOWED_ORIGINS.includes(req.headers.origin) ? req.headers.origin : ALLOWED_ORIGINS[0];

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      currency: "eur",
      customer_email: email,
      metadata: {
        email,
        attendeeCount: String(attendees.length),
        proposals: proposals || "",
      },
      line_items: [
        {
          price_data: {
            currency: "eur",
            product_data: {
              name: eventData.eventTitle,
              description: `${eventData.eventDate} — ${eventData.eventLocation} (${attendees.length} ${attendees.length === 1 ? "entrada" : "entrades"})`,
            },
            unit_amount: priceInCents,
          },
          quantity: attendees.length,
        },
      ],
      success_url: `${siteOrigin}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteOrigin}/cancel`,
    });

    // Save pending checkout registration details.
    // `expireAt` is used by a Firestore TTL policy to purge abandoned checkouts (see README).
    await db.collection("pendingCheckouts").doc(session.id).set({
      email,
      attendees,
      proposals: proposals || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expireAt: admin.firestore.Timestamp.fromMillis(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating checkout session:", err);
    return res.status(500).json({ error: "No s'ha pogut crear la sessió de pagament." });
  }
});

// ── GET /session-status ─────────────────────────────────────────────────────
router.get("/session-status", express.json(), async (req, res) => {
  try {
    const { session_id: sessionId } = req.query;
    if (!sessionId) {
      return res.status(400).json({ error: "Missing session_id parameter." });
    }

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Look up the transfers by stripeSessionId
    const transfersSnap = await db
      .collection("transfers")
      .where("stripeSessionId", "==", sessionId)
      .get();

    const attendees = [];
    transfersSnap.forEach((doc) => {
      attendees.push(doc.data());
    });

    if (attendees.length > 0) {
      const names = attendees.map((a) => a.fullName).join(", ");
      const towns = [...new Set(attendees.map((a) => a.town))].join(", ");
      const kintas = [...new Set(attendees.map((a) => a.kinta))].map((k) => `Kinta ${k}`).join(", ");
      const shirtSizes = attendees.map((a) => a.shirtSize || "N/A").join(", ");
      const veganCount = attendees.filter((a) => a.vegan).length;
      const veganStr = veganCount > 0 ? `Sí 🌱 (${veganCount})` + (veganCount < attendees.length ? `, No (${attendees.length - veganCount})` : "") : "No";

      return res.json({
        status: session.payment_status,
        customerEmail: session.customer_email || session.customer_details?.email || "",
        customerName: names,
        birthYear: attendees.map((a) => a.birthYear).join(", "),
        town: towns,
        kinta: kintas,
        shirtSize: shirtSizes,
        vegan: veganStr,
        proposals: attendees.map((a) => a.proposals).filter(Boolean).join("; ") || "",
        amountTotal: session.amount_total,
        currency: session.currency,
      });
    } else {
      // Fallback if transaction is pending or not yet processed in webhook
      const pendingDoc = await db.collection("pendingCheckouts").doc(sessionId).get();
      if (pendingDoc.exists) {
        const pendingData = pendingDoc.data();
        const pendingAttendees = pendingData.attendees || [];
        const names = pendingAttendees.map((a) => a.fullName).join(", ");
        const towns = [...new Set(pendingAttendees.map((a) => a.town))].join(", ");
        const kintas = [...new Set(pendingAttendees.map((a) => a.kinta))].map((k) => `Kinta ${k}`).join(", ");
        const shirtSizes = pendingAttendees.map((a) => a.shirtSize || "N/A").join(", ");
        const veganCount = pendingAttendees.filter((a) => a.vegan).length;
        const veganStr = veganCount > 0 ? `Sí 🌱 (${veganCount})` + (veganCount < pendingAttendees.length ? `, No (${pendingAttendees.length - veganCount})` : "") : "No";

        return res.json({
          status: session.payment_status,
          customerEmail: session.customer_email || session.customer_details?.email || pendingData.email || "",
          customerName: names,
          birthYear: pendingAttendees.map((a) => a.birthYear).join(", "),
          town: towns,
          kinta: kintas,
          shirtSize: shirtSizes,
          vegan: veganStr,
          proposals: pendingData.proposals || "",
          amountTotal: session.amount_total,
          currency: session.currency,
        });
      }
    }

    return res.json({
      status: session.payment_status,
      customerEmail: session.customer_details?.email || session.customer_email,
      customerName: session.customer_details?.name || "—",
      amountTotal: session.amount_total,
      currency: session.currency,
    });
  } catch (err) {
    console.error("Error fetching session status:", err);
    return res.status(500).json({ error: "Could not retrieve session status." });
  }
});

// ── POST /webhook ───────────────────────────────────────────────────────────
router.post("/webhook", async (req, res) => {
  const stripe = getStripe();
  const sig = req.headers["stripe-signature"];
  const rawBody = req.rawBody || req.body;

  let event;

  // ── 1. Verify webhook signature ───────────────────────────────────────
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      stripeWebhookSecret.value(),
    );
  } catch (err) {
    console.error(`Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ── 2. Handle checkout.session.completed ──────────────────────────────
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    try {
      // ── 3. Idempotency check ────────────────────────────────────────
      const processedRef = db.collection("processedEvents").doc(event.id);
      const processedDoc = await processedRef.get();

      if (processedDoc.exists) {
        console.log(`Event ${event.id} already processed. Skipping.`);
        return res.json({ received: true });
      }

      // ── 4. Atomic ticket decrement + transfer creation ──────────────
      const pendingRef = db.collection("pendingCheckouts").doc(session.id);
      const oversoldRef = db.collection("oversold").doc(session.id);
      let attendees = [];
      let email = session.customer_email || "";
      let proposals = "";
      let oversold = false;

      await db.runTransaction(async (transaction) => {
        oversold = false;
        const eventDoc = await transaction.get(EVENT_CONFIG_REF);
        if (!eventDoc.exists) {
          throw new Error("Event configuration not found.");
        }

        const pendingDoc = await transaction.get(pendingRef);
        if (pendingDoc.exists) {
          const pendingData = pendingDoc.data();
          attendees = pendingData.attendees || [];
          email = pendingData.email || email;
          proposals = pendingData.proposals || "";
        } else {
          // Fallback to metadata (old style)
          const meta = session.metadata || {};
          attendees = [{
            fullName: meta.fullName || "",
            birthYear: meta.birthYear || null,
            town: meta.town || "",
            kinta: meta.kinta || "",
            shirtSize: meta.shirtSize || "",
            vegan: meta.vegan === "true",
          }];
          email = meta.email || email;
          proposals = meta.proposals || "";
        }

        const qty = attendees.length;
        const remaining = eventDoc.data().ticketsRemaining;
        if (remaining < qty) {
          // Checkout does not hold seats, so the last ones can be paid for twice. Throwing here would make
          // Stripe retry for three days while the buyer has paid without a ticket: record it, mark the
          // event processed and refund below.
          oversold = true;
          transaction.set(oversoldRef, {
            email,
            attendeeCount: qty,
            amountTotal: session.amount_total || 0,
            stripePaymentIntentId: session.payment_intent || null,
            refundStatus: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          transaction.set(processedRef, { processedAt: admin.firestore.FieldValue.serverTimestamp() });
          return;
        }

        // Decrement ticket count
        transaction.update(EVENT_CONFIG_REF, {
          ticketsRemaining: admin.firestore.FieldValue.increment(-qty),
        });

        // Create transfer documents for each attendee
        attendees.forEach((att) => {
          const transferRef = db.collection("transfers").doc();
          const ticketToken = crypto.randomUUID();
          transaction.set(transferRef, {
            fullName: att.fullName || "",
            email: email,
            birthYear: att.birthYear ? parseInt(att.birthYear, 10) : null,
            town: att.town || "",
            kinta: att.kinta || "",
            shirtSize: att.shirtSize || "",
            vegan: att.vegan === true || att.vegan === "true",
            proposals: proposals,
            ticketToken: ticketToken,
            amountEur: (session.amount_total || 0) / (100 * qty), // price split
            paymentStatus: "completed",
            stripeSessionId: session.id,
            stripePaymentIntentId: session.payment_intent || null,
            stripeEventId: event.id,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        });

        // Mark event as processed (idempotency)
        transaction.set(processedRef, {
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      if (oversold) {
        try {
          if (!session.payment_intent) throw new Error("Session has no payment intent");
          await stripe.refunds.create(
            { payment_intent: session.payment_intent },
            { idempotencyKey: `oversold-${session.id}` },
          );
          await oversoldRef.update({ refundStatus: "refunded" });
          console.warn(`Oversold session ${session.id} refunded automatically.`);
        } catch (refundErr) {
          // Most likely the restricted key lacks Refunds: Write. The admin dashboard flags it.
          await oversoldRef.update({ refundStatus: "failed", refundError: String(refundErr.message).slice(0, 300) });
          console.error(`Oversold session ${session.id} needs a manual refund:`, refundErr.message);
        }
        return res.json({ received: true });
      }

      console.log(`✅ ${attendees.length} tickets issued for session ${session.id}`);

      // ── 5. Save to Google Sheet & Send confirmation email via Apps Script ────
      try {
        const eventDoc = await EVENT_CONFIG_REF.get();
        const eventData = eventDoc.data();
        
        const webAppUrl = appsScriptWebAppUrl.value();
        const secretToken = appsScriptSecretToken.value();

        if (webAppUrl && webAppUrl !== "PENDING" && webAppUrl !== "") {
          const emailHtml = buildConfirmationEmail({
            attendees,
            email,
            eventTitle: eventData.eventTitle || "Sopar del Jovent Junedenc",
            eventDate: eventData.eventDate || "",
            eventLocation: eventData.eventLocation || "",
            proposals,
            amountEur: ((session.amount_total || 0) / 100).toFixed(2),
          });

          const currentYear = new Date().getFullYear();
          const payload = {
            token: secretToken,
            name: attendees.map((a) => a.fullName).join(", "),
            email: email,
            tickets: attendees.length,
            price: ((session.amount_total || 0) / 100).toFixed(2),
            birthYears: attendees.map((a) => a.birthYear || "N/A").join(", "),
            ages: attendees.map((a) => a.birthYear ? (currentYear - Number(a.birthYear)) : "N/A").join(", "),
            towns: attendees.map((a) => a.town || "N/A").join(", "),
            kintas: attendees.map((a) => a.kinta ? `Kinta ${a.kinta}` : "Sense Kinta").join(", "),
            shirtSizes: attendees.map((a) => a.shirtSize || "N/A").join(", "),
            vegans: attendees.map((a) => a.vegan ? "Sí 🌱" : "No").join(", "),
            proposals: proposals || "",
            eventTitle: eventData.eventTitle || "Sopar del Jovent Junedenc",
            eventDate: eventData.eventDate || "",
            eventLocation: eventData.eventLocation || "",
            htmlBody: emailHtml,
          };

          const response = await fetch(webAppUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });

          if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
          }

          const result = await response.json();
          console.log("📧 Apps Script Response:", result);
        } else {
          console.log("⚠️ Apps Script Web App URL not configured. Skipping Sheet sync and Gmail confirmation.");
        }
      } catch (sheetErr) {
        // Non-fatal — tickets are already created in database. Log and continue.
        console.error("Failed to send confirmation email or write to Sheet:", sheetErr.message);
      }
    } catch (err) {
      console.error(`Error processing webhook event ${event.id}:`, err);
      return res.status(500).json({ error: "Webhook processing failed." });
    }
  }

  return res.json({ received: true });
});

// ── Admin Endpoints ─────────────────────────────────────────────────────────
router.post("/admin/login", express.json(), async (req, res) => {
  try {
    const expectedPassword = adminPassword.value();
    if (!expectedPassword) {
      return res.status(500).json({ error: "El codi d'accés de l'administrador no està configurat." });
    }
    const allowed = await consumeLimit(`admin-login:${clientKey(req)}`, ADMIN_LOGINS_PER_CLIENT) &&
      await consumeLimit("admin-login:global", ADMIN_LOGINS_GLOBAL);
    if (!allowed) return res.status(429).json({ error: "Massa intents. Torna-ho a provar d'aquí a un quart d'hora." });

    const ok = crypto.timingSafeEqual(hashSecret(req.body?.password), hashSecret(expectedPassword));
    if (!ok) return res.status(401).json({ error: "Contrasenya incorrecta." });

    const expiresAt = Date.now() + ADMIN_SESSION_MS;
    return res.json({ token: `${expiresAt}.${signSession(expiresAt)}` });
  } catch (err) {
    console.error("Error during admin login:", err);
    return res.status(503).json({ error: "No s'ha pogut iniciar la sessió. Torna-ho a provar." });
  }
});

router.post("/admin/transfers", express.json(), async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    const snapshot = await db.collection("transfers").orderBy("createdAt", "desc").get();
    const transfers = [];
    snapshot.forEach((doc) => {
      transfers.push({
        id: doc.id,
        ...doc.data(),
        createdAt: doc.data().createdAt?.toDate() || null,
      });
    });

    const eventDoc = await EVENT_CONFIG_REF.get();
    const eventData = eventDoc.exists ? eventDoc.data() : {};

    const oversoldSnap = await db.collection("oversold").where("refundStatus", "!=", "refunded").get();
    const unrefunded = oversoldSnap.docs.map((doc) => ({ sessionId: doc.id, ...doc.data(),
      createdAt: doc.data().createdAt?.toDate() || null }));

    return res.json({ transfers, event: eventData, unrefunded });
  } catch (err) {
    console.error("Error fetching transfers:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/admin/update-event", express.json(), async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;

    const { eventTitle, eventDate, eventLocation, ticketPriceEur, totalTickets, ticketsRemaining } = req.body;

    const updates = {};
    const textFields = { eventTitle, eventDate, eventLocation };
    for (const [key, value] of Object.entries(textFields)) {
      if (value === undefined) continue;
      const clean = cleanString(value, 200);
      if (!clean) return res.status(400).json({ error: `Valor no vàlid per a ${key}.` });
      updates[key] = clean;
    }
    const numberFields = { ticketPriceEur, totalTickets, ticketsRemaining };
    for (const [key, value] of Object.entries(numberFields)) {
      if (value === undefined) continue;
      const num = Number(value);
      if (!Number.isFinite(num) || num < 0 || num > 100000) {
        return res.status(400).json({ error: `Valor no vàlid per a ${key}.` });
      }
      updates[key] = key === "ticketPriceEur" ? num : Math.floor(num);
    }

    await EVENT_CONFIG_REF.update(updates);
    return res.json({ success: true });
  } catch (err) {
    console.error("Error updating event config:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Note: there is intentionally no "reset/wipe" endpoint exposed over HTTP.
// Use scripts/clear-test-data.js locally (requires Firebase credentials) for that.

// ── Mount router on both paths (works both via Hosting rewrite and direct URL)
app.use("/api", router);
app.use("/", router);

// ── Export as Firebase Cloud Function (v2) ──────────────────────────────────
exports.api = onRequest(
  {
    secrets: [
      stripeSecretKey,
      stripeWebhookSecret,
      adminPassword,
      appsScriptWebAppUrl,
      appsScriptSecretToken,
    ],
    region: "europe-west1",
    maxInstances: 10,
  },
  app,
);
