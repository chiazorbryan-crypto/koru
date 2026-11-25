// check.mjs - runs web/kitsunet/golden.json through web/js/kitsunet.js (the app's own code, unchanged)
// and checks it gives the same answers as the Python training code, to 1e-5. Also times both networks
// and checks profileFrom on a made-up Koru library.
//   node kitsunet/check.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..', 'web');
const TOL = 1e-5;
let fetches = 0;
const store = new Map();
// the page's globals, then the script as the browser runs it (in this realm, so the timing is realistic)
Object.assign(globalThis, {
  K: {}, window: globalThis,
  localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
  fetch: async p => { fetches++; const f = path.join(web, p); return { ok: fs.existsSync(f), status: fs.existsSync(f) ? 200 : 404, json: async () => JSON.parse(fs.readFileSync(f, 'utf8')) }; }
});
vm.runInThisContext(fs.readFileSync(path.join(web, 'js', 'kitsunet.js'), 'utf8'), { filename: 'kitsunet.js' });
const ctx = globalThis;
const N = ctx.K.kitsuNet;
const fail = [];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

if (fetches) fail.push('kitsunet.js fetched its files before anyone asked for K.kitsuNet.ready');
let early = null;
try { N.intent('hi'); } catch (e) { early = e; }
if (!early) fail.push('intent() before ready should say it is still loading');
await N.ready;
if (N.ready !== N.ready) fail.push('ready should be the same promise every time');
const gold = JSON.parse(fs.readFileSync(path.join(web, 'kitsunet', 'golden.json'), 'utf8'));

// ---------- intent ----------
let worstI = 0;
for (const g of gold.intent) {
  const pcs = N._test.pieces(g.text);
  if (!same(pcs, g.pieces)) { fail.push(`pieces differ for ${JSON.stringify(g.text)}`); continue; }
  if (!same(N._test.idsOf(g.text), g.ids)) { fail.push(`bucket ids differ for ${JSON.stringify(g.text)}`); continue; }
  const p = N._test.intentProbs(g.text);
  for (let i = 0; i < p.length; i++) worstI = Math.max(worstI, Math.abs(p[i] - g.p[i]));
  const top = N.intent(g.text);
  if (Math.abs(top.reduce((a, x) => a + x.p, 0) - 1) > 1e-9 || top.some((x, i) => i && x.p > top[i - 1].p)) fail.push('intent() is not a sorted distribution');
}
if (worstI > TOL) fail.push(`intent probabilities differ by ${worstI}`);
console.log(`intent: ${gold.intent.length} messages, largest gap ${worstI.toExponential(2)}`);

// ---------- taste ----------
const F = JSON.parse(fs.readFileSync(path.join(web, 'kitsunet', 'taste.json'), 'utf8')).features;
let worstF = 0, worstP = 0, nT = 0;
for (const c of gold.taste) {
  const prof = N._test.buildProfile(c.entries);
  const ps = N.tasteMany(prof, c.targets.map(t => t.series));
  c.targets.forEach((t, i) => {
    const x = N._test.features(prof, t.series);
    x.forEach((v, j) => { const d = Math.abs(v - t.features[j]); if (d > worstF) worstF = d; if (d > TOL) fail.push(`feature ${F[j]} differs by ${d} (${v} vs ${t.features[j]})`); });
    const p = N.taste(prof, t.series);
    worstP = Math.max(worstP, Math.abs(p - t.p), Math.abs(ps[i] - t.p));
    nT++;
  });
}
if (worstP > TOL) fail.push(`taste chances differ by ${worstP}`);
console.log(`taste: ${gold.taste.length} readers, ${nT} series, largest feature gap ${worstF.toExponential(2)}, largest chance gap ${worstP.toExponential(2)}`);

// ---------- timing ----------
const msgs = gold.intent.map(g => g.text).filter(Boolean);
let t0 = performance.now(), reps = 0;
while (performance.now() - t0 < 500) { for (const m of msgs) N.intent(m); reps += msgs.length; }
const perMsg = (performance.now() - t0) / reps;
const big = gold.taste.reduce((a, c) => (c.entries.length > a.entries.length ? c : a));
const prof = N._test.buildProfile(big.entries), list = gold.taste.flatMap(c => c.targets.map(t => t.series));
t0 = performance.now(); reps = 0;
while (performance.now() - t0 < 500) { N.tasteMany(prof, list); reps += list.length; }
const perSeries = (performance.now() - t0) / reps;
console.log(`timing: intent ${(perMsg * 1000).toFixed(0)} µs per message, taste ${(perSeries * 1000).toFixed(0)} µs per series (profile of ${big.entries.length})`);
if (perMsg > 2) fail.push(`intent takes ${perMsg.toFixed(2)} ms per message (limit 2 ms)`);

