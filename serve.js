// 极简静态服务器：node serve.js [端口] ，根目录为 whale-pet/（仅回环监听）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)), PORT = Number(process.argv[2]) || 8642;
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.png':'image/png', '.gif':'image/gif', '.webp':'image/webp', '.webm':'video/webm',
  '.json':'application/json', '.css':'text/css' };

function send(res, fp, st, req) {
  const type = MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [s, e] = range.replace('bytes=', '').split('-').map(Number);
    const start = s || 0, end = e || st.size - 1;
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(fp).pipe(res);
  }
}

// 解析后必须仍在根目录内（防 ../ 与 ..\ 穿越）
function escapesRoot(fp) {
  const resolved = path.resolve(fp);
  return resolved !== ROOT && !resolved.startsWith(ROOT + path.sep);
}

const server = http.createServer((req, res) => {
  let urlPath;
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); }
  catch { res.statusCode = 400; res.end('400'); return; }
  if (urlPath.includes('\0')) { res.statusCode = 403; res.end(); return; }
  let fp = path.join(ROOT, urlPath === '/' ? 'demo/index.html' : urlPath);
  if (escapesRoot(fp)) { res.statusCode = 403; res.end(); return; }
  fs.stat(fp, (err, st) => {
    if (!err && st.isDirectory()) fp = path.join(fp, 'index.html');
    fs.stat(fp, (err2, st2) => {
      if (err2 || !st2.isFile()) { res.statusCode = 404; res.end('404'); return; }
      send(res, fp, st2, req);
    });
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`whale-pet serving at http://127.0.0.1:${PORT}/demo/`));
