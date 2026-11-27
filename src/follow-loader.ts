// Loads my latest kind 3 and my follows' kind 0 with bounded relay load.
import type { Relay } from "./relay.js";
import { AUTHORS_PER_REQ, chunk, extractFollows, newerProfile, parseProfile, pickLatest, type FollowProfile } from "./follows.js";

export type FollowState =
  | { phase: "idle" }
  | { phase: "loading-kind3" }
  | { phase: "failed"; message: string }
  | { phase: "no-kind3" }
  | { phase: "empty" }
  | { phase: "profiles"; follows: string[]; done: number; total: number; truncated: boolean }
  | { phase: "ready"; follows: string[]; truncated: boolean; missing: number; queries: number };

const MAX_PARALLEL = 2;

export class FollowLoader {
  follows: string[] = [];
  profiles = new Map<string, FollowProfile>();
  state: FollowState = { phase: "idle" };
  queries = 0;
  private gen = 0;
  constructor(private onChange: () => void) {}

  private set(s: FollowState) { this.state = s; this.onChange(); }

  async load(me: string, relays: Relay[]): Promise<void> {
    const gen = ++this.gen;
    this.follows = []; this.profiles.clear(); this.queries = 0;
    this.set({ phase: "loading-kind3" });
    const res = await Promise.all(relays.map(async (r) => { this.queries++; return { r, q: await r.query({ kinds: [3], authors: [me], limit: 1 }, 10000, 5) }; }));
    if (gen !== this.gen) return;
    if (res.every(({ q }) => q.status !== "eose")) {
      this.set({ phase: "failed", message: res.map(({ r, q }) => `${r.url}: ${q.status}${q.message ? ` (${q.message})` : ""}`).join(" / ") });
      return;
    }
    const k3 = pickLatest(res.flatMap(({ q }) => q.events), 3, me);
    if (!k3) { this.set({ phase: "no-kind3" }); return; }
    const { pubkeys, truncated } = extractFollows(k3, me);
    if (!pubkeys.length) { this.set({ phase: "empty" }); return; }
    this.follows = pubkeys;
    const total = pubkeys.length;
    this.set({ phase: "profiles", follows: pubkeys, done: 0, total, truncated });

    // Relay by relay: ask each next relay only for pubkeys still missing.
    for (const r of relays) {
      const missing = pubkeys.filter((pk) => !this.profiles.has(pk));
      if (!missing.length) break;
      const chunks = chunk(missing, AUTHORS_PER_REQ);
      let next = 0;
      const worker = async () => {
        while (next < chunks.length) {
          const c = chunks[next++]!;
          this.queries++;
          const q = await r.query({ kinds: [0], authors: c }, 12000, c.length * 3);
          if (gen !== this.gen) return;
          const wanted = new Set(c);
          for (const ev of q.events) {
            const pk = (ev as { pubkey?: unknown })?.pubkey;
            if (typeof pk !== "string" || !wanted.has(pk)) continue;
            const p = parseProfile(ev, pk);
            if (p) this.profiles.set(pk, newerProfile(this.profiles.get(pk), p));
          }
          this.set({ phase: "profiles", follows: pubkeys, done: this.profiles.size, total, truncated });
          await new Promise((res) => setTimeout(res, 0)); // yield to UI
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, chunks.length) }, worker));
      if (gen !== this.gen) return;
    }
    this.set({ phase: "ready", follows: pubkeys, truncated, missing: total - this.profiles.size, queries: this.queries });
  }
}
