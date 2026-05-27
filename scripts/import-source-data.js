import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  categoryDirs,
  clusters,
  instructionEvents,
  normalizeMetricName,
  topdownLevel1,
  topdownNodes,
} from "./data-common.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultSourceRoot = path.join(root, "source_data");
const defaultDataDir = path.join(root, "data");
const defaultDbPath = path.join(defaultDataDir, "cpu_scenario_library.sqlite");
const args = parseArgs(process.argv.slice(2));
const sourceRoot = args.sourceRoot;
const dbPath = args.dbPath;
const dataDir = path.dirname(dbPath);
const resetMode = args.reset;
const strictMode = args.strict;
const debugMode = args.debug;

const metricNameMap = new Map([...topdownLevel1, ...topdownNodes].map((name) => [normalizeMetricName(name), name]));
const topdownAliases = {
  FE: "FE BOUND",
  FRONTEND: "FE BOUND",
  FRONTENDBOUND: "FE BOUND",
  FETCHBOUND: "FE BOUND",
  FETCHSTALL: "FE BOUND",
  STALLFRONTEND: "FE BOUND",
  BE: "BE BOUND",
  BACKEND: "BE BOUND",
  BACKENDBOUND: "BE BOUND",
  EXECUTIONBOUND: "BE BOUND",
  STALLBACKEND: "BE BOUND",
  BADINSTSPECULATION: "BAD_INST_SPEC",
  BADINSTRUCTIONSPEC: "BAD_INST_SPEC",
  INSTSPEC: "BAD_INST_SPEC",
  INSTRUCTIONSPEC: "BAD_INST_SPEC",
  BRIMMISPRETIRED: "BR_IMMED_MIS_PRED_RETIRED",
  BRIMMEDMISPRETIRED: "BR_IMMED_MIS_PRED_RETIRED",
  BRCONDMISPREDRETIRED: "BR_COND_MID_PRED_RETIRED",
  BRCONDMIDPREDRETIRED: "BR_COND_MID_PRED_RETIRED",
  BRINDMISPREDRETIRED: "BR_IND_MIS_PRED_RETIRED",
  BRINDIRECTMISPREDRETIRED: "BR_IND_MIS_PRED_RETIRED",
  BRINDNRMISPREDRETIRED: "BR_INDNR_MIS_PRED_RETIRED",
  STALLFRONTENDMEMBOUND: "STALL_FRONTEND_MEMBOUND",
  STALLFEMEMBOUND: "STALL_FRONTEND_MEMBOUND",
  FEMEMBOUND: "STALL_FRONTEND_MEMBOUND",
  STALLFRONTENDMEM: "STALL_FRONTEND_MEM",
  STALLFEMEM: "STALL_FRONTEND_MEM",
  STALLFRONTENDL1I: "STALL_FRONTEND_L1I",
  STALLFEL1I: "STALL_FRONTEND_L1I",
  STALLFRONTENDTLB: "STALL_FRONTEND_TLB",
  STALLFETLB: "STALL_FRONTEND_TLB",
  STALLFRONTENDCPUBOUND: "STALL_FRONTEND_CPUBOUND_PKI",
  FRONTENDCPUBOUND: "STALL_FRONTEND_CPUBOUND_PKI",
  STALLFECPUBOUND: "STALL_FRONTEND_CPUBOUND_PKI",
  FECPUBOUND: "STALL_FRONTEND_CPUBOUND_PKI",
  STALLFEFLOW: "STALL_FRONTEND_FLOW",
  STALLFEFLUSH: "STALL_FRONTEND_FLUSH",
  STALLFERENAME: "STALL_FRONTEND_RENAME",
  STALLBACKENDMEMBOUND: "STALL_BACKEND_MEMBOUND",
  STALLBEMEMBOUND: "STALL_BACKEND_MEMBOUND",
  BEMEMBOUND: "STALL_BACKEND_MEMBOUND",
  STALLBACKENDMEM: "STALL_BACKEND_MEM",
  STALLBEMEM: "STALL_BACKEND_MEM",
  STALLBACKENDL1D: "STALL_BACKEND_L1D",
  STALLBEL1D: "STALL_BACKEND_L1D",
  STALLBACKENDTLB: "STALL_BACKEND_TLB",
  STALLBETLB: "STALL_BACKEND_TLB",
  STALLBACKENDST: "STALL_BACKEND_ST",
  STALLBEST: "STALL_BACKEND_ST",
  STALLBACKENDBUSY: "STALL_BACKEND_BUSY",
  STALLBEBUSY: "STALL_BACKEND_BUSY",
  STALLBACKENDILOCK: "STALL_BACKEND_ILOCK",
  STALLBEILOCK: "STALL_BACKEND_ILOCK",
  L1DCACHEREFILL: "L1D_CACHE_REFILL",
  L1ICACHEREFILL: "L1I_CACHE_REFILL",
  L2DCACHEREFILL: "L2D_CACHE_REFILL",
  L2ICACHEREFILL: "L2I_CACHE_REFILL",
  L3DCACHEREFILL: "L3D_CACHE_REFILL",
};
for (const [alias, canonical] of Object.entries(topdownAliases)) {
  metricNameMap.set(normalizeMetricName(alias), canonical);
}
const instructionNameMap = new Map(instructionEvents.map((name) => [normalizeMetricName(name), name]));
const threadOrder = ["main", "main", "render", "render", "other", "other"];
const scopeOrder = ["total", "kernel", "total", "kernel", "total", "kernel"];

function usage() {
  console.log(`Usage:
  node scripts/import-source-data.js [--source <source_data>] [--db <path>] [--reset|--full] [--strict]
  node scripts/import-source-data.js --debug

Examples:
  node scripts/import-source-data.js
  node scripts/import-source-data.js --source D:\\cpu-scenario-library\\source_data
  node scripts/import-source-data.js --db D:\\cpu-scenario-library\\data\\cpu_scenario_library.sqlite
  node scripts/import-source-data.js --reset --strict`);
}

function parseArgs(argv) {
  const parsed = {
    sourceRoot: defaultSourceRoot,
    dbPath: defaultDbPath,
    reset: false,
    strict: false,
    debug: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") parsed.help = true;
    else if (item === "--reset" || item === "--full") parsed.reset = true;
    else if (item === "--strict") parsed.strict = true;
    else if (item === "--debug") parsed.debug = true;
    else if (item === "--source") parsed.sourceRoot = path.resolve(argv[++i] || "");
    else if (item === "--db") parsed.dbPath = path.resolve(argv[++i] || "");
    else throw new Error(`Unknown argument: ${item}`);
  }
  return parsed;
}

function unzipText(xlsxPath, entry, optional = false) {
  try {
    return execFileSync("unzip", ["-p", xlsxPath, entry], { encoding: "utf8", stdio: ["ignore", "pipe", optional ? "ignore" : "pipe"] });
  } catch (error) {
    if (optional) return "";
    throw error;
  }
}

function zipList(xlsxPath) {
  return execFileSync("unzip", ["-Z1", xlsxPath], { encoding: "utf8" }).split(/\r?\n/u).filter(Boolean);
}

