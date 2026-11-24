# GEE 遥感数据接入方案（金沙江流域）

> 目标：把 Google Earth Engine 上的公开遥感产品，变成**可参与指标计算、可追溯、可增量更新**的数值序列，
> 补上现有系统「时序 × 遥感 × 土壤」三块短板，同时不破坏「单命令启动、离线可用、服务端零依赖」的既有约束。

---

## 一、总体架构：三层分离，云端算、只取结果

```
                    ┌─────────────────────────── GEE 云端 ───────────────────────────┐
  MODIS / GPM /     │  影像集合 → 云雪掩膜 → 时间合成 → reduceRegions(站点缓冲区)   │
  ERA5-Land / GEDI  │  输出：20 站 × 每月 1 行的数值表（几千行），不是栅格          │
                    └───────────────────────────────┬───────────────────────────────┘
                                                    │ tools/gee_sync.py（批处理，可装重依赖）
                                    ┌───────────────┴───────────────┐
                                    ▼                               ▼
                     PostgreSQL jinsha              data/gee/*.json（运行时缓存）
                     遥感月值 / 年值 / 趋势             series / annual / meta
                     遥感静态值 / 同步日志                        │
                                    └───────────────┬───────────────┘
                                                    ▼
                              server.py（纯标准库，零 pip 依赖）  /api/rs/*
                                                    ▼
                                 web/app.html（Three.js 场景 + 指标面板）
```

**为什么不在服务端直接连 GEE**：`server.py` 的设计前提是「随 exe 自带、免安装、离线可跑」。
在运行时引入 `earthengine-api` + OAuth + 网络，会让这套东西全部失效，一次断网整个系统就打不开。
所以 GEE 只出现在**构建/批处理层**（和现有 `tools/fetch_climate.py`、`tools/build_detail.py` 完全同构），
运行时只读它落地的 JSON。

---

## 二、可用数据字段与时间范围

`tools/gee_sync.py` 的 `DS` 注册表是唯一事实来源，下表与之逐行对应。

| 指标代码 | 数据集（GEE ID） | 字段/波段 | 单位 | 定标 | 时间范围 | 时间分辨率 | 空间分辨率 | 在本项目中的用途 |
|---|---|---|---|---|---|---|---|---|
| `ndvi` | `MODIS/061/MOD13Q1` | `NDVI` | 无量纲 | ×0.0001 | 2000-02 → 今 | 16 天合成（取月均值） | 250 m | 植被长势、**退化趋势**主指标 |
| `evi` | `MODIS/061/MOD13Q1` | `EVI` | 无量纲 | ×0.0001 | 2000-02 → 今 | 同上 | 250 m | 高覆盖区不饱和，与 NDVI 互为校验 |
| `treecover` | `MODIS/061/MOD44B` | `Percent_Tree_Cover` | % | ×1 | 2000 → 今 | 年 | 250 m | 替代当前「5 km 缓冲推算」的树冠覆盖 |
| `lst` | `MODIS/061/MOD11A2` | `LST_Day_1km` | ℃ | ×0.02 − 273.15 | 2000-03 → 今 | 8 天合成（取月均值） | 1 km | 地表温度、干热河谷识别 |
| `precip` | `NASA/GPM_L3/IMERG_MONTHLY_V07` | `precipitation` | mm/月 | ×1 | 2000-06 → 今 | 月 | 0.1°(≈11 km) | 与 NASA POWER 降水互校，补山区地形雨 |
| `temp` | `ECMWF/ERA5_LAND/MONTHLY_AGGR` | `temperature_2m` | ℃ | −273.15 | 1950-01 → 今 | 月 | 0.1°(≈9 km) | 比 MERRA-2 0.5° 更贴合山地 |
| `et` | `ECMWF/ERA5_LAND/MONTHLY_AGGR` | `total_evaporation_sum` | mm/月 | ×(−1000) | 1950-01 → 今 | 月 | 0.1° | 干燥指数、水源涵养的物理输入 |
| `agbd` | `LARSE/GEDI/GEDI04_A_002_MONTHLY` | `agbd` | Mg/ha | ×1 | 2019-04 → 今 | 月合成（条带采样） | 25 m 足迹 | 地上生物量/碳储量，替代经验系数 |
| `soil_oc` | `OPENLANDMAP/SOL/SOL_ORGANIC-CARBON_USDA-6A1C_M/v02` | `b0` | g/kg | ×5 | 静态 | 静态 | 250 m | 补齐「土壤要素」（老师提的后期项） |

