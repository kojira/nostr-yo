// e2285: name tap opens/closes details (no separate 詳細 row) + full e2273 regression.
// Headless Chrome via CDP with iPhone-like emulation (390x844, DPR 3, mobile, touch, iOS UA).
// This is Blink emulation, NOT real WebKit/iOS Safari.
// A TEST-ONLY NIP-07 mock is injected; signing happens in this Node process with
// throwaway keys generated per run (never written to disk). The mock's active key
// can be switched to simulate the user changing accounts in the extension.
// Usage: node scripts/browser-verify-e2273.mjs <siteUrl> <outDir>
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";

const site = process.argv[2];
const out = process.argv[3] ?? "verification/e2285/browser";
mkdirSync(out, { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9300 + Math.floor(Math.random() * 500);
const profile = `${out}/.chrome-profile-${port}`;
const log = [];
const L = (...a) => { const s = a.join(" "); log.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
let ver;
for (let i = 0; i < 50; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); } }

const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const keys = new Map(); // pk -> sk
const K = () => { const sk = schnorr.utils.randomSecretKey(); const pk = bytesToHex(schnorr.getPublicKey(sk)); keys.set(pk, sk); return { sk, pk }; };
const npubOf = (hex) => bech32.encode("npub", bech32.toWords(hexToBytes(hex)), 90);
const now = () => Math.floor(Date.now() / 1000);
function signNode(e, sk) {
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const id = bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, pubkey, e.created_at, e.kind, e.tags, e.content]))));
  return { ...e, pubkey, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
}
const RELAYS = ["wss://r.kojira.io", "wss://yabu.me", "wss://x.kojira.io", "wss://n.kojira.io"];
async function publishNode(ev) {
  return Promise.all(RELAYS.map((u) => new Promise((res) => {
    const ws = new WebSocket(u); const to = setTimeout(() => { ws.close(); res(`${u}:timeout`); }, 20000);
    ws.onopen = () => ws.send(JSON.stringify(["EVENT", ev]));
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d[0] === "OK" && d[1] === ev.id) { clearTimeout(to); ws.close(); res(`${u}:${d[2]}`); } };
    ws.onerror = () => { clearTimeout(to); res(`${u}:error`); };
  })));
}

/** opts.mock: "none" | "now" | "late" (inject window.nostr 2.5 s after load) */
async function newPage(name, initialPk, opts = { mock: "now" }) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); const requests = []; const signed = []; const gpk = [];
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const state = { pk: initialPk };
  ws.onmessage = async (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); return; }
    if (msg.method === "Runtime.bindingCalled" && msg.params.name === "__mockSign") {
      const { reqId, ev } = JSON.parse(msg.params.payload);
      const sk = keys.get(state.pk);
      const e = signNode({ kind: ev.kind, created_at: ev.created_at, tags: ev.tags, content: ev.content }, sk);
      signed.push(e);
      L(`[${name}] mock signer signed kind=${e.kind} as ${e.pubkey.slice(0, 8)} tags=${JSON.stringify(e.tags)}`);
      await send("Runtime.evaluate", { expression: `window.__mockResolve(${reqId}, ${JSON.stringify(e)})` });
    }
    if (msg.method === "Runtime.bindingCalled" && msg.params.name === "__mockGpk") { gpk.push(Date.now()); L(`[${name}] getPublicKey called`); }
    if (msg.method === "Runtime.exceptionThrown") L(`[${name}] EXCEPTION ${JSON.stringify(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)}`);
    if (msg.method === "Network.requestWillBeSent") requests.push(msg.params.request.url);
  };
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenWidth: 390, screenHeight: 844 });
  await send("Emulation.setUserAgentOverride", { userAgent: IOS_UA, platform: "iPhone" });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Runtime.addBinding", { name: "__mockSign" });
  await send("Runtime.addBinding", { name: "__mockGpk" });
  if (opts.mock !== "none") {
    const install = `(() => { let n = 0; const p = new Map();
      window.__mockResolve = (i, e) => { p.get(i)(e); p.delete(i); };
      const nostr = { __TEST_MOCK__: true,
        getPublicKey: async () => { __mockGpk("1"); return window.__mockPk; },
        signEvent: (ev) => new Promise((res) => { const i = ++n; p.set(i, res); __mockSign(JSON.stringify({ reqId: i, ev })); }) };
      ${opts.mock === "late" ? "setTimeout(() => { window.nostr = nostr; }, 2500);" : "window.nostr = nostr;"}
    })();`;
    await send("Page.addScriptToEvaluateOnNewDocument", { source: install });
  }
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const setPk = async (pk) => { state.pk = pk; await evalJs(`window.__mockPk=${JSON.stringify(pk)}`); };
  // keep __mockPk set across reloads
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__mockPk = sessionStorage.getItem('__mockPk') || ${JSON.stringify(initialPk)};` });
  const setPkPersist = async (pk) => { await setPk(pk); await evalJs(`sessionStorage.setItem('__mockPk', ${JSON.stringify(pk)})`); };
  const shot = async (file, full = false) => { const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full }); writeFileSync(`${out}/${file}`, Buffer.from(r.result.data, "base64")); };
  const go = async (url) => { await send("Page.navigate", { url }); await sleep(1500); };
  const reload = async () => { await send("Page.reload", { ignoreCache: true }); await sleep(1500); };
  return { send, evalJs, setPk: setPkPersist, shot, go, reload, requests, signed, gpk, state, close: () => ws.close() };
}
async function waitFor(p, expr, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await p.evalJs(expr)) return true; await sleep(300); } return false; }


async function tap(p, sel) {
  const r = await p.evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({block:'center'}); const b=e.getBoundingClientRect(); return {x:b.left+Math.min(40,b.width/2), y:b.top+b.height/2}})()`);
  await p.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x, y: r.y }] });
  await p.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(350);
}
async function key(p, k) {
  const code = k === " " ? "Space" : k;
  const extra = k === "Enter" ? { text: "\r", windowsVirtualKeyCode: 13 } : { text: " ", windowsVirtualKeyCode: 32 };
  await p.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, ...extra });
  await p.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: extra.windowsVirtualKeyCode });
  await sleep(250);
}

