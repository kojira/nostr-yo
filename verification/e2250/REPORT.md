# e2250 — Yo as a NIP-25 kind 7 custom-emoji reaction to the recipient's kind 0 (2026-11-27 UTC)

Spec source: NIP-25 / NIP-30 at nostr-protocol/nips master `bec0fc8` (`nip25.md`, `nip30.md`, `nips-source.txt`).
Scope narrowed by owner e2251: existing Nostr clients were **not** surveyed or tested, and nothing is claimed about them.

## Event
`kind 7`, `content ":yo:"`, tags:
- `["e", <kind0 id>, <hint>, <to>]`
- `["p", <to>, <hint>]`
- `["k", "0"]`
- `["emoji", "yo", "https://kojira.github.io/nostr-yo/yo.png"]`

No `a` tag, since kind 0 is not addressable. The image is served from this site.
Kind 7117 is retired: no longer sent or read.

## Results
| check | result |
|---|---|
| Typecheck / unit tests | 13/13 pass. Covered: exact tags; pick of the latest verified kind 0 (forged, other-author and non-kind-0 events ignored; NIP-01 tie-break); signer tampering of p / e / emoji / k / content / kind / legacy kind / created_at / author all rejected; receive filter rejects bad sig, `+`, extra content, HTML, legacy 7117, kind 1, foreign emoji URL, other shortcode, missing or duplicate emoji/e/p/k, wrong e author hint, `a` tag, future timestamp |
| Supply chain | package.json, lockfile, pnpm-workspace.yaml (`minimumReleaseAge: 10080`) and .npmrc unchanged; audit: no known vulnerabilities (`audit.txt`); clean-clone build hashes == served |
| Public HTTP | index/app.js/style.css/yo.png all 200 and identical to build; `yo.png` 200 image/png (`public-http.txt`) |
| Public browser E2E (**mock NIP-07**, real 4 relays) | B's test kind 0 OK on 4/4; A's Yo reaction OK on 4/4; B received it with "kind0 一致"; recipient with no kind 0 refused with per-relay counts; recipient/target/emoji swaps and kind 1 refused before publish; only same-origin HTTP (`browser-public/`) |
| Independent relay readback | the reaction is on all 4 relays and passes `parseIncomingYo` (`relay-readback.txt`) |
| Local E2E | same results (`browser-local/`) |
| Default relays / saved settings (regression) | all true (`relay-settings-public.json`) |
| No extension | "未検出" shown, send refused, no console errors (`public-no-extension.txt`) |

## Not verified
- A real NIP-07 extension: every signature came from the test mock.
- How existing Nostr clients show or notify these reactions (out of scope, no promises).
- The "kind 0 lookup failed on every relay" message is implemented but was not forced in a browser test. The "no profile" path was tested.
- Test events (kind 0 profiles and kind 7 reactions from throwaway keys) remain on the 4 relays.
