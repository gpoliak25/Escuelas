'use strict';
// Datos de demostración: una escuela con ~64 familias y un año y medio de historia,
// con perfiles de pago variados para que el motor de riesgo tenga algo que mostrar.
// Todos los nombres y contactos son ficticios.
const db_ = require('./db');
const { isoToday, addDays, diffDays, getSettings, setSettings, tx } = db_;
const { montoFamilia, conceptoArancel, nuevoCodigoPortal } = require('./services');
const C = require('./cobranzas');

const APELLIDOS = ['González', 'Rodríguez', 'Fernández', 'López', 'Martínez', 'Pérez', 'Gómez', 'Díaz', 'Sánchez', 'Romero',
  'Sosa', 'Álvarez', 'Torres', 'Ruiz', 'Ramírez', 'Flores', 'Acosta', 'Benítez', 'Medina', 'Suárez', 'Herrera', 'Aguirre',
  'Pereyra', 'Gutiérrez', 'Giménez', 'Molina', 'Silva', 'Castro', 'Rojas', 'Ortiz', 'Núñez', 'Luna', 'Juárez', 'Cabrera',
  'Ríos', 'Ferreyra', 'Godoy', 'Morales', 'Domínguez', 'Moreno', 'Peralta', 'Vega', 'Carrizo', 'Quiroga', 'Castillo',
  'Ledesma', 'Muñoz', 'Ojeda', 'Ponce', 'Vera', 'Vázquez', 'Villalba', 'Cardozo', 'Navarro', 'Ramos', 'Arias', 'Coronel',
  'Córdoba', 'Figueroa', 'Correa', 'Cáceres', 'Vargas', 'Maldonado', 'Mendoza', 'Blanco', 'Bustos', 'Paz', 'Miranda'];
const ADULTOS = ['María', 'Laura', 'Carolina', 'Paula', 'Florencia', 'Natalia', 'Valeria', 'Lucía', 'Andrea', 'Silvina',
  'Juan', 'Martín', 'Pablo', 'Diego', 'Sebastián', 'Gustavo', 'Federico', 'Alejandro', 'Hernán', 'Marcelo'];
const CHICOS = ['Sofía', 'Valentina', 'Isabella', 'Emma', 'Martina', 'Catalina', 'Olivia', 'Mía', 'Delfina', 'Julia',
  'Mateo', 'Benjamín', 'Thiago', 'Santiago', 'Bautista', 'Joaquín', 'Felipe', 'Lautaro', 'Tomás', 'Lorenzo', 'Facundo', 'Juana'];

const NENAS = new Set(['Sofía', 'Valentina', 'Isabella', 'Emma', 'Martina', 'Catalina', 'Olivia', 'Mía', 'Delfina', 'Julia', 'Juana']);
const DOCENTES = ['Graciela Ferrari', 'Mónica Sanz', 'Adriana Leiva', 'Claudia Ibarra', 'Roxana Quintana', 'Patricia Olmos',
  'Daniel Avellaneda', 'Verónica Bravo', 'Cecilia Toledo', 'Sergio Robledo'];

const PERFILES = { puntual: 32, justo: 11, corto: 11, problema: 6, deteriora: 4 };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function slug(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z]/g, '');
}

/** Períodos del ciclo lectivo (marzo a diciembre) desde ~19 meses atrás hasta el mes siguiente. */
function periodosDemo(hoy) {
  const [y, m] = hoy.split('-').map(Number);
  const out = [];
  for (let k = -19; k <= 1; k++) {
    const d = new Date(Date.UTC(y, m - 1 + k, 1));
    const mes = d.getUTCMonth() + 1;
    if (mes >= 3) out.push(`${d.getUTCFullYear()}-${String(mes).padStart(2, '0')}`);
  }
  return out;
}

