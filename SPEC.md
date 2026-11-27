# Yo reaction convention (nostr-yo) — fixed 2026-11-27

Status: a **convention proposed by this project**. It is **not an adopted NIP**.
It is built on NIP-25 (reactions) and NIP-30 (custom emoji).

## Event a sender publishes
```json
{
  "kind": 7,
  "content": ":yo:",
  "tags": [
    ["e", "<recipient's latest kind 0 id>", "<relay hint>", "<recipient pubkey>"],
    ["p", "<recipient pubkey>", "<relay hint>"],
    ["k", "0"],
    ["emoji", "yo", "<https image URL of the sender's choice>"],
    ["t", "yo"]
  ]
}
```
- The target is the recipient's newest kind 0 whose signature checks out (the sender looks it up first).
- `["t","yo"]` is RECOMMENDED. nostr-yo always sends it.
- nostr-yo uses the image URL `https://kojira.github.io/nostr-yo/yo.png`. Other implementations may use their own https image.

## How a receiver decides "this is a Yo" (all must hold)
1. The id and signature are valid, `kind == 7`, and `content` is exactly `:yo:`.
2. There is exactly one `emoji` tag. Its shortcode is `yo` and its URL is **any** valid `https://` URL with no credentials and at most 2048 characters.
   **Receivers SHOULD NOT fetch that URL.** nostr-yo always shows its own local image.
3. There is exactly one `p` tag, and it is the receiver.
4. There is exactly one `e` tag, a 64-hex id. If it has a pubkey hint, the hint is the receiver.
5. There is a `k` tag equal to `"0"`, and there is no `a` tag.
6. `created_at` is no more than 10 minutes in the future.

A `t=yo` tag is **neither required nor sufficient**:
- An event that fails any rule above is not a Yo, even if it has `t=yo`. This prevents false positives from the tag alone.
- Yo events sent by nostr-yo before 2026-11-27 had no `t` tag, and they are still Yo.

Optional extra check: if the `e` id matches one of the receiver's own known kind 0 events, the Yo can be marked as confirmed.

## Discovery filter
`{"kinds":[7], "#p":[<me>], "#k":["0"]}`.
Where a relay supports it, `"#t":["yo"]` can be added to narrow the results. Doing so misses Yo events without the tag.

## Replying
A reply ("Yo back") is an ordinary Yo to the **author pubkey of the verified received event**. It is sent only when the user acts and signs it. Recipients are never taken from tags.

## Retired format
`kind 7117` (2026-11-26–27, nostr-yo only). It is no longer sent or recognised.
