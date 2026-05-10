import {
  WISE_MAGIC, WISE_FIXED_HEADER_SIZE, MAX_MERCATOR_LAT, LOCAL_L2_PRODUCTS, PROCESSED_WISE_FAMILY_SET,
} from '../core/config.js';
import {
  canonicalStationId, STATIONS, HAWAII_STATIONS, TERMINAL_STATIONS,
} from './stations.js';
import { parseKeyTimestampMs } from '../core/utils.js';

function _processedWiseProductCodeForFamily(family) {
  const f = String(family || '').trim().toUpperCase();
  return PROCESSED_WISE_FAMILY_SET.has(f) ? f : null;
}

// ﻿// NEXRAD Level III Radar Viewer
export // with typed array views (zero-copy — all arrays point into the original ArrayBuffer).
function parseRadarBinaryBlob(buffer) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));

  // ── WDAR format (Python WISE decode) ──────────────────────────────────────
  if (magic === 'WDAR') {
    let o = 4;
    const vertex_count      = dv.getUint32(o, true); o += 4;
    const gate_count        = dv.getUint32(o, true); o += 4;
    const source_gate_count = dv.getUint32(o, true); o += 4;
    const elevation         = dv.getFloat32(o, true); o += 4;
    const station_lat       = dv.getFloat32(o, true); o += 4;
    const station_lon       = dv.getFloat32(o, true); o += 4;
    const scan_time_ms      = dv.getFloat64(o, true); o += 8;
    o += 4;                                                    // unused slot
    const decimated         = dv.getUint8(o) !== 0;  o += 1;
    const has_types         = dv.getUint8(o) !== 0;  o += 1;
    o += 4;                                                    // padding (h + H)
    // field_name: 16 bytes null-padded at offset 46
    const fieldRaw = new Uint8Array(buffer, 46, 16);
    const nullIdx  = fieldRaw.indexOf(0);
    const field    = new TextDecoder().decode(fieldRaw.slice(0, nullIdx < 0 ? 16 : nullIdx));
    o = 64;

    let _bufXy = null, _bufColor = null, _bufVals = null, _bufTypes = null;
    if (vertex_count > 0) {
      _bufXy    = new Float32Array(buffer, o, vertex_count * 2); o += vertex_count * 2 * 4;
      _bufColor = new Uint8Array(buffer, o, vertex_count * 4);   o += vertex_count * 4;
      _bufVals  = new Float32Array(buffer, o, vertex_count);     o += vertex_count * 4;
      if (has_types) {
        _bufTypes = new Uint8Array(buffer, o, vertex_count);
      }
    }
    const scan_time = scan_time_ms > 0 ? new Date(scan_time_ms).toISOString() : null;
    return {
      vertex_count, gate_count, source_gate_count,
      elevation, station_lat, station_lon, scan_time,
      product_code: 0, decimated, field,
      l2_product_mask: 0, l2_available_products: [],
      l2_tilt_idx: undefined, l2_tilts: undefined,
      _bufXy, _bufColor, _bufVals, _bufTypes,
    };
  }

  // ── RDAR format (L3 / L2 Python backend) ──────────────────────────────────
  if (magic !== 'RDAR') throw new Error(`Bad binary magic from backend: ${magic}`);

  let o = 4;
  const vertex_count      = dv.getUint32(o, true); o += 4;
  const gate_count        = dv.getUint32(o, true); o += 4;
  const source_gate_count = dv.getUint32(o, true); o += 4;
  const elevation         = dv.getFloat32(o, true); o += 4;
  const station_lat       = dv.getFloat32(o, true); o += 4;
  const station_lon       = dv.getFloat32(o, true); o += 4;
  const scan_time_ms      = dv.getFloat64(o, true); o += 8;
  const product_code      = dv.getUint32(o, true); o += 4;
  const decimated         = dv.getUint8(o) !== 0;  o += 1;
  const field_name_len    = dv.getUint8(o);         o += 1;
  const l2_tilt_idx       = dv.getInt16(o, true);   o += 2;
  const l2_tilts_count    = dv.getUint16(o, true);  o += 2;
  // field_name: 16 bytes null-padded, then 2 bytes L2 product mask (total header = 64)
  const field = new TextDecoder().decode(new Uint8Array(buffer, o, field_name_len));
  o += 16;
  const l2_product_mask = dv.getUint16(o, true); o += 2;

  // Typed array views (zero-copy)
  let _bufXy = null, _bufColor = null, _bufVals = null;
  if (vertex_count > 0) {
    _bufXy    = new Float32Array(buffer, o, vertex_count * 2); o += vertex_count * 2 * 4;
    _bufColor = new Uint8Array(buffer, o, vertex_count * 4);   o += vertex_count * 4;
    _bufVals  = new Float32Array(buffer, o, vertex_count);     o += vertex_count * 4;
  }

  const l2_tilts = [];
  for (let i = 0; i < l2_tilts_count; i++) {
    l2_tilts.push(dv.getFloat32(o, true)); o += 4;
  }

  const scan_time = scan_time_ms > 0 ? new Date(scan_time_ms).toISOString() : null;

  return {
    vertex_count, gate_count, source_gate_count,
    elevation, station_lat, station_lon, scan_time,
    product_code, decimated, field,
    l2_product_mask,
    l2_available_products: _productsFromL2Mask(l2_product_mask),
    l2_tilt_idx: l2_tilt_idx >= 0 ? l2_tilt_idx : undefined,
    l2_tilts:    l2_tilts_count > 0 ? l2_tilts : undefined,
    _bufXy, _bufColor, _bufVals,
  };
}

