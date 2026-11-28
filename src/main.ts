// UI entry point. All untrusted text is rendered via textContent only.
//
// Account model:
//  - `account` is the public key the user explicitly logged in with. It is
//    remembered (pubkey only, see session.ts) so the inbox survives reloads and
//    returning from the background. It is NOT a signing permission.
//  - Signing always goes through the NIP-07 extension, only after a user tap,
//    and the extension's current key is re-checked against `account` first.
//  - Explicit logout forgets the account and suppresses any auto-restore.
import { Relay, type PublishResult } from "./relay.js";
import { LS_RELAYS, resolveRelayUrls } from "./config.js";
import { FollowLoader } from "./follow-loader.js";
import { searchFollows } from "./follows.js";
import { ProfileCache } from "./profile-cache.js";
import { LS_SESSION, compareSigner, formatWhen, parseSession, serializeSession, signerLabel, type SignerState } from "./session.js";
import {
  buildYo,
  parseIncomingYo,
  parseSentYo,
  sentYoFilter,
  pickLatestProfile,
  profileFilter,
  checkSignedYo,
  normalizeRelay,
  parsePubkey,
  shortNpub,
  toNpub,
  yoFilter,
  type IncomingYo,
  type SentYo,
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
const input = (id: string) => $(id) as HTMLInputElement;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------- state
let account: string | null = null;
/** bumps on every login / account switch / logout; stale async work checks it */
let accountGen = 0;
let signer: SignerState = "checking";
let relays: Relay[] = [];
let seen = new Set<string>();
let received: IncomingYo[] = [];
let inboxLoaded = false;
let inboxShown = 5;
/** Send history: only valid Yo authored by `account`, read back from relays (or accepted by ≥1 relay in this page). */
let sentSeen = new Set<string>();
let sent: SentYo[] = [];
let sentLoaded = false;
let sentShown = 5;
let tab: "in" | "out" = "in";
let selected: { pubkey: string; label: string } | null = null;
let sending = false;

let inboxRenderQueued = false;
function scheduleInbox() {
  if (inboxRenderQueued) return;
  inboxRenderQueued = true;
  // setTimeout (not rAF): rAF never fires in background tabs, which would freeze the inbox.
  setTimeout(() => { inboxRenderQueued = false; renderInbox(); renderSent(); renderAccount(); }, 50);
}
const follows = new FollowLoader(() => { renderFollowState(); renderSearch(); if (follows.state.phase === "ready") scheduleInbox(); });
const senders = new ProfileCache(() => [...relays], () => follows.profiles, scheduleInbox);

// ---------------------------------------------------------------- storage
function storageGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function storageSet(k: string, v: string | null) {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ }
}

// ---------------------------------------------------------------- relays
function saveRelayUrls() {
  storageSet(LS_RELAYS, JSON.stringify(relays.map((r) => r.url)));
}

const STATE_LABEL: Record<string, string> = { connecting: "接続中…", open: "接続中", closed: "未接続", error: "エラー" };

let relayRenderQueued = false;
function onRelayChange() {
  if (relayRenderQueued) return;
  relayRenderQueued = true;
  setTimeout(() => { relayRenderQueued = false; renderRelays(); renderNet(); }, 30);
}

function renderRelays() {
  const ul = $("relays");
  ul.replaceChildren();
  for (const r of relays) {
    const li = el("li", `relay ${r.state}`);
    li.dataset.url = r.url;
    li.append(el("span", "dot"), el("span", "url", r.url), el("span", "state", STATE_LABEL[r.state] ?? r.state));
    if (r.lastNotice && r.state !== "open") li.append(el("span", "notice", r.lastNotice));
    const rm = el("button", "rm", "×") as HTMLButtonElement;
    rm.type = "button";
    rm.setAttribute("aria-label", `${r.url} を外す`);
    rm.onclick = () => {
      r.close();
      relays = relays.filter((x) => x !== r);
      saveRelayUrls();
      renderRelays();
      renderNet();
    };
    li.append(rm);
    ul.append(li);
  }
}

let netGraceUntil = 0;
function renderNet() {
  const n = $("net");
  if (!account) { n.hidden = true; return; }
  const open = relays.filter((r) => r.state === "open").length;
  if (relays.length === 0) { n.textContent = "リレーがありません。メニューの「リレー設定」で追加してください。"; n.hidden = false; return; }
  if (open > 0 || Date.now() < netGraceUntil) { n.hidden = true; return; }
  n.textContent = "リレーに接続できていません。再接続しています…";
  n.hidden = false;
}

