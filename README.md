# WHONET Data Tool

<div align="center">
  <img src="https://whonet.org/img/WHONET_Logo_transparentbg.png" alt="WHONET Logo" width="100" />
  <h3>Laboratory Database Management, Deduplication &amp; AMR Surveillance Reporting</h3>
  <p>Free open-source community utility for clinical and public health microbiologists.</p>
  <p>
    🌐 <strong>Live Web App:</strong> <a href="https://whonet-tool.vercel.app/">https://whonet-tool.vercel.app/</a>
  </p>
</div>

---

## 🌐 Live Web App

Use the tool directly in your browser without any installation:
**[https://whonet-tool.vercel.app/](https://whonet-tool.vercel.app/)**

> [!IMPORTANT]
>
> - **100% Private & Client-Side**: This tool **does not upload any data to servers**. All SQLite processing, queries, deduplication, and calculations happen strictly locally within your browser using WebAssembly (`sql.js`).
> - **Data Quality Dependency**: Generated surveillance statistics, counts, and monthly breakdown tables depend directly on the quality, completeness, and standardization of data entered in your WHONET laboratory records (e.g., organism codes, specimen types, ward designations).
> - **Mandatory Verification**: All generated figures and tables must be **verified manually by qualified laboratory personnel / microbiologists** before submitting to any state, national, or organizational surveillance bodies (such as SAPCAR-Gujarat, ICMR, or national AMR containment programs).

## 🖥️ Localhost Browser App

The Windows workflow uses the user’s normal browser and a small local Node.js server. It provides direct access to `.sqlite` files in `C:\WHONET\Data` without bundling Electron or creating a separate application executable.

Install Node.js LTS, run `Start-WHONET.bat`, and the browser opens at `http://localhost:7890`. The server only listens on `127.0.0.1`, and all database processing remains on the local computer.

The localhost mode automatically discovers `.sqlite` files in `C:\WHONET\Data`, supports opening custom paths, and writes changes directly to the selected database. Keep the official WHONET application closed while modifying the same database file.

### Web Deployment and File Access

The deployed web app also supports browser-only SQLite processing through `sql.js` and WebAssembly:

- Select a folder containing WHONET `.sqlite` files. The selected folder is remembered by the browser for future visits.
- Browse for one specific `.sqlite` file from any folder.
- In Chrome or Edge, save changes directly to the selected file using the browser’s file permission prompt.
- In browsers without writable file handles, export the modified database as a new `.sqlite` download.

Browsers cannot silently open an arbitrary Windows path on a first visit. The first deployed visit therefore requires selecting `C:\WHONET\Data` once; later visits can restore it when permission remains available. The deployed sample databases are served from `public/sample-data` through the Vercel routes in `vercel.json`.

### Instructions for Users

1. Install Node.js LTS.
2. Download or clone this project.
3. Run `Start-WHONET.bat`.
4. Select a database from `C:\WHONET\Data` in the browser.
5. Edit and save the database.

The app processes data locally and does not upload WHONET records. Keep a backup of important databases before making bulk changes. The official WHONET application should be closed when modifying the same database file.

No executable is required. The server runs only while the browser tool is in use and listens on `127.0.0.1`.

---

## 📖 Overview

The **WHONET Data Tool** is a web-based utility designed to inspect, deduplicate, clean, and analyze antimicrobial resistance (AMR) laboratory databases stored in SQLite format (`.sqlite`). It supports both local automated path discovery and web-based drag-and-drop file inspection.

### Key Features

- **Zero-Lock Database Engine**: On-demand SQLite access with automatic connection closing, preventing Windows file locking conflicts with official WHONET software.
- **Two Flexible Loading Modes**:
  1. **Direct Path Reading**: Auto-discovers and reads `.sqlite` files directly from `C:\WHONET\Data` or any custom system path.
  2. **Drag & Drop / Upload**: Select or drop `.sqlite` files directly into the browser.
- **Deduplication Engine**: Identify duplicates grouped either by **Specimen Number (`SPEC_NUM`)** or by **Patient ID (`PATIENT_ID`)**, with options to delete all duplicates or preserve specific isolate rows.
- **Monthly AMR Surveillance Report (SAPCAR-Gujarat / National AMR Containment)**:
  - Generates standard monthly reporting tables showing culture totals and positive cultures across source (OPD, IPD, ICU, Others) and specimen type (Blood, Pus, Sputum, Urine, Others).
  - Micro-accurate culture growth rules:
    - **Blood (`bl`)**: Sterile / no growth excludes `xxx`, `xpa`, `xep`, `xsg`, `nor`, and skin contaminants (`scn` / CoNS).
    - **Other Specimens**: Sterile / no growth excludes `xxx`, `xpa`, `xep`, `xsg`, `nor`, `ora`, and `vag`.
  - One-click **Copy Table (TSV / Excel)** and **Export All Months (CSV)**.
- **Dynamic Visual Analytics & Charts (Bar & Pie/Doughnut)**:
  - Interactive distribution charts across key parameters: Organisms, Specimen Types, Wards, Location Types (OPD/IPD/ICU), Departments, Gender, Age Demographics, and AMR phenotypes (ESBL, Carbapenem, MRSA).
  - Time period filtering: All Time, Last 3 Months, Last 6 Months, Last 12 Months, or Custom Start/End Date Range.
  - View layout toggles: Dual Bar + Pie, Bar Only, or Doughnut/Pie Only.
- **Bulk Corrections**: Normalize casing (`SPEC_NUM`, `PATIENT_ID` to uppercase, `ORGANISM` to lowercase) and trim whitespace across all fields.
- **Built-in SQL Editor**: Execute custom SQLite queries directly against active databases.

---

## 📂 Repository Structure

```text
whonet/
├── src/
│   ├── index.html          # Frontend UI with disclaimer & source modals
│   ├── app.js              # Client logic (Hybrid: Node API + WebAssembly sql.js)
│   ├── styles.css           # Design system & dark theme
│   └── vendor/              # Offline SQLite WebAssembly runtime
├── server.js               # Localhost server with on-demand SQLite
├── Start-WHONET.bat        # Simple local browser launcher
├── package.json            # Local development and validation scripts
├── vercel.json             # Vercel static routing configuration
├── README.md               # Documentation & usage instructions
└── .gitignore              # Ignores *.sqlite, node_modules, etc.
```

---

## 🚀 Getting Started

### Local Browser App

Install Node.js LTS once, then install the dependencies:

```bash
npm install
```

Run the local server and open the browser:

```bash
npm start
```

Available npm scripts:

```bash
npm start       # Start the localhost server
npm run dev     # Start with automatic server restarts
npm run check   # Check server and browser JavaScript syntax
npm run build   # Run the project validation check
```

For development with automatic server restarts, run:

```bash
npm run dev
```

To validate the project scripts, run:

```bash
npm run check
```

Then open [http://localhost:7890](http://localhost:7890) in your browser. On Windows, `Start-WHONET.bat` starts the local server and opens the browser automatically.

---

## ⚖️ Legal & Ownership Disclaimer

**WHONET** is the intellectual property of the **WHO Collaborating Centre for Surveillance of Antimicrobial Resistance** (Brigham and Women's Hospital & Harvard Medical School, co-founded by Drs. Thomas O'Brien & John Stelling). Copyright © WHONET 1989–2026. Official website: [https://whonet.org](https://whonet.org).

This data tool is an independent, free open-source utility developed by [Dr. Darshit Mistry](https://drshtmstry.github.io/) for community benefit.
