import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { archiveCatalog, readArchive } from "./archives.ts";
import { readFloodReplay, readFloodSeries } from "./flood.ts";
import { getEngineeringCatalog } from "./operations.ts";
import { sections as waterSections, snapshots as waterSnapshots } from "../data/water-quality/reports.ts";
import { EcologyInputError, ecologyOptions, ecologyRsei, ecologyRseiLayer, evaluateEcology } from "./ecology.ts";
import { createWorkflow, readJsonBody, WorkflowError } from "./workflow.ts";
import { runEcologyAgent } from "./agent.ts";
import { readScientificSummary } from "./scientific.ts";
import { fileURLToPath } from "node:url";
import { createLiveService } from "./live.ts";
import { forecastUsable } from "./forecast-model.ts";

const workbenchRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = process.env.JINSHA_WORKBENCH_SOURCE || fileURLToPath(new URL("../../系统/", import.meta.url));
const sourceData = join(sourceRoot, "data");
const frontDist = join(workbenchRoot, "dist");
const newData = join(workbenchRoot, "data");
const host = "127.0.0.1";
const port = Number(process.env.JINSHA_WORKBENCH_PORT || 8732);
const statePath = process.env.JINSHA_WORKBENCH_STATE || join(newData, "ecology-workflow.sqlite");
const workflow = createWorkflow(sourceData, statePath);
const live = createLiveService(newData,sourceData,process.env.JINSHA_WORKBENCH_RUNTIME || join(dirname(statePath),"live-data"));
const bounds = [97.6, 25.9, 105.4, 32.5];
const regionalBounds = [88,20,112,39];

type SourceStation = {
  id: string; name: string; en: string; lon: number; lat: number; type: string; zone: string;
  elev: number; slope: number; temp: number; precip: number; lc: Record<string, number>;
  coordSrc: string; elevSrc: string; climSrc: string; lcSrc: string;
};
type AnnualClimate = { station: string; year: number; temp_c: number; precip_mm: number; et_mm: number; source: string };
type AnnualRunoff = { station: string; year: number; discharge_mean: number; source: string };
type AnnualRow = { year: number; value: number };
type ClimateRow = { year: number; temp: number; precip: number; et: number; samples: number | null; scope: string };
type AnnualNDVI = Record<string, [string, number | null][]>;
type ArchiveScore = { 名称: string; 生态环境综合指数: number; 综合等级: string };
type RiverLine = { nm: string; lvl: number; p: [number, number][] };
type RiverReach = {
  type: "Feature";
  properties: { id: number; order: number; [key: string]: unknown };
  geometry: { type: "LineString" | "MultiLineString"; coordinates: unknown[] };
};
type RseiRow = { year: number; rsei_mean: number; sensor: string };
type ExpandedRiverArchive = {
  id: string; title: string; attribution: string; product_url: string; features: number; clip_bbox: number[];
  layers: Record<string, { features: number; bytes: number; selection?: string }>;
};
type DatasetInfo = {
  id: string; label: string; source: string; unit: string; rows: number; startYear?: number; endYear?: number; kind: string;
};

const jsonCache = new Map<string, { changedAt: number; size: number; payload: unknown }>();

async function getJson<T>(path: string): Promise<T> {
  const record = await stat(path);
  const cached = jsonCache.get(path);
  if (cached && cached.changedAt === record.mtimeMs && cached.size === record.size) {
    return cached.payload as T;
  }
  const payload = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")) as T;
  jsonCache.set(path, { changedAt: record.mtimeMs, size: record.size, payload });
  return payload;
}

async function loadResearchData() {
  const [registry, climate, ndvi, assessment, discharge, rsei] = await Promise.all([
    getJson<{ stations: SourceStation[] }>(join(sourceData, "stations.json")),
    getJson<AnnualClimate[]>(join(sourceData, "climate_annual.json")),
    getJson<{ ndvi: AnnualNDVI }>(join(sourceData, "gee", "annual.json")),
    getJson<ArchiveScore[]>(join(sourceData, "eco_services.json")),
    getJson<AnnualRunoff[]>(join(sourceData, "hydro_annual.json")),
    getJson<RseiRow[]>(join(sourceData, "rsei", "rsei_all.json")),
  ]);
  return { registry, climate, ndvi: ndvi.ndvi, assessment, discharge, rsei };
}

