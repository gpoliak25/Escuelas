'use strict';
// Estadística descriptiva: medidas de resumen, tablas de frecuencia, histogramas y correlación.
const { addDays } = require('./db');
const { loadLedger } = require('./domain');
const { scoreFamily, cuotaAt, ATRASO_RELEVANTE } = require('./risk');
const { montoFamilia } = require('./services');
const { edad, resumenAsistencia, listarCursos } = require('./escolar');

function cuantil(ordenados, q) {
  if (!ordenados.length) return null;
  const pos = (ordenados.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return ordenados[lo] + (ordenados[hi] - ordenados[lo]) * (pos - lo);
}

/** Medidas de posición y dispersión de una variable numérica. */
function describir(valores) {
  const v = valores.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0 };
  const media = v.reduce((a, b) => a + b, 0) / n;
  const varianza = n > 1 ? v.reduce((a, x) => a + (x - media) ** 2, 0) / (n - 1) : 0;
  const desvio = Math.sqrt(varianza);
  // Moda: el valor más frecuente (útil en variables discretas).
  const cuenta = new Map();
  for (const x of v) cuenta.set(x, (cuenta.get(x) || 0) + 1);
  let moda = null, max = 0;
  for (const [x, c] of cuenta) if (c > max) { max = c; moda = x; }
  // Asimetría (coeficiente de Fisher, muestral).
  const asimetria = n > 2 && desvio > 0
    ? (n / ((n - 1) * (n - 2))) * v.reduce((a, x) => a + ((x - media) / desvio) ** 3, 0)
    : null;
  const p25 = cuantil(v, 0.25), p75 = cuantil(v, 0.75);
  return {
    n, media, mediana: cuantil(v, 0.5), moda: max > 1 ? moda : null, desvio, varianza,
    min: v[0], max: v[n - 1], rango: v[n - 1] - v[0], p25, p75, p90: cuantil(v, 0.9), riq: p75 - p25,
    cv: media ? desvio / Math.abs(media) : null, asimetria,
  };
}

/** Tabla de frecuencias absoluta, relativa y relativa acumulada. */
function frecuencias(valores, orden = null) {
  const cuenta = new Map();
  for (const x of valores) cuenta.set(x, (cuenta.get(x) || 0) + 1);
  const claves = orden || [...cuenta.keys()].sort((a, b) => cuenta.get(b) - cuenta.get(a));
  const total = valores.length;
  let acum = 0;
  return claves.map((k) => {
    const abs = cuenta.get(k) || 0;
    acum += abs;
    return { valor: String(k), abs, rel: total ? abs / total : 0, acum: total ? acum / total : 0 };
  });
}

/** Histograma en intervalos [desde, hasta). */
function histograma(valores, cortes) {
  const etiquetas = cortes.map((c) => c.label);
  const asignar = (x) => cortes.find((c) => x >= c.desde && x < c.hasta)?.label;
  return frecuencias(valores.map(asignar).filter(Boolean), etiquetas);
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

const GENERO = { F: 'Femenino', M: 'Masculino', X: 'No binario', '': 'Sin informar' };
const MEDIO = { debito: 'Débito automático', transferencia: 'Transferencia', efectivo: 'Efectivo', online: 'Pago online', tarjeta: 'Tarjeta' };
const GRADOS = [1, 2, 3, 4, 5, 6, 7].map((g) => `${g}°`);
const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];

