'use strict';
const D = require('./domain');
const S = require('./services');
const { getSettings, setSettings, today, DEFAULT_SETTINGS } = require('./db');
const { SENALES } = require('./risk');
const { seed } = require('./seed');
const E = require('./escolar');
const { estadisticas } = require('./stats');

const { HttpError } = S;
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '(\\d+)')) + '$');
  routes.push({ method, re, keys, handler });
};

// ---- Tablero y cobranza ----

route('GET', '/api/dashboard', ({ db }) => D.dashboard(D.loadLedger(db)));

route('GET', '/api/acciones', ({ db }) => {
  const L = D.loadLedger(db);
  return { hoy: L.hoy, acciones: D.accionesPendientes(L) };
});

// Registrar la acción ejecutada (o la decisión de omitirla) desde la bandeja.
route('POST', '/api/acciones', ({ db, body }) => ({ id: S.registrarComunicacion(db, body) }));

// ---- Familias ----

route('GET', '/api/familias', ({ db, query }) => {
  const L = D.loadLedger(db);
  const q = (query.get('q') || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const nivel = query.get('nivel');
  const estado = query.get('estado');
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  let lista = [...L.byFam.values()].map(D.resumenFamilia);
  if (q) lista = lista.filter((f) => norm(`${f.apellido} ${f.responsable} ${f.email} ${f.alumnos.join(' ')}`).includes(q));
  if (nivel) lista = lista.filter((f) => f.riesgo.nivel === nivel);
  if (estado === 'deuda') lista = lista.filter((f) => f.deuda_vencida > 0);
  if (estado === 'inactivas') lista = lista.filter((f) => !f.activa);
  else lista = lista.filter((f) => f.activa);
  return { hoy: L.hoy, familias: lista };
});

route('POST', '/api/familias', ({ db, body }) => ({ id: S.crearFamilia(db, body) }));

route('GET', '/api/familias/:id', ({ db, params }) => {
  const L = D.loadLedger(db);
  const d = D.detalleFamilia(L, params.id);
  if (!d) throw new HttpError(404, 'Familia inexistente');
  d.hoy = L.hoy;
  d.monto_mensual = S.montoFamilia(d.alumnos, L.settings);
  return d;
});

route('PUT', '/api/familias/:id', ({ db, params, body }) => { S.actualizarFamilia(db, params.id, body); return { ok: true }; });
route('POST', '/api/familias/:id/alumnos', ({ db, params, body }) => ({ id: S.crearAlumno(db, params.id, body) }));
route('PUT', '/api/alumnos/:id', ({ db, params, body }) => { S.actualizarAlumno(db, params.id, body); return { ok: true }; });

// ---- Alumnos, cursos y asistencia ----

route('GET', '/api/alumnos', ({ db }) => ({ hoy: today(db), alumnos: E.listarAlumnos(db), cursos: E.listarCursos(db), motivos_baja: E.MOTIVOS_BAJA }));

// Alta de alumno: en una familia existente (familia_id) o creando la familia en el mismo paso (familia: {...}).
route('POST', '/api/alumnos', ({ db, body }) => {
  const { familia_id, familia, ...alumno } = body;
  if (familia_id) return { id: E.crearAlumno(db, Number(familia_id), alumno) };
  if (!familia) throw new HttpError(400, 'Indicá la familia del alumno');
  const famId = S.crearFamilia(db, { ...familia, alumnos: [alumno] });
  const id = db.prepare('SELECT id FROM alumnos WHERE familia_id = ? ORDER BY id DESC').get(famId).id;
  return { id, familia_id: famId };
});

route('GET', '/api/alumnos/:id', ({ db, params }) => E.fichaAlumno(db, params.id));
route('POST', '/api/alumnos/:id/baja', ({ db, params, body }) => { E.bajaAlumno(db, params.id, body); return { ok: true }; });
route('POST', '/api/alumnos/:id/reincorporar', ({ db, params }) => { E.reincorporarAlumno(db, params.id); return { ok: true }; });

route('GET', '/api/familias/opciones', ({ db }) => ({
  familias: db.prepare('SELECT id, apellido, responsable FROM familias WHERE activa = 1 ORDER BY apellido, responsable').all(),
}));

route('GET', '/api/cursos', ({ db }) => ({ hoy: today(db), cursos: E.listarCursos(db) }));
route('POST', '/api/cursos', ({ db, body }) => ({ id: E.crearCurso(db, body) }));
route('PUT', '/api/cursos/:id', ({ db, params, body }) => { E.actualizarCurso(db, params.id, body); return { ok: true }; });
route('GET', '/api/cursos/:id', ({ db, params, query }) => E.detalleCurso(db, params.id, query.get('fecha')));
route('POST', '/api/cursos/:id/asistencia', ({ db, params, body }) => E.guardarAsistencia(db, params.id, body));

// ---- Estadística descriptiva ----

route('GET', '/api/estadisticas', ({ db }) => estadisticas(db));

// ---- Cuotas, pagos y planes ----

route('GET', '/api/cuotas', ({ db, query }) => {
  const L = D.loadLedger(db);
  const periodos = [...new Set(L.cuotas.filter((c) => !c.plan_id).map((c) => c.periodo))].sort().reverse();
  const periodo = query.get('periodo') || periodos.find((p) => p <= L.hoy.slice(0, 7)) || periodos[0];
  const cuotas = L.cuotas
    .filter((c) => c.periodo === periodo && !c.plan_id)
    .map(({ pagos, refinanciada_fecha, ...c }) => {
      const fam = L.byFam.get(c.familia_id);
      return { ...c, familia: fam.familia.apellido, responsable: fam.familia.responsable, nivel: fam.riesgo.nivel };
    })
    .sort((a, b) => a.familia.localeCompare(b.familia));
  const resumen = D.serieMensual(L, 100).find((s) => s.periodo === periodo) || null;
  const mes = Number(L.hoy.slice(5, 7));
  const sig = `${mes === 12 ? Number(L.hoy.slice(0, 4)) + 1 : L.hoy.slice(0, 4)}-${String(mes === 12 ? 1 : mes + 1).padStart(2, '0')}`;
  return { hoy: L.hoy, periodo, periodos, cuotas, resumen, sugerido_generar: periodos.includes(sig) ? null : sig };
});

route('POST', '/api/cuotas/generar', ({ db, body }) => S.generarCuotas(db, body.periodo));
route('POST', '/api/pagos', ({ db, body }) => ({ id: S.registrarPago(db, body) }));

route('GET', '/api/planes', ({ db }) => {
  const L = D.loadLedger(db);
  const planes = L.planes.map((p) => {
    const fam = L.byFam.get(p.familia_id);
    const cuotas = L.cuotas.filter((c) => c.plan_id === p.id).map(({ pagos, refinanciada_fecha, ...c }) => c);
    return { ...p, familia: fam.familia.apellido, responsable: fam.familia.responsable, cuotas };
  });
  const solicitudes = L.eventos
    .filter((e) => e.tipo === 'solicitud_plan' && !e.atendido)
    .map((e) => {
      const fam = L.byFam.get(e.familia_id);
      return { ...e, familia: fam.familia.apellido, responsable: fam.familia.responsable, deuda: fam.deuda_vencida, riesgo: fam.riesgo.nivel };
    });
  return { hoy: L.hoy, planes, solicitudes };
});

route('POST', '/api/planes', ({ db, body }) => ({ id: S.crearPlan(db, body) }));
route('POST', '/api/eventos/:id/atender', ({ db, params }) => { S.atenderEvento(db, params.id); return { ok: true }; });

// ---- Comunicaciones ----

route('POST', '/api/comunicaciones', ({ db, body }) => ({ id: S.registrarComunicacion(db, body) }));
route('PUT', '/api/comunicaciones/:id', ({ db, params, body }) => { S.marcarComunicacion(db, params.id, body); return { ok: true }; });

// ---- Motor de riesgo ----

route('GET', '/api/riesgo', ({ db }) => {
  const L = D.loadLedger(db);
  const familias = [...L.byFam.values()].filter((f) => f.familia.activa).map((f) => ({
    ...D.resumenFamilia(f),
    factores: f.riesgo.factores.map(({ key, puntos }) => ({ key, puntos })),
  })).sort((a, b) => b.riesgo.puntaje - a.riesgo.puntaje);
  return { hoy: L.hoy, umbrales: L.umbrales, senales: SENALES, familias, precision: D.precisionAlertas(L), prevencion: D.PREVENCION };
});

// ---- Configuración ----

route('GET', '/api/config', ({ db }) => ({ settings: getSettings(db), hoy: today(db), claves: Object.keys(DEFAULT_SETTINGS) }));

route('PUT', '/api/config', ({ db, body }) => {
  const v = { ...body };
  if (v.fecha_simulada && !/^\d{4}-\d{2}-\d{2}$/.test(v.fecha_simulada)) throw new HttpError(400, 'La fecha simulada debe tener formato AAAA-MM-DD');
  for (const k of ['arancel_mensual', 'descuento_hermano_pct', 'dia_vencimiento', 'umbral_medio', 'umbral_alto']) {
    if (v[k] !== undefined && !Number.isFinite(Number(v[k]))) throw new HttpError(400, `"${k}" debe ser numérico`);
  }
  if (v.dia_vencimiento !== undefined && (v.dia_vencimiento < 1 || v.dia_vencimiento > 28)) throw new HttpError(400, 'El día de vencimiento debe estar entre 1 y 28');
  if (v.umbral_medio !== undefined && v.umbral_alto !== undefined && Number(v.umbral_medio) >= Number(v.umbral_alto)) {
    throw new HttpError(400, 'El umbral de riesgo medio debe ser menor que el de riesgo alto');
  }
  setSettings(db, v);
  return { ok: true };
});

route('POST', '/api/demo/reset', ({ db }) => seed(db));

// ---- Portal de familias ----
// MVP: se ingresa con el código de portal de la familia. En producción esto debe
// reemplazarse por usuarios con contraseña o enlace mágico por mail.

function familiaPortal(db, headers) {
  const code = String(headers['x-portal-code'] || '').trim().toUpperCase();
  const f = code && db.prepare('SELECT * FROM familias WHERE codigo_portal = ? AND activa = 1').get(code);
  if (!f) throw new HttpError(401, 'Código de acceso inválido');
  return f;
}

route('POST', '/api/portal/login', ({ db, body }) => {
  const f = familiaPortal(db, { 'x-portal-code': body.codigo });
  S.registrarEvento(db, f.id, 'consulta_saldo');
  db.prepare("UPDATE eventos SET atendido = 1 WHERE familia_id = ? AND tipo = 'consulta_saldo'").run(f.id);
  return { codigo: f.codigo_portal };
});

route('GET', '/api/portal/estado', ({ db, headers }) => {
  const f = familiaPortal(db, headers);
  const L = D.loadLedger(db);
  const fam = L.byFam.get(f.id);
  const cuotas = fam.cuotas
    .filter((c) => c.estado !== 'refinanciada')
    .map(({ id, concepto, monto, saldo, vencimiento, estado, fecha_pago, atraso, plan_id }) => ({ id, concepto, monto, saldo, vencimiento, estado, fecha_pago, atraso, plan_id }))
    .reverse();
  return {
    hoy: L.hoy,
    escuela: L.settings.escuela_nombre,
    familia: { apellido: f.apellido, responsable: f.responsable, email: f.email, medio_pago: f.medio_pago },
    alumnos: fam.alumnos.filter((a) => a.activo).map((a) => ({ nombre: a.nombre, apellido: a.apellido, grado: a.grado })),
    cuotas,
    deuda_vencida: fam.deuda_vencida,
    proxima: fam.proxima ? { concepto: fam.proxima.concepto, saldo: fam.proxima.saldo, vencimiento: fam.proxima.vencimiento } : null,
    planes: fam.planes.map(({ id, fecha, monto_total, cuotas_n, estado, cuotas_pagadas }) => ({ id, fecha, monto_total, cuotas_n, estado, cuotas_pagadas })),
    solicitud_pendiente: fam.eventos.some((e) => e.tipo === 'solicitud_plan' && !e.atendido),
  };
});

route('POST', '/api/portal/pagar', ({ db, headers, body }) => {
  const f = familiaPortal(db, headers);
  const ids = Array.isArray(body.cuota_ids) ? body.cuota_ids.map(Number) : [];
  if (!ids.length) throw new HttpError(400, 'Elegí al menos una cuota');
  let total = 0;
  for (const id of ids) {
    const { cuota, saldo } = S.saldoCuota(db, id);
    if (cuota.familia_id !== f.id) throw new HttpError(403, 'La cuota no pertenece a la familia');
    if (saldo > 0) { S.registrarPago(db, { cuota_id: id, monto: saldo, medio: 'online' }); total += saldo; }
  }
  return { ok: true, total };
});

route('POST', '/api/portal/solicitar-plan', ({ db, headers, body }) => {
  const f = familiaPortal(db, headers);
  S.registrarEvento(db, f.id, 'solicitud_plan', `Pedido desde el portal: "${String(body.mensaje || 'Solicito un plan de pagos').trim()}"`);
  return { ok: true };
});

route('POST', '/api/portal/debito', ({ db, headers }) => {
  const f = familiaPortal(db, headers);
  if (f.medio_pago !== 'debito') S.actualizarFamilia(db, f.id, { medio_pago: 'debito' });
  return { ok: true };
});

function dispatch(ctx) {
  for (const r of routes) {
    if (r.method !== ctx.method) continue;
    const m = r.re.exec(ctx.pathname);
    if (!m) continue;
    ctx.params = Object.fromEntries(r.keys.map((k, i) => [k, Number(m[i + 1])]));
    return r.handler(ctx);
  }
  throw new HttpError(404, 'Ruta inexistente');
}

module.exports = { dispatch, HttpError };
