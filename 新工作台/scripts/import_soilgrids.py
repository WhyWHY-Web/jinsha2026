"""Download and clip the SoilGrids v2.0 topsoil estimates used by the workbench."""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import math
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
import requests
import shapely
from rasterio.io import MemoryFile
from requests.adapters import HTTPAdapter
from shapely.geometry import shape
from urllib3.util.retry import Retry


WORKBENCH = Path(__file__).resolve().parents[1]
BOUNDARY = WORKBENCH.parent / "系统" / "data" / "basin" / "jinsha_basin.geojson"
DATA = WORKBENCH / "data" / "scientific"
WCS = "https://maps.isric.org/mapserv"
WGS84 = "http://www.opengis.net/def/crs/EPSG/0/4326"
SCALE = 0.14
DEPTHS = ("0-5cm", "5-15cm", "15-30cm")
PROPERTIES = {
    "phh2o": {"field": "ph_h2o", "label": "土壤 pH（水）", "unit": "pH", "divisor": 10, "decimals": 1},
    "soc": {"field": "organic_carbon_g_kg", "label": "土壤有机碳含量", "unit": "g/kg", "divisor": 10, "decimals": 1},
    "clay": {"field": "clay_pct", "label": "黏粒含量", "unit": "%", "divisor": 10, "decimals": 1},
    "bdod": {"field": "bulk_density_g_cm3", "label": "细土容重", "unit": "g/cm³", "divisor": 100, "decimals": 2},
}
SOURCE_URL = "https://docs.isric.org/globaldata/soilgrids/"
LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/"


def digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def fetch_layer(task, bounds, cache: Path):
    prop, depth = task
    west, south, east, north = bounds
    coverage = f"{prop}_{depth}_mean"
    params = [
        ("MAP", f"/map/{prop}.map"), ("SERVICE", "WCS"), ("VERSION", "2.0.1"),
        ("REQUEST", "GetCoverage"), ("COVERAGEID", coverage), ("FORMAT", "image/tiff"),
        ("SUBSETTINGCRS", WGS84), ("OUTPUTCRS", WGS84),
        ("SUBSET", f"Lat({south:g},{north:g})"), ("SUBSET", f"Long({west:g},{east:g})"),
        ("SCALEFACTOR", str(SCALE)), ("INTERPOLATION", "NEAREST"),
    ]
    url = requests.Request("GET", WCS, params=params).prepare().url
    cache_file = cache / f"{coverage}-{digest(url.encode())[:12]}.tif"
    if cache_file.is_file():
        content = cache_file.read_bytes()
    else:
        with requests.Session() as session:
            session.mount("https://", HTTPAdapter(max_retries=Retry(2, backoff_factor=1, status_forcelist=(429, 500, 502, 503, 504))))
            response = session.get(url, timeout=(12, 60))
            response.raise_for_status()
            content = response.content
    try:
        with MemoryFile(content) as memory, memory.open() as source:
            if source.crs.to_epsg() != 4326 or source.count != 1:
                raise ValueError("Expected a single band in EPSG:4326")
            source_values = source.read(1, masked=True).astype(np.float32).filled(np.nan)
            raster = source.transform, source_values
    except rasterio.errors.RasterioError as error:
        raise ValueError(f"{coverage} did not return a raster: {content[:600]!r}") from error
    if not cache_file.exists():
        temporary = cache_file.with_suffix(".tmp")
        temporary.write_bytes(content)
        temporary.replace(cache_file)
    print(f"{coverage}: {source_values.shape}, {len(content):,} bytes", flush=True)
    return (prop, depth), raster, {"coverage": coverage, "url": url, "sha256": digest(content)}


def describe(values: np.ndarray):
    if not values.size:
        return None
    quantiles = np.quantile(values, (0.1, 0.5, 0.9))
    return {"mean": round(float(values.mean()), 3), "min": round(float(values.min()), 3),
            "max": round(float(values.max()), 3), "p10": round(float(quantiles[0]), 3),
            "median": round(float(quantiles[1]), 3), "p90": round(float(quantiles[2]), 3)}


