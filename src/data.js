(() => {
const clusters = ["小核", "中核", "大核"];
const processNames = ["game", "render", "ui", "binder", "system", "media"];
const threadNames = ["main", "renderThread", "worker", "binder", "io", "gpuWorker"];
const instructionEvents = [
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
const syscallPool = [
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

const baseScenarios = [
  ["游戏", "原神_xumi", "5.0.1", "开放世界跑图，须弥城 10 分钟 freerun", "60fps, 高画质, 固定路线", "Kirin-Next", "KRN-2026.05.11", "/archive/genshin/xumi/kirin-next"],
  ["游戏", "王者荣耀_replay", "10.2.2", "5v5 团战录像回放，持续 8 分钟", "极致画质, 120fps, replay", "Snapdragon-X", "SDX-2026.05.08", "/archive/hok/replay/sdx"],
  ["应用", "抖音_video", "34.1.0", "短视频连续滑动和播放", "Wi-Fi, 自动亮度, 15 分钟", "Tensor-Mobile", "TMO-2026.05.06", "/archive/douyin/video/tensor"],
  ["应用", "微信_browse", "8.0.58", "公众号文章浏览和图片加载", "冷缓存, 连续浏览 30 篇", "Kirin-Next", "KRN-2026.05.12", "/archive/wechat/browse/kirin-next"],
  ["冷启动", "淘宝_coldstart", "10.48.1", "清后台后首页冷启动", "连续 20 次, 统计中位数窗口", "Snapdragon-X", "SDX-2026.05.10", "/archive/taobao/coldstart/sdx"],
  ["AI", "相册_ai_edit", "2.9.4", "端侧 AI 抠图和增强", "4K 图片, NPU offload on", "Tensor-Mobile", "TMO-2026.05.14", "/archive/gallery/ai-edit/tensor"],
  ["游戏", "原神_xumi", "5.0.1", "同场景跨平台对比采集", "60fps, 高画质, 固定路线", "Snapdragon-X", "SDX-2026.05.13", "/archive/genshin/xumi/sdx"],
  ["应用", "抖音_video", "34.1.0", "同场景跨平台滑动播放", "Wi-Fi, 自动亮度, 15 分钟", "Kirin-Next", "KRN-2026.05.15", "/archive/douyin/video/kirin-next"],
];

function round(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : 0;
}

function makeStack(names, seed, total = 100) {
  const raw = names.map((name, index) => ({
    name,
    value: Math.max(4, Math.sin(seed + index * 1.7) * 18 + 22 - index * 2),
  }));
  const sum = raw.reduce((acc, item) => acc + item.value, 0);
  return raw
    .map((item) => ({ name: item.name, value: round((item.value / sum) * total) }))
    .sort(compareStackItems);
}

function makeTop80Stack(names, seed, running, otherName) {
  const raw = names.map((name, index) => ({
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
  return (other > 0 ? [...selected, { name: otherName, value: other }] : selected).sort(compareStackItems);
}

function makeSyscalls(seed) {
  const start = seed % syscallPool.length;
  const candidates = Array.from({ length: 8 }, (_, index) => syscallPool[(start + index * 3) % syscallPool.length]);
  const top5 = makeStack(candidates, seed, 92).slice(0, 5);
  const used = round(top5.reduce((sum, item) => sum + item.value, 0));
  return [...top5, { name: "others", value: round(100 - used) }].sort(compareStackItems);
}

function compareStackItems(a, b) {
  const aIdle = a.name === "idle";
  const bIdle = b.name === "idle";
  if (aIdle && !bIdle) return 1;
  if (!aIdle && bIdle) return -1;
  const aOther = /^others?$|^other /i.test(a.name);
  const bOther = /^others?$|^other /i.test(b.name);
  if (aOther && !bOther) return 1;
  if (!aOther && bOther) return -1;
  return b.value - a.value;
}

function makeScenario(row, index) {
  const [type, name, appVersion, description, config, platform, imageVersion, archivePath] = row;
  const seed = index + 1;
  const clusterRunning = clusters.map((cluster, i) => ({
    name: cluster,
    value: round(28 + seed * 3 + i * 12 + Math.sin(seed + i) * 5),
  }));
  const processRunning = clusters.map((cluster, i) => {
    const running = clusterRunning[i].value;
    const idle = round(100 - running);
    return {
      cluster,
      items: [...makeTop80Stack(processNames, seed + i, running, "other process"), { name: "idle", value: idle }].sort(compareStackItems),
    };
  });
  const threadRunning = clusters.map((cluster, i) => {
    const running = clusterRunning[i].value;
    const idle = round(100 - running);
    const otherProcess = processRunning[i].items.find((item) => item.name === "other process")?.value || 0;
    const threadBudget = Math.max(0, round(running - otherProcess));
    return {
      cluster,
      items: [
        ...makeTop80Stack(threadNames, seed + i * 0.8, threadBudget, "other thread"),
        { name: "other process", value: otherProcess },
        { name: "idle", value: idle },
      ].sort(compareStackItems),
    };
  });
  const hizeeRows = ["所有进程", "UI进程", "render service"].map((scope, i) => ({
    scope,
    littleRunning: round(clusterRunning[0].value - i * 3),
    midRunning: round(clusterRunning[1].value - i * 2),
    bigRunning: round(clusterRunning[2].value - i),
    littleFreq: Math.round(800 + seed * 50 + i * 40),
    midFreq: Math.round(1550 + seed * 80 + i * 60),
    bigFreq: Math.round(2100 + seed * 90 + i * 50),
    ddrFreq: Math.round(2100 + seed * 75 + i * 45),
    bandwidth: round(8 + seed * 0.9 + i * 0.7, 1),
    latency: round(112 - seed * 3 + i * 4, 1),
    fps: round(type === "游戏" ? 58 + seed * 1.5 - i : 43 + seed * 1.2 - i * 0.6, 1),
  }));
  const threadTemplates = {
    游戏: ["UnityMain", "RenderThread", "BinderWorker"],
    应用: ["MainThread", "RenderThread", "BinderWorker"],
    冷启动: ["ActivityThread", "PackageParser", "BinderWorker"],
    AI: ["AiWorker", "MainThread", "RenderThread"],
  };
  const threadNamesForScenario = threadTemplates[type] || threadTemplates.应用;
  const topThreads = [
    { name: threadNamesForScenario[0], threadType: "main", loadShare: round(38 + seed * 0.9) },
    { name: threadNamesForScenario[1], threadType: "render", loadShare: round(29 + seed * 0.7) },
    { name: threadNamesForScenario[2], threadType: "other", loadShare: round(18 + seed * 0.5) },
  ].map((thread, t) => ({
      name: thread.name,
      threadType: thread.threadType,
      loadShare: thread.loadShare,
      total: {
        level1: {
          IPC: round(2.7 - seed * 0.05 - t * 0.08, 2),
          MPKI: round(3.5 + seed * 0.5 + t * 0.4),
          "FE BOUND": round(16 + seed * 1.4 + t * 1.8),
          "BE BOUND": round(10 + seed * 1.1 + t * 1.2),
        },
        hierarchy: makeTopdownHierarchy(seed, t),
      },
      kernel: {
        level1: {
          IPC: round(1.6 - seed * 0.03 - t * 0.05, 2),
          MPKI: round(1.5 + seed * 0.2 + t * 0.2),
          "FE BOUND": round(7 + seed * 0.8 + t),
          "BE BOUND": round(5 + seed * 0.8 + t),
        },
      },
    }));
  return {
    id: `scenario-${index + 1}`,
    base: { type, name, appVersion, description, config, platform, imageVersion, archivePath },
    loadInfo: {
      clusterRunning,
      processRunning,
      threadRunning,
      hizeeRows,
    },
    topdownInfo: topThreads,
    instructionMix: topThreads.map((thread, t) => ({
      name: thread.name,
      threadType: thread.threadType,
      loadShare: thread.loadShare,
      total: instructionEvents.map((event, i) => ({ name: event, value: round(1.4 + seed * 0.25 + t * 0.5 + i * 0.32) })),
      kernel: instructionEvents.map((event, i) => ({ name: event, value: round(0.4 + seed * 0.11 + t * 0.18 + i * 0.12) })),
    })),
    syscallInfo: topThreads.map((thread, t) => ({
      name: thread.name,
      threadType: thread.threadType,
      loadShare: thread.loadShare,
      density: round(42 + seed * 8 + t * 13),
      calls: makeSyscalls(seed + t),
    })),
    hotspotInfo: {
      cycle: makeHotspotThreads(topThreads, seed, "cycle"),
      fe: makeHotspotThreads(topThreads, seed, "FE"),
      be: makeHotspotThreads(topThreads, seed, "BE"),
    },
  };
}

function makeTopdownHierarchy(seed, threadIndex) {
  const value = (base, step = 0.35) => round(base + seed * step + threadIndex * 0.45);
  return [
    {
      metric: "MPKI",
      unit: "PKI",
      level2: [
        { name: "BAD_INST_SPEC", value: value(0.8, 0.12) },
        { name: "BR_IMMED_MIS_PRED_RETIRED", value: value(0.5, 0.08) },
        { name: "BR_COND_MID_PRED_RETIRED", value: value(1.1, 0.14) },
        { name: "BR_IND_MIS_PRED_RETIRED", value: value(0.7, 0.1) },
        { name: "BR_INDNR_MIS_PRED_RETIRED", value: value(0.4, 0.07) },
      ],
    },
    {
      metric: "FE BOUND",
      unit: "PKI",
      level2: [
        {
          name: "STALL_FRONTEND_MEMBOUND",
          value: value(4.2),
          level3: [
            { name: "STALL_FRONTEND_L1I", value: value(1.4, 0.12) },
            { name: "STALL_FRONTEND_MEM", value: value(1.8, 0.16) },
            { name: "STALL_FRONTEND_TLB", value: value(0.7, 0.08) },
          ],
        },
        {
          name: "STALL_FRONTEND_CPUBOUND_PKI",
          value: value(7.4),
          level3: [
            { name: "STALL_FRONTEND_FLOW", value: value(1.1, 0.11) },
            { name: "STALL_FRONTEND_FLUSH", value: value(1.0, 0.1) },
            { name: "STALL_FRONTEND_RENAME", value: value(3.6, 0.2) },
          ],
        },
      ],
    },
    {
      metric: "BE BOUND",
      unit: "PKI",
      level2: [
        {
          name: "STALL_BACKEND_MEMBOUND",
          value: value(3.6),
          level3: [
            { name: "STALL_BACKEND_L1D", value: value(1.5, 0.13) },
            { name: "STALL_BACKEND_MEM", value: value(2.3, 0.18) },
            { name: "STALL_BACKEND_TLB", value: value(0.9, 0.08) },
            { name: "STALL_BACKEND_ST", value: value(1.0, 0.09) },
          ],
        },
        { name: "STALL_BACKEND_BUSY", value: value(3.4) },
        { name: "STALL_BACKEND_ILOCK", value: value(2.2) },
      ],
    },
    {
      metric: "LINX MEMSTALL PKI",
      unit: "PKI",
      kind: "diagnostic",
      level2: [
        "MEMSTALL_ANYSTORE",
        "MEMSTALL_ANYLOAD",
        "MEMSTALL_L1MISS",
        "MEMSTALL_L2MISS",
        "MEMSTALL_L3MISS",
      ].map((name, i) => ({ name, value: value(0.7 + i * 0.35, 0.1) })),
    },
    {
      metric: "CACHE REFILL PKI",
      unit: "PKI",
      kind: "diagnostic",
      level2: [
        "L1D_CACHE_REFILL",
        "L1D_CACHE_REFILL_RD",
        "L1I_CACHE_REFILL",
        "L2D_CACHE_REFILL",
        "L2D_CACHE_REFILL_RD",
        "L2I_CACHE_REFILL",
        "L3D_CACHE_REFILL",
        "L3D_CACHE_REFILL_RD",
      ].map((name, i) => ({ name, value: value(0.6 + i * 0.22, 0.08) })),
    },
    {
      metric: "TLB REFILL & PREFETCH PKI",
      unit: "PKI",
      kind: "diagnostic",
      level2: [
        "L1D_TLB_REFILL_RD",
        "L1I_TLB_REFILL",
        "L2D_TLB_REFILL_RD",
        "L2D_TLB_REFILL",
        "L2D_CACHE_REFILL_PRFM",
        "L2D_CACHE_REFILL_HWPRF",
        "L3D_CACHE_REFILL_PRFM",
        "L3D_CACHE_REFILL_HWPRF",
        "PAGE_FAULTS_PMI",
      ].map((name, i) => ({ name, value: value(0.25 + i * 0.12, 0.05) })),
    },
  ];
}

function makeHotspotThreads(topThreads, seed, label) {
  const weight = label === "cycle" ? 1 : label === "FE" ? 1.15 : 1.3;
  return topThreads
    .map((thread, threadIndex) => ({
      name: thread.name,
      threadType: thread.threadType,
      loadShare: thread.loadShare,
      score: round(thread.loadShare * weight - threadIndex * 1.7 + seed * 0.6),
      sos: makeHotspotSos(seed, threadIndex, label),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function makeHotspotSos(seed, threadIndex, label) {
  const soPool = ["libunity.so", "libhwui.so", "libart.so", "libil2cpp.so", "libc.so", "libGLESv2.so", "libbinder.so", "libskia.so"];
  const funcPool = ["RenderFrame", "ScheduleTask", "DoSyscall", "WaitFence", "UpdateScene", "BinderTransact", "TextureUpload", "PhysicsStep"];
  const labelOffset = label === "cycle" ? 0 : label === "FE" ? 1 : 2;
  const soNames = Array.from({ length: 3 }, (_, index) => soPool[(seed + threadIndex + labelOffset + index * 2) % soPool.length]);
  return soNames.map((name, soIndex) => ({
    name,
    value: round(34 - soIndex * 7 + seed + threadIndex * 1.5),
    funcs: Array.from({ length: 3 }, (_, index) => funcPool[(seed + threadIndex * 2 + labelOffset + soIndex + index * 2) % funcPool.length]).map((func, funcIndex) => ({
      name: `${label}_${func}`,
      value: round(18 - funcIndex * 3.2 + seed * 0.8 + threadIndex + soIndex * 0.5),
    })),
  }));
}

const scenarios = baseScenarios.map(makeScenario);
function topOverviewNames(collectionName, limit) {
  const counts = new Map();
  scenarios.forEach((scenario) => {
    scenario.loadInfo[collectionName].forEach((row) => {
      row.items.forEach((item) => {
        if (item.name !== "idle" && !/^other /i.test(item.name)) counts.set(item.name, (counts.get(item.name) || 0) + 1);
      });
    });
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
}
function topHotspotNames(dimension, kind) {
  const counts = new Map();
  scenarios.forEach((scenario) => {
    scenario.hotspotInfo[dimension].forEach((thread) => {
      thread.sos.forEach((so) => {
        if (kind === "so") counts.set(so.name, (counts.get(so.name) || 0) + 1);
        else so.funcs.forEach((func) => counts.set(func.name, (counts.get(func.name) || 0) + 1));
      });
    });
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name]) => name);
}
const topSyscallNames = [...scenarios.reduce((counts, scenario) => {
  scenario.syscallInfo.forEach((thread) => {
    thread.calls.forEach((call) => {
      if (call.name !== "others") counts.set(call.name, (counts.get(call.name) || 0) + 1);
    });
  });
  return counts;
}, new Map()).entries()]
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  .slice(0, 15)
  .map(([name]) => name);
const topProcessOverviewNames = topOverviewNames("processRunning", 5);
const topThreadOverviewNames = topOverviewNames("threadRunning", 5);
const filterFields = [
  ["type", "场景类型"],
  ["name", "场景名称"],
  ["appVersion", "应用版本"],
  ["platform", "抓取平台"],
  ["imageVersion", "镜像版本"],
];
const hizeeSceneTrendFields = [
  ["fps", "Hizee 场景 平均帧率", "fps"],
  ["ddrFreq", "Hizee 场景 DDR 平均频率", "Mhz"],
  ["bandwidth", "Hizee 场景 平均带宽", "GB/s"],
  ["latency", "Hizee 场景 平均 latency", "ns"],
];
const hizeeClusterFreqFields = [
  ["littleFreq", "小核", "Mhz"],
  ["midFreq", "中核", "Mhz"],
  ["bigFreq", "大核", "Mhz"],
];
const hizeeClusterRunningFields = [
  ["littleRunning", "小核"],
  ["midRunning", "中核"],
  ["bigRunning", "大核"],
];
const topdownNodeNames = [
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
  "L2D_TLB_REFILL",
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
const trendMetrics = [
  ...clusters.flatMap((cluster, index) => [
    { key: `cluster.${index}.running`, label: `${cluster} running 占比`, unit: "%", type: "load" },
    { key: `cluster.${index}.idle`, label: `${cluster} idle 占比`, unit: "%", type: "load" },
  ]),
  ...topProcessOverviewNames.map((name) => ({ key: `process.${name}`, label: `process overview ${name} 负载`, unit: "%", type: "load" })),
  ...topThreadOverviewNames.map((name) => ({ key: `threadload.${name}`, label: `thread overview ${name} 负载`, unit: "%", type: "load" })),
  ...hizeeSceneTrendFields.map(([field, label, unit]) => ({
    key: `hizee.scene.${field}`,
    label,
    unit,
    type: "load",
  })),
  ...hizeeClusterFreqFields.map(([field, cluster, unit]) => ({
    key: `hizee.freq.${field}`,
    label: `Hizee ${cluster} cluster 平均频率`,
    unit,
    type: "load",
  })),
  ...["所有进程", "UI进程", "render service"].flatMap((scope, scopeIndex) => hizeeClusterRunningFields.map(([field, cluster]) => ({
    key: `hizee.running.${scopeIndex}.${field}`,
    label: `Hizee ${cluster} cluster ${scope} running占比`,
    unit: "%",
    type: "load",
  }))),
  ...["IPC", "MPKI", "FE BOUND", "BE BOUND"].flatMap((metric) => [
    { key: `topdown.level1.total.${metric}`, label: `Topdown 总体 ${metric}`, unit: metric === "IPC" ? "" : "PKI", type: "thread" },
    { key: `topdown.level1.kernel.${metric}`, label: `Topdown 内核 ${metric}`, unit: metric === "IPC" ? "" : "PKI", type: "thread" },
  ]),
  ...topdownNodeNames.map((name) => ({ key: `topdown.node.${name}`, label: `Topdown ${name}`, unit: "PKI", type: "thread" })),
  ...instructionEvents.flatMap((event) => [
    { key: `inst.total.${event}`, label: `指令分布 总体 ${event}`, unit: "PKI", type: "thread" },
    { key: `inst.kernel.${event}`, label: `指令分布 内核 ${event}`, unit: "PKI", type: "thread" },
  ]),
  { key: "syscall.density", label: "系统调用密度", unit: "条/千万条指令", type: "thread" },
  ...topSyscallNames.map((name) => ({ key: `syscall.share.${name}`, label: `系统调用 ${name} 占比`, unit: "%", type: "thread" })),
  ...[
    ["cycle", "Cycle 热点"],
    ["fe", "FE BOUND"],
    ["be", "BE BOUND"],
  ].flatMap(([dimension, label]) => [
    ...topHotspotNames(dimension, "so").map((name) => ({ key: `hotspot.${dimension}.so.${encodeURIComponent(name)}`, label: `${label} SO ${name} 占比`, unit: "%", type: "thread" })),
    ...topHotspotNames(dimension, "func").map((name) => ({ key: `hotspot.${dimension}.func.${encodeURIComponent(name)}`, label: `${label} 函数 ${name} 占比`, unit: "%", type: "thread" })),
  ]),
];

window.CpuScenarioData = {
  scenarios,
  filterFields,
  trendMetrics,
};
})();
