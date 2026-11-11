# En ruta · Transporte de València

Mapa interactivo con **JavaScript vanilla**, Leaflet y tiles raster de OpenStreetMap; sin frameworks de interfaz ni claves de cartografía.

## Redes disponibles

El selector permite cambiar entre EMT, ATMV / Met Go, Metrovalencia (metro y tranvía), Cercanías València y Valenbisi. En «Líneas → Paradas de otras redes» se pueden superponer las otras redes y pulsar una parada para cambiar automáticamente de operador; el identificador de una parada siempre se interpreta dentro de su operador.

| Red | Datos en directo | Posición en el mapa | Consulta |
| --- | --- | --- | --- |
| EMT | Previsiones SAE | Estimada sobre recorrido vigente | 20 s |
| ATMV / Met Go | Previsiones y ocupación; algunas incluyen coordenadas de vehículo | Coordenadas publicadas cuando existen; estimación sobre recorrido en los demás casos | 30 s |
| Metrovalencia | Próximas llegadas de la ficha pública de estación | Estimada sobre geometría del mapa y destino del servicio | 30 s |
| Cercanías | GTFS-RT VehiclePositions y TripUpdates de Renfe | GPS publicado, con hora de medición | 20 s |
| Valenbisi | Estaciones, bicicletas y anclajes disponibles | Estación fija; no es una posición de vehículo | 60 s |

**No todas las fuentes proporcionan una posición real verificable.** Las tarjetas distinguen `GPS`, `Posición publicada · hora GPS no indicada` y `Estimación`. Las coordenadas de Met Go no incluyen timestamp de medición: una consulta reciente no garantiza que esas coordenadas también lo sean. Los puntos publicados se mantienen en su última ubicación y cambian con la siguiente consulta; solo las estimaciones avanzan continuamente entre consultas.

Las paradas tienen color, forma y letra diferenciados: EMT verde/círculo, ATMV naranja/cuadrado A, Metro azul/rombo M, Cercanías violeta/círculo doble C y Valenbisi naranja/círculo V. El tooltip y la ficha identifican el operador. Ver [docs/TRANSPORT-SERVICES.md](docs/TRANSPORT-SERVICES.md) para fuentes, contratos y despliegue independiente.

## Arrancar

Requiere Node.js 22 o posterior:

```bash
cd /home/maicol/test-map-emt
npm install
npm start
```

Abre **http://localhost:3000**. Para probar directamente una parada: **http://localhost:3000/?stop=167**.

Ejemplos de las otras redes:

- `http://localhost:3000/?provider=atmv&stop=487`
- `http://localhost:3000/?provider=metro&stop=26`
- `http://localhost:3000/?provider=cercanias&stop=65000`
- `http://localhost:3000/?provider=valenbisi&stop=1`

`npm start` carga los servicios como módulos separados dentro del servidor. Cercanías prepara el subconjunto de València desde el GTFS nacional en la primera consulta, por lo que esa carga tarda más que las siguientes; se conserva en memoria durante 12 horas.

Valenbisi se obtiene mediante un navegador headless que carga la página pública de mapping y captura la respuesta de estaciones que usa la propia web. No requiere configurar una URL ni una API key en `.env`; el navegador y sus dependencias se instalan durante la construcción de Docker. La interfaz muestra bicicletas y anclajes disponibles, con una caché de 45 segundos.

- Busca por número o nombre, o pulsa cualquier parada del mapa.
- La parada seleccionada centra el mapa y muestra sus líneas y próximas llegadas; «Ver en mapa» enfoca el vehículo.
- Las rutas de la parada seleccionada se destacan; «Líneas» permite activar toda la red o las paradas de otros operadores.
- «Centrar parada y buses» encuadra las posiciones de la selección; la ubicación se actualiza en segundo plano tras conceder permiso y el localizador solo centra el mapa.
- El mapa se puede girar con dos dedos; aparece una brújula para volver al norte. En móvil, la ficha también se expande o contrae con un gesto vertical.
- Met Go indica «Sin servicio hoy» solo cuando su fuente confirma que una línea no opera. EMT, Metrovalencia y Cercanías no publican aquí calendarios suficientes para confirmar ese estado.
- Configuración: velocidad media de 6–60 km/h para posiciones estimadas, animación y conexión directa/automática/proxy.
- Interfaz clara centrada en el mapa, adaptable a móvil, con navegación por teclado y respeto a la preferencia de movimiento reducido.

