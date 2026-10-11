# Paquetes por país (1.26.0): saca las calles de un extracto de OpenStreetMap (.osm.pbf) y las reparte en celdas.
# Guarda cada vía, con su geometría y todas sus etiquetas, en cada celda que toca (SQLite), con el mismo formato que
# devuelve Overpass; las relaciones de giros prohibidos van en la celda de su nodo «via». Después `herramienta.mjs calles`
# las empaqueta con el mismo código de la app (packOverpass), así las reglas son las mismas que al bajar de Overpass.
# Las listas de tipos de calle vienen de la app (`herramienta.mjs listas`): no se copian acá.
# Uso: python3 -I calles_extraer.py listas.json extracto.osm.pbf salida.sqlite
import json, math, sqlite3, sys
import osmium

listas_path, pbf, out = sys.argv[1], sys.argv[2], sys.argv[3]
L = json.load(open(listas_path))
DETAIL, MAIN = set(L['detalle']), set(L['principal'])
DZ, MZ = L['zoomDetalle'], L['zoomPrincipal']
# Cada tramo se recorre en pasos de 2 km para anotar las celdas que cruza sin tener un nodo adentro.
STEP_M = 2000

def tile(lat, lon, z):
    n = 2 ** z
    lat = max(-85.05112878, min(85.05112878, lat))
    x = int((lon + 180.0) / 360.0 * n)
    r = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(r)) / math.pi) / 2.0 * n)
    return min(n - 1, max(0, x)), min(n - 1, max(0, y))

def cells_of(geom, z):
    out = set()
    for i, (lat, lon) in enumerate(geom):
        out.add(tile(lat, lon, z))
        if i:
            plat, plon = geom[i - 1]
            d = math.hypot((lat - plat) * 111320, (lon - plon) * 111320 * math.cos(math.radians(lat)))
            k = int(d // STEP_M)
            for s in range(1, k + 1):
                f = s / (k + 1)
                out.add(tile(plat + (lat - plat) * f, plon + (lon - plon) * f, z))
    return out

class Restr(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.rels = []
        self.via = set()
    def relation(self, r):
        t = {k: v for k, v in r.tags}
        if t.get('type') != 'restriction':
            return
        mem = [{'type': {'n': 'node', 'w': 'way', 'r': 'relation'}[m.type], 'ref': m.ref, 'role': m.role} for m in r.members]
        via = [m for m in mem if m['role'] == 'via']
        self.rels.append({'type': 'relation', 'id': r.id, 'members': mem, 'tags': t})
        if len(via) == 1 and via[0]['type'] == 'node':
            self.via.add(via[0]['ref'])

class Ways(osmium.SimpleHandler):
    def __init__(self, db, via):
        super().__init__()
        self.db, self.via = db, via
        self.via_loc = {}
        self.n = 0
        self.skipped = 0
        self.per_cell = {}
        self.bbox = [180.0, 90.0, -180.0, -90.0]
        self.batch = []
    def way(self, w):
        t = {k: v for k, v in w.tags}
        hw = t.get('highway')
        ferry = t.get('route') == 'ferry'
        if not (hw in DETAIL or ferry):
            return
        nodes, geom = [], []
        for nd in w.nodes:
            if not nd.location.valid():
                # Vía cortada por el borde del extracto: se descarta, como hace Valhalla.
                self.skipped += 1
                return
            nodes.append(nd.ref)
            geom.append((round(nd.location.lat, 7), round(nd.location.lon, 7)))
        if len(nodes) < 2:
            return
        for ref, (lat, lon) in zip(nodes, geom):
            if ref in self.via:
                self.via_loc[ref] = (lat, lon)
            b = self.bbox
            b[0], b[1], b[2], b[3] = min(b[0], lon), min(b[1], lat), max(b[2], lon), max(b[3], lat)
        js = json.dumps({'type': 'way', 'id': w.id, 'nodes': nodes, 'geometry': [{'lat': a, 'lon': o} for a, o in geom], 'tags': t}, separators=(',', ':'), ensure_ascii=False)
        for (x, y) in cells_of(geom, DZ):
            self.batch.append((DZ, x, y, w.id, js))
            self.per_cell[(x, y)] = self.per_cell.get((x, y), 0) + 1
        if hw in MAIN or ferry:
            for (x, y) in cells_of(geom, MZ):
                self.batch.append((MZ, x, y, w.id, js))
        self.n += 1
        if len(self.batch) > 20000:
            self.flush()
    def flush(self):
        self.db.executemany('INSERT INTO ways VALUES (?,?,?,?,?)', self.batch)
        self.batch = []

db = sqlite3.connect(out)
db.executescript('''
DROP TABLE IF EXISTS ways; DROP TABLE IF EXISTS restr; DROP TABLE IF EXISTS info;
CREATE TABLE ways (z INTEGER, x INTEGER, y INTEGER, id INTEGER, json TEXT);
CREATE TABLE restr (z INTEGER, x INTEGER, y INTEGER, json TEXT);
CREATE TABLE info (k TEXT PRIMARY KEY, v TEXT);
''')
r = Restr()
r.apply_file(pbf)
h = Ways(db, r.via)
h.apply_file(pbf, locations=True)
h.flush()
rows = []
for rel in r.rels:
    via = [m for m in rel['members'] if m['role'] == 'via']
    if len(via) != 1 or via[0]['type'] != 'node' or via[0]['ref'] not in h.via_loc:
        continue
    lat, lon = h.via_loc[via[0]['ref']]
    js = json.dumps(rel, separators=(',', ':'), ensure_ascii=False)
    for z in (DZ, MZ):
        x, y = tile(lat, lon, z)
        rows.append((z, x, y, js))
db.executemany('INSERT INTO restr VALUES (?,?,?,?)', rows)
db.executescript('CREATE INDEX ways_cell ON ways (z, x, y); CREATE INDEX restr_cell ON restr (z, x, y);')
# Punto de prueba: en la celda de detalle con más vías, el nodo más cercano al promedio de sus vías (seguro es una calle).
centro = [0.0, 0.0]
if h.per_cell:
    (cx, cy), _ = max(h.per_cell.items(), key=lambda kv: kv[1])
    pts = []
    for (js,) in db.execute('SELECT json FROM ways WHERE z = ? AND x = ? AND y = ?', (DZ, cx, cy)):
        g = json.loads(js)['geometry']
        pts.extend((q['lat'], q['lon']) for q in g if tile(q['lat'], q['lon'], DZ) == (cx, cy))
    mlat = sum(p[0] for p in pts) / len(pts)
    mlon = sum(p[1] for p in pts) / len(pts)
    best = min(pts, key=lambda p: (p[0] - mlat) ** 2 + ((p[1] - mlon) * math.cos(math.radians(mlat))) ** 2)
    centro = [round(best[1], 6), round(best[0], 6)]
info = {'vias': h.n, 'descartadas_borde': h.skipped, 'giros_con_nodo': len(rows) // 2, 'relaciones_giro': len(r.rels), 'bbox': h.bbox, 'centro': centro, 'celdas_detalle': len(h.per_cell)}
db.executemany('INSERT INTO info VALUES (?,?)', [(k, json.dumps(v)) for k, v in info.items()])
db.commit()
print(json.dumps(info, ensure_ascii=False))
