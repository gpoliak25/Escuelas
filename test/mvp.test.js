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
