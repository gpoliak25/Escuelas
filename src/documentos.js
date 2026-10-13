'use strict';
// Comprobantes imprimibles: recibo / nota de crédito, estado de cuenta y certificado de libre deuda.
const D = require('./domain');
const { HttpError } = require('./validate');

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const money = (n) => '$ ' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fdate = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fechaLarga = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} de ${MESES[m - 1]} de ${y}`; };

function pagina(titulo, cuerpo) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<style>
  :root { --ink: #12303B; --muted: #5A6A70; --line: #D9D4C7; --bg: #F6F3EC; --accent: #E9A23B; color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, "Segoe UI", Roboto, Arial, sans-serif; }
  .bar { max-width: 820px; margin: 0 auto; padding: 16px; display: flex; gap: 8px; justify-content: flex-end; }
  .bar button, .bar a { font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: #fff; color: var(--ink); cursor: pointer; text-decoration: none; }
  .bar button { background: var(--ink); color: #fff; border-color: var(--ink); }
  .hoja { max-width: 820px; margin: 0 auto 40px; background: #fff; padding: 40px 44px; border: 1px solid var(--line); }
  header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid var(--ink); padding-bottom: 16px; margin-bottom: 20px; }
  .escuela { font-size: 20px; font-weight: 800; }
  .doc { text-align: right; }
  .doc .tipo { font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
  .doc .num { font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; }
  .anulado { color: #B8432C; font-weight: 800; border: 2px solid #B8432C; display: inline-block; padding: 2px 10px; margin-top: 6px; letter-spacing: .1em; }
  dl { display: grid; grid-template-columns: 150px 1fr; gap: 6px 14px; margin: 0 0 18px; }
  dt { color: var(--muted); }
  dd { margin: 0; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0 18px; font-variant-numeric: tabular-nums; }
  th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); border-bottom: 1px solid var(--line); padding: 6px 8px; }
  td { padding: 7px 8px; border-bottom: 1px solid #EEE9DD; }
  .r { text-align: right; }
  tfoot td { font-weight: 800; border-top: 2px solid var(--ink); border-bottom: 0; }
  .total { font-size: 18px; font-weight: 800; }
  .nota { color: var(--muted); font-size: 12px; margin-top: 26px; }
  .firma { margin-top: 70px; display: flex; justify-content: flex-end; }
  .firma div { border-top: 1px solid var(--ink); padding-top: 6px; width: 240px; text-align: center; color: var(--muted); font-size: 12px; }
  .cert { font-size: 15px; line-height: 1.8; max-width: 62ch; }
  @media print { body { background: #fff; } .bar { display: none; } .hoja { border: 0; margin: 0; padding: 0; max-width: none; } }
</style></head><body>
<div class="bar"><a href="javascript:history.back()">Volver</a><button onclick="window.print()">Imprimir o guardar PDF</button></div>
<main class="hoja">${cuerpo}</main>
</body></html>`;
}

function encabezado(L, tipo, numero, extra = '') {
  return `<header>
    <div><div class="escuela">${esc(L.settings.escuela_nombre)}</div><div style="color:var(--muted)">Administración</div></div>
    <div class="doc"><div class="tipo">${esc(tipo)}</div>${numero ? `<div class="num">${esc(numero)}</div>` : ''}<div>${extra}</div></div>
  </header>`;
}

function datosFamilia(f) {
  return `<dl><dt>Familia</dt><dd>${esc(f.apellido)}</dd><dt>Responsable</dt><dd>${esc(f.responsable)}</dd>
    ${f.email ? `<dt>Mail</dt><dd>${esc(f.email)}</dd>` : ''}</dl>`;
}

function recibo(db, id) {
  const L = D.loadLedger(db);
  const c = L.cobros.find((x) => x.id === id) || db.prepare('SELECT * FROM cobros WHERE id = ?').get(id);
  if (!c) throw new HttpError(404, 'El comprobante no existe');
  if (c.estado === 'rechazado') throw new HttpError(400, 'Un débito rechazado no genera recibo');
  const f = L.byFam.get(c.familia_id).familia;
  const imput = L.pagos.filter((p) => p.cobro_id === c.id && !p.rechazado);
  const nc = c.tipo === 'nota_credito';
  const filas = imput.map((p) => {
    const q = L.cuotaById.get(p.cuota_id);
    return `<tr><td>${esc(q.concepto)}</td><td>${fdate(q.vencimiento)}</td><td class="r">${money(p.monto)}</td></tr>`;
  }).join('');
  const aFavor = c.monto - imput.reduce((a, p) => a + p.monto, 0);
  const cuerpo = `${encabezado(L, nc ? 'Nota de crédito' : 'Recibo', c.comprobante || D.MEDIO_LBL[c.medio], `Fecha: ${fdate(c.fecha)}${c.estado === 'anulado' ? '<br><span class="anulado">ANULADO</span>' : ''}`)}
    ${datosFamilia(f)}
    <dl><dt>${nc ? 'Motivo' : 'Medio de pago'}</dt><dd>${esc(nc ? c.motivo : D.MEDIO_LBL[c.medio] || c.medio)}${c.referencia ? ` · ${esc(c.referencia)}` : ''}</dd>
      ${c.estado === 'anulado' ? `<dt>Anulación</dt><dd>${esc(c.motivo)}</dd>` : ''}</dl>
    <table><thead><tr><th>${nc ? 'Se acredita a' : 'Imputado a'}</th><th>Vencimiento</th><th class="r">Importe</th></tr></thead>
      <tbody>${filas || '<tr><td colspan="3">Sin imputación</td></tr>'}
        ${aFavor > 0.5 ? `<tr><td>Saldo a favor de la familia</td><td></td><td class="r">${money(aFavor)}</td></tr>` : ''}</tbody>
      <tfoot><tr><td colspan="2">Total ${nc ? 'acreditado' : 'recibido'}</td><td class="r total">${money(c.monto)}</td></tr></tfoot></table>
    <div class="firma"><div>Firma y sello de administración</div></div>
    <p class="nota">Comprobante interno de la escuela. No válido como factura.</p>`;
  return pagina(`${nc ? 'Nota de crédito' : 'Recibo'} ${c.comprobante}`, cuerpo);
}

