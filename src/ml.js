'use strict';
// Inteligencia de cobranza: los aportes del machine learning de la presentación.
//
//  · Modelo de riesgo: regresión logística entrenada con el historial de la escuela. Se compara
//    contra el motor por reglas con un backtest temporal (se entrena con lo viejo y se mide con
//    los últimos 6 meses, usando en cada caso sólo los datos disponibles 10 días antes del vencimiento).
//  · Modelo de recupero: probabilidad de cobrar en los próximos 30 días una deuda ya vencida.
//  · Segmentación, priorización, proyección de caja, anomalías, riesgo de baja y datos base del
//    simulador de escenarios.
// Todo se calcula con los datos del propio sistema; nada sale del servidor.
const { addDays, diffDays } = require('./db');
const { loadLedger } = require('./domain');
const { scoreFamily, cuotaAt, ATRASO_RELEVANTE } = require('./risk');
const { montoFamilia } = require('./services');
const { resumenAsistencia } = require('./escolar');

const BASE = (c) => c.tipo === 'arancel' || c.tipo === 'plan';
const ESTACIONALES = [3, 7, 12];
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// ---- Variables del modelo (todas de pago, contacto y matrícula; ninguna sensible) ----
const FEATURES = [
  ['atraso_prom', 'Días de atraso promedio en las últimas 6 cuotas'],
  ['share_tarde', 'Cuotas pagadas con más de 10 días de atraso'],
  ['deuda_abierta', 'Cuotas vencidas impagas'],
  ['max_abierto', 'Antigüedad de la deuda más vieja'],
  ['tendencia', 'Empeoramiento reciente del atraso'],
  ['rechazos', 'Débitos automáticos rechazados'],
  ['sin_abrir', 'Avisos sin abrir ni responder'],
  ['consultas', 'Consultas de saldo sin pago posterior'],
  ['estacional', 'Vencimiento en mes de alto gasto (marzo, julio, diciembre)'],
  ['hijos', 'Cantidad de hijos en la escuela'],
  ['cargos_extra', 'Cuotas extra pendientes (viajes, materiales)'],
  ['debito', 'Adhesión al débito automático'],
  ['historia', 'Antigüedad en la escuela'],
];
const KEYS = FEATURES.map((f) => f[0]);
const CORTO = {
  atraso_prom: 'atrasos largos', share_tarde: 'atrasos frecuentes', deuda_abierta: 'cuotas impagas', max_abierto: 'deuda antigua',
  tendencia: 'empeoró hace poco', rechazos: 'débitos rechazados', sin_abrir: 'no abre los avisos', consultas: 'consulta y no paga',
  estacional: 'mes de alto gasto', hijos: 'varios hijos', cargos_extra: 'cuotas extra', debito: 'débito automático', historia: 'antigüedad',
};
const LABEL = Object.fromEntries(FEATURES);

