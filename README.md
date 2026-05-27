# CPU 场景库后端与前端展示使用说明

本工程用于在目标环境中扫描 `source_data` 目录下的 CPU 场景 Excel 数据和 `hitrace` 解析产物，增量更新本地 SQLite 数据库，并通过本地 Node 服务给前端页面展示。

目标环境假设为 Windows x86。

## 1. 工程内容

核心文件：

- `server.js`：本地静态资源服务和 REST API 服务。
- `scripts/import-source-data.js`：从 `source_data` 增量导入数据库。
- `scripts/update-trace-summary.js`：从 `hitrace\` 下的原始 trace 生成统一的 `trace_summary.json`。
- `scripts/generate-source-data.js`：生成示例 `source_data`，仅用于演示或本地测试。
- `data/cpu_scenario_library.sqlite`：导入后生成的 SQLite 数据库。
- `source_data/`：目标环境的数据源目录。
- `index.html`、`src/`：前端页面资源。

常用 API：

- `GET /api/bootstrap`
- `GET /api/scenarios`
- `GET /api/scenarios/compare?ids=a,b,c`
- `GET /api/features`
- `GET /api/features/trend?featureKey=...&threadTypes=main,render`

## 2. Windows 环境准备

目标机器需要安装：

1. Node.js 24 或更新版本。
2. 可在命令行中直接执行的 `unzip` 命令。
3. Edge、Chrome 或其他现代浏览器。

在 PowerShell 中检查：

```powershell
node -v
unzip -v
```

注意：

- 当前后端使用 Node 内置 `node:sqlite`，因此 Node 版本需要足够新。
- 当前 Excel 读取依赖 `unzip` 命令读取 `.xlsx` 内部 XML。如果目标机器没有 `unzip`，导入脚本会失败。可以安装 Git for Windows、MSYS2 或 UnZip for Windows，并把 `unzip.exe` 加入 `PATH`。
- 本工程目前没有 npm 依赖，通常不需要执行 `npm install`。

## 3. 部署工程

将整个工程目录复制到 Windows，例如：

```text
D:\cpu-scenario-library
```

进入工程目录：

```powershell
cd D:\cpu-scenario-library
```

建议保留以下目录结构：

```text
cpu-scenario-library\
  data\
  scripts\
  source_data\
  src\
  index.html
  package.json
  server.js
```

其中 `data\` 可以不存在，导入数据库时会自动创建。

## 4. 准备 source_data 数据源

数据源目录固定为工程根目录下的 `source_data`：

```text
D:\cpu-scenario-library\source_data
```

推荐目录结构：

```text
source_data\
  01_game\
    wzry_replay\
      CPU测试场景库分析_xxx.xlsx
      hitrace\
        trace_summary.json
  02_app\
    douyin_video\
      CPU测试场景库分析_xxx.xlsx
      hitrace\
        trace_summary.json
