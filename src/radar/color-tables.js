import {
  WISE_PRT_SECTION_ORDER, WISE_MULTI_TYPE_RANGE_SPAN,
} from '../core/config.js';

// ﻿// NEXRAD Level III Radar Viewer


export const PAL_PARSER_VERSION = 5;
export function _prepareInlinePalette(palData) {
  if (!palData) return null;
  const scale = Number.isFinite(Number(palData.scale)) ? Number(palData.scale) : 1.0;
  if (Array.isArray(palData.colors) && palData.colors.length) {
    const colors = [];
    for (const color of palData.colors) {
      if (!Array.isArray(color) || color.length < 3) continue;
      colors.push([
        Math.max(0, Math.min(255, Number(color[0]) || 0)),
        Math.max(0, Math.min(255, Number(color[1]) || 0)),
        Math.max(0, Math.min(255, Number(color[2]) || 0)),
        Math.max(0, Math.min(255, Number.isFinite(Number(color[3])) ? Number(color[3]) : 255)),
      ]);
    }
    if (colors.length) {
      return {
        scale,
        min: Number.isFinite(Number(palData.min)) ? Number(palData.min) : 0,
        max: Number.isFinite(Number(palData.max)) ? Number(palData.max) : colors.length - 1,
        lookupStep: Number.isFinite(Number(palData.lookupStep)) ? Number(palData.lookupStep) : 1,
        colors,
      };
    }
  }
  const discrete = String(palData.mode || '').trim().toLowerCase() === 'discrete';
  if (!Array.isArray(palData.stops) || palData.stops.length < 2) return null;
  const rows = [];
  const seen = new Map();
  for (const stop of palData.stops) {
    if (!Array.isArray(stop) || stop.length < 4) continue;
    const value = Number(stop[0]);
    if (!Number.isFinite(value)) continue;
    const row = [
      value,
      Math.max(0, Math.min(255, Number(stop[1]) || 0)),
      Math.max(0, Math.min(255, Number(stop[2]) || 0)),
      Math.max(0, Math.min(255, Number(stop[3]) || 0)),
      Math.max(0, Math.min(255, Number.isFinite(Number(stop[4])) ? Number(stop[4]) : 255)),
    ];
    if (discrete) rows.push(row);
    else seen.set(value, row);
  }
  if (!discrete) rows.push(...seen.values());
  rows.sort((a, b) => a[0] - b[0]);
  if (rows.length < 2) return null;

  const xp = new Float32Array(rows.length);
  const fp = new Float32Array(rows.length * 4);
  for (let i = 0; i < rows.length; i += 1) {
    xp[i] = rows[i][0];
    fp[(i * 4) + 0] = rows[i][1];
    fp[(i * 4) + 1] = rows[i][2];
    fp[(i * 4) + 2] = rows[i][3];
    fp[(i * 4) + 3] = rows[i][4];
  }
  return {
    scale,
    mode: discrete ? 'discrete' : (palData.mode || ''),
    xp,
    fp,
  };
}

export function _writePreparedPaletteColor(palette, rawValue, target, offset) {
  if (!palette || !target) {
    target[offset + 0] = 255;
    target[offset + 1] = 255;
    target[offset + 2] = 255;
    target[offset + 3] = 255;
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
      ? Math.floor(((clamped - min) / lookupStep) + 1e-9)
      : Math.floor(((clamped - min) / denom) * (colors.length - 1));
    const index = Math.max(0, Math.min(colors.length - 1, rawIndex));
    const color = colors[index] || colors[colors.length - 1];
    target[offset + 0] = color[0];
    target[offset + 1] = color[1];
    target[offset + 2] = color[2];
    target[offset + 3] = color[3];
    return;
  }

  const xp = palette.xp;
  const fp = palette.fp;
  if (!xp || !fp || xp.length < 1) {
    target[offset + 0] = 255;
    target[offset + 1] = 255;
    target[offset + 2] = 255;
    target[offset + 3] = 255;
    return;
  }
  let idx = 0;
  const last = xp.length - 1;

  if (palette.mode === 'discrete') {
    while (idx < last && scaled >= xp[idx + 1]) idx += 1;
    const base = idx * 4;
    target[offset + 0] = fp[base + 0];
    target[offset + 1] = fp[base + 1];
    target[offset + 2] = fp[base + 2];
    target[offset + 3] = fp[base + 3];
    return;
  }

  if (scaled <= xp[0]) {
    idx = 0;
  } else if (scaled >= xp[last]) {
    idx = last;
  } else {
    while (idx < last - 1 && scaled > xp[idx + 1]) idx += 1;
    const x0 = xp[idx];
    const x1 = xp[idx + 1];
    const t = Math.max(0, Math.min(1, (scaled - x0) / Math.max(x1 - x0, 1e-10)));
    const base = idx * 4;
    const next = (idx + 1) * 4;
    target[offset + 0] = Math.round(fp[base + 0] + t * (fp[next + 0] - fp[base + 0]));
    target[offset + 1] = Math.round(fp[base + 1] + t * (fp[next + 1] - fp[base + 1]));
    target[offset + 2] = Math.round(fp[base + 2] + t * (fp[next + 2] - fp[base + 2]));
    target[offset + 3] = Math.round(fp[base + 3] + t * (fp[next + 3] - fp[base + 3]));
    return;
  }

  const base = idx * 4;
  target[offset + 0] = fp[base + 0];
  target[offset + 1] = fp[base + 1];
  target[offset + 2] = fp[base + 2];
  target[offset + 3] = fp[base + 3];
}

