// Remembered account (public key only) — pure helpers, no DOM.
//
// What is stored: ONLY the public key the user logged in with, so the inbox can
// be shown again after reload / reopening the page. It is NOT a signing
// capability: every signature still goes through the NIP-07 extension at the
// moment the user taps a button, and the extension's current key is re-checked
// against this pubkey first. No secret key, token, or signature is ever stored.
import { isHex64, isValidXOnlyPubkey } from "./yo.js";

export const LS_SESSION = "nostr-yo:session";

/** Parse the stored session; anything unexpected → null (no auto-restore). */
export function parseSession(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (o.v !== 1) return null;
    const keys = Object.keys(o).sort().join(",");
    if (keys !== "pubkey,v") return null; // refuse anything extra (e.g. a secret)
    const pk = o.pubkey;
    if (!isHex64(pk) || !isValidXOnlyPubkey(pk)) return null;
    return pk;
  } catch {
    return null;
  }
}

export function serializeSession(pubkey: string): string {
  if (!isHex64(pubkey) || !isValidXOnlyPubkey(pubkey)) throw new Error("invalid pubkey");
  return JSON.stringify({ v: 1, pubkey });
}

/**
 * Signer state for the remembered account.
 * - checking:   waiting for the extension to appear (extensions inject late)
 * - unverified: extension present, its key not yet asked in this page load
 *               (we do not call it automatically; it is checked when the user sends)
 * - ready:      extension's current key == the account (checked in this page load)
 * - missing:  no NIP-07 extension available (read-only)
 * - mismatch: extension is on a different key (sending blocked until the user acts)
 * - error:    extension refused / failed to answer
 */
export type SignerState = "checking" | "unverified" | "ready" | "missing" | "mismatch" | "error";

export function compareSigner(account: string, extPubkey: unknown): SignerState {
  if (typeof extPubkey !== "string" || !isHex64(extPubkey)) return "error";
  return extPubkey === account ? "ready" : "mismatch";
}

/** Short Japanese label for the signer state (never claims "connected" unless ready). */
export function signerLabel(s: SignerState): string {
  switch (s) {
    case "checking": return "拡張を確認中…";
    case "unverified": return "送信時に拡張で確認します";
    case "ready": return "送信できます";
    case "missing": return "拡張が見つかりません（受信の表示のみ）";
    case "mismatch": return "拡張のアカウントが違います";
    case "error": return "拡張に接続できません";
  }
}

/** Compact local date-time label for a Yo (always includes the date). */
export function formatWhen(unixSec: number, now: Date = new Date()): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}/${md} ${hm}`;
}
