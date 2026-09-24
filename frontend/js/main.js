/* =========================================================================
 * Ethosoma — Drosophila Connectome Digital Twin (simulation engine)
 * Copyright (c) 2026 Adel Benaissa. All rights reserved.
 * MIT License — see LICENSE in the repository root.
 *
 * FlyWire Digital Twin — Drosophila melanogaster connectome
 * 2-Photon calcium-imaging digital twin + grounded neuroethological engine
 *
 * Rendering pipeline:
 *   - True FlyWire connectome frontend/data/connectome.bin (139,255 real
 *     neuron somas, decoded with ArrayBuffer/DataView — no thread block).
 *   - RESTING STATE: every neuron (incl. optic lobes) renders as dark,
 *     neutral microscopy slate (#181b20→#282c35), low opacity, normal
 *     blending. Nothing is permanently highlighted.
 *   - Activity = transient calcium envelopes: dedicated circuit modules
 *     (LC/LPLC looming, T-series motion columns, PPL1 aversive, PAM reward,
 *     giant-fibre descending, OA arousal, central complex relay, gustatory)
 *     flash only when invoked, as travelling waves, then decay. Base RGB
 *     stays strictly within [0,1]; bloom is tight and restrained.
 *
 * Engine: 6-state Drosophila ethogram (locomotion / grooming / quiescence /
 * escape / depressive-freeze / economic-quiescence) driven by a simulated
 * population vector (metabolic reserve, octopamine arousal, PAM/PPL1 DA,
 * serotonin, sleep pressure, circadian phase) plus a chronic
 * environmental-stressor layer: episodic ODE forcing, allostatic-load
 * integration, and a latched burnout state (OA dominance × PAM depletion
 * > 30 s) that blunts GCaMP amplitudes. A socio-economic survival layer —
 * the "Drosophila Algeriana" stage (40,000 DZD salary, fixed-overhead/
 * groceries/utilities cascade, 25% reproductive-capital skim, market-
 * inflation surges, kinship obligation levies, street coffee) — couples
 *     economic scarcity back into the octopamine/dopamine axis, the
 *     allostatic integral, and a sixth economic-quiescence (metabolic
 *     deprivation freeze) posture. An
 *     associative substance-learning stage — first-exposure imprint, a
 *     misery-gated craving drive (allostasis × PAM-depletion × resignation),
 *     user-authorized chemical relief that silences the PPL1 aversive circuit,
 *     escorts tolerance, and a 1.2 Hz restless CC/PAM craving glow — completes
 *     the escape-vector economy.
 * ========================================================================= */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

/* -------------------------------------------------------------------------
 * Configuration
 * ---------------------------------------------------------------------- */
const CONFIG = {
  dataUrl: "data/connectome.bin",
  manifestUrl: "data/manifest.json",
  fallbackObjUrl: "models/fly_brain.obj",
  baselineOpacity: 0.48,
  activeOpacity: 1.0,
  cameraFactor: 2.5,
  fov: 60,
  bloom: { threshold: 0.60, strength: 0.55, radius: 0.30 },
  tickMs: 250,
};

const BASELINE_MIN = new THREE.Color("#232936");
const BASELINE_MAX = new THREE.Color("#454e60");

// Circuit modules — tag (from connectome.bin) → visual identity.
const CIRCUITS = {
  1: { name: "LC/LPLC Visual",           color: "#00e5ff", size: 0.010 },
  2: { name: "T-series Motion Columns",  color: "#00c2e8", size: 0.0065 },
  3: { name: "PPL1 Aversive DA",         color: "#ff9f1c", size: 0.024 },
  4: { name: "PAM Reward DA",            color: "#ff2a6d", size: 0.014 },
  5: { name: "Giant-Fibre / Descending", color: "#ff2244", size: 0.016 },
  6: { name: "OA-VUM Arousal",           color: "#ffc75f", size: 0.022 },
  7: { name: "Central Complex",          color: "#4dd0ff", size: 0.012 },
  8: { name: "Gustatory / Taste",        color: "#ffd08a", size: 0.018 },
  9: { name: "AL Olfactory / Antennal",  color: "#b794f6", size: 0.010 },
};

const BG_COLOR = new THREE.Color("#04070d");

/* -------------------------------------------------------------------------
 * DOM
 * ---------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const el = {
  scene: $("scene"),
  boot: $("boot"),
  icon: $("behaviour-icon"),
  name: $("behaviour-name"),
  confVal: $("confidence-val"),
  confFill: $("confidence-fill"),
  behSub: $("behaviour-sub"),
  modeChip: $("behaviour-mode"),
  trace: $("trace"),
  "anatomy-count": $("anatomy-count"),
  "anatomy-rows": $("anatomy-rows"),
  m: {
    energy: $("m-energy"), arousal: $("m-arousal"), phase: $("m-phase"),
    sleep: $("m-sleep"), load: $("m-load"),
    dopamine: $("m-dopamine"), aversive: $("m-aversive"),
    octopamine: $("m-octopamine"), serotonin: $("m-serotonin"), threat: $("m-threat"),
    liq: $("m-liq"), repro: $("m-repro"), infl: $("m-infl"),
    scar: $("m-scar"), social: $("m-social"),
    substance: $("m-substance"),
  },
  b: {
    energy: $("b-energy"), arousal: $("b-arousal"), phase: $("b-phase"),
    sleep: $("b-sleep"), load: $("b-load"),
    dopamine: $("b-dopamine"), aversive: $("b-aversive"),
    octopamine: $("b-octopamine"), serotonin: $("b-serotonin"), threat: $("b-threat"),
    liq: $("b-liq"), repro: $("b-repro"), infl: $("b-infl"),
    scar: $("b-scar"), social: $("b-social"),
    substance: $("b-substance"),
  },
  hints: {
    heat: $("hint-heat"), queue: $("hint-queue"),
    deadline: $("hint-deadline"), tea: $("hint-tea"),
    inflation: $("hint-inflation"), substance: $("hint-substance"),
  },
  paydayHint: $("hint-payday"),
  coffeeHint: $("hint-coffee"),
  survival: $("survival-mode"),
  ccExcite: $("cc-excite"),
  ccTemp: $("cc-temp"),
  substanceTol: $("substance-tol"),
  substanceLabel: $("substance-label"),
};

/* -------------------------------------------------------------------------
 * Small utilities
 * ---------------------------------------------------------------------- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

let lastActionTime = 0;
function throttleAction(fn, minIntervalMs = 150) {
  return (...args) => {
    const now = performance.now();
    if (now - lastActionTime < minIntervalMs) return;
    lastActionTime = now;
    fn(...args);
  };
}

/** Deterministic pseudo-random in [0,1) from an index — stable per neuron. */
function hash01(i) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function makeSoftTexture() {
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.40, "rgba(255,255,255,0.80)");
  g.addColorStop(0.75, "rgba(255,255,255,0.24)");
  g.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

function logTrace(msg, hot = false) {
  const stamp = new Date().toTimeString().slice(0, 8);
  const line = document.createElement("div");
  line.className = "tline" + (hot ? " hot" : "");
  line.textContent = "";
  const stampEl = document.createElement("strong");
  stampEl.textContent = `[${stamp}] `;
  line.appendChild(stampEl);
  line.appendChild(document.createTextNode(msg));
  el.trace.prepend(line);
  while (el.trace.children.length > 5) el.trace.removeChild(el.trace.lastChild);
}

/* -------------------------------------------------------------------------
 * Connectome binary decoder
 * Layout (little-endian):
 *   [0..4)   magic  "FWC1"
 *   [4..8)   u32 version = 2 (circuit tags)
 *   [8..12)  u32 N
 *   [12..)        N * 3 Float32   positions (centred, radius ≈ 1)
 *   [12+N*12..)   N Uint8         circuit tag (0..9)
 * ---------------------------------------------------------------------- */
const BIN_MAGIC = 0x31435746; // "FWC1" little-endian

function decodeConnectome(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < 12) throw new Error("truncated header");
  if (dv.getUint32(0, true) !== BIN_MAGIC) throw new Error("bad magic");
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error("unsupported version " + version);
  const N = dv.getUint32(8, true);
  if (N < 10000 || N > 2000000) throw new Error("implausible neuron count " + N);
  const need = 12 + N * 13;
  if (dv.byteLength < need) throw new Error("truncated payload");
  const positions = new Float32Array(buf, 12, N * 3);
  const tags = new Uint8Array(buf, 12 + N * 12, N);
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i]) || Math.abs(positions[i]) > 3) {
      throw new Error("non-finite / out-of-bounds coordinate at index " + i);
    }
  }
  for (let i = 0; i < N; i++) {
    if (tags[i] > 9) throw new Error("invalid circuit tag " + tags[i] + " at soma " + i);
  }
  return { N, positions, tags };
}

async function loadConnectome() {
  const res = await fetch(CONFIG.dataUrl);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return decodeConnectome(await res.arrayBuffer());
}

/* -------------------------------------------------------------------------
 * Scene construction
 * ---------------------------------------------------------------------- */
let scene, camera, renderer, composer, bloomPass, controls;
let brainRadius = 1;
const layers = new Map();   // circuit tag (≥1) → {mat, pts, env, flash, ambient}
let ccLayer = null;         // hoisted Central-Complex layer (tag 7) for the per-frame reservoir integrator

function initRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.NoToneMapping;   // no HDR — RGB stays in [0,1]
  renderer.setClearColor(BG_COLOR, 1);
  el.scene.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = BG_COLOR;

  camera = new THREE.PerspectiveCamera(CONFIG.fov, window.innerWidth / window.innerHeight, 0.01, 1000);

  const composerRes = new THREE.Vector2(window.innerWidth, window.innerHeight);
  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  bloomPass = new UnrealBloomPass(
    composerRes,
    CONFIG.bloom.strength,
    CONFIG.bloom.radius,
    CONFIG.bloom.threshold,
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());
}

function initControls() {
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.minDistance = brainRadius * 1.2;
  controls.maxDistance = brainRadius * 6;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.4;
  let idleTimer = null;
  controls.addEventListener("start", () => {
    controls.autoRotate = false;
    if (idleTimer) clearTimeout(idleTimer);
  });
  controls.addEventListener("end", () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { controls.autoRotate = true; }, 12000);
  });
  controls.update();
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
}

/* -------------------------------------------------------------------------
 * Connectome scene
 * ---------------------------------------------------------------------- */
