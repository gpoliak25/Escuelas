'use strict';
/* Gestión escolar: alumnos (alta, ficha, baja), cursos y asistencia, estadística descriptiva.
   Usa las utilidades globales de app.js (h, raw, api, openModal, columnChart, etc.). */

const GENERO_LBL = { F: 'Femenino', M: 'Masculino', X: 'No binario', '': 'Sin informar' };
const ESTADO_ALU = { activo: 'Activo', baja: 'Baja', egresado: 'Egresado' };
const TURNO_LBL = { 'mañana': 'Mañana', tarde: 'Tarde' };
const nf = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : v.toLocaleString('es-AR', { maximumFractionDigits: d }));
const pctPill = (p) => (p == null ? h`<span class="muted">—</span>`
  : h`<span class="pill ${p < 0.85 ? 'bad' : p < 0.9 ? 'warn' : 'ok'}">${pct(p, 0)}</span>`);

routes.alumnos = pageAlumnos;
routes.cursos = pageCursos;
routes.estadisticas = pageEstadisticas;

// ---------- Exportar tablas a CSV (separador ; para Excel en español) ----------
function descargarCsv(tablaId, nombre) {
  const t = document.getElementById(tablaId);
  if (!t) return;
  const filas = $$('tr', t).map((tr) => $$('th,td', tr).map((c) => `"${c.innerText.replace(/\s+/g, ' ').trim().replace(/"/g, '""')}"`).join(';'));
  const blob = new Blob(['﻿' + filas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${nombre}.csv` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function bindCsv(root = main) {
  $$('[data-csv]', root).forEach((b) => b.addEventListener('click', () => descargarCsv(b.dataset.csv, b.dataset.nombre || b.dataset.csv)));
}
const csvBtn = (id, nombre) => h`<button class="btn sm" data-csv="${id}" data-nombre="${nombre}">Descargar CSV</button>`;

// ---------- Alumnos ----------
const filtrosAlumnos = { q: '', curso: '', turno: '', estado: 'activo', genero: '' };

async function pageAlumnos(arg) {
  if (arg && arg !== 'nuevo') return pageFichaAlumno(Number(arg));
  const d = await api('/api/alumnos');
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Gestión escolar</div><h1>Alumnos</h1>
      <p>Legajo de cada alumno: datos personales, curso, familia y asistencia. Desde acá se dan las altas, los pases de sección y las bajas.</p>
    </div>
    <div class="btn-row"><button class="btn" data-csv="tabla-alumnos" data-nombre="alumnos">Descargar CSV</button><button class="btn primary" id="alta">+ Alta de alumno</button></div></div>
    <div class="card">
      <div class="filters">
        <input type="search" id="fa-q" placeholder="Buscar por nombre, apellido o DNI" value="${filtrosAlumnos.q}" aria-label="Buscar">
        <select id="fa-curso" aria-label="Curso"><option value="">Todos los cursos</option>
          ${d.cursos.map((c) => h`<option value="${c.nombre}" ${filtrosAlumnos.curso === c.nombre ? 'selected' : ''}>${c.nombre} · ${TURNO_LBL[c.turno]}</option>`)}</select>
        <select id="fa-turno" aria-label="Turno"><option value="">Ambos turnos</option>
          ${Object.entries(TURNO_LBL).map(([k, l]) => h`<option value="${k}" ${filtrosAlumnos.turno === k ? 'selected' : ''}>${l}</option>`)}</select>
        <select id="fa-genero" aria-label="Género"><option value="">Todos los géneros</option>
          ${Object.entries(GENERO_LBL).map(([k, l]) => h`<option value="${k || 'ninguno'}" ${filtrosAlumnos.genero === (k || 'ninguno') ? 'selected' : ''}>${l}</option>`)}</select>
        <select id="fa-estado" aria-label="Estado">
          ${[['activo', 'Activos'], ['baja', 'Bajas y egresos'], ['', 'Todos']].map(([k, l]) => h`<option value="${k}" ${filtrosAlumnos.estado === k ? 'selected' : ''}>${l}</option>`)}</select>
        <span class="muted small" id="fa-count" style="align-self:center"></span>
      </div>
      <div id="lista-alumnos"></div>
    </div>`);

  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9 ]/g, '');
  const pintar = () => {
    const f = filtrosAlumnos;
    const lista = d.alumnos.filter((a) =>
      (!f.q || norm(`${a.nombre} ${a.apellido} ${a.dni}`).includes(norm(f.q))) &&
      (!f.curso || a.curso === f.curso) &&
      (!f.turno || a.turno === f.turno) &&
      (!f.genero || (a.genero || 'ninguno') === f.genero) &&
      (!f.estado || (f.estado === 'activo' ? a.estado === 'activo' : a.estado !== 'activo')));
    $('#fa-count').textContent = `${lista.length} alumno(s) · ${lista.filter((a) => a.genero === 'F').length} F · ${lista.filter((a) => a.genero === 'M').length} M`;
    $('#lista-alumnos').innerHTML = String(lista.length ? h`<div class="table-wrap"><table id="tabla-alumnos">
      <thead><tr><th>Alumno</th><th>DNI</th><th class="r">Edad</th><th>Curso</th><th>Turno</th><th>Familia</th><th class="r">Beca</th><th>Asistencia 30 d</th><th>Estado</th></tr></thead>
      <tbody>${lista.map((a) => h`<tr class="link" data-href="#/alumnos/${a.id}">
        <td><b>${a.apellido}, ${a.nombre}</b></td><td class="num">${a.dni || '—'}</td><td class="r num">${a.edad ?? '—'}</td>
        <td>${a.curso}</td><td>${TURNO_LBL[a.turno] || '—'}</td>
        <td><a href="#/familias/${a.familia_id}">${a.familia_apellido}</a></td>
        <td class="r num">${a.beca_pct ? a.beca_pct + '%' : '—'}</td><td>${pctPill(a.asistencia_pct)}</td>
        <td><span class="pill ${a.estado === 'activo' ? 'ok' : 'plain'}">${ESTADO_ALU[a.estado]}</span>${a.fecha_baja ? h`<div class="small muted">${fdate(a.fecha_baja)} · ${a.motivo_baja}</div>` : ''}</td>
      </tr>`)}</tbody></table></div>` : h`<div class="empty">No hay alumnos con esos filtros.</div>`);
    bindLinks($('#lista-alumnos'));
  };
  let t;
  $('#fa-q').addEventListener('input', (e) => { filtrosAlumnos.q = e.target.value; clearTimeout(t); t = setTimeout(pintar, 150); });
  for (const k of ['curso', 'turno', 'genero', 'estado']) $(`#fa-${k}`).addEventListener('change', (e) => { filtrosAlumnos[k] = e.target.value; pintar(); });
  $('#alta').addEventListener('click', () => openAltaAlumno());
  bindCsv();
  pintar();
  if (arg === 'nuevo') openAltaAlumno();
}

