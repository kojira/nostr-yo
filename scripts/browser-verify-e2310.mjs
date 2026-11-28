// e2310: "もう一度 Yo!" button on each send-history row (reuses the shared send path).
// Headless Chrome via CDP (390x844 mobile emulation; Blink, not WebKit).
// A TEST-ONLY NIP-07 mock is injected; signing happens in this Node process with throwaway
// keys generated per run (never written to disk). This is NOT a real NIP-07 extension.
// Relay: a local mock relay (ws://127.0.0.1) started by this script, so queries can be delayed
// and publishes rejected deterministically. Profile pictures use *.nyo.test via CDP interception.
// Usage: node scripts/browser-verify-e2310.mjs <siteUrl> <outDir>
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const site = process.argv[2];
const out = process.argv[3] ?? "verification/e2310/browser";
mkdirSync(out, { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9300 + Math.floor(Math.random() * 500);
const profile = `${out}/.chrome-profile-${port}`;
const log = [];
const L = (...a) => { const s = a.join(" "); log.push(s); console.log(s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fixtures
const keys = new Map();
const K = () => { const sk = schnorr.utils.randomSecretKey(); const pk = bytesToHex(schnorr.getPublicKey(sk)); keys.set(pk, sk); return { sk, pk }; };
const now = () => Math.floor(Date.now() / 1000);
function signNode(e, sk) {
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const id = bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, pubkey, e.created_at, e.kind, e.tags, e.content]))));
  return { ...e, pubkey, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
}
function png(r, g, b) {
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: 8 }, () => Buffer.from([0, ...Array.from({ length: 8 }, () => [r, g, b]).flat()])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const tag = "e2310" + Math.random().toString(36).slice(2, 6);
const PIC = (n) => `https://img-nocors.nyo.test/${tag}/${n}.png`;
const A = K(), B = K(), R1 = K(), R2 = K(), R3 = K(), X = K();
const profiles = [
  [A, { name: `acctA_${tag}`, picture: PIC("A") }],
  [B, { name: `acctB_${tag}`, picture: PIC("B") }],
  [R1, { name: `r1_${tag}`, picture: PIC("S1") }],
  [R2, { name: `r2nopic_${tag}` }],
  [R3, { name: `r3_${tag}`, picture: PIC("S5") }],
  [X, { name: `x_${tag}`, picture: PIC("C") }],
];
const store = [];
const kind0Of = new Map();
for (const [k, o] of profiles) { const e = signNode({ kind: 0, created_at: now() - 100, tags: [], content: JSON.stringify(o) }, k.sk); store.push(e); kind0Of.set(k.pk, e); }
store.push(signNode({ kind: 3, created_at: now() - 100, tags: [R1, R2, R3].map((k) => ["p", k.pk]), content: "" }, A.sk));
const yoTags = (to, withT = true) => [["e", kind0Of.get(to.pk).id, "", to.pk], ["p", to.pk], ["k", "0"], ["emoji", "yo", "https://kojira.github.io/nostr-yo/yo.png"], ...(withT ? [["t", "yo"]] : [])];
const yo = (to, from, at, withT = true) => signNode({ kind: 7, created_at: at, content: ":yo:", tags: yoTags(to, withT) }, from.sk);
const T0 = now();
// A sent: R1 (newest, t=yo), R2 (no t tag: pre-e2257 compat), R3 (oldest)
const aSent = [yo(R1, A, T0 - 300), yo(R2, A, T0 - 400, false), yo(R3, A, T0 - 500)];
store.push(...aSent);
// Non-Yo events authored by A that must NOT appear as sent
store.push(signNode({ kind: 7, created_at: T0 - 250, content: "+", tags: [["e", kind0Of.get(R1.pk).id], ["p", R1.pk], ["k", "0"]] }, A.sk)); // plain like
store.push(signNode({ kind: 7, created_at: T0 - 240, content: ":yo:", tags: [["e", kind0Of.get(R1.pk).id], ["p", R1.pk], ["k", "0"], ["t", "yo"]] }, A.sk)); // t=yo only, no emoji
store.push({ ...yo(R3, A, T0 - 230), sig: "f".repeat(128) }); // forged signature
// A received from X; B received from R1 (inbox regression)
store.push(yo(A, X, T0 - 200));
store.push(yo(B, R1, T0 - 210));
// B sent one Yo to X
const bSent = yo(X, B, T0 - 220);
store.push(bSent);
const kind0Delay = new Map();
const sentDelay = new Map(); // author -> ms for kind 7 author queries
const relayCtl = { reject: false };

