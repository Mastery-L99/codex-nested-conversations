"""Install the pinned Windows preview into the current user's existing Codex client."""
import argparse
import contextlib
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

VERSION = "0.3.0-preview.6"
TAG = "v" + VERSION
RELEASE = "https://github.com/Mastery-L99/codex-nested-conversations/releases/download/" + TAG
MARKET = "codex-nested-local"
PLUGIN = "codex-nested-conversations"
PLUGIN_ID = PLUGIN + "@" + MARKET
MAX_BYTES = 32 * 1024 * 1024
TESTED_DESKTOP = "26.1027.3384.0"


def windows_path(path):
    value = str(path.absolute())
    if value.startswith("\\\\?\\"):
        return path
    return Path("\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value)


def checked_path(path):
    path = Path(os.path.abspath(path))
    for entry in (*reversed(path.parents), path):
        try:
            attributes = windows_path(entry).lstat().st_file_attributes
        except FileNotFoundError:
            continue
        if attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError(f"Refusing a linked installation path: {entry}")
    return path


def asset_bytes(name, asset_dir):
    if asset_dir:
        path = asset_dir / name
        if path.stat().st_size > MAX_BYTES:
            raise ValueError(f"Asset is too large: {name}")
        return path.read_bytes()
    request = urllib.request.Request(f"{RELEASE}/{name}", headers={"User-Agent": "Codex-Nested-Conversations-Installer"})
    with urllib.request.urlopen(request, timeout=45) as response:
        if not response.geturl().startswith("https://"):
            raise ValueError("Release download was redirected away from HTTPS")
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError(f"Asset is too large: {name}")
    return data


def release_files(name, asset_dir):
    checksum = asset_bytes(name + ".sha256.txt", asset_dir).decode("ascii").strip()
    match = re.fullmatch(r"([0-9a-f]{64})  " + re.escape(name), checksum)
    data = asset_bytes(name, asset_dir)
    if not match or hashlib.sha256(data).hexdigest() != match[1]:
        raise ValueError(f"SHA-256 did not match the release checksum: {name}")
    files = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        if len(infos) > 2048 or sum(info.file_size for info in infos) > MAX_BYTES:
            raise ValueError("Unexpected archive size")
        for info in infos:
            entry = info.filename
            parts = entry.split("/")
            if (info.is_dir() or PureWindowsPath(entry).drive or not entry.isascii() or
                    any(not re.fullmatch(r"[A-Za-z0-9_.-]+", part) or part.endswith(".") or
                        PureWindowsPath(part).is_reserved() for part in parts) or
                    stat.S_ISLNK(info.external_attr >> 16) or entry.lower() in files):
                raise ValueError(f"Unsafe or repeated archive entry: {entry}")
            files[entry.lower()] = (PurePosixPath(entry), archive.read(info))
    return files


def extract(files, destination):
    for entry, data in files.values():
        output = windows_path(destination.joinpath(*entry.parts))
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("xb") as stream:
            stream.write(data)


def verify_marketplace(files, target):
    present = set()
    target = windows_path(target)
    for directory, children, names in os.walk(target):
        for name in children + names:
            checked_path(Path(directory) / name)
        for name in names:
            path = Path(directory) / name
            key = path.relative_to(target).as_posix().lower()
            if key not in files or path.read_bytes() != files[key][1]:
                raise ValueError(f"Existing plugin files differ. Nothing was overwritten: {path}")
            present.add(key)
    if present != set(files):
        raise ValueError(f"The existing marketplace is incomplete. Nothing was overwritten: {target}")


def ps_command(command):
    result = subprocess.run([powershell(), "-NoProfile", "-NonInteractive", "-Command",
                             "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; " + command],
                            check=True, capture_output=True, encoding="utf-8")
    return result.stdout.strip()


def powershell():
    return str(Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe")


def official_cli():
    raw = ps_command("$p=@(Get-AppxPackage -Name OpenAI.Codex); "
                     "if($p.Count -ne 1 -or $p[0].PackageFamilyName -cne 'OpenAI.Codex_2p2nqsd0c76g0'){throw 'Official Codex desktop app not found'}; "
                     "@{exe=(Join-Path $p[0].InstallLocation 'app/resources/codex.exe');version=[string]$p[0].Version} | ConvertTo-Json -Compress")
    package = json.loads(raw)
    exe = Path(package["exe"])
    if not exe.is_absolute() or not exe.is_file():
        raise ValueError("The official Windows Codex desktop CLI is not installed.")
    return str(exe), package["version"]


def cli_json(cli, *args):
    value = subprocess.run([cli, "plugin", *args, "--json"], check=True, capture_output=True, encoding="utf-8")
    return json.loads(value.stdout)


def same_path(left, right):
    # The official CLI can return Windows verbatim paths for local marketplace sources.
    if not isinstance(left, str):
        return False
    value = "\\\\" + left[8:] if left.startswith("\\\\?\\UNC\\") else left.removeprefix("\\\\?\\")
    return Path(value).is_absolute() and Path(value).resolve() == Path(right).resolve()


def validate_identity(files, key, name):
    metadata = json.loads(files[key][1].decode("utf-8-sig"))
    if metadata.get("name") != name or metadata.get("version") != VERSION:
        raise ValueError("Release package identity or version does not match this installer")


def existing_full_install(target):
    if not target.exists():
        return False
    marker = target / ".cncc-install.json"
    if marker.is_file():
        metadata = json.loads(checked_path(marker).read_text(encoding="utf-8-sig"))
        if (metadata.get("project") == PLUGIN and metadata.get("state") == "installed" and
                metadata.get("version") == VERSION and same_path(metadata.get("installDir", ""), target) and
                all(checked_path(target / rel).is_file() for rel in ("scripts/Start.ps1", "app/runtime-main.cjs", "app/nested-ui.js"))):
            return True
    raise ValueError(f"A different or partial sidebar installation exists at {target}. The installer preserves it. "
                     "Use its documented uninstaller before explicitly replacing it.")


def recycle_stage(path):
    # Only our freshly created staging directory. Never remove an existing release or user data.
    env = dict(os.environ, CNCC_INSTALL_STAGE=str(path))
    command = ("$ErrorActionPreference='Stop'; Add-Type -AssemblyName Microsoft.VisualBasic; "
               "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:CNCC_INSTALL_STAGE,"
               "[Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,"
               "[Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin,"
               "[Microsoft.VisualBasic.FileIO.UICancelOption]::ThrowException)")
    result = subprocess.run([powershell(), "-NoProfile", "-NonInteractive", "-Command", command], env=env)
    if result.returncode:
        print(f"Staging directory retained: {path}", file=sys.stderr)


@contextlib.contextmanager
def staging(parent):
    path = Path(tempfile.mkdtemp(prefix="cncc-setup-", dir=parent))
    try:
        yield path
    finally:
        if path.exists():
            recycle_stage(path)


@contextlib.contextmanager
def install_lock():
    # Windows releases this process-local handle even if installation is interrupted.
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateMutexW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    ctypes.set_last_error(0)
    handle = kernel.CreateMutexW(None, False, "Local\\CodexNestedConversationsPreviewInstall")
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
            raise ValueError("Another preview installation is running. Please wait for it to finish.")
        yield
    finally:
        kernel.CloseHandle(handle)


def project_listing(cli):
    try:
        listing = cli_json(cli, "list", "--marketplace", MARKET, "--available")
    except subprocess.CalledProcessError:
        raise ValueError(f"The official CLI could not read {MARKET}. No marketplace registration was changed.") from None
    if not isinstance(listing.get("installed"), list) or not isinstance(listing.get("available"), list):
        raise ValueError("Unsupported plugin-list response. No marketplace registration was changed.")
    return listing


def installed_rows(cli):
    return [row for row in project_listing(cli)["installed"] if row["pluginId"] == PLUGIN_ID]


def registered_marketplace(cli, target):
    listing = project_listing(cli)
    rows = listing["installed"] + listing["available"]
    if rows:
        # Verify every returned row's marketplace identity; a plugin's own directory is not the market root.
        matches = all(row.get("marketplaceName") == MARKET and isinstance(row.get("marketplaceSource"), dict) and
                      row["marketplaceSource"].get("sourceType") == "local" and
                      same_path(row["marketplaceSource"].get("source"), target) for row in rows)
    else:
        # A targeted list also returns empty for a registered but empty marketplace.
        # Only a successful catalog listing can prove the name is free to register.
        try:
            markets = cli_json(cli, "marketplace", "list")["marketplaces"]
        except subprocess.CalledProcessError:
            raise ValueError(f"Cannot confirm that {MARKET} is unregistered. The official catalog listing failed. "
                             "Existing registrations were preserved.") from None
        if not isinstance(markets, list):
            raise ValueError("Unsupported marketplace-list response. Existing registrations were preserved.")
        existing = [row for row in markets if row["name"] == MARKET]
        if not existing:
            return False
        matches = len(existing) == 1 and same_path(existing[0]["root"], target)
    if not matches:
        raise ValueError(f"The marketplace {MARKET} is already registered with a different or unidentified source. "
                         "It was preserved. Upgrade through its existing registered source.")
    return True


def report_desktop(version):
    print(f"Desktop package: {version}; verified desktop package: {TESTED_DESKTOP}.")
    if version != TESTED_DESKTOP:
        print("This desktop version differs from the tested one. Open the installed panel and test its tree on this version.")


def check():
    if os.name != "nt" or sys.version_info < (3, 10):
        raise ValueError("Windows and Python 3.10+ are required.")
    cli, version = official_cli()
    report_desktop(version)
    rows = installed_rows(cli)
    if rows:
        print(f"{PLUGIN_ID}: version={rows[0]['version']}; enabled={rows[0]['enabled']}.")
    else:
        print(f"{PLUGIN_ID}: not installed.")
    print("This read-only check reports plugin registration. Open the panel to verify the GUI.")


def install(args):
    if os.name != "nt" or sys.version_info < (3, 10):
        raise ValueError("Windows and Python 3.10+ are required.")
    node = shutil.which("node.exe")
    if not node or int(subprocess.check_output([node, "-p", "process.versions.node.split('.')[0]"], text=True)) < 22:
        raise ValueError("Node.js 22+ on PATH is required.")
    python = os.environ.get("CNCC_PYTHON") or shutil.which("python.exe")
    if not python or "\\microsoft\\windowsapps\\" in python.lower():
        raise ValueError("The plugin needs Python 3.10+ as python.exe on PATH or CNCC_PYTHON.")
    subprocess.run([python, "-c", "import sqlite3,sys; sys.exit(0 if sys.version_info >= (3,10) else 1)"], check=True)
    cli, desktop_version = official_cli()
    report_desktop(desktop_version)
    full_root = checked_path(Path(os.environ["LOCALAPPDATA"]) / "CodexNestedConversations")
    need_full = args.full and not existing_full_install(full_root)
    npm = shutil.which("npm.cmd") if need_full else None
    if need_full and not npm:
        raise ValueError("The full sidebar install needs npm.cmd on PATH.")
    version_root = checked_path(Path(os.environ["LOCALAPPDATA"]) / "CodexConversationManager" / "releases" / TAG)
    target = checked_path(version_root / "marketplace")
    registered_marketplace(cli, target)
    market_files = release_files(f"codex-conversation-manager-{VERSION}-marketplace.zip", args.assets_dir)
    validate_identity(market_files, "plugin/plugin.json", PLUGIN)
    catalog = json.loads(market_files[".agents/plugins/marketplace.json"][1].decode("utf-8-sig"))
    if (catalog.get("name") != MARKET or len(catalog.get("plugins", [])) != 1 or
            catalog["plugins"][0].get("name") != PLUGIN or catalog["plugins"][0].get("source") != {"source":"local", "path":"./plugin"}):
        raise ValueError("Unexpected marketplace identity or plugin source")
    source_files = None
    if need_full:
        source_files = release_files(f"{PLUGIN}-{VERSION}-source.zip", args.assets_dir)
        validate_identity(source_files, PLUGIN + "/package.json", PLUGIN)
        if any(entry.parts[0] != PLUGIN for entry, _ in source_files.values()):
            raise ValueError("Unexpected source archive root")
    if target.exists():
        verify_marketplace(market_files, target)
    version_root.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        with staging(version_root) as extracted:
            extract(market_files, extracted)
            extracted.rename(target)
    if source_files is not None:
        with staging(checked_path(Path(tempfile.gettempdir()))) as stage:
            extract(source_files, stage)
            source = stage / PLUGIN
            subprocess.run([npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=source, check=True)
            command = [powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
                       str(source / "scripts/install.ps1"), "-ReuseData"]
            if args.no_shortcut:
                command.append("-NoShortcut")
            subprocess.run(command, check=True)
            if not existing_full_install(full_root):
                raise ValueError("The sidebar installer did not report a complete installation.")
    # Recheck the source after staging or running npm. External tools may also change registration.
    if not registered_marketplace(cli, target):
        cli_json(cli, "marketplace", "add", str(target))
    matches = installed_rows(cli)
    if not matches:
        added = cli_json(cli, "add", PLUGIN_ID)
        if added.get("pluginId") != PLUGIN_ID or added.get("version") != VERSION:
            raise ValueError("The official CLI did not install the expected plugin version. Registration was retained for retry.")
    matches = installed_rows(cli)
    if len(matches) != 1 or matches[0]["version"] != VERSION or not matches[0]["installed"]:
        raise ValueError("The installed version differs. The existing plugin was preserved; check it in Codex plugin settings.")
    enabled = matches[0]["enabled"]
    print(f"Installed {PLUGIN_ID} {VERSION}. Enabled: {enabled}.")
    print("Open Codex using the original app icon and open the plugin. If it was already running, reopen it to reload the plugin.")
    if not enabled:
        print("The existing disabled setting was preserved. Enable the plugin in Codex when you want to use it.")
    if args.full:
        print(f"Sidebar adapter installed. Start it with: {full_root / 'scripts/Start.ps1'}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full", action="store_true", help="also install the optional original-sidebar desktop launcher")
    parser.add_argument("--no-shortcut", action="store_true", help="skip the optional Full install desktop shortcut")
    parser.add_argument("--assets-dir", type=Path, help="use previously downloaded ZIPs and checksums from this directory")
    parser.add_argument("--check", action="store_true", help="only report desktop and installed plugin versions; no downloads or install")
    try:
        args = parser.parse_args()
        if args.check:
            check()
        else:
            if os.name != "nt":
                raise ValueError("This preview requires Windows.")
            with install_lock():
                install(args)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print("Installation stopped: " + str(error), file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(str(error.stderr).strip()[:500], file=sys.stderr)
        sys.exit(1)