function _wiseFieldNameForFamily(family) {
  const f = String(family || '').trim().toUpperCase();
  if (f === 'CC') return 'cross_correlation_ratio';
  if (f === 'ZDR') return 'differential_reflectivity';
  if (f === 'ET' || f === 'EET') return 'echo_top';
  if (f === 'SRV') return 'storm_relative_velocity';
  if (f === 'VEL') return 'velocity';
  if (f === 'SW') return 'spectrum_width';
  if (f === 'PRT') return 'precipitation_type';
  if (f === 'DTA') return 'storm_total_precipitation';
  return 'reflectivity';
}

const _wiseHostIsLittleEndian = (() => {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setUint16(0, 0x00ff, true);
  return new Uint16Array(buf)[0] === 0x00ff;
})();

function _wiseStationFallbackCoords(stationId) {
  const sid = canonicalStationId(stationId);
  const station = STATIONS[sid] || HAWAII_STATIONS[sid] || TERMINAL_STATIONS[sid] || [];
  return {
    lat: Number(station[0]) || 0,
    lon: Number(station[1]) || 0,
  };
}

function _parseWiseScanTimeIso(datetimeText, fileName = '') {
  const raw = String(datetimeText || '').trim();
  if (raw) {
    const normalized = raw.replace(' ', 'T');
    const withZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`;
    const dt = new Date(withZone);
    if (Number.isFinite(dt.getTime())) return dt.toISOString();
  }
  const ts = parseKeyTimestampMs(`WISE:X:X:X:${encodeURIComponent(fileName || '')}`);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function _wisePayloadToCodeStream(payloadBytes, precision) {
  if (precision <= 8) {
    return new Uint8Array(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
  }
  if (precision <= 16) {
    const count = Math.floor(payloadBytes.byteLength / 2);
    if (_wiseHostIsLittleEndian && (payloadBytes.byteOffset % 2) === 0) {
      return new Uint16Array(payloadBytes.buffer, payloadBytes.byteOffset, count);
    }
    const out = new Uint16Array(count);
    const dv = new DataView(payloadBytes.buffer, payloadBytes.byteOffset, payloadBytes.byteLength);
    for (let i = 0, o = 0; i < count; i += 1, o += 2) {
      out[i] = dv.getUint16(o, true);
    }
    return out;
  }
  throw new Error(`Unsupported WISE precision: ${precision}`);
}
export 
function parseWiseContainer(bytes, stationId, family, fileName) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < WISE_FIXED_HEADER_SIZE) {
    throw new Error('WISE payload too small');
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(
    dv.getUint8(0),
    dv.getUint8(1),
    dv.getUint8(2),
    dv.getUint8(3),
  );
  if (magic !== WISE_MAGIC) throw new Error(`Bad WISE magic: ${magic}`);

  const jsonLen = dv.getUint32(8, false);
  const payloadLen = dv.getUint32(12, false);
  const precision = dv.getUint8(16);
  const headerMin = dv.getFloat32(18, false);
  const headerMax = dv.getFloat32(22, false);
  const dimX = dv.getUint32(26, false);
  const dimY = dv.getUint32(30, false);
  const dimZ = dv.getUint32(34, false);

  const jsonStart = WISE_FIXED_HEADER_SIZE;
  const jsonEnd = jsonStart + jsonLen;
  if (jsonEnd > bytes.byteLength) throw new Error('WISE JSON block truncated');

  const meta = JSON.parse(new TextDecoder('utf-8').decode(bytes.subarray(jsonStart, jsonEnd)));
  const payloadStart = jsonEnd;
  const payloadEnd = payloadStart + payloadLen;
  if (payloadEnd > bytes.byteLength) throw new Error('WISE payload block truncated');

  const payloadBytes = bytes.subarray(payloadStart, payloadEnd);
  const location = Array.isArray(meta?.location) ? meta.location : [];
  const stationFallback = _wiseStationFallbackCoords(stationId);
  const stationLon = Number.isFinite(Number(location[0])) ? Number(location[0]) : stationFallback.lon;
  const stationLat = Number.isFinite(Number(location[1])) ? Number(location[1]) : stationFallback.lat;
  const minValue = Number.isFinite(headerMin) ? headerMin : Number(meta?.stats?.min);
  const maxValue = Number.isFinite(headerMax) ? headerMax : Number(meta?.stats?.max);

  return {
    stationId: canonicalStationId(stationId),
    family: String(family || '').trim().toUpperCase(),
    productCode: String(meta?.product || _processedWiseProductCodeForFamily(family) || '').toUpperCase(),
    fileName: String(fileName || ''),
    precision: Math.max(1, Number(precision) || 0),
    minValue,
    maxValue,
    dims: [dimX, dimY, dimZ],
    azimuthCount: Math.max(1, Number(dimX) || 0),
    gateCount: Math.max(1, Number(dimY) || 0),
    azimuthStart: Number(meta?.azimuth_start) || 0,
    gateSpacingM: Math.max(1, Number(meta?.meters_between_gates) || 250),
    firstGateCenterM: Math.max(0, Number(meta?.meters_to_center_of_first_gate) || (Number(meta?.meters_between_gates) || 250) * 0.5),
    stationLat,
    stationLon,
    elevation: Number(meta?.elevation) || 0,
    scanTime: _parseWiseScanTimeIso(meta?.datetime, fileName),
    field: _wiseFieldNameForFamily(family),
    multiTypeCount: Math.max(0, Number(meta?.multi_type?.count) || 0),
    payloadData: _wisePayloadToCodeStream(payloadBytes, precision),
  };
}

function decodeWiseRadar(meta, data) {
  const precision = Math.max(1, Number(meta?.precision) || 0);
  const threshold = (1 << (precision - 1)) - 1;
  const azimuthCount = Math.max(1, Number(meta?.azimuthCount) || 0);
  const gateCount = Math.max(1, Number(meta?.gateCount) || 0);
  const total = azimuthCount * gateCount;
  const out = new Uint16Array(total);

  if (!total || !data?.length) {
    return { grid: out, azimuthCount, gateCount };
  }

  let startIdx = gateCount * Math.round((azimuthCount / 360) * (Number(meta?.azimuthStart) || 0));
  startIdx = ((startIdx % total) + total) % total;

  let h = startIdx;
  let i = 0;
  while (i < data.length && h < total) {
    const code = data[i++];
    if (code > threshold) {
      h += code - threshold;
      continue;
    }
    if (code > 0) out[h] = code;
    h += 1;
  }

  h %= total;
  while (i < data.length) {
    const code = data[i++];
    if (code > threshold) {
      h += code - threshold;
      continue;
    }
    if (code > 0) out[h] = code;
    h += 1;
    if (h >= total) h %= total;
  }

  return { grid: out, azimuthCount, gateCount };
}

function decodeWiseRadarMultitype(meta, data) {
  const precision = Math.max(1, Number(meta?.precision) || 0);
  const threshold = (1 << (precision - 1)) - 1;
  const typeCount = Math.max(0, Number(meta?.multiTypeCount) || 0);
  const azimuthCount = Math.max(1, Number(meta?.azimuthCount) || 0);
  const gateCount = Math.max(1, Number(meta?.gateCount) || 0);
  const total = azimuthCount * gateCount;
  const out = new Uint16Array(total);
  const typeGrid = new Uint8Array(total);

  if (!total || !data?.length) {
    return { grid: out, typeGrid, azimuthCount, gateCount };
  }

  let startIdx = gateCount * Math.round((azimuthCount / 360) * (Number(meta?.azimuthStart) || 0));
  startIdx = ((startIdx % total) + total) % total;

  let currentType = 1;
  let h = startIdx;
  let i = 0;
  while (i < data.length && h < total) {
    const code = data[i++];
    if (code > (threshold + typeCount)) {
      h += code - threshold - typeCount;
      continue;
    }
    if (code > threshold) {
      currentType = Math.max(1, code - threshold);
      continue;
    }
    if (code > 0) {
      out[h] = (code << 1) - 1;
      typeGrid[h] = currentType;
    }
    h += 1;
  }

  h %= total;
  while (i < data.length) {
    const code = data[i++];
    if (code > (threshold + typeCount)) {
      h += code - threshold - typeCount;
      continue;
    }
    if (code > threshold) {
      currentType = Math.max(1, code - threshold);
      continue;
    }
    if (code > 0) {
      out[h] = (code << 1) - 1;
      typeGrid[h] = currentType;
    }
    h += 1;
    if (h >= total) h %= total;
  }

  return { grid: out, typeGrid, azimuthCount, gateCount };
}
export 
function _toMercatorPoint(latDeg, lonDeg) {
  const latClip = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, latDeg));
  const latRad = latClip * Math.PI / 180.0;
  return {
    x: (lonDeg + 180.0) / 360.0,
    y: (1.0 - (Math.log(Math.tan((Math.PI * 0.25) + (latRad * 0.5))) / Math.PI)) * 0.5,
  };
}
export 
function _wiseGeometryCacheKey(container) {
  return [
    canonicalStationId(container.stationId),
    Number(container.stationLat).toFixed(4),
    Number(container.stationLon).toFixed(4),
    Number(container.azimuthCount) || 0,
    Number(container.gateCount) || 0,
    Number(container.gateSpacingM || 0).toFixed(2),
    Number(container.firstGateCenterM || 0).toFixed(2),
  ].join('|');
}
export function _productsFromL2Mask(mask) {
  const bits = Number(mask);
  if (!Number.isFinite(bits) || bits <= 0) return [];
  return LOCAL_L2_PRODUCTS.filter((prod, idx) => (bits & (1 << idx)) !== 0);
}
