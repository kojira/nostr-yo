# Yo! on Nostr (nostr-yo)

Send a single "Yo!" to any npub over Nostr. That's it.

**Live:** https://kojira.github.io/nostr-yo/

- Static site (TypeScript → one bundled `app.js`), served from GitHub Pages.
- Signing only via a **NIP-07** browser extension (nos2x, Alby, nostr-keyx …).
  This site never asks for, stores, or handles a secret key.
- Relays are talked to directly from your browser over WebSocket.

## Protocol spec: Yo = custom-emoji reaction to the recipient's profile

Since 2026-11-27, a Yo is a **NIP-25 reaction (kind 7)** that uses the **NIP-30 custom
emoji `:yo:`** and targets the recipient's **latest kind 0 (profile) event**.
The spec was written against the NIP-25 / NIP-30 text at nostr-protocol/nips `bec0fc8`
(copies in `verification/e2250/`).

| field | value |
|---|---|
| `kind` | `7` |
| `content` | exactly `":yo:"` (one shortcode only, as NIP-25 requires) |
| `e` | `["e", <kind0 id>, <relay hint>, <recipient pubkey>]`, exactly one |
| `p` | `["p", <recipient pubkey>, <relay hint>]`, exactly one |
| `k` | `["k", "0"]` |
| `emoji` | `["emoji", "yo", "https://kojira.github.io/nostr-yo/yo.png"]`, exactly one. The image is served from this site. |
| `a` | not used: kind 0 is replaceable, not addressable |

The relay hint is the relay where the kind 0 was found.

**Sending**
1. Query `{"kinds":[0],"authors":[to],"limit":1}` on every configured relay.
2. Keep only events with a valid id and signature, `kind 0` and `pubkey == to`. Take the newest `created_at`; on a tie, the lowest id (NIP-01).
3. If nothing valid is found, the UI says so and nothing is signed. It also says whether every relay failed or whether there simply is no profile, with a count per relay.
4. The extension signs the event. The returned event must match the request exactly: kind, content, every tag, created_at, author pubkey, plus a valid id and signature. Otherwise nothing is published and the UI lists the mismatches.

**Receiving**
- Query: `{"kinds":[7],"#p":[me],"#k":["0"],"limit":50}`.
- An event is accepted only if all of these hold:
  - valid id and signature, `kind 7`, `content == ":yo:"`;
  - exactly one `emoji` tag, exactly `["emoji","yo",<our URL>]`;
  - exactly one `p` tag, equal to me;
  - `k == "0"`;
  - exactly one `e` tag, a 64-hex id, and if it carries a pubkey hint, that hint is me;
  - no `a` tag;
  - `created_at` no more than 10 minutes in the future.
