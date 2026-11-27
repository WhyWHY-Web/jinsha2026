"""Export the NASA Blue Marble view for the public 3D map."""

import argparse
import io
import math
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

import numpy as np
from PIL import Image


def image_url():
    radius = 6_378_137
    meter_x = lambda degrees: math.radians(degrees) * radius
    meter_y = lambda degrees: math.asinh(math.tan(math.radians(degrees))) * radius
    projected = (meter_x(97.6), meter_y(25.9), meter_x(105.4), meter_y(32.5))
    parameters = {"service": "WMS", "request": "GetMap", "version": "1.1.1",
                  "layers": "BlueMarble_ShadedRelief_Bathymetry", "srs": "EPSG:3857",
                  "bbox": ",".join(map(str, projected)), "width": 2048, "height": 1960,
                  "format": "image/jpeg"}
    return "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?" + urlencode(parameters)


def feather(content, destination):
    with Image.open(io.BytesIO(content)) as source:
        if source.size != (2048, 1960):
            raise ValueError("Unexpected NASA WMS image size")
        image = source.convert("RGBA")
    width, height = image.size
    x = np.arange(width)
    y = np.arange(height)
    edges = np.minimum(np.minimum(x, width - x - 1)[None, :] / (width * .08),
                       np.minimum(y, height - y - 1)[:, None] / (height * .115))
    ratio = np.clip(edges, 0, 1)
    image.putalpha(Image.fromarray(np.round(255 * ratio * ratio * (3 - 2 * ratio)).astype(np.uint8)))
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, "WEBP", quality=92, method=4)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--downloaded", type=Path, help="Reuse the exact WMS JPEG response")
    arguments = parser.parse_args()
    if arguments.downloaded:
        payload = arguments.downloaded.read_bytes()
    else:
        with urlopen(image_url(), timeout=30) as response:
            payload = response.read()
    output = Path(__file__).resolve().parents[1] / "data" / "public-map" / "blue-marble.webp"
    feather(payload, output)
    print(output)
