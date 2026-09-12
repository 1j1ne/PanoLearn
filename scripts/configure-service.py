#!/usr/bin/env python3
"""Set public service settings. Secrets belong only in Cloudflare secret storage."""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True, help='Deployed HTTPS worker origin')
parser.add_argument('--google-client-id', required=True, help='Public Web application OAuth client ID')
args = parser.parse_args()
url = urlsplit(args.url)
if (url.scheme != 'https' or not url.hostname or url.username or url.password or
    url.path not in ('', '/') or url.query or url.fragment or url.port or
    url.hostname in ('localhost', 'example.com') or url.hostname.endswith(('.example', '.invalid'))):
    parser.error('Use the real deployed HTTPS origin, without a path, credentials or query.')
if not re.fullmatch(r'[A-Za-z0-9_-]+\.apps\.googleusercontent\.com', args.google_client_id):
    parser.error('Expected a public Google OAuth client ID ending in .apps.googleusercontent.com')
base = 'https://' + url.hostname
(root / 'service-config.js').write_text('// Public deployment settings; no secrets.\nglobalThis.PANOLEARN_SERVICE = Object.freeze(' + json.dumps({
    'apiBaseUrl': base, 'googleClientId': args.google_client_id
}, indent=2) + ');\n')
manifest_path = root / 'manifest.json'
manifest = json.loads(manifest_path.read_text())
manifest['host_permissions'] = ['https://*.instructure.com/*', 'https://*.hosted.panopto.com/*', 'https://*.panopto.com/*', base + '/*']
manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
config_path = root / 'backend/wrangler.toml'
config = config_path.read_text()
config_path.write_text(re.sub(r'^GOOGLE_CLIENT_ID = .*$', 'GOOGLE_CLIENT_ID = ' + json.dumps(args.google_client_id), config, flags=re.M))
print('Public service settings saved. The backend secrets, deployment and live sign-in test are still required.')
