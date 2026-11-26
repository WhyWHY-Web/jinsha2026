"""Offline GCPI/RSEI/LTCCD calculations for the basin analysis workspace."""
from collections import Counter, defaultdict
import csv
from functools import cached_property
from heapq import nsmallest
from itertools import combinations
import json
import math
from pathlib import Path
from statistics import mean, median

INDICATORS = ("slope", "hsi", "pd", "pcd")
LISA_CLASSES = ("NS", "HH", "HL", "LH", "LL")
RSEI_GRADES = ("差", "较差", "中等", "良好", "优")
GCPI_GRADES = ("很低", "较低", "中等", "较高", "很高")
LTCCD_GRADES = ("极度失调", "严重失调", "中度失调", "轻度失调", "濒临失调",
                 "勉强协调", "初级协调", "中级协调", "良好协调", "优质协调")


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def read_json(path, fallback):
    try:
        with path.open(encoding="utf-8-sig") as stream:
            return json.load(stream)
    except (OSError, ValueError):
        return fallback


def scale(values, reverse=False):
    low, high = min(values), max(values)
    if high == low:
        return [0.5] * len(values)
    return [(high - x if reverse else x - low) / (high - low) for x in values]


def principal_axis(rows):
    """Dominant axis of a small symmetric covariance matrix."""
    cols = list(zip(*rows))
    centers = [mean(col) for col in cols]
    matrix = [[sum((a - centers[i]) * (b - centers[j]) for a, b in zip(col, peer))
               for j, peer in enumerate(cols)] for i, col in enumerate(cols)]
    dimensions = len(cols)
    candidates = []
    for start in range(dimensions):
        vector = [float(i == start) for i in range(dimensions)]
        for _ in range(128):
            prod = [sum(a * b for a, b in zip(row, vector)) for row in matrix]
            length = math.hypot(*prod)
            if not length:
                break
            successor = [x / length for x in prod]
            if max(abs(a - b) for a, b in zip(vector, successor)) < 1e-12:
                vector = successor
                break
            vector = successor
        magnitude = sum(vector[i] * sum(a * b for a, b in zip(row, vector))
                        for i, row in enumerate(matrix))
        candidates.append((magnitude, vector))
    value, axis = max(candidates, key=lambda pair: pair[0])
    return axis if value > 1e-18 else [1 / math.sqrt(dimensions)] * dimensions


def normalized_difference(a, b):
    return (a - b) / (a + b) if a + b else 0


def modis_components(bands, thermal_dn, soil_index, built_index):
    """Appendix B2 components from MOD09A1 band order and MOD11A2 thermal DN."""
    b1, b2, b3, b4, b5, b6, b7 = bands
    return {
        "ndvi": normalized_difference(b2, b1),
        "wet": sum(a * b for a, b in zip(bands, (0.1147, 0.2489, 0.2408, 0.3132,
                                                -0.3122, -0.6416, -0.5807))),
        "ndbsi": (soil_index + built_index) / 2,
        "lst": 0.02 * thermal_dn - 273.15,
        "mndwi": normalized_difference(b4, b6),
    }


def rsei_from_components(rows):
    if not rows:
        return []
    columns = [scale([r[key] for r in rows]) for key in ("ndvi", "wet", "ndbsi", "lst")]
    normalized = list(zip(*columns))
    axis = principal_axis(normalized)
    # Resolve the arbitrary PCA sign toward dryness/heat before applying 1 − PC1.
    if sum(a * b for a, b in zip(axis, (-1, -1, 1, 1))) < 0:
        axis = [-value for value in axis]
    return [1 - pc1 for pc1 in scale([sum(a * b for a, b in zip(row, axis)) for row in normalized])]


def haversine(a, b):
    x1, y1, x2, y2 = map(math.radians, (*a, *b))
    term = math.sin((y2 - y1) / 2) ** 2 + math.cos(y1) * math.cos(y2) * math.sin((x2 - x1) / 2) ** 2
    return 6371.0088 * 2 * math.asin(math.sqrt(min(1, term)))


def idw(distances):
    # Coincident stations share their weight rather than dividing by zero.
    zeros = sum(x == 0 for x in distances)
    if zeros:
        return [float(x == 0) / zeros for x in distances]
    raw = [x ** -2 for x in distances]
    total = sum(raw)
    return [x / total for x in raw] if total else raw


def coupling(poverty, ecological):
    total = poverty + ecological
    return 2 * math.sqrt(poverty * ecological) / total if total else 0


