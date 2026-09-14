/**
 * WHONET Data Tool - Modern ES Module Entry Point
 * Orchestrates state, views, WASM SQLite engine, and UI interactions.
 */

// ── State & API ──
import { state, setRuntimeBadge, updateCurrentFileDisplay } from './state/store.js';
import { api, API_BASE } from './api/client.js';

// ── Utils & UI Helpers ──
import { escapeHtml, fmtDate, formatAmrMonthLabel, debounce, isSqliteDatabase, isSampleDb } from './utils/formatters.js';
import { naturalKey, naturalCompare } from './utils/natural-sort.js';
import { getOrganismName, renderOrgBadge } from './utils/organisms.js';
import { renderSortHeader, renderPagination } from './ui/table.js';
import { toast } from './ui/toast.js';

// ── Modals & Dialogs ──
import {
  viewDetail, closeModal, startEdit, saveEdit, cancelEdit,
  openEditModal, closeEditModal, saveEditModal,
  confirmDeleteRow, confirmDeleteDupGroup, confirmDeleteSelectedDups,
  closeConfirm, executeConfirm, onDataMutated
} from './ui/modal.js';

// ── Database & Filesystem ──
import {
  getSqlJs, wasmSelect, wasmRun, ensureWasmFunctions, normaliseSchema,
  autoSaveToHandle, saveToFileHandle, exportSqliteDatabase
} from './db/wasm.js';
import {
  saveWhonetFolderHandle, getSavedWhonetFolderHandle, scanWhonetFolder,
  restoreWhonetFolder, chooseWhonetFolder, handleFolderSelected,
  renderLaunchDbSelect, checkNoticeModal, proceedToDataSourceModal,
  selectFromLaunchList, triggerBrowseFile, handleLaunchFileUpload, loadSampleFromLaunch
} from './db/filesystem.js';

// ── Page Controllers ──
import {
  loadStats, setChartTypeMode, onPeriodFilterChange, resetChartZoom,
  updateDashboardCharts, renderDbSelector, switchDb, loadSampleDatabase,
  handleFileUpload, handleFileDrop
} from './pages/dashboard.js';
import {
  sortIsolates, loadIsolates, renderIsolatesTable, debouncedLoadIsolates
} from './pages/isolates.js';
import {
  setDupMode, sortDuplicates, groupRows, loadDuplicates,
  renderDuplicatesTable, toggleSelectAllDups, updateDupSelectedState, debouncedLoadDups
} from './pages/duplicates.js';
import {
  loadMonthlyAmrData, renderAmrTable, getAmrRowsData, copyAmrTableTsv, exportAmrCsv
} from './pages/monthly-amr.js';
import {
  refreshSqlSchema, initSqlAutocomplete, insertSQL, clearSQL,
  sortSqlTable, renderSqlResultTable, runSQL
} from './pages/sql-workspace.js';
import {
  bulkFix, fixCasingAndRefresh
} from './pages/fixes.js';

// ── Theme Management ──
export function initTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
  updateThemeToggleBtn(currentTheme);
  if (typeof Chart !== 'undefined') {
    Chart.defaults.color = currentTheme === 'dark' ? '#e2e8f0' : '#334155';
  }
}

export function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', newTheme);
  try {
    localStorage.setItem('whonet-theme', newTheme);
  } catch (e) { }
  updateThemeToggleBtn(newTheme);
  if (typeof Chart !== 'undefined') {
    Chart.defaults.color = newTheme === 'dark' ? '#e2e8f0' : '#334155';
  }
  if (state.currentDb) {
    updateDashboardCharts();
  }
}

export function updateThemeToggleBtn(theme) {
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.innerHTML = theme === 'dark' ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
    btn.title = theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
  }
}

// ── Page Routing ──
export function showPage(name) {
  state.currentPage = name;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const targetPage = document.getElementById('page-' + name);
  const targetNav = document.getElementById('nav-' + name);
  if (targetPage) targetPage.classList.add('active');
  if (targetNav) targetNav.classList.add('active');

  const mainEl = document.querySelector('.main');
  if (mainEl) {
    const noScrollPages = ['sql', 'isolates', 'duplicates'];
    mainEl.classList.toggle('page-no-scroll', noScrollPages.includes(name));
    mainEl.classList.toggle('page-sql-active', name === 'sql');
  }

  if (name === 'isolates' && state.currentDb) loadIsolates(1);
  if (name === 'duplicates' && state.currentDb) loadDuplicates(1);
  if (name === 'dashboard' && state.currentDb) loadStats();
  if (name === 'monthly-amr' && state.currentDb) loadMonthlyAmrData();
  if (name === 'sql') {
    initSqlAutocomplete();
    refreshSqlSchema();
  }
}

