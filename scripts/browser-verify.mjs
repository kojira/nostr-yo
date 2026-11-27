// Real-browser verification via Chrome DevTools Protocol (no extra deps).
// A TEST-ONLY NIP-07 mock is injected into the page; signing happens in this
// Node process with throwaway keys generated per run (never written to disk).
// Usage: node scripts/browser-verify.mjs <siteUrl> <outDir> [mode]
//   mode: "honest" (default) – A sends Yo to B on real relays, B receives
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const site = process.argv[2];
const out = process.argv[3] ?? "verification/browser";
mkdirSync(out, { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9300 + Math.floor(Math.random() * 500);
const profile = `${out}/.chrome-profile-${port}`;
const log = [];
const L = (...a) => { const s = a.join(" "); log.push(s); console.log(s); };

const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--window-size=600,1400", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver;
for (let i = 0; i < 50; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); } }

async function newPage(name, sk, tamper) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); const events = [];
  ws.onmessage = async (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); return; }
    if (msg.method === "Runtime.bindingCalled" && msg.params.name === "__mockSign") {
      const { reqId, ev } = JSON.parse(msg.params.payload);
      const pubkey = bytesToHex(schnorr.getPublicKey(sk));
      let e = { ...ev, pubkey };
      const rnd = () => bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
      if (tamper === "swap-recipient") e.tags = e.tags.map((t) => (t[0] === "p" ? ["p", rnd(), t[2] ?? ""] : t));
      if (tamper === "swap-target") e.tags = e.tags.map((t) => (t[0] === "e" ? ["e", "f".repeat(64), t[2] ?? "", t[3] ?? ""] : t));
      if (tamper === "swap-emoji") e.tags = e.tags.map((t) => (t[0] === "emoji" ? ["emoji", "yo", "https://evil.example/yo.png"] : t));
      if (tamper === "kind1") e.kind = 1;
      const evid = bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]))));
      e = { ...e, id: evid, sig: bytesToHex(schnorr.sign(hexToBytes(evid), sk)) };
      L(`[${name}] mock signer signed kind=${e.kind} content=${JSON.stringify(e.content)} tags=${JSON.stringify(e.tags)} id=${e.id}`);
      await send("Runtime.evaluate", { expression: `window.__mockResolve(${reqId}, ${JSON.stringify(e)})` });
    }
    if (msg.method === "Runtime.consoleAPICalled") L(`[${name}] console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    if (msg.method === "Runtime.exceptionThrown") L(`[${name}] EXCEPTION ${JSON.stringify(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)}`);
    if (msg.method === "Network.webSocketCreated") L(`[${name}] ws created ${msg.params.url}`);
    if (msg.method === "Network.requestWillBeSent") events.push(msg.params.request.url);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
  await send("Runtime.addBinding", { name: "__mockSign" });
  const pk = bytesToHex(schnorr.getPublicKey(sk));
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `
    (() => { let n = 0; const p = new Map();
      window.__mockResolve = (i, e) => { p.get(i)(e); p.delete(i); };
      window.nostr = { __TEST_MOCK__: true,
        getPublicKey: async () => ${JSON.stringify(pk)},
        signEvent: (ev) => new Promise((res) => { const i = ++n; p.set(i, res); __mockSign(JSON.stringify({ reqId: i, ev })); }) };
    })();` });
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const shot = async (file) => { const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); writeFileSync(`${out}/${file}`, Buffer.from(r.result.data, "base64")); };
  return { send, evalJs, shot, pk, requests: events, close: () => ws.close() };
}

const text = (sel) => `document.querySelector(${JSON.stringify(sel)})?.innerText ?? null`;
async function waitFor(p, expr, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await p.evalJs(expr)) return true; await sleep(300); } return false; }

const result = { site, chrome: ver?.Browser, startedAt: new Date().toISOString(), checks: {} };
const skA = schnorr.utils.randomSecretKey(), skB = schnorr.utils.randomSecretKey();
const RELAYS = ["wss://r.kojira.io", "wss://yabu.me", "wss://x.kojira.io", "wss://n.kojira.io"];
function signNode(e, sk) {
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const id = bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, pubkey, e.created_at, e.kind, e.tags, e.content]))));
  return { ...e, pubkey, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
}
async function publishNode(ev) {
  return Promise.all(RELAYS.map((u) => new Promise((res) => {
    const ws = new WebSocket(u); const to = setTimeout(() => { ws.close(); res(`${u}: timeout`); }, 25000);
    ws.onopen = () => ws.send(JSON.stringify(["EVENT", ev]));
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d[0] === "OK" && d[1] === ev.id) { clearTimeout(to); ws.close(); res(`${u}: OK ${d[2]} ${d[3] ?? ""}`); } };
    ws.onerror = () => { clearTimeout(to); res(`${u}: error`); };
  })));
}
// Test-only: B (throwaway key) publishes a kind 0 profile so it has a reaction target.
const profileB = signNode({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ name: "nostr-yo e2e test (throwaway)" }) }, skB);
L("B kind0", profileB.id, "publish:", (await publishNode(profileB)).join(" | "));
result.profileB = profileB.id;
const A = await newPage("A", skA), B = await newPage("B", skB);
for (const p of [A, B]) { await p.send("Page.navigate", { url: site }); }
await sleep(2500);
result.checks.relaysOpenA = await waitFor(A, `[...document.querySelectorAll('#relays li')].filter(l=>l.classList.contains('open')).length>0`, 12000);
L("relay list A:", await A.evalJs(text("#relays")));
await B.evalJs(`document.getElementById('login').click()`);
await A.evalJs(`document.getElementById('login').click()`);
await sleep(1500);
const npubB = await B.evalJs(text("#me"));
L("B npub:", npubB);
await A.evalJs(`document.getElementById('to').value=${JSON.stringify(npubB)}; document.getElementById('send').click()`);
result.checks.sendStatusOk = await waitFor(A, `document.getElementById('status').classList.contains('ok') && /送りました/.test(document.getElementById("status").innerText)`, 45000);
L("A status:", await A.evalJs(text("#status")));
L("A send results:", await A.evalJs(text("#send-results")));
await A.shot("A-sent.png");
result.checks.receivedByB = await waitFor(B, `document.querySelectorAll('#inbox li').length>0`, 20000);
result.checks.receivedTargetConfirmed = await waitFor(B, `document.querySelector('#inbox li .target.ok')!==null`, 15000);
if (!result.checks.receivedByB) { // live sub may miss; reload to re-REQ stored events
  await B.send("Page.reload"); await sleep(2500); await B.evalJs(`document.getElementById('login').click()`);
  result.checks.receivedByBAfterReload = await waitFor(B, `document.querySelectorAll('#inbox li').length>0`, 15000);
}
L("B inbox:", await B.evalJs(text("#inbox")), "|", await B.evalJs(text("#inbox-note")));
await B.shot("B-received.png");

// Recipient without any kind 0: must refuse to send, with an explanation.
{
  const N = await newPage("N-noprofile", schnorr.utils.randomSecretKey());
  await N.send("Page.navigate", { url: site }); await sleep(2500);
  await N.evalJs(`document.getElementById('login').click()`); await sleep(500);
  const ghost = (await import("@scure/base")).bech32;
  const ghostHex = bytesToHex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
  const ghostNpub = ghost.encode("npub", ghost.toWords(hexToBytes(ghostHex)), 90);
  await N.evalJs(`document.getElementById('to').value=${JSON.stringify(ghostNpub)}; document.getElementById('send').click()`);
  result.checks.noProfileRefused = await waitFor(N, `/kind 0 プロフィールが見つかりません|プロフィール検索に失敗/.test(document.getElementById('status').innerText) && document.querySelectorAll('#send-results li').length===0`, 30000);
  L("N-noprofile status:", await N.evalJs(text("#status")));
  await N.shot("no-profile.png"); N.close();
}
// Negative: tampering signer must be refused before publishing.
for (const mode of ["swap-recipient", "swap-target", "swap-emoji", "kind1"]) {
  const M = await newPage(`M-${mode}`, schnorr.utils.randomSecretKey(), mode);
  await M.send("Page.navigate", { url: site }); await sleep(2000);
  await M.evalJs(`document.getElementById('login').click()`); await sleep(500);
  await M.evalJs(`document.getElementById('to').value=${JSON.stringify(npubB)}; document.getElementById('send').click()`);
  result.checks[`tamper_${mode}_refused`] = await waitFor(M, `/送信を中止/.test(document.getElementById('status').innerText) && document.querySelectorAll('#send-results li').length===0`, 30000);
  L(`M-${mode} status:`, await M.evalJs(text("#status")));
  await M.shot(`tamper-${mode}.png`); M.close();
}
// Static resource origins loaded by the page (must be same-origin only).
const origin = new URL(site).origin;
result.checks.onlySameOriginHttp = A.requests.filter((u) => u.startsWith("http")).every((u) => u.startsWith(origin));
result.httpRequests = [...new Set(A.requests)];
result.finishedAt = new Date().toISOString();
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
writeFileSync(`${out}/log.txt`, log.join("\n") + "\n");
console.log(JSON.stringify(result.checks));
A.close(); B.close(); chrome.kill();
