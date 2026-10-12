'use strict';
/* Administración: SPA sin dependencias con rutas por hash. */

// ---------- Utilidades ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const val = (v) => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : esc(v));
/** Plantilla HTML: escapa todo lo interpolado salvo lo marcado con raw() o generado con h``. */
function h(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => { out += s + (i < vals.length ? val(vals[i]) : ''); });
  return new Raw(out);
}

const money = (n) => '$' + Math.round(n || 0).toLocaleString('es-AR');
const moneyK = (n) => (Math.abs(n) >= 1e6 ? '$' + (n / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' M' : money(n));
const pct = (v, d = 1) => (v == null ? '—' : (v * 100).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d }) + '%');
const fdate = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const fperiodo = (p) => `${MESES[Number(p.slice(5, 7)) - 1]} ${p.slice(2, 4)}`;
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

const NIVEL = { bajo: 'Riesgo bajo', medio: 'Riesgo medio', alto: 'Riesgo alto' };
const NIVEL_COLOR = { bajo: 'var(--ok)', medio: 'var(--warn)', alto: 'var(--bad)' };
const ESTADO = { pagada: 'Pagada', pendiente: 'Por vencer', vencida: 'Vencida', refinanciada: 'En plan de pagos' };
const MEDIO = { debito: 'Débito automático', transferencia: 'Transferencia', efectivo: 'Efectivo', online: 'Pago online', tarjeta: 'Tarjeta' };
const CANAL = { mail: 'Mail', whatsapp: 'WhatsApp', llamada: 'Llamada', reunion: 'Reunión' };
const ETAPAS = [
  { key: 'prevencion', label: 'Prevención', when: 'Antes del vto.' },
  { key: 'vencimiento', label: 'Vencimiento', when: 'Día 0' },
  { key: 'contacto', label: 'Contacto', when: '+5 días' },
  { key: 'plan', label: 'Plan de pagos', when: '+15 días' },
  { key: 'reunion', label: 'Reunión', when: '+30 días' },
];

const nivelPill = (n) => h`<span class="pill ${n}">${NIVEL[n]}</span>`;
const scoreCell = (r) => h`<span class="score"><span class="score-bar" aria-hidden="true"><i style="width:${r.puntaje}%;background:${raw(NIVEL_COLOR[r.nivel])}"></i></span><span class="num">${r.puntaje}</span></span>`;
const estadoPill = (e) => h`<span class="pill ${e}">${ESTADO[e] || e}</span>`;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

