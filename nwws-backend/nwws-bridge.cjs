'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const EventProductParser = require('@atmosx/event-product-parser');

const Manager = EventProductParser.Manager || EventProductParser.default;

const DATA_ROOT = process.env.NWWS_BACKEND_DATA_DIR || process.env.NWWS_TEST_DATA_DIR || path.join(__dirname, 'runtime');
const APP_DIR = path.join(DATA_ROOT, 'nwws-backend');
const CACHE_DIR = path.join(APP_DIR, 'cache');
const DB_PATH = path.join(APP_DIR, 'nwws.sqlite');
const NWWS_USERNAME = String(process.env.NWWS_USERNAME || '').trim();
const NWWS_PASSWORD = String(process.env.NWWS_PASSWORD || '').trim();
const NWS_API_URL = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';
const NWWS_ALLOWED_EVENT_NAMES = Object.freeze([
  'tornado emergency',
  'tornado warning',
  'severe thunderstorm warning',
  'flash flood warning',
  'flood warning',
  'tornado watch',
  'severe thunderstorm watch',
  'blizzard warning',
  'winter storm warning',
  'ice storm warning',
  'snow squall warning',
  'wind chill warning',
  'lake effect snow warning',
  'frost/freeze warning',
  'hard freeze warning',
  'freeze warning',
  'winter storm watch',
  'ice storm watch',
  'lake effect snow watch',
  'winter weather advisory',
  'freezing rain advisory',
  'wind chill advisory',
  'lake effect snow advisory',
  'high wind warning',
  'wind advisory',
  'dense fog advisory',
  'special weather statement',
  'hazardous weather outlook',
  'special marine warning',
]);

fs.mkdirSync(CACHE_DIR, { recursive: true });

let parser = null;
const activeAlerts = new Map();
let lastStatus = {
  phase: 'starting',
  message: 'Starting NWWS bridge',
  alertCount: 0,
  updatedAt: new Date().toISOString(),
};
let fatalShutdownScheduled = false;
let nwsApiBootstrapDone = false;
let nwsApiFetchActive = false;
let hasSeenNwwsTraffic = false;
let lastNwwsTrafficAt = 0;
let nwwsAlertBatchCount = 0;
let nwwsMessageCount = 0;
let nwwsOccupantEventCount = 0;
let nwwsExpiredCount = 0;
let lastTrafficDiagnosticAt = 0;

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

function isFatalNwwsError(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('not-authorized')
    || text.includes('not authorized')
    || text.includes('connection is closing')
    || text.includes('starttls_failure')
    || text.includes('packet length too long')
    || text.includes('tls_get_more_records')
    || text.includes('cannot read properties of null')
    || text.includes('maxlistenersexceededwarning')
    || text.includes('error-reconnecting-too-fast')
    || text.includes('write after end')
  );
}

async function stopParserQuietly() {
  if (!parser || typeof parser.stop !== 'function') return;
  try {
    await parser.stop();
  } catch (error) {
    emitLog('warn', `Failed to stop NWWS parser cleanly: ${error?.message || String(error)}`);
  }
}

function scheduleFatalShutdown(message) {
  if (fatalShutdownScheduled) return;
  fatalShutdownScheduled = true;
  const text = String(message || 'Fatal NWWS bridge error');
  emitLog('error', `Scheduling fatal shutdown: ${text}`);
  updateStatus({ phase: 'error', message: text });
  void stopParserQuietly().finally(() => {
    setImmediate(() => process.exit(1));
  });
}

function markNwwsTraffic() {
  hasSeenNwwsTraffic = true;
  lastNwwsTrafficAt = Date.now();
}

function sourceCounts() {
  let bootstrap = 0;
  let nwws = 0;
  for (const entry of activeAlerts.values()) {
    if (entry && entry._source === 'nws-api') bootstrap += 1;
    else nwws += 1;
  }
  return { bootstrap, nwws, total: bootstrap + nwws };
}

