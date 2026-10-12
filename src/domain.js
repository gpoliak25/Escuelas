'use strict';
const { getSettings, today, diffDays, addDays } = require('./db');
const { scoreFamily, cuotaAt, ATRASO_RELEVANTE } = require('./risk');

// ---- Carga de datos ----------------------------------------------------------
// El volumen de una escuela primaria (cientos de familias) entra cómodo en memoria:
// se carga todo una vez por request y se calcula en JS.

function loadLedger(db) {
  const hoy = today(db);
  const settings = getSettings(db);
  const umbrales = { medio: Number(settings.umbral_medio) || 25, alto: Number(settings.umbral_alto) || 50 };

  const familias = db.prepare('SELECT * FROM familias ORDER BY apellido, responsable').all();
  const alumnos = db.prepare('SELECT * FROM alumnos ORDER BY grado, nombre').all();
  const planes = db.prepare('SELECT * FROM planes ORDER BY fecha DESC').all();
  const cuotas = db.prepare('SELECT * FROM cuotas ORDER BY vencimiento').all();
  // Con una fecha simulada, se ignora lo registrado "en el futuro".
  const pagos = db.prepare('SELECT * FROM pagos WHERE fecha <= ? ORDER BY fecha').all(hoy);
  const comunicaciones = db.prepare('SELECT * FROM comunicaciones WHERE fecha <= ? ORDER BY fecha DESC, id DESC').all(hoy);
  const eventos = db.prepare('SELECT * FROM eventos WHERE fecha <= ? ORDER BY fecha DESC, id DESC').all(hoy);

  const planById = new Map(planes.map((p) => [p.id, p]));
  const byFam = new Map(familias.map((f) => [f.id, { familia: f, alumnos: [], cuotas: [], comunicaciones: [], eventos: [], planes: [] }]));
  const cuotaById = new Map();

  for (const c of cuotas) {
    const plan = c.refinanciada_en ? planById.get(c.refinanciada_en) : null;
    c.refinanciada_fecha = plan ? plan.fecha : null;
    c.pagos = [];
    cuotaById.set(c.id, c);
    byFam.get(c.familia_id)?.cuotas.push(c);
  }
  for (const p of pagos) cuotaById.get(p.cuota_id)?.pagos.push(p);
  for (const a of alumnos) byFam.get(a.familia_id)?.alumnos.push(a);
  for (const m of comunicaciones) byFam.get(m.familia_id)?.comunicaciones.push(m);
  for (const e of eventos) byFam.get(e.familia_id)?.eventos.push(e);
  for (const p of planes) byFam.get(p.familia_id)?.planes.push(p);

  // Estado actual de cada cuota
  for (const c of cuotas) {
    const s = cuotaAt(c, hoy);
    c.pagado = Math.round(s.pagado);
    c.saldo = c.refinanciada_en ? 0 : Math.max(0, Math.round(c.monto - s.pagado));
    c.fecha_pago = c.refinanciada_en ? null : s.fechaPago;
    c.estado = c.refinanciada_en ? 'refinanciada'
      : s.cerrada ? 'pagada'
      : c.vencimiento < hoy ? 'vencida' : 'pendiente';
    c.atraso = c.estado === 'pendiente' ? 0 : s.atraso;
  }

  const ledger = { db, hoy, settings, umbrales, familias, alumnos, planes, cuotas, pagos, comunicaciones, eventos, byFam, cuotaById, planById };

  // Riesgo actual y resumen por familia
  for (const fam of byFam.values()) {
    const proxima = fam.cuotas.find((c) => c.estado === 'pendiente');
    fam.proxima = proxima || null;
    fam.riesgo = scoreFamily(fam, hoy, proxima ? proxima.vencimiento : null, umbrales);
    fam.deuda_vencida = fam.cuotas.filter((c) => c.estado === 'vencida').reduce((a, c) => a + c.saldo, 0);
    fam.max_atraso = Math.max(0, ...fam.cuotas.filter((c) => c.estado === 'vencida').map((c) => c.atraso));
    for (const p of fam.planes) Object.assign(p, planStatus(ledger, p));
  }
  return ledger;
}

