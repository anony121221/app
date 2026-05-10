export const MAPBOX_TOKEN = '';
export const MAPBOX_TOKEN_MAX_VELOCITY = '';
export const S3           = 'https://unidata-nexrad-level3.s3.amazonaws.com';
export const POLL_MS      = 5000;
export const L2_POLL_MS   = 10000;
export const PROCESSED_WISE_POLL_MS = 1000;
export const L3_FAMILIES  = ['REF', 'VEL', 'SRV', 'CC', 'ZDR', 'SW', 'EET', 'PRT', 'DTA'];
export const L3_TILTS     = ['0.5', '1.5', '2.4', '3.1'];
export const REMOTE_HYBRID_L2_PRODUCTS = ['CC', 'ZDR'];
export const HYBRID_L2_FAMILIES = new Set(REMOTE_HYBRID_L2_PRODUCTS);
export const PROCESSED_WISE_BASE_URL = 'https://data2.weatherwise.app/radar/processed';
export const PROCESSED_WISE_FAMILIES = Object.freeze(['REF', 'VEL', 'SRV', 'CC', 'ZDR', 'SW', 'EET', 'PRT', 'DTA', 'KDP']);
export const PROCESSED_WISE_FAMILY_SET = new Set(PROCESSED_WISE_FAMILIES);
// Products that only use a single tilt (tilt index always 0 in folder name)
export const PROCESSED_WISE_SINGLE_TILT_FAMILIES = new Set(['EET', 'PRT', 'DTA']);
export const PROCESSED_WISE_TILTS = Object.freeze(['0.5', '0.9', '1.3', '1.8', '2.5', '3.1']);
export const PROCESSED_WISE_TILT_TO_INDEX = Object.freeze({
  '0.5': 0,
  '0.9': 1,
  '1.3': 2,
  '1.8': 3,
  '2.5': 4,
  '3.1': 5,
});
export const PROCESSED_WISE_SINGLE_TILT = Object.freeze(['0.5']);
export const PROCESSED_WISE_FAMILY_TILTS = Object.freeze({
  REF: PROCESSED_WISE_TILTS,
  VEL: PROCESSED_WISE_TILTS,
  SRV: PROCESSED_WISE_TILTS,
  CC: PROCESSED_WISE_TILTS,
  ZDR: PROCESSED_WISE_TILTS,
  SW: PROCESSED_WISE_TILTS,
  EET: PROCESSED_WISE_SINGLE_TILT,
  PRT: PROCESSED_WISE_SINGLE_TILT,
  DTA: PROCESSED_WISE_SINGLE_TILT,
  KDP: PROCESSED_WISE_TILTS,
});

