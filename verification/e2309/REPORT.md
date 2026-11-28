# e2309: send history (送った Yo)

## Change
- `src/yo.ts`: the SPEC rules 1–6 check moved into a shared `parseYoShape`. `parseIncomingYo` behaves the same as before. New `parseSentYo` (author == me; recipient = the single `p` tag) and `sentYoFilter` (`{"kinds":[7],"authors":[me],"#k":["0"],"limit":50}`, no `#t`).
- `src/main.ts` / `web/index.html` / `web/style.css`: the history card now has two tabs, 届いた Yo (default) and 送った Yo. Each sent row shows the recipient's icon, name, and date and time; the npub is behind the name button. A new `yo-sent` subscription is created and removed with the account. A local addition happens only after ≥1 relay replied OK, and only if the account generation has not changed.
- The send event format is unchanged (kind 7, `:yo:`, e/p/k/emoji/t).

## Tests
- typecheck OK; unit tests 27/27 (2 new: sentYoFilter, parseSentYo).
- `scripts/browser-verify-e2309.mjs` (headless Chrome 390×844, local mock relay, TEST-ONLY NIP-07 mock with throwaway keys):
  - local `browser-local/`: **34/34**;
  - public `browser-public/`: **34/34**, run with `LNA_OFF=1`.
  - What the checks cover:
    - tabs, including the keyboard;
    - only valid own Yo are shown (a plain like, a `t=yo`-only event and a forged signature are excluded), newest first;
    - an untagged Yo is included;
    - icon, name and date/time are shown;
    - an accepted send appears;
    - a relay-rejected send and a cancelled signature do not appear;
    - after a reload, history comes back from the relay without calling the extension;
    - switching A→B with B's history query delayed shows nothing from A and resets the tab;
    - a late answer after logout is not shown;
    - logging in as A again shows A's history;
    - exact filter shape.
- e2290 regression (inbox, follow search, avatars, account switch/logout): local `regression-e2290-local/` **33/33**, public `regression-e2290-public/` **33/33**.
- Served files == local build (sha256): `public-http.txt`.

## Not verified
- A real NIP-07 extension: mock only.
- Real iOS Safari/WebKit: Blink emulation only.
- Real relays and the owner's real sent Yo: the mock relay only. The full e2285 real-relay regression was not rerun; e2290 covers the inbox and switch paths.
- Only the newest 50 sent Yo per relay are fetched; there is no paging into older history.
