import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  LEGACY_KIND, YO_EMOJI_URL, YO_KIND, acceptIncomingYo, buildYo, checkSignedYo, computeEventId, normalizeRelay,
  parseIncomingYo, parsePubkey, pickLatestProfile, profileFilter, toNpub, verifyEventSignature, yoFilter,
  type NostrEvent, type ProfileTarget, type UnsignedEvent,
} from "../src/yo.js";
import { DEFAULT_RELAYS, resolveRelayUrls } from "../src/config.js";

// Throwaway test keys generated in-process (never persisted).
const skA = schnorr.utils.randomSecretKey();
const pkA = bytesToHex(schnorr.getPublicKey(skA));
const skB = schnorr.utils.randomSecretKey();
const pkB = bytesToHex(schnorr.getPublicKey(skB));

function sign(e: UnsignedEvent, sk: Uint8Array): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const id = computeEventId({ ...e, pubkey });
  return { ...e, pubkey, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
}

test("NIP-19 known vector (NIP-19 spec example)", () => {
  const hex = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
  const npub = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";
  assert.equal(toNpub(hex), npub);
  assert.equal(parsePubkey(npub), hex);
  assert.equal(parsePubkey("  " + npub.toUpperCase() + " "), hex);
  assert.equal(parsePubkey(hex.toUpperCase()), hex);
});

test("parsePubkey rejects bad input", () => {
  assert.throws(() => parsePubkey("npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w7"));
  assert.throws(() => parsePubkey("nsec1xyz"));
  assert.throws(() => parsePubkey("hello"));
  assert.throws(() => parsePubkey("<img src=x onerror=alert(1)>"));
  // x not on curve
  assert.throws(() => parsePubkey("0000000000000000000000000000000000000000000000000000000000000000"));
});

test("NIP-01 id matches an independent sha256 of the canonical serialization", () => {
  const e = { pubkey: "a".repeat(64), created_at: 1, kind: 7117, tags: [["p", "b"]], content: 'he"llo\n\u2028日本' };
  const ser = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
  assert.equal(computeEventId(e), createHash("sha256").update(ser).digest("hex"));
});

const RELAY = "wss://r.kojira.io";
function profileOf(sk: Uint8Array, created_at: number, name = "b"): NostrEvent {
  return sign({ kind: 0, created_at, tags: [], content: JSON.stringify({ name }) }, sk);
}
function targetOf(p: NostrEvent): ProfileTarget {
  return { id: p.id, pubkey: p.pubkey, created_at: p.created_at, relay: RELAY };
}
const profB = profileOf(skB, 1690000000);
const tB = targetOf(profB);

test("buildYo: NIP-25 kind 7 + NIP-30 emoji reaction to kind 0", () => {
  const e = buildYo(tB, 1700000000);
  assert.equal(e.kind, 7);
  assert.equal(YO_KIND, 7);
  assert.equal(e.content, ":yo:");
  assert.deepEqual(e.tags, [
    ["e", profB.id, RELAY, pkB],
    ["p", pkB, RELAY],
    ["k", "0"],
    ["emoji", "yo", "https://kojira.github.io/nostr-yo/yo.png"],
  ]);
  assert.equal(YO_EMOJI_URL, "https://kojira.github.io/nostr-yo/yo.png");
  assert.equal(e.tags.filter((t) => t[0] === "a").length, 0, "kind 0 is not addressable: no a tag");
  assert.throws(() => buildYo({ ...tB, id: "x" }));
});

