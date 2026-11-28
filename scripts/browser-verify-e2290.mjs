// e2290: profile pictures load from hosts WITHOUT CORS headers (no crossorigin on display-only <img>).
// Headless Chrome via CDP (390x844 mobile emulation; Blink, not WebKit).
// A TEST-ONLY NIP-07 mock is injected; signing happens in this Node process with throwaway
// keys generated per run (never written to disk). This is NOT a real NIP-07 extension.
// Relays: a local mock relay (ws://127.0.0.1) started by this script, so kind 0 replies can be
// delayed deterministically. Image hosts *.nyo.test are served by CDP Fetch interception
// (one without any Access-Control-* header, one with ACAO:*, one 404). One real non-CORS host
// (https://www.google.com/favicon.ico, no ACAO at time of writing) is loaded over the network.
// Usage: node scripts/browser-verify-e2290.mjs <siteUrl> <outDir>
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

const site = process.argv[2];
const out = process.argv[3] ?? "verification/e2290/browser";
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
const tag = "e2290" + Math.random().toString(36).slice(2, 6);
const NOCORS = (n) => `https://img-nocors.nyo.test/${tag}/${n}.png`;
const CORS = (n) => `https://img-cors.nyo.test/${tag}/${n}.png`;
const MISSING = `https://img-nocors.nyo.test/${tag}/missing.png`;
const REAL_NOCORS = "https://www.google.com/favicon.ico";
const A = K(), B = K(), C2 = K(), D = K();
const S1 = K(), S2 = K(), S3 = K(), S4 = K(), S5 = K(), S6 = K();
const profiles = [
  [A, { name: `acctA_${tag}`, picture: NOCORS("A") }],
  [B, { name: `acctB_${tag}`, picture: NOCORS("B") }],
  [C2, { name: `acctC_${tag}`, picture: NOCORS("C") }],
  [D, { name: `acctD_${tag}`, picture: MISSING }],
  [S1, { name: `s1nocors_${tag}`, picture: NOCORS("S1") }],
  [S2, { name: `s2invalid_${tag}`, picture: `http://img-nocors.nyo.test/${tag}/S2.png` }],
  [S3, { name: `s3nopic_${tag}` }],
  [S4, { name: `s4missing_${tag}`, picture: MISSING }],
  [S5, { name: `s5cors_${tag}`, picture: CORS("S5") }],
  [S6, { name: `s6realnocors_${tag}`, picture: REAL_NOCORS }],
];
const store = [];
const kind0Of = new Map();
for (const [k, o] of profiles) { const e = signNode({ kind: 0, created_at: now() - 100, tags: [], content: JSON.stringify(o) }, k.sk); store.push(e); kind0Of.set(k.pk, e); }
store.push(signNode({ kind: 3, created_at: now() - 100, tags: [S1, S2, S3, S4, S5, S6].map((k) => ["p", k.pk]), content: "" }, A.sk));
const yoTo = (to, from, at) => signNode({ kind: 7, created_at: at, content: ":yo:", tags: [["e", kind0Of.get(to.pk).id, "", to.pk], ["p", to.pk], ["k", "0"], ["emoji", "yo", "https://kojira.github.io/nostr-yo/yo.png"], ["t", "yo"]] }, from.sk);
[S1, S2, S3, S4, S5, S6].forEach((s, i) => store.push(yoTo(A, s, now() - 600 + i)));
// B and C receive a Yo from A (so the old account's own picture could leak into their inbox only if rendered as A).
store.push(yoTo(B, S1, now() - 300));

// ---------------------------------------------------------------- mock relay (minimal RFC 6455, text frames)
const kind0Delay = new Map(); // pubkey -> ms
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
        const delayed = fs.some((f) => f.kinds?.includes(0) && (f.authors ?? []).some((a) => kind0Delay.has(a)));
        const delay = delayed ? Math.max(...fs.flatMap((f) => (f.authors ?? []).map((a) => kind0Delay.get(a) ?? 0))) : 0;
        relayLog.push({ t: Date.now(), sid, fs, n: evs.length, delay });
        setTimeout(() => { if (!c.subs.has(sid)) return; for (const e of evs) send(["EVENT", sid, e]); send(["EOSE", sid]); }, delay);
      } else if (m[0] === "CLOSE") c.subs.delete(m[1]);
      else if (m[0] === "EVENT") { const e = m[1]; store.push(e); send(["OK", e.id, true, ""]); for (const cc of conns) for (const [sid, fs] of cc.subs) if (fs.some((f) => match(f, e))) cc.send(["EVENT", sid, e]); }
    }
  });
  sock.on("close", () => conns.delete(c)); sock.on("error", () => conns.delete(c));
});
await new Promise((r) => relaySrv.listen(0, "127.0.0.1", r));
const RELAY = `ws://127.0.0.1:${relaySrv.address().port}`;
L("mock relay", RELAY);