function makeRelay(url: string) {
  const r = new Relay(url, onRelayChange);
  r.connect();
  if (account) subscribeOne(r);
  return r;
}

function subscribeOne(r: Relay) {
  if (!account) return;
  const mine = account;
  const gen = accountGen;
  r.subscribe(
    "yo-inbox",
    yoFilter(mine),
    (ev) => { if (gen === accountGen) onIncoming(ev, mine); },
    () => { if (gen === accountGen && !inboxLoaded) { inboxLoaded = true; renderInbox(); } },
    (m) => { r.lastNotice = `購読が閉じられました: ${m}`; onRelayChange(); },
  );
  r.subscribe(
    "yo-sent",
    sentYoFilter(mine),
    (ev) => { if (gen === accountGen) onSent(ev, mine); },
    () => { if (gen === accountGen && !sentLoaded) { sentLoaded = true; renderSent(); } },
    () => { if (gen === accountGen && !sentLoaded) { sentLoaded = true; renderSent(); } },
  );
}

/** A Yo authored by `mine` (from a relay, or our own signed event once a relay accepted it). */
function onSent(ev: unknown, mine: string) {
  const id = (ev as { id?: unknown })?.id;
  if (typeof id === "string" && sentSeen.has(id)) return;
  const yo = parseSentYo(ev, mine);
  if (typeof id === "string") sentSeen.add(id);
  if (!yo) return;
  sent.push(yo);
  sent.sort((a, b) => b.ev.created_at - a.ev.created_at);
  scheduleInbox();
}

function reconnectAll() {
  netGraceUntil = Date.now() + 6000;
  setTimeout(renderNet, 6100);
  for (const r of relays) r.reconnectIfNeeded();
}

// ---------------------------------------------------------------- inbox
function onIncoming(ev: unknown, mine: string) {
  const id = (ev as { id?: unknown })?.id;
  if (typeof id === "string" && seen.has(id)) return;
  // Strict recognition (signature, kind, content, tags, recipient) — see SPEC.md.
  const yo = parseIncomingYo(ev, mine);
  if (typeof id === "string") seen.add(id);
  if (!yo) return; // not a valid Yo for me: silently ignored
  received.push(yo);
  received.sort((a, b) => b.ev.created_at - a.ev.created_at);
  scheduleInbox();
  if (received[0]?.ev.id === yo.ev.id && yo.ev.created_at > Date.now() / 1000 - 60) bounce();
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
  img.width = 38;
  img.height = 38;
  img.referrerPolicy = "no-referrer";
  // No crossOrigin: the image is only displayed (never read via canvas), so a plain
  // no-cors request is used. CORS mode would make hosts without
  // Access-Control-Allow-Origin fail and fall back to the letter avatar.
  img.loading = "lazy";
  img.decoding = "async";
  img.onerror = () => { img.replaceWith(letterAvatar(pubkey, name)); };
  img.src = picture; // safePictureUrl(): https only
  return img;
}

function displayName(pubkey: string): { name: string; picture: string; state: string } {
  const { profile, state } = senders.get(pubkey);
  return { name: profile ? (profile.displayName || profile.name) : "", picture: profile?.picture ?? "", state };
}

/** Small inline "more" indicator inside a name button (decorative). */
function chevron(): HTMLElement {
  const c = el("span", "chev", "▾");
  c.setAttribute("aria-hidden", "true");
  return c;
}

/** Inbox rows whose details are open (by event id); survives re-renders. */
const openDetails = new Set<string>();

/** Per-row progress notes survive re-renders. */
const rowNotes = new Map<string, { text: string; kind: "info" | "ok" | "err" }>();

