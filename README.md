# En ruta · Transporte de València

Mapa interactivo con **JavaScript vanilla**, Leaflet y tiles raster de OpenStreetMap; sin frameworks de interfaz ni claves de cartografía.

## Redes disponibles

El selector permite cambiar entre EMT, ATMV / Met Go, Metrovalencia (metro y tranvía) y Cercanías València. En «Líneas → Paradas de otras redes» se pueden superponer las otras redes y pulsar una parada para cambiar automáticamente de operador; el identificador de una parada siempre se interpreta dentro de su operador.

| Red | Datos en directo | Posición en el mapa | Consulta |
| --- | --- | --- | --- |
| EMT | Previsiones SAE | Estimada sobre recorrido vigente | 20 s |
| ATMV / Met Go | Previsiones y ocupación; algunas incluyen coordenadas de vehículo | Coordenadas publicadas cuando existen; estimación sobre recorrido en los demás casos | 30 s |
| Metrovalencia | Próximas llegadas de la ficha pública de estación | Estimada sobre geometría del mapa y destino del servicio | 30 s |
| Cercanías | GTFS-RT VehiclePositions y TripUpdates de Renfe | GPS publicado, con hora de medición | 20 s |

**No todas las fuentes proporcionan una posición real verificable.** Las tarjetas distinguen `GPS`, `Posición publicada · hora GPS no indicada` y `Estimación`. Las coordenadas de Met Go no incluyen timestamp de medición: una consulta reciente no garantiza que esas coordenadas también lo sean. Los puntos publicados se mantienen en su última ubicación y cambian con la siguiente consulta; solo las estimaciones avanzan continuamente entre consultas.

Las paradas tienen color, forma y letra diferenciados: EMT verde/círculo, ATMV naranja/cuadrado A, Metro azul/rombo M y Cercanías violeta/círculo doble C. El tooltip y la ficha identifican el operador. Ver [docs/TRANSPORT-SERVICES.md](docs/TRANSPORT-SERVICES.md) para fuentes, contratos y despliegue independiente.

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

`npm start` carga los servicios como módulos separados dentro del servidor. Cercanías prepara el subconjunto de València desde el GTFS nacional en la primera consulta, por lo que esa carga tarda más que las siguientes; se conserva en memoria durante 12 horas.

- Busca por número o nombre, o pulsa cualquier parada del mapa.
- La parada seleccionada centra el mapa y muestra sus líneas y próximas llegadas; «Ver en mapa» enfoca el vehículo.
- Las rutas de la parada seleccionada se destacan; «Líneas» permite activar toda la red o las paradas de otros operadores.
- «Centrar parada y buses» encuadra las posiciones de la selección; el localizador muestra tu ubicación bajo petición.
- En móvil, la ficha de llegadas se puede expandir o contraer sin ocultar el mapa.
- Configuración: velocidad media de 6–60 km/h para posiciones estimadas, animación y conexión directa/automática/proxy.
- Interfaz clara centrada en el mapa, adaptable a móvil, con navegación por teclado y respeto a la preferencia de movimiento reducido.

`HOST=0.0.0.0 PORT=3000 npm start` permite acceso desde otros dispositivos de tu red; la geolocalización del navegador requiere HTTPS o localhost.

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
npm run test:providers
```

Las pruebas unitarias cubren distancias sobre recorrido, separación de sentidos, huecos, tramos suprimidos, circulares, caducidad, medianoche de Madrid, identidades temporales y límites del proxy. La prueba de navegador usa los servicios reales: abre la parada 167, comprueba interacción y movimiento cuando hay posiciones estimables, cambia de parada, velocidad y línea, revisa el diseño móvil, fuerza el respaldo proxy y comprueba errores XML. Requiere que EMT esté accesible; los resultados en directo varían según hora y servicio.

Capturas de verificación: `test-results/desktop.png` y `test-results/mobile.png`.

La prueba multimodal añade capturas `atmv.png`, `metro.png`, `cercanias.png`, `emt.png` y `multimodal-mobile.png`; comprueba aislamiento ante cambios rápidos de operador y superposición de paradas. Las pruebas deterministas cubren el tipo de posición, identidades de Met Go, destinos de Metro, orden de paradas de Renfe, feeds antiguos, cancelaciones, estaciones omitidas y gateway a procesos separados.

## Cartografía y atribución

Leaflet y OpenStreetMap son open source. Los tiles se cargan desde `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, sin API key y con atribución visible. El servicio público no ofrece SLA ni está pensado para cargas altas; para producción con mucho tráfico debe usarse un proveedor compatible con la política de tiles o una instancia propia. La aplicación no es un producto oficial de ninguno de los operadores.
