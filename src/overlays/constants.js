// Shared overlay and warning constants extracted from radar.js.

// ﻿// NEXRAD Level III Radar Viewer

export const SPC_OUTLOOK_SOURCES = {
  DAY1: {
    CAT:  { base: 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson' },
    TORN: { base: 'https://www.spc.noaa.gov/products/outlook/day1otlk_torn.nolyr.geojson', cig: 'https://www.spc.noaa.gov/products/outlook/day1otlk_cigtorn.nolyr.geojson' },
    HAIL: { base: 'https://www.spc.noaa.gov/products/outlook/day1otlk_hail.nolyr.geojson', cig: 'https://www.spc.noaa.gov/products/outlook/day1otlk_cighail.nolyr.geojson' },
    WIND: { base: 'https://www.spc.noaa.gov/products/outlook/day1otlk_wind.nolyr.geojson', cig: 'https://www.spc.noaa.gov/products/outlook/day1otlk_cigwind.nolyr.geojson' },
  },
  DAY2: {
    CAT:  { base: 'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.nolyr.geojson' },
    TORN: { base: 'https://www.spc.noaa.gov/products/outlook/day2otlk_torn.nolyr.geojson', cig: 'https://www.spc.noaa.gov/products/outlook/day2otlk_cigtorn.nolyr.geojson' },
    HAIL: { base: 'https://www.spc.noaa.gov/products/outlook/day2otlk_hail.nolyr.geojson', cig: 'https://www.spc.noaa.gov/products/outlook/day2otlk_cighail.nolyr.geojson' },
    WIND: { base: 'https://www.spc.noaa.gov/products/outlook/day2otlk_wind.nolyr.geojson', cig: 'https://www.spc.noaa.gov/products/outlook/day2otlk_cigwind.nolyr.geojson' },
  },
  DAY3: {
    CAT:  { base: 'https://www.spc.noaa.gov/products/outlook/day3otlk_cat.nolyr.geojson' },
    PROB: { base: 'https://www.spc.noaa.gov/products/outlook/day3otlk_prob.nolyr.geojson', cig: 'https://www.spc.noaa.gov/products/outlook/day3otlk_cigprob.nolyr.geojson' },
  },
  DAY4: { PROB: { base: 'https://www.spc.noaa.gov/products/exper/day4-8/day4prob.nolyr.geojson' } },
  DAY5: { PROB: { base: 'https://www.spc.noaa.gov/products/exper/day4-8/day5prob.nolyr.geojson' } },
  DAY6: { PROB: { base: 'https://www.spc.noaa.gov/products/exper/day4-8/day6prob.nolyr.geojson' } },
  DAY7: { PROB: { base: 'https://www.spc.noaa.gov/products/exper/day4-8/day7prob.nolyr.geojson' } },
  DAY8: { PROB: { base: 'https://www.spc.noaa.gov/products/exper/day4-8/day8prob.nolyr.geojson' } },
};

export const SPC_TYPE_OPTIONS_BY_DAY = {
  DAY1: [
    { id: 'CAT', label: 'Categorical' },
    { id: 'TORN', label: 'Tornado' },
    { id: 'HAIL', label: 'Hail' },
    { id: 'WIND', label: 'Wind' },
  ],
  DAY2: [
    { id: 'CAT', label: 'Categorical' },
    { id: 'TORN', label: 'Tornado' },
    { id: 'HAIL', label: 'Hail' },
    { id: 'WIND', label: 'Wind' },
  ],
  DAY3: [
    { id: 'CAT', label: 'Categorical' },
    { id: 'PROB', label: 'Probabilistic' },
  ],
  DAY4: [{ id: 'PROB', label: 'Probabilistic' }],
  DAY5: [{ id: 'PROB', label: 'Probabilistic' }],
  DAY6: [{ id: 'PROB', label: 'Probabilistic' }],
  DAY7: [{ id: 'PROB', label: 'Probabilistic' }],
  DAY8: [{ id: 'PROB', label: 'Probabilistic' }],
};

export const SPC_CAT_COLORS = {
  HIGH: { line: '#FF00FF', fill: '#FF80FF' },
  MDT:  { line: '#CD0000', fill: '#E68080' },
  ENH:  { line: '#FF7F00', fill: '#E6C280' },
  SLGT: { line: '#FF9600', fill: '#F7F780' },
  MRGL: { line: '#3C783C', fill: '#80C580' },
  TSTM: { line: '#646464', fill: '#C1E9C1' },
};

export const SPC_PROB_COLORS = {
  60: { line: '#3962B3', fill: '#5C85D6' },
  45: { line: '#9636EE', fill: '#C896F7' },
  30: { line: '#FF00FF', fill: '#FF80FF' },
  15: { line: '#FF0000', fill: '#FF8080' },
  10: { line: '#FF9600', fill: '#FFEB80' },
  5:  { line: '#8B4726', fill: '#C5A393' },
  2:  { line: '#3C783C', fill: '#80C580' },
};

export const SPC_DAY3_PROB_COLORS = {
  60: { line: '#6E4D96', fill: '#7FF7F7' },
  45: { line: '#FF00FF', fill: '#C895F6' },
  30: { line: '#CD0000', fill: '#FF8080' },
  15: { line: '#FF9600', fill: '#FAE77B' },
  5:  { line: '#8B4726', fill: '#C5A393' },
};

export const SPC_WIND_PROB_COLORS = {
  90: { line: '#46ACE3', fill: '#1AFFFF' },
  75: { line: '#3962B3', fill: '#5C85D6' },
  60: { line: '#912CEE', fill: '#C895F6' },
  45: { line: '#FF00FF', fill: '#FF80FF' },
  30: { line: '#CD0000', fill: '#FF8080' },
  15: { line: '#FF9600', fill: '#FAE77B' },
  5:  { line: '#8B4726', fill: '#C5A393' },
};

// Hail probabilities follow the wind-style ramp but do not include 75%/90%.
export const SPC_HAIL_PROB_COLORS = {
  60: { line: '#912CEE', fill: '#C895F6' },
  45: { line: '#FF00FF', fill: '#FF80FF' },
  30: { line: '#CD0000', fill: '#FF8080' },
  15: { line: '#FF9600', fill: '#FAE77B' },
  5:  { line: '#8B4726', fill: '#C5A393' },
};

export const SPC_DAY4_8_PROB_COLORS = {
  30: { line: '#A66B00', fill: '#E3C17F' },
  15: { line: '#FF9600', fill: '#FFEB7F' },
};

export const SPC_EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };
export const SPC_LAYER_IDS = ['spc-base-fill', 'spc-base-line', 'spc-cig-fill', 'spc-cig-line'];
export const SPC_GEOJSON_CACHE = new Map();
export const NOAA_OUTLOOK_EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };
export const NOAA_OUTLOOK_LAYER_IDS = [...SPC_LAYER_IDS, 'noaa-outlooks-fill', 'noaa-outlooks-line'];
export const NOAA_OUTLOOK_DATA_CACHE = new Map();
export const NOAA_OUTLOOK_META_CACHE = new Map();
export const NOAA_OUTLOOK_LOAD_TOKENS = new Map();
export const NOAA_OUTLOOK_PREFETCH_QUEUE = [];
export const NOAA_OUTLOOK_PREFETCH_PENDING = new Set();
export const NOAA_OUTLOOK_PREFETCH_CONCURRENCY = 3;
export const NOAA_OUTLOOK_FILL_OPACITY_MAX = 0.26;
export const SPC_FIRE_OUTLOOK_SERVICE = 'https://mapservices.weather.noaa.gov/vector/rest/services/fire_weather/SPC_firewx/MapServer';
export const WPC_QPF_SERVICE = 'https://mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_qpf/MapServer';
export const WPC_EXCESSIVE_RAIN_SERVICE = 'https://mapservices.weather.noaa.gov/vector/rest/services/hazards/wpc_precip_hazards/MapServer';
export const WPC_WINTER_PROB_SERVICE = 'https://mapservices.weather.noaa.gov/vector/rest/services/precip/wpc_prob_winter_precip/MapServer';
export const WPC_WSO_SERVICE = 'https://mapservices.weather.noaa.gov/experimental/rest/services/wpc_winter_storm_outlook/MapServer';
export const WPC_WSSI_SERVICE = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/wpc_wssi/MapServer';
export const CPC_610_SERVICE = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_6_10_day_outlk/MapServer';
export const CPC_814_SERVICE = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_8_14_day_outlk/MapServer';
export const CPC_DROUGHT_SERVICE = 'https://mapservices.weather.noaa.gov/vector/rest/services/outlooks/cpc_drought_outlk/MapServer';
export const CPC_HAZARDS_SERVICE = 'https://mapservices.weather.noaa.gov/vector/rest/services/hazards/cpc_weather_hazards/MapServer';
export const CPC_WEEK34_PRECIP_KML_URL = 'https://ftp.cpc.ncep.noaa.gov/GIS/us_tempprcpfcst/wk34prcp_latest.kml';
export const CPC_WEEK34_TEMP_KML_URL = 'https://ftp.cpc.ncep.noaa.gov/GIS/us_tempprcpfcst/wk34temp_latest.kml';

