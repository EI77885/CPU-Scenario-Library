import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { categoryDirs, clusters, round } from "./data-common.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultSourceRoot = path.join(root, "source_data");
const summaryName = "trace_summary.json";
const traceProcessor = process.env.TRACE_PROCESSOR_SHELL || "trace_processor_shell";

const textTraceExtensions = new Set([".txt", ".trace", ".ftrace", ".atrace", ".systrace", ".hitrace", ".htrace", ".ohtrace", ".log", ".html"]);
const jsonTraceExtensions = new Set([".json"]);
const binaryTraceExtensions = new Set([".perfetto-trace", ".pftrace", ".pb", ".bin", ".ctrace"]);

function usage() {
  console.log(`Usage:
  node scripts/update-trace-summary.js [--source <source_data>] [--force] [--strict] [--trace-processor <path>]

Examples:
  node scripts/update-trace-summary.js
  node scripts/update-trace-summary.js --force
  node scripts/update-trace-summary.js --source D:\\cpu-scenario-library\\source_data
  node scripts/update-trace-summary.js --trace-processor D:\\tools\\trace_processor_shell.exe

The script scans each scenario's hitrace directory, reads raw Android/Harmony trace files,
and writes hitrace/trace_summary.json. Existing trace_summary.json is skipped when newer
than all raw trace files unless --force is used.`);
}

function parseArgs(argv) {
  const args = { sourceRoot: defaultSourceRoot, force: false, strict: false, traceProcessor };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") args.help = true;
    else if (item === "--force") args.force = true;
    else if (item === "--strict") args.strict = true;
    else if (item === "--source") args.sourceRoot = path.resolve(argv[++i] || "");
    else if (item === "--trace-processor") args.traceProcessor = path.resolve(argv[++i] || "");
    else throw new Error(`Unknown argument: ${item}`);
  }
  return args;
}

function clusterForCpu(cpu) {
  const value = Number(cpu);
  if (!Number.isFinite(value)) return clusters[0];
  if (value <= 3) return clusters[0];
  if (value <= 6) return clusters[1];
  return clusters[2];
}

function isSummaryFile(filePath) {
  return path.basename(filePath) === summaryName;
}

function stripGzipExtension(filePath) {
  return filePath.toLowerCase().endsWith(".gz") ? filePath.slice(0, -3) : filePath;
}

function traceKind(filePath) {
  const normalized = stripGzipExtension(filePath);
  const ext = path.extname(normalized).toLowerCase();
  if (jsonTraceExtensions.has(ext)) return "json";
  if (textTraceExtensions.has(ext)) return "text";
  if (binaryTraceExtensions.has(ext)) return "binary";
  return "";
}

function isTraceCandidate(filePath) {
  if (isSummaryFile(filePath)) return false;
  return Boolean(traceKind(filePath));
}

async function listFilesRecursive(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listFilesRecursive(fullPath));
    else if (entry.isFile()) out.push(fullPath);
  }
  return out;
}

