// Browser check of default relays and saved-setting persistence (no extension, no keys).
// Usage: node scripts/relay-settings-check.mjs <siteUrl> <outFile>
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const site = process.argv[2];
const outFile = process.argv[3];
const CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9800 + Math.floor(Math.random() * 100);
const prof = mkdtempSync(join(tmpdir(), "yo-relaycheck-"));
const c = spawn(CH, [`--remote-debugging-port=${port}`, "--headless=new", `--user-data-dir=${prof}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const p = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); } };
const s = (m, pa = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: pa })); });
const ev = async (e) => (await s("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result.result.value;
await s("Page.enable"); await s("Runtime.enable");
const listUi = `[...document.querySelectorAll('#relays li')].map(l=>({url:l.dataset.url,state:l.className.replace('relay ',''),notice:l.querySelector('.notice')?.innerText??''}))`;
const go = async () => { await s("Page.navigate", { url: site }); await sleep(4000); };

const r = { site, at: new Date().toISOString(), steps: {} };
const want = ["wss://r.kojira.io", "wss://yabu.me", "wss://x.kojira.io", "wss://n.kojira.io"];
await go();
r.steps.fresh = { storage: await ev(`localStorage.getItem('nostr-yo:relays')`), ui: await ev(listUi) };
r.checks = { freshDefaultsInOrder: JSON.stringify(r.steps.fresh.ui.map((x) => x.url)) === JSON.stringify(want), freshNothingSaved: r.steps.fresh.storage === null };
// Simulate a user who saved a list under the old version.
await ev(`localStorage.setItem('nostr-yo:relays', JSON.stringify(["wss://nos.lol","wss://relay.damus.io"]))`);
await go();
r.steps.legacySaved = { ui: await ev(listUi) };
r.checks.legacySavedKept = JSON.stringify(r.steps.legacySaved.ui.map((x) => x.url)) === JSON.stringify(["wss://nos.lol", "wss://relay.damus.io"]);
// UI edit: remove one, add one → persisted and kept after reload.
await ev(`document.querySelector('#relays li[data-url="wss://relay.damus.io"] .rm').click()`);
await ev(`document.getElementById('relay-input').value='wss://yabu.me'; document.getElementById('relay-form').requestSubmit()`);
await sleep(500);
await go();
r.steps.afterUiEdit = { storage: await ev(`localStorage.getItem('nostr-yo:relays')`), ui: await ev(listUi) };
r.checks.uiEditPersisted = JSON.stringify(r.steps.afterUiEdit.ui.map((x) => x.url)) === JSON.stringify(["wss://nos.lol", "wss://yabu.me"]);
// Corrupt / empty saved value → defaults.
await ev(`localStorage.setItem('nostr-yo:relays', '[]')`); await go();
r.checks.emptySavedFallsBackToDefaults = JSON.stringify((await ev(listUi)).map((x) => x.url)) === JSON.stringify(want);
await ev(`localStorage.removeItem('nostr-yo:relays')`); await go();
r.steps.clearedAgain = { ui: await ev(listUi) };
r.checks.clearedFallsBackToDefaults = JSON.stringify(r.steps.clearedAgain.ui.map((x) => x.url)) === JSON.stringify(want);
const shot = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync(outFile.replace(/\.json$/, ".png"), Buffer.from(shot.result.data, "base64"));
writeFileSync(outFile, JSON.stringify(r, null, 2));
console.log(JSON.stringify(r.checks));
console.log(JSON.stringify(r.steps.clearedAgain.ui));
ws.close(); c.kill(); await sleep(500); rmSync(prof, { recursive: true, force: true });
