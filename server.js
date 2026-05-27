import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  clusters,
  filterFields,
  instructionEvents,
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

function dbExists() {
  return fs.existsSync(dbPath);
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
  const hizeeScene = db.prepare("SELECT * FROM hizee_scene WHERE scenario_id = ?").get(scenarioId) || {};
  const hizeeClusters = all(db, "SELECT * FROM hizee_clusters WHERE scenario_id = ? ORDER BY rowid", [scenarioId]);
  return {
    ...scenario,
    loadInfo: {
      clusterRunning: all(db, "SELECT * FROM load_cluster WHERE scenario_id = ? ORDER BY rowid", [scenarioId]).map((row) => ({ name: row.cluster, value: round2(row.running) })),
      processRunning: clusters.map((cluster) => ({
        cluster,
        items: all(db, "SELECT name, value FROM load_process WHERE scenario_id = ? AND cluster = ? ORDER BY rank", [scenarioId, cluster]).map(roundValueRow),
      })),
      threadRunning: clusters.map((cluster) => ({
        cluster,
        items: all(db, "SELECT name, value FROM load_thread WHERE scenario_id = ? AND cluster = ? ORDER BY rank", [scenarioId, cluster]).map(roundValueRow),
      })),
      hizeeRows: ["所有进程", "UI进程", "render service"].map((scope, index) => ({
        scope,
        littleRunning: runningForScope(hizeeClusters[0], index),
        midRunning: runningForScope(hizeeClusters[1], index),
        bigRunning: runningForScope(hizeeClusters[2], index),
        littleFreq: round2(hizeeClusters[0]?.avg_freq_mhz),
        midFreq: round2(hizeeClusters[1]?.avg_freq_mhz),
        bigFreq: round2(hizeeClusters[2]?.avg_freq_mhz),
        fps: round2(hizeeScene.fps),
        ddrFreq: round2(hizeeScene.ddr_freq_mhz),
        bandwidth: round2(hizeeScene.bandwidth),
        latency: round2(hizeeScene.latency),
      })),
    },
    topdownInfo: threads.map((thread) => buildTopdown(db, thread)),
    instructionMix: threads.map((thread) => buildInstruction(db, thread)),
    syscallInfo: threads.map((thread) => buildSyscall(db, thread)),
    hotspotInfo: {
      cycle: buildHotspots(db, scenarioId, "cycle", threads),
      fe: buildHotspots(db, scenarioId, "fe", threads),
      be: buildHotspots(db, scenarioId, "be", threads),
    },
  };
}

function runningForScope(row, index) {
  if (!row) return 0;
  return round2([row.all_process_running, row.ui_process_running, row.render_service_running][index]);
}

function round2(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

function roundValueRow(row) {
  return { ...row, value: round2(row.value) };
}

function buildTopdown(db, thread) {
  const rows = all(db, "SELECT * FROM topdown_metrics WHERE thread_id = ?", [thread.id]);
  const level1 = (scope) => Object.fromEntries(topdownLevel1.map((metric) => [metric, round2(rows.find((row) => row.scope === scope && row.level === 1 && row.metric === metric)?.value)]));
  return {
    name: thread.name,
    threadType: thread.threadType,
    loadShare: round2(thread.loadShare),
    total: { level1: level1("total"), hierarchy: buildHierarchy(rows) },
    kernel: { level1: level1("kernel") },
  };
}

function buildHierarchy(rows) {
  const nodes = rows.filter((row) => row.scope === "total" && row.level > 1);
  const groupNames = ["MPKI", "FE BOUND", "BE BOUND", "LINX MEMSTALL PKI", "CACHE REFILL PKI", "TLB REFILL & PREFETCH PKI"];
  return groupNames.map((metric) => {
    const level2 = nodes.filter((row) => row.level === 2 && row.parent === metric).map((row) => ({
      name: row.metric,
      value: round2(row.value),
      level3: nodes.filter((child) => child.level === 3 && child.parent === row.metric).map((child) => ({ name: child.metric, value: round2(child.value) })),
    }));
    return { metric, unit: metric === "MPKI" ? "PKI" : "PKI", kind: metric.includes("PKI") && !["MPKI", "FE BOUND", "BE BOUND"].includes(metric) ? "diagnostic" : "", level2 };
  }).filter((group) => group.level2.length);
}

function buildInstruction(db, thread) {
  const rows = all(db, "SELECT * FROM instruction_metrics WHERE thread_id = ?", [thread.id]);
  return {
    name: thread.name,
    threadType: thread.threadType,
    loadShare: round2(thread.loadShare),
    total: instructionEvents.map((event) => ({ name: event, value: round2(rows.find((row) => row.scope === "total" && row.event === event)?.value) })),
    kernel: instructionEvents.map((event) => ({ name: event, value: round2(rows.find((row) => row.scope === "kernel" && row.event === event)?.value) })),
  };
}

function buildSyscall(db, thread) {
  const metric = db.prepare("SELECT density FROM syscall_metrics WHERE thread_id = ?").get(thread.id) || {};
  return {
    name: thread.name,
    threadType: thread.threadType,
    loadShare: round2(thread.loadShare),
    density: round2(metric.density),
    calls: all(db, "SELECT name, share AS value FROM syscall_top WHERE thread_id = ? ORDER BY rank", [thread.id]).map(roundValueRow),
  };
}

function buildHotspots(db, scenarioId, dimension, threads) {
  const rows = all(db, "SELECT * FROM hotspot_threads WHERE scenario_id = ? AND dimension = ? ORDER BY rank", [scenarioId, dimension]);
  return rows.map((row) => {
    const thread = threads.find((item) => item.id === row.thread_id) || {};
    return {
      name: thread.name,
      threadType: thread.threadType,
      loadShare: round2(thread.loadShare),
      score: round2(row.score),
      sos: all(db, "SELECT * FROM hotspot_sos WHERE hotspot_thread_id = ? ORDER BY rank", [row.id]).map((so) => ({
        name: so.name,
        value: round2(so.value),
        funcs: all(db, "SELECT name, value FROM hotspot_functions WHERE hotspot_so_id = ? ORDER BY rank", [so.id]).map(roundValueRow),
      })),
    };
  });
}

function buildFeatures(db) {
  const processNames = topNames(db, "load_process", "name", "name NOT IN ('idle', 'other process')", 5);
  const threadNames = topNames(db, "load_thread", "name", "name NOT IN ('idle', 'other thread', 'other process')", 5);
  const syscallNames = topNames(db, "syscall_top", "name", "name != 'others'", 15);
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
      .filter((thread) => threadTypes.has(thread.threadType))
      .map((thread) => ({
        scenarioId: scenario.id,
        scenarioName: scenario.base.name,
        platform: scenario.base.platform,
        threadName: thread.name,
        threadType: thread.threadType,
        dimension: hotspotDimension(featureKey),
        value: metricValue(scenario, featureKey, thread),
      }));
  }).filter((row) => row.value > 0).sort((a, b) => b.value - a.value);
  return {
    feature: featureMeta,
    average: rows.length ? round2(rows.reduce((sum, row) => sum + row.value, 0) / rows.length) : 0,
    rows,
  };
}

