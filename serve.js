// 极简静态服务器：node serve.js [端口] ，根目录为 whale-pet/
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = __dirname, PORT = Number(process.argv[2]) || 8642;
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

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  let fp = path.join(ROOT, urlPath === '/' ? 'demo/index.html' : urlPath);
  fs.stat(fp, (err, st) => {
    if (!err && st.isDirectory()) fp = path.join(fp, 'index.html');
    fs.stat(fp, (err2, st2) => {
      if (err2 || !st2.isFile()) { res.statusCode = 404; res.end('404'); return; }
      send(res, fp, st2, req);
    });
  });
});
server.listen(PORT, () => console.log(`whale-pet serving at http://127.0.0.1:${PORT}/demo/`));
