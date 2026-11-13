# EP: Historial de disponibilidad de Valenbisi

## Estado

Implementación incluida en este repositorio: PostgreSQL persistente, worker independiente en Docker Compose y endpoint histórico autenticado. La captura empieza al iniciar el worker y continúa alineada cada 20 minutos mientras el servicio esté activo. El visualizador no forma parte del proyecto.

## Objetivo

Guardar disponibilidad histórica de bicicletas y anclajes de Valenbisi, con una captura cada 20 minutos, y exponerla mediante una API para que una aplicación independiente pueda generar mapas de calor y animar los cambios entre distintas horas y días.

## Arquitectura

Este repositorio ya tiene un frontend y un backend Node.js con una API versionada (`/api/v1`). Hoy consulta y almacena datos principalmente en caché de proceso; no conserva snapshots históricos.

- Un worker backend independiente del proceso HTTP consulta la fuente cada 20 minutos, aunque no haya usuarios conectados.
- PostgreSQL conserva los snapshots en el volumen Docker `valenbisi-history`; no hay borrado automático. Deben realizarse backups regulares.
- La API existente expone el histórico con autenticación. La aplicación que dibuja el mapa de calor es un consumidor aparte y no forma parte de este EP.

## Datos por estación y captura

Cada snapshot debe guardar el identificador estable y coordenadas de la estación, bicicletas disponibles, anclajes libres, capacidad, estado de servicio, timestamp de la fuente si existe, timestamp de captura del worker y metadatos de origen/calidad.

Una consulta fallida o incompleta no debe crear un snapshot con valores cero ni inventar disponibilidad. Los reintentos deben ser idempotentes, y los fallos deben quedar observables sin detener las siguientes ejecuciones.

## Alcance

- Implementar el worker periódico con intervalo configurable por entorno y valor predeterminado de 20 minutos; evitar ejecuciones solapadas.
- Persistir los datos con una clave que permita reintentar sin duplicar la misma estación/captura.
- Definir una política de retención de largo plazo basada en el volumen estimado, sin borrar datos necesarios para comparar días.
- Añadir lecturas históricas autenticadas con filtros de fechas y estación, metadatos de cobertura y límites/paginación o agregaciones para controlar respuestas grandes.
- Expresar timestamps en UTC y documentar cómo consultar e interpretar la hora local `Europe/Madrid`, incluidos los cambios de horario, para comparar horas del día.
- Documentar el contrato, despliegue, configuración, monitorización y límites/condiciones de la fuente.

## Criterios de aceptación

1. Se captura el estado disponible de todas las estaciones cada 20 minutos, con independencia de las sesiones del navegador.
2. Reinicios y reintentos no generan snapshots duplicados para la misma estación y ciclo.
3. Las respuestas incompletas o fallidas se identifican como fallos; nunca se confunden con disponibilidad cero.
4. El histórico sobrevive reinicios y permite consultar varias fechas, estaciones y horas con timestamps y cobertura explícitos.
5. La API valida parámetros, conserva la autenticación y CORS configurados, y limita el tamaño de las consultas.
6. Hay pruebas de captura normal, idempotencia, fallo de fuente, persistencia, límites temporales y endpoints; OpenAPI y despliegue describen el nuevo flujo.
7. El frontend actual no incorpora el mapa de calor: la API puede ser consumida por otra aplicación.

## Fuera de alcance

- Visualización, mapa de calor y animación de la aplicación consumidora.
- Históricos de buses u otros operadores.
- Inferir o completar datos de disponibilidad que Valenbisi no publique.

## Operación y límites

- El worker no solapa ejecuciones y usa un lock de PostgreSQL para impedir capturas concurrentes.
- Los errores de fuente/persistencia quedan registrados; los periodos sin datos no se rellenan con valores inventados ni se reconstruyen tras una caída.
- Cada snapshot conserva por separado el slot UTC, el momento de captura y el timestamp de la fuente cuando está disponible.
- La API limita cada página a 5000 filas, ofrece cursor y reporta el estado/cobertura de la captura más reciente.
- Antes de desplegar, configurar `HISTORY_DB_PASSWORD`, verificar las condiciones de uso/límites de la fuente y preparar backups del volumen.
