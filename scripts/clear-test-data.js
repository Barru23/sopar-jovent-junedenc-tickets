/**
 * Script per netejar dades de prova i preparar la configuració de producció.
 *
 * Accions:
 * 1. Esborra tots els documents de 'transfers'
 * 2. Esborra tots els documents de 'pendingCheckouts'
 * 3. Esborra tots els documents de 'processedEvents'
 * 4. Configura 'config/event' amb els valors de producció (300 entrades, Plaça Melis, etc.)
 */

const admin = require("firebase-admin");

// Inicialitza Firebase Admin amb credencials per defecte de projecte
// Ús: GCLOUD_PROJECT=<el-teu-project-id> node scripts/clear-test-data.js
const projectId = process.env.GCLOUD_PROJECT;
if (!projectId) {
  console.error("❌ Defineix GCLOUD_PROJECT amb l'ID del projecte de Firebase.");
  process.exit(1);
}
if (!admin.apps.length) {
  admin.initializeApp({ projectId });
}

const db = admin.firestore();

async function deleteCollection(collectionPath, batchSize = 100) {
  const collectionRef = db.collection(collectionPath);
  const query = collectionRef.limit(batchSize);

  return new Promise((resolve, reject) => {
    deleteQueryBatch(query, resolve, reject);
  });
}

async function deleteQueryBatch(query, resolve, reject) {
  try {
    const snapshot = await query.get();
    if (snapshot.size === 0) {
      return resolve();
    }

    const batch = db.batch();
    snapshot.docs.forEach((doc) => {
      batch.delete(doc.ref);
    });

    await batch.commit();
    process.nextTick(() => {
      deleteQueryBatch(query, resolve, reject);
    });
  } catch (err) {
    reject(err);
  }
}

async function cleanAndSeed() {
  console.log("🧹 Iniciant neteja de dades de prova...");

  try {
    console.log("--> Eliminant col·lecció 'transfers'...");
    await deleteCollection("transfers");

    console.log("--> Eliminant col·lecció 'pendingCheckouts'...");
    await deleteCollection("pendingCheckouts");

    console.log("--> Eliminant col·lecció 'processedEvents'...");
    await deleteCollection("processedEvents");

    console.log("✨ Dades de prova eliminades amb èxit.");

    console.log("⚙️ Configurant l'esdeveniment de producció a 'config/event'...");
    await db.collection("config").doc("event").set({
      eventTitle: "Sopar del Jovent Junedenc",
      eventDate: "31 d'agost de 2026, 21h",
      eventLocation: "Plaça Melis, Juneda",
      ticketPriceEur: 28,
      totalTickets: 300,
      ticketsRemaining: 300,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log("✅ Esdeveniment de producció configurat correctament!");
    console.log("   - Títol: Sopar del Jovent Junedenc");
    console.log("   - Data: 31 d'agost de 2026, 21h");
    console.log("   - Ubicació: Plaça Melis, Juneda");
    console.log("   - Preu: 28 € (+ 0.75 € gestió)");
    console.log("   - Entrades totals: 300");
    console.log("   - Entrades restants: 300");

    process.exit(0);
  } catch (err) {
    console.error("❌ Error durant la neteja / configuració:", err);
    process.exit(1);
  }
}

cleanAndSeed();