function features(fam, asOf, targetVenc) {
  const prev = fam.cuotas.filter((c) => BASE(c) && c.vencimiento < asOf).sort((a, b) => b.vencimiento.localeCompare(a.vencimiento));
  const st = prev.map((c) => ({ c, s: cuotaAt(c, asOf) }));
  const at = (arr) => mean(arr.map((x) => Math.min(60, x.s.atraso)));
  const last6 = st.slice(0, 6), last3 = st.slice(0, 3), prev3 = st.slice(3, 6);
  const abiertas = st.filter((x) => !x.s.cerrada);
  const d180 = addDays(asOf, -180), d90 = addDays(asOf, -90), d60 = addDays(asOf, -60);
  const pagos = fam.cuotas.flatMap((c) => c.pagos);
  const rech = pagos.filter((p) => p.rechazado && p.fecha > d180 && p.fecha <= asOf).length;
  const avisos = fam.comunicaciones.filter((m) => m.estado === 'enviada' && (m.canal === 'mail' || m.canal === 'whatsapp') && m.fecha > d90 && m.fecha <= asOf);
  const fechasPago = pagos.filter((p) => !p.rechazado).map((p) => p.fecha);
  const consultas = fam.eventos.filter((e) => e.tipo === 'consulta_saldo' && e.fecha > d60 && e.fecha <= asOf)
    .filter((e) => !fechasPago.some((f) => f >= e.fecha && diffDays(f, e.fecha) <= 5)).length;
  const hijos = fam.alumnos.filter((a) => (a.fecha_ingreso || '') <= asOf && (a.estado === 'activo' || (a.fecha_baja || '9999') > asOf)).length || 1;
  const extra = fam.cuotas.some((c) => c.tipo === 'cargo' && c.vencimiento <= addDays(asOf, 30) && !cuotaAt(c, asOf).cerrada);
  return {
    atraso_prom: at(last6) / 30,
    share_tarde: last6.length ? last6.filter((x) => x.s.atraso > ATRASO_RELEVANTE).length / last6.length : 0,
    deuda_abierta: Math.min(4, abiertas.length) / 4,
    max_abierto: Math.min(90, Math.max(0, ...abiertas.map((x) => x.s.atraso))) / 90,
    tendencia: prev3.length ? (at(last3) - at(prev3)) / 30 : 0,
    rechazos: Math.min(3, rech) / 3,
    sin_abrir: avisos.length ? avisos.filter((m) => !m.abierto && !m.respondido).length / avisos.length : 0,
    consultas: Math.min(3, consultas) / 3,
    estacional: ESTACIONALES.includes(Number(String(targetVenc).slice(5, 7))) ? 1 : 0,
    hijos: Math.min(3, hijos) / 3,
    cargos_extra: extra ? 1 : 0,
    debito: fam.familia.medio_pago === 'debito' ? 1 : 0,
    historia: Math.min(12, prev.length) / 12,
  };
}
const vec = (f) => KEYS.map((k) => f[k]);

// ---- Regresión logística (descenso por gradiente con regularización L2) ----
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function entrenar(X, y, { iter = 800, lr = 0.5, l2 = 0.02 } = {}) {
  const n = X.length, d = X[0].length;
  const mu = Array(d).fill(0), sd = Array(d).fill(0);
  for (const r of X) r.forEach((v, j) => { mu[j] += v / n; });
  for (const r of X) r.forEach((v, j) => { sd[j] += (v - mu[j]) ** 2 / n; });
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  const base = Math.min(0.99, Math.max(0.01, mean(y)));
  const w = Array(d).fill(0);
  let b = Math.log(base / (1 - base));
  for (let it = 0; it < iter; it++) {
    const gw = Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(b + Z[i].reduce((a, v, j) => a + v * w[j], 0));
      const e = p - y[i];
      gb += e;
      for (let j = 0; j < d; j++) gw[j] += e * Z[i][j];
    }
    b -= (lr * gb) / n;
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  return { w, b, mu, sd, n, tasa_base: base };
}
const predecir = (m, x) => sigmoid(m.b + x.reduce((a, v, j) => a + ((v - m.mu[j]) / m.sd[j]) * m.w[j], 0));
const contribuciones = (m, x) => x.map((v, j) => ({ key: KEYS[j], valor: ((v - m.mu[j]) / m.sd[j]) * m.w[j] }));

/** Área bajo la curva ROC: probabilidad de que un caso positivo tenga más puntaje que uno negativo. */
function auc(scores, labels) {
  const pares = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  let rank = 0, sumPos = 0, pos = 0;
  for (let i = 0; i < pares.length;) {
    let j = i;
    while (j < pares.length && pares[j][0] === pares[i][0]) j++;
    const r = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (pares[k][1]) { sumPos += r; pos++; }
    rank = j; i = j;
  }
  const neg = pares.length - pos;
  return pos && neg ? (sumPos - (pos * (pos + 1)) / 2) / (pos * neg) : null;
}

function pagadoAl(c, fecha) {
  return c.pagos.filter((p) => !p.rechazado && p.fecha <= fecha).reduce((a, p) => a + p.monto, 0) >= c.monto - 0.5;
}

// ---- Entrenamiento con el historial ----
function datasetRiesgo(L) {
  const limite = addDays(L.hoy, -(ATRASO_RELEVANTE + 1));
  const filas = [];
  for (const fam of L.byFam.values()) {
    for (const c of fam.cuotas) {
      if (c.tipo !== 'arancel' || c.vencimiento > limite) continue;
      const asOf = addDays(c.vencimiento, -ATRASO_RELEVANTE);
      if (fam.cuotas.filter((x) => BASE(x) && x.vencimiento < asOf).length < 2) continue;
      const s = cuotaAt(c, addDays(c.vencimiento, ATRASO_RELEVANTE + 1));
      filas.push({
        venc: c.vencimiento,
        x: vec(features(fam, asOf, c.vencimiento)),
        y: !s.cerrada || s.atraso > ATRASO_RELEVANTE ? 1 : 0,
        reglas: scoreFamily(fam, asOf, c.vencimiento, L.umbrales),
      });
    }
  }
  return filas;
}

