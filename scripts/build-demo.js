'use strict';
// Genera dist/gestion-escolar-demo.html: la administración completa en un solo archivo,
// con los datos de demostración congelados. Se abre con doble clic, sin servidor.
// Las pantallas se navegan normalmente; las acciones que modifican datos se rechazan.
const fs = require('node:fs');
const path = require('node:path');
const db_ = require('../src/db');
const { seed } = require('../src/seed');
const { dispatch } = require('../src/api');
const { esFinDeSemana } = require('../src/escolar');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'gestion-escolar-demo.html');

const db = db_.open(':memory:');
seed(db);

function get(ruta) {
  const url = new URL(ruta, 'http://demo');
  return dispatch({ db, method: 'GET', pathname: url.pathname, query: url.searchParams, headers: {}, body: {} });
}

const data = {};
const guardar = (ruta) => { data[ruta] = get(ruta); return data[ruta]; };

for (const r of ['/api/dashboard', '/api/acciones', '/api/planes', '/api/riesgo', '/api/config', '/api/estadisticas',
  '/api/alumnos', '/api/cursos', '/api/familias/opciones', '/api/caja', '/api/deudores', '/api/debitos', '/api/recargos', '/api/ml']) guardar(r);

// Familias: la lista se filtra en el navegador (activas e inactivas por separado)
const activas = get('/api/familias').familias;
const inactivas = get('/api/familias?estado=inactivas').familias;
for (const f of [...activas, ...inactivas]) { guardar(`/api/familias/${f.id}`); guardar(`/api/ml/familia/${f.id}`); }
for (const a of data['/api/alumnos'].alumnos) guardar(`/api/alumnos/${a.id}`);

// Cuotas y cargos: cada tipo y cada período, con la misma query que arma la interfaz
for (const tipo of ['arancel', 'cargo', 'recargo', 'plan']) {
  const base = guardar(`/api/cuotas?tipo=${tipo}`);
  for (const p of base.periodos) guardar(`/api/cuotas?tipo=${tipo}&periodo=${p}`);
}
for (const p of data['/api/debitos'].periodos) guardar(`/api/debitos?periodo=${p}`);

// Cursos: asistencia de hoy y de los últimos 20 días hábiles
const hoy = db_.today(db);
const dias = [];
for (let k = 0; dias.length < 20 && k < 40; k++) {
  const d = db_.addDays(hoy, -k);
  if (!esFinDeSemana(d)) dias.push(d);
}
for (const c of data['/api/cursos'].cursos) {
  guardar(`/api/cursos/${c.id}`);
  for (const d of dias) guardar(`/api/cursos/${c.id}?fecha=${d}`);
}

const json = JSON.stringify({ data, familias: { activas, inactivas } }).replace(/</g, '\\u003c');