export const WISE_PRT_PALETTE_SECTIONS = Object.freeze({
  RAIN: Object.freeze([
    [-30.0,  53,   8,  72, 255],
    [-12.0,  53,   8,  72, 255],
    [-10.0,  59,  33,  64, 255],
    [ -5.0,  64,  63,  66, 255],
    [  0.0, 118, 117, 118, 255],
    [  5.0, 188, 187, 187, 255],
    [ 10.0,  63,  94, 161, 255],
    [ 15.0,  92, 171, 216, 255],
    [ 20.0,  35, 187,  83, 255],
    [ 25.0,   2, 154,  11, 255],
    [ 30.0,   0, 115,   5, 255],
    [ 35.0,   0,  77,   0, 255],
    [ 40.0, 255, 214,   0, 255],
    [ 45.0, 255, 173,   0, 255],
    [ 50.0, 255,  23,   0, 255],
    [ 55.0, 213,  18,   3, 255],
    [ 60.0,  96,   8,   0, 255],
    [ 65.0, 255, 191, 253, 255],
    [ 70.0, 200, 117, 199, 255],
    [ 75.0, 255, 252, 255, 255],
    [ 80.0, 255, 252, 255, 255],
    [ 90.0, 255, 252, 255, 255],
  ]),
  SNOW: Object.freeze([
    [-30.0,  36, 115, 132, 255],
    [-10.0,  36, 115, 132, 255],
    [  0.0,   2, 117, 255, 255],
    [ 50.0,   0,   0,  50, 255],
    [ 70.0,   0,   0,  36, 255],
    [ 80.0,   0,   0,  26, 255],
    [ 90.0,   0,   0,  26, 255],
  ]),
  SLEET: Object.freeze([
    [-30.0, 128,  64, 192, 255],
    [-10.0, 128,  64, 192, 255],
    [  0.0, 160,  96, 224, 255],
    [ 50.0, 192, 128, 240, 255],
    [ 70.0, 120,  60, 178, 255],
    [ 80.0,  96,  40, 150, 255],
    [ 90.0,  96,  40, 150, 255],
  ]),
  FRZR: Object.freeze([
    [-30.0, 121,  93,  89, 255],
    [-10.0, 121,  93,  89, 255],
    [  0.0, 224,  80,  68, 255],
    [ 50.0,  34,  17,  20, 255],
    [ 70.0,  58,  26,  34, 255],
    [ 80.0,  42,  20,  24, 255],
    [ 90.0,  42,  20,  24, 255],
  ]),
});

let _wisePrtPreparedPalette = null;

