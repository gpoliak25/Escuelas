'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db_ = require('./src/db');
const { dispatch, HttpError } = require('./src/api');
const { seed } = require('./src/seed');
const { DOCUMENTOS, errorPagina } = require('./src/documentos');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const db = db_.open();
if (!db.prepare('SELECT COUNT(*) n FROM familias').get().n) {
  console.log('Base vacía: cargando datos de demostración…', seed(db));
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new HttpError(413, 'Cuerpo demasiado grande')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname === '/portal' ? 'portal.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Prohibido', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'No encontrado', 'text/plain; charset=utf-8');
    send(res, 200, data, TIPOS[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const doc = /^\/(recibos|estado-cuenta|libre-deuda)\/(\d+)$/.exec(url.pathname);
  if (doc && req.method === 'GET') {
    try {
      return send(res, 200, DOCUMENTOS[doc[1]](db, Number(doc[2])), 'text/html; charset=utf-8');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      return send(res, e.status || 500, errorPagina(e instanceof HttpError ? e.message : 'Error interno del servidor'), 'text/html; charset=utf-8');
    }
  }
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET') return send(res, 405, { error: 'Método no permitido' });
    return serveStatic(decodeURIComponent(url.pathname), res);
  }
  try {
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const out = dispatch({ db, method: req.method, pathname: url.pathname, query: url.searchParams, headers: req.headers, body });
    send(res, 200, out ?? { ok: true });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    if (/UNIQUE constraint/.test(e.message)) return send(res, 409, { error: 'El registro ya existe' });
    console.error(e);
    send(res, 500, { error: 'Error interno del servidor' });
  }
});

server.listen(PORT, () => {
  console.log(`Gestión escolar · morosidad\n  Administración: http://localhost:${PORT}\n  Portal de familias: http://localhost:${PORT}/portal`);
});