function planStatus(ledger, plan) {
  const cs = ledger.cuotas.filter((c) => c.plan_id === plan.id);
  const pagadas = cs.filter((c) => c.estado === 'pagada').length;
  // Incumplido: una cuota del plan lleva más de 30 días impaga o tuvo que refinanciarse en otro plan.
  const atrasada = cs.some((c) => (c.estado === 'vencida' && c.atraso > 30) || c.estado === 'refinanciada');
  const estado = pagadas === cs.length && cs.length ? 'cumplido' : atrasada ? 'incumplido' : 'activo';
  const pagadoATiempo = cs.every((c) => c.estado === 'pagada' && c.atraso <= ATRASO_RELEVANTE);
  return { estado, cuotas_pagadas: pagadas, a_tiempo: estado === 'cumplido' && pagadoATiempo, saldo: cs.reduce((a, c) => a + c.saldo, 0) };
}

// ---- Escalera de cobranza (slides 8 y 9) ---------------------------------------

const ETAPAS = [
  { key: 'prevencion', label: 'Recordatorio preventivo', desde: null },
  { key: 'vencimiento', label: 'Vencimiento', desde: 0 },
  { key: 'contacto', label: 'Contacto personal', desde: 5 },
  { key: 'plan', label: 'Propuesta de plan de pagos', desde: 15 },
  { key: 'reunion', label: 'Reunión con dirección', desde: 30 },
];
const ETAPA_ORDEN = Object.fromEntries(ETAPAS.map((e, i) => [e.key, i]));
const ETAPA_LABEL = Object.fromEntries(ETAPAS.map((e) => [e.key, e.label]));
ETAPA_LABEL.manual = 'Contacto manual';

// Acción preventiva según nivel de riesgo (slide 8)
const PREVENCION = {
  bajo: { dias: 3, canal: 'mail', accion: 'Recordatorio estándar y pago online simple' },
  medio: { dias: 7, canal: 'whatsapp', accion: 'Aviso personalizado, opción de débito automático o de ajustar la fecha' },
  alto: { dias: 10, canal: 'llamada', accion: 'Contacto personal de administración y propuesta de plan de pagos a medida' },
};

function etapaPorAtraso(dias) {
  if (dias >= 30) return 'reunion';
  if (dias >= 15) return 'plan';
  if (dias >= 5) return 'contacto';
  return 'vencimiento';
}

function canalPara(etapa, nivel) {
  switch (etapa) {
    case 'prevencion': return PREVENCION[nivel].canal;
    case 'vencimiento': return nivel === 'bajo' ? 'mail' : 'whatsapp';
    case 'contacto': return 'whatsapp';
    case 'plan': return 'llamada';
    default: return 'reunion';
  }
}

const fmt$ = (n) => '$' + Math.round(n).toLocaleString('es-AR');
const fmtFecha = (iso) => iso.split('-').reverse().join('/');

function mensajeSugerido(etapa, fam, cuota, deuda, escuela) {
  const nombre = fam.familia.responsable.split(' ')[0];
  const link = `el portal de familias (código ${fam.familia.codigo_portal})`;
  switch (etapa) {
    case 'prevencion':
      return `Hola ${nombre}, te recordamos que el ${fmtFecha(cuota.vencimiento)} vence la cuota de ${cuota.concepto.toLowerCase()} por ${fmt$(cuota.saldo)}. Podés pagarla desde ${link}.` +
        (fam.riesgo.nivel !== 'bajo' ? ' Si te sirve, podemos adherirte al débito automático o ajustar la fecha de pago.' : '') + ` ${escuela}`;
    case 'vencimiento':
      return `Hola ${nombre}, hoy venció la cuota de ${cuota.concepto.toLowerCase()} por ${fmt$(cuota.saldo)}. Podés abonarla por transferencia, débito o desde ${link}. ¡Gracias! ${escuela}`;
    case 'contacto':
      return `Hola ${nombre}, ¿cómo estás? Vimos que quedó pendiente un saldo de ${fmt$(deuda)}. Queríamos saber si está todo bien y si podemos ayudarte con alguna opción de pago. ${escuela}`;
    case 'plan':
      return `Llamar a ${fam.familia.responsable}: deuda de ${fmt$(deuda)}. Proponer un plan de pagos a medida y dejar el acuerdo por escrito.`;
    default:
      return `Coordinar reunión con dirección y ${fam.familia.responsable} para buscar una solución conjunta (deuda de ${fmt$(deuda)}).`;
  }
}

