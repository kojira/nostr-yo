const cands=[1600,1601,1602,4040,4041,5050,6060,7070,7071,7117,8086,8087,9690,9691];
const hits={}; cands.forEach(k=>hits[k]=0);
for (const u of ["wss://nos.lol","wss://nostr.mom","wss://yabu.me","wss://relay.primal.net","wss://nostr.wine","wss://relay.snort.social","wss://offchain.pub"]) {
  await new Promise(res => { const ws = new WebSocket(u); const to=setTimeout(()=>{console.log(u,"timeout");ws.close();res()},8000);
    ws.onopen=()=>ws.send(JSON.stringify(["REQ","x",{kinds:cands,limit:500}]));
    ws.onmessage=m=>{const d=JSON.parse(m.data); if(d[0]==="EVENT") hits[d[2].kind]++; else {console.log(u,d[0],d[2]??"");clearTimeout(to);ws.close();res();}};
    ws.onerror=()=>{console.log(u,"err");clearTimeout(to);res()}; });
}
console.log(JSON.stringify(hits));
