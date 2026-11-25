// Kitsu: Koru's own assistant. No AI service and no keys: it understands what you type with a set of rules,
// answers from your own data (library, history, ratings, shelves, stats) and asks AniList and your sources when it
// needs to look something up. Everything (chats, settings, Kitsu's bio) stays on this PC.
// Nothing runs until the Kitsu page opens: no timers, no network and no per-frame work at startup.
'use strict';
(function () {
  const { el, icon } = K;
  const baseIcon = K.icon;
  K.icon = (name, cls = '') => (name === 'kitsu' ? K.fox('ic ks-navfox ' + cls) : baseIcon(name, cls));
  const P = id => K.providers?.[id];
  const DAY = 864e5, H = 3600e3;
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
  };
  const lc = s => String(s || '').toLowerCase();
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const fmt = ms => { const m = Math.round((ms || 0) / 60000); return m < 60 ? m + 'm' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
  const pick = (arr, seed) => arr[Math.abs(seed | 0) % arr.length];
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const norm = t => (K.libx?.norm ? K.libx.norm(t) : lc(t).replace(/[^\p{L}\p{N}]+/gu, ''));
  const keysOf = s => (K.libx?.keysOf ? K.libx.keysOf(s) : new Set([norm(s?.title)].filter(Boolean)));
  const tagKey = t => lc(t).replace(/science[\s-]*fiction/, 'scifi').replace(/[^a-z0-9]+/g, '');
  const seriesRoute = (provider, slug) => `/series/${provider}/${encodeURIComponent(slug)}`;
  const readRoute = h => `/read/${h.provider}/${encodeURIComponent(h.slug)}/${encodeURIComponent(h.chapterSlug)}${h.page ? '?page=' + h.page + '&off=' + (h.off || 0) : ''}`;
  const splitKey = k => { const [provider, ...rest] = String(k).split(':'); return { provider, slug: rest.join(':') }; };
  const EMOJI = /\p{Extended_Pictographic}️?/gu;

  // KitsuNet (kitsunet.js, Koru's own small trained networks) is loaded only when the Kitsu page opens
  let netOK = false, netLoading = null;
  function loadNet() {
    if (netLoading) return netLoading;
    netLoading = new Promise(res => {
      const done = () => Promise.resolve(K.kitsuNet?.ready).then(() => { netOK = !!K.kitsuNet?.intent; res(netOK); }, () => res(false));
      if (K.kitsuNet) return done();
      const sc = document.createElement('script'); sc.src = 'js/kitsunet.js'; sc.async = true;
      sc.onload = done; sc.onerror = () => { sc.remove(); res(false); };
      document.head.append(sc);
    });
    return netLoading;
  }

  // ---------- settings and bio (K.data.settings.kitsu) ----------
  const DEF = { len: 'normal', spoilers: false, stream: 'fast', sources: null, ani: true, micLang: 'en-US',
    seePrivate: false, brain: 'smart', llm: true, brainFor: 'all', name: 'Kitsu', avatar: 'fox', color: 'accent', emoji: '🦊', preset: 'friendly', emojiAmt: 1, slang: 0, about: '', talk: '',
    home: 'pop', fab: true, fade: true, fadeTo: 0.35 };
  const S = () => ({ ...DEF, ...(K.data.settings?.kitsu || {}) });
  const setS = patch => { K.data.settings.kitsu = { ...(K.data.settings.kitsu || {}), ...patch }; K.save('settings'); };
  const FOX_COLORS = { accent: 'var(--accent-solid)', ember: '#ff8a3d', snow: '#e9ecff', silver: '#9aa0c4', rose: '#ff6fb1', sky: '#4cc3ff', gold: '#ffc94d', mint: '#4ee0a8' };
  const AVATAR_EMOJI = ['🦊', '🐱', '🐺', '🐉', '🌙', '✨', '📚', '🍜'];
  const LANGS = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['fr-FR', 'Français'], ['es-ES', 'Español'], ['pt-BR', 'Português (Brasil)'], ['de-DE', 'Deutsch'],
    ['it-IT', 'Italiano'], ['id-ID', 'Bahasa Indonesia'], ['fil-PH', 'Filipino'], ['ko-KR', '한국어'], ['ja-JP', '日本語'], ['zh-CN', '中文']];

  // ---------- what words mean: a concept is a genre or trope, with its AniList genres/tags and the words that say it ----------
  const C = (id, label, re, o = {}) => ({ id, label, re, genres: o.g || [], tags: o.t || [], words: o.w || [], src: o.s || [id] });
  const CONCEPTS = [
    C('regression', 'regression', /\b(regress\w*|returner|back in time|go(?:es|ing)? back in time|went back in time|turn(?:s|ed)? back time|second chance|do-?over|redo(?:es|ing)? (?:his|her|their) life|back to the past|returns? to the past|time travel\w*)\b/,
      { t: ['Age Regression', 'Time Loop', 'Time Manipulation'], w: ['regress', 'return', 'past', 'again', 'second chance', 'back in time'], s: ['regression', 'timetravel', 'returner', 'timeloop'] }),
    C('reincarnation', 'reincarnation', /\b(reincarnat\w*|reborn|rebirth|transmigrat\w*|possess(?:es|ed)? (?:the )?body|in(?:to)? the body of|wakes up as)\b/, { t: ['Reincarnation'], w: ['reincarnat', 'reborn', 'rebirth', 'transmigrat', 'body'], s: ['reincarnation', 'transmigration', 'rebirth'] }),
    C('isekai', 'isekai', /\b(isekai|another world|other world|summoned|transported to)\b/, { t: ['Isekai'], w: ['another world', 'summon', 'transport'] }),
    C('system', 'a system', /\b(system|status window|level(?:s|ing)? up|leveling|quests?|stat points|game ?like)\b/, { t: ['Video Games'], w: ['system', 'level', 'status', 'quest', 'skill'], s: ['system', 'gameelements', 'game'] }),
    C('murim', 'murim', /\b(murim|martial arts?|sects?|clans?|kung ?fu|wuxia|cultivat\w*|qi|heavenly demon|mount hua)\b/, { t: ['Martial Arts', 'Wuxia', 'Cultivation'], w: ['murim', 'martial', 'sect', 'clan', 'cultivat'], s: ['murim', 'martialarts', 'wuxia', 'cultivation', 'xianxia'] }),
    C('tower', 'a tower', /\b(tower|floors?|climb(?:s|ing)? the)\b/, { t: ['Dungeon'], w: ['tower', 'floor', 'climb'], s: ['tower'] }),
    C('dungeon', 'dungeons', /\b(dungeons?|gates?|raids?|portals?)\b/, { t: ['Dungeon'], w: ['dungeon', 'gate', 'raid'], s: ['dungeon', 'dungeons'] }),
    C('hunter', 'hunters', /\b(hunters?|awaken\w*|s-?rank|e-?rank|f-?rank)\b/, { t: ['Dungeon', 'Super Power'], w: ['hunter', 'awaken', 'rank', 'gate'], s: ['hunter', 'hunters'] }),
    C('villainess', 'villainess stories', /\b(villainess|villain(?:ess)? of|otome|novel (?:villain|extra)|duke'?s daughter)\b/, { t: ['Villainess'], w: ['villain', 'novel', 'duke', 'lady'], s: ['villainess'] }),
    C('academy', 'academy', /\b(academy|school|students?|college|university|classmates?)\b/, { t: ['School'], w: ['academy', 'school', 'student'], s: ['school', 'academy', 'schoollife'] }),
    C('smith', 'blacksmithing', /\b(blacksmith\w*|smith(?:ing)?|forg(?:e|es|ing|ed)|crafts?(?:man|ing)?|weapons? maker)\b/, { t: ['Crafts'], w: ['blacksmith', 'smith', 'forge', 'craft', 'weapon'], s: ['crafting'] }),
    C('cooking', 'cooking', /\b(cook\w*|chef|restaurant|food|recipes?)\b/, { t: ['Food', 'Restaurant'], w: ['cook', 'chef', 'food', 'restaurant'], s: ['cooking', 'food'] }),
    C('revenge', 'revenge', /\b(reveng\w*|vengean\w*|betray\w*|payback)\b/, { t: ['Revenge'], w: ['revenge', 'betray', 'vengeance'] }),
    C('apocalypse', 'apocalypse', /\b(apocalyp\w*|zombies?|end of the world|post-?apocalyptic|survival)\b/, { t: ['Post-Apocalyptic', 'Survival', 'Zombie'], w: ['apocalyp', 'zombie', 'surviv', 'end of the world'], s: ['apocalypse', 'postapocalyptic', 'survival', 'zombies'] }),
    C('magic', 'magic', /\b(magic\w*|mages?|wizards?|sorcer\w*|spells?|witch\w*)\b/, { t: ['Magic'], w: ['magic', 'mage', 'wizard', 'spell'] }),
    C('necro', 'necromancy', /\b(necromanc\w*|undead|skeletons?)\b/, { t: ['Necromancy'], w: ['necromanc', 'undead', 'skeleton'] }),
    C('demons', 'demons', /\b(demons?|devils?|demon king|demon lord)\b/, { t: ['Demons'], w: ['demon', 'devil'] }),
    C('gods', 'gods', /\b(gods?|deit(?:y|ies)|divine|constellations?)\b/, { t: ['Gods'], w: ['god', 'constellation', 'divine'] }),
    C('dragons', 'dragons', /\b(dragons?)\b/, { t: ['Dragons'], w: ['dragon'] }),
    C('vampire', 'vampires', /\b(vampires?)\b/, { t: ['Vampire'], w: ['vampire'] }),
    C('royalty', 'royalty', /\b(princes(?:s|ses)?|empress|emperor|empire|duke|duchess|noble\w*|royal\w*|kingdom|throne|crown)\b/, { t: ['Royal Affairs'], w: ['prince', 'emperor', 'empress', 'duke', 'noble', 'throne'], s: ['royalty', 'nobility', 'historical'] }),
    C('op', 'an overpowered lead', /\b(op mc|overpowered|strongest|weakest to strongest|one ?punch|god-?like)\b/, { w: ['strongest', 'overpower', 'weakest'], s: ['overpowered', 'opmc', 'strongmc'] }),
    C('games', 'games', /\b(video games?|vrmmo\w*|virtual reality|players?|gamer|game world|mmorpg)\b/, { t: ['Video Games', 'Virtual World'], w: ['game', 'player', 'virtual'], s: ['game', 'videogames', 'virtualreality'] }),
    C('war', 'war', /\b(wars?|army|armies|soldiers?|military|battlefield|general)\b/, { t: ['Military', 'War'], w: ['war', 'army', 'soldier', 'military'], s: ['military', 'war'] }),
    C('knights', 'swordplay', /\b(knights?|swords?(?:man|men|master)?|swordplay|fencing)\b/, { t: ['Swordplay'], w: ['knight', 'sword'] }),
    C('medical', 'medicine', /\b(doctors?|surgeons?|medic\w*|hospital|healer)\b/, { t: ['Medicine'], w: ['doctor', 'surgeon', 'medic', 'hospital'], s: ['medical'] }),
    C('idol', 'showbiz', /\b(idols?|actors?|actress|celebrit\w*|entertainment|k-?pop)\b/, { t: ['Idol', 'Acting'], w: ['idol', 'actor', 'celebrit', 'entertainment'] }),
    C('office', 'office life', /\b(office|company|corporate|salary ?man|employees?|ceo)\b/, { t: ['Office', 'Work'], w: ['office', 'company', 'employee', 'ceo'] }),
    C('taming', 'beast taming', /\b(tam(?:e|er|ing)|summoners?|beasts?|pets?)\b/, { t: ['Creature Taming'], w: ['tame', 'summon', 'beast'] }),
    C('crime', 'crime', /\b(crime|gangs?|mafia|yakuza|detectives?|murder\w*|police)\b/, { t: ['Crime'], w: ['crime', 'gang', 'mafia', 'detective', 'murder'] }),
    C('fights', 'street fights', /\b(delinquents?|bull(?:y|ies|ied|ying)|street fights?|fight club|gangster)\b/, { t: ['Delinquents', 'Bullying'], w: ['bully', 'fight', 'delinquent'], s: ['delinquents', 'bullying'] }),
    C('deathgame', 'death games', /\b(death games?|battle royale|survival games?)\b/, { t: ['Death Game', 'Battle Royale'], w: ['death game', 'survive'] }),
    C('family', 'family', /\b(famil(?:y|ies)|daughter|parent\w*|dad|father|mother|child(?:ren)?|baby)\b/, { t: ['Family Life', 'Found Family'], w: ['family', 'daughter', 'father', 'child'] }),
    C('harem', 'harem', /\b(harem)\b/, { t: ['Female Harem'], w: ['harem'] }),
    C('bl', "boys' love", /\b(bl|boys'? ?love|yaoi)\b/, { t: ["Boys' Love"], w: [], s: ['bl', 'boyslove', 'yaoi', 'shounenai'] }),
    C('gl', 'girls\' love', /\b(gl|yuri|girls'? ?love)\b/, { t: ['Yuri'], w: [], s: ['gl', 'yuri', 'girlslove', 'shoujoai'] }),
    C('gore', 'gore', /\b(gore|gory|blood(?:y)?)\b/, { t: ['Gore'], w: ['gore', 'blood'] }),
    C('femlead', 'a female lead', /\b(female (?:lead|mc|protagonist)|girl (?:lead|mc)|fl\b|she becomes)\b/, { t: ['Female Protagonist'], w: [] }),
    // genres
    C('action', 'action', /\b(action|fights?|fighting|battles?)\b/, { g: ['Action'] }),
    C('adventure', 'adventure', /\b(adventures?|journey|quest for)\b/, { g: ['Adventure'] }),
    C('comedy', 'comedy', /\b(comedy|funny|hilarious|laugh\w*|comedic)\b/, { g: ['Comedy'] }),
    C('drama', 'drama', /\b(drama|dramatic|emotional|tearjerker|sad)\b/, { g: ['Drama'] }),
    C('fantasy', 'fantasy', /\b(fantasy)\b/, { g: ['Fantasy'] }),
    C('horror', 'horror', /\b(horror|scary|creepy|terrifying)\b/, { g: ['Horror'] }),
    C('mystery', 'mystery', /\b(myster\w*|whodunit)\b/, { g: ['Mystery'] }),
    C('psychological', 'psychological', /\b(psychological|mind games?|mind-?bending)\b/, { g: ['Psychological'] }),
    C('romance', 'romance', /\b(romance|romantic|love story|love stories|dating|in love|marriage|married|rom-?com)\b/, { g: ['Romance'], w: ['love', 'marri', 'romance'] }),
    C('scifi', 'sci-fi', /\b(sci-?fi|science fiction|space|aliens?|robots?|mecha|cyberpunk)\b/, { g: ['Sci-Fi'] }),
    C('sol', 'slice of life', /\b(slice of life|wholesome|cozy|cosy|healing|relaxing|comfy)\b/, { g: ['Slice of Life'], s: ['sliceoflife'] }),
    C('sports', 'sports', /\b(sports?|football|soccer|basketball|baseball|volleyball|boxing|mma|swimming|tennis)\b/, { g: ['Sports'] }),
    C('supernatural', 'supernatural', /\b(supernatural|ghosts?|spirits?|exorcis\w*|shaman)\b/, { g: ['Supernatural'] }),
    C('thriller', 'thriller', /\b(thrillers?|suspense\w*|thrilling)\b/, { g: ['Thriller'] }),
    C('ecchi', 'ecchi', /\b(ecchi|fan ?service)\b/, { g: ['Ecchi'] })
  ];
  const CBY = Object.fromEntries(CONCEPTS.map(c => [c.id, c]));
  const GENRES = ['Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'];
  const GENRE_BY_KEY = Object.fromEntries(GENRES.map(g => [tagKey(g), g]));
  const conceptsIn = text => { const t = lc(text); return CONCEPTS.filter(c => c.re.test(t)); };
  // "no romance", "without harem", "not horror": things to leave out of this one answer
  function negated(text) {
    const out = new Set(), t = lc(text);
    for (const m of t.matchAll(/\b(?:no|not|without|avoid|skip|except|minus|nothing with|hate|don'?t like|dont want|no more)\s+(?:any\s+|too much\s+|the\s+)?([a-z' -]{2,30})/g)) {
      for (const c of conceptsIn(m[1].split(/\b(?:and|but|or|please|thanks)\b|[,.!?]/)[0])) out.add(c.id);
    }
    return out;
  }

  // ---------- About me and How Kitsu should talk ----------
  function aboutMe(text = S().about) {
    const out = { name: '', likes: new Set(), avoid: new Set() };
    const t = String(text || '');
    const n = t.match(/(?:call me|my name is|name\s*[:=]|i go by|address me as)\s+["“]?([\p{L}][\p{L}\p{N}'-]{0,20})/iu);
    if (n) out.name = n[1];
    for (const clause of lc(t).split(/[.\n;!?]+|\bbut\b/)) {
      if (!clause.trim()) continue;
      const neg = /\b(avoid|hate|don'?t like|dont like|not into|not a fan|no more|can'?t stand|skip|dislike|never|without|no)\b/.test(clause);
      const pos = /\b(like|love|enjoy|favou?rite|into|fan of|prefer|adore|obsessed)\b/.test(clause);
      const found = conceptsIn(clause);
      if (neg) found.forEach(c => out.avoid.add(c.id));
      else if (pos || found.length) found.forEach(c => out.likes.add(c.id));
    }
    for (const id of out.avoid) out.likes.delete(id);
    return out;
  }
  function talkRules(text = S().talk) {
    const raw = String(text || ''), t = lc(raw);
    return {
      lower: /lower ?case|no capitals|no caps|all small letters/.test(t),
      noEmoji: /no emoji|without emoji|don'?t use emoji|zero emoji/.test(t),
      moreEmoji: /(more|lots of|many|loads of) emoji/.test(t),
      short: /\b(short|brief|concise|to the point|few words|keep it quick)\b/.test(t),
      long: /\b(detailed|long(er)? answers|explain more|thorough|in depth)\b/.test(t),
      noExcl: /no exclamation|calm|not loud|don'?t shout/.test(t),
      pirate: /pirate/.test(t), uwu: /\buwu\b|owo/.test(t), mate: /british|aussie|\bmate\b/.test(t),
      call: (raw.match(/call me\s+["“]?([\p{L}][\p{L}\p{N}' -]{0,20}?)["”]?(?=[.,!\n]|$|\s+and\b)/iu) || [])[1] || '',
      sign: ((raw.match(/(?:end|sign off|finish|close)\s+(?:every|each|your|all)?\s*(?:message|reply|replies|answer|answers)?\s*with\s+["“]?([^"”\n]{1,30}?)["”]?(?=[.\n]|$)/i) || [])[1] || '').trim()
    };
  }

  // ---------- the voice: every reply goes through this ----------
  const PRESETS = {
    friendly: { name: 'Friendly', blurb: 'Warm, upbeat, helpful', emoji: 1, slang: 0, em: ['🦊', '✨', '📚', '💫'], t: {
      hi: ['Hey{n}! What\'s up?', 'Hi{n}! How\'s it going?', 'Hello{n}! What\'s on your mind?'],
      recs: ['Here are a few I think you\'ll like.', 'These look right up your alley.', 'I picked these for you.'],
      recsAsk: ['Here\'s some {what} I think you\'ll enjoy.', 'Got some {what} for you.'],
      more: ['Here\'s another batch.', 'A few more for you.'],
      notThat: ['No problem, how about these instead?', 'Fair enough! Try these.'],
      like: ['If you liked **{title}**, try these.', 'More in the spirit of **{title}**:'],
      find: ['These are my best guesses.', 'I think it might be one of these.'],
      findTop: ['I\'m fairly sure it\'s **{title}**.', 'My best guess is **{title}**.'],
      none: ['I couldn\'t find that one. Any other detail you remember?', 'Hmm, nothing matched. Try another detail?'],
      stats: ['Here\'s your reading {when}.', 'Your reading {when}:'],
      offline: ['AniList didn\'t answer just now, so this is from your sources only.'],
      empty: ['Nothing here yet. Read a chapter or two and ask me again!'],
      help: ['Here\'s how.', 'Easy one.'],
      unsure: ['I didn\'t quite get that. Here\'s what I can do:', 'Not sure I follow. Try one of these:'],
      thanks: ['Any time{n}!', 'Happy to help!', 'Glad I could help{n}!'],
      bye: ['Happy reading{n}!', 'See you in the next chapter!'],
      open: ['Found it on {src}. Opening it now.'],
      openNone: ['I couldn\'t find it on your sources, so I\'ve searched for it instead.'],
      me: ['I\'m {name}, Koru\'s own assistant. I run right here on your PC, know your library and stats, and help you find your next read.'],
      ok: ['Done!', 'All set.']
    } },
    hype: { name: 'Hype', blurb: 'Loud, excited, all caps energy', emoji: 2, slang: 1, em: ['🔥', '⚡', '🚀', '💥', '🙌'], t: {
      hi: ['YO{n}! What\'s good?!', 'Heyyy{n}! How we doing?!'],
      recs: ['Okay these are straight FIRE:', 'Buckle up, these go HARD:', 'You NEED these in your life:'],
      recsAsk: ['{what}? Say less. These are BANGERS:', 'Oh you want {what}? I got the GOOD stuff:'],
      more: ['LET\'S GO, more heat incoming!', 'Round two, even better:'],
      notThat: ['No worries, swapping in fresh heat:', 'Next! These hit different:'],
      like: ['Loved **{title}**? These are the SAME energy:', 'If **{title}** hyped you up, wait till you see these:'],
      find: ['Detective mode ON. Best matches:', 'Ooh, I think I found it:'],
      findTop: ['GOT IT! Pretty sure it\'s **{title}**!', 'It\'s gotta be **{title}**!'],
      none: ['Argh, nothing yet! Give me ONE more clue!', 'It\'s hiding from me! Any other detail?'],
      stats: ['Look at these numbers {when}!', 'Your reading {when}? IMPRESSIVE:'],
      empty: ['Nothing yet, but your legend starts NOW. Go read a chapter!'],
      help: ['Easy! Here\'s how:', 'Gotchu:'],
      unsure: ['Huh? Run that back! Here\'s what I can do:', 'Lost me there! Try one of these:'],
      thanks: ['ANYTIME{n}!', 'That\'s what I\'m here for!'],
      bye: ['Go crush those chapters{n}!', 'Later! Read something AMAZING!'],
      open: ['FOUND IT on {src}! Opening NOW!'],
      openNone: ['Not on your sources yet, so I fired up a search!'],
      me: ['I\'m {name}! Koru\'s very own hype fox, living on your PC, knowing your library and finding you BANGERS!'],
      ok: ['DONE!', 'Boom, done!']
    } },
    chill: { name: 'Chill', blurb: 'Laid-back, few words', emoji: 1, slang: 1, em: ['🌙', '🍵', '😌', '🌿'], t: {
      hi: ['hey{n}. what\'s up?', 'hi{n}. how\'s it going?'],
      recs: ['here\'s a few, no rush.', 'these might be your vibe.', 'some picks for you.'],
      recsAsk: ['some {what} for you.', 'here\'s a bit of {what}.'],
      more: ['a few more.', 'here, some others.'],
      notThat: ['all good, maybe these.', 'no worries, try these.'],
      like: ['if you liked **{title}**, these feel similar.', 'same vibe as **{title}**:'],
      find: ['could be one of these.', 'maybe one of these?'],
      findTop: ['pretty sure it\'s **{title}**.', 'probably **{title}**.'],
      none: ['couldn\'t find it. got another detail?', 'nothing yet. anything else you remember?'],
      stats: ['your reading {when}:', 'here\'s {when}.'],
      empty: ['nothing here yet. read a bit and ask again.'],
      help: ['here\'s how.', 'easy:'],
      unsure: ['not sure what you mean. maybe one of these:', 'hm, didn\'t get that. try these:'],
      thanks: ['anytime{n}.', 'no problem.'],
      bye: ['later{n}. enjoy the read.', 'take it easy.'],
      open: ['found it on {src}. opening.'],
      openNone: ['not on your sources, so i searched for it.'],
      me: ['i\'m {name}. i live in koru on your pc, know your library and help you pick what to read.'],
      ok: ['done.', 'there you go.']
    } },
    sarcastic: { name: 'Sarcastic but kind', blurb: 'Teasing, but always helps', emoji: 1, slang: 0, em: ['🙄', '😏', '💅', '🦊'], t: {
      hi: ['Oh look, it\'s you{n}. To what do I owe the pleasure?', 'Back again{n}? I\'m flattered. What\'s up?'],
      recs: ['Fine, here are some I definitely didn\'t pick just for you.', 'Brace yourself, these are actually good:', 'Here. Try not to binge them all tonight. (You will.)'],
      recsAsk: ['{what}? Bold choice. Fine, these are good:', 'You want {what}. Of course you do. Here:'],
      more: ['More? Your backlog is crying. Okay:', 'Greedy. I respect it. Here:'],
      notThat: ['Picky, aren\'t we? Okay, these then.', 'Wow, rude. Fine, try these.'],
      like: ['So **{title}** got you. Predictable. These are similar:', 'Ah, a **{title}** fan. These scratch the same itch:'],
      find: ['Ah yes, the famous "that one". I think it\'s one of these:', 'Vague, but I\'m good. Try these:'],
      findTop: ['Kidding aside, I\'m pretty sure it\'s **{title}**.', 'Easy. It\'s **{title}**. You\'re welcome.'],
      none: ['Nothing. Zero. Give me another clue, detective.', 'Even I can\'t work with that. Another detail?'],
      stats: ['Let\'s see how productive you\'ve been {when}:', 'Your reading {when}. No judgement. Okay, a little.'],
      empty: ['Empty. Like my patience. Kidding! Go read a chapter and ask again.'],
      help: ['Gasp, you asked for help. Here:', 'Here, since you asked nicely:'],
      unsure: ['I have no idea what that means. Try one of these:', 'Was that a question? Try these:'],
      thanks: ['You\'re welcome. Obviously.', 'I know, I\'m great{n}.'],
      bye: ['Go on, read{n}. I\'ll be here. Waiting. As always.', 'Bye! Don\'t stay up till 4 again.'],
      open: ['Found it on {src}. Opening it, as I do everything around here.'],
      openNone: ['Your sources are hiding it, so I ran a search. You\'re welcome.'],
      me: ['I\'m {name}. I live in Koru on your PC, I know your library better than you do, and I find your next read.'],
      ok: ['Done. Obviously.', 'Handled.']
    } },
    formal: { name: 'Formal', blurb: 'Polite and precise', emoji: 0, slang: 0, em: ['📚'], t: {
      hi: ['Good day{n}. How are you?', 'Welcome{n}. How may I help?'],
      recs: ['Here are my recommendations.', 'I would suggest the following titles.'],
      recsAsk: ['Here are my recommendations for {what}.', 'Certainly. The following titles offer {what}.'],
      more: ['Certainly. Here are further suggestions.', 'Here are additional titles.'],
      notThat: ['Understood. Please consider these alternatives.', 'Of course. Here are other options.'],
      like: ['Titles similar to **{title}**:', 'Readers of **{title}** may also enjoy the following.'],
      find: ['These are the most likely matches.', 'The following titles match your description.'],
      findTop: ['The most likely match is **{title}**.', 'It is most likely **{title}**.'],
      none: ['I was unable to locate that title. Could you provide another detail?'],
      stats: ['Here is a summary of your reading {when}.'],
      empty: ['There is no data yet. Please read a chapter and ask again.'],
      help: ['Here are the steps.', 'Certainly.'],
      unsure: ['I am afraid I did not understand. I can assist with the following:'],
      thanks: ['You are most welcome{n}.', 'It is my pleasure.'],
      bye: ['Enjoy your reading{n}.', 'Until next time.'],
      open: ['I found it on {src} and am opening it now.'],
      openNone: ['It was not found on your sources, so I have started a search.'],
      me: ['I am {name}, the assistant built into Koru. I run locally on your PC, consult your library and statistics, and help you choose what to read.'],
      ok: ['Completed.', 'It is done.']
    } }
  };
  const CONTRACT = [[/\bdon't\b/g, 'do not'], [/\bdoesn't\b/g, 'does not'], [/\bI'm\b/g, 'I am'], [/\byou're\b/gi, 'you are'], [/\bit's\b/g, 'it is'], [/\bIt's\b/g, 'It is'],
    [/\bcan't\b/g, 'cannot'], [/\bwon't\b/g, 'will not'], [/\bhere's\b/g, 'here is'], [/\bHere's\b/g, 'Here is'], [/\bthat's\b/g, 'that is'], [/\byou've\b/g, 'you have'], [/\bI've\b/g, 'I have'],
    [/\bhaven't\b/g, 'have not'], [/\bisn't\b/g, 'is not'], [/\bcouldn't\b/g, 'could not'], [/\bI'd\b/g, 'I would'], [/\byou'll\b/g, 'you will'], [/\bI'll\b/g, 'I will'], [/\blet's\b/gi, 'let us']];
  const SLANG1 = [[/\bgoing to\b/g, 'gonna'], [/\bwant to\b/g, 'wanna'], [/\bkind of\b/g, 'kinda'], [/\bsort of\b/g, 'sorta'], [/\bvery good\b/g, 'super good'], [/\bpretty sure\b/g, 'lowkey sure'], [/\bfavourites\b/g, 'faves']];
  const SLANG2 = [[/\breally\b/g, 'hella'], [/\bamazing\b/gi, 'insane'], [/\bvery\b/g, 'mad'], [/\bgood\b/g, 'bussin'], [/\bhonestly\b/gi, 'ngl'], [/\bfriend\b/g, 'bestie'], [/\bI think\b/g, 'ngl I think']];
  // the persona's line for a key, filled in ({n} = ", Name" when Kitsu knows what to call you)
  function line(key, vars = {}, seed = 0) {
    const s = S(), pr = PRESETS[s.preset] || PRESETS.friendly;
    const opts = pr.t[key] || PRESETS.friendly.t[key] || [key];
    const name = talkRules(s.talk).call || aboutMe(s.about).name;
    const out = pick(opts, seed + hash(key)).replace(/\{(\w+)\}/g, (_, k) => k === 'n' ? (name ? ', ' + name : '') : k === 'name' ? (s.name || 'Kitsu') : String(vars[k] ?? ''));
    return s.preset === 'chill' ? out : out.replace(/^([a-z])/, c => c.toUpperCase());
  }
  // style a finished reply: formal wording, slang, emoji, lowercase, sign-off. **bold** parts (titles) are left alone.
  function voice(text, { key = '', seed = 0, last = true, bare = false } = {}) {
    const s = S(), pr = PRESETS[s.preset] || PRESETS.friendly, tr = talkRules(s.talk);
    const amt = tr.noEmoji ? 0 : tr.moreEmoji ? 2 : Number(s.emojiAmt ?? pr.emoji);
    const slang = s.preset === 'formal' ? 0 : Number(s.slang ?? pr.slang);
    const parts = String(text).replace(/★/g, '\u0001').split(/(\*\*[^*]+\*\*)/);
    for (let i = 0; i < parts.length; i += 2) {
      let p = parts[i];
      if (s.preset === 'formal') for (const [a, b] of CONTRACT) p = p.replace(a, b);
      if (slang >= 1) for (const [a, b] of SLANG1) p = p.replace(a, b);
      if (slang >= 2) for (const [a, b] of SLANG2) p = p.replace(a, b);
      if (tr.noExcl) p = p.replace(/!+/g, '.');
      if (tr.pirate) p = p.replace(/\bmy friend\b/g, 'matey').replace(/\byes\b/gi, 'aye').replace(/\byour\b/g, 'yer').replace(/\bHello\b|\bHi\b|\bHey\b/g, 'Ahoy');
      if (tr.lower || s.preset === 'chill') p = tr.lower ? p.toLowerCase() : p;
      if (amt === 0) p = p.replace(EMOJI, '').replace(/ {2,}/g, ' ');
      parts[i] = p;
    }
    if (tr.lower) for (let i = 1; i < parts.length; i += 2) parts[i] = parts[i].toLowerCase();
    let out = parts.join('').replace(/\u0001/g, '★').trim();
    const lines = out.split('\n');
    const has = out.match(EMOJI)?.length || 0;
    const em = pick(pr.em, seed + hash(key || out.slice(0, 12)));
    if (bare) return lines.join('\n');
    if (amt >= 1 && !has && lines[0]) lines[0] = lines[0].replace(/[.:!]?$/, m => (m === ':' ? ' ' + em + ':' : m + ' ' + em));
    if (amt >= 2 && lines.length > 1) { const j = lines.length - 1; if (!EMOJI.test(lines[j])) lines[j] += ' ' + pick(pr.em, seed + 3); EMOJI.lastIndex = 0; }
    if (slang >= 2 && lines[0] && (seed % 3 === 0)) lines[0] = lines[0].replace(/[.!]?(\s*\p{Extended_Pictographic}️?)?$/u, m => ' fr' + m.replace(/^[.!]/, ''));
    if (tr.uwu && lines[0]) lines[0] += ' uwu';
    if (tr.mate && lines[0] && seed % 2 === 0) lines[0] = lines[0].replace(/([.!?])(\s*\p{Extended_Pictographic}️?)?$/u, ', mate$1$2');
    if (tr.sign && last) lines.push(tr.sign);
    return lines.join('\n');
  }
  // how many cards and which lines a reply keeps for your length setting
  const lenOf = () => { const tr = talkRules(); return tr.short ? 'short' : tr.long ? 'detailed' : S().len; };
  const cardCount = () => ({ short: 3, normal: 5, detailed: 8 })[lenOf()] || 5;

  // A reply under construction. say() = a persona line, add() = plain text (still styled), detail() = only in Detailed.
  function Reply(key, seed) {
    const r = { key, seed: seed || Date.now() % 997, lines: [], cards: [], chips: [], actions: [], meta: null };
    r.say = (k, vars) => {
      const said = r.ctx ? (r.ctx.said ||= []) : [];
      let t = line(k, vars, r.seed);
      for (let i = 1; i < 8 && said.includes(t); i++) t = line(k, vars, r.seed + i * 7);
      if (r.ctx) { said.push(t); if (said.length > 12) said.shift(); }
      r.lines.push({ t, core: true, tpl: true, k }); return r;
    };
    r.approve = a => { r.approveReq = { ...a, id: Date.now().toString(36) }; return r; };
    r.add = t => { if (t) r.lines.push({ t, core: true }); return r; };
    r.detail = t => { if (t) r.lines.push({ t, core: false }); return r; };
    r.card = c => { if (c) r.cards.push(c); return r; };
    r.chip = (...c) => { r.chips.push(...c.filter(Boolean)); return r; };
    r.act = a => { if (a) r.actions.push(a); return r; };
    r.done = () => {
      const len = lenOf();
      let lines = r.lines.filter(l => l.core || len === 'detailed');
      if (len === 'short' && lines.length > 2) { const data = lines.filter(l => !l.tpl); lines = (data.length >= 2 ? data : [lines.find(l => l.tpl), ...data].filter(Boolean)).slice(0, 2); }
      const text = voice(lines.map(l => l.t).join('\n'), { key: r.key, seed: r.seed });
      return { role: 'bot', text, facts: factsOf(r), cards: r.cards.slice(0, r.keepCards ?? cardCount()), chips: [...new Set(r.chips)].slice(0, 5), actions: r.actions.slice(0, 3), approve: r.approveReq || null, at: Date.now(), key: r.key };
    };
    return r;
  }

  // ---------- AniList (public, no key; Koru's background side sends the query) ----------
  const ANI_FIELDS = 'id title{english romaji native} synonyms coverImage{large color} description(asHtml:false) genres tags{name rank isMediaSpoiler} chapters status averageScore popularity countryOfOrigin format startDate{year}';
  const aniOK = () => S().ani && K.info?.platform !== 'web';
  const aniCache = new Map();
  async function ani(query, ttl = 30 * 60e3) {
    const hit = aniCache.get(query);
    if (hit && Date.now() - hit.at < ttl) return hit.data;
    let r;
    for (let tries = 0; ; tries++) {
      await aniSlot();
      r = await withTimeout(fetch('/k/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ u: 'https://graphql.anilist.co', body: { query } }) }), 25000);
      if (r.status !== 429 || tries) break;
      await new Promise(res => setTimeout(res, 5000));
    }
    if (r.status === 429) { aniBusy = Date.now() + 25e3; throw new Error('AniList is busy'); }
    const j = await r.json().catch(() => null);
    if (!j?.data) throw new Error(j?.errors?.[0]?.message || 'AniList didn\'t answer');
    aniCache.set(query, { at: Date.now(), data: j.data });
    if (aniCache.size > 60) aniCache.delete(aniCache.keys().next().value);
    return j.data;
  }
  const aniTimes = []; let aniBusy = 0;
  async function aniSlot() {   // AniList allows about 30 requests a minute
    const now = Date.now();
    while (aniTimes.length && now - aniTimes[0] > 60e3) aniTimes.shift();
    if (Date.now() < aniBusy) throw new Error('AniList is busy');
    if (aniTimes.length >= 20) await new Promise(res => setTimeout(res, Math.min(6000, 60e3 - (now - aniTimes[0]))));
    aniTimes.push(Date.now());
  }
  const gq = v => JSON.stringify(v);   // a GraphQL literal: strings and string lists are written the same as JSON
  // one request with several named lists: parts = { alias: { args: 'type:MANGA,...', n: 20 } }
  async function aniPages(parts) {
    const body = Object.entries(parts).map(([a, p]) => `${a}:Page(perPage:${p.n || 20}){media(type:MANGA,isAdult:false,${p.args}){...F}}`).join(' ');
    const data = await ani(`fragment F on Media{${ANI_FIELDS}} query{${body}}`);
    const out = {};
    for (const a of Object.keys(parts)) out[a] = data?.[a]?.media || [];
    return out;
  }
  let tagList = null;
  async function aniTagNames() {
    if (tagList) return tagList;
    const c = ls.get('koru-kitsu-anitags', null);
    if (c?.list?.length && Date.now() - c.at < 30 * DAY) return (tagList = new Map(c.list.map(n => [tagKey(n), n])));
    try {
      const d = await ani('query{MediaTagCollection{name isAdult}}', 30 * DAY);
      const list = (d.MediaTagCollection || []).filter(t => !t.isAdult).map(t => t.name);
      if (list.length) ls.set('koru-kitsu-anitags', { at: Date.now(), list });
      return (tagList = new Map(list.map(n => [tagKey(n), n])));
    } catch { return new Map(CONCEPTS.flatMap(c => c.tags).map(n => [tagKey(n), n])); }
  }
  const cleanDesc = (d, spoilers = S().spoilers) => {
    let s = String(d || '');
    s = spoilers ? s.replace(/~!|!~/g, '') : s.replace(/~![\s\S]*?!~/g, '');
    return K.plainText(s.replace(/<br\s*\/?>/gi, '\n')).replace(/\(Source:[^)]*\)/gi, '').replace(/\n{2,}/g, '\n').trim();
  };
  const COUNTRY = { KR: 'Manhwa', CN: 'Manhua', JP: 'Manga', TW: 'Manhua' };
  const STATUS = { FINISHED: 'Completed', RELEASING: 'Ongoing', HIATUS: 'On hiatus', CANCELLED: 'Cancelled', NOT_YET_RELEASED: 'Not out yet' };
  // an AniList entry as a Kitsu card
  function aniCard(m, why) {
    // English first; with no English title, an English-looking alternative name beats a romanized one
    const t = m.title || {}, enSyn = (m.synonyms || []).find(x => /^[\x20-\x7e]+$/.test(x) && / /.test(x) && x !== t.romaji && /\b(the|of|a|to|in|my|is|and|i|you|with|return\w*|regress\w*|reincarnat\w*|level\w*|king|lord|god|demon|sword\w*|martial|hunter|villain\w*|duke|lady|prince\w*|player|tower|academy|mad|dog|dragon|heavenly)\b/i.test(x));
    const title = t.english || enSyn || t.romaji || t.native || 'Untitled';
    const alt = [t.romaji, t.english, ...(m.synonyms || [])].filter(x => x && x !== title && /[a-z]/i.test(x)).slice(0, 6);
    const meta = [COUNTRY[m.countryOfOrigin] || m.format, m.chapters ? m.chapters + ' ch' : null, STATUS[m.status], m.averageScore ? m.averageScore + '%' : null, m.startDate?.year].filter(Boolean).join(' · ');
    const tags = (m.tags || []).filter(x => x.rank >= 50 && (S().spoilers || !x.isMediaSpoiler)).slice(0, 8).map(x => x.name);
    return { kind: 'ani', id: 'a:' + m.id, aniId: m.id, title, alt, cover: m.coverImage?.large || null, meta, why: why || '', desc: cleanDesc(m.description).slice(0, 420),
      genres: m.genres || [], tags, chapters: m.chapters || null, status: m.status || '', score: m.averageScore || null, country: m.countryOfOrigin || '' };
  }
  const koruCard = (s, why, sub) => ({ kind: 'koru', id: 'k:' + K.key(s.provider, s.slug), provider: s.provider, slug: s.slug, title: s.title || s.slug, cover: s.cover || null,
    meta: sub || P(s.provider)?.name || s.provider, why: why || '', newCount: s.newCount || 0 });

  // ---------- your data ----------
  const stats = () => (K.statsAll?.() || K.data.stats) || {};
  function titleOf(k) {
    const d = K.data, st = stats();
    for (const x of [d.library?.[k], d.history?.[k], d.notes?.[k], d.liked?.[k], st.series?.[k]]) if (x?.title) return x.title;
    return splitKey(k).slug;
  }
  function coverOf(k) {
    const d = K.data, st = stats();
    for (const x of [d.library?.[k], d.history?.[k], d.liked?.[k], st.series?.[k], d.notes?.[k]]) if (x?.cover) return x.cover;
    return null;
  }
  const seriesOf = k => ({ ...splitKey(k), title: titleOf(k), cover: coverOf(k) });
  // every title you know (to leave out of suggestions)
  function knownKeys() {
    const d = K.data, st = stats(), keys = new Set();
    for (const store of [d.library, d.history, d.liked, d.notes, st.series, d.flags]) for (const v of Object.values(store || {})) if (v?.title) for (const t of keysOf(v)) keys.add(t);
    return keys;
  }
  const isKnownAni = (m, known) => { const t = m.title || {}; return [t.english, t.romaji, ...(m.synonyms || [])].some(x => x && known.has(norm(x))); };
  // the series you're into, with the reason Kitsu can give ("you rated X 5★")
  function seeds() {
    const st = stats(), w = new Map();
    const add = (k, v, why, rank) => { const e = w.get(k) || { k, v: 0, why: null, rank: 0 }; e.v += v; if (why && rank > e.rank) { e.why = why; e.rank = rank; } w.set(k, e); };
    for (const [k, m] of Object.entries(st.series || {})) if (m) { const hrs = (m.ms || 0) / H; add(k, Math.min(10, hrs) + Math.min(100, m.ch || 0) / 20, hrs >= 1 ? `you've spent ${fmt(m.ms)} on **${titleOf(k)}**` : `you've been reading **${titleOf(k)}**`, hrs >= 1 ? 2 : 1); }
    for (const [k, n] of Object.entries(K.data.notes || {})) if (n?.rating) add(k, (n.rating - 2.5) * 3, n.rating >= 4 ? `you rated **${titleOf(k)}** ${n.rating}★` : null, n.rating >= 4 ? 3 + n.rating : 0);
    for (const k of Object.keys(K.data.library || {})) add(k, 0.6, `**${titleOf(k)}** is in your favourites`, 1.5);
    for (const [k, h] of Object.entries(K.data.history || {})) if (h?.at) add(k, Date.now() - h.at < 14 * DAY ? 1 : 0.3, `you've been reading **${titleOf(k)}**`, 1);
    return [...w.values()].filter(e => e.v > 0.4 && visibleKey(e.k)).sort((a, b) => b.v - a.v).slice(0, 10);
  }
  // genres of a series: Explore's cache first (discover.js), then Kitsu's own, then the series page (asked once, kept 14 days)
  const kTags = () => ls.get('koru-kitsu-tags', {});
  function cachedTags(k) {
    const d = ls.get('koru-disc-tags', {})[k]?.t;
    if (d?.length) return d;
    const m = kTags()[k];
    return m && Date.now() - m.at < 14 * DAY ? m.t : null;
  }
  async function tagsFor(list, max = 6) {
    const need = list.filter(e => !cachedTags(e.k)).slice(0, max), db = kTags();
    await Promise.all(need.map(async e => {
      const { provider, slug } = splitKey(e.k);
      if (!P(provider)) return;
      try { const s = await withTimeout(K.getSeries(provider, slug), 12000); if (s?.tags?.length) db[e.k] = { t: s.tags.slice(0, 20), at: Date.now() }; } catch {}
    }));
    if (need.length) { const keys = Object.keys(db); if (keys.length > 300) keys.sort((a, b) => db[a].at - db[b].at).slice(0, keys.length - 250).forEach(k => delete db[k]); ls.set('koru-kitsu-tags', db); }
  }
  // a source tag ("Murim", "Regression") as AniList's genre or tag
  function aniNameOf(tag, tags) {
    const k = tagKey(tag);
    if (GENRE_BY_KEY[k]) return { type: 'genre', name: GENRE_BY_KEY[k] };
    if (tags.has(k)) return { type: 'tag', name: tags.get(k) };
    const c = CONCEPTS.find(x => x.src.includes(k) || tagKey(x.label) === k);
    if (c) return c.genres[0] ? { type: 'genre', name: c.genres[0] } : c.tags[0] ? { type: 'tag', name: c.tags[0] } : null;
    return null;
  }
  // what you like, weighted: Map name -> { w, type, seeds: [seed] }
  async function profile({ fetchMissing = true } = {}) {
    const sd = seeds();
    if (fetchMissing) await tagsFor(sd, 5);
    const tags = await aniTagNames();
    const prof = new Map(), raw = new Map();
    for (const e of sd) {
      const t = cachedTags(e.k) || [];
      for (const name of t) {
        const rk = tagKey(name); if (rk.length < 2 || /^(manhwa|manhua|manga|webtoons?|fullcolor|longstrip|completed|ongoing)$/.test(rk)) continue;
        const r = raw.get(rk) || { name, w: 0, n: 0 }; r.w += e.v / Math.sqrt(t.length); r.n++; raw.set(rk, r);
        const a = aniNameOf(name, tags); if (!a) continue;
        const p = prof.get(a.name) || { name: a.name, type: a.type, w: 0, seeds: [] };
        p.w += e.v / Math.sqrt(t.length); if (!p.seeds.includes(e)) p.seeds.push(e);
        prof.set(a.name, p);
      }
    }
    const me = aboutMe();
    for (const id of me.likes) { const c = CBY[id]; for (const n of [...c.genres, ...c.tags.slice(0, 1)]) { const p = prof.get(n) || { name: n, type: c.genres.includes(n) ? 'genre' : 'tag', w: 0, seeds: [] }; p.w += 3; p.likedInBio = c.label; prof.set(n, p); } }
    return { sd, prof, raw, tags, me };
  }

  // ---------- finding a series on your sources ----------
  const sources = () => { const sel = S().sources; return (K.providerList || []).filter(p => !p.hidden && (!sel || sel.includes(p.id))); };
  async function searchSources(q, { timeout = 15000, stopOnExact = null, onTick } = {}) {
    const list = sources(), found = [], X = K.libx;
    let done = 0, stop = false;
    const queue = list.slice();
    const worker = async () => {
      while (queue.length && !stop) {
        const p = queue.shift();
        try {
          const res = await withTimeout(Promise.resolve().then(() => p.list({ q, page: 1 })), timeout);
          for (const raw of (res?.items || []).slice(0, 12)) {
            const s = { ...raw, provider: raw.provider || p.id };
            if (!s.slug || !K.notTrash(s)) continue;
            s._how = stopOnExact && X ? X.likeness(stopOnExact, keysOf(s)) : 0;
            found.push(s);
            if (s._how === 2) stop = true;
          }
        } catch {}
        done++; onTick?.(done, list.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
    return found;
  }
  // group search results that are the same series on different sites
  function groupResults(items) {
    const groups = [];
    for (const s of items) {
      const ks = keysOf(s);
      let g = groups.find(x => [...ks].some(k => x.keys.has(k)));
      if (!g) { g = { keys: new Set(), items: [] }; groups.push(g); }
      ks.forEach(k => g.keys.add(k)); g.items.push(s);
    }
    return groups.map(g => ({ ...g, best: K.libx?.best ? K.libx.best(g.items) : g.items[0] }));
  }
  // "Open in Koru": your own copy first, then your sources (title, then another spelling), else Search
  async function openInKoru(card, btn) {
    if (card.kind === 'koru') { K.go(seriesRoute(card.provider, card.slug)); return; }
    const label = btn?.querySelector('span'), was = label?.textContent;
    const set = t => { if (label) label.textContent = t; };
    if (btn) btn.disabled = true;
    try {
      const keys = keysOf({ title: card.title, alt: card.alt }), X = K.libx;
      for (const store of [K.data.library, K.data.history]) for (const it of Object.values(store || {})) if (it?.slug && X && X.likeness(keys, keysOf(it)) === 2) { K.go(seriesRoute(it.provider, it.slug)); return; }
      const asked = new Set(), qs = [card.title, ...(card.alt || [])].filter(q => { const n = norm(q); if (!n || n.length < 2 || asked.has(n)) return false; asked.add(n); return true; }).slice(0, 2);
      let close = null;
      for (const q of qs) {
        set('Looking…');
        const found = await searchSources(q, { stopOnExact: keys, onTick: (d, n) => set(`Looking… ${d}/${n}`) });
        const exact = found.filter(s => s._how === 2);
        if (exact.length) { const s = X?.best ? X.best(exact) : exact[0]; K.toast(voice(line('open', { src: P(s.provider)?.name || s.provider })), 'ok'); K.go(seriesRoute(s.provider, s.slug)); return; }
        close ||= found.find(s => s._how === 1);
      }
      if (close) { K.toast('Closest match on ' + (P(close.provider)?.name || close.provider), 'info'); K.go(seriesRoute(close.provider, close.slug)); return; }
      K.toast(voice(line('openNone')), 'info');
      K.go('/search?q=' + encodeURIComponent(card.title));
    } finally { if (btn?.isConnected) { btn.disabled = false; set(was); } }
  }

  // ---------- reading the question ----------
  const STOP = new Set(('a an the and or but of to in on at for with from by is are was were be been being it its this that these those i im me my mine you your he him his she her they them their we our us one ones some any where who what which when how why whose there here then than so very just also really about like into onto over under after before again guy man boy girl woman lady dude person someone somebody story manhwa manga manhua webtoon webtoons comic comics series book books read reading find looking look search remember name called title named think maybe kind sort thing stuff gets get got becomes become became turns turned has have had do does did can could would should will want wants know new old main character mc protagonist lead fl ml first gets goes going until finally then later end ends ending all more most other another lot lots way while because himself herself themselves dont cant wont isnt same help please tell show give need any something').split(' '));
  const stem = w => w.length <= 4 ? w : w.length === 5 ? w.replace(/s$/, '') : w.replace(/(?:ings?|ed|es|ers?|ions?|s)$/, '');
  const keywords = text => [...new Set((lc(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9']+/g) || []).map(w => w.replace(/'s$|'/g, '')).filter(w => w.length >= 3 && !STOP.has(w)))];
  const ORD = { first: 0, '1st': 0, one: 0, second: 1, '2nd': 1, two: 1, third: 2, '3rd': 2, three: 2, fourth: 3, '4th': 3, four: 3, fifth: 4, '5th': 4, five: 4, last: -1 };
  function ordinal(t) {
    const m = t.match(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\b/) || t.match(/(?:#|number |no\.? ?)(\d)\b/) || t.match(/^(?:open|read|show|that|the)?\s*(\d)\s*$/);
    if (!m) return null;
    return /^\d$/.test(m[1]) ? Number(m[1]) - 1 : ORD[m[1]];
  }
  function periodOf(t) {
    const d0 = new Date(); d0.setHours(0, 0, 0, 0);
    const back = n => { const d = new Date(d0); d.setDate(d.getDate() - n); return d; };
    if (/\btoday\b/.test(t)) return { from: d0, to: d0, when: 'today', prev: { from: back(1), to: back(1) } };
    if (/\byesterday\b/.test(t)) return { from: back(1), to: back(1), when: 'yesterday' };
    if (/\blast week\b/.test(t)) return { from: back(13), to: back(7), when: 'last week' };
    if (/\b(this week|past week|7 days|week)\b/.test(t)) return { from: back(6), to: d0, when: 'this week', prev: { from: back(13), to: back(7) } };
    if (/\blast month\b/.test(t)) { const s = new Date(d0.getFullYear(), d0.getMonth() - 1, 1); return { from: s, to: new Date(s.getFullYear(), s.getMonth() + 1, 0), when: 'last month', kind: 'last' }; }
    if (/\b(this year|year|annual)\b/.test(t)) return { from: new Date(d0.getFullYear(), 0, 1), to: d0, when: 'this year', kind: 'year' };
    if (/\b(all time|ever|total|overall|so far|in total|lifetime)\b/.test(t)) return { from: new Date(2000, 0, 1), to: d0, when: 'all time' };
    const s = new Date(d0.getFullYear(), d0.getMonth(), 1);
    return { from: s, to: d0, when: 'this month', kind: 'month', prev: { from: new Date(s.getFullYear(), s.getMonth() - 1, 1), to: new Date(s.getFullYear(), s.getMonth() - 1, d0.getDate()) } };
  }
  function sumRange(from, to) {
    const days = stats().days || {}, a = K.dayKey(from), b = K.dayKey(to);
    let ms = 0, ch = 0, read = 0; const per = {};
    for (const [d, x] of Object.entries(days)) {
      if (d < a || d > b) continue;
      ms += x.ms || 0; ch += x.ch || 0; if ((x.ms || 0) >= 60000 || x.ch) read++;
      for (const [k, v] of Object.entries(x.s || {})) (per[k] ||= { ms: 0, ch: 0 }).ms += v;
      for (const [k, v] of Object.entries(x.c || {})) (per[k] ||= { ms: 0, ch: 0 }).ch += v;
    }
    return { ms, ch, read, top: Object.entries(per).filter(([k]) => visibleKey(k)).sort((x, y) => y[1].ms - x[1].ms).slice(0, 5) };
  }
  // a title you mention, matched against what you have
  function resolveOwn(q) {
    const qn = norm(q); if (qn.length < 3) return null;
    const d = K.data, st = stats(), seen = new Map();
    for (const store of [d.history, d.library, d.notes, st.series, d.liked]) for (const [k, v] of Object.entries(store || {})) if (v && !seen.has(k) && visibleKey(k)) seen.set(k, v.title || titleOf(k));
    let best = null, bs = 0;
    for (const [k, title] of seen) {
      const tn = norm(title); if (!tn) continue;
      let s = tn === qn ? 100 : tn.startsWith(qn) ? 80 : tn.includes(qn) ? 60 : qn.includes(tn) && tn.length >= 5 ? 50 : 0;
      if (!s) { const qw = keywords(q), tw = new Set(keywords(title)); const hit = qw.filter(w => tw.has(w)).length; if (hit && hit >= Math.ceil(qw.length * 0.6)) s = 30 + hit * 5; }
      if (!s && qn.length >= 6 && Math.abs(tn.length - qn.length) <= 2 && dl(qn, tn) <= 2) s = 45;
      if (s > bs) { bs = s; best = k; }
    }
    return best ? seriesOf(best) : null;
  }

  // ---------- answers: your data ----------
  function ansReading(r) {
    const hist = Object.values(K.data.history || {}).filter(h => h?.provider && h.slug && visible(h)).sort((a, b) => (b.at || 0) - (a.at || 0));
    if (!hist.length) return r.say('empty').chip('What should I read next?');
    const top = hist.slice(0, 8), recent = hist.filter(h => Date.now() - (h.at || 0) < 30 * DAY).length;
    const names = top.slice(0, 3).map(h => `**${h.title || h.slug}**`);
    r.add(`Lately you've been reading ${names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0]}.`);
    r.detail(`You've opened ${plural(recent, 'series', 'series')} in the last 30 days.`);
    for (const h of top) r.card({ ...koruCard(h, '', (h.chapterName || 'Started') + ' · ' + K.ago(h.at)), go: readRoute(h), goLabel: 'Continue' });
    r.chip('What did I stop reading?', 'My stats this month', 'What should I read next?');
  }
  function ansStopped(r) {
    const st = stats(), now = Date.now();
    const list = Object.entries(K.data.history || {}).filter(([k, h]) => h?.at && now - h.at > 21 * DAY && !K.flag(h.provider, h.slug).completed && visible(h))
      .map(([k, h]) => ({ k, h, ms: st.series?.[k]?.ms || 0 })).sort((a, b) => b.ms - a.ms || (b.h.at - a.h.at)).slice(0, 8);
    if (!list.length) return r.add('You haven\'t dropped anything: everything in your history was opened in the last 3 weeks.').chip('What have I been reading?');
    const f = list[0], weeks = Math.round((now - f.h.at) / (7 * DAY));
    r.add(`You haven't opened **${f.h.title || f.h.slug}** in ${plural(weeks, 'week')}${f.h.chapterName ? ` (you were on ${f.h.chapterName})` : ''}.`);
    if (list.length > 1) r.add(`${plural(list.length - 1, 'other')} ${list.length === 2 ? 'is' : 'are'} waiting too.`);
    for (const { h, ms } of list) r.card({ ...koruCard(h, '', (h.chapterName || '') + ' · last read ' + K.ago(h.at) + (ms >= 60000 ? ' · ' + fmt(ms) + ' read' : '')), go: readRoute(h), goLabel: 'Pick it up' });
    r.chip('What\'s new in my favourites?', 'Recommend something new');
  }
  function ansNew(r) {
    const lib = Object.values(K.data.library || {}).filter(it => it?.slug && visible(it));
    if (!lib.length) return r.add('You have no favourites yet. Press the heart on a series and I\'ll keep an eye on it.').chip('What should I read next?');
    const fresh = lib.filter(it => it.newCount > 0).sort((a, b) => (b.lastNew || b.checkedAt || 0) - (a.lastNew || a.checkedAt || 0));
    const checked = Math.max(...lib.map(it => it.checkedAt || 0));
    if (!fresh.length) {
      r.add(`Nothing new in your ${plural(lib.length, 'favourite')} right now.`);
      if (checked) r.detail(`Last checked ${K.ago(checked)}.`);
      return r.act({ label: 'Check now', ic: 'refresh', run: 'checkUpdates' }).chip('What did I stop reading?');
    }
    const total = fresh.reduce((a, it) => a + it.newCount, 0);
    r.add(`${plural(fresh.length, 'favourite')} ${fresh.length === 1 ? 'has' : 'have'} new chapters, ${total} in all. **${fresh[0].title}** has ${plural(fresh[0].newCount, 'new one')}.`);
    if (checked) r.detail(`Checked ${K.ago(checked)}.`);
    for (const it of fresh) r.card({ ...koruCard(it, '', plural(it.newCount, 'new chapter')), newCount: it.newCount });
    r.act({ label: 'Check again', ic: 'refresh', run: 'checkUpdates' });
  }
  function ansStats(r, t) {
    const p = periodOf(t), s = sumRange(p.from, p.to);
    if (!s.ms && !s.ch) { r.add(`No reading ${p.when === 'all time' ? 'yet' : p.when} yet.`).chip('What should I read next?'); return; }
    r.say('stats', { when: p.when });
    r.add(`**${plural(s.ch, 'chapter')}** and **${fmt(s.ms)}** of reading${/day$/.test(p.when) ? '' : ` over ${plural(s.read, 'day')}`}.`);
    if (p.prev) { const b = sumRange(p.prev.from, p.prev.to); if (b.ms > 60000) { const d = Math.round((s.ms - b.ms) / b.ms * 100); r.detail(d >= 0 ? `That's ${d}% more than the same stretch before.` : `That's ${-d}% less than the same stretch before.`); } }
    if (s.top.length) r.add(`Most time went to **${titleOf(s.top[0][0])}** (${fmt(s.top[0][1].ms)}).`);
    for (const [k, x] of s.top) r.card(koruCard(seriesOf(k), '', fmt(x.ms) + (x.ch ? ' · ' + plural(x.ch, 'chapter') : '')));
    r.act({ label: 'Open Stats', ic: 'chart', route: '/stats' });
    if (p.kind && K.views.wrapped) r.act({ label: 'Your Wrapped', ic: 'sparkle', route: '/wrapped' });
    r.chip('What\'s my streak?', p.when === 'this month' ? 'How about this year?' : 'And this month?', 'My top genres');
  }
  function ansStreak(r) {
    const s = K.lively?.streak?.();
    if (!s) return r.add('Streaks aren\'t switched on in this Koru.');
    const best = K.lively.bestStreak?.(stats().days || {}) || 0;
    if (!s.n) r.add(s.paused ? 'Your streak is paused, so skipped days won\'t break it.' : 'No streak right now. Read for a minute today to start one!');
    else r.add(`You're on a **${s.n}-day** streak 🔥${s.today ? ' and today already counts.' : '. Read a minute today to keep it going.'}`);
    if (best > s.n) r.detail(`Your best so far is ${plural(best, 'day')}.`);
    if (s.paused) r.detail('It\'s paused right now.');
    if (s.canRestore) { r.add(`You can restore it with ${plural(s.missed.length, 'restore')} (${s.left} left this month).`); r.act({ label: 'Restore streak', ic: 'refresh', run: 'restoreStreak' }); }
    r.chip('How many chapters this week?', 'What should I read next?');
  }
  async function ansGenres(r, say) {
    say('Looking at what you read…');
    const { prof, raw } = await profile();
    const top = [...raw.values()].sort((a, b) => b.w - a.w).slice(0, 8);
    if (!top.length) return r.add('I don\'t know your taste yet. Rate a few series or read for a bit and ask again.').chip('Recommend something popular');
    r.add(`Your top genres are ${top.slice(0, 3).map(x => `**${x.name}**`).join(', ')}.`);
    if (top.length > 3) r.detail(`Then ${top.slice(3, 7).map(x => x.name).join(', ')}.`);
    const why = [...prof.values()].sort((a, b) => b.w - a.w)[0]?.seeds?.[0];
    if (why?.why) r.detail(`Mostly because ${why.why}.`);
    r.chip(...top.slice(0, 3).map(x => `Recommend some ${x.name.toLowerCase()}`));
  }
  function ansRatings(r, t) {
    const notes = Object.entries(K.data.notes || {}).filter(([k, n]) => n?.rating && visibleKey(k));
    if (!notes.length) return r.add('You haven\'t rated anything yet. Use the stars on a series page and I\'ll learn what you like.');
    const avg = notes.reduce((a, [, n]) => a + n.rating, 0) / notes.length;
    const low = /\b(worst|lowest|hate|bad)\b/.test(t);
    const sorted = notes.sort((a, b) => low ? a[1].rating - b[1].rating : b[1].rating - a[1].rating);
    r.add(`You've rated ${plural(notes.length, 'series', 'series')}, ${avg.toFixed(1)}★ on average. ${low ? 'Lowest' : 'Top'}: **${titleOf(sorted[0][0])}** (${sorted[0][1].rating}★).`);
    for (const [k, n] of sorted.slice(0, 8)) r.card(koruCard(seriesOf(k), '', '★'.repeat(n.rating) + (n.note ? ' · ' + n.note.slice(0, 40) : '')));
    r.chip('More like my top rated', 'What should I read next?');
  }
  function ansShelves(r, t) {
    const names = K.libx?.shelfNames?.() || Object.keys(K.data.shelves || {});
    if (!names.length) return r.add('You don\'t have any shelves yet. Make one from the shelf button on a series page.');
    const count = n => Object.entries(K.data.notes || {}).filter(([k, x]) => x?.shelves?.includes(n) && visibleKey(k)).length;
    const asked = names.find(n => lc(t).includes(lc(n)));
    if (asked) {
      const items = Object.entries(K.data.notes || {}).filter(([k, x]) => x?.shelves?.includes(asked) && visibleKey(k));
      r.add(`**${asked}** has ${plural(items.length, 'series', 'series')}.`);
      for (const [k] of items) r.card(koruCard(seriesOf(k)));
      return;
    }
    r.add(`You have ${plural(names.length, 'shelf', 'shelves')}: ${names.map(n => `**${n}** (${count(n)})`).join(', ')}.`);
    r.chip(...names.slice(0, 3).map(n => `What's on my ${n} shelf?`));
  }
  function ansNotes(r) {
    const notes = Object.entries(K.data.notes || {}).filter(([k, n]) => n?.note && visibleKey(k));
    if (!notes.length) return r.add('No notes yet. You can write one on any series page.');
    r.add(`You've written notes on ${plural(notes.length, 'series', 'series')}.`);
    for (const [k, n] of notes.slice(0, 8)) r.card(koruCard(seriesOf(k), '“' + n.note.slice(0, 120) + '”'));
  }
  function ansLibrary(r) {
    const d = K.data, lib = Object.keys(d.library || {}).filter(visibleKey).length, done = Object.values(d.flags || {}).filter(f => f?.completed).length;
    const chs = Object.values(d.read || {}).reduce((a, x) => a + Object.keys(x || {}).length, 0), all = sumRange(new Date(2000, 0, 1), new Date());
    r.add(`You have **${plural(lib, 'favourite')}** and ${plural(Object.keys(d.history || {}).filter(visibleKey).length, 'series', 'series')} in your history${done ? `, and ${plural(done, 'completed series', 'completed series')}` : ''}.`);
    r.add(`You've marked ${plural(chs, 'chapter')} read${all.ms ? ` and spent ${fmt(all.ms)} reading in Koru` : ''}.`);
    const badges = Object.keys(stats().badges || {}).length;
    if (badges) r.detail(`You've earned ${plural(badges, 'badge')}.`);
    r.act({ label: 'Open Library', ic: 'library', route: '/library' }).chip('My stats this month', 'My top genres');
  }
  function ansWrapped(r) {
    const c = K.lively2?.crunch?.('month');
    const s = c || (() => { const p = periodOf('month'), x = sumRange(p.from, p.to); return { total: x.ms, chapters: x.ch, daysRead: x.read, seriesList: x.top.map(([k, v]) => ({ title: titleOf(k), ms: v.ms })) }; })();
    if (!s.total && !s.chapters) return r.add('Your Wrapped for this month is still empty. Read a little and it fills in.');
    r.add(`This month so far: **${fmt(s.total)}**, ${plural(s.chapters, 'chapter')} over ${plural(s.daysRead, 'day')}.`);
    if (s.seriesList?.[0]) r.add(`Your number one is **${s.seriesList[0].title}**.`);
    if (c?.best?.n > 1) r.detail(`Best streak this month: ${plural(c.best.n, 'day')}.`);
    r.act({ label: 'Open your Wrapped', ic: 'sparkle', route: '/wrapped' });
  }
  function ansWhereWas(r, q, s0) {
    const s = s0 || resolveOwn(q);
    if (!s) return false;
    const k = K.key(s.provider, s.slug), h = K.data.history?.[k], n = K.data.notes?.[k], st = stats().series?.[k];
    if (h) r.add(`In **${h.title}** you're on **${h.chapterName || 'a chapter'}**${h.total ? `, page ${(h.page || 0) + 1} of ${h.total}` : ''}. Last read ${K.ago(h.at)}.`);
    else r.add(`You haven't started **${s.title}** yet.`);
    if (n?.rating) r.detail(`You rated it ${n.rating}★.`);
    if (st?.ms) r.detail(`You've spent ${fmt(st.ms)} on it.`);
    r.card({ ...koruCard(h || s, '', h ? (h.chapterName || '') + ' · ' + K.ago(h.at) : ''), go: h ? readRoute(h) : null, goLabel: h ? 'Continue' : null });
    r.chip(`More like ${s.title}`);
    return true;
  }

  // ---------- answers: suggestions ----------
  const avoidSet = extra => { const a = new Set([...aboutMe().avoid, ...(extra || [])]); return a; };
  const avoidHit = (m, avoid) => {
    for (const id of avoid) { const c = CBY[id]; if (!c) continue;
      if (c.genres.some(g => m.genres?.includes(g))) return c.label;
      if (c.tags.some(t => (m.tags || []).some(x => x.name === t && x.rank >= 50))) return c.label; }
    return null;
  };
  const koruAvoidHit = (s, avoid) => { const t = (cachedTags(K.key(s.provider, s.slug)) || []).map(tagKey); for (const id of avoid) { const c = CBY[id]; if (c && (c.src.some(x => t.includes(x)) || c.genres.some(g => t.includes(tagKey(g))))) return c.label; } return null; };
  const filterArgs = f => [f.country ? `countryOfOrigin:${gq(f.country)}` : '', f.done ? 'status:FINISHED' : f.ongoing ? 'status:RELEASING' : '', f.short ? 'chapters_lesser:90' : '', f.long ? 'chapters_greater:150' : ''].filter(Boolean).join(',');
  function readFilters(t, base = {}) {
    const f = { ...base };
    if (/\bmanhwa|korean|webtoon\b/.test(t)) f.country = 'KR'; else if (/\bmanhua|chinese\b/.test(t)) f.country = 'CN'; else if (/\bmanga\b|japanese/.test(t)) f.country = 'JP';
    if (/\b(any country|anything|any kind)\b/.test(t)) f.country = null;
    if (/\b(complete[d]?|finished|ended|done)\b/.test(t)) { f.done = true; f.ongoing = false; }
    if (/\b(ongoing|still (?:going|releasing)|releasing)\b/.test(t)) { f.ongoing = true; f.done = false; }
    if (/\b(short(?:er)?|quick(?:er)? read|few(?:er)? chapters|not too long|binge in a day)\b/.test(t)) { f.short = true; f.long = false; }
    if (/\b(long(?:er)?|lots of chapters|hundreds of chapters|long runner)\b/.test(t)) { f.long = true; f.short = false; }
    return f;
  }
  const filterWords = f => [f.short && 'short', f.long && 'long', f.done && 'completed', f.ongoing && 'ongoing', f.country && COUNTRY[f.country]?.toLowerCase()].filter(Boolean).join(' ');
  // the best seed behind a pick: the series of yours sharing the most of its genres
  function whyFor(m, prof, ask) {
    const names = new Set([...(m.genres || []), ...(m.tags || []).filter(t => t.rank >= 50 && (S().spoilers || !t.isMediaSpoiler)).map(t => t.name)]);
    const shared = [...prof.values()].filter(p => names.has(p.name)).sort((a, b) => b.w - a.w);
    const askHit = (ask || []).filter(c => c.genres.some(g => names.has(g)) || c.tags.some(t => names.has(t)));
    const bySeed = new Map();
    for (const p of shared) for (const s of p.seeds) bySeed.set(s, (bySeed.get(s) || 0) + (p.type === 'tag' ? 2 : 1));
    const jitter = x => (hash(String(m.id) + x.k) % 100) / 400;
    const seed = [...bySeed.entries()].sort((a, b) => (b[1] + (b[0].rank || 1) * 0.3 + jitter(b[0])) - (a[1] + (a[0].rank || 1) * 0.3 + jitter(a[0])))[0]?.[0];
    const likes = [...shared.filter(p => p.type === 'tag'), ...shared.filter(p => p.type !== 'tag')].slice(0, 2).map(p => lc(p.likedInBio || p.name));
    if (askHit.length) return `You asked for ${askHit.map(c => c.label).slice(0, 2).join(' and ')}${seed?.why ? `, and ${seed.why}` : ''}${likes.length ? ` · ${likes.join(', ')}` : ''}`;
    if (seed?.why) return `Because ${seed.why} and like ${likes.join(' and ') || 'this kind of story'}`;
    if (shared[0]?.likedInBio) return `You said you like ${shared[0].likedInBio}`;
    if (likes.length) return `You read a lot of ${likes.join(' and ')}`;
    return m.averageScore ? `Rated ${m.averageScore}% on AniList` : '';
  }
  function rankPicks(list, prof, ask, f) {
    const seen = new Set(), out = [];
    for (const m of list) {
      if (!m || seen.has(m.id)) continue; seen.add(m.id);
      let s = 0;
      for (const g of m.genres || []) s += (prof.get(g)?.w || 0) * 0.6;
      for (const t of m.tags || []) if (t.rank >= 40) s += (prof.get(t.name)?.w || 0) * t.rank / 100;
      s /= Math.sqrt((m.genres?.length || 1) + (m.tags?.length || 0) / 3);
      for (const c of ask || []) { if (c.genres.some(g => m.genres?.includes(g))) s += 3; if (c.tags.some(t => (m.tags || []).some(x => x.name === t && x.rank >= 40))) s += 3.5; }
      s += (m.averageScore || 60) / 100 + Math.log10((m.popularity || 0) + 10) * 0.12;
      if (f.country !== null && m.countryOfOrigin === 'KR') s += 0.3;
      out.push({ m, s });
    }
    return out.sort((a, b) => b.s - a.s).map(x => x.m);
  }
  async function recommend(r, ctx, t, say, opts = {}) {
    const ask = opts.ask || conceptsIn(t).filter(c => !negated(t).has(c.id));
    const f = readFilters(t, opts.filters || { country: 'KR' });
    const avoid = avoidSet(negated(t));
    for (const c of ask) avoid.delete(c.id);
    say('Thinking about what you like…');
    const { prof, sd, tags } = await profile();
    const again = /\b(?:again|same ones|those ones again|show (?:me )?(?:them|those) again)\b/.test(t);
    const excluded = new Set([...(ctx.excluded || []), ...(again ? [] : ctx.seen || [])]);
    const known = knownKeys();
    let picks = [], offline = false;
    if (aniOK()) {
      say('Asking AniList…');
      const fa = filterArgs(f), base = (fa ? fa + ',' : '') + 'sort:POPULARITY_DESC,averageScore_greater:58';
      const parts = {};
      const askG = ask.flatMap(c => c.genres), askT = ask.flatMap(c => c.tags.slice(0, 1)).filter(n => tags.has(tagKey(n)) || CONCEPTS.some(c => c.tags.includes(n)));
      if (askG.length) parts.ag = { args: `${base},genre_in:${gq(askG.slice(0, 2))}`, n: 30 };
      askT.slice(0, 3).forEach((n, i) => { parts['at' + i] = { args: `${base},tag_in:${gq([n])},minimumTagRank:55${askG.length ? `,genre_in:${gq(askG.slice(0, 1))}` : ''}`, n: 30 }; });
      if (!ask.length) {
        const top = [...prof.values()].filter(p => !avoid.size || ![...avoid].some(id => CBY[id].genres.includes(p.name) || CBY[id].tags.includes(p.name))).sort((a, b) => b.w - a.w);
        const g = top.filter(p => p.type === 'genre').slice(0, 2), tg = top.filter(p => p.type === 'tag').slice(0, 3);
        if (g[0] && tg[0]) parts.p0 = { args: `${base},genre_in:${gq([g[0].name])},tag_in:${gq([tg[0].name])},minimumTagRank:50`, n: 30 };
        tg.slice(0, 3).forEach((p, i) => { parts['pt' + i] = { args: `${base},tag_in:${gq([p.name])},minimumTagRank:55`, n: 25 }; });
        if (g.length) parts.pg = { args: `${base},genre_in:${gq(g.map(x => x.name))}`, n: 30 };
        if (!Object.keys(parts).length) parts.pop = { args: `${filterArgs({ ...f, country: f.country ?? null }) ? filterArgs(f) + ',' : ''}sort:TRENDING_DESC`, n: 30 };
      }
      try {
        const res = await aniPages(parts);
        const all = Object.values(res).flat().filter(m => !isKnownAni(m, known) && !excluded.has('a:' + m.id) && !avoidHit(m, avoid));
        picks = tasteRank(rankPicks(all, prof, ask, f).map(m => aniCard(m, whyFor(m, prof, ask))));
      } catch { offline = true; }
    }
    // Explore's own "More like this" picks (already on your sources), when they're saved
    const dr = ls.get('koru-disc-recs', null);
    if (!ask.length && dr?.items?.length && Date.now() - dr.at < 3 * DAY) {
      const extra = dr.items.filter(s => !excluded.has('k:' + K.key(s.provider, s.slug)) && !koruAvoidHit(s, avoid)).slice(0, 6)
        .map(s => koruCard(s, s.why?.length ? `Because you like ${s.why.slice(0, 2).join(' and ').toLowerCase()}${dr.because?.[0] ? ` (from reading **${dr.because[0]}**)` : ''}` : '', P(s.provider)?.name));
      picks = picks.length ? [picks[0], extra[0], ...picks.slice(1, 4), ...extra.slice(1, 3), ...picks.slice(4), ...extra.slice(3)].filter(Boolean) : extra;
    }
    if (!again) picks = picks.filter(c => !seenHas(ctx, c));
    if (opts.surprise) picks = picks.slice(0, 40).map(c => [Math.random(), c]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
    if (!picks.length) {
      if (offline) r.say('offline');
      return r.say('none').chip('My top genres', 'Recommend something popular');
    }
    const uf = readFilters(t, {});
    const pre = [uf.short && 'short', uf.long && 'long', uf.done && 'completed', uf.ongoing && 'ongoing'].filter(Boolean).join(' '), noun = uf.country ? COUNTRY[uf.country].toLowerCase() : '';
    const fw = pre || noun;
    const what = [pre, ask.map(c => c.label).slice(0, 2).join(' and '), noun].filter(Boolean).join(' ') + (ask.length || noun || !pre ? '' : ' ones');
    if (opts.surprise) r.add(pick(['Okay, a wildcard round.', 'Something a bit different, then.', 'Rolling the dice for you.'], r.seed + (ctx.seen || []).length));
    else r.say(opts.intro || (ask.length || fw ? 'recsAsk' : 'recs'), { what: what || 'picks' });
    // a small library: say so, instead of passing crowd favourites off as tailored picks
    if (!ask.length && sd.length < 3) r.add(sd.length ? 'I don\'t know your taste well yet, so these lean on what readers love overall. Tell me one you loved and I\'ll tailor it.' : 'I don\'t know your taste yet, so these are crowd favourites. Tell me one you loved and I\'ll tailor it.');
    if (offline) r.detail('AniList didn\'t answer, so these come from your sources only.');
    if (!ask.length && sd[0]?.why) r.detail(`Mostly based on how ${sd[0].why.replace(/^you('ve| have)? /, 'you\'ve ').replace(/^you rated/, 'you rated')}.`);
    if (avoid.size) r.detail(`Leaving out ${[...avoid].map(id => CBY[id]?.label).filter(Boolean).join(', ')}.`);
    ctx.last = { kind: 'recs', pool: picks.slice(0, 40), shown: picks.slice(0, cardCount()).map(c => c.id), t, f, ask: ask.map(c => c.id) };
    picks.slice(0, cardCount()).forEach(c => r.card(c));
    r.chip('Not those, something else', f.short ? 'Something longer' : 'Something shorter', f.done ? null : 'Only completed ones', picks[0] ? `More like ${picks[0].title}` : null);
  }
  // "more like X": AniList's own reader recommendations for X, plus its genres
  async function moreLike(r, ctx, target, say, but = '', filters = null) {
    let media = null; const title = target?.title || String(target || '');
    if (!aniOK()) { r.add('I need AniList for that, and it\'s switched off in my settings.'); return; }
    const f = filters || readFilters(lc(but || ''), {}), butC = conceptsIn(but || '');
    say(`Looking up ${title}…`);
    let aid = target?.aniId;
    if (!aid) {
      try {
        const hits = (await ani(`query{p:Page(perPage:6){media(type:MANGA,search:${gq(title)},sort:SEARCH_MATCH){id popularity title{english romaji} synonyms}}}`))?.p?.media || [];
        const n = norm(title), exact = hits.find(m => [m.title?.english, m.title?.romaji, ...(m.synonyms || [])].some(x => x && norm(x) === n));
        aid = (exact || hits.slice(0, 3).sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0])?.id;
      } catch {}
    }
    const q = `fragment F on Media{${ANI_FIELDS}} query{m:Media(type:MANGA,${aid ? 'id:' + aid : 'search:' + gq(title)}){${ANI_FIELDS} recommendations(perPage:25,sort:RATING_DESC){nodes{rating mediaRecommendation{...F}}}}}`;
    try { media = (await ani(q))?.m; } catch {}
    if (!media) { r.add(`I couldn't find **${title}** on AniList. Try the exact title?`); r.chip(`Find ${title}`); return; }
    const known = knownKeys(), avoid = avoidSet(negated(but)), excluded = new Set(ctx.excluded || []);
    const hasC = (m, c) => c.genres.some(g => m.genres?.includes(g)) || c.tags.some(t => (m.tags || []).some(x => x.name === t && x.rank >= 40));
    const fits = m => (!f.short || (m.chapters && m.chapters <= 90)) && (!f.long || (m.chapters || 0) >= 150) && (!f.done || m.status === 'FINISHED') && (!f.ongoing || m.status === 'RELEASING')
      && (!butC.length || butC.some(c => hasC(m, c)));
    const ok = m => m && m.id !== media.id && !m.isAdult && !isKnownAni(m, known) && !excluded.has('a:' + m.id) && !avoidHit(m, avoid) && fits(m);
    const name = media.title.english || media.title.romaji;
    const shared = m => (m.genres || []).filter(g => media.genres.includes(g)).concat((m.tags || []).filter(t => t.rank >= 50 && !t.isMediaSpoiler && media.tags.some(x => x.name === t.name)).map(t => t.name)).slice(0, 2).map(lc);
    const butWhy = m => butC.filter(c => hasC(m, c)).map(c => c.label)[0];
    let picks = (media.recommendations?.nodes || []).filter(n => n.rating > 0 && ok(n.mediaRecommendation)).map(n => {
      const m = n.mediaRecommendation, bw = butWhy(m), sh = shared(m);
      return aniCard(m, `${n.rating} AniList readers of **${name}** recommend it${bw ? ', and it has ' + bw : sh.length ? ' · ' + sh.join(', ') : ''}`);
    });
    if (picks.length < 4) {
      say('Finding more with the same feel…');
      const tg = (media.tags || []).filter(t => t.rank >= 60 && !t.isMediaSpoiler).slice(0, 2).map(t => t.name);
      const fa = filterArgs({ ...f, country: media.countryOfOrigin || null });
      const parts = { g: { args: `sort:POPULARITY_DESC,genre_in:${gq(media.genres.slice(0, butC.length ? 1 : 2))}${tg[0] && !butC.length ? `,tag_in:${gq([tg[0]])}` : ''}${fa ? ',' + fa : ''}`, n: 30 } };
      butC.slice(0, 2).forEach((c, i) => {
        const gs = [...new Set([c.genres[0], media.genres[0]].filter(Boolean))], t2 = c.tags[0];
        parts['b' + i] = { args: `sort:POPULARITY_DESC,genre_in:${gq(gs)}${t2 ? ',tag_in:' + gq([t2]) + ',minimumTagRank:50' : ''}${fa ? ',' + fa : ''}`, n: 30 };
      });
      try {
        const res = await aniPages(parts), seen = new Set(picks.map(p => p.aniId));
        for (const m of Object.values(res).flat()) {
          if (!ok(m) || seen.has(m.id)) continue; seen.add(m.id);
          const bw = butWhy(m);
          picks.push(aniCard(m, bw ? `Like **${name}** (${media.genres.slice(0, 2).join(', ').toLowerCase()}) but with ${bw}` : `Same mix as **${name}**: ${shared(m).join(', ') || media.genres.slice(0, 2).join(', ').toLowerCase()}`));
        }
      } catch {}
    }
    picks = tasteRank(picks);
    if (!picks.length) { r.add(`I couldn't find anything new like **${name}** that you haven't read${butC.length ? ' with ' + butC.map(c => c.label).join(' and ') : ''}.`); return; }
    r.say('like', { title: name });
    if (butC.length) r.add(`With ${butC.map(c => c.label).join(' and ')}, like you asked.`);
    if (filterWords(f)) r.detail(`Only ${filterWords(f)} ones.`);
    ctx.last = { kind: 'recs', pool: picks.slice(0, 40), shown: picks.slice(0, cardCount()).map(c => c.id), t: 'like ' + name, f, like: { title: name, aniId: media.id } };
    ctx.focus = picks[0];
    picks.slice(0, cardCount()).forEach(c => r.card(c));
    r.chip('Not those, something else', f.short ? 'Only completed ones' : 'Something shorter', picks[0] ? `Tell me more about ${picks[0].title}` : null);
  }
  // KitsuNet's taste model (when it's there) re-ranks picks by how likely you are to finish and enjoy each one
  let netProf = null, netAt = 0;
  const netProfile = () => { if (!netProf || Date.now() - netAt > 60e3) { netProf = K.kitsuNet.profileFrom(K.data, { includePrivate: !!S().seePrivate }); netAt = Date.now(); } return netProf; };
  function tasteRank(cards) {
    const N = K.kitsuNet;
    if (!netOK || !N?.tasteMany || !cards.length) return cards;
    try {
      const prof = netProfile();
      const sers = cards.map(c => ({ title: c.title, genres: c.genres || [], tags: c.tags || [], chapters: c.chapters, status: c.status, score: c.score, country: c.country, provider: c.provider, slug: c.slug, kind: c.kind }));
      const sc = N.tasteMany(prof, sers) || [];
      const out = cards.map((c, i) => ({ c, i, s: (Number(sc[i]) || 0) * 0.6 + (1 - i / cards.length) * 0.4 })).sort((a, b) => b.s - a.s);
      return out.map(({ c, i }) => {
        let why = c.why;
        try {
          const w = (N.why?.(prof, sers[i]) || []).filter(Boolean);
          const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
          if (w.length) {
            const mine = w.find(x => /^you\b/i.test(x)), other = w.find(x => !/^you\b/i.test(x));
            if (mine && !/readers of|asked for/.test(c.why || '')) why = 'Because ' + mine + (c.why ? ' · ' + c.why.replace(/^Because /, '') : '');
            else if (c.why && other) why = c.why + ' · ' + other;
            else if (!c.why) why = cap(w.slice(0, 2).join(' · '));
          }
        } catch {}
        return { ...c, why, taste: Math.round((Number(sc[i]) || 0) * 100) };
      });
    } catch { return cards; }
  }
  function nextBatch(r, ctx, key) {
    const L = ctx.last; if (!L?.pool?.length) return false;
    const excluded = new Set([...(ctx.excluded || []), ...(L.shown || [])]);
    const rest = L.pool.filter(c => !excluded.has(c.id) && !seenHas(ctx, c));
    if (!rest.length) return false;
    r.say(key);
    const n = cardCount();
    rest.slice(0, n).forEach(c => r.card(c));
    L.shown = [...(L.shown || []), ...rest.slice(0, n).map(c => c.id)];
    r.chip('More like the first one', 'Something shorter', 'Only completed ones');
    return true;
  }

  // ---------- answers: finding a series from a description or a half-remembered title ----------
  async function find(r, ctx, text, say, forceTitle = false, weak = false) {
    const q = String(text).replace(/^(?:hey|hi|kitsu|please|can you|could you|help me|i'?m|i am|i was)[, ]*/gi, '')
      .replace(/^(?:find|search(?: for)?|look(?:ing)? for|look up|trying to (?:find|remember)|what'?s|what is|whats|do you (?:know|have)|remember|i forgot|pull up|where can i read)\s+(?:me\s+)?(?:the\s+)?(?:name\s+of\s+)?(?:the\s+|a\s+|that\s+)?(?:manhwa|manga|manhua|webtoon|series|comic|one|title)?\s*(?:called|named|titled)?\s*/i, '')
      .replace(/\s+(?:on koru|please|pls)\??$/i, '').trim();
    const ask = conceptsIn(q), kws = keywords(q), avoid = avoidSet(negated(q));
    const titleLike = (forceTitle && kws.length <= 8) || !ask.length && kws.length && kws.length <= 6 && !/\b(where|about|who|which|that|with)\b/.test(lc(q));
    const f = readFilters(lc(q), {});
    const tags = await aniTagNames();
    const own = titleLike ? resolveOwn(q) : null;
    // what to look for: each trope and each telling word is a "facet"; the best match covers the most of them
    const conceptWords = new Set(ask.flatMap(c => [c.id, ...c.words.map(w => w.split(' ')[0])]));
    const loose = kws.filter(w => !ask.some(c => c.re.test(w)) && !conceptWords.has(w)).map(stem).filter(s => s.length >= 3);
    const facets = [...ask.map(c => ({ c })), ...loose.map(st => ({ st }))];
    let cards = [], offline = false, top = null;
    if (aniOK()) {
      say('Searching AniList…');
      const parts = {}, kr = f.country !== undefined ? (f.country ? `,countryOfOrigin:${gq(f.country)}` : '') : ',countryOfOrigin:"KR"';
      const conceptTags = [...new Set(ask.flatMap(c => c.tags.slice(0, 1)))].filter(n => tags.has(tagKey(n)) || CONCEPTS.some(c => c.tags.includes(n))).slice(0, 3);
      const conceptGenres = [...new Set(ask.flatMap(c => c.genres))].slice(0, 2);
      conceptTags.forEach((n, i) => { parts['t' + i] = { args: `sort:POPULARITY_DESC,tag_in:${gq([n])},minimumTagRank:45${kr}`, n: 40 }; });
      if (conceptGenres.length) parts.g = { args: `sort:POPULARITY_DESC,genre_in:${gq(conceptGenres)}${kr}`, n: 30 };
      // title searches with the most telling words the user typed (AniList searches titles, not stories)
      const telling = kws.filter(w => w.length >= 5).sort((a, b) => b.length - a.length).slice(0, 2);
      telling.forEach((w, i) => { parts['k' + i] = { args: `sort:SEARCH_MATCH,search:${gq(w)}`, n: 15 }; });
      if (titleLike || q.split(/\s+/).length <= 8) parts.s = { args: `sort:SEARCH_MATCH,search:${gq(q.slice(0, 80))}`, n: 10 };
      // a plain story with no tropes: the most popular ones, matched on their descriptions
      if (!titleLike && !conceptTags.length && !conceptGenres.length) parts.p = { args: `sort:POPULARITY_DESC${kr}`, n: 50 };
      try {
        const res = await aniPages(parts);
        const scored = new Map();
        for (const [alias, list] of Object.entries(res)) list.forEach((m, i) => {
          if (avoidHit(m, avoid)) return;
          const t = m.title || {}, titleText = lc([t.english, t.romaji, ...(m.synonyms || [])].join(' | ')), desc = lc(cleanDesc(m.description, true));
          let s = 0, covered = 0; const hits = [];
          for (const fc of facets) {
            let best = 0, why = '';
            if (fc.c) {
              const c = fc.c, tag = (m.tags || []).find(x => c.tags.includes(x.name) && x.rank >= 35), gen = c.genres.find(g => m.genres?.includes(g));
              const inTitle = c.re.test(titleText) || c.words.some(w => w.length >= 4 && titleText.includes(w)), inDesc = c.re.test(desc) || c.words.some(w => w.length >= 4 && desc.includes(w));
              best = Math.max(inTitle ? 2.6 : 0, inDesc ? 1.8 : 0, tag ? 1.2 + tag.rank / 100 : 0, gen ? 0.9 : 0);
              why = c.label;
            } else {
              const inTitle = titleText.includes(fc.st), inDesc = desc.includes(fc.st);
              best = inTitle ? 2.6 : inDesc ? 1.6 : 0;
              why = `"${fc.st}" in the ${inTitle ? 'title' : 'story'}`;
            }
            if (best) { s += best; covered++; hits.push(why); }
          }
          if (covered > 1) s += 2.4 * (covered - 1);   // several of the details at once beats one detail many times
          if (alias === 's') s += titleLike ? (i === 0 ? 4 : Math.max(0, 2.5 - i * 0.4)) : (i === 0 ? 1 : 0);
          if (f.country) s += m.countryOfOrigin === f.country ? 1.2 : -1.5; else if (m.countryOfOrigin === 'KR') s += 0.35;
          s += Math.log10((m.popularity || 0) + 10) * 0.15;
          const prev = scored.get(m.id);
          if (!prev || prev.s < s) scored.set(m.id, { m, s, covered, hits: [...new Set(hits)] });
        });
        const need = titleLike ? 0 : Math.min(2, facets.length);
        const ranked = [...scored.values()].sort((a, b) => b.s - a.s).filter(x => titleLike || x.covered >= Math.max(1, need - 1)).slice(0, 12);
        cards = ranked.map(x => aniCard(x.m, x.hits.length ? 'Matches ' + x.hits.slice(0, 4).join(', ') : 'Close to the title you typed'));
        if (ranked[0] && !titleLike && ranked[0].covered >= need && (!ranked[1] || ranked[0].s > ranked[1].s * 1.2)) top = cards[0];
      } catch (e) { offline = true; }
    }
    // a title: ask your sources too (what you can actually read). A description isn't searched there: titles only.
    let srcCards = [];
    if (titleLike) {
      say(`Searching ${plural(sources().length, 'source')}…`);
      const qk = keysOf({ title: q });
      const found = await searchSources(q, { timeout: 12000, stopOnExact: qk });
      srcCards = groupResults(found).sort((a, b) => Math.max(...b.items.map(s => s._how)) - Math.max(...a.items.map(s => s._how))).slice(0, 6)
        .map(g => ({ ...koruCard(g.best, `On ${[...new Set(g.items.map(s => P(s.provider)?.short || s.provider))].slice(0, 4).join(', ')}`, g.best.latest || P(g.best.provider)?.name), _how: Math.max(...g.items.map(s => s._how)) }));
    }
    if (own) r.add(`You already have **${own.title}**.`).card({ ...koruCard(own, 'In your library or history'), go: K.data.history?.[K.key(own.provider, own.slug)] ? readRoute(K.data.history[K.key(own.provider, own.slug)]) : null, goLabel: 'Continue' });
    let all = [...(titleLike ? srcCards : []), ...cards].filter((c, i, l) => l.findIndex(x => norm(x.title) === norm(c.title)) === i);
    // a guess from a few typed words: only keep it if the titles actually contain them
    if (weak && !own) {
      const st = kws.map(stem).filter(x => x.length >= 3);
      all = all.filter(c => c._how >= 1 || st.some(x => lc(c.title).includes(x)) && st.filter(x => lc(c.title).includes(x)).length >= Math.ceil(st.length / 2));
      if (!all.length) { r.say('unsure'); r.chip('What should I read next?', 'Find a manhwa', 'What can you do?'); return; }
      r.add('I\'m not sure that\'s what you meant, but here\'s my best guess:');
    }
    if (!all.length && !own) { if (offline) r.say('offline'); r.say('none'); r.chip('Recommend something like that instead'); return; }
    if (all.length) {
      if (top) r.say('findTop', { title: top.title }); else if (!weak) r.say('find');
      if (offline) r.detail('AniList didn\'t answer, so I only searched your sources.');
    }
    ctx.last = { kind: 'find', pool: all.slice(0, 30), shown: all.slice(0, cardCount()).map(c => c.id), t: text, f };
    ctx.focus = own ? koruCard(own) : all[0];
    all.slice(0, cardCount()).forEach(c => r.card(c));
    r.chip(all[0] ? 'Not that one' : null, all[0] ? 'Open the first one' : null, all[0] ? `Tell me more about ${all[0].title}` : null);
  }
  function detail(r, ctx, c) {
    if (!c) return false;
    r.add(`**${c.title}**${c.meta ? ' · ' + c.meta : ''}`);
    if (c.desc) r.add(c.desc.split('\n')[0].slice(0, lenOf() === 'short' ? 220 : 600));
    else if (c.kind === 'koru') r.add('It\'s on ' + (P(c.provider)?.name || c.provider) + '. Open it to see the full description.');
    if (c.genres?.length || c.tags?.length) r.detail('Genres: ' + [...(c.genres || []), ...(c.tags || []).slice(0, 5)].join(', ') + '.');
    if (c.alt?.length) r.detail('Also called ' + c.alt.slice(0, 3).join(', ') + '.');
    r.card({ ...c, desc: '' }); r.keepCards = 1;
    ctx.focus = c;
    r.chip(`More like ${c.title}`, 'Is it finished?', 'Open it');
    return true;
  }

  // ---------- answers: help with Koru ----------
  const HELP = [
    { re: /\b(your (?:name|personality|bio|avatar|voice)|rename you|change (?:your|kitsu'?s?) (?:name|personality|avatar|voice)|talk differently|change how you talk|kitsu'?s? (?:settings|bio))\b/, a: 'You can rename me, change my avatar and pick my personality on my **Bio** page. My **Settings** page has reply length, spoilers, sources and voice.', act: { label: 'Open Bio', ic: 'pencil', run: 'openBio' } },
    { re: /\bnew chapters?\b|\bnotif|\bcheck for (?:new|updates? (?:to|on) my)/, a: 'Koru checks your favourites for new chapters by itself, and the Library shows a badge on covers with new ones. You can also ask me "what\'s new in my favourites".', act: { label: 'Check now', ic: 'refresh', run: 'checkUpdates' } },
    { re: /\b(update koru|new version|update the app|app update|koru update|latest version)\b/, a: 'Settings → About shows your version and installs updates. Koru also tells you when a new one is out.', act: { label: 'Open About', ic: 'sparkle', set: 'about' } },
    { re: /\bwallpaper|background image|background picture\b/, a: 'Settings → Appearance → Wallpaper: pick a picture, then dim and blur it.', act: { label: 'Open Appearance', ic: 'palette', set: 'look' } },
    { re: /\b(animations?|motion|transitions?|less movement|reduce motion)\b/, a: 'Settings → Appearance → Motion turns animations on or off, changes their speed and picks the page transition.', act: { label: 'Open Appearance', ic: 'palette', set: 'look' } },
    { re: /\bsidebar|side bar\b/, a: 'Settings → Appearance → Sidebar moves it left or right and changes its style. The button at its bottom makes it smaller.', act: { label: 'Open Appearance', ic: 'palette', set: 'look' } },
    { re: /\b(fonts?|text size|bigger text|smaller text|round(?:ed)? corners)\b/, a: 'Settings → Appearance → Shape and text has the font, text size and corner roundness.', act: { label: 'Open Appearance', ic: 'palette', set: 'look' } },
    { re: /\b(themes?|colou?rs?|accent|dark mode|light mode|appearance|style|look of koru|glass|blur|glow)\b/, a: 'Settings → Appearance. Pick a style or a saved look at the top (hover one to preview it), then fine-tune colours, gradients, glass and glow below.', act: { label: 'Open Appearance', ic: 'palette', set: 'look' } },
    { re: /\btranslat/, a: 'Settings → Reading has Translate raws. In the reader, the translate button reads the page text and translates it.', act: { label: 'Open Reading', ic: 'book', set: 'read' } },
    { re: /\b(night (?:filter|mode)|blue light|warm(?:er)? screen)\b/, a: 'Settings → Reading → Night filter warms and dims the pages for late reading.', act: { label: 'Open Reading', ic: 'book', set: 'read' } },
    { re: /\bambient\b/, a: 'Settings → Reading → Ambient light: the glow around the page. Turn it off or soften it there.', act: { label: 'Open Reading', ic: 'book', set: 'read' } },
    { re: /\b(reader|reading mode|scroll(?:ing)?|page mode|double page|two pages|layout|fit (?:width|height)|zoom|webtoon mode)\b/, a: 'Settings → Reading → Pages and layout: scroll or page by page, one or two pages, fit and width. Most of it is also in the reader\'s own menu.', act: { label: 'Open Reading', ic: 'book', set: 'read' } },
    { re: /\bdownload/, a: 'Open a series, pick chapters and press Download. They show up in Downloads and work offline.', act: { label: 'Open Downloads', ic: 'download', route: '/downloads' } },
    { re: /\b(backups?|export|restore my data)\b/, a: 'Settings → Library & sync → Library and data has Export backup and Import backup.', act: { label: 'Open Library & sync', ic: 'folder', set: 'library' } },
    { re: /\b(import|myanimelist|mal|anilist list|mangadex list)\b/, a: 'Settings → Library & sync → Import from another app brings in a public MyAnimeList, AniList or MangaDex list.', act: { label: 'Open Library & sync', ic: 'folder', set: 'library' } },
    { re: /\b(sync|other pc|another pc|second pc|my phone|both pcs)\b/, a: 'Settings → Library & sync → Sync keeps your library, history and stats the same on your PCs.', act: { label: 'Open Library & sync', ic: 'folder', set: 'library' } },
    { re: /\b(incognito|private(?:ly)?|private mode|secretly|without saving|hide my history|not save (?:my )?history)\b/, a: 'Press the incognito button at the bottom of the sidebar. While it\'s on, nothing you read is saved.' },
    { re: /\b(shel(?:f|ves)|rate|rating|stars?|notes?)\b/, a: 'On a series page, the stars, note and shelf buttons sit under the cover. Shelves then show up as Library filters, and I use your ratings for suggestions.', act: { label: 'Open Library', ic: 'library', route: '/library' } },
    { re: /\b(trash|hide (?:a )?series|block a series|never see)\b/, a: 'Right-click a cover (or press its ⋯ button) for Hide or Absolute trash. Trash removes it everywhere, for good.' },
    { re: /\b(completed (?:only|filter)|only completed|finished series filter)\b/, a: 'Explore and Search have a Completed only chip.', act: { label: 'Open Explore', ic: 'explore', route: '/explore' } },
    { re: /\b(trending|popular)\b/, a: 'Explore → Trending merges every source\'s popular list into one.', act: { label: 'Open Explore', ic: 'explore', route: '/explore' } },
    { re: /\bwrapped\b/, a: 'Stats → Your Wrapped: your month or year in reading, and you can save it as a picture.', act: { label: 'Open Wrapped', ic: 'sparkle', route: '/wrapped' } },
    { re: /\b(stats|statistics|reading time)\b/, a: 'The Stats page shows your reading time, chapters, streak and top series.', act: { label: 'Open Stats', ic: 'chart', route: '/stats' } },
    { re: /\bstreak\b/, a: 'The streak chip on the Library page: click it to restore missed days (5 a month) or pause it.', act: { label: 'Open Library', ic: 'library', route: '/library' } },
    { re: /\b(lag(?:gy)?|slow|stutter\w*|smooth\w*|performance|fps|light mode|gpu|graphics card)\b/, a: 'Settings → Performance → Graphics: light mode keeps Koru smooth on slower PCs.', act: { label: 'Open Performance', ic: 'chart', set: 'speed' } },
    { re: /\b(ctrl\s*\+?\s*k|quick jump|shortcuts?|keyboard)\b/, a: 'Press Ctrl+K anywhere to jump to a series, page or setting. You can ask me from there too.', act: { label: 'Try Ctrl+K', ic: 'search', run: 'quickJump' } },
    { re: /\b(chat with friends|crew|read together|together|friends?)\b/, a: 'The Chat page is for your crew: talk, share series and read together.', act: { label: 'Open Chat', ic: 'chat', route: '/chat' } },
    { re: /\b(music|songs?|lo-?fi|soundtrack|playlist)\b/, a: 'Settings → Music sets up the player. Koru can play mood music or a soundtrack per series.', act: { label: 'Open Music settings', ic: 'music', set: 'music' } },
    { re: /\b(widget|desktop|taskbar|now playing|start with windows)\b/, a: 'Settings → Windows has the taskbar, the desktop widget and Now playing.', act: { label: 'Open Windows settings', ic: 'pages', set: 'pc' } },
    { re: /\b(sources?|sites?|providers?|scan sites?|site (?:is )?down)\b/, a: 'Koru searches all its sources together. Settings → Performance → Sources checks which ones are up, and a series can move to another source from its page.', act: { label: 'Open Performance', ic: 'chart', set: 'speed' } },
    { re: /\b(favou?rites?|heart|follow)\b/, a: 'Press the heart on a series page (or right-click a cover) to add it to your favourites. They live in the Library and get checked for new chapters.', act: { label: 'Open Library', ic: 'library', route: '/library' } },
    { re: /\bsettings?\b/, a: 'All of Koru\'s settings are in Settings, grouped in the side menu, with a search box at the top.', act: { label: 'Open Settings', ic: 'settings', route: '/settings' } }
  ];
  const helpFor = t => HELP.find(h => h.re.test(t));

  // ---------- small talk ----------
  const JOKES = ['Why did the regressor fail his exam? He kept answering the questions from his last life.', 'My reading list has a reading list.',
    'I tried to quit manhwa cold turkey. I lasted one chapter. A short one.', 'The tower has 100 floors and my backlog has more.',
    'Why don\'t murim masters use elevators? They\'re too busy taking the stairs to enlightenment.'];
  const CAN = 'I can tell you about your reading ("my stats this month", "what\'s my streak", "what did I stop reading"), suggest what to read next, find a series from a description ("the one where a guy regresses and becomes a blacksmith") and help with Koru ("how do I change the theme").';

  // ---------- understanding typos and slang ----------
  const FIX = [[/\b(?:wat|wht|whta|waht)\b/g, 'what'], [/\b(?:shud|shld|shoud|sould)\b/g, 'should'], [/\b(?:smth|sth|smthn|sumthin|somethin|smthing)\b/g, 'something'],
    [/\bu\b/g, 'you'], [/\bur\b/g, 'your'], [/\br\b/g, 'are'], [/\bpl[sz]+\b/g, 'please'], [/\brecs\b/g, 'recommendations'], [/\brec\b/g, 'recommend'], [/\bchs\b/g, 'chapters'], [/\bch\b(?=\s*\d|\s*$)/g, 'chapter'],
    [/\b(?:favs|faves|favos)\b/g, 'favourites'], [/\bfav\b/g, 'favourite'], [/\b(?:manwha|manhwah|mahnwa|manhawa|manhwas)\b/g, 'manhwa'], [/\bim\b/g, 'i\'m'], [/\bdont\b/g, 'don\'t'], [/\bwhats\b/g, 'what\'s'],
    [/\bwanna\b/g, 'want to'], [/\bgimme\b/g, 'give me'], [/\brn\b/g, 'right now'], [/\b(?:thx|thnx|tnx|thanx|tysm)\b/g, 'thanks'], [/\bw\/o\b/g, 'without'], [/\bw\/\s?/g, 'with '],
    [/\b(?:cuz|coz|bc)\b/g, 'because'], [/\bidk\b/g, 'i don\'t know'], [/\b(?:tbh|ngl|lol|lmao|fr|pls)\b/g, ' '], [/\bhaven'?t\b/g, 'haven\'t'], [/\bdidnt\b/g, 'didn\'t'], [/\bcant\b/g, 'can\'t'],
    [/\blvl(?:ing)?\b/g, 'leveling'], [/\bsys\b/g, 'system'], [/\bop\b(?= mc| main)/g, 'overpowered'], [/\bfl\b/g, 'female lead'], [/\bml\b/g, 'male lead'], [/\bk-?drama\b/g, 'drama'], [/\bgud\b/g, 'good'], [/\bnxt\b/g, 'next'],
    [/\bpls\b/g, 'please'], [/\bppl\b/g, 'people'], [/\bok+\b/g, 'ok'],
    [/\b(?:wek|wk|weeek)\b/g, 'week'], [/\b(?:mnth|mth|monht|mont)\b/g, 'month'], [/\b(?:yr|yaer)\b/g, 'year'], [/\b(?:tday|tdy|2day)\b/g, 'today'], [/\b(?:meny|mny)\b/g, 'many'], [/\b(?:chaptrs|chapers|chapetrs|chps)\b/g, 'chapters']];
  // the words that steer an answer: a misspelling one letter off (two for long words) is read as the word
  const VOCAB = ('recommend recommendation recommendations suggest suggestion something should anything chapters chapter favourites favourite favorite favorites streak history reading completed finished shorter longer similar '
    + 'manhwa manga manhua webtoon stats statistics genres genre shelves shelf ratings rated wrapped theme themes download downloads settings update updates regression regressor reincarnation reincarnated murim villainess '
    + 'academy dungeon dungeons apocalypse romance comedy horror fantasy isekai blacksmith necromancer cultivation martial incognito wallpaper colour colours color colors translate abandoned dropped stopped recently '
    + 'month week today yesterday year read stars start state sharp short long story series streaks people please random popular trending action adventure mystery thriller psychological supernatural system tower '
    + 'hunter hunters revenge magic dragon demon emperor princess duchess knight soldier doctor surprise continue progress library notes where whats which would could night').split(' ');
  const VSET = new Set(VOCAB);
  const COMMON = new Set(('about above after again against almost alone along already always among another answer around asked away because before begin being below better between bring build called cannot cause change check chose clean clear close comes could count cover doing dream during early earth either enjoy enough every faith false feels field final first flower found front funny given gives going great green group guess happy heard heart heavy hello helps human idea image issue keeps kinds known later learn least leave light likes lines lived lives local looks loved lower lucky makes maybe means might money months mostly mouth moved movie music named never night noble north nothing number often older order other owner paper parts party peace place plain plans plant point power press price prove quick quiet quite rather reach ready reads really reason right river round rules saved saying scene seems sense serve seven shall share shown shows since sleep small smart smile sound south space speak spent spoke stand still stood store stuff style sweet table taken takes taste teach thank their theme there these thing think third those three throw times tired title total touch tried truly trust truth twice under until upset using usual value video voice waits waking walks wants watch water while white whole whose woman women words works world worse worth would write wrong years young yours youth privately private reader viewpoint omniscient solo leveling').split(' '));
  const dl = (a, b) => {   // Damerau-Levenshtein distance, stopping early above 2
    if (Math.abs(a.length - b.length) > 2) return 3;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
  };
  const fixCache = new Map();
  function fixWord(w) {
    if (w.length < 5 || VSET.has(w) || COMMON.has(w) || /\d/.test(w)) return w;
    if (fixCache.has(w)) return fixCache.get(w);
    let best = w, bd = w.length >= 8 ? 2 : 1;
    for (const v of VOCAB) { if (v[0] !== w[0] && w.length < 7) continue; const d = dl(w, v); if (d <= bd && (d < bd || best === w)) { best = v; bd = d; if (d === 0) break; } }
    fixCache.set(w, best);
    return best;
  }
  function tidy(text) {
    let t = lc(text).replace(/[’‘`]/g, '\'').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().replace(/^(?:(?:hey|hi|ok|okay|yo|so)[, ]+)?kitsu[,!:.]?\s+(?=\S)/, '');
    for (const [a, b] of FIX) t = t.replace(a, b);
    // quoted parts are titles: left exactly as typed
    t = t.split(/("[^"]*")/).map((p, i) => i % 2 ? p : p.replace(/[a-z']+/g, w => fixWord(w))).join('');
    return t.replace(/\s+/g, ' ').trim();
  }

  // ---------- privacy: hidden series stay out unless you allow it; trash never shows ----------
  const visibleKey = k => { const f = K.data.flags?.[k] || {}; return !f.trash && (S().seePrivate || !f.hidden); };
  const visible = s => !!s && visibleKey(K.key(s.provider, s.slug));

  // ---------- intents (the same labels KitsuNet is trained on) ----------
  // Rules give a label and how sure they are; KitsuNet (when it's there) is the main signal and the rules break ties.
  function ruleIntent(t, ctx) {
    const has = ctx.last?.pool?.length, S1 = (intent, strong = true, arg) => ({ intent, strong, arg });
    if (!t) return S1('unknown', false);
    // hesitation after a suggestion ("hmm", "idk", "meh") is not a new request
    if (/^(?:h+m+|um+|uh+|idk|i dunno|dunno|i don'?t know|meh+|eh+|\?+|not sure|maybe|nah+|ehh*|i guess|kinda|not really|\.{2,}|hm+ ok|hmm+ idk)[?.!… ]*$/.test(t)) return S1('hesitant');
    if (/^surprise me\b|^(?:a )?surprise pick\b|^(?:give me )?(?:something )?random\b/.test(t)) return S1('surprise');
    // doing things in Koru: checked first so "open" and "read" below don't take them
    if (/^find (?:one|a series|something|a manhwa|it) (?:from|by|with) (?:a |the |my )?description$/.test(t)) return S1('find_prompt');
    if (/^help me change something$|^(?:what can i|help me) (?:change|tweak|adjust)\b/.test(t)) return S1('settings_help');
    if (/^(?:please |can you |could you )?(?:open|go to|take me to|show(?: me)?|jump to)\b.*\bsettings?\b|^settings (?:for|on)\b/.test(t) && !/\bhow (?:do|can|to)\b/.test(t)) return S1('do_settings');
    if (/^(?:please |pls |can you |could you |kitsu )?(?:add|put|save|stick|move|place|file|throw)\b.*\b(?:to|on|onto|in|into)\b/.test(t) && !/\bhow (?:do|can|to)\b/.test(t)) {
      if (/\b(?:favou?rites?|favs?|library)\s*(?:please)?\??$/.test(t)) return S1('do_fav');
      const q = shelfAsk(t);
      if (q && (/\bshel(?:f|ves)\b/.test(t) || (K.libx?.shelfNames?.() || []).some(n => lc(n) === lc(q.shelf || '')))) return S1('do_shelf');
    }
    if (/^(?:favou?rite|heart) (?:it|this|that)\b/.test(t)) return S1('do_fav');
    if (/^(?:please )?(?:rate|give)\b.*\b[1-5]\s*(?:stars?|★|\/\s*5|out of 5)\??$|^rate (?:it|this|that) [1-5]\??$/.test(t)) return S1('do_rate');
    if (/^(?:please )?(?:start|begin) reading\b|^(?:resume|continue|keep) reading (?:it|this|that)(?: one)?\??$|^(?:read|start) (?:it|this|that)(?: one)?(?: now)?\??$/.test(t) || (ctx.hereNow && /^(?:continue|resume|keep) reading\??$/.test(t))) return S1('do_read');
    if (/^where (?:was|am|did) i(?: (?:up to|at|stop|leave off))?\??$|^what chapter (?:am|was) i (?:on|at)\??$/.test(t)) return S1('where_was_i');
    if (/^(?:ok(?:ay)?,? )?(?:open|read|start|go to|take me to|let'?s read)\b|^(?:the )?(?:first|second|third|fourth|fifth|last|1st|2nd|3rd) one\b|^#?\d$/.test(t)) return S1('open_item');
    if (/^why\b|\bwhy (?:that|this|these|those|did you|do you think|the)\b|\bhow did you (?:pick|choose)\b|\bwhat makes you\b|^explain\b/.test(t) && (has || ctx.focus)) return S1('explain_why');
    if (/\btell me about (?:it|this|that)\b|\b(tell me more|more about|more info|what'?s (?:it|that|this|the \w+ one) about|what is .+ about|details|describe|synopsis|summary of|is it good)\b/.test(t)) return S1('item_details');
    if (/^(?:is it|is that|is this|are they|are those) (?:finished|completed|done|over|ongoing)\b|^how many chapters (?:does it|is it|has it)/.test(t) && (ctx.focus || has)) return S1('item_status');
    if (has && (/^(?:no|nah|nope|not (?:that|this|those|these|it)(?: one)?|not quite|wrong(?: one)?|something else|others?|another one|different(?: ones)?|none of (?:these|those|them)|neither|try again)\b/.test(t) || /\bnot those\b|\balready read (?:that|those|it|them)\b|\bi'?ve read (?:that|those|it|them)\b/.test(t))) return S1('refine_not_that');
    if (/^(?:more|something|anything|stuff|series|manhwa|give me (?:some|something)|recommend(?: me)?(?: something)?)? ?(?:like|similar to) (?:that|this|it|those|the (?:first|second|third|last) one)\b|^similar ones\b/.test(t)) return S1('more_like', true, 'focus');
    const lm = t.match(/(?:\bmore|\bsomething|\banything|\bstuff|\bseries|\bmanhwa|\bmanga|\bothers|\bones|\bwhat'?s|\brecommend(?: me)?(?: something)?|\bsimilar(?: to)?|\bsame vibe as|\bin the style of|\bif i liked|^like)\s+(?:like|to|as)?\s*("?)([^"?]{3,60}?)\1(?:\s+but\s+(.+?))?\??$/);
    if (lm && /\b(like|similar|vibe|style|if i liked)\b/.test(t) && !/\bi (?:like|love)\b/.test(t.slice(0, 8))) {
      const title = lm[2].replace(/\s+(?:but|except|without)\b.*$/, '').trim();
      const tropeOnly = keywords(title).every(w => conceptsIn(w).length || STOP.has(w));
      if (title && !/^(?:that|this|it|those|these|the (?:first|second|third|last) one|my favou?rites?)$/.test(title) && (!tropeOnly || resolveOwn(title))) return S1('more_like', true, { title, but: lm[3] || '' });
    }
    if (/^(?:more|show more|more please|keep going|go on|another batch|next|more of (?:those|these|them)|any more|give me more)\b/.test(t) && has) return S1('more_results');
    if (has && /^(?:something |any(?:thing)? |a |only |just )?(?:short(?:er)?|quick(?:er)? read|fewer chapters|less chapters|not (?:that|so|too) long)\b/.test(t)) return S1('refine_shorter');
    if (has && /^(?:something |any(?:thing)? |a |only |just )?(?:long(?:er)?|more chapters|lots of chapters)\b/.test(t)) return S1('refine_longer');
    if (has && /^(?:only |just )?(?:the )?(?:completed|finished|ended)(?: ones?)?(?: only| please)?\??$|^no ongoing\b|^completed only\b/.test(t)) return S1('refine_completed');
    if (/^(?:hi+|hey+|hello|yo|sup|hiya|howdy|good (?:morning|afternoon|evening)|heya|hola|morning)\b[!. ]*(?:kitsu|there)?[!. ]*$/.test(t)) return S1('smalltalk_greeting');
    if (/^(?:thanks?|thank you|ty|cheers|nice|great|awesome|cool|perfect|love it|good job|appreciate it|great job)\b/.test(t) && t.length < 40) return S1('smalltalk_thanks');
    if (/^(?:bye|good ?night|see you|cya|later|gn|gotta go|night night)\b/.test(t)) return S1('smalltalk_bye');
    if (/\b(who are you|what are you|your name|are you (?:an? )?(?:ai|bot|human|real|chatgpt|claude)|who made you|how do you work)\b/.test(t)) return S1('about_kitsu');
    if (/^(?:help|commands\??)$|\b(what can you do|what do you know|how can you help|what (?:are you able|should i ask))\b/.test(t)) return S1('capabilities');
    if (/\b(joke|make me laugh|something funny)\b/.test(t) && !/\b(manhwa|manga|recommend|suggest)\b/.test(t)) return S1('smalltalk_joke');
    // help with Koru, when it's clearly a how-to (not "how many", "how long")
    const h0 = helpFor(t);
    if (h0 && /\b(how (?:do|can|to|would|should)|where (?:is|are|do|can)|can i|can'?t|cannot|turn (?:on|off)|set ?up|enable|disable|is there a way|i want to|get rid|import|export|backup|laggy|stutter\w*|slow)\b/.test(t) && !/\bhow (?:many|much|long)\b/.test(t)) return S1('app_help', true, h0);
    // your data
    if (/\bstreaks?\b/.test(t) && !/\bhow (?:do|can) i\b/.test(t)) return S1('streak');
    if (/\b(wrapped|recap (?:of )?my|my (?:month|year) in)\b/.test(t)) return S1('wrapped');
    if (/\bwhere (?:was|am|did) i (?:in|on|at|with|stop in)\s+.+|\bwhat chapter (?:am|was) i (?:on|at) in\s+.+|\bmy progress (?:in|on)\s+.+|\bwhich chapter of\s+.+|^continue\s+(?!reading\b).+|^resume\s+.+/.test(t)) return S1('continue_reading');
    if (/^(?:continue reading|resume|pick up where i left off|continue|resume my last read)\??$/.test(t)) return S1('continue_reading', true, 'last');
    if (/\b(how many|how much|how long|count|number of)\b.*\b(chapters?|time|hours?|minutes?|read|reading)\b|\b(?:my )?stats\b|\bstatistics\b|\breading time\b|\bhow productive\b|^(?:and |how about |what about )?(?:this|last) (?:week|month|year)\??$|^(?:and |how about |what about )?(?:today|yesterday|all time)\??$/.test(t)
      && !/\bhow many (?:favou?rites|series|shelves|have i (?:rated|completed|finished))\b|\bmy library\b/.test(t)) return S1('my_stats');
    if (/\bwhat (?:have|has|am|was) i (?:been )?reading\b|\b(?:my )?(?:recent|currently) read|\bmy (?:reading )?history\b|\bwhat am i on\b|\blast thing i read\b|\bwhat did i read lately\b|\brecent reads\b/.test(t)) return S1('my_history');
    if (/\b(stop(?:ped)? reading|i stopped|drop(?:ped)?|abandon(?:ed)?|gave up on|forgot about|haven'?t (?:read|opened) in|left (?:unfinished|halfway)|unfinished)\b/.test(t)) return S1('stopped_reading');
    if (/\b(what'?s new|new chapters?|any (?:new )?updates?|anything new|updated|new eps?)\b/.test(t) && !/\bhow (?:do|can|to)\b/.test(t)) return S1('whats_new');
    if (/\b(top|favou?rite|main|best) genres?\b|\bwhat genres?\b|\bmy (?:taste|genres?)\b|\bwhat do i (?:like|read most)\b|\bwhat kind of (?:stuff|things|series) do i\b|\bwhich genres?\b/.test(t)) return S1('my_genres');
    if (/\b(?:my )?(?:rated|ratings?|my stars|top rated|highest rated|lowest rated|best rated)\b|\brate[d]? \d stars?\b|\bwhat did i rate\b/.test(t) && !/\bhow (?:do|can) i\b|\bhow to\b/.test(t)) return S1('my_ratings');
    if ((/\bshel(?:f|ves)\b/.test(t) || (K.libx?.shelfNames?.() || []).some(n => t.includes(lc(n)))) && !/\bhow (?:do|can) i\b|\bhow to\b|\bmake a\b|\bimport\b/.test(t)) return S1('my_shelves');
    if (/\bmy notes\b|\bnotes on\b|\bwhat notes\b/.test(t)) return S1('my_notes');
    if (/\b(how many (?:favou?rites|series)|my library|library size|how big is my library|how many have i (?:read|finished|completed)|how many (?:series )?have i rated)\b/.test(t)) return S1('my_library');
    if (/\bbadges?\b/.test(t)) return S1('my_badges');
    // help with Koru
    const h = helpFor(t);
    if (h && /\b(how|where|can i|can'?t|cannot|change|turn (?:on|off)|switch|set ?up|enable|disable|settings?|is there a way|help|make|customi[sz]e|i want to|get rid|remove|add|fix|use|why is|laggy|slow)\b/.test(t)) return S1('app_help', true, h);
    // finding and suggesting
    const isFind = /\b(find|looking for|look for|look up|search(?: for)?|trying to (?:find|remember)|the one (?:where|with|about|that)|what'?s (?:the|that) (?:name|title|one|manhwa)|name of (?:the|that)|remember (?:a|the|this|that)|forgot the name|i read (?:a|this|one)|there was (?:a|this)|do you (?:know|have)|is .+ on koru|where can i read|pull up)\b/.test(t)
      || /^(?:a |the |that )?(?:manhwa|manga|manhua|webtoon|series|story|one) (?:where|about|with|that) /.test(t);
    const isRec = /\b(recommend|recommendations|suggest|what (?:should|can|could|do) i read|what to read|something (?:to read|new|good|fun)|any good|give me (?:some|a|an|something)|i want (?:some|a|an|something)|i(?:'m| am) in the mood|read next|next read|surprise me|pick (?:something|one)|popular|hidden gems?|i(?:'m| am) bored|nothing to read|need (?:a new|something)|what would i like|what next after|top .+ (?:manhwa|webtoons?|manga))\b/.test(t)
      || /^(?:some|a|an|any|best) .*\b(manhwa|manga|manhua|webtoons?|series|stor(?:y|ies)|ones?)\b/.test(t);
    if (isFind && !/\b(recommend|suggest)\b/.test(t)) {
      const rest = t.replace(/^.*?\b(?:find|looking for|look for|look up|search(?: for)?|do you (?:know|have)|pull up|where can i read)\b\s*/, '').replace(/^(?:me |the |a |that )?(?:manhwa |manga |series |one )?(?:called |named )?/, '');
      const desc = /\b(where|about|who|with|that|which|whose|when)\b/.test(rest) || keywords(rest).length > 6;
      return S1(desc ? 'find_by_description' : 'find_title');
    }
    if (isRec) return S1('recommend');
    const cs = conceptsIn(t);
    if (cs.length) {
      if (/\b(where|who|whose|that has|which|then|after|becomes?|turns? into|gets?|ends up|wakes up)\b/.test(t) && keywords(t).length >= 3) return S1('find_by_description', false);
      return S1('recommend', false);
    }
    if (resolveOwn(t) && t.split(' ').length <= 6) return S1('continue_reading', false);
    if (h && /\b(settings?|option|button|page|menu|change|turn|make|use|where)\b/.test(t)) return S1('app_help', false, h);
    const kw = keywords(t);
    if (kw.length && kw.length <= 6 && !/\?$/.test(t) && !/^(?:why|how|what|when|who|is|are|do|does|can)\b/.test(t)) return S1('find_title', false, 'guess');
    return S1('unknown', false);
  }
  // ---------- just talking: Kitsu only brings up reading, picks or Koru when you do ----------
  const GREET_RE = /^(?:(?:hi+|hey+|hello+|helo|yo+|sup|wassup|wsg|wsp|wys|hiya|howdy|heya|hola|gm|morning|evening|what'?s ?up|whats ?good|what'?s good|what is good|what is up|wagwan|good (?:morning|afternoon|evening|day))\b[!.,?~ ]*(?:kitsu|there|bro|bruh|man|dude|fam|g|bestie|my (?:g|guy|friend))?[!.,?~ ]*){1,3}$/;
  const SMALL_RE = /\b(how are (?:you|u|ya)|how r u|how(?:'s| is) (?:it going|life|your day|ur day)|how you doing|how u doin\w*|how you been|how have you been|\bhru\b|what are you (?:doing|up to)|what u doing|\bwyd\b|you good|are you okay)\b/;
  const CORRECT_RE = /\b(it was (?:just )?a greeting|(?:it'?s|that'?s|that was) (?:just )?a greeting|i (?:was )?just (?:saying|said) (?:hi|hello|hey|what'?s (?:good|up))|i didn'?t ask (?:for|you|about)|i did not ask|not asking (?:for|about)|i wasn'?t asking|didn'?t want (?:recommendations|recs|suggestions|picks)|just (?:chatting|talking|saying hi)|i (?:just )?wanna (?:talk|chat)|let'?s (?:just )?(?:talk|chat)|can we (?:just )?(?:talk|chat))\b/;
  const isChat = t => GREET_RE.test(t) || CORRECT_RE.test(t) || ((SMALL_RE.test(t) || /^(?:tell me|say|teach me|share|give me) (?:something|anything|a (?:fun |random |cool )?fact|a story|a riddle)\b/.test(t)) && !READ_CUE.test(t));
  // words that mean the message is about reading, a series, Koru or your data
  const READ_CUE = /\b(read|reading|reads|reader|manhwa|manga|manhua|webtoons?|toons?|series|comics?|novels?|chapters?|ch\.?\s?\d+|recommend\w*|suggest\w*|recs?|picks?|genres?|tropes?|stor(?:y|ies)|plot|mc|fmc|ml|protagonist|isekai|romance|action|fantasy|regress\w*|reincarnat\w*|villain\w*|murim|cultivation|leveling|koru|library|shel(?:f|ves)|fav\w*|stats?|streak|wrapped|history|anilist|sources?|settings?|theme|download\w*|backup|sync|bookmark\w*|rated?|ratings?|stars?|completed|ongoing|finished|dropped)\b/;
  const meWords = /\b(i|im|i'm|me|my|you|u|ur|your|we|us|lol|lmao|haha|bro|bruh)\b/;
  function cueOf(t, raw) { return READ_CUE.test(t) || READ_CUE.test(raw) || !!resolveOwn(t) || (conceptsIn(t).length > 0 && !meWords.test(raw)); }
  // KitsuNet's labels that map onto the same handlers
  const NET_ALIAS = { app_help_theme: 'app_help', app_help_reader: 'app_help', app_help_downloads: 'app_help', app_help_backup_sync: 'app_help', app_help_import: 'app_help', app_help_incognito: 'app_help',
    app_help_shelves_ratings: 'app_help', app_help_performance: 'app_help', app_help_updates: 'app_help', app_help_shortcuts: 'app_help', app_help_music: 'app_help', app_help_other: 'app_help' };
  const NEEDS_CTX = new Set(['refine_not_that', 'more_results', 'refine_shorter', 'refine_longer', 'refine_completed', 'explain_why', 'open_item', 'item_details', 'item_status']);
  function pickIntent(raw, t, ctx) {
    const low = lc(raw).replace(/[’‘`]/g, '\'').replace(/\s+/g, ' ').trim();
    if (isChat(low) || isChat(t)) return { intent: 'chat', strong: true };
    const p = pickIntent0(raw, t, ctx);
    if (p.intent === 'chat') return p;
    // "hmm" with nothing suggested yet is just talking
    if (p.intent === 'hesitant' && !ctx.last?.pool?.length) return { intent: 'chat', strong: false };
    if (p.intent === 'unknown') return { intent: 'chat', strong: false };
    // a guess (not a clear request) about picks or a series needs the message to actually be about reading
    if (!p.strong && !cueOf(t, low) && !(p.intent === 'find_title' && !meWords.test(low) && !/\?$/.test(low))) return { intent: 'chat', strong: false };
    return p;
  }
  function pickIntent0(raw, t, ctx) {
    const rule = ruleIntent(t, ctx);
    if (ctx.awaitFind) { ctx.awaitFind = false; if (!rule.strong || rule.intent === 'unknown') return { intent: 'find_by_description', strong: true }; }
    if (ACT_INTENTS.has(rule.intent) || rule.intent === 'hesitant' || rule.intent === 'surprise') return rule;
    if (rule.strong && ctx.focus && ['item_status', 'item_details', 'more_like', 'where_was_i'].includes(rule.intent)) return rule;   // about the series we're on
    const net = K.kitsuNet?.intent && netOK ? (() => { try { return K.kitsuNet.intent(raw) || []; } catch { return []; } })() : [];
    const top = net[0];
    if (!top) return rule;
    const label = NET_ALIAS[top.intent] || top.intent;
    const usable = !NEEDS_CTX.has(label) || ctx.last?.pool?.length || ctx.focus;
    if (rule.intent === label) return rule;
    if (rule.strong) {
      const second = net.find(x => (NET_ALIAS[x.intent] || x.intent) === rule.intent);
      if (top.p >= 0.92 && usable && !second) return { intent: label, strong: true, arg: label === 'app_help' ? helpFor(t) : undefined, net: top.p };
      return rule;
    }
    if (top.p >= 0.5 && usable) return { intent: label, strong: false, arg: label === 'app_help' ? helpFor(t) || { a: 'All of Koru\'s settings are in Settings, grouped in the side menu, with a search box at the top.', act: { label: 'Open Settings', ic: 'settings', route: '/settings' } } : rule.arg, net: top.p };
    return rule;
  }
  // "what's my streak and recommend something": two questions, two answers
  function splitMulti(t, ctx) {
    const bits = t.split(/\s*(?:,?\s+and also\s+|,?\s+also\s+|;\s*|,?\s+and then\s+|\?\s+|\.\s+(?=[a-z]))\s*/).map(x => x.trim()).filter(x => x.length > 2);
    let parts = bits;
    if (bits.length === 1 && / and /.test(t)) {
      const [a, ...b] = t.split(' and '), rest = b.join(' and ');
      const ia = ruleIntent(a, ctx), ib = ruleIntent(rest, ctx);
      if (ia.strong && ib.strong && ia.intent !== ib.intent && !['find_by_description', 'recommend', 'more_like'].includes(ia.intent)) parts = [a, rest];
    }
    if (parts.length > 3) parts = parts.slice(0, 3);
    if (parts.length > 1) { const ints = parts.map(p => ruleIntent(p, ctx)); if (ints.some(x => x.intent === 'unknown') || new Set(ints.map(x => x.intent)).size < parts.length) return [t]; }
    return parts;
  }

  // the built-in words for plain conversation; with the AI voice, the model answers instead
  function chatReply(r, t, raw, chat) {
    r.chat = true; r.keepCards = 0;
    const x = lc(raw || t), n = chat.msgs.length + hash(x);
    if (CORRECT_RE.test(x)) { r.add(pick(['My bad, I jumped ahead there! Hey! How\'s it going?', 'Oops, got a little too eager. Hi! What\'s up with you?', 'Ah, sorry about that! Hey, how are you doing?'], n)); return; }
    if (SMALL_RE.test(x)) { r.add(pick(/what are you|what u|wyd/.test(x) ? ['Just hanging out here in Koru. What about you?', 'Not much, just chilling. You?'] : ['I\'m good, thanks for asking! How about you?', 'Doing great! How\'s your day going?', 'All good here! What about you?'], n)); return; }
    if (GREET_RE.test(x)) { r.say('hi'); return; }
    if (!(chat.ctx ||= {}).toldVoice) {
      chat.ctx.toldVoice = true;
      const st = brain.st, d = st?.dl;
      if (brainHost() && (!st || st.runtime) && S().llm) { r.add(d?.state === 'downloading' || d?.state === 'verifying' ? `I'm still getting my AI voice (${Math.round((d.done / (d.total || 1)) * 100)}% downloaded), so I can't really chat about everything yet. Give me a few minutes!` : 'I can\'t chat about everything until my AI voice is on. It downloads by itself when Kitsu is open, or turn it on in Settings → Kitsu.'); return; }
      r.add(brainHost() && !S().llm ? 'My AI voice is off, so I can only chat a little. Turn it on in Settings → Kitsu → Write replies with the brain.' : 'I can only chat a little on this device. Ask me anything about your reading, though!'); return;
    }
    r.add(pick(['Ha, fair. Tell me more?', 'I hear you. What else is going on?', 'Got it. Anything on your mind?'], n));
  }

  // ---------- the brain: which answer fits ----------
  async function answer(text, chat, say) {
    const ctx = chat.ctx ||= {};
    const clean = tidy(text);
    const parts = splitMulti(clean, ctx);
    const r = Reply('reply', chat.msgs.length + hash(clean));
    r.ctx = ctx;
    r.intents = [];
    for (const [i, p] of parts.entries()) {
      if (i) r.add('');
      const intent = pickIntent(parts.length > 1 ? p : text, p, ctx);
      r.intents.push(intent.intent);
      await answerOne(r, intent, p, parts.length > 1 ? p : text, chat, ctx, say);
    }
    if (!r.lines.length) r.say('unsure');
    if (r.intents.some(i => SUGGEST.has(i))) for (const c of r.cards.slice(0, r.keepCards ?? cardCount())) seenAdd(ctx, c);
    return r;
  }
  async function answerOne(r, intent, t, raw, chat, ctx, say) {
    const lastItems = () => (ctx.last?.shown || []).map(id => ctx.last.pool.find(c => c.id === id)).filter(Boolean);
    const itemByTitle = q => { const n = norm(q); if (n.length < 3) return null; return (ctx.last?.pool || []).find(c => norm(c.title) === n || keysOf(c).has(n)) || (ctx.last?.pool || []).find(c => norm(c.title).includes(n)); };
    const ordItem = () => { const o = ordinal(t); const list = lastItems(); if (o == null || !list.length) return null; return o < 0 ? list.at(-1) : list[o] || null; };
    const focusOf = () => ordItem() || ctx.focus || lastItems()[0] || null;
    switch (intent.intent) {
      case 'do_shelf': case 'do_fav': case 'do_rate': case 'do_read': case 'where_was_i': case 'do_settings': case 'settings_help': case 'find_prompt': return actOn(r, intent, t, raw, ctx);
      case 'hesitant': return hesitant(r, ctx, say);
      case 'surprise': return recommend(r, ctx, '', say, { surprise: true, filters: ctx.last?.f });
      case 'open_item': {
        const rest = t.replace(/^(?:ok(?:ay)?,? )?(?:open|read|start|go to|take me to|let'?s read)\s*/, '').replace(/\s*(?:in koru|please)$/, '');
        const c = ordItem() || (rest && !/^(?:it|that|this)( one)?$/.test(rest) ? itemByTitle(rest) : null) || (/^(?:it|that|this)( one)?$|^$/.test(rest) ? focusOf() : null);
        if (c) { ctx.focus = c; r.add(`Opening **${c.title}**…`); r.open = c; return; }
        const own = rest && resolveOwn(rest);
        if (own) { const h = K.data.history?.[K.key(own.provider, own.slug)]; r.add(`Opening **${own.title}**.`); r.go = h ? readRoute(h) : seriesRoute(own.provider, own.slug); return; }
        if (rest.length > 2) return find(r, ctx, rest, say, true);
        r.add('Open which one? Ask me for a series first and then say "open the first one".');
        return;
      }
      case 'explain_why': {
        const c = ordItem() || ctx.focus;
        if (c?.why) { r.add(`**${c.title}**: ${c.why.replace(/^Because /, 'because ')}.`); return; }
        const p = await profile({ fetchMissing: false });
        const top = [...p.prof.values()].sort((a, b) => b.w - a.w).slice(0, 3).map(x => lc(x.likedInBio || x.name));
        r.add(ctx.last?.kind === 'find' ? 'I matched the details you gave against AniList\'s descriptions and tags, and ranked by how many of them each one hits.'
          : `I look at what you rate highly, read the longest and favourite${top.length ? `. Right now that points to ${top.join(', ')}` : ''}${p.sd[0]?.why ? `, mostly because ${p.sd[0].why}` : ''}.`);
        const ls2 = lastItems().filter(x => x.why).slice(0, 3);
        for (const x of ls2) r.detail(`**${x.title}**: ${x.why}.`);
        r.chip('Something else', 'My top genres');
        return;
      }
      case 'item_details': {
        const m = t.match(/(?:more about|more info (?:on|about)|about|describe|summary of|details (?:on|of|for))\s+(.+?)\??$/) || t.match(/^what is (.+?) about\??$/);
        const named = m && !/^(?:it|that|this|the (?:first|second|third|last|\d+(?:st|nd|rd|th)?) one)$/.test(m[1]) ? m[1] : null;
        const c = ordItem() || (named ? itemByTitle(named) : null) || (!named ? focusOf() : null);
        if (c && detail(r, ctx, c)) return;
        if (named) return find(r, ctx, named, say, true);
        r.add('Tell me which series, and I\'ll describe it.');
        return;
      }
      case 'item_status': {
        const c = focusOf();
        r.add(c?.status ? `**${c.title}** is ${lc(STATUS[c.status] || c.status)}${c.chapters ? ` with ${c.chapters} chapters` : ''}.` : c?.here ? `The source doesn't say whether **${c.title}** is finished.` : c ? `I don't know yet. Open **${c.title}** to see its chapter list.` : 'Which one?');
        if (c) r.chip('Open it', `More like ${c.title}`);
        return;
      }
      case 'refine_not_that': {
        const c = ordItem();
        ctx.excluded = [...new Set([...(ctx.excluded || []), ...(c ? [c.id] : ctx.last.shown || [])])].slice(-200);
        if (nextBatch(r, ctx, ctx.last.kind === 'find' ? 'find' : 'notThat')) return;
        if (ctx.last.kind === 'recs') return recommend(r, ctx, ctx.last.t || '', say, { intro: 'notThat', filters: ctx.last.f, ask: (ctx.last.ask || []).map(id => CBY[id]).filter(Boolean) });
        r.say('none');
        return;
      }
      case 'more_like': {
        const a = intent.arg;
        if (a === 'focus' || !a) { const c = focusOf(); if (c) return moreLike(r, ctx, c, say); r.add('More like which one? Name a series, like "more like Solo Leveling".'); return; }
        if (/^my top rated$/.test(a.title)) { const best = Object.entries(K.data.notes || {}).filter(([k, n]) => n?.rating && visibleKey(k)).sort((x, y) => y[1].rating - x[1].rating)[0]; if (best) return moreLike(r, ctx, { title: titleOf(best[0]) }, say, a.but); }
        const c = itemByTitle(a.title) || resolveOwn(a.title) || { title: a.title };
        return moreLike(r, ctx, c.kind === 'ani' ? c : { title: c.title }, say, a.but);
      }
      case 'more_results': if (nextBatch(r, ctx, 'more')) return; return recommend(r, ctx, ctx.last?.t || t, say, { filters: ctx.last?.f });
      case 'refine_shorter': case 'refine_longer': case 'refine_completed': {
        const f = readFilters(t + (intent.intent === 'refine_shorter' ? ' shorter' : intent.intent === 'refine_longer' ? ' longer' : ' completed'), ctx.last?.f || {});
        if (ctx.last?.like && intent.intent === 'refine_completed') return moreLike(r, ctx, ctx.last.like, say, '', f);
        if (ctx.last?.like) return moreLike(r, ctx, ctx.last.like, say, '', f);
        return recommend(r, ctx, (ctx.last?.t || '') + ' ' + t, say, { filters: f, ask: (ctx.last?.ask || []).map(id => CBY[id]).filter(Boolean) });
      }
      case 'smalltalk_greeting': case 'chat': return chatReply(r, t, raw, chat);
      case 'smalltalk_thanks': r.say('thanks'); return;
      case 'smalltalk_bye': r.say('bye'); return;
      case 'about_kitsu': r.say('me'); r.detail('No AI service and no account: I work out what you mean on this PC, and look things up on AniList and your sources.'); r.chip('What can you do?'); return;
      case 'capabilities': r.add(CAN); r.chip('What should I read next?', 'My stats this month', 'Find a manhwa'); return;
      case 'smalltalk_joke': r.add(pick(JOKES, chat.msgs.length + hash(t))); r.chip('Another joke', 'What should I read next?'); return;
      case 'streak': return ansStreak(r);
      case 'wrapped': return ansWrapped(r);
      case 'continue_reading': {
        if (intent.arg === 'last') { const h = Object.values(K.data.history || {}).filter(visible).sort((a, b) => (b.at || 0) - (a.at || 0))[0]; if (h) { r.add(`Picking up **${h.title}** at ${h.chapterName || 'your last chapter'}.`); r.go = readRoute(h); return; } r.say('empty'); return; }
        const q = (t.match(/\bwhere (?:was|am|did) i (?:in|on|at|with|stop in)\s+(.+?)\??$|\bwhat chapter (?:am|was) i (?:on|at) in\s+(.+?)\??$|\bmy progress (?:in|on)\s+(.+?)\??$|\bwhich chapter of\s+(.+?)(?: was i on)?\??$|^(?:continue|resume)\s+(.+?)\??$/) || []).slice(1).find(Boolean) || t;
        if (ansWhereWas(r, q)) return;
        return find(r, ctx, q, say, true);
      }
      case 'my_stats': return ansStats(r, t);
      case 'my_history': return ansReading(r);
      case 'stopped_reading': return ansStopped(r);
      case 'whats_new': return ansNew(r);
      case 'my_genres': return ansGenres(r, say);
      case 'my_ratings': return ansRatings(r, t);
      case 'my_shelves': return ansShelves(r, t);
      case 'my_notes': return ansNotes(r);
      case 'my_library': return ansLibrary(r);
      case 'my_badges': { const b = Object.keys(stats().badges || {}).length; r.add(b ? `You've earned ${plural(b, 'badge')}. They're on the Stats page.` : 'No badges yet. Keep reading and they turn up.').act({ label: 'Open Stats', ic: 'chart', route: '/stats' }); return; }
      case 'app_help': { const h = intent.arg || helpFor(t); if (!h) break; r.add(h.a); if (h.act) r.act(h.act); r.chip('What else can you do?'); return; }
      case 'find_by_description': return find(r, ctx, raw, say);
      case 'find_title': return find(r, ctx, raw, say, true, intent.arg === 'guess' && !intent.net);
      case 'recommend': return recommend(r, ctx, t, say);
      case 'unknown': default: break;
    }
    // not sure: say so, and offer the best guess
    const own = resolveOwn(t);
    if (own) { r.add(`I'm not sure what you mean, but did you mean **${own.title}**?`); ansWhereWas(r, own.title); return; }
    if (conceptsIn(t).length) { r.add('I\'m not completely sure what you\'re after, so here\'s my best guess:'); return recommend(r, ctx, t, say, { intro: 'recsAsk' }); }
    r.say('unsure');
    r.chip('What should I read next?', 'What have I been reading?', 'How do I change the theme?', 'Find a manhwa');
  }

  // ---------- chats (this PC only) ----------
  const CHATS = 'koru-kitsu-chats';
  let chats = null, curId = null;
  const allChats = () => (chats ||= (ls.get(CHATS, []) || []).filter(c => c?.id && Array.isArray(c.msgs)));
  const saveChats = K.debounce(() => {
    const list = allChats().filter(c => c.msgs.length).sort((a, b) => (b.pinned - a.pinned) || (b.at - a.at)).slice(0, 60);
    for (const c of list) { if (c.msgs.length > 160) c.msgs = c.msgs.slice(-160); if (c.ctx?.last?.pool?.length > 30) c.ctx.last.pool = c.ctx.last.pool.slice(0, 30); }
    if (!ls.set(CHATS, list)) { for (const c of list) for (const m of c.msgs) for (const card of m.cards || []) card.desc = (card.desc || '').slice(0, 120); ls.set(CHATS, list); }
  }, 400);
  const autoTitle = t => { const s = String(t).replace(/\s+/g, ' ').trim().replace(/[?!.]+$/, ''); const x = s.length > 42 ? s.slice(0, 40).replace(/\s+\S*$/, '') + '…' : s; return x.charAt(0).toUpperCase() + x.slice(1); };
  const newChat = () => { const c = { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: 'New chat', at: Date.now(), pinned: false, msgs: [], ctx: {} }; allChats().unshift(c); curId = c.id; return c; };
  const curChat = () => allChats().find(c => c.id === curId) || null;

  // ---------- the avatar: Koru's own icon (img/icon.svg, the app icon), with a glow you can tint on the Bio page ----------
  function avatar(cls = '') {
    const s = S(), glow = FOX_COLORS[s.color] || FOX_COLORS.accent, c = cls ? '.' + cls : '';
    const face = s.avatar === 'emoji' ? el('span.ks-emo-i', { text: s.emoji || '🦊' }) : el('img.ks-logo', { src: 'img/icon.svg', alt: '', draggable: false });
    return el('span.ks-ava' + (s.avatar === 'emoji' ? '.ks-emo' : '') + c, { 'aria-hidden': 'true', style: { '--glow': glow } }, face, el('i.ks-shine'));
  }
  // while Kitsu answers, its icon "talks" (pulse ring, bob, shimmer); it settles once when the reply is done, then stays still
  function talk(ava, on) {
    if (!ava) return;
    if (on) { ava.classList.remove('ks-settle'); ava.classList.add('ks-talking'); return; }
    if (!ava.classList.contains('ks-talking')) return;
    ava.classList.remove('ks-talking'); void ava.offsetWidth; ava.classList.add('ks-settle');
    setTimeout(() => ava.classList.remove('ks-settle'), 900);
  }

  // ---------- drawing messages ----------
  // **bold** becomes <b>; every word is its own span so a streamed reply can reveal word by word
  function richText(text, wrapWords) {
    const box = el('div.ks-text');
    for (const ln of String(text || '').split('\n')) {
      const p = el('p');
      for (const [i, part] of ln.split(/(\*\*[^*]+\*\*)/).entries()) {
        if (!part) continue;
        const bold = i % 2 === 1, raw = bold ? part.slice(2, -2) : part;
        const target = bold ? el('b') : p;
        if (wrapWords) for (const w of raw.split(/(\s+)/)) { if (!w) continue; target.append(/^\s+$/.test(w) ? document.createTextNode(w) : el('span.ks-w', { text: w })); }
        else target.append(document.createTextNode(raw));
        if (bold) p.append(target);
      }
      box.append(p);
    }
    return box;
  }
  function cardNode(c, i, chatRef) {
    const open = () => c.go ? K.go(c.go) : c.kind === 'koru' ? K.go(seriesRoute(c.provider, c.slug)) : null;
    const cv = el('div.ks-cv', { onclick: c.kind === 'koru' || c.go ? open : null, title: c.kind === 'koru' ? 'Open ' + c.title : '' }, K.img(c.cover ? (c.kind === 'ani' ? c.cover : c.cover) : null, c.title, '', 72));
    if (c.newCount) cv.append(el('span.ks-newb', { text: String(Math.min(99, c.newCount)) }));
    const btns = el('div.ks-cbtns');
    if (c.go) btns.append(el('button.btn.small.primary', { onclick: open }, icon('play'), el('span', { text: c.goLabel || 'Open' })));
    else if (c.kind === 'koru') btns.append(el('button.btn.small', { onclick: open }, icon('book'), el('span', { text: 'Open' })));
    else { const b = el('button.btn.small.primary', { onclick: () => openInKoru(c, b) }, icon('book'), el('span', { text: 'Open in Koru' })); btns.append(b); }
    if (c.kind === 'ani') btns.append(el('button.btn.small', { title: 'More like this', onclick: () => chatRef.ask(`More like "${c.title}"`, { focus: c }) }, icon('sparkle'), el('span', { text: 'More like this' })));
    const desc = c.desc && lenOf() !== 'short' ? el('p.ks-desc', { text: c.desc.slice(0, lenOf() === 'detailed' ? 420 : 200) + (c.desc.length > (lenOf() === 'detailed' ? 420 : 200) ? '…' : '') }) : null;
    return el('div.ks-card.glass', { style: { '--i': i } }, cv,
      el('div.ks-cinfo', el('b.ks-ct', { text: c.title }), c.meta ? el('small.ks-cm', { text: c.meta }) : null,
        c.why ? richLine(voice(c.why, { key: 'why', last: false, bare: true }), 'ks-why') : null, desc, btns));
  }
  const richLine = (t, cls) => { const n = richText(t).firstChild || el('p'); n.className = cls; n.prepend(icon('sparkle')); return n; };
  function actNode(a, chatRef) {
    const run = () => {
      if (a.route) return K.go(a.route);
      if (a.set) return goSettings(a.set);
      if (a.run === 'checkUpdates') { K.toast('Checking your favourites…'); Promise.resolve(K.checkUpdates?.(true)).then(() => chatRef?.ask('What\'s new in my favourites?', { quiet: true })).catch(() => {}); return; }
      if (a.run === 'restoreStreak') { K.lively?.restoreStreak?.(); return; }
      if (a.run === 'quickJump') { K.quickJump?.(); return; }
      if (a.run === 'openBio') return chatRef?.pane('bio');
      if (a.run === 'openSettings') return chatRef?.pane('settings');
    };
    return el('button.btn.small.ks-act', { onclick: run }, icon(a.ic || 'next'), a.label);
  }
  function msgNode(m, chatRef, { animate = false, stream = false } = {}) {
    if (m.role === 'me') return el('div.ks-msg.ks-me' + (animate ? '.ks-in' : ''), el('div.ks-bub', richText(m.text)));
    const text = richText(m.text, stream);
    const body = el('div.ks-bub.glass', text);
    const node = el('div.ks-msg.ks-bot' + (animate ? '.ks-in' : ''), avatar('ks-ava-s'), el('div.ks-col', body));
    const extras = [];
    if (m.cards?.length) extras.push(el('div.ks-cards', m.cards.map((c, i) => cardNode(c, i, chatRef))));
    if (m.actions?.length) extras.push(el('div.ks-acts', m.actions.map(a => actNode(a, chatRef))));
    if (m.approve) extras.push(approveNode(m));
    node.lastChild.append(...extras);
    if (stream) { node.classList.add('ks-streaming'); extras.forEach(x => x.classList.add('ks-later')); }
    node._extras = extras; node._words = stream ? [...text.querySelectorAll('.ks-w')] : [];
    return node;
  }
  // reveal a streamed reply word by word (a short timer chain, not a per-frame loop); finishes in about 1.4s at most
  function streamIn(node, onStep, onDone) {
    const words = node._words || [], mode = S().stream;
    const per = { instant: 0, fast: 14, normal: 30, slow: 55 }[mode] ?? 14;
    const finish = () => { words.forEach(w => w.classList.add('on')); node.classList.remove('ks-streaming'); node._extras.forEach(x => x.classList.remove('ks-later')); onStep?.(); onDone?.(); };
    if (!per || !words.length || document.documentElement.classList.contains('no-anim')) { finish(); return () => {}; }
    const step = Math.max(1, Math.ceil(words.length * per / 1400 / Math.max(per, 1)) || 1);
    let i = 0, tm = 0, stopped = false;
    const tick = () => {
      if (stopped) return;
      if (!node.isConnected) { finish(); return; }
      for (let j = 0; j < step && i < words.length; j++) words[i++].classList.add('on');
      onStep?.();
      if (i < words.length) tm = setTimeout(tick, Math.min(per, 1400 / Math.max(1, words.length / step)));
      else finish();
    };
    tick();
    return () => { stopped = true; clearTimeout(tm); finish(); };
  }

  // ---------- voice typing ----------
  // Chromium's speech recognition sends audio to Google, which Electron builds can't use, so it's checked when you
  // first press the mic. Windows' own voice typing (Win+H) works in the box either way.
  const STT_KEY = 'koru-kitsu-stt';
  const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition;
  const sttState = () => { const v = ls.get(STT_KEY, null); return !SR() ? 'none' : v?.ua === navigator.userAgent ? v.state : 'unknown'; };
  function startVoice(ui) {
    const Rec = SR();
    if (!Rec || sttState() === 'broken') { ui.note(true); return null; }
    let stream = null, ac = null, timer = 0, rec = null, done = false, base = ui.input.value ? ui.input.value.replace(/\s*$/, ' ') : '';
    const stop = () => {
      if (done) return; done = true;
      clearInterval(timer); try { rec?.abort(); } catch {}
      stream?.getTracks().forEach(t => t.stop()); try { ac?.close(); } catch {}
      ui.recording(false);
    };
    ui.recording(true);
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (done) { stream.getTracks().forEach(t => t.stop()); return; }
        ac = new AudioContext(); ac.resume?.().catch(() => {});
        const an = ac.createAnalyser(); an.fftSize = 256;
        ac.createMediaStreamSource(stream).connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        timer = setInterval(() => {   // ~12 times a second while recording only
          an.getByteFrequencyData(buf);
          const n = ui.bars.length, seg = Math.floor(buf.length / 2 / n);
          ui.bars.forEach((b, i) => { let s = 0; for (let j = 0; j < seg; j++) s += buf[i * seg + j]; b.style.transform = `scaleY(${Math.max(0.15, Math.min(1, s / seg / 160)).toFixed(2)})`; });
        }, 85);
      } catch (e) { stop(); ui.note(false, /NotFound|DevicesNotFound/i.test(e?.name) ? 'No microphone found.' : 'Koru couldn\'t use the microphone.'); return; }
      try {
        rec = new Rec();
        rec.lang = S().micLang || 'en-US'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
        rec.onresult = e => { let txt = ''; for (const r of e.results) txt += r[0].transcript; ui.input.value = base + txt; ui.input.dispatchEvent(new Event('input')); if (e.results[e.results.length - 1].isFinal) ls.set(STT_KEY, { ua: navigator.userAgent, state: 'ok' }); };
        rec.onerror = e => {
          if (['network', 'service-not-allowed', 'language-not-supported'].includes(e.error)) { ls.set(STT_KEY, { ua: navigator.userAgent, state: 'broken' }); stop(); ui.note(true); }
          else if (e.error === 'not-allowed') { stop(); ui.note(false, 'Koru isn\'t allowed to use the microphone.'); }
          else if (e.error === 'no-speech') { stop(); K.toast('I didn\'t hear anything.'); }
          else if (e.error !== 'aborted') stop();
        };
        rec.onend = stop;
        rec.start();
      } catch { ls.set(STT_KEY, { ua: navigator.userAgent, state: 'broken' }); stop(); ui.note(true); }
    })();
    return stop;
  }

  // ---------- Kitsu's voice: the on-device model (electron/kitsu-llm.js) ----------
  // The built-in engine works out the answer and its facts; the model only words it, in Kitsu's personality.
  // Titles and numbers come from the facts (the cards are built from the same results), never from the model.
  const brain = { st: null, at: 0 };
  const autoDl = { tried: false };
  const brainHost = () => K.info?.platform === 'desktop';
  async function brainStatus(force) {
    if (!brainHost()) return null;
    if (!force && brain.st && Date.now() - brain.at < 2500) return brain.st;
    try { brain.st = await K.api.get('/k/kitsu/status'); brain.at = Date.now(); } catch { brain.st = null; }
    return brain.st;
  }
  const brainModel = () => (S().brain === 'fast' ? 'fast' : 'smart');
  const brainReady = () => !!(S().llm && brain.st?.runtime && brain.st.models?.[brainModel()]?.have);
  const SLOW_KEY = 'koru-kitsu-brain-slow';
  const brainSlow = () => Date.now() < (ls.get(SLOW_KEY, 0) || 0);
  const STYLE = { friendly: 'warm, upbeat and helpful', hype: 'loud and excited, full of energy, playful CAPS on a word or two', chill: 'laid-back and calm, few words, mostly lowercase',
    sarcastic: 'dry and teasing, sarcastic but always kind, and you always help in the end', formal: 'polite and precise, no contractions, no slang' };
  function systemPrompt() {
    const s = S(), pr = PRESETS[s.preset] || PRESETS.friendly, tr = talkRules(s.talk), me = aboutMe(s.about);
    const amt = tr.noEmoji ? 0 : tr.moreEmoji ? 2 : Number(s.emojiAmt ?? pr.emoji), slang = s.preset === 'formal' ? 0 : Number(s.slang ?? pr.slang);
    const len = { short: 'one short sentence', normal: 'one to three short sentences', detailed: 'up to five sentences' }[lenOf()] || 'one to three short sentences';
    return [`You are ${s.name || 'Kitsu'}, the reading assistant in Koru, a manhwa and manga reader app. Personality: ${STYLE[s.preset] || STYLE.friendly}. ${amt === 0 ? 'Never use emoji.' : amt === 1 ? 'At most one emoji.' : 'A few emoji.'} ${slang === 0 ? '' : slang === 1 ? 'A little casual slang.' : 'Lots of casual slang.'}`,
      me.name || tr.call ? `Call the user ${tr.call || me.name}.` : '',
      s.about ? `About the user: ${s.about.slice(0, 300)}` : '',
      s.talk ? `The user wants you to talk like this: ${s.talk.slice(0, 240)}` : '',
      `Write ${len}. Only use facts from FACTS. Never invent titles, numbers or plot details. Name at most two titles; cards show the rest. No lists. Put titles in **double asterisks**. If nothing was found, say so honestly.`
    ].filter(Boolean).join('\n');
  }
  function chatPrompt() {
    const s = S(), pr = PRESETS[s.preset] || PRESETS.friendly, tr = talkRules(s.talk), me = aboutMe(s.about);
    const amt = tr.noEmoji ? 0 : tr.moreEmoji ? 2 : Number(s.emojiAmt ?? pr.emoji), slang = s.preset === 'formal' ? 0 : Number(s.slang ?? pr.slang);
    const len = { short: 'one or two sentences', normal: 'one to four sentences', detailed: 'a short paragraph or two' }[lenOf()] || 'one to four sentences';
    return [`You are ${s.name || 'Kitsu'}, a friendly AI companion that lives inside Koru, a manhwa and manga reader app. Personality: ${STYLE[s.preset] || STYLE.friendly}. ${amt === 0 ? 'Never use emoji.' : amt === 1 ? 'At most one emoji.' : 'A few emoji.'} ${slang === 0 ? '' : slang === 1 ? 'A little casual slang.' : 'Lots of casual slang.'}`,
      'You are having a normal, relaxed conversation. Reply to what the user actually said, like a good friend would: be warm, curious and talkative, share opinions, joke around, and often ask a question back. You can talk about anything: their day, feelings, school, work, games, music, life, general knowledge.',
      'Slang greetings like "what is good", "what\'s good", "wsg", "wagwan", "sup" just mean "hey, what\'s up?": greet them back casually.',
      'Do NOT recommend series, mention their library, reading or the app unless the user brings it up. Never claim to know things about the user that they have not told you. If the user corrects you, apologise briefly and go along with what they meant.',
      me.name || tr.call ? `Call the user ${tr.call || me.name}.` : '',
      s.about ? `Background about the user (only to know them better; never use it to steer the chat to reading): ${s.about.slice(0, 300)}` : '',
      s.talk ? `The user wants you to talk like this: ${s.talk.slice(0, 240)}` : '',
      `Write ${len}. No lists or headings.`
    ].filter(Boolean).join('\n');
  }
  // the house rules the model sometimes forgets (no emoji, lowercase, sign-off), applied to its text
  function polish(text) {
    const s = S(), tr = talkRules(s.talk), amt = tr.noEmoji ? 0 : Number(s.emojiAmt ?? 1);
    let t = String(text || '').replace(/^\s*(?:assistant|kitsu)\s*:\s*/i, '').replace(/\n{3,}/g, '\n\n').trim();
    if (amt === 0) t = t.replace(EMOJI, '').replace(/ {2,}/g, ' ');
    if (tr.noExcl) t = t.replace(/!+/g, '.');
    if (tr.lower) t = t.toLowerCase();
    if (tr.sign && !t.toLowerCase().endsWith(tr.sign.toLowerCase())) t += '\n' + tr.sign;
    return t;
  }
  // lookups the model may ask for when the engine had nothing to go on; they run here, with the privacy rules
  const TOOLS = [
    { name: 'search_series', description: 'Search AniList and the user\'s sources for a series by title or description', params: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'reading_stats', description: 'The user\'s reading stats for a period like "this month" or "this week"', params: { type: 'object', properties: { period: { type: 'string' } } } },
    { name: 'recommend', description: 'Recommendations for the user, optionally for a genre or trope', params: { type: 'object', properties: { genre: { type: 'string' } } } }
  ];
  async function runTool(name, args, chat, cardsOut) {
    const r = Reply('tool', 1), ctx = chat.ctx ||= {};
    try {
      if (name === 'search_series') await find(r, ctx, String(args?.query || ''), () => {});
      else if (name === 'reading_stats') ansStats(r, lc(args?.period || 'this month'));
      else if (name === 'recommend') await recommend(r, ctx, lc(args?.genre ? 'recommend ' + args.genre : 'recommend'), () => {});
    } catch {}
    cardsOut.push(...r.cards);
    return factsOf(r).slice(0, 1500) || 'Nothing found.';
  }
  async function speak(msg, userText, chat, { onTok, signal, tools, talk }) {
    const hist = chat.msgs.slice(talk ? -13 : -7, -1).map(m => ({ role: m.role === 'me' ? 'user' : 'model', text: String(m.text || '').slice(0, talk ? 700 : 400) })).filter(h => h.text);
    const L = lenOf();
    const hint = CORRECT_RE.test(lc(userText)) ? '\n\n(They are telling you they were just greeting you or chatting, not asking for anything. Apologise in a few words, then just chat about them or their day. Do not mention reading.)' : '';
    const body = talk ? { model: brainModel(), system: chatPrompt(), history: hist, prompt: userText + hint, maxTokens: L === 'detailed' ? 380 : L === 'short' ? 110 : 230, temperature: 0.75, tools: [], fg: true }
      : { model: brainModel(), system: systemPrompt(), history: hist, prompt: `${userText}\n\nFACTS:\n${msg.facts || '- (no facts)'}`, maxTokens: L === 'detailed' ? 260 : L === 'short' ? 90 : 170, temperature: 0.45, tools: tools ? TOOLS : [], fg: document.visibilityState === 'visible' && /^#\/kitsu/.test(location.hash) };
    const res = await fetch('/k/kitsu/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!res.ok || !res.body) throw new Error('brain ' + res.status);
    const rd = res.body.getReader(), dec = new TextDecoder();
    let buf = '', text = '', stats = null;
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const lineTxt = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!lineTxt.trim()) continue;
        let m; try { m = JSON.parse(lineTxt); } catch { continue; }
        if (m.t === 'tok') { text += m.v; onTok(text); }
        else if (m.t === 'tool') {
          const extra = [];
          const result = await runTool(m.name, m.args, chat, extra);
          msg.cards = [...(msg.cards || []), ...extra].filter((c, j, l) => l.findIndex(x => x.id === c.id) === j).slice(0, cardCount());
          fetch('/k/kitsu/tool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: m.id, call: m.call, result }) }).catch(() => {});
        } else if (m.t === 'done') stats = m.stats;
        else if (m.t === 'err') throw new Error(m.msg);
      }
    }
    return { text, stats };
  }
  // the facts a reply is built on, plain (no persona wording), for the model
  const FACT_OF = { none: 'Nothing matched what they asked.', offline: 'AniList could not be reached right now.', empty: 'There is no reading data yet.', unsure: 'Kitsu did not understand the message.',
    hi: 'The user said hello.', thanks: 'The user said thanks.', bye: 'The user is leaving.', me: `You are ${'Kitsu'}, Koru's assistant; you run on this PC, read the library and stats, and look things up on AniList and the sources. No account or cloud AI.` };
  function factsOf(r) {
    const out = [];
    if (r.intents?.length) out.push('- What they asked for: ' + r.intents.join(', ').replace(/_/g, ' '));
    for (const l of r.lines) { if (!l.t) continue; if (l.tpl) { if (FACT_OF[l.k]) out.push('- ' + FACT_OF[l.k]); continue; } out.push('- ' + l.t.replace(/\*\*/g, '"')); }
    const one = r.keepCards === 1;
    r.cards.slice(0, Math.min(3, r.keepCards ?? cardCount())).forEach((c, i) => out.push(`- pick ${i + 1}: "${c.title}"${c.meta ? ', ' + lc(c.meta).replace(/ · /g, ', ') : ''}${c.why ? '; ' + c.why.replace(/\*\*/g, '"').slice(0, 110) : ''}${one && c.desc ? '; story: ' + c.desc.slice(0, 260) : ''}`));
    if (r.cards.length > 3) out.push(`- ${r.cards.length - 3} more picks shown as cards`);
    if (r.actions.length) out.push('- Buttons under the reply: ' + r.actions.map(a => a.label).join(', '));
    return out.join('\n');
  }

  // "Give Kitsu its brain": the one-time download card
  function brainCard(onReady) {
    const box = el('div.ks-brain.glass');
    let timer = 0;
    const mb = n => (n / 1048576).toFixed(n > 1e9 ? 0 : 1) + ' MB', gb = n => n > 1e9 ? (n / 1073741824).toFixed(1) + ' GB' : Math.round(n / 1048576) + ' MB';
    async function paint() {
      clearTimeout(timer);
      if (!box.isConnected && box._painted) return;
      box._painted = true;
      const st = await brainStatus(true);
      if (!st?.runtime) { box.remove(); return; }
      const id = brainModel(), m = st.models[id], d = st.dl;
      if (m.have && (!d || d.state === 'done' || d.id !== id)) { box.classList.add('ks-brain-done'); box.replaceChildren(avatar('ks-ava-b.ks-settle'), el('div.ks-btxt', el('b', { text: 'Kitsu\'s brain is ready' }), el('small.muted', { text: `${m.label} runs on this PC. Replies are now written by it.` }))); setTimeout(() => box.classList.add('ks-gone'), 2200); setTimeout(() => box.remove(), 2700); onReady?.(); return; }
      if (d && d.id === id && (d.state === 'downloading' || d.state === 'verifying')) {
        const p = d.total ? d.done / d.total : 0, eta = d.bps > 0 ? Math.round((d.total - d.done) / d.bps) : 0;
        box.replaceChildren(avatar('ks-ava-b.ks-talking'),
          el('div.ks-btxt', el('b', { text: d.state === 'verifying' ? 'Checking the download…' : 'Giving Kitsu its brain…' }),
            el('div.ks-bar', el('i', { style: { transform: `scaleX(${p.toFixed(4)})` } })),
            el('small.muted', { text: d.state === 'verifying' ? 'Making sure the file is complete and unchanged (SHA-256).' : `${Math.round(p * 100)}% · ${mb(d.done)} of ${gb(d.total)}${d.bps ? ' · ' + mb(d.bps) + '/s' : ''}${eta ? ' · about ' + (eta > 90 ? Math.round(eta / 60) + ' min' : eta + ' s') + ' left' : ''}` })),
          d.state === 'downloading' ? el('button.btn.small', { onclick: async () => { await K.api.post('/k/kitsu/download/cancel'); paint(); } }, icon('x'), 'Cancel') : null);
        timer = setTimeout(paint, 600);
        return;
      }
      if (Date.now() < (box._expect || 0)) { timer = setTimeout(paint, 500); }   // just started: the status catches up in a moment
      const other = id === 'smart' ? 'fast' : 'smart';
      box.replaceChildren(avatar('ks-ava-b'),
        el('div.ks-btxt', el('b', { text: 'Give Kitsu its brain' }),
          el('small.muted', { text: `A small AI model that runs on this PC, with no account or key, so Kitsu can chat in its own words. One download of ${gb(m.size)}, kept in Koru's data folder.` }),
          d?.state === 'failed' ? el('small.ks-err', { text: d.error || 'The download failed.' }) : d?.state === 'cancelled' && m.part ? el('small.muted', { text: `Paused at ${Math.round(m.part / m.size * 100)}%. It picks up where it stopped.` }) : null),
        el('div.ks-bbtns',
          el('button.btn.small.primary', { onclick: async () => { box._expect = Date.now() + 6000; await K.api.post('/k/kitsu/download', { model: id }); paint(); } }, icon('download'), m.part ? 'Resume' : `${m.name} · ${gb(m.size)}`),
          el('button.btn.small', { title: st.models[other].label, onclick: async () => { setS({ brain: other }); box._expect = Date.now() + 6000; await K.api.post('/k/kitsu/download', { model: other }); paint(); } }, `${st.models[other].name} · ${gb(st.models[other].size)}`),
          el('button.ks-ri', { title: 'Not now', 'aria-label': 'Not now', onclick: () => { ls.set('koru-kitsu-brain-later', Date.now()); box.classList.add('ks-gone'); setTimeout(() => box.remove(), 400); } }, icon('x'))));
    }
    paint();
    return box;
  }

  // ---------- the page ----------
  let busy = false;
  K.views = K.views || {};
  // ---------- the chat: the Kitsu page and the pop-up share it (same chats, same conversation) ----------
  const ib = (ic, label, fn, cls = '') => el('button.btn.icon.small.ks-pb' + cls, { type: 'button', title: label, 'aria-label': label, onclick: fn }, icon(ic));
  const ACT_INTENTS = new Set(['do_shelf', 'do_fav', 'do_rate', 'do_read', 'do_settings', 'where_was_i', 'settings_help', 'find_prompt']);
  function chatUI(root, { mode = 'page', alive = () => true, q0 = null, onExpand, onClose, onReply } = {}) {
    const pop = mode === 'pop';
    if (!curChat()) { const latest = allChats().filter(c => c.msgs.length).sort((a, b) => b.at - a.at)[0]; curId = latest && Date.now() - latest.at < 6 * H ? latest.id : null; }
    let paneOpen = null, stopStream = null, stopVoice = null;
    const page = el('div.ks-page' + (pop ? '.ks-popui' : ''));
    root.append(page);

    // side: chat history
    const search = el('input.txt.ks-search', { type: 'search', placeholder: 'Search chats', spellcheck: false });
    const list = el('div.ks-list');
    const side = el('aside.ks-side.glass',
      el('div.ks-side-h', el('button.btn.primary.ks-new', { onclick: () => { fresh(); closeSide(); } }, icon('plus'), 'New chat'),
        el('button.btn.icon.small.ks-side-x', { title: 'Close', 'aria-label': 'Close', onclick: () => closeSide() }, icon('x'))),
      search, list);
    const closeSide = () => page.classList.remove('side-open');
    search.addEventListener('input', () => paintList());
    function paintList() {
      const q = lc(search.value.trim());
      const items = allChats().filter(c => c.msgs.length && (!q || lc(c.title).includes(q) || c.msgs.some(m => lc(m.text).includes(q))))
        .sort((a, b) => (b.pinned - a.pinned) || (b.at - a.at));
      list.replaceChildren(...items.map((c, i) => chatRow(c, i)));
      if (!items.length) list.append(el('div.ks-none', { text: q ? 'No chats match.' : 'Your chats show up here.' }));
    }
    function chatRow(c, i) {
      const del = el('button.ks-ri', { title: 'Delete', 'aria-label': 'Delete chat', onclick: e => {
        e.stopPropagation();
        if (!del.classList.contains('sure')) { del.classList.add('sure'); del.title = 'Click again to delete'; setTimeout(() => del.isConnected && del.classList.remove('sure'), 2500); return; }
        chats = allChats().filter(x => x.id !== c.id); saveChats();
        if (curId === c.id) fresh(); else paintList();
      } }, icon('trash'));
      const row = el('div.ks-row' + (c.id === curId ? '.on' : '') + (c.pinned ? '.pinned' : ''), { style: { '--i': Math.min(i, 12) }, tabIndex: 0, onclick: () => { curId = c.id; paintChat(); paintList(); closeSide(); },
        onkeydown: e => { if (e.key === 'Enter') row.click(); } },
        c.pinned ? icon('pin', 'ks-pin') : null,
        el('div.ks-rt', el('b', { text: c.title }), el('small', { text: K.ago(c.at) })),
        el('div.ks-rbtns',
          el('button.ks-ri' + (c.pinned ? '.on' : ''), { title: c.pinned ? 'Unpin' : 'Pin', 'aria-label': 'Pin chat', onclick: e => { e.stopPropagation(); c.pinned = !c.pinned; saveChats(); paintList(); } }, icon('pin')),
          el('button.ks-ri', { title: 'Rename', 'aria-label': 'Rename chat', onclick: e => { e.stopPropagation(); rename(row, c); } }, icon('pencil')),
          del));
      return row;
    }
    function rename(row, c) {
      const inp = el('input.txt.ks-ren', { value: c.title, maxLength: 60 });
      const done = ok => { if (ok && inp.value.trim()) { c.title = inp.value.trim(); saveChats(); } paintList(); };
      inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
      inp.addEventListener('blur', () => done(true));
      inp.addEventListener('click', e => e.stopPropagation());
      row.querySelector('.ks-rt').replaceWith(inp); inp.focus(); inp.select();
    }

    // main: header, messages, composer
    const s0 = S();
    const title = el('div.ks-sub', { text: '' });
    const headAva = el('span.ks-head-ava');
    const tabs = pop ? null : el('div.ks-tabs',
      el('button.btn.small.ks-tab', { onclick: () => pane('bio'), dataset: { p: 'bio' } }, icon('pencil'), el('span', { text: 'Bio' })),
      el('button.btn.small.ks-tab', { onclick: () => pane('settings'), dataset: { p: 'settings' } }, icon('settings'), el('span', { text: 'Settings' })));
    const openSide = () => { page.classList.add('side-open'); paintList(); };
    const head = pop
      ? el('header.ks-top.ks-ptop', { title: 'Drag to move · double-click to put it back' },
        ib('list', 'Chats', openSide, '.ks-side-btn'), headAva, el('div.ks-name', el('h1', { text: s0.name || 'Kitsu' }), title), el('div.sp'),
        ib('plus', 'New chat', () => fresh()), ib('external', 'Open the full Kitsu page', () => onExpand?.()), ib('x', 'Close (Esc)', () => onClose?.()))
      : el('header.ks-top',
        el('button.btn.icon.small.ks-side-btn', { title: 'Chats', 'aria-label': 'Chats', onclick: openSide }, icon('list')),
        headAva, el('div.ks-name', el('h1', { text: s0.name || 'Kitsu' }), title), el('div.sp'), tabs,
        el('button.btn.small.ks-newtop', { title: 'New chat', onclick: () => fresh() }, icon('plus'), el('span', { text: 'New chat' })));
    const msgs = el('div.ks-msgs', { role: 'log', 'aria-live': 'polite' });
    const scroller = el('div.ks-scroll', msgs);
    const chips = el('div.ks-chips');
    const input = el('textarea.ks-input', { rows: 1, placeholder: `Ask ${s0.name || 'Kitsu'} anything…`, spellcheck: true, maxLength: 600 });
    const bars = Array.from({ length: 5 }, () => el('i'));
    const level = el('span.ks-level', bars);
    const mic = el('button.ks-mic', { type: 'button', title: 'Voice typing', 'aria-label': 'Voice typing' }, icon('mic'), el('span.ks-ring'));
    const sendB = el('button.ks-send', { type: 'submit', title: 'Send', 'aria-label': 'Send' }, icon('send'));
    const note = el('div.ks-note', { hidden: true });
    const form = el('form.ks-compose.glass', { onsubmit: e => { e.preventDefault(); ask(input.value); } }, input, level, mic, sendB);
    const paneBox = el('div.ks-pane');
    const foot = el('div.ks-foot', chips, note, form);
    const body = el('div.ks-body', scroller, foot, paneBox);
    const main = el('section.ks-main', head, body);
    page.append(side, main, el('div.ks-scrim', { onclick: () => closeSide() }));

    const paintHead = () => { const s = S(); headAva.replaceChildren(avatar('ks-ava-m')); head.querySelector('h1').textContent = s.name || 'Kitsu'; input.placeholder = `Ask ${s.name || 'Kitsu'} anything…`; };
    const status = t => { title.textContent = t; };
    const idle = () => status(pop ? (brainReady() ? 'On-device brain · ' : 'Runs on this PC · ') + (isDroid() ? 'tap a chip or ask' : 'Esc closes')
      : (brainReady() ? `${PRESETS[S().preset]?.name || 'Friendly'} · on-device brain (${brain.st.models[brainModel()].name})` : 'Runs on this PC') + ' · reads your library' + (aniOK() ? ' · asks AniList and your sources' : ' and your sources'));
    paintHead(); idle();
    loadNet();
    // the on-device model: kept warm while Kitsu is in front, closed a few minutes after; the download is offered on the page, once
    let warmAt = 0;
    const warm = () => { if (!brainReady() || Date.now() - warmAt < 30e3) return; warmAt = Date.now(); K.api.post('/k/kitsu/warm', { model: brainModel(), system: systemPrompt() }).catch(() => {}); };
    brainStatus(true).then(async st => {
      if (!page.isConnected || !st?.runtime || !S().llm) return;
      idle();
      if (st.models[brainModel()]?.have) { warm(); return; }
      const busyDl = st.dl?.state === 'downloading' || st.dl?.state === 'verifying';
      if (!busyDl && !autoDl.tried && !(st.dl?.state === 'cancelled')) { autoDl.tried = true; await K.api.post('/k/kitsu/download', { model: brainModel() }).catch(() => {}); await brainStatus(true); }
      if (!pop) { foot.prepend(brainCard(() => { brainStatus(true).then(() => { idle(); warmAt = 0; warm(); }); })); return; }
      // the pop-up: progress in the status line, then the voice switches on by itself
      const tick = setInterval(async () => {
        if (!page.isConnected) { clearInterval(tick); return; }
        const s2 = await brainStatus(true), d = s2?.dl;
        if (s2?.models?.[brainModel()]?.have) { clearInterval(tick); idle(); warmAt = 0; warm(); return; }
        if (busy) return;
        if (d?.state === 'downloading') status(`Getting my AI voice · ${Math.round(d.done / (d.total || 1) * 100)}%`);
        else if (d?.state === 'verifying') status('Checking my AI voice…');
        else { clearInterval(tick); idle(); }
      }, 2000);
    });
    if (!pop) {
      const warmT = setInterval(() => { if (page.isConnected && document.visibilityState === 'visible') { warmAt = 0; warm(); } }, 60e3);
      const leave = () => { if (page.isConnected && /^#\/kitsu/.test(location.hash)) return; window.removeEventListener('hashchange', leave); clearInterval(warmT); if (brainReady()) K.api.post('/k/kitsu/idle').catch(() => {}); };
      window.addEventListener('hashchange', leave);
    } else input.addEventListener('focus', warm);

    // voice: shown only where it can work; the note explains otherwise
    const ui = {
      input, bars,
      recording(on) { form.classList.toggle('rec', on); mic.classList.toggle('on', on); mic.title = on ? 'Stop' : 'Voice typing'; if (!on) bars.forEach(b => { b.style.transform = ''; }); if (!on) stopVoice = null; },
      note(broken, msg) {
        note.hidden = false;
        note.replaceChildren(icon('mic'), el('span', { text: msg || (K.info?.platform === 'desktop'
          ? 'Voice typing needs Google\'s online speech service, which Koru can\'t use, so the mic is hidden. Windows voice typing works here: press Win+H.'
          : 'Voice typing isn\'t available on this device, so the mic is hidden.') }), el('button.ks-ri', { title: 'Hide', 'aria-label': 'Hide note', onclick: () => { note.hidden = true; } }, icon('x')));
        if (broken) mic.hidden = true;
      }
    };
    mic.hidden = sttState() === 'none' || sttState() === 'broken';
    mic.onclick = () => { if (stopVoice) { stopVoice(); return; } stopVoice = startVoice(ui); };

    // composer
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(pop ? 110 : 140, input.scrollHeight) + 'px'; sendB.classList.toggle('ready', !!input.value.trim()); };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); } });

    const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
    const toBottom = (smooth) => scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    const STARTERS = [['sparkle', 'What should I read next?'], ['clock', 'What have I been reading?'], ['chart', 'How many chapters this month?'],
      ['search', 'The one where a guy regresses and becomes a blacksmith'], ['heart', 'What\'s new in my favourites?'], ['palette', 'How do I change the theme?']];
    function welcome() {
      const s = S();
      if (pop) return el('div.ks-hello.ks-hello-p', avatar('ks-ava-p'),
        el('h2', { text: voice(line('hi', {}, new Date().getDate()), { key: 'hi', last: false }) }),
        el('p.muted', { text: 'Talk to me about anything. When you want, I can help with your reading, this page or Koru too.' }));
      return el('div.ks-hello',
        avatar('ks-ava-l'),
        el('h2', { text: voice(line('hi', {}, new Date().getDate()), { key: 'hi', last: false }) }),
        el('p.muted', { text: `I'm ${s.name || 'Kitsu'}. I know your library, history, ratings and stats, suggest what to read, find a series from a description and help with Koru. I run on this PC, with no AI service.` }),
        el('div.ks-starters', STARTERS.map(([ic, q], i) => el('button.ks-starter.glass', { style: { '--i': i }, onclick: () => ask(q) }, icon(ic), el('span', { text: q })))));
    }
    // chips: a question, or [label, question, options]; the pop-up fills an empty row with ones for the page you're on
    const chipOf = (c, i) => { const [label, q, o] = Array.isArray(c) ? c : [c, c]; return el('button.chip.ks-chip' + (o?.here ? '.ks-here' : ''), { style: { '--i': i }, onclick: () => ask(q, o || {}) }, label); };
    let lastChips = [], chipsAt = 0;
    // the pop-up: a reply's own chips until you move to another page, then ones for that page
    function paintChips(list, at = Date.now()) {
      lastChips = list || []; chipsAt = at;
      const show = pop && (!lastChips.length || chipsAt < Pop.pageAt) ? hereChips() : lastChips;
      chips.replaceChildren(...show.map(chipOf));
    }
    function paintChat() {
      stopStream?.();
      const c = curChat();
      msgs.replaceChildren();
      if (!c || !c.msgs.length) { msgs.append(welcome()); paintChips([]); return; }
      msgs.append(...c.msgs.map(m => msgNode(m, api)));
      const lastBot = [...c.msgs].reverse().find(m => m.role === 'bot');
      paintChips(lastBot?.chips, lastBot?.at || 0);
      requestAnimationFrame(() => toBottom(false));
    }
    function fresh() { stopStream?.(); curId = null; paintChat(); paintList(); input.focus(); }

    async function ask(text, opts = {}) {
      text = String(text || '').trim();
      if (!text || busy) return;
      if (stopVoice) stopVoice();
      busy = true; form.classList.add('busy');
      if (paneOpen) pane(null);
      let c = curChat();
      if (!c) { c = newChat(); msgs.replaceChildren(); }
      c.ctx ||= {};
      if (opts.focus) c.ctx.focus = opts.focus;
      const me = { role: 'me', text, at: Date.now() };
      if (!opts.quiet) { c.msgs.push(me); msgs.append(msgNode(me, api, { animate: true })); }
      if (c.title === 'New chat') c.title = autoTitle(text);
      c.at = Date.now();
      input.value = ''; grow(); chips.replaceChildren();
      toBottom(true);
      const headA = headAva.firstChild; talk(headA, true);
      const typing = el('div.ks-msg.ks-bot.ks-in.ks-typing', avatar('ks-ava-s.ks-talking'), el('div.ks-bub.glass', el('span.ks-dots', el('i'), el('i'), el('i')), el('small.ks-doing')));
      msgs.append(typing); toBottom(true);
      const say = t => { const d = typing.querySelector('.ks-doing'); if (d) d.textContent = t; status(t); };
      const t0 = performance.now();
      // the page you're on: a series page makes "this" mean that series
      if (pop || opts.here) { try { await hereInto(c.ctx, opts.here); } catch {} }
      let reply, rb = null;
      try {
        rb = await answer(text, c, say);
        reply = rb.done();
      } catch (e) {
        reply = Reply('err').add('Something went wrong on my side: ' + (e?.message || 'unknown error') + '. Try again?').done();
      }
      const facts = reply.facts; delete reply.facts;
      reply.ms = Math.round(performance.now() - t0);
      let live = null;
      // Kitsu's own words, from the on-device model; the engine's reply is the fallback (and shows if it's slow to start)
      const DATA = new Set(['my_stats', 'streak', 'my_history', 'stopped_reading', 'whats_new', 'continue_reading', 'my_genres', 'my_ratings', 'my_shelves', 'my_notes', 'my_library', 'my_badges', 'wrapped', 'app_help', 'open_item', 'item_status']);
      const acting = (rb?.intents || []).some(i => ACT_INTENTS.has(i)) || !!reply.approve;
      const chatty = !acting && (S().brainFor !== 'chat' || !(rb?.intents || []).every(i => DATA.has(i)));
      if (brainReady() && !brainSlow() && chatty && rb && !opts.quiet && alive() && curId === c.id) {
        say('Writing…');
        const ctrl = new AbortController();
        let first = 0, box = null;
        let slow = false;
        const cold = brain.st?.loaded !== brainModel();
        const giveUp = setTimeout(() => { if (!first) { slow = !cold; ctrl.abort(); } }, cold ? 25000 : brainModel() === 'fast' ? 6000 : 9000);
        live = msgNode({ ...reply, text: '' }, api, { animate: true }); live.classList.add('ks-live');
        box = live.querySelector('.ks-text'); box.append(el('span.ks-dots', el('i'), el('i'), el('i')));
        talk(live.querySelector('.ks-ava'), true);
        typing.replaceWith(live); if (nearBottom()) toBottom(true);
        try {
          reply.facts = facts;
          const talkMode = (rb.intents || []).length > 0 && rb.intents.every(i => i === 'chat' || i === 'smalltalk_greeting' || i === 'smalltalk_thanks' || i === 'smalltalk_bye' || i === 'smalltalk_joke' || i === 'about_kitsu');
          const res = await speak(reply, text, c, { signal: ctrl.signal, talk: talkMode, tools: (rb.intents || []).every(i => i === 'unknown'), onTok: t => {
            if (!first) { first = performance.now(); reply.ttft = Math.round(first - t0); }
            const nb = richText(polish(t)); nb.classList.add('ks-caret'); box.replaceWith(nb); box = nb;
            if (nearBottom()) scroller.scrollTop = scroller.scrollHeight;
          } });
          delete reply.facts;
          if (res.text.trim()) { reply.text = polish(res.text); reply.voiced = true; reply.tps = res.stats?.tps; }
          else if (live && !first) { live.remove(); live = null; }
        } catch { if (live && !first) { live.replaceWith(typing); live = null; } }
        delete reply.facts;
        clearTimeout(giveUp);
        if (cold) brainStatus(true);
        if (slow || (reply.tps && reply.tps < 2.5)) { ls.set(SLOW_KEY, Date.now() + 10 * 60e3); note.hidden = false; note.replaceChildren(icon('sparkle'), el('span', { text: 'Kitsu’s brain is slow on this PC right now, so Kitsu answers with its quick replies for a while.' }), el('button.ks-ri', { title: 'Hide', 'aria-label': 'Hide note', onclick: () => { note.hidden = true; } }, icon('x'))); }
      }
      // going somewhere is free (no approval); changing your data waits for a Yes
      if (rb?.open) setTimeout(() => openInKoru(rb.open, null), 350);
      if (rb?.go) setTimeout(() => K.go(rb.go), 350);
      if (rb?.setSec) setTimeout(() => goSettings(rb.setSec), 350);
      const wait = live || S().stream === 'instant' ? 0 : Math.max(0, 90 - (performance.now() - t0));
      if (wait) await new Promise(res => setTimeout(res, wait));
      c.msgs.push(reply); c.at = Date.now(); saveChats();
      busy = false; form.classList.remove('busy'); idle();
      if (!alive() || curId !== c.id) { typing.remove(); talk(headA, false); onReply?.(); return; }
      if (live) {
        const done = msgNode(reply, api, {}); done.classList.add('ks-settle');
        live.replaceWith(done);
        const da = done.querySelector('.ks-ava'); talk(da, true); talk(da, false); talk(headA, false);
        if (nearBottom()) toBottom(true);
        paintChips(reply.chips); paintList(); onReply?.();
        return;
      }
      const node = msgNode(reply, api, { animate: true, stream: true });
      typing.replaceWith(node);
      const na = node.querySelector('.ks-ava'); talk(na, true);
      stopStream = streamIn(node, () => { scroller.scrollTop = scroller.scrollHeight; }, () => { stopStream = null; scroller.scrollTop = scroller.scrollHeight; talk(na, false); talk(headA, false); paintChips(reply.chips); paintList(); onReply?.(); });
    }

    // the Settings and Bio panes slide over the chat (the pop-up opens them on the full page)
    function pane(which) {
      if (pop) { if (which) { try { sessionStorage.setItem('koru-kitsu-pane', which); } catch {} onExpand?.(); } return; }
      if (which && paneOpen === which) which = null;
      paneOpen = which;
      tabs.querySelectorAll('.ks-tab').forEach(b => b.classList.toggle('on', b.dataset.p === which));
      if (!which) { body.classList.remove('pane-on'); setTimeout(() => { if (!paneOpen) paneBox.replaceChildren(); }, 360); input.focus({ preventScroll: true }); return; }
      paneBox.replaceChildren(which === 'bio' ? bioPane(() => { paintHead(); idle(); }) : settingsPane(() => { paintChat(); paintList(); }));
      body.classList.add('pane-on');
      paneBox.scrollTop = 0;
    }
    const api = {
      ask, pane, fresh, input, page, closeSide, sideOpen: () => page.classList.contains('side-open'),
      paint() { paintHead(); idle(); paintChat(); paintList(); },
      chips() { if (!busy) paintChips(lastChips, chipsAt); },
      paneOpen: () => paneOpen
    };
    if (!pop) K.kitsu._live = api;

    paintChat(); paintList();
    if (!pop) {
      document.addEventListener('keydown', function esc(e) {
        if (!page.isConnected) { document.removeEventListener('keydown', esc); return; }
        if (e.key === 'Escape' && paneOpen) pane(null);
      });
      let p0 = null; try { p0 = sessionStorage.getItem('koru-kitsu-pane'); sessionStorage.removeItem('koru-kitsu-pane'); } catch {}
      if (p0 === 'bio' || p0 === 'settings') pane(p0);
      if (q0) ask(q0); else setTimeout(() => { if (page.isConnected && !paneOpen) input.focus({ preventScroll: true }); }, 200);
    }
    return api;
  }

  K.views.kitsu = async function (root, r, alive) {
    const q0 = r.query.get('q');
    if (q0) history.replaceState(null, '', '#/kitsu');
    Pop.hideForPage();
    chatUI(root, { mode: 'page', alive, q0 });
  };

  // ---------- what's on screen: page-aware chips and "this" on a series page ----------
  const routeName = () => (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'library');
  function hereSeries() {
    const m = location.hash.match(/^#\/(?:series|read)\/([^/?]+)\/([^/?]+)/);
    return m ? { provider: decodeURIComponent(m[1]), slug: decodeURIComponent(m[2]) } : null;
  }
  async function hereFocus() {
    const h = hereSeries();
    if (!h) return null;
    const key = K.key(h.provider, h.slug);
    let s = null;
    try { s = await withTimeout(K.getSeries(h.provider, h.slug), 2500); } catch {}
    const base = s || K.data.library?.[key] || K.data.history?.[key] || K.data.notes?.[key] || { title: h.slug };
    const c = koruCard({ ...base, provider: h.provider, slug: h.slug });
    if (s) { c.desc = String(s.description || '').trim(); if (s.status) c.status = s.status; c.genres = (s.tags || []).slice(0, 8); }
    c.here = true;
    return c;
  }
  // only the pop-up passes the page along; a new series page (or a chip for it) makes it the one "this" means
  async function hereInto(ctx, force) {
    const h = hereSeries();
    ctx.hereNow = h ? 'k:' + K.key(h.provider, h.slug) : null;
    if (!h || (!force && ctx.hereKey === ctx.hereNow)) return;
    const c = await hereFocus();
    if (c) { ctx.focus = c; ctx.hereKey = c.id; }
  }
  function hereChips() {
    const n = routeName();
    if (n === 'series') return [['Tell me about this', 'Tell me about this', { here: true }], ['Is it finished?', 'Is it finished?', { here: true }], ['Similar series', 'More like this', { here: true }],
      ['Add to a shelf', 'Add this to a shelf', { here: true }], ['Where was I?', 'Where was I?', { here: true }]];
    if (n === 'library') return ['What should I read next?', 'What\'s new in my favourites?', 'What did I stop reading?'];
    if (n === 'explore' || n === 'search') return [['Find one from a description', 'Find one from a description'], 'What should I read next?'];
    if (n === 'stats' || n === 'wrapped') return [['Sum up my month', 'My stats this month'], 'My top genres', 'What\'s my streak?'];
    if (n === 'settings') return [['Help me change something', 'Help me change something'], 'How do I change the theme?'];
    if (n === 'downloads' || n === 'local') return ['What have I been reading?', 'What should I read next?'];
    return ['What should I read next?', 'What have I been reading?'];
  }

  // ---------- acting on the app: going somewhere is free, changing your data asks first ----------
  const SET_SECTIONS = [['kitsu', /\bkitsu\b|\bassistant\b|\bpop-?up\b/], ['look', /appearance|\blooks?\b|theme|colou?rs?|wallpaper|glass|\bstyle\b|motion|sidebar|font|text size/],
    ['read', /\bread(?:ing|er)\b|\bpages?\b|scroll|night filter|ambient/], ['library', /library|sync|backup|import|export|\bdata\b|privacy/], ['pc', /windows|taskbar|desktop|widget|now playing/],
    ['speed', /performance|graphics|speed|smooth|\bfps\b|lag/], ['music', /music|glasswave|songs?/], ['about', /\babout\b|version|updates?/]];
  const SET_NAMES = { kitsu: 'Kitsu', look: 'Appearance', read: 'Reading', library: 'Library & sync', pc: 'Windows', speed: 'Performance', music: 'Music', about: 'About' };
  const sectionIn = t => SET_SECTIONS.find(([, re]) => re.test(t))?.[0] || null;
  function goSettings(id) {
    try { localStorage.setItem('koru-set-section', id); } catch {}
    // Settings remembers its section when it loads, so pick it with its own side menu once the page is up
    const pickSec = (n = 0) => {
      const b = [...document.querySelectorAll('.set-nav-btn')].find(x => lc(x.textContent).trim().startsWith(lc(SET_NAMES[id] || id)));
      if (b) { if (!b.classList.contains('on')) b.click(); return; }
      if (n < 20) setTimeout(() => pickSec(n + 1), 100);
    };
    if (routeName() !== 'settings') K.go('/settings');
    pickSec();
  }
  const ITSELF = /^(?:it|this|that|this one|that one|this series|this manhwa|this manga|the series|this page)$/;
  // the series a request is about: a name you gave, else the one we're talking about (or the page you're on)
  function targetOf(name, ctx) {
    name = String(name || '').replace(/^(?:the series |the manhwa )/, '').trim();
    if (name && !ITSELF.test(name)) {
      const own = resolveOwn(name);
      if (own) return { kind: 'koru', provider: own.provider, slug: own.slug, title: own.title || own.slug, cover: own.cover || null };
      const c = (ctx.last?.pool || []).find(x => norm(x.title) === norm(name));
      return c ? (c.kind === 'koru' ? c : { ani: c }) : { missing: name };
    }
    const f = ctx.focus || null;
    return !f ? null : f.kind === 'koru' ? f : { ani: f };
  }
  const notInKoru = (r, t) => { r.add(t.missing ? `I can't find **${t.missing}** in your Koru.` : `**${t.ani.title}** isn't in Koru yet. Open it in Koru first, then ask me again.`); if (t.ani) r.card(t.ani); };
  const metaOf = c => ({ provider: c.provider, slug: c.slug, title: c.title, cover: c.cover || null });
  function shelfAsk(t) {
    const m = t.match(/^(?:please |pls |can you |could you |kitsu )?(?:add|put|save|stick|move|place|file|throw)\b\s*(.*?)\s*\b(?:to|on|onto|in|into)\b\s+(.+?)(?: please)?\??$/);
    if (!m) return null;
    const what = m[1].trim(), dest = m[2].trim();
    let shelf = (dest.match(/shel(?:f|ves)\s+(?:called|named)\s+"?(.+?)"?$/) || [])[1] || (dest.match(/^(?:my |the |a |an )?(?:new )?"?(.+?)"?\s+shel(?:f|ves)$/) || [])[1] || null;
    if (!shelf && !/\bshel(?:f|ves)\b/.test(dest)) shelf = dest.replace(/^(?:my |the )/, '');
    if (shelf && /^(?:a|an|one|some|my|the|new|another|one of my|any)$/.test(shelf)) shelf = null;
    return { what, shelf, neu: /\bnew\b/.test(dest) };
  }
  function shelfCase(name, raw) {
    const have = (K.libx?.shelfNames?.() || []).find(n => lc(n) === lc(name));
    if (have) return have;
    const i = lc(raw).indexOf(lc(name));
    const s = i >= 0 ? raw.slice(i, i + name.length) : name;
    return s === lc(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }
  async function firstChapter(c) {
    try {
      const list = await withTimeout(K.getChapters(c.provider, c.slug), 9000);
      const open = (list || []).filter(x => !x.locked);
      if (!open.length) return null;
      const num = open.filter(x => x.number != null);
      return num.length ? num.reduce((a, b) => (b.number < a.number ? b : a)) : open.at(-1);
    } catch { return null; }
  }
  async function actOn(r, intent, t, raw, ctx) {
    const nm = S().name || 'Kitsu';
    switch (intent.intent) {
      case 'do_shelf': {
        const q = shelfAsk(t) || { what: (t.match(/^(?:add|put|save)\s+(.+?)\s+to\b/) || [])[1] || '', shelf: null };
        const c = targetOf(q.what, ctx);
        if (!c) { r.add('Add which series? Open one, or name it: "add Solo Leveling to my Reading shelf".'); return; }
        if (c.ani || c.missing) return notInKoru(r, c);
        const names = K.libx?.shelfNames?.() || [];
        const on = new Set(K.libx?.noteOf?.(c.provider, c.slug)?.shelves || []);
        if (!q.shelf) {
          const free = names.filter(n => !on.has(n));
          r.add(free.length ? `Which shelf should **${c.title}** go on?` : `You don't have a shelf for it yet. Want a new one? Say "add it to a new shelf called Favourites".`);
          if (on.size) r.detail(`It's already on ${[...on].join(', ')}.`);
          r.chip(...free.slice(0, 4).map(n => [n, `Add it to my ${n} shelf`, { focus: c }]), free.length ? ['New shelf…', 'Add it to a new shelf called To read', { focus: c }] : null);
          ctx.focus = c;
          return;
        }
        const shelf = shelfCase(q.shelf, raw);
        if (on.has(shelf)) { r.add(`**${c.title}** is already on your **${shelf}** shelf.`); return; }
        const isNew = !names.some(n => lc(n) === lc(shelf));
        ctx.focus = c;
        r.add(`Sure. I'll ask first, since this changes your library.`);
        r.approve({ kind: 'shelf', ...metaOf(c), shelf, label: `add **${c.title}** to ${isNew ? 'a new shelf called' : 'your'} **${shelf}**${isNew ? '' : ' shelf'}` });
        return;
      }
      case 'do_fav': {
        const m = t.match(/^(?:please |can you |could you )?(?:add|put|save)\s+(.*?)\s*\b(?:to|in|into)\b/) || t.match(/^(?:favou?rite|heart|fav)\s+(.+?)\??$/) || [];
        const c = targetOf(m[1] || '', ctx);
        if (!c) { r.add('Which series? Open one, or name it: "add Solo Leveling to my favourites".'); return; }
        if (c.ani || c.missing) return notInKoru(r, c);
        if (K.data.library?.[K.key(c.provider, c.slug)]) { r.add(`**${c.title}** is already in your favourites.`); return; }
        ctx.focus = c;
        r.add('I\'ll ask first, since this changes your library.');
        r.approve({ kind: 'fav', ...metaOf(c), label: `add **${c.title}** to your favourites` });
        return;
      }
      case 'do_rate': {
        const m = t.match(/^(?:please )?(?:rate|give)\s+(.*?)\s*(\d)(?:\s*(?:\/|out of)\s*5)?\s*(?:stars?|★)?(?: please)?\??$/) || [];
        const stars = Math.max(0, Math.min(5, Number(m[2]) || 0));
        const c = targetOf(m[1] || '', ctx);
        if (!c) { r.add('Rate which series? Say "rate Solo Leveling 5 stars".'); return; }
        if (c.ani || c.missing) return notInKoru(r, c);
        if (!stars) { r.add('Give me a number of stars, from 1 to 5.'); return; }
        ctx.focus = c;
        r.approve({ kind: 'rate', ...metaOf(c), stars, label: `rate **${c.title}** ${stars}★` });
        r.add('Just checking first.');
        return;
      }
      case 'do_read': {
        const m = t.match(/^(?:please )?(?:start|begin|resume|continue|keep) reading\s*(.*?)\??$/) || t.match(/^(?:read|start)\s+(it|this|that)(?: one)?(?: now)?\??$/) || [];
        const what = String(m[1] || '').replace(/\s*(?:please|now|again)$/, '').trim();
        const c = targetOf(what, ctx);
        if (!c) { r.add('Read which one? Open a series, or name it.'); return; }
        if (c.missing) return notInKoru(r, c);
        if (c.ani) { r.add(`Opening **${c.ani.title}** in Koru…`); r.open = c.ani; return; }
        const h = K.data.history?.[K.key(c.provider, c.slug)];
        if (h) { r.add(`Picking up **${h.title || c.title}** at ${h.chapterName || 'your last chapter'}.`); r.go = readRoute(h); return; }
        const first = await firstChapter(c);
        if (first) { r.add(`Starting **${c.title}** from ${first.name || 'the first chapter'}.`); r.go = `/read/${c.provider}/${encodeURIComponent(c.slug)}/${encodeURIComponent(first.slug)}`; return; }
        r.add(`Opening **${c.title}**. Pick a chapter to start.`); r.go = seriesRoute(c.provider, c.slug);
        return;
      }
      case 'where_was_i': {
        const f = ctx.focus?.kind === 'koru' && (ctx.hereNow ? ctx.focus.id === ctx.hereNow : true) ? ctx.focus : null;
        if (f) { if (!ansWhereWas(r, null, f)) r.add(`You haven't started **${f.title}** yet.`); r.chip('Start reading it'); return; }
        const h = Object.values(K.data.history || {}).filter(visible).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
        if (h && ansWhereWas(r, null, h)) return;
        r.say('empty');
        return;
      }
      case 'do_settings': {
        const id = sectionIn(t);
        if (!id) return actOn(r, { intent: 'settings_help' }, t, raw, ctx);
        r.add(`Opening **${SET_NAMES[id]}** in Settings.`);
        r.setSec = id;
        return;
      }
      case 'settings_help': {
        r.add('Sure. Which part? Pick one, or tell me what you want, like "make the text bigger" or "turn on sync".');
        r.chip('Open Appearance settings', 'Open Reading settings', 'Open Library & sync settings', 'How do I change the theme?', `Open ${nm} settings`);
        return;
      }
      case 'find_prompt': {
        ctx.awaitFind = true;
        r.add('Tell me what you remember: the story, a character, a scene, the art, even half the title. Like "a guy regresses and becomes a blacksmith".');
        return;
      }
    }
  }
  function runApproved(a) {
    const meta = { provider: a.provider, slug: a.slug, title: a.title, cover: a.cover || null }, key = K.key(a.provider, a.slug);
    let msg = 'Done.';
    if (a.kind === 'shelf') {
      if (!K.libx?.addShelf) throw new Error('shelves aren\'t ready');
      const name = K.libx.addShelf(a.shelf);
      if (!name) throw new Error('that shelf name doesn\'t work');
      K.libx.toggleShelf(meta, name, true);
      msg = `Done. **${a.title}** is on your **${name}** shelf.`;
    } else if (a.kind === 'fav') {
      if (!K.data.library[key]) { K.data.library[key] = { ...meta, addedAt: Date.now(), newCount: 0, checkedAt: Date.now() }; K.save('library'); }
      const heart = hereSeries() && K.key(hereSeries().provider, hereSeries().slug) === key ? document.querySelector('.view .btn.heart') : null;
      if (heart) { heart.classList.add('on'); if (heart.lastChild) heart.lastChild.textContent = 'In library'; }
      msg = `Done. **${a.title}** is in your favourites.`;
    } else if (a.kind === 'rate') {
      if (!K.libx?.setRating) throw new Error('ratings aren\'t ready');
      K.libx.setRating(meta, a.stars);
      msg = `Done. You rated **${a.title}** ${a.stars}★.`;
    }
    document.dispatchEvent(new CustomEvent('koru-library'));
    return msg;
  }

  // ---------- the approval card: "Kitsu wants to …" Yes / No ----------
  function approveNode(m) {
    const a = m.approve;
    const box = el('div.ks-approve.glass');
    const paint = () => {
      box.className = 'ks-approve glass ' + (a.state ? 'done ' + a.state : 'pending');
      if (!a.state) {
        const yes = el('button.btn.small.primary', { type: 'button', onclick: () => decide(true) }, icon('check'), el('span', { text: 'Yes' }));
        box.replaceChildren(el('span.ks-aic', icon('lock')), el('div.ks-aq', richText(`${S().name || 'Kitsu'} wants to ${a.label}.`),
          el('div.ks-abtns', yes, el('button.btn.small', { type: 'button', onclick: () => decide(false) }, icon('x'), el('span', { text: 'No' })))));
      } else box.replaceChildren(el('span.ks-aic', icon(a.state === 'yes' ? 'check' : 'x')), el('div.ks-aq', richText(a.state === 'yes' ? a.doneText || 'Done.' : a.state === 'fail' ? a.err : 'Okay, I left it as it was.')));
    };
    const decide = yes => {
      if (a.state) return;
      if (yes) { try { a.doneText = runApproved(a); a.state = 'yes'; K.haptic?.('success'); } catch (e) { a.state = 'fail'; a.err = 'That didn\'t work: ' + (e?.message || 'unknown error') + '.'; } }
      else a.state = 'no';
      saveChats(); paint();
      box.dispatchEvent(new CustomEvent('ks-decided', { bubbles: true }));
    };
    paint();
    return box;
  }

  // ---------- the pop-up: a small launcher on every page and a floating chat you can move ----------
  // Tiny at startup (one button); the chat is built the first time it opens. Desktop: drag the header (or the
  // launcher) anywhere, resize from the corner, double-click the header to put it back; it fades when the mouse
  // is away. Android: the launcher is a bubble that sticks to the left or right edge, and the chat is a bottom sheet.
  const POS_KEY = 'koru-kitsu-pop', FAB_KEY = 'koru-kitsu-fab', OPEN_KEY = 'koru-kitsu-open';
  const isDroid = () => document.documentElement.classList.contains('android');
  const vw = () => document.documentElement.clientWidth, vh = () => document.documentElement.clientHeight;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const M = 12, SNAP = 28;
  const popMode = () => { try { return S().home !== 'tab'; } catch { return true; } };
  const Pop = {
    fab: null, box: null, wrap: null, ui: null, open: false, pageAt: Date.now(), inReader: false, hover: false, drag: false, hold: 0, fadeT: 0,
    hideForPage() { paintPop(); },
    check: () => fadeCheck()
  };
  const reading = () => /^#\/read\//.test(location.hash) || document.documentElement.classList.contains('reading');
  const onKitsuPage = () => /^#\/kitsu\b/.test(location.hash);
  // what sits along the bottom: the Music bar on desktop, the bottom bar on Android
  function floor() {
    const h = document.documentElement;
    if (isDroid()) {
      if (h.classList.contains('an-nonav') || h.classList.contains('an-kb')) return 0;
      return (parseFloat(getComputedStyle(h).getPropertyValue('--an-nav-h')) || 72) + 6 + (h.classList.contains('mu-bar-on') ? 84 : 0);
    }
    return h.classList.contains('mu-bar-on') ? 96 : 0;
  }
  const defPop = () => ({ side: 'r', x: 18, b: 18, w: 400, h: Math.min(640, vh() - 100) });
  const defFab = () => ({ side: 'r', x: isDroid() ? 14 : 18, b: isDroid() ? 14 : 18 });

  function buildFab() {
    const fab = el('button.ks-fab.glass', { type: 'button', title: `Ask ${S().name || 'Kitsu'}`, 'aria-label': `Open ${S().name || 'Kitsu'}`, onclick: e => { if (e.detail === 0) openPop(true); } }, avatar('ks-ava-f'), el('span.ks-fab-l', { text: S().name || 'Kitsu' }));
    document.body.append(fab);
    Pop.fab = fab;
    // the label shows for a few seconds after start, then only on hover
    fab.classList.add('peek'); setTimeout(() => fab.classList.remove('peek'), 4200);
    draggable(fab, fab, {
      get: () => ls.get(FAB_KEY, null) || defFab(),
      set: p => ls.set(FAB_KEY, p),
      edge: () => isDroid(),
      tap: () => openPop(true)
    });
    placeFab();
  }
  function place(node, p, isPop) {
    const W = vw(), Hh = vh(), f = floor();
    const w = isPop ? clamp(p.w || 400, Math.min(320, W - 2 * M), W - 2 * M) : node.offsetWidth || 48;
    const h = isPop ? clamp(p.h || 600, Math.min(360, Hh - 2 * M - f), Hh - 2 * M - f) : node.offsetHeight || 48;
    const x = clamp(p.x ?? 18, M, Math.max(M, W - w - M)), b = clamp(p.b ?? 18, M + f, Math.max(M + f, Hh - h - M));
    node.dataset.side = p.side === 'l' ? 'l' : 'r';
    node.style.left = p.side === 'l' ? x + 'px' : 'auto';
    node.style.right = p.side === 'l' ? 'auto' : x + 'px';
    node.style.bottom = b + 'px';
    if (isPop) { node.style.width = w + 'px'; node.style.height = h + 'px'; }
  }
  const placeFab = () => { if (Pop.fab) place(Pop.fab, ls.get(FAB_KEY, null) || defFab(), false); };
  const placePop = () => { if (Pop.box && !isDroid()) place(Pop.box, ls.get(POS_KEY, null) || defPop(), true); };

  // drag with pointer events: a transform while it moves (no layout), clamped to the window; on release it
  // settles (softly snapping to an edge it's near; on Android always to the left or right) and is saved
  function draggable(node, handle, { get, set, edge, tap, start }) {
    handle.addEventListener('pointerdown', e => {
      if (e.button !== 0 || (handle !== node && e.target.closest('button, input, textarea, select, a'))) return;
      if (node === Pop.box && isDroid()) return;
      const r0 = node.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY, f = floor();
      let moved = false, last = null;
      const mv = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        if (!moved) { if (Math.hypot(dx, dy) < 6) return; moved = true; Pop.drag = true; node.classList.add('ks-dragging'); try { handle.setPointerCapture(e.pointerId); } catch {} start?.(); fadeCheck(); }
        const x = clamp(r0.left + dx, M, vw() - r0.width - M), y = clamp(r0.top + dy, M, vh() - r0.height - M - f);
        last = { x, y };
        node.style.transform = `translate3d(${x - r0.left}px, ${y - r0.top}px, 0)`;
      };
      const up = () => {
        window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        if (!moved) { if (tap) tap(); return; }
        Pop.drag = false; node.classList.remove('ks-dragging');
        const W = vw(), Hh = vh(), w = r0.width, h = r0.height;
        let { x, y } = last;
        // settle: snap to an edge it's close to (Android: always the nearer side)
        if (edge?.()) x = x + w / 2 < W / 2 ? M : W - w - M;
        else { if (x - M < SNAP) x = M; if (W - w - M - x < SNAP) x = W - w - M; }
        if (y - M < SNAP) y = M; if (Hh - h - M - f - y < SNAP) y = Hh - h - M - f;
        const side = x + w / 2 < W / 2 ? 'l' : 'r';
        const p = { ...get(), side, x: Math.round(side === 'l' ? x : W - x - w), b: Math.round(Hh - y - h) };
        set(p);
        place(node, p, node === Pop.box);
        // FLIP: start from where it was let go and glide into place
        const r1 = node.getBoundingClientRect();
        node.style.transform = `translate3d(${last.x - r1.left}px, ${last.y - r1.top}px, 0)`;
        node.getBoundingClientRect();
        node.classList.add('ks-settling');
        node.style.transform = '';
        setTimeout(() => node.classList.remove('ks-settling'), 420);
        fadeCheck();
      };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
  }
  // resize from the top corner (the one away from the edge it's pinned to); the bottom and that side stay put
  function resizer(grip) {
    grip.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const box = Pop.box, p0 = { ...defPop(), ...(ls.get(POS_KEY, null) || {}) }, r0 = box.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
      p0.w = r0.width; p0.h = r0.height;
      Pop.drag = true; box.classList.add('ks-resizing'); fadeCheck();
      try { grip.setPointerCapture(e.pointerId); } catch {}
      let raf = 0, p = p0;
      const mv = ev => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        p = { ...p0, w: Math.round(p0.w + (p0.side === 'l' ? dx : -dx)), h: Math.round(p0.h - dy) };
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(box, p, true); });
      };
      const up = () => {
        grip.removeEventListener('pointermove', mv); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
        cancelAnimationFrame(raf); place(box, p, true);
        const r = box.getBoundingClientRect();
        ls.set(POS_KEY, { ...p, w: Math.round(r.width), h: Math.round(r.height) });
        Pop.drag = false; box.classList.remove('ks-resizing'); fadeCheck();
      };
      grip.addEventListener('pointermove', mv); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
  }

  // the first open builds the chat; after that it's shown and hidden
  function buildPop() {
    const box = el('div.ks-pop.glass', { role: 'dialog', 'aria-label': S().name || 'Kitsu', hidden: true });
    const grip = el('i.ks-grip', { title: 'Drag to resize', 'aria-hidden': 'true' });
    box.append(grip);
    Pop.box = box;
    document.body.append(box);
    Pop.ui = chatUI(box, {
      mode: 'pop', alive: () => box.isConnected,
      onExpand: () => { closePop(); K.go('/kitsu'); },
      onClose: () => closePop(),
      onReply: () => { Pop.hold = Date.now() + 3500; fadeCheck(); }
    });
    const head = box.querySelector('.ks-ptop');
    draggable(box, head, { get: () => ls.get(POS_KEY, null) || defPop(), set: p => ls.set(POS_KEY, p), edge: () => false });
    head.addEventListener('dblclick', e => { if (e.target.closest('button') || isDroid()) return; ls.set(POS_KEY, null); box.classList.add('ks-settling'); placePop(); setTimeout(() => box.classList.remove('ks-settling'), 420); });
    resizer(grip);
    // see-through when the mouse is away (never click-through)
    box.addEventListener('pointerenter', e => { if (e.pointerType === 'touch') return; Pop.hover = true; fadeCheck(); });
    box.addEventListener('pointerleave', e => { if (e.pointerType === 'touch') return; Pop.hover = false; fadeCheck(); });
    box.addEventListener('focusin', fadeCheck);
    box.addEventListener('focusout', () => setTimeout(fadeCheck, 0));
    box.addEventListener('ks-decided', () => { Pop.hold = Date.now() + 1500; fadeCheck(); });
    placePop();
  }
  function fadeCheck() {
    clearTimeout(Pop.fadeT);
    const box = Pop.box;
    if (!box) return;
    const s = S(), a = document.activeElement;
    box.style.setProperty('--ks-fade', String(clamp(Number(s.fadeTo) || 0.35, 0.1, 0.9)));
    const keep = !s.fade || isDroid() || !Pop.open || Pop.hover || Pop.drag || busy || Date.now() < Pop.hold
      || box.querySelector('.ks-approve.pending') || (a && box.contains(a) && a.matches('textarea, input'))
      || box.querySelector('.ks-page.side-open') || box.querySelector('.ks-compose.rec');
    if (keep) {
      box.classList.remove('ks-faded');
      if (Date.now() < Pop.hold || busy) Pop.fadeT = setTimeout(fadeCheck, busy ? 600 : Pop.hold - Date.now() + 30);
      return;
    }
    if (!box.classList.contains('ks-faded')) Pop.fadeT = setTimeout(() => box.classList.add('ks-faded'), 600);
  }
  function openPop(focus) {
    if (!popMode()) { K.go('/kitsu'); return; }
    if (!Pop.box) buildPop();
    Pop.open = true; Pop.inReader = reading();
    try { sessionStorage.setItem(OPEN_KEY, '1'); } catch {}
    paintPop(true);
    Pop.ui.paint();
    if (focus && !isDroid()) setTimeout(() => Pop.ui.input.focus({ preventScroll: true }), 60);
    Pop.hold = Date.now() + 1200; fadeCheck();
  }
  function closePop() {
    if (!Pop.open) return;
    Pop.open = false; Pop.hover = false;
    try { sessionStorage.removeItem(OPEN_KEY); } catch {}
    if (Pop.box?.contains(document.activeElement)) document.activeElement.blur();
    paintPop();
  }
  // shows or hides the launcher and the pop-up for the page you're on (and the "Where Kitsu lives" setting)
  function paintPop(opening) {
    const mode = popMode(), s = S();
    const showBox = mode && Pop.open && !onKitsuPage() && (!reading() || Pop.inReader);
    const showFab = mode && s.fab !== false && !Pop.open && !onKitsuPage() && !reading();
    if (showFab && !Pop.fab) buildFab();
    if (Pop.fab) { Pop.fab.hidden = !showFab; if (showFab) placeFab(); }
    const box = Pop.box;
    if (!box) return;
    const droid = isDroid();
    if (showBox) {
      if (droid) {
        // a bottom sheet the Android layer already knows (back closes it, it slides up, the bars dim)
        if (!Pop.wrap || !Pop.wrap.isConnected || Pop.wrap.classList.contains('out')) {
          Pop.wrap?.remove();
          Pop.wrap = el('div.lx-sheetwrap.ks-sheetwrap', { onpointerdown: e => { if (e.target === Pop.wrap) closePop(); } });
          box.classList.add('lx-sheet');
          box.style.cssText = '';
          Pop.wrap.append(box);
          document.body.append(Pop.wrap);
        }
      } else {
        if (Pop.wrap) { Pop.wrap.remove(); Pop.wrap = null; }
        if (box.parentNode !== document.body) document.body.append(box);
        box.classList.remove('lx-sheet');
        placePop();
      }
      if (box.hidden || opening) { box.hidden = false; box.classList.remove('ks-out'); box.classList.remove('ks-show'); void box.offsetWidth; box.classList.add('ks-show'); }
    } else if (!box.hidden) {
      if (droid && Pop.wrap) {
        const w = Pop.wrap; Pop.wrap = null;
        w.classList.add('out');
        setTimeout(() => { box.hidden = true; document.body.append(box); w.remove(); }, 180);
      } else {
        box.classList.add('ks-out');
        setTimeout(() => { if (!box.classList.contains('ks-out')) return; box.hidden = true; box.classList.remove('ks-out', 'ks-show'); }, 200);
      }
    }
  }
  // Esc (and Android's back button, which sends Escape) closes the chat list first, then the pop-up
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !Pop.open || !Pop.box || Pop.box.hidden) return;
    if (document.querySelector('.menu:not(.out), .pal-wrap')) return;
    if (Pop.ui?.sideOpen()) { Pop.ui.closeSide(); e.stopPropagation(); return; }
    closePop();
  });
  window.addEventListener('hashchange', () => {
    if (!reading()) Pop.inReader = false;
    Pop.pageAt = Date.now();
    paintPop();
    if (Pop.open && Pop.ui) Pop.ui.chips();
  });
  window.addEventListener('resize', K.debounce(() => { placeFab(); placePop(); }, 60));
  // the Music bar, the Android bottom bar and the keyboard come and go: keep clear of them
  new MutationObserver(K.debounce(() => { paintPop(); placeFab(); placePop(); }, 30)).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('koru-ready', () => {
    let wasOpen = false; try { wasOpen = sessionStorage.getItem(OPEN_KEY) === '1'; } catch {}
    paintNav();
    if (wasOpen && popMode() && !onKitsuPage()) openPop(false); else paintPop();
  });

  // ---------- where Kitsu lives: a pop-up, or its own tab in the sidebar ----------
  const navShown = () => { try { return S().home === 'tab'; } catch { return false; } };
  function paintNav() {
    const b = document.querySelector('.nav-btn[data-nav=kitsu]');
    if (b) b.hidden = !navShown();
    K.movePill?.();
  }
  function setHome(v) {
    setS({ home: v });
    if (v === 'tab') { if (Pop.open) closePop(); }
    paintNav(); paintPop();
  }

  // ---------- panes ----------
  const tgl = (label, sub, on, fn) => {
    const t = el('button.toggle' + (on ? '.on' : ''), { type: 'button', role: 'switch', 'aria-checked': String(!!on) });
    t.onclick = () => { const x = !t.classList.contains('on'); t.classList.toggle('on', x); t.setAttribute('aria-checked', String(x)); fn(x); };
    return el('div.ctl', el('div.lab', label, sub ? el('small', { text: sub }) : null), t);
  };
  const seg = (opts, val, fn) => K.segmented ? K.segmented(opts, val, fn) : el('div', opts.map(([v, l]) => el('button.chip' + (v === val ? '.on' : ''), { onclick: () => fn(v) }, l)));
  const row = (label, sub, ctl) => el('div.ctl.ks-ctl', el('div.lab', label, sub ? el('small', { text: sub }) : null), ctl);
  const card = (ic, h, sub, ...kids) => el('section.panel.glass.ks-pcard', el('h3', icon(ic), h), sub ? el('p.muted', { text: sub }) : null, ...kids);

  function settingsPane(onClear) {
    const s = S();
    const srcBox = el('div.ks-srcs');
    const paintSrc = () => {
      const sel = S().sources, all = (K.providerList || []).filter(p => !p.hidden);
      srcBox.replaceChildren(...all.map(p => el('button.chip.ks-chip' + (!sel || sel.includes(p.id) ? '.on' : ''), { type: 'button', onclick: () => {
        let cur = S().sources || all.map(x => x.id);
        cur = cur.includes(p.id) ? cur.filter(x => x !== p.id) : [...cur, p.id];
        if (!cur.length) { K.toast('Keep at least one source.', 'error'); return; }
        setS({ sources: cur.length === all.length ? null : cur }); paintSrc();
      } }, p.name)));
    };
    paintSrc();
    const lang = el('select.sel-in', LANGS.map(([v, l]) => el('option', { value: v, text: l, selected: v === s.micLang })));
    lang.onchange = () => setS({ micLang: lang.value });
    const st = sttState();
    const clear = el('button.btn.small.ks-danger', { type: 'button', onclick: () => {
      if (!clear.classList.contains('sure')) { clear.classList.add('sure'); clear.lastChild.textContent = 'Click again to delete every chat'; setTimeout(() => { if (clear.isConnected) { clear.classList.remove('sure'); clear.lastChild.textContent = 'Clear all chats'; } }, 3000); return; }
      chats = []; curId = null; ls.set(CHATS, []); K.toast('All chats cleared', 'ok'); onClear?.();
      clear.classList.remove('sure'); clear.lastChild.textContent = 'Clear all chats';
    } }, icon('trash'), el('span', { text: 'Clear all chats' }));
    return el('div.ks-pane-in',
      el('div.ks-pane-h', el('h2', icon('settings'), 'Settings'), el('p.muted', { text: 'How Kitsu answers. Saved on this PC.' })),
      card('chat', 'Replies', null,
        row('Reply length', 'Short replies show fewer lines and picks', seg([['short', 'Short'], ['normal', 'Normal'], ['detailed', 'Detailed']], s.len, v => setS({ len: v }))),
        row('How replies appear', 'Typed out word by word, or all at once', seg([['instant', 'Instant'], ['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow']], s.stream, v => setS({ stream: v }))),
        tgl('Spoilers', 'Show plot twists and spoiler tags in descriptions', s.spoilers, v => setS({ spoilers: v }))),
      card('lock', 'Privacy', 'Incognito reading is never saved, so Kitsu never sees it. Series you hid stay out of Kitsu\'s answers unless you allow them here.',
        tgl('Let Kitsu see hidden series', 'Hidden series count for stats, history and suggestions. Trash never does.', s.seePrivate, v => setS({ seePrivate: v }))),
      brainHost() ? brainSettings() : null,
      card('search', 'Where Kitsu looks', 'Which sources "Open in Koru" and title searches use.',
        tgl('AniList', 'Descriptions, genres and reader recommendations (public, no account)', s.ani, v => setS({ ani: v })), srcBox),
      card('mic', 'Voice typing', st === 'none' ? 'This device has no speech recognition. On Windows, Win+H types with your voice in any box.'
        : st === 'broken' ? 'Koru\'s speech service isn\'t reachable, so the mic is hidden. On Windows, Win+H types with your voice in any box.'
          : 'Press the mic in the chat box and speak.',
        row('Language', 'What you speak to the mic', lang),
        st === 'broken' ? el('button.btn.small', { type: 'button', onclick: () => { ls.set(STT_KEY, null); K.toast('The mic is back. Try it again.'); K.kitsu._live?.pane(null); K.go('/kitsu', true); } }, icon('refresh'), 'Try the mic again') : null),
      card('trash', 'Your chats', 'Chats are kept on this PC only, up to 60.', el('div.row', clear)),
      el('p.ks-fine.muted', { text: 'Kitsu reads your library, history, ratings, shelves and stats right here. To look things up it asks AniList and your sources, like Explore does. Nothing goes to an AI service.' }));
  }

  function brainSettings() {
    const s = S(), info = el('div.ks-binfo.muted');
    const paint = async () => {
      const st = await brainStatus(true);
      if (!st?.runtime) { info.textContent = 'The on-device brain isn\'t part of this Koru build.'; return; }
      const m = st.models[brainModel()], gb = n => (n / 1073741824).toFixed(2) + ' GB';
      const x = st.stats;
      info.replaceChildren(el('small', { text: m.have ? `${m.label}, ${gb(m.size)} on this PC${st.loaded ? ' · loaded' : ''}${x?.ttft ? ` · last reply: first word in ${(x.ttft / 1000).toFixed(1)} s, ${x.tps} words/s` : ''}` : `${m.label} isn't downloaded yet (${gb(m.size)}).` }),
        m.have ? el('button.btn.small', { type: 'button', onclick: async () => { await K.api.post('/k/kitsu/delete', { model: brainModel() }); K.toast('Removed. Kitsu uses its built-in replies.'); paint(); } }, icon('trash'), 'Remove model')
          : el('button.btn.small.primary', { type: 'button', onclick: async () => { await K.api.post('/k/kitsu/download', { model: brainModel() }); K.kitsu._live?.pane(null); K.go('/kitsu', true); } }, icon('download'), 'Download'));
    };
    paint();
    return card('sparkle', 'Kitsu\'s brain', 'A small AI model that runs on this PC and writes Kitsu\'s replies. No account, no key. Without it, Kitsu answers with its built-in replies.',
      tgl('Write replies with the brain', 'Off: instant built-in replies', s.llm, v => { setS({ llm: v }); }),
      row('Model', 'Smart sticks to the facts; Fast answers sooner but gets details wrong more often', seg([['smart', 'Smart'], ['fast', 'Fast']], s.brain, v => { setS({ brain: v }); paint(); })),
      row('Use it for', 'Conversation only: stats, history and how-tos stay instant', seg([['all', 'Everything'], ['chat', 'Conversation only']], s.brainFor || 'all', v => setS({ brainFor: v }))), info);
  }
  function bioPane(onChange) {
    const s = S();
    const preview = el('div.ks-preview');
    const name = el('input.txt', { value: s.name, maxLength: 24, placeholder: 'Kitsu' });
    const about = el('textarea.ks-ta', { value: s.about, rows: 4, maxLength: 600, placeholder: 'Call me Bryan. I love murim, regression and villainess stories. Avoid horror and harem.' });
    const talk = el('textarea.ks-ta', { value: s.talk, rows: 3, maxLength: 400, placeholder: 'Keep it short, all lowercase, and end every reply with "stay hydrated".' });
    const parsed = el('div.ks-parsed');
    const avaRow = el('div.ks-avas'), presetRow = el('div.ks-presets');
    const paintAva = () => {
      const x = S();
      avaRow.replaceChildren(
        ...Object.entries(FOX_COLORS).map(([k, c]) => el('button.ks-sw' + (x.avatar !== 'emoji' && x.color === k ? '.on' : ''), { type: 'button', title: 'Koru icon, ' + k + ' glow', style: { '--glow': c }, onclick: () => { setS({ avatar: 'fox', color: k }); upd(); } }, el('img', { src: 'img/icon.svg', alt: '' }))),
        ...AVATAR_EMOJI.map(e => el('button.ks-sw.ks-swe' + (x.avatar === 'emoji' && x.emoji === e ? '.on' : ''), { type: 'button', onclick: () => { setS({ avatar: 'emoji', emoji: e }); upd(); } }, e)));
    };
    const paintPresets = () => {
      const x = S();
      presetRow.replaceChildren(...Object.entries(PRESETS).map(([k, p], i) => el('button.ks-preset.glass' + (x.preset === k ? '.on' : ''), { type: 'button', style: { '--i': i }, onclick: () => { setS({ preset: k, emojiAmt: p.emoji, slang: p.slang }); upd(true); } },
        el('b', { text: p.name }), el('small', { text: p.blurb }))));
    };
    let emojiSeg, slangSeg;
    const segBox = el('div');
    const paintSegs = () => {
      const x = S();
      emojiSeg = seg([['0', 'None'], ['1', 'Some'], ['2', 'Lots']], String(x.emojiAmt), v => { setS({ emojiAmt: Number(v) }); upd(); });
      slangSeg = seg([['0', 'None'], ['1', 'A little'], ['2', 'Lots']], String(x.slang), v => { setS({ slang: Number(v) }); upd(); });
      segBox.replaceChildren(row('Emoji', null, emojiSeg), row('Slang', x.preset === 'formal' ? 'Formal ignores slang' : null, slangSeg));
    };
    let n = 0;
    function upd(all) {
      if (all) { paintPresets(); paintSegs(); }
      paintAva(); onChange?.();
      const me = aboutMe(), tr = talkRules();
      parsed.replaceChildren(...[
        (tr.call || me.name) && ['Calls you', tr.call || me.name],
        me.likes.size && ['Likes', [...me.likes].map(id => CBY[id].label).join(', ')],
        me.avoid.size && ['Leaves out', [...me.avoid].map(id => CBY[id].label).join(', ')],
        tr.lower && ['Writes', 'all lowercase'], tr.short && ['Keeps it', 'short'], tr.long && ['Goes into', 'detail'],
        tr.noEmoji && ['Emoji', 'off'], tr.sign && ['Signs off with', tr.sign]
      ].filter(Boolean).map(([k, v]) => el('span.tag.ks-tag', el('b', { text: k + ': ' }), v)));
      if (!parsed.children.length) parsed.append(el('small.muted', { text: 'Tell Kitsu what to call you, what you like and what to leave out.' }));
      // a sample reply, through the same voice as real ones
      const r = Reply('preview', ++n);
      r.say('hi');
      const like = [...me.likes][0], av = [...me.avoid][0];
      r.say('recsAsk', { what: like ? CBY[like].label : 'regression' });
      r.add(`Because you rated **Solo Leveling** 5★ and like ${like ? CBY[like].label : 'dungeons'}, try **Omniscient Reader**.${av ? ` I'm leaving out ${CBY[av].label}, like you asked.` : ''}`);
      r.detail('It\'s completed, so you can binge it in one go.');
      r.keepCards = 0;
      const msg = r.done();
      const node = msgNode(msg, null, { animate: true, stream: true });
      preview.replaceChildren(el('small.ks-plabel.muted', { text: 'Preview' }), node);
      streamIn(node);
    }
    name.addEventListener('input', K.debounce(() => { setS({ name: name.value.trim() || 'Kitsu' }); upd(); }, 200));
    about.addEventListener('input', K.debounce(() => { setS({ about: about.value }); upd(); }, 250));
    talk.addEventListener('input', K.debounce(() => { setS({ talk: talk.value }); upd(); }, 250));
    paintPresets(); paintSegs(); upd();
    return el('div.ks-pane-in.ks-bio',
      el('div.ks-pane-h', el('h2', icon('pencil'), 'Bio'), el('p.muted', { text: 'Who Kitsu is, and who you are. Every reply follows this.' })),
      el('div.ks-bio-grid',
        el('div.ks-bio-l',
          card('smile', 'Kitsu', null, row('Name', null, name), el('div.ks-lab', { text: 'Avatar: Koru\'s icon with a glow colour, or an emoji' }), avaRow),
          card('sparkle', 'Personality', null, presetRow, segBox),
          card('users', 'About me', 'What to call you, genres you love, things to avoid.', about, parsed),
          card('chat', 'How Kitsu should talk', 'In your own words: "short and lowercase", "call me boss", "no emoji"…', talk)),
        el('div.ks-bio-r', card('eye', 'Live preview', null, preview))));
  }

  // ---------- suggestions: never the same ones twice in a chat; "hmm" after a suggestion ----------
  const SUGGEST = new Set(['recommend', 'more_like', 'more_results', 'refine_shorter', 'refine_longer', 'refine_completed', 'refine_not_that', 'surprise', 'hesitant']);
  const seenKey = c => norm(c?.title || '');
  const seenHas = (ctx, c) => (ctx.seen || []).includes(c.id) || (ctx.seenT || []).includes(seenKey(c));
  function seenAdd(ctx, c) {
    if (!c) return;
    (ctx.seen ||= []).push(c.id); (ctx.seenT ||= []).push(seenKey(c));
    if (ctx.seen.length > 300) ctx.seen.splice(0, 60);
    if (ctx.seenT.length > 300) ctx.seenT.splice(0, 60);
  }
  const ALT_GENRES = [['romance', 'Romance'], ['comedy', 'Comedy'], ['thriller', 'Thriller'], ['mystery', 'Mystery'], ['slice of life', 'Slice of Life'], ['horror', 'Horror'], ['sports', 'Sports'], ['fantasy', 'Fantasy']];
  function hesitant(r, ctx) {
    const last = ctx.last, n = ctx.hesN = (ctx.hesN || 0) + 1;
    if (!last?.pool?.length) {
      r.add(pick(['No rush. Want a suggestion, or should I look something up?', 'Take your time. I can suggest something, or find one you half remember.', 'All good. Tell me a mood, a genre or one you loved, and I\'ll go from there.'], n));
      r.chip('What should I read next?', 'Surprise me', 'Find one from a description');
      return;
    }
    r.add(pick(['Not feeling those?', 'Not quite it?', 'Hmm, not sold on those?', 'No spark there?'], n * 3) + ' '
      + pick(['Pick a direction and I\'ll come at it from another angle.', 'Steer me below, or try one of these instead.', 'Here are a couple from a different angle, or tell me which way to go.'], n));
    // a few different ones: unshown ones from the same pool, leaning away from the genres just shown
    const shown = new Set(last.shown || []);
    const shownG = new Set(last.pool.filter(c => shown.has(c.id)).flatMap(c => c.genres || []));
    const rest = last.pool.filter(c => !shown.has(c.id) && !seenHas(ctx, c))
      .map((c, i) => [(c.genres || []).filter(g => shownG.has(g)).length * 3 + i * 0.1, c]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    const picks = rest.slice(0, 3);
    picks.forEach(c => r.card(c)); r.keepCards = picks.length;
    if (picks.length) ctx.last = { ...last, shown: picks.map(c => c.id) };
    const alt = ALT_GENRES.find(([, G]) => !shownG.has(G));
    const best = Object.entries(K.data.notes || {}).filter(([k, v]) => v?.rating >= 4 && visibleKey(k)).sort((a, b) => b[1].rating - a[1].rating)[0]?.[1]
      || Object.values(K.data.history || {}).filter(visible).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    r.chip(alt ? [`Try some ${lc(alt[1])}`, `Recommend some ${alt[0]}`] : null, 'Something shorter', 'Only completed ones', best?.title ? `More like ${best.title}` : null, 'Surprise me');
  }

  // ---------- Settings → Kitsu ----------
  (K.settingsExtras ||= []).push(() => {
    const s = S();
    const sel = el('select.sel-in', Object.entries(PRESETS).map(([k, p]) => el('option', { value: k, text: p.name, selected: k === s.preset })));
    sel.onchange = () => { const p = PRESETS[sel.value]; setS({ preset: sel.value, emojiAmt: p.emoji, slang: p.slang }); };
    const len = el('select.sel-in', [['short', 'Short'], ['normal', 'Normal'], ['detailed', 'Detailed']].map(([v, l]) => el('option', { value: v, text: l, selected: v === s.len })));
    len.onchange = () => setS({ len: len.value });
    // the fade amount: Koru's own slider look
    const fadeV = el('span.val'), fadeR = el('input', { type: 'range', min: 10, max: 90, step: 5, value: Math.round((Number(s.fadeTo) || 0.35) * 100) });
    const paintFade = () => { fadeR.style.setProperty('--p', ((fadeR.value - 10) / 80) * 100 + '%'); fadeV.textContent = fadeR.value + '%'; };
    fadeR.oninput = () => { paintFade(); setS({ fadeTo: Number(fadeR.value) / 100 }); if (Pop.box) Pop.box.style.setProperty('--ks-fade', String(Number(fadeR.value) / 100)); };
    paintFade();
    const fadeRow = el('div.ctl', el('div.lab', 'How see-through', el('small', { text: 'When the mouse is away' })), fadeR, fadeV);
    fadeRow.hidden = s.fade === false;
    const popBits = el('div.ks-popset',
      tgl('Show the Kitsu button', 'A small round button in the corner. Drag it anywhere. Ctrl+K → "Ask Kitsu" works either way.', s.fab !== false, v => { setS({ fab: v }); paintPop(); }),
      isDroid() ? null : tgl('Fade when the mouse is away', 'The pop-up goes see-through until you point at it. It stays clear while you type or Kitsu asks you something.', s.fade !== false, v => { setS({ fade: v }); fadeRow.hidden = !v; fadeCheck(); }),
      isDroid() ? null : fadeRow,
      isDroid() ? null : el('div.row', { style: { marginTop: '6px' } }, el('button.btn.small', { onclick: () => { ls.set(POS_KEY, null); ls.set(FAB_KEY, null); placePop(); placeFab(); K.toast('Kitsu is back in the corner', 'ok'); } }, icon('undo'), 'Put the pop-up back in the corner')));
    popBits.hidden = s.home === 'tab';
    const home = K.segmented([['pop', 'Pop-up', 'chat'], ['tab', 'Its own tab', 'list']], s.home === 'tab' ? 'tab' : 'pop', v => { setHome(v); popBits.hidden = v === 'tab'; });
    return el('section.panel.glass', el('h3', K.fox('ic ks-navfox'), 'Kitsu'), el('p', { text: 'Koru\'s own assistant. It runs on this PC and reads your library to answer.' }),
      el('div.ctl', el('div.lab', 'Where Kitsu lives', el('small', { text: 'A pop-up over every page, or a Kitsu tab in the sidebar' })), home),
      popBits,
      el('div.ctl', el('div.lab', 'Personality'), sel), el('div.ctl', el('div.lab', 'Reply length'), len),
      el('div.row', { style: { marginTop: '8px' } }, el('button.btn.small', { onclick: () => K.go('/kitsu') }, icon('chat'), 'Open the full Kitsu page')));
  });

  // for Ctrl+K and other pages: ask Kitsu (in the pop-up, or on its page in tab mode)
  K.kitsu = {
    ask: q => { if (!popMode()) { K.go('/kitsu?q=' + encodeURIComponent(q)); return; } openPop(false); setTimeout(() => Pop.ui?.ask(q), 80); },
    open: () => openPop(true), close: () => closePop(), toggle: () => (Pop.open ? closePop() : openPop(true)),
    navShown, setHome, _live: null, _pop: Pop,
    _test: { answer: (t, chat) => answer(t, chat || { msgs: [], ctx: {} }, () => {}), voice, line, aboutMe, talkRules, conceptsIn, tidy, ruleIntent: t => ruleIntent(tidy(t), {}) }
  };
})();
