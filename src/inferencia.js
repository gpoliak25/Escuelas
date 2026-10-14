'use strict';
// Estadística inferencial sin dependencias: distribuciones, tests exactos y no paramétricos,
// corrección de Holm y curva ROC. Pensado para muestras chicas (decenas de familias).
// Los resultados coinciden con scipy (chi2_contingency, fisher_exact, spearmanr,
// mannwhitneyu asintótico con corrección de continuidad, kruskal) salvo en los que usan azar.

// ---------- Generador reproducible ----------
/** Generador pseudoaleatorio con semilla (mulberry32): mismo resultado en cada corrida. */
function rng(seed = 20261014) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Funciones especiales ----------
function lgamma(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

/** Gamma incompleta regularizada superior Q(a, x). */
function gammaQ(a, x) {
  if (x <= 0) return 1;
  const gln = lgamma(a);
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 500; n++) { del *= x / ++ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-15) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, hh = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    hh *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - gln) * hh;
}

/** Beta incompleta regularizada I_x(a, b). */
function betaI(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const cf = (a, b, x) => {
    let c = 1, d = 1 - (a + b) * x / (a + 1);
    if (Math.abs(d) < 1e-300) d = 1e-300;
    d = 1 / d;
    let hh = d;
    for (let m = 1; m < 500; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d; hh *= d * c;
      aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
      d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      const del = d * c;
      hh *= del;
      if (Math.abs(del - 1) < 1e-15) break;
    }
    return hh;
  };
  return x < (a + 1) / (a + b + 2) ? bt * cf(a, b, x) / a : 1 - bt * cf(b, a, 1 - x) / b;
}

/** P(X > x) para una chi cuadrado con k grados de libertad. */
const chi2Sf = (x, k) => (x <= 0 ? 1 : gammaQ(k / 2, x / 2));
/** P(Z > z) para la normal estándar. */
const normSf = (z) => (z < 0 ? 1 - normSf(-z) : 0.5 * gammaQ(0.5, (z * z) / 2));
/** P(|T| > |t|) para una t de Student con df grados de libertad. */
const tSf2 = (t, df) => betaI(df / 2, 0.5, df / (df + t * t));

// ---------- Utilidades ----------
const suma = (v) => v.reduce((a, b) => a + b, 0);

