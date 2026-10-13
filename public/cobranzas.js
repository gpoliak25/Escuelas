'use strict';
/* Gestión de cobranzas: cobros con recibo, caja, deudores por antigüedad, débito automático,
   notas de crédito, cargos, recargos y promesas de pago. Usa las utilidades globales de app.js. */

const MEDIO_COBRO = { efectivo: 'Efectivo', transferencia: 'Transferencia', debito: 'Débito automático', tarjeta: 'Tarjeta', online: 'Pago online', cheque: 'Cheque', nota_credito: 'Nota de crédito' };
const TIPO_CARGO = { arancel: 'Arancel', plan: 'Plan de pagos', cargo: 'Cargo', recargo: 'Recargo' };
const ESTADO_COBRO = { vigente: 'Vigente', anulado: 'Anulado', rechazado: 'Rechazado' };
const ESTADO_PROMESA = { pendiente: 'Vigente', cumplida: 'Cumplida', incumplida: 'Incumplida' };

routes.caja = pageCaja;
routes.deudores = pageDeudores;
routes.debitos = pageDebitos;

const tipoPill = (t) => h`<span class="pill plain tipo-${t}">${TIPO_CARGO[t] || t}</span>`;
const promesaPill = (e) => h`<span class="pill ${e === 'cumplida' ? 'ok' : e === 'incumplida' ? 'bad' : 'warn'}">${ESTADO_PROMESA[e]}</span>`;
const cobroPill = (e) => h`<span class="pill ${e === 'vigente' ? 'ok' : e === 'rechazado' ? 'bad' : 'plain'}">${ESTADO_COBRO[e]}</span>`;
const linkRecibo = (c, texto = 'Ver recibo') => (c.estado === 'rechazado' ? '' : h`<a class="btn sm" href="/recibos/${c.id}" target="_blank" rel="noopener">${texto}</a>`);

/** Ventana informativa (sin formulario). */
function openInfo({ title, body }) {
  modal.style.width = '';
  modal.innerHTML = String(h`<div class="modal-head"><h2>${title}</h2><button type="button" class="btn ghost sm" data-close aria-label="Cerrar">✕</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot"><button type="button" class="btn primary" data-close>Listo</button></div>`);
  $$('[data-close]', modal).forEach((b) => b.addEventListener('click', () => { modal.close(); reload(); }));
  modal.showModal();
}

function resultadoCobro(r, titulo = 'Cobro registrado') {
  return () => openInfo({
    title: titulo,
    body: h`<p style="margin-top:0">Comprobante <b class="num">${r.comprobante}</b></p>
      ${r.imputaciones.length ? h`<table><thead><tr><th>Imputado a</th><th class="r">Importe</th></tr></thead><tbody>
        ${r.imputaciones.map((i) => h`<tr><td>${i.concepto}</td><td class="r num">${money(i.monto)}</td></tr>`)}</tbody></table>` : ''}
      ${r.saldo_a_favor > 0 ? h`<p class="notice" style="margin:12px 0 0">Quedan <b>${money(r.saldo_a_favor)}</b> de saldo a favor: se aplicarán automáticamente a las próximas cuotas.</p>` : ''}
      <div class="btn-row mt"><a class="btn" href="/recibos/${r.id}" target="_blank" rel="noopener">Ver e imprimir el comprobante</a></div>`,
  });
}

// ---------- Cobro con imputación ----------
function opcionesMedio(sel) {
  return Object.entries(MEDIO_COBRO).filter(([k]) => k !== 'nota_credito')
    .map(([k, l]) => h`<option value="${k}" ${k === sel ? 'selected' : ''}>${l}</option>`);
}

/** Simula la imputación tal como la hace el servidor: el cargo más antiguo primero. */
function simularImputacion(abiertas, monto, ids) {
  const lista = ids ? ids.map((id) => abiertas.find((c) => c.id === id)).filter(Boolean) : abiertas;
  let resto = Math.round(monto || 0);
  const out = [];
  for (const c of lista) {
    if (resto <= 0) break;
    const m = Math.min(resto, c.saldo);
    out.push({ c, m });
    resto -= m;
  }
  return { out, resto };
}

