# e2263 + e2264 — sender icon/name in inbox and follow search (2026-11-27 UTC)

Deployed: main `cf687ef` → gh-pages `fbc6887` (clean-clone build). Served sha256 == build (`public-http.txt`).

## Implementation
- Profile source: the newest verified kind 0 per author. The follow loader's profiles are reused; unknown senders are batched (150 authors per REQ, relay by relay, missing ones only), each author at most once per session.
- Name: display_name || name, as untrusted text (control/bidi chars removed, length capped, `textContent`). A short npub is always shown under it.
- Picture: plain https only (`safePictureUrl`). `<img referrerpolicy=no-referrer crossorigin=anonymous loading=lazy>`. On error → letter avatar. CSP `img-src 'self' data: https:`.
- The same `avatar()` is used in the follow search candidates (e2264). No extra queries.
- The emoji URL inside Yo events is still never fetched. The Yo back target is still the verified event author. A selected search result still fixes the pubkey.
- Privacy impact (profile image hosts see your IP and the time) is documented in the README.
- Bug fixed: inbox re-render used requestAnimationFrame, which doesn't fire in background tabs.

## Tests
- Unit: 21/21. New: `safePictureUrl` rejects http, javascript:, data:, protocol-relative, credentials, quotes, `<>`, too-long, NUL, file:, blob:; picture parsing; search rows carry only safe pictures.
- Browser (headless Chrome, **test NIP-07 mock**, real 4 relays, throwaway keys). Local and public: 22/22 (`browser-public/result.json`, screenshots `inbox-profiles.png`, `search-icons.png`).
  - Inbox:
    - name and icon shown, with no-referrer;
    - same name told apart by npub;
    - broken image → letter avatar;
    - HTML name shown as text, no script run;
    - javascript: and http: picture → letter avatar;
    - no picture → letter avatar;
    - no profile → "プロフィールなし" plus npub;
    - reply targets = authors;
    - the injected emoji URL host was never requested.
  - Search:
    - icon shown;
    - broken image → letter avatar;
    - same name told apart by npub;
    - bad URL → letter avatar;
    - no profile → letter avatar;
    - choosing a same-name entry fixes that pubkey, and the Yo went to it.
  - Yo back: one signature to the author, `t=yo` present; the other side shows the reply with the sender's name.
- Regression on the public site:
  - e2257 suite 28/28 (one assertion updated: it looked for the old "from npub" text);
  - e2250 suite all pass;
  - default relays and saved settings all pass;
  - no-extension message OK.
- Supply chain: no dependency or config changes; `minimumReleaseAge: 10080` is kept; audit finds no known vulnerabilities.

## Not verified
- A real NIP-07 extension (mock only).
- Real-world profile images on many hosts (slow or huge images, hosts that reject anonymous CORS). Images that fail fall back to a letter avatar, but this was only tested with a 404 image.
- Very large inboxes: up to 100 rows are rendered; sender lookups are batched but were not load-tested.
- The "profile lookup failed on every relay" sender state was not forced in a test.
- Test events from throwaway keys remain on the 4 relays.