export const NOAA_OUTLOOK_SECTIONS = {
  SPC: {
    label: 'SPC',
    tabs: {
      THUNDER: {
        label: 'Thunderstorm Outlook',
        columns: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7', 'Day 8'],
        rows: [
          { label: 'Categorical', cells: ['SPC:THUNDER:DAY1:CAT', 'SPC:THUNDER:DAY2:CAT', 'SPC:THUNDER:DAY3:CAT', null, null, null, null, null] },
          { label: 'Tornado', cells: ['SPC:THUNDER:DAY1:TORN', 'SPC:THUNDER:DAY2:TORN', null, null, null, null, null, null] },
          { label: 'Wind', cells: ['SPC:THUNDER:DAY1:WIND', 'SPC:THUNDER:DAY2:WIND', null, null, null, null, null, null] },
          { label: 'Hail', cells: ['SPC:THUNDER:DAY1:HAIL', 'SPC:THUNDER:DAY2:HAIL', null, null, null, null, null, null] },
          { label: 'Prob', cells: [null, null, 'SPC:THUNDER:DAY3:PROB', 'SPC:THUNDER:DAY4:PROB', 'SPC:THUNDER:DAY5:PROB', 'SPC:THUNDER:DAY6:PROB', 'SPC:THUNDER:DAY7:PROB', 'SPC:THUNDER:DAY8:PROB'] },
        ],
      },
      FIRE: {
        label: 'Fire Weather Outlook',
        columns: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5', 'Day 6', 'Day 7', 'Day 8'],
        rows: [
          { label: 'Outlook', cells: ['SPC:FIRE:DAY1', 'SPC:FIRE:DAY2', 'SPC:FIRE:DAY3', 'SPC:FIRE:DAY4', 'SPC:FIRE:DAY5', 'SPC:FIRE:DAY6', 'SPC:FIRE:DAY7', 'SPC:FIRE:DAY8'] },
        ],
      },
    },
  },
  WPC: {
    label: 'WPC',
    tabs: {
      QPF: {
        label: 'QPF',
        columns: ['Day 1', 'Day 2', 'Day 3', 'Day 4-5', 'Day 6-7'],
        rows: [
          { label: 'QPF', cells: ['WPC:QPF:DAY1', 'WPC:QPF:DAY2', 'WPC:QPF:DAY3', 'WPC:QPF:DAY45', 'WPC:QPF:DAY67'] },
        ],
      },
      EXCESSIVE_RAIN: {
        label: 'Excessive Rain',
        columns: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Day 5'],
        rows: [
          { label: 'Risk', cells: ['WPC:ERO:DAY1', 'WPC:ERO:DAY2', 'WPC:ERO:DAY3', 'WPC:ERO:DAY4', 'WPC:ERO:DAY5'] },
        ],
      },
      WINTER_FORECASTS: {
        label: 'Winter Forecasts',
        columns: ['Day 1', 'Day 2', 'Day 3'],
        rows: [
          { label: 'Snow / Ice', cells: ['WPC:WINT_FORECAST:DAY1', 'WPC:WINT_FORECAST:DAY2', 'WPC:WINT_FORECAST:DAY3'] },
        ],
      },
      WINTER_PROBABILITIES: {
        label: 'Winter Probabilities',
        columns: ['Day 1', 'Day 2', 'Day 3'],
        rows: [
          { label: '4\" Snow', cells: ['WPC:WPROB:DAY1_4IN', 'WPC:WPROB:DAY2_4IN', 'WPC:WPROB:DAY3_4IN'] },
          { label: '8\" Snow', cells: ['WPC:WPROB:DAY1_8IN', 'WPC:WPROB:DAY2_8IN', 'WPC:WPROB:DAY3_8IN'] },
          { label: '12\" Snow', cells: ['WPC:WPROB:DAY1_12IN', 'WPC:WPROB:DAY2_12IN', 'WPC:WPROB:DAY3_12IN'] },
          { label: '0.25\" Ice', cells: ['WPC:WPROB:DAY1_ICE', 'WPC:WPROB:DAY2_ICE', 'WPC:WPROB:DAY3_ICE'] },
        ],
      },
      WSO: {
        label: 'Winter Storm Outlook (WSO)',
        columns: ['Day 1', 'Day 2', 'Day 3', 'Day 4', 'Days 1-4'],
        rows: [
          { label: 'Snowfall', cells: ['WPC:WSO:SNOW:DAY1', 'WPC:WSO:SNOW:DAY2', 'WPC:WSO:SNOW:DAY3', 'WPC:WSO:SNOW:DAY4', 'WPC:WSO:SNOW:DAY14'] },
          { label: 'Freezing Rain', cells: ['WPC:WSO:ICE:DAY1', 'WPC:WSO:ICE:DAY2', 'WPC:WSO:ICE:DAY3', 'WPC:WSO:ICE:DAY4', 'WPC:WSO:ICE:DAY14'] },
        ],
      },
      WSSI: {
        label: 'Winter Storm Severity Index (WSSI)',
        columns: ['Day 1', 'Day 2', 'Day 3', 'Days 1-3'],
        rows: [
          { label: 'Overall Impact', cells: ['WPC:WSSI:DAY1', 'WPC:WSSI:DAY2', 'WPC:WSSI:DAY3', 'WPC:WSSI:DAY13'] },
        ],
      },
    },
  },
  CPC: {
    label: 'CPC',
    tabs: {
      PRECIPTEMP: {
        label: 'Precip/Temp Outlook',
        columns: ['Days 6-10', 'Days 8-14', 'Weeks 3-4'],
        rows: [
          { label: 'Precipitation', cells: ['CPC:PRECIPTEMP:PRECIP:610', 'CPC:PRECIPTEMP:PRECIP:814', 'CPC:PRECIPTEMP:PRECIP:34'] },
          { label: 'Temperature', cells: ['CPC:PRECIPTEMP:TEMP:610', 'CPC:PRECIPTEMP:TEMP:814', 'CPC:PRECIPTEMP:TEMP:34'] },
        ],
      },
      DROUGHT: {
        label: 'Drought Outlook',
        columns: ['Monthly', 'Seasonal'],
        rows: [
          { label: 'Outlook', cells: ['CPC:DROUGHT:MONTHLY', 'CPC:DROUGHT:SEASONAL'] },
        ],
      },
      HAZARDS: {
        label: 'Hazards',
        columns: ['3-7 Day', '8-14 Day'],
        rows: [
          { label: 'Temperature', cells: ['CPC:HAZARDS:TEMP:37', 'CPC:HAZARDS:TEMP:814'] },
          { label: 'Precipitation', cells: ['CPC:HAZARDS:PRECIP:37', 'CPC:HAZARDS:PRECIP:814'] },
          { label: 'Wildfire / Drought', cells: ['CPC:HAZARDS:FIRE:37', 'CPC:HAZARDS:FIRE:814'] },
        ],
      },
      GLOBAL_TROPICS: {
        label: 'Global Tropics Hazards',
        columns: ['Week 2', 'Week 3'],
        rows: [
          { label: 'Tropical Cyclone', cells: ['CPC:GLOBAL:TC:W2', 'CPC:GLOBAL:TC:W3'] },
          { label: 'Wet', cells: ['CPC:GLOBAL:WET:W2', 'CPC:GLOBAL:WET:W3'] },
          { label: 'Dry', cells: ['CPC:GLOBAL:DRY:W2', 'CPC:GLOBAL:DRY:W3'] },
          { label: 'Warm', cells: ['CPC:GLOBAL:WARM:W2', 'CPC:GLOBAL:WARM:W3'] },
          { label: 'Cold', cells: ['CPC:GLOBAL:COLD:W2', 'CPC:GLOBAL:COLD:W3'] },
        ],
      },
    },
  },
};

