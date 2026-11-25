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

## 本地运行（只有一条命令）

```bash
cd 系统
python server.py
# 浏览器打开 http://127.0.0.1:8080
```

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
