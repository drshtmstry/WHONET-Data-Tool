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

## 🖥️ Standalone Windows App

For editing WHONET databases directly on a laboratory computer, use the portable Windows app. It runs locally and does not require internet access, Node.js, or a separate server window.

### Instructions for Users

1. Open the project’s **GitHub Releases** page.
2. Download the latest `WHONET Data Tool.exe` release asset. Do not download the source-code ZIP for normal use.
3. If Windows shows a SmartScreen message, verify that the file came from the official project release, then choose **More info** and **Run anyway**.
4. Double-click the downloaded executable.
5. Select a database from `C:\WHONET\Data` inside the app.
6. Edit and save the database.

The app processes data locally and does not upload WHONET records. Keep a backup of important databases before making bulk changes. The official WHONET application should be closed when modifying the same database file.

## 📦 Publishing a GitHub Release

After running `npm run build:desktop`, upload this file as a GitHub Release asset:

```text
desktop-dist/WHONET Data Tool 1.0.0.exe
```

Do not publish WHONET `.sqlite` files, patient data, database backups, credentials, API keys, or `node_modules`. The executable contains the application only; user databases remain on the local computer.

Because the executable is not code-signed, Windows may display a SmartScreen warning on first launch. Users should verify that the file was downloaded from the project’s official GitHub Release before choosing **More info** and **Run anyway**.

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
├── server.js               # Zero-lock Node.js server with on-demand SQLite
├── electron-main.cjs       # Native desktop window entry point
├── Start-WHONET.bat        # Simple local browser launcher
├── package.json            # Scripts & metadata
├── vercel.json             # Vercel static routing configuration
├── README.md               # Documentation & usage instructions
└── .gitignore              # Ignores *.sqlite, node_modules, etc.
```

---

## 🚀 Getting Started

### Standalone Desktop Build

Install Node.js once, install the dependencies, and build the portable Windows app:

```bash
npm install
npm run build:desktop
```

The executable is created at:

```text
desktop-dist/WHONET Data Tool 1.0.0.exe
```

For local browser development, run:

```bash
npm run dev
```

Then open [http://localhost:7890](http://localhost:7890) in your browser. On Windows, `Start-WHONET.bat` starts the local server and opens the browser automatically.

---

## ⚖️ Legal & Ownership Disclaimer

**WHONET** is the intellectual property of the **WHO Collaborating Centre for Surveillance of Antimicrobial Resistance** (Brigham and Women's Hospital & Harvard Medical School, co-founded by Drs. Thomas O'Brien & John Stelling). Copyright © WHONET 1989–2026. Official website: [https://whonet.org](https://whonet.org).

This data tool is an independent, free open-source utility developed by [Dr. Darshit Mistry](https://drshtmstry.github.io/) for community benefit.
