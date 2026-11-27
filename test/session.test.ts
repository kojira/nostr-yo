import test from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { LS_SESSION, compareSigner, formatWhen, parseSession, serializeSession, signerLabel } from "../src/session.js";

const pk = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
const pk2 = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));

test("session stores only {v:1,pubkey}", () => {
  const s = serializeSession(pk);
  assert.deepEqual(JSON.parse(s), { v: 1, pubkey: pk });
  assert.equal(parseSession(s), pk);
  assert.equal(LS_SESSION, "nostr-yo:session");
  assert.throws(() => serializeSession("nsec1xyz"));
  assert.throws(() => serializeSession("f".repeat(64))); // not on the curve
});

test("parseSession refuses anything unexpected (no auto-restore)", () => {
  for (const raw of [null, "", "{", "null", "[]", "1", JSON.stringify({ pubkey: pk }), JSON.stringify({ v: 2, pubkey: pk }),
    JSON.stringify({ v: 1, pubkey: pk.toUpperCase() }), JSON.stringify({ v: 1, pubkey: pk, nsec: "x" }),
    JSON.stringify({ v: 1, pubkey: pk, token: "t" }), JSON.stringify({ v: 1, pubkey: "f".repeat(64) }), JSON.stringify({ v: 1, pubkey: 5 })]) {
    assert.equal(parseSession(raw), null, String(raw));
  }
});

test("compareSigner distinguishes remembered account from signing ability", () => {
  assert.equal(compareSigner(pk, pk), "ready");
  assert.equal(compareSigner(pk, pk2), "mismatch");
  assert.equal(compareSigner(pk, undefined), "error");
  assert.equal(compareSigner(pk, "npub1..."), "error");
  // never claims "connected" for non-ready states
  for (const s of ["checking", "unverified", "missing", "mismatch", "error"] as const) assert.ok(!/送信できます/.test(signerLabel(s)));
  assert.equal(signerLabel("ready"), "送信できます");
});

test("formatWhen always includes the date", () => {
  const now = new Date(2026, 10, 27, 12, 0, 0);
  const t = Math.floor(new Date(2026, 10, 27, 9, 5, 0).getTime() / 1000);
  assert.equal(formatWhen(t, now), "11/27 09:05");
  const old = Math.floor(new Date(2025, 0, 3, 23, 59, 0).getTime() / 1000);
  assert.equal(formatWhen(old, now), "2025/1/3 23:59");
});
