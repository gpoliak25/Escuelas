'use strict';
// Gestión de cobranzas: cobros con recibo, imputación a la deuda, saldo a favor, notas de crédito,
// recargos por mora, cargos adicionales, promesas de pago y débito automático por lotes.
//
// Modelo: un "cobro" es el ingreso (recibo) o crédito (nota de crédito). Cada "pago" es la
// imputación de una parte de un cobro a un cargo (cuota). Lo no imputado es saldo a favor.
const { getSettings, today, tx, addDays, diffDays } = require('./db');
const { HttpError, req, oneOf, num, fecha } = require('./validate');

const MEDIOS_COBRO = ['efectivo', 'transferencia', 'debito', 'tarjeta', 'online', 'cheque'];
const TIPOS_CARGO = ['arancel', 'plan', 'cargo', 'recargo'];
const MOTIVOS_RECHAZO = ['Fondos insuficientes', 'Cuenta cerrada o inexistente', 'Baja de la adhesión', 'Otro'];
const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

function familiaOk(db, id) {
  const f = db.prepare('SELECT * FROM familias WHERE id = ?').get(id);
  if (!f) throw new HttpError(404, 'Familia inexistente');
  return f;
}

function numeroRecibo(db, numero, tipo = 'recibo') {
  if (numero == null) return '—';
  const pv = String(getSettings(db).punto_venta || '0001').padStart(4, '0');
  return `${tipo === 'nota_credito' ? 'NC ' : ''}${pv}-${String(numero).padStart(8, '0')}`;
}

/** Cargos con saldo de una familia, en orden de imputación: el más antiguo primero
 *  (un recargo se ordena junto a la cuota que lo originó, justo después de ella). */
function cargosAbiertos(db, familiaId) {
  return db.prepare(`SELECT c.*, COALESCE(o.vencimiento, c.vencimiento) AS orden,
      c.monto - COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.cuota_id = c.id AND p.rechazado = 0), 0) AS saldo
    FROM cuotas c LEFT JOIN cuotas o ON o.id = c.origen_id
    WHERE c.familia_id = ? AND c.refinanciada_en IS NULL`).all(familiaId)
    .map((c) => ({ ...c, saldo: Math.round(c.saldo) }))
    .filter((c) => c.saldo > 0)
    .sort((a, b) => a.orden.localeCompare(b.orden) || (a.tipo === 'recargo') - (b.tipo === 'recargo') || a.id - b.id);
}

function imputar(db, cobro, monto, cuotaIds, fechaImp) {
  let lista = cargosAbiertos(db, cobro.familia_id);
  if (cuotaIds) {
    lista = cuotaIds.map((id) => {
      const c = lista.find((x) => x.id === id);
      if (!c) throw new HttpError(400, 'Una de las cuotas elegidas no tiene saldo o no pertenece a la familia');
      return c;
    });
  }
  const ins = db.prepare('INSERT INTO pagos (familia_id, cuota_id, fecha, monto, medio, rechazado, cobro_id) VALUES (?, ?, ?, ?, ?, 0, ?)');
  const imputaciones = [];
  let resto = Math.round(monto);
  for (const c of lista) {
    if (resto <= 0) break;
    const m = Math.min(resto, c.saldo);
    ins.run(cobro.familia_id, c.id, fechaImp, m, cobro.medio, cobro.id);
    imputaciones.push({ cuota_id: c.id, concepto: c.concepto, monto: m });
    resto -= m;
  }
  return { imputaciones, resto };
}

function siguienteNumero(db, tipo) {
  return db.prepare('SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM cobros WHERE tipo = ?').get(tipo).n;
}

