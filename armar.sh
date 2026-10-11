#!/bin/sh
# Arma el paquete de un país para Voy Por Ahí (1.26.0): baja el extracto de Geofabrik (comprueba su md5), arma el mapa con
# Planetiler y las calles con calles_extraer.py y la herramienta, escribe el manifiesto, actualiza el catálogo y relee todo
# con el código de la app. No sube nada: eso lo hace subir.sh, con el alojamiento y las credenciales de quien publica.
#
# Uso:   ./armar.sh <id> "<Nombre>" <ruta en Geofabrik> <carpeta de salida>
# Ej.:   ./armar.sh ar Argentina south-america/argentina salida
#        ./armar.sh uy Uruguay south-america/uruguay salida
# Variables: TRABAJO (carpeta de trabajo; por defecto trabajo/<id>), MEMORIA (para Planetiler; por defecto 8g), GEOFABRIK
#            (otro servidor con los extractos, para las pruebas),
#            PLANETILER (ruta del .jar; por defecto planetiler.jar), FORZAR=1 (rehacer una versión ya armada).
# Requisitos (versiones probadas): Java 21, Planetiler 0.10.2 (planetiler.jar, SHA-256 abajo), Python 3.11+ con
# osmium (pyosmium) 4.3.1, Node 22 y dist/herramienta.mjs (ver LEEME.md, «Preparar»).
set -eu

[ $# -eq 4 ] || { sed -n '6,8p' "$0"; exit 2; }
ID=$1; NOMBRE=$2; RUTA=$3; SALIDA=$4
AQUI=$(cd "$(dirname "$0")" && pwd)
H="$AQUI/dist/herramienta.mjs"
TRABAJO=${TRABAJO:-trabajo/$ID}
JAR=${PLANETILER:-planetiler.jar}
JAR_SHA256=f310bd0413e2e4512b27f4046d418664e8e1d3bf31603c2a70e23de06c167e4d
GEOFABRIK=${GEOFABRIK:-https://download.geofabrik.de}
AGENTE="VoyPorAhi-paquetes/1.28.0 (+https://voyporahi.com)"

echo "$ID" | grep -Eq '^[a-z0-9-]{2,32}$' || { echo "id: letras minúsculas, números y guiones"; exit 2; }
[ -f "$H" ] || { echo "Falta $H: ver LEEME.md, «Preparar»"; exit 2; }
echo "$JAR_SHA256  $JAR" | sha256sum -c --quiet || { echo "planetiler.jar no es la versión probada (0.10.2)"; exit 2; }
mkdir -p "$TRABAJO" "$SALIDA"

# 1) Extracto y borde del país. Una descarga por armado, de a una conexión (lo que pide Geofabrik).
PBF="$TRABAJO/$(basename "$RUTA")-latest.osm.pbf"
curl --fail --location --silent --show-error -A "$AGENTE" -o "$PBF.md5" "$GEOFABRIK/$RUTA-latest.osm.pbf.md5"
if ! (cd "$TRABAJO" && md5sum -c --quiet "$(basename "$PBF").md5" 2>/dev/null); then
  curl --fail --location --silent --show-error -A "$AGENTE" -o "$PBF" "$GEOFABRIK/$RUTA-latest.osm.pbf"
  (cd "$TRABAJO" && md5sum -c --quiet "$(basename "$PBF").md5") || { echo "El extracto bajado no coincide con su md5"; exit 1; }
fi
curl --fail --location --silent --show-error -A "$AGENTE" -o "$TRABAJO/borde.poly" "$GEOFABRIK/$RUTA.poly"

# 2) Mapa (esquema OpenMapTiles, como OpenFreeMap). Planetiler baja una vez el agua, Natural Earth y los lagos a
#    fuentes/ (se reusan para los otros países).
java "-Xmx${MEMORIA:-8g}" -jar "$JAR" --osm-path="$PBF" --output="$TRABAJO/mapa.pmtiles" --download --download-dir=fuentes \
  --tmpdir="$TRABAJO/tmp" --force > "$TRABAJO/planetiler.log" 2>&1 || { tail -n 30 "$TRABAJO/planetiler.log"; exit 1; }
VERSION=$(node --no-warnings "$H" fecha "$TRABAJO/mapa.pmtiles")
DEST="$SALIDA/$ID/$VERSION"
if [ -e "$DEST/manifiesto.json" ] && [ "${FORZAR:-0}" != 1 ]; then
  echo "Ya existe $DEST: una versión publicada no se cambia. (FORZAR=1 para rehacerla antes de publicarla.)"; exit 1
fi
mkdir -p "$DEST"
cp "$TRABAJO/mapa.pmtiles" "$DEST/mapa.pmtiles"

# 3) Calles para calcular rutas, en celdas (las mismas reglas que la descarga desde OpenStreetMap de la app).
node --no-warnings "$H" listas "$TRABAJO/listas.json"
python3 -I "$AQUI/calles_extraer.py" "$TRABAJO/listas.json" "$PBF" "$TRABAJO/celdas.sqlite"
node --no-warnings "$H" calles "$TRABAJO/celdas.sqlite" "$DEST/calles.pmtiles"

# 4) Manifiesto (sumas de control por trozo), catálogo y relectura con el código de la app.
node --no-warnings "$H" manifiesto "$DEST" --id "$ID" --nombre "$NOMBRE" --poly "$TRABAJO/borde.poly" --fuente "Geofabrik ($RUTA)"
node --no-warnings "$H" catalogo "$SALIDA"
node --no-warnings "$H" verificar "$DEST"
echo "Listo: $DEST"