**待评估、暂未纳入**（写在这里避免"假装有"）：

- `UMD/hansen/global_forest_change_*`：森林变化以 30 m 逐年给出，但"损失"是二值事件，落到站点缓冲区会退化为比例，
  需配合 LandTrendr 才有趋势意义 → 放到二期。
- `GOOGLE/DYNAMICWORLD/V1`：10 m 近实时土地覆盖，适合替换 2017–2021 复合产品，但类别体系与现有 7 类需重新映射 → 二期。
- `COPERNICUS/S2_SR_HARMONIZED`：云掩膜与 5 日重访带来大量无效像元，站点级月合成成本高 → 仅用于样本区核查。

**时间范围口径**：月值覆盖「产品起始月 → 上一个月」（当月不完整不采）；年值覆盖「起始年 → 上一完整年」。

---

## 三、采集与访问方式

### 3.1 认证与配额（关键前提）

- GEE 自 **2024-11-13** 起强制绑定 Google Cloud 项目；非商业（科研/教学）**免费**。
- 非商业默认 **Community Tier：150 EECU-hours/月**（无需结算账号）；Contributor 档 1000 EECU-hours/月。
  本项目一次全量同步（20 站 × 8 指标 × 25 年）实测在数十 EECU-minutes 量级，月度增量几乎可忽略。
- 两种凭据：
  1. **服务账号**（推荐，可无人值守）：Cloud 控制台建 SA → 下载 JSON → 存 `tools/gee-key.json` → 项目里授予 EE 角色；
  2. **个人 OAuth**：本地执行一次 `earthengine authenticate`（会写入 `~/.config/earthengine`）。
- 命令行：

```bash
python tools/gee_sync.py --check --project your-gee-project       # 只验证数据集与波段，不写库
python tools/gee_sync.py --dry-run                                # 打印计划（不联网）
python tools/gee_sync.py --project your-gee-project --start 2015  # 增量：2015 年起
python tools/gee_sync.py --project your-gee-project --full         # 全量重算
python tools/gee_sync.py --export-only                             # 不重跑 GEE，仅从库重建缓存
```

### 3.2 采样策略

- 每个站点建 **1 km 缓冲区**（`Geometry.Point.buffer(1000)`），`reduceRegions` 取 `mean` + `count`；
- 用 `count` 判断"这个月是否真有有效像元"——全云月份会被标 `missing`，而不是记成 0；
- 缓冲区半径可调 `--radius`；对 GEDI 这类条带数据，1000 m 内可能整月无足迹，属正常缺失。

### 3.3 性能设计（工程要点）

逐月 `reduceRegions` 是 300 次往返（25 年 × 12 月）。脚本改为**把一年 12 个月合成到一张 12 波段影像**，
再一次性 `reduceRegions` → 往返次数从 300 降到 25，单指标全量同步从十几分钟压到 1–2 分钟。

```python
img = None
for m in months:
    band = monthly_composite(...)      # 掩膜 + 合成 + rename('NDVI_2020_01')
    img = band if img is None else img.addBands(band)
img.reduceRegions(collection=station_fc(...), reducer=mean+count, scale=250, tileScale=4)
```

---

## 四、后端存储与更新策略

### 4.1 双写：库是账本，JSON 是运行时候