export const NOAA_OUTLOOK_PRODUCTS = (() => {
  const out = {};
  const add = (id, entry) => { out[id] = { id, ...entry }; };
  const fireLayers = { DAY1: 1, DAY2: 4, DAY3: 8, DAY4: 11, DAY5: 14, DAY6: 17, DAY7: 20, DAY8: 23 };
  const qpfLayers = { DAY1: 1, DAY2: 2, DAY3: 3, DAY45: 4, DAY67: 5 };
  const eroLayers = { DAY1: 0, DAY2: 1, DAY3: 2, DAY4: 3, DAY5: 4 };
  const winterForecastLayers = {
    DAY1: [1, 4],
    DAY2: [6, 9],
    DAY3: [11, 14],
  };
  const winterProbLayers = {
    DAY1_4IN: 1, DAY1_8IN: 2, DAY1_12IN: 3, DAY1_ICE: 4,
    DAY2_4IN: 6, DAY2_8IN: 7, DAY2_12IN: 8, DAY2_ICE: 9,
    DAY3_4IN: 11, DAY3_8IN: 12, DAY3_12IN: 13, DAY3_ICE: 14,
  };
  const wsoLayers = {
    'SNOW:DAY1': 1, 'SNOW:DAY2': 2, 'SNOW:DAY3': 3, 'SNOW:DAY4': 4, 'SNOW:DAY14': 5,
    'ICE:DAY1': 7, 'ICE:DAY2': 8, 'ICE:DAY3': 9, 'ICE:DAY4': 10, 'ICE:DAY14': 11,
  };
  const wssiLayers = { DAY1: 1, DAY2: 2, DAY3: 3, DAY13: 4 };
  Object.keys(SPC_OUTLOOK_SOURCES).forEach(day => {
    Object.keys(SPC_OUTLOOK_SOURCES[day]).forEach(type => {
      add(`SPC:THUNDER:${day}:${type}`, {
        kind: 'spc-thunder',
        day,
        type,
        title: `SPC ${day.replace('DAY', 'Day ')} ${type === 'CAT' ? 'Categorical' : type === 'PROB' ? 'Probabilistic' : `${type[0]}${type.slice(1).toLowerCase()}`} Outlook`,
      });
    });
  });
  Object.entries(fireLayers).forEach(([day, layer]) => add(`SPC:FIRE:${day}`, {
    kind: 'arcgis',
    service: SPC_FIRE_OUTLOOK_SERVICE,
    layer,
    title: `SPC Fire Weather ${day.replace('DAY', 'Day ')} Outlook`,
  }));
  Object.entries(qpfLayers).forEach(([span, layer]) => add(`WPC:QPF:${span}`, {
    kind: 'arcgis',
    service: WPC_QPF_SERVICE,
    layer,
    title: `WPC QPF ${span.replace('DAY', 'Day ').replace('45', '4-5').replace('67', '6-7')}`,
  }));
  Object.entries(eroLayers).forEach(([day, layer]) => add(`WPC:ERO:${day}`, {
    kind: 'arcgis',
    service: WPC_EXCESSIVE_RAIN_SERVICE,
    layer,
    title: `WPC Excessive Rain ${day.replace('DAY', 'Day ')}`,
  }));
  Object.entries(winterForecastLayers).forEach(([day, layer]) => add(`WPC:WINT_FORECAST:${day}`, {
    kind: 'arcgis',
    service: WPC_WINTER_PROB_SERVICE,
    layers: Array.isArray(layer) ? layer : [layer],
    title: `WPC Winter Forecast ${day.replace('DAY', 'Day ')}`,
  }));
  Object.entries(winterProbLayers).forEach(([key, layer]) => add(`WPC:WPROB:${key}`, {
    kind: 'arcgis',
    service: WPC_WINTER_PROB_SERVICE,
    layer,
    title: `WPC Winter Probability ${key.replaceAll('_', ' ')}`,
  }));
  Object.entries(wsoLayers).forEach(([key, layer]) => add(`WPC:WSO:${key.replace(':', ':')}`, {
    kind: 'arcgis',
    service: WPC_WSO_SERVICE,
    layer,
    title: `WPC WSO ${key.replace(':', ' ')}`,
  }));
  Object.entries(wssiLayers).forEach(([key, layer]) => add(`WPC:WSSI:${key}`, {
    kind: 'arcgis',
    service: WPC_WSSI_SERVICE,
    layer,
    title: `WPC WSSI ${key}`,
  }));
  add('CPC:PRECIPTEMP:PRECIP:610', { kind: 'arcgis', service: CPC_610_SERVICE, layer: 1, title: 'CPC 6-10 Day Precipitation Outlook' });
  add('CPC:PRECIPTEMP:TEMP:610', { kind: 'arcgis', service: CPC_610_SERVICE, layer: 0, title: 'CPC 6-10 Day Temperature Outlook' });
  add('CPC:PRECIPTEMP:PRECIP:814', { kind: 'arcgis', service: CPC_814_SERVICE, layer: 1, title: 'CPC 8-14 Day Precipitation Outlook' });
  add('CPC:PRECIPTEMP:TEMP:814', { kind: 'arcgis', service: CPC_814_SERVICE, layer: 0, title: 'CPC 8-14 Day Temperature Outlook' });
  add('CPC:PRECIPTEMP:PRECIP:34', { kind: 'kml', url: CPC_WEEK34_PRECIP_KML_URL, title: 'CPC Weeks 3-4 Precipitation Outlook' });
  add('CPC:PRECIPTEMP:TEMP:34', { kind: 'kml', url: CPC_WEEK34_TEMP_KML_URL, title: 'CPC Weeks 3-4 Temperature Outlook' });
  add('CPC:DROUGHT:MONTHLY', { kind: 'arcgis', service: CPC_DROUGHT_SERVICE, layer: 1, title: 'CPC Monthly Drought Outlook' });
  add('CPC:DROUGHT:SEASONAL', { kind: 'arcgis', service: CPC_DROUGHT_SERVICE, layer: 4, title: 'CPC Seasonal Drought Outlook' });
  add('CPC:HAZARDS:TEMP:37', { kind: 'arcgis', service: CPC_HAZARDS_SERVICE, layer: 1, title: 'CPC 3-7 Day Temperature Hazards' });
  add('CPC:HAZARDS:TEMP:814', { kind: 'arcgis', service: CPC_HAZARDS_SERVICE, layer: 3, title: 'CPC 8-14 Day Temperature Hazards' });
  add('CPC:HAZARDS:PRECIP:37', { kind: 'arcgis', service: CPC_HAZARDS_SERVICE, layer: 4, title: 'CPC 3-7 Day Precipitation Hazards' });
  add('CPC:HAZARDS:PRECIP:814', { kind: 'arcgis', service: CPC_HAZARDS_SERVICE, layer: 6, title: 'CPC 8-14 Day Precipitation Hazards' });
  add('CPC:HAZARDS:FIRE:37', { kind: 'arcgis', service: CPC_HAZARDS_SERVICE, layer: 7, title: 'CPC 3-7 Day Wildfire / Drought Hazards' });
  add('CPC:HAZARDS:FIRE:814', { kind: 'arcgis', service: CPC_HAZARDS_SERVICE, layer: 8, title: 'CPC 8-14 Day Wildfire / Drought Hazards' });
  ['TC', 'WET', 'DRY', 'WARM', 'COLD'].forEach(kind => {
    ['W2', 'W3'].forEach(week => {
      add(`CPC:GLOBAL:${kind}:${week}`, {
        kind: 'kml',
        url: `https://www.cpc.ncep.noaa.gov/products/precip/CWlink/ghaz/kmzs/${week}_${kind}.kml`,
        title: `CPC Global Tropics ${kind} ${week.replace('W', 'Week ')}`,
      });
    });
  });
  return out;
})();