// ---------- Modal ----------
const modal = $('#modal');
/** Abre un formulario modal. onSubmit recibe los datos del form; si lanza, se muestra el error. */
function openModal({ title, body, submit = 'Guardar', onSubmit, wide = false }) {
  modal.style.width = wide ? 'min(720px, calc(100vw - 32px))' : '';
  modal.innerHTML = String(h`
    <form method="dialog" id="modal-form">
      <div class="modal-head"><h2>${title}</h2><button type="button" class="btn ghost sm" data-close aria-label="Cerrar">✕</button></div>
      <div class="modal-body">${body}<div class="error" id="modal-error" role="alert"></div></div>
      <div class="modal-foot"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary" type="submit">${submit}</button></div>
    </form>`);
  $$('[data-close]', modal).forEach((b) => b.addEventListener('click', () => modal.close()));
  $('#modal-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {};
    for (const [k, v] of fd.entries()) data[k] = v;
    $$('input[type=checkbox]', e.target).forEach((c) => { data[c.name] = c.checked; });
    const btn = $('button[type=submit]', e.target);
    btn.disabled = true;
    try {
      await onSubmit(data);
      modal.close();
    } catch (err) {
      $('#modal-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  modal.showModal();
  $('input:not([type=hidden]),select,textarea', modal)?.focus();
}

// ---------- Gráficos (SVG) ----------
function roundedTop(x, y, w, hh, r) {
  r = Math.min(r, w / 2, hh);
  return `M${x},${y + hh}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hh}Z`;
}
function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/**
 * Columnas (apiladas si hay varias series). data: [{label, ...valores}], series: [{key, label, color}]
 */
function columnChart(el, data, series, { fmt = money, fmtAxis = moneyK, height = 240, width = 640 } = {}) {
  const W = width, H = height, m = { t: 12, r: 8, b: 26, l: 56 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const totals = data.map((d) => series.reduce((a, s) => a + (d[s.key] || 0), 0));
  const max = niceMax(Math.max(...totals, 0));
  const step = iw / Math.max(1, data.length);
  const bw = Math.min(36, step * 0.62);
  const y = (v) => m.t + ih - (v / max) * ih;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.label).join(', '))} por mes"><g class="grid">`;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
  }
  svg += '</g><g class="axis">';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg += `<text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${esc(fmtAxis(v))}</text>`;
  }
  data.forEach((d, i) => {
    svg += `<text x="${m.l + step * i + step / 2}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  svg += '</g>';
  data.forEach((d, i) => {
    const x = m.l + step * i + (step - bw) / 2;
    let acc = 0;
    const visibles = series.filter((s) => d[s.key] > 0);
    visibles.forEach((s, j) => {
      const v = d[s.key];
      const y0 = y(acc), y1 = y(acc + v);
      let hh = y0 - y1 - (j > 0 ? 2 : 0); // 2px de separación entre segmentos
      if (hh < 0.5) { acc += v; return; }
      const top = j === visibles.length - 1;
      svg += top
        ? `<path d="${roundedTop(x, y1, bw, hh, 4)}" style="fill:${s.color}"/>`
        : `<rect x="${x}" y="${y1}" width="${bw}" height="${hh}" style="fill:${s.color}"/>`;
      acc += v;
    });
    svg += `<rect class="hit" data-i="${i}" x="${m.l + step * i}" y="${m.t}" width="${step}" height="${ih}"/>`;
  });
  svg += '</svg>';
  const legend = series.length > 1
    ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('')}</div>` : '';
  el.innerHTML = `<div class="chart">${svg}<div class="tip"></div></div>${legend}`;
  const tip = $('.tip', el), box = $('.chart', el);
  $$('.hit', el).forEach((r) => {
    r.addEventListener('mouseenter', () => {
      const d = data[r.dataset.i];
      tip.innerHTML = `<b>${esc(d.title || d.label)}</b>` + series.map((s) => `<div><span><i style="background:${s.color}"></i>${esc(s.label)}</span><span class="num">${esc(fmt(d[s.key] || 0))}</span></div>`).join('') +
        (d.extra ? `<div class="muted"><span>${esc(d.extra[0])}</span><span class="num">${esc(d.extra[1])}</span></div>` : '');
      tip.style.display = 'block';
      const bb = box.getBoundingClientRect(), rb = r.getBoundingClientRect();
      let left = rb.left - bb.left + rb.width / 2 + 10;
      if (left + 190 > bb.width) left = rb.left - bb.left + rb.width / 2 - 200;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = '8px';
    });
    r.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

// ---------- Router ----------
const main = $('#main');
const routes = {
  '': pageTablero,
  cobranza: pageCobranza,
  familias: pageFamilias,
  cuotas: pageCuotas,
  planes: pagePlanes,
  riesgo: pageRiesgo,
  config: pageConfig,
};

async function router() {
  const parts = location.hash.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
  const [name = '', arg] = parts;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  $('#side').classList.remove('open');
  const page = routes[name] || pageTablero;
  main.innerHTML = '<div class="loading">Cargando…</div>';
  try {
    await page(arg);
  } catch (e) {
    main.innerHTML = String(h`<div class="card"><h2>No se pudo cargar la sección</h2><p class="muted">${e.message}</p></div>`);
  }
  window.scrollTo(0, 0);
}
const reload = () => router().then(refreshBadges);

async function refreshBadges() {
  try {
    const [acc, pl, cfg] = await Promise.all([api('/api/acciones'), api('/api/planes'), api('/api/config')]);
    const set = (id, n) => { const b = $(id); b.hidden = !n; b.textContent = n; };
    set('#badge-acciones', acc.acciones.length);
    set('#badge-solicitudes', pl.solicitudes.length);
    $('#hoy').textContent = fdate(cfg.hoy) + (cfg.settings.fecha_simulada ? ' (simulada)' : '');
    $('#escuela-nombre').textContent = cfg.settings.escuela_nombre;
  } catch { /* los badges son informativos */ }
}

window.addEventListener('hashchange', reload);
$('#menu-btn').addEventListener('click', () => $('#side').classList.toggle('open'));

// ---------- Tablero ----------
async function pageTablero() {
  const d = await api('/api/dashboard');
  const k = d.kpis;
  const recuperado = k.recupero.filter((r) => r.etapa !== 'sin_gestion').reduce((a, r) => a + r.pct, 0);
  const tot = d.niveles.bajo + d.niveles.medio + d.niveles.alto || 1;
  main.innerHTML = String(h`
    <div class="page-head">
      <div>
        <div class="eyebrow">Tablero directivo</div>
        <h1>${d.escuela}</h1>
        <p>${d.familias} familias · ${d.alumnos} alumnos · Deuda vencida total <b class="num">${money(d.deuda_vencida_total)}</b></p>
      </div>
      <div class="btn-row">
        <a class="btn accent" href="#/cobranza">Bandeja de cobranza · ${d.acciones_pendientes} acciones</a>
      </div>
    </div>

    <div class="grid g-3">
      <div class="card kpi"><span class="label">Tasa de morosidad</span><span class="value">${pct(k.tasa_morosidad.valor)}</span>
        <span class="sub">De lo facturado en 12 meses, con más de 30 días de atraso. Hoy: ${k.tasa_morosidad.familias} familia(s) superan los 30 días.</span></div>
      <div class="card kpi"><span class="label">Días de atraso promedio</span><span class="value">${k.dias_atraso.valor.toLocaleString('es-AR', { maximumFractionDigits: 1 })}</span>
        <span class="sub">Entre el vencimiento y el pago efectivo, últimos 6 meses (${k.dias_atraso.cuotas} cuotas).</span></div>
      <div class="card kpi"><span class="label">Cartera en riesgo</span><span class="value">${moneyK(k.cartera_riesgo.valor)}</span>
        <span class="sub">Deuda y próxima cuota de las ${k.cartera_riesgo.familias} familias en riesgo alto.</span></div>
      <div class="card kpi"><span class="label">Recupero con gestión</span><span class="value">${pct(recuperado, 0)}</span>
        <span class="sub">De la deuda generada en 12 meses, la cobrada tras alguna etapa de la escalera.</span></div>
      <div class="card kpi"><span class="label">Precisión de alertas</span><span class="value">${pct(k.precision.precision, 0)}</span>
        <span class="sub">De ${k.precision.alertas} alertas de riesgo alto, ${k.precision.aciertos} terminaron en atraso de más de 10 días.</span></div>
      <div class="card kpi"><span class="label">Planes cumplidos</span><span class="value">${pct(k.planes.valor, 0)}</span>
        <span class="sub">${k.planes.cumplidos} de ${k.planes.cerrados} planes finalizados se saldaron. ${k.planes.activos} en curso.</span></div>
    </div>

    <div class="grid g-21 mt">
      <div class="card">
        <div class="card-head"><div><h2>Cobranza por mes</h2><p>Facturación de cada período según cómo se cobró</p></div>
          <div class="seg" role="group" aria-label="Vista"><button class="on" data-view="chart">Gráfico</button><button data-view="table">Tabla</button></div></div>
        <div id="ch-cobranza"></div>
        <div id="tb-cobranza" hidden></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Riesgo de la cartera</h2><p>Familias activas por nivel de riesgo</p></div></div>
        <div class="dist" role="img" aria-label="Bajo ${d.niveles.bajo}, medio ${d.niveles.medio}, alto ${d.niveles.alto}">
          ${['bajo', 'medio', 'alto'].map((n) => h`<i style="width:${(d.niveles[n] / tot) * 100}%;background:${raw(NIVEL_COLOR[n])}" title="${NIVEL[n]}: ${d.niveles[n]}"></i>`)}
        </div>
        <table><tbody>
          ${['bajo', 'medio', 'alto'].map((n) => h`<tr class="link" data-href="#/familias?nivel=${n}"><td>${nivelPill(n)}</td><td class="r num"><b>${d.niveles[n]}</b></td><td class="r num muted">${pct(d.niveles[n] / tot, 0)}</td></tr>`)}
        </tbody></table>
        <div class="mt btn-row">
          <a class="btn sm" href="#/riesgo">Ver motor predictivo</a>
          ${d.solicitudes_pendientes ? h`<a class="btn sm" href="#/planes">${d.solicitudes_pendientes} pedido(s) de plan</a>` : ''}
        </div>
      </div>
    </div>

    <div class="grid g-2 mt">
      <div class="card">
        <div class="card-head"><div><h2>Tasa de morosidad mensual</h2><p>Parte de cada período con más de 30 días de atraso</p></div></div>
        <div id="ch-mora"></div>
      </div>
      <div class="card">
        <div class="card-head"><div><h2>Recupero por etapa</h2><p>Deuda cobrada según la última etapa de la escalera, 12 meses</p></div></div>
        ${k.recupero.map((r) => h`
          <div class="factor"><span>${r.label}</span><span class="bar"><i style="width:${Math.max(r.pct * 100, r.monto ? 1 : 0)}%"></i></span><span class="r num">${pct(r.pct, 0)}</span>
          <span class="d">${r.cuotas} cuotas · ${money(r.monto)}</span></div>`)}
      </div>
    </div>

    <div class="card mt">
      <div class="card-head"><div><h2>Familias con mayor riesgo</h2><p>Para actuar antes del próximo vencimiento</p></div><a class="btn sm" href="#/familias">Ver todas</a></div>
      ${tablaFamilias(d.top_riesgo)}
    </div>`);

  const serie = d.serie.map((s) => ({ label: fperiodo(s.periodo), title: fperiodo(s.periodo), en_termino: s.en_termino, con_atraso: s.con_atraso, impago: s.impago, extra: ['Facturado', money(s.facturado)] }));
  columnChart($('#ch-cobranza'), serie, [
    { key: 'en_termino', label: 'Cobrado en término', color: 'var(--ok)' },
    { key: 'con_atraso', label: 'Cobrado con atraso', color: 'var(--warn)' },
    { key: 'impago', label: 'Impago o en plan', color: 'var(--bad)' },
  ]);
  $('#tb-cobranza').innerHTML = String(h`<div class="table-wrap"><table><thead><tr><th>Período</th><th class="r">Facturado</th><th class="r">En término</th><th class="r">Con atraso</th><th class="r">Impago</th><th class="r">Mora +30</th></tr></thead><tbody>
    ${d.serie.map((s) => h`<tr><td>${fperiodo(s.periodo)}</td><td class="r num">${money(s.facturado)}</td><td class="r num">${money(s.en_termino)}</td><td class="r num">${money(s.con_atraso)}</td><td class="r num">${money(s.impago)}</td><td class="r num">${pct(s.tasa_mora)}</td></tr>`)}
    </tbody></table></div>`);
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => {
    $$('[data-view]').forEach((x) => x.classList.toggle('on', x === b));
    $('#ch-cobranza').hidden = b.dataset.view !== 'chart';
    $('#tb-cobranza').hidden = b.dataset.view !== 'table';
  }));
  columnChart($('#ch-mora'), d.serie.map((s) => ({ label: fperiodo(s.periodo), tasa: s.tasa_mora })),
    [{ key: 'tasa', label: 'Tasa de morosidad', color: 'var(--brand-2)' }],
    { fmt: (v) => pct(v), fmtAxis: (v) => pct(v, 0), height: 300, width: 520 });
  bindLinks();
}

function tablaFamilias(lista) {
  if (!lista.length) return h`<div class="empty">No hay familias para mostrar.</div>`;
  return h`<div class="table-wrap"><table>
    <thead><tr><th>Familia</th><th>Alumnos</th><th>Riesgo</th><th>Puntaje</th><th>Motivo principal</th><th class="r">Deuda vencida</th><th>Próx. vto.</th></tr></thead>
    <tbody>${lista.map((f) => h`<tr class="link" data-href="#/familias/${f.id}">
      <td><b>${f.apellido}</b><div class="small muted">${f.responsable}</div></td>
      <td class="small">${f.alumnos.join(', ')}</td>
      <td>${nivelPill(f.riesgo.nivel)}</td>
      <td>${scoreCell(f.riesgo)}</td>
      <td class="small">${f.riesgo.motivo}${f.plan_activo ? h` <span class="pill plain">Plan activo</span>` : ''}</td>
      <td class="r num">${f.deuda_vencida ? money(f.deuda_vencida) : '—'}${f.max_atraso ? h`<div class="small muted">${f.max_atraso} días</div>` : ''}</td>
      <td class="num small">${fdate(f.proximo_vencimiento)}</td>
    </tr>`)}</tbody></table></div>`;
}

function bindLinks(root = main) {
  $$('[data-href]', root).forEach((r) => r.addEventListener('click', (e) => {
    if (e.target.closest('a,button,input,select,textarea')) return;
    location.hash = r.dataset.href;
  }));
}

// ---------- Bandeja de cobranza ----------
let filtroEtapa = '';
async function pageCobranza() {
  const { acciones, hoy } = await api('/api/acciones');
  const cuenta = Object.fromEntries(ETAPAS.map((e) => [e.key, acciones.filter((a) => a.etapa === e.key).length]));
  const visibles = filtroEtapa ? acciones.filter((a) => a.etapa === filtroEtapa) : acciones;
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Cobranza y comunicación</div>
      <h1>Bandeja de cobranza</h1>
      <p>Acciones sugeridas para hoy (${fdate(hoy)}). El puntaje orienta; la administración decide cómo actuar con cada familia: podés editar el mensaje, ejecutarlo u omitirlo.</p>
    </div></div>
    <div class="card">
      <div class="card-head"><div><h2>Escalera de cobranza</h2><p>Cada etapa se activa sólo si la anterior no resolvió la deuda</p></div></div>
      <div class="ladder">${ETAPAS.map((e) => h`<div class="step"><b>${e.when}</b><span>${e.label}</span><span class="n">${cuenta[e.key]}</span></div>`)}</div>
    </div>
    <div class="card mt">
      <div class="stage-tabs" role="tablist">
        <button class="${filtroEtapa ? '' : 'on'}" data-etapa="">Todas <b>${acciones.length}</b></button>
        ${ETAPAS.map((e) => h`<button class="${filtroEtapa === e.key ? 'on' : ''}" data-etapa="${e.key}">${e.label} <b>${cuenta[e.key]}</b></button>`)}
      </div>
      ${visibles.length ? visibles.map(accionHtml) : h`<div class="empty">No hay acciones pendientes en esta etapa. 🎉</div>`}
    </div>`);

  $$('[data-etapa]').forEach((b) => b.addEventListener('click', () => { filtroEtapa = b.dataset.etapa; pageCobranza(); }));
  $$('.action').forEach((el) => {
    const a = visibles[Number(el.dataset.i)];
    $$('[data-do]', el).forEach((b) => b.addEventListener('click', async () => {
      const mensaje = $('textarea', el).value;
      const tipo = b.dataset.do;
      if (tipo === 'plan') return modalPlan(a.familia_id, a.deuda);
      if (tipo === 'whatsapp') window.open(`https://wa.me/${a.telefono.replace(/\D/g, '')}?text=${encodeURIComponent(mensaje)}`, '_blank', 'noopener');
      if (tipo === 'mail') window.open(`mailto:${a.email}?subject=${encodeURIComponent('Cuota escolar')}&body=${encodeURIComponent(mensaje)}`, '_self');
      try {
        await api('/api/acciones', {
          method: 'POST',
          body: { familia_id: a.familia_id, cuota_id: a.cuota_id, etapa: a.etapa, canal: tipo === 'omitir' ? a.canal : tipo, mensaje, estado: tipo === 'omitir' ? 'omitida' : 'enviada' },
        });
        toast(tipo === 'omitir' ? 'Acción omitida y registrada' : 'Acción registrada en el legajo');
        reload();
      } catch (e) { toast(e.message); }
    }));
  });
  bindLinks();
}

