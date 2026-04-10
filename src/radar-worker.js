'use strict';
// radar-worker.js
// Builds WebGL vertex buffers for WISE radar data entirely off the main thread.
// Receives: { id, container, payloadData, palette }
// Returns:  { id, frame } with _bufXy/_bufColor/_bufVals transferred (zero-copy)

const EARTH_RADIUS_M      = 6_371_000.0;
const MAX_MERCATOR_LAT    = 85.05112878;
const WISE_MAX_RENDER_GATES      = 750_000;
const WISE_MULTI_TYPE_RANGE_SPAN = 120.0; // RANGE_MAX(90) - RANGE_MIN(-30)
const WISE_PRT_SECTION_ORDER     = ['RAIN', 'SNOW', 'SLEET', 'FRZR'];
const WISE_GEOMETRY_CACHE_MAX    = 6;
const _wiseGeometryCache         = new Map();

// ---------------------------------------------------------------------------
// Mercator projection
// ---------------------------------------------------------------------------
function _toMercatorPoint(latDeg, lonDeg) {
  const latClip = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, latDeg));
  const latRad  = latClip * Math.PI / 180.0;
  return {
    x: (lonDeg + 180.0) / 360.0,
    y: (1.0 - (Math.log(Math.tan((Math.PI * 0.25) + (latRad * 0.5))) / Math.PI)) * 0.5,
  };
}

// ---------------------------------------------------------------------------
// Gate-edge geometry (cached per station+product combo)
// ---------------------------------------------------------------------------
function _getWiseGeometry(container) {
  const azimuthCount    = Math.max(1, Number(container.azimuthCount)    || 0);
  const gateCount       = Math.max(1, Number(container.gateCount)       || 0);
  const gateSpacingM    = Math.max(1, Number(container.gateSpacingM)    || 250);
  const firstCenterM    = Math.max(0, Number(container.firstGateCenterM) || (gateSpacingM * 0.5));
  const stationLat      = Number(container.stationLat);
  const stationLon      = Number(container.stationLon);

  const cacheKey = [
    Number(stationLat).toFixed(4), Number(stationLon).toFixed(4),
    azimuthCount, gateCount,
    Number(gateSpacingM).toFixed(2), Number(firstCenterM).toFixed(2),
  ].join('|');

  const cached = _wiseGeometryCache.get(cacheKey);
  if (cached) {
    // LRU promotion
    _wiseGeometryCache.delete(cacheKey);
    _wiseGeometryCache.set(cacheKey, cached);
    return cached;
  }

  const lat1Rad  = stationLat * Math.PI / 180.0;
  const lon1Rad  = stationLon * Math.PI / 180.0;
  const sinLat1  = Math.sin(lat1Rad);
  const cosLat1  = Math.cos(lat1Rad);
  const firstEdgeM     = Math.max(0, firstCenterM - (gateSpacingM * 0.5));
  const rangeEdgeCount = gateCount + 1;

  const sinD = new Float64Array(rangeEdgeCount);
  const cosD = new Float64Array(rangeEdgeCount);
  for (let r = 0; r < rangeEdgeCount; r += 1) {
    const d = (firstEdgeM + (r * gateSpacingM)) / EARTH_RADIUS_M;
    sinD[r] = Math.sin(d);
    cosD[r] = Math.cos(d);
  }

  const edgeAzCount    = azimuthCount + 1;
  const azimuthStepDeg = 360.0 / azimuthCount;
  const halfStepDeg    = azimuthStepDeg * 0.5;
  const edgeXs = new Float32Array(edgeAzCount * rangeEdgeCount);
  const edgeYs = new Float32Array(edgeAzCount * rangeEdgeCount);
  for (let a = 0; a < edgeAzCount; a += 1) {
    const bearingRad  = ((a * azimuthStepDeg) - halfStepDeg) * Math.PI / 180.0;
    const sinBearing  = Math.sin(bearingRad);
    const cosBearing  = Math.cos(bearingRad);
    const rowBase     = a * rangeEdgeCount;
    for (let r = 0; r < rangeEdgeCount; r += 1) {
      const lat2 = Math.asin((sinLat1 * cosD[r]) + (cosLat1 * sinD[r] * cosBearing));
      const lon2 = lon1Rad + Math.atan2(
        sinBearing * sinD[r] * cosLat1,
        cosD[r] - (sinLat1 * Math.sin(lat2)),
      );
      const lonDeg = (((lon2 * 180.0 / Math.PI) + 180.0) % 360.0) - 180.0;
      const merc   = _toMercatorPoint(lat2 * 180.0 / Math.PI, lonDeg);
      edgeXs[rowBase + r] = merc.x;
      edgeYs[rowBase + r] = merc.y;
    }
  }

  const geometry = { rangeEdgeCount, edgeXs, edgeYs };
  _wiseGeometryCache.set(cacheKey, geometry);
  while (_wiseGeometryCache.size > WISE_GEOMETRY_CACHE_MAX) {
    const oldest = _wiseGeometryCache.keys().next().value;
    if (oldest == null) break;
    _wiseGeometryCache.delete(oldest);
  }
  return geometry;
}

