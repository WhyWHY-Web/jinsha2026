"""Build a standalone Windows executable using the current source and data."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from zipfile import ZIP_STORED, ZipFile

BASE = Path(__file__).resolve().parent
DATA = BASE / 'data'
WORK = BASE / '_pybuild'
DIST = BASE / '_dist'
PRIVATE_FILES = {'users.json', 'public_url.txt', '.secret', '.power_cache.json',
                 'public.pg_stat_statements.csv.gz', 'public.pg_stat_statements_info.csv.gz'}
PRIVATE_SUFFIXES = {'.log', '.sqlite', '.sqlite3', '.db', '.pem', '.key'}
OPTIONAL_DIRECTORIES = {'tiles', 'tiles_dem', 'sql'}


def copy_data(destination, full):
    """Copy fresh seed data while keeping credentials and live runtime state local."""
    def ignored(directory, names):
        directory = Path(directory)
        skip = set()
        for name in names:
            path = directory / name
            suffix = path.suffix.lower()
            if name.startswith('.') or name in PRIVATE_FILES or name.startswith('audit.log'):
                skip.add(name)
            elif suffix in PRIVATE_SUFFIXES or name.endswith(('.sqlite3-wal', '.sqlite3-shm')):
                skip.add(name)
            elif name == 'tiles' or (not full and (name in OPTIONAL_DIRECTORIES or suffix in {'.tif', '.tiff'})):
                skip.add(name)
        return skip

    shutil.copytree(DATA, destination, ignore=ignored)
    if full:
        # A single archive avoids thousands of small file extractions at launch.
        with ZipFile(destination / 'tiles.zip', 'w', compression=ZIP_STORED) as archive:
            for path in (DATA / 'tiles').rglob('*'):
                if path.is_file() and path.suffix.lower() in {'.jpg', '.jpeg', '.png'}:
                    archive.write(path, path.relative_to(DATA).as_posix())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--full', action='store_true', help='Include all local map tiles and research data')
    parser.add_argument('--output-dir', type=Path, default=DIST, help='Directory for the finished executable')
    args = parser.parse_args()
    output_dir = args.output_dir.resolve()
    name = '金沙江生态评估_完整版' if args.full else '金沙江生态评估'
    if not (DATA / 'dem.bin').is_file():
        parser.error('data/dem.bin is required for the offline terrain.')
    if args.full and not (DATA / 'tiles').is_dir():
        parser.error('data/tiles is required for the full build.')

    WORK.mkdir(exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='jinsha-build-', dir=WORK) as staging:
        staging = Path(staging)
        data = staging / 'data'
        copy_data(data, args.full)
        command = [
            sys.executable, '-m', 'PyInstaller',
            '--onefile', '--name', name, '--noconfirm',
            '--icon', str(BASE / 'tools' / 'app.ico'),
            '--add-data', f'{BASE / "web"}{os.pathsep}web',
            '--add-data', f'{data}{os.pathsep}data',
            '--collect-submodules', 'uvicorn.loops',
            '--collect-submodules', 'uvicorn.protocols',
            '--collect-submodules', 'uvicorn.lifespan',
            '--exclude-module', 'PIL',
            '--distpath', str(output_dir), '--workpath', str(WORK / output_dir.name),
            '--specpath', str(staging), str(BASE / 'boot.py'),
        ]
        subprocess.run(command, cwd=BASE, check=True)
    executable = output_dir / (name + '.exe')
    print(f'[build] {executable} ({executable.stat().st_size:,} bytes)', flush=True)


if __name__ == '__main__':
    main()