const result = { site, chrome: ver?.Browser, emulation: "Chrome headless, 390x844 DPR3 mobile+touch, iOS Safari UA (Blink, not WebKit)", startedAt: new Date().toISOString(), checks: {} };
const C = result.checks;

// ---- fixtures (throwaway keys) ----
const tag = "e2285" + Math.random().toString(36).slice(2, 6);
const R = K(), S1 = K(), S2 = K(), S3 = K(), FORGER = K();
const LONG = "ながーい名前".repeat(6) + "X".repeat(40);
for (const [k, o] of [[R, { name: `recv_${tag}` }], [S1, { name: `alice_${tag}`, display_name: `アリス ${tag}`, picture: "https://kojira.github.io/nostr-yo/yo.png" }], [S2, { name: `bob_${tag}` }], [S3, { name: LONG + tag, nip05: "a".repeat(60) + "@example.com" }]]) {
  L("kind0", k.pk.slice(0, 8), (await publishNode(signNode({ kind: 0, created_at: now(), tags: [], content: JSON.stringify(o) }, k.sk))).join(" | "));
}
L("R kind3", (await publishNode(signNode({ kind: 3, created_at: now(), tags: [S1, S2, S3].map((k) => ["p", k.pk]), content: "" }, R.sk))).join(" | "));
L("S1 kind3", (await publishNode(signNode({ kind: 3, created_at: now(), tags: [["p", R.pk]], content: "" }, S1.sk))).join(" | "));
await sleep(1500);
const latestKind0 = async (pk) => new Promise((res) => { const ws = new WebSocket(RELAYS[0]); ws.onopen = () => ws.send(JSON.stringify(["REQ", "p", { kinds: [0], authors: [pk], limit: 1 }])); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d[0] === "EVENT") { res(d[2].id); ws.close(); } else if (d[0] === "EOSE") { res(null); ws.close(); } }; });
const rK0 = await latestKind0(R.pk);
const yoTo = (to, k0, from, emoji = "https://kojira.github.io/nostr-yo/yo.png", at = now()) => signNode({ kind: 7, created_at: at, content: ":yo:", tags: [["e", k0, RELAYS[0], to], ["p", to, RELAYS[0]], ["k", "0"], ["emoji", "yo", emoji], ["t", "yo"]] }, from.sk);
L("yo S1->R", (await publishNode(yoTo(R.pk, rK0, S1, undefined, now() - 3600))).join(" | "));
L("yo S3->R (other impl emoji)", (await publishNode(yoTo(R.pk, rK0, S3, "https://evil.example/yo.png", now() - 120))).join(" | "));
const forged = { ...yoTo(R.pk, rK0, FORGER), sig: "0".repeat(128) };
L("forged yo", (await publishNode(forged)).join(" | "));

