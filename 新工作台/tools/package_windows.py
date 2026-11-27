"""Build and test the self-contained Windows x64 web workbench ZIP."""

import argparse
from hashlib import file_digest
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
from tempfile import TemporaryDirectory
import time
from urllib.request import ProxyHandler, build_opener
from zipfile import ZIP_DEFLATED, ZipFile


WORKBENCH = Path(__file__).resolve().parents[1]
REPOSITORY = WORKBENCH.parent
PACKAGE = "金沙江生态评估工作台"
HIDDEN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
REQUIRED_SOURCE_FILES = [
    "data/stations.json",
    "data/eco_services.json",
    "data/climate.json",
    "data/climate_annual.json",
    "data/climate_monthly.json",
    "data/hydro.json",
    "data/hydro_annual.json",
    "data/hydro_monthly.json",
    "data/dem.bin",
    "data/dem256.bin",
    "data/basin/jinsha_basin.geojson",
    "data/gee/annual.json",
    "data/rsei/rsei_all.json",
    "web/assets/img/satellite-3d.jpg",
    "web/assets/img/satellite-3d-hd.jpg",
]
WORKBENCH_DATA = {
    "ecology": ("rsei-support.json",),
    "engineering": ("catalog.json", "types.ts"),
    "flood": ("glofas-daily.json.gz", "types.ts"),
    "water-quality": ("reports.ts",),
    "map-context": ("relief.webp", "imagery.webp"),
}
ARCHIVE_DIRS = ("ghcn", "precipitation", "landcover", "scientific")
RIVER_FILES = ("river-mainstem.geojson", "rivers-major.geojson", "rivers.geojson", "rivers.source.json", "河网来源.md")


def execute(command, cwd=None, capture=False, env=None, timeout=None):
    return subprocess.run(
        [str(part) for part in command], cwd=cwd, check=True, env=env, timeout=timeout,
        creationflags=HIDDEN if capture else 0, capture_output=capture,
    )


def require_binary(path):
    if not path or not Path(path).is_file():
        raise FileNotFoundError(f"Missing executable: {path}")
    return Path(path).resolve()


def framework_csc():
    windows = Path(os.environ.get("WINDIR", "C:/Windows"))
    for architecture in ("Framework64", "Framework"):
        candidate = windows / "Microsoft.NET" / architecture / "v4.0.30319" / "csc.exe"
        if candidate.is_file():
            return candidate
    raise FileNotFoundError("The Windows .NET Framework C# compiler (csc.exe) was not found")


def compile_launcher(path):
    execute([
        framework_csc(), "/nologo", "/target:winexe", "/platform:x64", "/optimize+",
        "/codepage:65001", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll",
        f"/out:{path}", WORKBENCH / "tools" / "WindowsLauncher.cs",
    ])


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def validated_asset(path, base):
    resolved = path.resolve(strict=True)
    resolved.relative_to(base.resolve(strict=True))
    if not resolved.is_file() or not resolved.stat().st_size:
        raise ValueError(f"Missing or empty portable asset: {path}")
    return resolved


def add(archive, path, destination, base):
    archive.write(validated_asset(path, base), f"{PACKAGE}/{destination}")


def add_build(archive):
    build = WORKBENCH / "dist"
    for path in sorted(build.rglob("*")):
        if path.is_file():
            add(archive, path, "app/dist/" + path.relative_to(build).as_posix(), build)
    for path in sorted((WORKBENCH / "server").glob("*.ts")):
        add(archive, path, "app/server/" + path.name, WORKBENCH / "server")
    archive.writestr(f"{PACKAGE}/app/package.json", '{"type":"module","private":true}\n')


def add_data(archive):
    data = WORKBENCH / "data"
    for folder, names in WORKBENCH_DATA.items():
        for name in names:
            relative = f"{folder}/{name}"
            add(archive, data / relative, f"app/data/{relative}", data)
    for name in RIVER_FILES:
        add(archive, data / name, f"app/data/{name}", data)
    for folder in ARCHIVE_DIRS:
        manifest_path = data / folder / "manifest.json"
        manifest = read_json(manifest_path)
        filename = manifest["file"]
        if Path(filename).name != filename or not filename.endswith(".csv.gz"):
            raise ValueError(f"Invalid archive manifest filename at {manifest_path}")
        add(archive, manifest_path, f"app/data/{folder}/manifest.json", data)
        add(archive, data / folder / filename, f"app/data/{folder}/{filename}", data)
    add(archive, data / "scientific/profiles.json", "app/data/scientific/profiles.json", data)

    for folder, zooms in (("terrain", range(5, 10)), ("regional-dem", range(5, 8))):
        for zoom in zooms:
            tiles = sorted((data / folder / str(zoom)).glob("*/*.png"))
            if not tiles:
                raise ValueError(f"Missing offline terrain tiles at level {zoom} in {folder}")
            for tile in tiles:
                relative = tile.relative_to(data).as_posix()
                add(archive, tile, f"app/data/{relative}", data)
    add(archive, data / "regional-dem/complete", "app/data/regional-dem/complete", data)