| 位置 | 角色 | 内容 | 谁读 |
|---|---|---|---|
| PostgreSQL `jinsha` | **系统 of record** | `遥感月值` / `遥感年值` / `遥感趋势` / `遥感静态值` / `遥感同步日志` | 分析、答辩查证、`/api/rs/*` 的上游 |
| `data/gee/series.json` | 运行时缓存 | `{指标: {站点: [[年月, 值, 质量], …]}}` | `server.py`（纯标准库，秒级响应） |
| `data/gee/annual.json` | 运行时缓存 | `{指标: {站点: [[年, 年值], …]}}` | 趋势卡、折线 |
| `data/gee/meta.json` | 批次元数据 | 版本、时间、采样半径、指标清单 | `/api/rs/status`、`/api/provenance` |

写库通道**三级降级**：`psycopg2` → 本机 `psql` → `docker exec jinsha-pg psql`。
学院机器常常只有 Docker 没有 Python 驱动，不因为缺一个包就让整条链路失败；三通道都不可用时，
脚本仍会写 `data/gee/*.json`，前端照常可用。

### 4.2 更新策略

| 触发 | 频率 | 动作 |
|---|---|---|
| 月度增量 | 每月 3 日（上一个月数据稳定后） | `--start <当年>`，只补最近 12 个月 |
| 年度回补 | 每年 1 月 | 补上一年，并重算 `遥感年值` / `遥感趋势` |
| 规则变更 | 手动 | 改 `qc_value`/`fill_missing` 后 `--export-only` 重建缓存，不重跑 GEE（省配额） |
| 全量重算 | 极少 | `--full` |

**幂等**：所有写库语句都是 `INSERT … ON CONFLICT (主键) DO UPDATE`，重复跑不会产生重复行。
**版本**：`meta.version = YYYY.MM.DD-HHMM`，`/api/provenance` 与前端数据血缘卡直接展示。
**陈旧判定**：`DATA_LAYERS` 里 GEE 层 `stale=45 天`，超期前端标黄"陈旧"，不隐藏、不粉饰。

### 4.3 数据模型（实际已建表，见 `data/sql/gee_tables.sql`）

```sql
-- 长表统一承载所有时序指标，避免"一个产品一张表"的表爆炸
"遥感月值"("站点" text, "年月" text, "指标代码" text, "指标名称" text,
          "数值" double precision, "单位" text, "质量标记" text, "采集时间" timestamptz,
          PRIMARY KEY ("站点","年月","指标代码"))
"遥感年值"("站点","年份","指标代码","数值","单位","质量标记","采集时间",
          PRIMARY KEY ("站点","年份","指标代码"))
"遥感趋势"("站点","指标代码","Sen斜率","MK_Z","MK_P","趋势","单位","采集时间",
          PRIMARY KEY ("站点","指标代码"))
"遥感静态值"("站点","指标代码","指标名称","数值","单位","采集时间", PRIMARY KEY ("站点","指标代码"))
"遥感同步日志"("开始时间","指标","站点数","耗时秒","状态")
```

配套视图 `"遥感概览"`：一站一行给出月值条数、覆盖起止、最新 NDVI 年值、NDVI 的 Sen 斜率与趋势、土壤有机碳，
供前端「数据管理」直接消费（也能被智能体的 `db_query` 直接 `select * from "遥感概览"`）。

`质量标记` 取值：`ok` / `interp`（短缺口插补）/ `missing`（无有效像元）/ `out_of_range`（定标后越界）/ `sparse`（年值有效月 < 6）。

---

## 五、预处理要求（逐条对应"清洗 / 坐标 / 单位 / 缺失值"）

### 5.1 数据清洗

