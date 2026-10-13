'use strict';
/* Portal de familias: estado de cuenta, pago online (simulado) y pedido de plan de pagos. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const money = (n) => '$' + Math.round(n || 0).toLocaleString('es-AR');
const fdate = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
const ESTADO = { pagada: 'Pagada', pendiente: 'Por vencer', vencida: 'Vencida' };
const MEDIO = { debito: 'Débito automático', transferencia: 'Transferencia', efectivo: 'Efectivo', online: 'Pago online', tarjeta: 'Tarjeta' };
const app = $('#app');
const modal = $('#modal');

const store = {
  get() { try { return sessionStorage.getItem('portal-code') || ''; } catch { return ''; } },
  set(v) { try { v ? sessionStorage.setItem('portal-code', v) : sessionStorage.removeItem('portal-code'); } catch { /* sin storage */ } },
};
let codigo = store.get();

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Portal-Code': codigo },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Error'), { status: res.status });
  return data;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

function login(error = '') {
  $('#salir').hidden = true;
  app.innerHTML = `
    <div class="portal"><form class="card login" id="login">
      <div class="eyebrow">Portal de familias</div>
      <h1 style="margin:6px 0 8px">Ingresá a tu cuenta</h1>
      <p class="muted small" style="margin:0 0 16px">Consultá el estado de cuenta, pagá online o pedí un plan de pagos. Usá el código de acceso que te envió la escuela.</p>
      <label class="field">Código de acceso<input name="codigo" autocomplete="off" autocapitalize="characters" required placeholder="Ej.: K7P2QX" style="text-transform:uppercase;letter-spacing:.1em"></label>
      <div class="error" role="alert">${esc(error)}</div>
      <button class="btn primary mt" style="width:100%">Ingresar</button>
      <p class="small muted" style="margin:14px 0 0">Demo: los códigos de cada familia figuran en su legajo, en la administración.</p>
    </form></div>`;
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      codigo = new FormData(e.target).get('codigo').trim().toUpperCase();
      await api('/api/portal/login', { method: 'POST', body: { codigo } });
      store.set(codigo);
      render();
    } catch (err) {
      codigo = '';
      login(err.message);
    }
  });
  $('input', app).focus();
}