def write_json(path: Path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def execute(boundary_path: Path, cache: Path):
    cache.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    source_boundary = boundary_path.read_bytes()
    boundary = json.loads(source_boundary.decode("utf-8-sig"))
    basins = [(str(feature["properties"]["HYBAS_ID"]), shapely.make_valid(shape(feature["geometry"])))
              for feature in boundary["features"]]
    west, south, east, north = shapely.union_all([geometry for _, geometry in basins]).bounds
    bounds = math.floor(west * 10) / 10, math.floor(south * 10) / 10, math.ceil(east * 10) / 10, math.ceil(north * 10) / 10
    tasks = [(prop, depth) for depth in DEPTHS for prop in PROPERTIES]
    with ThreadPoolExecutor(max_workers=4) as workers:
        results = list(workers.map(lambda task: fetch_layer(task, bounds, cache), tasks))
    data = {task: raster for task, raster, _source in results}
    transform, first = data[tasks[0]]
    if any(other != transform or values.shape != first.shape for other, values in data.values()):
        raise ValueError("SoilGrids WCS returned mismatched grids; no census was created")
    if transform.b != 0 or transform.d != 0:
        raise ValueError("Expected a north-up geographic grid")
    lon, lat = np.meshgrid(transform.c + (np.arange(first.shape[1]) + .5) * transform.a,
                           transform.f + (np.arange(first.shape[0]) + .5) * transform.e)
    levels = np.full(first.shape, -1, dtype=np.int16)
    grid_points = shapely.points(lon, lat)
    for index, (_id, polygon) in enumerate(basins):
        shapely.prepare(polygon)
        levels[(levels == -1) & shapely.covers(polygon, grid_points)] = index
    inside = levels >= 0
    potential = int(inside.sum())
    if not potential or any(not (levels == index).any() for index, _ in enumerate(basins)):
        raise ValueError("Missing grid coverage in one or more subbasins")

    filename = "soilgrids_v2_topsoil.csv.gz"
    archive = DATA / filename
    temporary = archive.with_suffix(".tmp")
    columns = ["longitude", "latitude", "basin_id", "depth", *(item["field"] for item in PROPERTIES.values())]
    total_profiles, basin_profiles = [], {basin_id: [] for basin_id, _ in basins}
    row_count = 0
    with temporary.open("wb") as stream, gzip.GzipFile(fileobj=stream, mode="wb", mtime=0, filename="") as zipped, io.TextIOWrapper(zipped, encoding="utf-8", newline="") as wrapped:
        writer = csv.writer(wrapped, lineterminator="\n")
        writer.writerow(columns)
        for depth in DEPTHS:
            raw = {name: data[name, depth][1] for name in PROPERTIES}
            valid = (inside & (0 < raw["phh2o"]) & (raw["phh2o"] <= 140)
                     & (0 <= raw["soc"]) & (raw["soc"] <= 10000)
                     & (0 <= raw["clay"]) & (raw["clay"] <= 1000)
                     & (0 < raw["bdod"]) & (raw["bdod"] <= 300))
            converted = {key: values / PROPERTIES[key]["divisor"] for key, values in raw.items()}
            count = int(valid.sum())
            if count < potential / 2:
                raise ValueError(f"Only {count} of {potential} cross-variable valid cells at {depth}")
            row_count += count
            print(f"{depth}: {count:,} valid points from {potential:,} inside", flush=True)
            for row, col in zip(*np.nonzero(valid)):
                values = [f"{converted[key][row, col]:.{metadata['decimals']}f}" for key, metadata in PROPERTIES.items()]
                writer.writerow((f"{lon[row, col]:.8f}", f"{lat[row, col]:.8f}", basins[levels[row, col]][0], depth, *values))

            def profile(scope):
                live = valid & scope
                scope_count, valid_count = int(scope.sum()), int(live.sum())
                return {"depth": depth, "inside": scope_count, "samples": valid_count,
                        "coverage": round(valid_count / scope_count, 5),
                        "properties": {PROPERTIES[key]["field"]: describe(layer[live]) for key, layer in converted.items()}}

            total_profiles.append(profile(inside))
            for index, (basin_id, _) in enumerate(basins):
                basin_profiles[basin_id].append(profile(levels == index))

    temporary.replace(archive)
    manifest = {
        "id": "isric-soilgrids-2-topsoil", "label": "SoilGrids 金沙江表层土壤", "source": "ISRIC SoilGrids250m v2.0",
        "kind": "静态模型预测 · 多深度土壤", "rows": row_count, "unit": "条", "file": filename, "format": "csv.gz",
        "sourceUrl": SOURCE_URL, "licenseUrl": LICENSE_URL, "attribution": "ISRIC – World Soil Information, SoilGrids 2.0, CC BY 4.0. 金沙江工作台裁剪、单位换算与派生统计。",
        "description": "四项土壤属性的平均预测层，含 0–5、5–15、15–30 cm 三层。每行代表一个网格中心及一个深度。用于区域土壤背景与后续研究，不是实测剖面或生态评级阈值。",
        "nativeResolutionMetres": 250, "outputCrs": "EPSG:4326", "outputSpacingDegrees": [abs(transform.a), abs(transform.e)],
        "requestedExtent": list(bounds), "boundarySha256": digest(source_boundary), "insideCellsPerDepth": potential,
        "subbasins": len(basins), "depths": DEPTHS, "fields": list(PROPERTIES.values()), "columns": columns,
        "sourceCoverages": [source for _task, _raster, source in results], "sha256": digest(archive.read_bytes()), "bytes": archive.stat().st_size,
        "processing": "从 ISRIC WCS 2.0.1 重投影并按 0.14 缩小后，以网格中心点裁剪入 HYBAS_ID。对四项有效的样点求非面积加权空间分位数。pH 和容重正值用于排除无效匹配。土壤层有效覆盖率分母为子流域内网格中心数。",
    }
    write_json(DATA / "profiles.json", {"watershed": total_profiles, "subbasins": basin_profiles})
    write_json(DATA / "manifest.json", manifest)
    print(f"{row_count:,} rows at {len(basins)} subbasins; {archive.stat().st_size:,} compressed bytes", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boundary", type=Path, default=BOUNDARY)
    parser.add_argument("--cache", type=Path, required=True, help="Directory for raw WCS raster downloads")
    args = parser.parse_args()
    execute(args.boundary, args.cache)