function datasetRecupero(L) {
  const filas = [];
  for (const fam of L.byFam.values()) {
    for (const c of fam.cuotas) {
      if (!BASE(c) || c.vencimiento > addDays(L.hoy, -36)) continue;
      const dia5 = addDays(c.vencimiento, 5);
      if (pagadoAl(c, dia5) || (c.refinanciada_fecha && c.refinanciada_fecha <= dia5)) continue;
      filas.push({ x: vec(features(fam, dia5, c.vencimiento)), y: pagadoAl(c, addDays(c.vencimiento, 35)) ? 1 : 0 });
    }
  }
  return filas;
}

function evaluar(L, filas) {
  const corte = addDays(L.hoy, -(ATRASO_RELEVANTE + 1) - 183);
  const train = filas.filter((f) => f.venc < corte), test = filas.filter((f) => f.venc >= corte);
  if (train.length < 50 || test.length < 20 || !train.some((f) => f.y) || !test.some((f) => f.y)) return null;
  const m = entrenar(train.map((f) => f.x), train.map((f) => f.y));
  const pML = test.map((f) => predecir(m, f.x));
  const yT = test.map((f) => f.y);
  // Mismo número de alertas que las reglas (nivel alto), para comparar precisión de igual a igual
  const k = test.filter((f) => f.reglas.nivel === 'alto').length || Math.round(test.length * 0.1);
  const precision = (orden) => orden.slice(0, k).filter((i) => yT[i]).length / k;
  const idx = test.map((_, i) => i);
  const topML = [...idx].sort((a, b) => pML[b] - pML[a]);
  const topR = [...idx].sort((a, b) => test[b].reglas.puntaje - test[a].reglas.puntaje);
  const atrasos = yT.filter(Boolean).length;
  return {
    entrenamiento: train.length, prueba: test.length, atrasos, alertas: k,
    ml: { auc: auc(pML, yT), precision: precision(topML), cobertura: topML.slice(0, k).filter((i) => yT[i]).length / atrasos },
    reglas: { auc: auc(test.map((f) => f.reglas.puntaje), yT), precision: precision(topR), cobertura: topR.slice(0, k).filter((i) => yT[i]).length / atrasos },
  };
}

// ---- Segmentación por comportamiento ----
const SEGMENTOS = {
  puntual: { label: 'Pagador puntual', estrategia: 'Recordatorio simple por mail 3 días antes; sin insistir.' },
  tardio: { label: 'Tardío recurrente', estrategia: 'Aviso anticipado por WhatsApp 7 días antes y propuesta de débito automático.' },
  transitoria: { label: 'Dificultad transitoria', estrategia: 'Llamado de administración y plan de pagos temprano, antes de que se acumule deuda.' },
  cronico: { label: 'Riesgo de deuda crónica', estrategia: 'Gestión personal y reunión con dirección; plan de pagos con seguimiento.' },
};