function accionHtml(a, i) {
  const dias = a.etapa === 'prevencion' ? `Vence en ${-a.dias} día(s)` : `${a.dias} día(s) de atraso`;
  const principal = { mail: 'Enviar mail', whatsapp: 'Enviar WhatsApp', llamada: 'Registrar llamada', reunion: 'Registrar reunión' }[a.canal];
  const otros = ['mail', 'whatsapp', 'llamada', 'reunion'].filter((c) => c !== a.canal && (c !== 'reunion' || a.etapa === 'reunion'));
  return h`<div class="action" data-i="${i}">
    <div>
      <h3><a href="#/familias/${a.familia_id}">${a.familia}</a></h3>
      <div class="action-meta">
        ${nivelPill(a.riesgo.nivel)} <span class="num">Puntaje ${a.riesgo.puntaje}</span> · <span>${a.riesgo.motivo}</span>
        · <b>${a.etapa_label}</b> · <span>${dias}</span> · <span class="num">${a.etapa === 'prevencion' ? money(a.deuda) : 'Deuda ' + money(a.deuda)}</span>
      </div>
      ${a.accion_preventiva ? h`<p class="small muted" style="margin:0 0 8px">Acción preventiva para ${NIVEL[a.riesgo.nivel].toLowerCase()}: ${a.accion_preventiva}.</p>` : ''}
      <label class="sr-only" for="msg-${i}">Mensaje</label>
      <textarea id="msg-${i}" class="msg" rows="3">${a.mensaje}</textarea>
    </div>
    <div class="action-btns">
      <button class="btn primary sm" data-do="${a.canal}">${principal}</button>
      ${a.etapa === 'plan' || a.etapa === 'reunion' ? h`<button class="btn accent sm" data-do="plan">Crear plan de pagos</button>` : ''}
      <div class="alt">${otros.map((c) => h`<button class="btn ghost sm" data-do="${c}" title="Registrar por ${CANAL[c]}">${CANAL[c]}</button>`)}</div>
      <button class="btn ghost sm" data-do="omitir" title="Registrar que se decidió no actuar">Omitir</button>
    </div>
  </div>`;
}