function metricValue(scenario, key, thread) {
  if (key.startsWith("cluster.")) {
    const [, index, stateName] = key.split(".");
    const running = scenario.loadInfo.clusterRunning[Number(index)]?.value || 0;
    return stateName === "idle" ? round2(100 - running) : round2(running);
  }
  if (key.startsWith("process.")) {
    const name = key.slice("process.".length);
    return avg(scenario.loadInfo.processRunning.map((row) => row.items.find((item) => item.name === name)?.value || 0));
  }
  if (key.startsWith("threadload.")) {
    const name = key.slice("threadload.".length);
    return avg(scenario.loadInfo.threadRunning.map((row) => row.items.find((item) => item.name === name)?.value || 0));
  }
  if (key.startsWith("hizee.scene.")) return scenario.loadInfo.hizeeRows[0]?.[key.split(".")[2]] || 0;
  if (key.startsWith("hizee.freq.")) return scenario.loadInfo.hizeeRows[0]?.[key.split(".")[2]] || 0;
  if (key.startsWith("hizee.running.")) {
    const [, , rowIndex, field] = key.split(".");
    return scenario.loadInfo.hizeeRows[Number(rowIndex)]?.[field] || 0;
  }
  if (!thread) return 0;
  if (key.startsWith("topdown.level1.")) {
    const [, , scope, metric] = key.split(".");
    return thread[scope]?.level1?.[metric] || 0;
  }
  if (key.startsWith("topdown.node.")) return findTopdownNodeValue(thread.total?.hierarchy || [], key.slice("topdown.node.".length));
  if (key.startsWith("inst.")) {
    const [, scope, event] = key.split(".");
    const source = scenario.instructionMix.find((item) => item.name === thread.name && item.threadType === thread.threadType);
    return source?.[scope]?.find((item) => item.name === event)?.value || 0;
  }
  if (key === "syscall.density") {
    return scenario.syscallInfo.find((item) => item.name === thread.name && item.threadType === thread.threadType)?.density || 0;
  }
  if (key.startsWith("syscall.share.")) {
    const name = key.slice("syscall.share.".length);
    const source = scenario.syscallInfo.find((item) => item.name === thread.name && item.threadType === thread.threadType);
    return source?.calls.find((item) => item.name === name)?.value || 0;
  }
  if (key.startsWith("hotspot.")) {
    const [, dimension, kind, encodedName] = key.split(".");
    const targetName = decodeURIComponent(encodedName);
    const source = scenario.hotspotInfo[dimension]?.find((item) => item.name === thread.name && item.threadType === thread.threadType);
    if (!source) return 0;
    if (kind === "so") return source.sos.find((so) => so.name === targetName)?.value || 0;
    const values = source.sos.flatMap((so) => so.funcs.filter((fn) => fn.name === targetName).map((fn) => fn.value));
    return values.length ? Math.max(...values) : 0;
  }
  return 0;
}

function avg(values) {
  return values.length ? round2(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function findTopdownNodeValue(groups, name) {
  for (const group of groups) {
    for (const level2 of group.level2 || []) {
      if (level2.name === name) return level2.value;
      const level3 = level2.level3?.find((item) => item.name === name);
      if (level3) return level3.value;
    }
  }
  return 0;
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
  console.log(`CPU 场景库 Dashboard: http://localhost:${port}`);
});