// ── Connect Mutation Callback ──
onDataMutated((hint) => {
  loadStats();
  loadDuplicates(state.dupsPage || 1);
  if (state.currentPage === 'isolates') {
    loadIsolates(state.isolatesPage || 1);
  }
});

// ── App Initialization ──
export async function init() {
  initTheme();
  initSqlAutocomplete();

  try {
    const res = await fetch(API_BASE + '/api/databases');
    const data = await res.json();
    if (data && Array.isArray(data.databases)) {
      state.isWasmMode = false;
      state.databases = data.databases;
      state.currentDb = data.current;
      setRuntimeBadge('Local Server Connected', true);
      renderDbSelector();
      if (state.currentDb) {
        await loadStats();
        refreshSqlSchema();
      }
      return;
    }
  } catch (e) {
    console.info('Local server not found or running on web, enabling in-browser SQLite mode:', e.message);
  }

  // Fallback to in-browser WASM mode
  state.isWasmMode = true;
  setRuntimeBadge('In-Browser Client Mode (WASM)', false);
  const btnOpenPath = document.getElementById('btn-open-path');
  if (btnOpenPath) btnOpenPath.style.display = 'none';
  renderDbSelector();
  await restoreWhonetFolder();
}

// ── Global Event Handlers & Shortcuts ──
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal();
    closeConfirm();
    closeEditModal();
  }
  if (e.key === 'F5' || (e.ctrlKey && e.key === 'Enter')) {
    const page = document.querySelector('.page.active');
    if (page?.id === 'page-sql') {
      e.preventDefault();
      runSQL();
    }
  }
});

document.getElementById('detail-modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('detail-modal')) closeModal();
});

document.getElementById('confirm-modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('confirm-modal')) closeConfirm();
});

const editModalEl = document.getElementById('edit-modal');
if (editModalEl) {
  editModalEl.addEventListener('click', e => {
    if (e.target === editModalEl) closeEditModal();
  });
}

// Drag & Drop
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

window.addEventListener('beforeunload', e => {
  if (state.isModified && state.isWasmMode) {
    e.preventDefault();
    e.returnValue = 'You have unsaved changes. Leave anyway?';
  }
});

// ── Bind to window for 100% backward compatibility with index.html inline event handlers ──
Object.assign(window, {
  state,
  showPage,
  toggleTheme,
  switchDb,
  renderDbSelector,
  loadStats,
  setChartTypeMode,
  onPeriodFilterChange,
  resetChartZoom,
  updateDashboardCharts,
  loadSampleDatabase,
  handleFileUpload,
  handleFileDrop,
  exportSqliteDatabase,
  saveToFileHandle,
  sortIsolates,
  loadIsolates,
  debouncedLoadIsolates,
  setDupMode,
  sortDuplicates,
  loadDuplicates,
  debouncedLoadDups,
  toggleSelectAllDups,
  updateDupSelectedState,
  viewDetail,
  closeModal,
  startEdit,
  saveEdit,
  cancelEdit,
  openEditModal,
  closeEditModal,
  saveEditModal,
  confirmDeleteRow,
  confirmDeleteDupGroup,
  confirmDeleteSelectedDups,
  closeConfirm,
  executeConfirm,
  loadMonthlyAmrData,
  copyAmrTableTsv,
  exportAmrCsv,
  refreshSqlSchema,
  insertSQL,
  clearSQL,
  sortSqlTable,
  runSQL,
  bulkFix,
  fixCasingAndRefresh,
  chooseWhonetFolder,
  handleFolderSelected,
  selectFromLaunchList,
  triggerBrowseFile,
  handleLaunchFileUpload,
  loadSampleFromLaunch,
  proceedToDataSourceModal,
  toast
});

// Auto-run startup
init();
checkNoticeModal();
