import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ===========================================================================
// Renderer / scene / camera
// ===========================================================================
const canvas = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // cap: 2x on retina doubles bloom+fill cost
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x120c20);
scene.fog = new THREE.Fog(0x120c20, 22, 60);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);

// Locked follow camera — fixed direction from the hero, no orbit. Zoom scales
// the whole offset, so the viewing angle is unchanged as you push in or out.
const FACE_Y = 0.5;                                  // resting facing for seated agents
const CAM_OFFSET = new THREE.Vector3(8, 12, 12);
const camDesired = new THREE.Vector3();
const ZOOM_KEY = 'dungeon.zoom';
const ZOOM_MIN = 0.4, ZOOM_MAX = 2.0;
const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
let camZoom = (() => {
  try { return clampZoom(parseFloat(localStorage.getItem(ZOOM_KEY)) || 1); } catch { return 1; }
})();
function setZoom(z) {
  camZoom = clampZoom(z);
  try { localStorage.setItem(ZOOM_KEY, String(camZoom)); } catch {}
}

// ===========================================================================
// Lighting
// ===========================================================================
scene.add(new THREE.HemisphereLight(0x8a6bff, 0x120c20, 0.6));
scene.add(new THREE.AmbientLight(0x6a6a90, 0.75));
const key = new THREE.DirectionalLight(0xffe8c0, 0.95);
key.position.set(20, 34, 16);
key.castShadow = true;
key.shadow.mapSize.set(512, 512); // smaller map for the larger 12-room dungeon; shadows stay readable at this camera distance
// A 12-room map is far wider than one shadow frustum can cover sharply, so the
// shadow box tracks the hero (see updateCamera) and stays small.
const SHADOW_HALF = 24;
Object.assign(key.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF });
key.target = new THREE.Object3D();
scene.add(key.target);
key.shadow.bias = -0.0002;
scene.add(key);
const rim = new THREE.DirectionalLight(0x4a7bff, 0.45);
rim.position.set(-18, 12, -16);
scene.add(rim);

// ===========================================================================
// Per-piece color tints
// ===========================================================================
const TINTS = {
  floor: 0x8891b5, 'floor-detail': 0x9aa0c0, dirt: 0x7a6a52,
  wall: 0x6b6f9a, 'wall-half': 0x6b6f9a, 'wall-narrow': 0x6b6f9a, 'wall-opening': 0x6b6f9a,
  column: 0xb9c0e6, chest: 0xffcf6e, barrel: 0xc98a5a, table: 0xc98a5a, chair: 0xc98a5a,
  banner: 0xff5d73, pot: 0x6ad0c0, rocks: 0x9098b0, stones: 0x9098b0,
  gate: 0x8a8fb8, stairs: 0x8891b5, trap: 0xff7a5c,
};
const EMISSIVE = {
  chest: { color: 0xffa000, intensity: 0.15 }, banner: { color: 0xff2a44, intensity: 0.12 },
  pot: { color: 0x18d6c0, intensity: 0.15 }, trap: { color: 0xff3d1a, intensity: 0.2 },
};

// ===========================================================================
// Asset loading
// ===========================================================================
// Every Kenney glTF in public/models references an external
// `Textures/colormap.png` that this repo does not ship — the look here comes
// from the per-piece TINTS below instead. Left alone, that is 30 failed
// requests and a console full of loader errors on every single page load.
// Resolving it to a 1x1 white pixel hands the loader exactly the neutral base
// colour it was already falling back to, so nothing renders differently.
const WHITE_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
const loadingManager = new THREE.LoadingManager();
loadingManager.setURLModifier((url) => (url.includes('Textures/colormap.png') ? WHITE_PIXEL : url));

const loader = new GLTFLoader(loadingManager);
const cache = new Map();
function load(name) {
  if (!cache.has(name)) cache.set(name, loader.loadAsync(`/models/${name}.glb`));
  return cache.get(name);
}
function applyLook(material, name) {
  const tint = TINTS[name], glow = EMISSIVE[name];
  if (tint) material.color = new THREE.Color(tint);
  if (glow) { material.emissive = new THREE.Color(glow.color); material.emissiveIntensity = glow.intensity; }
  return material;
}
async function piece(name) {
  const gltf = await load(name);
  const obj = skeletonClone(gltf.scene);
  obj.traverse((n) => {
    if (!n.isMesh) return;
    n.castShadow = true; n.receiveShadow = true;
    n.material = applyLook(n.material.clone(), name);
  });
  return obj;
}

// The static layer is the same handful of models repeated thousands of times.
// One InstancedMesh per (model, sub-mesh) keeps a 12-room dungeon at a few
// dozen draw calls instead of a few thousand.
const _im = new THREE.Matrix4(), _iq = new THREE.Quaternion(), _iv = new THREE.Vector3(), _ie = new THREE.Euler();
async function addInstanced(name, places, cast = true) {
  if (!places.length) return;
  const gltf = await load(name);
  gltf.scene.updateWorldMatrix(true, true);
  const protos = [];
  gltf.scene.traverse((n) => { if (n.isMesh) protos.push(n); });
  for (const pm of protos) {
    const inst = new THREE.InstancedMesh(pm.geometry, applyLook(pm.material.clone(), name), places.length);
    inst.castShadow = cast; inst.receiveShadow = true;
    inst.frustumCulled = false;   // bounds come from one tile, not the spread
    for (let i = 0; i < places.length; i++) {
      const pl = places[i];
      _ie.set(0, pl.rot || 0, 0);
      _im.compose(pl.pos, _iq.setFromEuler(_ie), _iv.setScalar(pl.scale || 1));
      _im.multiply(pm.matrixWorld);
      inst.setMatrixAt(i, _im);
    }
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
  }
}

// ===========================================================================
// Deterministic RNG
// Layouts vary by seed but stay stable across refreshes — rooms are bound to
// folders in localStorage, so a reshuffle on every reload would be wrong.
// Force a fresh layout with ?seed=123 (or ?seed=0 for the reference layout).
// ===========================================================================
function mulberry32(a) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED_KEY = 'dungeon.seed';
const SEED = (() => {
  const q = new URLSearchParams(location.search).get('seed');
  if (q != null) { const n = (parseInt(q, 10) || 0) >>> 0; try { localStorage.setItem(SEED_KEY, String(n)); } catch {} return n; }
  try { const s = localStorage.getItem(SEED_KEY); if (s != null) return (parseInt(s, 10) || 0) >>> 0; } catch {}
  const n = (Math.random() * 4294967296) >>> 0;
  try { localStorage.setItem(SEED_KEY, String(n)); } catch {}
  return n;
})();
const rnd = mulberry32(SEED);
const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const rpick = (arr) => arr[Math.floor(rnd() * arr.length)];
const rjit = (m) => (rnd() * 2 - 1) * m;
const rchance = (p) => rnd() < p;
function rtake(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, Math.min(n, a.length));
}

// ===========================================================================
// Props
// Collision radius is per-prop (in tiles), not a boolean. Small dressing —
// coins, banners, shields, weapons — has radius 0, so decorating a room never
// costs the agents standing room.
// ===========================================================================
const PROP_RADIUS = {
  column: 0.40, table: 0.40, stairs: 0.44, 'wood-structure': 0.36, chest: 0.34,
  barrel: 0.30, rocks: 0.30, stones: 0.24, pot: 0.22, chair: 0.22, 'wood-support': 0.20,
  // radius 0 (walk-through dressing): banner, gate, trap, coin, key, potion,
  // floor-detail, weapon-*, shield-*
};
const radiusOf = (name) => PROP_RADIUS[name] || 0;

// ===========================================================================
// Room archetypes
// Each room is a place with a job, not a bag of props. `focal` is the work
// anchor agents walk to; `accent` is the room's single torch colour, which is
// the only wayfinding cue a locked follow-camera leaves you.
// ===========================================================================
const ARCHETYPES = [
  { key: 'vault', label: 'Vault', accent: 0xffd24a, pillars: 'corners',
    focal: { work: 'chest', side: 'stairs' },
    wall: ['chest', 'barrel', 'chest', 'barrel', 'wood-support'], wallN: [4, 6],
    scatter: ['coin', 'coin', 'coin', 'key', 'floor-detail'], scatterN: [5, 8],
    rest: 'barrel' },
  { key: 'forge', label: 'Forge', accent: 0xff7b2e, pillars: 'colonnade',
    focal: { work: 'table', side: 'chair' },
    wall: ['barrel', 'wood-structure', 'wood-support', 'weapon-spear', 'barrel'], wallN: [4, 6],
    scatter: ['weapon-sword', 'stones', 'floor-detail', 'coin'], scatterN: [4, 7],
    rest: 'barrel' },
  { key: 'scriptorium', label: 'Scriptorium', accent: 0x4ad6ff, pillars: 'none',
    focal: { work: 'table', side: 'chair' },
    wall: ['banner', 'pot', 'banner', 'barrel', 'pot'], wallN: [4, 6],
    scatter: ['potion', 'coin', 'floor-detail', 'floor-detail'], scatterN: [4, 6],
    rest: 'pot' },
  { key: 'armory', label: 'Armory', accent: 0xb84dff, pillars: 'corners',
    focal: { work: 'table', side: 'chair' },
    wall: ['shield-round', 'shield-rectangle', 'weapon-spear', 'weapon-sword', 'barrel', 'wood-support'], wallN: [5, 7],
    scatter: ['floor-detail', 'stones', 'coin'], scatterN: [3, 5],
    rest: 'barrel' },
  { key: 'ruin', label: 'Ruin', accent: 0x4dff9e, pillars: 'broken',
    focal: { work: 'rocks', side: 'stones' },
    wall: ['rocks', 'stones', 'wood-support', 'stones', 'rocks'], wallN: [5, 7],
    scatter: ['stones', 'rocks', 'floor-detail', 'trap', 'coin'], scatterN: [5, 8],
    rest: 'rocks' },
  { key: 'alchemy', label: 'Alchemy', accent: 0xff5d9e, pillars: 'colonnade',
    focal: { work: 'table', side: 'pot' },
    wall: ['pot', 'barrel', 'pot', 'barrel', 'wood-structure'], wallN: [4, 6],
    scatter: ['potion', 'potion', 'coin', 'floor-detail'], scatterN: [5, 7],
    rest: 'pot' },
  { key: 'archive', label: 'Archive', accent: 0x5a8cff, pillars: 'aisle',
    focal: { work: 'table', side: 'chair' },
    wall: ['wood-structure', 'barrel', 'wood-structure', 'banner', 'barrel'], wallN: [5, 7],
    scatter: ['floor-detail', 'coin', 'key', 'floor-detail'], scatterN: [4, 6],
    rest: 'barrel' },
  { key: 'barracks', label: 'Barracks', accent: 0xa8bcd8, pillars: 'shored',
    focal: { work: 'table', side: 'chair' },
    wall: ['shield-rectangle', 'barrel', 'weapon-spear', 'shield-round', 'barrel', 'chest'], wallN: [5, 7],
    scatter: ['coin', 'floor-detail', 'stones', 'weapon-sword'], scatterN: [4, 6],
    rest: 'barrel' },
  { key: 'reliquary', label: 'Reliquary', accent: 0xf2f0ff, pillars: 'dais',
    focal: { work: 'chest', side: 'pot' },
    wall: ['banner', 'pot', 'banner', 'chest', 'pot'], wallN: [4, 6],
    scatter: ['coin', 'potion', 'key', 'coin'], scatterN: [5, 8],
    rest: 'pot' },
  { key: 'cistern', label: 'Cistern', accent: 0x2fd6c8, pillars: 'aisle',
    focal: { work: 'pot', side: 'barrel' },
    wall: ['pot', 'rocks', 'pot', 'wood-support', 'barrel'], wallN: [5, 7],
    scatter: ['potion', 'floor-detail', 'stones', 'floor-detail'], scatterN: [5, 8],
    rest: 'pot' },
  { key: 'quarry', label: 'Quarry', accent: 0xd08a3c, pillars: 'shored',
    focal: { work: 'rocks', side: 'wood-structure' },
    wall: ['rocks', 'wood-structure', 'stones', 'wood-support', 'rocks', 'barrel'], wallN: [6, 8],
    scatter: ['stones', 'rocks', 'trap', 'coin', 'floor-detail'], scatterN: [6, 9],
    rest: 'rocks' },
  { key: 'shrine', label: 'Shrine', accent: 0xff4d5e, pillars: 'dais',
    focal: { work: 'table', side: 'banner' },
    wall: ['banner', 'column', 'pot', 'banner', 'chest'], wallN: [4, 6],
    scatter: ['potion', 'coin', 'floor-detail', 'key'], scatterN: [4, 7],
    rest: 'pot' },
];
const CORRIDOR_ACCENT = 0x9d8ad6;

