'use strict';
// Análisis estadístico de la morosidad: dataset en tres tablas (alumno, familia, cuota), validación,
// cruces inferenciales a nivel familia, validación del puntaje (ROC), Pareto y conclusiones automáticas.
// Es la misma lógica que analisis/analisis_morosidad.py, que corre sobre el dataset exportado.
const { addDays } = require('./db');
const { loadLedger } = require('./domain');
const { montoFamilia } = require('./services');
const { edad, resumenAsistencia } = require('./escolar');
const { describir, cuantil, UMBRAL_MOROSO_DIAS } = require('./stats');
const I = require('./inferencia');

const CONFIG = {
  UMBRAL_MOROSO_DIAS, // familia morosa: al menos una cuota con atraso mayor a este valor
  ALFA: 0.05,
  CORTES_RIESGO: [0.25, 0.75], // percentiles del puntaje para bajo / medio / alto
  CORTES_ASISTENCIA: [90, 95], // % de asistencia: menos de 90, 90 a 95, 95 o más
  PARETO_REFERENCIA: 0.8,
  TOP_PUNTAJE: 0.2, // fracción de familias con mayor puntaje para el Pareto del puntaje
  BOOTSTRAP: 1000,
  MONTE_CARLO: 10000,
  SEMILLA: 20261014,
};

// ---------- 0. Datos ----------

/**
 * Las tres tablas del análisis, sin datos personales (sólo identificadores).
 * Cuotas: las mismas que la estadística descriptiva (vencidas en los últimos 12 meses, sin cuotas de planes).
 */
function dataset(db) {
  const L = loadLedger(db);
  const hoy = L.hoy;
  const familias = [...L.byFam.values()].filter((f) => f.familia.activa);
  const asis = resumenAsistencia(db, addDays(hoy, -30), hoy);
  const desde12 = addDays(hoy, -365);
  const alumnos = [], fams = [], cuotas = [];
  for (const f of familias) {
    const activos = f.alumnos.filter((a) => a.estado === 'activo');
    for (const a of activos) {
      const r = asis.get(a.id);
      alumnos.push({ id_alumno: a.id, id_familia: f.familia.id, edad: edad(a.fecha_nacimiento, hoy), beca_pct: a.beca_pct || 0, asistencia_30d_pct: r && r.pct != null ? Math.round(r.pct * 1000) / 10 : null });
    }
    fams.push({ id_familia: f.familia.id, hijos_por_familia: activos.length, cuota_mensual_familiar: montoFamilia(f.alumnos, L.settings), puntaje_riesgo_actual: f.riesgo.puntaje });
    for (const c of f.cuotas) {
      if (c.plan_id || c.vencimiento < desde12 || c.vencimiento >= hoy) continue;
      cuotas.push({ id_cuota: c.id, id_familia: f.familia.id, dias_atraso: c.atraso, monto_adeudado: c.estado === 'vencida' ? c.saldo : 0 });
    }
  }
  return { hoy, alumnos, familias: fams, cuotas, L };
}

// ---------- 1. Validación ----------

