// One-click updates: Koru looks at its GitHub releases, and "Update now" downloads the new installer and
// runs it silently. The installer closes Koru, installs over it (your library and settings stay) and opens
// it again. Only installers attached to this repo's releases are used.
// The repo is private, so GitHub only shows its releases to someone signed in: you paste a read-only key
// (a fine-grained token that can only read this repo) once in Settings → About. It's stored encrypted by
// Windows for your user account (Electron safeStorage) and only ever sent to api.github.com.
import { app, net, safeStorage } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import https from 'node:https';

const REPO = 'chiazorbryan-crypto/koru';
const API = `https://api.github.com/repos/${REPO}`;
const ASSET = /^Koru-Setup-(\d+\.\d+\.\d+)\.exe$/;
const KEYFILE = () => path.join(app.getPath('userData'), 'update-key.bin');

let latest = null, checkedAt = 0, job = null;   // job: { state, done, total, error }
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const parse = v => String(v || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
export const newer = (a, b) => { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };

function getKey() {
  try { const b = fs.readFileSync(KEYFILE()); return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : null; } catch { return null; }
}
function setKey(k) {
  if (!k) { try { fs.rmSync(KEYFILE(), { force: true }); } catch {} return; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows can\'t protect the key on this PC, so it wasn\'t saved.');
  fs.writeFileSync(KEYFILE(), safeStorage.encryptString(k));
}
const headers = (extra = {}) => { const k = getKey(); return { 'User-Agent': 'Koru-app', 'X-GitHub-Api-Version': '2022-11-28', ...(k ? { Authorization: 'Bearer ' + k } : {}), ...extra }; };

async function check(force) {
  if (latest && !force && Date.now() - checkedAt < 30 * 60e3) return latest;
  const r = await net.fetch(API + '/releases/latest', { headers: headers({ Accept: 'application/vnd.github+json' }) });
  if (r.status === 404 || r.status === 401) throw Object.assign(new Error(getKey() ? 'That GitHub key can\'t read the Koru repo. Check its access, or make a new one.' : 'Your Koru repo is private, so Koru needs a read-only GitHub key to see new versions.'), { code: 'key' });
  if (!r.ok) throw new Error(r.status === 403 ? 'GitHub is busy, try again in a bit.' : 'Couldn\'t reach GitHub (' + r.status + ').');
  const rel = await r.json();
  const asset = (rel.assets || []).find(a => ASSET.test(a.name));
  const version = (rel.tag_name || '').replace(/^v/, '');
  latest = {
    version, name: rel.name || 'Koru ' + version, notes: String(rel.body || '').slice(0, 4000), url: rel.html_url,
    asset: asset ? { name: asset.name, size: asset.size, api: asset.url } : null
  };
  checkedAt = Date.now();
  return latest;
}

// GitHub answers the asset request with a redirect to its file storage. The key goes to GitHub only:
// the redirect is followed by hand, without it.
const firstHop = (url, hdrs) => new Promise((resolve, reject) => {
  const req = https.get(url, { headers: hdrs }, r => { r.resume(); resolve({ status: r.statusCode, location: r.headers.location }); });
  req.on('error', reject);
  req.setTimeout(30000, () => req.destroy(new Error('GitHub took too long to answer.')));
});
export async function fetchAsset(apiUrl, hdrs) {
  const h = { ...hdrs, Accept: 'application/octet-stream' };
  const hop = await firstHop(apiUrl, h);
  if (hop.status >= 300 && hop.status < 400) {
    if (!hop.location || !/^https:\/\//.test(hop.location)) throw new Error('Unexpected download address.');
    return net.fetch(hop.location, { headers: { 'User-Agent': 'Koru-app' } });
  }
  if (hop.status === 200) return net.fetch(apiUrl, { headers: h });   // served straight from GitHub
  throw new Error('Download failed (' + hop.status + ').');
}

async function download(info) {
  const a = info.asset;
  if (!a || !a.api.startsWith(API + '/releases/assets/')) throw new Error('No installer found in that release.');
  const file = path.join(os.tmpdir(), a.name);
  job = { state: 'downloading', done: 0, total: a.size };
  const r = await fetchAsset(a.api, headers());
  if (!r.ok || !r.body) throw new Error('Download failed (' + r.status + ').');
  const out = fs.createWriteStream(file + '.part');
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      job.done += value.length;
      if (!out.write(Buffer.from(value))) await new Promise(res => out.once('drain', res));
    }
  } finally { await new Promise(res => out.end(res)); }
  if (job.done !== a.size) { fs.rmSync(file + '.part', { force: true }); throw new Error('The download was incomplete. Try again.'); }
  fs.renameSync(file + '.part', file);
  return file;
}

export async function updateRoute(request, url) {
  const sub = url.pathname.slice('/k/app-update'.length) || '/';
  try {
    if (sub === '/check') {
      const current = app.getVersion();
      let info;
      try { info = await check(url.searchParams.get('force') === '1'); }
      catch (e) { return json(e.code === 'key' ? 200 : 502, { current, needKey: e.code === 'key', hasKey: !!getKey(), error: e.message }); }
      return json(200, { current, latest: info.version, newer: newer(info.version, current) && !!info.asset, name: info.name, notes: info.notes, page: info.url, size: info.asset?.size || 0, hasKey: !!getKey(), canInstall: app.isPackaged && process.platform === 'win32' });
    }
    if (sub === '/key' && request.method === 'POST') {
      let k = '';
      try { k = String(JSON.parse(await request.text()).key || '').trim(); } catch {}
      if (k && !/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(k)) return json(400, { error: 'That doesn\'t look like a GitHub key. It starts with github_pat_.' });
      setKey(k || null); latest = null;
      return json(200, { ok: true, hasKey: !!k });
    }
    if (sub === '/status') return json(200, job || { state: 'idle' });
    if (sub === '/install' && request.method === 'POST') {
      if (!app.isPackaged || process.platform !== 'win32') return json(400, { error: 'Updates install from the installed Koru only.' });
      if (job?.state === 'downloading' || job?.state === 'installing') return json(200, { ok: true });
      const info = await check(true);
      if (!newer(info.version, app.getVersion())) return json(400, { error: 'You already have the newest Koru.' });
      (async () => {
        try {
          const file = await download(info);
          job.state = 'installing';
          // /S: silent install over the current one (same folder). --force-run: open Koru when it's done.
          spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          setTimeout(() => app.quit(), 800);
        } catch (e) { job = { state: 'failed', error: e.message, done: 0, total: 0 }; }
      })();
      return json(200, { ok: true });
    }
    return json(404, { error: 'Not found' });
  } catch (e) { return json(502, { error: e.message || 'Update error' }); }
}