// ===========================================================================
// Procedural 12-room dungeon
// Connections are listed first and doors are derived from that list, so the
// door lanes a room reserves can never disagree with the corridors actually
// carved. Vertical links include one seeded interior column per row gap, which
// gives the map loops instead of a single spine.
// ===========================================================================
const ROOMS = [];
const DECOR = [];        // { gx, gy, name, soft, ox, oz, rot, scale }
const TORCH_SPEC = [];   // { gx, gy, color }
const ANCHOR_SPEC = [];  // { room, kind, gx, gy, ox, oz }
const WALLVAR = new Map(); // "x,y" -> wall model name

const ROOM_W = 9, ROOM_H = 7, COLS = 4, ROWS = 3;

function generateGrid() {
  const GAP = 3, MARGIN = 1;
  const W = MARGIN * 2 + COLS * ROOM_W + (COLS - 1) * GAP;
  const H = MARGIN * 2 + ROWS * ROOM_H + (ROWS - 1) * GAP;
  const g = Array.from({ length: H }, () => Array(W).fill(' '));
  const ox = (j) => MARGIN + j * (ROOM_W + GAP);
  const oy = (i) => MARGIN + i * (ROOM_H + GAP);
  const set = (x, y, ch) => { if (y >= 0 && y < H && x >= 0 && x < W) g[y][x] = ch; };

  for (let i = 0; i < ROWS; i++)
    for (let j = 0; j < COLS; j++)
      for (let y = oy(i); y < oy(i) + ROOM_H; y++)
        for (let x = ox(j); x < ox(j) + ROOM_W; x++) set(x, y, '.');

  // ---- Connection graph ----
  const links = [];
  for (let i = 0; i < ROWS; i++)
    for (let j = 0; j < COLS - 1; j++) links.push({ i, j, dir: 'h' });
  for (let i = 0; i < ROWS - 1; i++) {
    const cols = new Set([0, COLS - 1, rint(1, COLS - 2)]);
    for (const j of cols) links.push({ i, j, dir: 'v' });
  }

  const doorsOf = Array.from({ length: ROWS * COLS }, () => new Set());
  for (const l of links) {
    if (l.dir === 'h') { doorsOf[l.i * COLS + l.j].add('E'); doorsOf[l.i * COLS + l.j + 1].add('W'); }
    else { doorsOf[l.i * COLS + l.j].add('S'); doorsOf[(l.i + 1) * COLS + l.j].add('N'); }
  }

  const corridors = [];
  for (const l of links) {
    const run = [];
    if (l.dir === 'h') {
      const y = oy(l.i) + 3;
      for (let x = ox(l.j) + ROOM_W; x < ox(l.j + 1); x++) { set(x, y, 'd'); run.push([x, y]); }
      corridors.push({ cells: run, axis: 'h' });
    } else {
      const x = ox(l.j) + 4;
      for (let y = oy(l.i) + ROOM_H; y < oy(l.i + 1); y++) { set(x, y, 'd'); run.push([x, y]); }
      corridors.push({ cells: run, axis: 'v' });
    }
  }

  for (let i = 0; i < ROWS; i++)
    for (let j = 0; j < COLS; j++) {
      const idx = i * COLS + j;
      ROOMS.push({ index: idx, cx: ox(j) + 4, cy: oy(i) + 3, arch: ARCHETYPES[idx], doors: doorsOf[idx] });
      dressRoom(ox(j), oy(i), idx, doorsOf[idx], g);
    }

  for (const c of corridors) dressCorridor(c, g);

  const walkable = (x, y) => y >= 0 && y < H && x >= 0 && x < W && g[y][x] !== ' ' && g[y][x] !== '#';
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (g[y][x] === ' ' && (walkable(x + 1, y) || walkable(x - 1, y) || walkable(x, y + 1) || walkable(x, y - 1) ||
          walkable(x + 1, y + 1) || walkable(x - 1, y - 1) || walkable(x + 1, y - 1) || walkable(x - 1, y + 1)))
        g[y][x] = '#';

  // Break the identical-room silhouette: one side of each room gets a low or
  // narrow wall run, so no two rooms read the same from the follow camera.
  for (let i = 0; i < ROWS; i++)
    for (let j = 0; j < COLS; j++) {
      const bx = ox(j), by = oy(i);
      const variant = rpick(['wall-half', 'wall-half', 'wall-narrow']);
      const side = rpick(['N', 'S', 'W', 'E']);
      const cells = side === 'N' ? [[bx + 3, by - 1], [bx + 4, by - 1], [bx + 5, by - 1]]
        : side === 'S' ? [[bx + 3, by + ROOM_H], [bx + 4, by + ROOM_H], [bx + 5, by + ROOM_H]]
        : side === 'W' ? [[bx - 1, by + 2], [bx - 1, by + 3], [bx - 1, by + 4]]
        : [[bx + ROOM_W, by + 2], [bx + ROOM_W, by + 3], [bx + ROOM_W, by + 4]];
      for (const [x, y] of cells) if (g[y]?.[x] === '#') WALLVAR.set(x + ',' + y, variant);
    }

  return g.map((r) => r.join(''));
}