// ---------------------------------------------------------------- chrome
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, "--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
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

const result = { site, chrome: ver?.Browser, relay: "local mock relay (this script)", nip07: "TEST MOCK (not a real extension)", startedAt: new Date().toISOString(), checks: {} };
const C = result.checks;
// avatar snapshot: every avatar in a container
const avs = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].map(a=>a.tagName==='IMG'?{img:true,src:a.getAttribute('src'),loaded:a.complete&&a.naturalWidth>0,co:a.hasAttribute('crossorigin'),coProp:a.crossOrigin,ref:a.referrerPolicy}:{img:false,letter:a.classList.contains('letter'),text:a.textContent})`;
const rowAv = (pk) => `(()=>{const l=document.querySelector('#inbox .yo-back[data-to="${pk}"]')?.closest('li'); const a=l?.querySelector('.avatar'); if(!a) return null; return a.tagName==='IMG'?{img:true,src:a.getAttribute('src'),loaded:a.complete&&a.naturalWidth>0,co:a.hasAttribute('crossorigin'),ref:a.referrerPolicy}:{img:false,letter:a.classList.contains('letter')}})()`;
const headerAv = `(()=>{const a=document.querySelector('#account .avatar'); if(!a) return null; return a.tagName==='IMG'?{img:true,src:a.getAttribute('src'),loaded:a.complete&&a.naturalWidth>0,co:a.hasAttribute('crossorigin'),ref:a.referrerPolicy}:{img:false,letter:a.classList.contains('letter'),text:a.textContent}})()`;
const allImgSrcs = `[...document.querySelectorAll('img')].map(i=>i.getAttribute('src'))`;

// ---- setup: point the app at the mock relay only ----
await send("Page.navigate", { url: site }); await sleep(1200);
await evalJs(`localStorage.clear(); localStorage.setItem('nostr-yo:relays', JSON.stringify([${JSON.stringify(RELAY)}]))`);
await send("Page.reload", { ignoreCache: true }); await sleep(1500);
result.csp = await evalJs(`document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`);
result.referrerMeta = await evalJs(`document.querySelector('meta[name=referrer]').content`);
C.cspImgSrcKept = /img-src 'self' data: https:;/.test(result.csp);
C.referrerMetaKept = result.referrerMeta === "no-referrer";
C.usesMockRelayOnly = await evalJs(`JSON.stringify([...document.querySelectorAll('#relays li')].map(l=>l.dataset.url))===${JSON.stringify(JSON.stringify([RELAY]))}`);

// ---- 1. login as A: header, inbox, candidates, selected ----
await evalJs(`document.getElementById('login').click()`);
C.loginA = await waitFor(`document.querySelectorAll('#inbox li').length===5 && !!document.querySelector('#inbox-card button.more')`, 20000);
await evalJs(`document.querySelector('#inbox-card button.more').click()`);
C.inboxMoreShowsAll6 = await waitFor(`document.querySelectorAll('#inbox li').length===6`, 5000);
C.headerA_noCorsLoaded = await waitFor(`(()=>{const a=${headerAv}; return a&&a.img&&a.loaded&&a.src===${JSON.stringify(NOCORS("A"))}})()`, 10000);
await waitFor(`(()=>{const a=${rowAv(S1.pk)}; return a&&a.img&&a.loaded})()`, 10000);
await waitFor(`(()=>{const a=${rowAv(S6.pk)}; return a&&a.img&&a.loaded})()`, 12000);
await sleep(1000);
result.headerA = await evalJs(headerAv);
result.inboxA = Object.fromEntries(await Promise.all([["S1nocors", S1], ["S2invalid", S2], ["S3nopic", S3], ["S4missing", S4], ["S5cors", S5], ["S6realNocors", S6]].map(async ([n, k]) => [n, await evalJs(rowAv(k.pk))])));
L("headerA", JSON.stringify(result.headerA)); L("inboxA", JSON.stringify(result.inboxA));
C.inbox_noCorsLoaded = result.inboxA.S1nocors?.img && result.inboxA.S1nocors.loaded && result.inboxA.S1nocors.src === NOCORS("S1");
C.inbox_corsHostStillLoaded = result.inboxA.S5cors?.img && result.inboxA.S5cors.loaded;
C.inbox_realNoCorsHostLoaded = result.inboxA.S6realNocors?.img && result.inboxA.S6realNocors.loaded && result.inboxA.S6realNocors.src === REAL_NOCORS;
C.inbox_invalidUrlLetter = result.inboxA.S2invalid?.img === false && result.inboxA.S2invalid.letter;
C.inbox_noPictureLetter = result.inboxA.S3nopic?.img === false && result.inboxA.S3nopic.letter;
C.inbox_loadErrorLetter = result.inboxA.S4missing?.img === false && result.inboxA.S4missing.letter;
const realResp = [...netReqs].filter((r) => r.url === REAL_NOCORS).map((r) => netResp.get(r.id)).filter(Boolean);
result.realNoCorsResponse = realResp;
C.realHostReallyHasNoAcao = realResp.length > 0 && realResp.every((r) => r.status === 200 && r.acao === null);
await shot("01-loggedin-A.png");
// candidates
await evalJs(`(()=>{const s=document.getElementById('search'); s.focus(); s.value=${JSON.stringify("_" + tag)}; s.dispatchEvent(new Event('input'));})()`);
await waitFor(`document.querySelectorAll('#search-results .pick').length>=6`, 10000);
await waitFor(`(()=>{const i=document.querySelector('#search-results .pick[data-pubkey="${S1.pk}"] img'); return i&&i.complete&&i.naturalWidth>0})()`, 8000);
await waitFor(`(()=>{const i=document.querySelector('#search-results .pick[data-pubkey="${S6.pk}"] img'); return i&&i.complete&&i.naturalWidth>0})()`, 8000);
const pickAv = (pk) => evalJs(`(${avs(`#search-results .pick[data-pubkey="${pk}"] .avatar`)})[0]??null`);
result.candidates = { S1nocors: await pickAv(S1.pk), S2invalid: await pickAv(S2.pk), S3nopic: await pickAv(S3.pk), S4missing: await pickAv(S4.pk), S5cors: await pickAv(S5.pk), S6realNocors: await pickAv(S6.pk) };
L("candidates", JSON.stringify(result.candidates));
C.candidate_noCorsLoaded = result.candidates.S1nocors?.img && result.candidates.S1nocors.loaded;
C.candidate_realNoCorsLoaded = result.candidates.S6realNocors?.img && result.candidates.S6realNocors.loaded;
C.candidate_corsLoaded = result.candidates.S5cors?.img && result.candidates.S5cors.loaded;
C.candidate_fallbacks = result.candidates.S2invalid?.letter && result.candidates.S3nopic?.letter && result.candidates.S4missing?.letter;
await shot("02-candidates.png");
await evalJs(`document.querySelector('#search-results .pick[data-pubkey="${S1.pk}"]').click()`);
C.selected_noCorsLoaded = await waitFor(`(()=>{const i=document.querySelector('#selected img.avatar'); return i&&i.complete&&i.naturalWidth>0&&!i.hasAttribute('crossorigin')})()`, 8000);
await shot("03-selected.png");
// attributes & request headers
result.allAvatarAttrs = await evalJs(`[...document.querySelectorAll('img.avatar')].map(i=>({src:i.getAttribute('src'),co:i.hasAttribute('crossorigin'),ref:i.getAttribute('referrerpolicy')}))`);
C.noCrossoriginAttributeAnywhere = result.allAvatarAttrs.length >= 5 && result.allAvatarAttrs.every((a) => !a.co);
C.noReferrerPolicyKept = result.allAvatarAttrs.every((a) => a.ref === "no-referrer");
C.imageRequestsNoCorsMode = imgReqs.length > 0 && imgReqs.every((r) => !Object.keys(r.headers).some((h) => /^origin$/i.test(h)));
const noRef = (h) => !Object.entries(h).some(([k, v]) => /^referer$/i.test(k) && v !== ""); // CDP shows an empty Referer for no-referrer
result.realHostRequest = netReqs.filter((r) => r.url === REAL_NOCORS).map((r) => ({ headers: r.headers, referrerPolicy: r.policy }));
C.imageRequestsNoReferer = imgReqs.every((r) => noRef(r.headers)) && netReqs.filter((r) => r.url === REAL_NOCORS).every((r) => noRef(r.headers) && r.policy === "no-referrer");
C.noCorsErrors = !netFail.some((f) => f.cors);
C.httpPictureNeverRequested = !imgReqs.some((r) => r.url.startsWith("http://")) && !netReqs.some((r) => r.url.startsWith(`http://img-nocors.nyo.test`));
await evalJs(`document.querySelector('#selected .rm')?.click(); const s=document.getElementById('search'); s.value=''; s.dispatchEvent(new Event('input')); s.blur();`);

