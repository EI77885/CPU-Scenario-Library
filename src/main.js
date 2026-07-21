(async () => {
function renderBootError(error) {
  console.error("CPU scenario dashboard failed to start.", error);
  const app = document.querySelector("#app") || document.body;
  app.innerHTML = "";
  const panel = document.createElement("main");
  panel.className = "boot-error";
  panel.innerHTML = `
    <h1>CPU 场景库启动失败</h1>
    <p>前端已加载，但初始化数据不可用。请先确认数据库已导入，并检查浏览器控制台或服务端窗口中的错误。</p>
    <pre>${String(error?.stack || error?.message || error).replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[char]))}</pre>
  `;
  app.append(panel);
}

try {
async function loadCpuScenarioData() {
  try {
    const response = await fetch("/api/bootstrap");
    if (!response.ok) throw new Error(`API ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn("Using bundled mock data because API data is unavailable.", error);
    return window.CpuScenarioData;
  }
}

function normalizeAppData(data) {
  const normalized = data && typeof data === "object" ? data : {};
  return {
    filterFields: Array.isArray(normalized.filterFields) ? normalized.filterFields : [],
    scenarios: Array.isArray(normalized.scenarios) ? normalized.scenarios : [],
    trendMetrics: Array.isArray(normalized.trendMetrics) ? normalized.trendMetrics : [],
  };
}

const { filterFields, scenarios, trendMetrics } = normalizeAppData(await loadCpuScenarioData());
const initialTrendMetric = trendMetrics[0] || { key: "", type: "load" };

const trendMetricCategories = [
  ["load", "负载信息"],
  ["topdown", "TOPDOWN 信息"],
  ["instruction", "指令分布信息"],
  ["syscall", "系统调用信息"],
  ["hotspot", "热点与瓶颈 SO/函数"],
];

const threadTypeOptions = [
  ["main", "主逻辑线程"],
  ["render", "渲染线程"],
  ["other", "其他线程"],
  ["main_process", "主逻辑进程"],
  ["render_process", "渲染进程"],
];

const state = {
  page: "trend",
  compareFilters: {},
  trendFilters: {},
  selectedIds: new Set(scenarios.slice(0, 3).map((item) => item.id)),
  trendMetric: initialTrendMetric.key,
  trendCategory: getTrendMetricCategory(initialTrendMetric.key),
  threadTypes: new Set(threadTypeOptions.map(([value]) => value)),
  imageFilters: {},
  conclusionFilters: {},
  conclusionTouchedFields: new Set(),
  currentImageVersion: unique("imageVersion").at(-1) || "",
  baselineImageVersion: unique("imageVersion")[0] || "",
  expandedTopdownThreadIndexes: new Set(),
  expandedHotspotThreadIndexes: new Set(),
  savedTrends: [],
};

const colors = [
  "#4f7ec7",
  "#42a69a",
  "#d39a36",
  "#cb6b78",
  "#8674c4",
  "#3fa7c8",
  "#83ad4a",
  "#c4659a",
  "#9a76bd",
  "#4bad73",
  "#c87f43",
  "#4397bf",
  "#b6854b",
  "#5e86bd",
  "#6aa86f",
  "#b96b86",
  "#6f93c9",
  "#9b9a4b",
  "#bd6f62",
  "#6c86b3",
  "#58a6ad",
  "#b58c3f",
  "#8d82c7",
  "#55a47e",
  "#c17774",
  "#6e9ec1",
  "#a07ab8",
  "#7ca458",
  "#bb7897",
  "#5c9aa1",
  "#b47d55",
  "#7790bd",
];
const fixedStackColors = {
  running: "#8ee5aa",
  idle: "#2f3b4d",
  other: "#6f8095",
  "other process": "#6f8095",
  "other thread": "#aab8c8",
  others: "#6f8095",
};
const stackColorMap = buildStackColorMap(scenarios);

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === "class") el.className = value;
    else if (key === "html") el.innerHTML = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) el.setAttribute(key, value === true ? "" : value);
  });
  children.forEach((child) => el.append(child instanceof Node ? child : document.createTextNode(child == null ? "" : child)));
  return el;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function buildStackColorMap(sourceScenarios) {
  const names = new Set();
  for (const scenario of asArray(sourceScenarios)) {
    const loadInfo = asObject(scenario.loadInfo);
    for (const row of [...asArray(loadInfo.processRunning), ...asArray(loadInfo.threadRunning)]) {
      for (const item of asArray(row.items)) {
        const key = stackColorKey(item.name);
        if (key && !fixedStackColors[key]) names.add(key);
      }
    }
  }
  return new Map([...names].sort().map((name, index) => [name, colors[index % colors.length]]));
}

function toFiniteNumber(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function displayValue(value, suffix = "") {
  const number = toFiniteNumber(value);
  if (number == null) return "NA";
  const text = formatDisplayNumber(number);
  return `${text}${suffix}`;
}

function formatDisplayNumber(number) {
  if (Object.is(number, -0) || number === 0) return "0.00";
  const roundedTwo = roundTwo(number);
  if (roundedTwo === 0) return formatSignificantNumber(number, 2);
  return roundedTwo.toFixed(2);
}

function formatSignificantNumber(number, digits) {
  const text = number.toPrecision(digits);
  if (!/e/iu.test(text)) return text;
  const [mantissa, exponentText] = text.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const sign = mantissa.startsWith("-") ? "-" : "";
  const digitsOnly = mantissa.replace("-", "").replace(".", "");
  if (exponent >= 0) {
    const integerLength = exponent + 1;
    return `${sign}${digitsOnly.padEnd(integerLength, "0")}`;
  }
  const zeroCount = Math.max(0, Math.abs(exponent) - 1);
  return `${sign}0.${"0".repeat(zeroCount)}${digitsOnly}`;
}

function displayText(value) {
  return value == null || value === "" ? "NA" : String(value);
}

function safePercent(value) {
  const number = toFiniteNumber(value);
  return number == null ? 0 : Math.max(0, Math.min(100, number));
}

function unique(field) {
  return [...new Set(scenarios.map((scenario) => scenario.base[field]))];
}

function matchesFilters(scenario, filters) {
  return Object.entries(filters).every(([field, value]) => !value || scenario.base[field] === value);
}

function render() {
  const app = document.querySelector("#app");
  app.innerHTML = "";
  app.append(renderShell());
  scheduleCompareHeightSync();
}

function renderShell() {
  const page = h("main", { class: "app" });
  page.append(
    h("header", { class: "topbar" }, [
      h("div", {}, [
        h("p", { class: "eyebrow" }, ["CPU Scenario Library"]),
        h("h1", {}, ["CPU 场景库性能 Dashboard"]),
      ]),
      h("nav", { class: "nav" }, [
        navButton("特征概览", "trend"),
        navButton("对比展示", "compare"),
        navButton("结论汇总", "conclusion"),
      ]),
    ]),
  );
  page.append(state.page === "trend" ? renderTrendPage() : state.page === "compare" ? renderComparePage() : renderConclusionSummaryPage());
  return page;
}

function navButton(label, page) {
  return h("button", { class: state.page === page ? "nav-item active" : "nav-item", onclick: () => { state.page = page; render(); } }, [label]);
}

function renderFilters(filters, onChange, extraControls = [], title = "目标范围筛选池") {
  return h("section", { class: "filter-panel" }, [
    h("div", { class: "section-title" }, [
      h("h2", {}, [title]),
      h("span", {}, [extraControls.length ? "场景类型 / 场景名称 / 应用版本 / 平台 / 镜像版本 / 线程类型" : "场景类型 / 场景名称 / 应用版本 / 平台 / 镜像版本"]),
    ]),
    h("div", { class: "filters" }, [
      ...filterFields.map(([field, label]) => {
      const select = h("select", {
        onchange: (event) => onChange(field, event.target.value),
      }, [
        h("option", { value: "" }, [`全部${label}`]),
        ...unique(field).map((value) => h("option", { value, selected: filters[field] === value }, [value])),
      ]);
      return h("label", { class: "field" }, [h("span", {}, [label]), select]);
      }),
      ...extraControls,
    ]),
  ]);
}

function renderComparePage() {
  const matched = scenarios.filter((scenario) => matchesFilters(scenario, state.compareFilters));
  const selected = matched.filter((scenario) => state.selectedIds.has(scenario.id)).slice(0, 3);
  if (selected.length === 0) matched.slice(0, 3).forEach((item) => state.selectedIds.add(item.id));
  const active = matched.filter((scenario) => state.selectedIds.has(scenario.id)).slice(0, 3);

  return h("div", { class: "page-grid" }, [
    renderFilters(state.compareFilters, (field, value) => {
      state.compareFilters[field] = value;
      state.selectedIds = new Set(scenarios.filter((scenario) => matchesFilters(scenario, state.compareFilters)).slice(0, 3).map((item) => item.id));
      render();
    }),
    renderScenarioSelector(matched),
    renderCompareSection("1. 基础信息", active, renderBaseCard),
    renderCompareSection("2. 场景特征摘要", active, renderScenarioSummaryCard),
    renderCompareSection("3. 负载信息", active, renderLoadCard),
    renderCompareSection("4. TOPDOWN 信息", active, renderTopdownCard),
    renderCompareSection("5. 指令分布信息", active, renderInstructionCard),
    renderCompareSection("6. 系统调用信息", active, renderSyscallCard),
    renderCompareSection("7. 热点与瓶颈 SO/函数", active, renderHotspotCard),
  ]);
}

function renderScenarioSelector(matched) {
  return h("section", { class: "panel" }, [
    h("div", { class: "section-title" }, [
      h("h2", {}, [`筛选结果 ${matched.length} 个`]),
      h("span", {}, ["最多勾选 3 个场景参与横向对比"]),
    ]),
    h("div", { class: "scenario-picks" }, matched.map((scenario) => {
      const checked = state.selectedIds.has(scenario.id);
      return h("label", { class: checked ? "pick checked" : "pick" }, [
        h("input", {
          type: "checkbox",
          checked,
          onchange: (event) => {
            if (event.target.checked && state.selectedIds.size >= 3) event.target.checked = false;
            else if (event.target.checked) state.selectedIds.add(scenario.id);
            else state.selectedIds.delete(scenario.id);
            render();
          },
        }),
        h("strong", {}, [scenario.base.name]),
        h("span", {}, [`${scenario.base.platform} · ${scenario.base.type}`]),
      ]);
    })),
  ]);
}

function renderCompareSection(title, scenariosToShow, renderer) {
  return h("section", { class: "panel" }, [
    h("div", { class: "section-title" }, [h("h2", {}, [title]), h("span", {}, [`${scenariosToShow.length} 个场景`])]),
    h("div", { class: "compare-grid", style: `--cols:${Math.max(1, scenariosToShow.length)}` }, scenariosToShow.map(renderer)),
  ]);
}

const compareSyncSelectors = [
  ":scope > .card-head",
  ":scope > h3",
  ":scope > .badge-row",
  ":scope > .info-row",
  ":scope > .summary-list > .summary-item",
  ":scope > .summary-list > .summary-item .topdown-summary-thread",
  ":scope > .summary-list > .summary-item .topdown-summary-path",
  ":scope > .summary-list > .summary-item .topdown-summary-anomalies",
  ":scope > .summary-list > .summary-item .instruction-summary-thread",
  ":scope > .summary-list > .summary-item .syscall-summary-thread",
  ":scope > h4",
  ":scope > .chart-panel",
  ":scope > .hizee-matrix-wrap",
  ":scope > .thread-block",
  ":scope > details.thread-block",
  ":scope > .thread-block .topdown-tree > .tree-note",
  ":scope > .thread-block .topdown-tree > .bottleneck-summary",
  ":scope > .thread-block .topdown-tree > .bottleneck-summary .path-chips",
  ":scope > .thread-block .topdown-tree > .tree-group",
  ":scope > .thread-block .topdown-tree > .tree-group > .tree-group-title",
  ":scope > .thread-block .topdown-tree > .tree-group > .tree-level2",
  ":scope > .thread-block .topdown-tree > .tree-group > .tree-level2 > .tree-row",
  ":scope > .thread-block .topdown-tree > .tree-group > .tree-level2 > .tree-level3",
  ":scope > .thread-block .topdown-tree > .tree-group > .tree-level2 > .tree-level3 > .tree-row",
  ":scope > .hotspot-dimensions > .hotspot-dimension",
  ":scope > .hotspot-dimensions > .hotspot-dimension .hotspot-thread",
  ":scope > .hotspot-dimensions > .hotspot-dimension .so-card",
  ":scope > .hotspot-dimensions > .hotspot-dimension .so-title",
  ":scope > .hotspot-dimensions > .hotspot-dimension .func-list li",
];

let compareHeightSyncFrame = 0;

function scheduleCompareHeightSync() {
  if (compareHeightSyncFrame) cancelAnimationFrame(compareHeightSyncFrame);
  compareHeightSyncFrame = requestAnimationFrame(() => {
    compareHeightSyncFrame = 0;
    syncCompareHeights();
    compareHeightSyncFrame = requestAnimationFrame(() => {
      compareHeightSyncFrame = 0;
      syncCompareHeights();
    });
  });
}

function syncCompareHeights() {
  document.querySelectorAll("[data-sync-min-height]").forEach((element) => {
    element.style.minHeight = "";
    element.removeAttribute("data-sync-min-height");
  });
  if (state.page !== "compare") return;
  document.querySelectorAll(".compare-grid").forEach((grid) => {
    const cards = [...grid.querySelectorAll(":scope > .card")];
    if (cards.length <= 1 || cards[0].getBoundingClientRect().width >= grid.getBoundingClientRect().width - 1) return;
    compareSyncSelectors.forEach((selector) => syncElementsByIndex(cards, selector));
  });
}

function syncElementsByIndex(cards, selector) {
  const groups = [];
  cards.forEach((card) => {
    card.querySelectorAll(selector).forEach((element, index) => {
      if (!groups[index]) groups[index] = [];
      groups[index].push(element);
    });
  });
  groups.forEach((elements) => {
    if (!elements || elements.length <= 1) return;
    const maxHeight = Math.ceil(Math.max(...elements.map((element) => element.getBoundingClientRect().height)));
    elements.forEach((element) => {
      element.style.minHeight = `${maxHeight}px`;
      element.setAttribute("data-sync-min-height", "true");
    });
  });
}

function renderBaseCard(scenario) {
  const base = asObject(scenario.base);
  return h("article", { class: "card base-card" }, [
    h("h3", {}, [displayText(base.name)]),
    h("div", { class: "badge-row" }, [badge(base.type), badge(base.platform), badge(base.appVersion)]),
    infoRow("场景描述", base.description),
    infoRow("配置说明", base.config),
    infoRow("镜像版本", base.imageVersion),
    infoRow("归档路径", base.archivePath),
  ]);
}

function renderScenarioSummaryCard(scenario) {
  return h("article", { class: "card summary-card-compare" }, [
    cardHeader(scenario),
    h("div", { class: "summary-list" }, scenarioFeatureSummaries(scenario).map(renderScenarioSummaryItem)),
  ]);
}

function renderScenarioSummaryItem(item) {
  const threadRenderers = {
    topdown: renderTopdownSummaryThread,
    instruction: renderInstructionSummaryThread,
    syscall: renderSyscallSummaryThread,
  };
  const threadRenderer = threadRenderers[item.kind];
  const hasThreadProfiles = Boolean(threadRenderer && item.threads?.length);
  const content = hasThreadProfiles
    ? h("div", { class: `${item.kind}-summary-threads` }, item.threads.map(threadRenderer))
    : renderCompactSummaryContent(item);
  const anomalyCount = hasThreadProfiles
    ? asArray(item.threads).reduce((count, thread) => count + asArray(thread.anomalies).length, 0)
    : asArray(item.anomalies).length;
  return h("div", { class: `summary-item ${item.kind}` }, [
    h("div", { class: "summary-item-head" }, [
      h("strong", {}, [item.title]),
      h("span", {}, [anomalyCount
        ? `${anomalyCount} 项指标异常`
        : hasThreadProfiles ? `${item.threads.length} 个线程` : item.badge]),
    ]),
    content,
  ]);
}

function renderCompactSummaryContent(item) {
  const anomalies = asArray(item.anomalies);
  return h("div", { class: "summary-compact-content" }, [
    item.profileTags?.length
      ? h("div", { class: "summary-profile-tags" }, item.profileTags.map((tag) => h("span", {}, [tag])))
      : null,
    h("p", { class: "summary-conclusion" }, [item.text]),
    anomalies.length ? renderSummaryAnomalies(anomalies) : null,
  ]);
}

function renderSummaryAnomalies(anomalies, label = "指标异常") {
  const items = asArray(anomalies);
  return h("div", { class: `summary-anomaly-row${items.length ? " has-anomaly" : ""}` }, [
    h("span", { class: "summary-anomaly-label" }, [label]),
    items.length
      ? h("div", { class: "summary-anomaly-chips" }, items.map((item) => h("span", { class: item.side?.includes("最高") ? "high" : "low" }, [
        h("b", {}, [`${item.label}${item.side}`]),
        `（${displayMetric(item.value, item.unit ? ` ${item.unit}` : "", item.digits ?? (item.unit ? 1 : 2))}）`,
      ])))
      : h("span", { class: "summary-anomaly-empty" }, ["无指标异常"]),
  ]);
}

function renderTopdownSummaryThread(profile) {
  return h("section", { class: `topdown-summary-thread ${profile.typeClass}` }, [
    h("div", { class: "topdown-summary-thread-head" }, [
      h("div", { class: "topdown-summary-identity" }, [
        h("span", { class: `thread-type-badge ${profile.typeClass}` }, [profile.typeLabel]),
        h("strong", {}, [profile.name]),
      ]),
      h("div", { class: "topdown-summary-head-badges" }, [
        h("span", { class: profile.anomalies.length ? "topdown-thread-anomaly-chip" : "topdown-normal-chip" }, [
          profile.anomalies.length ? `${profile.anomalies.length} 项指标异常` : "无指标异常",
        ]),
      ]),
    ]),
    h("div", { class: "topdown-key-metrics" }, [
      h("span", {}, ["IPC 总体/内核 ", h("b", {}, [`${displayMetric(profile.ipc, "", 2)}/${displayMetric(profile.kernelIpc, "", 2)}`])]),
      h("span", {}, ["内核占比 Inst/Cycle ", h("b", {}, [`${displayMetric(profile.kernelInstShare, "%", 1)}/${displayMetric(profile.kernelCycleShare, "%", 1)}`])]),
    ]),
    h("div", { class: "topdown-summary-section topdown-summary-path" }, [
      h("span", { class: "topdown-summary-label" }, ["Bound 链路"]),
      h("div", { class: "topdown-path-steps" }, profile.path.flatMap((item, index) => [
        h("span", { class: `topdown-path-step level-${index + 1}` }, [
          h("small", {}, [`L${index + 1}`]),
          h("b", {}, [item.name]),
          h("em", {}, [`（${displayMetric(item.value, " PKI", 1)}）`]),
        ]),
        index < profile.path.length - 1 ? h("span", { class: "topdown-path-arrow" }, ["→"]) : null,
      ])),
    ]),
    profile.anomalies.length ? renderSummaryAnomalies(profile.anomalies) : null,
  ]);
}

function renderInstructionSummaryThread(profile) {
  return h("section", { class: `instruction-summary-thread ${profile.typeClass}` }, [
    h("div", { class: "compact-thread-head" }, [
      h("div", { class: "topdown-summary-identity" }, [
        h("span", { class: `thread-type-badge ${profile.typeClass}` }, [profile.typeLabel]),
        h("strong", {}, [profile.name]),
      ]),
      h("span", { class: "instruction-total-chip" }, [`总计 ${displayMetric(profile.totalPki, " PKI", 1)}`]),
    ]),
    h("div", { class: "instruction-stack", title: profile.segments.map((item) => `${item.name}: ${displayMetric(item.value, " PKI", 1)} / ${displayMetric(item.share, "%", 1)}`).join("\n") },
      profile.segments.map((item) => h("i", { style: `width:${safePercent(item.share)}%;background:${stackColor(item.name)}` }, [
        item.share >= 13 ? displayMetric(item.share, "%", 0) : "",
      ]))),
    h("div", { class: "instruction-stack-legend" }, profile.segments.map((item) => h("span", {}, [
      h("i", { style: `background:${stackColor(item.name)}` }),
      h("b", {}, [item.name]),
      ` ${displayMetric(item.share, "%", 1)}`,
    ]))),
    profile.anomalies.length ? renderSummaryAnomalies(profile.anomalies) : null,
  ]);
}

function renderSyscallSummaryThread(profile) {
  return h("section", { class: `syscall-summary-thread ${profile.typeClass}` }, [
    h("div", { class: "compact-thread-head" }, [
      h("div", { class: "topdown-summary-identity" }, [
        h("span", { class: `thread-type-badge ${profile.typeClass}` }, [profile.typeLabel]),
        h("strong", {}, [profile.name]),
      ]),
      h("span", { class: "syscall-density-chip" }, [`密度 ${displayMetric(profile.density, "", 0)}`]),
    ]),
    h("div", { class: "syscall-business-row" }, [
      h("span", { class: "offline-profile-label" }, ["离线业务画像"]),
      ...profile.businessTags.map((item) => h("span", { class: "syscall-business-tag" }, [
        h("b", {}, [item.label]),
        ` ${displayMetric(item.share, "%", 1)}`,
      ])),
    ]),
    h("p", { class: "syscall-top5-line" }, [
      "Top5 ",
      profile.calls.map((call) => `${displayText(call.name)} ${displayMetric(call.value, "%", 1)}`).join(" · "),
    ]),
    profile.anomalies.length ? renderSummaryAnomalies(profile.anomalies) : null,
  ]);
}

function scenarioFeatureSummaries(scenario) {
  const loadInfo = asObject(scenario.loadInfo);
  const loadProfile = scenarioLoadProfile(scenario);
  const topdownProfile = scenarioTopdownProfile(scenario);
  const instructionProfiles = scenarioInstructionProfiles(scenario);
  const syscallProfiles = scenarioSyscallProfiles(scenario);
  const hotspotThread = asArray(scenario.hotspotInfo?.cycle)[0] || {};
  const topSo = asArray(hotspotThread.sos)[0];
  const topFunc = asArray(topSo?.funcs)[0];
  const hotspotAnomalies = hotspotSummaryAnomalies(scenario, hotspotThread, topSo, topFunc);
  return [
    {
      title: "负载",
      badge: loadProfile.tags.join(" · "),
      kind: "load",
      text: loadProfile.text,
      profileTags: loadProfile.tags,
      anomalies: loadProfile.anomalies,
    },
    {
      title: "TOPDOWN",
      badge: topdownProfile.tags.join(" · "),
      kind: "topdown",
      text: topdownProfile.text,
      threads: topdownProfile.threads,
    },
    {
      title: "指令分布",
      kind: "instruction",
      threads: instructionProfiles,
    },
    {
      title: "系统调用",
      kind: "syscall",
      threads: syscallProfiles,
    },
    {
      title: "热点与瓶颈 SO/函数",
      badge: topSo?.name || "NA",
      kind: "hotspot",
      text: `Cycle 热点集中在 ${displayText(topSo?.name)} / ${displayText(topFunc?.name)}，占比分别为 ${displayValue(topSo?.value, "%")} / ${displayValue(topFunc?.value, "%")}。`,
      anomalies: hotspotAnomalies,
    },
  ];
}

function scenarioLoadProfile(scenario) {
  const values = scenarioLoadValues(scenario);
  const { fps, ddrFreq, targetFps, allAcr, uiAcr, renderAcr } = values;
  const tags = loadProfileTags({ fps, targetFps, ddrFreq, acr: allAcr });
  return {
    tags,
    text: `帧率 ${displayMetric(fps, "", 1)}/${targetFps}fps；ACR 全进程整机 ${displayMetric(allAcr.system, "%", 1)}、主逻辑/UI进程 ${displayMetric(uiAcr.system, "%", 1)}、Render Service ${displayMetric(renderAcr.system, "%", 1)}；DDR ${displayMetric(ddrFreq, " MHz", 0)}。`,
    anomalies: loadSummaryAnomalies(scenario, values),
  };
}

function scenarioLoadValues(scenario) {
  const rows = asArray(asObject(scenario.loadInfo).hizeeRows);
  const allProcess = rows.find((row) => row.scope === "所有进程") || rows[0] || {};
  const uiProcess = rows.find((row) => row.scope === "UI进程") || rows[1] || {};
  const renderService = rows.find((row) => row.scope === "render service") || rows[2] || {};
  const peaks = cpuPeakFrequencies(scenario.base?.platform);
  return {
    fps: toFiniteNumber(allProcess.fps),
    ddrFreq: toFiniteNumber(allProcess.ddrFreq),
    targetFps: scenarioTargetFps(scenario),
    allAcr: acrProfile(allProcess, peaks),
    uiAcr: acrProfile(uiProcess, peaks),
    renderAcr: acrProfile(renderService, peaks),
  };
}

function loadSummaryAnomalies(scenario, current) {
  const peers = scenarios.filter((item) => item.base?.type === scenario.base?.type).map(scenarioLoadValues);
  const metrics = [
    summaryMetric("帧率", current.fps, "fps", 1, peers.map((item) => item.fps)),
    summaryMetric("全进程小核ACR", current.allAcr.little, "%", 1, peers.map((item) => item.allAcr.little)),
    summaryMetric("全进程中核ACR", current.allAcr.mid, "%", 1, peers.map((item) => item.allAcr.mid)),
    summaryMetric("全进程大核ACR", current.allAcr.big, "%", 1, peers.map((item) => item.allAcr.big)),
    summaryMetric("全进程整机ACR", current.allAcr.system, "%", 1, peers.map((item) => item.allAcr.system)),
    summaryMetric("UI进程整机ACR", current.uiAcr.system, "%", 1, peers.map((item) => item.uiAcr.system)),
    summaryMetric("Render Service整机ACR", current.renderAcr.system, "%", 1, peers.map((item) => item.renderAcr.system)),
    summaryMetric("DDR平均频率", current.ddrFreq, "MHz", 0, peers.map((item) => item.ddrFreq)),
  ];
  return metrics.map(percentileSummaryAnomaly).filter(Boolean).slice(0, 3);
}

function scenarioInstructionProfiles(scenario) {
  return asArray(scenario.instructionMix).map((thread) => {
    const events = [...asArray(thread.total)]
      .map((item) => ({ name: displayText(item.name), value: toFiniteNumber(item.value) || 0 }))
      .sort((a, b) => b.value - a.value);
    const totalPki = events.reduce((sum, item) => sum + item.value, 0);
    const topEvents = events.slice(0, 5);
    const otherValue = events.slice(5).reduce((sum, item) => sum + item.value, 0);
    const segments = [...topEvents, ...(otherValue > 0 ? [{ name: "other instructions", value: otherValue }] : [])]
      .map((item) => ({ ...item, share: totalPki > 0 ? (item.value / totalPki) * 100 : 0 }));
    return {
      name: displayText(thread.name),
      typeLabel: threadTypeLabel(getThreadDisplayType(thread)),
      typeClass: summaryThreadTypeClass(thread),
      totalPki,
      segments,
      anomalies: instructionSummaryAnomalies(scenario, thread),
    };
  });
}

function scenarioSyscallProfiles(scenario) {
  return asArray(scenario.syscallInfo).map((thread) => {
    const calls = asArray(thread.calls).filter((call) => call.name !== "others").slice(0, 5);
    return {
      name: displayText(thread.name),
      typeLabel: threadTypeLabel(getThreadDisplayType(thread)),
      typeClass: summaryThreadTypeClass(thread),
      density: thread.density,
      calls,
      businessTags: asArray(thread.businessTags),
      anomalies: syscallSummaryAnomalies(scenario, thread),
    };
  });
}

function summaryThreadTypeClass(thread) {
  const type = getThreadType(thread);
  if (type === "main" || type === "main_process") return "main";
  if (type === "render" || type === "render_process") return "render";
  return "other";
}

function instructionSummaryAnomalies(scenario, thread) {
  const peers = comparableFeatureThreads(scenario, thread, "instructionMix");
  return [...asArray(thread.total)]
    .sort((a, b) => (toFiniteNumber(b.value) || 0) - (toFiniteNumber(a.value) || 0))
    .map((event) => percentileSummaryAnomaly(summaryMetric(
      displayText(event.name),
      event.value,
      "PKI",
      1,
      peers.map((item) => asArray(item.total).find((candidate) => candidate.name === event.name)?.value),
    )))
    .filter(Boolean)
    .slice(0, 3);
}

function syscallSummaryAnomalies(scenario, thread) {
  const peers = comparableFeatureThreads(scenario, thread, "syscallInfo");
  const metrics = [summaryMetric("syscall密度", thread.density, "条/千万条指令", 0, peers.map((item) => item.density))];
  asArray(thread.calls).filter((call) => call.name !== "others").slice(0, 5).forEach((call) => {
    metrics.push(summaryMetric(
      `${displayText(call.name)}占比`,
      call.value,
      "%",
      1,
      peers.map((item) => asArray(item.calls).find((candidate) => candidate.name === call.name)?.value),
    ));
  });
  return metrics.map(percentileSummaryAnomaly).filter(Boolean).slice(0, 3);
}

function hotspotSummaryAnomalies(scenario, thread, topSo, topFunc) {
  const peers = comparableHotspotThreads(scenario, thread, "cycle");
  const metrics = [summaryMetric("Cycle线程热度", thread.score, "%", 1, peers.map((item) => item.score))];
  if (topSo?.name) {
    metrics.push(summaryMetric(
      `${displayText(topSo.name)}占比`,
      topSo.value,
      "%",
      1,
      peers.map((item) => asArray(item.sos).find((candidate) => candidate.name === topSo.name)?.value),
    ));
  }
  if (topSo?.name && topFunc?.name) {
    metrics.push(summaryMetric(
      `${displayText(topFunc.name)}占比`,
      topFunc.value,
      "%",
      1,
      peers.map((item) => asArray(item.sos)
        .find((candidate) => candidate.name === topSo.name)?.funcs
        ?.find((candidate) => candidate.name === topFunc.name)?.value),
    ));
  }
  return metrics.map(percentileSummaryAnomaly).filter(Boolean).slice(0, 3);
}

function comparableFeatureThreads(scenario, thread, featureKey) {
  const type = scenario.base?.type;
  const canonicalType = getThreadType(thread);
  return scenarios
    .filter((item) => item.base?.type === type)
    .flatMap((item) => asArray(item[featureKey]))
    .filter((item) => getThreadType(item) === canonicalType);
}

function comparableHotspotThreads(scenario, thread, dimension) {
  const type = scenario.base?.type;
  const canonicalType = getThreadType(thread);
  return scenarios
    .filter((item) => item.base?.type === type)
    .flatMap((item) => asArray(item.hotspotInfo?.[dimension]))
    .filter((item) => getThreadType(item) === canonicalType);
}

function summaryMetric(label, value, unit, digits, samples) {
  return {
    label,
    value: toFiniteNumber(value),
    unit,
    digits,
    samples: asArray(samples).map(toFiniteNumber).filter((item) => item != null),
  };
}

function percentileSummaryAnomaly(metric) {
  if (metric.value == null || metric.samples.length < 3) return null;
  const low = quantile(metric.samples, 0.2);
  const high = quantile(metric.samples, 0.8);
  if (low == null || high == null || low === high) return null;
  if (metric.value <= low) return { ...metric, side: "最低20%" };
  if (metric.value >= high) return { ...metric, side: "最高20%" };
  return null;
}

function scenarioTargetFps(scenario) {
  const config = String(scenario.base?.config || "");
  const match = config.match(/(\d+)\s*fps/i);
  if (match) return Number(match[1]);
  return scenario.base?.type === "游戏" ? 60 : 60;
}

function cpuPeakFrequencies(platform) {
  const text = String(platform || "").toLowerCase();
  if (text.includes("nch")) {
    return {
      little: [1750],
      mid: [2350, 2700],
      big: [3100],
    };
  }
  return {
    little: [1720],
    mid: [2270],
    big: [2750],
  };
}

function acrProfile(row, peaks) {
  const little = clusterAcr(row?.littleRunning, row?.littleFreq, peaks.little);
  const mid = clusterAcr(row?.midRunning, row?.midFreq, peaks.mid);
  const big = clusterAcr(row?.bigRunning, row?.bigFreq, peaks.big);
  return {
    little,
    mid,
    big,
    system: average([little, mid, big]),
  };
}

function clusterAcr(running, avgFreq, peakFreqs) {
  const runningValue = toFiniteNumber(running);
  const freqValue = toFiniteNumber(avgFreq);
  const peaks = asArray(peakFreqs).map(toFiniteNumber).filter((value) => value != null && value > 0);
  if (runningValue == null || freqValue == null || !peaks.length) return null;
  return average(peaks.map((peak) => runningValue * (freqValue / peak)));
}

function acrText(profile) {
  return [
    displayMetric(profile?.little, "%", 1),
    displayMetric(profile?.mid, "%", 1),
    displayMetric(profile?.big, "%", 1),
    displayMetric(profile?.system, "%", 1),
  ].join("/");
}

function displayMetric(value, suffix = "", digits = 1) {
  const number = toFiniteNumber(value);
  if (number == null) return "NA";
  return `${number.toFixed(digits)}${suffix}`;
}

function loadProfileTags({ fps, targetFps, ddrFreq, acr }) {
  const tags = [];
  const fpsValue = toFiniteNumber(fps);
  const fpsGap = fpsValue == null || !targetFps ? null : targetFps - fpsValue;
  if (fpsGap != null && fpsGap > 5) tags.push("严重掉帧");
  else if (fpsGap != null && fpsGap > 1) tags.push("掉帧");
  else if (fpsGap != null) tags.push("满帧");
  if ((toFiniteNumber(acr?.little) || 0) > 60) tags.push("小核高载");
  if ((toFiniteNumber(acr?.mid) || 0) > 20) tags.push("中核高载");
  if ((toFiniteNumber(acr?.big) || 0) > 10) tags.push("大核高载");
  if (!tags.some((tag) => tag.endsWith("高载"))) tags.push("CPU轻载");
  const ddrValue = toFiniteNumber(ddrFreq);
  if (ddrValue != null && ddrValue < 1000) tags.push("DDR低载");
  else if (ddrValue != null && ddrValue < 2000) tags.push("DDR中载");
  else if (ddrValue != null) tags.push("DDR高载");
  return tags;
}

function loadProfileSentence(tags) {
  const frameTag = tags.find((tag) => tag.includes("掉帧") || tag === "满帧");
  const cpuTags = tags.filter((tag) => ["小核高载", "中核高载", "大核高载", "CPU轻载"].includes(tag));
  const ddrTag = tags.find((tag) => tag.startsWith("DDR"));
  return `负载画像为${[...cpuTags, ddrTag, frameTag].filter(Boolean).join("、")}。`;
}

function loadRiskLabel(bigRunning, fps) {
  const running = toFiniteNumber(bigRunning);
  const frameRate = toFiniteNumber(fps);
  if (running == null) return "NA";
  if (running >= 70 || (frameRate != null && frameRate < 45)) return "高负载";
  if (running >= 55) return "中负载";
  return "稳定";
}

function scenarioTopdownProfile(scenario) {
  const profiles = asArray(scenario.topdownInfo).map((thread) => topdownThreadProfile(scenario, thread));
  const tags = uniqueText(profiles.flatMap((profile) => profile.tags));
  return {
    tags: tags.length ? tags : ["TOPDOWN"],
    text: profiles.length ? profiles.map((profile) => profile.text).join(" ") : "暂无 TOPDOWN 统计数据。",
    threads: profiles,
  };
}

function topdownThreadProfile(scenario, thread) {
  const total = asObject(thread.total);
  const kernel = asObject(thread.kernel);
  const level1 = asObject(total.level1);
  const kernelLevel1 = asObject(kernel.level1);
  const bottleneck = getBottleneckPath(asArray(total.hierarchy), level1);
  const ipc = toFiniteNumber(level1.IPC);
  const kernelIpc = toFiniteNumber(kernelLevel1.IPC);
  const ipcTag = ipcLevelTag(ipc);
  const anomalies = topdownAnomalies(scenario, thread, bottleneck);
  const anomalyTags = anomalies.map((item) => item.tag);
  const anomalyText = anomalies.length
    ? `异常指标：${anomalies.map((item) => `${item.label}${item.side}${topdownMetricValueText(item)}`).join("、")}`
    : "异常指标：无指标异常";
  const type = getThreadType(thread);
  return {
    tags: uniqueText([ipcTag, ...anomalyTags].filter(Boolean)),
    text: `${threadDisplayLabel(thread)}：负载 ${displayMetric(thread.loadShare, "%", 1)}，IPC(user/kernel) ${displayMetric(ipc, "", 2)}/${displayMetric(kernelIpc, "", 2)}，内核占比(inst/cycle) ${displayMetric(kernelShareValue(thread, "inst"), "%", 1)}/${displayMetric(kernelShareValue(thread, "cycle"), "%", 1)}，bound链路 ${bottleneckPathText(bottleneck)}，Level1 PKI ${level1TopdownPkiText(level1)}，${anomalyText}。`,
    name: displayText(thread.name),
    typeLabel: threadTypeLabel(getThreadDisplayType(thread)),
    typeClass: type === "main" || type === "main_process" ? "main" : type === "render" || type === "render_process" ? "render" : "other",
    loadShare: thread.loadShare,
    ipc,
    kernelIpc,
    ipcTag,
    ipcClass: ipcTag === "低IPC" ? "low" : ipcTag === "中IPC" ? "medium" : "high",
    kernelInstShare: kernelShareValue(thread, "inst"),
    kernelCycleShare: kernelShareValue(thread, "cycle"),
    path: [
      { name: bottleneck.metric, value: bottleneck.metricValue },
      { name: bottleneck.level2, value: bottleneck.level2Value },
      { name: bottleneck.level3, value: bottleneck.level3Value },
    ].filter((item) => item.name),
    level1: [
      { label: "MPKI", value: level1.MPKI },
      { label: "FE", value: level1["FE BOUND"] },
      { label: "BE", value: level1["BE BOUND"] },
    ],
    anomalies,
  };
}

function ipcLevelTag(ipc) {
  const value = toFiniteNumber(ipc);
  if (value == null) return "";
  if (value < 1) return "低IPC";
  if (value < 2) return "中IPC";
  return "高IPC";
}

function topdownAnomalies(scenario, thread, bottleneck) {
  const anomalies = topdownSummaryMetrics(thread, bottleneck)
    .map((metric) => topdownAnomalyForMetric(scenario, thread, metric))
    .filter(Boolean);
  const level1 = anomalies.filter((item) => !item.key.startsWith("node."));
  const hierarchy = anomalies.filter((item) => item.key.startsWith("node."));
  return [...level1.slice(0, 2), ...hierarchy.slice(0, 2)].slice(0, 4);
}

function topdownSummaryMetrics(thread, bottleneck) {
  const metrics = [
    topdownMetricDef("total.IPC", "IPC", "", (item) => asObject(item.total?.level1).IPC),
    topdownMetricDef("total.MPKI", "MPKI", "PKI", (item) => asObject(item.total?.level1).MPKI),
    topdownMetricDef("total.FE BOUND", "FE BOUND", "PKI", (item) => asObject(item.total?.level1)["FE BOUND"]),
    topdownMetricDef("total.BE BOUND", "BE BOUND", "PKI", (item) => asObject(item.total?.level1)["BE BOUND"]),
    topdownMetricDef("kernel.IPC", "内核IPC", "", (item) => asObject(item.kernel?.level1).IPC),
    topdownMetricDef("kernel.MPKI", "内核MPKI", "PKI", (item) => asObject(item.kernel?.level1).MPKI),
    topdownMetricDef("kernel.FE BOUND", "内核FE BOUND", "PKI", (item) => asObject(item.kernel?.level1)["FE BOUND"]),
    topdownMetricDef("kernel.BE BOUND", "内核BE BOUND", "PKI", (item) => asObject(item.kernel?.level1)["BE BOUND"]),
    topdownMetricDef("kernelShare.inst", "内核Inst占比", "%", (item) => kernelShareValue(item, "inst")),
    topdownMetricDef("kernelShare.cycle", "内核Cycle占比", "%", (item) => kernelShareValue(item, "cycle")),
  ];
  const hierarchyNames = topdownHierarchyNodeNames(asArray(thread.total?.hierarchy));
  [bottleneck.metric, bottleneck.level2, bottleneck.level3, ...hierarchyNames].filter(Boolean).forEach((name) => {
    if (metrics.some((metric) => metric.key === `node.${name}` || metric.label === name)) return;
    metrics.push(topdownMetricDef(`node.${name}`, name, "PKI", (item) => findTopdownNodeValue(asArray(item.total?.hierarchy), name)));
  });
  return metrics;
}

function topdownHierarchyNodeNames(groups) {
  const names = [];
  asArray(groups).forEach((group) => {
    asArray(group.level2).forEach((level2) => {
      names.push(level2.name);
      asArray(level2.level3).forEach((level3) => names.push(level3.name));
    });
  });
  return uniqueText(names.filter(Boolean));
}

function topdownMetricDef(key, label, unit, getter) {
  return {
    key,
    label,
    unit,
    value: (thread) => toFiniteNumber(getter(thread)),
  };
}

function topdownAnomalyForMetric(scenario, thread, metric) {
  const value = metric.value(thread);
  if (value == null) return null;
  const samples = comparableTopdownThreads(scenario, thread)
    .map((item) => metric.value(item))
    .filter((item) => item != null);
  if (samples.length < 3) return null;
  const low = quantile(samples, 0.2);
  const high = quantile(samples, 0.8);
  if (low == null || high == null || low === high) return null;
  if (value <= low) return { ...metric, value, side: "最低20%", tag: `${metric.label}最低20%` };
  if (value >= high) return { ...metric, value, side: "最高20%", tag: `${metric.label}最高20%` };
  return null;
}

function comparableTopdownThreads(scenario, thread) {
  const type = scenario.base?.type;
  const canonicalType = getThreadType(thread);
  const entityKind = threadEntityKind(thread);
  return scenarios
    .filter((item) => item.base?.type === type)
    .flatMap((item) => asArray(item.topdownInfo))
    .filter((item) => getThreadType(item) === canonicalType && threadEntityKind(item) === entityKind);
}

function quantile(values, percentile) {
  const sorted = asArray(values).map(toFiniteNumber).filter((value) => value != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function topdownMetricValueText(metric) {
  return `(${displayMetric(metric.value, metric.unit, metric.unit === "" ? 2 : 1)})`;
}

function bottleneckPathText(bottleneck) {
  const parts = [
    bottleneck.metric ? `${bottleneck.metric}（${displayMetric(bottleneck.metricValue, " PKI", 1)}）` : "",
    bottleneck.level2 ? `${bottleneck.level2}（${displayMetric(bottleneck.level2Value, " PKI", 1)}）` : "",
    bottleneck.level3 ? `${bottleneck.level3}（${displayMetric(bottleneck.level3Value, " PKI", 1)}）` : "",
  ].filter(Boolean);
  return parts.join(" > ") || "NA";
}

function level1TopdownPkiText(level1) {
  return `MPKI ${displayMetric(level1.MPKI, "PKI", 1)} / FE ${displayMetric(level1["FE BOUND"], "PKI", 1)} / BE ${displayMetric(level1["BE BOUND"], "PKI", 1)}`;
}

function kernelShareValue(thread, kind) {
  const explicit = toFiniteNumber(kind === "inst" ? thread?.kernelInstShare : thread?.kernelCycleShare);
  if (explicit != null) return explicit;
  const total = asObject(thread?.total?.level1);
  const kernel = asObject(thread?.kernel?.level1);
  const keys = kind === "inst" ? ["MPKI", "FE BOUND"] : ["MPKI", "FE BOUND", "BE BOUND"];
  const ratios = keys.map((key) => {
    const totalValue = toFiniteNumber(total[key]);
    const kernelValue = toFiniteNumber(kernel[key]);
    return totalValue && kernelValue != null ? (kernelValue / totalValue) * 100 : null;
  }).filter((value) => value != null);
  return clamp(average(ratios), 0, 100);
}

function clamp(value, min, max) {
  const number = toFiniteNumber(value);
  if (number == null) return null;
  return Math.max(min, Math.min(max, number));
}

function uniqueText(items) {
  return [...new Set(asArray(items).map((item) => displayText(item)).filter((item) => item && item !== "NA"))];
}

function renderLoadCard(scenario) {
  const loadInfo = asObject(scenario.loadInfo);
  return h("article", { class: "card" }, [
    cardHeader(scenario),
    h("h4", {}, ["Trace 三视图"]),
    clusterStateRows(asArray(loadInfo.clusterRunning)),
    stackedRows(asArray(loadInfo.processRunning), "cluster", "cluster process overview", "累计前 80% 热点进程，其他合并为 other", "process"),
    stackedRows(asArray(loadInfo.threadRunning), "cluster", "cluster thread overview", "继承idle；只关注主进程，其他进程都记为other process；主进程只展开前80%线程，其它线程计入other thread"),
    h("h4", {}, ["Hizee 指标矩阵"]),
    hizeeTable(asArray(loadInfo.hizeeRows)),
  ]);
}

function renderTopdownCard(scenario) {
  return h("article", { class: "card" }, [
    cardHeader(scenario),
    ...asArray(scenario.topdownInfo).map((thread, threadIndex) => {
      const body = [
        topdownThreadTitle(thread),
        metricLegend(),
      ];
      const total = asObject(thread.total);
      const kernel = asObject(thread.kernel);
      const content = [
        dualMetricBars(asObject(total.level1), asObject(kernel.level1), "PKI"),
        renderTopdownHierarchy(asArray(total.hierarchy), asObject(total.level1)),
      ];
      return threadDisclosure(threadIndex === 0, body, content, threadIndex);
    }),
  ]);
}

function threadDisclosure(alwaysOpen, titleContent, content, threadIndex) {
  if (alwaysOpen) {
    return h("div", { class: "thread-block" }, [
      h("div", { class: "thread-title-row" }, titleContent),
      ...content,
    ]);
  }
  return h("details", {
    class: "thread-block collapsible-thread",
    open: state.expandedTopdownThreadIndexes.has(threadIndex),
  }, [
    h("summary", { onclick: (event) => toggleTopdownThread(event, threadIndex) }, titleContent),
    ...content,
  ]);
}

function renderInstructionCard(scenario) {
  return h("article", { class: "card" }, [
    cardHeader(scenario),
    ...asArray(scenario.instructionMix).map((thread) => h("div", { class: "thread-block" }, [
      threadTitle(thread),
      instructionTable(thread),
    ])),
  ]);
}

function renderSyscallCard(scenario) {
  return h("article", { class: "card" }, [
    cardHeader(scenario),
    ...asArray(scenario.syscallInfo).map((thread) => h("div", { class: "thread-block" }, [
      threadTitle(thread, ` · ${displayValue(thread.density)} 条/千万条指令`),
      stackedBar(asArray(thread.calls)),
      stackLegend(asArray(thread.calls)),
    ])),
  ]);
}

function renderHotspotCard(scenario) {
  const groups = [["cycle", "Cycle 热点"], ["fe", "FE 瓶颈"], ["be", "BE 瓶颈"]];
  return h("article", { class: "card" }, [
    cardHeader(scenario),
    h("div", { class: "hotspot-dimensions" }, groups.map(([key, label]) => renderHotspotDimension(key, label, asArray(scenario.hotspotInfo?.[key])))),
  ]);
}

function renderHotspotDimension(dimension, label, threads) {
  return h("section", { class: "hotspot-dimension" }, [
    h("div", { class: "hotspot-dimension-title" }, [
      h("strong", {}, [label]),
      h("span", {}, ["Top3 线程 / Top3 SO / Top3 函数"]),
    ]),
    h("div", { class: "hotspot-thread-list" }, asArray(threads).map((thread, threadIndex) => {
      const title = [
        h("b", {}, [`${threadIndex + 1}. `, threadDisplayLabel(thread)]),
        hotspotScoreBadge(dimension, thread.score),
      ];
      const content = [h("div", { class: "so-list" }, asArray(thread.sos).map((so, soIndex) => h("div", { class: "so-card" }, [
        h("div", { class: "so-title" }, [
          h("b", {}, [`${soIndex + 1}. ${displayText(so.name)}`]),
          h("span", {}, [displayValue(so.value, "%")]),
        ]),
        h("ul", { class: "func-list" }, asArray(so.funcs).map((func, funcIndex) => h("li", {}, [
          h("span", {}, [`${funcIndex + 1}. ${displayText(func.name)}`]),
          h("b", {}, [displayValue(func.value, "%")]),
        ]))),
      ])))];
      return hotspotDisclosure(threadIndex === 0, title, content, dimension, threadIndex);
    })),
  ]);
}

function hotspotDisclosure(alwaysOpen, titleContent, content, dimension, threadIndex) {
  if (alwaysOpen) {
    return h("article", { class: "hotspot-thread" }, [
      h("div", { class: "hotspot-thread-title" }, titleContent),
      ...content,
    ]);
  }
  const stateKey = `${dimension}:${threadIndex}`;
  return h("details", {
    class: "hotspot-thread collapsible-hotspot",
    open: state.expandedHotspotThreadIndexes.has(stateKey),
  }, [
    h("summary", { onclick: (event) => toggleHotspotThread(event, stateKey) }, titleContent),
    ...content,
  ]);
}

function toggleTopdownThread(event, threadIndex) {
  event.preventDefault();
  if (state.expandedTopdownThreadIndexes.has(threadIndex)) state.expandedTopdownThreadIndexes.delete(threadIndex);
  else state.expandedTopdownThreadIndexes.add(threadIndex);
  render();
}

function toggleHotspotThread(event, stateKey) {
  event.preventDefault();
  if (state.expandedHotspotThreadIndexes.has(stateKey)) state.expandedHotspotThreadIndexes.delete(stateKey);
  else state.expandedHotspotThreadIndexes.add(stateKey);
  render();
}

function renderTrendPage() {
  const isThreadMetric = state.trendCategory !== "load";
  const categoryMetrics = trendMetrics.filter((item) => getTrendMetricCategory(item.key) === state.trendCategory);
  if (!categoryMetrics.some((item) => item.key === state.trendMetric)) {
    state.trendMetric = categoryMetrics[0]?.key || "";
  }
  const metric = trendMetrics.find((item) => item.key === state.trendMetric) || { key: "", label: "NA", unit: "" };
  const matched = scenarios.filter((scenario) => matchesFilters(scenario, state.trendFilters));
  const trendRows = (isThreadMetric
    ? matched.flatMap((scenario) => selectedTrendThreads(scenario).map((thread) => {
      const value = getMetricValueForThread(scenario, metric.key, thread);
      return {
        id: `${scenario.id}:${thread.threadType}:${thread.name}`,
        scenario,
        thread,
        sourceDimension: getHotspotDimensionLabel(metric.key),
        label: `${scenario.base.name}_${thread.name}`,
        detail: [scenario.base.platform, threadTypeLabel(thread.threadType), getHotspotDimensionLabel(metric.key)].filter(Boolean).join(" · "),
        value,
      };
    }))
    : matched.map((scenario) => ({
      id: scenario.id,
      scenario,
      label: scenario.base.name,
      detail: scenario.base.platform,
      value: getMetricValue(scenario, metric.key, state.threadTypes),
    }))).sort((a, b) => (toFiniteNumber(b.value) ?? -1) - (toFiniteNumber(a.value) ?? -1));
  const visibleTrendRows = trendRows.filter(hasTrendValue);
  const trendValues = visibleTrendRows.map((row) => toFiniteNumber(row.value)).filter((value) => value != null);
  const averageValue = trendValues.length ? roundTwo(trendValues.reduce((sum, value) => sum + value, 0) / trendValues.length) : null;
  const medianValue = median(trendValues);
  const rangeText = trendValues.length
    ? `${displayValue(Math.min(...trendValues))} - ${displayValue(Math.max(...trendValues))}`
    : "NA";
  const snapshotKey = getTrendSnapshotKey(metric, visibleTrendRows);
  const isSaved = state.savedTrends.some((snapshot) => snapshot.key === snapshotKey);
  return h("div", { class: "page-grid" }, [
    h("section", { class: "filter-panel trend-control" }, [
      h("div", { class: "section-title" }, [h("h2", {}, ["特征筛选池"]), h("span", {}, ["按信息分类选择一个指标，按场景名称汇总趋势"])]),
      h("div", { class: "filters" }, [
        h("label", { class: "field" }, [
          h("span", {}, ["分类"]),
          h("select", {
            onchange: (event) => {
              state.trendCategory = event.target.value;
              state.trendMetric = trendMetrics.find((item) => getTrendMetricCategory(item.key) === state.trendCategory)?.key || "";
              render();
            },
          }, trendMetricCategories.map(([key, label]) => h("option", { value: key, selected: state.trendCategory === key }, [label]))),
        ]),
        h("label", { class: "field" }, [
          h("span", {}, ["特征"]),
          h("select", { onchange: (event) => { state.trendMetric = event.target.value; render(); } }, categoryMetrics.map((item) => h("option", { value: item.key, selected: state.trendMetric === item.key }, [item.label]))),
        ]),
      ]),
    ]),
    renderFilters(state.trendFilters, (field, value) => {
      state.trendFilters[field] = value;
      render();
    }, isThreadMetric ? [renderThreadTypeFilter()] : [], "目标范围筛选池"),
    h("section", { class: "panel" }, [
      h("div", { class: "section-title trend-title" }, [
        h("h2", {}, [`${metric.label} 趋势`]),
        h("div", { class: "trend-summary" }, [
          h("div", { class: "trend-stat-list" }, [
            h("span", {}, [`平均值：${displayValue(averageValue)}`]),
            h("span", {}, [`中位值：${displayValue(medianValue)}`]),
            h("span", {}, [`取值范围：${rangeText}`]),
            h("span", {}, [`单位：${metric.unit || "-"}`]),
          ]),
          h("button", {
            class: isSaved ? "keep-trend saved" : "keep-trend",
            disabled: isSaved,
            onclick: () => saveCurrentTrend(metric, visibleTrendRows, averageValue, snapshotKey),
          }, [isSaved ? "已保留" : "保留当前结果"]),
        ]),
      ]),
      trendChart(visibleTrendRows, metric.unit),
      isThreadMetric && state.trendCategory === "hotspot"
        ? miniTable(["场景名称", "线程名", "平台", "线程类型", "来源维度", metric.label], visibleTrendRows.map((row) => [
          row.scenario.base.name,
          row.thread.name,
          row.scenario.base.platform,
          threadTypeLabel(row.thread.threadType),
          row.sourceDimension,
          displayValue(row.value),
        ]))
        : isThreadMetric
        ? miniTable(["应用_场景_线程名", "平台", "场景类型", "线程类型", metric.label], visibleTrendRows.map((row) => [
          row.label,
          row.scenario.base.platform,
          row.scenario.base.type,
          threadTypeLabel(row.thread.threadType),
          displayValue(row.value),
        ]))
        : miniTable(["场景名称", "平台", "场景类型", metric.label], visibleTrendRows.map((row) => [
          row.label,
          row.scenario.base.platform,
          row.scenario.base.type,
          displayValue(row.value),
        ])),
    ]),
    state.savedTrends.length ? renderSavedTrends() : "",
  ]);
}

function renderImageConclusionPage() {
  const versions = unique("imageVersion");
  if (!state.currentImageVersion && versions.length) state.currentImageVersion = versions.at(-1);
  if (!state.baselineImageVersion && versions.length) state.baselineImageVersion = versions[0];
  if (state.currentImageVersion === state.baselineImageVersion && versions.length > 1) {
    state.baselineImageVersion = versions.find((version) => version !== state.currentImageVersion) || state.baselineImageVersion;
  }
  const report = buildImageCompareReport();
  return h("div", { class: "page-grid" }, [
    renderImageVersionControls(versions),
    renderImageSummary(report),
    renderImageScenarioDiffs(report),
    renderImageMetricDiffs(report),
    renderBottleneckAttribution(report),
    renderImageVersionTrend(report),
  ]);
}

const conclusionFieldOrder = [
  ["platform", "抓取平台"],
  ["imageVersion", "镜像版本"],
  ["type", "场景类型"],
  ["name", "场景名称"],
  ["appVersion", "应用版本"],
];

function renderConclusionSummaryPage() {
  const groups = buildConclusionGroups();
  return h("div", { class: "page-grid" }, [
    renderConclusionFilterPool(),
    h("section", { class: "panel conclusion-summary-panel" }, [
      h("div", { class: "section-title" }, [
        h("h2", {}, ["结论汇总"]),
        h("span", {}, [`按 ${groups.groupLabel} 组织对比 · ${groups.items.length} 个条目`]),
      ]),
      h("div", { class: "conclusion-group-grid", style: `--cols:${Math.min(3, Math.max(1, groups.items.length))}` },
        groups.items.map(renderConclusionGroupCard)),
    ]),
  ]);
}

function renderConclusionFilterPool() {
  return h("section", { class: "filter-panel conclusion-filter-panel" }, [
    h("div", { class: "section-title" }, [
      h("h2", {}, ["目标范围筛选池"]),
      h("span", {}, ["抓取平台 / 镜像版本 / 场景类型 / 场景名称 / 应用版本"]),
    ]),
    h("div", { class: "conclusion-filter-grid" }, conclusionFieldOrder.map(([field, label]) => renderConclusionMultiField(field, label))),
  ]);
}

function renderConclusionMultiField(field, label) {
  const values = unique(field);
  const selected = conclusionSelectedValues(field);
  const isAll = selected.size === values.length;
  return h("div", { class: "conclusion-field" }, [
    h("div", { class: "conclusion-field-head" }, [
      h("strong", {}, [label]),
      h("button", {
        onclick: () => {
          state.conclusionFilters[field] = new Set(values);
          state.conclusionTouchedFields.delete(field);
          render();
        },
      }, [isAll ? "全部" : `${selected.size}/${values.length}`]),
    ]),
    h("div", { class: "conclusion-options" }, values.map((value) => h("label", { class: selected.has(value) ? "thread-type checked" : "thread-type" }, [
      h("input", {
        type: "checkbox",
        checked: selected.has(value),
        onchange: (event) => {
          const next = new Set(selected);
          if (event.target.checked) next.add(value);
          else if (next.size > 1) next.delete(value);
          state.conclusionFilters[field] = next;
          state.conclusionTouchedFields.add(field);
          render();
        },
      }),
      h("span", {}, [value]),
    ]))),
  ]);
}

function conclusionSelectedValues(field) {
  const values = unique(field);
  const selected = state.conclusionFilters[field];
  return selected instanceof Set ? selected : new Set(values);
}

function buildConclusionGroups() {
  const selectedByField = Object.fromEntries(conclusionFieldOrder.map(([field]) => [field, conclusionSelectedValues(field)]));
  const matched = scenarios.filter((scenario) => conclusionFieldOrder.every(([field]) => selectedByField[field].has(scenario.base[field])));
  const lastIndex = conclusionLastGroupIndex(selectedByField);
  const participatingFields = lastIndex >= 0
    ? conclusionFieldOrder.slice(0, lastIndex + 1).filter(([field]) => state.conclusionTouchedFields.has(field) && selectedByField[field].size > 1)
    : [];
  const groupMap = new Map();
  matched.forEach((scenario) => {
    const keyParts = participatingFields.map(([field, label]) => `${label}:${scenario.base[field]}`);
    const key = keyParts.length ? keyParts.join(" / ") : "全部范围";
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        key,
        title: keyParts.length ? keyParts.map((part) => part.split(":")[1]).join(" · ") : "全部范围",
        criteria: Object.fromEntries(participatingFields.map(([field]) => [field, scenario.base[field]])),
        scenarios: [],
      });
    }
    groupMap.get(key).scenarios.push(scenario);
  });
  const groupLabel = lastIndex >= 0 ? conclusionFieldOrder[lastIndex][1] : "全部范围";
  return {
    groupLabel,
    items: [...groupMap.values()].map((group) => ({
      ...group,
      summary: summarizeConclusionGroup(group.scenarios),
    })).sort((a, b) => b.summary.riskScore - a.summary.riskScore || a.title.localeCompare(b.title)),
  };
}

function conclusionLastGroupIndex(selectedByField) {
  let last = -1;
  conclusionFieldOrder.forEach(([field], index) => {
    if (!state.conclusionTouchedFields.has(field)) return;
    if (selectedByField[field]?.size > 1) last = index;
  });
  return last;
}

function summarizeConclusionGroup(groupScenarios) {
  const metrics = imageMetricDefinitions().map((definition) => ({
    ...definition,
    value: average(groupScenarios.map((scenario) => definition.value(scenario))),
  }));
  const load = metrics.find((metric) => metric.key === "cluster.2.running");
  const fps = metrics.find((metric) => metric.key === "hizee.scene.fps");
  const ipc = metrics.find((metric) => metric.key === "topdown.level1.total.IPC");
  const fe = metrics.find((metric) => metric.key === "topdown.level1.total.FE BOUND");
  const be = metrics.find((metric) => metric.key === "topdown.level1.total.BE BOUND");
  const mpki = metrics.find((metric) => metric.key === "topdown.level1.total.MPKI");
  const syscall = metrics.find((metric) => metric.key === "syscall.density");
  const bottleneck = commonBottleneck(groupScenarios);
  const instruction = commonInstruction(groupScenarios);
  const hot = commonHotspot(groupScenarios);
  const riskScore = roundTwo((toFiniteNumber(load?.value) || 0) / 35 + (toFiniteNumber(fe?.value) || 0) / 8 + (toFiniteNumber(mpki?.value) || 0) / 6 + (toFiniteNumber(syscall?.value) || 0) / 80);
  return {
    scenarioCount: groupScenarios.length,
    riskScore,
    riskLevel: riskScore >= 6 ? "high" : riskScore >= 4 ? "medium" : "stable",
    metrics,
    conclusions: [
      { title: "负载", kind: "load", badge: loadRiskLabel(load?.value, fps?.value), text: `平均大核 running ${displayValue(load?.value, "%")}；平均帧率 ${displayValue(fps?.value, "fps")}。` },
      { title: "TOPDOWN", kind: "topdown", badge: bottleneck.metric, text: `主瓶颈集中在 ${[bottleneck.metric, bottleneck.level2, bottleneck.level3].filter(Boolean).join(" > ")}；IPC ${displayValue(ipc?.value)}，FE ${displayValue(fe?.value)}，BE ${displayValue(be?.value)}。` },
      { title: "指令分布", kind: "instruction", badge: instruction.name, text: `${instruction.name} 在范围内较突出，平均 ${displayValue(instruction.value)}。` },
      { title: "系统调用", kind: "syscall", badge: displayValue(syscall?.value), text: `系统调用密度平均 ${displayValue(syscall?.value)} 条/千万条指令。` },
      { title: "热点与瓶颈 SO/函数", kind: "hotspot", badge: hot.so, text: `热点主要集中在 ${hot.so} / ${hot.func}，平均占比 ${displayValue(hot.value, "%")}。` },
    ],
  };
}

function commonBottleneck(groupScenarios) {
  const counts = new Map();
  groupScenarios.forEach((scenario) => {
    const thread = mainThread(scenario) || asArray(scenario.topdownInfo)[0] || {};
    const bottleneck = thread.total ? getBottleneckPath(asArray(thread.total.hierarchy), asObject(thread.total.level1)) : { metric: "NA", level2: "NA" };
    const key = [bottleneck.metric, bottleneck.level2, bottleneck.level3].filter(Boolean).join(" > ");
    counts.set(key, { ...bottleneck, count: (counts.get(key)?.count || 0) + 1 });
  });
  return [...counts.values()].sort((a, b) => b.count - a.count)[0] || { metric: "NA", level2: "NA" };
}

function commonInstruction(groupScenarios) {
  const values = new Map();
  groupScenarios.forEach((scenario) => {
    const thread = mainThread(scenario, "instructionMix") || asArray(scenario.instructionMix)[0] || {};
    asArray(thread.total).forEach((item) => {
      const value = toFiniteNumber(item.value);
      if (value == null) return;
      const current = values.get(item.name) || [];
      current.push(value);
      values.set(item.name, current);
    });
  });
  return [...values.entries()]
    .map(([name, valueList]) => ({ name, value: average(valueList) }))
    .sort((a, b) => (toFiniteNumber(b.value) || 0) - (toFiniteNumber(a.value) || 0))[0] || { name: "NA", value: null };
}

function commonHotspot(groupScenarios) {
  const values = new Map();
  groupScenarios.forEach((scenario) => {
    asArray(scenario.hotspotInfo?.cycle).forEach((thread) => {
      asArray(thread.sos).forEach((so) => {
        const func = asArray(so.funcs)[0] || {};
        const key = `${so.name}::${func.name}`;
        const current = values.get(key) || { so: so.name, func: func.name, values: [] };
        const value = toFiniteNumber(so.value);
        if (value != null) current.values.push(value);
        values.set(key, current);
      });
    });
  });
  return [...values.values()]
    .map((item) => ({ so: item.so || "NA", func: item.func || "NA", value: average(item.values) }))
    .sort((a, b) => (toFiniteNumber(b.value) || 0) - (toFiniteNumber(a.value) || 0))[0] || { so: "NA", func: "NA", value: null };
}

function renderConclusionGroupCard(group) {
  return h("article", { class: `card conclusion-card risk-${group.summary.riskLevel}` }, [
    h("div", { class: "card-head" }, [
      h("h3", {}, [group.title]),
      h("span", {}, [`${group.summary.scenarioCount} 个场景`]),
    ]),
    h("div", { class: "summary-list" }, group.summary.conclusions.map((item) => h("div", { class: `summary-item ${item.kind}` }, [
      h("div", { class: "summary-item-head" }, [
        h("strong", {}, [item.title]),
        h("span", {}, [item.badge]),
      ]),
      h("p", {}, [item.text]),
    ]))),
    h("details", { class: "conclusion-detail" }, [
      h("summary", {}, ["查看明细场景"]),
      miniTable(["场景名称", "平台", "镜像版本", "类型", "应用版本"], group.scenarios.map((scenario) => [
        scenario.base.name,
        scenario.base.platform,
        scenario.base.imageVersion,
        scenario.base.type,
        scenario.base.appVersion,
      ])),
    ]),
  ]);
}

function renderImageVersionControls(versions) {
  return h("section", { class: "filter-panel image-control" }, [
    h("div", { class: "section-title" }, [
      h("h2", {}, ["版本对比筛选池"]),
      h("span", {}, ["当前镜像 / 基线镜像 / 场景范围"]),
    ]),
    h("div", { class: "filters image-filters" }, [
      h("label", { class: "field" }, [
        h("span", {}, ["当前镜像版本"]),
        h("select", { onchange: (event) => { state.currentImageVersion = event.target.value; render(); } },
          versions.map((version) => h("option", { value: version, selected: state.currentImageVersion === version }, [version]))),
      ]),
      h("label", { class: "field" }, [
        h("span", {}, ["基线镜像版本"]),
        h("select", { onchange: (event) => { state.baselineImageVersion = event.target.value; render(); } },
          versions.map((version) => h("option", { value: version, selected: state.baselineImageVersion === version }, [version]))),
      ]),
      ...filterFields.filter(([field]) => field !== "imageVersion").map(([field, label]) => h("label", { class: "field" }, [
        h("span", {}, [label]),
        h("select", {
          onchange: (event) => {
            state.imageFilters[field] = event.target.value;
            render();
          },
        }, [
          h("option", { value: "" }, [`全部${label}`]),
          ...unique(field).map((value) => h("option", { value, selected: state.imageFilters[field] === value }, [value])),
        ]),
      ])),
    ]),
  ]);
}

function buildImageCompareReport() {
  const current = scenarios
    .filter((scenario) => scenario.base.imageVersion === state.currentImageVersion)
    .filter((scenario) => matchesFilters(scenario, state.imageFilters));
  const candidates = current.length ? current : scenarios.filter((scenario) => matchesFilters(scenario, state.imageFilters)).slice(0, 6);
  const scenarioDiffs = candidates.map((scenario) => buildScenarioImageDiff(scenario));
  const summary = summarizeScenarioDiffs(scenarioDiffs);
  const metricDiffs = summarizeMetricDiffs(scenarioDiffs);
  return {
    currentImageVersion: state.currentImageVersion,
    baselineImageVersion: state.baselineImageVersion,
    scenarioDiffs,
    summary,
    metricDiffs,
  };
}

function buildScenarioImageDiff(currentScenario) {
  const baselineScenario = findBaselineScenario(currentScenario);
  const metrics = imageMetricDefinitions().map((metric) => {
    const current = metric.value(currentScenario);
    const baseline = baselineScenario ? metric.value(baselineScenario) : syntheticBaselineValue(current, currentScenario, metric.key);
    const delta = valueDelta(current, baseline);
    const deltaPercent = percentDelta(current, baseline);
    const judgement = judgeMetricChange(metric, delta, deltaPercent);
    return { ...metric, current, baseline, delta, deltaPercent, judgement };
  });
  const riskScore = metrics.reduce((sum, metric) => sum + (metric.judgement === "bad" ? metric.weight : metric.judgement === "good" ? -0.6 : 0), 0);
  const status = riskScore >= 2 ? "regression" : riskScore <= -1 ? "improvement" : "stable";
  const topThread = mainThread(currentScenario) || asArray(currentScenario.topdownInfo)[0] || {};
  const bottleneck = topThread?.total ? getBottleneckPath(asArray(topThread.total.hierarchy), asObject(topThread.total.level1)) : { metric: "NA", level2: "NA" };
  return {
    scenario: currentScenario,
    baselineScenario,
    metrics,
    keyChanges: metrics.filter((metric) => metric.judgement !== "neutral").sort((a, b) => Math.abs(b.deltaPercent || b.delta || 0) - Math.abs(a.deltaPercent || a.delta || 0)).slice(0, 3),
    status,
    riskLevel: riskScore >= 3.5 ? "high" : riskScore >= 2 ? "medium" : status === "improvement" ? "low" : "stable",
    riskScore: roundTwo(riskScore),
    bottleneckPath: [bottleneck.metric, bottleneck.level2, bottleneck.level3].filter(Boolean),
  };
}

function imageMetricDefinitions() {
  return [
    { key: "cluster.2.running", label: "大核 running", unit: "%", direction: "down", weight: 1, value: (scenario) => getMetricValue(scenario, "cluster.2.running", state.threadTypes) },
    { key: "hizee.scene.fps", label: "平均帧率", unit: "fps", direction: "up", weight: 2, value: (scenario) => getMetricValue(scenario, "hizee.scene.fps", state.threadTypes) },
    { key: "hizee.scene.latency", label: "平均 latency", unit: "ns", direction: "down", weight: 1.2, value: (scenario) => getMetricValue(scenario, "hizee.scene.latency", state.threadTypes) },
    { key: "topdown.level1.total.IPC", label: "主逻辑 IPC", unit: "", direction: "up", weight: 1.4, value: (scenario) => threadMetricValue(scenario, "topdown.level1.total.IPC") },
    { key: "topdown.level1.total.MPKI", label: "主逻辑 MPKI", unit: "PKI", direction: "down", weight: 1.2, value: (scenario) => threadMetricValue(scenario, "topdown.level1.total.MPKI") },
    { key: "topdown.level1.total.FE BOUND", label: "主逻辑 FE BOUND", unit: "PKI", direction: "down", weight: 1.8, value: (scenario) => threadMetricValue(scenario, "topdown.level1.total.FE BOUND") },
    { key: "topdown.level1.total.BE BOUND", label: "主逻辑 BE BOUND", unit: "PKI", direction: "down", weight: 1.5, value: (scenario) => threadMetricValue(scenario, "topdown.level1.total.BE BOUND") },
    { key: "syscall.density", label: "系统调用密度", unit: "条/千万条指令", direction: "down", weight: 1, value: (scenario) => threadMetricValue(scenario, "syscall.density", "syscallInfo") },
  ];
}

function threadMetricValue(scenario, key, sourceName = "topdownInfo") {
  const thread = mainThread(scenario, sourceName) || asArray(scenario[sourceName])[0];
  return thread ? getMetricValueForThread(scenario, key, thread) : null;
}

function mainThread(scenario, sourceName = "topdownInfo") {
  return asArray(scenario[sourceName]).find((thread) => getThreadType(thread) === "main");
}

function findBaselineScenario(currentScenario) {
  const exact = scenarios.find((scenario) =>
    scenario.base.imageVersion === state.baselineImageVersion
    && scenario.base.name === currentScenario.base.name
    && scenario.base.appVersion === currentScenario.base.appVersion
    && scenario.base.platform === currentScenario.base.platform);
  if (exact) return exact;
  return scenarios.find((scenario) =>
    scenario.base.imageVersion === state.baselineImageVersion
    && scenario.base.name === currentScenario.base.name
    && scenario.base.appVersion === currentScenario.base.appVersion);
}

function syntheticBaselineValue(current, scenario, key) {
  const value = toFiniteNumber(current);
  if (value == null) return null;
  const drift = (stableHash(`${scenario.id}:${state.currentImageVersion}:${state.baselineImageVersion}:${key}`) % 1400) / 100 - 7;
  return roundTwo(Math.max(0, value - drift));
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function valueDelta(current, baseline) {
  const currentValue = toFiniteNumber(current);
  const baselineValue = toFiniteNumber(baseline);
  return currentValue == null || baselineValue == null ? null : roundTwo(currentValue - baselineValue);
}

function percentDelta(current, baseline) {
  const currentValue = toFiniteNumber(current);
  const baselineValue = toFiniteNumber(baseline);
  if (currentValue == null || baselineValue == null || baselineValue === 0) return null;
  return roundTwo(((currentValue - baselineValue) / Math.abs(baselineValue)) * 100);
}

function judgeMetricChange(metric, delta, deltaPercent) {
  const deltaValue = toFiniteNumber(delta);
  if (deltaValue == null) return "neutral";
  const percent = Math.abs(toFiniteNumber(deltaPercent) || 0);
  const absolute = Math.abs(deltaValue);
  const threshold = metric.key.includes("IPC") ? 3 : metric.unit === "%" ? 5 : 8;
  const changed = percent >= threshold || absolute >= (metric.key.includes("IPC") ? 0.08 : 2);
  if (!changed) return "neutral";
  const worse = metric.direction === "down" ? deltaValue > 0 : deltaValue < 0;
  return worse ? "bad" : "good";
}

function summarizeScenarioDiffs(scenarioDiffs) {
  const counts = {
    matchedScenarioCount: scenarioDiffs.length,
    regressionCount: scenarioDiffs.filter((item) => item.status === "regression").length,
    improvementCount: scenarioDiffs.filter((item) => item.status === "improvement").length,
    stableCount: scenarioDiffs.filter((item) => item.status === "stable").length,
    highRiskCount: scenarioDiffs.filter((item) => item.riskLevel === "high").length,
  };
  const bottleneckCounts = new Map();
  scenarioDiffs.forEach((item) => {
    const key = item.bottleneckPath[0] || "NA";
    bottleneckCounts.set(key, (bottleneckCounts.get(key) || 0) + 1);
  });
  const mainRegressionType = [...bottleneckCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "NA";
  const riskLevel = counts.highRiskCount ? "high" : counts.regressionCount ? "medium" : "low";
  return {
    ...counts,
    mainRegressionType,
    riskLevel,
    conclusion: makeImageConclusionText(counts, mainRegressionType),
  };
}

function makeImageConclusionText(counts, mainRegressionType) {
  if (!counts.matchedScenarioCount) return "当前筛选范围内没有可用于版本对比的场景。";
  if (counts.regressionCount > counts.improvementCount) {
    return `当前镜像相对基线有 ${counts.regressionCount} 个场景呈退化风险，主要瓶颈集中在 ${mainRegressionType}，建议优先复核高风险场景的主逻辑线程。`;
  }
  if (counts.improvementCount > counts.regressionCount) {
    return `当前镜像相对基线改善场景更多，核心指标整体向好，可继续关注剩余持平场景是否存在局部线程风险。`;
  }
  return `当前镜像相对基线整体稳定，退化与改善数量接近，建议结合关键指标变化继续复核边界场景。`;
}

function summarizeMetricDiffs(scenarioDiffs) {
  return imageMetricDefinitions().map((definition) => {
    const metricRows = scenarioDiffs.map((scenarioDiff) => scenarioDiff.metrics.find((metric) => metric.key === definition.key)).filter(Boolean);
    const currentValues = metricRows.map((metric) => toFiniteNumber(metric.current)).filter((value) => value != null);
    const baselineValues = metricRows.map((metric) => toFiniteNumber(metric.baseline)).filter((value) => value != null);
    const deltaValues = metricRows.map((metric) => toFiniteNumber(metric.delta)).filter((value) => value != null);
    return {
      ...definition,
      currentAverage: average(currentValues),
      baselineAverage: average(baselineValues),
      deltaAverage: average(deltaValues),
      regressionCount: metricRows.filter((metric) => metric.judgement === "bad").length,
      improvementCount: metricRows.filter((metric) => metric.judgement === "good").length,
    };
  });
}

function average(values) {
  const safeValues = asArray(values).map(toFiniteNumber).filter((value) => value != null);
  return safeValues.length ? roundTwo(safeValues.reduce((sum, value) => sum + value, 0) / safeValues.length) : null;
}

function renderImageSummary(report) {
  const summary = report.summary;
  const cards = [
    ["可比场景", summary.matchedScenarioCount, "个"],
    ["退化风险", summary.regressionCount, "个"],
    ["改善场景", summary.improvementCount, "个"],
    ["高风险", summary.highRiskCount, "个"],
    ["主瓶颈", summary.mainRegressionType, ""],
  ];
  return h("section", { class: `panel image-summary risk-${summary.riskLevel}` }, [
    h("div", { class: "section-title" }, [
      h("h2", {}, [`${report.currentImageVersion || "当前镜像"} vs ${report.baselineImageVersion || "基线镜像"}`]),
      h("span", {}, ["版本验收结论"]),
    ]),
    h("div", { class: "image-summary-grid" }, cards.map(([label, value, unit]) => h("article", { class: "summary-card" }, [
      h("span", {}, [label]),
      h("strong", {}, [`${displayText(value)}${unit}`]),
    ]))),
    h("p", { class: "image-conclusion" }, [summary.conclusion]),
  ]);
}

function renderImageScenarioDiffs(report) {
  const rows = [...report.scenarioDiffs].sort((a, b) => b.riskScore - a.riskScore);
  return h("section", { class: "panel" }, [
    h("div", { class: "section-title" }, [
      h("h2", {}, ["场景变化排行"]),
      h("span", {}, ["按风险分与退化幅度排序"]),
    ]),
    h("div", { class: "scenario-diff-list" }, rows.map((item) => h("article", { class: `scenario-diff-card ${item.status}` }, [
      h("div", { class: "scenario-diff-head" }, [
        h("div", {}, [
          h("strong", {}, [item.scenario.base.name]),
          h("span", {}, [`${item.scenario.base.platform} · ${item.scenario.base.type} · ${item.scenario.base.appVersion}`]),
        ]),
        h("div", { class: "status-pack" }, [
          h("span", { class: `status-pill ${item.status}` }, [statusLabel(item.status)]),
          h("span", { class: `risk-pill ${item.riskLevel}` }, [riskLabel(item.riskLevel)]),
        ]),
      ]),
      h("div", { class: "change-chips" }, item.keyChanges.length ? item.keyChanges.map((metric) => h("span", { class: metric.judgement }, [
        `${metric.label} ${formatSigned(metric.delta)}${metric.unit ? ` ${metric.unit}` : ""}`,
      ])) : [h("span", { class: "neutral" }, ["关键指标无明显变化"])]),
      h("div", { class: "bottleneck-line" }, [
        h("b", {}, ["瓶颈链路"]),
        ...item.bottleneckPath.map((name) => h("span", {}, [name])),
      ]),
    ]))),
  ]);
}

function renderImageMetricDiffs(report) {
  return h("section", { class: "panel" }, [
    h("div", { class: "section-title" }, [
      h("h2", {}, ["关键指标 delta"]),
      h("span", {}, ["当前均值 / 基线均值 / 平均变化"]),
    ]),
    h("div", { class: "metric-diff-grid" }, report.metricDiffs.map((metric) => h("article", { class: "metric-diff-card" }, [
      h("div", { class: "metric-diff-title" }, [
        h("strong", {}, [metric.label]),
        h("span", {}, [metric.unit || "-"]),
      ]),
      h("div", { class: "metric-diff-values" }, [
        h("span", {}, ["当前", h("b", {}, [displayValue(metric.currentAverage)])]),
        h("span", {}, ["基线", h("b", {}, [displayValue(metric.baselineAverage)])]),
        h("span", { class: deltaClass(metric, metric.deltaAverage) }, ["Δ", h("b", {}, [formatSigned(metric.deltaAverage)])]),
      ]),
      h("div", { class: "metric-diff-foot" }, [
        h("span", {}, [`退化 ${metric.regressionCount}`]),
        h("span", {}, [`改善 ${metric.improvementCount}`]),
      ]),
    ]))),
  ]);
}

function renderBottleneckAttribution(report) {
  const groups = new Map();
  report.scenarioDiffs.forEach((diff) => {
    const key = diff.bottleneckPath[0] || "NA";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(diff);
  });
  return h("section", { class: "panel" }, [
    h("div", { class: "section-title" }, [
      h("h2", {}, ["瓶颈变化归因"]),
      h("span", {}, ["按 TOPDOWN 主瓶颈聚合"]),
    ]),
    h("div", { class: "bottleneck-grid" }, [...groups.entries()].map(([name, items]) => h("article", { class: "bottleneck-card" }, [
      h("h3", {}, [name]),
      h("p", {}, [`命中 ${items.length} 个场景，退化 ${items.filter((item) => item.status === "regression").length} 个`]),
      h("ul", {}, items.slice(0, 4).map((item) => h("li", {}, [
        h("span", {}, [item.scenario.base.name]),
        h("b", {}, [statusLabel(item.status)]),
      ]))),
    ]))),
  ]);
}

function renderImageVersionTrend(report) {
  const metric = report.metricDiffs.find((item) => item.key === "topdown.level1.total.FE BOUND") || report.metricDiffs[0];
  const versions = unique("imageVersion");
  const trendRows = versions.map((version, index) => ({
    label: version,
    detail: index === versions.indexOf(report.baselineImageVersion) ? "基线" : index === versions.indexOf(report.currentImageVersion) ? "当前" : "历史",
    value: syntheticVersionMetric(metric, version, index),
  }));
  return h("section", { class: "panel" }, [
    h("div", { class: "section-title" }, [
      h("h2", {}, ["多版本趋势预览"]),
      h("span", {}, [`${metric?.label || "关键指标"} · ${metric?.unit || "-"}`]),
    ]),
    trendChart(trendRows, metric?.unit || "", true),
  ]);
}

function syntheticVersionMetric(metric, version, index) {
  const base = toFiniteNumber(metric?.baselineAverage) ?? 10;
  const noise = ((stableHash(`${version}:${metric?.key}`) % 1000) / 1000 - 0.5) * 3;
  return roundTwo(Math.max(0, base + index * 0.7 + noise));
}

function statusLabel(status) {
  return { regression: "退化", improvement: "改善", stable: "持平" }[status] || "持平";
}

function riskLabel(risk) {
  return { high: "高风险", medium: "中风险", low: "低风险", stable: "稳定" }[risk] || "稳定";
}

function formatSigned(value) {
  const number = toFiniteNumber(value);
  if (number == null) return "NA";
  return `${number > 0 ? "+" : ""}${displayValue(number)}`;
}

function deltaClass(metric, delta) {
  const judgement = judgeMetricChange(metric, delta, percentDelta((toFiniteNumber(metric.baselineAverage) || 0) + (toFiniteNumber(delta) || 0), metric.baselineAverage));
  return judgement === "bad" ? "bad" : judgement === "good" ? "good" : "neutral";
}


function getTrendMetricCategory(key) {
  if (key.startsWith("topdown.")) return "topdown";
  if (key.startsWith("inst.")) return "instruction";
  if (key.startsWith("syscall.")) return "syscall";
  if (key.startsWith("hotspot.")) return "hotspot";
  return "load";
}

function hasTrendValue(row) {
  return toFiniteNumber(row?.value) != null;
}

function getHotspotDimensionLabel(key) {
  if (!key.startsWith("hotspot.")) return "";
  const dimension = key.split(".")[1];
  return { cycle: "Cycle 热点", fe: "FE BOUND", be: "BE BOUND" }[dimension] || "";
}

function saveCurrentTrend(metric, trendRows, averageValue, snapshotKey) {
  if (state.savedTrends.some((snapshot) => snapshot.key === snapshotKey)) return;
  state.savedTrends.unshift({
    id: `trend-${Date.now()}`,
    key: snapshotKey,
    metricLabel: metric.label,
    unit: metric.unit,
    averageValue,
    filters: formatFilters(state.trendFilters),
    threadTypes: [...state.threadTypes],
    rows: trendRows.map((row) => ({
      label: row.label,
      detail: row.detail,
      name: row.label,
      platform: row.scenario.base.platform,
      type: row.scenario.base.type,
      threadType: row.thread?.threadType || "",
      value: row.value,
    })),
  });
  render();
}

function getTrendSnapshotKey(metric, trendRows) {
  return JSON.stringify({
    metric: metric.key,
    filters: state.trendFilters,
    threadTypes: [...state.threadTypes].sort(),
    rows: trendRows.map((row) => `${row.id}:${row.value}`),
  });
}

function renderSavedTrends() {
  return h("section", { class: "panel saved-trends" }, [
    h("div", { class: "section-title" }, [
      h("h2", {}, ["保留结果对比"]),
      h("span", {}, [`${state.savedTrends.length} 个快照`]),
    ]),
    h("div", { class: "saved-trend-grid" }, state.savedTrends.map((snapshot) => h("article", { class: "saved-trend-card" }, [
      h("div", { class: "saved-trend-head" }, [
        h("div", {}, [
          h("strong", {}, [snapshot.metricLabel]),
          h("span", {}, [`平均值 ${snapshot.averageValue}`]),
        ]),
        h("button", { onclick: () => { state.savedTrends = state.savedTrends.filter((item) => item.id !== snapshot.id); render(); } }, ["移除"]),
      ]),
      h("p", {}, [snapshot.filters]),
      trendChart(snapshot.rows.map((row) => ({ label: row.label || row.name, detail: row.detail || row.platform, value: row.value })), snapshot.unit, true),
    ]))),
  ]);
}

window.addEventListener("resize", () => {
  if (state.page === "compare") scheduleCompareHeightSync();
});

function selectedTrendThreads(scenario) {
  return allScenarioThreads(scenario).filter((thread) => state.threadTypes.has(getThreadType(thread)));
}

function allScenarioThreads(scenario) {
  const source = [
    ...asArray(scenario.topdownInfo),
    ...asArray(scenario.instructionMix),
    ...asArray(scenario.syscallInfo),
    ...asArray(scenario.hotspotInfo?.cycle),
    ...asArray(scenario.hotspotInfo?.fe),
    ...asArray(scenario.hotspotInfo?.be),
  ];
  return [...new Map(source
    .filter((thread) => thread?.name)
    .map((thread) => [`${normalizeThreadFilterKey(thread.name)}:${getThreadType(thread)}`, thread])).values()];
}

function normalizeThreadFilterKey(value) {
  return displayText(value).trim().toLowerCase();
}

function formatFilters(filters) {
  const active = Object.entries(filters).filter(([, value]) => value).map(([field, value]) => {
    const label = filterFields.find(([key]) => key === field)?.[1] || field;
    return `${label}:${value}`;
  });
  return active.length ? active.join(" / ") : "全部场景";
}

function threadTypeOption(value, label, enabled) {
  return h("label", { class: state.threadTypes.has(value) ? "thread-type checked" : "thread-type" }, [
    h("input", {
      type: "checkbox",
      checked: state.threadTypes.has(value),
      disabled: !enabled,
      onchange: (event) => {
        if (event.target.checked) state.threadTypes.add(value);
        else if (state.threadTypes.size > 1) state.threadTypes.delete(value);
        render();
      },
    }),
    h("span", {}, [label]),
  ]);
}

function renderThreadTypeFilter() {
  return h("div", { class: "field thread-type-field" }, [
    h("span", {}, ["线程/进程类型"]),
    h("div", { class: "thread-type-options" }, threadTypeOptions.map(([value, label]) => threadTypeOption(value, label, true))),
  ]);
}

function getMetricValue(scenario, key, threadTypes) {
  const avg = (items) => {
    const values = items.map(toFiniteNumber).filter((value) => value != null);
    return values.length ? roundTwo(values.reduce((sum, item) => sum + item, 0) / values.length) : null;
  };
  const selectedThreadValues = (items, getter) => {
    const safeItems = asArray(items);
    const values = safeItems.filter((item) => threadTypes.has(getThreadType(item))).map(getter);
    return avg(values.length ? values : safeItems.map(getter));
  };
  const loadInfo = asObject(scenario.loadInfo);
  if (key.startsWith("cluster.")) {
    const [, index, stateName] = key.split(".");
    const running = toFiniteNumber(asArray(loadInfo.clusterRunning)[Number(index)]?.value);
    if (running == null) return null;
    return stateName === "idle" ? roundTwo(100 - running) : roundTwo(running);
  }
  if (key.startsWith("process.")) {
    const name = key.slice("process.".length);
    return avg(asArray(loadInfo.processRunning).map((row) => asArray(row.items).find((item) => item.name === name)?.value));
  }
  if (key.startsWith("threadload.")) {
    const name = key.slice("threadload.".length);
    return avg(asArray(loadInfo.threadRunning).map((row) => asArray(row.items).find((item) => item.name === name)?.value));
  }
  if (key.startsWith("hizee.")) {
    const [, kind, first, second] = key.split(".");
    const rows = asArray(loadInfo.hizeeRows);
    if (kind === "scene") return toFiniteNumber(rows[0]?.[first]);
    if (kind === "freq") return toFiniteNumber(rows[0]?.[first]);
    if (kind === "running") return toFiniteNumber(rows[Number(first)]?.[second]);
  }
  if (key === "syscall.density") {
    return selectedThreadValues(scenario.syscallInfo, (item) => item?.density);
  }
  if (key.startsWith("syscall.share.")) {
    const name = key.slice("syscall.share.".length);
    return selectedThreadValues(scenario.syscallInfo, (item) => asArray(item?.calls).find((call) => call.name === name)?.value);
  }
  if (key.startsWith("topdown.level1.")) {
    const [, , scope, metric] = key.split(".");
    return selectedThreadValues(scenario.topdownInfo, (item) => item?.[scope]?.level1?.[metric]);
  }
  if (key.startsWith("topdown.node.")) {
    const name = key.slice("topdown.node.".length);
    return selectedThreadValues(scenario.topdownInfo, (item) => findTopdownNodeValue(asArray(item?.total?.hierarchy), name));
  }
  if (key.startsWith("inst.")) {
    const [, scope, eventName] = key.split(".");
    return selectedThreadValues(scenario.instructionMix, (thread) => asArray(thread?.[scope]).find((item) => item.name === eventName)?.value);
  }
  if (key.startsWith("hotspot.")) {
    const [, dimension, kind, encodedName] = key.split(".");
    const targetName = decodeURIComponent(encodedName);
    const dimensionThreads = asArray(scenario.hotspotInfo?.[dimension]);
    const threads = dimensionThreads.filter((thread) => threadTypes.has(getThreadType(thread)));
    const sourceThreads = threads.length ? threads : dimensionThreads;
    return avg(sourceThreads.map((thread) => hotspotValueInThread(thread, kind, targetName)));
  }
  return null;
}

function getMetricValueForThread(scenario, key, thread) {
  if (key === "syscall.density") {
    return toFiniteNumber(asArray(scenario.syscallInfo).find((item) => sameThread(item, thread))?.density);
  }
  if (key.startsWith("syscall.share.")) {
    const name = key.slice("syscall.share.".length);
    const source = asArray(scenario.syscallInfo).find((item) => sameThread(item, thread));
    return toFiniteNumber(asArray(source?.calls).find((call) => call.name === name)?.value);
  }
  if (key.startsWith("topdown.level1.")) {
    const [, , scope, metric] = key.split(".");
    const source = asArray(scenario.topdownInfo).find((item) => sameThread(item, thread));
    return toFiniteNumber(source?.[scope]?.level1?.[metric]);
  }
  if (key.startsWith("topdown.node.")) {
    const name = key.slice("topdown.node.".length);
    const source = asArray(scenario.topdownInfo).find((item) => sameThread(item, thread));
    return source ? findTopdownNodeValue(asArray(source.total?.hierarchy), name) : null;
  }
  if (key.startsWith("inst.")) {
    const [, scope, eventName] = key.split(".");
    const source = asArray(scenario.instructionMix).find((item) => sameThread(item, thread));
    return toFiniteNumber(asArray(source?.[scope]).find((item) => item.name === eventName)?.value);
  }
  if (key.startsWith("hotspot.")) {
    const [, dimension, kind, encodedName] = key.split(".");
    const targetName = decodeURIComponent(encodedName);
    const source = asArray(scenario.hotspotInfo?.[dimension]).find((item) => sameThread(item, thread));
    if (!source) return null;
    return hotspotValueInThread(source, kind, targetName);
  }
  return getMetricValue(scenario, key, new Set([getThreadType(thread)]));
}

function hotspotValueInThread(thread, kind, targetName) {
  if (kind === "so") return toFiniteNumber(asArray(thread.sos).find((so) => so.name === targetName)?.value);
  const values = asArray(thread.sos)
    .flatMap((so) => asArray(so.funcs).filter((func) => func.name === targetName).map((func) => toFiniteNumber(func.value)))
    .filter((value) => value != null);
  return values.length ? Math.max(...values) : null;
}

function sameThread(a, b) {
  const aKey = normalizeThreadKey(a?.name);
  return !!aKey && aKey === normalizeThreadKey(b?.name) && threadEntityKind(a) === threadEntityKind(b);
}

function normalizeThreadKey(name) {
  return String(name || "")
    .normalize("NFKC")
    .trim()
    .replace(/线程$/u, "")
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}

function threadEntityKind(thread) {
  return /进程|process/iu.test(thread?.threadType || "") ? "process" : "thread";
}

function findTopdownNodeValue(groups, name) {
  for (const group of asArray(groups)) {
    for (const level2 of asArray(group.level2)) {
      if (level2.name === name) return toFiniteNumber(level2.value);
      const level3 = asArray(level2.level3).find((item) => item.name === name);
      if (level3) return toFiniteNumber(level3.value);
    }
  }
  return null;
}

function getThreadType(thread) {
  return canonicalThreadType(thread?.threadType);
}

function getThreadDisplayType(thread) {
  return thread?.threadType || "other";
}

function canonicalThreadType(type) {
  const text = displayText(type).trim().toLowerCase();
  if (!text || text === "na") return "other";
  if (text === "main_process" || /主逻辑进程|main[_\s-]*process/u.test(text)) return "main_process";
  if (text === "render_process" || /渲染进程|render[_\s-]*process/u.test(text)) return "render_process";
  if (text === "main" || /主逻辑线程|main/u.test(text)) return "main";
  if (text === "render" || /渲染线程|render/u.test(text)) return "render";
  if (text === "other" || /其他线程|other/u.test(text)) return "other";
  return "other";
}

function cardHeader(scenario) {
  const base = asObject(scenario.base);
  return h("div", { class: "card-head" }, [h("h3", {}, [displayText(base.name)]), h("span", {}, [displayText(base.platform)])]);
}

function badge(text) {
  return h("span", { class: "badge" }, [displayText(text)]);
}

function loadBadge(value) {
  return h("span", { class: "load-badge" }, [`负载 ${displayValue(value, "%")}`]);
}

function hotspotScoreBadge(dimension, value) {
  const label = { cycle: "负载占比", fe: "FE BOUND占比", be: "BE BOUND占比" }[dimension] || "占比";
  return h("span", { class: "load-badge" }, [`${label} ${displayValue(value, "%")}`]);
}

function threadTitle(thread, suffix = "") {
  return h("h4", {}, [threadDisplayLabel(thread), loadBadge(thread.loadShare), suffix]);
}

function topdownThreadTitle(thread) {
  return h("h4", { class: "topdown-thread-title" }, [
    h("span", { class: "thread-name-text" }, [threadDisplayLabel(thread)]),
    h("span", { class: "thread-meta-badges" }, [
      loadBadge(thread.loadShare),
      kernelShareBadge("内核占比(Inst)", kernelShareValue(thread, "inst")),
      kernelShareBadge("内核占比(Cycle)", kernelShareValue(thread, "cycle")),
    ]),
  ]);
}

function kernelShareBadge(label, value) {
  return h("span", { class: "kernel-share-badge" }, [`${label} ${displayValue(value, "%")}`]);
}

function threadDisplayLabel(thread) {
  return `${threadNameLabel(thread?.name)}-${threadTypeLabel(getThreadDisplayType(thread))}`;
}

function threadNameLabel(name) {
  const text = displayText(name);
  return `${text}${/线程$/u.test(text) ? "" : "线程"}`;
}

function threadTypeLabel(type) {
  const known = {
    main: "主逻辑线程",
    render: "渲染线程",
    other: "其他线程",
    main_process: "主逻辑进程",
    render_process: "渲染进程",
  };
  const canonical = canonicalThreadType(type);
  if (known[canonical]) return known[canonical];
  const text = displayText(type);
  return text && text !== "NA" ? text : "其他线程";
}

function infoRow(label, value) {
  return h("p", { class: "info-row" }, [h("span", {}, [label]), h("strong", {}, [displayText(value)])]);
}

function barChart(items, unit) {
  const safeItems = asArray(items);
  const max = Math.max(...safeItems.map((item) => toFiniteNumber(item.value) || 0), 1);
  return h("div", { class: "bars" }, safeItems.map((item, index) => h("div", { class: "bar-row" }, [
    h("span", {}, [displayText(item.name)]),
    h("div", { class: "bar-track" }, [h("i", { style: `width:${((toFiniteNumber(item.value) || 0) / max) * 100}%;background:${colors[index % colors.length]}` })]),
    h("b", {}, [displayValue(item.value, unit)]),
  ])));
}

function clusterStateRows(items) {
  return h("div", { class: "stacked-rows chart-panel chart-one cluster-state-rows" }, [
    h("div", { class: "chart-title" }, [
      h("strong", {}, ["cluster load overview"]),
      h("span", {}, ["running + idle = 100%"]),
    ]),
    ...asArray(items).map((item) => {
      const running = toFiniteNumber(item.value);
      const idle = running == null ? null : roundTwo(100 - running);
      const states = [
        { name: "running", value: running },
        { name: "idle", value: idle },
      ];
      return h("div", { class: "stack-line" }, [
        h("span", { class: "stack-label" }, [displayText(item.name)]),
        h("div", { class: "stack-content" }, [
          stackedBar(states),
          stackLegend(states),
        ]),
      ]);
    }),
  ]);
}

function stackedRows(rows, labelKey, title, subtitle, kind = "") {
  const chartClass = title.includes("thread") ? "chart-three" : "chart-two";
  return h("div", { class: `stacked-rows chart-panel ${chartClass}` }, [
    h("div", { class: "chart-title" }, [
      h("strong", {}, [title]),
      h("span", {}, [subtitle]),
    ]),
    ...asArray(rows).map((row) => h("div", { class: "stack-line" }, [
      h("span", { class: "stack-label" }, [displayText(row[labelKey])]),
      h("div", { class: "stack-content" }, [
        stackedBar(normalizeLoadStackItems(asArray(row.items), kind)),
        stackLegend(normalizeLoadStackItems(asArray(row.items), kind)),
      ]),
    ])),
  ]);
}

function normalizeLoadStackItems(items, kind = "") {
  return asArray(items).map((item) => ({
    ...item,
    name: kind === "process" && /^other(?:\s+process)?$/iu.test(displayText(item.name)) ? "other" : item.name,
  }));
}

function stackedBar(items) {
  const sortedItems = sortStackItems(items);
  return h("div", { class: "stacked-bar" }, sortedItems.map((item) => h("i", {
    title: `${displayText(item.name)} ${displayValue(item.value, "%")}`,
    style: `width:${safePercent(item.value)}%;background:${stackColor(item.name)}`,
  }, [safePercent(item.value) >= 14 ? displayValue(item.value, "%") : ""])));
}

function stackLegend(items) {
  const sortedItems = sortStackItems(items);
  return h("div", { class: "stack-legend" }, sortedItems.map((item) => h("span", {}, [
    h("i", { style: `background:${stackColor(item.name)}` }),
    `${displayText(item.name)}`,
    h("b", {}, [displayValue(item.value, "%")]),
  ])));
}

function sortStackItems(items) {
  return asArray(items).sort((a, b) => {
    const aPriority = stackItemPriority(a.name);
    const bPriority = stackItemPriority(b.name);
    if (aPriority !== bPriority) return aPriority - bPriority;
    return (toFiniteNumber(b.value) || 0) - (toFiniteNumber(a.value) || 0);
  });
}

function stackItemPriority(name) {
  const text = displayText(name);
  if (text === "idle") return 3;
  if (/^other\s+process$/iu.test(text) || /^other$/iu.test(text) || /^others$/iu.test(text)) return 2;
  if (/^other\s+thread$/iu.test(text)) return 1;
  return 0;
}

function stackColor(name) {
  const key = stackColorKey(name);
  return fixedStackColors[key] || stackColorMap.get(key) || colors[stableColorIndex(key)];
}

function stackColorKey(name) {
  return displayText(name).toLocaleLowerCase();
}

function stableColorIndex(value) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % colors.length;
}

function roundTwo(value) {
  const number = toFiniteNumber(value);
  return number == null ? null : Number(number.toFixed(2));
}

function median(values) {
  const sorted = asArray(values).map(toFiniteNumber).filter((value) => value != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? roundTwo(sorted[middle]) : roundTwo((sorted[middle - 1] + sorted[middle]) / 2);
}

function dualMetricBars(total, kernel, unit) {
  const order = ["IPC", "MPKI", "FE BOUND", "BE BOUND"];
  return h("div", { class: "dual-bars" }, order.map((key) => h("div", {}, [
    h("span", {}, [key === "IPC" ? "IPC" : `${key} (${unit})`]),
    h("div", { class: "bar-pair" }, [
      h("i", { class: "total", style: `width:${metricWidth(key, total[key])}%` }, [displayValue(total[key])]),
      h("i", { class: "kernel", style: `width:${metricWidth(key, kernel[key])}%` }, [displayValue(kernel[key])]),
    ]),
  ])));
}

function metricWidth(key, value) {
  const scale = key === "IPC" ? 28 : key === "MPKI" ? 12 : 4;
  const number = toFiniteNumber(value);
  return number == null ? 0 : Math.min(number * scale, 100);
}

function metricLegend() {
  return h("div", { class: "metric-legend" }, [
    h("span", {}, [h("i", { class: "total" }), "总体"]),
    h("span", {}, [h("i", { class: "kernel" }), "内核"]),
  ]);
}

function renderTopdownHierarchy(groups, level1) {
  const bottleneck = getBottleneckPath(groups, level1);
  return h("div", { class: "topdown-tree" }, [
    h("div", { class: "tree-note" }, ["总体 PMU level2 / level3 展开；内核 PMU 仅展示 level1"]),
    h("div", { class: "bottleneck-summary" }, [
      h("strong", {}, ["瓶颈链路"]),
      h("div", { class: "path-chips" }, [
        { level: "L1", name: bottleneck.metric, value: bottleneck.metricValue },
        { level: "L2", name: bottleneck.level2, value: bottleneck.level2Value },
        bottleneck.level3 ? { level: "L3", name: bottleneck.level3, value: bottleneck.level3Value } : null,
      ].filter(Boolean).map((item) => h("span", {}, [
        h("b", {}, [item.level]),
        h("em", {}, [item.name, item.value == null ? "" : ` ${displayMetric(item.value, "PKI", 1)}`]),
      ]))),
    ]),
    ...asArray(groups).map((group) => {
      const isGroupHot = group.metric === bottleneck.metric;
      return h("section", { class: `tree-group ${metricClass(group.metric)} ${group.kind === "diagnostic" ? "diagnostic" : ""} ${isGroupHot ? "hot-path" : ""}` }, [
      h("div", { class: "tree-group-title" }, [
        h("strong", {}, [group.metric]),
        h("span", {}, [group.unit]),
      ]),
      ...asArray(group.level2).map((level2) => {
        const isLevel2Hot = isGroupHot && level2.name === bottleneck.level2;
        return h("div", { class: `tree-level2 ${isLevel2Hot ? "hot-path" : ""}` }, [
        h("div", { class: "tree-row" }, [
          h("b", {}, [level2.name]),
          h("span", {}, [displayValue(level2.value)]),
        ]),
        asArray(level2.level3).length ? h("div", { class: "tree-level3" }, asArray(level2.level3).map((level3) => h("div", { class: `tree-row ${isLevel2Hot && level3.name === bottleneck.level3 ? "hot-path" : ""}` }, [
          h("b", {}, [level3.name]),
          h("span", {}, [displayValue(level3.value)]),
        ]))) : "",
      ]);
      }),
    ]);
    }),
  ]);
}

function getBottleneckPath(groups, level1) {
  const metric = ["MPKI", "FE BOUND", "BE BOUND"].sort((a, b) => (toFiniteNumber(level1[b]) || 0) - (toFiniteNumber(level1[a]) || 0))[0];
  const group = asArray(groups).find((item) => item.metric === metric) || asArray(groups)[0];
  const level2 = [...asArray(group?.level2)].sort((a, b) => (toFiniteNumber(b.value) || 0) - (toFiniteNumber(a.value) || 0))[0];
  const level3 = [...asArray(level2?.level3)].sort((a, b) => (toFiniteNumber(b.value) || 0) - (toFiniteNumber(a.value) || 0))[0];
  return {
    metric: group?.metric || metric || "NA",
    metricValue: toFiniteNumber(level1[group?.metric || metric]),
    level2: level2?.name || "NA",
    level2Value: toFiniteNumber(level2?.value),
    level3: level3?.name,
    level3Value: toFiniteNumber(level3?.value),
  };
}

function metricClass(metric) {
  return String(metric || "na").toLowerCase().replaceAll(" ", "-").replaceAll("&", "and");
}

function hizeeTable(rows) {
  const safeRows = [asObject(rows[0]), asObject(rows[1]), asObject(rows[2])];
  const scene = safeRows[0];
  const clusters = [
    ["小核cluster", "littleFreq", "littleRunning"],
    ["中核cluster", "midFreq", "midRunning"],
    ["大核cluster", "bigFreq", "bigRunning"],
  ];
  return h("div", { class: "table-wrap hizee-matrix-wrap" }, [
    h("div", { class: "scroll-hint" }, ["Hizee 指标按进程级 / cluster级 / 场景级分层展示"]),
    h("table", { class: "hizee-matrix" }, [
      h("thead", {}, [
        h("tr", {}, [
          h("th", { rowspan: 2 }, ["Cluster"]),
          h("th", { colspan: 3 }, ["进程级负载特征"]),
          h("th", { colspan: 1 }, ["Cluster级特征"]),
          h("th", { colspan: 4 }, ["场景级特征"]),
        ]),
        h("tr", {}, [
          h("th", {}, ["所有进程 running占比(%)"]),
          h("th", {}, ["UI进程 running占比(%)"]),
          h("th", {}, ["render service running占比(%)"]),
          h("th", {}, ["平均频率(Mhz)"]),
          h("th", {}, ["平均帧率(fps)"]),
          h("th", {}, ["DDR平均频率(Mhz)"]),
          h("th", {}, ["平均带宽(GB/s)"]),
          h("th", {}, ["平均latency(ns)"]),
        ]),
      ]),
      h("tbody", {}, clusters.map(([cluster, freqField, runningField], index) => h("tr", {}, [
        h("td", { class: "cluster-cell" }, [cluster]),
        h("td", { class: "process-metric" }, [displayValue(safeRows[0][runningField])]),
        h("td", { class: "process-metric" }, [displayValue(safeRows[1][runningField])]),
        h("td", { class: "process-metric" }, [displayValue(safeRows[2][runningField])]),
        h("td", { class: "cluster-metric" }, [displayValue(scene[freqField])]),
        ...(index === 0 ? [
          h("td", { rowspan: 3, class: "scene-cell" }, [displayValue(scene.fps)]),
          h("td", { rowspan: 3, class: "scene-cell" }, [displayValue(scene.ddrFreq)]),
          h("td", { rowspan: 3, class: "scene-cell" }, [displayValue(scene.bandwidth)]),
          h("td", { rowspan: 3, class: "scene-cell" }, [displayValue(scene.latency)]),
        ] : []),
      ]))),
    ]),
  ]);
}

function miniTable(headers, rows, scrollHint = "") {
  return h("div", { class: "table-wrap" }, [
    scrollHint ? h("div", { class: "scroll-hint" }, [scrollHint]) : "",
    h("table", {}, [
      h("thead", {}, [h("tr", {}, headers.map((header) => h("th", {}, [header])))]),
      h("tbody", {}, rows.map((row) => h("tr", {}, row.map((cell) => h("td", {}, [displayText(cell)]))))),
    ]),
  ]);
}

function instructionTable(thread) {
  const total = asArray(thread.total);
  const kernel = asArray(thread.kernel);
  return h("div", { class: "table-wrap compact-table-wrap" }, [
    h("table", { class: "compact-table" }, [
      h("thead", {}, [h("tr", {}, ["事件/PKI", "总体", "内核态"].map((header) => h("th", {}, [header])))]),
      h("tbody", {}, total.map((item, index) => h("tr", {}, [
        h("td", { title: displayText(item.name).toUpperCase() }, [displayText(item.name).toUpperCase()]),
        h("td", {}, [displayValue(item.value)]),
        h("td", {}, [displayValue(kernel[index]?.value)]),
      ]))),
    ]),
  ]);
}

function trendChart(rows, unit, compact = false) {
  const safeRows = asArray(rows).filter(hasTrendValue);
  const max = Math.max(...safeRows.map((row) => toFiniteNumber(row.value) || 0), 1);
  return h("div", { class: compact ? "trend-chart trend-chart-compact" : "trend-chart" }, safeRows.map((row, index) => h("div", { class: "trend-item" }, [
    h("div", { class: "trend-label" }, [
      h("strong", {}, [displayText(row.label || row.scenario?.base?.name)]),
      h("small", {}, [displayText(row.detail || row.scenario?.base?.platform)]),
    ]),
    h("div", { class: "trend-track" }, [
      h("div", { class: "trend-bar", style: `width:${toFiniteNumber(row.value) == null ? 0 : Math.max(2, (row.value / max) * 100)}%;background:${colors[index % colors.length]}` }),
    ]),
    h("b", {}, [displayValue(row.value)]),
  ])));
}

render();
} catch (error) {
  renderBootError(error);
}
})();
