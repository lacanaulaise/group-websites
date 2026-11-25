// =============================================================================
// WEB EVENTS — pub events calendars → websites
// Reads the monthly tabs of each pub's calendar Sheet (one tab per month, a calendar grid:
// a grey row of day numbers, then the events of each day underneath, coloured by type)
// and writes a flat list of upcoming public events to a tab of the "Carte site web" Sheet.
// Each tab is published as CSV and read by that pub's website (Worker /api/events).
//
// Event type comes from the cell colour, matched against the legend at the bottom of each tab.
// Golden Apple: every legend colour is public (Foot, Rugby, Flechettes, Quizz, Need advertising).
// Pub La Canaulaise: ONLY cells coloured "EVENEMENTS AU PUB" (plus matches in a sport colour)
// are published — private hire, groups, markets, kitchen and Buvette notes stay private.
// New monthly tabs are picked up automatically as long as row 1 says
// "Planning Détaillé - <MOIS> <ANNÉE>".
//
// SETUP (once), in the monora_pull Apps Script project (file "WebEvents"):
//   1. Paste this file, save.
//   2. Run weExportEvents() once (authorises access to the calendar Sheets).
//   3. Run weInstallTrigger() (refreshes every hour).
//   4. In "Carte site web": Fichier > Partager > Publier sur le Web > each EVENEMENTS tab,
//      format CSV > Publier. Send the CSV links to Claude (they become EVENTS_CSV_URL).
// =============================================================================

var WE_TARGET_ID = '1EKCWmnXdgpeOSb6p09WPf-E43yae3lHPRr1BerPKDZE';
var WE_VENUES = [
  { name: 'Golden Apple', calendarId: '1n-8KxXQ6iPzynbC9cQOzm1ouA7awKt7wkNdYQz6IJ7Q',
    tab: 'EVENEMENTS GOLDEN APPLE', publicOnly: null },
  { name: 'Pub La Canaulaise', calendarId: '1p914OwjDaj9cHgv7sQ6FBOklaOnRPzjLMZaYzEVKYXI',
    tab: 'EVENEMENTS LA CANAULAISE', publicOnly: ['event'] }
];
var WE_TZ = 'Europe/Paris';

var WE_MONTHS = { 'JANVIER': 1, 'FEVRIER': 2, 'MARS': 3, 'AVRIL': 4, 'MAI': 5, 'JUIN': 6, 'JUILLET': 7,
  'AOUT': 8, 'SEPTEMBRE': 9, 'OCTOBRE': 10, 'NOVEMBRE': 11, 'DECEMBRE': 12 };
// Legend label → category used by the website.
var WE_LEGEND = { 'foot': 'foot', 'rugby': 'rugby', 'flechettes': 'flechettes', 'quizz': 'quiz', 'quiz': 'quiz',
  'need advertising': 'special',
  // Pub La Canaulaise legend
  'evenements au pub': 'event', 'restauration pub': 'private', 'privatisations': 'private',
  'marche': 'private', 'animations buvette': 'private' };
// Never published, whatever the colour: private bookings and internal notes.
var WE_PRIVATE = /PRIVAT|ANNIV|GROUPE|RESERV|\bAG\b|FERMETURE|\d+\s*P(ERS)?\b|\?\?/;
// Cells that are opening notes, not events.
// Matched on the text without accents, in capitals.
var WE_SKIP = /^(CUISINE OUVERTE|OUVERTURE\b|NOUVEAUX HORAIRES|FERME\b)|\bDISPO\b/;

