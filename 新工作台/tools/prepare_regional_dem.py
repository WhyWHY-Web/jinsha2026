"""Cache open Mapzen Terrarium tiles for the complete Jinsha regional view."""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from math import asinh, floor, pi, radians, tan
from pathlib import Path
from subprocess import check_output

from PIL import Image


BASE = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium"
ROOT = Path(__file__).resolve().parents[1] / "data" / "regional-dem"
BOUNDS = (88, 20, 112, 39)


def y_index(latitude, scale):
    return floor((1 - asinh(tan(radians(latitude))) / pi) / 2 * scale)


def tiles():
    west, south, east, north = BOUNDS
    for zoom in range(5, 8):
        scale = 2 ** zoom
        for x in range(floor((west + 180) / 360 * scale), floor((east + 180) / 360 * scale) + 1):
            for y in range(y_index(north, scale), y_index(south, scale) + 1):
                yield zoom, x, y


def download(tile):
    zoom, x, y = tile
    output = ROOT / str(zoom) / str(x) / f"{y}.png"
    if output.is_file():
        with Image.open(output) as existing:
            existing.verify()
        return
    url = f"{BASE}/{zoom}/{x}/{y}.png"
    data = check_output(["curl", "--fail", "--silent", "--show-error", "--retry", "2",
                         "--connect-timeout", "8", "--max-time", "20", url])
    with Image.open(BytesIO(data)) as image:
        if image.format != "PNG" or image.size != (256, 256):
            raise ValueError(f"Invalid elevation tile {tile}")
        image.verify()
    output.parent.mkdir(parents=True, exist_ok=True)
    staged = output.with_suffix(".part")
    staged.write_bytes(data)
    staged.replace(output)


if __name__ == "__main__":
    selected = list(tiles())
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(download, selected))
    (ROOT / "complete").write_text(str(len(selected)) + "\n", encoding="ascii")
    print(f"Verified {len(selected)} local Mapzen Terrarium tiles")