const layoutJs = `(()=>{const d=document.documentElement,b=document.body;
  const over=[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect(); return r.width>0 && (r.right>innerWidth+0.5 || r.left< -0.5) && getComputedStyle(e).position!=='fixed' && !e.closest('dialog:not([open])')}).slice(0,5).map(e=>e.tagName+'.'+e.className+':'+Math.round(e.getBoundingClientRect().right));
  return {innerWidth, docSW:d.scrollWidth, docCW:d.clientWidth, bodySW:b.scrollWidth, bodyCW:b.clientWidth, over};})()`;
const layoutOk = (l) => l && l.docSW <= l.docCW && l.bodySW <= l.bodyCW && l.over.length === 0;
const bodyText = `document.body.innerText`;
const BANNED = [/署名検証済み/, /kind ?0/i, /kind ?3/i, /返信先/, /フォロー \\d+ 人/, /プロフィールあり/, /クエリ/, /npub1[0-9a-z]{20,}/];
const visibleBanned = async (p) => { const t = await p.evalJs(bodyText); return BANNED.filter((r) => r.test(t)).map(String); };
const inView = (sel) => `(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; const r=e.getBoundingClientRect(); return r.width>0 && r.top>=0 && r.bottom<=innerHeight && r.right<=innerWidth;})()`;

// ---- 1. first visit (not logged in) ----
const pR = await newPage("R", R.pk);
await pR.go(site);
C.viewportAllowsZoom = await pR.evalJs(`(()=>{const c=document.querySelector('meta[name=viewport]').content; return !/maximum-scale|user-scalable\\s*=\\s*(no|0)/i.test(c)})()`);
C.firstVisitLoginVisible = await pR.evalJs(inView("#login")) && await pR.evalJs(`document.getElementById('inbox-card').hidden && document.getElementById('sendbox').hidden`);
C.firstVisitNoAutoGetPublicKey = pR.gpk.length === 0;
C.headerCompact = await pR.evalJs(`document.querySelector('header.bar').getBoundingClientRect().height <= 64`);
C.relaySettingsNotOnMainScreen = await pR.evalJs(`(()=>{const r=document.getElementById('relays'); return !r.closest('main') && !document.getElementById('menu').open})()`);
result.layoutFirst = await pR.evalJs(layoutJs);
C.firstVisitNoHorizontalOverflow = layoutOk(result.layoutFirst);
await pR.shot("01-first-visit.png");

// ---- 2. login → inbox with reply buttons in the first view ----
await pR.evalJs(`document.getElementById('login').click()`);
C.loginShowsInbox = await waitFor(pR, `document.querySelectorAll('#inbox li').length===2 && [...document.querySelectorAll('#inbox .from-name')].every(n=>!/読み込み中/.test(n.innerText))`, 30000);
C.forgedYoNotShown = await pR.evalJs(`!document.querySelector('#inbox .yo-back[data-to="${FORGER.pk}"]')`);
await sleep(1500);
C.sessionStoresOnlyPubkey = await pR.evalJs(`JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(k=>[k,localStorage.getItem(k)])))`).then((s) => { L("localStorage:", s); const o = JSON.parse(s); const sess = JSON.parse(o["nostr-yo:session"] ?? "null"); return !!sess && JSON.stringify(sess) === JSON.stringify({ v: 1, pubkey: R.pk }) && !/nsec|sig|token|secret/i.test(s) && Object.keys(o).every((k) => k === "nostr-yo:session" || k === "nostr-yo:relays"); });
C.inboxReplyButtonInFirstView = await pR.evalJs(`(()=>{window.scrollTo(0,0); const b=document.querySelector('#inbox .yo-back'); const r=b.getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight})()`);
C.inboxItemInFirstView = await pR.evalJs(inView("#inbox li .from-name"));
result.rows = await pR.evalJs(`[...document.querySelectorAll('#inbox li')].map(l=>({to:l.querySelector('.yo-back').dataset.to.slice(0,8), name:l.querySelector('.from-name').innerText, when:l.querySelector('time.when')?.innerText, datetime:l.querySelector('time.when')?.getAttribute('datetime'), detailOpen:!l.querySelector('.detail').hidden, expanded:l.querySelector('button.who').getAttribute('aria-expanded')}))`);
L("rows", JSON.stringify(result.rows));
C.dateTimeShown = result.rows.length === 2 && result.rows.every((r) => /^(\d{4}\/)?\d{1,2}\/\d{1,2} \d{2}:\d{2}$/.test(r.when ?? "") && !!r.datetime);
C.iconAndNameShown = result.rows.some((r) => r.name === `アリス ${tag}`) && await pR.evalJs(`!!document.querySelector('#inbox .yo-back[data-to="${S1.pk}"]').closest('li').querySelector('img.avatar[referrerpolicy="no-referrer"], .avatar')`);
C.npubHiddenInDetails = await pR.evalJs(`[...document.querySelectorAll('#inbox li')].every(l=>{const c=l.querySelector('.detail .from-npub'); return c && /^npub1/.test(c.textContent) && l.querySelector('.detail').hidden})`);
result.bannedVisibleAfterLogin = await visibleBanned(pR);
C.noTechnicalInfoVisible = result.bannedVisibleAfterLogin.length === 0;
result.layoutLoggedIn = await pR.evalJs(layoutJs);
C.loggedInNoHorizontalOverflow = layoutOk(result.layoutLoggedIn);
C.headerShowsAccountName = await waitFor(pR, `document.querySelector('#account .acc-name')?.innerText===${JSON.stringify("recv_" + tag)}`, 15000);
C.headerNoOverflowWithAccount = await pR.evalJs(`(()=>{const h=document.querySelector('header.bar'); return h.scrollWidth<=h.clientWidth})()`);
await pR.shot("02-logged-in-first-view.png");
await pR.shot("02b-logged-in-full.png", true);


