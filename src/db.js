'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'escuela.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS familias (
  id             INTEGER PRIMARY KEY,
  apellido       TEXT NOT NULL,
  responsable    TEXT NOT NULL,
  email          TEXT DEFAULT '',
  telefono       TEXT DEFAULT '',
  medio_pago     TEXT NOT NULL DEFAULT 'transferencia',
  codigo_portal  TEXT NOT NULL UNIQUE,
  consentimiento INTEGER NOT NULL DEFAULT 0,
  notas          TEXT DEFAULT '',
  activa         INTEGER NOT NULL DEFAULT 1,
  creada         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alumnos (
  id         INTEGER PRIMARY KEY,
  familia_id INTEGER NOT NULL REFERENCES familias(id) ON DELETE CASCADE,
  nombre     TEXT NOT NULL,
  apellido   TEXT NOT NULL,
  grado      INTEGER NOT NULL,
  beca_pct   INTEGER NOT NULL DEFAULT 0,
  activo     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS planes (
  id          INTEGER PRIMARY KEY,
  familia_id  INTEGER NOT NULL REFERENCES familias(id) ON DELETE CASCADE,
  fecha       TEXT NOT NULL,
  monto_total REAL NOT NULL,
  cuotas_n    INTEGER NOT NULL,
  nota        TEXT DEFAULT ''
);

-- Una cuota es una obligación de pago: un arancel mensual o una cuota de un plan.
-- refinanciada_en: plan que absorbió la deuda de esta cuota (deja de exigirse).
-- plan_id/plan_nro: la cuota es la n-ésima de un plan de pagos.
CREATE TABLE IF NOT EXISTS cuotas (
  id              INTEGER PRIMARY KEY,
  familia_id      INTEGER NOT NULL REFERENCES familias(id) ON DELETE CASCADE,
  periodo         TEXT NOT NULL,
  concepto        TEXT NOT NULL,
  monto           REAL NOT NULL,
  vencimiento     TEXT NOT NULL,
  refinanciada_en INTEGER REFERENCES planes(id),
  plan_id         INTEGER REFERENCES planes(id),
  plan_nro        INTEGER,
  UNIQUE (familia_id, periodo, concepto)
);

CREATE TABLE IF NOT EXISTS pagos (
  id         INTEGER PRIMARY KEY,
  familia_id INTEGER NOT NULL REFERENCES familias(id) ON DELETE CASCADE,
  cuota_id   INTEGER NOT NULL REFERENCES cuotas(id) ON DELETE CASCADE,
  fecha      TEXT NOT NULL,
  monto      REAL NOT NULL,
  medio      TEXT NOT NULL,
  rechazado  INTEGER NOT NULL DEFAULT 0
);

-- etapa: prevencion | vencimiento | contacto | plan | reunion | manual
-- estado: enviada | omitida (la administración decidió no actuar)
CREATE TABLE IF NOT EXISTS comunicaciones (
  id         INTEGER PRIMARY KEY,
  familia_id INTEGER NOT NULL REFERENCES familias(id) ON DELETE CASCADE,
  cuota_id   INTEGER REFERENCES cuotas(id) ON DELETE SET NULL,
  fecha      TEXT NOT NULL,
  canal      TEXT NOT NULL,
  etapa      TEXT NOT NULL,
  mensaje    TEXT DEFAULT '',
  estado     TEXT NOT NULL DEFAULT 'enviada',
  abierto    INTEGER NOT NULL DEFAULT 0,
  respondido INTEGER NOT NULL DEFAULT 0
);

-- tipo: consulta_saldo | solicitud_plan | cambio_medio | reclamo | pedido_pase
CREATE TABLE IF NOT EXISTS eventos (
  id         INTEGER PRIMARY KEY,
  familia_id INTEGER NOT NULL REFERENCES familias(id) ON DELETE CASCADE,
  fecha      TEXT NOT NULL,
  tipo       TEXT NOT NULL,
  detalle    TEXT DEFAULT '',
  atendido   INTEGER NOT NULL DEFAULT 0
);

-- Cursos: una sección de un grado, con turno, docente a cargo y cupo.
CREATE TABLE IF NOT EXISTS cursos (
  id        INTEGER PRIMARY KEY,
  grado     INTEGER NOT NULL,
  seccion   TEXT NOT NULL,
  turno     TEXT NOT NULL DEFAULT 'mañana',
  docente   TEXT DEFAULT '',
  capacidad INTEGER NOT NULL DEFAULT 25,
  UNIQUE (grado, seccion)
);

-- Asistencia diaria. No se usa en el motor de riesgo de cobranza (slide 11: el alumno, primero).
CREATE TABLE IF NOT EXISTS asistencia (
  id          INTEGER PRIMARY KEY,
  alumno_id   INTEGER NOT NULL REFERENCES alumnos(id) ON DELETE CASCADE,
  fecha       TEXT NOT NULL,
  estado      TEXT NOT NULL,
  justificada INTEGER NOT NULL DEFAULT 0,
  UNIQUE (alumno_id, fecha)
);

-- Cobros: cada ingreso de dinero (recibo) o crédito (nota de crédito) de una familia.
-- Se imputa a cargos mediante filas de "pagos"; lo no imputado queda como saldo a favor.
-- estado: vigente | anulado | rechazado (débito automático rechazado: sin número de recibo).
CREATE TABLE IF NOT EXISTS cobros (
  id         INTEGER PRIMARY KEY,
  numero     INTEGER,
  tipo       TEXT NOT NULL DEFAULT 'recibo',
  familia_id INTEGER NOT NULL REFERENCES familias(id) ON DELETE CASCADE,
  fecha      TEXT NOT NULL,
  monto      REAL NOT NULL,
  medio      TEXT NOT NULL,
  referencia TEXT DEFAULT '',
  estado     TEXT NOT NULL DEFAULT 'vigente',
  motivo     TEXT DEFAULT '',
  creado     TEXT NOT NULL
);

-- Promesas de pago acordadas con la familia. Su cumplimiento se calcula con los cobros.
CREATE TABLE IF NOT EXISTS promesas (
  id             INTEGER PRIMARY KEY,
  familia_id     INTEGER NOT NULL REFERENCES familias(id) ON DELETE CASCADE,
  fecha_registro TEXT NOT NULL,
  fecha_promesa  TEXT NOT NULL,
  monto          REAL NOT NULL,
  nota           TEXT DEFAULT '',
  anulada        INTEGER NOT NULL DEFAULT 0
);

-- Lotes de débito automático procesados.
CREATE TABLE IF NOT EXISTS lotes_debito (
  id         INTEGER PRIMARY KEY,
  periodo    TEXT NOT NULL,
  fecha      TEXT NOT NULL,
  cantidad   INTEGER NOT NULL,
  aceptados  INTEGER NOT NULL,
  rechazados INTEGER NOT NULL,
  monto      REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_cuotas_familia ON cuotas(familia_id);
CREATE INDEX IF NOT EXISTS ix_cobros_familia ON cobros(familia_id);
CREATE INDEX IF NOT EXISTS ix_cobros_fecha ON cobros(fecha);
CREATE INDEX IF NOT EXISTS ix_asistencia_fecha ON asistencia(fecha);
CREATE INDEX IF NOT EXISTS ix_pagos_cuota ON pagos(cuota_id);
CREATE INDEX IF NOT EXISTS ix_com_familia ON comunicaciones(familia_id);
CREATE INDEX IF NOT EXISTS ix_eventos_familia ON eventos(familia_id);
`;

const DEFAULT_SETTINGS = {
  escuela_nombre: 'Escuela Primaria Modelo',
  arancel_mensual: '185000',
  descuento_hermano_pct: '10',
  dia_vencimiento: '15',
  umbral_medio: '25',
  umbral_alto: '50',
  fecha_simulada: '',
  recargo_activo: '1',
  recargo_pct: '3',
  recargo_dias_gracia: '5',
  punto_venta: '0001',
};

function open(dbPath = DB_PATH) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

// Columnas del legajo del alumno agregadas después de la primera versión.
const ALUMNO_COLS = {
  dni: "TEXT DEFAULT ''",
  fecha_nacimiento: 'TEXT',
  genero: "TEXT DEFAULT ''",
  seccion: "TEXT NOT NULL DEFAULT 'A'",
  fecha_ingreso: 'TEXT',
  estado: "TEXT NOT NULL DEFAULT 'activo'",
  fecha_baja: 'TEXT',
  motivo_baja: "TEXT DEFAULT ''",
};

function migrate(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(alumnos)').all().map((c) => c.name));
  for (const [col, def] of Object.entries(ALUMNO_COLS)) {
    if (!cols.has(col)) db.exec(`ALTER TABLE alumnos ADD COLUMN ${col} ${def}`);
  }
  db.exec("UPDATE alumnos SET estado = 'baja' WHERE activo = 0 AND estado = 'activo'");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_alumnos_dni ON alumnos(dni) WHERE dni IS NOT NULL AND dni <> ''");
  // Todo alumno debe pertenecer a un curso existente.
  db.exec("INSERT OR IGNORE INTO cursos (grado, seccion) SELECT DISTINCT grado, seccion FROM alumnos");

  // Cobranzas: tipo de cargo (arancel | plan | cargo | recargo), recargo -> cargo de origen, pago -> cobro.
  const cuotaCols = new Set(db.prepare('PRAGMA table_info(cuotas)').all().map((c) => c.name));
  if (!cuotaCols.has('tipo')) db.exec("ALTER TABLE cuotas ADD COLUMN tipo TEXT NOT NULL DEFAULT 'arancel'");
  db.exec("UPDATE cuotas SET tipo = 'plan' WHERE plan_id IS NOT NULL AND tipo <> 'plan'");
  if (!cuotaCols.has('origen_id')) db.exec('ALTER TABLE cuotas ADD COLUMN origen_id INTEGER REFERENCES cuotas(id)');
  const pagoCols = new Set(db.prepare('PRAGMA table_info(pagos)').all().map((c) => c.name));
  if (!pagoCols.has('cobro_id')) db.exec('ALTER TABLE pagos ADD COLUMN cobro_id INTEGER REFERENCES cobros(id)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_pagos_cobro ON pagos(cobro_id)');
  vincularPagosSinCobro(db);
}

/** Los pagos cargados antes de existir los recibos reciben uno cada uno (numerados por fecha). */
function vincularPagosSinCobro(db) {
  const sueltos = db.prepare('SELECT * FROM pagos WHERE cobro_id IS NULL ORDER BY fecha, id').all();
  if (!sueltos.length) return 0;
  let n = db.prepare("SELECT COALESCE(MAX(numero), 0) AS n FROM cobros WHERE tipo = 'recibo'").get().n;
  const ins = db.prepare(`INSERT INTO cobros (numero, tipo, familia_id, fecha, monto, medio, estado, motivo, creado)
    VALUES (?, 'recibo', ?, ?, ?, ?, ?, ?, ?)`);
  const upd = db.prepare('UPDATE pagos SET cobro_id = ? WHERE id = ?');
  tx(db, () => {
    for (const p of sueltos) {
      const r = ins.run(p.rechazado ? null : ++n, p.familia_id, p.fecha, p.monto, p.medio,
        p.rechazado ? 'rechazado' : 'vigente', p.rechazado ? 'Débito rechazado' : '', `${p.fecha}T12:00:00`);
      upd.run(Number(r.lastInsertRowid), p.id);
    }
  });
  return sueltos.length;
}

function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
  return out;
}

function setSettings(db, values) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(values)) {
    if (k in DEFAULT_SETTINGS) up.run(k, String(v ?? ''));
  }
}

function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---- Fechas (ISO YYYY-MM-DD, aritmética en UTC para evitar saltos de horario) ----

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function today(db) {
  const sim = getSettings(db).fecha_simulada;
  return /^\d{4}-\d{2}-\d{2}$/.test(sim || '') ? sim : isoToday();
}

function toUTC(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function diffDays(a, b) {
  return Math.round((toUTC(a) - toUTC(b)) / 86400000);
}

function addDays(iso, n) {
  return new Date(toUTC(iso) + n * 86400000).toISOString().slice(0, 10);
}

function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(d, last));
  return dt.toISOString().slice(0, 10);
}

module.exports = {
  open, getSettings, setSettings, tx, DB_PATH, DEFAULT_SETTINGS, vincularPagosSinCobro,
  today, isoToday, diffDays, addDays, addMonths,
};
