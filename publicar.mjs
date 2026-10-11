#!/usr/bin/env node
// Sube un país al Cloudflare R2 del sitio a través del plugin de WordPress (1.27.0), sin ninguna clave de Cloudflare.
// La máquina que sube tiene una clave propia (Ed25519). Quien administra el sitio pega su parte pública en Voy Por Ahí ›
// Países completos; desde ahí, el plugin acepta los pedidos firmados con la parte privada, que nunca sale de esta máquina:
// empieza y termina cada subida en partes y da direcciones prefirmadas (valen una hora, cada una para una sola parte).
// Esta clave no publica para los usuarios ni pisa ni borra nada: publicar se hace en el escritorio del sitio.
//
// Uso:   node publicar.mjs clave                                    crea la clave de esta máquina (si no está) y muestra la parte pública
//        node publicar.mjs subir <sitio> <salida> <id> <versión>    sube la versión y la comprueba desde afuera (no la publica)
//        node publicar.mjs estado <sitio>                           versiones a medio subir y catálogo publicado
// Ej.:   node publicar.mjs subir https://voyporahi.com salida uy 2026-10-11
// La clave queda en VPA_CLAVE (por omisión ~/.config/voyporahi/publicador.json), solo legible por quien la creó.
// Requisitos: Node 22.21 o más nuevo (para salir por HTTPS_PROXY, si lo hay), curl y ../dist/herramienta.mjs (armar.sh).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// fetch de Node usa HTTPS_PROXY solo con NODE_USE_ENV_PROXY=1: si hay proxy, el programa se vuelve a lanzar con eso (sin
// el aviso de Node de que esa parte es experimental).
if (process.env.HTTPS_PROXY && process.env.NODE_USE_ENV_PROXY !== '1') {
  const r = spawnSync(process.execPath, ['--disable-warning=UNDICI-EHPA', ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1' } })
  process.exit(r.status ?? 1)
}

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const KEY_FILE = process.env.VPA_CLAVE || path.join(os.homedir(), '.config', 'voyporahi', 'publicador.json')
const PREFIX = 'vpa-ed25519:'
const TAG = 'VPA-PUBLICAR-1'
const PARALELO = Math.max(1, Math.min(8, Number(process.env.PARALELO ?? 3)))

class Falla extends Error { constructor(msg, code = 1) { super(msg); this.code = code } }
const die = (msg, code = 1) => { throw new Falla(msg, code) }
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const md5 = (b) => crypto.createHash('md5').update(b).digest()
const espera = (ms) => new Promise((ok) => setTimeout(ok, ms))
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`

// ---------- Clave de esta máquina ----------
function publicLine(raw) { return PREFIX + Buffer.from(raw).toString('base64url') }
function keyId(raw) { return sha256(raw).slice(0, 16) }

function crearClave() {
  if (!fs.existsSync(KEY_FILE)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
    const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 })
    fs.writeFileSync(KEY_FILE, JSON.stringify({ privada: privateKey.export({ format: 'pem', type: 'pkcs8' }), publica: raw.toString('base64url'), creada: new Date().toISOString() }), { mode: 0o600, flag: 'wx' })
    console.log(`Clave nueva en ${KEY_FILE} (la parte privada no sale de esta máquina).`)
  }
  const k = cargarClave()
  console.log(`Clave pública (para pegar en Voy Por Ahí › Países completos › «Quién puede subir países»):\n${publicLine(k.pub)}\nIdentificador: ${k.id}`)
}

function cargarClave() {
  let k
  try { k = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')) } catch { die(`No está la clave de esta máquina (${KEY_FILE}): créela con «node publicar.mjs clave».`) }
  const st = fs.statSync(KEY_FILE)
  if (st.mode & 0o077) die(`${KEY_FILE} lo pueden leer otros usuarios: chmod 600 "${KEY_FILE}"`)
  const pub = Buffer.from(k.publica, 'base64url')
  return { privateKey: crypto.createPrivateKey(k.privada), pub, id: keyId(pub) }
}

// ---------- Pedidos firmados al plugin ----------
let CLAVE = null
let SITIO = null

/** Pedido a la API del plugin (ruta /voyporahi/v1/paquetes/<ruta>), firmado y con reintentos si el sitio no responde. */
async function api(method, ruta, body) {
  const json = body === undefined ? '' : JSON.stringify(body)
  const route = '/voyporahi/v1/paquetes/' + ruta
  const url = new URL(SITIO.href)
  url.searchParams.set('rest_route', route)
  for (let intento = 0; ; intento++) {
    const fecha = String(Math.floor(Date.now() / 1000))
    const nonce = crypto.randomBytes(18).toString('base64url')
    const msg = [TAG, method, route, SITIO.host.toLowerCase(), fecha, nonce, sha256(json)].join('\n')
    const headers = {
      'content-type': 'application/json',
      'x-vpa-clave': CLAVE.id,
      'x-vpa-fecha': fecha,
      'x-vpa-nonce': nonce,
      'x-vpa-firma': crypto.sign(null, Buffer.from(msg), CLAVE.privateKey).toString('base64'),
    }
    let res, text
    try {
      res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : json, redirect: 'manual' })
      text = await res.text()
    } catch (e) {
      if (intento < 4) { await espera(2000 * 2 ** intento); continue }
      die(`No se pudo conectar con ${SITIO.origin}: ${e.cause?.message ?? e.message}`)
    }
    if (res.status >= 300 && res.status < 400) die(`${SITIO.origin} redirige a ${res.headers.get('location')}: use esa dirección del sitio.`)
    let data
    try { data = JSON.parse(text) } catch {
      if (res.status >= 500 && intento < 4) { await espera(2000 * 2 ** intento); continue }
      die(`${SITIO.origin} respondió ${res.status} con algo que no es la API de Voy Por Ahí (¿el plugin 1.27.0 no está activo, o un bloqueo de seguridad del sitio o del hosting?): ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
    }
    if (res.ok) return data
    // 502/503/504: Cloudflare o el sitio no respondieron; se reintenta con otra firma.
    if ([502, 503, 504].includes(res.status) && data?.code !== 'vpa_r2_off' && intento < 4) { await espera(2000 * 2 ** intento); continue }
    die(`El sitio dice (${res.status}): ${data?.message ?? text.slice(0, 200)}`, res.status === 409 ? 3 : 1)
  }
}

