#!/usr/bin/env python3
"""Build a clean Chrome Web Store ZIP from an explicit runtime allowlist."""
from pathlib import Path
import hashlib
import json
import re
import struct
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    'manifest.json', 'background.js', 'auth.js', 'service-config.js', 'study-schema.js', 'sniffer.js', 'capture.js',
    'transcript.js', 'accuracy.js', 'content.js', 'panel-ui.js', 'panel.css',
    'popup.html', 'popup.js', 'privacy.html', 'print.html', 'print.js', 'print.css',
    'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png',
    'vendor/katex/katex.min.js', 'vendor/katex/LICENSE',
]

def build():
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    assert manifest['manifest_version'] == 3
    assert manifest['permissions'] == ['storage', 'identity'], 'Review changed permissions before release'
    config_text = (ROOT / 'service-config.js').read_text()
    match = re.search(r'Object\.freeze\((\{[\s\S]*?\})\)', config_text)
    assert match, 'Run scripts/configure-service.py before packaging'
    config = json.loads(match.group(1))
    assert config['apiBaseUrl'].startswith('https://') and config['googleClientId'].endswith('.apps.googleusercontent.com'), 'Configure the deployed service first'
    assert config['apiBaseUrl'] + '/*' in manifest['host_permissions'], 'Backend permission is missing'
    assert 'https://api.openai.com/*' not in manifest['host_permissions'], 'OpenAI must be called only by the backend'
    references = [manifest['background']['service_worker'], manifest['action']['default_popup']]
    for entry in manifest['content_scripts']:
        references.extend(entry.get('js', []))
        references.extend(entry.get('css', []))
    references.extend(manifest['icons'].values())
    for name in references:
        assert name in FILES, f'Missing packaged dependency: {name}'
    contents = {}
    for name in FILES:
        path = ROOT / name
        assert path.is_file() and not path.is_symlink(), f'Invalid release file: {name}'
        data = path.read_bytes()
        if path.suffix in {'.js', '.html', '.json', '.css'}:
            text = data.decode('utf-8')
            assert not re.search(r'sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}', text), f'Possible embedded key in {name}'
        if path.suffix == '.html':
            for dependency in re.findall(r'(?:src|href)=["\']([^"\']+)["\']', text):
                if dependency.startswith(('https://', '#', 'mailto:')):
                    continue
                assert dependency in FILES, f'Missing HTML dependency: {dependency}'
            assert not re.search(r'<script[^>]+src=["\']https?://', text), 'Remote script in package'
        contents[name] = data
    for size in [16, 48, 128]:
        png = contents[f'icons/icon{size}.png']
        assert png[:8] == b'\x89PNG\r\n\x1a\n'
        assert struct.unpack('>II', png[16:24]) == (size, size)
    destination = ROOT / 'release' / f'panolearn-{manifest["version"]}.zip'
    destination.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in contents.items():
            info = zipfile.ZipInfo(name, (2026, 9, 12, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    with zipfile.ZipFile(destination) as archive:
        assert archive.testzip() is None
        assert set(archive.namelist()) == set(FILES)
    report = {
        'version': manifest['version'], 'zip': destination.name,
        'bytes': destination.stat().st_size,
        'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
        'permissions': manifest['permissions'],
        'host_permissions': manifest['host_permissions'],
        'files': {name: hashlib.sha256(data).hexdigest() for name, data in contents.items()},
        'excluded': ['backups', 'backend including secrets and dependencies', 'tests', 'release drafts', 'ui-preview.html', 'README.md', 'local user storage'],
        'status': 'Package prepared; Google OAuth, backend secrets/deployment, public policy URL, store images and live release smoke test must be verified before submission.'
    }
    (destination.parent / 'package-audit.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'{destination}\n{report["bytes"]} bytes; {len(FILES)} files; SHA-256 {report["sha256"]}')

if __name__ == '__main__':
    try:
        build()
    except (AssertionError, ValueError) as error:
        raise SystemExit(f'Release not built: {error}')