function seed(db, { seed: semilla = 42 } = {}) {
  const rnd = mulberry32(semilla);
  // Generador aparte para los datos escolares: así no cambia la historia de pagos.
  const rnd2 = mulberry32(semilla + 1000);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const chance = (p) => rnd() < p;
  const hoy = isoToday();

  tx(db, () => {
    for (const t of ['asistencia', 'pagos', 'cobros', 'promesas', 'lotes_debito', 'comunicaciones', 'eventos', 'cuotas', 'planes', 'alumnos', 'familias', 'cursos']) db.exec(`DELETE FROM ${t}`);
    setSettings(db, { fecha_simulada: '' });
  });
  const settings = getSettings(db);
  const dia = String(Number(settings.dia_vencimiento) || 15).padStart(2, '0');
  const periodos = periodosDemo(hoy);

  const perfiles = Object.entries(PERFILES).flatMap(([p, n]) => Array(n).fill(p));
  for (let i = perfiles.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perfiles[i], perfiles[j]] = [perfiles[j], perfiles[i]]; }

  // Cursos: 1° a 3° con dos secciones (A mañana, B tarde); 4° a 7° con una.
  const ciclo = Number(hoy.slice(0, 4));
  const insCurso = db.prepare('INSERT INTO cursos (grado, seccion, turno, docente, capacidad) VALUES (?, ?, ?, ?, ?)');
  let doc = 0;
  for (let g = 1; g <= 7; g++) {
    insCurso.run(g, 'A', 'mañana', DOCENTES[doc++ % DOCENTES.length], g <= 3 ? 12 : 20);
    if (g <= 3) insCurso.run(g, 'B', 'tarde', DOCENTES[doc++ % DOCENTES.length], 12);
  }
  const dnis = new Set();
  function datosEscolares(nombre, grado) {
    const nac = `${ciclo - grado - 5}-${String(1 + Math.floor(rnd2() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd2() * 28)).padStart(2, '0')}`;
    let dni;
    do { dni = String(44000000 + (ciclo - grado - 5 - 2012) * 1300000 + Math.floor(rnd2() * 1200000)); } while (dnis.has(dni));
    dnis.add(dni);
    const pase = grado > 1 && rnd2() < 0.15;
    const anioIngreso = pase ? ciclo - Math.floor(rnd2() * (grado - 1)) : ciclo - (grado - 1);
    let ingreso = pase ? `${anioIngreso}-0${3 + Math.floor(rnd2() * 5)}-${String(1 + Math.floor(rnd2() * 28)).padStart(2, '0')}` : `${anioIngreso}-03-01`;
    if (ingreso > hoy) ingreso = `${anioIngreso}-03-01`;
    return {
      dni, nac, ingreso,
      genero: NENAS.has(nombre) ? 'F' : 'M',
      seccion: grado <= 3 && rnd2() < 0.5 ? 'B' : 'A',
    };
  }

  const apellidos = [...APELLIDOS].sort(() => rnd() - 0.5);
  const q = {
    fam: db.prepare(`INSERT INTO familias (apellido, responsable, email, telefono, medio_pago, codigo_portal, consentimiento, notas, creada)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    alu: db.prepare(`INSERT INTO alumnos (familia_id, nombre, apellido, grado, beca_pct, dni, fecha_nacimiento, genero, seccion, fecha_ingreso)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    cuota: db.prepare('INSERT INTO cuotas (familia_id, periodo, concepto, monto, vencimiento, plan_id, plan_nro) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    pago: db.prepare('INSERT INTO pagos (familia_id, cuota_id, fecha, monto, medio, rechazado) VALUES (?, ?, ?, ?, ?, ?)'),
    com: db.prepare(`INSERT INTO comunicaciones (familia_id, cuota_id, fecha, canal, etapa, mensaje, estado, abierto, respondido)
      VALUES (?, ?, ?, ?, ?, ?, 'enviada', ?, ?)`),
    ev: db.prepare('INSERT INTO eventos (familia_id, fecha, tipo, detalle, atendido) VALUES (?, ?, ?, ?, ?)'),
    plan: db.prepare('INSERT INTO planes (familia_id, fecha, monto_total, cuotas_n, nota) VALUES (?, ?, ?, ?, ?)'),
    refi: db.prepare('UPDATE cuotas SET refinanciada_en = ? WHERE id = ?'),
    medio: db.prepare('UPDATE familias SET medio_pago = ? WHERE id = ?'),
  };

  // Comunicaciones simuladas de la escalera. Las de los últimos 3 días se dejan sin hacer
  // para que la bandeja de cobranza tenga trabajo pendiente.
  const corteComs = addDays(hoy, -3);
  function simularComs(famId, cuotaId, venc, hasta, perfil, abreP, lead) {
    const canalPrev = lead >= 10 ? 'llamada' : lead >= 7 ? 'whatsapp' : 'mail';
    const etapas = [
      ['prevencion', addDays(venc, -lead), canalPrev, 'Recordatorio de vencimiento'],
      ['vencimiento', venc, perfil === 'puntual' ? 'mail' : 'whatsapp', 'Aviso de vencimiento'],
      ['contacto', addDays(venc, 5), 'whatsapp', 'Mensaje personal de administración'],
      ['plan', addDays(venc, 15), 'llamada', 'Propuesta de plan de pagos'],
      ['reunion', addDays(venc, 30), 'reunion', 'Reunión con dirección'],
    ];
    // Si la cuota sigue impaga, la última etapa que correspondía suele quedar pendiente.
    const elegibles = etapas.filter(([, f]) => f <= corteComs && f <= hasta);
    if (hasta === hoy && elegibles.length && chance(0.75)) elegibles.pop();
    for (const [etapa, f, canal, msg] of elegibles) {
      if (etapa === 'vencimiento' && hasta <= venc && f >= hasta) continue; // pagó antes del vencimiento
      const directo = canal === 'llamada' || canal === 'reunion';
      const abierto = directo || chance(abreP) ? 1 : 0;
      q.com.run(famId, cuotaId, f, canal, etapa, msg, abierto, abierto && chance(0.3) ? 1 : 0);
    }
  }

  let problemas = 0;
  tx(db, () => {
    perfiles.forEach((perfil, i) => {
      const apellido = apellidos[i % apellidos.length];
      const adulto = pick(ADULTOS);
      const responsable = `${adulto} ${apellido}`;
      let medio = perfil === 'puntual' ? (chance(0.6) ? 'debito' : 'transferencia')
        : perfil === 'deteriora' ? 'debito'
        : perfil === 'problema' ? pick(['transferencia', 'efectivo', 'debito'])
        : pick(['transferencia', 'debito', 'online']);
      const famId = Number(q.fam.run(apellido, responsable, `${slug(adulto)}.${slug(apellido)}@ejemplo.com`,
        `+54 9 11 ${String(4000 + Math.floor(rnd() * 5999))}-${String(1000 + Math.floor(rnd() * 8999))}`,
        medio, nuevoCodigoPortal(db), chance(0.92) ? 1 : 0, '', addDays(hoy, -600)).lastInsertRowid);

      const nHijos = chance(0.55) ? 1 : chance(0.75) ? 2 : 3;
      const beca = chance(0.1) ? pick([25, 50]) : 0;
      const alumnos = [];
      for (let h = 0; h < nHijos; h++) {
        const grado = 1 + Math.floor(rnd() * 7);
        const nombre = pick(CHICOS);
        const e = datosEscolares(nombre, grado);
        const id = Number(q.alu.run(famId, nombre, apellido, grado, h === 0 ? beca : 0, e.dni, e.nac, e.genero, e.seccion, e.ingreso).lastInsertRowid);
        alumnos.push({ id, grado, beca_pct: h === 0 ? beca : 0, activo: 1 });
      }
      const monto = montoFamilia(alumnos, settings);

      // Roles especiales dentro de los perfiles "problema"
      let rol = null;
      if (perfil === 'problema') rol = ['plan_cumplido', 'plan_incumplido', 'plan_activo', 'solicitud', 'solicitud', null][problemas++] ?? null;

      const cambioMedio = perfil === 'deteriora' ? addDays(hoy, -90) : null;
      const refinanciar = [];
      const planHistIdx = [2, 3]; // mayo y junio del primer año
      let rechazosRestantes = perfil === 'problema' ? 2 : 3;

      periodos.forEach((periodo, pIdx) => {
        const venc = `${periodo}-${dia}`;
        const cuotaId = Number(q.cuota.run(famId, periodo, conceptoArancel(periodo), monto, venc, null, null).lastInsertRowid);
        const mesesAtras = diffDays(hoy, venc) / 30;

        let atraso;
        switch (perfil) {
          case 'puntual': atraso = chance(0.05) ? 1 + Math.floor(rnd() * 3) : chance(0.12) ? 0 : -(1 + Math.floor(rnd() * 8)); break;
          case 'justo': { const r = rnd(); atraso = r < 0.55 ? 0 : r < 0.8 ? -(1 + Math.floor(rnd() * 2)) : 1 + Math.floor(rnd() * 4); break; }
          case 'corto': atraso = chance(0.2) ? -(1 + Math.floor(rnd() * 3)) : 2 + Math.floor(rnd() * 11); break;
          case 'problema': atraso = chance(0.15) ? Math.floor(rnd() * 5) : 12 + Math.floor(rnd() * 75); break;
          case 'deteriora': atraso = mesesAtras > 5 ? -(1 + Math.floor(rnd() * 6)) : Math.round(6 + (5 - mesesAtras) * 7 + rnd() * 6); break;
        }
        const enPlanHist = (rol === 'plan_cumplido' || rol === 'plan_incumplido') && planHistIdx.includes(pIdx);
        const enPlanActivo = rol === 'plan_activo' && mesesAtras > 0.8 && mesesAtras < 3.5;
        if (enPlanHist || enPlanActivo) { refinanciar.push({ cuotaId, venc }); atraso = 9999; }

        const fechaPago = addDays(venc, atraso);
        const pagada = fechaPago <= hoy && atraso < 9999;
        const lead = perfil === 'problema' ? 10 : perfil === 'corto' || (perfil === 'deteriora' && mesesAtras <= 5) ? 7 : 3;
        const abreP = { puntual: 0.85, justo: 0.7, corto: 0.55, problema: 0.2, deteriora: mesesAtras > 5 ? 0.8 : 0.25 }[perfil];
        const hasta = enPlanHist || enPlanActivo ? null : pagada ? fechaPago : hoy;
        if (hasta) simularComs(famId, cuotaId, venc, hasta, perfil, abreP, lead);

        const medioEnFecha = cambioMedio && venc >= cambioMedio ? 'transferencia' : medio;
        if (medioEnFecha === 'debito' && atraso > 0 && venc <= hoy && rechazosRestantes > 0 && chance(perfil === 'puntual' ? 0.5 : 0.7)) {
          q.pago.run(famId, cuotaId, venc, monto, 'debito', 1);
          if (perfil !== 'puntual' && mesesAtras < 6) rechazosRestantes--;
        }
        if (pagada) {
          q.pago.run(famId, cuotaId, fechaPago, monto, atraso > 0 && medioEnFecha === 'debito' ? 'transferencia' : medioEnFecha, 0);
          if (chance(0.2)) q.ev.run(famId, fechaPago, 'consulta_saldo', '', 1);
        }
        // Consultas al portal que no terminan en pago
        const consultaSinPago = perfil === 'problema' || (perfil === 'deteriora' && mesesAtras <= 5);
        if (consultaSinPago && chance(0.55)) {
          const f = addDays(venc, 2 + Math.floor(rnd() * 6));
          if (f <= hoy && (!pagada || diffDays(fechaPago, f) > 5)) q.ev.run(famId, f, 'consulta_saldo', '', 1);
        }
      });

      if (cambioMedio) {
        q.ev.run(famId, cambioMedio, 'cambio_medio', 'debito→transferencia', 1);
        q.medio.run('transferencia', famId);
      }

      // Planes de pago
      if (refinanciar.length) {
        const activo = rol === 'plan_activo';
        const fechaPlan = activo ? addDays(hoy, -25) : addDays(refinanciar[refinanciar.length - 1].venc, 20);
        const n = activo ? 4 : 3;
        const total = monto * refinanciar.length;
        const planId = Number(q.plan.run(famId, fechaPlan, total, n, activo ? 'Acordado en reunión con dirección' : 'Plan acordado por teléfono').lastInsertRowid);
        for (const r of refinanciar) {
          q.refi.run(planId, r.cuotaId);
          simularComs(famId, r.cuotaId, r.venc, fechaPlan, perfil, 0.3, 10);
        }
        const base = Math.floor(total / n);
        for (let k = 1; k <= n; k++) {
          const venc = db_.addMonths(addDays(fechaPlan, 5), k - 1);
          const m = k === n ? total - base * (n - 1) : base;
          const cid = Number(q.cuota.run(famId, venc.slice(0, 7), `Plan de pagos #${planId} · cuota ${k}/${n}`, m, venc, planId, k).lastInsertRowid);
          const paga = rol === 'plan_cumplido' || k === 1;
          const f = addDays(venc, rol === 'plan_cumplido' ? -2 : 3);
          if (paga && f <= hoy) q.pago.run(famId, cid, f, m, 'transferencia', 0);
        }
      }
      if (rol === 'solicitud') {
        q.ev.run(famId, addDays(hoy, -Math.floor(1 + rnd() * 6)), 'solicitud_plan', 'Pedido desde el portal: "Estamos complicados este mes, ¿podemos pagar en cuotas?"', 0);
      }
    });
  });

  // Algunas bajas en el ciclo (sólo en familias con más de un hijo, para no alterar la cobranza)
  tx(db, () => {
    const candidatos = db.prepare(`SELECT a.id FROM alumnos a WHERE (SELECT COUNT(*) FROM alumnos b WHERE b.familia_id = a.familia_id) > 1 ORDER BY a.id`).all();
    const motivos = ['Pase a otra escuela', 'Mudanza', 'Motivos económicos', 'Pase a otra escuela'];
    const inicio = `${ciclo}-03-01`;
    const dias = Math.max(1, Math.min(diffDays(hoy, inicio) - 10, 200));
    for (let k = 0; k < motivos.length && candidatos.length; k++) {
      const [{ id }] = candidatos.splice(Math.floor(rnd2() * candidatos.length), 1);
      db.prepare("UPDATE alumnos SET estado = 'baja', activo = 0, fecha_baja = ?, motivo_baja = ? WHERE id = ?")
        .run(addDays(inicio, Math.floor(rnd2() * dias)), motivos[k], id);
    }
    // Ajusta el cupo si algún curso quedó sobrepasado
    db.exec(`UPDATE cursos SET capacidad = MAX(capacidad, (SELECT COUNT(*) FROM alumnos a WHERE a.grado = cursos.grado AND a.seccion = cursos.seccion AND a.estado = 'activo'))`);
  });

  // Asistencia de los últimos 60 días hábiles: la mayoría falta poco, algunos con ausentismo marcado.
  tx(db, () => {
    const ins = db.prepare('INSERT INTO asistencia (alumno_id, fecha, estado, justificada) VALUES (?, ?, ?, ?)');
    const activos = db.prepare("SELECT id FROM alumnos WHERE estado = 'activo'").all();
    const base = new Map(activos.map((a) => {
      const r = rnd2();
      return [a.id, r < 0.7 ? 0.02 + rnd2() * 0.03 : r < 0.92 ? 0.06 + rnd2() * 0.05 : 0.12 + rnd2() * 0.13];
    }));
    for (let k = 60; k >= 0; k--) {
      const f = addDays(hoy, -k);
      const dow = new Date(f + 'T12:00:00Z').getUTCDay();
      if (dow === 0 || dow === 6 || f < `${ciclo}-03-01`) continue;
      const extra = dow === 1 || dow === 5 ? 0.02 : 0;
      for (const a of activos) {
        const r = rnd2();
        const p = base.get(a.id) + extra;
        const estado = r < p ? 'ausente' : r < p + 0.03 ? 'tarde' : 'presente';
        ins.run(a.id, f, estado, estado === 'ausente' && rnd2() < 0.45 ? 1 : 0);
      }
    }
  });

  // ---- Cobranzas: recibos de los pagos, recargos por mora, adelantos y promesas de ejemplo ----
  db.exec("UPDATE cuotas SET tipo = 'plan' WHERE plan_id IS NOT NULL");
  inyectarCasos(db, hoy, settings);
  db_.vincularPagosSinCobro(db);
  C.liquidarRecargos(db);
  const conDeuda = db.prepare(`SELECT c.familia_id, SUM(c.monto) AS deuda, MIN(c.vencimiento) AS desde FROM cuotas c
    WHERE c.vencimiento < ? AND c.refinanciada_en IS NULL AND c.tipo IN ('arancel', 'plan')
      AND c.monto > COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.cuota_id = c.id AND p.rechazado = 0), 0)
    GROUP BY c.familia_id ORDER BY c.familia_id`).all(hoy);
  const insProm = db.prepare('INSERT INTO promesas (familia_id, fecha_registro, fecha_promesa, monto, nota) VALUES (?, ?, ?, ?, ?)');
  // Una promesa vigente y una incumplida, en familias con deuda de un solo mes
  const chicas = conDeuda.filter((f) => f.deuda <= 360000);
  if (chicas[0]) insProm.run(chicas[0].familia_id, addDays(hoy, -2), addDays(hoy, 6), chicas[0].deuda, 'Llamado telefónico: cobra a fin de mes y paga el total');
  if (chicas[1]) insProm.run(chicas[1].familia_id, addDays(hoy, -20), addDays(hoy, -9), chicas[1].deuda, 'Se comprometió por WhatsApp a pagar en una semana');
  // Una promesa cumplida: un pago reciente que había sido prometido
  const reciente = db.prepare(`SELECT * FROM cobros WHERE estado = 'vigente' AND fecha BETWEEN ? AND ? ORDER BY fecha DESC LIMIT 1`).get(addDays(hoy, -25), addDays(hoy, -5));
  if (reciente) insProm.run(reciente.familia_id, addDays(reciente.fecha, -6), addDays(reciente.fecha, 1), reciente.monto, 'Acordado en la reunión de padres');
  // Un adelanto: una familia al día paga dos meses y le queda saldo a favor
  const alDia = db.prepare(`SELECT f.id FROM familias f WHERE f.medio_pago = 'transferencia'
    AND NOT EXISTS (SELECT 1 FROM cuotas c WHERE c.familia_id = f.id AND c.vencimiento < ? AND c.refinanciada_en IS NULL
      AND c.monto > COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.cuota_id = c.id AND p.rechazado = 0), 0))
    ORDER BY f.id LIMIT 1`).get(hoy);
  if (alDia) {
    const abiertas = C.cargosAbiertos(db, alDia.id);
    const total = abiertas.reduce((a, c) => a + c.saldo, 0);
    if (total) C.registrarCobro(db, { familia_id: alDia.id, monto: total + 50000, medio: 'transferencia', fecha: addDays(hoy, -1), referencia: 'Adelanto de cuotas' });
  }
  // Un cobro cargado dos veces el mismo día (para la detección de anomalías)
  const dup = db.prepare(`SELECT * FROM cobros WHERE estado = 'vigente' AND tipo = 'recibo' AND medio = 'efectivo' AND fecha >= ?
    ORDER BY fecha DESC, id LIMIT 1`).get(addDays(hoy, -20));
  if (dup) C.registrarCobro(db, { familia_id: dup.familia_id, monto: dup.monto, medio: dup.medio, fecha: dup.fecha });

  return {
    familias: db.prepare('SELECT COUNT(*) n FROM familias').get().n,
    cobros: db.prepare('SELECT COUNT(*) n FROM cobros').get().n,
    recargos: db.prepare("SELECT COUNT(*) n FROM cuotas WHERE tipo = 'recargo'").get().n,
    asistencia: db.prepare('SELECT COUNT(*) n FROM asistencia').get().n,
    alumnos: db.prepare('SELECT COUNT(*) n FROM alumnos').get().n,
    cuotas: db.prepare('SELECT COUNT(*) n FROM cuotas').get().n,
    pagos: db.prepare('SELECT COUNT(*) n FROM pagos').get().n,
    comunicaciones: db.prepare('SELECT COUNT(*) n FROM comunicaciones').get().n,
  };
}

/**
 * Casos de ejemplo de la presentación, para que la inteligencia de cobranza tenga qué mostrar:
 * un atraso estacional, una familia puntual que se atrasa por primera vez, un error de facturación
 * y señales de riesgo de baja. Todo ficticio.
 */
function inyectarCasos(db, hoy, settings) {
  const saldoOk = (cuotaId) => db.prepare('SELECT COALESCE(SUM(monto), 0) AS s FROM pagos WHERE cuota_id = ? AND rechazado = 0').get(cuotaId).s;
  const puntuales = db.prepare(`SELECT f.id, f.apellido, (SELECT COUNT(*) FROM alumnos a WHERE a.familia_id = f.id AND a.estado = 'activo') AS hijos
    FROM familias f WHERE NOT EXISTS (
      SELECT 1 FROM cuotas c JOIN pagos p ON p.cuota_id = c.id AND p.rechazado = 0
      WHERE c.familia_id = f.id AND c.tipo = 'arancel' AND p.fecha > c.vencimiento)
    AND NOT EXISTS (SELECT 1 FROM pagos p WHERE p.familia_id = f.id AND p.rechazado = 1)
    ORDER BY f.id`).all();
  const usados = new Set();
  const tomar = (pred) => { const f = puntuales.find((x) => !usados.has(x.id) && pred(x)); if (f) usados.add(f.id); return f; };

  // 1. Tardío estacional: paga 12 días tarde en marzo, julio y diciembre
  const est = tomar((f) => f.hijos === 1);
  if (est) {
    for (const c of db.prepare("SELECT * FROM cuotas WHERE familia_id = ? AND tipo = 'arancel' AND CAST(substr(periodo, 6, 2) AS INTEGER) IN (3, 7, 12) AND vencimiento < ?").all(est.id, addDays(hoy, -15))) {
      db.prepare('UPDATE pagos SET fecha = ? WHERE cuota_id = ? AND rechazado = 0').run(addDays(c.vencimiento, 12), c.id);
    }
  }

  // 2. Puntual de siempre (3 hijos) que deja impaga la última cuota vencida
  const anom = tomar((f) => f.hijos === 3) || tomar((f) => f.hijos === 2);
  if (anom) {
    const c = db.prepare("SELECT * FROM cuotas WHERE familia_id = ? AND tipo = 'arancel' AND vencimiento < ? ORDER BY vencimiento DESC LIMIT 1").get(anom.id, hoy);
    if (c) db.prepare('DELETE FROM pagos WHERE cuota_id = ?').run(c.id);
  }

  // 3. Error de facturación: a una familia con dos hijos no se le aplicó el descuento por hermano
  const err = db.prepare(`SELECT c.id, c.familia_id FROM cuotas c WHERE c.tipo = 'arancel' AND c.vencimiento >= ? AND c.vencimiento <= ?
      AND (SELECT COUNT(*) FROM alumnos a WHERE a.familia_id = c.familia_id AND a.estado = 'activo' AND a.beca_pct = 0) = 2
      AND NOT EXISTS (SELECT 1 FROM pagos p WHERE p.cuota_id = c.id) ORDER BY c.familia_id LIMIT 1`).get(hoy, addDays(hoy, 31));
  if (err) db.prepare('UPDATE cuotas SET monto = ? WHERE id = ?').run(2 * Number(settings.arancel_mensual), err.id);

  // 4. Riesgo de baja: la familia con más cuotas vencidas suma un reclamo y faltas de su hijo
  const deudora = db.prepare(`SELECT c.familia_id, COUNT(*) AS n FROM cuotas c
      WHERE c.tipo IN ('arancel', 'plan') AND c.refinanciada_en IS NULL AND c.vencimiento < ?
      GROUP BY c.familia_id HAVING SUM(c.monto) > SUM((SELECT COALESCE(SUM(p.monto), 0) FROM pagos p WHERE p.cuota_id = c.id AND p.rechazado = 0)) + 1
      ORDER BY n DESC, c.familia_id LIMIT 1`).get(hoy);
  const ev = db.prepare('INSERT INTO eventos (familia_id, fecha, tipo, detalle, atendido) VALUES (?, ?, ?, ?, 0)');
  if (deudora) {
    ev.run(deudora.familia_id, addDays(hoy, -12), 'reclamo', 'Reclamo por nota: disconformidad con el último aumento de la cuota.');
    for (const a of db.prepare("SELECT id FROM alumnos WHERE familia_id = ? AND estado = 'activo'").all(deudora.familia_id)) {
      const filas = db.prepare("SELECT id FROM asistencia WHERE alumno_id = ? AND fecha > ? ORDER BY fecha").all(a.id, addDays(hoy, -30));
      filas.forEach((r, i) => { if (i % 4 === 0) db.prepare("UPDATE asistencia SET estado = 'ausente', justificada = 0 WHERE id = ?").run(r.id); });
    }
  }
  // 5. Otra familia con deuda pide documentación para un pase
  const otra = db.prepare(`SELECT DISTINCT c.familia_id FROM cuotas c WHERE c.tipo = 'arancel' AND c.vencimiento < ? AND c.refinanciada_en IS NULL
      AND c.monto > (SELECT COALESCE(SUM(p.monto), 0) FROM pagos p WHERE p.cuota_id = c.id AND p.rechazado = 0) + 1
      AND c.familia_id <> ? ORDER BY c.familia_id LIMIT 1`).get(hoy, deudora ? deudora.familia_id : 0);
  if (otra) ev.run(otra.familia_id, addDays(hoy, -6), 'pedido_pase', 'Pidió constancia de alumno regular y libreta para un posible pase de escuela.');
  return { estacional: est?.id, anomalia: anom?.id, error: err?.familia_id, saldo: saldoOk };
}

module.exports = { seed };

if (require.main === module) {
  const db = db_.open();
  const r = seed(db);
  console.log('Datos de demostración cargados:', r);
}