// ---- Set dressing -------------------------------------------------------
// Props hug walls, sit off tile-centre, and face inward. Nothing lands in the
// 3x3 core or in a door lane, so agents always have somewhere to be.
function dressRoom(bx, by, idx, doors, g) {
  const A = ARCHETYPES[idx];
  const taken = new Set();
  const keyOf = (dx, dy) => dx + ',' + dy;
  const reserve = (dx, dy) => taken.add(keyOf(dx, dy));

  for (let dx = 3; dx <= 5; dx++) for (let dy = 2; dy <= 4; dy++) reserve(dx, dy); // agent core
  if (doors.has('E')) for (const dx of [6, 7, 8]) reserve(dx, 3);
  if (doors.has('W')) for (const dx of [0, 1, 2]) reserve(dx, 3);
  if (doors.has('N')) for (const dy of [0, 1, 2]) reserve(4, dy);
  if (doors.has('S')) for (const dy of [4, 5, 6]) reserve(4, dy);

  const add = (dx, dy, name, o = {}) => {
    DECOR.push({ gx: bx + dx, gy: by + dy, name, soft: !!o.soft,
      ox: o.ox || 0, oz: o.oz || 0, rot: o.rot != null ? o.rot : rnd() * Math.PI * 2, scale: o.scale || 1 });
  };
  // Offset a wall-ring prop toward the wall it belongs against, facing in.
  const wallPose = (dx, dy) => {
    let ox = 0, oz = 0;
    if (dx === 1) ox = -0.30; else if (dx === 7) ox = 0.30;
    if (dy === 1) oz = -0.30; else if (dy === 5) oz = 0.30;
    const jx = ox !== 0 ? 0 : rjit(0.18), jz = oz !== 0 ? 0 : rjit(0.18);
    return { ox: ox + jx, oz: oz + jz, rot: Math.atan2(-ox, -oz) + rjit(0.22) };
  };

  // ---- Structure -------------------------------------------------------
  // The one thing that changes a room's floorplan rather than its contents.
  // Everything here is guarded against `taken`, so a structural piece can
  // never seal a doorway or squat in the agent core.
  const corners = [[1, 1], [7, 1], [1, 5], [7, 5]];
  const tryAdd = (dx, dy, name, o) => {
    if (taken.has(keyOf(dx, dy))) return false;
    add(dx, dy, name, o); reserve(dx, dy); return true;
  };
  // A wall with no corridor through it — where a dais or altar can go.
  const freeSide = (cands) => cands.find((sd) => !doors.has(sd)) || null;

  if (A.pillars === 'corners') {
    for (const [dx, dy] of corners) tryAdd(dx, dy, 'column', { rot: 0 });
  } else if (A.pillars === 'colonnade') {
    const row = rpick([1, 5]), other = row === 1 ? 5 : 1;
    for (const dx of [2, 6]) tryAdd(dx, row, 'column', { rot: 0 });
    for (const dx of [2, 6]) tryAdd(dx, other, 'wood-support', wallPose(dx, other));
  } else if (A.pillars === 'aisle') {
    // Four inner columns framing the core — a nave you walk down.
    for (const [dx, dy] of [[2, 2], [2, 4], [6, 2], [6, 4]]) tryAdd(dx, dy, 'column', { rot: 0 });
  } else if (A.pillars === 'dais') {
    // A raised platform against a blank wall, flanked by columns, registered
    // as a work anchor so agents actually go and stand at it.
    const sd = freeSide(['N', 'S', 'W', 'E']);
    const plan = { N: [[4, 1], [2, 1], [6, 1]], S: [[4, 5], [2, 5], [6, 5]],
                   W: [[1, 3], [1, 1], [1, 5]], E: [[7, 3], [7, 1], [7, 5]] }[sd];
    if (plan) {
      const [[px, py], ...flank] = plan;
      const inward = Math.atan2(4 - px, 3 - py);
      if (tryAdd(px, py, 'stairs', { ...wallPose(px, py), rot: inward })) {
        ANCHOR_SPEC.push({ room: idx, kind: 'work', gx: bx + px, gy: by + py, ox: 0, oz: 0 });
      }
      for (const [dx, dy] of flank) tryAdd(dx, dy, 'column', { rot: 0 });
    } else {
      for (const [dx, dy] of corners) tryAdd(dx, dy, 'column', { rot: 0 });
    }
  } else if (A.pillars === 'broken') {
    const std = rtake(corners, 2);
    for (const [dx, dy] of corners) {
      const up = std.some((c) => c[0] === dx && c[1] === dy);
      tryAdd(dx, dy, up ? 'column' : 'rocks', up ? { rot: 0 } : wallPose(dx, dy));
    }
  } else if (A.pillars === 'shored') {
    // Working timber rather than masonry — heavy frames, light props.
    const heavy = rtake(corners, 2);
    for (const [dx, dy] of corners) {
      const big = heavy.some((c) => c[0] === dx && c[1] === dy);
      tryAdd(dx, dy, big ? 'wood-structure' : 'wood-support', wallPose(dx, dy));
    }
  } else {
    for (const [dx, dy] of corners) tryAdd(dx, dy, 'wood-support', wallPose(dx, dy));
  }

  // Focal work station — a table with its chair, a chest on its dais. This is
  // what agents walk to when they're writing or reading, so props earn their
  // collision instead of just stealing floor.
  // Inner corners are the natural spot, but a structure like the aisle already
  // owns them — fall back to the wall ring so every room keeps a place to work.
  const free = ([dx, dy]) => !taken.has(keyOf(dx, dy));
  const primary = [[2, 2], [6, 2], [2, 4], [6, 4]].filter(free);
  const focalCells = primary.length ? primary
    : [[3, 1], [5, 1], [3, 5], [5, 5], [2, 1], [6, 1], [2, 5], [6, 5]].filter(free);
  if (focalCells.length) {
    const [fx, fy] = rpick(focalCells);
    const inward = Math.atan2(4 - fx, 3 - fy);
    add(fx, fy, A.focal.work, { ox: rjit(0.1), oz: rjit(0.1), rot: inward + rjit(0.25) });
    reserve(fx, fy);
    ANCHOR_SPEC.push({ room: idx, kind: 'work', gx: bx + fx, gy: by + fy, ox: 0, oz: 0 });
    // Companion piece one tile along the wall, if there's room.
    const sx = fx < 4 ? fx - 1 : fx + 1;
    if (sx >= 1 && sx <= 7 && !taken.has(keyOf(sx, fy))) {
      add(sx, fy, A.focal.side, { ...wallPose(sx, fy), rot: inward + rjit(0.4) });
      reserve(sx, fy);
      ANCHOR_SPEC.push({ room: idx, kind: 'read', gx: bx + sx, gy: by + fy, ox: 0, oz: 0 });
    }
  }

  // Wall ring — the bulk of the dressing, pressed against the stone.
  const ring = [];
  for (let dx = 1; dx <= 7; dx++) for (let dy = 1; dy <= 5; dy++) {
    if (dx !== 1 && dx !== 7 && dy !== 1 && dy !== 5) continue;
    if (!taken.has(keyOf(dx, dy))) ring.push([dx, dy]);
  }
  const wallCells = rtake(ring, rint(A.wallN[0], A.wallN[1]));
  for (const [dx, dy] of wallCells) {
    const name = rpick(A.wall);
    const pose = wallPose(dx, dy);
    if (name === 'banner' || name.startsWith('shield')) pose.oz *= 1.45, pose.ox *= 1.45; // mount flush
    add(dx, dy, name, pose);
    reserve(dx, dy);
    if (name === A.rest) ANCHOR_SPEC.push({ room: idx, kind: 'rest', gx: bx + dx, gy: by + dy, ox: 0, oz: 0 });
  }

  // Torches — both on the room's single accent colour, placed on free wall
  // cells rather than the same two tiles in every room.
  const torchCells = rtake(ring.filter(([dx, dy]) => !taken.has(keyOf(dx, dy))), rint(2, 3));
  for (const [dx, dy] of torchCells) { TORCH_SPEC.push({ gx: bx + dx, gy: by + dy, color: A.accent }); reserve(dx, dy); }

  // Litter — zero-radius, so it can fall anywhere including near the core.
  const litter = [];
  for (let dx = 1; dx <= 7; dx++) for (let dy = 1; dy <= 5; dy++)
    if (!taken.has(keyOf(dx, dy)) || (dx >= 3 && dx <= 5 && dy >= 2 && dy <= 4)) litter.push([dx, dy]);
  for (const [dx, dy] of rtake(litter, rint(A.scatterN[0], A.scatterN[1]))) {
    const name = rpick(A.scatter);
    // Litter never blocks and never eats standing room — rubble that lands
    // here is debris underfoot, not the boulder-sized pile on the wall ring.
    add(dx, dy, name, { ox: rjit(0.32), oz: rjit(0.32), soft: true,
      scale: radiusOf(name) > 0 ? 0.5 + rnd() * 0.2 : 1 });
  }

  // Archways where corridors meet the room (non-blocking).
  if (doors.has('E')) add(8, 3, 'gate', { rot: Math.PI / 2, ox: 0.42 });
  if (doors.has('W')) add(0, 3, 'gate', { rot: Math.PI / 2, ox: -0.42 });
  if (doors.has('N')) add(4, 0, 'gate', { rot: 0, oz: -0.42 });
  if (doors.has('S')) add(4, 6, 'gate', { rot: 0, oz: 0.42 });
}

// Corridors read as corridors: timber shoring, rubble, the odd trap, and one
// neutral-coloured torch so the coloured rooms stay the landmarks.
function dressCorridor(c, g) {
  const { cells, axis } = c;
  cells.forEach(([x, y], i) => {
    const mid = Math.floor(cells.length / 2);
    if (i === mid) TORCH_SPEC.push({ gx: x, gy: y, color: CORRIDOR_ACCENT });
    if (i !== mid && rchance(0.34)) {
      const side = rchance(0.5) ? 1 : -1;
      DECOR.push({ gx: x, gy: y, name: 'wood-support', scale: 1, soft: false,
        ox: axis === 'h' ? rjit(0.1) : side * 0.4, oz: axis === 'h' ? side * 0.4 : rjit(0.1),
        rot: axis === 'h' ? 0 : Math.PI / 2 });
    }
    if (rchance(0.30)) {
      const name = rpick(['floor-detail', 'stones', 'rocks', 'trap', 'coin']);
      DECOR.push({ gx: x, gy: y, name, soft: true, ox: rjit(0.3), oz: rjit(0.3),
        rot: rnd() * Math.PI * 2, scale: radiusOf(name) > 0 ? 0.5 + rnd() * 0.2 : 1 });
    }
  });
}

const MAP = generateGrid();

let TILE = 1;
const torches = [];
const blockers = [];      // { x, z, r } — r in world units
const floorCells = [];    // every walkable tile (rooms + corridors)
const floorSet = new Set(); // same tiles keyed by grid cell, for O(1) "am I on floor?"
let GOX = 0, GOZ = 0;       // world->grid offset, set once TILE is known
const cellKeyAt = (x, z) => Math.round(x / TILE + GOX) + ',' + Math.round(z / TILE + GOZ);
const seatCandidates = []; // room-only floor, used for agent waypoints
const anchors = [];       // { room, kind, pos, stand, face }

async function tileSize() {
  const f = await piece('floor');
  const s = new THREE.Vector3();
  new THREE.Box3().setFromObject(f).getSize(s);
  return Math.max(s.x, s.z) || 1;
}
function toWorld(c, r, cols, rows) {
  return new THREE.Vector3(c * TILE - ((cols - 1) * TILE) / 2, 0, r * TILE - ((rows - 1) * TILE) / 2);
}
function wallFacing(r, c) {
  const at = (rr, cc) => (MAP[rr]?.[cc] ?? ' ');
  const open = (ch) => ch !== '#' && ch !== ' ';
  if (open(at(r + 1, c))) return 0;
  if (open(at(r - 1, c))) return Math.PI;
  if (open(at(r, c + 1))) return -Math.PI / 2;
  if (open(at(r, c - 1))) return Math.PI / 2;
  return 0;
}

async function buildMap() {
  TILE = await tileSize();
  const rows = MAP.length, cols = MAP[0].length;
  GOX = (cols - 1) / 2; GOZ = (rows - 1) / 2;

  // Collect first, draw once: every tile and prop of the same model ends up in
  // a single instanced batch.
  const batches = new Map();
  const batch = (name, place) => {
    if (!batches.has(name)) batches.set(name, []);
    batches.get(name).push(place);
  };

  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const ch = MAP[r][c];
      if (ch === ' ') continue;
      const p = toWorld(c, r, cols, rows);
      if (ch === '#') { batch(WALLVAR.get(c + ',' + r) || 'wall', { pos: p, rot: wallFacing(r, c) }); continue; }
      batch(ch === 'd' ? 'dirt' : 'floor', { pos: p, rot: 0 });
      floorCells.push(p.clone());
      floorSet.add(c + ',' + r);
      if (ch !== 'd') seatCandidates.push(p.clone());
    }

  for (const d of DECOR) {
    const p = toWorld(d.gx, d.gy, cols, rows);
    p.x += d.ox * TILE; p.z += d.oz * TILE;
    batch(d.name, { pos: p, rot: d.rot, scale: d.scale });
    const rad = d.soft ? 0 : radiusOf(d.name);
    if (rad > 0) blockers.push({ x: p.x, z: p.z, r: rad });
  }

  // Small / flat / wall-mounted dressing doesn't cast shadows — at this camera
  // distance their shadows are invisible, but they'd still cost a full shadow
  // pass every frame. Only structural + large props (columns, furniture, rubble)
  // stay as shadow casters.
  const NO_SHADOW = new Set(['floor', 'dirt', 'floor-detail', 'coin', 'key', 'potion',
    'trap', 'banner', 'shield-round', 'shield-rectangle', 'weapon-sword', 'weapon-spear', 'stones']);
  for (const [name, places] of batches) await addInstanced(name, places, !NO_SHADOW.has(name));

  for (const t of TORCH_SPEC) addTorch(toWorld(t.gx, t.gy, cols, rows), t.color);
  initTorchLights();

  for (const a of ANCHOR_SPEC) {
    const pos = toWorld(a.gx, a.gy, cols, rows);
    const c = toWorld(ROOMS[a.room].cx, ROOMS[a.room].cy, cols, rows);
    const dir = new THREE.Vector3().subVectors(c, pos);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize();
    const stand = pos.clone().addScaledVector(dir, TILE * 0.95);
    anchors.push({ room: a.room, kind: a.kind, pos, stand, face: Math.atan2(-dir.x, -dir.z) });
  }
}

// ---- Torches ------------------------------------------------------------
// Every torch always has a flame (cheap, and it blooms). Real PointLights are
// a fixed-size pool that follows the hero, so lighting cost is constant
// whether the dungeon has 6 rooms or 60.
const MAX_TORCH_LIGHTS = 9;
const torchPool = [];
const TORCH_BASE = 8;