function segmento(fam, hoy) {
  const base = fam.cuotas.filter((c) => BASE(c) && c.vencimiento < hoy && c.vencimiento >= addDays(hoy, -365))
    .sort((a, b) => b.vencimiento.localeCompare(a.vencimiento));
  if (base.length < 3) return { key: 'puntual', motivo: 'Poca historia: se trata como puntual hasta tener más datos', estacional: false, poca_historia: true };
  const at = base.map((c) => (c.estado === 'refinanciada' ? Math.max(31, c.atraso) : c.atraso));
  const abiertas = base.filter((c) => c.estado === 'vencida').length;
  const avg6 = mean(at.slice(0, 6)), recent = mean(at.slice(0, 3)), older = mean(at.slice(3, 12));
  const tardes = base.filter((_, i) => at[i] > 3);
  const shareTarde = tardes.length / base.length;
  const estacional = tardes.length >= 2 && tardes.filter((c) => ESTACIONALES.includes(Number(c.vencimiento.slice(5, 7)))).length / tardes.length >= 0.75;
  const r1 = (n) => Math.round(n);
  if (abiertas >= 3 || avg6 > 30 || Math.max(...at.slice(0, 6)) > 60) {
    return { key: 'cronico', motivo: abiertas >= 3 ? `${abiertas} cuotas vencidas impagas` : `Atraso promedio de ${r1(avg6)} días en las últimas 6 cuotas`, estacional: false };
  }
  if (base.length >= 6 && older <= 5 && (recent > 10 || abiertas > 0)) {
    return { key: 'transitoria', motivo: `Pagaba con ${r1(older)} días de atraso promedio y en los últimos meses pasó a ${r1(recent)}`, estacional: false };
  }
  if (shareTarde >= 0.3) {
    return { key: 'tardio', motivo: estacional ? 'Se atrasa sobre todo en marzo, julio y diciembre' : `${Math.round(shareTarde * 100)}% de las cuotas pagadas con atraso`, estacional };
  }
  return { key: 'puntual', motivo: 'Paga en término o con atrasos mínimos', estacional: false };
}

// ---- Cálculo principal, con memoria mientras los datos no cambien ----
let memo = { firma: null, valor: null };

