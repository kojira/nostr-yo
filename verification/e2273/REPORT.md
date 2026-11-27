# e2273: simple mobile UI, kept login, explicit logout (2026-11-27)

Deployed: main `5e6d20c` → gh-pages `3b87f14` (clean-clone build). The served sha256 of all 4 files matches the build (`public-http.txt`).

## Changes
- Header: a compact bar with a 36 px logo, your icon and name, and the ☰ menu. The tall title image is gone.
- First view after login: "届いた Yo" (newest first, 5 shown, then "さらに表示"), each with icon, name, date/time (`11/27 19:59`, plus the year for older Yo; `<time datetime>`), and "Yo! を返す". The send box comes next.
- Removed from the screen:
  - "署名検証済み" and the kind0 一致 / 未確認 badges;
  - the "返信先: name (npub)" line;
  - follow / profile / query counts;
  - the rejected count;
  - the verbose relay error details on send (they are now inside a collapsed "リレーごとの結果").
- npub: inside the collapsed "詳細". In search it is shown only for same-name results or results without a profile.
- Internal checks are unchanged: `parseIncomingYo`, `checkSignedYo` and `pickLatestProfile` are untouched. A forged event is still not shown (tested).
- Menu: account (npub in 詳細, 入り直す, ログアウト) and relay settings (defaults unchanged).
- Login: `localStorage["nostr-yo:session"] = {"v":1,"pubkey":hex}` only; anything else there is refused (unit tests). No secret key or token.
  - Reload/resume restores the inbox **without calling the extension**. Each send/reply checks the extension's current `getPublicKey()` against the account first. If they differ, nothing is signed, a short message is shown, and there is a "切り替える" button.
  - No extension: "拡張が見つかりません（受信の表示のみ）". Late extensions are waited for (≈4 s).
  - Relays reconnect on visibilitychange / pageshow / online. Stale WebSocket events are ignored.
  - Logout removes the session, clears the inbox and search, and unsubscribes. Nothing is restored after reload. The `storage` event keeps other tabs in sync.
- iOS: every input is 16 px or larger. The viewport is `width=device-width, initial-scale=1, viewport-fit=cover`, so zoom is not disabled. min-width:0 and ellipsis are used throughout. No `overflow-x:hidden` hack on html/body: the overflow check runs against the real document and body widths.

## Tests
- Unit 25/25. New: `session.test.ts` covers the session format and refusals, account vs. signer state, and the date format.
- Browser: `scripts/browser-verify-e2273.mjs`.
  - Setup: headless Chrome 390×844, DPR 3, mobile, touch, iOS Safari UA; **test NIP-07 mock**; real 4 relays; throwaway keys.
  - Results: local **58/58** (`browser-local/`) and public **58/58** (`browser-public/result.json`, 12 screenshots).
  - Covered:
    - the first view (login visible, no extension call);
    - document and body scrollWidth ≤ clientWidth, and no element sticking out, on: the first view, after login, with long-name search, with a 120-character input, in the menu, and in no-extension mode;
    - all inputs ≥ 16 px, and the viewport allows zoom;
    - the reply button and Yo in the first view, with date/time kept;
    - no technical text and no long npub visible;
    - reply and search send: one signature each, to the right pubkey;
    - reload restores the inbox (0 extension calls, 0 signatures);
    - offline → online, then a new Yo arrives;
    - an extension account change blocks sending (0 signatures), then switching works;
    - the menu (add/remove relay, defaults);
    - logout, then reload stays logged out;
    - no extension: read-only, with a short message;
    - a late extension;
    - the emoji URL is never fetched;
    - signatures only happen after taps.
- Relay defaults and saved settings: 6/6, local and public.
- Supply chain: no dependency, lockfile or workspace changes; `minimumReleaseAge` is kept.

## Not verified / limits
- Real iPhone Safari (WebKit), focus-zoom, and the software keyboard: emulation in Blink only. safaridriver needs "Allow remote automation", which is off, so it was not used.
- A real NIP-07 extension (nos2x, Alby, iOS extensions): mock only. Real background suspension: simulated with offline/online plus visibilitychange.
- The old e2257/e2263 browser suites assert the removed UI (follow counts, the kind0 badge, npub lines). They were superseded by e2273 and not re-run. Their protocol checks (reply target = author, forged event rejected, emoji URL never fetched, search pick fixes the pubkey) are covered again in e2273.
- Test events from throwaway keys remain on the 4 relays.