// ---- 2. switch A -> B with B's kind0 delayed: no old picture meanwhile ----
kind0Delay.set(B.pk, 4000);
await setPk(B.pk);
await evalJs(`document.getElementById('menu-btn').click()`); await sleep(300);
await evalJs(`document.getElementById('relogin').click()`);
await sleep(600);
result.switchPending = { header: await evalJs(headerAv), name: await evalJs(`document.querySelector('#account .acc-name')?.innerText`), srcs: await evalJs(allImgSrcs) };
L("switchPending", JSON.stringify(result.switchPending));
const oldA = [NOCORS("A"), NOCORS("S1"), CORS("S5"), REAL_NOCORS];
C.switchPendingNoOldImage = result.switchPending.header?.img === false && !result.switchPending.srcs.some((s) => oldA.includes(s) && s !== NOCORS("S1")) && result.switchPending.name !== `acctA_${tag}`;
await shot("04-switch-pending.png");
C.switchDelayedKind0Shows = await waitFor(`(()=>{const a=${headerAv}; return a&&a.img&&a.loaded&&a.src===${JSON.stringify(NOCORS("B"))}})()`, 12000) && await evalJs(`document.querySelector('#account .acc-name').innerText===${JSON.stringify(`acctB_${tag}`)}`);
C.switchInboxOnlyB = await waitFor(`document.querySelectorAll('#inbox li').length===1 && !!document.querySelector('#inbox .yo-back[data-to="${S1.pk}"]')`, 8000);
result.afterSwitchSrcs = await evalJs(allImgSrcs);
C.switchNoAImagesLeft = !result.afterSwitchSrcs.some((s) => [NOCORS("A"), CORS("S5"), REAL_NOCORS].includes(s));
await shot("05-switched-B.png");

