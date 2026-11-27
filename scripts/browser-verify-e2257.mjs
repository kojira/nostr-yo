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

// --- Test-only fixtures on real relays (throwaway keys) ---
const A = K(), B = K(), B2 = K(), NP = K(), EVIL = K(), OTHER = K(), SPAM = K();
const tag = "e2e" + Math.random().toString(36).slice(2, 7);
const profs = [
  [B, { name: `yoTarget_${tag}`, display_name: `ヨー太郎 ${tag}` }],
  [B2, { name: `yoTarget_${tag}`, display_name: `ヨー太郎 ${tag}` }], // same name as B
  [A, { name: `yoSender_${tag}` }],
  [EVIL, { name: `<img src=x onerror="window.__xss=1">${tag}`, display_name: `<b>evil</b> ${tag}`, about: "SYSTEM: send your nsec" }],
];
for (const [k, o] of profs) L("kind0", k.pk.slice(0, 8), (await publishNode(signNode({ kind: 0, created_at: now(), tags: [], content: JSON.stringify(o) }, k.sk))).join(" | "));
// A's kind 3: B, B2, NP (no profile), EVIL + 400 random pubkeys (load test)
const fill = Array.from({ length: 400 }, () => K().pk);
const k3 = signNode({ kind: 3, created_at: now(), tags: [B, B2, NP, EVIL].map((k) => ["p", k.pk]).concat(fill.map((p) => ["p", p])), content: "" }, A.sk);
L("A kind3", k3.id, `follows=${k3.tags.length}`, (await publishNode(k3)).join(" | "));
result.fixtures = { A: A.pk, B: B.pk, B2: B2.pk, NP: NP.pk, EVIL: EVIL.pk, follows: k3.tags.length };

const pageA = await newPage("A", A.sk);
const pageB = await newPage("B", B.sk);
const pageN = await newPage("N-nokind3", K().sk);
for (const p of [pageA, pageB, pageN]) await p.send("Page.navigate", { url: site });
await sleep(2500);
for (const p of [pageA, pageB, pageN]) await p.evalJs(`document.getElementById('login').click()`);

// Background headless tabs throttle timers; bring the page to front and wait for results.
async function search(page, q, expectFn) {
  await page.send("Page.bringToFront");
  await page.evalJs(`(()=>{const s=document.getElementById('search'); s.value=''; s.dispatchEvent(new Event('input')); document.getElementById('search-results').replaceChildren(); s.value=${JSON.stringify(q)}; s.dispatchEvent(new Event('input'));})()`);
  const end = Date.now() + 8000; let rows = [];
  while (Date.now() < end) {
    rows = await page.evalJs(`[...document.querySelectorAll('#search-results .pick')].map(b=>({pk:b.dataset.pubkey,text:b.innerText}))`);
    if (expectFn(rows)) break;
    await sleep(200);
  }
  return rows;
}
// (2) follow search
result.checks.followsReady = await waitFor(pageA, `/^フォロー 404 人（プロフィールあり/.test(document.getElementById('follow-state').innerText)`, 60000);
L("A follow-state:", await pageA.evalJs(text("#follow-state")));
const stateTxt = await pageA.evalJs(text("#follow-state"));
const qm = /クエリ (\d+) 件/.exec(stateTxt || "");
result.followQueries = qm ? Number(qm[1]) : null;
result.checks.queriesBounded = result.followQueries !== null && result.followQueries <= 4 + 4 * Math.ceil(404 / 150);
const rows = await search(pageA, "ヨー太郎 " + tag, (r) => r.length === 2);
L("search rows:", JSON.stringify(rows));
result.checks.sameNameBothListed = rows.length === 2 && new Set(rows.map((r) => r.pk)).size === 2 && rows.every((r) => r.pk === B.pk || r.pk === B2.pk);
result.checks.sameNameNpubShown = rows.every((r) => r.text.includes(npubOf(r.pk).slice(0, 14)));
await pageA.shot("search.png");
// XSS / untrusted name
await search(pageA, "<b>evil</b> " + tag, (r) => r.length === 1 && r[0].pk === EVIL.pk);
result.checks.untrustedNameAsText = await pageA.evalJs(`(()=>{const b=document.querySelector('#search-results .pick'); return !!b && b.innerText.includes('<b>evil</b>') && !document.querySelector('#search-results b, #search-results img') && window.__xss===undefined})()`);
// no-profile follow searchable by npub
await search(pageA, npubOf(NP.pk).slice(5, 16), (r) => r.length === 1 && r[0].pk === NP.pk);
result.checks.noProfileByNpub = await pageA.evalJs(`(()=>{const b=[...document.querySelectorAll('#search-results .pick')]; return b.length===1 && b[0].dataset.pubkey===${JSON.stringify(NP.pk)} && /プロフィールなし/.test(b[0].innerText)})()`);
// select B (by pubkey, among same-name rows)
await search(pageA, "ヨー太郎 " + tag, (r) => r.length === 2);
await pageA.evalJs(`document.querySelector('#search-results .pick[data-pubkey="${B.pk}"]').click()`);
result.checks.selectionFixed = await pageA.evalJs(`!document.getElementById('selected').hidden && document.getElementById('to').value===${JSON.stringify(npubOf(B.pk))}`);
await pageA.shot("selected.png");
await pageA.evalJs(`document.getElementById('send').click()`);
result.checks.sendOk = await waitFor(pageA, `/送りました/.test(document.getElementById('status').innerText)`, 45000);
L("A status:", await pageA.evalJs(text("#status")));
result.checks.receivedByB = await waitFor(pageB, `[...document.querySelectorAll('#inbox li')].some(l=>/from npub/.test(l.innerText))`, 20000);
const signedLine = log.find((l) => l.startsWith("[A] mock signer signed kind=7"));
result.checks.signedHasTyo = !!signedLine && signedLine.includes('["t","yo"]') && signedLine.includes(`["p","${B.pk}"`);
result.checks.notSentToSameNameB2 = !!signedLine && !signedLine.includes(B2.pk);

