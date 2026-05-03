'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const EventProductParser = require('@atmosx/event-product-parser');

function makeNwwsNickname(username = '') {
  const cleanUser = String(username).replace(/[^a-zA-Z0-9]/g, '').slice(-6);
  const random = crypto.randomBytes(3).toString('hex');
  return `RadarApp-${cleanUser || 'user'}-${random}`;
}

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
let lastPublishedAlertSignature = '';
const NWWS_DEBUG = process.env.NWWS_DEBUG === '1';
const droppedGeometryLogKeys = new Set();
let lastLoggedActiveCount = -1;
const BRIDGE_STARTED_MS = Date.now();
const NWWS_REPLAY_GRACE_MS = 60_000;

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

function nwwsLog(message) {
  emitLog('info', `[NWWS] ${String(message || '').trim()}`);
}

function nwwsWarn(message) {
  emitLog('warn', `[NWWS] ${String(message || '').trim()}`);
}

function nwwsDebug(message) {
  if (!NWWS_DEBUG) return;
  emitLog('info', `[NWWS DEBUG] ${String(message || '').trim()}`);
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
    || text.includes('attempting to reconnect too fast')
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
  if (now - lastTrafficDiagnosticAt < 60_000) return;
  lastTrafficDiagnosticAt = now;
  const counts = sourceCounts();
  if (!hasSeenNwwsTraffic) {
    nwwsDebug(`No live traffic yet; bootstrap=${counts.bootstrap} live=${counts.nwws}`);
    return;
  }
  const ageSec = lastNwwsTrafficAt > 0 ? Math.max(0, Math.round((now - lastNwwsTrafficAt) / 1000)) : -1;
  if (ageSec >= 120) {
    const roomOk = nwwsOccupantEventCount > 0 ? `room-joined` : `room-NOT-confirmed`;
    nwwsDebug(`Live traffic idle ${ageSec}s; live=${counts.nwws} bootstrap=${counts.bootstrap} rawMsg=${nwwsMessageCount} room=${roomOk}`);
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
  const vtec = normalizeValueArray(rawParams.VTEC ?? rawParams.vtec ?? rawProps?.pvtec ?? rawProps?.details?.pvtec);
  const ugc = normalizeValueArray(rawParams.UGC ?? rawParams.ugc);
  const geocodeUgc = Array.isArray(rawProps?.geocode?.UGC) ? rawProps.geocode.UGC.map(String) : [];
  return {
    ...rawParams,
    VTEC: vtec,
    UGC: ugc.length ? ugc : geocodeUgc,
    // Expose snake_case NWWS library keys under the camelCase NWS API keys that radar.js expects
    ...(rawParams.damage_threat != null ? {
      thunderstormDamageThreat: rawParams.damage_threat,
      tornadoDamageThreat: rawParams.damage_threat,
    } : {}),
    ...(rawParams.tornado_detection != null ? { tornadoDetection: rawParams.tornado_detection } : {}),
    ...(rawParams.max_hail_size != null ? { maxHailSize: rawParams.max_hail_size } : {}),
    ...(rawParams.max_wind_gust != null ? { maxWindGust: rawParams.max_wind_gust } : {}),
    ...(rawParams.flood_detection != null ? { flashFloodDamageThreat: rawParams.flood_detection } : {}),
  };
}

function rawFeatureIdForParsedEvent(event) {
  const rawProps = event?.properties && typeof event.properties === 'object' ? event.properties : {};
  return String(
    event?.id
    || rawProps.id
    || event?.tracking
    || rawProps.tracking
    || rawProps.details?.tracking
    || rawProps.hash
    || ''
  ).trim();
}

function eventTimeMs(event) {
  const props = event?.properties || {};
  const history = Array.isArray(event?.history)
    ? event.history
    : (Array.isArray(props.history) ? props.history : []);
  const raw =
    props.sent
    || props.issued
    || props.effective
    || props.onset
    || history[0]?.issued
    || history[0]?.sent
    || '';
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function isOldNwwsReplay(event) {
  const ms = eventTimeMs(event);
  if (!ms) return false;
  return ms < (BRIDGE_STARTED_MS - NWWS_REPLAY_GRACE_MS);
}

function vtecTextFromEvent(event) {
  const props = event?.properties || {};
  const raw =
    props.vtec ||
    props.VTEC ||
    props.pvtec ||
    props.rawVtec ||
    props.parameters?.VTEC ||
    props.parameters?.vtec ||
    props.details?.pvtec ||
    props.details?.vtec ||
    '';
  return Array.isArray(raw) ? String(raw[0] || '') : String(raw || '');
}

function getVtecAction(event) {
  const text = vtecTextFromEvent(event).toUpperCase();
  const match = text.toUpperCase().match(/\/?[OTEX]\.([A-Z]{3})\./);
  return match ? match[1] : '';
}

function warningChangeKindFromVtec(action) {
  const code = String(action || '').toUpperCase();
  if (!code) return '';

  if (code === 'NEW') return 'new';
  if (code === 'UPG') return 'upgraded';
  if (code === 'CAN' || code === 'EXP') return 'cancelled';
  if (code === 'CON' || code === 'EXT' || code === 'EXA' || code === 'EXB') return 'continued';
  if (code === 'COR') return 'updated';

  return 'updated';
}

function getStableWarningId(event) {
  const text = vtecTextFromEvent(event).toUpperCase();
  const match = text.match(/\/?[OTEX]\.[A-Z]{3}\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})/);
  if (match) {
    const [, office, phen, sig, etn] = match;
    return `${office}-${phen}-${sig}-${etn}`;
  }

  const raw = rawFeatureIdForParsedEvent(event);
  if (raw) return String(raw).trim().toUpperCase();
  return '';
}

