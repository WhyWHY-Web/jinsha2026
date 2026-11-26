# 金沙江流域森林生态环境智能评估系统

融合 AI 与数字孪生的金沙江流域森林生态环境智能评估方法 —— 项目总仓库。

## 目录结构

| 目录 | 内容 |
| --- | --- |
| `系统/` | **主程序**：后端 `server.py` / `main.py` / `features.py`，前端 `web/`，数据构建脚本 `tools/`，文档 `docs/` |
| `系统/docs/` | 方案文档：GEE 遥感数据接入、三人协作数据方案、**数据字典**、软著材料、技术说明 |
| `系统/data/` | 数据：`*.json`（产品运行读取）、`rsei/`+`lulc/`+`nightlight/`+`population/`（分析结果）、`sql/snapshots/`（云库压缩快照） |
| `截图/` | 界面截图（智能巡检、形变监测、登录页、Studio 页） |
| `_fenzu_img/` | 论文/汇报用图（分组结果图） |
| `homarr-portal/` | 门户面板配置 |

## 新手请先读

进入 `系统/` 后看 [系统/README.md](系统/README.md)，包含启动方式、账号、外网访问方法。

> **数据没跟着仓库走？** 看 [数据获取说明.md](数据获取说明.md)——哪些大文件（`dem.bin` 地形、`detail/` 实景、`tiles/` 2D底图）需要单独索取、放到哪个目录、缺了会怎样，都写清楚了。

## 本地运行（只有一条命令）

```bash
cd 系统
python server.py
# 浏览器打开 http://127.0.0.1:8080
```

## 分发给别人电脑（单文件 exe，双击即用）

`系统/build_dist.py` 会把前端 + 运行所需数据（3D 地形 dem.bin、河流、图表 JSON、实景块 detail/patch，约 120MB）一起打进**一个 exe**，对方电脑无需装 Python、无需带 data 目录，双击即开：

```bash
cd 系统
python build_dist.py
# 产物：系统/_dist/金沙江生态评估.exe（约 140MB）
```

- 已排除：2D 底图瓦片 `data/tiles`(246MB)、前端不引用的 `data/rsei/*.tif`(50MB)、`tiles_dem`(38.5MB)、`sql` 快照
- 启动器 `boot.py` 自动按「内置数据(_MEIPASS/data) → exe 同目录 data → 上级 data」顺序找数据；端口被占会自动顺延，不会因旧进程占 8080 而起不来
- 首次启动会把内置数据解压到系统临时目录，约需 10~30 秒；之后每次启动仍需解压（PyInstaller onefile 特性）

## 当前前端能力（2026-11 版本）

三维主界面（`系统/web/app.html`）已完成信息架构重构：

- **顶部**：全局核心指标条（EEI / 综合风险 / 高风险站 / NDVI退化 / 站点数 / 年均温），单一来源不重复
- **左栏**：优先核查站点（红/橙/黄风险分级，置顶行动区）→ 核心结论卡（等级+结论+证据入口）→ 干流三段 → NDVI趋势 → 分区聚合 → 多源数据 → 指标体检
- **中央三维**：地形/河道/站点光柱；顶部站点搜索定位；底部工具分组（图层管理 / 视角·视图·分析 + 更多菜单）；统一图例可折叠；统一时间轴（NDVI+气候联动）
- **右栏**：数据状态（更新时间/指标项数/实测模型/遥感代理）+ 生成核查任务/导出报告；选中站点时显示站点摘要
- **左右面板可折叠**，折叠后地图铺满
- **联动闭环**：点站点/搜索/左栏列表 → 地图飞行 + 站点卡 + 右栏摘要；点空白恢复流域总览
- **模拟运行中心**：未接入/可配置/运行中/已完成/失败 五态 + 运行中可取消
- **AI 模块**：结构化评估卡（结论—指标依据—影响因子—数据完整度—核查建议），区分实测 A 与模型 B/C/D

> 详细改动与踩坑记录见 `.workbuddy/memory/`（项目记忆）与 git 提交历史。

## 未纳入仓库的内容（体积大 / 含密钥 / 可重新生成）

以下内容**不在**仓库里，需要时由 `系统/tools/` 下的脚本重新生成，或向项目负责人索取：

- `系统/data/tiles*`、`detail/`、`basin/`、`patch/`、`dem.bin` —— 约 450MB 遥感切片与地形数据
- `系统/dist/`、`系统/tools/bin/` —— 约 430MB 打包产物
- `系统/tools/gee-key.json` —— Google Earth Engine 服务账号密钥（**严禁提交**，需自行向负责人索要并放到该路径）
- `node_modules/`、`__pycache__/`、`*.exe`、`*.sqlite` —— 本地依赖与运行态数据

> 新增了大文件或密钥时，先确认 `.gitignore` 已覆盖，再 `git add`。

## 数据快照备份（每周跑一次）

云数据库负责三人实时共享与 SQL 查询，Git 负责版本留痕。为了让论文数据可追溯，用这个脚本把库里的全部表倒成压缩 CSV 存进仓库：

```bash
cd 系统
python tools/backup_to_repo.py --push     # 导出 + 自动提交推送
```

- 产物在 `系统/data/sql/snapshots/<时间戳>/`，约 40 个对象、13.5 万行，压缩后约 1.2 MB
- 每份快照附带 `MANIFEST.json`（导出时间、来源库、每表行数与体积），可用来核对数据是否走样
- 默认只保留最近 8 份，更早的自动清理（历史仍留在 Git 里）
- 连接优先级：`--dsn` 参数 > 环境变量 `JINSHA_DSN` > 本机 docker `jinsha-pg`，不会静默连错库

## 数据看板与分析结果

启动服务后访问 `http://127.0.0.1:8080/dashboard`，ECharts 展示 RSEI 时序、土地利用、夜间灯光、人口、Moran's I 五类图（数据来自 `data/*.json`，本地离线可用）。

已落地的核心分析结果（均真实计算，脚本见 `系统/tools/`）：

| 数据集 | 期数/行数 | 来源 | JSON |
| --- | --- | --- | --- |
| RSEI 年度 | 8 期（1990–2025 每 5 年） | Landsat C2 L2 + PCA | `data/rsei/rsei_all.json` |
| 空间自相关 Moran/LISA | 8 期 | RSEI 1km 格网 + Queen 邻接 | `data/rsei/moran_lisa.json` |
| 土地利用 | 207 行（2001–2023） | MODIS MCD12Q1 | `data/lulc/lulc.json` |
| 夜间灯光 | 13 期 | VIIRS + DMSP | `data/nightlight/nightlight.json` |
| 人口 | 25 行 | GHS-POP + WorldPop | `data/population/population.json` |

完整字段说明与行数核对见 [系统/docs/数据字典.md](系统/docs/数据字典.md)。云库全部表+视图的压缩快照在 `系统/data/sql/snapshots/<时间戳>/`（38 对象 / 约 13.5 万行，含 MANIFEST 行数核对）。

## 协作约定

1. 拉取最新代码：`git pull`
2. 改完提交：`git add -A && git commit -m "说明改了什么" && git push`
3. 同一文件多人改容易冲突，动手前在群里说一声；大改动建议新建分支