function estadisticas(db) {
  const L = loadLedger(db);
  const hoy = L.hoy;
  const ciclo = hoy.slice(0, 4);
  const inicioCiclo = `${ciclo}-01-01`;

  // ---- Matrícula ----
  const alumnos = db.prepare('SELECT a.*, c.turno FROM alumnos a LEFT JOIN cursos c ON c.grado = a.grado AND c.seccion = a.seccion').all();
  const activos = alumnos.filter((a) => a.estado === 'activo');
  const bajasCiclo = alumnos.filter((a) => a.estado !== 'activo' && (a.fecha_baja || '') >= inicioCiclo);
  const altasCiclo = alumnos.filter((a) => (a.fecha_ingreso || '') >= inicioCiclo);
  const edades = activos.map((a) => edad(a.fecha_nacimiento, hoy)).filter((e) => e != null);
  const cursos = listarCursos(db);

  const matricula = {
    total: activos.length,
    altas_ciclo: altasCiclo.length,
    bajas_ciclo: bajasCiclo.length,
    tasa_bajas: activos.length + bajasCiclo.length ? bajasCiclo.length / (activos.length + bajasCiclo.length) : 0,
    ocupacion: cursos.reduce((a, c) => a + c.inscriptos, 0) / (cursos.reduce((a, c) => a + c.capacidad, 0) || 1),
    vacantes: cursos.reduce((a, c) => a + c.vacantes, 0),
    por_grado: frecuencias(activos.map((a) => `${a.grado}°`), GRADOS),
    por_turno: frecuencias(activos.map((a) => (a.turno === 'tarde' ? 'Tarde' : 'Mañana')), ['Mañana', 'Tarde']),
    por_genero: frecuencias(activos.map((a) => GENERO[a.genero || '']), Object.values(GENERO)).filter((f) => f.abs),
    motivos_baja: frecuencias(bajasCiclo.map((a) => a.motivo_baja || 'Otro')),
    edad: describir(edades),
    edad_por_grado: [1, 2, 3, 4, 5, 6, 7].map((g) => ({
      grupo: `${g}°`,
      ...describir(activos.filter((a) => a.grado === g).map((a) => edad(a.fecha_nacimiento, hoy)).filter((e) => e != null)),
    })),
    cursos: cursos.map((c) => ({ curso: c.nombre, turno: c.turno, inscriptos: c.inscriptos, capacidad: c.capacidad, ocupacion: c.inscriptos / c.capacidad })),
  };

  // ---- Familias ----
  const famActivas = [...L.byFam.values()].filter((f) => f.familia.activa);
  const hijos = famActivas.map((f) => f.alumnos.filter((a) => a.estado === 'activo').length).filter((n) => n > 0);
  const becados = activos.filter((a) => a.beca_pct > 0);
  const familias = {
    total: famActivas.length,
    hijos: describir(hijos),
    hijos_frec: frecuencias(hijos.map((n) => (n >= 4 ? '4 o más' : String(n))), ['1', '2', '3', '4 o más']),
    medios_pago: frecuencias(famActivas.map((f) => MEDIO[f.familia.medio_pago] || f.familia.medio_pago)),
    becas: { alumnos: becados.length, pct: activos.length ? becados.length / activos.length : 0, porcentaje: describir(becados.map((a) => a.beca_pct)) },
    cuota: describir(famActivas.map((f) => montoFamilia(f.alumnos, L.settings)).filter((m) => m > 0)),
  };

  // ---- Cobranza (cuotas de arancel vencidas en los últimos 12 meses) ----
  const desde12 = addDays(hoy, -365);
  const cuotas = L.cuotas.filter((c) => !c.plan_id && c.vencimiento >= desde12 && c.vencimiento < hoy);
  const atrasos = cuotas.map((c) => c.atraso);
  const medioDe = (c) => MEDIO[L.byFam.get(c.familia_id).familia.medio_pago];
  const puntajes = famActivas.map((f) => f.riesgo.puntaje);

  // Puntaje calculado 10 días antes de cada vencimiento vs. atraso real (últimos 6 meses con resultado conocido)
  const pares = [];
  const limite = addDays(hoy, -(ATRASO_RELEVANTE + 1));
  for (const fam of famActivas) {
    for (const c of fam.cuotas) {
      if (c.plan_id || c.vencimiento > limite || c.vencimiento < addDays(hoy, -186)) continue;
      const r = scoreFamily(fam, addDays(c.vencimiento, -ATRASO_RELEVANTE), c.vencimiento, L.umbrales);
      const s = cuotaAt(c, hoy);
      pares.push([r.puntaje, s.atraso]);
    }
  }

  const cobranza = {
    cuotas: cuotas.length,
    atraso: describir(atrasos),
    atraso_hist: histograma(atrasos, [
      { label: 'En término', desde: 0, hasta: 1 },
      { label: '1 a 5 días', desde: 1, hasta: 6 },
      { label: '6 a 10', desde: 6, hasta: 11 },
      { label: '11 a 30', desde: 11, hasta: 31 },
      { label: '31 a 60', desde: 31, hasta: 61 },
      { label: 'Más de 60', desde: 61, hasta: Infinity },
    ]),
    atraso_por_medio: [...new Set(cuotas.map(medioDe))].map((m) => ({ grupo: m, ...describir(cuotas.filter((c) => medioDe(c) === m).map((c) => c.atraso)) }))
      .sort((a, b) => b.media - a.media),
    puntaje: describir(puntajes),
    puntaje_hist: histograma(puntajes, Array.from({ length: 10 }, (_, i) => ({ label: `${i * 10}–${i * 10 + 9}`, desde: i * 10, hasta: i === 9 ? 101 : i * 10 + 10 }))),
    correlacion: { r: pearson(pares.map((p) => p[0]), pares.map((p) => p[1])), n: pares.length },
  };

  // ---- Asistencia (últimos 30 días) ----
  const desde30 = addDays(hoy, -30);
  const resumen = resumenAsistencia(db, desde30, hoy);
  const conDatos = activos.filter((a) => resumen.get(a.id));
  const pcts = conDatos.map((a) => resumen.get(a.id).pct * 100);
  const registros = db.prepare('SELECT s.fecha, s.estado, s.justificada FROM asistencia s JOIN alumnos a ON a.id = s.alumno_id WHERE s.fecha > ? AND s.fecha <= ? AND a.estado = \'activo\'').all(desde30, hoy);
  const ausencias = registros.filter((r) => r.estado === 'ausente');
  const porDia = DIAS.map((d, i) => {
    const delDia = registros.filter((r) => new Date(r.fecha + 'T12:00:00Z').getUTCDay() === i + 1);
    return { valor: d, abs: delDia.filter((r) => r.estado === 'ausente').length, rel: delDia.length ? delDia.filter((r) => r.estado === 'ausente').length / delDia.length : 0 };
  });
  const asistencia = {
    alumnos: conDatos.length,
    dias: new Set(registros.map((r) => r.fecha)).size,
    pct: describir(pcts),
    pct_hist: histograma(pcts, [
      { label: 'Menos de 75%', desde: 0, hasta: 75 },
      { label: '75 a 85%', desde: 75, hasta: 85 },
      { label: '85 a 90%', desde: 85, hasta: 90 },
      { label: '90 a 95%', desde: 90, hasta: 95 },
      { label: '95 a 100%', desde: 95, hasta: 100.01 },
    ]),
    cronico: pcts.filter((p) => p < 90).length,
    tardanzas: registros.filter((r) => r.estado === 'tarde').length,
    justificadas: ausencias.length ? ausencias.filter((r) => r.justificada).length / ausencias.length : null,
    por_grado: [1, 2, 3, 4, 5, 6, 7].map((g) => ({ grupo: `${g}°`, ...describir(conDatos.filter((a) => a.grado === g).map((a) => resumen.get(a.id).pct * 100)) })),
    por_dia: porDia,
  };

  // Tabla resumen de variables numéricas
  const resumenVariables = [
    { variable: 'Edad de los alumnos', unidad: 'años', ...matricula.edad },
    { variable: 'Hijos por familia', unidad: 'alumnos', ...familias.hijos },
    { variable: 'Cuota mensual familiar', unidad: '$', ...familias.cuota },
    { variable: 'Beca (alumnos becados)', unidad: '%', ...familias.becas.porcentaje },
    { variable: 'Días de atraso por cuota', unidad: 'días', ...cobranza.atraso },
    { variable: 'Puntaje de riesgo actual', unidad: 'puntos', ...cobranza.puntaje },
    { variable: 'Asistencia por alumno (30 días)', unidad: '%', ...asistencia.pct },
  ];

  return { hoy, ciclo, resumen: resumenVariables, matricula, familias, cobranza, asistencia };
}

module.exports = { describir, frecuencias, histograma, pearson, cuantil, estadisticas };