// ---------- Familias ----------
async function pageFamilias(id) {
  if (id === 'nueva') { location.hash = '#/alumnos/nuevo'; return; }
  if (id) return pageFamilia(Number(id));
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const state = { q: params.get('q') || '', nivel: params.get('nivel') || '', estado: params.get('estado') || '' };
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Gestión escolar</div><h1>Legajo de familias</h1>
      <p>Un legajo único por familia: responsables, hermanos, becas, contacto y riesgo de atraso.</p>
    </div><button class="btn primary" id="nueva" title="Una familia se da de alta junto con su primer alumno">+ Nueva familia</button></div>
    <div class="card">
      <div class="filters">
        <input type="search" id="f-q" placeholder="Buscar por apellido, responsable o alumno" value="${state.q}" aria-label="Buscar">
        <select id="f-nivel" aria-label="Nivel de riesgo"><option value="">Todos los niveles</option>
          ${['bajo', 'medio', 'alto'].map((n) => h`<option value="${n}" ${state.nivel === n ? 'selected' : ''}>${NIVEL[n]}</option>`)}</select>
        <select id="f-estado" aria-label="Estado"><option value="">Activas</option><option value="deuda" ${state.estado === 'deuda' ? 'selected' : ''}>Con deuda vencida</option><option value="inactivas" ${state.estado === 'inactivas' ? 'selected' : ''}>Inactivas</option></select>
        <span class="muted small" id="f-count" style="align-self:center"></span>
      </div>
      <div id="lista"></div>
    </div>`);
  const cargar = async () => {
    const qs = new URLSearchParams(Object.entries(state).filter(([, v]) => v));
    const { familias } = await api('/api/familias?' + qs);
    $('#lista').innerHTML = String(tablaFamilias(familias.sort((a, b) => b.riesgo.puntaje - a.riesgo.puntaje)));
    $('#f-count').textContent = `${familias.length} familia(s)`;
    bindLinks($('#lista'));
  };
  let t;
  $('#f-q').addEventListener('input', (e) => { state.q = e.target.value; clearTimeout(t); t = setTimeout(cargar, 200); });
  $('#f-nivel').addEventListener('change', (e) => { state.nivel = e.target.value; cargar(); });
  $('#f-estado').addEventListener('change', (e) => { state.estado = e.target.value; cargar(); });
  $('#nueva').addEventListener('click', () => openAltaAlumno({ nuevaFamilia: true }));
  await cargar();
}

let tabFamilia = 'cuenta';
async function pageFamilia(id) {
  const d = await api('/api/familias/' + id);
  const f = d.familia, r = d.riesgo;
  const abiertas = d.cuotas.filter((c) => c.saldo > 0);
  main.innerHTML = String(h`
    <div class="page-head">
      <div>
        <div class="eyebrow"><a href="#/familias">Familias</a> / Legajo</div>
        <h1>Familia ${f.apellido} ${f.activa ? '' : h`<span class="pill plain">Inactiva</span>`}</h1>
        <p>${f.responsable} · ${f.email || 'sin mail'} · ${f.telefono || 'sin teléfono'} · ${MEDIO[f.medio_pago]}</p>
      </div>
      <div class="btn-row">
        <button class="btn primary" id="b-pago" ${abiertas.length ? '' : 'disabled'}>Registrar pago</button>
        <button class="btn" id="b-plan" ${d.resumen.deuda_vencida ? '' : 'disabled'}>Plan de pagos</button>
        <button class="btn" id="b-contacto">Registrar contacto</button>
        <button class="btn" id="b-editar">Editar</button>
      </div>
    </div>
    <div class="grid g-3">
      <div class="card kpi"><span class="label">Deuda vencida</span><span class="value">${money(d.resumen.deuda_vencida)}</span><span class="sub">${d.resumen.max_atraso ? `La más antigua con ${d.resumen.max_atraso} días de atraso` : 'Al día'}</span></div>
      <div class="card kpi"><span class="label">Cuota mensual</span><span class="value">${money(d.monto_mensual)}</span><span class="sub">${d.alumnos.filter((a) => a.activo).length} alumno(s), con becas y descuento por hermanos</span></div>
      <div class="card kpi"><span class="label">Próximo vencimiento</span><span class="value">${fdate(d.resumen.proximo_vencimiento)}</span><span class="sub">Código de portal: <b class="num">${f.codigo_portal}</b></span></div>
    </div>
    <div class="grid g-21 mt">
      <div class="card">
        <div class="tabs" role="tablist">
          ${[['cuenta', 'Estado de cuenta'], ['coms', `Comunicaciones (${d.comunicaciones.length})`], ['pagos', 'Pagos'], ['planes', `Planes (${d.planes.length})`], ['legajo', 'Alumnos y legajo']]
            .map(([k, l]) => h`<button class="${tabFamilia === k ? 'on' : ''}" data-tab="${k}">${l}</button>`)}
        </div>
        <div id="tab"></div>
      </div>
      <div>
        <div class="card">
          <div class="card-head"><div><h2>Riesgo de atraso</h2><p>Próxima cuota con más de 10 días de atraso</p></div></div>
          <div class="gauge"><span class="big" style="color:${raw(NIVEL_COLOR[r.nivel])}">${r.puntaje}</span><div>${nivelPill(r.nivel)}<div class="small muted" style="margin-top:4px">${r.motivo}</div></div></div>
          <div class="mt">${r.factores.map((x) => h`<div class="factor"><span class="small">${x.label}</span><span class="bar"><i style="width:${(x.puntos / x.max) * 100}%"></i></span><span class="r num small">${x.puntos}/${x.max}</span><span class="d">${x.detalle}</span></div>`)}</div>
        </div>
        <div class="card">
          <h3>Acción preventiva sugerida</h3>
          <p class="small" style="margin:6px 0 0">${d.prevencion.accion} · ${CANAL[d.prevencion.canal]} · ${d.prevencion.dias} días antes del vencimiento.</p>
          <p class="small muted" style="margin:6px 0 0">El puntaje orienta; la decisión es de la administración.</p>
        </div>
        <div class="card">
          <div class="card-head"><div><h3>Puntaje antes de cada vencimiento</h3><p>Calculado 10 días antes con los datos de ese momento</p></div></div>
          <div id="ch-hist"></div>
        </div>
      </div>
    </div>`);

  const tabs = {
    cuenta: () => h`<div class="table-wrap"><table><thead><tr><th>Concepto</th><th>Vencimiento</th><th class="r">Monto</th><th class="r">Saldo</th><th>Estado</th><th class="r">Atraso</th><th></th></tr></thead><tbody>
      ${d.cuotas.map((c) => h`<tr><td>${c.concepto}</td><td class="num">${fdate(c.vencimiento)}</td><td class="r num">${money(c.monto)}</td><td class="r num">${c.saldo ? money(c.saldo) : '—'}</td>
        <td>${estadoPill(c.estado)}${c.fecha_pago ? h`<div class="small muted">${fdate(c.fecha_pago)}</div>` : ''}</td><td class="r num">${c.atraso ? c.atraso + ' d' : '—'}</td>
        <td class="r">${c.saldo > 0 ? h`<button class="btn sm" data-pagar="${c.id}">Pagar</button>` : ''}</td></tr>`)}
      </tbody></table></div>`,
    coms: () => d.comunicaciones.length ? h`<ul class="tl">${d.comunicaciones.map((m) => h`<li><span class="when">${fdate(m.fecha)}</span><div>
        <b>${m.etapa_label}</b> · ${CANAL[m.canal] || m.canal} ${m.estado === 'omitida' ? h`<span class="pill plain">Omitida</span>` : ''}
        <div class="small muted">${m.mensaje}</div>
        ${m.estado === 'enviada' && (m.canal === 'mail' || m.canal === 'whatsapp') ? h`<div class="btn-row small" style="margin-top:4px">
          <label class="field check"><input type="checkbox" data-com="${m.id}" data-k="abierto" ${m.abierto ? 'checked' : ''}> Abierto</label>
          <label class="field check"><input type="checkbox" data-com="${m.id}" data-k="respondido" ${m.respondido ? 'checked' : ''}> Respondido</label></div>` : ''}
      </div></li>`)}</ul>` : h`<div class="empty">Sin comunicaciones.</div>`,
    pagos: () => d.pagos.length ? h`<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Concepto</th><th>Medio</th><th class="r">Monto</th><th></th></tr></thead><tbody>
      ${d.pagos.map((p) => h`<tr><td class="num">${fdate(p.fecha)}</td><td>${p.concepto}</td><td>${MEDIO[p.medio] || p.medio}</td><td class="r num">${money(p.monto)}</td><td>${p.rechazado ? h`<span class="pill bad">Rechazado</span>` : ''}</td></tr>`)}
      </tbody></table></div>` : h`<div class="empty">Sin pagos registrados.</div>`,
    planes: () => d.planes.length ? h`<div class="table-wrap"><table><thead><tr><th>Plan</th><th>Fecha</th><th class="r">Total</th><th>Cuotas</th><th>Estado</th><th class="r">Saldo</th></tr></thead><tbody>
      ${d.planes.map((p) => h`<tr><td>#${p.id}<div class="small muted">${p.nota}</div></td><td class="num">${fdate(p.fecha)}</td><td class="r num">${money(p.monto_total)}</td><td class="num">${p.cuotas_pagadas}/${p.cuotas_n}</td><td><span class="pill ${p.estado}">${p.estado}</span></td><td class="r num">${money(p.saldo)}</td></tr>`)}
      </tbody></table></div>` : h`<div class="empty">La familia no tiene planes de pago.</div>`,
    legajo: () => h`
      <div class="table-wrap"><table><thead><tr><th>Alumno</th><th>DNI</th><th>Curso</th><th class="r">Beca</th><th>Estado</th></tr></thead><tbody>
        ${d.alumnos.map((a) => h`<tr class="link" data-href="#/alumnos/${a.id}"><td><a href="#/alumnos/${a.id}"><b>${a.nombre} ${a.apellido}</b></a></td><td class="num">${a.dni || '—'}</td><td>${a.grado}° ${a.seccion}</td>
          <td class="r num">${a.beca_pct ? a.beca_pct + '%' : '—'}</td><td>${a.estado === 'activo' ? 'Activo' : h`${a.estado === 'egresado' ? 'Egresado' : 'Baja'} <span class="small muted">${fdate(a.fecha_baja)}</span>`}</td></tr>`)}
      </tbody></table></div>
      <div class="btn-row mt"><button class="btn sm" id="b-alumno">+ Alta de alumno en esta familia</button></div>
      <div class="principles mt">
        <div><b>Consentimiento</b>${f.consentimiento ? 'La familia dio su consentimiento para el tratamiento de datos (Ley 25.326).' : 'Falta registrar el consentimiento de la familia (Ley 25.326).'}</div>
        <div><b>Notas</b>${f.notas || 'Sin notas.'}</div>
      </div>`,
  };
  const renderTab = () => {
    $$('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tabFamilia));
    $('#tab').innerHTML = String(tabs[tabFamilia]());
    $$('[data-pagar]').forEach((b) => b.addEventListener('click', () => modalPago(d, Number(b.dataset.pagar))));
    $$('[data-com]').forEach((c) => c.addEventListener('change', async () => {
      const fila = $$(`[data-com="${c.dataset.com}"]`);
      const body = Object.fromEntries(fila.map((x) => [x.dataset.k, x.checked]));
      await api('/api/comunicaciones/' + c.dataset.com, { method: 'PUT', body });
      toast('Comunicación actualizada');
    }));
    bindLinks($('#tab'));
    $('#b-alumno')?.addEventListener('click', () => openAltaAlumno({ familiaId: f.id }));
  };
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => { tabFamilia = b.dataset.tab; renderTab(); }));
  renderTab();

  columnChart($('#ch-hist'), d.historial_riesgo.map((x) => ({
    label: MESES[Number(x.periodo.slice(5, 7)) - 1], title: fperiodo(x.periodo), puntaje: x.puntaje, extra: ['Atraso real', x.atraso == null ? 'por vencer' : x.atraso + ' días'],
  })), [{ key: 'puntaje', label: 'Puntaje de riesgo', color: 'var(--brand-2)' }], { fmt: String, fmtAxis: (v) => String(Math.round(v)), height: 220, width: 380 });

  $('#b-pago').addEventListener('click', () => modalPago(d));
  $('#b-plan').addEventListener('click', () => modalPlan(f.id, d.resumen.deuda_vencida));
  $('#b-contacto').addEventListener('click', () => modalContacto(f.id));
  $('#b-editar').addEventListener('click', () => modalFamilia(f));
}

// ---------- Modales de acciones ----------
function modalPago(d, cuotaId) {
  const abiertas = d.cuotas.filter((c) => c.saldo > 0).reverse();
  const sel = cuotaId || abiertas[0]?.id;
  openModal({
    title: 'Registrar pago',
    body: h`<div class="form-grid">
      <label class="field full">Cuota<select name="cuota_id" id="p-cuota">${abiertas.map((c) => h`<option value="${c.id}" data-saldo="${c.saldo}" ${c.id === sel ? 'selected' : ''}>${c.concepto} · vence ${fdate(c.vencimiento)} · saldo ${money(c.saldo)}</option>`)}</select></label>
      <label class="field">Monto<input name="monto" id="p-monto" type="number" min="1" step="1" required></label>
      <label class="field">Fecha<input name="fecha" type="date" value="${d.hoy}" required></label>
      <label class="field">Medio<select name="medio">${Object.entries(MEDIO).map(([k, l]) => h`<option value="${k}" ${k === d.familia.medio_pago ? 'selected' : ''}>${l}</option>`)}</select></label>
      <label class="field check" style="align-self:end"><input type="checkbox" name="rechazado"> Débito rechazado</label>
    </div>`,
    onSubmit: async (data) => {
      await api('/api/pagos', { method: 'POST', body: data });
      toast(data.rechazado ? 'Rechazo registrado' : 'Pago registrado');
      reload();
    },
  });
  const sync = () => { $('#p-monto').value = $('#p-cuota').selectedOptions[0]?.dataset.saldo || ''; };
  $('#p-cuota').addEventListener('change', sync);
  sync();
}

async function modalPlan(familiaId, deuda) {
  const cfg = await api('/api/config');
  openModal({
    title: 'Plan de pagos a medida',
    body: h`<p class="small muted" style="margin-top:0">Se refinancia la deuda vencida (${money(deuda)}) en cuotas mensuales. Dejá el acuerdo por escrito.</p>
      <div class="form-grid">
        <label class="field">Cantidad de cuotas<input name="cuotas_n" type="number" min="1" max="24" value="3" required></label>
        <label class="field">Primer vencimiento<input name="primer_vencimiento" type="date" value="${addDays(cfg.hoy, 7)}" required></label>
        <label class="field check full"><input type="checkbox" name="incluir_pendientes"> Incluir también las cuotas por vencer</label>
        <label class="field full">Nota del acuerdo<textarea name="nota" placeholder="Ej.: acordado por teléfono con la madre; revisar en marzo"></textarea></label>
      </div>`,
    submit: 'Crear plan',
    onSubmit: async (data) => {
      const r = await api('/api/planes', { method: 'POST', body: { ...data, familia_id: familiaId } });
      toast(`Plan #${r.id} creado`);
      reload();
    },
  });
}

