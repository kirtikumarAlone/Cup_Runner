import * as THREE from 'three';

/* =========================================================
   CONSTANTS
   ========================================================= */
const LANES      = [-2.6, 0, 2.6];
const GRAVITY    = 42;
const JUMP_V     = [13.2, 11.6];      // 1st + 2nd jump
const MAX_JUMPS  = 2;
const BASE_SPEED = 20;
const MAX_SPEED  = 46;
const SPAWN_Z    = -135;
const DESPAWN_Z  = 14;

/* =========================================================
   RENDERER / SCENE / CAMERA
   ========================================================= */
const app = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias:true, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffe6c4);
scene.fog = new THREE.Fog(0xffe6c4, 55, 150);

const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 400);
camera.position.set(0, 5.4, 9.5);
camera.lookAt(0, 1.6, -8);

/* ---------- lights ---------- */
scene.add(new THREE.HemisphereLight(0xfff3e0, 0xd9b48f, 0.85));

const sun = new THREE.DirectionalLight(0xfff1d8, 2.1);
sun.position.set(-9, 16, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 60;
sun.shadow.camera.left = -16;
sun.shadow.camera.right = 16;
sun.shadow.camera.top = 18;
sun.shadow.camera.bottom = -10;
sun.shadow.bias = -0.0012;
scene.add(sun);
scene.add(sun.target);

const rim = new THREE.DirectionalLight(0xffd9a8, 0.5);
rim.position.set(8, 6, -12);
scene.add(rim);

/* =========================================================
   AUDIO (procedural, no files)
   ========================================================= */
const sfx = {
  ac:null, muted:false,
  ensure(){
    if(!this.ac){
      const AC = window.AudioContext || window.webkitAudioContext;
      if(AC) this.ac = new AC();
    }
    if(this.ac && this.ac.state === 'suspended') this.ac.resume();
    return this.ac;
  },
  tone(f0, f1, dur, type, vol){
    if(this.muted) return;
    const ac = this.ensure(); if(!ac) return;
    const t = ac.currentTime;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(Math.max(1, f0), t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(ac.destination);
    o.start(t); o.stop(t + dur + 0.03);
  },
  jump(n){ this.tone(n === 1 ? 320 : 420, n === 1 ? 680 : 820, 0.16, 'square', 0.07); },
  land(){ this.tone(150, 80, 0.09, 'sine', 0.08); },
  coin(){ this.tone(880, 1560, 0.10, 'sine', 0.09); },
  lane(){ this.tone(500, 620, 0.06, 'triangle', 0.045); },
  hit(){ this.tone(240, 40, 0.55, 'sawtooth', 0.13); }
};

/* =========================================================
   GAME STATE
   ========================================================= */
let best = 0;
try { best = Number(localStorage.getItem('teaRide3d.best')) || 0; } catch(e){ best = 0; }

const G = {
  state:'menu',            // menu | playing | paused | dead
  time:0, speed:BASE_SPEED, dist:0, coins:0, score:0,
  sinceSpawn:0, nextGap:16,
  lane:1, targetLane:1,
  shake:0, deadAt:-10, started:false
};

const P = {
  group:null, vy:0, jumps:0, onGround:true,
  squash:1, legPhase:0, leanZ:0
};

let obstacles = [];   // {mesh, type, w, h, d}
let coins     = [];   // {mesh, phase}
let particles = [];   // {mesh, vx, vy, vz, life, max}

/* =========================================================
   HELPERS
   ========================================================= */
const rnd   = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const pick  = a => a[Math.floor(Math.random() * a.length)];

function mat(color, opts = {}){
  return new THREE.MeshStandardMaterial({
    color, roughness: opts.rough ?? 0.65, metalness: opts.metal ?? 0.0,
    flatShading: !!opts.flat, transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1, emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1
  });
}

/* =========================================================
   WORLD
   ========================================================= */
const worldGroup = new THREE.Group();
scene.add(worldGroup);

/* ---------- tabletop ---------- */
const tableTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#f6e6cf'; x.fillRect(0, 0, 256, 256);
  const S = 32;
  for(let r = 0; r < 8; r++){
    for(let col = 0; col < 8; col++){
      if((r + col) & 1){
        x.fillStyle = '#efd8bc';
        x.fillRect(col * S, r * S, S, S);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 30);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
})();

const table = new THREE.Mesh(
  new THREE.PlaneGeometry(60, 340),
  new THREE.MeshStandardMaterial({ map: tableTex, roughness: 0.9, metalness: 0 })
);
table.rotation.x = -Math.PI / 2;
table.position.set(0, 0, -140);
table.receiveShadow = true;
worldGroup.add(table);

/* ---------- lane divider dashes ---------- */
const dashMat = mat(0xe7cbaa, { rough: 0.95 });
const dashGeo = new THREE.PlaneGeometry(0.12, 2.0);
const dashes = [];
for(const lx of [-1.3, 1.3]){
  for(let i = 0; i < 70; i++){
    const m = new THREE.Mesh(dashGeo, dashMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(lx, 0.012, -i * 5);
    worldGroup.add(m);
    dashes.push(m);
  }
}

/* ---------- roadside props (sugar cubes far off) ---------- */
const propGroup = new THREE.Group();
worldGroup.add(propGroup);
const propMat = mat(0xfffaf0, { rough: 0.8 });
const propGeo = new THREE.BoxGeometry(1, 1, 1);
const props = [];
for(let i = 0; i < 40; i++){
  const side = Math.random() < 0.5 ? -1 : 1;
  const m = new THREE.Mesh(propGeo, propMat);
  const s = rnd(0.7, 1.8);
  m.scale.setScalar(s);
  m.position.set(side * rnd(5.5, 12), s / 2, -i * 4 - rnd(0, 4));
  m.rotation.y = rnd(0, Math.PI);
  m.castShadow = false; m.receiveShadow = true;
  propGroup.add(m);
  props.push(m);
}

/* =========================================================
   PLAYER — teacup
   ========================================================= */
function buildCup(){
  const g = new THREE.Group();

  const cupMat = mat(0xfffdf8, { rough: 0.35 });
  const teaMat = mat(0xc0763a, { rough: 0.25 });
  const dark   = mat(0x46301f, { rough: 0.5 });

  /* body: lathe profile */
  const pts = [];
  pts.push(new THREE.Vector2(0.00, 0.00));
  pts.push(new THREE.Vector2(0.46, 0.00));
  pts.push(new THREE.Vector2(0.50, 0.10));
  pts.push(new THREE.Vector2(0.62, 0.62));
  pts.push(new THREE.Vector2(0.66, 0.98));
  pts.push(new THREE.Vector2(0.63, 1.02));
  pts.push(new THREE.Vector2(0.58, 0.96));
  pts.push(new THREE.Vector2(0.56, 0.62));
  pts.push(new THREE.Vector2(0.42, 0.14));
  pts.push(new THREE.Vector2(0.00, 0.14));
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 28), cupMat);
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);

  /* tea surface */
  const tea = new THREE.Mesh(new THREE.CircleGeometry(0.575, 28), teaMat);
  tea.rotation.x = -Math.PI / 2;
  tea.position.y = 0.9;
  g.add(tea);

  /* handle */
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.075, 10, 20, Math.PI * 1.15), cupMat);
  handle.position.set(0.66, 0.6, 0);
  handle.rotation.z = -Math.PI * 0.42;
  handle.castShadow = true;
  g.add(handle);

  /* eyes */
  for(const s of [-1, 1]){
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.062, 10, 8), dark);
    e.position.set(s * 0.20, 0.62, 0.60);
    g.add(e);
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), mat(0xffffff, { rough: 0.2 }));
    hl.position.set(s * 0.20 - 0.02, 0.65, 0.655);
    g.add(hl);
  }

  /* smile */
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.10, 0.018, 8, 14, Math.PI), dark);
  smile.position.set(0, 0.50, 0.605);
  smile.rotation.z = Math.PI;
  g.add(smile);

  /* cheeks */
  for(const s of [-1, 1]){
    const c = new THREE.Mesh(new THREE.CircleGeometry(0.075, 12),
      new THREE.MeshBasicMaterial({ color: 0xffb0a0, transparent: true, opacity: 0.5 }));
    c.position.set(s * 0.34, 0.48, 0.545);
    g.add(c);
  }

  /* legs */
  const legs = [];
  for(const s of [-1, 1]){
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.22, 0.14, 0);
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.24, 4, 8), mat(0xb0855c, { rough: 0.7 }));
    leg.position.y = -0.16;
    leg.castShadow = true;
    pivot.add(leg);
    const shoe = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), mat(0x8b5e34, { rough: 0.6 }));
    shoe.scale.set(1, 0.7, 1.35);
    shoe.position.set(0, -0.32, 0.05);
    shoe.castShadow = true;
    pivot.add(shoe);
    g.add(pivot);
    legs.push(pivot);
  }

  g.userData.legs = legs;
  g.userData.tea = tea;
  return g;
}