function modalCobro(d, { cuotaId } = {}) {
  const abiertas = d.abiertas;
  const vencido = abiertas.filter((c) => c.estado === 'vencida').reduce((a, c) => a + c.saldo, 0);
  const sugerido = cuotaId ? abiertas.find((c) => c.id === cuotaId)?.saldo : vencido || abiertas[0]?.saldo || '';
  const medioDefault = { debito: 'debito', online: 'online', tarjeta: 'tarjeta', efectivo: 'efectivo' }[d.familia.medio_pago] || 'transferencia';
  openModal({
    title: `Registrar cobro · Familia ${d.familia.apellido}`,
    wide: true,
    submit: 'Registrar cobro y emitir recibo',
    body: h`<div class="form-grid">
        <label class="field">Importe recibido<input name="monto" id="cb-monto" type="number" min="1" step="1" value="${sugerido}" required></label>
        <label class="field">Fecha<input name="fecha" type="date" value="${d.hoy}" max="${d.hoy}" required></label>
        <label class="field">Medio de pago<select name="medio">${opcionesMedio(medioDefault)}</select></label>
        <label class="field">Referencia <small>N° de operación, cheque o comprobante</small><input name="referencia" maxlength="120"></label>
      </div>
      <h3 class="form-sec">Imputación</h3>
      <div class="seg" role="radiogroup" aria-label="Imputación" style="margin-bottom:10px">
        <label class="seg-opt"><input type="radio" name="modo" value="auto" ${cuotaId ? '' : 'checked'}> Automática (deuda más antigua primero)</label>
        <label class="seg-opt"><input type="radio" name="modo" value="manual" ${cuotaId ? 'checked' : ''}> Elegir cargos</label>
      </div>
      ${abiertas.length ? h`<div class="table-wrap"><table class="imput"><thead><tr><th></th><th>Cargo</th><th>Vencimiento</th><th class="r">Saldo</th><th class="r">Se imputa</th></tr></thead><tbody>
        ${abiertas.map((c) => h`<tr data-cid="${c.id}"><td><input type="checkbox" class="cb-sel" value="${c.id}" ${c.id === cuotaId ? 'checked' : ''} aria-label="Imputar a ${c.concepto}"></td>
          <td>${c.concepto} ${c.tipo !== 'arancel' ? tipoPill(c.tipo) : ''}</td><td class="num">${fdate(c.vencimiento)}${c.estado === 'vencida' ? h` <span class="small muted">· ${c.atraso} d</span>` : ''}</td>
          <td class="r num">${money(c.saldo)}</td><td class="r num imp">—</td></tr>`)}
      </tbody></table></div>` : h`<p class="small muted">La familia no tiene deuda: el importe quedará como saldo a favor.</p>`}
      <p class="small" id="cb-resumen" style="margin:10px 0 0"></p>`,
    onSubmit: async (data) => {
      const manual = $('input[name=modo]:checked', modal).value === 'manual';
      const ids = $$('.cb-sel:checked', modal).map((x) => Number(x.value));
      if (manual && !ids.length) throw new Error('Elegí al menos un cargo o usá la imputación automática');
      const r = await api('/api/cobros', { method: 'POST', body: {
        familia_id: d.familia.id, monto: data.monto, fecha: data.fecha, medio: data.medio, referencia: data.referencia, cuota_ids: manual ? ids : undefined,
      } });
      return resultadoCobro(r);
    },
  });
  const actualizar = () => {
    const manual = $('input[name=modo]:checked', modal).value === 'manual';
    $$('.cb-sel', modal).forEach((x) => { x.disabled = !manual; });
    const ids = manual ? $$('.cb-sel:checked', modal).map((x) => Number(x.value)) : null;
    const { out, resto } = simularImputacion(abiertas, Number($('#cb-monto').value), ids);
    $$('tr[data-cid]', modal).forEach((tr) => {
      const it = out.find((o) => o.c.id === Number(tr.dataset.cid));
      $('.imp', tr).textContent = it ? money(it.m) : '—';
      tr.classList.toggle('sel', Boolean(it));
    });
    $('#cb-resumen').textContent = out.length
      ? `Se cancelan ${out.filter((o) => o.m >= o.c.saldo).length} cargo(s)${out.some((o) => o.m < o.c.saldo) ? ' y uno queda con pago parcial' : ''}.` + (resto > 0 ? ` Quedan ${money(resto)} como saldo a favor.` : '')
      : resto > 0 ? `${money(resto)} quedarán como saldo a favor.` : '';
  };
  $('#cb-monto').addEventListener('input', actualizar);
  $$('input[name=modo], .cb-sel', modal).forEach((x) => x.addEventListener('change', () => {
    if (x.classList.contains('cb-sel') || x.value === 'manual') {
      const ids = $$('.cb-sel:checked', modal).map((y) => Number(y.value));
      if ($('input[name=modo]:checked', modal).value === 'manual' && ids.length) {
        $('#cb-monto').value = abiertas.filter((c) => ids.includes(c.id)).reduce((a, c) => a + c.saldo, 0);
      }
    }
    actualizar();
  }));
  actualizar();
}