`HOST=0.0.0.0 PORT=3000 npm start` permite acceso desde otros dispositivos de tu red; la geolocalización del navegador requiere HTTPS o localhost.

## Despliegue en un VPS

El proyecto incluye [docker-compose.yml](docker-compose.yml), [Dockerfile](Dockerfile) y [nginx.conf](nginx.conf). Docker Compose construye dos servicios: `frontend` sirve la web compilada con Nginx y reenvía `/api/` al `backend` Node, que ejecuta los cinco proveedores y la API v1. Solo el frontend publica un puerto; ambos servicios se reinician al arrancar el VPS y tienen comprobaciones de salud.

Requisitos: Docker Engine con Compose, conexión saliente a los proveedores y a OpenStreetMap, y espacio y memoria suficientes para procesar el GTFS nacional de Renfe. La primera consulta de Cercanías puede tardar y consumir más memoria; su caché está en RAM y se pierde al reiniciar.

1. En el directorio del proyecto, prepara la configuración:

	```bash
	cp .env.example .env
	openssl rand -hex 32
	```

	Edita `.env` y coloca el valor generado en `API_KEYS`. Puedes indicar varias claves separadas por comas. Protege el archivo con `chmod 600 .env`; no lo subas al repositorio ni incluyas las claves en el código del navegador. Las variables de entorno de Docker también son visibles para los administradores del host.

	Para activar Valenbisi, añade también `VALENBISI_FEED_URL` con la URL completa del feed que compartiste. Si se deja vacío, el resto del mapa arranca normalmente y Valenbisi muestra que no tiene fuente configurada.

2. Arranca los servicios:

	```bash
	docker compose up -d --build
	docker compose ps
	```

3. Para una prueba inicial, abre `http://IP_DEL_VPS:8083`. El puerto y la interfaz se configuran con `WEB_PORT` y `BIND_ADDRESS`. El valor predeterminado `0.0.0.0` publica el puerto en todas las interfaces IPv4; asegúrate de que las reglas del proveedor del VPS permitan solo el acceso deseado. Docker puede publicar puertos al margen de reglas UFW: comprueba las reglas efectivas del host y del proveedor.

4. Para producción, usa un dominio y HTTPS mediante un proxy inverso existente con certificado válido. Conecta ese proxy a `proxy-net` y configura su destino como `http://en-ruta-frontend:80`, conservando las rutas completas, incluidas `/api/`. Ajusta su tiempo de lectura a al menos 150 segundos para la carga inicial de Cercanías. Establece `BIND_ADDRESS=127.0.0.1` en `.env` y vuelve a ejecutar `docker compose up -d` para no exponer el puerto de prueba a Internet. La configuración incluida no solicita certificados ni habilita HTTPS por sí sola. La geolocalización móvil y el envío seguro de claves requieren HTTPS.

`PROXY_NETWORK` cambia el nombre de la red Docker. `VALENBISI_FEED_URL` es opcional para arrancar, pero necesario para disponibilidad de bicicletas. `API_CORS_ORIGINS` contiene los orígenes web autorizados exactos, separados por comas, por ejemplo `https://cliente.example`; vacío no autoriza solicitudes CORS. Las peticiones servidor a servidor no necesitan CORS. `API_RATE_LIMIT` limita las peticiones a `/api/v1` por clave y minuto, por proceso; el valor predeterminado es 120.

Comprueba desde el propio VPS, sustituyendo la clave de forma segura en tu terminal:

```bash
curl -i http://127.0.0.1:8083/api/v1/operators
# Debe responder 401 sin clave.
read -rs -p 'Clave API: ' TRANSIT_API_KEY; echo
curl -H "X-API-Key: $TRANSIT_API_KEY" http://127.0.0.1:8083/api/v1/operators
unset TRANSIT_API_KEY
docker compose logs -f --tail=100
```

Usa HTTPS para consultar la API desde fuera del VPS; HTTP directo es solo para diagnóstico local. La API versionada requiere clave, pero `/api/` y `/api/providers/` son intermediarios públicos necesarios para la web y no están protegidos por `API_KEYS` ni por `API_RATE_LIMIT`. En producción aplica límites por cliente en el proxy exterior y evita confiar en cabeceras de IP enviadas directamente por clientes. Si hay varias réplicas, usa un limitador compartido. Comprueba también las políticas y límites de uso de las fuentes y de los tiles.

