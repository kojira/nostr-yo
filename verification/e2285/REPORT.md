# e2285: tap the name to open/close details (2026-11-27)

Deployed: main `fa1449b` → gh-pages `ef057f1` (clean-clone build). The served sha256 of all 4 files matches the build (`public-http.txt`).

## Changes (the e2273 simple UI is kept)
- Inbox card: the separate "詳細" `<details>/<summary>` row is gone. Icon, name and date/time form one real `<button type=button>` with `aria-expanded` and `aria-controls` pointing to the details panel. Tapping it, or pressing Enter/Space, opens or closes the same details: the npub, plus the "他のアプリから（絵文字…）" note.
  - A small ▾ marks the button (aria-hidden).
  - The open state and keyboard focus survive re-renders.
- Menu account: the "公開鍵 (npub)" summary row is gone. The name after "ログイン中:" is a button with aria-expanded that opens and closes the npub.
- Unchanged:
  - the reply button (a separate button; the name button never signs or replies);
  - date/time `<time>`;
  - the search pick's sub-line (short npub for same-name results);
  - the send box's "リレーごとの結果" (not a person entry);
  - verification, login keeping, logout, relay settings, 16 px inputs, overflow handling.
- No dependency or protocol changes. Only src/main.ts, web/index.html and web/style.css changed.

## Tests
- typecheck, unit 25/25.
- `scripts/browser-verify-e2285.mjs`: the full e2273 regression plus 23 new checks. Local **81/81**, public **81/81**.
  - Setup: headless Chrome 390×844, DPR 3, touch, iOS UA, test NIP-07 mock, real relays, throwaway keys.
  - New checks:
    - no details/summary row, and a closed row is one line (2 visible children);
    - the name is a real button and the AX tree shows button + name + expanded=false;
    - touch tap opens and closes; Enter opens and Space closes, with focus kept;
    - other rows stay closed; the state survives a re-render;
    - no overflow with details open; date/time still shown;
    - no signature, no getPublicKey, no row note or status from toggling;
    - the same checks for the menu name.
- Relay settings, public: 6/6 (`relay-settings-public.json`).

## Not verified
- Real iOS Safari/WebKit and VoiceOver: emulation plus the Chrome AX tree only.
- A real NIP-07 extension: mock only.
- Test events from throwaway keys remain on the relays.
