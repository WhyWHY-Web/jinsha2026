# 金沙江工作台数据服务

在本文件所在目录运行以下命令，启动独立的本地查询原型。使用 Node.js 24 自带的 TypeScript 类型剥离和 HTTP 模块。

    node index.ts

默认监听 http://127.0.0.1:8732。环境变量 JINSHA_WORKBENCH_PORT 可指定端口。源目录默认是同一项目的「系统」，也可用 JINSHA_WORKBENCH_SOURCE 指向另一份原始档案。「新工作台/dist」有 Vite 构建时，同一个服务也提供应用页面。

| 路径 | 返回内容 |
| --- | --- |
| /api/health | 本地服务与站点台账可用状态 |
| /api/dashboard | 站点、流域面平均气候年值、站点 NDVI 均值、地图和目录 |
| /api/stations?q=关键词 | 可按站点名称、代号和分区检索 |
| /api/series?metric=ndvi&station=wudongde | 带单位和来源的时间序列，可用 from / to 筛选年份 |
| /api/engineering | 梯级工程公开参数与历史调度档案 |
| /api/flood/replay | 八个历史日流量过程及四个模型格点的第 95 百分位参考值 |
| /api/flood/series?station=xiangjiaba&year=2020 | 一个格点指定年份的逐日模拟流量 |
| /api/water-quality | 八个国考断面在十个报告期的类别与出处 |
| /api/ecology/options | 区域、年份、指标和情景选择 |
| /api/ecology/assess | 按区域评估，并可指定年份、对照年份和情景 |
| /api/ecology/rsei | 遥感档案、共同覆盖统计与可复核参数 |
| /api/layers/rsei?year=2025 | 子流域绘图值和覆盖率 |
| /api/scientific | 按全流域或子流域查询土壤剖面统计 |
| POST /api/ecology/agent | 自然语言查询、定位、评估和修正草稿 |
| GET 或 POST /api/ecology/amendments | 查看历史或提交通过预览的修正 |
| POST /api/ecology/amendments/preview | 预览受影响站点和旧值，返回提交版本 |
| POST /api/ecology/amendments/{id}/revert | 带版本号撤销修正 |
| /api/catalog | 数据集、条数、来源与覆盖年份 |
| /api/layers/ndvi?year=2025 | 返回当年有值的站点 NDVI，以站点代号为键 |
| /api/layers/river-network | HydroRIVERS 干流与本地支流 GeoJSON。无新增干流数据时可回退到旧档案 |
| /api/layers/basin | 本地原始流域边界 GeoJSON |
| /api/layers/expanded-rivers | 新增 HydroRIVERS 河网归档。默认完整河网，detail=major 提供主要河段 |

可查询指标包括 ndvi、temperature、precipitation、evapotranspiration、discharge 和 rsei。NDVI 的流域视图展示有值站点的算术均值。气候的流域视图使用档案中的「流域面平均」序列。径流档案是 GloFAS 模型模拟，部分站点没有该指标。EEI 与分级来自原始档案中的历史评估快照。

使用 WGS 84 坐标和 Terrarium XYZ 高程瓦片。原有第 10 级高程和第 9–17 级影像按需读取。第 5–9 级高程由原始高程格网重采样，存放在新工作台数据目录。区域晕渲及羽化影像仅在本地两份资源均可用时启用。