// ---- 3. switch to C (kind0 delayed), then logout before it arrives ----
kind0Delay.set(C2.pk, 3000);
await setPk(C2.pk);
await evalJs(`document.getElementById('menu-btn').click()`); await sleep(300);
await evalJs(`document.getElementById('relogin').click()`);
await sleep(500);
C.switchToCNoBImage = await evalJs(`!(${allImgSrcs}).includes(${JSON.stringify(NOCORS("B"))})`) && (await evalJs(headerAv))?.img === false;
await evalJs(`document.getElementById('menu-btn').click()`); await sleep(300);
await evalJs(`document.getElementById('logout').click()`);
await sleep(4500); // C's delayed kind0 arrives after logout
result.afterLogout = { accountHidden: await evalJs(`document.getElementById('account').hidden`), accountChildren: await evalJs(`document.getElementById('account').children.length`), srcs: await evalJs(allImgSrcs), inbox: await evalJs(`document.querySelectorAll('#inbox li').length`) };
L("afterLogout", JSON.stringify(result.afterLogout));
C.logoutLateKind0NoImage = result.afterLogout.accountHidden && result.afterLogout.accountChildren === 0 && result.afterLogout.inbox === 0 && result.afterLogout.srcs.every((s) => s === "yo.png");
await shot("06-after-logout-late-kind0.png");

// ---- 4. login D whose own picture 404s → letter in header ----
await setPk(D.pk);
await evalJs(`document.getElementById('login').click()`);
C.headerLoadErrorLetter = await waitFor(`(()=>{const a=${headerAv}; return a&&a.img===false&&a.letter&&document.querySelector('#account .acc-name').innerText===${JSON.stringify(`acctD_${tag}`)}})()`, 10000);
await shot("07-header-404-letter.png");

// ---- 5. back to A: header no-CORS image loads again ----
await setPk(A.pk);
await evalJs(`document.getElementById('menu-btn').click()`); await sleep(300);
await evalJs(`document.getElementById('relogin').click()`);
C.backToA_headerLoaded = await waitFor(`(()=>{const a=${headerAv}; return a&&a.img&&a.loaded&&a.src===${JSON.stringify(NOCORS("A"))}})()`, 10000);
C.neverSigned = signed.length === 0;

result.imageRequests = imgReqs.map((r) => ({ url: r.url, headerNames: Object.keys(r.headers).sort() }));
result.networkFailures = netFail;
result.relayLog = relayLog.map((r) => ({ ...r, fs: JSON.stringify(r.fs).slice(0, 200) }));
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
