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

const state = {
  page: "compare",
  compareFilters: {},
  trendFilters: {},
  selectedIds: new Set(scenarios.slice(0, 3).map((item) => item.id)),
  trendMetric: initialTrendMetric.key,
  trendCategory: getTrendMetricCategory(initialTrendMetric.key),
  threadTypes: new Set(["main", "render", "other"]),
  expandedTopdownThreadIndexes: new Set(),
  expandedHotspotThreadIndexes: new Set(),
  savedTrends: [],
};

const colors = ["#2563eb", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6", "#64748b"];

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

function toFiniteNumber(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function displayValue(value, suffix = "") {
  const number = toFiniteNumber(value);
  if (number == null) return "NA";
  const abs = Math.abs(number);
  const text = abs > 0 && abs < 0.01
    ? number.toFixed(6).replace(/\.?0+$/u, "")
    : roundTwo(number).toFixed(2);
  return `${text}${suffix}`;
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
        navButton("对比展示", "compare"),
        navButton("特征汇总", "trend"),
      ]),
    ]),
  );
  page.append(state.page === "compare" ? renderComparePage() : renderTrendPage());
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
    renderCompareSection("2. 负载信息", active, renderLoadCard),
    renderCompareSection("3. TOPDOWN 信息", active, renderTopdownCard),
    renderCompareSection("4. 指令分布信息", active, renderInstructionCard),
    renderCompareSection("5. 系统调用信息", active, renderSyscallCard),
    renderCompareSection("6. 热点与瓶颈 SO/函数", active, renderHotspotCard),
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

function renderLoadCard(scenario) {
  const loadInfo = asObject(scenario.loadInfo);
  return h("article", { class: "card" }, [
    cardHeader(scenario),
    h("h4", {}, ["Trace 三视图"]),
    clusterStateRows(asArray(loadInfo.clusterRunning)),
    stackedRows(asArray(loadInfo.processRunning), "cluster", "cluster process overview", "累计前 80% 热点进程，其他合并为 other process"),
    stackedRows(asArray(loadInfo.threadRunning), "cluster", "cluster thread overview", "继承 other process；前 80% 进程内线程再聚合 other thread"),
    h("h4", {}, ["Hizee 指标矩阵"]),
    hizeeTable(asArray(loadInfo.hizeeRows)),
  ]);
}

function renderTopdownCard(scenario) {
  return h("article", { class: "card" }, [
    cardHeader(scenario),
    ...asArray(scenario.topdownInfo).map((thread, threadIndex) => {
      const body = [
        threadTitle(thread),
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
        h("b", {}, [`${threadIndex + 1}. `, threadNameLabel(thread.name)]),
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
  const trendValues = trendRows.map((row) => toFiniteNumber(row.value)).filter((value) => value != null);
  const averageValue = trendValues.length ? roundTwo(trendValues.reduce((sum, value) => sum + value, 0) / trendValues.length) : null;
  const snapshotKey = getTrendSnapshotKey(metric, trendRows);
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
          h("span", {}, [`平均值：${displayValue(averageValue)}`]),
          h("span", {}, [`单位：${metric.unit || "-"}`]),
          h("button", {
            class: isSaved ? "keep-trend saved" : "keep-trend",
            disabled: isSaved,
            onclick: () => saveCurrentTrend(metric, trendRows, averageValue, snapshotKey),
          }, [isSaved ? "已保留" : "保留当前结果"]),
        ]),
      ]),
      trendChart(trendRows, metric.unit),
      isThreadMetric && state.trendCategory === "hotspot"
        ? miniTable(["场景名称", "线程名", "平台", "线程类型", "来源维度", metric.label], trendRows.map((row) => [
          row.scenario.base.name,
          row.thread.name,
          row.scenario.base.platform,
          threadTypeLabel(row.thread.threadType),
          row.sourceDimension,
          displayValue(row.value),
        ]))
        : isThreadMetric
        ? miniTable(["应用_场景_线程名", "平台", "场景类型", "线程类型", metric.label], trendRows.map((row) => [
          row.label,
          row.scenario.base.platform,
          row.scenario.base.type,
          threadTypeLabel(row.thread.threadType),
          displayValue(row.value),
        ]))
        : miniTable(["场景名称", "平台", "场景类型", metric.label], trendRows.map((row) => [
          row.label,
          row.scenario.base.platform,
          row.scenario.base.type,
          displayValue(row.value),
        ])),
    ]),
    state.savedTrends.length ? renderSavedTrends() : "",
  ]);
}

