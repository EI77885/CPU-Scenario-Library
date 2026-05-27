# CPU 场景库网站前端设计交接文档

本文档用于把当前 CPU 场景库前端 demo 的产品形态、数据结构、展示规则和后续后端/部署输入整理清楚，方便其他会话继续实现真实后端、数据导入和线上部署。

## 1. 产品定位

CPU 场景库网站定位为性能分析 dashboard，不是营销页。核心目标是沉淀不同手机平台、不同应用场景下的 CPU 特征数据，并支持两类分析：

1. 对比展示：选择 2-3 个场景，横向对比各类性能特征。
2. 特征汇总：选择一个具体数值特征，再用筛选条件圈定目标场景，查看该特征在场景或线程维度上的整体趋势。

当前版本全部使用 mock 数据，重点验证 UI、筛选方式、层级关系、对比视角是否符合性能分析习惯。

## 2. 页面结构

### 2.1 对比展示页

页面入口：`对比展示`

主要区域：

1. 目标范围筛选池
   - 使用基础信息字段筛选目标场景。
   - 字段包括：场景类型、场景名称、应用版本、抓取平台、镜像版本。
2. 筛选结果
   - 展示筛选命中的场景。
   - 最多勾选 3 个场景参与横向对比。
3. 1. 基础信息
   - 展示场景类型、场景名称、应用版本、描述、配置、平台、镜像版本、归档路径。
4. 2. 负载信息
   - 展示 Trace 三视图。
   - 展示 Hizee 指标矩阵。
5. 3. TOPDOWN 信息
   - 默认只展开主逻辑线程。
   - 渲染线程、其他线程默认折叠。
   - 点击任意场景的同类线程展开/折叠时，当前对比的多个场景同步操作。
6. 4. 指令分布信息
   - 展示 top3 线程的总体/内核态 PMU 指令事件，单位按事件/PKI。
7. 5. 系统调用信息
   - 展示 top3 线程的系统调用密度及 top5 syscall 占比。
   - top5 占比不足 100% 时补充 `others`，且 `others` 固定排在最后。
8. 6. 热点与瓶颈 SO/函数
   - 第一层：Cycle 热点、FE 瓶颈、BE 瓶颈。
   - 第二层：该维度火焰图排序的 top3 线程。
   - 第三层：每个线程 top3 SO。
   - 第四层：每个 SO 下 top3 函数。
   - 默认只展开主逻辑线程；渲染线程、其他线程折叠，并支持同类线程跨场景同步展开/折叠。

### 2.2 特征汇总页

页面入口：`特征汇总`

主要区域：

1. 特征筛选池
   - 先按信息分类选择特征类别，再选择一个具体特征。
   - 每次只能选择一个特征。
   - 分类不带数字前缀，包括：负载信息、TOPDOWN 信息、指令分布信息、系统调用信息、热点与瓶颈 SO/函数。
2. 目标范围筛选池
   - 使用基础信息筛选目标场景。
   - 对线程级特征额外提供线程类型多选：主逻辑线程、渲染线程、其他线程。
   - 线程类型可任意多选，但至少保留一个。
3. 结果展示框
   - 支持按当前筛选结果生成趋势视图。
   - 支持保留当前结果，用于多次筛选结果之间对比。
   - 保留按钮每个快照只允许执行一次，执行后按钮变为已保留状态。
   - 展示平均值。
   - 展示单位，但数值本身不重复带单位。
   - 结果自动按数值降序展示。
   - 占比为 0 的结果不展示。

## 3. 数据特征定义

### 3.1 基础信息

场景级字段：

- 场景类型：游戏、应用、冷启动、AI 等。
- 场景名称：如 `原神_xumi`、`王者荣耀_replay`、`抖音_video`。
- 应用版本。
- 场景描述。
- 场景配置说明。
- 抓取平台。
- 数据采集镜像版本。
- 归档路径。

后端建议建模为 `scenario` 主表。

### 3.2 负载信息

负载信息包含 Trace 三视图和 Hizee 指标。

#### Trace 三视图

图名固定为：

1. `cluster load overview`
2. `cluster process overview`
3. `cluster thread overview`

展示规则：

