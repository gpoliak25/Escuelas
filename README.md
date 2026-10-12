# Gestión escolar que anticipa la morosidad · MVP

MVP de la propuesta *"Gestión escolar y morosidad"* (octubre 2026): un sistema para escuelas primarias que detecta el riesgo de atraso **antes** del vencimiento y ordena la cobranza con criterio y cuidado por las familias.

## Cómo correrlo

Requiere **Node.js 22.13 o superior** (usa el SQLite integrado de Node: no hay dependencias que instalar).

```bash
npm start          # http://localhost:3000  (administración)
                   # http://localhost:3000/portal  (portal de familias)
npm test           # tests del motor de riesgo, pagos, planes y bandeja
npm run seed       # vuelve a cargar los datos de demostración
```

La primera vez se crea `data/escuela.db` con **64 familias ficticias** y un año y medio de historia (perfiles puntuales, de pago justo, de atraso corto, morosos y familias que empeoran), para que el motor y el tablero tengan algo que mostrar. Para entrar al portal, usá el **código de portal** que figura en el legajo de cualquier familia.

Variables opcionales: `PORT` (puerto) y `DB_PATH` (ruta de la base).

## Qué cubre de la presentación

| Slide | En el MVP |
|---|---|
| **Seis módulos, un solo legajo** | Alumnos y familias · Cuotas y facturación · Cobranza y comunicación · Motor predictivo · Tablero directivo · Portal de familias |
| **Anticipar** – señales | Las 7 señales (historial, deuda actual, momento del pago, medio de pago, vínculo, portal, estacionalidad) suman puntos en `src/risk.js`. |
| **Motor predictivo** | Puntaje 0–100 por familia, nivel bajo/medio/alto y **motivo principal**. Versión por reglas explicables, como propone la slide 7. |
| **Prevenir** – una acción por nivel | Bajo: mail 3 días antes · Medio: WhatsApp 7 días antes, ofrece débito o cambio de fecha · Alto: llamada 10 días antes y plan a medida. |
| **Gestionar** – escalera en 5 etapas | La *Bandeja de cobranza* propone para hoy la etapa que corresponde a cada familia (prevención → vencimiento → contacto +5 → plan +15 → reunión +30), con mensaje editable, links de WhatsApp/mail y opción de omitir. |
| **Aprender** – 6 indicadores | Tasa de morosidad, días de atraso, cartera en riesgo, recupero por etapa, precisión de alertas (backtest) y planes cumplidos. |
| **Principios de uso** | El puntaje sólo sugiere; toda acción la confirma una persona y queda registrada (también las omitidas). No hay campos de salud, religión ni ideología. Consentimiento (Ley 25.326) en el legajo. Nada referido a la deuda se muestra a los chicos. |

### Gestión escolar

| Módulo | Qué hace |
|---|---|
| **Alumnos** | Listado con filtros (curso, turno, género, estado) y exportación a CSV. **Alta de alumno** con DNI (único), fecha de nacimiento (sugiere el grado), curso con control de cupo, fecha de ingreso y beca; la familia se elige de las existentes o se crea en el mismo paso. Legajo con datos personales, escolaridad, hermanos y asistencia. **Pase de sección**, **baja** (fecha y motivo) y **reincorporación**. |
| **Cursos y asistencia** | Cursos por grado y sección con turno, docente y cupo (ocupación y vacantes). Toma de asistencia diaria por curso (presente, ausente, tarde y falta justificada), corregible. La asistencia **no** se usa para el puntaje de cobranza. |
| **Estadísticas** | Estadística descriptiva: tabla resumen (n, media, mediana, moda, desvío, coeficiente de variación, mín., P25, P75, máx., asimetría) de edad, hijos por familia, cuota, beca, días de atraso, puntaje de riesgo y asistencia; tablas de frecuencia absoluta/relativa/acumulada; histogramas; medidas por grupo (edad por grado, atraso por medio de pago, asistencia por grado); correlación de Pearson entre puntaje y atraso real. Todas las tablas se descargan en CSV. |

**Fecha simulada** (en *Configuración*): permite ver el sistema "como si hoy fuera" otra fecha, útil para demos.

## Estructura

```
server.js          servidor HTTP (API JSON + archivos estáticos)
src/db.js          esquema SQLite, configuración y utilidades de fechas
src/risk.js        motor de riesgo por reglas
src/domain.js      estado de cuotas, escalera de cobranza, indicadores
src/services.js    altas, pagos, planes, comunicaciones (con validación)
src/api.js         rutas de la API
src/escolar.js     alumnos, cursos y asistencia
src/stats.js       estadística descriptiva
src/seed.js        datos de demostración
public/            administración (index.html, app.js, escolar.js) y portal (portal.html, portal.js)
test/              tests con node:test
```

## Qué falta para producción

Es un MVP para validar la idea con una escuela; antes de usarlo con datos reales hace falta:

- **Autenticación**: usuarios para administración y login real de familias (hoy el portal entra sólo con un código).
- **Integraciones**: pasarela de pago (el pago online está simulado), débito automático/CBU, envío real de mail y WhatsApp Business (hoy se abren `mailto:` / `wa.me` y se registra la acción).
- **Calibrar el modelo** con el historial real de la escuela (las señales son hipótesis iniciales) y, con datos suficientes, pasar a un modelo estadístico.
- **Política de la escuela**: intereses/recargos por mora, matrícula, plazos y canales propios.
- Backups, auditoría de accesos y un aviso de privacidad formal para las familias.