/** Opciones de curso con vacantes; el curso actual del alumno siempre queda habilitado. */
function opcionesCurso(cursos, actual) {
  return cursos.map((c) => {
    const esActual = actual && c.grado === actual.grado && c.seccion === actual.seccion;
    const lleno = c.vacantes <= 0 && !esActual;
    return h`<option value="${c.grado}|${c.seccion}" data-grado="${c.grado}" ${esActual ? 'selected' : ''} ${lleno ? 'disabled' : ''}>${c.nombre} · ${TURNO_LBL[c.turno]} · ${lleno ? 'sin vacantes' : c.vacantes + ' vacante(s)'}</option>`;
  });
}

function camposAlumno(a, cursos, hoy) {
  return h`
    <h3 class="form-sec">Datos personales</h3>
    <div class="form-grid">
      <label class="field">Nombre<input name="nombre" value="${a.nombre || ''}" required></label>
      <label class="field">Apellido<input name="apellido" id="alu-apellido" value="${a.apellido || ''}" required></label>
      <label class="field">DNI<input name="dni" value="${a.dni || ''}" inputmode="numeric" pattern="[0-9.]{7,10}" placeholder="Sólo números"></label>
      <label class="field">Fecha de nacimiento<input name="fecha_nacimiento" id="alu-nac" type="date" value="${a.fecha_nacimiento || ''}" max="${hoy}"></label>
      <label class="field">Género<select name="genero">${Object.entries(GENERO_LBL).map(([k, l]) => h`<option value="${k}" ${(a.genero || '') === k ? 'selected' : ''}>${l}</option>`)}</select></label>
    </div>
    <h3 class="form-sec">Escolaridad</h3>
    <div class="form-grid">
      <label class="field">Curso<select name="curso" id="alu-curso" required><option value="">Elegí un curso…</option>${opcionesCurso(cursos, a.grado ? a : null)}</select>
        <small id="alu-curso-hint"></small></label>
      <label class="field">Fecha de ingreso<input name="fecha_ingreso" type="date" value="${a.fecha_ingreso || hoy}" max="${hoy}"></label>
      <label class="field">Beca (%)<input name="beca_pct" type="number" min="0" max="100" value="${a.beca_pct ?? 0}"></label>
    </div>`;
}