function modalNotaCredito(d) {
  openModal({
    title: 'Nota de crédito',
    body: h`<p class="small muted" style="margin-top:0">Para bonificaciones, descuentos acordados o correcciones. Se imputa como un pago y queda registrada con su motivo.</p>
      <div class="form-grid">
        <label class="field">Importe<input name="monto" type="number" min="1" step="1" required></label>
        <label class="field">Aplicar a<select name="cuota_id"><option value="">Deuda más antigua primero</option>
          ${d.abiertas.map((c) => h`<option value="${c.id}">${c.concepto} · saldo ${money(c.saldo)}</option>`)}</select></label>
        <label class="field full">Motivo<input name="motivo" required maxlength="300" placeholder="Ej.: bonificación por hermano ingresante"></label>
      </div>`,
    submit: 'Emitir nota de crédito',
    onSubmit: async (data) => {
      const r = await api('/api/cobros', { method: 'POST', body: {
        familia_id: d.familia.id, tipo: 'nota_credito', monto: data.monto, motivo: data.motivo, cuota_ids: data.cuota_id ? [Number(data.cuota_id)] : undefined,
      } });
      return resultadoCobro(r, 'Nota de crédito emitida');
    },
  });
}

function modalCondonar(cuota) {
  openModal({
    title: 'Condonar cargo',
    body: h`<p style="margin-top:0">Se emite una nota de crédito por <b>${money(cuota.saldo)}</b> que cancela <b>${cuota.concepto}</b>.</p>
      <label class="field">Motivo<input name="motivo" required maxlength="300" value="Condonación de recargo por mora"></label>`,
    submit: 'Condonar',
    onSubmit: async (data) => {
      const r = await api('/api/condonaciones', { method: 'POST', body: { cuota_ids: [cuota.id], motivo: data.motivo } });
      return resultadoCobro(r, 'Cargo condonado');
    },
  });
}

function modalRechazo(d) {
  const candidatas = d.abiertas.filter((c) => c.tipo !== 'recargo');
  openModal({
    title: 'Registrar débito rechazado',
    body: h`<p class="small muted" style="margin-top:0">El rechazo no cancela deuda: queda registrado en la cuenta y suma como señal de riesgo.</p>
      <div class="form-grid">
        <label class="field full">Cuota debitada<select name="cuota_id" required>${candidatas.map((c) => h`<option value="${c.id}">${c.concepto} · ${money(c.saldo)}</option>`)}</select></label>
        <label class="field">Fecha<input name="fecha" type="date" value="${d.hoy}" max="${d.hoy}" required></label>
        <label class="field">Motivo<select name="motivo">${['Fondos insuficientes', 'Cuenta cerrada o inexistente', 'Baja de la adhesión', 'Otro'].map((m) => h`<option>${m}</option>`)}</select></label>
      </div>`,
    submit: 'Registrar rechazo',
    onSubmit: async (data) => {
      await api('/api/rechazos', { method: 'POST', body: data });
      toast('Rechazo registrado');
      reload();
    },
  });
}

function modalAnularCobro(c) {
  openModal({
    title: `Anular ${c.comprobante}`,
    body: h`<p style="margin-top:0">Se anula el comprobante por <b>${money(c.monto)}</b> y la deuda que cancelaba vuelve a quedar pendiente. El comprobante se conserva marcado como anulado.</p>
      <label class="field">Motivo de la anulación<input name="motivo" required maxlength="300" placeholder="Ej.: transferencia no acreditada"></label>`,
    submit: 'Anular comprobante',
    onSubmit: async (data) => {
      await api(`/api/cobros/${c.id}/anular`, { method: 'POST', body: data });
      toast('Comprobante anulado');
      reload();
    },
  });
}