async function discoverHitraceDirs(sourceRoot) {
  const dirs = [];
  for (const category of categoryDirs) {
    const categoryPath = path.join(sourceRoot, category.dir);
    let entries = [];
    try {
      entries = await fs.readdir(categoryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.filter((item) => item.isDirectory())) {
      dirs.push({
        scenarioId: `${category.dir}-${entry.name}`,
        scenarioName: entry.name,
        hitraceDir: path.join(categoryPath, entry.name, "hitrace"),
      });
    }
  }
  return dirs;
}

async function needsUpdate(summaryPath, traceFiles, force) {
  if (force) return true;
  let summaryStat;
  try {
    summaryStat = await fs.stat(summaryPath);
  } catch {
    return true;
  }
  for (const file of traceFiles) {
    const stat = await fs.stat(file);
    if (stat.mtimeMs > summaryStat.mtimeMs) return true;
  }
  return false;
}

function emptyAccumulator() {
  return {
    byCluster: new Map(),
    totalNsByCluster: new Map(),
    sourceFiles: [],
    warnings: [],
  };
}

function ensureCluster(acc, cluster) {
  if (!acc.byCluster.has(cluster)) {
    acc.byCluster.set(cluster, {
      runningNs: 0,
      processNs: new Map(),
      threadNs: new Map(),
      processThreadNs: new Map(),
    });
  }
  return acc.byCluster.get(cluster);
}

function addRunning(acc, cpu, processName, threadName, durNs) {
  const ns = Number(durNs);
  if (!Number.isFinite(ns) || ns <= 0) return;
  const cluster = clusterForCpu(cpu);
  const bucket = ensureCluster(acc, cluster);
  const process = cleanName(processName || threadName || "unknown_process");
  const thread = cleanName(threadName || processName || "unknown_thread");
  acc.totalNsByCluster.set(cluster, (acc.totalNsByCluster.get(cluster) || 0) + ns);
  if (isIdleThread(process) || isIdleThread(thread)) return;
  bucket.runningNs += ns;
  bucket.processNs.set(process, (bucket.processNs.get(process) || 0) + ns);
  bucket.threadNs.set(thread, (bucket.threadNs.get(thread) || 0) + ns);
  if (!bucket.processThreadNs.has(process)) bucket.processThreadNs.set(process, new Map());
  const processThreads = bucket.processThreadNs.get(process);
  processThreads.set(thread, (processThreads.get(thread) || 0) + ns);
}

function cleanName(value) {
  return String(value || "").trim() || "unknown";
}

function isIdleThread(name) {
  return /^(swapper|idle|<idle>|cpu_idle)(?:\/\d+)?$/iu.test(cleanName(name));
}

function numberFrom(value) {
  const match = String(value ?? "").replace(/,/gu, "").match(/-?\d+(?:\.\d+)?/u);
  return match ? Number(match[0]) : 0;
}

function nsFromTraceTimestamp(value) {
  return numberFrom(value) * 1000;
}

function extractTraceField(line, key) {
  const stopKeys = [
    "prev_comm",
    "prev_pid",
    "prev_prio",
    "prev_state",
    "next_comm",
    "next_pid",
    "next_prio",
    "cpu",
    "cpu_id",
    "ts",
    "timestamp",
  ].filter((item) => item !== key).join("|");
  const pattern = new RegExp(`${key}\\s*[:=]\\s*(.*?)(?=\\s+(?:${stopKeys})\\s*[:=]|\\s+==>|$)`, "iu");
  return cleanName(line.match(pattern)?.[1] || "");
}

function extractTraceCpu(line) {
  const bracketCpu = line.match(/\[(\d+)\]/u)?.[1];
  if (bracketCpu != null) return Number(bracketCpu);
  const keyCpu = line.match(/\bcpu(?:_id)?\s*[:=]\s*(\d+)\b/iu)?.[1];
  if (keyCpu != null) return Number(keyCpu);
  const compactCpu = line.match(/\bC(?:PU)?0*(\d+)\b/iu)?.[1];
  if (compactCpu != null) return Number(compactCpu);
  return 0;
}

function extractTraceTimestamp(line) {
  const keyTs = line.match(/\b(?:ts|timestamp)\s*[:=]\s*(\d+(?:\.\d+)?)/iu)?.[1];
  if (keyTs != null) return nsFromTraceTimestamp(keyTs);
  const beforeEvent = line.match(/(\d+(?:\.\d+)?)\s*:?\s+sched_switch\b/iu)?.[1];
  if (beforeEvent != null) return nsFromTraceTimestamp(beforeEvent);
  return 0;
}

function parseSchedSwitch(line) {
  if (!/\bsched_switch\b/iu.test(line)) return null;
  const nextComm = extractTraceField(line, "next_comm");
  const nextPid = numberFrom(extractTraceField(line, "next_pid"));
  const tsNs = extractTraceTimestamp(line);
  if (!nextComm || !tsNs) return null;
  return {
    cpu: extractTraceCpu(line),
    tsNs,
    nextComm,
    nextPid,
  };
}

function parseCpuFromTextEvent(event) {
  return event.args?.cpu ?? event.args?.cpu_id ?? event.cpu ?? event.cpu_id ?? event.tid ?? 0;
}

function normalizeJsonTrace(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.traceEvents)) return data.traceEvents;
  if (Array.isArray(data.events)) return data.events;
  return [];
}

async function readMaybeGzip(filePath, maxBytes = 300 * 1024 * 1024) {
  const stat = await fs.stat(filePath);
  if (stat.size > maxBytes) throw new Error(`file too large for direct JSON/text read (${stat.size} bytes)`);
  const raw = await fs.readFile(filePath);
  if (!filePath.toLowerCase().endsWith(".gz")) return raw.toString("utf8");
  return await new Promise((resolve, reject) => {
    const chunks = [];
    const stream = createGunzip();
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
    stream.end(raw);
  });
}