async function render() {
  let d;
  try { d = await api('/api/portal/estado'); } catch (e) {
    store.set(''); codigo = '';
    return login(e.status === 401 ? '' : e.message);
  }
  $('#salir').hidden = false;
  $('#escuela').textContent = d.escuela;
  document.title = `Portal de familias · ${d.escuela}`;
  const abiertas = d.cuotas.filter((c) => c.saldo > 0);
  const nombre = d.familia.responsable.split(' ')[0];

  app.innerHTML = `
    <div class="hero"><div class="in">
      <h1>Hola, ${esc(nombre)}</h1>
      <p>Familia ${esc(d.familia.apellido)} · ${d.alumnos.map((a) => `${esc(a.nombre)} (${a.grado}° grado)`).join(' · ')}</p>
    </div></div>
    <div class="portal lift">
      <div class="grid g-2">
        <div class="card kpi"><span class="label">Saldo vencido</span><span class="value">${money(d.deuda_vencida)}</span>
          <span class="sub">${d.deuda_vencida ? 'Podés pagarlo online o pedirnos un plan de pagos.' + (d.deuda_recargos ? ` Incluye ${money(d.deuda_recargos)} de recargos por mora.` : '') : d.saldo_a_favor ? `¡Estás al día! Tenés ${money(d.saldo_a_favor)} a favor para las próximas cuotas.` : '¡Estás al día! Gracias.'}</span></div>
        <div class="card kpi"><span class="label">Próximo vencimiento</span><span class="value">${d.proxima ? fdate(d.proxima.vencimiento) : '—'}</span>
          <span class="sub">${d.proxima ? `${esc(d.proxima.concepto)} · ${money(d.proxima.saldo)}` : 'No hay cuotas por vencer.'}</span></div>
      </div>

      <div class="card mt">
        <div class="card-head"><div><h2>Cuotas a pagar</h2><p>Elegí qué cuotas querés pagar</p></div></div>
        ${abiertas.length ? `
          <div class="table-wrap"><table><thead><tr><th></th><th>Concepto</th><th>Vencimiento</th><th>Estado</th><th class="r">Saldo</th></tr></thead><tbody>
          ${abiertas.map((c) => `<tr><td><input type="checkbox" data-id="${c.id}" data-saldo="${c.saldo}" checked aria-label="Pagar ${esc(c.concepto)}"></td>
            <td>${esc(c.concepto)}</td><td class="num">${fdate(c.vencimiento)}</td><td><span class="pill ${c.estado}">${ESTADO[c.estado]}</span></td><td class="r num">${money(c.saldo)}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="tot"><span>Total seleccionado <b class="num" id="total"></b></span><button class="btn accent" id="pagar">Pagar online</button></div>`
        : '<div class="empty">No tenés cuotas pendientes.</div>'}
      </div>

      <div class="grid g-2 mt">
        <div class="card">
          <h2>Débito automático</h2>
          <p class="small muted">Medio de pago actual: <b>${esc(MEDIO[d.familia.medio_pago] || d.familia.medio_pago)}</b>.</p>
          ${d.familia.medio_pago === 'debito'
            ? '<p class="small">Tus cuotas se debitan automáticamente al vencimiento.</p>'
            : '<p class="small">Olvidate de los vencimientos: la cuota se debita sola cada mes.</p><button class="btn" id="debito">Adherir al débito automático</button>'}
        </div>
        <div class="card">
          <h2>¿Necesitás ayuda con los pagos?</h2>
          ${d.solicitud_pendiente
            ? '<p class="small">Recibimos tu pedido. La administración se va a comunicar con vos para armar un plan a medida.</p>'
            : '<p class="small muted">Si estás pasando un momento complicado, podemos armar un plan de pagos a medida. Es confidencial.</p><button class="btn" id="plan">Pedir un plan de pagos</button>'}
        </div>
      </div>

      ${d.planes.length ? `<div class="card mt"><h2>Mis planes de pago</h2><div class="table-wrap mt"><table><thead><tr><th>Plan</th><th>Fecha</th><th class="r">Total</th><th>Cuotas pagas</th></tr></thead><tbody>
        ${d.planes.map((p) => `<tr><td>#${p.id}</td><td class="num">${fdate(p.fecha)}</td><td class="r num">${money(p.monto_total)}</td><td class="num">${p.cuotas_pagadas}/${p.cuotas_n}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}

      <div class="card mt">
        <div class="card-head"><div><h2>Mis recibos</h2><p>Comprobantes de los últimos pagos</p></div></div>
        ${d.recibos.length ? `<div class="table-wrap"><table><thead><tr><th>Fecha</th><th>Comprobante</th><th>Medio</th><th class="r">Importe</th><th></th></tr></thead><tbody>
          ${d.recibos.map((c) => `<tr><td class="num">${fdate(c.fecha)}</td><td class="num">${esc(c.comprobante)}</td><td>${esc(c.medio)}</td><td class="r num">${money(c.monto)}</td>
            <td class="r"><a class="btn sm" href="/recibos/${c.id}" target="_blank" rel="noopener">Ver recibo</a></td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty">Todavía no hay pagos.</div>'}
      </div>
      <p class="small muted mt">Tus datos se tratan según la Ley 25.326 de Protección de Datos Personales.</p>
    </div>`;

  const totalSel = () => $$('[data-id]:checked').reduce((a, c) => a + Number(c.dataset.saldo), 0);
  const syncTotal = () => {
    if (!$('#total')) return;
    $('#total').textContent = money(totalSel());
    $('#pagar').disabled = totalSel() === 0;
  };
  $$('[data-id]').forEach((c) => c.addEventListener('change', syncTotal));
  syncTotal();

  $('#pagar')?.addEventListener('click', () => {
    const ids = $$('[data-id]:checked').map((c) => Number(c.dataset.id));
    dialog(`
      <h2>Confirmar pago</h2>
      <p>Vas a pagar <b class="num">${money(totalSel())}</b> (${ids.length} cuota/s).</p>
      <p class="small muted">Pago simulado para la demo. En producción se redirige a la pasarela de pago (Mercado Pago, Banelco, etc.).</p>`,
    'Pagar', async () => {
      const r = await api('/api/portal/pagar', { method: 'POST', body: { cuota_ids: ids } });
      toast(`¡Listo! Registramos tu pago de ${money(r.total)}. Recibo ${r.comprobante}.`);
      render();
    });
  });
  $('#debito')?.addEventListener('click', () => dialog(`
      <h2>Débito automático</h2>
      <p class="small">Vamos a registrar tu adhesión. La administración te va a pedir el CBU para completar el alta.</p>`,
  'Adherir', async () => {
    await api('/api/portal/debito', { method: 'POST' });
    toast('Adhesión registrada');
    render();
  }));
  $('#plan')?.addEventListener('click', () => dialog(`
      <h2>Pedir un plan de pagos</h2>
      <label class="field">Contanos brevemente tu situación (opcional)<textarea name="mensaje" maxlength="500" placeholder="Ej.: preferimos pagar en 3 cuotas a partir del mes que viene"></textarea></label>`,
  'Enviar pedido', async (fd) => {
    await api('/api/portal/solicitar-plan', { method: 'POST', body: { mensaje: fd.get('mensaje') || 'Solicito un plan de pagos' } });
    toast('Pedido enviado. Te vamos a contactar.');
    render();
  }));
}

function dialog(body, submit, onSubmit) {
  modal.innerHTML = `<form id="dlg"><div class="modal-body">${body}<div class="error" role="alert"></div></div>
    <div class="modal-foot"><button type="button" class="btn" id="cancel">Cancelar</button><button class="btn primary">${esc(submit)}</button></div></form>`;
  $('#cancel', modal).addEventListener('click', () => modal.close());
  $('#dlg', modal).addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await onSubmit(new FormData(e.target)); modal.close(); } catch (err) { $('.error', modal).textContent = err.message; }
  });
  modal.showModal();
}

$('#salir').addEventListener('click', () => { store.set(''); codigo = ''; login(); });
codigo ? render() : login();
