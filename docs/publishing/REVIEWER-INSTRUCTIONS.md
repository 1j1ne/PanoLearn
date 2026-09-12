# Reviewer instructions draft

Version 1.9.0 requires a supported Canvas/Panopto page and Google sign-in; the publisher-funded backend must be deployed before review. No reviewer API key is required. Ensure Google OAuth is available to the reviewers, and provide an authorized demo lecture. Do not embed credentials in this document or ZIP.

Before submission, establish a reviewer-accessible demonstration route for the complete workflow. Provide a public, authorized Panopto lecture with captions, or an appropriately permissioned test course/account in the dashboard's private test-instructions field. A private university lecture belonging to the developer is not sufficient unless the reviewer can access it legitimately. Decide how reviewers can exercise the API-funded generation without exposing an unrestricted credential publicly.

Test procedure:
1. Install the ZIP through the developer dashboard or load its extracted directory unpacked for pre-release QA.
2. Open the popup; verify the version and privacy/key-cost disclosure.
3. Sign in with Google through the popup.
4. Open the authorized test Panopto lecture directly and via an embedded supported Canvas page. Enable captions if necessary.
5. Open PanoLearn and inspect the transcript beginning/end. Alternatively, use Transcript source → Use your own transcript with the fixture below to test generation (fixture timestamps do not represent a real video).
6. Generate Summary. Confirm estimated progress, collapsible topics, math rendering and worked-example titles/ranges. Only test seek accuracy against a real corresponding transcript/video, not the fixture.
7. Select additional study sections; test a multi-lecture selection.
8. Save Notes as PDF; confirm topics expand and example setup/result prose remains hidden.
9. Remove a saved lecture and sign out. Confirm the popup is signed out and generation requires sign-in.

Original test transcript (safe synthetic data, not a real lecture):
[0:00] Today we will describe a line in three dimensions using a point and a direction vector.
[0:15] A vector equation is r of t equals r zero plus t times v.
[0:30] For an example, use the point one, two, three and direction vector two, one, minus one.
[0:45] Substitute the point and direction to obtain x equals one plus two t, y equals two plus t, and z equals three minus t.
[1:00] At t equals one, the resulting point is three, three, two. That completes our example.
[1:15] A symmetric form sets x minus one over two equal to y minus two over one equal to z minus three over minus one.
[1:30] Each denominator is the corresponding nonzero direction component. If a component is zero, its coordinate stays fixed instead.
[1:45] In summary, choose vector, parametric or symmetric form according to the task.