/** Nulos, duplicados, rangos imposibles e identificadores huérfanos. Informa, no aborta. */
function validar({ alumnos, familias, cuotas }) {
  const out = [];
  const add = (tabla, chequeo, n, detalle = '') => out.push({ tabla, chequeo, n, ok: n === 0, detalle });
  const nulos = (rows, campos, tabla) => campos.forEach((k) => add(tabla, `Nulos en ${k}`, rows.filter((r) => r[k] == null || Number.isNaN(r[k])).length));
  const dup = (rows, k, tabla) => { const s = new Set(); let n = 0; for (const r of rows) { if (s.has(r[k])) n++; s.add(r[k]); } add(tabla, `Duplicados de ${k}`, n); };
  const rango = (rows, k, min, max, tabla) => add(tabla, `${k} fuera de ${min} a ${max}`, rows.filter((r) => r[k] != null && (r[k] < min || r[k] > max)).length);
  nulos(alumnos, ['id_familia', 'edad', 'asistencia_30d_pct'], 'alumnos');
  dup(alumnos, 'id_alumno', 'alumnos');
  rango(alumnos, 'asistencia_30d_pct', 0, 100, 'alumnos');
  rango(alumnos, 'beca_pct', 0, 100, 'alumnos');
  rango(alumnos, 'edad', 3, 18, 'alumnos');
  nulos(familias, ['cuota_mensual_familiar', 'puntaje_riesgo_actual'], 'familias');
  dup(familias, 'id_familia', 'familias');
  rango(familias, 'puntaje_riesgo_actual', 0, 100, 'familias');
  add('familias', 'Cuota mensual menor o igual a 0', familias.filter((f) => f.cuota_mensual_familiar != null && f.cuota_mensual_familiar <= 0).length, 'familias sin alumnos activos o con beca completa');
  nulos(cuotas, ['dias_atraso'], 'cuotas');
  dup(cuotas, 'id_cuota', 'cuotas');
  add('cuotas', 'Atraso negativo', cuotas.filter((c) => c.dias_atraso < 0).length);
  add('cuotas', 'Monto adeudado negativo', cuotas.filter((c) => c.monto_adeudado < 0).length);
  const ids = new Set(familias.map((f) => f.id_familia));
  add('cuotas', 'Cuotas de familias inexistentes', cuotas.filter((c) => !ids.has(c.id_familia)).length);
  add('alumnos', 'Alumnos de familias inexistentes', alumnos.filter((a) => !ids.has(a.id_familia)).length);
  return out;
}

// ---------- Tabla a nivel familia ----------

/** Une las tres tablas por id_familia: agrega alumnos (beca, asistencia) y cuotas (atraso, deuda, moroso). */
function tablaFamilias({ alumnos, familias, cuotas }, cfg = CONFIG) {
  const porFam = (rows) => { const m = new Map(); for (const r of rows) { if (!m.has(r.id_familia)) m.set(r.id_familia, []); m.get(r.id_familia).push(r); } return m; };
  const al = porFam(alumnos), cu = porFam(cuotas);
  const filas = familias.map((f) => {
    const a = al.get(f.id_familia) || [], c = (cu.get(f.id_familia) || []).filter((x) => x.dias_atraso != null && x.dias_atraso >= 0);
    const pcts = a.map((x) => x.asistencia_30d_pct).filter((p) => p != null && p >= 0 && p <= 100);
    return {
      ...f,
      becados: a.filter((x) => x.beca_pct > 0).length,
      beca: a.some((x) => x.beca_pct > 0),
      asistencia_prom: pcts.length ? pcts.reduce((s, p) => s + p, 0) / pcts.length : null,
      n_cuotas: c.length,
      atraso_max: c.length ? Math.max(...c.map((x) => x.dias_atraso)) : null,
      atraso_acum: c.reduce((s, x) => s + x.dias_atraso, 0),
      monto_adeudado: c.reduce((s, x) => s + (x.monto_adeudado || 0), 0),
      moroso: c.some((x) => x.dias_atraso > cfg.UMBRAL_MOROSO_DIAS),
    };
  });
  // Sólo se analizan las familias con al menos una cuota vencida en la ventana y puntaje calculado
  const analizadas = filas.filter((f) => f.n_cuotas > 0 && f.puntaje_riesgo_actual != null);
  const ord = analizadas.map((f) => f.puntaje_riesgo_actual).sort((a, b) => a - b);
  const [p25, p75] = cfg.CORTES_RIESGO.map((q) => cuantil(ord, q));
  const [ca, cb] = cfg.CORTES_ASISTENCIA;
  for (const f of analizadas) {
    const s = f.puntaje_riesgo_actual;
    f.beca_lbl = f.beca ? 'Con beca' : 'Sin beca';
    f.riesgo_cat = p25 === p75 ? (s <= p25 ? 'Bajo' : 'Alto') : s <= p25 ? 'Bajo' : s <= p75 ? 'Medio' : 'Alto';
    f.asistencia_cat = f.asistencia_prom == null ? null : f.asistencia_prom < ca ? `Menos de ${ca}%` : f.asistencia_prom < cb ? `${ca} a ${cb}%` : `${cb}% o más`;
  }
  // Hijos: 1, 2, 3 o más; si un grupo queda con menos de 3 familias se une al anterior
  const grupoHijos = (n, tope) => (n >= tope ? `${tope} o más` : String(n));
  let tope = 3;
  while (tope > 2 && analizadas.filter((f) => f.hijos_por_familia >= tope).length < 3) tope--;
  for (const f of analizadas) f.hijos_grupo = grupoHijos(f.hijos_por_familia, tope);
  return { filas, analizadas, cortes_riesgo: { p25, p75 }, hijos_tope: tope };
}