async function parseJsonTrace(filePath, acc) {
  const text = await readMaybeGzip(filePath);
  const data = JSON.parse(text);
  const events = normalizeJsonTrace(data);
  if (!events.length) throw new Error("no trace events found");

  const open = new Map();
  for (const event of events) {
    const ph = event.ph || event.type;
    const name = cleanName(event.name);
    const processName = cleanName(event.args?.process_name || event.args?.process || event.pid || name);
    const threadName = cleanName(event.args?.thread_name || event.args?.thread || event.tname || event.tid || name);
    if (ph === "X" && Number(event.dur) > 0) {
      addRunning(acc, parseCpuFromTextEvent(event), processName, threadName, Number(event.dur) * 1000);
    } else if (ph === "B") {
      open.set(`${event.pid}:${event.tid}:${name}`, event);
    } else if (ph === "E") {
      const keyPrefix = `${event.pid}:${event.tid}:`;
      const key = [...open.keys()].reverse().find((item) => item.startsWith(keyPrefix));
      if (key) {
        const start = open.get(key);
        open.delete(key);
        const durUs = Number(event.ts) - Number(start.ts);
        if (durUs > 0) addRunning(acc, parseCpuFromTextEvent(start), processName, threadName, durUs * 1000);
      }
    }
  }
}

async function parseTextTrace(filePath, acc) {
  const stateByCpu = new Map();
  const stream = filePath.toLowerCase().endsWith(".gz")
    ? createReadStream(filePath).pipe(createGunzip())
    : createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const event = parseSchedSwitch(line);
    if (!event) continue;
    const previous = stateByCpu.get(event.cpu);
    if (previous && event.tsNs > previous.tsNs) {
      addRunning(acc, event.cpu, previous.comm, previous.comm, event.tsNs - previous.tsNs);
    }
    stateByCpu.set(event.cpu, { tsNs: event.tsNs, comm: event.nextComm, pid: event.nextPid });
  }
}

function hasTraceProcessor(command) {
  try {
    execFileSync(command, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function parseTraceProcessorCsv(output) {
  const lines = output.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((item) => item.trim().replace(/^"|"$/gu, ""));
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((item) => item.trim().replace(/^"|"$/gu, ""));
    return Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""]));
  });
}