function addTorch(pos, color) {
  const y = TILE * 1.7;
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 12), new THREE.MeshBasicMaterial({ color }));
  flame.position.set(pos.x, y, pos.z);
  scene.add(flame);
  torches.push({ x: pos.x, y, z: pos.z, color, flame });
}
function initTorchLights() {
  for (let i = 0; i < Math.min(MAX_TORCH_LIGHTS, torches.length); i++) {
    const l = new THREE.PointLight(0xffffff, 0, TILE * 11, 2);
    scene.add(l);
    torchPool.push({ light: l, torch: null });
  }
}
let lightReassign = 0;
function updateTorches(dt, t) {
  lightReassign -= dt;
  if (lightReassign <= 0 && hero && torchPool.length) {
    lightReassign = 0.35;
    const hp = hero.group.position;
    const near = torches
      .map((tr) => ({ tr, d: (tr.x - hp.x) ** 2 + (tr.z - hp.z) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, torchPool.length);
    torchPool.forEach((slot, i) => {
      slot.torch = near[i] ? near[i].tr : null;
      if (!slot.torch) { slot.light.intensity = 0; return; }
      slot.light.color.setHex(slot.torch.color);
      slot.light.position.set(slot.torch.x, slot.torch.y, slot.torch.z);
    });
  }
  const flicker = (x) => 0.75 + Math.sin(t * 12 + x) * 0.15 + Math.sin(t * 27) * 0.1;
  for (const tr of torches) tr.flame.scale.setScalar(0.85 + flicker(tr.x) * 0.3);
  for (const slot of torchPool) if (slot.torch) slot.light.intensity = TORCH_BASE * flicker(slot.torch.x);
}

let seats = [];
let roomSeats = []; // free floor per room — agent waypoints
function buildSeats() {
  const cols = MAP[0].length, rows = MAP.length;
  const free = seatCandidates.filter((p) => !blockers.some((b) => Math.hypot(p.x - b.x, p.z - b.z) < b.r * TILE + TILE * 0.3));
  const centers = ROOMS.map((rm) => toWorld(rm.cx, rm.cy, cols, rows));
  const groups = centers.map(() => []);
  for (const s of free) {
    let bi = 0, bd = Infinity;
    centers.forEach((c, i) => { const d = c.distanceToSquared(s); if (d < bd) { bd = d; bi = i; } });
    groups[bi].push(s);
  }
  roomSeats = groups;
  const order = [];
  for (let k = 0, any = true; any; k++) { any = false; for (const gr of groups) if (gr[k]) { order.push(gr[k]); any = true; } }
  seats = order;
}

// ===========================================================================
// Post-processing
// ===========================================================================
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.35, 0.4, 0.85);
composer.addPass(bloomPass);
composer.addPass(new ShaderPass({
  uniforms: {
    tDiffuse: { value: null }, saturation: { value: 1.06 },
    shadowTint: { value: new THREE.Color(0x1a2a55) }, highlightTint: { value: new THREE.Color(0xffe9c0) },
    tintAmount: { value: 0.05 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);} `,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float saturation; uniform vec3 shadowTint;
    uniform vec3 highlightTint; uniform float tintAmount; varying vec2 vUv;
    void main(){ vec4 c=texture2D(tDiffuse,vUv); float l=dot(c.rgb,vec3(0.299,0.587,0.114));
      c.rgb=mix(vec3(l),c.rgb,saturation); vec3 tint=mix(shadowTint,highlightTint,l);
      c.rgb=mix(c.rgb,c.rgb*tint*2.0,tintAmount); gl_FragColor=c; }`,
}));
composer.addPass(new OutputPass());

// ===========================================================================
// Floating labels
// ===========================================================================
function makeSprite(draw, w, h, scale = 0.0045) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(canvas); tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const sp = new THREE.Sprite(mat); sp.scale.set(w * scale, h * scale, 1); sp.renderOrder = 999;
  return sp;
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function makeNameLabel(name, activity, colorHex) {
  const nameFs = 38, actFs = 30, pad = 22;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `bold ${nameFs}px ui-monospace, Menlo, monospace`;
  const w1 = probe.measureText(name).width;
  probe.font = `${actFs}px ui-monospace, Menlo, monospace`;
  const w2 = probe.measureText(activity || '').width;
  const w = Math.ceil(Math.max(w1, w2)) + pad * 2;
  const h = nameFs + actFs + pad * 1.6;
  return makeSprite((ctx) => {
    ctx.fillStyle = 'rgba(16,11,28,0.82)'; roundRect(ctx, 0, 0, w, h, 14); ctx.fill();
    ctx.strokeStyle = colorHex; ctx.lineWidth = 3; ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `bold ${nameFs}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = colorHex; ctx.fillText(name, w / 2, pad * 0.8 + nameFs / 2);
    ctx.font = `${actFs}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = '#cfd3e8'; ctx.fillText(activity || '', w / 2, h - pad * 0.8 - actFs / 2);
  }, w, h);
}
function makeBubble(text, bg) {
  const fs = 34, pad = 22;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `bold ${fs}px ui-monospace, Menlo, monospace`;
  const w = Math.ceil(probe.measureText(text).width) + pad * 2;
  const h = fs + pad * 1.4;
  return makeSprite((ctx) => {
    ctx.fillStyle = bg; roundRect(ctx, 0, 0, w, h - 8, 16); ctx.fill();
    ctx.beginPath(); ctx.moveTo(w / 2 - 10, h - 10); ctx.lineTo(w / 2 + 10, h - 10); ctx.lineTo(w / 2, h); ctx.closePath(); ctx.fill();
    ctx.font = `bold ${fs}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = '#1a1030'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, (h - 8) / 2);
  }, w, h, 0.0052);
}
function makeGauge(pct) {
  const w = 256, h = 52, r = 19, p = 6;
  const col = pct < 0.4 ? '#4dff9e' : pct < 0.6 ? '#ffd24a' : '#ff5d73';  // green → amber at 40% → red at 60%
  return makeSprite((ctx) => {
    ctx.fillStyle = 'rgba(10,8,18,0.88)'; roundRect(ctx, 0, 0, w, h, r); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 3; ctx.stroke();
    const fw = Math.max(0, (w - p * 2) * Math.min(1, pct));
    if (fw > 0) { ctx.fillStyle = col; roundRect(ctx, p, p, fw, h - p * 2, r - 4); ctx.fill(); }
    // dark halo under the text so it stays readable over both the fill and the track
    ctx.font = 'bold 26px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const t = 'ctx ' + Math.round(pct * 100) + '%';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(10,8,18,0.85)'; ctx.strokeText(t, w / 2, h / 2 + 1);
    ctx.fillStyle = '#ffffff'; ctx.fillText(t, w / 2, h / 2 + 1);
  }, w, h, 0.0055);
}
function makeRoomLabel(text) {
  const fs = 40, pad = 26;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `bold ${fs}px ui-monospace, Menlo, monospace`;
  const w = Math.ceil(probe.measureText(text).width) + pad * 2;
  const h = fs + pad;
  return makeSprite((ctx) => {
    ctx.fillStyle = 'rgba(30,20,52,0.5)'; roundRect(ctx, 0, 0, w, h, 16); ctx.fill();
    ctx.strokeStyle = 'rgba(150,130,230,0.35)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.font = `bold ${fs}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = '#b7a9e6'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);
  }, w, h, 0.006);
}

// ===========================================================================
// Sound
// ===========================================================================
let audioCtx = null, soundOn = true;
function ensureAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
  if (audioCtx?.state === 'suspended') audioCtx.resume();
}
function tone(freq, dur, when, type = 'sine', gain = 0.07) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime + when;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + dur + 0.03);
}
function chime(kind) {
  if (!soundOn || !audioCtx) return;
  if (kind === 'done') { tone(660, 0.15, 0); tone(990, 0.22, 0.12); }
  else if (kind === 'attention') { tone(520, 0.12, 0, 'triangle'); tone(520, 0.12, 0.17, 'triangle'); }
  else if (kind === 'poke') { tone(740, 0.1, 0, 'square', 0.05); }
}

// ===========================================================================
// Agents (live Claude Code sessions)
// ===========================================================================
const AGENT_COLORS = [0x6ea8ff, 0xffb257, 0x8affa0, 0xff6ec7, 0xc79bff, 0x5fe0d6, 0xffd24a, 0xff7a5c, 0x9db4ff, 0xff9bd0];
const MODELS = ['character-human', 'character-orc'];
// What an agent physically does for each mode. `move` picks the navigation
// style, `rest` is the clip played once it arrives. Walking is decided by the
// locomotion system, not by the mode, so agents animate from what they do.
const MODE_BEHAVIOR = {
  idle:     { move: 'wander', rest: 'idle',   speed: 1.1, dwell: [2.5, 6.0] },
  thinking: { move: 'pace',   rest: 'idle',   speed: 0.9, dwell: [1.2, 3.0] },
  reading:  { move: 'anchor', rest: 'crouch', speed: 1.7, dwell: [3.0, 6.5], kind: 'read' },
  writing:  { move: 'anchor', rest: 'sit',    speed: 1.8, dwell: [4.0, 9.0], kind: 'work' },
  typing:   { move: 'anchor', rest: 'sit',    speed: 1.8, dwell: [4.0, 9.0], kind: 'work' },
  running:  { move: 'patrol', rest: 'attack-melee-right', speed: 3.1, dwell: [0.4, 1.2] },
};
const DEFAULT_BEHAVIOR = MODE_BEHAVIOR.idle;
const AGENT_RADIUS = 0.30;
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

const agentsGroup = new THREE.Group();
scene.add(agentsGroup);
const views = new Map();
const pending = new Map();

// Custom agent names persist across refreshes (localStorage), keyed by session
// id. When a session ends its name is dropped so stale ids don't accumulate.
const NAMES_KEY = 'dungeon.agentNames';
const customNames = new Map();
try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(NAMES_KEY) || '{}'))) customNames.set(k, v); } catch {}
function saveNames() {
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(Object.fromEntries(customNames))); } catch {}
}
const displayName = (id, fallback) => customNames.get(id) || fallback;
let nextIndex = 0;

// ---- Rooms: each agent gets its OWN room (persisted by session id, freed on
// session end). Sub-agents don't take a room — they stand by their parent.
const ROOMMAP_KEY = 'dungeon.rooms', ROOMNAMES_KEY = 'dungeon.roomNames';
const loadObj = (k) => { try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; } };
const saveObj = (k, o) => { try { localStorage.setItem(k, JSON.stringify(o)); } catch {} };
const roomOfAgent = loadObj(ROOMMAP_KEY);  // { sessionId: roomIndex }
const roomNames = loadObj(ROOMNAMES_KEY);  // { roomIndex: name }
const usedRooms = new Set(Object.values(roomOfAgent));
const roomLabels = {};