// ---------- 2. Descriptiva (con la unidad de análisis de cada variable) ----------

function descriptiva({ alumnos, familias, cuotas }, cfg = CONFIG) {
  const v = (rows, k, filtro = () => true) => rows.filter(filtro).map((r) => r[k]).filter((x) => x != null);
  const filas = [
    ['Edad', 'años', 'alumnos', v(alumnos, 'edad')],
    ['Beca (sólo alumnos becados)', '%', 'alumnos', v(alumnos, 'beca_pct', (a) => a.beca_pct > 0)],
    ['Asistencia últimos 30 días', '%', 'alumnos', v(alumnos, 'asistencia_30d_pct')],
    ['Hijos por familia', 'alumnos', 'familias', v(familias, 'hijos_por_familia')],
    ['Cuota mensual familiar', '$', 'familias', v(familias, 'cuota_mensual_familiar', (f) => f.cuota_mensual_familiar > 0)],
    ['Puntaje de riesgo actual', 'puntos', 'familias', v(familias, 'puntaje_riesgo_actual')],
    ['Días de atraso por cuota', 'días', 'cuotas', v(cuotas, 'dias_atraso', (c) => c.dias_atraso >= 0)],
    ['Monto adeudado por cuota', '$', 'cuotas', v(cuotas, 'monto_adeudado')],
  ].map(([variable, unidad, unidad_analisis, valores]) => {
    const d = describir(valores);
    return { variable, unidad, unidad_analisis, ...d, asimetrica: d.asimetria != null && Math.abs(d.asimetria) > 1 };
  });
  const atrasos = v(cuotas, 'dias_atraso', (c) => c.dias_atraso >= 0);
  return {
    variables: filas,
    atraso: {
      n: atrasos.length,
      pct_mayor_0: atrasos.length ? atrasos.filter((x) => x > 0).length / atrasos.length : null,
      pct_mayor_umbral: atrasos.length ? atrasos.filter((x) => x > cfg.UMBRAL_MOROSO_DIAS).length / atrasos.length : null,
    },
  };
}

// ---------- 3. Inferencial (nivel familia) ----------

const ORDEN_RIESGO = ['Bajo', 'Medio', 'Alto'];
const MOROSO = ['Morosa', 'No morosa'];
const lblMoroso = (f) => (f.moroso ? 'Morosa' : 'No morosa');