const mock = `
// ---- Demo sin servidor: responde la API con datos congelados ----
(() => {
  const { data, familias } = JSON.parse(document.getElementById('demo-data').textContent);
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
  const SOLO_LECTURA = 'Esta es una demo sin servidor: los cambios no se guardan. Para usar el sistema completo, ejecutá "npm start".';
  function familiasFiltradas(params) {
    const q = norm(params.get('q')), nivel = params.get('nivel'), estado = params.get('estado');
    let lista = estado === 'inactivas' ? familias.inactivas : familias.activas;
    if (q) lista = lista.filter((f) => norm(f.apellido + ' ' + f.responsable + ' ' + f.email + ' ' + f.alumnos.join(' ')).includes(q));
    if (nivel) lista = lista.filter((f) => f.riesgo.nivel === nivel);
    if (estado === 'deuda') lista = lista.filter((f) => f.deuda_vencida > 0);
    return { hoy: data['/api/config'].hoy, familias: lista };
  }
  function cursoSinRegistro(id, fecha) {
    const base = data['/api/cursos/' + id];
    if (!base) return null;
    const dow = new Date(fecha + 'T12:00:00Z').getUTCDay();
    return { ...base, fecha, tomada: false, fin_de_semana: dow === 0 || dow === 6, alumnos: base.alumnos.map((a) => ({ ...a, dia: null })) };
  }
  window.fetch = async (input, opts = {}) => {
    const u = new URL(String(input), 'http://demo');
    const method = (opts.method || 'GET').toUpperCase();
    let status = 200, body;
    if (method !== 'GET') { status = 403; body = { error: SOLO_LECTURA }; }
    else if (u.pathname === '/api/familias') body = familiasFiltradas(u.searchParams);
    else {
      body = data[u.pathname + u.search] || data[u.pathname];
      const m = /^\\/api\\/cursos\\/(\\d+)$/.exec(u.pathname);
      if (m && u.searchParams.get('fecha') && !data[u.pathname + u.search]) body = cursoSinRegistro(m[1], u.searchParams.get('fecha'));
      if (!body) { status = 404; body = { error: 'Esta pantalla no está disponible en la demo' }; }
    }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  // Los comprobantes imprimibles y el portal necesitan el servidor
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="/recibos/"], a[href^="/estado-cuenta/"], a[href^="/libre-deuda/"], a[href="/portal"]');
    if (!a) return;
    e.preventDefault();
    toast('Los comprobantes imprimibles y el portal de familias están disponibles al ejecutar el sistema con "npm start".');
  }, true);
  window.addEventListener('unhandledrejection', (e) => { if (String(e.reason?.message || '').startsWith('Esta es una demo')) { e.preventDefault(); toast(e.reason.message); } });
})();
`;

const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8') + `
.demo-banner { background: var(--accent); color: var(--accent-ink); font-size: 13px; padding: 8px 16px; text-align: center; font-weight: 600; }
`;
const js = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');

let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const reemplazar = (a, b) => {
  if (!html.includes(a)) throw new Error('No se encontró en index.html: ' + a);
  html = html.replace(a, () => b);
};
reemplazar('<title>Gestión escolar · Morosidad</title>', '<title>Gestión escolar y morosidad</title>');
reemplazar('<link rel="stylesheet" href="/styles.css">', `<style>\n${css}\n</style>`);
reemplazar('<body>', `<body>\n  <div class="demo-banner" role="note">Demo con datos ficticios al ${hoy.split('-').reverse().join('/')} · se puede navegar todo, pero los cambios no se guardan</div>`);
reemplazar('<a href="/portal" target="_blank" rel="noopener">Abrir portal de familias ↗</a>', '<span>Portal de familias: disponible con <code>npm start</code></span>');
reemplazar('<script src="/app.js"></script>\n  <script src="/escolar.js"></script>\n  <script src="/cobranzas.js"></script>\n  <script src="/ml.js"></script>',
  `<script type="application/json" id="demo-data">${json}</script>\n  <script>${mock}</script>\n  <script>\n${js('app.js')}\n</script>\n  <script>\n${js('escolar.js')}\n</script>\n  <script>\n${js('cobranzas.js')}\n</script>\n  <script>\n${js('ml.js')}\n</script>`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`Demo generada: ${path.relative(ROOT, OUT)} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB, ${Object.keys(data).length} respuestas precargadas)`);

// Variante para publicar como página web: sin envoltorio de documento (lo agrega el visor)
// y sin descargas de CSV, que el visor bloquea.
const quitar = (s, desde, hasta) => {
  const i = s.indexOf(desde);
  const j = s.indexOf(hasta, i);
  if (i < 0 || j < 0) throw new Error('No se encontró: ' + desde);
  return s.slice(0, i) + s.slice(j + hasta.length);
};
let web = html;
web = quitar(web, '<!doctype html>', '<head>');
web = quitar(web, '<meta charset="utf-8">', '>');
web = quitar(web, '<meta name="viewport"', '>');
web = quitar(web, '<link rel="icon"', '>');
web = quitar(web, '</head>', '<body>');
web = web.slice(0, web.lastIndexOf('</body>'));
web = web.replace('</style>', () => '[data-csv] { display: none !important; }\n</style>');
fs.writeFileSync(path.join(ROOT, 'dist', 'gestion-escolar-web.html'), web);
