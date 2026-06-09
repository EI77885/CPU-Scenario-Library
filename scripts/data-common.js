export const clusters = ["小核", "中核", "大核"];

export const categoryDirs = [
  {
    dir: "01_game",
    type: "游戏",
    scenarios: ["wzry_replay", "yuanshen_xumi", "qqfeiche_replay"],
  },
  {
    dir: "02_app",
    type: "应用",
    scenarios: ["douyin_video", "weixin_browse", "taobao_shopping"],
  },
  {
    dir: "03_coldstart",
    type: "冷启动",
    scenarios: ["jingdong_coldstartup", "qunar_coldstartup", "ctrip_coldstartup"],
  },
  {
    dir: "04_AIandAgent",
    type: "AI",
    scenarios: ["codex_vibecoding", "chatgpt_chat"],
  },
  {
    dir: "05_camera",
    type: "camera",
    scenarios: ["camera_preview", "camera_video"],
  },
];

export const threadTypeLabels = {
  main: "主逻辑线程",
  render: "渲染线程",
  other: "其他线程",
};

export const instructionEvents = [
  "ld/st_retired",
  "br_retired",
  "dp_spec",
  "vfp_spec",
  "ase_spec",
  "sve_inst_spec",
  "ld/strex_spec",
  "atomic/cas_spec",
  "barrier_spec",
  "unaligned_ldst_spec",
];

export const topdownLevel1 = ["IPC", "MPKI", "FE BOUND", "BE BOUND"];

export const topdownNodes = [
  "BAD_INST_SPEC",
  "BR_IMMED_MIS_PRED_RETIRED",
  "BR_COND_MID_PRED_RETIRED",
  "BR_IND_MIS_PRED_RETIRED",
  "BR_INDNR_MIS_PRED_RETIRED",
  "STALL_FRONTEND_MEMBOUND",
  "STALL_FRONTEND_L1I",
  "STALL_FRONTEND_MEM",
  "STALL_FRONTEND_TLB",
  "STALL_FRONTEND_CPUBOUND_PKI",
  "STALL_FRONTEND_FLOW",
  "STALL_FRONTEND_FLUSH",
  "STALL_FRONTEND_RENAME",
  "STALL_BACKEND_MEMBOUND",
  "STALL_BACKEND_L1D",
  "STALL_BACKEND_MEM",
  "STALL_BACKEND_TLB",
  "STALL_BACKEND_ST",
  "STALL_BACKEND_BUSY",
  "STALL_BACKEND_ILOCK",
  "L1D_CACHE_REFILL",
  "L1D_CACHE_REFILL_RD",
  "L1I_CACHE_REFILL",
  "L2D_CACHE_REFILL",
  "L2D_CACHE_REFILL_RD",
  "L2I_CACHE_REFILL",
  "L3D_CACHE_REFILL",
  "L3D_CACHE_REFILL_RD",
  "L1D_TLB_REFILL_RD",
  "L1I_TLB_REFILL",
  "L2D_TLB_REFILL_RD",
  "L2I_TLB_REFILL",
  "L2D_CACHE_REFILL_PRFM",
  "L2D_CACHE_REFILL_HWPRF",
  "L3D_CACHE_REFILL_PRFM",
  "L3D_CACHE_REFILL_HWPRF",
  "PAGE_FAULTS_PMI",
  "MEMSTALL_ANYSTORE",
  "MEMSTALL_ANYLOAD",
  "MEMSTALL_L1MISS",
  "MEMSTALL_L2MISS",
  "MEMSTALL_L3MISS",
];

export const syscallPool = [
  "futex",
  "write",
  "ioctl",
  "close",
  "fcntl",
  "epoll_pwait",
  "read",
  "mmap",
  "mprotect",
  "recvmsg",
  "sendmsg",
  "poll",
  "nanosleep",
  "openat",
  "getpid",
  "clock_gettime",
  "munmap",
  "rt_sigprocmask",
  "sched_yield",
  "prctl",
];

export const filterFields = [
  ["type", "场景类型"],
  ["name", "场景名称"],
  ["appVersion", "应用版本"],
  ["platform", "抓取平台"],
  ["imageVersion", "镜像版本"],
];

export function normalizeMetricName(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/_PKI$/u, "")
    .replace(/[\\/\s_-]+/gu, "");
}

export function round(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : 0;
}

