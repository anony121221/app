const US_STATE_NAME_TO_ABBR = {
  ALABAMA: 'AL', ALASKA: 'AK', ARIZONA: 'AZ', ARKANSAS: 'AR', CALIFORNIA: 'CA',
  COLORADO: 'CO', CONNECTICUT: 'CT', DELAWARE: 'DE', FLORIDA: 'FL', GEORGIA: 'GA',
  HAWAII: 'HI', IDAHO: 'ID', ILLINOIS: 'IL', INDIANA: 'IN', IOWA: 'IA',
  KANSAS: 'KS', KENTUCKY: 'KY', LOUISIANA: 'LA', MAINE: 'ME', MARYLAND: 'MD',
  MASSACHUSETTS: 'MA', MICHIGAN: 'MI', MINNESOTA: 'MN', MISSISSIPPI: 'MS', MISSOURI: 'MO',
  MONTANA: 'MT', NEBRASKA: 'NE', NEVADA: 'NV', 'NEW HAMPSHIRE': 'NH', 'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM', 'NEW YORK': 'NY', 'NORTH CAROLINA': 'NC', 'NORTH DAKOTA': 'ND', OHIO: 'OH',
  OKLAHOMA: 'OK', OREGON: 'OR', PENNSYLVANIA: 'PA', 'RHODE ISLAND': 'RI', 'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD', TENNESSEE: 'TN', TEXAS: 'TX', UTAH: 'UT', VERMONT: 'VT',
  VIRGINIA: 'VA', WASHINGTON: 'WA', 'WEST VIRGINIA': 'WV', WISCONSIN: 'WI', WYOMING: 'WY',
  'DISTRICT OF COLUMBIA': 'DC',
};

const CAMERA_ALLOWED_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'PR', 'VI', 'GU', 'AS', 'MP', 'AA', 'AE', 'AP',
]);

function _normalizeUsState(raw) {
  const s = String(raw || '').trim().replace(/\./g, '');
  if (!s) return '';
  if (/^[A-Za-z]{2}$/.test(s)) {
    const code = s.toUpperCase();
    return CAMERA_ALLOWED_STATE_CODES.has(code) ? code : '';
  }
  const up = s.toUpperCase().replace(/\s+/g, ' ');
  const code = US_STATE_NAME_TO_ABBR[up] || '';
  return CAMERA_ALLOWED_STATE_CODES.has(code) ? code : '';
}

function _extractStateCode(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const direct = _normalizeUsState(s);
  if (direct) return direct;

  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    const n = _normalizeUsState(part);
    if (n) return n;
    const words = part.split(/[^A-Za-z]+/).filter(Boolean);
    for (let j = 0; j < words.length; j += 1) {
      const one = _normalizeUsState(words[j]);
      if (one) return one;
      if (j + 1 < words.length) {
        const two = _normalizeUsState(`${words[j]} ${words[j + 1]}`);
        if (two) return two;
      }
      if (j + 2 < words.length) {
        const three = _normalizeUsState(`${words[j]} ${words[j + 1]} ${words[j + 2]}`);
        if (three) return three;
      }
    }
  }
  return '';
}

function _cameraStateFromSources(...sources) {
  for (const src of sources) {
    const state = _extractStateCode(src);
    if (state) return state;
  }
  return '';
}

