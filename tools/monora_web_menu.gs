// =============================================================================
// MONORA → CARTE SITE WEB
// Fichier ADDITIONNEL du projet monora_pull. Ne modifie ni Code.gs ni Items.gs.
// =============================================================================
// Autonome : n'utilise rien de Code.gs. Token Monora dédié (propriété MONORA_PROG_TOKEN,
// portée read:programmation), distinct du token reporting de MonoraAuth.
// Tous les noms de ce fichier sont préfixés wm / WM_ pour éviter tout conflit.
//
// Ce que fait le script : chaque matin, lit les articles de la caisse (API
// programmation Monora) et les écrit dans le classeur « Carte site web », un onglet
// par pub. Le site lit cet onglet (publié en CSV) pour afficher la carte et les prix.
//
// COLONNES (onglet par pub)
//   A posId | B Rubrique | C Nom caisse | D Prix TTC | E Prix happy hour | F Format |
//   G Sur l'écran | H Nom site | I Description | J Afficher | K Ordre | L Statut | M Mis à jour
//   Le script réécrit A–G, L, M. Il ne touche JAMAIS à H, I, J, K une fois remplis :
//   c'est là que James / les managers choisissent le nom affiché, la description,
//   si l'article apparaît (oui / non) et l'ordre dans sa rubrique.
//   Les articles retirés ou bloqués en caisse passent en Statut « retiré » (le site les cache).
//
// MISE EN ROUTE (une fois)
//   0. Monora > Integrations > My tokens : créer un token avec l'accès read:programmation,
//      puis Paramètres du projet > Propriétés du script : MONORA_PROG_TOKEN = ce token.
//   1. wmSetup()            -> crée le classeur « Carte site web » (ID gardé dans les
//                              propriétés du script) et l'onglet GOLDEN APPLE.
//   2. wmExportAll()        -> premier remplissage. Relire les colonnes H–K.
//   3. Fichier > Partager > Publier sur le Web : onglet GOLDEN APPLE, format CSV.
//      Copier l'URL et la mettre dans Cloudflare (Worker golden-apple, variable
//      CARTE_CSV_URL, type Texte).
//   4. wmInstallTrigger()   -> mise à jour quotidienne vers 6 h.
// =============================================================================

// keyboard + pages = the till screen (Clavier). An article counts as "on the screen" if it
// has a key, or sits in a folder (window) that has a key, at any depth.
var WM_SITES = [
  { key: 'golden-apple', tab: 'GOLDEN APPLE', site: '45304', carte: '384', brand: '44772',
    keyboard: 1002, pages: [11339, 11341, 11343, 11344, 11345] }
];
var WM_PROP_SHEET = 'WEB_MENU_SHEET_ID';
var WM_PROP_TOKEN = 'MONORA_PROG_TOKEN';
var WM_API = 'https://api.mypi.net/programmation/sites/';
var WM_HEADERS = ['posId', 'Rubrique', 'Nom caisse', 'Prix TTC', 'Prix happy hour', 'Format',
                  "Sur l'écran", 'Nom site', 'Description', 'Afficher', 'Ordre', 'Statut', 'Mis à jour'];

// Familles / sous-familles jamais affichées sur le site.
var WM_HIDDEN_FAMILIES = ['TABAC', 'BOUTIQUE', 'MESSAGE'];
var WM_HIDDEN_TITLES = /^(ADI |DIVERS|BIP |\+ )|FORMULE|3 EURO SHOT|4 EURO SHOOTER/;

// Sous-famille caisse -> rubrique du site.
var WM_RUBRIQUES = {
  'COCKTAILS': 'Cocktails',
  'CKTAIL SS ALCOOL': 'Sans alcool',
  'BIERE SS ALCOOL': 'Sans alcool',
  'ALCOOLS': 'Spiritueux & long drinks',
  'DIGESTIFS': 'Digestifs',
  'VINS': 'Vins',
  'SODAS': 'Softs',
  'BOISSONS CHAUDES': 'Boissons chaudes',
  'TAPAS': 'À partager',
  'PLATS': 'Burgers & plats',
  'DESSERT': 'Desserts',
  'BIERES EMPORTER': 'À emporter'
};

// Noms de caisse -> nom suggéré pour le site (appliqué seulement aux nouvelles lignes).
// Beer renames apply only to draught sizes (a cocktail is also called SOUR).
var WM_BEER_FIXES = [
  [/\bENG IPA\b/, 'English IPA'], [/\bOUEST IPA\b/, 'Ouest Coast IPA'],
  [/^PALE ALE\b/, 'Blonde'], [/^PILS\b/, 'Pils Session'], [/^SOUR\b/, 'La Grimace'],
  [/^MILKSHAKE\b/, 'Milky Mango'], [/^CIDER\b/, 'Cidre'], [/^STOUT\b/, 'Stout Orange']
];
var WM_NAME_FIXES = [
  [/\bDEVILS\b/, "DEVIL'S"], [/\bCAPTAINS\b/, "CAPTAIN'S"], [/^BTL\s*\.?/, 'BOUTEILLE '],
  [/\bMOEL\./, 'MOELLEUX']
];