function buildConnectomeScene(data) {
  const { N, positions, tags } = data;
  const tex = makeSoftTexture();

  // --- 1. Baseline microscopy slate — ALL neurons, uniformly dark. ---------
  const baseColors = new Float32Array(N * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const t = hash01(i);
    tmp.lerpColors(BASELINE_MIN, BASELINE_MAX, t);
    const rJ = 1 + (hash01(i + 1) - 0.5) * 0.08;
    const gJ = 1 + (hash01(i + 2) - 0.5) * 0.08;
    const bJ = 1 + (hash01(i + 3) - 0.5) * 0.08;
    baseColors[i * 3]     = clamp(tmp.r * rJ, 0, 1);
    baseColors[i * 3 + 1] = clamp(tmp.g * gJ, 0, 1);
    baseColors[i * 3 + 2] = clamp(tmp.b * bJ, 0, 1);
  }
  const baseGeo = new THREE.BufferGeometry();
  baseGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  baseGeo.setAttribute("color", new THREE.BufferAttribute(baseColors, 3));
  baseGeo.computeBoundingSphere();
  const R = baseGeo.boundingSphere.radius;
  brainRadius = R;

  const baseMat = new THREE.PointsMaterial({
    map: tex,
    size: R * 0.0085,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: CONFIG.baselineOpacity,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
  });
  const basePts = new THREE.Points(baseGeo, baseMat);
  basePts.renderOrder = 0;
  scene.add(basePts);

  // --- 2. Circuit modules — tagged sub-populations, invisible at rest. ------
  const idxByTag = new Map();
  for (const tag of Object.keys(CIRCUITS).map(Number)) idxByTag.set(tag, []);
  for (let i = 0; i < N; i++) {
    const tag = tags[i];
    if (idxByTag.has(tag)) idxByTag.get(tag).push(i);
  }

  for (const [tag, def] of Object.entries(CIRCUITS)) {
    const t = Number(tag);
    const idx = idxByTag.get(t);
    if (!idx.length) continue;
    const m = idx.length;
    const posArr = new Float32Array(m * 3);
    const colArr = new Float32Array(m * 3);
    const color = new THREE.Color(def.color);
    const ctmp = new THREE.Color();
    for (let j = 0; j < m; j++) {
      const i = idx[j];
      posArr[j * 3] = positions[i * 3];
      posArr[j * 3 + 1] = positions[i * 3 + 1];
      posArr[j * 3 + 2] = positions[i * 3 + 2];
      const k = 0.70 + 0.30 * hash01(i + 97); // per-neuron variation, ≤ 1.0
      ctmp.copy(color).multiplyScalar(k);
      colArr[j * 3] = clamp(ctmp.r, 0, 1);
      colArr[j * 3 + 1] = clamp(ctmp.g, 0, 1);
      colArr[j * 3 + 2] = clamp(ctmp.b, 0, 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colArr, 3));
    const mat = new THREE.PointsMaterial({
      map: tex,
      size: R * def.size,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: CONFIG.activeOpacity,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.renderOrder = t;
    scene.add(pts);

    layers.set(t, { tag: t, def, mat, pts, env: 0.0, flash: 0.0, ambient: 0.0, craveSource: t === 4 || t === 7 });
  }
  ccLayer = layers.get(7) || null;

  return R;
}

/* Calcium transient system
 * A layer's envelope (env) eases toward (ambient + flash) with a fast
 * attack and slower release — the signature of a GCaMP transient.
 * The global gcamp gain (1.0 healthy, ~0.35 in burnout) blunts amplitudes
 * during chronic-stress hypo-reactivity.
 * ---------------------------------------------------------------------- */
function setFlash(tag, value) {
  const layer = layers.get(tag);
  if (layer) layer.flash = value;
}

/**
 * Fire a temporal wave: steps = [[delayMs, tag, value], ...] applied
 * sequentially, letting the envelope's release tail carry the signal
 * inward/outward and fade within the specified window.
 */
function scheduleWave(steps) {
  let t = 0;
  for (const [delta, tag, value] of steps) {
    t += delta;
    setTimeout(() => setFlash(tag, value), t);
  }
}

/* Ambient sources stack additively: behaviour-state glow + chronic-episode
 * stressor glow. Resting/healthy states stay dark; escape and chronic
 * stressors visibly engage. */
const STATE_AMBIENT = {
  locomotion: { 2: 0.045, 6: 0.05 },      // subtle motion columns + OA
  grooming:   { 8: 0.03, 1: 0.03 },
  quiescence: {},
  apathy:     { 4: 0.04, 7: 0.05 },       // depressive freeze — weak residual tone
  economicIdling: { 5: 0.12, 7: 0.04 },  // minimalist freeze — faint descending + CC residue
  escape:     { 1: 0.06, 3: 0.30, 5: 0.42, 6: 0.30 },
};

const ambientS = new Map();   // behaviour-state ambient (recomputed on switch)
const ambientE = new Map();   // chronic-stressor episode ambient (stacked)

function refreshAmbient() {
  for (const [tag, layer] of layers) {
    const s = ambientS.get(tag) || 0;
    const e = ambientE.get(tag) || 0;
    layer.ambient = s + e;
  }
}

function applyStateAmbient(state) {
  ambientS.clear();
  const map = STATE_AMBIENT[state] || {};
  for (const [tag, v] of Object.entries(map)) ambientS.set(Number(tag), v);
  refreshAmbient();
}

function setEpisodeAmbient(map) {
  ambientE.clear();
  for (const [tag, v] of Object.entries(map || {})) ambientE.set(Number(tag), v);
  refreshAmbient();
}

/* -------------------------------------------------------------------------
 * Grounded neuroethology — behavioural engine
 * ---------------------------------------------------------------------- */
const STATES = ["locomotion", "grooming", "quiescence", "escape", "apathy", "economicIdling"];

const STATE_META = {
  locomotion: { icon: "◆", color: "#7de3ff", tag: "LOCOMOTION / FORAGING · HIGH DRIVE" },
  grooming: { icon: "◇", color: "#ffd28a", tag: "GROOMING · SCRATCH / WIPE" },
  quiescence: { icon: "●", color: "#8fe8be", tag: "QUIESCENCE / SLEEP · LOW AROUSAL" },
  escape: { icon: "▲", color: "#ff9191", tag: "AVERSIVE ESCAPE · GIANT-FIBRE" },
  apathy: { icon: "◌", color: "#9fb2c8", tag: "DEPRESSIVE FREEZE · LEARNED HELPLESSNESS · PASSIVE COPING" },
  economicIdling: { icon: "○", color: "#8b98ad", tag: "ECONOMIC QUIESCENCE · METABOLIC DEPRIVATION FREEZE" },
};

/** Prototypical population vectors (8 neuromodulatory dims), one per state.
 *  Order: energy, sleepPressure, arousal, serotonin, threat, octopamine,
 *         dopamine, aversive. */
const PROTOTYPES = {
  locomotion: [0.70, 0.30, 0.70, 0.35, 0.25, 0.55, 0.38, 0.40],
  grooming:   [0.35, 0.45, 0.40, 0.62, 0.48, 0.42, 0.52, 0.30],
  quiescence: [0.22, 0.78, 0.18, 0.55, 0.20, 0.30, 0.82, 0.22],
  escape:     [0.55, 0.18, 0.85, 0.22, 0.82, 0.28, 0.24, 0.88],
  apathy:     [0.30, 0.74, 0.14, 0.38, 0.42, 0.12, 0.10, 0.60],
  economicIdling: [0.26, 0.60, 0.16, 0.30, 0.50, 0.20, 0.12, 0.52],
};

const agent = {
  energy: 78, arousal: 46, phase: 10.5, sleepPressure: 12,
  dopamine: 45, aversive: 42, octopamine: 38, serotonin: 52, threat: 16,
  behavior: "locomotion", confidence: 0.62, dwell: 0,
  allostaticLoad: 6, strainSeconds: 0, burnout: false,
  cumulativeStress: 0,
  gcamp: 1.0, gcampTarget: 1.0,
  ccExcite: 0.0, effectiveTemp: 14.0,
  liquidityDZD: 5000, reproductiveCapitalDZD: 42000, fixedOverheadAccumulator: 0,
  socioDebt: 8, resignationIndex: 0.35, liquidityPct: 100,
socialCapital: 20,
    freezeKindle: 0, freezeCount: 0, foldWarningLogged: false, solidarityPool: 0,
  reproductiveReserveRatio: 0.175, paydayCountdown: 60, coffeeTimer: 0,
  marketInflation: 0, financialHypoxia: 0, hypoxiaLogged: false,
  reproductiveCapitalReady: false,
  substanceKnown: false, substanceCraving: 0, substanceTolerance: 0,
  substanceReliefTimer: 0, substanceStrain: 0, cravingLogged: false,
  tolWashLogged: false, escapeDenied: false,
  substancePulsePhase: 0,
};

const VECTOR_ORDER = [
  "energy", "sleepPressure", "arousal", "serotonin",
  "threat", "octopamine", "dopamine", "aversive",
];

function currentPopulationVector() {
  return VECTOR_ORDER.map((k) => clamp(agent[k] / 100, 0, 1));
}

function cosine(a, b) {
  const na = Math.hypot(...a), nb = Math.hypot(...b);
  if (!na || !nb) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / (na * nb);
}

function stateLikelihoods() {
  const v = currentPopulationVector();
  const raw = STATES.map((s) => Math.max(0, cosine(v, PROTOTYPES[s])));
  const m = Math.max(...raw);

  // Upstream calcium feedback — sustained Central Complex excitation (a local
  // excitotoxicity proxy) flattens the arbitration softmax: T_eff decays from
  // 14 toward 6.75 (Hill-saturating; the global ≈6.3 asymptote is unreachable
  // under the ccExcite ≤ 10 clamp since ccHill(10) = 100/106.25 = 0.9412),
  // degrading decisiveness into
  // behavioural entropy / hesitation under hyper-excitation.
  const ccHill = (agent.ccExcite * agent.ccExcite) / (2.5 * 2.5 + agent.ccExcite * agent.ccExcite);
  const effectiveTemp = 14.0 * (1.0 - 0.55 * ccHill);
  agent.effectiveTemp = effectiveTemp;
  const exps = raw.map((x) => Math.exp((x - m) * effectiveTemp));
  const sum = exps.reduce((a, b) => a + b, 0);
  return STATES.map((s, i) => ({ state: s, p: exps[i] / sum }));
}

function chooseBehavior(dt) {
  const { energy, arousal, threat, octopamine, sleepPressure, dopamine } = agent;

  // Coping-style gate. Octopamine potentiates active coping (escape);
  // dopamine depletion with chronic strain shifts the mouse into passive
  // coping — a depressive freeze / learned-helplessness posture.
  const inAcuteDanger =
    !(agent.burnout && dopamine < 20) &&
    ((threat > 64 && octopamine > 52) || (arousal > 80 && energy > 20));

  const passiveCoping =
    !inAcuteDanger && dopamine < 28 &&
    (agent.burnout || agent.allostaticLoad > 55 || isEpisode("queue"));

  const sleepy = sleepPressure > 70 || (energy < 24 && arousal < 24);

  // Cognitive decoupling during the acute relief window: intoxication
  // silences the future-oriented Central Complex arbitration (reproductive
  // capital, socio-debt, inflation), so the fly forages even under objective
  // liquidity collapse. When relief expires the gates snap back shut.
  const reliefWindow = agent.substanceReliefTimer > 0;

  // Socio-economic freeze — the sixth state. Chronic scarcity with
  // accumulated resignation and a savings / debt squeeze latches the fly
  // into a metabolic deprivation freeze (economic quiescence) posture.
  // Epigenetic-kindling latch (Q2) — repeated freeze entries sensitize the
  // basin: at a full stack (kindle 3.0) the gate deforms to R > 0.384 and
  // L < 20.4%, i.e. the 11th freeze triggers at higher cash and lower
  // resignation than the 1st, until the near-geological washout.
  const kindleFactor = 1.0 - 0.12 * agent.freezeKindle;
  const economicFreeze =
    !reliefWindow && agent.liquidityPct < (15 * (2 - kindleFactor)) &&
    agent.resignationIndex > (0.6 * kindleFactor) &&
    (agent.reproductiveReserveRatio < 0.25 || agent.socioDebt > 25 || isEpisode("inflation"));

  // Metabolic rescue — primal survival over socio-economic resignation. When
  // physiological starvation is imminent and no acute threat dominates, the
  // fly ignores the ledger and forages regardless of cash or savings balance.
  const survivalForage = energy < 20 && threat < 50;

  // Viability gate: scarce cash or a thin reproductive reserve halts costly search.
  const forageBlocked =
    !reliefWindow && !survivalForage &&
    (agent.liquidityPct < 20 ||
     (agent.reproductiveReserveRatio < 0.6 && agent.liquidityPct < 45));

  const feedEligible =
    energy > 34 && sleepPressure < 58 && arousal > 30 &&
    threat < 40 && dopamine > 24;

  let next = agent.behavior;
  if (inAcuteDanger) next = "escape";
  else if (survivalForage) {
    // Starvation trumps every socio-economic and avoidance gate below —
    // the animal forages even out of freeze/apathy/quiescence.
    next = "locomotion";
    if (!survivalOverrideLogged) {
      survivalOverrideLogged = true;
      logTrace("METABOLIC RESCUE — critical energy (<20) overrides socio-economic gating → desperate foraging engaged.", true);
    }
  } else if (passiveCoping) next = "apathy";
  else if (economicFreeze) next = "economicIdling";
  else if (sleepy) next = "quiescence";
  else if (agent.behavior === "economicIdling") {
    // Emerge from the minimalist freeze as soon as the budget regains a
    // floor (the post-payday flush window before the liability cascade).
    // The Schmitt exit hysteresis is gently coupled to the kindling factor
    // (Q1-exit fix): a saturated latch (κf → 0.64) relaxes the exit to
    // 30·(0.85+0.15·0.64) = 28.38% (~1,419 DZD) — a viable biological path out
    // while keeping the recovery band strictly above the 20.4% entry.
    const dynamicExitPct = 30.0 * (0.85 + 0.15 * kindleFactor);
    if (agent.liquidityPct > dynamicExitPct) next = "locomotion";
  } else if (agent.behavior === "apathy") {
    // Emerge from freeze only when reward tone and drive recover.
    if (dopamine > 42 && energy > 40 && !isEpisode("queue")) next = "locomotion";
  } else if (agent.behavior === "quiescence" && sleepPressure < 34 && energy > 55) {
    next = "locomotion";
  } else if (feedEligible) {
    // Foraging is gated by socio-economic viability (metabolic triage):
    // scarce cash or savings halts otherwise-valid search behaviour.
    if (!forageBlocked) {
      if (socioGateLogged) socioGateLogged = false;
      next = Math.random() < 0.004 && serotoninGate() ? "grooming" : "locomotion";
    } else if (!socioGateLogged) {
      socioGateLogged = true;
      logTrace(`SOCIO-REPRODUCTIVE GATING — Reproductive reserve at ${Math.round(agent.reproductiveReserveRatio * 100)}% → Locomotor foraging suppressed to prevent deficit.`, false);
    }
  }

  // Freeze-entry sensitization — a NEW transition into economic idling stacks
  // the kindling latch (capped 3.0); `agent.behavior` is still the prior state
  // here, so `next === economicIdling` with a different current state is a
  // genuine re-entry (the memory the plain hysteresis loop lacks).
  if (next === "economicIdling" && agent.behavior !== "economicIdling") {
    agent.freezeKindle = Math.min(3.0, agent.freezeKindle + 0.3);
    logTrace(`[FREEZE SENSITIZATION #${++agent.freezeCount}] Kindle factor: ${agent.freezeKindle.toFixed(2)}`, false);
  }

  if (!survivalForage) survivalOverrideLogged = false;
  if (next !== agent.behavior) switchBehavior(next, false);
  agent.dwell += dt;

  const best = stateLikelihoods().reduce((a, b) => (b.p > a.p ? b : a));
  agent.confidence = clamp(best.p * (0.55 + 0.45 * Math.min(1, agent.dwell / 6)), 0.05, 0.98);
}

function serotoninGate() {
  return agent.arousal >= 20 && agent.arousal <= 82 && agent.serotonin > 40;
}

function applyBehaviourUI(next) {
  const meta = STATE_META[next];
  el.icon.textContent = meta.icon;
  el.icon.style.color = meta.color;
  el.name.textContent = meta.tag.split(" · ")[0];
  el.name.style.color = meta.color;
  el.behSub.textContent = meta.tag;
}

function switchBehavior(next, byUser = false) {
  agent.behavior = next;
  agent.dwell = 0;
  applyBehaviourUI(next);
  applyStateAmbient(next);
  if (byUser || next === "escape" || next === "apathy" || next === "economicIdling") {
    logTrace(`STATE → ${STATE_META[next].tag}`, true);
  }
}

/* -------------------------------------------------------------------------
 * Chronic environmental stressor episodes + allostatic load
 * Duration in simulation seconds; each episode drives the ODE for its whole
 * window, holds circuit envelopes, and accumulates allostatic wear.
 * ---------------------------------------------------------------------- */
const EPISODE_DEFS = {
  heat:     { label: "HEATWAVE & NOISE",    tagline: "columns + antennal drive · OA surge",    hint: "COLUMNS · ANTENNAL · OA",   duration: 34 },
  queue:    { label: "WAITING QUEUE",       tagline: "PAM depletion → chronic frustration",   hint: "PAM↓ · PPL1↑ · FREEZE",     duration: 26 },
  deadline: { label: "LATE-NIGHT DEADLINE", tagline: "acute stress spike · giant-fibre panic",hint: "THREAT · GIANT-FIBRE",      duration: 16 },
  tea:      { label: "MINT TEA / COFFEE",   tagline: "gustatory reward → PAM recovery",       hint: "GUSTATORY · PAM · RESTORE", duration: 14 },
  inflation:{ label: "MARKET INFLATION SURGE",tagline: "price-index pressure · metabolic triage",hint: "DRAIN ×1.8 · AL FLASH",   duration: 45 },
};

let episodes = [];    // { kind, remaining, label, burstT? }
let burnoutT = 0;     // accumulator for sporadic burnout CC transients

function isEpisode(kind) {
  return episodes.some((e) => e.kind === kind);
}

function panicBurst() {
  scheduleWave([
    [0,   5, 0.95],   // giant-fibre / descending escape motor
    [70,  6, 0.45],   // OA arousal surge
    [110, 3, 0.50],   // PPL1 aversive reinforcement
    [280, 5, 0.0],
    [320, 6, 0.0],
    [340, 3, 0.0],
  ]);
}

function activateEpisode(kind) {
  const def = EPISODE_DEFS[kind];
  const existing = episodes.find((e) => e.kind === kind);
  if (existing) {
    existing.remaining = def.duration;
    if (existing.burstT !== undefined) existing.burstT = 1.5;
    logTrace(`EPISODE RENEWED — ${def.label} (+${def.duration.toFixed(0)} s)`, true);
    refreshEpisodeAmbient();
    return;
  }
  const e = { kind, remaining: def.duration, label: def.label };
  if (kind === "deadline") e.burstT = 1.5;
  episodes.push(e);

  // Onset lumps — the acute signature of each stressor.
  switch (kind) {
    case "heat":
      agent.octopamine += 22; agent.arousal += 14;
      agent.threat += 5; agent.allostaticLoad += 8;
      break;
    case "queue":
      agent.dopamine -= 18; agent.sleepPressure += 12;
      agent.aversive += 10; agent.allostaticLoad += 10;
      break;
    case "deadline":
      agent.threat = Math.max(agent.threat, 76);
      agent.octopamine = Math.max(agent.octopamine, 66);
      agent.allostaticLoad += 8;
      break;
    case "tea":
      agent.dopamine += 45; agent.energy += 20;
      agent.threat = Math.max(0, agent.threat - 30);
      agent.sleepPressure = Math.max(0, agent.sleepPressure - 25);
      agent.serotonin += 15; agent.aversive = Math.max(0, agent.aversive - 10);
      agent.allostaticLoad = Math.round(agent.allostaticLoad * 0.6);
      break;
    case "inflation":
      agent.aversive += 12; agent.threat += 8;
      agent.allostaticLoad += 10;
      agent.marketInflation = 1;
      break;
  }

  logTrace(`EPISODE → ${def.label} — ${def.tagline} (${def.duration.toFixed(0)} s)`, true);
  refreshEpisodeAmbient();
}

/* Continuous ODE forcing while an episode is live. */
function forceEpisode(kind, dt) {
  switch (kind) {
    case "heat": // sensory overload: firing columns + OA, metabolic drain
      agent.energy -= 1.35 * dt;
      agent.octopamine += 1.6 * dt;
      agent.arousal += 2.5 * dt;
      agent.threat += 0.55 * dt;
      break;
    case "queue": // frustration: reward tone collapses, aversive + sleep climb
      agent.dopamine -= (1.6 + 0.05 * agent.dopamine) * dt;
      agent.aversive += 3.2 * dt;
      agent.sleepPressure += 1.05 * dt;
      agent.arousal -= 0.8 * dt;
      agent.serotonin = Math.max(0, agent.serotonin - 0.4 * dt);
      break;
    case "deadline": // acute spike: threat + OA reinforced, spontaneous panic
      agent.threat += 2.0 * dt;
      agent.octopamine += 1.8 * dt;
      agent.arousal += 4.5 * dt;
      agent.energy -= 0.9 * dt;
      break;
    case "tea": // restorative: reserves recover, aversive tone eases
      agent.energy += 3.0 * dt;
      agent.serotonin = Math.min(100, agent.serotonin + 2.0 * dt);
      agent.aversive = Math.max(0, agent.aversive - 2.0 * dt);
      break;
    case "inflation": // price-index pressure: metabolic triage + wariness
      agent.energy -= 0.4 * dt;
      agent.aversive += 1.8 * dt;
      agent.threat += 1.0 * dt;
      break;
  }
}

/* Circuit envelopes sustained by each stressor (stacked across episodes). */
function episodeAmbientFor(kind) {
  switch (kind) {
    case "heat":     return { 2: 0.52, 9: 0.46, 6: 0.30 };   // columns + AL + OA
    case "queue":    return { 3: 0.18, 7: 0.07 };             // aversive tone, faint CC
    case "deadline": return { 5: 0.52, 6: 0.42, 3: 0.35 };    // motor panic + arousal
    case "tea":      return { 8: 0.50, 4: 0.85 };             // gustatory → sustained PAM
    case "inflation": return { 9: 0.32, 2: 0.22, 3: 0.26 };   // AL + columns + aversive
    default:         return {};
  }
}

function refreshEpisodeAmbient() {
  const acc = {};
  for (const e of episodes) {
    for (const [tag, v] of Object.entries(episodeAmbientFor(e.kind))) {
      acc[tag] = Math.max(acc[tag] || 0, v);
    }
  }
  setEpisodeAmbient(acc);
}

function tickEpisodes(dt) {
  for (let i = episodes.length - 1; i >= 0; i--) {
    const e = episodes[i];
    e.remaining -= dt;
    forceEpisode(e.kind, dt);
    if (e.burstT !== undefined) {           // spontaneous deadline panic bursts
      e.burstT += dt;
      if (e.burstT > 2.4 + Math.random() * 1.8) { e.burstT = 0; panicBurst(); }
    }
    if (e.remaining <= 0) {
      episodes.splice(i, 1);
      logTrace(`EPISODE END — ${e.label}: stressor lifted, homoeostatic recovery begins`, false);
      if (e.kind === "queue") logTrace(`QUEUE END — PAM tone may re-sensitise; freeze posture releasing`, false);
    }
  }
  refreshEpisodeAmbient();
}

/* Allostatic load = wear-and-tear integral of stress; strainSeconds bridges
 * high OA + depleted PAM into a latched burnout (calcium hypo-reactivity). */
function updateAllostasis(dt) {
  let flux = 0;
  for (const e of episodes) {
    if (e.kind === "heat") flux += 1.8;
    else if (e.kind === "queue") flux += 1.4;
    else if (e.kind === "deadline") flux += 2.4;
    else if (e.kind === "inflation") flux += 0.8;
    else if (e.kind === "tea") flux -= 2.2;      // restorative episodes unburden
  }
  if (agent.energy < 25) flux += 0.04;          // energetic-workload contribution
  flux += agent.socioDebt * 0.02 + scarcity() * 0.5;  // socio-economic wear
  flux += agent.substanceStrain * 0.5;          // substance-dose baseline strain (ratchets)
  agent.substanceStrain = Math.max(0, agent.substanceStrain - 0.004 * dt);

  // First-order tolerance dynamics — dR/dt = −β·R. The acute pulse from each
  // dose (α) washes out continuously over minutes of abstinence, so the
  // GCaMP reward read-out re-sensitises (gcampTarget coupling below) and the
  // craving return-rate relaxes once the chemistry clears.
  const prevTol = agent.substanceTolerance;
  agent.substanceTolerance = Math.max(0, agent.substanceTolerance - SUBSTANCE.toleranceDecayBeta * dt);
  if (prevTol >= 10 && agent.substanceTolerance < 5 && !agent.tolWashLogged) {
    agent.tolWashLogged = true;
    logTrace("HOMEOSTATIC RE-SENSITISATION — tolerance washed out; reward readout recovering.", false);
  } else if (agent.substanceTolerance >= 10 && agent.tolWashLogged) {
    agent.tolWashLogged = false;
  }
  // Diminished allostatic recovery velocity — cumulative scarring slows the
  // baseline passive relief (recovery is never again free).
  const scarRelief = 0.35 * (1 - agent.cumulativeStress * 0.006);
  flux -= episodes.some((e) => e.kind === "tea") ? 2.0 : scarRelief;

  agent.allostaticLoad = clamp(agent.allostaticLoad + flux * dt, 0, 100);

  // Cumulative allostatic scarring — a monotone trace of severe stress that
  // cleanses only at a geological rate, and is NOT zeroed by ordinary payday
  // flushes. Accrues while deep load / learned helplessness dominates; erodes
  // only under sustained solvency with low load.
  if (agent.allostaticLoad > 50 || agent.resignationIndex > 0.6) {
    agent.cumulativeStress = Math.min(100, agent.cumulativeStress + 0.008 * (agent.allostaticLoad / 50) * dt);
  } else if (agent.allostaticLoad < 20 && scarcity() < 0.2) {
    agent.cumulativeStress = Math.max(0, agent.cumulativeStress - 0.0008 * dt);
  }

  // Geological kindling washout — the sensitization latch heals on an
  // epigenetic timescale (5× slower than scar), never on payday resets.
  agent.freezeKindle = Math.max(0, agent.freezeKindle - 0.00025 * dt);

  // Burnout criterion: prolonged (>30 s aggregate) octopamine-dominance with
  // PAM depletion — the ODE of chronic neuroendocrine strain. Brief dips in
  // the imbalance only dent, not erase, accumulated strain (slow -1/s relief).
  if (agent.octopamine > 50 && agent.dopamine < 34) {
    agent.strainSeconds += dt;
  } else {
    agent.strainSeconds = Math.max(0, agent.strainSeconds - dt);
  }

  const afferentStrain = agent.strainSeconds >= 30;
  if (afferentStrain && !agent.burnout) {
    agent.burnout = true;
    logTrace(`STRESS OVERLOAD — OA surge → PAM depleted → Learned Helplessness state active`, true);
  } else if (!afferentStrain && agent.burnout && agent.strainSeconds <= 8) {
    agent.burnout = false;
    logTrace(`HOMEOSTASIS RETURN — PAM tone recovered; helplessness state clearing`, false);
  }
  agent.gcampTarget = agent.burnout ? 0.35 : 1.0;   // blunted GCaMP amplitudes

  // Financial hypoxia — chronic cash scarcity blunts calcium responsiveness
  // even without a latched burnout: (scarcity)^2 folds into gcamp attenuation.
  agent.financialHypoxia = Math.pow(scarcity(), 2) * 0.5;
  // Substance tolerance further dulls the real GCaMP reward response — the
  // artificial chemistry corners the calcium instrument.
  agent.gcampTarget = clamp(
    (agent.burnout ? 0.35 : 1.0) - agent.financialHypoxia -
    agent.substanceTolerance * 0.0025,
    0.3, 1);

  if (agent.liquidityPct < 20 && !agent.hypoxiaLogged) {
    agent.hypoxiaLogged = true;
    logTrace("ALLOSTASIS ELEVATED — Chronic financial hypoxia detected → Blunting GCaMP responsiveness.", true);
  } else if (agent.liquidityPct > 45 && agent.hypoxiaLogged) {
    agent.hypoxiaLogged = false;
  }
}

/* Sporadic, weak central-complex transients while burned out. */
function burnoutSporadic(dt) {
  if (agent.burnout) {
    burnoutT += dt;
    if (burnoutT > 3.2 + Math.random() * 3.2) {
      burnoutT = 0;
      scheduleWave([[0, 7, 0.24], [240, 7, 0]]);
    }
  } else {
    burnoutT = 0;
  }
}

/* -------------------------------------------------------------------------
 * Socio-economic survival layer — "Drosophila Algeriana"
 * A monthly 40,000 DZD wage, fixed city liabilities (fixed habitat overhead
 * 18k, groceries 12k, utilities 5k), a 25% skim into reproductive capital,
 * market-inflation surges, kinship obligation levies, and street coffee all
 * couple economic scarcity back into the octopamine/dopamine axis, the
 * allostatic integral, and the sixth "economic-quiescence" posture.
 * ---------------------------------------------------------------------- */
const ECON = {
  grossIncome: 40000,
  skimRate: 0.25,
  disposableBase: 5000,
  fixedHabitatOverhead: 18000,
  groceriesPerMonth: 12000,
  billsPerMonth: 5000,
  paydayPeriod: 90,
  targetReproductiveCapital: 240000,
  daAlpha: 0.001125,
  daBeta: 0.0005,
  locoBurn: 40,
  escapeBurn: 70,
};

/* Saddle-node calibration block (non-linear dynamics audit, Q1) — the fold
 * locus L_sn(D) of the resignation nullcline and the Schmitt hysteresis gate
 * cash thresholds, exposed for empirical calibration of the freeze
 * bifurcation. liquidityPct = liquidityDZD / disposableBase * 100. */
const ANNIHILATION = {
  disposableBase: 5000,     // ECON.disposableBase (cash-denominated)
  freezeCashGate: 750,      // liquidityPct 15 → economic-freeze entry (DZD)
  blockCashGate: 1000,      // liquidityPct 20 → locomotion block (DZD)
  exitCashGate: 1500,       // liquidityPct 30 → freeze exit (DZD)
  resignGate: 0.6,          // resignation threshold for freeze latch
  debtGateLatch: 25,        // socioDebt hammer-latch even at high reserve
  marginAlarm: 150,         // fold-margin alarm band (DZD) — true critical proximity to the fold locus
};

/** R-nullcline fold liquidity: below this cash level the resignation nullcline
 *  has no branch → the active-foraging attractor is annihilated (a saddle-node
 *  in the reduced (L, R) slow map). Exact fold locus:
 *  L_sn(D) = D_b · 0.016·(1 + D/60) / (0.028 + 0.016·D/60). */
function foldCriticalLiquidity(D) {
  const a = 0.016 * (1 + D / 60), b = 0.012;
  return (ECON.disposableBase * a) / (a + b);
}

const SURVIVAL = {
  "ACTIVE FORAGING": "forage",
  "AUSTERE SAVING": "save",
  "CRITICAL DEFICIT": "deficit",
  "APATHETIC FREEZE": "freeze",
};

/* Associative substance learning — a conditioned escape vector.
 * substanceKnown gates the whole craving axis; the drive itself is a
 * misery integral (allostasis + PAM depletion + learned resignation).
 * Tolerance (+15% per authorized dose) accelerates craving recurrence and
 * dulls real GCaMP reward response — the artificial chemistry corners the
 * calcium instrument the way a payday "illusion" corners dopamine.
 * ---------------------------------------------------------------------- */
const SUBSTANCE = {
  dosePenaltyDZD: 800,
  reliefSeconds: 14,
  toleranceAlpha: 15,        // acute per-dose pulse on the tolerance integral (α)
  toleranceDecayBeta: 0.05,  // first-order washout rate per second (β): a single
                             // dose fully clears after ~5 min of abstinence
  curlOnset: 60,     // resting CC/PAM pulse threshold (1.2 Hz, magenta)
  demandOnset: 50,   // button glow threshold (amber, rhythmic)
  cravingAlpha: 0.03,// base craving-return kinetics (per 250 ms tick)
  strainPerDose: 0.5,
};

let socioGateLogged = false;
let survivalOverrideLogged = false;

function scarcity() {
  return clamp(1 - agent.liquidityPct / 100, 0, 1);
}

function spend(dzd) {
  agent.liquidityDZD = Math.max(0, agent.liquidityDZD - dzd);
}

/* Positive prediction error — a realised economic gain scaled into a PAM
 * dopamine RPE bump via daAlpha (the "payday illusion": the nominal gross
 * spike precedes the deduction cascade). */
function receive(dzd) {
  agent.dopamine = clamp(agent.dopamine + dzd * ECON.daAlpha, 0, 100);
  agent.liquidityDZD += dzd;
}

/* Realised loss — PPL1-side aversive salience via daBeta. */
function realisedLoss(dzd) {
  agent.aversive = clamp(agent.aversive + dzd * ECON.daBeta, 0, 100);
}

function refreshSocioMetrics() {
  agent.liquidityPct = clamp((agent.liquidityDZD / ECON.disposableBase) * 100, 0, 100);
  agent.reproductiveReserveRatio = clamp(agent.reproductiveCapitalDZD / ECON.targetReproductiveCapital, 0, 1);
  agent.reproductiveCapitalReady = agent.reproductiveCapitalDZD >= ECON.targetReproductiveCapital;
}

function updateSocioEconomics(dt) {
  refreshSocioMetrics();

  // Saddle-node proximity monitor (Q1c) — live margin to the R-nullcline fold
  // locus; one-shot alarm when the foraging attractor is about to annihilate.
  // Recalibrated (Q1-fix): fires only at genuine fold proximity (within the
  // marginAlarm band), not during the solvent cyclical monthly drain. Reset
  // above the fold plus the freeze-entry buffer on the recovery rebound.
  const foldMargin = agent.liquidityDZD - foldCriticalLiquidity(agent.socioDebt);
  if (foldMargin < ANNIHILATION.marginAlarm && !agent.foldWarningLogged) {
    agent.foldWarningLogged = true;
    logTrace("FOLD CRITICAL · R-NULLCLINE ANNIHILATED", true);
  } else if (foldMargin > ANNIHILATION.freezeCashGate && agent.foldWarningLogged) {
    agent.foldWarningLogged = false;
  }

  agent.fixedOverheadAccumulator += (ECON.fixedHabitatOverhead / ECON.paydayPeriod) * dt;
  // fixedOverheadAccumulator — the continuous accrual of unpaid fixed habitat
  // overhead in DZD — is the "impending obligation" integrator consumed by the
  // dread gradient.

  // Auto-payday cadence — one sim-month every `paydayPeriod` seconds.
  agent.paydayCountdown -= dt;
  if (agent.paydayCountdown <= 0) doPayday();

  // Continuous idle burn: fixed cost-of-living plus behaviour-specific
  // metabolic triage, inflated up to ×1.8 during a market inflation surge.
  const inflMult = 1 + agent.marketInflation * 0.8;
  agent.marketInflation = Math.max(0, agent.marketInflation - dt * 2);
  const activeBurn =
    agent.behavior === "locomotion" ? ECON.locoBurn :
    agent.behavior === "escape"     ? ECON.escapeBurn : 0;
  spend((ECON.disposableBase / ECON.paydayPeriod) * inflMult * dt +
        activeBurn * inflMult * dt);

  // Scarce cash + debt raise the threat floor (folded into updateVitals, so
  // threat gravitates to a scarcity-raised baseline rather than an unbounded
  // escalator — acute episodes stay able to briefly tip the fly into escape).
  if (agent.coffeeTimer > 0) {
    agent.threat = clamp(agent.threat - 2.5 * dt, 0, 100);
    agent.coffeeTimer = Math.max(0, agent.coffeeTimer - dt);
  }

  // Resignation index — learned economic helplessness. Climbs sharply under
  // scarcity and debt (reaching the freeze threshold within the first month
  // or two, while reproductive capital is still thin), decays while solvent, and
  // eases with a coffee lift.
  const s = scarcity();
  // Active cognitive dampener: while the substance relief window lasts,
  // resignation (learned helplessness) erodes faster than scarcity rebuilds
  // it — intoxication actively discounts learned futility, extending the
  // decoupling past the acute PPL1 silence.
  const reliefDecay = agent.substanceReliefTimer > 0 ? 0.05 : 0;
  agent.resignationIndex = clamp(
    agent.resignationIndex +
    (0.016 * s * (1 + agent.socioDebt / 60)) * dt -
    (0.012 * (1 - s) + 0.01 * (agent.coffeeTimer > 0 ? 1 : 0) + reliefDecay) * dt,
    0, 1);

  // Social debts are repaid only while the budget is solvent.
  if (agent.liquidityPct > 75) {
    agent.socioDebt = Math.max(0, agent.socioDebt - 0.4 * dt);
  }
  agent.socioDebt = clamp(agent.socioDebt, 0, 60);

  // Social capital erodes slowly under isolation — bonds must be actively
  // maintained or they decay back toward solitude.
  agent.socialCapital = Math.max(0, agent.socialCapital - 0.005 * dt);

  // Bond-gated reverse bailout (Q4) — an insolvent bondholder draws on the
  // actuarial solidarity pool: the entitlement scales with accumulated social
  // capital, and the draw is rebooked as socio-debt, so the pool
  // re-equilibrates into a risk-pooling steady state rather than a free lunch.
  if (agent.liquidityPct < 10 && agent.solidarityPool > 500 && agent.socialCapital > 15) {
    const deficit = ANNIHILATION.freezeCashGate - agent.liquidityDZD;
    const draw = Math.floor(Math.min(deficit, agent.solidarityPool * (agent.socialCapital / 100)));
    if (draw > 0) {
      agent.liquidityDZD += draw;
      agent.solidarityPool -= draw;
      agent.socioDebt = Math.min(60, agent.socioDebt + 0.02 * draw);
      logTrace(`[NETWORK REVERSE BAILOUT] Drew ${draw.toLocaleString()} DZD from solidarity pool (bond-gated).`, true);
      refreshSocioMetrics();
    }
  }
}

/* Associative craving dynamics. The desire drive is only authorised once the
 * fly has held a first exposure — after imprinting, craving tracks the
 * "misery integral": 0.4·allostaticLoad + 0.4·(100−PAM dopamine) +
 * 0.2·resignationIndex. Tolerance scales the return rate and the ceiling
 * (recurrence accelerates), so repeated dosing corners the instrument. */
function updateSubstance(dt) {
  const raw =
    agent.substanceKnown
      ? 0.4 * agent.allostaticLoad +
        0.4 * (100 - agent.dopamine) +
        0.2 * agent.resignationIndex * 100
      : 0;

  // Tolerance → faster craving recurrence and a higher sustained peak.
  const k = SUBSTANCE.cravingAlpha + agent.substanceTolerance * 0.0015;
  const target = clamp(raw * (1 + agent.substanceTolerance * 0.004), 0, 100);
  agent.substanceCraving = clamp(
    agent.substanceCraving + (target - agent.substanceCraving) * Math.min(1, k * (dt / 0.25)),
    0, 100);

  // One-shot neural request log per high-desire episode.
  if (agent.substanceCraving > SUBSTANCE.curlOnset && !agent.cravingLogged) {
    agent.cravingLogged = true;
    logTrace("[NEURAL DESIRE]: Scarcity & Allostasis peaked -> Central Complex requesting chemical override.", true);
  } else if (agent.substanceCraving < SUBSTANCE.curlOnset - 12 && (agent.cravingLogged || agent.escapeDenied)) {
    agent.cravingLogged = false;
    agent.escapeDenied = false;
  }
}

/* User-authorised dose — the chemical escape. PPL1 aversive is silenced for
 * reliefSeconds, craving is flushed, tolerance pulses up by toleranceAlpha
 * (then washes out first-order in updateAllostasis), and the baseline strain
 * climbs: recovery from here is never free. */
function authorizeDose() {
  // Solvency veto — escape is not free. If the ledger cannot cover the dose,
  // the chemical relief is aborted and the unfulfilled craving is redirected
  // into an acute spike of allostatic strain + octopaminergic restlessness
  // (the "denied escape" cascade).
  if (agent.liquidityDZD < SUBSTANCE.dosePenaltyDZD) {
    agent.allostaticLoad = clamp(agent.allostaticLoad + 6, 0, 100);
    agent.aversive = clamp(agent.aversive + 12, 0, 100);
    agent.threat = clamp(agent.threat + 10, 0, 100);
    agent.octopamine = clamp(agent.octopamine + 8, 0, 100);
    agent.substanceCraving = clamp(agent.substanceCraving + 20, 0, 100);
    if (!agent.escapeDenied) {
      agent.escapeDenied = true;
      logTrace("[ESCAPE DENIED]: insolvent — craving redirected into allostatic strain + octopaminergic restlessness.", true);
    }
    scheduleWave([
      [0,   6, 0.60],   // OA-VUM arousal frustration burst
      [90,  3, 0.50],   // PPL1 aversive reinforcement of the denial
      [240, 6, 0],
      [300, 3, 0],
    ]);
    return;
  }
  agent.escapeDenied = false;

  const first = !agent.substanceKnown;
  if (first) {
    agent.substanceKnown = true;
    logTrace("[ASSOCIATIVE IMPRINT]: Novel substance ingested -> Pain muted -> Mushroom body memorizes escape vector.", true);
  } else {
    const tol = clamp(agent.substanceTolerance + SUBSTANCE.toleranceAlpha, 0, 100);
    logTrace(`[RELIEF AUTHORIZED]: Artificial dopamine surge granted -> Tolerance index escalated to ${Math.round(tol)}%.`, true);
  }

  spend(SUBSTANCE.dosePenaltyDZD);                       // discretionary liquidity
  agent.substanceReliefTimer = SUBSTANCE.reliefSeconds;  // PPL1 silence window
  agent.substanceCraving = 0;                            // temporary flush
  agent.cravingLogged = false;
  agent.substanceTolerance = clamp(agent.substanceTolerance + SUBSTANCE.toleranceAlpha, 0, 100);
  agent.substanceStrain = clamp(
    agent.substanceStrain + SUBSTANCE.strainPerDose * (1 + agent.substanceTolerance * 0.01),
    0, 12);
  agent.dopamine = clamp(agent.dopamine + (first ? 34 : 22), 0, 100);  // artificial surge
  agent.allostaticLoad = clamp(agent.allostaticLoad + 3, 0, 100);

  // Cognitive dampener — acute discounting of learned helplessness. The
  // relief window also actively erodes resignation while it lasts, so the
  // future-liability layer is decoupled from CC arbitration on both timescales.
  agent.resignationIndex = clamp(agent.resignationIndex - 0.35, 0, 1);
  logTrace("[COGNITIVE DECOUPLING]: relief window bypasses CC arbitration gates -> future liabilities discounted, escapist drive released.", true);

  scheduleWave([
    [0,   4, 0.95],   // PAM artificial surge
    [90,  7, 0.85],   // CC relay registers the memorised escape vector
    [500, 4, 0.0],
    [600, 7, 0.0],
  ]);
  refreshSocioMetrics();
}

let PAYDAY_EPOCH = 0;   // generation token — invalidates inflight liability timeouts

function doPayday() {
  if (agent.paydayCountdown > ECON.paydayPeriod - 1.0) return;   // re-entry cooldown (D2)
  const epoch = ++PAYDAY_EPOCH;                                  // capture generation (D1)
  const skim = ECON.grossIncome * ECON.skimRate;       // 10,000 DZD → reproductive capital
  receive(ECON.grossIncome);                           // nominal gross → RPE
  agent.reproductiveCapitalDZD = clamp(agent.reproductiveCapitalDZD + skim, 0, ECON.targetReproductiveCapital);
  agent.fixedOverheadAccumulator = 0;
  agent.paydayCountdown = ECON.paydayPeriod;

  logTrace("PAYDAY INGESTION — +40,000 DZD → PAM DA spike (+45) → Immediate fixed liability drain.", true);
  scheduleWave([
    [0,   4, 0.75],
    [240, 4, 0.0],
  ]);

  // Fixed-liability cascade: fixed habitat overhead → groceries → utilities across 3 s.
  // Each callback bails if the payday generation has been superseded (reset/refire),
  // so stale deductions can never land on a newer ledger (race defect D1).
  setTimeout(() => {
    if (epoch !== PAYDAY_EPOCH) return;
    spend(ECON.fixedHabitatOverhead);
    realisedLoss(ECON.fixedHabitatOverhead);
    logTrace("FIXED HABITAT OVERHEAD DEDUCTION — -18,000 DZD → Liquidity critically pruned.", true);
  }, 1000);
  setTimeout(() => {
    if (epoch !== PAYDAY_EPOCH) return;
    spend(ECON.groceriesPerMonth);
    realisedLoss(ECON.groceriesPerMonth);
    logTrace("GROCERIES DEDUCTION — -12,000 DZD → subsistence secured; buffer spent.", false);
  }, 2000);
  setTimeout(() => {
    if (epoch !== PAYDAY_EPOCH) return;
    spend(ECON.billsPerMonth);
    realisedLoss(ECON.billsPerMonth);
    logTrace("UTILITIES DEDUCTION — -5,000 DZD → household baseline cleared.", false);
  }, 3000);

  refreshSocioMetrics();
}

function kinExogenousShock() {
  // Status taxation ("black tax") — high social standing attracts larger kin
  // demands: up to +65% for a fully bonded fly.
  const statusMultiplier = 1.0 + (agent.socialCapital / 100) * 0.65;
  const baseDemand = 8000 + Math.random() * 5000;
  const amount = Math.round(baseDemand * statusMultiplier);   // 8–13k DZD × status
  logTrace(`KIN LEVY · STATUS SCALED — kinship request ${amount.toLocaleString()} DZD for a familial milestone (Buffer: ${Math.round(agent.socialCapital)}%).`, true);
  let settled = false;

  // Trilemma #1 — settle from the cash buffer: rewarding.
  if (agent.liquidityPct >= 18 && agent.liquidityDZD >= amount) {
    spend(amount);
    agent.serotonin = clamp(agent.serotonin + 12, 0, 100);
    agent.aversive = clamp(agent.aversive - 8, 0, 100);
    agent.socioDebt = Math.max(0, agent.socioDebt - 12);
    settled = true;
    // Obligation fatigue — consolidation reward diminishes near the bond
    // ceiling (14 → ~3), so repeated settlements cannot trivially pin 100.
    const incrementalGain = Math.round(14 * (1.0 - agent.socialCapital / 110));
    agent.socialCapital = Math.min(100, agent.socialCapital + Math.max(3, incrementalGain));
    // Reciprocal premium — a settled levy posts a κ-scaled dues into the
    // solidarity pool, mirroring the demand multiplier f(κ) = 0.3·(1+0.65κ)
    // so that premium-in stays in actuarial balance with expected claim-out.
    const premium = Math.round(0.3 * amount * (1 + 0.65 * agent.socialCapital / 100));
    agent.solidarityPool += premium;
    scheduleWave([[0, 8, 0.45], [90, 4, 0.55], [420, 8, 0], [520, 4, 0]]);
    logTrace("SOCIAL OBLIGATION CLEARED — shared resources uphold kin reciprocity; serotonin reward.", false);
    logTrace("[SOCIAL CAPITAL CONSOLIDATED] — bond deepened by mutual support, threat buffer strengthened.", true);
  } else if (agent.reproductiveCapitalDZD >= amount) {
    // Trilemma #2 — raid reproductive capital: the courtship gate slips.
    agent.reproductiveCapitalDZD = Math.max(0, agent.reproductiveCapitalDZD - amount);
    agent.aversive = clamp(agent.aversive + 14, 0, 100);
    agent.allostaticLoad = clamp(agent.allostaticLoad + 8, 0, 100);
    settled = true;
    scheduleWave([[0, 3, 0.45], [200, 3, 0]]);
    logTrace("SOCIAL OBLIGATION COVERED FROM REPRODUCTIVE CAPITAL — reserve raided; courtship gate slips.", true);
  }

  if (!settled) {
    // Trilemma #3 — defer: debt + allostatic wear + aversive tone surge +
    // erosion of the social bond.
    agent.socialCapital = Math.max(0, agent.socialCapital - 16);
    agent.socioDebt = clamp(agent.socioDebt + 15, 0, 60);
    agent.allostaticLoad = clamp(agent.allostaticLoad + 20, 0, 100);
    agent.aversive = clamp(agent.aversive + 20, 0, 100);
    agent.threat = clamp(agent.threat + 15, 0, 100);
    scheduleWave([[0, 3, 0.60], [180, 3, 0]]);
    logTrace("SOCIAL OBLIGATION DEFERRED — allo-parental levy unmet; kin standing + allostatic cost surge.", true);
  }

  refreshSocioMetrics();
}

function takeCoffee() {
  if (agent.coffeeTimer > 0) {
    logTrace("STREET COFFEE — on a fresh caffeinated lift; a second cup resets the relief window.", false);
  }
  agent.coffeeTimer = 8;
  agent.dopamine = clamp(agent.dopamine + 15, 0, 100);
  agent.threat = clamp(agent.threat - 25, 0, 100);
  spend(200);
  scheduleWave([
    [0,   8, 0.85],
    [120, 4, 0.70],
    [600, 8, 0.0],
    [900, 4, 0.0],
  ]);
  logTrace("STREET COFFEE — gustatory pick-me-up → PAM lift; -200 DZD, threat -25.", true);
  refreshSocioMetrics();
}

function survivalPosture() {
  const s = scarcity();
  if (s > 0.85 || agent.resignationIndex > 0.75) return "APATHETIC FREEZE";
  if (agent.liquidityPct < 15) return "CRITICAL DEFICIT";
  if (s > 0.45 || agent.reproductiveReserveRatio < 0.4) return "AUSTERE SAVING";
  return "ACTIVE FORAGING";
}

function updateVitals(dt) {
  agent.phase = (agent.phase + dt / 10) % 24;

  const drain = {
    locomotion: 0.95, grooming: 0.45, escape: 1.5,
    quiescence: 0.05, apathy: 0.05, economicIdling: 0.05,
  }[agent.behavior] || 0.5;
  const drainMult = isEpisode("inflation") ? 1.8 : 1;   // price-index viability drain
  // Neuro-metabolic basal inefficiency (Q3) — cumulative scarring raises the
  // resting ATP-maintenance sink per soma (×1.0 → ×1.45 at full scar + burnout),
  // and precarity adds a scarcity/debt-proportional burden even while idle:
  // chronically strained cells never stop paying the upkeep bill.
  const metabolicInefficiency = 1.0 + 0.45 * (agent.cumulativeStress / 100) * (agent.burnout ? 1.4 : 1.0);
  const precarityBurden = 0.02 * (1 - agent.liquidityPct / 100) * (1 + 0.6 * (agent.socioDebt / 60));
  // Desperate scavenging: while the metabolic-rescue override is active the
  // starving fly ingests whatever it can. The band (<25) sits above the
  // override threshold (<20) as hysteresis so the fly climbs clear of
  // starvation before normal socio-economic gating resumes — a genuine rescue.
  let feed = agent.behavior === "quiescence" ? 1.1 : 0;
  if (agent.behavior === "locomotion" && agent.energy < 25 && agent.threat < 50) feed += 1.3;
  agent.energy += (feed - (drain * drainMult * metabolicInefficiency + precarityBurden)) * dt;
  if (agent.behavior !== "quiescence") agent.energy -= 0.14 * dt;

  const dayDrive = 0.55 + 0.45 * Math.sin((agent.phase / 24) * Math.PI * 2);
  agent.arousal = lerp(agent.arousal, 46 * dayDrive, Math.min(1, dt * 0.04));
  if (agent.behavior === "locomotion") agent.arousal += 4.5 * (1 - scarcity() * 0.85) * dt;
  if (agent.behavior === "escape") agent.arousal += 9.0 * dt;

  agent.sleepPressure += (agent.behavior === "quiescence" ? -5.2 : 0.55) * dt;

  // Anticipatory dread gradient — looming liabilities. fixedOverheadAccumulator
  // is the continuous accrual of unpaid fixed habitat overhead (DZD); as the
  // payday horizon closes the dread factor ramps toward 1.0, pumping tonic
  // threat and octopaminergic drive days before the fixed expenses are actually
  // deducted. Payday resets the ledger and the gradient collapses (brief
  // serenity before the shock).
  // Social buffering blunts the anticipation itself: strong bonds deflate the
  // dread envelope (up to −45%) before it ever reaches the threat floor.
  const socialBuffer = agent.socialCapital / 100;
  const dread =
    Math.min(1.0, (agent.fixedOverheadAccumulator / ECON.fixedHabitatOverhead) * (1 - agent.paydayCountdown / ECON.paydayPeriod)) *
    (1.0 - socialBuffer * 0.45);

  // Chronic strain + socio-economic deficit raise the threat floor;
  // acute episodes still spike threat above it, and it decays on recovery.
  // An authorised dose silences the PPL1 aversive circuit for 14 s — the
  // scarcity leg of the threat floor is cut and aversive tone clamps low.
  const avSilenced = agent.substanceReliefTimer > 0;
  agent.substanceReliefTimer = Math.max(0, agent.substanceReliefTimer - dt);
  const threatFloor =
    14 + agent.allostaticLoad * 0.25 +
    scarcity() * 30 * (avSilenced ? 0.4 : 1) + agent.socioDebt * 0.8 +
    dread * 18.0 - socialBuffer * 8.0;
  agent.threat = lerp(agent.threat, threatFloor, Math.min(1, dt * 0.07));
  agent.octopamine = lerp(agent.octopamine, 36 + scarcity() * 12 + dread * 10.0, Math.min(1, dt * 0.05));
  // Scarred dopamine baseline — cumulative allostatic damage permanently (until
  // geological washout) lowers the maximal reward set-point: −15 units at a
  // full 100% scar.
  const scarredDaTarget = 45 - (agent.cumulativeStress * 0.15);
  agent.dopamine = lerp(agent.dopamine, scarredDaTarget, Math.min(1, dt * 0.045));
  agent.aversive = lerp(agent.aversive, avSilenced ? 14 : 40, Math.min(1, dt * (avSilenced ? 0.09 : 0.045)));
  // Serotonergic baseline boost — social bonds raise the tonic 5-HT set-point
  // (up to +10 at a full bond).
  agent.serotonin = lerp(agent.serotonin, Math.min(100, 52 + agent.socialCapital * 0.1), Math.min(1, dt * 0.03));

  if (agent.behavior === "escape") {
    agent.octopamine += 3.0 * dt;
    agent.arousal += 3.0 * dt;
    agent.aversive += 2.6 * dt;
  }

  const keys = ["energy", "arousal", "sleepPressure", "threat",
                "octopamine", "dopamine", "aversive", "serotonin"];
  for (const k of keys) agent[k] = clamp(agent[k], 0, 100);
}

function renderDashboard() {
  el.m.energy.textContent = Math.round(agent.energy);
  el.m.arousal.textContent = Math.round(agent.arousal);
  el.m.sleep.textContent = Math.round(agent.sleepPressure);
  el.m.dopamine.textContent = Math.round(agent.dopamine);
  el.m.aversive.textContent = Math.round(agent.aversive);
  el.m.octopamine.textContent = Math.round(agent.octopamine);
  el.m.serotonin.textContent = Math.round(agent.serotonin);
  el.m.threat.textContent = Math.round(agent.threat);
  el.m.phase.textContent = "ZT " + Math.floor(agent.phase) + ":" +
    String(Math.floor((agent.phase % 1) * 60)).padStart(2, "0");

  el.b.energy.style.width = agent.energy + "%";
  el.b.arousal.style.width = agent.arousal + "%";
  el.b.sleep.style.width = agent.sleepPressure + "%";
  el.b.phase.style.width = (agent.phase / 24) * 100 + "%";
  el.b.dopamine.style.width = agent.dopamine + "%";
  el.b.aversive.style.width = agent.aversive + "%";
  el.b.octopamine.style.width = agent.octopamine + "%";
  el.b.serotonin.style.width = agent.serotonin + "%";
  el.b.threat.style.width = agent.threat + "%";

  el.confVal.textContent = Math.round(agent.confidence * 100) + " %";
  el.confFill.style.width = (agent.confidence * 100).toFixed(1) + "%";

  // Calcium feedback telemetry — upstream CC excitation reservoir + effective
  // arbitration temperature (excitotoxicity-induced decisiveness loss).
  if (el.ccExcite) el.ccExcite.textContent = agent.ccExcite.toFixed(2);
  if (el.ccTemp) el.ccTemp.textContent = (agent.effectiveTemp || 14).toFixed(2);

  // Allostatic load + burnout chip
  el.m.load.textContent = Math.round(agent.allostaticLoad);
  el.b.load.style.width = agent.allostaticLoad + "%";
  el.b.load.classList.toggle("burn", agent.burnout);
  el.modeChip.textContent = agent.burnout ? "BURNOUT" : "AUTO";
  el.modeChip.classList.toggle("burnout", agent.burnout);

  // Episodic-stressor countdown + active glow
  for (const k of Object.keys(el.hints)) {
    const ex = episodes.find((e) => e.kind === k);
    const btn = document.getElementById("btn-" + k);
    if (btn) btn.classList.toggle("active", !!ex);
    const node = el.hints[k];
    if (node && EPISODE_DEFS[k]) node.textContent = ex ? `± ${Math.ceil(ex.remaining)} s` : EPISODE_DEFS[k].hint;
  }

  // Socio-economic gauges
  el.m.liq.textContent = Math.max(0, Math.round(agent.liquidityDZD)).toLocaleString();
  el.b.liq.style.width = agent.liquidityPct + "%";
  el.b.liq.classList.toggle("low", agent.liquidityPct < 15);
  el.b.liq.classList.toggle("mid", agent.liquidityPct >= 15 && agent.liquidityPct < 40);

  el.m.repro.textContent = Math.round(agent.reproductiveReserveRatio * 100) + "%";
  el.b.repro.style.width = (agent.reproductiveReserveRatio * 100).toFixed(1) + "%";
  el.b.repro.classList.toggle("ready", agent.reproductiveCapitalReady);

  // Cumulative allostatic scar + social capital (buffering hypothesis) gauges
  el.m.scar.textContent = Math.round(agent.cumulativeStress);
  el.b.scar.style.width = agent.cumulativeStress + "%";
  el.b.scar.classList.toggle("high", agent.cumulativeStress > 50);
  el.m.social.textContent = Math.round(agent.socialCapital);
  el.b.social.style.width = agent.socialCapital.toFixed(1) + "%";
  el.b.social.classList.toggle("high", agent.socialCapital > 60);

  const inflOn = isEpisode("inflation");
  el.m.infl.textContent = inflOn ? "ON" : "OFF";
  el.b.infl.style.width = (inflOn ? 100 : 0) + "%";
  el.b.infl.classList.toggle("mid", agent.allostaticLoad > 50 && !inflOn);
  el.b.infl.classList.toggle("high", inflOn);

  const posture = survivalPosture();
  el.survival.textContent = posture;
  el.survival.classList.remove("forage", "save", "deficit", "freeze");
  el.survival.classList.add(SURVIVAL[posture] || "forage");

  // Payday + coffee countdowns
  if (el.paydayHint) el.paydayHint.textContent = `${Math.ceil(Math.max(0, agent.paydayCountdown))} s · +40,000 DZD`;
  if (el.coffeeHint) el.coffeeHint.textContent = agent.coffeeTimer > 0 ? `RELIEF · ${Math.ceil(agent.coffeeTimer)} s` : "GUSTATORY · PAM";

  // Substance craving — dynamic misery gauge + authorisation button states.
  const craving = agent.substanceCraving;
  if (el.m.substance) el.m.substance.textContent = Math.round(craving);
  if (el.b.substance) {
    el.b.substance.style.width = craving.toFixed(1) + "%";
    el.b.substance.classList.toggle("hot", craving > SUBSTANCE.curlOnset);
  }
  if (el.substanceTol) el.substanceTol.textContent = Math.round(agent.substanceTolerance);

  if (el.substanceLabel) {
    el.substanceLabel.textContent = agent.substanceKnown
      ? "Authorize Chemical Relief (Dose)"
      : "Sample Unknown Substance (First Exposure)";
  }
  if (el.hints.substance) {
    el.hints.substance.textContent = !agent.substanceKnown
      ? "NOVEL · UNKNOWN"
      : agent.substanceReliefTimer > 0
        ? `RELIEF · ${Math.ceil(agent.substanceReliefTimer)} s`
        : agent.escapeDenied
          ? "DENIED · INSOLVENT"
          : craving > SUBSTANCE.demandOnset
            ? "NEURAL REQUEST · GRANT?"
            : "CONDITIONED ESCAPE";
  }
  const sb = $("btn-substance");
  if (sb) {
    sb.classList.toggle("craving-pulse", agent.substanceKnown && craving > SUBSTANCE.demandOnset);
    sb.classList.toggle("relief", agent.substanceReliefTimer > 0);
  }
}

/* -------------------------------------------------------------------------
 * Homeostatic state reset controller — soft reboot.
 * Re-initialises every dynamic behavioural / metabolic variable WITHOUT
 * touching the WebGL context. Connectome buffers stay pinned in GPU memory;
 * only state resets. Zero fetch, zero promise churn.
 * ---------------------------------------------------------------------- */
function resetHomeostasis() {
  Object.assign(agent, {
    energy: 100, arousal: 46, phase: 10.5, sleepPressure: 10,
    dopamine: 45, aversive: 42, octopamine: 38, serotonin: 52, threat: 16,
    behavior: "locomotion", confidence: 0.62, dwell: 0,
    allostaticLoad: 0, strainSeconds: 0, burnout: false,
    cumulativeStress: 0,
    gcamp: 1.0, gcampTarget: 1.0,
    ccExcite: 0.0, effectiveTemp: 14.0,
    liquidityDZD: 5000, reproductiveCapitalDZD: 0, fixedOverheadAccumulator: 0,
    socioDebt: 8, resignationIndex: 0.35, liquidityPct: 100,
socialCapital: 20,
  freezeKindle: 0, freezeCount: 0, foldWarningLogged: false, solidarityPool: 0,
    reproductiveReserveRatio: 0, paydayCountdown: 60, coffeeTimer: 0,
    marketInflation: 0, financialHypoxia: 0, hypoxiaLogged: false,
    reproductiveCapitalReady: false,
    substanceKnown: false, substanceCraving: 0, substanceTolerance: 0,
    substanceReliefTimer: 0, substanceStrain: 0, cravingLogged: false,
    tolWashLogged: false, escapeDenied: false,
    substancePulsePhase: 0,
  });

  episodes.length = 0;          // clear active chronic-stressor episodes
  burnoutT = 0;
  socioGateLogged = false;
  survivalOverrideLogged = false;
  ambientS.clear();             // behaviour-state ambient stack
  ambientE.clear();             // chronic-episode ambient stack

  // Extinguish all circuit transients — resting slate restored.
  for (const layer of layers.values()) {
    layer.env = 0;
    layer.flash = 0;
    layer.ambient = 0;
  }

  PAYDAY_EPOCH++;   // invalidate any inflight payday liability timeouts (race defect D1)

  applyBehaviourUI(agent.behavior);
  applyStateAmbient(agent.behavior);
  refreshSocioMetrics();
  renderDashboard();
  logTrace("[SYSTEM RESET]: Homeostatic baseline re-established | Zero allostatic load | Connectome buffer preserved.", true);
}

/* -------------------------------------------------------------------------
 * Circuit reference modal — toggle helper (open state via force flag).
 * ---------------------------------------------------------------------- */
function toggleCircuitModal(force) {
  const modal = $("circuit-modal");
  const open = force !== undefined ? force : !modal.classList.contains("open");
  modal.classList.toggle("open", open);
}

/* -------------------------------------------------------------------------
 * Stimulus injection — travelling-wave calcium transients
 * ---------------------------------------------------------------------- */
function fireStimulus(kind) {
  switch (kind) {
    case "sensory": // Visual pulse: optic columns → central complex → fade 600ms
      agent.dopamine = clamp(agent.dopamine + 7, 0, 100);
      agent.threat = clamp(agent.threat - 3, 0, 100);
      scheduleWave([
        [0,   1, 1.00],  // LC/LPLC columnar projection neurons
        [70,  2, 0.60],  // T-series motion columns light, propagating inward
        [160, 7, 0.50],  // signal reaches the central complex relay
        [330, 1, 0.0],
        [380, 2, 0.0],
        [400, 7, 0.0],
      ]);
      logTrace("VISUAL PULSE — optic columns → CC transient (≈600 ms)", true);
      if (agent.behavior === "quiescence") switchBehavior("locomotion", true);
      break;

    case "threat": // Predator shadow: looming → PPL1 → giant-fibre escape
      agent.threat = clamp(agent.threat + 38, 0, 100);
      agent.aversive = clamp(agent.aversive + 16, 0, 100);
      agent.octopamine = clamp(agent.octopamine + 12, 0, 100);
      scheduleWave([
        [0,   1, 1.00],  // LC4/LPLC2 looming detection (optic)
        [70,  3, 0.90],  // PPL1 aversive dopamine (MB salience)
        [150, 6, 0.70],  // OA-VUM arousal surge
        [190, 5, 1.00],  // giant-fibre / descending escape motor
        [430, 1, 0.0],
        [460, 3, 0.0],
        [480, 6, 0.0],
        [520, 5, 0.0],
      ]);
      logTrace("PREDATOR SHADOW — PPL1 + giant-fibre escape circuit", true);
      break;

    case "forage": // Sugar reward: gustatory → sustained PAM reward glow
      agent.dopamine = clamp(agent.dopamine + 22, 0, 100);
      agent.energy = clamp(agent.energy + 3, 0, 100);
      agent.sleepPressure = clamp(agent.sleepPressure - 8, 0, 100);
      scheduleWave([
        [0,   8, 0.55],  // gustatory taste neurons (BM_Taste / claw_tpGRN)
        [90,  4, 0.85],  // PAM reward dopamine — sustained coral glow
        [400, 8, 0.0],   // gustatory fades
        [1000, 4, 0.0],  // PAM persists a beat longer, then decays
      ]);
      logTrace("SUGAR REWARD — PAM-positive reinforcement (sustained)", true);
      break;
  }

  if (agent.threat > 62 && !(agent.burnout && agent.dopamine < 25)) switchBehavior("escape", true);
}

/* -------------------------------------------------------------------------
 * Animation loop
 * ---------------------------------------------------------------------- */
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = clamp(clock.getDelta(), 0, 0.1);
  const renderDt = Math.min(dt, 0.033);

  // Ease toward the burnout-blunted GCaMP gain (calcium hypo-reactivity).
  agent.gcamp += (agent.gcampTarget - agent.gcamp) * Math.min(1, renderDt * 0.8);

  // Associative craving signature: when desire > onset, Central Complex and
  // PAM dopamine clusters adopt a restless 1.2 Hz magenta/coral pulse.
  const craveBlend = agent.substanceCraving > SUBSTANCE.curlOnset
    ? clamp((agent.substanceCraving - SUBSTANCE.curlOnset) / 15, 0, 1) : 0;
  let cravePulse = 0;
  if (craveBlend > 0) {
    agent.substancePulsePhase += Math.PI * 2 * 1.2 * renderDt;
    cravePulse = (0.5 + 0.5 * Math.sin(agent.substancePulsePhase)) * craveBlend;
  }

  for (const layer of layers.values()) {
    let target = clamp(layer.ambient + layer.flash, 0, 1.1);
    if (layer.craveSource) target = clamp(target + cravePulse * 0.6, 0, 1.1);
    // Fast attack, slower release (GCaMP-style transient).
    const rise = 1 - Math.exp(-renderDt * 9);
    const relax = 1 - Math.exp(-renderDt * 3.4);
    layer.env += (target - layer.env) * (target >= layer.env ? rise : relax);

    // Gain multiplies pre-clamped vertex colours — never exceeds [0,1].
    // Under craving the CC/PAM scalar shifts to a magenta tint (R↑, G↓, B↑).
    const c = layer.env * agent.gcamp;
    if (layer.craveSource && cravePulse > 0.02) {
      layer.mat.color.set(
        c * (1 + 0.5 * cravePulse),
        c * (1 - 0.5 * cravePulse),
        c * (1 + 0.2 * cravePulse));
    } else {
      layer.mat.color.setScalar(c);
    }
  }

  // Upstream Central Complex excitation reservoir — the calcium field writes
  // back into the decision engine (see stateLikelihoods / T_eff). Square-law
  // drive with slow neural recovery; clamped to [0, 10].
  const ccEnv = ccLayer?.env || 0.0;
  agent.ccExcite = clamp(agent.ccExcite + (ccEnv * ccEnv - 0.25 * agent.ccExcite) * renderDt, 0, 10);

  controls.update();
  composer.render();
}

/* -------------------------------------------------------------------------
 * Manifest → neuropil composition panel
 * ---------------------------------------------------------------------- */
function buildAnatomyPanel(manifest) {
  if (!manifest || typeof manifest !== "object") return;
  if (!Array.isArray(manifest.regions)) return;
  if (Number.isFinite(manifest.total)) {
    el["anatomy-count"].textContent = `${manifest.total.toLocaleString()} neurons`;
  }
  for (const r of manifest.regions.slice(0, 12)) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.name !== "string") continue;
    if (!Number.isFinite(r.pct) || r.pct < 0 || r.pct > 100) continue;
    if (!Number.isInteger(r.count) || r.count < 0) continue;
    const row = document.createElement("div");
    row.className = "anatomy-row";
    const nameSpan = document.createElement("span");
    nameSpan.className = "a-name";
    nameSpan.textContent = r.name;        // textContent — no raw template innerHTML (P2)
    const pctSpan = document.createElement("span");
    pctSpan.className = "a-pct";
    pctSpan.textContent = `${r.pct}%`;
    const countSpan = document.createElement("span");
    countSpan.className = "a-n";
    countSpan.textContent = r.count.toLocaleString();
    row.append(nameSpan, pctSpan, countSpan);
    el["anatomy-rows"].appendChild(row);
  }
  if (manifest.circuits && typeof manifest.circuits === "object") {
    const keys = {
      1: "LC/LPLC Visual Projection", 2: "T-series Visual Columns",
      3: "PPL1 Aversive Dopamine", 4: "PAM Reward Dopamine",
      5: "Giant-Fibre / Descending", 6: "OA-VUM Octopaminergic Arousal",
      7: "Central Complex", 8: "Gustatory / Taste",
      9: "AL Olfactory / Antennal Sensory",
    };
    for (const [cat, label] of Object.entries(keys)) {
      const node = document.getElementById("cat-count-" + cat);
      if (node && Number.isFinite(manifest.circuits[label])) {
        node.textContent = manifest.circuits[label].toLocaleString();
      }
    }
  }
}

