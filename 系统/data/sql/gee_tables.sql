-- ═══════════════════════════════════════════════════════════════════════════
-- GEE 遥感数据接入 · 表结构（jinsha 库）
-- 与库内既有表（站点 / 气候月值 / 气候趋势 / 数据源）保持同一套中文命名与粒度
-- 执行：docker exec -i jinsha-pg psql -U postgres -d jinsha -f - < data/sql/gee_tables.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) 遥感月值：所有时序产品统一长表，指标代码见 tools/gee_sync.py 的 DS 注册表
CREATE TABLE IF NOT EXISTS "遥感月值" (
  "站点"      text NOT NULL,
  "年月"      text NOT NULL,              -- YYYY-MM
  "指标代码"  text NOT NULL,              -- ndvi / evi / lst / precip / temp / et / agbd
  "指标名称"  text,
  "数值"      double precision,           -- 已定标、已单位换算后的物理量
  "单位"      text,
  "质量标记"  text,                       -- ok / interp / missing / out_of_range
  "采集时间"  timestamptz DEFAULT now(),
  PRIMARY KEY ("站点", "年月", "指标代码")
);
CREATE INDEX IF NOT EXISTS idx_rs_month ON "遥感月值" ("指标代码", "年月");

-- 2) 遥感年值：生长季均值（植被/温度）或年累计（降水/蒸散），趋势检验的输入
CREATE TABLE IF NOT EXISTS "遥感年值" (
  "站点"      text NOT NULL,
  "年份"      text NOT NULL,              -- YYYY
  "指标代码"  text NOT NULL,
  "数值"      double precision,
  "单位"      text,
  "质量标记"  text,                       -- ok / sparse（有效月 < 6）
  "采集时间"  timestamptz DEFAULT now(),
  PRIMARY KEY ("站点", "年份", "指标代码")
);

-- 3) 遥感趋势：Sen 斜率 + Mann-Kendall，与库内「气候趋势」表同口径
CREATE TABLE IF NOT EXISTS "遥感趋势" (
  "站点"      text NOT NULL,
  "指标代码"  text NOT NULL,
  "Sen斜率"   double precision,           -- 每年变化量（NDVI 无量纲/年，降水 mm/年）
  "MK_Z"      double precision,
  "MK_P"      double precision,
  "趋势"      text,                       -- 显著上升 / 显著下降 / 无显著趋势
  "单位"      text,
  "采集时间"  timestamptz DEFAULT now(),
  PRIMARY KEY ("站点", "指标代码")
);

-- 4) 遥感静态值：土壤、地形一类不随时间变化的属性
CREATE TABLE IF NOT EXISTS "遥感静态值" (
  "站点"      text NOT NULL,
  "指标代码"  text NOT NULL,              -- soil_oc …
  "指标名称"  text,
  "数值"      double precision,
  "单位"      text,
  "采集时间"  timestamptz DEFAULT now(),
  PRIMARY KEY ("站点", "指标代码")
);

-- 5) 同步日志：每次批处理一行，便于回答「数据是哪天采的、覆盖多少站」
CREATE TABLE IF NOT EXISTS "遥感同步日志" (
  "开始时间"  text,
  "指标"      text,
  "站点数"    integer,
  "耗时秒"    double precision,
  "状态"      text
);

-- 6) 便捷视图：一站一行的遥感概况，前端「数据管理」直接读它
CREATE OR REPLACE VIEW "遥感概览" AS
SELECT s."名称" AS "站点",
       (SELECT count(*) FROM "遥感月值" m WHERE m."站点" = s."名称")  AS "月值条数",
       (SELECT min("年月") FROM "遥感月值" m WHERE m."站点" = s."名称") AS "起始月",
       (SELECT max("年月") FROM "遥感月值" m WHERE m."站点" = s."名称") AS "结束月",
       (SELECT "数值" FROM "遥感年值" a WHERE a."站点" = s."名称"
          AND a."指标代码" = 'ndvi' ORDER BY "年份" DESC LIMIT 1)      AS "最新NDVI年值",
       (SELECT "Sen斜率" FROM "遥感趋势" t WHERE t."站点" = s."名称"
          AND t."指标代码" = 'ndvi')                                   AS "NDVI_Sen斜率",
       (SELECT "趋势" FROM "遥感趋势" t WHERE t."站点" = s."名称"
          AND t."指标代码" = 'ndvi')                                   AS "NDVI趋势",
       (SELECT "数值" FROM "遥感静态值" v WHERE v."站点" = s."名称"
          AND v."指标代码" = 'soil_oc')                                AS "土壤有机碳gkg"
FROM "站点" s
ORDER BY s."站点ID";

-- 7) 数据源台账补两行，让「数据管理」页能显示 GEE 已接入
INSERT INTO "数据源" ("数据源ID","分类ID","数据源名称","英文名称","来源机构","数据简介",
                     "数据类型","空间范围","空间分辨率","时间范围","时间分辨率","数据格式",
                     "坐标参考","获取方式","下载地址","许可协议","是否免费","存储方式","项目用途","备注")
SELECT 29,1,'Google Earth Engine 遥感产品集','GEE Collections','Google Earth Engine',
       '经 GEE 云平台按站点缓冲提取的 MODIS/GPM/ERA5/GEDI/OpenLandMap 时序统计值',
       '时序统计表','金沙江流域 20 站 ±1 km','250 m–0.1°','2000-01 至今','月 / 年','JSON + PostgreSQL',
       'EPSG:4326','earthengine-api + 服务账号批处理','https://developers.google.com/earth-engine/datasets',
       '各产品原始许可','是','数值入库（遥感月值 / 年值 / 趋势）','植被趋势、树冠覆盖、蒸散与土壤输入','需绑定 Cloud 项目'
WHERE NOT EXISTS (SELECT 1 FROM "数据源" WHERE "数据源ID" = 29);