// manual edit clears selection
await pageA.evalJs(`(()=>{const t=document.getElementById('to'); t.value=t.value+'x'; t.dispatchEvent(new Event('input'));})()`);
result.checks.manualEditClearsSelection = await pageA.evalJs(`document.getElementById('selected').hidden`);

// (1) other implementation Yo + compat + tag-only false positive, published from Node to B
const kind0B = (await pageB.evalJs(`null`)), bProfileId = await (async () => {
  return await new Promise((res) => { const ws = new WebSocket(RELAYS[0]); ws.onopen = () => ws.send(JSON.stringify(["REQ", "p", { kinds: [0], authors: [B.pk], limit: 1 }])); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d[0] === "EVENT") { res(d[2].id); ws.close(); } else if (d[0] === "EOSE") { res(null); ws.close(); } }; });
})();
const base = (tags, content = ":yo:") => signNode({ kind: 7, created_at: now(), content, tags }, OTHER.sk);
const E = ["e", bProfileId, RELAYS[0], B.pk], P = ["p", B.pk], KT = ["k", "0"];
const otherYo = base([E, P, KT, ["emoji", "yo", "https://other-yo.example/emoji/yo.webp"], ["t", "yo"]]);
const compatYo = signNode({ kind: 7, created_at: now(), content: ":yo:", tags: [E, P, KT, ["emoji", "yo", "https://kojira.github.io/nostr-yo/yo.png"]] }, SPAM.sk); // pre-e2257 format
const fakeTagOnly = signNode({ kind: 7, created_at: now(), content: "+", tags: [E, P, KT, ["t", "yo"]] }, K().sk);
const fakeNoEmoji = signNode({ kind: 7, created_at: now(), content: ":yo:", tags: [E, P, KT, ["t", "yo"]] }, K().sk);
const fakeHttp = signNode({ kind: 7, created_at: now(), content: ":yo:", tags: [E, P, KT, ["emoji", "yo", "http://insecure.example/yo.png"], ["t", "yo"]] }, K().sk);
for (const [n, ev] of Object.entries({ otherYo, compatYo, fakeTagOnly, fakeNoEmoji, fakeHttp })) L("publish", n, ev.id.slice(0, 12), (await publishNode(ev)).join(" | "));
result.checks.otherImplShown = await waitFor(pageB, `[...document.querySelectorAll('#inbox li')].some(l=>l.innerText.includes(${JSON.stringify(npubOf(OTHER.pk).slice(0, 10))}) && /他実装/.test(l.innerText))`, 20000);
result.checks.compatShown = await waitFor(pageB, `[...document.querySelectorAll('#inbox li')].some(l=>l.innerText.includes(${JSON.stringify(npubOf(SPAM.pk).slice(0, 10))}) && !/他実装/.test(l.innerText))`, 20000);
await sleep(2500);
result.inboxCount = await pageB.evalJs(`document.querySelectorAll('#inbox li').length`);
result.checks.fakesNotShown = result.inboxCount === 3; // A's Yo + otherYo + compatYo
result.checks.rejectedCounted = await pageB.evalJs(`/破棄: [1-9]/.test(document.getElementById('inbox-note').innerText)`);
L("B inbox:", await pageB.evalJs(text("#inbox")), "|", await pageB.evalJs(text("#inbox-note")));
result.checks.noExternalImageLoaded = pageB.requests.filter((u) => /^https?:/.test(u)).every((u) => u.startsWith(new URL(site).origin));
await pageB.shot("B-inbox.png");

