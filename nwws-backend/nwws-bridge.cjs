const fs = require('fs');
const path = require('path');
const { AtmosXWireParser } = require('atmosx-nwws-parser');

const DATA_ROOT = process.env.NWWS_BACKEND_DATA_DIR || process.env.NWWS_TEST_DATA_DIR || path.join(__dirname, 'runtime');
const APP_DIR = path.join(DATA_ROOT, 'nwws-backend');
const CACHE_DIR = path.join(APP_DIR, 'cache');
const DB_PATH = path.join(APP_DIR, 'nwws.sqlite');
const NWWS_USERNAME = String(process.env.NWWS_USERNAME || '').trim();
const NWWS_PASSWORD = String(process.env.NWWS_PASSWORD || '').trim();

fs.mkdirSync(CACHE_DIR, { recursive: true });

const activeAlerts = new Map();
let lastStatus = {
  phase: 'starting',
  message: 'Starting NWWS bridge',
  alertCount: 0,
  updatedAt: new Date().toISOString(),
};
let fatalShutdownScheduled = false;

function isFatalNwwsError(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('not-authorized')
    || text.includes('starttls_failure')
    || text.includes('packet length too long')
    || text.includes('tls_get_more_records')
    || text.includes('cannot read properties of null')
    || text.includes('maxlistenersexceededwarning')
    || text.includes('error-reconnecting-too-fast')
    || text.includes('write after end')
  );
}

function scheduleFatalShutdown(message) {
  if (fatalShutdownScheduled) return;
  fatalShutdownScheduled = true;
  updateStatus({
    phase: 'error',
    message: String(message || 'Fatal NWWS bridge error'),
  });
  setImmediate(() => process.exit(1));
}

function emit(type, payload) {
  process.stdout.write(`${JSON.stringify({ type, payload })}\n`);
}

function emitLog(level, message, extra = {}) {
  emit('log', {
    level: String(level || 'info'),
    message: String(message || ''),
    timestamp: new Date().toISOString(),
    ...extra,
  });
}

function updateStatus(partial) {
  lastStatus = {
    ...lastStatus,
    ...partial,
    updatedAt: new Date().toISOString(),
    alertCount: activeAlerts.size,
  };
  emit('status', lastStatus);
}

function reflectLogToStatus(level, message) {
  const text = String(message || '');
  const lower = text.toLowerCase();
  if (lastStatus.phase === 'connected' || lastStatus.phase === 'error') {
    return;
  }
  if (lower.includes('importing ') || lower.includes('finished importing')) {
    updateStatus({
      phase: 'starting',
      message: text,
    });
    return;
  }
  if (lower.includes('shapefiles have been successfully created')) {
    updateStatus({
      phase: 'starting',
      message: 'Shapefile database is ready, waiting for NWWS connection',
    });
    return;
  }
  if (level === 'error') {
    updateStatus({
      phase: 'error',
      message: text,
    });
  }
}

function patchConsole() {
  console.log = (...args) => {
    const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
    emitLog('info', message);
    reflectLogToStatus('info', message);
  };
  console.warn = (...args) => {
    const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
    emitLog('warn', message);
    reflectLogToStatus('warn', message);
  };
  console.error = (...args) => {
    const message = args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ');
    emitLog('error', message);
    reflectLogToStatus('error', message);
  };
}

function classifyEvent(eventName) {
  const text = String(eventName || '').toLowerCase();
  if (text.includes('tornado')) return 'tornado';
  if (text.includes('severe thunderstorm')) return 'severe-thunderstorm';
  if (text.includes('flash flood')) return 'flash-flood';
  if (text.includes('special marine')) return 'special-marine';
  if (text.includes('snow squall')) return 'snow-squall';
  return 'warning';
}

function isWarningAlert(alert) {
  return /warning/i.test(String(alert?.properties?.event || ''));
}

function isSuppressedFloodWarning(alert) {
  const eventText = String(alert?.properties?.event || '').toLowerCase();
  return eventText.includes('flood warning') && !eventText.includes('flash flood');
}

