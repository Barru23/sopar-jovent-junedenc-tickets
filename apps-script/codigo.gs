// El token de seguretat NO es desa al codi.
// Configura'l a: Configuració del projecte (⚙️) > Propietats de l'script > SECURITY_TOKEN
// Ha de coincidir amb el secret 'APPS_SCRIPT_SECRET_TOKEN' de Firebase (genera'l amb: openssl rand -hex 32).
function getSecurityToken() {
  return PropertiesService.getScriptProperties().getProperty("SECURITY_TOKEN");
}

/**
 * Escapa text per inserir-lo de forma segura dins d'HTML.
 */
function escapeHtml(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Evita la injecció de fórmules al full de càlcul: qualsevol text que comenci per
 * = + - @ (o tabulador / retorn) es desa com a text pla amb un apòstrof davant.
 */
function safeCell(value) {
  if (typeof value !== "string") return value;
  return /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

/**
 * Hook per rebre peticions POST automàtiques des de Firebase.
 * S'executa immediatament quan algun usuari fa una compra online a través de Stripe.
 */
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);

    // Seguretat: comprovar el token (si no està configurat, es rebutja tot)
    var expectedToken = getSecurityToken();
    if (!expectedToken || payload.token !== expectedToken) {
      return ContentService.createTextOutput(JSON.stringify({status: "error", message: "Unauthorized"}))
             .setMimeType(ContentService.MimeType.JSON);
    }

    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var name = payload.name;
    var email = payload.email;
    var tickets = payload.tickets || 1;
    var price = payload.price || (tickets * 28.75).toFixed(2);
    var birthYears = payload.birthYears || "N/A";
    var ages = payload.ages || "N/A";
    var towns = payload.towns || "N/A";
    var kintas = payload.kintas || "N/A";
    var shirtSizes = payload.shirtSizes || "N/A";
    var vegans = payload.vegans || "No";
    var proposals = payload.proposals || "";
    var eventTitle = payload.eventTitle || "Sopar Festa Major";
    var eventDate = payload.eventDate || "";
    var eventLocation = payload.eventLocation || "";

    // Si el full està buit, escriu la capçalera
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["Data / Hora", "Nom i Cognoms", "Correu", "Any Naixement", "Edat", "Poble", "Kinta", "Talla Samarreta", "Sopar Vegà", "Propostes", "Estat Correus"]);   
    }

    // Afegir la fila al Full de Google (amb totes les columnes)
    var timestamp = new Date();
    sheet.appendRow([timestamp, name, email, birthYears, ages, towns, kintas, shirtSizes, vegans, proposals, "Pendent"].map(safeCell));
    var lastRow = sheet.getLastRow();
    
    // Enviar el correu de confirmació immediatament
    enviarCorreuIndividual(name, email, tickets, price, eventTitle, eventDate, eventLocation);
    
    // Actualitzar l'estat a "Enviat" a la columna 11
    sheet.getRange(lastRow, 11).setValue("Enviat");
    
    return ContentService.createTextOutput(JSON.stringify({status: "success", message: "Registre correcte i correu enviat."}))
           .setMimeType(ContentService.MimeType.JSON);
           
  } catch(error) {
    // Detall només als registres interns; la resposta no exposa errors interns
    Logger.log("doPost error: " + error.toString());
    return ContentService.createTextOutput(JSON.stringify({status: "error", message: "Internal error"}))
           .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Envia el correu electrònic a un destinatari individual en català.
 */
function enviarCorreuIndividual(nom, email, tiquets, preu, eventTitle, eventDate, eventLocation) {
  var assumpte = "Confirmació de compra: " + eventTitle + " 🍽️";

  // Versions escapades per al cos HTML (el text pla no les necessita)
  var nomHtml = escapeHtml(nom);
  var tiquetsHtml = escapeHtml(tiquets);
  var preuHtml = escapeHtml(preu);
  var eventTitleHtml = escapeHtml(eventTitle);
  var eventDateHtml = escapeHtml(eventDate);
  var eventLocationHtml = escapeHtml(eventLocation);

  // Cos en text pla
  var textBody = "Hola " + nom + ",\n\n" +
                 "Moltes gràcies per comprar els teus tiquets per al " + eventTitle + "!\n\n" +
                 "Aquí tens els detalls de la teva reserva:\n" +
                 "- Nom: " + nom + "\n" +
                 "- Nombre de tiquets: " + tiquets + "\n" +
                 "- Total pagat: " + preu + " €\n\n" +
                 "Ens veiem al sopar!\n\n" +
                 "Atentament,\n" +
                 "Organització de " + eventTitle;
  
  // Cos en HTML elegant
  var htmlBody = 
    "<div style='font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #ffffff;'>" +
      "<div style='text-align: center; padding-bottom: 20px; border-bottom: 2px solid #3182ce;'>" +
        "<h2 style='color: #2b6cb0; margin: 0;'>" + eventTitleHtml + "</h2>" +
        "<p style='color: #4a5568; font-size: 14px; margin: 5px 0 0 0;'>Confirmació oficial de reserva</p>" +
      "</div>" +
      "<div style='padding: 20px 0;'>" +
        "<p style='font-size: 16px; color: #2d3748;'>Hola <strong>" + nomHtml + "</strong>,</p>" +
        "<p style='font-size: 15px; line-height: 1.5; color: #4a5568;'>" +
          "Moltes gràcies per la teva compra de tiquets. Ja tenim la teva reserva registrada correctament per al <strong>" + eventTitleHtml + "</strong>. Estem desitjant compartir aquest moment amb tu!" +
        "</p>" +
        
        "<div style='background-color: #f7fafc; border: 1px solid #edf2f7; padding: 15px; border-radius: 6px; margin: 20px 0;'>" +
          "<h3 style='margin-top: 0; color: #2b6cb0; font-size: 16px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;'>Resum de la reserva:</h3>" +
          "<table style='width: 100%; border-collapse: collapse; font-size: 14px; color: #4a5568;'>" +
            "<tr><td style='padding: 6px 0;'><strong>Titular(s):</strong></td><td>" + nomHtml + "</td></tr>" +
            "<tr><td style='padding: 6px 0;'><strong>Tiquets:</strong></td><td>" + tiquetsHtml + "</td></tr>" +
            "<tr><td style='padding: 6px 0;'><strong>Preu total:</strong></td><td style='color: #38a169; font-weight: bold; font-size: 16px;'>" + preuHtml + " €</td></tr>" +
          "</table>" +
        "</div>" +
        
        (eventDateHtml || eventLocationHtml ? 
        "<div style='margin-bottom: 20px; font-size: 14px; color: #718096;'>" +
          (eventDateHtml ? "📅 <strong>Data:</strong> " + eventDateHtml + "<br>" : "") +
          (eventLocationHtml ? "📍 <strong>Lloc:</strong> " + eventLocationHtml + "<br>" : "") +
        "</div>" : "") +
        
        "<p style='font-size: 15px; line-height: 1.5; color: #4a5568;'>" +
          "Rebràs més detalls de l'esdeveniment pròximament. Si tens qualsevol dubte o vols fer alguna modificació, pots respondre directament a aquest correu." +
        "</p>" +
      "</div>" +
      "<div style='text-align: center; border-top: 1px solid #edf2f7; padding-top: 20px; color: #a0aec0; font-size: 12px;'>" +
        "<p style='margin: 0;'>Aquest correu s'ha enviat automàticament de forma gratuïta des de <strong>joventjunedenc@gmail.com</strong>.</p>" +
        "<p style='margin: 5px 0 0 0;'>Moltes gràcies per col·laborar amb la Festa Major!</p>" +
      "</div>" +
    "</div>";

  MailApp.sendEmail({
    to: email,
    subject: assumpte,
    body: textBody,
    htmlBody: htmlBody
  });
}

/**
 * Crea un menú personalitzat al full de càlcul quan s'obre.
 */
function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Sopar Festa Major')
      .addItem('Enviar correus pendents ✉️', 'processarCorreusPendents')
      .addToUi();
}