P.group = buildCup();
P.group.position.set(0, 0, 0);
scene.add(P.group);

/* =========================================================
   OBSTACLE / COIN FACTORIES
   ========================================================= */
const sugarMat   = mat(0xfffdf6, { rough: 0.55 });
const biscuitMat = mat(0xe0a95f, { rough: 0.8 });
const chipMat    = mat(0x8a5a2b, { rough: 0.8 });
const metalMat   = mat(0xd3dae2, { rough: 0.28, metal: 0.85 });
const leafMat    = mat(0x5fbf7d, { rough: 0.45, emissive: 0x1d5c34, emissiveIntensity: 0.35 });

const OBSTACLE_DEFS = [
  { type:'sugar',   w:1.1, h:1.1, d:1.1, weight:4 },
  { type:'sugar2',  w:2.0, h:1.1, d:1.1, weight:2 },
  { type:'biscuit', w:1.5, h:0.55, d:1.5, weight:3 },
  { type:'spoon',   w:0.7, h:2.0, d:0.7, weight:2 }
];

function buildSugar(w, h, d){
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), sugarMat);
  m.position.y = h / 2;
  m.castShadow = true; m.receiveShadow = true;
  g.add(m);
  /* seam line */
  const seam = new THREE.Mesh(new THREE.BoxGeometry(w * 1.002, 0.03, d * 1.002),
    mat(0xeadbc6, { rough: 0.9 }));
  seam.position.y = h * 0.52;
  g.add(seam);
  return g;
}