function maybeEmitTrafficDiagnostic() {
  if (lastStatus.phase !== 'connected') return;
  const now = Date.now();
  if (now - lastTrafficDiagnosticAt < 15_000) return;
  lastTrafficDiagnosticAt = now;
  const counts = sourceCounts();
  if (!hasSeenNwwsTraffic) {
    emitLog('warn', `[NWWS] No live NWWS traffic received yet; showing ${counts.bootstrap} bootstrapped / ${counts.nwws} live warning polygons`);
    return;
  }
  const ageSec = lastNwwsTrafficAt > 0 ? Math.max(0, Math.round((now - lastNwwsTrafficAt) / 1000)) : -1;
  if (ageSec >= 30) {
    emitLog('warn', `[NWWS] Live traffic idle for ${ageSec}s (live=${counts.nwws}, bootstrap=${counts.bootstrap})`);
  }
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
    const rings = geometry.coordinates.map(normalizeRing).filter(ring => ring.length >= 4);
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

function classifyEvent(eventName) {
  const text = String(eventName || '').toLowerCase();
  if (text.includes('tornado')) return 'tornado';
  if (text.includes('severe thunderstorm')) return 'severe-thunderstorm';
  if (text.includes('flash flood')) return 'flash-flood';
  if (text.includes('special weather statement')) return 'special-weather';
  if (text.includes('special marine')) return 'special-marine';
  if (text.includes('snow squall')) return 'snow-squall';
  return 'warning';
}

function normalizeValueArray(value) {
  if (Array.isArray(value)) return value.map(item => String(item));
  if (value == null || value === '') return [];
  return [String(value)];
}

function normalizeParameters(rawProps) {
  const rawParams = rawProps?.parameters && typeof rawProps.parameters === 'object'
    ? { ...rawProps.parameters }
    : {};
  const vtec = normalizeValueArray(rawParams.VTEC ?? rawParams.vtec ?? rawProps?.pvtec);
  const ugc = normalizeValueArray(rawParams.UGC ?? rawParams.ugc);
  const geocodeUgc = Array.isArray(rawProps?.geocode?.UGC) ? rawProps.geocode.UGC.map(String) : [];
  return {
    ...rawParams,
    VTEC: vtec,
    UGC: ugc.length ? ugc : geocodeUgc,
  };
}

function featureIdForParsedEvent(event) {
  const rawProps = event?.properties && typeof event.properties === 'object' ? event.properties : {};
  return String(
    event?.id
    || rawProps.id
    || event?.tracking
    || rawProps.tracking
    || rawProps.hash
    || ''
  ).trim();
}

function featureFromParsedEvent(event) {
  if (!event || event.type !== 'Feature') return null;
  const geometry = normalizeGeometry(event.geometry);
  if (!geometry) return null;
  const rawProps = event.properties && typeof event.properties === 'object' ? { ...event.properties } : {};
  const history = Array.isArray(event.history)
    ? event.history
    : (Array.isArray(rawProps.history) ? rawProps.history : []);
  const id = featureIdForParsedEvent(event);
  if (!id) return null;
  const issuedRaw = rawProps.issued || rawProps.sent || history[0]?.issued || null;
  const expiresRaw = rawProps.expires || null;
  const parameters = normalizeParameters(rawProps);
  const eventText = String(rawProps.event || rawProps.parent || 'Unknown Warning');
  return {
    type: 'Feature',
    id,
    geometry,
    properties: {
      ...rawProps,
      id,
      tracking: id,
      event: eventText,
      eventRaw: eventText,
      eventClass: classifyEvent(eventText),
      areaDesc: String(rawProps.areaDesc || rawProps.locations || rawProps.location || ''),
      senderName: String(rawProps.senderName || rawProps.sender_name || rawProps.sender || rawProps.sender_icao || ''),
      sender_icao: String(rawProps.sender_icao || ''),
      action: String(rawProps.messageType || history[0]?.type || (rawProps.is_cancelled ? 'Cancelled' : 'Issued')),
      messageType: String(rawProps.messageType || history[0]?.type || (rawProps.is_cancelled ? 'Cancelled' : 'Issued')),
      issued: issuedRaw ? new Date(issuedRaw).toISOString() : null,
      sent: issuedRaw ? new Date(issuedRaw).toISOString() : null,
      effective: rawProps.effective ? new Date(rawProps.effective).toISOString() : null,
      onset: rawProps.onset ? new Date(rawProps.onset).toISOString() : null,
      expires: expiresRaw ? new Date(expiresRaw).toISOString() : null,
      description: String(rawProps.description || ''),
      instruction: String(rawProps.instruction || ''),
      headline: String(rawProps.headline || ''),
      certainty: String(rawProps.certainty || ''),
      severity: String(rawProps.severity || ''),
      urgency: String(rawProps.urgency || ''),
      response: String(rawProps.response || ''),
      parameters,
      tags: Array.isArray(rawProps.tags) ? rawProps.tags.join(', ') : String(rawProps.tags || ''),
      _source: 'nwws',
    },
  };
}

function featureFromNwsApiFeature(feature) {
  if (!feature || feature.type !== 'Feature') return null;
  const geometry = normalizeGeometry(feature.geometry);
  if (!geometry) return null;
  const rawProps = feature.properties || {};
  const eventText = String(rawProps.event || '').trim();
  if (!eventText || !/warning/i.test(eventText)) return null;
  if (eventText.toLowerCase().includes('flood warning') && !eventText.toLowerCase().includes('flash flood')) {
    return null;
  }
  const id = String(feature.id || rawProps.id || '').trim();
  if (!id) return null;
  const expiresMs = rawProps.expires ? new Date(rawProps.expires).getTime() : 0;
  const issuedMs = rawProps.sent ? new Date(rawProps.sent).getTime() : 0;
  const vtec = normalizeValueArray(rawProps?.parameters?.VTEC ?? rawProps?.parameters?.vtec);
  const ugc = normalizeValueArray(rawProps?.parameters?.UGC ?? rawProps?.parameters?.ugc);
  return {
    type: 'Feature',
    id,
    geometry,
    properties: {
      id,
      tracking: id,
      event: eventText,
      eventRaw: eventText,
      eventClass: classifyEvent(eventText),
      areaDesc: String(rawProps.areaDesc || ''),
      senderName: String(rawProps.senderName || rawProps.sender || ''),
      action: String(rawProps.messageType || 'Alert'),
      messageType: String(rawProps.messageType || 'Alert'),
      issued: issuedMs ? new Date(issuedMs).toISOString() : null,
      sent: issuedMs ? new Date(issuedMs).toISOString() : null,
      effective: rawProps.effective || null,
      onset: rawProps.onset || null,
      expires: expiresMs && Number.isFinite(expiresMs) ? new Date(expiresMs).toISOString() : null,
      description: String(rawProps.description || ''),
      instruction: String(rawProps.instruction || ''),
      headline: String(rawProps.headline || ''),
      certainty: String(rawProps.certainty || ''),
      severity: String(rawProps.severity || ''),
      urgency: String(rawProps.urgency || ''),
      response: String(rawProps.response || ''),
      parameters: {
        VTEC: vtec,
        UGC: ugc,
      },
      tags: '',
      _source: 'nws-api',
    },
  };
}

function getFeatureForEntry(entry) {
  return entry?._prebuiltFeature || null;
}

function getExpiresMs(entry) {
  return entry?._rawExpires || 0;
}

function isWarningFeature(feature) {
  const eventText = String(feature?.properties?.event || '').toLowerCase();
  return /warning/i.test(eventText) || eventText.includes('special weather statement');
}

function isSuppressedFloodFeature(feature) {
  const eventText = String(feature?.properties?.event || '').toLowerCase();
  return eventText.includes('flood warning') && !eventText.includes('flash flood');
}

function vtecSignatureFromFeature(feature) {
  const vtec = normalizeValueArray(feature?.properties?.parameters?.VTEC ?? feature?.properties?.parameters?.vtec)[0] || '';
  if (!vtec) return '';
  return vtec.replace(/^\//, '').split('.').slice(0, 5).join('.');
}

function replaceBootstrapDuplicates(feature, liveKey) {
  const liveSig = vtecSignatureFromFeature(feature);
  if (!liveSig) return 0;
  let removed = 0;
  for (const [entryKey, entry] of activeAlerts.entries()) {
    if (entryKey === liveKey || entry?._source !== 'nws-api') continue;
    const entryFeature = getFeatureForEntry(entry);
    const entrySig = vtecSignatureFromFeature(entryFeature);
    if (!entrySig) continue;
    if (entrySig === liveSig) {
      activeAlerts.delete(entryKey);
      removed += 1;
      emitLog('info', `[NWWS] Replaced NWS API bootstrap entry ${entryKey} with live NWWS alert ${liveKey}`);
    }
  }
  return removed;
}

function summarizeSkippedEvent(event) {
  const props = event?.properties && typeof event.properties === 'object' ? event.properties : {};
  const geocode = props?.geocode && typeof props.geocode === 'object' ? props.geocode : {};
  const ugc = Array.isArray(geocode.UGC) ? geocode.UGC.slice(0, 5).map(String) : [];
  return {
    event: String(props.event || props.parent || ''),
    sender: String(props.sender_icao || props.sender || ''),
    tracking: featureIdForParsedEvent(event),
    hasGenerated: geocode.generated != null && String(geocode.generated).trim() !== '',
    ugcCount: Array.isArray(geocode.UGC) ? geocode.UGC.length : 0,
    ugcSample: ugc,
  };
}

function removeAlertByIdentity(event) {
  const keys = new Set();
  const id = featureIdForParsedEvent(event);
  if (id) keys.add(id);
  const feature = featureFromParsedEvent(event);
  const sig = feature ? vtecSignatureFromFeature(feature) : '';
  if (sig) {
    for (const [entryKey, entry] of activeAlerts.entries()) {
      const entryFeature = getFeatureForEntry(entry);
      if (vtecSignatureFromFeature(entryFeature) === sig) {
        keys.add(entryKey);
      }
    }
  }
  let removed = 0;
  for (const key of keys) {
    if (activeAlerts.delete(key)) removed += 1;
  }
  return removed;
}

function pruneExpiredAlerts() {
  const now = Date.now();
  for (const [key, entry] of activeAlerts.entries()) {
    const feature = getFeatureForEntry(entry);
    if (isSuppressedFloodFeature(feature)) {
      activeAlerts.delete(key);
      continue;
    }
    const expires = getExpiresMs(entry);
    if (expires && Number.isFinite(expires) && expires <= now) {
      activeAlerts.delete(key);
    }
  }
}

function publishAlerts() {
  pruneExpiredAlerts();
  const features = [];
  for (const entry of activeAlerts.values()) {
    const feature = getFeatureForEntry(entry);
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
  const counts = sourceCounts();
  if (lastStatus.phase !== 'starting') {
    updateStatus({
      phase: lastStatus.phase,
      message: !hasSeenNwwsTraffic
        ? `Connected to NWWS, awaiting live traffic (${counts.bootstrap} bootstrapped warning polygon${counts.bootstrap === 1 ? '' : 's'})`
        : features.length
          ? `${features.length} active warning polygon${features.length === 1 ? '' : 's'}`
          : 'Connected, no active warning polygons',
      alertCount: features.length,
    });
  }
  maybeEmitTrafficDiagnostic();
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'RadarApp/nwws-bridge',
        'Accept': 'application/geo+json',
      },
      timeout: 20_000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        req.destroy();
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error('Invalid JSON from NWS API'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('NWS API timeout'));
    });
  });
}