function modalContacto(familiaId) {
  openModal({
    title: 'Registrar contacto',
    body: h`<div class="form-grid">
      <label class="field">Canal<select name="canal">${Object.entries(CANAL).map(([k, l]) => h`<option value="${k}">${l}</option>`)}</select></label>
      <label class="field check" style="align-self:end"><input type="checkbox" name="respondido"> La familia respondió</label>
      <label class="field full">Detalle<textarea name="mensaje" required placeholder="Qué se habló o se envió"></textarea></label>
    </div>`,
    onSubmit: async (data) => {
      await api('/api/comunicaciones', { method: 'POST', body: { ...data, familia_id: familiaId, etapa: 'manual', abierto: true } });
      toast('Contacto registrado');
      reload();
    },
  });
}

function modalFamilia(f) {
  openModal({
    title: 'Editar familia',
    wide: true,
    body: h`<div class="form-grid">
      <label class="field">Apellido<input name="apellido" value="${f.apellido || ''}" required></label>
      <label class="field">Responsable<input name="responsable" value="${f.responsable || ''}" required></label>
      <label class="field">Mail<input name="email" type="email" value="${f.email || ''}"></label>
      <label class="field">Teléfono (WhatsApp)<input name="telefono" value="${f.telefono || ''}" placeholder="+54 9 11 ..."></label>
      <label class="field">Medio de pago<select name="medio_pago">${Object.entries(MEDIO).map(([k, l]) => h`<option value="${k}" ${k === f.medio_pago ? 'selected' : ''}>${l}</option>`)}</select></label>
      <div class="field" style="justify-content:end">
        <label class="field check"><input type="checkbox" name="consentimiento" ${f.consentimiento ? 'checked' : ''}> Consentimiento de datos (Ley 25.326)</label>
        <label class="field check"><input type="checkbox" name="activa" ${f.activa ? 'checked' : ''}> Familia activa</label>
      </div>
      <label class="field full">Notas<textarea name="notas" placeholder="Sólo información administrativa. No registrar datos de salud, religión ni ideología.">${f.notas || ''}</textarea></label>
    </div>`,
    onSubmit: async (data) => {
      await api('/api/familias/' + f.id, { method: 'PUT', body: data });
      toast('Datos actualizados');
      reload();
    },
  });
}