export function _prepareWisePrtPalette() {
  if (_wisePrtPreparedPalette) return _wisePrtPreparedPalette;
  const combinedStops = [];
  WISE_PRT_SECTION_ORDER.forEach((section, index) => {
    const stops = WISE_PRT_PALETTE_SECTIONS[section] || [];
    const offset = WISE_MULTI_TYPE_RANGE_SPAN * index;
    stops.forEach(stop => {
      combinedStops.push([
        Number(stop[0]) + offset,
        stop[1],
        stop[2],
        stop[3],
        stop[4],
      ]);
    });
  });
  _wisePrtPreparedPalette = _prepareInlinePalette({ scale: 1, stops: combinedStops });
  return _wisePrtPreparedPalette;
}
export const CT_FAMILIES = ['REF', 'VEL', 'SRV', 'CC', 'ZDR', 'SW'];
export const EET_DEFAULT_PALETTE = {
  product: 'ET',
  units: 'KFT',
  scale: 1,
  step: 5,
  stops: [
    [10.0, 150, 225, 255, 255],
    [15.0,  25, 215, 255, 255],
    [20.0,  15, 125, 215, 255],
    [25.0,  15, 100, 115, 255],
    [30.0,  50, 255, 225, 255],
    [35.0,  25, 180, 150, 255],
    [40.0, 255, 255,   0, 255],
    [45.0, 220, 180,   0, 255],
    [50.0, 155,  65,   0, 255],
    [52.0, 125,  65,   0, 255],
    [55.0, 255,  55,   0, 255],
    [57.0, 125,  25,   0, 255],
    [59.0, 200,  50, 255, 255],
    [63.0,  75,   0, 200, 255],
    [65.0,  50,   0, 100, 255],
    [66.0,  50,   0,  75, 255],
    [70.0,  25,   0,  50, 255],
  ],
};
export const CT_DEFAULT_PALETTES = {
  REF: {
    product: 'REF',
    units: 'dBZ',
    scale: 1,
    step: 5,
    stops: [
      [0.0,    4, 233, 231,   0],
      [5.0,    4, 233, 231, 200],
      [10.0,   1, 159, 244, 200],
      [15.0,   3,   0, 244, 200],
      [20.0,   2, 253,   2, 200],
      [25.0,   1, 197,   1, 200],
      [30.0,   0, 142,   0, 200],
      [35.0, 253, 248,   2, 220],
      [40.0, 229, 188,   0, 220],
      [45.0, 253, 149,   0, 220],
      [50.0, 253,   0,   0, 230],
      [55.0, 212,   0,   0, 230],
      [60.0, 188,   0,   0, 230],
      [65.0, 248,   0, 253, 240],
      [70.0, 152,  84, 198, 240],
    ],
  },
  VEL: {
    product: 'BV',
    units: 'MPH',
    scale: 2.237,
    step: 20,
    stops: [
      [-160.0,   0,   0,   0, 255],
      [-120.0,   0,   0, 255, 255],
      [ -58.0,  71, 240, 240, 255],
      [ -50.0,  82, 247,  89, 255],
      [ -10.0,   5,  33,   0, 255],
      [   0.0, 110, 110, 110, 255],
      [  10.0,  33,   0,   0, 255],
      [  50.0, 255,  55,  26, 255],
      [  58.0, 254, 154,  39, 255],
      [  70.0, 255, 255,   0, 255],
      [ 120.0, 164,  89,  68, 255],
      [ 160.0,   0,   0,   0, 255],
    ],
  },
  SRV: {
    product: 'SRV',
    units: 'MPH',
    scale: 2.237,
    step: 20,
    stops: [
      [-160.0,   0,   0,   0, 255],
      [-120.0,   0,   0, 255, 255],
      [ -58.0,  71, 240, 240, 255],
      [ -50.0,  82, 247,  89, 255],
      [ -10.0,   5,  33,   0, 255],
      [   0.0, 110, 110, 110, 255],
      [  10.0,  33,   0,   0, 255],
      [  50.0, 255,  55,  26, 255],
      [  58.0, 254, 154,  39, 255],
      [  70.0, 255, 255,   0, 255],
      [ 120.0, 164,  89,  68, 255],
      [ 160.0,   0,   0,   0, 255],
    ],
  },
  CC: {
    product: 'CC',
    units: '%',
    scale: 100,
    step: 4,
    stops: [
      [20.0,  20,   0,  50, 255],
      [24.0,  22,   0,  55, 255],
      [28.0,  23,   0,  59, 255],
      [32.0,  25,   0,  64, 255],
      [36.0,  20,   0,  69, 255],
      [40.0,  28,   0,  73, 255],
      [44.0,  30,   0,  79, 255],
      [48.0,  22,   0,  88, 255],
      [52.0,   9,   0, 101, 255],
      [56.0,   0,   0, 113, 255],
      [60.0,   0,   0, 130, 255],
      [64.0,   0,   0, 146, 255],
      [68.0,   0,   0, 163, 255],
      [72.0,   0,   0, 203, 255],
      [76.0,  30,  30, 255, 255],
      [80.0, 120, 120, 255, 255],
      [84.0,  93, 229, 119, 255],
      [88.0, 121, 235,  17, 255],
      [92.0, 255, 187,   0, 255],
      [96.0, 255,  11,   0, 255],
      [100.0, 25,  25,  25, 255],
    ],
  },
  ZDR: {
    product: 'ZDR',
    units: 'dB',
    scale: 1,
    step: 0.25,
    stops: [
      [-4.00,   0,   0,   0, 200],
      [ 0.00, 142, 121, 181, 215],
      [ 0.25,  10,  10, 155, 220],
      [ 1.00,  68, 248, 212, 225],
      [ 1.50,  90, 221,  98, 225],
      [ 2.00, 255, 255, 100, 230],
      [ 3.00, 220,  10,   5, 235],
      [ 4.00, 175,   0,   0, 235],
      [ 5.00, 240, 120, 180, 235],
      [ 6.00, 255, 255, 255, 240],
      [ 8.00, 145,  45, 150, 245],
    ],
  },
  SW: {
    product: 'SW',
    units: 'KTS',
    scale: 1.9426,
    step: 2,
    stops: [
      [ 0.0,   5,   5,   6, 255],
      [ 2.0,  42,  42,  49, 255],
      [ 4.0,  78,  77,  91, 255],
      [ 6.0, 115, 114, 133, 255],
      [ 8.0, 152, 148, 173, 255],
      [10.0, 200, 109, 105, 255],
      [12.0, 246,  75,  42, 255],
      [14.0, 248, 116,  52, 255],
      [16.0, 250, 161,  63, 255],
      [18.0, 252, 203,  73, 255],
      [20.0, 255, 244,  83, 255],
      [22.0, 255, 248, 111, 255],
      [24.0, 255, 250, 140, 255],
      [26.0, 255, 251, 170, 255],
      [28.0, 255, 252, 199, 255],
      [30.0, 255, 254, 226, 255],
      [32.0, 246, 246, 246, 255],
    ],
  },
  DTA: {
    product: 'DTA',
    units: 'IN',
    scale: 1,
    step: 0.25,
    stops: [
      [0.00,   0,   0,   0,   0],
      [0.05,  24,  26,  38, 110],
      [0.10,  36,  78, 124, 165],
      [0.25,  43, 127, 184, 215],
      [0.50,  42, 179, 120, 230],
      [0.75, 116, 214,  74, 235],
      [1.00, 232, 233,  63, 240],
      [1.50, 250, 180,  52, 245],
      [2.00, 240, 110,  44, 245],
      [3.00, 214,  44,  52, 245],
      [4.00, 178,  38, 118, 245],
      [6.00, 143,  70, 195, 248],
      [8.00, 236, 241, 247, 250],
    ],
  },
  EET: EET_DEFAULT_PALETTE,
  KDP: {
    product: 'KDP',
    units: '°/km',
    scale: 1,
    step: 0.5,
    stops: [
      [-2.0, 142, 142, 142, 200],
      [-1.0,  76,   0,   1, 220],
      [-0.5, 163,   7,  48, 220],
      [ 0.0, 234, 115, 180, 220],
      [ 0.5, 153, 126, 185, 225],
      [ 1.0, 104, 244, 244, 230],
      [ 1.5,  26, 186,  52, 235],
      [ 2.0,  17, 249,  16, 240],
      [ 3.0, 247, 252,   0, 245],
      [ 4.0, 255, 124,  16, 245],
      [ 6.0, 255, 196, 124, 248],
      [ 8.0, 121,   2, 125, 250],
    ],
  },
  NROT: {
    product: 'NROT',
    units: '/ks',
    scale: 1,
    step: 0.005,
    stops: [
      [-0.05,   0,   0, 128, 220],
      [-0.03,   0,   0, 255, 230],
      [-0.02,   0, 128, 255, 235],
      [-0.01,   0, 255, 255, 235],
      [ 0.00, 128, 128, 128,  80],
      [ 0.01, 255, 200,   0, 235],
      [ 0.02, 255, 128,   0, 235],
      [ 0.03, 255,   0,   0, 240],
      [ 0.05, 128,   0,   0, 250],
    ],
  },
  PTDS: {
    product: 'PTDS',
    units: '%',
    scale: 1,
    step: 10,
    stops: [
      [  0,   0,   0,   0,   0],
      [ 10,   0, 200,   0,  60],
      [ 20,  60, 220,   0, 120],
      [ 30, 255, 255,   0, 160],
      [ 50, 255, 165,   0, 200],
      [ 70, 255,  60,   0, 230],
      [ 80, 200,   0,   0, 245],
      [100, 255,   0, 255, 255],
    ],
  },
  REFE: {
    product: 'REFE',
    units: 'dBZ',
    scale: 1,
    step: 5,
    stops: [
      [  0.0,   4, 233, 231,   0],
      [  5.0,   4, 233, 231, 200],
      [ 10.0,   1, 159, 244, 200],
      [ 15.0,   3,   0, 244, 200],
      [ 20.0,   2, 253,   2, 200],
      [ 25.0,   1, 197,   1, 200],
      [ 30.0,   0, 142,   0, 200],
      [ 35.0, 253, 248,   2, 220],
      [ 40.0, 229, 188,   0, 220],
      [ 45.0, 253, 149,   0, 220],
      [ 50.0, 253,   0,   0, 230],
      [ 55.0, 212,   0,   0, 230],
      [ 60.0, 188,   0,   0, 230],
      [ 65.0, 248,   0, 253, 240],
      [ 70.0, 152,  84, 198, 240],
      [ 75.0, 255, 255, 255, 255],
    ],
  },
  SHR: {
    product: 'SHR',
    units: 'KTS',
    scale: 1.9426,
    step: 2,
    stops: [
      [ 0.0,   5,   5,   6, 255],
      [ 2.0,  42,  42,  49, 255],
      [ 4.0,  78,  77,  91, 255],
      [ 6.0, 115, 114, 133, 255],
      [ 8.0, 152, 148, 173, 255],
      [10.0, 200, 109, 105, 255],
      [12.0, 246,  75,  42, 255],
      [14.0, 248, 116,  52, 255],
      [16.0, 250, 161,  63, 255],
      [18.0, 252, 203,  73, 255],
      [20.0, 255, 244,  83, 255],
      [25.0, 255, 248, 111, 255],
      [30.0, 246, 246, 246, 255],
    ],
  },
};