async function bootstrapFromNwsApi() {
  if (nwsApiBootstrapDone || nwsApiFetchActive) return;
  nwsApiFetchActive = true;
  try {
    emitLog('info', '[NWS API] Fetching current warnings for one-time bootstrap...');
    const data = await httpsGet(NWS_API_URL);
    const features = Array.isArray(data?.features) ? data.features : [];
    let added = 0;
    for (const feature of features) {
      const normalized = featureFromNwsApiFeature(feature);
      if (!normalized) continue;
      if (activeAlerts.has(normalized.id)) continue;
      const expiresMs = normalized.properties.expires ? new Date(normalized.properties.expires).getTime() : 0;
      activeAlerts.set(normalized.id, {
        _prebuiltFeature: normalized,
        _rawExpires: expiresMs,
        _source: 'nws-api',
      });
      added += 1;
    }
    nwsApiBootstrapDone = true;
    emitLog('info', `[NWS API] Bootstrap complete: loaded ${added} polygon warning(s) — switching to NWWS`);
    updateStatus({
      phase: lastStatus.phase,
      message: `Bootstrapped ${added} warning(s) from NWS API, awaiting NWWS XMPP`,
    });
    publishAlerts();
  } catch (error) {
    nwsApiBootstrapDone = true;
    emitLog('warn', `[NWS API] Bootstrap failed: ${error?.message || String(error)} — continuing with NWWS only`);
  } finally {
    nwsApiFetchActive = false;
  }
}