/** Acciones pendientes de hoy: una por familia, la de la etapa más avanzada. */
function accionesPendientes(ledger) {
  const out = [];
  const escuela = ledger.settings.escuela_nombre;
  for (const fam of ledger.byFam.values()) {
    if (!fam.familia.activa) continue;
    const vencidas = fam.cuotas.filter((c) => c.estado === 'vencida');
    let accion = null;

    if (vencidas.length) {
      const masAntigua = vencidas[0];
      const etapa = etapaPorAtraso(masAntigua.atraso);
      // Hecha si ya hay una comunicación de esa etapa (o posterior) desde que venció la cuota más antigua.
      const hecha = fam.comunicaciones.some((m) => m.etapa !== 'manual' && ETAPA_ORDEN[m.etapa] >= ETAPA_ORDEN[etapa] && m.fecha >= masAntigua.vencimiento);
      if (!hecha) accion = { etapa, cuota: masAntigua, dias: masAntigua.atraso };
    } else if (fam.proxima) {
      const c = fam.proxima;
      const faltan = diffDays(c.vencimiento, ledger.hoy);
      const ventana = PREVENCION[fam.riesgo.nivel].dias;
      const hecha = fam.comunicaciones.some((m) => m.cuota_id === c.id && m.etapa === 'prevencion');
      if (faltan <= ventana && !hecha) accion = { etapa: 'prevencion', cuota: c, dias: -faltan };
    }
    if (!accion) continue;

    const deuda = fam.deuda_vencida || accion.cuota.saldo;
    out.push({
      familia_id: fam.familia.id,
      familia: `${fam.familia.apellido} (${fam.familia.responsable})`,
      email: fam.familia.email,
      telefono: fam.familia.telefono,
      riesgo: { puntaje: fam.riesgo.puntaje, nivel: fam.riesgo.nivel, motivo: fam.riesgo.motivo },
      etapa: accion.etapa,
      etapa_label: ETAPA_LABEL[accion.etapa],
      accion_preventiva: accion.etapa === 'prevencion' ? PREVENCION[fam.riesgo.nivel].accion : null,
      dias: accion.dias,
      cuota_id: accion.cuota.id,
      cuota: accion.cuota.concepto,
      vencimiento: accion.cuota.vencimiento,
      deuda,
      canal: canalPara(accion.etapa, fam.riesgo.nivel),
      mensaje: mensajeSugerido(accion.etapa, fam, accion.cuota, deuda, escuela),
    });
  }
  // Primero lo más avanzado de la escalera; dentro de cada etapa, mayor riesgo primero.
  out.sort((a, b) => ETAPA_ORDEN[b.etapa] - ETAPA_ORDEN[a.etapa] || b.riesgo.puntaje - a.riesgo.puntaje);
  return out;
}

// ---- Indicadores (slide 10) ---------------------------------------------------

function periodosRecientes(ledger, n) {
  const ps = [...new Set(ledger.cuotas.filter((c) => !c.plan_id && c.vencimiento <= ledger.hoy).map((c) => c.periodo))].sort();
  return ps.slice(-n);
}

function serieMensual(ledger, n = 12) {
  return periodosRecientes(ledger, n).map((periodo) => {
    const cs = ledger.cuotas.filter((c) => c.periodo === periodo && !c.plan_id);
    const facturado = cs.reduce((a, c) => a + c.monto, 0);
    let enTermino = 0, conAtraso = 0, impago = 0, mora30 = 0;
    for (const c of cs) {
      if (c.estado === 'pagada' && c.atraso === 0) enTermino += c.monto;
      else if (c.estado === 'pagada') conAtraso += c.monto;
      else if (c.estado === 'refinanciada') impago += c.monto;
      else { conAtraso += c.pagado; impago += c.saldo; }
      if (c.atraso > 30) mora30 += c.monto;
    }
    return { periodo, facturado, en_termino: enTermino, con_atraso: conAtraso, impago, tasa_mora: facturado ? mora30 / facturado : 0 };
  });
}