// ---------- Subida de un archivo en partes ----------
function leerParte(fd, n, tam, bytes) {
  const desde = (n - 1) * tam, largo = Math.min(tam, bytes - desde)
  const buf = Buffer.alloc(largo)
  let leidos = 0
  while (leidos < largo) leidos += fs.readSync(fd, buf, leidos, largo - leidos, desde + leidos)
  return buf
}

/** ETag que da S3 a un archivo subido en partes: MD5 de los MD5 de las partes, «-» y la cantidad. */
function etagEnPartes(md5s) { return `${crypto.createHash('md5').update(Buffer.concat(md5s)).digest('hex')}-${md5s.length}` }

const limpiarEtag = (e) => String(e ?? '').replace(/^W\//, '').replace(/"/g, '').trim()

async function subirArchivo(id, version, f, archivo, r) {
  const { uploadId, parte: tam, total } = r
  if (!Number.isInteger(tam) || tam < 5 * 1048576 || Math.ceil(f.bytes / tam) !== total) die(`El sitio propone partes que no cierran para ${f.nombre}.`)
  const fd = fs.openSync(archivo, 'r')
  const md5s = new Array(total), etags = new Array(total)
  const ya = new Map((r.partes ?? []).map((p) => [p.n, p]))
  const faltan = []
  for (let n = 1; n <= total; n++) {
    const p = ya.get(n)
    if (p) {
      const buf = leerParte(fd, n, tam, f.bytes), h = md5(buf)
      // Una parte que ya está se usa solo si es igual a la de este archivo (si no, se vuelve a subir encima).
      if (p.bytes === buf.length && limpiarEtag(p.etag) === h.toString('hex')) { md5s[n - 1] = h; etags[n - 1] = limpiarEtag(p.etag); continue }
    }
    faltan.push(n)
  }
  if (faltan.length < total) console.log(`  ${f.nombre}: ${total - faltan.length} de ${total} partes ya estaban subidas.`)
  const urls = new Map()
  let vence = 0
  const pedirUrls = async (nums) => {
    for (let i = 0; i < nums.length; i += 100) {
      const res = await api('POST', 'partes', { id, version, nombre: f.nombre, uploadId, numeros: nums.slice(i, i + 100) })
      for (const [n, u] of Object.entries(res.urls)) urls.set(Number(n), u)
      vence = res.vence
    }
  }
  let hechas = total - faltan.length
  const cola = [...faltan]
  const trabajador = async () => {
    for (let n = cola.shift(); n !== undefined; n = cola.shift()) {
      const buf = leerParte(fd, n, tam, f.bytes), h = md5(buf)
      for (let intento = 0; ; intento++) {
        if (!urls.has(n) || Date.now() / 1000 > vence - 120) await pedirUrls([n, ...cola.slice(0, 49)])
        let res
        try {
          res = await fetch(urls.get(n), { method: 'PUT', body: buf })
          await res.arrayBuffer()
        } catch (e) {
          if (intento < 4) { await espera(2000 * 2 ** intento); continue }
          die(`No se pudo subir la parte ${n} de ${f.nombre} a Cloudflare: ${e.cause?.message ?? e.message}`)
        }
        if (res.status === 200) {
          const etag = limpiarEtag(res.headers.get('etag'))
          // Cloudflare devuelve el MD5 de la parte: si no es el de lo mandado, la parte llegó mal y se vuelve a subir.
          if (/^[0-9a-f]{32}$/.test(etag) && etag !== h.toString('hex')) { if (intento < 4) continue; die(`La parte ${n} de ${f.nombre} llegó distinta a Cloudflare.`) }
          if (!etag) die(`Cloudflare no devolvió la suma (ETag) de la parte ${n} de ${f.nombre}.`)
          md5s[n - 1] = h; etags[n - 1] = etag
          break
        }
        // 403: la dirección venció o la firma no sirvió; se pide otra. 5xx: se reintenta.
        if ((res.status === 403 || res.status >= 500) && intento < 4) { urls.delete(n); await espera(res.status === 403 ? 0 : 2000 * 2 ** intento); continue }
        die(`Cloudflare respondió ${res.status} al subir la parte ${n} de ${f.nombre}.`)
      }
      hechas++
      process.stdout.write(`  ${f.nombre}: ${hechas}/${total} partes (${Math.floor((100 * hechas) / total)} %)\n`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALELO, Math.max(1, faltan.length)) }, trabajador))
  fs.closeSync(fd)
  const fin = await api('POST', 'completar', { id, version, nombre: f.nombre, uploadId, partes: etags.map((etag, i) => ({ n: i + 1, etag })) })
  const esperado = etagEnPartes(md5s)
  if (limpiarEtag(fin.etag) === esperado) console.log(`  ${f.nombre}: ${mb(f.bytes)} subidos; la suma de Cloudflare coincide (${esperado}).`)
  else console.log(`  ${f.nombre}: ${mb(f.bytes)} subidos; Cloudflare informa otra suma del archivo entero (${limpiarEtag(fin.etag)}): se comprueba bajándolo entero.`)
}

