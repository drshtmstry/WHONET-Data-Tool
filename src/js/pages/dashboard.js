import { state, setRuntimeBadge, updateCurrentFileDisplay } from '../state/store.js';
import { api, API_BASE } from '../api/client.js';
import { toast } from '../ui/toast.js';
import { getOrganismName } from '../utils/organisms.js';
import { getSqlJs, wasmSelect, normaliseSchema } from '../db/wasm.js';

let barChartInstance = null;
let pieChartInstance = null;
let currentChartDisplayMode = 'both';

const PALETTE_COLORS = [
  '#4f46e5', '#06b6d4', '#10b981', '#f59e0b', '#f43f5e',
  '#8b5cf6', '#3b82f6', '#14b8a6', '#ec4899', '#6366f1',
  '#84cc16', '#a855f7', '#0ea5e9', '#f97316', '#64748b'
];

export async function loadStats() {
  if (!state.currentDb) return;
  updateCurrentFileDisplay(state.currentDb);
  const data = await api('/api/stats');
  if (data.error) return toast(data.error, 'error');
  state.stats = data;

  // Update duplicate badge
  const activeDupCount = state.dupMode === 'patient' ? (data.dupPtRows || 0) : (data.dupRows || 0);
  const activeDupGroups = state.dupMode === 'patient' ? (data.dupPtGroups || 0) : (data.dupGroups || 0);
  const dupBadge = document.getElementById('dup-badge');
  if (dupBadge) dupBadge.textContent = activeDupCount;

  // Populate Executive KPI Stat Cards
  const statTotal = document.getElementById('stat-total-isolates');
  if (statTotal) statTotal.textContent = (data.total || 0).toLocaleString();

  const statDupRows = document.getElementById('stat-dup-rows');
  if (statDupRows) statDupRows.textContent = (activeDupCount || 0).toLocaleString();

  const statDupGroups = document.getElementById('stat-dup-groups-text');
  if (statDupGroups) {
    statDupGroups.textContent = `In ${(activeDupGroups || 0).toLocaleString()} clusters (${state.dupMode === 'patient' ? 'Patient ID' : 'Specimen ID'})`;
  }

  const statOrgs = document.getElementById('stat-organisms-count');
  if (statOrgs) statOrgs.textContent = (data.organisms ? data.organisms.length : 0).toLocaleString();

  const statWards = document.getElementById('stat-wards-count');
  if (statWards) statWards.textContent = (data.wards ? data.wards.length : 0).toLocaleString();

  // Populate filters
  const orgFilter = document.getElementById('isolates-org-filter');
  if (orgFilter && data.organisms) {
    orgFilter.innerHTML = '<option value="">All Organisms</option>' +
      data.organisms.map(o => {
        const name = getOrganismName(o);
        const label = name ? `${o} — ${name}` : o;
        return `<option value="${o}">${label}</option>`;
      }).join('');
  }

  const wardFilter = document.getElementById('isolates-ward-filter');
  if (wardFilter && data.wards) {
    wardFilter.innerHTML = '<option value="">All Wards</option>' +
      data.wards.map(w => `<option value="${w}">${w}</option>`).join('');
  }

  // Organisms list
  const orgListEl = document.getElementById('org-list');
  if (orgListEl && data.organisms) {
    orgListEl.innerHTML = data.organisms.slice(0, 20).map(o => {
      const name = getOrganismName(o);
      const titleAttr = name ? `title="${name} (${o})"` : `title="${o}"`;
      return `<span class="badge badge-org" ${titleAttr} style="cursor:pointer" onclick="showPage('isolates');document.getElementById('isolates-org-filter').value='${o}';loadIsolates(1)">${o}</span>`;
    }).join('');
  }

  // Refresh dynamic visual charts
  updateDashboardCharts();

  if (document.getElementById('page-monthly-amr')?.classList.contains('active')) {
    if (typeof window.loadMonthlyAmrData === 'function') {
      window.loadMonthlyAmrData();
    }
  }
}

export function setChartTypeMode(mode) {
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

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (barChartInstance) barChartInstance.resize();
      if (pieChartInstance) pieChartInstance.resize();
    });
  });
}

export function onPeriodFilterChange() {
  const period = document.getElementById('chart-period-select')?.value || 'all';
  const customDates = document.getElementById('chart-custom-dates');
  if (customDates) {
    customDates.style.display = period === 'custom' ? 'flex' : 'none';
  }
  updateDashboardCharts();
}

export function resetChartZoom(chartType) {
  if (chartType === 'bar' && barChartInstance) {
    barChartInstance.resetZoom ? barChartInstance.resetZoom() : barChartInstance.update();
  }
  updateDashboardCharts();
}