type ResearchData = Awaited<ReturnType<typeof loadResearchData>>;

function mapStations(data: ResearchData) {
  const assessment = new Map(data.assessment.map(row => [row.名称, row]));
  return data.registry.stations.map(row => {
    const score = assessment.get(row.name);
    return {
      id: row.id, name: row.name, en: row.en, lon: row.lon, lat: row.lat, type: row.type, zone: row.zone,
      elevation: row.elev, slope: row.slope, temp: row.temp, precip: row.precip, cover: row.lc,
      forestCover: row.lc["林地"] ?? null,
      assessment: score ? { eei: score.生态环境综合指数, grade: score.综合等级, kind: "历史评估快照" } : null,
      provenance: { location: row.coordSrc, elevation: row.elevSrc, landCover: row.lcSrc, climate: row.climSrc },
    };
  });
}

function meanAnnualNdvi(ndvi: AnnualNDVI) {
  const distribution = new Map<number, number[]>();
  Object.values(ndvi).forEach(station => {
    station.forEach(([label, value]) => {
      const year = Number(label);
      if (!Number.isInteger(year) || typeof value !== "number" || !Number.isFinite(value)) return;
      const group = distribution.get(year) || [];
      group.push(value);
      distribution.set(year, group);
    });
  });
  return [...distribution].sort(([left], [right]) => left - right).map(([year, values]) => ({
    year, value: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)), samples: values.length,
  }));
}

const map = {
  bounds,
  terrainUrl: "/assets/source/terrain/{z}/{x}/{y}.png",
  imageryUrl: "/assets/source/imagery/{z}/{x}/{y}.jpg",
  fallbackImageUrl: "/assets/source/satellite-3d-hd.jpg",
  lowResolutionImageUrl: "/assets/source/satellite-3d.jpg",
  riverUrl: "/api/layers/river-network",
  basinUrl: "/api/layers/basin",
  terrainEncoding: "terrarium",
  terrainZoom: 10,
  terrainMinZoom: 5,
  terrainMaxZoom: 10,
  imageryMinZoom: 9,
  imageryMaxZoom: 17,
  terrainSize: 256,
  terrainSource: "Terrarium 高程瓦片",
  imagerySource: "本地卫星影像档案",
  riverSource: "本地水系档案 · DEM D8 与站点约束",
  basinSource: "原始流域边界档案",
};

function dataCatalog(
  data: ResearchData, ndvi: ReturnType<typeof meanAnnualNdvi>, archive: ExpandedRiverArchive | null,
): DatasetInfo[] {
  const climateYears = data.climate.map(row => row.year);
  const hydroYears = data.discharge.map(row => row.year);
  const rseiYears = data.rsei.map(row => row.year);
  return [
    { id: "stations", label: "站点台账", rows: data.registry.stations.length, source: "原始水文站及梯级电站台账", kind: "台账", unit: "站" },
    { id: "climate", label: "站点与流域气候年值", rows: data.climate.length,
      startYear: Math.min(...climateYears), endYear: Math.max(...climateYears), source: "NASA POWER MERRA-2", kind: "再分析", unit: "条" },
    { id: "ndvi", label: "站点植被指数", rows: Object.values(data.ndvi).reduce((count, rows) => count + rows.length, 0),
      startYear: ndvi[0]?.year, endYear: ndvi.at(-1)?.year, source: "MODIS MOD13Q1 · 站点缓冲区", kind: "遥感反演", unit: "条" },
    { id: "hydrology", label: "径流年值", rows: data.discharge.length,
      startYear: Math.min(...hydroYears), endYear: Math.max(...hydroYears), source: "GloFAS v4", kind: "模型模拟", unit: "条" },
    { id: "rsei", label: "遥感生态指数", rows: data.rsei.length,
      startYear: Math.min(...rseiYears), endYear: Math.max(...rseiYears), source: "Landsat RSEI 归档", kind: "遥感反演", unit: "期" },
    ...(archive ? [{ id: archive.id, label: archive.title, rows: archive.features, source: archive.attribution,
      kind: "地形派生河网", unit: "条" }] : []),
  ];
}

