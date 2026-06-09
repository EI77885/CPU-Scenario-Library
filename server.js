import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  clusters,
  filterFields,
  instructionEvents,
  syscallPool,
  topdownLevel1,
  topdownNodes,
} from "./scripts/data-common.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(root, "data", "cpu_scenario_library.sqlite");
const port = Number(process.env.PORT || 5173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
};
const NA = "NA";

function dbExists() {
  return fs.existsSync(dbPath);
}

function localNetworkUrls(portNumber) {
  const urls = new Set();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal) continue;
      urls.add(`http://${address.address}:${portNumber}/`);
    }
  }
  return [...urls];
}

function withDb(callback) {
  if (!dbExists()) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function all(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function getBaseScenarios(db, filters = {}) {
  const clauses = [];
  const params = [];
  const fieldMap = {
    type: "type",
    name: "name",
    appVersion: "app_version",
    platform: "platform",
    imageVersion: "image_version",
  };
  for (const [key, column] of Object.entries(fieldMap)) {
    if (filters[key]) {
      clauses.push(`${column} = ?`);
      params.push(filters[key]);
    }
  }
  const sql = `SELECT * FROM scenarios${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id`;
  return all(db, sql, params).map(baseFromRow);
}

function baseFromRow(row) {
  return {
    id: row.id,
    base: {
      type: row.type,
      name: row.name,
      appVersion: row.app_version,
      description: row.description,
      config: row.config,
      platform: row.platform,
      imageVersion: row.image_version,
      archivePath: row.archive_path,
    },
  };
}

function scenarioFull(db, scenarioId) {
  const scenario = baseFromRow(db.prepare("SELECT * FROM scenarios WHERE id = ?").get(scenarioId));
  const threads = all(db, "SELECT * FROM threads WHERE scenario_id = ? ORDER BY rank", [scenarioId]).map((row) => ({
    id: row.id,
    name: row.name,
    threadType: row.thread_type,
    loadShare: round2(row.load_share),
  }));
  const displayThreads = threads.length ? threads : defaultDisplayThreads(scenarioId, scenario.base.name);
  const topdownThreads = limitedModuleThreads(db, "topdown_metrics", displayThreads, scenario.base.type === "冷启动");
  const instructionThreads = limitedModuleThreads(db, "instruction_metrics", displayThreads, scenario.base.type === "冷启动");
  const syscallThreads = limitedModuleThreads(db, "syscall_metrics", displayThreads, scenario.base.type === "冷启动");
  const hizeeScene = db.prepare("SELECT * FROM hizee_scene WHERE scenario_id = ?").get(scenarioId) || {};
  const hizeeClusters = all(db, "SELECT * FROM hizee_clusters WHERE scenario_id = ? ORDER BY rowid", [scenarioId]);
  return {
    ...scenario,
    loadInfo: {
      clusterRunning: buildClusterRunning(db, scenarioId),
      processRunning: buildLoadStacks(db, scenarioId, "load_process", "未识别进程"),
      threadRunning: buildLoadStacks(db, scenarioId, "load_thread", "未识别线程"),
      hizeeRows: ["所有进程", "UI进程", "render service"].map((scope, index) => ({
        scope,
        littleRunning: runningForScope(hizeeClusters[0], index),
        midRunning: runningForScope(hizeeClusters[1], index),
        bigRunning: runningForScope(hizeeClusters[2], index),
        littleFreq: valueOrNA(hizeeClusters[0], "avg_freq_mhz"),
        midFreq: valueOrNA(hizeeClusters[1], "avg_freq_mhz"),
        bigFreq: valueOrNA(hizeeClusters[2], "avg_freq_mhz"),
        fps: valueOrNA(hizeeScene, "fps"),
        ddrFreq: valueOrNA(hizeeScene, "ddr_freq_mhz"),
        bandwidth: valueOrNA(hizeeScene, "bandwidth"),
        latency: valueOrNA(hizeeScene, "latency"),
      })),
    },
    topdownInfo: topdownThreads.map((thread) => buildTopdown(db, thread)),
    instructionMix: instructionThreads.map((thread) => buildInstruction(db, thread, scenario.base.type === "冷启动")),
    syscallInfo: syscallThreads.map((thread) => buildSyscall(db, thread)),
    hotspotInfo: {
      cycle: buildHotspots(db, scenarioId, "cycle", displayThreads),
      fe: buildHotspots(db, scenarioId, "fe", displayThreads),
      be: buildHotspots(db, scenarioId, "be", displayThreads),
    },
  };
}

function limitedModuleThreads(db, table, threads, requireRows = false) {
  const source = requireRows
    ? threads.filter((thread) => db.prepare(`SELECT 1 FROM ${table} WHERE thread_id = ? LIMIT 1`).get(thread.id))
    : threads;
  return source.slice(0, 3);
}

function defaultDisplayThreads(scenarioId, scenarioName) {
  return [
    { id: `${scenarioId}-missing-main`, name: `${scenarioName}_未识别主线程`, threadType: "main", loadShare: NA },
    { id: `${scenarioId}-missing-render`, name: `${scenarioName}_未识别渲染线程`, threadType: "render", loadShare: NA },
    { id: `${scenarioId}-missing-other`, name: `${scenarioName}_未识别其他线程`, threadType: "other", loadShare: NA },
  ];
}

function runningForScope(row, index) {
  if (!row) return NA;
  return valueAtOrNA([row.all_process_running, row.ui_process_running, row.render_service_running][index]);
}

function buildClusterRunning(db, scenarioId) {
  const rows = all(db, "SELECT * FROM load_cluster WHERE scenario_id = ? ORDER BY rowid", [scenarioId]);
  return clusters.map((cluster, index) => {
    const row = rows.find((item) => item.cluster === cluster) || rows[index];
    return { name: cluster, value: row ? valueAtOrNA(row.running) : NA };
  });
}

function buildLoadStacks(db, scenarioId, table, missingLabel) {
  return clusters.map((cluster) => {
    const items = all(db, `SELECT name, value FROM ${table} WHERE scenario_id = ? AND cluster = ? ORDER BY rank`, [scenarioId, cluster]).map(roundValueRow);
    return {
      cluster,
      items: items.length ? items : [{ name: `${missingLabel}(${cluster})`, value: NA }],
    };
  });
}

function round2(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function valueAtOrNA(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NA;
}

function preciseValueAtOrNA(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NA;
}

function valueOrNA(row, key) {
  return row && Object.hasOwn(row, key) ? valueAtOrNA(row[key]) : NA;
}

function isNA(value) {
  return value === NA || value == null || value === "";
}

function toMetricNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundValueRow(row) {
  return row ? { ...row, value: valueAtOrNA(row.value) } : { value: NA };
}

function normalizeThreadKey(name) {
  return String(name || "")
    .normalize("NFKC")
    .trim()
    .replace(/线程$/u, "")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}

function sameThreadName(a, b) {
  return normalizeThreadKey(a?.name)
    && normalizeThreadKey(a?.name) === normalizeThreadKey(b?.name)
    && threadEntityKind(a) === threadEntityKind(b);
}

function threadCategory(thread) {
  return ["main", "render", "other"].includes(thread?.threadType) ? thread.threadType : "other";
}

function threadEntityKind(thread) {
  return /进程|process/iu.test(thread?.threadType || "") ? "process" : "thread";
}

function threadLoadShare(thread) {
  return valueAtOrNA(thread?.loadShare);
}

function buildTopdown(db, thread) {
  const rows = all(db, "SELECT * FROM topdown_metrics WHERE thread_id = ?", [thread.id]);
  const meta = db.prepare("SELECT * FROM topdown_thread_meta WHERE thread_id = ?").get(thread.id);
  const valueFor = (scope, metric, level = null) => {
    const row = rows.find((item) => item.scope === scope && item.metric === metric && (level == null || item.level === level));
    return row ? valueAtOrNA(row.value) : NA;
  };
  const level1 = (scope) => Object.fromEntries(topdownLevel1.map((metric) => [metric, valueFor(scope, metric, 1)]));
  return {
    name: thread.name,
    threadType: thread.threadType,
    loadShare: threadLoadShare(thread),
    kernelInstShare: valueOrNA(meta, "kernel_inst_share"),
    kernelCycleShare: valueOrNA(meta, "kernel_cycle_share"),
    total: { level1: level1("total"), hierarchy: buildHierarchy(rows, valueFor) },
    kernel: { level1: level1("kernel") },
  };
}

function buildHierarchy(rows, valueFor) {
  const groupNames = ["MPKI", "FE BOUND", "BE BOUND", "LINX MEMSTALL PKI", "CACHE REFILL PKI", "TLB REFILL & PREFETCH PKI"];
  return groupNames.map((metric) => {
    const level2Names = topdownNodes.filter((name) => topdownLevel(name, topdownParent(name)) === 2 && topdownParent(name) === metric);
    const level2 = level2Names.map((name) => ({
      name,
      value: valueFor("total", name, 2),
      level3: topdownNodes
        .filter((child) => topdownLevel(child, topdownParent(child)) === 3 && topdownParent(child) === name)
        .map((child) => ({ name: child, value: valueFor("total", child, 3) })),
    }));
    return { metric, unit: metric === "MPKI" ? "PKI" : "PKI", kind: metric.includes("PKI") && !["MPKI", "FE BOUND", "BE BOUND"].includes(metric) ? "diagnostic" : "", level2 };
  }).filter((group) => group.level2.length || rows.some((row) => row.scope === "total" && row.parent === group.metric));
}

function buildInstruction(db, thread, coldStart = false) {
  const rows = all(db, "SELECT * FROM instruction_metrics WHERE thread_id = ?", [thread.id]);
  const valueFor = (scope, event) => {
    const row = rows.find((item) => item.scope === scope && item.event === event);
    return row ? preciseValueAtOrNA(row.value) : NA;
  };
  const loadShare = coldStart && threadEntityKind(thread) === "process" ? NA : threadLoadShare(thread);
  return {
    name: thread.name,
    threadType: thread.threadType,
    loadShare,
    total: instructionEvents.map((event) => ({ name: event, value: valueFor("total", event) })),
    kernel: instructionEvents.map((event) => ({ name: event, value: valueFor("kernel", event) })),
  };
}

function buildSyscall(db, thread) {
  const metric = db.prepare("SELECT density FROM syscall_metrics WHERE thread_id = ?").get(thread.id);
  const calls = all(db, "SELECT name, share AS value FROM syscall_top WHERE thread_id = ? ORDER BY rank", [thread.id]).map(roundValueRow);
  return {
    name: thread.name,
    threadType: thread.threadType,
    loadShare: threadLoadShare(thread),
    density: metric ? valueAtOrNA(metric.density) : NA,
    calls: calls.length ? calls : [{ name: `未识别系统调用(${thread.name || "未知线程"})`, value: NA }],
  };
}

function buildHotspots(db, scenarioId, dimension, threads) {
  const rows = all(db, "SELECT * FROM hotspot_threads WHERE scenario_id = ? AND dimension = ? ORDER BY rank", [scenarioId, dimension]);
  const builtRows = normalizeHotspotDuplicateThreadTypes(rows.map((row) => {
    const fallbackThread = threads.find((item) => item.id === row.thread_id) || threads.find((item) => sameThreadName(item, row)) || {};
    const thread = {
      name: row.name || fallbackThread.name,
      threadType: row.thread_type || fallbackThread.threadType,
      loadShare: valueAtOrNA(row.score),
    };
    const sos = all(db, "SELECT * FROM hotspot_sos WHERE hotspot_thread_id = ? ORDER BY rank LIMIT 3", [row.id]).map((so) => {
      const funcs = all(db, "SELECT name, value FROM hotspot_functions WHERE hotspot_so_id = ? ORDER BY rank LIMIT 3", [so.id]).map(roundValueRow);
      return {
        name: so.name || missingHotspotName(dimension, thread, "so"),
        value: valueAtOrNA(so.value),
        funcs: funcs.length ? funcs : [missingHotspotFunction(dimension, thread, so.name)],
      };
    });
    return {
      name: thread.name,
      threadType: thread.threadType,
      loadShare: threadLoadShare(thread),
      score: valueAtOrNA(row.score),
      sos: sos.length ? sos : [missingHotspotSo(dimension, thread)],
    };
  })).slice(0, 3);
  const seenThreads = new Set(builtRows.map((row) => normalizeThreadKey(row.name)));
  const missingRows = threads
    .filter((thread) => !seenThreads.has(normalizeThreadKey(thread.name)))
    .slice(0, Math.max(0, 3 - builtRows.length))
    .map((thread) => missingHotspotThread(dimension, thread));
  return [...builtRows, ...missingRows].slice(0, 3);
}

function normalizeHotspotDuplicateThreadTypes(rows) {
  const byName = new Map();
  rows.forEach((row) => {
    const key = normalizeThreadKey(row.name);
    if (!key) return;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  });
  for (const group of byName.values()) {
    if (group.length <= 1) continue;
    const primary = group.reduce((best, row) => (toMetricNumber(row.score) ?? -1) > (toMetricNumber(best.score) ?? -1) ? row : best, group[0]);
    group.forEach((row) => {
      row.threadType = row === primary ? "main" : "other";
    });
  }
  return rows;
}

function missingHotspotThread(dimension, thread) {
  return {
    name: thread.name,
    threadType: thread.threadType,
    loadShare: threadLoadShare(thread),
    score: NA,
    sos: [missingHotspotSo(dimension, thread)],
  };
}

function missingHotspotSo(dimension, thread) {
  return {
    name: missingHotspotName(dimension, thread, "so"),
    value: NA,
    funcs: [missingHotspotFunction(dimension, thread)],
  };
}

function missingHotspotFunction(dimension, thread, soName = "") {
  const soPart = soName ? ` / ${soName}` : "";
  return { name: `未识别函数(${hotspotDimensionLabel(dimension)} / ${thread.name || "未知线程"}${soPart})`, value: NA };
}

function missingHotspotName(dimension, thread, kind) {
  const label = kind === "so" ? "未识别SO" : "未识别函数";
  return `${label}(${hotspotDimensionLabel(dimension)} / ${thread.name || "未知线程"})`;
}

function hotspotDimensionLabel(dimension) {
  return { cycle: "Cycle 热点", fe: "FE 瓶颈", be: "BE 瓶颈" }[dimension] || dimension;
}

function buildFeatures(db) {
  const processNames = topNames(db, "load_process", "name", "name NOT IN ('idle', 'other', 'other process')", 5);
  const threadNames = topNames(db, "load_thread", "name", "name NOT IN ('idle', 'other thread', 'other process')", 5);
  const syscallNames = [...new Set([...topNames(db, "syscall_top", "name", "name != 'others'", 15), ...syscallPool])];
  const hotspotFeatures = ["cycle", "fe", "be"].flatMap((dimension) => {
    const label = { cycle: "Cycle 热点", fe: "FE BOUND", be: "BE BOUND" }[dimension];
    return [
      ...topHotspotNames(db, dimension, "so").map((name) => feature(`hotspot.${dimension}.so.${encodeURIComponent(name)}`, `${label} SO ${name} 占比`, "%", "hotspot", "thread")),
      ...topHotspotNames(db, dimension, "func").map((name) => feature(`hotspot.${dimension}.func.${encodeURIComponent(name)}`, `${label} 函数 ${name} 占比`, "%", "hotspot", "thread")),
    ];
  });
  return [
    ...clusters.flatMap((cluster, index) => [
      feature(`cluster.${index}.running`, `${cluster} running 占比`, "%", "load", "scenario"),
      feature(`cluster.${index}.idle`, `${cluster} idle 占比`, "%", "load", "scenario"),
    ]),
    ...processNames.map((name) => feature(`process.${name}`, `process overview ${name} 负载`, "%", "load", "scenario")),
    ...threadNames.map((name) => feature(`threadload.${name}`, `thread overview ${name} 负载`, "%", "load", "scenario")),
    feature("hizee.scene.fps", "Hizee 场景 平均帧率", "fps", "load", "scenario"),
    feature("hizee.scene.ddrFreq", "Hizee 场景 DDR 平均频率", "Mhz", "load", "scenario"),
    feature("hizee.scene.bandwidth", "Hizee 场景 平均带宽", "GB/s", "load", "scenario"),
    feature("hizee.scene.latency", "Hizee 场景 平均 latency", "ns", "load", "scenario"),
    feature("hizee.freq.littleFreq", "Hizee 小核 cluster 平均频率", "Mhz", "load", "scenario"),
    feature("hizee.freq.midFreq", "Hizee 中核 cluster 平均频率", "Mhz", "load", "scenario"),
    feature("hizee.freq.bigFreq", "Hizee 大核 cluster 平均频率", "Mhz", "load", "scenario"),
    ...["所有进程", "UI进程", "render service"].flatMap((scope, scopeIndex) => [
      feature(`hizee.running.${scopeIndex}.littleRunning`, `Hizee 小核 cluster ${scope} running占比`, "%", "load", "scenario"),
      feature(`hizee.running.${scopeIndex}.midRunning`, `Hizee 中核 cluster ${scope} running占比`, "%", "load", "scenario"),
      feature(`hizee.running.${scopeIndex}.bigRunning`, `Hizee 大核 cluster ${scope} running占比`, "%", "load", "scenario"),
    ]),
    ...topdownLevel1.flatMap((metric) => [
      feature(`topdown.level1.total.${metric}`, `Topdown 总体 ${metric}`, metric === "IPC" ? "" : "PKI", "topdown", "thread"),
      feature(`topdown.level1.kernel.${metric}`, `Topdown 内核 ${metric}`, metric === "IPC" ? "" : "PKI", "topdown", "thread"),
    ]),
    ...topdownNodes.map((name) => feature(`topdown.node.${name}`, `Topdown ${name}`, "PKI", "topdown", "thread")),
    ...instructionEvents.flatMap((event) => [
      feature(`inst.total.${event}`, `指令分布 总体 ${event}`, "PKI", "instruction", "thread"),
      feature(`inst.kernel.${event}`, `指令分布 内核 ${event}`, "PKI", "instruction", "thread"),
    ]),
    feature("syscall.density", "系统调用密度", "条/千万条指令", "syscall", "thread"),
    ...syscallNames.map((name) => feature(`syscall.share.${name}`, `系统调用 ${name} 占比`, "%", "syscall", "thread")),
    ...hotspotFeatures,
  ];
}

function feature(key, label, unit, category, scope) {
  return { key, label, unit, category, type: scope === "thread" ? "thread" : "load", scope };
}

function topNames(db, table, column, where, limit) {
  return all(db, `SELECT ${column} AS name, COUNT(*) AS n FROM ${table} WHERE ${where} GROUP BY ${column} ORDER BY n DESC, name ASC LIMIT ?`, [limit]).map((row) => row.name);
}

function topHotspotNames(db, dimension, kind) {
  const sql = kind === "so"
    ? "SELECT s.name AS name, COUNT(*) AS n FROM hotspot_sos s JOIN hotspot_threads h ON h.id = s.hotspot_thread_id WHERE h.dimension = ? GROUP BY s.name ORDER BY n DESC, s.name ASC LIMIT 5"
    : "SELECT f.name AS name, COUNT(*) AS n FROM hotspot_functions f JOIN hotspot_sos s ON s.id = f.hotspot_so_id JOIN hotspot_threads h ON h.id = s.hotspot_thread_id WHERE h.dimension = ? GROUP BY f.name ORDER BY n DESC, f.name ASC LIMIT 5";
  return all(db, sql, [dimension]).map((row) => row.name);
}

function bootstrap(db) {
  const ids = all(db, "SELECT id FROM scenarios ORDER BY id").map((row) => row.id);
  return { scenarios: ids.map((id) => scenarioFull(db, id)), filterFields, trendMetrics: buildFeatures(db) };
}

function trendResponse(db, query) {
  const featureKey = query.get("featureKey") || buildFeatures(db)[0]?.key;
  const featureMeta = buildFeatures(db).find((item) => item.key === featureKey) || buildFeatures(db)[0];
  const threadTypes = new Set((query.get("threadTypes") || "main,render,other").split(",").filter(Boolean));
  const filters = Object.fromEntries(["type", "name", "appVersion", "platform", "imageVersion"].map((key) => [key, query.get(key)]).filter(([, value]) => value));
  const scenarios = getBaseScenarios(db, filters).map((scenario) => scenarioFull(db, scenario.id));
  const rows = scenarios.flatMap((scenario) => {
    if (featureMeta.scope !== "thread") {
      return [{ scenarioId: scenario.id, scenarioName: scenario.base.name, platform: scenario.base.platform, value: metricValue(scenario, featureKey) }];
    }
    return scenario.topdownInfo
      .filter((thread) => threadTypes.has(threadCategory(thread)))
      .map((thread) => ({
        scenarioId: scenario.id,
        scenarioName: scenario.base.name,
        platform: scenario.base.platform,
        threadName: thread.name,
        threadType: thread.threadType,
        dimension: hotspotDimension(featureKey),
        value: metricValue(scenario, featureKey, thread),
      }));
  }).sort((a, b) => (toMetricNumber(b.value) ?? -1) - (toMetricNumber(a.value) ?? -1));
  const validValues = rows.map((row) => toMetricNumber(row.value)).filter((value) => value != null);
  return {
    feature: featureMeta,
    average: validValues.length ? round2(validValues.reduce((sum, value) => sum + value, 0) / validValues.length) : NA,
    rows,
  };
}

function metricValue(scenario, key, thread) {
  if (key.startsWith("cluster.")) {
    const [, index, stateName] = key.split(".");
    const running = metricValueOrNA(scenario.loadInfo.clusterRunning[Number(index)]?.value);
    if (isNA(running)) return NA;
    return stateName === "idle" ? round2(100 - running) : round2(running);
  }
  if (key.startsWith("process.")) {
    const name = key.slice("process.".length);
    return avg(scenario.loadInfo.processRunning.map((row) => row.items.find((item) => item.name === name)?.value));
  }
  if (key.startsWith("threadload.")) {
    const name = key.slice("threadload.".length);
    return avg(scenario.loadInfo.threadRunning.map((row) => row.items.find((item) => item.name === name)?.value));
  }
  if (key.startsWith("hizee.scene.")) return metricValueOrNA(scenario.loadInfo.hizeeRows[0]?.[key.split(".")[2]]);
  if (key.startsWith("hizee.freq.")) return metricValueOrNA(scenario.loadInfo.hizeeRows[0]?.[key.split(".")[2]]);
  if (key.startsWith("hizee.running.")) {
    const [, , rowIndex, field] = key.split(".");
    return metricValueOrNA(scenario.loadInfo.hizeeRows[Number(rowIndex)]?.[field]);
  }
  if (!thread) return NA;
  if (key.startsWith("topdown.level1.")) {
    const [, , scope, metric] = key.split(".");
    return metricValueOrNA(thread[scope]?.level1?.[metric]);
  }
  if (key.startsWith("topdown.node.")) return findTopdownNodeValue(thread.total?.hierarchy || [], key.slice("topdown.node.".length));
  if (key.startsWith("inst.")) {
    const [, scope, event] = key.split(".");
    const source = scenario.instructionMix.find((item) => sameThreadName(item, thread));
    return metricValueOrNA(source?.[scope]?.find((item) => item.name === event)?.value);
  }
  if (key === "syscall.density") {
    return metricValueOrNA(scenario.syscallInfo.find((item) => sameThreadName(item, thread))?.density);
  }
  if (key.startsWith("syscall.share.")) {
    const name = key.slice("syscall.share.".length);
    const source = scenario.syscallInfo.find((item) => sameThreadName(item, thread));
    return metricValueOrNA(source?.calls.find((item) => item.name === name)?.value);
  }
  if (key.startsWith("hotspot.")) {
    const [, dimension, kind, encodedName] = key.split(".");
    const targetName = decodeURIComponent(encodedName);
    const source = scenario.hotspotInfo[dimension]?.find((item) => sameThreadName(item, thread));
    if (!source) return NA;
    if (kind === "so") return metricValueOrNA(source.sos.find((so) => so.name === targetName)?.value);
    const values = source.sos
      .flatMap((so) => so.funcs.filter((fn) => fn.name === targetName).map((fn) => toMetricNumber(fn.value)))
      .filter((value) => value != null);
    return values.length ? Math.max(...values) : NA;
  }
  return NA;
}

function avg(values) {
  const validValues = values.map((value) => toMetricNumber(value)).filter((value) => value != null);
  return validValues.length ? round2(validValues.reduce((sum, value) => sum + value, 0) / validValues.length) : NA;
}

function findTopdownNodeValue(groups, name) {
  for (const group of groups) {
    for (const level2 of group.level2 || []) {
      if (level2.name === name) return level2.value;
      const level3 = level2.level3?.find((item) => item.name === name);
      if (level3) return level3.value;
    }
  }
  return NA;
}

function metricValueOrNA(value) {
  return isNA(value) ? NA : value;
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

function hotspotDimension(key) {
  if (!key.startsWith("hotspot.")) return "";
  return { cycle: "Cycle 热点", fe: "FE BOUND", be: "BE BOUND" }[key.split(".")[1]] || "";
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function handleApi(req, res, url) {
  const result = withDb((db) => {
    if (url.pathname === "/api/bootstrap") return bootstrap(db);
    if (url.pathname === "/api/features") return buildFeatures(db);
    if (url.pathname === "/api/features/trend") return trendResponse(db, url.searchParams);
    if (url.pathname === "/api/scenarios") {
      const filters = Object.fromEntries(["type", "name", "appVersion", "platform", "imageVersion"].map((key) => [key, url.searchParams.get(key)]).filter(([, value]) => value));
      return getBaseScenarios(db, filters).map((scenario) => ({ id: scenario.id, ...scenario.base }));
    }
    if (url.pathname === "/api/scenarios/compare") {
      const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
      const selected = ids.length ? ids : all(db, "SELECT id FROM scenarios ORDER BY id LIMIT 3").map((row) => row.id);
      return selected.map((id) => scenarioFull(db, id));
    }
    return undefined;
  });
  if (result === null) return sendJson(res, 503, { error: "Database is not ready. Run scripts/generate-source-data.js and scripts/import-source-data.js first." });
  if (result === undefined) return sendJson(res, 404, { error: "Not found" });
  return sendJson(res, 200, result);
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      try {
        handleApi(req, res, url);
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
      return;
    }
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = path.join(root, requested);
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": types[path.extname(filePath)] || "text/plain; charset=utf-8",
      });
      res.end(data);
    });
  });

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`端口 ${port} 已被占用。请先结束旧的 node server.js 进程，或使用 PORT=其他端口 node server.js 启动。`);
    process.exit(1);
  }
  throw error;
});

server.listen(port, "0.0.0.0", () => {
  console.log(`CPU 场景库 Dashboard 已启动`);
  console.log(`本机访问: http://localhost:${port}/`);
  const networkUrls = localNetworkUrls(port);
  if (networkUrls.length) {
    console.log(`局域网访问地址:`);
    networkUrls.forEach((url) => console.log(`  ${url}`));
  } else {
    console.log(`未检测到可用的局域网 IPv4 地址，请确认目标环境已连接内部网络。`);
  }
});
