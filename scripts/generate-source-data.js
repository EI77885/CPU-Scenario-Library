import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDataset, categoryDirs, clusters, instructionEvents } from "./data-common.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceRoot = path.join(root, "source_data");
const tempRoot = path.join(root, ".tmp-xlsx");
const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAYAAACqNX6+AAAAfklEQVR42u3QMQEAAAgDINc/9K3hHBwgzTOwqgJ2ZQOQBYgCxAFiAbEAWYAsQBYgCxAFiALEAmQBsgBZgCxAFiALEAWIBcACZAGyAFmALEAWIAuQBcgCZAGyAFmALEAWIAuQBcgCZAGyAFmALEAWIAuQBcgCZAGyAFmALEAWIAuQBcgCZAGyADYQAoeuArdfAAAAAElFTkSuQmCC",
  "base64",
);

const cellStyles = {
  normal: 1,
  section: 2,
  label: 3,
  title: 4,
  metric: 5,
  red: 6,
};

const topdownTotalRows = [
  ["IPC", "FE BOUND", "BE BOUND", "L1D_CACHE_REFILL", "L1D_TLB_REFILL_RD", "MEMSTALL_ANYSTORE"],
  ["MPKI", "STALL_FRONTEND_MEMBOUND", "STALL_BACKEND_MEMBOUND", "L1D_CACHE_REFILL_RD", "L1I_TLB_REFILL", "MEMSTALL_ANYLOAD"],
  ["BAD_INST_SPEC", "STALL_FRONTEND_L1I", "STALL_BACKEND_L1D", "L1I_CACHE_REFILL", "L2D_TLB_REFILL_RD", "MEMSTALL_L1MISS"],
  ["BR_IMMED_MIS_PRED_RETIRED", "STALL_FRONTEND_MEM", "STALL_BACKEND_MEM", "L2D_CACHE_REFILL", "L2D_TLB_REFILL", "MEMSTALL_L2MISS"],
  ["BR_COND_MID_PRED_RETIRED", "STALL_FRONTEND_TLB", "STALL_BACKEND_TLB", "L2D_CACHE_REFILL_RD", "PAGE_FAULTS_PMI", "MEMSTALL_L3MISS"],
  ["BR_IND_MIS_PRED_RETIRED", "STALL_FRONTEND_CPUBOUND_PKI", "STALL_BACKEND_ST", "L2I_CACHE_REFILL", "L2D_CACHE_REFILL_PRFM", "L2I_TLB_REFILL"],
  ["BR_INDNR_MIS_PRED_RETIRED", "STALL_FRONTEND_FLOW", "STALL_BACKEND_BUSY", "L3D_CACHE_REFILL", "L2D_CACHE_REFILL_HWPRF", ""],
  ["", "STALL_FRONTEND_FLUSH", "STALL_BACKEND_ILOCK", "L3D_CACHE_REFILL_RD", "L3D_CACHE_REFILL_PRFM", ""],
  ["", "STALL_FRONTEND_RENAME", "", "", "L3D_CACHE_REFILL_HWPRF", ""],
];

const topdownKernelRows = [
  ["IPC", "INST_ratio", "FE BOUND", "MPKI", "L2D_CACHE_REFILL", ""],
  ["", "CYCLE_ratio", "BE BOUND", "BAD_INST_SPEC", "L2D_CACHE_REFILL_RD", ""],
];

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cellRef(rowIndex, columnIndex) {
  let n = columnIndex;
  let col = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    col = String.fromCharCode(65 + rem) + col;
    n = Math.floor((n - rem) / 26);
  }
  return `${col}${rowIndex}`;
}