// ---------------------------------------------------------------------------
// RLE decode
// ---------------------------------------------------------------------------
function decodeWiseRadar(meta, data) {
  const precision     = Math.max(1, Number(meta.precision) || 0);
  const threshold     = (1 << (precision - 1)) - 1;
  const azimuthCount  = Math.max(1, Number(meta.azimuthCount) || 0);
  const gateCount     = Math.max(1, Number(meta.gateCount) || 0);
  const total         = azimuthCount * gateCount;
  const out           = new Uint16Array(total);
  if (!total || !data?.length) return { grid: out, azimuthCount, gateCount };
  let startIdx = gateCount * Math.round((azimuthCount / 360) * (Number(meta.azimuthStart) || 0));
  startIdx = ((startIdx % total) + total) % total;
  let h = startIdx, i = 0;
  while (i < data.length && h < total) {
    const code = data[i++];
    if (code > threshold) { h += code - threshold; continue; }
    if (code > 0) out[h] = code;
    h += 1;
  }
  h %= total;
  while (i < data.length) {
    const code = data[i++];
    if (code > threshold) { h += code - threshold; continue; }
    if (code > 0) out[h] = code;
    h += 1;
    if (h >= total) h %= total;
  }
  return { grid: out, azimuthCount, gateCount };
}

function decodeWiseRadarMultitype(meta, data) {
  const precision     = Math.max(1, Number(meta.precision) || 0);
  const threshold     = (1 << (precision - 1)) - 1;
  const typeCount     = Math.max(0, Number(meta.multiTypeCount) || 0);
  const azimuthCount  = Math.max(1, Number(meta.azimuthCount) || 0);
  const gateCount     = Math.max(1, Number(meta.gateCount) || 0);
  const total         = azimuthCount * gateCount;
  const out           = new Uint16Array(total);
  const typeGrid      = new Uint8Array(total);
  if (!total || !data?.length) return { grid: out, typeGrid, azimuthCount, gateCount };
  let startIdx = gateCount * Math.round((azimuthCount / 360) * (Number(meta.azimuthStart) || 0));
  startIdx = ((startIdx % total) + total) % total;
  let currentType = 1, h = startIdx, i = 0;
  while (i < data.length && h < total) {
    const code = data[i++];
    if (code > threshold + typeCount) { h += code - threshold - typeCount; continue; }
    if (code > threshold) { currentType = Math.max(1, code - threshold); continue; }
    if (code > 0) { out[h] = (code << 1) - 1; typeGrid[h] = currentType; }
    h += 1;
  }
  h %= total;
  while (i < data.length) {
    const code = data[i++];
    if (code > threshold + typeCount) { h += code - threshold - typeCount; continue; }
    if (code > threshold) { currentType = Math.max(1, code - threshold); continue; }
    if (code > 0) { out[h] = (code << 1) - 1; typeGrid[h] = currentType; }
    h += 1;
    if (h >= total) h %= total;
  }
  return { grid: out, typeGrid, azimuthCount, gateCount };
}

