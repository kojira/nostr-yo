import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  YO_KIND, acceptIncomingYo, buildYo, checkSignedYo, computeEventId, normalizeRelay,
  parsePubkey, toNpub, verifyEventSignature, type NostrEvent, type UnsignedEvent,
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

test("buildYo shape", () => {
  const e = buildYo(pkB, 1700000000);
  assert.equal(e.kind, YO_KIND);
  assert.equal(e.content, "Yo!");
  assert.deepEqual(e.tags[0], ["p", pkB]);
  assert.equal(e.tags.filter((t) => t[0] === "p").length, 1);
  assert.throws(() => buildYo("npub1..."));
});

test("checkSignedYo accepts an honest signature", () => {
  const req = buildYo(pkB, 1700000000);
  const signed = sign(structuredClone(req), skA);
  assert.ok(verifyEventSignature(signed));
  assert.deepEqual(checkSignedYo(signed, req, pkA), []);
});

test("checkSignedYo rejects a signer that swapped recipient / content / kind / author", () => {
  const req = buildYo(pkB, 1700000000);
  const swappedTo = sign({ ...req, tags: [["p", pkA], req.tags[1]!] }, skA);
  assert.ok(checkSignedYo(swappedTo, req, pkA).length > 0);
  const extraP = sign({ ...req, tags: [...req.tags, ["p", pkA]] }, skA);
  assert.ok(checkSignedYo(extraP, req, pkA).length > 0);
  const content = sign({ ...req, content: "buy my coin" }, skA);
  assert.ok(checkSignedYo(content, req, pkA).length > 0);
  const kind1 = sign({ ...req, kind: 1 }, skA);
  assert.ok(checkSignedYo(kind1, req, pkA).length > 0);
  const otherAuthor = sign(req, skB);
  assert.ok(checkSignedYo(otherAuthor, req, pkA).length > 0);
  const ts = sign({ ...req, created_at: req.created_at + 1 }, skA);
  assert.ok(checkSignedYo(ts, req, pkA).length > 0);
});

test("checkSignedYo rejects tampered id / sig / garbage", () => {
  const req = buildYo(pkB, 1700000000);
  const s = sign(req, skA);
  assert.ok(checkSignedYo({ ...s, content: "Yo!!" }, req, pkA).length > 0);
  assert.ok(checkSignedYo({ ...s, sig: "0".repeat(128) }, req, pkA).length > 0);
  assert.ok(checkSignedYo({ ...s, tags: [["p", pkA], req.tags[1]!] }, req, pkA).length > 0);
  for (const g of [null, undefined, "x", 1, {}, [], { ...s, tags: "p" }]) {
    assert.ok(checkSignedYo(g, req, pkA).length > 0);
  }
});

test("acceptIncomingYo filters", () => {
  const now = 1700000000;
  const good = sign(buildYo(pkB, now), skA);
  assert.ok(acceptIncomingYo(good, pkB, now));
  assert.ok(!acceptIncomingYo(good, pkA, now), "not addressed to me");
  assert.ok(!acceptIncomingYo({ ...good, sig: "f".repeat(128) }, pkB, now));
  assert.ok(!acceptIncomingYo(sign({ ...buildYo(pkB, now), content: "<script>alert(1)</script>" }, skA), pkB, now));
  assert.ok(!acceptIncomingYo(sign({ ...buildYo(pkB, now), kind: 1 }, skA), pkB, now));
  assert.ok(!acceptIncomingYo(sign(buildYo(pkB, now + 3600), skA), pkB, now), "future");
  assert.ok(!acceptIncomingYo(sign({ ...buildYo(pkB, now), tags: [["p", pkB], ["p", pkA]] }, skA), pkB, now));
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
