"""Build reproducible source and installable archive-marketplace ZIPs and checksums."""
import argparse
import hashlib
import json
import re
import subprocess
import zipfile
from pathlib import Path

ALLOWED_FILES = {'.gitignore', 'README.md', 'README.zh-CN.md', 'LICENSE',
                 'NOTICE.md', 'package.json', 'package-lock.json', 'runtime-manifest.json', 'plugin.json', 'mcp.json'}
ALLOWED_DIRS = {'src', 'scripts', 'tests', 'docs', '.github', '.agents'}
PRIVATE = re.compile(r'^(?:auth(?:\..*)?\.json|credentials.*|tokens.*|relations\.json|'
                     r'(?:native-)?runtime-status\.json|module-state\.json|ui-preferences\.json|runtime-options\.json|'
                     r'stop-request.*\.json|deployment\.json|release\.json|codex\.ico|'
                     r'\.env.*|\.npmrc)$', re.I)


def tracked_sources(root):
    tracked = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z'])
    names = sorted(p for p in tracked.decode('utf-8').split('\0') if p)
    entries = {}
    for name in names:
        relative = Path(name)
        source = root / relative
        if (relative.is_absolute() or '..' in relative.parts or
                (relative.parts[0] == '.agents' and name != '.agents/plugins/marketplace.json') or
                (len(relative.parts) == 1 and name not in ALLOWED_FILES) or
                (len(relative.parts) > 1 and relative.parts[0] not in ALLOWED_DIRS) or
                PRIVATE.fullmatch(relative.name) or
                re.search(r'\.(?:sqlite(?:3)?|db|lnk|log)(?:-.*)?$', name, re.I) or
                source.is_symlink() or not source.is_file() or
                not source.resolve().is_relative_to(root)):
            raise ValueError('Excluded source entry: ' + name)
        content = source.read_bytes()
        if len(content) > 2 * 1024 * 1024 or b'\0' in content:
            raise ValueError('Binary or oversized source entry: ' + name)
        content.decode('utf-8')
        entries[name] = content
    if not entries:
        raise ValueError('No tracked source files')
    return entries


def marketplace_sources(root, sources, version):
    # Use the same validated package contents as the standalone plugin builder.
    command = """
        const {collectPluginSources} = require('./scripts/build-plugin.cjs');
        const {createHash} = require('node:crypto');
        collectPluginSources(process.cwd()).then(({entries}) => console.log(JSON.stringify(
          entries.map(({relative,bytes}) => [relative,createHash('sha256').update(bytes).digest('hex')])
        ))).catch(error => { console.error(error.message); process.exitCode = 1; });
    """
    reviewed = json.loads(subprocess.check_output(['node', '-e', command], cwd=root))
    plugin = json.loads(sources['plugin.json'].decode('utf-8-sig'))
    if plugin['version'] != version:
        raise ValueError('Plugin and release versions differ')
    catalog_path = '.agents/plugins/marketplace.json'
    catalog = json.loads(sources[catalog_path].decode('utf-8-sig'))
    records = catalog.get('plugins', [])
    if (len(records) != 1 or records[0]['name'] != plugin['name'] or
            records[0]['source'] != {'source': 'local', 'path': './'}):
        raise ValueError('Marketplace must identify the reviewed local plugin')
    records[0]['source']['path'] = './plugin'
    entries = {catalog_path: (json.dumps(catalog, ensure_ascii=False, indent=2) + '\n').encode('utf-8')}
    for name, digest in reviewed:
        content = sources[name]
        if hashlib.sha256(content).hexdigest() != digest:
            raise ValueError('Source differs from the validated plugin: ' + name)
        entries['plugin/' + name] = content
    return entries


def write_archive(archive, entries):
    # Fixed metadata, ordering and text line endings avoid differences across
    # checkout configurations and operating systems. All inputs are UTF-8 text.
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as output:
        for name, content in sorted(entries.items()):
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            output.writestr(info, content.replace(b'\r\n', b'\n'))
    with zipfile.ZipFile(archive) as check:
        if check.testzip() is not None or len(check.infolist()) != len(entries):
            raise ValueError('Archive integrity check failed')
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256.txt').write_text(
        digest + '  ' + archive.name + '\n', encoding='utf-8', newline='\n')
    return {'archive': str(archive), 'sha256': digest, 'files': len(entries)}


def build(root, destination):
    root = root.resolve()
    sources = tracked_sources(root)
    version = json.loads(sources['package.json'].decode('utf-8-sig'))['version']
    if not re.fullmatch(r'[0-9A-Za-z.+-]+', version):
        raise ValueError('Invalid release version')
    marketplace = marketplace_sources(root, sources, version)
    destination.mkdir(parents=True, exist_ok=True)
    source = write_archive(destination / f'codex-nested-conversations-{version}-source.zip',
                           {'codex-nested-conversations/' + name: data for name, data in sources.items()})
    source['marketplace'] = write_archive(destination / f'codex-conversation-manager-{version}-marketplace.zip',
                                          marketplace)
    return source


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=Path('dist'))
    args = parser.parse_args()
    print(json.dumps(build(Path(__file__).resolve().parent.parent, args.output_dir)))