// TDWR (Terminal Doppler Weather Radar) uses different folder names
export const TDWR_WISE_FAMILIES = Object.freeze(['REF', 'VEL', 'PRT']);
export const TDWR_WISE_FAMILY_SET = new Set(TDWR_WISE_FAMILIES);
export const TDWR_WISE_SINGLE_TILT = Object.freeze(['0.5']);
export const TDWR_WISE_FAMILY_TILTS = Object.freeze({
  REF: TDWR_WISE_SINGLE_TILT,
  VEL: TDWR_WISE_SINGLE_TILT,
  PRT: TDWR_WISE_SINGLE_TILT,
});
// TDWR folder name mapping: family -> folder name (no tilt index)
export const TDWR_WISE_FOLDER_MAP = Object.freeze({
  REF: 'TZ0',      // Base reflectivity (0.5 degree)
  VEL: 'TV0',      // Base velocity (0.5 degree)
  PRT: 'PRT0',     // Precipitation type
  // Long range reflectivity is a separate product
  'REF-LR': 'TZL', // Long range reflectivity
});
export const ALL_TILT_VALUES = Object.freeze([...new Set([...PROCESSED_WISE_TILTS, ...L3_TILTS])]);
export const WISE_MAGIC = 'WISE';
export const WISE_FIXED_HEADER_SIZE = 68;
export const WISE_CACHE_TTL_MS = 1000;
export const WISE_MAX_RENDER_GATES = 750000;
export const RADAR_PERF_DEBUG = false;
export const RADAR_PRELOAD_MODE = 'raw-only'; // off | raw-only | decode-visible | decode-all
export const RADAR_RENDER_MODE = 'gate-geometry'; // gate-geometry | texture-bins-experimental
export const FRAME_CACHE_BYTES_BASE = 450 * 1024 * 1024;
export const FRAME_CACHE_BYTES_TIMELINE = 900 * 1024 * 1024;
export const WISE_PROBE_LOOKBACK_MINUTES = 12;
export const WISE_PROBE_AHEAD_MINUTES = 1;
export const WISE_PROBE_TIMEOUT_MS = 100;
export const WISE_NOT_FOUND_COOLDOWN_MS = 5000;
export const WISE_MAX_PROBE_CANDIDATES = 3;
export const ACTIVE_WISE_PROBE_MS = 100;
export const WISE_PREFETCH_CACHE_MAX = 24;
export const WISE_GEOMETRY_CACHE_MAX = 6;
export const RECENT_WISE_FRAME_COUNT = 12;
export const RECENT_WISE_FRAME_OPTIONS = Object.freeze([6, 12, 24, 50]);
export const MAX_RECENT_WISE_FRAME_COUNT = RECENT_WISE_FRAME_OPTIONS[RECENT_WISE_FRAME_OPTIONS.length - 1];
export const RECENT_WISE_PRIORITY_WINDOW = 8;
export const DRAW_MAX_WIDTH = 30;
export const DRAW_DEFAULT_COLOR = '#1d6ef5';
export const DRAW_DEFAULT_THICKNESS = 4;
export const DRAW_DEFAULT_STYLE = 'solid';
export const DRAW_DEFAULT_OPACITY = 0.92;
export const WISE_MULTI_TYPE_RANGE_MIN = -30.0;
export const WISE_MULTI_TYPE_RANGE_MAX = 90.0;
export const WISE_MULTI_TYPE_RANGE_SPAN = WISE_MULTI_TYPE_RANGE_MAX - WISE_MULTI_TYPE_RANGE_MIN;
export const WISE_PRT_SECTION_ORDER = Object.freeze(['RAIN', 'SNOW', 'SLEET', 'FRZR']);
export const WISE_PRT_SECTION_LABELS = Object.freeze({
  RAIN: 'Rain',
  SNOW: 'Snow',
  SLEET: 'Sleet',
  FRZR: 'Freezing Rain',
});
export const RADAR_SITE_OFFLINE_COLOR = '#ff3030';
export const RADAR_SITE_STATUS_URL = 'https://api.weather.gov/radar/stations';
export const RADAR_SITE_STATUS_REFRESH_MS = 5 * 60 * 1000;
export const RADAR_SITE_STALE_MS = 20 * 60 * 1000;
export const WEATHERWISE_RELAY_PRECONNECT_URL = 'https://relay2.weatherwise.app/preconnect';
export const WEATHERWISE_RELAY_SOCKET_HTTP_URL = 'https://relay2.weatherwise.app/ws/socket.io/';
export const WEATHERWISE_RELAY_SOCKET_WS_URL = 'wss://relay2.weatherwise.app/ws/socket.io/';
export const WEATHERWISE_RELAY_RECONNECT_MS = 3000;
export const WEATHERWISE_RELAY_CONNECT_TIMEOUT_MS = 10000;
export const WEATHERWISE_RELAY_ENABLED = true;
export const EARTH_RADIUS_M = 6_371_000.0;
export const MAX_MERCATOR_LAT = 85.05112878;
export const MAP_AMERICAS_MAX_BOUNDS = [[-172, -60], [-18, 84]];
export const MAP_STYLE_BLACK = 'custom://black';
export const MAP_STYLE_DARK = 'mapbox://styles/mapbox/dark-v11';
export const MAP_STYLE_GREY = 'mapbox://styles/tuftsweather/cmnr19sq6003k01qt8u28bt6g';
export const LEGACY_MAP_STYLE_LIGHT_GRAY = 'mapbox://styles/mapbox/light-v11';
export const MAP_STYLE_LIGHT_GRAY = 'mapbox://styles/jamespettus1/cm95unnm000b801qu4ocaho1g';
export const MAP_STYLE_MAX_VELOCITY = 'mapbox://styles/maxvelocity/cmlr940qf004c01qk3t62gir4';
export const DEFAULT_MAP_STYLE = MAP_STYLE_DARK;
export const MAP_STYLE_OPTIONS = [
  { id: MAP_STYLE_DARK, label: 'Dark' },
  { id: MAP_STYLE_GREY, label: 'Grey' },
  { id: MAP_STYLE_LIGHT_GRAY, label: 'Light Gray' },
  { id: MAP_STYLE_MAX_VELOCITY, label: 'Max Velocity' },
];
export const MAP_STYLE_IDS = new Set(MAP_STYLE_OPTIONS.map(opt => opt.id));
export const LOCAL_FILE_STATION_ID = '__LOCAL_FILE__';
export const LOCAL_L2_PRODUCTS = ['REF', 'VEL', 'CC', 'ZDR', 'PHI', 'SW', 'PTDS'];

export const APP_UPDATE_AUTO_CHECK_DELAY_MS = 4500;
export const APP_UPDATE_RETRY_DELAY_MS = 20000;