/** Sugiere el grado según la fecha de nacimiento (6 años cumplidos en el año = 1° grado). */
function bindSugerenciaCurso(hoy) {
  const nac = $('#alu-nac'), sel = $('#alu-curso'), hint = $('#alu-curso-hint');
  nac?.addEventListener('change', () => {
    if (!nac.value) return;
    const grado = Number(hoy.slice(0, 4)) - Number(nac.value.slice(0, 4)) - 5;
    if (grado < 1 || grado > 7) { hint.textContent = 'Por la edad, no corresponde a un grado de primaria.'; return; }
    hint.textContent = `Por la edad le corresponde ${grado}° grado.`;
    if (!sel.value || !sel.selectedOptions[0]?.dataset.grado || Number(sel.selectedOptions[0].dataset.grado) !== grado) {
      const opt = [...sel.options].find((o) => Number(o.dataset.grado) === grado && !o.disabled);
      if (opt) sel.value = opt.value;
    }
  });
}

function datosDeForm(data) {
  const [grado, seccion] = String(data.curso || '').split('|');
  const { curso, ...resto } = data;
  return { ...resto, grado, seccion };
}

async function openAltaAlumno({ familiaId, nuevaFamilia = false } = {}) {
  const [{ cursos, hoy }, { familias }] = await Promise.all([api('/api/cursos'), api('/api/familias/opciones')]);
  const famLabel = (f) => `${f.apellido} — ${f.responsable} (#${f.id})`;
  const fija = familiaId ? familias.find((f) => f.id === familiaId) : null;
  openModal({
    title: 'Alta de alumno',
    wide: true,
    submit: 'Dar de alta',
    body: h`
      ${camposAlumno({ apellido: fija?.apellido }, cursos, hoy)}
      <h3 class="form-sec">Familia</h3>
      ${fija ? h`<p class="small" style="margin:0">Se suma a la familia <b>${fija.apellido}</b> (${fija.responsable}).</p>` : h`
        <div class="seg" role="radiogroup" aria-label="Familia" style="margin-bottom:12px">
          <label class="seg-opt"><input type="radio" name="fam_modo" value="existente" ${nuevaFamilia ? '' : 'checked'}> Familia existente</label>
          <label class="seg-opt"><input type="radio" name="fam_modo" value="nueva" ${nuevaFamilia ? 'checked' : ''}> Familia nueva</label>
        </div>
        <div id="fam-existente" class="form-grid" ${nuevaFamilia ? 'hidden' : ''}>
          <label class="field full">Buscar familia<input name="familia_txt" id="fam-txt" list="fam-list" placeholder="Escribí el apellido…" autocomplete="off">
            <small>Si tiene hermanos en la escuela, se aplica el descuento por hermano.</small></label>
          <datalist id="fam-list">${familias.map((f) => h`<option value="${famLabel(f)}"></option>`)}</datalist>
        </div>
        <div id="fam-nueva" class="form-grid" ${nuevaFamilia ? '' : 'hidden'}>
          <label class="field">Apellido de la familia<input name="f_apellido" id="f-apellido"></label>
          <label class="field">Responsable<input name="f_responsable" placeholder="Nombre y apellido"></label>
          <label class="field">Mail<input name="f_email" type="email"></label>
          <label class="field">Teléfono (WhatsApp)<input name="f_telefono" placeholder="+54 9 11 ..."></label>
          <label class="field">Medio de pago<select name="f_medio_pago">${Object.entries(MEDIO).map(([k, l]) => h`<option value="${k}">${l}</option>`)}</select></label>
          <label class="field check" style="align-self:end"><input type="checkbox" name="f_consentimiento" checked> Consentimiento de datos (Ley 25.326)</label>
        </div>`}
      <p class="small muted" style="margin:14px 0 0">No se registran datos de salud, religión ni ideología.</p>`,
    onSubmit: async (data) => {
      const body = datosDeForm(data);
      for (const k of Object.keys(body)) if (k.startsWith('f_') || k === 'fam_modo' || k === 'familia_txt') delete body[k];
      if (fija) body.familia_id = fija.id;
      else if (data.fam_modo === 'nueva') {
        body.familia = {
          apellido: data.f_apellido, responsable: data.f_responsable, email: data.f_email,
          telefono: data.f_telefono, medio_pago: data.f_medio_pago, consentimiento: data.f_consentimiento,
        };
      } else {
        const f = familias.find((x) => famLabel(x) === data.familia_txt);
        if (!f) throw new Error('Elegí una familia de la lista o cargá una familia nueva');
        body.familia_id = f.id;
      }
      const r = await api('/api/alumnos', { method: 'POST', body });
      toast('Alumno dado de alta');
      const destino = '#/alumnos/' + r.id;
      if (location.hash === destino) reload(); else location.hash = destino;
    },
  });
  bindSugerenciaCurso(hoy);
  if (!fija) {
    $$('input[name=fam_modo]', modal).forEach((r) => r.addEventListener('change', () => {
      const nueva = $('input[name=fam_modo]:checked', modal).value === 'nueva';
      $('#fam-nueva').hidden = !nueva;
      $('#fam-existente').hidden = nueva;
    }));
    $('#fam-txt').addEventListener('change', (e) => {
      const f = familias.find((x) => famLabel(x) === e.target.value);
      if (f && !$('#alu-apellido').value) $('#alu-apellido').value = f.apellido;
    });
    $('#alu-apellido').addEventListener('input', (e) => { const fa = $('#f-apellido'); if (fa && !fa.dataset.touched) fa.value = e.target.value; });
    $('#f-apellido').addEventListener('input', (e) => { e.target.dataset.touched = '1'; });
  }
}