test("pickLatestProfile: newest verified kind 0 of the author only", () => {
  const old = profileOf(skB, 1000, "old");
  const newer = profileOf(skB, 2000, "new");
  const forged = { ...profileOf(skB, 9999, "forged"), content: "{\"name\":\"evil\"}" }; // bad id
  const otherAuthor = profileOf(skA, 5000, "a");
  const notKind0 = sign({ kind: 1, created_at: 8000, tags: [], content: "x" }, skB);
  const got = pickLatestProfile([old, forged, otherAuthor, notKind0, newer].map((ev) => ({ ev, relay: "wss://x" })), pkB);
  assert.equal(got?.id, newer.id);
  assert.equal(got?.relay, "wss://x");
  assert.equal(pickLatestProfile([], pkB), null);
  assert.equal(pickLatestProfile([{ ev: otherAuthor, relay: "" }, { ev: forged, relay: "" }], pkB), null);
  // tie on created_at -> lowest id (NIP-01)
  const t1 = profileOf(skB, 3000, "t1"), t2 = profileOf(skB, 3000, "t2");
  const lo = t1.id < t2.id ? t1 : t2;
  assert.equal(pickLatestProfile([{ ev: t1, relay: "" }, { ev: t2, relay: "" }], pkB)?.id, lo.id);
  assert.equal(pickLatestProfile([{ ev: t2, relay: "" }, { ev: t1, relay: "" }], pkB)?.id, lo.id);
});

test("filters", () => {
  assert.deepEqual(yoFilter(pkB), { kinds: [7], "#p": [pkB], "#k": ["0"], limit: 50 });
  assert.deepEqual(profileFilter(pkB), { kinds: [0], authors: [pkB], limit: 1 });
});

test("checkSignedYo accepts an honest signature", () => {
  const req = buildYo(tB, 1700000000);
  const signed = sign(structuredClone(req), skA);
  assert.ok(verifyEventSignature(signed));
  assert.deepEqual(checkSignedYo(signed, req, pkA), []);
});

test("checkSignedYo rejects a signer that changed anything", () => {
  const req = buildYo(tB, 1700000000);
  const t = req.tags;
  const variants: Array<[string, UnsignedEvent]> = [
    ["recipient p swapped", { ...req, tags: [t[0]!, ["p", pkA, RELAY], t[2]!, t[3]!] }],
    ["target e swapped", { ...req, tags: [["e", "f".repeat(64), RELAY, pkB], t[1]!, t[2]!, t[3]!] }],
    ["extra p", { ...req, tags: [...t, ["p", pkA]] }],
    ["extra e", { ...req, tags: [["e", "f".repeat(64)], ...t] }],
    ["emoji url swapped", { ...req, tags: [t[0]!, t[1]!, t[2]!, ["emoji", "yo", "https://evil.example/x.png"]] }],
    ["k changed", { ...req, tags: [t[0]!, t[1]!, ["k", "1"], t[3]!] }],
    ["content +", { ...req, content: "+" }],
    ["content kind1 text", { ...req, content: "buy my coin" }],
    ["kind 1", { ...req, kind: 1 }],
    ["legacy kind", { ...req, kind: LEGACY_KIND }],
    ["created_at", { ...req, created_at: req.created_at + 1 }],
  ];
  for (const [name, v] of variants) assert.ok(checkSignedYo(sign(v, skA), req, pkA).length > 0, name);
  assert.ok(checkSignedYo(sign(req, skB), req, pkA).length > 0, "other author");
});

test("checkSignedYo rejects tampered id / sig / garbage", () => {
  const req = buildYo(tB, 1700000000);
  const s = sign(req, skA);
  assert.ok(checkSignedYo({ ...s, content: ":yo::yo:" }, req, pkA).length > 0);
  assert.ok(checkSignedYo({ ...s, sig: "0".repeat(128) }, req, pkA).length > 0);
  for (const g of [null, undefined, "x", 1, {}, [], { ...s, tags: "p" }]) {
    assert.ok(checkSignedYo(g, req, pkA).length > 0);
  }
});

