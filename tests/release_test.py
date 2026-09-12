"""Verify release packaging without configuring or publishing the real build."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]

class ReleaseTests(unittest.TestCase):
    def test_release_requires_service_and_excludes_backend(self):
        definition = runpy.run_path(str(ROOT / 'scripts/build-release.py'))
        with tempfile.TemporaryDirectory(prefix='panolearn-package-') as folder:
            root = Path(folder)
            for name in definition['FILES'] + ['scripts/build-release.py']:
                dest = root / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, dest)
            build = runpy.run_path(str(root / 'scripts/build-release.py'))['build']
            with self.assertRaisesRegex(AssertionError, 'Configure the deployed service'):
                build()
            (root / 'service-config.js').write_text('globalThis.PANOLEARN_SERVICE = Object.freeze(' + json.dumps({
                'apiBaseUrl': 'https://fixture.workers.dev', 'googleClientId': 'fixture.apps.googleusercontent.com'
            }) + ');')
            manifest = json.loads((root / 'manifest.json').read_text())
            manifest['host_permissions'].append('https://fixture.workers.dev/*')
            (root / 'manifest.json').write_text(json.dumps(manifest))
            (root / 'backend').mkdir()
            (root / 'backend/.dev.vars').write_text('OPENAI_API_KEY=TEST_ONLY_DO_NOT_PACKAGE')
            with contextlib.redirect_stdout(io.StringIO()):
                build()
            with zipfile.ZipFile(root / 'release' / ('panolearn-' + manifest['version'] + '.zip')) as archive:
                self.assertIn('auth.js', archive.namelist())
                self.assertIn('study-schema.js', archive.namelist())
                self.assertFalse(any(name.startswith('backend/') for name in archive.namelist()))
                self.assertFalse(any(b'TEST_ONLY_DO_NOT_PACKAGE' in archive.read(name) for name in archive.namelist()))

if __name__ == '__main__':
    unittest.main()