function weExportEvents() {
  var today = Utilities.formatDate(new Date(), WE_TZ, 'yyyy-MM-dd');
  var thisMonth = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7));
  var ss = SpreadsheetApp.openById(WE_TARGET_ID);
  WE_VENUES.forEach(function (v) {
    try {
      var out = [];
      SpreadsheetApp.openById(v.calendarId).getSheets().forEach(function (sh) {
        var month = weMonthOf_(sh);
        if (!month) return;
        var n = month.y * 12 + month.m;
        if (n < thisMonth - 1 || n > thisMonth + 6) return; // only the coming months
        weParseTab_(sh, month.y, month.m, v).forEach(function (e) { if (e.date >= today) out.push(e); });
      });
      out.sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
      var rows = [['Date', 'Heure', 'Début', 'Titre', 'Catégorie', 'Onglet']];
      out.forEach(function (e) { rows.push([e.date, e.time, e.time ? weIso_(e.date, e.time) : '', e.title, e.cat, e.tab]); });
      var t = ss.getSheetByName(v.tab) || ss.insertSheet(v.tab);
      t.clearContents();
      t.getRange(1, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
      t.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
      Logger.log(v.name + ' : ' + out.length + ' événements à venir exportés');
    } catch (err) {
      Logger.log(v.name + ' : ÉCHEC — ' + err.message);
    }
  });
}

function weInstallTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (tr) {
    if (tr.getHandlerFunction() === 'weExportEvents') ScriptApp.deleteTrigger(tr);
  });
  ScriptApp.newTrigger('weExportEvents').timeBased().everyHours(1).create();
}

// Month and year from row 1 ("Planning Détaillé - NOVEMBRE 2026- …").
function weMonthOf_(sh) {
  var title = weNorm_(String(sh.getRange(1, 1).getDisplayValue()));
  var m = title.match(/(JANVIER|FEVRIER|MARS|AVRIL|MAI|JUIN|JUILLET|AOUT|SEPTEMBRE|OCTOBRE|NOVEMBRE|DECEMBRE)\s+(\d{4})/);
  return m ? { m: WE_MONTHS[m[1]], y: Number(m[2]) } : null;
}

function weParseTab_(sh, year, month, venue) {
  var range = sh.getDataRange();
  var vals = range.getDisplayValues();
  var bgs = range.getBackgrounds();

  // Legend: colour → category (the cells whose text is a legend label).
  var colours = {};
  for (var r = 0; r < vals.length; r++) {
    for (var c = 0; c < vals[r].length; c++) {
      var key = weNorm_(vals[r][c]).toLowerCase();
      if (WE_LEGEND[key]) colours[bgs[r][c].toLowerCase()] = WE_LEGEND[key];
    }
  }

  var events = [];
  var colDate = {};          // column → yyyy-MM-dd of the week being read
  var maxDay = 0;
  var pending = {};          // column → time-only cell waiting for its title (older tabs)
  for (r = 0; r < vals.length; r++) {
    var row = vals[r];
    var filled = row.filter(function (v) { return String(v).trim() !== ''; });
    if (!filled.length) continue;
    if (filled.every(function (v) { return WE_LEGEND[weNorm_(v).toLowerCase()]; })) break; // legend reached
    if (filled.every(function (v) { return /^\d{1,2}$/.test(String(v).trim()); })) {
      // Day-number row.
      colDate = {}; pending = {};
      var hasOne = filled.some(function (v) { return Number(v) === 1; });
      for (var c2 = 0; c2 < row.length; c2++) {
        var s = String(row[c2]).trim();
        if (!/^\d{1,2}$/.test(s)) continue;
        var d = Number(s), y = year, m = month;
        if (maxDay && d < maxDay - 20) { m++; }                    // spill into next month
        else if (!maxDay && hasOne && d > 20) { m--; }             // spill from previous month
        if (m > 12) { m = 1; y++; } if (m < 1) { m = 12; y--; }
        if (m === month && y === year) maxDay = Math.max(maxDay, d);
        colDate[c2] = y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2);
      }
      continue;
    }
    if (!Object.keys(colDate).length) continue; // title rows above the grid
    for (c = 0; c < row.length; c++) {
      var text = String(row[c]).replace(/\s+/g, ' ').trim();
      if (!text || !colDate[c]) continue;
      var bg = bgs[r][c].toLowerCase();
      if (/^\d{1,2}\s*[:h]\s*(\d{2})?$/i.test(text)) { pending[c] = { time: text, bg: bg }; continue; }
      if (WE_SKIP.test(weNorm_(text))) { delete pending[c]; continue; }
      var time = '';
      var tm = text.match(/\b(\d{1,2})\s*[:h]\s*(\d{2})?(?!\d)/i);
      if (tm && Number(tm[1]) < 24) { time = ('0' + tm[1]).slice(-2) + ':' + (tm[2] || '00'); text = text.replace(tm[0], ' '); }
      else if (pending[c]) { var pm = pending[c].time.match(/(\d{1,2})\s*[:h]\s*(\d{2})?/i); time = ('0' + pm[1]).slice(-2) + ':' + (pm[2] || '00'); }
      var legendCat = colours[bg] || (pending[c] && colours[pending[c].bg]) || '';
      delete pending[c];
      if (WE_PRIVATE.test(weNorm_(text))) continue;
      var cat = legendCat || weGuess_(text);
      if (venue.publicOnly) {
        // Only the public colour, or a match in a colour outside the legend.
        var sport = cat === 'rugby' || cat === 'foot';
        if (legendCat === 'event') cat = weGuess_(text);
        else if (!(legendCat === '' && sport)) continue;
      }
      if (cat === 'private') continue;
      var title = weTitle_(text);
      if (title) events.push({ date: colDate[c], time: time, title: title, cat: cat, tab: sh.getName() });
    }
  }
  return events;
}