function renderInbox() {
  const card = $("inbox-card");
  card.hidden = !account;
  if (!account) { $("inbox").replaceChildren(); $("panel-in").querySelector("button.more")?.remove(); return; }
  const rows = received.slice(0, Math.min(inboxShown, 100));
  senders.want(rows.map((y) => y.ev.pubkey));
  const ul = $("inbox");
  // Keep keyboard focus across re-renders (profiles arriving re-render the list).
  const focusKey = (document.activeElement as HTMLElement | null)?.closest("#inbox") ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
  ul.replaceChildren();
  for (const yo of rows) {
    const e = yo.ev;
    const li = el("li", "yo-item");
    li.dataset.id = e.id;
    const { name, picture, state } = displayName(e.pubkey);
    // The name (with icon and time) is the disclosure button for the details; no separate row.
    const detId = `det-${e.id}`;
    const open = openDetails.has(e.id);
    const who = el("button", "who") as HTMLButtonElement;
    who.type = "button";
    who.dataset.focusKey = `who:${e.id}`;
    who.setAttribute("aria-expanded", String(open));
    who.setAttribute("aria-controls", detId);
    who.append(avatar(e.pubkey, picture, name));
    const t = el("span", "who-text");
    const nm = el("span", name ? "from-name" : "from-name none", name || (state === "pending" ? "読み込み中…" : "名前なし"));
    t.append(nm);
    const when = el("time", "when", formatWhen(e.created_at));
    when.setAttribute("datetime", new Date(e.created_at * 1000).toISOString());
    when.title = new Date(e.created_at * 1000).toLocaleString();
    t.append(when);
    who.append(t, chevron());
    // Yo back: recipient is the verified author of this event (never a tag value).
    const author = e.pubkey;
    const back = el("button", "yo-back", "Yo! を返す") as HTMLButtonElement;
    back.type = "button";
    back.dataset.to = author;
    back.dataset.focusKey = `back:${e.id}`;
    back.setAttribute("aria-label", `${name || "この相手"} に Yo! を返す`);
    back.disabled = sending;
    li.append(who, back);
    const noteState = rowNotes.get(e.id);
    const rowNote = el("span", `row-note ${noteState?.kind ?? ""}`, noteState?.text ?? "");
    rowNote.hidden = !noteState;
    back.onclick = () => { void sendYoTo(author, e.id); };
    li.append(rowNote);
    const det = el("div", "detail");
    det.id = detId;
    det.hidden = !open;
    det.append(el("code", "from-npub", toNpub(author)));
    if (!yo.ours) det.append(el("div", undefined, `他のアプリから（絵文字: ${yo.emojiHost}・読み込みません）`));
    who.onclick = () => {
      const next = !openDetails.has(e.id);
      if (next) openDetails.add(e.id); else openDetails.delete(e.id);
      who.setAttribute("aria-expanded", String(next));
      det.hidden = !next;
    };
    li.append(det);
    ul.append(li);
  }
  if (focusKey) ul.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  const note = $("inbox-note");
  if (!received.length) note.textContent = inboxLoaded ? "まだ Yo は届いていません。" : "読み込み中…";
  else note.textContent = "";
  note.hidden = received.length > 0;
  const panel = $("panel-in");
  let more = panel.querySelector<HTMLButtonElement>("button.more");
  if (received.length > rows.length && rows.length < 100) {
    if (!more) {
      more = el("button", "more", "") as HTMLButtonElement;
      more.type = "button";
      more.onclick = () => { inboxShown = Math.min(inboxShown + 20, 100); renderInbox(); };
      panel.append(more);
    }
    more.textContent = `さらに表示（全 ${received.length} 件）`;
  } else more?.remove();
}