export function sortStackItems(items) {
  return [...items].sort((a, b) => {
    const aIdle = a.name === "idle";
    const bIdle = b.name === "idle";
    if (aIdle && !bIdle) return 1;
    if (!aIdle && bIdle) return -1;
    const aOther = /^others?$|^other(?:\s+|$)/iu.test(a.name);
    const bOther = /^others?$|^other(?:\s+|$)/iu.test(b.name);
    if (aOther && !bOther) return 1;
    if (!aOther && bOther) return -1;
    return b.value - a.value;
  });
}

export function makeStack(names, seed, total = 100) {
  const raw = names.map((name, index) => ({
    name,
    value: Math.max(4, Math.sin(seed + index * 1.7) * 18 + 22 - index * 2),
  }));
  const sum = raw.reduce((acc, item) => acc + item.value, 0);
  return sortStackItems(raw.map((item) => ({ name: item.name, value: round((item.value / sum) * total) })));
}

function top80Stack(names, seed, running, otherName) {
  const baseNames = names.filter((name) => name !== otherName);
  const raw = baseNames.map((name, index) => ({
    name,
    value: Math.max(4, Math.sin(seed + index * 1.7) * 18 + 22 - index * 2),
  })).sort((a, b) => b.value - a.value);
  const sum = raw.reduce((acc, item) => acc + item.value, 0);
  let included = 0;
  const selected = [];
  for (const item of raw) {
    const share = item.value / sum;
    if (selected.length < 5 && included < 0.8) {
      selected.push({ name: item.name, value: round(share * running) });
      included += share;
    }
  }
  const selectedTotal = selected.reduce((acc, item) => acc + item.value, 0);
  const other = round(Math.max(0, running - selectedTotal));
  return sortStackItems(other > 0 ? [...selected, { name: otherName, value: other }] : selected);
}

export function flattenScenarios() {
  return categoryDirs.flatMap((category) =>
    category.scenarios.map((name) => ({
      dir: category.dir,
      type: category.type,
      name,
    })),
  );
}

export function buildScenario(row, index) {
  const seed = index + 1;
  const appName = row.name.split("_")[0];
  const versionMajor = row.type === "游戏" ? "10" : row.type === "AI" ? "1" : row.type === "camera" ? "3" : "8";
  const platform = ["Kirin-Next", "Snapdragon-X", "Tensor-Mobile"][index % 3];
  const imagePrefix = platform === "Kirin-Next" ? "KRN" : platform === "Snapdragon-X" ? "SDX" : "TMO";
  const sceneText = row.name.replace("_", " ");
  const base = {
    type: row.type,
    name: row.name,
    appVersion: `${versionMajor}.${(seed % 8) + 1}.${(seed * 3) % 10}`,
    description: `${sceneText} CPU 场景库采集窗口，持续 ${8 + (seed % 5)} 分钟`,
    config: row.type === "冷启动" ? "清后台连续 20 次，取稳定窗口" : row.type === "camera" ? "默认相机参数，稳定预览/录像" : "freerun，固定脚本路线，自动亮度",
    platform,
    imageVersion: `${imagePrefix}-2026.05.${String(8 + seed).padStart(2, "0")}`,
    archivePath: `/archive/${row.type}/${appName}/${row.name}/${platform.toLowerCase()}`,
  };
  const clusterRunning = clusters.map((cluster, i) => ({
    cluster,
    running: round(29 + seed * 2.5 + i * 11 + Math.sin(seed + i) * 4),
    idle: 0,
  })).map((item) => ({ ...item, idle: round(100 - item.running) }));
  const processNames = [appName, "render_service", "system_server", "surfaceflinger", "binder", "system_ui", "media_server"];
  const threadNames = ["main_thread", "render_thread", "worker_thread", "binder_thread", "io_thread", "gpu_worker", "jit_thread"];
  const processRunning = clusters.map((cluster, i) => ({
    cluster,
    items: sortStackItems([...top80Stack(processNames, seed + i, clusterRunning[i].running, "other"), { name: "idle", value: clusterRunning[i].idle }]),
  }));
  const threadRunning = clusters.map((cluster, i) => {
    const otherProcess = processRunning[i].items.find((item) => item.name === "other")?.value || 0;
    const threadBudget = Math.max(0, round(clusterRunning[i].running - otherProcess));
    return {
      cluster,
      items: sortStackItems([
        ...top80Stack(threadNames, seed + i * 0.8, threadBudget, "other thread"),
        { name: "other process", value: otherProcess },
        { name: "idle", value: clusterRunning[i].idle },
      ]),
    };
  });
  const hizee = {
    scene: {
      fps: round(row.type === "游戏" ? 58 + seed * 0.9 : row.type === "冷启动" ? 0 : 35 + seed * 0.6, 1),
      ddrFreqMhz: Math.round(2200 + seed * 65),
      bandwidth: round(8.2 + seed * 0.72, 1),
      latency: round(118 - seed * 2.4, 1),
    },
    clusters: clusters.map((cluster, i) => ({
      cluster,
      avgFreqMhz: Math.round(850 + seed * 45 + i * 520),
      allProcessRunning: round(clusterRunning[i].running),
      uiProcessRunning: round(clusterRunning[i].running * 0.62),
      renderServiceRunning: round(clusterRunning[i].running * 0.38),
    })),
  };
  const threadTemplates = {
    游戏: ["UnityMain", "RenderThread", "BinderWorker"],
    应用: ["MainThread", "RenderThread", "BinderWorker"],
    冷启动: ["ActivityThread", "PackageParser", "BinderWorker"],
    AI: ["AgentWorker", "RenderThread", "RpcWorker"],
    camera: ["CameraMain", "PreviewRender", "CodecWorker"],
  };
  const names = threadTemplates[row.type] || threadTemplates.应用;
  const threads = ["main", "render", "other"].map((threadType, t) => ({
    id: `${row.name}-${threadType}`,
    name: names[t],
    threadType,
    loadShare: round(36 + seed * 0.9 - t * 7.1),
    rank: t + 1,
  }));
  return {
    id: `scenario-${String(index + 1).padStart(3, "0")}`,
    sourceDir: row.dir,
    base,
    loadInfo: { clusterOverview: clusterRunning, processOverview: processRunning, threadOverview: threadRunning, hizee },
    threads,
    topdown: threads.flatMap((thread, t) => makeTopdownRows(thread, seed, t)),
    instructions: threads.flatMap((thread, t) => makeInstructionRows(thread, seed, t)),
    syscalls: threads.map((thread, t) => makeSyscallRow(thread, seed, t)),
    hotspots: ["cycle", "fe", "be"].flatMap((dimension, d) => makeHotspotRows(threads, seed, dimension, d)),
  };
}