function _registrarCobro(db, body) {
  const familiaId = num(body.familia_id, 'familia_id', { min: 1 });
  familiaOk(db, familiaId);
  const hoy = today(db);
  const tipo = body.tipo === 'nota_credito' ? 'nota_credito' : 'recibo';
  const monto = Math.round(num(body.monto, 'monto', { min: 1, max: 1e10 }));
  const medio = tipo === 'nota_credito' ? 'nota_credito' : oneOf(body.medio || 'efectivo', MEDIOS_COBRO, 'medio');
  const f = body.fecha ? fecha(body.fecha, 'fecha') : hoy;
  if (f > hoy) throw new HttpError(400, 'La fecha del cobro no puede ser futura');
  const motivo = String(body.motivo || '').trim().slice(0, 300);
  if (tipo === 'nota_credito' && !motivo) throw new HttpError(400, 'Indicá el motivo de la nota de crédito');
  const cuotaIds = Array.isArray(body.cuota_ids) && body.cuota_ids.length ? body.cuota_ids.map(Number) : null;
  if (body.estricto && cuotaIds) {
    const abiertos = cargosAbiertos(db, familiaId);
    const saldo = cuotaIds.reduce((a, id) => a + (abiertos.find((c) => c.id === id)?.saldo || 0), 0);
    if (!saldo) throw new HttpError(400, 'La cuota no tiene saldo pendiente');
    if (monto > saldo) throw new HttpError(400, `El monto supera el saldo de la cuota ($${saldo})`);
  }
  const numero = siguienteNumero(db, tipo);
  const r = db.prepare(`INSERT INTO cobros (numero, tipo, familia_id, fecha, monto, medio, referencia, estado, motivo, creado)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'vigente', ?, ?)`)
    .run(numero, tipo, familiaId, f, monto, medio, String(body.referencia || '').trim().slice(0, 120), motivo, new Date().toISOString());
  const cobro = { id: Number(r.lastInsertRowid), familia_id: familiaId, medio };
  const { imputaciones, resto } = imputar(db, cobro, monto, cuotaIds, f);
  return { id: cobro.id, numero, comprobante: numeroRecibo(db, numero, tipo), imputaciones, saldo_a_favor: resto };
}

/** Registra un cobro (recibo) o una nota de crédito y lo imputa a la deuda. */
function registrarCobro(db, body) {
  return tx(db, () => _registrarCobro(db, body));
}

/** Pago de una cuota puntual (botón "Pagar" y portal): no admite pagar de más. */
function registrarPago(db, body) {
  const cuotaId = num(body.cuota_id, 'cuota_id', { min: 1 });
  const c = db.prepare('SELECT * FROM cuotas WHERE id = ?').get(cuotaId);
  if (!c) throw new HttpError(404, 'Cuota inexistente');
  if (body.rechazado) return registrarRechazo(db, { ...body, familia_id: c.familia_id });
  const saldo = cargosAbiertos(db, c.familia_id).find((x) => x.id === cuotaId)?.saldo || 0;
  return registrarCobro(db, {
    ...body,
    familia_id: c.familia_id,
    monto: body.monto === undefined || body.monto === '' ? saldo || 1 : body.monto,
    cuota_ids: [cuotaId],
    estricto: true,
  }).id;
}

function _registrarRechazo(db, body) {
  const cuotaId = num(body.cuota_id, 'cuota_id', { min: 1 });
  const c = db.prepare('SELECT * FROM cuotas WHERE id = ?').get(cuotaId);
  if (!c) throw new HttpError(404, 'Cuota inexistente');
  const hoy = today(db);
  const f = body.fecha ? fecha(body.fecha, 'fecha') : hoy;
  const monto = body.monto ? Math.round(num(body.monto, 'monto', { min: 1 })) : c.monto;
  const motivo = MOTIVOS_RECHAZO.includes(body.motivo) ? body.motivo : 'Débito rechazado';
  const r = db.prepare(`INSERT INTO cobros (numero, tipo, familia_id, fecha, monto, medio, referencia, estado, motivo, creado)
    VALUES (NULL, 'recibo', ?, ?, ?, 'debito', ?, 'rechazado', ?, ?)`)
    .run(c.familia_id, f, monto, String(body.referencia || ''), motivo, new Date().toISOString());
  const cobroId = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO pagos (familia_id, cuota_id, fecha, monto, medio, rechazado, cobro_id) VALUES (?, ?, ?, ?, ?, 1, ?)')
    .run(c.familia_id, cuotaId, f, monto, 'debito', cobroId);
  return cobroId;
}