function _cameraParseViews(rawViews) {
  if (Array.isArray(rawViews)) return rawViews;
  if (typeof rawViews !== 'string') return [];
  try {
    const parsed = JSON.parse(rawViews);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function _cameraIsLikelyVideoStreamUrl(value) {
  const u = String(value || '').trim().toLowerCase();
  if (!u) return false;
  if (/traveler\.modot\.org\/tisvc\/api\/tms\/camerastream\/?$/i.test(u)) return false;
  if (/traveler\.modot\.org\/tisvc\/api\/tms\/camerastream\/[^/?#]+/i.test(u)) return true;
  if (u.includes('.m3u8') || u.includes('.mpd')) return true;
  if (u.includes('/playlist') || u.includes('/manifest')) return true;
  return false;
}

function _cameraViewHasVideo(view, props = {}) {
  if (!view) return false;
  if (typeof view === 'string') return _cameraIsLikelyVideoStreamUrl(view);
  if (typeof view !== 'object') return false;

  const state = String(props?._state || props?.state || '').trim().toUpperCase();
  const directUrls = [
    view.url,
    view.video_url,
    view.m3u8Url,
    view.m3u8_url,
    view.dash_url,
    view.streamingURL,
    view.streamingVideoURL,
    view.html,
  ];
  if (directUrls.some(url => _cameraIsLikelyVideoStreamUrl(url))) return true;

  const viewUrl = String(view.url || view.image_url || '').trim();
  if (state === 'WI' && /511wi\.gov\/map\/Cctv\/\d+/i.test(viewUrl)) return true;

  const preview = String(
    view.videoPreviewUrl
    || view.preview_url
    || view.snapshot_url
    || view.thumbnail
    || view.jpg_url
    || ''
  ).trim();
  const type = String(view.type || view.mediaType || '').trim().toUpperCase();
  if (preview && (!type || !/(?:STILL|IMAGE|SNAPSHOT|JPEG|JPG|PNG)/.test(type))) return true;

  return false;
}

function _cameraHasKnownBrokenStreamUrl(props = {}) {
  return [props.url2, props.URL2, props.url, props.html].some(value =>
    /traveler\.modot\.org\/tisvc\/api\/tms\/camerastream\/?$/i.test(String(value || '').trim())
  );
}

function _cameraFeatureHasVideo(props = {}) {
  if (!props || typeof props !== 'object') return false;
  const definiteStreamFields = [
    props.dash_url,
    props.mpd_url,
    props.dash,
    props.hls_url,
    props.streamingURL,
    props.streamingVideoURL,
    props.m3u8Url,
    props.m3u8_url,
    props.m3u8,
    props.hls_stream_protected,
    props.streamSrc,
    props.httpsVideoUrl,
    props.httpVideoUrl,
    props.https_url,
    props.ios_url,
    props.stream_url,
    props.video_url,
    props.videoUrl,
  ];
  if (definiteStreamFields.some(v => String(v || '').trim())) return true;
  if ([props.url2, props.URL2, props.url, props.html].some(v => _cameraIsLikelyVideoStreamUrl(v))) return true;

  const grouped = props.cameras;
  if (grouped) {
    try {
      const cams = typeof grouped === 'string' ? JSON.parse(grouped) : grouped;
      if (Array.isArray(cams) && cams.some(cam => _cameraFeatureHasVideo(cam))) return true;
    } catch (_) {}
  }

  const views = _cameraParseViews(props.views);
  if (views.some(view => _cameraViewHasVideo(view, props))) return true;

  const videoAuth = props.videoauth;
  if (videoAuth === true || String(videoAuth || '').toLowerCase() === 'true') return true;

  const imageUrl = String(props.image_url || props.imageUrl || '').trim();
  const imageId = String(props.imageId || props.image_id || '').trim();
  const viewId = String(props.view_id || '').trim();
  if (imageId && String(props._state || '').toUpperCase() === 'GA') return true;
  if (viewId && /511pa\.com\/map\/Cctv\/\d+/i.test(imageUrl)) return true;
  if (/511ga\.org\/map\/Cctv\/\d+/i.test(imageUrl)) return true;
  if (/511ny\.org\/map\/Cctv\/\d+/i.test(imageUrl)) return true;
  if (/fl511\.com\/map\/Cctv\/\d+/i.test(imageUrl)) return true;
  return false;
}

function _cameraResolvedHasVideo(props = {}) {
  if (Object.prototype.hasOwnProperty.call(props, '_has_video')) {
    return Number(props?._has_video) ? 1 : 0;
  }
  if (_cameraHasKnownBrokenStreamUrl(props)) return 0;
  if (_cameraFeatureHasVideo(props)) return 1;
  return 0;
}

function _cameraPointFeature(lon, lat, props = {}, id = '') {
  const featureProps = { ...(props || {}) };
  featureProps._has_video = _cameraResolvedHasVideo(featureProps);
  return {
    type: 'Feature',
    id: id || undefined,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: featureProps,
  };
}

function _cameraCoords(feature) {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

function isOklahomaCameraFeature(feature) {
  const p = feature.properties || {};
  const state = (p.state || p.State || '').toLowerCase();
  if (state === 'oklahoma' || state === 'ok') return true;
  return Object.values(p).some(v =>
    typeof v === 'string' && (v.includes('oktraffic.org') || v.includes('oktrafficradar.org'))
  );
}

function isKentuckyCameraFeature(feature) {
  const p = feature?.properties || {};
  const source = String(p.source || p.Source || '').toUpperCase();
  if (source.includes('KYTC') || source.includes('TRIMARC')) return true;
  return _cameraStateFromSources(
    p.state,
    p.State,
    p.state_name,
    p.county,
    p.location,
    p.description,
    p.name,
  ) === 'KY';
}

function isAlabamaCameraFeature(feature) {
  const p = feature?.properties || {};
  const blob = JSON.stringify({
    state: p.state || p.State || '',
    source_file: p._source_file || '',
    permalink: p.permalink || p.permLink || '',
    snapshot_url: p.snapshot_url || p.snapshotImageUrl || '',
    map_image_url: p.map_image_url || p.mapImageUrl || '',
  }).toLowerCase();
  return blob.includes('alabama')
    || blob.includes('algotraffic.com')
    || blob.includes('/v4/cameras/');
}

function isGeorgiaCameraFeature(feature) {
  const p = feature?.properties || {};
  const state = _cameraStateFromSources(
    p.state,
    p.State,
    p.state_name,
    p.county,
    p.city,
    p.location,
    p.title,
    p.name,
  );
  if (state === 'GA') return true;
  return Object.values(p).some(v => {
    if (typeof v !== 'string') return false;
    const s = v.toLowerCase();
    return s.includes('navigator.dot.ga.gov')
      || s.includes('511ga.org/map/cctv/')
      || s.includes('511ga.org');
  });
}

function isIndianaCameraFeature(feature) {
  const p = feature?.properties || {};
  const state = _cameraStateFromSources(
    p.state,
    p.State,
    p.state_name,
    p.county,
    p.city,
    p.location,
    p.title,
    p.name,
  );
  if (state === 'IN') return true;
  return Object.values(p).some(v => {
    if (typeof v !== 'string') return false;
    const s = v.toLowerCase();
    return s.includes('public.carsprogram.org/cameras/in/')
      || s.includes('indot_')
      || s.includes('511in.org')
      || s.includes('indiana');
  });
}

function isIowaCameraFeature(feature) {
  const p = feature?.properties || {};
  const state = _cameraStateFromSources(
    p.state,
    p.State,
    p.state_name,
    p.county,
    p.city,
    p.location,
    p.title,
    p.name,
    p.source,
  );
  if (state === 'IA') return true;
  return Object.values(p).some(v => {
    if (typeof v !== 'string') return false;
    const s = v.toLowerCase();
    return s.includes('iowadot')
      || s.includes('iowadotsnapshot')
      || s.includes('511ia')
      || s.includes('iowa');
  });
}

function isColoradoCameraFeature(feature) {
  const p = feature?.properties || {};
  const state = _cameraStateFromSources(
    p.state,
    p.State,
    p.state_name,
    p.county,
    p.city,
    p.location,
    p.title,
    p.name,
  );
  if (state === 'CO') return true;
  return Object.values(p).some(v => {
    if (typeof v !== 'string') return false;
    const s = v.toLowerCase();
    return s.includes('cotrip')
      || s.includes('cocam.carsprogram.org')
      || s.includes('publicstreamer');
  });
}

function isMississippiCameraFeature(feature) {
  const p = feature?.properties || {};
  const state = _cameraStateFromSources(
    p.state,
    p.State,
    p.state_abbr,
    p.iso_3166_2,
    p.county,
    p.city,
    p.location,
    p.description,
    p.name,
  );
  if (state !== 'MS') return false;
  return Object.values(p).some(v => {
    if (typeof v !== 'string') return false;
    const s = v.toLowerCase();
    return s.includes('mdottraffic.com')
      || s.includes('trafficvision.live')
      || s.includes('mississippi dot')
      || s.includes('mdot');
  });
}

function _normalizeTrimarcSnapshotUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  return s.replace(/^http:\/\//i, 'https://');
}

function _normalizeCardinalDirection(value) {
  const s = String(value || '').trim().toUpperCase();
  if (!s) return '';
  const map = {
    N: 'N', S: 'S', E: 'E', W: 'W',
    NB: 'N', SB: 'S', EB: 'E', WB: 'W',
    NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
    NORTHBOUND: 'N', SOUTHBOUND: 'S', EASTBOUND: 'E', WESTBOUND: 'W',
  };
  return map[s] || '';
}

function _inferCameraDirectionFromText(text) {
  const t = String(text || '').trim().toUpperCase();
  if (!t) return '';
  const patterns = [
    /\b(NB|SB|EB|WB)\b/,
    /\b(NORTHBOUND|SOUTHBOUND|EASTBOUND|WESTBOUND)\b/,
    /\b([NSEW])\s+(?:OF|AT|TO)\b/,
    /\b(NORTH|SOUTH|EAST|WEST)\b/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const raw = m[1] || m[0];
    const dir = _normalizeCardinalDirection(raw);
    if (dir) return dir;
  }
  return '';
}

function _cameraDirectionLabel(props) {
  const explicit = _normalizeCardinalDirection(
    props?.direction
    || props?.Direction
    || props?.DIRECTION
    || props?.dir
    || ''
  );
  if (explicit) return explicit;
  return _inferCameraDirectionFromText(
    props?.camera_title
    || props?.title
    || props?.name
    || props?.location
    || props?.description
    || ''
  );
}

function _buildKentuckyTrimarcFeatures(raw) {
  const items = Array.isArray(raw) ? raw : [];
  const features = [];
  for (const item of items) {
    const status = String(item?.status || '').trim().toLowerCase();
    const snapshot = _normalizeTrimarcSnapshotUrl(item?.snapshot);
    const lat = Number(item?.latitude);
    const lon = Number(item?.longitude);
    if (status !== 'online' || !snapshot || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    features.push(_cameraPointFeature(lon, lat, {
      state: 'Kentucky',
      source: 'KYTC',
      id: item?.id ?? '',
      name: item?.name || 'Traffic Camera',
      description: item?.description || '',
      direction: item?.direction || '',
      highway: item?.highway || '',
      milemarker: item?.mileMarker || item?.milemarker || '',
      snapshot,
      snapshot_name: item?.snapshot_name || '',
      latitude: lat,
      longitude: lon,
      status: 'Online',
      _state: 'KY',
    }, String(item?.id || item?.name || snapshot)));
  }
  return features;
}

function _buildAlabamaAlgoTrafficFeatures(raw) {
  const items = Array.isArray(raw) ? raw : [];
  const features = [];
  for (const item of items) {
    const loc = item?.location || {};
    const lat = Number(loc?.latitude);
    const lon = Number(loc?.longitude);
    const hls = String(item?.playbackUrls?.hls || '').trim();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !hls) continue;
    const route = String(loc?.displayRouteDesignator || loc?.routeDesignator || '').trim();
    const cross = String(loc?.displayCrossStreet || loc?.crossStreet || '').trim();
    const mile = Number(loc?.linearReference);
    const crossLabel = cross || (Number.isFinite(mile) ? `MM ${mile}` : '');
    const name = [route, crossLabel].filter(Boolean).join(' @ ') || `Camera ${item?.id ?? ''}`.trim();
    features.push(_cameraPointFeature(lon, lat, {
      id: item?.id ?? '',
      name,
      location: name,
      hls_url: hls,
      dash_url: String(item?.playbackUrls?.dash || '').trim(),
      snapshot_url: String(item?.snapshotImageUrl || '').trim(),
      map_image_url: String(item?.mapImageUrl || '').trim(),
      city: String(loc?.city || '').trim(),
      county: String(loc?.county || '').trim(),
      route,
      cross_street: crossLabel,
      direction: String(loc?.direction || '').trim(),
      milepost: Number.isFinite(mile) ? mile : '',
      responsibleRegion: String(item?.responsibleRegion || '').trim(),
      accessLevel: String(item?.accessLevel || '').trim(),
      permalink: String(item?.permLink || '').trim(),
      source: 'AlgoTraffic',
      agency: 'ALDOT',
      state: 'Alabama',
      _state: 'AL',
    }, String(item?.id || name)));
  }
  return features;
}

function _buildIndianaCarsFeatures(raw) {
  const features = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const loc = item?.location || {};
      const lat = Number(loc?.latitude);
      const lon = Number(loc?.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const views = Array.isArray(item?.views) ? item.views : [];
      const videoView = views.find(v => String(v?.url || '').trim() && String(v?.type || '').toUpperCase() !== 'STILL_IMAGE') || views[0] || {};
      const m3u8Url = String(videoView?.url || '').trim();
      const imageUrl = String(videoView?.videoPreviewUrl || '').trim();
      if (!m3u8Url && !imageUrl) continue;
      const title = String(item?.name || '').trim() || 'Indiana Traffic Camera';
      const route = String(loc?.routeId || '').trim();
      const cityRef = String(loc?.cityReference || '').trim();
      const locationText = [route, cityRef].filter(Boolean).join(' @ ') || cityRef || route || title;
      features.push(_cameraPointFeature(lon, lat, {
        id: item?.id ?? '',
        name: title,
        title,
        location: locationText,
        route,
        city: cityRef,
        image_url: imageUrl,
        m3u8_url: m3u8Url,
        source: 'INDOT',
        agency: String(item?.cameraOwner?.name || 'INDOT').trim() || 'INDOT',
        state: 'Indiana',
        _state: 'IN',
      }, String(item?.id || title)));
    }
    return features;
  }

  const srcFeatures = Array.isArray(raw?.features) ? raw.features : [];
  for (const f of srcFeatures) {
    const c = _cameraCoords(f);
    if (!c) continue;
    const p = f?.properties || {};
    const title = String(p.title || p.name || '').trim();
    const imageUrl = String(p.image_url || p.imageUrl || '').trim();
    const m3u8Url = String(p.m3u8_url || p.m3u8 || '').trim();
    if (!imageUrl && !m3u8Url) continue;
    features.push(_cameraPointFeature(c[0], c[1], {
      ...p,
      name: title || 'Indiana Traffic Camera',
      title: title || 'Indiana Traffic Camera',
      image_url: imageUrl,
      m3u8_url: m3u8Url,
      source: 'INDOT',
      agency: 'INDOT',
      state: 'Indiana',
      _state: 'IN',
    }, String(f?.id || p?.id || p?.m3u8_url || p?.image_url || title)));
  }
  return features;
}

function _buildIowa511Features(raw) {
  const srcFeatures = Array.isArray(raw?.features) ? raw.features : [];
  const features = [];
  for (const f of srcFeatures) {
    const c = _cameraCoords(f);
    if (!c) continue;
    const p = f?.properties || {};
    const views = Array.isArray(p.views) ? p.views : [];
    const preferredView = views.find(v => String(v?.m3u8_url || '').trim())
      || views.find(v => String(v?.jpg_url || '').trim())
      || views[0]
      || {};
    const jpgList = Array.isArray(p.jpg_urls) ? p.jpg_urls : [];
    const hlsList = Array.isArray(p.m3u8_urls) ? p.m3u8_urls : [];
    const imageUrl = String(preferredView?.jpg_url || jpgList.find(url => String(url || '').trim()) || '').trim();
    const m3u8Url = String(preferredView?.m3u8_url || hlsList.find(url => String(url || '').trim()) || '').trim();
    if (!imageUrl && !m3u8Url) continue;
    const title = String(p.title || p.name || '').trim() || 'Iowa Traffic Camera';
    const serializedViews = views.length ? JSON.stringify(views) : '';
    features.push(_cameraPointFeature(c[0], c[1], {
      ...p,
      id: String(p.camera_uri || p.id || '').trim(),
      camera_uri: String(p.camera_uri || '').trim(),
      name: title,
      title,
      location: title,
      image_url: imageUrl,
      snapshot_url: imageUrl,
      m3u8_url: m3u8Url,
      stream_url: m3u8Url,
      jpg_urls: JSON.stringify(jpgList),
      m3u8_urls: JSON.stringify(hlsList),
      views: serializedViews,
      source: 'Iowa 511',
      agency: 'Iowa DOT',
      state: 'Iowa',
      _state: 'IA',
    }, String(f?.id || p?.camera_uri || imageUrl || m3u8Url || title)));
  }
  return features;
}

function _buildGeorgia511Features(raw) {
  const srcFeatures = Array.isArray(raw?.features) ? raw.features : [];
  const features = [];
  for (const f of srcFeatures) {
    const c = _cameraCoords(f);
    if (!c) continue;
    const p = f?.properties || {};
    const title = String(p.name || p.title || '').trim() || 'Georgia Traffic Camera';
    const imageUrl = String(p.image_url || p.imageUrl || '').trim();
    const rawStreamUrl = String(p.stream_url || p.streamUrl || p.m3u8_url || '').trim();
    const imageId = String(p.imageId || p.image_id || '').trim();
    if (!imageUrl && !rawStreamUrl && !imageId) continue;
    features.push(_cameraPointFeature(c[0], c[1], {
      ...p,
      id: String(p.siteId || p.id || '').trim(),
      imageId,
      name: title,
      title,
      location: title,
      image_url: imageUrl,
      m3u8_url: rawStreamUrl,
      stream_url: rawStreamUrl,
      source: 'GDOT',
      agency: 'GDOT',
      state: 'Georgia',
      _state: 'GA',
    }, String(f?.id || p?.siteId || p?.id || title)));
  }
  return features;
}

function _buildColoradoCotTripFeatures(raw) {
  const srcFeatures = Array.isArray(raw?.features) ? raw.features : [];
  const features = [];
  for (const f of srcFeatures) {
    const c = _cameraCoords(f);
    if (!c) continue;
    const p = f?.properties || {};
    const title = String(p.title || p.name || '').trim() || 'Colorado Traffic Camera';
    const snapshotUrl = String(p.snapshotUrl || p.snapshot_url || p.image_url || p.imageUrl || '').trim();
    const streamUrl = String(p.streamUrl || p.stream_url || p.m3u8_url || p.m3u8 || '').trim();
    if (!snapshotUrl && !streamUrl) continue;
    features.push(_cameraPointFeature(c[0], c[1], {
      ...p,
      id: String(p.id || p.cameraCode || '').trim(),
      name: title,
      title,
      location: title,
      snapshot_url: snapshotUrl,
      image_url: snapshotUrl,
      m3u8_url: streamUrl,
      stream_url: streamUrl,
      camera_code: String(p.cameraCode || p.camera_code || '').trim(),
      source: String(p.source || 'COtrip').trim(),
      agency: 'CDOT',
      state: 'Colorado',
      _state: 'CO',
    }, String(f?.id || p?.id || p?.cameraCode || streamUrl || snapshotUrl || title)));
  }
  return features;
}

function _buildMississippiGroupedFeatures(rawFeatures) {
  const items = Array.isArray(rawFeatures) ? rawFeatures : [];
  const siteMap = new Map();
  for (const f of items) {
    if (!isMississippiCameraFeature(f)) continue;
    const c = _cameraCoords(f);
    if (!c) continue;
    const p = f?.properties || {};
    const siteId = String(p.siteId || p.site_id || '').trim();
    const key = siteId || `${c[0]},${c[1]}`;
    if (!siteMap.has(key)) {
      siteMap.set(key, {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: c },
        properties: {
          name: p.site_title || p.location || p.camera_title || p.name || p.roadway || 'Mississippi Camera',
          location: p.site_title || p.location || p.display_name || '',
          state: 'Mississippi',
          source: p.source || p.provider || 'MDOT',
          agency: p.agency || '',
          siteId: siteId || String(p.site_id || ''),
          _state: 'MS',
          _cameras: [],
        },
      });
    }
    siteMap.get(key).properties._cameras.push({
      id: p.id || f?.id || p.camera_code || '',
      name: p.camera_title || p.name || p.title || p.location || p.roadway || 'Camera',
      title: p.camera_title || p.title || p.name || '',
      location: p.site_title || p.location || p.display_name || '',
      description: p.description || '',
      direction: p.direction || '',
      roadway: p.roadway || p.road || '',
      site_id: p.site_id || p.siteId || '',
      site_title: p.site_title || '',
      camera_code: p.camera_code || '',
      streamname: p.streamname || '',
      m3u8_url: p.m3u8_url || '',
      thumbnail_url: p.thumbnail_url || '',
      web_page_url: p.web_page_url || '',
      camera_page_url: p.camera_page_url || '',
      source: p.source || p.provider || 'MDOT',
      agency: p.agency || '',
      videoUrl: p.videoUrl || '',
      video_url: p.video_url || '',
      stream_url: p.stream_url || '',
      url: p.url || '',
      html: p.html || '',
      imageUrl: p.imageUrl || '',
      image_url: p.image_url || '',
      _state: 'MS',
    });
  }
  const features = [];
  for (const f of siteMap.values()) {
    const cams = f.properties._cameras || [];
    cams.sort((a, b) => _cameraDirectionLabel(a).localeCompare(_cameraDirectionLabel(b)));
    f.properties.cameras = JSON.stringify(cams);
    f.properties._has_video = cams.some(cam => _cameraFeatureHasVideo(cam)) ? 1 : 0;
    delete f.properties._cameras;
    features.push(f);
  }
  return features;
}

function _buildOklahomaGroupedFeatures(raw) {
  const okFeatures = Array.isArray(raw?.features) ? raw.features : [];
  const poleMap = new Map();
  for (const f of okFeatures) {
    const c = _cameraCoords(f);
    if (!c) continue;
    const p = f?.properties || {};
    const key = p.poleId != null ? String(p.poleId) : `${c[0]},${c[1]}`;
    if (!poleMap.has(key)) {
      poleMap.set(key, {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: c },
        properties: {
          name: p.poleName || p.name || 'Oklahoma Camera',
          city: p.city || '',
          state: 'Oklahoma',
          _state: 'OK',
          _cameras: [],
        },
      });
    }
    poleMap.get(key).properties._cameras.push({
      direction: p.direction || '—',
      name: p.name || p.poleName || 'Camera',
      m3u8: p.m3u8 || null,
    });
  }
  const features = [];
  for (const f of poleMap.values()) {
    f.properties.cameras = JSON.stringify(f.properties._cameras);
    f.properties._has_video = (f.properties._cameras || []).some(cam => _cameraFeatureHasVideo(cam)) ? 1 : 0;
    delete f.properties._cameras;
    features.push(f);
  }
  return features;
}

function _normalizeCombinedFeature(f) {
  const c = _cameraCoords(f);
  if (!c) return null;
  const p = f?.properties || {};
  const state = _cameraStateFromSources(
    p._state, p._merged_state, p.state, p.State, p.state_name,
    p.city, p.name, p.cameraName, p.location, p.locationName, p.nearbyPlace,
    p.county, p._source_file, p._source_url,
  );
  const primaryName = p.name || p.cameraName || p.title || p.description || p.locationName
    || p.location || p.nearbyPlace || p.CameraLocation || p.camera_description
    || p.station_name || p.site_name || '';
  const direction = String(p.CameraDirection || p.direction_name || p.directionLabel || '').trim();
  const displayName = primaryName
    ? (direction && !String(primaryName).toLowerCase().includes(` ${direction.toLowerCase()}`)
        ? `${primaryName} (${direction})` : primaryName)
    : 'Traffic Camera';
  return _cameraPointFeature(c[0], c[1], {
    ...p,
    name: displayName,
    _state: state || String(p._state || p.state || '').trim().toUpperCase().slice(0, 2),
  }, String(f?.id || p?.id || p?.cameraId || p?.camera_id || p?.deviceID || ''));
}

function _inMissouriBounds(lon, lat) {
  return lat >= 35.9 && lat <= 40.7 && lon >= -95.9 && lon <= -88.9;
}
function _inKansasBounds(lon, lat) {
  return lat >= 36.9 && lat <= 40.1 && lon >= -102.2 && lon <= -94.4;
}

function _composeTrafficCameraFeatures(datasets = {}) {
  const features = [];
  for (const [stateCode, geojson] of Object.entries(datasets)) {
    const srcFeatures = Array.isArray(geojson?.features) ? geojson.features : [];
    let count = 0;
    for (const f of srcFeatures) {
      const c = _cameraCoords(f);
      if (!c) continue;
      const p = f?.properties || {};
      const name = String(p.cameraName || p.name || p.title || p.camera_title || p.location || '').trim()
        || `${stateCode} Traffic Camera`;
      const rawId = String(f?.id || p?.id || p?.cameraId || p?.camera_id || p?.deviceID || '');
      const stateId = rawId ? `${stateCode}:${rawId}` : '';
      const extraProps = {};
      if (stateCode === 'PA') {
        const paId = String(p.view_id || p.cameraId || p.camera_id || rawId || '').trim()
          || (String(p.imageUrl || '').match(/\/map\/Cctv\/(\d+)/)?.[1] || '');
        if (paId) {
          extraProps.view_id = paId;
          if (!String(p.cameraId || p.camera_id || '').trim()) extraProps.cameraId = paId;
        }
      }
      if (stateCode === 'KS') {
        const ksId = String(p.cameraId || p.camera_id || rawId || '').trim();
        if (ksId) {
          extraProps.videoauth = 'true';
          if (!String(p.cameraId || p.camera_id || '').trim()) extraProps.cameraId = ksId;
        }
      }
      features.push(_cameraPointFeature(c[0], c[1], {
        ...p,
        ...extraProps,
        name,
        _state: stateCode,
      }, stateId));
      count++;
    }
    if (count === 0) console.warn(`[Camera][Traffic] ${stateCode}: 0 valid features`);
  }
  return features;
}

self.onmessage = ev => {
  const { id, datasets } = ev.data || {};
  try {
    const features = _composeTrafficCameraFeatures(datasets || {});
    self.postMessage({ id, features });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