// ---------- Comandos ----------
async function subir(sitio, salida, id, version) {
  const dir = path.join(salida, id, version)
  let texto
  try { texto = fs.readFileSync(path.join(dir, 'manifiesto.json'), 'utf8') } catch { die(`No está ${dir}/manifiesto.json (armar el país con armar.sh).`) }
  const man = JSON.parse(texto)
  if (man.id !== id || man.version !== version) die(`El manifiesto es de ${man.id} ${man.version}, no de ${id} ${version}.`)
  console.log(`Comprobando ${dir} antes de subir…`)
  const v = spawnSync(process.execPath, ['--no-warnings', path.join(AQUI, 'dist', 'herramienta.mjs'), 'verificar', dir], { encoding: 'utf8' })
  process.stdout.write(v.stdout.replace(/^/gm, '  ') + v.stderr)
  if (v.status !== 0) die('Los archivos no coinciden con su manifiesto: no se sube nada.')
  const inicio = await api('POST', 'version', { manifiesto: texto })
  console.log(`${man.nombre} ${version}: ${inicio.estado === 'lista' ? 'ya estaba completa en Cloudflare.' : 'subiendo.'}`)
  if (inicio.estado !== 'lista') {
    for (const f of man.archivos) {
      const r = await api('POST', 'archivo', { id, version, nombre: f.nombre })
      if (r.existe) {
        const fd = fs.openSync(path.join(dir, f.nombre), 'r')
        const md5s = []
        for (let n = 1; (n - 1) * r.parte < f.bytes; n++) md5s.push(md5(leerParte(fd, n, r.parte, f.bytes)))
        fs.closeSync(fd)
        const remoto = limpiarEtag(r.etag), esperado = etagEnPartes(md5s)
        if (remoto === esperado) { console.log(`  ${f.nombre}: ya estaba subido, igual.`); continue }
        // Mismo tamaño y misma cantidad de partes con otra suma: es otro archivo. Si no, no se puede comparar así: lo dice
        // la comprobación completa del final (baja todo y compara cada trozo con el manifiesto).
        if (/^[0-9a-f]{32}-\d+$/.test(remoto) && remoto.split('-')[1] === String(md5s.length)) die(`En Cloudflare ya hay un ${f.nombre} distinto para ${id} ${version}. Lo subido no se cambia: arme otra versión (otra fecha).`, 3)
        console.log(`  ${f.nombre}: ya estaba subido con el mismo tamaño; se comprueba al final bajándolo entero.`)
        continue
      }
      await subirArchivo(id, version, f, path.join(dir, f.nombre), r)
    }
    await api('POST', 'cerrar', { id, version })
    console.log(`${man.nombre} ${version}: completa en Cloudflare (se subió el manifiesto).`)
  }
  console.log(`Comprobando desde afuera, como la app (${inicio.publica})…`)
  const c = spawnSync('sh', [path.join(AQUI, 'comprobar-remoto.sh'), inicio.publica, id, version], {
    encoding: 'utf8', env: { ...process.env, ORIGEN: SITIO.origin, SIN_CATALOGO: '1', COMPLETO: '1' },
  })
  process.stdout.write(c.stdout.replace(/^/gm, '  ') + c.stderr)
  if (c.status !== 0) die('La comprobación desde afuera encontró problemas (arriba). La versión no está lista para publicar.')
  console.log(`Listo para publicar: en ${SITIO.origin}/wp-admin/admin.php?page=voyporahi-paises, «Publicar para los usuarios» en ${man.nombre} ${version}.`)
}