/** Débito automático rechazado: queda registrado (señal de riesgo) pero no cancela deuda. */
function registrarRechazo(db, body) {
  return tx(db, () => _registrarRechazo(db, body));
}

function anularCobro(db, id, body) {
  const c = db.prepare('SELECT * FROM cobros WHERE id = ?').get(id);
  if (!c) throw new HttpError(404, 'Cobro inexistente');
  if (c.estado !== 'vigente') throw new HttpError(400, 'El comprobante ya no está vigente');
  const motivo = req(body.motivo, 'motivo');
  tx(db, () => {
    db.prepare('DELETE FROM pagos WHERE cobro_id = ?').run(id);
    db.prepare("UPDATE cobros SET estado = 'anulado', motivo = ? WHERE id = ?").run(String(motivo).slice(0, 300), id);
  });
}

/** Saldo a favor de una familia: lo cobrado que todavía no se imputó a ningún cargo. */
function saldoAFavor(db, familiaId) {
  return db.prepare(`SELECT c.id, c.medio, c.monto - COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.cobro_id = c.id), 0) AS resto
    FROM cobros c WHERE c.familia_id = ? AND c.estado = 'vigente' ORDER BY c.fecha, c.id`).all(familiaId)
    .map((r) => ({ ...r, resto: Math.round(r.resto) })).filter((r) => r.resto > 0);
}

/** Aplica el saldo a favor a los cargos abiertos (por ejemplo, cuando se generan cuotas nuevas). */
function aplicarSaldoAFavor(db, familiaId) {
  const hoy = today(db);
  let aplicado = 0;
  for (const c of saldoAFavor(db, familiaId)) {
    const { imputaciones } = imputar(db, { id: c.id, familia_id: familiaId, medio: c.medio }, c.resto, null, hoy);
    aplicado += imputaciones.reduce((a, i) => a + i.monto, 0);
  }
  return aplicado;
}

function aplicarSaldosAFavor(db, familiaIds = null) {
  const ids = familiaIds || db.prepare("SELECT DISTINCT familia_id FROM cobros WHERE estado = 'vigente'").all().map((r) => r.familia_id);
  let total = 0;
  for (const id of ids) total += aplicarSaldoAFavor(db, id);
  return total;
}

/** Nota de crédito por el saldo de los cargos elegidos (condonación de recargos, bonificaciones). */
function condonar(db, body) {
  const ids = Array.isArray(body.cuota_ids) ? body.cuota_ids.map(Number) : [];
  if (!ids.length) throw new HttpError(400, 'Elegí qué cargos condonar');
  const primero = db.prepare('SELECT familia_id FROM cuotas WHERE id = ?').get(ids[0]);
  if (!primero) throw new HttpError(404, 'Cargo inexistente');
  const abiertos = cargosAbiertos(db, primero.familia_id);
  const monto = ids.reduce((a, id) => a + (abiertos.find((c) => c.id === id)?.saldo || 0), 0);
  if (!monto) throw new HttpError(400, 'Los cargos elegidos no tienen saldo');
  return registrarCobro(db, { familia_id: primero.familia_id, tipo: 'nota_credito', monto, cuota_ids: ids, motivo: body.motivo || 'Condonación' });
}

// ---- Recargos por mora ----

/**
 * Recargo por mora: un % del saldo de la cuota por cada mes de atraso, a partir del día
 * siguiente a los días de gracia. Es idempotente: sólo crea los recargos que faltan.
 */