export const MESO_DISCUSSION_URL = 'https://mesoscalediscussionserver.colewx.workers.dev/';
export const SPC_MESO_INDEX_URL = 'https://www.spc.noaa.gov/products/md/';
export const MESO_EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };
export const MESO_LAYER_IDS = ['meso-discussions-line-under', 'meso-discussions-line'];
export const MESO_KIND_IDS = ['precip', 'convective', 'winter'];
export const SPC_WATCHES_URL = 'https://mesonet.agron.iastate.edu/json/spcwatch.py';
export const WATCHES_EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };
export const WATCH_LAYER_IDS = ['spc-watch-hit', 'spc-watch-line-under', 'spc-watch-line'];
export const NEXRAD_ATTR_TVS_URL = 'https://mesonet.agron.iastate.edu/geojson/nexrad_attr.geojson';
export const TVS_EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };
export const TVS_LAYER_IDS = ['tvs-icons-symbol'];
export const LIGHTNING_EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };
export const LIGHTNING_LAYER_IDS = ['lightning-cluster-symbol', 'lightning-symbol'];
export const LIGHTNING_ICON_ID = 'lightning-bolt-symbol';
export const LIGHTNING_POLL_MS = 20_000;
export const LIGHTNING_WINDOW_MS = 5 * 60 * 1000;
export const TVS_ICON_BY_BUCKET = {
  GREEN: 'tvs-tri-green',
  YELLOW: 'tvs-tri-yellow',
  ORANGE: 'tvs-tri-orange',
  RED: 'tvs-tri-red',
  PINK: 'tvs-tri-pink',
};
export const TVS_ICON_COLORS = {
  GREEN: '#00d83f',
  YELLOW: '#ffd400',
  ORANGE: '#ff8c1a',
  RED: '#ff2a2a',
  PINK: '#ff4db8',
};

