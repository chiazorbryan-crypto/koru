// Koru's background side: talks to the scan sites, saves your library and handles downloads.
// It has no Electron imports, so the same code runs in the app and in the dev server (scripts/dev.js).
//
// Routes (all under /k/):
//   GET  /k/fetch?u=<url>        a site request (only the allowed sites), returned as-is
//   GET  /k/store/<key>          saved JSON (library, history, settings)
//   PUT  /k/store/<key>          save JSON
//   POST /k/dl/start             queue a chapter download {provider, seriesSlug, seriesTitle, cover, chapterSlug, chapterName, number, pages:[url]}
//   POST /k/dl/cancel {id}       stop a queued or running download
//   POST /k/dl/delete {id}|{series}  remove a downloaded chapter, or a whole series
//   GET  /k/dl/queue             what is downloading now
//   GET  /k/dl/list              everything downloaded
//   GET  /k/dl/file/<series>/<chapter>/<file>   a downloaded page or cover
//   GET  /k/dl/cbz?dir=<series>/<chapter> | ?id=<provider:series:chapter> | ?series=<series folder>
//                                a downloaded chapter or whole series as a .cbz (an uncompressed ZIP + ComicInfo.xml), streamed
//   GET  /k/info                 app version, platform, downloads folder
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns';
try { net.setDefaultAutoSelectFamilyAttemptTimeout?.(2500); dns.setDefaultResultOrder('ipv4first'); } catch {}
import fsp from 'node:fs/promises';
import path from 'node:path';

export const USER_AGENT = 'Koru/0.1 (personal reader)';
// Image servers that only serve pictures to their own site get that site as Referer (what its own pages send).
export const REFERERS = [   // [hostSuffix, referer]
  ['pstatic.net', 'https://www.webtoons.com/'], ['tnlycdn.com', 'https://toonily.com/'],
  ['cmzcdn.org', 'https://comizy.io/'], ['readdetectiveconan.com', 'https://mangapill.com/']
];
const refererFor = u => { try { const h = new URL(u).hostname; return REFERERS.find(([d]) => h === d || h.endsWith('.' + d))?.[1]; } catch { return undefined; } };
// "/k/fetch?u=<url>" (images routed through Koru) back to the real url
const unwrap = u => { if (typeof u === 'string' && u.startsWith('/k/fetch?')) { try { return new URLSearchParams(u.slice(9)).get('u') || ''; } catch { return ''; } } return u; };
// Only these sites (and their subdomains) can be reached through Koru.
const ALLOWED = ['omegascans.org', 'vortexscans.org', 'asurascans.com', 'flamecomics.xyz', 'mangadex.org', 'mangadex.network',
  'webtoons.com', 'pstatic.net', 'toonily.com', 'tnlycdn.com',
  'weebcentral.com', 'compsci88.com', 'planeptune.us', 'lastation.us', 'lowee.us', 'leanbox.us',
  'comizy.io', 'cmzcdn.org', 'hivetoons.org', 'hivetoon.com',
  'en-thunderscans.com', 'madarascans.net', 'wp.com', 'kingofshojo.com', 'violetmanga.com', 'drakecomic.net', 'ibb.co',
  'qimanga.com', 'qiscans.org', 'nyxscans.com', 'magustoon.org', 'rokaricomics.com', 'elftoon.net', 'elftoon.com',
  'mangapill.com', 'readdetectiveconan.com', 'lagoonscans.com', 'mangaread.org', 'manhuaplus.com', 'files.wordpress.com'];
export const allowedUrl = u => {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && ALLOWED.some(d => url.hostname === d || url.hostname.endsWith('.' + d));
  } catch { return false; }
};

const IMG_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', json: 'application/json' };
const safe = s => String(s).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '_').slice(0, 90) || '_';
export const dlId = (provider, seriesSlug, chapterSlug) => `${provider}:${seriesSlug}:${chapterSlug}`;