function liquidarRecargos(db, { simular = false } = {}) {
  const s = getSettings(db);
  if (s.recargo_activo !== '1') return { creados: 0, monto: 0, activo: false };
  const pct = Number(s.recargo_pct) || 0;
  const gracia = Math.max(0, Number(s.recargo_dias_gracia) || 0);
  const hoy = today(db);
  if (pct <= 0) return { creados: 0, monto: 0, activo: true };
  const vencidas = db.prepare(`SELECT c.*, c.monto - COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.cuota_id = c.id AND p.rechazado = 0), 0) AS saldo,
      (SELECT COUNT(*) FROM cuotas r WHERE r.origen_id = c.id AND r.tipo = 'recargo') AS hechos
    FROM cuotas c WHERE c.tipo IN ('arancel', 'plan', 'cargo') AND c.refinanciada_en IS NULL AND c.vencimiento < ?`).all(hoy)
    .filter((c) => c.saldo > 0.5);
  const ins = db.prepare(`INSERT OR IGNORE INTO cuotas (familia_id, periodo, concepto, monto, vencimiento, tipo, origen_id)
    VALUES (?, ?, ?, ?, ?, 'recargo', ?)`);
  let creados = 0, monto = 0;
  const run = () => {
    for (const c of vencidas) {
      const dias = diffDays(hoy, c.vencimiento);
      if (dias <= gracia) continue;
      const debidos = Math.floor((dias - gracia - 1) / 30) + 1;
      for (let k = c.hechos + 1; k <= debidos; k++) {
        const m = Math.round((c.saldo * pct) / 100);
        if (m <= 0) continue;
        if (!simular) {
          const venc = addDays(c.vencimiento, gracia + 1 + 30 * (k - 1));
          if (!ins.run(c.familia_id, c.periodo, `Recargo por mora ${k} · ${c.concepto}`, m, venc, c.id).changes) continue;
        }
        creados++;
        monto += m;
      }
    }
  };
  if (simular) run(); else tx(db, run);
  return { creados, monto, activo: true, pct, gracia };
}

// ---- Cargos adicionales ----

const ALCANCES = ['familia', 'todas', 'alumnos'];

/** Cargo puntual (matrícula, materiales, excursión…) a una familia o masivo. */
function crearCargo(db, body) {
  const alcance = oneOf(body.alcance || 'familia', ALCANCES, 'alcance');
  const concepto = String(req(body.concepto, 'concepto')).slice(0, 120);
  const monto = Math.round(num(body.monto, 'monto', { min: 1, max: 1e9 }));
  const venc = fecha(body.vencimiento, 'vencimiento');
  const grado = body.grado ? num(body.grado, 'grado', { min: 1, max: 7 }) : null;
  let destinos;
  if (alcance === 'familia') {
    const f = familiaOk(db, num(body.familia_id, 'familia_id', { min: 1 }));
    destinos = [{ id: f.id, monto }];
  } else {
    const fams = db.prepare(`SELECT f.id, COUNT(a.id) AS hijos FROM familias f
      JOIN alumnos a ON a.familia_id = f.id AND a.estado = 'activo' ${grado ? 'AND a.grado = ?' : ''}
      WHERE f.activa = 1 GROUP BY f.id`).all(...(grado ? [grado] : []));
    destinos = fams.map((f) => ({ id: f.id, monto: alcance === 'alumnos' ? monto * f.hijos : monto }));
  }
  const ins = db.prepare(`INSERT OR IGNORE INTO cuotas (familia_id, periodo, concepto, monto, vencimiento, tipo)
    VALUES (?, ?, ?, ?, ?, 'cargo')`);
  return tx(db, () => {
    let creados = 0, total = 0;
    for (const d of destinos) {
      if (ins.run(d.id, venc.slice(0, 7), concepto, d.monto, venc).changes) { creados++; total += d.monto; }
    }
    aplicarSaldosAFavor(db, destinos.map((d) => d.id));
    return { creados, total, omitidos: destinos.length - creados };
  });
}

// ---- Promesas de pago ----

