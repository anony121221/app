"""
Radar-app refactor build script.

Reads src/radar.js and produces:
  src/main.js                   — what remains after extraction (with ES module imports)
  src/radar/radar-layer.js      — Phase 2: WebGL helpers + RadarGateLayer class
  src/radar/color-tables.js     — Phase 3: palette data + pure color-table functions
  src/radar/wise-decode.js      — Phase 4: pure binary decode + geometry helpers
  src/overlays/constants.js      — Phase 5: overlay/warning static config
"""

import os

SRC    = 'src/radar.js'
MAIN   = 'src/main.js'
RL_OUT = 'src/radar/radar-layer.js'
CT_OUT = 'src/radar/color-tables.js'
WD_OUT = 'src/radar/wise-decode.js'
OVL_OUT = 'src/overlays/constants.js'

# ---------------------------------------------------------------------------
# Lines to export-prefix inside the extracted modules.
# Key = 1-indexed radar.js line number, value = prefix to prepend.
# ---------------------------------------------------------------------------
EXPORT_PREFIX = {
    # radar-layer.js
    11229: 'export ',    # function buildShader
    11241: 'export ',    # function buildProgram
    11275: 'export ',    # class RadarGateLayer
    11615: 'export ',    # class SweepLayer
    # color-tables.js  (palette helpers)
    10532: 'export ',    # function _prepareInlinePalette
    10566: 'export ',    # function _writePreparedPaletteColor
    10606: 'export ',    # const WISE_PRT_PALETTE_SECTIONS
    10662: 'export ',    # function _prepareWisePrtPalette
    # color-tables.js  (CT data + functions)
    26780: 'export ',    # const CT_FAMILIES
    26781: 'export ',    # const EET_DEFAULT_PALETTE
    26806: 'export ',    # const CT_DEFAULT_PALETTES
    27066: 'export ',    # const CT_DEFAULT_GRADIENTS
    27085: 'export ',    # function ctStore
    27091: 'export ',    # function ctSave
    27095: 'export ',    # function ctGetActivePalette
    27101: 'export ',    # function ctGetDefaultPalette
    27105: 'export ',    # function ctGetEffectivePalette
    27109: 'export ',    # function getActivePalettes
    27128: 'export ',    # function getActiveDecodeOptions
    27134: 'export ',    # function parsePalFile
    27206: 'export ',    # function buildGradientStyle
    27222: 'export ',    # function _formatColorbarValue
    27229: 'export ',    # function _colorbarLabelsForPalette
    # wise-decode.js
    10439: 'export ',    # function parseRadarBinaryBlob
    10740: 'export ',    # function parseWiseContainer
    10904: 'export ',    # function _toMercatorPoint
    10913: 'export ',    # function _wiseGeometryCacheKey
    21476: 'export ',    # function _productsFromL2Mask
}

# ---------------------------------------------------------------------------
# Which module each extracted line range feeds into.
# Format: (start_line, end_line, target_file)  [inclusive, 1-indexed]
# ---------------------------------------------------------------------------
EXTRACTIONS = [
    # Phase 1 — originally done by hand, keep in skip list so main.js stays clean
    (2,     121,  None),   # config constants      → src/core/config.js
    (133,   145,  None),   # tauri + warmL3         → src/core/tauri.js
    (146,   210,  None),   # version utils          → src/core/utils.js
    (280,   465,  None),   # station tables         → src/radar/stations.js
    (681,   691,  None),   # enc / flatDate / flatDateTime → src/core/utils.js
    (708,   756,  None),   # parseKeys / parseNextContinuationToken / parseCommonPrefixes / parseKeyTimestampMs / id3

    # Phase 2 — WebGL render layer
    (11228, 11724, RL_OUT),  # buildShader/buildProgram/_rgProg*/RadarGateLayer/SweepLayer

    # Phase 3 — colour tables (two disjoint sections in radar.js)
    (10531, 10680, CT_OUT),  # _prepareInlinePalette … _prepareWisePrtPalette
    (26780, 27239, CT_OUT),  # CT_FAMILIES … _colorbarLabelsForPalette

    # Phase 4 — pure binary decode + geometry helpers (three disjoint sections)
    (10439, 10530, WD_OUT),  # parseRadarBinaryBlob
    (10681, 10924, WD_OUT),  # _wiseFieldNameForFamily … _wiseGeometryCacheKey
    (21476, 21480, WD_OUT),  # _productsFromL2Mask

    # Phase 5 — overlay/warning constants. Keep mutable noaaOutlookPrefetchActive in main.js
    # because main assigns to it during queue drain. Imported bindings are read-only.
    (852,  962,  OVL_OUT),
    (964,  1458, OVL_OUT),
]

