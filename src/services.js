'use strict';
// Operaciones de escritura. Validan entrada y lanzan HttpError ante datos inválidos.
const crypto = require('node:crypto');
const { getSettings, today, tx, addMonths } = require('./db');
const { HttpError, req, oneOf, num, fecha } = require('./validate');
const E = require('./escolar');
const C = require('./cobranzas');

const MEDIOS = ['debito', 'transferencia', 'efectivo', 'online', 'tarjeta'];
const CANALES = ['mail', 'whatsapp', 'llamada', 'reunion'];
const ETAPAS = ['prevencion', 'vencimiento', 'contacto', 'plan', 'reunion', 'promesa', 'manual'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const PERIODO = /^\d{4}-(0[1-9]|1[0-2])$/;

function nuevoCodigoPortal(db) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const code = Array.from(crypto.randomBytes(6), (b) => abc[b % abc.length]).join('');
    if (!db.prepare('SELECT 1 FROM familias WHERE codigo_portal = ?').get(code)) return code;
  }
}

function conceptoArancel(periodo) {
  const [y, m] = periodo.split('-').map(Number);
  return `Arancel ${MESES[m - 1]} ${y}`;
}

/**
 * Cuota mensual de cada alumno activo: arancel, menos su beca y, del segundo hijo en adelante
 * (ordenados por grado), menos el descuento por hermano. Misma regla que montoFamilia.
 */
function desgloseCuota(alumnos, settings) {
  const arancel = Number(settings.arancel_mensual) || 0;
  const desc = Number(settings.descuento_hermano_pct) || 0;
  return alumnos
    .filter((a) => a.activo)
    .sort((a, b) => a.grado - b.grado || a.id - b.id)
    .map((a, i) => {
      const hermano = i > 0 ? desc : 0;
      return {
        alumno_id: a.id, nombre: a.nombre, grado: a.grado, seccion: a.seccion,
        arancel, beca_pct: a.beca_pct, descuento_hermano_pct: hermano,
        monto: Math.round(arancel * (1 - a.beca_pct / 100) * (1 - hermano / 100)),
      };
    });
}

/** Monto mensual de una familia: arancel por alumno, menos beca, menos descuento por hermano. */
function montoFamilia(alumnos, settings) {
  return desgloseCuota(alumnos, settings).reduce((tot, a) => tot + a.monto, 0);
}

// ---- Familias y alumnos ----

function datosFamilia(b, parcial = false) {
  const d = {};
  const campos = { apellido: true, responsable: true, email: false, telefono: false, notas: false };
  for (const [k, obligatorio] of Object.entries(campos)) {
    if (b[k] === undefined && parcial) continue;
    d[k] = obligatorio ? req(b[k], k) : String(b[k] ?? '').trim();
  }
  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) throw new HttpError(400, 'El email no es válido');
  if (b.medio_pago !== undefined || !parcial) d.medio_pago = oneOf(b.medio_pago || 'transferencia', MEDIOS, 'medio_pago');
  if (b.consentimiento !== undefined || !parcial) d.consentimiento = b.consentimiento ? 1 : 0;
  if (b.activa !== undefined) d.activa = b.activa ? 1 : 0;
  return d;
}