function decodeXml(value) {
  return String(value || "")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function columnIndex(ref) {
  const letters = ref.match(/[A-Z]+/u)?.[0] || "A";
  return [...letters].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function rowNumber(ref) {
  return Number(ref.match(/\d+/u)?.[0] || 1) - 1;
}

function parseSharedStrings(xlsxPath) {
  const xml = unzipText(xlsxPath, "xl/sharedStrings.xml", true);
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gu)].map((match) =>
    [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/gu)].map((part) => decodeXml(part[1])).join(""),
  );
}

function parseStyles(xlsxPath) {
  const xml = unzipText(xlsxPath, "xl/styles.xml", true);
  if (!xml) return { percentStyleIds: new Set() };
  const customPercentFormats = new Set(
    [...xml.matchAll(/<numFmt\b([^>]*)\/?>/gu)]
      .filter((match) => decodeXml(match[1]).includes("%"))
      .map((match) => Number(match[1].match(/\bnumFmtId="(\d+)"/u)?.[1]))
      .filter(Number.isFinite),
  );
  const builtInPercentFormats = new Set([9, 10]);
  const percentStyleIds = new Set();
  const cellXfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/u)?.[1] || "";
  let styleIndex = 0;
  for (const match of cellXfs.matchAll(/<xf\b([^>]*)\/?>/gu)) {
    const numFmtId = Number(match[1].match(/\bnumFmtId="(\d+)"/u)?.[1] || 0);
    if (builtInPercentFormats.has(numFmtId) || customPercentFormats.has(numFmtId)) percentStyleIds.add(styleIndex);
    styleIndex += 1;
  }
  return { percentStyleIds };
}

function parseSheet(xml, sharedStrings = [], styles = { percentStyleIds: new Set() }) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/gu)) {
    const rowIndex = Number(rowMatch[1]) - 1;
    const row = rows[rowIndex] || [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const ref = attrs.match(/\br="([^"]+)"/u)?.[1] || `A${rowIndex + 1}`;
      const index = columnIndex(ref);
      const shared = /\bt="s"/u.test(attrs);
      const inline = body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/u);
      const textMatch = inline
        ? [...inline[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/gu)].map((item) => decodeXml(item[1])).join("")
        : body.match(/<t[^>]*>([\s\S]*?)<\/t>/u)?.[1];
      const valueMatch = body.match(/<v>([\s\S]*?)<\/v>/u);
      let raw = textMatch != null ? decodeXml(textMatch) : valueMatch ? decodeXml(valueMatch[1]) : "";
      if (shared && raw !== "") raw = sharedStrings[Number(raw)] ?? raw;
      const styleId = Number(attrs.match(/\bs="(\d+)"/u)?.[1] || 0);
      if (!shared && textMatch == null && raw !== "" && styles.percentStyleIds.has(styleId)) {
        const numeric = Number(raw);
        if (Number.isFinite(numeric)) raw = String(numeric * 100);
      }
      row[index] = coerceCell(raw);
    }
    rows[rowIndex] = row;
  }
  applyMergedCells(rows, xml);
  return normalizeRows(rows);
}

function applyMergedCells(rows, xml) {
  for (const match of xml.matchAll(/<mergeCell\b[^>]*\bref="([A-Z]+\d+):([A-Z]+\d+)"[^>]*\/?>/gu)) {
    const start = match[1];
    const end = match[2];
    const startRow = rowNumber(start);
    const endRow = rowNumber(end);
    const startCol = columnIndex(start);
    const endCol = columnIndex(end);
    const value = rows[startRow]?.[startCol];
    if (value === undefined || value === "") continue;
    for (let r = startRow; r <= endRow; r += 1) {
      if (!rows[r]) rows[r] = [];
      for (let c = startCol; c <= endCol; c += 1) {
        if (rows[r][c] === undefined || rows[r][c] === "") rows[r][c] = value;
      }
    }
  }
}

function coerceCell(raw) {
  const text = String(raw ?? "").trim();
  if (text !== "" && /^-?\d+(?:\.\d+)?$/u.test(text)) return Number(text);
  return text;
}

function trimRows(rows) {
  let last = rows.length - 1;
  while (last >= 0 && isBlankRow(rows[last])) last -= 1;
  return rows.slice(0, last + 1);
}

function normalizeRows(rows) {
  const normalized = Array.from({ length: rows.length }, (_, index) => normalizeRow(rows[index]));
  return trimRows(normalized);
}

function normalizeRow(row) {
  return Array.isArray(row) ? row.map((item) => item ?? "") : [];
}

function safeRows(rows) {
  return Array.isArray(rows) ? rows.map(normalizeRow) : [];
}

function isBlankRow(row = []) {
  return row.every((cell) => String(cell ?? "").trim() === "");
}

function readWorkbook(xlsxPath) {
  const sharedStrings = parseSharedStrings(xlsxPath);
  const styles = parseStyles(xlsxPath);
  const entries = zipList(xlsxPath).filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(entry));
  const sheets = entries.map((entry, index) => ({
    name: `sheet${index + 1}`,
    entry,
    rows: parseSheet(unzipText(xlsxPath, entry), sharedStrings, styles),
  }));
  return {
    sheets,
    byRole: {
      base: sheets[0]?.rows || [],
      load: sheets[1]?.rows || [],
      topdown: sheets[2]?.rows || [],
      instructions: sheets[3]?.rows || [],
      syscalls: sheets[4]?.rows || [],
      hotspots: sheets[5]?.rows || [],
    },
  };
}

function clean(value) {
  return String(value ?? "").trim();
}

function rowText(row) {
  return normalizeRow(row).map(clean).filter(Boolean).join(" ");
}

function includesText(value, pattern) {
  return clean(value).toLowerCase().includes(pattern.toLowerCase());
}

function findValueRight(rows, labels) {
  for (const row of safeRows(rows)) {
    for (let c = 0; c < row.length; c += 1) {
      const cell = clean(row[c]);
      if (!cell) continue;
      if (labels.some((label) => cell.includes(label))) {
        for (let next = c + 1; next < Math.min(row.length, c + 5); next += 1) {
          if (clean(row[next])) return row[next];
        }
      }
    }
  }
  return "";
}

function oneSheetObject(workbook, sourceInfo) {
  const rows = workbook.sheets.flatMap((sheet) => sheet.rows);
  const dirName = path.basename(path.dirname(sourceInfo.xlsxPath));
  const name = clean(findValueRight(rows, ["场景名称"])) || dirName;
  return {
    type: clean(findValueRight(rows, ["场景类型"])) || sourceInfo.type,
    name,
    appVersion: clean(findValueRight(rows, ["游戏/应用版本号", "应用版本号", "版本号"])) || "unknown",
    description: clean(findValueRight(rows, ["场景描述"])) || name,
    config: clean(findValueRight(rows, ["场景配置说明", "配置说明"])) || "",
    platform: clean(findValueRight(rows, ["抓取平台", "平台"])) || "",
    imageVersion: clean(findValueRight(rows, ["版本镜像", "镜像"])) || "",
    archivePath: clean(findValueRight(rows, ["归档路径"])) || "",
  };
}

function sixSheetBaseObject(rows, fallbackType, xlsxPath) {
  const map = new Map(safeRows(rows).slice(1).map((row) => [row[0], row[1]]));
  const dirName = path.basename(path.dirname(xlsxPath));
  return {
    type: fallbackType || map.get("场景类型"),
    name: map.get("场景名称") || dirName,
    appVersion: map.get("游戏/应用版本号") || "unknown",
    description: map.get("场景描述") || dirName,
    config: map.get("场景配置说明") || "",
    platform: map.get("抓取平台") || "",
    imageVersion: map.get("版本镜像") || "",
    archivePath: map.get("归档路径") || "",
  };
}

