from __future__ import annotations

import argparse
import calendar
import csv
import gzip
import hashlib
import io
import json
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import URLError
from urllib.request import urlopen

from shapely.geometry import Point, shape
from shapely.ops import unary_union

BASE = "https://www.ncei.noaa.gov/pub/data/ghcn/daily/"
PRODUCT = "https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-daily"
DOCUMENTATION = BASE + "readme.txt"
METADATA = "https://www.ncei.noaa.gov/metadata/geoportal/rest/metadata/item/gov.noaa.ncdc:C00861/html"
ELEMENTS = {
    "TMAX": ("°C", 10),
    "TMIN": ("°C", 10),
    "TAVG": ("°C", 10),
    "PRCP": ("mm", 10),
    "SNOW": ("mm", 1),
    "SNWD": ("mm", 1),
}
COLUMNS = ["station_id", "date", "element", "value", "unit", "measurement_flag", "quality_flag", "source_flag"]
ROOT = Path(__file__).resolve().parents[1]


def download(url: str) -> bytes:
    for attempt in range(3):
        try:
            with urlopen(url, timeout=30) as response:
                return response.read()
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(1 + attempt)


def station_scope(index_text: str, boundary_file: Path) -> list[dict]:
    boundary = json.loads(boundary_file.read_text(encoding="utf-8-sig"))
    geometry = unary_union([shape(item["geometry"]) for item in boundary["features"]])
    west, south, east, north = geometry.bounds
    stations = []
    for line in index_text.splitlines():
        if len(line) < 71:
            continue
        station_id = line[:11].strip()
        try:
            lat, lon, elevation = float(line[12:20]), float(line[21:30]), float(line[31:37])
        except ValueError:
            continue
        if not (west <= lon <= east and south <= lat <= north and geometry.covers(Point(lon, lat))):
            continue
        stations.append({
            "stationId": station_id,
            "name": line[41:71].strip(),
            "lat": lat,
            "lon": lon,
            "elevation_m": None if elevation == -999.9 else elevation,
        })
    return sorted(stations, key=lambda station: station["stationId"])


def observations(station_id: str, data: bytes, first_year: int, last_year: int):
    for line in data.decode("ascii").splitlines():
        if len(line) < 269 or line[:11] != station_id:
            continue
        year, month, element = int(line[11:15]), int(line[15:17]), line[17:21]
        if not first_year <= year <= last_year or element not in ELEMENTS:
            continue
        unit, divisor = ELEMENTS[element]
        for day in range(1, calendar.monthrange(year, month)[1] + 1):
            start = 21 + (day - 1) * 8
            value = int(line[start:start + 5])
            measurement, quality, source = line[start + 5:start + 8]
            if value == -9999 or quality != " ":
                continue
            numeric = str(value) if divisor == 1 else f"{value / divisor:.1f}"
            yield station_id, f"{year:04d}-{month:02d}-{day:02d}", element, numeric, unit, measurement.strip(), quality.strip(), source.strip()


def default_boundary() -> Path:
    return next(path / "data" / "basin" / "jinsha_basin.geojson" for path in ROOT.parent.iterdir()
                if (path / "data" / "basin" / "jinsha_basin.geojson").is_file())


def main() -> None:
    parser = argparse.ArgumentParser(description="Import unflagged GHCN-Daily observations for the project basin.")
    parser.add_argument("--boundary", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "ghcn")
    parser.add_argument("--from-year", type=int, default=1980)
    parser.add_argument("--through-year", type=int, default=datetime.now(timezone.utc).year)
    args = parser.parse_args()
    if args.through_year < args.from_year:
        parser.error("--through-year must be at or after --from-year")

    path = args.boundary or default_boundary()
    stations = station_scope(download(BASE + "ghcnd-stations.txt").decode("ascii", errors="replace"), path)
    if not stations:
        raise ValueError("No NOAA stations inside the supplied boundary.")

    def fetch(station: dict):
        station_id = station["stationId"]
        return download(BASE + "all/" + station_id + ".dly")

    args.output.mkdir(parents=True, exist_ok=True)
    counters, source_files, station_summaries = Counter(), [], []
    first_all, last_all = "9999-99-99", "0000-00-00"
    output_file = args.output / "daily-observations.csv.gz"
    with TemporaryDirectory(dir=args.output) as directory, ThreadPoolExecutor(max_workers=5) as workers:
        staged = Path(directory)
        staged_data = staged / output_file.name
        with staged_data.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with io.TextIOWrapper(compressed, encoding="utf-8", newline="") as stream:
                writer = csv.writer(stream, lineterminator="\n")
                writer.writerow(COLUMNS)
                for station, source in zip(stations, workers.map(fetch, stations)):
                    station_id = station["stationId"]
                    values = list(observations(station_id, source, args.from_year, args.through_year))
                    source_files.append({
                        "url": BASE + "all/" + station_id + ".dly",
                        "sha256": hashlib.sha256(source).hexdigest(),
                        "bytes": len(source),
                    })
                    if not values:
                        continue
                    values.sort(key=lambda row: (row[1], row[2]))
                    first, last = values[0][1], values[-1][1]
                    counts = Counter(row[2] for row in values)
                    writer.writerows(values)
                    counters.update(counts)
                    first_all, last_all = min(first_all, first), max(last_all, last)
                    station_summaries.append({**station, "rows": len(values), "firstDate": first, "lastDate": last,
                                              "elements": dict(sorted(counts.items()))})
                    print(f"{station_id}: {len(values):,} ({first} to {last})", flush=True)

        if not counters:
            raise ValueError("The station data has no acceptable observations in the requested years.")
        manifest = {
            "id": "ghcn-daily",
            "label": "NOAA 全球历史气候网日观测",
            "source": "NOAA NCEI · Global Historical Climatology Network–Daily (GHCN-Daily)",
            "kind": "气象地面站日观测",
            "rows": sum(counters.values()),
            "startYear": int(first_all[:4]),
            "endYear": int(last_all[:4]),
            "startDate": first_all,
            "endDate": last_all,
            "retrievedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "file": output_file.name,
            "format": "csv.gz",
            "sizeBytes": staged_data.stat().st_size,
            "sha256": hashlib.sha256(staged_data.read_bytes()).hexdigest(),
            "columns": COLUMNS,
            "description": "按项目金沙江流域边界选取站点，归档最高温、最低温、平均温、日降水及可用雪量。每行是单站、单日、单要素。保留 NOAA 测量与来源标志，剔除缺测和非空质量标志。记录时间以各站归档为准，年度和站点覆盖不完全一致。",
            "sourceUrl": PRODUCT,
            "licenseUrl": METADATA,
            "doi": "10.7289/V5D21VHZ",
            "documentationUrl": DOCUMENTATION,
            "stationIndexUrl": BASE + "ghcnd-stations.txt",
            "stationCount": len(station_summaries),
            "elements": {element: {"rows": count, "unit": ELEMENTS[element][0]}
                         for element, count in sorted(counters.items())},
            "stations": station_summaries,
            "sourceFiles": source_files,
            "spatialFilter": {
                "geometry": "项目金沙江流域 GeoJSON 子流域边界合并",
                "crs": "WGS 84 / EPSG:4326",
                "method": "点坐标位于合并后的多边形内或边界上",
                "boundarySha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            },
        }
        staged_manifest = staged / "manifest.json"
        staged_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        staged_data.replace(output_file)
        staged_manifest.replace(args.output / "manifest.json")
    print(f"{manifest['rows']:,} observations, {manifest['stationCount']} stations, {first_all} to {last_all}", flush=True)


if __name__ == "__main__":
    main()
