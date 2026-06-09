import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";
import Worksheet from "exceljs/lib/doc/worksheet.js";
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

patchExcelJsMergeHandling();

const metricNameMap = new Map([...topdownLevel1, ...topdownNodes].map((name) => [normalizeMetricName(name), name]));
const ignoredTopdownMetrics = new Set(["L2D_TLB_REFILL"].map(normalizeMetricName));
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
const fixedTopdownBlockStarts = [37, 50, 63];
const fixedTopdownThreadTypes = ["main", "render", "other"];
const fixedInstructionDataStarts = [79, 87, 95];
const fixedSyscallRows = [103, 104, 105];
const fixedHotspotBlocks = [
  { dimension: "cycle", headerRow: 107, startRow: 108, endRow: 135 },
  { dimension: "fe", headerRow: 135, startRow: 136, endRow: 163 },
  { dimension: "be", headerRow: 163, startRow: 164, endRow: 191 },
];
const fixedInstructionRows = [
  ["ld/st_retired", "ld/strex_spec"],
  ["br_retired", "atomic/cas_spec"],
  ["dp_spec", "unaligned_ldst_spec"],
  ["vfp_spec", "barrier_spec"],
  ["ase_spec", ""],
  ["sve_inst_spec", ""],
];
const fixedTopdownTotalRows = [
  ["IPC", "FE BOUND", "BE BOUND", "L1D_CACHE_REFILL", "L1D_TLB_REFILL_RD", "MEMSTALL_ANYSTORE"],
  ["MPKI", "STALL_FRONTEND_MEMBOUND", "STALL_BACKEND_MEMBOUND", "L1D_CACHE_REFILL_RD", "L1I_TLB_REFILL", "MEMSTALL_ANYLOAD"],
  ["BAD_INST_SPEC", "STALL_FRONTEND_L1I", "STALL_BACKEND_L1D", "L1I_CACHE_REFILL", "L2D_TLB_REFILL_RD", "MEMSTALL_L1MISS"],
  ["BR_IMMED_MIS_PRED_RETIRED", "STALL_FRONTEND_MEM", "STALL_BACKEND_MEM", "L2D_CACHE_REFILL", "L2I_TLB_REFILL", "MEMSTALL_L2MISS"],
  ["BR_COND_MID_PRED_RETIRED", "STALL_FRONTEND_TLB", "STALL_BACKEND_TLB", "L2D_CACHE_REFILL_RD", "PAGE_FAULTS_PMI", "MEMSTALL_L3MISS"],
  ["BR_IND_MIS_PRED_RETIRED", "STALL_FRONTEND_CPUBOUND_PKI", "STALL_BACKEND_ST", "L2I_CACHE_REFILL", "L2D_CACHE_REFILL_PRFM", ""],
  ["BR_INDNR_MIS_PRED_RETIRED", "STALL_FRONTEND_FLOW", "STALL_BACKEND_BUSY", "L3D_CACHE_REFILL", "L2D_CACHE_REFILL_HWPRF", ""],
  ["", "STALL_FRONTEND_FLUSH", "STALL_BACKEND_ILOCK", "L3D_CACHE_REFILL_RD", "L3D_CACHE_REFILL_PRFM", ""],
  ["", "STALL_FRONTEND_RENAME", "", "", "L3D_CACHE_REFILL_HWPRF", ""],
];
const fixedTopdownKernelRows = [
  ["IPC", "INST_ratio", "FE BOUND", "MPKI", "L2D_CACHE_REFILL", ""],
  ["", "CYCLE_ratio", "BE BOUND", "BAD_INST_SPEC", "L2D_CACHE_REFILL_RD", ""],
];

function patchExcelJsMergeHandling() {
  const originalMerge = Worksheet.prototype._mergeCellsInternal;
  if (originalMerge.__cpuScenarioPatched) return;
  Worksheet.prototype._mergeCellsInternal = function patchedMergeCellsInternal(dimensions, ignoreStyle) {
    try {
      return originalMerge.call(this, dimensions, ignoreStyle);
    } catch (error) {
      if (error?.message === "Cannot merge already merged cells") {
        if (debugMode) console.warn(`[debug] skipped overlapping merge ${dimensions?.range || ""}`);
        return undefined;
      }
      throw error;
    }
  };
  Worksheet.prototype._mergeCellsInternal.__cpuScenarioPatched = true;
}

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

