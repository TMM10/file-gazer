"""Build a clean consumer ZIP from an explicit runtime-only allowlist."""
import argparse
import hashlib
import json
import shutil
import zipfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--executable-source', default='FileGazer.exe')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    manifest_file = root / 'release' / 'package-manifest.json'
    names = [
        'FileGazer.exe', 'README.md', 'ui/index.html', 'ui/app.js', 'ui/app.css',
        'ui/bubble-camera.js', 'ui/bubble-layout.js', 'ui/favicon.svg',
        'ui/file-gazer.ico', 'ui/star.svg', 'ui/vendor/d3-hierarchy.min.js',
        'ui/vendor/d3-hierarchy-LICENSE.txt',
    ]
    executable = (root / args.executable_source).resolve()
    if not executable.is_relative_to(root) or not executable.is_file():
        raise ValueError('The executable source must be a file inside this project.')
    stage = root / 'release' / 'FileGazer-Consumer'
    archive = root / 'FileGazer-Portable.zip'
    backup = root / 'legacy' / 'FileGazer-before-consumer-package.zip'
    if archive.exists() and not backup.exists():
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(archive, backup)
    records = []
    for name in names:
        if Path(name).is_absolute() or '..' in Path(name).parts:
            raise ValueError('Unsafe manifest path: ' + name)
        if Path(name).name.startswith('game-libraries') and Path(name).suffix == '.json':
            raise ValueError('Personal library settings cannot be packaged: ' + name)
        source = executable if name == 'FileGazer.exe' else root / 'release' / 'README-portable.md' if name == 'README.md' else root / name
        target = stage / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        data = target.read_bytes()
        records.append({'Path': name.replace('/', '\\'), 'Bytes': len(data),
                        'SHA256': hashlib.sha256(data).hexdigest().upper()})
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zipped:
        for name in names:
            zipped.write(stage / name, 'FileGazer/' + name)
    with zipfile.ZipFile(archive) as zipped:
        assert set(zipped.namelist()) == {'FileGazer/' + name for name in names}
        assert zipped.testzip() is None
        for row in records:
            name = 'FileGazer/' + row['Path'].replace('\\', '/')
            data = zipped.read(name)
            assert len(data) == row['Bytes']
            assert hashlib.sha256(data).hexdigest().upper() == row['SHA256']
    assert {p.relative_to(stage).as_posix() for p in stage.rglob('*') if p.is_file()} == set(names)
    manifest_file.write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'archive': str(archive), 'files': len(records),
                      'bytes': archive.stat().st_size,
                      'SHA256': hashlib.sha256(archive.read_bytes()).hexdigest().upper()}))


if __name__ == '__main__':
    main()