function weTitle_(t) {
  t = t.replace(/!+/g, '').replace(/\s+/g, ' ').trim().replace(/^[-–·:,\s]+|[-–·:,\s]+$/g, '');
  t = t.replace(/^(rugby|foot)\s+(?=\S)/i, '').replace(/^\w/, function (c) { return c.toUpperCase(); });
  return t.replace(/\bQuizz\b/gi, 'Quiz').replace(/\bFlechettes\b/gi, 'Fléchettes').replace(/\bvs\.?\b/gi, '/');
}

// Used only when a cell has no legend colour.
function weGuess_(t) {
  var n = weNorm_(t);
  if (/QUIZ/.test(n)) return 'quiz';
  if (/FLECHETTE|DART/.test(n)) return 'flechettes';
  if (/^FOOT\b|LIGUE DES NATIONS|LEAGUE NATIONS|PREMIER LEAGUE|LIGUE 1|CHAMPIONS/.test(n)) return 'foot';
  if (/^RUGBY\b/.test(n)) return 'rugby';
  if (/TOP 14|UBB|RUGBY|FIDJI|FIJI|AFRIQUE|AFS|ARGENTIN|JAPON|IRELAND|IRLANDE|AUSTRALIE|ANGLET|NOUVELLE|ECOSSE|GALLES|SAMOA|TONGA|GEORGIE|STORMERS|TOULON|LA ROCHELLE|STADE/.test(n)) return 'rugby';
  if (/NFL/.test(n)) return 'special';
  if (/KARAOK/.test(n)) return 'karaoke';
  if (/CONCERT|SCENE|\bDJ\b|LIVE|BLIND|GROUPE/.test(n)) return 'concert';
  return n.indexOf('/') >= 0 ? 'foot' : 'special';
}

function weIso_(date, time) {
  var p = date.split('-'), h = time.split(':');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], +h[0], +h[1]));
  // Paris offset for that day (handles summer time).
  var off = Utilities.formatDate(d, WE_TZ, 'XXX');
  var local = new Date(d.getTime() - weOffsetMinutes_(off) * 60000);
  return Utilities.formatDate(local, WE_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function weOffsetMinutes_(off) {
  var m = off.match(/([+-])(\d{2}):?(\d{2})/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

function weNorm_(s) {
  return String(s).trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
}