function basinClimate(rows: AnnualClimate[]): ClimateRow[] {
  return rows.filter(row => row.station === "流域面平均").sort((left, right) => left.year - right.year).map(row => ({
    year: row.year, temp: row.temp_c, precip: row.precip_mm, et: row.et_mm, samples: null, scope: "流域面平均",
  }));
}

const metrics = {
  ndvi: { label: "植被指数", unit: "1", source: "MODIS MOD13Q1 · 站点缓冲区" },
  temperature: { label: "年均温", unit: "°C", source: "NASA POWER MERRA-2", field: "temp_c" },
  precipitation: { label: "年降水", unit: "mm", source: "NASA POWER MERRA-2", field: "precip_mm" },
  evapotranspiration: { label: "年蒸散", unit: "mm", source: "NASA POWER MERRA-2", field: "et_mm" },
  discharge: { label: "年均径流", unit: "m³/s", source: "GloFAS v4 模型模拟" },
  rsei: { label: "遥感生态指数", unit: "1", source: "Landsat RSEI 归档" },
} as const;
type Metric = keyof typeof metrics;

function seriesFor(data: ResearchData, metric: Metric, station: SourceStation | undefined): AnnualRow[] {
  if (metric === "ndvi") {
    if (!station) return meanAnnualNdvi(data.ndvi);
    return (data.ndvi[station.name] || []).flatMap(([year, value]) =>
      value === null ? [] : [{ year: Number(year), value }]);
  }
  if (metric === "rsei") return station ? [] : data.rsei.map(row => ({ year: row.year, value: row.rsei_mean }));
  if (metric === "discharge") {
    return station ? data.discharge.filter(row => row.station === station.name)
      .map(row => ({ year: row.year, value: row.discharge_mean })) : [];
  }
  const name = station?.name || "流域面平均";
  const field = metrics[metric].field;
  return data.climate.filter(row => row.station === name).map(row => ({ year: row.year, value: row[field] }));
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg", ".png": "image/png", ".bin": "application/octet-stream", ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2", ".json": "application/json; charset=utf-8", ".geojson": "application/geo+json; charset=utf-8",
};

