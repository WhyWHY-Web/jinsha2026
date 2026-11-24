-- =====================================================================
-- 金沙江流域 土地利用 / 人类活动 / 空间自相关 建表脚本（PostgreSQL）
-- 用途：同学丙 任务三（数据库规范）
-- 执行：psql "$JINSHA_DSN" -f schema_v3.sql
-- 说明：均为幂等（IF NOT EXISTS）；updated_at 默认当前时间，可重复覆盖写。
-- =====================================================================

-- 1) 土地利用逐年面积占比（主：CLCD 30m，1990-2025；兜底：MCD12Q1 500m 2001-2023）
CREATE TABLE IF NOT EXISTS public.lulc (
    year       integer      NOT NULL,
    class      varchar(32)  NOT NULL,          -- 地类：耕地/森林/灌木/草地/水体/冰雪/裸地/建设用地/湿地
    class_code integer      NOT NULL,          -- CLCD 编码 1-9
    area_km2   numeric(12,3),
    pct        numeric(7,4),                   -- 占流域面积百分比（0-100）
    source     text,                           -- 数据产品全名 + 版本
    updated_at timestamp    NOT NULL DEFAULT now(),
    PRIMARY KEY (year, class)
);
COMMENT ON TABLE public.lulc IS '金沙江流域逐年土地利用面积占比（CLCD 30m 为主）';

-- 2) 夜间灯光强度（VIIRS 年度 2013-2025；DMSP-OLS 1992-2013 可选）
CREATE TABLE IF NOT EXISTS public.nightlight (
    year          integer       NOT NULL,
    mean_radiance numeric(14,6),               -- 流域年均灯光强度（nW/cm2/sr）
    source        text,
    updated_at    timestamp     NOT NULL DEFAULT now(),
    PRIMARY KEY (year)
);
COMMENT ON TABLE public.nightlight IS '金沙江流域逐年年均夜间灯光强度';

-- 3) 流域逐年总人口（GHS-POP 100m 5年档 1990-2030；WorldPop R2025A 100m 中国逐年 2015-2030）
CREATE TABLE IF NOT EXISTS public.population (
    year       integer      NOT NULL,
    total_pop  numeric(16,0),
    source     text         NOT NULL,
    updated_at timestamp    NOT NULL DEFAULT now(),
    PRIMARY KEY (year, source)   -- 两个产品同一年份并存（GHS-POP / WorldPop）
);
COMMENT ON TABLE public.population IS '金沙江流域逐年总人口';

-- 4) RSEI 空间自相关（全局 Moran I + 局部 LISA 四类计数）
CREATE TABLE IF NOT EXISTS public.moran_lisa (
    year         integer     NOT NULL,
    global_moran numeric(8,5),
    z_score      numeric(8,4),
    p_value      numeric(8,6),
    hh           integer,                     -- 高-高聚集单元数
    hl           integer,                     -- 高-低
    lh           integer,                     -- 低-高
    ll           integer,                     -- 低-低聚集单元数
    n_units      integer,                     -- 参与计算的空间单元数
    weight_type  varchar(16) DEFAULT 'queen', -- 权重矩阵类型（Queen 邻接）
    source       text,
    updated_at   timestamp   NOT NULL DEFAULT now(),
    PRIMARY KEY (year)
);
COMMENT ON TABLE public.moran_lisa IS '金沙江流域逐年 RSEI 空间自相关（Moran I + LISA，Queen 邻接）';

-- 常用索引
CREATE INDEX IF NOT EXISTS idx_lulc_year ON public.lulc (year);
CREATE INDEX IF NOT EXISTS idx_nightlight_year ON public.nightlight (year);
CREATE INDEX IF NOT EXISTS idx_population_year ON public.population (year);
