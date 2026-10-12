'use strict';
// Gestión escolar: legajo del alumno (altas, bajas, pases de sección), cursos y asistencia.
const { today, tx, addDays } = require('./db');
const { HttpError, req, oneOf, num, fecha } = require('./validate');

const TURNOS = ['mañana', 'tarde'];
const GENEROS = ['F', 'M', 'X', ''];
const MOTIVOS_BAJA = ['Pase a otra escuela', 'Mudanza', 'Motivos económicos', 'Egreso', 'Otro'];
const ESTADOS_ASISTENCIA = ['presente', 'ausente', 'tarde'];
const DIAS_RESUMEN = 30;

function edad(nacimiento, hoy) {
  if (!nacimiento) return null;
  const [y, m, d] = nacimiento.split('-').map(Number);
  const [Y, M, D] = hoy.split('-').map(Number);
  return Y - y - (M < m || (M === m && D < d) ? 1 : 0);
}

const porNombre = (a, b) => a.apellido.localeCompare(b.apellido, 'es') || a.nombre.localeCompare(b.nombre, 'es');

const esFinDeSemana = (iso) => [0, 6].includes(new Date(iso + 'T12:00:00Z').getUTCDay());

// ---- Cursos ----

function getCurso(db, grado, seccion) {
  return db.prepare('SELECT * FROM cursos WHERE grado = ? AND seccion = ?').get(grado, seccion);
}

function inscriptos(db, grado, seccion, exceptoId = 0) {
  return db.prepare("SELECT COUNT(*) AS n FROM alumnos WHERE grado = ? AND seccion = ? AND estado = 'activo' AND id <> ?")
    .get(grado, seccion, exceptoId).n;
}

function verificarCupo(db, grado, seccion, exceptoId = 0) {
  const c = getCurso(db, grado, seccion);
  if (!c) throw new HttpError(400, `No existe el curso ${grado}° ${seccion}`);
  if (inscriptos(db, grado, seccion, exceptoId) >= c.capacidad) {
    throw new HttpError(409, `${grado}° ${seccion} no tiene vacantes (cupo de ${c.capacidad} alumnos)`);
  }
  return c;
}

function datosCurso(b, parcial = false) {
  const d = {};
  if (!parcial) {
    d.grado = num(b.grado, 'grado', { min: 1, max: 7 });
    d.seccion = String(req(b.seccion, 'seccion')).toUpperCase();
    if (!/^[A-Z]$/.test(d.seccion)) throw new HttpError(400, 'La sección debe ser una letra (A, B, C…)');
  }
  if (b.turno !== undefined || !parcial) d.turno = oneOf(b.turno || 'mañana', TURNOS, 'turno');
  if (b.docente !== undefined || !parcial) d.docente = String(b.docente ?? '').trim().slice(0, 120);
  if (b.capacidad !== undefined || !parcial) d.capacidad = num(b.capacidad ?? 25, 'capacidad', { min: 1, max: 60 });
  return d;
}

function crearCurso(db, body) {
  const d = datosCurso(body);
  if (getCurso(db, d.grado, d.seccion)) throw new HttpError(409, `Ya existe ${d.grado}° ${d.seccion}`);
  return Number(db.prepare('INSERT INTO cursos (grado, seccion, turno, docente, capacidad) VALUES (?, ?, ?, ?, ?)')
    .run(d.grado, d.seccion, d.turno, d.docente, d.capacidad).lastInsertRowid);
}