// ---------------------------------------------------------------------------
// Palette color lookup (matches _writePreparedPaletteColor in radar.js)
// ---------------------------------------------------------------------------
function _writePreparedPaletteColor(palette, rawValue, target, offset) {
  if (!palette || !target) {
    target[offset] = target[offset+1] = target[offset+2] = target[offset+3] = 255;
    return;
  }
  const scaled = Number(rawValue) * palette.scale;
  const xp = palette.xp, fp = palette.fp;
  let idx = 0;
  const last = xp.length - 1;
  if (scaled <= xp[0]) {
    idx = 0;
  } else if (scaled >= xp[last]) {
    idx = last;
  } else {
    while (idx < last - 1 && scaled > xp[idx + 1]) idx += 1;
    const x0 = xp[idx], x1 = xp[idx + 1];
    const t    = Math.max(0, Math.min(1, (scaled - x0) / Math.max(x1 - x0, 1e-10)));
    const base = idx * 4, next = (idx + 1) * 4;
    target[offset + 0] = Math.round(fp[base+0] + t * (fp[next+0] - fp[base+0]));
    target[offset + 1] = Math.round(fp[base+1] + t * (fp[next+1] - fp[base+1]));
    target[offset + 2] = Math.round(fp[base+2] + t * (fp[next+2] - fp[base+2]));
    target[offset + 3] = Math.round(fp[base+3] + t * (fp[next+3] - fp[base+3]));
    return;
  }
  const base = idx * 4;
  target[offset+0] = fp[base+0]; target[offset+1] = fp[base+1];
  target[offset+2] = fp[base+2]; target[offset+3] = fp[base+3];
}