/**
 * Escaneja el full de càlcul i envia correus pendents (per a compres afegides manualment).
 */
function processarCorreusPendents() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var startRow = 2; 
  var lastRow = sheet.getLastRow();
  
  if (lastRow < startRow) {
    SpreadsheetApp.getActiveSpreadsheet().toast("No hi ha dades per processar.", "Info");
    return;
  }
  
  var numRows = lastRow - startRow + 1;
  var dataRange = sheet.getRange(startRow, 1, numRows, 11);
  var data = dataRange.getValues();
  var enviats = 0;
  
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var nom = row[1];
    var email = String(row[2]).trim();
    var tiquets = 1;
    var preu = "28.75";
    var estat = row[10];
    
    if (email && nom && estat !== "Enviat") {
      try {
        enviarCorreuIndividual(nom, email, tiquets, preu, "Sopar Festa Major", "", "");
        sheet.getRange(startRow + i, 11).setValue("Enviat");
        enviats++;
        Utilities.sleep(500); 
      } catch (e) {
        Logger.log("Error: " + e.toString());
        sheet.getRange(startRow + i, 11).setValue("Error: " + e.message);
      }
    }
  }
  
  if (enviats > 0) {
    SpreadsheetApp.getActiveSpreadsheet().toast("S'han enviat " + enviats + " correu(s).", "Èxit");
  } else {
    SpreadsheetApp.getActiveSpreadsheet().toast("No hi havia cap correu pendent.", "Info");
  }
}