def ltccd(rows):
    """IDW-normalized outbound and inbound means for each focal station."""
    poverty = scale([row["gcpi"] for row in rows], reverse=True)
    ecological = [row["rsei"] for row in rows]
    coordinates = [(row["lon"], row["lat"]) for row in rows]
    weights = [idw([haversine(coordinates[i], point) if i != k else math.inf
                    for k, point in enumerate(coordinates)])
               for i in range(len(rows))]
    for i, row in enumerate(rows):
        c = coupling(poverty[i], ecological[i])
        t = (poverty[i] + ecological[i]) / 2
        if len(rows) > 1:
            outbound = weights[i]
            inbound = [row_weights[i] for row_weights in weights]
            incoming_total = sum(inbound)
            inbound = [w / incoming_total for w in inbound] if incoming_total else outbound
            remote_c = sum(out * coupling(poverty[i], ecological[k]) +
                           inc * coupling(poverty[k], ecological[i])
                           for k, (out, inc) in enumerate(zip(outbound, inbound))) / 2
            remote_t = sum(out * (poverty[i] + ecological[k]) +
                           inc * (poverty[k] + ecological[i])
                           for k, (out, inc) in enumerate(zip(outbound, inbound))) / 4
        else:
            remote_c, remote_t = c, t
        cs, ts = (c + remote_c) / 2, (t + remote_t) / 2
        row.update(normalized_gcpi=poverty[i], coupling=c, remote_coupling=remote_c,
                   connection=t, remote_connection=remote_t, cs=cs, ts=ts,
                   ltccd=math.sqrt(cs * ts))
    return weights


def moran_i(values, weights):
    avg = mean(values)
    centered = [value - avg for value in values]
    den = sum(value ** 2 for value in centered)
    total = sum(map(sum, weights))
    if not den or not total:
        return None
    return len(values) / total * sum(weights[i][j] * a * b for i, a in enumerate(centered)
                                    for j, b in enumerate(centered)) / den


def theil(values):
    avg = mean(values)
    if not avg:
        return 0
    return sum(value / avg * math.log(value / avg) for value in values if value > 0) / len(values)


def trend(year_values):
    n = len(year_values)
    if n < 3:
        return {"n": n, "sen": None, "tau": None, "p": None}
    slopes = []
    statistic = 0
    for (time_a, a), (time_b, b) in combinations(year_values, 2):
        diff = b - a
        slopes.append(diff / (time_b - time_a))
        statistic += (diff > 0) - (diff < 0)
    groups = Counter(value for _, value in year_values)
    variance = (n * (n - 1) * (2 * n + 5) -
                sum(t * (t - 1) * (2 * t + 5) for t in groups.values())) / 18
    correction = (statistic > 0) - (statistic < 0)
    z = (statistic - correction) / math.sqrt(variance) if variance else 0
    n_pairs = n * (n - 1) / 2
    value_ties = sum(t * (t - 1) / 2 for t in groups.values())
    tau_den = math.sqrt(n_pairs * (n_pairs - value_ties))
    return {"n": n, "sen": round(median(slopes), 7),
            "tau": round(statistic / tau_den, 6) if tau_den else None,
            "p": round(math.erfc(abs(z) / math.sqrt(2)), 6)}


def grade(value, labels):
    return labels[min(len(labels) - 1, max(0, int(value * len(labels))))]


