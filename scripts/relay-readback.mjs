// Read back Yo reactions for a pubkey directly from relays (independent of the UI).
import { parseIncomingYo } from "../dist-test/yo-lib.mjs";
const me = process.argv[2];
for (const u of ["wss://r.kojira.io", "wss://yabu.me", "wss://x.kojira.io", "wss://n.kojira.io"]) {
  await new Promise((res) => { const ws = new WebSocket(u); const evs = []; const to = setTimeout(() => { console.log(u, "timeout"); ws.close(); res(); }, 10000);
    ws.onopen = () => ws.send(JSON.stringify(["REQ", "r", { kinds: [7], "#p": [me], "#k": ["0"], limit: 20 }]));
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d[0] === "EVENT") evs.push(d[2]); else if (d[0] === "EOSE" || d[0] === "CLOSED") { clearTimeout(to); ws.close();
      console.log(u, d[0], `events=${evs.length}`, evs.map((e) => `${e.id.slice(0, 12)} kind=${e.kind} content=${e.content} accepted=${!!parseIncomingYo(e, me)}`).join(" | ")); res(); } };
    ws.onerror = () => { clearTimeout(to); console.log(u, "error"); res(); }; });
}
