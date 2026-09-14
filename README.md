# WHONET Data Tool

<p>High-performance, open-source utility for inspecting, deduplicating, sorting, and analyzing WHONET SQLite databases.</p>
<p>🌐 <strong><a href="https://whonet-tool.vercel.app/">whonet-tool.vercel.app</a></strong></p>

---

> [!IMPORTANT]
> All data is processed **locally** — nothing is uploaded to any cloud server. Verify all generated figures before submitting to any surveillance body.

## Features

- **Deduplication** — Identify and resolve duplicate isolates clustered by `SPEC_NUM` (Specimen #) or `PATIENT_ID` with batch selection and deletion.
- **Natural Column Sorting** — Interactive click-to-sort headers with intelligent alphanumeric ordering for specimen numbers (e.g. `CSR-1`, `CSR-2`, `CSR-10`, `CSR-151`, `-1/-2`, `-A/-B` suffixes) across Isolates, Duplicates, and SQL Workspace.
- **Monthly AMR Surveillance Report** — Standard National AMR Containment C&S reporting matrix (OPD/IPD/ICU × specimen type) with instant TSV clipboard copy and CSV export.
- **Interactive Visual Analytics** — Real-time Chart.js distribution charts (Organisms, Specimen Types, Wards, Age Groups, Gender, AMR Phenotypes) with dynamic date range filtering and single/dual view toggles.
- **In-Place Record Corrections** — Clean, inline field editing and full-record correction modals with immediate database sync.
- **Bulk Data Cleansing** — One-click uppercase specimen normalization and whitespace sanitation.
- **Intelligent SQL Console** — Built-in query editor with schema-aware autocomplete, keyboard shortcuts, and instant result table sorting.
- **Dual Runtime Architecture** — Runs either completely client-side in the browser via WebAssembly (`sql.js`), or locally via Node.js native `DatabaseSync` (`node:sqlite`).

---

## Usage

### Web App (Client-Side WASM Mode)
Open **[whonet-tool.vercel.app](https://whonet-tool.vercel.app/)** in Chrome or Edge:
- **File System Access**: Grant folder access once (`C:\WHONET\Data`) → the browser remembers the handle via IndexedDB and auto-saves changes directly to disk.
- **Bundled Samples**: Test immediately with preloaded WHO sample databases (`WHO-TST-2020-01.sqlite`, etc.).
- **100% Private**: Database engine runs entirely in browser memory; zero network data transfer.

### Local Server Mode
1. Install [Node.js LTS](https://nodejs.org/) (v22+ recommended)
2. Run `Start-WHONET.bat` or use the command line:
   ```bash
   npm start       # start server on http://localhost:7890
   npm run dev     # start with auto-restart on file changes
   ```
3. Browser automatically opens at `http://localhost:7890`.
4. Reads `.sqlite` files directly from `C:\WHONET\Data`. Mutations save straight to disk with on-demand connection locking.

---

## Project Structure & Modular Schema

The frontend is built using standard native ES Modules without requiring Webpack or build bundlers:

```
├── docs/
│   └── modular-schema.md   # Architectural specification & schema guide
├── src/
│   ├── index.html          # Application UI layout & modals
│   ├── styles.css          # Design system, themes & typography
│   ├── organisms.js        # WHONET organism dictionary
│   ├── vendor/             # sql.js WebAssembly engine
│   ├── sample-data/        # Bundled sample SQLite files
│   └── js/
│       ├── main.js         # ES Module entry point & global event bridge
│       ├── state/store.js  # Reactive application state
│       ├── api/            # Hybrid API dispatcher & WASM emulator
│       ├── db/             # WebAssembly database & File System Access API
│       ├── ui/             # Table sorting, modals, and toasts
│       ├── utils/          # Natural sort, formatters, and organism badges
│       └── pages/          # Dashboard, Isolates, Duplicates, AMR, SQL, Fixes
├── server.js               # Node.js backend (native sqlite & static server)
├── Start-WHONET.bat        # Windows one-click launcher
└── vercel.json             # Static web deployment routing
```

For complete technical specifications, module contracts, and database table diagrams, refer to **[docs/modular-schema.md](docs/modular-schema.md)**.

---

## Disclaimer

**WHONET** is the intellectual property of the WHO Collaborating Centre for Surveillance of Antimicrobial Resistance (Brigham and Women's Hospital). [whonet.org](https://whonet.org)

This project is an independent open-source utility by [Dr. Darshit Mistry](https://drshtmstry.github.io/) and is not affiliated with, endorsed by, or sponsored by WHONET.