Para actualizar, obtén los cambios del proyecto y ejecuta `docker compose up -d --build`; para detenerlo, `docker compose down`. La red externa no se elimina. El backend se resuelve de nuevo por DNS interno cuando cambia su contenedor; tras un reinicio puede haber unos segundos de indisponibilidad.

### Comprobación del despliegue

En una máquina de pruebas con Node.js 22, dependencias de desarrollo y Chromium de Playwright instalados, configura `TRANSIT_API_KEY` con una clave válida y ejecuta:

```bash
BASE_URL=https://tu-dominio.example TRANSIT_API_KEY="$TRANSIT_API_KEY" npm run test:deployment
BASE_URL=https://tu-dominio.example npm run test:ui
BASE_URL=https://tu-dominio.example npm run test:browser
```

`test:deployment` verifica autenticación y contrato, carga Metro a través del proxy real y prueba búsqueda, mapa y panel en tres tamaños táctiles, incluido horizontal. `test:ui` usa respuestas simuladas para probar las cuatro redes; `test:browser` depende de datos reales de EMT y de la disponibilidad de vehículos. Las pruebas móviles son emulación Chromium, no sustituyen comprobar Safari y Chrome en dispositivos físicos. Las capturas se guardan en `test-results/`.

## API para otras aplicaciones

La API JSON de lectura se publica bajo `/api/v1` y requiere una clave en la cabecera `X-API-Key`. Configura una o varias claves secretas separadas por comas mediante `API_KEYS`; si no se configura ninguna, la API responde `503`. No incluyas claves en aplicaciones distribuidas al navegador. El contrato completo está en [docs/openapi.yaml](docs/openapi.yaml) y también se sirve autenticado en `/api/v1/openapi.yaml`.

Con `TRANSIT_API_KEY` configurada en el entorno con una clave secreta:

```bash
API_KEYS="$TRANSIT_API_KEY" API_CORS_ORIGINS="https://cliente.example" npm start
curl -H "X-API-Key: $TRANSIT_API_KEY" 'http://localhost:3000/api/v1/operators/metro/stops?limit=10&q=facultats'
curl -H "X-API-Key: $TRANSIT_API_KEY" 'http://localhost:3000/api/v1/operators/metro/stops/26/arrivals'
```

Las rutas incluyen `/operators`, `/operators/{operator}/stops`, `/operators/{operator}/lines` y los recursos de detalle, llegadas, vehículos y recorridos descritos en OpenAPI. Los IDs son cadenas en el ámbito de cada operador; las fechas se expresan en UTC y las coordenadas GeoJSON son `[longitud, latitud]`. La paginación usa `limit` y `offset` y ordena por ID. Los datos pueden cambiar entre páginas al actualizarse la red.

`meta.fetchedAt` indica cuándo se normalizó la respuesta, no necesariamente cuándo se midió el dato. `position.measuredAt` es `null` cuando el proveedor no publica la hora; la API nunca convierte la posición estimada por la interfaz en una posición real. La lista de vehículos por parada es parcial y puede estar vacía; no es un inventario global. Las geometrías de ATMV con `serviceToday: false` corresponden a un día alternativo; si falla alguna variante, `meta.failedVariants` indica cuántas faltan.

Por defecto, CORS no autoriza orígenes; `API_CORS_ORIGINS` admite una lista de orígenes exactos separados por comas. `API_RATE_LIMIT` fija el máximo de peticiones por clave y minuto, por proceso (predeterminado: 120). En múltiples instancias se necesita un limitador compartido en el despliegue. Utiliza HTTPS y protege las claves fuera del repositorio. Revisa las condiciones y límites de las fuentes antes de publicar el servicio.

**Importante:** la clave solo protege `/api/v1`; las rutas heredadas `/api/` y `/api/providers/` siguen sin autenticación para no romper la web, y no deben considerarse protegidas por el límite de la API. El servidor escucha en `127.0.0.1` por defecto; la exposición pública y la terminación HTTPS deben configurarse en el despliegue.

## Frontend independiente

```bash
npm run build
```