function isCancellation(alert) {
  const actionText = [
    alert?.action,
    alert?.properties?.messageType,
    alert?.history?.[0]?.action,
  ].filter(Boolean).join(' ').toLowerCase();
  return /cancel|expire|expired|cancellation|cancelled/i.test(actionText);
}

function normalizeRing(ring) {
  if (!Array.isArray(ring)) return [];
  const points = ring
    .filter(point => Array.isArray(point) && point.length >= 2)
    .map(point => [Number(point[0]), Number(point[1])])
    .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
  if (points.length < 3) return [];
  const first = points[0];
  const last = points[points.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    points.push([first[0], first[1]]);
  }
  return points;
}

function normalizeGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
    const rings = geometry.coordinates
      .map(normalizeRing)
      .filter(ring => ring.length >= 4);
    if (!rings.length) return null;
    return { type: 'Polygon', coordinates: rings };
  }
  if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
    const polygons = geometry.coordinates
      .map(polygon => Array.isArray(polygon) ? polygon.map(normalizeRing).filter(ring => ring.length >= 4) : [])
      .filter(polygon => polygon.length);
    if (!polygons.length) return null;
    return { type: 'MultiPolygon', coordinates: polygons };
  }
  return null;
}

function featureFromAlert(alert) {
  const geometry = normalizeGeometry(alert?.geometry);
  if (!geometry) return null;
  const rawProps = alert?.properties && typeof alert.properties === 'object'
    ? { ...alert.properties }
    : {};
  const expires = alert?.properties?.expires ? new Date(alert.properties.expires) : null;
  const issued = alert?.history?.[0]?.issued || alert?.properties?.sent || null;
  const id = String(alert?.tracking || alert?.id || '');
  if (!id) return null;
  return {
    type: 'Feature',
    id,
    geometry,
    properties: {
      ...rawProps,
      id,
      tracking: id,
      event: String(rawProps.event || 'Unknown Warning'),
      eventClass: classifyEvent(rawProps.event),
      areaDesc: String(rawProps.areaDesc || ''),
      senderName: String(rawProps.senderName || rawProps.sender || ''),
      action: String(alert?.action || rawProps.messageType || ''),
      issued: issued ? new Date(issued).toISOString() : null,
      sent: issued ? new Date(issued).toISOString() : (rawProps.sent || null),
      effective: rawProps.effective || null,
      onset: rawProps.onset || null,
      expires: expires && !Number.isNaN(expires.getTime()) ? expires.toISOString() : null,
      description: String(rawProps.description || ''),
      instruction: String(rawProps.instruction || ''),
      headline: String(rawProps.headline || ''),
      certainty: String(rawProps.certainty || ''),
      severity: String(rawProps.severity || ''),
      urgency: String(rawProps.urgency || ''),
      response: String(rawProps.response || ''),
      parameters: rawProps.parameters && typeof rawProps.parameters === 'object'
        ? rawProps.parameters
        : {},
      tags: Array.isArray(rawProps.tags) ? rawProps.tags.join(', ') : String(rawProps.tags || ''),
    },
  };
}

function pruneExpiredAlerts() {
  const now = Date.now();
  for (const [key, alert] of activeAlerts.entries()) {
    if (isSuppressedFloodWarning(alert)) {
      activeAlerts.delete(key);
      continue;
    }
    const expires = alert?.properties?.expires ? new Date(alert.properties.expires).getTime() : 0;
    if (expires && Number.isFinite(expires) && expires <= now) {
      activeAlerts.delete(key);
    }
  }
}

function publishAlerts() {
  pruneExpiredAlerts();
  const features = [];
  for (const alert of activeAlerts.values()) {
    const feature = featureFromAlert(alert);
    if (feature) features.push(feature);
  }
  features.sort((a, b) => {
    const aTime = Date.parse(a.properties.issued || '') || 0;
    const bTime = Date.parse(b.properties.issued || '') || 0;
    return bTime - aTime;
  });
  emit('alerts', {
    type: 'FeatureCollection',
    features,
    generatedAt: new Date().toISOString(),
  });
  updateStatus({
    phase: lastStatus.phase === 'error' ? 'connected' : (lastStatus.phase || 'connected'),
    message: features.length ? `${features.length} active warning polygon${features.length === 1 ? '' : 's'}` : 'Connected, no active warning polygons',
    alertCount: features.length,
  });
}

