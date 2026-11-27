# Verification report — nostr-yo (2026-11-27 UTC)

## Scope / ground rules followed
- New standalone project; no other projects were touched. No key files were searched for, read, or displayed.
- No secret-key input or storage in the app. The test signer is a **mock** using throwaway keys generated in memory for each run.

## Results
| check | result | evidence |
|---|---|---|
| Typecheck (tsc 5.9.3 strict) | pass | `pnpm typecheck` |
| Unit tests (node:test, 9 tests: NIP-19 vector, id vs independent sha256, honest sign OK, tampered recipient/extra p/content/kind1/author/created_at rejected, bad id/sig/garbage rejected, incoming filter, relay URL validation) | 9/9 pass | `pnpm test` |
| pnpm audit / audit --prod | No known vulnerabilities | `audit.txt` |
| Publish age of all 31 locked pkgs + pnpm | all ≥ 7d (min 90d), integrity == registry | `dependency-ages.txt` |
| minimumReleaseAge actually rejects young version | yes: `ERR_PNPM_NO_MATURE_MATCHING_VERSION`; control with 0 resolves | `minimum-release-age-test.txt` |
| Reproducible build: clean clone + frozen lockfile → identical sha256 as local | yes | `public-http.txt` hashes |
| Kind collision check | 7107 already used by another app; switched to 7117 (0 events on 7 relays) | `kind-selection.md` |
| Local browser E2E (headless Chrome, **mock NIP-07**, **real relays**) | send OK (4/4 relays accepted on final run), receiver B shows the Yo, swap-recipient & kind1 signers refused before publish, only same-origin HTTP loads | `browser-local/` |
| GitHub Pages HTTP | 200 for index/app.js/style.css, served sha256 == clean build | `public-http.txt` |
| Public browser E2E (mock NIP-07, real relays) | send OK 3/4 (relay.damus.io failed to connect: HTTP 503 handshake, shown honestly as failure), B received, tamper cases refused | `browser-public/` |
| Public site with no extension | shows "未検出" + clear error, send refused | `public-no-extension.txt` |

## Problems found during the work
- Go/Wasm was started, then the owner withdrew it (e2240). The unused go.mod was moved out of the project to the workspace `tmp/nostr-yo-go-abandoned/`.
- yabu.me answered `OK` only after ~18.6 s. With the first 8 s timeout this showed up as a false failure. The timeout is now 25 s, and the failure message says the relay may still have stored the event.
- relay.damus.io sometimes returned 503 / failed the WebSocket handshake (seen from Node too). That is on the relay side. The UI shows it as an error.
- Kind 7107 collided with another app (see above).
- Missing favicon caused a 404 console error; an empty data: icon was added.

## Not verified
- **No real NIP-07 extension (nos2x/Alby etc.) was used.** All signing in the browser tests went through the test mock. The UI path is the same `window.nostr.getPublicKey/signEvent` interface, but behaviour specific to each extension (permission popups, timing of injection) is untested.
- Mobile browsers and Firefox/Safari: not tested (only Chrome headless, macOS).
- Dependency source code was not reviewed by hand. Audit only covers published advisories.
- Kind 7117 being unused was only checked on 7 relays at one moment.
- Long-running behaviour (relay disconnects; there is no auto-reconnect) was not tested.
- Test Yo events from throwaway keys (a few kind 7117/7107 events) stay on public relays.