// ---- 2b. e2285: name tap discloses details; no separate details row ----
{
  const row = (pk) => `document.querySelector('#inbox .yo-back[data-to="${pk}"]').closest('li')`;
  const sb = pR.signed.length, gb = pR.gpk.length;
  C.noDetailsSummaryRowInInbox = await pR.evalJs(`!document.querySelector('#inbox details, #inbox summary') && ![...document.querySelectorAll('#inbox li')].some(l=>/^\\s*詳細\\s*$/m.test(l.innerText))`);
  result.closedRows = await pR.evalJs(`[...document.querySelectorAll('#inbox li')].map(l=>{const w=l.querySelector('button.who'), b=l.querySelector('.yo-back'); const lr=l.getBoundingClientRect(), wr=w.getBoundingClientRect(), br=b.getBoundingClientRect(); return {h:Math.round(lr.height), whoH:Math.round(wr.height), sameLine: Math.abs((wr.top+wr.bottom)/2-(br.top+br.bottom)/2)<4, visibleChildren:[...l.children].filter(c=>c.getBoundingClientRect().height>0).map(c=>c.className)}})`);
  L("closedRows", JSON.stringify(result.closedRows));
  C.closedRowIsSingleLine = result.closedRows.every((r) => r.sameLine && r.h <= r.whoH + 20 && r.visibleChildren.length === 2);
  C.nameIsRealButton = await pR.evalJs(`[...document.querySelectorAll('#inbox li')].every(l=>{const w=l.querySelector('.who'); const d=l.querySelector('.detail'); return w.tagName==='BUTTON' && w.type==='button' && w.getAttribute('aria-expanded')==='false' && w.getAttribute('aria-controls')===d.id && !!document.getElementById(d.id) && w.contains(l.querySelector('.from-name')) && w.contains(l.querySelector('time.when'))})`);
  // accessibility tree: role button, name contains the display name, expanded=false
  await pR.send("Accessibility.enable");
  const ax = (await pR.send("Accessibility.getFullAXTree")).result.nodes;
  const axBtn = ax.find((n) => n.role?.value === "button" && String(n.name?.value ?? "").includes(`アリス ${tag}`) && !String(n.name?.value).includes("返す"));
  result.axNameButton = axBtn ? { role: axBtn.role.value, name: axBtn.name.value, expanded: axBtn.properties?.find((p) => p.name === "expanded")?.value?.value } : null;
  L("ax", JSON.stringify(result.axNameButton));
  C.axButtonWithNameAndExpanded = !!axBtn && axBtn.properties?.some((p) => p.name === "expanded" && p.value.value === false);
  // touch tap on the name opens
  await pR.evalJs(`${row(S1.pk)}.querySelector('button.who').dataset.t='1'`);
  await tap(pR, `#inbox li button.who[data-t="1"]`);
  C.nameTapOpensDetail = await pR.evalJs(`(()=>{const l=${row(S1.pk)}; const d=l.querySelector('.detail'); return !d.hidden && d.getBoundingClientRect().height>0 && l.querySelector('button.who').getAttribute('aria-expanded')==='true' && l.querySelector('.from-npub').textContent===${JSON.stringify(npubOf(S1.pk))}})()`);
  C.otherRowsStayClosed = await pR.evalJs(`${row(S3.pk)}.querySelector('.detail').hidden`);
  result.layoutDetailOpen = await pR.evalJs(layoutJs);
  C.detailOpenNoHorizontalOverflow = layoutOk(result.layoutDetailOpen);
  await pR.shot("02c-name-tap-open.png");
  // long-name row (other app) open too
  await pR.evalJs(`${row(S3.pk)}.querySelector('button.who').click()`);
  C.otherAppNoteInDetail = await pR.evalJs(`(()=>{const d=${row(S3.pk)}.querySelector('.detail'); return !d.hidden && /他のアプリから（絵文字: evil.example/.test(d.innerText)})()`);
  result.layoutBothOpen = await pR.evalJs(layoutJs);
  C.bothOpenNoHorizontalOverflow = layoutOk(result.layoutBothOpen);
  C.dateTimeKeptWhenOpen = await pR.evalJs(`[...document.querySelectorAll('#inbox time.when')].every(t=>/^(\\d{4}\\/)?\\d{1,2}\\/\\d{1,2} \\d{2}:\\d{2}$/.test(t.innerText) && t.getBoundingClientRect().height>0)`);
  await pR.shot("02d-both-open.png", true);
  // re-render (profile updates etc.) keeps the open state
  await pR.evalJs(`window.dispatchEvent(new Event('online'))`);
  await sleep(1500);
  C.openStateSurvivesRerender = await pR.evalJs(`!${row(S1.pk)}.querySelector('.detail').hidden && ${row(S1.pk)}.querySelector('button.who').getAttribute('aria-expanded')==='true'`);
  // tap again closes
  await pR.evalJs(`document.querySelectorAll('#inbox button.who').forEach(b=>delete b.dataset.t); ${row(S1.pk)}.querySelector('button.who').dataset.t='1'`);
  await tap(pR, `#inbox li button.who[data-t="1"]`);
  C.nameTapAgainCloses = await pR.evalJs(`${row(S1.pk)}.querySelector('.detail').hidden && ${row(S1.pk)}.querySelector('button.who').getAttribute('aria-expanded')==='false'`);
  // keyboard: Enter opens, Space closes, focus stays on the name button
  await pR.evalJs(`${row(S1.pk)}.querySelector('button.who').focus()`);
  await key(pR, "Enter");
  C.keyboardEnterOpens = await pR.evalJs(`!${row(S1.pk)}.querySelector('.detail').hidden && document.activeElement===${row(S1.pk)}.querySelector('button.who')`);
  await key(pR, " ");
  C.keyboardSpaceCloses = await pR.evalJs(`${row(S1.pk)}.querySelector('.detail').hidden && ${row(S1.pk)}.querySelector('button.who').getAttribute('aria-expanded')==='false'`);
  await pR.evalJs(`${row(S3.pk)}.querySelector('button.who').click(); document.activeElement.blur()`);
  C.nameToggleNeverSignsOrRepliesOrCallsExt = pR.signed.length === sb && pR.gpk.length === gb && await pR.evalJs(`[...document.querySelectorAll('#inbox .row-note')].every(n=>n.hidden) && document.getElementById('status').hidden`);
  C.allClosedAgain = await pR.evalJs(`[...document.querySelectorAll('#inbox .detail')].every(d=>d.hidden)`);
}

