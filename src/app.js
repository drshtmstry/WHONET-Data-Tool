const isLocalHost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API = isLocalHost && (window.location.port === '7890' || window.location.port === '') ? '' : 'http://localhost:7890';

let state = {
  currentDb: null,
  databases: [],
  stats: {},
  isolatesPage: 1,
  dupsPage: 1,
  dupMode: 'spec', // 'spec' | 'patient'
  monthlyAmrData: null,
  fixHistory: [],
  confirmAction: null,
  isWasmMode: false,
  wasmDb: null,
  sqlJsInstance: null,
  dirHandle: null,
  fileHandles: {}, // filename -> FileSystemFileHandle or File
  activeFileHandle: null,
  isModified: false
};

// ── Utils ──
function getOrganismName(code) {
  if (!code) return '';
  const key = String(code).trim().toLowerCase();
  if (typeof window !== 'undefined' && window.ORGANISMS_DICT && window.ORGANISMS_DICT[key]) {
    return window.ORGANISMS_DICT[key];
  }
  return '';
}

function renderOrgBadge(code, extraStyle = '') {
  if (!code || code === '—') return '—';
  const name = getOrganismName(code);
  const titleAttr = name ? `title="${name} (${code})"` : `title="${code}"`;
  return `<span class="badge badge-org" ${titleAttr} style="${extraStyle}">${code}</span>`;
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success: '✓', error: '✗', info: 'ℹ' };
  el.innerHTML = `<span>${icons[type]}</span> ${msg}`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
const debouncedLoadIsolates = debounce(() => loadIsolates(1), 350);
const debouncedLoadDups = debounce(() => loadDuplicates(1), 350);

// ── sql.js WebAssembly Loader ──
async function getSqlJs() {
  if (state.sqlJsInstance) return state.sqlJsInstance;
  if (typeof window.initSqlJs !== 'function') {
    throw new Error('sql.js library not loaded in browser');
  }
  const SQL = await window.initSqlJs({
    locateFile: file => `vendor/${file}`
  });
  state.sqlJsInstance = SQL;
  return SQL;
}

// ── WASM Client-Side Database Engine ──
function wasmSelect(sql, params = []) {
  if (!state.wasmDb) throw new Error('No client-side SQLite database loaded');
  const stmt = state.wasmDb.prepare(sql);
  if (params && params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function wasmRun(sql, params = []) {
  if (!state.wasmDb) throw new Error('No client-side SQLite database loaded');
  state.wasmDb.run(sql, params);
  const changes = state.wasmDb.getRowsModified();
  if (changes > 0) {
    markModified();
  }
  return { changes };
}

function markModified() {
  state.isModified = true;
  const saveBtn = document.getElementById('btn-save-file');
  if (saveBtn) {
    if (state.activeFileHandle && typeof state.activeFileHandle.createWritable === 'function') {
      saveBtn.style.display = 'inline-flex';
      saveBtn.classList.remove('btn-outline');
      saveBtn.classList.add('btn-success');
      saveBtn.innerHTML = '💾 Save to File';
    }
  }
  const dlBtn = document.getElementById('btn-download-db');
  if (dlBtn && state.isWasmMode) {
    dlBtn.style.display = 'inline-flex';
  }
}

async function saveToFileHandle() {
  if (!state.wasmDb) return;
  const saveBtn = document.getElementById('btn-save-file');
  try {
    let handle = state.activeFileHandle;
    // If we don't have a direct file handle, or if it doesn't support writing, ask user to pick destination
    if (!handle || typeof handle.createWritable !== 'function') {
      if ('showSaveFilePicker' in window) {
        handle = await window.showSaveFilePicker({
          suggestedName: state.currentDb || 'WHONET_DATA.sqlite',
          types: [{
            description: 'SQLite Database',
            accept: { 'application/x-sqlite3': ['.sqlite'] }
          }]
        });
        state.activeFileHandle = handle;
      } else {
        // Fallback to direct export download
        return exportSqliteDatabase();
      }
    }

    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ Saving…';
    }

    const binaryArray = state.wasmDb.export();
    const writable = await handle.createWritable();
    await writable.write(binaryArray);
    await writable.close();

    state.isModified = false;
    toast(`✓ Successfully saved changes directly to ${handle.name || state.currentDb}`, 'success');

    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '💾 Saved ✓';
      setTimeout(() => {
        if (!state.isModified && saveBtn) {
          saveBtn.innerHTML = '💾 Save to File';
        }
      }, 2500);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      toast(`Save failed: ${err.message}`, 'error');
    }
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '💾 Save to File';
    }
  }
}