// ---------------------------------------------------------------------------
// Main build (sync — runs in worker, so blocking is fine)
// ---------------------------------------------------------------------------
function buildWiseFrameSync(container, payloadData, palette) {
  const isPrtMultiType = String(container.family || '').trim().toUpperCase() === 'PRT'
    && Number(container.multiTypeCount) > 0;
  const decoded = isPrtMultiType
    ? decodeWiseRadarMultitype(container, payloadData)
    : decodeWiseRadar(container, payloadData);
  const { grid, typeGrid = null, azimuthCount, gateCount } = decoded;
  const total           = azimuthCount * gateCount;
  const precision       = Math.max(1, Number(container.precision) || 0);
  const threshold       = (1 << (precision - 1)) - 1;
  const valueDenom      = isPrtMultiType
    ? Math.max(1, (1 << precision) - 2)
    : Math.max(1, threshold - 1);
  const minValue        = Number.isFinite(Number(container.minValue)) ? Number(container.minValue) : 0.0;
  const maxValue        = Number.isFinite(Number(container.maxValue)) ? Number(container.maxValue) : 1.0;

  let validGateCount = 0;
  for (let i = 0; i < total; i += 1) {
    if (grid[i] > 0) validGateCount += 1;
  }

  const emptyResult = {
    vertex_count: 0, gate_count: 0, source_gate_count: 0,
    elevation:    Number(container.elevation)   || 0,
    station_lat:  Number(container.stationLat)  || 0,
    station_lon:  Number(container.stationLon)  || 0,
    scan_time:    container.scanTime,
    product_code: container.productCode || '--',
    decimated:    false,
    field:        container.field,
    _bufXy:    new Float32Array(0),
    _bufColor: new Uint8Array(0),
    _bufVals:  new Float32Array(0),
    _bufTypes: new Uint8Array(0),
  };
  if (!validGateCount) return emptyResult;

  const stride          = validGateCount > WISE_MAX_RENDER_GATES
    ? Math.max(1, Math.ceil(validGateCount / WISE_MAX_RENDER_GATES))
    : 1;
  const vertexCapacity  = Math.ceil(validGateCount / stride) * 6;
  const xy     = new Float32Array(vertexCapacity * 2);
  const rgba   = new Uint8Array(vertexCapacity * 4);
  const vals   = new Float32Array(vertexCapacity);
  const types  = isPrtMultiType ? new Uint8Array(vertexCapacity) : null;
  const colorTmp = new Uint8Array(4);

  const geometry       = _getWiseGeometry(container);
  const rangeEdgeCount = geometry.rangeEdgeCount;
  const edgeXs         = geometry.edgeXs;
  const edgeYs         = geometry.edgeYs;

  let seenValid = 0, outGateCount = 0, vertexIndex = 0;
  for (let ray = 0; ray < azimuthCount; ray += 1) {
    const rowBase   = ray * gateCount;
    const edgeBase0 = ray * rangeEdgeCount;
    const edgeBase1 = (ray + 1) * rangeEdgeCount;
    for (let gate = 0; gate < gateCount; gate += 1) {
      const code = grid[rowBase + gate];
      if (code <= 0) continue;
      if ((seenValid % stride) !== 0) { seenValid += 1; continue; }
      seenValid += 1;

      const value = minValue + (((code - 1.0) / valueDenom) * (maxValue - minValue));
      let colorValue = value, typeCode = 0;
      if (isPrtMultiType) {
        const typeMask    = typeGrid?.[rowBase + gate] || 1;
        const secIdx      = Math.max(0, Math.min(WISE_PRT_SECTION_ORDER.length - 1, Number(typeMask) - 1));
        typeCode          = secIdx + 1;
        colorValue        = value + (secIdx * WISE_MULTI_TYPE_RANGE_SPAN);
      }
      _writePreparedPaletteColor(palette, colorValue, colorTmp, 0);

      const p00 = edgeBase0 + gate,     p10 = edgeBase0 + gate + 1;
      const p11 = edgeBase1 + gate + 1, p01 = edgeBase1 + gate;
      const x00 = edgeXs[p00], y00 = edgeYs[p00];
      const x10 = edgeXs[p10], y10 = edgeYs[p10];
      const x11 = edgeXs[p11], y11 = edgeYs[p11];
      const x01 = edgeXs[p01], y01 = edgeYs[p01];

      const posBase = vertexIndex * 2;
      xy[posBase+0]=x00; xy[posBase+1]=y00;
      xy[posBase+2]=x10; xy[posBase+3]=y10;
      xy[posBase+4]=x11; xy[posBase+5]=y11;
      xy[posBase+6]=x00; xy[posBase+7]=y00;
      xy[posBase+8]=x11; xy[posBase+9]=y11;
      xy[posBase+10]=x01; xy[posBase+11]=y01;

      vals[vertexIndex]=vals[vertexIndex+1]=vals[vertexIndex+2]=
      vals[vertexIndex+3]=vals[vertexIndex+4]=vals[vertexIndex+5]=value;

      if (types) {
        types[vertexIndex]=types[vertexIndex+1]=types[vertexIndex+2]=
        types[vertexIndex+3]=types[vertexIndex+4]=types[vertexIndex+5]=typeCode;
      }

      const colorBase = vertexIndex * 4;
      for (let i = 0; i < 6; i += 1) {
        const off = colorBase + (i * 4);
        rgba[off]=colorTmp[0]; rgba[off+1]=colorTmp[1];
        rgba[off+2]=colorTmp[2]; rgba[off+3]=colorTmp[3];
      }
      vertexIndex += 6;
      outGateCount += 1;
    }
  }

  const n = vertexIndex;
  return {
    vertex_count: n,
    gate_count:   outGateCount,
    source_gate_count: validGateCount,
    elevation:    Number(container.elevation)   || 0,
    station_lat:  Number(container.stationLat)  || 0,
    station_lon:  Number(container.stationLon)  || 0,
    scan_time:    container.scanTime,
    product_code: container.productCode || '--',
    decimated:    stride > 1,
    field:        container.field,
    _bufXy:    n === vertexCapacity ? xy    : xy.slice(0, n * 2),
    _bufColor: n === vertexCapacity ? rgba  : rgba.slice(0, n * 4),
    _bufVals:  n === vertexCapacity ? vals  : vals.slice(0, n),
    _bufTypes: !types ? null : (n === vertexCapacity ? types : types.slice(0, n)),
  };
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
self.onmessage = function (ev) {
  const { id, container, payloadData, palette } = ev.data;
  try {
    const frame = buildWiseFrameSync(container, payloadData, palette);
    const transferables = [frame._bufXy.buffer, frame._bufColor.buffer, frame._bufVals.buffer];
    if (frame._bufTypes) transferables.push(frame._bufTypes.buffer);
    self.postMessage({ id, frame }, transferables);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
