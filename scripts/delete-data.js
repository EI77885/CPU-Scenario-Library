import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaultDbPath = path.join(root, "data", "cpu_scenario_library.sqlite");

const scenarioChildDeletes = [
  "DELETE FROM hotspot_functions WHERE hotspot_so_id IN (SELECT s.id FROM hotspot_sos s JOIN hotspot_threads h ON h.id = s.hotspot_thread_id WHERE h.scenario_id = ?)",
  "DELETE FROM hotspot_sos WHERE hotspot_thread_id IN (SELECT id FROM hotspot_threads WHERE scenario_id = ?)",
  "DELETE FROM hotspot_threads WHERE scenario_id = ?",
  "DELETE FROM syscall_top WHERE thread_id IN (SELECT id FROM threads WHERE scenario_id = ?)",
  "DELETE FROM syscall_metrics WHERE thread_id IN (SELECT id FROM threads WHERE scenario_id = ?)",
  "DELETE FROM instruction_metrics WHERE thread_id IN (SELECT id FROM threads WHERE scenario_id = ?)",
  "DELETE FROM topdown_metrics WHERE thread_id IN (SELECT id FROM threads WHERE scenario_id = ?)",
  "DELETE FROM hizee_scene WHERE scenario_id = ?",
  "DELETE FROM hizee_clusters WHERE scenario_id = ?",
  "DELETE FROM load_thread WHERE scenario_id = ?",
  "DELETE FROM load_process WHERE scenario_id = ?",
  "DELETE FROM load_cluster WHERE scenario_id = ?",
  "DELETE FROM threads WHERE scenario_id = ?",
  "DELETE FROM scenarios WHERE id = ?",
];

const tableColumns = {
  topdown_metrics: ["thread_id", "scope", "level", "metric", "parent", "value"],
  instruction_metrics: ["thread_id", "scope", "event", "value"],
  syscall_metrics: ["thread_id", "density"],
  syscall_top: ["thread_id", "rank", "number", "name", "share"],
  hizee_clusters: ["scenario_id", "cluster", "avg_freq_mhz", "all_process_running", "ui_process_running", "render_service_running"],
  hizee_scene: ["scenario_id", "fps", "ddr_freq_mhz", "bandwidth", "latency"],
  load_cluster: ["scenario_id", "cluster", "running", "idle"],
  load_process: ["scenario_id", "cluster", "name", "value", "rank"],
  load_thread: ["scenario_id", "cluster", "name", "value", "rank"],
  hotspot_threads: ["id", "scenario_id", "dimension", "thread_id", "rank", "score"],
  hotspot_sos: ["id", "hotspot_thread_id", "rank", "name", "value"],
  hotspot_functions: ["hotspot_so_id", "rank", "name", "value"],
};

const metricAliases = {
  topdown: "topdown_metrics",
  instruction: "instruction_metrics",
  syscall: "syscall_top",
  syscall_metric: "syscall_metrics",
  syscall_density: "syscall_metrics",
  hizee_cluster: "hizee_clusters",
  hizee_scene: "hizee_scene",
  load_cluster: "load_cluster",
  load_process: "load_process",
  load_thread: "load_thread",
  hotspot_thread: "hotspot_threads",
  hotspot_so: "hotspot_sos",
  hotspot_function: "hotspot_functions",
};

function usage() {
  console.log(`Usage:
  node scripts/delete-data.js scenario <scenario_id> [--yes] [--db <path>]
  node scripts/delete-data.js metric <metric_type> --where column=value [--where column=value ...] [--yes] [--db <path>]
  node scripts/delete-data.js row <table> --where column=value [--where column=value ...] [--yes] [--db <path>]
  node scripts/delete-data.js list-scenarios [--db <path>]

Examples:
  node scripts/delete-data.js list-scenarios
  node scripts/delete-data.js scenario 01_game-wzry_replay --yes
  node scripts/delete-data.js metric topdown --where thread_id=01_game-wzry_replay-main --where "metric=FE BOUND" --yes
  node scripts/delete-data.js metric instruction --where thread_id=01_game-wzry_replay-main --where event=ld_st_retired --yes
  node scripts/delete-data.js row syscall_top --where thread_id=01_game-wzry_replay-main --where name=futex --yes

Without --yes the script only previews matched rows.`);
}

function parseArgs(argv) {
  const args = { positional: [], where: [], yes: false, dbPath: defaultDbPath };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--yes") {
      args.yes = true;
    } else if (item === "--help" || item === "-h") {
      args.help = true;
    } else if (item === "--db") {
      args.dbPath = path.resolve(argv[++i] || "");
    } else if (item === "--where") {
      args.where.push(argv[++i] || "");
    } else {
      args.positional.push(item);
    }
  }
  return args;
}

function parseWhere(items) {
  return items.map((item) => {
    const index = item.indexOf("=");
    if (index <= 0) throw new Error(`Invalid --where value: ${item}`);
    return { column: item.slice(0, index).trim(), value: item.slice(index + 1).trim() };
  });
}

