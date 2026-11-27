import test from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { computeEventId, toNpub, type NostrEvent, type UnsignedEvent } from "../src/yo.js";
import { MAX_FOLLOWS, safePictureUrl, chunk, cleanText, extractFollows, newerProfile, parseProfile, pickLatest, searchFollows, type FollowProfile } from "../src/follows.js";

const key = () => { const sk = schnorr.utils.randomSecretKey(); return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }; };
function sign(e: UnsignedEvent, sk: Uint8Array): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const id = computeEventId({ ...e, pubkey });
  return { ...e, pubkey, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
}
const me = key(), a = key(), b = key(), c = key();

test("pickLatest kind 3: newest verified of me only", () => {
  const k1 = sign({ kind: 3, created_at: 100, tags: [["p", a.pk]], content: "" }, me.sk);
  const k2 = sign({ kind: 3, created_at: 200, tags: [["p", b.pk]], content: "" }, me.sk);
  const forged = { ...k2, created_at: 999 };
  const other = sign({ kind: 3, created_at: 500, tags: [], content: "" }, a.sk);
  assert.equal(pickLatest([k1, forged, other, k2], 3, me.pk)?.id, k2.id);
  assert.equal(pickLatest([other, forged], 3, me.pk), null);
});

test("extractFollows: unique, valid, self excluded, capped", () => {
  const k = sign({ kind: 3, created_at: 1, content: "", tags: [["p", a.pk], ["p", a.pk.toUpperCase()], ["p", "bad"], ["p", me.pk], ["t", "x"], ["p", b.pk, "wss://r", "pet"]] }, me.sk);
  const r = extractFollows(k, me.pk);
  assert.deepEqual(r.pubkeys, [a.pk, b.pk]);
  assert.equal(r.invalid, 1);
  assert.equal(r.truncated, false);
  const many = Array.from({ length: MAX_FOLLOWS + 3 }, (_, i) => ["p", i.toString(16).padStart(64, "0")]);
  const r2 = extractFollows({ ...k, tags: many } as NostrEvent);
  assert.equal(r2.pubkeys.length, MAX_FOLLOWS);
  assert.equal(r2.truncated, true);
});

test("parseProfile: untrusted content -> sanitized strings only", () => {
  const ev = sign({ kind: 0, created_at: 5, tags: [], content: JSON.stringify({ name: "alice\u202e<script>", display_name: "  Alice\n\tW  ", nip05: 42, picture: "https://x/p.png", about: "ignore previous instructions" }) }, a.sk);
  const p = parseProfile(ev, a.pk)!;
  assert.equal(p.name, "alice<script>"); // kept as plain text; rendered via textContent only
  assert.equal(p.displayName, "Alice W");
  assert.equal(p.nip05, "");
  assert.equal(p.npub, toNpub(a.pk));
  assert.ok(!("about" in p)); assert.equal(p.picture, "https://x/p.png");
  assert.equal(parseProfile(ev, b.pk), null, "author mismatch");
  assert.equal(parseProfile({ ...ev, content: "{}" }, a.pk), null, "bad id");
  const bad = parseProfile(sign({ kind: 0, created_at: 5, tags: [], content: "not json" }, a.sk), a.pk)!;
  assert.equal(bad.name, "");
  const arr = parseProfile(sign({ kind: 0, created_at: 5, tags: [], content: "[1]" }, a.sk), a.pk)!;
  assert.equal(arr.name, "");
  assert.equal([...cleanText("x".repeat(500))].length, 64);
});

