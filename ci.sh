#!/bin/sh
# Armado de un país en GitHub Actions (Voy Por Ahí 1.28.0). Lo corre .github/workflows/armar-pais.yml cuando el plugin
# de WordPress lo pide (Voy Por Ahí › Países completos › Armar y subir un país). El plugin escribe este repositorio: lo
# que se cambie a mano se pierde la próxima vez que lo prepare.
#
# Uso:  sh ci.sh preparar | bajar | armar | subir
#   preparar  Planetiler 0.10.2 (comprueba su SHA-256), pyosmium 4.3.1 (comprueba la suma del paquete) y espacio libre.
#   bajar     El extracto de Geofabrik y su md5; con la fecha de los datos, mira si esa versión ya está subida (si está,
#             los pasos siguientes no corren).
#   armar     armar.sh: mapa con Planetiler, calles, manifiesto y relectura con el código de la app.
#   subir     publicar.mjs: sube la versión al Cloudflare R2 del sitio a través del plugin y la comprueba desde afuera.
#             No la publica para los usuarios: eso se hace en el escritorio.
# Entradas (variables de entorno; el workflow las pone con lo que mandó el plugin, nunca dentro del código de los pasos):
#   RUTA (en Geofabrik, ej. south-america/argentina), ID (ej. ar), NOMBRE (ej. Argentina), SITIO (https://…) y PUBLICA
#   (dirección pública del bucket). En «subir», VPA_CLAVE_B64: la clave de publicación que el plugin creó para este
#   armado (secreto VPA_CLAVE del repositorio), en una línea de base64.
# Para las pruebas locales: GEOFABRIK (otro servidor), PRUEBA_LOCAL=1 (admite http://localhost) y MEMORIA.
set -eu
AQUI=$(cd "$(dirname "$0")" && pwd)
cd "$AQUI"
PASO=${1:-}
PLANETILER_URL=https://github.com/onthegomap/planetiler/releases/download/v0.10.2/planetiler.jar
JAR_SHA256=$(sed -n 's/^JAR_SHA256=//p' armar.sh)
GEOFABRIK=${GEOFABRIK:-https://download.geofabrik.de}
AGENTE=$(sed -n 's/^AGENTE="\(.*\)"$/\1/p' armar.sh)
export GEOFABRIK

# Un aviso en la página del armado en GitHub (y en la salida). El texto nunca empieza con lo que mandó el plugin.
falla() { echo "::error::$1"; exit 1; }
salida() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1" >> "$GITHUB_OUTPUT"; echo "$1"; }
resumen() { [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$1" >> "$GITHUB_STEP_SUMMARY"; echo "$1"; }

direccion() {
  printf '%s' "$1" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$' && return 0
  [ "${PRUEBA_LOCAL:-0}" = 1 ] && printf '%s' "$1" | grep -Eq '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
}

# Las entradas se vuelven a revisar aquí (el plugin ya las revisó): una sola línea, sin caracteres de control.
validar() {
  for v in "${RUTA:-}" "${ID:-}" "${NOMBRE:-}" "${SITIO:-}" "${PUBLICA:-}"; do
    [ "$(printf '%s' "$v" | wc -l)" -eq 0 ] || falla "Una de las entradas tiene más de una línea."
  done
  printf '%s' "${RUTA:-}" | grep -Eq '^[a-z0-9_-]{1,60}(/[a-z0-9_-]{1,60}){0,4}$' || falla "La ruta en Geofabrik no es válida."
  printf '%s' "${ID:-}" | grep -Eq '^[a-z0-9-]{2,32}$' || falla "El identificador del país no es válido."
  n=$(printf '%s' "${NOMBRE:-}" | wc -m)
  { [ "$n" -ge 1 ] && [ "$n" -le 80 ]; } || falla "El nombre del país tiene que tener entre 1 y 80 letras."
  ! printf '%s' "$NOMBRE" | LC_ALL=C grep -q '[[:cntrl:]]' || falla "El nombre del país tiene caracteres de control."
  direccion "${SITIO:-}" || falla "La dirección del sitio no es válida."
  direccion "${PUBLICA:-}" || falla "La dirección pública del bucket no es válida."
}

TRABAJO="trabajo/${ID:-x}"
PBF="$TRABAJO/$(basename "${RUTA:-x}")-latest.osm.pbf"

preparar() {
  validar
  java -version 2>&1 | head -1
  node --version
  if ! echo "$JAR_SHA256  planetiler.jar" | sha256sum -c --quiet 2>/dev/null; then
    curl --fail --location --silent --show-error -o planetiler.jar "$PLANETILER_URL"
    echo "$JAR_SHA256  planetiler.jar" | sha256sum -c --quiet || falla "planetiler.jar no es la versión probada (0.10.2)."
  fi
  if ! venv/bin/python -c 'import osmium' 2>/dev/null; then
    python3 -m venv venv || falla "No se pudo crear el entorno de Python (python3 -m venv)."
    venv/bin/pip install --quiet --disable-pip-version-check --no-deps --require-hashes -r requisitos.txt \
      || falla "No se pudo instalar pyosmium 4.3.1 con la suma esperada (requisitos.txt)."
  fi
  # Las máquinas de GitHub traen muchas herramientas que no se usan: si queda poco lugar, se borran las más grandes.
  libre=$(df -Pk . | awk 'NR == 2 { print int($4 / 1048576) }')
  echo "Espacio libre: $libre GB"
  if [ "${GITHUB_ACTIONS:-}" = true ] && [ "$libre" -lt 40 ]; then
    sudo rm -rf /usr/share/dotnet /usr/local/lib/android /opt/ghc /opt/hostedtoolcache/CodeQL /usr/local/share/boost || true
    echo "Espacio libre después de limpiar: $(df -Pk . | awk 'NR == 2 { print int($4 / 1048576) }') GB"
  fi
}

# Fecha de los datos según el encabezado del extracto (la misma que después escribe Planetiler en el mapa).
fecha_extracto() {
  venv/bin/python -I -c '
import sys, osmium
r = osmium.io.Reader(sys.argv[1], osmium.osm.osm_entity_bits.NOTHING)
t = r.header().get("osmosis_replication_timestamp", "")
r.close()
print(t)' "$1"
}

bajar() {
  validar
  mkdir -p "$TRABAJO"
  # Una descarga a la vez y con un nombre que identifica al sitio, como pide Geofabrik.
  curl --fail --location --silent --show-error -A "$AGENTE" -o "$PBF.md5" "$GEOFABRIK/$RUTA-latest.osm.pbf.md5"
  if ! (cd "$TRABAJO" && md5sum -c --quiet "$(basename "$PBF").md5" > /dev/null 2>&1); then
    curl --fail --location --silent --show-error -A "$AGENTE" -o "$PBF" "$GEOFABRIK/$RUTA-latest.osm.pbf"
    (cd "$TRABAJO" && md5sum -c --quiet "$(basename "$PBF").md5") || falla "El extracto bajado de Geofabrik no coincide con su md5."
  fi
  echo "Extracto: $(du -h "$PBF" | cut -f1)"
  cuando=$(fecha_extracto "$PBF")
  if ! printf '%s' "$cuando" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'; then
    echo "El extracto no dice la fecha de sus datos: se arma igual (armar.sh avisa si hace falta)."
    salida "ya=0"
    return
  fi
  version=$(printf '%s' "$cuando" | cut -c1-10)
  salida "version=$version"
  codigo=$(curl --silent --show-error -o /dev/null -w '%{http_code}' "$PUBLICA/$ID/$version/manifiesto.json") || codigo=000
  if [ "$codigo" = 200 ]; then
    resumen "La versión $version (datos de Geofabrik del $cuando) ya está subida completa en Cloudflare: no se arma de nuevo. Geofabrik todavía no publicó datos más nuevos."
    salida "ya=1"
  else
    echo "La versión $version todavía no está completa en Cloudflare (respondió $codigo): se arma."
    salida "ya=0"
  fi
}

armar() {
  validar
  if [ -z "${MEMORIA:-}" ]; then
    # Para Planetiler, el 60 % de la memoria de la máquina (hasta 12 GB): el resto queda para el sistema y los archivos.
    MEMORIA=$(awk '/^MemTotal:/ { m = int($2 / 1024 * 0.6); if (m > 12288) m = 12288; print m "m" }' /proc/meminfo)
  fi
  echo "Memoria para Planetiler: $MEMORIA"
  PATH="$AQUI/venv/bin:$PATH" PLANETILER="$AQUI/planetiler.jar" TRABAJO="$TRABAJO" MEMORIA="$MEMORIA" \
    sh armar.sh "$ID" "$NOMBRE" "$RUTA" salida
  for f in salida/"$ID"/*/*.pmtiles; do resumen "$(basename "$f"): $(du -h "$f" | cut -f1)"; done
}

subir() {
  validar
  [ -n "${VPA_CLAVE_B64:-}" ] || falla "Falta la clave de publicación (secreto VPA_CLAVE): vuelva a tocar «Armar y subir» en el plugin, que la crea para cada armado."
  versiones=$(ls salida/"$ID")
  [ "$(printf '%s\n' "$versiones" | wc -l)" -eq 1 ] || falla "Se esperaba una sola versión armada en salida/$ID."
  # La clave queda en un archivo que solo lee este usuario y se borra al terminar (publicar.mjs no acepta otro). Después
  # sale del entorno: los programas que siguen (node y lo que este abra) no la reciben.
  clave="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/vpa-publicador-$$.json"
  trap 'rm -f "$clave"' EXIT INT TERM
  (umask 077 && printf '%s' "$VPA_CLAVE_B64" | base64 -d > "$clave") 2>/dev/null || falla "La clave de publicación del secreto VPA_CLAVE no se puede leer: vuelva a tocar «Armar y subir» en el plugin, que la crea de nuevo."
  unset VPA_CLAVE_B64
  codigo=0
  VPA_CLAVE="$clave" node publicar.mjs subir "$SITIO" salida "$ID" "$versiones" || codigo=$?
  rm -f "$clave"
  # 3: el sitio no aceptó la versión (el motivo está arriba). Lo que ya está entero en Cloudflare no se cambia: si un armado
  # anterior de la misma fecha se cortó y este salió distinto, hay que esperar los datos nuevos de Geofabrik.
  [ "$codigo" -ne 3 ] || falla "El sitio no aceptó la versión $versiones (el motivo está arriba). Si dice que en Cloudflare ya hay otra de esa fecha, vuelva a armar el país cuando Geofabrik publique datos nuevos (lo hace todos los días)."
  [ "$codigo" -eq 0 ] || falla "No se pudo subir la versión $versiones a Cloudflare (el motivo está arriba)."
  resumen "Subida y comprobada la versión $versiones. Falta publicarla para los usuarios en el escritorio del sitio (Voy Por Ahí › Países completos)."
}

case "$PASO" in
  preparar) preparar ;;
  bajar) bajar ;;
  armar) armar ;;
  subir) subir ;;
  *) sed -n '5,12p' "$0"; exit 2 ;;
esac