async function pageFichaAlumno(id) {
  const d = await api('/api/alumnos/' + id);
  const a = d.alumno, f = d.familia;
  const activo = a.estado === 'activo';
  const ciclo = d.asistencia.ciclo, u30 = d.asistencia.ultimos_30;
  main.innerHTML = String(h`
    <div class="page-head">
      <div>
        <div class="eyebrow"><a href="#/alumnos">Alumnos</a> / Legajo</div>
        <h1>${a.nombre} ${a.apellido} <span class="pill ${activo ? 'ok' : 'plain'}">${ESTADO_ALU[a.estado]}</span></h1>
        <p>${a.curso} · Turno ${TURNO_LBL[a.turno] || '—'} · Docente: ${a.docente || 'sin asignar'}</p>
      </div>
      <div class="btn-row">
        <button class="btn" id="editar">Editar / cambiar de curso</button>
        ${activo ? h`<button class="btn" id="baja">Dar de baja</button>` : h`<button class="btn primary" id="reinc">Reincorporar</button>`}
      </div>
    </div>
    ${activo ? '' : h`<div class="notice">Baja el ${fdate(a.fecha_baja)} · Motivo: ${a.motivo_baja}. Sus cuotas futuras dejan de generarse.</div>`}
    <div class="grid g-3">
      <div class="card">
        <h2>Datos personales</h2>
        <dl class="dl">
          <dt>DNI</dt><dd class="num">${a.dni || '—'}</dd>
          <dt>Nacimiento</dt><dd>${fdate(a.fecha_nacimiento)}${a.edad != null ? h` · ${a.edad} años` : ''}</dd>
          <dt>Género</dt><dd>${GENERO_LBL[a.genero || '']}</dd>
        </dl>
      </div>
      <div class="card">
        <h2>Escolaridad</h2>
        <dl class="dl">
          <dt>Curso</dt><dd><a href="#/cursos/${a.curso_id}">${a.curso}</a> · ${TURNO_LBL[a.turno] || '—'}</dd>
          <dt>Ingreso</dt><dd>${fdate(a.fecha_ingreso)}</dd>
          <dt>Beca</dt><dd>${a.beca_pct ? a.beca_pct + '%' : 'No'}</dd>
          <dt>Cuota mensual</dt><dd>${d.cuota ? h`<b class="num">${money(d.cuota.monto)}</b> <span class="small muted">arancel ${money(d.cuota.arancel)}${d.cuota.beca_pct ? ` · beca ${d.cuota.beca_pct}%` : ''}${d.cuota.descuento_hermano_pct ? ` · hermano −${d.cuota.descuento_hermano_pct}%` : ''}</span>` : '—'}</dd>
        </dl>
      </div>
      <div class="card">
        <h2>Familia</h2>
        <dl class="dl">
          <dt>Familia</dt><dd><a href="#/familias/${f.id}">${f.apellido}</a></dd>
          <dt>Responsable</dt><dd>${f.responsable}</dd>
          <dt>Contacto</dt><dd>${f.telefono || '—'}<br><span class="small">${f.email || ''}</span></dd>
          <dt>Hermanos</dt><dd>${d.hermanos.length ? d.hermanos.map((x, i) => h`${i ? ', ' : ''}<a href="#/alumnos/${x.id}">${x.nombre}</a> (${x.grado}° ${x.seccion}${x.estado !== 'activo' ? ', ' + ESTADO_ALU[x.estado].toLowerCase() : ''})`) : 'No'}</dd>
        </dl>
      </div>
    </div>
    <div class="grid g-21 mt">
      <div class="card">
        <div class="card-head"><div><h2>Asistencia</h2><p>Se usa para el seguimiento pedagógico; nunca para el puntaje de cobranza.</p></div></div>
        <div class="grid g-3">
          <div class="kpi"><span class="label">Ciclo lectivo</span><span class="value">${ciclo ? pct(ciclo.pct, 1) : '—'}</span><span class="sub">${ciclo ? `${ciclo.dias} días registrados` : 'Sin registros'}</span></div>
          <div class="kpi"><span class="label">Últimos 30 días</span><span class="value">${u30 ? pct(u30.pct, 1) : '—'}</span><span class="sub">${u30 ? `${u30.ausentes} inasistencia(s)` : ''}</span></div>
          <div class="kpi"><span class="label">Tardanzas (ciclo)</span><span class="value">${ciclo ? ciclo.tardes : 0}</span><span class="sub">${ciclo && ciclo.ausentes ? `${pct(ciclo.justificadas / ciclo.ausentes, 0)} de las faltas justificadas` : ''}</span></div>
        </div>
        ${u30 && u30.pct < 0.9 ? h`<div class="notice mt">Asistencia por debajo del 90% en el último mes: conviene un contacto de la docente con la familia.</div>` : ''}
      </div>
      <div class="card">
        <h2>Últimas inasistencias</h2>
        ${d.inasistencias.length ? h`<ul class="tl mt">${d.inasistencias.map((x) => h`<li><span class="when">${fdate(x.fecha)}</span><span>${x.estado === 'tarde' ? 'Llegada tarde' : 'Ausente'}${x.estado === 'ausente' ? (x.justificada ? ' · justificada' : ' · sin justificar') : ''}</span></li>`)}</ul>`
          : h`<div class="empty">Sin inasistencias registradas.</div>`}
      </div>
    </div>`);

  $('#editar').addEventListener('click', async () => {
    const { cursos } = await api('/api/cursos');
    openModal({
      title: 'Editar alumno',
      wide: true,
      body: camposAlumno(a, cursos, d.hoy),
      onSubmit: async (data) => {
        await api('/api/alumnos/' + id, { method: 'PUT', body: datosDeForm(data) });
        toast('Legajo actualizado');
        reload();
      },
    });
    bindSugerenciaCurso(d.hoy);
  });
  $('#baja')?.addEventListener('click', () => openModal({
    title: `Dar de baja a ${a.nombre} ${a.apellido}`,
    submit: 'Confirmar baja',
    body: h`<div class="form-grid">
      <label class="field">Fecha de baja<input name="fecha" type="date" value="${d.hoy}" max="${d.hoy}" required></label>
      <label class="field">Motivo<select name="motivo" required>${d.motivos_baja.map((m) => h`<option>${m}</option>`)}</select></label>
    </div><p class="small muted">El legajo se conserva. Desde el próximo período no se le generan cuotas; la deuda existente se mantiene.</p>`,
    onSubmit: async (data) => {
      await api(`/api/alumnos/${id}/baja`, { method: 'POST', body: data });
      toast('Baja registrada');
      reload();
    },
  }));
  $('#reinc')?.addEventListener('click', async () => {
    try {
      await api(`/api/alumnos/${id}/reincorporar`, { method: 'POST' });
      toast('Alumno reincorporado');
      reload();
    } catch (e) { toast(e.message); }
  });
}

