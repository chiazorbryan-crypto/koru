// Koru Together server: reading together and a crew chat (kept forever), for a few friends.
//
// Who's who: everyone signs in with GitHub using GitHub's device sign-in (Koru shows a short code, you enter it
// on github.com/login/device). No password or GitHub key is kept: the server asks GitHub who you are once, then
// gives Koru its own session token. Only a hash of that token is stored.
// A crew has an owner, who adds people by their GitHub username. Your PC and phone are the same person.
// Everyone has a profile they edit themselves (name, picture and banner, GIFs too, about, pronouns, status) and
// Koru adds their reading info (streak, badges, chapters, top series).
//
// Durable Objects:
//  - Hub (one): people and profiles, sessions, crews and who's in them.
//  - Crew (one per crew): the chat (SQLite, kept forever: replies, reactions, edits, pins), live connections,
//    who's reading what.
//  - Media (one): pictures and GIFs people upload (profile pictures, banners, chat pictures), up to 14 MB each.
// Sockets use the WebSocket Hibernation API, so a quiet connection costs nothing, and "ping" is answered with
// "pong" by Cloudflare without waking the crew.
import { DurableObject } from 'cloudflare:workers';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra } });
const err = (status, error) => json({ error }, status);
const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
const rand = n => { const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map(x => ALPHA[x % ALPHA.length]).join(''); };
const sha256 = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
const DEV_RE = /^[a-zA-Z0-9_-]{6,40}$/, LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/, MEDIA_RE = /^[a-z2-9]{20}$/;
const KINDS = ['text', 'share', 'together', 'sticker', 'image', 'voice'];
const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg'];   // voice messages
const PAGE = 60, MAX_MEMBERS = 12, MAX_MEDIA = 14 * 1024 * 1024, PART = 1024 * 1024;
const UA = 'Koru-Together';

const ghWeb = env => (env.GH_WEB || 'https://github.com').replace(/\/+$/, '');
const ghApi = env => (env.GH_API || 'https://api.github.com').replace(/\/+$/, '');
const hub = env => env.HUB.get(env.HUB.idFromName('hub'));
const media = env => env.MEDIA.get(env.MEDIA.idFromName('media'));
const crewStub = (env, id) => env.CREW.get(env.CREW.idFromName(id));
const prof = u => { try { return JSON.parse(u.profile || '{}') || {}; } catch { return {}; } };
// how someone shows up in lists: the name they typed, their picture (uploaded, else GitHub's), their status
const person = u => {
  const p = prof(u);
  return { id: u.id, login: u.login, name: u.nick || u.name || u.login, avatar: p.avatar || u.avatar || null, status: STATUSES.includes(p.status) ? p.status : 'online', custom: p.custom || '', color: p.color || null };
};
// the full profile card
const card = u => { const p = prof(u); return { ...person(u), bio: p.bio || '', pronouns: p.pronouns || '', banner: p.banner || null, theme: p.theme || null, joined: u.joined || null, stats: p.stats || null }; };

async function ghForm(env, path, body) {
  const r = await fetch(ghWeb(env) + path, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: new URLSearchParams(body) });
  let j = {}; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
