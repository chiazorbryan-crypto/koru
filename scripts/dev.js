// Runs Koru in a normal browser for testing: node scripts/dev.js [port] [dataDir]
// Serves web/ and answers /k/ with the same backend the app uses. Only listens on 127.0.0.1.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createBackend } from '../electron/backend.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(root, 'web');
const port = Number(process.argv[2]) || 5178;
const data = process.argv[3] || path.join(os.tmpdir(), 'koru-dev');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const handle = createBackend({ dataDir: path.join(data, 'data'), downloadsDir: path.join(data, 'downloads'), version: 'dev', platform: 'dev' });

http.createServer(async (req, res) => {
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/k/')) {
    let body = '';
    for await (const c of req) body += c;
    const r = await handle({ method: req.method, path: url.pathname, query: url.searchParams, body });
    res.writeHead(r.status, { 'Content-Type': r.type, 'Cache-Control': 'no-store' });
    return r.file ? fs.createReadStream(r.file).pipe(res) : res.end(r.body);
  }
  const full = path.normalize(path.join(WEB, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!full.startsWith(WEB + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(full).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`Koru dev: http://127.0.0.1:${port}  (data in ${data})`));