// ---- 3. input sizes & typing does not overflow ----
result.inputFontSizes = await pR.evalJs(`[...document.querySelectorAll('input')].map(i=>({id:i.id, fs:parseFloat(getComputedStyle(i).fontSize)}))`);
C.allInputsAtLeast16px = result.inputFontSizes.every((x) => x.fs >= 16);
await pR.evalJs(`(()=>{const s=document.getElementById('search'); s.focus(); s.value=${JSON.stringify(LONG.slice(0, 4))}; s.dispatchEvent(new Event('input'));})()`);
C.searchFindsLongName = await waitFor(pR, `document.querySelectorAll('#search-results .pick').length>=1`, 30000);
result.layoutSearchLong = await pR.evalJs(layoutJs);
C.searchLongNameNoOverflow = layoutOk(result.layoutSearchLong);
C.noFollowStatsShown = await pR.evalJs(`!/フォロー \\d+ 人|プロフィールあり|クエリ/.test(document.body.innerText)`);
await pR.shot("03-search-long-name.png");
await pR.evalJs(`(()=>{const s=document.getElementById('search'); s.value='zzzz'+'w'.repeat(120); s.dispatchEvent(new Event('input'));})()`);
await sleep(400);
result.layoutLongTyped = await pR.evalJs(layoutJs);
C.longTypedTextNoOverflow = layoutOk(result.layoutLongTyped);

