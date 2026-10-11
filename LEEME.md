# Armador de países de Voy Por Ahí

Este repositorio lo maneja el plugin de WordPress de Voy Por Ahí (1.28.0 o más nuevo), desde **Voy Por Ahí › Países
completos › Armar y subir un país**. No hace falta tocar nada aquí.

Cuando en el plugin se elige un país y se toca «Armar y subir», GitHub prende una computadora para ese armado y corre
`.github/workflows/armar-pais.yml`:

1. Baja los datos del país de [Geofabrik](https://download.geofabrik.de/) (OpenStreetMap) y comprueba su suma md5.
2. Si esa versión (la fecha de los datos) ya está subida, termina ahí.
3. Arma el mapa con [Planetiler](https://github.com/onthegomap/planetiler) 0.10.2 (esquema OpenMapTiles, el mismo de
   los estilos de la app) y las calles para calcular rutas sin conexión.
4. Lo sube al Cloudflare R2 del sitio a través del plugin y lo comprueba desde afuera, como lo baja la app.

La versión queda «Lista para publicar» en el plugin: los usuarios la ven recién cuando se toca «Publicar para los
usuarios» en el escritorio.

## Qué hay aquí

| Archivo | Qué es |
|---|---|
| `.github/workflows/armar-pais.yml` | Los pasos del armado en GitHub Actions. |
| `ci.sh` | Prepara las herramientas, baja los datos, arma y sube. |
| `armar.sh`, `calles_extraer.py`, `dist/herramienta.mjs` | El armado de un país (las mismas herramientas de siempre). |
| `publicar.mjs`, `comprobar-remoto.sh` | La subida a través del plugin y la comprobación desde afuera. |
| `requisitos.txt` | La versión fija de pyosmium, con la suma de cada paquete. |

El plugin vuelve a escribir estos archivos cuando cambian con una versión nueva del plugin: lo que se cambie a mano se
pierde.

## Claves

- El secreto **VPA_CLAVE** del repositorio lo pone el plugin antes de cada armado: es una clave de publicación nueva que
  solo puede subir versiones nuevas a través del sitio (no publicarlas para los usuarios, pisar ni borrar), y el sitio la
  deja de aceptar cuando el armado termina o se cancela (como mucho vale 2 días). El sitio no guarda su parte privada:
  solo GitHub la puede leer.
- La clave de GitHub (token) que se pegó en el plugin queda guardada cifrada en el sitio. Se puede borrar en GitHub
  (Settings › Developer settings › Personal access tokens) cuando ya no se use.

## Costo

Conviene que este repositorio sea **público**: en los repositorios públicos GitHub no cobra los armados y usa
computadoras más grandes (4 procesadores y 16 GB de memoria). Aquí no hay claves ni datos privados: el código es el del
armador, y el registro de cada armado muestra la dirección del sitio y la del bucket (las dos son públicas, la app las
usa) pero no la clave de publicación (GitHub la tapa).

En un repositorio privado, GitHub da 2.000 minutos por mes sin cargo a las cuentas gratuitas y usa computadoras más
chicas (2 procesadores y 8 GB). Cuántos minutos usa cada país depende de su tamaño (todavía no se midió con un país real
en GitHub): la página de cada armado en GitHub lo dice. Si se terminan los minutos, el armado no empieza y el plugin
muestra el aviso de GitHub.

Los datos son © colaboradores de OpenStreetMap (ODbL) y el esquema del mapa es de OpenMapTiles (CC-BY).
