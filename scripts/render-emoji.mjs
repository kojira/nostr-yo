// One-off: render assets/yo-emoji.html to web/yo.png (256x256, transparent) with headless Chrome.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const CH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9701, prof = mkdtempSync(join(tmpdir(), "yo-emoji-"));
const c = spawn(CH, [`--remote-debugging-port=${port}`, "--headless=new", `--user-data-dir=${prof}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/json/version`); break; } catch { await sleep(200); } }
const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const p = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); } };
const s = (m, pa = {}) => new Promise((r) => { const i = ++id; p.set(i, r); ws.send(JSON.stringify({ id: i, method: m, params: pa })); });
await s("Page.enable");
await s("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
await s("Page.navigate", { url: "file://" + resolve("assets/yo-emoji.html") }); await sleep(1000);
const r = await s("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 256, height: 256, scale: 1 } });
writeFileSync("web/yo.png", Buffer.from(r.result.data, "base64"));
ws.close(); c.kill(); await sleep(300); rmSync(prof, { recursive: true, force: true }); console.log("wrote web/yo.png");
