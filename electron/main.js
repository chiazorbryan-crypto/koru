// Koru for Windows. The app's pages are served from koru://app/ and its background calls (/k/...)
// are answered by backend.js here in the main process. No local port is opened, and the pages
// have no Node access (contextIsolation + sandbox).
import { app, BrowserWindow, protocol, shell, Menu, nativeTheme, nativeImage, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createBackend } from './backend.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, '..', 'web');
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };

protocol.registerSchemesAsPrivileged([{ scheme: 'koru', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

if (process.platform === 'win32') app.setAppUserModelId('app.koru.reader.window');

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
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

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
    onWindowIcon: png => { const img = nativeImage.createFromDataURL(png); if (win && !img.isEmpty()) win.setIcon(img); }
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
    if (url.pathname === '/k/relaunch' && request.method === 'POST') {
      setTimeout(() => { app.relaunch(); app.exit(0); }, 200);
      return reply(200, { ok: true });
    }
    if (url.pathname.startsWith('/k/')) {
      const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
      const r = await handle({ method: request.method, path: url.pathname, query: url.searchParams, body });
      const headers = { 'Content-Type': r.type, 'Cache-Control': r.file ? 'max-age=86400' : 'no-store' };
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  win.once('ready-to-show', () => win.show());
  // Links never open inside Koru: only app pages load here, anything else goes to the browser (allowed sites only).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, u) => { if (!u.startsWith('koru://app/')) e.preventDefault(); });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
  });
  win.loadURL('koru://app/index.html');
});

app.on('window-all-closed', () => app.quit());