- Everything else is dropped and counted as "rejected". Plain `+` likes and other custom emojis are never treated as a Yo.
- The app also loads my own kind 0 events. A Yo whose `e` points to one of them is labelled "kind0 一致"; otherwise it is labelled "kind0 未確認" (for example, a reaction to an older version of my profile that we didn't load).
- The emoji image is always our own `yo.png`. The URL inside the event is compared but never loaded, and CSP `img-src 'self'` enforces this.

**Retired format, kind 7117 (2026-11-26 – 2026-11-27).** The old Yo was `kind 7117, content "Yo!", ["p", to]`. It is no longer sent or read. Old 7117 events stay on relays and are simply ignored.

**Existing Nostr clients: not verified, no promises.** Other clients may or may not show these reactions or notify the recipient. That is out of scope (owner instruction e2251) and was not tested.

Note: Yo events are **public** (not encrypted). Anyone can see that A sent a Yo to B.

## Default relays

In this order (`src/config.ts`):

1. `wss://r.kojira.io`
2. `wss://yabu.me`
3. `wss://x.kojira.io`
4. `wss://n.kojira.io`

The defaults apply only when there is no saved relay list. Once you add or remove a
relay, the list is saved in `localStorage` (`nostr-yo:relays`), and from then on it
is kept as-is, including over a change of defaults. Invalid or duplicate entries are
dropped. If the saved value is empty or corrupt, the app falls back to the defaults.
To get the new defaults back, clear the site data.

Note: `n.kojira.io` sends a NIP-42 `AUTH` challenge on connect, and nostr-yo does not
implement NIP-42. In the 2026-11-27 tests the relay still accepted Yo events (`OK true`)
and served the inbox query. If a relay ever refuses for lack of AUTH, the UI shows its
`OK false` / `CLOSED` message as a failure.

## Security notes

- Received data is shown with `textContent` only; it is never parsed as HTML.
  Content must be exactly "Yo!" anyway.
- CSP meta: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src wss: ws://localhost:*…`.
  No inline scripts, and no third-party scripts, fonts or CDNs.
- Relay URLs must be `wss://` (`ws://` is allowed only for localhost) and must not contain credentials.
- The relay list is the only thing stored in `localStorage`.
- Crypto is not hand-rolled: `@noble/curves` (Schnorr), `@noble/hashes` (sha256), `@scure/base` (bech32).

## Supply chain

| measure | how |
|---|---|
| Few dependencies | 3 runtime deps (`@noble/curves`, `@noble/hashes`, `@scure/base`, all by paulmillr, audited libs, 0 transitive deps outside this set), 2 dev deps (`esbuild`, `typescript` 5.9.3). Lockfile has 31 packages total, 26 of them esbuild platform binaries (only the host one gets installed). No `@types/node`: a small local type shim is used instead. |
| Exact versions | Exact versions in `package.json`, `.npmrc save-exact=true`, `pnpm-lock.yaml` committed, `--frozen-lockfile` for clean builds. |
| Package manager pinned | `"packageManager": "pnpm@10.34.9+sha512.…"` (corepack checks the hash). |
| **minimumReleaseAge** | `pnpm-workspace.yaml`: `minimumReleaseAge: 10080` (7 days). No `minimumReleaseAgeExclude`, so there are no exceptions. **Tested:** asking for `typescript@7.1.0-dev.20261126.1` (17 h old) failed with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`. The same request with the setting at 0 resolved, which shows the setting is what blocked it (`verification/minimum-release-age-test.txt`). |
| Publish dates checked | Since the setting does not re-check an existing lockfile, the npm publish time of all 31 locked packages and pnpm itself was checked by hand. All are ≥ 7 days old (youngest: `@scure/base@2.4.0`, 90 days), and the lockfile integrity matches the registry for each (`verification/dependency-ages.txt`). |
| Lifecycle scripts | `.npmrc ignore-scripts=true`, plus pnpm 10's default of not running dep build scripts (`onlyBuiltDependencies: []`). esbuild's `postinstall` does not run; its platform binary comes in as an optional dependency. |
| Known vulns | `pnpm audit` and `pnpm audit --prod`: "No known vulnerabilities found" (2026-11-27, `verification/audit.txt`). |
| Reproducible | A clean clone with `pnpm install --frozen-lockfile` and `pnpm build` gives byte-identical `dist/` (sha256 printed by the build). |
| No runtime CDN | The bundle loads no remote code. The only network use is WebSocket to the relays you choose. |
| Deployment | **No GitHub Actions, so no third-party Actions.** A locally built `dist/` is pushed to the `gh-pages` branch, and Pages serves that branch. No secrets involved. |

Remaining supply-chain risks (not hidden):
- `pnpm audit` only knows about advisories that have been published. A 7-day age gate lowers the risk of a freshly compromised release but does not remove it.
- No one has reviewed the dependency source code by hand for this project. Trust rests on the libraries' reputation, the registry integrity hashes and the age gate.
- Tooling outside the lockfile — Node 22 (mise-managed), corepack, macOS Chrome used for testing — is not covered by the lockfile or the age gate.
- Because there's no CI, the published build comes from the maintainer's machine. Anyone can reproduce it with the steps below and compare hashes.

## Build & test

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test           # node:test unit tests (throwaway keys)
corepack pnpm build          # → dist/ (prints sha256 of each file)
node scripts/browser-verify.mjs http://127.0.0.1:8765/ verification/browser-local
sh scripts/deploy.sh         # clean-clone build -> force-push dist/ to gh-pages
```

`scripts/browser-verify.mjs` drives headless Chrome through CDP. It injects a
**test-only NIP-07 mock** (throwaway keys made per run, never stored, never
shipped). The script:
- publishes a test kind 0 profile for B;
- has A send a `:yo:` reaction to it over the real default relays and checks that B receives it, labelled "kind0 一致";
- checks that a recipient with no kind 0 is refused;
- checks that a tampering signer (recipient / target / emoji URL swap, or kind 1) is refused.

This is not a test with a real NIP-07 extension.

## Limitations

- No automatic reconnect: a relay that errors stays "エラー" until you reload.
- If a relay never sends an `OK`, the send times out after 25 s and is shown as a failure,
  even though the relay may have stored the event anyway.
- No spam controls beyond the strict format. Anyone can Yo anyone.
- You can't Yo someone who has no kind 0 profile on the configured relays.
- The emoji image is only the 256×256 `yo.png` on this site. If its URL ever changes, older Yo events will stop matching the receive filter.
