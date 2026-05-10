// Version string helpers
export function normalizeVersionLabel(raw) {
  return String(raw || '').trim().replace(/^v/i, '');
}

export function parseVersionParts(raw) {
  const normalized = normalizeVersionLabel(raw);
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function comparePrereleaseParts(a = [], b = []) {
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left == null) return -1;
    if (right == null) return 1;
    const leftNum = /^\d+$/.test(left) ? Number(left) : null;
    const rightNum = /^\d+$/.test(right) ? Number(right) : null;
    if (leftNum != null && rightNum != null) {
      if (leftNum !== rightNum) return leftNum > rightNum ? 1 : -1;
      continue;
    }
    if (leftNum != null) return -1;
    if (rightNum != null) return 1;
    if (left !== right) return left > right ? 1 : -1;
  }
  return 0;
}

export function compareVersionLabels(a, b) {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  if (!left || !right) return 0;
  if (left.major !== right.major) return left.major > right.major ? 1 : -1;
  if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1;
  if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1;
  return comparePrereleaseParts(left.prerelease, right.prerelease);
}

export function pickReleaseDownloadUrl(release) {
  const assets = Array.isArray(release?.assets) ? release.assets.slice() : [];
  assets.sort((a, b) => {
    const rank = item => {
      const name = String(item?.name || '').toLowerCase();
      if (name.endsWith('-setup.exe')) return 0;
      if (name.endsWith('.msi')) return 1;
      if (name.endsWith('.exe')) return 2;
      return 3;
    };
    return rank(a) - rank(b);
  });
  const url = String(assets[0]?.browser_download_url || '').trim();
  return /\.(exe|msi)(?:$|\?)/i.test(url) ? url : '';
}

// URL / string helpers
export function enc(s) { return encodeURIComponent(s); }

export function flatDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '_');
}

export function flatDateTime(d) {
  // "2026-03-01T02:23:17" → "2026_03_01_02_23_17"
  return d.toISOString().slice(0, 19).replace('T', '_').replace(/-/g, '_').replace(/:/g, '_');
}

// S3 XML parsing helpers
export function parseKeys(xml) {
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)]
    .map(m => m[1])
    .filter(k => !k.endsWith('/'));
}

export function parseNextContinuationToken(xml) {
  const m = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
  return m ? m[1] : null;
}

export function parseCommonPrefixes(xml) {
  return [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g)]
    .map(m => m[1]);
}

export function parseKeyTimestampMs(key) {
  if (key.startsWith('L2:')) {
    const ts = key.split(':')[3];  // "20260228-062733"
    if (!ts) return NaN;
    const m = ts.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  if (key.startsWith('TGFTP:')) {
    const ts = key.split(':')[4];
    if (!ts) return NaN;
    const m = ts.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  }
  if (key.startsWith('WISE:')) {
    const fileToken = key.split(':').slice(4).join(':');
    const fileName = decodeURIComponent(fileToken || '');
    const m = fileName.match(/(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})(?:_(\d{2}))?\.wise$/i);
    if (!m) return NaN;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  }
  const m = key.match(/_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