function inferencial(T, cfg = CONFIG) {
  const F = T.analizadas;
  const aleatorio = I.rng(cfg.SEMILLA);
  const tests = [];
  const ordenAsis = [`Menos de ${cfg.CORTES_ASISTENCIA[0]}%`, `${cfg.CORTES_ASISTENCIA[0]} a ${cfg.CORTES_ASISTENCIA[1]}%`, `${cfg.CORTES_ASISTENCIA[1]}% o más`];

  // Categórica vs. categórica
  // puntaje: true marca los cruces que validan el propio puntaje (no son señales nuevas)
  const cat = (variable, sub, orden) => {
    const r = I.cruceCategorico(sub.map((f) => f[variable.k]), sub.map(lblMoroso), orden, MOROSO, { B: cfg.MONTE_CARLO, rng: aleatorio });
    tests.push({ tipo: 'categorica', variable: variable.label, cruce: `${variable.label} × morosidad`, puntaje: variable.k === 'riesgo_cat', ...r });
  };
  cat({ k: 'riesgo_cat', label: 'Riesgo categorizado (P25/P75)' }, F, ORDEN_RIESGO);
  cat({ k: 'beca_lbl', label: 'Beca' }, F, ['Con beca', 'Sin beca']);
  cat({ k: 'asistencia_cat', label: 'Asistencia categorizada' }, F.filter((f) => f.asistencia_cat), ordenAsis);

  // Numérica vs. numérica (Spearman)
  const corr = (label, k, sub = F) => {
    const s = sub.filter((f) => f[k] != null && f.atraso_max != null);
    const r = I.spearman(s.map((f) => f[k]), s.map((f) => f.atraso_max));
    tests.push({ tipo: 'correlacion', variable: label, puntaje: k === 'puntaje_riesgo_actual', cruce: `${label} vs. atraso máximo`, test: 'Spearman', estadistico: r.rho, estadistico_tipo: 'rho', p: r.p, efecto: r.rho, efecto_tipo: 'rho', n: r.n, error: r.error });
  };
  corr('Puntaje de riesgo', 'puntaje_riesgo_actual');
  corr('Asistencia promedio', 'asistencia_prom');
  corr('Cuota mensual familiar', 'cuota_mensual_familiar');

  // Numérica vs. grupos (atraso máximo por familia)
  const grupos = (label, k, orden) => {
    const presentes = orden.filter((g) => F.some((f) => f[k] === g));
    const valores = presentes.map((g) => F.filter((f) => f[k] === g).map((f) => f.atraso_max));
    const medianas = presentes.map((g, i) => ({ grupo: g, n: valores[i].length, mediana: cuantil([...valores[i]].sort((a, b) => a - b), 0.5) }));
    const r = presentes.length === 2 ? I.mannWhitney(valores[0], valores[1]) : I.kruskal(valores);
    tests.push({ tipo: 'grupos', variable: label, puntaje: k === 'riesgo_cat', cruce: `Atraso máximo según ${label.toLowerCase()}`, test: presentes.length === 2 ? 'Mann-Whitney' : 'Kruskal-Wallis',
      estadistico: presentes.length === 2 ? r.U : r.H, estadistico_tipo: presentes.length === 2 ? 'U' : 'H', gl: r.gl, p: r.p, efecto: r.efecto, efecto_tipo: r.efecto_tipo, n: r.n, error: r.error, grupos: medianas });
  };
  grupos('Beca', 'beca_lbl', ['Con beca', 'Sin beca']);
  const ordenHijos = ['1', '2', `${T.hijos_tope} o más`].filter((x, i, a) => a.indexOf(x) === i);
  grupos('Cantidad de hijos', 'hijos_grupo', ordenHijos);
  grupos('Nivel de riesgo', 'riesgo_cat', ORDEN_RIESGO);

  const aj = I.holm(tests.map((t) => t.p));
  tests.forEach((t, i) => {
    t.p_ajustado = aj[i];
    t.significativo = t.p_ajustado != null && t.p_ajustado < cfg.ALFA;
  });

  // Validación del puntaje de riesgo: ROC contra moroso
  const scores = F.map((f) => f.puntaje_riesgo_actual), y = F.map((f) => f.moroso);
  const valorAuc = I.auc(scores, y);
  const roc = valorAuc == null ? null : {
    auc: valorAuc,
    ic: I.aucBootstrap(scores, y, cfg.BOOTSTRAP, 0.95, I.rng(cfg.SEMILLA + 1)),
    curva: I.curvaRoc(scores, y),
    positivos: y.filter(Boolean).length,
    negativos: y.filter((x) => !x).length,
  };
  return { tests, roc, n_familias: F.length, n_morosas: F.filter((f) => f.moroso).length };
}

// ---------- 4. Pareto (nivel familia) ----------

function pareto(F, valor, cfg = CONFIG, ordenarPor = valor) {
  const items = [...F].sort((a, b) => b[ordenarPor] - a[ordenarPor] || b[valor] - a[valor] || a.id_familia - b.id_familia);
  const total = items.reduce((s, f) => s + f[valor], 0);
  let acum = 0;
  const lista = items.map((f, i) => { acum += f[valor]; return { rank: i + 1, id_familia: f.id_familia, valor: f[valor], pct_acum: total ? acum / total : 0, riesgo_cat: f.riesgo_cat, puntaje: f.puntaje_riesgo_actual }; });
  const k = lista.findIndex((x) => x.pct_acum >= cfg.PARETO_REFERENCIA - 1e-12);
  const n80 = total && k >= 0 ? k + 1 : null;
  return {
    total, n: items.length, lista,
    n_ref: n80, pct_familias_ref: n80 ? n80 / items.length : null, pct_valor_ref: n80 ? lista[n80 - 1].pct_acum : null,
    ceros: items.filter((f) => !f[valor]).length, pct_ceros: items.length ? items.filter((f) => !f[valor]).length / items.length : null,
  };
}