function makeTopdownRows(thread, seed, threadIndex) {
  const level1 = {
    IPC: round(2.8 - seed * 0.04 - threadIndex * 0.08, 2),
    MPKI: round(3.2 + seed * 0.45 + threadIndex * 0.4),
    "FE BOUND": round(15 + seed * 1.3 + threadIndex * 1.6),
    "BE BOUND": round(9 + seed * 1.0 + threadIndex * 1.2),
  };
  const kernel = {
    IPC: round(1.65 - seed * 0.02 - threadIndex * 0.04, 2),
    MPKI: round(1.4 + seed * 0.22 + threadIndex * 0.25),
    "FE BOUND": round(6.5 + seed * 0.72 + threadIndex),
    "BE BOUND": round(5 + seed * 0.63 + threadIndex * 0.9),
  };
  const value = (base, step = 0.31) => round(base + seed * step + threadIndex * 0.4);
  const hierarchy = [
    ["MPKI", [
      ["BAD_INST_SPEC", value(0.8, 0.1)],
      ["BR_IMMED_MIS_PRED_RETIRED", value(0.5, 0.08)],
      ["BR_COND_MID_PRED_RETIRED", value(1.1, 0.12)],
      ["BR_IND_MIS_PRED_RETIRED", value(0.7, 0.09)],
      ["BR_INDNR_MIS_PRED_RETIRED", value(0.4, 0.07)],
    ]],
    ["FE BOUND", [
      ["STALL_FRONTEND_MEMBOUND", value(4.2), null],
      ["STALL_FRONTEND_L1I", value(1.4, 0.12), "STALL_FRONTEND_MEMBOUND"],
      ["STALL_FRONTEND_MEM", value(1.8, 0.16), "STALL_FRONTEND_MEMBOUND"],
      ["STALL_FRONTEND_TLB", value(0.7, 0.08), "STALL_FRONTEND_MEMBOUND"],
      ["STALL_FRONTEND_CPUBOUND_PKI", value(7.4), null],
      ["STALL_FRONTEND_FLOW", value(1.1, 0.1), "STALL_FRONTEND_CPUBOUND_PKI"],
      ["STALL_FRONTEND_FLUSH", value(1.0, 0.1), "STALL_FRONTEND_CPUBOUND_PKI"],
      ["STALL_FRONTEND_RENAME", value(3.6, 0.2), "STALL_FRONTEND_CPUBOUND_PKI"],
    ]],
    ["BE BOUND", [
      ["STALL_BACKEND_MEMBOUND", value(3.6), null],
      ["STALL_BACKEND_L1D", value(1.5, 0.13), "STALL_BACKEND_MEMBOUND"],
      ["STALL_BACKEND_MEM", value(2.3, 0.18), "STALL_BACKEND_MEMBOUND"],
      ["STALL_BACKEND_TLB", value(0.9, 0.08), "STALL_BACKEND_MEMBOUND"],
      ["STALL_BACKEND_ST", value(1.0, 0.09), "STALL_BACKEND_MEMBOUND"],
      ["STALL_BACKEND_BUSY", value(3.4), null],
      ["STALL_BACKEND_ILOCK", value(2.2), null],
    ]],
  ];
  return [
    ...Object.entries(level1).map(([metric, metricValue]) => ({ threadId: thread.id, scope: "total", level: 1, metric, parent: "", value: metricValue })),
    ...Object.entries(kernel).map(([metric, metricValue]) => ({ threadId: thread.id, scope: "kernel", level: 1, metric, parent: "", value: metricValue })),
    ...hierarchy.flatMap(([parentMetric, rows]) => rows.map(([metric, metricValue, parent]) => ({
      threadId: thread.id,
      scope: "total",
      level: parent ? 3 : 2,
      metric,
      parent: parent || parentMetric,
      value: metricValue,
    }))),
    ...topdownNodes.filter((name) => name.startsWith("L") || name.startsWith("MEMSTALL") || name === "PAGE_FAULTS_PMI").map((metric, i) => ({
      threadId: thread.id,
      scope: "total",
      level: 2,
      metric,
      parent: metric.startsWith("MEMSTALL") ? "LINX MEMSTALL PKI" : metric.includes("TLB") || metric.includes("PRFM") || metric.includes("HWPRF") || metric === "PAGE_FAULTS_PMI" ? "TLB REFILL & PREFETCH PKI" : "CACHE REFILL PKI",
      value: value(0.3 + i * 0.08, 0.04),
    })),
  ];
}