test("parseIncomingYo: accepts only exact Yo reactions to me", () => {
  const now = 1700000000;
  const req = buildYo(tB, now);
  const t = req.tags;
  const good = sign(req, skA);
  assert.equal(parseIncomingYo(good, pkB, now)?.targetId, profB.id);
  assert.ok(acceptIncomingYo(good, pkB, now));
  const no = (e: unknown, why: string) => assert.equal(parseIncomingYo(e, pkB, now), null, why);
  assert.equal(parseIncomingYo(good, pkA, now), null, "not addressed to me");
  no({ ...good, sig: "f".repeat(128) }, "bad sig");
  no(sign({ ...req, content: "+" }, skA), "plain like");
  no(sign({ ...req, content: ":yo: hi" }, skA), "extra content");
  no(sign({ ...req, content: "<img src=x onerror=alert(1)>" }, skA), "html");
  no(sign({ ...req, kind: LEGACY_KIND, content: "Yo!", tags: [["p", pkB]] }, skA), "legacy 7117");
  no(sign({ ...req, kind: 1 }, skA), "kind 1");
  no(sign({ ...req, tags: [t[0]!, t[1]!, t[2]!, ["emoji", "yo", "https://evil.example/yo.png"]] }, skA), "foreign emoji url");
  no(sign({ ...req, tags: [t[0]!, t[1]!, t[2]!, ["emoji", "yo2", YO_EMOJI_URL]] }, skA), "other shortcode");
  no(sign({ ...req, tags: [t[0]!, t[1]!, t[2]!] }, skA), "no emoji tag");
  no(sign({ ...req, tags: [...t, ["emoji", "yo", YO_EMOJI_URL]] }, skA), "two emoji tags");
  no(sign({ ...req, tags: [t[0]!, t[1]!, t[3]!] }, skA), "no k");
  no(sign({ ...req, tags: [t[0]!, t[1]!, ["k", "1"], t[3]!] }, skA), "k != 0");
  no(sign({ ...req, tags: [t[1]!, t[2]!, t[3]!] }, skA), "no e");
  no(sign({ ...req, tags: [["e", "f".repeat(64)], ...t] }, skA), "two e");
  no(sign({ ...req, tags: [["e", "nothex", RELAY, pkB], t[1]!, t[2]!, t[3]!] }, skA), "e not hex");
  no(sign({ ...req, tags: [["e", profB.id, RELAY, pkA], t[1]!, t[2]!, t[3]!] }, skA), "e author hint not me");
  no(sign({ ...req, tags: [...t, ["p", pkA]] }, skA), "two p");
  no(sign({ ...req, tags: [...t, ["a", `0:${pkB}:`]] }, skA), "a tag");
  no(sign(buildYo(tB, now + 3600), skA), "future");
  // e without relay/pubkey hints is still a valid NIP-25 reaction
  assert.ok(parseIncomingYo(sign({ ...req, tags: [["e", profB.id], ["p", pkB], t[2]!, t[3]!] }, skA), pkB, now));
});

test("normalizeRelay", () => {
  assert.equal(normalizeRelay(" wss://nos.lol/ "), "wss://nos.lol");
  assert.equal(normalizeRelay("ws://localhost:7777"), "ws://localhost:7777");
  assert.throws(() => normalizeRelay("ws://evil.example"));
  assert.throws(() => normalizeRelay("https://nos.lol"));
  assert.throws(() => normalizeRelay("javascript:alert(1)"));
  assert.throws(() => normalizeRelay("wss://u:p@nos.lol"));
});

test("default relays: exact list and order", () => {
  assert.deepEqual([...DEFAULT_RELAYS], ["wss://r.kojira.io", "wss://yabu.me", "wss://x.kojira.io", "wss://n.kojira.io"]);
  for (const u of DEFAULT_RELAYS) assert.equal(normalizeRelay(u), u);
});

test("resolveRelayUrls keeps a saved list, falls back to defaults otherwise", () => {
  assert.deepEqual(resolveRelayUrls(null), [...DEFAULT_RELAYS]);
  assert.deepEqual(resolveRelayUrls('["wss://nos.lol","wss://relay.damus.io/"]'), ["wss://nos.lol", "wss://relay.damus.io"]);
  assert.deepEqual(resolveRelayUrls('["wss://nos.lol","ws://evil.example",42,"wss://nos.lol"]'), ["wss://nos.lol"]);
  assert.deepEqual(resolveRelayUrls("[]"), [...DEFAULT_RELAYS]);
  assert.deepEqual(resolveRelayUrls("not json"), [...DEFAULT_RELAYS]);
  assert.deepEqual(resolveRelayUrls('{"a":1}'), [...DEFAULT_RELAYS]);
  const r = resolveRelayUrls(null); r.push("wss://x"); assert.equal(DEFAULT_RELAYS.length, 4);
});
