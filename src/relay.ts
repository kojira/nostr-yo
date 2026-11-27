// Minimal NIP-01 relay client over the browser's native WebSocket.
import type { NostrEvent } from "./yo.js";

export type RelayState = "connecting" | "open" | "closed" | "error";
export type PublishResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

type Listener = () => void;

export class Relay {
  readonly url: string;
  state: RelayState = "closed";
  lastNotice = "";
  private ws: WebSocket | null = null;
  private pendingOk = new Map<string, (r: PublishResult) => void>();
  private subs = new Map<string, { filter: unknown; onEvent: (e: unknown) => void; onEose: () => void; onClosed: (m: string) => void }>();
  private onChange: Listener;
  private openWaiters: Array<(ok: boolean) => void> = [];

  constructor(url: string, onChange: Listener) {
    this.url = url;
    this.onChange = onChange;
  }

  connect(): void {
    if (this.ws && (this.state === "open" || this.state === "connecting")) return;
    this.setState("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (e) {
      this.lastNotice = String(e);
      this.setState("error");
      this.flushOpenWaiters(false);
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.setState("open");
      for (const [id, s] of this.subs) this.sendRaw(["REQ", id, s.filter]);
      this.flushOpenWaiters(true);
    };
    ws.onerror = () => {
      this.lastNotice = "WebSocket error";
      this.setState("error");
    };
    ws.onclose = (ev) => {
      if (this.state !== "error") this.setState("closed");
      if (ev.reason) this.lastNotice = ev.reason;
      for (const [, cb] of this.pendingOk) cb({ ok: false, message: "接続が切れました（OK未受信）" });
      this.pendingOk.clear();
      this.flushOpenWaiters(false);
      this.ws = null;
    };
    ws.onmessage = (m) => this.handle(m.data);
  }

  close(): void {
    this.ws?.close();
  }

  waitOpen(timeoutMs: number): Promise<boolean> {
    if (this.state === "open") return Promise.resolve(true);
    this.connect();
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), timeoutMs);
      this.openWaiters.push((ok) => {
        clearTimeout(t);
        resolve(ok);
      });
    });
  }

  private flushOpenWaiters(ok: boolean) {
    const w = this.openWaiters;
    this.openWaiters = [];
    w.forEach((f) => f(ok));
  }

  private setState(s: RelayState) {
    this.state = s;
    this.onChange();
  }

  private sendRaw(msg: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private handle(data: unknown) {
    if (typeof data !== "string" || data.length > 256 * 1024) return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || typeof msg[0] !== "string") return;
    switch (msg[0]) {
      case "EVENT": {
        const s = typeof msg[1] === "string" ? this.subs.get(msg[1]) : undefined;
        if (s) s.onEvent(msg[2]);
        break;
      }
      case "EOSE": {
        const s = typeof msg[1] === "string" ? this.subs.get(msg[1]) : undefined;
        s?.onEose();
        break;
      }
      case "CLOSED": {
        const s = typeof msg[1] === "string" ? this.subs.get(msg[1]) : undefined;
        s?.onClosed(String(msg[2] ?? ""));
        break;
      }
      case "OK": {
        const cb = typeof msg[1] === "string" ? this.pendingOk.get(msg[1]) : undefined;
        if (cb) {
          this.pendingOk.delete(msg[1] as string);
          cb({ ok: msg[2] === true, message: String(msg[3] ?? "") });
        }
        break;
      }
      case "NOTICE":
        this.lastNotice = String(msg[1] ?? "").slice(0, 300);
        this.onChange();
        break;
    }
  }

  async publish(ev: NostrEvent, timeoutMs = 8000): Promise<PublishResult> {
    const opened = await this.waitOpen(timeoutMs);
    if (!opened) return { ok: false, message: "接続できませんでした" };
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pendingOk.delete(ev.id);
        resolve({ ok: false, message: `タイムアウト（${timeoutMs / 1000}秒以内にOKなし）` });
      }, timeoutMs);
      this.pendingOk.set(ev.id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
      if (!this.sendRaw(["EVENT", ev])) {
        clearTimeout(t);
        this.pendingOk.delete(ev.id);
        resolve({ ok: false, message: "送信できませんでした（未接続）" });
      }
    });
  }

  subscribe(id: string, filter: unknown, onEvent: (e: unknown) => void, onEose: () => void, onClosed: (m: string) => void) {
    this.subs.set(id, { filter, onEvent, onEose, onClosed });
    if (this.state === "open") this.sendRaw(["REQ", id, filter]);
    else this.connect();
  }

  unsubscribe(id: string) {
    if (this.subs.delete(id)) this.sendRaw(["CLOSE", id]);
  }
}
