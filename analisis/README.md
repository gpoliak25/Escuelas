# Análisis de morosidad en Python

`analisis_morosidad.py` hace el mismo análisis que la pantalla **Estadística → Análisis de morosidad** del sistema: validación de datos, estadística descriptiva, tests inferenciales a nivel familia (con corrección de Holm), curva ROC del puntaje de riesgo, tres análisis de Pareto y `conclusiones.md`.

## Cómo correrlo

```bash
pip install -r requirements.txt                 # pandas, numpy, scipy, statsmodels, matplotlib, openpyxl
npm run export:dataset                          # desde la raíz del proyecto: deja datos/alumnos.csv, familias.csv y cuotas.csv
python analisis_morosidad.py                    # desde esta carpeta; sin datos usa un dataset sintético (o forzalo con --sintetico)
```

Los datos también se bajan desde la app (botón **Exportar dataset para Python**). Otras entradas: `--alumnos/--familias/--cuotas` con rutas propias, o `--archivo datos.xlsx` (Excel con hojas `alumnos`, `familias` y `cuotas`, o una sola tabla plana). Si tus columnas tienen otros nombres, ajustá `CONFIG["COLUMNAS"]` al principio del script.

Salida en `./resultados/`: `validacion.csv`, `descriptiva.csv` y `.xlsx`, `inferencial.csv`, `roc.png`, `pareto_{atraso,deuda,puntaje}.png` y `.csv`, y `conclusiones.md`. Al final, la consola muestra qué se generó y qué se omitió, y por qué.

## Supuestos tomados donde faltaba información

- **Ventana de cuotas:** las vencidas en los últimos 12 meses, sin las cuotas de planes de pago (la misma base que la estadística descriptiva). Los recargos por mora cuentan como cuotas.
- **Monto adeudado por cuota:** el saldo impago de las cuotas vencidas; la deuda que se pasó a un plan de pagos no se cuenta.
- **Atraso por familia:** los tests y las correlaciones usan el **atraso máximo**; el Pareto usa los **días acumulados**.
- **Beca a nivel familia:** "con beca" si al menos un hijo tiene beca mayor a 0.
- **Asistencia de la familia:** promedio de la asistencia de los hijos en los últimos 30 días, con cortes en 90% y 95% (configurables).
- **Hijos por familia:** grupos 1, 2 y "3 o más"; si un grupo queda con menos de 3 familias, se une al anterior.
- **Familias analizadas:** sólo las que tienen al menos una cuota vencida en la ventana y puntaje calculado.
- **Chi cuadrado:** con corrección de Yates en tablas 2×2 (como scipy). La V de Cramér se calcula sin esa corrección. El Monte Carlo usa 10.000 permutaciones con márgenes fijos.
- **Mann-Whitney:** aproximación normal con corrección por empates y de continuidad (los atrasos tienen muchos empates en cero, así que el test exacto no aplica).
- **Holm:** se aplica sobre los 9 cruces juntos. La ROC queda fuera del ajuste porque informa un intervalo de confianza, no un p-valor.
- **Cruces circulares:** el puntaje actual incluye la deuda y el historial de pagos, así que sus cruces con la morosidad y su AUC son optimistas. Se marcan con "valida el puntaje".
- **Excel:** los números se guardan como números con formato (`$ #,##0` en montos). La coma decimal la pone la configuración regional de Excel; en los CSV se escribe siempre con coma y `;`.
- **Datos sintéticos:** 64 familias, entre 1 y 4 hijos, y una propensión al atraso lognormal (muchos ceros y una cola larga). Sólo sirven para probar el pipeline.

Los tests deterministas dan lo mismo que en la app. Los que usan azar (Monte Carlo y bootstrap) pueden diferir en el tercer decimal, porque cada uno usa su propio generador.
