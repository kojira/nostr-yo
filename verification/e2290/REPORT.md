# e2290: profile pictures from hosts without CORS headers (2026-11-28)

Deployed: main `c528830` → gh-pages `8144c32` (clean-clone build via `scripts/deploy.sh`). The served sha256 of index.html, app.js, style.css and yo.png matches the build (`public-http.txt`). The served app.js contains no `crossOrigin`.

## Cause and fix
- `avatar()` in `src/main.ts` set `crossOrigin = "anonymous"` on every profile `<img>`. That turns the request into a CORS request, so hosts without `Access-Control-Allow-Origin` failed and the image fell back to the letter avatar.
- The image is only displayed and never read via canvas, so the attribute is removed. Because `avatar()` is shared, this fixes the header account icon, inbox rows, search candidates and the selected recipient together.
- Kept unchanged:
  - `safePictureUrl` (https only, no credentials or control characters, ≤ 1024 chars);
  - `referrerpolicy=no-referrer` plus `<meta name=referrer content=no-referrer>`;
  - CSP `img-src 'self' data: https:`;
  - `onerror` → letter avatar;
  - lazy loading.
- Docs: README/DESIGN no longer say "crossorigin=anonymous (no cookies)". Without `crossorigin`, the browser may send the image host's own cookies, depending on its third-party cookie settings.

## Tests (`scripts/browser-verify-e2290.mjs`)
- Setup:
  - headless Chrome, 390×844 mobile emulation;
  - **TEST-ONLY NIP-07 mock** with throwaway keys;
  - local mock relay, so kind 0 replies can be delayed;
  - image hosts `img-nocors.nyo.test` (no ACAO header), `img-cors.nyo.test` (ACAO `*`) and a 404 path, served by CDP interception;
  - one real non-CORS host, `https://www.google.com/favicon.ico` (confirmed status 200 with no ACAO in the run).
- Before the fix (old build): `browser-before-fix/` **21/33**. Every failure is a non-CORS image falling back to the letter avatar; the CORS host loads. This reproduces the bug.
- After the fix:
  - local `browser-local/`: **33/33**;
  - public `browser-public/`: **33/33**. Run with `LNA_OFF=1`, which disables Chrome's local network access check in the test browser only, so the https site can reach the `ws://127.0.0.1` mock relay.
- What the 33 checks cover:
  - non-CORS and real non-CORS images load in the header, inbox, candidates and selected recipient, and the CORS host still loads;
  - no `crossorigin` attribute; `no-referrer` kept;
  - requests carry no Origin header (no-cors) and no Referer; no CORS errors;
  - `http://` picture → letter avatar and never requested; no picture → letter; 404 → letter (inbox, candidates, header);
  - CSP and referrer meta unchanged;
  - account switch A→B with B's kind 0 delayed 4 s: no A image or name while waiting, then B's image appears and the inbox is B's only;
  - switch to C, then logout before C's delayed kind 0 arrives: no image or account remains (only `yo.png`);
  - switching back to A loads A's image again; nothing was signed.
- Full e2285 regression (real relays, NIP-07 mock): local `regression-e2285-local/` **81/81**, public `regression-e2285-public/` **81/81**.
- typecheck OK, unit tests 25/25.

## Not verified
- A real NIP-07 extension: mock only.
- Real iOS Safari/WebKit: Blink emulation only.
- The owner's actual kind 0 picture URL was not checked: the non-CORS cases are mock hosts plus google.com/favicon.ico.
- Whether cookies are actually sent: this depends on each browser's third-party cookie settings and was not measured.
- Test events from throwaway keys remain on the real relays (e2285 regression).