function roomCenter(i) {
  const cols = MAP[0].length, rows = MAP.length;
  return toWorld(ROOMS[i].cx, ROOMS[i].cy, cols, rows).clone();
}
function updateRoomLabel(i) {
  if (roomLabels[i]) { scene.remove(roomLabels[i]); roomLabels[i].material.map.dispose(); roomLabels[i].material.dispose(); delete roomLabels[i]; }
  // An unclaimed room still says what it is — the archetype is its identity
  // until an agent moves in and renames it after the folder.
  const text = roomNames[i] != null ? roomNames[i] : ROOMS[i].arch.label;
  const sp = makeRoomLabel(text);
  const c = roomCenter(i);
  sp.position.set(c.x, TILE * 3.7, c.z);
  scene.add(sp); roomLabels[i] = sp;
}
function setRoomName(i, name) { roomNames[i] = name; saveObj(ROOMNAMES_KEY, roomNames); updateRoomLabel(i); }
function allocRoom(id) {
  if (id in roomOfAgent) return roomOfAgent[id];
  let idx = -1;
  for (let k = 0; k < ROOMS.length; k++) if (!usedRooms.has(k)) { idx = k; break; }
  if (idx < 0) idx = Object.keys(roomOfAgent).length % ROOMS.length; // more agents than rooms → share
  roomOfAgent[id] = idx; usedRooms.add(idx); saveObj(ROOMMAP_KEY, roomOfAgent);
  return idx;
}
function freeRoom(id) {
  const idx = roomOfAgent[id];
  if (idx == null) return;
  delete roomOfAgent[id]; saveObj(ROOMMAP_KEY, roomOfAgent);
  if (!Object.values(roomOfAgent).includes(idx)) { // nobody else here → clear the room
    usedRooms.delete(idx); delete roomNames[idx]; saveObj(ROOMNAMES_KEY, roomNames); updateRoomLabel(idx);
  }
}

function playClip(view, name) {
  const next = view.actions[name] || view.actions['idle'];
  if (!next || next === view.current) return;
  next.reset().fadeIn(0.25).play();
  if (view.current) view.current.fadeOut(0.25);
  view.current = next;
}

async function createView(state) {
  const idx = nextIndex++;
  const model = MODELS[idx % MODELS.length];
  const color = state.isSubagent ? 0xd8ccff : AGENT_COLORS[idx % AGENT_COLORS.length];
  const m = await piece(model);
  m.traverse((n) => { if (n.isMesh) n.material.color = new THREE.Color(color); });
  const group = new THREE.Group();
  group.add(m);

  if (state.isSubagent) {
    // ephemeral helper — stand it in a ring next to its parent, smaller
    const parent = views.get(state.parentId);
    const bpos = parent ? parent.group.position : (seats[0] || new THREE.Vector3());
    const ang = (idx * 1.9) % (Math.PI * 2);
    group.position.set(bpos.x + Math.cos(ang) * TILE * 0.95, 0, bpos.z + Math.sin(ang) * TILE * 0.95);
    group.scale.setScalar(0.62);
  }
  let roomIdx = null;
  if (!state.isSubagent) {
    roomIdx = allocRoom(state.id);
    group.position.copy(roomCenter(roomIdx));
    setRoomName(roomIdx, displayName(state.id, state.name));
  }
  group.rotation.y = FACE_Y;
  agentsGroup.add(group);

  const gltf = await load(model);
  const actions = {}; let mixer = null;
  if (gltf.animations?.length) { mixer = new THREE.AnimationMixer(m); for (const c of gltf.animations) actions[c.name] = mixer.clipAction(c); }
  const baseScale = state.isSubagent ? 0.62 : 1;
  const view = { id: state.id, group, mixer, actions, current: null, color, colorHex: hex(color),
    isSubagent: !!state.isSubagent, parentId: state.parentId || null, roomIdx, baseScale,
    nameLabel: null, bubble: null, gauge: null, pulse: 0, prev: {},
    // locomotion
    target: null, dwell: rnd() * 2, facing: FACE_Y, orbit: (idx * 1.9) % (Math.PI * 2),
    moving: false, patrolStep: 0,
    // timers (#3) + needs-you alert (#1)
    activityStart: performance.now(), statusStart: performance.now(), lastActivity: null, lastStatus: null };
  group.userData.view = view;
  return view;
}

function applyState(view, state) {
  const modeChanged = view.state && view.state.mode !== state.mode;
  view.state = state;
  if (modeChanged) { view.target = null; view.dwell = 0; }   // re-plan for the new job

  // timers: reset when the activity/status changes
  const _now = performance.now();
  if (state.activity !== view.lastActivity) { view.activityStart = _now; view.lastActivity = state.activity; }
  if (state.status !== view.lastStatus) { view.statusStart = _now; view.lastStatus = state.status; }

  const dn = displayName(view.id, state.name);
  if (dn !== view.prev.display || state.activity !== view.prev.activity) {
    if (view.nameLabel) { view.group.remove(view.nameLabel); view.nameLabel.material.map.dispose(); view.nameLabel.material.dispose(); }
    view.nameLabel = makeNameLabel(dn, state.activity, view.colorHex);
    view.nameLabel.position.set(0, TILE * 2.05, 0);
    view.group.add(view.nameLabel);
    view.prev.display = dn; view.prev.activity = state.activity;
  }

  const bubbleText = state.status === 'permission' ? '🔒 permission' : state.status === 'waiting' ? '💬 waiting' : null;
  if (bubbleText !== view.prev.bubble) {
    if (view.bubble) { view.group.remove(view.bubble); view.bubble.material.map.dispose(); view.bubble.material.dispose(); view.bubble = null; }
    if (bubbleText) {
      view.bubble = makeBubble(bubbleText, state.status === 'permission' ? '#ffcf6e' : '#8affa0');
      view.bubble.position.set(0, TILE * 3.35, 0);
      view.group.add(view.bubble);
    }
    view.prev.bubble = bubbleText;
  }

  // context-window gauge (real agents only)
  if (!view.isSubagent) {
    const pct = state.contextPct || 0;
    if (view.prev.ctx == null || Math.abs(pct - view.prev.ctx) > 0.02) {
      if (view.gauge) { view.group.remove(view.gauge); view.gauge.material.map.dispose(); view.gauge.material.dispose(); }
      view.gauge = makeGauge(pct);
      view.gauge.position.set(0, TILE * 2.55, 0);
      view.group.add(view.gauge);
      view.prev.ctx = pct;
    }
  }

  // Only on the transition. The relay leaves `finished` true until that
  // session's next event, so a snapshot on reconnect would otherwise fire one
  // chime per idle agent every time the page loads.
  if (state.finished && view.prev.finished === false) chime('done');
  view.prev.finished = !!state.finished;
  if ((state.status === 'waiting' || state.status === 'permission') && view.prev.status !== state.status) chime('attention');
  view.prev.status = state.status;

  if (selected === view) renderDetail(view);
}

async function upsertAgent(state) {
  if (state.status === 'gone') { removeAgent(state.id); return; }
  const existing = views.get(state.id);
  if (existing) { applyState(existing, state); updateHUD(); return; }
  if (pending.has(state.id)) { pending.set(state.id, state); return; }
  pending.set(state.id, state);
  const view = await createView(state);
  // The session can end while createView is still awaiting its model — a
  // subagent that spawns and stops quickly does exactly this. removeAgent
  // clears `pending`, so an empty slot here means "already gone": throw the
  // half-built view away instead of re-registering a dead session as a
  // permanently frozen, stateless character.
  const latest = pending.get(state.id);
  if (!latest) { destroyView(view); freeRoom(state.id); return; }
  views.set(state.id, view);
  applyState(view, latest);
  pending.delete(state.id);
  updateHUD();
}

// Every sprite is a CanvasTexture and every agent mesh gets its own cloned
// material, so a session ending has to hand all of that back. Geometry is
// shared with the cached glTF and must NOT be disposed here.
function destroyView(v) {
  for (const k of ['nameLabel', 'gauge', 'bubble']) {
    const sp = v[k];
    if (!sp) continue;
    v.group.remove(sp);
    sp.material.map?.dispose();
    sp.material.dispose();
    v[k] = null;
  }
  clearSpeech(v);
  v.mixer?.stopAllAction();
  v.mixer?.uncacheRoot(v.group);
  v.group.traverse((n) => {
    if (!n.isMesh || !n.material) return;
    for (const m of Array.isArray(n.material) ? n.material : [n.material]) m.dispose();
  });
  agentsGroup.remove(v.group);
}

function removeAgent(id) {
  // session terminated → forget its custom name + free its room
  if (customNames.delete(id)) saveNames();
  freeRoom(id);
  const v = views.get(id);
  if (!v) { pending.delete(id); return; }
  destroyView(v);
  views.delete(id);
  pending.delete(id);
  pendingByAgent.delete(id);
  if (nearby === v) { nearby = null; setChatTarget(null); }
  if (selected === v) closeDetail();
  updateHUD();
}

// ===========================================================================
// Agent locomotion
// Agents live in their room instead of standing on its centre tile. Where they
// go is driven by what they're doing: writing sends them to the room's work
// anchor (the table, the chest), reading to a side piece, running paces the
// perimeter. Props are destinations, which is what stops the set dressing from
// merely being in the way.
// ===========================================================================
const _av = new THREE.Vector3(), _ap = new THREE.Vector3();

const behaviorOf = (view) => MODE_BEHAVIOR[view.state?.mode] || DEFAULT_BEHAVIOR;
const dwellFor = (b) => b.dwell[0] + Math.random() * (b.dwell[1] - b.dwell[0]);

function roomWaypoints(view) {
  const cells = roomSeats[view.roomIdx];
  return cells && cells.length ? cells : (seats.length ? seats : floorCells);
}

// Pick the next destination for an agent that has finished dwelling.
function planTarget(view) {
  const b = behaviorOf(view);
  const cells = roomWaypoints(view);
  if (!cells.length) return null;
  const here = view.group.position;

  if (b.move === 'anchor') {
    const want = anchors.filter((a) => a.room === view.roomIdx && a.kind === b.kind);
    const pool = want.length ? want : anchors.filter((a) => a.room === view.roomIdx);
    if (pool.length) {
      const a = pool[Math.floor(Math.random() * pool.length)];
      return { pos: a.stand.clone(), face: a.face };
    }
  }
  if (b.move === 'patrol') {
    // Head for the farthest free cell each time, so it reads as covering ground.
    let best = null, bd = -1;
    for (const c of cells) { const d = c.distanceToSquared(here); if (d > bd) { bd = d; best = c; } }
    if (best) return { pos: best.clone().add(new THREE.Vector3(rjit(0.2) * TILE, 0, rjit(0.2) * TILE)), face: null };
  }
  if (b.move === 'pace') {
    // Short hops near where it already is — restless, not touring.
    const near = cells.filter((c) => c.distanceToSquared(here) < (TILE * 2.6) ** 2);
    const from = near.length > 1 ? near : cells;
    return { pos: from[Math.floor(Math.random() * from.length)].clone(), face: null };
  }
  const c = cells[Math.floor(Math.random() * cells.length)];
  return { pos: c.clone().add(new THREE.Vector3(rjit(0.25) * TILE, 0, rjit(0.25) * TILE)), face: null };
}

// Subagents get no room of their own — they trail their parent in a slow orbit.
function followParent(view, dt) {
  const parent = views.get(view.parentId);
  if (!parent) return null;
  view.orbit += dt * 0.5;
  const r = TILE * 1.05;
  return { pos: new THREE.Vector3(parent.group.position.x + Math.cos(view.orbit) * r, 0,
                                  parent.group.position.z + Math.sin(view.orbit) * r), face: null };
}

