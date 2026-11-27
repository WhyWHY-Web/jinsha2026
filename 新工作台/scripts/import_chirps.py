"""Build the basin-clipped CHIRPS v2 archive. Requires numpy, requests and shapely>=2."""
import argparse
from collections import Counter
from datetime import date
import csv
from concurrent.futures import ThreadPoolExecutor
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import struct

import numpy as np
import requests
from shapely import intersects_xy, union_all
from shapely.geometry import shape

BASE = "https://iridl.ldeo.columbia.edu/SOURCES/.UCSB/.CHIRPS/.v2p0/.monthly/.global/.precipitation/"
PRODUCT = "https://www.chc.ucsb.edu/data/chirps"
OUTPUT = "chirps_monthly_025_sample.csv.gz"
WORKBENCH = Path(__file__).resolve().parents[1]
BOUNDARY = WORKBENCH.parent / "系统" / "data" / "basin" / "jinsha_basin.geojson"


def query_url(first, last):
    return BASE + f"dods.dods?precipitation[{first}:1:{last}][280:5:510][5405:5:5705]"


def retrieve(span):
    url = query_url(*span)
    for attempt in range(3):
        try:
            response = requests.get(url, timeout=(24, 90))
            response.raise_for_status()
            return response.content
        except (requests.Timeout, requests.ConnectionError):
            if attempt == 2:
                raise


def source_month_count():
    response = requests.get(BASE + "dods.dds", timeout=(24, 45))
    response.raise_for_status()
    count = re.search(r"Float32 T\[T\s*=\s*(\d+)\]", response.text)
    if not count:
        raise ValueError("Source DAP2 time coordinate missing")
    return int(count[1])


def parse_dap(payload):
    header, marker, data = payload.partition(b"\nData:\n")
    if not marker or not header.startswith(b"Dataset"):
        raise ValueError("Source did not return a DAP2 grid")
    dims = re.search(rb"Float32 precipitation\[T = (\d+)\]\[Y = (\d+)\]\[X = (\d+)\]", header)
    if not dims:
        raise ValueError("Unexpected grid declaration")
    t, y, x = map(int, dims.groups())
    offset = 0
    arrays = []
    for expected in (t*y*x, t, y, x):
        actual, repeated = struct.unpack_from(">II", data, offset)
        offset += 8
        if actual != expected or repeated != expected:
            raise ValueError("Unexpected DAP2 vector length")
        arrays.append(np.frombuffer(data, dtype=">f4", count=expected, offset=offset))
        offset += actual * 4
    if offset != len(data):
        raise ValueError("Unexpected extra DAP2 bytes")
    return arrays[0].reshape(t,y,x), arrays[1], arrays[2], arrays[3]


def format_month(months):
    index = int(months)
    year, month = divmod(index, 12)
    return 1960 + year, month + 1


def join_snapshots(payloads):
    grids = [parse_dap(payload) for payload in payloads]
    lat, lon = grids[0][2:]
    if any(not np.array_equal(lat, x[2]) or not np.array_equal(lon, x[3]) for x in grids[1:]):
        raise ValueError("Chunk grid coordinates differ")
    return np.concatenate([g[0] for g in grids]), np.concatenate([g[1] for g in grids]), lat, lon


def export(grid, urls, boundary, dest):
    precipitation, times, lat, lon = grid
    xx, yy = np.meshgrid(lon, lat)
    basin = union_all([shape(feature["geometry"]) for feature in boundary["features"]])
    inside = intersects_xy(basin, xx, yy)
    y_indices, x_indices = np.where(inside)
    selected = precipitation[:, y_indices, x_indices]
    valid = np.isfinite(selected) & (selected >= 0)
    if not np.any(valid):
        raise ValueError("No valid precipitation rows in supplied basin")
    if not np.all(np.diff(times) == 1):
        raise ValueError("Source month coordinate is incomplete")
    points = [
        (f"CHIRPS_{5405+x*5}_{280+y*5}", f"{lon[x]:.3f}", f"{lat[y]:.3f}")
        for y, x in zip(y_indices, x_indices)
    ]

    dest.mkdir(parents=True, exist_ok=True)
    months = [format_month(value) for value in times]
    per_year = Counter()
    pending = dest / (OUTPUT + ".tmp")
    with pending.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as zipped:
        with io.TextIOWrapper(zipped, encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream, lineterminator="\n")
            writer.writerow(("date", "year", "month", "grid_id", "lon", "lat", "precip_mm"))
            for index, (year, month) in enumerate(months):
                stamp = f"{year:04d}-{month:02d}"
                indices = np.flatnonzero(valid[index])
                per_year[year] += len(indices)
                for point in indices:
                    writer.writerow((stamp, year, month, *points[point], f"{selected[index, point]:.3f}"))
    archive = dest / OUTPUT
    pending.replace(archive)
    start_year, start_month = months[0]
    end_year, end_month = months[-1]
    manifest = {
        "id": "chirps-monthly",
        "label": "CHIRPS 流域月降水网格",
        "source": "UCSB Climate Hazards Center CHIRPS v2.0 · Columbia University IRI Data Library",
        "kind": "卫星与地面站融合降水产品",
        "rows": sum(per_year.values()),
        "startYear": start_year,
        "endYear": end_year,
        "startMonth": f"{start_year:04d}-{start_month:02d}",
        "endMonth": f"{end_year:04d}-{end_month:02d}",
        "file": OUTPUT,
        "format": "csv.gz",
        "description": "按项目流域边界筛选 CHIRPS v2.0 月降水原产品像元中心。像元分辨率 0.05°，每隔 5 个像元取样，格点间距 0.25°。数值为 mm/月，缺测从记录中排除。",
        "license": "Public domain",
        "licenseUrl": PRODUCT,
        "sourceUrl": PRODUCT,
        "downloadUrls": urls,
        "downloadRoot": BASE,
        "retrievedOn": date.today().isoformat(),
        "unit": "mm/月",
        "crs": "EPSG:4326",
        "nativeResolutionDegrees": 0.05,
        "pointSpacingDegrees": 0.25,
        "gridPoints": len(points),
        "months": len(months),
        "missingRows": int(valid.size - valid.sum()),
        "minimumPrecipMm": round(float(selected[valid].min()), 3),
        "maximumPrecipMm": round(float(selected[valid].max()), 3),
        "rowsByYear": dict(sorted(per_year.items())),
        "csvGzipSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "sizeBytes": archive.stat().st_size,
    }
    temporary_manifest = dest / "manifest.json.tmp"
    temporary_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    temporary_manifest.replace(dest / "manifest.json")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", type=Path, nargs="+", help="Use already downloaded DAP2 slices in time order")
    args = parser.parse_args()
    if args.snapshot:
        payloads = [path.read_bytes() for path in args.snapshot]
        spans = []
        for payload in payloads:
            times = parse_dap(payload)[1]
            spans.append((int(times[0])-252, int(times[-1])-252))
    else:
        count = source_month_count()
        spans = [(first, min(count-1, first+179)) for first in range(0, count, 180)]
        with ThreadPoolExecutor(max_workers=3) as executor:
            payloads = list(executor.map(retrieve, spans))
    boundary = json.loads(BOUNDARY.read_text(encoding="utf-8-sig"))
    manifest = export(
        join_snapshots(payloads),
        [query_url(*span) for span in spans],
        boundary,
        WORKBENCH / "data" / "precipitation",
    )
    print(manifest["rows"], "rows", manifest["gridPoints"], "points", manifest["startMonth"], manifest["endMonth"])


if __name__ == "__main__":
    main()