Publica el contenido de `dist/` en cualquier alojamiento estático mediante HTTP(S), también bajo un subdirectorio. En configuración selecciona **Directa · solo frontend**. Leaflet se copia dentro del directorio; el procesamiento XML, los cálculos geográficos y la animación ocurren en el navegador.

Este despliegue puramente estático sirve para **EMT y Met Go** mientras permitan CORS. Metrovalencia necesita normalmente el intermediario por CORS y su cadena TLS incompleta; Cercanías necesita el servicio para procesar el GTFS nacional. Para las cuatro redes utiliza `npm start`, con modo automático o proxy.

Los servicios públicos consultados de EMT permiten actualmente CORS (`Access-Control-Allow-Origin: *`); se ha comprobado el flujo real en Chromium. **No hacen falta claves ni credenciales.** Google Fonts y el mapa base necesitan conexión; la tipografía tiene respaldo local del sistema. Los tiles públicos de OpenStreetMap no requieren cuenta ni API key, pero deben usarse conforme a su política.

El modo automático intenta primero EMT desde el navegador. Ante un fallo de transporte usa `/api/sae` o `/api/wfs` del pequeño servidor incluido, y vuelve a intentar conexión directa tras cinco minutos. En un alojamiento únicamente estático no existe ese respaldo; para disponer de él despliega `server.mjs` y `public/` con las dependencias instaladas.

## Fuentes y relación con `../EMT-Services`

Se ha revisado:

- `scrapping_service.py`: petición `getSAE`, cabeceras de navegador, XML `solo_parada/bus` y error del servicio.
- `geo_service.py`: WFS, sublíneas, recorrido vigente, separación de sentidos y velocidad de **200 m/min = 12 km/h**.
- `utils.py`: formatos `Próximo`/`Pròxim`, minutos y hora de llegada.

### Estimaciones

`https://geoportal.emtvalencia.es/EMT/mapfunctions/MapUtilsPetitions.php`

Parámetros: `sec=getSAE`, `parada=<id>`, `adaptados=false`, `idioma=es`, `nocache=<UUID>`. El parámetro aleatorio es importante: durante la investigación, una URL sin él devolvía un error antiguo mientras una petición nueva sí devolvía las llegadas.

Se extraen `linea`, `destino` y `minutos` del XML con `DOMParser`. Los errores de EMT y el XML inválido se muestran explícitamente; una respuesta válida sin buses se distingue de una caída del servicio.

### Paradas y líneas

`https://geoportal.emtvalencia.es/geoserver/emt/wfs`

Petición WFS `GetFeature`, versión `1.1.0`, `outputFormat=json`, `srsName=EPSG:4326`:

| Capa | Uso |
| --- | --- |
| `emt:Paradas` | Identificadores, nombres y coordenadas de la red publicada |
| `emt:Lineas` | Código público, sublíneas, topología y cabeceras |
| `emt:Tramos_Vigentes` | Geometría vigente, orden y relación entre nodos/paradas |

Para los tramos se envía `viewparams=p_linea:<sublinea>;p_fecha:'YYYY-MM-DD';p_hora:'HHmm'`, con fecha y hora **Europe/Madrid**, independientemente de la zona horaria del navegador.

La relación parada–línea se construye desde los extremos `IDTRAMO` del recorrido activo: por ejemplo `P00016602P00016701` conecta las paradas 166 y 167. Esto permite listar líneas aunque no tengan ninguna previsión de llegada. No se utiliza la tabla de demostración de `constants.py` ni se inventan buses.

## Cálculo de posiciones

1. Ordenar los tramos por `UNIQUE_ID`; omitir los suprimidos.
2. Mantener cada sublínea separada y partir recorridos en cabeceras o discontinuidades, sin unir segmentos lejanos mediante rectas ficticias.
3. Ubicar la parada por su identificador de nodo y comprobar proximidad geográfica; evitar asignar una parada a la calzada opuesta solo porque está cerca.
4. Convertir ETA en distancia: `metros = segundos_restantes × velocidad_km_h / 3.6`.
5. Retroceder esa distancia sobre la polilínea del sentido que llega a la parada e interpolar entre sus vértices.
6. En una sublínea realmente circular y cerrada se permite volver al final del recorrido, como máximo una vuelta.

Las correcciones de ETA se suavizan durante cuatro segundos **sobre la ruta**, interpolando el instante previsto de llegada; no se interpolan posiciones mediante rectas entre calles. Se conservan identidades temporales mediante emparejamiento uno-a-uno por línea, destino y hora estimada, con tolerancia de 150 segundos.