// ── Hybrid API Dispatcher (Local Node Server OR In-Browser WASM SQLite) ──
async function api(path, options = {}) {
  // If running in in-browser WASM mode, emulate API queries directly on the SQLite database
  if (state.isWasmMode) {
    return handleWasmApi(path, options);
  }

  try {
    const res = await fetch(API + path, options);
    if (!res.ok && res.status >= 500) {
      const err = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
      return { error: err.error || `HTTP ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    // If local server unreachable and user has a file loaded or drops a file, we can fall back to WASM
    return { error: `Network/Server error: ${err.message}` };
  }
}

// Emulate backend SQL operations in-browser for 100% web / offline usage
function handleWasmApi(path, options = {}) {
  try {
    const url = new URL(path, 'http://dummy');
    const pathname = url.pathname;
    const body = options.body ? (typeof options.body === 'string' ? JSON.parse(options.body) : options.body) : {};

    if (pathname === '/api/stats') {
      const total = wasmSelect('SELECT COUNT(*) as c FROM Isolates')[0]?.c || 0;
      const dupRows = wasmSelect(`
        SELECT COUNT(*) as c FROM Isolates WHERE SPEC_NUM IS NOT NULL AND SPEC_NUM != '' AND UPPER(SPEC_NUM) IN (
          SELECT UPPER(SPEC_NUM) FROM Isolates WHERE SPEC_NUM IS NOT NULL AND SPEC_NUM != '' GROUP BY UPPER(SPEC_NUM) HAVING COUNT(*) > 1
        )
      `)[0]?.c || 0;
      const dupGroups = wasmSelect(`
        SELECT COUNT(DISTINCT UPPER(SPEC_NUM)) as c FROM Isolates WHERE SPEC_NUM IS NOT NULL AND SPEC_NUM != '' GROUP BY UPPER(SPEC_NUM) HAVING COUNT(*) > 1
      `).length || 0;

      const dupPtRows = wasmSelect(`
        SELECT COUNT(*) as c FROM Isolates WHERE PATIENT_ID IS NOT NULL AND PATIENT_ID != '' AND UPPER(PATIENT_ID) IN (
          SELECT UPPER(PATIENT_ID) FROM Isolates WHERE PATIENT_ID IS NOT NULL AND PATIENT_ID != '' GROUP BY UPPER(PATIENT_ID) HAVING COUNT(*) > 1
        )
      `)[0]?.c || 0;
      const dupPtGroups = wasmSelect(`
        SELECT COUNT(DISTINCT UPPER(PATIENT_ID)) as c FROM Isolates WHERE PATIENT_ID IS NOT NULL AND PATIENT_ID != '' GROUP BY UPPER(PATIENT_ID) HAVING COUNT(*) > 1
      `).length || 0;

      const organisms = wasmSelect("SELECT DISTINCT ORGANISM FROM Isolates WHERE ORGANISM IS NOT NULL AND ORGANISM != '' ORDER BY ORGANISM").map(r => r.ORGANISM);
      const wards = wasmSelect("SELECT DISTINCT WARD FROM Isolates WHERE WARD IS NOT NULL AND WARD != '' ORDER BY WARD").map(r => r.WARD);

      return { total, dupRows, dupGroups, dupPtRows, dupPtGroups, organisms, wards };
    }

    if (pathname === '/api/isolates') {
      const page = parseInt(url.searchParams.get('page') || '1');
      const pageSize = parseInt(url.searchParams.get('pageSize') || '50');
      const search = (url.searchParams.get('search') || '').trim();
      const organism = (url.searchParams.get('organism') || '').trim();
      const ward = (url.searchParams.get('ward') || '').trim();
      const offset = (page - 1) * pageSize;

      let whereClauses = [];
      let params = [];
      if (search) {
        whereClauses.push("(SPEC_NUM LIKE ? OR PATIENT_ID LIKE ? OR FULL_NAME LIKE ? OR ORGANISM LIKE ?)");
        const s = `%${search}%`;
        params.push(s, s, s, s);
      }
      if (organism) {
        whereClauses.push("ORGANISM = ?");
        params.push(organism);
      }
      if (ward) {
        whereClauses.push("WARD = ?");
        params.push(ward);
      }
      const whereSql = whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : '';

      const countSql = `SELECT COUNT(*) as c FROM Isolates ${whereSql}`;
      const totalCount = wasmSelect(countSql, params)[0]?.c || 0;

      const rowsSql = `
        SELECT ROW_IDX, SPEC_NUM, SPEC_DATE, SPEC_TYPE, ORGANISM, FULL_NAME, SEX, AGE, WARD, DEPARTMENT,
               ESBL, CARBAPENEM, MRSA
        FROM Isolates
        ${whereSql}
        ORDER BY ROW_IDX DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `;
      const rows = wasmSelect(rowsSql, params);
      return { rows, totalCount };
    }

    if (pathname === '/api/duplicates') {
      const page = parseInt(url.searchParams.get('page') || '1');
      const pageSize = parseInt(url.searchParams.get('pageSize') || '200');
      const mode = (url.searchParams.get('mode') || 'spec').toLowerCase();
      const search = (url.searchParams.get('search') || '').trim();
      const offset = (page - 1) * pageSize;

      const groupCol = mode === 'patient' ? 'UPPER(PATIENT_ID)' : 'UPPER(SPEC_NUM)';
      const notEmptyCond = mode === 'patient' ? "PATIENT_ID IS NOT NULL AND PATIENT_ID != ''" : "SPEC_NUM IS NOT NULL AND SPEC_NUM != ''";

      let searchCond = '';
      let params = [];
      if (search) {
        searchCond = `AND (${groupCol} LIKE ? OR UPPER(FULL_NAME) LIKE ?)`;
        params.push(`%${search.toUpperCase()}%`, `%${search.toUpperCase()}%`);
      }

      const dupSql = `
        WITH RankedIsolates AS (
          SELECT *,
                 ROW_NUMBER() OVER (PARTITION BY ${groupCol} ORDER BY ROW_IDX) AS row_num,
                 COUNT(*) OVER (PARTITION BY ${groupCol}) AS total_duplicates
          FROM Isolates
          WHERE ${notEmptyCond}
        )
        SELECT ROW_IDX, PATIENT_ID, SPEC_DATE, SPEC_NUM, SPEC_TYPE, ORGANISM, FULL_NAME, SEX, AGE, WARD, DEPARTMENT, row_num, total_duplicates
        FROM RankedIsolates
        WHERE total_duplicates > 1 ${searchCond}
        ORDER BY ${groupCol}, row_num
        LIMIT ${pageSize} OFFSET ${offset}
      `;
      const rows = wasmSelect(dupSql, params);

      const countSql = `
        SELECT COUNT(*) as c FROM (
          SELECT ROW_IDX, COUNT(*) OVER (PARTITION BY ${groupCol}) AS total_duplicates
          FROM Isolates
          WHERE ${notEmptyCond}
        ) WHERE total_duplicates > 1 ${searchCond}
      `;
      const totalCount = wasmSelect(countSql, params)[0]?.c || 0;
      return { rows, totalCount };
    }

    if (pathname.startsWith('/api/isolate/')) {
      const rowIdx = parseInt(pathname.split('/').pop());
      const rows = wasmSelect('SELECT * FROM Isolates WHERE ROW_IDX = ?', [rowIdx]);
      if (!rows.length) return { error: 'Not found' };
      return { row: rows[0] };
    }

    if (pathname === '/api/delete-row') {
      const { row_idx } = body;
      const res = wasmRun('DELETE FROM Isolates WHERE ROW_IDX = ?', [row_idx]);
      return { ok: true, changes: res.changes };
    }

    if (pathname === '/api/delete-duplicates') {
      const { spec_num, patient_id, mode } = body;
      let sql = '';
      if (mode === 'patient') {
        sql = `DELETE FROM Isolates WHERE PATIENT_ID IS NOT NULL AND PATIENT_ID != '' AND ROW_IDX NOT IN (
          SELECT MIN(ROW_IDX) FROM Isolates WHERE PATIENT_ID IS NOT NULL AND PATIENT_ID != '' GROUP BY UPPER(PATIENT_ID)
        )`;
      } else if (patient_id) {
        const safe = patient_id.replace(/'/g, "''");
        sql = `DELETE FROM Isolates WHERE ROW_IDX NOT IN (
          SELECT MIN(ROW_IDX) FROM Isolates WHERE UPPER(PATIENT_ID) = UPPER('${safe}')
        ) AND UPPER(PATIENT_ID) = UPPER('${safe}')`;
      } else if (spec_num) {
        const safe = spec_num.replace(/'/g, "''");
        sql = `DELETE FROM Isolates WHERE ROW_IDX NOT IN (
          SELECT MIN(ROW_IDX) FROM Isolates WHERE UPPER(SPEC_NUM) = UPPER('${safe}')
        ) AND UPPER(SPEC_NUM) = UPPER('${safe}')`;
      } else {
        sql = `DELETE FROM Isolates WHERE SPEC_NUM IS NOT NULL AND SPEC_NUM != '' AND ROW_IDX NOT IN (
          SELECT MIN(ROW_IDX) FROM Isolates WHERE SPEC_NUM IS NOT NULL AND SPEC_NUM != '' GROUP BY UPPER(SPEC_NUM)
        )`;
      }
      const res = wasmRun(sql);
      return { ok: true, changes: res.changes };
    }

    if (pathname === '/api/bulk-fix') {
      const { operation } = body;
      let sql = '';
      let description = '';
      if (operation === 'upper_spec_num') {
        sql = "UPDATE Isolates SET SPEC_NUM = UPPER(SPEC_NUM) WHERE SPEC_NUM != UPPER(SPEC_NUM)";
        description = 'SPEC_NUM → UPPERCASE';
      } else if (operation === 'trim_all') {
        sql = `UPDATE Isolates SET SPEC_NUM = TRIM(SPEC_NUM), PATIENT_ID = TRIM(PATIENT_ID), FULL_NAME = TRIM(FULL_NAME), WARD = TRIM(WARD), DEPARTMENT = TRIM(DEPARTMENT)`;
        description = 'Trim whitespace from text fields';
      } else if (operation === 'upper_patient_id') {
        sql = "UPDATE Isolates SET PATIENT_ID = UPPER(PATIENT_ID) WHERE PATIENT_ID != UPPER(PATIENT_ID)";
        description = 'PATIENT_ID → UPPERCASE';
      } else if (operation === 'upper_organism') {
        sql = "UPDATE Isolates SET ORGANISM = LOWER(ORGANISM) WHERE ORGANISM != LOWER(ORGANISM)";
        description = 'ORGANISM → lowercase';
      } else {
        return { error: 'Unknown operation' };
      }
      const res = wasmRun(sql);
      return { ok: true, description, changes: res.changes };
    }

    if (pathname === '/api/update-field') {
      const { row_idx, field, value } = body;
      const EDITABLE_FIELDS = ['SPEC_NUM', 'PATIENT_ID', 'SPEC_TYPE', 'ORGANISM', 'FULL_NAME', 'SEX', 'AGE', 'WARD', 'DEPARTMENT', 'COMMENT', 'ESBL', 'CARBAPENEM', 'MRSA', 'URINECOUNT', 'SEROTYPE', 'BETA_LACT', 'INDUC_CLI'];
      if (!EDITABLE_FIELDS.includes(field)) return { error: 'Field not editable' };
      const res = wasmRun(`UPDATE Isolates SET ${field} = ? WHERE ROW_IDX = ?`, [value, row_idx]);
      return { ok: true, changes: res.changes };
    }

    if (pathname === '/api/custom-sql') {
      const { sql } = body;
      if (!sql || !sql.trim()) return { error: 'Empty SQL' };
      const trimmed = sql.trim().toUpperCase();
      if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
        const rows = wasmSelect(sql);
        const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
        return { type: 'select', rows, columns, count: rows.length };
      } else {
        const res = wasmRun(sql);
        return { type: 'update', changes: res.changes };
      }
    }

    if (pathname === '/api/monthly-amr') {
      const rows = wasmSelect(`
        SELECT ROW_IDX, SPEC_NUM, SPEC_DATE, SPEC_TYPE, WARD_TYPE, WARD, DEPARTMENT, ORGANISM
        FROM Isolates
        WHERE SPEC_DATE IS NOT NULL AND LENGTH(SPEC_DATE) >= 7
      `);

      const monthMap = {};
      const bloodNoGrowth = ['xxx', 'xpa', 'xep', 'xsg', 'nor', 'scn', ''];
      const othersNoGrowth = ['xxx', 'xpa', 'xep', 'xsg', 'nor', 'ora', 'vag', ''];

      for (const r of rows) {
        const ym = (r.SPEC_DATE || '').substring(0, 7);
        if (!/^\d{4}-\d{2}$/.test(ym)) continue;

        if (!monthMap[ym]) {
          monthMap[ym] = {
            month: ym,
            totalRows: 0,
            srcSamples: { opd: 0, ipd: 0, icu: 0, others: 0, total: 0 },
            srcPositives: { opd: 0, ipd: 0, icu: 0, others: 0, total: 0 },
            typeSamples: { blood: 0, pus: 0, sputum: 0, urine: 0, others: 0, total: 0 },
            typePositives: { blood: 0, pus: 0, sputum: 0, urine: 0, others: 0, total: 0 }
          };
        }

        const m = monthMap[ym];
        m.totalRows++;

        const wt = (r.WARD_TYPE || '').toLowerCase();
        const st = (r.SPEC_TYPE || '').toLowerCase();
        const org = (r.ORGANISM || '').toLowerCase().trim();

        const isPos = st === 'bl'
          ? !bloodNoGrowth.includes(org)
          : !othersNoGrowth.includes(org);

        if (wt === 'out') {
          m.srcSamples.opd++;
          if (isPos) m.srcPositives.opd++;
        } else if (wt === 'in') {
          m.srcSamples.ipd++;
          if (isPos) m.srcPositives.ipd++;
        } else if (wt === 'icu') {
          m.srcSamples.icu++;
          if (isPos) m.srcPositives.icu++;
        } else {
          m.srcSamples.others++;
          if (isPos) m.srcPositives.others++;
        }

        if (st === 'bl') {
          m.typeSamples.blood++;
          if (isPos) m.typePositives.blood++;
        } else if (st === 'ps') {
          m.typeSamples.pus++;
          if (isPos) m.typePositives.pus++;
        } else if (st === 'sp') {
          m.typeSamples.sputum++;
          if (isPos) m.typePositives.sputum++;
        } else if (st === 'ur') {
          m.typeSamples.urine++;
          if (isPos) m.typePositives.urine++;
        } else {
          m.typeSamples.others++;
          if (isPos) m.typePositives.others++;
        }
      }

      const sortedMonths = Object.keys(monthMap).sort((a, b) => b.localeCompare(a));
      const monthlyData = sortedMonths.map(ym => {
        const m = monthMap[ym];
        m.srcSamples.total = m.srcSamples.opd + m.srcSamples.ipd + m.srcSamples.icu + m.srcSamples.others;
        m.srcPositives.total = m.srcPositives.opd + m.srcPositives.ipd + m.srcPositives.icu + m.srcPositives.others;
        m.typeSamples.total = m.typeSamples.blood + m.typeSamples.pus + m.typeSamples.sputum + m.typeSamples.urine + m.typeSamples.others;
        m.typePositives.total = m.typePositives.blood + m.typePositives.pus + m.typePositives.sputum + m.typePositives.urine + m.typePositives.others;
        return m;
      });

      return { months: sortedMonths, monthlyData };
    }

    if (pathname === '/api/chart-data') {
      const param = (url.searchParams.get('param') || 'ORGANISM').toUpperCase();
      const period = url.searchParams.get('period') || 'all';
      const startDate = url.searchParams.get('startDate') || '';
      const endDate = url.searchParams.get('endDate') || '';

      const whereClauses = [];
      const params = [];

      if (startDate) {
        whereClauses.push("SPEC_DATE >= ?");
        params.push(startDate);
      }
      if (endDate) {
        whereClauses.push("SPEC_DATE <= ?");
        params.push(endDate);
      }

      if (!startDate && !endDate && period !== 'all') {
        const maxDateRow = wasmSelect("SELECT MAX(SPEC_DATE) as m FROM Isolates WHERE SPEC_DATE IS NOT NULL AND SPEC_DATE != ''")[0];
        if (maxDateRow && maxDateRow.m) {
          const maxD = new Date(maxDateRow.m.substring(0, 10));
          if (!isNaN(maxD.getTime())) {
            let monthsBack = 3;
            if (period === '6m') monthsBack = 6;
            if (period === '12m') monthsBack = 12;
            const cutoff = new Date(maxD);
            cutoff.setMonth(cutoff.getMonth() - monthsBack);
            const cutoffStr = cutoff.toISOString().substring(0, 10);
            whereClauses.push("SPEC_DATE >= ?");
            params.push(cutoffStr);
          }
        }
      }

      let selectExpr = param;
      if (param === 'AGE_GROUP') {
        selectExpr = `
          CASE
            WHEN CAST(AGE AS INTEGER) < 1 THEN '<1 yr'
            WHEN CAST(AGE AS INTEGER) BETWEEN 1 AND 12 THEN '1-12 yrs'
            WHEN CAST(AGE AS INTEGER) BETWEEN 13 AND 25 THEN '13-25 yrs'
            WHEN CAST(AGE AS INTEGER) BETWEEN 26 AND 45 THEN '26-45 yrs'
            WHEN CAST(AGE AS INTEGER) BETWEEN 46 AND 65 THEN '46-65 yrs'
            WHEN CAST(AGE AS INTEGER) > 65 THEN '>65 yrs'
            ELSE 'Unknown'
          END
        `;
      }

      const whereSql = whereClauses.length
        ? `WHERE ${selectExpr} IS NOT NULL AND ${selectExpr} != '' AND ` + whereClauses.join(' AND ')
        : `WHERE ${selectExpr} IS NOT NULL AND ${selectExpr} != ''`;

      const querySql = `
        SELECT ${selectExpr} as label, COUNT(*) as count
        FROM Isolates
        ${whereSql}
        GROUP BY label
        ORDER BY count DESC
        LIMIT 15
      `;

      const rows = wasmSelect(querySql, params);
      const totalFiltered = wasmSelect(`SELECT COUNT(*) as c FROM Isolates ${whereClauses.length ? 'WHERE ' + whereClauses.join(' AND ') : ''}`, params)[0]?.c || 0;

      return {
        param,
        period,
        totalFiltered,
        rows
      };
    }

    return { error: `Unhandled WASM route: ${pathname}` };
  } catch (err) {
    return { error: `WASM Execution error: ${err.message}` };
  }
}

function fmtDate(d) {
  if (!d) return '—';
  return d.substring(0, 10);
}

// ── Navigation ──
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');

  if (name === 'isolates' && state.currentDb) loadIsolates(1);
  if (name === 'duplicates' && state.currentDb) loadDuplicates(1);
  if (name === 'dashboard' && state.currentDb) loadStats();
  if (name === 'monthly-amr' && state.currentDb) loadMonthlyAmrData();
}

// ── Init ──
async function init() {
  const badge = document.getElementById('runtime-badge');
  try {
    const data = await fetch(API + '/api/databases').then(r => r.json());
    if (data && Array.isArray(data.databases)) {
      state.isWasmMode = false;
      state.databases = data.databases;
      state.currentDb = data.current;
      if (badge) {
        badge.textContent = '⚡ Local Server Connected';
        badge.style.background = 'rgba(74, 222, 128, 0.15)';
        badge.style.color = 'var(--green)';
      }
      renderDbSelector();
      if (state.currentDb) {
        await loadStats();
      }
      return;
    }
  } catch (e) {
    console.info('Local server not found or running on web, enabling in-browser SQLite mode:', e.message);
  }

  // If local server is not accessible (e.g. running on Vercel / GitHub Pages / static)
  state.isWasmMode = true;
  if (badge) {
    badge.textContent = '🌐 In-Browser Client Mode (WASM)';
    badge.style.background = 'rgba(96, 165, 250, 0.15)';
    badge.style.color = 'var(--accent)';
  }
  const btnOpenPath = document.getElementById('btn-open-path');
  if (btnOpenPath) btnOpenPath.style.display = 'none';
  renderDbSelector();
  await restoreWhonetFolder();
}

function renderDbSelector() {
  const sel = document.getElementById('db-select');
  if (state.isWasmMode && !state.databases.length) {
    sel.innerHTML = '<option value="">(Drop or browse .sqlite file)</option>';
    return;
  }
  sel.innerHTML = state.databases.map(db =>
    `<option value="${db}" ${db === state.currentDb ? 'selected' : ''}>${db.replace('.sqlite', '')}</option>`
  ).join('');
}

async function switchDb(filename) {
  if (!filename || filename === state.currentDb) return;

  if (state.isWasmMode) {
    const handleOrFile = state.fileHandles[filename];
    if (handleOrFile) {
      if (typeof handleOrFile.getFile === 'function') {
        const file = await handleOrFile.getFile();
        await handleFileUpload(file, handleOrFile);
      } else if (handleOrFile instanceof File || handleOrFile instanceof Blob) {
        await handleFileUpload(handleOrFile, null);
      }
      return;
    }
    // If not found in fileHandles, warn user
    return toast(`Cannot switch to ${filename} directly without file access.`, 'info');
  }

  const data = await api('/api/open-database', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename })
  });
  if (data.error) return toast(data.error, 'error');
  state.currentDb = filename;
  renderDbSelector();
  toast(`Switched to ${filename} (${data.count.toLocaleString()} records)`, 'success');
  loadStats();
}

// ── Export / Download .sqlite (for in-browser WASM changes) ──
function exportSqliteDatabase() {
  if (!state.wasmDb) {
    return toast('Download is only needed when editing in-browser WASM mode', 'info');
  }
  try {
    const binaryArray = state.wasmDb.export();
    const blob = new Blob([binaryArray], { type: 'application/x-sqlite3' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.currentDb || 'whonet_database.sqlite';
    a.click();
    URL.revokeObjectURL(url);
    toast(`✓ Downloaded ${state.currentDb}`, 'success');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  }
}

// ── Load Bundled Sample Database (Online WASM or Local Server) ──
async function loadSampleDatabase(sampleFilename) {
  toast(`Loading sample ${sampleFilename}…`, 'info');
  try {
    // If running in local server mode and file is present in WHONET_DIR, switch normally
    if (!state.isWasmMode && state.databases.includes(sampleFilename)) {
      await switchDb(sampleFilename);
      return;
    }

    // Otherwise fetch the bundled sample .sqlite file via HTTP and load into WASM engine
    const res = await fetch(`/sample-data/${sampleFilename}`);
    if (!res.ok) {
      throw new Error(`Failed to download ${sampleFilename} (${res.status})`);
    }
    const arrayBuffer = await res.arrayBuffer();
    const uInt8Array = new Uint8Array(arrayBuffer);
    const SQL = await getSqlJs();
    const db = new SQL.Database(uInt8Array);

    state.isWasmMode = true;
    state.wasmDb = db;
    state.currentDb = sampleFilename;
    if (!state.databases.includes(sampleFilename)) {
      state.databases.push(sampleFilename);
    }

    const badge = document.getElementById('runtime-badge');
    if (badge) {
      badge.textContent = '🌐 In-Browser WASM Mode';
      badge.style.background = 'rgba(96, 165, 250, 0.15)';
      badge.style.color = 'var(--accent)';
    }

    const dlBtn = document.getElementById('btn-download-db');
    if (dlBtn) dlBtn.style.display = 'inline-flex';

    renderDbSelector();
    const count = wasmSelect('SELECT COUNT(*) as c FROM Isolates')[0]?.c || 0;
    toast(`Loaded sample ${sampleFilename} (${count.toLocaleString()} records)`, 'success');
    loadStats();
  } catch (err) {
    toast(`Failed to load sample database: ${err.message}`, 'error');
  }
}

// ── Handle Upload / Drag & Drop (Supports both Local Node Server & In-Browser WASM) ──
async function handleFileUpload(file, fileHandle = null) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.sqlite')) {
    return toast('Please drop/upload a valid .sqlite file', 'error');
  }

  toast(`Reading ${file.name}…`, 'info');

  // If connected to local Node backend, send to server
  if (!state.isWasmMode) {
    try {
      const res = await fetch(API + '/api/upload-database?filename=' + encodeURIComponent(file.name), {
        method: 'POST',
        body: file
      });
      const data = await res.json();
      if (data.error) return toast(data.error, 'error');

      if (data.databases) state.databases = data.databases;
      state.currentDb = data.filename;
      renderDbSelector();
      toast(`Successfully loaded ${data.filename} (${data.count.toLocaleString()} records)`, 'success');
      loadStats();
      return;
    } catch (err) {
      console.warn('Local upload failed, falling back to client-side WASM engine:', err.message);
    }
  }

  // Client-side WASM SQLite fallback / Web mode
  try {
    const SQL = await getSqlJs();
    const arrayBuffer = await file.arrayBuffer();
    const uInt8Array = new Uint8Array(arrayBuffer);
    const db = new SQL.Database(uInt8Array);

    state.isWasmMode = true;
    state.wasmDb = db;
    state.currentDb = file.name;
    state.activeFileHandle = fileHandle;
    state.fileHandles[file.name] = fileHandle || file;
    state.isModified = false;

    if (!state.databases.includes(file.name)) {
      state.databases.push(file.name);
    }

    const badge = document.getElementById('runtime-badge');
    if (badge) {
      badge.textContent = '🌐 In-Browser WASM Mode';
      badge.style.background = 'rgba(96, 165, 250, 0.15)';
      badge.style.color = 'var(--accent)';
    }

    const saveBtn = document.getElementById('btn-save-file');
    if (saveBtn) {
      if (fileHandle && typeof fileHandle.createWritable === 'function') {
        saveBtn.style.display = 'inline-flex';
        saveBtn.innerHTML = '💾 Save to File';
      } else {
        saveBtn.style.display = 'none';
      }
    }

    const dlBtn = document.getElementById('btn-download-db');
    if (dlBtn) dlBtn.style.display = 'inline-flex';

    renderDbSelector();
    const count = wasmSelect('SELECT COUNT(*) as c FROM Isolates')[0]?.c || 0;
    toast(`Successfully loaded ${file.name} into browser (${count.toLocaleString()} records)`, 'success');
    loadStats();
  } catch (err) {
    toast(`Failed to load SQLite file in browser: ${err.message}`, 'error');
  }
}

function handleFileDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  const dropzone = document.getElementById('global-dropzone');
  if (dropzone) dropzone.classList.remove('dragover');

  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    handleFileUpload(files[0]);
  }
}

// ── Stats / Dashboard ──
async function loadStats() {
  if (!state.currentDb) return;
  document.getElementById('db-label').textContent = state.currentDb;
  const data = await api('/api/stats');
  if (data.error) return toast(data.error, 'error');
  state.stats = data;

  // Update badge
  const activeDupCount = state.dupMode === 'patient' ? (data.dupPtRows || 0) : (data.dupRows || 0);
  document.getElementById('dup-badge').textContent = activeDupCount;

  // Populate filters
  const orgFilter = document.getElementById('isolates-org-filter');
  orgFilter.innerHTML = '<option value="">All Organisms</option>' +
    data.organisms.map(o => {
      const name = getOrganismName(o);
      const label = name ? `${o} — ${name}` : o;
      return `<option value="${o}">${label}</option>`;
    }).join('');
  const wardFilter = document.getElementById('isolates-ward-filter');
  wardFilter.innerHTML = '<option value="">All Wards</option>' +
    data.wards.map(w => `<option value="${w}">${w}</option>`).join('');

  // Organisms list (if present in DOM)
  const orgListEl = document.getElementById('org-list');
  if (orgListEl) {
    orgListEl.innerHTML = data.organisms.slice(0, 20).map(o => {
      const name = getOrganismName(o);
      const titleAttr = name ? `title="${name} (${o})"` : `title="${o}"`;
      return `<span class="badge badge-org" ${titleAttr} style="cursor:pointer" onclick="showPage('isolates');document.getElementById('isolates-org-filter').value='${o}';loadIsolates(1)">${o}</span>`;
    }).join('');
  }

  // Refresh dynamic visual charts
  updateDashboardCharts();

  if (document.getElementById('page-monthly-amr')?.classList.contains('active')) {
    loadMonthlyAmrData();
  }
}

// ── Dynamic Visual Analytics (Chart.js Engine) ──
let barChartInstance = null;
let pieChartInstance = null;
let currentChartDisplayMode = 'both'; // 'both' | 'bar' | 'pie'

function setChartTypeMode(mode) {
  currentChartDisplayMode = mode;
  const grid = document.getElementById('charts-view-grid');
  if (grid) {
    grid.classList.remove('single-bar', 'single-pie');
    if (mode === 'bar') grid.classList.add('single-bar');
    if (mode === 'pie') grid.classList.add('single-pie');
  }

  ['both', 'bar', 'pie'].forEach(m => {
    const btn = document.getElementById(`btn-chart-${m}`);
    if (btn) btn.classList.toggle('active', m === mode);
  });

  if (barChartInstance) barChartInstance.resize();
  if (pieChartInstance) pieChartInstance.resize();
}

function onPeriodFilterChange() {
  const period = document.getElementById('chart-period-select')?.value || 'all';
  const customDates = document.getElementById('chart-custom-dates');
  if (customDates) {
    customDates.style.display = period === 'custom' ? 'flex' : 'none';
  }
  updateDashboardCharts();
}

function resetChartZoom(chartType) {
  if (chartType === 'bar' && barChartInstance) {
    barChartInstance.resetZoom ? barChartInstance.resetZoom() : barChartInstance.update();
  }
  updateDashboardCharts();
}

const PALETTE_COLORS = [
  '#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed',
  '#0891b2', '#db2777', '#4f46e5', '#ca8a04', '#16a34a',
  '#ea580c', '#9333ea', '#0284c7', '#65a30d', '#64748b'
];

async function updateDashboardCharts() {
  if (!state.currentDb) return;
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js library is not yet loaded');
    return;
  }

  const param = document.getElementById('chart-param-select')?.value || 'ORGANISM';
  const period = document.getElementById('chart-period-select')?.value || 'all';
  const startDate = document.getElementById('chart-date-start')?.value || '';
  const endDate = document.getElementById('chart-date-end')?.value || '';

  const queryParams = new URLSearchParams({
    param,
    period,
    startDate,
    endDate
  });

  const res = await api(`/api/chart-data?${queryParams.toString()}`);
  if (res.error) {
    console.warn('Chart data query failed:', res.error);
    return;
  }

  const rows = res.rows || [];
  const totalFiltered = res.totalFiltered || 0;

  // Update subtitle info
  const sub = document.getElementById('chart-filtered-sub');
  const paramText = document.getElementById('chart-param-select')?.selectedOptions[0]?.text || param;
  if (sub) {
    const periodText = period === 'custom'
      ? `Range: ${startDate || 'start'} to ${endDate || 'end'}`
      : document.getElementById('chart-period-select')?.selectedOptions[0]?.text || period;
    sub.textContent = `${paramText} • ${periodText} • ${totalFiltered.toLocaleString()} isolates matched`;
  }

  const pieBadge = document.getElementById('pie-total-badge');
  if (pieBadge) {
    pieBadge.textContent = `${totalFiltered.toLocaleString()} records`;
  }

  // Format Labels with human-friendly descriptions
  const labels = rows.map(r => {
    let label = String(r.label || 'Unknown');
    if (param === 'ORGANISM') {
      const orgName = getOrganismName(label);
      if (orgName) return `${orgName} (${label})`;
    }
    if (param === 'SPEC_TYPE') {
      const dict = { bl: 'Blood (bl)', ps: 'Pus (ps)', sp: 'Sputum (sp)', ur: 'Urine (ur)', st: 'Stool (st)', cs: 'CSF (cs)' };
      if (dict[label.toLowerCase()]) return dict[label.toLowerCase()];
    }
    if (param === 'WARD_TYPE') {
      const dict = { in: 'Inpatient (in)', out: 'Outpatient (out)', icu: 'ICU (icu)' };
      if (dict[label.toLowerCase()]) return dict[label.toLowerCase()];
    }
    if (param === 'SEX') {
      const dict = { m: 'Male (m)', f: 'Female (f)', u: 'Unknown (u)' };
      if (dict[label.toLowerCase()]) return dict[label.toLowerCase()];
    }
    return label;
  });

  const counts = rows.map(r => r.count);
  const bgColors = rows.map((_, i) => PALETTE_COLORS[i % PALETTE_COLORS.length]);

  // ── Render Bar Chart ──
  const barCanvas = document.getElementById('dashboard-bar-chart');
  if (barCanvas) {
    const barCtx = barCanvas.getContext('2d');
    if (barChartInstance) barChartInstance.destroy();

    barChartInstance = new Chart(barCtx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Isolates Count',
          data: counts,
          backgroundColor: bgColors.map(c => c + 'cc'),
          borderColor: bgColors,
          borderWidth: 1.5,
          borderRadius: 5,
          maxBarThickness: 38
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            titleFont: { family: 'Inter', size: 12, weight: 'bold' },
            bodyFont: { family: 'Inter', size: 12 },
            padding: 10,
            callbacks: {
              label: ctx => {
                const cnt = ctx.parsed.y || 0;
                const pct = totalFiltered > 0 ? ((cnt / totalFiltered) * 100).toFixed(1) : '0.0';
                return `Count: ${cnt.toLocaleString()} (${pct}%)`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              font: { family: 'Inter', size: 11 },
              color: '#475569',
              maxRotation: 40,
              minRotation: 0,
              callback: function (val, index) {
                const raw = labels[index] || '';
                return raw.length > 20 ? raw.substring(0, 18) + '…' : raw;
              }
            }
          },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(226, 232, 240, 0.8)' },
            ticks: {
              font: { family: 'JetBrains Mono', size: 11 },
              color: '#64748b',
              precision: 0
            }
          }
        }
      }
    });
  }

  // ── Render Pie / Doughnut Chart ──
  const pieCanvas = document.getElementById('dashboard-pie-chart');
  if (pieCanvas) {
    const pieCtx = pieCanvas.getContext('2d');
    if (pieChartInstance) pieChartInstance.destroy();

    pieChartInstance = new Chart(pieCtx, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{
          data: counts,
          backgroundColor: bgColors,
          borderColor: '#ffffff',
          borderWidth: 2,
          hoverOffset: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 400 },
        plugins: {
          legend: {
            position: 'right',
            labels: {
              boxWidth: 12,
              boxHeight: 12,
              padding: 8,
              font: { family: 'Inter', size: 11 },
              color: '#334155',
              generateLabels: function (chart) {
                const data = chart.data;
                if (data.labels.length && data.datasets.length) {
                  return data.labels.map((lbl, i) => {
                    const val = data.datasets[0].data[i] || 0;
                    const pct = totalFiltered > 0 ? ((val / totalFiltered) * 100).toFixed(1) : 0;
                    const shortLbl = lbl.length > 16 ? lbl.substring(0, 14) + '…' : lbl;
                    return {
                      text: `${shortLbl} (${pct}%)`,
                      fillStyle: data.datasets[0].backgroundColor[i],
                      strokeStyle: '#fff',
                      lineWidth: 1,
                      index: i
                    };
                  });
                }
                return [];
              }
            }
          },
          tooltip: {
            backgroundColor: 'rgba(15, 23, 42, 0.95)',
            titleFont: { family: 'Inter', size: 12, weight: 'bold' },
            bodyFont: { family: 'Inter', size: 12 },
            padding: 10,
            callbacks: {
              label: ctx => {
                const cnt = ctx.parsed || 0;
                const pct = totalFiltered > 0 ? ((cnt / totalFiltered) * 100).toFixed(1) : '0.0';
                return ` ${cnt.toLocaleString()} isolates (${pct}%)`;
              }
            }
          }
        },
        cutout: '58%'
      }
    });
  }
}

// ── Isolates table ──
async function loadIsolates(page = 1) {
  state.isolatesPage = page;
  const search = encodeURIComponent(document.getElementById('isolates-search').value);
  const org = encodeURIComponent(document.getElementById('isolates-org-filter').value);
  const ward = encodeURIComponent(document.getElementById('isolates-ward-filter').value);
  const data = await api(`/api/isolates?page=${page}&pageSize=50&search=${search}&organism=${org}&ward=${ward}`);
  if (data.error) return toast(data.error, 'error');

  document.getElementById('isolates-count').textContent = `${data.totalCount.toLocaleString()} records`;
  document.getElementById('isolates-table-body').innerHTML = renderIsolatesTable(data.rows);
  renderPagination('isolates-pagination', page, data.totalCount, 50, loadIsolates);
}

function renderIsolatesTable(rows) {
  if (!rows.length) return `<div class="empty"><div class="empty-icon">🔍</div><div class="empty-title">No records found</div></div>`;
  return `<table>
    <thead><tr>
      <th>Row</th><th>Specimen #</th><th>Date</th><th>Type</th><th>Organism</th>
      <th>Sex</th><th>Age</th><th>Ward</th><th>ESBL</th><th>Carbapenem</th><th>MRSA</th><th>Actions</th>
    </tr></thead>
    <tbody>
    ${rows.map(r => `<tr>
      <td class="mono">${r.ROW_IDX}</td>
      <td class="mono">${r.SPEC_NUM || '—'}</td>
      <td>${fmtDate(r.SPEC_DATE)}</td>
      <td>${r.SPEC_TYPE || '—'}</td>
      <td>${renderOrgBadge(r.ORGANISM)}</td>
      <td>${r.SEX || '—'}</td>
      <td>${r.AGE || '—'}</td>
      <td>${r.WARD || '—'}</td>
      <td>${r.ESBL ? `<span class="badge badge-${r.ESBL === '+' ? 'r' : 's'}">${r.ESBL}</span>` : '—'}</td>
      <td>${r.CARBAPENEM ? `<span class="badge badge-${r.CARBAPENEM === '+' ? 'r' : 's'}">${r.CARBAPENEM}</span>` : '—'}</td>
      <td>${r.MRSA ? `<span class="badge badge-${r.MRSA === '+' ? 'r' : 's'}">${r.MRSA}</span>` : '—'}</td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="viewDetail(${r.ROW_IDX})">View</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeleteRow(${r.ROW_IDX}, '${r.SPEC_NUM}')">Del</button>
      </td>
    </tr>`).join('')}
    </tbody>
  </table>`;
}

// ── Fix casing ──
async function fixCasingAndRefresh() {
  const data = await api('/api/bulk-fix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'upper_spec_num' })
  });
  if (data.error) return toast(data.error, 'error');
  if (data.changes === 0) {
    toast('All SPEC_NUMs are already uppercase', 'info');
  } else {
    toast(`✓ Normalized ${data.changes} SPEC_NUM(s) to UPPERCASE`, 'success');
  }
  document.getElementById('casing-banner').style.display = 'none';
  loadStats();
  loadDuplicates(state.dupsPage);
}

function setDupMode(mode) {
  if (state.dupMode === mode) return;
  state.dupMode = mode;
  document.getElementById('mode-btn-spec').classList.toggle('active', mode === 'spec');
  document.getElementById('mode-btn-patient').classList.toggle('active', mode === 'patient');

  const searchInput = document.getElementById('dup-search');
  searchInput.placeholder = mode === 'patient'
    ? 'Search by Patient ID or Name…'
    : 'Search by Specimen # or Name…';
  searchInput.value = '';

  if (state.stats) {
    const activeCount = mode === 'patient' ? (state.stats.dupPtRows || 0) : (state.stats.dupRows || 0);
    document.getElementById('dup-badge').textContent = activeCount;
  }

  loadDuplicates(1);
}

// ── Duplicates table ──
async function loadDuplicates(page = 1) {
  state.dupsPage = page;
  const search = encodeURIComponent(document.getElementById('dup-search').value);
  const mode = state.dupMode;

  // Check for mixed-case SPEC_NUMs and show/hide warning banner
  const casingCheck = await api('/api/custom-sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: "SELECT COUNT(*) as c FROM Isolates WHERE SPEC_NUM != UPPER(SPEC_NUM) AND SPEC_NUM != ''" })
  });
  const hasMixedCase = casingCheck.rows?.[0]?.c > 0;
  document.getElementById('casing-banner').style.display = hasMixedCase ? 'flex' : 'none';

  const data = await api(`/api/duplicates?page=${page}&pageSize=200&search=${search}&mode=${mode}`);
  if (data.error) return toast(data.error, 'error');

  const modeLabel = mode === 'patient' ? 'Patient ID' : 'Specimen ID';
  const groups = groupRows(data.rows, mode);
  const groupCount = Object.keys(groups).length;

  document.getElementById('dup-count').textContent =
    `${data.totalCount.toLocaleString()} duplicate rows in ${groupCount.toLocaleString()} groups (grouped by ${modeLabel})`;

  if (!data.rows.length) {
    document.getElementById('dup-table-body').innerHTML =
      `<div class="empty"><div class="empty-icon">✅</div><div class="empty-title">No duplicates found by ${modeLabel}!</div></div>`;
    document.getElementById('dup-pagination').innerHTML = '';
    return;
  }

  let html = '<div class="dup-groups">';

  for (const [groupKey, rows] of Object.entries(groups)) {
    const safeGroupKey = groupKey.replace(/'/g, "\\'");
    const firstRow = rows[0];
    const groupSubText = mode === 'patient'
      ? (firstRow.FULL_NAME ? `Patient: ${firstRow.FULL_NAME}` : '')
      : (firstRow.PATIENT_ID ? `Patient ID: ${firstRow.PATIENT_ID}` : '');

    html += `
      <div class="dup-group-header">
        <span style="font-size:11px;color:var(--text3);text-transform:uppercase;font-weight:700;">${modeLabel}:</span>
        <span class="dup-group-spec">${groupKey}</span>
        ${groupSubText ? `<span style="font-size:12px;color:var(--text2);font-weight:500;">(${groupSubText})</span>` : ''}
        <span class="badge badge-dup" style="margin-left:auto;">${rows.length} records</span>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th>Patient Name</th><th>Patient ID</th><th>Specimen #</th><th>Date</th>
          <th>Type</th><th>Organism</th><th>Sex</th><th>Age</th><th>Ward</th><th>Row #</th><th></th>
        </tr></thead>
        <tbody>`;

    rows.forEach(r => {
      html += `
        <tr class="dup-row">
          <td class="pt-name">${r.FULL_NAME || '—'}</td>
          <td class="mono" style="font-size:11px;font-weight:${mode === 'patient' ? '600' : 'normal'};color:${mode === 'patient' ? 'var(--accent)' : 'inherit'}">${r.PATIENT_ID || '—'}</td>
          <td class="mono" style="font-size:11px;font-weight:${mode === 'spec' ? '600' : 'normal'};color:${mode === 'spec' ? 'var(--accent)' : 'inherit'}">${r.SPEC_NUM || '—'}</td>
          <td>${fmtDate(r.SPEC_DATE)}</td>
          <td>${r.SPEC_TYPE || '—'}</td>
          <td>${renderOrgBadge(r.ORGANISM)}</td>
          <td>${r.SEX || '—'}</td>
          <td>${r.AGE || '—'}</td>
          <td>${r.WARD || '—'}</td>
          <td class="mono" style="color:var(--text3);font-size:11px">#${r.ROW_IDX}</td>
          <td>
            <button class="btn btn-danger btn-sm" onclick="deleteRowAndRefresh(${r.ROW_IDX})">✕ Delete</button>
          </td>
        </tr>`;
    });

    html += '</tbody></table>';
  }
  html += '</div>';

  document.getElementById('dup-table-body').innerHTML = html;
  renderPagination('dup-pagination', page, data.totalCount, 200, loadDuplicates);
}

function groupRows(rows, mode = state.dupMode) {
  const groups = {};
  for (const r of rows) {
    const val = mode === 'patient' ? (r.PATIENT_ID || '') : (r.SPEC_NUM || '');
    const key = val.trim().toUpperCase() || '(BLANK)';
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }
  return groups;
}

async function deleteRowAndRefresh(rowIdx) {
  const data = await api('/api/delete-row', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ row_idx: rowIdx })
  });
  if (data.error) return toast(data.error, 'error');
  toast(`Row #${rowIdx} deleted`, 'success');
  loadStats();
  loadDuplicates(state.dupsPage);
}

// ── Pagination ──
function renderPagination(containerId, page, total, pageSize, loadFn) {
  const totalPages = Math.ceil(total / pageSize);
  const el = document.getElementById(containerId);
  if (totalPages <= 1) { el.innerHTML = `<div class="page-info">Showing ${total} records</div>`; return; }

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  const pages = [];
  for (let i = Math.max(1, page - 2); i <= Math.min(totalPages, page + 2); i++) pages.push(i);

  el.innerHTML = `
    <div class="page-info">Showing ${start}–${end} of ${total.toLocaleString()}</div>
    <button class="page-btn" onclick="${loadFn.name}(1)" ${page === 1 ? 'disabled' : ''}>«</button>
    <button class="page-btn" onclick="${loadFn.name}(${page - 1})" ${page === 1 ? 'disabled' : ''}>‹</button>
    ${pages.map(p => `<button class="page-btn ${p === page ? 'active' : ''}" onclick="${loadFn.name}(${p})">${p}</button>`).join('')}
    <button class="page-btn" onclick="${loadFn.name}(${page + 1})" ${page === totalPages ? 'disabled' : ''}>›</button>
    <button class="page-btn" onclick="${loadFn.name}(${totalPages})" ${page === totalPages ? 'disabled' : ''}>»</button>
  `;
}

// ── Bulk fixes ──
async function bulkFix(op) {
  const data = await api('/api/bulk-fix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: op })
  });
  if (data.error) return toast(data.error, 'error');

  toast(`✓ ${data.description}: ${data.changes} rows updated`, 'success');

  const histEl = document.getElementById('fix-history');
  const item = document.createElement('div');
  item.style.cssText = 'background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:12px;';
  item.innerHTML = `
    <span style="color:var(--green);font-size:18px">✓</span>
    <div style="flex:1">
      <div style="font-weight:600;font-size:13.5px">${data.description}</div>
      <div style="font-size:12px;color:var(--text3)">${data.changes} rows affected · ${new Date().toLocaleTimeString()}</div>
    </div>
    <span style="font-family:JetBrains Mono,monospace;font-size:12px;color:var(--accent2)">op: ${op}</span>
  `;
  if (histEl.querySelector('.empty')) histEl.innerHTML = '';
  histEl.prepend(item);

  if (op === 'upper_spec_num') loadStats();
}

// ── SQL Editor ──
function insertSQL(sql) {
  document.getElementById('sql-input').value = sql;
  document.getElementById('sql-result').innerHTML = '<span style="color:var(--text3)">Results will appear here…</span>';
  document.getElementById('sql-result-table').style.display = 'none';
}
function clearSQL() {
  document.getElementById('sql-input').value = '';
  document.getElementById('sql-result').innerHTML = '<span style="color:var(--text3)">Results will appear here…</span>';
  document.getElementById('sql-result-table').style.display = 'none';
}
async function runSQL() {
  const sql = document.getElementById('sql-input').value.trim();
  if (!sql) return;
  const resultEl = document.getElementById('sql-result');
  const tableEl = document.getElementById('sql-result-table');
  resultEl.innerHTML = '<div class="loading" style="padding:12px"><div class="spinner"></div> Running…</div>';
  resultEl.className = 'sql-result';
  tableEl.style.display = 'none';

  const data = await api('/api/custom-sql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql })
  });

  if (data.error) {
    resultEl.className = 'sql-result error';
    resultEl.textContent = '✗ ' + data.error;
    return;
  }

  if (data.type === 'select') {
    resultEl.className = 'sql-result success';
    resultEl.textContent = `✓ ${data.count} row${data.count !== 1 ? 's' : ''} returned`;
    if (data.rows.length > 0) {
      tableEl.style.display = 'block';
      tableEl.innerHTML = `<table>
        <thead><tr>${data.columns.map(c => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody>${data.rows.slice(0, 500).map(r =>
        `<tr>${data.columns.map(c => `<td>${r[c] ?? '—'}</td>`).join('')}</tr>`
      ).join('')}</tbody>
      </table>`;
    }
  } else {
    resultEl.className = 'sql-result success';
    resultEl.textContent = `✓ ${data.changes} row${data.changes !== 1 ? 's' : ''} affected`;
    loadStats();
  }
}

// ── Detail modal ──
const EDITABLE = ['SPEC_NUM', 'PATIENT_ID', 'SPEC_TYPE', 'ORGANISM', 'FULL_NAME', 'SEX', 'AGE', 'WARD', 'DEPARTMENT', 'COMMENT', 'ESBL', 'CARBAPENEM', 'MRSA', 'URINECOUNT', 'SEROTYPE', 'BETA_LACT', 'INDUC_CLI'];

async function viewDetail(rowIdx) {
  const data = await api(`/api/isolate/${rowIdx}`);
  if (data.error) return toast(data.error, 'error');
  const r = data.row;

  document.getElementById('modal-title').textContent = `Isolate #${r.ROW_IDX} — ${r.SPEC_NUM || 'No Specimen #'}`;

  const fields = [
    ['SPEC_NUM', 'Specimen Number'], ['PATIENT_ID', 'Patient ID'], ['SPEC_DATE', 'Specimen Date'], ['SPEC_TYPE', 'Specimen Type'],
    ['ORGANISM', 'Organism'], ['FULL_NAME', 'Full Name'], ['SEX', 'Sex'], ['AGE', 'Age'],
    ['WARD', 'Ward'], ['DEPARTMENT', 'Department'], ['INSTITUT', 'Institution'],
    ['DATE_ADMIS', 'Admission Date'], ['DATE_DATA', 'Entry Date'],
    ['ESBL', 'ESBL'], ['CARBAPENEM', 'Carbapenem'], ['MRSA', 'MRSA'],
    ['URINECOUNT', 'Urine Count'], ['SEROTYPE', 'Serotype'], ['BETA_LACT', 'Beta-Lactamase'],
    ['INDUC_CLI', 'Inducible Clinda'], ['COMMENT', 'Comment']
  ];

  document.getElementById('modal-body').innerHTML = `
    <div class="detail-grid">
      ${fields.map(([key, label]) => {
    const editable = EDITABLE.includes(key);
    let valDisplay = r[key] || '<span style=color:var(--text3)>—</span>';
    if (key === 'ORGANISM' && r[key]) {
      const orgName = getOrganismName(r[key]);
      if (orgName) {
        valDisplay = `${r[key]} <span style="font-size:12px;color:var(--text3);font-weight:normal">(${orgName})</span>`;
      }
    }
    return `<div class="detail-field ${editable ? 'editable' : ''}">
          <label>${label}${editable ? ' ✏' : ''}</label>
          ${editable
        ? `<div class="field-val" id="fv-${rowIdx}-${key}" onclick="startEdit(${rowIdx},'${key}')">${valDisplay}</div>`
        : `<div class="field-val">${valDisplay}</div>`}
        </div>`;
  }).join('')}
    </div>
    <div style="margin-top:16px;padding-top:16px;border-top:1px solid var(--border);display:flex;gap:8px;">
      <button class="btn btn-danger btn-sm" onclick="confirmDeleteRow(${r.ROW_IDX}, '${r.SPEC_NUM}');closeModal()">
        Delete This Record
      </button>
    </div>
  `;

  document.getElementById('detail-modal').classList.add('open');
}

function closeModal() { document.getElementById('detail-modal').classList.remove('open'); }

function startEdit(rowIdx, field) {
  const el = document.getElementById(`fv-${rowIdx}-${field}`);
  if (!el) return;
  const current = el.textContent.trim() === '—' ? '' : el.textContent.trim();
  el.innerHTML = `<input class="field-input" id="fi-${rowIdx}-${field}" value="${current.replace(/"/g, '&quot;')}" onblur="saveEdit(${rowIdx},'${field}')" onkeydown="if(event.key==='Enter')saveEdit(${rowIdx},'${field}');if(event.key==='Escape')cancelEdit(${rowIdx},'${field}','${current}')">`;
  document.getElementById(`fi-${rowIdx}-${field}`).focus();
}

async function saveEdit(rowIdx, field) {
  const inp = document.getElementById(`fi-${rowIdx}-${field}`);
  if (!inp) return;
  const value = inp.value;
  const data = await api('/api/update-field', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ row_idx: rowIdx, field, value })
  });
  const el = document.getElementById(`fv-${rowIdx}-${field}`);
  if (data.error) {
    toast(data.error, 'error');
    if (el) el.innerHTML = value || '<span style=color:var(--text3)>—</span>';
  } else {
    if (el) el.innerHTML = value || '<span style=color:var(--text3)>—</span>';
    toast(`${field} updated`, 'success');
  }
}