- 图一：大/中/小核 cluster 的 running 与 idle 占比。
- running + idle 必须等于 100%。
- running 使用浅绿，idle 使用深灰。
- 图二：cluster 进一步拆到 process 粒度。
- 图二保留图一 idle，且 idle 比例与图一一致。
- 图二展示累计前 80% 热点进程，其余合并为 `other process`。
- 进程按负载降序显示，`other process` 和 `idle` 固定靠后。
- 图三：cluster 进一步拆到 thread 粒度。
- 图三继承图二的 `other process`，这部分不继续展开到线程。
- 图三只在图二前 80% 进程范围内展开线程，再按线程负载降序累计前 80%，其余合并为 `other thread`。
- 线程按负载降序显示，`other thread`、`other process` 和 `idle` 固定靠后。

#### Hizee 指标矩阵

矩阵行：

- 小核 cluster
- 中核 cluster
- 大核 cluster

矩阵列按层级排列：

1. 进程级负载特征
   - 所有进程 running 占比，单位 `%`
   - UI 进程 running 占比，单位 `%`
   - render service running 占比，单位 `%`
2. cluster 级特征
   - 平均频率，单位 `Mhz`
3. 场景级特征
   - 平均帧率，单位 `fps`
   - DDR 平均频率，单位 `Mhz`
   - 平均带宽，单位 `GB/s`
   - 平均 latency，单位 `ns`

表头需要在特征名称后标注单位，数值后不再重复展示单位。

场景级特征对小/中/大核是同一个值，前端可用合并单元格或视觉分组展示。

### 3.3 TOPDOWN 信息

展示对象：

- 场景特定 top3 线程。
- 线程顺序固定为：主逻辑线程、渲染线程、其他线程。
- 不再按负载降序排列，但每个线程仍展示负载占比。
- 每个线程需要带线程类型标签，供特征汇总页筛选使用。

Level 1：

- IPC
- MPKI
- FE BOUND
- BE BOUND

排列顺序固定为：

1. IPC
2. MPKI
3. FE BOUND
4. BE BOUND

展示规则：

- 总体 PMU 和内核 PMU 均展示 level1。
- 内核 PMU 只展示 level1。
- 总体 PMU 展开 level2 / level3。
- 总体用蓝色，内核用橙色，通过图例展示，不在每个数值框里重复写“总体/内核”。
- PKI 单位体现在 PMU 名称或表头中，数值后不写 `PKI`。

Level 2 / Level 3：

MPKI level2：

- BAD_INST_SPEC
- BR_IMMED_MIS_PRED_RETIRED
- BR_COND_MID_PRED_RETIRED
- BR_IND_MIS_PRED_RETIRED
- BR_INDNR_MIS_PRED_RETIRED

MPKI 不展示 level3。

FE BOUND level2：

- STALL_FRONTEND_MEMBOUND
  - STALL_FRONTEND_L1I
  - STALL_FRONTEND_MEM
  - STALL_FRONTEND_TLB
- STALL_FRONTEND_CPUBOUND_PKI
  - STALL_FRONTEND_FLOW
  - STALL_FRONTEND_FLUSH
  - STALL_FRONTEND_RENAME

BE BOUND level2：

- STALL_BACKEND_MEMBOUND
  - STALL_BACKEND_L1D
  - STALL_BACKEND_MEM
  - STALL_BACKEND_TLB
  - STALL_BACKEND_ST
- STALL_BACKEND_BUSY
- STALL_BACKEND_ILOCK

瓶颈链路：

- 当前真实场景默认偏向 FE BOUND > STALL_FRONTEND_CPUBOUND_PKI > STALL_FRONTEND_RENAME。
- 前端需要突出瓶颈链路，并表现 L1 -> L2 -> L3 的递进关系。

额外诊断框：

这些框与 MPKI、FE BOUND、BE BOUND 平级展示，不影响当前 topdown 展示逻辑。

1. LINX MEMSTALL PKI
   - MEMSTALL_ANYSTORE
   - MEMSTALL_ANYLOAD
   - MEMSTALL_L1MISS
   - MEMSTALL_L2MISS
   - MEMSTALL_L3MISS
