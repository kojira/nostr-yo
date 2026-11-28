# e2310: Yo again from send history

## Change
- `src/main.ts`: each 送った Yo row gets a "もう一度 Yo!" button. The recipient is the row's verified `p` pubkey (from `parseSentYo`). The button calls the shared `sendYoTo` with row id `s:<id>`. That gives it the same behaviour as "Yo! を返す":
  - all Yo buttons are disabled while sending;
  - the extension account is checked first;
  - there is an account-generation abort;
  - progress and errors are shown on the row;
  - the history entry is added only after ≥1 relay OK.
- The event format is unchanged.

## Tests
- typecheck OK; unit tests pass (unchanged).
- `scripts/browser-verify-e2310.mjs` (headless Chrome 390×844, local mock relay, TEST-ONLY NIP-07 mock): local `browser-local/` **16/16**, public `browser-public/` **16/16** (`LNA_OFF=1`).
  - What the checks cover:
    - the buttons and their recipients;
    - a double click signs once and all buttons are disabled while sending;
    - the Yo format;
    - a successful send is added at the top;
    - a relay reject shows a row error and adds nothing;
    - an extension account mismatch is refused unsigned;
    - an account switch mid-send leaves the send unsigned, shows only B's history, and leaves the buttons usable.
- e2309 regression (local): 33/34. The only failure is `sentRowsHaveNoReplyButton`, which is now intentionally false.
- Served files == local build (sha256): `public-http.txt`.

## Not verified
Real NIP-07 extension, real iOS Safari, real relays. No real Yo was sent.