def add_sources(archive, source):
    for relative in REQUIRED_SOURCE_FILES:
        add(archive, source / relative, "sources/" + relative, source)
    tiles = sorted((source / "data/tiles_dem/10").glob("*/*.png"))
    if not tiles:
        raise ValueError("Missing original zoom-10 offline terrain tiles")
    for tile in tiles:
        relative = tile.relative_to(source).as_posix()
        add(archive, tile, f"sources/{relative}", source)


def add_licenses(archive, node):
    add(archive, node.parent / "LICENSE", "licenses/Node.js.txt", node.parent)
    packages = read_json(WORKBENCH / "package-lock.json")["packages"]
    for relative, details in packages.items():
        if not relative or details.get("dev"):
            continue
        directory = WORKBENCH / relative
        destination = "licenses/npm/" + relative.removeprefix("node_modules/")
        files = sorted(path for path in directory.glob("*") if path.is_file()
                       and path.name.upper().startswith(("LICENSE", "LICENCE", "COPYING", "NOTICE")))
        for path in files:
            add(archive, path, f"{destination}/{path.name}", directory)


def write_package(zip_path, launcher, node, source):
    with ZipFile(zip_path, "w", compression=ZIP_DEFLATED, compresslevel=3) as archive:
        add(archive, launcher, PACKAGE + ".exe", launcher.parent)
        add(archive, WORKBENCH / "tools/portable-readme.txt", "使用说明.txt", WORKBENCH)
        add(archive, node, "runtime/node.exe", node.parent)
        add_build(archive)
        add_data(archive)
        add_sources(archive, source)
        add_licenses(archive, node)
        add(archive, WORKBENCH / "README.md", "来源与项目说明.md", WORKBENCH)


def local_url(base, route):
    request = build_opener(ProxyHandler({}))
    with request.open(base + route, timeout=5) as response:
        return response.read()


def exercise_portable_data(root, state):
    """Start the packaged service directly to verify the data-dependent entry points."""
    with socket.socket() as available:
        available.bind(("127.0.0.1", 0))
        port = available.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    env = dict(os.environ)
    for inherited in ("NODE_OPTIONS", "NODE_PATH", "JINSHA_WORKBENCH_ORIGIN"):
        env.pop(inherited, None)
    env.update(
        JINSHA_WORKBENCH_SOURCE=str(root / "sources"), JINSHA_WORKBENCH_PORT=str(port),
        JINSHA_WORKBENCH_STATE=str(state / "service-test.sqlite"), JINSHA_AGENT_MODEL="off",
    )
    with subprocess.Popen(
        [str(root / "runtime/node.exe"), "--disable-warning=ExperimentalWarning", "server/index.ts"],
        cwd=root / "app", env=env, creationflags=HIDDEN, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    ) as service:
        try:
            for _ in range(100):
                if service.poll() is not None:
                    raise RuntimeError(service.stderr.read().decode("utf-8", errors="replace"))
                try:
                    if json.loads(local_url(base, "/api/health"))["ok"]:
                        break
                except OSError:
                    time.sleep(.1)
            else:
                raise TimeoutError("The extracted package failed its local health check")
            requirements = {
                "/api/dashboard": ("stations", 20),
                "/api/ecology/assess?year=2025": ("metricDefinitions", 18),
                "/api/layers/rsei?year=2025": ("values", 27),
                "/api/engineering": ("projects", 4),
                "/api/water-quality": ("sections", 8),
                "/api/flood/replay": ("events", 8),
                "/api/scientific": ("datasets", None),
            }
            for route, (key, minimum) in requirements.items():
                result = json.loads(local_url(base, route))
                if minimum is None:
                    if not result:
                        raise RuntimeError(f"Empty packaged response: {route}")
                elif len(result.get(key, [])) < minimum:
                    raise RuntimeError(f"Incomplete packaged data at {route}")
            catalog = json.loads(local_url(base, "/api/catalog"))["datasets"]
            queryable = [item["id"] for item in catalog if item.get("queryable")]
            if len(queryable) < 4:
                raise RuntimeError("Packaged archive index lacks public datasets")
            for identifier in queryable:
                result = json.loads(local_url(base, f"/api/archives/{identifier}?limit=1"))
                if not result.get("rows"):
                    raise RuntimeError(f"Unable to read packaged archive {identifier}")
            local_png = next((root / "app/data/terrain/5").glob("*/*.png"))
            route = "/assets/source/" + local_png.relative_to(root / "app/data").as_posix()
            if not local_url(base, route).startswith(b"\x89PNG"):
                raise RuntimeError("Missing offline terrain response")
            if not local_url(base, "/assets/source/context-imagery.webp").startswith(b"RIFF"):
                raise RuntimeError("Missing offline satellite response")
        finally:
            if service.poll() is None:
                service.terminate()
            service.communicate(timeout=5)