// -----------------------------------------------------------------------------
// SETUP
// -----------------------------------------------------------------------------

function wmSetup() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(WM_PROP_SHEET);
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create('Carte site web');
  props.setProperty(WM_PROP_SHEET, ss.getId());
  WM_SITES.forEach(function (s) { wmSheet_(ss, s.tab); });
  var first = ss.getSheets()[0];
  if (first.getName() === 'Feuille 1' || first.getName() === 'Sheet1') {
    if (ss.getSheets().length > 1) ss.deleteSheet(first);
  }
  Logger.log('Classeur « Carte site web » : ' + ss.getUrl());
}

function wmInstallTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'wmExportAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('wmExportAll').timeBased().everyDays(1).atHour(6).create();
  Logger.log('Déclencheur quotidien wmExportAll installé (6 h).');
}

function wmSheet_(ss, tab) {
  var sh = ss.getSheetByName(tab) || ss.insertSheet(tab);
  sh.getRange(1, 1, 1, WM_HEADERS.length).setValues([WM_HEADERS])
    .setFontWeight('bold').setBackground('#1f3a2b').setFontColor('#f4efe3');
  sh.setFrozenRows(1);
  sh.getRange(1, 8, 1, 4).setBackground('#c1ac6e').setFontColor('#142a1f'); // colonnes éditables
  sh.setColumnWidth(3, 200); sh.setColumnWidth(8, 220); sh.setColumnWidth(9, 320);
  var rule = SpreadsheetApp.newDataValidation().requireValueInList(['oui', 'non'], true).build();
  sh.getRange('J2:J').setDataValidation(rule);
  return sh;
}

// -----------------------------------------------------------------------------
// EXPORT
// -----------------------------------------------------------------------------

function wmExportAll() {
  var id = PropertiesService.getScriptProperties().getProperty(WM_PROP_SHEET);
  if (!id) throw new Error('Lancez wmSetup() d\'abord.');
  var ss = SpreadsheetApp.openById(id);
  // Monora needs a token with the read:programmation scope for the article list.
  // Created in Monora > Integrations > My tokens, stored by James in this project's
  // Script Properties as MONORA_PROG_TOKEN (never in the code).
  var token = (PropertiesService.getScriptProperties().getProperty(WM_PROP_TOKEN) || '').trim()
              .replace(/^["']|["']$/g, '');
  if (!token) throw new Error('Propriété ' + WM_PROP_TOKEN + ' absente : créez un token Monora ' +
                              '(Integrations > My tokens, accès read:programmation) et collez-le ' +
                              'dans Paramètres du projet > Propriétés du script.');
  WM_SITES.forEach(function (s) { wmExportSite_(ss, s, token); });
}

function wmExportSite_(ss, s, token) {
  var articles = wmFetchArticles_(s, token);
  var reachable = wmReachable_(s, token);
  var sh = wmSheet_(ss, s.tab);
  var now = new Date();

  // Lignes existantes : on garde les colonnes éditables H–K par posId.
  var last = sh.getLastRow();
  var existing = {};
  if (last > 1) {
    sh.getRange(2, 1, last - 1, WM_HEADERS.length).getValues().forEach(function (r) {
      if (r[0] !== '') existing[String(r[0])] = r;
    });
  }

  var seen = {};
  var rows = [];
  articles.forEach(function (a) {
    if (a.blocked) return;
    var key = String(a.posId);
    seen[key] = true;
    var fam = (a.family && a.family.title) || '';
    var sub = (a.subfamily && a.subfamily.title) || '';
    var title = String(a.title || '').trim();
    var onScreen = !!reachable[String(a.posId)] || !!(a.keyboards && a.keyboards['Clavier']);
    var format = wmFormat_(title);
    var rubrique = wmRubrique_(fam, sub, format, title);
    var prev = existing[key];
    var hidden = !rubrique || WM_HIDDEN_FAMILIES.indexOf(fam) >= 0 || WM_HIDDEN_TITLES.test(title) || !a.price1;
    rows.push([
      a.posId, rubrique || '', title,
      (a.price1 || 0) / 100, a.price2 ? a.price2 / 100 : '', format,
      onScreen ? 'oui' : 'non',
      prev ? prev[7] : wmSuggestName_(title),
      prev ? prev[8] : '',
      prev ? prev[9] : (hidden || !onScreen ? 'non' : 'oui'),
      prev ? prev[10] : '',
      'actif', now
    ]);
  });
  // Articles disparus ou bloqués : gardés, marqués « retiré ».
  Object.keys(existing).forEach(function (k) {
    if (seen[k]) return;
    var r = existing[k].slice();
    r[11] = 'retiré'; r[12] = now;
    rows.push(r);
  });

  rows.sort(function (x, y) {
    return String(x[1]).localeCompare(String(y[1])) || String(x[7]).localeCompare(String(y[7]));
  });
  if (last > 1) sh.getRange(2, 1, last - 1, WM_HEADERS.length).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, WM_HEADERS.length).setValues(rows);
    sh.getRange(2, 4, rows.length, 2).setNumberFormat('0.00 €');
    sh.getRange(2, 13, rows.length, 1).setNumberFormat('dd/mm/yyyy hh:mm');
  }
  Logger.log(s.tab + ' : ' + rows.length + ' lignes (' + articles.length + ' articles caisse).');
}

