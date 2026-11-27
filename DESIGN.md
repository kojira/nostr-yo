# nostr-yo 設計メモ（実装前）

## 経緯
- 当初 Go+Wasm 指定 → owner指示 e2240 で TypeScript に切替（Go の go.mod は未使用のまま退避）。
- e2241 で minimumReleaseAge（7日=10080分）を必須化。

## 目的
Nostr で「Yo!」だけを送り合う静的Webアプリ。GitHub Pages で配信。

## 構成
- TypeScript → esbuild で単一 `app.js` にバンドル。CDN からのコード動的読込なし。
- 署名は NIP-07 (`window.nostr`) のみ。秘密鍵の入力・保存は実装しない。
- 暗号は自作しない: `@noble/curves`(schnorr検証), `@noble/hashes`(sha256), `@scure/base`(bech32)。
- relay 通信はブラウザ標準 WebSocket で自前の最小実装（NIP-01 の EVENT/REQ/OK/EOSE/CLOSED/NOTICE）。

## イベント設計
- kind `7117`（regular, 1000–9999。2026-11時点の公式NIP一覧に未登録のアプリ独自kind）。kind1 は使わない＝タイムラインを汚さない。
- content は固定 `"Yo!"`。
- tags: `["p", <宛先hex>]` を正確に1つ、`["alt", "Yo! sent with nostr-yo"]`（NIP-31）。
- 受信: `REQ {kinds:[7117], "#p":[自分], limit:50}`。

## 検証
- 送信前: NIP-07 が返したイベントの kind / content / tags / created_at / pubkey が依頼内容と一致、id 再計算一致、schnorr 署名検証OK でなければ送らない。
- 受信: id・署名検証、kind/content/p タグ（自分宛）を確認し、不一致は破棄。表示は textContent のみ（HTMLとして解釈しない）。CSP meta で script-src 'self'。

## UI
- 大きな「Yo!」ボタン、npub 入力、relay ごとの接続状態と OK/失敗/タイムアウトを正直に表示、受信 Yo 一覧。

## 供給網対策
- pnpm（corepack, packageManager に版+hash固定）、`minimumReleaseAge: 10080`、厳密バージョン、lockfile コミット、lifecycle script 無効、`pnpm audit`。
- 配信は GitHub Actions を使わず、クリーンビルドした dist を gh-pages ブランチへ push（第三者 Action ゼロ、秘密不要）。

## テスト
- node:test で純粋関数（bech32, id計算, 署名検証, 署名内容検証, 受信フィルタ）。
- ブラウザ: Chrome headless + CDP（Node標準WebSocket、追加依存なし）。テスト専用 NIP-07 モック（使い捨て鍵、配信物に含めない）で実 relay への送受信を確認。実拡張での確認は別扱い。

---
## e2250 redesign (2026-11-27): Yo = NIP-25 kind 7 custom-emoji reaction to the recipient's kind 0

Sources checked: NIP-25 and NIP-30 text at nostr-protocol/nips master bec0fc8 (copies in verification/e2250/).

- Look up the recipient's latest kind 0: `{"kinds":[0],"authors":[to],"limit":1}` on every relay. Keep only events with a valid signature, `kind==0` and `pubkey==to`; take the newest `created_at` (on a tie, the lowest id, as NIP-01 says). If there is none, or every relay fails, say so in the UI and do not send.
- Event: `kind 7`, `content ":yo:"`, tags:
  `["e", <kind0 id>, <relay hint>, <to>]`, `["p", <to>, <relay hint>]`, `["k","0"]`,
  `["emoji","yo","https://kojira.github.io/nostr-yo/yo.png"]` (exactly one emoji tag; image served by this site).
  No `a` tag: kind 0 is replaceable, not addressable (30000–39999). No extra e/p tags.
- Sender: the signed event must match the request exactly (kind, content, every tag, created_at, pubkey), and the id and signature must be valid.
- Receiver: REQ `{"kinds":[7],"#p":[me],"#k":["0"]}`. Accept only: valid id and signature, kind 7, content exactly `:yo:`, exactly one emoji tag equal to ours (shortcode yo + our URL), exactly one p tag equal to me, exactly one e tag (64-hex id, pubkey hint equal to me), `k == "0"`, and created_at not more than 10 minutes in the future.
  If the e id matches one of my kind 0 events that we know, the Yo is marked "target confirmed".
- The old kind 7117 is retired: no longer sent or read. Old events stay on relays.
- Existing Nostr clients are out of scope (owner e2251): no claim is made about how they display or notify these reactions.