// ---- 3b. same-name search still identifies people (short npub sub-line) ----
C.searchSubLineKept = await (async () => { await pR.evalJs(`(()=>{const s=document.getElementById('search'); s.value=${JSON.stringify(LONG.slice(0, 4))}; s.dispatchEvent(new Event('input'));})()`); return waitFor(pR, `[...document.querySelectorAll('#search-results .pick-sub')].some(x=>x.innerText.length>0)`, 15000); })();

// ---- 4. Yo back from the inbox (user tap → one signature, to the author) ----
let before = pR.signed.length;
await pR.evalJs(`(()=>{const s=document.getElementById('search'); s.value=''; s.dispatchEvent(new Event('input')); s.blur();})()`);
await pR.evalJs(`document.querySelector('#inbox .yo-back[data-to="${S1.pk}"]').click()`);
C.replyOk = await waitFor(pR, `/Yo! を返しました/.test(document.querySelector('#inbox .yo-back[data-to="${S1.pk}"]').closest('li').querySelector('.row-note').innerText)`, 45000);
C.replySignedOnceToAuthor = pR.signed.length === before + 1 && pR.signed.at(-1).tags.some((t) => t[0] === "p" && t[1] === S1.pk) && pR.signed.at(-1).pubkey === R.pk;
await pR.shot("04-replied.png");

// ---- 5. send via search pick ----
before = pR.signed.length;
await pR.evalJs(`(()=>{const s=document.getElementById('search'); s.value=${JSON.stringify("bob_" + tag)}; s.dispatchEvent(new Event('input'));})()`);
await waitFor(pR, `!!document.querySelector('#search-results .pick[data-pubkey="${S2.pk}"]')`, 15000);
await pR.evalJs(`document.querySelector('#search-results .pick[data-pubkey="${S2.pk}"]').click()`);
C.pickShowsNameNotNpub = await pR.evalJs(`!document.getElementById('selected').hidden && document.querySelector('#selected .sel-name').innerText===${JSON.stringify("bob_" + tag)} && !/npub1/.test(document.getElementById('selected').innerText)`);
await pR.evalJs(`document.getElementById('send').click()`);
C.sendOk = await waitFor(pR, `/Yo! を送りました/.test(document.getElementById('status').innerText)`, 45000);
C.sendSignedToPicked = pR.signed.length === before + 1 && pR.signed.at(-1).tags.some((t) => t[0] === "p" && t[1] === S2.pk);
await pR.shot("05-sent.png");

// ---- 6. reload: remembered login restores inbox without prompting the extension ----
const gpkBefore = pR.gpk.length; const signBefore = pR.signed.length;
await pR.reload();
C.reloadRestoresInbox = await waitFor(pR, `document.querySelectorAll('#inbox li').length===2 && document.getElementById('auth').hidden`, 30000);
await sleep(2500);
C.reloadNoExtensionCallNoSign = pR.gpk.length === gpkBefore && pR.signed.length === signBefore;
C.reloadSignerNotClaimedReady = await pR.evalJs(`document.getElementById('signer').hidden`); // unverified is silent; no false "connected"
await pR.shot("06-after-reload.png");

// ---- 7. background / network loss → reconnect, live inbox keeps working ----
await pR.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await sleep(3000);
await pR.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await pR.evalJs(`window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange'))`);
await sleep(3000);
L("yo S2->R after reconnect", (await publishNode(yoTo(R.pk, rK0, S2))).join(" | "));
C.reconnectReceivesNewYo = await waitFor(pR, `!!document.querySelector('#inbox .yo-back[data-to="${S2.pk}"]')`, 25000);
C.stillLoggedInAfterResume = await pR.evalJs(`document.getElementById('auth').hidden && !document.getElementById('account').hidden`);

