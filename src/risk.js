'use strict';
// Motor predictivo v1: reglas simples y explicables (slide 7: "se empieza con reglas
// simples y se pasa a un modelo estadístico al juntar historial").
//
// Cada señal de la slide 6 aporta puntos; el total (0-100) estima el riesgo de que la
// próxima cuota se pague con más de 10 días de atraso. Sólo se usan hábitos de pago y
// de contacto: nunca datos sensibles (slide 11).
const { diffDays, addDays } = require('./db');

const MESES_ESTACIONALES = [3, 7, 12]; // marzo, julio, diciembre
const ATRASO_RELEVANTE = 10; // días

const SENALES = [
  { key: 'historial', label: 'Historial de pagos', max: 40, anticipa: 'Atraso recurrente', mide: 'Días de atraso en las últimas seis cuotas' },
  { key: 'deuda', label: 'Deuda vencida actual', max: 25, anticipa: 'Atraso prolongado', mide: 'Cuotas vencidas e impagas a la fecha' },
  { key: 'momento', label: 'Momento del pago', max: 10, anticipa: 'Margen de caja ajustado', mide: 'Pagos en el último día o tras varios avisos' },
  { key: 'medio', label: 'Medio de pago', max: 20, anticipa: 'Impago inmediato', mide: 'Débitos rechazados o cambios de medio' },
  { key: 'vinculo', label: 'Vínculo con la escuela', max: 10, anticipa: 'Pérdida de contacto', mide: 'Avisos sin abrir ni responder' },
  { key: 'portal', label: 'Uso del portal', max: 10, anticipa: 'Dificultad para pagar', mide: 'Consulta el saldo y no paga' },
  { key: 'estacionalidad', label: 'Estacionalidad', max: 5, anticipa: 'Picos de mora previsibles', mide: 'Meses de más gasto: marzo, julio, diciembre' },
];

// Estado de una cuota tal como se conocía en la fecha asOf.
function cuotaAt(c, asOf) {
  let pagado = 0;
  let fechaPago = null;
  const validos = c.pagos.filter((p) => !p.rechazado && p.fecha <= asOf).sort((a, b) => a.fecha.localeCompare(b.fecha));
  for (const p of validos) {
    pagado += p.monto;
    if (pagado >= c.monto - 0.5) { fechaPago = p.fecha; break; }
  }
  if (!fechaPago && c.refinanciada_en && c.refinanciada_fecha && c.refinanciada_fecha <= asOf) {
    fechaPago = c.refinanciada_fecha; // la deuda pasó a un plan: se cierra con el atraso acumulado
  }
  const cerrada = Boolean(fechaPago);
  const atraso = Math.max(0, diffDays(cerrada ? fechaPago : asOf, c.vencimiento));
  return { cerrada, fechaPago, atraso, pagado };
}

function round1(n) { return Math.round(n * 10) / 10; }

/**
 * @param fam { cuotas: [{id, monto, vencimiento, refinanciada_en, refinanciada_fecha, pagos: [...]}],
 *              comunicaciones: [...], eventos: [...] }
 * @param asOf fecha ISO: sólo se usan datos conocidos hasta ese día.
 * @param proximoVenc vencimiento que se intenta anticipar (para estacionalidad).
 * @param umbrales { medio, alto }
 */