process.on('uncaughtException', (error) => {
  const message = String(error?.stack || error?.message || error || 'Unknown bridge exception');
  emitLog('error', message);
  updateStatus({
    phase: 'error',
    message: String(error?.message || error || 'Unknown bridge exception'),
  });
});

process.on('unhandledRejection', (reason) => {
  const message = String(reason?.stack || reason?.message || reason || 'Unknown bridge rejection');
  emitLog('error', message);
  updateStatus({
    phase: 'error',
    message: String(reason?.message || reason || 'Unknown bridge rejection'),
  });
});

patchConsole();

emitLog('info', 'NWWS bridge booting');
updateStatus({
  phase: 'starting',
  message: 'Loading NWWS parser package',
});
emitLog('info', `Bridge data dir: ${APP_DIR}`);
emitLog('info', `Bridge cache dir: ${CACHE_DIR}`);
emitLog('info', `Bridge database path: ${DB_PATH}`);

emitLog('info', 'Constructing NWWS parser client');
if (!NWWS_USERNAME || !NWWS_PASSWORD) {
  emitLog('error', 'NWWS credentials were not provided');
  updateStatus({
    phase: 'error',
    message: 'NWWS login required',
  });
  process.exit(1);
}
const client = new AtmosXWireParser({
  database: DB_PATH,
  authentication: {
    username: NWWS_USERNAME,
    password: NWWS_PASSWORD,
    display: 'RadarApp',
  },
  cacheSettings: {
    readCache: true,
    maxMegabytes: 16,
    cacheDir: CACHE_DIR,
  },
  alertSettings: {
    onlyCap: false,
    betterEvents: true,
    ugcPolygons: false,
    expiryCheck: true,
    filteredAlerts: [],
  },
  xmpp: {
    reconnect: true,
    reconnectInterval: 60,
  },
});
emitLog('info', 'NWWS parser client constructed');
updateStatus({
  phase: 'starting',
  message: 'NWWS parser initialized, waiting for XMPP connection',
});

client.onEvent('onConnection', () => {
  emitLog('info', 'NWWS XMPP connection established');
  updateStatus({
    phase: 'connected',
    message: 'Connected to NWWS',
  });
  publishAlerts();
});

client.onEvent('onReconnect', () => {
  if (fatalShutdownScheduled) return;
  emitLog('warn', 'NWWS bridge is reconnecting');
  updateStatus({
    phase: 'reconnecting',
    message: 'Reconnecting to NWWS',
  });
});

client.onEvent('onError', (error) => {
  if (fatalShutdownScheduled) return;
  const message = String(error?.stack || error?.message || error || 'Unknown NWWS error');
  emitLog('error', message);
  updateStatus({
    phase: 'error',
    message: String(error?.message || error || 'Unknown NWWS error'),
  });
  if (isFatalNwwsError(message)) {
    emitLog('error', 'NWWS bridge encountered a fatal auth/TLS error and will stop reconnecting');
    scheduleFatalShutdown(String(error?.message || error || 'Fatal NWWS error'));
  }
});

client.onEvent('onAlert', (alerts) => {
  emitLog('info', `Received ${Array.isArray(alerts) ? alerts.length : 0} NWWS alert object(s)`);
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const key = String(alert?.tracking || alert?.id || '');
    if (!key) continue;
    if (
      isCancellation(alert)
      || !isWarningAlert(alert)
      || isSuppressedFloodWarning(alert)
      || !normalizeGeometry(alert?.geometry)
    ) {
      activeAlerts.delete(key);
      continue;
    }
    activeAlerts.set(key, alert);
  }
  publishAlerts();
});

client.onEvent('onStormReport', () => {});
client.onEvent('onMesoscaleDiscussion', () => {});
client.onEvent('onMessage', () => {});
client.onEvent('onOccupant', () => {});

setInterval(() => {
  publishAlerts();
}, 1000);

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
