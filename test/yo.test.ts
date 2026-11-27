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
    ["t", "yo"],
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
    ["recipient p swapped", { ...req, tags: [t[0]!, ["p", pkA, RELAY], t[2]!, t[3]!, t[4]!] }],
    ["target e swapped", { ...req, tags: [["e", "f".repeat(64), RELAY, pkB], t[1]!, t[2]!, t[3]!, t[4]!] }],
    ["extra p", { ...req, tags: [...t, ["p", pkA]] }],
    ["extra e", { ...req, tags: [["e", "f".repeat(64)], ...t] }],
    ["emoji url swapped", { ...req, tags: [t[0]!, t[1]!, t[2]!, ["emoji", "yo", "https://evil.example/x.png"], t[4]!] }],
    ["k changed", { ...req, tags: [t[0]!, t[1]!, ["k", "1"], t[3]!, t[4]!] }],
    ["t tag dropped", { ...req, tags: [t[0]!, t[1]!, t[2]!, t[3]!] }],
    ["t tag changed", { ...req, tags: [t[0]!, t[1]!, t[2]!, t[3]!, ["t", "spam"]] }],
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

test("parseIncomingYo: recognition rule", () => {
  const now = 1700000000;
  const req = buildYo(tB, now);
  const [E, P, K, EM, T] = req.tags as [string[], string[], string[], string[], string[]];
  const good = sign(req, skA);
  const y = parseIncomingYo(good, pkB, now);
  assert.equal(y?.targetId, profB.id);
  assert.equal(y?.ours, true);
  assert.equal(y?.hasTag, true);
  assert.ok(acceptIncomingYo(good, pkB, now));
  const yes = (tags: string[][], why: string, content = ":yo:") => {
    const r = parseIncomingYo(sign({ ...req, tags, content }, skA), pkB, now);
    assert.ok(r, why);
    return r!;
  };
  const no = (e: unknown, why: string) => assert.equal(parseIncomingYo(e, pkB, now), null, why);
  const tagsNo = (tags: string[][], why: string, extra: Partial<UnsignedEvent> = {}) => no(sign({ ...req, ...extra, tags }, skA), why);

  // compatibility: pre-e2257 nostr-yo Yo (no t tag) is still a Yo
  const legacy = yes([E, P, K, EM], "pre-e2257 nostr-yo Yo without t tag");
  assert.equal(legacy.hasTag, false);
  assert.equal(legacy.ours, true);
  // other implementation: different https emoji URL, still recognized, flagged as not ours
  const other = yes([E, P, K, ["emoji", "yo", "https://cdn.example.org/emoji/yo.webp"], T], "other impl with own image");
  assert.equal(other.ours, false);
  assert.equal(other.emojiHost, "cdn.example.org");
  yes([["e", profB.id], ["p", pkB], K, EM], "minimal hints");
  yes([E, P, K, EM, ["t", "YO"]], "t value case-insensitive");
  yes([E, P, K, EM, T, ["t", "nostr"], ["client", "x"]], "extra unrelated tags ok");

  // tag-only false positives: t=yo alone is never enough
  tagsNo([E, P, K, T], "t=yo but no emoji tag");
  tagsNo([E, P, K, EM, T], "t=yo but plain like", { content: "+" });
  tagsNo([E, P, K, EM, T], "t=yo but text content", { content: "yo" });
  tagsNo([E, P, K, EM, T], "t=yo but kind 1", { kind: 1 });
  tagsNo([E, P, K, ["emoji", "wave", "https://x.example/w.png"], T], "t=yo but other shortcode", { content: ":wave:" });
  tagsNo([P, K, EM, T], "t=yo but no e");
  tagsNo([E, K, EM, T], "t=yo but no p");
  tagsNo([E, P, EM, T], "t=yo but no k");
  tagsNo([E, P, ["k", "1"], EM, T], "t=yo but reaction to a note");

  // emoji URL rules (never fetched; must be https)
  tagsNo([E, P, K, ["emoji", "yo", "http://x.example/yo.png"], T], "http url");
  tagsNo([E, P, K, ["emoji", "yo", "javascript:alert(1)"], T], "javascript url");
  tagsNo([E, P, K, ["emoji", "yo", "data:image/png;base64,AAAA"], T], "data url");
  tagsNo([E, P, K, ["emoji", "yo", "https://u:p@x.example/yo.png"], T], "credentials url");
  tagsNo([E, P, K, ["emoji", "yo", "https://x.example/" + "a".repeat(2100)], T], "too long url");
  tagsNo([E, P, K, ["emoji", "yo"], T], "emoji without url");
  tagsNo([E, P, K, ["emoji", "yo2", YO_EMOJI_URL], T], "other shortcode");
  tagsNo([E, P, K, EM, ["emoji", "yo", YO_EMOJI_URL], T], "two emoji tags");

  // previous structural rules still hold
  assert.equal(parseIncomingYo(good, pkA, now), null, "not addressed to me");
  no({ ...good, sig: "f".repeat(128) }, "bad sig");
  no(sign({ ...req, content: ":yo: hi" }, skA), "extra content");
  no(sign({ ...req, content: "<img src=x onerror=alert(1)>" }, skA), "html");
  no(sign({ ...req, kind: LEGACY_KIND, content: "Yo!", tags: [["p", pkB]] }, skA), "legacy 7117");
  tagsNo([["e", "f".repeat(64)], E, P, K, EM, T], "two e");
  tagsNo([["e", "nothex", RELAY, pkB], P, K, EM, T], "e not hex");
  tagsNo([["e", profB.id, RELAY, pkA], P, K, EM, T], "e author hint not me");
  tagsNo([E, P, ["p", pkA], K, EM, T], "two p");
  tagsNo([E, P, K, EM, T, ["a", `0:${pkB}:`]], "a tag");
  no(sign(buildYo(tB, now + 3600), skA), "future");
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