export const STORM_REPORT_SOURCE_OPTIONS = [
  { id: 'LSR', label: 'Local Storm Reports' },
  { id: 'SPOTTER', label: 'Spotter Network' },
];

export const STORM_REPORT_LSR_WINDOWS = [
  {
    id: '30m',
    label: '30m',
    minutes: 30,
  },
  {
    id: '1',
    label: '1h',
    minutes: 60,
  },
  {
    id: '2',
    label: '2h',
    minutes: 120,
  },
  {
    id: '4',
    label: '4h',
    minutes: 240,
  },
  {
    id: '24',
    label: '24h',
    minutes: 1440,
  },
  {
    id: '48',
    label: '48h',
    minutes: 2880,
  },
  {
    id: '72',
    label: '72h',
    minutes: 4320,
  },
];

export const STORM_REPORT_LSR_URL = 'https://data2.weatherwise.app/weather-reports/NWS-LSR/reports-259200.geojson';
export const SPOTTER_REPORTS_URL = 'https://data2.weatherwise.app/weather-reports/SPOTTER-NETWORK/reports-259200.geojson';
export const STORM_REPORT_POLL_MS = 60_000;

export const STORM_REPORT_CATEGORY_OPTIONS = [
  { id: 'FLOOD', label: 'Rain/Flood' },
  { id: 'WINTER', label: 'Snow' },
  { id: 'ICE', label: 'Ice' },
  { id: 'HAIL', label: 'Hail' },
  { id: 'WIND', label: 'Wind' },
  { id: 'TSTM', label: 'T-Storm' },
  { id: 'MARINE', label: 'Marine' },
  { id: 'TORNADO', label: 'Tornado' },
  { id: 'FIRE', label: 'Fire' },
  { id: 'FOG', label: 'Fog' },
  { id: 'OTHER', label: 'Other' },
];