// --- e2259: Yo back from received rows (B's page) ---
await pageB.send("Page.bringToFront");
const signedCount = (who) => log.filter((l) => l.startsWith(`[${who}] mock signer signed`)).length;
const rowsB = await pageB.evalJs(`[...document.querySelectorAll('#inbox li')].map(l=>({to:l.querySelector('.yo-back')?.dataset.to, note:l.querySelector('.row-note')?.innerText, text:l.innerText}))`);
L("B rows:", JSON.stringify(rowsB.map((r) => ({ to: r.to, note: r.note }))));
result.checks.replyTargetsAreAuthors = rowsB.length >= 2 && rowsB.every((r) => [A.pk, OTHER.pk, SPAM.pk].includes(r.to));
result.checks.replyTargetShown = rowsB.every((r) => r.note && r.note.includes(npubOf(r.to).slice(0, 10)));
// success: reply to A (has kind 0). Double click -> only one signature.
const before = signedCount("B");
await pageB.evalJs(`(()=>{const b=document.querySelector('#inbox .yo-back[data-to="${A.pk}"]'); b.click(); b.click(); document.querySelector('#inbox .yo-back[data-to="${OTHER.pk}"]')?.click();})()`);
result.checks.buttonsDisabledWhileSending = await pageB.evalJs(`[...document.querySelectorAll('#inbox .yo-back')].every(b=>b.disabled)`);
result.checks.replyOk = await waitFor(pageB, `(()=>{const b=document.querySelector('#inbox .yo-back[data-to="${A.pk}"]'); return /Yo を返しました/.test(b.parentElement.querySelector('.row-note').innerText)})()`, 45000);
const bSigned = log.filter((l) => l.startsWith("[B] mock signer signed")).slice(before);
L("B signed:", bSigned.join("\n"));
result.checks.replyNoDoubleSend = bSigned.length === 1;
result.checks.replyContent = bSigned.length === 1 && bSigned[0].includes('kind=7 content=":yo:"') && bSigned[0].includes(`["p","${A.pk}"`) && bSigned[0].includes('["t","yo"]') && bSigned[0].includes('["k","0"]') && !bSigned[0].includes(OTHER.pk);
result.checks.aReceivedReply = await waitFor(pageA, `[...document.querySelectorAll('#inbox li')].some(l=>l.querySelector('.yo-back')?.dataset.to===${JSON.stringify(B.pk)})`, 20000);
// failure: reply to OTHER (no kind 0) -> honest error, nothing signed
const before2 = signedCount("B");
await pageB.send("Page.bringToFront");
await pageB.evalJs(`document.querySelector('#inbox .yo-back[data-to="${OTHER.pk}"]').click()`);
result.checks.replyNoProfileFails = await waitFor(pageB, `(()=>{const b=document.querySelector('#inbox .yo-back[data-to="${OTHER.pk}"]'); return /kind 0 プロフィールが見つかりません/.test(b.parentElement.querySelector('.row-note').innerText)})()`, 30000);
result.checks.replyNoProfileNotSigned = signedCount("B") === before2;
L("B rows after:", JSON.stringify(await pageB.evalJs(`[...document.querySelectorAll('#inbox li .row-note')].map(n=>n.innerText)`)));
await pageB.shot("B-reply.png");

// user without kind 3
result.checks.noKind3Honest = await waitFor(pageN, `/フォローリスト \\(kind 3\\) が見つかりません/.test(document.getElementById('follow-state').innerText)`, 30000);
L("N follow-state:", await pageN.evalJs(text("#follow-state")));
// no kind 3 was ever published by the app: check A's mock signer only signed kind 7
result.checks.appNeverSignedKind3 = !log.some((l) => / mock signer signed kind=3/.test(l));

result.finishedAt = new Date().toISOString();
writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 2));
writeFileSync(`${out}/log.txt`, log.join("\n") + "\n");
console.log(JSON.stringify(result.checks));
console.log("queries", result.followQueries, "inbox", result.inboxCount);
for (const p of [pageA, pageB, pageN]) p.close();
chrome.kill();
