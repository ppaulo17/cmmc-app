require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const cron = require('node-cron');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Base de datos SQLite ───────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'cmmc.db');
const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS stations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    city TEXT NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    elev INTEGER DEFAULT 0,
    url TEXT NOT NULL,
    model TEXT DEFAULT 'WH-1081',
    operator TEXT,
    email TEXT,
    notes TEXT,
    active INTEGER DEFAULT 1,
    is_reference INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    temp REAL,
    hum REAL,
    rain_today REAL,
    rain_month REAL,
    rain_year REAL,
    rain_rate REAL,
    pres REAL,
    pres_trend TEXT,
    wind_gust REAL,
    wind_avg REAL,
    wind_dir INTEGER,
    wind_dir_str TEXT,
    wind_beaufort TEXT,
    dew_point REAL,
    heat_index REAL,
    apparent_temp REAL,
    feels_like REAL,
    updated_str TEXT,
    fetched_at TEXT DEFAULT (datetime('now')),
    online INTEGER DEFAULT 0,
    FOREIGN KEY(station_id) REFERENCES stations(id)
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    value REAL,
    threshold REAL,
    triggered_at TEXT DEFAULT (datetime('now')),
    resolved INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pending_registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    city TEXT,
    url TEXT,
    model TEXT,
    lat REAL,
    lng REAL,
    elev INTEGER,
    email TEXT,
    notes TEXT,
    status TEXT DEFAULT 'pending',
    submitted_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Estaciones iniciales de la red CMMC ────────────────────────────────────
const seedStations = [
  { id: 'Rincon', name: 'NiederHaus', city: 'San José del Rincón', lat: -31.578, lng: -60.544, elev: 16, url: 'https://estaciones.cmmcsat.net.ar/Rincon/', model: 'WH-1081', is_reference: 1 },
  { id: 'CODE', name: 'EMA CODE', city: 'Santa Fe capital', lat: -31.626, lng: -60.679, elev: 20, url: 'https://estaciones.cmmcsat.net.ar/CODE/', model: 'WT-1081' },
  { id: 'Sgto_Cabral', name: 'Gral. Paz', city: 'Sgto. Cabral, SF', lat: -31.618, lng: -60.697, elev: 18, url: 'https://www.estaciones.cmmcsat.net.ar/Sgto_Cabral/', model: 'WH-1081' },
  { id: 'Candioti_Norte', name: 'Candioti Norte', city: 'SF capital', lat: -31.607, lng: -60.710, elev: 17, url: 'https://www.estaciones.cmmcsat.net.ar/Candioti_Norte/', model: 'WH-1081' },
  { id: 'SanCris', name: 'San Cristóbal', city: 'San Cristóbal, SF', lat: -30.330, lng: -61.239, elev: 80, url: 'https://estaciones.cmmcsat.net.ar/SanCris/', model: 'WH-1081T' },
  { id: 'Melincue', name: 'Melincué', city: 'Melincué, SF', lat: -34.004, lng: -61.475, elev: 90, url: 'https://www.estaciones.cmmcsat.net.ar/Melincue/', model: 'WH-1081' },
  { id: 'EIS', name: 'Escuela Industrial', city: 'Santa Fe capital', lat: -31.632, lng: -60.688, elev: 19, url: 'https://estaciones.cmmcsat.net.ar/EIS/', model: 'Davis Vantage Vue' },
  { id: 'FIQ', name: 'FIQ-UNL', city: 'Santa Fe capital', lat: -31.615, lng: -60.683, elev: 18, url: 'https://estaciones.cmmcsat.net.ar/movil/', model: 'WH-1081T' },
];

const insertStation = db.prepare(`
  INSERT OR IGNORE INTO stations (id, name, city, lat, lng, elev, url, model, is_reference)
  VALUES (@id, @name, @city, @lat, @lng, @elev, @url, @model, @is_reference)
`);
seedStations.forEach(s => insertStation.run({ is_reference: 0, ...s }));