def smoke(zip_path, scratch):
    extract = scratch / "便携测试 路径"
    state = scratch / "测试用户数据"
    with ZipFile(zip_path) as archive:
        archive.extractall(extract)
    root = extract / PACKAGE
    state.mkdir(parents=True)
    env = dict(os.environ, JINSHA_LAUNCHER_TEST_STATE=str(state))
    with socket.socket() as busy:
        try:
            busy.bind(("127.0.0.1", 8732))
            busy.listen()
        except OSError:
            # The existing service already provides the occupied default port.
            pass
        result = subprocess.run(
            [str(root / (PACKAGE + ".exe")), "--self-test"], cwd=extract, env=env,
            creationflags=HIDDEN, timeout=45,
        )
    if result.returncode:
        error = state / "self-test-error.txt"
        raise RuntimeError(error.read_text(encoding="utf-8-sig") if error.exists() else "Windows launch self-test failed")
    selected = (state / "self-test-result.txt").read_text(encoding="utf-8-sig")
    if not selected.startswith("http://127.0.0.1:") or selected.endswith(":8732"):
        raise RuntimeError(f"Fallback port check failed: {selected}")
    if not (state / "ecology-workflow.sqlite").is_file():
        raise RuntimeError("No per-user journal was created during launch")
    exercise_portable_data(root, state)
    print(f"Validated the compiled launcher in a fresh path. Its fallback address was {selected}")


def file_hash(path):
    with path.open("rb") as stream:
        return file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", type=Path, default=shutil.which("node.exe"), help="Node.js 24 x64 node.exe with sibling LICENSE")
    parser.add_argument("--source", type=Path, default=REPOSITORY / "系统", help="Path to the selected original archive")
    parser.add_argument("--output", type=Path, default=REPOSITORY / "dist/Jinsha-Workbench-Windows-x64.zip")
    parser.add_argument("--skip-build", action="store_true", help="Use the current, already built workbench/dist")
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("Use Windows to compile and test this x64 package")
    node = require_binary(args.node)
    version = execute([node, "-p", "JSON.stringify([process.platform,process.arch,process.versions.node])"], capture=True)
    platform, arch, release = json.loads(version.stdout)
    if platform != "win32" or arch != "x64" or int(release.split(".")[0]) != 24:
        parser.error("Select a Windows x64 Node.js 24 runtime")
    execute([node, "-e", "require('node:sqlite').DatabaseSync"], capture=True)
    if not args.skip_build:
        npm = require_binary(shutil.which("npm.cmd"))
        execute([npm, "run", "build"], cwd=WORKBENCH)
    validated_asset(WORKBENCH / "dist/index.html", WORKBENCH / "dist")
    output = args.output.resolve()
    if output.suffix.lower() != ".zip":
        parser.error("--output must be a ZIP file")
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="jinsha-package-", dir=output.parent) as directory:
        scratch = Path(directory)
        launcher = scratch / (PACKAGE + ".exe")
        archive = scratch / "portable.zip"
        compile_launcher(launcher)
        write_package(archive, launcher, node, args.source.resolve())
        smoke(archive, scratch)
        archive.replace(output)
    checksum = file_hash(output)
    output.with_suffix(".zip.sha256").write_text(f"{checksum}  {output.name}\n", encoding="ascii")
    print(f"{output}\n{output.stat().st_size:,} bytes · SHA-256 {checksum}")


if __name__ == "__main__":
    main()
