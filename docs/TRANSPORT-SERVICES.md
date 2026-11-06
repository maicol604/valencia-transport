# Servicios de transporte

## Organización

```text
public/js/services/
  index.js          Registro de proveedores para la interfaz
  emt.js            Contrato de EMT para el mapa
  emt-api.js        Scraping SAE, WFS y caché de EMT
  atmv.js           Met Go: paradas, líneas, shapes, ETA y coordenadas ALMEX
  metro.js          Metrovalencia: mapa embebido y próximas llegadas
  cercanias.js      Renfe: vinculación de GPS/ETA con viajes y estaciones
  shapes.js         Utilidades de geometría para GTFS/mapas
  transport.js      Conexión directa/proxy y caché por proveedor

services/
  emt.mjs           Proxy y caché WFS de EMT
  atmv.mjs          Proxy de endpoints públicos Met Go
  metro.mjs         Scraping HTTP de FGV, caché de mapa y cadena TLS
  cercanias.mjs     GTFS nacional → red de València; feeds GTFS-RT
  shared.mjs        HTTP, validación y caché
  index.mjs         Registro de handlers de backend
  gateway.mjs       Resolución a módulo local o proceso independiente
  serve.mjs         Arranque de un único operador
  certs/            Certificado intermedio público de Sectigo
```

`app.js` mantiene selección, presentación, capas y polling; los adaptadores normalizan las fuentes. El cambio de operador incrementa una generación de red y de selección, aborta la consulta de llegadas y descarta resultados geográficos tardíos. Las colas antiguas dejan de lanzar trabajo; los datos de un operador no pueden sobrescribir los de otro aunque compartan números de línea o parada.

## Contrato de frontend

Cada entrada de `providers` expone:

```js
{
  id, name, color, symbol, kind, interval, speed, preloadRoutes,
  description, source,
  getNetwork(),                        // { stops, lines }
  getModels(line),                      // modelos geométricos
  getArrivals(stop, signal),            // llegadas normalizadas
  getStopLines?.(stop, signal),          // líneas sin necesidad de ETA
  getApproach(models, stop, arrival),   // sentido y distancia acumulada, o null
}
```

- Parada: `{ id, name, coords: [lon, lat], lines?: string[] }`.
- Línea: `{ id, name, color?, ...datosPrivadosDelAdaptador }`.
- Modelo: `{ paths, features, stopIds: Set, allowEstimate? }`.
- Llegada: `{ line, destination, raw, arrivalAt, observedAt, programmed, vehicleId?, position?, positionNote? }`.
- `arrivalAt` puede ser `null` si solo se conoce la posición, sin previsión para la estación.
- `position`: `{ coords, kind: 'gps' | 'reported', timestamp, receivedAt }`.
- `timestamp` es la hora de **medición de la fuente**, nunca se rellena con la hora de consulta; si falta se mantiene `null`.
- Sin `position`, la interfaz puede calcular una estimación mediante `getApproach`. Cercanías devuelve `null` para esa operación: no se inventa un tren a partir de un horario.
- Los tiempos son milisegundos Unix. Las posiciones caducan a los 90 segundos de medición o recepción según los datos disponibles, y las ETAs también caducan.
- Las velocidades por defecto son hipótesis de visualización, no velocidades observadas: EMT 12, ATMV 20 y Metro 30 km/h.

Para añadir o sustituir una fuente se modifica su adaptador y, si necesita intermediario, su handler; no es necesario reescribir la interfaz. Los errores de fuente se propagan al panel; una caída no se sustituye por datos simulados.

## Fuentes comprobadas

### EMT

- `https://geoportal.emtvalencia.es/EMT/mapfunctions/MapUtilsPetitions.php?sec=getSAE&parada=...&nocache=...`
- WFS `https://geoportal.emtvalencia.es/geoserver/emt/wfs`.
- Los endpoints históricos `/api/sae` y `/api/wfs` se conservan; también están disponibles bajo `/api/providers/emt/`.
- Lógica basada en `../EMT-Services/scrapping_service.py` y `geo_service.py`.

### ATMV / Met Go

`metgovalencia.com` incrusta `https://metrobus.softoursistemas.com/`. Su frontend público consulta:

```text
https://api.softoursistemas.com/metrobus/old/stops
https://api.softoursistemas.com/metrobus/old/routes
https://api.softoursistemas.com/metrobus/stops/code/{stop}/routes
https://api.softoursistemas.com/metrobus/estimacion/ocupacion/{stop}
https://api.softoursistemas.com/metrobus/routes/{route_id}/stops?direction=0&concesion=CV106
https://api.softoursistemas.com/metrobus/routes/{route_id}/shapes/?direction=0&concesion=CV106
```

- Se mantiene el `route_id` interno y la concesión; el número público puede ser distinto.
- Se consultan los dos sentidos y sus paradas para estimaciones. Las geometrías de un día de respaldo (`noServiceToday`) se pueden dibujar, pero no se usan para deducir posiciones actuales.
- Las estimaciones incluyen `vehicleId`, `minutesToArrival`, `ocupacion` y, en algunos casos, `almex.latitude/longitude`.
- ALMEX no proporciona hora GPS en las respuestas observadas: se muestra como **posición publicada sin hora**, no como GPS reciente verificado.
- Sin ALMEX, se estima desde la ETA solo si el sentido de la parada queda resuelto.
- Cuatro peticiones simultáneas como máximo en el cliente; recorridos bajo demanda y caché de diez minutos. Si falla un sentido se conserva el otro.
- Se han observado HTTP 500 en algunos recorridos de la fuente; pueden seguir disponibles las llegadas y posiciones de los vehículos. No se presenta una geometría fallida como válida.

### Metrovalencia (metro y tranvía)

- Mapa: `https://www.metrovalencia.es/es/consulta-mapas/`.
- De `datosMapaGeneral` se extraen valores JSON de `lineas`, `coloresLineas`, `estaciones` e `infoEstaciones`; nunca se ejecuta el JavaScript extraído.
- Próximas llegadas: POST público a `/wp-admin/admin-ajax.php`, con `action=formularios_ajax` y `data=action=info-estacion&id={id}&lang=es`.
- El backend envía un `User-Agent` identificable (configurable con `METRO_USER_AGENT`), agrupa consultas simultáneas y conserva cada previsión 25 segundos.
- Una respuesta `429` activa un backoff exponencial entre 30 segundos y 10 minutos; durante ese periodo no se insiste contra FGV.
- Se analiza `html`, concretamente `.item--proximos`, línea, destino y espera en horas/minutos.
- Los identificadores de piezas geométricas del mapa no son los números públicos de línea; se agrupan por los colores publicados y se cruzan con la pertenencia de estaciones.
- El destino resuelve el sentido, invirtiendo la polilínea si corresponde. Si no se encuentra un destino inequívoco dentro del tramo publicado, se muestra ETA sin posición.
- Es la geometría del mapa público, que puede estar simplificada o dividida en ramales; no es seguimiento GPS y no permite resolver todos los servicios.
- El sitio omite su certificado intermedio de Sectigo en la cadena TLS. Se incluye el certificado público `Sectigo Public Server Authentication CA OV R36` como material de cadena únicamente para este cliente HTTPS; se mantiene la verificación TLS y de nombre de host. Fuente del intermedio: `http://crt.sectigo.com/SectigoPublicServerAuthenticationCAOVR36.crt`; caducidad: marzo de 2036.

### Cercanías València

```text
https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip
https://gtfsrt.renfe.com/vehicle_positions.json
https://gtfsrt.renfe.com/trip_updates.json
```