// ---------- Cuotas ----------
let filtroCuotas = '';
async function pageCuotas(periodoArg) {
  const d = await api('/api/cuotas' + (periodoArg ? '?periodo=' + periodoArg : ''));
  const r = d.resumen;
  const cuotas = filtroCuotas ? d.cuotas.filter((c) => c.estado === filtroCuotas) : d.cuotas;
  const cobrado = r ? r.en_termino + r.con_atraso : 0;
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Cuotas y facturación</div><h1>Cuotas de ${fperiodo(d.periodo)}</h1>
      <p>Aranceles por alumno con becas y descuento por hermanos, vencimientos y medios de pago.</p>
    </div>
    <div class="btn-row">
      <select id="periodo" aria-label="Período">${d.periodos.map((p) => h`<option value="${p}" ${p === d.periodo ? 'selected' : ''}>${fperiodo(p)}</option>`)}</select>
      <button class="btn primary" id="generar">Generar cuotas…</button>
    </div></div>
    ${d.sugerido_generar ? h`<div class="notice">Todavía no se generaron las cuotas de <b>${fperiodo(d.sugerido_generar)}</b>. <button class="btn sm" id="gen-sug">Generar ahora</button></div>` : ''}
    ${r ? h`<div class="grid g-3">
      <div class="card kpi"><span class="label">Facturado</span><span class="value">${money(r.facturado)}</span><span class="sub">${d.cuotas.length} cuotas</span></div>
      <div class="card kpi"><span class="label">Cobrado</span><span class="value">${money(cobrado)}</span><span class="sub">${pct(r.facturado ? r.en_termino / r.facturado : 0, 0)} en término</span></div>
      <div class="card kpi"><span class="label">Impago o en plan</span><span class="value">${money(r.impago)}</span><span class="sub">Mora de más de 30 días: ${pct(r.tasa_mora)}</span></div>
    </div>` : ''}
    <div class="card mt">
      <div class="filters">
        <div class="seg" role="group" aria-label="Estado">${[['', 'Todas'], ['pagada', 'Pagadas'], ['pendiente', 'Por vencer'], ['vencida', 'Vencidas'], ['refinanciada', 'En plan']]
          .map(([k, l]) => h`<button class="${filtroCuotas === k ? 'on' : ''}" data-f="${k}">${l}</button>`)}</div>
      </div>
      ${cuotas.length ? h`<div class="table-wrap"><table><thead><tr><th>Familia</th><th>Vencimiento</th><th class="r">Monto</th><th class="r">Saldo</th><th>Estado</th><th>Pago</th><th class="r">Atraso</th><th>Riesgo actual</th></tr></thead><tbody>
        ${cuotas.map((c) => h`<tr class="link" data-href="#/familias/${c.familia_id}"><td><b>${c.familia}</b><div class="small muted">${c.responsable}</div></td><td class="num">${fdate(c.vencimiento)}</td>
          <td class="r num">${money(c.monto)}</td><td class="r num">${c.saldo ? money(c.saldo) : '—'}</td><td>${estadoPill(c.estado)}</td><td class="num small">${fdate(c.fecha_pago)}</td>
          <td class="r num">${c.atraso ? c.atraso + ' d' : '—'}</td><td>${nivelPill(c.nivel)}</td></tr>`)}
      </tbody></table></div>` : h`<div class="empty">No hay cuotas con ese estado.</div>`}
    </div>`);
  $('#periodo').addEventListener('change', (e) => { location.hash = '#/cuotas/' + e.target.value; });
  $$('[data-f]').forEach((b) => b.addEventListener('click', () => { filtroCuotas = b.dataset.f; pageCuotas(d.periodo); }));
  $('#gen-sug')?.addEventListener('click', () => generar(d.sugerido_generar));
  $('#generar').addEventListener('click', () => openModal({
    title: 'Generar cuotas de un período',
    body: h`<label class="field">Período<input name="periodo" type="month" value="${d.sugerido_generar || d.periodo}" required></label>
      <p class="small muted">Se crea una cuota por familia activa con el arancel vigente. Si ya existe, no se duplica.</p>`,
    submit: 'Generar',
    onSubmit: (data) => generar(data.periodo),
  }));
  bindLinks();
}
async function generar(periodo) {
  const r = await api('/api/cuotas/generar', { method: 'POST', body: { periodo } });
  toast(`${r.creadas} cuota(s) generadas para ${fperiodo(r.periodo)}, vencen el ${fdate(r.vencimiento)}`);
  const destino = '#/cuotas/' + r.periodo;
  if (location.hash === destino) reload();
  else location.hash = destino;
}

// ---------- Planes ----------
async function pagePlanes() {
  const d = await api('/api/planes');
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Gestión</div><h1>Planes de pago</h1>
      <p>Propuestas de cuotas a medida, con acuerdo por escrito. Se miden como "planes cumplidos" en el tablero.</p>
    </div></div>
    <div class="card">
      <div class="card-head"><div><h2>Pedidos desde el portal</h2><p>Familias que pidieron un plan de pagos</p></div></div>
      ${d.solicitudes.length ? h`<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Familia</th><th>Pedido</th><th class="r">Deuda</th><th>Riesgo</th><th></th></tr></thead><tbody>
        ${d.solicitudes.map((s) => h`<tr><td class="num">${fdate(s.fecha)}</td><td><a href="#/familias/${s.familia_id}"><b>${s.familia}</b></a><div class="small muted">${s.responsable}</div></td>
          <td class="small">${s.detalle}</td><td class="r num">${money(s.deuda)}</td><td>${nivelPill(s.riesgo)}</td>
          <td class="r"><div class="btn-row" style="justify-content:flex-end"><button class="btn primary sm" data-crear="${s.familia_id}" data-deuda="${s.deuda}">Crear plan</button><button class="btn sm" data-atender="${s.id}">Marcar atendido</button></div></td></tr>`)}
      </tbody></table></div>` : h`<div class="empty">No hay pedidos pendientes.</div>`}
    </div>
    <div class="card">
      <div class="card-head"><div><h2>Planes</h2><p>${d.planes.length} planes registrados</p></div></div>
      ${d.planes.length ? h`<div class="table-wrap"><table><thead><tr><th>Plan</th><th>Familia</th><th>Fecha</th><th class="r">Total</th><th>Cuotas pagas</th><th>Estado</th><th class="r">Saldo</th></tr></thead><tbody>
        ${d.planes.map((p) => h`<tr class="link" data-href="#/familias/${p.familia_id}"><td>#${p.id}<div class="small muted">${p.nota}</div></td><td><b>${p.familia}</b></td><td class="num">${fdate(p.fecha)}</td>
          <td class="r num">${money(p.monto_total)}</td><td class="num">${p.cuotas_pagadas}/${p.cuotas_n}</td><td><span class="pill ${p.estado}">${p.estado}</span></td><td class="r num">${money(p.saldo)}</td></tr>`)}
      </tbody></table></div>` : h`<div class="empty">Todavía no hay planes.</div>`}
    </div>`);
  $$('[data-crear]').forEach((b) => b.addEventListener('click', () => modalPlan(Number(b.dataset.crear), Number(b.dataset.deuda))));
  $$('[data-atender]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/eventos/${b.dataset.atender}/atender`, { method: 'POST' });
    toast('Pedido marcado como atendido');
    reload();
  }));
  bindLinks();
}