// Keep agents from standing inside each other, or inside you. The shove can
// push someone into a prop or off the floor, so re-settle afterwards.
const _sp = new THREE.Vector3();
function separate(view) {
  const p = view.group.position, min = TILE * 0.62;
  _sp.copy(p);
  for (const o of views.values()) {
    if (o === view) continue;
    const dx = p.x - o.group.position.x, dz = p.z - o.group.position.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min && d2 > 1e-6) { const d = Math.sqrt(d2), k = ((min - d) * 0.5) / d; p.x += dx * k; p.z += dz * k; }
  }
  if (hero) {
    const dx = p.x - hero.group.position.x, dz = p.z - hero.group.position.z;
    const d2 = dx * dx + dz * dz, hmin = TILE * 0.7;
    if (d2 < hmin * hmin && d2 > 1e-6) { const d = Math.sqrt(d2), k = (hmin - d) / d; p.x += dx * k; p.z += dz * k; }
  }
  if (p.x !== _sp.x || p.z !== _sp.z) { resolveCollision(p, AGENT_RADIUS); clampFloor(p, _sp); }
}

function updateAgents(dt) {
  for (const view of views.values()) {
    const st = view.state;
    if (!st) continue;
    const b = behaviorOf(view);
    const p = view.group.position;

    // Talking, blocked on a human, or just poked → hold still and face you.
    const halted = st.status === 'waiting' || st.status === 'permission';
    if (view.talking || halted || view.faceHeroT > 0) {
      view.target = null; view.moving = false;
      playClip(view, halted ? 'idle' : b.rest);
      if (hero) view.facing = Math.atan2(hero.group.position.x - p.x, hero.group.position.z - p.z);
      view.faceHeroT = Math.max(0, (view.faceHeroT || 0) - dt);
      view.group.rotation.y = THREE.MathUtils.lerp(view.group.rotation.y, view.facing, 0.18);
      separate(view);
      continue;
    }

    if (view.isSubagent) view.target = followParent(view, dt) || view.target;
    else if (!view.target) {
      if (view.dwell > 0) view.dwell -= dt;
      else view.target = planTarget(view);
    }

    if (view.target) {
      _av.subVectors(view.target.pos, p); _av.y = 0;
      const dist = _av.length();
      const arrive = view.isSubagent ? TILE * 0.25 : TILE * 0.18;
      if (dist > arrive) {
        _av.multiplyScalar(1 / dist);
        _ap.copy(p);
        const step = Math.min(dist, b.speed * (view.isSubagent ? 1.3 : 1) * dt);
        p.x += _av.x * step; p.z += _av.z * step;
        resolveCollision(p, AGENT_RADIUS);
        clampFloor(p, _ap);
        view.facing = Math.atan2(_av.x, _av.z);
        view.moving = true;
        playClip(view, 'walk');
      } else {
        if (view.target.face != null) view.facing = view.target.face;
        if (!view.isSubagent) { view.target = null; view.dwell = dwellFor(b); }
        view.moving = false;
        playClip(view, b.rest);
      }
    } else {
      view.moving = false;
      playClip(view, b.rest);
    }

    separate(view);
    view.group.rotation.y = THREE.MathUtils.lerp(view.group.rotation.y, view.facing, view.moving ? 0.22 : 0.12);
  }
}

// ===========================================================================
// Player hero — WASD movement, follow camera, collision
// ===========================================================================
let hero = null;
const heroStart = new THREE.Vector3();

// The player's gamertag — persisted, set by pressing N.
const GT_KEY = 'dungeon.gamertag';
let gamertag = (() => { try { return localStorage.getItem(GT_KEY) || 'You'; } catch { return 'You'; } })();
let heroTag = null;

function refreshHeroTag() {
  if (!hero) return;
  if (heroTag) { hero.group.remove(heroTag); heroTag.material.map.dispose(); heroTag.material.dispose(); }
  heroTag = makeNameLabel(gamertag, '(you)', '#ffffff');
  heroTag.position.set(0, TILE * 2.05, 0);
  hero.group.add(heroTag);
}
const gtModal = document.getElementById('gt-modal');
const gtInput = document.getElementById('gt-input');
const gtConfirm = document.getElementById('gt-confirm');
const gtCancel = document.getElementById('gt-cancel');

function openGamertagModal() {
  for (const k in keys) keys[k] = false;          // release any held movement keys
  gtInput.value = gamertag === 'You' ? '' : gamertag;
  gtModal.classList.add('show');
  requestAnimationFrame(() => { gtInput.focus(); gtInput.select(); });
}
function closeGamertagModal() { gtModal.classList.remove('show'); gtInput.blur(); }
function commitGamertag() {
  const v = gtInput.value.trim().slice(0, 24);
  if (v) { gamertag = v; try { localStorage.setItem(GT_KEY, gamertag); } catch {} refreshHeroTag(); }
  closeGamertagModal();
}
const promptGamertag = openGamertagModal;

gtConfirm.addEventListener('click', commitGamertag);
gtCancel.addEventListener('click', closeGamertagModal);
gtModal.addEventListener('click', (e) => { if (e.target === gtModal) closeGamertagModal(); });
// Escape is handled globally by closeTopOverlay, so it isn't repeated here.
gtInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); commitGamertag(); }
});

// ---- Tutorial modal (asked on load) ----
const tutModal = document.getElementById('tut-modal');
const tutAsk = document.getElementById('tut-ask');
const tutLesson = document.getElementById('tut-lesson');
const closeTutorial = () => tutModal.classList.remove('show');
document.getElementById('tut-no').addEventListener('click', closeTutorial);
document.getElementById('tut-start').addEventListener('click', closeTutorial);
document.getElementById('tut-yes').addEventListener('click', () => {
  tutAsk.classList.add('hidden'); tutLesson.classList.remove('hidden');
});
const anyModalOpen = () => tutModal.classList.contains('show') || gtModal.classList.contains('show');

async function buildHero() {
  const m = await piece('character-human');
  m.traverse((n) => { if (n.isMesh) n.material.color = new THREE.Color(0xffffff); }); // bright hero
  const group = new THREE.Group();
  group.add(m);
  group.position.copy(heroStart);
  scene.add(group);
  const gltf = await load('character-human');
  const actions = {}; let mixer = null;
  if (gltf.animations?.length) { mixer = new THREE.AnimationMixer(m); for (const c of gltf.animations) actions[c.name] = mixer.clipAction(c); }
  hero = { group, mixer, actions, current: null };
  playHero('idle');
  refreshHeroTag();
}
function playHero(name) {
  if (!hero) return;
  const next = hero.actions[name] || hero.actions['idle'];
  if (!next || next === hero.current) return;
  next.reset().fadeIn(0.2).play();
  if (hero.current) hero.current.fadeOut(0.2);
  hero.current = next;
}

const HSPEED = 5, HRAD = 0.35;
const hmove = new THREE.Vector3(), hprev = new THREE.Vector3();

function resolveCollision(pos, rad = HRAD) {
  for (const b of blockers) {
    const dx = pos.x - b.x, dz = pos.z - b.z, min = b.r * TILE + rad;
    const d2 = dx * dx + dz * dz;
    if (d2 < min * min && d2 > 1e-6) { const d = Math.sqrt(d2); pos.x = b.x + (dx / d) * min; pos.z = b.z + (dz / d) * min; }
  }
}
// Is this position standing on a floor tile? A grid lookup rather than a scan
// over every cell in the dungeon — this runs for each agent, every frame.
function clampFloor(pos, prev) {
  if (!floorSet.has(cellKeyAt(pos.x, pos.z))) pos.copy(prev);
}

function updateHero(dt) {
  if (!hero) return;
  hmove.set(0, 0, 0);
  if (keys['w'] || keys['arrowup']) hmove.z -= 1;
  if (keys['s'] || keys['arrowdown']) hmove.z += 1;
  if (keys['a'] || keys['arrowleft']) hmove.x -= 1;
  if (keys['d'] || keys['arrowright']) hmove.x += 1;
  const p = hero.group.position;
  if (hmove.lengthSq() > 0) {
    hprev.copy(p); hmove.normalize();
    p.x += hmove.x * HSPEED * dt; p.z += hmove.z * HSPEED * dt;
    resolveCollision(p); clampFloor(p, hprev);
    hero.group.rotation.y = THREE.MathUtils.lerp(hero.group.rotation.y, Math.atan2(hmove.x, hmove.z), 0.25);
    playHero('walk');
  } else playHero('idle');
}

// ===========================================================================
// Input (keys ignored while typing in the rename field)
// ===========================================================================
// Single-key room shortcuts: 1-9, then 0, then letters — skipping W/A/S/D
// (movement) and N (gamertag) so nothing collides.
// Skips W/A/S/D (movement), N (gamertag), T (talk) and G (jump-to-needy) so a
// growing room list can never shadow a real binding.
const ROOM_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0',
  'q', 'e', 'r', 'y', 'u', 'i', 'o', 'p', 'f', 'h', 'j', 'k', 'l', 'z', 'x', 'c', 'v', 'b', 'm'];
const keyForRoom = (i) => ROOM_KEYS[i] || '';

const keys = {};
const renameInput = document.getElementById('dlg-rename');
const typingInField = (e) => e.target === renameInput || e.target === gtInput || e.target === chatInput;
// Escape always backs out of whatever is on top, even from inside a text
// field — otherwise you have to hunt for the close button with the mouse.
function closeTopOverlay() {
  if (tutModal.classList.contains('show')) { closeTutorial(); return true; }
  if (gtModal.classList.contains('show')) { closeGamertagModal(); return true; }
  if (chatOpen()) { closeChat(); return true; }
  if (dlg.classList.contains('show')) { closeDetail(); return true; }
  return false;
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && closeTopOverlay()) { e.preventDefault(); return; }
  if (typingInField(e) || anyModalOpen()) return;
  const k = e.key.toLowerCase();
  if (k === 'n') { promptGamertag(); return; } // set your gamertag
  if (k === ' ') {                             // logs for the agent you're next to
    e.preventDefault();                        // else the browser scrolls the page
    ensureAudio();
    const v = nearestAgent();
    if (v) selectView(v);
    return;
  }
  if (k === 't') {                             // open/close the chat box
    if (chatOpen()) { closeChat(); return; }
    ensureAudio(); openChat();
    return;
  }
  if (k === '=' || k === '+') { setZoom(camZoom / 1.12); return; }  // zoom in
  if (k === '-' || k === '_') { setZoom(camZoom * 1.12); return; }  // zoom out
  const roomI = ROOM_KEYS.indexOf(k);
  if (roomI >= 0 && roomI < ROOMS.length) { if (hero) hero.group.position.copy(roomCenter(roomI)); return; } // fast travel
  if (k === 'g') { jumpToNeedy(); return; } // #1: jump to whoever needs you
  keys[k] = true;
});
// Releasing a key must ALWAYS clear it. The guard on keydown is there to stop
// typing from driving the hero, but applying that same guard here strands the
// key as held: click into the chat box mid-stride, let go, and you walk into a
// wall forever.
addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