// ─── Parser de HTML de Cumulus ───────────────────────────────────────────────
function parseCumulusHTML(html) {
  const d = {};
  // Normalizar separadores decimales (puede ser coma o punto)
  const t = html.replace(/(\d),(\d)/g, '$1.$2');

  const extract = (pattern, transform = v => parseFloat(v)) => {
    const m = t.match(pattern);
    return m ? transform(m[1]) : null;
  };

  d.temp        = extract(/Temperatura\s*\|\s*([\d.]+)\s*°C/i);
  d.hum         = extract(/Humedad\s*\|\s*(\d+)\s*%/i, v => parseInt(v));
  d.rain_today  = extract(/Precipitaci[oó]n hoy\s*\|\s*([\d.]+)\s*mm/i);
  d.rain_month  = extract(/Precipitaciones este mes\s*\|\s*([\d.]+)\s*mm/i);
  d.rain_year   = extract(/Precipitaciones este a[ñn]o\s*\|\s*([\d.]+)\s*mm/i);
  d.rain_rate   = extract(/Tasa de precipitaci[oó]n actual\s*\|\s*([\d.]+)\s*mm/i);
  d.pres        = extract(/Bar[oó]metro\s*\|\s*([\d.]+)\s*hPa/i);
  d.wind_gust   = extract(/Velocidad de viento \(R[aá]faga\)\s*\|\s*([\d.]+)\s*km\/h/i);
  d.wind_avg    = extract(/Velocidad de viento\(Prom 10 min\)\s*\|\s*([\d.]+)\s*km\/h/i);
  d.dew_point   = extract(/Punto de roc[ií]o\s*\|\s*([\d.]+)\s*°C/i);
  d.heat_index  = extract(/[Íi]ndice de calor\s*\|\s*([\d.]+)\s*°C/i);
  d.feels_like  = extract(/Sensaci[oó]n t[eé]rmica\s*\|\s*([\d.]+)\s*°C/i);
  d.apparent_temp = extract(/Temperatura aparente\s*\|\s*([\d.]+)\s*°C/i);

  const wdMatch = t.match(/Direcci[oó]n del viento\s*\|\s*(\d+)°\s*(\S+)/i);
  if (wdMatch) { d.wind_dir = parseInt(wdMatch[1]); d.wind_dir_str = wdMatch[2]; }

  const bfMatch = t.match(/Beaufort\s+F(\d)\s*\|\s*(.+?)(?:\n|\|)/i);
  if (bfMatch) d.wind_beaufort = `F${bfMatch[1]} ${bfMatch[2].trim()}`;

  const pTrend = t.match(/Bar[oó]metro\s*\|[^|]+\|\s*([A-Za-záéíóú ]+)/i);
  if (pTrend) d.pres_trend = pTrend[1].trim().slice(0, 30);

  const updMatch = t.match(/Condiciones a la hora local:\s*(.+?)(?:\n|$)/i);
  if (updMatch) d.updated_str = updMatch[1].trim();

  d.online = d.temp !== null;
  return d;
}

// ─── Parser de todo.php (una sola URL con todas las estaciones) ──────────────
function parseTodoPHP(html) {
  // Mapeo nombre en todo.php -> id en nuestra DB
  const nameMap = {
    'sgto. cabral': 'Sgto_Cabral',
    'candioti n': 'Candioti_Norte',
    'fiq1 (telemática)': 'FIQ',
    'fiq1 (directo)': 'FIQ',
    'fiq2': 'FIQ',
    'eis': 'EIS',
    'sur': null,
    'colastine n 1': null,
    'arroyo leyes': null,
    'movil': null,
    'recreo': null,
    'santo tomé': null,
    'coronda': null,
    'laguna paiva': null,
    'san justo': null,
    'tostado': null,
    'arrufó': null,
    'san cristobal': 'SanCris',
    'arteaga': null,
    'gral. lagos': null,
  };

  const results = {};
  const t = html.replace(/,/g, '.');

  // Parser de bloques separados por ---
  const blocks = t.split("---");
  blocks.forEach(block => {
    const nameMatch = block.match(/^([^\n:]+):/m);
    if (!nameMatch) return;
    const rawName = nameMatch[1].trim().toLowerCase();
    const stationId = nameMap[rawName];
    if (!stationId) return;
    if (results[stationId]) return; // ya lo tenemos

    if (block.includes('OFF-LINE')) {
      results[stationId] = { online: false };
      return;
    }

    const horaMatch = block.match(/Hora:\s*(.+)/i);
    const tMatch = block.match(/T:\s*([\d.]+)°C/i);
    const hMatch = block.match(/H:\s*(\d+)%/i);
    const pMatch = block.match(/P:\s*([\d.]+)hPa/i);
    const rMatch = block.match(/Lluvia:\s*([\d.]+)mm/i);
    const wMatch = block.match(/Viento:\s*(\d+)°\s*(\S+)\s*([\d.]+)\s*km\/h,([\d.]+)/i);

    if (!tMatch) return;

    results[stationId] = {
      online: true,
      temp: parseFloat(tMatch[1]),
      hum: hMatch ? parseInt(hMatch[1]) : null,
      pres: pMatch ? parseFloat(pMatch[1]) : null,
      rain_today: rMatch ? parseFloat(rMatch[1]) : null,
      wind_gust: wMatch ? parseFloat(wMatch[3]) : null,
      wind_avg: wMatch ? parseFloat(wMatch[4]) : null,
      wind_dir: wMatch ? parseInt(wMatch[1]) : null,
      wind_dir_str: wMatch ? wMatch[2] : null,
      updated_str: horaMatch ? horaMatch[1].trim() : null,
    };
  });

  return results;
}

