// Kitsu's voice: a small language model that runs on this PC (llama.cpp through node-llama-cpp), no account, no key.
// The model isn't in the installer: "Give Kitsu its brain" on the Kitsu page downloads it once from Hugging Face into
// Koru's data folder (resumable, size and SHA-256 checked). It runs in its own utility process at below-normal
// priority, so reading stays smooth, and that process is closed a few minutes after Kitsu was last used (RAM back).
//   GET  /k/kitsu/status            what's downloaded, the download, whether the model is loaded
//   POST /k/kitsu/download {model}  start or resume a download      POST /k/kitsu/download/cancel
//   POST /k/kitsu/delete {model}    remove a downloaded model
//   POST /k/kitsu/warm {model}      load it now (the Kitsu page is open)      POST /k/kitsu/idle   the page closed
//   POST /k/kitsu/chat {...}        the reply, streamed as NDJSON lines: {t:'tok',v} {t:'tool',call,name,args} {t:'done',stats} {t:'err',msg}
//   POST /k/kitsu/tool {id,call,result}   the answer to a lookup the model asked for
import { app, utilityProcess } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MODELS = {
  smart: { name: 'Smart', label: 'Qwen2.5 1.5B Instruct', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', size: 1117320736, sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf' },
  fast: { name: 'Fast', label: 'Qwen2.5 0.5B Instruct', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', size: 491400032, sha256: '74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db',
    url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf' }
};
const IDLE_MS = 4 * 60e3;
const dir = () => path.join(process.env.KORU_KITSU_DIR || app.getPath('userData'), 'kitsu');
const fileOf = id => path.join(dir(), MODELS[id].file);
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const have = id => { try { return fs.statSync(fileOf(id)).size === MODELS[id].size; } catch { return false; } };
const partSize = id => { try { return fs.statSync(fileOf(id) + '.part').size; } catch { return 0; } };
let runtimeOk = null;
function runtime() {
  if (runtimeOk !== null) return runtimeOk;
  try { import.meta.resolve('node-llama-cpp'); runtimeOk = true; } catch { runtimeOk = false; }
  return runtimeOk;
}

// ---------- downloading the model ----------
let dl = null;   // { id, done, total, state: 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled', error, ctrl, at, bps }
async function download(id) {
  if (dl && (dl.state === 'downloading' || dl.state === 'verifying')) return;
  const m = MODELS[id];
  const part = fileOf(id) + '.part';
  const ctrl = new AbortController();
  dl = { id, done: partSize(id), total: m.size, state: 'downloading', error: '', ctrl, at: Date.now(), bps: 0 };   // set before any wait, so the status shows it at once
  const me = dl;
  try {
    await fsp.mkdir(dir(), { recursive: true });
    if (me.done > m.size) { await fsp.rm(part, { force: true }); me.done = 0; }
    if (me.done < m.size) {
      const r = await fetch(m.url, { headers: me.done ? { Range: `bytes=${me.done}-` } : {}, signal: ctrl.signal, redirect: 'follow' });
      if (!(r.ok || r.status === 206)) throw new Error('Hugging Face answered ' + r.status);
      if (me.done && r.status !== 206) me.done = 0;   // no resume offered: start over
      const out = fs.createWriteStream(part, { flags: me.done ? 'a' : 'w' });
      let lastT = Date.now(), lastB = me.done;
      try {
        for await (const chunk of r.body) {
          if (!out.write(chunk)) await new Promise(res => out.once('drain', res));
          me.done += chunk.length;
          const now = Date.now();
          if (now - lastT > 700) { me.bps = Math.round((me.done - lastB) / ((now - lastT) / 1000)); lastT = now; lastB = me.done; }
        }
      } finally { await new Promise(res => out.end(res)); }
    }
    me.state = 'verifying';
    const st = await fsp.stat(part);
    if (st.size !== m.size) throw new Error(`The download is ${st.size} bytes, expected ${m.size}.`);
    const h = crypto.createHash('sha256');
    await new Promise((res, rej) => fs.createReadStream(part, { highWaterMark: 1 << 20 }).on('data', d => h.update(d)).on('end', res).on('error', rej));
    if (h.digest('hex') !== m.sha256) { await fsp.rm(part, { force: true }); throw new Error('The file didn\'t check out (SHA-256), so it was removed. Try again.'); }
    await fsp.rename(part, fileOf(id));
    me.state = 'done';
  } catch (e) {
    if (ctrl.signal.aborted) me.state = 'cancelled';
    else { me.state = 'failed'; me.error = e?.message || String(e); }
  }
}

// ---------- the worker process ----------
let preloaded = '';
let child = null, childReady = null, loadedId = null, loading = null, idleT = 0, lastStats = null, lastExit = null, errTail = '';
const waits = new Map();   // request id -> { push(msg) }
let seq = 0;
function startChild() {
  if (child) return childReady;
  child = utilityProcess.fork(path.join(here, 'kitsu-llm-worker.js'), [], { serviceName: 'Koru Kitsu', stdio: 'pipe' });
  child.stderr?.on('data', d => { errTail = (errTail + d).slice(-1500); });
  child.stdout?.on('data', () => {});
  childReady = new Promise((res, rej) => {
    child.once('spawn', () => { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} });
    const t = setTimeout(() => rej(new Error('Kitsu\'s brain didn\'t start')), 20000);
    child.on('message', m => {
      if (m?.type === 'ready') { clearTimeout(t); res(); return; }
      const w = waits.get(m?.id);
      if (w) w.push(m);
    });
    child.once('exit', code => {
      lastExit = { code, at: Date.now(), err: errTail.trim().slice(-600) };
      clearTimeout(t); child = null; childReady = null; loadedId = null; loading = null; preloaded = '';
      for (const w of waits.values()) w.push({ type: 'err', msg: 'Kitsu\'s brain stopped' });
      waits.clear();
      rej(new Error('Kitsu\'s brain stopped'));
    });
  });
  childReady.catch(() => {});
  return childReady;
}
function call(type, payload, onMsg) {
  const id = ++seq;
  return new Promise((res, rej) => {
    waits.set(id, { push: m => { if (onMsg && m.type !== 'done' && m.type !== 'err') { onMsg(m); return; } waits.delete(id); m.type === 'err' ? rej(new Error(m.msg)) : res(m); if (onMsg) onMsg(m); } });
    child.postMessage({ type, id, ...payload });
  });
}
async function ensureLoaded(id) {
  if (!MODELS[id] || !have(id)) throw new Error('That model isn\'t downloaded');
  if (!runtime()) throw new Error('Kitsu\'s brain runtime isn\'t installed');
  await startChild();
  if (loadedId === id) return;
  if (loading?.id === id) return loading.p;
  const threads = Math.max(2, Math.min(4, Math.floor((os.availableParallelism?.() || os.cpus().length) / 2)));
  const p = call('load', { modelPath: fileOf(id), threads, gpu: process.env.KORU_KITSU_GPU || false }).then(m => { loadedId = id; lastStats = { ...(lastStats || {}), loadMs: m.ms, gpu: m.gpu, threads }; });
  loading = { id, p };
  try { await p; } finally { if (loading?.p === p) loading = null; }
}
// normal priority only while you wait for a reply on the Kitsu page; below normal otherwise, so reading stays smooth
const setPri = on => { try { if (child?.pid) os.setPriority(child.pid, on ? os.constants.priority.PRIORITY_NORMAL : os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} };
function touch() {
  clearTimeout(idleT);
  idleT = setTimeout(() => { if (waits.size) { touch(); return; } try { child?.kill(); } catch {} }, IDLE_MS);
}

export async function kitsuRoute(request, url) {
  try {
    const p = url.pathname, method = request.method;
    const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
    if (p === '/k/kitsu/status') {
      const models = Object.fromEntries(Object.entries(MODELS).map(([id, m]) => [id, { name: m.name, label: m.label, size: m.size, have: have(id), part: partSize(id) }]));
      const d = dl && { id: dl.id, done: dl.done, total: dl.total, state: dl.state, error: dl.error, bps: dl.bps };
      return json(200, { runtime: runtime(), models, dl: d, loaded: loadedId, loading: loading?.id || null, stats: lastStats, exit: lastExit });
    }
    if (p === '/k/kitsu/download' && method === 'POST') { if (!MODELS[body.model]) return json(400, { error: 'Unknown model' }); download(body.model); return json(200, { ok: true }); }
    if (p === '/k/kitsu/download/cancel' && method === 'POST') { dl?.ctrl?.abort(); return json(200, { ok: true }); }
    if (p === '/k/kitsu/delete' && method === 'POST') {
      if (!MODELS[body.model]) return json(400, { error: 'Unknown model' });
      if (loadedId === body.model) { try { child?.kill(); } catch {} }
      await fsp.rm(fileOf(body.model), { force: true }); await fsp.rm(fileOf(body.model) + '.part', { force: true });
      return json(200, { ok: true });
    }
    if (p === '/k/kitsu/warm' && method === 'POST') {
      touch();
      // the system prompt is read once per loaded model (again only if Kitsu's bio changed)
      ensureLoaded(body.model).then(() => { if (body.system && !waits.size && preloaded !== loadedId + body.system) { preloaded = loadedId + body.system; return call('preload', { system: body.system }); } }).catch(() => {});
      return json(200, { ok: true });
    }
    if (p === '/k/kitsu/idle' && method === 'POST') { setPri(false); clearTimeout(idleT); idleT = setTimeout(() => { if (!waits.size) try { child?.kill(); } catch {} }, 60e3); return json(200, { ok: true }); }
    if (p === '/k/kitsu/tool' && method === 'POST') { child?.postMessage({ type: 'tool-result', id: body.id, call: body.call, result: body.result }); return json(200, { ok: true }); }
    if (p === '/k/kitsu/chat' && method === 'POST') {
      touch();
      const pri = setPri;
      if (body.fg) pri(true);
      await ensureLoaded(body.model);
      const enc = new TextEncoder();
      let ctl, reqId = 0;
      const stream = new ReadableStream({
        start(c) {
          ctl = c;
          const t0 = Date.now();
          const send = o => { try { ctl.enqueue(enc.encode(JSON.stringify(o) + '\n')); } catch {} };
          const pr = call('chat', { system: body.system, history: body.history || [], prompt: body.prompt, maxTokens: body.maxTokens || 220, tools: body.tools || [], temperature: body.temperature },
            m => {
              if (!reqId) reqId = seq;
              if (m.type === 'tok') send({ t: 'tok', v: m.v });
              else if (m.type === 'tool') send({ t: 'tool', id: m.id, call: m.call, name: m.name, args: m.args });
              else if (m.type === 'done') { lastStats = { loadMs: lastStats?.loadMs, gpu: lastStats?.gpu, threads: lastStats?.threads, ...m.stats, wall: Date.now() - t0 }; send({ t: 'done', stats: lastStats }); }
            });
          reqId = seq;
          pr.catch(e => send({ t: 'err', msg: e.message })).finally(() => { pri(false); touch(); try { ctl.close(); } catch {} });
        },
        cancel() { child?.postMessage({ type: 'abort', id: reqId }); pri(false); }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
    }
    return json(404, { error: 'Not found' });
  } catch (e) { return json(500, { error: e?.message || String(e) }); }
}
app.on?.('before-quit', () => { try { child?.kill(); } catch {} });