function firma(db, hoy) {
  const q = (t) => db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m FROM ${t}`).get();
  return [hoy, ...['cuotas', 'pagos', 'cobros', 'comunicaciones', 'eventos', 'alumnos', 'promesas', 'familias'].map((t) => { const r = q(t); return `${r.n}:${r.m}`; })].join('|')
    + '|' + db.prepare("SELECT GROUP_CONCAT(value) AS v FROM settings").get().v
    + '|' + db.prepare("SELECT COALESCE(SUM(monto), 0) AS s FROM cuotas").get().s;
}

function analizar(db) {
  const L = loadLedger(db);
  const f = firma(db, L.hoy);
  if (memo.firma === f) return memo.valor;

  const filas = datasetRiesgo(L);
  const evaluacion = evaluar(L, filas);
  const modelo = entrenar(filas.map((r) => r.x), filas.map((r) => r.y));
  const rec = datasetRecupero(L);
  const modeloRec = rec.length >= 30 && rec.some((r) => r.y) && rec.some((r) => !r.y) ? entrenar(rec.map((r) => r.x), rec.map((r) => r.y)) : null;

  const familias = new Map();
  for (const fam of L.byFam.values()) {
    if (!fam.familia.activa) continue;
    const prox = fam.proxima?.vencimiento || addDays(L.hoy, 30);
    const x = vec(features(fam, L.hoy, prox));
    const p = predecir(modelo, x);
    const motivos = contribuciones(modelo, x).filter((c) => c.valor > 0.15).sort((a, b) => b.valor - a.valor).slice(0, 3).map((c) => CORTO[c.key]);
    const hace90 = addDays(L.hoy, -90);
    const p90 = predecir(modelo, vec(features(fam, hace90, addDays(hace90, 30))));
    const pRec = fam.deuda_vencida > 0 && modeloRec ? predecir(modeloRec, vec(features(fam, L.hoy, L.hoy))) : null;
    familias.set(fam.familia.id, { fam, prob: p, prob_90: p90, motivos, recupero: pRec, segmento: segmento(fam, L.hoy) });
  }
  const valor = { L, modelo, modeloRec, evaluacion, familias, observaciones: filas.length, episodios: rec.length };
  memo = { firma: f, valor };
  return valor;
}

const resumen = (fam) => ({ id: fam.familia.id, apellido: fam.familia.apellido, responsable: fam.familia.responsable, telefono: fam.familia.telefono, medio_pago: fam.familia.medio_pago });

// ---- Aporte 1 · Modelo de riesgo ----
function infoModelo(A) {
  const lista = [...A.familias.values()];
  return {
    observaciones: A.observaciones,
    tasa_base: A.modelo.tasa_base,
    evaluacion: A.evaluacion,
    pesos: KEYS.map((k, j) => ({ key: k, label: LABEL[k], peso: A.modelo.w[j] })).sort((a, b) => Math.abs(b.peso) - Math.abs(a.peso)),
    distribucion: [0, 0.1, 0.2, 0.3, 0.5, 0.7].map((d, i, arr) => ({
      desde: d, hasta: arr[i + 1] ?? 1.01,
      familias: lista.filter((x) => x.prob >= d && x.prob < (arr[i + 1] ?? 1.01)).length,
    })),
    familias: lista.map((x) => ({ ...resumen(x.fam), prob: x.prob, motivos: x.motivos, reglas: x.fam.riesgo.puntaje, nivel: x.fam.riesgo.nivel, segmento: x.segmento.key }))
      .sort((a, b) => b.prob - a.prob),
  };
}

// ---- Aporte 2 · Segmentación ----
function infoSegmentos(A) {
  const lista = [...A.familias.values()];
  return Object.entries(SEGMENTOS).map(([key, s]) => {
    const del = lista.filter((x) => x.segmento.key === key);
    return {
      key, ...s,
      familias: del.length,
      deuda: del.reduce((a, x) => a + x.fam.deuda_vencida, 0),
      prob_media: del.length ? mean(del.map((x) => x.prob)) : null,
      estacionales: del.filter((x) => x.segmento.estacional).length,
      lista: del.map((x) => ({ ...resumen(x.fam), motivo: x.segmento.motivo, estacional: x.segmento.estacional, prob: x.prob, deuda: x.fam.deuda_vencida }))
        .sort((a, b) => b.prob - a.prob),
    };
  });
}

// ---- Aporte 4 · Priorización por recupero esperado ----
function priorizacion(A, n = 20) {
  const base = (x) => ({ ...resumen(x.fam), segmento: x.segmento.key, estrategia: SEGMENTOS[x.segmento.key].estrategia, plan_activo: x.fam.planes.some((p) => p.estado === 'activo') });
  const activas = [...A.familias.values()].filter((x) => !x.fam.promesa);
  // Cobrar: deuda vencida × probabilidad de recuperarla en 30 días
  const cobrar = activas.filter((x) => x.fam.deuda_vencida > 0).map((x) => ({
    ...base(x), gestion: 'cobrar', monto: x.fam.deuda_vencida, max_atraso: x.fam.max_atraso,
    prob: x.recupero ?? 0.5, esperado: x.fam.deuda_vencida * (x.recupero ?? 0.5),
  }));
  // Prevenir: familias al día con alta probabilidad de atrasar la próxima cuota (monto que se protege)
  const prevenir = activas.filter((x) => !x.fam.deuda_vencida && x.fam.proxima && x.prob >= 0.1).map((x) => ({
    ...base(x), gestion: 'prevenir', monto: x.fam.proxima.saldo, vence: x.fam.proxima.vencimiento,
    prob: x.prob, esperado: x.fam.proxima.saldo * x.prob,
  }));
  const filas = [...cobrar, ...prevenir].sort((a, b) => b.esperado - a.esperado);
  return { total: filas.length, cobrar: cobrar.length, prevenir: prevenir.length, lista: filas.slice(0, n), en_pausa: [...A.familias.values()].filter((x) => x.fam.promesa).length };
}

// ---- Aporte 5 · Proyección de flujo de caja ----
const mesDe = (iso) => iso.slice(0, 7);
function sumarMeses(p, k) {
  const [y, m] = p.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + k, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Cómo se cobró históricamente cada segmento: en el mes del vencimiento, al mes siguiente, o más tarde / nunca. */
function patronesDeCobro(A) {
  const L = A.L;
  const desde = addDays(L.hoy, -365), hasta = addDays(L.hoy, -62);
  const acum = {};
  const add = (k, campo, v) => { acum[k] = acum[k] || { mes: 0, siguiente: 0, tarde: 0 }; acum[k][campo] += v; };
  for (const x of A.familias.values()) {
    for (const c of x.fam.cuotas) {
      if (c.tipo !== 'arancel' || c.vencimiento < desde || c.vencimiento > hasta) continue;
      const fp = c.estado === 'pagada' ? c.fecha_pago : null;
      const campo = fp && mesDe(fp) <= mesDe(c.vencimiento) ? 'mes' : fp && mesDe(fp) === sumarMeses(mesDe(c.vencimiento), 1) ? 'siguiente' : 'tarde';
      add(x.segmento.key, campo, c.monto);
      add('todas', campo, c.monto);
    }
  }
  const norm = (o) => { const t = o.mes + o.siguiente + o.tarde; return t ? { mes: o.mes / t, siguiente: o.siguiente / t, tarde: o.tarde / t, n: t } : null; };
  const out = {};
  for (const k of [...Object.keys(SEGMENTOS), 'todas']) out[k] = acum[k] && acum[k].mes + acum[k].siguiente + acum[k].tarde > 0 ? norm(acum[k]) : null;
  for (const k of Object.keys(SEGMENTOS)) if (!out[k]) out[k] = out.todas;
  return out;
}

function flujoDeCaja(A) {
  const L = A.L;
  const patrones = patronesDeCobro(A);
  const m0 = mesDe(L.hoy);
  const meses = [0, 1, 2].map((k) => sumarMeses(m0, k));
  const generados = new Set(L.cuotas.filter((c) => c.tipo === 'arancel').map((c) => c.periodo));
  const proyectados = [];
  const filas = meses.map((m) => ({ mes: m, facturado: 0, ya_cobrado: 0, del_mes: 0, arrastre: 0, recupero: 0, proyectado: false }));
  const idx = Object.fromEntries(meses.map((m, i) => [m, i]));

  for (const x of A.familias.values()) {
    const pat = patrones[x.segmento.key];
    const pendientes = meses.map(() => 0);
    for (const c of x.fam.cuotas) {
      const i = idx[mesDe(c.vencimiento)];
      if (i === undefined || c.estado === 'refinanciada') continue;
      filas[i].facturado += c.monto;
      if (c.estado === 'pendiente' || (c.estado === 'vencida' && i === 0)) pendientes[i] += c.saldo;
    }
    // Aranceles todavía no generados (marzo a diciembre): se proyectan con el arancel vigente
    meses.forEach((m, i) => {
      const mes = Number(m.slice(5, 7));
      if (generados.has(m) || mes < 3) return;
      const monto = montoFamilia(x.fam.alumnos, L.settings);
      filas[i].facturado += monto;
      filas[i].proyectado = true;
      pendientes[i] += monto;
    });
    meses.forEach((_, i) => {
      filas[i].del_mes += pendientes[i] * pat.mes;
      if (i > 0) filas[i].arrastre += pendientes[i - 1] * pat.siguiente;
    });
    // Deuda vencida de meses anteriores: se recupera con la probabilidad del modelo de recupero
    const deudaVieja = x.fam.cuotas.filter((c) => c.estado === 'vencida' && mesDe(c.vencimiento) < m0).reduce((a, c) => a + c.saldo, 0);
    if (deudaVieja > 0) {
      const p = x.recupero ?? 0.3;
      filas[0].recupero += deudaVieja * p;
      filas[1].recupero += deudaVieja * (1 - p) * p * 0.7;
      filas[2].recupero += deudaVieja * (1 - p) * (1 - p * 0.7) * p * 0.5;
    }
  }
  filas[0].ya_cobrado = L.cobros.filter((c) => c.estado === 'vigente' && c.tipo === 'recibo' && mesDe(c.fecha) === m0).reduce((a, c) => a + c.monto, 0);
  for (const f of filas) f.esperado = f.ya_cobrado + f.del_mes + f.arrastre + f.recupero;

  const historico = [-6, -5, -4, -3, -2, -1].map((k) => {
    const m = sumarMeses(m0, k);
    return {
      mes: m,
      facturado: L.cuotas.filter((c) => mesDe(c.vencimiento) === m && c.tipo !== 'recargo').reduce((a, c) => a + c.monto, 0),
      cobrado: L.cobros.filter((c) => c.estado === 'vigente' && c.tipo === 'recibo' && mesDe(c.fecha) === m).reduce((a, c) => a + c.monto, 0),
    };
  });
  return { hoy: L.hoy, historico, proyeccion: filas, patrones };
}

// ---- Aporte 6 · Anomalías ----
function anomalias(A) {
  const L = A.L;
  const out = [];
  const desdeV = addDays(L.hoy, -20), hastaV = addDays(L.hoy, 45);
  for (const x of A.familias.values()) {
    const fam = x.fam;
    // Comportamiento: buen historial y, de repente, atraso
    const base = fam.cuotas.filter((c) => BASE(c) && c.vencimiento < L.hoy && c.estado !== 'refinanciada').sort((a, b) => b.vencimiento.localeCompare(a.vencimiento));
    if (base.length >= 7) {
      const [ult, ...prev] = base;
      const previas = prev.slice(0, 6);
      if (previas.every((c) => c.atraso <= 2) && ult.atraso > 3) {
        out.push({
          tipo: 'comportamiento', gravedad: 'media', ...resumen(fam),
          titulo: 'Cambio brusco de comportamiento',
          detalle: `Pagó en término sus últimas ${previas.length} cuotas y ${ult.concepto.toLowerCase()} ${ult.estado === 'vencida' ? `lleva ${ult.atraso} días impaga` : `se pagó con ${ult.atraso} días de atraso`}.`,
          sugerencia: 'Contacto suave de administración para saber si necesita algo; sin aviso automático de deuda.',
        });
      }
    }
    if (!out.some((a) => a.id === fam.familia.id) && x.prob - x.prob_90 >= 0.3 && x.prob >= 0.45) {
      out.push({
        tipo: 'comportamiento', gravedad: 'media', ...resumen(fam),
        titulo: 'Subida fuerte del riesgo',
        detalle: `Su probabilidad de atraso pasó de ${Math.round(x.prob_90 * 100)}% a ${Math.round(x.prob * 100)}% en tres meses.`,
        sugerencia: 'Revisar qué cambió y anticipar el contacto antes del próximo vencimiento.',
      });
    }
    // Facturación: importe distinto del esperado según alumnos activos, becas y descuentos
    const esperado = montoFamilia(fam.alumnos, L.settings);
    const c = fam.cuotas.find((q) => q.tipo === 'arancel' && q.vencimiento >= desdeV && q.vencimiento <= hastaV && Math.abs(q.monto - esperado) > Math.max(100, esperado * 0.01));
    if (c) {
      const bajas = fam.alumnos.filter((a) => a.estado !== 'activo' && a.fecha_baja).length;
      out.push({
        tipo: 'facturacion', gravedad: 'alta', ...resumen(fam),
        titulo: esperado === 0 ? 'Cuota emitida sin alumnos activos' : 'Importe distinto del esperado',
        detalle: `${c.concepto}: se emitió por $${Math.round(c.monto).toLocaleString('es-AR')} y según alumnos, becas y descuento por hermano correspondía $${esperado.toLocaleString('es-AR')}.${bajas ? ' La familia tiene alumnos dados de baja.' : ''}`,
        sugerencia: c.saldo > 0 ? 'Corregir con una nota de crédito o un cargo por la diferencia antes de reclamar el pago.' : 'Revisar si corresponde devolver o compensar la diferencia.',
      });
    }
  }
  // Facturación: recibos duplicados (mismo día, importe y medio)
  const vistos = new Map();
  for (const c of L.cobros.filter((q) => q.estado === 'vigente' && q.tipo === 'recibo')) {
    const k = `${c.familia_id}|${c.fecha}|${c.monto}|${c.medio}`;
    if (vistos.has(k)) {
      const fam = L.byFam.get(c.familia_id);
      out.push({
        tipo: 'facturacion', gravedad: 'alta', ...resumen(fam),
        titulo: 'Posible cobro duplicado',
        detalle: `Dos recibos el ${c.fecha.split('-').reverse().join('/')} por $${Math.round(c.monto).toLocaleString('es-AR')} (${vistos.get(k)} y ${c.comprobante}).`,
        sugerencia: 'Confirmar con la familia; si fue un error, anular uno de los recibos o dejarlo como saldo a favor.',
      });
    } else vistos.set(k, c.comprobante);
  }
  const orden = { alta: 0, media: 1 };
  return out.sort((a, b) => orden[a.gravedad] - orden[b.gravedad]);
}

// ---- Aporte 7 · Riesgo de baja ----
function riesgoBaja(A, db) {
  const L = A.L;
  const asis = resumenAsistencia(db, addDays(L.hoy, -30), L.hoy);
  const inicioCiclo = `${L.hoy.slice(0, 4)}-01-01`;
  const out = [];
  for (const x of A.familias.values()) {
    const fam = x.fam;
    const motivos = [];
    let pts = 0;
    const vencidas = fam.cuotas.filter((c) => c.estado === 'vencida' && BASE(c)).length;
    if (vencidas) { const p = vencidas >= 3 ? 35 : vencidas === 2 ? 20 : 10; pts += p; motivos.push(`${vencidas} cuota(s) vencidas`); }
    const activos = fam.alumnos.filter((a) => a.estado === 'activo');
    const pcts = activos.map((a) => asis.get(a.id)?.pct).filter((p) => p != null);
    const minAsis = pcts.length ? Math.min(...pcts) : null;
    if (minAsis != null && minAsis < 0.85) { pts += 20; motivos.push(`Asistencia del ${Math.round(minAsis * 100)}% en 30 días`); } else if (minAsis != null && minAsis < 0.9) { pts += 10; motivos.push(`Asistencia del ${Math.round(minAsis * 100)}% en 30 días`); }
    const reclamos = fam.eventos.filter((e) => e.tipo === 'reclamo' && e.fecha > addDays(L.hoy, -90)).length;
    if (reclamos) { pts += Math.min(30, reclamos * 15); motivos.push(`${reclamos} reclamo(s) en 90 días`); }
    const pase = fam.eventos.find((e) => e.tipo === 'pedido_pase' && e.fecha > addDays(L.hoy, -120));
    if (pase) { pts += 30; motivos.push('Pidió documentación para un pase'); }
    if (fam.alumnos.some((a) => a.estado !== 'activo' && (a.fecha_baja || '') >= inicioCiclo)) { pts += 10; motivos.push('Un hermano se dio de baja este año'); }
    if (fam.promesas.some((p) => p.estado === 'incumplida' && p.fecha_promesa > addDays(L.hoy, -60))) { pts += 5; motivos.push('Promesa de pago incumplida'); }
    if (!pts) continue;
    const nivel = pts >= 50 ? 'alto' : pts >= 25 ? 'medio' : 'bajo';
    if (nivel === 'bajo') continue;
    out.push({
      ...resumen(fam), puntaje: Math.min(100, pts), nivel, motivos,
      alumnos: activos.map((a) => `${a.nombre} (${a.grado}° ${a.seccion})`),
      deuda: fam.deuda_vencida,
      accion: nivel === 'alto' ? 'Reunión con dirección (no sólo administración) para entender la situación y sostener la continuidad.' : 'Seguimiento de la docente y contacto cordial de administración.',
    });
  }
  return out.sort((a, b) => b.puntaje - a.puntaje);
}

// ---- Aporte 8 · Datos base del simulador ----
function baseSimulacion(A, patrones) {
  const L = A.L;
  return Object.entries(SEGMENTOS).map(([key, s]) => {
    const del = [...A.familias.values()].filter((x) => x.segmento.key === key);
    const p = patrones[key] || { mes: 1, siguiente: 0, tarde: 0 };
    return {
      key, label: s.label, familias: del.length,
      mensual: del.reduce((a, x) => a + montoFamilia(x.fam.alumnos, L.settings), 0),
      en_termino: p.mes, siguiente: p.siguiente, tarde: p.tarde,
    };
  });
}

function inteligencia(db) {
  const A = analizar(db);
  const flujo = flujoDeCaja(A);
  return {
    hoy: A.L.hoy,
    modelo: infoModelo(A),
    segmentos: infoSegmentos(A),
    priorizacion: priorizacion(A),
    flujo,
    anomalias: anomalias(A),
    bajas: riesgoBaja(A, db),
    simulacion: { segmentos: baseSimulacion(A, flujo.patrones), meses: 10 },
  };
}

/** Lo que el sistema sabe de una familia, para su ficha y la bandeja. */
function deFamilia(db, id) {
  const A = analizar(db);
  const x = A.familias.get(id);
  if (!x) return null;
  return {
    prob: x.prob, prob_90: x.prob_90, motivos: x.motivos, recupero: x.recupero,
    segmento: { ...x.segmento, ...SEGMENTOS[x.segmento.key] },
  };
}

function segmentosPorFamilia(db) {
  const A = analizar(db);
  return new Map([...A.familias.entries()].map(([id, x]) => [id, { key: x.segmento.key, label: SEGMENTOS[x.segmento.key].label, estrategia: SEGMENTOS[x.segmento.key].estrategia, prob: x.prob }]));
}

module.exports = { inteligencia, deFamilia, segmentosPorFamilia, entrenar, predecir, auc, segmento, features, SEGMENTOS, FEATURES };