// ─── Scraping desde todo.php ──────────────────────────────────────────────────
async function updateAllStations() {
  if (isFetching) return;
  isFetching = true;
  console.log(`[${new Date().toISOString()}] Actualizando desde todo.php...`);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const res = await fetch('https://cmmcsat.net.ar/todo.php', {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CMMC-Monitor/1.0)' }
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const parsed = parseTodoPHP(html);

    // Guardar lecturas de las estaciones que pudimos parsear
    Object.entries(parsed).forEach(([stationId, data]) => {
      try {
        saveReading(stationId, data);
        if (data.online) console.log(`[${stationId}] OK: ${data.temp}°C`);
      } catch(e) { console.log(`[${stationId}] save error:`, e.message); }
    });

    // Estaciones no encontradas en todo.php -> marcar offline
    const allStations = db.prepare('SELECT id FROM stations WHERE active=1').all();
    allStations.forEach(s => {
      if (!parsed[s.id]) saveReading(s.id, { online: false });
    });

    lastFetchTime = new Date().toISOString();
    console.log(`[${lastFetchTime}] Actualización completa. ${Object.keys(parsed).length} estaciones.`);
  } catch(err) {
    console.log('Error actualizando:', err.message);
  }
  isFetching = false;
}

// ─── Guardar lectura// ─── Guardar lectura y evaluar alertas ──────────────────────────────────────
const insertReading = db.prepare(`
  INSERT INTO readings (
    station_id, temp, hum, rain_today, rain_month, rain_year, rain_rate,
    pres, pres_trend, wind_gust, wind_avg, wind_dir, wind_dir_str,
    wind_beaufort, dew_point, heat_index, apparent_temp, feels_like,
    updated_str, online
  ) VALUES (
    @station_id, @temp, @hum, @rain_today, @rain_month, @rain_year, @rain_rate,
    @pres, @pres_trend, @wind_gust, @wind_avg, @wind_dir, @wind_dir_str,
    @wind_beaufort, @dew_point, @heat_index, @apparent_temp, @feels_like,
    @updated_str, @online
  )
`);

const insertAlert = db.prepare(`
  INSERT INTO alerts (station_id, type, message, value, threshold)
  VALUES (@station_id, @type, @message, @value, @threshold)
`);

const THRESHOLDS = {
  rain_today: { warn: 10, alert: 20 },
  wind_gust:  { warn: 30, alert: 50 },
  temp_max:   { alert: 38 },
  temp_min:   { alert: 0 },
};

function evaluateAlerts(stationId, data) {
  if (!data.online) return;
  const alerts = [];
  if (data.rain_today >= THRESHOLDS.rain_today.alert)
    alerts.push({ type: 'rain_alert', message: `Lluvia intensa: ${data.rain_today} mm`, value: data.rain_today, threshold: THRESHOLDS.rain_today.alert });
  else if (data.rain_today >= THRESHOLDS.rain_today.warn)
    alerts.push({ type: 'rain_warn', message: `Lluvia moderada: ${data.rain_today} mm`, value: data.rain_today, threshold: THRESHOLDS.rain_today.warn });
  if (data.wind_gust >= THRESHOLDS.wind_gust.alert)
    alerts.push({ type: 'wind_alert', message: `Ráfaga fuerte: ${data.wind_gust} km/h`, value: data.wind_gust, threshold: THRESHOLDS.wind_gust.alert });
  if (data.temp !== null && data.temp >= THRESHOLDS.temp_max.alert)
    alerts.push({ type: 'temp_max', message: `Temperatura extrema: ${data.temp}°C`, value: data.temp, threshold: THRESHOLDS.temp_max.alert });
  if (data.temp !== null && data.temp <= THRESHOLDS.temp_min.alert)
    alerts.push({ type: 'temp_min', message: `Helada: ${data.temp}°C`, value: data.temp, threshold: THRESHOLDS.temp_min.alert });
  alerts.forEach(a => insertAlert.run({ station_id: stationId, ...a }));
}