function worksheetXml(rows, options = {}) {
  const rowXml = rows.map((row, r) => {
    const cells = row.map((value, c) => {
      const ref = cellRef(r + 1, c + 1);
      const style = options.styles?.[r]?.[c] ?? cellStyles.normal;
      const styleAttr = style ? ` s="${style}"` : "";
      if (typeof value === "number") return `<c r="${ref}"${styleAttr}><v>${value}</v></c>`;
      return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
    }).join("");
    const height = options.rowHeights?.[r + 1];
    const heightAttr = height ? ` ht="${height}" customHeight="1"` : "";
    return `<row r="${r + 1}"${heightAttr}>${cells}</row>`;
  }).join("");
  const mergeXml = options.merges?.length
    ? `<mergeCells count="${options.merges.length}">${options.merges.map((ref) => `<mergeCell ref="${ref}"/>`).join("")}</mergeCells>`
    : "";
  const drawing = options.drawing ? '<drawing r:id="rId1"/>' : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${Array.from({ length: 12 }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${options.colWidths?.[i + 1] || (i % 2 === 0 ? 30 : 14)}" customWidth="1"/>`).join("")}</cols>
  <sheetData>${rowXml}</sheetData>
  ${mergeXml}
  ${drawing}
</worksheet>`;
}

function rowsForScenario(scenario) {
  const sheet = targetSheetForScenario(scenario);
  return { demo: sheet };
}

function createSheet(maxRows = 230, maxCols = 12) {
  const rows = Array.from({ length: maxRows }, () => Array.from({ length: maxCols }, () => ""));
  const styles = Array.from({ length: maxRows }, () => Array.from({ length: maxCols }, () => cellStyles.normal));
  const rowHeights = {};
  const colWidths = { 1: 30, 2: 14, 3: 30, 4: 14, 5: 30, 6: 14, 7: 30, 8: 14, 9: 30, 10: 14, 11: 30, 12: 14 };
  const merges = [];
  return {
    rows,
    styles,
    rowHeights,
    colWidths,
    merges,
    set(row, col, value) {
      rows[row - 1][col - 1] = value;
    },
    style(row, col, style) {
      styles[row - 1][col - 1] = style;
    },
    rangeStyle(startRow, startCol, endRow, endCol, style) {
      for (let r = startRow; r <= endRow; r += 1) {
        for (let c = startCol; c <= endCol; c += 1) this.style(r, c, style);
      }
    },
    height(row, value) {
      rowHeights[row] = value;
    },
    row(row, values) {
      values.forEach((value, index) => this.set(row, index + 1, value));
    },
    merge(ref) {
      merges.push(ref);
    },
  };
}

function topdownSourceName(metric) {
  if (metric === "FE BOUND") return "FE_PKI";
  if (metric === "BE BOUND") return "BE_PKI";
  if (metric === "MPKI") return "MPKI";
  if (metric === "IPC") return "IPC";
  if (/ratio$/iu.test(metric)) return metric;
  return metric.endsWith("_PKI") ? metric : `${metric}_PKI`;
}

function topdownLookup(rows, thread, scope) {
  return new Map(rows.filter((row) => row.threadId === thread.id && row.scope === scope).map((row) => [row.metric, row.value]));
}

function metricValue(map, metric, fallback = "") {
  if (!metric) return "";
  return map.has(metric) ? map.get(metric) : fallback;
}

function scaledValue(map, metric, factor) {
  const value = metricValue(map, metric, "");
  return value === "" ? "" : Number((Number(value) * factor).toFixed(2));
}

function writeMetricPair(sheet, row, pairIndex, metric, value, style = cellStyles.metric) {
  const col = pairIndex * 2 + 1;
  if (!metric) return;
  sheet.set(row, col, topdownSourceName(metric).toUpperCase());
  sheet.set(row, col + 1, value);
  sheet.style(row, col, style);
  sheet.style(row, col + 1, style);
}

function writeTopdownThreadBlock(sheet, scenario, thread, start) {
  const total = topdownLookup(scenario.topdown, thread, "total");
  const kernel = topdownLookup(scenario.topdown, thread, "kernel");
  sheet.merge(`A${start}:L${start}`);
  sheet.set(start, 1, `${thread.name}线程-all`);
  sheet.rangeStyle(start, 1, start, 12, cellStyles.section);

  topdownTotalRows.forEach((metrics, rowIndex) => {
    const row = start + 1 + rowIndex;
    metrics.forEach((metric, pairIndex) => {
      writeMetricPair(sheet, row, pairIndex, metric, metricValue(total, metric));
    });
  });

  const kernelStart = start + 10;
  sheet.merge(`A${kernelStart}:L${kernelStart}`);
  sheet.set(kernelStart, 1, `${thread.name}线程-kernel`);
  sheet.rangeStyle(kernelStart, 1, kernelStart, 12, cellStyles.section);
  topdownKernelRows.forEach((metrics, rowIndex) => {
    const row = kernelStart + 1 + rowIndex;
    metrics.forEach((metric, pairIndex) => {
      const value = metric === "INST_ratio" || metric === "CYCLE_ratio"
        ? percentText(12 - rowIndex * 4 - thread.rank * 0.37)
        : metricValue(kernel, metric, scaledValue(total, metric, 0.42));
      const style = metric === "INST_ratio" || metric === "CYCLE_ratio" || metric === "FE BOUND" || metric === "BE BOUND" ? cellStyles.red : cellStyles.metric;
      writeMetricPair(sheet, row, pairIndex, metric, value, style);
    });
  });
}

function percentText(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}%` : "";
}

function targetSheetForScenario(scenario) {
  const appName = scenario.base.name.split("_")[0];
  const sheet = createSheet(260, 12);
  const { rows, styles, merges } = sheet;

  sheet.rangeStyle(1, 1, 260, 12, cellStyles.normal);
  [1, 2, 3, 4, 5, 6, 26, 36, 37, 78, 103, 108].forEach((row) => sheet.height(row, 22));

  sheet.merge("E1:F1");
  sheet.merge("A2:A3");
  sheet.merge("B2:D3");
  sheet.merge("E2:E3");
  sheet.merge("F2:L3");
  sheet.merge("D4:E4");
  sheet.merge("F4:H4");
  sheet.merge("B5:L5");
  sheet.merge("B6:L6");
  sheet.row(1, ["场景类型", scenario.base.type, "游戏/应用名称", appName, "1. 基础信息", "", "游戏/应用版本号", scenario.base.appVersion, "场景名称", scenario.base.name]);
  sheet.row(2, ["场景描述", scenario.base.description, "", "", "场景配置说明", `${scenario.base.config}\n帧率：${scenario.base.type === "游戏" ? 60 : 30}\n动态模糊：非常高`]);
  sheet.row(4, ["抓取平台", scenario.base.platform, "版本镜像", scenario.base.imageVersion, "\\\\100.105.165.102\\pka\\CHS\\harmony\\CHS 部分 CPU场景库"]);
  sheet.row(5, ["归档路径", scenario.base.archivePath]);
  sheet.row(6, ["", "\\\\100.105.26.106\\pmupower\\elf\\SVC\\sherpa_elf\\pmupower_summary\\A_problem_clarify\\57.CPU场景库\\yuanshen"]);
  sheet.rangeStyle(1, 1, 6, 12, cellStyles.label);
  sheet.rangeStyle(1, 5, 1, 6, cellStyles.title);

  sheet.merge("A7:L7");
  sheet.set(7, 1, "2. 负载信息");
  sheet.rangeStyle(7, 1, 7, 12, cellStyles.section);
  sheet.merge("A8:C25");
  sheet.merge("D8:F25");
  sheet.merge("G8:I25");
  sheet.set(8, 1, "CLUSTER LOAD OVERVIEW");
  sheet.set(8, 4, "CLUSTER PROCESS OVERVIEW");
  sheet.set(8, 7, "CLUSTER THREAD OVERVIEW");

  sheet.rangeStyle(8, 1, 25, 9, cellStyles.title);
  sheet.row(26, ["", "负载", "", "平均帧率", "平均频率（Mhz）", "", "DDR平均频率（Mhz）", "平均带宽(GB/S)", "平均latency(ns)"]);
  sheet.merge("B26:C26");
  sheet.merge("E26:F26");
  sheet.rangeStyle(26, 1, 36, 12, cellStyles.normal);
  sheet.rangeStyle(26, 1, 26, 12, cellStyles.label);
  scenario.loadInfo.hizee.clusters.forEach((cluster, index) => {
    const row = 27 + index * 3;
    sheet.merge(`A${row}:A${row + 2}`);
    sheet.merge(`D${row}:D${row + 2}`);
    sheet.merge(`E${row}:F${row + 2}`);
    sheet.merge(`G${row}:G${row + 2}`);
    sheet.merge(`H${row}:H${row + 2}`);
    sheet.merge(`I${row}:I${row + 2}`);
    sheet.row(row, [
      `${cluster.cluster}cluster`,
      "所有进程",
      percentText(cluster.allProcessRunning),
      index === 0 ? scenario.loadInfo.hizee.scene.fps : "",
      cluster.avgFreqMhz,
      "",
      index === 0 ? scenario.loadInfo.hizee.scene.ddrFreqMhz : "",
      index === 0 ? scenario.loadInfo.hizee.scene.bandwidth : "",
      index === 0 ? scenario.loadInfo.hizee.scene.latency : "",
    ]);
    sheet.row(row + 1, ["", "UI进程", percentText(cluster.uiProcessRunning)]);
    sheet.row(row + 2, ["", "render service进程", percentText(cluster.renderServiceRunning)]);
  });
  sheet.set(36, 3, "卡顿次数");

  sheet.merge("A37:L37");
  sheet.set(37, 1, "3. TOPDOWN(测试TOP3线程，UI线程绑大核，其他线程绑中核) —— ST测试");
  sheet.rangeStyle(37, 1, 37, 12, cellStyles.section);
  const topdownStarts = [38, 51, 64];
  scenario.threads.forEach((thread, threadIndex) => {
    writeTopdownThreadBlock(sheet, scenario, thread, topdownStarts[threadIndex]);
  });

  sheet.merge("A78:L78");
  sheet.set(78, 1, "4. 指令分布");
  sheet.rangeStyle(78, 1, 78, 12, cellStyles.section);
  const instructionStarts = [79, 88, 96];
  scenario.threads.forEach((thread, threadIndex) => {
    const start = instructionStarts[threadIndex];
    const threadRows = scenario.instructions.filter((row) => row.threadId === thread.id);
    sheet.merge(`A${start}:L${start}`);
    sheet.set(start, 1, `${thread.name}线程`);
    sheet.rangeStyle(start, 1, start, 12, cellStyles.section);
    sheet.merge(`A${start + 1}:D${start + 1}`);
    sheet.merge(`E${start + 1}:H${start + 1}`);
    sheet.set(start + 1, 1, "ALL");
    sheet.set(start + 1, 5, "Kernel");
    sheet.rangeStyle(start + 1, 1, start + 1, 8, cellStyles.label);
    for (let i = 0; i < instructionEvents.length; i += 2) {
      const row = start + 2 + i / 2;
      const events = instructionEvents.slice(i, i + 2);
      sheet.row(row, [
        ...events.flatMap((event) => [event.toUpperCase() + "_PKI", threadRows.find((item) => item.scope === "total" && item.event === event)?.value ?? ""]),
        "",
        ...events.flatMap((event) => [event.toUpperCase() + "_PKI", threadRows.find((item) => item.scope === "kernel" && item.event === event)?.value ?? ""]),
      ]);
      sheet.rangeStyle(row, 1, row, 8, cellStyles.metric);
    }
  });

  sheet.merge("A103:L103");
  sheet.set(103, 1, "5. 系统调用");
  sheet.rangeStyle(103, 1, 103, 12, cellStyles.section);
  sheet.row(104, ["线程名", "", "系统调用密度（每千万条指令）", "TOP1系统调用及占比", "TOP2系统调用及占比", "TOP3系统调用及占比", "TOP4系统调用及占比", "TOP5系统调用及占比"]);
  sheet.merge("A104:B104");
  sheet.rangeStyle(104, 1, 104, 8, cellStyles.label);
  scenario.syscalls.forEach((syscall, index) => {
    const thread = scenario.threads.find((item) => item.id === syscall.threadId);
    const row = 105 + index;
    sheet.merge(`A${row}:B${row}`);
    sheet.row(row, [
      `${thread.name}线程`,
      "",
      syscall.density,
      ...syscall.calls.filter((call) => call.name !== "others").slice(0, 5).map((call) => `${call.number}_${call.name}(${call.share}%)`),
    ]);
  });

  sheet.merge("A108:L108");
  sheet.set(108, 1, "6. 热点SO及函数&Bound SO及函数");
  sheet.rangeStyle(108, 1, 108, 12, cellStyles.section);
  let row = 109;
  for (const dimension of ["cycle", "fe", "be"]) {
    sheet.merge(`A${row}:L${row}`);
    sheet.set(row, 1, dimension.toUpperCase());
    sheet.rangeStyle(row, 1, row, 12, cellStyles.section);
    row += 1;
    for (const hotspot of scenario.hotspots.filter((item) => item.dimension === dimension)) {
      const thread = scenario.threads.find((item) => item.id === hotspot.threadId);
      const threadStart = row;
      for (const so of hotspot.sos) {
        const soStart = row;
        so.functions.forEach((fn, index) => {
          if (index === 0) sheet.set(row, 4, `Library: ${so.name}(${so.value}%)`);
          sheet.set(row, 7, `Function: ${fn.name}(${fn.value}%)`);
          sheet.rangeStyle(row, 1, row, 8, cellStyles.normal);
          row += 1;
        });
        sheet.merge(`D${soStart}:F${row - 1}`);
      }
      sheet.set(threadStart, 1, `${thread.name}(${hotspot.score}%)`);
      sheet.merge(`A${threadStart}:C${row - 1}`);
    }
  }
  return { rows: trimTrailingRows(rows), styles, merges, rowHeights: sheet.rowHeights, colWidths: sheet.colWidths };
}

function trimTrailingRows(rows) {
  let last = rows.length - 1;
  while (last >= 0 && rows[last].every((cell) => cell === "")) last -= 1;
  return rows.slice(0, last + 1);
}

function legacyRowsForScenario(scenario) {
  const rows = {};
  rows["基础信息"] = [
    ["字段", "值"],
    ["场景类型", scenario.base.type],
    ["游戏/应用名称", scenario.base.name.split("_")[0]],
    ["场景名称", scenario.base.name],
    ["游戏/应用版本号", scenario.base.appVersion],
    ["场景描述", scenario.base.description],
    ["场景配置说明", scenario.base.config],
    ["抓取平台", scenario.base.platform],
    ["版本镜像", scenario.base.imageVersion],
    ["归档路径", scenario.base.archivePath],
  ];
  rows["负载信息"] = [
    ["1. 负载信息"],
    ["三视图图片", "图片嵌入在本 sheet；结构化数据来自同级 hitrace/trace_summary.json"],
    [],
    ["Hizee 信息"],
    ["cluster", "所有进程running占比(%)", "UI进程running占比(%)", "render service running占比(%)", "平均频率(Mhz)", "平均帧率(fps)", "DDR平均频率(Mhz)", "平均带宽(GB/s)", "平均latency(ns)"],
    ...scenario.loadInfo.hizee.clusters.map((cluster, index) => [
      cluster.cluster,
      cluster.allProcessRunning,
      cluster.uiProcessRunning,
      cluster.renderServiceRunning,
      cluster.avgFreqMhz,
      index === 0 ? scenario.loadInfo.hizee.scene.fps : "",
      index === 0 ? scenario.loadInfo.hizee.scene.ddrFreqMhz : "",
      index === 0 ? scenario.loadInfo.hizee.scene.bandwidth : "",
      index === 0 ? scenario.loadInfo.hizee.scene.latency : "",
    ]),
  ];
  rows["TOPDOWN"] = [
    ["线程", "线程类型", "PMU范围", "层级", "事件名", "父事件", "值"],
    ...scenario.topdown.map((row) => {
      const thread = scenario.threads.find((item) => item.id === row.threadId);
      const sourceName = row.level === 1 && row.metric !== "IPC" ? `${row.metric}_PKI` : row.metric;
      return [thread.name, thread.threadType, row.scope === "total" ? "ALL" : "Kernel", row.level, sourceName.toUpperCase(), row.parent, row.value];
    }),
  ];
  rows["指令分布"] = [
    ["线程", "线程类型", ...instructionEvents.map((event) => event.toUpperCase() + "_PKI"), "", ...instructionEvents.map((event) => event.toUpperCase() + "_PKI")],
    ["", "", ...instructionEvents.map(() => "ALL"), "", ...instructionEvents.map(() => "Kernel")],
    ...scenario.threads.map((thread) => {
      const threadRows = scenario.instructions.filter((item) => item.threadId === thread.id);
      return [
        thread.name,
        thread.threadType,
        ...instructionEvents.map((event) => threadRows.find((item) => item.scope === "total" && item.event === event)?.value ?? ""),
        "",
        ...instructionEvents.map((event) => threadRows.find((item) => item.scope === "kernel" && item.event === event)?.value ?? ""),
      ];
    }),
  ];
  rows["系统调用"] = [
    ["线程", "线程类型", "系统调用密度（每千万条指令）", "TOP1系统调用及占比", "TOP2系统调用及占比", "TOP3系统调用及占比", "TOP4系统调用及占比", "TOP5系统调用及占比"],
    ...scenario.syscalls.map((row) => {
      const thread = scenario.threads.find((item) => item.id === row.threadId);
      return [
        thread.name,
        thread.threadType,
        row.density,
        ...row.calls.filter((call) => call.name !== "others").slice(0, 5).map((call) => `${call.number}_${call.name}(${call.share}%)`),
      ];
    }),
  ];
  rows["热点或bound的SO及函数"] = [
    ["维度", "线程", "线程占比", "SO", "SO占比", "函数", "函数占比"],
    ...scenario.hotspots.flatMap((hotspot) => {
      const thread = scenario.threads.find((item) => item.id === hotspot.threadId);
      return hotspot.sos.flatMap((so) => so.functions.map((fn) => [
        hotspot.dimension.toUpperCase(),
        thread.name,
        hotspot.score,
        so.name,
        so.value,
        fn.name,
        fn.value,
      ]));
    }),
  ];
  return rows;
}

async function writeXlsx(filePath, sheets) {
  const workDir = path.join(tempRoot, `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(path.join(workDir, "_rels"), { recursive: true });
  await fs.mkdir(path.join(workDir, "docProps"), { recursive: true });
  await fs.mkdir(path.join(workDir, "xl", "_rels"), { recursive: true });
  await fs.mkdir(path.join(workDir, "xl", "worksheets", "_rels"), { recursive: true });
  await fs.mkdir(path.join(workDir, "xl", "drawings", "_rels"), { recursive: true });
  await fs.mkdir(path.join(workDir, "xl", "media"), { recursive: true });

  const sheetNames = Object.keys(sheets);
  await fs.writeFile(path.join(workDir, "[Content_Types].xml"), contentTypes(sheetNames.length));
  await fs.writeFile(path.join(workDir, "_rels", ".rels"), rootRels());
  await fs.writeFile(path.join(workDir, "docProps", "core.xml"), coreProps());
  await fs.writeFile(path.join(workDir, "docProps", "app.xml"), appProps(sheetNames));
  await fs.writeFile(path.join(workDir, "xl", "workbook.xml"), workbookXml(sheetNames));
  await fs.writeFile(path.join(workDir, "xl", "_rels", "workbook.xml.rels"), workbookRels(sheetNames.length));
  await fs.writeFile(path.join(workDir, "xl", "styles.xml"), stylesXml());
  await fs.writeFile(path.join(workDir, "xl", "drawings", "drawing1.xml"), drawingXml());
  await fs.writeFile(path.join(workDir, "xl", "drawings", "_rels", "drawing1.xml.rels"), drawingRels());
  for (let i = 1; i <= 3; i += 1) await fs.writeFile(path.join(workDir, "xl", "media", `image${i}.png`), png1x1);
  for (const [index, name] of sheetNames.entries()) {
    const sheet = Array.isArray(sheets[name]) ? { rows: sheets[name], merges: [] } : sheets[name];
    const hasLoadDrawing = name === "负载信息" || name === "demo";
    await fs.writeFile(path.join(workDir, "xl", "worksheets", `sheet${index + 1}.xml`), worksheetXml(sheet.rows, {
      drawing: hasLoadDrawing,
      merges: sheet.merges,
      styles: sheet.styles,
      rowHeights: sheet.rowHeights,
      colWidths: sheet.colWidths,
    }));
    if (hasLoadDrawing) {
      await fs.writeFile(path.join(workDir, "xl", "worksheets", "_rels", `sheet${index + 1}.xml.rels`), '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
    }
  }
  await fs.rm(filePath, { force: true });
  execFileSync("zip", ["-qr", filePath, "."], { cwd: workDir });
  await fs.rm(workDir, { recursive: true, force: true });
}

function contentTypes(sheetCount) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${Array.from({ length: sheetCount }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}
<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function rootRels() {
  return '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
}

function coreProps() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:creator>CPU Scenario Library</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`;
}

function appProps(sheetNames) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>CPU Scenario Library</Application><TitlesOfParts><vt:vector size="${sheetNames.length}" baseType="lpstr">${sheetNames.map((name) => `<vt:lpstr>${xml(name)}</vt:lpstr>`).join("")}</vt:vector></TitlesOfParts></Properties>`;
}

function workbookXml(sheetNames) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetNames.map((name, i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
}

function workbookRels(sheetCount) {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: sheetCount }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="10"/><name val="Consolas"/></font>
    <font><b/><sz val="10"/><name val="Consolas"/></font>
    <font><b/><sz val="11"/><name val="Consolas"/></font>
    <font><color rgb="FFB00020"/><b/><sz val="10"/><name val="Consolas"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD9E2EA"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF2DCDB"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right><top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="7">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1" applyBorder="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyAlignment="1" applyBorder="1" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1" applyBorder="1" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyAlignment="1" applyBorder="1" applyFill="1" applyFont="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyAlignment="1" applyBorder="1" applyFill="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyAlignment="1" applyBorder="1" applyFont="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;
}

function drawingXml() {
  const anchors = [[0, 7], [3, 7], [6, 7]];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.map(([col, row], i) => `<xdr:twoCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${col + 3}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 18}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="cluster view ${i + 1}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`).join("")}</xdr:wsDr>`;
}

function drawingRels() {
  return '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image2.png"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image3.png"/></Relationships>';
}

async function main() {
  const scenarios = buildDataset();
  await fs.rm(sourceRoot, { recursive: true, force: true });
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(tempRoot, { recursive: true });
  for (const category of categoryDirs) {
    await fs.mkdir(path.join(sourceRoot, category.dir), { recursive: true });
  }
  for (const scenario of scenarios) {
    const scenarioDir = path.join(sourceRoot, scenario.sourceDir, scenario.base.name);
    const hitraceDir = path.join(scenarioDir, "hitrace");
    await fs.mkdir(hitraceDir, { recursive: true });
    await fs.writeFile(path.join(hitraceDir, "trace_summary.json"), JSON.stringify({
      scenarioId: scenario.id,
      clusterOverview: scenario.loadInfo.clusterOverview,
      processOverview: scenario.loadInfo.processOverview,
      threadOverview: scenario.loadInfo.threadOverview,
    }, null, 2));
    await writeXlsx(
      path.join(scenarioDir, `CPU测试场景库分析_${scenario.base.name}.xlsx`),
      rowsForScenario(scenario),
    );
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
  console.log(`Generated ${scenarios.length} scenarios in ${sourceRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