function getTrendMetricCategory(key) {
  if (key.startsWith("topdown.")) return "topdown";
  if (key.startsWith("inst.")) return "instruction";
  if (key.startsWith("syscall.")) return "syscall";
  if (key.startsWith("hotspot.")) return "hotspot";
  return "load";
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
  return scenario.topdownInfo.filter((thread) => state.threadTypes.has(getThreadType(thread)));
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
    h("span", {}, ["线程类型"]),
    h("div", { class: "thread-type-options" }, [
      threadTypeOption("main", "主逻辑线程", true),
      threadTypeOption("render", "渲染线程", true),
      threadTypeOption("other", "其他线程", true),
    ]),
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
  return a?.name === b?.name && getThreadType(a) === getThreadType(b);
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
  if (thread?.threadType) return thread.threadType;
  if (["UnityMain", "MainThread", "ActivityThread", "AiWorker"].includes(thread?.name)) return "main";
  if (thread?.name === "RenderThread") return "render";
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
  return h("h4", {}, [threadNameLabel(thread.name), loadBadge(thread.loadShare), suffix]);
}

function threadNameLabel(name) {
  const text = displayText(name);
  return `${text}${/线程$/u.test(text) ? "" : "线程"}`;
}

function threadTypeLabel(type) {
  return { main: "主逻辑线程", render: "渲染线程", other: "其他线程" }[type] || "其他线程";
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

function stackedRows(rows, labelKey, title, subtitle) {
  const chartClass = title.includes("thread") ? "chart-three" : "chart-two";
  return h("div", { class: `stacked-rows chart-panel ${chartClass}` }, [
    h("div", { class: "chart-title" }, [
      h("strong", {}, [title]),
      h("span", {}, [subtitle]),
    ]),
    ...asArray(rows).map((row) => h("div", { class: "stack-line" }, [
      h("span", { class: "stack-label" }, [displayText(row[labelKey])]),
      h("div", { class: "stack-content" }, [
        stackedBar(asArray(row.items)),
        stackLegend(asArray(row.items)),
      ]),
    ])),
  ]);
}

function stackedBar(items) {
  const sortedItems = sortStackItems(items);
  return h("div", { class: "stacked-bar" }, sortedItems.map((item, index) => h("i", {
    title: `${displayText(item.name)} ${displayValue(item.value, "%")}`,
    style: `width:${safePercent(item.value)}%;background:${stackColor(item.name, index)}`,
  }, [safePercent(item.value) >= 14 ? displayValue(item.value, "%") : ""])));
}

function stackLegend(items) {
  const sortedItems = sortStackItems(items);
  return h("div", { class: "stack-legend" }, sortedItems.map((item, index) => h("span", {}, [
    h("i", { style: `background:${stackColor(item.name, index)}` }),
    `${displayText(item.name)}`,
    h("b", {}, [displayValue(item.value, "%")]),
  ])));
}

function sortStackItems(items) {
  return asArray(items).sort((a, b) => {
    const aIdle = a.name === "idle";
    const bIdle = b.name === "idle";
    if (aIdle && !bIdle) return 1;
    if (!aIdle && bIdle) return -1;
    const aOther = /^others?$|^other /i.test(a.name);
    const bOther = /^others?$|^other /i.test(b.name);
    if (aOther && !bOther) return 1;
    if (!aOther && bOther) return -1;
    return (toFiniteNumber(b.value) || 0) - (toFiniteNumber(a.value) || 0);
  });
}

function stackColor(name, index) {
  const fixed = {
    running: "#86efac",
    idle: "#334155",
    "other process": "#64748b",
    "other thread": "#94a3b8",
    others: "#64748b",
  };
  return fixed[name] || colors[index % colors.length];
}

function roundTwo(value) {
  const number = toFiniteNumber(value);
  return number == null ? null : Number(number.toFixed(2));
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
        { level: "L1", name: bottleneck.metric },
        { level: "L2", name: bottleneck.level2 },
        bottleneck.level3 ? { level: "L3", name: bottleneck.level3 } : null,
      ].filter(Boolean).map((item) => h("span", {}, [
        h("b", {}, [item.level]),
        h("em", {}, [item.name]),
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
    level2: level2?.name || "NA",
    level3: level3?.name,
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
  const safeRows = asArray(rows);
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