function createParser() {
  return new Manager({
    database: DB_PATH,
    is_wire: true,
    journal: true,
    noaa_weather_wire_service_settings: {
      reconnection_settings: {
        enabled: false,
        interval: 60,
      },
      credentials: {
        username: NWWS_USERNAME,
        password: NWWS_PASSWORD,
        nickname: 'RadarApp',
      },
      cache: {
        enabled: false,
        max_db_history: 5000,
        max_db_cache_size: 1000,
      },
      preferences: {
        disable_ugc: false,
        disable_vtec: false,
        disable_text: false,
        cap_only: false,
      },
    },
    national_weather_service_settings: {
      interval: 15,
      endpoint: 'https://api.weather.gov/alerts/active',
    },
    global_settings: {
      parent_events_only: true,
      better_event_parsing: true,
      shapefile_coordinates: true,
      shapefile_skip: 10,
      filtering: {
        events: NWWS_ALLOWED_EVENT_NAMES,
        filtered_icao: [],
        ignored_icao: [],
        ignored_events: ['xx', 'test message'],
        ugc_filter: [],
        state_filter: [],
        check_expired: true,
        ignore_test_products: true,
      },
      eas_settings: {
        directory: null,
        intro_wav: null,
      },
    },
  });
}

function attachParserHandlers(instance) {
  instance.on('log', message => {
    const text = String(message || '');
    emitLog('info', text);
    if (isFatalNwwsError(text)) {
      scheduleFatalShutdown(text);
    }
  });

  instance.on('onConnection', nickname => {
    emitLog('info', `NWWS XMPP connection established${nickname ? ` (${nickname})` : ''}`);
    updateStatus({ phase: 'connected', message: 'Connected to NWWS, awaiting traffic' });
    publishAlerts();
  });

  instance.on('onReconnection', data => {
    if (fatalShutdownScheduled) return;
    emitLog('warn', `[NWWS] Reconnection attempt #${data?.reconnects ?? '?'} after ${data?.lastStanza ?? '?'} ms since last stanza`);
    updateStatus({ phase: 'reconnecting', message: 'Reconnecting to NWWS' });
  });

  instance.on('onOccupant', data => {
    nwwsOccupantEventCount += 1;
    void data;
  });

  instance.on('onMessage', data => {
    nwwsMessageCount += 1;
    markNwwsTraffic();
    void data;
  });

  instance.on('onExpired', event => {
    nwwsExpiredCount += 1;
    markNwwsTraffic();
    const removed = removeAlertByIdentity(event);
    if (removed > 0) {
      emitLog('info', `[NWWS] Expired/cancelled alert removed (${removed} entr${removed === 1 ? 'y' : 'ies'})`);
      publishAlerts();
    }
  });

  instance.on('onEvents', events => {
    const list = Array.isArray(events) ? events : [];
    nwwsAlertBatchCount += 1;
    markNwwsTraffic();
    const summary = {
      received: list.length,
      added: 0,
      updated: 0,
      removedBootstrap: 0,
      skippedNonWarning: 0,
      skippedFlood: 0,
      skippedGeometry: 0,
    };
    for (const event of list) {
      const feature = featureFromParsedEvent(event);
      const key = featureIdForParsedEvent(event);
      if (!feature) {
        summary.skippedGeometry += 1;
        if (key) activeAlerts.delete(key);
        continue;
      }
      if (!isWarningFeature(feature)) {
        summary.skippedNonWarning += 1;
        if (key) activeAlerts.delete(key);
        continue;
      }
      if (isSuppressedFloodFeature(feature)) {
        summary.skippedFlood += 1;
        if (key) activeAlerts.delete(key);
        continue;
      }
      const expiresMs = feature.properties.expires ? new Date(feature.properties.expires).getTime() : 0;
      const wasPresent = activeAlerts.has(feature.id);
      activeAlerts.set(feature.id, {
        _prebuiltFeature: feature,
        _rawExpires: expiresMs,
        _source: 'nwws',
      });
      if (wasPresent) summary.updated += 1;
      else summary.added += 1;
      summary.removedBootstrap += replaceBootstrapDuplicates(feature, feature.id);
    }
    const counts = sourceCounts();
    if (summary.added > 0 || summary.updated > 0 || summary.removedBootstrap > 0 || summary.skippedFlood > 0) {
      emitLog(
        'info',
        `[NWWS] Alert batch #${nwwsAlertBatchCount}: received=${summary.received} added=${summary.added} updated=${summary.updated} removedBootstrap=${summary.removedBootstrap} skipped(nonWarning=${summary.skippedNonWarning}, flood=${summary.skippedFlood}, geometry=${summary.skippedGeometry}) live=${counts.nwws} bootstrap=${counts.bootstrap}`
      );
    }
    publishAlerts();
  });
}