function cancelEdit(rowIdx, field, original) {
  const el = document.getElementById(`fv-${rowIdx}-${field}`);
  if (el) el.innerHTML = original || '<span style=color:var(--text3)>—</span>';
}

// ── Confirm modal ──
function confirmDeleteRow(rowIdx, specNum) {
  document.getElementById('confirm-title').textContent = 'Delete Record';
  document.getElementById('confirm-body').innerHTML = `
    <div class="confirm-danger">⚠️ This will permanently delete isolate <strong>#${rowIdx}</strong> (Specimen: <strong>${specNum}</strong>).<br><br>This action cannot be undone.</div>
  `;
  state.confirmAction = async () => {
    const data = await api('/api/delete-row', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ row_idx: rowIdx })
    });
    if (data.error) return toast(data.error, 'error');
    toast(`Row #${rowIdx} deleted`, 'success');
    loadStats();
    loadIsolates(state.isolatesPage);
    loadDuplicates(state.dupsPage);
  };
  document.getElementById('confirm-modal').classList.add('open');
}

function confirmDeleteDupGroup(specNum) {
  document.getElementById('confirm-title').textContent = 'Keep Only First Record';
  document.getElementById('confirm-body').innerHTML = `
    <div class="confirm-danger">⚠️ This will delete all <strong>duplicate records</strong> for Specimen # <strong>${specNum}</strong>, keeping only the first (lowest ROW_IDX).<br><br>This action cannot be undone.</div>
  `;
  state.confirmAction = async () => {
    const data = await api('/api/delete-duplicates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec_num: specNum })
    });
    if (data.error) return toast(data.error, 'error');
    toast(`Deleted ${data.changes} duplicate(s) for ${specNum}`, 'success');
    loadStats();
    loadDuplicates(state.dupsPage);
  };
  document.getElementById('confirm-modal').classList.add('open');
}

