const kinds=[7107,7108,7109,7110];
for (const u of ["wss://nos.lol","wss://nostr.mom","wss://yabu.me"]) for (const k of kinds) {
  await new Promise(res => { const ws = new WebSocket(u); const to=setTimeout(()=>{ws.close();res()},6000); const seen=[];
    ws.onopen=()=>ws.send(JSON.stringify(["REQ","x",{kinds:[k],limit:20}]));
    ws.onmessage=m=>{const d=JSON.parse(m.data); if(d[0]==="EVENT") seen.push(`${new Date(d[2].created_at*1000).toISOString().slice(0,10)} c=${JSON.stringify(d[2].content.slice(0,40))} tags=${JSON.stringify(d[2].tags.map(t=>t[0]))}`); else {console.log(u,k,seen.length, seen.slice(0,4).join(" || ")); clearTimeout(to); ws.close(); res();}};
    ws.onerror=()=>{clearTimeout(to);res()}; });
}