# ---------------------------------------------------------------------------
# Module file headers (imports + any preamble)
# ---------------------------------------------------------------------------
CT_HEADER = """\
import {
  WISE_PRT_SECTION_ORDER, WISE_MULTI_TYPE_RANGE_SPAN,
} from '../core/config.js';

"""

WD_HEADER = """\
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

"""

OVL_HEADER = """\
// Shared overlay and warning constants extracted from radar.js.

"""

# ---------------------------------------------------------------------------
# main.js import block (injected after line 1)
# ---------------------------------------------------------------------------
MAIN_IMPORTS = """\
import {
  MAPBOX_TOKEN, MAPBOX_TOKEN_MAX_VELOCITY, S3, POLL_MS, L2_POLL_MS, PROCESSED_WISE_POLL_MS,
  L3_FAMILIES, L3_TILTS, REMOTE_HYBRID_L2_PRODUCTS, HYBRID_L2_FAMILIES,
  PROCESSED_WISE_BASE_URL, PROCESSED_WISE_FAMILIES, PROCESSED_WISE_FAMILY_SET,
  PROCESSED_WISE_SINGLE_TILT_FAMILIES, PROCESSED_WISE_TILTS, PROCESSED_WISE_TILT_TO_INDEX,
  PROCESSED_WISE_SINGLE_TILT, PROCESSED_WISE_FAMILY_TILTS,
  TDWR_WISE_FAMILIES, TDWR_WISE_FAMILY_SET, TDWR_WISE_SINGLE_TILT,
  TDWR_WISE_FAMILY_TILTS, TDWR_WISE_FOLDER_MAP,
  ALL_TILT_VALUES, WISE_MAGIC, WISE_FIXED_HEADER_SIZE, WISE_CACHE_TTL_MS,
  WISE_MAX_RENDER_GATES, WISE_PROBE_LOOKBACK_MINUTES, WISE_PROBE_AHEAD_MINUTES,
  WISE_PROBE_TIMEOUT_MS, WISE_NOT_FOUND_COOLDOWN_MS, WISE_MAX_PROBE_CANDIDATES,
  ACTIVE_WISE_PROBE_MS, WISE_PREFETCH_CACHE_MAX, WISE_GEOMETRY_CACHE_MAX,
  RECENT_WISE_FRAME_COUNT, RECENT_WISE_FRAME_OPTIONS, MAX_RECENT_WISE_FRAME_COUNT,
  RECENT_WISE_PRIORITY_WINDOW,
  DRAW_MAX_WIDTH, DRAW_DEFAULT_COLOR, DRAW_DEFAULT_THICKNESS, DRAW_DEFAULT_STYLE, DRAW_DEFAULT_OPACITY,
  WISE_MULTI_TYPE_RANGE_MIN, WISE_MULTI_TYPE_RANGE_MAX, WISE_MULTI_TYPE_RANGE_SPAN,
  WISE_PRT_SECTION_ORDER, WISE_PRT_SECTION_LABELS,
  RADAR_SITE_OFFLINE_COLOR, RADAR_SITE_STATUS_URL, RADAR_SITE_STATUS_REFRESH_MS, RADAR_SITE_STALE_MS,
  WEATHERWISE_RELAY_PRECONNECT_URL, WEATHERWISE_RELAY_SOCKET_HTTP_URL,
  WEATHERWISE_RELAY_SOCKET_WS_URL, WEATHERWISE_RELAY_RECONNECT_MS,
  WEATHERWISE_RELAY_CONNECT_TIMEOUT_MS, WEATHERWISE_RELAY_ENABLED,
  EARTH_RADIUS_M, MAX_MERCATOR_LAT, MAP_AMERICAS_MAX_BOUNDS,
  MAP_STYLE_BLACK, MAP_STYLE_DARK, MAP_STYLE_GREY, LEGACY_MAP_STYLE_LIGHT_GRAY,
  MAP_STYLE_LIGHT_GRAY, MAP_STYLE_MAX_VELOCITY, MAP_STYLE_SATELLITE,
  DEFAULT_MAP_STYLE, MAP_STYLE_OPTIONS, MAP_STYLE_IDS,
  LOCAL_FILE_STATION_ID, LOCAL_L2_PRODUCTS,
  APP_UPDATE_AUTO_CHECK_DELAY_MS, APP_UPDATE_RETRY_DELAY_MS,
} from './core/config.js';

import {
  STATIONS, HAWAII_STATIONS, TERMINAL_STATIONS,
  TERMINAL_STATION_IDS, HAWAII_STATION_IDS,
  STATION_SOURCE_OVERRIDES, STATION_ID_ALIASES, STATION_ID_DISPLAY,
  VIEWABLE_STATION_IDS, VIEWABLE_STATIONS,
  canonicalStationId, displayStationId, stationSource, stationKind,
  isTerminalStation, _stationSupportsProcessedWise, id3,
} from './radar/stations.js';

import {
  normalizeVersionLabel, parseVersionParts, comparePrereleaseParts,
  compareVersionLabels, pickReleaseDownloadUrl,
  enc, flatDate, flatDateTime,
  parseKeys, parseNextContinuationToken, parseCommonPrefixes, parseKeyTimestampMs,
} from './core/utils.js';

import { invoke, listen, warmL3TransportOnce } from './core/tauri.js';

import { buildShader, buildProgram, RadarGateLayer, SweepLayer } from './radar/radar-layer.js';

import { SatelliteView } from './satellite/satellite-view.js';
import { SatellitePanel } from './ui/satellite-panel.js';

import {
  _prepareInlinePalette, _writePreparedPaletteColor,
  WISE_PRT_PALETTE_SECTIONS, _prepareWisePrtPalette,
  CT_FAMILIES, EET_DEFAULT_PALETTE, CT_DEFAULT_PALETTES, CT_DEFAULT_GRADIENTS,
  ctStore, ctSave, ctGetActivePalette, ctGetDefaultPalette, ctGetEffectivePalette,
  getActivePalettes, getActiveDecodeOptions,
  parsePalFile, buildGradientStyle, _formatColorbarValue, _colorbarLabelsForPalette,
} from './radar/color-tables.js';

import {
  parseRadarBinaryBlob, parseWiseContainer,
  _toMercatorPoint, _wiseGeometryCacheKey, _productsFromL2Mask,
} from './radar/wise-decode.js';


import {
  SPC_OUTLOOK_SOURCES, SPC_TYPE_OPTIONS_BY_DAY, SPC_CAT_COLORS, SPC_PROB_COLORS,
  SPC_DAY3_PROB_COLORS, SPC_WIND_PROB_COLORS, SPC_HAIL_PROB_COLORS,
  SPC_DAY4_8_PROB_COLORS, SPC_EMPTY_GEOJSON, SPC_LAYER_IDS, SPC_GEOJSON_CACHE,
  NOAA_OUTLOOK_EMPTY_GEOJSON, NOAA_OUTLOOK_LAYER_IDS, NOAA_OUTLOOK_DATA_CACHE,
  NOAA_OUTLOOK_META_CACHE, NOAA_OUTLOOK_LOAD_TOKENS, NOAA_OUTLOOK_PREFETCH_QUEUE,
  NOAA_OUTLOOK_PREFETCH_PENDING, NOAA_OUTLOOK_PREFETCH_CONCURRENCY,
  NOAA_OUTLOOK_FILL_OPACITY_MAX, SPC_FIRE_OUTLOOK_SERVICE, WPC_QPF_SERVICE,
  WPC_EXCESSIVE_RAIN_SERVICE, WPC_WINTER_PROB_SERVICE, WPC_WSO_SERVICE, WPC_WSSI_SERVICE,
  CPC_610_SERVICE, CPC_814_SERVICE, CPC_DROUGHT_SERVICE, CPC_HAZARDS_SERVICE,
  CPC_WEEK34_PRECIP_KML_URL, CPC_WEEK34_TEMP_KML_URL, NOAA_OUTLOOK_SECTIONS,
  NOAA_OUTLOOK_PRODUCTS, MESO_DISCUSSION_URL, SPC_MESO_INDEX_URL, MESO_EMPTY_GEOJSON,
  MESO_LAYER_IDS, MESO_KIND_IDS, SPC_WATCHES_URL, WATCHES_EMPTY_GEOJSON, WATCH_LAYER_IDS,
  NEXRAD_ATTR_TVS_URL, TVS_EMPTY_GEOJSON, TVS_LAYER_IDS, LIGHTNING_EMPTY_GEOJSON,
  LIGHTNING_LAYER_IDS, LIGHTNING_ICON_ID, LIGHTNING_POLL_MS, LIGHTNING_WINDOW_MS,
  TVS_ICON_BY_BUCKET, TVS_ICON_COLORS, STORM_REPORT_SOURCE_OPTIONS,
  STORM_REPORT_LSR_WINDOWS, STORM_REPORT_LSR_URL, SPOTTER_REPORTS_URL,
  STORM_REPORT_POLL_MS, STORM_REPORT_CATEGORY_OPTIONS, STORM_REPORT_CATEGORY_COLORS,
  STORM_REPORT_CATEGORY_IDS, STORM_REPORT_CATEGORY_ID_SET, STORM_REPORT_LAYER_IDS,
  STORM_EMPTY_GEOJSON, STORM_REPORT_CACHE_MS, MPING_URL, MPING_SOURCE_ID, MPING_LAYER_ID,
  MPING_EMPTY_GEOJSON, MPING_POLL_MS, MPING_CACHE_MS, METARS_URL, METAR_SOURCE_ID,
  METAR_DOT_LAYER_ID, METAR_LAYER_IDS, METAR_EMPTY_GEOJSON, METAR_POLL_MS,
  METAR_CACHE_MS, METAR_FLIGHT_CATEGORY_COLORS, SPOTTER_LOCATIONS_URL,
  SPOTTER_LOCATIONS_SOURCE_ID, SPOTTER_LOCATIONS_LAYER_ID,
  SPOTTER_LOCATIONS_EMPTY_GEOJSON, SPOTTER_LOCATIONS_POLL_MS, SPOTTER_LOCATIONS_CACHE_MS,
  ALERT_LAYER_IDS, ALERT_POPUP_LAYER_IDS, ALERTS_EMPTY_GEOJSON, ALERT_EVENT_COLOR_MAP,
  WARNING_SOUND_OPTIONS, WARNING_SOUND_ID_SET, WARNING_SOUND_OPTION_MAP,
  WARNING_PREF_CONFIG, WARNING_PREF_ID_SET, _WARNING_ONLY_IDS, ALERT_FALLBACK_COLOR,
  ALERT_DEFAULT_KEEP_MS, WARNING_NOTIFY_STARTUP_QUIET_MS, WARNING_TOAST_LIFETIME_MS,
  WARNING_TOAST_LIMIT, WARNING_SOUND_COOLDOWN_MS, WARNING_GLOBAL_VOLUME_DEFAULT,
  ALERT_SOURCE_NWS_API, ALERT_SOURCE_NWS_BOOTSTRAP, ALERT_SOURCE_NWWS, ALERT_SOURCE_TEST,
  NWS_API_ALERTS_URL, NWS_API_POLL_MS, ALERT_BOOTSTRAP_GRACE_MS,
} from './overlays/constants.js';

"""

