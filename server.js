import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import { URL } from "node:url";
import { exec } from "node:child_process";

import { watch } from "node:fs";

const __dirname = process.pkg
  ? dirname(process.execPath)
  : dirname(fileURLToPath(import.meta.url));
const WHONET_DIR = "C:\\WHONET\\Data";

// Live-reload SSE clients
const liveReloadClients = new Set();

function broadcastReload() {
  for (const client of liveReloadClients) {
    try {
      client.write("data: reload\n\n");
    } catch (_) {
      liveReloadClients.delete(client);
    }
  }
}

// Watch src folder for changes to auto-reload browser
const srcDir = join(__dirname, "src");
if (!process.env.WHONET_NO_WATCH && existsSync(srcDir)) {
  let debounceTimer = null;
  watch(srcDir, { recursive: true }, (eventType, filename) => {
    if (
      filename &&
      (filename.endsWith(".html") ||
        filename.endsWith(".js") ||
        filename.endsWith(".css"))
    ) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(
          `[Auto-Sync] File changed: ${filename}, refreshing browser tabs...`,
        );
        broadcastReload();
      }, 150);
    }
  });
}

// Auto-discover all .sqlite files in the data directory
function getDbFiles() {
  try {
    return readdirSync(WHONET_DIR)
      .filter((f) => f.toLowerCase().endsWith(".sqlite"))
      .sort();
  } catch (e) {
    console.error(`Could not read ${WHONET_DIR}:`, e.message);
    return [];
  }
}

let DB_FILES = getDbFiles();

let currentDbFile = null;
let currentDbFullPath = null;

function setTargetDb(filename, customPath = null) {
  currentDbFile = filename;
  currentDbFullPath = customPath || join(WHONET_DIR, filename);
}

// Execute query with on-demand connection that closes immediately, freeing the file lock
function withDb(callback) {
  if (!currentDbFullPath) {
    throw new Error("No database selected");
  }
  const db = new DatabaseSync(currentDbFullPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.function("NATURAL_KEY", (str) => {
      if (str === null || str === undefined) return "";
      return String(str)
        .toLowerCase()
        .replace(/\d+/g, (m) => m.padStart(12, "0"));
    });
    return callback(db);
  } finally {
    try {
      db.close();
    } catch (_) {}
  }
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

const staticMiddleware = express.static(join(__dirname, "src"), {
  index: "index.html",
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".html") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  }
});
const publicMiddleware = express.static(join(__dirname, "public"));

function handleRequest(req, res) {
  const urlObj = new URL(req.url, `http://localhost`);
  const path = urlObj.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (path === "/api/live-reload") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write("data: connected\n\n");
    liveReloadClients.add(res);
    req.on("close", () => liveReloadClients.delete(res));
    return;
  }

  // Standard Express static serving
  staticMiddleware(req, res, () => {
    publicMiddleware(req, res, () => {
      handleApi(req, res);
    });
  });
}