function buildBiscuit(w, h, d){
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, h, 20), biscuitMat);
  base.position.y = h / 2;
  base.castShadow = true; base.receiveShadow = true;
  g.add(base);
  for(let i = 0; i < 6; i++){
    const a = (i / 6) * Math.PI * 2;
    const chip = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), chipMat);
    chip.position.set(Math.cos(a) * w * 0.24, h + 0.01, Math.sin(a) * w * 0.24);
    chip.scale.y = 0.5;
    g.add(chip);
  }
  return g;
}

function buildSpoon(w, h, d){
  const g = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.055, h * 0.72, 10), metalMat);
  handle.position.y = h * 0.36;
  handle.castShadow = true;
  g.add(handle);
  const bowl = new THREE.Mesh(new THREE.SphereGeometry(w * 0.52, 16, 12), metalMat);
  bowl.scale.set(1, 0.42, 1.25);
  bowl.position.y = h * 0.80;
  bowl.castShadow = true;
  g.add(bowl);
  return g;
}

function spawnObstacle(){
  const def = (() => {
    const total = OBSTACLE_DEFS.reduce((s, d) => s + d.weight, 0);
    let r = Math.random() * total;
    for(const d of OBSTACLE_DEFS){ if((r -= d.weight) <= 0) return d; }
    return OBSTACLE_DEFS[0];
  })();

  const lane = Math.floor(Math.random() * 3);
  let mesh;
  if(def.type === 'sugar')       mesh = buildSugar(def.w, def.h, def.d);
  else if(def.type === 'sugar2') mesh = buildSugar(def.w, def.h, def.d);
  else if(def.type === 'biscuit')mesh = buildBiscuit(def.w, def.h, def.d);
  else                           mesh = buildSpoon(def.w, def.h, def.d);

  mesh.position.set(LANES[lane], 0, SPAWN_Z);
  scene.add(mesh);
  obstacles.push({ mesh, type:def.type, w:def.w, h:def.h, d:def.d, lane });

  /* sometimes a leaf arc over the obstacle */
  if(Math.random() < 0.55){
    const n = 4;
    for(let i = 0; i < n; i++){
      const t = i / (n - 1);
      spawnCoin(LANES[lane], def.h + 1.5 + Math.sin(t * Math.PI) * 1.7, SPAWN_Z + 2 + t * 7, 0.9);
    }
  }
}

