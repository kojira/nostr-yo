# Yo! on Nostr (nostr-yo)

Send a single "Yo!" to any npub over Nostr. That's it.

**Live:** https://kojira.github.io/nostr-yo/

- Static site (TypeScript → one bundled `app.js`), served from GitHub Pages.
- Signing only via a **NIP-07** browser extension (nos2x, Alby, nostr-keyx …).
  This site never asks for, stores, or handles a secret key.
- Relays are talked to directly from your browser over WebSocket.

## Protocol spec: the Yo event

| field        | value |
|--------------|-------|
| `kind`       | **7117** (regular event, 1000–9999 range → relays store it) |
| `content`    | exactly `"Yo!"` |
| `tags`       | `[["p", <recipient pubkey hex>], ["alt", "Yo! (a one-word ping sent with nostr-yo)"]]` — exactly one `p` tag |
| `created_at` | unix seconds at send time |

Example (unsigned):

```json
{ "kind": 7117, "content": "Yo!",
  "tags": [["p", "3bf0c63f…459d"], ["alt", "Yo! (a one-word ping sent with nostr-yo)"]],
  "created_at": 1795000000 }
```

Why not kind 1: kind 1 is the public text-note timeline. A Yo is a tiny ping
to one person, so a dedicated kind keeps it out of everyone's timeline. Clients
that don't know kind 7117 will ignore it, or show the NIP-31 `alt` text.

Why 7117: it is not in the official NIP kind list (checked 2026-11-27). Our first
pick, 7107, turned out to be in use by another app ("satminer") on relays, so we
scanned other candidates on 7 relays and moved to 7117 (0 events seen). See
`verification/kind-selection.md`. This is an app-specific kind, not a NIP.

**Inbox query:** `["REQ", sub, {"kinds":[7117], "#p":[<my pubkey>], "limit":50}]`

**Receiver acceptance rules** (anything else is dropped and counted as "rejected"):
1. id = sha256 of the NIP-01 serialization, and a valid BIP-340 Schnorr signature;
2. `kind == 7117`, `content == "Yo!"`;
3. exactly one `p` tag, and it equals my pubkey;
4. `created_at` is no more than 10 minutes in the future.

**Sender checks** (before publishing): the event the NIP-07 extension returns must have
the same kind / content / tags / created_at that was requested, `pubkey` equal to the
extension's `getPublicKey()`, a correct id and a valid signature. If any check fails,
nothing is sent and the UI says why. This catches a signer that swaps the recipient or
the kind.

Note: Yo events are **public** (not encrypted). Anyone can see that A sent a Yo to B.

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
shipped). With it, the script sends a Yo between two pages over real public relays,
checks that the receiver sees it, and checks that a tampering signer
(recipient swap / kind 1) gets refused.

## Limitations

- No automatic reconnect: a relay that errors stays "エラー" until you reload.
- If a relay never sends an `OK`, the send times out after 25 s and is shown as a failure,
  even though the relay may have stored the event anyway.
- No spam controls beyond the strict format. Anyone can Yo anyone.
