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
  'mangapill.com', 'readdetectiveconan.com'];
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
      chapterSlug: j.chapterSlug, done: j.done, total: j.pages.length, state: j.state, error: j.error || null };
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
        files, bytes, savedAt: new Date().toISOString()
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
            number: b.number ?? null, pages, done: 0, state: 'queued' });
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