function saveReading(stationId, data) {
  insertReading.run({ station_id: stationId, online: data.online ? 1 : 0, ...data });
  evaluateAlerts(stationId, data);
}

// ─── Ciclo de actualización ──────────────────────────────────────────────────
let lastFetchTime = null;
let isFetching = false;


// Cada 5 minutos (igual que la frecuencia de Cumulus)
cron.schedule('*/5 * * * *', updateAllStations);
// Primera ejecución al arrancar
updateAllStations();

// ─── API REST ────────────────────────────────────────────────────────────────

// GET /api/stations — lista todas las estaciones con última lectura
app.get('/api/stations', (req, res) => {
  const stations = db.prepare('SELECT * FROM stations WHERE active = 1 ORDER BY is_reference DESC, name ASC').all();
  const result = stations.map(s => {
    const last = db.prepare(`
      SELECT * FROM readings WHERE station_id = ? ORDER BY fetched_at DESC LIMIT 1
    `).get(s.id);
    return { ...s, reading: last || null };
  });
  res.json({ stations: result, last_update: lastFetchTime, fetching: isFetching });
});

// GET /api/stations/:id — detalle de una estación
app.get('/api/stations/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Estación no encontrada' });
  const readings = db.prepare(`
    SELECT * FROM readings WHERE station_id = ? ORDER BY fetched_at DESC LIMIT 288
  `).all(s.id); // últimas 24h a 5min
  const alerts = db.prepare(`
    SELECT * FROM alerts WHERE station_id = ? ORDER BY triggered_at DESC LIMIT 20
  `).all(s.id);
  res.json({ station: s, readings, alerts });
});

