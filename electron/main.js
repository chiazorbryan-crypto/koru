// Koru for Windows. The app's pages are served from koru://app/ and its background calls (/k/...)
// are answered by backend.js here in the main process. No local port is opened, and the pages
// have no Node access (contextIsolation + sandbox).
import { app, BrowserWindow, protocol, shell, Menu, Tray, nativeTheme, nativeImage, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createBackend } from './backend.js';
import { updateRoute } from './updater.js';
import { syncRoute } from './sync.js';
import { screen } from 'electron';   // the wallpaper's size and the widget's spot
import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, '..', 'web');
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };

protocol.registerSchemesAsPrivileged([{ scheme: 'koru', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const AUMID = 'app.koru.reader.window';
if (process.platform === 'win32') app.setAppUserModelId(AUMID);

// Graphics options (Settings → Graphics). Chromium only reads these at launch, so changes need a restart.
const GPU_FILE = path.join(app.getPath('userData'), 'gpu.json');
const GPU_DEFAULT = { gpu: 'high', accel: true, angle: 'default', blocklist: false };
const GPU_CHOICES = { gpu: ['high', 'auto', 'low'], angle: ['default', 'd3d11', 'd3d9', 'gl', 'vulkan'] };
const cleanGpu = o => {
  const r = { ...GPU_DEFAULT };
  if (o && typeof o === 'object') {
    if (GPU_CHOICES.gpu.includes(o.gpu)) r.gpu = o.gpu;
    if (GPU_CHOICES.angle.includes(o.angle)) r.angle = o.angle;
    if (typeof o.accel === 'boolean') r.accel = o.accel;
    if (typeof o.blocklist === 'boolean') r.blocklist = o.blocklist;
  }
  return r;
};
let gpuSaved = GPU_DEFAULT;
try { gpuSaved = cleanGpu(JSON.parse(fs.readFileSync(GPU_FILE, 'utf8'))); } catch {}
const gpuNow = gpuSaved;
if (!gpuNow.accel) app.disableHardwareAcceleration();
else {
  // "high" makes laptops with two graphics chips use the NVIDIA/AMD one instead of the built-in one.
  if (gpuNow.gpu === 'high') app.commandLine.appendSwitch('force_high_performance_gpu');
  if (gpuNow.gpu === 'low') app.commandLine.appendSwitch('force_low_power_gpu');
  if (gpuNow.angle !== 'default') app.commandLine.appendSwitch('use-angle', gpuNow.angle);
  if (gpuNow.blocklist) app.commandLine.appendSwitch('ignore-gpu-blocklist');
}
const VENDORS = { 4318: 'NVIDIA', 4098: 'AMD', 32902: 'Intel', 5140: 'Microsoft (software)' };
if (!app.requestSingleInstanceLock()) app.quit();
let win = null;

// The desktop, Start menu and pinned-taskbar shortcuts get the same themed icon as the window.
// The themed picture is saved as an .ico (PNG inside, as Windows allows) and each Koru shortcut is pointed at it.
function pngToIco(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map(x => x.png)]);
}
// Pinning to the taskbar: Windows builds the pin from the window's "relaunch" details. Without them it used
// Koru.exe's own built-in icon, which is why a fresh pin showed the original icon. So the window always
// carries the themed .ico, and pins that already exist are found (by what they open) and updated too.
const ICON_DIR = () => path.join(app.getPath('userData'), 'icons');
const themedShortcuts = process.platform === 'win32' && app.isPackaged && !process.env.KORU_BG_TEST;   // only the installed app touches your shortcuts
function setPinDetails(icoFile) {
  if (!themedShortcuts || !win || !icoFile) return;
  try { win.setAppDetails({ appId: AUMID, appIconPath: icoFile, appIconIndex: 0, relaunchCommand: `"${process.execPath}"`, relaunchDisplayName: 'Koru' }); } catch {}
}
function lastIcon() {
  try {
    const dir = ICON_DIR();
    const all = fs.readdirSync(dir).filter(f => /^koru-[0-9a-f]+\.ico$/.test(f)).map(f => path.join(dir, f));
    all.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return all[0] || null;
  } catch { return null; }
}
// every .lnk in a folder (and its subfolders) that opens Koru.exe
function koruLinksIn(dir, depth = 2, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  const exe = process.execPath.toLowerCase();
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory() && depth > 0) koruLinksIn(p, depth - 1, out);
    else if (it.isFile() && it.name.toLowerCase().endsWith('.lnk')) {
      try { if ((shell.readShortcutLink(p).target || '').toLowerCase() === exe) out.push(p); } catch {}
    }
  }
  return out;
}
let shortcutTimer = null;
function themeShortcuts(img) {
  if (!themedShortcuts) return;
  clearTimeout(shortcutTimer);
  shortcutTimer = setTimeout(() => {
    try {
      const images = [256, 64, 48, 32, 24, 16].map(size => ({ size, png: img.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
      const ico = pngToIco(images);
      const hash = crypto.createHash('sha1').update(ico).digest('hex').slice(0, 10);
      const dir = ICON_DIR();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `koru-${hash}.ico`);   // a new name per theme, so Windows doesn't show an old cached icon
      if (!fs.existsSync(file)) fs.writeFileSync(file, ico); else fs.utimesSync(file, new Date(), new Date());
      setPinDetails(file);   // a pin made from now on uses the themed icon
      const appData = app.getPath('appData');
      const pinned = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned');
      const links = new Set([
        path.join(app.getPath('desktop'), 'Koru.lnk'),
        path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop', 'Koru.lnk'),
        path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Koru.lnk'),
        ...koruLinksIn(path.join(pinned, 'TaskBar'), 0),
        ...koruLinksIn(path.join(pinned, 'ImplicitAppShortcuts'), 2),
        ...koruLinksIn(path.join(pinned, 'StartMenu'), 0)
      ]);
      let changed = 0, failed = 0;
      for (const l of links) {
        if (!fs.existsSync(l)) continue;
        try {
          const cur = shell.readShortcutLink(l);
          if (cur.icon === file) continue;
          if (shell.writeShortcutLink(l, 'update', { icon: file, iconIndex: 0 })) changed++; else failed++;
        } catch { failed++; }
      }
      // old theme icons go once nothing points at them any more
      if (!failed) for (const f of fs.readdirSync(dir)) if (f.startsWith('koru-') && f.endsWith('.ico') && path.join(dir, f) !== file) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
      // ask Explorer to redraw shortcut and taskbar icons
      if (changed) { try { spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'ie4uinit.exe'), ['-show'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {} }
    } catch {}
  }, 1500);
}
app.on('second-instance', () => showWin());

// Taskbar options: a tiny helper (build/koru-taskbar.exe, from native/koru-taskbar.cs) does the work and keeps
// working without Koru. It's copied to Koru's data folder so updates never have to replace a file that's in use.
const TTB_PKG = '28017CharlesMilette.TranslucentTB_v826wp6bftszj';
const taskbar = (() => {
  const fake = process.env.KORU_BG_TEST ? { autohide: false, hide: false, alpha: 255, running: false, clear: false } : null;   // tests never touch the real taskbar
  const src = () => app.isPackaged ? path.join(process.resourcesPath, 'koru-taskbar.exe') : path.join(here, '..', 'build', 'koru-taskbar.exe');
  const dst = () => path.join(app.getPath('userData'), 'taskbar', 'koru-taskbar.exe');
  const run = (exe, args) => new Promise((res, rej) => execFile(exe, args, { timeout: 15000, windowsHide: true }, (err, out, errOut) => err ? rej(new Error(String(errOut || err.message).trim())) : res(String(out).trim())));
  const same = (a, b) => { try { return fs.statSync(a).size === fs.statSync(b).size && fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; } };
  async function ready() {
    const s = src(), d = dst();
    if (same(s, d)) return d;
    if (fs.existsSync(d)) await run(d, ['stop']).catch(() => {});
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
    return d;
  }
  return {
    async state() { if (fake) return fake; const d = dst(); return JSON.parse(await run(fs.existsSync(d) ? d : src(), ['state'])); },
    async set(hide, alpha) {
      alpha = Math.max(40, Math.min(255, Math.round(alpha) || 255));
      if (fake) { Object.assign(fake, { hide, alpha, running: hide || alpha < 255 }); return fake; }
      if (!hide && alpha >= 255) { if (fs.existsSync(dst())) await run(dst(), ['disable']); }
      else await run(await ready(), ['enable', hide ? '1' : '0', String(alpha)]);
      return this.state();
    },
    // Fully clear taskbar (only the icons show): Windows 11 draws the taskbar inside Explorer, so only a tool that
    // hooks into Explorer can clear it. TranslucentTB (free, Microsoft Store) does that well; Koru sets it up and starts it.
    ttb() {
      const pkg = path.join(process.env.LOCALAPPDATA || '', 'Packages', TTB_PKG), file = path.join(pkg, 'RoamingState', 'settings.json');
      let clear = false;
      try { clear = /"desktop_appearance"\s*:\s*\{[^}]*"accent"\s*:\s*"clear"/.test(fs.readFileSync(file, 'utf8')); } catch {}
      return fake ? { installed: true, clear: !!fake.clear } : { installed: fs.existsSync(pkg), clear };
    },
    async setClear(on) {
      if (fake) { fake.clear = on; return; }
      const pkg = path.join(process.env.LOCALAPPDATA || '', 'Packages', TTB_PKG);
      if (!fs.existsSync(pkg)) { shell.openExternal('ms-windows-store://pdp/?productid=9PF4KZ2VN4W9'); return { store: true }; }
      const file = path.join(pkg, 'RoamingState', 'settings.json');
      let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch {}
      const body = text.replace(/^﻿/, '').replace(/^\s*\/\/.*$/gm, '');
      let j = {}; try { j = JSON.parse(body || '{}'); } catch { j = {}; }
      j.desktop_appearance = { ...(j.desktop_appearance || {}), accent: on ? 'clear' : 'normal', color: '#00000000', show_line: !on, show_peek: j.desktop_appearance?.show_peek ?? false };
      // keep it clear with apps open and maximized too (otherwise TranslucentTB would switch styles)
      for (const k of ['visible_window_appearance', 'maximized_window_appearance']) if (j[k]) j[k].enabled = false;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '// See https://TranslucentTB.github.io/config for more information\n' + JSON.stringify(j, null, 2));
      if (on) spawn('explorer.exe', ['shell:AppsFolder\\' + TTB_PKG + '!TranslucentTB'], { detached: true, stdio: 'ignore' }).unref();   // already running: it just picks up the change
      return {};
    },
    // after a Koru update brings a newer helper: swap it in and keep it running with the same settings
    async refresh() { if (fake) return; try { const st = await this.state(); if (st.running && !same(src(), dst())) await this.set(st.hide, st.alpha); } catch {} }
  };
})();

// Koru wallpaper: the reader sizes a page to the screen (a PNG), it's saved in Koru's data folder and the taskbar
// helper sets it as the Windows wallpaper. Test runs (KORU_BG_TEST) save the picture but never touch the real wallpaper.
async function wallpaperRoute(request, url) {
  const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  const d = screen.getPrimaryDisplay();
  if (request.method === 'GET') return reply(200, { w: Math.round(d.size.width * d.scaleFactor), h: Math.round(d.size.height * d.scaleFactor) });
  if (request.method !== 'POST') return reply(404, { error: 'Not found' });
  const mode = url.searchParams.get('mode') === 'fit' ? 'fit' : 'fill';
  const png = Buffer.from(await request.arrayBuffer());
  if (png.length < 100 || png.length > 80e6 || png.readUInt32BE(0) !== 0x89504e47) return reply(400, { error: 'That picture didn\'t come through. Try again.' });
  try {
    const dir = path.join(app.getPath('userData'), 'wallpaper');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `koru-wallpaper-${Date.now()}.png`);   // a new name each time, so Windows never shows an old cached one
    fs.writeFileSync(file, png);
    for (const f of fs.readdirSync(dir)) if (/^koru-wallpaper-\d+\.png$/.test(f) && path.join(dir, f) !== file) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
    if (process.env.KORU_BG_TEST) return reply(200, { ok: true, fake: true, file, mode });
    const exe = app.isPackaged ? path.join(process.resourcesPath, 'koru-taskbar.exe') : path.join(here, '..', 'build', 'koru-taskbar.exe');
    await new Promise((res, rej) => execFile(exe, ['wallpaper', file, mode], { timeout: 15000, windowsHide: true }, (err, out, errOut) => err ? rej(new Error(String(errOut || err.message).trim())) : res()));
    return reply(200, { ok: true, file, mode });
  } catch (e) { return reply(500, { error: 'Couldn\'t set the wallpaper: ' + (e.message || e) }); }
}

// Desktop widget (Settings, off by default): a small glass window on the desktop with Up next and new chapters.
// It's a normal window (not always on top, not on the taskbar) that you drag anywhere; Koru remembers where.
// It reads your library through the usual /k/ routes, and looks again when your library or history is saved.
const widget = (() => {
  const FILE = () => path.join(app.getPath('userData'), 'widget.json');
  const test = !!process.env.KORU_BG_TEST;
  const W = 300, H = 360;
  let w = null, cfg = null, refreshT = 0;
  const conf = () => { if (!cfg) { cfg = { on: false, x: null, y: null }; try { Object.assign(cfg, JSON.parse(fs.readFileSync(FILE(), 'utf8'))); } catch {} } return cfg; };
  const save = () => { try { fs.writeFileSync(FILE(), JSON.stringify(conf())); } catch {} };
  function open() {
    if (w) return;
    const c = conf(), wa = screen.getPrimaryDisplay().workArea;
    let { x, y } = c;
    // a saved spot that's on no screen any more (a screen unplugged): back to the top right
    const seen = Number.isFinite(x) && Number.isFinite(y) && screen.getAllDisplays().some(d => x > d.workArea.x - W / 2 && x < d.workArea.x + d.workArea.width - W / 2 && y >= d.workArea.y - 10 && y < d.workArea.y + d.workArea.height - 60);
    if (!seen) { x = wa.x + wa.width - W - 28; y = wa.y + 28; }
    if (test) { x = -5000; y = 1400; }   // test runs: off-screen
    w = new BrowserWindow({ width: W, height: H, x, y, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: false, show: false, title: 'Koru', focusable: !test,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false } });
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', e => e.preventDefault());
    w.once('ready-to-show', () => w?.showInactive());   // never takes the focus from what you're doing
    w.on('moved', () => { if (!w || test) return; [c.x, c.y] = w.getPosition(); save(); });
    w.on('closed', () => { w = null; });
    w.loadURL('koru://app/widget.html');
  }
  const close = () => { if (w) { const x = w; w = null; x.destroy(); } };
  return {
    restore() { if (conf().on) open(); },
    close,
    // your library or history changed: the widget looks again (once, a moment later)
    changed() { if (!w) return; clearTimeout(refreshT); refreshT = setTimeout(() => w?.webContents.executeJavaScript('window.koruWidgetRefresh && koruWidgetRefresh()').catch(() => {}), 1500); },
    async route(request, url) {
      const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      let b = {}; if (request.method === 'POST') { try { b = JSON.parse(await request.text() || '{}'); } catch {} }
      if (url.pathname === '/k/widget' && request.method === 'GET') return reply(200, { on: !!conf().on, open: !!w });
      if (url.pathname === '/k/widget' && request.method === 'POST') {
        conf().on = !!b.on; save();
        if (b.on) open(); else close();
        return reply(200, { on: conf().on });
      }
      // the widget's content height, so the window fits it
      if (url.pathname === '/k/widget/size' && request.method === 'POST') {
        const h = Math.max(120, Math.min(560, Math.round(Number(b.h) || H)));
        if (w && w.getSize()[1] !== h) { const [x, y] = w.getPosition(); w.setResizable(true); w.setBounds({ x, y, width: W, height: h }); w.setResizable(false); }   // Windows ignores a new size on a fixed-size window
        return reply(200, { ok: true });
      }
      // a click in the widget: Koru opens at that chapter or series (or the library)
      if (url.pathname === '/k/widget/open' && request.method === 'POST') {
        const to = String(b.to || '');
        if (!(to === '/library' || /^\/(read|series)\/[^\s#"'`\\]+$/.test(to)) || to.length > 600 || !win) return reply(400, { error: 'Bad place' });
        if (!test) showWin();
        win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + to)}`).catch(() => {});
        return reply(200, { ok: true });
      }
      return reply(404, { error: 'Not found' });
    }
  };
})();

// Now playing: a tiny helper (build/koru-media.exe, from native/koru-media.cs) reads Windows' media controls,
// so Koru's mini player shows and controls Glasswave, Spotify, a browser... It's started the first time the page
// asks, waits for Windows to report changes (no polling), and ends when Koru does (its input pipe closes).
const media = (() => {
  let child = null, now = { on: false }, lastAsk = 0, fails = 0, retryT = 0;
  const exe = () => app.isPackaged ? path.join(process.resourcesPath, 'koru-media.exe') : path.join(here, '..', 'build', 'koru-media.exe');
  function start() {
    if (child || process.platform !== 'win32' || !fs.existsSync(exe())) return;
    try { child = spawn(exe(), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { child = null; return; }
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { now = JSON.parse(line); fails = 0; } catch {} } } });
    child.on('exit', () => { child = null; now = { on: false }; if (++fails < 5 && Date.now() - lastAsk < 60000) retryT = setTimeout(start, 2000 * fails); });
    child.stdin.on('error', () => {});
  }
  app.on('will-quit', () => { clearTimeout(retryT); try { child?.stdin.end(); child?.kill(); } catch {} });
  return {
    state() { lastAsk = Date.now(); start(); return now; },
    send(cmd) { if (!['toggle', 'play', 'pause', 'next', 'prev'].includes(cmd) || !child) return false; try { child.stdin.write(cmd + '\n'); return true; } catch { return false; } }
  };
})();

// Mini reader: the chapter you're reading in a small window that stays on top of everything.
// When it closes, the main window reloads your saved progress so the two never overwrite each other.
let mini = null;
function openMini(hash) {
  const url = 'koru://app/index.html?mini=1#' + hash;
  if (mini) { mini.loadURL(url); mini.show(); return; }
  const test = !!process.env.KORU_BG_TEST;
  mini = new BrowserWindow({
    width: 460, height: 780, minWidth: 300, minHeight: 360, alwaysOnTop: !test, title: 'Koru mini reader', backgroundColor: '#07081a',
    icon: path.join(here, '..', 'build', 'icon.ico'), titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#e8e9ff', height: 30 },
    show: false, ...(test ? { x: -5000, y: 0, skipTaskbar: true, focusable: false } : {}),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: !test }
  });
  if (!test) mini.setAlwaysOnTop(true, 'floating');
  mini.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mini.webContents.on('will-navigate', (e, u) => { if (!u.startsWith('koru://app/')) e.preventDefault(); });
  mini.once('ready-to-show', () => { if (test) mini.showInactive(); else mini.show(); });
  mini.on('closed', () => {
    mini = null;
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript('K.loadData && K.loadData().then(() => window.dispatchEvent(new HashChangeEvent("hashchange")))').catch(() => {});
  });
  mini.loadURL(url);
}

// Closing the window keeps Koru running in the tray (so your crew sees you online and new chapters are still checked).
// Quit from the tray icon's menu.
let tray = null, quitting = false;
app.on('before-quit', () => { quitting = true; });
function showWin() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function makeTray() {
  if (tray || process.env.KORU_BG_TEST) return;
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(here, '..', 'build', 'icon.ico')).resize({ width: 16, height: 16 }));
    tray.setToolTip('Koru');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open Koru', click: showWin }, { type: 'separator' }, { label: 'Quit Koru', click: () => { quitting = true; app.quit(); } }]));
    tray.on('click', showWin);
  } catch {}
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const userData = app.getPath('userData');
  const handle = createBackend({
    dataDir: path.join(userData, 'data'),
    downloadsDir: path.join(userData, 'downloads'),
    version: pkg.version,
    platform: 'desktop',
    // Chromium's network stack: same DNS, proxy and connection handling as the browser, better on slow networks.
    fetchImpl: (url, opts) => net.fetch(url, opts),
    onOpenPath: p => shell.openPath(p),
    onOpenExternal: u => shell.openExternal(u),
    onWindowIcon: png => { const img = nativeImage.createFromDataURL(png); if (img.isEmpty()) return; if (win) win.setIcon(img); themeShortcuts(img); }
  });

  protocol.handle('koru', async request => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (url.pathname === '/k/gpu') {
      if (request.method === 'GET') {
        let info = {};
        try { info = await app.getGPUInfo('basic'); } catch {}
        const devices = (info.gpuDevice || []).map(d => ({ active: !!d.active, vendor: VENDORS[d.vendorId] || 'Graphics card',
          name: d.deviceString || '', driver: d.driverVersion || '' }));
        return reply(200, { now: gpuNow, saved: gpuSaved, status: app.getGPUFeatureStatus(), devices });
      }
      if (request.method === 'PUT') {
        try { gpuSaved = cleanGpu({ ...gpuSaved, ...JSON.parse(await request.text()) }); fs.writeFileSync(GPU_FILE, JSON.stringify(gpuSaved)); }
        catch { return reply(400, { error: 'Bad graphics settings' }); }
        return reply(200, { saved: gpuSaved });
      }
    }
    if (url.pathname === '/k/fullscreen' && request.method === 'POST') {
      let on = false; try { on = !!JSON.parse(await request.text()).on; } catch {}
      if (win) win.setFullScreen(on);
      return reply(200, { ok: true });
    }
    if (url.pathname === '/k/taskbar') {
      try {
        if (request.method === 'GET') return reply(200, { ...(await taskbar.state()), ttb: taskbar.ttb() });
        if (request.method === 'POST') {
          const b = JSON.parse(await request.text() || '{}');
          let extra = {};
          if ('clear' in b) extra = (await taskbar.setClear(!!b.clear)) || {};
          if ('hide' in b) await taskbar.set(!!b.hide, 255);   // the old fade is gone: always full strength
          return reply(200, { ...(await taskbar.state()), ttb: taskbar.ttb(), ...extra });
        }
      } catch (e) { return reply(500, { error: "Couldn't change the taskbar: " + (e.message || e) }); }
    }
    if (url.pathname === '/k/wallpaper') return wallpaperRoute(request, url);
    if (url.pathname === '/k/widget' || url.pathname.startsWith('/k/widget/')) return widget.route(request, url);
    if (url.pathname === '/k/media') {
      if (request.method === 'GET') return reply(200, media.state());
      if (request.method === 'POST') { let cmd = ''; try { cmd = String(JSON.parse(await request.text()).cmd || ''); } catch {} return reply(media.send(cmd) ? 200 : 400, { ok: true }); }
    }
    if (url.pathname === '/k/mini' && request.method === 'POST') {
      let hash = ''; try { hash = String(JSON.parse(await request.text()).hash || ''); } catch {}
      if (!/^\/read\//.test(hash)) return reply(400, { error: 'Open a chapter first' });
      openMini(hash);
      return reply(200, { ok: true });
    }
    if (url.pathname === '/k/relaunch' && request.method === 'POST') {
      setTimeout(() => { app.relaunch(); app.exit(0); }, 200);
      return reply(200, { ok: true });
    }
    if (url.pathname.startsWith('/k/app-update/')) return updateRoute(request, url);
    if (url.pathname.startsWith('/k/sync/')) return syncRoute(request, url);
    if (url.pathname.startsWith('/k/')) {
      const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
      const r = await handle({ method: request.method, path: url.pathname, query: url.searchParams, body });
      if (request.method === 'PUT' && /^\/k\/store\/(library|history|flags)$/.test(url.pathname)) widget.changed();
      const headers = { 'Content-Type': r.type, 'Cache-Control': r.file || r.cache ? 'max-age=86400' : 'no-store', ...(r.headers || {}) };   // e.g. the .cbz file name
      if (r.file) return new Response(Readable.toWeb(fs.createReadStream(r.file)), { status: 200, headers });
      return new Response(r.body, { status: r.status, headers });
    }
    // App files.
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const full = path.normalize(path.join(WEB, rel));
    if (!full.startsWith(WEB + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return new Response('Not found', { status: 404 });
    // no-cache: after an update the new app files are always used, never an old copy
    return new Response(fs.readFileSync(full), { headers: { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
  });

  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 420, minHeight: 520,
    backgroundColor: '#07081a',
    title: 'Koru',
    icon: path.join(here, '..', 'build', 'icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e8e9ff', height: 34 },
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: !process.env.KORU_BG_TEST },
    ...(process.env.KORU_BG_TEST ? { skipTaskbar: true, minimizable: false, focusable: false } : {})
  });
  setPinDetails(lastIcon());
  // KORU_BG_TEST: a test window that draws normally but sits off-screen and never takes focus
  win.once('ready-to-show', () => { if (process.env.KORU_BG_TEST) { win.setPosition(-5000, 0); win.showInactive(); } else win.show(); });
  // Links never open inside Koru: only app pages load here, anything else goes to the browser (allowed sites only).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, u) => { if (!u.startsWith('koru://app/')) e.preventDefault(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
  });
  win.on('close', e => {
    if (quitting || process.env.KORU_BG_TEST || !tray) return;
    e.preventDefault(); win.hide();
    const told = path.join(app.getPath('userData'), 'tray-told');
    if (!fs.existsSync(told)) { try { fs.writeFileSync(told, '1'); tray.displayBalloon({ iconType: 'info', title: 'Koru is still running', content: 'It stays in the tray so your crew sees you online. Right-click the icon to quit.' }); } catch {} }
  });
  makeTray();
  win.on('closed', () => widget.close());
  widget.restore();
  setTimeout(() => taskbar.refresh(), 8000);
  win.loadURL('koru://app/index.html');
});

app.on('window-all-closed', () => app.quit());