2. CACHE REFILL PKI
   - L1D_CACHE_REFILL
   - L1D_CACHE_REFILL_RD
   - L1I_CACHE_REFILL
   - L2D_CACHE_REFILL
   - L2D_CACHE_REFILL_RD
   - L2I_CACHE_REFILL
   - L3D_CACHE_REFILL
   - L3D_CACHE_REFILL_RD
3. TLB REFILL & PREFETCH PKI
   - L1D_TLB_REFILL_RD
   - L1I_TLB_REFILL
   - L2D_TLB_REFILL_RD
   - L2D_TLB_REFILL
   - L2D_CACHE_REFILL_PRFM
   - L2D_CACHE_REFILL_HWPRF
   - L3D_CACHE_REFILL_PRFM
   - L3D_CACHE_REFILL_HWPRF
   - PAGE_FAULTS_PMI

### 3.4 指令分布信息

展示对象：

- 场景特定 top3 线程。
- 展示总体和内核态 PMU。
- 表头为 `事件/PKI`、`总体`、`内核态`。

事件名必须保持原始名称，不要缩写：

- ld/st_retired
- br_retired
- dp_spec
- vfp_spec
- ase_spec
- sve_inst_spec
- ld/strex_spec
- atomic/cas_spec
- barrier_spec
- unaligned_ldst_spec

如果事件名过长，可以缩小列宽、横向拖动或优化表格布局，但不能改名。

### 3.5 系统调用信息

展示对象：

- 场景特定 top3 线程。
- 每个线程展示系统调用密度，单位 `条/千万条指令`。
- 每个线程展示 top5 系统调用及占比。
- top5 占比之和不足 100% 时，补充 `others`。
- `others` 固定排在最后，其余 syscall 按占比降序。
- 图例中必须显示 syscall 名称和占比。

特征汇总页：

- AArch64 syscall 很多，但本项目不展示全集。
- 只统计整个数据库中出现在 top5 syscall 里的高频 syscall。
- 备选 syscall 数量为数据库出现次数最多的 top15。

### 3.6 热点与瓶颈 SO/函数

对比展示页四层结构：

1. Cycle 热点 / FE 瓶颈 / BE 瓶颈
2. 对应维度火焰图排序的 top3 线程
3. 每个线程的 top3 SO
4. 每个 SO 下 top3 函数

视觉规则：

- 四层用不同颜色区分。
- Cycle 热点、FE 瓶颈、BE 瓶颈作为第一层，不要在每个线程内并排三张小卡重复展示。
- 默认只展开主逻辑线程，渲染线程和其他线程折叠。
- 同类线程展开/折叠需要跨当前对比场景同步。

特征汇总页：

- 按维度展开：Cycle 热点、FE BOUND、BE BOUND。
- 每个维度提供数据库中出现次数最多的 top5 SO 和 top5 函数供选择。
- 这里不是每个 SO 对应 5 个函数，而是该维度全库 top5 SO + 全库 top5 函数。
- 结果展示时只展示包含该 SO 或函数的线程。
- 结果按占比降序展示。
- 结果需要写清来源：场景、线程、维度。

## 4. 特征汇总页粒度规则

### 4.1 场景级特征

负载信息整体按场景级特征处理，结果展示只用场景粒度。

场景级趋势 label：

- `应用/场景名称`
- 平台作为副信息展示。

### 4.2 线程级特征

TOPDOWN、指令分布、系统调用、热点与瓶颈 SO/函数均按线程级特征处理。

线程级趋势 label：

- `应用名_场景名_线程名`
- 副信息展示平台和线程类型。

线程类型：

- 主逻辑线程
- 渲染线程
- 其他线程

线程类型用于筛选，不使用 top1/top2/top3 维度。

## 5. 后端数据模型建议

建议后端按以下资源组织：

### 5.1 Scenario

```json
{
  "id": "scenario-001",
  "type": "游戏",
  "name": "原神_xumi",
  "appVersion": "5.0.1",
  "description": "开放世界跑图，须弥城 10 分钟 freerun",
  "config": "60fps, 高画质, 固定路线",
  "platform": "Kirin-Next",
  "imageVersion": "KRN-2026.05.11",
  "archivePath": "/archive/genshin/xumi/kirin-next"
}
```

### 5.2 LoadInfo