// Default gradient CSS for preview bars
export const CT_DEFAULT_GRADIENTS = {
  REF: 'linear-gradient(to right, #04E9E7 0%, #019CF4 12%, #0300F4 18%, #02FD02 24%, #01C501 30%, #008E00 37%, #FDF802 43%, #E7BC00 50%, #FD9500 57%, #FD0000 64%, #D40000 72%, #BC0000 79%, #F800FD 86%, #9854C6 100%)',
  VEL: 'linear-gradient(to right, rgb(0,0,0) 0%, rgb(0,0,255) 12.5%, rgb(71,240,240) 31.9%, rgb(82,247,89) 34.4%, rgb(5,33,0) 46.9%, rgb(110,110,110) 50%, rgb(33,0,0) 53.1%, rgb(255,55,26) 65.6%, rgb(254,154,39) 68.1%, rgb(255,255,0) 71.9%, rgb(164,89,68) 87.5%, rgb(0,0,0) 100%)',
  CC:  'linear-gradient(to right, rgb(20,0,50) 0%, rgb(22,0,55) 5%, rgb(23,0,59) 10%, rgb(25,0,64) 15%, rgb(20,0,69) 20%, rgb(28,0,73) 25%, rgb(30,0,79) 30%, rgb(22,0,88) 35%, rgb(9,0,101) 40%, rgb(0,0,113) 45%, rgb(0,0,130) 50%, rgb(0,0,146) 55%, rgb(0,0,163) 60%, rgb(0,0,203) 65%, rgb(30,30,255) 70%, rgb(120,120,255) 75%, rgb(93,229,119) 80%, rgb(121,235,17) 85%, rgb(255,187,0) 90%, rgb(255,11,0) 95%, rgb(25,25,25) 100%)',
  ZDR: 'linear-gradient(to right, rgba(0,0,0,0.78) 0%, rgba(142,121,181,0.84) 33%, rgba(10,10,155,0.86) 38%, rgba(68,248,212,0.88) 47%, rgba(90,221,98,0.88) 53%, rgba(255,255,100,0.90) 60%, rgba(220,10,5,0.92) 73%, rgba(175,0,0,0.92) 80%, rgba(240,120,180,0.92) 87%, rgba(255,255,255,0.94) 93%, rgba(145,45,150,0.96) 100%)',
  KDP: 'linear-gradient(to right, rgb(142,142,142) 0%, rgb(76,0,1) 12.5%, rgb(163,7,48) 18.8%, rgb(234,115,180) 25%, rgb(153,126,185) 29.2%, rgb(104,244,244) 33.3%, rgb(26,186,52) 37.5%, rgb(17,249,16) 41.7%, rgb(247,252,0) 50%, rgb(255,124,16) 58.3%, rgb(255,196,124) 75%, rgb(121,2,125) 100%)',
  NROT: 'linear-gradient(to right, rgb(0,0,128) 0%, rgb(0,0,255) 16%, rgb(0,128,255) 25%, rgb(0,255,255) 33%, rgb(128,128,128) 50%, rgb(255,200,0) 67%, rgb(255,128,0) 75%, rgb(255,0,0) 84%, rgb(128,0,0) 100%)',
  REFE: 'linear-gradient(to right, #04E9E7 0%, #019CF4 12%, #0300F4 18%, #02FD02 24%, #01C501 30%, #008E00 37%, #FDF802 43%, #E7BC00 50%, #FD9500 57%, #FD0000 64%, #D40000 72%, #BC0000 79%, #F800FD 86%, #9854C6 93%, #ffffff 100%)',
  SHR: 'linear-gradient(to right, rgb(5,5,6) 0%, rgb(42,42,49) 8%, rgb(78,77,91) 16%, rgb(115,114,133) 24%, rgb(152,148,173) 32%, rgb(200,109,105) 40%, rgb(246,75,42) 48%, rgb(248,116,52) 56%, rgb(250,161,63) 64%, rgb(252,203,73) 72%, rgb(255,244,83) 80%, rgb(255,248,111) 85%, rgb(255,250,140) 89%, rgb(255,251,170) 93%, rgb(255,254,226) 98%, rgb(246,246,246) 100%)',
  SRV: 'linear-gradient(to right, rgb(0,0,0) 0%, rgb(0,0,255) 12.5%, rgb(71,240,240) 31.9%, rgb(82,247,89) 34.4%, rgb(5,33,0) 46.9%, rgb(110,110,110) 50%, rgb(33,0,0) 53.1%, rgb(255,55,26) 65.6%, rgb(254,154,39) 68.1%, rgb(255,255,0) 71.9%, rgb(164,89,68) 87.5%, rgb(0,0,0) 100%)',
  SW:  'linear-gradient(to right, rgb(5,5,6) 0%, rgb(42,42,49) 8%, rgb(78,77,91) 16%, rgb(115,114,133) 24%, rgb(152,148,173) 32%, rgb(200,109,105) 40%, rgb(246,75,42) 48%, rgb(248,116,52) 56%, rgb(250,161,63) 64%, rgb(252,203,73) 72%, rgb(255,244,83) 80%, rgb(255,248,111) 85%, rgb(255,250,140) 89%, rgb(255,251,170) 93%, rgb(255,252,199) 96%, rgb(255,254,226) 98%, rgb(246,246,246) 100%)',
  DTA: 'linear-gradient(to right, rgba(0,0,0,0.0) 0%, rgba(24,26,38,0.43) 2%, rgba(36,78,124,0.65) 8%, rgba(43,127,184,0.84) 20%, rgba(42,179,120,0.90) 35%, rgba(116,214,74,0.92) 45%, rgba(232,233,63,0.94) 55%, rgba(250,180,52,0.96) 65%, rgba(240,110,44,0.96) 74%, rgba(214,44,52,0.96) 82%, rgba(178,38,118,0.96) 90%, rgba(143,70,195,0.97) 96%, rgba(236,241,247,0.98) 100%)',
  ET:   'linear-gradient(to right, #00c8ff 0%, #00e100 20%, #ffff00 40%, #ff9600 60%, #ff0000 80%, #ff00ff 100%)',
  VIL:  'linear-gradient(to right, #646464 0%, #00e6e6 20%, #00aa00 40%, #ffff00 60%, #ff6400 80%, #ff00ff 100%)',
  NROT: 'linear-gradient(to right, rgb(0,0,128) 0%, rgb(0,0,255) 16%, rgb(0,128,255) 25%, rgb(0,255,255) 33%, rgb(128,128,128) 50%, rgb(255,200,0) 67%, rgb(255,128,0) 75%, rgb(255,0,0) 84%, rgb(128,0,0) 100%)',
  REFE: 'linear-gradient(to right, #04E9E7 0%, #019CF4 12%, #0300F4 18%, #02FD02 24%, #01C501 30%, #008E00 37%, #FDF802 43%, #E7BC00 50%, #FD9500 57%, #FD0000 64%, #D40000 72%, #BC0000 79%, #F800FD 86%, #9854C6 93%, #ffffff 100%)',
  SHR:  'linear-gradient(to right, rgb(5,5,6) 0%, rgb(78,77,91) 16%, rgb(152,148,173) 32%, rgb(200,109,105) 40%, rgb(246,75,42) 48%, rgb(250,161,63) 64%, rgb(255,244,83) 80%, rgb(255,254,226) 98%, rgb(246,246,246) 100%)',
};

