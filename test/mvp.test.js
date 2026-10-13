'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const db_ = require('../src/db');
const { seed } = require('../src/seed');
const D = require('../src/domain');
const S = require('../src/services');
const { scoreFamily } = require('../src/risk');

function fresh() {
  const db = db_.open(':memory:');
  seed(db);
  return db;
}

test('fechas: aritmética de días y meses', () => {
  assert.equal(db_.addDays('2026-02-27', 3), '2026-03-02');
  assert.equal(db_.diffDays('2026-03-01', '2026-02-01'), 28);
  assert.equal(db_.addMonths('2026-01-31', 1), '2026-02-28');
});

test('motor de riesgo: familia puntual = bajo, familia morosa = alto', () => {
  const cuota = (venc, pagoDias, extra = {}) => ({
    id: venc, monto: 100, vencimiento: venc, refinanciada_en: null,
    pagos: pagoDias == null ? [] : [{ fecha: db_.addDays(venc, pagoDias), monto: 100, rechazado: 0 }], ...extra,
  });
  const meses = ['2026-03-10', '2026-04-10', '2026-05-10', '2026-06-10', '2026-07-10', '2026-08-10'];
  const puntual = { cuotas: meses.map((m) => cuota(m, -3)), comunicaciones: [], eventos: [] };
  const morosa = { cuotas: [...meses.slice(0, 5).map((m) => cuota(m, 25)), cuota('2026-08-10', null)], comunicaciones: [], eventos: [] };
  const r1 = scoreFamily(puntual, '2026-09-01', '2026-09-10');
  const r2 = scoreFamily(morosa, '2026-09-01', '2026-09-10');
  assert.equal(r1.nivel, 'bajo');
  assert.equal(r2.nivel, 'alto');
  assert.equal(r2.motivo, 'Historial de pagos');
  // Sólo usa datos conocidos a la fecha: el mismo historial visto antes de los atrasos es bajo.
  assert.equal(scoreFamily(morosa, '2026-03-01', '2026-03-10').puntaje, 5); // sólo estacionalidad de marzo
});

test('seed genera una cartera con los tres niveles de riesgo y acciones pendientes', () => {
  const L = D.loadLedger(fresh());
  const d = D.dashboard(L);
  assert.equal(d.familias, 64);
  for (const n of ['bajo', 'medio', 'alto']) assert.ok(d.niveles[n] > 0, `sin familias en ${n}`);
  assert.ok(D.accionesPendientes(L).length > 0);
  assert.ok(d.kpis.precision.precision > 0.5);
});

test('pagos: no se puede pagar más que el saldo y el pago salda la cuota', () => {
  const db = fresh();
  const L = D.loadLedger(db);
  const c = L.cuotas.find((x) => x.estado === 'pendiente');
  assert.throws(() => S.registrarPago(db, { cuota_id: c.id, monto: c.saldo + 1 }), /supera el saldo/);
  S.registrarPago(db, { cuota_id: c.id, medio: 'online' });
  const c2 = D.loadLedger(db).cuotaById.get(c.id);
  assert.equal(c2.estado, 'pagada');
  assert.equal(c2.saldo, 0);
});

test('plan de pagos: refinancia la deuda vencida en cuotas que suman lo mismo', () => {
  const db = fresh();
  let L = D.loadLedger(db);
  const fam = [...L.byFam.values()].find((f) => f.deuda_vencida > 0 && !f.planes.some((p) => p.estado === 'activo'));
  const deuda = fam.deuda_vencida;
  const planId = S.crearPlan(db, { familia_id: fam.familia.id, cuotas_n: 3 });
  L = D.loadLedger(db);
  const f2 = L.byFam.get(fam.familia.id);
  assert.equal(f2.deuda_vencida, 0);
  const cuotasPlan = L.cuotas.filter((c) => c.plan_id === planId);
  assert.equal(cuotasPlan.length, 3);
  assert.equal(cuotasPlan.reduce((a, c) => a + c.monto, 0), deuda);
  assert.equal(f2.planes.find((p) => p.id === planId).estado, 'activo');
});

test('bandeja: registrar la acción la quita de la lista', () => {
  const db = fresh();
  const [a] = D.accionesPendientes(D.loadLedger(db));
  S.registrarComunicacion(db, { familia_id: a.familia_id, cuota_id: a.cuota_id, etapa: a.etapa, canal: a.canal, mensaje: a.mensaje });
  const despues = D.accionesPendientes(D.loadLedger(db));
  assert.ok(!despues.some((x) => x.familia_id === a.familia_id && x.etapa === a.etapa));
});