/* -------------------------------------------------------------------------
 * OBJ fallback (sphere-free template envelope) — only if connectome.bin
 * is unavailable.
 * ---------------------------------------------------------------------- */
const MAX_OBJ_VERTS = 1000000;
const MAX_OBJ_TRIANGLES = 3000000;

function parseObj(text) {
  const verts = [];
  const rawFaces = [];
  for (const raw of text.split(/\r?\n/)) {
    if (verts.length / 3 > MAX_OBJ_VERTS || rawFaces.length > MAX_OBJ_TRIANGLES) {
      throw new Error("OBJ exceeds parser safety limits");
    }
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const p = line.split(/\s+/);
    if (p[0] === "v") {
      const vx = parseFloat(p[1]), vy = parseFloat(p[2]), vz = parseFloat(p[3]);
      if (Number.isFinite(vx) && Number.isFinite(vy) && Number.isFinite(vz)) verts.push(vx, vy, vz);
    }
    else if (p[0] === "f") {
      const idx = [];
      for (let i = 1; i < p.length; i++) {
        const n = parseInt(p[i].split("/")[0], 10);
        if (Number.isFinite(n)) idx.push(n > 0 ? n - 1 : verts.length / 3 + n);
      }
      for (let i = 1; i + 1 < idx.length; i++) rawFaces.push(idx[0], idx[i], idx[i + 1]);
    }
  }
  const positions = new Float32Array(rawFaces.length * 3);
  for (let i = 0; i < rawFaces.length; i++) {
    const o = rawFaces[i] * 3;
    if (o < 0 || o + 2 > verts.length - 1) throw new Error("OBJ face index out of range");
    positions[i * 3] = verts[o];
    positions[i * 3 + 1] = verts[o + 1];
    positions[i * 3 + 2] = verts[o + 2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return g;
}

function buildSampler(geom) {
  const pos = geom.attributes.position.array;
  const n = Math.floor(pos.length / 9);
  const cum = new Float32Array(n);
  let total = 0;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
    const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    total += 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    cum[t] = total;
  }
  if (total <= 0) for (let t = 0; t < n; t++) cum[t] = (t + 1) / n;
  else for (let t = 0; t < n; t++) cum[t] /= total;
  return { pos, n, cum };
}

function pickSurfacePoint(s) {
  const r = Math.random();
  let lo = 0, hi = s.n - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (s.cum[m] < r) lo = m + 1; else hi = m;
  }
  const i = lo * 9;
  let u = Math.random(), w = Math.random();
  if (u + w > 1) { u = 1 - u; w = 1 - w; }
  const v2 = 1 - u - w;
  return [
    u * s.pos[i] + v2 * s.pos[i + 3] + w * s.pos[i + 6],
    u * s.pos[i + 1] + v2 * s.pos[i + 4] + w * s.pos[i + 7],
    u * s.pos[i + 2] + v2 * s.pos[i + 5] + w * s.pos[i + 8],
  ];
}

