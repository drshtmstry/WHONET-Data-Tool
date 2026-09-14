# WHONET Data Tool

<p>Open-source utility for inspecting, deduplicating, and analyzing WHONET SQLite databases.</p>
<p>🌐 <strong><a href="https://whonet-tool.vercel.app/">whonet-tool.vercel.app</a></strong></p>

---

> [!IMPORTANT]
> All data is processed **locally** — nothing is uploaded to any server. Verify all generated figures before submitting to any surveillance body.

## Usage

### Web App
Open **[whonet-tool.vercel.app](https://whonet-tool.vercel.app/)** in Chrome or Edge.
- Grant folder access once → browser remembers it; changes auto-save directly to disk.
- Try it instantly with the bundled sample databases.

### Local Server
1. Install [Node.js LTS](https://nodejs.org/)
2. Run `Start-WHONET.bat`
3. Browser opens at `http://localhost:7890`

Reads `.sqlite` files directly from `C:\WHONET\Data`. Writes go straight to disk — no save step needed. Keep official WHONET closed when editing the same file.

```bash
npm start       # start server
npm run dev     # start with auto-restart on file changes
```

## Features

- **Deduplication** — find and remove duplicate isolates by `SPEC_NUM` or `PATIENT_ID`
- **Monthly AMR Report** — standard C&S reporting table (OPD/IPD/ICU × specimen type) with CSV export and TSV copy
- **Charts** — organism, specimen, ward, location, gender, age, and AMR phenotype (ESBL/Carbapenem/MRSA) distributions with date-range filtering
- **Bulk Corrections** — normalize casing, trim whitespace
- **SQL Editor** — run custom queries against the active database

## Structure

```
src/
  index.html      UI
  app.js          Client logic (Node API + sql.js WebAssembly)
  styles.css      Styles
  vendor/         Offline SQLite WASM runtime
  sample-data/    Bundled sample databases
server.js         Local Node server
Start-WHONET.bat  Windows launcher
vercel.json       Vercel routing
```

## Disclaimer

**WHONET** is the intellectual property of the WHO Collaborating Centre for Surveillance of Antimicrobial Resistance (Brigham and Women's Hospital). [whonet.org](https://whonet.org)

This project is an independent open-source utility by [Dr. Darshit Mistry](https://drshtmstry.github.io/) and is not affiliated with, endorsed by, or sponsored by WHONET.

