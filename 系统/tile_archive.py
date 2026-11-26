"""Read bundled offline raster tiles using the same paths as source tiles."""
from functools import lru_cache
from pathlib import Path
from zipfile import ZipFile


@lru_cache(maxsize=1)
def _open_tiles(path):
    return ZipFile(path)


def read_tile(data, path):
    archive = Path(data) / 'tiles.zip'
    if not archive.is_file():
        return None
    try:
        tile = Path(path).relative_to(data)
    except ValueError:
        return None
    if tile.parts[:1] != ('tiles',) or '..' in tile.parts or tile.suffix.lower() not in {'.jpg', '.jpeg', '.png'}:
        return None
    try:
        return _open_tiles(archive).read(tile.as_posix())
    except KeyError:
        return None