// ---- 8. account switched in the extension → no signing as the wrong key ----
await pR.setPk(S1.pk);
before = pR.signed.length;
await pR.evalJs(`document.querySelector('#inbox .yo-back[data-to="${S2.pk}"]').click()`);
C.mismatchBlocksSend = await waitFor(pR, `/アカウントが違います/.test(document.querySelector('#inbox .yo-back[data-to="${S2.pk}"]').closest('li').querySelector('.row-note').innerText)`, 15000);
C.mismatchNoSignature = pR.signed.length === before;
C.mismatchBannerShown = await pR.evalJs(`!document.getElementById('signer').hidden && /アカウントが違います/.test(document.getElementById('signer').innerText)`);
await pR.shot("07-account-mismatch.png");
await pR.evalJs(`document.querySelector('#signer button').click()`);
C.switchToOtherAccount = await waitFor(pR, `document.querySelector('#account .acc-name')?.innerText===${JSON.stringify("アリス " + tag)}`, 20000);
C.switchedInboxShowsReplyFromR = await waitFor(pR, `!!document.querySelector('#inbox .yo-back[data-to="${R.pk}"]') && !document.querySelector('#inbox .yo-back[data-to="${S2.pk}"]')`, 30000);
C.switchedSessionPubkey = await pR.evalJs(`JSON.parse(localStorage.getItem('nostr-yo:session')).pubkey===${JSON.stringify(S1.pk)}`);
await pR.shot("08-switched-account.png");

// ---- 9. menu: relay settings + account + logout ----
await pR.evalJs(`document.getElementById('menu-btn').click()`);
C.menuOpens = await pR.evalJs(`document.getElementById('menu').open && document.querySelectorAll('#relays li').length===4`);
C.menuRelaysDefault = JSON.stringify(await pR.evalJs(`[...document.querySelectorAll('#relays li')].map(l=>l.dataset.url)`)) === JSON.stringify(RELAYS);
result.layoutMenu = await pR.evalJs(`(()=>{const m=document.getElementById('menu'); const r=m.getBoundingClientRect(); return {sw:m.scrollWidth, cw:m.clientWidth, right:r.right, iw:innerWidth, relayInputFs:parseFloat(getComputedStyle(document.getElementById('relay-input')).fontSize)}})()`);
C.menuNoOverflow = result.layoutMenu.sw <= result.layoutMenu.cw && result.layoutMenu.right <= result.layoutMenu.iw && result.layoutMenu.relayInputFs >= 16;
C.menuNpubInDetails = await pR.evalJs(`document.getElementById('me-detail').hidden && /^npub1/.test(document.getElementById('me-npub').textContent)`);
// menu account: name is the disclosure button, no summary row
C.menuNoSummaryRow = await pR.evalJs(`!document.querySelector('#menu-account details, #menu-account summary')`);
C.menuNameIsButtonCollapsed = await pR.evalJs(`(()=>{const b=document.getElementById('me-name'); return !!b && b.tagName==='BUTTON' && b.getAttribute('aria-expanded')==='false' && b.getAttribute('aria-controls')==='me-detail' && b.innerText.includes(${JSON.stringify("アリス " + tag)})})()`);
await pR.shot("09-menu.png");
{ const sb = pR.signed.length, gb = pR.gpk.length;
  await tap(pR, '#me-name');
  C.menuNameTapOpens = await pR.evalJs(`!document.getElementById('me-detail').hidden && document.getElementById('me-name').getAttribute('aria-expanded')==='true' && document.getElementById('me-npub').getBoundingClientRect().height>0`);
  const ml = await pR.evalJs(`(()=>{const m=document.getElementById('menu'); return {sw:m.scrollWidth, cw:m.clientWidth}})()`);
  C.menuOpenNoOverflow = ml.sw <= ml.cw;
  await pR.shot("09b-menu-name-open.png");
  await pR.evalJs(`document.getElementById('me-name').focus()`);
  await key(pR, "Enter");
  C.menuNameKeyboardCloses = await pR.evalJs(`document.getElementById('me-detail').hidden && document.getElementById('me-name').getAttribute('aria-expanded')==='false' && document.activeElement.id==='me-name'`);
  C.menuNameNoSignNoExt = pR.signed.length === sb && pR.gpk.length === gb; }
