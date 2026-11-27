// UI entry point. All untrusted text is rendered via textContent only.
import { Relay, type PublishResult } from "./relay.js";
import {
  acceptIncomingYo,
  buildYo,
  checkSignedYo,
  normalizeRelay,
  parsePubkey,
  shortNpub,
  toNpub,
  yoFilter,
  type NostrEvent,
} from "./yo.js";

interface Nip07 {
  getPublicKey(): Promise<string>;
  signEvent(e: unknown): Promise<unknown>;
}
declare global {
  interface Window {
    nostr?: Nip07;
  }
}

const DEFAULT_RELAYS = ["wss://nos.lol", "wss://yabu.me", "wss://nostr.mom", "wss://relay.damus.io"];
const LS_RELAYS = "nostr-yo:relays";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

let me: string | null = null;
let relays: Relay[] = [];
const seen = new Set<string>();
const received: NostrEvent[] = [];
let rejected = 0;

function loadRelayUrls(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LS_RELAYS) ?? "null");
    if (Array.isArray(v)) {
      const ok = v.filter((x) => typeof x === "string").map((x) => {
        try { return normalizeRelay(x); } catch { return null; }
      }).filter((x): x is string => !!x);
      if (ok.length) return ok;
    }
  } catch { /* ignore */ }
  return DEFAULT_RELAYS;
}

function saveRelayUrls() {
  localStorage.setItem(LS_RELAYS, JSON.stringify(relays.map((r) => r.url)));
}

const STATE_LABEL: Record<string, string> = {
  connecting: "接続中…",
  open: "接続OK",
  closed: "未接続",
  error: "エラー",
};

function renderRelays() {
  const ul = $("relays");
  ul.replaceChildren();
  for (const r of relays) {
    const li = el("li", `relay ${r.state}`);
    li.dataset.url = r.url;
    li.append(el("span", "dot"), el("span", "url", r.url), el("span", "state", STATE_LABEL[r.state] ?? r.state));
    if (r.lastNotice) li.append(el("span", "notice", r.lastNotice));
    const rm = el("button", "rm", "×") as HTMLButtonElement;
    rm.title = "このrelayを外す";
    rm.onclick = () => {
      r.close();
      relays = relays.filter((x) => x !== r);
      saveRelayUrls();
      renderRelays();
    };
    li.append(rm);
    ul.append(li);
  }
}

function makeRelay(url: string) {
  const r = new Relay(url, renderRelays);
  r.connect();
  if (me) subscribeOne(r);
  return r;
}

function subscribeOne(r: Relay) {
  if (!me) return;
  const mine = me;
  r.subscribe(
    "yo-inbox",
    yoFilter(mine),
    (ev) => onIncoming(ev, mine),
    () => setInboxNote(),
    (m) => { r.lastNotice = `購読が閉じられました: ${m}`; renderRelays(); },
  );
}

function onIncoming(ev: unknown, mine: string) {
  const id = (ev as { id?: unknown })?.id;
  if (typeof id === "string" && seen.has(id)) return;
  if (!acceptIncomingYo(ev, mine)) {
    rejected++;
    setInboxNote();
    return;
  }
  seen.add(ev.id);
  received.push(ev);
  received.sort((a, b) => b.created_at - a.created_at);
  renderInbox();
  const newest = received[0];
  if (newest && newest.id === ev.id && ev.created_at > Date.now() / 1000 - 60) bounce();
}

function setInboxNote() {
  $("inbox-note").textContent =
    `${received.length} 件の Yo（署名検証済み）` + (rejected ? ` ／ 検証失敗などで破棄: ${rejected} 件` : "");
}

function renderInbox() {
  const ul = $("inbox");
  ul.replaceChildren();
  for (const e of received.slice(0, 100)) {
    const li = el("li", "yo-item");
    li.append(el("span", "yo-word", "Yo!"));
    const who = el("button", "from", `from ${shortNpub(e.pubkey)}`) as HTMLButtonElement;
    who.title = "この人に Yo を返す";
    who.onclick = () => {
      ($("to") as HTMLInputElement).value = toNpub(e.pubkey);
      ($("to") as HTMLInputElement).focus();
    };
    li.append(who, el("time", "when", new Date(e.created_at * 1000).toLocaleString()));
    ul.append(li);
  }
  setInboxNote();
}

function bounce() {
  const b = $("logo");
  b.classList.remove("bounce");
  void b.offsetWidth;
  b.classList.add("bounce");
}

