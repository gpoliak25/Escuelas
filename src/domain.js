'use strict';
const { getSettings, today, diffDays, addDays } = require('./db');
const { scoreFamily, cuotaAt, ATRASO_RELEVANTE } = require('./risk');
const { numeroRecibo, liquidarRecargos } = require('./cobranzas');

const BASE = new Set(['arancel', 'plan']); // cargos que miden el comportamiento de pago
const MEDIO_LBL = { efectivo: 'Efectivo', transferencia: 'Transferencia', debito: 'Débito automático', tarjeta: 'Tarjeta', online: 'Pago online', cheque: 'Cheque', nota_credito: 'Nota de crédito' };
const DIAS_GRACIA_PROMESA = 2;

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
  const cobros = db.prepare('SELECT * FROM cobros WHERE fecha <= ? ORDER BY fecha DESC, id DESC').all(hoy);
  const promesas = db.prepare('SELECT * FROM promesas WHERE anulada = 0 AND fecha_registro <= ? ORDER BY fecha_promesa DESC').all(hoy);

  const planById = new Map(planes.map((p) => [p.id, p]));
  const byFam = new Map(familias.map((f) => [f.id, { familia: f, alumnos: [], cuotas: [], comunicaciones: [], eventos: [], planes: [], cobros: [], promesas: [] }]));
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
  for (const c of cobros) byFam.get(c.familia_id)?.cobros.push(c);
  for (const p of promesas) byFam.get(p.familia_id)?.promesas.push(p);

  // Saldo a favor: lo cobrado que no se imputó a ningún cargo
  const imputado = new Map();
  for (const p of pagos) if (p.cobro_id && !p.rechazado) imputado.set(p.cobro_id, (imputado.get(p.cobro_id) || 0) + p.monto);
  for (const c of cobros) {
    c.comprobante = numeroRecibo(db, c.numero, c.tipo);
    c.imputado = Math.round(imputado.get(c.id) || 0);
    c.a_favor = c.estado === 'vigente' ? Math.max(0, Math.round(c.monto - c.imputado)) : 0;
  }

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

  const ledger = { db, hoy, settings, umbrales, familias, alumnos, planes, cuotas, pagos, comunicaciones, eventos, cobros, promesas, byFam, cuotaById, planById };

  // Riesgo actual y resumen por familia
  for (const fam of byFam.values()) {
    const proxima = fam.cuotas.find((c) => c.estado === 'pendiente' && c.tipo !== 'recargo');
    fam.proxima = proxima || null;
    fam.riesgo = scoreFamily(fam, hoy, proxima ? proxima.vencimiento : null, umbrales);
    fam.deuda_vencida = fam.cuotas.filter((c) => c.estado === 'vencida').reduce((a, c) => a + c.saldo, 0);
    fam.max_atraso = Math.max(0, ...fam.cuotas.filter((c) => c.estado === 'vencida').map((c) => c.atraso));
    for (const p of fam.planes) Object.assign(p, planStatus(ledger, p));
    fam.deuda_recargos = fam.cuotas.filter((c) => c.estado === 'vencida' && c.tipo === 'recargo').reduce((a, c) => a + c.saldo, 0);
    fam.saldo_a_favor = fam.cobros.reduce((a, c) => a + c.a_favor, 0);
    for (const p of fam.promesas) Object.assign(p, promesaStatus(ledger, fam, p));
    fam.promesa = fam.promesas.find((p) => p.estado === 'pendiente') || null;
    fam.ultimo_cobro = fam.cobros.find((c) => c.estado === 'vigente' && c.tipo === 'recibo')?.fecha || null;
  }
  return ledger;
}

