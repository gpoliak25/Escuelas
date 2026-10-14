'use strict';
/* Estadística: descriptiva de la escuela y análisis de morosidad (inferencial, ROC, Pareto y conclusiones).
   Usa las utilidades globales de app.js (h, raw, api, columnChart…) y de escolar.js (nf, csvBtn, bindCsv). */

routes.estadisticas = pageEstadisticas;
routes.morosidad = pageMorosidad;

// ---------- Utilidades ----------
function fmtStat(v, unidad) {
  if (v == null) return '—';
  if (unidad === '$') return money(v);
  if (unidad === '%') return nf(v, 1) + '%';
  return nf(v, 2);
}
const fp = (p) => (p == null ? '—' : p < 0.001 ? '< 0,001' : nf(p, 3));

function descargarTexto(nombre, texto, tipo = 'text/plain') {
  const blob = new Blob(['﻿' + texto], { type: `${tipo};charset=utf-8` });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nombre });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** CSV estándar (coma y punto decimal) para procesar con Python, R o planillas. */
function aCsv(filas) {
  if (!filas.length) return '';
  const cols = Object.keys(filas[0]);
  const celda = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...filas.map((f) => cols.map((c) => celda(f[c])).join(','))].join('\r\n');
}

/** Markdown mínimo (títulos, listas, negritas y citas) para mostrar las conclusiones. */
function markdown(md) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  let out = '', lista = false;
  for (const linea of md.split('\n')) {
    const item = /^- (.*)/.exec(linea);
    if (!item && lista) { out += '</ul>'; lista = false; }
    if (item) { if (!lista) { out += '<ul>'; lista = true; } out += `<li>${inline(item[1])}</li>`; }
    else if (/^# /.test(linea)) continue; // el título ya está en el encabezado de la tarjeta
    else if (/^## /.test(linea)) out += `<h3>${inline(linea.slice(3))}</h3>`;
    else if (/^> /.test(linea)) out += `<blockquote>${inline(linea.slice(2))}</blockquote>`;
    else if (linea.trim()) out += `<p>${inline(linea)}</p>`;
  }
  return raw(out + (lista ? '</ul>' : ''));
}

// ---------- Gráficos ----------
/**
 * Pareto en un solo eje (porcentaje): cada barra es la participación de la familia en el total
 * y la línea, el acumulado. Línea de referencia horizontal en el 80% y vertical en la familia que lo alcanza.
 */
function paretoChart(el, p, { fmtValor, ref = 0.8, etiqueta = 'familias' }) {
  const W = 1100, H = 300, m = { t: 14, r: 12, b: 30, l: 44 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b, n = p.lista.length;
  const step = iw / Math.max(1, n), bw = Math.max(1.5, Math.min(18, step - 2));
  const x = (i) => m.l + step * i + step / 2, y = (v) => m.t + ih - v * ih;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pareto: participación y acumulado por familia"><g class="grid">`;
  for (let i = 0; i <= 4; i++) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(i / 4)}" y2="${y(i / 4)}"/>`;
  svg += '</g><g class="axis">';
  for (let i = 0; i <= 4; i++) svg += `<text x="${m.l - 8}" y="${y(i / 4) + 4}" text-anchor="end">${i * 25}%</text>`;
  const cada = n > 40 ? 10 : n > 15 ? 5 : 1;
  p.lista.forEach((_, i) => { if ((i + 1) % cada === 0 || i === 0) svg += `<text x="${x(i)}" y="${H - 12}" text-anchor="middle">${i + 1}</text>`; });
  svg += `<text x="${W - m.r}" y="${H}" text-anchor="end">${esc(etiqueta)} ordenadas →</text></g>`;
  p.lista.forEach((f, i) => {
    const share = p.total ? f.valor / p.total : 0, hh = share * ih;
    if (hh >= 0.5) svg += `<path d="${roundedTop(x(i) - bw / 2, y(share), bw, hh, Math.min(4, bw / 2))}" style="fill:var(--brand-2)"/>`;
  });
  svg += `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${y(ref)}" y2="${y(ref)}"/><text class="ref-lbl" x="${m.l + 4}" y="${y(ref) - 5}">${Math.round(ref * 100)}%</text>`;
  if (p.n_ref) svg += `<line class="ref" x1="${x(p.n_ref - 1)}" x2="${x(p.n_ref - 1)}" y1="${m.t}" y2="${m.t + ih}"/>`;
  svg += `<polyline class="acum" points="${p.lista.map((f, i) => `${x(i)},${y(f.pct_acum)}`).join(' ')}"/>`;
  p.lista.forEach((_, i) => { svg += `<rect class="hit" data-i="${i}" x="${m.l + step * i}" y="${m.t}" width="${step}" height="${ih}"/>`; });
  svg += '</svg>';
  el.innerHTML = `<div class="chart">${svg}<div class="tip"></div></div>
    <div class="legend"><span><i style="background:var(--brand-2)"></i>Participación de cada familia</span><span><i style="background:var(--accent)"></i>Acumulado</span><span><i class="dash"></i>Referencia ${Math.round(ref * 100)}%</span></div>`;
  hoverTip(el, (i) => {
    const f = p.lista[i];
    return `<b>${f.rank}. ${esc(f.apellido || 'Familia ' + f.id_familia)}</b><div><span>Valor</span><span class="num">${esc(fmtValor(f.valor))}</span></div>
      <div><span>Del total</span><span class="num">${pct(p.total ? f.valor / p.total : 0, 1)}</span></div><div><span>Acumulado</span><span class="num">${pct(f.pct_acum, 1)}</span></div>`;
  });
}

/** Curva ROC: tasa de verdaderos positivos contra falsos positivos para cada corte del puntaje. */
function rocChart(el, roc) {
  const W = 420, H = 340, m = { t: 12, r: 14, b: 40, l: 48 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const x = (v) => m.l + v * iw, y = (v) => m.t + ih - v * ih;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Curva ROC del puntaje de riesgo"><g class="grid">`;
  for (let i = 0; i <= 4; i++) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(i / 4)}" y2="${y(i / 4)}"/><line x1="${x(i / 4)}" x2="${x(i / 4)}" y1="${m.t}" y2="${m.t + ih}"/>`;
  svg += '</g><g class="axis">';
  for (let i = 0; i <= 4; i++) svg += `<text x="${m.l - 8}" y="${y(i / 4) + 4}" text-anchor="end">${nf(i / 4, 2)}</text><text x="${x(i / 4)}" y="${m.t + ih + 16}" text-anchor="middle">${nf(i / 4, 2)}</text>`;
  svg += `<text x="${m.l + iw / 2}" y="${H - 4}" text-anchor="middle">1 − especificidad (falsos positivos)</text>
    <text transform="translate(12 ${m.t + ih / 2}) rotate(-90)" text-anchor="middle">Sensibilidad</text></g>`;
  svg += `<line class="ref" x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}"/>`;
  svg += `<polyline class="roc" points="${roc.curva.map((q) => `${x(q.fpr)},${y(q.tpr)}`).join(' ')}"/>`;
  roc.curva.forEach((q, i) => { if (i) svg += `<circle class="hit-pt" data-i="${i}" cx="${x(q.fpr)}" cy="${y(q.tpr)}" r="9"/>`; });
  svg += '</svg>';
  el.innerHTML = `<div class="chart">${svg}<div class="tip"></div></div>
    <div class="legend"><span><i style="background:var(--brand-2)"></i>Puntaje de riesgo</span><span><i class="dash"></i>Azar (AUC 0,5)</span></div>`;
  hoverTip(el, (i) => {
    const q = roc.curva[i];
    return `<b>Alerta desde ${q.corte} puntos</b><div><span>Sensibilidad</span><span class="num">${pct(q.tpr, 0)}</span></div><div><span>Especificidad</span><span class="num">${pct(1 - q.fpr, 0)}</span></div>`;
  }, '.hit-pt');
}

function hoverTip(el, html, sel = '.hit') {
  const tip = $('.tip', el), box = $('.chart', el);
  $$(sel, el).forEach((r) => {
    r.addEventListener('mouseenter', () => {
      tip.innerHTML = html(Number(r.dataset.i));
      tip.style.display = 'block';
      const bb = box.getBoundingClientRect(), rb = r.getBoundingClientRect();
      let left = rb.left - bb.left + rb.width / 2 + 12;
      if (left + 190 > bb.width) left = rb.left - bb.left + rb.width / 2 - 200;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = '8px';
    });
    r.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  });
}

// ---------- Estadística descriptiva ----------
function tablaFrecuencias(id, filas, titulo = 'Valor') {
  if (!filas.length) return h`<div class="empty">Sin datos.</div>`;
  const total = filas.reduce((a, f) => a + f.abs, 0);
  return h`<div class="table-wrap"><table id="${id}" class="freq">
    <thead><tr><th>${titulo}</th><th class="r">Frec. absoluta</th><th>Frec. relativa</th><th class="r">Acumulada</th></tr></thead>
    <tbody>${filas.map((f) => h`<tr><td>${f.valor}</td><td class="r num">${f.abs}</td>
      <td><span class="relbar"><span class="bar"><i style="width:${f.rel * 100}%"></i></span><span class="num">${pct(f.rel, 1)}</span></span></td>
      <td class="r num">${f.acum != null ? pct(f.acum, 1) : ''}</td></tr>`)}
      <tr class="total"><td>Total</td><td class="r num">${total}</td><td class="num">100%</td><td></td></tr>
    </tbody></table></div>`;
}

function tablaGrupos(id, filas, unidad, etiqueta) {
  return h`<div class="table-wrap"><table id="${id}">
    <thead><tr><th>${etiqueta}</th><th class="r">n</th><th class="r">Media</th><th class="r">Mediana</th><th class="r">Desvío</th><th class="r">Mín.</th><th class="r">Máx.</th></tr></thead>
    <tbody>${filas.map((f) => h`<tr><td>${f.grupo}</td><td class="r num">${f.n}</td>
      ${f.n ? h`<td class="r num">${fmtStat(f.media, unidad)}</td><td class="r num">${fmtStat(f.mediana, unidad)}</td><td class="r num">${fmtStat(f.desvio, unidad)}</td><td class="r num">${fmtStat(f.min, unidad)}</td><td class="r num">${fmtStat(f.max, unidad)}</td>`
        : h`<td class="r muted" colspan="5">Sin datos</td>`}</tr>`)}
    </tbody></table></div>`;
}

function interpretarR(r) {
  if (r == null) return 'sin datos suficientes';
  const a = Math.abs(r);
  const fuerza = a >= 0.6 ? 'fuerte' : a >= 0.3 ? 'moderada' : 'débil';
  return `relación ${r >= 0 ? 'positiva' : 'negativa'} ${fuerza}`;
}

async function pageEstadisticas() {
  const s = await api('/api/estadisticas');
  const m = s.matricula, fa = s.familias, co = s.cobranza, as = s.asistencia;
  const asimetricas = s.resumen.filter((r) => r.asimetrica);
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Estadística · descriptiva · ciclo ${s.ciclo}</div><h1>Estadística descriptiva</h1>
      <p>Matrícula, familias, cobranza y asistencia al ${fdate(s.hoy)}. Cada tabla se puede descargar en CSV.</p>
    </div><div class="btn-row"><a class="btn" href="#/morosidad">Ver el análisis de morosidad →</a></div></div>

    <div class="grid g-3">
      <div class="card kpi"><span class="label">Matrícula activa</span><span class="value">${m.total}</span><span class="sub">${m.altas_ciclo} altas y ${m.bajas_ciclo} bajas en el ciclo (tasa de bajas ${pct(m.tasa_bajas, 1)})</span></div>
      <div class="card kpi"><span class="label">Cuotas con atraso</span><span class="value">${pct(co.pct_atraso_mayor_0, 1)}</span><span class="sub">${pct(co.pct_atraso_mayor_umbral, 1)} con más de ${co.umbral_moroso} días · ${co.cuotas} cuotas de los últimos 12 meses</span></div>
      <div class="card kpi"><span class="label">Asistencia mediana</span><span class="value">${as.pct.n ? nf(as.pct.mediana, 1) + '%' : '—'}</span><span class="sub">${as.cronico} alumno(s) por debajo del 90% en 30 días</span></div>
    </div>

    <div class="card mt">
      <div class="card-head"><div><h2>Resumen de variables numéricas</h2><p>Cada variable con su unidad de análisis y su propio n</p></div>${csvBtn('t-resumen', 'resumen-variables')}</div>
      <div class="table-wrap"><table id="t-resumen">
        <thead><tr><th>Variable</th><th>Unidad de análisis</th><th class="r">n</th><th class="r">Media</th><th class="r">Mediana</th><th class="r">Moda</th><th class="r">Desvío</th><th class="r">CV</th><th class="r">Mín.</th><th class="r">P25</th><th class="r">P75</th><th class="r">Máx.</th><th class="r">Asimetría</th></tr></thead>
        <tbody>${s.resumen.map((r) => h`<tr><td><b>${r.variable}</b><div class="small muted">${r.unidad}</div></td><td>${r.unidad_analisis}</td><td class="r num">${r.n}</td>
          ${r.n ? h`<td class="r num ${r.asimetrica ? 'muted' : ''}">${fmtStat(r.media, r.unidad)}</td><td class="r num"><b>${fmtStat(r.mediana, r.unidad)}</b></td><td class="r num">${fmtStat(r.moda, r.unidad)}</td>
            <td class="r num">${fmtStat(r.desvio, r.unidad)}</td><td class="r num">${r.cv == null ? '—' : pct(r.cv, 0)}</td><td class="r num">${fmtStat(r.min, r.unidad)}</td>
            <td class="r num">${fmtStat(r.p25, r.unidad)}</td><td class="r num">${fmtStat(r.p75, r.unidad)}</td><td class="r num">${fmtStat(r.max, r.unidad)}</td>
            <td class="r num">${nf(r.asimetria, 2)}${r.asimetrica ? h` <span class="pill warn" title="|asimetría| > 1: usar mediana y percentiles">Asimétrica</span>` : ''}</td>`
            : h`<td colspan="10" class="muted">Sin datos</td>`}</tr>`)}
        </tbody></table></div>
      ${asimetricas.length ? h`<p class="small mt"><span class="pill warn">Asimétrica</span> ${asimetricas.map((r) => r.variable.toLowerCase()).join(', ')}: la cola de valores extremos arrastra la media, así que conviene leer la <b>mediana</b> y los <b>percentiles P25–P75</b>.</p>` : ''}
      <details class="glosario"><summary>¿Cómo leer esta tabla?</summary>
        <p><b>Media</b>: promedio. <b>Mediana</b>: el valor del medio (la mitad está por debajo). <b>Moda</b>: el valor más frecuente.
        <b>Desvío</b>: cuánto se alejan los valores del promedio, en la misma unidad. <b>CV</b> (coeficiente de variación): desvío ÷ media; permite comparar variables distintas.
        <b>P25 y P75</b>: el 25% y el 75% de los casos está por debajo de esos valores. <b>Asimetría</b>: positiva si hay una cola de valores altos (por ejemplo, pocos atrasos muy largos), cercana a 0 si es simétrica; por encima de 1 en valor absoluto se marca como asimétrica.
        <b>Unidad de análisis</b>: qué se cuenta en cada fila (alumnos, familias o cuotas); por eso cada variable tiene su propio n.</p>
      </details>
    </div>

    <h2 class="section-title">Matrícula</h2>
    <div class="grid g-2">
      <div class="card"><div class="card-head"><div><h2>Alumnos por grado</h2></div>${csvBtn('t-grado', 'alumnos-por-grado')}</div>
        <div id="ch-grado"></div>${tablaFrecuencias('t-grado', m.por_grado, 'Grado')}</div>
      <div class="card"><div class="card-head"><div><h2>Edad por grado</h2><p>En años cumplidos</p></div>${csvBtn('t-edad', 'edad-por-grado')}</div>
        ${tablaGrupos('t-edad', m.edad_por_grado, 'años', 'Grado')}</div>
      <div class="card"><div class="card-head"><div><h2>Por turno</h2></div>${csvBtn('t-turno', 'alumnos-por-turno')}</div>${tablaFrecuencias('t-turno', m.por_turno, 'Turno')}
        <div class="card-head mt"><div><h2>Por género</h2></div>${csvBtn('t-genero', 'alumnos-por-genero')}</div>${tablaFrecuencias('t-genero', m.por_genero, 'Género')}</div>
      <div class="card"><div class="card-head"><div><h2>Ocupación por curso</h2></div>${csvBtn('t-ocup', 'ocupacion-cursos')}</div>
        <div class="table-wrap"><table id="t-ocup"><thead><tr><th>Curso</th><th>Turno</th><th class="r">Inscriptos</th><th class="r">Cupo</th><th>Ocupación</th></tr></thead><tbody>
          ${m.cursos.map((c) => h`<tr><td>${c.curso}</td><td>${TURNO_LBL[c.turno]}</td><td class="r num">${c.inscriptos}</td><td class="r num">${c.capacidad}</td>
            <td><span class="relbar"><span class="bar"><i style="width:${Math.min(100, c.ocupacion * 100)}%"></i></span><span class="num">${pct(c.ocupacion, 0)}</span></span></td></tr>`)}
        </tbody></table></div>
        <p class="small muted">Ocupación total ${pct(m.ocupacion, 0)} · ${m.vacantes} vacantes disponibles.</p>
        <div class="card-head mt"><div><h2>Motivos de baja en el ciclo</h2></div></div>${tablaFrecuencias('t-bajas', m.motivos_baja, 'Motivo')}</div>
    </div>

    <h2 class="section-title">Familias</h2>
    <div class="grid g-2">
      <div class="card"><div class="card-head"><div><h2>Hijos por familia</h2><p>Mediana ${nf(fa.hijos.mediana, 1)} · media ${nf(fa.hijos.media, 2)} · desvío ${nf(fa.hijos.desvio, 2)}</p></div></div>${tablaFrecuencias('t-hijos', fa.hijos_frec, 'Hijos')}</div>
      <div class="card"><div class="card-head"><div><h2>Medios de pago</h2></div>${csvBtn('t-medios', 'medios-de-pago')}</div>${tablaFrecuencias('t-medios', fa.medios_pago, 'Medio')}</div>
      <div class="card"><h2>Becas</h2>
        <div class="kpi mt"><span class="value">${fa.becas.alumnos}</span><span class="sub">alumnos becados (${pct(fa.becas.pct, 1)} de la matrícula)</span></div>
        <p class="small">Beca mediana: <b>${fa.becas.porcentaje.n ? nf(fa.becas.porcentaje.mediana, 1) + '%' : '—'}</b></p>
        <p class="small">Cuota familiar: mediana <b>${money(fa.cuota.mediana)}</b>, entre ${money(fa.cuota.min)} y ${money(fa.cuota.max)}.</p></div>
    </div>

    <h2 class="section-title">Cobranza · últimos 12 meses</h2>
    <div class="grid g-2">
      <div class="card"><div class="card-head"><div><h2>Distribución de los días de atraso</h2><p>${co.cuotas} cuotas vencidas · ${pct(co.pct_atraso_mayor_0, 1)} con atraso, ${pct(co.pct_atraso_mayor_umbral, 1)} con más de ${co.umbral_moroso} días · mediana ${nf(co.atraso.mediana)} días · P90 ${nf(co.atraso.p90)} días</p></div>${csvBtn('t-atraso', 'distribucion-atraso')}</div>
        <div id="ch-atraso"></div>${tablaFrecuencias('t-atraso', co.atraso_hist, 'Días de atraso')}</div>
      <div class="card"><div class="card-head"><div><h2>Distribución del puntaje de riesgo</h2><p>Familias activas · mediana ${nf(co.puntaje.mediana)} · P25 ${nf(co.puntaje.p25)} · P75 ${nf(co.puntaje.p75)}</p></div>${csvBtn('t-puntaje', 'distribucion-puntaje')}</div>
        <div id="ch-puntaje"></div>${tablaFrecuencias('t-puntaje', co.puntaje_hist, 'Puntaje')}</div>
    </div>
    <div class="grid g-2 mt">
      <div class="card"><div class="card-head"><div><h2>Atraso según medio de pago</h2><p>Días de atraso por cuota</p></div>${csvBtn('t-atraso-medio', 'atraso-por-medio')}</div>
        ${tablaGrupos('t-atraso-medio', co.atraso_por_medio, 'días', 'Medio de pago')}</div>
      <div class="card"><div class="card-head"><div><h2>¿El puntaje anticipa el atraso?</h2><p>Correlación de Pearson (r)</p></div></div>
        <div class="gauge"><span class="big num">${co.correlacion.r == null ? '—' : nf(co.correlacion.r, 2)}</span>
          <p class="small" style="margin:0">Entre el puntaje calculado 10 días antes de cada vencimiento y los días de atraso reales, sobre ${co.correlacion.n} cuotas de los últimos 6 meses: <b>${interpretarR(co.correlacion.r)}</b>.</p></div>
        <p class="small muted">r va de −1 a 1: cerca de 0 no hay relación; cuanto más cerca de 1, mejor ordena el puntaje a las familias según su atraso. Los tests de asociación con p-valores están en el <a href="#/morosidad">análisis de morosidad</a>.</p>
      </div>
    </div>

    <h2 class="section-title">Asistencia · últimos 30 días</h2>
    <div class="grid g-2">
      <div class="card"><div class="card-head"><div><h2>Asistencia por alumno</h2><p>${as.alumnos} alumnos · ${as.dias} días hábiles · ${as.tardanzas} tardanzas · ${as.justificadas == null ? '—' : pct(as.justificadas, 0)} de faltas justificadas</p></div>${csvBtn('t-asis', 'distribucion-asistencia')}</div>
        <div id="ch-asis"></div>${tablaFrecuencias('t-asis', as.pct_hist, 'Asistencia')}</div>
      <div class="card"><div class="card-head"><div><h2>Inasistencias por día de la semana</h2><p>Porcentaje de ausentes sobre los registros de cada día</p></div></div>
        <div id="ch-dia"></div>
        <div class="card-head mt"><div><h2>Asistencia por grado</h2><p>Porcentaje de asistencia por alumno</p></div>${csvBtn('t-asis-grado', 'asistencia-por-grado')}</div>
        ${tablaGrupos('t-asis-grado', as.por_grado, '%', 'Grado')}</div>
    </div>`);

  const hist = (el, filas, label, color = 'var(--brand-2)') => columnChart($(el), filas.map((f) => ({ label: f.valor, cant: f.abs, extra: ['Porcentaje', pct(f.rel, 1)] })),
    [{ key: 'cant', label, color }], { fmt: String, fmtAxis: (v) => nf(v, 0), height: 220 });
  hist('#ch-grado', m.por_grado, 'Alumnos');
  hist('#ch-atraso', co.atraso_hist, 'Cuotas');
  hist('#ch-puntaje', co.puntaje_hist, 'Familias');
  hist('#ch-asis', as.pct_hist, 'Alumnos');
  columnChart($('#ch-dia'), as.por_dia.map((d) => ({ label: d.valor, tasa: d.rel, extra: ['Ausencias', String(d.abs)] })),
    [{ key: 'tasa', label: 'Inasistencia', color: 'var(--brand-2)' }], { fmt: (v) => pct(v, 1), fmtAxis: (v) => pct(v, 0), height: 220 });
  bindCsv();
}

// ---------- Análisis de morosidad ----------
function tablaContingencia(t) {
  if (!t.tabla) return '';
  return h`<div class="table-wrap"><table class="small">
    <thead><tr><th>Categoría</th>${t.cols.map((c) => h`<th class="r">${c}</th>`)}<th class="r">% morosa</th></tr></thead>
    <tbody>${t.filas.map((f, i) => {
      const tot = t.tabla[i].reduce((a, b) => a + b, 0);
      return h`<tr><td>${f}</td>${t.tabla[i].map((v) => h`<td class="r num">${v}</td>`)}<td class="r num">${pct(tot ? t.tabla[i][t.cols.indexOf('Morosa')] / tot : 0, 0)}</td></tr>`;
    })}</tbody></table></div>`;
}

function tablaMedianas(t) {
  if (!t.grupos) return '';
  return h`<div class="table-wrap"><table class="small">
    <thead><tr><th>Grupo</th><th class="r">Familias</th><th class="r">Mediana del atraso máx.</th></tr></thead>
    <tbody>${t.grupos.map((g) => h`<tr><td>${g.grupo}</td><td class="r num">${g.n}</td><td class="r num">${nf(g.mediana, 1)} días</td></tr>`)}</tbody></table></div>`;
}

const PARETOS = [
  { key: 'atraso', titulo: 'Días de atraso acumulados por familia', que: 'del atraso', fmt: (v) => `${nf(v, 0)} días`, archivo: 'pareto-atraso' },
  { key: 'deuda', titulo: 'Deuda vencida por familia', que: 'de la deuda', fmt: money, archivo: 'pareto-deuda' },
  { key: 'puntaje', titulo: 'Atraso acumulado, con las familias ordenadas por puntaje', que: 'del atraso', fmt: (v) => `${nf(v, 0)} días`, archivo: 'pareto-puntaje' },
];

async function pageMorosidad() {
  const d = await api('/api/estadisticas/morosidad');
  const c = d.config, roc = d.roc;
  const problemas = d.validacion.filter((v) => !v.ok);
  const sig = d.inferencial.filter((t) => t.significativo);
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Estadística · análisis de morosidad</div><h1>Análisis de morosidad</h1>
      <p>Familia <b>morosa</b>: al menos una cuota con más de ${c.UMBRAL_MOROSO_DIAS} días de atraso en los últimos 12 meses. Los tests se hacen a nivel familia, porque las cuotas de una misma familia no son independientes.
        α = ${nf(c.ALFA, 2)} con ajuste de Holm. Datos al ${fdate(d.hoy)}.</p>
    </div><div class="btn-row">
      <button class="btn sm" id="dl-md">Descargar conclusiones (.md)</button>
      <button class="btn sm" id="dl-datos">Exportar dataset para Python</button>
    </div></div>

    <div class="grid g-4">
      <div class="card kpi"><span class="label">Familias analizadas</span><span class="value">${d.n.analizadas}</span><span class="sub">${d.n.alumnos} alumnos · ${d.n.cuotas} cuotas</span></div>
      <div class="card kpi"><span class="label">Familias morosas</span><span class="value">${d.n.morosas}</span><span class="sub">${pct(d.n.analizadas ? d.n.morosas / d.n.analizadas : null, 1)} de las analizadas</span></div>
      <div class="card kpi"><span class="label">AUC del puntaje</span><span class="value">${roc ? nf(roc.auc, 2) : '—'}</span><span class="sub">${roc ? h`IC 95%: ${nf(roc.ic.li, 2)} a ${nf(roc.ic.ls, 2)}` : 'Sin datos suficientes'}</span></div>
      <div class="card kpi"><span class="label">Concentración del atraso</span><span class="value">${d.pareto.atraso.n_ref ?? '—'}</span><span class="sub">${d.pareto.atraso.n_ref ? h`familias (${pct(d.pareto.atraso.pct_familias_ref, 0)}) explican el ${pct(d.pareto.atraso.pct_valor_ref, 0)}` : 'Sin atrasos'}</span></div>
    </div>

    <div class="card mt">
      <div class="card-head"><div><h2>Calidad de los datos</h2><p>Nulos, duplicados, rangos imposibles e identificadores sin familia. Se informan, no frenan el análisis.</p></div>
        <span class="pill ${problemas.length ? 'warn' : 'ok'}">${problemas.length ? `${problemas.length} observación(es)` : 'Sin observaciones'}</span></div>
      ${problemas.length ? h`<ul class="small">${problemas.map((v) => h`<li><b>${v.tabla}</b>: ${v.chequeo} → ${v.n}${v.detalle ? ` (${v.detalle})` : ''}</li>`)}</ul>` : ''}
      <details class="glosario"><summary>Ver los ${d.validacion.length} chequeos</summary>
        <div class="table-wrap"><table class="small"><thead><tr><th>Tabla</th><th>Chequeo</th><th class="r">Casos</th></tr></thead>
          <tbody>${d.validacion.map((v) => h`<tr><td>${v.tabla}</td><td>${v.chequeo}</td><td class="r num">${v.n}</td></tr>`)}</tbody></table></div>
      </details>
    </div>

    <h2 class="section-title">Estadística inferencial</h2>
    <div class="card">
      <div class="card-head"><div><h2>Resultados de los tests</h2><p>${sig.length} de ${d.inferencial.length} cruces con asociación significativa después del ajuste por comparaciones múltiples</p></div>${csvBtn('t-inf', 'inferencial')}</div>
      <div class="table-wrap"><table id="t-inf">
        <thead><tr><th>Cruce</th><th>Test</th><th class="r">Estadístico</th><th class="r">p</th><th class="r">p ajustado (Holm)</th><th class="r">Tamaño del efecto</th><th class="r">n</th><th>Significativo</th></tr></thead>
        <tbody>${d.inferencial.map((t) => h`<tr><td><b>${t.cruce}</b>${t.puntaje ? h`<div class="small muted">Valida el propio puntaje</div>` : ''}</td><td class="small">${t.test || '—'}</td>
          <td class="r num">${t.estadistico == null ? '—' : h`${nf(t.estadistico, 2)}<div class="small muted">${t.estadistico_tipo || 'χ²'}${t.gl ? ` · gl ${t.gl}` : ''}</div>`}</td>
          <td class="r num">${fp(t.p)}</td><td class="r num">${fp(t.p_ajustado)}</td>
          <td class="r num">${t.efecto == null ? '—' : h`${nf(t.efecto, 2)}<div class="small muted">${t.efecto_tipo}</div>`}</td><td class="r num">${t.n}</td>
          <td>${t.p == null ? h`<span class="pill plain" title="${t.error}">No se pudo correr</span>` : t.significativo ? h`<span class="pill bad">Sí</span>` : h`<span class="pill plain">No</span>`}</td></tr>`)}
        </tbody></table></div>
      <p class="small mt"><b>Asociación no implica causalidad.</b> Con ${d.n.analizadas} familias (${d.n.morosas} morosas y ${d.n.becadas} con algún hijo becado) los resultados son exploratorios: orientan, no confirman.
        Los cruces marcados "valida el propio puntaje" son circulares: el puntaje se calcula con el historial de pagos y la deuda, que también definen la morosidad.</p>
      <details class="glosario"><summary>¿Qué test se usó en cada caso?</summary>
        <p><b>Categórica × morosidad</b>: chi cuadrado de independencia (con corrección de Yates en tablas 2×2); si alguna frecuencia esperada es menor a 5, test exacto de Fisher (2×2) o chi cuadrado con p-valor por simulación Monte Carlo (${nf(c.MONTE_CARLO, 0)} réplicas). Tamaño del efecto: V de Cramér (0,1 chico, 0,3 mediano, 0,5 grande).
        <b>Numérica × numérica</b>: correlación de Spearman (rho), robusta a la asimetría y a los valores extremos.
        <b>Numérica por grupos</b>: Mann-Whitney (2 grupos, efecto rank-biserial) o Kruskal-Wallis (3 o más, efecto ε²), sobre el atraso máximo de cada familia.
        <b>Holm</b>: ajusta los p-valores porque se hacen ${d.inferencial.length} tests a la vez; sin el ajuste, alguno saldría "significativo" por azar.
        <b>Categorías</b>: riesgo bajo hasta P25 (${nf(d.cortes_riesgo.p25)} puntos), medio hasta P75 (${nf(d.cortes_riesgo.p75)}) y alto por encima; asistencia promedio de los hijos en 30 días con cortes en ${c.CORTES_ASISTENCIA.join('% y ')}%.</p>
      </details>
    </div>
    <div class="grid g-2 mt">
      ${d.inferencial.filter((t) => t.tabla).map((t) => h`<div class="card"><h2>${t.cruce}</h2><p class="small muted">${t.test || t.error} · p ${fp(t.p)}</p>${tablaContingencia(t)}</div>`)}
      ${d.inferencial.filter((t) => t.grupos).map((t) => h`<div class="card"><h2>${t.cruce}</h2><p class="small muted">${t.test} · p ${fp(t.p)}</p>${tablaMedianas(t)}</div>`)}
    </div>

    <div class="grid g-2 mt">
      <div class="card"><div class="card-head"><div><h2>Validación del puntaje de riesgo</h2><p>Curva ROC del puntaje actual contra la morosidad</p></div></div>
        ${roc ? h`<div id="ch-roc"></div>` : h`<div class="empty">Hace falta al menos una familia morosa y una no morosa.</div>`}</div>
      <div class="card"><h2>¿Cómo se lee?</h2>
        ${roc ? h`<div class="gauge mt"><span class="big num">${nf(roc.auc, 2)}</span>
          <p class="small" style="margin:0">AUC con intervalo de confianza del 95% por bootstrap (${roc.ic.B} réplicas): <b>${nf(roc.ic.li, 2)} a ${nf(roc.ic.ls, 2)}</b>. ${roc.positivos} familias morosas y ${roc.negativos} no morosas.</p></div>` : ''}
        <p class="small">El AUC es la probabilidad de que una familia morosa elegida al azar tenga más puntaje que una no morosa. 0,5 es azar; 0,7 aceptable; 0,8 bueno; 0,9 excelente. Pasá el mouse por la curva para ver la sensibilidad y la especificidad de cada corte.</p>
        <p class="small muted">Este AUC es optimista: el puntaje actual ya incluye la deuda y el historial que definen la morosidad. La validación sin esa ventaja es el backtest del <a href="#/riesgo">Motor predictivo</a> y de <a href="#/ml">Inteligencia (ML)</a>, que usan el puntaje calculado antes de cada vencimiento.</p>
      </div>
    </div>

    <h2 class="section-title">Análisis de Pareto</h2>
    ${PARETOS.map((p) => {
      const r = d.pareto[p.key];
      const top = r.top;
      return h`<div class="card mt">
        <div class="card-head"><div><h2>${p.titulo}</h2>
          <p>${r.total ? (top
            ? h`El ${pct(top.pct_familias, 0)} de familias con mayor puntaje (${top.n}) concentra el <b>${pct(top.pct_atraso, 1)}</b> del atraso y ${top.morosas_capturadas} de las ${d.n.morosas} familias morosas (${pct(top.pct_morosas, 0)}).`
            : h`<b>${r.n_ref} familias (${pct(r.pct_familias_ref, 1)} del total) explican el ${pct(r.pct_valor_ref, 1)} ${p.que}.</b>`) : 'Sin valores para analizar.'}
            ${r.ceros} familias (${pct(r.pct_ceros, 0)}) tienen valor cero.</p></div>${csvBtn(`t-${p.archivo}`, p.archivo)}</div>
        ${r.total ? h`<div id="ch-${p.key}"></div>` : ''}
        <details class="glosario"><summary>Lista priorizada de familias</summary>
          <div class="table-wrap"><table id="t-${p.archivo}"><thead><tr><th class="r">#</th><th>Familia</th><th class="r">${p.key === 'deuda' ? 'Deuda' : 'Días de atraso'}</th><th class="r">% acumulado</th><th class="r">Puntaje</th><th>Nivel (P25/P75)</th><th>Semáforo actual</th></tr></thead>
            <tbody>${r.lista.map((f) => h`<tr><td class="r num">${f.rank}</td><td><a href="#/familias/${f.id_familia}">${f.apellido}</a> <span class="small muted">#${f.id_familia}</span></td><td class="r num">${p.fmt(f.valor)}</td>
              <td class="r num">${pct(f.pct_acum, 1)}</td><td class="r num">${f.puntaje}</td><td>${f.riesgo_cat}</td><td>${nivelPill(f.nivel)}</td></tr>`)}</tbody></table></div>
        </details></div>`;
    })}

    <h2 class="section-title">Conclusiones automáticas</h2>
    <div class="card conclusiones">${markdown(d.conclusiones)}
      <p class="small muted mt">Generadas a partir de los cálculos de esta página; no agregan números que no surjan de ellos.</p></div>`);

  if (roc) rocChart($('#ch-roc'), roc);
  for (const p of PARETOS) if (d.pareto[p.key].total) paretoChart($(`#ch-${p.key}`), d.pareto[p.key], { fmtValor: p.fmt, ref: c.PARETO_REFERENCIA });
  $('#dl-md').addEventListener('click', () => descargarTexto(`conclusiones-morosidad-${d.hoy}.md`, d.conclusiones, 'text/markdown'));
  $('#dl-datos').addEventListener('click', async () => {
    const ds = await api('/api/estadisticas/dataset');
    for (const t of ['alumnos', 'familias', 'cuotas']) descargarTexto(`${t}.csv`, aCsv(ds[t]), 'text/csv');
    toast('Se descargaron alumnos.csv, familias.csv y cuotas.csv (sin datos personales). Ver analisis/README.md para correr el script.');
  });
  bindCsv();
}