function crearPromesa(db, body) {
  const familiaId = num(body.familia_id, 'familia_id', { min: 1 });
  familiaOk(db, familiaId);
  const hoy = today(db);
  const f = fecha(body.fecha_promesa, 'fecha_promesa');
  if (f < hoy) throw new HttpError(400, 'La fecha prometida no puede ser pasada');
  if (diffDays(f, hoy) > 90) throw new HttpError(400, 'La promesa no puede superar los 90 días; para plazos mayores usá un plan de pagos');
  const monto = Math.round(num(body.monto, 'monto', { min: 1 }));
  return Number(db.prepare('INSERT INTO promesas (familia_id, fecha_registro, fecha_promesa, monto, nota) VALUES (?, ?, ?, ?, ?)')
    .run(familiaId, hoy, f, monto, String(body.nota || '').trim().slice(0, 300)).lastInsertRowid);
}

function anularPromesa(db, id) {
  const r = db.prepare('UPDATE promesas SET anulada = 1 WHERE id = ?').run(id);
  if (!r.changes) throw new HttpError(404, 'Promesa inexistente');
}

// ---- Débito automático ----

/** Cuotas del período a debitar: familias adheridas al débito con saldo en esa cuota. */
function loteDebito(db, periodo) {
  if (!PERIODO.test(periodo || '')) throw new HttpError(400, 'El período debe tener formato AAAA-MM');
  return db.prepare(`SELECT c.id AS cuota_id, c.familia_id, c.concepto, c.vencimiento, f.apellido, f.responsable,
      c.monto - COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.cuota_id = c.id AND p.rechazado = 0), 0) AS saldo,
      (SELECT COUNT(*) FROM pagos p WHERE p.cuota_id = c.id AND p.rechazado = 1) AS rechazos,
      (SELECT MAX(p.fecha) FROM pagos p WHERE p.cuota_id = c.id AND p.rechazado = 1) AS ultimo_rechazo
    FROM cuotas c JOIN familias f ON f.id = c.familia_id
    WHERE f.medio_pago = 'debito' AND f.activa = 1 AND c.tipo = 'arancel' AND c.periodo = ? AND c.refinanciada_en IS NULL
    ORDER BY f.apellido`).all(periodo)
    .map((r) => ({ ...r, saldo: Math.round(r.saldo) }))
    .filter((r) => r.saldo > 0);
}

function procesarLote(db, body) {
  const periodo = body.periodo;
  const pendientes = new Map(loteDebito(db, periodo).map((r) => [r.cuota_id, r]));
  const hoy = today(db);
  const f = body.fecha ? fecha(body.fecha, 'fecha') : hoy;
  if (f > hoy) throw new HttpError(400, 'La fecha de acreditación no puede ser futura');
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, 'El lote está vacío');
  return tx(db, () => {
    let aceptados = 0, rechazados = 0, monto = 0;
    for (const it of items) {
      const r = pendientes.get(Number(it.cuota_id));
      if (!r) throw new HttpError(400, 'Hay cuotas que ya no están pendientes de débito; actualizá la pantalla');
      const referencia = `Lote débito ${periodo}`;
      if (it.rechazado) {
        _registrarRechazo(db, { cuota_id: r.cuota_id, monto: r.saldo, fecha: f, motivo: it.motivo, referencia });
        rechazados++;
      } else {
        _registrarCobro(db, { familia_id: r.familia_id, monto: r.saldo, medio: 'debito', fecha: f, cuota_ids: [r.cuota_id], referencia });
        aceptados++;
        monto += r.saldo;
      }
    }
    const id = Number(db.prepare('INSERT INTO lotes_debito (periodo, fecha, cantidad, aceptados, rechazados, monto) VALUES (?, ?, ?, ?, ?, ?)')
      .run(periodo, f, items.length, aceptados, rechazados, monto).lastInsertRowid);
    return { id, aceptados, rechazados, monto };
  });
}

module.exports = {
  MEDIOS_COBRO, TIPOS_CARGO, MOTIVOS_RECHAZO, ALCANCES,
  numeroRecibo, cargosAbiertos, registrarCobro, registrarPago, registrarRechazo, anularCobro,
  saldoAFavor, aplicarSaldoAFavor, aplicarSaldosAFavor, condonar, liquidarRecargos, crearCargo,
  crearPromesa, anularPromesa, loteDebito, procesarLote,
};
