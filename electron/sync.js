// Library sync between PCs. You pick a folder both PCs can see (a OneDrive, Google Drive or Dropbox folder,
// or a USB stick). Each PC writes only its own file there (Koru-sync/<this PC>.json) and reads the others,
// so two PCs never write the same file at once. The merging itself happens in the page (web/js/sync.js).
import { app, dialog, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CONF = () => path.join(app.getPath('userData'), 'sync.json');
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
function conf() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONF(), 'utf8')) || {}; } catch {}
  if (!c.device) { c.device = crypto.randomBytes(6).toString('hex'); save(c); }
  return c;
}
function save(c) { try { fs.writeFileSync(CONF(), JSON.stringify(c)); } catch {} }
const folder = c => c.dir ? path.join(c.dir, 'Koru-sync') : null;
const safeName = s => String(s || 'PC').replace(/[^a-z0-9 _-]/gi, '').trim().slice(0, 30) || 'PC';

// OneDrive, Dropbox and the like briefly lock a file while they upload it, so replacing it can fail with
// EPERM/EBUSY for a moment. Try again a few times, then write it in place rather than fail the sync.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function writeShared(file, body) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body);
  for (let i = 0; i < 8; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) { if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch {} throw e; } }
    await sleep(150 + i * 150);
  }
  try { fs.writeFileSync(file, body); } finally { try { fs.unlinkSync(tmp); } catch {} }
}

export async function syncRoute(request, url) {
  const sub = url.pathname.slice('/k/sync'.length) || '/';
  try {
    const c = conf();
    if (sub === '/info') {
      const dir = folder(c), others = [];
      if (dir && fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json') || f.includes(c.device)) continue;
          try { const st = fs.statSync(path.join(dir, f)); others.push({ name: f.replace(/-[0-9a-f]{12}\.json$/, '').replace(/\.json$/, ''), at: st.mtimeMs }); } catch {}
        }
      }
      return json(200, { dir: c.dir || null, reachable: !!dir && fs.existsSync(c.dir), device: c.device, name: os.hostname(), others });
    }
    if (sub === '/pick' && request.method === 'POST') {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const r = await dialog.showOpenDialog(win, { title: 'Pick a folder both PCs can see', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return json(200, { dir: c.dir || null, canceled: true });
      c.dir = r.filePaths[0]; save(c);
      fs.mkdirSync(folder(c), { recursive: true });
      return json(200, { dir: c.dir });
    }
    if (sub === '/off' && request.method === 'POST') { delete c.dir; save(c); return json(200, { ok: true }); }
    const dir = folder(c);
    if (!dir) return json(409, { error: 'Sync is off.' });
    if (!fs.existsSync(c.dir)) return json(503, { error: 'The sync folder isn\'t reachable right now.' });
    fs.mkdirSync(dir, { recursive: true });
    if (sub === '/read') {
      const files = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json') || f.includes(c.device)) continue;
        try { files.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {}   // a half-synced file is skipped this time
      }
      return json(200, { files });
    }
    if (sub === '/write' && request.method === 'PUT') {
      const body = await request.text();
      JSON.parse(body);
      const file = path.join(dir, `${safeName(os.hostname())}-${c.device}.json`);
      await writeShared(file, body);
      return json(200, { ok: true });
    }
    return json(404, { error: 'Not found' });
  } catch (e) { return json(500, { error: e.message || 'Sync error' }); }
}
