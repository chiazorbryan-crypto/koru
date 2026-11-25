// KitsuNet: the two small networks behind Kitsu (trained in kitsunet/, see its README).
//  - intent: what a chat message is asking for. Hashed words, word pairs and 3-5 letter runs, averaged,
//    then a softmax over Kitsu's intents. Reads typos and slang (kitsunet/textfeat.py has the same maths).
//  - taste: the chance you'd finish and enjoy a series, from your own Koru data (favourites, ratings, read marks,
//    completed / trash marks, shelves) and the series's genres, status and length (kitsunet/taste_features.py).
// The weights (web/kitsunet/*.json) load the first time K.kitsuNet.ready is asked for, never at app start.
//   await K.kitsuNet.ready
//   K.kitsuNet.intent('wat shoud i read')               -> [{ intent: 'recommend', p: 0.97 }, ...]
//   const me = K.kitsuNet.profileFrom(K.data)            (hidden series are left out unless { includePrivate: true })
//   K.kitsuNet.taste(me, series)  /  tasteMany(me, list)  -> 0..1
//   K.kitsuNet.why(me, series)                           -> ['you finish a lot of regression manhwa', ...]
// A series can be a Koru series ({ provider, slug, title, tags, status, author, total }), one of Kitsu's cards
// ({ kind: 'ani', genres, tags: [names], status, chapters, score, country }), a whole AniList media object (with
// countryOfOrigin, tags as { name, rank }, popularity, averageScore, staff), or a Koru series carrying its AniList
// media as .anilist. Whatever isn't known (popularity, score, year...) is fine: the network was trained with it missing.
'use strict';
(function () {
  const N = {};
  let loading = null, INT = null, TASTE = null;

  // ---------- loading ----------
  const getJson = path => fetch(path).then(r => { if (!r.ok) throw new Error('KitsuNet: ' + path + ' ' + r.status); return r.json(); });
  function load() {
    if (!loading) {
      loading = Promise.all([getJson('kitsunet/intent.json'), getJson('kitsunet/taste.json')])
        .then(([i, t]) => { INT = prepIntent(i); TASTE = prepTaste(t); return N; })
        .catch(e => { loading = null; throw e; });
    }
    return loading;
  }
  Object.defineProperty(N, 'ready', { get: load, enumerable: true });
  const need = what => { if (!(what === 'intent' ? INT : TASTE)) { load().catch(() => {}); throw new Error('KitsuNet is still loading: await K.kitsuNet.ready first'); } };

  // ---------- the intent network ----------
  const enc = new TextEncoder();
  function tidy(text, maxWords = 40) {
    let t = String(text ?? '').toLowerCase().replace(/[’‘]/g, "'").replace(/['`]/g, '');
    t = t.replace(/\?/g, ' ? ').replace(/[^a-z0-9?]+/g, ' ');
    return t.split(' ').filter(Boolean).slice(0, maxWords);
  }
  function pieces(text, minN = 3, maxN = 5, maxWords = 40) {
    const words = tidy(text, maxWords), out = [];
    words.forEach((w, i) => {
      out.push('w:' + w);
      if (i) out.push('b:' + words[i - 1] + ' ' + w);
      if (w === '?') return;
      const m = '<' + w + '>';
      for (let n = minN; n <= maxN; n++) for (let a = 0; a + n <= m.length; a++) out.push('c:' + m.slice(a, a + n));
    });
    return out;
  }
  // 32-bit FNV-1a over the UTF-8 bytes (pieces are plain ASCII after tidy(), so the characters are the bytes)
  function fnv1a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c > 127) { h = 0x811c9dc5; for (const b of enc.encode(s)) { h ^= b; h = Math.imul(h, 0x01000193); } break; }
      h ^= c; h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  const idsOf = (text, net) => pieces(text, net.min_n, net.max_n, net.max_words).map(p => fnv1a(p) % net.buckets);

  function prepIntent(j) {
    const bin = atob(j.emb_q), q = new Int8Array(bin.length);
    for (let i = 0; i < bin.length; i++) q[i] = bin.charCodeAt(i) << 24 >> 24;
    return { ...j, q, scale: Float64Array.from(j.emb_scale), emb_q: null, emb_scale: null };
  }
  function dense(layers, h, last) {
    for (let li = 0; li < layers.length; li++) {
      const { w, b } = layers[li], o = new Float64Array(b.length);
      for (let r = 0; r < b.length; r++) { let s = b[r]; const row = w[r]; for (let c = 0; c < row.length; c++) s += row[c] * h[c]; o[r] = li < layers.length - 1 ? Math.max(0, s) : s; }
      h = o;
    }
    return last ? last(h) : h;
  }
  function intentProbs(text) {
    const net = INT, D = net.dim, ids = idsOf(text, net), h = new Float64Array(D);
    for (const id of ids) { const s = net.scale[id]; if (!s) continue; const o = id * D; for (let j = 0; j < D; j++) h[j] += net.q[o + j] * s; }
    if (ids.length) for (let j = 0; j < D; j++) h[j] /= ids.length;
    const z = dense(net.layers, h), mx = Math.max(...z), e = z.map(v => Math.exp(v - mx)), sum = e.reduce((a, b) => a + b, 0);
    return e.map(v => v / sum);
  }
  N.intent = function (text) {
    need('intent');
    const p = intentProbs(text);
    return INT.intents.map((intent, i) => ({ intent, p: p[i] })).sort((a, b) => b.p - a.p);
  };

  // ---------- the taste network: series ----------
  const STATUSES = ['COMPLETED', 'CURRENT', 'PAUSED', 'DROPPED', 'REPEATING'];
  const S_STATUS = ['FINISHED', 'RELEASING', 'HIATUS', 'CANCELLED'];
  const tagKey = n => String(n ?? '').toLowerCase().replace(/science fiction/g, 'scifi').replace(/[^a-z0-9]+/g, '');
  const staffKey = n => String(n ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort().join('');   // "Chu-Gong" = "Chugong"
  const num = v => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
  const lg = x => (x ? Math.log1p(x) : 0);

  function prepTaste(j) {
    return { ...j, vocab: new Map(Object.entries(j.vocab)), order: new Map(Object.keys(j.vocab).map((t, i) => [t, i])),
      aliases: new Map(Object.entries(j.aliases || {})), cache: new WeakMap() };
  }
  // an AniList media object, as kitsunet/taste_features.normalize_media reads it
  function fromAniList(m, key) {
    const V = TASTE.vocab, rankMin = TASTE.constants.tag_rank;
    const gs = (m.genres || []).map(tagKey).filter(g => V.has(g));
    const top = (m.tags || []).filter(t => (t?.rank || 0) >= rankMin && !t.isMediaSpoiler).map(t => [t.rank || 0, tagKey(t.name)])
      .sort((a, b) => b[0] - a[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(x => x[1]).filter(k => V.get(k) === 'tag');
    const tags = [...new Set([...gs, ...top])];
    const c = m.countryOfOrigin || '', fmt = m.format, st = m.status || '';
    const staff = [], staffNames = [];
    for (const e of m.staff?.edges || []) { const n = e?.node?.name?.full, k = staffKey(n); if (k && !staff.includes(k)) { staff.push(k); staffNames.push(n); } }
    return { key: key || 'al:' + m.id, tags, genres: new Set(gs), top, country: c === 'TW' ? 'CN' : ['KR', 'JP', 'CN'].includes(c) ? c : '',
      oneshot: fmt === 'MANGA' ? 0 : fmt === 'ONE_SHOT' ? 1 : null, status: S_STATUS.includes(st) ? st : '',
      chapters: m.chapters || null, pop: m.popularity || null, avg: m.averageScore || null, year: m.startDate?.year || null, staff, staffNames };
  }
  function koruStatus(text) {
    const t = String(text || '').toLowerCase();
    if (/hiatus/.test(t)) return 'HIATUS';
    if (/cancel|discontinu|dropped|axed/.test(t)) return 'CANCELLED';
    if (/\b(not|ongoing|upcoming|yet)\b|on ?going|releasing|publishing|serializ/.test(t)) return 'RELEASING';
    if (/complet|finish|ended|concluded|\bend\b|\bdone\b/.test(t)) return 'FINISHED';
    return '';
  }
  // a Koru series: the source's genre list, status, author and chapter count (kitsunet/taste_features.normalize_koru)
  function fromKoru(s, key) {
    const V = TASTE.vocab, A = TASTE.aliases, KO = TASTE.koru, rankMin = TASTE.constants.tag_rank;
    const names = [...(Array.isArray(s.genres) ? s.genres : []), ...(Array.isArray(s.tags) ? s.tags : [])]
      .map(t => (typeof t === 'string' ? t : t && typeof t === 'object' && !t.isMediaSpoiler && (t.rank == null || t.rank >= rankMin) ? t.name : null));
    const raw = names.filter(t => typeof t === 'string').map(tagKey), keys = [];
    for (const k of raw) { const v = A.get(k) || k; if (V.has(v) && !keys.includes(v)) keys.push(v); }
    const genres = new Set(keys.filter(k => V.get(k) === 'genre')), top = keys.filter(k => V.get(k) === 'tag');
    let country = String(s.country || s.countryOfOrigin || '').toUpperCase();
    country = country === 'TW' ? 'CN' : ['KR', 'JP', 'CN'].includes(country) ? country : '';
    if (!country) { const hits = new Set(raw.filter(k => KO.country[k]).map(k => KO.country[k])); if (hits.size === 1) country = [...hits][0]; }
    const status = koruStatus(s.status);
    let chapters = num(s.chapters) || num(s.total) || (Array.isArray(s._chapters) && s._chapters.length) || null;
    if (KO.finished_chapters_only && status !== 'FINISHED') chapters = null;
    const staff = [], staffNames = [];
    for (const n of String(s.author || '').split(/\s*(?:·|,|\/|&|;|\band\b)\s*/)) { const k = staffKey(n); if (k && !staff.includes(k)) { staff.push(k); staffNames.push(n.trim()); } }
    return { key, tags: [...[...genres], ...top], genres, top, country, oneshot: raw.some(k => KO.oneshot.includes(k)) ? 1 : null, status,
      chapters, pop: num(s.popularity), avg: num(s.averageScore) || (s.kind === 'ani' ? num(s.score) : null), year: num(s.year) || num(s.startDate?.year), staff, staffNames };
  }
  // a whole AniList media object (Kitsu's own cards, with genres and tag names but no country field, take the path above)
  const isAniList = s => !!s && !s.provider && ('countryOfOrigin' in s || (Array.isArray(s.tags) && s.tags.length > 0 && typeof s.tags[0] === 'object'));
  function normSeries(s) {
    if (!s || typeof s !== 'object') return fromKoru({}, '');
    if (s.__kn) return s;
    const hit = TASTE.cache.get(s);
    if (hit) return hit;
    const key = s.provider && s.slug != null ? s.provider + ':' + s.slug : s.key || (s.id != null ? 'al:' + s.id : '');
    const a = s.anilist || (isAniList(s) ? s : null);
    const n = a ? fromAniList(a, key) : fromKoru(s, key);
    n.__kn = true;
    n.title = s.title?.english || s.title?.romaji || (typeof s.title === 'string' ? s.title : '') || a?.title?.english || a?.title?.romaji || '';
    TASTE.cache.set(s, n);
    return n;
  }

  // ---------- the taste network: a reader's profile ----------
  // label of one entry against the reader's mean score m (null = not counted)
  function label(status, score, m) {
    if (status === 'DROPPED') return 0;
    if (score && m != null) { if (score >= m) return 1; if (score <= m - TASTE.constants.clear) return 0; }
    if (status === 'COMPLETED' || status === 'REPEATING') return 1;
    return null;
  }
  // Everything about the profile that doesn't depend on the series being scored.
  function aggregate(entries) {
    const C = TASTE.constants, k = C.k, n = entries.length;
    const scored = entries.filter(e => e.score).map(e => e.score);
    const m = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null;
    const a = { n, m, entries, cnt: new Map(), lab: new Map(), pos: new Map(), comp: new Map(), drop: new Map(), nL: 0, P: 0, C: 0, D: 0 };
    const add = (map, t, v) => map.set(t, (map.get(t) || 0) + v);
    a.labs = entries.map(e => label(e.status, e.score, m));
    entries.forEach((e, i) => {
      const l = a.labs[i], co = e.status === 'COMPLETED' || e.status === 'REPEATING' ? 1 : 0, dr = e.status === 'DROPPED' ? 1 : 0;
      a.C += co; a.D += dr;
      if (l != null) { a.nL++; a.P += l; }
      for (const t of e.series.tags) { add(a.cnt, t, 1); add(a.comp, t, co); add(a.drop, t, dr); if (l != null) { add(a.lab, t, 1); add(a.pos, t, l); } }
    });
    let sum = 0; for (const s of scored) sum += s;
    a.u_comp = (a.C + k * C.p_comp) / (n + k);
    a.u_drop = (a.D + k * C.p_drop) / (n + k);
    a.u_pos = (a.P + k * C.p_pos) / (a.nL + k);
    a.u = [lg(n), a.u_comp, a.u_drop, a.u_pos, n ? a.nL / n : 0, n ? scored.length / n : 0, (sum + k * C.mean0) / (scored.length + k) / 100];
    const ord = t => TASTE.order.get(t) ?? 1e9;
    const topOf = map => [...map.keys()].filter(t => map.get(t) > 0).sort((x, y) => map.get(y) - map.get(x) || ord(x) - ord(y)).slice(0, C.top);
    a.top = new Set(topOf(a.cnt)); a.fav = new Set(topOf(a.pos));
    let ps = 0, pc = 0, as = 0, ac = 0, cs = 0, cc = 0;
    entries.forEach(e => {
      const s = e.series;
      if (s.pop) { ps += lg(s.pop); pc++; }
      if (s.avg) { as += s.avg / 100; ac++; }
      if ((e.status === 'COMPLETED' || e.status === 'REPEATING') && s.chapters) { cs += lg(s.chapters); cc++; }
    });
    a.popMean = (ps + k * C.pop0) / (pc + k); a.avgMean = (as + k * C.avg0) / (ac + k); a.chMean = (cs + k * C.ch0) / (cc + k);
    return a;
  }
  // the inputs, in the order of taste.json "features" (kitsunet/taste_features.reference_features)
  function features(a, s) {
    const C = TASTE.constants, k = C.k, n = a.n, f = {};
    const names = ['u_n', 'u_comp', 'u_drop', 'u_pos', 'u_lab', 'u_scored', 'u_mean'];
    names.forEach((nm, i) => { f[nm] = a.u[i]; });
    const { u_comp, u_drop, u_pos } = a, c = s.country, st = s.status;
    Object.assign(f, { s_kr: +(c === 'KR'), s_jp: +(c === 'JP'), s_cn: +(c === 'CN'), s_has_country: +(c !== ''),
      s_fin: +(st === 'FINISHED'), s_rel: +(st === 'RELEASING'), s_hia: +(st === 'HIATUS'), s_can: +(st === 'CANCELLED'), s_has_status: +(st !== ''),
      s_oneshot: +(s.oneshot || 0), s_has_format: +(s.oneshot != null), s_ch: lg(s.chapters), s_has_ch: +!!s.chapters,
      s_pop: lg(s.pop), s_has_pop: +!!s.pop, s_avg: (s.avg || 0) / 100, s_has_avg: +!!s.avg,
      s_year: s.year ? (s.year - 2000) / 10 : 0, s_has_year: +!!s.year, s_ntags: lg(s.tags.length) });
    const g = (map, t) => map.get(t) || 0;
    for (const [px, group] of [['g', s.tags.filter(t => s.genres.has(t))], ['t', s.tags.filter(t => !s.genres.has(t))]]) {
      if (!group.length) { for (const x of ['_share', '_pos', '_comp', '_drop', '_min', '_max']) f[px + x] = 0; continue; }
      let sc = 0, sl = 0, sp = 0, scm = 0, sdr = 0, mn = Infinity, mx = -Infinity;
      for (const t of group) {
        sc += g(a.cnt, t); sl += g(a.lab, t); sp += g(a.pos, t); scm += g(a.comp, t); sdr += g(a.drop, t);
        const r = (g(a.pos, t) + k * u_pos) / (g(a.lab, t) + k); if (r < mn) mn = r; if (r > mx) mx = r;
      }
      f[px + '_share'] = n ? sc / group.length / n : 0;
      f[px + '_pos'] = (sp + k * u_pos) / (sl + k) - u_pos;
      f[px + '_comp'] = (scm + k * u_comp) / (sc + k) - u_comp;
      f[px + '_drop'] = (sdr + k * u_drop) / (sc + k) - u_drop;
      f[px + '_min'] = mn - u_pos; f[px + '_max'] = mx - u_pos;
    }
    const denom = Math.min(C.top, s.tags.length);
    f.top_overlap = denom ? s.tags.filter(t => a.top.has(t)).length / denom : 0;
    f.fav_overlap = denom ? s.tags.filter(t => a.fav.has(t)).length / denom : 0;
    if (c) {
      let cc = 0, cl = 0, cp = 0, ccomp = 0;
      a.entries.forEach((e, i) => { if (e.series.country !== c) return; const l = a.labs[i]; cc++; ccomp += e.status === 'COMPLETED' || e.status === 'REPEATING' ? 1 : 0; if (l != null) { cl++; cp += l; } });
      f.c_share = n ? cc / n : 0; f.c_pos = (cp + k * u_pos) / (cl + k) - u_pos; f.c_comp = (ccomp + k * u_comp) / (cc + k) - u_comp;
    } else f.c_share = f.c_pos = f.c_comp = 0;
    if (st) {
      let zc = 0, zl = 0, zp = 0, zcomp = 0;
      a.entries.forEach((e, i) => { if (e.series.status !== st) return; const l = a.labs[i]; zc++; zcomp += e.status === 'COMPLETED' || e.status === 'REPEATING' ? 1 : 0; if (l != null) { zl++; zp += l; } });
      f.z_share = n ? zc / n : 0; f.z_pos = (zp + k * u_pos) / (zl + k) - u_pos; f.z_comp = (zcomp + k * u_comp) / (zc + k) - u_comp;
    } else f.z_share = f.z_pos = f.z_comp = 0;
    const mine = new Set(s.staff);
    let sn = 0, sl2 = 0, sp2 = 0;
    if (mine.size) a.entries.forEach((e, i) => { if (!e.series.staff.some(x => mine.has(x))) return; sn++; const l = a.labs[i]; if (l != null) { sl2++; sp2 += l; } });
    f.st_n = lg(sn); f.st_pos = mine.size ? (sp2 + k * u_pos) / (sl2 + k) - u_pos : 0; f.st_has = +(mine.size > 0);
    f.pop_diff = s.pop ? f.s_pop - a.popMean : 0;
    f.avg_diff = s.avg ? f.s_avg - a.avgMean : 0;
    f.ch_diff = s.chapters ? f.s_ch - a.chMean : 0;
    return TASTE.features.map(nm => f[nm]);
  }
  function logit(x) {
    const T = TASTE, h = x.map((v, i) => (v - T.mean[i]) / T.std[i]);
    return dense(T.layers, h)[0];
  }
  const sigmoid = z => 1 / (1 + Math.exp(-z));
  function buildProfile(list) {
    const entries = [], seen = new Set();
    for (const e of list || []) {
      if (!e || !STATUSES.includes(e.status)) continue;
      const series = normSeries(e.series);
      if (series.key && seen.has(series.key)) continue;
      if (series.key) seen.add(series.key);
      entries.push({ series, status: e.status, score: Math.max(0, Math.min(100, +e.score || 0)) });
    }
    return { kitsuProfile: true, entries, agg: aggregate(entries) };
  }
  const asProfile = p => (p?.kitsuProfile ? p : buildProfile(Array.isArray(p) ? p : p?.entries || []));
  // the profile without this series (it never judges a series by itself)
  function aggFor(p, s) {
    if (!s.key || !p.entries.some(e => e.series.key === s.key)) return p.agg;
    return aggregate(p.entries.filter(e => e.series.key !== s.key));
  }
  N.taste = function (profile, series) {
    need('taste');
    const p = asProfile(profile), s = normSeries(series);
    return sigmoid(logit(features(aggFor(p, s), s)));
  };
  N.tasteMany = function (profile, list) {
    need('taste');
    const p = asProfile(profile);
    return (list || []).map(x => { const s = normSeries(x); return sigmoid(logit(features(aggFor(p, s), s))); });
  };

  // ---------- your profile from Koru's own data ----------
  // Started series only (a favourite you never opened is "planning" and left out, as in training):
  //   status   absolute trash or a shelf named like "dropped" -> DROPPED; marked completed or a "completed"/"finished"
  //            shelf -> COMPLETED; a "reread" shelf -> REPEATING; anything else you've read -> CURRENT
  //   score    your stars x 20 (1-5 -> 20-100); a like without stars counts as 90
  //   series   genres from the series pages Koru has seen (the More like this cache), plus data.series[key]
  //            (a Koru series or AniList media) when the caller has one
  // Hidden series (the Hide menu item) are left out unless includePrivate is set. Incognito reading is never
  // saved by Koru, so there is nothing of it to leave out.
  N.profileFrom = function (data = K.data, { includePrivate = false } = {}) {
    need('taste');
    const d = data || {}, st = (d === K.data ? K.statsAll?.() : null) || d.stats || {};
    let tagDb = d.tags;
    if (!tagDb) { try { tagDb = JSON.parse(localStorage.getItem('koru-disc-tags') || '{}') || {}; } catch { tagDb = {}; } }
    const keys = new Set();
    for (const store of [d.library, d.history, d.read, d.notes, d.liked, d.flags, st.series]) for (const k of Object.keys(store || {})) if (k.includes(':')) keys.add(k);
    const list = [];
    for (const k of keys) {
      const f = d.flags?.[k] || {}, note = d.notes?.[k] || {}, h = d.history?.[k], lib = d.library?.[k], liked = d.liked?.[k], ss = st.series?.[k];
      if (f.hidden && !includePrivate) continue;
      const shelves = (note.shelves || []).map(x => String(x).toLowerCase());
      const shelf = re => shelves.some(x => re.test(x));
      const readN = Object.keys(d.read?.[k] || {}).length;
      const started = h || readN || ss?.ch || ss?.ms || f.completed || f.trash || note.rating || liked || shelf(/drop|re-?read|complet|finish/);
      if (!started) continue;
      const status = f.trash || shelf(/drop/) ? 'DROPPED' : f.completed || shelf(/complet|finish/) ? 'COMPLETED' : shelf(/re-?read/) ? 'REPEATING' : 'CURRENT';
      const score = note.rating ? Math.max(1, Math.min(5, note.rating)) * 20 : liked ? 90 : 0;
      const i = k.indexOf(':'), provider = k.slice(0, i), slug = k.slice(i + 1), extra = d.series?.[k];
      const base = { provider, slug, title: lib?.title || h?.title || liked?.title || f.title || ss?.title || note.title || slug,
        tags: tagDb[k]?.t || [], status: tagDb[k]?.status || '', total: lib?.total || null };
      const series = extra ? (isAniList(extra) ? { ...base, anilist: extra } : { ...base, ...extra, provider, slug }) : base;
      list.push({ series, status, score });
    }
    return buildProfile(list);
  };

  // ---------- why: 2-3 short reasons from the inputs that moved the answer most ----------
  const GROUPS = {
    tags: ['g_share', 'g_pos', 'g_comp', 'g_drop', 'g_min', 'g_max', 't_share', 't_pos', 't_comp', 't_drop', 't_min', 't_max', 'top_overlap', 'fav_overlap'],
    country: ['c_share', 'c_pos', 'c_comp'],
    staff: ['st_n', 'st_pos', 'st_has'],
    popular: ['s_pop', 's_has_pop', 's_avg', 's_has_avg', 'pop_diff', 'avg_diff'],
    status: ['s_fin', 's_rel', 's_hia', 's_can', 's_has_status', 's_ch', 's_has_ch', 'ch_diff', 's_oneshot', 's_has_format', 'z_share', 'z_pos', 'z_comp'],
    habits: ['u_comp', 'u_drop', 'u_pos']
  };
  const kindOf = s => ({ KR: 'manhwa', JP: 'manga', CN: 'manhua' })[s.country] || 'series';
  function reason(group, up, a, s) {
    const T = TASTE, kind = kindOf(s), k = T.constants.k, name = t => (T.names[t] || t).toLowerCase();
    if (group === 'tags') {
      const rate = t => ((a.pos.get(t) || 0) + k * a.u_pos) / ((a.lab.get(t) || 0) + k);
      // tags that describe the format or the cast rather than the story make clumsy reasons
      const seen = s.tags.filter(t => (a.cnt.get(t) || 0) > 0 && !/protagonist|fullcolor|longstrip|primarily|heterosexual|ensemblecast/.test(t));
      if (!seen.length) return up ? null : `not much like what you usually read`;
      const pick = seen.sort((x, y) => (up ? rate(y) - rate(x) : rate(x) - rate(y)) || (a.cnt.get(y) - a.cnt.get(x)))[0];
      if (up) return (a.comp.get(pick) || 0) >= 2 ? `you finish a lot of ${name(pick)} ${kind}` : `you enjoy ${name(pick)} stories`;
      return (a.drop.get(pick) || 0) >= 1 ? `you often drop ${name(pick)} ${kind}` : `${name(pick)} hasn't clicked with you so far`;
    }
    if (group === 'country') return s.country ? (up ? `you read a lot of ${kind}` : `you rarely stick with ${kind}`) : null;
    if (group === 'staff') { const who = s.staffNames?.[0]; return who ? (up ? `you've read other work by ${who}` : `other work by ${who} didn't land for you`) : null; }
    if (group === 'popular') {
      if (!s.pop && !s.avg) return null;
      const big = s.pop && s.pop >= 20000, good = s.avg && s.avg >= 75;
      if (up) return big && good ? 'very popular and well rated' : big ? 'very popular' : good ? 'well rated' : null;
      return s.avg && s.avg < 65 ? 'mixed reviews' : 'not many readers yet';
    }
    if (group === 'status') {
      const ch = s.chapters ? `, ${s.chapters} chapter${s.chapters === 1 ? '' : 's'}` : '';
      if (s.status === 'FINISHED') return up ? `completed${ch}, ready to binge` : s.chapters && lg(s.chapters) > a.chMean ? 'longer than what you usually finish' : null;
      if (s.status === 'RELEASING') return up ? 'still coming out, with new chapters to look forward to' : 'still ongoing, and you mostly finish completed series';
      if (s.status === 'HIATUS') return up ? null : 'on hiatus right now';
      if (s.status === 'CANCELLED') return up ? null : 'it was cancelled';
      return null;
    }
    if (group === 'habits') return up ? 'you finish most of what you start' : 'you drop a fair share of what you start';
    return null;
  }
  N.why = function (profile, series) {
    need('taste');
    const p = asProfile(profile), s = normSeries(series), a = aggFor(p, s), x = features(a, s), z = logit(x), up = z >= 0;
    const idx = new Map(TASTE.features.map((nm, i) => [nm, i]));
    // how far each group pushes the answer the way it went (that group set to its usual value instead)
    const moves = Object.entries(GROUPS).map(([g, names]) => {
      const y = x.slice(); for (const nm of names) { const i = idx.get(nm); y[i] = TASTE.mean[i]; }
      return { g, d: (z - logit(y)) * (up ? 1 : -1) };
    }).filter(m => m.d > 0).sort((m1, m2) => m2.d - m1.d);
    const out = [];
    for (const min of [0.02, 0]) {              // the clear reasons first; smaller ones only to reach two
      for (const m of moves) { if (m.d < min) continue; const r = reason(m.g, up, a, s); if (r && !out.includes(r)) out.push(r); if (out.length === 3) break; }
      if (out.length >= 2) break;
    }
    return out;
  };

  N._test = { tidy, pieces, fnv1a, idsOf: t => idsOf(t, INT), intentProbs, normSeries, buildProfile, features: (p, s) => features(aggFor(asProfile(p), normSeries(s)), normSeries(s)), label, koruStatus };
  K.kitsuNet = N;
})();
