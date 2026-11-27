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
const RELAYS = ["wss://r.kojira.io", "wss://yabu.me", "wss://x.kojira.io", "wss://n.kojira.io"];
const now = () => Math.floor(Date.now() / 1000);
function signNode(e, sk) {
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const id = bytesToHex(sha256(utf8ToBytes(JSON.stringify([0, pubkey, e.created_at, e.kind, e.tags, e.content]))));
  return { ...e, pubkey, id, sig: bytesToHex(schnorr.sign(hexToBytes(id), sk)) };
}
async function publishNode(ev) {
  return Promise.all(RELAYS.map((u) => new Promise((res) => {
    const ws = new WebSocket(u); const to = setTimeout(() => { ws.close(); res(`${u}:timeout`); }, 25000);
    ws.onopen = () => ws.send(JSON.stringify(["EVENT", ev]));
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d[0] === "OK" && d[1] === ev.id) { clearTimeout(to); ws.close(); res(`${u}:${d[2]}${d[3] ? " " + d[3] : ""}`); } };
    ws.onerror = () => { clearTimeout(to); res(`${u}:error`); };
  })));
}
const { bech32 } = await import("@scure/base");
const npubOf = (hex) => bech32.encode("npub", bech32.toWords(hexToBytes(hex)), 90);
const K = () => { const sk = schnorr.utils.randomSecretKey(); return { sk, pk: bytesToHex(schnorr.getPublicKey(sk)) }; };

// --- e2263 fixtures (throwaway keys) ---
const R = K(), S1 = K(), S2 = K(), S3 = K(), S4 = K(), S5 = K(), S6 = K();
const tag = "e2263" + Math.random().toString(36).slice(2, 6);
const GOODPIC = "https://kojira.github.io/nostr-yo/yo.png";
const BROKENPIC = "https://kojira.github.io/nostr-yo/does-not-exist-" + tag + ".png";
const profiles = [
  [R, { name: `recv_${tag}` }],
  [S1, { name: `alice_${tag}`, display_name: `アリス ${tag}`, picture: GOODPIC }],
  [S2, { name: `alice_${tag}`, display_name: `アリス ${tag}`, picture: BROKENPIC }],            // same name, broken image
  [S3, { name: `<img src=x onerror="window.__xss=1">${tag}`, picture: "javascript:window.__xss=2" }], // bad name + bad URL
  [S4, { display_name: `nopic_${tag}` }],                                                         // no picture
  [S6, { name: `httppic_${tag}`, picture: "http://insecure.example/p.png" }],                    // http picture rejected
  // S5: no kind 0 at all
];
for (const [k, o] of profiles) L("kind0", k.pk.slice(0, 8), (await publishNode(signNode({ kind: 0, created_at: now(), tags: [], content: JSON.stringify(o) }, k.sk))).join(" | "));
// R follows S1 (good pic), S2 (broken pic, same name), S3 (bad URL), S5 (no profile) — for e2264 search icons
const k3R = signNode({ kind: 3, created_at: now(), tags: [S1, S2, S3, S5].map((k) => ["p", k.pk]), content: "" }, R.sk);
L("R kind3", (await publishNode(k3R)).join(" | "));
const rProfile = await new Promise((res) => { const ws = new WebSocket(RELAYS[0]); ws.onopen = () => ws.send(JSON.stringify(["REQ", "p", { kinds: [0], authors: [R.pk], limit: 1 }])); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d[0] === "EVENT") { res(d[2].id); ws.close(); } else if (d[0] === "EOSE") { res(null); ws.close(); } }; });
const yoTo = (k) => signNode({ kind: 7, created_at: now(), content: ":yo:", tags: [["e", rProfile, RELAYS[0], R.pk], ["p", R.pk, RELAYS[0]], ["k", "0"], ["emoji", "yo", "https://kojira.github.io/nostr-yo/yo.png"], ["t", "yo"]] }, k.sk);
for (const k of [S1, S2, S3, S4, S5, S6]) L("yo from", k.pk.slice(0, 8), (await publishNode(yoTo(k))).join(" | "));