function makeInstructionRows(thread, seed, threadIndex) {
  return instructionEvents.flatMap((event, i) => [
    { threadId: thread.id, scope: "total", event, value: round(1.4 + seed * 0.24 + threadIndex * 0.48 + i * 0.31) },
    { threadId: thread.id, scope: "kernel", event, value: round(0.42 + seed * 0.1 + threadIndex * 0.17 + i * 0.11) },
  ]);
}

function makeSyscallRow(thread, seed, threadIndex) {
  const calls = makeStack(
    Array.from({ length: 7 }, (_, i) => syscallPool[(seed + threadIndex + i * 3) % syscallPool.length]),
    seed + threadIndex,
    91,
  ).slice(0, 5).map((item, i) => ({
    rank: i + 1,
    number: 40 + ((seed + threadIndex + i * 19) % 260),
    name: item.name,
    share: item.value,
  }));
  const used = calls.reduce((sum, call) => sum + call.share, 0);
  calls.push({ rank: 6, number: 0, name: "others", share: round(100 - used) });
  return { threadId: thread.id, density: round(42 + seed * 8 + threadIndex * 13), calls };
}

function makeHotspotRows(threads, seed, dimension, dimensionIndex) {
  const soPool = ["libunity.so", "libhwui.so", "libart.so", "libil2cpp.so", "libc.so", "libGLESv2.so", "libbinder.so", "libskia.so", "libcamera_client.so"];
  const funcPool = ["RenderFrame", "ScheduleTask", "DoSyscall", "WaitFence", "UpdateScene", "BinderTransact", "TextureUpload", "PhysicsStep", "EncodeFrame"];
  return threads.map((thread, threadIndex) => ({
    dimension,
    threadId: thread.id,
    rank: threadIndex + 1,
    score: round(thread.loadShare * (1 + dimensionIndex * 0.12)),
    sos: Array.from({ length: 3 }, (_, soIndex) => ({
      rank: soIndex + 1,
      name: soPool[(seed + threadIndex + dimensionIndex + soIndex * 2) % soPool.length],
      value: round(34 - soIndex * 7 + seed + threadIndex * 1.5),
      functions: Array.from({ length: 3 }, (_, funcIndex) => ({
        rank: funcIndex + 1,
        name: `${dimension}_${funcPool[(seed + threadIndex * 2 + dimensionIndex + soIndex + funcIndex * 2) % funcPool.length]}`,
        value: round(18 - funcIndex * 3.2 + seed * 0.75 + threadIndex + soIndex * 0.5),
      })),
    })),
  }));
}

export function buildDataset() {
  return flattenScenarios().map(buildScenario);
}
