# Yo! on Nostr (nostr-yo)

Send a single "Yo!" to any npub over Nostr. That's it.

**Live:** https://kojira.github.io/nostr-yo/

- Static site (TypeScript → one bundled `app.js`), served from GitHub Pages.
- Signing only via a **NIP-07** browser extension (nos2x, Alby, nostr-keyx …).
  This site never asks for, stores, or handles a secret key.
- Relays are talked to directly from your browser over WebSocket.

## Screen & login (e2273, 2026-11-27)

- **Simple UI.** Compact header (logo, your icon/name, ☰ menu). After login the first view shows the received Yo, newest first: icon, name, date and time, and a "Yo! を返す" button. The send box follows.
  Technical details (signature checks, kind 0 matching, follow/query counts, "reply to npub…" lines) are no longer shown. **All verification still runs internally**: invalid events are silently dropped. npubs live in a collapsed "詳細" section.
- **Menu (☰).** Account (npub inside "詳細", "拡張のアカウントで入り直す", **ログアウト**) and relay settings (add/remove; defaults unchanged).
- **Remembered login.** Only `{"v":1,"pubkey":<hex>}` is stored in `localStorage` (`nostr-yo:session`). Anything else in that key is refused. No secret key, token or signature is ever stored.
  - Reload, reopening or returning from the background restores the inbox read-only, **without calling the extension**. Relays reconnect on `visibilitychange`, `pageshow` and `online`.
  - Remembering the pubkey is not a signing permission. Each send/reply is a user tap. Before signing, the app asks the extension for its current key; if it differs, nothing is signed and "拡張のアカウントが違います" is shown with a "切り替える" button.
  - With no extension, the page says so ("拡張が見つかりません（受信の表示のみ）") and never claims it can send. Late-injected extensions are waited for (≈4 s).
  - **Logout** removes the stored pubkey, clears the inbox and search, and stops subscriptions. Nothing is restored on reload. Logging out or switching in another tab is followed via the `storage` event.
- **iPhone.** All inputs are 16 px or larger, so iOS does not zoom on focus. The viewport still allows pinch zoom (no `maximum-scale` / `user-scalable=no`). Long names are ellipsized, and the layout has no horizontal overflow at 390 px.

## Protocol spec

**The shared Yo reaction convention is in [`SPEC.md`](SPEC.md).** It is a convention proposed by this project, not an adopted NIP.

In short, a Yo is:
- a NIP-25 kind 7 reaction, `content ":yo:"`;
- with tags `e` (the recipient's latest kind 0), `p` (the recipient), `k=0`, the NIP-30 `["emoji","yo",<https URL>]`, and `["t","yo"]`.

Receivers accept **any https emoji URL from any implementation, but never fetch it**; nostr-yo always shows its own `yo.png`. A `t=yo` tag is neither required nor sufficient, so:
- Yo events sent by nostr-yo before the `t` tag existed are still recognised;
- an event with only `t=yo` but missing other rules is rejected.

In the inbox, a Yo whose emoji URL is not ours is noted inside the row's collapsed "詳細" section.

**Sending (nostr-yo)**
1. Look up the recipient's newest kind 0 whose signature checks out. If there is none, say so and don't sign.
2. Build the event and have the NIP-07 extension sign it.
3. Strictly check the signed result (kind, content, every tag including `t`, time, author, id, signature) before publishing.

**Yo back.** Every received Yo has a "Yo! を返す" button.
- The recipient is the **author pubkey of the verified event**, never a tag value.
- It reuses the send path above and needs a click plus a NIP-07 signature; there are no auto-replies.
- While a send is in progress, all Yo buttons are disabled. The row shows short progress and the result (the npub is in "詳細").

**Pick a recipient from your follows.** After login, the app loads your newest verified kind 3 (read-only: it never publishes kind 3 or changes follows).
- **Loading profiles:** follows' kind 0 are fetched in batches of 150 authors, relay by relay. Each relay is only asked for profiles still missing, with at most 2 requests in flight, and the UI yields between batches. Test: 404 follows took 16 queries in total.
- **What's used from a profile:** only `name`, `display_name` and `nip05`, as untrusted strings. Control/bidi characters are removed, length is capped, and everything is shown with `textContent`. Pictures and `about` are not used.
- **Searching:** matches name, display name, nip05 and npub (case- and width-insensitive). A short npub is shown only for same-name results or results without a profile.
- **Choosing a result:** clicking one fixes that pubkey as the recipient. Editing the field by hand clears the choice; typing an npub manually still works.
- **States:** short messages for loading, failed, and no or empty follow list. Counts are not shown. Follows without a profile can be found by npub only.

**Sender icons and names.** The inbox and the follow search show each person's icon and display_name/name, taken from their newest verified kind 0.
- Profiles the follow loader already has are reused. Unknown senders are looked up in batches, at most once each.
- Names are untrusted text, shown with `textContent`.
- The npub is in the row's collapsed "詳細" section. The Yo back target stays fixed to the event author.
- No profile, a failed lookup, no picture, an invalid picture URL, or an image that fails to load → a built-in letter avatar.

**Privacy note (profile pictures).** Showing a `picture` means your browser fetches that image from whatever host the profile points to. That host sees your IP address and the time.
- Mitigations:
  - only plain `https://` URLs are allowed (no credentials, whitespace or quotes, ≤ 1024 chars);
  - images are fetched with `referrerpolicy="no-referrer"` (no Referer header) and loaded lazily;
  - images are normal display-only `<img>` requests without `crossorigin`, so hosts that send no CORS headers still work. Because of this, the browser may send that host's own cookies, depending on its third-party cookie settings;
  - CSP limits images to `'self' data: https:`.
- The emoji URL inside a Yo event is **still never fetched**; the app always shows its own `yo.png`.

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
- CSP meta: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src wss: ws://localhost:*…`. Profile pictures (https) are the only third-party requests.
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
| No runtime CDN | The bundle loads no remote code. Network use: WebSocket to the relays you choose, plus https profile images (see the privacy note). |
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
- Follow search loads at most 5000 follows; anything beyond is noted as truncated. Kind 3 lists are not refreshed until you reload.
- You can't Yo someone who has no kind 0 profile on the configured relays.
- The emoji image is only the 256×256 `yo.png` on this site. If its URL ever changes, older Yo events will stop matching the receive filter.