function modalPromesa(familiaId, deuda, hoy) {
  openModal({
    title: 'Promesa de pago',
    body: h`<p class="small muted" style="margin-top:0">Mientras la promesa esté vigente, la familia sale de la bandeja de cobranza. Si vence sin el pago, vuelve con prioridad.</p>
      <div class="form-grid">
        <label class="field">Importe prometido<input name="monto" type="number" min="1" step="1" value="${deuda || ''}" required></label>
        <label class="field">Fecha prometida<input name="fecha_promesa" type="date" min="${hoy}" value="${addDays(hoy, 7)}" required></label>
        <label class="field full">Nota<input name="nota" maxlength="300" placeholder="Ej.: cobra el 5; paga por transferencia"></label>
      </div>`,
    submit: 'Registrar promesa',
    onSubmit: async (data) => {
      await api('/api/promesas', { method: 'POST', body: { ...data, familia_id: familiaId } });
      toast('Promesa registrada');
      reload();
    },
  });
}

async function modalCargo({ familiaId = null } = {}) {
  const { hoy } = await api('/api/config');
  const masivo = !familiaId;
  openModal({
    title: masivo ? 'Cargo masivo' : 'Nuevo cargo',
    body: h`<p class="small muted" style="margin-top:0">Para conceptos fuera del arancel: matrícula, materiales, excursiones, seguro escolar…</p>
      <div class="form-grid">
        <label class="field full">Concepto<input name="concepto" required maxlength="120" placeholder="Ej.: Matrícula 2027"></label>
        <label class="field">Importe<input name="monto" type="number" min="1" step="1" required></label>
        <label class="field">Vencimiento<input name="vencimiento" type="date" value="${addDays(hoy, 15)}" required></label>
        ${masivo ? h`<label class="field">Se cobra<select name="alcance"><option value="alumnos">Por cada alumno activo</option><option value="todas">Una vez por familia</option></select></label>
          <label class="field">Grado<select name="grado"><option value="">Todos los grados</option>${[1, 2, 3, 4, 5, 6, 7].map((g) => h`<option value="${g}">${g}°</option>`)}</select></label>` : ''}
      </div>
      ${masivo ? h`<p class="small muted">Si una familia ya tiene un cargo con el mismo concepto y mes, no se duplica.</p>` : ''}`,
    submit: masivo ? 'Generar cargos' : 'Crear cargo',
    onSubmit: async (data) => {
      const r = await api('/api/cargos', { method: 'POST', body: masivo ? data : { ...data, alcance: 'familia', familia_id: familiaId } });
      toast(masivo ? `${r.creados} cargo(s) generados por ${money(r.total)}${r.omitidos ? ` · ${r.omitidos} ya existían` : ''}` : 'Cargo creado');
      reload();
    },
  });
}

async function liquidarRecargos() {
  const r = await api('/api/recargos');
  if (!r.activo) return toast('Los recargos por mora están desactivados en Configuración');
  if (!r.creados) return toast('No hay recargos pendientes de liquidar');
  openModal({
    title: 'Liquidar recargos por mora',
    body: h`<p style="margin-top:0">Se generarán <b>${r.creados}</b> recargo(s) por <b>${money(r.monto)}</b>: ${nf(Number(r.settings.recargo_pct), 2)}% mensual sobre el saldo de cada cuota impaga, a partir del día ${Number(r.settings.recargo_dias_gracia) + 1} después del vencimiento.</p>
      <p class="small muted">Los recargos pueden condonarse después, uno por uno o al acordar un plan de pagos.</p>`,
    submit: 'Liquidar',
    onSubmit: async () => {
      const x = await api('/api/recargos/liquidar', { method: 'POST' });
      toast(`${x.creados} recargo(s) liquidados por ${money(x.monto)}`);
      reload();
    },
  });
}

// ---------- Caja ----------
const filtrosCaja = { desde: '', hasta: '', medio: '' };

