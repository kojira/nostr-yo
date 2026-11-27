// Pure protocol logic for nostr-yo (no DOM). Crypto comes from audited
// @noble / @scure libraries; nothing cryptographic is hand-rolled here.
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";

export const YO_KIND = 7107;
export const YO_CONTENT = "Yo!";
export const YO_ALT = "Yo! (a one-word ping sent with nostr-yo)";
/** Reject events whose created_at is too far in the future (seconds). */
export const MAX_FUTURE_SKEW = 10 * 60;

export interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}
export interface NostrEvent extends UnsignedEvent {
  id: string;
  pubkey: string;
  sig: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export function isHex64(s: unknown): s is string {
  return typeof s === "string" && HEX64.test(s);
}

/** Decode an npub1... (NIP-19) or 64-char hex pubkey to lowercase hex. Throws on invalid input. */
export function parsePubkey(input: string): string {
  const s = input.trim();
  if (s.length === 64 && HEX64.test(s.toLowerCase())) {
    const hex = s.toLowerCase();
    if (!isValidXOnlyPubkey(hex)) throw new Error("公開鍵として無効な点です");
    return hex;
  }
  if (!s.toLowerCase().startsWith("npub1")) throw new Error("npub1… か64桁hexを入力してください");
  let decoded;
  try {
    decoded = bech32.decode(s.toLowerCase() as `${string}1${string}`, 90);
  } catch {
    throw new Error("npub の形式が正しくありません（チェックサム不一致など）");
  }
  if (decoded.prefix !== "npub") throw new Error("npub ではありません");
  const bytes = bech32.fromWords(decoded.words);
  if (bytes.length !== 32) throw new Error("npub の長さが正しくありません");
  const hex = bytesToHex(bytes);
  if (!isValidXOnlyPubkey(hex)) throw new Error("公開鍵として無効な点です");
  return hex;
}

export function toNpub(hex: string): string {
  if (!isHex64(hex)) throw new Error("invalid hex pubkey");
  return bech32.encode("npub", bech32.toWords(hexToBytes(hex)), 90);
}

export function isValidXOnlyPubkey(hex: string): boolean {
  if (!isHex64(hex)) return false;
  try {
    schnorr.utils.lift_x(BigInt("0x" + hex));
    return true;
  } catch {
    return false;
  }
}

/** NIP-01 event id: sha256 of the canonical JSON serialization. */
export function computeEventId(e: UnsignedEvent & { pubkey: string }): string {
  const ser = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
  return bytesToHex(sha256(utf8ToBytes(ser)));
}

export function buildYo(recipientHex: string, now: number = Math.floor(Date.now() / 1000)): UnsignedEvent {
  if (!isHex64(recipientHex)) throw new Error("invalid recipient");
  return {
    kind: YO_KIND,
    created_at: now,
    tags: [["p", recipientHex], ["alt", YO_ALT]],
    content: YO_CONTENT,
  };
}

function isStringMatrix(t: unknown): t is string[][] {
  return Array.isArray(t) && t.every((r) => Array.isArray(r) && r.every((x) => typeof x === "string"));
}

/** Structural + cryptographic check of any event (id and BIP-340 signature). */
export function verifyEventSignature(e: unknown): e is NostrEvent {
  if (typeof e !== "object" || e === null) return false;
  const ev = e as Record<string, unknown>;
  if (!isHex64(ev.id) || !isHex64(ev.pubkey) || typeof ev.sig !== "string" || !HEX128.test(ev.sig)) return false;
  if (typeof ev.kind !== "number" || !Number.isInteger(ev.kind)) return false;
  if (typeof ev.created_at !== "number" || !Number.isInteger(ev.created_at)) return false;
  if (typeof ev.content !== "string" || !isStringMatrix(ev.tags)) return false;
  const id = computeEventId(ev as unknown as NostrEvent);
  if (id !== ev.id) return false;
  try {
    return schnorr.verify(hexToBytes(ev.sig), hexToBytes(id), hexToBytes(ev.pubkey));
  } catch {
    return false;
  }
}

function pTags(tags: string[][]): string[] {
  return tags.filter((t) => t[0] === "p").map((t) => t[1] ?? "");
}

/**
 * Verify that what the NIP-07 signer returned is exactly what we asked for:
 * same kind/content/tags/created_at, the expected author, the single intended
 * recipient, a correct id and a valid signature. Returns a list of problems
 * (empty = OK).
 */
export function checkSignedYo(signed: unknown, requested: UnsignedEvent, expectedPubkey: string): string[] {
  const problems: string[] = [];
  if (!verifyEventSignature(signed)) return ["id または署名が無効です"];
  const e = signed;
  if (e.pubkey !== expectedPubkey) problems.push("署名者の公開鍵が拡張から取得したものと違います");
  if (e.kind !== YO_KIND || e.kind !== requested.kind) problems.push(`kind が ${YO_KIND} ではありません (${e.kind})`);
  if (e.content !== YO_CONTENT || e.content !== requested.content) problems.push("本文が \"Yo!\" ではありません");
  if (e.created_at !== requested.created_at) problems.push("created_at が要求と違います");
  if (JSON.stringify(e.tags) !== JSON.stringify(requested.tags)) problems.push("tags が要求と違います（宛先が書き換えられた可能性）");
  const ps = pTags(e.tags);
  if (ps.length !== 1 || ps[0] !== pTags(requested.tags)[0]) problems.push("p タグ（宛先）が要求と一致しません");
  return problems;
}

/** Decide whether an incoming relay event is a valid Yo addressed to `me`. */
export function acceptIncomingYo(e: unknown, me: string, now: number = Math.floor(Date.now() / 1000)): e is NostrEvent {
  if (!verifyEventSignature(e)) return false;
  if (e.kind !== YO_KIND || e.content !== YO_CONTENT) return false;
  const ps = pTags(e.tags);
  if (ps.length !== 1 || ps[0] !== me) return false;
  if (e.created_at > now + MAX_FUTURE_SKEW) return false;
  return true;
}

export function yoFilter(me: string, limit = 50): Record<string, unknown> {
  return { kinds: [YO_KIND], "#p": [me], limit };
}

/** Normalize a relay URL; only wss:// (and ws://localhost for dev) allowed. */
export function normalizeRelay(input: string): string {
  const u = new URL(input.trim());
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (!(u.protocol === "wss:" || (u.protocol === "ws:" && local))) throw new Error("wss:// のみ対応です");
  if (u.username || u.password) throw new Error("認証情報付きURLは不可");
  return u.toString().replace(/\/$/, "");
}

/** Short safe label for a pubkey, e.g. npub1abcd…wxyz */
export function shortNpub(hex: string): string {
  const n = toNpub(hex);
  return `${n.slice(0, 10)}…${n.slice(-6)}`;
}