# ---------------------------------------------------------------------------
# Build a set for fast lookup: lineno → target file (None means skip)
# ---------------------------------------------------------------------------
skip_set = {}
for start, end, target in EXTRACTIONS:
    for n in range(start, end + 1):
        skip_set[n] = target

# ---------------------------------------------------------------------------
# Read source
# ---------------------------------------------------------------------------
with open(SRC, encoding='utf-8') as f:
    lines = f.readlines()

# ---------------------------------------------------------------------------
# Open output files
# ---------------------------------------------------------------------------
os.makedirs(os.path.dirname(RL_OUT), exist_ok=True)
os.makedirs(os.path.dirname(CT_OUT), exist_ok=True)
os.makedirs(os.path.dirname(WD_OUT), exist_ok=True)
os.makedirs(os.path.dirname(OVL_OUT), exist_ok=True)

rl_lines = []
ct_lines = []
wd_lines = []
ovl_lines = []
main_lines = []

for i, raw in enumerate(lines):
    lineno = i + 1

    line = (EXPORT_PREFIX[lineno] + raw) if lineno in EXPORT_PREFIX else raw

    target = skip_set.get(lineno)

    if lineno == 1:
        main_lines.append(raw)
        main_lines.append(MAIN_IMPORTS)
        rl_lines.append(f'// {raw.strip()}\n')
        ct_lines.append(f'// {raw.strip()}\n')
        wd_lines.append(f'// {raw.strip()}\n')
        ovl_lines.append(f'// {raw.strip()}\n')
        continue

    if target is None and lineno not in skip_set:
        main_lines.append(line)
    elif target == RL_OUT:
        rl_lines.append(line)
    elif target == CT_OUT:
        ct_lines.append(line)
    elif target == WD_OUT:
        wd_lines.append(line)
    elif target == OVL_OUT:
        if raw.startswith('const ') or raw.startswith('let '):
            ovl_lines.append('export ' + raw)
        else:
            ovl_lines.append(raw)
    # target == None but in skip_set → Phase-1 range, silently drop