```json
{
  "scenarioId": "scenario-001",
  "clusterOverview": [
    { "cluster": "小核", "running": 35.2, "idle": 64.8 }
  ],
  "processOverview": [
    {
      "cluster": "小核",
      "items": [
        { "name": "UI进程", "value": 12.4 },
        { "name": "render service", "value": 8.5 },
        { "name": "other process", "value": 5.2 },
        { "name": "idle", "value": 64.8 }
      ]
    }
  ],
  "threadOverview": [
    {
      "cluster": "小核",
      "items": [
        { "threadType": "main", "name": "UnityMain", "value": 9.6 },
        { "threadType": "render", "name": "RenderThread", "value": 7.2 },
        { "threadType": "other", "name": "BinderWorker", "value": 3.3 },
        { "name": "other thread", "value": 2.8 },
        { "name": "idle", "value": 64.8 }
      ]
    }
  ],
  "hizee": {
    "scene": { "fps": 60.0, "ddrFreq": 2250, "bandwidth": 9.8, "latency": 104.0 },
    "clusters": [
      {
        "cluster": "小核",
        "avgFreq": 850,
        "running": {
          "allProcess": 35.2,
          "uiProcess": 32.2,
          "renderService": 29.2
        }
      }
    ]
  }
}
```

### 5.3 ThreadMetric

所有线程级数据建议统一带：

```json
{
  "scenarioId": "scenario-001",
  "threadId": "thread-001",
  "threadName": "UnityMain",
  "threadType": "main",
  "loadShare": 38.9
}
```

`threadType` 取值建议：

- `main`
- `render`
- `other`

### 5.4 TopdownMetric

```json
{
  "threadId": "thread-001",
  "total": {
    "level1": { "IPC": 2.65, "MPKI": 4.0, "FE BOUND": 17.4, "BE BOUND": 11.1 },
    "hierarchy": [
      {
        "metric": "FE BOUND",
        "unit": "PKI",
        "level2": [
          {
            "name": "STALL_FRONTEND_CPUBOUND_PKI",
            "value": 7.8,
            "level3": [
              { "name": "STALL_FRONTEND_RENAME", "value": 4.0 }
            ]
          }
        ]
      }
    ],
    "bottleneckPath": ["FE BOUND", "STALL_FRONTEND_CPUBOUND_PKI", "STALL_FRONTEND_RENAME"]
  },
  "kernel": {
    "level1": { "IPC": 1.57, "MPKI": 1.7, "FE BOUND": 7.8, "BE BOUND": 5.8 }
  }
}
```

### 5.5 InstructionMix

```json
{
  "threadId": "thread-001",
  "total": [{ "name": "ld/st_retired", "value": 1.6 }],
  "kernel": [{ "name": "ld/st_retired", "value": 0.5 }]
}
```

### 5.6 SyscallInfo

```json
{
  "threadId": "thread-001",
  "density": 50,
  "calls": [
    { "name": "futex", "value": 30.1 },
    { "name": "write", "value": 22.4 },
    { "name": "others", "value": 8.1 }
  ]
}
```

### 5.7 HotspotInfo

```json
{
  "threadId": "thread-001",
  "dimension": "cycle",
  "rank": 1,
  "sos": [
    {
      "name": "libunity.so",
      "value": 35.0,
      "functions": [
        { "name": "cycle_RenderFrame", "value": 18.8 }
      ]
    }
  ]
}
```

`dimension` 取值建议：

- `cycle`
- `fe`
- `be`

## 6. 接口建议

### 6.1 场景筛选

`GET /api/scenarios`

查询参数：

- `type`
- `name`
- `appVersion`
- `platform`
- `imageVersion`

返回：

- 场景基础信息列表。

### 6.2 对比展示数据

`GET /api/scenarios/compare?ids=scenario-001,scenario-002,scenario-003`

返回：

- 基础信息
- 负载信息
- TOPDOWN 信息
- 指令分布信息
- 系统调用信息
- 热点与瓶颈 SO/函数信息

### 6.3 特征字典

`GET /api/features`

返回：

- 按分类组织的特征列表。
- 每个特征需要包含：
  - `key`
  - `label`
  - `category`
  - `unit`
  - `scope`：`scenario` 或 `thread`
  - 可选 `dimension`