export const STORM_REPORT_CATEGORY_COLORS = {
  FLOOD: '#72D62B',
  WINTER: '#7FB0EB',
  ICE: '#DDA0DD',
  HAIL: '#EA60C6',
  WIND: '#F7B51A',
  TSTM: '#E3A727',
  MARINE: '#E4B6CB',
  TORNADO: '#FF3030',
  FIRE: '#FF9F43',
  FOG: '#A9ADB7',
  OTHER: '#8F949E',
};

export const STORM_REPORT_CATEGORY_IDS = STORM_REPORT_CATEGORY_OPTIONS.map(opt => opt.id);
export const STORM_REPORT_CATEGORY_ID_SET = new Set(STORM_REPORT_CATEGORY_IDS);
export const STORM_REPORT_LAYER_IDS = ['storm-reports-dot'];
export const STORM_EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };
export const STORM_REPORT_CACHE_MS = 55_000;

export const MPING_URL = 'https://mping.ou.edu/mping/api/v2/reports.geojson';
export const MPING_SOURCE_ID = 'mping-reports-src';
export const MPING_LAYER_ID = 'mping-reports-dot';
export const MPING_EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };
export const MPING_POLL_MS = 300_000;
export const MPING_CACHE_MS = 270_000;

export const METARS_URL = 'https://aviationweather-metar-worker.c1483952.workers.dev/metars/all.geojson';
export const METAR_SOURCE_ID = 'metars-src';
export const METAR_DOT_LAYER_ID = 'metars-dot';
export const METAR_LAYER_IDS = [METAR_DOT_LAYER_ID];
export const METAR_EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };
export const METAR_POLL_MS = 300_000;
export const METAR_CACHE_MS = 240_000;
export const METAR_FLIGHT_CATEGORY_COLORS = Object.freeze({
  VFR: '#4BE06A',
  MVFR: '#4D8BFF',
  IFR: '#FF5A5A',
  LIFR: '#C657FF',
});

