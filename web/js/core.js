// Koru core: small DOM helpers, icons, the link to the background side, saved data and toasts.
'use strict';
window.K = window.K || {};

// ---------- DOM ----------
// el('div.card#id', {onclick, style:{}, dataset:{}}, child, 'text', [more]) — text is always set as text, never HTML.
K.el = function el(spec, props, ...kids) {
  const m = spec.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const node = document.createElement(m[1] || 'div');
  for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') node.classList.add(part.slice(1)); else node.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  const add = c => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else node.append(c instanceof Node ? c : document.createTextNode(String(c))); };
  kids.forEach(add);
  return node;
};
K.$ = (s, r = document) => r.querySelector(s);
K.$$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- icons (trusted constants only) ----------
const ICONS = {
  library: '<path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="M16.5 4.6l3.8-1 3.2 15.4-3.8.9z" transform="translate(-2 1)"/>',
  explore: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  collapse: '<path d="M15 6l-6 6 6 6"/>',
  expand: '<path d="M9 6l6 6-6 6"/>',
  heart: '<path d="M12 20s-7-4.4-9.2-9A5 5 0 0 1 12 6a5 5 0 0 1 9.2 5C19 15.6 12 20 12 20z"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chart: '<path d="M4 20h16M7 20v-6M12 20V6M17 20v-9"/>',
  auto: '<path d="M7 5l5 5 5-5M7 12l5 5 5-5"/>',
  pause: '<path d="M8.5 5v14M15.5 5v14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  zen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="2.5"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  sort: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
  select: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>',
  scroll: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10 7h4M10 11h4M10 15h4"/>',
  pages: '<rect x="3" y="5" width="8" height="14" rx="1.5"/><rect x="13" y="5" width="8" height="14" rx="1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5C21 6.4 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  like: '<path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 3 2l-1 4h5.5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.3 20H7"/>',
  bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
  incognito: '<path d="M3 11h18M5 11l2-6h10l2 6"/><circle cx="7.5" cy="16" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/><path d="M10 16h4"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/>',
  eyeoff: '<path d="M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.5M6.5 7.5C4.3 9 3 12 3 12s4 6 9 6a9 9 0 0 0 4.4-1.2M9.9 10a3 3 0 0 0 4.1 4.1"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  done: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor"/>'
};
K.icon = function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ic ' + cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || ICONS.dot;
  return s;
};