function wmGet_(s, token, path) {
  var res = UrlFetchApp.fetch(WM_API + s.site + '/restaurant-menus/' + s.carte + '/' + path, {
    method: 'get', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, 'x-brand-id': s.brand, 'x-site-id': s.site }
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Monora ' + path + ' HTTP ' + res.getResponseCode() + ' : ' +
                    res.getContentText().substring(0, 200));
  }
  return JSON.parse(res.getContentText());
}

// posIds reachable from the till screen: keys, then folders (windows) on keys, recursively.
function wmReachable_(s, token) {
  var found = {}, windowsSeen = {}, queue = [];
  s.pages.forEach(function (pg) {
    var keys = wmGet_(s, token, 'keyboards/' + s.keyboard + '/pages/' + pg + '/keys');
    keys = Array.isArray(keys) ? keys : (keys.rowData || []);
    keys.forEach(function (k) {
      if (k.posArticle) found[String(k.posArticle.posId)] = true;
      if (k.posWindow) queue.push(k.posWindow.posId);
    });
  });
  while (queue.length) {
    var w = queue.shift();
    if (windowsSeen[w]) continue;
    windowsSeen[w] = true;
    var win = wmGet_(s, token, 'pos-windows/' + w);
    (win.items || []).forEach(function (it) {
      if (it.article) found[String(it.article.posId)] = true;
      var sub = it.window || it.subWindow || it.posWindow;
      if (sub && sub.posId != null) queue.push(sub.posId);
    });
    Utilities.sleep(300);
  }
  return found;
}

function wmFetchArticles_(s, token) {
  var all = [];
  for (var start = 0; start < 2000; start += 100) {
    var url = WM_API + s.site + '/restaurant-menus/' + s.carte +
              '/pos-articles?startRow=' + start + '&endRow=' + (start + 100);
    var res = UrlFetchApp.fetch(url, {
      method: 'get', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + token, 'x-brand-id': s.brand, 'x-site-id': s.site }
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('Monora pos-articles HTTP ' + res.getResponseCode() + ' : ' +
                      res.getContentText().substring(0, 200));
    }
    var rows = JSON.parse(res.getContentText()).rowData || [];
    all = all.concat(rows);
    if (rows.length < 100) break;
    Utilities.sleep(1000);
  }
  return all;
}

// -----------------------------------------------------------------------------
// RÈGLES
// -----------------------------------------------------------------------------

function wmFormat_(title) {
  var t = title.toUpperCase().replace(',', '.');
  if (/\b1\.5\s*L\b/.test(t)) return '1,5 L';
  if (/\b0?\.75\s*(CL|L)?\b|\b75\s*CL\b/.test(t)) return '75 cl';
  var m = t.match(/\b(\d{2})\s*CL\b/);
  return m ? m[1] + ' cl' : '';
}

// Articles with no sub-family in the till.
var WM_TITLE_RUBRIQUES = { 'COFFEE': 'Boissons chaudes', 'TEA': 'Boissons chaudes',
                           'EXPRESSO': 'Boissons chaudes', 'ALLONGE': 'Boissons chaudes' };

function wmRubrique_(fam, sub, format, title) {
  if (!sub && title && WM_TITLE_RUBRIQUES[title]) return WM_TITLE_RUBRIQUES[title];
  if (sub === 'BIERES') return format ? 'Bières à la pression' : 'Bières en bouteille';
  return WM_RUBRIQUES[sub] || '';
}

function wmSuggestName_(title) {
  var isDraught = !!wmFormat_(title);
  var t = title.replace(/\b(\d{2}\s*CL|1[.,]5\s*L|0?[.,]75\s*(CL|L)?)\b/gi, '').trim();
  if (isDraught) WM_BEER_FIXES.forEach(function (f) { t = t.replace(f[0], f[1]); });
  WM_NAME_FIXES.forEach(function (f) { t = t.replace(f[0], f[1]); });
  return t.toLowerCase().replace(/(^|[\s(-])([a-zàâçéèêëîïôûùüÿ])/g, function (m, a, b) {
    return a + b.toUpperCase();
  }).replace(/\bIpa\b/g, 'IPA').replace(/\b0%/g, '0 %').replace(/\s{2,}/g, ' ');
}