function baseObject(workbook, sourceInfo) {
  if (workbook.sheets.length >= 6 && workbook.byRole.base[0]?.[0] === "字段") {
    return sixSheetBaseObject(workbook.byRole.base, sourceInfo.type, sourceInfo.xlsxPath);
  }
  return oneSheetObject(workbook, sourceInfo);
}

function scenarioIdFromSource(sourceInfo, base) {
  const sourceDir = path.basename(path.dirname(sourceInfo.xlsxPath));
  const raw = `${sourceInfo.dir}-${base.name || sourceDir}`;
  return raw.toLowerCase().replace(/[^a-z0-9_一-龥-]+/giu, "-").replace(/^-+|-+$/gu, "");
}

function scopeFromSource(value) {
  const text = clean(value).toLowerCase();
  return text === "kernel" || text.includes("kernel") || text.includes("内核") ? "kernel" : "total";
}

function canonicalTopdownName(value) {
  return metricNameMap.get(normalizeMetricName(value)) || clean(value).replace(/_PKI$/iu, "");
}

function canonicalInstructionName(value) {
  return instructionNameMap.get(normalizeMetricName(value)) || clean(value).toLowerCase().replace(/_pki$/iu, "");
}

function numberFrom(value) {
  if (typeof value === "number") return round2(value);
  const match = clean(value).replace(/,/gu, "").match(/-?\d+(?:\.\d+)?/u);
  return match ? round2(Number(match[0])) : 0;
}