// The browser never delivers keyup for a key released while the page is in the
// background, so drop everything held on the way out. Without this, tabbing
// away mid-stride and coming back leaves the hero running.
const releaseKeys = () => { for (const k in keys) keys[k] = false; };
addEventListener('blur', releaseKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseKeys(); });

// ===========================================================================
// HUD + click-to-interact + rename
// ===========================================================================
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const countEl = document.getElementById('count');
const emptyEl = document.getElementById('empty');
const muteBtn = document.getElementById('mute');
const dlg = document.getElementById('dialogue');
const dlgName = document.getElementById('dlg-name');
const dlgText = document.getElementById('dlg-text');
const saveBtn = document.getElementById('dlg-save');

function setStatus(kind, text) { statusEl.className = kind; statusText.textContent = text; }
function updateHUD() { countEl.textContent = views.size; emptyEl.classList.toggle('hidden', views.size > 0); renderRoomList(); }
muteBtn.addEventListener('click', () => { soundOn = !soundOn; ensureAudio(); muteBtn.textContent = soundOn ? 'sound: on' : 'sound: off'; });


const STATUS_TEXT = { working: 'working', idle: 'idle', waiting: 'waiting for input', permission: 'needs permission' };
const dlgFeed = document.getElementById('dlg-feed');
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Bottom-right roster: which agent occupies each numbered room (press 1-6 to jump)
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60), r = s % 60;
  return m + 'm' + (r ? r + 's' : '');
}
const isNeedy = (v) => v?.state?.status === 'waiting' || v?.state?.status === 'permission';

const roomListEl = document.getElementById('roomlist-rows');
function renderRoomList() {
  if (!roomListEl) return;
  const occ = {};
  for (const v of views.values()) if (!v.isSubagent && v.roomIdx != null) occ[v.roomIdx] = v;
  roomListEl.innerHTML = ROOMS.map((rm, i) => {
    const v = occ[i];
    const arch = escapeHtml(rm.arch?.label || ('Room ' + (i + 1)));
    const needy = isNeedy(v);
    const timer = v ? `<span class="rl-time">${fmtElapsed(performance.now() - (needy ? v.statusStart : v.activityStart))}</span>` : '';
    const who = v
      ? `<span class="rl-dot" style="background:${v.colorHex}"></span><span class="rl-name">${escapeHtml(displayName(v.id, v.state?.name || ''))}</span>${timer}`
      : `<span class="rl-dot rl-empty"></span><span class="rl-name rl-vacant">empty</span>`;
    const keyLabel = escapeHtml((keyForRoom(i) || String(i + 1)).toUpperCase());
    return `<div class="rl-row${needy ? ' rl-alert' : ''}"><span class="rl-num">${keyLabel}</span><span class="rl-arch">${arch}</span>${who}</div>`;
  }).join('');
}

// Room roster is collapsible — click its header; state persists.
const RL_KEY = 'dungeon.roomlistCollapsed';
const roomlistPanel = document.getElementById('roomlist');
const roomlistToggle = document.getElementById('roomlist-toggle');
function setRoomlistCollapsed(c) {
  roomlistPanel?.classList.toggle('collapsed', c);
  try { localStorage.setItem(RL_KEY, c ? '1' : '0'); } catch {}
}
roomlistToggle?.addEventListener('click', () => setRoomlistCollapsed(!roomlistPanel.classList.contains('collapsed')));
try { if (localStorage.getItem(RL_KEY) === '1') setRoomlistCollapsed(true); } catch {}
function renderDetail(view) {
  const s = view.state;
  const tag = s.isSubagent ? ' (subagent)' : '';
  dlgName.textContent = displayName(view.id, s.name) + tag;
  const el = fmtElapsed(performance.now() - (isNeedy(view) ? view.statusStart : view.activityStart));
  dlgText.textContent = `${STATUS_TEXT[s.status] || s.status} · ${s.activity} · ${el}\n${s.cwd || ''}`;
  const hist = s.history || [];
  dlgFeed.innerHTML = hist.length
    ? hist.slice().reverse().map((e) => `<div class="feed-row"><span class="ft">${escapeHtml(e.t || '')}</span> ${escapeHtml(e.text || '')}</div>`).join('')
    : '<div class="feed-empty">no activity yet</div>';
  // Don't clobber what the user is typing — the HUD re-renders this panel
  // once a second, which would otherwise wipe the field mid-rename.
  if (document.activeElement !== renameInput) renameInput.value = displayName(view.id, s.name);
}

let selected = null;
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downX = 0, downY = 0;

function pick(x, y) {
  pointer.x = (x / window.innerWidth) * 2 - 1;
  pointer.y = -(y / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(agentsGroup.children, true);
  if (!hits.length) return null;
  let o = hits[0].object;
  while (o && !o.userData.view) o = o.parent;
  return o ? o.userData.view : null;
}
// Wheel zoom. Bound to the canvas so scrolling the chat log still scrolls it,
// and non-passive so preventDefault can stop the page/trackpad from panning.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  setZoom(camZoom * Math.exp(e.deltaY * 0.0015));
}, { passive: false });
canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; ensureAudio(); });
canvas.addEventListener('pointermove', (e) => { canvas.style.cursor = pick(e.clientX, e.clientY) ? 'pointer' : 'default'; });
function selectView(v) {
  selected = v;
  v.pulse = 1;                                   // tactile "poke"
  v.faceHeroT = 2.5;                             // turn to face you for a beat
  chime('poke');
  renderDetail(v);
  dlg.classList.add('show');
}

// Nearest agent standing within arm's reach of the hero, or null.
const INTERACT_TILES = 2.2;
function nearestAgent() {
  if (!hero) return null;
  const reach = TILE * INTERACT_TILES;
  let best = null, bd = Infinity;
  for (const v of views.values()) {
    const d = v.group.position.distanceTo(hero.group.position);
    if (d <= reach && d < bd) { bd = d; best = v; }
  }
  return best;
}

canvas.addEventListener('click', (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
  const v = pick(e.clientX, e.clientY);
  if (v) selectView(v);
  else closeDetail();
});

function closeDetail() { selected = null; dlg.classList.remove('show'); renameInput.blur(); }

function commitRename() {
  if (!selected) return;
  const v = renameInput.value.trim();
  if (v) customNames.set(selected.id, v); else customNames.delete(selected.id);
  saveNames();                              // persist across refreshes
  selected.prev.display = null;              // force label rebuild
  applyState(selected, selected.state);
  if (selected.roomIdx != null) setRoomName(selected.roomIdx, displayName(selected.id, selected.state.name));
  renderDetail(selected);
}
saveBtn.addEventListener('click', commitRename);
renameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename(); renameInput.blur(); } });

// ===========================================================================
// Talking to an agent
// Walk up, press space, ask. The bubble fills instantly with facts the relay
// already parsed out of the transcript (tier 1), then upgrades to a spoken
// line from the LLM backend (tier 2) when it lands.
// ===========================================================================
const SPEECH_W = 30;            // characters per line before wrapping
const SPEECH_MAX_LINES = 5;
// The 3D bubble is a fresh canvas + GPU texture upload every time its text
// changes. A streamed answer changes it once per token, so sample it instead.
const SPEECH_STREAM_MS = 120;

function wrapText(text, cols) {
  const lines = [];
  for (const word of String(text).split(/\s+/)) {
    if (!lines.length) { lines.push(word); continue; }
    const last = lines[lines.length - 1];
    if (last.length + 1 + word.length <= cols) lines[lines.length - 1] = last + ' ' + word;
    else lines.push(word);
  }
  if (lines.length > SPEECH_MAX_LINES) {
    lines.length = SPEECH_MAX_LINES;
    lines[SPEECH_MAX_LINES - 1] = lines[SPEECH_MAX_LINES - 1].slice(0, cols - 1) + '…';
  }
  return lines;
}

// A multi-line speech bubble with a tail. makeBubble() is single-line and is
// still used for the short status pips (permission / waiting).
function makeSpeech(text, accent, muted = false) {
  const fs = 30, lh = fs * 1.34, pad = 24, tail = 14;
  const lines = wrapText(text, SPEECH_W);
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `${fs}px ui-monospace, Menlo, monospace`;
  const textW = Math.max(...lines.map((l) => probe.measureText(l).width));
  const w = Math.ceil(textW) + pad * 2;
  const h = Math.ceil(lines.length * lh) + pad * 1.5 + tail;
  return makeSprite((ctx) => {
    // keep the fill below the bloom threshold (~0.85 luma) so the bubble doesn't glow
    ctx.fillStyle = muted ? 'rgba(26,19,44,0.94)' : 'rgba(203,198,222,0.97)';
    roundRect(ctx, 0, 0, w, h - tail, 18); ctx.fill();
    ctx.strokeStyle = accent; ctx.lineWidth = 3; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(w / 2 - 12, h - tail - 1); ctx.lineTo(w / 2 + 12, h - tail - 1); ctx.lineTo(w / 2, h);
    ctx.closePath(); ctx.fill();
    ctx.font = `${fs}px ui-monospace, Menlo, monospace`;
    ctx.fillStyle = muted ? '#9a93b8' : '#1a1030';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, w / 2, pad * 0.75 + lh * (i + 0.5)));
  }, w, h, 0.0044);
}

function clearSpeech(view) {
  if (!view.speech) return;
  view.group.remove(view.speech);
  view.speech.material.map.dispose(); view.speech.material.dispose();
  view.speech = null;
}
function setSpeech(view, text, muted = false) {
  clearSpeech(view);
  if (!text) return;
  view.speech = makeSpeech(text, view.colorHex, muted);
  view.speech.position.set(0, TILE * 3.5, 0);
  view.group.add(view.speech);
  view.speechT = 14;                 // seconds on screen before it fades out
}

// ---- Chat panel ----------------------------------------------------------
// A persistent box in the bottom-left rather than a modal. It stays open while
// you walk around, and always addresses whoever you're currently standing
// next to — so changing who you're talking to is just walking over to them.
const chatPanel = document.getElementById('chat');
const chatLogEl = document.getElementById('chat-log');
const chatInput = document.getElementById('chat-input');
const chatTargetEl = document.getElementById('chat-target');

const chatOpen = () => chatPanel.classList.contains('show');
let nearby = null;            // the agent you're standing next to, live
let chatLog = [];             // { who, name, colorHex, text, muted }
const CHAT_MAX = 60;

function renderChat() {
  chatLogEl.innerHTML = chatLog.map((m) => m.who === 'you'
    ? `<div class="cm cm-you"><span class="cm-who">${escapeHtml(gamertag)}</span> ${escapeHtml(m.text)}</div>`
    : `<div class="cm${m.muted ? ' cm-muted' : ''}"><span class="cm-who" style="color:${m.colorHex}">${escapeHtml(m.name)}</span> ${escapeHtml(m.text)}</div>`
  ).join('');
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}
function pushChat(entry) {
  chatLog.push(entry);
  if (chatLog.length > CHAT_MAX) chatLog.shift();
  renderChat();
  return entry;
}