function featureIdForParsedEvent(event) {
  return getStableWarningId(event);
}

function vtecActionFromProps(props = {}) {
  const first = vtecTextFromProps(props);
  const text = String(first || '').toUpperCase();
  const match = text.match(/\/?[A-Z]\.([A-Z]{3})\./);
  return match ? match[1] : '';
}

function parsedEventActionText(event) {
  const props = event?.properties && typeof event.properties === 'object' ? event.properties : {};
  const history = Array.isArray(event?.history)
    ? event.history
    : (Array.isArray(props.history) ? props.history : []);

  return [
    props.messageType,
    props.action,
    props.is_cancelled ? 'cancelled' : '',
    history[0]?.type,
    getVtecAction(event),
  ]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function isCancelledParsedEvent(event) {
  const kind = warningChangeKindFromVtec(getVtecAction(event));
  if (kind) return kind === 'cancelled';
  const text = parsedEventActionText(event);
  return (
    text.includes('cancel')
    || text.includes('cancelled')
    || text.includes('expire')
    || /\bcan\b/.test(text)
    || /\bexp\b/.test(text)
  );
}

function featureFromParsedEvent(event, fallbackGeometry = null) {
  if (!event || event.type !== 'Feature') return null;
  let geometry = normalizeGeometry(event.geometry);
  if (!geometry && fallbackGeometry) geometry = normalizeGeometry(fallbackGeometry);
  if (!geometry) return null;
  const rawProps = event.properties && typeof event.properties === 'object' ? { ...event.properties } : {};
  const history = Array.isArray(event.history)
    ? event.history
    : (Array.isArray(rawProps.history) ? rawProps.history : []);
  const id = featureIdForParsedEvent(event);
  const rawTracking = rawFeatureIdForParsedEvent(event);
  if (!id) return null;
  const issuedRaw = rawProps.issued || rawProps.sent || history[0]?.issued || null;
  const expiresRaw = rawProps.expires || null;
  const parameters = normalizeParameters(rawProps);
  const eventText = String(rawProps.event || rawProps.parent || 'Unknown Warning');
  const vtecAction = getVtecAction(event);
  const changeKind = warningChangeKindFromVtec(vtecAction);
  return {
    type: 'Feature',
    id,
    geometry,
    properties: {
      ...rawProps,
      id,
      tracking: rawTracking || id,
      _stableId: id,
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
      _nwwsAction: vtecAction,
      _changeKind: changeKind,
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

function vtecTextFromProps(props = {}) {
  return normalizeValueArray(
    props?.parameters?.VTEC
    ?? props?.parameters?.vtec
    ?? props?.pvtec
    ?? props?.details?.pvtec
  )[0] || '';
}

function vtecSignatureFromText(vtecText = '') {
  const vtec = String(vtecText || '');
  if (!vtec) return '';
  const parts = vtec.replace(/^\//, '').split('.');
  // VTEC: O.NEW.KTLX.TO.W.0001.dates — stable key ignores action (index 1) and time range (index 6+)
  if (parts.length < 6) return parts.slice(0, 5).join('.');
  return [parts[0], parts[2], parts[3], parts[4], parts[5]].join('.');
}

function vtecSignatureFromProps(props = {}) {
  return vtecSignatureFromText(vtecTextFromProps(props));
}

function vtecSignatureFromFeature(feature) {
  return vtecSignatureFromProps(feature?.properties || {});
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
      nwwsDebug(`Replaced bootstrap alert with live NWWS alert ${liveKey}`);
    }
  }
  return removed;
}

// Remove stale NWWS entries for the same warning when an upgraded version arrives.
// Upgrades (e.g. TOR→TORE) share the same VTEC stable key but get a new tracking hash.
function replaceNwwsDuplicates(feature, liveKey) {
  const liveSig = vtecSignatureFromFeature(feature);
  if (!liveSig) return 0;
  let removed = 0;
  for (const [entryKey, entry] of activeAlerts.entries()) {
    if (entryKey === liveKey || entry?._source === 'nws-api') continue;
    const entryFeature = getFeatureForEntry(entry);
    const entrySig = vtecSignatureFromFeature(entryFeature);
    if (!entrySig) continue;
    if (entrySig === liveSig) {
      activeAlerts.delete(entryKey);
      removed += 1;
      nwwsDebug(`Replaced stale NWWS entry with upgraded entry ${liveKey}`);
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

function logDroppedGeometryOnce(event) {
  const skipped = summarizeSkippedEvent(event);
  const key = `${skipped.event}|${skipped.sender}|${skipped.tracking}`;
  if (droppedGeometryLogKeys.has(key)) return;
  droppedGeometryLogKeys.add(key);
  nwwsDebug(`Dropped no-geometry event: ${skipped.event} ${skipped.tracking || ''} ugcZones=${skipped.ugcCount}`);
}

function removeAlertByIdentity(event) {
  const keys = new Set();
  const id = featureIdForParsedEvent(event);
  if (id) keys.add(id);
  const rawProps = event?.properties && typeof event.properties === 'object' ? event.properties : {};
  const feature = featureFromParsedEvent(event);
  const sig = feature ? vtecSignatureFromFeature(feature) : vtecSignatureFromProps(rawProps);
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
  let removed = 0;
  for (const [key, entry] of activeAlerts.entries()) {
    const feature = getFeatureForEntry(entry);
    if (isSuppressedFloodFeature(feature)) {
      activeAlerts.delete(key);
      removed += 1;
      continue;
    }
    const expires = getExpiresMs(entry);
    if (expires && Number.isFinite(expires) && expires <= now) {
      activeAlerts.delete(key);
      removed += 1;
    }
  }
  return removed;
}

function buildPublishedFeatures() {
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

  return features;
}

function buildAlertSignature(features) {
  return features
    .map(feature => {
      const props = feature?.properties || {};
      return [
        String(feature?.id || ''),
        String(props._source || ''),
        String(props.action || props.messageType || ''),
        String(props.expires || ''),
      ].join('|');
    })
    .join('\n');
}

function publishStatusOnly(featuresCount = activeAlerts.size) {
  const counts = sourceCounts();
  if (lastStatus.phase !== 'starting') {
    updateStatus({
      phase: lastStatus.phase,
      message: !hasSeenNwwsTraffic
        ? `Connected to NWWS, awaiting live traffic (${counts.bootstrap} bootstrapped warning polygon${counts.bootstrap === 1 ? '' : 's'})`
        : featuresCount
          ? `${featuresCount} active warning polygon${featuresCount === 1 ? '' : 's'}`
          : 'Connected, no active warning polygons',
      alertCount: featuresCount,
    });
  }
  maybeEmitTrafficDiagnostic();
}

function maybeLogActiveCount(featuresCount = activeAlerts.size) {
  if (!Number.isFinite(featuresCount)) return;
  if (featuresCount === lastLoggedActiveCount) return;
  lastLoggedActiveCount = featuresCount;
  nwwsLog(`${featuresCount} active warning polygon${featuresCount === 1 ? '' : 's'}`);
}

function publishAlerts(force = false) {
  pruneExpiredAlerts();
  const features = buildPublishedFeatures();
  const signature = buildAlertSignature(features);
  if (!force && signature === lastPublishedAlertSignature) {
    publishStatusOnly(features.length);
    return;
  }

  lastPublishedAlertSignature = signature;
  emit('alerts', {
    type: 'FeatureCollection',
    features,
    generatedAt: new Date().toISOString(),
  });
  publishStatusOnly(features.length);
  maybeLogActiveCount(features.length);
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
    nwwsDebug('Fetching NWS API bootstrap alerts...');
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
    nwwsLog(`Bootstrapped ${added} active warning polygon${added === 1 ? '' : 's'} from NWS API`);
    updateStatus({
      phase: lastStatus.phase,
      message: `Bootstrapped ${added} warning(s) from NWS API, awaiting NWWS XMPP`,
    });
    publishAlerts();
  } catch (error) {
    nwsApiBootstrapDone = true;
    nwwsWarn(`NWS API bootstrap failed: ${error?.message || String(error)} - continuing with NWWS only`);
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
        enabled: true,
        interval: 900,
      },
      credentials: {
        username: NWWS_USERNAME,
        password: NWWS_PASSWORD,
        nickname: makeNwwsNickname(NWWS_USERNAME),
      },
      cache: {
        enabled: false,
        max_db_history: 0,
        max_db_cache_size: 0,
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
      shapefile_coordinates: false,
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
    if (isFatalNwwsError(text)) {
      nwwsWarn(text);
      scheduleFatalShutdown(text);
      return;
    }
    nwwsDebug(text);
  });

  instance.on('onConnection', nickname => {
    nwwsLog(`Connected${nickname ? ` as ${nickname}` : ''}`);
    updateStatus({ phase: 'connected', message: 'Connected to NWWS, awaiting traffic' });
    publishAlerts();
  });

  instance.on('onReconnection', data => {
    if (fatalShutdownScheduled) return;
    nwwsWarn(`Reconnecting to live feed... attempt ${data?.reconnects ?? '?'}`);
    nwwsDebug(`Reconnect detail: lastStanza=${data?.lastStanza ?? '?'} ms`);
    updateStatus({ phase: 'reconnecting', message: 'Reconnecting to NWWS' });
  });

  instance.on('onOccupant', data => {
    const wasFirst = nwwsOccupantEventCount === 0;
    nwwsOccupantEventCount += 1;
    if (wasFirst) {
      nwwsLog('Live feed ready');
      nwwsDebug(`Room join confirmed: occupant=${data?.occupant ?? 'unknown'} type=${data?.type ?? 'available'}`);
    }
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
    if (isOldNwwsReplay(event)) {
      nwwsDebug('Ignored old cached expired/cancel product');
      return;
    }
    const removed = removeAlertByIdentity(event);
    if (removed > 0) {
      nwwsDebug(`Expired/cancelled alert removed (${removed} entr${removed === 1 ? 'y' : 'ies'})`);
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
      cancelled: 0,
      removedBootstrap: 0,
      skippedCached: 0,
      skippedNonWarning: 0,
      skippedFlood: 0,
      skippedGeometry: 0,
    };
    for (const event of list) {
      if (isOldNwwsReplay(event)) {
        summary.skippedCached += 1;
        continue;
      }
      const key = featureIdForParsedEvent(event);
      const vtecAction = getVtecAction(event);
      const changeKind = warningChangeKindFromVtec(vtecAction);
      if (changeKind === 'cancelled' || isCancelledParsedEvent(event)) {
        const removed = removeAlertByIdentity(event);
        if (removed > 0) summary.cancelled += removed;
        continue;
      }
      const existingEntry = key ? activeAlerts.get(key) : null;
      const fallbackGeometry = existingEntry?._prebuiltFeature?.geometry ?? null;
      const feature = featureFromParsedEvent(event, fallbackGeometry);
      if (!feature) {
        summary.skippedGeometry += 1;
        logDroppedGeometryOnce(event);
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
      else {
        summary.added += 1;
        const eventTitle = String(feature?.properties?.event || feature?.properties?.eventRaw || 'Warning').trim() || 'Warning';
        if (changeKind === 'continued') {
          nwwsLog(`${eventTitle} has been continued.`);
        } else if (changeKind === 'updated') {
          nwwsDebug(`${eventTitle} has been updated.`);
        } else if (/warning/i.test(eventTitle)) {
          nwwsLog(`A new ${eventTitle} has been issued.`);
        } else {
          nwwsDebug(`A new ${eventTitle} has been issued.`);
        }
      }
      summary.removedBootstrap += replaceBootstrapDuplicates(feature, feature.id);
      summary.removedBootstrap += replaceNwwsDuplicates(feature, feature.id);
    }
    const counts = sourceCounts();
    if (
      summary.added > 0
      || summary.updated > 0
      || summary.cancelled > 0
      || summary.removedBootstrap > 0
      || summary.skippedCached > 0
      || summary.skippedFlood > 0
    ) {
      nwwsDebug(`Batch #${nwwsAlertBatchCount}: received=${summary.received} added=${summary.added} updated=${summary.updated} cancelled=${summary.cancelled} removedBootstrap=${summary.removedBootstrap} skippedCached=${summary.skippedCached} skippedGeometry=${summary.skippedGeometry} live=${counts.nwws} bootstrap=${counts.bootstrap}`);
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

nwwsLog('Starting...');
updateStatus({ phase: 'starting', message: 'Starting NWWS' });
nwwsDebug(`Bridge data dir: ${APP_DIR}`);
nwwsDebug(`Bridge cache dir: ${CACHE_DIR}`);
nwwsDebug(`Bridge database path: ${DB_PATH}`);

if (!NWWS_USERNAME || !NWWS_PASSWORD) {
  emitLog('error', 'NWWS credentials were not provided');
  updateStatus({ phase: 'error', message: 'NWWS login required' });
  process.exit(1);
}

async function startBridge() {
  await bootstrapFromNwsApi();

  nwwsLog('Connecting live feed...');
  nwwsDebug('Constructing NWWS parser client');
  parser = createParser();
  nwwsDebug('NWWS parser client constructed (@atmosx/event-product-parser)');

  attachParserHandlers(parser);

  updateStatus({
    phase: 'starting',
    message: 'NWS API bootstrap complete; NWWS parser initialized, waiting for XMPP connection',
  });
}

void startBridge();

setInterval(() => {
  const removed = pruneExpiredAlerts();
  if (removed > 0) {
    publishAlerts(true);
  } else {
    publishStatusOnly();
  }
}, 1000);
