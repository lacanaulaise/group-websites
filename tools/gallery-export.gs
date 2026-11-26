/**
 * Web copies of a venue's photo folders, for the website galleries.
 *
 * Reads every image under SOURCE_FOLDER_ID (sub-folders included), asks Drive
 * for a 1600 px version (long edge) and packs them into zip files of about
 * 8 MB each, in a new folder "Copies web (site)" inside the source folder.
 * The original photos are only read, never moved or changed.
 *
 * Run galleryExport() once from a new Apps Script project (script.new),
 * logged in as james@lacanaulaise.fr, and accept the Drive permission.
 * If it stops at the 6-minute limit, just run it again: finished zips are kept
 * and their photos are skipped.
 */
const SOURCE_FOLDER_ID = '1Dy3roPOo_SnkrJmkvJrnwYkXnNlV934k'; // 05-Marketing Pub La Canaulaise
const OUT_NAME = 'Copies web (site)';
const LONG_EDGE = 1600;
const ZIP_MAX_BYTES = 8 * 1024 * 1024;

function galleryExport() {
  const started = Date.now();
  const src = DriveApp.getFolderById(SOURCE_FOLDER_ID);
  const out = getOrCreate_(src, OUT_NAME);

  // photos already packed in an earlier run (listed in done.txt)
  const doneFile = out.getFilesByName('done.txt');
  const doneTxt = doneFile.hasNext() ? doneFile.next() : null;
  const done = new Set(doneTxt ? doneTxt.getBlob().getDataAsString().split('\n').filter(String) : []);

  const images = [];
  collect_(src, '', images, out.getId());
  Logger.log(images.length + ' photos found, ' + done.size + ' already done');

  const token = ScriptApp.getOAuthToken();
  let batch = [], size = 0, zipNo = countZips_(out) + 1, newlyDone = [];

  const flush = () => {
    if (!batch.length) return;
    const name = 'photos-pub-' + String(zipNo).padStart(2, '0') + '.zip';
    out.createFile(Utilities.zip(batch.map(b => b.blob), name));
    batch.forEach(b => { done.add(b.id); newlyDone.push(b.id); });
    writeDone_(out, doneTxt, done);
    Logger.log(name + ': ' + batch.length + ' photos');
    zipNo++; batch = []; size = 0;
  };

  for (const img of images) {
    if (done.has(img.id)) continue;
    if (Date.now() - started > 5 * 60 * 1000) { flush(); Logger.log('Time limit: run again to continue'); return; }
    const meta = JSON.parse(UrlFetchApp.fetch(
      'https://www.googleapis.com/drive/v3/files/' + img.id + '?fields=thumbnailLink&supportsAllDrives=true',
      { headers: { Authorization: 'Bearer ' + token } }).getContentText());
    if (!meta.thumbnailLink) { Logger.log('No preview for ' + img.path); continue; }
    const url = meta.thumbnailLink.replace(/=s\d+$/, '=s' + LONG_EDGE);
    const resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) { Logger.log('Skipped ' + img.path + ' (' + resp.getResponseCode() + ')'); continue; }
    const blob = resp.getBlob().setName(img.path.replace(/\.(jpe?g|png|heic)$/i, '') + '__' + img.id + '.jpg');
    const n = blob.getBytes().length;
    if (size + n > ZIP_MAX_BYTES) flush();
    batch.push({ id: img.id, blob }); size += n;
  }
  flush();
  Logger.log('Finished: ' + newlyDone.length + ' photos added. Folder: ' + out.getUrl());
}

function collect_(folder, prefix, list, skipId) {
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (/^image\//.test(f.getMimeType())) list.push({ id: f.getId(), path: prefix + f.getName() });
  }
  const subs = folder.getFolders();
  while (subs.hasNext()) {
    const s = subs.next();
    if (s.getId() === skipId) continue;
    collect_(s, prefix + s.getName().replace(/[\/:]/g, '-') + '__', list, skipId);
  }
}

function getOrCreate_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function countZips_(folder) {
  let n = 0; const it = folder.getFiles();
  while (it.hasNext()) if (/\.zip$/.test(it.next().getName())) n++;
  return n;
}

function writeDone_(folder, existing, set) {
  const txt = Array.from(set).join('\n');
  const it = folder.getFilesByName('done.txt');
  if (it.hasNext()) it.next().setContent(txt); else folder.createFile('done.txt', txt);
}
