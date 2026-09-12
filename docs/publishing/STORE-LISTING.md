# PanoLearn — Chrome Web Store listing draft

Status: 1.9.0 draft; requires backend deployment and OAuth setup. The live store draft still describes 1.8.15 and must be updated before submission.

## Name
PanoLearn — AI Study Notes for Canvas

## Short description
Turn Panopto lecture transcripts into concise study notes, clickable topic ranges, flashcards and PDF exports.

## Detailed description
PanoLearn helps you review lectures from Panopto and supported Canvas pages. Use available captions or paste your own transcript, then sign in with Google to generate study materials. No personal API key is required.

• Concise summaries with expandable, numbered topics.
• Clickable topic and worked-example time ranges when supported by the transcript.
• Worked-example titles grouped under the relevant topic.
• Mathematical notation, including stacked fractions.
• Optional 3-Step Concepts, flashcards, mind maps and practice questions.
• Save and select multiple lecture transcripts to study together.
• Export notes through Chrome’s Save as PDF dialog.

Designed for different subjects, including humanities, social sciences and technical courses. Notes depend on the supplied transcript; PanoLearn does not record audio or interpret unspoken slide content. Generated explanations and timestamps can be wrong and should be checked against the lecture.

REQUIREMENTS
A supported Canvas or Panopto page and readable transcript text are required. Google sign-in is required for generation. PanoLearn supplies API access with daily per-user and service-wide limits. A long lecture can use multiple generation requests. Compatibility may vary with your institution’s player and caption setup. PanoLearn does not bypass course access restrictions.

PRIVACY
On supported pages, PanoLearn reads available lecture captions/transcript responses locally. Clicking Generate sends selected transcript text and lecture titles through PanoLearn’s Cloudflare-hosted server to OpenAI. Google handles sign-in; short-lived identity tokens stay in trusted browser session storage. Saved lectures remain in local extension storage. The service keeps hashed usage counters for up to 48 hours and does not store lecture content in its application database. PanoLearn includes no advertising or analytics SDK. See the privacy policy for details and deletion controls.

PanoLearn is an independent project and is not affiliated with or endorsed by Canvas, Instructure, Panopto or OpenAI.

## Publisher-provided fields still needed
- Publisher name and verified public contact email.
- Public privacy-policy URL (host the reviewed privacy.html file from the project root).
- Support URL/contact and, optionally, homepage URL.
- Distribution countries and any applicable publisher/trader declarations: answer based on your actual status.
- Store category: select the closest education/study category available in the current dashboard.
- Extension access/pricing: this build has no extension payment mechanism; OpenAI bills the user separately.

## Images still required
- 128×128 extension icon: ../../icons/icon128.png is available; inspect it against the current store visual guidelines.
- 440×280 small promotional image.
- At least one 1280×800 or 640×400 screenshot of the actual extension experience.
Use an original demo lecture or material you have permission to publish. Do not expose keys, student names, private course URLs or a professor’s image without appropriate permission. Show actual functioning UI rather than an invented mockup. Label demo/sample content honestly.

Reference: https://developer.chrome.com/docs/webstore/images