function spawnCoin(x, y, z, scale = 1){
  const g = new THREE.Group();

  const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), leafMat);
  leaf.scale.set(0.55, 1.25, 0.28);
  leaf.castShadow = true;
  g.add(leaf);

  const vein = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.5, 0.02),
    mat(0xdff5e4, { rough: 0.4, emissive: 0x2f7a4a, emissiveIntensity: 0.4 }));
  g.add(vein);

  g.scale.setScalar(scale);
  g.position.set(x, y, z);
  scene.add(g);
  coins.push({ mesh:g, phase:rnd(0, Math.PI * 2), baseY:y });
}

/* =========================================================
   PARTICLES
   ========================================================= */
const partGeo = new THREE.SphereGeometry(0.07, 6, 5);

function emit(x, y, z, n, colors, spd, size, life){
  for(let i = 0; i < n; i++){
    const m = new THREE.Mesh(partGeo, new THREE.MeshBasicMaterial({
      color: pick(colors), transparent: true, opacity: 1
    }));
    m.position.set(x, y, z);
    m.scale.setScalar(rnd(size * 0.5, size));
    scene.add(m);
    const a = rnd(0, Math.PI * 2), e = rnd(-0.4, 1.0), s = rnd(spd * 0.4, spd);
    particles.push({
      mesh:m,
      vx: Math.cos(a) * s * 0.6,
      vy: e * s,
      vz: Math.sin(a) * s * 0.6,
      life, max:life
    });
  }
}
const dustP = (x, y, z, n) => emit(x, y, z, n, [0xd8bd9c, 0xe6d2b8, 0xc9a884], 2.6, 1, 0.5);
const sparkP = (x, y, z) => emit(x, y, z, 12, [0xffe9a8, 0xffffff, 0x8fd3a8], 4.2, 0.9, 0.45);
const burstP = (x, y, z) => emit(x, y, z, 26, [0xffffff, 0xffe9c9, 0x8fd3a8, 0xd9b48f], 6, 1.4, 0.9);

/* =========================================================
   FLOW
   ========================================================= */
const overlay = document.getElementById('overlay');
const elTitle = document.getElementById('title');
const elSub   = document.getElementById('sub');
const elBig   = document.getElementById('big');
const elCta   = document.getElementById('cta');
const elNew   = document.getElementById('newbest');
const elScore = document.getElementById('score');
const elCoins = document.getElementById('coins');
const elBest  = document.getElementById('best');
const elFps   = document.getElementById('fps');

function resetRun(){
  for(const o of obstacles) scene.remove(o.mesh);
  for(const c of coins)     scene.remove(c.mesh);
  for(const p of particles) scene.remove(p.mesh);
  obstacles = []; coins = []; particles = [];

  G.dist = 0; G.coins = 0; G.score = 0;
  G.speed = BASE_SPEED;
  G.sinceSpawn = 0; G.nextGap = 16;
  G.lane = 1; G.targetLane = 1;
  G.shake = 0;

  P.vy = 0; P.jumps = 0; P.onGround = true; P.squash = 1; P.leanZ = 0;
  P.group.position.set(0, 0, 0);
  P.group.rotation.set(0, 0, 0);

  G.state = 'playing';
  overlay.classList.add('hide');
}

