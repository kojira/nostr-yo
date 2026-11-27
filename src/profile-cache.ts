// Sender profile cache: reuses already-loaded profiles and batches lookups for
// unknown authors (each author queried at most once per session).
import type { Relay } from "./relay.js";
import { AUTHORS_PER_REQ, chunk, newerProfile, parseProfile, type FollowProfile } from "./follows.js";

export type LookupState = "pending" | "found" | "none" | "failed";

export class ProfileCache {
  private profiles = new Map<string, FollowProfile>();
  private state = new Map<string, LookupState>();
  private queue = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  queries = 0;

  constructor(private getRelays: () => Relay[], private external: () => Map<string, FollowProfile>, private onChange: () => void) {}

  get(pk: string): { profile: FollowProfile | undefined; state: LookupState } {
    const ext = this.external().get(pk);
    const own = this.profiles.get(pk);
    const p = ext && own ? newerProfile(ext, own) : ext ?? own;
    if (p) return { profile: p, state: "found" };
    return { profile: undefined, state: this.state.get(pk) ?? "pending" };
  }

  /** Request profiles for authors not yet known/queried. */
  want(pks: Iterable<string>): void {
    for (const pk of pks) {
      if (this.external().has(pk) || this.profiles.has(pk) || this.state.has(pk)) continue;
      this.state.set(pk, "pending");
      this.queue.add(pk);
    }
    if (this.queue.size && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 300);
  }

  private async flush(): Promise<void> {
    const batch = [...this.queue];
    this.queue.clear();
    const relays = this.getRelays();
    let anyAnswered = false;
    for (const r of relays) {
      const missing = batch.filter((pk) => !this.profiles.has(pk) && !this.external().has(pk));
      if (!missing.length) break;
      for (const c of chunk(missing, AUTHORS_PER_REQ)) {
        this.queries++;
        const q = await r.query({ kinds: [0], authors: c }, 10000, c.length * 3);
        if (q.status === "eose") anyAnswered = true;
        const wanted = new Set(c);
        for (const ev of q.events) {
          const pk = (ev as { pubkey?: unknown })?.pubkey;
          if (typeof pk !== "string" || !wanted.has(pk)) continue;
          const p = parseProfile(ev, pk);
          if (p) { this.profiles.set(pk, newerProfile(this.profiles.get(pk), p)); this.state.set(pk, "found"); }
        }
      }
      this.onChange();
    }
    for (const pk of batch) {
      if (this.profiles.has(pk)) continue;
      // Served by the external (follow) map: forget the pending mark so it can be
      // looked up again if that map is reset (logout / account switch).
      if (this.external().has(pk)) this.state.delete(pk);
      else this.state.set(pk, anyAnswered ? "none" : "failed");
    }
    this.onChange();
  }
}