// ---------------------------------------------------------------- mock relay (minimal RFC 6455, text frames)
const relayLog = [];
const match = (f, e) => (!f.kinds || f.kinds.includes(e.kind)) && (!f.authors || f.authors.includes(e.pubkey)) && (!f["#p"] || e.tags.some((t) => t[0] === "p" && f["#p"].includes(t[1]))) && (!f["#k"] || e.tags.some((t) => t[0] === "k" && f["#k"].includes(t[1])));
const conns = new Set();
const relaySrv = createServer();
relaySrv.on("upgrade", (req, sock) => {
  const acc = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
  const c = { sock, subs: new Map() }; conns.add(c);
  const send = (msg) => { if (sock.destroyed) return; const p = Buffer.from(JSON.stringify(msg)); let h; if (p.length < 126) h = Buffer.from([0x81, p.length]); else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(p.length, 2); } else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(p.length), 2); } sock.write(Buffer.concat([h, p])); };
  c.send = send;
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15; let len = buf[1] & 127; let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4); const data = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { sock.end(); return; }
      if (op === 9) { sock.write(Buffer.from([0x8a, 0])); continue; }
      if (op !== 1) continue;
      let m; try { m = JSON.parse(Buffer.from(data).toString()); } catch { continue; }
      if (m[0] === "REQ") {
        const [, sid, ...fs] = m; c.subs.set(sid, fs);
        const evs = store.filter((e) => fs.some((f) => match(f, e)));
        const delay = Math.max(0, ...fs.flatMap((f) => (f.authors ?? []).map((a) => (f.kinds?.includes(0) ? kind0Delay.get(a) : f.kinds?.includes(7) ? sentDelay.get(a) : 0) ?? 0)));
        relayLog.push({ t: Date.now(), sid, fs, n: evs.length, delay });
        setTimeout(() => { if (!c.subs.has(sid)) return; for (const e of evs) send(["EVENT", sid, e]); send(["EOSE", sid]); }, delay);
      } else if (m[0] === "CLOSE") c.subs.delete(m[1]);
      else if (m[0] === "EVENT") { const e = m[1]; if (relayCtl.reject) { send(["OK", e.id, false, "blocked: test reject"]); continue; } store.push(e); send(["OK", e.id, true, ""]); for (const cc of conns) for (const [sid, fs] of cc.subs) if (fs.some((f) => match(f, e))) cc.send(["EVENT", sid, e]); }
    }
  });
  sock.on("close", () => conns.delete(c)); sock.on("error", () => conns.delete(c));
});
await new Promise((r) => relaySrv.listen(0, "127.0.0.1", r));
const RELAY = `ws://127.0.0.1:${relaySrv.address().port}`;
L("mock relay", RELAY);

