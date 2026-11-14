// Koru on Android. The same page runs inside the Android app's WebView, which gives it window.KoruNative.
// This file fills the few gaps between that WebView and the desktop app; on a PC it does nothing.
//  - Request bodies: the WebView can't pass a POST/PUT body to the app, so each one is handed over first and
//    the request carries its id (X-Koru-Body).
//  - The phone's back button: closes what's on top (a menu, a sheet, the reader), then goes back a page.
//  - Saving files (backups, Wrapped pictures, .cbz exports) into Downloads/Koru.
//  - Zen mode hides the status and navigation bars.
//  - Smooth on any phone: a quick check of the processor, memory and graphics on start picks light mode for
//    slower phones (the same light mode as on a PC without a graphics card). Settings → Graphics can override it.
'use strict';
(function () {
  const N = window.KoruNative;
  if (!N) return;
  const html = document.documentElement;
  html.classList.add('android');

  // ---------- requests to Koru's background side ----------
  const realFetch = window.fetch.bind(window);
  const json = o => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
  window.fetch = async function (input, init) {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    let u; try { u = new URL(href, location.href); } catch { return realFetch(input, init); }
    if (u.host !== location.host || !u.pathname.startsWith('/k/')) return realFetch(input, init);
    if (u.pathname === '/k/fullscreen') {
      let on = false; try { on = !!JSON.parse(init?.body || '{}').on; } catch {}
      N.immersive(on);
      return json({ ok: true });
    }
    const method = String(init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (init && init.body != null && method !== 'GET' && method !== 'HEAD') {
      const body = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
      const headers = new Headers(init.headers || {});
      headers.set('X-Koru-Body', N.stash(body));
      init = { ...init, headers };
      delete init.body;
    }
    return realFetch(input, init);
  };

  // ---------- back button ----------
  const esc = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  window.KoruBack = () => {
    const rset = document.querySelector('.reader .rset');
    if (rset) { rset.remove(); return true; }
    if (document.querySelector('.menu:not(.out), .lx-sheetwrap:not(.out), .lx-pop:not(.out), .reader')) { esc(); return true; }
    const route = location.hash.slice(1) || '/library';
    if (route === '/library' || route === '/') return false;   // at home: leave the app
    if (history.length > 1) history.back(); else K.go('/library');
    return true;
  };

  // ---------- saving files ----------
  const b64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  document.addEventListener('click', async e => {
    const a = e.target?.closest?.('a[download]');
    if (!a || !a.href) return;
    e.preventDefault();
    const name = a.getAttribute('download') || 'Koru file';
    try {
      const u = new URL(a.href, location.href);
      if (u.protocol === 'blob:' || u.protocol === 'data:') {
        const blob = await (await realFetch(a.href)).blob();
        N.saveFile(name, blob.type || 'application/octet-stream', await b64(blob));
      } else if (u.host === location.host) {
        K.toast('Saving ' + name + '…');
        N.saveKoru(u.pathname + u.search, name);
      }
    } catch (err) { K.toast('Couldn\'t save the file: ' + err.message, 'error'); }
  }, true);

  // ---------- smooth on any phone ----------
  // 'soft' turns on light mode (when it's set to Auto) and keeps looping animations off, as on a PC without a
  // graphics card. Phones with a software-drawn screen, few cores, little memory or a slow processor get it.
  K.androidCheck = function () {
    const out = { cores: 0, memMb: 0, gpu: '', cpuMs: 0 };
    try { out.cores = N.cores(); out.memMb = N.memoryMb(); } catch {}
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      out.gpu = gl ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '') : 'none';
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { out.gpu = 'none'; }
    // a fixed bit of work, the best of three (so a busy moment doesn't count)
    let best = 1e9;
    for (let r = 0; r < 3; r++) {
      const t = performance.now(); let x = 0;
      for (let i = 1; i < 400000; i++) x += Math.sqrt(i) * Math.sin(i);
      best = Math.min(best, performance.now() - t); if (x === 42) best++;
    }
    out.cpuMs = Math.round(best * 10) / 10;
    out.noGpu = out.gpu === 'none' || /swiftshader|llvmpipe|software|softpipe/i.test(out.gpu);
    out.weak = out.noGpu || (out.cores && out.cores <= 4) || (out.memMb && out.memMb < 3000) || out.cpuMs > 18;
    out.mode = out.weak ? 'soft' : 'gpu';
    try { localStorage.setItem('koru-android-check', JSON.stringify({ ...out, at: Date.now() })); } catch {}
    return out;
  };
  // the stored result is used right away (core.js reads it), and the check runs again a little after start
  try { const c = JSON.parse(localStorage.getItem('koru-android-check') || 'null'); if (c?.mode) K.applyLite(c.mode); } catch {}
  document.addEventListener('koru-ready', () => setTimeout(() => {
    const c = K.androidCheck();
    K.applyLite(c.mode);
  }, 1500));
})();
