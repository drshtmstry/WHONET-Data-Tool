# WHONET Data Tool

<div align="center">
  <img src="https://whonet.org/img/WHONET_Logo_transparentbg.png" alt="WHONET Logo" width="100" />
  <h3>Laboratory Database Management, Deduplication &amp; AMR Surveillance Reporting</h3>
  <p>Free open-source community utility for clinical and public health microbiologists.</p>
</div>

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
    - **Blood (`bl`)**: Sterile / no growth excludes `xxx`, `xpa`, `xep`, `xsg`, `nor`, and skin contaminants (`scn` / CoNS). *(Oral and vaginal flora are not applicable to blood).*
    - **Other Specimens**: Sterile / no growth excludes `xxx`, `xpa`, `xep`, `xsg`, `nor`, `ora` (oral flora), and `vag` (vaginal flora).
  - One-click **Copy Table (TSV / Excel)** and **Export All Months (CSV)**.
- **Bulk Corrections**: Normalize casing (`SPEC_NUM`, `PATIENT_ID` to uppercase, `ORGANISM` to lowercase) and trim whitespace across all fields.
- **Built-in SQL Editor**: Execute custom SQLite queries directly against active databases.

---

## 📂 Repository Structure

```text
whonet/
├── src/
│   ├── index.html          # Frontend UI with disclaimer & source modals
│   ├── app.js              # Client logic (Hybrid: Node API + WebAssembly sql.js)
│   └── styles.css          # Design system & dark theme
├── server.js               # Zero-lock Node.js server with on-demand SQLite
├── package.json            # Scripts & metadata
├── vercel.json             # Vercel static routing configuration
├── README.md               # Documentation & usage instructions
└── .gitignore              # Ignores *.sqlite, node_modules, etc.
```

---

## 🚀 Getting Started

Run the development server locally:
```bash
npm run dev
```

Open [http://localhost:7890](http://localhost:7890) in your browser.

---

## ⚖️ Legal & Ownership Disclaimer

**WHONET** is the intellectual property of the **WHO Collaborating Centre for Surveillance of Antimicrobial Resistance** (Brigham and Women's Hospital & Harvard Medical School, co-founded by Drs. Thomas O'Brien & John Stelling). Copyright © WHONET 1989–2026. Official website: [https://whonet.org](https://whonet.org).

This data tool is an independent, free open-source utility developed by [Dr. Darshit Mistry](https://drshtmstry.github.io/) for community benefit.