// ---------- Cursos y asistencia ----------
async function pageCursos(arg) {
  if (arg) return pageCurso(Number(arg));
  const { cursos } = await api('/api/cursos');
  const tot = cursos.reduce((a, c) => a + c.inscriptos, 0), cap = cursos.reduce((a, c) => a + c.capacidad, 0);
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Gestión escolar</div><h1>Cursos y asistencia</h1>
      <p>${cursos.length} cursos · ${tot} alumnos activos · ocupación ${pct(tot / (cap || 1), 0)} (${cap - tot} vacantes). Entrá a un curso para tomar asistencia.</p>
    </div><button class="btn primary" id="nuevo-curso">+ Nuevo curso</button></div>
    <div class="grid g-3">
      ${cursos.map((c) => h`<a class="card curso" href="#/cursos/${c.id}">
        <div class="curso-top"><span class="curso-nombre">${c.nombre}</span><span class="pill plain">${TURNO_LBL[c.turno]}</span></div>
        <div class="small muted">${c.docente || 'Docente sin asignar'}</div>
        <div class="ocup"><span class="bar"><i style="width:${Math.min(100, (c.inscriptos / c.capacidad) * 100)}%"></i></span><span class="num small">${c.inscriptos}/${c.capacidad}</span></div>
        <div class="curso-stats small">
          <span>${c.vacantes} vacante(s)</span><span>${c.mujeres} F · ${c.varones} M</span>
          <span>Edad prom. ${nf(c.edad_promedio)}</span><span>Asistencia ${c.asistencia_pct == null ? '—' : pct(c.asistencia_pct, 0)}</span>
        </div>
      </a>`)}
    </div>`);
  $('#nuevo-curso').addEventListener('click', () => modalCurso());
}

function modalCurso(c) {
  openModal({
    title: c ? `Editar ${c.nombre}` : 'Nuevo curso',
    body: h`<div class="form-grid">
      ${c ? '' : h`<label class="field">Grado<select name="grado">${[1, 2, 3, 4, 5, 6, 7].map((g) => h`<option value="${g}">${g}°</option>`)}</select></label>
        <label class="field">Sección<input name="seccion" maxlength="1" required placeholder="A, B, C…" style="text-transform:uppercase"></label>`}
      <label class="field">Turno<select name="turno">${Object.entries(TURNO_LBL).map(([k, l]) => h`<option value="${k}" ${c?.turno === k ? 'selected' : ''}>${l}</option>`)}</select></label>
      <label class="field">Cupo<input name="capacidad" type="number" min="1" max="60" value="${c?.capacidad ?? 25}" required></label>
      <label class="field full">Docente a cargo<input name="docente" value="${c?.docente || ''}"></label>
    </div>`,
    onSubmit: async (data) => {
      if (c) await api('/api/cursos/' + c.id, { method: 'PUT', body: data });
      else await api('/api/cursos', { method: 'POST', body: data });
      toast(c ? 'Curso actualizado' : 'Curso creado');
      reload();
    },
  });
}

let fechaAsistencia = null;
async function pageCurso(id) {
  const d = await api(`/api/cursos/${id}${fechaAsistencia ? '?fecha=' + fechaAsistencia : ''}`);
  const c = d.curso;
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow"><a href="#/cursos">Cursos</a> / ${c.nombre}</div>
      <h1>${c.nombre} · Turno ${TURNO_LBL[c.turno].toLowerCase()}</h1>
      <p>Docente: ${c.docente || 'sin asignar'} · ${c.inscriptos} de ${c.capacidad} alumnos · Asistencia de los últimos 30 días: ${c.asistencia_pct == null ? '—' : pct(c.asistencia_pct, 1)}</p>
    </div>
    <div class="btn-row"><button class="btn" id="editar-curso">Editar curso</button><button class="btn" id="alta-curso">+ Alta de alumno</button></div></div>
    <form class="card" id="form-asis">
      <div class="card-head">
        <div><h2>Asistencia del día</h2><p>${d.tomada ? 'Ya se tomó asistencia en esta fecha: podés corregirla.' : 'Todavía no se tomó asistencia en esta fecha.'}</p></div>
        <div class="btn-row">
          <input type="date" id="asis-fecha" value="${d.fecha}" max="${d.hoy}" aria-label="Fecha" style="width:auto">
          <button type="button" class="btn sm" id="todos-presentes">Todos presentes</button>
        </div>
      </div>
      ${d.fin_de_semana ? h`<div class="notice">La fecha elegida es fin de semana.</div>` : ''}
      ${d.alumnos.length ? h`<div class="table-wrap"><table>
        <thead><tr><th>Alumno</th><th>Asistencia</th><th>Justificada</th><th class="r">Edad</th><th>Últimos 30 días</th></tr></thead>
        <tbody>${d.alumnos.map((a) => {
          const est = a.dia?.estado || 'presente';
          return h`<tr data-alumno="${a.id}">
            <td><a href="#/alumnos/${a.id}"><b>${a.apellido}, ${a.nombre}</b></a></td>
            <td><div class="seg asis" role="radiogroup" aria-label="Asistencia de ${a.nombre}">
              ${[['presente', 'P', 'Presente'], ['ausente', 'A', 'Ausente'], ['tarde', 'T', 'Tarde']].map(([k, l, t]) => h`<label class="seg-opt" title="${t}"><input type="radio" name="e-${a.id}" value="${k}" ${est === k ? 'checked' : ''}> ${l}</label>`)}
            </div></td>
            <td><input type="checkbox" name="j-${a.id}" ${a.dia?.justificada ? 'checked' : ''} aria-label="Falta justificada" ${est === 'ausente' ? '' : 'disabled'}></td>
            <td class="r num">${a.edad ?? '—'}</td>
            <td>${pctPill(a.asistencia_pct)} <span class="small muted">${a.ausentes_30} falta(s)</span></td>
          </tr>`;
        })}</tbody></table></div>
        <div class="btn-row mt"><button class="btn primary" ${d.fin_de_semana ? 'disabled' : ''}>Guardar asistencia</button><span class="small muted" id="asis-resumen"></span></div>`
        : h`<div class="empty">El curso no tiene alumnos activos.</div>`}
    </form>`);

  const resumen = () => {
    const vals = $$('tr[data-alumno]').map((tr) => $('input[type=radio]:checked', tr)?.value);
    const n = (k) => vals.filter((v) => v === k).length;
    if ($('#asis-resumen')) $('#asis-resumen').textContent = `${n('presente')} presentes · ${n('ausente')} ausentes · ${n('tarde')} tarde`;
  };
  $$('tr[data-alumno]').forEach((tr) => $$('input[type=radio]', tr).forEach((r) => r.addEventListener('change', () => {
    const j = $('input[type=checkbox]', tr);
    j.disabled = r.value !== 'ausente';
    if (j.disabled) j.checked = false;
    resumen();
  })));
  resumen();
  $('#asis-fecha').addEventListener('change', (e) => { fechaAsistencia = e.target.value; pageCurso(id); });
  $('#todos-presentes').addEventListener('click', () => {
    $$('tr[data-alumno]').forEach((tr) => { $('input[value=presente]', tr).checked = true; const j = $('input[type=checkbox]', tr); j.checked = false; j.disabled = true; });
    resumen();
  });
  $('#form-asis').addEventListener('submit', async (e) => {
    e.preventDefault();
    const registros = $$('tr[data-alumno]').map((tr) => ({
      alumno_id: Number(tr.dataset.alumno),
      estado: $('input[type=radio]:checked', tr).value,
      justificada: $('input[type=checkbox]', tr).checked,
    }));
    try {
      const r = await api(`/api/cursos/${id}/asistencia`, { method: 'POST', body: { fecha: $('#asis-fecha').value, registros } });
      toast(`Asistencia guardada (${r.guardados} alumnos)`);
      fechaAsistencia = $('#asis-fecha').value;
      pageCurso(id);
    } catch (err) { toast(err.message); }
  });
  $('#editar-curso').addEventListener('click', () => modalCurso(c));
  $('#alta-curso').addEventListener('click', () => openAltaAlumno());
}

