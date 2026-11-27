"""Create a WorldCover 2021 sampling grid. Requires rasterio, NumPy and Shapely 2."""
from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from math import floor
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from shapely import contains_xy, prepare, union_all
from shapely.geometry import box, shape

YEAR = 2021
RESOLUTION = 100
TILE_DEGREES = 3
SAMPLES_PER_TILE = TILE_DEGREES * RESOLUTION
COG_ROOT = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map"
SOURCE_URL = "https://esa-worldcover.org/en/data-access"
LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/"
BOUNDARY = Path("系统/data/basin/jinsha_basin.geojson")
CLASSES = {
    0: "无数据", 10: "乔木覆盖", 20: "灌丛", 30: "草地", 40: "耕地",
    50: "建设用地", 60: "裸地或稀疏植被", 70: "冰雪", 80: "永久水体",
    90: "草本湿地", 95: "红树林", 100: "苔藓与地衣",
}
GDAL_OPTIONS = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tif",
    "GDAL_HTTP_TIMEOUT": "25",
    "GDAL_HTTP_MAX_RETRY": "2",
}

@dataclass(frozen=True)
class SampleTile:
    url: str
    lon: np.ndarray
    lat: np.ndarray
    codes: np.ndarray
    overviews: tuple[int, ...]


def hemisphere(value: int, positive: str, negative: str) -> str:
    return f"{positive if value >= 0 else negative}{abs(value):03d}"


def get_tile(spec) -> SampleTile:
    west, south, lon, lat, inside = spec
    latitude_hemisphere = "N" if south >= 0 else "S"
    latitude_code = f"{latitude_hemisphere}{abs(south):02d}"
    name = latitude_code + hemisphere(west, "E", "W")
    url = f"{COG_ROOT}/ESA_WorldCover_10m_{YEAR}_v200_{name}_Map.tif"
    with rasterio.Env(**GDAL_OPTIONS):
        with rasterio.open(f"/vsicurl/{url}") as archive:
            bounds = (west, south, west + TILE_DEGREES, south + TILE_DEGREES)
            if archive.crs.to_epsg() != 4326 or not np.allclose(archive.bounds, bounds):
                raise ValueError(f"Unexpected CRS or extent in {url}")
            overviews = tuple(archive.overviews(1))
            if not overviews or max(overviews) < 32:
                raise ValueError(f"COG overview unavailable in {url}")
            values = archive.read(
                1,
                out_shape=(SAMPLES_PER_TILE, SAMPLES_PER_TILE),
                resampling=Resampling.nearest,
            )
    print(f"{name} {np.count_nonzero(inside):,} cells", flush=True)
    return SampleTile(url, lon[inside], lat[inside], values[inside], overviews)


def find_tiles(boundary):
    min_lon, min_lat, max_lon, max_lat = boundary.bounds
    for west in range(floor(min_lon / TILE_DEGREES) * TILE_DEGREES, floor(max_lon) + 1, TILE_DEGREES):
        for south in range(floor(min_lat / TILE_DEGREES) * TILE_DEGREES, floor(max_lat) + 1, TILE_DEGREES):
            if not boundary.intersects(box(west, south, west + TILE_DEGREES, south + TILE_DEGREES)):
                continue
            offset = (np.arange(SAMPLES_PER_TILE) + 0.5) / RESOLUTION
            lon, lat = np.meshgrid(west + offset, south + TILE_DEGREES - offset)
            inside = contains_xy(boundary, lon, lat)
            if inside.any():
                yield west, south, lon, lat, inside


def main() -> None:
    application = Path(__file__).resolve().parents[1]
    basin = json.loads((application.parent / BOUNDARY).read_text(encoding="utf-8"))
    boundary = union_all([shape(feature["geometry"]) for feature in basin["features"]])
    prepare(boundary)
    tiles = list(find_tiles(boundary))
    print(f"Reading overviews of {len(tiles)} COG tiles", flush=True)
    folder = application / "data" / "landcover"
    folder.mkdir(parents=True, exist_ok=True)
    file = folder / "worldcover_2021_cells.csv.gz"
    temporary = folder / (file.name + ".tmp")
    columns = ("longitude", "latitude", "year", "class_code")
    counts: Counter[int] = Counter()
    sources = []
    rules = "从官方 WorldCover COG 内建低分辨率概览最近邻采样，按网格中心点掩膜，0.01° EPSG:4326。"
    with (
        ThreadPoolExecutor(max_workers=5) as pool,
        temporary.open("wb") as blob,
        gzip.GzipFile(filename="", fileobj=blob, mode="wb", mtime=0) as gz,
        io.TextIOWrapper(gz, encoding="utf-8", newline="") as text,
    ):
        writer = csv.writer(text, lineterminator="\n")
        writer.writerow(columns)
        for tile in pool.map(get_tile, tiles):
            counts.update(map(int, tile.codes))
            sources.append({"url": tile.url, "overviewFactors": list(tile.overviews)})
            writer.writerows(
                (f"{lon:.3f}", f"{lat:.3f}", YEAR, int(code))
                for lon, lat, code in zip(tile.lon, tile.lat, tile.codes, strict=True)
            )

    if set(counts) - set(CLASSES):
        raise ValueError(f"Unexpected class codes: {set(counts) - set(CLASSES)}")
    if not counts:
        raise ValueError("Basin sample is empty")
    temporary.replace(file)
    with file.open("rb") as raw_samples:
        digest = hashlib.file_digest(raw_samples, "sha256").hexdigest()
    manifest = {
        "id": "esa-worldcover-2021-sample",
        "label": "ESA WorldCover 2021 流域土地覆盖样本",
        "source": "ESA WorldCover 2021 v200",
        "kind": "卫星遥感分类 · 0.01° 网格样本",
        "rows": sum(counts.values()),
        "startYear": YEAR,
        "endYear": YEAR,
        "file": file.name,
        "format": "csv.gz",
        "description": rules + " 用于流域图层和按类筛选。类别频数为样本数。",
        "sourceUrl": SOURCE_URL,
        "licenseUrl": LICENSE_URL,
        "attribution": "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by the ESA WorldCover consortium",
        "crs": "EPSG:4326",
        "coverageBounds": [round(value, 6) for value in boundary.bounds],
        "maskSource": BOUNDARY.as_posix(),
        "cellSpacingDegrees": 1 / RESOLUTION,
        "columns": list(columns),
        "columnsDescription": {"longitude": "°E", "latitude": "°N", "year": "产品年份", "class_code": "ESA 官方类别代码"},
        "classLegend": CLASSES,
        "classCounts": dict(sorted(counts.items())),
        "sourceTiles": sources,
        "missingRows": counts[0],
        "bytes": file.stat().st_size,
        "sha256": digest,
    }
    manifest_path = folder / "manifest.json"
    staged_manifest = folder / "manifest.json.tmp"
    staged_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    staged_manifest.replace(manifest_path)
    print(f"Saved {manifest['rows']:,} samples in {manifest['bytes']:,} bytes", flush=True)


if __name__ == "__main__":
    main()