/** Una promesa se cumple si entre su registro y la fecha prometida (+2 días) se cobró el monto. */
function promesaStatus(ledger, fam, p) {
  const limite = addDays(p.fecha_promesa, DIAS_GRACIA_PROMESA);
  const cobrado = fam.cobros
    .filter((c) => c.estado === 'vigente' && c.tipo === 'recibo' && c.fecha >= p.fecha_registro && c.fecha <= limite)
    .reduce((a, c) => a + c.monto, 0);
  const estado = cobrado >= p.monto - 1 ? 'cumplida' : ledger.hoy > limite ? 'incumplida' : 'pendiente';
  return { estado, cobrado: Math.round(cobrado) };
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
ETAPA_LABEL.promesa = 'Promesa incumplida';
ETAPA_ORDEN.promesa = ETAPA_ORDEN.contacto;

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
    case 'promesa': return 'llamada';
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
    case 'promesa': {
      const p = fam.promesas.find((x) => x.estado === 'incumplida');
      return 'Llamar a ' + fam.familia.responsable + ': no se registró el pago de ' + fmt$(p.monto) + ' prometido para el ' + fmtFecha(p.fecha_promesa) +
        '. Deuda actual: ' + fmt$(deuda) + '. Acordar una nueva fecha o un plan de pagos.';
    }
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
    // Promesa incumplida sin seguimiento posterior: se llama primero.
    const incumplida = fam.promesas.find((p) => p.estado === 'incumplida');
    const seguida = incumplida && fam.comunicaciones.some((m) => m.fecha > addDays(incumplida.fecha_promesa, DIAS_GRACIA_PROMESA));

    if (fam.promesa) {
      continue; // promesa de pago vigente: la gestión queda en pausa hasta su fecha
    } else if (vencidas.length && incumplida && !seguida) {
      accion = { etapa: 'promesa', cuota: vencidas[0], dias: vencidas[0].atraso };
    } else if (vencidas.length) {
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
      deuda_recargos: fam.deuda_recargos,
      saldo_a_favor: fam.saldo_a_favor,
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
  const ps = [...new Set(ledger.cuotas.filter((c) => c.tipo === 'arancel' && c.vencimiento <= ledger.hoy).map((c) => c.periodo))].sort();
  return ps.slice(-n);
}

function serieMensual(ledger, n = 12) {
  return periodosRecientes(ledger, n).map((periodo) => {
    const cs = ledger.cuotas.filter((c) => c.periodo === periodo && c.tipo === 'arancel');
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
      if (c.tipo !== 'arancel' || c.vencimiento > limite || c.vencimiento < desde) continue;
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
      if (!BASE.has(c.tipo) || c.vencimiento < desde || c.atraso === 0 || c.estado === 'pendiente') continue;
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
  const exigibles = ledger.cuotas.filter((c) => c.tipo === 'arancel' && c.estado !== 'pendiente' && c.vencimiento >= exigibleDesde);
  const carteraExigible = exigibles.reduce((a, c) => a + c.monto, 0);
  const montoMora30 = exigibles.filter((c) => c.atraso > 30).reduce((a, c) => a + c.monto, 0);
  const vencidas = ledger.cuotas.filter((c) => c.estado === 'vencida');
  const mora30 = vencidas.filter((c) => c.atraso > 30).reduce((a, c) => a + c.saldo, 0);
  const familiasMora30 = new Set(vencidas.filter((c) => c.atraso > 30).map((c) => c.familia_id)).size;

  const desde6 = addDays(ledger.hoy, -183);
  const pagadas6 = ledger.cuotas.filter((c) => c.estado === 'pagada' && c.fecha_pago >= desde6 && c.tipo === 'arancel');
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
    cobranza: gestionCobranza(ledger),
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
    deuda_recargos: fam.deuda_recargos,
    saldo_a_favor: fam.saldo_a_favor,
    promesa: fam.promesa ? { fecha: fam.promesa.fecha_promesa, monto: fam.promesa.monto } : null,
    ultimo_cobro: fam.ultimo_cobro,
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
    cobros: fam.cobros.map((c) => ({ ...c, medio_label: MEDIO_LBL[c.medio] || c.medio })),
    promesas: fam.promesas,
    saldo_a_favor: fam.saldo_a_favor,
    cuenta_corriente: cuentaCorriente(ledger, fam),
    // Cargos con saldo, en el orden en que se imputan los cobros (el más antiguo primero)
    abiertas: fam.cuotas.filter((c) => c.saldo > 0)
      .map(({ pagos, refinanciada_fecha, ...c }) => ({ ...c, orden: c.origen_id ? ledger.cuotaById.get(c.origen_id)?.vencimiento || c.vencimiento : c.vencimiento }))
      .sort((a, b) => a.orden.localeCompare(b.orden) || (a.tipo === 'recargo') - (b.tipo === 'recargo') || a.id - b.id),
  };
}

function historialRiesgo(ledger, fam) {
  return fam.cuotas
    .filter((c) => c.tipo === 'arancel' && c.vencimiento <= addDays(ledger.hoy, 40))
    .slice(-10)
    .map((c) => {
      const r = scoreFamily(fam, addDays(c.vencimiento, -ATRASO_RELEVANTE), c.vencimiento, ledger.umbrales);
      return { periodo: c.periodo, puntaje: r.puntaje, nivel: r.nivel, atraso: c.estado === 'pendiente' ? null : c.atraso };
    });
}

// ---- Gestión de cobranzas ------------------------------------------------------

/** Cuenta corriente al día: cargos vencidos al debe; cobros, notas de crédito y refinanciaciones al haber. */
function cuentaCorriente(ledger, fam) {
  const movs = [];
  for (const c of fam.cuotas) {
    if (c.vencimiento > ledger.hoy) continue;
    movs.push({ fecha: c.vencimiento, tipo: c.tipo, concepto: c.concepto, debe: c.monto, haber: 0, cuota_id: c.id, orden: 0 });
  }
  for (const p of fam.planes) {
    const refinanciado = fam.cuotas.filter((c) => c.refinanciada_en === p.id).reduce((a, c) => a + (c.monto - c.pagado), 0);
    if (refinanciado > 0) movs.push({ fecha: p.fecha, tipo: 'refinanciacion', concepto: `Deuda refinanciada en el plan de pagos #${p.id}`, debe: 0, haber: Math.round(refinanciado), orden: 1 });
  }
  for (const c of fam.cobros) {
    if (c.estado !== 'vigente') continue;
    const concepto = c.tipo === 'nota_credito' ? `Nota de crédito ${c.comprobante} · ${c.motivo}` : `Recibo ${c.comprobante} · ${MEDIO_LBL[c.medio] || c.medio}`;
    movs.push({ fecha: c.fecha, tipo: c.tipo, concepto, debe: 0, haber: c.monto, cobro_id: c.id, orden: 1 });
  }
  movs.sort((a, b) => a.fecha.localeCompare(b.fecha) || a.orden - b.orden);
  let saldo = 0;
  for (const m of movs) { saldo += m.debe - m.haber; m.saldo = Math.round(saldo); delete m.orden; }
  const aVencer = fam.cuotas.filter((c) => c.vencimiento > ledger.hoy && c.saldo > 0)
    .map((c) => ({ fecha: c.vencimiento, concepto: c.concepto, monto: c.monto, saldo: c.saldo, tipo: c.tipo }));
  return { movimientos: movs.reverse(), saldo: Math.round(saldo), a_vencer: aVencer };
}

const TRAMOS = [
  { key: 'd1_30', label: '1 a 30 días', hasta: 30 },
  { key: 'd31_60', label: '31 a 60 días', hasta: 60 },
  { key: 'd61_90', label: '61 a 90 días', hasta: 90 },
  { key: 'd90', label: 'Más de 90 días', hasta: Infinity },
];

/** Deudores por antigüedad de la deuda. */
function deudores(ledger) {
  const filas = [];
  const detalle = []; // cada cargo vencido, para ver la composición de cada tramo
  for (const fam of ledger.byFam.values()) {
    const t = { a_vencer: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 };
    for (const c of fam.cuotas) {
      if (c.saldo <= 0 || c.estado === 'refinanciada') continue;
      if (c.estado === 'pendiente') { t.a_vencer += c.saldo; continue; }
      const tramo = TRAMOS.find((x) => c.atraso <= x.hasta).key;
      t[tramo] += c.saldo;
      detalle.push({
        tramo, familia_id: fam.familia.id, familia: fam.familia.apellido, responsable: fam.familia.responsable,
        concepto: c.concepto, tipo: c.tipo, vencimiento: c.vencimiento, atraso: c.atraso, monto: c.monto, saldo: c.saldo,
      });
    }
    const vencido = t.d1_30 + t.d31_60 + t.d61_90 + t.d90;
    if (!vencido) continue;
    filas.push({ ...resumenFamilia(fam), ...t, vencido });
  }
  filas.sort((a, b) => b.vencido - a.vencido);
  const totales = { familias: filas.length };
  for (const k of ['a_vencer', 'd1_30', 'd31_60', 'd61_90', 'd90', 'vencido', 'deuda_recargos', 'saldo_a_favor']) totales[k] = filas.reduce((a, f) => a + f[k], 0);
  detalle.sort((a, b) => b.atraso - a.atraso || a.familia.localeCompare(b.familia, 'es'));
  return { hoy: ledger.hoy, tramos: TRAMOS.map(({ key, label }) => ({ key, label })), filas, totales, detalle };
}

/** Cobros de un período: el libro de caja. */
function caja(ledger, { desde, hasta, medio } = {}) {
  const lista = ledger.cobros
    .filter((c) => c.fecha >= desde && c.fecha <= hasta && (!medio || c.medio === medio))
    .map((c) => {
      const f = ledger.byFam.get(c.familia_id)?.familia;
      const imputaciones = ledger.pagos.filter((p) => p.cobro_id === c.id)
        .map((p) => ({ concepto: ledger.cuotaById.get(p.cuota_id)?.concepto, monto: p.monto, rechazado: p.rechazado }));
      return { ...c, familia: f?.apellido, responsable: f?.responsable, medio_label: MEDIO_LBL[c.medio] || c.medio, imputaciones };
    });
  const vigentes = lista.filter((c) => c.estado === 'vigente' && c.tipo === 'recibo');
  const porMedio = {};
  for (const c of vigentes) porMedio[c.medio] = (porMedio[c.medio] || 0) + c.monto;
  const porDia = {};
  for (const c of vigentes) porDia[c.fecha] = (porDia[c.fecha] || 0) + c.monto;
  const suma = (arr) => arr.reduce((a, c) => a + c.monto, 0);
  return {
    hoy: ledger.hoy, desde, hasta, medio: medio || '',
    cobros: lista,
    totales: {
      cobrado: suma(vigentes),
      recibos: vigentes.length,
      notas_credito: suma(lista.filter((c) => c.estado === 'vigente' && c.tipo === 'nota_credito')),
      anulados: lista.filter((c) => c.estado === 'anulado').length,
      rechazados: lista.filter((c) => c.estado === 'rechazado').length,
      monto_rechazado: suma(lista.filter((c) => c.estado === 'rechazado')),
    },
    por_medio: Object.entries(porMedio).map(([k, v]) => ({ medio: k, label: MEDIO_LBL[k] || k, monto: v })).sort((a, b) => b.monto - a.monto),
    por_dia: Object.entries(porDia).map(([fecha, monto]) => ({ fecha, monto })).sort((a, b) => a.fecha.localeCompare(b.fecha)),
  };
}

/** Indicadores de gestión del mes para el tablero. */
function gestionCobranza(ledger) {
  const mes = ledger.hoy.slice(0, 7);
  const recibosMes = ledger.cobros.filter((c) => c.estado === 'vigente' && c.tipo === 'recibo' && c.fecha.startsWith(mes));
  // Efectividad: del último período de aranceles ya vencido, qué parte se cobró.
  const periodo = periodosRecientes(ledger, 1)[0];
  const delPeriodo = ledger.cuotas.filter((c) => c.tipo === 'arancel' && c.periodo === periodo);
  const facturado = delPeriodo.reduce((a, c) => a + c.monto, 0);
  const cobrado = delPeriodo.reduce((a, c) => a + (c.estado === 'refinanciada' ? 0 : c.pagado), 0);
  const fams = [...ledger.byFam.values()];
  const promesas = fams.flatMap((f) => f.promesas);
  return {
    cobrado_mes: recibosMes.reduce((a, c) => a + c.monto, 0),
    recibos_mes: recibosMes.length,
    efectividad: { periodo, valor: facturado ? cobrado / facturado : null, facturado, cobrado },
    saldo_a_favor: fams.reduce((a, f) => a + f.saldo_a_favor, 0),
    deuda_recargos: fams.reduce((a, f) => a + f.deuda_recargos, 0),
    promesas_pendientes: promesas.filter((p) => p.estado === 'pendiente').length,
    promesas_incumplidas: promesas.filter((p) => p.estado === 'incumplida' && p.fecha_promesa >= addDays(ledger.hoy, -60)).length,
    rechazos_mes: ledger.cobros.filter((c) => c.estado === 'rechazado' && c.fecha.startsWith(mes)).length,
    recargos_por_liquidar: liquidarRecargos(ledger.db, { simular: true }).creados,
  };
}

const ORDEN_PROMESA = { pendiente: 0, incumplida: 1, cumplida: 2 };

/** Promesas de pago de todas las familias: primero las pendientes, después las incumplidas. */
function promesasListado(ledger) {
  return [...ledger.byFam.values()]
    .flatMap((f) => f.promesas.map((p) => ({ ...p, familia: f.familia.apellido, responsable: f.familia.responsable, deuda: f.deuda_vencida })))
    .sort((a, b) => ORDEN_PROMESA[a.estado] - ORDEN_PROMESA[b.estado] || b.fecha_promesa.localeCompare(a.fecha_promesa));
}

module.exports = {
  cuentaCorriente, deudores, caja, gestionCobranza, promesasListado, MEDIO_LBL,
  loadLedger, accionesPendientes, dashboard, resumenFamilia, detalleFamilia, planStatus,
  serieMensual, precisionAlertas, recuperoPorEtapa,
  ETAPAS, ETAPA_LABEL, PREVENCION,
};
