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
  const scaled = Number(rawValue) * (Number.isFinite(Number(palette.scale)) ? Number(palette.scale) : 1.0);
  const colors = palette.colors;
  if (Array.isArray(colors) && colors.length) {
    const min = Number.isFinite(Number(palette.min)) ? Number(palette.min) : 0;
    const max = Number.isFinite(Number(palette.max)) ? Number(palette.max) : min + colors.length - 1;
    const clamped = Math.max(min, Math.min(max, scaled));
    const lookupStep = Number.isFinite(Number(palette.lookupStep)) && Number(palette.lookupStep) > 0 ? Number(palette.lookupStep) : null;
    const denom = Math.max(max - min, 1e-10);
    const rawIndex = lookupStep
      ? Math.round((clamped - min) / lookupStep)
      : Math.floor(((clamped - min) / denom) * (colors.length - 1));
    const index = Math.max(0, Math.min(colors.length - 1, rawIndex));
    const color = colors[index] || colors[colors.length - 1];
    target[offset+0] = color[0]; target[offset+1] = color[1];
    target[offset+2] = color[2]; target[offset+3] = color[3];
    return;
  }
  const xp = palette.xp, fp = palette.fp;
  if (!xp || !fp || xp.length < 1) {
    target[offset] = target[offset+1] = target[offset+2] = target[offset+3] = 255;
    return;
  }
  let idx = 0;
  const last = xp.length - 1;
  if (palette.mode === 'discrete') {
    while (idx < last && scaled >= xp[idx + 1]) idx += 1;
    const base = idx * 4;
    target[offset+0] = fp[base+0]; target[offset+1] = fp[base+1];
    target[offset+2] = fp[base+2]; target[offset+3] = fp[base+3];
    return;
  }
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
  const smoothStrength = isPrtMultiType
    ? 0
    : Math.max(0, Math.min(1, Number(container.dataSmoothingStrength) || 0));
  const smoothingAvailable = smoothStrength > 0;
  const smoothClamp = Math.max(0, Math.min(0.62, smoothStrength));
  const smoothX = smoothClamp * 0.38;
  const smoothY = smoothClamp * 0.68;
  const cleanupStrength = smoothingAvailable
    ? Math.max(0, Math.min(0.75, Math.pow(smoothClamp, 1.8)))
    : 0;
  const productFamily = String(container.family || '').trim().toUpperCase();
  const lowDbzCleanup = smoothingAvailable && productFamily === 'REF';
  const lowDbzThreshold = 15;
  const lowDbzDropBelow = 5;
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

  const maxRenderGates = Math.max(100_000, Number(container.maxRenderGates) || WISE_MAX_RENDER_GATES);
  const stride          = validGateCount > maxRenderGates
    ? Math.max(1, Math.ceil(validGateCount / maxRenderGates))
    : 1;
  const geometry       = _getWiseGeometry(container);
  const rangeEdgeCount = geometry.rangeEdgeCount;
  const edgeXs         = geometry.edgeXs;
  const edgeYs         = geometry.edgeYs;
  const codeToValue = code => minValue + (((code - 1.0) / valueDenom) * (maxValue - minValue));
  const buildHannKernel = radius => {
    const r = Math.max(0, Math.floor(Number(radius) || 0));
    const kernel = new Float32Array((r * 2) + 1);
    for (let offset = -r; offset <= r; offset += 1) {
      kernel[offset + r] = (Math.cos((offset / (r + 1)) * Math.PI) * 0.5 + 0.5) / (r + 1);
    }
    return { radius: r, kernel };
  };
  const smoothValueField = () => {
    const rawValues = new Float32Array(total);
    const rawWeights = new Float32Array(total);
    for (let i = 0; i < total; i += 1) {
      const raw = grid[i];
      if (raw <= 0) continue;
      rawValues[i] = codeToValue(raw);
      rawWeights[i] = 1;
    }
    if (!smoothingAvailable) {
      return {
        values: rawValues,
        weights: rawWeights,
        radiusX: 0,
        radiusY: 0,
      };
    }

    const { radius: radiusX, kernel: kernelX } = buildHannKernel(7);
    const { radius: radiusY, kernel: kernelY } = buildHannKernel(3);
    const passValues = new Float32Array(total);
    const passWeights = new Float32Array(total);
    const outValues = new Float32Array(total);
    const outWeights = new Float32Array(total);

    for (let ray = 0; ray < azimuthCount; ray += 1) {
      const rowBase = ray * gateCount;
      for (let gate = 0; gate < gateCount; gate += 1) {
        const idx = rowBase + gate;
        let sum = 0;
        let wsum = 0;
        for (let o = -radiusX; o <= radiusX; o += 1) {
          const gg = gate + o;
          if (gg < 0 || gg >= gateCount) continue;
          const src = rowBase + gg;
          const weighted = kernelX[o + radiusX] * rawWeights[src];
          if (weighted <= 0) continue;
          sum += rawValues[src] * weighted;
          wsum += weighted;
        }
        const xValue = wsum > 1e-6 ? (sum / wsum) : rawValues[idx];
        passValues[idx] = rawValues[idx] + ((xValue - rawValues[idx]) * smoothX);
        passWeights[idx] = rawWeights[idx] + ((Math.min(1, wsum) - rawWeights[idx]) * smoothX);
      }
    }

    for (let ray = 0; ray < azimuthCount; ray += 1) {
      const rowBase = ray * gateCount;
      for (let gate = 0; gate < gateCount; gate += 1) {
        const idx = rowBase + gate;
        let sum = 0;
        let wsum = 0;
        let coverage = 0;
        for (let o = -radiusY; o <= radiusY; o += 1) {
          const rr = (ray + o + azimuthCount) % azimuthCount;
          const src = (rr * gateCount) + gate;
          const weighted = kernelY[o + radiusY] * passWeights[src];
          if (weighted <= 0) continue;
          sum += passValues[src] * weighted;
          wsum += weighted;
          coverage += weighted;
        }
        const yValue = wsum > 1e-6 ? (sum / wsum) : passValues[idx];
        outValues[idx] = passValues[idx] + ((yValue - passValues[idx]) * smoothY);
        outWeights[idx] = passWeights[idx] + ((Math.min(1, coverage) - passWeights[idx]) * smoothY);
      }
    }

    return {
      values: outValues,
      weights: outWeights,
      radiusX,
      radiusY,
    };
  };
  const smoothedField = smoothingAvailable ? smoothValueField() : null;
  const renderCoverageThreshold = smoothingAvailable
    ? Math.max(0.055, 0.12 - (smoothY * 0.07))
    : 0.5;
  let renderableGateCount = 0;
  if (smoothingAvailable) {
    for (let i = 0; i < total; i += 1) {
      if (grid[i] > 0) {
        renderableGateCount += 1;
        continue;
      }
      if (
        smoothedField.weights[i] >= renderCoverageThreshold &&
        smoothedField.values[i] > lowDbzDropBelow
      ) {
        renderableGateCount += 1;
      }
    }
  } else {
    renderableGateCount = validGateCount;
  }
  const renderGateCapacity = Math.ceil(renderableGateCount / stride);
  const vertexCapacity  = Math.max(0, renderGateCapacity * 6);
  const xy     = new Float32Array(vertexCapacity * 2);
  const rgba   = new Uint8Array(vertexCapacity * 4);
  const vals   = new Float32Array(vertexCapacity);
  const types  = isPrtMultiType ? new Uint8Array(vertexCapacity) : null;
  const colorTmp = new Uint8Array(4);
  const lowDbzAlphaScale = value => {
    if (!lowDbzCleanup || value >= lowDbzThreshold) return 1;
    if (cleanupStrength <= 0) return 1;
    const t = Math.max(0, Math.min(1, (value - lowDbzDropBelow) / (lowDbzThreshold - lowDbzDropBelow)));
    const cleanedAlpha = value <= lowDbzDropBelow ? 0 : (0.08 + (0.42 * t * t));
    return 1 + ((cleanedAlpha - 1) * cleanupStrength);
  };
  const lowDbzNeighborSupport = (ray, gate) => {
    let valid = 0;
    let strong = 0;
    for (let dr = -1; dr <= 1; dr += 1) {
      const rr = (ray + dr + azimuthCount) % azimuthCount;
      const row = rr * gateCount;
      for (let dg = -1; dg <= 1; dg += 1) {
        if (dr === 0 && dg === 0) continue;
        const gg = gate + dg;
        if (gg < 0 || gg >= gateCount) continue;
        const raw = grid[row + gg];
        if (raw <= 0) continue;
        valid += 1;
        if (codeToValue(raw) >= lowDbzThreshold) strong += 1;
      }
    }
    return { valid, strong };
  };
  const sampleValueField = (rayCoord, gateCoord, fallbackValue) => {
    const ray0Raw = Math.floor(rayCoord);
    const rayFrac = rayCoord - ray0Raw;
    const gate0 = Math.floor(gateCoord);
    const gateFrac = gateCoord - gate0;

    const samples = [
      { ray: ray0Raw,     gate: gate0,     weight: (1 - rayFrac) * (1 - gateFrac) },
      { ray: ray0Raw + 1, gate: gate0,     weight: rayFrac * (1 - gateFrac) },
      { ray: ray0Raw,     gate: gate0 + 1, weight: (1 - rayFrac) * gateFrac },
      { ray: ray0Raw + 1, gate: gate0 + 1, weight: rayFrac * gateFrac },
    ];

    let sum = 0;
    let weightSum = 0;
    let alphaSum = 0;
    let alphaWeightSum = 0;
    for (const sample of samples) {
      if (sample.weight <= 0) continue;
      if (sample.gate < 0 || sample.gate >= gateCount) continue;
      const rr = ((sample.ray % azimuthCount) + azimuthCount) % azimuthCount;
      const src = (rr * gateCount) + sample.gate;
      const coverage = smoothedField.weights[src];
      alphaSum += coverage * sample.weight;
      alphaWeightSum += sample.weight;
      if (coverage <= 1e-4) continue;
      sum += smoothedField.values[src] * coverage * sample.weight;
      weightSum += coverage * sample.weight;
    }
    return {
      value: weightSum > 1e-6 ? (sum / weightSum) : fallbackValue,
      alpha: alphaWeightSum > 1e-6 ? Math.max(0, Math.min(1, alphaSum / alphaWeightSum)) : 1,
    };
  };
  const writeVertexPosition = (vertex, x, y) => {
    const pos = vertex * 2;
    xy[pos + 0] = x;
    xy[pos + 1] = y;
  };
  const writeVertexValueColor = (vertex, value, alpha = 1) => {
    vals[vertex] = value;
    _writePreparedPaletteColor(palette, value, colorTmp, 0);
    const off = vertex * 4;
    rgba[off + 0] = colorTmp[0];
    rgba[off + 1] = colorTmp[1];
    rgba[off + 2] = colorTmp[2];
    rgba[off + 3] = Math.round(colorTmp[3] * lowDbzAlphaScale(value) * Math.max(0, Math.min(1, alpha)));
  };

  let seenValid = 0, outGateCount = 0, vertexIndex = 0;
  for (let ray = 0; ray < azimuthCount; ray += 1) {
    const rowBase   = ray * gateCount;
    const edgeBase0 = ray * rangeEdgeCount;
    const edgeBase1 = (ray + 1) * rangeEdgeCount;
    for (let gate = 0; gate < gateCount; gate += 1) {
      const fieldIdx = rowBase + gate;
      const code = grid[rowBase + gate];
      const rawValid = code > 0;
      const fieldValue = smoothingAvailable ? smoothedField.values[fieldIdx] : 0;
      const fieldWeight = smoothingAvailable ? smoothedField.weights[fieldIdx] : 0;
      const fringeValid = smoothingAvailable &&
        fieldWeight >= renderCoverageThreshold &&
        fieldValue > lowDbzDropBelow;
      if (!rawValid && !fringeValid) continue;
      if ((seenValid % stride) !== 0) { seenValid += 1; continue; }
      seenValid += 1;

      const value = rawValid ? codeToValue(code) : fieldValue;
      if (rawValid && lowDbzCleanup && cleanupStrength > 0.45 && value < lowDbzThreshold) {
        const support = lowDbzNeighborSupport(ray, gate);
        if (support.valid <= 1 && support.strong === 0) continue;
      }
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

      const emitVertex = (x, y, rayEdgeOffset, gateEdgeOffset) => {
        writeVertexPosition(vertexIndex, x, y);
        if (smoothingAvailable) {
          const sampled = sampleValueField(ray + rayEdgeOffset - 0.5, gate + gateEdgeOffset - 0.5, value);
          writeVertexValueColor(vertexIndex, sampled.value, sampled.alpha);
        } else {
          writeVertexValueColor(vertexIndex, value, 1);
        }
        if (types) types[vertexIndex] = typeCode;
        vertexIndex += 1;
      };

      emitVertex(x00, y00, 0, 0);
      emitVertex(x10, y10, 0, 1);
      emitVertex(x11, y11, 1, 1);
      emitVertex(x00, y00, 0, 0);
      emitVertex(x11, y11, 1, 1);
      emitVertex(x01, y01, 1, 0);
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
    min_val:      minValue,
    max_val:      maxValue,
    data_smoothing: smoothingAvailable,
    data_smoothing_method: smoothingAvailable ? 'separable-hann-value-field' : 'off',
    data_smoothing_strength: smoothStrength,
    data_smoothing_x: smoothX,
    data_smoothing_y: smoothY,
    data_smoothing_radius_x: smoothedField ? smoothedField.radiusX : 0,
    data_smoothing_radius_y: smoothedField ? smoothedField.radiusY : 0,
    data_smoothing_cleanup_strength: cleanupStrength,
    data_smoothing_low_dbz_cleanup: lowDbzCleanup,
    data_smoothing_low_dbz_threshold: lowDbzThreshold,
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
