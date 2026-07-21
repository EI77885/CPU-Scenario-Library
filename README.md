# CPU 场景库性能 Dashboard

CPU 场景库用于沉淀不同手机平台、镜像版本和应用场景下的 CPU 性能特征，并提供单特征概览、场景横向对比和多范围结论汇总。

项目由纯前端 Dashboard、Node.js REST 服务、SQLite 数据库和 Excel/Trace 数据导入器组成。前端无需构建步骤，服务启动后即可通过浏览器访问。

## 核心能力

### 特征概览

- 按负载、TOPDOWN、指令分布、系统调用、热点与瓶颈 SO/函数分类选择一个指标。
- 使用抓取平台、镜像版本、场景类型、场景名称和应用版本圈定目标范围。
- 线程级指标支持主逻辑线程、渲染线程、其他线程、主逻辑进程和渲染进程多选。
- 结果按数值降序展示，同时给出平均值、中位值、取值范围和明细表。
- 当前结果可保留为快照，用于多次筛选结果之间的对比。

### 对比展示

- 从筛选结果中选择最多 3 个场景进行横向对比。
- 多个场景始终按列对齐，便于逐模块检查差异。
- 展示模块依次为：
  1. 基础信息
  2. 场景特征摘要
  3. 负载信息
  4. TOPDOWN 信息
  5. 指令分布信息
  6. 系统调用信息
  7. 热点与瓶颈 SO/函数
- TOPDOWN 和热点 SO/函数默认展开主逻辑线程；同类线程在多个对比场景间同步展开或折叠。

### 结论汇总

- 使用多选目标范围筛选池组织跨平台、跨镜像、跨类型或跨场景结论。
- 筛选顺序固定为：抓取平台 -> 镜像版本 -> 场景类型 -> 场景名称 -> 应用版本。
- 按最后一级多选维度组织对比，未细分的更低层级数据会聚合后形成结论。
- 每个汇总条目包含负载、TOPDOWN、指令分布、系统调用及热点 SO/函数摘要，并可展开查看明细场景。

## 分析数据

### 基础信息

场景类型、场景名称、应用版本、场景描述、配置说明、抓取平台、镜像版本和归档路径。

### 负载与 ACR

- `cluster load overview`：小/中/大核 cluster 的 running 与 idle，占比合计 100%。
- `cluster process overview`：按进程拆分 running，热点进程累计前 80%，其余合并为 `other process`。
- `cluster thread overview`：继承进程视图中的 idle 和 `other process`，线程热点累计前 80%，其余合并为 `other thread`。
- Hizee 指标：所有进程、UI 进程和 Render Service 在各 cluster 的 running；各 cluster 平均频率；场景平均帧率、DDR 平均频率、带宽和 latency。
- ACR 用于衡量绝对算力需求：

```text
core ACR    = running 占比 * (平均频率 / 峰值频率)
cluster ACR = cluster 内多个 core ACR 的均值
system ACR  = Sum(cluster ACR * 单核算力比 * 核数比)
              / Sum(单核算力比 * 核数比)
```

CHS 平台的小/中/大核单核算力比按 `1:3:4`，核数比按 `4:6:1.5`。整机 ACR 是按算力和核数加权后的总体压力，cluster ACR 是对应核簇的局部压力，两类标签可以同时出现。

场景特征摘要会结合帧率目标、CPU ACR 和 DDR 平均频率生成标签：

- 帧率：与目标帧率差值不超过 1 帧为满帧，大于 1 帧为掉帧，大于 5 帧为严重掉帧。
- 小核 ACR：不高于 30% 为低载，30%-60% 为中载，高于 60% 为高载。
- 中核 ACR：不高于 10% 为低载，10%-20% 为中载，高于 20% 为高载。
- 大核 ACR：不高于 5% 为低载，5%-10% 为中载，高于 10% 为高载。
- 整机 ACR：不高于 20% 为轻载，20%-40% 为中载，高于 40% 为高载。
- DDR：低于 1GHz 为低载，1GHz-2GHz 为中载，不低于 2GHz 为高载。

异常检测覆盖帧率、全进程/UI进程/Render Service 的各 cluster 与整机 ACR、各 cluster 平均频率、DDR 平均频率、带宽和 latency，并突出同类场景中最高或最低 20% 的指标。

### TOPDOWN

- 每个场景按主逻辑线程、渲染线程、其他线程展示。
- Level 1：IPC、MPKI、FE BOUND、BE BOUND。
- 总体 PMU 展开 Level 2/Level 3，内核 PMU 仅展示 Level 1。
- 突出显示 L1 -> L2 -> L3 瓶颈链路和对应 PKI。
- 额外诊断组包括 LINX MEMSTALL、CACHE REFILL、TLB REFILL & PREFETCH。
- 摘要按线程展示 IPC（总体/内核）、内核占比（Inst/Cycle）、Bound 链路和全层级指标异常。

### 指令、系统调用和热点