function precisionAlertas(ledger, meses = 6) {
  // Para cada cuota con resultado conocido, se recalcula el puntaje con los datos
  // disponibles 10 días antes del vencimiento y se compara con lo que pasó.
  const limite = addDays(ledger.hoy, -(ATRASO_RELEVANTE + 1));
  const desde = addDays(ledger.hoy, -31 * meses);
  let alertas = 0, aciertos = 0, atrasos = 0, detectados = 0;
  for (const fam of ledger.byFam.values()) {
    for (const c of fam.cuotas) {
      if (c.plan_id || c.vencimiento > limite || c.vencimiento < desde) continue;
      const r = scoreFamily(fam, addDays(c.vencimiento, -ATRASO_RELEVANTE), c.vencimiento, ledger.umbrales);
      const s = cuotaAt(c, addDays(c.vencimiento, ATRASO_RELEVANTE + 1));
      const seAtraso = !s.cerrada || s.atraso > ATRASO_RELEVANTE;
      if (r.nivel === 'alto') { alertas++; if (seAtraso) aciertos++; }
      if (seAtraso) { atrasos++; if (r.nivel === 'alto') detectados++; }
    }
  }
  return {
    precision: alertas ? aciertos / alertas : null,
    cobertura: atrasos ? detectados / atrasos : null,
    alertas, aciertos, atrasos, detectados,
  };
}

function recuperoPorEtapa(ledger, meses = 12) {
  // Se atribuye cada cuota cobrada fuera de término a la última etapa de la escalera
  // ejecutada antes del pago.
  const desde = addDays(ledger.hoy, -31 * meses);
  const res = Object.fromEntries(ETAPAS.filter((e) => e.key !== 'prevencion').map((e) => [e.key, { etapa: e.key, label: e.label, monto: 0, cuotas: 0 }]));
  res.sin_gestion = { etapa: 'sin_gestion', label: 'Sin gestión', monto: 0, cuotas: 0 };
  let deudaGenerada = 0;
  for (const fam of ledger.byFam.values()) {
    for (const c of fam.cuotas) {
      if (c.vencimiento < desde || c.atraso === 0 || c.estado === 'pendiente') continue;
      deudaGenerada += c.monto;
      if (c.estado !== 'pagada') continue;
      const previas = fam.comunicaciones.filter((m) => m.estado === 'enviada' && m.etapa !== 'prevencion' && m.etapa !== 'manual' && m.fecha >= c.vencimiento && m.fecha <= c.fecha_pago);
      const ultima = previas.sort((a, b) => ETAPA_ORDEN[b.etapa] - ETAPA_ORDEN[a.etapa])[0];
      const k = ultima ? ultima.etapa : 'sin_gestion';
      res[k].monto += c.monto;
      res[k].cuotas++;
    }
  }
  const lista = Object.values(res);
  for (const r of lista) r.pct = deudaGenerada ? r.monto / deudaGenerada : 0;
  return lista;
}

function dashboard(ledger) {
  const activas = [...ledger.byFam.values()].filter((f) => f.familia.activa);
  // Tasa de morosidad: de lo facturado en los últimos 12 meses, qué parte superó los 30 días
  // de atraso (pagada tarde, refinanciada o todavía impaga).
  const exigibleDesde = addDays(ledger.hoy, -365);
  const exigibles = ledger.cuotas.filter((c) => !c.plan_id && c.estado !== 'pendiente' && c.vencimiento >= exigibleDesde);
  const carteraExigible = exigibles.reduce((a, c) => a + c.monto, 0);
  const montoMora30 = exigibles.filter((c) => c.atraso > 30).reduce((a, c) => a + c.monto, 0);
  const vencidas = ledger.cuotas.filter((c) => c.estado === 'vencida');
  const mora30 = vencidas.filter((c) => c.atraso > 30).reduce((a, c) => a + c.saldo, 0);
  const familiasMora30 = new Set(vencidas.filter((c) => c.atraso > 30).map((c) => c.familia_id)).size;

  const desde6 = addDays(ledger.hoy, -183);
  const pagadas6 = ledger.cuotas.filter((c) => c.estado === 'pagada' && c.fecha_pago >= desde6 && !c.plan_id);
  const diasProm = pagadas6.length ? pagadas6.reduce((a, c) => a + c.atraso, 0) / pagadas6.length : 0;

  const enRiesgoAlto = activas.filter((f) => f.riesgo.nivel === 'alto');
  const carteraRiesgo = enRiesgoAlto.reduce((a, f) => a + (f.proxima ? f.proxima.saldo : 0) + f.deuda_vencida, 0);

  const planesCerrados = ledger.planes.filter((p) => p.estado !== 'activo');
  const planesCumplidos = planesCerrados.filter((p) => p.estado === 'cumplido').length;

  const niveles = { bajo: 0, medio: 0, alto: 0 };
  for (const f of activas) niveles[f.riesgo.nivel]++;

  return {
    hoy: ledger.hoy,
    escuela: ledger.settings.escuela_nombre,
    familias: activas.length,
    alumnos: ledger.alumnos.filter((a) => a.activo).length,
    kpis: {
      tasa_morosidad: { valor: carteraExigible ? montoMora30 / carteraExigible : 0, deuda_actual_30: mora30, familias: familiasMora30 },
      dias_atraso: { valor: diasProm, cuotas: pagadas6.length },
      cartera_riesgo: { valor: carteraRiesgo, familias: enRiesgoAlto.length },
      recupero: recuperoPorEtapa(ledger),
      precision: precisionAlertas(ledger),
      planes: { valor: planesCerrados.length ? planesCumplidos / planesCerrados.length : null, cumplidos: planesCumplidos, cerrados: planesCerrados.length, activos: ledger.planes.length - planesCerrados.length },
    },
    deuda_vencida_total: vencidas.reduce((a, c) => a + c.saldo, 0),
    niveles,
    serie: serieMensual(ledger),
    acciones_pendientes: accionesPendientes(ledger).length,
    solicitudes_pendientes: ledger.eventos.filter((e) => e.tipo === 'solicitud_plan' && !e.atendido).length,
    top_riesgo: activas
      .filter((f) => f.riesgo.nivel !== 'bajo')
      .sort((a, b) => b.riesgo.puntaje - a.riesgo.puntaje)
      .slice(0, 8)
      .map((f) => resumenFamilia(f)),
  };
}

