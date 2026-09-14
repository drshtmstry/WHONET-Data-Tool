# WHONET Data Tool - Modular Architecture & Schema Reference

Comprehensive architectural guide and modular schema reference for developers maintaining or extending the WHONET Data Tool.

---

## 1. System Architecture Overview

The WHONET Data Tool utilizes a **hybrid execution model** designed to function in two operational modes with zero code duplication:
1. **Local Server Mode (Node.js)**: Runs locally with `node server.js` on `http://localhost:7890`. Direct file I/O to `C:\WHONET\Data` via Node's native `DatabaseSync` (`node:sqlite`).
2. **Web / Offline Client Mode (WASM)**: Runs statically (e.g. on [whonet-tool.vercel.app](https://whonet-tool.vercel.app/)) using `sql.js` (WebAssembly SQLite) in the browser. Uses the **File System Access API** with IndexedDB persistent handles to read and auto-save changes directly to local `.sqlite` files on disk without cloud transmission.

```
                  ┌────────────────────────────────────────────────────────┐
                  │                 Browser Client UI                     │
                  │   (Vanilla JS ES Modules + Native CSS Tokens)          │
                  └───────────┬────────────────────────────────┬───────────┘
                              │                                │
                 [state.isWasmMode === false]     [state.isWasmMode === true]
                              ▼                                ▼
                  ┌──────────────────────┐         ┌───────────────────────┐
                  │   Node.js Backend    │         │  In-Browser SQLite    │
                  │   (server.js)        │         │  (sql.js WASM)        │
                  │                      │         │                       │
                  │  - DatabaseSync      │         │  - wasm-emulator.js   │
                  │  - NATURAL_KEY UDF   │         │  - NATURAL_KEY UDF    │
                  │  - Live-Reload SSE   │         │  - File System Access │
                  └───────────┬──────────┘         └───────────┬───────────┘
                              │                                │
                              ▼                                ▼
                  ┌──────────────────────┐         ┌───────────────────────┐
                  │ Disk (C:\WHONET\Data)│         │ Disk (Direct Handle)  │
                  └──────────────────────┘         └───────────────────────┘
```

---

## 2. Frontend Modular Directory Schema (`src/js/`)

The frontend is structured in native ES Modules (`<script type="module" src="js/main.js"></script>`). No Webpack, Vite, or bundle build steps are required.

```
src/
├── index.html                  # HTML5 UI shell & semantic layout
├── styles.css                  # CSS Variables, dark/light themes, typography
├── organisms.js                # WHONET organism dictionary mapping
├── vendor/                     # sql.js WASM runtime & wasm binary
└── js/
    ├── main.js                 # Application entry point & backward-compat window bridge
    │
    ├── state/
    │   └── store.js            # Reactive application state, observers & badge updates
    │
    ├── api/
    │   ├── client.js           # Unified hybrid API dispatcher (`api()`)
    │   └── wasm-emulator.js    # Client-side route emulator for offline WASM execution
    │
    ├── db/
    │   ├── wasm.js             # sql.js loader, schema normalization & export
    │   └── filesystem.js       # File System Access API, IndexedDB folder persistence
    │
    ├── ui/
    │   ├── table.js            # renderSortHeader(), renderPagination()
    │   ├── toast.js            # Toast alerts with semantic icons
    │   └── modal.js            # Detail view, edit form, and confirm dialogs
    │
    ├── utils/
    │   ├── natural-sort.js     # naturalKey() & naturalCompare() algorithms
    │   ├── formatters.js       # Date formatters, HTML sanitization, debouncing
    │   └── organisms.js        # Organism badge rendering & full name lookup
    │
    └── pages/
        ├── dashboard.js        # KPI cards & Chart.js dynamic visual analytics
        ├── isolates.js         # Isolates table, multi-parameter search & sort
        ├── duplicates.js       # Cluster grouping, duplicate modes & batch delete
        ├── monthly-amr.js      # Surveillance reporting matrix & CSV/TSV exports
        ├── sql-workspace.js    # SQL query console & contextual autocomplete
        └── fixes.js            # Bulk data cleansing operations
```

---

## 3. Module Responsibilities & Contracts

| Module | Core Exports | Primary Responsibility |
|---|---|---|
| `state/store.js` | `state`, `subscribe`, `markModified`, `setRuntimeBadge` | Single source of truth for active database, pagination, filters, and modified flags. |
| `api/client.js` | `api(path, options)`, `API_BASE` | Dispatches requests to `wasm-emulator.js` if in browser WASM mode, or `fetch()` if connected to Node server. |
| `api/wasm-emulator.js`| `handleWasmApi(path, options)` | Emulates backend endpoints (`/api/stats`, `/api/isolates`, `/api/duplicates`, etc.) inside browser WASM memory. |
| `db/wasm.js` | `getSqlJs`, `wasmSelect`, `wasmRun`, `saveToFileHandle` | Direct execution interface to the WebAssembly SQLite instance; registers custom SQLite functions. |
| `db/filesystem.js` | `chooseWhonetFolder`, `restoreWhonetFolder`, `scanWhonetFolder` | Handles directory picker permissions and preserves access handles across browser sessions via IndexedDB. |
| `ui/table.js` | `renderSortHeader`, `renderPagination` | Generates accessible, sortable `<th>` headers with dynamic arrow icons and unified pagination controls. |
| `ui/modal.js` | `viewDetail`, `openEditModal`, `confirmDeleteRow` | Modal dialog controllers, inline cell editor, and deletion confirmation guards. |
| `utils/natural-sort.js` | `naturalKey`, `naturalCompare` | Natural alphanumeric ordering engine that pads numeric segments to 12 digits. |
| `pages/dashboard.js` | `loadStats`, `updateDashboardCharts`, `switchDb` | Renders executive summary counters and responsive Chart.js visual distribution graphs. |
| `pages/isolates.js` | `loadIsolates`, `sortIsolates`, `renderIsolatesTable` | All Isolates table controller with natural column sorting and live search filters. |
| `pages/duplicates.js` | `loadDuplicates`, `sortDuplicates`, `setDupMode` | Deduplication interface supporting Specimen # vs Patient ID clustering and multi-row selection. |
| `pages/monthly-amr.js` | `loadMonthlyAmrData`, `renderAmrTable`, `exportAmrCsv` | National AMR Surveillance matrix (OPD/IPD/ICU vs Specimen Types) with TSV/CSV export. |
| `pages/sql-workspace.js` | `runSQL`, `sortSqlTable`, `initSqlAutocomplete` | Arbitrary SQL query execution engine with intelligent caret-based keyword/column autocomplete. |
| `pages/fixes.js` | `bulkFix`, `fixCasingAndRefresh` | Sanitizes data (e.g. UPPERCASE specimen normalization, whitespace cleanup). |

---

## 4. WHONET Database Schema Reference

The tool interacts primarily with the `Isolates` table inside WHONET SQLite databases:

```sql
CREATE TABLE Isolates (
  ROW_IDX       INTEGER PRIMARY KEY,
  SPEC_NUM      TEXT,          -- Specimen number (e.g. CSR-1, 2026/01/10)
  PATIENT_ID    TEXT,          -- Patient identifier / Hospital MRN
  FULL_NAME     TEXT,          -- Patient Name (or computed virtual column)
  SPEC_DATE     TEXT,          -- Collection date (YYYY-MM-DD)
  SPEC_TYPE     TEXT,          -- Sample type (bl=blood, ur=urine, ps=pus, sp=sputum, cs=csf, st=stool)
  ORGANISM      TEXT,          -- WHONET organism code (e.g. eco, sau, kpn, pae)
  SEX           TEXT,          -- m=male, f=female, u=unknown
  AGE           TEXT,          -- Numerical age or age format
  AGE_GROUP     TEXT,          -- Age cohort category
  WARD          TEXT,          -- Ward name / clinic identifier
  WARD_TYPE     TEXT,          -- in=inpatient, out=outpatient, icu=intensive care
  DEPARTMENT    TEXT,          -- Hospital department
  INSTITUT      TEXT,          -- Hospital or health facility code
  DATE_ADMIS    TEXT,          -- Hospital admission date
  DATE_DATA     TEXT,          -- Data entry date
  COMMENT       TEXT,          -- Clinical / laboratory remarks
  ESBL          TEXT,          -- + or -
  CARBAPENEM    TEXT,          -- + or -
  MRSA          TEXT,          -- + or -
  URINECOUNT    TEXT,          -- Colony forming units (CFU/mL)
  SEROTYPE      TEXT,          -- Organism serotype
  BETA_LACT     TEXT,          -- Beta-lactamase production flag
  INDUC_CLI     TEXT           -- Inducible Clindamycin resistance
  -- Followed by antimicrobial ND / MIC test result columns:
  -- AMP_ND10, AMC_ND30, CRO_ND30, MEM_ND10, CIP_ND5, VAN_ND30, etc.
);
```

---

## 5. Universal Natural Sort Engine (`NATURAL_KEY`)

### Problem
ASCII sorting arranges string characters sequentially, causing `CSR-10` and `CSR-151` to precede `CSR-2`.

### Normalization Algorithm
Any continuous block of digits is padded to a 12-digit zero-prefixed string:

$$\text{"CSR-1"} \longrightarrow \text{"csr-000000000001"}$$
$$\text{"CSR-151"} \longrightarrow \text{"csr-000000000151"}$$
$$\text{"CSR-2"} \longrightarrow \text{"csr-000000000002"}$$

### Implementation:
- **Node.js**: Registered via `db.function('NATURAL_KEY', fn)` in `server.js`.
- **WASM Browser**: Registered via `db.create_function('NATURAL_KEY', fn)` in `src/js/db/wasm.js`.
- **Client JS Sorting**: Performed with `naturalCompare(a, b)` using `localeCompare(..., { numeric: true })` in `src/js/utils/natural-sort.js`.
