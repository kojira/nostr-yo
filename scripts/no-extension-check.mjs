import { spawn } from "node:child_process";
const CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; const port=9911;
const c=spawn(CH,[`--remote-debugging-port=${port}`,"--headless=new",`--user-data-dir=/tmp/noext-prof`,"about:blank"],{stdio:"ignore"});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); for(let i=0;i<40;i++){try{await fetch(`http://127.0.0.1:${port}/json/version`);break}catch{await sleep(200)}}
const t=await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:"PUT"})).json();
const ws=new WebSocket(t.webSocketDebuggerUrl); await new Promise(r=>ws.onopen=r); let id=0; const p=new Map(); const logs=[];
ws.onmessage=m=>{const d=JSON.parse(m.data); if(d.id&&p.has(d.id)){p.get(d.id)(d);p.delete(d.id)} if(d.method==="Log.entryAdded")logs.push(d.params.entry.level+": "+d.params.entry.text); if(d.method==="Runtime.exceptionThrown")logs.push("EXC "+d.params.exceptionDetails.text)};
const s=(m,pa={})=>new Promise(r=>{const i=++id;p.set(i,r);ws.send(JSON.stringify({id:i,method:m,params:pa}))});
await s("Runtime.enable");await s("Log.enable");await s("Page.enable");
await s("Page.navigate",{url:"https://kojira.github.io/nostr-yo/"}); await sleep(3000);
const ev=async e=>(await s("Runtime.evaluate",{expression:e,returnByValue:true})).result.result.value;
await ev("document.getElementById('login').click()"); await sleep(500);
console.log(JSON.stringify({ext:await ev("document.getElementById('ext').innerText"),status:await ev("document.getElementById('status').innerText"),hasNostr:await ev("typeof window.nostr"),logs}));
await ev("document.getElementById('send').click()"); await sleep(300); console.log("send w/o login:",await ev("document.getElementById('status').innerText"));
c.kill();