function die(){
  if(G.state !== 'playing') return;
  G.state = 'dead';
  G.deadAt = G.time;
  G.shake = 0.45;
  burstP(P.group.position.x, 0.8, 0);
  sfx.hit();

  G.score = Math.floor(G.dist) + G.coins * 10;
  const isNew = G.score > best;
  if(isNew){
    best = G.score;
    try { localStorage.setItem('teaRide3d.best', String(best)); } catch(e){}
  }

  elTitle.textContent = 'SPILLED!';
  elSub.textContent = 'the tea has left the cup';
  elBig.textContent = String(G.score);
  elNew.textContent = isNew && G.score > 0 ? 'NEW BEST!' : 'BEST ' + String(best).padStart(5, '0');
  elCta.textContent = 'SPACE / TAP TO RIDE AGAIN';
  overlay.classList.remove('hide');
}

function showMenu(){
  G.state = 'menu';
  elTitle.textContent = 'THE TEA RIDE';
  elSub.textContent = 'an endless cup of chaos';
  elBig.textContent = '';
  elNew.textContent = '';
  elCta.textContent = 'PRESS SPACE / TAP TO RIDE';
  overlay.classList.remove('hide');
}

function jump(){
  if(G.state !== 'playing' || P.jumps >= MAX_JUMPS) return;
  const i = P.jumps;
  P.vy = JUMP_V[Math.min(i, JUMP_V.length - 1)];
  P.jumps = i + 1;
  P.onGround = false;
  P.squash = 1.16;
  dustP(P.group.position.x, 0.05, 0, 6);
  sfx.jump(i + 1);
}

function moveLane(dir){
  if(G.state !== 'playing') return;
  const next = clamp(G.targetLane + dir, 0, 2);
  if(next !== G.targetLane){ G.targetLane = next; sfx.lane(); }
}

function handlePrimary(){
  sfx.ensure();
  if(G.state === 'menu'){ resetRun(); return; }
  if(G.state === 'dead'){
    if(G.time - G.deadAt > 0.55) resetRun();
    return;
  }
  if(G.state === 'paused'){ G.state = 'playing'; return; }
  jump();
}

/* =========================================================
   UPDATE
   ========================================================= */
