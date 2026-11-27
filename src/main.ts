// UI entry point. All untrusted text is rendered via textContent only.
import { Relay, type PublishResult } from "./relay.js";
import { LS_RELAYS, resolveRelayUrls } from "./config.js";
import { FollowLoader } from "./follow-loader.js";
import { searchFollows } from "./follows.js";
import { ProfileCache } from "./profile-cache.js";
import {
  buildYo,
  parseIncomingYo,
  pickLatestProfile,
  profileFilter,
  checkSignedYo,
  normalizeRelay,
  parsePubkey,
  shortNpub,
  toNpub,
  yoFilter,
  type IncomingYo,
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
const received: IncomingYo[] = [];
/** ids of my own kind 0 events seen (verified), to mark Yo targets as confirmed */
const myProfileIds = new Set<string>();
let rejected = 0;
/** recipient fixed by choosing a follow from search (cleared when the to-field is edited) */
let selected: { pubkey: string; label: string } | null = null;
let inboxRenderQueued = false;
function scheduleInbox() {
  if (inboxRenderQueued) return;
  inboxRenderQueued = true;
  // setTimeout (not rAF): rAF never fires in background tabs, which would freeze the inbox.
  setTimeout(() => { inboxRenderQueued = false; renderInbox(); }, 50);
}
const follows = new FollowLoader(() => { renderFollowState(); renderSearch(); if (follows.state.phase === "ready") scheduleInbox(); });
const senders = new ProfileCache(() => [...relays], () => follows.profiles, scheduleInbox);

function loadRelayUrls(): string[] {
  let raw: string | null = null;
  try { raw = localStorage.getItem(LS_RELAYS); } catch { /* storage blocked */ }
  return resolveRelayUrls(raw);
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
  const yo = parseIncomingYo(ev, mine);
  if (!yo) {
    rejected++;
    if (typeof id === "string") seen.add(id);
    setInboxNote();
    return;
  }
  seen.add(yo.ev.id);
  received.push(yo);
  received.sort((a, b) => b.ev.created_at - a.ev.created_at);
  renderInbox();
  if (received[0]?.ev.id === yo.ev.id && yo.ev.created_at > Date.now() / 1000 - 60) bounce();
}

async function loadMyProfiles(mine: string) {
  const res = await Promise.all(relays.map(async (r) => {
    const q = await r.query({ kinds: [0], authors: [mine], limit: 5 });
    return q.events.map((ev) => ({ ev, relay: r.url }));
  }));
  for (const { ev } of res.flat()) {
    const t = pickLatestProfile([{ ev, relay: "" }], mine);
    if (t) myProfileIds.add(t.id);
  }
  renderInbox();
}

function setInboxNote() {
  $("inbox-note").textContent =
    `${received.length} 件の Yo（署名検証済み）` + (rejected ? ` ／ 検証失敗などで破棄: ${rejected} 件` : "");
}

const AVATAR_COLORS = ["#7b2ff7", "#f107a3", "#1aa260", "#e67e22", "#2d7ff9", "#c0392b", "#16a085", "#8e44ad"];

/** Letter avatar (built-in, no network). */
function letterAvatar(pubkey: string, name: string): HTMLElement {
  const d = el("span", "avatar letter", ([...name.trim()][0] ?? "?").toUpperCase());
  d.style.background = AVATAR_COLORS[parseInt(pubkey.slice(0, 2), 16) % AVATAR_COLORS.length]!;
  d.setAttribute("aria-hidden", "true");
  return d;
}

/** Profile picture with privacy-preserving attributes and fallback to a letter avatar. */
function avatar(pubkey: string, picture: string, name: string): HTMLElement {
  if (!picture) return letterAvatar(pubkey, name);
  const img = document.createElement("img");
  img.className = "avatar";
  img.alt = "";
  img.width = 36;
  img.height = 36;
  img.referrerPolicy = "no-referrer";
  img.crossOrigin = "anonymous";
  img.loading = "lazy";
  img.decoding = "async";
  img.onerror = () => { img.replaceWith(letterAvatar(pubkey, name)); };
  img.src = picture; // safePictureUrl(): https only
  return img;
}

function renderInbox() {
  senders.want(received.slice(0, 100).map((y) => y.ev.pubkey));
  const ul = $("inbox");
  ul.replaceChildren();
  for (const yo of received.slice(0, 100)) {
    const { ev: e, targetId } = yo;
    const li = el("li", "yo-item");
    const img = document.createElement("img");
    img.src = "yo.png"; // our own static copy; never load the URL from the event
    img.alt = ":yo:";
    img.className = "yo-emoji";
    li.append(img);
    const { profile, state } = senders.get(e.pubkey);
    const name = profile ? (profile.displayName || profile.name) : "";
    const who = el("button", "from") as HTMLButtonElement;
    who.type = "button";
    who.append(avatar(e.pubkey, profile?.picture ?? "", name));
    const names = el("span", "from-names");
    names.append(el("span", name ? "from-name" : "from-name none", name || (state === "pending" ? "読み込み中…" : state === "failed" ? "プロフィール取得失敗" : profile ? "(名前なし)" : "プロフィールなし")));
    names.append(el("span", "from-npub", shortNpub(e.pubkey)));
    who.append(names);
    who.title = `${toNpub(e.pubkey)} を宛先欄に入れる`;
    who.onclick = () => {
      clearSelection(false);
      ($("to") as HTMLInputElement).value = toNpub(e.pubkey);
      ($("to") as HTMLInputElement).focus();
    };
    const conf = myProfileIds.has(targetId);
    const badge = el("span", conf ? "target ok" : "target", conf ? "kind0 一致" : "kind0 未確認");
    badge.title = conf ? `対象 kind0 ${targetId} はあなたのプロフィールと確認済み` : `対象 kind0 ${targetId}（あなたの既知のプロフィールと未照合／古い版の可能性）`;
    li.append(who, badge);
    if (!yo.ours) {
      const o = el("span", "target other", "他実装");
      o.title = `絵文字画像は ${yo.emojiHost} を指定（読み込まず当サイトの画像で表示）`;
      li.append(o);
    }
    li.append(el("time", "when", new Date(e.created_at * 1000).toLocaleString()));
    // Yo back: recipient is the verified author of this event (never a tag value).
    const author = e.pubkey;
    const back = el("button", "yo-back", "Yo! を返す") as HTMLButtonElement;
    back.type = "button";
    back.dataset.to = author;
    back.title = `${toNpub(author)} に Yo を返す（署名が必要）`;
    back.disabled = sending;
    const rowNote = el("span", "row-note", `返信先: ${name ? `${name} ` : ""}(${shortNpub(author)})`);
    back.onclick = () => { void sendYoTo(author, rowNote); };
    li.append(back, rowNote);
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
  void loadMyProfiles(me);
  ($("search") as HTMLInputElement).disabled = false;
  void follows.load(me, [...relays]);
}

let sending = false;

function setSendingUi(on: boolean) {
  sending = on;
  ($("send") as HTMLButtonElement).disabled = on;
  document.querySelectorAll<HTMLButtonElement>("button.yo-back").forEach((b) => (b.disabled = on));
}

/** Manual send from the form (selected follow or typed npub). */
async function sendYo() {
  if (!me || !window.nostr) { status("先に「拡張でログイン」してください", "err"); return; }
  let to: string;
  try {
    to = selected ? selected.pubkey : parsePubkey(($("to") as HTMLInputElement).value);
  } catch (e) {
    status((e as Error).message, "err");
    return;
  }
  await sendYoTo(to, null);
}

/**
 * Shared send path: newest verified kind 0 of `to` → build kind 7 Yo →
 * NIP-07 sign → strict check of the signed event → publish. Returns true on ≥1 OK.
 * `rowNote` (optional) mirrors progress in a received-Yo row.
 */
async function sendYoTo(to: string, rowNote: HTMLElement | null): Promise<boolean> {
  const note = (t: string, kind: "info" | "ok" | "err" = "info") => {
    status(t, kind);
    if (rowNote) { rowNote.textContent = t; rowNote.className = `row-note ${kind}`; }
  };
  if (!me || !window.nostr) { note("先に「拡張でログイン」してください", "err"); return false; }
  if (sending) { note("送信中です。完了までお待ちください", "err"); return false; }
  if (relays.length === 0) { note("relay がありません", "err"); return false; }
  setSendingUi(true);
  try {
    note(`宛先 ${shortNpub(to)} の最新プロフィール (kind 0) を検索中…`);
    const qs = await Promise.all(relays.map(async (r) => ({ r, q: await r.query(profileFilter(to)) })));
    const target = pickLatestProfile(qs.flatMap(({ r, q }) => q.events.map((ev) => ({ ev, relay: r.url }))), to);
    if (!target) {
      const detail = qs.map(({ r, q }) => `${r.url}: ${q.status === "eose" ? `${q.events.length}件` : q.status}${q.message ? ` (${q.message})` : ""}`).join(" / ");
      const allFailed = qs.every(({ q }) => q.status !== "eose");
      note(allFailed
        ? `プロフィール検索に失敗しました（どの relay からも応答なし）。送信していません。 ${detail}`
        : `宛先の署名検証済み kind 0 プロフィールが見つかりません。Yo はプロフィールへのリアクションなので送信できません。 ${detail}`, "err");
      $("send-results").replaceChildren();
      return false;
    }
    const req = buildYo(target);
    note(`${shortNpub(to)} 宛ての Yo を拡張で署名してください…`);
    let signed: unknown;
    try {
      signed = await window.nostr.signEvent(structuredClone(req));
    } catch (e) {
      note(`署名が拒否/失敗しました: ${(e as Error).message ?? e}`, "err");
      return false;
    }
    const problems = checkSignedYo(signed, req, me);
    if (problems.length) {
      note(`署名済みイベントが要求と一致しないため送信を中止しました: ${problems.join(" / ")}`, "err");
      return false;
    }
    const ev = signed as NostrEvent;
    note(`${relays.length} 個の relay に送信中…（応答を待っています）`);
    const targets = [...relays];
    const results: Array<[Relay, PublishResult | null]> = targets.map((r) => [r, null]);
    renderSendResults(results, to, false);
    await Promise.all(targets.map(async (r, i) => {
      const res = await r.publish(ev);
      results[i] = [r, res];
      renderSendResults(results, to, false);
    }));
    renderSendResults(results, to, true);
    const ok = results.filter(([, r]) => r?.ok).length;
    if (rowNote) {
      rowNote.textContent = ok ? `✓ Yo を返しました（${ok}/${results.length} relay）` : `✗ 失敗（0/${results.length} relay）`;
      rowNote.className = `row-note ${ok ? "ok" : "err"}`;
    }
    return ok > 0;
  } finally {
    setSendingUi(false);
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
    status(`Yo! (:yo: リアクション) を ${shortNpub(to)} のプロフィールに送りました（${okCount}/${results.length} relay が受理）`, "ok");
    bounce();
  } else {
    status(`どの relay にも受理されませんでした（0/${results.length}）`, "err");
  }
}

function renderFollowState() {
  const st = follows.state;
  const t = $("follow-state");
  let msg = "";
  let cls = "small";
  switch (st.phase) {
    case "idle": msg = "ログインするとフォローリスト (kind 3) を読み込みます。"; break;
    case "loading-kind3": msg = "フォローリスト (kind 3) を読み込み中…"; break;
    case "failed": msg = `フォローリストの取得に失敗しました（全relay応答なし）: ${st.message}`; cls += " bad"; break;
    case "no-kind3": msg = "署名検証済みのフォローリスト (kind 3) が見つかりません。npub を直接入力してください。"; cls += " bad"; break;
    case "empty": msg = "フォローリストは空です。npub を直接入力してください。"; break;
    case "profiles": msg = `フォロー ${st.total} 人。プロフィール取得中… ${st.done}/${st.total}` + (st.truncated ? "（先頭5000人のみ）" : ""); break;
    case "ready": msg = `フォロー ${st.follows.length} 人（プロフィールあり ${st.follows.length - st.missing} / なし ${st.missing}）` + (st.truncated ? "（先頭5000人のみ）" : "") + ` ・ クエリ ${st.queries} 件`; break;
  }
  t.textContent = msg;
  t.className = cls;
}

function renderSearch() {
  const ul = $("search-results");
  ul.replaceChildren();
  const q = ($("search") as HTMLInputElement).value;
  if (!q.trim()) return;
  if (!follows.follows.length) {
    ul.append(el("li", "none", "検索できるフォローがまだありません"));
    return;
  }
  const rows = searchFollows(q, follows.follows, follows.profiles, 30);
  if (!rows.length) {
    ul.append(el("li", "none", follows.state.phase === "profiles" ? "見つかりません（プロフィール取得中）" : "見つかりません"));
    return;
  }
  for (const r of rows) {
    const li = el("li");
    const b = el("button", "pick") as HTMLButtonElement;
    b.type = "button";
    b.dataset.pubkey = r.pubkey;
    b.append(avatar(r.pubkey, r.picture, r.hasProfile ? r.label : ""));
    b.append(el("span", r.hasProfile ? "pick-name" : "pick-name none", r.label));
    if (r.name && r.name !== r.label) b.append(el("span", "pick-sub", `@${r.name}`));
    if (r.nip05) b.append(el("span", "pick-sub", r.nip05));
    b.append(el("span", "pick-npub", `${r.npub.slice(0, 14)}…${r.npub.slice(-8)}`));
    b.onclick = () => selectRecipient(r.pubkey, r.label);
    li.append(b);
    ul.append(li);
  }
}

function selectRecipient(pubkey: string, label: string) {
  selected = { pubkey, label };
  ($("to") as HTMLInputElement).value = toNpub(pubkey);
  const box = $("selected");
  box.replaceChildren(el("span", "sel-label", `選択中: ${label}`), el("code", "sel-npub", toNpub(pubkey)));
  const x = el("button", "rm", "×") as HTMLButtonElement;
  x.type = "button";
  x.title = "選択解除";
  x.onclick = () => clearSelection(true);
  box.append(x);
  box.hidden = false;
  $("search-results").replaceChildren();
  ($("search") as HTMLInputElement).value = "";
}

function clearSelection(clearField: boolean) {
  selected = null;
  $("selected").hidden = true;
  $("selected").replaceChildren();
  if (clearField) ($("to") as HTMLInputElement).value = "";
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
  ($("to") as HTMLInputElement).oninput = () => { if (selected) clearSelection(false); };
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  ($("search") as HTMLInputElement).oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 120); };
  // Extensions often inject window.nostr slightly after load.
  setTimeout(() => {
    $("ext").textContent = window.nostr ? "NIP-07 拡張: 検出" : "NIP-07 拡張: 未検出";
  }, 400);
}

init();