// ---------- profileFrom on a made-up Koru library ----------
const now = Date.now();
store.set('koru-disc-tags', JSON.stringify({
  'asura:a': { t: ['Action', 'Fantasy', 'Regression'], status: 'Completed' }, 'asura:b': { t: ['Romance', 'Drama'], status: 'Ongoing' },
  'asura:c': { t: ['Action', 'Murim'] }, 'asura:h': { t: ['Horror'] }, 'asura:p': { t: ['Comedy'] }
}));
const data = {
  library: { 'asura:a': { title: 'A', total: 120 }, 'asura:p': { title: 'Planned only' }, 'asura:h': { title: 'Hidden one' } },
  history: { 'asura:b': { title: 'B', at: now }, 'asura:h': { title: 'Hidden one', at: now } },
  read: { 'asura:a': { c1: 1, c2: 1 }, 'asura:c': { c1: 1 } },
  notes: { 'asura:a': { rating: 5 }, 'asura:b': { rating: 2, shelves: ['Dropped'] }, 'asura:d': { shelves: ['Reread'] } },
  liked: { 'asura:c': { title: 'C' } },
  flags: { 'asura:a': { completed: true }, 'asura:h': { hidden: true }, 'asura:t': { trash: true, title: 'Trash' } },
  stats: { series: {} }, settings: {}
};
const pf = N.profileFrom(data), byKey = Object.fromEntries(pf.entries.map(e => [e.series.key, e]));
const expect = { 'asura:a': ['COMPLETED', 100], 'asura:b': ['DROPPED', 40], 'asura:c': ['CURRENT', 90], 'asura:d': ['REPEATING', 0], 'asura:t': ['DROPPED', 0] };
for (const [k, [status, score]] of Object.entries(expect)) {
  const e = byKey[k];
  if (!e || e.status !== status || e.score !== score) fail.push(`profileFrom: ${k} should be ${status} ${score}, got ${e ? e.status + ' ' + e.score : 'nothing'}`);
}
if (byKey['asura:p']) fail.push('profileFrom: a favourite never opened (planning) should be left out');
if (byKey['asura:h']) fail.push('profileFrom: a hidden series should be left out');
if (!N.profileFrom(data, { includePrivate: true }).entries.some(e => e.series.key === 'asura:h')) fail.push('profileFrom: includePrivate should keep hidden series');
if (!same(byKey['asura:a'].series.tags, ['action', 'fantasy', 'ageregression'].filter(t => JSON.parse(fs.readFileSync(path.join(web, 'kitsunet', 'taste.json'), 'utf8')).vocab[t])))
  fail.push('profileFrom: tags of asura:a were not mapped: ' + JSON.stringify(byKey['asura:a'].series.tags));
const why = N.why(pf, { provider: 'asura', slug: 'x', title: 'X', tags: ['Action', 'Fantasy', 'Manhwa'], status: 'Completed', total: 90 });
console.log('why (made-up library, an action fantasy manhwa):', JSON.stringify(why), 'chance', N.taste(pf, { provider: 'asura', slug: 'x', tags: ['Action', 'Fantasy', 'Manhwa'], status: 'Completed', total: 90 }).toFixed(3));
for (const c of gold.taste.slice(0, 3)) {
  const p = N._test.buildProfile(c.entries), t = c.targets[c.targets.length - 1].series;
  const w = N.why(p, t);
  console.log(`why (${c.entries.length} series, p ${N.taste(p, t).toFixed(2)}):`, JSON.stringify(w));
  if (!Array.isArray(w) || w.length > 3) fail.push('why() should give at most 3 reasons');
}

if (fail.length) { console.log('\nFAILED:\n  ' + [...new Set(fail)].slice(0, 30).join('\n  ')); process.exit(1); }
console.log('\nall checks passed: kitsunet.js matches the Python training maths');