def compact_ring(ring):
    if not ring:
        return ring
    step = max(1, len(ring) // 260)
    coordinates = [[round(x, 4), round(y, 4)] for x, y in ring[::step]]
    if coordinates[0] != coordinates[-1]:
        coordinates.append(coordinates[0])
    return coordinates


class CouplingAnalysis:
    """Existing RSEI products and separately labeled station-level pilot estimates."""

    def __init__(self, data_dir, stations_provider=None, effective=None):
        self.data = Path(data_dir)
        self.stations_provider = stations_provider
        self.effective = effective

    @cached_property
    def annual(self):
        stats = {int(row["year"]): row for row in read_json(self.data / "rsei/moran_lisa.json", [])}
        rows = {}
        for raw in read_json(self.data / "rsei/rsei_all.json", []):
            year = int(raw["year"])
            value = number(raw.get("rsei_mean"))
            if value is None:
                continue
            row = {"year": year, "rsei": value, "rsei_grade": grade(value, RSEI_GRADES),
                   "sensor": raw.get("sensor"), "samples": raw.get("n_scenes"),
                   "area_km2": raw.get("total_area_km2"), "pc1_loadings": raw.get("pc1_loadings"),
                   "class_pct": [raw.get(f"class_{i}_pct") for i in range(5)]}
            row["moran_rsei"] = number(stats.get(year, {}).get("global_moran"))
            row["moran_rsei_p"] = number(stats.get(year, {}).get("p_value"))
            rows[year] = row
        return dict(sorted(rows.items()))

    @cached_property
    def spatial_points(self):
        samples = {}
        for year in self.annual:
            path = self.data / "rsei" / f"lisa_{year}.csv"
            if not path.is_file():
                continue
            with path.open(encoding="utf-8-sig", newline="") as stream:
                rows = []
                for row in csv.DictReader(stream):
                    lon, lat, score = (number(row.get(key)) for key in ("lon", "lat", "rsei"))
                    if None not in (lon, lat, score) and 0 <= score <= 1:
                        label = row.get("lisa", "").upper()
                        rows.append([lon, lat, score, label if label in LISA_CLASSES else "NS"])
            samples[year] = rows
        return samples

    @cached_property
    def boundary(self):
        data = read_json(self.data / "basin/jinsha_basin.geojson", {})
        features = []
        for idx, source in enumerate(data.get("features", [])):
            geometry = source.get("geometry", {})
            polygons = geometry.get("coordinates", [])
            if geometry.get("type") == "Polygon":
                coordinates = [compact_ring(ring) for ring in polygons]
            elif geometry.get("type") == "MultiPolygon":
                coordinates = [[compact_ring(ring) for ring in part] for part in polygons]
            else:
                continue
            features.append({"type": "Feature", "properties": {"name": str(idx + 1)},
                             "geometry": {"type": geometry["type"], "coordinates": coordinates}})
        return {"type": "FeatureCollection", "features": features}

    @cached_property
    def auxiliary(self):
        pop_rows = read_json(self.data / "population/population.json", [])
        population = {int(row["year"]): number(row.get("total_pop")) for row in pop_rows
                      if row.get("source", "").startswith("GHS-POP")}
        lights = {int(row["year"]): number(row.get("mean_radiance"))
                  for row in read_json(self.data / "nightlight/nightlight.json", [])}
        series = read_json(self.data / "gee/series.json", {}).get("ndvi", {})
        ndvi = defaultdict(list)
        for station, observations in series.items():
            for period, raw, *_ in observations:
                value = number(raw)
                if value is not None and -1 <= value <= 1:
                    ndvi[(station, int(str(period)[:4]))].append(value)
        return population, lights, ndvi

    @staticmethod
    def site_rsei(coordinates, points):
        lon, lat = coordinates
        radius = 55 / 110
        lon_radius = radius / max(.01, math.cos(math.radians(abs(lat) + radius)))
        nearest = nsmallest(4, ((haversine(coordinates, (p[0], p[1])), p[2]) for p in points
                                if abs(p[0] - lon) <= lon_radius and abs(p[1] - lat) <= radius))
        nearby = [sample for sample in nearest if sample[0] <= 55]
        if not nearby:
            return None
        return sum(w * value for w, (_, value) in zip(idw([d for d, _ in nearby]), nearby))

    def station_field(self, station, key):
        if self.effective:
            return number(self.effective(station, key))
        if key.startswith("lc."):
            return number(station.get("lc", {}).get(key[3:], 0))
        return number(station.get(key))

    def _source_stations(self):
        payload = self.stations_provider() if self.stations_provider else read_json(self.data / "stations.json", {})
        if isinstance(payload, dict):
            payload = payload.get("stations", [])
        stations = []
        for station in payload:
            lon, lat = number(station.get("lon")), number(station.get("lat"))
            slope, cover = self.station_field(station, "slope"), self.station_field(station, "lc.建成区")
            if None not in (lon, lat, slope) and station.get("name"):
                stations.append((station["name"], (lon, lat), slope, max(0, cover or 0)))
        return stations

    def _observations(self, stations):
        population, lights, ndvi = self.auxiliary
        if not stations:
            return []
        centers = [item[1] for item in sorted(stations, key=lambda item: item[3], reverse=True)[:4] if item[3] > 0]
        if not centers:
            return []
        avg_weight = mean(.01 + station[3] for station in stations)
        res = []
        for year, inputs in self.annual.items():
            area = number(inputs.get("area_km2"))
            if not population.get(year) or not lights.get(year) or not area:
                continue
            for name, (lon, lat), slope, built in stations:
                vegetation = ndvi[(name, year)]
                if len(vegetation) < 6:
                    continue
                ecological = self.site_rsei((lon, lat), self.spatial_points.get(year, []))
                if ecological is None:
                    continue
                share = (.01 + built) / avg_weight
                distance = min(haversine((lon, lat), center) for center in centers)
                res.append({"name": name, "year": year, "lon": lon, "lat": lat,
                            "slope": slope, "built_cover": built, "rsei": ecological,
                            "ndvi_min": min(vegetation), "ndvi_max": max(vegetation), "ndvi_months": len(vegetation),
                            "viirs_proxy": lights[year] * share, "pd": population[year] / area * share,
                            "pcd": 1 / (1 + distance / 50)})
        for row, npp in zip(res, scale([row["viirs_proxy"] for row in res]) if res else []):
            hi, lo = row["ndvi_max"], row["ndvi_min"]
            denom = 1 - npp + hi + npp * lo
            row["hsi"] = 1 - hi + npp / denom if denom > 0 else 1 - hi
        return res

    def report(self, year=None):
        years = list(self.annual)
        if year is not None and year not in self.annual:
            raise ValueError("年份不在现有 RSEI 序列中")
        year = (years[-1] if years else None) if year is None else year
        source_stations = self._source_stations()
        observations = self._observations(source_stations)
        for_year = defaultdict(list)
        pca_weights = {}
        if observations:
            cols = [scale([row[key] for row in observations], reverse=key == "slope") for key in INDICATORS]
            components = list(zip(*cols))
            axis = [abs(x) for x in principal_axis(components)]
            pca_weights = {key: weight / sum(axis) for key, weight in zip(INDICATORS, axis)}
            for row, values in zip(observations, components):
                row["gcpi"] = 1 - sum(a * b for a, b in zip(pca_weights.values(), values))
                row["gcpi_grade"] = grade(row["gcpi"], GCPI_GRADES)
                row["rsei_grade"] = grade(row["rsei"], RSEI_GRADES)
                for_year[row["year"]].append(row)
        by_year = []
        for n in years:
            summary = self.annual[n].copy()
            stations = for_year.get(n, [])
            summary.update(gcpi=None, ltccd=None, n_stations=len(stations), moran_ltccd=None, theil=None)
            if stations:
                weights = ltccd(stations)
                lvalues = [row["ltccd"] for row in stations]
                for row in stations:
                    row["ltccd_grade"] = grade(row["ltccd"], LTCCD_GRADES)
                summary.update(gcpi=mean(row["gcpi"] for row in stations), ltccd=mean(lvalues),
                               moran_ltccd=moran_i(lvalues, weights), theil=theil(lvalues))
            by_year.append(summary)
        selected = for_year.get(year, [])
        return {
            "ok": True, "year": year, "years": years, "coupling_years": sorted(for_year),
            "series": by_year, "stations": selected, "lisa": self.spatial_points.get(year, []),
            "boundary": self.boundary, "pca_weights": pca_weights,
            "statistics": {field: trend([(r["year"], r[field]) for r in by_year if r[field] is not None])
                           for field in ("rsei", "gcpi", "ltccd")},
            "coverage": {"station_candidates": len(source_stations), "demo_stations": len(selected),
                         "rsei_grid_samples": len(self.spatial_points.get(year, []))},
            "sources": {
                "rsei": "既有 Landsat 归档。RSEI 采用绿度、湿度、干度、热度 PCA 合成。各期有效像元覆盖面积有差异。",
                "lisa": "归档 RSEI 采样和 Queen 邻接 Moran’s I / 局部 LISA。站点 RSEI 取 55 km 内最多四个采样点作反距离估计。",
                "gcpi": "站点演示，使用台账坡度和 MOD13Q1 月 NDVI 极值。灯光及人口从 NPP-VIIRS 和 GHS-POP 流域汇总值，按现状建成区比例分配至站点。人口密度以有效 RSEI 面积为代理。可达性用距四个建成区占比最高站点的距离衰减估计。",
                "ltccd": "本地和双向邻域均值各占一半。反距离平方权重按起点行归一化，入向列再归一化为加权均值，同期 GCPI 反向标准化。样本规模及代理变量限制了实际贫困识别。",
                "trend": "Sen 斜率以年为步长。Mann–Kendall 报告双侧近似 p 值，3 期耦合趋势仅用于描述。Theil T 和 IDW Moran’s I 按同期纳入的站点计算。"
            }
        }