function status(text: string, kind: "info" | "ok" | "err" = "info") {
  const s = $("status");
  s.textContent = text;
  s.className = `status ${kind}`;
}

async function login() {
  if (!window.nostr) {
    status("NIP-07 拡張（nos2x / Alby / nostr-keyx など）が見つかりません。インストールして再読み込みしてください。", "err");
    return;
  }
  try {
    const pk = await window.nostr.getPublicKey();
    if (typeof pk !== "string" || !/^[0-9a-f]{64}$/.test(pk)) throw new Error("拡張が不正な公開鍵を返しました");
    me = pk;
  } catch (e) {
    status(`公開鍵を取得できませんでした: ${(e as Error).message ?? e}`, "err");
    return;
  }
  $("me").textContent = toNpub(me);
  document.body.classList.add("logged-in");
  status("ログインしました。受信箱を購読中…", "ok");
  for (const r of relays) subscribeOne(r);
}

async function sendYo() {
  if (!me || !window.nostr) { status("先に「拡張でログイン」してください", "err"); return; }
  let to: string;
  try {
    to = parsePubkey(($("to") as HTMLInputElement).value);
  } catch (e) {
    status((e as Error).message, "err");
    return;
  }
  if (relays.length === 0) { status("relay がありません", "err"); return; }
  const btn = $("send") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const req = buildYo(to);
    status("拡張で署名を確認してください…");
    let signed: unknown;
    try {
      signed = await window.nostr.signEvent(structuredClone(req));
    } catch (e) {
      status(`署名が拒否/失敗しました: ${(e as Error).message ?? e}`, "err");
      return;
    }
    const problems = checkSignedYo(signed, req, me);
    if (problems.length) {
      status(`署名済みイベントが要求と一致しないため送信を中止しました: ${problems.join(" / ")}`, "err");
      return;
    }
    const ev = signed as NostrEvent;
    status(`${relays.length} 個の relay に送信中…（応答を待っています）`);
    const targets = [...relays];
    const results: Array<[Relay, PublishResult | null]> = targets.map((r) => [r, null]);
    renderSendResults(results, to, false);
    await Promise.all(targets.map(async (r, i) => {
      const res = await r.publish(ev);
      results[i] = [r, res];
      renderSendResults(results, to, false);
    }));
    renderSendResults(results, to, true);
  } finally {
    btn.disabled = false;
  }
}

function renderSendResults(results: Array<[Relay, PublishResult | null]>, to: string, done: boolean) {
  const ul = $("send-results");
  ul.replaceChildren();
  let okCount = 0;
  for (const [r, res] of results) {
    if (res?.ok) okCount++;
    const li = el("li", res === null ? "pending" : res.ok ? "ok" : "err");
    li.append(el("span", "url", r.url), el("span", "res", res === null ? "… 応答待ち" : res.ok ? "✓ 受理 (OK true)" : "✗ 失敗"));
    if (res?.message) li.append(el("span", "notice", res.message));
    ul.append(li);
  }
  if (!done) {
    if (okCount > 0) status(`Yo! 送信中… いま ${okCount}/${results.length} relay が受理`, "ok");
    return;
  }
  if (okCount > 0) {
    status(`Yo! を ${shortNpub(to)} に送りました（${okCount}/${results.length} relay が受理）`, "ok");
    bounce();
  } else {
    status(`どの relay にも受理されませんでした（0/${results.length}）`, "err");
  }
}

function addRelay(ev: Event) {
  ev.preventDefault();
  const input = $("relay-input") as HTMLInputElement;
  try {
    const url = normalizeRelay(input.value);
    if (relays.some((r) => r.url === url)) throw new Error("追加済みです");
    relays.push(makeRelay(url));
    saveRelayUrls();
    input.value = "";
    renderRelays();
  } catch (e) {
    status(`relay 追加失敗: ${(e as Error).message}`, "err");
  }
}

function init() {
  relays = loadRelayUrls().map(makeRelay);
  renderRelays();
  $("login").onclick = login;
  $("send").onclick = sendYo;
  $("relay-form").onsubmit = addRelay;
  ($("to") as HTMLInputElement).onkeydown = (e) => { if (e.key === "Enter") void sendYo(); };
  // Extensions often inject window.nostr slightly after load.
  setTimeout(() => {
    $("ext").textContent = window.nostr ? "NIP-07 拡張: 検出" : "NIP-07 拡張: 未検出";
  }, 400);
}

init();
