"""Build an offline relief backdrop and feather the existing Esri archive at its edges."""
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from math import asinh, floor, pi, radians, tan
from pathlib import Path
from subprocess import check_output

import numpy as np
from PIL import Image


WORKBENCH = Path(__file__).resolve().parents[1]
IMAGERY = WORKBENCH / "data" / "source-assets" / "satellite-3d-hd.jpg"
OUTPUT = WORKBENCH / "data" / "map-context"
BOUNDS = 88.0, 20.0, 112.0, 39.0
ZOOM = 6
SCALE = 2 ** ZOOM * 256
SOURCE = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium"


def mercator_x(longitude):
    return (longitude + 180) / 360 * SCALE


def mercator_y(latitude):
    return (1 - asinh(tan(radians(latitude))) / pi) / 2 * SCALE


def read_tile(pair):
    x, y = pair
    contents = check_output(["curl", "--fail", "--silent", "--show-error", "--retry", "2",
                            "--connect-timeout", "8", "--max-time", "20", f"{SOURCE}/{ZOOM}/{x}/{y}.png"])
    with Image.open(BytesIO(contents)) as tile:
        rgb = np.asarray(tile.convert("RGB"), dtype="float32")
    return x, y, rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768


def make_relief():
    west, south, east, north = BOUNDS
    left, right = mercator_x(west), mercator_x(east)
    top, bottom = mercator_y(north), mercator_y(south)
    xs = range(floor(left / 256), floor(right / 256) + 1)
    ys = range(floor(top / 256), floor(bottom / 256) + 1)
    canvas = np.zeros((len(ys) * 256, len(xs) * 256), dtype="float32")
    with ThreadPoolExecutor(max_workers=8) as pool:
        for x, y, heights in pool.map(read_tile, [(x, y) for x in xs for y in ys]):
            row, column = (y - ys.start) * 256, (x - xs.start) * 256
            canvas[row:row + 256, column:column + 256] = heights
    raster = Image.fromarray(canvas).transform(
        (1800, 1600), Image.Transform.EXTENT,
        (left - xs.start * 256, top - ys.start * 256, right - xs.start * 256, bottom - ys.start * 256),
        Image.Resampling.BILINEAR,
    )
    height = np.asarray(raster)
    dy, dx = np.gradient(height)
    light = np.clip(.5 + (dx + dy) / 440, 0, 1)
    elevation = np.clip(height / 5200, 0, 1)
    low = np.array([9, 25, 40])
    high = np.array([44, 65, 80])
    rgb = low + (high - low) * elevation[..., None] + (light[..., None] - .5) * 55
    Image.fromarray(np.uint8(np.clip(rgb, 0, 255))).save(OUTPUT / "relief.webp", quality=91, method=6)
    return len(xs) * len(ys)


def make_feathered_imagery():
    with Image.open(IMAGERY) as original:
        image = original.convert("RGBA")
    width, height = image.size
    x = np.minimum(np.arange(width), np.arange(width)[::-1]) / (width * .12)
    y = np.minimum(np.arange(height), np.arange(height)[::-1]) / (height * .15)
    blend = np.clip(np.minimum(x[None, :], y[:, None]), 0, 1)
    opacity = np.uint8(255 * blend * blend * (3 - 2 * blend))
    image.putalpha(Image.fromarray(opacity))
    image.save(OUTPUT / "imagery.webp", quality=89, method=6)


if __name__ == "__main__":
    OUTPUT.mkdir(parents=True, exist_ok=True)
    tile_count = make_relief()
    make_feathered_imagery()
    print(f"{tile_count} Mapzen Terrarium tiles, offline relief plus alpha-feathered local imagery")