// The header names whoever is in reach right now — that's who Enter will ask.
function setChatTarget(v) {
  if (v) {
    chatTargetEl.textContent = displayName(v.id, v.state?.name || '');
    chatTargetEl.style.color = v.colorHex;
    chatPanel.classList.remove('no-target');
  } else {
    chatTargetEl.textContent = 'nobody in reach';
    chatTargetEl.style.color = '';
    chatPanel.classList.add('no-target');
  }
}

function updateProximity() {
  const v = nearestAgent();
  if (v !== nearby) {
    if (nearby) nearby.talking = false;
    nearby = v;
    if (v && chatOpen()) v.talking = true;     // stop and face you while chatting
    setChatTarget(v);
  }
}

function openChat() {
  chatPanel.classList.add('show');
  if (nearby) nearby.talking = true;
  for (const k in keys) keys[k] = false;       // drop held movement keys
  requestAnimationFrame(() => chatInput.focus());
}
function closeChat() {
  chatPanel.classList.remove('show');
  if (nearby) nearby.talking = false;
  chatInput.blur();
}

function sendAsk() {
  const text = chatInput.value.trim();
  const v = nearby;
  if (!v) { pushChat({ who: 'sys', name: '—', colorHex: '#8880ad', text: 'walk up to an agent first', muted: true }); return; }
  if (!text) return;
  chatInput.value = '';
  pushChat({ who: 'you', text });

  if (!liveSocket || liveSocket.readyState !== 1) {
    pushChat({ who: 'sys', name: '—', colorHex: '#8880ad', text: 'relay offline', muted: true });
    return;
  }
  // One entry per exchange: tier 1 fills it, tier 2 replaces it in place.
  const name = displayName(v.id, v.state?.name || '');
  const entry = pushChat({ who: 'agent', id: v.id, name, colorHex: v.colorHex, text: '…', muted: true });
  pendingByAgent.set(v.id, entry);
  v.awaitingReply = true;
  setSpeech(v, '…', true);
  liveSocket.send(JSON.stringify({ type: 'ask', id: v.id, text }));
}

const pendingByAgent = new Map();

// Relay replies: tier 1 immediately, tier 2 a few seconds later.
function onSay(m) {
  const v = views.get(m.id);
  const entry = pendingByAgent.get(m.id);
  const excuse = { busy: "still mid-task — ask me once i'm done",
                   nomodel: 'no model wired up (set ANTHROPIC_API_KEY or start ollama)',
                   nothing: "there's barely anything in my log for that one",
                   error: "couldn't reach the model" }[m.reason];

  if (m.tier === 1) {
    if (entry) { entry.text = m.text; entry.muted = true; renderChat(); }
    if (v) setSpeech(v, m.text, true);
    return;
  }
  // Streamed fragment — type it out as it generates.
  if (m.delta != null) {
    if (!entry) return;
    entry.text = (entry.streaming ? entry.text : '') + m.delta;
    entry.streaming = true; entry.muted = false;
    renderChat();
    // The DOM log above is cheap and updates on every fragment. The bubble is
    // not, so it samples — and the `done` branch below always writes the final
    // text, so nothing is dropped.
    if (v) {
      const now = performance.now();
      if (!v.speechAt || now - v.speechAt > SPEECH_STREAM_MS) {
        v.speechAt = now;
        setSpeech(v, entry.text, false);
      }
    }
    return;
  }
  const text = m.text || excuse || "couldn't get an answer";
  if (entry) { entry.text = text; entry.muted = !m.text; renderChat(); pendingByAgent.delete(m.id); }
  if (v) { v.awaitingReply = false; v.speechAt = 0; setSpeech(v, text, !m.text); }
  if (m.text) chime('done');
}

chatInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); sendAsk(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
});
document.getElementById('chat-send').addEventListener('click', () => { sendAsk(); chatInput.focus(); });
document.getElementById('chat-close').addEventListener('click', closeChat);

// ===========================================================================
// Camera follow (locked)
// ===========================================================================
function updateCamera() {
  if (!hero) return;
  const hp = hero.group.position;
  key.position.set(hp.x + 20, 34, hp.z + 16);   // keep the shadow frustum over the hero
  key.target.position.copy(hp);
  key.target.updateMatrixWorld();
  camDesired.copy(hp).addScaledVector(CAM_OFFSET, camZoom);
  camera.position.lerp(camDesired, 0.12);
  camera.lookAt(hero.group.position);
}

// ===========================================================================
// Data sources
// ===========================================================================
let liveSocket = null;
function connectWS() {
  setStatus('offline', 'connecting…');
  let ws;
  try { ws = new WebSocket(`ws://${location.host}/agent-ws`); } catch { return; }
  liveSocket = ws;
  ws.onopen = () => setStatus('live', 'live');
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'snapshot') {
      // prune room allocations for sessions that ended while the page was closed
      const live = new Set(m.agents.map((a) => a.id));
      for (const id of Object.keys(roomOfAgent)) if (!live.has(id)) freeRoom(id);
      m.agents.forEach(upsertAgent);
    }
    else if (m.type === 'agent') upsertAgent(m.agent);
    else if (m.type === 'remove') removeAgent(m.id);
    else if (m.type === 'say') onSay(m);
  };
  ws.onclose = () => { setStatus('offline', 'offline — retrying'); setTimeout(connectWS, 2000); };
  ws.onerror = () => ws.close();
}
function startDemo() {
  setStatus('demo', 'demo mode');
  // Enough sessions to populate most of the twelve rooms, so demo mode shows
  // the whole dungeon inhabited rather than one corner of it.
  const names = ['api-server', 'web-app', 'docs-site', 'infra', 'auth-svc',
                 'data-pipeline', 'mobile', 'design-system', 'billing'];
  const modes = ['reading', 'writing', 'running', 'thinking'];
  const acts = { reading: 'Reading main.js', writing: 'Writing index.html', running: 'Running: npm test', thinking: 'Thinking…' };
  const now = () => new Date().toTimeString().slice(0, 8);
  const rec = names.map((n, i) => ({ id: 'demo-' + i, name: n, cwd: '/Users/you/' + n, ctx: 0.1 + i * 0.12, history: [] }));
  const push = (r, text) => { r.history.push({ t: now(), text }); if (r.history.length > 12) r.history.shift(); };
  const send = (r, s) => upsertAgent({ id: r.id, name: r.name, cwd: r.cwd, contextPct: r.ctx, history: r.history.slice(), ...s });
  rec.forEach((r) => { push(r, 'Joined'); send(r, { status: 'working', mode: 'thinking', activity: 'Thinking…' }); });

  const subs = {};
  let tick = 0;
  setInterval(() => {
    tick++;
    const r = rec[tick % rec.length];
    r.ctx = Math.min(1, r.ctx + Math.random() * 0.06);
    const roll = Math.random();
    if (roll < 0.1) send(r, { status: 'waiting', mode: 'idle', activity: 'Waiting for input' });
    else if (roll < 0.17) send(r, { status: 'permission', mode: 'idle', activity: 'Needs permission' });
    else if (roll < 0.28) { r.ctx = 0.1; send(r, { status: 'idle', mode: 'idle', activity: 'Done', finished: true }); }
    else { const mo = modes[Math.floor(Math.random() * modes.length)]; push(r, acts[mo]); send(r, { status: 'working', mode: mo, activity: acts[mo] }); }

    // occasionally spawn a subagent next to a parent, remove it a few ticks later
    if (!subs[r.id] && Math.random() < 0.14) {
      subs[r.id] = tick;
      upsertAgent({ id: r.id + ':sub', name: 'analyze', isSubagent: true, parentId: r.id, cwd: r.cwd,
        status: 'working', mode: 'typing', activity: 'Subtask: analyze', history: [{ t: now(), text: 'Spawned' }] });
    } else if (subs[r.id] && tick - subs[r.id] > 3) { removeAgent(r.id + ':sub'); delete subs[r.id]; }
  }, 1300);
}

// ===========================================================================
// Boot + loop
// ===========================================================================
async function init() {
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshStandardMaterial({ color: 0x090713 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.02; ground.receiveShadow = true; scene.add(ground);

  await buildMap();
  buildSeats();

  for (let i = 0; i < ROOMS.length; i++) updateRoomLabel(i);

  const cols = MAP[0].length, rows = MAP.length;
  heroStart.copy(toWorld(ROOMS[0].cx, ROOMS[0].cy, cols, rows));
  await buildHero();

  camera.position.copy(hero.group.position).addScaledVector(CAM_OFFSET, camZoom);
  camera.lookAt(hero.group.position);

  updateHUD();
  if (location.search.includes('demo')) startDemo();
  else connectWS();
}

const clock = new THREE.Clock();
let frameCount = 0;
function animate() {
  requestAnimationFrame(animate);
  frameCount++;
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  updateTorches(dt, t);
  for (const v of views.values()) {
    v.mixer?.update(dt);
    if (v.pulse > 0) { v.pulse = Math.max(0, v.pulse - dt * 3); v.group.scale.setScalar(v.baseScale * (1 + v.pulse * 0.18)); }
    else if (v.group.scale.x !== v.baseScale) v.group.scale.setScalar(v.baseScale);
  }
  hero?.mixer?.update(dt);

  updateHero(dt);
  updateAgents(dt);
  updateProximity();
  for (const v of views.values()) {
    if (v.speechT > 0 && !v.awaitingReply) { v.speechT -= dt; if (v.speechT <= 0) clearSpeech(v); }
  }
  updateCamera();
  composer.render();
}

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ===========================================================================
// #1 Needs-you alert — banner + G to jump to the longest-waiting agent.
// A 1s tick also keeps the roster/detail timers (#3) live.
// ===========================================================================
const needBanner = document.getElementById('needyou');
const needText = document.getElementById('needyou-text');
function needyList() {
  return [...views.values()].filter((v) => !v.isSubagent && isNeedy(v)).sort((a, b) => a.statusStart - b.statusStart);
}
function jumpToNeedy() {
  const n = needyList();
  if (!n.length) return;
  const v = n[0];
  if (hero && v.roomIdx != null) hero.group.position.copy(roomCenter(v.roomIdx));
  selectView(v);
}
needBanner?.addEventListener('click', jumpToNeedy);
let lastReminder = 0;
function tickAlerts() {
  const n = needyList();
  if (needBanner) {
    if (n.length) {
      const v = n[0];
      const nm = displayName(v.id, v.state?.name || '');
      const what = v.state?.status === 'permission' ? 'needs permission' : 'waiting for input';
      needText.textContent = n.length === 1
        ? `${nm} ${what} · ${fmtElapsed(performance.now() - v.statusStart)} — press G`
        : `${n.length} agents need you — press G`;
      needBanner.classList.add('show');
    } else needBanner.classList.remove('show');
  }
  const now = performance.now();
  if (n.length && now - lastReminder > 15000) { chime('attention'); lastReminder = now; }
  if (!n.length) lastReminder = 0;
}
const fpsEl = document.getElementById('fps');
setInterval(() => {
  renderRoomList(); if (selected) renderDetail(selected); tickAlerts();
  if (fpsEl) { fpsEl.textContent = frameCount + ' fps'; frameCount = 0; }
}, 1000);

init().then(animate);