export const SPOTTER_LOCATIONS_URL = 'https://spotternetworkpositions.cole173616.workers.dev/';
export const SPOTTER_LOCATIONS_SOURCE_ID = 'spotter-locations-src';
export const SPOTTER_LOCATIONS_LAYER_ID = 'spotter-locations-dot';
export const SPOTTER_LOCATIONS_EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };
export const SPOTTER_LOCATIONS_POLL_MS = 120_000;
export const SPOTTER_LOCATIONS_CACHE_MS = 90_000;

export const ALERT_LAYER_IDS = ['alerts-fill', 'alerts-line-under', 'alerts-fill-hit', 'alerts-line', 'alerts-point'];
export const ALERT_POPUP_LAYER_IDS = ['alerts-point', 'alerts-line', 'alerts-fill-hit'];
export const ALERTS_EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };
export const ALERT_EVENT_COLOR_MAP = {
  SVR: '#FFE600',
  SVRC: '#FFE600',
  SVRD: '#FFE600',
  SVRE: '#FF8000',
  TOR: '#FF2D2D',
  TORR: '#FF46FF',
  TORP: '#C010FF',
  TORE: '#FF00FF',
  FFW: '#35C759',
  FLW: '#2FBF71',
  TOW: '#7A0000',
  TOWP: '#FF4DFF',
  SVW: '#FFE600',
  SVWP: '#C7A600',
  // Winter warnings
  WSW: '#6495ED',
  BLW: '#5B8DD9',
  ISW: '#8B7FD4',
  SNQ: '#C0C0FF',
  WCW: '#B0C4DE',
  LESW: '#87CEEB',
  FFZ: '#6495ED',
  HFZ: '#4169E1',
  FZW: '#4682B4',
  // Winter watches/advisories
  WSWA: '#4682B4',
  ISWA: '#708090',
  LESWA: '#87CEEB',
  WWA: '#7B96C8',
  FRA: '#8B9BCB',
  WCVA: '#B0C4DE',
  LESA: '#B0D4E8',
  // Special event / other
  DFA: '#708090',
  HWW: '#DAA520',
  WNDADV: '#D2B48C',
  SPS: '#FFE680',
  HWO: '#E0E080',
  // Legacy event-name keys
  'Tornado Warning': '#FF2D2D',
  'Severe Thunderstorm Warning': '#FFE600',
  'Flash Flood Warning': '#35C759',
  'Flood Warning': '#2FBF71',
  'Tornado Watch': '#7A0000',
  'Severe Thunderstorm Watch': '#FFE600',
};
export const WARNING_SOUND_OPTIONS = Object.freeze([
  { id: 'silent', label: 'NONE', fileName: '', volume: 0 },
  { id: 'confirmed-tornado-issued', label: 'Confirmed Tornado Issued', fileName: 'confirmed-tornado-issued.mp3', volume: 0.62 },
  { id: 'beep-sfx', label: 'Beep SFX', fileName: 'beep-sfx.mp3', volume: 0.54 },
  { id: 'flash-flood-issued', label: 'Flash Flood Issued', fileName: 'flash-flood-issued.mp3', volume: 0.62 },
  { id: 'iphone-eas', label: 'iPhone EAS', fileName: 'iphone-eas.mp3', volume: 0.56 },
  { id: 'maxvelocitybeep', label: 'Max Velocity Beep', fileName: 'maxvelocitybeep.mp3', volume: 0.56 },
  { id: 'pds-tornado-issued', label: 'PDS Tornado Issued', fileName: 'pds-tornado-issued.mp3', volume: 0.64 },
  { id: 'radar-tornado-issued', label: 'Radar Tornado Issued', fileName: 'radar-tornado-issued.mp3', volume: 0.64 },
  { id: 'severe-destructive-issued', label: 'Severe Destructive Issued', fileName: 'severe-destructive-issued.mp3', volume: 0.62 },
  { id: 'severe-considerable-issued', label: 'Severe Considerable Issued', fileName: 'severe-considerable-issued.mp3', volume: 0.60 },
  { id: 'severe-eds-issued', label: 'Severe EDS Issued', fileName: 'severe-eds-issued.mp3', volume: 0.60 },
  { id: 'severe-issued', label: 'Severe Issued', fileName: 'severe-issued.mp3', volume: 0.58 },
  { id: 'severe-updated', label: 'Severe Updated', fileName: 'severe-updated.mp3', volume: 0.58 },
  { id: 'siren-eas', label: 'Siren EAS', fileName: 'siren-eas.mp3', volume: 0.54 },
]);
export const WARNING_SOUND_ID_SET = new Set(WARNING_SOUND_OPTIONS.map(option => option.id));
export const WARNING_SOUND_OPTION_MAP = new Map(WARNING_SOUND_OPTIONS.map(option => [option.id, option]));
export const WARNING_PREF_CONFIG = Object.freeze([
  { id: 'TORE', label: 'Tornado Emergency' },
  { id: 'TORP', label: 'PDS Tornado Warning' },
  { id: 'TORR', label: 'Confirmed Tornado Warning' },
  { id: 'TOR', label: 'Tornado Warning' },
  { id: 'SVRE', label: 'EDS Severe Thunderstorm Warning' },
  { id: 'SVRD', label: 'Destructive Severe Thunderstorm Warning' },
  { id: 'SVRC', label: 'Considerable Severe Thunderstorm Warning' },
  { id: 'SVR', label: 'Severe Thunderstorm Warning' },
  { id: 'FFW', label: 'Flash Flood Warning' },
  { id: 'FLW', label: 'Flood Warning' },
  { id: 'TOWP', label: 'PDS Tornado Watch' },
  { id: 'TOW', label: 'Tornado Watch' },
  { id: 'SVWP', label: 'PDS Severe Thunderstorm Watch' },
  { id: 'SVW', label: 'Severe Thunderstorm Watch' },
  // Winter warnings
  { id: 'BLW', label: 'Blizzard Warning' },
  { id: 'WSW', label: 'Winter Storm Warning' },
  { id: 'ISW', label: 'Ice Storm Warning' },
  { id: 'SNQ', label: 'Snow Squall Warning' },
  { id: 'WCW', label: 'Wind Chill Warning' },
  { id: 'LESW', label: 'Lake Effect Snow Warning' },
  { id: 'FFZ', label: 'Frost/Freeze Warning' },
  { id: 'HFZ', label: 'Hard Freeze Warning' },
  { id: 'FZW', label: 'Freeze Warning' },
  // Winter watches
  { id: 'WSWA', label: 'Winter Storm Watch' },
  { id: 'ISWA', label: 'Ice Storm Watch' },
  { id: 'LESWA', label: 'Lake Effect Snow Watch' },
  // Winter advisories
  { id: 'WWA', label: 'Winter Weather Advisory' },
  { id: 'FRA', label: 'Freezing Rain Advisory' },
  { id: 'WCVA', label: 'Wind Chill Advisory' },
  { id: 'LESA', label: 'Lake Effect Snow Advisory' },
  // Special event / other
  { id: 'HWW', label: 'High Wind Warning' },
  { id: 'WNDADV', label: 'Wind Advisory' },
  { id: 'DFA', label: 'Dense Fog Advisory' },
  { id: 'SPS', label: 'Special Weather Statement' },
  { id: 'HWO', label: 'Hazardous Weather Outlook' },
]);
export const WARNING_PREF_ID_SET = new Set(WARNING_PREF_CONFIG.map(item => item.id));
export const _WARNING_ONLY_IDS = new Set(['TORE','TORP','TORR','TOR','SVRE','SVRD','SVRC','SVR','FFW','FLW','BLW','WSW','ISW','SNQ','WCW','LESW','FFZ','HFZ','FZW','HWW']);
export const ALERT_FALLBACK_COLOR = '#E6E6E6';
export const ALERT_DEFAULT_KEEP_MS = 6 * 60 * 60 * 1000;
export const WARNING_NOTIFY_STARTUP_QUIET_MS = 10_000;
export const WARNING_TOAST_LIFETIME_MS = 12_000;
export const WARNING_TOAST_LIMIT = 4;
export const WARNING_SOUND_COOLDOWN_MS = 2500;
export const WARNING_GLOBAL_VOLUME_DEFAULT = 100;
export const ALERT_SOURCE_NWS_API = 'NWS_API';
export const ALERT_SOURCE_NWS_BOOTSTRAP = 'NWS_BOOTSTRAP';
export const ALERT_SOURCE_NWWS = 'NWWS';
export const ALERT_SOURCE_TEST = 'TEST';
export const NWS_API_ALERTS_URL = 'https://api.weather.gov/alerts/active';
export const NWS_API_POLL_MS = 60_000;
export const ALERT_BOOTSTRAP_GRACE_MS = 30_000;