/** Rangos promedio (los empates reciben el promedio de sus posiciones). */
function rangos(v) {
  const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

/** Suma de t³ − t sobre los grupos de empates (corrección por empates). */
function empates(v) {
  const c = new Map();
  for (const x of v) c.set(x, (c.get(x) || 0) + 1);
  let s = 0;
  for (const t of c.values()) s += t ** 3 - t;
  return s;
}

// ---------- Correlación ----------
function pearsonR(x, y) {
  const n = x.length, mx = suma(x) / n, my = suma(y) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Correlación de Spearman con p-valor bilateral (aproximación t, igual que scipy). */
function spearman(x, y) {
  const n = x.length;
  if (n < 4) return { n, rho: null, p: null, error: 'Menos de 4 pares' };
  const rho = pearsonR(rangos(x), rangos(y));
  if (rho == null) return { n, rho: null, p: null, error: 'Una de las variables es constante' };
  if (Math.abs(rho) >= 1) return { n, rho, p: 0 };
  const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
  return { n, rho, p: tSf2(t, n - 2) };
}

// ---------- Comparación de grupos ----------
/**
 * Mann-Whitney bilateral, aproximación normal con corrección por empates y de continuidad.
 * Tamaño del efecto: correlación rank-biserial r = 2·U₁/(n₁·n₂) − 1 (positiva si el grupo a tiene valores mayores).
 */
function mannWhitney(a, b) {
  const n1 = a.length, n2 = b.length, n = n1 + n2;
  if (n1 < 2 || n2 < 2) return { n, U: null, p: null, error: 'Algún grupo tiene menos de 2 casos' };
  const r = rangos([...a, ...b]);
  const R1 = suma(r.slice(0, n1));
  const U1 = R1 - (n1 * (n1 + 1)) / 2;
  const mu = (n1 * n2) / 2;
  const sigma = Math.sqrt((n1 * n2 / 12) * ((n + 1) - empates([...a, ...b]) / (n * (n - 1))));
  const U = Math.max(U1, n1 * n2 - U1);
  const p = sigma ? Math.min(1, 2 * normSf((U - mu - 0.5) / sigma)) : 1;
  return { n, U: U1, p, efecto: (2 * U1) / (n1 * n2) - 1, efecto_tipo: 'r rank-biserial' };
}

/** Kruskal-Wallis con corrección por empates. Tamaño del efecto: ε² = H / (n − 1). */
function kruskal(grupos) {
  const g = grupos.filter((x) => x.length);
  const todos = g.flat(), n = todos.length;
  if (g.length < 2 || g.some((x) => x.length < 2)) return { n, H: null, p: null, error: 'Se necesitan 2 o más grupos con 2 casos o más' };
  const r = rangos(todos);
  let pos = 0, H = 0;
  for (const x of g) { const Ri = suma(r.slice(pos, pos + x.length)); H += (Ri * Ri) / x.length; pos += x.length; }
  H = (12 / (n * (n + 1))) * H - 3 * (n + 1);
  const corr = 1 - empates(todos) / (n ** 3 - n);
  if (corr <= 0) return { n, H: null, p: null, error: 'Todos los valores son iguales' };
  H /= corr;
  return { n, H, gl: g.length - 1, p: chi2Sf(H, g.length - 1), efecto: H / (n - 1), efecto_tipo: 'ε²' };
}

// ---------- Tablas de contingencia ----------
/** Tabla de contingencia a partir de dos vectores de categorías. */
function contingencia(filasV, colsV, ordenFilas, ordenCols) {
  const filas = ordenFilas || [...new Set(filasV)];
  const cols = ordenCols || [...new Set(colsV)];
  const t = filas.map(() => cols.map(() => 0));
  filasV.forEach((f, i) => {
    const a = filas.indexOf(f), b = cols.indexOf(colsV[i]);
    if (a >= 0 && b >= 0) t[a][b]++;
  });
  // Se descartan filas o columnas vacías (no aportan y rompen las esperadas)
  const fi = filas.map((_, i) => i).filter((i) => suma(t[i]) > 0);
  const ci = cols.map((_, j) => j).filter((j) => fi.some((i) => t[i][j] > 0));
  return { filas: fi.map((i) => filas[i]), cols: ci.map((j) => cols[j]), tabla: fi.map((i) => ci.map((j) => t[i][j])) };
}

function esperadas(t) {
  const fr = t.map(suma), fc = t[0].map((_, j) => suma(t.map((f) => f[j]))), n = suma(fr);
  return t.map((_, i) => t[0].map((_, j) => (fr[i] * fc[j]) / n));
}

function chi2Estadistico(t, E, yates = false) {
  let x = 0;
  t.forEach((f, i) => f.forEach((o, j) => {
    const d = yates ? Math.max(0, Math.abs(o - E[i][j]) - 0.5) : Math.abs(o - E[i][j]);
    x += (d * d) / E[i][j];
  }));
  return x;
}

/** Chi cuadrado de independencia (con corrección de Yates en 2×2, como scipy). */
function chi2Contingencia(t) {
  const E = esperadas(t);
  const gl = (t.length - 1) * (t[0].length - 1);
  const yates = gl === 1;
  const chi2 = chi2Estadistico(t, E, yates);
  return { chi2, gl, p: chi2Sf(chi2, gl), yates, esperadas: E, min_esperada: Math.min(...E.flat()) };
}

/** V de Cramér (sobre el chi cuadrado sin corrección). */
function cramerV(t) {
  const n = suma(t.map(suma));
  const k = Math.min(t.length, t[0].length) - 1;
  if (!k || !n) return null;
  return Math.sqrt(chi2Estadistico(t, esperadas(t)) / (n * k));
}

const lfact = (n) => lgamma(n + 1);
/** Test exacto de Fisher bilateral para tablas 2×2. */
function fisher2x2([[a, b], [c, d]]) {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
  const lp = (x) => lfact(r1) + lfact(r2) + lfact(c1) + lfact(n - c1) - lfact(n) - lfact(x) - lfact(r1 - x) - lfact(c1 - x) - lfact(r2 - c1 + x);
  const pObs = Math.exp(lp(a));
  let p = 0;
  for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) {
    const px = Math.exp(lp(x));
    if (px <= pObs * (1 + 1e-7)) p += px;
  }
  const or = b * c ? (a * d) / (b * c) : null;
  return { p: Math.min(1, p), odds_ratio: or };
}

/**
 * Chi cuadrado con p-valor por simulación Monte Carlo (como chisq.test(simulate.p.value = TRUE) de R):
 * se permutan las etiquetas manteniendo los totales marginales. p = (1 + extremos) / (B + 1).
 */
function chi2MonteCarlo(filasV, colsV, filas, cols, B = 10000, aleatorio = rng()) {
  const tabla = (fv, cv) => contingenciaFija(fv, cv, filas, cols);
  const t = tabla(filasV, colsV);
  const E = esperadas(t);
  const obs = chi2Estadistico(t, E);
  const cv = [...colsV];
  let extremos = 0;
  for (let b = 0; b < B; b++) {
    for (let i = cv.length - 1; i > 0; i--) { const j = Math.floor(aleatorio() * (i + 1)); [cv[i], cv[j]] = [cv[j], cv[i]]; }
    if (chi2Estadistico(tabla(filasV, cv), E) >= obs - 1e-9) extremos++;
  }
  return { chi2: obs, gl: (t.length - 1) * (t[0].length - 1), p: (1 + extremos) / (B + 1), B };
}
function contingenciaFija(fv, cv, filas, cols) {
  const t = filas.map(() => cols.map(() => 0));
  fv.forEach((f, i) => { t[filas.indexOf(f)][cols.indexOf(cv[i])]++; });
  return t;
}

/**
 * Cruce de dos variables categóricas: elige el test según las frecuencias esperadas.
 * Esperadas ≥ 5 → chi cuadrado; si alguna < 5 → Fisher exacto (2×2) o Monte Carlo (tablas mayores).
 */
function cruceCategorico(filasV, colsV, ordenFilas, ordenCols, opciones = {}) {
  const ct = contingencia(filasV, colsV, ordenFilas, ordenCols);
  const n = filasV.length;
  if (ct.filas.length < 2 || ct.cols.length < 2) return { ...ct, n, p: null, error: 'Una de las variables tiene una sola categoría con datos' };
  const base = chi2Contingencia(ct.tabla);
  const V = cramerV(ct.tabla);
  if (base.min_esperada >= 5) return { ...ct, n, test: base.yates ? 'Chi cuadrado (Yates)' : 'Chi cuadrado', estadistico: base.chi2, gl: base.gl, p: base.p, efecto: V, efecto_tipo: 'V de Cramér', min_esperada: base.min_esperada };
  if (ct.tabla.length === 2 && ct.tabla[0].length === 2) {
    const f = fisher2x2(ct.tabla);
    return { ...ct, n, test: 'Fisher exacto', estadistico: f.odds_ratio, estadistico_tipo: 'odds ratio', p: f.p, efecto: V, efecto_tipo: 'V de Cramér', min_esperada: base.min_esperada };
  }
  const mc = chi2MonteCarlo(filasV.filter((f, i) => ct.filas.includes(f) && ct.cols.includes(colsV[i])),
    colsV.filter((c, i) => ct.filas.includes(filasV[i]) && ct.cols.includes(c)), ct.filas, ct.cols, opciones.B, opciones.rng);
  return { ...ct, n, test: `Chi cuadrado Monte Carlo (${mc.B} réplicas)`, estadistico: mc.chi2, gl: mc.gl, p: mc.p, efecto: V, efecto_tipo: 'V de Cramér', min_esperada: base.min_esperada };
}

// ---------- Comparaciones múltiples ----------
/** Corrección de Holm-Bonferroni. Los null se ignoran (tests que no se pudieron correr). */
function holm(ps) {
  const idx = ps.map((p, i) => [p, i]).filter(([p]) => p != null).sort((a, b) => a[0] - b[0]);
  const m = idx.length;
  const out = ps.map(() => null);
  let max = 0;
  idx.forEach(([p, i], k) => { max = Math.max(max, Math.min(1, (m - k) * p)); out[i] = max; });
  return out;
}

// ---------- ROC ----------
/** AUC por el estadístico de Mann-Whitney (empates cuentan 0,5). */
function auc(scores, y) {
  const pos = scores.filter((_, i) => y[i]), neg = scores.filter((_, i) => !y[i]);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const p of pos) for (const q of neg) s += p > q ? 1 : p === q ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

/** Puntos de la curva ROC (tasa de falsos positivos, tasa de verdaderos positivos) por cada corte. */
function curvaRoc(scores, y) {
  const P = y.filter(Boolean).length, N = y.length - P;
  const cortes = [...new Set(scores)].sort((a, b) => b - a);
  const pts = [{ corte: Infinity, fpr: 0, tpr: 0 }];
  for (const c of cortes) {
    const tp = scores.filter((s, i) => s >= c && y[i]).length;
    const fp = scores.filter((s, i) => s >= c && !y[i]).length;
    pts.push({ corte: c, fpr: N ? fp / N : 0, tpr: P ? tp / P : 0 });
  }
  return pts;
}

/** Intervalo de confianza del AUC por bootstrap de percentiles. */
function aucBootstrap(scores, y, B = 1000, nivel = 0.95, aleatorio = rng()) {
  const n = scores.length, vals = [];
  for (let b = 0; b < B; b++) {
    const s = [], t = [];
    for (let i = 0; i < n; i++) { const k = Math.floor(aleatorio() * n); s.push(scores[k]); t.push(y[k]); }
    const a = auc(s, t);
    if (a != null) vals.push(a);
  }
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(p * (vals.length - 1))))];
  return { li: q((1 - nivel) / 2), ls: q(1 - (1 - nivel) / 2), B: vals.length };
}

module.exports = {
  rng, lgamma, gammaQ, betaI, chi2Sf, normSf, tSf2, rangos, spearman, mannWhitney, kruskal,
  contingencia, chi2Contingencia, cramerV, fisher2x2, chi2MonteCarlo, cruceCategorico, holm, auc, curvaRoc, aucBootstrap,
};