function confirmDeleteAllDups() {
  const mode = state.dupMode;
  const label = mode === 'patient' ? 'PATIENT_ID' : 'SPEC_NUM';
  document.getElementById('confirm-title').textContent = `Delete ALL Duplicates (${mode === 'patient' ? 'by Patient ID' : 'by Specimen ID'})`;
  document.getElementById('confirm-body').innerHTML = `
    <div class="confirm-danger">⚠️ <strong>DANGER:</strong> This will delete ALL duplicate rows across the entire database, keeping only the <strong>first occurrence</strong> (lowest ROW_IDX) per ${label}.<br><br>This action is <strong>irreversible</strong>. Make sure you have a backup of the database file!</div>
  `;
  state.confirmAction = async () => {
    const data = await api('/api/delete-duplicates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    if (data.error) return toast(data.error, 'error');
    toast(`Deleted ${data.changes} duplicate rows`, 'success');
    loadStats();
    loadDuplicates(1);
  };
  document.getElementById('confirm-modal').classList.add('open');
}

function closeConfirm() {
  document.getElementById('confirm-modal').classList.remove('open');
  state.confirmAction = null;
}
async function executeConfirm() {
  if (state.confirmAction) await state.confirmAction();
  closeConfirm();
}

// ── Monthly AMR Report (SAPCAR-Gujarat / National AMR Containment) ──
async function loadMonthlyAmrData() {
  if (!state.currentDb) return;
  const data = await api('/api/monthly-amr');
  if (data.error) return toast(data.error, 'error');

  state.monthlyAmrData = data;
  renderAmrTable();
}

function formatAmrMonthLabel(ym) {
  if (!ym) return '—';
  const [yr, mo] = ym.split('-');
  const dateObj = new Date(parseInt(yr), parseInt(mo) - 1, 1);
  return dateObj.toLocaleString('en-US', { month: 'short' }) + ', ' + yr;
}

function renderAmrTable() {
  const data = state.monthlyAmrData;
  if (!data || !data.monthlyData || !data.monthlyData.length) {
    document.getElementById('amr-table-body').innerHTML = `
          <tr><td colspan="24" style="padding:24px;text-align:center;color:var(--text3);">No monthly records found</td></tr>
        `;
    return;
  }

  // Grand totals across all months
  const totals = {
    srcSamples: { opd: 0, ipd: 0, icu: 0, others: 0, total: 0 },
    srcPositives: { opd: 0, ipd: 0, icu: 0, others: 0, total: 0 },
    typeSamples: { blood: 0, pus: 0, sputum: 0, urine: 0, others: 0, total: 0 },
    typePositives: { blood: 0, pus: 0, sputum: 0, urine: 0, others: 0, total: 0 }
  };

  const rowsHtml = data.monthlyData.map(m => {
    // Accumulate totals
    totals.srcSamples.opd += m.srcSamples.opd;
    totals.srcSamples.ipd += m.srcSamples.ipd;
    totals.srcSamples.icu += m.srcSamples.icu;
    totals.srcSamples.others += m.srcSamples.others;
    totals.srcSamples.total += m.srcSamples.total;

    totals.srcPositives.opd += m.srcPositives.opd;
    totals.srcPositives.ipd += m.srcPositives.ipd;
    totals.srcPositives.icu += m.srcPositives.icu;
    totals.srcPositives.others += m.srcPositives.others;
    totals.srcPositives.total += m.srcPositives.total;

    totals.typeSamples.blood += m.typeSamples.blood;
    totals.typeSamples.pus += m.typeSamples.pus;
    totals.typeSamples.sputum += m.typeSamples.sputum;
    totals.typeSamples.urine += m.typeSamples.urine;
    totals.typeSamples.others += m.typeSamples.others;
    totals.typeSamples.total += m.typeSamples.total;

    totals.typePositives.blood += m.typePositives.blood;
    totals.typePositives.pus += m.typePositives.pus;
    totals.typePositives.sputum += m.typePositives.sputum;
    totals.typePositives.urine += m.typePositives.urine;
    totals.typePositives.others += m.typePositives.others;
    totals.typePositives.total += m.typePositives.total;

    const monthLabel = formatAmrMonthLabel(m.month);

    return `
          <tr class="amr-data-row">
            <td class="td-month">
              ${monthLabel}
            </td>

            <!-- Source of Sample -->
            <td class="td-num">${m.srcSamples.opd}</td>
            <td class="td-num">${m.srcSamples.ipd}</td>
            <td class="td-num">${m.srcSamples.icu}</td>
            <td class="td-num">${m.srcSamples.others}</td>
            <td class="td-num td-total">${m.srcSamples.total}</td>

            <!-- Positive by Source -->
            <td class="td-num">${m.srcPositives.opd}</td>
            <td class="td-num">${m.srcPositives.ipd}</td>
            <td class="td-num">${m.srcPositives.icu}</td>
            <td class="td-num">${m.srcPositives.others}</td>
            <td class="td-num td-total-pos">${m.srcPositives.total}</td>

            <!-- Type of sample -->
            <td class="td-num">${m.typeSamples.blood}</td>
            <td class="td-num">${m.typeSamples.pus}</td>
            <td class="td-num">${m.typeSamples.sputum}</td>
            <td class="td-num">${m.typeSamples.urine}</td>
            <td class="td-num">${m.typeSamples.others}</td>
            <td class="td-num td-total">${m.typeSamples.total}</td>

            <!-- Positive by Type -->
            <td class="td-num">${m.typePositives.blood}</td>
            <td class="td-num">${m.typePositives.pus}</td>
            <td class="td-num">${m.typePositives.sputum}</td>
            <td class="td-num">${m.typePositives.urine}</td>
            <td class="td-num">${m.typePositives.others}</td>
            <td class="td-num td-total-pos">${m.typePositives.total}</td>
          </tr>
        `;
  }).join('');

  // Summary total row
  const totalRowHtml = `
        <tr class="amr-summary-row">
          <td class="td-summary-label">Overall Total</td>

          <!-- Source of Sample -->
          <td class="td-num">${totals.srcSamples.opd}</td>
          <td class="td-num">${totals.srcSamples.ipd}</td>
          <td class="td-num">${totals.srcSamples.icu}</td>
          <td class="td-num">${totals.srcSamples.others}</td>
          <td class="td-num td-summary-total">${totals.srcSamples.total}</td>

          <!-- Positive by Source -->
          <td class="td-num">${totals.srcPositives.opd}</td>
          <td class="td-num">${totals.srcPositives.ipd}</td>
          <td class="td-num">${totals.srcPositives.icu}</td>
          <td class="td-num">${totals.srcPositives.others}</td>
          <td class="td-num td-summary-pos">${totals.srcPositives.total}</td>

          <!-- Type of sample -->
          <td class="td-num">${totals.typeSamples.blood}</td>
          <td class="td-num">${totals.typeSamples.pus}</td>
          <td class="td-num">${totals.typeSamples.sputum}</td>
          <td class="td-num">${totals.typeSamples.urine}</td>
          <td class="td-num">${totals.typeSamples.others}</td>
          <td class="td-num td-summary-total">${totals.typeSamples.total}</td>

          <!-- Positive by Type -->
          <td class="td-num">${totals.typePositives.blood}</td>
          <td class="td-num">${totals.typePositives.pus}</td>
          <td class="td-num">${totals.typePositives.sputum}</td>
          <td class="td-num">${totals.typePositives.urine}</td>
          <td class="td-num">${totals.typePositives.others}</td>
          <td class="td-num td-summary-pos">${totals.typePositives.total}</td>
        </tr>
      `;

  document.getElementById('amr-table-body').innerHTML = rowsHtml + totalRowHtml;
}

const AMR_HEADERS = [
  'Month, Year',
  'Total samples (Source: OPD)',
  'Total samples (Source: IPD)',
  'Total samples (Source: ICU)',
  'Total samples (Source: Others)',
  'Total samples (Source: Total)',
  'Culture Positive (Source: OPD)',
  'Culture Positive (Source: IPD)',
  'Culture Positive (Source: ICU)',
  'Culture Positive (Source: Others)',
  'Culture Positive (Source: Total)',
  'Total samples (Type: Blood)',
  'Total samples (Type: Pus)',
  'Total samples (Type: Sputum)',
  'Total samples (Type: Urine)',
  'Total samples (Type: Others)',
  'Total samples (Type: Total)',
  'Culture Positive (Type: Blood)',
  'Culture Positive (Type: Pus)',
  'Culture Positive (Type: Sputum)',
  'Culture Positive (Type: Urine)',
  'Culture Positive (Type: Others)',
  'Culture Positive (Type: Total)'
];

function getAmrRowsData() {
  const data = state.monthlyAmrData;
  if (!data || !data.monthlyData) return [];
  return data.monthlyData.map(m => [
    formatAmrMonthLabel(m.month),
    m.srcSamples.opd, m.srcSamples.ipd, m.srcSamples.icu, m.srcSamples.others, m.srcSamples.total,
    m.srcPositives.opd, m.srcPositives.ipd, m.srcPositives.icu, m.srcPositives.others, m.srcPositives.total,
    m.typeSamples.blood, m.typeSamples.pus, m.typeSamples.sputum, m.typeSamples.urine, m.typeSamples.others, m.typeSamples.total,
    m.typePositives.blood, m.typePositives.pus, m.typePositives.sputum, m.typePositives.urine, m.typePositives.others, m.typePositives.total
  ]);
}

function copyAmrTableTsv() {
  const rows = getAmrRowsData();
  if (!rows.length) return toast('No AMR data loaded', 'error');

  const allRows = [AMR_HEADERS, ...rows];
  const tsv = allRows.map(r => r.join('\t')).join('\n');

  navigator.clipboard.writeText(tsv).then(() => {
    toast('✓ Copied all monthly AMR data to clipboard (ready for Excel / Sheets)', 'success');
  }).catch(() => {
    prompt('Copy this TSV table:', tsv);
  });
}

function exportAmrCsv() {
  const rows = getAmrRowsData();
  if (!rows.length) return toast('No AMR data loaded', 'error');

  const csvContent = [
    AMR_HEADERS.map(h => `"${h}"`).join(','),
    ...rows.map(r => r.map(v => typeof v === 'string' ? `"${v}"` : v).join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Monthly_AMR_Surveillance_Report_${state.currentDb || 'WHONET'}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast('✓ Exported all months AMR CSV', 'success');
}

// ── Launch Flow: Disclaimer -> Data Source Selection (Path list OR Upload) ──
function checkNoticeModal() {
  // Open disclaimer modal on launch
  document.getElementById('disclaimer-modal').classList.add('open');
}

function proceedToDataSourceModal() {
  document.getElementById('disclaimer-modal').classList.remove('open');
  renderLaunchDbSelect();
  document.getElementById('source-modal').classList.add('open');
}

function renderLaunchDbSelect() {
  const sel = document.getElementById('launch-db-select');
  const localOption = document.getElementById('launch-option-local');
  const btnPickFolder = document.getElementById('btn-pick-folder');
  const btnOpenLaunch = document.getElementById('btn-open-launch-file');

  if (state.isWasmMode) {
    if (localOption) {
      localOption.style.opacity = '1';
    }
    if (btnPickFolder) {
      btnPickFolder.style.display = 'inline-flex';
      const folderConnected = Boolean(state.dirHandle);
      btnPickFolder.classList.toggle('btn-primary', !folderConnected);
      btnPickFolder.classList.toggle('btn-success', folderConnected);
      btnPickFolder.textContent = folderConnected
        ? '✓ Folder Connected'
        : '📂 Select WHONET Folder (C:\\WHONET\\Data)';
      btnPickFolder.title = folderConnected
        ? 'Select a different WHONET data folder'
        : 'Select the WHONET data folder';
    }

    const localDbs = state.databases || [];

    if (!localDbs.length) {
      document.getElementById('launch-local-desc').innerHTML =
        '<span style="color:var(--text2)">Click below to select your <code>C:\\WHONET\\Data</code> folder once. Browser will automatically list and load all <code>.sqlite</code> files!</span>';
      sel.innerHTML = '<option value="">(No folder selected yet — Click "Select WHONET Folder")</option>';
      if (btnOpenLaunch) btnOpenLaunch.disabled = true;
      return;
    }

    document.getElementById('launch-local-desc').innerHTML =
      `Folder loaded: <strong>${localDbs.length} database file(s)</strong> available. Select one to open:`;
    if (btnOpenLaunch) btnOpenLaunch.disabled = false;
    sel.innerHTML = localDbs.map(db =>
      `<option value="${db}" ${db === state.currentDb ? 'selected' : ''}>${db}</option>`
    ).join('');
    return;
  }

  // Local Server mode
  if (btnPickFolder) btnPickFolder.style.display = 'none';
  if (btnOpenLaunch) btnOpenLaunch.disabled = false;
  const localDbs = state.databases || [];
  if (!localDbs.length) {
    sel.innerHTML = '<option value="">No laboratory .sqlite files found in C:\\WHONET\\Data</option>';
    return;
  }
  sel.innerHTML = localDbs.map(db =>
    `<option value="${db}" ${db === state.currentDb ? 'selected' : ''}>${db}</option>`
  ).join('');
}

function isSqliteDatabase(filename) {
  return filename.toLowerCase().endsWith('.sqlite');
}

async function getFolderHandleStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('whonet-data-tool', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('settings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveWhonetFolderHandle(dirHandle) {
  try {
    const db = await getFolderHandleStore();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('settings', 'readwrite');
      transaction.objectStore('settings').put(dirHandle, 'whonet-folder');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  } catch (err) {
    console.info('Could not remember selected folder:', err.message);
  }
}

async function getSavedWhonetFolderHandle() {
  try {
    const db = await getFolderHandleStore();
    const handle = await new Promise((resolve, reject) => {
      const request = db.transaction('settings').objectStore('settings').get('whonet-folder');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return handle;
  } catch (err) {
    console.info('Could not restore selected folder:', err.message);
    return null;
  }
}

async function scanWhonetFolder(dirHandle, showToast = true) {
  state.dirHandle = dirHandle;
  if (showToast) toast('Scanning selected folder for .sqlite files…', 'info');

  const foundFiles = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file' && isSqliteDatabase(entry.name)) {
      state.fileHandles[entry.name] = entry;
      foundFiles.push(entry.name);
    }
  }

  foundFiles.sort();
  if (!foundFiles.length) {
    if (showToast) toast('No .sqlite files found in the selected folder.', 'error');
    return false;
  }

  foundFiles.forEach(f => {
    if (!state.databases.includes(f)) state.databases.push(f);
  });

  renderLaunchDbSelect();
  renderDbSelector();
  if (showToast) toast(`✓ Found ${foundFiles.length} WHONET database(s)! Select one to open.`, 'success');
  return true;
}

async function restoreWhonetFolder() {
  if (!('showDirectoryPicker' in window)) return;
  const dirHandle = await getSavedWhonetFolderHandle();
  if (!dirHandle) return;

  try {
    const permission = await dirHandle.queryPermission({ mode: 'read' });
    if (permission === 'granted') await scanWhonetFolder(dirHandle, false);
  } catch (err) {
    console.info('Saved folder is no longer available:', err.message);
  }
}

// Direct folder picker for Web / Vercel mode using File System Access API
async function chooseWhonetFolder() {
  if ('showDirectoryPicker' in window) {
    try {
      const dirHandle = await window.showDirectoryPicker({
        id: 'whonet_data_dir',
        startIn: 'documents'
      });
      await saveWhonetFolderHandle(dirHandle);
      await scanWhonetFolder(dirHandle);
    } catch (err) {
      if (err.name !== 'AbortError') {
        toast(`Failed to read folder: ${err.message}`, 'error');
      }
    }
  } else {
    // Fallback for browsers without showDirectoryPicker (Firefox/Safari)
    const input = document.getElementById('folder-input-fallback');
    if (input) input.click();
  }
}

async function handleFolderSelected(files) {
  if (!files || !files.length) return;
  const foundFiles = [];
  for (const file of files) {
    if (isSqliteDatabase(file.name)) {
      state.fileHandles[file.name] = file;
      foundFiles.push(file.name);
      if (!state.databases.includes(file.name)) {
        state.databases.push(file.name);
      }
    }
  }
  foundFiles.sort();
  if (!foundFiles.length) {
    return toast('No .sqlite files found in the selected folder.', 'error');
  }
  renderLaunchDbSelect();
  renderDbSelector();
  toast(`✓ Found ${foundFiles.length} WHONET database(s)!`, 'success');
}

async function selectFromLaunchList() {
  const sel = document.getElementById('launch-db-select');
  const filename = sel.value;
  if (!filename) return toast('Please select a file from the list', 'error');

  if (state.isWasmMode) {
    const handleOrFile = state.fileHandles[filename];
    if (handleOrFile) {
      document.getElementById('source-modal').classList.remove('open');
      if (typeof handleOrFile.getFile === 'function') {
        const file = await handleOrFile.getFile();
        await handleFileUpload(file, handleOrFile);
      } else {
        await handleFileUpload(handleOrFile, null);
      }
      return;
    }
    return toast('Please select your .sqlite file using Option 2 (Browse / Upload)', 'info');
  }

  await switchDb(filename);
  document.getElementById('source-modal').classList.remove('open');
}

async function triggerBrowseFile() {
  if ('showOpenFilePicker' in window) {
    try {
      const [fileHandle] = await window.showOpenFilePicker({
        types: [{
          description: 'WHONET SQLite Database',
          accept: { 'application/x-sqlite3': ['.sqlite'] }
        }],
        multiple: false
      });
      const file = await fileHandle.getFile();
      document.getElementById('source-modal').classList.remove('open');
      state.isWasmMode = true;
      await handleFileUpload(file, fileHandle);
    } catch (err) {
      if (err.name !== 'AbortError') {
        toast(`Failed to open file: ${err.message}`, 'error');
      }
    }
  } else {
    const input = document.getElementById('launch-file-input');
    if (input) input.click();
  }
}

async function handleLaunchFileUpload(file) {
  if (!file) return;
  document.getElementById('source-modal').classList.remove('open');
  await handleFileUpload(file);
}

async function loadSampleFromLaunch(sampleFilename) {
  document.getElementById('source-modal').classList.remove('open');
  await loadSampleDatabase(sampleFilename);
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeConfirm(); }
  if (e.key === 'F5' || (e.ctrlKey && e.key === 'Enter')) {
    const page = document.querySelector('.page.active');
    if (page?.id === 'page-sql') { e.preventDefault(); runSQL(); }
  }
});

// Close modal on overlay click
document.getElementById('detail-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('detail-modal')) closeModal();
});
document.getElementById('confirm-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('confirm-modal')) closeConfirm();
});

// Window-level drag & drop support
window.addEventListener('dragover', e => {
  e.preventDefault();
  const dropzone = document.getElementById('global-dropzone');
  if (dropzone) dropzone.classList.add('dragover');
});
window.addEventListener('dragleave', e => {
  if (e.clientX === 0 && e.clientY === 0) {
    const dropzone = document.getElementById('global-dropzone');
    if (dropzone) dropzone.classList.remove('dragover');
  }
});
window.addEventListener('drop', e => {
  const files = e.dataTransfer?.files;
  if (files && files.length > 0 && files[0].name.toLowerCase().endsWith('.sqlite')) {
    handleFileDrop(e);
  }
});

init();
checkNoticeModal();