// ---------- Motor predictivo ----------
async function pageRiesgo() {
  const d = await api('/api/riesgo');
  const p = d.precision;
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Motor predictivo · v1 por reglas</div><h1>Un puntaje de riesgo por familia</h1>
      <p>Estima, antes de cada vencimiento, el riesgo de que la próxima cuota se pague con más de 10 días de atraso. Se empieza con reglas simples y explicables; con historial suficiente se pasa a un modelo estadístico.</p>
    </div></div>
    <div class="grid g-3">
      <div class="card"><div class="eyebrow">Entrada</div><p style="margin:6px 0 0">Historial de pagos, hábitos y señales de contacto de cada familia.</p></div>
      <div class="card"><div class="eyebrow">Cálculo</div><p style="margin:6px 0 0">Cada señal suma puntos (0–100). Umbrales: medio desde <b>${d.umbrales.medio}</b>, alto desde <b>${d.umbrales.alto}</b>.</p></div>
      <div class="card"><div class="eyebrow">Salida</div><p style="margin:6px 0 0">Un nivel de riesgo y su motivo principal, visible para administración.</p></div>
    </div>
    <div class="grid g-2 mt">
      <div class="card">
        <div class="card-head"><div><h2>Señales que anticipan el atraso</h2><p>Hipótesis iniciales: validar con el historial real de la escuela</p></div></div>
        <div class="table-wrap"><table><thead><tr><th>Señal</th><th>Cómo se mide</th><th>Qué anticipa</th><th class="r">Máx.</th></tr></thead><tbody>
          ${d.senales.map((s) => h`<tr><td><b>${s.label}</b></td><td class="small">${s.mide}</td><td class="small">${s.anticipa}</td><td class="r num">${s.max}</td></tr>`)}
        </tbody></table></div>
      </div>
      <div>
        <div class="card">
          <div class="card-head"><div><h2>¿Qué tan bien anticipa?</h2><p>Backtest de los últimos 6 meses con los datos disponibles 10 días antes de cada vencimiento</p></div></div>
          <div class="grid g-2">
            <div class="kpi"><span class="label">Precisión</span><span class="value">${pct(p.precision, 0)}</span><span class="sub">${p.aciertos} de ${p.alertas} alertas altas se atrasaron</span></div>
            <div class="kpi"><span class="label">Cobertura</span><span class="value">${pct(p.cobertura, 0)}</span><span class="sub">${p.detectados} de ${p.atrasos} atrasos fueron anticipados</span></div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Una acción para cada nivel</h2></div></div>
          <table><tbody>${['bajo', 'medio', 'alto'].map((n) => h`<tr><td>${nivelPill(n)}</td><td class="small">${d.prevencion[n].accion}</td><td class="small nowrap">${CANAL[d.prevencion[n].canal]} · ${d.prevencion[n].dias} días antes</td></tr>`)}</tbody></table>
        </div>
      </div>
    </div>
    <div class="card mt">
      <div class="card-head"><div><h2>Puntaje por familia</h2><p>Aporte de cada señal al puntaje actual</p></div></div>
      <div class="table-wrap"><table><thead><tr><th>Familia</th><th>Puntaje</th>${d.senales.map((s) => h`<th class="r" title="${s.label}">${s.label.split(' ')[0]}</th>`)}<th>Motivo</th></tr></thead><tbody>
        ${d.familias.map((f) => h`<tr class="link" data-href="#/familias/${f.id}"><td><b>${f.apellido}</b> ${nivelPill(f.riesgo.nivel)}</td><td>${scoreCell(f.riesgo)}</td>
          ${f.factores.map((x) => h`<td class="r num small ${x.puntos ? '' : 'muted'}">${x.puntos ? Math.round(x.puntos) : '·'}</td>`)}<td class="small">${f.riesgo.motivo}</td></tr>`)}
      </tbody></table></div>
    </div>`);
  bindLinks();
}

// ---------- Configuración ----------
async function pageConfig() {
  const { settings: s, hoy } = await api('/api/config');
  main.innerHTML = String(h`
    <div class="page-head"><div><div class="eyebrow">Configuración</div><h1>Parámetros de la escuela</h1>
      <p>Los plazos, canales y umbrales son una propuesta inicial y se ajustan a la política de cada escuela.</p></div></div>
    <div class="grid g-21">
      <form class="card" id="cfg">
        <div class="form-grid">
          <label class="field full">Nombre de la escuela<input name="escuela_nombre" value="${s.escuela_nombre}" required></label>
          <label class="field">Arancel mensual por alumno ($)<input name="arancel_mensual" type="number" min="0" value="${s.arancel_mensual}"></label>
          <label class="field">Descuento por hermano (%)<input name="descuento_hermano_pct" type="number" min="0" max="100" value="${s.descuento_hermano_pct}"></label>
          <label class="field">Día de vencimiento<input name="dia_vencimiento" type="number" min="1" max="28" value="${s.dia_vencimiento}"></label>
          <span></span>
          <label class="field">Umbral riesgo medio<input name="umbral_medio" type="number" min="1" max="99" value="${s.umbral_medio}"></label>
          <label class="field">Umbral riesgo alto<input name="umbral_alto" type="number" min="2" max="100" value="${s.umbral_alto}"></label>
          <label class="field full">Fecha simulada <small>Para demos: el sistema se comporta como si hoy fuera esta fecha. Vacío = fecha real.</small>
            <input name="fecha_simulada" type="date" value="${s.fecha_simulada}"></label>
        </div>
        <div class="error" id="cfg-error" role="alert"></div>
        <div class="btn-row mt"><button class="btn primary">Guardar</button><span class="muted small">Hoy para el sistema: ${fdate(hoy)}</span></div>
      </form>
      <div>
        <div class="card">
          <h2>Principios de uso</h2>
          <div class="principles mt">
            <div><b>Decisión humana</b>El puntaje orienta; la administración decide cómo actuar con cada familia.</div>
            <div><b>Sin datos sensibles</b>No se usan datos de salud, religión ni ideología; sólo hábitos de pago y contacto.</div>
            <div><b>El alumno, primero</b>Nunca se condiciona la asistencia ni se expone a los chicos por la deuda.</div>
            <div><b>Datos protegidos</b>Ley 25.326 de Protección de Datos Personales y consentimiento de las familias.</div>
          </div>
        </div>
        <div class="card">
          <h2>Datos de demostración</h2>
          <p class="small muted">Borra todo y vuelve a cargar 64 familias ficticias con un año y medio de historia.</p>
          <button class="btn" id="reset">Restablecer datos de demo</button>
        </div>
      </div>
    </div>`);
  $('#cfg').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/config', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
      toast('Configuración guardada');
      reload();
    } catch (err) { $('#cfg-error').textContent = err.message; }
  });
  $('#reset').addEventListener('click', async () => {
    if (!confirm('Se borrarán todos los datos y se cargarán los de demostración. ¿Continuar?')) return;
    await api('/api/demo/reset', { method: 'POST' });
    toast('Datos de demostración restablecidos');
    location.hash = '#/';
    reload();
  });
}

document.addEventListener('DOMContentLoaded', reload);