function handleApi(req, res) {
  const urlObj = new URL(req.url, `http://localhost`);
  const path = urlObj.pathname;

  if (path === "/api/schema" && req.method === "GET") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    try {
      withDb((db) => {
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
          )
          .all()
          .map((t) => t.name);
        const columns = {};
        for (const t of tables) {
          try {
            columns[t] = db
              .prepare(`PRAGMA table_info("${t.replace(/"/g, '""')}")`)
              .all()
              .map((c) => c.name);
          } catch (_) {
            columns[t] = [];
          }
        }
        sendJson(res, { tables, columns });
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (path === "/api/databases" && req.method === "GET") {
    DB_FILES = getDbFiles(); // refresh from disk
    return sendJson(res, { databases: DB_FILES, current: currentDbFile });
  }

  if (path === "/api/open-database" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const { filename, path: customPath } = JSON.parse(body);
        if (customPath) {
          if (!existsSync(customPath))
            return sendJson(
              res,
              { error: "File does not exist: " + customPath },
              400,
            );
          const base = basename(customPath);
          setTargetDb(base, customPath);
          const count = withDb((db) =>
            db.prepare("SELECT COUNT(*) as c FROM Isolates").get(),
          );
          return sendJson(res, {
            ok: true,
            filename: base,
            path: customPath,
            count: count.c,
          });
        }

        if (!DB_FILES.includes(filename))
          return sendJson(res, { error: "Invalid database" }, 400);
        setTargetDb(filename);
        const count = withDb((db) =>
          db.prepare("SELECT COUNT(*) as c FROM Isolates").get(),
        );
        sendJson(res, { ok: true, filename, count: count.c });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // Upload/drop SQLite database file
  if (path === "/api/upload-database" && req.method === "POST") {
    const filename = decodeURIComponent(
      urlObj.searchParams.get("filename") || "uploaded.sqlite",
    );
    const safeName = basename(filename);
    const targetPath = join(WHONET_DIR, safeName);

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const buffer = Buffer.concat(chunks);
        // Save to WHONET_DIR if possible, otherwise local data directory
        try {
          writeFileSync(targetPath, buffer);
          setTargetDb(safeName, targetPath);
        } catch (err) {
          // fallback to directory alongside script
          const localPath = join(__dirname, safeName);
          writeFileSync(localPath, buffer);
          setTargetDb(safeName, localPath);
        }

        DB_FILES = getDbFiles();
        if (!DB_FILES.includes(safeName)) DB_FILES.push(safeName);

        const count = withDb((db) =>
          db.prepare("SELECT COUNT(*) as c FROM Isolates").get(),
        );
        sendJson(res, {
          ok: true,
          filename: safeName,
          count: count.c,
          databases: DB_FILES,
        });
      } catch (e) {
        sendJson(
          res,
          { error: "Failed to process SQLite file: " + e.message },
          500,
        );
      }
    });
    return;
  }

  if (path === "/api/stats" && req.method === "GET") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    try {
      withDb((db) => {
        const total = db.prepare("SELECT COUNT(*) as c FROM Isolates").get().c;
        const dupInfo = db
          .prepare(
            `
          SELECT COUNT(*) as dupRows, COUNT(DISTINCT UPPER(SPEC_NUM)) as dupGroups
          FROM Isolates WHERE SPEC_NUM IS NOT NULL AND SPEC_NUM != '' AND UPPER(SPEC_NUM) IN (
            SELECT UPPER(SPEC_NUM) FROM Isolates WHERE SPEC_NUM IS NOT NULL AND SPEC_NUM != '' GROUP BY UPPER(SPEC_NUM) HAVING COUNT(*) > 1
          )
        `,
          )
          .get();
        const dupPtInfo = db
          .prepare(
            `
          SELECT COUNT(*) as dupPtRows, COUNT(DISTINCT UPPER(PATIENT_ID)) as dupPtGroups
          FROM Isolates WHERE PATIENT_ID IS NOT NULL AND PATIENT_ID != '' AND UPPER(PATIENT_ID) IN (
            SELECT UPPER(PATIENT_ID) FROM Isolates WHERE PATIENT_ID IS NOT NULL AND PATIENT_ID != '' GROUP BY UPPER(PATIENT_ID) HAVING COUNT(*) > 1
          )
        `,
          )
          .get();
        const organisms = db
          .prepare(
            "SELECT DISTINCT ORGANISM FROM Isolates WHERE ORGANISM != '' ORDER BY ORGANISM",
          )
          .all()
          .map((r) => r.ORGANISM);
        const wards = db
          .prepare(
            "SELECT DISTINCT WARD FROM Isolates WHERE WARD != '' ORDER BY WARD",
          )
          .all()
          .map((r) => r.WARD);
        sendJson(res, {
          total,
          dupRows: dupInfo.dupRows,
          dupGroups: dupInfo.dupGroups,
          dupPtRows: dupPtInfo.dupPtRows,
          dupPtGroups: dupPtInfo.dupPtGroups,
          organisms,
          wards,
        });
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (path === "/api/duplicates" && req.method === "GET") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    try {
      const page = parseInt(urlObj.searchParams.get("page") || "1");
      const pageSize = parseInt(urlObj.searchParams.get("pageSize") || "50");
      const mode = (urlObj.searchParams.get("mode") || "spec").toLowerCase();
      const search = (urlObj.searchParams.get("search") || "").replace(
        /'/g,
        "''",
      );
      const offset = (page - 1) * pageSize;

      const groupCol =
        mode === "patient" ? "UPPER(PATIENT_ID)" : "UPPER(SPEC_NUM)";
      const notEmptyCond =
        mode === "patient"
          ? "PATIENT_ID IS NOT NULL AND PATIENT_ID != ''"
          : "SPEC_NUM IS NOT NULL AND SPEC_NUM != ''";
      let searchCond = "";
      if (search) {
        searchCond = `AND (${groupCol} LIKE UPPER('%${search}%') OR UPPER(FULL_NAME) LIKE UPPER('%${search}%'))`;
      }

      const ALLOWED_DUP_COLS = {
        ROW_IDX: "ROW_IDX",
        MATCHED: groupCol,
        OTHER: mode === "patient" ? "UPPER(SPEC_NUM)" : "UPPER(PATIENT_ID)",
        SPEC_NUM: "SPEC_NUM",
        PATIENT_ID: "PATIENT_ID",
        FULL_NAME: "FULL_NAME",
        SPEC_DATE: "SPEC_DATE",
        SPEC_TYPE: "SPEC_TYPE",
        ORGANISM: "ORGANISM",
        SEX: "SEX",
        AGE: "AGE",
        WARD: "WARD",
      };
      const rawDupSort = urlObj.searchParams.get("sortCol")?.toUpperCase();
      const dupSortExpr = ALLOWED_DUP_COLS[rawDupSort] || null;
      const rawDupDir = (
        urlObj.searchParams.get("sortDir") || "ASC"
      ).toUpperCase();
      const dupSortDir = rawDupDir === "DESC" ? "DESC" : "ASC";

      let orderClause = `ORDER BY NATURAL_KEY(${groupCol}), row_num`;
      if (dupSortExpr) {
        if (rawDupSort === "MATCHED") {
          orderClause = `ORDER BY NATURAL_KEY(${groupCol}) ${dupSortDir}, row_num`;
        } else {
          const clusterAgg = dupSortDir === "DESC" ? "MAX" : "MIN";
          const clusterValExpr = `${clusterAgg}(NATURAL_KEY(${dupSortExpr})) OVER (PARTITION BY ${groupCol})`;
          orderClause = `ORDER BY 
            CASE WHEN ${clusterValExpr} IS NULL OR ${clusterValExpr} = '' THEN 1 ELSE 0 END,
            ${clusterValExpr} ${dupSortDir},
            NATURAL_KEY(${groupCol}),
            CASE WHEN ${dupSortExpr} IS NULL OR ${dupSortExpr} = '' THEN 1 ELSE 0 END,
            NATURAL_KEY(${dupSortExpr}) ${dupSortDir},
            row_num`;
        }
      }

      withDb((db) => {
        const rows = db
          .prepare(
            `
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
          ${orderClause}
          LIMIT ${pageSize} OFFSET ${offset}
        `,
          )
          .all();

        const totalCount = db
          .prepare(
            `
          SELECT COUNT(*) as c FROM (
            SELECT ROW_IDX, COUNT(*) OVER (PARTITION BY ${groupCol}) AS total_duplicates
            FROM Isolates
            WHERE ${notEmptyCond}
          ) WHERE total_duplicates > 1 ${searchCond}
        `,
          )
          .get().c;

        sendJson(res, { rows, totalCount, page, pageSize, mode });
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (path === "/api/isolates" && req.method === "GET") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    try {
      const page = parseInt(urlObj.searchParams.get("page") || "1");
      const pageSize = parseInt(urlObj.searchParams.get("pageSize") || "25");
      const search = (urlObj.searchParams.get("search") || "").replace(
        /'/g,
        "''",
      );
      const organism = (urlObj.searchParams.get("organism") || "").replace(
        /'/g,
        "''",
      );
      const ward = (urlObj.searchParams.get("ward") || "").replace(/'/g, "''");
      const offset = (page - 1) * pageSize;

      const ALLOWED_ISOLATE_COLS = {
        ROW_IDX: "ROW_IDX",
        SPEC_NUM: "SPEC_NUM",
        SPEC_DATE: "SPEC_DATE",
        SPEC_TYPE: "SPEC_TYPE",
        ORGANISM: "ORGANISM",
        FULL_NAME: "FULL_NAME",
        SEX: "SEX",
        AGE: "AGE",
        WARD: "WARD",
        DEPARTMENT: "DEPARTMENT",
        ESBL: "ESBL",
        CARBAPENEM: "CARBAPENEM",
        MRSA: "MRSA",
      };
      const rawSortCol = (
        urlObj.searchParams.get("sortCol") || "ROW_IDX"
      ).toUpperCase();
      const sortCol = ALLOWED_ISOLATE_COLS[rawSortCol] || "ROW_IDX";
      const rawSortDir = (
        urlObj.searchParams.get("sortDir") || "DESC"
      ).toUpperCase();
      const sortDir = rawSortDir === "ASC" ? "ASC" : "DESC";

      const orderClause =
        sortCol === "ROW_IDX"
          ? `ORDER BY ROW_IDX ${sortDir}`
          : `ORDER BY CASE WHEN ${sortCol} IS NULL OR ${sortCol} = '' THEN 1 ELSE 0 END, NATURAL_KEY(${sortCol}) ${sortDir}, ROW_IDX DESC`;

      const conditions = [];
      if (search)
        conditions.push(
          `(UPPER(SPEC_NUM) LIKE UPPER('%${search}%') OR UPPER(PATIENT_ID) LIKE UPPER('%${search}%') OR UPPER(FULL_NAME) LIKE UPPER('%${search}%'))`,
        );
      if (organism) conditions.push(`ORGANISM = '${organism}'`);
      if (ward) conditions.push(`WARD = '${ward}'`);
      const where =
        conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

      withDb((db) => {
        const rows = db
          .prepare(
            `
          SELECT ROW_IDX, PATIENT_ID, SPEC_DATE, SPEC_NUM, SPEC_TYPE, ORGANISM, FULL_NAME, SEX, AGE, WARD, DEPARTMENT, ESBL, CARBAPENEM, MRSA
          FROM Isolates ${where}
          ${orderClause}
          LIMIT ${pageSize} OFFSET ${offset}
        `,
          )
          .all();

        const totalCount = db
          .prepare(`SELECT COUNT(*) as c FROM Isolates ${where}`)
          .get().c;
        sendJson(res, { rows, totalCount, page, pageSize, sortCol, sortDir });
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (path === "/api/monthly-amr" && req.method === "GET") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    try {
      withDb((db) => {
        // Query all records with a valid SPEC_DATE
        const rows = db
          .prepare(
            `
          SELECT ROW_IDX, SPEC_NUM, SPEC_DATE, SPEC_TYPE, WARD_TYPE, WARD, DEPARTMENT, ORGANISM
          FROM Isolates
          WHERE SPEC_DATE IS NOT NULL AND LENGTH(SPEC_DATE) >= 7
        `,
          )
          .all();

        const monthMap = {};

        // Negative & commensal definitions:
        // Blood: 'xxx' (no growth), 'xpa', 'xep', 'xsg', 'nor' (normal flora), 'scn' (CoNS/skin contaminant)
        // Others: 'xxx', 'xpa', 'xep', 'xsg', 'nor', 'ora', 'vag'
        const bloodNoGrowth = ["xxx", "xpa", "xep", "xsg", "nor", "scn", ""];
        const othersNoGrowth = [
          "xxx",
          "xpa",
          "xep",
          "xsg",
          "nor",
          "ora",
          "vag",
          "",
        ];

        for (const r of rows) {
          const ym = (r.SPEC_DATE || "").substring(0, 7);
          if (!/^\d{4}-\d{2}$/.test(ym)) continue;

          if (!monthMap[ym]) {
            monthMap[ym] = {
              month: ym,
              totalRows: 0,
              srcSamples: { opd: 0, ipd: 0, icu: 0, others: 0, total: 0 },
              srcPositives: { opd: 0, ipd: 0, icu: 0, others: 0, total: 0 },
              typeSamples: {
                blood: 0,
                pus: 0,
                sputum: 0,
                urine: 0,
                others: 0,
                total: 0,
              },
              typePositives: {
                blood: 0,
                pus: 0,
                sputum: 0,
                urine: 0,
                others: 0,
                total: 0,
              },
            };
          }

          const m = monthMap[ym];
          m.totalRows++;

          const wt = (r.WARD_TYPE || "").toLowerCase();
          const st = (r.SPEC_TYPE || "").toLowerCase();
          const org = (r.ORGANISM || "").toLowerCase().trim();

          // Growth rule:
          // Blood (st === 'bl'): 'xxx', 'xpa', 'xep', 'xsg', 'nor', 'scn' are no growth / contaminants
          // Others (st !== 'bl'): 'xxx', 'xpa', 'xep', 'xsg', 'nor', 'ora', 'vag' are no growth
          const isPos =
            st === "bl"
              ? !bloodNoGrowth.includes(org)
              : !othersNoGrowth.includes(org);

          // By Source of sample (OPD / IPD / ICU / Others)
          if (wt === "out") {
            m.srcSamples.opd++;
            if (isPos) m.srcPositives.opd++;
          } else if (wt === "in") {
            m.srcSamples.ipd++;
            if (isPos) m.srcPositives.ipd++;
          } else if (wt === "icu") {
            m.srcSamples.icu++;
            if (isPos) m.srcPositives.icu++;
          } else {
            m.srcSamples.others++;
            if (isPos) m.srcPositives.others++;
          }

          // By Type of sample (Blood / Pus / Sputum / Urine / Others)
          if (st === "bl") {
            m.typeSamples.blood++;
            if (isPos) m.typePositives.blood++;
          } else if (st === "ps") {
            m.typeSamples.pus++;
            if (isPos) m.typePositives.pus++;
          } else if (st === "sp") {
            m.typeSamples.sputum++;
            if (isPos) m.typePositives.sputum++;
          } else if (st === "ur") {
            m.typeSamples.urine++;
            if (isPos) m.typePositives.urine++;
          } else {
            m.typeSamples.others++;
            if (isPos) m.typePositives.others++;
          }
        }

        // Calculate totals and sort months in ascending order
        const sortedMonths = Object.keys(monthMap).sort((a, b) =>
          a.localeCompare(b),
        );
        const monthlyData = sortedMonths.map((ym) => {
          const m = monthMap[ym];
          m.srcSamples.total =
            m.srcSamples.opd +
            m.srcSamples.ipd +
            m.srcSamples.icu +
            m.srcSamples.others;
          m.srcPositives.total =
            m.srcPositives.opd +
            m.srcPositives.ipd +
            m.srcPositives.icu +
            m.srcPositives.others;
          m.typeSamples.total =
            m.typeSamples.blood +
            m.typeSamples.pus +
            m.typeSamples.sputum +
            m.typeSamples.urine +
            m.typeSamples.others;
          m.typePositives.total =
            m.typePositives.blood +
            m.typePositives.pus +
            m.typePositives.sputum +
            m.typePositives.urine +
            m.typePositives.others;
          return m;
        });

        sendJson(res, {
          months: sortedMonths,
          monthlyData,
        });
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  // API: Dynamic chart aggregated analytics
  if (path === "/api/chart-data" && req.method === "GET") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    try {
      const param = (
        urlObj.searchParams.get("param") || "ORGANISM"
      ).toUpperCase();
      const period = urlObj.searchParams.get("period") || "all";
      const startDate = urlObj.searchParams.get("startDate") || "";
      const endDate = urlObj.searchParams.get("endDate") || "";

      const ALLOWED_PARAMS = [
        "ORGANISM",
        "SPEC_TYPE",
        "WARD",
        "WARD_TYPE",
        "DEPARTMENT",
        "SEX",
        "AGE_GROUP",
        "ESBL",
        "CARBAPENEM",
        "MRSA",
      ];
      if (!ALLOWED_PARAMS.includes(param)) {
        return sendJson(
          res,
          { error: "Invalid parameter for chart aggregation" },
          400,
        );
      }

      withDb((db) => {
        const whereClauses = [];
        const params = [];

        // Apply period / date filters on SPEC_DATE
        if (startDate) {
          whereClauses.push("SPEC_DATE >= ?");
          params.push(startDate);
        }
        if (endDate) {
          whereClauses.push("SPEC_DATE <= ?");
          params.push(endDate);
        }

        // Relative periods based on maximum date available in current database
        if (!startDate && !endDate && period !== "all") {
          const maxDateRow = db
            .prepare(
              "SELECT MAX(SPEC_DATE) as m FROM Isolates WHERE SPEC_DATE IS NOT NULL AND SPEC_DATE != ''",
            )
            .get();
          if (maxDateRow && maxDateRow.m) {
            const maxD = new Date(maxDateRow.m.substring(0, 10));
            if (!isNaN(maxD.getTime())) {
              let monthsBack = 3;
              if (period === "6m") monthsBack = 6;
              if (period === "12m") monthsBack = 12;
              const cutoff = new Date(maxD);
              cutoff.setMonth(cutoff.getMonth() - monthsBack);
              const cutoffStr = cutoff.toISOString().substring(0, 10);
              whereClauses.push("SPEC_DATE >= ?");
              params.push(cutoffStr);
            }
          }
        }

        let selectExpr = param;
        if (param === "AGE_GROUP") {
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
          ? `WHERE ${selectExpr} IS NOT NULL AND ${selectExpr} != '' AND ` +
            whereClauses.join(" AND ")
          : `WHERE ${selectExpr} IS NOT NULL AND ${selectExpr} != ''`;

        const querySql = `
          SELECT ${selectExpr} as label, COUNT(*) as count
          FROM Isolates
          ${whereSql}
          GROUP BY label
          ORDER BY count DESC
          LIMIT 15
        `;

        const rows = db.prepare(querySql).all(...params);
        const totalFiltered = db
          .prepare(
            `SELECT COUNT(*) as c FROM Isolates ${whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : ""}`,
          )
          .get(...params).c;

        sendJson(res, {
          param,
          period,
          totalFiltered,
          rows,
        });
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (path.startsWith("/api/isolate/") && req.method === "GET") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    try {
      const rowIdx = parseInt(path.split("/").pop());
      withDb((db) => {
        const row = db
          .prepare("SELECT * FROM Isolates WHERE ROW_IDX = ?")
          .get(rowIdx);
        if (!row) return sendJson(res, { error: "Not found" }, 404);
        sendJson(res, { row });
      });
    } catch (e) {
      sendJson(res, { error: e.message }, 500);
    }
    return;
  }

  if (path === "/api/bulk-fix" && req.method === "POST") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const { operation } = JSON.parse(body);
        let sql = "";
        let description = "";

        if (operation === "upper_spec_num") {
          sql =
            "UPDATE Isolates SET SPEC_NUM = UPPER(SPEC_NUM) WHERE SPEC_NUM != UPPER(SPEC_NUM)";
          description = "SPEC_NUM → UPPERCASE";
        } else if (operation === "trim_all") {
          sql = `UPDATE Isolates SET SPEC_NUM = TRIM(SPEC_NUM), PATIENT_ID = TRIM(PATIENT_ID), FULL_NAME = TRIM(FULL_NAME), WARD = TRIM(WARD), DEPARTMENT = TRIM(DEPARTMENT)`;
          description = "Trim whitespace from text fields";
        } else if (operation === "upper_patient_id") {
          sql =
            "UPDATE Isolates SET PATIENT_ID = UPPER(PATIENT_ID) WHERE PATIENT_ID != UPPER(PATIENT_ID)";
          description = "PATIENT_ID → UPPERCASE";
        } else if (operation === "upper_organism") {
          sql =
            "UPDATE Isolates SET ORGANISM = LOWER(ORGANISM) WHERE ORGANISM != LOWER(ORGANISM)";
          description = "ORGANISM → lowercase";
        } else {
          return sendJson(res, { error: "Unknown operation" }, 400);
        }

        withDb((db) => {
          const result = db.prepare(sql).run();
          sendJson(res, { ok: true, description, changes: result.changes });
        });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  if (path === "/api/custom-sql" && req.method === "POST") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const { sql } = JSON.parse(body);
        if (!sql || sql.trim().length === 0)
          return sendJson(res, { error: "Empty SQL" }, 400);
        const trimmed = sql.trim().toUpperCase();

        withDb((db) => {
          const stmt = db.prepare(sql);
          if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH")) {
            const rows = stmt.all();
            const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
            sendJson(res, {
              type: "select",
              rows,
              columns,
              count: rows.length,
            });
          } else {
            const result = stmt.run();
            sendJson(res, { type: "update", changes: result.changes });
          }
        });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  if (path === "/api/delete-duplicates" && req.method === "POST") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const { spec_num, patient_id, mode } = JSON.parse(body);
        let sql;
        if (mode === "patient" || patient_id) {
          const ptId = patient_id;
          if (ptId) {
            const safe = ptId.replace(/'/g, "''");
            sql = `DELETE FROM Isolates WHERE ROW_IDX NOT IN (
              SELECT MIN(ROW_IDX) FROM Isolates WHERE UPPER(PATIENT_ID) = UPPER('${safe}')
            ) AND UPPER(PATIENT_ID) = UPPER('${safe}')`;
          } else {
            sql = `DELETE FROM Isolates WHERE PATIENT_ID IS NOT NULL AND PATIENT_ID != '' AND ROW_IDX NOT IN (
              SELECT MIN(ROW_IDX) FROM Isolates WHERE PATIENT_ID IS NOT NULL AND PATIENT_ID != '' GROUP BY UPPER(PATIENT_ID)
            )`;
          }
        } else {
          if (spec_num) {
            const safe = spec_num.replace(/'/g, "''");
            sql = `DELETE FROM Isolates WHERE ROW_IDX NOT IN (
              SELECT MIN(ROW_IDX) FROM Isolates WHERE UPPER(SPEC_NUM) = UPPER('${safe}')
            ) AND UPPER(SPEC_NUM) = UPPER('${safe}')`;
          } else {
            sql = `DELETE FROM Isolates WHERE SPEC_NUM IS NOT NULL AND SPEC_NUM != '' AND ROW_IDX NOT IN (
              SELECT MIN(ROW_IDX) FROM Isolates WHERE SPEC_NUM IS NOT NULL AND SPEC_NUM != '' GROUP BY UPPER(SPEC_NUM)
            )`;
          }
        }
        withDb((db) => {
          const result = db.prepare(sql).run();
          sendJson(res, { ok: true, changes: result.changes });
        });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // API: keep specific row, delete all other duplicates for that SPEC_NUM or PATIENT_ID
  if (path === "/api/keep-row" && req.method === "POST") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const { row_idx, spec_num, patient_id, mode } = JSON.parse(body);
        let sql;
        if (mode === "patient" || patient_id) {
          const safe = (patient_id || "").replace(/'/g, "''");
          sql = `DELETE FROM Isolates WHERE UPPER(PATIENT_ID) = UPPER('${safe}') AND ROW_IDX != ${parseInt(row_idx)}`;
        } else {
          const safe = (spec_num || "").replace(/'/g, "''");
          sql = `DELETE FROM Isolates WHERE UPPER(SPEC_NUM) = UPPER('${safe}') AND ROW_IDX != ${parseInt(row_idx)}`;
        }
        withDb((db) => {
          const result = db.prepare(sql).run();
          sendJson(res, { ok: true, changes: result.changes });
        });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // API: delete single row
  if (path === "/api/delete-row" && req.method === "POST") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const { row_idx } = JSON.parse(body);
        withDb((db) => {
          const result = db
            .prepare("DELETE FROM Isolates WHERE ROW_IDX = ?")
            .run(row_idx);
          sendJson(res, { ok: true, changes: result.changes });
        });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // API: delete multiple rows (batch)
  if (path === "/api/delete-rows" && req.method === "POST") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const { row_indices } = JSON.parse(body);
        if (!Array.isArray(row_indices) || !row_indices.length) {
          return sendJson(res, { ok: true, changes: 0 });
        }
        withDb((db) => {
          const placeholders = row_indices.map(() => "?").join(",");
          const stmt = db.prepare(
            `DELETE FROM Isolates WHERE ROW_IDX IN (${placeholders})`,
          );
          const result = stmt.run(...row_indices);
          sendJson(res, { ok: true, changes: result.changes });
        });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  if (path === "/api/update-field" && req.method === "POST") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const { row_idx, field, value } = JSON.parse(body);
        const EDITABLE_FIELDS = [
          "SPEC_NUM",
          "PATIENT_ID",
          "SPEC_DATE",
          "SPEC_TYPE",
          "ORGANISM",
          "FULL_NAME",
          "SEX",
          "AGE",
          "WARD",
          "DEPARTMENT",
          "INSTITUT",
          "DATE_ADMIS",
          "DATE_DATA",
          "COMMENT",
          "ESBL",
          "CARBAPENEM",
          "MRSA",
          "URINECOUNT",
          "SEROTYPE",
          "BETA_LACT",
          "INDUC_CLI",
        ];
        if (!EDITABLE_FIELDS.includes(field))
          return sendJson(res, { error: "Field not editable" }, 400);
        withDb((db) => {
          const result = db
            .prepare(`UPDATE Isolates SET ${field} = ? WHERE ROW_IDX = ?`)
            .run(value, row_idx);
          sendJson(res, { ok: true, changes: result.changes });
        });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  // API: batch update multiple fields for an isolate row
  if (path === "/api/update-row" && req.method === "POST") {
    if (!currentDbFullPath)
      return sendJson(res, { error: "No database open" }, 400);
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const { row_idx, fields } = JSON.parse(body);
        if (!row_idx || !fields)
          return sendJson(res, { error: "Missing row_idx or fields" }, 400);
        const EDITABLE_FIELDS = [
          "SPEC_NUM",
          "PATIENT_ID",
          "SPEC_DATE",
          "SPEC_TYPE",
          "ORGANISM",
          "FULL_NAME",
          "SEX",
          "AGE",
          "WARD",
          "DEPARTMENT",
          "INSTITUT",
          "DATE_ADMIS",
          "DATE_DATA",
          "COMMENT",
          "ESBL",
          "CARBAPENEM",
          "MRSA",
          "URINECOUNT",
          "SEROTYPE",
          "BETA_LACT",
          "INDUC_CLI",
        ];
        const updates = [];
        const params = [];
        for (const [key, val] of Object.entries(fields)) {
          if (EDITABLE_FIELDS.includes(key)) {
            updates.push(`${key} = ?`);
            params.push(val);
          }
        }
        if (!updates.length) {
          return sendJson(res, { ok: true, changes: 0 });
        }
        params.push(row_idx);
        withDb((db) => {
          const stmt = db.prepare(
            `UPDATE Isolates SET ${updates.join(", ")} WHERE ROW_IDX = ?`,
          );
          const result = stmt.run(...params);
          sendJson(res, { ok: true, changes: result.changes });
        });
      } catch (e) {
        sendJson(res, { error: e.message }, 500);
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

function openBrowser(url) {
  if (process.env.WHONET_NO_BROWSER === "1") return;
  try {
    if (process.platform === "win32") {
      exec(`cmd.exe /c start "" "${url}"`, (err) => {
        if (err) {
          exec(`powershell.exe -Command "Start-Process '${url}'"`, () => {});
        }
      });
    } else if (process.platform === "darwin") {
      exec(`open "${url}"`, () => {});
    } else {
      exec(`xdg-open "${url}"`, () => {});
    }
  } catch (e) {
    console.error("Auto-open failed:", e.message);
  }
}

const PORT = 7890;
const server = createServer(handleRequest);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(
      `\n\u{1F9EC} WHONET Data Tool is already running on port ${PORT}!`,
    );
    console.log(`   Opening: http://localhost:${PORT}\n`);
    openBrowser(`http://localhost:${PORT}`);
    process.exit(0);
  } else {
    console.error("Server error:", err);
    process.exit(1);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("\n\u{1F9EC} WHONET Data Tool");
  console.log(`   Open: http://localhost:${PORT}`);
  console.log("   Press Ctrl+C to stop\n");
  try {
    setTargetDb(DB_FILES[2]);
    console.log(`   Auto-selected: ${DB_FILES[2]} (on-demand connection mode)`);
  } catch (e) {
    console.error("Could not auto-select DB:", e.message);
  }
  openBrowser(`http://localhost:${PORT}`);
});
