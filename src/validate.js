'use strict';
// Validación de entrada compartida por los servicios.

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function req(v, name) {
  if (v === undefined || v === null || String(v).trim() === '') throw new HttpError(400, `Falta el campo "${name}"`);
  return typeof v === 'string' ? v.trim() : v;
}
function oneOf(v, list, name) {
  if (!list.includes(v)) throw new HttpError(400, `"${name}" debe ser uno de: ${list.join(', ')}`);
  return v;
}
function num(v, name, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (v === '' || v === null || !Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `"${name}" debe ser un número entre ${min} y ${max}`);
  return n;
}
function fecha(v, name) {
  if (!ISO.test(String(v || '')) || Number.isNaN(Date.parse(v))) throw new HttpError(400, `"${name}" debe ser una fecha válida (AAAA-MM-DD)`);
  return v;
}

module.exports = { HttpError, req, oneOf, num, fecha, ISO };
