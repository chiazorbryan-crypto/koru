// Series badges: every series has its own badge, themed on what the story is about.
// Popular series have a hand-made one (The Greatest Estate Developer: 💰 Love of Money); every other series
// gets one picked from its genres and description (murim → Martial Spirit, regression → Second Chance…).
// You unlock it once you're deep into the story, and it turns gold when you catch up or finish it.
'use strict';
(function () {
  const { el } = K;
  const norm = t => String(t || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

  // Hand-made badges for well-known series: [title words that must appear, emoji, name, what it's for]
  const SIGNATURE = [
    ['greatest estate developer', '💰', 'Love of Money', 'Got deep into Lloyd’s money-making schemes'],
    ['solo leveling', '🗡️', 'Arise', 'Rose through the ranks with the Shadow Monarch'],
    ['na honjaman', '🗡️', 'Arise', 'Rose through the ranks with the Shadow Monarch'],
    ['ore dake level', '🗡️', 'Arise', 'Rose through the ranks with the Shadow Monarch'],
    ['jeonjijeok dokja', '📖', 'The Only Reader', 'Read along with the one person who knows the ending'],
    ['kami no tou', '🗼', 'Climber', 'Climbed floor after floor of the Tower'],
    ['sinui tap', '🗼', 'Climber', 'Climbed floor after floor of the Tower'],
    ['omniscient reader', '📖', 'The Only Reader', 'Read along with the one person who knows the ending'],
    ['tower of god', '🗼', 'Climber', 'Climbed floor after floor of the Tower'],
    ['beginning after the end', '👑', 'Reborn King', 'Followed a king’s second life'],
    ['eleceed', '🐈', 'Cat Person', 'Trained under a very grumpy cat'],
    ['nano machine', '🤖', 'Nanites Online', 'Powered up with nanomachines'],
    ['mount hua', '🌸', 'Plum Blossoms Bloom', 'Brought a fallen sect back to life'],
    ['the boxer', '🥊', 'Knockout', 'Watched the fists fly'],
    ['lookism', '🪞', 'Two Bodies', 'Lived two lives in two bodies'],
    ['pick me up', '🎰', 'Gacha Luck', 'Rolled for heroes and survived the dungeon'],
    ['reaper of the drifting moon', '🌙', 'Moonlit Reaper', 'Walked the night with the reaper'],
    ['swordmasters youngest son', '⚔️', 'Youngest Son’s Blade', 'Proved the youngest son wrong about nothing'],
    ['world after the fall', '🌀', 'After the Fall', 'Kept going after the world ended'],
    ['second life ranker', '🪜', 'Ranker Again', 'Climbed again for a brother'],
    ['northern blade', '❄️', 'Northern Blade', 'Carried on the Northern Heavenly Sect'],
    ['overgeared', '🔨', 'Legendary Smith', 'Forged legendary gear'],
    ['suicide hunter', '💀', 'Try Again', 'Died, and died, and got stronger'],
    ['novels extra', '📝', 'Just an Extra', 'Played a side character into the spotlight'],
    ['infinite mage', '✨', 'Infinite Mage', 'Watched magic without limits'],
    ['magic emperor', '🐉', 'Demonic Emperor', 'Rose with the Magic Emperor'],
    ['tales of demons and gods', '🐲', 'Demon Spirit', 'Tamed demon spirits'],
    ['martial peak', '🏔️', 'Peak Climber', 'Climbed toward the martial peak'],
    ['hardcore leveling warrior', '🎮', 'Hardcore Gamer', 'Lived inside the game'],
    ['god of high school', '🥋', 'Tournament Fighter', 'Fought through the tournament'],
    ['noblesse', '🍷', 'Noble Taste', 'Sipped tea with a noble'],
    ['true beauty', '💄', 'Makeover', 'Saw what makeup can hide'],
    ['remarried empress', '🦢', 'Remarried', 'Watched an empress choose again'],
    ['villains are destined to die', '🗡️', 'Destined', 'Survived a villainess’ route'],
    ['wind breaker', '🚲', 'Crew Rider', 'Rode with the crew'],
    ['max level hero', '⬆️', 'Max Level', 'Came back at max level'],
    ['player who returned 10000 years', '⏳', 'Ten Thousand Years', 'Came back from hell, a little late'],
    ['regressor', '⏳', 'Regressor', 'Tried the same life again, smarter'],
    ['one piece', '🏴‍☠️', 'Pirate Spirit', 'Sailed the Grand Line'],
    ['naruto', '🍥', 'Ninja Way', 'Never gave up, believe it'],
    ['jujutsu kaisen', '🫴', 'Cursed Energy', 'Fought curses with the sorcerers'],
    ['chainsaw man', '🪚', 'Chainsaw Heart', 'Revved up with Denji'],
    ['demon slayer', '🌊', 'Breathing Style', 'Slayed demons until sunrise'],
    ['kimetsu no yaiba', '🌊', 'Breathing Style', 'Slayed demons until sunrise'],
    ['blue lock', '⚽', 'Ego', 'Became the best striker in the world'],
    ['kage no jitsuryokusha', '🕶️', 'Shadow Garden', 'Played the mastermind in the shadows'],
    ['eminence in shadow', '🕶️', 'Shadow Garden', 'Played the mastermind in the shadows'],
    ['spy x family', '🥜', 'Peanuts', 'Kept the family secret (and the peanuts)'],
    ['frieren', '🌼', 'After the Journey', 'Walked on after the hero’s journey'],
    ['berserk', '🗡️', 'Struggler', 'Kept struggling'],
    ['vinland saga', '🛶', 'True Warrior', 'Sailed to find Vinland'],
    ['dandadan', '👽', 'Paranormal', 'Chased aliens and ghosts'],
    ['kaiju no 8', '🦖', 'Kaiju', 'Turned into a kaiju'],
    ['one punch man', '👊', 'One Punch', 'Ended fights with one punch'],
    ['hunter x hunter', '🎣', 'Hunter', 'Passed the Hunter Exam'],
    ['attack on titan', '🧱', 'Beyond the Walls', 'Looked beyond the walls'],
    ['shingeki no kyojin', '🧱', 'Beyond the Walls', 'Looked beyond the walls'],
    ['my hero academia', '💥', 'Plus Ultra', 'Went further beyond'],
    ['boku no hero', '💥', 'Plus Ultra', 'Went further beyond'],
    ['dragon ball', '🐉', 'Super Saiyan', 'Powered past every limit'],
    ['bleach', '⚰️', 'Soul Reaper', 'Carried a soul reaper’s sword'],
    ['tokyo ghoul', '☕', 'Ghoul Café', 'Had coffee at Anteiku'],
    ['sakamoto days', '🛒', 'Retired Hitman', 'Shopped with a retired legend'],
    ['undead unluck', '🍀', 'Unlucky', 'Survived terrible luck'],
    ['black clover', '🍀', 'Wizard King', 'Aimed to be Wizard King with no magic'],
    ['mashle', '🍞', 'Cream Puffs', 'Muscled through a magic school']
  ];

  // Themes picked from genres and the description, most telling first: [pattern, emoji, name, what it's for]
  const THEMES = [
    // specific kinds of story first; they win ties against the broad genres further down
    [/\b(vampires?|bloodsuckers?)\b/, '🧛', 'Night Blood', 'Ran with the vampires'],
    [/\b(pirates?|sea ?king|navy)\b/, '🏴‍☠️', 'Sea Legs', 'Sailed with pirates'],
    [/\b(ninjas?|shinobi)\b/, '🥷', 'Shadow Step', 'Moved like a ninja'],
    [/\b(doctors?|surgeon|medical|hospital|medicine|healer)\b/, '🩺', 'Miracle Hands', 'Saved lives, chapter by chapter'],
    [/\b(idols?|k-?pop|singer|trainee|entertainment industry|actor|actress)\b/, '🎤', 'Center Stage', 'Took the stage'],
    [/\b(knights?|paladin|holy order)\b/, '🛡️', 'Sworn Knight', 'Swore the knight’s oath'],
    [/\b(assassins?|hitman|killers?)\b/, '🗡️', 'Silent Blade', 'Struck from the shadows'],
    [/\b(necromancer|undead|skeletons?|lich)\b/, '💀', 'Raise the Dead', 'Commanded the dead'],
    [/\b(archer|bow|marksman|sniper)\b/, '🏹', 'Sharpshooter', 'Never missed a shot'],
    [/\b(mecha|robots?|cyborg|android)\b/, '🤖', 'Steel Heart', 'Piloted something huge'],
    [/\b(gods?|deity|divine|heaven)\b/, '✨', 'Divine Favour', 'Caught the gods’ attention'],
    [/\b(emperor|empire|throne|crown prince|king|kingdom)\b/, '👑', 'Throne Watcher', 'Watched the fight for the throne'],
    [/\b(wolf|wolves|werewolf|beast|tamer|summon(er|s)?|pets?)\b/, '🐺', 'Beast Bond', 'Bonded with beasts'],
    [/\b(alchemy|alchemist|potions?|herbs?|pill)\b/, '⚗️', 'Alchemist', 'Brewed something powerful'],
    [/\b(blacksmith|forge|crafting|craftsman|smith)\b/, '🔨', 'Master Crafter', 'Made something legendary'],
    [/\b(farm|farming|farmer|harvest)\b/, '🌾', 'Green Thumb', 'Grew a whole farm'],
    [/\b(detective|mystery|murder|crime|investigat\w*)\b/, '🕵️', 'Case Closed', 'Followed every clue'],
    [/\b(police|cop|prosecutor|lawyer|court)\b/, '⚖️', 'Order in Court', 'Saw justice through'],
    [/\b(military|soldiers?|army|war|mercenar\w*)\b/, '🎖️', 'Veteran', 'Survived the war'],
    [/\b(gangs?|delinquents?|thugs?|street fights?|bully|bullies)\b/, '👊', 'Street Fighter', 'Won the street fights'],
    [/\b(office|company|salary ?man|employee|ceo|corporate)\b/, '💼', 'Overtime', 'Clocked in, chapter after chapter'],
    [/\b(webtoon artist|manga artist|author|writer|novel)\b/, '✍️', 'Plot Twist', 'Lived inside a story'],
    [/\b(music|band|piano|guitar|violin)\b/, '🎵', 'Encore', 'Played it again'],
    [/\b(art|painter|painting|artist)\b/, '🎨', 'Masterpiece', 'Painted a masterpiece'],
    [/\b(space|stars|galaxy|alien|planet)\b/, '🚀', 'Starbound', 'Went to the stars'],
    [/\b(time loop|loop|repeat(ed|ing)? the same day)\b/, '🔁', 'Loop Breaker', 'Broke the loop'],
    [/\b(villainess|evil (lady|daughter|stepmother))\b/, '🌹', 'Villainess Era', 'Rewrote the villainess’ ending'],
    [/\b(contract marriage|fake (dating|marriage|relationship)|arranged marriage)\b/, '💍', 'Contract Signed', 'Signed on for a fake romance'],
    [/\b(childcare|baby|daughter|parenting|adopted|stepmother|stepdaughter)\b/, '🍼', 'Family First', 'Raised a family'],
    [/\b(divorce[sd]?|ex-husband|ex-wife|remarr\w*)\b/, '💔', 'Moving On', 'Saw a marriage end and a life begin'],
    [/\b(maids?|butler|servant)\b/, '🧹', 'At Your Service', 'Served in a grand house'],
    [/\b(princess|noble lady|duchess|countess|young miss)\b/, '🌹', 'Noble Lady', 'Lived the noble life'],
    [/\b(fortune|prophecy|fate|oracle|seer)\b/, '🔮', 'Fate Reader', 'Read what fate had planned'],
    [/\b(ghost|spirits?|exorcis\w*|shaman|curse[sd]?)\b/, '👻', 'Spirit Seer', 'Saw what others can’t'],
    [/\b(hamsters?|cats?|dogs?|bunny|bunnies)\b/, '🐾', 'Animal Friend', 'Made a furry friend'],

    [/\b(money|merchant|business|debt|rich|wealth|chaebol|tycoon|gold coins?|trade|economy)\b/, '💰', 'Love of Money', 'Followed the money'],
    [/\b(cook|cooking|chef|restaurant|food|recipe)\b/, '🍜', 'Foodie', 'Ate well, chapter after chapter'],
    [/\b(sports?|football|soccer|basketball|baseball|volleyball|boxing|mma|golf|tennis)\b/, '🏆', 'Team Player', 'Gave it everything on the field'],
    [/\b(horror|zombies?|ghosts?|haunted|apocalypse|survival)\b/, '🧟', 'Survivor', 'Made it through the worst'],
    [/\b(revenge|vengeance|betray(ed|al)?)\b/, '🗡️', 'Sweet Revenge', 'Saw the revenge through'],
    [/\b(murim|martial|wuxia|cultivat\w*|sects?|kung ?fu|swords?man)\b/, '⚔️', 'Martial Spirit', 'Trained the martial way'],
    [/\b(romance|love|marriage|married|duke|duchess|villainess|empress|engaged|fianc[eé]e?)\b/, '💘', 'Hopeless Romantic', 'Fell for the romance'],
    [/\b(dragons?)\b/, '🐉', 'Dragon Heart', 'Flew with dragons'],
    [/\b(magic|mage|wizard|witch|mana|sorcer\w*|academy)\b/, '🔮', 'Arcane Scholar', 'Studied the arcane'],
    [/\b(game|gamer|vr|virtual|mmorpg|player)\b/, '🕹️', 'Gamer', 'Played to win'],
    [/\b(system|level ?up|leveling|dungeons?|hunters?|gates?|tower|rank(er)?)\b/, '🎮', 'Level Up', 'Levelled up again and again'],
    [/\b(regress\w*|second chance|back in time|reincarnat\w*|rebirth|reborn|return(ed|s)? to the past|transmigrat\w*)\b/, '⏳', 'Second Chance', 'Lived a second life'],
    [/\b(isekai|another world|other world|summoned)\b/, '🌀', 'Otherworlder', 'Crossed into another world'],
    [/\b(demons?|devils?|evil|villain)\b/, '😈', 'Dark Side', 'Walked on the dark side'],
    [/\b(school|high school|student|class)\b/, '🎒', 'Class Act', 'Made it through school'],
    [/\b(comedy|gag|funny)\b/, '😂', 'Comic Relief', 'Laughed all the way'],
    [/\b(slice of life|healing|wholesome|daily life)\b/, '🍵', 'Cozy Days', 'Enjoyed the quiet days']
  ];

  function theme(series) {
    const t = norm(series?.title) + ' ' + norm((series?.altTitles || []).join(' '));
    for (const [words, e, name, desc] of SIGNATURE) if (words.split(' ').every(w => t.includes(w))) return { e, name, desc, sig: true };
    // score each theme: genre tags count double, the title counts triple, the description once;
    // money has to come up at least twice (lots of stories mention a rich family in passing)
    const tags = ((series?.tags || []).join(' ') + ' ' + (series?.genres || []).join(' ')).toLowerCase();
    const desc = K.plainText(series?.description || '').slice(0, 1500).toLowerCase();
    const hits = (re, txt) => (txt.match(new RegExp(re.source, 'g')) || []).length;
    // the specific kinds of story (vampires, villainesses, doctors…) count double against the broad genres
    const broadFrom = THEMES.findIndex(x => x[2] === 'Love of Money');
    let best = null, bestScore = 0;
    THEMES.forEach(([re, e, name, d], i) => {
      const sc = (hits(re, t) * 3 + hits(re, tags) * 2 + hits(re, desc)) * (i < broadFrom ? 2 : 1);
      if (sc < (name === 'Love of Money' ? 2 : 1)) return;
      if (sc > bestScore) { bestScore = sc; best = { e, name, desc: d }; }
    });
    return best || { e: '📘', name: 'Devoted Reader', desc: 'Stuck with this story' };
  }
  // how many chapters you need for the badge: 30, or a third of the series if it's short (at least 8)
  const need = total => Math.max(8, Math.min(30, Math.ceil((total || 30) / 3)));
  const readCount = key => Object.keys(K.data.read?.[key] || {}).length;

  // called after you finish a chapter (from lively.js); returns 'new', 'gold' or nothing
  function check(s) {
    if (!s?.provider || !s.slug || K.incognito?.()) return null;
    const key = K.key(s.provider, s.slug), all = (K.data.stats.sb ||= {}), have = (K.statsAll?.() || K.data.stats).sb?.[key] || all[key];
    const chs = s.chapters || [], free = chs.filter(c => !c.locked), n = readCount(key);
    const newest = free[0], caught = newest && s.chapter && newest.slug === s.chapter.slug;
    const done = caught && /complete|finish|ended/i.test(s.series?.status || '');
    const th = theme(s.series || { title: s.title });
    const save = lvl => { all[key] = { lvl, at: Date.now(), provider: s.provider, slug: s.slug, title: s.series?.title || s.title || s.slug, cover: s.series?.cover || null, e: th.e, name: th.name, desc: th.desc }; K.save('stats'); };
    if (!have && n >= need(free.length)) { save(caught && n >= 10 ? 2 : 1); return { kind: 'new', b: all[key] }; }
    if (have && have.lvl < 2 && (done || (caught && n >= need(free.length)))) { save(2); return { kind: 'gold', b: all[key] }; }
    return null;
  }
  // the chip on a series page: the badge, and how close you are
  function chip(series, key, chapters) {
    const have = (K.statsAll?.() || K.data.stats)?.sb?.[key], th = have || theme(series);
    const total = (chapters || []).filter(c => !c.locked).length, n = readCount(key), goal = need(total);
    const label = have ? (have.lvl > 1 ? ' · gold' : ' · unlocked') : ` · ${Math.min(n, goal)}/${goal} chapters`;
    return el('div.sbchip' + (have ? '.got' : '') + (have?.lvl > 1 ? '.gold' : ''), { title: th.desc + (have ? '' : '. Read ' + goal + ' chapters to unlock it.') },
      el('span.em', { text: th.e }), el('b', { text: th.name }), el('small', { text: label }),
      have ? null : el('i.sbp', el('i', { style: { transform: `scaleX(${Math.min(1, n / goal).toFixed(3)})` } })));
  }
  function card() {
    const list = Object.values((K.statsAll?.() || K.data.stats)?.sb || {}).sort((a, b) => (b.lvl - a.lvl) || (b.at - a.at));
    return el('div.chartcard.glass',
      el('div.badgehead', el('b', { text: 'Series badges' }), el('small.muted', { text: list.length ? `${list.length} earned · ${list.filter(b => b.lvl > 1).length} gold` : 'one for every series you get into' })),
      list.length ? el('div.badges', ...list.map(b => el('a.badge.got' + (b.lvl > 1 ? '.gold' : ''), { href: `#/series/${b.provider}/${encodeURIComponent(b.slug)}`, title: b.desc },
        el('div.em', { text: b.e }), el('div', el('b', { text: b.name }), el('small', { text: b.title })))))
        : el('p.muted', { style: { margin: '10px 0 0' }, text: 'Get deep into a series to unlock its badge. The Greatest Estate Developer gives 💰 Love of Money, murim stories give ⚔️ Martial Spirit, and so on.' }));
  }
  K.seriesBadges = { theme, check, chip, card, need, SIGNATURE, THEMES };
})();
