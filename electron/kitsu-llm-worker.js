// Kitsu's model, in its own utility process (started by kitsu-llm.js at below-normal priority).
// One chat sequence is kept between replies, so the system prompt and earlier turns stay in the cache and only the
// new message has to be read: that keeps the first word quick.
let lib = null, llama = null, model = null, context = null, sequence = null, modelPath = null;
const aborts = new Map(), toolWaits = new Map();
const post = m => process.parentPort.postMessage(m);

async function load({ id, modelPath: mp, threads, gpu }) {
  const t0 = Date.now();
  lib ||= await import('node-llama-cpp');
  if (!llama) llama = await lib.getLlama({ gpu: gpu || false, build: 'never', logLevel: lib.LlamaLogLevel?.error ?? 'error', progressLogs: false });
  if (model && modelPath !== mp) { await context?.dispose(); await model.dispose(); model = context = sequence = null; }
  if (!model) {
    model = await llama.loadModel({ modelPath: mp });
    context = await model.createContext({ contextSize: 2048, threads, batchSize: 256, flashAttention: true }).catch(() => model.createContext({ contextSize: 2048, threads, batchSize: 256 }));
    sequence = context.getSequence();
    modelPath = mp;
  }
  post({ type: 'loaded', id, ms: Date.now() - t0, gpu: llama.gpu || false });
}

async function chat({ id, system, history, prompt, maxTokens, tools, temperature }) {
  const ctrl = new AbortController(); aborts.set(id, ctrl);
  const t0 = Date.now(); let first = 0, n = 0;
  const session = new lib.LlamaChatSession({ contextSequence: sequence, systemPrompt: system || '', autoDisposeSequence: false });
  try {
    const hist = [{ type: 'system', text: system || '' }];
    for (const h of history || []) hist.push(h.role === 'user' ? { type: 'user', text: h.text } : { type: 'model', response: [h.text] });
    session.setChatHistory(hist);
    let functions;
    if (tools?.length) {
      functions = {};
      let calls = 0;
      for (const t of tools) functions[t.name] = lib.defineChatSessionFunction({
        description: t.description, params: t.params,
        handler: async args => {
          if (++calls > 2) return { note: 'No more lookups for this reply. Answer with what you have.' };
          const call = id + ':' + calls;
          post({ type: 'tool', id, call, name: t.name, args });
          return await new Promise(res => { toolWaits.set(call, res); setTimeout(() => { if (toolWaits.delete(call)) res({ error: 'timed out' }); }, 25000); });
        }
      });
    }
    await session.prompt(prompt, {
      maxTokens: maxTokens || 220, temperature: temperature ?? 0.6, topP: 0.9, repeatPenalty: { penalty: 1.12 }, signal: ctrl.signal, stopOnAbortSignal: true, functions,
      onTextChunk: t => { if (!first) first = Date.now(); n++; post({ type: 'tok', id, v: t }); }
    });
    const genMs = first ? Date.now() - first : 0;
    post({ type: 'done', id, stats: { ttft: first ? first - t0 : null, chunks: n, tps: genMs > 0 ? Math.round(n / (genMs / 1000) * 10) / 10 : null, ms: Date.now() - t0 } });
  } catch (e) {
    if (ctrl.signal.aborted) post({ type: 'done', id, stats: { aborted: true } });
    else post({ type: 'err', id, msg: e?.message || String(e) });
  } finally { aborts.delete(id); session.dispose({ disposeSequence: false }); }
}

// read the system prompt into the cache ahead of the first message
async function preload({ id, system }) {
  if (!sequence) { post({ type: 'done', id }); return; }
  const session = new lib.LlamaChatSession({ contextSequence: sequence, systemPrompt: system || '', autoDisposeSequence: false });
  try { await session.preloadPrompt(''); } finally { session.dispose({ disposeSequence: false }); }
  post({ type: 'done', id });
}
// the model reads one thing at a time
let queue = Promise.resolve();
const run = fn => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
process.parentPort.on('message', async e => {
  const m = e.data;
  try {
    if (m.type === 'load') await run(() => load(m)).then(() => post({ type: 'done', id: m.id, ms: 0 })).catch(err => post({ type: 'err', id: m.id, msg: err?.message || String(err) }));
    else if (m.type === 'chat') run(() => chat(m));
    else if (m.type === 'preload') run(() => preload(m)).catch(err => post({ type: 'err', id: m.id, msg: err?.message || String(err) }));
    else if (m.type === 'abort') aborts.get(m.id)?.abort();
    else if (m.type === 'tool-result') { const w = toolWaits.get(m.call); if (w) { toolWaits.delete(m.call); w(m.result ?? null); } }
  } catch (err) { post({ type: 'err', id: m.id, msg: err?.message || String(err) }); }
});
post({ type: 'ready' });