// ---------- a tiny ZIP writer (STORE only, no compression: comic pages are already compressed) ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
const dosTime = d => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });
// entries: [{ name, file } | { name, data: Buffer }] in order. Returns a web ReadableStream of the .zip; files are read
// one at a time as the reader asks for more, so a whole series never sits in memory. Zip64 kicks in past 4 GB / 65535 files.
export function zipStream(entries) {
  const now = dosTime(new Date()), central = [];
  let offset = 0, i = 0, finished = false;
  const u16 = (b, o, v) => b.writeUInt16LE(v & 0xFFFF, o), u32 = (b, o, v) => b.writeUInt32LE(v >>> 0, o);
  return new ReadableStream({
    async pull(ctl) {
      try {
        if (i < entries.length) {
          const e = entries[i++];
          const data = e.data || await fsp.readFile(e.file);
          const name = Buffer.from(e.name, 'utf8'), crc = crc32(data);
          const h = Buffer.alloc(30);
          u32(h, 0, 0x04034b50); u16(h, 4, 20); u16(h, 6, 0x0800); u16(h, 8, 0); u16(h, 10, now.time); u16(h, 12, now.date);
          u32(h, 14, crc); u32(h, 18, data.length); u32(h, 22, data.length); u16(h, 26, name.length); u16(h, 28, 0);
          central.push({ name, crc, size: data.length, offset });
          offset += h.length + name.length + data.length;
          ctl.enqueue(new Uint8Array(Buffer.concat([h, name]))); ctl.enqueue(new Uint8Array(data));
          return;
        }
        if (finished) return;
        finished = true;
        const parts = [], cdStart = offset;
        for (const c of central) {
          const big = c.offset >= 0xFFFFFFFF;
          const x = big ? Buffer.alloc(12) : null;
          if (x) { u16(x, 0, 0x0001); u16(x, 2, 8); x.writeBigUInt64LE(BigInt(c.offset), 4); }
          const h = Buffer.alloc(46);
          u32(h, 0, 0x02014b50); u16(h, 4, big ? 45 : 20); u16(h, 6, big ? 45 : 20); u16(h, 8, 0x0800); u16(h, 10, 0); u16(h, 12, now.time); u16(h, 14, now.date);
          u32(h, 16, c.crc); u32(h, 20, c.size); u32(h, 24, c.size); u16(h, 28, c.name.length); u16(h, 30, x ? x.length : 0);
          u16(h, 32, 0); u16(h, 34, 0); u16(h, 36, 0); u32(h, 38, 0); u32(h, 42, big ? 0xFFFFFFFF : c.offset);
          parts.push(h, c.name); if (x) parts.push(x);
        }
        const cd = Buffer.concat(parts), cdSize = cd.length, n = central.length;
        const z64 = n >= 0xFFFF || cdStart >= 0xFFFFFFFF || cdSize >= 0xFFFFFFFF;
        const tail = [];
        if (z64) {
          const r = Buffer.alloc(56), zEnd = cdStart + cdSize;
          u32(r, 0, 0x06064b50); r.writeBigUInt64LE(44n, 4); u16(r, 12, 45); u16(r, 14, 45); u32(r, 16, 0); u32(r, 20, 0);
          r.writeBigUInt64LE(BigInt(n), 24); r.writeBigUInt64LE(BigInt(n), 32); r.writeBigUInt64LE(BigInt(cdSize), 40); r.writeBigUInt64LE(BigInt(cdStart), 48);
          const l = Buffer.alloc(20); u32(l, 0, 0x07064b50); u32(l, 4, 0); l.writeBigUInt64LE(BigInt(zEnd), 8); u32(l, 16, 1);
          tail.push(r, l);
        }
        const e = Buffer.alloc(22);
        u32(e, 0, 0x06054b50); u16(e, 4, 0); u16(e, 6, 0); u16(e, 8, Math.min(n, 0xFFFF)); u16(e, 10, Math.min(n, 0xFFFF));
        u32(e, 12, Math.min(cdSize, 0xFFFFFFFF)); u32(e, 16, Math.min(cdStart, 0xFFFFFFFF)); u16(e, 20, 0);
        ctl.enqueue(new Uint8Array(Buffer.concat([cd, ...tail, e])));
        ctl.close();
      } catch (err) { ctl.error(err); }
    }
  }, { highWaterMark: 0 });
}
const xmlEsc = s => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
// ComicInfo.xml (the Anansi/ComicRack format most comic readers understand)
const comicInfo = f => '<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n'
  + Object.entries(f).filter(([, v]) => v != null && v !== '').map(([k, v]) => `  <${k}>${xmlEsc(v)}</${k}>\n`).join('') + '</ComicInfo>\n';
const fileName = s => String(s || 'Koru').replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Koru';
const PAGE_RE = /^[\w-][\w.-]*\.(jpe?g|png|webp|gif|avif)$/i;