function makeFallbackShell(sampler, count, radius) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const tmp = new THREE.Color();
  const jitter = () => (Math.random() - 0.5) * 2 * radius * 0.015;
  const nSurf = Math.round(count * 0.3);
  for (let i = 0; i < count; i++) {
    const pt = pickSurfacePoint(sampler);
    let depth;
    if (i < nSurf) depth = 1;
    else {
      const r = Math.pow(Math.random(), 1.6);
      pt[0] *= r; pt[1] *= r; pt[2] *= r;
      depth = r;
    }
    positions[i * 3] = pt[0] + jitter();
    positions[i * 3 + 1] = pt[1] + jitter();
    positions[i * 3 + 2] = pt[2] + jitter();
    tmp.lerpColors(new THREE.Color("#22262c"), new THREE.Color("#3a404a"), depth);
    const j = (Math.random() - 0.5) * 0.07;
    colors[i * 3] = clamp(tmp.r + j, 0, 1);
    colors[i * 3 + 1] = clamp(tmp.g + j, 0, 1);
    colors[i * 3 + 2] = clamp(tmp.b + j, 0, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

async function loadFallbackObj() {
  const res = await fetch(CONFIG.fallbackObjUrl);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const geom = parseObj(await res.text());
  if (!geom.attributes.position || geom.attributes.position.count < 3) {
    throw new Error("empty geometry");
  }
  geom.computeBoundingBox();
  const cTmp = new THREE.Vector3();
  geom.boundingBox.getCenter(cTmp);
  geom.translate(-cTmp.x, -cTmp.y, -cTmp.z);
  geom.computeBoundingSphere();
  const R = geom.boundingSphere.radius;
  const shell = makeFallbackShell(buildSampler(geom), 90000, R);
  return { R, shell };
}

/* -------------------------------------------------------------------------
 * Boot sequence
 * ---------------------------------------------------------------------- */
async function boot() {
  let R = null;
  let source = null;

  try {
    const data = await loadConnectome();
    R = buildConnectomeScene(data);
    source = "FLYWIRE_CONNECTOME";
    logTrace(`${source} — ${data.N.toLocaleString()} real neurons (circuit-tagged)`);
  } catch (err) {
    console.warn("connectome unavailable, falling back to template mesh:", err);
    try {
      const fb = await loadFallbackObj();
      const tex = makeSoftTexture();
      const mat = new THREE.PointsMaterial({
        map: tex,
        size: fb.R * 0.009,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
        depthTest: true,
        blending: THREE.NormalBlending,
      });
      const pts = new THREE.Points(fb.shell, mat);
      pts.renderOrder = 0;
      scene.add(pts);
      R = fb.R;
      source = "TEMPLATE_MESH (connectome.bin missing)";
      try {
        const res = await fetch(CONFIG.manifestUrl);
        if (res.ok) buildAnatomyPanel(await res.json());
      } catch { /* ignored */ }
    } catch (err2) {
      fatal("CONNECTOME UNAVAILABLE — could not load connectome.bin or template mesh.<br>" + err2.message);
      return;
    }
    logTrace(`${source} — volumetric template shell`);
  }

  if (source === "FLYWIRE_CONNECTOME") {
    try {
      const res = await fetch(CONFIG.manifestUrl);
      const mf = res.ok ? await res.json() : null;
      if (mf) buildAnatomyPanel(mf);
    } catch { /* panel stays empty */ }
  }
  brainRadius = R;

  // Cinematic three-quarter perspective — brain fills ~70% of viewport width.
  camera.position.set(R * 0.90, R * 0.70, R * 2.25);
  camera.lookAt(0, 0, 0);
  initControls();

  const throttledReset = throttleAction(() => resetHomeostasis(), 500);
  $("btn-sensory").addEventListener("click", throttleAction(() => fireStimulus("sensory")));
  $("btn-threat").addEventListener("click", throttleAction(() => fireStimulus("threat")));
  $("btn-forage").addEventListener("click", throttleAction(() => fireStimulus("forage")));
  $("btn-heat").addEventListener("click", throttleAction(() => activateEpisode("heat")));
  $("btn-queue").addEventListener("click", throttleAction(() => activateEpisode("queue")));
  $("btn-deadline").addEventListener("click", throttleAction(() => activateEpisode("deadline")));
  $("btn-tea").addEventListener("click", throttleAction(() => activateEpisode("tea")));
  $("btn-payday").addEventListener("click", throttleAction(() => doPayday()));
  $("btn-inflation").addEventListener("click", throttleAction(() => activateEpisode("inflation")));
  $("btn-kin-shock").addEventListener("click", throttleAction(() => kinExogenousShock()));
  $("btn-coffee").addEventListener("click", throttleAction(() => takeCoffee()));
  $("btn-substance").addEventListener("click", throttleAction(() => authorizeDose()));
  $("btn-circuit-ref").addEventListener("click", () => toggleCircuitModal(true));
  $("modal-close").addEventListener("click", () => toggleCircuitModal(false));
  $("btn-reset").addEventListener("click", throttledReset);
  $("circuit-modal").addEventListener("click", (e) => {
    if (e.target === $("circuit-modal")) toggleCircuitModal(false);
  });

  window.addEventListener("keydown", (e) => {
    const tag = e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    if (e.key === "Escape") { toggleCircuitModal(false); return; }
    if (e.key.toLowerCase() === "h") toggleCircuitModal();
    if (e.key.toLowerCase() === "r" && !e.metaKey && !e.ctrlKey) throttledReset();
  });

  applyBehaviourUI(agent.behavior);
  applyStateAmbient(agent.behavior);
  setInterval(() => {
    const s = CONFIG.tickMs / 1000;
    updateSocioEconomics(s);
    updateVitals(s);
    tickEpisodes(s);
    updateAllostasis(s);
    updateSubstance(s);
    burnoutSporadic(s);
    chooseBehavior(s);
    renderDashboard();
  }, CONFIG.tickMs);

  logTrace("DECISION ENGINE STANDBY — 250 ms cadence · 6-state ethogram · chronic stressors + socio-economic + substance stage");
  logTrace("2-PHOTON STAGE READY — resting slate, circuits silent until driven");

  window.addEventListener("resize", onResize);
  animate();
  el.boot.classList.add("done");
}

/* ---- Entry -------------------------------------------------------------- */
function fatal(msg) {
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;inset:0;z-index:99;background:#04060b;color:#f87171;display:flex;align-items:center;justify-content:center;font-family:monospace;font-size:13px;letter-spacing:.08em;text-align:center;padding:24px;";
  box.textContent = msg;   // textContent — error text rendered as inert nodes (P2)
  document.body.appendChild(box);
}

window.addEventListener("error", (e) => fatal("RUNTIME ERROR · " + e.message));

try {
  initRenderer();
} catch (err) {
  fatal("WEBGL UNAVAILABLE — this digital twin needs hardware-accelerated WebGL.<br>" + err.message);
}

boot();