"""Clip the official HydroRIVERS Asia shapefile to the project basin."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import date
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

import geopandas as gpd
from pyproj import Geod
from shapely import get_parts, intersection, set_precision
from shapely.geometry import MultiLineString, Point, mapping, shape
from shapely.prepared import prep


SOURCE = "https://data.hydrosheds.org/file/HydroRIVERS/HydroRIVERS_v10_as_shp.zip"
PRODUCT = "https://www.hydrosheds.org/products/hydrorivers"
LICENSE = "https://data.hydrosheds.org/file/technical-documentation/HydroSHEDS_TechDoc_v1_4.pdf"
CITATION = "Lehner, B. and Grill, G. (2013). Global river hydrography and network routing. Hydrological Processes, 27(15): 2171–2186. https://doi.org/10.1002/hyp.9740"
CREDIT = "HydroRIVERS v1.0 · HydroSHEDS © World Wildlife Fund, Inc. (2006–2022)"
COLUMNS = ["HYRIV_ID", "NEXT_DOWN", "ORD_STRA", "DIS_AV_CMS", "LENGTH_KM", "UPLAND_SKM"]


def write_json(path: Path, value: dict) -> None:
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    path.write_text(payload + "\n", encoding="utf-8")


def numeric_or_none(value: float, digits: int) -> float | None:
    return round(float(value), digits) if value >= 0 else None


def line_parts(geometry):
    if geometry.geom_type == "LineString":
        return [geometry] if not geometry.is_empty else []
    if geometry.geom_type in {"MultiLineString", "GeometryCollection"}:
        return [part for child in get_parts(geometry) for part in line_parts(child)]
    return []


def trace_mainstem(features: list[dict]) -> list[dict]:
    """Trace the model network upstream from the project outlet near Yibin."""
    ids = {feature["id"] for feature in features}
    outlet_hint = Point(104.64, 28.77)
    by_downstream = defaultdict(list)
    outlet_candidates = []
    for feature in features:
        downstream = feature["properties"]["next_down"]
        by_downstream[downstream].append(feature)
        if downstream not in ids and shape(feature["geometry"]).distance(outlet_hint) < 0.05:
            outlet_candidates.append(feature)
    if not outlet_candidates:
        return []
    accumulation = lambda feature: feature["properties"]["upstream_area_km2"] or 0
    current = max(outlet_candidates, key=accumulation)
    mainstem = []
    seen = set()
    while current["id"] not in seen:
        mainstem.append(current)
        seen.add(current["id"])
        upstream = by_downstream[current["id"]]
        if not upstream:
            break
        current = max(upstream, key=accumulation)
    return mainstem[::-1]


def make_collection(features: list[dict]) -> dict:
    return {
        "type": "FeatureCollection",
        "attribution": CREDIT,
        "features": features,
    }


def clip_hydrorivers(archive: Path, basin_path: Path, output: Path) -> None:
    basin = gpd.read_file(basin_path).to_crs("EPSG:4326")
    area_km2 = basin.to_crs("EPSG:6933").union_all().area / 1e6
    shape = set_precision(basin.make_valid().union_all(), 0.00001)
    mask = prep(shape)
    with ZipFile(archive) as zipped:
        member = next(name for name in zipped.namelist() if name.lower().endswith(".shp"))
    uri = f"zip://{archive.resolve().as_posix()}!{member}"
    candidates = gpd.read_file(uri, bbox=tuple(basin.total_bounds), columns=COLUMNS)
    if candidates.crs.to_epsg() != 4326:
        raise ValueError(f"Expected source CRS EPSG:4326, got {candidates.crs}")

    features = []
    geodesic = Geod(ellps="WGS84")
    for river in candidates.itertuples(index=False):
        if not mask.intersects(river.geometry):
            continue
        clipped = mask.covers(river.geometry)
        geometry = river.geometry if clipped else intersection(shape, river.geometry)
        geometry = set_precision(geometry, 0.00001)
        parts = line_parts(geometry)
        if not parts:
            continue
        length = sum(geodesic.geometry_length(part) for part in parts) / 1000
        line = parts[0] if len(parts) == 1 else MultiLineString(parts)
        properties = {
            "id": int(river.HYRIV_ID),
            "next_down": int(river.NEXT_DOWN) or None,
            "order": int(river.ORD_STRA),
            "discharge_m3s": numeric_or_none(river.DIS_AV_CMS, 4),
            "length_km": numeric_or_none(river.LENGTH_KM, 3),
            "clipped_length_km": round(length, 3),
            "upstream_area_km2": numeric_or_none(river.UPLAND_SKM, 2),
            "boundary_clipped": not clipped,
        }
        features.append({
            "type": "Feature",
            "id": properties["id"],
            "properties": properties,
            "geometry": mapping(line),
        })
    features.sort(key=lambda feature: feature["id"])
    overview = [feature for feature in features if feature["properties"]["order"] >= 4]

    mainstem = trace_mainstem(features)
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "rivers.geojson", make_collection(features))
    write_json(output / "rivers-major.geojson", make_collection(overview))
    write_json(output / "river-mainstem.geojson", make_collection(mainstem))
    with archive.open("rb") as reader:
        digest = hashlib.file_digest(reader, "sha256").hexdigest()
    metadata = {
        "id": "hydrorivers-jinsha-v10",
        "title": "金沙江流域 HydroRIVERS 河网",
        "version": "HydroRIVERS v1.0",
        "attribution": CREDIT,
        "citation": CITATION,
        "product_url": PRODUCT,
        "download_url": SOURCE,
        "license_url": LICENSE,
        "source_sha256": digest,
        "source_bytes": archive.stat().st_size,
        "generated": date.today().isoformat(),
        "geometry": "LineString / MultiLineString",
        "crs": "EPSG:4326 (longitude, latitude)",
        "clip_source": "系统/data/basin/jinsha_basin.geojson",
        "clip_bbox": [round(float(bound), 6) for bound in basin.total_bounds],
        "clip_area_km2": round(area_km2),
        "bbox_candidates": len(candidates),
        "features": len(features),
        "boundary_clipped": sum(feature["properties"]["boundary_clipped"] for feature in features),
        "orders": dict(sorted(Counter(feature["properties"]["order"] for feature in features).items())),
        "layers": {
            "rivers.geojson": {"features": len(features), "bytes": (output / "rivers.geojson").stat().st_size},
            "rivers-major.geojson": {
                "features": len(overview),
                "bytes": (output / "rivers-major.geojson").stat().st_size,
                "selection": "Strahler order >= 4",
            },
            "river-mainstem.geojson": {
                "features": len(mainstem),
                "bytes": (output / "river-mainstem.geojson").stat().st_size,
                "selection": "HydroRIVERS upstream path by drainage area, from the Yibin outlet",
                "length_km": round(sum(feature["properties"]["clipped_length_km"] for feature in mainstem), 1),
            },
        },
        "fields": {
            "id": "HydroRIVERS HYRIV_ID",
            "next_down": "Original downstream HYRIV_ID, potentially outside the clip",
            "order": "HydroRIVERS Strahler stream order",
            "discharge_m3s": "HydroRIVERS estimated long-term mean discharge (m³/s)",
            "length_km": "Original full reach length (km)",
            "clipped_length_km": "In-basin line length, measured geodesically after coordinate rounding (km)",
            "upstream_area_km2": "HydroRIVERS upstream drainage area (km²)",
            "boundary_clipped": "At least some of the original reach fell outside the project boundary",
        },
        "limitations": [
            "河网为 HydroSHEDS 基于地形与河网规则提取的产品。平均流量为长期模型估算。",
            "覆盖范围继承旧项目的 27 个水文子流域边界，超过站点 DEM 的范围。",
            "下游索引保留源产品拓扑，边界处有引用指向裁剪区外。",
            "坐标保留到 0.00001 度，几何供全流域制图和分析。",
        ],
    }
    write_json(output / "rivers.source.json", metadata)
    print(f"{len(features)} river reaches, {len(overview)} major reaches, {area_km2:,.0f} km²")


def main() -> None:
    script_dir = Path(__file__).resolve().parent
    workspace = script_dir.parent.parent
    parser = argparse.ArgumentParser(description=__doc__, epilog=f"Download source: {SOURCE}")
    parser.add_argument("archive", type=Path, help="Official HydroRIVERS Asia shapefile ZIP")
    parser.add_argument("--basin", type=Path, default=workspace / "系统" / "data" / "basin" / "jinsha_basin.geojson")
    parser.add_argument("--output", type=Path, default=script_dir.parent / "data")
    args = parser.parse_args()
    clip_hydrorivers(args.archive, args.basin, args.output)


if __name__ == "__main__":
    main()
