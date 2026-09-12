# PanoLearn

A Chrome extension that turns Panopto lecture transcripts into study notes on Canvas and Panopto pages.

- Expandable topic summaries with clickable video time ranges
- Worked examples grouped under their topics
- Mathematical notation rendered with bundled KaTeX
- Flashcards, concepts, mind maps and practice questions
- Multiple saved lectures and PDF export

## Status

Version **1.9.0** implements Google sign-in and publisher-funded OpenAI requests through a Cloudflare backend. Service configuration and live deployment are still required. Users do not enter an OpenAI API key. The public service settings are intentionally empty until setup is complete.

Generated notes depend on the supplied transcript. PanoLearn does not record audio, interpret unspoken slides or bypass course access controls. Check important explanations and timestamps against the lecture.

## Project structure

```text
manifest.json           Chrome extension manifest (load this root directory)
background.js           Message routing and streaming transport
content.js              Transcript selection and generation workflow
auth.js                 Google sign-in and trusted session storage
service-config.js       Public backend URL and Google OAuth client ID only
study-schema.js         Shared structured-response schemas
accuracy.js             Source evidence and topic/example reconciliation
transcript.js           Caption normalization and source parsing
sniffer.js / capture.js  Caption capture in supported lecture frames
panel-ui.js / panel.css  Study notes rendering and styling
popup.* / print.*        Account popup and PDF export
privacy.html            Privacy disclosure, also intended for public hosting
backend/                Cloudflare Worker, usage limits and deployment guide
scripts/                Service configuration and extension packaging
tests/                 Extension and release regression tests
docs/publishing/       Store listing, disclosures and review checklist
icons/ / vendor/        Icons and bundled KaTeX (including its license)
```

## Setup

Requirements: Chrome 116+, a current Node.js version supported by Wrangler, Python 3, a Cloudflare account, a Google Cloud OAuth client and the publisher's OpenAI API key.

1. Follow [backend setup](backend/README.md) to configure Google sign-in, Cloudflare secrets and the service URL.
2. Open `chrome://extensions`, enable **Developer mode**, and select **Load unpacked** with this repository's root directory. Use the stable extension ID described in the backend guide for OAuth testing.
3. Sign in with Google from the extension popup.
4. Reload a supported Canvas or Panopto lecture page. Enable captions, open **Study Notes**, and inspect the selected transcript. Pasted transcripts are also supported.
5. Select the study sections and generate notes. Export using **Save Notes as PDF**.

Only public configuration belongs in `service-config.js` and `backend/wrangler.toml`. Enter `OPENAI_API_KEY` and `GOOGLE_CLIENT_SECRET` directly into Cloudflare secret storage. Never put them in extension code, GitHub, screenshots or store materials.

## Verification

```sh
npm ci --prefix backend
node --test tests/*.test.cjs
python3 tests/release_test.py
npm test --prefix backend
npm run check --prefix backend
```

These checks cover parsing, source matching, rendering, authentication, quotas and packaging. They do not replace a live Google sign-in and authorized lecture-generation test after deployment.

## Chrome Web Store package

After service configuration and live testing:

```sh
python3 scripts/build-release.py
```

The script creates `release/panolearn-<version>.zip` from an explicit runtime allowlist. It refuses missing service configuration and excludes backend code, secrets, dependencies and development files. The Chrome Web Store ZIP is different from the full source repository uploaded to GitHub.

See the [publishing checklist](docs/publishing/PUBLISH-CHECKLIST.md), [store listing](docs/publishing/STORE-LISTING.md), [privacy disclosures](docs/publishing/PRIVACY-DISCLOSURES.md) and [reviewer instructions](docs/publishing/REVIEWER-INSTRUCTIONS.md).

## Repository hygiene

`.gitignore` excludes secrets, dependencies, generated releases and local archives. Commit `backend/package-lock.json` for reproducible dependencies. Previous local backups are preserved in `.local/archive/` and should not be uploaded. GitHub's browser upload does not apply `.gitignore`. For a source-only copy, run `python3 scripts/build-source.py`, extract `.local/panolearn-github.zip`, and upload the extracted source files. Alternatively, use Git/GitHub Desktop so ignored files remain local.

## Third-party code

KaTeX is bundled under its [MIT license](vendor/katex/LICENSE). No open-source license for PanoLearn's own code has been selected yet. PanoLearn is independent of Canvas, Panopto, Google, Cloudflare and OpenAI.
# PanoLearn
