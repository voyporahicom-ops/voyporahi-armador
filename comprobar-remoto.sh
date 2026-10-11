#!/bin/sh
# Comprueba desde afuera lo publicado de un país, como lo va a pedir la app desde el sitio: catálogo, manifiesto, CORS,
# pedidos de una parte del archivo (Range) y caché. Con COMPLETO=1 baja además los dos archivos enteros y los relee con la
# herramienta (las mismas sumas por trozo). Con SIN_CATALOGO=1 no mira el catálogo (versión subida sin publicar). Solo lee.
#
# Uso:   [ORIGEN=https://voyporahi.com] [COMPLETO=1] [SIN_CATALOGO=1] ./comprobar-remoto.sh <dirección base> <id> <versión>
# Ej.:   COMPLETO=1 ./comprobar-remoto.sh https://paquetes.voyporahi.com uy 2026-10-11
set -u
[ $# -eq 3 ] || { sed -n '6,7p' "$0"; exit 2; }
BASE=${1%/}; ID=$2; VERSION=$3
ORIGEN=${ORIGEN:-https://voyporahi.com}
AQUI=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FALLAS=0
si() { if [ "$1" = 0 ]; then echo "OK    $2"; else echo "FALLA $2${3:+ — $3}"; FALLAS=$((FALLAS + 1)); fi; }
# Valor de un encabezado (sin distinguir mayúsculas) de una respuesta guardada con curl -D (la última, si hubo redirección).
hdr() { tr -d '\r' < "$1" | awk -v k="$2" 'BEGIN { k = tolower(k) } { i = index($0, ":"); if (i && tolower(substr($0, 1, i - 1)) == k) { v = substr($0, i + 1); sub(/^ +/, "", v) } } END { print v }'; }
# Pedido con el origen del sitio. $1: dirección, $2: nombre de la respuesta, el resto: opciones de curl. Imprime el código.
pedir() { u=$1; n=$2; shift 2; curl -sS --suppress-connect-headers -o "$TMP/$n.cuerpo" -D "$TMP/$n.enc" -w '%{http_code}' -H "Origin: $ORIGEN" "$@" "$u" \
  2>"$TMP/$n.err"; true; }
# El mismo pedido sin Origin, como un buscador o un enlace abierto a mano. Va antes del pedido con Origin: si un CDN guardara
# esa respuesta (sin encabezados CORS) y se la diera después a la app, la comprobación de CORS que sigue lo detecta.
sin_origen() { curl -sS -o /dev/null "$@" 2>/dev/null; true; }
contiene() { echo "$1" | tr 'A-Z' 'a-z' | grep -qF "$(echo "$2" | tr 'A-Z' 'a-z')"; }
cors_ok() { a=$(hdr "$1" access-control-allow-origin); [ "$a" = "$ORIGEN" ] || [ "$a" = "*" ]; }

case "$BASE" in https://*|http://127.0.0.1[:/]*|http://localhost[:/]*) ;; *) si 1 "dirección https" "la app solo acepta https: $BASE" ;; esac

# 1. Catálogo: la app lo pide con CORS y lo vuelve a consultar cada tanto (caché corta). Con SIN_CATALOGO=1 se salta
#    (una versión recién subida, que todavía no se publicó para los usuarios): el manifiesto va en <id>/<versión>/.
if [ "${SIN_CATALOGO:-0}" = 1 ]; then
  MAN="$ID/$VERSION/manifiesto.json"
else
  sin_origen "$BASE/catalogo.json"
  c=$(pedir "$BASE/catalogo.json" cat)
  si "$([ "$c" = 200 ]; echo $?)" "catálogo: responde" "código $c $(cat "$TMP/cat.err")"
  cors_ok "$TMP/cat.enc"; si $? "catálogo: CORS para $ORIGEN (también después de un pedido sin Origin)" "Access-Control-Allow-Origin: $(hdr "$TMP/cat.enc" access-control-allow-origin)"
  contiene "$(hdr "$TMP/cat.enc" cache-control)" max-age=300; si $? "catálogo: caché de 5 minutos" "Cache-Control: $(hdr "$TMP/cat.enc" cache-control)"
  MAN=$(node -e 'const [, f, id, v] = process.argv; try { const c = JSON.parse(require("fs").readFileSync(f, "utf8"));
    const p = (c.paises || []).find((x) => x.id === id); if (!p) process.exit(3); if (p.version !== v) { console.log("otra:" + p.version); process.exit(0) }
    console.log(p.manifiesto) } catch { process.exit(4) }' "$TMP/cat.cuerpo" "$ID" "$VERSION"); e=$?
  si "$e" "catálogo: lista $ID" "$([ $e = 3 ] && echo "no está en el catálogo" || echo "el catálogo no se pudo leer")"
  case "$MAN" in otra:*) si 1 "catálogo: la versión vigente de $ID es la $VERSION" "dice ${MAN#otra:}"; MAN="$ID/$VERSION/manifiesto.json" ;; esac
  [ -n "$MAN" ] || MAN="$ID/$VERSION/manifiesto.json"
fi
MURL=$(node -e 'console.log(new URL(process.argv[1], process.argv[2]).href)' "$MAN" "$BASE/catalogo.json")

# 2. Manifiesto.
c=$(pedir "$MURL" man)
si "$([ "$c" = 200 ]; echo $?)" "manifiesto: responde" "código $c $(cat "$TMP/man.err")"
cors_ok "$TMP/man.enc"; si $? "manifiesto: CORS para $ORIGEN"
contiene "$(hdr "$TMP/man.enc" cache-control)" immutable; si $? "manifiesto: caché de un año, inmutable" "Cache-Control: $(hdr "$TMP/man.enc" cache-control)"
ARCHIVOS=$(node -e 'const [, f, id, v] = process.argv; try { const m = JSON.parse(require("fs").readFileSync(f, "utf8"));
  if (m.id !== id || m.version !== v) process.exit(3); for (const a of m.archivos) console.log(a.nombre + " " + a.bytes + " " + a.sha256) } catch { process.exit(4) }' \
  "$TMP/man.cuerpo" "$ID" "$VERSION"); e=$?
si "$e" "manifiesto: es el de $ID $VERSION"
[ "$e" = 0 ] || { echo "Sin el manifiesto no se pueden comprobar los archivos."; echo "$FALLAS fallas"; exit 1; }
mkdir -p "$TMP/completo" && cp "$TMP/man.cuerpo" "$TMP/completo/manifiesto.json"

# 3. Cada archivo: el aviso previo de CORS, el principio, una parte desde el medio hasta el final (como cuando la app
#    retoma una descarga cortada) y, con COMPLETO=1, el archivo entero.
echo "$ARCHIVOS" > "$TMP/archivos.txt"
while read -r NOMBRE BYTES SHA <&3; do
  [ -n "$NOMBRE" ] || continue
  U=$(node -e 'console.log(new URL(process.argv[1], process.argv[2]).href)' "$NOMBRE" "$MURL")
  c=$(curl -sS --suppress-connect-headers -o /dev/null -D "$TMP/pre.enc" -w '%{http_code}' -X OPTIONS -H "Origin: $ORIGEN" -H 'Access-Control-Request-Method: GET' \
    -H 'Access-Control-Request-Headers: range' "$U" 2>/dev/null; true)
  { [ "$c" -ge 200 ] && [ "$c" -lt 300 ] && cors_ok "$TMP/pre.enc" && contiene "$(hdr "$TMP/pre.enc" access-control-allow-headers)" range; }
  si $? "$NOMBRE: el navegador puede pedir una parte (aviso previo de CORS con Range)" "código $c, Allow-Headers: $(hdr "$TMP/pre.enc" access-control-allow-headers)"
  sin_origen -H 'Range: bytes=0-15' "$U"
  c=$(pedir "$U" ini -H 'Range: bytes=0-15')
  si "$([ "$c" = 206 ] && [ "$(hdr "$TMP/ini.enc" content-range)" = "bytes 0-15/$BYTES" ]; echo $?)" "$NOMBRE: las primeras partes, con su tamaño ($BYTES bytes)" \
    "código $c, Content-Range: $(hdr "$TMP/ini.enc" content-range)"
  si "$([ "$(head -c 7 "$TMP/ini.cuerpo")" = PMTiles ]; echo $?)" "$NOMBRE: es un archivo PMTiles"
  cors_ok "$TMP/ini.enc" && contiene "$(hdr "$TMP/ini.enc" access-control-expose-headers)" content-range
  si $? "$NOMBRE: CORS y la app puede leer Content-Range (también después de un pedido sin Origin)" "Expose-Headers: $(hdr "$TMP/ini.enc" access-control-expose-headers)"
  contiene "$(hdr "$TMP/ini.enc" cache-control)" immutable; si $? "$NOMBRE: caché de un año, inmutable"
  D=$((BYTES > 100 ? BYTES - 100 : 0))
  c=$(pedir "$U" fin -H "Range: bytes=$D-")
  si "$([ "$c" = 206 ] && [ "$(hdr "$TMP/fin.enc" content-range)" = "bytes $D-$((BYTES - 1))/$BYTES" ] && [ "$(wc -c < "$TMP/fin.cuerpo")" -eq $((BYTES - D)) ]; echo $?)" \
    "$NOMBRE: retomar desde el byte $D hasta el final" "código $c, Content-Range: $(hdr "$TMP/fin.enc" content-range)"
  if [ "${COMPLETO:-0}" = 1 ]; then
    c=$(curl -sS -o "$TMP/completo/$NOMBRE" -w '%{http_code}' -H "Origin: $ORIGEN" "$U" 2>/dev/null; true)
    si "$([ "$c" = 200 ] && [ "$(sha256sum < "$TMP/completo/$NOMBRE" | cut -d' ' -f1)" = "$SHA" ]; echo $?)" "$NOMBRE: entero, igual al armado (SHA-256)" "código $c"
  fi
done 3< "$TMP/archivos.txt"
if [ "${COMPLETO:-0}" = 1 ]; then
  node --no-warnings "$AQUI/dist/herramienta.mjs" verificar "$TMP/completo" > "$TMP/verificar.txt" 2>&1; e=$?
  sed 's/^/      /' "$TMP/verificar.txt"; si $e "relectura completa con la herramienta (sumas por trozo y celdas de calles)"
fi
echo "$FALLAS fallas"
[ "$FALLAS" = 0 ]