function reply(
  request: IncomingMessage, response: ServerResponse, code: number, payload: unknown, contentType = "application/json; charset=utf-8",
) {
  const body = JSON.stringify(payload);
  response.writeHead(code, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

async function sendFile(request: IncomingMessage, response: ServerResponse, path: string, cacheSeconds = 0) {
  const entry = await stat(path).catch(() => null);
  if (!entry?.isFile()) return false;
  const modified = entry.mtime.toUTCString();
  response.setHeader("Last-Modified", modified);
  response.setHeader("Cache-Control", cacheSeconds ? "public, max-age=" + cacheSeconds : "no-cache");
  if (request.headers["if-modified-since"] === modified) {
    response.writeHead(304);
    response.end();
    return true;
  }
  response.writeHead(200, {
    "Content-Type": contentTypes[extname(path)] || "application/octet-stream",
    "Content-Length": entry.size,
  });
  if (request.method === "HEAD") response.end();
  else {
    const stream = createReadStream(path);
    stream.on("error", error => response.destroy(error));
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  }
  return true;
}

const sourceAssets: Record<string, string> = {
  "/assets/source/satellite-3d.jpg": join(newData, "source-assets", "satellite-3d.jpg"),
  "/assets/source/satellite-3d-hd.jpg": join(newData, "source-assets", "satellite-3d-hd.jpg"),
  "/assets/source/context-relief.webp": join(newData, "map-context", "relief.webp"),
  "/assets/source/context-imagery.webp": join(newData, "map-context", "imagery.webp"),
  "/assets/source/blue-marble.webp": join(newData,"public-map","blue-marble.webp"),
};

function sourceTile(path: string) {
  const tile = /^\/assets\/source\/(terrain|regional-dem|imagery)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.(png|jpg)$/.exec(path);
  if (!tile) return null;
  const [, category, zoom, x, y, format] = tile;
  const z = Number(zoom);
  if (z > 20 || Number(x) >= 2 ** z || Number(y) >= 2 ** z) return null;
  if (category === "regional-dem") {
    return z >= 5 && z <= 7 && format === "png" ? join(newData, category, zoom, x, y + ".png") : null;
  }
  if (category === "terrain" && (z < 5 || z > 10 || format !== "png")) return null;
  if (category === "imagery" && (z < 9 || z > 17 || format !== "jpg")) return null;
  const root = category === "terrain" && z < 10 ? join(newData, "terrain")
    : join(sourceData, category === "terrain" ? "tiles_dem" : "tiles");
  return join(root, zoom, x, y + "." + format);
}

async function layers(request: IncomingMessage, response: ServerResponse, url: URL) {
  const path = url.pathname;
  if (path === "/api/layers/basin") {
    if (!(await sendFile(request, response, join(sourceData, "basin", "jinsha_basin.geojson"), 300))) {
      reply(request, response, 404, { error: "原始流域边界暂不可用" });
    }
    return true;
  }
  if (path === "/api/layers/expanded-rivers") {
    const detail = url.searchParams.get("detail") || "all";
    if (detail !== "all" && detail !== "major") {
      reply(request, response, 400, { error: "河网范围须为 all 或 major" });
      return true;
    }
    const filename = detail === "major" ? "rivers-major.geojson" : "rivers.geojson";
    const delivered = await sendFile(request, response, join(newData, filename), 300);
    if (!delivered) reply(request, response, 404, { error: "扩展河网数据尚未导入" });
    return true;
  }
  if (path === "/api/layers/river-network") {
    const [{ rivers }, mainstem] = await Promise.all([
      getJson<{ rivers: RiverLine[] }>(join(sourceData, "hydro.json")),
      getJson<{ features: RiverReach[] }>(join(newData, "river-mainstem.geojson")).catch(() => null),
    ]);
    const mainReaches = (mainstem?.features ?? []).map(reach => ({
      ...reach,
      id: "hyriv-" + reach.properties.id,
      properties: { ...reach.properties, name: "金沙江", level: reach.properties.order, role: "main", source: "HydroRIVERS v1.0" },
    }));
    reply(request, response, 200, {
      type: "FeatureCollection",
      features: [...mainReaches, ...rivers.flatMap((river, index) => river.p.length < 2 || (mainReaches.length && index === 0) ? [] : [{
        type: "Feature", id: index + 1,
        properties: { id: index + 1, name: river.nm, level: river.lvl, role: index === 0 ? "main" : "tributary" },
        geometry: { type: "LineString", coordinates: river.p },
      }])],
    }, contentTypes[".geojson"]);
    return true;
  }
  return false;
}

function yearBound(value: string | null) {
  if (value === null) return null;
  if (!/^[0-9]{4}$/.test(value) || Number(value) < 1000) throw new RangeError("年份须为四位整数");
  return Number(value);
}

async function api(request: IncomingMessage, response: ServerResponse, url: URL) {
  const path = url.pathname;
  if (request.method === "POST") {
    const origin = request.headers.origin;
    const localOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    if (origin && !localOrigins.includes(origin) && !/^http:\/\/(?:127\.0\.0\.1|localhost):517[3-9]$/.test(origin)) {
      throw new WorkflowError("请从本机工作台提交请求", 403);
    }
    if (path === "/api/live/refresh") {
      void live.refresh(true).catch(error=>console.error(error.message));
      reply(request,response,202,{accepted:true,message:"后台检查资料，可在数据与方法查看进度"});return;
    }
    const revertPath = /^\/api\/ecology\/amendments\/(\d+)\/revert$/.exec(path);
    if (!revertPath && !["/api/ecology/amendments/preview", "/api/ecology/amendments", "/api/ecology/agent"].includes(path)) {
      response.setHeader("Allow", "GET, HEAD");
      reply(request, response, 405, {error:"此入口只提供查询"});
      return;
    }
    const body = await readJsonBody(request);
    if (path === "/api/ecology/amendments/preview") {
      reply(request, response, 200, await workflow.preview(body));
    } else if (path === "/api/ecology/amendments") {
      reply(request, response, 201, await workflow.commit(body));
    } else if (revertPath) {
      reply(request, response, 200, workflow.revert(Number(revertPath[1]),body));
    } else {
      reply(request, response, 200, await runEcologyAgent(body,{
        sourceData, newData, stations:(await workflow.sources()).stations, overrides:workflow.overrides,
      }));
    }
    return;
  }
  if (path === "/api/live/status") {reply(request,response,200,await live.status());return;}
  if (path === "/api/live/forecast") {
    const batch=url.searchParams.get("batch");
    if(batch && !/^[a-f0-9]{24}$/.test(batch))throw new WorkflowError("预报批次格式无效");
    const snapshot=await live.forecast(batch);
    reply(request,response,200,{snapshot,usable:snapshot ? forecastUsable(snapshot) : false,
      sourceStatus:(await live.status()).sources.find(source=>source.id==='forecast')});return;
  }
  if (path === "/api/live/observations") {reply(request,response,200,{snapshot:await live.observations()});return;}
  if (path === "/api/ecology/options") {
    reply(request, response, 200, await ecologyOptions(sourceData));
    return;
  }
  if (path === "/api/ecology/assess") {
    const overrideFor = (key: string) => {
      const year = url.searchParams.get(key);
      return year && /^\d{4}$/.test(year) ? workflow.overrides(Number(year)) : {};
    };
    reply(request,response,200,await evaluateEcology(sourceData,url.searchParams,overrideFor("year"),overrideFor("compareYear")));
    return;
  }
  if (path === "/api/ecology/rsei") {
    reply(request, response, 200, await ecologyRsei(sourceData,newData,url.searchParams.get("scope") ?? "basin"));
    return;
  }
  if (path === "/api/layers/rsei") {
    const year = url.searchParams.get("year") || "";
    if (!/^\d{4}$/.test(year)) throw new WorkflowError("请选择 RSEI 档案年份");
    reply(request,response,200,await ecologyRseiLayer(newData,Number(year),url.searchParams.get('mask') ?? 'common'));
    return;
  }
  if (path === "/api/scientific") {
    const profile = await readScientificSummary(newData,url.searchParams.get("basin"));
    reply(request,response,profile ? 200 : 404,profile ?? {error:"该范围没有可用的土壤档案"});
    return;
  }
  if (path === "/api/ecology/amendments") {
    reply(request, response, 200, workflow.list());
    return;
  }
  if (path === "/api/engineering") {
    reply(request, response, 200, await getEngineeringCatalog(newData));
    return;
  }
  if (path === "/api/water-quality") {
    reply(request, response, 200, {
      source:"四川省生态环境厅 · 国考断面水质统计表",
      sections:waterSections,
      snapshots:waterSnapshots,
      rows:waterSections.length * waterSnapshots.length,
      interpretation:"按报告期发布的断面类别",
    });
    return;
  }
  if (path === "/api/flood/replay") {
    reply(request, response, 200, await readFloodReplay(newData));
    return;
  }
  if (path === "/api/flood/series") {
    const stationId = url.searchParams.get("station") || "";
    const year = url.searchParams.get("year") || "";
    if (!stationId || !/^\d{4}$/.test(year)) {
      reply(request, response, 400, { error:"须指定站点和四位年份" });
      return;
    }
    const result = await readFloodSeries(newData, stationId, Number(year));
    reply(request, response, result ? 200 : 404, result ?? {error:"未找到洪水回放站点"});
    return;
  }
  const archivePart = /^\/api\/archives\/([a-zA-Z0-9_-]+)$/.exec(path);
  if (archivePart) {
    const rawYear = url.searchParams.get("year") || undefined;
    const limit = Number(url.searchParams.get("limit") ?? 24);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if ((rawYear && !/^[0-9]{4}$/.test(rawYear)) || !Number.isInteger(limit) || limit < 1 || limit > 100
      || !Number.isInteger(offset) || offset < 0 || offset > 1000000) {
      reply(request, response, 400, { error: "请检查年份或分页参数" });
      return;
    }
    const result = await readArchive(newData, archivePart[1], { year:rawYear, limit, offset,
      query:(url.searchParams.get("q") || "").trim().toLowerCase().slice(0,120) });
    reply(request, response, result ? 200 : 404, result ?? { error: "未找到数据集" });
    return;
  }
  if (path === "/api/climate/months") {
    const year = url.searchParams.get("year") || "";
    const id = url.searchParams.get("station") || "";
    if (!/^\d{4}$/.test(year)) {
      reply(request, response, 400, {error:"请输入四位年份"});
      return;
    }
    const data = await loadResearchData();
    const station = data.registry.stations.find(row => row.id === id);
    if (id && !station) {
      reply(request, response, 404, {error:"未找到站点"});
      return;
    }
    const name = station?.name || "流域面平均";
    const monthly = await getJson<Array<{station:string;year:number;month:number;precip_mm:number}>>(join(sourceData, "climate_monthly.json"));
    const rows = monthly.filter(row => row.station === name && row.year === Number(year))
      .sort((a,b)=>a.month-b.month).map(row => ({month:row.month,value:row.precip_mm}));
    reply(request,response,200,{rows,scope:name,source:"NASA POWER · MERRA-2",unit:"mm"});
    return;
  }
  if (path === "/api/layers/ndvi") {
    let year: number;
    try {
      const rawYear = yearBound(url.searchParams.get("year"));
      if (rawYear === null) throw new RangeError("请选择 NDVI 年份");
      year = rawYear;
    } catch (error) {
      reply(request, response, 400, { error: error instanceof Error ? error.message : "无效的 NDVI 年份" });
      return;
    }
    const data = await loadResearchData();
    const values = Object.fromEntries(data.registry.stations.flatMap(station => {
      const observation = data.ndvi[station.name]?.find(([label]) => Number(label) === year);
      const value = observation?.[1];
      return typeof value === "number" && Number.isFinite(value) ? [[station.id, value] as const] : [];
    }));
    reply(request, response, 200, { year, values, source: metrics.ndvi.source });
    return;
  }
  if (path === "/api/health") {
    const available = Boolean(await stat(join(sourceData, "stations.json")).catch(() => null));
    reply(request, response, available ? 200 : 503, { ok: available, service: "jinsha-workbench", engine: "Node.js", mode: "local" });
    return;
  }
  if (await layers(request, response, url)) return;
  if (!["/api/dashboard", "/api/stations", "/api/catalog", "/api/series"].includes(path)) {
    reply(request, response, 404, { error: "该接口不存在" });
    return;
  }

  const data = await loadResearchData();
  if (path === "/api/stations") {
    const query = (url.searchParams.get("q") || "").trim().toLowerCase();
    const stations = mapStations(data).filter(station => !query || [station.name, station.en, station.id, station.zone]
      .some(value => value.toLowerCase().includes(query)));
    reply(request, response, 200, { stations, count: stations.length });
    return;
  }
  if (path === "/api/series") {
    const metricName = (url.searchParams.get("metric") || "ndvi").trim().toLowerCase();
    if (!Object.hasOwn(metrics, metricName)) {
      reply(request, response, 400, { error: "指标不受支持", metrics: Object.keys(metrics) });
      return;
    }
    const metric = metricName as Metric;
    const stationId = (url.searchParams.get("station") || "").trim().toLowerCase();
    const station = data.registry.stations.find(row => row.id.toLowerCase() === stationId);
    if (stationId && !station) {
      reply(request, response, 404, { error: "未找到该站点" });
      return;
    }
    let from: number | null;
    let to: number | null;
    try {
      from = yearBound(url.searchParams.get("from"));
      to = yearBound(url.searchParams.get("to"));
      if (from !== null && to !== null && from > to) throw new RangeError("起始年份晚于结束年份");
    } catch (error) {
      reply(request, response, 400, { error: error instanceof Error ? error.message : "无效的年份范围" });
      return;
    }
    const rseiSupport=metric==='rsei' && !station ? (await ecologyRsei(sourceData,newData)).research?.region : null;
    const baseValues = rseiSupport ? rseiSupport.records.map(row=>({year:row.year,value:row.allYearsCommon.value})) : seriesFor(data, metric, station);
    const amended = station && (metric === "temperature" || metric === "precipitation")
      ? workflow.stationSeries(station.id,metric) : undefined;
    const sourceValues = amended?.size ? new Map(baseValues.map(row=>[row.year,row.value])) : null;
    if (sourceValues && amended) for (const [year,value] of amended) sourceValues.set(year,value);
    const values = (sourceValues ? [...sourceValues].map(([year,value])=>({year,value})) : baseValues)
      .filter(row => (from === null || row.year >= from) && (to === null || row.year <= to))
      .sort((left, right) => left.year - right.year);
    const { label, unit, source } = metrics[metric];
    reply(request, response, 200, {
      metric, label, unit, source:values.some(row=>amended?.has(row.year)) ? source+" · 工作台修正档案" : source, station: station?.id ?? null,
      scope: station?.name ?? (metric === "ndvi" ? "有观测站点均值" : metric === "discharge" ? "站点径流档案" : metric==='rsei' ? "统一边界八期共同有效覆盖" : "流域面平均"),
      ...(rseiSupport ? {maskMode:'all-years-common',areaKm2:rseiSupport.areaKm2,coverageKm2:rseiSupport.records[0]?.allYearsCommon.coverageKm2} : {}),
      values,
    });
    return;
  }

  const ndvi = meanAnnualNdvi(data.ndvi);
  const archive = await getJson<ExpandedRiverArchive>(join(newData, "rivers.source.json")).catch(() => null);
  const floodArchive = await readFloodReplay(newData).catch(() => null);
  const catalog = [...dataCatalog(data, ndvi, archive), ...await archiveCatalog(newData)];
  catalog.push({ id:"water-quality", label:"国考断面水质类别", rows:waterSections.length * waterSnapshots.length,
    unit:"条", startYear:2022, endYear:2024, source:"四川省生态环境厅", kind:"公开监测报告" });
  if (floodArchive) {
    catalog.push({ id:"daily-discharge", label:"历史日流量", rows:floodArchive.rows, unit:"条",
      startYear:Number(floodArchive.start.slice(0,4)), endYear:Number(floodArchive.end.slice(0,4)),
      source:floodArchive.source, kind:"模型再分析" });
  }
  if (path === "/api/catalog") {
    reply(request, response, 200, { datasets: catalog });
    return;
  }
  const contextPaths = ["/assets/source/context-relief.webp", "/assets/source/context-imagery.webp"];
  const [reliefContext,featheredImagery,hiDetail,regionalDem,publicPreview] = await Promise.all([
    ...contextPaths.map(path=>stat(sourceAssets[path]).catch(()=>null)),
    stat(join(sourceData,"tiles_dem","10")).catch(()=>null),
    stat(join(newData,"regional-dem","complete")).catch(()=>null),
    stat(sourceAssets["/assets/source/blue-marble.webp"]).catch(()=>null),
  ]);
  const baseView = {
    ...map,
    onlineImagery:{url:"https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg",
      minZoom:0,maxZoom:14,year:"2024 年合成（非实时）",resolution:"10 m 源采样；瓦片显示不代表定位精度",
      attribution:"Sentinel-2 cloudless © EOX · contains modified Copernicus Sentinel data 2024",licenseUrl:"https://maps.eox.at/"},
    imageryManifest:{verified:false,note:"原本地 XYZ 影像未核验覆盖与再分发许可，保持停用。可选 EOX 在线逐级影像；离线使用区域预览。"},
    terrainMaxZoom:hiDetail?.isDirectory() ? 10 : 9,
    ...(reliefContext?.size ? { context:{url:contextPaths[0],bounds:regionalBounds} } : {}),
    ...(featheredImagery?.size ? { fallbackImageUrl:contextPaths[1] } : {}),
    ...(publicPreview?.size ? {fallbackImageUrl:"/assets/source/blue-marble.webp",imagerySource:"NASA Blue Marble · GIBS"} : {}),
    ...(regionalDem?.isFile() ? { regionalTerrain:{ url:"/assets/source/regional-dem/{z}/{x}/{y}.png", bounds:regionalBounds } } : {}),
  };
  const hasMainstem = archive?.layers["river-mainstem.geojson"] && (await stat(join(newData, "river-mainstem.geojson")).catch(()=>null))?.isFile();
  const mapView = archive && hasMainstem ? {
    ...baseView, riverSource:"干流 HydroRIVERS v1.0 · HydroSHEDS © WWF", mainstemProductUrl:archive.product_url,
  } : baseView;
  reply(request, response, 200, {
    stations: mapStations(data), climate: basinClimate(data.climate), ndvi, catalog,
    runoffStations: data.registry.stations.filter(station => data.discharge.some(row => row.station === station.name)).map(station => station.id),
    map: archive ? {
      ...mapView,
      expandedRiverUrl: "/api/layers/expanded-rivers?detail=major",
      expandedRiverSource: archive.attribution,
      expandedRiverBounds: archive.clip_bbox,
      expandedRiverCount: archive.features,
      expandedMajorCount: archive.layers["rivers-major.geojson"]?.features ?? null,
      expandedRiverProductUrl: archive.product_url,
    } : mapView,
  });
}

createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  const requestHost = request.headers.host;
  if (requestHost && ![`${host}:${port}`, `localhost:${port}`, host, "localhost"].includes(requestHost)) {
    reply(request,response,403,{error:"仅接受本机工作台访问"});
    return;
  }
  const origin = request.headers.origin;
  if (origin && (/^http:\/\/(?:localhost|127\.0\.0\.1):517[3-9]$/.test(origin)
    || origin === process.env.JINSHA_WORKBENCH_ORIGIN)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "POST") {
    response.setHeader("Allow", "GET, HEAD, POST");
    reply(request, response, 405, { error: "不支持该请求方法" });
    return;
  }
  try {
    const requestTarget = request.url || "/";
    const rawPath = requestTarget.split("?", 1)[0];
    if (rawPath.includes("\\") || /(?:^|\/)(?:\.|%2e){1,2}(?=\/|$)/i.test(rawPath)) {
      reply(request, response, 400, { error: "无效的请求路径" });
      return;
    }
    const url = new URL(requestTarget, "http://" + host);
    const path = url.pathname;
    if (path.startsWith("/api/")) {
      await api(request, response, url);
      return;
    }
    if (request.method === "POST") {
      response.setHeader("Allow", "GET, HEAD");
      reply(request, response, 405, {error:"此入口只提供查询"});
      return;
    }
    if (path.startsWith("/assets/source/")) {
      const file = sourceAssets[path] || sourceTile(path);
      if (!file || !(await sendFile(request, response, file, 3600))) {
        reply(request, response, 404, { error: "未找到该图层资源" });
      }
      return;
    }
    if (path === "/" && await sendFile(request, response, join(frontDist, "index.html"))) return;
    if (/^\/assets\/[a-zA-Z0-9_.-]+$/.test(path) && await sendFile(request, response, resolve(frontDist, "." + path), 3600)) return;
    if (path === "/") {
      reply(request, response, 200, { service: "金沙江生态工作台", api: "/api/dashboard" });
      return;
    }
    reply(request, response, 404, { error: "未找到该资源" });
  } catch (error) {
    if (response.headersSent) response.destroy(error instanceof Error ? error : undefined);
    else if (error instanceof EcologyInputError || error instanceof WorkflowError) {
      reply(request, response, error.status, {error:error.message});
    }
    else {
      console.error(error instanceof Error ? error.message : String(error));
      reply(request, response, 503, { error: "本地来源数据暂不可用" });
    }
  }
}).listen(port, host, () => {
  console.log("金沙江工作台数据服务 http://" + host + ":" + port);
});