function actualizarCurso(db, id, body) {
  const c = db.prepare('SELECT * FROM cursos WHERE id = ?').get(id);
  if (!c) throw new HttpError(404, 'Curso inexistente');
  const d = datosCurso(body, true);
  if (d.capacidad !== undefined && d.capacidad < inscriptos(db, c.grado, c.seccion)) {
    throw new HttpError(400, `El cupo no puede ser menor que los ${inscriptos(db, c.grado, c.seccion)} alumnos inscriptos`);
  }
  if (!Object.keys(d).length) return;
  db.prepare(`UPDATE cursos SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(d), id);
}

/** Asistencia agregada por alumno desde una fecha. */
function resumenAsistencia(db, desde, hasta) {
  const rows = db.prepare(`SELECT alumno_id, COUNT(*) AS dias,
      SUM(estado = 'ausente') AS ausentes, SUM(estado = 'tarde') AS tardes,
      SUM(estado = 'ausente' AND justificada = 1) AS justificadas
    FROM asistencia WHERE fecha > ? AND fecha <= ? GROUP BY alumno_id`).all(desde, hasta);
  return new Map(rows.map((r) => [r.alumno_id, { ...r, pct: r.dias ? (r.dias - r.ausentes) / r.dias : null }]));
}

function listarCursos(db) {
  const hoy = today(db);
  const asis = resumenAsistencia(db, addDays(hoy, -DIAS_RESUMEN), hoy);
  const alumnos = db.prepare("SELECT id, grado, seccion, genero, fecha_nacimiento FROM alumnos WHERE estado = 'activo'").all();
  return db.prepare('SELECT * FROM cursos ORDER BY grado, seccion').all().map((c) => {
    const del = alumnos.filter((a) => a.grado === c.grado && a.seccion === c.seccion);
    const pcts = del.map((a) => asis.get(a.id)?.pct).filter((p) => p != null);
    const edades = del.map((a) => edad(a.fecha_nacimiento, hoy)).filter((e) => e != null);
    return {
      ...c,
      nombre: `${c.grado}° ${c.seccion}`,
      inscriptos: del.length,
      vacantes: Math.max(0, c.capacidad - del.length),
      mujeres: del.filter((a) => a.genero === 'F').length,
      varones: del.filter((a) => a.genero === 'M').length,
      edad_promedio: edades.length ? edades.reduce((a, b) => a + b, 0) / edades.length : null,
      asistencia_pct: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null,
    };
  });
}

function detalleCurso(db, id, dia) {
  const hoy = today(db);
  const c = listarCursos(db).find((x) => x.id === id);
  if (!c) throw new HttpError(404, 'Curso inexistente');
  const f = dia ? fecha(dia, 'fecha') : hoy;
  const asis = resumenAsistencia(db, addDays(hoy, -DIAS_RESUMEN), hoy);
  const delDia = new Map(db.prepare(`SELECT s.* FROM asistencia s JOIN alumnos a ON a.id = s.alumno_id
    WHERE s.fecha = ? AND a.grado = ? AND a.seccion = ?`).all(f, c.grado, c.seccion).map((r) => [r.alumno_id, r]));
  const alumnos = db.prepare(`SELECT a.*, f.apellido AS familia_apellido FROM alumnos a JOIN familias f ON f.id = a.familia_id
    WHERE a.grado = ? AND a.seccion = ? AND a.estado = 'activo'`).all(c.grado, c.seccion)
    .sort(porNombre)
    .map((a) => ({
      id: a.id, nombre: a.nombre, apellido: a.apellido, dni: a.dni, genero: a.genero, familia_id: a.familia_id,
      edad: edad(a.fecha_nacimiento, hoy),
      asistencia_pct: asis.get(a.id)?.pct ?? null,
      ausentes_30: asis.get(a.id)?.ausentes ?? 0,
      dia: delDia.get(a.id) || null,
    }));
  return { hoy, fecha: f, fin_de_semana: esFinDeSemana(f), tomada: delDia.size > 0, curso: c, alumnos };
}

function guardarAsistencia(db, cursoId, body) {
  const c = db.prepare('SELECT * FROM cursos WHERE id = ?').get(cursoId);
  if (!c) throw new HttpError(404, 'Curso inexistente');
  const f = fecha(body.fecha, 'fecha');
  if (f > today(db)) throw new HttpError(400, 'No se puede tomar asistencia de una fecha futura');
  if (esFinDeSemana(f)) throw new HttpError(400, 'La fecha es sábado o domingo');
  const registros = Array.isArray(body.registros) ? body.registros : [];
  if (!registros.length) throw new HttpError(400, 'No hay registros de asistencia');
  const delCurso = new Set(db.prepare("SELECT id FROM alumnos WHERE grado = ? AND seccion = ? AND estado = 'activo'").all(c.grado, c.seccion).map((a) => a.id));
  const up = db.prepare(`INSERT INTO asistencia (alumno_id, fecha, estado, justificada) VALUES (?, ?, ?, ?)
    ON CONFLICT(alumno_id, fecha) DO UPDATE SET estado = excluded.estado, justificada = excluded.justificada`);
  tx(db, () => {
    for (const r of registros) {
      const id = Number(r.alumno_id);
      if (!delCurso.has(id)) throw new HttpError(400, 'Hay alumnos que no pertenecen al curso');
      const estado = oneOf(r.estado, ESTADOS_ASISTENCIA, 'estado');
      up.run(id, f, estado, estado === 'ausente' && r.justificada ? 1 : 0);
    }
  });
  return { guardados: registros.length };
}

// ---- Alumnos ----

function datosAlumno(db, b, hoy, id = 0) {
  const d = {
    nombre: req(b.nombre, 'nombre'),
    apellido: req(b.apellido, 'apellido'),
    dni: String(b.dni ?? '').replace(/\D/g, ''),
    fecha_nacimiento: b.fecha_nacimiento ? fecha(b.fecha_nacimiento, 'fecha_nacimiento') : null,
    genero: oneOf(b.genero ?? '', GENEROS, 'genero'),
    grado: num(b.grado, 'grado', { min: 1, max: 7 }),
    seccion: String(b.seccion || 'A').trim().toUpperCase(),
    beca_pct: num(b.beca_pct === undefined || b.beca_pct === '' || b.beca_pct === null ? 0 : b.beca_pct, 'beca_pct', { min: 0, max: 100 }),
    fecha_ingreso: b.fecha_ingreso ? fecha(b.fecha_ingreso, 'fecha_ingreso') : hoy,
  };
  if (d.dni && !/^\d{7,8}$/.test(d.dni)) throw new HttpError(400, 'El DNI debe tener 7 u 8 dígitos');
  if (d.dni && db.prepare('SELECT 1 FROM alumnos WHERE dni = ? AND id <> ?').get(d.dni, id)) {
    throw new HttpError(409, `Ya hay un alumno registrado con el DNI ${d.dni}`);
  }
  if (d.fecha_nacimiento) {
    const e = edad(d.fecha_nacimiento, hoy);
    if (e < 4 || e > 16) throw new HttpError(400, 'La fecha de nacimiento no corresponde a un alumno de primaria');
  }
  if (d.fecha_ingreso > hoy) throw new HttpError(400, 'La fecha de ingreso no puede ser futura');
  return d;
}

function crearAlumno(db, familiaId, body) {
  if (!db.prepare('SELECT 1 FROM familias WHERE id = ?').get(familiaId)) throw new HttpError(404, 'Familia inexistente');
  const d = datosAlumno(db, body, today(db));
  verificarCupo(db, d.grado, d.seccion);
  const r = db.prepare(`INSERT INTO alumnos (familia_id, nombre, apellido, dni, fecha_nacimiento, genero, grado, seccion, beca_pct, fecha_ingreso, estado, activo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo', 1)`)
    .run(familiaId, d.nombre, d.apellido, d.dni, d.fecha_nacimiento, d.genero, d.grado, d.seccion, d.beca_pct, d.fecha_ingreso);
  return Number(r.lastInsertRowid);
}

function actualizarAlumno(db, id, body) {
  const prev = db.prepare('SELECT * FROM alumnos WHERE id = ?').get(id);
  if (!prev) throw new HttpError(404, 'Alumno inexistente');
  const d = datosAlumno(db, { ...prev, ...body }, today(db), id);
  const cambiaCurso = d.grado !== prev.grado || d.seccion !== prev.seccion;
  if (cambiaCurso && prev.estado === 'activo') verificarCupo(db, d.grado, d.seccion, id);
  db.prepare(`UPDATE alumnos SET nombre = ?, apellido = ?, dni = ?, fecha_nacimiento = ?, genero = ?, grado = ?, seccion = ?,
    beca_pct = ?, fecha_ingreso = ? WHERE id = ?`)
    .run(d.nombre, d.apellido, d.dni, d.fecha_nacimiento, d.genero, d.grado, d.seccion, d.beca_pct, d.fecha_ingreso, id);
}

function bajaAlumno(db, id, body) {
  const a = db.prepare('SELECT * FROM alumnos WHERE id = ?').get(id);
  if (!a) throw new HttpError(404, 'Alumno inexistente');
  if (a.estado !== 'activo') throw new HttpError(400, 'El alumno ya no está activo');
  const hoy = today(db);
  const f = body.fecha ? fecha(body.fecha, 'fecha') : hoy;
  if (f > hoy) throw new HttpError(400, 'La fecha de baja no puede ser futura');
  if (a.fecha_ingreso && f < a.fecha_ingreso) throw new HttpError(400, 'La fecha de baja es anterior al ingreso');
  const motivo = oneOf(body.motivo, MOTIVOS_BAJA, 'motivo');
  db.prepare('UPDATE alumnos SET estado = ?, activo = 0, fecha_baja = ?, motivo_baja = ? WHERE id = ?')
    .run(motivo === 'Egreso' ? 'egresado' : 'baja', f, motivo, id);
}

function reincorporarAlumno(db, id) {
  const a = db.prepare('SELECT * FROM alumnos WHERE id = ?').get(id);
  if (!a) throw new HttpError(404, 'Alumno inexistente');
  if (a.estado === 'activo') throw new HttpError(400, 'El alumno ya está activo');
  verificarCupo(db, a.grado, a.seccion, id);
  db.prepare("UPDATE alumnos SET estado = 'activo', activo = 1, fecha_baja = NULL, motivo_baja = '' WHERE id = ?").run(id);
}

function listarAlumnos(db) {
  const hoy = today(db);
  const asis = resumenAsistencia(db, addDays(hoy, -DIAS_RESUMEN), hoy);
  return db.prepare(`SELECT a.*, f.apellido AS familia_apellido, f.responsable, c.turno, c.docente, c.id AS curso_id
      FROM alumnos a JOIN familias f ON f.id = a.familia_id
      LEFT JOIN cursos c ON c.grado = a.grado AND c.seccion = a.seccion
`).all()
    .sort(porNombre)
    .map((a) => ({ ...a, edad: edad(a.fecha_nacimiento, hoy), curso: `${a.grado}° ${a.seccion}`, asistencia_pct: asis.get(a.id)?.pct ?? null }));
}

function fichaAlumno(db, id) {
  const hoy = today(db);
  const a = listarAlumnos(db).find((x) => x.id === id);
  if (!a) throw new HttpError(404, 'Alumno inexistente');
  const inicioCiclo = `${hoy.slice(0, 4)}-03-01`;
  const ciclo = resumenAsistencia(db, addDays(inicioCiclo, -1), hoy).get(id) || null;
  const ult30 = resumenAsistencia(db, addDays(hoy, -DIAS_RESUMEN), hoy).get(id) || null;
  return {
    hoy,
    alumno: a,
    familia: db.prepare('SELECT id, apellido, responsable, email, telefono, medio_pago, consentimiento FROM familias WHERE id = ?').get(a.familia_id),
    hermanos: db.prepare("SELECT id, nombre, apellido, grado, seccion, estado FROM alumnos WHERE familia_id = ? AND id <> ? ORDER BY grado").all(a.familia_id, id),
    asistencia: { ciclo, ultimos_30: ult30 },
    inasistencias: db.prepare("SELECT fecha, estado, justificada FROM asistencia WHERE alumno_id = ? AND estado <> 'presente' ORDER BY fecha DESC LIMIT 15").all(id),
    motivos_baja: MOTIVOS_BAJA,
  };
}

module.exports = {
  TURNOS, GENEROS, MOTIVOS_BAJA, ESTADOS_ASISTENCIA, DIAS_RESUMEN,
  edad, esFinDeSemana, resumenAsistencia,
  listarCursos, detalleCurso, crearCurso, actualizarCurso, guardarAsistencia,
  crearAlumno, actualizarAlumno, bajaAlumno, reincorporarAlumno, listarAlumnos, fichaAlumno,
};
