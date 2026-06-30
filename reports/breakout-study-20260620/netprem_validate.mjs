import 'dotenv/config';
import fs from 'fs';
const KEY=process.env.UW_API_KEY, BASE='https://api.unusualwhales.com/api';
const H={Authorization:`Bearer ${KEY}`,Accept:'application/json'};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const rows=fs.readFileSync('/tmp/bo_events.csv','utf8').trim().split('\n').slice(1)
  .map(l=>{const[symbol,date,is_trap,rvol,fwd10]=l.split(',');return{symbol,date,is_trap:+is_trap,rvol:+rvol,fwd10:+fwd10};});
const step=Math.max(1,Math.floor(rows.length/500));
const sample=rows.filter((_,i)=>i%step===0);
console.log(`sampling ${sample.length} of ${rows.length} breakout events`);

async function netprem(sym,date,tries=4){
  for(let i=0;i<tries;i++){
    try{const r=await fetch(`${BASE}/stock/${sym}/net-prem-ticks?date=${date}`,{headers:H,signal:AbortSignal.timeout(15000)});
      if(r.status===429||r.status>=500){await sleep(1500*2**i);continue;}
      if(!r.ok)return null;
      const j=await r.json().catch(()=>null);return j?.data||[];
    }catch(e){if(i<tries-1)await sleep(1000*2**i);else return null;}
  }return null;
}

const out=[];
for(let i=0;i<sample.length;i++){
  const e=sample[i];
  const ticks=await netprem(e.symbol,e.date);
  if(ticks&&ticks.length){
    let nc=0,np=0;
    for(const t of ticks){nc+=+(t.net_call_premium||0);np+=+(t.net_put_premium||0);}
    e.net_bull=nc-np;            // $ bullish flow (net call prem minus net put prem)
    e.has=true;
  } else e.has=false;
  out.push(e);
  if(i%50===0)console.log(`  ${i+1}/${sample.length}`);
  await sleep(600);
}

const ok=out.filter(e=>e.has);
console.log(`\ngot flow for ${ok.length}/${sample.length}`);
// terciles by net_bull
const sorted=[...ok].sort((a,b)=>a.net_bull-b.net_bull);
const t1=sorted[Math.floor(ok.length/3)].net_bull, t2=sorted[Math.floor(2*ok.length/3)].net_bull;
function stats(arr){const n=arr.length;const trap=100*arr.filter(e=>e.is_trap).reduce((s)=>s+1,0)/n;
  const f=arr.reduce((s,e)=>s+e.fwd10,0)/n;return {n,trap:trap.toFixed(0),fwd10:f.toFixed(2)};}
const lo=ok.filter(e=>e.net_bull<=t1), mid=ok.filter(e=>e.net_bull>t1&&e.net_bull<t2), hi=ok.filter(e=>e.net_bull>=t2);
console.log('\n=== FALSE-breakout rate by breakout-day NET BULLISH FLOW (net call minus put premium) ===');
console.log('bucket                         n    %false  avg_fwd10');
console.log('a) bearish flow (low tercile) ', JSON.stringify(stats(lo)));
console.log('b) neutral     (mid tercile)  ', JSON.stringify(stats(mid)));
console.log('c) bullish flow (high tercile)', JSON.stringify(stats(hi)));
// sign split
const pos=ok.filter(e=>e.net_bull>0), neg=ok.filter(e=>e.net_bull<=0);
console.log('\n=== by SIGN ===');
console.log('net bullish (>0) ', JSON.stringify(stats(pos)));
console.log('net bearish (<=0)', JSON.stringify(stats(neg)));
fs.writeFileSync('/tmp/netprem_results.json',JSON.stringify(ok));
