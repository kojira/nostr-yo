// Relay defaults and stored-setting resolution (pure; no DOM).
import { normalizeRelay } from "./yo.js";

/** Default relays, in this order. Used only when the user has no saved list. */
export const DEFAULT_RELAYS: readonly string[] = Object.freeze([
  "wss://r.kojira.io",
  "wss://yabu.me",
  "wss://x.kojira.io",
  "wss://n.kojira.io",
]);
export const LS_RELAYS = "nostr-yo:relays";

/**
 * Resolve the relay list from the raw localStorage value.
 * A previously saved, valid list is kept as-is (invalid entries are dropped);
 * only when nothing usable is saved do we fall back to DEFAULT_RELAYS.
 */
export function resolveRelayUrls(stored: string | null): string[] {
  if (stored !== null) {
    try {
      const v: unknown = JSON.parse(stored);
      if (Array.isArray(v)) {
        const ok: string[] = [];
        for (const x of v) {
          if (typeof x !== "string") continue;
          try {
            const u = normalizeRelay(x);
            if (!ok.includes(u)) ok.push(u);
          } catch { /* drop invalid */ }
        }
        if (ok.length) return ok;
      }
    } catch { /* corrupt → defaults */ }
  }
  return [...DEFAULT_RELAYS];
}