function scoreFamily(fam, asOf, proximoVenc, umbrales = { medio: 25, alto: 50 }) {
  const factores = {};
  const vencidas = fam.cuotas
    .filter((c) => c.vencimiento < asOf)
    .sort((a, b) => b.vencimiento.localeCompare(a.vencimiento));
  const ultimas = vencidas.slice(0, 6).map((c) => ({ c, s: cuotaAt(c, asOf) }));

  // 1. Historial de pagos
  if (ultimas.length) {
    const prom = ultimas.reduce((a, x) => a + x.s.atraso, 0) / ultimas.length;
    const largas = ultimas.filter((x) => x.s.atraso > ATRASO_RELEVANTE).length;
    const pts = Math.min(40, prom * 1.2 + largas * 4);
    factores.historial = {
      puntos: pts,
      detalle: `Promedio de ${round1(prom)} días de atraso en las últimas ${ultimas.length} cuotas` +
        (largas ? `; ${largas} con más de ${ATRASO_RELEVANTE} días` : ''),
    };
  } else {
    factores.historial = { puntos: 0, detalle: 'Sin historial todavía' };
  }

  // 2. Deuda vencida actual
  const abiertas = vencidas.map((c) => ({ c, s: cuotaAt(c, asOf) })).filter((x) => !x.s.cerrada);
  if (abiertas.length) {
    const max = Math.max(...abiertas.map((x) => x.s.atraso));
    const pts = max > 30 ? 25 : max > ATRASO_RELEVANTE ? 18 : 10;
    factores.deuda = { puntos: pts, detalle: `${abiertas.length} cuota(s) impaga(s), la más antigua con ${max} días de atraso` };
  } else {
    factores.deuda = { puntos: 0, detalle: 'Sin deuda vencida' };
  }

  // 3. Momento del pago: entre las pagadas en término, cuántas el último día o tras 2+ avisos
  const enTermino = ultimas.filter((x) => x.s.cerrada && x.s.atraso === 0);
  if (enTermino.length) {
    const justas = enTermino.filter((x) => {
      if (x.s.fechaPago === x.c.vencimiento) return true;
      const avisos = fam.comunicaciones.filter((m) => m.cuota_id === x.c.id && m.estado === 'enviada' && m.fecha <= x.s.fechaPago).length;
      return avisos >= 2;
    }).length;
    factores.momento = {
      puntos: (justas / enTermino.length) * 10,
      detalle: `${justas} de ${enTermino.length} pagos en término fueron el último día o tras varios avisos`,
    };
  } else {
    factores.momento = { puntos: 0, detalle: 'Sin pagos en término recientes' };
  }

  // 4. Medio de pago: débitos rechazados (180 días) y abandonos del débito automático
  const desde180 = addDays(asOf, -180);
  const rechazos = fam.cuotas.flatMap((c) => c.pagos).filter((p) => p.rechazado && p.fecha > desde180 && p.fecha <= asOf).length;
  const cambios = fam.eventos.filter((e) => e.tipo === 'cambio_medio' && e.fecha > desde180 && e.fecha <= asOf && /^debito/.test(e.detalle || '')).length;
  factores.medio = {
    puntos: Math.min(20, rechazos * 10 + cambios * 5),
    detalle: rechazos || cambios
      ? `${rechazos} débito(s) rechazado(s)${cambios ? ` y ${cambios} baja(s) del débito automático` : ''} en 6 meses`
      : 'Sin rechazos ni cambios de medio',
  };

  // 5. Vínculo: avisos sin abrir en los últimos 90 días
  const desde90 = addDays(asOf, -90);
  const avisos = fam.comunicaciones.filter((m) => m.estado === 'enviada' && m.canal !== 'llamada' && m.canal !== 'reunion' && m.fecha > desde90 && m.fecha <= asOf);
  if (avisos.length >= 2) {
    const sinAbrir = avisos.filter((m) => !m.abierto && !m.respondido).length;
    factores.vinculo = { puntos: (sinAbrir / avisos.length) * 10, detalle: `${sinAbrir} de ${avisos.length} avisos sin abrir ni responder (90 días)` };
  } else {
    factores.vinculo = { puntos: 0, detalle: 'Pocos avisos recientes para evaluar' };
  }

  // 6. Portal: consultas de saldo sin un pago en los 5 días siguientes (60 días)
  const desde60 = addDays(asOf, -60);
  const pagosFechas = fam.cuotas.flatMap((c) => c.pagos).filter((p) => !p.rechazado).map((p) => p.fecha);
  const consultas = fam.eventos.filter((e) => e.tipo === 'consulta_saldo' && e.fecha > desde60 && e.fecha <= asOf);
  const sinPago = consultas.filter((e) => !pagosFechas.some((f) => f >= e.fecha && diffDays(f, e.fecha) <= 5)).length;
  factores.portal = {
    puntos: Math.min(10, sinPago * 3),
    detalle: consultas.length ? `${sinPago} de ${consultas.length} consultas de saldo sin pago posterior (60 días)` : 'Sin consultas recientes',
  };

  // 7. Estacionalidad
  const mes = proximoVenc ? Number(proximoVenc.slice(5, 7)) : 0;
  const estacional = MESES_ESTACIONALES.includes(mes);
  factores.estacionalidad = {
    puntos: estacional ? 5 : 0,
    detalle: estacional ? 'El próximo vencimiento cae en un mes de alto gasto' : 'Mes sin estacionalidad marcada',
  };

  const total = Math.min(100, Math.round(Object.values(factores).reduce((a, f) => a + f.puntos, 0)));
  const nivel = total >= umbrales.alto ? 'alto' : total >= umbrales.medio ? 'medio' : 'bajo';
  const lista = SENALES.map((s) => ({ ...s, puntos: round1(factores[s.key].puntos), detalle: factores[s.key].detalle }));
  const top = lista.filter((f) => f.puntos > 0).sort((a, b) => b.puntos - a.puntos)[0];

  return {
    puntaje: total,
    nivel,
    motivo: top && nivel !== 'bajo' ? top.label : 'Paga en término',
    motivo_detalle: top && nivel !== 'bajo' ? top.detalle : '',
    factores: lista,
    as_of: asOf,
  };
}

module.exports = { scoreFamily, cuotaAt, SENALES, ATRASO_RELEVANTE };
