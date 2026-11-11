// Voice reader: Koru's side of the local voice engine (voice/server.py, Python).
// The engine runs only on this PC: free voices, reading the speech bubbles (OCR) and your own cloned voice.
// It's started the first time you use the voice reader, listens only on 127.0.0.1, and stops with Koru.
// The page talks to it through /k/voice/... here, so the page itself still can't reach any local port.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// inside the installed app the voice folder sits unpacked next to app.asar, so Python can read it
const VOICE_DIR = path.join(here, '..', 'voice').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const BASE = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Koru');
const PY = path.join(BASE, 'voice-env', 'Scripts', 'python.exe');
const PORT = Number(process.env.KORU_VOICE_PORT) || 5199;
const URL0 = `http://127.0.0.1:${PORT}`;

let proc = null, starting = null, setup = null, setupLog = '';
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const installed = () => fs.existsSync(PY) && fs.existsSync(path.join(VOICE_DIR, 'server.py'));

async function healthy() {
  try { const r = await fetch(URL0 + '/health', { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function ensure() {
  if (await healthy()) return true;
  if (!fs.existsSync(path.join(VOICE_DIR, 'setup.ps1'))) throw Object.assign(new Error('The voice reader is coming in the next update.'), { status: 409 });
  if (!installed()) throw Object.assign(new Error('Voices aren\'t set up yet. Open Settings → Voice reader → Set up voices.'), { status: 409 });
  if (!starting) {
    starting = (async () => {
      if (!proc || proc.exitCode !== null) {
        proc = spawn(PY, [path.join(VOICE_DIR, 'server.py')], {
          cwd: VOICE_DIR, windowsHide: true, stdio: 'ignore',
          env: { ...process.env, KORU_VOICE_PORT: String(PORT), KORU_VOICE_HOME: BASE, PYTHONIOENCODING: 'utf-8' }
        });
        proc.on('exit', () => { proc = null; });
      }
      for (let i = 0; i < 240; i++) { if (await healthy()) return true; if (!proc) break; await new Promise(r => setTimeout(r, 500)); }
      throw Object.assign(new Error('The voice engine didn\'t start.'), { status: 503 });
    })().finally(() => { starting = null; });
  }
  return starting;
}

export async function voiceRoute(request, url) {
  const sub = url.pathname.slice('/k/voice'.length) || '/';
  try {
    if (sub === '/status') {
      const h = await healthy();
      return json(200, { available: fs.existsSync(path.join(VOICE_DIR, 'setup.ps1')), installed: installed(), running: !!h, health: h, setup: setup ? 'running' : null, log: setupLog.slice(-1500) });
    }
    if (sub === '/setup' && request.method === 'POST') {
      if (!setup) {
        setupLog = '';
        setup = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(VOICE_DIR, 'setup.ps1')],
          { cwd: VOICE_DIR, windowsHide: true, env: { ...process.env, KORU_VOICE_HOME: BASE } });
        const add = d => { setupLog = (setupLog + d.toString()).slice(-20000); };
        setup.stdout.on('data', add); setup.stderr.on('data', add);
        setup.on('exit', code => { setupLog += `\n[setup finished: ${code === 0 ? 'ok' : 'failed ' + code}]`; setup = null; });
      }
      return json(200, { ok: true });
    }
    // your voice: the recording is saved in Koru's folder on this PC, then the engine learns it
    if (sub === '/clone-upload' && request.method === 'POST') {
      const buf = Buffer.from(await request.arrayBuffer());
      if (buf.length < 1000 || buf.length > 60e6) return json(400, { error: 'That recording looks empty or too big.' });
      const dir = path.join(BASE, 'my-voice');
      fs.mkdirSync(dir, { recursive: true });
      const ext = (url.searchParams.get('ext') || 'wav').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'wav';
      const file = path.join(dir, 'sample.' + ext);
      fs.writeFileSync(file, buf);
      await ensure();
      const r = await fetch(URL0 + '/clone', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: file, name: url.searchParams.get('name') || 'My voice' }), signal: AbortSignal.timeout(30 * 60e3) });
      return new Response(await r.arrayBuffer(), { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'application/json' } });
    }
    // everything else goes straight to the engine
    await ensure();
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());
    const r = await fetch(URL0 + sub + url.search, {
      method: request.method, body,
      headers: { 'Content-Type': request.headers.get('content-type') || 'application/octet-stream' },
      signal: AbortSignal.timeout(10 * 60e3)
    });
    return new Response(await r.arrayBuffer(), { status: r.status, headers: { 'Content-Type': r.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return json(e.status || 502, { error: e.message || 'Voice engine error' });
  }
}

export function stopVoice() {
  try { proc?.kill(); } catch {}
  proc = null;
}