function columnIndex(ref) {
  const letters = ref.match(/[A-Z]+/u)?.[0] || "A";
  return [...letters].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function columnLabel(index) {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label || "A";
}

function rowNumber(ref) {
  return Number(ref.match(/\d+/u)?.[0] || 1) - 1;
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

function cellDisplayValue(cell) {
  if (!cell) return "";
  const value = cell.value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" && /[%％]/u.test(cell.numFmt || "")) return formatPercentValue(value, cell.numFmt);
  if (value instanceof Date) return cell.text || value.toISOString();
  if (typeof value !== "object") return value;
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
  if (value.result !== undefined && value.result !== null) return value.result;
  if (value.text !== undefined && value.text !== null) return value.text;
  if (value.hyperlink && value.text) return value.text;
  if (cell.text !== undefined && cell.text !== null) return cell.text;
  return "";
}

function formatPercentValue(value, numberFormat = "") {
  const decimals = numberFormat.match(/\.([0#]+)/u)?.[1]?.length || 0;
  const percentValue = Math.abs(value) <= 1 ? value * 100 : value;
  return `${percentValue.toFixed(decimals)}%`;
}

function parseExcelSheet(worksheet) {
  const rows = [];
  for (let rowIndex = 0; rowIndex < worksheet.rowCount; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const excelRow = worksheet.getRow(rowIndex + 1);
    for (let column = 0; column < worksheet.columnCount; column += 1) {
      const raw = cellDisplayValue(excelRow.getCell(column + 1));
      if (raw !== "") row[column] = coerceCell(raw);
    }
    rows[rowIndex] = row;
  }
  applyExcelMergedCells(rows, worksheet);
  return normalizeRows(rows);
}

function applyExcelMergedCells(rows, worksheet) {
  for (const mergeRef of worksheet.model?.merges || []) {
    const [start, end] = mergeRef.split(":");
    const startRow = rowNumber(start);
    const endRow = rowNumber(end || start);
    const startCol = columnIndex(start);
    const endCol = columnIndex(end || start);
    const value = rows[startRow]?.[startCol];
    if (value === undefined || value === "") continue;
    for (let row = startRow; row <= endRow; row += 1) {
      if (!rows[row]) rows[row] = [];
      for (let column = startCol; column <= endCol; column += 1) {
        if (rows[row][column] === undefined || rows[row][column] === "") rows[row][column] = value;
      }
    }
  }
}

function logExcelRowsDebug(sheet, rowNumbers) {
  for (const rowNumberValue of rowNumbers) {
    const row = normalizeRow(sheet.rows[rowNumberValue - 1]);
    const cells = row
      .map((value, index) => clean(value) ? `${columnLabel(index)}${rowNumberValue}=${JSON.stringify(value)}` : "")
      .filter(Boolean);
    console.warn(`[debug] excel ${sheet.name} row${rowNumberValue}: ${cells.join(" | ") || "<no cells>"}`);
  }
  const merges = (sheet.worksheet.model?.merges || []).filter((ref) => rowNumbers.some((rowNumberValue) => mergeRefTouchesRow(ref, rowNumberValue)));
  if (merges.length) console.warn(`[debug] excel ${sheet.name} merges near rows ${rowNumbers.join(",")}: ${merges.join(", ")}`);
}

function mergeRefTouchesRow(ref, rowNumberValue) {
  const [start, end] = ref.split(":");
  const startRow = rowNumber(start) + 1;
  const endRow = rowNumber(end || start) + 1;
  return rowNumberValue >= startRow && rowNumberValue <= endRow;
}

function isBlankRow(row = []) {
  return row.every((cell) => String(cell ?? "").trim() === "");
}

async function readWorkbook(xlsxPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);
  const sheets = workbook.worksheets.map((worksheet, index) => {
    return {
      name: worksheet.name || `sheet${index + 1}`,
      entry: worksheet.name || `sheet${index + 1}`,
      rows: parseExcelSheet(worksheet),
      worksheet,
    };
  });
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

function cellAt(rows, ref) {
  return safeRows(rows)[rowNumber(ref)]?.[columnIndex(ref)] ?? "";
}

function appAwareScenarioName(appName, sceneName, fallbackName) {
  const app = clean(appName);
  const scene = clean(sceneName) || clean(fallbackName);
  if (!app || !scene) return scene || app || clean(fallbackName);
  const parts = scene.split("_").map(clean).filter(Boolean);
  if (parts.length <= 1) return `${app}_${scene}`;
  return `${app}_${parts.slice(1).join("_")}`;
}

function oneSheetObject(workbook, sourceInfo) {
  const rows = workbook.sheets.flatMap((sheet) => sheet.rows);
  const dirName = path.basename(path.dirname(sourceInfo.xlsxPath));
  const appName = clean(findValueRight(rows, ["游戏/应用名称", "游戏名称", "应用名称"])) || clean(cellAt(rows, "D2"));
  const sceneName = clean(findValueRight(rows, ["场景名称"])) || clean(cellAt(rows, "H2"));
  const name = appAwareScenarioName(appName, sceneName, dirName);
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
  const name = appAwareScenarioName(map.get("游戏/应用名称") || map.get("游戏名称") || map.get("应用名称"), map.get("场景名称"), dirName);
  return {
    type: fallbackType || map.get("场景类型"),
    name,
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
  const match = clean(value).replace(/,/gu, "").match(/-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/iu);
  return match ? round2(Number(match[0])) : 0;
}

function hasPercentSign(value) {
  return /[%％]/u.test(clean(value));
}

function hasWrappedPercent(value) {
  return /[（(][^）)]*[%％][）)]/u.test(clean(value));
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
  const text = clean(value);
  const match = text.match(/^(?:(\d+(?:\.\d+)?)\s*[_\-\s:：]*)?([A-Za-z_][\w./-]*?)\s*(?:[（(]\s*([\d.]+)\s*[%％]\s*[）)]|[\s,，:：]+([\d.]+)\s*[%％])$/u);
  if (!match) return null;
  return {
    rank,
    number: match[1] ? Number(match[1]) : rank,
    name: match[2],
    share: round2(Number(match[3] || match[4])),
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
    CREATE TABLE IF NOT EXISTS hotspot_threads (id TEXT PRIMARY KEY, scenario_id TEXT NOT NULL, dimension TEXT NOT NULL, thread_id TEXT NOT NULL, rank INTEGER NOT NULL, score REAL NOT NULL, name TEXT NOT NULL DEFAULT '', thread_type TEXT NOT NULL DEFAULT '');
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
  const hotspotThreadColumns = new Set(db.prepare("PRAGMA table_info(hotspot_threads)").all().map((row) => row.name));
  if (!hotspotThreadColumns.has("name")) db.exec("ALTER TABLE hotspot_threads ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  if (!hotspotThreadColumns.has("thread_type")) db.exec("ALTER TABLE hotspot_threads ADD COLUMN thread_type TEXT NOT NULL DEFAULT ''");
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
    hotspotThread: db.prepare("INSERT INTO hotspot_threads (id, scenario_id, dimension, thread_id, rank, score, name, thread_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    hotspotSo: db.prepare("INSERT INTO hotspot_sos VALUES (?, ?, ?, ?, ?)"),
    hotspotFunction: db.prepare("INSERT INTO hotspot_functions VALUES (?, ?, ?, ?)"),
  };
}

function threadId(scenarioId, threadName, threadType = "") {
  return `${scenarioId}-${threadEntityKind(threadType)}-${safeFilePart(normalizeThreadKey(threadName))}`;
}

async function dumpWorkbookExcelDebug(xlsxPath, scenarioId, workbook) {
  const dir = path.dirname(xlsxPath);
  const prefix = `${path.basename(xlsxPath, path.extname(xlsxPath))}.${safeFilePart(scenarioId)}.debug`;
  const outPath = path.join(dir, `${prefix}.excel.json`);
  const payload = workbook.sheets.map((sheet) => ({
    name: sheet.name,
    merges: sheet.worksheet.model?.merges || [],
    rows: sheet.rows,
  }));
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2), "utf8");
  console.warn(`[debug] dumped parsed excel workbook: ${outPath}`);
}

function safeFilePart(value) {
  return clean(value).replace(/[\\/:*?"<>|\s]+/gu, "_").slice(0, 120) || "scenario";
}

function inferThreadType(threadName, rank) {
  const value = clean(threadName).toLowerCase();
  if (value.includes("render") || value.includes("gfx") || value.includes("preview")) return "render";
  if (rank === 0 || value.includes("main") || value.includes("activity") || value.includes("agent") || value.includes("camera")) return "main";
  return "other";
}

function canonicalThreadType(value) {
  const raw = clean(value);
  const text = raw.toLowerCase();
  if (!raw) return "";
  if (/进程|\bprocess\b/iu.test(raw)) {
    if (/主逻辑|主进程|main|activity|agent|camera/iu.test(text)) return "主逻辑进程";
    if (/渲染|render|gfx|preview/iu.test(text)) return "渲染进程";
    if (/其他|other|worker|binder|device/iu.test(text)) return "其他进程";
  }
  if (/主逻辑|主线程|main|activity|agent|camera/iu.test(text)) return "main";
  if (/渲染|render|gfx|preview/iu.test(text)) return "render";
  if (/其他|other|worker|binder|device/iu.test(text)) return "other";
  if (/线程|进程|\bthread\b|\bprocess\b/iu.test(raw)) return raw;
  return "";
}

function threadTypeSegmentFromName(value) {
  const text = clean(value);
  const separators = [...text.matchAll(/\s*[-－—–]\s*/gu)];
  for (let index = 0; index < separators.length; index += 1) {
    const separator = separators[index];
    const segmentStart = separator.index + separator[0].length;
    const segmentEnd = separators[index + 1]?.index ?? text.length;
    const segment = clean(text.slice(segmentStart, segmentEnd));
    const type = canonicalThreadType(segment);
    if (type) return { name: clean(text.slice(0, separator.index)), type };
  }
  return null;
}

function parseThreadInfo(threadName, threadType = "") {
  const parsedPercent = parseNamedPercent(threadName);
  let name = clean(parsedPercent.name || threadName);
  let type = canonicalThreadType(threadType);
  const typedSegment = threadTypeSegmentFromName(name);
  if (typedSegment) {
    name = typedSegment.name;
    type ||= typedSegment.type;
  }
  name = name
    .replace(/线程\s*[-_－—– ]*(all|kernel|总体|内核).*$/iu, "")
    .replace(/\s*[-_－—–]\s*(all|kernel|总体|内核).*$/iu, "")
    .replace(/线程$/u, "")
    .trim();
  return {
    name: name || clean(parsedPercent.name || threadName),
    type,
  };
}

function normalizeThreadKey(threadName) {
  return clean(parseThreadInfo(threadName).name)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}

function threadEntityKind(threadType = "") {
  return /进程|process/iu.test(clean(threadType)) ? "process" : "thread";
}

function ensureThread(threadMap, scenarioId, threadName, threadType, loadShare = 0) {
  const parsed = parseThreadInfo(threadName, threadType);
  const name = parsed.name;
  const type = parsed.type || clean(threadType) || inferThreadType(name, threadMap.size);
  const key = `${threadEntityKind(type)}:${normalizeThreadKey(name)}`;
  const existing = threadMap.get(key);
  if (existing) {
    if (type && (!existing.type || existing.type === "other")) existing.type = type;
    if (loadShare && !existing.loadShare) existing.loadShare = round2(loadShare);
    return existing;
  }
  const thread = { id: threadId(scenarioId, name, type), name, type, loadShare: round2(loadShare), rank: threadMap.size + 1 };
  threadMap.set(key, thread);
  return thread;
}

async function importScenario(db, statements, sourceInfo, warnings) {
  const workbook = await readWorkbook(sourceInfo.xlsxPath);
  if (debugMode) {
    console.warn(`[debug] reading ${sourceInfo.xlsxPath}`);
    console.warn(`[debug] sheets: ${workbook.sheets.map((sheet) => `${sheet.name}:${sheet.rows.length} rows`).join(", ") || "none"}`);
    logExcelRowsDebug(workbook.sheets[0], [104, 105, 106]);
    logExcelRowsDebug(
      workbook.sheets[0],
      [108, 109, 110, 111, 112, 113, 118, 121, 127, 136, 137, 138, 164, 165, 166],
    );
  }
  const base = baseObject(workbook, sourceInfo);
  const scenarioId = scenarioIdFromSource(sourceInfo, base);
  if (debugMode) console.warn(`[debug] scenario ${scenarioId}: ${JSON.stringify(base)}`);
  if (debugMode) await dumpWorkbookExcelDebug(sourceInfo.xlsxPath, scenarioId, workbook);
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
    ? parseSixSheet(workbook, scenarioId, warnings, base)
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

function parseSixSheet(workbook, scenarioId, warnings, base = {}) {
  const parsed = emptyParsed();
  const options = parseOptions(base);
  const topdownRows = safeRows(workbook.byRole.topdown);
  const hotspotRows = safeRows(workbook.byRole.hotspots);
  for (const row of topdownRows.slice(1).filter((item) => item[0])) {
    ensureThread(parsed.threads, scenarioId, row[0], row[1]);
  }
  for (const row of hotspotRows.slice(1).filter((item) => item[0])) {
    ensureThread(parsed.threads, scenarioId, row[1], "", clean(row[0]).toLowerCase() === "cycle" ? row[2] : 0);
  }
  safeParse(warnings, scenarioId, "hizee", () => parseSixSheetHizee(safeRows(workbook.byRole.load), parsed));
  safeParse(warnings, scenarioId, "topdown", () => parseSixSheetTopdown(topdownRows, parsed, scenarioId, options));
  safeParse(warnings, scenarioId, "instructions", () => parseSixSheetInstructions(safeRows(workbook.byRole.instructions), parsed, scenarioId, options));
  safeParse(warnings, scenarioId, "syscalls", () => parseSixSheetSyscalls(safeRows(workbook.byRole.syscalls), parsed, scenarioId, options));
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

function parseSixSheetTopdown(rows, parsed, scenarioId, options = {}) {
  const dataRows = options.coldStart ? rows.slice(1, 2) : rows.slice(1);
  for (const row of dataRows) {
    const [threadName, threadType, sourceScope, level, rawMetric, parent, value] = row;
    if (!threadName || value === "") continue;
    if (isIgnoredTopdownMetric(rawMetric)) continue;
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

function parseSixSheetInstructions(rows, parsed, scenarioId, options = {}) {
  const header = rows[0] || [];
  const scopeRow = rows[1] || [];
  for (const [rowIndex, row] of rows.slice(2).entries()) {
    const [threadName, threadType] = row;
    if (!threadName) continue;
    const adjusted = options.coldStart ? coldStartInstructionThreadInfo(threadName, threadType, rowIndex) : { name: threadName, type: threadType };
    const thread = ensureThread(parsed.threads, scenarioId, adjusted.name, adjusted.type);
    if (options.coldStart) thread.rank = adjusted.rank;
    for (let c = 2; c < header.length; c += 1) {
      if (!header[c] || row[c] === "") continue;
      parsed.instructions.push({ threadId: thread.id, scope: scopeFromSource(scopeRow[c]), event: canonicalInstructionName(header[c]), value: numberFrom(row[c]) });
    }
  }
}

function parseSixSheetSyscalls(rows, parsed, scenarioId, options = {}) {
  const dataRows = options.coldStart ? rows.slice(1, 2) : rows.slice(1);
  for (const row of dataRows) {
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
    const dimension = clean(dimensionRaw).toLowerCase();
    const thread = ensureThread(parsed.threads, scenarioId, threadName, "", dimension === "cycle" ? threadScore : 0);
    parsed.hotspots.push({
      dimension,
      threadId: thread.id,
      threadName: clean(threadName),
      threadType: thread.type,
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
  const options = parseOptions(base);
  const normalizedRows = safeRows(rows);
  const sections = locateSections(normalizedRows);
  if (debugMode) console.warn(`[debug] ${scenarioId} one-sheet sections: ${JSON.stringify(sections)}, rows=${normalizedRows.length}`);
  safeParse(warnings, scenarioId, "hizee", () => parseOneSheetHizee(normalizedRows, sections, parsed));
  safeParse(warnings, scenarioId, "topdown", () => parseOneSheetTopdown(normalizedRows, sections, parsed, scenarioId, warnings, options));
  safeParse(warnings, scenarioId, "instructions", () => parseOneSheetInstructions(normalizedRows, sections, parsed, scenarioId, options));
  safeParse(warnings, scenarioId, "syscalls", () => parseOneSheetSyscalls(normalizedRows, sections, parsed, scenarioId, options));
  safeParse(warnings, scenarioId, "hotspots", () => parseOneSheetHotspots(normalizedRows, sections, parsed, scenarioId));
  if (!parsed.threads.size) {
    ["main", "render", "other"].forEach((type, index) => ensureThread(parsed.threads, scenarioId, `${base.name}_${type}`, type, index === 0 ? 30 : 20));
  }
  return parsed;
}

function parseOptions(base = {}) {
  return { coldStart: clean(base.type) === "冷启动" };
}

function locateSections(rows) {
  const markers = {};
  safeRows(rows).forEach((row, index) => {
    const text = rowText(row).toUpperCase();
    if (text.includes("TOPDOWN") && markers.topdown == null) markers.topdown = index;
    if (text.includes("指令分布") && markers.instructions == null) markers.instructions = index;
    if (text.includes("系统调用") && markers.syscalls == null) markers.syscalls = index;
    if ((text.includes("热点") || text.includes("瓶颈") || text.includes("HOT") || text.includes("BOUND SO") || text.includes("LIBRARY") || text.includes("FUNCTION")) && markers.hotspots == null) markers.hotspots = index;
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
  const loadEndCol = firstPositiveIndex([fpsCol, freqCol, ddrCol, bandwidthCol, latencyCol]) - 1;
  const searchRows = safe.slice(headerIndex >= 0 ? headerIndex + 1 : sections.load ?? 0, sections.topdown ?? safe.length);
  let currentCluster = "";
  const clusterSeen = new Map();
  const clusterLoadRows = new Map();
  for (const row of searchRows) {
    const text = rowText(row);
    const cluster = clusterFromRow(row) || currentCluster;
    if (clusterFromRow(row)) currentCluster = clusterFromRow(row);
    if (!cluster) continue;
    if (!clusterSeen.has(cluster)) clusterSeen.set(cluster, { cluster, avgFreqMhz: 0, allProcess: 0, uiProcess: 0, renderService: 0 });
    const item = clusterSeen.get(cluster);
    const loadSlot = hizeeLoadSlotFromRow(text);
    const orderedLoadValue = hizeeLoadValueFromRow(row, loadCol, loadEndCol);
    if (loadSlot === "all") item.allProcess = processLoadFromRow(row, loadCol, loadEndCol, hizeeAllProcessPattern()) || item.allProcess;
    if (loadSlot === "ui") item.uiProcess = processLoadFromRow(row, loadCol, loadEndCol, hizeeUiProcessPattern()) || item.uiProcess;
    if (loadSlot === "render") item.renderService = processLoadFromRow(row, loadCol, loadEndCol, hizeeRenderProcessPattern()) || item.renderService;
    if (loadSlot) {
      clusterLoadRows.set(cluster, Math.max(clusterLoadRows.get(cluster) || 0, hizeeLoadSlotIndex(loadSlot) + 1));
    } else if (orderedLoadValue) {
      const rowIndex = clusterLoadRows.get(cluster) || 0;
      if (rowIndex === 0) item.allProcess = item.allProcess || orderedLoadValue;
      if (rowIndex === 1) item.uiProcess = item.uiProcess || orderedLoadValue;
      if (rowIndex === 2) item.renderService = item.renderService || orderedLoadValue;
      clusterLoadRows.set(cluster, rowIndex + 1);
    }
    if (loadSlot === "all" || clusterFromRow(row)) {
      if (!item.avgFreqMhz) item.avgFreqMhz = numberAtOrNear(row, freqCol, (num) => num > 300 && num < 10000);
      if (!parsed.hizee.scene.fps) parsed.hizee.scene.fps = numberAtOrNear(row, fpsCol, (num) => num > 0 && num <= 300);
      if (!parsed.hizee.scene.ddrFreqMhz) parsed.hizee.scene.ddrFreqMhz = numberAtOrNear(row, ddrCol, (num) => num > 300 && num < 10000);
      if (!parsed.hizee.scene.bandwidth) parsed.hizee.scene.bandwidth = numberAtOrNear(row, bandwidthCol, (num) => num > 0 && num < 1000);
      if (!parsed.hizee.scene.latency) parsed.hizee.scene.latency = numberAtOrNear(row, latencyCol, (num) => num > 0 && num < 10000);
    }
  }
  applyHizeeCoordinateLayout(safe, clusterSeen, parsed);
  parsed.hizee.clusters = clusters.map((cluster) => clusterSeen.get(cluster) || { cluster, avgFreqMhz: 0, allProcess: 0, uiProcess: 0, renderService: 0 });
}

function applyHizeeCoordinateLayout(rows, clusterSeen, parsed) {
  const layout = [
    { cluster: "小核", rows: [26, 27, 28] },
    { cluster: "中核", rows: [29, 30, 31] },
    { cluster: "大核", rows: [32, 33, 34] },
  ];
  const hasTargetCells = layout.some((item) => item.rows.some((rowIndex) => numericCellOrNull(rows[rowIndex]?.[2]) != null || numericCellOrNull(rows[rowIndex]?.[4]) != null));
  if (!hasTargetCells) return;
  for (const item of layout) {
    if (!clusterSeen.has(item.cluster)) clusterSeen.set(item.cluster, { cluster: item.cluster, avgFreqMhz: 0, allProcess: 0, uiProcess: 0, renderService: 0 });
    const cluster = clusterSeen.get(item.cluster);
    const [allProcess, uiProcess, renderService] = item.rows.map((rowIndex) => percentCellOrNull(rows[rowIndex]?.[2]));
    if (allProcess != null) cluster.allProcess = boundedNumber(allProcess);
    if (uiProcess != null) cluster.uiProcess = boundedNumber(uiProcess);
    if (renderService != null) cluster.renderService = boundedNumber(renderService);
    const avgFreqMhz = numericCellOrNull(rows[item.rows[0]]?.[4]);
    if (avgFreqMhz != null && avgFreqMhz > 300 && avgFreqMhz < 10000) cluster.avgFreqMhz = round2(avgFreqMhz);
  }
  const fps = numericCellOrNull(rows[26]?.[3]);
  if (fps != null && fps > 0 && fps <= 300) parsed.hizee.scene.fps = round2(fps);
  if (hasTargetHizeeSceneColumns(rows[25])) {
    const ddrFreqMhz = numericCellOrNull(rows[26]?.[5]);
    if (ddrFreqMhz != null && ddrFreqMhz > 300 && ddrFreqMhz < 10000) parsed.hizee.scene.ddrFreqMhz = round2(ddrFreqMhz);
    const bandwidth = numericCellOrNull(rows[26]?.[6]);
    if (bandwidth != null && bandwidth >= 0 && bandwidth < 1000) parsed.hizee.scene.bandwidth = round2(bandwidth);
    const latency = numericCellOrNull(rows[26]?.[7]);
    if (latency != null && latency > 0 && latency < 10000) parsed.hizee.scene.latency = round2(latency);
  }
}

function hasTargetHizeeSceneColumns(headerRow) {
  const cells = normalizeRow(headerRow).map(clean);
  return /DDR/iu.test(cells[5] || "") && /平均带宽|bandwidth/iu.test(cells[6] || "") && /latency|时延/iu.test(cells[7] || "");
}

function clusterFromRow(row) {
  const text = rowText(row);
  if (/小核|cluster0/iu.test(text)) return "小核";
  if (/中核|cluster1/iu.test(text)) return "中核";
  if (/大核|cluster2/iu.test(text)) return "大核";
  return "";
}

function firstPositiveIndex(indexes) {
  const valid = indexes.filter((index) => index > 0);
  return valid.length ? Math.min(...valid) : Number.POSITIVE_INFINITY;
}

function hizeeAllProcessPattern() {
  return /所有\s*进程|全部\s*进程|总进程|all\s*(process|proc)?|total\s*(process|proc)?/iu;
}

function hizeeUiProcessPattern() {
  return /\bUI\b\s*(进程|线程|process|thread)?|UI进程|UI线程|前台\s*(进程|线程)|主\s*(进程|线程)/iu;
}

function hizeeRenderProcessPattern() {
  return /render[\s_-]*(service|server|进程|线程|process|thread)?|render\s*service|render_service|renderservice|RS\s*(进程|线程|process|thread)?|渲染\s*(服务|进程|线程)/iu;
}

function hizeeLoadSlotFromRow(text) {
  if (hizeeAllProcessPattern().test(text)) return "all";
  if (hizeeUiProcessPattern().test(text)) return "ui";
  if (hizeeRenderProcessPattern().test(text)) return "render";
  return "";
}

function hizeeLoadSlotIndex(slot) {
  return { all: 0, ui: 1, render: 2 }[slot] ?? 0;
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

function processLoadFromRow(row, loadCol, loadEndCol, labelPattern) {
  const cells = normalizeRow(row);
  const effectiveLoadEndCol = Number.isFinite(loadEndCol) ? Math.min(loadEndCol, cells.length - 1) : cells.length - 1;
  const labelIndex = cells.findIndex((cell) => labelPattern.test(clean(cell)));
  if (labelIndex >= 0) {
    const afterLabel = firstLikelyPercentInRange(cells, labelIndex + 1, Math.min(effectiveLoadEndCol, labelIndex + 2));
    if (afterLabel) return afterLabel;
  }
  if (loadCol >= 0) {
    const direct = percentCellOrNull(cells[loadCol]);
    if (direct > 0 && direct <= 100) return direct;
    const nearby = firstLikelyPercentInRange(cells, loadCol, Math.min(effectiveLoadEndCol, loadCol + 2));
    if (nearby) return nearby;
  }
  return 0;
}

function hizeeLoadValueFromRow(row, loadCol, loadEndCol) {
  const cells = normalizeRow(row);
  const effectiveLoadEndCol = Number.isFinite(loadEndCol) ? Math.min(loadEndCol, cells.length - 1) : cells.length - 1;
  if (loadCol >= 0) return firstLikelyPercentInRange(cells, loadCol, Math.min(effectiveLoadEndCol, loadCol + 2));
  return firstLikelyPercentInRange(cells, 0, effectiveLoadEndCol);
}

function numericCellOrNull(value) {
  if (typeof value === "number") return round2(value);
  const text = clean(value);
  if (!text) return null;
  const match = text.replace(/,/gu, "").match(/-?\d+(?:\.\d+)?/u);
  return match ? round2(Number(match[0])) : null;
}

function numericCellExactOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = clean(value);
  if (!text) return null;
  const match = text.replace(/,/gu, "").match(/-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/iu);
  return match ? Number(match[0]) : null;
}

function percentCellOrNull(value) {
  const number = numericCellExactOrNull(value);
  if (number == null) return null;
  if (typeof value === "number" && number > 0 && number <= 1) return round2(number * 100);
  return round2(number);
}

function firstLikelyPercentInRange(cells, start, end) {
  for (let c = Math.max(0, start); c <= Math.min(cells.length - 1, end); c += 1) {
    const text = clean(cells[c]);
    const value = percentCellOrNull(cells[c]) ?? 0;
    if (value > 0 && value <= 100 && (hasPercentSign(text) || value < 100)) return value;
  }
  return 0;
}

function numberNear(row, index, predicate, radius = 3) {
  const cells = normalizeRow(row);
  if (index >= 0) {
    const direct = numberFrom(cells[index]);
    if (direct && predicate(direct)) return direct;
    const nearby = firstNumberInRange(cells, Math.max(0, index - 1), Math.min(cells.length - 1, index + radius), predicate);
    if (nearby) return nearby;
    return 0;
  }
  return firstNumberInRange(cells, 0, cells.length - 1, predicate);
}

function numberAtOrNear(row, index, predicate) {
  const cells = normalizeRow(row);
  if (index < 0) return 0;
  const direct = numberFrom(cells[index]);
  if (direct && predicate(direct)) return direct;
  return firstNumberInRange(cells, Math.max(0, index - 1), Math.min(cells.length - 1, index + 1), predicate);
}

function firstNumberInRange(cells, start, end, predicate) {
  for (let c = Math.max(0, start); c <= Math.min(cells.length - 1, end); c += 1) {
    const value = numberFrom(cells[c]);
    if (value && predicate(value)) return value;
  }
  return 0;
}

function parseOneSheetTopdown(rows, sections, parsed, scenarioId, warnings, options = {}) {
  const safe = safeRows(rows);
  const start = sections.topdown ?? safe.findIndex((row) => row.some((cell) => isKnownTopdown(cell)));
  const end = firstSectionAfter(sections, start, ["instructions", "syscalls", "hotspots"]) ?? safe.length;
  if (start < 0) return;
  const fixedCount = parseFixedTopdownCoordinates(safe, parsed, scenarioId, options);
  if (fixedCount) return;
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
    for (const candidate of unresolvedMetricCandidates(row, isKnownTopdown)) {
      if (!isIgnoredTopdownMetric(candidate)) unresolved.add(candidate);
    }
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
      const parent = topdownParent(metric);
      parsed.topdown.push({ threadId: targetThread.id, scope, level: topdownLevel(metric, parent), metric, parent, value: pair.value });
    }
  }
  if (unresolved.size) {
    warnings.push(`Unresolved topdown metric alias for ${scenarioId}: ${[...unresolved].slice(0, 20).join(", ")}${unresolved.size > 20 ? " ..." : ""}`);
  }
}

function parseFixedTopdownCoordinates(rows, parsed, scenarioId, options = {}) {
  let count = 0;
  const blockStarts = options.coldStart ? fixedTopdownBlockStarts.slice(0, 1) : fixedTopdownBlockStarts;
  blockStarts.forEach((blockStart, blockIndex) => {
    const headerText = rowText(rows[blockStart]);
    if (!/线程.*(all|kernel)|thread/iu.test(headerText)) return;
    const threadInfo = fixedSectionThreadInfo(rows[blockStart], fixedTopdownThreadTypes[blockIndex] || "main");
    const threadName = threadInfo.name;
    const threadType = threadInfo.type || fixedTopdownThreadTypes[blockIndex] || inferThreadType(threadName, blockIndex);
    const thread = ensureThread(parsed.threads, scenarioId, threadName, threadType);
    count += parseFixedTopdownRows(rows, blockStart + 1, fixedTopdownTotalRows, thread, "total", parsed);
    count += parseFixedTopdownRows(rows, blockStart + 11, fixedTopdownKernelRows, thread, "kernel", parsed);
  });
  return count;
}

function parseFixedTopdownRows(rows, startRow, metricRows, thread, scope, parsed) {
  let count = 0;
  metricRows.forEach((metrics, rowOffset) => {
    metrics.forEach((metric, pairIndex) => {
      if (!metric || isIgnoredTopdownMetric(metric) || !isKnownTopdown(metric)) return;
      const value = numericCellOrNull(rows[startRow + rowOffset]?.[pairIndex * 2 + 1]);
      if (value == null) return;
      const parent = topdownParent(metric);
      parsed.topdown.push({ threadId: thread.id, scope, level: topdownLevel(metric, parent), metric, parent, value });
      count += 1;
    });
  });
  return count;
}

function fixedTopdownThreadName(row, blockIndex) {
  return fixedSectionThreadInfo(row, fixedTopdownThreadTypes[blockIndex] || "main").name;
}

function fixedSectionThreadInfo(row, fallbackType) {
  const raw = normalizeRow(row).map(clean).find(Boolean) || `${fallbackType}_thread`;
  return parseThreadInfo(raw, fallbackType);
}

function fixedSectionThreadName(row, fallbackType) {
  return fixedSectionThreadInfo(row, fallbackType).name;
}

function coldStartInstructionThreadInfo(threadName, threadType, slotIndex) {
  const info = parseThreadInfo(threadName, threadType);
  if (slotIndex === 0) return { name: info.name, type: "主逻辑进程", rank: 2 };
  if (slotIndex === 1) return { name: info.name, type: "渲染进程", rank: 3 };
  return { name: info.name, type: "main", rank: 1 };
}

function parseOneSheetInstructions(rows, sections, parsed, scenarioId, options = {}) {
  const safe = safeRows(rows);
  const start = sections.instructions ?? safe.findIndex((row) => row.some((cell) => isKnownInstruction(cell)));
  if (start < 0) return;
  const fixedCount = parseFixedInstructionCoordinates(safe, parsed, scenarioId, options);
  if (fixedCount) return;
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

function parseFixedInstructionCoordinates(rows, parsed, scenarioId, options = {}) {
  let count = 0;
  fixedInstructionDataStarts.forEach((dataStart, blockIndex) => {
    const headerRow = dataStart - 2;
    const threadInfo = fixedSectionThreadInfo(rows[headerRow], fixedTopdownThreadTypes[blockIndex] || "main");
    const adjusted = options.coldStart ? coldStartInstructionThreadInfo(threadInfo.name, threadInfo.type, blockIndex) : { name: threadInfo.name, type: threadInfo.type || fixedTopdownThreadTypes[blockIndex] || inferThreadType(threadInfo.name, blockIndex) };
    const threadName = adjusted.name;
    const threadType = adjusted.type;
    const thread = ensureThread(parsed.threads, scenarioId, threadName, threadType);
    if (options.coldStart) thread.rank = adjusted.rank;
    fixedInstructionRows.forEach(([firstEvent, secondEvent], rowOffset) => {
      const row = rows[dataStart + rowOffset];
      count += addFixedInstruction(parsed, thread, "total", firstEvent, row?.[1]);
      count += addFixedInstruction(parsed, thread, "total", secondEvent, row?.[3]);
      count += addFixedInstruction(parsed, thread, "kernel", firstEvent, row?.[5]);
      count += addFixedInstruction(parsed, thread, "kernel", secondEvent, row?.[7]);
    });
  });
  return count;
}

function addFixedInstruction(parsed, thread, scope, event, rawValue) {
  if (!event) return 0;
  const value = numericCellExactOrNull(rawValue);
  if (value == null) return 0;
  parsed.instructions.push({ threadId: thread.id, scope, event, value });
  return 1;
}

function parseOneSheetSyscalls(rows, sections, parsed, scenarioId, options = {}) {
  const safe = safeRows(rows);
  const start = sections.syscalls ?? safe.findIndex((row) => row.some((cell) => includesText(cell, "系统调用密度")));
  if (start < 0) return;
  const fixedCount = parseFixedSyscallCoordinates(safe, parsed, scenarioId, options);
  if (fixedCount) return;
  const end = firstSectionAfter(sections, start, ["hotspots"]) ?? safe.length;
  const header = safe.slice(start, Math.min(end, start + 3)).find((row) => row.some((cell) => /线程|thread/iu.test(clean(cell))) && row.some((cell) => /密度|density/iu.test(clean(cell)))) || [];
  const threadCol = header.findIndex((cell) => /线程|thread/iu.test(clean(cell)));
  const densityCol = header.findIndex((cell) => /密度|density/iu.test(clean(cell)));
  const topCol = firstSyscallTopColumn(header);
  for (const row of safe.slice(start, end)) {
    const cells = normalizeRow(row).map(clean);
    if (isSyscallHeaderLikeRow(cells)) continue;
    const calls = parseSyscallRowCalls(cells, topCol >= 0 ? topCol : Math.max(threadCol, densityCol) + 1);
    if (!calls.length) continue;
    const name = syscallThreadName(row, cells, threadCol, densityCol) || `thread_${parsed.threads.size + 1}`;
    const thread = ensureThread(parsed.threads, scenarioId, name, "");
    const density = syscallDensity(row, densityCol, threadCol, topCol);
    parsed.syscalls.push({ threadId: thread.id, density, calls });
  }
}

function parseFixedSyscallCoordinates(rows, parsed, scenarioId, options = {}) {
  let count = 0;
  const syscallRows = options.coldStart ? fixedSyscallRows.slice(0, 1) : fixedSyscallRows;
  syscallRows.forEach((rowIndex, index) => {
    const row = rows[rowIndex];
    const threadInfo = fixedSectionThreadInfo(row, fixedTopdownThreadTypes[index] || "main");
    const name = threadInfo.name;
    const rawDensity = fixedSyscallDensityRaw(row);
    const density = fixedSyscallDensity(row);
    if (debugMode) logSyscallCoordinateDebug(row, rowIndex, index, name, rawDensity, density);
    if (!name || !/线程|thread|Unity|Render|Main|Worker|Device|Camera|Activity|Binder|Gfx/iu.test(rowText(row))) return;
    const calls = parseSyscallRowCalls(normalizeRow(row).slice(3, 8), 0);
    if (debugMode) console.warn(`[debug] syscall row${rowIndex + 1} parsed calls=${calls.length} first=${calls[0] ? `${calls[0].number}_${calls[0].name}(${calls[0].share}%)` : "NA"}`);
    if (!calls.length) return;
    const thread = ensureThread(parsed.threads, scenarioId, name, threadInfo.type || fixedTopdownThreadTypes[index] || inferThreadType(name, index));
    parsed.syscalls.push({ threadId: thread.id, density, calls });
    count += 1;
  });
  return count;
}

function logSyscallCoordinateDebug(row, rowIndex, index, name, rawDensity, density) {
  const refs = ["A", "B", "C", "D", "E", "F", "G", "H"].map((col, colIndex) => `${col}${rowIndex + 1}=${JSON.stringify(clean(normalizeRow(row)[colIndex]))}`);
  console.warn(`[debug] syscall row${rowIndex + 1} type=${fixedTopdownThreadTypes[index] || ""} name=${JSON.stringify(name)} rawDensity=${JSON.stringify(rawDensity)} density=${density} ${refs.join(" ")}`);
  if (rawDensity == null || rawDensity === "") {
    console.warn(`[debug] syscall row${rowIndex + 1} density is empty in parsed Excel cells; checked C${rowIndex + 1} and B${rowIndex + 1}.`);
  }
}

function fixedSyscallDensity(row) {
  const direct = numericCellExactOrNull(fixedSyscallDensityRaw(row));
  if (direct != null) return direct;
  const cells = normalizeRow(row);
  for (const column of [2, 1, 3]) {
    if (syscallFromText(cells[column], 1)) continue;
    const value = numericCellExactOrNull(cells[column]);
    if (value != null) return value;
  }
  return 0;
}

function fixedSyscallDensityRaw(row) {
  const cells = normalizeRow(row);
  const preferred = [cells[2], cells[1]];
  return preferred.find((cell) => numericCellExactOrNull(cell) != null);
}

function firstSyscallTopColumn(header) {
  return normalizeRow(header).findIndex((cell) => /TOP\s*\d|系统调用.*占比|占比/iu.test(clean(cell)));
}

function isSyscallHeaderLikeRow(cells) {
  const text = cells.filter(Boolean).join(" ");
  return /系统调用\s*$|系统调用信息|线程名|系统调用密度|TOP\s*\d/iu.test(text) && !cells.some((cell) => syscallFromText(cell, 1));
}

function syscallThreadName(row, cells, threadCol, densityCol) {
  const direct = threadCol >= 0 ? clean(row[threadCol]) : "";
  if (direct && !/线程名|thread\s*name/iu.test(direct) && !syscallFromText(direct, 1)) return direct;
  const maxCol = densityCol >= 0 ? densityCol : cells.length;
  const beforeDensity = cells.slice(0, maxCol).find((cell) => looksLikeSyscallThread(cell));
  if (beforeDensity) return beforeDensity;
  return cells.find((cell) => looksLikeSyscallThread(cell) && !syscallFromText(cell, 1)) || "";
}

function looksLikeSyscallThread(value) {
  const text = clean(value);
  return !!text && /线程|thread|Unity|Render|Main|Worker|Device|Camera|Activity|Binder|Gfx/iu.test(text) && !/系统调用|TOP|密度|density/iu.test(text);
}

function syscallDensity(row, densityCol, threadCol, topCol) {
  if (densityCol >= 0) return numberFrom(row[densityCol]);
  const cells = normalizeRow(row);
  const searchStart = Math.max(0, threadCol + 1);
  const searchEnd = topCol >= 0 ? topCol - 1 : Math.min(cells.length - 1, searchStart + 3);
  const nearHeader = firstNumberInRangeOrNull(cells, searchStart, searchEnd, (num) => num >= 0 && num < 100000);
  if (nearHeader != null) return nearHeader;
  const beforeCalls = cells.find((cell) => clean(cell) && !syscallFromText(cell, 1) && numberFrom(cell) > 0);
  return numberFrom(beforeCalls);
}

function parseSyscallRowCalls(cells, startCol = 0) {
  const source = normalizeRow(cells).slice(Math.max(0, startCol)).map(clean);
  const parsed = [];
  for (let i = 0; i < source.length; i += 1) {
    const compact = syscallFromText(source[i], parsed.length + 1);
    if (compact) {
      parsed.push(compact);
      continue;
    }
    const split = syscallFromSplitCells(source, i, parsed.length + 1);
    if (split) {
      parsed.push(split.call);
      i += split.consumed - 1;
    }
  }
  const total = parsed.reduce((sum, call) => sum + call.share, 0);
  if (parsed.length && total < 99.995) parsed.push({ rank: parsed.length + 1, number: 0, name: "others", share: round2(100 - total) });
  return parsed;
}

function syscallFromSplitCells(cells, index, rank) {
  const first = clean(cells[index]);
  const second = clean(cells[index + 1]);
  const third = clean(cells[index + 2]);
  if (!first) return null;
  const hasPercent = hasPercentSign(first) || hasPercentSign(second) || hasPercentSign(third);
  if (!hasPercent) return null;
  if (/^[A-Za-z_][\w./-]*$/u.test(first)) {
    return { consumed: 2, call: { rank, number: rank, name: first, share: round2(numberFrom(second)) } };
  }
  if (/^\d+(?:\.\d+)?$/u.test(first) && /^[A-Za-z_][\w./-]*$/u.test(second)) {
    return { consumed: 3, call: { rank, number: Number(first), name: second, share: round2(numberFrom(third)) } };
  }
  return null;
}

function firstNumberInRangeOrNull(cells, start, end, predicate) {
  for (let c = Math.max(0, start); c <= Math.min(cells.length - 1, end); c += 1) {
    const value = numberFrom(cells[c]);
    if (value && predicate(value)) return value;
  }
  return null;
}

function parseOneSheetHotspots(rows, sections, parsed, scenarioId) {
  const safe = safeRows(rows);
  const start = sections.hotspots ?? safe.findIndex((row) => row.some((cell) => isLibraryCell(cell) || isFunctionCell(cell)));
  if (start < 0) return;
  const fixedCount = parseFixedHotspotCoordinates(safe, parsed, scenarioId);
  if (fixedCount) return;
  let dimension = "cycle";
  let currentThread = null;
  let currentSo = null;
  for (const row of safe.slice(start)) {
    if (isHotspotDimensionRow(row, "cycle")) dimension = "cycle";
    if (isHotspotDimensionRow(row, "fe")) dimension = "fe";
    if (isHotspotDimensionRow(row, "be")) dimension = "be";
    const indexed = normalizeRow(row).map((cell, column) => ({ cell, column, text: clean(cell) })).filter((item) => item.text);
    const threadCell = indexed.find((item) => item.column <= 1 && !isLibraryCell(item.text) && !isExplicitFunctionCell(item.text) && parseNamedPercent(item.text).name && hasWrappedPercent(item.text))
      || indexed.find((item) => item.column <= 1 && looksLikeThreadName(item.text));
    if (threadCell) {
      const parsedThread = parseNamedPercent(threadCell.text);
      currentThread = ensureThread(parsed.threads, scenarioId, parsedThread.name, "", dimension === "cycle" ? parsedThread.value : 0);
      currentSo = null;
    }
    const libraryCells = indexed.filter((item) => (item.column >= 2 && item.column <= 4 && isLibraryCell(item.text)) || looksLikeHotspotSoCell(item));
    const firstLibraryColumn = libraryCells[0]?.column ?? -1;
    for (const libraryCell of libraryCells) {
      currentSo = parseNamedPercent(stripHotspotPrefix(libraryCell.text, "library"));
    }
    const functionCells = indexed.filter((item) =>
      isExplicitFunctionCell(item.text)
      || looksLikeHotspotFunctionCell(item, firstLibraryColumn)
    );
    for (const functionCell of functionCells) {
      const fn = parseNamedPercent(stripHotspotPrefix(functionCell.text, "function"));
      if (currentThread && currentSo && fn.name) {
        parsed.hotspots.push({
          dimension,
          threadId: currentThread.id,
          threadName: currentThread.name,
          threadType: currentThread.type,
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

function parseFixedHotspotCoordinates(rows, parsed, scenarioId) {
  let count = 0;
  for (const block of fixedHotspotBlocks) {
    const records = parseFixedHotspotBlock(rows, block);
    if (debugMode) logHotspotCoordinateDebug(rows, block, records);
    for (const record of records) {
      const thread = ensureThread(parsed.threads, scenarioId, record.threadName, record.threadType, block.dimension === "cycle" ? record.threadScore : 0);
      parsed.hotspots.push({
        dimension: block.dimension,
        threadId: thread.id,
        threadName: record.threadName,
        threadType: record.threadType,
        threadRank: record.threadRank,
        threadScore: record.threadScore,
        soName: record.soName,
        soValue: record.soValue,
        functionName: record.functionName,
        functionValue: record.functionValue,
      });
      count += 1;
    }
  }
  return count;
}

function parseFixedHotspotBlock(rows, block) {
  const records = [];
  for (let threadIndex = 0; threadIndex < 3; threadIndex += 1) {
    const threadStart = block.startRow + threadIndex * 9;
    const thread = firstHotspotThreadInRange(rows[threadStart], 0, 1);
    if (!thread.name) continue;
    for (let soIndex = 0; soIndex < 3; soIndex += 1) {
      const soStart = threadStart + soIndex * 3;
      const so = firstNamedPercentInRange(rows[soStart], 2, 4, "library");
      if (!so.name) continue;
      for (let functionIndex = 0; functionIndex < 3; functionIndex += 1) {
        const fn = firstNamedPercentInRange(rows[soStart + functionIndex], 5, 7, "function");
        if (!fn.name) continue;
        records.push({
          threadType: inferThreadType(thread.name, threadIndex),
          threadName: thread.name,
          threadRank: threadIndex + 1,
          threadScore: thread.value,
          soName: so.name,
          soValue: so.value,
          functionName: fn.name,
          functionValue: fn.value,
        });
      }
    }
  }
  return records;
}

function firstHotspotThreadInRange(row, startColumn, endColumn) {
  const cells = normalizeRow(row);
  for (let column = startColumn; column <= endColumn; column += 1) {
    const text = clean(cells[column]);
    if (!text || isLibraryCell(text) || isExplicitFunctionCell(text) || isHotspotDimensionRow([text], "cycle") || isHotspotDimensionRow([text], "fe") || isHotspotDimensionRow([text], "be")) continue;
    const parsed = parseNamedPercent(text);
    if ((parsed.name && hasWrappedPercent(text)) || looksLikeThreadName(text)) return parsed;
  }
  return { name: "", value: 0 };
}

function logHotspotCoordinateDebug(rows, block, records) {
  const sampleRows = [block.startRow, block.startRow + 1, block.startRow + 2, block.startRow + 3, block.startRow + 4]
    .map((rowIndex) => `r${rowIndex + 1}=${JSON.stringify(normalizeRow(rows[rowIndex]).slice(0, 10).map(clean))}`)
    .join(" ");
  const first = records[0];
  console.warn(`[debug] hotspot ${block.dimension} rows=${block.startRow + 1}-${block.endRow} records=${records.length} first=${first ? JSON.stringify({ thread: first.threadName, so: first.soName, fn: first.functionName }) : "NA"} ${sampleRows}`);
}

function firstNamedPercentInRange(row, startColumn, endColumn, kind = "") {
  const cells = normalizeRow(row);
  const candidates = [];
  for (let column = startColumn; column <= endColumn; column += 1) {
    const text = clean(cells[column]);
    if (!text) continue;
    candidates.push(text);
  }
  const prioritized = kind === "library"
    ? [...candidates.filter((text) => isLibraryCell(text)), ...candidates.filter((text) => !isLibraryCell(text) && !looksLikeThreadName(text))]
    : kind === "function"
      ? [
          ...candidates.filter((text) => isExplicitFunctionCell(text)),
          ...candidates.filter((text) => !isExplicitFunctionCell(text) && looksLikeFunctionText(text)),
          ...candidates.filter((text) => !isExplicitFunctionCell(text) && !looksLikeFunctionText(text)),
        ]
      : candidates;
  for (const text of prioritized) {
    const source = kind ? stripHotspotPrefix(text, kind) : text;
    const parsed = parseNamedPercent(source);
    if (parsed.name) return parsed;
  }
  return { name: "", value: 0 };
}

function isHotspotDimensionRow(row, dimension) {
  const cells = [...new Set(normalizeRow(row).map(clean).filter(Boolean))];
  if (!cells.length || cells.some((cell) => isLibraryCell(cell) || isExplicitFunctionCell(cell))) return false;
  const text = cells.join(" ").trim();
  if (dimension === "cycle") return /^(CYCLE|热点|CPU热点|Cycle热点)$/iu.test(text);
  if (dimension === "fe") return /^(FE|FE\s*BOUND|FE瓶颈|前端瓶颈)$/iu.test(text);
  if (dimension === "be") return /^(BE|BE\s*BOUND|BE瓶颈|后端瓶颈)$/iu.test(text);
  return false;
}

function isLibraryCell(value) {
  const text = clean(value);
  return /^(Library|SO|库|模块)\s*[:：]/iu.test(text)
    || /^(Library|SO)\b/iu.test(text)
    || /(\.so(?:\b|[.\s+])|\[kernel\.kallsyms\]|kallsyms|\/system\/|\/vendor\/|\/proc\/)/iu.test(text);
}

function isExplicitFunctionCell(value) {
  return /^(Function|函数|方法)\s*[:：]/iu.test(clean(value)) || /^Function\b/iu.test(clean(value));
}

function isFunctionCell(value) {
  const text = clean(value);
  return isExplicitFunctionCell(text) || looksLikeFunctionText(text);
}

function looksLikeHotspotSoCell(item) {
  if (!item || item.column < 2 || item.column > 4) return false;
  const parsed = parseNamedPercent(item.text);
  if (!parsed.name || !parsed.value) return false;
  if (looksLikeThreadName(item.text) || isExplicitFunctionCell(item.text) || looksLikeFunctionText(item.text) || isHotspotDimensionRow([item.text], "cycle") || isHotspotDimensionRow([item.text], "fe") || isHotspotDimensionRow([item.text], "be")) return false;
  return true;
}

function looksLikeHotspotFunctionCell(item, firstLibraryColumn) {
  if (!item || item.column < 5 || item.column > 7) return false;
  if (firstLibraryColumn >= 0 && item.column <= firstLibraryColumn) return false;
  const parsed = parseNamedPercent(item.text);
  if (!parsed.name || !parsed.value) return false;
  if (isHotspotDimensionRow([item.text], "cycle") || isHotspotDimensionRow([item.text], "fe") || isHotspotDimensionRow([item.text], "be")) return false;
  return true;
}

function looksLikeFunctionText(value) {
  const text = stripHotspotPrefix(value, "function");
  if (!text) return false;
  return /\+0x[0-9a-f]+/iu.test(text)
    || /\b0x[0-9a-f]+\b/iu.test(text)
    || /(?:^|[/\s])(?:[A-Za-z_~][\w~]*::)+[A-Za-z_~][\w~]*/u.test(text)
    || /^[A-Za-z_~][\w~]*(?:\([^)]*\))?\s*[（(]\s*[\d.]+\s*[%％]\s*[）)]$/u.test(text);
}

function stripHotspotPrefix(value, kind) {
  const text = clean(value).replace(/\s+/gu, " ");
  return kind === "library"
    ? text.replace(/^(Library|SO|库|模块)\s*[:：]?\s*/iu, "")
    : text.replace(/^(Function|函数|方法)\s*[:：]?\s*/iu, "");
}

function looksLikeThreadName(value) {
  const text = clean(value);
  if (!text || isLibraryCell(text) || isExplicitFunctionCell(text) || isHotspotDimensionRow([text], "cycle") || isHotspotDimensionRow([text], "fe") || isHotspotDimensionRow([text], "be")) return false;
  return /线程|thread|Unity|Render|Main|Worker|Device|Camera|Activity|Binder|Gfx/iu.test(text);
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
    const parsed = parseThreadInfo(cell);
    const name = parsed.name || cell;
    const key = `${name}:${scope}`;
    if (key === lastKey) return;
    lastKey = key;
    headers.push({ name, threadType: parsed.type, scope, column });
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

function topdownLevel(metric, parent = topdownParent(metric)) {
  if (topdownLevel1.includes(metric)) return 1;
  if (!parent || topdownLevel1.includes(parent) || ["LINX MEMSTALL PKI", "CACHE REFILL PKI", "TLB REFILL & PREFETCH PKI"].includes(parent)) return 2;
  return 3;
}

function isKnownTopdown(value) {
  return metricNameMap.has(normalizeMetricName(value));
}

function isIgnoredTopdownMetric(value) {
  return ignoredTopdownMetrics.has(normalizeMetricName(value));
}

function isKnownInstruction(value) {
  return instructionNameMap.has(normalizeMetricName(value));
}

function parseNamedPercent(value) {
  const text = clean(value).replace(/\s+/gu, " ");
  const match = text.match(/^(.+?)\s*[（(]\s*([\d.]+)\s*[%％]\s*[）)]$/u);
  return match ? { name: match[1].trim(), value: numberFrom(match[2]) } : { name: text, value: 0 };
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
    statements.syscallMetric.run(row.threadId, numericCellExactOrNull(row.density) ?? 0);
    for (const call of row.calls) {
      statements.syscallTop.run(row.threadId, call.rank, call.number, call.name, round2(call.share));
    }
  }
}

function importHotspotRows(statements, scenarioId, hotspots, threadMap) {
  const groups = new Map();
  const nextRanks = new Map();
  for (const row of hotspots) {
    const thread = [...threadMap.values()].find((item) => item.id === row.threadId);
    if (!thread || !row.soName || !row.functionName) continue;
    const parsedThread = parseThreadInfo(row.threadName || thread.name, row.threadType || thread.type);
    const threadName = parsedThread.name || thread.name;
    const threadType = parsedThread.type || inferThreadType(threadName, 0);
    const slotRank = Number(row.threadRank);
    const groupKey = Number.isInteger(slotRank) && slotRank > 0
      ? `${row.dimension}:slot:${slotRank}`
      : `${row.dimension}:name:${normalizeThreadKey(threadName)}`;
    if (!groups.has(groupKey)) {
      const nextRank = nextRanks.get(row.dimension) || 1;
      const rank = Number.isInteger(slotRank) && slotRank > 0 ? slotRank : nextRank;
      if (rank > 3) continue;
      groups.set(groupKey, { dimension: row.dimension, thread, threadName, threadType, rank, score: round2(row.threadScore), sos: new Map() });
      nextRanks.set(row.dimension, Math.max(nextRank, rank + 1));
    }
    const group = groups.get(groupKey);
    if (!group.sos.has(row.soName)) {
      if (group.sos.size >= 3) continue;
      group.sos.set(row.soName, { name: row.soName, value: round2(row.soValue), functions: [] });
    }
    const functions = group.sos.get(row.soName).functions;
    if (functions.length >= 3 || functions.some((item) => item.name === row.functionName)) continue;
    functions.push({ name: row.functionName, value: round2(row.functionValue) });
  }
  for (const group of groups.values()) {
    const htId = `${scenarioId}-${group.dimension}-slot-${group.rank}`;
    statements.hotspotThread.run(htId, scenarioId, group.dimension, group.thread.id, group.rank, group.score || 0, group.threadName, group.threadType);
    [...group.sos.values()].slice(0, 3).forEach((so, soIndex) => {
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