- 指令分布：总体/内核态 PMU 事件，单位为 PKI；摘要使用堆叠条展示各线程指令构成，并将事件归并为内存访问、整型计算、浮点计算、SIMD/向量、分支控制和原子同步等多标签画像。
- 系统调用：每个线程的 syscall 密度和 Top5 调用占比，不足 100% 的部分归为 `others`。
- 系统调用业务画像由离线规则生成，例如同步等待、文件 IO、内存管理、网络 IO 和进程调度。
- 热点与瓶颈：按 Cycle 热点、FE BOUND、BE BOUND 展示 Top3 线程 -> Top3 SO -> 每个 SO 的 Top3 函数。

## 技术架构

```text
CPU测试场景库分析*.xlsx + trace_summary.json
                       |
                       v
          scripts/import-source-data.js
                       |
                       v
        data/cpu_scenario_library.sqlite
                       |
                       v
              server.js REST API
                       |
                       v
        index.html + src/main.js + src/styles.css
```

- 后端：Node.js 内置 `node:http` 与 `node:sqlite`。
- Excel 解析：`exceljs`。
- 数据库：SQLite，服务端只读访问，导入器负责写入。
- 前端：原生 HTML/CSS/JavaScript，无打包和编译步骤。

## 环境要求

- Node.js 24 或更新版本。
- npm。
- Chrome、Edge 或其他现代浏览器。

项目使用 `node:sqlite`，旧版 Node.js 无法启动。Excel 由 `exceljs` 解析，不要求系统额外安装 `unzip` 命令。

## 快速开始

### 使用仓库内示例数据

```bash
git clone https://github.com/EI77885/CPU-Scenario-Library.git
cd CPU-Scenario-Library
npm install
npm run setup:data
npm start
```

浏览器访问：

```text
http://localhost:5173/
```

`npm run setup:data` 会生成并导入演示数据，仅用于本地体验。真实数据环境不要执行该命令。

### 使用真实归档数据

```bash
npm install
npm run update:data -- --source "/absolute/path/to/cpu-data-archive"
npm start
```

Windows PowerShell 示例：

```powershell
npm install
npm run update:data -- --source "D:\cpu-data-archive"
npm start
```

服务监听 `0.0.0.0:5173`，启动日志会同时打印本机和可用的局域网访问地址。

## 数据发现与配对

导入器既支持仓库内的 `source_data`，也支持任意外部目录。目录层级和目录名称不是识别前提。

### 必需文件

每个场景必须有且只有一组：

```text
CPU测试场景库分析*.xlsx
trace_summary.json
```

规则如下：

- Excel 文件名必须以 `CPU测试场景库分析` 开头，并以 `.xlsx` 结尾。
- `~$` 开头的 Excel 临时文件会被忽略。
- 导入器从 `--source` 指定的根目录递归查找两类文件。
- 平台、镜像版本、场景类型、场景名称、应用版本等业务字段从 Excel 读取，不依赖目录名。
- `trace_summary.json` 只会配对给其路径上最近的 Excel 所在目录。
- Excel 和 summary 必须一一对应；一个文件不会复用给多个场景。
- 缺少文件、出现多个候选、JSON 无效或配对不唯一时，该场景会被跳过，避免错误数据进入网页数据库。

推荐结构仍然是：

```text
archive/
  platform_image-version/
    01_game/
      app_scene/
        CPU测试场景库分析_xxx.xlsx
        hitrace/
          trace_summary.json
```

但以下不规则结构同样可以识别：

```text
any-root/
  arbitrary-folder/
    CPU测试场景库分析_xxx.xlsx
    nested-trace-output/
      trace_summary.json
```

旧版 `source_data/分类/场景` 结构继续沿用原场景 ID；其它目录结构的 ID 由 Excel 中的平台、镜像版本、场景类型和场景名称生成。

## trace_summary.json

Trace 三视图不从 Excel 图片或原始 trace 解析，而是直接读取已经结构化的 JSON：

```json
{
  "clusterOverview": [],
  "processOverview": [],
  "threadOverview": []
}
```

上游工具需要提前把 Perfetto/Hitrace 结果转换为该结构。本项目不会解析原始 `hitrace`、`systrace` 或 Perfetto 文件。

数据约束：

- `clusterOverview` 中 running + idle 应等于 100%。
- `processOverview` 应保留 cluster idle，并将非热点进程合并为 `other process`。
- `threadOverview` 应继承 idle 和 `other process`，并将非热点线程合并为 `other thread`。
- JSON 缺失、格式错误或无法唯一配对时，整个场景不会导入。

## 导入命令

默认从仓库内 `source_data` 增量导入：

```bash
npm run update:data
```

指定任意数据根目录：

```bash
npm run update:data -- --source "/path/to/archive"
```

指定数据库文件：

