#!/usr/bin/env python3
"""Create a source-only GitHub upload archive; not a Chrome extension package."""
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    '.gitignore', 'README.md', 'manifest.json', 'accuracy.js', 'auth.js',
    'background.js', 'capture.js', 'content.js', 'panel-ui.js', 'panel.css',
    'popup.html', 'popup.js', 'print.css', 'print.html', 'print.js',
    'privacy.html', 'service-config.js', 'sniffer.js', 'study-schema.js', 'transcript.js',
    'backend/.gitignore', 'backend/README.md', 'backend/package.json',
    'backend/package-lock.json', 'backend/wrangler.toml',
]
DIRECTORIES = ['backend/src', 'backend/test', 'docs', 'icons', 'scripts', 'tests', 'vendor']
ALLOWED_EXTENSIONS = {'.js', '.cjs', '.mjs', '.json', '.html', '.css', '.md', '.py', '.png', '.toml'}

def build():
    paths = [ROOT / name for name in FILES]
    for directory in DIRECTORIES:
        for path in sorted((ROOT / directory).rglob('*')):
            if path.is_file() and not any(part.startswith('.') or part == '__pycache__' for part in path.relative_to(ROOT).parts):
                if path.suffix in ALLOWED_EXTENSIONS or path.name == 'LICENSE':
                    paths.append(path)
    contents = {}
    for path in paths:
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Missing or linked source file: {path.relative_to(ROOT)}')
        data = path.read_bytes()
        if path.suffix != '.png':
            text = data.decode('utf-8')
            if re.search(r'sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|GOCSPX-[A-Za-z0-9_-]{20,}', text):
                raise ValueError(f'Possible secret in {path.relative_to(ROOT)}; archive not created')
        contents[path.relative_to(ROOT).as_posix()] = data
    destination = ROOT / '.local' / 'panolearn-github.zip'
    destination.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(contents.items()):
            archive.writestr('PanoLearn/' + name, data)
    with zipfile.ZipFile(destination) as archive:
        if archive.testzip() is not None:
            raise ValueError('Source archive integrity check failed')
    print(f'{destination}\n{len(contents)} source files; {destination.stat().st_size} bytes. Extract before uploading to GitHub.')

if __name__ == '__main__':
    build()