// ---------------------------------------------------------------- send history
function setTab(t: "in" | "out", focus = false) {
  tab = t;
  for (const [k, id] of [["in", "tab-in"], ["out", "tab-out"]] as const) {
    const b = $(id);
    const on = k === t;
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  $("panel-in").hidden = t !== "in";
  $("panel-out").hidden = t !== "out";
  if (t === "out") renderSent();
}

function renderSent() {
  const panel = $("panel-out");
  const ul = $("sent");
  if (!account) { ul.replaceChildren(); panel.querySelector("button.more")?.remove(); $("sent-note").textContent = ""; return; }
  const rows = sent.slice(0, Math.min(sentShown, 100));
  // Only look up recipients while the tab is visible (no extra queries for a hidden list).
  if (tab === "out") senders.want(rows.map((y) => y.to));
  const focusKey = (document.activeElement as HTMLElement | null)?.closest("#sent") ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
  ul.replaceChildren();
  for (const yo of rows) {
    const e = yo.ev;
    const li = el("li", "yo-item sent-item");
    li.dataset.id = e.id;
    li.dataset.to = yo.to;
    const { name, picture, state } = displayName(yo.to);
    const detId = `sdet-${e.id}`;
    const open = openDetails.has(`s:${e.id}`);
    const who = el("button", "who") as HTMLButtonElement;
    who.type = "button";
    who.dataset.focusKey = `swho:${e.id}`;
    who.setAttribute("aria-expanded", String(open));
    who.setAttribute("aria-controls", detId);
    who.append(avatar(yo.to, picture, name));
    const t = el("span", "who-text");
    t.append(el("span", name ? "from-name" : "from-name none", name || (state === "pending" ? "読み込み中…" : "名前なし")));
    const when = el("time", "when", formatWhen(e.created_at));
    when.setAttribute("datetime", new Date(e.created_at * 1000).toISOString());
    when.title = new Date(e.created_at * 1000).toLocaleString();
    t.append(when);
    who.append(t, chevron());
    const det = el("div", "detail");
    det.id = detId;
    det.hidden = !open;
    det.append(el("code", "from-npub", toNpub(yo.to)));
    who.onclick = () => {
      const k = `s:${e.id}`;
      const next = !openDetails.has(k);
      if (next) openDetails.add(k); else openDetails.delete(k);
      who.setAttribute("aria-expanded", String(next));
      det.hidden = !next;
    };
    // Yo again: recipient is the single verified p tag of my own verified Yo (parseSentYo).
    const to = yo.to;
    const again = el("button", "yo-back", "もう一度 Yo!") as HTMLButtonElement;
    again.type = "button";
    again.dataset.to = to;
    again.dataset.focusKey = `again:${e.id}`;
    again.setAttribute("aria-label", `${name || "この相手"} にもう一度 Yo! を送る`);
    again.disabled = sending;
    again.onclick = () => { void sendYoTo(to, `s:${e.id}`); };
    const noteState = rowNotes.get(`s:${e.id}`);
    const rowNote = el("span", `row-note ${noteState?.kind ?? ""}`, noteState?.text ?? "");
    rowNote.hidden = !noteState;
    li.append(who, again, rowNote, det);
    ul.append(li);
  }
  if (focusKey) ul.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  const note = $("sent-note");
  note.textContent = sent.length ? "" : sentLoaded ? "まだ Yo を送っていません。" : "読み込み中…";
  note.hidden = sent.length > 0;
  let more = panel.querySelector<HTMLButtonElement>("button.more");
  if (sent.length > rows.length && rows.length < 100) {
    if (!more) {
      more = el("button", "more", "") as HTMLButtonElement;
      more.type = "button";
      more.onclick = () => { sentShown = Math.min(sentShown + 20, 100); renderSent(); };
      panel.append(more);
    }
    more.textContent = `さらに表示（全 ${sent.length} 件）`;
  } else more?.remove();
}

function bounce() {
  const b = $("logo");
  b.classList.remove("bounce");
  void b.offsetWidth;
  b.classList.add("bounce");
}

// ---------------------------------------------------------------- account UI
function renderAccount() {
  const acc = $("account");
  const loggedIn = !!account;
  document.body.classList.toggle("logged-in", loggedIn);
  $("auth").hidden = loggedIn;
  $("sendbox").hidden = !loggedIn;
  $("logout").hidden = !loggedIn;
  $("relogin").hidden = !loggedIn;
  if (!account) {
    setMeDetail(false);
    acc.hidden = true;
    acc.replaceChildren();
    $("menu-me").replaceChildren("未ログイン");
    $("me-npub").textContent = "";
    renderSigner();
    renderNet();
    return;
  }
  senders.want([account]);
  const { name, picture } = displayName(account);
  acc.replaceChildren(avatar(account, picture, name || "?"), el("span", "acc-name", name || "自分"));
  acc.hidden = false;
  const meBtn = el("button", "name-btn") as HTMLButtonElement;
  meBtn.type = "button";
  meBtn.id = "me-name";
  meBtn.setAttribute("aria-controls", "me-detail");
  meBtn.append(el("span", "name-btn-text", name || "（名前なし）"), chevron());
  meBtn.onclick = () => setMeDetail($("me-detail").hidden);
  const hadFocus = document.activeElement?.id === "me-name";
  $("menu-me").replaceChildren("ログイン中: ", meBtn);
  setMeDetail(!$("me-detail").hidden);
  if (hadFocus) meBtn.focus();
  $("me-npub").textContent = toNpub(account);
  renderSigner();
  renderNet();
}

/** Menu account: the name button discloses the npub. */
function setMeDetail(open: boolean) {
  $("me-detail").hidden = !open;
  document.getElementById("me-name")?.setAttribute("aria-expanded", String(open));
}

function renderSigner() {
  const s = $("signer");
  if (!account || signer === "ready" || signer === "unverified") { s.hidden = true; return; }
  s.replaceChildren(el("span", undefined, signerLabel(signer)));
  s.className = `signer ${signer === "checking" ? "" : "bad"}`;
  if (signer === "mismatch") {
    const b = el("button", undefined, "切り替える") as HTMLButtonElement;
    b.type = "button";
    b.onclick = () => { void relogin(); };
    s.append(b);
  }
  s.hidden = false;
}

function setSigner(st: SignerState) {
  signer = st;
  renderSigner();
}

// ---------------------------------------------------------------- NIP-07 presence
/** Wait for an extension to inject window.nostr (they often do it late). Never calls it. */
function waitForExtension(ms: number): Promise<boolean> {
  if (window.nostr) return Promise.resolve(true);
  return new Promise((res) => {
    const end = Date.now() + ms;
    const tick = () => {
      if (window.nostr) return res(true);
      if (Date.now() >= end) return res(false);
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function refreshExtensionPresence(ms = 4000) {
  const had = signer;
  if (!window.nostr && had !== "missing") setSigner("checking");
  const ok = await waitForExtension(ms);
  if (!ok) { setSigner("missing"); $("ext").textContent = "NIP-07 拡張が見つかりません。"; return; }
  $("ext").textContent = "NIP-07 拡張を検出しました。";
  // Present, but the active key is only checked when the user acts (no automatic prompts).
  if (signer === "checking" || signer === "missing" || signer === "error") setSigner("unverified");
}

// ---------------------------------------------------------------- login / logout
function startAccount(pk: string) {
  accountGen++;
  account = pk;
  received = [];
  seen = new Set();
  sent = [];
  sentSeen = new Set();
  sentLoaded = false;
  sentShown = 5;
  rowNotes.clear();
  openDetails.clear();
  setMeDetail(false);
  inboxLoaded = false;
  inboxShown = 5;
  clearSelection(true);
  $("send-results").replaceChildren();
  $("send-detail").hidden = true;
  hideStatus();
  for (const r of relays) { r.unsubscribe("yo-inbox"); r.unsubscribe("yo-sent"); subscribeOne(r); }
  netGraceUntil = Date.now() + 6000;
  setTimeout(renderNet, 6100);
  follows.reset();
  void follows.load(pk, [...relays]);
  setTab("in");
  renderAccount();
  renderInbox();
  renderSent();
}

function stopAccount() {
  accountGen++;
  account = null;
  for (const r of relays) { r.unsubscribe("yo-inbox"); r.unsubscribe("yo-sent"); }
  received = [];
  seen = new Set();
  sent = [];
  sentSeen = new Set();
  sentLoaded = false;
  rowNotes.clear();
  openDetails.clear();
  inboxLoaded = false;
  clearSelection(true);
  follows.reset();
  $("send-results").replaceChildren();
  $("send-detail").hidden = true;
  hideStatus();
  setTab("in");
  renderAccount();
  renderInbox();
  renderSent();
}

/** Ask the extension for its current key (user-initiated only). */
async function askExtensionKey(): Promise<string> {
  if (!(await waitForExtension(1500)) || !window.nostr) throw new Error("NIP-07 拡張が見つかりません");
  const pk = await window.nostr.getPublicKey();
  if (typeof pk !== "string" || !/^[0-9a-f]{64}$/.test(pk)) throw new Error("拡張から公開鍵を取得できませんでした");
  return pk;
}

async function login() {
  const btn = $("login") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const pk = await askExtensionKey();
    storageSet(LS_SESSION, serializeSession(pk));
    setSigner("ready");
    startAccount(pk);
  } catch (e) {
    $("ext").textContent = errText(e, "ログインできませんでした");
    $("ext").className = "small bad";
  } finally {
    btn.disabled = false;
  }
}

/** Menu: re-read the extension's key and switch to it if different. */
async function relogin() {
  try {
    const pk = await askExtensionKey();
    storageSet(LS_SESSION, serializeSession(pk));
    setSigner("ready");
    if (pk !== account) startAccount(pk);
    else renderAccount();
    menuMsg("拡張のアカウントで入り直しました。");
    closeMenu();
  } catch (e) {
    setSigner(window.nostr ? "error" : "missing");
    menuMsg(errText(e, "拡張に接続できません"));
  }
}

function logout() {
  storageSet(LS_SESSION, null); // removes the remembered pubkey → no auto-restore
  stopAccount();
  closeMenu();
  $("ext").className = "small";
  $("ext").textContent = "ログアウトしました。";
}

function errText(e: unknown, fallback: string): string {
  const m = (e as Error)?.message;
  return typeof m === "string" && m && /[ぁ-んァ-ン一-龥]/.test(m) ? m : fallback;
}

// ---------------------------------------------------------------- send
function status(text: string, kind: "info" | "ok" | "err" = "info") {
  const s = $("status");
  s.textContent = text;
  s.className = `status ${kind}`;
  s.hidden = false;
}
function hideStatus() { const s = $("status"); s.hidden = true; s.textContent = ""; }

function setSendingUi(on: boolean) {
  sending = on;
  ($("send") as HTMLButtonElement).disabled = on;
  document.querySelectorAll<HTMLButtonElement>("button.yo-back").forEach((b) => (b.disabled = on));
}

/** Manual send from the form (selected follow or typed npub). */
async function sendYo() {
  if (!account) { status("先にログインしてください", "err"); return; }
  let to: string;
  if (selected) to = selected.pubkey;
  else {
    const v = input("search").value.trim();
    if (!v) { status("宛先を選んでください", "err"); return; }
    try { to = parsePubkey(v); } catch { status("宛先が見つかりません。候補から選ぶか npub を入力してください", "err"); return; }
  }
  await sendYoTo(to, null);
}

/**
 * Shared send path (user tap only): extension key == account → newest verified
 * kind 0 of `to` → build kind 7 Yo → NIP-07 sign → strict check of the signed
 * event → publish. Returns true on ≥1 relay OK.
 */
async function sendYoTo(to: string, rowId: string | null): Promise<boolean> {
  const note = (t: string, kind: "info" | "ok" | "err" = "info") => {
    if (rowId) { rowNotes.set(rowId, { text: t, kind }); if (rowId.startsWith("s:")) renderSent(); else renderInbox(); }
    else status(t, kind);
  };
  if (!account) { note("先にログインしてください", "err"); return false; }
  if (sending) { note("送信中です。少しお待ちください", "err"); return false; }
  if (relays.length === 0) { note("リレーがありません。メニューで設定してください", "err"); return false; }
  const gen = accountGen;
  const mine = account;
  setSendingUi(true);
  try {
    // 1) the extension must currently be on the logged-in account
    note("拡張を確認中…");
    let extPk: string;
    try { extPk = await askExtensionKey(); } catch (e) {
      setSigner(window.nostr ? "error" : "missing");
      note(errText(e, "拡張に接続できません"), "err");
      return false;
    }
    if (gen !== accountGen) return false;
    const st = compareSigner(mine, extPk);
    setSigner(st);
    if (st !== "ready") { note("拡張のアカウントが違います。メニューから切り替えてください", "err"); return false; }

    // 2) recipient's newest verified kind 0
    note("送信準備中…");
    for (const r of relays) r.reconnectIfNeeded();
    const qs = await Promise.all(relays.map(async (r) => ({ r, q: await r.query(profileFilter(to)) })));
    if (gen !== accountGen) return false;
    const target = pickLatestProfile(qs.flatMap(({ r, q }) => q.events.map((ev) => ({ ev, relay: r.url }))), to);
    if (!target) {
      const allFailed = qs.every(({ q }) => q.status !== "eose");
      note(allFailed ? "リレーに接続できず送れませんでした" : "相手のプロフィールが見つからないため送れません", "err");
      return false;
    }

    // 3) sign (extension prompt) and strictly check what came back
    const req = buildYo(target);
    note("拡張で署名してください…");
    let signed: unknown;
    try {
      signed = await window.nostr!.signEvent(structuredClone(req));
    } catch {
      note("署名がキャンセルされました", "err");
      return false;
    }
    if (gen !== accountGen) { note("アカウントが変わったため送信を中止しました", "err"); return false; }
    const problems = checkSignedYo(signed, req, mine);
    if (problems.length) {
      console.warn("nostr-yo: signed event rejected:", problems);
      note("署名結果が正しくないため送信を中止しました", "err");
      return false;
    }
    const ev = signed as NostrEvent;

    // 4) publish
    note("送信中…");
    const targets = [...relays];
    const results: Array<[Relay, PublishResult | null]> = targets.map((r) => [r, null]);
    if (!rowId) renderSendResults(results);
    await Promise.all(targets.map(async (r, i) => {
      const res = await r.publish(ev);
      results[i] = [r, res];
      if (!rowId) renderSendResults(results);
    }));
    const ok = results.filter(([, r]) => r?.ok).length;
    // History: only an event at least one relay accepted, and only for the account that signed it.
    if (ok && gen === accountGen && account === mine) onSent(ev, mine);
    if (ok) { note(rowId && !rowId.startsWith("s:") ? "✓ Yo! を返しました" : "✓ Yo! を送りました", "ok"); bounce(); }
    else note("送れませんでした（リレーが受け付けませんでした）", "err");
    if (ok && !rowId) clearSelection(true);
    return ok > 0;
  } finally {
    setSendingUi(false);
  }
}

function renderSendResults(results: Array<[Relay, PublishResult | null]>) {
  const ul = $("send-results");
  ul.replaceChildren();
  for (const [r, res] of results) {
    const li = el("li", res === null ? "pending" : res.ok ? "ok" : "err");
    li.dataset.url = r.url;
    li.append(el("span", "url", r.url), el("span", "res", res === null ? "応答待ち…" : res.ok ? "✓ 受理" : "✗ 失敗"));
    if (res?.message) li.append(el("span", "notice", res.message));
    ul.append(li);
  }
  $("send-detail").hidden = false;
}

// ---------------------------------------------------------------- recipient search
function renderFollowState() {
  const st = follows.state;
  const t = $("follow-state");
  let msg = "";
  let bad = false;
  switch (st.phase) {
    case "loading-kind3": case "profiles": msg = "フォローを読み込み中…"; break;
    case "failed": msg = "フォローを読み込めませんでした。npub を入力して送れます。"; bad = true; break;
    case "no-kind3": case "empty": msg = "フォローが見つかりません。npub を入力して送れます。"; break;
    default: msg = "";
  }
  t.textContent = msg;
  t.className = bad ? "small bad" : "small";
  t.hidden = !msg;
}

function renderSearch() {
  const ul = $("search-results");
  ul.replaceChildren();
  const q = input("search").value;
  if (!q.trim() || selected) return;
  let manual: string | null = null;
  try { manual = parsePubkey(q); } catch { /* not a key */ }
  if (manual) {
    const li = el("li");
    const { name, picture } = displayName(manual);
    senders.want([manual]);
    li.append(pickButton(manual, name || "この npub", picture, name ? "" : shortNpub(manual), !!name));
    ul.append(li);
    return;
  }
  if (!follows.follows.length) {
    if (follows.state.phase !== "loading-kind3" && follows.state.phase !== "profiles") ul.append(el("li", "none", "候補がありません"));
    return;
  }
  const rows = searchFollows(q, follows.follows, follows.profiles, 30);
  if (!rows.length) {
    ul.append(el("li", "none", follows.state.phase === "profiles" ? "見つかりません（読み込み中）" : "見つかりません"));
    return;
  }
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  for (const r of rows) {
    const li = el("li");
    // Sub line: a human hint; the short npub only when the name is ambiguous or missing.
    const sub = (counts.get(r.label) ?? 0) > 1 || !r.hasProfile ? shortNpub(r.pubkey) : (r.nip05 || (r.name && r.name !== r.label ? `@${r.name}` : ""));
    li.append(pickButton(r.pubkey, r.label, r.picture, sub, r.hasProfile));
    ul.append(li);
  }
}

function pickButton(pubkey: string, label: string, picture: string, sub: string, hasProfile: boolean): HTMLElement {
  const b = el("button", "pick") as HTMLButtonElement;
  b.type = "button";
  b.dataset.pubkey = pubkey;
  b.append(avatar(pubkey, picture, hasProfile ? label : ""));
  const t = el("span", "pick-text");
  t.append(el("span", hasProfile ? "pick-name" : "pick-name none", label));
  if (sub) t.append(el("span", "pick-sub", sub));
  b.append(t);
  b.onclick = () => selectRecipient(pubkey, label, picture);
  return b;
}

function selectRecipient(pubkey: string, label: string, picture: string) {
  selected = { pubkey, label };
  const box = $("selected");
  box.replaceChildren(avatar(pubkey, picture, label), el("span", "sel-name", label));
  box.dataset.pubkey = pubkey;
  const x = el("button", "rm", "×") as HTMLButtonElement;
  x.type = "button";
  x.setAttribute("aria-label", "宛先を解除");
  x.onclick = () => { clearSelection(true); input("search").focus(); };
  box.append(x);
  box.hidden = false;
  $("search-results").replaceChildren();
  input("search").value = "";
  input("search").hidden = true;
}

function clearSelection(clearField: boolean) {
  selected = null;
  const box = $("selected");
  box.hidden = true;
  box.replaceChildren();
  delete box.dataset.pubkey;
  input("search").hidden = false;
  if (clearField) { input("search").value = ""; $("search-results").replaceChildren(); }
}

// ---------------------------------------------------------------- menu
const menu = () => $("menu") as HTMLDialogElement;
function openMenu() {
  renderRelays();
  menuMsg("");
  const d = menu();
  if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
}
function closeMenu() {
  const d = menu();
  if (typeof d.close === "function") { if (d.open) d.close(); } else d.removeAttribute("open");
}
function menuMsg(t: string) { $("relay-msg").textContent = t; }

function addRelay(ev: Event) {
  ev.preventDefault();
  const inp = input("relay-input");
  try {
    const url = normalizeRelay(inp.value);
    if (relays.some((r) => r.url === url)) throw new Error("追加済みです");
    relays.push(makeRelay(url));
    saveRelayUrls();
    inp.value = "";
    renderRelays();
    menuMsg(`${url} を追加しました`);
  } catch (e) {
    menuMsg(`追加できません: ${errText(e, "wss:// の URL を入力してください")}`);
  }
}

// ---------------------------------------------------------------- lifecycle
function onResume() {
  reconnectAll();
  // The extension may have switched accounts while we were away: re-check at next send.
  if (account && signer === "ready") setSigner("unverified");
  void refreshExtensionPresence(3000);
}

function init() {
  relays = resolveRelayUrls(storageGet(LS_RELAYS)).map(makeRelay);
  renderRelays();
  $("login").onclick = () => { void login(); };
  $("logout").onclick = logout;
  $("relogin").onclick = () => { void relogin(); };
  $("send").onclick = () => { void sendYo(); };
  $("menu-btn").onclick = openMenu;
  $("tab-in").onclick = () => setTab("in");
  $("tab-out").onclick = () => setTab("out");
  $("tabs").onkeydown = (e) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setTab(e.key === "Home" ? "in" : e.key === "End" ? "out" : tab === "in" ? "out" : "in", true);
    }
  };
  $("menu-close").onclick = closeMenu;
  menu().addEventListener("click", (e) => { if (e.target === menu()) closeMenu(); });
  $("relay-form").onsubmit = addRelay;
  const s = input("search");
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  s.oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearch, 120); };
  s.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); void sendYo(); } };

  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") onResume(); });
  window.addEventListener("pageshow", (e) => { if ((e as PageTransitionEvent).persisted) onResume(); });
  window.addEventListener("online", onResume);
  // Another tab logged out / switched account.
  window.addEventListener("storage", (e) => {
    if (e.key !== LS_SESSION && e.key !== null) return;
    const pk = parseSession(storageGet(LS_SESSION));
    if (!pk && account) stopAccount();
    else if (pk && pk !== account) { setSigner("unverified"); startAccount(pk); }
  });

  // Restore the remembered account (pubkey only → read-only until the user acts).
  const remembered = parseSession(storageGet(LS_SESSION));
  if (remembered) startAccount(remembered);
  else { storageSet(LS_SESSION, null); renderAccount(); renderInbox(); }
  void refreshExtensionPresence(4000);
}

init();