function analisisPareto(T, cfg = CONFIG) {
  const F = T.analizadas;
  const atraso = pareto(F, 'atraso_acum', cfg);
  const deuda = pareto(F, 'monto_adeudado', cfg);
  const porPuntaje = pareto(F, 'atraso_acum', cfg, 'puntaje_riesgo_actual');
  const top = Math.max(1, Math.ceil(F.length * cfg.TOP_PUNTAJE));
  const morosas = F.filter((f) => f.moroso).length;
  const topIds = new Set(porPuntaje.lista.slice(0, top).map((x) => x.id_familia));
  porPuntaje.top = {
    n: top,
    pct_familias: top / F.length,
    pct_atraso: porPuntaje.total ? porPuntaje.lista[top - 1].pct_acum : null,
    morosas_capturadas: F.filter((f) => f.moroso && topIds.has(f.id_familia)).length,
    pct_morosas: morosas ? F.filter((f) => f.moroso && topIds.has(f.id_familia)).length / morosas : null,
  };
  return { atraso, deuda, puntaje: porPuntaje };
}

// ---------- 5. Conclusiones ----------

const fnum = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : v.toLocaleString('es-AR', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
const fpct = (v, d = 1) => (v == null ? '—' : `${fnum(v * 100, d)}%`);
const fp = (nombre, p) => (p == null ? `${nombre} —` : p < 0.001 ? `${nombre} < 0,001` : `${nombre} = ${fnum(p, 3)}`);
const fmoney = (v) => (v == null ? '—' : '$' + Math.round(v).toLocaleString('es-AR'));

function conclusiones({ hoy, desc, T, inf, par, valid, umbrales }, cfg = CONFIG) {
  const L = [];
  const F = T.analizadas;
  const v = (nombre) => desc.variables.find((x) => x.variable === nombre);
  L.push('# Conclusiones del análisis de morosidad', '', `Datos al ${hoy.split('-').reverse().join('/')}. Familia morosa: al menos una cuota con más de ${cfg.UMBRAL_MOROSO_DIAS} días de atraso en los últimos 12 meses. Nivel de significación: ${fnum(cfg.ALFA, 2)} (p ajustado por Holm).`, '');
  const problemas = valid.filter((x) => !x.ok);
  L.push('## Calidad de los datos', '', problemas.length ? problemas.map((x) => `- ${x.tabla}: ${x.chequeo.toLowerCase()} → ${x.n}${x.detalle ? ` (${x.detalle})` : ''}.`).join('\n') : '- Sin nulos, duplicados ni valores fuera de rango.', '');

  L.push('## Hallazgos descriptivos', '');
  const at = v('Días de atraso por cuota'), pu = v('Puntaje de riesgo actual'), cu = v('Cuota mensual familiar'), as = v('Asistencia últimos 30 días');
  L.push(`- Se analizaron ${at.n} cuotas, ${desc.variables.find((x) => x.variable === 'Hijos por familia').n} familias y ${v('Edad').n} alumnos.`);
  L.push(`- El ${fpct(desc.atraso.pct_mayor_0)} de las cuotas se pagó (o sigue impaga) con algún día de atraso y el ${fpct(desc.atraso.pct_mayor_umbral)} superó los ${cfg.UMBRAL_MOROSO_DIAS} días. Mediana del atraso: ${fnum(at.mediana)} días; P75: ${fnum(at.p75)}; máximo: ${fnum(at.max, 0)}.`);
  if (pu.n) L.push(`- Puntaje de riesgo: mediana ${fnum(pu.mediana)}, P25 ${fnum(pu.p25)}, P75 ${fnum(pu.p75)} (media ${fnum(pu.media)}).`);
  if (cu.n) L.push(`- Cuota mensual familiar: mediana ${fmoney(cu.mediana)}, entre ${fmoney(cu.min)} y ${fmoney(cu.max)}.`);
  if (as.n) L.push(`- Asistencia de los alumnos en 30 días: mediana ${fnum(as.mediana)}%, P25 ${fnum(as.p25)}%.`);
  const asim = desc.variables.filter((x) => x.asimetrica);
  if (asim.length) L.push(`- Variables con asimetría marcada (|asimetría| > 1), donde conviene informar mediana y percentiles en lugar de la media: ${asim.map((x) => `${x.variable.toLowerCase()} (${fnum(x.asimetria, 2)})`).join(', ')}.`);
  L.push(`- ${inf.n_morosas} de ${inf.n_familias} familias (${fpct(inf.n_morosas / inf.n_familias)}) quedaron clasificadas como morosas.`, '');

  L.push('## Asociaciones (nivel familia)', '');
  const sig = inf.tests.filter((t) => t.significativo), noSig = inf.tests.filter((t) => !t.significativo && t.p != null), sinTest = inf.tests.filter((t) => t.p == null);
  const desc1 = (t) => `${t.cruce} — ${t.test}, ${fp("p", t.p)}, ${fp("p ajustado", t.p_ajustado)}, ${t.efecto_tipo} = ${fnum(t.efecto, 2)}, n = ${t.n}`;
  L.push('**Con asociación significativa después de ajustar por comparaciones múltiples:**', '', sig.length ? sig.map((t) => `- ${desc1(t)}.`).join('\n') : '- Ninguna.', '');
  L.push('**Sin asociación significativa:**', '', noSig.length ? noSig.map((t) => `- ${desc1(t)}.`).join('\n') : '- Ninguna.', '');
  if (sinTest.length) L.push('**No se pudieron correr:**', '', sinTest.map((t) => `- ${t.cruce}: ${t.error}.`).join('\n'), '');
  L.push('> Asociación no implica causalidad. Con este tamaño de muestra los resultados son exploratorios: sirven para orientar, no para confirmar.', '');

  L.push('## Capacidad discriminante del puntaje de riesgo', '');
  if (inf.roc) {
    const a = inf.roc.auc;
    const lectura = a >= 0.9 ? 'excelente' : a >= 0.8 ? 'buena' : a >= 0.7 ? 'aceptable' : a >= 0.6 ? 'pobre' : 'casi nula';
    L.push(`- AUC = ${fnum(a, 3)} (IC 95% bootstrap: ${fnum(inf.roc.ic.li, 3)} a ${fnum(inf.roc.ic.ls, 3)}; ${inf.roc.ic.B} réplicas), con ${inf.roc.positivos} familias morosas y ${inf.roc.negativos} no morosas: discriminación ${lectura}.`);
    L.push('- Advertencia: el puntaje actual incorpora el historial de pagos y la deuda vencida, que son parte de lo que define a una familia como morosa. Este AUC es optimista; la validación honesta es la del backtest del Motor predictivo, con el puntaje calculado antes de cada vencimiento.', '');
  } else L.push('- No se pudo calcular: hace falta al menos una familia morosa y una no morosa.', '');

  L.push('## Concentración (Pareto)', '');
  const linea = (p, que) => (p.n_ref ? `- ${p.n_ref} familia${p.n_ref === 1 ? '' : 's'} (${fpct(p.pct_familias_ref)} del total) explica${p.n_ref === 1 ? '' : 'n'} el ${fpct(p.pct_valor_ref)} ${que}. ${p.ceros} familias (${fpct(p.pct_ceros)}) tienen valor cero.` : `- No hay ${que.replace('de la ', '').replace('del ', '')} para analizar.`);
  L.push(linea(par.atraso, 'de los días de atraso acumulados'));
  L.push(linea(par.deuda, 'de la deuda vencida'));
  const t = par.puntaje.top;
  L.push(`- El ${fpct(t.pct_familias, 0)} de familias con mayor puntaje (${t.n}) concentra el ${fpct(t.pct_atraso)} de los días de atraso y ${t.morosas_capturadas} de las ${inf.n_morosas} familias morosas (${fpct(t.pct_morosas)}).`, '');

  L.push('## Implicancias para el diseño del sistema', '');
  if (par.atraso.n_ref) L.push(`- **Focalización:** la gestión intensiva puede concentrarse en ${par.atraso.n_ref} familias; el resto se atiende con recordatorios automáticos.`);
  L.push(`- **Cortes del semáforo:** en la distribución real, P25 = ${fnum(T.cortes_riesgo.p25)} y P75 = ${fnum(T.cortes_riesgo.p75)} puntos${umbrales ? `; hoy el sistema usa medio desde ${umbrales.medio} y alto desde ${umbrales.alto}` : ''}. Conviene revisar los cortes para que "alto" agrupe a la cola real de riesgo, y recalibrarlos cada ciclo.`);
  const delPuntaje = sig.filter((x) => x.puntaje), externas = [...new Set(sig.filter((x) => !x.puntaje).map((x) => x.variable.toLowerCase()))];
  if (delPuntaje.length) L.push(`- **Puntaje como alerta:** el puntaje ordena a las familias según su atraso (${delPuntaje.length} de ${inf.tests.filter((x) => x.puntaje).length} cruces significativos); sigue siendo la señal principal, con la salvedad de circularidad indicada arriba.`);
  L.push(`- **Otras señales de alerta temprana:** ${externas.length ? `con respaldo en estos datos: ${externas.join(', ')}.` : 'ninguna variable fuera del puntaje (beca, asistencia, cuota, cantidad de hijos) pasó el ajuste por comparaciones múltiples; no conviene sumarlas como alerta hasta tener más datos.'}`);
  if (sig.some((x) => /asistencia/i.test(x.variable))) L.push('- La asistencia no se usa en el puntaje de cobranza por principio; si se asocia con la morosidad, es una señal para que la dirección acompañe a la familia, nunca para cobrar.');
  L.push('');

  L.push('## Limitaciones', '');
  const becadas = F.filter((f) => f.beca).length;
  L.push(`- Muestra chica: ${F.length} familias analizadas (${inf.n_morosas} morosas) y ${becadas} familias con algún hijo becado; los tests tienen poca potencia para detectar efectos moderados.`);
  if (T.filas.length > F.length) L.push(`- ${T.filas.length - F.length} familias activas sin cuotas vencidas en la ventana quedaron fuera de los análisis a nivel familia.`);
  L.push('- Foto estática: se cruzan variables actuales con el atraso de los últimos 12 meses; no hay dimensión temporal ni se controla por otras variables.');
  L.push('- La deuda refinanciada en planes de pago no se cuenta en el monto adeudado por cuota.');
  return L.join('\n') + '\n';
}

/** Análisis completo, listo para la pantalla y la exportación. */
function analisisMorosidad(db, cfg = CONFIG) {
  const ds = dataset(db);
  const valid = validar(ds);
  const desc = descriptiva(ds, cfg);
  const T = tablaFamilias(ds, cfg);
  const inf = inferencial(T, cfg);
  const par = analisisPareto(T, cfg);
  const md = conclusiones({ hoy: ds.hoy, desc, T, inf, par, valid, umbrales: ds.L.umbrales }, cfg);
  const nombres = new Map([...ds.L.byFam.values()].map((f) => [f.familia.id, { apellido: f.familia.apellido, nivel: f.riesgo.nivel }]));
  const conNombre = (p) => ({ ...p, lista: p.lista.map((x) => ({ ...x, ...nombres.get(x.id_familia) })) });
  return {
    hoy: ds.hoy, config: cfg, umbrales: ds.L.umbrales,
    n: { alumnos: ds.alumnos.length, familias: ds.familias.length, cuotas: ds.cuotas.length, analizadas: T.analizadas.length, morosas: inf.n_morosas, becadas: T.analizadas.filter((f) => f.beca).length },
    validacion: valid, descriptiva: desc, cortes_riesgo: T.cortes_riesgo,
    inferencial: inf.tests, roc: inf.roc,
    pareto: { atraso: conNombre(par.atraso), deuda: conNombre(par.deuda), puntaje: conNombre(par.puntaje) },
    conclusiones: md,
  };
}

/** Dataset para exportar (lo consume el script de Python). */
function exportarDataset(db) {
  const { hoy, alumnos, familias, cuotas } = dataset(db);
  return { hoy, alumnos, familias, cuotas };
}

module.exports = { CONFIG, dataset, validar, tablaFamilias, descriptiva, inferencial, analisisPareto, pareto, conclusiones, analisisMorosidad, exportarDataset };