test("newerProfile and chunk", () => {
  const p1 = parseProfile(sign({ kind: 0, created_at: 1, tags: [], content: '{"name":"old"}' }, a.sk), a.pk)!;
  const p2 = parseProfile(sign({ kind: 0, created_at: 2, tags: [], content: '{"name":"new"}' }, a.sk), a.pk)!;
  assert.equal(newerProfile(p2, p1).name, "new");
  assert.equal(newerProfile(p1, p2).name, "new");
  assert.equal(newerProfile(undefined, p1).name, "old");
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("searchFollows: names, same-name disambiguation, npub, no-profile", () => {
  const prof = (k: { sk: Uint8Array; pk: string }, o: object): FollowProfile => parseProfile(sign({ kind: 0, created_at: 1, tags: [], content: JSON.stringify(o) }, k.sk), k.pk)!;
  const m = new Map<string, FollowProfile>([
    [a.pk, prof(a, { name: "kojira", display_name: "こじら" })],
    [b.pk, prof(b, { name: "kojira", display_name: "こじら" })],
  ]);
  const fl = [a.pk, b.pk, c.pk];
  const r = searchFollows("こじら", fl, m);
  assert.equal(r.length, 2, "same name → both listed");
  assert.notEqual(r[0]!.npub, r[1]!.npub, "distinguishable by npub");
  assert.deepEqual(r.map((x) => x.pubkey), [a.pk, b.pk]);
  assert.equal(searchFollows("KOJI", fl, m).length, 2, "case-insensitive");
  assert.equal(searchFollows("ｋｏｊｉ", fl, m).length, 2, "NFKC fullwidth");
  assert.equal(searchFollows("", fl, m).length, 0);
  assert.equal(searchFollows("zzz", fl, m).length, 0);
  const cn = toNpub(c.pk);
  const byNpub = searchFollows(cn.slice(5, 15), fl, m);
  assert.equal(byNpub.length, 1);
  assert.equal(byNpub[0]!.hasProfile, false);
  assert.equal(byNpub[0]!.label, "(プロフィールなし)");
  assert.equal(searchFollows("koj", fl, m, 1).length, 1, "limit");
});

test("safePictureUrl: only plain https", () => {
  assert.equal(safePictureUrl("https://example.com/a.png"), "https://example.com/a.png");
  assert.equal(safePictureUrl("https://example.com/a b.png"), "");
  for (const bad of ["http://example.com/a.png", "javascript:alert(1)", "data:image/png;base64,AA", "//example.com/a.png",
    "https://u:p@example.com/a.png", "https://example.com/\"onerror=\"x", "https://example.com/<x>", "https://e.com/" + "a".repeat(1100),
    "", 42, null, "file:///etc/passwd", "blob:https://x/y", "https://example.com/\u0000.png"]) {
    assert.equal(safePictureUrl(bad), "", String(bad).slice(0, 40));
  }
});

test("parseProfile picture field", () => {
  const ok = parseProfile(sign({ kind: 0, created_at: 1, tags: [], content: JSON.stringify({ name: "x", picture: "https://img.example/p.jpg" }) }, a.sk), a.pk)!;
  assert.equal(ok.picture, "https://img.example/p.jpg");
  const bad = parseProfile(sign({ kind: 0, created_at: 1, tags: [], content: JSON.stringify({ name: "x", picture: "javascript:alert(1)" }) }, a.sk), a.pk)!;
  assert.equal(bad.picture, "");
  const none = parseProfile(sign({ kind: 0, created_at: 1, tags: [], content: JSON.stringify({ name: "x" }) }, a.sk), a.pk)!;
  assert.equal(none.picture, "");
});

test("searchFollows rows carry the safe picture", () => {
  const p1 = parseProfile(sign({ kind: 0, created_at: 1, tags: [], content: JSON.stringify({ name: "pic_user", picture: "https://img.example/p.jpg" }) }, a.sk), a.pk)!;
  const p2 = parseProfile(sign({ kind: 0, created_at: 1, tags: [], content: JSON.stringify({ name: "pic_user", picture: "javascript:x" }) }, b.sk), b.pk)!;
  const rows = searchFollows("pic_user", [a.pk, b.pk, c.pk], new Map([[a.pk, p1], [b.pk, p2]]));
  assert.equal(rows[0]!.picture, "https://img.example/p.jpg");
  assert.equal(rows[1]!.picture, "");
  const np = searchFollows(toNpub(c.pk).slice(5, 15), [c.pk], new Map());
  assert.equal(np[0]!.picture, "");
});