function update(dt){
  G.speed = Math.min(MAX_SPEED, BASE_SPEED + G.dist * 0.055);
  const dz = G.speed * dt;
  G.dist += dz;

  /* ---- player ---- */
  /* lane lerp */
  const tx = LANES[G.targetLane];
  const px = P.group.position.x;
  const nx = px + (tx - px) * Math.min(1, dt * 12);
  P.group.position.x = nx;
  P.leanZ += ((-(tx - nx) * 0.22) - P.leanZ) * Math.min(1, dt * 10);

  /* jump physics */
  P.vy -= GRAVITY * dt;
  P.group.position.y += P.vy * dt;

  if(P.group.position.y <= 0){
    if(!P.onGround){
      P.squash = 0.78;
      dustP(P.group.position.x, 0.05, 0, 7);
      sfx.land();
    }
    P.group.position.y = 0;
    P.vy = 0;
    P.jumps = 0;
    P.onGround = true;
  } else {
    P.onGround = false;
  }

  /* squash/stretch + run cycle */
  P.squash += (1 - P.squash) * Math.min(1, dt * 12);
  const sy = P.squash, sxz = 1 + (1 - sy) * 0.55;
  P.group.scale.set(sxz, sy, sxz);
  P.group.rotation.z = P.leanZ;

  P.legPhase += dt * (P.onGround ? G.speed * 0.75 : 4);
  const legs = P.group.userData.legs;
  if(legs){
    for(let i = 0; i < 2; i++){
      const sw = P.onGround ? Math.sin(P.legPhase + i * Math.PI) : (i === 0 ? 0.9 : -0.9);
      legs[i].rotation.x = sw * 0.85;
    }
  }
  /* tea slosh */
  const tea = P.group.userData.tea;
  if(tea){
    tea.position.y = 0.9 + Math.sin(G.time * 7) * 0.012 + clamp(-P.vy * 0.004, -0.05, 0.05);
    tea.rotation.z = Math.sin(G.time * 5) * 0.05;
  }

  /* ---- spawn ---- */
  G.sinceSpawn += dz;
  if(G.sinceSpawn >= G.nextGap){
    G.sinceSpawn = 0;
    spawnObstacle();
    G.nextGap = rnd(14, 24) + G.speed * 0.22;
  }

  /* ---- obstacles ---- */
  const pz = 0;
  for(let i = obstacles.length - 1; i >= 0; i--){
    const o = obstacles[i];
    o.mesh.position.z += dz;
    if(o.mesh.position.z > DESPAWN_Z){
      scene.remove(o.mesh);
      obstacles.splice(i, 1);
      continue;
    }
    /* collision (generous hitbox) */
    const dx = Math.abs(o.mesh.position.x - P.group.position.x);
    const dzc = Math.abs(o.mesh.position.z - pz);
    const py = P.group.position.y;
    if(dx < (o.w * 0.5 + 0.34) && dzc < (o.d * 0.5 + 0.34) && py < o.h - 0.12){
      die();
      return;
    }
  }

  /* ---- coins ---- */
  for(let i = coins.length - 1; i >= 0; i--){
    const c = coins[i];
    c.mesh.position.z += dz;
    c.phase += dt * 3.4;
    c.mesh.rotation.y = c.phase;
    c.mesh.position.y = c.baseY + Math.sin(c.phase * 1.6) * 0.12;

    if(c.mesh.position.z > DESPAWN_Z){
      scene.remove(c.mesh);
      coins.splice(i, 1);
      continue;
    }
    const dx = Math.abs(c.mesh.position.x - P.group.position.x);
    const dzc = Math.abs(c.mesh.position.z - pz);
    const dy = Math.abs((P.group.position.y + 0.75) - c.mesh.position.y);
    if(dx < 0.85 && dzc < 0.85 && dy < 1.15){
      scene.remove(c.mesh);
      coins.splice(i, 1);
      G.coins++;
      sparkP(c.mesh.position.x, c.mesh.position.y, 0);
      sfx.coin();
    }
  }

  /* ---- world scroll ---- */
  tableTex.offset.y -= dz * 0.02;
  for(const d of dashes){
    d.position.z += dz;
    if(d.position.z > 12) d.position.z -= 70 * 5;
  }
  for(const p of props){
    p.position.z += dz;
    p.rotation.y += dt * 0.25;
    if(p.position.z > 14){
      p.position.z -= 40 * 4;
      const side = Math.random() < 0.5 ? -1 : 1;
      p.position.x = side * rnd(5.5, 12);
    }
  }

  /* ---- particles ---- */
  updateParticles(dt, dz);

  /* ---- camera ---- */
  camFollow(dt, dz);

  /* ---- hud ---- */
  G.score = Math.floor(G.dist) + G.coins * 10;
  elScore.textContent = String(G.score).padStart(5, '0');
  elCoins.textContent = '🍃 ' + G.coins;
}

function updateParticles(dt, dz){
  for(let i = particles.length - 1; i >= 0; i--){
    const p = particles[i];
    p.life -= dt;
    if(p.life <= 0){
      scene.remove(p.mesh);
      p.mesh.material.dispose();
      particles.splice(i, 1);
      continue;
    }
    p.vy -= 12 * dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt + dz * 0.6;
    p.mesh.material.opacity = Math.max(0, p.life / p.max);
    if(p.mesh.position.y < 0.03){
      p.mesh.position.y = 0.03;
      p.vy *= -0.35;
      p.vx *= 0.7; p.vz *= 0.7;
    }
  }
}

function camFollow(dt, dz){
  /* smooth follow of lane + speed-based pullback */
  const targetX = P.group.position.x * 0.45;
  const pull = (G.speed - BASE_SPEED) * 0.035;
  camera.position.x += (targetX - camera.position.x) * Math.min(1, dt * 3.2);
  camera.position.y += ((5.4 + pull * 0.4) - camera.position.y) * Math.min(1, dt * 2.5);
  camera.position.z += ((9.5 + pull) - camera.position.z) * Math.min(1, dt * 2.5);

  if(G.shake > 0){
    G.shake -= dt;
    const m = G.shake * 0.9;
    camera.position.x += rnd(-m, m);
    camera.position.y += rnd(-m, m);
  }

  const lookX = P.group.position.x * 0.30;
  camera.lookAt(lookX, 1.5, -9);
  sun.position.x = -9 + P.group.position.x * 0.4;
  sun.target.position.set(P.group.position.x * 0.4, 0, -6);
  sun.target.updateMatrixWorld();
}

