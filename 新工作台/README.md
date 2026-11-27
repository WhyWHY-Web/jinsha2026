# 金沙江智能生态评估工作台

本目录包含独立前端和后端。新工作台从既有资料读取站点、流域边界和可用影像，并通过独立目录加载新获取的公开资料。

- [在线浏览](https://whywhy-web.github.io/jinsha2026/)使用公开的研究数据。支持地图、评估、档案查询和导出。
- [Windows 软件](https://github.com/WhyWHY-Web/jinsha2026/releases)解压后即可启动。包内含运行时和离线资料，工作台在默认浏览器打开。
- 桌面版可按区域选站，并对年度气候数据做预览、修正、确认与撤销。工作台生效值和原始档案都可追溯。

## 启动

需要 Node.js 24。安装依赖并构建之后，工作台和地图可以在本地运行。服务地址为 `http://127.0.0.1:8732/`。开发服务只监听本机。

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd start
```

默认从同级的旧项目目录读取本地资料。需要指定源目录时，可设置 `JINSHA_WORKBENCH_SOURCE`。衍生地形瓦片由 `tools/prepare_terrain.py` 从实有的 4096² 高程栅格重投影生成，输出到 `data/terrain`。

工作台使用 Node 的 SQLite 将修正写入本机状态文件。可用 `JINSHA_WORKBENCH_STATE` 指定该文件路径。智能体默认查询本机 Ollama 的 `qwen2.5:3b`。可用 `JINSHA_AGENT_MODEL` 指定已安装的本机模型或设为 `off`。无可用模型时，离线指令仍可查询评估结果和定位站点。

## 前端和后端如何选

| 路线 | 前端与地图 | 数据与 API | 适用条件 |
|---|---|---|---|
| 浏览器数字孪生 | React + TypeScript + CesiumJS | Go 或 ASP.NET Core + PostGIS。科学处理用 Python | 研究区需要进一步上载坝体、点云、无人机实景和分级高精地形 |
| 多图层地理分析 | React + MapLibre GL JS，可增加 deck.gl | Node.js/Go + PostGIS。单机查询可组合 DuckDB Spatial 与 GeoParquet | 重点是空间筛选、历史对照、大量资料图层和本机浏览 |
| 专用展厅 | Unreal Engine + Cesium for Unreal | 共用空间数据服务 | 固定显示设备，重点是低空漫游、模型和大屏演示，可承担较重的客户端交付 |

当前原型采用第二条路线的地图和轻量 Node.js 数据 API。底部导航联动地图、双侧面板与时间轴。流域态势中的植被演变可按年重放站点 NDVI，工程与调度呈现有出处的工程档案，洪水专题以历史模拟日流量重放洪峰。

生态评估涵盖综合生态质量、森林退化、滑坡敏感性、水源涵养、土壤保持与模型碳密度。情景页支持模型敏感性对照。年度比较基于两期均有输入的相同站点。风险等级用于研究筛查。

推荐将栅格及大文件以 COG 保存，并用 STAC 记录来源、日期和范围。PostGIS 用于站点、河段与流域边界的空间联查。Martin 可针对常用图层发布矢量瓦片。

[Cesium 地形](https://cesium.com/learn/cesiumjs-learn/cesiumjs-terrain/) · [Cesium 离线指南](https://github.com/CesiumGS/cesium/blob/main/Documentation/OfflineGuide/README.md) · [MapLibre 地形](https://maplibre.org/maplibre-gl-js/docs/examples/3d-terrain/) · [deck.gl](https://deck.gl/docs/developer-guide/base-maps/using-with-maplibre) · [Cesium for Unreal](https://cesium.com/learn/unreal/unreal-faq/)

[PostGIS 空间索引](https://postgis.net/documentation/faq/spatial-indexes/) · [OGC COG](https://docs.ogc.org/is/21-026/21-026.html) · [OGC STAC](https://www.ogc.org/standards/stac/) · [Martin](https://maplibre.org/martin/architecture/) · [.NET 单文件发布](https://learn.microsoft.com/dotnet/core/deploying/single-file/overview)

## 原型中的数据

- 高分辨率三维窗口为经度 97.6–105.4°E、纬度 25.9–32.5°N。外圈以 Mapzen Terrarium 瓦片派生的区域晕渲连续显示。高程资料由美国地质调查局和 NOAA 提供。区域晕渲与原卫星影像边缘羽化由 `tools/prepare_map_context.py` 生成。全流域模式可查看边界和主要河段。 [Mapzen 开放数据目录](https://registry.opendata.aws/terrain-tiles/) · [高程资料署名](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
- HydroRIVERS 加入了 27,524 条公开河段，包含 4,248 条供界面使用的主要河段。径流长期估计来自模型数据。 [数据来源与许可](data/河网来源.md)
- NOAA GHCN-Daily 表包含流域内 11 站、694,730 条气温、降水和雪深日记录。日期 1980-01-01 至 2026-11-21，按站实有覆盖。 [目录](data/ghcn/manifest.json) · [NOAA 产品](https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-daily)
- ESA WorldCover 2021 表包含 447,637 个 0.01° 网格类别样本。样本由官方遥感产品概览层获得，精细变化研究需另按原始分辨率处理。 [目录](data/landcover/manifest.json) · [ESA 产品](https://esa-worldcover.org/en/data-access)
- CHIRPS v2.0 表包含 713 个流域内点的 391,437 条月降水记录，覆盖 1981-01 至 2026-09。以 0.25° 点距对官方 0.05° 产品进行抽样。 [目录](data/precipitation/manifest.json) · [UCSB CHIRPS](https://www.chc.ucsb.edu/data/chirps)
- GloFAS v4 日流量增加 42,368 条模型再分析记录。石鼓、攀枝花、屏山、向家坝四个代表格点覆盖 1997–2025 年。洪水专题以向家坝格点的年度最大日流量选取 8 个历史过程，用各格点自身日流量的第 95 百分位进行比较。 [Open-Meteo Flood API](https://open-meteo.com/en/docs/flood-api)
- 工程专题收录乌东德、白鹤滩、溪洛渡、向家坝四座电站的设计参数和 2023 年发电量。调度页包含 2018–2026 年的 12 份公开管理文件、生态试验和阶段总结。 [工程与调度档案](data/engineering/catalog.json)
- 水质专题录入 8 个选录断面、10 个报告期的 80 条地表水类别记录，按同口径报告期对照。应急专题定位 2018 年白格堰塞湖并展示官方通报的 4 个历史节点。 [水质来源](data/water-quality/reports.ts) · [应急管理部通报](https://www.mem.gov.cn/xw/bndt/201811/t20181112_229767.shtml)
- ISRIC SoilGrids v2.0 增加 484,614 条三层土壤栅格记录。土壤剖面按子流域和深度显示样点覆盖，以及 pH、有机碳含量、黏粒含量和细土容重分布。 [数据说明](data/scientific/README.md)
- RSEI 研究档案按 27 个子流域重新裁剪和汇总，支持全流域、8 期、任意两期共同有效覆盖、地图着色及带来源哈希的统计导出。原 GeoTIFF 的零值编码有歧义，界面注明掩膜规则。 [统计与来源](data/ecology/rsei-support.json)
- 区域三维模式以 115 张 Mapzen Terrarium 瓦片覆盖全流域。内区读取原档案及衍生高程。在线版影像由 NASA Blue Marble 提供。 [瓦片来源](https://registry.opendata.aws/terrain-tiles/) · [NASA Blue Marble](https://visibleearth.nasa.gov/collection/1484/blue-marble)
- 用户现有站点、气候、NDVI 与径流资料仍以档案显示。数据资源页可浏览新表，并可按年份、站号或类别筛选和分页。数据表字段、质量检查、授权信息与复现脚本一并存放在本目录内。

后端接口详见 [服务说明](server/README.md)。