// GET /api/readings/latest — última lectura de cada estación activa
app.get('/api/readings/latest', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, s.name, s.city, s.lat, s.lng, s.is_reference, s.url, s.model
    FROM readings r
    JOIN stations s ON s.id = r.station_id
    WHERE r.fetched_at = (
      SELECT MAX(r2.fetched_at) FROM readings r2 WHERE r2.station_id = r.station_id
    )
    AND s.active = 1
    ORDER BY s.is_reference DESC, s.name ASC
  `).all();
  res.json(rows);
});

// GET /api/alerts — alertas activas y recientes
app.get('/api/alerts', (req, res) => {
  const active = db.prepare(`
    SELECT a.*, s.name as station_name FROM alerts a
    JOIN stations s ON s.id = a.station_id
    WHERE a.triggered_at > datetime('now', '-24 hours')
    ORDER BY a.triggered_at DESC LIMIT 50
  `).all();
  res.json(active);
});

// GET /api/history/:id?hours=24 — historial de una estación
app.get('/api/history/:id', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const rows = db.prepare(`
    SELECT * FROM readings
    WHERE station_id = ? AND fetched_at > datetime('now', '-${hours} hours')
    ORDER BY fetched_at ASC
  `).all(req.params.id);
  res.json(rows);
});

// GET /api/compare — comparación de todas las estaciones activas
app.get('/api/compare', (req, res) => {
  const ref = db.prepare(`
    SELECT r.* FROM readings r
    JOIN stations s ON s.id = r.station_id
    WHERE s.is_reference = 1
    ORDER BY r.fetched_at DESC LIMIT 1
  `).get();

  const all = db.prepare(`
    SELECT r.*, s.name, s.city, s.lat, s.lng, s.is_reference
    FROM readings r
    JOIN stations s ON s.id = r.station_id
    WHERE r.fetched_at = (
      SELECT MAX(r2.fetched_at) FROM readings r2 WHERE r2.station_id = r.station_id
    )
    AND s.active = 1 AND r.online = 1
  `).all();

  const result = all.map(row => ({
    ...row,
    diff_temp: ref && row.temp != null && ref.temp != null ? +(row.temp - ref.temp).toFixed(1) : null,
    diff_rain: ref && row.rain_today != null && ref.rain_today != null ? +(row.rain_today - ref.rain_today).toFixed(1) : null,
    diff_pres: ref && row.pres != null && ref.pres != null ? +(row.pres - ref.pres).toFixed(1) : null,
  }));
  res.json({ reference: ref, stations: result });
});

// POST /api/push-readings — recibir datos scrapeados desde el frontend
app.post('/api/push-readings', (req, res) => {
  const readings = req.body;
  if (!Array.isArray(readings)) return res.status(400).json({ error: 'Array esperado' });
  let saved = 0;
  readings.forEach(data => {
    if (!data.station_id) return;
    try {
      insertReading.run({
        station_id: data.station_id,
        temp: data.temp ?? null, hum: data.hum ?? null,
        rain_today: data.rain_today ?? null, rain_month: data.rain_month ?? null,
        rain_year: data.rain_year ?? null, rain_rate: data.rain_rate ?? null,
        pres: data.pres ?? null, pres_trend: data.pres_trend ?? null,
        wind_gust: data.wind_gust ?? null, wind_avg: data.wind_avg ?? null,
        wind_dir: data.wind_dir ?? null, wind_dir_str: data.wind_dir_str ?? null,
        wind_beaufort: data.wind_beaufort ?? null, dew_point: data.dew_point ?? null,
        heat_index: data.heat_index ?? null, apparent_temp: data.apparent_temp ?? null,
        feels_like: data.feels_like ?? null, updated_str: data.updated_str ?? null,
        online: data.online ? 1 : 0
      });
      evaluateAlerts(data.station_id, data);
      saved++;
    } catch(e) { console.log('push-readings error:', e.message); }
  });
  lastFetchTime = new Date().toISOString();
  res.json({ saved });
});

// POST /api/refresh — forzar actualización manual
app.post('/api/refresh', async (req, res) => {
  res.json({ message: 'Actualización iniciada' });
  updateAllStations();
});

// POST /api/register — registrar nueva estación (pendiente de aprobación)
app.post('/api/register', (req, res) => {
  const { name, city, url, model, lat, lng, elev, email, notes } = req.body;
  if (!name || !url) return res.status(400).json({ error: 'Nombre y URL son requeridos' });
  const stmt = db.prepare(`
    INSERT INTO pending_registrations (name, city, url, model, lat, lng, elev, email, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(name, city || '', url, model || 'WH-1081', lat || 0, lng || 0, elev || 0, email || '', notes || '');
  res.json({ message: 'Solicitud recibida. El equipo CMMC la revisará en breve.' });
});

// POST /api/stations — agregar estación directamente (admin)
app.post('/api/stations', (req, res) => {
  const { id, name, city, lat, lng, elev, url, model } = req.body;
  if (!id || !name || !url) return res.status(400).json({ error: 'id, name y url son requeridos' });
  try {
    db.prepare(`
      INSERT INTO stations (id, name, city, lat, lng, elev, url, model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, city || '', lat || 0, lng || 0, elev || 0, url, model || 'WH-1081');
    res.json({ message: 'Estación agregada', id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/pending — ver registros pendientes (admin)
app.get('/api/pending', (req, res) => {
  const rows = db.prepare('SELECT * FROM pending_registrations ORDER BY submitted_at DESC').all();
  res.json(rows);
});

// GET /api/status — health check
app.get('/api/status', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM stations WHERE active=1').get().c;
  const online = db.prepare(`
    SELECT COUNT(DISTINCT station_id) as c FROM readings
    WHERE online=1 AND fetched_at > datetime('now', '-15 minutes')
  `).get().c;
  res.json({ status: 'ok', total_stations: total, online, last_update: lastFetchTime, fetching: isFetching });
});

app.listen(PORT, () => {
  console.log(`\n🌦  CMMC SAT Backend corriendo en http://localhost:${PORT}`);
  console.log(`   API: http://localhost:${PORT}/api/stations`);
  console.log(`   Estado: http://localhost:${PORT}/api/status\n`);
});
