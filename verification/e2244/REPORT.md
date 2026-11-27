# e2244 — default relay change (2026-11-27 UTC)

Change: default relays are now, in this order, `wss://r.kojira.io`, `wss://yabu.me`,
`wss://x.kojira.io`, `wss://n.kojira.io` (moved into `src/config.ts`). A saved
localStorage list (`nostr-yo:relays`) is still kept as-is; the defaults are used only
when nothing valid is saved.

| check | result |
|---|---|
| Typecheck / unit tests | pass, 11/11 (added: exact default list and order; saved-list resolution: kept / invalid and duplicate entries dropped / empty, corrupt or non-array → defaults) |
| Supply chain | no dependency changes: package.json, lockfile, pnpm-workspace.yaml (minimumReleaseAge 10080) and .npmrc untouched; `pnpm install --frozen-lockfile` OK; audit: no known vulnerabilities (`audit.txt`) |
| Clean-clone build → gh-pages | deployed from main 853e347, gh-pages d91fa09; served sha256 == build (`public-http.txt`) |
| Public site, new browser profile | 4 relays shown in the given order, all "open"; nothing saved until the user edits (`relay-settings-public.json`/`.png`) |
| Saved setting kept | an old saved list [nos.lol, damus] still shows after the update; a UI remove/add persists across reload; empty/cleared storage → defaults |
| Public E2E (mock NIP-07, real relays) | send 4/4 `OK true`; receiver got the Yo; swap-recipient / kind1 signers refused (`browser-public/`) |
| Same on local build | same results (`relay-settings-local.json`, `browser-local/`) |

Notes / unverified:
- n.kojira.io sends a NIP-42 AUTH challenge. The app doesn't implement AUTH, but the relay still accepted events and served the inbox in these tests. Behaviour may change if the relay policy changes.
- Still no real NIP-07 extension tested (mock only).
- Users who had already saved a list do not get the new defaults automatically (intended; clear site data to reset).
- Test Yo events from throwaway keys were published to these 4 relays.
