// Library sync between PCs, two ways:
// - a folder both PCs can see (a OneDrive, Google Drive or Dropbox folder, or a USB stick), or
// - a private GitHub repo of your own (Koru writes small JSON files into koru-sync/ with your key).
// Each PC writes only its own file (<this PC>-<device>.json) and reads the others, so two PCs never write the
// same file at once. The merging itself happens in the page (web/js/sync.js).
// The GitHub key is stored encrypted by Windows for your user account (Electron safeStorage) and is only
// ever sent to GitHub.
import { app, dialog, BrowserWindow, safeStorage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CONF = () => path.join(app.getPath('userData'), 'sync.json');
const GHKEY = () => path.join(app.getPath('userData'), 'sync-key.bin');
const GH_API = process.env.KORU_GH_API || 'https://api.github.com';   // KORU_GH_API: a stand-in GitHub for tests
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
const myFile = c => `${safeName(os.hostname())}-${c.device}.json`;

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

// ---------- GitHub ----------
function ghKey() { try { const b = fs.readFileSync(GHKEY()); return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : null; } catch { return null; } }
function setGhKey(k) {
  if (!k) { try { fs.unlinkSync(GHKEY()); } catch {} return; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows can\'t protect the key on this PC, so it wasn\'t saved.');
  fs.writeFileSync(GHKEY(), safeStorage.encryptString(k));
}
async function gh(pathname, { method = 'GET', body, key = ghKey(), raw = false } = {}) {
  const r = await fetch(GH_API + pathname, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'User-Agent': 'Koru-app', 'X-GitHub-Api-Version': '2022-11-28', Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      ...(key ? { Authorization: 'Bearer ' + key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(20000)
  });
  const text = await r.text();
  let j = null; if (!raw) { try { j = JSON.parse(text); } catch {} }
  if (!r.ok) {
    const msg = r.status === 401 ? 'GitHub didn\'t accept the key. It may have expired; make a new one.'
      : r.status === 403 ? (/rate limit/i.test(j?.message || '') ? 'GitHub says to slow down. Koru will try again later.' : 'That key can\'t write to the repo. Give it Contents: Read and write on this repo.')
      : r.status === 404 ? 'GitHub can\'t find that repo with this key. Check the name (owner/repo) and that the key has access to it.'
      : (j?.message || 'GitHub answered ' + r.status);
    throw Object.assign(new Error(msg), { status: r.status });
  }
  return raw ? text : j;
}
const repoPath = c => '/repos/' + c.gh.repo.split('/').map(encodeURIComponent).join('/');
const shas = new Map();   // file -> sha GitHub gave us last time (needed to replace a file)
const cache = new Map();  // file -> { sha, data } so unchanged files aren't downloaded again

async function ghList(c) {
  try { return (await gh(repoPath(c) + '/contents/koru-sync')).filter(f => f.type === 'file' && f.name.endsWith('.json')); }
  catch (e) { if (e.status === 404) return []; throw e; }   // no koru-sync folder yet
}

export async function syncRoute(request, url) {
  const sub = url.pathname.slice('/k/sync'.length) || '/';
  try {
    const c = conf();
    const mode = c.gh?.repo ? 'github' : c.dir ? 'folder' : null;
    if (sub === '/info') {
      const others = [];
      if (mode === 'folder') {
        const dir = folder(c);
        if (dir && fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json') || f.includes(c.device)) continue;
          try { const st = fs.statSync(path.join(dir, f)); others.push({ name: f.replace(/-[0-9a-f]{12}\.json$/, '').replace(/\.json$/, ''), at: st.mtimeMs }); } catch {}
        }
      } else if (mode === 'github' && url.searchParams.get('others')) {
        try { for (const f of await ghList(c)) if (!f.name.includes(c.device)) others.push({ name: f.name.replace(/-[0-9a-f]{12}\.json$/, '').replace(/\.json$/, '') }); } catch {}
      }
      return json(200, { mode, dir: c.dir || null, repo: c.gh?.repo || null, hasKey: !!ghKey(), reachable: mode === 'github' ? true : !!c.dir && fs.existsSync(c.dir), device: c.device, name: os.hostname(), others });
    }
    if (sub === '/pick' && request.method === 'POST') {
      const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
      const r = await dialog.showOpenDialog(win, { title: 'Pick a folder both PCs can see', properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return json(200, { dir: c.dir || null, canceled: true });
      c.dir = r.filePaths[0]; delete c.gh; save(c);
      fs.mkdirSync(folder(c), { recursive: true });
      return json(200, { dir: c.dir });
    }
    // connect a private GitHub repo: { repo: 'owner/name', key }
    if (sub === '/github' && request.method === 'POST') {
      let b = {}; try { b = JSON.parse(await request.text()); } catch {}
      const repo = String(b.repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
      const key = String(b.key || '').trim() || ghKey();
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json(400, { error: 'Write the repo as owner/name, like yourname/koru-sync.' });
      if (!key || !/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(key)) return json(400, { error: 'That doesn\'t look like a GitHub key. It starts with github_pat_.' });
      const info = await gh('/repos/' + repo.split('/').map(encodeURIComponent).join('/'), { key });
      if (!info.private) return json(400, { error: 'That repo is public. Use a private repo so your reading history stays yours.' });
      if (info.permissions && !info.permissions.push) return json(400, { error: 'That key can read the repo but can\'t write to it. Give it Contents: Read and write.' });
      setGhKey(key);
      c.gh = { repo: info.full_name || repo }; delete c.dir; save(c);
      shas.clear(); cache.clear();
      return json(200, { repo: c.gh.repo });
    }
    if (sub === '/off' && request.method === 'POST') { delete c.dir; delete c.gh; save(c); setGhKey(null); shas.clear(); cache.clear(); return json(200, { ok: true }); }

    if (!mode) return json(409, { error: 'Sync is off.' });

    if (mode === 'github') {
      if (!ghKey()) return json(409, { error: 'The GitHub key is missing on this PC. Connect the repo again.' });
      if (sub === '/read') {
        const files = [], mine = myFile(c);
        for (const f of await ghList(c)) {
          if (f.name === mine) { shas.set(f.name, f.sha); continue; }
          if (f.name.includes(c.device)) continue;
          const hit = cache.get(f.name);
          if (hit && hit.sha === f.sha) { files.push(hit.data); continue; }
          try { const data = JSON.parse(await gh(repoPath(c) + '/contents/koru-sync/' + encodeURIComponent(f.name), { raw: true })); cache.set(f.name, { sha: f.sha, data }); files.push(data); } catch {}
        }
        return json(200, { files });
      }
      if (sub === '/write' && request.method === 'PUT') {
        const body = await request.text();
        JSON.parse(body);
        const name = myFile(c), p = repoPath(c) + '/contents/koru-sync/' + encodeURIComponent(name);
        const put = sha => gh(p, { method: 'PUT', body: { message: 'Koru sync from ' + safeName(os.hostname()), content: Buffer.from(body).toString('base64'), ...(sha ? { sha } : {}) } });
        let r;
        try { r = await put(shas.get(name)); }
        catch (e) {
          if (e.status !== 409 && e.status !== 422) throw e;   // our idea of the file's version was out of date
          let sha; try { sha = (await gh(p)).sha; } catch {}
          r = await put(sha);
        }
        if (r?.content?.sha) shas.set(name, r.content.sha);
        return json(200, { ok: true });
      }
      return json(404, { error: 'Not found' });
    }

    const dir = folder(c);
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
      await writeShared(path.join(dir, myFile(c)), body);
      return json(200, { ok: true });
    }
    return json(404, { error: 'Not found' });
  } catch (e) { return json(e.status === 401 || e.status === 403 || e.status === 404 ? 400 : 500, { error: e.message || 'Sync error' }); }
}
