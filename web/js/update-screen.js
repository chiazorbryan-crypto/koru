// The update screen (PC): Koru's line-art fox drawing itself in (the same animation as the Android opening screen),
// in your theme's colours, with how much of the update has downloaded. It shows only while an update downloads
// and installs, and for a moment when the new Koru opens after updating; never on a normal start.
'use strict';
(function () {
  const FOX = '<svg viewBox="0 0 256 256" aria-hidden="true"><defs><clipPath id="us-clip"><path d="M62,50 L108,96 L148,96 L194,50 L190,120 L214,144 L128,214 L42,144 L66,120 Z M102,154 L112,144 L82,138 Z M174,138 L144,144 L154,154 Z M78,112 L100,108 L82,90 Z M174,90 L156,108 L178,112 Z" clip-rule="nonzero"/></clipPath><linearGradient id="us-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--us-a)"/><stop offset="1" stop-color="var(--us-b)"/></linearGradient></defs><g class="us-fox" transform="translate(128 132) scale(0.82) translate(-128 -132)"><g class="us-hatch" clip-path="url(#us-clip)"><path d="M40.81,141.59 L43.65,148.62" pathLength="1" style="--i:0"/><path d="M47.34,135.06 L57.31,159.74" pathLength="1" style="--i:1"/><path d="M53.87,128.53 L70.97,170.86" pathLength="1" style="--i:2"/><path d="M60.4,122 L84.63,181.98" pathLength="1" style="--i:3"/><path d="M62.81,105.27 L98.29,193.1" pathLength="1" style="--i:4"/><path d="M61.3,78.84 L111.95,204.22" pathLength="1" style="--i:5"/><path d="M59.79,52.41 L125.61,215.33" pathLength="1" style="--i:6"/><path d="M69.7,54.25 L133.65,212.55" pathLength="1" style="--i:7"/><path d="M85.08,69.63 L140.55,206.93" pathLength="1" style="--i:8"/><path d="M100.46,85.01 L147.45,201.32" pathLength="1" style="--i:9"/><path d="M113.05,93.47 L154.35,195.7" pathLength="1" style="--i:10"/><path d="M122.21,93.47 L161.25,190.09" pathLength="1" style="--i:11"/><path d="M131.38,93.47 L168.15,184.47" pathLength="1" style="--i:12"/><path d="M140.55,93.47 L175.05,178.85" pathLength="1" style="--i:13"/><path d="M148.91,91.49 L181.95,173.24" pathLength="1" style="--i:14"/><path d="M155.44,84.96 L188.84,167.62" pathLength="1" style="--i:15"/><path d="M161.97,78.43 L195.74,162.01" pathLength="1" style="--i:16"/><path d="M168.5,71.9 L202.64,156.39" pathLength="1" style="--i:17"/><path d="M175.03,65.37 L209.54,150.78" pathLength="1" style="--i:18"/><path d="M181.56,58.84 L194.19,90.1" pathLength="1" style="--i:19"/><path d="M188.09,52.31 L195.33,70.22" pathLength="1" style="--i:20"/></g><path class="us-nose" d="M116.5,193.5 L138.5,193.5 L127.5,207.5 Z"/></g></svg>';
  let box = null, bar = null, pctEl = null, msgEl = null, loopT = 0;
  function show(title) {
    if (box) return;
    box = K.el('div.us-screen', { role: 'status', 'aria-live': 'polite' });
    box.innerHTML = '<div class="us-mark">' + FOX + '</div>';
    const h = K.el('div.us-title', { text: title || 'Updating Koru' });
    bar = K.el('i'); pctEl = K.el('b.us-pct', { text: '0%' }); msgEl = K.el('small.us-msg', { text: 'Starting…' });
    box.append(h, K.el('div.us-bar', bar), K.el('div.us-row', msgEl, pctEl));
    document.body.append(box);
    requestAnimationFrame(() => box.classList.add('on'));
    // the fox redraws every few seconds while it waits
    loopT = setInterval(() => { const m = box?.querySelector('.us-mark'); if (!m) return; m.classList.remove('draw'); void m.offsetWidth; m.classList.add('draw'); }, 4200);
    box.querySelector('.us-mark').classList.add('draw');
  }
  function progress(pct, msg) {
    if (!box) show();
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    bar.style.width = p + '%'; pctEl.textContent = p + '%';
    if (msg) msgEl.textContent = msg;
  }
  function busy(msg) { if (!box) show(); box.classList.add('us-busy'); msgEl.textContent = msg; }
  function hide() { if (!box) return; clearInterval(loopT); const b = box; box = null; b.classList.remove('on'); setTimeout(() => b.remove(), 500); }
  K.updateScreen = { show, progress, busy, hide };
})();
