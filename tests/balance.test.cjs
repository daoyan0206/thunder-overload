'use strict';
// Normal-pace balance comparison: actual unmodified game runtime, no browser.
// node tests/balance.test.cjs [--quick] [--seconds=80]
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const helperPath=path.join(__dirname,'runtime.test.cjs');
const helper=fs.readFileSync(helperPath,'utf8').split('const tests = [];')[0];
const context=vm.createContext({require,__dirname,console,Buffer,process});
// Only load the reusable test adapter prefix, not its tests or modified game code.
new vm.Script(helper+'\nglobalThis.adapter={runtime,config,source};',{filename:helperPath}).runInContext(context);
const {runtime,config,source}=context.adapter;
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const sourceHash=digest(source),configHash=digest(JSON.stringify(config));
const args=process.argv.slice(2),quick=args.includes('--quick');
const seconds=Number(args.find(x=>x.startsWith('--seconds='))?.split('=')[1]||80);
assert.ok(seconds>=60&&seconds<=80,'balance must cover normal60-80s');
if(config.rules.waveEvery!==20||config.rules.waveHealthPower!==1.35||config.rules.enemyHealth!==60||config.rules.waveHealthGrowth!==6||config.rules.waveHealthCurve!==3){
  console.error('NOT READY: latest default rules do not yet match early-pressure design; adapter prepared. No game rules overridden.');
  console.error(JSON.stringify(config.rules));process.exit(2);
}
function seeded(seed){let a=seed>>>0;return()=>{a+=0x6D2B79F5;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
const seeds=[137,2026,9109],banks=quick?[625]:[0,625,10000];
function danger(s){return s.counts.enemyBullets>14||s.counts.enemies>7||s.enemies.some(e=>e.boss&&e.y>=190);}
function run(seed,bank,moving){
  const r=runtime({save:{bank,best:0,muted:true},random:seeded(seed)});r.key('Enter');
  let before=r.state(),initial={...before.hero},firstDamage=null,timeDeath=null,waveDeath=null,minHearts=before.hearts,peakEnemies=0,peakEnemyBullets=0,maxMovement=0;
  const initialHearts=before.hearts,core=before.core,milestones={},damageEvents=[];
  for(let i=0;i<Math.ceil(seconds*60)&&before.phase==='playing';i++){
    if(i%6===0){if(moving)r.window.__autoplay(before);else if(before.charge>=100&&danger(before))r.key(' ');}
    const s=r.step();maxMovement=Math.max(maxMovement,Math.hypot(s.hero.x-initial.x,s.hero.y-initial.y));
    if(!moving){assert.equal(s.hero.x,initial.x,'stationary x invariant');assert.equal(s.hero.y,initial.y,'stationary y invariant');}
    if(s.hearts<before.hearts){if(firstDamage===null)firstDamage=s.elapsed;damageEvents.push({time:+s.elapsed.toFixed(2),wave:s.wave,loss:before.hearts-s.hearts});}
    minHearts=Math.min(minHearts,s.hearts);peakEnemies=Math.max(peakEnemies,s.counts.enemies);peakEnemyBullets=Math.max(peakEnemyBullets,s.counts.enemyBullets);
    for(const t of [20,40,60,80])if(s.elapsed>=t-1e-6&&!milestones[t])milestones[t]={hearts:s.hearts,level:s.level,wave:s.wave,kills:s.kills,bossKills:s.bossKills};
    if(s.phase==='lost'){timeDeath=s.elapsed;waveDeath=s.wave;}before=s;
  }
  assert.ok(moving?maxMovement>1:maxMovement===0,'movement treatment correct');
  assert.equal(r.messages.filter(x=>x.type==='error').length,0,'no game error');
  return{seed,bank,core,mode:moving?'moving':'stationary',initialHearts,firstDamage:firstDamage===null?null:+firstDamage.toFixed(2),timeDeath:timeDeath===null?null:+timeDeath.toFixed(2),waveDeath,minHearts,finalHearts:before.hearts,bossKills:before.bossKills,peakEnemies,peakEnemyBullets,maxMovement:+maxMovement.toFixed(2),elapsed:+before.elapsed.toFixed(2),level:before.level,skillUses:before.skillUses,milestones,damageEvents};
}
console.log(`Actual game.js SHA256 ${sourceHash}; actual parsed game.json SHA256 ${configHash}`);
console.log(`Default waveEvery=${config.rules.waveEvery}; no rule overrides; duration=${seconds}s; seeds=${seeds}; banks=${banks}`);
const results=[];
for(const bank of banks){for(const seed of seeds){for(const moving of [false,true]){const row=run(seed,bank,moving);results.push(row);console.log(JSON.stringify(row));}}}
const summary=banks.map(bank=>{
  const pairs=seeds.map(seed=>({seed,stationary:results.find(x=>x.bank===bank&&x.seed===seed&&x.mode==='stationary'),moving:results.find(x=>x.bank===bank&&x.seed===seed&&x.mode==='moving')}));
  const pressured=pairs.filter(p=>p.stationary.damageEvents.some(e=>e.wave>=2&&e.wave<=3)).length;
  const advantages=pairs.filter(p=>(p.stationary.timeDeath!==null&&(p.moving.timeDeath===null||p.moving.timeDeath>=p.stationary.timeDeath+5))||(p.moving.minHearts>=p.stationary.minHearts+2)||(p.stationary.firstDamage!==null&&(p.moving.firstDamage===null||p.moving.firstDamage>=p.stationary.firstDamage+10))).map(p=>p.seed);
  return{bank,pressuredByEndWave3:pressured,movingAdvantageSeeds:advantages,status:pressured>=2&&advantages.length>=1?'PASS':'FAIL',criterion:'>=2/3 stationary seeds take actual HP damage during wave2 or3, >=1 moving seed survives5s longer OR retains2 more minimum hearts OR delays first damage10s'};
});
const report={sourceHash,configHash,seconds,seeds,banks,rules:config.rules,results,summary,limitations:'PureNodeVM480x900/DPR1; no-op Canvas; synchronous60Hz; seeded RNG is also consumed by real FX/render so matching seeds do not guarantee identical later enemy RNG after tactics diverge. No GPU/FPS/mobile/audio/browser storage validation. Stationary uses actual Space skill every100ms only under same danger trigger; moving uses real __autoplay. Actual default rules/weapons/life and profile growth; no private state injected.'};
const filename=quick?'balance-quick-results.json':'balance-results.json';fs.writeFileSync(path.join(__dirname,filename),JSON.stringify(report,null,2)+'\n');
console.log('SUMMARY '+JSON.stringify(summary));console.log(report.limitations);
const unchanged=fs.readFileSync(path.join(root,'game.js'),'utf8')===source&&digest(JSON.stringify(JSON.parse(fs.readFileSync(path.join(root,'game.json'),'utf8'))))===configHash;
if(!unchanged){console.error('INVALIDATED: main game changed during run; rerun latest source.');process.exitCode=2;}else process.exitCode=summary.every(x=>x.status==='PASS')?0:1;
console.log('Report '+path.join(__dirname,filename));