// The Koru fox: a geometric fox head drawn in diagonal lines (same art as the app icon).
let foxN = 0;
K.fox = function fox(cls = '') {
  const id = 'fx' + (++foxN);
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 100 100');
  s.setAttribute('class', 'fox ' + cls);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<defs>
    <pattern id="${id}p" width="5.2" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(-22)"><rect x="0" y="0" width="2.3" height="10" fill="currentColor"/></pattern>
    <mask id="${id}m"><path d="M17 10 L40 33 L60 33 L83 10 L81 45 L93 57 L50 92 L7 57 L19 45 Z" fill="#fff"/>
      <path d="M27 54 L42 57 L37 62 Z" fill="#000"/><path d="M73 54 L58 57 L63 62 Z" fill="#000"/>
      <path d="M27 30 L36 39 L25 41 Z" fill="#000"/><path d="M73 30 L64 39 L75 41 Z" fill="#000"/></mask></defs>
    <rect width="100" height="100" fill="url(#${id}p)" mask="url(#${id}m)"/>
    <path d="M44.5 82 L55.5 82 L50 89 Z" fill="currentColor"/>`;
  return s;
};

// ---------- talking to the background side ----------
async function readJson(r) {
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  if (!r.ok) { const e = new Error(j?.error || (r.status >= 500 ? 'That site is down or busy right now. Try again in a bit.' : `Request failed (${r.status})`)); e.status = r.status; throw e; }
  return j;
}
K.api = {
  get: path => fetch(path).then(readJson),
  post: (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(readJson),
  // A request to one of the scan sites, through Koru's background side.
  site: url => fetch('/k/fetch?u=' + encodeURIComponent(url)).then(readJson),
  siteText: url => fetch('/k/fetch?u=' + encodeURIComponent(url) + '&accept=text/html').then(async r => { if (!r.ok) { let m = ''; try { m = JSON.parse(await r.text()).error; } catch {} throw new Error(m || (r.status >= 500 ? 'That site is down or busy right now. Try again in a bit.' : `The site answered ${r.status}`)); } return r.text(); }),
  load: key => fetch('/k/store/' + key).then(readJson),
  save: (key, value) => fetch('/k/store/' + key, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }).then(readJson)
};

// ---------- saved data ----------
// library: favourites   history: last read spot per series   read: read chapters per series   settings: everything else
K.data = { library: {}, history: {}, read: {}, settings: {}, liked: {}, bookmarks: {}, flags: {}, stats: {} };
K.flag = (provider, slug) => K.data.flags[provider + ':' + slug] || {};
K.notTrash = s => !K.flag(s.provider, s.slug).trash;
K.incognito = () => !!K.data.settings.incognito;
const saveTimers = {};
K.save = function save(key) {
  clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => K.api.save(key, K.data[key]).catch(() => K.toast('Couldn\'t save your changes.', 'error')), 350);
};
K.loadData = async function loadData() {
  await Promise.all(Object.keys(K.data).map(async k => { try { K.data[k] = (await K.api.load(k)) || {}; } catch { K.data[k] = {}; } }));
};
K.key = (provider, slug) => provider + ':' + slug;
// Reading stats: active reading time per day and per series, and chapters finished. Nothing is kept in incognito.
K.dayKey = (d = new Date()) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
function statEntry(s) {
  if (!s?.provider || !s.slug || K.incognito() || K.flag(s.provider, s.slug).trash) return null;
  const st = K.data.stats; st.days ||= {}; st.series ||= {};
  const k = K.key(s.provider, s.slug), d = st.days[K.dayKey()] ||= { ms: 0, ch: 0, s: {}, c: {} };
  const m = st.series[k] ||= { ms: 0, ch: 0 };
  Object.assign(m, { provider: s.provider, slug: s.slug, title: s.series?.title || m.title || s.slug, cover: s.series?.cover || m.cover || null, last: Date.now() });
  return { k, d, m };
}
K.stats = {
  add(s, ms) { const e = statEntry(s); if (!e) return; e.d.ms += ms; (e.d.s ||= {})[e.k] = (e.d.s[e.k] || 0) + ms; e.m.ms += ms; K.save('stats'); },
  chapter(s) { const e = statEntry(s); if (!e) return; e.d.ch = (e.d.ch || 0) + 1; (e.d.c ||= {})[e.k] = (e.d.c[e.k] || 0) + 1; e.m.ch = (e.m.ch || 0) + 1; K.save('stats'); }
};

// ---------- small helpers ----------
K.toast = function toast(msg, kind = 'info') {
  let box = K.$('#toasts');
  if (!box) box = document.body.appendChild(K.el('div#toasts'));
  const t = K.el('div.toast.glass.' + kind, K.icon(kind === 'error' ? 'x' : kind === 'ok' ? 'check' : 'sparkle'), K.el('span', { text: msg }));
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, 3200);
};
K.ago = function ago(date) {
  const d = typeof date === 'number' ? date : Date.parse(date);
  if (!d) return '';
  const s = (Date.now() - d) / 1000;
  if (s < 0) { const f = -s; return f < 3600 ? `in ${Math.ceil(f / 60)} min` : f < 86400 ? `in ${Math.ceil(f / 3600)} h` : `in ${Math.ceil(f / 86400)} days`; }
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
  return new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
K.bytes = n => n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
K.gpuSoftware = g => !g.now?.accel ? false : !/^enabled/.test(g.status?.gpu_compositing || '') || !/^enabled/.test(g.status?.rasterization || '');
K.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
// An image whose server wants the site's own Referer: Koru's backend fetches it (and adds that Referer).
K.viaKoru = url => (typeof url === 'string' && /^https:\/\//.test(url) ? '/k/fetch?u=' + encodeURIComponent(url) + '&accept=' + encodeURIComponent('image/avif,image/webp,image/*;q=0.8') : url);
K.plainText = html => new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent.trim();
// Covers: sites send them up to 1500×2100 for a 180px card, and decoding hundreds of those made scrolling
// stutter. Each one is shrunk to card size once, on a background thread, when it comes near the screen.
const thumbs = new Map(), twaits = new Map(), tqueue = [];
let tworker = null, tseq = 0, tactive = 0;
const thumbAsk = (blob, w) => new Promise((res, rej) => {
  if (!tworker) {
    tworker = new Worker('js/slicer.js');
    tworker.onmessage = e => { const t = twaits.get(e.data.id); if (!t) return; twaits.delete(e.data.id); e.data.type === 'error' ? t.rej(new Error(e.data.error)) : t.res(e.data.blob); };
  }
  const id = 't' + (++tseq); twaits.set(id, { res, rej }); tworker.postMessage({ type: 'thumb', id, blob, w });
});
function makeThumb(src, w) {
  const key = w + '|' + src;
  if (thumbs.has(key)) return thumbs.get(key);
  const p = (async () => {
    const r = await fetch(/^https:\/\//.test(src) ? K.viaKoru(src) : src);
    if (!r.ok) throw new Error('cover ' + r.status);
    return URL.createObjectURL(await thumbAsk(await r.blob(), w));
  })();
  thumbs.set(key, p);
  p.catch(() => thumbs.delete(key));
  if (thumbs.size > 900) { const [k, old] = thumbs.entries().next().value; thumbs.delete(k); old.then(u => setTimeout(() => URL.revokeObjectURL(u), 60000), () => {}); }
  return p;
}
const runThumbs = () => {
  while (tactive < 4 && tqueue.length) {
    const job = tqueue.shift();
    if (!job.i.isConnected) { thumbIO.observe(job.i); continue; }   // page put away for now; picked up when it's back
    tactive++;
    makeThumb(job.src, job.w).then(u => { job.i.src = u; }, () => { job.i.src = job.src; }).finally(() => { tactive--; runThumbs(); });
  }
};
const thumbIO = new IntersectionObserver(es => {
  for (const e of es) if (e.isIntersecting) { thumbIO.unobserve(e.target); tqueue.push(e.target._thumb); }
  runThumbs();
}, { rootMargin: '700px 0px' });
K.img = function img(src, alt = '', cls = '', cssW = 220) {
  const i = K.el('img' + (cls ? '.' + cls : ''), { alt, decoding: 'async', referrerPolicy: 'no-referrer', draggable: false });
  i.addEventListener('load', () => i.classList.add('ready'));
  i.addEventListener('error', () => i.classList.add('broken'));
  if (!src) return i;
  if (/^(data|blob):/.test(src)) { i.src = src; return i; }
  i._thumb = { i, src, w: Math.min(900, Math.round(cssW * Math.max(1, devicePixelRatio || 1))) };
  thumbIO.observe(i);
  return i;
};
