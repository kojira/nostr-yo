# e2257 / e2259 — Yo convention (t=yo), follow-list search, Yo back (2026-11-27 UTC)

Spec: `SPEC.md`. It is a convention proposed by nostr-yo, **not an adopted NIP**. Confirmed and open items are listed separately in it.
Deployed: main `233a84c` → gh-pages `1e284fe` (clean-clone build). Served sha256 == build (`public-http.txt`).

## Unit tests: 18/18
- **Recognition rule:** our Yo; a Yo without `t` (pre-e2257, backward compatible); another implementation's https URL (labelled not ours).
- **Fakes carrying `t=yo` all rejected:** no emoji tag, `+`, text content, kind 1, other shortcode, missing e/p/k, `k=1`.
- **Bad emoji URLs rejected:** http, javascript:, data:, URLs with credentials, over 2048 chars, missing URL, two emoji tags.
- **Signer tampering rejected:** a dropped or changed `t` tag; the existing tamper cases still hold.
- **Follows:** pick of the latest verified kind 3; follows deduplicated, invalid entries dropped, self removed, 5000 cap; profiles sanitised (control/bidi chars, length, non-JSON content, author mismatch, forged id); search (same name, case and width insensitive, npub, no profile, limit).

## Browser (headless Chrome, **test NIP-07 mock**, real 4 relays) — local 2 runs + public 1 run: 28/28 each
Fixtures were throwaway keys published to the real relays: A's kind 3 with 404 follows, two follows with the same name, a follow with no profile, and a follow whose name contains HTML/XSS and an injection attempt.

| check | result |
|---|---|
| Follow list loaded, 404 people, with honest counts | ok |
| Query count for 404 follows | 16 (bound is 4 + 4×3 = 16) |
| Same name → both listed, each with its npub | ok |
| HTML name shown as text (no `<b>`/`<img>` elements, no script run) | ok |
| No-profile follow found by npub, labelled "プロフィールなし" | ok |
| Choosing a result fixes the pubkey; sent to that person, not the same-name B2 | ok |
| Signed event contains `["t","yo"]` and the right `p` | ok |
| Editing the field by hand clears the choice | ok |
| User with no kind 3 → honest message | ok |
| App never signed a kind 3 | ok |
| Other implementation's Yo (external https image) shown, labelled "他実装" | ok |
| Pre-e2257 format Yo (no `t`) shown | ok |
| 3 fakes (`t=yo` with `+`, without emoji, with http URL) not shown; counted as rejected | ok |
| No external image loaded (only same-origin HTTP) | ok |
| **Yo back:** each row's target is the verified event author and is shown | ok |
| Double click + clicking another row while sending → exactly 1 signature; all buttons disabled | ok |
| Reply contents: kind 7, `:yo:`, `p`=A, `k=0`, `t=yo` | ok |
| A received the reply | ok |
| Reply to an author with no kind 0 → honest failure in the row, nothing signed | ok |

Regression on the public site: the e2250 E2E (send/receive, no profile, recipient/target/emoji/kind1 tamper) all pass; default relays and saved settings all pass; the no-extension message is correct.
Supply chain: no dependency changes (only the test script line in package.json changed); `minimumReleaseAge: 10080` is kept; audit finds no known vulnerabilities (`audit.txt`).

## Not verified / remaining issues
- A real NIP-07 extension (every signature came from the mock).
- Existing Nostr clients: not surveyed, nothing promised.
- Very large follow lists (several thousand) were not measured. Only 404 was tested; the design caps at 5000, with 150-author chunks relay by relay and 2 requests in flight.
- A failure of the kind 3 lookup on all relays (as opposed to "not found") was not forced in a browser test.
- `#t` filter support per relay was not checked. The app does not depend on it.
- Test events from throwaway keys (kind 0, kind 3, kind 7) remain on the 4 relays.