process.on('uncaughtException', error => {
  const message = String(error?.stack || error?.message || error || 'Unknown bridge exception');
  emitLog('error', message);
  updateStatus({ phase: 'error', message: String(error?.message || error || 'Unknown bridge exception') });
  if (isFatalNwwsError(message)) scheduleFatalShutdown(String(error?.message || error || 'Fatal NWWS bridge exception'));
});

process.on('unhandledRejection', reason => {
  const message = String(reason?.stack || reason?.message || reason || 'Unknown bridge rejection');
  emitLog('error', message);
  updateStatus({ phase: 'error', message: String(reason?.message || reason || 'Unknown bridge rejection') });
  if (isFatalNwwsError(message)) scheduleFatalShutdown(String(reason?.message || reason || 'Fatal NWWS bridge rejection'));
});

async function shutdownCleanly() {
  await stopParserQuietly();
  process.exit(0);
}

process.on('SIGINT', () => { void shutdownCleanly(); });
process.on('SIGTERM', () => { void shutdownCleanly(); });

emitLog('info', 'NWWS bridge booting');
updateStatus({ phase: 'starting', message: 'Loading NWWS parser package' });
emitLog('info', `Bridge data dir: ${APP_DIR}`);
emitLog('info', `Bridge cache dir: ${CACHE_DIR}`);
emitLog('info', `Bridge database path: ${DB_PATH}`);

if (!NWWS_USERNAME || !NWWS_PASSWORD) {
  emitLog('error', 'NWWS credentials were not provided');
  updateStatus({ phase: 'error', message: 'NWWS login required' });
  process.exit(1);
}

void bootstrapFromNwsApi();

emitLog('info', 'Constructing NWWS parser client');
parser = createParser();
emitLog('info', 'NWWS parser client constructed (@atmosx/event-product-parser)');
emitLog('info', 'NWWS parser reconnect loop disabled via Manager settings');
attachParserHandlers(parser);
updateStatus({ phase: 'starting', message: 'NWWS parser initialized, waiting for XMPP connection' });

setInterval(() => {
  publishAlerts();
}, 250);
