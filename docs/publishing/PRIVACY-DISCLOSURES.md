# Chrome Web Store privacy fields — draft based on source review

These answers describe this build. Review them alongside the store’s current form before certifying anything. Do not select “no user data”: local processing counts, and generation transmits selected content to OpenAI.

## Single purpose
Turn user-selected Panopto lecture transcripts into study materials, with source-linked topics and examples and PDF export.

## Permission justification
storage: Save explicitly selected lecture transcripts/title/URLs locally; keep Google identity tokens and email in trusted session storage, and temporarily pass generated notes to the PDF print page through session storage.

Host access to *.instructure.com and *.panopto.com (including *.hosted.panopto.com): Detect the supported lecture context, read available captions and transcript/player-metadata responses in the top page and embedded frames, display the study panel, and navigate to source caption times. No all-sites access is requested.

identity: Open Google sign-in using the authorization code flow with PKCE.

Host access to the exact deployed PanoLearn backend: Authenticate Google sign-in and send selected source text for publisher-funded generation. The extension does not request api.openai.com access.

Unused activeTab and scripting permissions were removed in the release-preparation build. All executable code, including KaTeX, is bundled; generated JSON is rendered as data, not executed.

## Data categories to disclose
- Website content: lecture transcripts, available caption text, source titles, and generated/pasted study material.
- Personally identifiable information: Google account identifier and email for sign-in; hashed account identifiers for usage limits.
- Authentication information: short-lived Google identity tokens stored in trusted session storage and verified by the backend.
- Location/network information: Cloudflare processes connecting IP addresses; application sign-in throttling keeps only a daily salted IP hash. No GPS access is requested.
- Web history/activity: limited source-page URLs and lecture context on supported sites, used for source selection, saved lectures and time links; not a general browsing-history collector.
- Other sensitive information: transcripts can contain personal, health, financial or other sensitive material. Reconcile the dashboard’s exact definitions with your allowed use cases before making declarations. The app does not intentionally extract those categories separately.

## Usage and sharing
Data is used for the disclosed study-note features. The extension sends selected source text/titles and intermediate notes through the Cloudflare-hosted PanoLearn backend to OpenAI when generation is requested. Google provides authentication. The backend keeps hashed identity-based usage counters and daily salted IP hashes for throttling, removed within 48 hours. Application code does not log/store transcripts. There are no advertisements, analytics SDKs or sale of user data. Requests use store:false, which does not promise zero provider retention.

Do not certify claims about operations outside this codebase without verifying them. Publisher contact email handling through the store is separate from the extension’s runtime behavior.

## Public policy
The root privacy.html file is a human-readable draft that can be hosted as a public static page. Add the chosen publisher contact details or ensure the referenced store contact is valid. Host it without requiring sign-in; put the public URL in the dashboard. The bundled copy alone is not a public policy URL.

Reference: https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