export function createBackend({ dataDir, downloadsDir, version = '0.0.0', platform = 'desktop', onOpenPath, onOpenExternal, onWindowIcon, fetchImpl = fetch }) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(downloadsDir, { recursive: true });

  const json = (status, body) => ({ status, type: 'application/json', body: JSON.stringify(body) });
  const seriesDir = (provider, slug) => path.join(downloadsDir, safe(provider + '-' + slug));
  const chapterDir = (provider, slug, ch) => path.join(seriesDir(provider, slug), safe(ch));

  async function writeAtomic(file, data) {
    const tmp = file + '.' + process.pid + '.tmp';
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, file);
  }

  // Slow or patchy connections: wait longer and try again before giving up.
  async function siteFetch(u, accept = 'application/json') {
    if (!allowedUrl(u)) throw Object.assign(new Error('That site is not one of Koru\'s sources.'), { status: 403 });
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const headers = { 'User-Agent': USER_AGENT, Accept: accept };
        const ref = refererFor(u); if (ref) headers.Referer = ref;
        const r = await fetchImpl(u, { headers, signal: AbortSignal.timeout(45000), redirect: 'follow' });
        if (r.url && !allowedUrl(r.url)) throw Object.assign(new Error('The site redirected somewhere unexpected.'), { status: 502, final: true });
        if ([502, 503, 504, 522, 524].includes(r.status) && attempt < 2) { lastErr = new Error('The site is busy (' + r.status + ').'); await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); continue; }
        return r;
      } catch (e) {
        if (e.final) throw e;
        lastErr = e;
        await new Promise(res => setTimeout(res, 1200 * (attempt + 1)));
      }
    }
    const host = (() => { try { return new URL(u).hostname.replace(/^api\./, ''); } catch { return 'the site'; } })();
    throw Object.assign(new Error(`Couldn't reach ${host}. Your connection may be slow, or the site may be down. Try again in a moment.`), { status: 504, cause: lastErr });
  }

  // ---------- downloads ----------
  const queue = [];          // jobs waiting or running, in order
  let running = null;

  function jobView(j) {
    return { id: j.id, seriesTitle: j.seriesTitle, chapterName: j.chapterName, provider: j.provider, seriesSlug: j.seriesSlug,
      chapterSlug: j.chapterSlug, done: j.done, total: j.pages.length, state: j.state, error: j.error || null, auto: !!j.auto };
  }

  async function saveCover(job) {
    const dir = seriesDir(job.provider, job.seriesSlug);
    await fsp.mkdir(dir, { recursive: true });
    const metaFile = path.join(dir, 'series.json');
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(metaFile, 'utf8')); } catch {}
    if (!meta.cover && job.cover && allowedUrl(job.cover)) {
      try {
        const r = await siteFetch(job.cover, 'image/*');
        const ext = IMG_TYPES[(r.headers.get('content-type') || '').split(';')[0]];
        if (r.ok && ext) { await writeAtomic(path.join(dir, 'cover.' + ext), Buffer.from(await r.arrayBuffer())); meta.cover = 'cover.' + ext; }
      } catch {}
    }
    Object.assign(meta, { provider: job.provider, seriesSlug: job.seriesSlug, title: job.seriesTitle });
    await writeAtomic(metaFile, JSON.stringify(meta));
  }

  async function runJob(job) {
    job.state = 'downloading';
    await saveCover(job);
    const dir = chapterDir(job.provider, job.seriesSlug, job.chapterSlug);
    const part = dir + '.part';
    await fsp.mkdir(part, { recursive: true });
    const files = new Array(job.pages.length);
    let bytes = 0, next = 0;
    async function worker() {
      while (next < job.pages.length && !job.cancelled) {
        const i = next++;
        let lastErr;
        for (let attempt = 0; attempt < 3 && !job.cancelled; attempt++) {
          try {
            const r = await siteFetch(job.pages[i], 'image/*');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const type = (r.headers.get('content-type') || '').split(';')[0];
            const ext = IMG_TYPES[type] || (job.pages[i].match(/\.(jpe?g|png|webp|gif|avif)(?:$|\?)/i)?.[1] || 'jpg').toLowerCase().replace('jpeg', 'jpg');
            const buf = Buffer.from(await r.arrayBuffer());
            const name = String(i + 1).padStart(4, '0') + '.' + ext;
            await fsp.writeFile(path.join(part, name), buf);
            files[i] = name; bytes += buf.length; job.done++;
            lastErr = null;
            break;
          } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 800 * (attempt + 1))); }
        }
        if (lastErr) throw lastErr;
      }
    }
    try {
      await Promise.all([worker(), worker(), worker()]);
      if (job.cancelled) throw new Error('cancelled');
      await writeAtomic(path.join(part, 'chapter.json'), JSON.stringify({
        id: job.id, provider: job.provider, seriesSlug: job.seriesSlug, seriesTitle: job.seriesTitle,
        chapterSlug: job.chapterSlug, chapterName: job.chapterName, number: job.number ?? null,
        files, bytes, savedAt: new Date().toISOString(), auto: !!job.auto
      }));
      await fsp.rm(dir, { recursive: true, force: true });
      await fsp.rename(part, dir);
      job.state = 'done';
    } catch (e) {
      await fsp.rm(part, { recursive: true, force: true }).catch(() => {});
      job.state = job.cancelled ? 'cancelled' : 'failed';
      job.error = job.cancelled ? null : 'Some pages wouldn\'t download. Try again.';
    }
  }

  async function pump() {
    if (running) return;
    const job = queue.find(j => j.state === 'queued');
    if (!job) return;
    running = job;
    try { await runJob(job); } finally {
      running = null;
      // Finished jobs stay visible for a minute so the Downloads page can show them.
      setTimeout(() => { const i = queue.indexOf(job); if (i >= 0 && job.state !== 'queued' && job.state !== 'downloading') queue.splice(i, 1); }, 60000);
      pump();
    }
  }

  async function listDownloads() {
    const out = [];
    let series = [];
    try { series = await fsp.readdir(downloadsDir, { withFileTypes: true }); } catch {}
    for (const s of series) {
      if (!s.isDirectory()) continue;
      const sdir = path.join(downloadsDir, s.name);
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(path.join(sdir, 'series.json'), 'utf8')); } catch { continue; }
      const chapters = [];
      for (const c of await fsp.readdir(sdir, { withFileTypes: true })) {
        if (!c.isDirectory() || c.name.endsWith('.part')) continue;
        try {
          const m = JSON.parse(await fsp.readFile(path.join(sdir, c.name, 'chapter.json'), 'utf8'));
          chapters.push({ ...m, dir: s.name + '/' + c.name });
        } catch {}
      }
      if (!chapters.length) continue;
      out.push({ provider: meta.provider, seriesSlug: meta.seriesSlug, title: meta.title,
        cover: meta.cover ? `/k/dl/file/${encodeURIComponent(s.name)}/${encodeURIComponent(meta.cover)}` : null,
        bytes: chapters.reduce((a, c) => a + (c.bytes || 0), 0), chapters });
    }
    return out;
  }

  // ---------- CBZ export ----------
  // A folder name straight under downloadsDir (or one level deeper): no separators, no dots-only names, no links.
  const okName = n => typeof n === 'string' && n.length > 0 && n.length < 200 && !/[\\/:*?"<>|\u0000-\u001F]/.test(n) && !/^\.+$/.test(n);
  async function realDir(...names) {
    if (!names.every(okName)) return null;
    const full = path.join(downloadsDir, ...names);
    if (!full.startsWith(downloadsDir + path.sep) || full.endsWith('.part')) return null;
    try { const st = await fsp.lstat(full); return st.isDirectory() && !st.isSymbolicLink() ? full : null; } catch { return null; }
  }
  // The pages of one downloaded chapter folder, in reading order (as chapter.json lists them).
  async function chapterPages(dir) {
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'chapter.json'), 'utf8')); } catch { return null; }
    let names = Array.isArray(meta.files) ? meta.files.filter(f => typeof f === 'string' && PAGE_RE.test(f)) : [];
    if (!names.length) names = (await fsp.readdir(dir)).filter(f => PAGE_RE.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const files = [];
    for (const n of names) { const full = path.join(dir, n); try { const st = await fsp.lstat(full); if (st.isFile()) files.push(full); } catch {} }
    return files.length ? { meta, files } : null;
  }
  async function cbz(query) {
    let sdir = null, cdirs = [];
    const id = query.get('id'), dir = query.get('dir'), series = query.get('series');
    if (dir) {
      const [a, b, ...more] = String(dir).split('/');
      if (more.length || !b) return json(400, { error: 'Bad path' });
      sdir = await realDir(a); const c = await realDir(a, b); if (c) cdirs = [c];
    } else if (id) {
      const [provider, seriesSlug, ...rest] = String(id).split(':');
      if (!provider || !seriesSlug || !rest.length) return json(400, { error: 'Bad id' });
      sdir = await realDir(path.basename(seriesDir(provider, seriesSlug)));
      const c = sdir && await realDir(path.basename(sdir), path.basename(chapterDir(provider, seriesSlug, rest.join(':')))); if (c) cdirs = [c];
    } else if (series) {
      // the series folder name, or "provider:slug" like /k/dl/delete takes
      const [provider, ...slug] = String(series).split(':');
      sdir = await realDir(String(series)) || (slug.length ? await realDir(path.basename(seriesDir(provider, slug.join(':')))) : null);
      if (sdir) for (const d of await fsp.readdir(sdir, { withFileTypes: true })) if (d.isDirectory() && !d.isSymbolicLink() && !d.name.endsWith('.part')) cdirs.push(path.join(sdir, d.name));
    } else return json(400, { error: 'Say which download to export.' });
    if (!sdir || !cdirs.length) return json(404, { error: 'Not downloaded' });
    let smeta = {};
    try { smeta = JSON.parse(await fsp.readFile(path.join(sdir, 'series.json'), 'utf8')); } catch {}
    const chapters = (await Promise.all(cdirs.map(chapterPages))).filter(Boolean)
      .sort((a, b) => (a.meta.number ?? 1e9) - (b.meta.number ?? 1e9) || String(a.meta.chapterName || '').localeCompare(String(b.meta.chapterName || ''), undefined, { numeric: true }));
    if (!chapters.length) return json(404, { error: 'Not downloaded' });
    const title = smeta.title || chapters[0].meta.seriesTitle || path.basename(sdir);
    const one = !series && chapters.length === 1 ? chapters[0].meta : null;
    const entries = [];
    chapters.forEach((c, ci) => c.files.forEach((f, pi) => {
      const ext = path.extname(f).toLowerCase().replace('.jpeg', '.jpg');
      // one chapter: 0001.jpg…; a series: 0001-0001.jpg… (chapter, page), flat so every reader keeps the order
      entries.push({ name: (one ? '' : String(ci + 1).padStart(4, '0') + '-') + String(pi + 1).padStart(4, '0') + ext, file: f });
    }));
    const pages = entries.length, nums = chapters.map(c => c.meta.number).filter(n => typeof n === 'number' && Number.isFinite(n));
    const info = one
      ? { Title: one.chapterName || '', Series: title, Number: one.number ?? '', PageCount: pages, Notes: 'Exported by Koru' }
      : { Title: title, Series: title, Count: chapters.length, PageCount: pages,
        Notes: `Exported by Koru: ${chapters.length} chapter${chapters.length > 1 ? 's' : ''}${nums.length ? ` (${Math.min(...nums)}–${Math.max(...nums)})` : ''}` };
    entries.push({ name: 'ComicInfo.xml', data: Buffer.from(comicInfo(info), 'utf8') });
    const name = fileName(one ? `${title} - ${one.chapterName || 'Chapter ' + (one.number ?? '')}` : title) + '.cbz';
    return { status: 200, type: 'application/vnd.comicbook+zip', body: zipStream(entries), stream: true,
      headers: { 'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` } };
  }

  // ---------- request handler ----------
  // req: { method, path, query: URLSearchParams, body: string }
  // returns: { status, type, body } where body is a string/Buffer, or { status, file, type } to stream a file.
  return async function handle(req) {
    const { method, path: p, query } = req;
    try {
      if (p === '/k/info' && method === 'GET') return json(200, { version, platform, downloadsDir });

      if (p === '/k/fetch' && method === 'GET') {
        const r = await siteFetch(query.get('u') || '', query.get('accept') || 'application/json');
        const type = r.headers.get('content-type') || 'application/octet-stream';
        return { status: r.status, type, body: Buffer.from(await r.arrayBuffer()), cache: r.ok && type.startsWith('image/') };
      }

      const store = p.match(/^\/k\/store\/([a-z0-9-]{1,40})$/);
      if (store) {
        const file = path.join(dataDir, store[1] + '.json');
        if (method === 'GET') {
          try { return { status: 200, type: 'application/json', body: await fsp.readFile(file) }; }
          catch { return { status: 200, type: 'application/json', body: 'null' }; }
        }
        if (method === 'PUT') {
          JSON.parse(req.body); // only valid JSON is saved
          await writeAtomic(file, req.body);
          return json(200, { ok: true });
        }
      }

      if (p === '/k/dl/start' && method === 'POST') {
        const b = JSON.parse(req.body || '{}');
        if (b.cover) b.cover = unwrap(b.cover);
        const pages = Array.isArray(b.pages) ? b.pages.map(unwrap).filter(allowedUrl) : [];
        if (!b.provider || !b.seriesSlug || !b.chapterSlug || !pages.length) return json(400, { error: 'Nothing to download.' });
        const id = dlId(b.provider, b.seriesSlug, b.chapterSlug);
        if (!queue.some(j => j.id === id && (j.state === 'queued' || j.state === 'downloading'))) {
          queue.push({ id, provider: String(b.provider), seriesSlug: String(b.seriesSlug), seriesTitle: String(b.seriesTitle || b.seriesSlug),
            cover: b.cover || null, chapterSlug: String(b.chapterSlug), chapterName: String(b.chapterName || b.chapterSlug),
            number: b.number ?? null, pages, done: 0, state: 'queued', auto: !!b.auto });
          pump();
        }
        return json(200, { ok: true, id });
      }
      if (p === '/k/dl/cancel' && method === 'POST') {
        const { id } = JSON.parse(req.body || '{}');
        for (const j of queue) if (j.id === id || id === '*') { j.cancelled = true; if (j.state === 'queued') j.state = 'cancelled'; }
        return json(200, { ok: true });
      }
      if (p === '/k/dl/queue' && method === 'GET') return json(200, { jobs: queue.map(jobView) });
      if (p === '/k/dl/list' && method === 'GET') {
        let disk = null;
        try { await fsp.mkdir(downloadsDir, { recursive: true }); const st = await fsp.statfs(downloadsDir); disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize }; } catch {}
        return json(200, { series: await listDownloads(), disk });
      }
      if (p === '/k/dl/delete' && method === 'POST') {
        const b = JSON.parse(req.body || '{}');
        if (b.id) {
          const [provider, seriesSlug, ...rest] = String(b.id).split(':');
          await fsp.rm(chapterDir(provider, seriesSlug, rest.join(':')), { recursive: true, force: true });
          const sdir = seriesDir(provider, seriesSlug);
          const left = (await fsp.readdir(sdir, { withFileTypes: true }).catch(() => [])).filter(d => d.isDirectory());
          if (!left.length) await fsp.rm(sdir, { recursive: true, force: true });
        } else if (b.series) {
          const [provider, ...slug] = String(b.series).split(':');
          await fsp.rm(seriesDir(provider, slug.join(':')), { recursive: true, force: true });
        }
        return json(200, { ok: true });
      }
      if (p === '/k/dl/cbz' && method === 'GET') return await cbz(query);
      const file = p.match(/^\/k\/dl\/file\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
      if (file && method === 'GET') {
        const parts = file.slice(1).filter(Boolean).map(decodeURIComponent);
        if (parts.some(x => x === '..' || x.includes('/') || x.includes('\\'))) return json(400, { error: 'Bad path' });
        const full = path.join(downloadsDir, ...parts);
        if (!full.startsWith(downloadsDir + path.sep)) return json(400, { error: 'Bad path' });
        const ext = path.extname(full).slice(1).toLowerCase();
        if (!fs.existsSync(full)) return json(404, { error: 'Not downloaded' });
        return { status: 200, file: full, type: MIME[ext] || 'application/octet-stream' };
      }
      if (p === '/k/window-icon' && method === 'POST') {
        // The window and taskbar icon, recoloured to match your theme (a PNG made by the page).
        const { png } = JSON.parse(req.body || '{}');
        if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,') || png.length > 3e6) return json(400, { error: 'Bad icon' });
        onWindowIcon?.(png);
        return json(200, { ok: true });
      }
      if (p === '/k/open-downloads' && method === 'POST') { onOpenPath?.(downloadsDir); return json(200, { ok: true }); }
      if (p === '/k/open-external' && method === 'POST') {
        const { url } = JSON.parse(req.body || '{}');
        if (!allowedUrl(url) && !/^https:\/\/github\.com\//.test(url)) return json(400, { error: 'Not allowed' });
        onOpenExternal?.(url);
        return json(200, { ok: true });
      }
      return json(404, { error: 'Not found' });
    } catch (e) {
      return json(e.status || 500, { error: e.message || 'Something went wrong.' });
    }
  };
}