function runTraceProcessorQuery(command, filePath, query) {
  const attempts = [
    ["--query-string", query, "--query-result-format", "csv", filePath],
    ["--query-result-format", "csv", "--query-string", query, filePath],
    ["-q", query, "--query-result-format", "csv", filePath],
    [filePath, "--query-string", query, "--query-result-format", "csv"],
  ];
  let lastError;
  for (const args of attempts) {
    try {
      return execFileSync(command, args, {
        encoding: "utf8",
        maxBuffer: 100 * 1024 * 1024,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function parseBinaryTraceWithProcessor(filePath, acc, command) {
  if (!hasTraceProcessor(command)) throw new Error(`trace_processor_shell not found: ${command}`);
  const query = `
SELECT
  cpu,
  COALESCE(process.name, thread.name, 'unknown_process') AS process_name,
  COALESCE(thread.name, 'unknown_thread') AS thread_name,
  SUM(dur) AS dur_ns
FROM sched
JOIN thread USING(utid)
LEFT JOIN process USING(upid)
WHERE dur > 0
GROUP BY cpu, process_name, thread_name
ORDER BY cpu, dur_ns DESC;`;
  const output = runTraceProcessorQuery(command, filePath, query);
  const rows = parseTraceProcessorCsv(output);
  if (!rows.length) throw new Error("trace_processor_shell returned no sched rows");
  for (const row of rows) addRunning(acc, row.cpu, row.process_name, row.thread_name, Number(row.dur_ns));
}

async function parseTraceFile(filePath, acc, args) {
  const kind = traceKind(filePath);
  acc.sourceFiles.push(path.basename(filePath));
  if (kind === "json") await parseJsonTrace(filePath, acc);
  else if (kind === "text") await parseTextTrace(filePath, acc);
  else if (kind === "binary") await parseBinaryTraceWithProcessor(filePath, acc, args.traceProcessor);
  else throw new Error("unsupported trace file type");
}

function selectTop80(map, runningNs) {
  const runningTotal = Math.max(runningNs, 1);
  const sorted = [...map.entries()]
    .filter(([, value]) => value > 0)
    .sort((a, b) => b[1] - a[1]);
  const selected = [];
  let includedRunning = 0;
  for (const [name, value] of sorted) {
    const runningShare = value / runningTotal;
    if (selected.length < 5 && includedRunning < 0.8) {
      selected.push({ name, ns: value });
      includedRunning += runningShare;
    }
  }
  const selectedNs = selected.reduce((sum, item) => sum + item.ns, 0);
  return { selected, selectedNs, otherNs: Math.max(0, runningNs - selectedNs) };
}

function percentItems(selected, totalNs) {
  const total = Math.max(totalNs, 1);
  return selected.map((item) => ({ name: item.name, value: round((item.ns / total) * 100) }));
}

function topProcessItems(bucket, totalNs, idle) {
  const processSelection = selectTop80(bucket.processNs, bucket.runningNs);
  const out = percentItems(processSelection.selected, totalNs);
  if (processSelection.otherNs > 0) out.push({ name: "other process", value: round((processSelection.otherNs / Math.max(totalNs, 1)) * 100) });
  out.push({ name: "idle", value: idle });
  return { items: out, selectedProcesses: processSelection.selected, selectedProcessNs: processSelection.selectedNs, otherProcessNs: processSelection.otherNs };
}

function inheritedThreadItems(bucket, totalNs, processSelection, idle) {
  const threadMap = new Map();
  for (const process of processSelection.selectedProcesses) {
    const processThreads = bucket.processThreadNs.get(process.name) || new Map();
    for (const [thread, ns] of processThreads) {
      threadMap.set(thread, (threadMap.get(thread) || 0) + ns);
    }
  }
  const threadSelection = selectTop80(threadMap, processSelection.selectedProcessNs);
  const out = percentItems(threadSelection.selected, totalNs);
  if (threadSelection.otherNs > 0) out.push({ name: "other thread", value: round((threadSelection.otherNs / Math.max(totalNs, 1)) * 100) });
  if (processSelection.otherProcessNs > 0) out.push({ name: "other process", value: round((processSelection.otherProcessNs / Math.max(totalNs, 1)) * 100) });
  out.push({ name: "idle", value: idle });
  return out;
}

function buildSummary(acc, scenarioId) {
  const clusterOverview = [];
  const processOverview = [];
  const threadOverview = [];
  for (const cluster of clusters) {
    const bucket = ensureCluster(acc, cluster);
    const totalNs = acc.totalNsByCluster.get(cluster) || bucket.runningNs;
    const running = totalNs > 0 ? round((bucket.runningNs / totalNs) * 100) : 0;
    const idle = round(Math.max(0, 100 - running));
    clusterOverview.push({ cluster, running, idle });
    const processSelection = topProcessItems(bucket, totalNs, idle);
    processOverview.push({
      cluster,
      items: processSelection.items,
    });
    threadOverview.push({
      cluster,
      items: inheritedThreadItems(bucket, totalNs, processSelection, idle),
    });
  }
  return {
    scenarioId,
    generatedAt: new Date().toISOString(),
    parser: {
      name: "update-trace-summary",
      sourceFiles: acc.sourceFiles,
      notes: [
        "CPU cluster mapping defaults to CPU0-3=小核, CPU4-6=中核, CPU7+=大核.",
        "Text trace parsing uses sched_switch events; binary Perfetto parsing requires trace_processor_shell.",
      ],
    },
    clusterOverview,
    processOverview,
    threadOverview,
  };
}

async function processHitraceDir(item, args) {
  const files = (await listFilesRecursive(item.hitraceDir)).filter(isTraceCandidate);
  const summaryPath = path.join(item.hitraceDir, summaryName);
  if (!files.length) return { status: "skipped", scenarioId: item.scenarioId, message: "no raw trace files" };
  if (!await needsUpdate(summaryPath, files, args.force)) return { status: "skipped", scenarioId: item.scenarioId, message: "trace_summary.json is up to date" };

  const acc = emptyAccumulator();
  for (const file of files) {
    try {
      await parseTraceFile(file, acc, args);
    } catch (error) {
      acc.warnings.push(`${path.basename(file)}: ${error.message}`);
      if (args.strict) throw error;
    }
  }
  const hasData = [...acc.byCluster.values()].some((bucket) => bucket.runningNs > 0);
  if (!hasData) {
    const message = acc.warnings.length ? acc.warnings.join("; ") : "no sched/running data parsed";
    return { status: "failed", scenarioId: item.scenarioId, message };
  }
  const summary = buildSummary(acc, item.scenarioId);
  if (acc.warnings.length) summary.parser.warnings = acc.warnings;
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { status: "updated", scenarioId: item.scenarioId, message: summaryPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const hitraceDirs = await discoverHitraceDirs(args.sourceRoot);
  const results = [];
  for (const item of hitraceDirs) {
    try {
      results.push(await processHitraceDir(item, args));
    } catch (error) {
      results.push({ status: "failed", scenarioId: item.scenarioId, message: error.message });
      if (args.strict) throw error;
    }
  }
  const updated = results.filter((item) => item.status === "updated");
  const skipped = results.filter((item) => item.status === "skipped");
  const failed = results.filter((item) => item.status === "failed");
  console.log(`Trace summary update: ${updated.length} updated, ${skipped.length} skipped, ${failed.length} failed`);
  for (const item of [...updated, ...failed]) console.log(`${item.status}: ${item.scenarioId} - ${item.message}`);
  if (failed.length && args.strict) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