| 环节 | 做法 | 代码位置 |
|---|---|---|
| 云 / 雪 / 阴影 | 用各产品**官方 QA 位**，不做启发式去云：MOD13Q1 `SummaryQA ≤ 1`、MOD11A2 `QC_Day & 3 ≤ 1`、GEDI `l4_quality_flag==1 且 degrade_flag==0` | `mask_image()` |
| 无效像元 | `updateMask` 后参与合成；合成后 `count==0` 判为整月无效 | `monthly_composite()` |
| 定标 | 每产品集中登记 `scale/offset`（NDVI ×0.0001、LST ×0.02−273.15、ET ×(−1000)） | `DS` 注册表 |
| 物理区间 | 定标后越界不丢弃，保留原值并打 `out_of_range`，供人工复核 | `qc_value()` |
| 重复 / 幂等 | 主键冲突即更新，不追加 | `ON CONFLICT DO UPDATE` |

### 5.2 坐标统一

- 全部统一到 **EPSG:4326（WGS-84 经纬度）**，与 `stations.json`、DEM、Esri 影像一致，不做投影转换；
- 站点缓冲区用 `ee.Geometry.Point([lon,lat]).buffer(米)`，GEE 内部按测地线计算，跨纬度不会变形；
- 采样尺度显式指定（MODIS 250 m、ERA5 1000 m），**不让 GEE 用默认 30 m 无谓放大计算量**；
- 与现有 `dem.bin` 的 `BBOX=(97.6,25.9,105.4,32.5)` 完全同域，站点点位可直接复用。

### 5.3 单位统一

统一到本项目已在用的单位体系，写进 `单位` 字段，前端不再做二次换算：

| 量 | 原始 | 统一为 | 换算 |
|---|---|---|---|
| 温度 | K | ℃ | −273.15 |
| 降水 | mm/月 | mm/月 | 已是月累计 |
| 蒸散 | m（负值，向下） | mm/月（正） | ×(−1000) |
| NDVI/EVI | int16 | 无量纲 | ×0.0001 |
| 树冠覆盖 | % | % | ×1 |
| 生物量 | Mg/ha | Mg/ha | ×1 |
| 土壤有机碳 | 5 g/kg 定标 | g/kg | ×5 |

### 5.4 缺失值处理

规则明确写死，避免"随便插值把趋势插出来"：

1. **短缺口**（前后有效值间隔 ≤ 4 个月）→ 线性插补，标 `interp`；
2. **长缺口**（> 4 个月，或序列两端）→ 保持 `null`，不插补；
3. **年值**：有效月 < 6 个月 → 仍计算但标 `sparse`，趋势检验时按缺失处理；
4. **趋势检验**：只对有值年份做 Sen + Mann-Kendall，`n < 10` 不出结论（不硬凑显著性）；
5. 前端与接口一律把 `null` 显示为 `—`，不用 0 代替——0 在生态指标里是真实取值，混淆会误导判断。

### 5.5 异常值

复用「区域治理」模块已有的稳健判定（中位数 + 1.4826·MAD，气温先按 6.5 ℃/km 订正到站点高程）。
遥感序列入库后同样可被 `anomaly_scan` 扫描，形成「遥感发现异常 → 人工确认 → 台账留痕」的闭环。

---

## 六、接口设计（已实现，纯标准库）

| 接口 | 方法 | 说明 | 返回要点 |
|---|---|---|---|
| `/api/rs/status` | GET | 批次状态 | `available`、`meta.version/updated/radius_m`、每指标的 `rows/stations/from/to` |
| `/api/rs/series?metric=ndvi&station=巴塘` | GET | 单站月序列 | `points: [[年月, 值, 质量], …]` |
| `/api/rs/trend?metric=ndvi` | GET | 全站趋势 | `items: [{station, sen, z, p, trend, latest}]`，按 Sen 升序（退化最重在前） |
| `/api/rs/basin` | GET | 流域平均年值 | `{指标: [[年, 值], …]}`，供折线/趋势卡 |
| `/api/provenance` | GET | **数据血缘** | 每层 `来源/分辨率/更新节律/文件时间/年龄/状态/覆盖区间` |
| `/api/data/version` | GET | 轻量指纹 | `token`（人工修正、站点表、气候、遥感批次任一变化即变） |

