(() => {
  const CHANNEL_NAME = 'radar-warning-dashboard';
  const STORAGE_KEY = 'radar_warning_dashboard_bus';
  const SOURCE = 'dashboard';
  const TYPE_SNAPSHOT = 'snapshot';
  const TYPE_REQUEST_SNAPSHOT = 'request_snapshot';
  const TYPE_GO_TO_WARNING = 'go_to_warning';
  const LOG_EVENT = 'dashboard-window-log';
  const SEEN_LIMIT = 256;

  const tauriEvent = window.__TAURI__?.event || null;
  const emitLogEvent = typeof tauriEvent?.emit === 'function'
    ? (payload) => tauriEvent.emit(LOG_EVENT, payload).catch(() => {})
    : () => {};

  const seenIds = new Set();
  let channel = null;
  let countEl = null;
  let statusEl = null;
  let listEl = null;
  let emptyEl = null;
  let searchEl = null;
  let filterBtnEl = null;
  let filterMenuEl = null;
  let warnings = [];
  let generatedAtMs = NaN;
  let liveTimer = null;
  let filterMode = 'all';
  let searchQuery = '';
  let sortMode = 'newest';
  let sortBtnEl = null;
  let sortMenuEl = null;
  const expandedWarningIds = new Set();
  const warningSnapshotSignatures = new Map();
  const warningFlashUntilMs = new Map();
  let hasAppliedSnapshot = false;

  function log(phase, detail, extra = {}) {
    const payload = {
      phase: String(phase || 'log'),
      detail: String(detail || ''),
      label: 'warning-dashboard',
      url: window.location.href,
      ...extra,
    };
    try { console.info('[dashboard-window]', payload.phase, payload.detail, extra); } catch (_) {}
    try { emitLogEvent(payload); } catch (_) {}
  }

  function rememberMessage(id) {
    const key = String(id || '').trim();
    if (!key) return false;
    if (seenIds.has(key)) return true;
    seenIds.add(key);
    if (seenIds.size > SEEN_LIMIT) {
      const first = seenIds.values().next().value;
      if (first) seenIds.delete(first);
    }
    return false;
  }

  function parseMs(value) {
    const ms = Date.parse(String(value || ''));
    return Number.isFinite(ms) ? ms : NaN;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function rowSignature(row) {
    return JSON.stringify({
      title: row?.title || '',
      event: row?.event || '',
      warnClass: row?.warnClass || '',
      color: row?.color || '',
      area: row?.area || '',
      headline: row?.headline || '',
      hazards: row?.hazards || '',
      impact: row?.impact || '',
      where: row?.where || '',
      when: row?.when || '',
      description: row?.description || '',
      severity: row?.severity || '',
      urgency: row?.urgency || '',
      certainty: row?.certainty || '',
      sent: row?.sent || '',
      expires: row?.expires || '',
    });
  }

  function formatAbsolute(value) {
    const ms = parseMs(value);
    if (!Number.isFinite(ms)) return '--';
    return new Date(ms).toLocaleString([], {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatRelativeMs(ms) {
    if (!Number.isFinite(ms)) return '--';
    const diffMin = Math.round((Date.now() - ms) / 60000);
    if (Math.abs(diffMin) < 1) return 'now';
    if (Math.abs(diffMin) < 60) return `${Math.abs(diffMin)}m ${diffMin >= 0 ? 'ago' : 'from now'}`;
    const diffHour = Math.round(diffMin / 60);
    if (Math.abs(diffHour) < 24) return `${Math.abs(diffHour)}h ${diffHour >= 0 ? 'ago' : 'from now'}`;
    const diffDay = Math.round(diffHour / 24);
    return `${Math.abs(diffDay)}d ${diffDay >= 0 ? 'ago' : 'from now'}`;
  }

  function formatCountdown(expiresMs) {
    if (!Number.isFinite(expiresMs)) return '--';
    const remainingMs = Math.max(0, expiresMs - Date.now());
    const totalSeconds = Math.floor(remainingMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const prefix = remainingMs > 0 ? 'Expires in' : 'Expired';
    return `${prefix} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function renderExpiresText(expiresMs) {
    if (!Number.isFinite(expiresMs)) return 'Expires --';
    return formatCountdown(expiresMs);
  }

  function isMeaningful(value) {
    const text = String(value ?? '').trim();
    return !!text && text !== '--';
  }

  function warningSearchBlob(row) {
    return [
      row?.title,
      row?.event,
      row?.area,
      row?.hazards,
      row?.headline,
      row?.impact,
      row?.where,
      row?.when,
      row?.description,
      row?.instruction,
    ].map(v => String(v || '')).join(' ').toLowerCase();
  }

  const _DASH_CATEGORY_MAP = {
    tornado: new Set(['TOR', 'TORR', 'TORP', 'TORE', 'TOW', 'TOWP']),
    severe:  new Set(['SVR', 'SVRC', 'SVRD', 'SVW', 'SVWP']),
    winter:  new Set(['WSW', 'BLW', 'ISW', 'SNQ', 'WCW', 'LESW', 'FFZ', 'HFZ', 'FZW', 'WSWA', 'ISWA', 'LESWA', 'WWA', 'FRA', 'WCVA', 'LESA']),
    special: new Set(['SPS', 'HWO', 'DFA', 'HWW', 'WNDADV']),
    flood:   new Set(['FFW']),
  };

  function warningCategory(row) {
    return row?.category || (() => {
      const code = String(row?.warnClass || '').trim().toUpperCase();
      for (const [cat, codes] of Object.entries(_DASH_CATEGORY_MAP)) {
        if (codes.has(code)) return cat;
      }
      return 'other';
    })();
  }

  function warningMatchesFilter(row) {
    if (filterMode === 'tornado') {
      return String(row?.warnClass || '').toUpperCase().startsWith('TOR')
        || /tornado warning/i.test(String(row?.event || ''));
    }
    if (filterMode === 'severe') {
      return String(row?.warnClass || '').toUpperCase().startsWith('SVR')
        || /severe thunderstorm warning/i.test(String(row?.event || ''));
    }
    if (filterMode === 'winter') return warningCategory(row) === 'winter';
    if (filterMode === 'special') return warningCategory(row) === 'special';
    if (filterMode === 'flood') return warningCategory(row) === 'flood';
    return true;
  }

  function warningMatchesSearch(row) {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return true;
    return warningSearchBlob(row).includes(needle);
  }

  function visibleWarnings() {
    return sortWarningRows(warnings.filter(row => warningMatchesFilter(row) && warningMatchesSearch(row)));
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      :root {
        color-scheme: dark;
        --bg: #000000;
        --panel: #000000;
        --panel-soft: #000000;
        --line: #1a1a1a;
        --text: #eef3ff;
        --muted: #afb7c6;
        --warn: #f4b740;
        --accent: #4d89ff;
      }
      * { box-sizing: border-box; }
      html, body {
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        background: var(--bg);
        color: var(--text);
        font-family: "Segoe UI", sans-serif;
        overflow: hidden;
      }
      body {
        display: flex;
        flex-direction: column;
      }
      body::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      body::-webkit-scrollbar-track {
        background: transparent;
      }
      body::-webkit-scrollbar-thumb {
        background: #232323;
        border-radius: 999px;
      }
      body::-webkit-scrollbar-thumb:hover {
        background: #2f2f2f;
      }
      .dashboard-shell {
        display: flex;
        flex-direction: column;
        min-height: 100%;
        background: var(--bg);
      }
      .dashboard-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--line);
        background: var(--panel);
      }
      .dashboard-heading {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .dashboard-title {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: #f4f7ff;
      }
      .dashboard-count {
        font-size: 11px;
        color: var(--muted);
        font-variant-numeric: tabular-nums;
      }
      .dashboard-tools {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-shrink: 0;
      }
      .dashboard-search {
        width: 240px;
        height: 34px;
        padding: 0 12px;
        border: 1px solid #262626;
        border-radius: 10px;
        background: #050505;
        color: var(--text);
        font-size: 12px;
        outline: none;
      }
      .dashboard-search::placeholder {
        color: #6f7888;
      }
      .dashboard-search:focus {
        border-color: #3d4f73;
      }
      .dashboard-filter-wrap {
        position: relative;
      }
      .dashboard-menu-btn {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 34px;
        padding: 0 12px;
        border: 1px solid #262626;
        border-radius: 10px;
        background: #050505;
        color: #d7e0ef;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .dashboard-menu-btn:hover,
      .dashboard-menu-btn.open {
        border-color: #3d4f73;
      }
      .dashboard-menu-btn svg {
        width: 14px;
        height: 14px;
        display: block;
      }
      .dashboard-filter-btn {
        min-width: 152px;
      }
      .dashboard-filter-btn:hover,
      .dashboard-filter-btn.open {
      }
      .dashboard-filter-btn svg {
      }
      .dashboard-filter-menu {
        position: absolute;
        top: calc(100% + 8px);
        right: 0;
        min-width: 180px;
        display: none;
        flex-direction: column;
        padding: 6px;
        border: 1px solid #262626;
        border-radius: 12px;
        background: #050505;
        box-shadow: 0 16px 30px rgba(0, 0, 0, 0.42);
        z-index: 20;
      }
      .dashboard-filter-menu.open {
        display: flex;
      }
      .dashboard-filter-option {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        min-height: 34px;
        padding: 0 10px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #dce6f6;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
      }
      .dashboard-filter-option:hover,
      .dashboard-filter-option.active {
        background: #11151b;
      }
      .dashboard-sort-btn {
        min-width: 144px;
      }
      .dashboard-status {
        min-height: 34px;
        display: flex;
        align-items: center;
        padding: 8px 16px;
        border-bottom: 1px solid var(--line);
        color: var(--muted);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        background: var(--panel-soft);
      }
      .warning-list {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 12px;
        overflow-y: auto;
        list-style: none;
        margin: 0;
        padding: 14px;
        scrollbar-width: thin;
        scrollbar-color: #232323 transparent;
      }
      .warning-list::-webkit-scrollbar {
        width: 8px;
      }
      .warning-list::-webkit-scrollbar-track {
        background: transparent;
      }
      .warning-list::-webkit-scrollbar-thumb {
        background: #232323;
        border-radius: 999px;
      }
      .warning-list::-webkit-scrollbar-thumb:hover {
        background: #2f2f2f;
      }
      .warning-item {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 14px;
        padding: 16px 18px;
        border: 1px solid #161616;
        border-left: 4px solid var(--row-border, #1a1a1a);
        border-radius: 16px;
        background: #050505;
        box-shadow: 0 14px 28px rgba(0, 0, 0, 0.28);
        transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
      }
      .warning-item.warning-flash {
        animation: warningCardFlash 1.25s ease-in-out 4;
      }
      @keyframes warningCardFlash {
        0%, 100% {
          border-color: #161616;
          box-shadow: 0 14px 28px rgba(0, 0, 0, 0.28);
        }
        50% {
          border-color: var(--row-border, #1a1a1a);
          box-shadow:
            0 14px 28px rgba(0, 0, 0, 0.28),
            0 0 0 1px var(--row-border, #1a1a1a),
            0 0 18px var(--row-border, #1a1a1a);
        }
      }
      .warning-main { min-width: 0; }
      .warning-title-row {
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      .warning-title {
        font-size: 15px;
        font-weight: 700;
        color: #f3f6ff;
        line-height: 1.2;
      }
      .warning-info {
        width: 26px;
        height: 26px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid #27303d;
        border-radius: 999px;
        background: #090b0f;
        color: #dfe7f7;
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
      }
      .warning-info:hover {
        border-color: var(--accent);
        color: #ffffff;
      }
      .warning-actions {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        justify-content: space-between;
        gap: 10px;
        min-height: 100%;
      }
      .warning-headline {
        margin-top: 8px;
        color: #f0f4ff;
        font-size: 12px;
        line-height: 1.4;
      }
      .warning-area {
        margin-top: 6px;
        color: #c5cfdf;
        font-size: 12px;
        line-height: 1.3;
      }
      .warning-hazards {
        margin-top: 8px;
        color: #dde3ef;
        font-size: 12px;
        line-height: 1.4;
      }
      .warning-hazards-label {
        margin-right: 6px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .warning-times {
        margin-top: 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        color: var(--muted);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      .warning-expires {
        color: #edf2ff;
      }
      .warning-details {
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px solid #151515;
        display: grid;
        gap: 10px;
      }
      .warning-detail-grid {
        display: grid;
        grid-template-columns: 110px minmax(0, 1fr);
        gap: 8px 12px;
        align-items: start;
      }
      .warning-detail-k {
        color: #8c95a4;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .warning-detail-v {
        color: #edf2ff;
        font-size: 12px;
        line-height: 1.45;
        white-space: pre-wrap;
      }
      .warning-go {
        min-width: 76px;
        height: 32px;
        padding: 0 12px;
        border: 1px solid #4a5568;
        border-radius: 6px;
        background: #1b1f26;
        color: #d9e7ff;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        cursor: pointer;
      }
      .warning-go:hover {
        border-color: var(--accent);
        background: #232935;
        color: #ffffff;
      }
      .warning-empty {
        display: none;
        padding: 18px 16px;
        color: var(--muted);
        font-size: 12px;
      }
      @media (max-width: 900px) {
        .dashboard-header {
          flex-direction: column;
          align-items: stretch;
        }
        .dashboard-tools {
          width: 100%;
        }
        .dashboard-search {
          flex: 1;
          width: auto;
        }
        .warning-item {
          grid-template-columns: 1fr;
        }
        .warning-actions {
          align-items: flex-start;
          min-height: 0;
        }
      }
      .warning-category-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 12px 18px 4px;
        list-style: none;
      }
      .warning-cat-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #6a7585;
      }
      .warning-cat-count {
        background: #1c2028;
        color: #8a96a6;
        font-size: 9px;
        font-weight: 700;
        padding: 1px 6px;
        border-radius: 999px;
        letter-spacing: 0.04em;
      }
    `;
    document.head.appendChild(style);
  }

  function warningBorderColor(row) {
    if (row?.color) return String(row.color);
    const warnClass = String(row?.warnClass || '').trim().toUpperCase();
    const event = String(row?.event || '').trim().toUpperCase();
    if (warnClass === 'TORE') return '#4b177a';
    if (warnClass === 'TORP') return '#ff4fd8';
    if (warnClass === 'TORR') return '#6d0000';
    if (warnClass === 'TOR') return '#c90000';
    if (warnClass === 'SVRD') return '#ff9800';
    if (warnClass === 'SVRC') return '#ffd400';
    if (warnClass === 'SVR') return '#bba600';
    if (warnClass === 'FFW' || event === 'FLASH FLOOD WARNING') return '#21c55d';
    if (event === 'FLOOD WARNING') return '#18a999';
    if (event === 'SPECIAL MARINE WARNING') return '#2cc6ff';
    // Winter warnings
    if (warnClass === 'BLW') return '#3a6abf';
    if (warnClass === 'WSW') return '#4878c8';
    if (warnClass === 'ISW') return '#5c4fa8';
    if (warnClass === 'SNQ' || event === 'SNOW SQUALL WARNING') return '#7ccfff';
    if (warnClass === 'WCW') return '#6a8fbb';
    if (warnClass === 'LESW') return '#5aa8cc';
    if (warnClass === 'HFZ') return '#2a5aad';
    if (warnClass === 'FFZ' || warnClass === 'FZW') return '#3a6aad';
    if (warnClass === 'WSWA' || warnClass === 'ISWA' || warnClass === 'LESWA') return '#335e94';
    if (warnClass === 'WWA' || warnClass === 'FRA' || warnClass === 'WCVA' || warnClass === 'LESA') return '#3a5880';
    // Special event
    if (warnClass === 'HWW') return '#8a6400';
    if (warnClass === 'WNDADV') return '#6e5830';
    if (warnClass === 'DFA') return '#404040';
    if (warnClass === 'SPS') return '#808000';
    if (warnClass === 'HWO') return '#707020';
    return '#2a2a2a';
  }

  function filterLabel() {
    if (filterMode === 'tornado') return 'Tornado';
    if (filterMode === 'severe') return 'Severe';
    if (filterMode === 'winter') return 'Winter';
    if (filterMode === 'special') return 'Special Event';
    if (filterMode === 'flood') return 'Flood';
    return 'All';
  }

  function sortLabel() {
    if (sortMode === 'urgency') return 'Highest Urgency';
    return 'Newest First';
  }

  function warningUrgencyScore(row) {
    const warnClass = String(row?.warnClass || '').trim().toUpperCase();
    const event = String(row?.event || '').trim().toUpperCase();
    const urgency = String(row?.urgency || '').trim().toUpperCase();
    const severity = String(row?.severity || '').trim().toUpperCase();
    const certainty = String(row?.certainty || '').trim().toUpperCase();

    let score = ({
      TORE: 1000,
      TORP: 960,
      TORR: 930,
      TOR: 900,
      SVRD: 820,
      SVRC: 780,
      SVR: 740,
      FFW: 700,
      BLW: 750,
      WSW: 720,
      ISW: 700,
      WCW: 680,
      HFZ: 660,
      FFZ: 660,
      FZW: 660,
      HWW: 640,
      SNQ: 650,
      LESW: 620,
      WSWA: 580,
      ISWA: 580,
      LESWA: 580,
      WWA: 560,
      FRA: 560,
      WCVA: 560,
      LESA: 520,
      WNDADV: 500,
      DFA: 480,
      SPS: 440,
      HWO: 420,
    })[warnClass] ?? ({
      'FLASH FLOOD WARNING': 700,
      'SNOW SQUALL WARNING': 650,
      'SPECIAL MARINE WARNING': 610,
      'FLOOD WARNING': 520,
    })[event] ?? 420;

    if (urgency.includes('IMMEDIATE')) score += 60;
    else if (urgency.includes('EXPECTED')) score += 35;
    else if (urgency.includes('FUTURE')) score += 10;

    if (severity.includes('EXTREME')) score += 40;
    else if (severity.includes('SEVERE')) score += 30;
    else if (severity.includes('MODERATE')) score += 20;
    else if (severity.includes('MINOR')) score += 10;

    if (certainty.includes('OBSERVED')) score += 30;
    else if (certainty.includes('LIKELY')) score += 20;
    else if (certainty.includes('POSSIBLE')) score += 10;

    return score;
  }

  function warningNewestMs(row) {
    return Number(row?.issuedMs || parseMs(row?.sent) || 0);
  }

  function warningExpiresSortMs(row) {
    return Number(row?.expiresMs || parseMs(row?.expires) || 0);
  }

  function sortWarningRows(rows) {
    const nextRows = [...rows];
    if (sortMode === 'urgency') {
      nextRows.sort((a, b) => {
        const urgencyDiff = warningUrgencyScore(b) - warningUrgencyScore(a);
        if (urgencyDiff) return urgencyDiff;
        const issuedDiff = warningNewestMs(b) - warningNewestMs(a);
        if (issuedDiff) return issuedDiff;
        return warningExpiresSortMs(b) - warningExpiresSortMs(a);
      });
      return nextRows;
    }
    nextRows.sort((a, b) => {
      const issuedDiff = warningNewestMs(b) - warningNewestMs(a);
      if (issuedDiff) return issuedDiff;
      return warningExpiresSortMs(b) - warningExpiresSortMs(a);
    });
    return nextRows;
  }

  function renderShell() {
    document.body.innerHTML = `
      <div class="dashboard-shell">
        <div class="dashboard-header">
          <div class="dashboard-heading">
            <div class="dashboard-title">Warning Dashboard</div>
            <div class="dashboard-count" id="dashboard-count">0 warnings</div>
          </div>
          <div class="dashboard-tools">
            <input class="dashboard-search" id="dashboard-search" type="search" placeholder="Search warnings">
            <div class="dashboard-filter-wrap">
              <button class="dashboard-menu-btn dashboard-sort-btn" id="dashboard-sort-btn" type="button" aria-haspopup="true" aria-expanded="false">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M7 6h10M7 12h7M7 18h4"/>
                </svg>
                <span id="dashboard-sort-label">Newest First</span>
              </button>
              <div class="dashboard-filter-menu" id="dashboard-sort-menu">
                <button class="dashboard-filter-option active" type="button" data-sort="newest">Newest First</button>
                <button class="dashboard-filter-option" type="button" data-sort="urgency">Highest Urgency</button>
              </div>
            </div>
            <div class="dashboard-filter-wrap">
              <button class="dashboard-menu-btn dashboard-filter-btn" id="dashboard-filter-btn" type="button" aria-haspopup="true" aria-expanded="false">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M3 5h18M6 12h12M10 19h4"/>
                </svg>
                <span id="dashboard-filter-label">All Warnings</span>
              </button>
              <div class="dashboard-filter-menu" id="dashboard-filter-menu">
                <button class="dashboard-filter-option active" type="button" data-filter="all">All</button>
                <button class="dashboard-filter-option" type="button" data-filter="tornado">Tornado</button>
                <button class="dashboard-filter-option" type="button" data-filter="severe">Severe</button>
                <button class="dashboard-filter-option" type="button" data-filter="winter">Winter</button>
                <button class="dashboard-filter-option" type="button" data-filter="special">Special Event</button>
                <button class="dashboard-filter-option" type="button" data-filter="flood">Flood</button>
              </div>
            </div>
          </div>
        </div>
        <div class="dashboard-status" id="dashboard-status">Booting dashboard...</div>
        <ul class="warning-list" id="warning-list"></ul>
        <div class="warning-empty" id="warning-empty">No active warnings.</div>
      </div>
    `;
    countEl = document.getElementById('dashboard-count');
    statusEl = document.getElementById('dashboard-status');
    listEl = document.getElementById('warning-list');
    emptyEl = document.getElementById('warning-empty');
    searchEl = document.getElementById('dashboard-search');
    filterBtnEl = document.getElementById('dashboard-filter-btn');
    filterMenuEl = document.getElementById('dashboard-filter-menu');
    sortBtnEl = document.getElementById('dashboard-sort-btn');
    sortMenuEl = document.getElementById('dashboard-sort-menu');
  }

  function setFilterMenuOpen(open) {
    if (!filterBtnEl || !filterMenuEl) return;
    if (open) setSortMenuOpen(false);
    filterBtnEl.classList.toggle('open', !!open);
    filterBtnEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    filterMenuEl.classList.toggle('open', !!open);
  }

  function setSortMenuOpen(open) {
    if (!sortBtnEl || !sortMenuEl) return;
    if (open) setFilterMenuOpen(false);
    sortBtnEl.classList.toggle('open', !!open);
    sortBtnEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    sortMenuEl.classList.toggle('open', !!open);
  }

  function syncFilterUi() {
    document.getElementById('dashboard-filter-label').textContent = filterLabel();
    filterMenuEl?.querySelectorAll('.dashboard-filter-option').forEach(node => {
      node.classList.toggle('active', String(node.dataset.filter || '') === filterMode);
    });
  }

  function syncSortUi() {
    document.getElementById('dashboard-sort-label').textContent = sortLabel();
    sortMenuEl?.querySelectorAll('.dashboard-filter-option').forEach(node => {
      node.classList.toggle('active', String(node.dataset.sort || '') === sortMode);
    });
  }

  function updateStatusText(extra) {
    if (!statusEl) return;
    if (extra) {
      statusEl.textContent = extra;
      return;
    }
    if (!Number.isFinite(generatedAtMs)) {
      statusEl.textContent = 'Waiting for warning feed from main app...';
      return;
    }
    statusEl.textContent = `Updated ${formatRelativeMs(generatedAtMs)}`;
  }

  function refreshLiveTimes() {
    if (!listEl) return;
    const nodes = listEl.querySelectorAll('.warning-expires[data-expires-ms]');
    for (const node of nodes) {
      const expiresMs = Number(node.getAttribute('data-expires-ms'));
      node.textContent = renderExpiresText(expiresMs);
    }
    if (!Number.isFinite(generatedAtMs)) return;
    updateStatusText();
  }

  function renderDetailRows(row) {
    const detailRows = [
      ['Headline', row.headline],
      ['Hazards', row.hazards],
      ['Where', row.where],
      ['When', row.when],
      ['Impact', row.impact],
      ['Severity', row.severity],
      ['Urgency', row.urgency],
      ['Certainty', row.certainty],
      ['Description', row.description],
    ].filter(([, value]) => isMeaningful(value));

    if (!detailRows.length) return '';

    return `
      <div class="warning-details">
        <div class="warning-detail-grid">
          ${detailRows.map(([key, value]) => `
            <div class="warning-detail-k">${escapeHtml(key)}</div>
            <div class="warning-detail-v">${escapeHtml(value)}</div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderWarnings() {
    if (!countEl || !listEl || !emptyEl) return;
    const rows = visibleWarnings();
    countEl.textContent = rows.length === warnings.length
      ? `${rows.length} warning${rows.length === 1 ? '' : 's'}`
      : `${rows.length} of ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;
    listEl.innerHTML = '';
    emptyEl.style.display = rows.length ? 'none' : 'block';
    emptyEl.textContent = warnings.length
      ? 'No warnings match the current search or filter.'
      : 'No active warnings.';

    const _CAT_ORDER = ['tornado', 'severe', 'winter', 'special', 'flood', 'other'];
    const _CAT_LABELS = { tornado: 'Tornado', severe: 'Severe', winter: 'Winter', special: 'Special Event', flood: 'Flood', other: 'Other' };
    // Group rows by category (preserve sort order within each group)
    const grouped = {};
    for (const cat of _CAT_ORDER) grouped[cat] = [];
    for (const row of rows) {
      const cat = warningCategory(row);
      (grouped[cat] || grouped['other']).push(row);
    }
    const showCategories = filterMode === 'all' && rows.length > 0;
    for (const cat of _CAT_ORDER) {
      const catRows = grouped[cat];
      if (!catRows || !catRows.length) continue;
      if (showCategories) {
        const header = document.createElement('li');
        header.className = 'warning-category-header';
        header.innerHTML = `<span class="warning-cat-label">${escapeHtml(_CAT_LABELS[cat])}</span><span class="warning-cat-count">${catRows.length}</span>`;
        listEl.appendChild(header);
      }
      for (const row of catRows) {
        const expanded = expandedWarningIds.has(row.id);
        const flashUntilMs = Number(warningFlashUntilMs.get(row.id) || 0);
        const isFlashing = flashUntilMs > Date.now();
        const li = document.createElement('li');
        li.className = `warning-item${isFlashing ? ' warning-flash' : ''}`;
        li.style.setProperty('--row-border', warningBorderColor(row));
        li.innerHTML = `
          <div class="warning-main">
            <div class="warning-title-row">
              <div class="warning-title">${escapeHtml(row.title || row.event || 'Warning')}</div>
            </div>
            ${isMeaningful(row.headline) ? `<div class="warning-headline">${escapeHtml(row.headline)}</div>` : ''}
            <div class="warning-area">${escapeHtml(row.area || 'Area not listed')}</div>
            <div class="warning-hazards"><span class="warning-hazards-label">Hazards</span>${escapeHtml(row.hazards || '--')}</div>
            <div class="warning-times">
              <span>Issued: ${escapeHtml(formatAbsolute(row.sent))}</span>
              <span class="warning-expires" data-expires-ms="${escapeHtml(row.expiresMs)}">${escapeHtml(renderExpiresText(Number(row.expiresMs) || NaN))}</span>
            </div>
            ${expanded ? renderDetailRows(row) : ''}
          </div>
          <div class="warning-actions">
            <button class="warning-info" type="button" data-warning-info="${escapeHtml(row.id)}" aria-expanded="${expanded ? 'true' : 'false'}">i</button>
            <button class="warning-go" type="button" data-warning-id="${escapeHtml(row.id)}">Go To</button>
          </div>
        `;
        listEl.appendChild(li);
      }
    }
    refreshLiveTimes();
  }

  function applySnapshot(payload) {
    const rows = Array.isArray(payload?.warnings) ? payload.warnings : [];
    const nextWarnings = rows
      .filter(row => row && row.id)
      .sort((a, b) => {
        const aMs = Number(a.issuedMs || parseMs(a.sent) || 0);
        const bMs = Number(b.issuedMs || parseMs(b.sent) || 0);
        if (bMs !== aMs) return bMs - aMs;
        return Number(b.expiresMs || parseMs(b.expires) || 0) - Number(a.expiresMs || parseMs(a.expires) || 0);
      });
    const liveIds = new Set(nextWarnings.map(row => row.id));
    [...expandedWarningIds].forEach(id => {
      if (!liveIds.has(id)) expandedWarningIds.delete(id);
    });
    for (const id of [...warningSnapshotSignatures.keys()]) {
      if (!liveIds.has(id)) warningSnapshotSignatures.delete(id);
    }
    for (const id of [...warningFlashUntilMs.keys()]) {
      if (!liveIds.has(id)) warningFlashUntilMs.delete(id);
    }
    const nowMs = Date.now();
    for (const row of nextWarnings) {
      const sig = rowSignature(row);
      const prevSig = warningSnapshotSignatures.get(row.id);
      if (hasAppliedSnapshot && prevSig && prevSig !== sig) {
        warningFlashUntilMs.set(row.id, nowMs + 5_000);
      } else if (hasAppliedSnapshot && !prevSig) {
        warningFlashUntilMs.set(row.id, nowMs + 5_000);
      }
      warningSnapshotSignatures.set(row.id, sig);
    }
    warnings = nextWarnings;
    hasAppliedSnapshot = true;
    generatedAtMs = parseMs(payload?.generatedAt);
    renderWarnings();
    updateStatusText();
    log('snapshot', `received ${warnings.length} warning rows`);
  }

  function sendMessage(type, payload) {
    const message = {
      id: `dashboard-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      source: SOURCE,
      type,
      payload: payload || null,
      sentAt: new Date().toISOString(),
    };
    try { channel?.postMessage(message); } catch (_) {}
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(message)); } catch (_) {}
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.source === SOURCE) return;
    if (rememberMessage(message.id)) return;

    if (message.type === TYPE_SNAPSHOT) {
      applySnapshot(message.payload || {});
    }
  }

  function initMessaging() {
    if (typeof BroadcastChannel === 'function') {
      try {
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.addEventListener('message', evt => {
          handleMessage(evt?.data);
        });
        log('channel', 'BroadcastChannel connected');
      } catch (err) {
        log('error', `BroadcastChannel failed: ${err?.message || String(err)}`);
        channel = null;
      }
    } else {
      log('warn', 'BroadcastChannel unavailable, using storage fallback only');
    }

    window.addEventListener('storage', evt => {
      if (evt.key !== STORAGE_KEY || !evt.newValue) return;
      try {
        handleMessage(JSON.parse(evt.newValue));
      } catch (_) {}
    });
  }

  function bindEvents() {
    listEl?.addEventListener('click', evt => {
      const infoButton = evt.target?.closest?.('.warning-info');
      if (infoButton) {
        const id = String(infoButton.dataset.warningInfo || '').trim();
        if (!id) return;
        if (expandedWarningIds.has(id)) expandedWarningIds.delete(id);
        else expandedWarningIds.add(id);
        renderWarnings();
        return;
      }
      const button = evt.target?.closest?.('.warning-go');
      if (!button) return;
      const id = String(button.dataset.warningId || '').trim();
      if (!id) return;
      const row = warnings.find(item => String(item?.id || '') === id) || null;
      log('go-to', `requested ${id}`);
      sendMessage(TYPE_GO_TO_WARNING, {
        id,
        center: Array.isArray(row?.center) ? row.center : null,
        bounds: Array.isArray(row?.bounds) ? row.bounds : null,
      });
    });

    searchEl?.addEventListener('input', () => {
      searchQuery = String(searchEl.value || '');
      renderWarnings();
    });

    filterBtnEl?.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      const open = !filterMenuEl?.classList.contains('open');
      setFilterMenuOpen(open);
    });

    sortBtnEl?.addEventListener('click', evt => {
      evt.preventDefault();
      evt.stopPropagation();
      const open = !sortMenuEl?.classList.contains('open');
      setSortMenuOpen(open);
    });

    filterMenuEl?.addEventListener('click', evt => {
      const option = evt.target?.closest?.('.dashboard-filter-option');
      if (!option) return;
      filterMode = String(option.dataset.filter || 'all');
      syncFilterUi();
      setFilterMenuOpen(false);
      renderWarnings();
    });

    sortMenuEl?.addEventListener('click', evt => {
      const option = evt.target?.closest?.('.dashboard-filter-option');
      if (!option) return;
      sortMode = String(option.dataset.sort || 'newest');
      syncSortUi();
      setSortMenuOpen(false);
      renderWarnings();
    });

    document.addEventListener('click', evt => {
      if (evt.target?.closest?.('.dashboard-filter-wrap')) return;
      if (filterMenuEl?.classList.contains('open')) setFilterMenuOpen(false);
      if (sortMenuEl?.classList.contains('open')) setSortMenuOpen(false);
    });

    window.addEventListener('focus', () => {
      log('request', 'focus snapshot request');
      sendMessage(TYPE_REQUEST_SNAPSHOT, { reason: 'focus' });
    });

    window.addEventListener('error', evt => {
      const message = String(evt?.message || 'Dashboard script error');
      updateStatusText(message);
      log('error', message);
    });

    window.addEventListener('unhandledrejection', evt => {
      const reason = evt?.reason?.message || String(evt?.reason || 'Unhandled promise rejection');
      updateStatusText(reason);
      log('error', reason);
    });
  }

  injectStyles();
  renderShell();
  log('dashboard', 'bootstrap start');
  initMessaging();
  bindEvents();
  syncFilterUi();
  syncSortUi();
  renderWarnings();
  updateStatusText('Connecting to main app...');
  log('request', 'startup snapshot request');
  sendMessage(TYPE_REQUEST_SNAPSHOT, { reason: 'startup' });

  liveTimer = window.setInterval(() => {
    refreshLiveTimes();
  }, 1000);
})();