function resumenFamilia(fam) {
  return {
    id: fam.familia.id,
    apellido: fam.familia.apellido,
    responsable: fam.familia.responsable,
    email: fam.familia.email,
    telefono: fam.familia.telefono,
    medio_pago: fam.familia.medio_pago,
    activa: fam.familia.activa,
    alumnos: fam.alumnos.filter((a) => a.activo).map((a) => `${a.nombre} (${a.grado}°)`),
    riesgo: { puntaje: fam.riesgo.puntaje, nivel: fam.riesgo.nivel, motivo: fam.riesgo.motivo, motivo_detalle: fam.riesgo.motivo_detalle },
    deuda_vencida: fam.deuda_vencida,
    max_atraso: fam.max_atraso,
    proximo_vencimiento: fam.proxima ? fam.proxima.vencimiento : null,
    plan_activo: fam.planes.some((p) => p.estado === 'activo'),
  };
}

function detalleFamilia(ledger, id) {
  const fam = ledger.byFam.get(id);
  if (!fam) return null;
  const strip = ({ pagos, refinanciada_fecha, ...c }) => c;
  return {
    familia: fam.familia,
    alumnos: fam.alumnos,
    resumen: resumenFamilia(fam),
    riesgo: fam.riesgo,
    prevencion: PREVENCION[fam.riesgo.nivel],
    cuotas: fam.cuotas.map(strip).reverse(),
    pagos: fam.cuotas.flatMap((c) => c.pagos.map((p) => ({ ...p, concepto: c.concepto }))).sort((a, b) => b.fecha.localeCompare(a.fecha)),
    comunicaciones: fam.comunicaciones.map((m) => ({ ...m, etapa_label: ETAPA_LABEL[m.etapa] || m.etapa })),
    eventos: fam.eventos,
    planes: fam.planes,
    historial_riesgo: historialRiesgo(ledger, fam),
  };
}

function historialRiesgo(ledger, fam) {
  return fam.cuotas
    .filter((c) => !c.plan_id && c.vencimiento <= addDays(ledger.hoy, 40))
    .slice(-10)
    .map((c) => {
      const r = scoreFamily(fam, addDays(c.vencimiento, -ATRASO_RELEVANTE), c.vencimiento, ledger.umbrales);
      return { periodo: c.periodo, puntaje: r.puntaje, nivel: r.nivel, atraso: c.estado === 'pendiente' ? null : c.atraso };
    });
}

module.exports = {
  loadLedger, accionesPendientes, dashboard, resumenFamilia, detalleFamilia, planStatus,
  serieMensual, precisionAlertas, recuperoPorEtapa,
  ETAPAS, ETAPA_LABEL, PREVENCION,
};