function round2(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function boundedNumber(value, min = 0, max = 100) {
  const number = numberFrom(value);
  if (!Number.isFinite(number)) return min;
  return round2(Math.min(max, Math.max(min, number)));
}

function percentFrom(value) {
  return numberFrom(value);
}

function syscallFromText(value, rank) {
  const match = clean(value).match(/^(\d+)\s*[_-]\s*([^(]+?)\s*\(\s*([\d.]+)\s*%\s*\)$/u);
  if (!match) return null;
  return {
    rank,
    number: Number(match[1]),
    name: match[2],
    share: round2(Number(match[3])),
  };
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scenarios (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      app_version TEXT NOT NULL,
      description TEXT NOT NULL,
      config TEXT NOT NULL,
      platform TEXT NOT NULL,
      image_version TEXT NOT NULL,
      archive_path TEXT NOT NULL,
      source_dir TEXT NOT NULL,
      xlsx_path TEXT NOT NULL,
      hitrace_dir TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      scenario_id TEXT NOT NULL,
      name TEXT NOT NULL,
      thread_type TEXT NOT NULL,
      load_share REAL NOT NULL,
      rank INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS load_cluster (scenario_id TEXT NOT NULL, cluster TEXT NOT NULL, running REAL NOT NULL, idle REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS load_process (scenario_id TEXT NOT NULL, cluster TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, rank INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS load_thread (scenario_id TEXT NOT NULL, cluster TEXT NOT NULL, name TEXT NOT NULL, value REAL NOT NULL, rank INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hizee_clusters (
      scenario_id TEXT NOT NULL,
      cluster TEXT NOT NULL,
      avg_freq_mhz REAL NOT NULL,
      all_process_running REAL NOT NULL,
      ui_process_running REAL NOT NULL,
      render_service_running REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hizee_scene (
      scenario_id TEXT PRIMARY KEY,
      fps REAL NOT NULL,
      ddr_freq_mhz REAL NOT NULL,
      bandwidth REAL NOT NULL,
      latency REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS topdown_metrics (thread_id TEXT NOT NULL, scope TEXT NOT NULL, level INTEGER NOT NULL, metric TEXT NOT NULL, parent TEXT NOT NULL, value REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS instruction_metrics (thread_id TEXT NOT NULL, scope TEXT NOT NULL, event TEXT NOT NULL, value REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS syscall_metrics (thread_id TEXT PRIMARY KEY, density REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS syscall_top (thread_id TEXT NOT NULL, rank INTEGER NOT NULL, number INTEGER NOT NULL, name TEXT NOT NULL, share REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS hotspot_threads (id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL, dimension TEXT NOT NULL, thread_id TEXT NOT NULL, rank INTEGER NOT NULL, score REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS hotspot_sos (id TEXT PRIMARY KEY, hotspot_thread_id TEXT NOT NULL, rank INTEGER NOT NULL, name TEXT NOT NULL, value REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS hotspot_functions (hotspot_so_id TEXT NOT NULL, rank INTEGER NOT NULL, name TEXT NOT NULL, value REAL NOT NULL);
  `);
  migrateSchema(db);
}

function migrateSchema(db) {
  const scenarioColumns = new Set(db.prepare("PRAGMA table_info(scenarios)").all().map((row) => row.name));
  if (!scenarioColumns.has("updated_at")) {
    db.exec("ALTER TABLE scenarios ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
  }
}

function resetSchema(db) {
  db.exec(`
    DROP TABLE IF EXISTS hotspot_functions;
    DROP TABLE IF EXISTS hotspot_sos;
    DROP TABLE IF EXISTS hotspot_threads;
    DROP TABLE IF EXISTS syscall_top;
    DROP TABLE IF EXISTS syscall_metrics;
    DROP TABLE IF EXISTS instruction_metrics;
    DROP TABLE IF EXISTS topdown_metrics;
    DROP TABLE IF EXISTS hizee_scene;
    DROP TABLE IF EXISTS hizee_clusters;
    DROP TABLE IF EXISTS load_thread;
    DROP TABLE IF EXISTS load_process;
    DROP TABLE IF EXISTS load_cluster;
    DROP TABLE IF EXISTS threads;
    DROP TABLE IF EXISTS scenarios;
  `);
  createSchema(db);
}

function deleteScenarioPayload(db, scenarioId) {
  db.prepare("DELETE FROM hotspot_functions WHERE hotspot_so_id IN (SELECT s.id FROM hotspot_sos s JOIN hotspot_threads h ON h.id = s.hotspot_thread_id WHERE h.scenario_id = ?)").run(scenarioId);
  db.prepare("DELETE FROM hotspot_sos WHERE hotspot_thread_id IN (SELECT id FROM hotspot_threads WHERE scenario_id = ?)").run(scenarioId);
  db.prepare("DELETE FROM hotspot_threads WHERE scenario_id = ?").run(scenarioId);
  db.prepare("DELETE FROM syscall_top WHERE thread_id IN (SELECT id FROM threads WHERE scenario_id = ?)").run(scenarioId);
  db.prepare("DELETE FROM syscall_metrics WHERE thread_id IN (SELECT id FROM threads WHERE scenario_id = ?)").run(scenarioId);
  db.prepare("DELETE FROM instruction_metrics WHERE thread_id IN (SELECT id FROM threads WHERE scenario_id = ?)").run(scenarioId);
  db.prepare("DELETE FROM topdown_metrics WHERE thread_id IN (SELECT id FROM threads WHERE scenario_id = ?)").run(scenarioId);
  for (const table of ["hizee_scene", "hizee_clusters", "load_thread", "load_process", "load_cluster", "threads"]) {
    db.prepare(`DELETE FROM ${table} WHERE scenario_id = ?`).run(scenarioId);
  }
}

function prepareStatements(db) {
  return {
    scenario: db.prepare(`INSERT INTO scenarios (
      id, type, name, app_version, description, config, platform, image_version, archive_path, source_dir, xlsx_path, hitrace_dir, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      name = excluded.name,
      app_version = excluded.app_version,
      description = excluded.description,
      config = excluded.config,
      platform = excluded.platform,
      image_version = excluded.image_version,
      archive_path = excluded.archive_path,
      source_dir = excluded.source_dir,
      xlsx_path = excluded.xlsx_path,
      hitrace_dir = excluded.hitrace_dir,
      updated_at = CURRENT_TIMESTAMP`),
    thread: db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)"),
    loadCluster: db.prepare("INSERT INTO load_cluster VALUES (?, ?, ?, ?)"),
    loadProcess: db.prepare("INSERT INTO load_process VALUES (?, ?, ?, ?, ?)"),
    loadThread: db.prepare("INSERT INTO load_thread VALUES (?, ?, ?, ?, ?)"),
    hizeeCluster: db.prepare("INSERT INTO hizee_clusters VALUES (?, ?, ?, ?, ?, ?)"),
    hizeeScene: db.prepare("INSERT INTO hizee_scene VALUES (?, ?, ?, ?, ?)"),
    topdown: db.prepare("INSERT INTO topdown_metrics VALUES (?, ?, ?, ?, ?, ?)"),
    instruction: db.prepare("INSERT INTO instruction_metrics VALUES (?, ?, ?, ?)"),
    syscallMetric: db.prepare("INSERT INTO syscall_metrics VALUES (?, ?)"),
    syscallTop: db.prepare("INSERT INTO syscall_top VALUES (?, ?, ?, ?, ?)"),
    hotspotThread: db.prepare("INSERT INTO hotspot_threads VALUES (?, ?, ?, ?, ?, ?)"),
    hotspotSo: db.prepare("INSERT INTO hotspot_sos VALUES (?, ?, ?, ?, ?)"),
    hotspotFunction: db.prepare("INSERT INTO hotspot_functions VALUES (?, ?, ?, ?)"),
  };
}

function threadId(scenarioId, threadType) {
  return `${scenarioId}-${threadType}`;
}

function inferThreadType(threadName, rank) {
  const value = clean(threadName).toLowerCase();
  if (value.includes("render") || value.includes("gfx") || value.includes("preview")) return "render";
  if (rank === 0 || value.includes("main") || value.includes("activity") || value.includes("agent") || value.includes("camera")) return "main";
  return "other";
}

function ensureThread(threadMap, scenarioId, threadName, threadType, loadShare = 0) {
  const name = clean(threadName).replace(/线程$/u, "");
  const type = clean(threadType) || inferThreadType(name, threadMap.size);
  const id = threadId(scenarioId, type);
  const existingById = [...threadMap.values()].find((thread) => thread.id === id);
  if (existingById && !threadMap.has(name)) {
    if (loadShare && !existingById.loadShare) existingById.loadShare = round2(loadShare);
    threadMap.set(name, existingById);
    return existingById;
  }
  if (!threadMap.has(name)) {
    threadMap.set(name, { id, name, type, loadShare: round2(loadShare), rank: threadMap.size + 1 });
  } else if (loadShare && !threadMap.get(name).loadShare) {
    threadMap.get(name).loadShare = round2(loadShare);
  }
  return threadMap.get(name);
}

async function importScenario(db, statements, sourceInfo, warnings) {
  const workbook = readWorkbook(sourceInfo.xlsxPath);
  if (debugMode) {
    console.warn(`[debug] reading ${sourceInfo.xlsxPath}`);
    console.warn(`[debug] sheets: ${workbook.sheets.map((sheet) => `${sheet.name}:${sheet.rows.length} rows`).join(", ") || "none"}`);
  }
  const base = baseObject(workbook, sourceInfo);
  const scenarioId = scenarioIdFromSource(sourceInfo, base);
  if (debugMode) console.warn(`[debug] scenario ${scenarioId}: ${JSON.stringify(base)}`);
  const hitraceDir = path.join(path.dirname(sourceInfo.xlsxPath), "hitrace");
  try {
    const stat = await fs.stat(hitraceDir);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch {
    warnings.push(`Missing hitrace directory for ${scenarioId}: ${hitraceDir}`);
  }

  deleteScenarioPayload(db, scenarioId);
  statements.scenario.run(
    scenarioId,
    base.type,
    base.name,
    base.appVersion,
    base.description,
    base.config,
    base.platform,
    base.imageVersion,
    base.archivePath,
    sourceInfo.dir,
    sourceInfo.xlsxPath,
    hitraceDir,
  );

  const parsed = workbook.sheets.length >= 6 && workbook.byRole.base[0]?.[0] === "字段"
    ? parseSixSheet(workbook, scenarioId, warnings)
    : parseOneSheet(workbook.sheets[0]?.rows || [], scenarioId, base, warnings);

  for (const thread of uniqueThreads(parsed.threads)) {
    statements.thread.run(thread.id, scenarioId, thread.name, thread.type, thread.loadShare, thread.rank);
  }
  await importTraceSummary(statements, scenarioId, hitraceDir, warnings);
  importHizeeRows(statements, scenarioId, parsed.hizee);
  for (const row of parsed.topdown) statements.topdown.run(row.threadId, row.scope, row.level, row.metric, row.parent, row.value);
  for (const row of parsed.instructions) statements.instruction.run(row.threadId, row.scope, row.event, row.value);
  importSyscallRows(statements, parsed.syscalls);
  importHotspotRows(statements, scenarioId, parsed.hotspots, parsed.threads);
  return scenarioId;
}

function emptyParsed() {
  return {
    threads: new Map(),
    hizee: { clusters: [], scene: { fps: 0, ddrFreqMhz: 0, bandwidth: 0, latency: 0 } },
    topdown: [],
    instructions: [],
    syscalls: [],
    hotspots: [],
  };
}

function uniqueThreads(threadMap) {
  return [...new Map([...threadMap.values()].map((thread) => [thread.id, thread])).values()].sort((a, b) => a.rank - b.rank);
}

function warnParse(warnings, scenarioId, section, error) {
  warnings.push(`Skipped ${section} for ${scenarioId}: ${error.message || error}`);
  if (debugMode) {
    console.warn(`[debug] skipped section`, {
      scenarioId,
      section,
      message: error?.message || String(error),
      stack: error?.stack,
    });
  }
}

function safeParse(warnings, scenarioId, section, fn) {
  try {
    fn();
  } catch (error) {
    warnParse(warnings, scenarioId, section, error);
  }
}

function compactError(error) {
  const text = error?.stderr?.toString?.() || error?.message || String(error);
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)[0] || String(error);
}

function parseSixSheet(workbook, scenarioId, warnings) {
  const parsed = emptyParsed();
  const topdownRows = safeRows(workbook.byRole.topdown);
  const hotspotRows = safeRows(workbook.byRole.hotspots);
  for (const row of topdownRows.slice(1).filter((item) => item[0])) {
    ensureThread(parsed.threads, scenarioId, row[0], row[1]);
  }
  for (const row of hotspotRows.slice(1).filter((item) => item[0])) {
    ensureThread(parsed.threads, scenarioId, row[1], "", row[2]);
  }
  safeParse(warnings, scenarioId, "hizee", () => parseSixSheetHizee(safeRows(workbook.byRole.load), parsed));
  safeParse(warnings, scenarioId, "topdown", () => parseSixSheetTopdown(topdownRows, parsed, scenarioId));
  safeParse(warnings, scenarioId, "instructions", () => parseSixSheetInstructions(safeRows(workbook.byRole.instructions), parsed, scenarioId));
  safeParse(warnings, scenarioId, "syscalls", () => parseSixSheetSyscalls(safeRows(workbook.byRole.syscalls), parsed, scenarioId));
  safeParse(warnings, scenarioId, "hotspots", () => parseSixSheetHotspots(hotspotRows, parsed, scenarioId));
  return parsed;
}

function parseSixSheetHizee(rows, parsed) {
  const tableRows = rows.slice(5, 8);
  let sceneInserted = false;
  for (const row of tableRows) {
    const [cluster, allProcess, uiProcess, renderService, avgFreqMhz, fps, ddrFreqMhz, bandwidth, latency] = row;
    if (!cluster) continue;
    parsed.hizee.clusters.push({ cluster, avgFreqMhz, allProcess, uiProcess, renderService });
    if (!sceneInserted) {
      parsed.hizee.scene = { fps, ddrFreqMhz, bandwidth, latency };
      sceneInserted = true;
    }
  }
}

function parseSixSheetTopdown(rows, parsed, scenarioId) {
  for (const row of rows.slice(1)) {
    const [threadName, threadType, sourceScope, level, rawMetric, parent, value] = row;
    if (!threadName || value === "") continue;
    const thread = ensureThread(parsed.threads, scenarioId, threadName, threadType);
    parsed.topdown.push({
      threadId: thread.id,
      scope: scopeFromSource(sourceScope),
      level: numberFrom(level) || 1,
      metric: canonicalTopdownName(rawMetric),
      parent: parent ? canonicalTopdownName(parent) : "",
      value: numberFrom(value),
    });
  }
}

function parseSixSheetInstructions(rows, parsed, scenarioId) {
  const header = rows[0] || [];
  const scopeRow = rows[1] || [];
  for (const row of rows.slice(2)) {
    const [threadName, threadType] = row;
    if (!threadName) continue;
    const thread = ensureThread(parsed.threads, scenarioId, threadName, threadType);
    for (let c = 2; c < header.length; c += 1) {
      if (!header[c] || row[c] === "") continue;
      parsed.instructions.push({ threadId: thread.id, scope: scopeFromSource(scopeRow[c]), event: canonicalInstructionName(header[c]), value: numberFrom(row[c]) });
    }
  }
}

function parseSixSheetSyscalls(rows, parsed, scenarioId) {
  for (const row of rows.slice(1)) {
    const [threadName, threadType, density, ...calls] = row;
    if (!threadName) continue;
    const thread = ensureThread(parsed.threads, scenarioId, threadName, threadType);
    parsed.syscalls.push({ threadId: thread.id, density: numberFrom(density), calls: parseSyscallCalls(calls) });
  }
}

function parseSixSheetHotspots(rows, parsed, scenarioId) {
  for (const row of rows.slice(1)) {
    const [dimensionRaw, threadName, threadScore, soName, soValue, functionName, functionValue] = row;
    if (!dimensionRaw || !threadName || !soName || !functionName) continue;
    const thread = ensureThread(parsed.threads, scenarioId, threadName, "", threadScore);
    parsed.hotspots.push({
      dimension: clean(dimensionRaw).toLowerCase(),
      threadId: thread.id,
      threadScore: numberFrom(threadScore),
      soName,
      soValue: numberFrom(soValue),
      functionName,
      functionValue: numberFrom(functionValue),
    });
  }
}

function parseOneSheet(rows, scenarioId, base, warnings) {
  const parsed = emptyParsed();
  const normalizedRows = safeRows(rows);
  const sections = locateSections(normalizedRows);
  if (debugMode) console.warn(`[debug] ${scenarioId} one-sheet sections: ${JSON.stringify(sections)}, rows=${normalizedRows.length}`);
  safeParse(warnings, scenarioId, "hizee", () => parseOneSheetHizee(normalizedRows, sections, parsed));
  safeParse(warnings, scenarioId, "topdown", () => parseOneSheetTopdown(normalizedRows, sections, parsed, scenarioId, warnings));
  safeParse(warnings, scenarioId, "instructions", () => parseOneSheetInstructions(normalizedRows, sections, parsed, scenarioId));
  safeParse(warnings, scenarioId, "syscalls", () => parseOneSheetSyscalls(normalizedRows, sections, parsed, scenarioId));
  safeParse(warnings, scenarioId, "hotspots", () => parseOneSheetHotspots(normalizedRows, sections, parsed, scenarioId));
  if (!parsed.threads.size) {
    ["main", "render", "other"].forEach((type, index) => ensureThread(parsed.threads, scenarioId, `${base.name}_${type}`, type, index === 0 ? 30 : 20));
  }
  return parsed;
}

function locateSections(rows) {
  const markers = {};
  safeRows(rows).forEach((row, index) => {
    const text = rowText(row).toUpperCase();
    if (text.includes("TOPDOWN") && markers.topdown == null) markers.topdown = index;
    if (text.includes("指令分布") && markers.instructions == null) markers.instructions = index;
    if (text.includes("系统调用") && markers.syscalls == null) markers.syscalls = index;
    if ((text.includes("热点SO") || text.includes("HOT") || text.includes("BOUND SO") || text.includes("LIBRARY:")) && markers.hotspots == null) markers.hotspots = index;
    if ((text.includes("负载信息") || text.includes("CLUSTER LOAD OVERVIEW")) && markers.load == null) markers.load = index;
  });
  return markers;
}

function parseOneSheetHizee(rows, sections, parsed) {
  const safe = safeRows(rows);
  const headerIndex = safe.findIndex((row) => {
    const text = rowText(row);
    const hits = [/负载|running/iu, /平均帧率|fps/iu, /平均频率/iu, /DDR/iu, /平均带宽|bandwidth/iu, /latency|时延/iu]
      .filter((pattern) => pattern.test(text)).length;
    return hits >= 2;
  });
  const header = safe[headerIndex] || [];
  const loadCol = header.findIndex((cell) => /负载|running/iu.test(clean(cell)));
  const fpsCol = header.findIndex((cell) => /平均帧率|fps/iu.test(clean(cell)));
  const freqCol = header.findIndex((cell) => /平均频率/iu.test(clean(cell)) && !/DDR/iu.test(clean(cell)));
  const ddrCol = header.findIndex((cell) => /DDR/iu.test(clean(cell)));
  const bandwidthCol = header.findIndex((cell) => /平均带宽|bandwidth/iu.test(clean(cell)));
  const latencyCol = header.findIndex((cell) => /latency|时延/iu.test(clean(cell)));
  const searchRows = safe.slice(headerIndex >= 0 ? headerIndex + 1 : sections.load ?? 0, sections.topdown ?? safe.length);
  let currentCluster = "";
  const clusterSeen = new Map();
  for (const row of searchRows) {
    const text = rowText(row);
    const cluster = clusterFromRow(row) || currentCluster;
    if (clusterFromRow(row)) currentCluster = clusterFromRow(row);
    if (!cluster) continue;
    if (!clusterSeen.has(cluster)) clusterSeen.set(cluster, { cluster, avgFreqMhz: 0, allProcess: 0, uiProcess: 0, renderService: 0 });
    const item = clusterSeen.get(cluster);
    if (/所有进程|all\s*process/iu.test(text)) item.allProcess = valueAtOrNear(row, loadCol, "所有进程") || item.allProcess;
    if (/(^|\s|[^\w])UI\s*进程|UI\s*process/iu.test(text)) item.uiProcess = valueAtOrNear(row, loadCol, "UI进程") || item.uiProcess;
    if (/render[\s_-]*service|renderservice/iu.test(text)) item.renderService = valueAtOrNear(row, loadCol, "render service") || item.renderService;
    const nums = row.filter((cell) => typeof cell === "number");
    if (!item.avgFreqMhz) item.avgFreqMhz = freqCol >= 0 ? numberFrom(row[freqCol]) : nums.find((num) => num > 300 && num < 5000) || 0;
    if (!parsed.hizee.scene.fps) parsed.hizee.scene.fps = fpsCol >= 0 ? numberFrom(row[fpsCol]) : 0;
    if (!parsed.hizee.scene.ddrFreqMhz) parsed.hizee.scene.ddrFreqMhz = ddrCol >= 0 ? numberFrom(row[ddrCol]) : 0;
    if (!parsed.hizee.scene.bandwidth) parsed.hizee.scene.bandwidth = bandwidthCol >= 0 ? numberFrom(row[bandwidthCol]) : 0;
    if (!parsed.hizee.scene.latency) parsed.hizee.scene.latency = latencyCol >= 0 ? numberFrom(row[latencyCol]) : 0;
  }
  parsed.hizee.clusters = clusters.map((cluster) => clusterSeen.get(cluster) || { cluster, avgFreqMhz: 0, allProcess: 0, uiProcess: 0, renderService: 0 });
}

function clusterFromRow(row) {
  const text = rowText(row);
  if (/小核|cluster0/iu.test(text)) return "小核";
  if (/中核|cluster1/iu.test(text)) return "中核";
  if (/大核|cluster2/iu.test(text)) return "大核";
  return "";
}

function firstPercentNear(row, label) {
  const cells = normalizeRow(row);
  const index = cells.findIndex((cell) => includesText(cell, label));
  if (index < 0) return 0;
  for (let c = Math.max(0, index); c < Math.min(cells.length, index + 5); c += 1) {
    const value = percentFrom(cells[c]);
    if (value) return value;
  }
  return 0;
}

function valueAtOrNear(row, index, label) {
  const cells = normalizeRow(row);
  if (index >= 0 && numberFrom(cells[index])) return numberFrom(cells[index]);
  return firstPercentNear(row, label);
}

function parseOneSheetTopdown(rows, sections, parsed, scenarioId, warnings) {
  const safe = safeRows(rows);
  const start = sections.topdown ?? safe.findIndex((row) => row.some((cell) => isKnownTopdown(cell)));
  const end = firstSectionAfter(sections, start, ["instructions", "syscalls", "hotspots"]) ?? safe.length;
  if (start < 0) return;
  let block = -1;
  let currentThread = null;
  let columnHeaders = [];
  let columnScopes = [];
  const unresolved = new Set();
  for (const row of safe.slice(Math.max(0, start), end)) {
    const threadHeaders = detectThreadHeaders(row);
    if (threadHeaders.length > 1) {
      columnHeaders = threadHeaders.map((header, index) => {
        const threadType = header.threadType || (threadHeaders.length === 3 ? inferThreadType(header.name, index) : threadOrder[index]) || inferThreadType(header.name, parsed.threads.size);
        const scope = header.scope || scopeOrder[index] || "total";
        const thread = ensureThread(parsed.threads, scenarioId, header.name, threadType);
        return { ...header, thread, scope };
      });
      continue;
    }
    if (columnHeaders.length) {
      const scopeHeaders = detectScopeHeaders(row);
      if (scopeHeaders.length) {
        columnScopes = scopeHeaders;
        continue;
      }
    }
    const threadHeader = threadHeaders[0];
    if (threadHeader && !columnHeaders.length) {
      block += 1;
      const threadType = threadHeader.threadType || threadOrder[block] || inferThreadType(threadHeader.name, parsed.threads.size);
      const scope = threadHeader.scope || scopeOrder[block] || "total";
      currentThread = ensureThread(parsed.threads, scenarioId, threadHeader.name, threadType);
      currentThread.currentScope = scope;
    }
    const pairs = metricPairsDetailed(row, isKnownTopdown);
    for (const candidate of unresolvedMetricCandidates(row, isKnownTopdown)) unresolved.add(candidate);
    if (!pairs.length) continue;
    for (const pair of pairs) {
      const header = columnHeaders.length ? headerForColumn(columnHeaders, pair.column) : null;
      if (!header && !currentThread) {
        block += 1;
        const type = threadOrder[block] || "main";
        currentThread = ensureThread(parsed.threads, scenarioId, `${type}_thread`, type);
        currentThread.currentScope = scopeOrder[block] || "total";
      }
      const targetThread = header?.thread || currentThread;
      const scope = pair.scope || scopeForColumn(columnScopes, pair.column) || header?.scope || currentThread?.currentScope || "total";
      const metric = canonicalTopdownName(pair.name);
      const level = topdownLevel1.includes(metric) ? 1 : 2;
      parsed.topdown.push({ threadId: targetThread.id, scope, level, metric, parent: topdownParent(metric), value: pair.value });
    }
  }
  if (unresolved.size) {
    warnings.push(`Unresolved topdown metric alias for ${scenarioId}: ${[...unresolved].slice(0, 20).join(", ")}${unresolved.size > 20 ? " ..." : ""}`);
  }
}

function parseOneSheetInstructions(rows, sections, parsed, scenarioId) {
  const safe = safeRows(rows);
  const start = sections.instructions ?? safe.findIndex((row) => row.some((cell) => isKnownInstruction(cell)));
  if (start < 0) return;
  const end = firstSectionAfter(sections, start, ["syscalls", "hotspots"]) ?? safe.length;
  let currentThread = null;
  for (const row of safe.slice(start, end)) {
    const threadHeader = detectThreadHeader(row);
    if (threadHeader) currentThread = ensureThread(parsed.threads, scenarioId, threadHeader.name, threadHeader.threadType);
    const pairs = metricPairsDetailed(row, isKnownInstruction);
    if (!pairs.length) continue;
    if (!currentThread) currentThread = ensureThread(parsed.threads, scenarioId, "main_thread", "main");
    const splitAt = Math.ceil(pairs.length / 2);
    pairs.forEach((pair, index) => {
      parsed.instructions.push({
        threadId: currentThread.id,
        scope: pair.scope || (index < splitAt ? "total" : "kernel"),
        event: canonicalInstructionName(pair.name),
        value: pair.value,
      });
    });
  }
}

function parseOneSheetSyscalls(rows, sections, parsed, scenarioId) {
  const safe = safeRows(rows);
  const start = sections.syscalls ?? safe.findIndex((row) => row.some((cell) => includesText(cell, "系统调用密度")));
  if (start < 0) return;
  const end = firstSectionAfter(sections, start, ["hotspots"]) ?? safe.length;
  for (const row of safe.slice(start, end)) {
    const cells = normalizeRow(row).map(clean);
    const callCells = cells.filter((cell) => syscallFromText(cell, 1));
    if (!callCells.length) continue;
    const name = cells.find((cell) => cell && !cell.includes("系统调用") && !cell.includes("TOP") && !syscallFromText(cell, 1)) || `thread_${parsed.threads.size + 1}`;
    const thread = ensureThread(parsed.threads, scenarioId, name, "");
    const density = row.find((cell) => typeof cell === "number" && cell > 0) || 0;
    parsed.syscalls.push({ threadId: thread.id, density: Number(density), calls: parseSyscallCalls(callCells) });
  }
}

function parseOneSheetHotspots(rows, sections, parsed, scenarioId) {
  const safe = safeRows(rows);
  const start = sections.hotspots ?? safe.findIndex((row) => row.some((cell) => includesText(cell, "Library:")));
  if (start < 0) return;
  let dimension = "cycle";
  let currentThread = null;
  let currentSo = null;
  for (const row of safe.slice(start)) {
    const text = rowText(row);
    if (/^\s*FE\s*$/iu.test(text) || /\bFE\b/iu.test(text)) dimension = "fe";
    if (/^\s*BE\s*$/iu.test(text) || /\bBE\b/iu.test(text)) dimension = "be";
    const threadCell = row.find((cell) => /\([^)]*%\)/u.test(clean(cell)) && !includesText(cell, "Library") && !includesText(cell, "Function"));
    if (threadCell) {
      const match = clean(threadCell).match(/^(.+?)\s*\(\s*([\d.]+)\s*%\s*\)$/u);
      if (match) currentThread = ensureThread(parsed.threads, scenarioId, match[1], "", numberFrom(match[2]));
    }
    const libraryCell = row.find((cell) => includesText(cell, "Library"));
    if (libraryCell) currentSo = parseNamedPercent(clean(libraryCell).replace(/^Library:\s*/iu, ""));
    const functionCells = row.filter((cell) => includesText(cell, "Function"));
    for (const functionCell of functionCells) {
      const fn = parseNamedPercent(clean(functionCell).replace(/^Function:\s*/iu, ""));
      if (currentThread && currentSo && fn.name) {
        parsed.hotspots.push({
          dimension,
          threadId: currentThread.id,
          threadScore: currentThread.loadShare,
          soName: currentSo.name,
          soValue: currentSo.value,
          functionName: fn.name,
          functionValue: fn.value,
        });
      }
    }
  }
}

function firstSectionAfter(sections, start, names) {
  return names.map((name) => sections[name]).filter((value) => value != null && value > start).sort((a, b) => a - b)[0];
}

function detectThreadHeader(row) {
  return detectThreadHeaders(row)[0] || null;
}

function detectThreadHeaders(row) {
  const text = rowText(row);
  if (/TOPDOWN|指令分布|系统调用|热点|BOUND SO|Library:|Function:/iu.test(text)) return [];
  const headers = [];
  let lastKey = "";
  normalizeRow(row).map(clean).forEach((cell, column) => {
    if (!/线程|thread|Unity|Render|Main|Worker|Device|Camera|Activity/iu.test(cell)) return;
    if (isKnownTopdown(cell) || isKnownInstruction(cell)) return;
    const scope = /kernel|内核/iu.test(cell) ? "kernel" : /all|总体/iu.test(cell) ? "total" : "";
    const name = cell.replace(/[-_ ]*(all|kernel|总体|内核).*$/iu, "").replace(/线程$/u, "").trim() || cell;
    const key = `${name}:${scope}`;
    if (key === lastKey) return;
    lastKey = key;
    headers.push({ name, threadType: "", scope, column });
  });
  return headers;
}

function headerForColumn(headers, column) {
  return [...headers].reverse().find((header) => header.column <= column) || headers[0] || null;
}

function detectScopeHeaders(row) {
  const headers = [];
  let lastScope = "";
  normalizeRow(row).map(clean).forEach((cell, column) => {
    const scope = /^kernel$/iu.test(cell) || /^内核$/u.test(cell) ? "kernel" : /^(all|总体)$/iu.test(cell) ? "total" : "";
    if (!scope || scope === lastScope) return;
    lastScope = scope;
    headers.push({ scope, column });
  });
  return headers;
}

function scopeForColumn(headers, column) {
  return [...headers].reverse().find((header) => header.column <= column)?.scope || "";
}

function metricPairs(row, predicate) {
  return metricPairsDetailed(row, predicate).map(({ name, value, scope }) => ({ name, value, scope }));
}

function metricPairsDetailed(row, predicate) {
  const pairs = [];
  const cells = normalizeRow(row);
  for (let c = 0; c < cells.length; c += 1) {
    if (!predicate(cells[c])) continue;
    const value = cells.slice(c + 1, Math.min(cells.length, c + 4)).find((cell) => typeof cell === "number" || /^-?\d+(?:\.\d+)?$/u.test(clean(cell)));
    if (value !== undefined) pairs.push({ name: cells[c], value: round2(value), scope: "", column: c });
  }
  return pairs;
}

function unresolvedMetricCandidates(row, predicate) {
  const out = [];
  const cells = normalizeRow(row);
  for (let c = 0; c < cells.length; c += 1) {
    const cell = clean(cells[c]);
    if (!cell || predicate(cell) || !looksLikePmuMetric(cell)) continue;
    const value = cells.slice(c + 1, Math.min(cells.length, c + 4)).find((item) => typeof item === "number" || /^-?\d+(?:\.\d+)?$/u.test(clean(item)));
    if (value !== undefined) out.push(cell);
  }
  return out;
}

function looksLikePmuMetric(value) {
  const text = clean(value);
  if (!/^[A-Z0-9_/\-.\s]+$/u.test(text)) return false;
  return /(PKI|SPEC|STALL|CACHE|TLB|REFILL|MEM|BR_|LD|IPC|MPKI|FE|BE)/iu.test(text);
}

function topdownParent(metric) {
  if (topdownLevel1.includes(metric)) return "";
  if (/^(BAD_|BR_)/u.test(metric)) return "MPKI";
  if (/^STALL_FRONTEND_(L1I|MEM|TLB)$/u.test(metric)) return "STALL_FRONTEND_MEMBOUND";
  if (/^STALL_FRONTEND_(FLOW|FLUSH|RENAME)$/u.test(metric)) return "STALL_FRONTEND_CPUBOUND_PKI";
  if (/^STALL_FRONTEND/u.test(metric)) return "FE BOUND";
  if (/^STALL_BACKEND_(L1D|MEM|TLB|ST)$/u.test(metric)) return "STALL_BACKEND_MEMBOUND";
  if (/^STALL_BACKEND/u.test(metric)) return "BE BOUND";
  if (/^MEMSTALL/u.test(metric)) return "LINX MEMSTALL PKI";
  if (/TLB|PRFM|HWPRF|PAGE_FAULT/u.test(metric)) return "TLB REFILL & PREFETCH PKI";
  if (/CACHE_REFILL/u.test(metric)) return "CACHE REFILL PKI";
  return "";
}

function isKnownTopdown(value) {
  return metricNameMap.has(normalizeMetricName(value));
}

function isKnownInstruction(value) {
  return instructionNameMap.has(normalizeMetricName(value));
}

function parseNamedPercent(value) {
  const match = clean(value).match(/^(.+?)\s*\(\s*([\d.]+)\s*%\s*\)$/u);
  return match ? { name: match[1].trim(), value: numberFrom(match[2]) } : { name: clean(value), value: 0 };
}

function parseSyscallCalls(calls) {
  const parsed = (Array.isArray(calls) ? calls : []).map((value, index) => syscallFromText(value, index + 1)).filter(Boolean);
  const total = parsed.reduce((sum, call) => sum + call.share, 0);
  if (total < 99.995) parsed.push({ rank: parsed.length + 1, number: 0, name: "others", share: round2(100 - total) });
  return parsed;
}

async function importTraceSummary(statements, scenarioId, hitraceDir, warnings) {
  const summaryPath = path.join(hitraceDir, "trace_summary.json");
  let summary;
  try {
    summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  } catch (error) {
    warnings.push(`Missing or invalid trace summary for ${scenarioId}: ${summaryPath} (${error.message})`);
    return;
  }
  safeParse(warnings, scenarioId, "trace cluster overview", () => {
    for (const row of Array.isArray(summary.clusterOverview) ? summary.clusterOverview : []) {
      const cluster = clean(row.cluster) || "unknown";
      const running = boundedNumber(row.running);
      const idle = row.idle === undefined || row.idle === "" ? boundedNumber(100 - running) : boundedNumber(row.idle);
      statements.loadCluster.run(scenarioId, cluster, running, idle);
    }
  });
  safeParse(warnings, scenarioId, "trace process overview", () => {
    for (const row of Array.isArray(summary.processOverview) ? summary.processOverview : []) {
      const cluster = clean(row.cluster) || "unknown";
      const items = Array.isArray(row.items) ? row.items : [];
      items.forEach((item, i) => statements.loadProcess.run(scenarioId, cluster, clean(item.name) || `process_${i + 1}`, boundedNumber(item.value), i + 1));
    }
  });
  safeParse(warnings, scenarioId, "trace thread overview", () => {
    for (const row of Array.isArray(summary.threadOverview) ? summary.threadOverview : []) {
      const cluster = clean(row.cluster) || "unknown";
      const items = Array.isArray(row.items) ? row.items : [];
      items.forEach((item, i) => statements.loadThread.run(scenarioId, cluster, clean(item.name) || `thread_${i + 1}`, boundedNumber(item.value), i + 1));
    }
  });
}

function importHizeeRows(statements, scenarioId, hizee) {
  for (const row of hizee.clusters) {
    if (!row.cluster) continue;
    statements.hizeeCluster.run(
      scenarioId,
      row.cluster,
      round2(numberFrom(row.avgFreqMhz)),
      round2(percentFrom(row.allProcess)),
      round2(percentFrom(row.uiProcess)),
      round2(percentFrom(row.renderService)),
    );
  }
  statements.hizeeScene.run(
    scenarioId,
    round2(numberFrom(hizee.scene.fps)),
    round2(numberFrom(hizee.scene.ddrFreqMhz)),
    round2(numberFrom(hizee.scene.bandwidth)),
    round2(numberFrom(hizee.scene.latency)),
  );
}

function importSyscallRows(statements, syscalls) {
  const byThread = new Map();
  for (const row of syscalls) {
    if (!row.threadId || byThread.has(row.threadId)) continue;
    byThread.set(row.threadId, row);
  }
  for (const row of byThread.values()) {
    statements.syscallMetric.run(row.threadId, round2(row.density));
    for (const call of row.calls) {
      statements.syscallTop.run(row.threadId, call.rank, call.number, call.name, round2(call.share));
    }
  }
}

function importHotspotRows(statements, scenarioId, hotspots, threadMap) {
  const groups = new Map();
  for (const row of hotspots) {
    const thread = [...threadMap.values()].find((item) => item.id === row.threadId);
    if (!thread || !row.soName || !row.functionName) continue;
    const groupKey = `${row.dimension}:${thread.id}`;
    if (!groups.has(groupKey)) groups.set(groupKey, { dimension: row.dimension, thread, score: round2(row.threadScore), sos: new Map() });
    const group = groups.get(groupKey);
    if (!group.sos.has(row.soName)) group.sos.set(row.soName, { name: row.soName, value: round2(row.soValue), functions: [] });
    group.sos.get(row.soName).functions.push({ name: row.functionName, value: round2(row.functionValue) });
  }
  for (const [groupIndex, group] of [...groups.values()].entries()) {
    const htId = `${scenarioId}-${group.dimension}-${group.thread.type}-${groupIndex + 1}`;
    statements.hotspotThread.run(htId, scenarioId, group.dimension, group.thread.id, groupIndex + 1, group.score || group.thread.loadShare || 0);
    [...group.sos.values()].forEach((so, soIndex) => {
      const soId = `${htId}-so-${soIndex + 1}`;
      statements.hotspotSo.run(soId, htId, soIndex + 1, so.name, so.value || 0);
      so.functions.slice(0, 3).forEach((fn, fnIndex) => statements.hotspotFunction.run(soId, fnIndex + 1, fn.name, fn.value || 0));
    });
  }
}

async function discoverSources() {
  const sources = [];
  for (const category of categoryDirs) {
    const categoryPath = path.join(sourceRoot, category.dir);
    let entries = [];
    try {
      entries = await fs.readdir(categoryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const scenarioDir = path.join(categoryPath, entry.name);
      let files = [];
      try {
        files = await fs.readdir(scenarioDir);
      } catch {
        continue;
      }
      const xlsx = files.find((file) => !file.startsWith("~$") && /^CPU测试场景库分析.*\.xlsx$/iu.test(file));
      if (xlsx) sources.push({ type: category.type, dir: category.dir, xlsxPath: path.join(scenarioDir, xlsx) });
    }
  }
  return sources.sort((a, b) => a.xlsxPath.localeCompare(b.xlsxPath));
}

async function main() {
  if (args.help) {
    usage();
    return;
  }
  await fs.mkdir(dataDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  if (resetMode) resetSchema(db);
  else createSchema(db);
  const statements = prepareStatements(db);
  const sources = await discoverSources();
  const warnings = [];
  const failures = [];
  const imported = [];
  try {
    for (const source of sources) {
      db.exec("BEGIN");
      try {
        if (debugMode) console.warn(`[debug] importing ${source.xlsxPath}`);
        const scenarioId = await importScenario(db, statements, source, warnings);
        db.exec("COMMIT");
        imported.push(scenarioId);
        if (debugMode) console.warn(`[debug] imported ${scenarioId}`);
      } catch (error) {
        db.exec("ROLLBACK");
        failures.push({ source: source.xlsxPath, message: compactError(error) });
        if (debugMode) console.warn(`[debug] failed ${source.xlsxPath}\n${error?.stack || error}`);
        if (strictMode) throw error;
      }
    }
  } catch (error) {
    throw error;
  } finally {
    db.close();
  }
  console.log(`${resetMode ? "Reset and imported" : "Incrementally imported"} ${imported.length}/${sources.length} scenarios into ${dbPath}`);
  if (warnings.length) console.warn(warnings.join("\n"));
  if (failures.length) {
    console.warn("Failed scenarios:");
    for (const failure of failures) console.warn(`- ${failure.source}: ${failure.message}`);
    if (strictMode) process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
