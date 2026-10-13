'use strict';
/* Inteligencia de cobranza: los ocho aportes del machine learning de la presentación.
   Usa las utilidades globales de app.js, escolar.js y cobranzas.js. */

const SEG_COLOR = { puntual: 'var(--ok)', tardio: 'var(--warn)', transitoria: 'var(--brand-2)', cronico: 'var(--bad)' };
const segPill = (key, label) => h`<span class="pill seg-${key}">${label || SEG_LABEL[key]}</span>`;
const SEG_LABEL = { puntual: 'Pagador puntual', tardio: 'Tardío recurrente', transitoria: 'Dificultad transitoria', cronico: 'Riesgo de deuda crónica' };
const probPill = (p) => h`<span class="pill ${p >= 0.5 ? 'bad' : p >= 0.25 ? 'warn' : 'ok'}">${pct(p, 0)}</span>`;
const auc2 = (v) => (v == null ? '—' : v.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

const ML_TABS = [
  ['modelo', '1 · Predicción de riesgo'],
  ['segmentos', '2-3 · Segmentos y contacto'],
  ['prioridad', '4 · Priorización'],
  ['caja', '5 · Flujo de caja'],
  ['anomalias', '6 · Anomalías'],
  ['bajas', '7 · Riesgo de baja'],
  ['escenarios', '8 · Escenarios'],
];

routes.ml = pageML;
let segFiltro = '';

async function pageML(tab) {
  const t = ML_TABS.some(([k]) => k === tab) ? tab : 'prioridad';
  const d = await api('/api/ml');
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Machine learning</div><h1>Inteligencia de cobranza</h1>
      <p>Pasar de llamar cuando ya hay deuda a actuar antes de que aparezca. Los modelos se entrenan con el historial de la escuela y se recalculan solos cuando cambian los datos.</p>
    </div></div>
    <div class="tabs ml-tabs" role="tablist">${ML_TABS.map(([k, l]) => h`<a class="${k === t ? 'on' : ''}" href="#/ml/${k}" role="tab">${l}</a>`)}</div>
    <div id="ml-body"></div>
    <p class="small muted mt">Resultados calculados sobre los datos de demostración (ficticios). Con datos reales, los números se recalculan; las metas se fijan con la dirección.</p>`);
  const body = $('#ml-body');
  ({ modelo: mlModelo, segmentos: mlSegmentos, prioridad: mlPrioridad, caja: mlCaja, anomalias: mlAnomalias, bajas: mlBajas, escenarios: mlEscenarios })[t](body, d);
  bindLinks(body);
  bindCsv(body);
}

// ---------- 1. Predicción de riesgo ----------
function mlModelo(el, d) {
  const m = d.modelo, ev = m.evaluacion;
  const maxPeso = Math.max(...m.pesos.map((p) => Math.abs(p.peso))) || 1;
  el.innerHTML = String(h`
    <div class="grid g-4">
      <div class="card kpi"><span class="label">Capacidad de anticipar (AUC)</span><span class="value">${ev ? auc2(ev.ml.auc) : '—'}</span>
        <span class="sub">Modelo ML · reglas actuales: ${ev ? auc2(ev.reglas.auc) : '—'}. Va de 0,5 (azar) a 1 (perfecto).</span></div>
      <div class="card kpi"><span class="label">Precisión de las alertas</span><span class="value">${ev ? pct(ev.ml.precision, 0) : '—'}</span>
        <span class="sub">Con ${ev ? ev.alertas : '—'} alertas, igual que las reglas (${ev ? pct(ev.reglas.precision, 0) : '—'}).</span></div>
      <div class="card kpi"><span class="label">Morosos anticipados</span><span class="value">${ev ? pct(ev.ml.cobertura, 0) : '—'}</span>
        <span class="sub">De ${ev ? ev.atrasos : '—'} atrasos de más de 10 días en los últimos 6 meses.</span></div>
      <div class="card kpi"><span class="label">Historia usada</span><span class="value">${m.observaciones}</span>
        <span class="sub">cuotas con resultado conocido · tasa base de atraso ${pct(m.tasa_base, 0)}</span></div>
    </div>
    <div class="grid g-21 mt">
      <div class="card">
        <div class="card-head"><div><h2>Probabilidad de atraso por familia</h2><p>Que la próxima cuota se pague con más de 10 días de atraso · con los motivos que más pesan</p></div>${csvBtn('t-ml-fam', 'probabilidad-de-atraso')}</div>
        <div class="table-wrap"><table id="t-ml-fam"><thead><tr><th>Familia</th><th>Probabilidad</th><th class="r">Puntaje reglas</th><th>Segmento</th><th>Por qué</th></tr></thead><tbody>
          ${m.familias.slice(0, 25).map((f) => h`<tr class="link" data-href="#/familias/${f.id}"><td><b>${f.apellido}</b><div class="small muted">${f.responsable}</div></td>
            <td>${probPill(f.prob)}</td><td class="r num">${f.reglas}</td><td>${segPill(f.segmento)}</td><td class="small">${f.motivos.join(', ') || 'sin señales de riesgo'}</td></tr>`)}
        </tbody></table></div>
        <p class="small muted">Se muestran las 25 familias con mayor probabilidad.</p>
      </div>
      <div>
        <div class="card">
          <div class="card-head"><div><h2>Qué mira el modelo</h2><p>Peso de cada variable: a la derecha sube el riesgo, a la izquierda lo baja</p></div></div>
          ${m.pesos.map((p) => h`<div class="peso"><span class="small">${p.label}</span>
            <span class="peso-bar"><i class="${p.peso >= 0 ? 'pos' : 'neg'}" style="width:${(Math.abs(p.peso) / maxPeso) * 50}%"></i></span></div>`)}
          <p class="small muted mt">Sólo datos de pago, contacto y matrícula: nada de salud, religión ni ideología.</p>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>Cómo se validó</h2></div></div>
          <p class="small" style="margin:0">Se entrenó con ${ev ? ev.entrenamiento : '—'} cuotas anteriores y se probó con las ${ev ? ev.prueba : '—'} de los últimos 6 meses, usando en cada caso sólo lo que se sabía 10 días antes del vencimiento. Mismo método para las reglas, para comparar de igual a igual.</p>
        </div>
      </div>
    </div>`);
}

// ---------- 2-3. Segmentos y estrategia de contacto ----------
function mlSegmentos(el, d) {
  const total = d.segmentos.reduce((a, s) => a + s.familias, 0) || 1;
  const sel = d.segmentos.find((s) => s.key === segFiltro);
  const lista = sel ? sel.lista : d.segmentos.flatMap((s) => s.lista.map((f) => ({ ...f, seg: s.key })));
  el.innerHTML = String(h`
    <div class="grid g-4">${d.segmentos.map((s) => h`<button class="card seg-card ${segFiltro === s.key ? 'on' : ''}" data-seg="${s.key}">
      <span class="seg-dot" style="background:${raw(SEG_COLOR[s.key])}"></span>
      <span class="label">${s.label}</span>
      <span class="value">${s.familias}</span>
      <span class="sub">${pct(s.familias / total, 0)} de las familias · deuda ${moneyK(s.deuda)}${s.estacionales ? ` · ${s.estacionales} estacional(es)` : ''}</span>
      <span class="estrategia"><b>Estrategia:</b> ${s.estrategia}</span>
    </button>`)}</div>
    <div class="card mt">
      <div class="card-head"><div><h2>${sel ? sel.label : 'Todas las familias'}</h2><p>Segmento según cómo pagó en los últimos 12 meses. Tocá un segmento para filtrar.</p></div>
        <div class="btn-row">${sel ? h`<button class="btn sm" data-seg="">Ver todas</button>` : ''}${csvBtn('t-seg', 'segmentos')}</div></div>
      <div class="table-wrap"><table id="t-seg"><thead><tr><th>Familia</th><th>Segmento</th><th>Por qué</th><th>Probabilidad</th><th class="r">Deuda</th></tr></thead><tbody>
        ${lista.map((f) => h`<tr class="link" data-href="#/familias/${f.id}"><td><b>${f.apellido}</b><div class="small muted">${f.responsable}</div></td>
          <td>${segPill(f.seg || segFiltro)}${f.estacional ? h` <span class="pill plain">estacional</span>` : ''}</td><td class="small">${f.motivo}</td><td>${probPill(f.prob)}</td>
          <td class="r num">${f.deuda ? money(f.deuda) : '—'}</td></tr>`)}
      </tbody></table></div>
    </div>`);
  $$('[data-seg]', el).forEach((b) => b.addEventListener('click', () => { segFiltro = segFiltro === b.dataset.seg ? '' : b.dataset.seg; mlSegmentos(el, d); bindLinks(el); bindCsv(el); }));
}

// ---------- 4. Priorización ----------
function mlPrioridad(el, d) {
  const p = d.priorizacion;
  el.innerHTML = String(h`
    <div class="card">
      <div class="card-head"><div><h2>Las ${p.lista.length} familias a contactar esta semana</h2>
        <p>Pensado para equipos chicos: primero, donde un contacto rinde más. Ordenado por monto en juego × probabilidad: para cobrar, la de recuperar la deuda en 30 días; para prevenir, la de que la próxima cuota se atrase.${p.en_pausa ? ` ${p.en_pausa} familia(s) quedan en pausa por una promesa de pago vigente.` : ''}</p></div>
        <div class="btn-row">${csvBtn('t-prio', 'familias-a-contactar')}<a class="btn sm" href="#/cobranza">Ir a la bandeja</a></div></div>
      ${p.lista.length ? h`<div class="table-wrap"><table id="t-prio"><thead><tr><th class="r">#</th><th>Familia</th><th>Gestión</th><th>Segmento</th><th class="r">Monto en juego</th><th>Probabilidad</th><th class="r">Valor esperado</th><th>Estrategia sugerida</th></tr></thead><tbody>
        ${p.lista.map((f, i) => h`<tr class="link" data-href="#/familias/${f.id}"><td class="r num"><b>${i + 1}</b></td>
          <td><b>${f.apellido}</b><div class="small muted">${f.responsable}</div></td>
          <td>${f.gestion === 'cobrar' ? h`<span class="pill bad">Cobrar deuda</span>` : h`<span class="pill warn">Prevenir atraso</span>`}</td>
          <td>${segPill(f.segmento)}${f.plan_activo ? h` <span class="pill plain">plan</span>` : ''}</td>
          <td class="r num">${money(f.monto)}<div class="small muted">${f.gestion === 'cobrar' ? `${f.max_atraso} días de atraso` : `vence ${fdate(f.vence)}`}</div></td>
          <td><span class="relbar"><span class="bar"><i style="width:${f.prob * 100}%"></i></span><span class="num">${pct(f.prob, 0)}</span></span>
            <div class="small muted">${f.gestion === 'cobrar' ? 'de recuperar' : 'de atraso'}</div></td>
          <td class="r num"><b>${money(f.esperado)}</b></td><td class="small">${f.estrategia}</td></tr>`)}
      </tbody></table></div>` : h`<div class="empty">No hay familias para gestionar esta semana.</div>`}
      <p class="small muted mt">${p.cobrar} familia(s) con deuda y ${p.prevenir} al día con riesgo de atraso; se muestran las ${p.lista.length} de mayor valor esperado.</p>
    </div>`);
}

// ---------- 5. Flujo de caja ----------
function mlCaja(el, d) {
  const f = d.flujo;
  const datos = [
    ...f.historico.map((x) => ({ label: fperiodo(x.mes), title: `${fperiodo(x.mes)} · real`, real: x.cobrado, extra: ['Facturado', money(x.facturado)] })),
    ...f.proyeccion.map((x) => ({ label: fperiodo(x.mes) + (x.mes === d.hoy.slice(0, 7) ? '*' : ''), title: `${fperiodo(x.mes)} · proyectado`, ya: x.ya_cobrado, mes: x.del_mes, arrastre: x.arrastre, recupero: x.recupero, extra: ['Facturado', money(x.facturado)] })),
  ];
  const segs = Object.entries(f.patrones).filter(([k]) => k !== 'todas');
  el.innerHTML = String(h`
    <div class="grid g-3">${f.proyeccion.map((x) => h`<div class="card kpi"><span class="label">${fperiodo(x.mes)}${x.proyectado ? ' · aranceles proyectados' : ''}</span>
      <span class="value">${moneyK(x.esperado)}</span><span class="sub">cobro esperado · facturado ${moneyK(x.facturado)}</span></div>`)}</div>
    <div class="card mt">
      <div class="card-head"><div><h2>Cobrado real y proyectado</h2><p>Últimos 6 meses reales y los próximos 3 estimados con el patrón de cobro de cada segmento y el modelo de recupero</p></div></div>
      <div id="ch-flujo"></div>
      <p class="small muted">* Mes en curso: suma lo ya cobrado más lo que se espera cobrar hasta fin de mes.</p>
    </div>
    <div class="mt">
      <div class="card"><div class="card-head"><div><h2>Detalle de la proyección</h2></div>${csvBtn('t-flujo', 'proyeccion-de-caja')}</div>
        <div class="table-wrap"><table id="t-flujo"><thead><tr><th>Mes</th><th class="r">Facturado</th><th class="r">Ya cobrado</th><th class="r">Del mes</th><th class="r">Del mes anterior</th><th class="r">Deuda vieja</th><th class="r">Esperado</th></tr></thead><tbody>
          ${f.proyeccion.map((x) => h`<tr><td>${fperiodo(x.mes)}</td><td class="r num">${money(x.facturado)}</td><td class="r num">${money(x.ya_cobrado)}</td><td class="r num">${money(x.del_mes)}</td>
            <td class="r num">${money(x.arrastre)}</td><td class="r num">${money(x.recupero)}</td><td class="r num"><b>${money(x.esperado)}</b></td></tr>`)}
        </tbody></table></div></div>
      <div class="card"><div class="card-head"><div><h2>Cómo cobra cada segmento</h2><p>Del total facturado, qué parte entró en el mes del vencimiento, al mes siguiente o más tarde (12 meses)</p></div></div>
        <table><thead><tr><th>Segmento</th><th class="r">En el mes</th><th class="r">Mes siguiente</th><th class="r">Más tarde o impago</th></tr></thead><tbody>
          ${segs.map(([k, p]) => h`<tr><td>${segPill(k)}</td><td class="r num">${pct(p.mes, 0)}</td><td class="r num">${pct(p.siguiente, 0)}</td><td class="r num">${pct(p.tarde, 0)}</td></tr>`)}
        </tbody></table></div>
    </div>`);
  columnChart($('#ch-flujo', el), datos, [
    { key: 'real', label: 'Cobrado real', color: 'var(--brand-2)' },
    { key: 'ya', label: 'Ya cobrado (mes en curso)', color: 'var(--ok)' },
    { key: 'mes', label: 'Esperado del mes', color: 'var(--teal)' },
    { key: 'arrastre', label: 'Del mes anterior', color: 'var(--warn)' },
    { key: 'recupero', label: 'Recupero de deuda vieja', color: 'var(--bad)' },
  ]);
}

// ---------- 6. Anomalías ----------
function mlAnomalias(el, d) {
  const a = d.anomalias;
  const comp = a.filter((x) => x.tipo === 'comportamiento'), fact = a.filter((x) => x.tipo === 'facturacion');
  const item = (x) => h`<div class="anomalia ${x.gravedad}">
    <div class="anomalia-top"><span class="pill ${x.gravedad === 'alta' ? 'bad' : 'warn'}">${x.titulo}</span><a href="#/familias/${x.id}"><b>${x.apellido}</b></a><span class="small muted">${x.responsable}</span></div>
    <p>${x.detalle}</p><p class="small"><b>Sugerencia:</b> ${x.sugerencia}</p></div>`;
  el.innerHTML = String(h`
    <div class="grid g-2">
      <div class="card"><div class="card-head"><div><h2>Cambios de comportamiento</h2><p>Familias que se apartan de su propio historial</p></div></div>
        ${comp.length ? comp.map(item) : h`<div class="empty">Sin cambios bruscos.</div>`}</div>
      <div class="card"><div class="card-head"><div><h2>Facturación</h2><p>Importes que no coinciden con alumnos, becas y descuentos; cobros duplicados</p></div></div>
        ${fact.length ? fact.map(item) : h`<div class="empty">Sin inconsistencias.</div>`}</div>
    </div>`);
}

// ---------- 7. Riesgo de baja ----------
function mlBajas(el, d) {
  const b = d.bajas;
  el.innerHTML = String(h`
    <div class="notice">Uso exclusivo de dirección para acompañar y retener: nunca condiciona la asistencia ni expone a los chicos. La asistencia no forma parte del puntaje de cobranza.</div>
    <div class="card">
      <div class="card-head"><div><h2>Familias con señales de baja</h2><p>Cruce de deuda, inasistencias, reclamos y pedidos de pase</p></div>${csvBtn('t-bajas', 'riesgo-de-baja')}</div>
      ${b.length ? h`<div class="table-wrap"><table id="t-bajas"><thead><tr><th>Familia</th><th>Riesgo</th><th>Señales</th><th>Alumnos</th><th>Acción sugerida</th></tr></thead><tbody>
        ${b.map((f) => h`<tr class="link" data-href="#/familias/${f.id}"><td><b>${f.apellido}</b><div class="small muted">${f.responsable}</div></td>
          <td>${nivelPill(f.nivel)} <span class="num small">${f.puntaje}</span></td><td class="small">${f.motivos.join(' · ')}</td>
          <td class="small">${f.alumnos.join(', ')}</td><td class="small">${f.accion}</td></tr>`)}
      </tbody></table></div>` : h`<div class="empty">No hay familias con señales de baja.</div>`}
      <p class="small muted mt">Los reclamos y pedidos de pase se registran desde la ficha de la familia (Más acciones).</p>
    </div>`);
}

// ---------- 8. Simulación de escenarios ----------
const supuestos = { puntual: 0.5, tardio: 1.5, transitoria: 4, cronico: 3, plan: 40 };
const escenario = { aumento: 10, tramos: '1', descuento: 0, adhesion: 30, plan: false };

function simular(segs, e, s) {
  const meses = 10;
  const res = { base: { fact: 0, cobro: 0, mora: 0, desc: 0 }, esc: { fact: 0, cobro: 0, mora: 0, desc: 0 }, segs: [] };
  for (const g of segs) {
    const fact0 = g.mensual * meses;
    const imp0 = g.tarde;
    const fact1 = fact0 * (1 + e.aumento / 100);
    let imp1 = Math.min(0.95, imp0 + (s[g.key] / 100) * (e.aumento / 10) * (e.tramos === '2' ? 0.6 : 1));
    if (e.plan && g.key === 'transitoria') imp1 *= 1 - s.plan / 100;
    // Descuento por pago anticipado: sólo puntuales y tardíos; quienes adhieren pagan a término
    const adh = ['puntual', 'tardio'].includes(g.key) && e.descuento > 0 ? e.adhesion / 100 : 0;
    const desc = fact1 * adh * (e.descuento / 100);
    imp1 *= 1 - adh;
    res.base.fact += fact0; res.base.mora += fact0 * imp0; res.base.cobro += fact0 * (1 - imp0);
    res.esc.fact += fact1; res.esc.mora += fact1 * imp1; res.esc.desc += desc; res.esc.cobro += fact1 * (1 - imp1) - desc;
    res.segs.push({ ...g, imp0, imp1, cobro0: fact0 * (1 - imp0), cobro1: fact1 * (1 - imp1) - desc });
  }
  return res;
}

function mlEscenarios(el, d) {
  const segs = d.simulacion.segmentos;
  const pinta = () => {
    const r = simular(segs, escenario, supuestos);
    const mora = (x) => (x.fact ? x.mora / x.fact : 0);
    $('#sim-res').innerHTML = String(h`
      <div class="grid g-4">
        <div class="card kpi"><span class="label">Facturación anual</span><span class="value">${moneyK(r.esc.fact)}</span><span class="sub">hoy ${moneyK(r.base.fact)}</span></div>
        <div class="card kpi"><span class="label">Morosidad esperada</span><span class="value">${pct(mora(r.esc), 1)}</span><span class="sub">hoy ${pct(mora(r.base), 1)} · ${mora(r.esc) >= mora(r.base) ? '+' : ''}${((mora(r.esc) - mora(r.base)) * 100).toLocaleString('es-AR', { maximumFractionDigits: 1 })} pp</span></div>
        <div class="card kpi"><span class="label">Cobro esperado</span><span class="value">${moneyK(r.esc.cobro)}</span><span class="sub">hoy ${moneyK(r.base.cobro)}${r.esc.desc ? ` · descuentos ${moneyK(r.esc.desc)}` : ''}</span></div>
        <div class="card kpi"><span class="label">Diferencia de caja</span><span class="value ${r.esc.cobro >= r.base.cobro ? 'pos' : 'neg'}">${r.esc.cobro >= r.base.cobro ? '+' : '−'}${moneyK(Math.abs(r.esc.cobro - r.base.cobro))}</span><span class="sub">en el ciclo (10 cuotas)</span></div>
      </div>
      <div class="card mt"><div class="card-head"><div><h2>Impacto por segmento</h2></div></div>
        <div class="table-wrap"><table><thead><tr><th>Segmento</th><th class="r">Familias</th><th class="r">Impago hoy</th><th class="r">Impago esperado</th><th class="r">Cobro hoy</th><th class="r">Cobro esperado</th></tr></thead><tbody>
          ${r.segs.map((g) => h`<tr><td>${segPill(g.key)}</td><td class="r num">${g.familias}</td><td class="r num">${pct(g.imp0, 1)}</td><td class="r num">${pct(g.imp1, 1)}</td>
            <td class="r num">${money(g.cobro0)}</td><td class="r num">${money(g.cobro1)}</td></tr>`)}
        </tbody></table></div></div>`);
  };
  el.innerHTML = String(h`
    <div class="grid g-21">
      <form class="card" id="sim-form" onsubmit="return false">
        <div class="card-head"><div><h2>Escenario</h2><p>Ejemplo: la escuela evalúa un aumento de cuota</p></div></div>
        <div class="form-grid">
          <label class="field">Aumento de cuota (%)<input type="number" id="s-aumento" min="0" max="80" step="1" value="${escenario.aumento}"></label>
          <label class="field">Cómo se aplica<select id="s-tramos"><option value="1" ${escenario.tramos === '1' ? 'selected' : ''}>Todo junto en marzo</option><option value="2" ${escenario.tramos === '2' ? 'selected' : ''}>En dos tramos</option></select></label>
          <label class="field">Descuento por pago anticipado (%)<input type="number" id="s-descuento" min="0" max="20" step="1" value="${escenario.descuento}"></label>
          <label class="field">Adhesión al pago anticipado (%) <small>Supuesto, sobre puntuales y tardíos</small><input type="number" id="s-adhesion" min="0" max="100" step="5" value="${escenario.adhesion}"></label>
          <label class="field check full"><input type="checkbox" id="s-plan" ${escenario.plan ? 'checked' : ''}> Ofrecer plan de pagos temprano a familias en dificultad transitoria</label>
        </div>
      </form>
      <div class="card">
        <div class="card-head"><div><h2>Supuestos</h2><p>A calibrar con la respuesta real a aumentos anteriores</p></div></div>
        <p class="small" style="margin-top:0">Puntos de impago que suma cada 10% de aumento:</p>
        <div class="form-grid">${['puntual', 'tardio', 'transitoria', 'cronico'].map((k) => h`<label class="field">${SEG_LABEL[k]}<input type="number" class="s-sup" data-k="${k}" min="0" max="20" step="0.5" value="${supuestos[k]}"></label>`)}
          <label class="field full">Reducción del impago con plan temprano (%)<input type="number" class="s-sup" data-k="plan" min="0" max="100" step="5" value="${supuestos.plan}"></label></div>
      </div>
    </div>
    <div id="sim-res" class="mt"></div>`);
  const leer = () => {
    escenario.aumento = Number($('#s-aumento').value) || 0;
    escenario.tramos = $('#s-tramos').value;
    escenario.descuento = Number($('#s-descuento').value) || 0;
    escenario.adhesion = Number($('#s-adhesion').value) || 0;
    escenario.plan = $('#s-plan').checked;
    $$('.s-sup', el).forEach((i) => { supuestos[i.dataset.k] = Number(i.value) || 0; });
    pinta();
  };
  $$('input, select', el).forEach((i) => i.addEventListener('input', leer));
  pinta();
}