const pageR = await newPage("R", R.sk);
const pageS1 = await newPage("S1", S1.sk);
await pageR.send("Page.navigate", { url: site });
await pageS1.send("Page.navigate", { url: site });
await sleep(2500);
await pageR.evalJs(`document.getElementById('login').click()`);
await pageS1.evalJs(`document.getElementById('login').click()`);
await pageR.send("Page.bringToFront");
const rowsJs = `[...document.querySelectorAll('#inbox li')].map(l=>({to:l.querySelector('.yo-back')?.dataset.to, name:l.querySelector('.from-name')?.innerText, npub:l.querySelector('.from-npub')?.innerText, img:l.querySelector('img.avatar')?.getAttribute('src')??null, imgLoaded:(()=>{const i=l.querySelector('img.avatar');return i?(i.complete&&i.naturalWidth>0):null})(), ref:l.querySelector('img.avatar')?.referrerPolicy??null, letter:!!l.querySelector('.avatar.letter'), note:l.querySelector('.row-note')?.innerText}))`;
const ready = await waitFor(pageR, `(${rowsJs}).length===6 && (${rowsJs}).every(r=>r.name && r.name!=='読み込み中…')`, 40000);
await sleep(3000); // let images load / error
const rows = await pageR.evalJs(rowsJs);
L("rows:", JSON.stringify(rows, null, 0));
const by = (k) => rows.find((r) => r.to === k.pk);
const npubOfShort = (hex) => { const n = npubOf(hex); return `${n.slice(0, 10)}…${n.slice(-6)}`; };
result.checks.allRowsResolved = ready;
result.checks.nameAndIconShown = by(S1)?.name === `アリス ${tag}` && by(S1)?.img === GOODPIC && by(S1)?.imgLoaded === true && by(S1)?.ref === "no-referrer";
result.checks.sameNameDistinguishedByNpub = by(S2)?.name === by(S1)?.name && by(S2)?.npub === npubOfShort(S2.pk) && by(S1)?.npub === npubOfShort(S1.pk) && by(S1)?.npub !== by(S2)?.npub;
result.checks.brokenImageFallsBack = by(S2)?.letter === true && by(S2)?.img === null;
result.checks.badNameAsText = by(S3)?.name === `<img src=x onerror="window.__xss=1">${tag}` && (await pageR.evalJs(`window.__xss===undefined && !document.querySelector('#inbox .from-name img')`));
result.checks.badUrlRejected = by(S3)?.letter === true && by(S3)?.img === null && by(S6)?.letter === true && by(S6)?.img === null;
result.checks.noPictureLetter = by(S4)?.name === `nopic_${tag}` && by(S4)?.letter === true;
result.checks.noProfileHonest = by(S5)?.name === "プロフィールなし" && by(S5)?.letter === true && by(S5)?.npub === npubOfShort(S5.pk);
result.checks.replyTargetsFixedToAuthor = rows.every((r) => [S1, S2, S3, S4, S5, S6].some((k) => k.pk === r.to));
result.checks.emojiUrlNeverLoaded = !pageR.requests.some((u) => u.includes("evil.example") || u.includes("insecure.example"));
result.checks.imageRequestsOnlyHttps = pageR.requests.filter((u) => /\.(png|jpg|gif|webp)/.test(u)).every((u) => u.startsWith("https://") || u.startsWith(new URL(site).origin));
await pageR.shot("inbox-profiles.png");
// --- e2264: icons in follow search candidates ---
await waitFor(pageR, `/^フォロー 4 人（プロフィールあり/.test(document.getElementById('follow-state').innerText)`, 30000);
L("R follow-state:", await pageR.evalJs(text("#follow-state")));
async function search(page, q, expectFn) {
  await page.send("Page.bringToFront");
  await page.evalJs(`(()=>{const s=document.getElementById('search'); s.value=''; s.dispatchEvent(new Event('input')); document.getElementById('search-results').replaceChildren(); s.value=${JSON.stringify(q)}; s.dispatchEvent(new Event('input'));})()`);
  const end = Date.now() + 8000; let rows = [];
  while (Date.now() < end) {
    rows = await page.evalJs(`[...document.querySelectorAll('#search-results .pick')].map(b=>({pk:b.dataset.pubkey, name:b.querySelector('.pick-name')?.innerText, npub:b.querySelector('.pick-npub')?.innerText, img:b.querySelector('img.avatar')?.getAttribute('src')??null, ref:b.querySelector('img.avatar')?.referrerPolicy??null, loaded:(()=>{const i=b.querySelector('img.avatar');return i?(i.complete&&i.naturalWidth>0):null})(), letter:!!b.querySelector('.avatar.letter')}))`);
    if (expectFn(rows)) break;
    await sleep(200);
  }
  return rows;
}
let srows = await search(pageR, `アリス ${tag}`, (r) => r.length === 2);
await sleep(2500); // let image load / error
srows = await search(pageR, `アリス ${tag}`, (r) => r.length === 2 && r.every((x) => x.loaded !== false || x.letter));
await sleep(2500);
srows = await pageR.evalJs(`[...document.querySelectorAll('#search-results .pick')].map(b=>({pk:b.dataset.pubkey, name:b.querySelector('.pick-name')?.innerText, npub:b.querySelector('.pick-npub')?.innerText, img:b.querySelector('img.avatar')?.getAttribute('src')??null, ref:b.querySelector('img.avatar')?.referrerPolicy??null, loaded:(()=>{const i=b.querySelector('img.avatar');return i?(i.complete&&i.naturalWidth>0):null})(), letter:!!b.querySelector('.avatar.letter')}))`);
L("search rows:", JSON.stringify(srows));
const sby = (k) => srows.find((r) => r.pk === k.pk);
result.checks.searchIconShown = sby(S1)?.img === GOODPIC && sby(S1)?.loaded === true && sby(S1)?.ref === "no-referrer";
result.checks.searchBrokenIconFallsBack = sby(S2)?.letter === true && sby(S2)?.img === null;
result.checks.searchSameNameNpub = sby(S1)?.name === sby(S2)?.name && sby(S1)?.npub !== sby(S2)?.npub;
await pageR.shot("search-icons.png");
const s3rows = await search(pageR, `${tag}`, (r) => r.some((x) => x.pk === S3.pk));
result.checks.searchBadUrlLetter = s3rows.find((r) => r.pk === S3.pk)?.letter === true && s3rows.find((r) => r.pk === S3.pk)?.img === null;
const s5rows = await search(pageR, npubOf(S5.pk).slice(5, 16), (r) => r.length === 1 && r[0].pk === S5.pk);
result.checks.searchNoProfileLetter = s5rows[0]?.letter === true && /プロフィールなし/.test(s5rows[0]?.name ?? "");
// select S2 (same name as S1) → pubkey fixed to S2
await search(pageR, `アリス ${tag}`, (r) => r.length === 2);
await pageR.evalJs(`document.querySelector('#search-results .pick[data-pubkey="${S2.pk}"]').click()`);
result.checks.searchSelectFixesAuthor = await pageR.evalJs(`!document.getElementById('selected').hidden && document.getElementById('to').value===${JSON.stringify(npubOf(S2.pk))}`);
await pageR.evalJs(`document.getElementById('send').click()`);
result.checks.searchSendOk = await waitFor(pageR, `/送りました/.test(document.getElementById('status').innerText)`, 45000);
const sentLine = log.filter((l) => l.startsWith("[R] mock signer signed")).at(-1) ?? "";
result.checks.searchSentToSelected = sentLine.includes(`["p","${S2.pk}"`) && !sentLine.includes(S1.pk);
L("R status:", await pageR.evalJs(text("#status")));