test('generar cuotas aplica descuento por hermano y beca, sin duplicar', () => {
  const db = fresh();
  const fid = S.crearFamilia(db, {
    apellido: 'Test', responsable: 'Ana Test',
    alumnos: [{ nombre: 'A', apellido: 'Test', grado: 1 }, { nombre: 'B', apellido: 'Test', grado: 3, beca_pct: 50 }],
  });
  const r1 = S.generarCuotas(db, '2027-03');
  const r2 = S.generarCuotas(db, '2027-03');
  assert.ok(r1.creadas > 0);
  assert.equal(r2.creadas, 0);
  const c = db.prepare("SELECT monto FROM cuotas WHERE familia_id = ? AND periodo = '2027-03'").get(fid);
  // 185000 + 185000 * 0.5 (beca) * 0.9 (hermano) = 268250
  assert.equal(c.monto, 268250);
});

// ---- Gestión escolar y estadística ----
const E = require('../src/escolar');
const ST = require('../src/stats');

test('estadística: media, mediana, desvío, cuartiles y frecuencias', () => {
  const d = ST.describir([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(d.n, 8);
  assert.equal(d.media, 5);
  assert.equal(d.mediana, 4.5);
  assert.equal(d.moda, 4);
  assert.ok(Math.abs(d.desvio - 2.138) < 0.001); // desvío muestral
  assert.equal(d.p25, 4);
  const f = ST.frecuencias(['a', 'b', 'a', 'c'], ['a', 'b', 'c', 'd']);
  assert.deepEqual(f.map((x) => x.abs), [2, 1, 1, 0]);
  assert.equal(f[3].acum, 1);
  assert.ok(Math.abs(ST.pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9);
});

test('alta de alumno: valida DNI único, edad y cupo del curso', () => {
  const db = fresh();
  const fam = db.prepare('SELECT id FROM familias LIMIT 1').get().id;
  const anio = Number(db_.today(db).slice(0, 4));
  const base = { nombre: 'Lía', apellido: 'Prueba', grado: 1, seccion: 'A', fecha_nacimiento: `${anio - 6}-05-10`, dni: '60111222' };
  const id = E.crearAlumno(db, fam, base);
  assert.ok(id > 0);
  assert.throws(() => E.crearAlumno(db, fam, { ...base, nombre: 'Otra' }), /DNI/);
  assert.throws(() => E.crearAlumno(db, fam, { ...base, dni: '', fecha_nacimiento: `${anio - 30}-01-01` }), /primaria/);
  const c = db.prepare("SELECT * FROM cursos WHERE grado = 1 AND seccion = 'A'").get();
  E.actualizarCurso(db, c.id, { capacidad: db.prepare("SELECT COUNT(*) n FROM alumnos WHERE grado = 1 AND seccion = 'A' AND estado = 'activo'").get().n });
  assert.throws(() => E.crearAlumno(db, fam, { ...base, dni: '' }), /vacantes/);
});

test('baja y reincorporación de un alumno', () => {
  const db = fresh();
  const a = db.prepare("SELECT * FROM alumnos WHERE estado = 'activo' LIMIT 1").get();
  E.bajaAlumno(db, a.id, { motivo: 'Mudanza' });
  let r = db.prepare('SELECT * FROM alumnos WHERE id = ?').get(a.id);
  assert.equal(r.estado, 'baja');
  assert.equal(r.activo, 0);
  assert.throws(() => E.bajaAlumno(db, a.id, { motivo: 'Mudanza' }), /no está activo/);
  E.reincorporarAlumno(db, a.id);
  r = db.prepare('SELECT * FROM alumnos WHERE id = ?').get(a.id);
  assert.equal(r.estado, 'activo');
});

test('asistencia: se guarda por curso y se corrige sin duplicar', () => {
  const db = fresh();
  const c = E.listarCursos(db).find((x) => x.inscriptos > 0);
  let dia = db_.today(db);
  while (E.esFinDeSemana(dia)) dia = db_.addDays(dia, -1);
  const det = E.detalleCurso(db, c.id, dia);
  const registros = det.alumnos.map((a, i) => ({ alumno_id: a.id, estado: i === 0 ? 'ausente' : 'presente', justificada: true }));
  E.guardarAsistencia(db, c.id, { fecha: dia, registros });
  E.guardarAsistencia(db, c.id, { fecha: dia, registros });
  const filas = db.prepare('SELECT * FROM asistencia WHERE fecha = ? AND alumno_id = ?').all(dia, det.alumnos[0].id);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].estado, 'ausente');
  assert.throws(() => E.guardarAsistencia(db, c.id, { fecha: db_.addDays(db_.today(db), 7), registros }), /futura/);
});

test('estadísticas generales sobre los datos de demo', () => {
  const s = ST.estadisticas(fresh());
  assert.ok(s.matricula.total > 80);
  assert.equal(s.matricula.por_grado.reduce((a, f) => a + f.abs, 0), s.matricula.total);
  assert.ok(s.asistencia.pct.media > 80 && s.asistencia.pct.media <= 100);
  assert.ok(s.cobranza.correlacion.r > 0);
});

// ---- Cobranzas ----
const C = require('../src/cobranzas');

function familiaConDeuda(db) {
  const L = D.loadLedger(db);
  return [...L.byFam.values()].find((f) => f.deuda_vencida > 0 && !f.promesa && !f.planes.some((p) => p.estado === 'activo'));
}

test('cobro: imputa a la deuda más antigua y deja el excedente como saldo a favor', () => {
  const db = fresh();
  const fam = familiaConDeuda(db);
  const abiertas = C.cargosAbiertos(db, fam.familia.id);
  const total = abiertas.reduce((a, c) => a + c.saldo, 0);
  const r = C.registrarCobro(db, { familia_id: fam.familia.id, monto: total + 1000, medio: 'efectivo' });
  assert.equal(r.imputaciones[0].cuota_id, abiertas[0].id); // la más antigua primero
  assert.equal(r.saldo_a_favor, 1000);
  assert.match(r.comprobante, /^0001-\d{8}$/);
  const L = D.loadLedger(db);
  const f2 = L.byFam.get(fam.familia.id);
  assert.equal(f2.deuda_vencida, 0);
  assert.equal(f2.saldo_a_favor, 1000);
});

test('cobro parcial y anulación: la deuda vuelve a quedar pendiente', () => {
  const db = fresh();
  const fam = familiaConDeuda(db);
  const deuda = fam.deuda_vencida;
  const r = C.registrarCobro(db, { familia_id: fam.familia.id, monto: 1000, medio: 'transferencia' });
  assert.equal(D.loadLedger(db).byFam.get(fam.familia.id).deuda_vencida, deuda - 1000);
  C.anularCobro(db, r.id, { motivo: 'Transferencia no acreditada' });
  assert.equal(D.loadLedger(db).byFam.get(fam.familia.id).deuda_vencida, deuda);
  assert.throws(() => C.anularCobro(db, r.id, { motivo: 'otra vez' }), /no está vigente/);
});

test('cuenta corriente: el saldo concilia con deuda, saldo a favor y pagos adelantados', () => {
  const L = D.loadLedger(fresh());
  for (const fam of L.byFam.values()) {
    const adelantado = fam.cuotas.filter((c) => c.vencimiento > L.hoy).reduce((a, c) => a + c.pagado, 0);
    assert.equal(D.cuentaCorriente(L, fam).saldo, fam.deuda_vencida - fam.saldo_a_favor - adelantado, fam.familia.apellido);
  }
});

test('recargos por mora: se liquidan una vez por mes de atraso y se pueden condonar', () => {
  const db = fresh();
  assert.equal(C.liquidarRecargos(db).creados, 0); // el seed ya los liquidó: es idempotente
  const fam = familiaConDeuda(db);
  const db2 = db;
  const recargo = C.cargosAbiertos(db2, fam.familia.id).find((c) => c.tipo === 'recargo');
  assert.ok(recargo, 'la familia con deuda debería tener recargos');
  const r = C.condonar(db2, { cuota_ids: [recargo.id], motivo: 'Buena voluntad' });
  assert.match(r.comprobante, /^NC /);
  assert.ok(!C.cargosAbiertos(db2, fam.familia.id).some((c) => c.id === recargo.id));
});

test('cargo masivo por alumno y aplicación automática del saldo a favor', () => {
  const db = fresh();
  const L = D.loadLedger(db);
  const conFavor = [...L.byFam.values()].find((f) => f.saldo_a_favor > 0);
  assert.ok(conFavor, 'el seed incluye una familia con saldo a favor');
  const r = C.crearCargo(db, { alcance: 'alumnos', concepto: 'Materiales 2027', monto: 20000, vencimiento: db_.addDays(db_.today(db), 20) });
  assert.ok(r.creados > 50);
  const again = C.crearCargo(db, { alcance: 'alumnos', concepto: 'Materiales 2027', monto: 20000, vencimiento: db_.addDays(db_.today(db), 20) });
  assert.equal(again.creados, 0); // no duplica
  const f2 = D.loadLedger(db).byFam.get(conFavor.familia.id);
  assert.ok(f2.saldo_a_favor < conFavor.saldo_a_favor); // el saldo a favor pagó el cargo nuevo
});

test('promesa de pago: pausa la bandeja y se cumple con un cobro', () => {
  const db = fresh();
  const fam = familiaConDeuda(db);
  const id = fam.familia.id;
  C.crearPromesa(db, { familia_id: id, fecha_promesa: db_.addDays(db_.today(db), 5), monto: fam.deuda_vencida });
  let L = D.loadLedger(db);
  assert.equal(L.byFam.get(id).promesa.estado, 'pendiente');
  assert.ok(!D.accionesPendientes(L).some((a) => a.familia_id === id));
  C.registrarCobro(db, { familia_id: id, monto: fam.deuda_vencida, medio: 'efectivo' });
  L = D.loadLedger(db);
  assert.equal(L.byFam.get(id).promesas[0].estado, 'cumplida');
  assert.throws(() => C.crearPromesa(db, { familia_id: id, fecha_promesa: db_.addDays(db_.today(db), -1), monto: 10 }), /pasada/);
});

test('débito automático: el lote acredita y registra rechazos', () => {
  const db = fresh();
  const periodo = db_.today(db).slice(0, 7);
  const lote = C.loteDebito(db, periodo);
  assert.ok(lote.length >= 2, 'hay familias adheridas con la cuota del mes pendiente');
  const items = lote.map((x, i) => ({ cuota_id: x.cuota_id, rechazado: i === 0, motivo: 'Fondos insuficientes' }));
  const r = C.procesarLote(db, { periodo, items });
  assert.equal(r.rechazados, 1);
  assert.equal(r.aceptados, lote.length - 1);
  const pendientes = C.loteDebito(db, periodo);
  assert.equal(pendientes.length, 1); // sólo queda el rechazado
  assert.equal(pendientes[0].rechazos, 1);
});

test('deudores por antigüedad: los tramos suman el total vencido', () => {
  const d = D.deudores(D.loadLedger(fresh()));
  const t = d.totales;
  assert.equal(t.d1_30 + t.d31_60 + t.d61_90 + t.d90, t.vencido);
  assert.ok(d.filas.every((f) => f.vencido > 0));
});

// ---- Inteligencia de cobranza (ML) ----
const ML = require('../src/ml');

test('regresión logística: aprende un patrón separable y el AUC lo refleja', () => {
  const X = [], y = [];
  for (let i = 0; i < 200; i++) { const v = (i % 50) / 50; X.push([v, (i * 7) % 3]); y.push(v > 0.5 ? 1 : 0); }
  const m = ML.entrenar(X, y);
  assert.ok(ML.predecir(m, [0.9, 1]) > 0.8);
  assert.ok(ML.predecir(m, [0.1, 1]) < 0.2);
  assert.equal(ML.auc([0.1, 0.4, 0.35, 0.8], [0, 0, 1, 1]), 0.75);
});

test('inteligencia de cobranza sobre los datos de demo', () => {
  const r = ML.inteligencia(fresh());
  const ev = r.modelo.evaluacion;
  assert.ok(ev && ev.ml.auc > 0.75, 'el modelo debe anticipar mejor que el azar');
  assert.ok(r.segmentos.every((s) => s.familias > 0), 'los cuatro segmentos tienen familias');
  assert.ok(r.segmentos.find((s) => s.key === 'tardio').estacionales >= 1, 'aparece el caso estacional');
  assert.ok(r.priorizacion.lista.length > 0 && r.priorizacion.lista.every((f, i, a) => !i || a[i - 1].esperado >= f.esperado), 'ranking ordenado');
  assert.equal(r.flujo.proyeccion.length, 3);
  assert.ok(r.flujo.proyeccion.every((m) => m.esperado >= 0 && m.facturado > 0));
  const titulos = r.anomalias.map((a) => a.titulo);
  assert.ok(titulos.includes('Cambio brusco de comportamiento'));
  assert.ok(titulos.includes('Posible cobro duplicado'));
  assert.ok(titulos.includes('Importe distinto del esperado'));
  assert.ok(r.bajas.some((b) => b.nivel === 'alto'), 'hay al menos un riesgo de baja alto');
  assert.equal(r.simulacion.segmentos.length, 4);
});