async function ghGet(env, path, token) {
  const r = await fetch(ghApi(env) + path, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA, ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
// a picture people may use: one uploaded here, a GitHub picture, or a meme picture (stickers)
const okPicture = (url, origin, memes) => typeof url === 'string' && url.length <= 300 && (url.startsWith(origin + '/media/') || url.startsWith('https://avatars.githubusercontent.com/') || (memes && (/^https:\/\/i\.imgflip\.com\/[\w.]+$/.test(url) || /^https:\/\/media\.giphy\.com\/media\/\w+\/200\.gif$/.test(url))));
// meme sticker tabs: what GIPHY is searched for (trending = what's popular right now)
const MEME_CATS = { trending: 'trending', speed: ['ishowspeed', 'ishowspeed speed', 'speed meme'], kai: ['kai cenat', 'kaicenat', 'kai cenat stream'], duke: ['duke dennis', 'amp duke dennis'], brainrot: ['brainrot', 'skibidi', 'aura meme', 'john pork'], reactions: ['reaction meme', 'shocked meme', 'side eye meme', 'crying laughing meme'], classics: 'classics' };
// the old templates people still actually use; the rest of Imgflip's list is left out
const CLASSICS = ['drake', 'distracted boyfriend', 'two buttons', 'woman yelling at cat', 'change my mind', 'expanding brain', 'left exit 12', 'uno draw 25', 'once again asking', 'disaster girl', "gru's plan", 'is this a pigeon', 'waiting skeleton', 'buff doge', 'always has been', 'monkey puppet', 'sad pablo', 'trade offer', 'epic handshake', 'anakin padme', 'batman slapping', 'running away balloon', 'hide the pain', 'this is fine', 'panik kalm', 'spider man pointing', 'spiderman pointing', 'they\'re the same picture', 'surprised pikachu', 'mocking spongebob', 'sleeping shaq', 'two guys on a bus', 'squidward', 'bike fall', 'clown applying makeup', 'think about it', 'boardroom meeting', 'roll safe', 'black girl wat', 'leonardo dicaprio cheers', 'blank nut button', 'grus plan', 'x, x everywhere', 'unsettled tom', 'guy holding cardboard sign', 'flex tape', 'tuxedo winnie'];
function cleanStats(s) {
  if (!s || typeof s !== 'object') return null;
  const n = v => Math.max(0, Math.min(1e9, Math.round(Number(v) || 0)));
  return {
    streak: n(s.streak), best: n(s.best), chapters: n(s.chapters), hours: n(s.hours), series: n(s.series),
    badges: (Array.isArray(s.badges) ? s.badges : []).slice(0, 40).map(b => ({ e: clean(b.e, 8), name: clean(b.name, 40) })).filter(b => b.e),
    top: (Array.isArray(s.top) ? s.top : []).slice(0, 3).map(t => ({ title: clean(t.title, 80), cover: typeof t.cover === 'string' && /^https:\/\//.test(t.cover) ? t.cover.slice(0, 400) : null, provider: clean(t.provider, 30), slug: clean(t.slug, 200) })),
    reading: s.reading && typeof s.reading === 'object' ? { title: clean(s.reading.title, 80), chapterName: clean(s.reading.chapterName, 60) } : null
  };
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), path = url.pathname, origin = url.origin;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (path === '/' || path === '/health') return json({ ok: true, app: 'koru-together', signIn: !!env.GITHUB_CLIENT_ID });
    try {
      // ---- pictures (public by their long random id, so they can be shown anywhere) ----
      let m = path.match(/^\/media\/([a-z2-9]{20})$/);
      if (m && req.method === 'GET') {
        const f = await media(env).get(m[1]);
        if (!f) return err(404, 'Not found');
        return new Response(f.data, { headers: { 'Content-Type': f.type, 'Cache-Control': 'public, max-age=31536000, immutable', ...CORS } });
      }
      // ---- meme pictures for stickers (Imgflip's popular templates), kept for a day ----
      if (path === '/memes' && req.method === 'GET') {
        // categories: recent GIPHY searches (Speed, Kai Cenat, ...), plus the classics people still use
        const cat = url.searchParams.get('cat') || 'trending', q = clean(url.searchParams.get('q') || '', 50).trim().toLowerCase();
        const offset = Math.min(450, Math.max(0, Math.floor(Number(url.searchParams.get('offset')) / 50) * 50 || 0));
        if (!q && !MEME_CATS[cat]) return err(400, 'Unknown category');
        if (offset && !q && cat === 'classics') return json({ memes: [] });
        const cache = caches.default, key = new Request(origin + '/memes-cache-v3?' + new URLSearchParams({ ...(q ? { q } : { cat }), offset }));
        const hit = await cache.match(key);
        if (hit) return new Response(hit.body, { headers: { 'Content-Type': 'application/json', ...CORS } });
        let list;
        if (!q && cat === 'classics') {
          const r = await fetch('https://api.imgflip.com/get_memes', { headers: { 'User-Agent': UA } });
          const j = await r.json().catch(() => null);
          if (!j?.success) return err(502, 'Couldn\'t load memes right now.');
          list = j.data.memes.filter(x => CLASSICS.some(c => x.name.toLowerCase().includes(c)) && okPicture(x.url, origin, true)).map(x => ({ id: String(x.id), name: x.name, url: x.url, w: x.width, h: x.height }));
        } else {
          if (!env.GIPHY_KEY) return err(503, 'New memes aren\'t set up on the server yet. Classics still work.');
          const api = env.GIPHY_API || 'https://api.giphy.com';
          const page = offset / 50;
          const queries = q ? [q] : MEME_CATS[cat] === 'trending' ? null : MEME_CATS[cat];
          const each = queries ? Math.ceil(50 / queries.length) : 50;
          const targets = queries ? queries.map(x => `${api}/v1/gifs/search?` + new URLSearchParams({ api_key: env.GIPHY_KEY, q: x, limit: String(each), offset: String(page * each), rating: q ? 'r' : 'pg-13', lang: 'en' }))
            : [`${api}/v1/gifs/trending?` + new URLSearchParams({ api_key: env.GIPHY_KEY, limit: '50', offset: String(offset), rating: 'pg-13' })];
          const got = await Promise.all(targets.map(t => fetch(t, { headers: { 'User-Agent': UA } }).then(r => r.ok ? r.json() : null).catch(() => null)));
          if (got.every(x => !Array.isArray(x?.data))) return err(502, 'Couldn\'t load memes right now.');
          // take turns from each search so a tab mixes them, without repeats
          const lists = got.map(x => x?.data || []), seen = new Set(), mixed = [];
          for (let i = 0; i < Math.max(...lists.map(l => l.length)); i++) for (const l of lists) { const x = l[i]; if (x && !seen.has(x.id)) { seen.add(x.id); mixed.push(x); } }
          const j = { data: mixed };
          list = j.data.filter(x => /^\w+$/.test(x.id || '')).map(x => { const im = x.images?.fixed_height || {}; return { id: 'g' + x.id, name: String(x.title || '').replace(/\s*GIF( by .*)?$/i, '').slice(0, 80) || 'GIF', url: `https://media.giphy.com/media/${x.id}/200.gif`, w: Number(im.width) || 200, h: Number(im.height) || 200 }; });
        }
        const res = json({ memes: list }, 200, { 'Cache-Control': 'public, max-age=' + (q ? 3600 : cat === 'trending' ? 3 * 3600 : 86400) });
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      }
      // ---- GitHub device sign-in ----
      if (path === '/auth/start' && req.method === 'POST') {
        if (!env.GITHUB_CLIENT_ID) return err(503, 'Sign-in isn\'t set up on the server yet.');
        const { status, j } = await ghForm(env, '/login/device/code', { client_id: env.GITHUB_CLIENT_ID, scope: '' });
        if (status !== 200 || !j.device_code) return err(502, j.error_description || 'GitHub didn\'t answer. Try again in a moment.');
        return json({ device: j.device_code, code: j.user_code, url: j.verification_uri, interval: j.interval || 5, expires: j.expires_in || 900 });
      }
      if (path === '/auth/poll' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        if (typeof b.device !== 'string' || b.device.length > 200) return err(400, 'Bad request');
        const { j } = await ghForm(env, '/login/oauth/access_token', { client_id: env.GITHUB_CLIENT_ID, device_code: b.device, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
        if (j.error === 'authorization_pending') return json({ wait: true });
        if (j.error === 'slow_down') return json({ wait: true, interval: j.interval || 10 });
        if (j.error === 'expired_token') return err(410, 'The code ran out. Start again.');
        if (j.error === 'access_denied') return err(403, 'Sign-in was cancelled on GitHub.');
        if (!j.access_token) return err(502, j.error_description || 'GitHub sign-in didn\'t work. Try again.');
        // who is this? (then the GitHub token is dropped: Koru never keeps it)
        const gh = await ghGet(env, '/user', j.access_token);
        if (gh.status !== 200 || !gh.j?.id) return err(502, 'Couldn\'t read your GitHub profile. Try again.');
        const user = { id: gh.j.id, login: gh.j.login, name: gh.j.name || gh.j.login, avatar: gh.j.avatar_url || null };
        const token = rand(40);
        const u = await hub(env).signIn(user, await sha256(token));
        return json({ token, user: person(u) });
      }
      // ---- everything else needs a session ----
      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
      const H = hub(env);
      const me = token && token.length === 40 ? await H.who(await sha256(token)) : null;
      if (!me) return err(401, 'Sign in with GitHub again.');
      const tellCrews = async crews => { for (const c of crews) await crewStub(env, c.id).setMembers(c.members); };

      if (path === '/me' && req.method === 'GET') return json({ user: person(me), profile: card(me), crews: await H.crewsFor(me.id) });
      if (path === '/me/name' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const nick = clean(b.name, 32).trim();
        if (!nick) return err(400, 'Type a name.');
        const r = await H.saveProfile(me.id, { nick });
        await tellCrews(r.crews);
        return json({ user: person(r.user), crews: r.crews });
      }
      if (path === '/me/profile' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const patch = {}, p = {};
        if ('name' in b) { const nick = clean(b.name, 32).trim(); if (!nick) return err(400, 'Type a name.'); patch.nick = nick; }
        if ('bio' in b) p.bio = clean(b.bio, 300);
        if ('pronouns' in b) p.pronouns = clean(b.pronouns, 30).trim();
        if ('custom' in b) p.custom = clean(b.custom, 80).trim();
        if ('status' in b) { if (!STATUSES.includes(b.status)) return err(400, 'Bad status'); p.status = b.status; }
        if ('color' in b) { if (b.color !== null && !/^#[0-9a-f]{6}$/i.test(b.color)) return err(400, 'Bad colour'); p.color = b.color; }
        if ('theme' in b) { if (b.theme !== null && !(Array.isArray(b.theme) && b.theme.length === 2 && b.theme.every(c => /^#[0-9a-f]{6}$/i.test(c)))) return err(400, 'Bad theme'); p.theme = b.theme; }
        for (const k of ['avatar', 'banner']) if (k in b) { if (b[k] !== null && !okPicture(b[k], origin)) return err(400, 'That picture can\'t be used.'); p[k] = b[k]; }
        if ('stats' in b) p.stats = cleanStats(b.stats);
        const r = await H.saveProfile(me.id, patch, p);
        // stats alone don't change how you look in the member list
        if (Object.keys(patch).length || Object.keys(p).some(k => k !== 'stats')) await tellCrews(r.crews);
        return json({ user: person(r.user), profile: card(r.user), crews: r.crews });
      }
      m = path.match(/^\/users\/(\d{1,12})\/profile$/);
      if (m && req.method === 'GET') {
        const r = await H.profileFor(me.id, Number(m[1]));
        if (!r) return err(404, 'Not found');
        return json(r);
      }
      if (path === '/media' && req.method === 'POST') {
        const type = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
        if (!IMAGE_TYPES.includes(type) && !AUDIO_TYPES.includes(type)) return err(415, 'Only pictures, GIFs and voice messages.');
        const len = Number(req.headers.get('Content-Length') || 0);
        if (len > MAX_MEDIA) return err(413, 'That file is too big (14 MB at most).');
        const buf = await req.arrayBuffer();
        if (!buf.byteLength) return err(400, 'Empty file');
        if (buf.byteLength > MAX_MEDIA) return err(413, 'That file is too big (14 MB at most).');
        const id = rand(20);
        await media(env).put(id, type, buf, me.id);
        return json({ id, url: origin + '/media/' + id, type, size: buf.byteLength });
      }
      if (path === '/auth/signout' && req.method === 'POST') { await H.signOut(await sha256(token)); return json({ ok: true }); }
      if (path === '/crews' && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const crew = await H.createCrew(me.id, clean(b.name, 40).trim() || 'Crew', rand(8));
        if (crew.error) return err(400, crew.error);
        return json(crew);
      }
      m = path.match(/^\/crews\/([a-z2-9]{8})\/members$/);
      if (m && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const login = clean(b.login, 40).trim().replace(/^@/, '');
        if (!LOGIN_RE.test(login)) return err(400, 'That isn\'t a GitHub username.');
        const gh = await ghGet(env, '/users/' + encodeURIComponent(login));
        if (gh.status === 404) return err(404, 'There\'s no GitHub user called ' + login + '.');
        if (gh.status !== 200 || !gh.j?.id) return err(502, 'Couldn\'t look that person up on GitHub. Try again.');
        if (gh.j.type !== 'User') return err(400, login + ' is an organisation, not a person.');
        const r = await H.addMember(m[1], me.id, { id: gh.j.id, login: gh.j.login, name: gh.j.name || gh.j.login, avatar: gh.j.avatar_url || null });
        if (r.error) return err(r.status || 400, r.error);
        await crewStub(env, m[1]).setMembers(r.members);
        return json(r);
      }
      m = path.match(/^\/crews\/([a-z2-9]{8})\/members\/(\d{1,12})$/);
      if (m && req.method === 'DELETE') {
        const r = await H.removeMember(m[1], me.id, Number(m[2]));
        if (r.error) return err(r.status || 400, r.error);
        await crewStub(env, m[1]).setMembers(r.members, Number(m[2]), r.deleted ? { deleted: true } : { name: r.name, owner: r.owner });
        return json(r);
      }
      // rename or delete a crew (its owner)
      m = path.match(/^\/crews\/([a-z2-9]{8})$/);
      if (m && req.method === 'POST') {
        const b = await req.json().catch(() => ({}));
        const name = clean(b.name, 40).trim();
        if (!name) return err(400, 'Type a name.');
        const r = await H.renameCrew(m[1], me.id, name);
        if (r.error) return err(r.status || 400, r.error);
        await crewStub(env, m[1]).setMembers(r.members, null, { name: r.name, owner: r.owner });
        return json(r);
      }
      if (m && req.method === 'DELETE') {
        const r = await H.deleteCrew(m[1], me.id);
        if (r.error) return err(r.status || 400, r.error);
        await crewStub(env, m[1]).setMembers([], null, { deleted: true });
        return json(r);
      }
      // forward a message into another of your crews
      m = path.match(/^\/crews\/([a-z2-9]{8})\/messages$/);
      if (m && req.method === 'POST') {
        const crew = await H.crew(m[1]);
        if (!crew || !crew.members.some(x => x.id === me.id)) return err(403, 'You\'re not in that crew.');
        const b = await req.json().catch(() => ({}));
        const r = await crewStub(env, m[1]).post(person(me), b, origin, crew);
        if (r.error) return err(400, r.error);
        return json(r);
      }
      m = path.match(/^\/crews\/([a-z2-9]{8})\/ws$/);
      if (m) {
        if (req.headers.get('Upgrade') !== 'websocket') return err(426, 'Expected a WebSocket');
        const device = url.searchParams.get('device') || '';
        if (!DEV_RE.test(device)) return err(400, 'Bad device');
        const crew = await H.crew(m[1]);
        if (!crew || !crew.members.some(x => x.id === me.id)) return err(403, 'You\'re not in this crew.');
        const fwd = new Request('https://crew/ws', { headers: req.headers });
        fwd.headers.set('X-Koru-User', JSON.stringify(person(me)));
        fwd.headers.set('X-Koru-Device', device);
        if (url.searchParams.get('lite') === '1') fwd.headers.set('X-Koru-Lite', '1');
        fwd.headers.set('X-Koru-Crew', JSON.stringify(crew));
        fwd.headers.set('X-Koru-Origin', origin);
        return crewStub(env, m[1]).fetch(fwd);
      }
      return err(404, 'Not found');
    } catch (e) {
      return err(500, 'Something went wrong on the server.');
    }
  }
};

// ---------- Hub: people, profiles, sessions, crews ----------
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const q = s => ctx.storage.sql.exec(s);
    q(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, login TEXT NOT NULL, name TEXT, nick TEXT, avatar TEXT, updated INTEGER)`);
    for (const col of ['joined INTEGER', 'profile TEXT']) { try { q('ALTER TABLE users ADD COLUMN ' + col); } catch {} }
    q(`CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user INTEGER NOT NULL, created INTEGER NOT NULL, last INTEGER NOT NULL)`);
    q(`CREATE TABLE IF NOT EXISTS crews (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner INTEGER NOT NULL, created INTEGER NOT NULL)`);
    q(`CREATE TABLE IF NOT EXISTS members (crew TEXT NOT NULL, user INTEGER NOT NULL, added INTEGER NOT NULL, PRIMARY KEY (crew, user))`);
    this.sql = ctx.storage.sql;
  }
  rows(s, ...a) { return this.sql.exec(s, ...a).toArray(); }
  user(id) { return this.rows('SELECT * FROM users WHERE id = ?', id)[0] || null; }
  saveUser(u) {
    this.sql.exec('INSERT INTO users (id, login, name, avatar, updated, joined) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET login = excluded.login, name = excluded.name, avatar = excluded.avatar, updated = excluded.updated',
      u.id, u.login, u.name, u.avatar, Date.now(), Date.now());
  }
  async signIn(u, hash) { this.saveUser(u); const t = Date.now(); this.sql.exec('INSERT INTO sessions (hash, user, created, last) VALUES (?, ?, ?, ?)', hash, u.id, t, t); return this.user(u.id); }
  async who(hash) {
    const r = this.rows('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user WHERE s.hash = ?', hash)[0];
    if (r) this.sql.exec('UPDATE sessions SET last = ? WHERE hash = ?', Date.now(), hash);
    return r || null;
  }
  async saveProfile(id, patch = {}, p = {}) {
    if (patch.nick) this.sql.exec('UPDATE users SET nick = ? WHERE id = ?', patch.nick, id);
    if (Object.keys(p).length) { const cur = prof(this.user(id)); this.sql.exec('UPDATE users SET profile = ? WHERE id = ?', JSON.stringify({ ...cur, ...p }), id); }
    return { user: this.user(id), crews: await this.crewsFor(id) };
  }
  // a profile card: only for people you share a crew with (and yourself)
  async profileFor(viewer, id) {
    if (viewer !== id && !this.rows('SELECT 1 FROM members a JOIN members b ON a.crew = b.crew WHERE a.user = ? AND b.user = ? LIMIT 1', viewer, id).length) return null;
    const u = this.user(id); return u ? card(u) : null;
  }
  async signOut(hash) { this.sql.exec('DELETE FROM sessions WHERE hash = ?', hash); return true; }
  membersOf(crew) { return this.rows('SELECT u.* FROM members m JOIN users u ON u.id = m.user WHERE m.crew = ? ORDER BY m.added', crew).map(person); }
  async crew(id) { const c = this.rows('SELECT * FROM crews WHERE id = ?', id)[0]; return c ? { id: c.id, name: c.name, owner: c.owner, members: this.membersOf(c.id) } : null; }
  async crewsFor(user) { return this.rows('SELECT c.* FROM members m JOIN crews c ON c.id = m.crew WHERE m.user = ? ORDER BY c.created', user).map(c => ({ id: c.id, name: c.name, owner: c.owner, members: this.membersOf(c.id) })); }
  async createCrew(owner, name, id) {
    if (this.rows('SELECT COUNT(*) AS n FROM crews WHERE owner = ?', owner)[0].n >= 5) return { error: 'You already have 5 crews.' };
    const t = Date.now();
    this.sql.exec('INSERT INTO crews (id, name, owner, created) VALUES (?, ?, ?, ?)', id, name, owner, t);
    this.sql.exec('INSERT INTO members (crew, user, added) VALUES (?, ?, ?)', id, owner, t);
    return this.crew(id);
  }
  async addMember(crew, actor, u) {
    const c = await this.crew(crew);
    if (!c) return { error: 'No such crew', status: 404 };
    if (c.owner !== actor) return { error: 'Only the person who made the crew can add people.', status: 403 };
    if (c.members.length >= MAX_MEMBERS) return { error: 'This crew is full.' };
    if (!this.user(u.id)) this.saveUser(u);
    this.sql.exec('INSERT OR IGNORE INTO members (crew, user, added) VALUES (?, ?, ?)', crew, u.id, Date.now());
    return this.crew(crew);
  }
  async removeMember(crew, actor, user) {
    const c = await this.crew(crew);
    if (!c) return { error: 'No such crew', status: 404 };
    if (actor !== c.owner && actor !== user) return { error: 'Only the person who made the crew can remove people.', status: 403 };
    if (user === c.owner && actor !== user) return { error: 'The crew\'s owner can only leave by themselves.' };
    this.sql.exec('DELETE FROM members WHERE crew = ? AND user = ?', crew, user);
    // the owner left: the crew passes to whoever joined next, or goes away if nobody's left
    if (user === c.owner) {
      const next = this.rows('SELECT user FROM members WHERE crew = ? ORDER BY added LIMIT 1', crew)[0];
      if (!next) { this.sql.exec('DELETE FROM crews WHERE id = ?', crew); return { deleted: true, members: [] }; }
      this.sql.exec('UPDATE crews SET owner = ? WHERE id = ?', next.user, crew);
    }
    return this.crew(crew);
  }
  async renameCrew(crew, actor, name) {
    const c = await this.crew(crew);
    if (!c) return { error: 'No such crew', status: 404 };
    if (c.owner !== actor) return { error: 'Only the crew\'s owner can rename it.', status: 403 };
    this.sql.exec('UPDATE crews SET name = ? WHERE id = ?', name, crew);
    return this.crew(crew);
  }
  async deleteCrew(crew, actor) {
    const c = await this.crew(crew);
    if (!c) return { error: 'No such crew', status: 404 };
    if (c.owner !== actor) return { error: 'Only the crew\'s owner can delete it.', status: 403 };
    this.sql.exec('DELETE FROM members WHERE crew = ?', crew);
    this.sql.exec('DELETE FROM crews WHERE id = ?', crew);
    return { deleted: true, members: [] };
  }
}

// ---------- Media: uploaded pictures and GIFs ----------
export class Media extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS media (id TEXT NOT NULL, part INTEGER NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, owner INTEGER NOT NULL, at INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, part))`);
  }
  async put(id, type, buf, owner) {
    const t = Date.now();
    for (let i = 0, part = 0; i < buf.byteLength; i += PART, part++) this.sql.exec('INSERT INTO media (id, part, type, size, owner, at, data) VALUES (?, ?, ?, ?, ?, ?, ?)', id, part, type, buf.byteLength, owner, t, buf.slice(i, i + PART));
    return true;
  }
  async get(id) {
    if (!MEDIA_RE.test(id)) return null;
    const rows = this.sql.exec('SELECT type, size, data FROM media WHERE id = ? ORDER BY part', id).toArray();
    if (!rows.length) return null;
    const out = new Uint8Array(rows[0].size); let o = 0;
    for (const r of rows) { const b = new Uint8Array(r.data); out.set(b, o); o += b.byteLength; }
    return { type: rows[0].type, data: out };
  }
}

// ---------- Crew: the chat and the live connections ----------
export class Crew extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, data TEXT)`);
    for (const col of ['reply INTEGER', 'edited INTEGER', 'deleted INTEGER', 'reacts TEXT', 'pinned INTEGER', 'fwd TEXT']) { try { this.sql.exec('ALTER TABLE msgs ADD COLUMN ' + col); } catch {} }
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  meta(k) { const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]; return r ? r.v : null; }
  setMeta(k, v) { this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v); }
  crewInfo() { try { return JSON.parse(this.meta('crew') || 'null'); } catch { return null; } }
  rt() { try { return JSON.parse(this.meta('rt') || '{}'); } catch { return {}; } }
  lastSeen() { try { return JSON.parse(this.meta('seen') || '{}'); } catch { return {}; } }
  isMember(user) { return (this.crewInfo()?.members || []).some(x => x.id === user); }

  async fetch(req) {
    const user = JSON.parse(req.headers.get('X-Koru-User'));
    const device = req.headers.get('X-Koru-Device');
    const crew = JSON.parse(req.headers.get('X-Koru-Crew'));
    this.setMeta('crew', JSON.stringify(crew));
    this.setMeta('origin', req.headers.get('X-Koru-Origin') || '');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ['u' + user.id]);
    server.serializeAttachment({ user: user.id, name: user.name, device, idle: false });
    // lite: Koru is open but showing another crew; it only counts you as online here (and hears about new messages)
    if (req.headers.get('X-Koru-Lite') === '1') server.send(JSON.stringify({ t: 'lite', lastId: this.lastId() }));
    else server.send(JSON.stringify({ t: 'init', me: user, crew, members: this.members(), msgs: this.page(null), rt: this.rt(), lastId: this.lastId() }));
    this.broadcast({ t: 'presence', members: this.members() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // the crew's people (from the Hub) with who's online right now and how (online, idle, do not disturb)
  members(except) {
    const socks = {}, seen = this.lastSeen();
    for (const ws of this.ctx.getWebSockets()) if (ws !== except && ws.readyState === 1) { const a = ws.deserializeAttachment(); if (a) (socks[a.user] ||= []).push(a); }
    return (this.crewInfo()?.members || []).map(m => {
      const s = socks[m.id], on = !!s && m.status !== 'invisible';
      const presence = !on ? 'offline' : m.status === 'dnd' ? 'dnd' : (m.status === 'idle' || s.every(a => a.idle)) ? 'idle' : 'online';
      return { ...m, status: undefined, online: on, presence, last: seen[m.id] || 0 };
    });
  }
  // someone was added, removed or changed their profile: update everyone, and close a removed person's connections
  async setMembers(members, removed, crew) {
    const c = this.crewInfo() || {};
    this.setMeta('crew', JSON.stringify({ ...c, ...(crew ? { name: crew.name, owner: crew.owner } : {}), members }));
    if (crew) this.broadcast({ t: 'crew', name: crew.name, owner: crew.owner });
    // the crew was deleted: everyone's connection closes
    if (crew?.deleted) { for (const ws of this.ctx.getWebSockets()) { try { ws.send(JSON.stringify({ t: 'removed', deleted: true })); ws.close(4003, 'deleted'); } catch {} } return true; }
    for (const m of members) for (const ws of this.ctx.getWebSockets('u' + m.id)) { const a = ws.deserializeAttachment(); if (a && a.name !== m.name) ws.serializeAttachment({ ...a, name: m.name }); }
    if (removed) for (const ws of this.ctx.getWebSockets('u' + removed)) { try { ws.send(JSON.stringify({ t: 'removed' })); ws.close(4003, 'removed'); } catch {} }
    this.broadcast({ t: 'presence', members: this.members() });
    return true;
  }

  // a message as the app sees it: with the message it replies to, its reactions, and whether it was edited/deleted
  out(r, cache = new Map()) {
    let reply = null;
    if (r.reply) {
      if (!cache.has(r.reply)) cache.set(r.reply, this.sql.exec('SELECT id, user, name, kind, text, data, deleted FROM msgs WHERE id = ?', r.reply).toArray()[0] || null);
      const q = cache.get(r.reply);
      reply = q ? { id: q.id, user: q.user, name: q.name, kind: q.kind, text: q.deleted ? '' : q.text.slice(0, 200), deleted: !!q.deleted } : { id: r.reply, gone: true };
    }
    return { id: r.id, at: r.at, user: r.user, name: r.name, kind: r.kind, text: r.deleted ? '' : r.text, data: r.deleted ? null : (r.data ? JSON.parse(r.data) : null),
      reply, edited: r.edited || null, deleted: !!r.deleted, reacts: r.reacts ? JSON.parse(r.reacts) : null, pinned: r.pinned || null, fwd: r.fwd || null };
  }
  one(id) { const r = this.sql.exec('SELECT * FROM msgs WHERE id = ?', id).toArray()[0]; return r ? this.out(r) : null; }
  page(before) {
    const rows = before ? this.sql.exec('SELECT * FROM msgs WHERE id < ? ORDER BY id DESC LIMIT ?', before, PAGE).toArray()
      : this.sql.exec('SELECT * FROM msgs ORDER BY id DESC LIMIT ?', PAGE).toArray();
    const cache = new Map();
    return rows.reverse().map(r => this.out(r, cache));
  }
  lastId() { return this.sql.exec('SELECT MAX(id) AS id FROM msgs').toArray()[0]?.id || 0; }
  broadcast(o, except) {
    const s = JSON.stringify(o);
    for (const ws of this.ctx.getWebSockets()) if (ws !== except && ws.readyState === 1) { try { ws.send(s); } catch {} }
  }

  // a new message (from a connection, or forwarded from another crew)
  add(me, m, origin) {
    const kind = KINDS.includes(m.kind) ? m.kind : 'text';
    const text = clean(m.text, 4000).trim();
    let data = null;
    if (m.data && typeof m.data === 'object') {
      if ((kind === 'sticker' || kind === 'image' || kind === 'voice') && !okPicture(m.data.url, origin, kind === 'sticker')) return { error: 'That can\'t be sent.' };
      const d = JSON.stringify(m.data); if (d.length <= 4000) data = d;
    }
    if (!text && !data) return { error: 'Empty message' };
    const reply = Number(m.reply) > 0 && this.sql.exec('SELECT 1 FROM msgs WHERE id = ?', Number(m.reply)).toArray().length ? Number(m.reply) : null;
    const fwd = m.fwd ? clean(m.fwd, 60) : null;
    const id = this.sql.exec('INSERT INTO msgs (at, user, name, kind, text, data, reply, fwd) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id', Date.now(), me.user ?? me.id, me.name, kind, text, data, reply, fwd).toArray()[0].id;
    const msg = this.one(id);
    this.broadcast({ t: 'msg', m: { ...msg, nonce: clean(m.nonce, 40) } });
    return { ok: true, id };
  }
  async post(user, m, origin, crew) {
    if (crew) { this.setMeta('crew', JSON.stringify(crew)); this.setMeta('origin', origin); }
    if (!this.isMember(user.id)) return { error: 'Not in this crew' };
    return this.add({ user: user.id, name: user.name }, { ...m, reply: null, fwd: clean(m.fwd || 'another crew', 60) }, origin);
  }
  update(id) { const m = this.one(id); if (m) this.broadcast({ t: 'upd', m }); }

  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const me = ws.deserializeAttachment() || {};
    // removed from the crew while connected
    if (!this.isMember(me.user)) { try { ws.close(4003, 'removed'); } catch {} return; }
    const t = Date.now(), origin = this.meta('origin') || '';
    const row = id => this.sql.exec('SELECT * FROM msgs WHERE id = ?', Number(id) || 0).toArray()[0];
    if (m.t === 'send') {
      const r = this.add(me, m, origin);
      if (r.error && m.nonce) ws.send(JSON.stringify({ t: 'fail', nonce: clean(m.nonce, 40), error: r.error }));
    } else if (m.t === 'edit') {
      const r = row(m.id); const text = clean(m.text, 4000).trim();
      if (!r || r.user !== me.user || r.deleted || r.kind !== 'text' || !text) return;
      this.sql.exec('UPDATE msgs SET text = ?, edited = ? WHERE id = ?', text, t, r.id); this.update(r.id);
    } else if (m.t === 'del') {
      const r = row(m.id);
      if (!r || r.deleted || (r.user !== me.user && this.crewInfo()?.owner !== me.user)) return;
      this.sql.exec('UPDATE msgs SET deleted = 1, text = \'\', data = NULL, reacts = NULL, pinned = NULL WHERE id = ?', r.id); this.update(r.id);
    } else if (m.t === 'react') {
      const r = row(m.id); const e = clean(m.emoji, 16).trim();
      if (!r || r.deleted || !e) return;
      const reacts = r.reacts ? JSON.parse(r.reacts) : {};
      const who = new Set(reacts[e] || []);
      if (who.has(me.user)) who.delete(me.user); else { if (!reacts[e] && Object.keys(reacts).length >= 20) return; who.add(me.user); }
      if (who.size) reacts[e] = [...who]; else delete reacts[e];
      this.sql.exec('UPDATE msgs SET reacts = ? WHERE id = ?', Object.keys(reacts).length ? JSON.stringify(reacts) : null, r.id); this.update(r.id);
    } else if (m.t === 'pin') {
      const r = row(m.id);
      if (!r || r.deleted) return;
      this.sql.exec('UPDATE msgs SET pinned = ? WHERE id = ?', r.pinned ? null : t, r.id); this.update(r.id);
      if (!r.pinned) this.broadcast({ t: 'pinned', by: me.name, id: r.id });
    } else if (m.t === 'pins') {
      const rows = this.sql.exec('SELECT * FROM msgs WHERE pinned IS NOT NULL AND deleted IS NOT 1 ORDER BY pinned DESC LIMIT 50').toArray();
      ws.send(JSON.stringify({ t: 'pins', msgs: rows.map(r => this.out(r)) }));
    } else if (m.t === 'search') {
      const q = clean(m.q, 60).trim().replace(/[%_\\]/g, '\\$&');
      if (q.length < 2) return;
      const rows = this.sql.exec('SELECT * FROM msgs WHERE deleted IS NOT 1 AND (text LIKE ? ESCAPE \'\\\' OR data LIKE ? ESCAPE \'\\\') ORDER BY id DESC LIMIT 50', '%' + q + '%', '%' + q + '%').toArray();
      ws.send(JSON.stringify({ t: 'search', q: m.q, msgs: rows.map(r => this.out(r)) }));
    } else if (m.t === 'around') {
      // jump to an old message (a reply's original, a pin, a search result): it and the messages around it
      const id = Number(m.id) || 0;
      const rows = this.sql.exec('SELECT * FROM msgs WHERE id BETWEEN ? AND ? ORDER BY id', id - 30, id + 30).toArray();
      ws.send(JSON.stringify({ t: 'around', id, msgs: rows.map(r => this.out(r)) }));
    } else if (m.t === 'older') {
      ws.send(JSON.stringify({ t: 'older', msgs: this.page(Number(m.before) || 1) }));
    } else if (m.t === 'since') {
      const rows = this.sql.exec('SELECT * FROM msgs WHERE id > ? ORDER BY id LIMIT 500', Number(m.after) || 0).toArray();
      ws.send(JSON.stringify({ t: 'since', msgs: rows.map(r => this.out(r)) }));
    } else if (m.t === 'pos') {
      // read-together: where this person is reading (null = stopped sharing)
      const rt = this.rt(), key = String(me.user);
      if (m.pos && typeof m.pos === 'object' && JSON.stringify(m.pos).length <= 2000) rt[key] = { name: me.name, pos: m.pos, at: t, device: me.device };
      else if (!rt[key] || rt[key].device === me.device) delete rt[key];
      for (const [d, v] of Object.entries(rt)) if (t - v.at > 6 * 3600e3) delete rt[d];
      this.setMeta('rt', JSON.stringify(rt));
      this.broadcast({ t: 'pos', user: me.user, name: me.name, pos: rt[key]?.pos || null, at: t }, ws);
    } else if (m.t === 'typing') {
      this.broadcast({ t: 'typing', user: me.user, name: me.name }, ws);
    } else if (m.t === 'idle') {
      // Koru noticed you've been away a while (or came back)
      ws.serializeAttachment({ ...me, idle: !!m.on });
      this.broadcast({ t: 'presence', members: this.members() });
    }
  }
  async webSocketClose(ws) {
    const me = ws.deserializeAttachment() || {};
    if (me.user) { const seen = this.lastSeen(); seen[me.user] = Date.now(); this.setMeta('seen', JSON.stringify(seen)); }
    this.broadcast({ t: 'presence', members: this.members(ws) }, ws);
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }
}