/* idle (menu/dead/paused) */
function idle(dt, dz){
  if(G.state === 'menu'){
    P.legPhase += dt * 7;
    const legs = P.group.userData.legs;
    if(legs) for(let i = 0; i < 2; i++) legs[i].rotation.x = Math.sin(P.legPhase + i * Math.PI) * 0.7;
    P.group.position.y = Math.abs(Math.sin(P.legPhase * 0.5)) * 0.06;
    tableTex.offset.y -= 2.2 * dt * 0.02;
    for(const d of dashes){ d.position.z += 2.2 * dt; if(d.position.z > 12) d.position.z -= 350; }
    camFollow(dt, 0);
  } else if(G.state === 'dead'){
    /* cup tips over */
    P.group.rotation.z += (1.35 - P.group.rotation.z) * Math.min(1, dt * 5);
    P.group.position.y += (0 - P.group.position.y) * Math.min(1, dt * 5);
    camFollow(dt, 0);
  }

  updateParticles(dt, 0);
}

/* =========================================================
   LOOP
   ========================================================= */
const STEP = 1 / 120;
let last = performance.now();
let acc = 0;
let fpsAcc = 0, fpsFrames = 0;

function frame(now){
  let dt = (now - last) / 1000;
  last = now;
  if(dt > 0.05) dt = 0.05;
  G.time += dt;

  fpsAcc += dt; fpsFrames++;
  if(fpsAcc > 0.5){
    elFps.textContent = Math.round(fpsFrames / fpsAcc) + ' FPS';
    fpsAcc = 0; fpsFrames = 0;
  }

  if(G.state === 'playing'){
    acc += dt;
    let guard = 0;
    while(acc >= STEP && guard++ < 8){
      update(STEP);
      acc -= STEP;
      if(G.state !== 'playing'){ acc = 0; break; }
    }
  } else {
    acc = 0;
    idle(dt, 0);
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/* =========================================================
   INPUT
   ========================================================= */
window.addEventListener('keydown', e => {
  const c = e.code;
  if(c === 'Space' || c === 'ArrowUp' || c === 'KeyW' || c === 'Enter'){
    e.preventDefault();
    if(e.repeat) return;
    handlePrimary();
  } else if(c === 'ArrowLeft' || c === 'KeyA'){
    e.preventDefault(); moveLane(-1);
  } else if(c === 'ArrowRight' || c === 'KeyD'){
    e.preventDefault(); moveLane(1);
  } else if(c === 'KeyP'){
    if(G.state === 'playing') G.state = 'paused';
    else if(G.state === 'paused') G.state = 'playing';
  } else if(c === 'KeyM'){
    sfx.muted = !sfx.muted;
  } else if(c === 'KeyR'){
    if(G.state === 'dead' || G.state === 'playing') resetRun();
  }
}, { passive:false });

/* pointer / touch: tap = jump, swipe = lane */
let touchX = 0, touchY = 0, touchT = 0, moved = false;
const el = renderer.domElement;

el.addEventListener('pointerdown', e => {
  touchX = e.clientX; touchY = e.clientY; touchT = performance.now(); moved = false;
});
el.addEventListener('pointermove', e => {
  if(moved) return;
  const dx = e.clientX - touchX, dy = e.clientY - touchY;
  if(Math.abs(dx) > 34 && Math.abs(dx) > Math.abs(dy)){
    moveLane(dx > 0 ? 1 : -1);
    moved = true;
    touchX = e.clientX;
  }
});
el.addEventListener('pointerup', e => {
  const dt = performance.now() - touchT;
  const dx = e.clientX - touchX, dy = e.clientY - touchY;
  if(!moved && dt < 400 && Math.abs(dx) < 30 && Math.abs(dy) < 30){
    handlePrimary();
  }
});

/* =========================================================
   RESIZE
   ========================================================= */
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* =========================================================
   GO
   ========================================================= */
showMenu();
requestAnimationFrame(frame);