```bash
node scripts/import-source-data.js --source "/path/to/archive" --db "/path/to/library.sqlite"
```

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--source <path>` | 指定递归扫描的数据根目录 |
| `--db <path>` | 指定 SQLite 数据库文件 |
| `--debug` | 输出文件识别、分段解析和错误堆栈 |
| `--strict` | 发现坏表或解析失败时让命令返回失败 |
| `--reset` / `--full` | 清空数据库后重新导入 |

增量导入会插入新场景，并重写已存在场景的主表和子表；本次目录中没有出现的旧场景会保留。数值在写入数据库前统一四舍五入到两位小数。

真实数据环境请谨慎使用 `--reset` 或 `--full`。

## 数据删除

删除脚本默认只预览，不会直接修改数据库：

```bash
npm run delete:data -- list-scenarios
node scripts/delete-data.js scenario <scenario_id>
```

确认后增加 `--yes`：

```bash
node scripts/delete-data.js scenario <scenario_id> --yes
```

删除单项指标：

```bash
node scripts/delete-data.js metric topdown \
  --where thread_id=<thread_id> \
  --where "metric=FE BOUND" \
  --yes
```

使用非默认数据库时增加 `--db <path>`。完整参数可执行：

```bash
node scripts/delete-data.js --help
```

## REST API

| 接口 | 用途 |
| --- | --- |
| `GET /api/bootstrap` | 返回前端初始化所需的场景、筛选字段和特征定义 |
| `GET /api/scenarios` | 返回场景基础信息，支持基础字段筛选 |
| `GET /api/scenarios/compare?ids=a,b,c` | 返回最多 3 个场景的完整对比数据 |
| `GET /api/features` | 返回数据库中可用于概览的特征列表 |
| `GET /api/features/trend?featureKey=...` | 返回指定特征的降序趋势数据与平均值 |
| `GET /api/images/compare` | 返回当前镜像与基线镜像的场景和指标差异 |

场景筛选参数：

- `platform`
- `imageVersion`
- `type`
- `name`
- `appVersion`

线程级趋势接口还支持 `threadTypes=main,render,other,main_process,render_process`。

示例：

```bash
curl "http://localhost:5173/api/scenarios?platform=CHS-SGT"
curl "http://localhost:5173/api/features"
curl "http://localhost:5173/api/features/trend?featureKey=syscall.density&threadTypes=main,render"
```

## 项目结构

```text
cpu-scenario-library/
  data/                         SQLite 数据库
  scripts/
    data-common.js              公共枚举、PMU 和线程类型定义
    generate-source-data.js     演示数据生成器
    import-source-data.js       Excel/JSON 发现、配对和导入
    delete-data.js              安全删除工具
  source_data/                  默认数据根目录
  src/
    data.js                     API 不可用时的前端演示数据
    main.js                     三页面交互和分析逻辑
    styles.css                  Dashboard 样式
  index.html                    页面入口
  server.js                     静态资源与 REST API 服务
```

## 部署建议

### Windows 内网机器

```powershell
cd D:\cpu-scenario-library
npm ci
npm run update:data -- --source "D:\cpu-data-archive"
$env:PORT=5173
npm start
```

浏览器访问启动日志给出的局域网地址。生产环境建议使用 Windows 服务、任务计划程序或进程管理器保持 `server.js` 运行，并定时执行增量导入。

### 更换端口

macOS/Linux：

```bash
PORT=5174 npm start
```

Windows PowerShell：

```powershell
$env:PORT=5174
npm start
```

## 快速验证

```bash
node --check server.js
node --check src/main.js
node --check scripts/import-source-data.js
npm run update:data -- --strict
curl "http://localhost:5173/api/scenarios"
```

## 常见问题

### 页面打开后为空白

不要直接双击 `index.html`。前端需要通过 `server.js` 获取 `/api/bootstrap`，请先执行 `npm start`，再访问 `http://localhost:5173/`。

### Database is not ready

尚未生成数据库。先执行：

```bash
npm run update:data -- --source "/path/to/archive"
```

或使用演示数据：

```bash
npm run setup:data
```

### Excel 已存在但场景未导入

依次检查：

1. 文件名是否以 `CPU测试场景库分析` 开头。
2. Excel 路径下是否存在唯一可配对的 `trace_summary.json`。
3. JSON 是否为合法格式。
4. Excel 中是否包含平台、镜像版本、场景类型和场景名称等基础字段。
5. 使用 `--debug --strict` 查看具体文件和分段错误。

### Excel 解析出现重叠合并单元格

导入器会兼容 Excel 中重复或重叠的 merge 定义，并将合并区域左上角文本作为上下文继承。若仍有字段缺失，请使用 `--debug` 保存对应文件路径和错误堆栈。

### 端口被占用

设置新的 `PORT` 后重新启动。服务会明确打印端口占用错误，不会静默失败。

## 相关文档

- `CPU_SCENARIO_LIBRARY_HANDOFF.md`：前端数据模型、展示规则和后端交接说明。
- `CPU场景库UI会话实录.md`：历史 UI 需求与迭代记录。

> 当前仓库中的示例数据和部分结论规则用于验证产品与 UI。接入真实采集链路时，应继续校准平台峰值频率、分位阈值、业务标签和回归判定标准。