```

要求：

- 分类目录使用 `01_game`、`02_app`、`03_coldstart`、`04_AIandAgent`、`05_camera`。
- 场景目录名称作为场景唯一名称的一部分，例如 `wzry_replay`。
- 每个场景目录下需要有一个以 `CPU测试场景库分析` 开头的 `.xlsx` 文件。
- 每个场景目录下需要有同级 `hitrace\` 目录。
- `hitrace\trace_summary.json` 用于提供负载三视图结构化数据；该文件名不绑定具体 trace 来源，后续 Android 或鸿蒙 trace 解析器只要输出同结构 JSON 即可接入。如果暂时缺失，导入器会记录 warning，并跳过该场景的三视图数据。
- 目标环境 Excel 只有一个 sheet 页也可以。导入器会按关键词识别基础信息、负载信息、TOPDOWN、指令分布、系统调用、热点 SO/函数等分段。
- 频率单位统一使用 `Mhz`，数据库和前端展示都不再转换为 `GHz`。

## 5. 生成 trace_summary.json

三视图数据不从 Excel 图片 OCR 获取，而是从每个场景目录下的：

```text
hitrace\trace_summary.json
```

读取。目标环境可以先把 Android、systrace 或鸿蒙 trace 原始文件放到对应场景的 `hitrace\` 目录，再执行：

```powershell
node scripts/update-trace-summary.js
```

也可以使用 npm 脚本：

```powershell
npm run trace:summary
```

脚本会扫描 `source_data` 下每个场景的 `hitrace\` 目录，生成或更新 `trace_summary.json`。默认是增量模式：如果 `trace_summary.json` 比原始 trace 新，就跳过；需要强制重算时加 `--force`：

```powershell
node scripts/update-trace-summary.js --force
```

支持的输入类型：

- Perfetto / proto 二进制 trace：例如 `.perfetto-trace`、`.pftrace`、`.pb`、`.bin`。这类文件需要目标环境安装 `trace_processor_shell`，或通过 `--trace-processor` 指定路径。
- systrace / atrace / OpenHarmony HiTrace / ftrace 文本：例如 `.txt`、`.trace`、`.ftrace`、`.atrace`、`.systrace`、`.hitrace`、`.htrace`、`.ohtrace`、`.log`、`.html`。脚本会解析其中的 `sched_switch` 事件。
- Chrome Trace JSON：例如 `.json`，支持 `traceEvents` / `events` 中的 `X` 或 `B/E` 时长事件。
- `.gz` 压缩的上述文本或 JSON 文件。

Perfetto 二进制 trace 示例：

```powershell
node scripts/update-trace-summary.js --trace-processor D:\tools\trace_processor_shell.exe
```

输出的 `trace_summary.json` 结构为：

```json
{
  "clusterOverview": [],
  "processOverview": [],
  "threadOverview": []
}
```

注意：

- 默认 CPU cluster 映射为 `CPU0-3=小核`、`CPU4-6=中核`、`CPU7+=大核`。
- 文本 trace 主要依赖 `sched_switch` 计算 running/idle，占比会根据线程调度时长估算。已兼容 Android/ftrace 常见格式，以及 OpenHarmony HiTrace 中常见的 `prev_comm:...`、`cpu_id=...`、`C02 ... sched_switch` 等写法。
- 如果鸿蒙 trace 是无法直接读取的私有二进制格式，需要先用对应工具导出为包含 `sched_switch` 的文本，或转换成 Chrome Trace JSON。
- 进程视图按进程 running 负载降序累计前 80%，剩余归 `other process`；线程视图继承这部分 `other process`，只展开前 80% 进程内的线程，并在这些线程里继续按负载降序累计前 80%，剩余归 `other thread`。
- Perfetto 二进制 trace 没有 `trace_processor_shell` 时无法直接解析，脚本会记录 failed；其它场景不受影响。
- 如需发现任何 trace 解析失败就让命令失败，可加 `--strict`。

## 6. 增量更新数据库

正常更新数据库时执行：

```powershell
node scripts/import-source-data.js
```

如果希望一步完成“解析 hitrace 原始 trace -> 更新 `trace_summary.json` -> 增量导入数据库”，可执行：

```powershell
npm run update:data
```

导入结果会写入：

```text
D:\cpu-scenario-library\data\cpu_scenario_library.sqlite
```

如需指定数据源目录或数据库文件：

```powershell
node scripts/import-source-data.js --source D:\cpu-scenario-library\source_data --db D:\cpu-scenario-library\data\cpu_scenario_library.sqlite
```

增量导入规则：

- 新增场景会插入数据库。
- 已存在场景会更新主表，并清理后重写该场景的子表数据。
- 未出现在本次 `source_data` 中的旧场景会保留。
- 场景唯一 ID 由“分类目录 + 场景目录名”生成，例如 `01_game-wzry_replay`。
- 默认使用宽松导入模式：单个场景或单个分段解析失败时会记录 warning，并继续导入其它可识别数据。
- 单个场景失败不会回滚其它场景，导入结果会显示 `已导入场景数/发现的场景数`。

如果看到类似：

```text
Skipped topdown for xxx: Cannot read properties of undefined (reading 'some')
Skipped syscalls for xxx: Cannot read properties of undefined (reading 'map')
```

这表示导入脚本内部对某一行或某个分段的解析遇到了空行、缺失列或非预期表格结构，不表示 Excel 里真的有 `some` 或 `map` 关键字。Excel 中的图片通常存放在 `.xlsx` 的 media/drawing XML 中，导入器只读取工作表单元格文本，不会把图片内容当作指标文本解析。

需要定位具体文件和分段时使用调试模式：

```powershell
node scripts/import-source-data.js --debug
```

调试输出会打印当前导入的 Excel 路径、sheet 行数、识别到的场景基础信息、单 sheet 分段行号，以及被跳过分段的错误堆栈。建议将这段输出连同对应 Excel 一起保存，便于继续增强解析规则。

如果希望发现任何坏表后让命令返回失败，可增加 `--strict`：

```powershell
node scripts/import-source-data.js --strict
```

只有需要清空并重建整个数据库时，才执行：

```powershell
node scripts/import-source-data.js --reset
```

或：

```powershell
node scripts/import-source-data.js --full
```

请勿在目标真实数据环境中随意执行 `scripts/generate-source-data.js`，它会生成示例数据，主要用于本地测试。

## 7. 删除数据库数据

工程提供了安全删除脚本：

```powershell
node scripts/delete-data.js
```

默认不带 `--yes` 时只预览匹配行数，不会真正删除。确认无误后再加 `--yes`。

查看当前场景 ID：

```powershell
node scripts/delete-data.js list-scenarios
```

删除一个完整场景及其所有子表数据：

```powershell
node scripts/delete-data.js scenario 01_game-wzry_replay
node scripts/delete-data.js scenario 01_game-wzry_replay --yes
```

删除某个 TOPDOWN 指标：

```powershell
node scripts/delete-data.js metric topdown --where thread_id=01_game-wzry_replay-main --where "metric=FE BOUND"
node scripts/delete-data.js metric topdown --where thread_id=01_game-wzry_replay-main --where "metric=FE BOUND" --yes
```

删除某个指令分布指标：

```powershell
node scripts/delete-data.js metric instruction --where thread_id=01_game-wzry_replay-main --where event=ld_st_retired --yes
```

删除某个系统调用 TOP 项：

```powershell
node scripts/delete-data.js metric syscall --where thread_id=01_game-wzry_replay-main --where name=futex --yes
```

也可以直接按白名单表删除行：

```powershell
node scripts/delete-data.js row hizee_clusters --where scenario_id=01_game-wzry_replay --where cluster=小核 --yes
```

支持的指标别名：

- `topdown` -> `topdown_metrics`
- `instruction` -> `instruction_metrics`
- `syscall` -> `syscall_top`
- `syscall_metric` / `syscall_density` -> `syscall_metrics`
- `hizee_cluster` -> `hizee_clusters`
- `hizee_scene` -> `hizee_scene`
- `load_cluster`、`load_process`、`load_thread`
- `hotspot_thread`、`hotspot_so`、`hotspot_function`

如需操作非默认数据库文件，可加 `--db`：

```powershell
node scripts/delete-data.js list-scenarios --db D:\cpu-scenario-library\data\cpu_scenario_library.sqlite
```

## 8. 启动服务并查看前端

启动本地服务：

```powershell
node server.js
```

默认访问地址：

```text
http://localhost:5173
```

如需指定端口：

```powershell
$env:PORT=5174
node server.js
```

然后打开：

```text
http://localhost:5174
```

也可以使用 npm 脚本：

```powershell
npm start
```

## 9. 推荐日常更新流程

目标环境每次有新 Excel 或 trace 解析结果时：

1. 将新的场景目录放入 `source_data`，或替换已有场景目录下的 `.xlsx` 和 `hitrace\` 原始 trace。
2. 生成或更新三视图结构化数据：

```powershell
node scripts/update-trace-summary.js
```

3. 执行增量导入：

```powershell
node scripts/import-source-data.js
```

也可以直接使用组合命令：

```powershell
npm run update:data
```

4. 如果 `server.js` 已经在运行，刷新浏览器页面即可看到最新数据库数据。

可以用 Windows 任务计划程序定时执行导入命令，实现周期性更新数据库。

## 10. 快速验证

检查数据库是否已生成：

```powershell
Test-Path .\data\cpu_scenario_library.sqlite
```

检查接口是否正常：

```powershell
curl http://localhost:5173/api/scenarios
```

检查前端：

```text
http://localhost:5173
```

页面中的 Hizee 频率列应展示 `平均频率(Mhz)`、`DDR平均频率(Mhz)`。

## 11. 常见问题

### node:sqlite 报错

说明 Node 版本不满足要求。请升级到 Node.js 24 或更新版本。

### unzip 不是内部或外部命令

说明 Windows 当前 `PATH` 中没有 `unzip.exe`。安装 Git for Windows、MSYS2 或 UnZip for Windows 后，将 `unzip.exe` 所在目录加入系统 `PATH`，重新打开 PowerShell 再执行导入。

### Missing hitrace directory

每个场景目录建议有同级 `hitrace\` 目录。缺失时导入器会记录 warning，并跳过该场景的三视图数据；为了数据完整，即使暂时没有真实 trace，也建议创建该目录。

### Missing trace summary

表示该场景缺少：

```text
hitrace\trace_summary.json
```

这种情况下导入会继续，但负载三视图结构化数据不会入库。

### Perfetto 二进制 trace 解析失败

`.perfetto-trace`、`.pftrace`、`.pb` 等二进制 trace 需要 `trace_processor_shell`。检查：

```powershell
trace_processor_shell --version
```

如果没有加入 `PATH`，可以显式指定：

```powershell
node scripts/update-trace-summary.js --trace-processor D:\tools\trace_processor_shell.exe
```

### 某个 Excel 格式不标准

导入器会尽量按关键词识别单 sheet 中的分段，包括 `负载信息`、`CLUSTER LOAD OVERVIEW`、`TOPDOWN`、`指令分布`、`系统调用`、`Library:`、`Function:` 等。某个分段无法识别时会跳过该分段并输出 warning，不会直接中断整个数据库更新。

如果某个 `.xlsx` 文件损坏或无法解压，该场景会失败并出现在 `Failed scenarios` 列表中，其它场景仍会继续导入。

### 前端没有最新数据

按顺序检查：

1. 是否已执行 `node scripts/import-source-data.js`。
2. `data\cpu_scenario_library.sqlite` 的修改时间是否更新。
3. 浏览器是否刷新了页面。
4. 服务启动目录是否是工程根目录。

### 端口被占用

换一个端口启动：

```powershell
$env:PORT=5174
node server.js
```

## 12. 本地生成示例数据

仅在需要重建演示数据时使用：

```powershell
node scripts/generate-source-data.js
node scripts/import-source-data.js --reset
node server.js
```

生成脚本会创建 5 类、13 个示例场景，并在每个场景目录下生成单 sheet Excel 和同级 `hitrace\trace_summary.json`。
