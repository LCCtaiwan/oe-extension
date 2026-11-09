# iPhone lookup: authentication, response type and presentation

Observed 2026-11-09. No deployment, spreadsheet or tutorial-site access policy was changed.
The request URL was the existing deployment supplied by the user, with
`q=rosuvastatin`. Tests used no Google login cookies and did not request AI rewrites.

## Observed remote responses

| Request | Redirects / final response | Interpretation |
| --- | --- | --- |
| GET `/exec?q=rosuvastatin` | 302 to `accounts.google.com/ServiceLogin`, then 302 to Google sign-in; final 200 `text/html; charset=utf-8`, title `Sign in - Google Accounts` | Login HTML, not a formulary result |
| GET `/exec?api=lookup&q=rosuvastatin` | Same login redirects and final HTML | Expected text API was not reached in this context |
| POST `/exec`, URL-encoded Form field `q=rosuvastatin` | Immediate 401 `text/html; charset=utf-8`, title `Page Not Found`, 7,913 bytes; no redirect | Google error response, not a lookup result |
| POST while configured to preserve POST on redirects | Same immediate 401 | No downstream ContentService redirect was reached in this test |

All captured bodies decoded as UTF-8 without replacement characters. This does not
prove the cause of the user's earlier mojibake or blank display; the iPhone's
failing response has not been captured. A 401 alone does not establish which GAS
access setting is configured, nor prove that `doPost` is absent.

The [ContentService documentation](https://developers.google.com/apps-script/guides/content#redirects)
explains an additional one-time redirect to `script.googleusercontent.com` for
successful ContentService responses. That is distinct from the Google **login**
redirects actually observed here. Do not hardcode a temporary response URL or
force POST to a redirected read-only response URL.

## What the user's screenshots confirm

The current shortcut receives Text from the share sheet, URL-encodes Shortcut
Input, and constructs `/exec?q=` followed by the encoded-text variable.
Originally its final action was Open URLs, which invokes the default browser.
This explains Chrome opening without implying any problem in drug matching.

The latest screenshot confirms that the final action has been changed to the
Safari Web View action, labeled `顯示網頁顯示方式` in the action search and
`顯示 URL 的網頁顯示方式` after insertion. Its input is the complete URL from the
preceding action, not the raw drug name. Configuration is confirmed; execution
and login behavior are still pending.

## Test on the iPhone without changing access

1. Keep the current URL Encode and URL actions unchanged.
2. Use the configured Safari Web View action as the last action.
3. From **OpenEvidence or the original webpage**, select `rosuvastatin`, Share,
   and run the shortcut. Running it without input in the editor is not the same test.
4. Confirm all three: a real formulary result appears in an embedded view; Chrome
   does not launch; closing the view returns to the original reading location.
5. If login or a Google embedded-browser error appears, record that exact state.
   Do not assume Chrome/Safari cookies are shared with this view. If existing
   authorized login cannot work in the view, this candidate has not passed.
6. If the action cannot execute from the share sheet, record that restriction.
   Do not replace it with Open URLs and call the overlay requirement satisfied.

No new GAS endpoint or public-access change is required to test the page route.
The two-action HTTP shortcut is not an established solution for this protected
deployment. Changing q encoding, adding POST support or passing unit tests cannot
repair a Google authentication gate outside the application's code.

## Verification limits

- Real remote HTTP requests: completed as above.
- Repository tests: all 15 test files passed.
- User screenshot: Web View action and complete-URL input confirmed.
- Formulary result in Web View on the user's iPhone: **pending**.
- Login inside Web View, no Chrome launch, and return to source app: **pending**.
- Authenticated browser session and GAS deployment settings: not accessible from
  this environment; no iPhone or connected logged-in browser control is available.

[Apple's share-sheet documentation](https://support.apple.com/guide/shortcuts/launch-a-shortcut-from-another-app-apd163eb9f95/ios)
confirms the share-sheet entry point, not that Google authentication succeeds in
an embedded view. Update the pending checks only after receiving device evidence.