// Yo back regression: reply to S1 (has kind 0)
const before = log.filter((l) => l.startsWith("[R] mock signer signed")).length;
await pageR.evalJs(`document.querySelector('#inbox .yo-back[data-to="${S1.pk}"]').click()`);
result.checks.replyOk = await waitFor(pageR, `/Yo を返しました/.test(document.querySelector('#inbox .yo-back[data-to="${S1.pk}"]').parentElement.querySelector('.row-note').innerText)`, 45000);
const signed = log.filter((l) => l.startsWith("[R] mock signer signed")).slice(before);
result.checks.replySignedOnceToAuthor = signed.length === 1 && signed[0].includes(`["p","${S1.pk}"`) && signed[0].includes('["t","yo"]');
await pageS1.send("Page.bringToFront");
result.checks.s1ReceivedWithRName = await waitFor(pageS1, `[...document.querySelectorAll('#inbox li')].some(l=>l.querySelector('.yo-back')?.dataset.to===${JSON.stringify(R.pk)} && l.querySelector('.from-name')?.innerText===${JSON.stringify("recv_" + tag)})`, 25000);
result.finishedAt = new Date().toISOString();
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
writeFileSync(`${out}/log.txt`, log.join("\n") + "\n");
console.log(JSON.stringify(result.checks));
pageR.close(); pageS1.close(); chrome.kill();
