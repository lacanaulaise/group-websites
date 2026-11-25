// =============================================================================
// WEB EVENTS — Golden Apple events calendar → website
// Reads the monthly tabs of "CALENDRIER The Golden Apple" (one tab per month, a calendar grid:
// a grey row of day numbers, then the events of each day underneath, coloured by type),
// and writes a flat list to the tab EVENEMENTS GOLDEN APPLE of the "Carte site web" Sheet.
// That tab is published as CSV and read by the website (Worker /api/events).
//
// Event type comes from the cell colour, matched against the legend at the bottom of each tab
// (Foot, Rugby, Flechettes, Quizz, Need advertising). New monthly tabs are picked up automatically
// as long as row 1 says "Planning Détaillé - <MOIS> <ANNÉE>".
//
// SETUP (once), in the monora_pull Apps Script project (new file "WebEvents"):
//   1. Paste this file, save.
//   2. Run weExportEvents() once (authorises access to the calendar Sheet).
//   3. Run weInstallTrigger() (refreshes every hour).
//   4. In "Carte site web": Fichier > Partager > Publier sur le Web > tab EVENEMENTS GOLDEN APPLE,
//      format CSV > Publier. Send the CSV link to Claude (it becomes EVENTS_CSV_URL).
// =============================================================================

var WE_CALENDAR_ID = '1n-8KxXQ6iPzynbC9cQOzm1ouA7awKt7wkNdYQz6IJ7Q';
var WE_TARGET_ID = '1EKCWmnXdgpeOSb6p09WPf-E43yae3lHPRr1BerPKDZE';
var WE_TARGET_TAB = 'EVENEMENTS GOLDEN APPLE';
var WE_TZ = 'Europe/Paris';

var WE_MONTHS = { 'JANVIER': 1, 'FEVRIER': 2, 'MARS': 3, 'AVRIL': 4, 'MAI': 5, 'JUIN': 6, 'JUILLET': 7,
  'AOUT': 8, 'SEPTEMBRE': 9, 'OCTOBRE': 10, 'NOVEMBRE': 11, 'DECEMBRE': 12 };
// Legend label → category used by the website.
var WE_LEGEND = { 'foot': 'foot', 'rugby': 'rugby', 'flechettes': 'flechettes', 'quizz': 'quiz', 'quiz': 'quiz',
  'need advertising': 'special' };
// Cells that are opening notes, not events.
// Matched on the text without accents, in capitals.
var WE_SKIP = /^(CUISINE OUVERTE|OUVERTURE\b|NOUVEAUX HORAIRES|FERME\b)|\bDISPO\b/;

function weExportEvents() {
  var cal = SpreadsheetApp.openById(WE_CALENDAR_ID);
  var today = Utilities.formatDate(new Date(), WE_TZ, 'yyyy-MM-dd');
  var out = [];
  cal.getSheets().forEach(function (sh) {
    var month = weMonthOf_(sh);
    if (!month) return;
    weParseTab_(sh, month.y, month.m).forEach(function (e) { if (e.date >= today) out.push(e); });
  });
  out.sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });

  var rows = [['Date', 'Heure', 'Début', 'Titre', 'Catégorie', 'Onglet']];
  out.forEach(function (e) {
    var start = e.time ? weIso_(e.date, e.time) : '';
    rows.push([e.date, e.time, start, e.title, e.cat, e.tab]);
  });
  var ss = SpreadsheetApp.openById(WE_TARGET_ID);
  var t = ss.getSheetByName(WE_TARGET_TAB) || ss.insertSheet(WE_TARGET_TAB);
  t.clearContents();
  t.getRange(1, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
  t.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
  Logger.log(out.length + ' événements à venir exportés');
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

function weParseTab_(sh, year, month) {
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
      if (/^\d{1,2}[:h]\d{2}$/i.test(text)) { pending[c] = { time: text, bg: bg }; continue; }
      if (WE_SKIP.test(weNorm_(text))) { delete pending[c]; continue; }
      var time = '';
      var tm = text.match(/(\d{1,2})\s*[:h]\s*(\d{2})/i);
      if (tm) { time = ('0' + tm[1]).slice(-2) + ':' + tm[2]; text = text.replace(tm[0], ' '); }
      else if (pending[c]) { var pm = pending[c].time.match(/(\d{1,2})[:h](\d{2})/i); time = ('0' + pm[1]).slice(-2) + ':' + pm[2]; }
      var cat = colours[bg] || (pending[c] && colours[pending[c].bg]) || weGuess_(text);
      delete pending[c];
      var title = weTitle_(text);
      if (title) events.push({ date: colDate[c], time: time, title: title, cat: cat, tab: sh.getName() });
    }
  }
  return events;
}

function weTitle_(t) {
  t = t.replace(/!+/g, '').replace(/\s+/g, ' ').trim().replace(/^[-–·:,\s]+|[-–·:,\s]+$/g, '');
  return t.replace(/\bQuizz\b/gi, 'Quiz').replace(/\bFlechettes\b/gi, 'Fléchettes').replace(/\bvs\.?\b/gi, '/');
}

// Used only when a cell has no legend colour.
function weGuess_(t) {
  var n = weNorm_(t);
  if (/QUIZ/.test(n)) return 'quiz';
  if (/FLECHETTE|DART/.test(n)) return 'flechettes';
  if (/LIGUE DES NATIONS|LEAGUE NATIONS|PREMIER LEAGUE|LIGUE 1|CHAMPIONS/.test(n)) return 'foot';
  if (/TOP 14|UBB|RUGBY|FIDJI|FIJI|AFRIQUE|AFS|ARGENTIN|JAPON|IRELAND|IRLANDE|AUSTRALIE|ANGLET|NOUVELLE|ECOSSE|GALLES|SAMOA|TONGA|GEORGIE|STORMERS|TOULON|LA ROCHELLE|STADE/.test(n)) return 'rugby';
  if (/NFL/.test(n)) return 'special';
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
