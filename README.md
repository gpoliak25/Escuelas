# Gestión escolar que anticipa la morosidad · MVP

MVP de la propuesta *"Gestión escolar y morosidad"* (octubre 2026): un sistema para escuelas primarias que detecta el riesgo de atraso **antes** del vencimiento y ordena la cobranza con criterio y cuidado por las familias.

## Cómo correrlo

Requiere **Node.js 22.13 o superior** (usa el SQLite integrado de Node: no hay dependencias que instalar).

```bash
npm start          # http://localhost:3000  (administración)
                   # http://localhost:3000/portal  (portal de familias)
npm test           # 22 tests: riesgo, ML, cobros, cuenta corriente, recargos, promesas, débitos, escolar
npm run seed       # vuelve a cargar los datos de demostración
```

La primera vez se crea `data/escuela.db` con **64 familias ficticias** y un año y medio de historia (perfiles puntuales, de pago justo, de atraso corto, morosos y familias que empeoran), para que el motor y el tablero tengan algo que mostrar. Para entrar al portal, usá el **código de portal** que figura en el legajo de cualquier familia.

Variables opcionales: `PORT` (puerto) y `DB_PATH` (ruta de la base).

**Documentación:** [docs/documentacion-tecnica.html](docs/documentacion-tecnica.html) (arquitectura, modelo de datos, reglas, ML, API y pendientes para producción) y [docs/motor-predictivo.html](docs/motor-predictivo.html) (cálculo del puntaje de riesgo).

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

### Gestión integral de cobranzas

| Módulo | Qué hace |
|---|---|
| **Cobros con recibo** | Cobro a nivel familia con recibo numerado (punto de venta configurable). Imputación automática a la deuda más antigua (el recargo se cancela junto a su cuota) o eligiendo los cargos; pagos parciales; el excedente queda como **saldo a favor** y se aplica solo a las cuotas nuevas. Anulación de comprobantes con motivo. |
| **Cuenta corriente** | Debe, haber y saldo de cada familia (cargos, recibos, notas de crédito y refinanciaciones), próximos vencimientos, **estado de cuenta** y **certificado de libre deuda** imprimibles. |
| **Recargos por mora** | Porcentaje mensual sobre el saldo de cada cuota impaga, después de los días de gracia; se liquidan sin duplicarse. Se pueden **condonar** (nota de crédito), uno por uno o al acordar un plan. |
| **Cargos y notas de crédito** | Cargos adicionales (matrícula, materiales, excursiones) para una familia o masivos (por familia o por alumno, con filtro por grado). Notas de crédito para bonificaciones y correcciones. |
| **Promesas de pago** | Se registran desde la bandeja o la ficha; mientras están vigentes la familia sale de la bandeja; si vencen sin el pago vuelven con prioridad como "promesa incumplida". |
| **Débito automático** | Lote por período con las familias adheridas, archivo para el banco y registro del resultado (acreditados y rechazados con motivo); historial de lotes. |
| **Caja y deudores** | Cobros por período y medio de pago, con gráfico diario y CSV. Deudores por antigüedad (1–30, 31–60, 61–90, +90 días) con recargos, promesas y último cobro. |
| **Tablero** | Cobrado en el mes, efectividad del último período, promesas vigentes e incumplidas, recargos adeudados y saldos a favor. |

### Inteligencia de cobranza (machine learning)

Pantalla **Inteligencia (ML)**, con los ocho aportes de la presentación. Todo se calcula con los datos del sistema y se recalcula solo cuando cambian (`src/ml.js`).

| Aporte | En la demo |
|---|---|
| **1 · Predicción de riesgo** | Regresión logística entrenada con el historial (pagos, atrasos, medio de pago, hijos, antigüedad, cuotas extra, estacionalidad, contacto). Se valida con un backtest temporal contra el motor por reglas (AUC, precisión y cobertura) y explica cada probabilidad con sus motivos principales. |
| **2-3 · Segmentos y contacto** | Pagador puntual, tardío recurrente (con detección de patrón estacional), dificultad transitoria y riesgo de deuda crónica, cada uno con su estrategia de contacto; el segmento se ve en la bandeja y en la ficha. |
| **4 · Priorización** | Las familias a contactar esta semana: deuda × probabilidad de recuperarla en 30 días (segundo modelo, de recupero) y familias al día con alto riesgo, para prevenir. |
| **5 · Flujo de caja** | Cobrado real de los últimos 6 meses y proyección de los próximos 3 según el patrón de cobro de cada segmento y el modelo de recupero. |
| **6 · Anomalías** | Cambios bruscos de comportamiento, subidas fuertes del riesgo, importes que no coinciden con alumnos/becas/descuentos y cobros duplicados. |
| **7 · Riesgo de baja** | Cruce de deuda, inasistencias, reclamos y pedidos de pase (registrables en la ficha), para que dirección acompañe; nunca condiciona la asistencia. |
| **8 · Escenarios** | Simulador de aumento de cuota (en uno o dos tramos), descuento por pago anticipado y plan temprano, con los supuestos a la vista y editables. |

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
src/services.js    familias, cuotas, planes, comunicaciones (con validación)
src/cobranzas.js   cobros, imputación, saldo a favor, recargos, cargos, promesas, débito automático
src/documentos.js  recibo, estado de cuenta y libre deuda imprimibles
src/api.js         rutas de la API
src/escolar.js     alumnos, cursos y asistencia
src/stats.js       estadística descriptiva
src/ml.js          inteligencia de cobranza (modelos, segmentos, proyección, anomalías, escenarios)
src/seed.js        datos de demostración
public/            administración (index.html, app.js, escolar.js, cobranzas.js, ml.js) y portal (portal.html, portal.js)
test/              tests con node:test
```

## Qué falta para producción

Es un MVP para validar la idea con una escuela; antes de usarlo con datos reales hace falta:

- **Autenticación**: usuarios para administración y login real de familias (hoy el portal entra sólo con un código).
- **Integraciones**: pasarela de pago (el pago online está simulado), débito automático/CBU, envío real de mail y WhatsApp Business (hoy se abren `mailto:` / `wa.me` y se registra la acción).
- **Calibrar el modelo** con el historial real de la escuela (las señales son hipótesis iniciales) y, con datos suficientes, pasar a un modelo estadístico.
- **Facturación electrónica** (AFIP/ARCA) si la escuela necesita emitir facturas además de los recibos internos.
- **Formato del archivo de débito** de cada banco (CBU de las familias) y lectura automática del archivo de respuesta.
- **Política de la escuela**: porcentaje de recargo, días de gracia, plazos y canales propios.
- Backups, auditoría de accesos y un aviso de privacidad formal para las familias.
