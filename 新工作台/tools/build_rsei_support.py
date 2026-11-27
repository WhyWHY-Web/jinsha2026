"""Summarize the aligned Landsat archive on a versioned basin and explicit masks."""

import argparse
from hashlib import sha256
from itertools import combinations
import json
from pathlib import Path

import numpy as np
from pyproj import Geod
import rasterio
from rasterio.features import rasterize


def digest(path):
    with path.open("rb") as stream:
        hasher = sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def row_areas(grid):
    """One WGS84 cell area per raster row, in square kilometres."""
    transform, width, height = grid
    if transform.b or transform.d or transform.a <= 0 or transform.e >= 0:
        raise ValueError("Expected an unrotated north-up WGS84 raster")
    datum = Geod(ellps="WGS84")
    west, east = transform.c, transform.c + transform.a
    latitudes = transform.f + transform.e * np.arange(height + 1)
    areas = [
        abs(datum.polygon_area_perimeter([west, east, east, west], [n, n, s, s])[0]) / 1e6
        for n, s in zip(latitudes[:-1], latitudes[1:])
    ]
    return np.broadcast_to(np.asarray(areas)[:, None], (height, width))


def summary(array, mask, weights):
    area = float(weights[mask].sum())
    return {
        "validPixels": int(mask.sum()),
        "coverageKm2": round(area, 2),
        "value": round(float(np.dot(array[mask].astype("float64"), weights[mask]) / area), 6) if area else None,
    }


def build(data):
    boundaries_path = data / "basin" / "jinsha_basin.geojson"
    boundaries = json.loads(boundaries_path.read_text(encoding="utf-8-sig"))["features"]
    arrays, valid, sources = {}, {}, []
    grid = None
    for path in sorted((data / "rsei").glob("rsei_*_1km.tif")):
        year = int(path.stem.split("_")[1])
        with rasterio.open(path) as raster:
            signature = (raster.transform, raster.width, raster.height)
            if raster.crs.to_epsg() != 4326 or (grid and signature != grid):
                raise ValueError(f"Raster {year} has a different grid or CRS")
            if raster.count != 1 or raster.nodata != 0:
                raise ValueError(f"Raster {year} has an unexpected mask convention")
            grid = signature
            arrays[year] = raster.read(1)
            valid[year] = np.isfinite(arrays[year]) & (arrays[year] > 0) & (arrays[year] <= 1)
        sources.append({"year": year, "file": path.name, "sha256": digest(path)})

    if len(arrays) < 2:
        raise ValueError("At least two historical RSEI rasters are required")
    transform, width, height = grid
    weights = row_areas(grid)
    region_grid = rasterize(
        [(feature["geometry"], index) for index, feature in enumerate(boundaries, start=1)],
        out_shape=(height, width), transform=transform, fill=0, dtype="uint16", all_touched=False,
    )
    years = list(arrays)
    all_common = np.logical_and.reduce(list(valid.values()))

    def summarize_region(identifier, raster_mask):
        area = float(weights[raster_mask].sum())
        records = [
            {
                "year": year,
                "ambiguousZeroPixels": int(np.count_nonzero(raster_mask & (arrays[year] == 0))),
                **summary(arrays[year], raster_mask & valid[year], weights),
                "allYearsCommon": summary(arrays[year], raster_mask & all_common, weights),
            }
            for year in years
        ]
        pairs = []
        for start, end in combinations(years, 2):
            overlap = raster_mask & valid[start] & valid[end]
            left = summary(arrays[start], overlap, weights)
            right = summary(arrays[end], overlap, weights)
            pairs.append({
                "startYear": start, "endYear": end,
                "validPixels": left["validPixels"], "coverageKm2": left["coverageKm2"],
                "startValue": left["value"], "endValue": right["value"],
                "delta": round(right["value"] - left["value"], 6) if left["value"] is not None else None,
            })
        return {"id": identifier, "areaKm2": round(area, 2), "records": records, "pairs": pairs}

    regions = {"basin": summarize_region("basin", region_grid > 0)}
    for label, feature in enumerate(boundaries, start=1):
        identifier = "subbasin:" + str(feature["properties"]["HYBAS_ID"])
        regions[identifier] = summarize_region(identifier, region_grid == label)

    return {
        "version": "rsei-common-support-v1",
        "source": "项目 Landsat RSEI 历史归档",
        "boundarySha256": digest(boundaries_path),
        "rasterSources": sources,
        "pixelSizeDegrees": abs(transform.a),
        "crs": "EPSG:4326",
        "note": "按像元中心归区，使用 WGS84 椭球像元面积加权。原档以 0 编码无效值，无法与真实 0 区分，现档 0 像元统一排除。各期仍沿用原归档传感器、掩膜和 PCA，变化量为同位置档案对照。",
        "regions": regions,
    }


def main():
    workbench = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=workbench.parent / "系统" / "data")
    parser.add_argument("--output", type=Path, default=workbench / "data" / "ecology" / "rsei-support.json")
    args = parser.parse_args()
    result = build(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    pending = args.output.with_suffix(".json.tmp")
    pending.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    pending.replace(args.output)
    print(f"{len(result['rasterSources'])} archive years, {len(result['regions'])} regions, {args.output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