function estadoCuenta(db, familiaId) {
  const L = D.loadLedger(db);
  const d = D.detalleFamilia(L, familiaId);
  if (!d) throw new HttpError(404, 'Familia inexistente');
  const cc = d.cuenta_corriente;
  const movs = [...cc.movimientos].reverse().map((m) => `<tr><td>${fdate(m.fecha)}</td><td>${esc(m.concepto)}</td>
    <td class="r">${m.debe ? money(m.debe) : ''}</td><td class="r">${m.haber ? money(m.haber) : ''}</td><td class="r">${money(m.saldo)}</td></tr>`).join('');
  const futuras = cc.a_vencer.map((c) => `<tr><td>${fdate(c.fecha)}</td><td>${esc(c.concepto)}</td><td class="r">${money(c.saldo)}</td></tr>`).join('');
  const cuerpo = `${encabezado(L, 'Estado de cuenta', '', `Al ${fdate(L.hoy)}`)}
    ${datosFamilia(d.familia)}
    <dl><dt>Alumnos</dt><dd>${esc(d.resumen.alumnos.join(', ') || '—')}</dd>
      <dt>Deuda vencida</dt><dd><b>${money(d.resumen.deuda_vencida)}</b>${d.resumen.deuda_recargos ? ` (incluye ${money(d.resumen.deuda_recargos)} de recargos por mora)` : ''}</dd>
      ${d.saldo_a_favor ? `<dt>Saldo a favor</dt><dd>${money(d.saldo_a_favor)}</dd>` : ''}</dl>
    <h3>Movimientos</h3>
    <table><thead><tr><th>Fecha</th><th>Concepto</th><th class="r">Debe</th><th class="r">Haber</th><th class="r">Saldo</th></tr></thead>
      <tbody>${movs || '<tr><td colspan="5">Sin movimientos</td></tr>'}</tbody>
      <tfoot><tr><td colspan="4">Saldo al ${fdate(L.hoy)} ${cc.saldo < 0 ? '(a favor de la familia)' : ''}</td><td class="r total">${money(Math.abs(cc.saldo))}</td></tr></tfoot></table>
    ${futuras ? `<h3>Próximos vencimientos</h3><table><thead><tr><th>Vencimiento</th><th>Concepto</th><th class="r">Saldo</th></tr></thead><tbody>${futuras}</tbody></table>` : ''}
    <p class="nota">Los pagos se imputan a la deuda más antigua. Consultas: administración de ${esc(L.settings.escuela_nombre)}.</p>`;
  return pagina(`Estado de cuenta · ${d.familia.apellido}`, cuerpo);
}

function libreDeuda(db, familiaId) {
  const L = D.loadLedger(db);
  const fam = L.byFam.get(familiaId);
  if (!fam) throw new HttpError(404, 'Familia inexistente');
  if (fam.deuda_vencida > 0) {
    throw new HttpError(409, `La familia ${fam.familia.apellido} tiene una deuda vencida de ${money(fam.deuda_vencida)}: no se puede emitir el libre deuda.`);
  }
  const alumnos = fam.alumnos.filter((a) => a.estado === 'activo').map((a) => `${a.nombre} ${a.apellido} (${a.grado}° ${a.seccion})`);
  const cuerpo = `${encabezado(L, 'Certificado de libre deuda', '', `Fecha: ${fdate(L.hoy)}`)}
    <p class="cert">Se deja constancia de que la familia <b>${esc(fam.familia.apellido)}</b>, responsable <b>${esc(fam.familia.responsable)}</b>${alumnos.length ? `, de los alumnos ${esc(alumnos.join(', '))},` : ','}
    no registra deuda vencida con ${esc(L.settings.escuela_nombre)} al día ${fechaLarga(L.hoy)}.</p>
    <p class="cert">Se extiende el presente a pedido de la persona interesada, para ser presentado ante quien corresponda.</p>
    <div class="firma"><div>Firma y sello de administración</div></div>
    <p class="nota">El certificado refleja la situación a la fecha de emisión y no incluye cuotas por vencer.</p>`;
  return pagina(`Libre deuda · ${fam.familia.apellido}`, cuerpo);
}

function errorPagina(msg) {
  return pagina('No disponible', `<h2>No se puede mostrar el documento</h2><p>${esc(msg)}</p>`);
}

const DOCUMENTOS = { recibos: recibo, 'estado-cuenta': estadoCuenta, 'libre-deuda': libreDeuda };

module.exports = { DOCUMENTOS, errorPagina };