### 6.4 特征汇总

`GET /api/features/trend`

查询参数：

- `featureKey`
- `type`
- `name`
- `appVersion`
- `platform`
- `imageVersion`
- `threadTypes`

返回：

```json
{
  "feature": { "key": "topdown.level1.total.MPKI", "label": "Topdown 总体 MPKI", "unit": "PKI", "scope": "thread" },
  "average": 6.2,
  "rows": [
    {
      "scenarioId": "scenario-001",
      "scenarioName": "原神_xumi",
      "platform": "Kirin-Next",
      "threadName": "UnityMain",
      "threadType": "main",
      "dimension": "",
      "value": 4.0
    }
  ]
}
```

后端排序规则：

- 默认按 `value` 降序。
- 占比型特征中过滤 `value = 0` 的记录。

## 7. 前端实现现状

当前实现是静态前端 + 本地 Node/SQLite 后端：

- 入口：`index.html`
- mock 数据兜底：`src/data.js`
- 页面逻辑：`src/main.js`
- 样式：`src/styles.css`
- 本地服务与 API：`server.js`

当前已补充本地后端和数据导入链路：

- 数据源生成：`scripts/generate-source-data.js`
- 数据导入：`scripts/import-source-data.js`
- Trace 三视图解析：`scripts/update-trace-summary.js`
- SQLite 数据库：`data/cpu_scenario_library.sqlite`
- 数据源目录：`source_data/`
- 每个场景目录下均有同级 `hitrace/`，后续真实 trace 放在该目录；v1 使用 `hitrace/trace_summary.json` 模拟 trace 三视图解析产物。该 JSON 文件名不绑定具体来源，后续 Android 或鸿蒙 trace 解析器只要输出同结构数据即可接入。
- `scripts/update-trace-summary.js` 会扫描 `hitrace/` 下的 Perfetto/proto 二进制 trace、systrace/atrace/OpenHarmony HiTrace/ftrace 文本和 Chrome Trace JSON，统一生成 `trace_summary.json`。二进制 Perfetto 解析依赖外部 `trace_processor_shell`；文本 trace 主要解析 `sched_switch`，已兼容 `=`/`:` 字段分隔、`[002]`/`cpu_id=2`/`C02` CPU 标记等常见鸿蒙文本格式。
- `source_data` 中的 xlsx 已按目标环境改为单 sheet 布局，基础信息、负载信息、TOPDOWN、指令分布、系统调用、热点 SO/函数都在同一个 sheet 内分段排列。
- 导入脚本默认是增量导入：按 `分类目录 + 场景名称` 生成稳定场景 id，对已存在场景先清理该场景的子表数据再 upsert 主表，不会重建整个数据库。
- 如需全量重建，可显式执行 `node scripts/import-source-data.js --reset`。
- 单 sheet 解析依赖关键词和事件名归一化，不依赖固定单元格坐标；可识别示例图中的 `CLUSTER LOAD OVERVIEW`、`TOPDOWN`、`指令分布`、`系统调用`、`Library:`、`Function:` 等分段。

本地访问：

```bash
npm run setup:data
npm start
```

默认地址：

```text
http://localhost:5173/
```

如果当前环境没有 npm，可直接使用：

```bash
node scripts/generate-source-data.js
node scripts/import-source-data.js
node server.js
```

## 8. 后续实现注意事项

1. 后端不要直接返回 UI 拼好的文本，尽量返回结构化字段。
2. 所有数值都要明确单位，但单位建议放在特征字典或字段元信息里。
3. 趋势页数值不应重复带单位。
4. 线程类型是核心字段，后端解析 trace 后需要稳定归类。
5. Trace 三视图中进程视图先按进程 running 负载累计前 80%，剩余归入 `other process`；线程视图继承 `other process`，只对前 80% 进程内线程继续累计前 80%，剩余归入 `other thread`。
6. 系统调用和热点 SO/函数的候选项应由数据库统计生成，不要写死全集。
7. TOPDOWN 内核态只需要 level1；总体需要 level2 / level3。
8. 线上部署时当前静态站可先作为前端资源部署，后续再把 `src/data.js` 替换为 API 调用层。