export async function updateDashboardCharts() {
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

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const textColor = isDark ? '#e2e8f0' : '#334155';
  const mutedColor = isDark ? '#94a3b8' : '#64748b';
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(226, 232, 240, 0.8)';
  const doughnutBorder = isDark ? '#121826' : '#ffffff';
  const tooltipBg = isDark ? 'rgba(18, 24, 38, 0.96)' : 'rgba(15, 23, 42, 0.95)';

  Chart.defaults.color = textColor;

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
          borderRadius: 6,
          maxBarThickness: 40
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 350 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: tooltipBg,
            titleFont: { family: 'Plus Jakarta Sans', size: 12, weight: 'bold' },
            bodyFont: { family: 'Plus Jakarta Sans', size: 12 },
            padding: 12,
            cornerRadius: 8,
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
              font: { family: 'Plus Jakarta Sans', size: 11, weight: '600' },
              color: mutedColor,
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
            grid: { color: gridColor },
            ticks: {
              font: { family: 'JetBrains Mono', size: 11, weight: '500' },
              color: mutedColor,
              precision: 0
            }
          }
        }
      }
    });
  }

  // ── Render Pie Chart ──
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
          borderColor: doughnutBorder,
          borderWidth: 2.5,
          hoverOffset: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 350 },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: tooltipBg,
            titleFont: { family: 'Plus Jakarta Sans', size: 12, weight: 'bold' },
            bodyFont: { family: 'Plus Jakarta Sans', size: 12 },
            padding: 12,
            cornerRadius: 8,
            callbacks: {
              label: ctx => {
                const cnt = ctx.parsed || 0;
                const pct = totalFiltered > 0 ? ((cnt / totalFiltered) * 100).toFixed(1) : '0.0';
                return ` ${cnt.toLocaleString()} isolates (${pct}%)`;
              }
            }
          }
        },
        cutout: '62%'
      }
    });
  }
}

export function renderDbSelector() {
  const sel = document.getElementById('db-select');
  if (!sel) return;
  if (state.isWasmMode && !state.databases.length) {
    sel.innerHTML = '<option value="">(Drop or browse .sqlite file)</option>';
    updateCurrentFileDisplay('');
    return;
  }
  sel.innerHTML = state.databases.map(db =>
    `<option value="${db}" ${db === state.currentDb ? 'selected' : ''}>${db}</option>`
  ).join('');
  updateCurrentFileDisplay(state.currentDb);
}

export async function switchDb(filename) {
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
    const data = await api('/api/open-database', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename })
    });
    if (data.error) return toast(`Cannot switch: ${data.error}`, 'error');
    state.isWasmMode = false;
    state.wasmDb = null;
    state.activeFileHandle = null;
    state.isModified = false;
    state.currentDb = filename;
    setRuntimeBadge('Local Server Connected', true);
    const saveBtn = document.getElementById('btn-save-file');
    if (saveBtn) saveBtn.style.display = 'none';
    renderDbSelector();
    toast(`Switched to ${filename} (${data.count.toLocaleString()} records)`, 'success');
    loadStats();
    if (typeof window.refreshSqlSchema === 'function') window.refreshSqlSchema();
    return;
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
  if (typeof window.refreshSqlSchema === 'function') window.refreshSqlSchema();
}

export async function loadSampleDatabase(sampleFilename) {
  toast(`Loading sample ${sampleFilename}…`, 'info');
  try {
    if (!state.isWasmMode && state.databases.includes(sampleFilename)) {
      await switchDb(sampleFilename);
      return;
    }

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

    setRuntimeBadge('In-Browser WASM Mode', false);

    const dlBtn = document.getElementById('btn-download-db');
    if (dlBtn) dlBtn.style.display = 'inline-flex';

    normaliseSchema();
    renderDbSelector();
    const count = wasmSelect('SELECT COUNT(*) as c FROM Isolates')[0]?.c || 0;
    toast(`Loaded sample ${sampleFilename} (${count.toLocaleString()} records)`, 'success');
    loadStats();
    if (typeof window.refreshSqlSchema === 'function') window.refreshSqlSchema();
  } catch (err) {
    toast(`Failed to load sample database: ${err.message}`, 'error');
  }
}

export async function handleFileUpload(file, fileHandle = null) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.sqlite')) {
    return toast('Please drop/upload a valid .sqlite file', 'error');
  }

  toast(`Reading ${file.name}…`, 'info');

  if (!state.isWasmMode) {
    try {
      const res = await fetch(API_BASE + '/api/upload-database?filename=' + encodeURIComponent(file.name), {
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
      if (typeof window.refreshSqlSchema === 'function') window.refreshSqlSchema();
      return;
    } catch (err) {
      console.warn('Local upload failed, falling back to client-side WASM engine:', err.message);
    }
  }

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

    setRuntimeBadge('In-Browser WASM Mode', false);

    const saveBtn = document.getElementById('btn-save-file');
    if (saveBtn) {
      if (fileHandle && typeof fileHandle.createWritable === 'function') {
        saveBtn.style.display = 'inline-flex';
        saveBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Save to File';
      } else {
        saveBtn.style.display = 'none';
      }
    }

    const dlBtn = document.getElementById('btn-download-db');
    if (dlBtn) dlBtn.style.display = 'inline-flex';

    normaliseSchema();
    renderDbSelector();
    const count = wasmSelect('SELECT COUNT(*) as c FROM Isolates')[0]?.c || 0;
    toast(`Successfully loaded ${file.name} into browser (${count.toLocaleString()} records)`, 'success');
    loadStats();
    if (typeof window.refreshSqlSchema === 'function') window.refreshSqlSchema();
  } catch (err) {
    toast(`Failed to load SQLite file in browser: ${err.message}`, 'error');
  }
}

export function handleFileDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  const dropzone = document.getElementById('global-dropzone');
  if (dropzone) dropzone.classList.remove('dragover');

  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    handleFileUpload(files[0]);
  }
}
