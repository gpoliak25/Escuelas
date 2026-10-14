'use strict';
// Exporta el dataset del análisis de morosidad (sin datos personales) a analisis/datos/*.csv,
// para correr analisis/analisis_morosidad.py sobre los datos reales de la escuela.
// Uso: npm run export:dataset   (o DB_PATH=otra.db npm run export:dataset)
const fs = require('node:fs');
const path = require('node:path');
const db_ = require('../src/db');
const { exportarDataset } = require('../src/morosidad');

const OUT = path.join(__dirname, '..', 'analisis', 'datos');
const celda = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const aCsv = (filas) => [Object.keys(filas[0]).join(','), ...filas.map((f) => Object.values(f).map(celda).join(','))].join('\n') + '\n';

const ds = exportarDataset(db_.open());
fs.mkdirSync(OUT, { recursive: true });
for (const t of ['alumnos', 'familias', 'cuotas']) {
  fs.writeFileSync(path.join(OUT, `${t}.csv`), aCsv(ds[t]));
  console.log(`${path.relative(process.cwd(), path.join(OUT, t + '.csv'))}: ${ds[t].length} filas`);
}
console.log(`Datos al ${ds.hoy}. Ahora: cd analisis && python analisis_morosidad.py`);
