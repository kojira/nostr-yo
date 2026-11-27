// Pure protocol logic for nostr-yo (no DOM). Crypto comes from audited
// @noble / @scure libraries; nothing cryptographic is hand-rolled here.
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";

/** Yo is a NIP-25 reaction (kind 7) with a NIP-30 custom emoji, targeting the recipient's kind 0. */
export const YO_KIND = 7;
export const PROFILE_KIND = 0;
export const YO_SHORTCODE = "yo";
export const YO_CONTENT = ":yo:";
export const YO_EMOJI_URL = "https://kojira.github.io/nostr-yo/yo.png";
/** Retired format (kind 7117, before 2026-11-27). Not sent or read anymore. */
export const LEGACY_KIND = 7117;
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

export interface ProfileTarget {
  /** kind 0 event id */
  id: string;
  /** recipient pubkey (author of the kind 0) */
  pubkey: string;
  created_at: number;
  /** relay URL where it was found ("" if unknown) */
  relay: string;
}

/** Pick the newest valid kind 0 of `author` from candidates (NIP-01 tie-break: lowest id). */
export function pickLatestProfile(cands: Array<{ ev: unknown; relay: string }>, author: string): ProfileTarget | null {
  let best: ProfileTarget | null = null;
  for (const { ev, relay } of cands) {
    if (!verifyEventSignature(ev)) continue;
    if (ev.kind !== PROFILE_KIND || ev.pubkey !== author) continue;
    if (!best || ev.created_at > best.created_at || (ev.created_at === best.created_at && ev.id < best.id)) {
      best = { id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at, relay };
    }
  }
  return best;
}

export function buildYo(target: ProfileTarget, now: number = Math.floor(Date.now() / 1000)): UnsignedEvent {
  if (!isHex64(target.id) || !isHex64(target.pubkey)) throw new Error("invalid target");
  const hint = target.relay;
  return {
    kind: YO_KIND,
    created_at: now,
    tags: [
      ["e", target.id, hint, target.pubkey],
      ["p", target.pubkey, hint],
      ["k", String(PROFILE_KIND)],
      ["emoji", YO_SHORTCODE, YO_EMOJI_URL],
    ],
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

function tagsNamed(tags: string[][], name: string): string[][] {
  return tags.filter((t) => t[0] === name);
}

/**
 * Verify that what the NIP-07 signer returned is exactly what we asked for:
 * same kind/content/tags/created_at, the expected author, the intended target
 * and recipient, a correct id and a valid signature. Returns problems (empty = OK).
 */
export function checkSignedYo(signed: unknown, requested: UnsignedEvent, expectedPubkey: string): string[] {
  const problems: string[] = [];
  if (!verifyEventSignature(signed)) return ["id または署名が無効です"];
  const e = signed;
  if (e.pubkey !== expectedPubkey) problems.push("署名者の公開鍵が拡張から取得したものと違います");
  if (e.kind !== YO_KIND || e.kind !== requested.kind) problems.push(`kind が ${YO_KIND} ではありません (${e.kind})`);
  if (e.content !== YO_CONTENT || e.content !== requested.content) problems.push(`本文が "${YO_CONTENT}" ではありません`);
  if (e.created_at !== requested.created_at) problems.push("created_at が要求と違います");
  if (JSON.stringify(e.tags) !== JSON.stringify(requested.tags)) problems.push("tags が要求と違います（宛先/対象が書き換えられた可能性）");
  const reqE = tagsNamed(requested.tags, "e")[0]?.[1];
  const reqP = tagsNamed(requested.tags, "p")[0]?.[1];
  const es = tagsNamed(e.tags, "e"), ps = tagsNamed(e.tags, "p"), em = tagsNamed(e.tags, "emoji");
  if (es.length !== 1 || es[0]?.[1] !== reqE) problems.push("e タグ（対象 kind0）が要求と一致しません");
  if (ps.length !== 1 || ps[0]?.[1] !== reqP) problems.push("p タグ（宛先）が要求と一致しません");
  if (em.length !== 1 || em[0]?.[1] !== YO_SHORTCODE || em[0]?.[2] !== YO_EMOJI_URL) problems.push("emoji タグが Yo 絵文字ではありません");
  return problems;
}

export interface IncomingYo {
  ev: NostrEvent;
  /** kind 0 id the Yo reacts to */
  targetId: string;
}

/** Decide whether an incoming relay event is a valid Yo reaction addressed to `me`. */
export function parseIncomingYo(e: unknown, me: string, now: number = Math.floor(Date.now() / 1000)): IncomingYo | null {
  if (!verifyEventSignature(e)) return null;
  if (e.kind !== YO_KIND || e.content !== YO_CONTENT) return null;
  if (e.created_at > now + MAX_FUTURE_SKEW) return null;
  const em = tagsNamed(e.tags, "emoji");
  if (em.length !== 1 || em[0]?.[1] !== YO_SHORTCODE || em[0]?.[2] !== YO_EMOJI_URL) return null;
  const ps = tagsNamed(e.tags, "p");
  if (ps.length !== 1 || ps[0]?.[1] !== me) return null;
  const ks = tagsNamed(e.tags, "k");
  if (ks.length !== 1 || ks[0]?.[1] !== String(PROFILE_KIND)) return null;
  const es = tagsNamed(e.tags, "e");
  if (es.length !== 1) return null;
  const target = es[0]?.[1];
  if (!isHex64(target)) return null;
  const authorHint = es[0]?.[3];
  if (authorHint !== undefined && authorHint !== "" && authorHint !== me) return null;
  if (tagsNamed(e.tags, "a").length) return null;
  return { ev: e, targetId: target };
}

export function acceptIncomingYo(e: unknown, me: string, now?: number): e is NostrEvent {
  return parseIncomingYo(e, me, now) !== null;
}

export function yoFilter(me: string, limit = 50): Record<string, unknown> {
  return { kinds: [YO_KIND], "#p": [me], "#k": [String(PROFILE_KIND)], limit };
}

export function profileFilter(author: string): Record<string, unknown> {
  return { kinds: [PROFILE_KIND], authors: [author], limit: 1 };
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
