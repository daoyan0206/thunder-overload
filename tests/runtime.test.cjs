'use strict';
// Pure Node VM tests: execute the untouched current game.js, no browser/server.
// Run: node thunder-overload/tests/runtime.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
const config = JSON.parse(fs.readFileSync(path.join(root, 'game.json'), 'utf8'));

function runtime({ rules = {}, save = null, storageMode = 'normal', random = 0.5 } = {}) {
  let now = 1000, nextId = 1;
  const frames = new Map(), messages = [], stored = new Map();
  if (save !== null) stored.set('thunder-overload-save-v1', typeof save === 'string' ? save : JSON.stringify(save));
  function eventTarget() {
    const listeners = new Map();
    return {
      addEventListener(type, fn) { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
      removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(x => x !== fn)); },
      dispatch(type, extras = {}) {
        const e = Object.assign({ type, repeat: false, preventDefault() {}, stopPropagation() {} }, extras);
        for (const fn of listeners.get(type) || []) fn(e);
      }
    };
  }
  function context2d() {
    const gradient = { addColorStop() {} };
    return new Proxy({ createLinearGradient() { return gradient; }, createRadialGradient() { return gradient; }, measureText(t) { return { width: String(t).length * 8 }; } }, {
      get(obj, key) { return key in obj ? obj[key] : (() => {}); },
      set(obj, key, value) { obj[key] = value; return true; }
    });
  }
  function makeCanvas() {
    const target = eventTarget(), captures = new Set(), context = context2d();
    return Object.assign(target, { style: {}, width: 480, height: 900, tabIndex: 0,
      getContext() { return context; }, toDataURL() { return 'data:image/png;base64,bW9jaw=='; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 480, height: 900 }; },
      focus() {}, setPointerCapture(id) { captures.add(id); }, releasePointerCapture(id) { captures.delete(id); }
    });
  }
  const canvas = makeCanvas();
  const document = Object.assign(eventTarget(), { body: { style: {}, appendChild() {} }, hidden: false,
    getElementById(id) { return id === 'game' ? canvas : null; }, createElement(type) { if (type === 'canvas') return makeCanvas(); return { style: {} }; }
  });
  const storage = {
    getItem(key) { if (storageMode === 'disabled') throw new Error('SecurityError: localStorage disabled'); return stored.get(key) ?? null; },
    setItem(key, value) { if (storageMode === 'disabled' || storageMode === 'write-disabled') throw new Error('QuotaExceededError'); stored.set(key, String(value)); },
    removeItem(key) { stored.delete(key); }
  };
  const math = Object.create(Math); math.random = typeof random === 'function' ? random : () => random;
  const window = Object.assign(eventTarget(), { GAME: { ...config, rules: { ...config.rules, ...rules }, assets: {} },
    parent: { postMessage(message) { messages.push(message); } }
  });
  const sandbox = { window, document, localStorage: storage, innerWidth: 480, innerHeight: 900, devicePixelRatio: 1,
    console, Math: math, Image: class { set src(value) { this._src = value; if (this.onload) this.onload(); } },
    performance: { now: () => now }, requestAnimationFrame(fn) { const id = nextId++; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); }
  };
  window.localStorage = storage; window.requestAnimationFrame = sandbox.requestAnimationFrame;
  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename: path.join(root, 'game.js') }).runInContext(context, { timeout: 5000 });
  function step(dt = 1 / 60) {
    now += dt * 1000;
    const pending = [...frames.values()]; frames.clear();
    assert.ok(pending.length > 0, 'game scheduled its next animation frame');
    for (const fn of pending) fn(now);
    return state();
  }
  function advance(seconds, { onFrame = null, autopilot = false } = {}) {
    const count = Math.ceil(seconds * 60);
    for (let i = 0; i < count; i++) {
      if (autopilot && i % 6 === 0) window.__autoplay(state());
      const s = step(); if (onFrame) onFrame(s, i);
    }
    return state();
  }
  function state() { return JSON.parse(JSON.stringify(window.__gameState())); }
  function key(key, extras = {}) { document.dispatch('keydown', { key, ...extras }); }
  function keyup(key) { document.dispatch('keyup', { key }); }
  function pointer(type, pointerId, x, y) { canvas.dispatch(type, { pointerId, pointerType: 'touch', clientX: x, clientY: y }); }
  function profile() { return JSON.parse(stored.get('thunder-overload-save-v1') || 'null'); }
  return { state, step, advance, key, keyup, pointer, document, window, messages, profile };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const approx = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} ~= ${b}`);

test('title -> Enter starts the real round', () => {
  const r = runtime(); assert.equal(r.state().phase, 'title'); r.step();
  r.key('Enter'); const s = r.state();
  assert.equal(s.phase, 'playing'); assert.equal(s.elapsed, 0); assert.equal(s.score, 0);
  assert.equal(s.level, config.rules.startingLevel); assert.equal(s.hearts, config.rules.hearts);
  assert.equal(s.skillUses, 0); assert.equal(s.charge, 100);
  assert.ok(r.advance(0.5).elapsed > 0.4);
});

test('P pauses/resumes and blur/hidden pause and clear held controls', () => {
  const r = runtime({ rules: { enemySpawnEvery: 1000, bossEvery: 1000 } }); r.key('Enter'); r.advance(0.5);
  r.key('ArrowRight'); r.advance(0.1); r.keyup('ArrowRight');
  r.key('p'); let s = r.state(), elapsed = s.elapsed, x = s.hero.x;
  assert.equal(s.paused, true); r.advance(1); approx(r.state().elapsed, elapsed); approx(r.state().hero.x, x);
  r.key('p', { repeat: true }); assert.equal(r.state().paused, true, 'repeat does not unpause');
  r.key('p'); assert.equal(r.state().paused, false); assert.ok(r.advance(0.5).elapsed > elapsed + 0.4);
  r.key('ArrowLeft'); r.window.dispatch('blur'); s = r.state(); elapsed = s.elapsed; x = s.hero.x;
  assert.equal(s.paused, true); r.advance(1); approx(r.state().elapsed, elapsed);
  r.key('p'); r.advance(0.5); approx(r.state().hero.x, x);
  r.document.hidden = true; r.document.dispatch('visibilitychange'); assert.equal(r.state().paused, true);
});

test('first touch keeps drag ownership while second touch triggers thunder', () => {
  const r = runtime(); r.key('Enter');
  r.pointer('pointerdown', 11, 240, 702); r.pointer('pointermove', 11, 300, 662); r.advance(0.3);
  let s = r.state(); approx(s.hero.x, 309); approx(s.hero.y, 656);
  r.pointer('pointerdown', 22, 416, 846); assert.equal(r.state().skillUses, 1);
  r.pointer('pointermove', 22, 40, 400); r.pointer('pointerup', 22, 40, 400); r.advance(0.1);
  approx(r.state().hero.x, 309); approx(r.state().hero.y, 656);
  r.pointer('pointermove', 11, 330, 622); r.advance(0.3);
  approx(r.state().hero.x, 343.5); approx(r.state().hero.y, 610);
  r.pointer('pointercancel', 11, 330, 622); s = r.state(); r.pointer('pointermove', 11, 100, 200); r.advance(0.2);
  approx(r.state().hero.x, s.hero.x); approx(r.state().hero.y, s.hero.y);
});

test('corrupt or unavailable localStorage never prevents startup and live play', () => {
  const conditions = [{ save: '{not json' }, { save: 'null' }, { save: { best: 'bad', bank: 'bad' } }, { storageMode: 'disabled' }, { storageMode: 'write-disabled' }];
  for (const condition of conditions) {
    const r = runtime({ ...condition, rules: { enemySpawnEvery: 1000, bossEvery: 1000 } });
    assert.equal(r.state().phase, 'title'); r.key('Enter'); r.advance(6);
    assert.equal(r.state().phase, 'playing'); assert.ok(Number.isFinite(r.state().damage));
    if (condition.storageMode) assert.equal(r.state().storageOK, false, 'failed autosave is reported');
    assert.equal(r.messages.filter(m => m.type === 'error').length, 0);
  }
});

test('real collision death and real guarded restart reset round but preserve bank/core', () => {
  const r = runtime({ save: { bank: 625, best: 12345, muted: false }, rules: { hearts: 1, enemyDamage: 30, hitInvulnerability: 0.1, enemyHealth: 400, enemySpawnEvery: 0.12, bossEvery: 1000 } });
  r.key('Enter'); const initialCore = r.state().core; assert.equal(initialCore, 5);
  r.key('ArrowUp'); r.advance(1.5); r.keyup('ArrowUp');
  let death = null;
  for (let frame = 0; frame < 1800 && !death; frame++) { const s = r.step(); if (s.phase === 'lost') death = s; }
  assert.ok(death, 'real enemy/bullet collision caused death'); assert.equal(death.hearts, 0);
  assert.ok(death.elapsed > 0); assert.ok(death.kills > 0, 'earned bank comes from real kills');
  console.log(`  real death elapsed=${death.elapsed.toFixed(2)} kills=${death.kills} earned=${death.earned}`);
  const saved = r.profile(); assert.ok(saved.bank >= 625 + death.earned); assert.ok(saved.best >= 12345);
  r.key('Enter'); assert.equal(r.state().phase, 'lost', 'death input guard prevents instant accidental restart');
  r.advance(1.1); r.key('Enter'); const fresh = r.state();
  assert.equal(fresh.phase, 'playing'); assert.equal(fresh.elapsed, 0); assert.equal(fresh.score, 0);
  assert.equal(fresh.kills, 0); assert.equal(fresh.earned, 0); assert.equal(fresh.bossCount, 0); assert.equal(fresh.bossKills, 0);
  assert.equal(fresh.level, config.rules.startingLevel); assert.equal(fresh.xp, 0); assert.equal(fresh.skillUses, 0);
  assert.equal(fresh.core, Math.floor(Math.sqrt(saved.bank / 25))); assert.ok(fresh.core >= initialCore);
  assert.ok(fresh.hearts > 0); assert.equal(fresh.charge, 100);
  for (const count of Object.values(fresh.counts)) assert.equal(count, 0);
  approx(fresh.hero.x, 240); approx(fresh.hero.y, 702); assert.equal(r.profile().bank, saved.bank);
});

test('damage still grows after main-cannon spread and fire-rate caps', () => {
  function sample(startingLevel) {
    const r = runtime({ rules: { startingLevel, enemyHealth: 1e12, enemySpawnEvery: 1000, bossEvery: 1000 } });
    r.key('Enter'); r.step(); return r.state();
  }
  const low = sample(100), high = sample(1000);
  assert.equal(low.counts.playerBullets, 13, '9 capped main + 2 drone + 2 missiles on first frame');
  assert.equal(high.counts.playerBullets, 13, 'higher level adds damage, not unbounded first-volley entity count');
  assert.ok(high.damage > low.damage * 8, `damage ${low.damage} -> ${high.damage}`);
});

test('accelerated boss entrance ignores real thunder and bullet damage until vulnerability threshold', () => {
  const r = runtime({ rules: { startingLevel: 1000, bossEvery: 3, bossHealth: 100000, enemySpawnEvery: 1000, enemyDamage: 0 } });
  r.key('Enter'); while (r.state().bossCount < 1) r.step();
  const hp = r.state().boss.hp; r.key(' '); assert.equal(r.state().skillUses, 1);
  assert.equal(r.state().boss.hp, hp, 'thunder cannot skip boss entrance');
  r.advance(2.8, { onFrame(s) { assert.ok(s.boss, 'boss alive while entering'); assert.equal(s.boss.hp, hp, 'entering boss invulnerable to all real weapons'); } });
  r.advance(0.7); assert.ok(!r.state().boss || r.state().boss.hp < hp, 'boss becomes damageable after entry');
});

test('accelerated real combat repeatedly spawns at least all three boss kinds', () => {
  const r = runtime({ rules: { startingLevel: 1000, bossEvery: 3, bossHealth: 1, enemySpawnEvery: 1000, enemyDamage: 0 } });
  r.key('Enter'); const types = [], counted = new Set();
  r.advance(35, { onFrame(s) { if (s.boss && !counted.has(s.bossCount)) { counted.add(s.bossCount); types.push(s.boss.type); } } });
  assert.ok(r.state().bossKills >= 3, `boss kills: ${r.state().bossKills}`);
  assert.deepEqual(types.slice(0, 4), [0, 1, 2, 0]);
  console.log(`  observed boss types ${types.join(' -> ')}, kills=${r.state().bossKills}`);
});

test('entity budgets hold during stress including full enemy roster at boss spawn', () => {
  const rules = { startingLevel: 1000, bossEvery: 3, bossHealth: 1e12, enemyHealth: 1e12, enemySpawnEvery: 0.12,
    maxEnemies: 1, maxPlayerBullets: 20, maxEnemyBullets: 10, maxParticles: 5, maxPickups: 1, enemyDamage: 0 };
  const r = runtime({ rules }); r.key('Enter'); let peak = { enemies: 0, playerBullets: 0, enemyBullets: 0, particles: 0, pickups: 0 };
  r.advance(18, { onFrame(s) {
    for (const key of ['enemies', 'playerBullets', 'enemyBullets', 'particles']) peak[key] = Math.max(peak[key], s.counts[key]);
    peak.pickups = Math.max(peak.pickups, s.pickups.length);
  } });
  console.log(`  configured=${JSON.stringify(rules)} observedPeaks=${JSON.stringify(peak)}`);
  assert.ok(peak.playerBullets <= rules.maxPlayerBullets, 'player bullet budget');
  assert.ok(peak.enemyBullets <= rules.maxEnemyBullets, 'enemy bullet budget');
  assert.ok(peak.particles <= rules.maxParticles, 'particle budget');
  assert.ok(peak.pickups <= rules.maxPickups, 'pickup budget');
  assert.ok(peak.enemies <= rules.maxEnemies, `enemy budget exceeded: ${peak.enemies} > ${rules.maxEnemies}`);
});

test('small pickup and particle budgets preserve real kill rewards under heavy farming', () => {
  const rules = { startingLevel: 1000, bossEvery: 1000, enemyHealth: 1, enemySpawnEvery: 0.12,
    maxEnemies: 4, maxPlayerBullets: 20, maxEnemyBullets: 10, maxParticles: 3, maxPickups: 1, enemyDamage: 0 };
  const r = runtime({ rules }); r.key('Enter'); let pickupPeak = 0, particlePeak = 0;
  r.advance(20, { onFrame(s) {
    pickupPeak = Math.max(pickupPeak, s.pickups.length); particlePeak = Math.max(particlePeak, s.counts.particles);
    assert.ok(s.pickups.length <= 1); assert.ok(s.counts.particles <= 3);
    assert.ok(s.counts.enemies <= 4); assert.ok(s.counts.playerBullets <= 20); assert.ok(s.counts.enemyBullets <= 10);
  } });
  const s = r.state(); assert.ok(s.kills > 10, 'many real kills exercise drop overflow fallback');
  assert.equal(pickupPeak, 1); assert.equal(particlePeak, 3); assert.ok(s.earned >= s.kills); assert.ok(Number.isFinite(s.xp));
  console.log(`  farming kills=${s.kills} earned=${s.earned} pickupPeak=${pickupPeak} particlePeak=${particlePeak}`);
});

// Wave regressions use only public state and ordinary input/rule overrides.
// Expected curves are the fixed spawn-wave contract, not current player level.
// Early-pressure update: expectedWave below now multiplies the approved power
// curve; no original assertion was weakened and all17 pass at production defaults.
// No first-fire override is needed: coverage checks real reset spacing and actual
// collision geometry, not the former randomized initial fire delay. Elite gate
// isolation already sets growth/curve0, leaving power active; Lv1000 still achieves
// real kills in that finite test. The independent balancing suite uses NO overrides.
// Historical pre-early-pressure observed run:17/17 PASS(original10 + new7), game.js
// SHA256 3e13152f3f71bbeb9d995a9cdfb006451e01755ce7f0e29915130c620e32881b.
// Same type2 wave1->3: HP x2.58, speed104->118.56, fire1->1.2, bullet1->1.16;
// oldest wave1 snapshot preserved151 frames. Wave1 projectile at current wave9
// still105 speed /0.1 damage. Actual collision geometry matched127 life deductions.
// First boss at spawnWave4->7: HP27.25M->58M and damage0.01->0.02.
// At wave23: actual speed228.8, projectile236.25, normal fire-reset1s,
// observed spawn interval0.150s (60Hz quantization of0.14s floor), damage cap0.04.
// Elite totals below are observations across frames, not unique spawn counts or
// measured probability; fixed RNG0.31 crosses the threshold, RNG0.32 never does.
function expectedWave(w, rules = {}) {
  const p = { ...config.rules, ...rules }, n = Math.max(0, w - 1);
  return { health: (1 + p.waveHealthGrowth * n + p.waveHealthCurve * n * n) * Math.pow(p.waveHealthPower ?? 1, Math.min(n, 200)),
    bossHealth: (1 + p.waveBossHealthGrowth * n + p.waveBossHealthCurve * n * n) * Math.pow(p.waveBossHealthPower ?? 1, Math.min(n, 200)),
    move: Math.min(2.2, 1 + p.waveMoveGrowth * n), bullet: Math.min(2.25, 1 + p.waveBulletGrowth * n),
    fire: Math.min(2.5, 1 + p.waveFireGrowth * n), spawnEvery: Math.max(0.14, p.enemySpawnEvery / (1 + p.waveSpawnGrowth * n)),
    eliteChance: Math.min(0.32, 0.08 + p.waveEliteGrowth * n), damage: p.enemyDamage * Math.min(4, 1 + Math.floor(n / p.waveDamageEvery)) };
}
function ordinarySnapshot(e) {
  return { type: e.type, elite: e.elite, maxHp: e.maxHp, speed: e.speed, fireRate: e.fireRate, bulletScale: e.bulletScale, damage: e.damage, spawnWave: e.spawnWave };
}

test('fixed waves follow elapsed play time, ignore level, freeze on pause and reset after real death', () => {
  const rules = { waveEvery: 2, enemyHealth: 1e12, enemyDamage: 0, bossEvery: 1000 };
  const low = runtime({ rules }), high = runtime({ rules: { ...rules, startingLevel: 1000 } });
  low.key('Enter'); high.key('Enter');
  low.advance(4.5); high.advance(4.5);
  assert.equal(low.state().wave, 3); assert.equal(high.state().wave, 3);
  assert.equal(low.state().level, 1); assert.equal(high.state().level, 1000);
  assert.deepEqual(low.state().pressure, high.state().pressure, 'same time has same pressure despite player level');
  const elapsed = low.state().elapsed; low.key('p'); low.advance(5);
  approx(low.state().elapsed, elapsed); assert.equal(low.state().wave, 3);
  low.key('p'); assert.equal(low.advance(1.6).wave, 4);
  const death = runtime({ rules: { waveEvery: 1, enemyDamage: 30, hearts: 1, enemyHealth: 400, enemySpawnEvery: 0.12, bossEvery: 1000, hitInvulnerability: 0.1 } });
  death.key('Enter'); death.key('ArrowUp'); death.advance(1.5); death.keyup('ArrowUp');
  for (let i = 0; i < 1200 && death.state().phase !== 'lost'; i++) death.step();
  assert.equal(death.state().phase, 'lost'); assert.ok(death.state().wave >= 2);
  const deathWave = death.state().wave; death.advance(1.1); assert.equal(death.state().wave, deathWave);
  death.key('Enter'); assert.equal(death.state().wave, 1); assert.equal(death.state().elapsed, 0);
  assert.deepEqual(death.state().pressure, expectedWave(1, { enemyDamage: 30, enemySpawnEvery: 0.12 }));
  console.log(`  waves level1/1000=3/3, pause freezes; death wave=${deathWave}, restart wave=1`);
});

test('real type2 ordinary enemies scale at spawn and old enemies retain their property snapshot', () => {
  const rules = { waveEvery: 1, enemyHealth: 1e12, enemyDamage: 0, bossEvery: 1000, enemySpawnEvery: 0.4 };
  const r = runtime({ rules }); r.key('Enter'); const first = new Map(); let tracked = null, preserved = 0;
  r.advance(3.5, { onFrame(s) {
    for (const e of s.enemies.filter(e => !e.boss && !e.elite)) {
      assert.equal(e.type, 2, 'constant random=0.5 selects the same real type');
      const p = expectedWave(e.spawnWave, rules);
      approx(e.maxHp, rules.enemyHealth * p.health, 0.01); approx(e.speed, 104 * p.move);
      approx(e.fireRate, p.fire); approx(e.bulletScale, p.bullet); approx(e.damage, p.damage);
      if (!first.has(e.spawnWave)) first.set(e.spawnWave, ordinarySnapshot(e));
    }
    const oldest = s.enemies.filter(e => !e.boss && e.spawnWave === 1).sort((a, b) => b.y - a.y)[0];
    if (!tracked && oldest) tracked = ordinarySnapshot(oldest);
    if (tracked && oldest && s.wave > 1) { assert.deepEqual(ordinarySnapshot(oldest), tracked); preserved++; }
  } });
  assert.ok(first.has(1) && first.has(3), 'actual spawns from waves1 and3 were both observed');
  const a = first.get(1), b = first.get(3);
  for (const k of ['maxHp', 'speed', 'fireRate', 'bulletScale']) assert.ok(b[k] > a[k], `${k} grows on later same-type spawn`);
  assert.ok(preserved > 60, 'same oldest wave1 enemy remained stable across multiple later waves');
  console.log(`  type2 wave1=${JSON.stringify(a)} wave3=${JSON.stringify(b)} preservedFrames=${preserved}`);
});

test('real enemy projectiles use source spawn-wave speed and damage, not the current wave', () => {
  const rules = { waveEvery: 1, enemyHealth: 1e12, enemyDamage: 0.1, waveDamageEvery: 1, bossEvery: 1000, hearts: 12 };
  const r = runtime({ rules }); r.key('Enter'); r.key('ArrowRight'); r.advance(0.6); r.keyup('ArrowRight');
  let delayed = null, older = null; const sourceWaves = new Set();
  r.advance(9, { onFrame(s) {
    for (const b of s.hostile) {
      const p = expectedWave(b.spawnWave, rules); sourceWaves.add(b.spawnWave);
      approx(Math.hypot(b.vx, b.vy), 105 * p.bullet); approx(b.damage, p.damage);
      if (s.wave >= b.spawnWave + 2 && !delayed) delayed = { wave: s.wave, sourceWave: b.spawnWave, speed: Math.hypot(b.vx, b.vy), damage: b.damage };
      if (s.wave >= 6 && b.spawnWave === 1) older = { wave: s.wave, speed: Math.hypot(b.vx, b.vy), damage: b.damage };
    }
  } });
  assert.ok(sourceWaves.size >= 3, 'at least three real source waves fired'); assert.ok(delayed && older, 'old-wave projectiles survive several current-wave transitions');
  assert.notEqual(delayed.damage, expectedWave(delayed.wave, rules).damage, 'old projectile damage is not recomputed from current wave');
  approx(older.speed, 105); approx(older.damage, 0.1);
  console.log(`  delayedSource=${JSON.stringify(delayed)} wave1ProjectileStillAt=${JSON.stringify(older)}`);
});

test('waveEvery1 actual high-wave projectile and body collisions deduct their source damage', () => {
  // Fast capped bullets and slower bodies create distinct, observable collision windows.
  const rules = { waveEvery: 1, waveDamageEvery: 1, waveBulletGrowth: 10, waveMoveGrowth: 0, enemyHealth: 1e12, enemyDamage: 0.01, hearts: 12, hitInvulnerability: 0.1, bossEvery: 1000, enemySpawnEvery: 0.25 };
  const r = runtime({ rules }); r.key('Enter'); const events = [];
  for (let i = 0; i < 1200 && r.state().phase === 'playing'; i++) {
    const before = r.state(), after = r.step(), deducted = before.hearts - after.hearts;
    if (deducted <= 1e-8) continue;
    // Static hero at x240/y702, deterministic type2; inspect the next actual collision geometry.
    const body = before.enemies.find(e => !e.boss && Math.hypot(e.x - before.hero.x, e.y + e.speed / 60 - before.hero.y) < (e.elite ? 34 : 27));
    const bullet = before.hostile.find(b => Math.hypot(b.x + b.vx / 60 - before.hero.x, b.y + b.vy / 60 - before.hero.y) < 11);
    const source = body || bullet; assert.ok(source, 'each observed life decrement has a real next-frame collision source');
    approx(deducted, Math.min(before.hearts, source.damage));
    approx(source.damage, expectedWave(source.spawnWave, rules).damage);
    events.push({ kind: body ? 'body' : 'bullet', currentWave: after.wave, spawnWave: source.spawnWave, deducted });
  }
  const bullet = events.find(e => e.kind === 'bullet' && e.spawnWave >= 3), body = events.find(e => e.kind === 'body' && e.spawnWave >= 3);
  assert.ok(bullet, 'real bullet collision from an enhanced spawn wave reduced life');
  assert.ok(body, 'real body collision from an enhanced spawn wave reduced life');
  assert.ok(events.some(e => e.spawnWave < e.currentWave), 'life deductions include an old source in a newer current wave');
  console.log(`  matchedCollisionCount=${events.length} enhancedBullet=${JSON.stringify(bullet)} enhancedBody=${JSON.stringify(body)}`);
});

test('same first boss grows by spawn wave, retains its attributes and entrance immunity', () => {
  function sample(bossEvery) {
    const rules = { waveEvery: 1, bossEvery, bossHealth: 1e7, enemyHealth: 1e12, enemySpawnEvery: 1000, enemyDamage: 0.01, startingLevel: 1000 };
    const r = runtime({ rules }); r.key('Enter'); while (!r.state().boss) r.step();
    const first = r.state().boss, p = expectedWave(first.spawnWave, rules);
    assert.equal(r.state().bossCount, 1); approx(first.maxHp, rules.bossHealth * p.bossHealth, 0.01);
    approx(first.fireRate, p.fire); approx(first.bulletScale, p.bullet); approx(first.damage, p.damage);
    r.key(' '); assert.equal(r.state().boss.hp, first.hp);
    r.advance(2.8, { onFrame(s) { assert.ok(s.boss); assert.equal(s.boss.hp, first.hp); const { hp, ...snapshot } = s.boss; const { hp: initialHp, ...initial } = first; assert.deepEqual(snapshot, initial); } });
    r.advance(0.7); assert.ok(r.state().boss && r.state().boss.hp < first.hp, 'real weapons damage boss after entrance');
    return first;
  }
  const early = sample(3), late = sample(6); assert.ok(late.spawnWave > early.spawnWave);
  for (const k of ['maxHp', 'fireRate', 'bulletScale', 'damage']) assert.ok(late[k] > early[k], `${k} grows at identical bossCount=1`);
  console.log(`  firstBossEarly=${JSON.stringify(early)} firstBossLate=${JSON.stringify(late)}`);
});

test('real elite spawns respect kill gating, growing threshold and strict capped chance', () => {
  const common = { waveEvery: 1, bossEvery: 1000, enemyDamage: 0, enemySpawnEvery: 0.12, waveHealthGrowth: 0, waveHealthCurve: 0 };
  const gated = runtime({ random: 0.31, rules: { ...common, enemyHealth: 1e12 } }); gated.key('Enter');
  gated.advance(12, { onFrame(s) { assert.equal(s.kills, 0); assert.ok(s.enemies.every(e => !e.elite), 'no elites before kill13 despite threshold growth'); } });
  function farm(random) {
    const r = runtime({ random, rules: { ...common, enemyHealth: 1, startingLevel: 1000 } }); r.key('Enter'); let eligibleNormal = 0, elites = 0, cappedFrames = 0;
    r.advance(13, { onFrame(s) { if (s.pressure.eliteChance === 0.32) cappedFrames++;
      for (const e of s.enemies.filter(e => !e.boss && e.y < 0)) {
        const p = expectedWave(e.spawnWave, common);
        if (e.elite) { elites++; assert.ok(s.kills > 12); assert.ok(random < p.eliteChance); }
        if (s.kills > 12 && p.eliteChance <= random) { assert.equal(e.elite, false); eligibleNormal++; }
      }
    } });
    assert.ok(r.state().kills > 12 && cappedFrames > 0); return { eligibleNormal, elites, kills: r.state().kills };
  }
  const below = farm(0.31), boundary = farm(0.32);
  assert.ok(below.eligibleNormal > 0 && below.elites > 0, 'same RNG becomes elite only when spawn threshold exceeds0.31');
  assert.equal(boundary.elites, 0, 'random exactly0.32 never passes the capped strict-less-than chance');
  console.log(`  RNG0.31=${JSON.stringify(below)} RNG0.32=${JSON.stringify(boundary)}`);
});

test('actual high-wave spawn density, movement, fire, projectile and damage multipliers remain bounded', () => {
  const rules = { waveEvery: 1, enemyHealth: 1e12, enemyDamage: 0.01, hearts: 12, bossEvery: 1000, enemySpawnEvery: 0.42 };
  const r = runtime({ rules }); r.key('Enter'); const spawns = [], bulletSpeeds = []; let cappedEnemies = 0, firingReset = false, previous = null;
  r.advance(22, { onFrame(s) {
    const expected = expectedWave(s.wave, rules); assert.deepEqual(s.pressure, expected);
    assert.ok(s.pressure.move <= 2.2 && s.pressure.bullet <= 2.25 && s.pressure.fire <= 2.5 && s.pressure.spawnEvery >= 0.14 && s.pressure.eliteChance <= 0.32 && s.pressure.damage <= rules.enemyDamage * 4);
    for (const e of s.enemies.filter(e => !e.boss)) {
      assert.equal(e.type, 2); assert.ok(e.speed <= 104 * 2.2 + 1e-8); assert.ok(e.fireRate <= 2.5 && e.bulletScale <= 2.25);
      if (Math.abs(e.y - (-45 + e.speed / 60)) < 1e-6) spawns.push({ elapsed: s.elapsed, wave: e.spawnWave });
      assert.ok(e.damage <= rules.enemyDamage * 4);
      if (e.spawnWave >= 19) { cappedEnemies++; approx(e.speed, 104 * 2.2); approx(e.fireRate, 2.5); approx(e.bulletScale, 2.25); approx(e.damage, rules.enemyDamage * 4); }
      if (previous && e.spawnWave >= 19) {
        const old = previous.enemies.find(p => p.spawnWave === e.spawnWave && Math.abs(p.y + p.speed / 60 - e.y) < 1e-6);
        if (old && e.fire > old.fire + 0.1) { approx(e.fire, 1); firingReset = true; }
      }
    }
    for (const b of s.hostile) { const speed = Math.hypot(b.vx, b.vy); assert.ok(speed <= 105 * 2.25 + 1e-8); assert.ok(b.damage <= rules.enemyDamage * 4); if (b.spawnWave >= 19) { bulletSpeeds.push(speed); approx(b.damage, rules.enemyDamage * 4); } }
    previous = s;
  } });
  const intervals = spawns.slice(1).map((s, i) => ({ dt: s.elapsed - spawns[i].elapsed, wave: s.wave }));
  const early = intervals.filter(i => i.wave === 1), capped = intervals.filter(i => i.wave >= 20);
  assert.ok(early.length > 0 && capped.length >= 8 && cappedEnemies > 0 && bulletSpeeds.length > 0 && firingReset);
  early.forEach(i => assert.ok(i.dt >= 0.42 - 1e-8 && i.dt <= 0.42 + 1 / 60 + 1e-8));
  capped.forEach(i => assert.ok(i.dt >= 0.14 - 1e-8 && i.dt <= 0.14 + 1 / 60 + 1e-8));
  bulletSpeeds.forEach(v => approx(v, 105 * 2.25));
  assert.ok(capped[0].dt < early[0].dt); assert.ok(r.state().pressure.health > expectedWave(19, rules).health, 'HP growth continues after pacing caps');
  console.log(`  wave=${r.state().wave} pressure=${JSON.stringify(r.state().pressure)} earlySpawnDt=${early[0].dt.toFixed(3)} cappedSpawnDt=${capped[0].dt.toFixed(3)} cappedSpeed=${(104 * 2.2).toFixed(1)} actualBulletSpeed=${bulletSpeeds[0].toFixed(2)}`);
});

console.log(`Actual game.js SHA256: ${crypto.createHash('sha256').update(source).digest('hex')}`);
console.log(`Actual game.json SHA256: ${crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex')}`);
let failures = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
}
console.log(`\n${tests.length - failures}/${tests.length} passed; ${failures} failed.`);
console.log('Simulation limits: 480x900 DPR=1, deterministic random=0.5, synchronous 60Hz RAF; Canvas draw calls are no-op; no real browser, pointer capture dispatch, audio, storage permissions, FPS/GPU, visuals or mobile OS tested. Rule overrides accelerate/force actual combat; no private variables injected and no game source edited.');
process.exitCode = failures ? 1 : 0;
FinalSourceCheck: {
  const latest = fs.readFileSync(path.join(root, 'game.js'), 'utf8');
  if (latest !== source) console.warn('WARNING: game.js changed during this test run; rerun against latest source.');
}