# ---------------------------------------------------------------------------
# Write module files
# ---------------------------------------------------------------------------
with open(RL_OUT, 'w', encoding='utf-8') as f:
    f.writelines(rl_lines)

with open(CT_OUT, 'w', encoding='utf-8') as f:
    f.write(CT_HEADER)
    f.writelines(ct_lines)

with open(WD_OUT, 'w', encoding='utf-8') as f:
    f.write(WD_HEADER)
    f.writelines(wd_lines)

with open(OVL_OUT, 'w', encoding='utf-8') as f:
    f.write(OVL_HEADER)
    f.writelines(ovl_lines)

with open(MAIN, 'w', encoding='utf-8') as f:
    f.writelines(main_lines)

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
rl_count   = sum(1 for l in rl_lines if l.strip())
ct_count   = sum(1 for l in ct_lines if l.strip())
wd_count   = sum(1 for l in wd_lines if l.strip())
ovl_count  = sum(1 for l in ovl_lines if l.strip())
main_count = len(main_lines)
print(f"radar.js:        {len(lines):>6} lines")
print(f"main.js:         {main_count:>6} lines")
print(f"radar-layer.js:  {rl_count:>6} non-blank lines")
print(f"color-tables.js: {ct_count:>6} non-blank lines")
print(f"wise-decode.js:  {wd_count:>6} non-blank lines")
print(f"overlay consts:  {ovl_count:>6} non-blank lines")
