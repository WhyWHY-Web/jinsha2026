from math import asinh, atan, floor, pi, sinh, tan
from pathlib import Path

import numpy as np
from PIL import Image

workspace = Path(__file__).resolve().parents[1]
original = next(path / "data" / "dem.bin" for path in workspace.parent.iterdir() if (path / "data" / "dem.bin").is_file())
west, south, east, north = 97.6, 25.9, 105.4, 32.5
heightmap = np.fromfile(original, dtype="<i2")
size = int(heightmap.size ** .5)
if size * size != heightmap.size:
    raise ValueError("DEM must be square")
heightmap = heightmap.reshape(size, size)
output = workspace / "data" / "terrain"

def tile_y(lat, scale):
    return (1 - asinh(tan(lat * pi / 180)) / pi) / 2 * scale

def sample(lon, lat):
    x = np.clip((lon - west) / (east - west) * size - .5, 0, size - 1)
    y = np.clip((north - lat) / (north - south) * size - .5, 0, size - 1)
    x0, y0 = x.astype(int), y.astype(int)
    x1, y1 = np.minimum(x0 + 1, size - 1), np.minimum(y0 + 1, size - 1)
    fx, fy = x - x0, y - y0
    return ((heightmap[y0, x0] * (1-fx) + heightmap[y0, x1]*fx) * (1-fy)
            + (heightmap[y1, x0] * (1-fx) + heightmap[y1, x1] * fx) * fy)

count = 0
for z in range(5, 10):
    scale = 2 ** z
    for x in range(floor((west + 180) / 360 * scale), floor((east + 180) / 360 * scale) + 1):
        for y in range(floor(tile_y(north, scale)), floor(tile_y(south, scale)) + 1):
            px = (np.arange(256) + .5) / 256
            lon = (x + px)[None, :] / scale * 360 - 180
            lat = np.degrees(np.arctan(np.sinh(pi * (1 - 2 * (y + px) / scale))))[:, None]
            elevation = sample(lon, lat)
            encoded = np.round((32768 + elevation) * 256).astype(np.uint32)
            rgb = np.stack([encoded >> 16, (encoded >> 8) & 255, encoded & 255], axis=2).astype(np.uint8)
            folder = output / str(z) / str(x)
            folder.mkdir(parents=True, exist_ok=True)
            Image.fromarray(rgb).save(folder / f"{y}.png", compress_level=3)
            count += 1
print(f"{count} terrain tiles derived from the {size} by {size} source DEM")