export function ctStore(family) {
  try {
    const store = JSON.parse(localStorage.getItem(`radar_ct_${family}`) || '{"active":"Default","tables":{}}');
    let changed = false;
    if (store?.tables && typeof store.tables === 'object') {
      for (const [name, palette] of Object.entries(store.tables)) {
        if (palette?.parserVersion !== PAL_PARSER_VERSION) {
          if (typeof palette?.sourceText === 'string') {
            const reparsed = parsePalFile(palette.sourceText);
            if (reparsed) {
              store.tables[name] = reparsed;
              changed = true;
            }
          } else {
            console.warn('[PAL] stored palette needs re-upload:', name);
            delete store.tables[name];
            if (store.active === name) store.active = 'Default';
            changed = true;
          }
        }
      }
    }
    if (changed) ctSave(family, store);
    return store;
  } catch (_) { return { active: 'Default', tables: {} }; }
}

export function ctSave(family, store) {
  try { localStorage.setItem(`radar_ct_${family}`, JSON.stringify(store)); } catch (_) {}
}

export function ctGetActivePalette(family) {
  const store = ctStore(family);
  if (store.active === 'Default') return null;
  return store.tables[store.active] || null;
}

export function ctGetDefaultPalette(family) {
  return CT_DEFAULT_PALETTES[String(family || '').trim().toUpperCase()] || null;
}

