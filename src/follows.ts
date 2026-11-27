// Follow list (kind 3) + follow profiles (kind 0) — pure logic, no DOM.
// All Nostr data is untrusted: only verified events are used, and only a few
// string fields are extracted, sanitized and length-capped. Nothing here is
// ever interpreted as HTML or as instructions.
import { isHex64, toNpub, verifyEventSignature, type NostrEvent } from "./yo.js";

export const MAX_FOLLOWS = 5000;
export const AUTHORS_PER_REQ = 150;
const MAX_FIELD = 64;

export interface FollowProfile {
  pubkey: string;
  npub: string;
  name: string;
  displayName: string;
  nip05: string;
  /** safe https picture URL or "" */
  picture: string;
  created_at: number;
  id: string;
}

/** Newest verified event of `kind` by `author` (NIP-01 tie-break: lowest id). */
export function pickLatest(events: unknown[], kind: number, author: string): NostrEvent | null {
  let best: NostrEvent | null = null;
  for (const e of events) {
    if (!verifyEventSignature(e) || e.kind !== kind || e.pubkey !== author) continue;
    if (!best || e.created_at > best.created_at || (e.created_at === best.created_at && e.id < best.id)) best = e;
  }
  return best;
}

/** Unique, valid hex `p` tags of a kind 3, in order, capped. Self is excluded. */
export function extractFollows(kind3: NostrEvent, self?: string): { pubkeys: string[]; truncated: boolean; invalid: number } {
  const out: string[] = [];
  const seen = new Set<string>();
  let invalid = 0;
  let truncated = false;
  for (const t of kind3.tags) {
    if (t[0] !== "p") continue;
    const pk = (t[1] ?? "").toLowerCase();
    if (!isHex64(pk)) { invalid++; continue; }
    if (pk === self || seen.has(pk)) continue;
    if (out.length >= MAX_FOLLOWS) { truncated = true; break; }
    seen.add(pk);
    out.push(pk);
  }
  return { pubkeys: out, truncated, invalid };
}

/** Strip control / bidi-override chars, collapse whitespace, cap length. */
export function cleanText(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v
    .replace(/[\t\n\r\f\v]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return [...s].slice(0, MAX_FIELD).join("");
}

/** Accept only plain https image URLs (no credentials, no whitespace/control chars, bounded length). */
export function safePictureUrl(v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 1024) return "";
  if (/[\s\u0000-\u001f\u007f-\u009f"'<>\\`]/.test(v)) return "";
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password) return "";
    return u.href;
  } catch {
    return "";
  }
}

/** Parse a verified kind 0 into display fields. Returns null if not a valid kind 0 of `author`. */
export function parseProfile(e: unknown, author: string): FollowProfile | null {
  if (!verifyEventSignature(e) || e.kind !== 0 || e.pubkey !== author) return null;
  let obj: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(e.content);
    if (v && typeof v === "object" && !Array.isArray(v)) obj = v as Record<string, unknown>;
  } catch { /* malformed content: keep empty fields */ }
  return {
    pubkey: author,
    npub: toNpub(author),
    name: cleanText(obj.name),
    displayName: cleanText(obj.display_name) || cleanText(obj.displayName),
    nip05: cleanText(obj.nip05),
    picture: safePictureUrl(obj.picture),
    created_at: e.created_at,
    id: e.id,
  };
}

/** Keep the newer of two profiles (NIP-01 rules). */
export function newerProfile(a: FollowProfile | undefined, b: FollowProfile): FollowProfile {
  if (!a) return b;
  if (b.created_at > a.created_at || (b.created_at === a.created_at && b.id < a.id)) return b;
  return a;
}

export function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase();

export interface SearchRow {
  pubkey: string;
  npub: string;
  label: string;
  name: string;
  nip05: string;
  /** safe https picture URL or "" */
  picture: string;
  hasProfile: boolean;
}

/**
 * Search follows by display_name / name / nip05 / npub (NFKC, case-insensitive substring).
 * Prefix matches rank first. Follows without a profile match only by npub/hex.
 */
export function searchFollows(query: string, follows: string[], profiles: Map<string, FollowProfile>, limit = 30): SearchRow[] {
  const q = norm(query.trim());
  if (!q) return [];
  const scored: Array<[number, number, SearchRow]> = [];
  follows.forEach((pk, idx) => {
    const p = profiles.get(pk);
    const npub = p?.npub ?? toNpub(pk);
    const fields = p ? [p.displayName, p.name, p.nip05] : [];
    let score = -1;
    for (const f of fields) {
      if (!f) continue;
      const n = norm(f);
      if (n.startsWith(q)) score = Math.max(score, 3);
      else if (n.includes(q)) score = Math.max(score, 2);
    }
    if (score < 0 && q.length >= 5 && (npub.includes(q) || pk.includes(q))) score = 1;
    if (score < 0) return;
    scored.push([score, idx, {
      pubkey: pk,
      npub,
      label: p ? (p.displayName || p.name || "(名前なし)") : "(プロフィールなし)",
      name: p?.name ?? "",
      nip05: p?.nip05 ?? "",
      picture: p?.picture ?? "",
      hasProfile: !!p,
    }]);
  });
  scored.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  return scored.slice(0, limit).map((x) => x[2]);
}