### Actualización y precisión

- Se consulta solo la parada seleccionada cada **20 segundos**, sin peticiones simultáneas de estimaciones para esa selección.
- El movimiento estimado se dibuja hasta 20 veces por segundo; no implica nuevos datos GPS a esa frecuencia.
- La nueva selección aborta la consulta anterior e ignora resultados de selecciones antiguas.
- Se pausa el polling al ocultar la pestaña y se reanuda al volver.
- Se atenúan posiciones con más de 45 segundos; a los **90 segundos** se ocultan y se identifica el dato como antiguo.
- Tras 15 segundos del instante de llegada previsto se oculta el marcador hasta recibir una nueva previsión.
- Horarios `HH:mm`/`HH:mm:ss` se muestran como **programados**, sin generar un bus en el mapa.
- Si la distancia supera el tramo disponible, falta geometría o el sentido es ambiguo, se conserva la tarjeta y se explica por qué no hay posición.
- La carga de toda la red usa cuatro tareas concurrentes, caché geográfica de diez minutos y actualización periódica de recorridos; los recorridos no disponibles se identifican en el selector.
- El servidor almacena geometría durante cinco minutos y agrupa peticiones simultáneas; no almacena ETA para evitar presentarla con una antigüedad incorrecta.

**Los marcadores de EMT representan posiciones estimadas, no GPS ni vehículos identificados por EMT.** La velocidad media no conoce atascos, semáforos, espera en cabecera o cambios de velocidad. La red publicada puede incluir paradas sin servicio y una línea puede carecer de recorrido vigente en ese momento. Los colores son una paleta identificativa de esta aplicación, salvo los colores de Metrovalencia publicados en su mapa.

## Archivos

```text
public/index.html       Estructura y configuración accesible
public/styles.css       Interfaz clara y diseño adaptable
public/js/api.js         Reexportación de compatibilidad para EMT
public/js/services/     Un adaptador de frontend por operador y transporte compartido
public/js/arrivals.js    Parsing, horas de Madrid y emparejamiento de llegadas
public/js/geo.js         Recorridos, sentidos, distancias e interpolación
public/js/app.js         Mapa, interfaz, selección, polling y animación
server.mjs              Servidor estático y gateway sin lógica de operadores
services/               EMT, ATMV, Metro y Cercanías en módulos ejecutables por separado
scripts/build.mjs       Generación del frontend estático autónomo
test/                   Pruebas geográficas, de servidor y navegador
```

## Verificación

```bash
npm test
npm run build
npx playwright install chromium  # solo si no está instalado
npm run test:browser
npm run test:ui          # navegador con datos simulados, sin depender de operadores
npm run test:providers
```

Las pruebas unitarias cubren distancias sobre recorrido, separación de sentidos, huecos, tramos suprimidos, circulares, caducidad, medianoche de Madrid, identidades temporales y límites del proxy. La prueba de navegador usa los servicios reales: abre la parada 167, comprueba interacción y movimiento cuando hay posiciones estimables, cambia de parada, velocidad y línea, revisa el diseño móvil, fuerza el respaldo proxy y comprueba errores XML. Requiere que EMT esté accesible; los resultados en directo varían según hora y servicio.

Capturas de verificación: `test-results/desktop.png` y `test-results/mobile.png`.

La prueba multimodal añade capturas `atmv.png`, `metro.png`, `cercanias.png`, `emt.png` y `multimodal-mobile.png`; comprueba aislamiento ante cambios rápidos de operador y superposición de paradas. Las pruebas deterministas cubren el tipo de posición, identidades de Met Go, destinos de Metro, orden de paradas de Renfe, feeds antiguos, cancelaciones, estaciones omitidas y gateway a procesos separados.

## Cartografía y atribución

Leaflet y OpenStreetMap son open source. Los tiles se cargan desde `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, sin API key y con atribución visible. La PWA guarda las teselas de València que ya se han visitado (hasta 900, con un máximo de siete días); no descarga el mapa por adelantado. El servicio público no ofrece SLA ni está pensado para cargas altas; para producción con mucho tráfico debe usarse un proveedor compatible con la política de tiles o una instancia propia. La aplicación no es un producto oficial de ninguno de los operadores.