- GTFS oficial: rutas con prefijo de red `40` (València), viajes, secuencia de paradas, destinos y shapes.
- `stop_times.txt` es muy grande; se procesa como flujo y se retienen únicamente viajes de València. El ZIP comprimido y el subconjunto se mantienen en memoria; caché de 12 horas, sin base de datos obligatoria.
- `VehiclePositions` se une con `TripUpdates` por `tripId`, y después con el GTFS estático.
- Se muestran solo trenes de viajes que pasan por la estación elegida, sin incluir trenes cercanos de otra red por proximidad geográfica. Se descartan estaciones ya rebasadas, servicios cancelados y paradas omitidas cuando el feed lo indica.
- Muchos `TripUpdates` solo publican el próximo evento. Una estación posterior puede mostrar el GPS del tren con **Sin ETA**: no se extrapola una llegada desde horarios estáticos.
- La posición incluye timestamp de medición. Si el feed tiene más de 90 segundos, se muestra el error de antigüedad; si falta GPS fresco, la tarjeta no genera un marcador estimado.
- Si un viaje no se encuentra en el GTFS descargado, no se asigna a una estación por intuición; puede haber cobertura parcial mientras Renfe publica cambios.
- El timestamp de GPS se muestra en la tarjeta; los datos oficiales de Renfe están publicados bajo CC BY 4.0 y se enlaza la fuente desde la interfaz.

## Procesos independientes

Para desarrollo basta `npm start`; para separar cargas, ejecutar cada comando en su proceso:

```bash
npm run service:emt        # 127.0.0.1:3101
npm run service:atmv       # 127.0.0.1:3102
npm run service:metro      # 127.0.0.1:3103
npm run service:cercanias  # 127.0.0.1:3104
```

Arrancar el gateway/frontend:

```bash
EMT_SERVICE_URL=http://127.0.0.1:3101 \
ATMV_SERVICE_URL=http://127.0.0.1:3102 \
METRO_SERVICE_URL=http://127.0.0.1:3103 \
CERCANIAS_SERVICE_URL=http://127.0.0.1:3104 \
npm start
```

En la interfaz selecciona **Proxy** para que todas las peticiones pasen por estos servicios. En modo automático, EMT y Met Go pueden seguir consultándose directamente desde el navegador.

- Cada proceso acepta `HOST` y `PORT`; `/health` devuelve operador y estado del proceso.
- El gateway expone `/api/providers/{id}/{endpoint}`; un proceso individual expone `/{endpoint}`.
- Se pueden externalizar solo algunos operadores; los no configurados se ejecutan como módulos locales.
- Las URLs de servicios son configuración del despliegue, no parámetros de una petición. Los handlers permiten únicamente endpoints y parámetros conocidos.
- Las cachés son locales a cada proceso. Para muchas réplicas, se puede sustituir `memoize` por almacenamiento compartido sin cambiar el contrato del frontend.

## Verificación

`npm test`, `npm run test:browser`, `npm run test:providers`, `npm run build`.

La integración real se ha comprobado con Met Go parada 487, Metro estación 26, Cercanías estación 65000 y EMT parada 167; número de vehículos, ETAs y disponibilidad de recorridos dependen del momento de consulta. Las pruebas de navegador guardan capturas y comprueban que no hay errores de ejecución, que el selector conserva el operador correcto tras cambios rápidos y que las tres redes adicionales pueden superponerse al mapa EMT.

## Basemap

The map uses OpenStreetMap raster tiles through Leaflet, avoiding a WebGL requirement:

```text
https://tile.openstreetmap.org/{z}/{x}/{y}.png
```

Attribution remains visible for OpenStreetMap contributors. The public instance has no SLA and must only be used within the OpenStreetMap tile usage policy; a production deployment with substantial traffic should use a compliant provider or self-host tiles without changing the transport-provider contracts.

## EMT route-cycle correction

EMT `Tramos_Vigentes` commonly publishes a general two-way line as one ordered, continuous, closed service cycle: outbound leg, terminus, return leg, and closure to the sequence origin. The route builder therefore:

1. Sorts by numeric `UNIQUE_ID`.
2. Splits only on missing/suppressed geometry or a measured gap above 30 metres.
3. Keeps `PINI_*` and `PFIN_*` as leg-boundary metadata instead of cutting the geometry.
4. Marks any measured first/last closure below 30 metres as a cycle, independently of the textual `TOPOLOGIA` value.
5. Permits at most one backward wrap when ETA distance crosses the route origin.

This fixes cases such as stop 167 on lines 30 and 81, where the stop lies shortly after a terminus in the sorted geometry but a valid approaching bus is still on the preceding return portion. Suppressed segments and actual street gaps remain hard boundaries, so the estimator never bridges disconnected roads.