export function ctGetEffectivePalette(family) {
  return ctGetActivePalette(family) || ctGetDefaultPalette(family);
}

export function getActivePalettes() {
  return {
    REF:  ctGetEffectivePalette('REF'),
    VEL:  ctGetEffectivePalette('VEL'),
    CC:   ctGetEffectivePalette('CC'),
    ZDR:  ctGetEffectivePalette('ZDR'),
    SW:   ctGetEffectivePalette('SW'),
    KDP:  ctGetEffectivePalette('KDP'),
    SRV:  ctGetEffectivePalette('SRV'),
    NROT: ctGetEffectivePalette('NROT'),
    REFE: ctGetEffectivePalette('REFE'),
    SHR:  ctGetEffectivePalette('SHR'),
    ET:   ctGetEffectivePalette('ET') || ctGetEffectivePalette('EET'),
    VIL:  ctGetEffectivePalette('VIL') || ctGetEffectivePalette('NVL'),
    EET:  ctGetEffectivePalette('ET') || ctGetEffectivePalette('EET'),
    NVL:  ctGetEffectivePalette('VIL') || ctGetEffectivePalette('NVL'),
  };
}

export function getActiveDecodeOptions() {
  return {
    palettes: getActivePalettes(),
  };
}

export function parsePalFile(text) {
  const rows = [];
  let scaleValue = null;
  let offsetValue = 0;
  let product = '';
  let units = '';
  let step = null;
  let rf = null;
  let rawColorRowCount = 0;
  let singleColorRowCount = 0;
  let dualColorRowCount = 0;
  let solidColorRowCount = 0;

  const clampByte = value => Math.min(255, Math.max(0, Math.round(Number(value))));
  const parseColor = (parts, offset = 0, count = 3) => {
    if (parts.length - offset < 3) return null;
    const rgba = parts.slice(offset, offset + count).map(Number);
    if (!Number.isFinite(rgba[0]) || !Number.isFinite(rgba[1]) || !Number.isFinite(rgba[2])) return null;
    return [
      clampByte(rgba[0]),
      clampByte(rgba[1]),
      clampByte(rgba[2]),
      Number.isFinite(rgba[3]) ? clampByte(rgba[3]) : 255,
    ];
  };
  const normalizeProduct = value => {
    const code = String(value || '').trim().toUpperCase();
    return code === 'BR' ? 'REF' : code;
  };
  const normalizeValue = value => {
    let normalized = Number(value);
    if (!Number.isFinite(normalized)) return NaN;
    if (Number.isFinite(scaleValue) && scaleValue !== 0) normalized /= scaleValue;
    if (Number.isFinite(offsetValue)) normalized += offsetValue;
    return normalized;
  };
  const addRow = (value, color1, color2 = null, solid = false) => {
    const normalized = normalizeValue(value);
    if (!Number.isFinite(normalized) || !color1) return;
    rows.push({ value: normalized, color1, color2, solid });
  };

  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine
      .replace(/\r/g, '')
      .replace(/#.*/, '')
      .replace(/\/\/.*$/, '')
      .replace(/;.*$/, '')
      .trim();
    if (!line) continue;

    const keyMatch = line.match(/^([a-z][\w -]*)\s*[:=]\s*(.*)$/i);
    const key = keyMatch ? keyMatch[1].trim().toLowerCase().replace(/\s+/g, '') : '';
    const valueText = keyMatch ? keyMatch[2].trim() : '';

    if (key === 'product') {
      product = normalizeProduct(valueText);
      continue;
    }
    if (key === 'units') {
      units = valueText;
      continue;
    }
    if (key === 'scale') {
      const parsed = parseFloat(valueText);
      scaleValue = Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
      continue;
    }
    if (key === 'offset') {
      const parsed = parseFloat(valueText);
      offsetValue = Number.isFinite(parsed) ? parsed : 0;
      continue;
    }
    if (key === 'step') {
      const parsed = parseFloat(valueText);
      step = Number.isFinite(parsed) ? parsed : null;
      continue;
    }
    if (key === 'rf') {
      const parsed = parseFloat(valueText);
      rf = Number.isFinite(parsed) ? parsed : valueText;
      continue;
    }

    const isColor = key === 'color' || key === 'color4';
    const isSolid = key === 'solidcolor' || key === 'solidcolor4';
    if (!isColor && !isSolid) continue;

    const nums = valueText.split(/[\s,]+/).filter(Boolean).map(Number);
    if (!nums.every(Number.isFinite) || nums.length < 4) continue;
    const colorSize = key.endsWith('4') ? 4 : 3;
    if (nums.length < 1 + colorSize) continue;
    const value = nums[0];
    const color1 = parseColor(nums, 1, colorSize);
    if (!color1) continue;
    let color2 = null;
    if (isSolid) {
      color2 = color1.slice();
      solidColorRowCount += 1;
    } else if (nums.length >= 1 + (colorSize * 2)) {
      color2 = parseColor(nums, 1 + colorSize, colorSize);
    }
    rawColorRowCount += 1;
    if (color2 && !isSolid) dualColorRowCount += 1;
    else singleColorRowCount += 1;
    addRow(value, color1, color2, isSolid);
  }

  const orderedRows = rows.slice().sort((a, b) => a.value - b.value);
  if (orderedRows.length < 2) return null;
  const stops = [];
  const addStop = (value, color) => {
    if (!Number.isFinite(value) || !Array.isArray(color)) return;
    stops.push([value, ...color]);
  };
  for (let i = 0; i < orderedRows.length; i += 1) {
    const row = orderedRows[i];
    const next = orderedRows[i + 1] || null;
    addStop(row.value, row.color1);
    if (row.color2) {
      const stepSize = Number.isFinite(step) && step > 0 ? step : 1;
      const rampEnd = row.value + stepSize;
      addStop(rampEnd, row.color2);
      if (next && Number.isFinite(next.value) && next.value > rampEnd) {
        addStop(next.value, row.color2);
      }
    }
  }
  const lookupProduct = product || '';
  const hasSegmentRows = dualColorRowCount > 0 || solidColorRowCount > 0;
  const lookupStep = hasSegmentRows ? 0.5 : 1.0;
  const min = orderedRows[0].value;
  const lastRow = orderedRows[orderedRows.length - 1];
  const max = lastRow?.color2 && Number.isFinite(step) && step > 0
    ? Math.max(lastRow.value + step, lastRow.value)
    : orderedRows[orderedRows.length - 1].value;
  const colors = [];
  const lerp = (a, b, t) => [
    Math.round(a[0] + ((b[0] - a[0]) * t)),
    Math.round(a[1] + ((b[1] - a[1]) * t)),
    Math.round(a[2] + ((b[2] - a[2]) * t)),
    Math.round(a[3] + ((b[3] - a[3]) * t)),
  ];
  if (hasSegmentRows) {
    for (let y = min; y <= max + (lookupStep * 1e-6); y += lookupStep) {
      let idx = 0;
      while (idx < orderedRows.length - 1 && y >= orderedRows[idx + 1].value) idx += 1;
      const row = orderedRows[idx];
      const next = orderedRows[idx + 1] || null;
      if (row.color2) {
        const stepSize = Number.isFinite(step) && step > 0 ? step : 1;
        const rampEnd = row.value + stepSize;
        if (y <= rampEnd) {
          const t = Math.max(0, Math.min(1, (y - row.value) / Math.max(rampEnd - row.value, 1e-10)));
          colors.push(lerp(row.color1, row.color2, t));
        } else {
          colors.push(row.color2.slice());
        }
      } else if (next) {
        const denom = Math.max(next.value - row.value, 1e-10);
        const t = Math.max(0, Math.min(1, (y - row.value) / denom));
        colors.push(lerp(row.color1, next.color1, t));
      } else {
        colors.push(row.color1.slice());
      }
    }
  }

  const palette = {
    product: lookupProduct,
    units,
    min,
    max,
    lookupStep,
    scale: 1,
    stops: stops.filter(stop => stop.every(Number.isFinite)).sort((a, b) => a[0] - b[0]),
    parserVersion: PAL_PARSER_VERSION,
    sourceText: String(text || ''),
    debug: {
      rawColorRowCount,
      singleColorRowCount,
      dualColorRowCount,
      solidColorRowCount,
      sourceScale: scaleValue,
      offset: offsetValue,
    },
  };
  if (colors.length) palette.colors = colors;
  if (colors.length) palette.mode = 'segments';
  else palette.mode = 'continuous';
  if (Number.isFinite(step)) palette.step = step;
  if (rf !== null) palette.rf = rf;
  console.debug('[PAL] parsed palette summary', {
    name: lookupProduct || 'uploaded palette',
    parserMode: palette.mode,
    colorRows: rawColorRowCount,
    generatedSegments: hasSegmentRows ? colors.length : 0,
    first10: colors.length ? colors.slice(0, 10) : palette.stops.slice(0, 10),
    last10: colors.length ? colors.slice(-10) : palette.stops.slice(-10),
    parserVersion: PAL_PARSER_VERSION,
  });
  return palette;
}