async function pageCaja() {
  const qs = new URLSearchParams(Object.entries(filtrosCaja).filter(([, v]) => v));
  const d = await api('/api/caja?' + qs);
  const t = d.totales;
  const mesAnt = (() => { const [y, m] = d.hoy.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 2, 1)); return dt.toISOString().slice(0, 7); })();
  const ultimoDia = (p) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(5, 7)), 0)).toISOString().slice(0, 10);
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Cobranzas</div><h1>Cobros y caja</h1>
      <p>Todos los comprobantes del período: recibos, notas de crédito, rechazos de débito y anulaciones.</p>
    </div><div class="btn-row">${csvBtn('t-caja', `caja-${d.desde}-${d.hasta}`)}</div></div>
    <div class="card">
      <div class="filters" style="margin:0">
        <label class="field">Desde<input type="date" id="cj-desde" value="${d.desde}" max="${d.hoy}"></label>
        <label class="field">Hasta<input type="date" id="cj-hasta" value="${d.hasta}" max="${d.hoy}"></label>
        <label class="field">Medio<select id="cj-medio"><option value="">Todos</option>${Object.entries(MEDIO_COBRO).map(([k, l]) => h`<option value="${k}" ${d.medio === k ? 'selected' : ''}>${l}</option>`)}</select></label>
        <div class="btn-row" style="align-self:end">
          <button class="btn sm" data-rango="hoy">Hoy</button><button class="btn sm" data-rango="mes">Este mes</button><button class="btn sm" data-rango="anterior">Mes anterior</button>
        </div>
      </div>
    </div>
    <div class="grid g-4 mt">
      <div class="card kpi"><span class="label">Cobrado</span><span class="value">${moneyK(t.cobrado)}</span><span class="sub">${t.recibos} recibo(s)</span></div>
      <div class="card kpi"><span class="label">Notas de crédito</span><span class="value">${moneyK(t.notas_credito)}</span><span class="sub">Bonificaciones y condonaciones</span></div>
      <div class="card kpi"><span class="label">Débitos rechazados</span><span class="value">${t.rechazados}</span><span class="sub">${money(t.monto_rechazado)}</span></div>
      <div class="card kpi"><span class="label">Anulados</span><span class="value">${t.anulados}</span><span class="sub">Comprobantes anulados en el período</span></div>
    </div>
    <div class="grid g-21 mt">
      <div class="card"><div class="card-head"><div><h2>Cobrado por día</h2><p>Recibos vigentes</p></div></div><div id="ch-caja"></div></div>
      <div class="card"><div class="card-head"><div><h2>Por medio de pago</h2></div></div>
        ${d.por_medio.length ? h`<table><tbody>${d.por_medio.map((m) => h`<tr><td>${m.label}</td>
          <td><span class="relbar"><span class="bar"><i style="width:${(m.monto / (t.cobrado || 1)) * 100}%"></i></span><span class="num">${pct(m.monto / (t.cobrado || 1), 0)}</span></span></td>
          <td class="r num">${money(m.monto)}</td></tr>`)}</tbody></table>` : h`<div class="empty">Sin cobros.</div>`}</div>
    </div>
    <div class="card mt">
      <div class="card-head"><div><h2>Comprobantes</h2><p>${d.cobros.length} en el período</p></div></div>
      ${d.cobros.length ? h`<div class="table-wrap"><table id="t-caja"><thead><tr><th>Fecha</th><th>Comprobante</th><th>Familia</th><th>Medio</th><th>Imputado a</th><th class="r">Importe</th><th>Estado</th><th></th></tr></thead><tbody>
        ${d.cobros.map((c) => h`<tr><td class="num">${fdate(c.fecha)}</td><td class="num">${c.comprobante}</td>
          <td><a href="#/familias/${c.familia_id}"><b>${c.familia}</b></a></td><td>${c.medio_label}${c.referencia ? h`<div class="small muted">${c.referencia}</div>` : ''}</td>
          <td class="small">${c.imputaciones.map((i) => i.concepto).join(' · ') || (c.a_favor ? 'Saldo a favor' : '—')}${c.estado !== 'vigente' && c.motivo ? h`<div class="muted">${c.motivo}</div>` : ''}</td>
          <td class="r num">${money(c.monto)}</td><td>${cobroPill(c.estado)}</td>
          <td class="r"><div class="btn-row" style="justify-content:flex-end;flex-wrap:nowrap">${linkRecibo(c, 'Ver')}${c.estado === 'vigente' ? h`<button class="btn ghost sm" data-anular="${c.id}">Anular</button>` : ''}</div></td></tr>`)}
      </tbody></table></div>` : h`<div class="empty">No hay comprobantes en el período.</div>`}
    </div>`);
  columnChart($('#ch-caja'), d.por_dia.map((x) => ({ label: x.fecha.slice(8, 10) + '/' + x.fecha.slice(5, 7), monto: x.monto })),
    [{ key: 'monto', label: 'Cobrado', color: 'var(--ok)' }], { height: 220 });
  const set = (k, v) => { filtrosCaja[k] = v; pageCaja(); };
  $('#cj-desde').addEventListener('change', (e) => set('desde', e.target.value));
  $('#cj-hasta').addEventListener('change', (e) => set('hasta', e.target.value));
  $('#cj-medio').addEventListener('change', (e) => set('medio', e.target.value));
  $$('[data-rango]').forEach((b) => b.addEventListener('click', () => {
    const r = b.dataset.rango;
    if (r === 'hoy') Object.assign(filtrosCaja, { desde: d.hoy, hasta: d.hoy });
    if (r === 'mes') Object.assign(filtrosCaja, { desde: d.hoy.slice(0, 7) + '-01', hasta: d.hoy });
    if (r === 'anterior') Object.assign(filtrosCaja, { desde: mesAnt + '-01', hasta: ultimoDia(mesAnt) });
    pageCaja();
  }));
  $$('[data-anular]').forEach((b) => b.addEventListener('click', () => modalAnularCobro(d.cobros.find((c) => c.id === Number(b.dataset.anular)))));
  bindCsv();
}

// ---------- Deudores por antigüedad ----------
async function pageDeudores() {
  const d = await api('/api/deudores');
  const t = d.totales;
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Cobranzas</div><h1>Deudores por antigüedad</h1>
      <p>${t.familias} familia(s) con deuda vencida por ${money(t.vencido)}, ${t.deuda_recargos ? `incluidos ${money(t.deuda_recargos)} de recargos` : 'sin recargos'}. La antigüedad se mide desde el vencimiento de cada cargo.</p>
    </div><div class="btn-row">${csvBtn('t-deudores', 'deudores-por-antiguedad')}</div></div>
    <div class="grid g-4">
      ${d.tramos.map((x) => h`<button type="button" class="card kpi tramo-card" data-tramo="${x.key}" ${t[x.key] ? '' : 'disabled'} aria-label="Ver la composición de la deuda de ${x.label}">
        <span class="label">${x.label}</span><span class="value">${moneyK(t[x.key])}</span>
        <span class="sub">${pct(t.vencido ? t[x.key] / t.vencido : 0, 0)} de la deuda vencida · ${d.filas.filter((f) => f[x.key] > 0).length} familia(s)</span>
        ${t[x.key] ? h`<span class="ver">Ver composición →</span>` : ''}</button>`)}
    </div>
    <div class="card mt">
      ${d.filas.length ? h`<div class="table-wrap"><table id="t-deudores">
        <thead><tr><th>Familia</th><th>Riesgo</th><th>Gestión</th><th>Último cobro</th>${d.tramos.map((x) => h`<th class="r">${x.label}</th>`)}<th class="r">Total vencido</th><th class="r">A vencer</th></tr></thead>
        <tbody>${d.filas.map((f) => h`<tr class="link" data-href="#/familias/${f.id}">
          <td class="nowrap"><b>${f.apellido}</b><div class="small muted">${f.responsable}</div></td>
          <td>${nivelPill(f.riesgo.nivel)}</td>
          <td class="small">${f.promesa ? h`<span class="pill warn">Promesa ${fdate(f.promesa.fecha)}</span>` : f.plan_activo ? h`<span class="pill plain">Plan activo</span>` : '—'}</td>
          <td class="num small">${fdate(f.ultimo_cobro)}</td>
          ${d.tramos.map((x) => h`<td class="r num ${f[x.key] ? '' : 'muted'}">${f[x.key] ? money(f[x.key]) : '—'}</td>`)}
          <td class="r num"><b>${money(f.vencido)}</b>${f.deuda_recargos ? h`<div class="small muted">rec. ${money(f.deuda_recargos)}</div>` : ''}</td>
          <td class="r num muted">${f.a_vencer ? money(f.a_vencer) : '—'}</td></tr>`)}
          <tr class="total"><td colspan="4"><b>Total</b></td>${d.tramos.map((x) => h`<td class="r num"><b>${money(t[x.key])}</b></td>`)}<td class="r num"><b>${money(t.vencido)}</b></td><td class="r num">${money(t.a_vencer)}</td></tr>
        </tbody></table></div>` : h`<div class="empty">No hay familias con deuda vencida.</div>`}
    </div>`);
  $$('[data-tramo]').forEach((b) => b.addEventListener('click', () => composicionTramo(d, b.dataset.tramo)));
  bindLinks();
  bindCsv();
}