// ---------- Estadística descriptiva ----------
function fmtStat(v, unidad) {
  if (v == null) return '—';
  if (unidad === '$') return money(v);
  if (unidad === '%') return nf(v, 1) + '%';
  return nf(v, 2);
}

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
  main.innerHTML = String(h`
    <div class="page-head"><div>
      <div class="eyebrow">Estadística descriptiva · ciclo ${s.ciclo}</div><h1>Estadísticas de la escuela</h1>
      <p>Matrícula, familias, cobranza y asistencia al ${fdate(s.hoy)}. Cada tabla se puede descargar en CSV.</p>
    </div></div>

    <div class="grid g-3">
      <div class="card kpi"><span class="label">Matrícula activa</span><span class="value">${m.total}</span><span class="sub">${m.altas_ciclo} altas y ${m.bajas_ciclo} bajas en el ciclo (tasa de bajas ${pct(m.tasa_bajas, 1)})</span></div>
      <div class="card kpi"><span class="label">Ocupación de cursos</span><span class="value">${pct(m.ocupacion, 0)}</span><span class="sub">${m.vacantes} vacantes disponibles</span></div>
      <div class="card kpi"><span class="label">Asistencia media</span><span class="value">${as.pct.n ? nf(as.pct.media, 1) + '%' : '—'}</span><span class="sub">${as.cronico} alumno(s) por debajo del 90% en 30 días</span></div>
    </div>

    <div class="card mt">
      <div class="card-head"><div><h2>Resumen de variables numéricas</h2><p>Medidas de posición, dispersión y forma</p></div>${csvBtn('t-resumen', 'resumen-variables')}</div>
      <div class="table-wrap"><table id="t-resumen">
        <thead><tr><th>Variable</th><th class="r">n</th><th class="r">Media</th><th class="r">Mediana</th><th class="r">Moda</th><th class="r">Desvío</th><th class="r">CV</th><th class="r">Mín.</th><th class="r">P25</th><th class="r">P75</th><th class="r">Máx.</th><th class="r">Asimetría</th></tr></thead>
        <tbody>${s.resumen.map((r) => h`<tr><td><b>${r.variable}</b><div class="small muted">${r.unidad}</div></td><td class="r num">${r.n}</td>
          ${r.n ? h`<td class="r num">${fmtStat(r.media, r.unidad)}</td><td class="r num">${fmtStat(r.mediana, r.unidad)}</td><td class="r num">${fmtStat(r.moda, r.unidad)}</td>
            <td class="r num">${fmtStat(r.desvio, r.unidad)}</td><td class="r num">${r.cv == null ? '—' : pct(r.cv, 0)}</td><td class="r num">${fmtStat(r.min, r.unidad)}</td>
            <td class="r num">${fmtStat(r.p25, r.unidad)}</td><td class="r num">${fmtStat(r.p75, r.unidad)}</td><td class="r num">${fmtStat(r.max, r.unidad)}</td><td class="r num">${nf(r.asimetria, 2)}</td>`
            : h`<td colspan="10" class="muted">Sin datos</td>`}</tr>`)}
        </tbody></table></div>
      <details class="glosario"><summary>¿Cómo leer esta tabla?</summary>
        <p><b>Media</b>: promedio. <b>Mediana</b>: el valor del medio (la mitad está por debajo). <b>Moda</b>: el valor más frecuente.
        <b>Desvío</b>: cuánto se alejan los valores del promedio, en la misma unidad. <b>CV</b> (coeficiente de variación): desvío ÷ media; permite comparar variables distintas.
        <b>P25 y P75</b>: el 25% y el 75% de los casos está por debajo de esos valores. <b>Asimetría</b>: positiva si hay una cola de valores altos (por ejemplo, pocos atrasos muy largos), cercana a 0 si es simétrica.</p>
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
        <div class="card-head mt"><div><h2>Motivos de baja en el ciclo</h2></div></div>${tablaFrecuencias('t-bajas', m.motivos_baja, 'Motivo')}</div>
    </div>

    <h2 class="section-title">Familias</h2>
    <div class="grid g-2">
      <div class="card"><div class="card-head"><div><h2>Hijos por familia</h2><p>Media ${nf(fa.hijos.media, 2)} · desvío ${nf(fa.hijos.desvio, 2)}</p></div></div>${tablaFrecuencias('t-hijos', fa.hijos_frec, 'Hijos')}</div>
      <div class="card"><div class="card-head"><div><h2>Medios de pago</h2></div>${csvBtn('t-medios', 'medios-de-pago')}</div>${tablaFrecuencias('t-medios', fa.medios_pago, 'Medio')}</div>
      <div class="card"><h2>Becas</h2>
        <div class="kpi mt"><span class="value">${fa.becas.alumnos}</span><span class="sub">alumnos becados (${pct(fa.becas.pct, 1)} de la matrícula)</span></div>
        <p class="small">Beca promedio: <b>${fa.becas.porcentaje.n ? nf(fa.becas.porcentaje.media, 1) + '%' : '—'}</b></p>
        <p class="small">Cuota familiar: mediana <b>${money(fa.cuota.mediana)}</b>, entre ${money(fa.cuota.min)} y ${money(fa.cuota.max)}.</p></div>
    </div>

    <h2 class="section-title">Cobranza · últimos 12 meses</h2>
    <div class="grid g-2">
      <div class="card"><div class="card-head"><div><h2>Distribución de los días de atraso</h2><p>${co.cuotas} cuotas vencidas · mediana ${nf(co.atraso.mediana)} días · P90 ${nf(co.atraso.p90)} días</p></div>${csvBtn('t-atraso', 'distribucion-atraso')}</div>
        <div id="ch-atraso"></div>${tablaFrecuencias('t-atraso', co.atraso_hist, 'Días de atraso')}</div>
      <div class="card"><div class="card-head"><div><h2>Distribución del puntaje de riesgo</h2><p>Familias activas · media ${nf(co.puntaje.media)} · mediana ${nf(co.puntaje.mediana)}</p></div>${csvBtn('t-puntaje', 'distribucion-puntaje')}</div>
        <div id="ch-puntaje"></div>${tablaFrecuencias('t-puntaje', co.puntaje_hist, 'Puntaje')}</div>
    </div>
    <div class="grid g-2 mt">
      <div class="card"><div class="card-head"><div><h2>Atraso según medio de pago</h2><p>Días de atraso por cuota</p></div>${csvBtn('t-atraso-medio', 'atraso-por-medio')}</div>
        ${tablaGrupos('t-atraso-medio', co.atraso_por_medio, 'días', 'Medio de pago')}</div>
      <div class="card"><div class="card-head"><div><h2>¿El puntaje anticipa el atraso?</h2><p>Correlación de Pearson (r)</p></div></div>
        <div class="gauge"><span class="big num">${co.correlacion.r == null ? '—' : nf(co.correlacion.r, 2)}</span>
          <p class="small" style="margin:0">Entre el puntaje calculado 10 días antes de cada vencimiento y los días de atraso reales, sobre ${co.correlacion.n} cuotas de los últimos 6 meses: <b>${interpretarR(co.correlacion.r)}</b>.</p></div>
        <p class="small muted">r va de −1 a 1: cerca de 0 no hay relación; cuanto más cerca de 1, mejor ordena el puntaje a las familias según su atraso.</p>
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