export function buildGradientStyle(palette, family, direction = 'to right') {
  if (!palette || !palette.stops || palette.stops.length < 2) {
    const fallback = CT_DEFAULT_GRADIENTS[family] || '#333';
    if (direction === 'to right' || !String(fallback).startsWith('linear-gradient(')) return fallback;
    return fallback.replace('to right', direction);
  }
  const { stops } = palette;
  const min = stops[0][0], max = stops[stops.length - 1][0];
  const range = max - min || 1;
  const colorStops = stops.map(([val, r, g, b, a]) => {
    const pct = ((val - min) / range * 100).toFixed(1);
    return `rgba(${r},${g},${b},${(a / 255).toFixed(2)}) ${pct}%`;
  });
  return `linear-gradient(${direction}, ${colorStops.join(', ')})`;
}

export function _formatColorbarValue(value) {
  if (!Number.isFinite(value)) return '';
  if (Math.abs(value) >= 100 || Number.isInteger(value)) return String(Math.round(value));
  if (Math.abs(value) >= 10) return String(Math.round(value));
  return value.toFixed(1).replace(/\.0$/, '');
}

export function _colorbarLabelsForPalette(palette) {
  if (!palette?.stops?.length) return ['', '', ''];
  const values = palette.stops
    .map(stop => Number(stop?.[0]))
    .filter(val => Number.isFinite(val));
  if (values.length < 2) return ['', '', ''];
  const min = values[0];
  const max = values[values.length - 1];
  const mid = min + ((max - min) / 2);
  return [_formatColorbarValue(max), _formatColorbarValue(mid), _formatColorbarValue(min)];
}
