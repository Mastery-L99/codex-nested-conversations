"""Build a reproducible source ZIP and SHA-256 from reviewed Git-tracked files."""
import argparse
import hashlib
import json
import re
import subprocess
import zipfile
from pathlib import Path

ALLOWED_FILES = {'.gitignore', 'README.md', 'README.zh-CN.md', 'LICENSE',
                 'NOTICE.md', 'package.json', 'package-lock.json', 'runtime-manifest.json'}
ALLOWED_DIRS = {'src', 'scripts', 'tests', 'docs', '.github'}
PRIVATE = re.compile(r'^(?:auth(?:\..*)?\.json|credentials.*|tokens.*|relations\.json|'
                     r'runtime-status\.json|ui-preferences\.json|runtime-options\.json|'
                     r'stop-request.*\.json|deployment\.json|release\.json|codex\.ico|'
                     r'\.env.*|\.npmrc)$', re.I)


def build(root, destination):
    root = root.resolve()
    version = json.loads((root / 'package.json').read_text(encoding='utf-8-sig'))['version']
    if not re.fullmatch(r'[0-9A-Za-z.+-]+', version):
        raise ValueError('Invalid release version')
    tracked = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z'])
    names = sorted(p for p in tracked.decode('utf-8').split('\0') if p)
    entries = []
    for name in names:
        relative = Path(name)
        source = root / relative
        if (relative.is_absolute() or '..' in relative.parts or
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
        entries.append((name, content))
    if not entries:
        raise ValueError('No tracked source files')
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / f'codex-nested-conversations-{version}-source.zip'
    # Fixed metadata and stored bytes make builds independent of file dates,
    # platform permissions, newline conversion and compression-library versions.
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_STORED) as output:
        for name, content in entries:
            info = zipfile.ZipInfo('codex-nested-conversations/' + name, (2026, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            output.writestr(info, content)
    with zipfile.ZipFile(archive) as check:
        if check.testzip() is not None or len(check.infolist()) != len(entries):
            raise ValueError('Archive integrity check failed')
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256.txt').write_text(
        digest + '  ' + archive.name + '\n', encoding='utf-8', newline='\n')
    return {'archive': str(archive), 'sha256': digest, 'files': len(entries)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, default=Path('dist'))
    args = parser.parse_args()
    print(json.dumps(build(Path(__file__).resolve().parent.parent, args.output_dir)))