/** Composición de un tramo de antigüedad: por tipo de cargo, por familia y cargo por cargo. */
function composicionTramo(d, key) {
  const tramo = d.tramos.find((x) => x.key === key);
  const items = d.detalle.filter((x) => x.tramo === key);
  const total = items.reduce((a, x) => a + x.saldo, 0);
  const sumar = (campo) => {
    const m = new Map();
    for (const x of items) m.set(x[campo], (m.get(x[campo]) || 0) + x.saldo);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const porTipo = sumar('tipo');
  const porFamilia = sumar('familia_id').map(([id, saldo]) => {
    const del = items.filter((x) => x.familia_id === id);
    return { id, familia: del[0].familia, responsable: del[0].responsable, cargos: del.length, saldo, max: Math.max(...del.map((x) => x.atraso)) };
  });
  modal.style.width = 'min(900px, calc(100vw - 32px))';
  modal.innerHTML = String(h`
    <div class="modal-head"><h2>Deuda de ${tramo.label.toLowerCase()} · ${money(total)}</h2><button type="button" class="btn ghost sm" data-close aria-label="Cerrar">✕</button></div>
    <div class="modal-body">
      <p class="small muted" style="margin-top:0">${items.length} cargo(s) impagos de ${porFamilia.length} familia(s). La antigüedad se cuenta desde el vencimiento de cada cargo.</p>
      <h3 class="form-sec">Por tipo de cargo</h3>
      <div class="comp-tipos">${porTipo.map(([tipo, saldo]) => h`<div class="comp-tipo">${tipoPill(tipo)}<b class="num">${money(saldo)}</b><span class="small muted">${pct(saldo / total, 0)}</span></div>`)}</div>
      <h3 class="form-sec mt">Por familia</h3>
      <div class="table-wrap"><table><thead><tr><th>Familia</th><th class="r">Cargos</th><th class="r">Atraso máx.</th><th class="r">Saldo</th><th>Peso en el tramo</th></tr></thead><tbody>
        ${porFamilia.map((f) => h`<tr class="link" data-fam="${f.id}"><td><b>${f.familia}</b><div class="small muted">${f.responsable}</div></td>
          <td class="r num">${f.cargos}</td><td class="r num">${f.max} d</td><td class="r num"><b>${money(f.saldo)}</b></td>
          <td><span class="relbar"><span class="bar"><i style="width:${(f.saldo / total) * 100}%"></i></span><span class="num">${pct(f.saldo / total, 0)}</span></span></td></tr>`)}
      </tbody></table></div>
      <h3 class="form-sec mt">Cargo por cargo</h3>
      <div class="table-wrap"><table id="t-tramo"><thead><tr><th>Familia</th><th>Concepto</th><th>Vencimiento</th><th class="r">Atraso</th><th class="r">Importe</th><th class="r">Saldo</th></tr></thead><tbody>
        ${items.map((x) => h`<tr class="link" data-fam="${x.familia_id}"><td>${x.familia}</td><td>${x.concepto} ${x.tipo !== 'arancel' ? tipoPill(x.tipo) : ''}</td>
          <td class="num">${fdate(x.vencimiento)}</td><td class="r num">${x.atraso} d</td><td class="r num">${money(x.monto)}</td><td class="r num"><b>${money(x.saldo)}</b></td></tr>`)}
        <tr class="total"><td colspan="5"><b>Total del tramo</b></td><td class="r num"><b>${money(total)}</b></td></tr>
      </tbody></table></div>
    </div>
    <div class="modal-foot">${csvBtn('t-tramo', `deuda-${key}`)}<button type="button" class="btn primary" data-close>Cerrar</button></div>`);
  $$('[data-close]', modal).forEach((b) => b.addEventListener('click', () => modal.close()));
  $$('[data-fam]', modal).forEach((r) => r.addEventListener('click', () => { modal.close(); location.hash = '#/familias/' + r.dataset.fam; }));
  bindCsv(modal);
  modal.showModal();
}

// ---------- Débito automático ----------
let periodoDebito = '';
async function pageDebitos() {
  const d = await api('/api/debitos' + (periodoDebito ? '?periodo=' + periodoDebito : ''));
  const total = d.items.reduce((a, x) => a + x.saldo, 0);
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Cobranzas</div><h1>Débito automático</h1>
      <p>${d.adheridas} familias adheridas. Generá el archivo del lote para el banco y, cuando llegue la respuesta, registrá qué débitos se acreditaron y cuáles se rechazaron.</p>
    </div>
    <select id="db-periodo" aria-label="Período" style="width:auto">${d.periodos.map((p) => h`<option value="${p}" ${p === d.periodo ? 'selected' : ''}>${fperiodo(p)}</option>`)}</select></div>
    <form class="card" id="form-lote">
      <div class="card-head"><div><h2>Lote de ${fperiodo(d.periodo || d.hoy.slice(0, 7))}</h2><p>${d.items.length} débito(s) pendientes por ${money(total)}</p></div>
        <div class="btn-row">${csvBtn('t-lote', `lote-debito-${d.periodo}`)}</div></div>
      ${d.items.length ? h`<div class="table-wrap"><table id="t-lote"><thead><tr><th>Familia</th><th>Concepto</th><th>Vencimiento</th><th class="r">Importe</th><th>Antecedentes</th><th>Resultado</th><th>Motivo de rechazo</th></tr></thead><tbody>
        ${d.items.map((x) => h`<tr data-cuota="${x.cuota_id}"><td><a href="#/familias/${x.familia_id}"><b>${x.apellido}</b></a><div class="small muted">${x.responsable}</div></td>
          <td>${x.concepto}</td><td class="num">${fdate(x.vencimiento)}</td><td class="r num">${money(x.saldo)}</td>
          <td class="small">${x.rechazos ? h`<span class="pill bad">${x.rechazos} rechazo(s)</span> <span class="muted">último ${fdate(x.ultimo_rechazo)}</span>` : h`<span class="muted">—</span>`}</td>
          <td><div class="seg asis" role="radiogroup" aria-label="Resultado de ${x.apellido}">
            <label class="seg-opt"><input type="radio" name="r-${x.cuota_id}" value="ok" checked> Acreditado</label>
            <label class="seg-opt"><input type="radio" name="r-${x.cuota_id}" value="rechazado"> Rechazado</label></div></td>
          <td><select class="db-motivo" disabled aria-label="Motivo de rechazo">${d.motivos.map((m) => h`<option>${m}</option>`)}</select></td></tr>`)}
      </tbody></table></div>
      <div class="btn-row mt">
        <label class="field" style="flex-direction:row;align-items:center;gap:8px">Fecha de acreditación <input type="date" id="db-fecha" value="${d.hoy}" max="${d.hoy}" style="width:auto"></label>
        <button class="btn primary">Registrar resultado del lote</button><span class="small muted" id="db-resumen"></span>
      </div>` : h`<div class="empty">No hay débitos pendientes para este período.</div>`}
    </form>
    <div class="card mt"><div class="card-head"><div><h2>Lotes procesados</h2></div></div>
      ${d.lotes.length ? h`<div class="table-wrap"><table><thead><tr><th>Lote</th><th>Período</th><th>Fecha</th><th class="r">Débitos</th><th class="r">Acreditados</th><th class="r">Rechazados</th><th class="r">Cobrado</th></tr></thead><tbody>
        ${d.lotes.map((l) => h`<tr><td>#${l.id}</td><td>${fperiodo(l.periodo)}</td><td class="num">${fdate(l.fecha)}</td><td class="r num">${l.cantidad}</td><td class="r num">${l.aceptados}</td>
          <td class="r num">${l.rechazados ? h`<span class="pill bad">${l.rechazados}</span>` : 0}</td><td class="r num">${money(l.monto)}</td></tr>`)}
      </tbody></table></div>` : h`<div class="empty">Todavía no se procesó ningún lote.</div>`}</div>`);

  const resumen = () => {
    const rech = $$('tr[data-cuota]').filter((tr) => $('input[value=rechazado]', tr).checked);
    if ($('#db-resumen')) $('#db-resumen').textContent = `${d.items.length - rech.length} acreditado(s) · ${rech.length} rechazado(s)`;
  };
  $$('tr[data-cuota]').forEach((tr) => $$('input[type=radio]', tr).forEach((r) => r.addEventListener('change', () => {
    $('.db-motivo', tr).disabled = r.value !== 'rechazado';
    resumen();
  })));
  resumen();
  $('#db-periodo').addEventListener('change', (e) => { periodoDebito = e.target.value; pageDebitos(); });
  $('#form-lote').addEventListener('submit', async (e) => {
    e.preventDefault();
    const items = $$('tr[data-cuota]').map((tr) => ({
      cuota_id: Number(tr.dataset.cuota),
      rechazado: $('input[value=rechazado]', tr).checked,
      motivo: $('.db-motivo', tr).value,
    }));
    try {
      const r = await api('/api/debitos/procesar', { method: 'POST', body: { periodo: d.periodo, fecha: $('#db-fecha').value, items } });
      toast(`Lote registrado: ${r.aceptados} acreditado(s) por ${money(r.monto)}, ${r.rechazados} rechazado(s)`);
      reload();
    } catch (err) { toast(err.message); }
  });
  bindCsv();
}