function assertKnownTable(table) {
  if (!tableColumns[table]) throw new Error(`Unsupported table: ${table}`);
}

function buildWhereClause(table, where) {
  assertKnownTable(table);
  if (!where.length) throw new Error("At least one --where condition is required.");
  const allowed = new Set(tableColumns[table]);
  for (const condition of where) {
    if (!allowed.has(condition.column)) throw new Error(`Unsupported column for ${table}: ${condition.column}`);
  }
  return {
    clause: where.map((condition) => `${condition.column} = ?`).join(" AND "),
    values: where.map((condition) => condition.value),
  };
}

function openDatabase(dbPath) {
  return new DatabaseSync(dbPath);
}

function listScenarios(db) {
  const rows = db.prepare("SELECT id, type, name, updated_at FROM scenarios ORDER BY source_dir, name").all();
  if (!rows.length) {
    console.log("No scenarios found.");
    return;
  }
  for (const row of rows) {
    console.log(`${row.id}\t${row.type}\t${row.name}\t${row.updated_at}`);
  }
}

function countScenarioRows(db, scenarioId) {
  const counts = [];
  const scenario = db.prepare("SELECT COUNT(*) AS count FROM scenarios WHERE id = ?").get(scenarioId).count;
  counts.push({ table: "scenarios", count: scenario });
  for (const table of ["threads", "load_cluster", "load_process", "load_thread", "hizee_clusters", "hizee_scene", "hotspot_threads"]) {
    counts.push({ table, count: db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE scenario_id = ?`).get(scenarioId).count });
  }
  for (const table of ["topdown_metrics", "instruction_metrics", "syscall_metrics", "syscall_top"]) {
    counts.push({ table, count: db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE thread_id IN (SELECT id FROM threads WHERE scenario_id = ?)`).get(scenarioId).count });
  }
  counts.push({
    table: "hotspot_sos",
    count: db.prepare("SELECT COUNT(*) AS count FROM hotspot_sos WHERE hotspot_thread_id IN (SELECT id FROM hotspot_threads WHERE scenario_id = ?)").get(scenarioId).count,
  });
  counts.push({
    table: "hotspot_functions",
    count: db.prepare("SELECT COUNT(*) AS count FROM hotspot_functions WHERE hotspot_so_id IN (SELECT s.id FROM hotspot_sos s JOIN hotspot_threads h ON h.id = s.hotspot_thread_id WHERE h.scenario_id = ?)").get(scenarioId).count,
  });
  return counts;
}

function printCounts(title, counts) {
  console.log(title);
  for (const row of counts.filter((item) => item.count > 0)) {
    console.log(`- ${row.table}: ${row.count}`);
  }
  const total = counts.reduce((sum, row) => sum + Number(row.count || 0), 0);
  console.log(`Total rows: ${total}`);
  return total;
}

function deleteScenario(db, scenarioId, yes) {
  const counts = countScenarioRows(db, scenarioId);
  const total = printCounts(`Scenario delete preview: ${scenarioId}`, counts);
  if (!total) return;
  if (!yes) {
    console.log("Dry run only. Add --yes to delete these rows.");
    return;
  }
  db.exec("BEGIN");
  try {
    let deleted = 0;
    for (const sql of scenarioChildDeletes) {
      deleted += db.prepare(sql).run(scenarioId).changes;
    }
    db.exec("COMMIT");
    console.log(`Deleted scenario ${scenarioId}; rows deleted: ${deleted}`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function deleteRows(db, table, where, yes) {
  const built = buildWhereClause(table, where);
  const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${built.clause}`).get(...built.values).count;
  console.log(`Row delete preview: ${table}`);
  console.log(`Matched rows: ${count}`);
  if (!count) return;
  if (!yes) {
    console.log("Dry run only. Add --yes to delete these rows.");
    return;
  }
  const result = db.prepare(`DELETE FROM ${table} WHERE ${built.clause}`).run(...built.values);
  console.log(`Deleted rows from ${table}: ${result.changes}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.positional.length) {
    usage();
    return;
  }

  const [command, target] = args.positional;
  const db = openDatabase(args.dbPath);
  try {
    if (command === "list-scenarios") {
      listScenarios(db);
    } else if (command === "scenario") {
      if (!target) throw new Error("Missing scenario_id.");
      deleteScenario(db, target, args.yes);
    } else if (command === "metric" || command === "row") {
      if (!target) throw new Error(`Missing ${command === "metric" ? "metric_type" : "table"}.`);
      const table = command === "metric" ? metricAliases[target.replaceAll("-", "_")] : target;
      if (!table) throw new Error(`Unsupported metric type: ${target}`);
      deleteRows(db, table, parseWhere(args.where), args.yes);
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
  } finally {
    db.close();
  }
}

main();
