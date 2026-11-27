# 金沙江流域表层土壤预测档案

ISRIC SoilGrids250m v2.0 的 pH、土壤有机碳含量、黏粒含量和细土容重覆盖 27 个项目子流域。每行记录一个网格中心和一个土层。0–5、5–15、15–30 cm 各有 161,538 条匹配记录，共 484,614 条。

## 数据口径

| 字段 | 单位 | 原始层与换算 |
| --- | --- | --- |
| `ph_h2o` | pH | `phh2o`，整数除以 10 |
| `organic_carbon_g_kg` | g/kg | `soc`，dg/kg 除以 10 |
| `clay_pct` | % | `clay`，g/kg 除以 10 |
| `bulk_density_g_cm3` | g/cm³ | `bdod`，cg/cm³ 除以 100 |

从 ISRIC WCS 2.0.1 获取四项属性的平均预测层，最近邻重采样到 EPSG:4326。原始格网标称 250 m，工作台样点间距约 0.01617° × 0.01709°。采样使用项目 27 个 HydroBASINS 子流域的边界，按网格中心点所在多边形分配 `HYBAS_ID`。以四项匹配、pH 和容重为正的格点计算统计。每层有 161,993 个边界内格点，其中 455 个缺少有效组合。

`profiles.json` 包含逐层、逐流域的样点数、覆盖率、算术均值和空间分位数。统计为样点等权。覆盖率分母是各子流域实际落入的格点数。区间 P10–P90 描述空间样点分布。结果属于静态模型背景，可用于规划调查、研究气候和土壤梯度，与基于野外实测给出生态定级、土壤碳储量的研究用途有不同的数据要求。

`manifest.json` 记录每个源栅格的 URL 和 SHA-256，以及裁剪边界与输出数据的 SHA-256。

## 来源与许可

署名 ISRIC – World Soil Information, SoilGrids v2.0。工作台进行了裁剪、重采样和单位换算。 [ISRIC SoilGrids](https://docs.isric.org/globaldata/soilgrids/) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) · [Poggio 等的产品方法](https://doi.org/10.5194/soil-7-217-2021)

## 查看与重建

在数据资源中打开「SoilGrids 金沙江表层土壤」，选择范围和深度即可同时查看统计和源样点。`/api/scientific` 返回全流域各层统计，可用参数 `basin=HYBAS_ID` 查询子流域。`/api/archives/isric-soilgrids-2-topsoil` 分页查询记录。

重建脚本需要 Python、requests、NumPy、Rasterio 和 Shapely 2。从仓库根目录运行以下命令。

```powershell
python 新工作台/scripts/import_soilgrids.py --cache (Join-Path $env:TEMP 'jinsha-soilgrids-v2')
```