// ---------------------------------------------------------------- chrome
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", ...(process.env.LNA_OFF ? ["--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights"] : []), "about:blank"], { stdio: "ignore" });
let ver;
for (let i = 0; i < 50; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(200); } }
const imgReqs = []; // intercepted *.nyo.test image requests
const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); const signed = []; const gpk = []; const netReqs = []; const netFail = []; const netResp = new Map();
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const state = { pk: A.pk };
ws.onmessage = async (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pend.has(msg.id)) { pend.get(msg.id)(msg); pend.delete(msg.id); return; }
  const p = msg.params;
  if (msg.method === "Fetch.requestPaused") {
    const u = new URL(p.request.url);
    imgReqs.push({ url: p.request.url, headers: p.request.headers, resourceType: p.resourceType });
    const hdr = [{ name: "Content-Type", value: "image/png" }, { name: "Cache-Control", value: "no-store" }];
    if (u.hostname === "img-cors.nyo.test") hdr.push({ name: "Access-Control-Allow-Origin", value: "*" });
    const name = u.pathname.split("/").pop().replace(".png", "");
    const colors = { A: [255, 0, 0], B: [0, 0, 255], C: [0, 200, 0], S1: [255, 160, 0], S5: [0, 200, 200] };
    if (name === "missing" || !colors[name]) await send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 404, responseHeaders: [{ name: "Content-Type", value: "text/plain" }], body: Buffer.from("nf").toString("base64") });
    else await send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: hdr, body: png(...colors[name]).toString("base64") });
    return;
  }
  if (msg.method === "Runtime.bindingCalled" && p.name === "__mockSign") {
    const { reqId, ev } = JSON.parse(p.payload);
    const e = signNode({ kind: ev.kind, created_at: ev.created_at, tags: ev.tags, content: ev.content }, keys.get(state.pk));
    signed.push(e);
    await send("Runtime.evaluate", { expression: `window.__mockResolve(${reqId}, ${JSON.stringify(e)})` });
  }
  if (msg.method === "Runtime.bindingCalled" && p.name === "__mockGpk") gpk.push(Date.now());
  if (msg.method === "Runtime.exceptionThrown") L(`EXCEPTION ${JSON.stringify(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text)}`);
  if (msg.method === "Network.requestWillBeSent") netReqs.push({ id: p.requestId, url: p.request.url, type: p.type, headers: p.request.headers, initiator: p.initiator?.type, policy: p.request.referrerPolicy });
  if (msg.method === "Network.responseReceived") netResp.set(p.requestId, { url: p.response.url, status: p.response.status, acao: Object.entries(p.response.headers).find(([k]) => k.toLowerCase() === "access-control-allow-origin")?.[1] ?? null });
  if (msg.method === "Network.loadingFailed") netFail.push({ id: p.requestId, error: p.errorText, cors: p.corsErrorStatus ?? null, blocked: p.blockedReason ?? null });
};
await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Fetch.enable", { patterns: [{ urlPattern: "*://*.nyo.test/*", requestStage: "Request" }] });
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenWidth: 390, screenHeight: 844 });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Runtime.addBinding", { name: "__mockSign" });
await send("Runtime.addBinding", { name: "__mockGpk" });
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => { let n = 0; const p = new Map();
  window.__mockPk = sessionStorage.getItem('__mockPk') || ${JSON.stringify(A.pk)};
  window.__mockResolve = (i, e) => { p.get(i)(e); p.delete(i); };
  window.nostr = { __TEST_MOCK__: true,
    getPublicKey: async () => { __mockGpk("1"); return window.__mockPk; },
    signEvent: (ev) => new Promise((res) => { const i = ++n; p.set(i, res); __mockSign(JSON.stringify({ reqId: i, ev })); }) }; })();` });
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const setPk = async (pk) => { state.pk = pk; await evalJs(`window.__mockPk=${JSON.stringify(pk)}; sessionStorage.setItem('__mockPk', ${JSON.stringify(pk)})`); };
const shot = async (file, full = false) => { const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full }); writeFileSync(`${out}/${file}`, Buffer.from(r.result.data, "base64")); };
async function waitFor(expr, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await evalJs(expr)) return true; await sleep(250); } return false; }


const result = { site, chrome: ver?.Browser, relay: "local mock relay (this script)", chromeFlags: process.env.LNA_OFF ? "LocalNetworkAccessChecks disabled (test browser only, so the https site can reach the ws://127.0.0.1 mock relay)" : "default", nip07: "TEST MOCK (not a real extension)", startedAt: new Date().toISOString(), checks: {} };
const C = result.checks;
const sentRows = `[...document.querySelectorAll('#sent li')].map(l=>{const a=l.querySelector('.avatar'); return {to:l.dataset.to, id:l.dataset.id, name:l.querySelector('.from-name')?.innerText, when:l.querySelector('time.when')?.innerText, dt:l.querySelector('time.when')?.getAttribute('datetime'), img:a?.tagName==='IMG'?{src:a.getAttribute('src'),loaded:a.complete&&a.naturalWidth>0}:null, letter:!!a?.classList.contains('letter'), back:!!l.querySelector('.yo-back')}})`;
const inboxTos = `[...document.querySelectorAll('#inbox .yo-back')].map(b=>b.dataset.to)`;
const tabState = `({inSel:document.getElementById('tab-in').getAttribute('aria-selected'), outSel:document.getElementById('tab-out').getAttribute('aria-selected'), inHidden:document.getElementById('panel-in').hidden, outHidden:document.getElementById('panel-out').hidden})`;
const sentIds = async () => (await evalJs(sentRows)).map((r) => r.id);

const againBtns = `[...document.querySelectorAll('#sent li .yo-back')]`;
const rowNote = (eid) => `(document.querySelector('#sent li[data-id="${eid}"] .row-note')?.innerText ?? '')`;

// ---- setup ----
await send("Page.navigate", { url: site }); await sleep(1200);
await evalJs(`localStorage.clear(); localStorage.setItem('nostr-yo:relays', JSON.stringify([${JSON.stringify(RELAY)}]))`);
await send("Page.reload", { ignoreCache: true }); await sleep(1500);
C.usesMockRelayOnly = await evalJs(`JSON.stringify([...document.querySelectorAll('#relays li')].map(l=>l.dataset.url))===${JSON.stringify(JSON.stringify([RELAY]))}`);
await evalJs(`document.getElementById('login').click()`);
await waitFor(`document.querySelectorAll('#inbox li').length===1`, 15000);
await evalJs(`document.getElementById('tab-out').click()`);
await waitFor(`(()=>{const r=${sentRows}; return r.length===3 && r.every(x=>!/読み込み中/.test(x.name))})()`, 15000);
result.sentA = await evalJs(sentRows);
const want = JSON.stringify([R1.pk, R2.pk, R3.pk]);
C.everySentRowHasAgainButton = result.sentA.length === 3 && result.sentA.every((r) => r.back) && await evalJs(`JSON.stringify(${againBtns}.map(b=>b.dataset.to))===${JSON.stringify(want)} && ${againBtns}.every(b=>b.innerText==='もう一度 Yo!' && /にもう一度 Yo! を送る$/.test(b.getAttribute('aria-label')))`);
C.inboxReplyStillThere = await evalJs(`document.querySelector('#inbox .yo-back')?.innerText==='Yo! を返す'`);
C.noHorizontalOverflow = await evalJs(`document.documentElement.scrollWidth<=innerWidth`);
await shot("01-sent-with-again.png");

// ---- 1. Yo again to R2 (2nd row), with a rapid double click ----
const r2id = aSent[1].id;
const n0 = signed.length;
const busy = await evalJs(`(()=>{const b=document.querySelector('#sent li[data-id="${r2id}"] .yo-back'); b.click(); b.click(); return {all:${againBtns}.every(x=>x.disabled), send:document.getElementById('send').disabled, inbox:[...document.querySelectorAll('#inbox .yo-back')].every(x=>x.disabled)}})()`);
C.allYoButtonsDisabledWhileSending = busy.all && busy.send && busy.inbox;
C.againOk = await waitFor(`/Yo! を送りました/.test(${rowNote(r2id)})`, 20000);
const ev1 = signed[signed.length - 1];
C.doubleClickSignedOnce = signed.length === n0 + 1;
C.againEventToR2InYoFormat = !!ev1 && ev1.pubkey === A.pk && ev1.kind === 7 && ev1.content === ":yo:" && JSON.stringify(ev1.tags.map((t) => [t[0], t[1]])) === JSON.stringify(yoTags(R2).map((t) => [t[0], t[1]])) && ev1.tags[3][2] === "https://kojira.github.io/nostr-yo/yo.png";
C.againAppearsAtTop = await waitFor(`(()=>{const r=${sentRows}; return r.length===4 && r[0].id===${JSON.stringify(ev1?.id)} && r[0].to===${JSON.stringify(R2.pk)}})()`, 8000);
C.buttonsReenabled = await evalJs(`${againBtns}.every(b=>!b.disabled) && !document.getElementById('send').disabled`);
await shot("02-again-ok.png");

// ---- 2. relay rejects → row error, not added ----
relayCtl.reject = true;
const r3id = aSent[2].id;
const before = (await evalJs(sentRows)).map((r) => r.id);
await evalJs(`document.querySelector('#sent li[data-id="${r3id}"] .yo-back').click()`);
C.rejectShowsRowError = await waitFor(`/送れませんでした/.test(${rowNote(r3id)})`, 20000);
await sleep(600);
C.rejectNotAdded = JSON.stringify((await evalJs(sentRows)).map((r) => r.id)) === JSON.stringify(before);
relayCtl.reject = false;
await shot("03-again-rejected.png");

// ---- 3. extension on another account → refused before signing ----
const n1 = signed.length;
state.pk = B.pk; await evalJs(`window.__mockPk=${JSON.stringify(B.pk)}`);
await evalJs(`document.querySelector('#sent li[data-id="${r3id}"] .yo-back').click()`);
C.mismatchRefused = await waitFor(`/拡張のアカウントが違います/.test(${rowNote(r3id)})`, 10000) && signed.length === n1;
state.pk = A.pk; await evalJs(`window.__mockPk=${JSON.stringify(A.pk)}`);

// ---- 4. account switch while the send is preparing → aborted, nothing signed/leaked ----
kind0Delay.set(R3.pk, 3000);
await evalJs(`document.querySelector('#sent li[data-id="${r3id}"] .yo-back').click()`);
await sleep(500);
await setPk(B.pk);
await evalJs(`document.getElementById('menu-btn').click()`); await sleep(300);
await evalJs(`document.getElementById('relogin').click()`);
await sleep(3500);
await evalJs(`document.getElementById('tab-out').click()`);
C.switchDuringSendNotSigned = signed.length === n1;
C.switchShowsOnlyBSent = await waitFor(`(()=>{const r=${sentRows}; return r.length===1 && r[0].id===${JSON.stringify(bSent.id)} && !document.querySelector('#sent .row-note:not([hidden])')})()`, 10000);
C.switchButtonsUsable = await evalJs(`${againBtns}.length===1 && ${againBtns}.every(b=>!b.disabled)`);
await shot("04-switched-B.png");

result.signedIds = signed.map((e) => e.id);
result.finishedAt = new Date().toISOString();
result.pass = Object.values(C).filter(Boolean).length;
result.total = Object.keys(C).length;
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
writeFileSync(`${out}/log.txt`, log.join("\n") + "\n");
console.log(JSON.stringify(C));
console.log(`PASS ${result.pass}/${result.total}`, Object.entries(C).filter(([, v]) => !v).map(([k]) => k).join(" "));
ws.close(); chrome.kill(); relaySrv.close(); for (const c of conns) c.sock.destroy();
await sleep(500);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(0);
