"""
radar_backend — WISE radar decode server
Reads JSON commands from stdin, writes binary (WDAR) or JSON responses to stdout.

Protocol:
  Request:  one JSON line on stdin  (e.g. {"cmd": "decode_wise", "key": "...", "palettes": {...}})
  Response (decode): [4-byte LE uint32 length][WDAR binary blob]
             if error: [4-byte LE uint32 length][{"error":"..."} JSON bytes]  (blob starts with '{')
  Response (list):    {"frames":[...], ...}\n  (plain JSON line)
  Response (error):   {"error":"..."}\n
"""

import sys
import io
import struct
import json
import math
import re
import time
import gc
import os
import urllib.request
import urllib.parse
import gzip
import zlib
from datetime import datetime, timezone

import numpy as np

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
EARTH_RADIUS_M       = 6_371_000.0
MAX_MERCATOR_LAT     = 85.05112878
WISE_MAGIC           = b'WISE'
WISE_FIXED_HEADER    = 68
WISE_MAX_GATES       = int(
    __import__('os').environ.get('RADAR_MAX_GATES', '750000')
)
WISE_PRT_RANGE_SPAN  = 120.0
WISE_BASE            = 'https://data2.weatherwise.app/radar/processed'

TDWR_FOLDER = {
    'REF': 'TZ0', 'VEL': 'TV0', 'PRT': 'PRT0', 'REF-LR': 'TZL',
}
TILT_INDEX = {
    '0.5': 0, '0.9': 1, '1.3': 2, '1.8': 3, '2.5': 4, '3.1': 5,
}
FAMILY_FIELD = {
    'CC':  'cross_correlation_ratio',
    'ZDR': 'differential_reflectivity',
    'SRV': 'storm_relative_velocity',
    'VEL': 'velocity',
    'SW':  'spectrum_width',
    'PRT': 'precipitation_type',
    'DTA': 'storm_total_precipitation',
}

# WDAR binary header: 46 bytes packed + 16-byte field_name + 2-byte pad = 64 total
# Fields: magic(4s) vc(I) gate_count(I) source_gate_count(I) elevation(f) lat(f) lon(f)
#         scan_time_ms(d) _unused(I) decimated(B) has_types(B) _pad_h(h) _pad_H(H)
WDAR_HDR_FMT  = '<4sIIIfffdIBBhH'
WDAR_HDR_SIZE = struct.calcsize(WDAR_HDR_FMT)  # 46

assert WDAR_HDR_SIZE == 46, f'WDAR header size mismatch: {WDAR_HDR_SIZE}'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _is_tdwr(station_id: str) -> bool:
    s = station_id.upper()
    return len(s) == 4 and s.startswith('T')


def folder_name(station_id: str, family: str, tilt: str) -> str:
    f = family.upper()
    if f == 'DTA':
        return 'DTA'
    if _is_tdwr(station_id):
        return TDWR_FOLDER.get(f, '')
    idx = TILT_INDEX.get(str(tilt), 0)
    return f'{f}{idx}'