function crearFamilia(db, body) {
  const d = datosFamilia(body);
  return tx(db, () => {
    const r = db.prepare(`INSERT INTO familias (apellido, responsable, email, telefono, medio_pago, codigo_portal, consentimiento, notas, creada)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(d.apellido, d.responsable, d.email, d.telefono, d.medio_pago, nuevoCodigoPortal(db), d.consentimiento, d.notas, today(db));
    const id = Number(r.lastInsertRowid);
    for (const a of body.alumnos || []) crearAlumno(db, id, { apellido: d.apellido, ...a });
    return id;
  });
}

function actualizarFamilia(db, id, body) {
  const prev = db.prepare('SELECT * FROM familias WHERE id = ?').get(id);
  if (!prev) throw new HttpError(404, 'Familia inexistente');
  const d = datosFamilia(body, true);
  if (!Object.keys(d).length) return;
  tx(db, () => {
    db.prepare(`UPDATE familias SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
    if (d.medio_pago && d.medio_pago !== prev.medio_pago) registrarCambioMedio(db, id, prev.medio_pago, d.medio_pago);
  });
}

function registrarCambioMedio(db, familiaId, de, a) {
  db.prepare("INSERT INTO eventos (familia_id, fecha, tipo, detalle, atendido) VALUES (?, ?, 'cambio_medio', ?, 1)")
    .run(familiaId, today(db), `${de}→${a}`);
}

// Los alumnos se gestionan en escolar.js (legajo, cursos, altas y bajas).
const { crearAlumno, actualizarAlumno } = E;

// ---- Cuotas y pagos ----

function generarCuotas(db, periodo) {
  if (!PERIODO.test(periodo || '')) throw new HttpError(400, 'El período debe tener formato AAAA-MM');
  const s = getSettings(db);
  const dia = String(Math.min(28, Math.max(1, Number(s.dia_vencimiento) || 10))).padStart(2, '0');
  const venc = `${periodo}-${dia}`;
  const concepto = conceptoArancel(periodo);
  const familias = db.prepare('SELECT id FROM familias WHERE activa = 1').all();
  const alumnosDe = db.prepare('SELECT * FROM alumnos WHERE familia_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO cuotas (familia_id, periodo, concepto, monto, vencimiento) VALUES (?, ?, ?, ?, ?)');
  let creadas = 0;
  let aplicado = 0;
  tx(db, () => {
    for (const f of familias) {
      const monto = montoFamilia(alumnosDe.all(f.id), s);
      if (monto > 0) creadas += ins.run(f.id, periodo, concepto, monto, venc).changes;
    }
    // Las familias con saldo a favor cancelan automáticamente las cuotas nuevas
    aplicado = C.aplicarSaldosAFavor(db);
  });
  return { periodo, vencimiento: venc, creadas, saldo_a_favor_aplicado: aplicado };
}

function saldoCuota(db, cuotaId) {
  const c = db.prepare('SELECT * FROM cuotas WHERE id = ?').get(cuotaId);
  if (!c) throw new HttpError(404, 'Cuota inexistente');
  const pagado = db.prepare('SELECT COALESCE(SUM(monto), 0) AS t FROM pagos WHERE cuota_id = ? AND rechazado = 0').get(cuotaId).t;
  return { cuota: c, saldo: c.refinanciada_en ? 0 : Math.max(0, Math.round(c.monto - pagado)) };
}

// El pago de una cuota puntual genera un recibo (ver cobranzas.js).
const { registrarPago } = C;

// ---- Planes de pago ----

function crearPlan(db, body) {
  const familiaId = num(body.familia_id, 'familia_id', { min: 1 });
  const n = num(body.cuotas_n, 'cuotas_n', { min: 1, max: 24 });
  const hoy = today(db);
  const primera = body.primer_vencimiento ? fecha(body.primer_vencimiento, 'primer_vencimiento') : hoy;
  const incluirPendientes = Boolean(body.incluir_pendientes);

  // Opcionalmente se condonan los recargos por mora antes de refinanciar (con nota de crédito)
  if (body.condonar_recargos) {
    const recargos = C.cargosAbiertos(db, familiaId).filter((c) => c.tipo === 'recargo').map((c) => c.id);
    if (recargos.length) C.condonar(db, { cuota_ids: recargos, motivo: 'Condonación de recargos al acordar plan de pagos' });
  }
  const cuotas = C.cargosAbiertos(db, familiaId)
    .filter((c) => c.vencimiento < hoy || incluirPendientes)
    .map((c) => ({ c, saldo: c.saldo }));
  if (!cuotas.length) throw new HttpError(400, 'La familia no tiene deuda para incluir en un plan');
  const total = cuotas.reduce((a, x) => a + x.saldo, 0);

  return tx(db, () => {
    const planId = Number(db.prepare('INSERT INTO planes (familia_id, fecha, monto_total, cuotas_n, nota) VALUES (?, ?, ?, ?, ?)')
      .run(familiaId, hoy, total, n, String(body.nota || '').trim()).lastInsertRowid);
    const upd = db.prepare('UPDATE cuotas SET refinanciada_en = ? WHERE id = ?');
    for (const { c } of cuotas) upd.run(planId, c.id);
    const ins = db.prepare("INSERT INTO cuotas (familia_id, periodo, concepto, monto, vencimiento, plan_id, plan_nro, tipo) VALUES (?, ?, ?, ?, ?, ?, ?, 'plan')");
    const base = Math.floor(total / n);
    for (let i = 1; i <= n; i++) {
      const venc = addMonths(primera, i - 1);
      const monto = i === n ? total - base * (n - 1) : base;
      ins.run(familiaId, venc.slice(0, 7), `Plan de pagos #${planId} · cuota ${i}/${n}`, monto, venc, planId, i);
    }
    db.prepare("UPDATE eventos SET atendido = 1 WHERE familia_id = ? AND tipo = 'solicitud_plan'").run(familiaId);
    return planId;
  });
}

// ---- Comunicaciones y eventos ----

function registrarComunicacion(db, body) {
  const familiaId = num(body.familia_id, 'familia_id', { min: 1 });
  if (!db.prepare('SELECT 1 FROM familias WHERE id = ?').get(familiaId)) throw new HttpError(404, 'Familia inexistente');
  const r = db.prepare(`INSERT INTO comunicaciones (familia_id, cuota_id, fecha, canal, etapa, mensaje, estado, abierto, respondido)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    familiaId,
    body.cuota_id ? num(body.cuota_id, 'cuota_id', { min: 1 }) : null,
    today(db),
    oneOf(body.canal, CANALES, 'canal'),
    oneOf(body.etapa || 'manual', ETAPAS, 'etapa'),
    String(body.mensaje || '').slice(0, 2000),
    oneOf(body.estado || 'enviada', ['enviada', 'omitida'], 'estado'),
    body.abierto || body.canal === 'llamada' || body.canal === 'reunion' ? 1 : 0,
    body.respondido ? 1 : 0,
  );
  return Number(r.lastInsertRowid);
}

function marcarComunicacion(db, id, body) {
  const r = db.prepare('UPDATE comunicaciones SET abierto = ?, respondido = ? WHERE id = ?')
    .run(body.abierto ? 1 : 0, body.respondido ? 1 : 0, id);
  if (!r.changes) throw new HttpError(404, 'Comunicación inexistente');
}

function registrarEvento(db, familiaId, tipo, detalle = '') {
  db.prepare('INSERT INTO eventos (familia_id, fecha, tipo, detalle) VALUES (?, ?, ?, ?)')
    .run(familiaId, today(db), tipo, String(detalle).slice(0, 1000));
}

function atenderEvento(db, id) {
  const r = db.prepare('UPDATE eventos SET atendido = 1 WHERE id = ?').run(id);
  if (!r.changes) throw new HttpError(404, 'Evento inexistente');
}

module.exports = {
  HttpError, MEDIOS, CANALES, MESES,
  crearFamilia, actualizarFamilia, crearAlumno, actualizarAlumno, registrarCambioMedio,
  generarCuotas, registrarPago, saldoCuota, crearPlan, montoFamilia, desgloseCuota, conceptoArancel,
  registrarComunicacion, marcarComunicacion, registrarEvento, atenderEvento, nuevoCodigoPortal,
};