前端的实时机制（`web/assets/datasrc.js`）：

```
每 20 s: GET /api/data/version  →  token 未变则什么都不做
                                  token 变了 → dataHubTick() 重拉站点 + 重绘当前模块 + toast 提示
每 30 s: GET /api/legacy/stations + /api/trend（DataHub 轮询，指数退避 15→120 s）
```

只比对指纹、不整页重绘，既保证"最新"，又不会让三维场景每 30 秒闪一次。

---

## 七、与现有指标的接入点

不改动既有公式，只把"经验估算"逐步替换为"遥感输入"，每一步都可回退：

| 现有指标 | 现在 | 接入后 | 改动位置 |
|---|---|---|---|
| 植被覆盖 FVC | 下垫面占比加权（`_m()` 内 `fvc`） | NDVI 生长季均值经像元二分模型反演 | `server.py: _m()` |
| 退化风险 `deg` | 覆盖 + 干燥指数静态估算 | NDVI 年值 Sen 斜率 + MK 显著性（显著下降则上调） | `_m()` + `/api/rs/trend` |
| 树冠覆盖 | 5 km 缓冲 LULC 推算 | MOD44B 站点缓冲区均值 | `legacy_station()` |
| 碳密度 | 覆盖 × 经验系数 | GEDI L4A 地上生物量 × 含碳率 0.47 | `_m()` |
| 干燥指数 | 降水/蒸散参考值 | ERA5-Land 月值年聚合 | `_m()` |
| 土壤 | 无 | `soil_oc` 静态值 | 新增字段 |

**实施顺序建议**：先接 `ndvi` + `precip` + `temp`（数据最稳、覆盖最长）→ 再 `treecover`、`et` →
最后 `agbd`（GEDI 条带稀疏，必须先做缺失策略）。

---

## 八、落地步骤与风险

**步骤（预计 1–2 天）**

1. 注册 GEE 非商业 Cloud 项目，建服务账号，存 `tools/gee-key.json`；
2. `python tools/gee_sync.py --check --project <id>`，确认 8 个数据集的波段名与影像数；
3. `python data/sql/gee_tables.sql`（已建）→ `python tools/gee_sync.py --start 2015`；
4. 打开「数据管理」，数据血缘卡应显示 GEE 层为"正常"并给出覆盖区间；
5. 抽查 3 个站的 NDVI 年值，与 MODIS 官方时序图对齐后，再改 `_m()` 的指标口径。

**风险与对策**

| 风险 | 影响 | 对策 |
|---|---|---|
| 配额耗尽（150 EECU-h/月） | 同步中断 | 年度增量只跑近 12 个月；`--export-only` 避免重算 |
| 服务账号无权限 | 401 | 在 Cloud 项目给 SA 授予 Earth Engine Resource Viewer/Writer |
| GEDI 条带稀疏 | 大量 `missing` | 年值聚合 + `sparse` 标记，不启用单月生物量 |
| ERA5/IMERG 分辨率粗 | 山地代表性不足 | 只做区域气候背景，站点实测仍以台站/再分析订正值为准，界面标注来源 |
| 数据产品改版（如 Hansen 版本号） | 脚本报错 | 数据集 ID 集中在 `DS` 注册表，改一行即可 |

---

## 九、口径声明（答辩可直接引用）

> 遥感序列为 **GEE 云端按站点 ±1 km 缓冲区统计的产品级数值**，非样地实测；
> MODIS 250 m/1 km、ERA5-Land 0.1°、IMERG 0.1° 的空间代表性有限，山区存在混合像元与地形效应；
> 已按各产品官方 QA 位掩膜云雪，短缺口线性插补并标记，长缺口保留缺失；
> 趋势为 Sen 斜率 + Mann-Kendall 检验，样本不足 10 年不出结论。
> 原始栅格不入库，入库的是可追溯、可复算的站点统计值。