await pR.evalJs(`document.getElementById('relay-input').value='wss://relay.example.invalid'; document.getElementById('relay-form').requestSubmit()`);
C.menuAddRelay = await pR.evalJs(`!!document.querySelector('#relays li[data-url="wss://relay.example.invalid"]') && JSON.parse(localStorage.getItem('nostr-yo:relays')).includes('wss://relay.example.invalid')`);
await pR.evalJs(`document.querySelector('#relays li[data-url="wss://relay.example.invalid"] .rm').click()`);
C.menuRemoveRelay = await pR.evalJs(`JSON.stringify(JSON.parse(localStorage.getItem('nostr-yo:relays')))===${JSON.stringify(JSON.stringify(RELAYS))}`);
await pR.evalJs(`document.getElementById('logout').click()`);
C.logoutClearsUi = await pR.evalJs(`!document.getElementById('menu').open && !document.getElementById('auth').hidden && document.getElementById('inbox-card').hidden && document.getElementById('sendbox').hidden && document.getElementById('account').hidden && document.querySelectorAll('#inbox li').length===0`);
C.logoutRemovesSession = await pR.evalJs(`localStorage.getItem('nostr-yo:session')===null`);
const gpkAtLogout = pR.gpk.length;
await pR.reload();
await sleep(3500);
C.logoutStaysAfterReload = await pR.evalJs(`!document.getElementById('auth').hidden && document.getElementById('inbox-card').hidden`) && pR.gpk.length === gpkAtLogout;
await pR.shot("10-after-logout-reload.png");

// ---- 10. no extension / late extension ----
const pN = await newPage("N", R.pk, { mock: "none" });
await pN.go(site);
await pN.evalJs(`localStorage.setItem('nostr-yo:session', JSON.stringify({v:1,pubkey:${JSON.stringify(R.pk)}}))`);
await pN.reload();
C.noExtRestoresReadOnlyInbox = await waitFor(pN, `document.querySelectorAll('#inbox li').length>=2`, 30000);
C.noExtHonestBanner = await waitFor(pN, `!document.getElementById('signer').hidden && /拡張が見つかりません/.test(document.getElementById('signer').innerText)`, 8000);
await pN.evalJs(`document.querySelector('#inbox .yo-back').click()`);
C.noExtReplyShortError = await waitFor(pN, `/拡張が見つかりません/.test(document.querySelector('#inbox .row-note:not([hidden])')?.innerText ?? '')`, 8000);
result.layoutNoExt = await pN.evalJs(layoutJs);
C.noExtNoOverflow = layoutOk(result.layoutNoExt);
await pN.shot("11-no-extension-readonly.png");
await pN.evalJs(`localStorage.removeItem('nostr-yo:session')`);
await pN.reload(); await sleep(4500);
await pN.evalJs(`document.getElementById('login').click()`);
C.noExtLoginShortError = await waitFor(pN, `/拡張が見つかりません/.test(document.getElementById('ext').innerText)`, 5000);
const pLate = await newPage("LATE", S2.pk, { mock: "late" });
await pLate.go(site);
C.lateExtensionWaitedFor = await waitFor(pLate, `/検出しました/.test(document.getElementById('ext').innerText)`, 8000);
await pLate.evalJs(`document.getElementById('login').click()`);
C.lateExtensionLogin = await waitFor(pLate, `document.getElementById('auth').hidden && !document.getElementById('inbox-card').hidden`, 10000);

// ---- privacy / supply chain ----
C.emojiUrlNeverLoaded = ![...pR.requests, ...pN.requests].some((u) => u.includes("evil.example"));
C.noForeignScripts = [...pR.requests].filter((u) => /\.js(\?|$)/.test(u)).every((u) => u.startsWith(new URL(site).origin));
C.neverSignedWithoutTap = pR.signed.length === 2 && pN.signed.length === 0 && pLate.signed.length === 0;

result.finishedAt = new Date().toISOString();
result.pass = Object.values(C).filter(Boolean).length;
result.total = Object.keys(C).length;
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
writeFileSync(`${out}/log.txt`, log.join("\n") + "\n");
console.log(JSON.stringify(C));
console.log(`PASS ${result.pass}/${result.total}`, Object.entries(C).filter(([, v]) => !v).map(([k]) => k).join(" "));
pR.close(); pN.close(); pLate.close(); chrome.kill();
await sleep(500);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