def fetch_bytes(url: str, timeout: float = 15.0) -> bytes:
    req = urllib.request.Request(url, headers={
        'User-Agent': 'radar-app/1.0',
        'Accept-Encoding': 'gzip, deflate',
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
        enc = r.headers.get('Content-Encoding', '')
        if enc == 'gzip':
            data = gzip.decompress(data)
        elif enc == 'deflate':
            data = zlib.decompress(data)
        return data


# ---------------------------------------------------------------------------
# dir.list fetch
# ---------------------------------------------------------------------------

def fetch_dir_list(station_id: str, family: str, tilt: str):
    """Returns (sorted_filenames_list, folder_name)."""
    fold = folder_name(station_id, family, tilt)
    if not fold:
        raise ValueError(f'No folder for {station_id}/{family}/{tilt}')
    url = f'{WISE_BASE}/{station_id}/{fold}/dir.list'
    data = fetch_bytes(url, timeout=8.0)
    text = data.decode('utf-8', errors='replace').strip()
    # The listing is sometimes base64-encoded
    if '.wise' not in text.lower():
        import base64
        try:
            text = base64.b64decode(text).decode('utf-8', errors='replace').strip()
        except Exception:
            pass
    lines = [
        ln.strip() for ln in text.splitlines()
        if ln.strip().lower().endswith('.wise')
    ]
    return sorted(lines), fold


# ---------------------------------------------------------------------------
# WISE binary parsing
# ---------------------------------------------------------------------------

def parse_wise_bytes(data: bytes) -> dict:
    """Parse raw WISE binary. Returns metadata dict including 'codes' ndarray."""
    if len(data) < WISE_FIXED_HEADER or data[:4] != WISE_MAGIC:
        raise ValueError('Bad WISE magic or file too small')
    mv = memoryview(data)

    # Fixed header fields (big-endian)
    json_len,    = struct.unpack_from('>I', mv, 8)
    payload_len, = struct.unpack_from('>I', mv, 12)
    precision,   = struct.unpack_from('B',  mv, 16)
    min_val,     = struct.unpack_from('>f', mv, 18)
    max_val,     = struct.unpack_from('>f', mv, 22)
    az_count,    = struct.unpack_from('>I', mv, 26)
    gate_count,  = struct.unpack_from('>I', mv, 30)

    # JSON metadata block
    js = WISE_FIXED_HEADER
    meta = json.loads(bytes(mv[js: js + json_len]))

    # Payload (RLE codes)
    ps = js + json_len
    payload = bytes(mv[ps: ps + payload_len])
    if precision <= 8:
        codes = np.frombuffer(payload, dtype=np.uint8)
    else:
        # 16-bit little-endian per JS _wisePayloadToCodeStream
        codes = np.frombuffer(payload, dtype='<u2')

    loc = meta.get('location') or [None, None]
    station_lat = float(loc[1]) if loc[1] is not None else 0.0
    station_lon = float(loc[0]) if loc[0] is not None else 0.0

    gate_spacing   = max(1.0, float(meta.get('meters_between_gates', 250)))
    first_center   = float(meta.get('meters_to_center_of_first_gate', gate_spacing * 0.5))
    multi_type_cnt = max(0, int((meta.get('multi_type') or {}).get('count', 0)))

    return {
        'precision':        max(1, int(precision)),
        'min_value':        float(min_val),
        'max_value':        float(max_val),
        'azimuth_count':    max(1, int(az_count)),
        'gate_count':       max(1, int(gate_count)),
        'azimuth_start':    float(meta.get('azimuth_start', 0)),
        'gate_spacing_m':   gate_spacing,
        'first_center_m':   first_center,
        'station_lat':      station_lat,
        'station_lon':      station_lon,
        'elevation':        float(meta.get('elevation', 0)),
        'scan_time':        str(meta.get('datetime', '')),
        'multi_type_count': multi_type_cnt,
        'codes':            codes,
    }


# ---------------------------------------------------------------------------
# Gate-edge geometry  (vectorized)
# ---------------------------------------------------------------------------

def build_gate_geometry(
    station_lat: float, station_lon: float,
    az_count: int, gate_count: int,
    gate_spacing_m: float, first_center_m: float,
) -> tuple:
    """
    Returns (edge_x, edge_y) float32 arrays of shape (az_count+1, gate_count+1).
    Each element is the Mercator XY of a gate corner.
    """
    first_edge = max(0.0, first_center_m - gate_spacing_m * 0.5)
    r = (first_edge + np.arange(gate_count + 1) * gate_spacing_m) / EARTH_RADIUS_M
    sin_r = np.sin(r)
    cos_r = np.cos(r)

    az_step  = 2.0 * math.pi / az_count
    half_az  = az_step * 0.5
    bearings = np.arange(az_count + 1) * az_step - half_az
    sin_b = np.sin(bearings)
    cos_b = np.cos(bearings)

    lat1 = math.radians(station_lat)
    lon1 = math.radians(station_lon)
    sin1 = math.sin(lat1)
    cos1 = math.cos(lat1)

    # Shape: (az_count+1, gate_count+1)
    lat2 = np.arcsin(
        sin1 * cos_r[np.newaxis, :] +
        cos1 * sin_r[np.newaxis, :] * cos_b[:, np.newaxis]
    )
    lon2 = lon1 + np.arctan2(
        sin_b[:, np.newaxis] * sin_r[np.newaxis, :] * cos1,
        cos_r[np.newaxis, :] - sin1 * np.sin(lat2),
    )

    lon_deg = ((np.degrees(lon2) + 180.0) % 360.0) - 180.0
    lat_deg = np.degrees(lat2)
    lat_clip = np.clip(lat_deg, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)
    lat_rad  = np.radians(lat_clip)

    edge_x = ((lon_deg + 180.0) / 360.0).astype(np.float32)
    edge_y = ((1.0 - np.log(np.tan(math.pi * 0.25 + lat_rad * 0.5)) / math.pi) * 0.5).astype(np.float32)
    return edge_x, edge_y


# ---------------------------------------------------------------------------
# RLE decode  (matches JS decodeWiseRadar exactly)
# ---------------------------------------------------------------------------

def rle_decode(
    codes, precision: int,
    az_count: int, gate_count: int,
    az_start: float = 0.0,
) -> np.ndarray:
    threshold = (1 << (precision - 1)) - 1
    total     = az_count * gate_count
    start     = int(gate_count * round((az_count / 360.0) * az_start)) % total

    ca = np.asarray(codes, dtype=np.int32)
    skip_mask = ca > threshold
    # Advance per code: skip → (c - threshold), data/zero → 1
    advance   = np.where(skip_mask, ca - threshold, 1).astype(np.int64)
    # Position before each code (running sum, offset by start)
    cumpos    = np.cumsum(advance) - advance + start

    data_mask = (ca > 0) & ~skip_mask
    pos       = cumpos[data_mask] % total
    val       = ca[data_mask].astype(np.uint16)

    out = np.zeros(total, dtype=np.uint16)
    out[pos] = val
    return out.reshape(az_count, gate_count)


def rle_decode_multitype(
    codes, precision: int, type_count: int,
    az_count: int, gate_count: int,
    az_start: float = 0.0,
) -> tuple:
    threshold = (1 << (precision - 1)) - 1
    total     = az_count * gate_count
    start     = int(gate_count * round((az_count / 360.0) * az_start)) % total

    ca            = np.asarray(codes, dtype=np.int32)
    skip_mask     = ca > threshold + type_count
    type_mk_mask  = (ca > threshold) & ~skip_mask   # threshold < c <= threshold+type_count
    data_mask     = (ca > 0) & ~(ca > threshold)    # 0 < c <= threshold

    # Advance: skip → c-threshold-type_count, type_marker → 0, data/zero → 1
    advance = np.where(skip_mask, ca - threshold - type_count,
              np.where(type_mk_mask, 0, 1)).astype(np.int64)
    cumpos  = np.cumsum(advance) - advance + start

    # --- positions & values for data codes ---
    data_indices = np.where(data_mask)[0]
    data_pos     = cumpos[data_indices] % total
    data_val     = ((ca[data_indices] << 1) - 1).astype(np.uint16)

    # --- determine cur_type for each data code ---
    # type marker indices (in code array)
    tm_indices = np.where(type_mk_mask)[0]
    tm_values  = np.clip(ca[tm_indices] - threshold, 1, type_count).astype(np.uint8)
    if len(tm_indices) > 0 and len(data_indices) > 0:
        # For each data code, find the last type marker that precedes it
        ins = np.searchsorted(tm_indices, data_indices, side='right') - 1
        safe_ins  = np.where(ins >= 0, ins, 0)
        cur_types = np.where(ins >= 0, tm_values[safe_ins], np.uint8(1)).astype(np.uint8)
    else:
        cur_types = np.ones(len(data_indices), dtype=np.uint8)

    out       = np.zeros(total, dtype=np.uint16)
    type_grid = np.zeros(total, dtype=np.uint8)
    out[data_pos]       = data_val
    type_grid[data_pos] = cur_types
    return (
        out.reshape(az_count, gate_count),
        type_grid.reshape(az_count, gate_count),
    )


# ---------------------------------------------------------------------------
# Palette colour lookup
# ---------------------------------------------------------------------------

def palette_lookup(palette: dict, values: np.ndarray) -> np.ndarray:
    """
    Palette format: {xp: list[float], fp: list[float] (len = 4 * len(xp)), scale: float}
    Returns uint8 (n, 4) RGBA array.
    """
    n = len(values)
    if palette is None or not palette:
        return np.full((n, 4), 255, dtype=np.uint8)
    scale = float(palette.get('scale', 1.0))
    xp    = np.asarray(palette['xp'], dtype=np.float64)
    fp    = np.asarray(palette['fp'], dtype=np.float64).reshape(-1, 4)
    scaled = values.astype(np.float64) * scale
    rgba = np.empty((n, 4), dtype=np.uint8)
    for ch in range(4):
        raw = np.interp(scaled, xp, fp[:, ch])
        rgba[:, ch] = np.clip(np.round(raw), 0, 255).astype(np.uint8)
    return rgba


# ---------------------------------------------------------------------------
# Vertex-buffer assembly
# ---------------------------------------------------------------------------

def build_vertices(
    grid: np.ndarray,
    type_grid,          # None or ndarray shape (az, gc)
    edge_x: np.ndarray,
    edge_y: np.ndarray,
    az_count: int,
    gate_count: int,
    precision: int,
    min_val: float,
    max_val: float,
    palette,
    is_prt: bool,
) -> tuple:
    """
    Returns (xy_flat, rgba_flat, vals_flat, types_flat_or_None, vertex_count, decimated).
    vertex_count is a multiple of 6 (2 triangles per gate).
    """
    valid_r, valid_g = np.where(grid > 0)
    valid_count = len(valid_r)
    if valid_count == 0:
        empty_f = np.empty(0, dtype=np.float32)
        return empty_f, np.empty(0, dtype=np.uint8), empty_f, None, 0, False

    stride = max(1, math.ceil(valid_count / WISE_MAX_GATES))
    if stride > 1:
        keep    = np.arange(0, valid_count, stride)
        valid_r = valid_r[keep]
        valid_g = valid_g[keep]

    codes = grid[valid_r, valid_g].astype(np.float32)
    value_denom = max(1, ((1 << precision) - 2) if is_prt else ((1 << (precision - 1)) - 2))
    values = min_val + ((codes - 1.0) / value_denom) * (max_val - min_val)

    if is_prt and type_grid is not None:
        pt       = type_grid[valid_r, valid_g].astype(np.int32)
        sec      = np.clip(pt - 1, 0, 3)
        col_vals = values + sec.astype(np.float32) * WISE_PRT_RANGE_SPAN
        t_codes  = (sec + 1).astype(np.uint8)
    else:
        col_vals = values
        t_codes  = None

    rgba = palette_lookup(palette, col_vals)   # shape (n, 4)

    # Gate-corner indices: edge arrays are (az+1, gc+1), stored row-major
    gc1  = gate_count + 1
    r    = valid_r
    g    = valid_g
    r1   = r + 1
    p00  = r  * gc1 + g      # top-left
    p10  = r  * gc1 + g + 1  # top-right
    p11  = r1 * gc1 + g + 1  # bottom-right
    p01  = r1 * gc1 + g      # bottom-left

    ex = edge_x.ravel()
    ey = edge_y.ravel()
    n  = len(r)

    # Build 2 triangles (6 vertices) per gate: TL,TR,BR + TL,BR,BL
    xy = np.empty((n, 6, 2), dtype=np.float32)
    xy[:, 0, 0] = ex[p00];  xy[:, 0, 1] = ey[p00]
    xy[:, 1, 0] = ex[p10];  xy[:, 1, 1] = ey[p10]
    xy[:, 2, 0] = ex[p11];  xy[:, 2, 1] = ey[p11]
    xy[:, 3, 0] = ex[p00];  xy[:, 3, 1] = ey[p00]
    xy[:, 4, 0] = ex[p11];  xy[:, 4, 1] = ey[p11]
    xy[:, 5, 0] = ex[p01];  xy[:, 5, 1] = ey[p01]

    vc          = n * 6
    xy_flat     = xy.reshape(-1)
    rgba_flat   = np.repeat(rgba,    6, axis=0).ravel()
    vals_flat   = np.repeat(values,  6).astype(np.float32)
    types_flat  = np.repeat(t_codes, 6).astype(np.uint8) if t_codes is not None else None

    return xy_flat, rgba_flat, vals_flat, types_flat, vc, stride > 1


# ---------------------------------------------------------------------------
# WDAR binary blob builder
# ---------------------------------------------------------------------------

def build_wdar_blob(
    vc: int,
    gate_count: int,
    elevation: float,
    station_lat: float,
    station_lon: float,
    scan_time_ms: float,    # milliseconds since Unix epoch (float64)
    decimated: bool,
    has_types: bool,
    field_name: str,
    xy:    np.ndarray,      # float32 flat (vc*2)
    rgba:  np.ndarray,      # uint8  flat (vc*4)
    vals:  np.ndarray,      # float32 flat (vc)
    types,                  # uint8  flat (vc) or None
) -> bytes:
    field_bytes = field_name.encode('utf-8')[:16].ljust(16, b'\x00')
    hdr = struct.pack(
        WDAR_HDR_FMT,
        b'WDAR',
        vc, gate_count, gate_count,
        float(elevation), float(station_lat), float(station_lon),
        float(scan_time_ms),
        0,                          # unused (product_code slot)
        1 if decimated else 0,
        1 if has_types else 0,
        0, 0,                       # padding (h, H)
    ) + field_bytes + b'\x00\x00'   # 46 + 16 + 2 = 64 bytes
    assert len(hdr) == 64
    blob  = hdr
    blob += xy.astype(np.float32).tobytes()
    blob += rgba.astype(np.uint8).tobytes()
    blob += vals.astype(np.float32).tobytes()
    if has_types and types is not None:
        blob += types.astype(np.uint8).tobytes()
    return blob


# ---------------------------------------------------------------------------
# Scan-time parsing
# ---------------------------------------------------------------------------
_WISE_TS_RE = re.compile(
    r'(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})(?:_(\d{2}))?'
)

def parse_scan_time_ms(datetime_str: str, filename: str) -> float:
    """Return milliseconds since Unix epoch."""
    if datetime_str:
        try:
            dt = datetime.fromisoformat(datetime_str.replace('Z', '+00:00'))
            return dt.timestamp() * 1000.0
        except Exception:
            pass
    m = _WISE_TS_RE.search(filename)
    if m:
        y, mo, d, h, mn = int(m[1]), int(m[2]), int(m[3]), int(m[4]), int(m[5])
        s = int(m[6]) if m[6] else 0
        return datetime(y, mo, d, h, mn, s, tzinfo=timezone.utc).timestamp() * 1000.0
    return 0.0


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Decode cache — avoids re-fetching/re-decoding frames already seen this session
# ---------------------------------------------------------------------------
_DECODE_CACHE: dict = {}          # key → WDAR blob bytes
_DECODE_CACHE_MAX = max(8, int(os.environ.get('RADAR_WISE_SESSION_CACHE_MAX', '36')))

def _cache_get(key: str):
    return _DECODE_CACHE.get(key)

def _cache_put(key: str, blob: bytes) -> None:
    if key in _DECODE_CACHE:
        return  # already stored
    evicted = False
    while len(_DECODE_CACHE) >= _DECODE_CACHE_MAX:
        oldest = next(iter(_DECODE_CACHE))
        del _DECODE_CACHE[oldest]
        evicted = True
    _DECODE_CACHE[key] = blob
    if evicted:
        gc.collect()


def handle_decode_wise(req: dict) -> bytes:
    """Decode a WISE frame. Returns raw WDAR blob bytes."""
    key = req['key']

    cached = _cache_get(key)
    if cached is not None:
        return cached

    # key format: WISE:{station}:{family}:{tilt}:{url-encoded-filename}
    parts = key.split(':', 4)
    if len(parts) < 5:
        raise ValueError(f'Invalid WISE key: {key}')
    station  = parts[1]
    family   = parts[2].upper()
    tilt     = parts[3]
    filename = urllib.parse.unquote(parts[4])

    fold = folder_name(station, family, tilt)
    if not fold:
        raise ValueError(f'Unknown folder for {station}/{family}/{tilt}')
    url  = f'{WISE_BASE}/{station}/{fold}/{filename}'

    raw    = fetch_bytes(url)
    parsed = parse_wise_bytes(raw)
    del raw  # free download bytes immediately

    az        = parsed['azimuth_count']
    gc_       = parsed['gate_count']
    prec      = parsed['precision']
    is_prt    = (family == 'PRT' and parsed['multi_type_count'] > 0)
    sta_lat   = parsed['station_lat']
    sta_lon   = parsed['station_lon']
    elevation = parsed['elevation']
    min_val   = parsed['min_value']
    max_val   = parsed['max_value']
    scan_time = parsed['scan_time']

    edge_x, edge_y = build_gate_geometry(
        sta_lat, sta_lon, az, gc_,
        parsed['gate_spacing_m'], parsed['first_center_m'],
    )

    if is_prt:
        grid, type_grid = rle_decode_multitype(
            parsed['codes'], prec, parsed['multi_type_count'],
            az, gc_, parsed['azimuth_start'],
        )
    else:
        grid      = rle_decode(parsed['codes'], prec, az, gc_, parsed['azimuth_start'])
        type_grid = None
    del parsed  # free metadata dict + codes array

    palettes = req.get('palettes') or {}
    palette  = palettes.get(family) or palettes.get(family.upper()) or None

    xy, rgba, vals, types, vc, decimated = build_vertices(
        grid, type_grid, edge_x, edge_y,
        az, gc_, prec, min_val, max_val,
        palette, is_prt,
    )
    del grid, type_grid, edge_x, edge_y  # free geometry intermediates

    field        = FAMILY_FIELD.get(family, 'reflectivity')
    scan_time_ms = parse_scan_time_ms(scan_time, filename)

    blob = build_wdar_blob(
        vc,
        vc // 6 if vc > 0 else 0,
        elevation, sta_lat, sta_lon,
        scan_time_ms,
        decimated,
        is_prt,
        field,
        xy   if vc > 0 else np.empty(0, np.float32),
        rgba if vc > 0 else np.empty(0, np.uint8),
        vals if vc > 0 else np.empty(0, np.float32),
        types,
    )
    del xy, rgba, vals, types  # free vertex arrays now that blob is built
    _cache_put(key, blob)
    return blob


_DIR_LIST_CACHE: dict = {}   # (station, family, tilt) → (files, fold, fetched_at)
_DIR_LIST_CACHE_TTL_LIVE = 5.0
_DIR_LIST_CACHE_TTL_MANUAL = 20.0


def handle_list_wise(req: dict) -> dict:
    """List recent frames for a station/product."""
    station   = req['station']
    family    = req['family'].upper()
    tilt      = req.get('tilt', '0.5')
    mode      = str(req.get('mode', 'live') or 'live').lower()
    max_n     = min(60, int(req.get('max_frames', 20)))
    cache_key = (station, family, tilt)
    cached    = _DIR_LIST_CACHE.get(cache_key)
    ttl = _DIR_LIST_CACHE_TTL_MANUAL if mode == 'manual' else _DIR_LIST_CACHE_TTL_LIVE
    if cached and (time.monotonic() - cached[2]) < ttl:
        files, fold = cached[0], cached[1]
    else:
        files, fold = fetch_dir_list(station, family, tilt)
        _DIR_LIST_CACHE[cache_key] = (files, fold, time.monotonic())
    return {
        'frames':  files[-max_n:],
        'folder':  fold,
        'station': station,
        'family':  family,
        'tilt':    tilt,
    }


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------

def write_binary_response(stdout, blob: bytes) -> None:
    stdout.write(struct.pack('<I', len(blob)))
    stdout.write(blob)
    stdout.flush()


def write_error_binary(stdout, message: str) -> None:
    """Send error as a binary response whose blob starts with '{'."""
    err_bytes = json.dumps({'error': message}).encode('utf-8')
    stdout.write(struct.pack('<I', len(err_bytes)))
    stdout.write(err_bytes)
    stdout.flush()


def write_json_response(stdout, obj: dict) -> None:
    stdout.write((json.dumps(obj) + '\n').encode('utf-8'))
    stdout.flush()


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main() -> None:
    stdin  = io.TextIOWrapper(sys.stdin.buffer,  encoding='utf-8', errors='replace')
    stdout = sys.stdout.buffer

    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            cmd = req.get('cmd', 'decode_wise')

            if cmd == 'decode_wise':
                try:
                    blob = handle_decode_wise(req)
                    write_binary_response(stdout, blob)
                except Exception as e:
                    write_error_binary(stdout, str(e))

            elif cmd == 'list_wise':
                try:
                    result = handle_list_wise(req)
                    write_json_response(stdout, result)
                except Exception as e:
                    write_json_response(stdout, {'error': str(e)})

            else:
                write_json_response(stdout, {'error': f'Unknown command: {cmd}'})

        except json.JSONDecodeError as e:
            write_json_response(stdout, {'error': f'JSON parse error: {e}'})
        except Exception as e:
            write_json_response(stdout, {'error': str(e)})


if __name__ == '__main__':
    main()
