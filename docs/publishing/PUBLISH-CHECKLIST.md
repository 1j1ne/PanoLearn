> 1.9.0 migration: the 1.8.15 ZIP and existing online draft are superseded for this release. Complete backend/README.md, live Google sign-in/generation tests, revised disclosures and a fresh configured ZIP before submitting.

# PanoLearn publication checklist

## Prepared
- Source-only packaging and extension release scripts prepared. A fresh configured 1.9.0 ZIP is still required.
- Runtime dependencies and KaTeX license included.
- Unused permissions removed.
- Google sign-in popup and publisher-funded generation disclosure added.
- Privacy page and store-listing/privacy-field drafts prepared.

## Still required — do not submit yet
1. Complete Google OAuth and backend deployment using backend/README.md. The Chrome Web Store account and 2-Step Verification are already set up.
2. Set your publisher name and verify the public contact email. Complete any identity/status declarations requested by Google truthfully.
3. Review privacy.html against your actual business practices, add chosen contact details if appropriate, and publish it at a publicly accessible HTTPS URL. A simple static page is sufficient; a full product website is not necessary.
4. Prepare the required small promotional image and at least one actual product screenshot, using content you may publish.
5. Complete the live smoke test described in REVIEWER-INSTRUCTIONS.md. Regression tests do not replace a real OpenAI/Panopto end-to-end run.
6. Arrange a legitimate reviewer-accessible lecture/demo and generation-testing route. Do not submit private student/university credentials or unrestricted API keys publicly.
7. Upload the ZIP as a draft. Fill in store listing, privacy, distribution and private test instructions using the prepared drafts and actual publisher information.
8. Review the completed draft before submitting to Google's review. Publication is subject to approval; the package has not been submitted or approved.

## Rebuild
From the project directory:

    node --test tests/*.test.cjs
    python3 scripts/build-release.py

The ZIP version comes from manifest.json. Upload the ZIP itself, not the project directory. Keep the same store item for future updates, incrementing the manifest version.

## Official resources
- Register: https://developer.chrome.com/docs/webstore/register
- Dashboard: https://chrome.google.com/webstore/devconsole
- 2-Step Verification: https://developer.chrome.com/docs/webstore/program-policies/two-step-verification/
- Publish: https://developer.chrome.com/docs/webstore/publish/
- User-data disclosures: https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- Required images: https://developer.chrome.com/docs/webstore/images
