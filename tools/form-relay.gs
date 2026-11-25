// =============================================================================
// FORM RELAY — Les Brasseurs de l'Océan websites
// Receives form submissions from the Cloudflare Workers (privatisation requests for now),
// emails the pub and logs each request in this spreadsheet; also logs newsletter sign-ups.
//
// SETUP (once):
//   1. Create a Google Sheet "Demandes sites web" in the Brasseurs Drive, then
//      Extensions > Apps Script, paste this file.
//   2. Project Settings > Script Properties: add FORM_RELAY_SECRET = a long random string.
//   3. Run setup() once (authorises Gmail + Sheets, creates the tab).
//   4. Deploy > New deployment > Web app: Execute as "Me", Who has access "Anyone".
//      Copy the /exec URL.
//   5. Cloudflare > golden-apple Worker > Settings > Variables and Secrets:
//      FORM_RELAY_URL = the /exec URL, FORM_RELAY_SECRET = the same random string.
// The Worker fixes the recipient per venue, and this script only accepts calls carrying the secret.
// =============================================================================

var LOG_SHEET = 'Privatisations';
var HEADERS = ['Reçu le', 'Pub', 'Nom', 'E-mail', 'Téléphone', 'Date souhaitée',
               'Personnes', 'Type', 'Budget', 'Message', 'Envoyé à'];
var VENUE_NAMES = { 'golden-apple': 'The Golden Apple' };

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(LOG_SHEET) || ss.insertSheet(LOG_SHEET);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  MailApp.getRemainingDailyQuota(); // triggers the Gmail authorisation prompt
}

function doPost(e) {
  var d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad json' }); }
  var secret = PropertiesService.getScriptProperties().getProperty('FORM_RELAY_SECRET');
  if (!secret || d.secret !== secret) return out_({ ok: false, error: 'forbidden' });
  if (d.kind === 'newsletter') return newsletter_(d);
  if (d.kind !== 'privatisation' || !d.to) return out_({ ok: false, error: 'bad request' });

  var venue = VENUE_NAMES[d.venue] || d.venue;
  var lines = [
    'Nouvelle demande de privatisation — ' + venue, '',
    'Nom : ' + d.name,
    'E-mail : ' + d.email,
    'Téléphone : ' + (d.phone || '—'),
    'Date souhaitée : ' + d.date,
    'Nombre de personnes : ' + d.guests,
    "Type d'événement : " + (d.type || '—'),
    'Budget indicatif : ' + (d.budget || '—'), '',
    'Message :', d.message || '—', '',
    'Répondez directement à ce mail pour écrire au client.'
  ];
  MailApp.sendEmail({
    to: d.to,
    replyTo: d.email,
    name: venue + ' — site web',
    subject: 'Privatisation ' + d.date + ' · ' + d.guests + ' pers. · ' + d.name,
    body: lines.join('\n')
  });

  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET);
  if (sh) sh.appendRow([new Date(), venue, d.name, d.email, d.phone, d.date, d.guests,
                        d.type, d.budget, d.message, d.to]);
  return out_({ ok: true });
}

// Newsletter sign-ups: one row per address and pub (a repeat sign-up is ignored).
function newsletter_(d) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('Newsletter') || ss.insertSheet('Newsletter');
  if (sh.getLastRow() === 0) sh.appendRow(['Inscrit le', 'Pub', 'E-mail']);
  var email = String(d.email || '').trim().toLowerCase();
  var venue = VENUE_NAMES[d.venue] || d.venue;
  var rows = sh.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][2]).toLowerCase() === email && rows[i][1] === venue) return out_({ ok: true });
  }
  sh.appendRow([new Date(), venue, email]);
  return out_({ ok: true });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