async function estado() {
  const e = await api('GET', 'estado')
  console.log(`Dirección pública: ${e.publica}\nLa app ofrece estos países: ${e.enLaApp ? 'sí' : 'no'}`)
  console.log(`Catálogo publicado: ${e.catalogo.length ? e.catalogo.map((p) => `${p.nombre} ${p.version}`).join(', ') : 'ninguno'}`)
  for (const s of e.subiendo) console.log(`A medio subir: ${s.version} (desde ${new Date(s.creada * 1000).toISOString()})`)
}

const [cmd, ...args] = process.argv.slice(2)
try {
  if (cmd === 'clave' && args.length === 0) crearClave()
  else if ((cmd === 'subir' && args.length === 4) || (cmd === 'estado' && args.length === 1)) {
    SITIO = new URL(args[0].endsWith('/') ? args[0] : args[0] + '/')
    if (SITIO.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(SITIO.hostname)) die('La dirección del sitio tiene que ser https://.')
    CLAVE = cargarClave()
    if (cmd === 'subir') await subir(args[0], ...args.slice(1))
    else await estado()
  } else {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(7, 11).join('\n'))
    process.exit(2)
  }
} catch (e) {
  if (!(e instanceof Falla)) throw e
  console.error(e.message)
  process.exit(e.code)
}
