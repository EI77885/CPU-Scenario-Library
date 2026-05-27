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
      if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  const drawing = options.drawing ? '<drawing r:id="rId1"/>' : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${Array.from({ length: 12 }, (_, i) => `<col min="${i + 1}" max="${i + 1}" width="${i < 2 ? 22 : 16}" customWidth="1"/>`).join("")}</cols>
  <sheetData>${rowXml}</sheetData>
  ${drawing}
</worksheet>`;
}

function rowsForScenario(scenario) {
  return { demo: targetRowsForScenario(scenario) };
}

function targetRowsForScenario(scenario) {
  const appName = scenario.base.name.split("_")[0];
  const rows = [
    ["场景类型", scenario.base.type, "游戏/应用名称", appName, "1. 基础信息", "", "游戏/应用版本号", scenario.base.appVersion, "场景名称", scenario.base.name],
    ["场景描述", scenario.base.description, "", "", "", "", "场景配置说明", scenario.base.config],
    ["抓取平台", scenario.base.platform, "版本镜像", scenario.base.imageVersion],
    ["归档路径", scenario.base.archivePath],
    [],
    ["2. 负载信息"],
    ["CLUSTER LOAD OVERVIEW", "", "", "CLUSTER PROCESS OVERVIEW", "", "", "CLUSTER THREAD OVERVIEW"],
    [],
    ["cluster", "进程", "负载", "平均帧率", "平均频率(Mhz)", "DDR平均频率(Mhz)", "平均带宽(GB/S)", "平均latency(ns)"],
    ...scenario.loadInfo.hizee.clusters.flatMap((cluster, index) => [
      [
        `${cluster.cluster}cluster`,
        "所有进程",
        cluster.allProcessRunning,
        index === 0 ? scenario.loadInfo.hizee.scene.fps : "",
        cluster.avgFreqMhz,
        index === 0 ? scenario.loadInfo.hizee.scene.ddrFreqMhz : "",
        index === 0 ? scenario.loadInfo.hizee.scene.bandwidth : "",
        index === 0 ? scenario.loadInfo.hizee.scene.latency : "",
      ],
      ["", "UI进程", cluster.uiProcessRunning],
      ["", "render service进程", cluster.renderServiceRunning],
    ]),
    [],
    ["3. TOPDOWN(测试TOP3线程，UI线程排大核，其他线程排中核)"],
  ];
  const orderedTopdownBlocks = scenario.threads.flatMap((thread) => [
    [thread, "total"],
    [thread, "kernel"],
  ]);
  for (const [thread, scope] of orderedTopdownBlocks) {
    const metrics = scenario.topdown.filter((row) => row.threadId === thread.id && row.scope === scope);
    rows.push(["", "", "", `${thread.name}线程-${scope === "kernel" ? "kernel" : "all"}`]);
    for (let i = 0; i < metrics.length; i += 4) {
      rows.push(metrics.slice(i, i + 4).flatMap((item) => {
        const sourceName = item.metric === "IPC" ? item.metric : `${item.metric}_PKI`;
        return [sourceName.toUpperCase(), item.value];
      }));
    }
  }
  rows.push([], ["4. 指令分布"]);
  for (const thread of scenario.threads) {
    const threadRows = scenario.instructions.filter((row) => row.threadId === thread.id);
    rows.push(["", "", "", `${thread.name}线程`], ["ALL", "", "", "", "Kernel"]);
    for (let i = 0; i < instructionEvents.length; i += 2) {
      const events = instructionEvents.slice(i, i + 2);
      rows.push([
        ...events.flatMap((event) => [event.toUpperCase() + "_PKI", threadRows.find((item) => item.scope === "total" && item.event === event)?.value ?? ""]),
        "",
        ...events.flatMap((event) => [event.toUpperCase() + "_PKI", threadRows.find((item) => item.scope === "kernel" && item.event === event)?.value ?? ""]),
      ]);
    }
  }
  rows.push([], ["5. 系统调用"], ["线程名", "系统调用密度（每千万条指令）", "TOP1系统调用及占比", "TOP2系统调用及占比", "TOP3系统调用及占比", "TOP4系统调用及占比", "TOP5系统调用及占比"]);
  for (const syscall of scenario.syscalls) {
    const thread = scenario.threads.find((item) => item.id === syscall.threadId);
    rows.push([
      `${thread.name}线程`,
      syscall.density,
      ...syscall.calls.filter((call) => call.name !== "others").slice(0, 5).map((call) => `${call.number}_${call.name}(${call.share}%)`),
    ]);
  }
  rows.push([], ["6. 热点SO及函数或Bound SO及函数"]);
  for (const dimension of ["cycle", "fe", "be"]) {
    rows.push([dimension.toUpperCase()]);
    for (const hotspot of scenario.hotspots.filter((item) => item.dimension === dimension)) {
      const thread = scenario.threads.find((item) => item.id === hotspot.threadId);
      rows.push([`${thread.name}(${hotspot.score}%)`]);
      for (const so of hotspot.sos) {
        rows.push(["", "", "", `Library: ${so.name}(${so.value}%)`, "", "", `Function: ${so.functions[0].name}(${so.functions[0].value}%)`]);
        for (const fn of so.functions.slice(1)) {
          rows.push(["", "", "", "", "", "", `Function: ${fn.name}(${fn.value}%)`]);
        }
      }
    }
  }
  return rows;
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
  await fs.writeFile(path.join(workDir, "xl", "drawings", "drawing1.xml"), drawingXml());
  await fs.writeFile(path.join(workDir, "xl", "drawings", "_rels", "drawing1.xml.rels"), drawingRels());
  for (let i = 1; i <= 3; i += 1) await fs.writeFile(path.join(workDir, "xl", "media", `image${i}.png`), png1x1);
  for (const [index, name] of sheetNames.entries()) {
    const hasLoadDrawing = name === "负载信息" || name === "demo";
    await fs.writeFile(path.join(workDir, "xl", "worksheets", `sheet${index + 1}.xml`), worksheetXml(sheets[name], { drawing: hasLoadDrawing }));
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
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: sheetCount }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`;
}

function drawingXml() {
  const anchors = [[2, 7], [7, 7], [12, 7]];
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.map(([col, row], i) => `<xdr:twoCellAnchor><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${col + 4}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 10}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 1}" name="cluster view ${i + 1}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`).join("")}</xdr:wsDr>`;
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
