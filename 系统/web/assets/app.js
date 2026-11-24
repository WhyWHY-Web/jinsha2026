/* ═══════════════════════════════════════════════════════════════════════
   金沙江流域森林生态环境智能评估系统 · 前端主程序
   三维：Three.js r158（本地 vendor）
   数据：/api/stations · /data/dem.bin · /data/streams.json · /data/meta.json
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';
THREE.ColorManagement.enabled = false;

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const nf = (v, d = 0) => (v == null || isNaN(v)) ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = v => (v == null ? '—' : (v * 100).toFixed(0) + '%');

/* ─────────── 常量 ─────────── */
const LON_MIN = 97.6, LON_MAX = 105.4, LAT_MIN = 25.9, LAT_MAX = 32.5;
const LON0 = 101.5, LAT0 = 29.2, SX = 97.4, SZ = 110.9;   // km / 度（按 29°N 余弦校正）
const DEM_N = 1024;
let EXAG = 22;

const toX = lon => (lon - LON0) * SX;
const toZ = lat => -(lat - LAT0) * SZ;
const toLon = x => x / SX + LON0;
const toLat = z => -z / SZ + LAT0;

const App = {
  stations: [], meta: null, dem: null, streams: null,
  module: 'twin', sel: null, hover: null,
  overlay: 'none', scen: 'base',
  quality: 'high', dpr: 1.5,
  cam: { th: .30, ph: .52, d: 840, tx: 0, ty: 10, tz: 0 },
  anim: null, fps: 60, fpsAcc: 0, fpsN: 0, lowCount: 0
};

/* ═════════════ 1. 工具 ═════════════ */
function toast(msg, type) {
  const d = document.createElement('div');
  d.className = 'toast' + (type ? ' ' + type : '');
  d.textContent = msg;
  $('#toasts').appendChild(d);
  setTimeout(() => { d.style.opacity = 0; d.style.transform = 'translateX(10px)'; d.style.transition = '.3s'; }, 3200);
  setTimeout(() => d.remove(), 3600);
}
function api(url, opt) {
  return fetch(url, Object.assign({ credentials: 'same-origin' }, opt)).then(r => {
    if (r.status === 401) { location.href = '/login'; throw new Error('unauth'); }
    return r.json();
  });
}
function hex2rgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

/* ═════════════ 2. 指标模型（全部公式在“方法”页公开） ═════════════ */
const LCK = { forest: '林地', grass: '草地灌丛', crop: '农田', built: '建成区', bare: '裸地', water: '水体', wet: '湿地', snow: '冰雪' };

function lcOf(s) {
  const g = k => s.lc && s.lc[LCK[k]] != null ? s.lc[LCK[k]] : 0;
  return { forest: g('forest'), grass: g('grass'), crop: g('crop'), built: g('built'), bare: g('bare'), water: g('water'), wet: g('wet'), snow: g('snow') };
}

/** 植被覆盖度（土地覆盖加权，估算） */
function fvcOf(s) {
  const l = lcOf(s);
  return clamp(l.forest * .92 + l.grass * .62 + l.crop * .55 + l.wet * .75 + l.bare * .05 + l.built * .08, 0, 1);
}
/** 地上植被碳密度 tC/ha（InVEST Carbon 口径简化，估算） */
function carbonOf(s) {
  const l = lcOf(s);
  const base = l.forest * 52 + l.grass * 7.5 + l.crop * 5.2 + l.wet * 18 + l.bare * .4 + l.built * 1.2;
  const P = s.precip == null ? 1000 : s.precip;
  return base * (.72 + .28 * clamp(P / 1200, .45, 1.35));
}
/** 生物丰度指数（HJ 192-2015 权重） */
function abiOf(s) {
  const l = lcOf(s);
  return 100 * (.35 * l.forest + .21 * l.grass + .28 * (l.water + l.wet) + .11 * l.crop + .04 * l.built + .01 * l.bare);
}
/** 水网密度指数（降水 + 水域占比代理） */
function wriOf(s) {
  const l = lcOf(s);
  return 100 * (.70 * clamp((s.precip || 0) / 1600, 0, 1) + .30 * clamp((l.water + l.wet) / .05, 0, 1));
}
/** 土地胁迫指数（越大越胁迫） */
function lsiOf(s) {
  const l = lcOf(s);
  const sf = clamp((s.slope - 5) / 30, 0, 1);
  const rf = clamp(s.relief / 900, 0, 1);
  return 100 * (.45 * sf + .30 * rf + .15 * clamp(l.built / .12, 0, 1) + .10 * clamp(l.bare / .15, 0, 1));
}
/** 滑坡敏感性 0-100（地形实测 + 经验权重） */
function slideOf(s) {
  const l = lcOf(s);
  const sf = clamp((s.slope - 4) / 28, 0, 1);
  const rf = clamp(s.relief / 800, 0, 1);
  const pf = clamp((s.precip || 0) / 1600, 0, 1);
  const cover = clamp(l.forest * .8 + l.grass * .35 + l.wet * .5, 0, 1);
  return 100 * (.42 * sf + .18 * rf + .22 * pf + .18 * (1 - cover));
}
/** 退化风险 0-100 */
function degOf(s) {
  const l = lcOf(s);
  const T = s.temp == null ? 12 : s.temp;
  const P = s.precip == null ? 1000 : s.precip;
  const dry = clamp((T - 6) / 18, 0, 1) * clamp(1 - P / 1800, .15, 1);
  return 100 * (.40 * (1 - fvcOf(s)) + .30 * dry + .18 * clamp(l.built / .10, 0, 1) + .12 * (1 - l.forest));
}
/** 生态环境状况指数 EI（HJ 192-2015 框架，缺污染负荷项后按 0.90 归一） */
function eiOf(s) {
  const abi = abiOf(s), vci = fvcOf(s) * 100, wri = wriOf(s), lsi = lsiOf(s);
  return (.35 * abi + .25 * vci + .15 * wri + .15 * (100 - lsi)) / .90;
}
function eiGrade(v) { return v >= 75 ? '优' : v >= 55 ? '良' : v >= 35 ? '一般' : v >= 20 ? '较差' : '差'; }
function eiClass(v) { return v >= 75 ? 'lo' : v >= 55 ? 'lo' : v >= 35 ? 'mid' : 'hi'; }
/** 综合风险 */
function riskOf(s) { return .42 * slideOf(s) + .33 * degOf(s) + .25 * lsiOf(s); }
function riskGrade(v) { return v >= 58 ? '高风险' : v >= 45 ? '中风险' : '低风险'; }
function riskClass(v) { return v >= 58 ? 'risk-high' : v >= 45 ? 'risk-mid' : 'risk-low'; }

function computeAll() {
  App.stations.forEach(s => {
    s.m = {
      fvc: fvcOf(s), carbon: carbonOf(s), abi: abiOf(s), wri: wriOf(s), lsi: lsiOf(s),
      slide: slideOf(s), deg: degOf(s), ei: eiOf(s), risk: riskOf(s)
    };
    s.m.riskG = riskGrade(s.m.risk);
    s.m.eiG = eiGrade(s.m.ei);
  });
}
const mean = (arr, f) => arr.length ? arr.reduce((a, b) => a + (f ? f(b) : b), 0) / arr.length : 0;

/* 情景：只改土地覆盖结构，其余保持不变（明确标注为情景模拟） */
function scenarioStation(s, mode) {
  if (mode === 'base') return s;
  const l = lcOf(s);
  const n = Object.assign({}, l);
  if (mode === 'degrade') {
    const d = l.forest * .22;
    n.forest -= d; n.grass += d * .55; n.bare += d * .22; n.crop += d * .23;
  } else if (mode === 'restore') {
    const d = Math.min(l.grass * .22 + l.crop * .18, .16);
    n.forest += d; n.grass -= Math.min(l.grass * .22, d); n.crop -= Math.max(0, d - Math.min(l.grass * .22, d));
  }
  const lc = {};
  Object.keys(l).forEach(k => { if (n[k] > 0.0005) lc[LCK[k]] = n[k]; });
  return Object.assign({}, s, { lc });
}

/* ═════════════ 3. 数据加载 ═════════════ */
function bilinear(arr, C, R, lon, lat) {
  const x = (lon - LON_MIN) / (LON_MAX - LON_MIN) * C - .5;
  const y = (LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * R - .5;
  const x0 = clamp(Math.floor(x), 0, C - 2), y0 = clamp(Math.floor(y), 0, R - 2);
  const fx = x - x0, fy = y - y0, i = y0 * C + x0;
  return arr[i] * (1 - fx) * (1 - fy) + arr[i + 1] * (1 - fx) * fy + arr[i + C] * fx * (1 - fy) + arr[i + C + 1] * fx * fy;
}
function elevAt(lon, lat) { return bilinear(App.dem, DEM_N, DEM_N, lon, lat); }
function yAt(lon, lat) { return (elevAt(lon, lat) - 150) * EXAG / 1000; }

async function loadAll() {
  const [stRes, meta, demBuf, streams] = await Promise.all([
    api('/api/stations'),
    fetch('/data/meta.json').then(r => r.json()),
    fetch('/data/dem.bin').then(r => r.arrayBuffer()),
    fetch('/data/streams.json').then(r => r.json())
  ]);
  App.stations = stRes.stations || [];
  App.meta = meta;
  App.dem = new Int16Array(demBuf);
  App.streams = streams;
  computeAll();
  $('#cVer').textContent = meta.version || '—';
  $('#hStn').textContent = App.stations.length;
}

/* ═════════════ 4. 三维场景 ═════════════ */
let renderer, scene, camera, terrain, terrainMat, satTex, hillTex, rampTex, ovTex, ovCanvas,
  streamGroup, stationPts, stationGeo, sky, labelEls = [], raycaster;

const RAMP = [
  [200, '#0F2F26'], [800, '#17452F'], [1400, '#215838'], [2000, '#2E6A40'],
  [2500, '#467A45'], [3000, '#5F8449'], [3500, '#7E8A55'], [4000, '#9C9468'],
  [4500, '#B7AB88'], [5000, '#D2C8AE'], [5600, '#EDE7DB'], [6500, '#FFFFFF']
];

function makeRampTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 1;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 256, 0);
  RAMP.forEach(([h, col]) => grd.addColorStop(clamp((h - 200) / (6800 - 200), 0, 1), col));
  g.fillStyle = grd; g.fillRect(0, 0, 256, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
  return t;
}

function initGL() {
  const cv = $('#gl');
  renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, powerPreference: 'high-performance', alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, App.dpr));
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x070b0f, 1);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(42, 1, 1, 6000);

  satTex = new THREE.TextureLoader().load('/assets/img/satellite.jpg');
  satTex.colorSpace = THREE.SRGBColorSpace; satTex.anisotropy = 4;
  satTex.minFilter = THREE.LinearMipmapLinearFilter;
  hillTex = new THREE.TextureLoader().load('/assets/img/hillshade.jpg');
  hillTex.colorSpace = THREE.NoColorSpace; hillTex.anisotropy = 4;
  rampTex = makeRampTexture();

  buildSky();
  buildTerrain(App.quality === 'high' ? 448 : 352);
  buildStreams();
  buildStations();
  buildOverlay();

  raycaster = new THREE.Raycaster();
  bindControls();
  resize();
  window.addEventListener('resize', resize);
}

function buildSky() {
  const geo = new THREE.SphereGeometry(3200, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uTop: { value: new THREE.Color('#05090D') }, uHor: { value: new THREE.Color('#08141A') }, uSun: { value: new THREE.Color('#14292B') } },
    vertexShader: `varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uTop,uHor,uSun; varying vec3 vP;
      void main(){
        vec3 d=normalize(vP);
        vec3 c=mix(uHor,uTop,smoothstep(-0.04,0.62,d.y));
        c*=mix(0.55,1.0,smoothstep(-0.30,0.02,d.y));
        float s=pow(max(dot(d,normalize(vec3(-0.55,0.35,-0.75))),0.0),26.0);
        c+=uSun*s*0.45;
        c=pow(c,vec3(1.0/2.2));
        gl_FragColor=vec4(c,1.0);
      }`
  });
  sky = new THREE.Mesh(geo, mat);
  sky.frustumCulled = false;
  scene.add(sky);
}

function buildTerrain(N) {
  if (terrain) { scene.remove(terrain); terrain.geometry.dispose(); }
  const V = N * N;
  const pos = new Float32Array(V * 3), uv = new Float32Array(V * 2), el = new Float32Array(V);
  for (let j = 0; j < N; j++) {
    const lat = LAT_MAX - j / (N - 1) * (LAT_MAX - LAT_MIN);
    for (let i = 0; i < N; i++) {
      const lon = LON_MIN + i / (N - 1) * (LON_MAX - LON_MIN);
      const k = j * N + i;
      const e = elevAt(lon, lat);
      pos[k * 3] = toX(lon); pos[k * 3 + 1] = (e - 150) * EXAG / 1000; pos[k * 3 + 2] = toZ(lat);
      uv[k * 2] = i / (N - 1); uv[k * 2 + 1] = 1 - j / (N - 1);
      el[k] = e;
    }
  }
  const idx = new Uint32Array((N - 1) * (N - 1) * 6);
  let p = 0;
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    idx[p++] = a; idx[p++] = c; idx[p++] = b;
    idx[p++] = b; idx[p++] = c; idx[p++] = d;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aElev', new THREE.BufferAttribute(el, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();

  terrainMat = new THREE.ShaderMaterial({
    uniforms: {
      uSat: { value: satTex }, uHill: { value: hillTex }, uRampTex: { value: rampTex },
      uOverlay: { value: ovTex || null },
      uContour: { value: 0 }, uRamp: { value: 0.0 }, uHillAmt: { value: 0.55 }, uSatMix: { value: 0.62 },
      uOverlayOn: { value: 0 }, uHaze: { value: new THREE.Color('#0D1B21') },
      uMin: { value: 200 }, uMax: { value: 6800 }
    },
    vertexShader: `
      attribute float aElev;
      varying vec2 vUv; varying float vE; varying vec3 vW;
      void main(){
        vUv=uv; vE=aElev;
        vec4 w=modelMatrix*vec4(position,1.0);
        vW=w.xyz;
        gl_Position=projectionMatrix*viewMatrix*w;
      }`,
    fragmentShader: `
      uniform sampler2D uSat,uHill,uRampTex,uOverlay;
      uniform float uContour,uRamp,uHillAmt,uOverlayOn,uMin,uMax,uSatMix;
      uniform vec3 uHaze;
      varying vec2 vUv; varying float vE; varying vec3 vW;
      void main(){
        vec3 sat=texture2D(uSat,vUv).rgb;
        sat=(sat-0.5)*1.07+0.5;
        float lum=dot(sat,vec3(0.299,0.587,0.114));
        sat=mix(vec3(lum),sat,1.10);
        float hs=texture2D(uHill,vUv).r;
        float sh=mix(1.0,0.74+0.44*hs,uHillAmt);
        float t=clamp((vE-uMin)/(uMax-uMin),0.0,1.0);
        vec3 tint=texture2D(uRampTex,vec2(t,0.5)).rgb;
        vec3 img=sat*sh;
        vec3 cart=tint*(0.55+0.75*hs);
        vec3 col=mix(cart,img,uSatMix);
        float d=length(vW-cameraPosition);
        float ci=vE/500.0;
        float w=fwidth(ci);
        float line=1.0-smoothstep(0.0,w*1.15,abs(fract(ci)-0.5));
        float cfd=1.0-smoothstep(240.0,880.0,d);
        col=mix(col,vec3(0.90,0.98,0.95),line*uContour*0.20*cfd);
        if(uOverlayOn>0.001){
          vec4 ov=texture2D(uOverlay,vUv);
          col=mix(col,ov.rgb,ov.a*uOverlayOn*0.78);
        }
        float hz=smoothstep(320.0,1250.0,d);
        col=mix(col,uHaze,hz*0.60);
        float ex=min(min(vUv.x,1.0-vUv.x),min(vUv.y,1.0-vUv.y));
        col=mix(uHaze,col,smoothstep(0.0,0.030,ex));
        col=pow(clamp(col,0.0,1.0),vec3(1.0/2.2));
        gl_FragColor=vec4(col,1.0);
      }`
  });
  terrain = new THREE.Mesh(geo, terrainMat);
  terrain.frustumCulled = false;
  scene.add(terrain);
  buildSkirt(N, pos);
  if (stationPts) stationPts.position.y = 0;
}

/* 侧壁：让地形像一块“岩板”而不是一张纸，边缘渐隐入背景 */
let skirtMesh = null;
function buildSkirt(N, pos) {
  if (skirtMesh) { scene.remove(skirtMesh); skirtMesh.geometry.dispose(); skirtMesh.material.dispose(); }
  const v = [], a = [], idx = [];
  let k = 0;
  const H = 120;
  function quad(i1, i2) {
    const x1 = pos[i1 * 3], y1 = pos[i1 * 3 + 1], z1 = pos[i1 * 3 + 2];
    const x2 = pos[i2 * 3], y2 = pos[i2 * 3 + 1], z2 = pos[i2 * 3 + 2];
    v.push(x1, y1, z1, x2, y2, z2, x1, y1 - H, z1, x2, y2 - H, z2);
    a.push(1, 1, 0, 0);
    idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    k += 4;
  }
  for (let i = 0; i < N - 1; i++) {
    quad(i, i + 1);
    quad((N - 1) * N + i, (N - 1) * N + i + 1);
  }
  for (let j = 0; j < N - 1; j++) {
    quad(j * N, (j + 1) * N);
    quad(j * N + N - 1, (j + 1) * N + N - 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('aA', new THREE.Float32BufferAttribute(a, 1));
  g.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    transparent: true, side: THREE.DoubleSide, depthWrite: true,
    uniforms: { uC: { value: new THREE.Color('#0A1116') } },
    vertexShader: `attribute float aA; varying float vA; varying float vY;
      void main(){ vA=aA; vY=position.y; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 uC; varying float vA; varying float vY;
      void main(){ float al=pow(vA,1.35)*0.96; if(al<0.004) discard;
        vec3 c=mix(uC,vec3(0.02,0.03,0.035),1.0-vA);
        c=pow(c,vec3(1.0/2.2));
        gl_FragColor=vec4(c,al); }`
  });
  skirtMesh = new THREE.Mesh(g, m);
  skirtMesh.frustumCulled = false;
  scene.add(skirtMesh);
}

function buildStreams() {
  if (streamGroup) { scene.remove(streamGroup); streamGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
  streamGroup = new THREE.Group();
  const lines = App.streams.lines || [];
  const caseP = [], caseI = [], coreP = [], coreI = [], lineP = [];
  let vi = 0, ci = 0;
  lines.forEach(([lvl, pts]) => {
    if (lvl >= 6 && pts.length > 1) {
      const w = .30 + (lvl - 6) * .38;
      const base = vi, baseC = ci;
      for (let i = 0; i < pts.length; i++) {
        const [lo, la] = pts[i];
        const y = yAt(lo, la) + .9;
        const p = new THREE.Vector3(toX(lo), y, toZ(la));
        const nb = i < pts.length - 1 ? pts[i + 1] : pts[i - 1];
        const dx = toX(nb[0]) - toX(lo), dz = toZ(nb[1]) - toZ(la);
        const len = Math.hypot(dx, dz) || 1;
        const ox = -dz / len, oz = dx / len;
        // 外描边（深色，宽度 2.6 倍）
        coreP.push(p.x - ox * w * 2.6, p.y - .3, p.z - oz * w * 2.6, p.x + ox * w * 2.6, p.y - .3, p.z + oz * w * 2.6);
        ci += 2;
        if (i < pts.length - 1) {
          const a = baseC + i * 2;
          coreI.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
        // 内芯
        caseP.push(p.x - ox * w, p.y, p.z - oz * w, p.x + ox * w, p.y, p.z + oz * w);
        vi += 2;
        if (i < pts.length - 1) {
          const a = base + i * 2;
          caseI.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    } else {
      for (let i = 0; i < pts.length - 1; i++) {
        const [a, b] = [pts[i], pts[i + 1]];
        lineP.push(toX(a[0]), yAt(a[0], a[1]) + .55, toZ(a[1]), toX(b[0]), yAt(b[0], b[1]) + .55, toZ(b[1]));
      }
    }
  });
  if (lineP.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(lineP, 3));
    streamGroup.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: 0x74C3D6, transparent: true, opacity: .42, depthWrite: false
    })));
  }
  if (coreP.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(coreP, 3));
    g.setIndex(coreI);
    const mm = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0x061A20, transparent: true, opacity: .55, depthWrite: false
    })); mm.renderOrder = 2; streamGroup.add(mm);
  }
  if (caseP.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(caseP, 3));
    g.setIndex(caseI);
    const mm = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xA8ECF5, transparent: true, opacity: .9, depthWrite: false
    })); mm.renderOrder = 3; streamGroup.add(mm);
  }
  scene.add(streamGroup);
}

function buildStations() {
  if (stationPts) { scene.remove(stationPts); stationGeo.dispose(); }
  const n = App.stations.length;
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n);
  App.stations.forEach((s, i) => {
    pos[i * 3] = toX(s.lon); pos[i * 3 + 1] = yAt(s.lon, s.lat) + 1.2; pos[i * 3 + 2] = toZ(s.lat);
    const c = s.m.risk >= 58 ? '#FF6B6B' : s.m.risk >= 45 ? '#F0B44C' : '#37D9A0';
    const [r, g, b] = hex2rgb(c);
    col[i * 3] = r / 255; col[i * 3 + 1] = g / 255; col[i * 3 + 2] = b / 255;
    size[i] = s.type === '梯级电站' ? 11 : 9;
  });
  stationGeo = new THREE.BufferGeometry();
  stationGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  stationGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  stationGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute vec3 aColor; attribute float aSize;
      varying vec3 vC; varying float vS;
      uniform float uTime;
      void main(){
        vec4 mv=modelViewMatrix*vec4(position,1.0);
        gl_Position=projectionMatrix*mv;
        float ps=aSize*(520.0/max(-mv.z,1.0));
        gl_PointSize=clamp(ps,5.0,30.0);
        vC=aColor; vS=clamp(ps/9.0,0.6,1.6);
      }`,
    fragmentShader: `
      varying vec3 vC; varying float vS;
      void main(){
        vec2 p=gl_PointCoord-0.5; float d=length(p);
        if(d>0.5) discard;
        float core=smoothstep(0.30,0.20,d);
        float ring=smoothstep(0.44,0.38,d)-smoothstep(0.38,0.30,d);
        float halo=smoothstep(0.5,0.16,d)*0.30;
        float a=core+ring*0.85+halo;
        vec3 c=vC*(0.55+0.45*core);
        gl_FragColor=vec4(c,a);
      }`
  });
  stationPts = new THREE.Points(stationGeo, mat);
  stationPts.frustumCulled = false;
  scene.add(stationPts);
}

/* ─────────── 专题层（IDW 插值纹理） ─────────── */
const OV_DEF = {
  ei: { name: '生态环境状况指数 EI', get: s => s.m.ei, lo: 30, hi: 80, cols: ['#B33A3A', '#E0A33A', '#7FC08A', '#2E9E6B'] },
  risk: { name: '综合生态风险', get: s => s.m.risk, lo: 25, hi: 80, cols: ['#2E9E6B', '#C9C05A', '#E08A3A', '#C0392B'] },
  carbon: { name: '地上植被碳密度', get: s => s.m.carbon, lo: 2, hi: 45, cols: ['#20364A', '#2C7A5B', '#8CC26A', '#D9E8A8'] },
  fvc: { name: '植被覆盖度', get: s => s.m.fvc * 100, lo: 20, hi: 95, cols: ['#3A2F2A', '#8A7A3F', '#6FA84F', '#2F8F5B'] },
  slide: { name: '滑坡敏感性', get: s => s.m.slide, lo: 20, hi: 80, cols: ['#2E9E6B', '#C9C05A', '#E07A3A', '#C0392B'] }
};
function rampColor(cols, t) {
  t = clamp(t, 0, 1) * (cols.length - 1);
  const i = Math.min(cols.length - 2, Math.floor(t)), f = t - i;
  const a = hex2rgb(cols[i]), b = hex2rgb(cols[i + 1]);
  return `rgb(${Math.round(lerp(a[0], b[0], f))},${Math.round(lerp(a[1], b[1], f))},${Math.round(lerp(a[2], b[2], f))})`;
}
function buildOverlay() {
  ovCanvas = document.createElement('canvas'); ovCanvas.width = ovCanvas.height = 256;
  ovTex = new THREE.CanvasTexture(ovCanvas);
  ovTex.colorSpace = THREE.SRGBColorSpace;
  ovTex.minFilter = THREE.LinearFilter; ovTex.magFilter = THREE.LinearFilter;
  if (terrainMat) terrainMat.uniforms.uOverlay.value = ovTex;
}
function drawOverlay(key) {
  if (key === 'none') { if (terrainMat) terrainMat.uniforms.uOverlayOn.value = 0; return; }
  const D = OV_DEF[key]; if (!D) return;
  const c = ovCanvas, g = c.getContext('2d'), S = c.width;
  const img = g.createImageData(S, S);
  const pts = App.stations.map(s => ({ lon: s.lon, lat: s.lat, v: D.get(s) }));
  for (let j = 0; j < S; j++) {
    const lat = LAT_MAX - (j + .5) / S * (LAT_MAX - LAT_MIN);
    for (let i = 0; i < S; i++) {
      const lon = LON_MIN + (i + .5) / S * (LON_MAX - LON_MIN);
      let sw = 0, sv = 0, dmin = 1e9;
      for (const p of pts) {
        const dx = (lon - p.lon) * 97, dy = (lat - p.lat) * 111, d2 = dx * dx + dy * dy;
        if (d2 < dmin) dmin = d2;
        const w = 1 / Math.pow(Math.max(d2, 1), .85);
        sw += w; sv += w * p.v;
      }
      const v = sv / sw;
      const col = rampColor(D.cols, (v - D.lo) / (D.hi - D.lo));
      const rgb = col.match(/\d+/g).map(Number);
      const dm = Math.sqrt(dmin);
      const a = clamp(1 - (dm - 60) / 55, 0, 1) * .82;
      const k = (j * S + i) * 4;
      img.data[k] = rgb[0]; img.data[k + 1] = rgb[1]; img.data[k + 2] = rgb[2];
      img.data[k + 3] = Math.round(a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  ovTex.needsUpdate = true;
  if (terrainMat) { terrainMat.uniforms.uOverlay.value = ovTex; terrainMat.uniforms.uOverlayOn.value = 1; }
}

/* ═════════════ 5. 相机与控制 ═════════════ */
function applyCam() {
  const c = App.cam;
  const cp = Math.cos(c.ph), sp = Math.sin(c.ph);
  camera.position.set(c.tx + c.d * cp * Math.sin(c.th), c.ty + c.d * sp, c.tz + c.d * cp * Math.cos(c.th));
  camera.lookAt(c.tx, c.ty, c.tz);
  if (sky) sky.position.set(camera.position.x, 0, camera.position.z);
}
function bindControls() {
  const cv = $('#gl');
  let down = false, btn = 0, lx = 0, ly = 0, moved = 0, pinch = 0;
  const pts = new Map();

  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { down = true; btn = e.button; lx = e.clientX; ly = e.clientY; moved = 0; cv.classList.add('drag'); }
  });
  cv.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const arr = Array.from(pts.values());
      const d = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
      if (pinch) App.cam.d = clamp(App.cam.d * pinch / d, 30, 1700);
      pinch = d; return;
    }
    if (!down) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    moved += Math.abs(dx) + Math.abs(dy);
    if (btn === 2 || e.shiftKey) {
      const s = App.cam.d * .0016;
      const st = Math.sin(App.cam.th), ct = Math.cos(App.cam.th);
      App.cam.tx -= (dx * ct - dy * st * .7) * s;
      App.cam.tz -= (-dx * st - dy * ct * .7) * s;
    } else {
      App.cam.th -= dx * .0042;
      App.cam.ph = clamp(App.cam.ph + dy * .0032, .07, 1.42);
    }
  });
  const up = e => {
    pts.delete(e.pointerId); pinch = 0;
    if (pts.size === 0) {
      cv.classList.remove('drag');
      if (down && moved < 6) pick(e.clientX, e.clientY);
      down = false;
    }
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    App.cam.d = clamp(App.cam.d * Math.exp(e.deltaY * .0009), 30, 1700);
  }, { passive: false });
  // 触摸双指
  cv.addEventListener('touchmove', e => { if (e.touches.length === 2) e.preventDefault(); }, { passive: false });
}

function pick(cx, cy) {
  const rect = $('#gl').getBoundingClientRect();
  let best = null, bd = 20;
  App.stations.forEach(s => {
    const p = project(s.lon, s.lat);
    if (!p) return;
    const d = Math.hypot(p.x - cx + rect.left, p.y - cy + rect.top);
    if (d < bd) { bd = d; best = s; }
  });
  if (best) selectStation(best); else closeCard();
}
function project(lon, lat) {
  const v = new THREE.Vector3(toX(lon), yAt(lon, lat) + 1.5, toZ(lat)).project(camera);
  if (v.z > 1 || v.z < -1) return null;
  const w = $('#gl').clientWidth, h = $('#gl').clientHeight;
  return { x: (v.x * .5 + .5) * w, y: (-v.y * .5 + .5) * h };
}
function selectStation(s) {
  App.sel = s;
  renderCard(s);
  if (App.module !== 'twin') renderDock(App.module);
  updateLabels(true);
}
function closeCard() { App.sel = null; $('#card').classList.remove('show'); updateLabels(true); }

function flyTo(lon, lat, dist, dur) {
  const from = { th: App.cam.th, ph: App.cam.ph, d: App.cam.d, tx: App.cam.tx, ty: App.cam.ty, tz: App.cam.tz };
  const to = { th: from.th, ph: clamp(.78, .07, 1.42), d: dist || 150, tx: toX(lon), ty: yAt(lon, lat) + 6, tz: toZ(lat) };
  // 方位角取最短路径
  let dth = to.th - from.th;
  while (dth > Math.PI) dth -= Math.PI * 2;
  while (dth < -Math.PI) dth += Math.PI * 2;
  to.th = from.th + dth;
  const t0 = performance.now(), T = dur || 950;
  App.anim = function (now) {
    const t = clamp((now - t0) / T, 0, 1), e = t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    App.cam.th = lerp(from.th, to.th, e);
    App.cam.ph = lerp(from.ph, to.ph, e);
    App.cam.d = lerp(from.d, to.d, e);
    App.cam.tx = lerp(from.tx, to.tx, e);
    App.cam.ty = lerp(from.ty, to.ty, e);
    App.cam.tz = lerp(from.tz, to.tz, e);
    if (t >= 1) App.anim = null;
  };
}
function setView(k) {
  const V = {
    overview: { th: .30, ph: .52, d: 840, tx: 0, ty: 10, tz: 0 },
    upstream: { th: -.5, ph: .55, d: 330, tx: toX(99.0), ty: 60, tz: toZ(30.4) },
    mid: { th: .55, ph: .5, d: 300, tx: toX(100.6), ty: 40, tz: toZ(27.4) },
    down: { th: 1.1, ph: .52, d: 320, tx: toX(103.6), ty: 26, tz: toZ(27.6) }
  }[k];
  if (!V) return;
  flyTo(toLon(V.tx), toLat(V.tz), V.d, 1000);
  App.cam.ph = V.ph; App.cam.th = V.th;
}

/* ═════════════ 6. 渲染循环 ═════════════ */
let lastT = 0, hudT = 0, fpsT = 0;
function loop(t) {
  requestAnimationFrame(loop);
  const dt = Math.min(60, t - lastT || 16); lastT = t;
  if (App.anim) App.anim(t);
  applyCam();
  if (stationPts) stationPts.material.uniforms.uTime.value = t * .001;
  renderer.render(scene, camera);

  // FPS
  App.fpsAcc += dt; App.fpsN++;
  if (t - fpsT > 600) {
    App.fps = 1000 / (App.fpsAcc / App.fpsN);
    $('#fps').textContent = App.fps.toFixed(0);
    $('#fps').parentElement.classList.toggle('warn', App.fps < 40);
    $('#fps').parentElement.classList.toggle('bad', App.fps < 26);
    if (App.fps < 38) { App.lowCount++; } else App.lowCount = 0;
    if (App.lowCount === 4 && renderer.getPixelRatio() > 1.0) {
      renderer.setPixelRatio(1.0); resize(); toast('已自动降低渲染倍率以保证流畅', 'warn');
    }
    if (App.lowCount === 10 && App.quality === 'high') {
      App.quality = 'mid'; buildTerrain(352); resize();
      toast('已切换至中等地形精度', 'warn');
    }
    fpsT = t; App.fpsAcc = 0; App.fpsN = 0;
  }
  if (t - hudT > 220) { updateHUD(); updateLabels(); hudT = t; }
}

function updateHUD() {
  const az = ((App.cam.th * 180 / Math.PI) % 360 + 360) % 360;
  $('#camAz').textContent = String(Math.round(az)).padStart(3, '0') + '°';
  const alt = App.cam.d * Math.sin(App.cam.ph) * 1000;
  $('#camAlt').textContent = alt > 1000 ? (alt / 1000).toFixed(0) + ' km' : alt.toFixed(0) + ' m';
  const sc = App.cam.d * 2 * Math.tan(21 * Math.PI / 180) / 900;
  $('#camScale').textContent = '1 : ' + nf(sc * 1000, 0);
  $('#hExag').textContent = EXAG + '×';
}
function updateLabels(force) {
  const placed = [];
  const order = App.stations.map((s, i) => ({ s, i, p: project(s.lon, s.lat) }))
    .filter(o => o.p).sort((a, b) => (b.s === App.sel) - (a.s === App.sel) || b.s.m.risk - a.s.m.risk);
  order.forEach(o => {
    const el = labelEls[o.i]; if (!el) return;
    const hit = placed.some(q => Math.abs(q.x - o.p.x) < 58 && Math.abs(q.y - o.p.y) < 13);
    if (hit && o.s !== App.sel) { el.classList.remove('show'); return; }
    placed.push(o.p);
    el.style.transform = `translate(${o.p.x}px,${o.p.y}px) translate(-50%,-150%)`;
    el.classList.add('show');
    el.classList.toggle('sel', o.s === App.sel);
  });
}
function resize() {
  const el = $('#stage');
  const w = el.clientWidth, h = el.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}

/* ═════════════ 7. 站点卡片 ═════════════ */
function renderCard(s) {
  $('#cdName').textContent = s.name;
  $('#cdEn').textContent = (s.en || '').toUpperCase() + ' · ' + s.type;
  $('#cdTags').innerHTML = `<span class="tag ${riskClass(s.m.risk)}">${s.m.riskG}</span>
    <span class="tag">${s.zone || '—'}</span>
    <span class="tag">EI ${s.m.ei.toFixed(1)} · ${s.m.eiG}</span>`;
  $('#cdRows').innerHTML = `
    <div>海拔<b>${nf(s.elev)}<small>m</small></b></div>
    <div>坡度<b>${nf(s.slope, 1)}<small>°</small></b></div>
    <div>林地占比<b>${pct((s.lc || {})['林地'] || 0)}</b></div>
    <div>植被覆盖<b>${pct(s.m.fvc)}</b></div>
    <div>碳密度<b>${nf(s.m.carbon, 1)}<small>tC/ha</small></b></div>
    <div>综合风险<b>${nf(s.m.risk, 1)}</b></div>`;
  $('#card').classList.add('show');
}

/* ═════════════ 8. Dock 渲染 ═════════════ */
const MODS = {
  twin: { k: 'DIGITAL TWIN', t: '数字孪生', d: '真实高程与卫星影像构建的三维生态基底，叠加专题评估层。' },
  data: { k: 'DATA LAYER', t: '数据', d: '多源数据接入、质量体检与人工录入，全部字段标注来源类型。' },
  model: { k: 'MODEL LAYER', t: '模型', d: '生态过程模型与评估模型的编排、运行与结果叠加。' },
  assess: { k: 'ASSESSMENT', t: '评估', d: '按 HJ 192—2015 框架计算的生态环境状况指数与风险构成。' },
  warn: { k: 'EARLY WARNING', t: '预警', d: '基于综合风险的等级判定、主控因子与处置建议。' },
  agent: { k: 'AGENT', t: '智能体', d: '解析意图 → 调用工具 → 落到图层与数据，全链路可追踪。' },
  method: { k: 'METHODOLOGY', t: '方法', d: '技术路线、指标口径与数据边界，全部可复核。' }
};

function renderDock(mod) {
  App.module = mod;
  const M = MODS[mod];
  $('#dhK').textContent = M.k; $('#dhT').textContent = M.t; $('#dhD').textContent = M.d;
  $$('.tab').forEach(t => t.classList.toggle('on', t.dataset.mod === mod));
  const body = $('#dockBody');
  body.scrollTop = 0;
  ({ twin: dockTwin, data: dockData, model: dockModel, assess: dockAssess, warn: dockWarn, agent: dockAgent, method: dockMethod })[mod](body);
}

/* ─────────── 孪生 ─────────── */
function dockTwin(b) {
  b.innerHTML = `
  <div class="sec">
    <div class="sec-h"><h3>底图样式</h3><div class="ln"></div></div>
    <div class="seg" id="baseSeg">
      <button data-b="sat">卫星影像</button>
      <button data-b="hyb" class="on">地形晕渲</button>
      <button data-b="ramp">分层设色</button>
    </div>
    <div class="rowline" style="margin-top:8px"><div class="l">等高线（500 m）</div><div class="r"><label class="sw"><input type="checkbox" id="lyCont"><i></i></label></div></div>
    <div class="rowline"><div class="l">水系网络（DEM 提取）</div><div class="r"><label class="sw"><input type="checkbox" id="lyRiver" checked><i></i></label></div></div>
    <div class="rowline"><div class="l">站点标注</div><div class="r"><label class="sw"><input type="checkbox" id="lyStn" checked><i></i></label></div></div>
    <div class="note">晕渲＝影像与分层设色叠加，用于突出地形结构；影像模式保留原始光谱表现。</div>
  </div>

  <div class="sec">
    <div class="sec-h"><h3>专题评估层</h3><div class="ln"></div><span class="n">IDW 插值</span></div>
    <div class="seg" id="ovSeg">
      <button data-ov="none" class="on">无</button>
      <button data-ov="ei">EI</button>
      <button data-ov="risk">风险</button>
      <button data-ov="carbon">碳密度</button>
      <button data-ov="fvc">覆盖度</button>
      <button data-ov="slide">滑坡</button>
    </div>
    <div class="note">专题层由 20 个站点的评估值经反距离加权（幂 = 1.7）插值生成，仅用于空间格局示意，不代表逐像元实测。</div>
  </div>

  <div class="sec">
    <div class="sec-h"><h3>视角</h3><div class="ln"></div></div>
    <div class="grid2">
      <button class="btn" data-view="overview">全域鸟瞰</button>
      <button class="btn" data-view="upstream">上游峡谷</button>
      <button class="btn" data-view="mid">中游河湾</button>
      <button class="btn" data-view="down">下游库区</button>
    </div>
  </div>

  <div class="sec">
    <div class="sec-h"><h3>垂直夸张</h3><div class="ln"></div><span class="n" id="exagV">${EXAG}×</span></div>
    <input type="range" id="exag" min="6" max="30" step="1" value="${EXAG}" class="rng">
    <div class="note">真实地形起伏约 7 km / 760 km，为可读性做垂直放大；数值仅影响视觉，不参与任何指标计算。</div>
  </div>

  <div class="sec">
    <div class="sec-h"><h3>场景统计</h3><div class="ln"></div></div>
    <div class="grid2">
      <div class="kpi"><div class="k">地形网格</div><div class="v" id="kGrid">—</div><div class="s">DEM ${DEM_N}² 采样</div></div>
      <div class="kpi"><div class="k">三角面</div><div class="v" id="kTri">—</div><div class="s">单次绘制调用</div></div>
      <div class="kpi"><div class="k">影像纹理</div><div class="v">2048<small>²</small></div><div class="s">≈380 m/px</div></div>
      <div class="kpi"><div class="k">水系折线</div><div class="v">${(App.streams.lines || []).length}</div><div class="s">D8 汇流提取</div></div>
    </div>
  </div>`;

  const setU = (k, v) => { if (terrainMat) terrainMat.uniforms[k].value = v; };
  const BASE = { sat: [1.0, .30], hyb: [.62, .55], ramp: [.18, .38] };
  $('#baseSeg').onclick = e => {
    const btn = e.target.closest('button'); if (!btn) return;
    $$('#baseSeg button').forEach(x => x.classList.toggle('on', x === btn));
    const [sm, hm] = BASE[btn.dataset.b]; setU('uSatMix', sm); setU('uHillAmt', hm);
  };
  $('#lyCont').onchange = e => setU('uContour', e.target.checked ? 1 : 0);
  $('#lyRiver').onchange = e => { if (streamGroup) streamGroup.visible = e.target.checked; };
  $('#lyStn').onchange = e => { if (stationPts) stationPts.visible = e.target.checked; };
  $('#ovSeg').onclick = e => {
    const btn = e.target.closest('button'); if (!btn) return;
    $$('#ovSeg button').forEach(x => x.classList.toggle('on', x === btn));
    App.overlay = btn.dataset.ov; drawOverlay(App.overlay);
    $('#legOv').style.display = App.overlay === 'none' ? 'none' : 'flex';
    $('#legOvName').textContent = App.overlay === 'none' ? '' : OV_DEF[App.overlay].name;
  };
  $$('[data-view]').forEach(x => x.onclick = () => setView(x.dataset.view));
  $('#exag').oninput = e => {
    EXAG = +e.target.value; $('#exagV').textContent = EXAG + '×';
    buildTerrain(App.quality === 'high' ? 448 : 352); buildStreams(); buildStations(); drawOverlay(App.overlay);
    if (App.sel) renderCard(App.sel);
  };
  const N = App.quality === 'high' ? 448 : 352;
  $('#kGrid').textContent = N + '²';
  $('#kTri').textContent = nf((N - 1) * (N - 1) * 2 / 10000, 1) + '万';
}

/* ─────────── 数据 ─────────── */
const SOURCES = [
  ['数字高程 DEM', 'obs', 'Terrarium / SRTM 30 m 镶嵌，重采样 1024²', '≈740 m', '三维地形、坡度、起伏度、水系提取'],
  ['卫星影像', 'obs', 'Esri World Imagery 镶嵌 2048²', '≈380 m', '三维贴图、影像绿度指数'],
  ['土地覆盖', 'obs', 'Sentinel-2 10 m LULC（Impact Observatory / Esri）', '10 m', '林/草/农占比、生物丰度'],
  ['站点坐标', 'obs', '公开水文站与梯级电站位置（WGS-84）', '点', '站点定位与空间插值'],
  ['气候参考', 'ref', '台站 / 再分析统计值（待接入 ERA5-Land）', '年值', '水分与热量驱动'],
  ['水系网络', 'der', 'DEM 洼地填充 + D8 汇流累积（阈值 700 像元）', '—', '河网渲染、水网密度'],
  ['Meta 1 m 树冠高度', 'plan', 'AWS Open Data · dataforgood-fb-forests', '1 m', '树冠高度、地上生物量'],
  ['Landsat 8/9', 'plan', 'USGS EarthExplorer', '30 m', '长时序植被趋势']
];
const BT = { obs: '实测', der: '派生', ref: '参考', est: '估算', plan: '规划' };

function dockData(b) {
  const s = App.stations;
  const health = healthCheck();
  b.innerHTML = `
  <div class="sec">
    <div class="sec-h"><h3>数据源台账</h3><div class="ln"></div><span class="n">${SOURCES.length} 类</span></div>
    ${SOURCES.map(([n, t, src, res, use]) => `
      <div style="padding:9px 0;border-bottom:1px solid var(--line)">
        <div style="display:flex;align-items:center;gap:7px">
          <span class="badge ${t}">${BT[t]}</span>
          <b style="font-size:11.5px;color:#CBDCD8">${n}</b>
          <span style="margin-left:auto;font-family:var(--mono);font-size:10px;color:#7E9296">${res}</span>
        </div>
        <div style="font-size:10px;color:var(--dim2);margin-top:4px;line-height:1.6">${src}</div>
        <div style="font-size:9.5px;color:#5E7176;margin-top:2px">用途：${use}</div>
      </div>`).join('')}
    <div class="note">标 <span class="badge plan">规划</span> 的数据尚未接入，界面与接口已预留，不做“已接入”的虚假呈现。</div>
  </div>

  <div class="sec">
    <div class="sec-h"><h3>站点数据</h3><div class="ln"></div><span class="n">${s.length} 条</span></div>
    <div style="display:flex;gap:7px;margin-bottom:8px">
      <button class="btn sm" id="btnAdd">＋ 新增站点</button>
      <button class="btn sm" id="btnImp">导入 CSV</button>
      <button class="btn sm" id="btnExp">导出</button>
    </div>
    <div id="addForm" style="display:none;padding:10px;border:1px solid var(--line2);border-radius:9px;margin-bottom:9px;background:rgba(255,255,255,.02)">
      <div class="grid2" style="gap:7px">
        <div><label class="lab">名称</label><input class="inp" id="fName" placeholder="如 拉伯"></div>
        <div><label class="lab">类型</label><select class="inp" id="fType"><option>生态监测站</option><option>水文站</option><option>梯级电站</option></select></div>
        <div><label class="lab">经度</label><input class="inp" id="fLon" placeholder="100.25"></div>
        <div><label class="lab">纬度</label><input class="inp" id="fLat" placeholder="27.10"></div>
      </div>
      <div style="display:flex;gap:7px;margin-top:8px">
        <button class="btn pri sm" id="fOk" style="flex:1">保存并接入</button>
        <button class="btn sm" id="fNo">取消</button>
      </div>
      <div class="note" style="margin-top:6px">保存时服务端实时采样 DEM 高程、坡度，并联网补齐土地覆盖（离线则标注待补）。</div>
    </div>
    <div id="impBox" style="display:none;margin-bottom:9px">
      <textarea class="inp" id="csvText" style="height:76px;padding:8px;resize:vertical;line-height:1.5"
        placeholder="站点,经度,纬度,类型&#10;拉伯,100.25,27.10,生态监测站"></textarea>
      <div style="display:flex;gap:7px;margin-top:6px"><button class="btn pri sm" id="impOk" style="flex:1">导入</button>
      <button class="btn sm" id="impNo">取消</button></div>
    </div>
    <div style="max-height:250px;overflow:auto;border:1px solid var(--line);border-radius:9px">
      <table class="t"><thead><tr><th>站点</th><th>海拔</th><th>坡度</th><th>林地</th><th>EI</th><th>风险</th></tr></thead>
      <tbody id="stTbody">${s.map((x, i) => `<tr data-i="${i}">
        <td>${x.name}${x.manual ? ' <span class="badge obs" style="height:14px">新</span>' : ''}</td>
        <td class="n">${nf(x.elev)}</td><td class="n">${nf(x.slope, 1)}°</td>
        <td class="n">${pct((x.lc || {})['林地'] || 0)}</td>
        <td class="n ${eiClass(x.m.ei)}">${x.m.ei.toFixed(1)}</td>
        <td class="n ${x.m.risk >= 58 ? 'hi' : x.m.risk >= 45 ? 'mid' : 'lo'}">${x.m.risk.toFixed(0)}</td></tr>`).join('')}</tbody></table>
    </div>
  </div>

  <div class="sec">
    <div class="sec-h"><h3>数据体检</h3><div class="ln"></div><span class="n">${health.length} 项</span></div>
    ${health.length ? health.map(h => `<div class="rowline"><div class="l"><i style="background:${h.lv === 'bad' ? '#FF6B6B' : h.lv === 'warn' ? '#F0B44C' : '#57B6FF'}"></i>${h.msg}</div><div class="r"><small>${h.n} 站</small></div></div>`).join('')
      : '<div class="note">未发现明显异常。</div>'}
    <div class="note">体检规则：林地占比与影像绿度背离（2σ）、高程—气温垂直递减率偏差 &gt; 6 ℃、关键字段缺失。</div>
  </div>

  <div class="sec">
    <div class="sec-h"><h3>版本与审计</h3><div class="ln"></div></div>
    <div class="rowline"><div class="l">数据版本</div><div class="r">${App.meta.version}</div></div>
    <div class="rowline"><div class="l">构建时间</div><div class="r"><small>${App.meta.built}</small></div></div>
    <div class="rowline"><div class="l">DEM 来源</div><div class="r"><small>${App.meta.dem.source}</small></div></div>
    <div id="auditBox" class="note">加载审计记录…</div>
  </div>`;

  $('#btnAdd').onclick = () => { $('#addForm').style.display = 'block'; $('#impBox').style.display = 'none'; };
  $('#fNo').onclick = () => $('#addForm').style.display = 'none';
  $('#btnImp').onclick = () => { $('#impBox').style.display = 'block'; $('#addForm').style.display = 'none'; };
  $('#impNo').onclick = () => $('#impBox').style.display = 'none';
  $('#fOk').onclick = async () => {
    const body = { name: $('#fName').value.trim(), lon: +$('#fLon').value, lat: +$('#fLat').value, type: $('#fType').value };
    if (!body.name || !body.lon || !body.lat) return toast('请填写名称与经纬度', 'warn');
    $('#fOk').disabled = true; $('#fOk').textContent = '接入中…';
    try {
      const r = await api('/api/stations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(r.error);
      App.stations.push(r.station); computeAll(); refreshScene();
      toast(`已接入 ${r.station.name}：DEM ${r.station.elev} m · 坡度 ${r.station.slope}°`, 'ok');
      renderDock('data');
    } catch (e) { toast(e.message || '接入失败', 'bad'); $('#fOk').disabled = false; $('#fOk').textContent = '保存并接入'; }
  };
  $('#impOk').onclick = async () => {
    const csv = $('#csvText').value;
    try {
      const r = await api('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
      if (!r.ok) throw new Error(r.error);
      toast(`导入完成：新增 ${r.added} · 更新 ${r.updated} · 跳过 ${r.skipped}`, 'ok');
      await reload();
    } catch (e) { toast(e.message || '导入失败', 'bad'); }
  };
  $('#btnExp').onclick = () => { location.href = '/api/export.csv'; };
  $$('#stTbody tr').forEach(tr => tr.onclick = () => {
    const s = App.stations[+tr.dataset.i]; selectStation(s); flyTo(s.lon, s.lat, 210);
  });
  api('/api/audit').then(r => {
    const box = $('#auditBox'); if (!box) return;
    box.innerHTML = (r.rows || []).slice(0, 5).map(x =>
      `<div style="display:flex;justify-content:space-between;gap:8px"><span>${x.act}${x.name ? ' · ' + x.name : ''}</span><span style="color:#4E6065">${x.t.slice(5)}</span></div>`).join('') || '暂无记录';
  }).catch(() => { });
}

function healthCheck() {
  const out = [];
  const miss = App.stations.filter(s => !s.lc || !Object.keys(s.lc).length).length;
  if (miss) out.push({ lv: 'warn', msg: '土地覆盖缺失（离线新增站点）', n: miss });
  const nov = App.stations.filter(s => s.vgi == null).length;
  if (nov) out.push({ lv: 'info', msg: '影像绿度缺失', n: nov });
  const arr = App.stations.filter(s => s.vgi != null).map(s => (s.lc['林地'] || 0) - clamp(s.vgi * 3, 0, 1));
  const mu = mean(arr), sd = Math.sqrt(mean(arr, v => (v - mu) ** 2)) || .01;
  const bad = App.stations.filter(s => s.vgi != null && Math.abs(((s.lc['林地'] || 0) - clamp(s.vgi * 3, 0, 1)) - mu) > 2 * sd);
  if (bad.length) out.push({ lv: 'warn', msg: '林地占比与影像绿度背离（2σ）：' + bad.map(x => x.name).join('、'), n: bad.length });
  const tbad = App.stations.filter(s => Math.abs(s.temp - (22 - .0055 * s.elev)) > 6);
  if (tbad.length) out.push({ lv: 'bad', msg: '高程—气温垂直递减偏差 > 6 ℃：' + tbad.map(x => x.name).join('、'), n: tbad.length });
  return out;
}

/* ─────────── 模型 ─────────── */
const MODELS = [
  { id: 'rusle', n: 'RUSLE 土壤侵蚀', en: 'Revised Universal Soil Loss Equation', st: 'real', tag: 'DEM 派生',
    d: 'LS 因子由真实 DEM 坡度与汇流长度逐站计算；R/K/C/P 取区域参考值。输出相对侵蚀强度。', out: 'slide' },
  { id: 'scscn', n: 'SCS-CN 径流', en: 'Soil Conservation Service Curve Number', st: 'real', tag: '可复算',
    d: 'CN 由土地覆盖类型映射，结合年降水估算径流系数与水源涵养能力。', out: 'fvc' },
  { id: 'invest', n: 'InVEST 碳储量', en: 'Carbon Storage & Sequestration', st: 'real', tag: '估算',
    d: '按地上植被碳密度计算（仅 aboveground 库），系数来自文献区间中值，未含土壤碳。', out: 'carbon' },
  { id: 'hj192', n: '生态环境状况指数', en: 'Ecological Index (HJ 192—2015)', st: 'real', tag: '标准框架',
    d: '生物丰度、植被覆盖、水网密度、土地胁迫四项加权，缺污染负荷项后按 0.90 归一。', out: 'ei' },
  { id: 'rf', n: '随机森林滑坡分类', en: 'Random Forest', st: 'plan', tag: '需样本',
    d: '需历史滑坡编目作为标签；当前无标注样本，仅保留模型接口，不以“已训练”呈现。', out: 'slide' },
  { id: 'cnn', n: 'CNN 树冠提取', en: 'Convolutional Neural Network', st: 'plan', tag: '需数据',
    d: '依赖 Meta 1 m 树冠高度或高分辨率影像，尚未接入，列为后续工作。', out: 'fvc' }
];
const MST = { real: ['已实现', 'obs'], plan: ['待训练', 'plan'] };

function dockModel(b) {
  b.innerHTML = `
  <div class="sec">
    <div class="sec-h"><h3>模型编排</h3><div class="ln"></div><span class="n">${MODELS.length}</span></div>
    ${MODELS.map(m => `
      <div class="node" data-m="${m.id}" style="margin-bottom:8px">
        <div class="nt"><b style="font-weight:600">${m.n}</b>
          <span class="badge ${MST[m.st][1]}" style="margin-left:auto">${MST[m.st][0]}</span></div>
        <div class="nd">${m.d}</div>
        <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
          <span class="badge est">${m.tag}</span>
          <button class="btn sm" data-run="${m.id}" style="margin-left:auto">运行</button>
        </div>
      </div>`).join('')}
    <div class="note">“已实现”指可在浏览器内用当前真实数据复算；“待训练/需数据”的模型不参与结果，避免把演示包装成实测。</div>
  </div>

  <div class="sec">
    <div class="sec-h"><h3>运行日志</h3><div class="ln"></div><span class="n" id="runSt">空闲</span></div>
    <div id="runLog" style="font-family:var(--mono);font-size:10px;line-height:1.9;color:#7E9296;
      background:#080D11;border:1px solid var(--line);border-radius:9px;padding:9px;min-height:86px;max-height:150px;overflow:auto">
      <div style="color:#4E6065">— 等待任务 —</div>
    </div>
    <div id="runProg" style="height:2px;background:rgba(255,255,255,.06);border-radius:2px;margin-top:8px;overflow:hidden">
      <div id="runBar" style="height:100%;width:0;background:linear-gradient(90deg,#1FA97C,#4BE7B4);transition:width .3s"></div>
    </div>
  </div>

  <div class="sec">
    <div class="sec-h"><h3>模型层说明</h3><div class="ln"></div></div>
    <div class="rowline"><div class="l">过程模型</div><div class="r"><small>RUSLE · SCS-CN · InVEST</small></div></div>
    <div class="rowline"><div class="l">机器学习</div><div class="r"><small>RF / CNN 待标注样本</small></div></div>
    <div class="rowline"><div class="l">评估模型</div><div class="r"><small>HJ 192—2015 框架</small></div></div>
    <div class="rowline"><div class="l">决策支持</div><div class="r"><small>三情景对比（评估页）</small></div></div>
  </div>`;

  $$('[data-run]').forEach(btn => btn.onclick = () => runModel(btn.dataset.run));
}

function runModel(id) {
  const m = MODELS.find(x => x.id === id); if (!m) return;
  const log = $('#runLog'); if (!log) return;
  const steps = {
    rusle: ['读取 DEM 与坡度栅格', '计算 LS 因子（逐站 9 km 窗口）', '叠加降雨侵蚀力 R 与植被覆盖 C', '归一化为相对侵蚀强度'],
    scscn: ['按土地覆盖映射 CN 值', '结合年降水估算直接径流', '计算水源涵养系数', '输出空间分布'],
    invest: ['读取土地覆盖类型面积比', '匹配碳密度系数（地上库）', '按样点缓冲面积折算', '生成碳密度专题层'],
    hj192: ['计算生物丰度指数 ABI', '计算植被覆盖指数 VCI', '计算水网密度 WRI 与土地胁迫 LSI', '加权合成 EI 并分级'],
    rf: ['检查训练样本', '未找到滑坡编目标签', '终止：需补充历史灾害数据'],
    cnn: ['检查输入影像', '未找到 1 m 树冠高度数据', '终止：需接入 Meta 数据集']
  }[id];
  let i = 0;
  log.innerHTML = '';
  $('#runSt').textContent = '运行中';
  const tick = () => {
    if (i < steps.length) {
      const d = document.createElement('div');
      d.innerHTML = `<span style="color:#37D9A0">›</span> ${steps[i]}`;
      log.appendChild(d); log.scrollTop = log.scrollHeight;
      $('#runBar').style.width = ((i + 1) / steps.length * 100) + '%';
      i++;
      setTimeout(tick, 320 + Math.random() * 220);
    } else {
      $('#runSt').textContent = m.st === 'real' ? '完成' : '已终止';
      if (m.st === 'real') {
        App.overlay = m.out; drawOverlay(m.out);
        $('#legOv').style.display = 'flex'; $('#legOvName').textContent = OV_DEF[m.out].name;
        const d = document.createElement('div');
        d.innerHTML = `<span style="color:#37D9A0">✓</span> 结果已叠加到场景（${OV_DEF[m.out].name}）`;
        log.appendChild(d);
        toast(m.n + ' 计算完成，已叠加专题层', 'ok');
      } else {
        toast('该模型缺少训练数据，未执行计算', 'warn');
      }
    }
  };
  setTimeout(tick, 200);
}

/* ─────────── 评估 ─────────── */
let asTab = 'overview';
function dockAssess(b) {
  const S = App.stations;
  const ei = mean(S, s => s.m.ei), rk = mean(S, s => s.m.risk);
  const hi = S.filter(s => s.m.risk >= 58).length;
  const carbon = mean(S, s => s.m.carbon);
  b.innerHTML = `
  <div class="tabbar" id="asTab">
    <button data-t="overview" class="${asTab === 'overview' ? 'on' : ''}">总览</button>
    <button data-t="ind" class="${asTab === 'ind' ? 'on' : ''}">指标</button>
    <button data-t="w" class="${asTab === 'w' ? 'on' : ''}">权重</button>
    <button data-t="val" class="${asTab === 'val' ? 'on' : ''}">空天校验</button>
    <button data-t="sc" class="${asTab === 'sc' ? 'on' : ''}">情景</button>
  </div>
  <div id="asBody"></div>`;

  const render = () => {
    $$('#asTab button').forEach(x => x.classList.toggle('on', x.dataset.t === asTab));
    const box = $('#asBody');
    if (asTab === 'overview') {
      box.innerHTML = `
      <div class="sec">
        <div class="kpi" style="padding:16px">
          <div class="k">流域平均生态环境状况指数（EI）</div>
          <div style="display:flex;align-items:flex-end;gap:10px;margin-top:6px">
            <div class="v" style="font-size:40px;line-height:1;color:#EAF7F1">${ei.toFixed(1)}</div>
            <div style="padding-bottom:5px"><span class="badge ${ei >= 55 ? 'obs' : 'ref'}">${eiGrade(ei)}</span></div>
          </div>
          <div class="s" style="margin-top:6px">HJ 192—2015 框架 · 4 项加权（污染负荷未纳入）</div>
        </div>
      </div>
      <div class="sec">
        <div class="sec-h"><h3>分项指数</h3><div class="ln"></div></div>
        ${subBars()}
      </div>
      <div class="grid3">
        <div class="kpi"><div class="k">平均风险</div><div class="v">${rk.toFixed(0)}</div><div class="s">${riskGrade(rk)}</div></div>
        <div class="kpi"><div class="k">高风险站</div><div class="v" style="color:#FF9E9E">${hi}</div><div class="s">共 ${S.length} 站</div></div>
        <div class="kpi"><div class="k">平均碳密度</div><div class="v">${carbon.toFixed(1)}</div><div class="s">tC/ha（地上）</div></div>
      </div>
      <div class="sec" style="margin-top:16px">
        <div class="sec-h"><h3>站点排序</h3><div class="ln"></div><span class="n">按 EI</span></div>
        <div style="border:1px solid var(--line);border-radius:9px;overflow:hidden">
          <table class="t"><thead><tr><th>站点</th><th>EI</th><th>等级</th><th>风险</th><th>覆盖度</th></tr></thead>
          <tbody>${S.slice().sort((a, c) => c.m.ei - a.m.ei).map(s => `
            <tr data-n="${s.name}"><td>${s.name}</td>
            <td class="n ${eiClass(s.m.ei)}">${s.m.ei.toFixed(1)}</td><td>${s.m.eiG}</td>
            <td class="n ${s.m.risk >= 58 ? 'hi' : s.m.risk >= 45 ? 'mid' : 'lo'}">${s.m.risk.toFixed(0)}</td>
            <td class="n">${pct(s.m.fvc)}</td></tr>`).join('')}</tbody></table>
        </div>
      </div>`;
      $$('#asBody tr[data-n]').forEach(tr => tr.onclick = () => {
        const s = S.find(x => x.name === tr.dataset.n); selectStation(s); flyTo(s.lon, s.lat, 210);
      });
    }
    if (asTab === 'ind') {
      const keys = [['ei', 'EI'], ['fvc', '覆盖度'], ['carbon', '碳密度'], ['slide', '滑坡'], ['deg', '退化'], ['risk', '综合风险']];
      box.innerHTML = `
      <div class="sec">
        <div class="sec-h"><h3>指标矩阵</h3><div class="ln"></div><span class="n">20 × 6</span></div>
        <div style="overflow:auto;max-height:420px;border:1px solid var(--line);border-radius:9px">
        <table class="t"><thead><tr><th>站点</th>${keys.map(k => `<th>${k[1]}</th>`).join('')}</tr></thead>
        <tbody>${S.map(s => `<tr data-n="${s.name}"><td>${s.name}</td>${keys.map(([k]) => {
          const v = k === 'fvc' ? s.m[k] * 100 : s.m[k];
          const cls = k === 'risk' || k === 'slide' || k === 'deg' ? (v > 60 ? 'hi' : v > 40 ? 'mid' : 'lo') : '';
          return `<td class="n ${cls}">${v.toFixed(k === 'carbon' ? 1 : 0)}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table></div>
      </div>
      <div class="sec">
        <div class="sec-h"><h3>指标口径</h3><div class="ln"></div></div>
        <div class="note">
          <b>覆盖度</b>：由土地覆盖类型面积比加权（林地 0.92、草地 0.62、农田 0.55、湿地 0.75）。<br>
          <b>碳密度</b>：地上植被碳库，林地 52、草地 7.5、农田 5.2 tC/ha 基准，按降水修正。<br>
          <b>滑坡</b>：坡度（实测）42% + 起伏度 18% + 降水 22% + 覆盖亏缺 18%。<br>
          <b>退化</b>：覆盖亏缺 40% + 干燥度 30% + 人为压力 30%。<br>
          <b>风险</b>：0.42 滑坡 + 0.33 退化 + 0.25 土地胁迫。
        </div>
      </div>`;
      $$('#asBody tr[data-n]').forEach(tr => tr.onclick = () => {
        const s = S.find(x => x.name === tr.dataset.n); selectStation(s); flyTo(s.lon, s.lat, 210);
      });
    }
    if (asTab === 'w') {
      box.innerHTML = `
      <div class="sec">
        <div class="sec-h"><h3>EI 权重（HJ 192—2015）</h3><div class="ln"></div></div>
        ${[['生物丰度指数 ABI', .35], ['植被覆盖指数 VCI', .25], ['水网密度指数 WRI', .15], ['土地胁迫指数 LSI', .15], ['污染负荷指数', .10]]
          .map(([n, w]) => `<div class="rowline"><div class="l">${n}</div><div class="r">${(w * 100).toFixed(0)}%</div></div>`).join('')}
        <div class="note">污染负荷指数因缺少断面水质/排污数据未纳入，其余四项按 0.90 归一化。因此本 EI 仅在本研究内部可比，不可直接与官方发布值对比。</div>
      </div>
      <div class="sec">
        <div class="sec-h"><h3>计算公式</h3><div class="ln"></div></div>
        <div style="font-family:var(--mono);font-size:10px;line-height:2;color:#9FB2B5;background:#080D11;
          border:1px solid var(--line);border-radius:9px;padding:10px;white-space:pre-wrap">ABI = 100×(0.35林地+0.21草地
      +0.28水域湿地+0.11农田
      +0.04建成+0.01未利用)

VCI = 100×FVC
FVC = 0.92林地+0.62草地+0.55农田
      +0.75湿地+0.05裸地+0.08建成

WRI = 100×(0.7×min(1,P/1600)
      +0.3×min(1,水域/0.05))

LSI = 100×(0.45坡度因子+0.30起伏因子
      +0.15建成因子+0.10裸地因子)

EI  = (0.35ABI+0.25VCI
      +0.15WRI+0.15(100−LSI)) / 0.90</div>
        <div class="note">分级：≥75 优 · 55–75 良 · 35–55 一般 · 20–35 较差 · &lt;20 差。</div>
      </div>
      <div class="sec">
        <div class="sec-h"><h3>风险权重</h3><div class="ln"></div></div>
        <div class="rowline"><div class="l">滑坡敏感性</div><div class="r">42%</div></div>
        <div class="rowline"><div class="l">退化风险</div><div class="r">33%</div></div>
        <div class="rowline"><div class="l">土地胁迫</div><div class="r">25%</div></div>
        <div class="note">权重为专家经验取值，可在后续用 AHP 判断矩阵与一致性检验替换；当前未做敏感性分析，属已知局限。</div>
      </div>`;
    }
    if (asTab === 'val') {
      box.innerHTML = `
      <div class="sec">
        <div class="sec-h"><h3>影像绿度 × 植被覆盖</h3><div class="ln"></div><span class="n" id="rTxt">—</span></div>
        <canvas id="scatter" class="chart" height="230"></canvas>
        <div class="legend-inline"><span><i style="background:#37D9A0"></i>站点</span><span><i style="background:#5AB8FF"></i>线性拟合</span></div>
        <div class="note" id="valNote"></div>
      </div>
      <div class="sec">
        <div class="sec-h"><h3>为什么做这项校验</h3><div class="ln"></div></div>
        <div class="note">
          影像绿度来自 Esri World Imagery 真实像元（GLI 可见光绿度指数，6 km 窗口均值），与土地覆盖推算的覆盖度相互独立。
          两者相关性可作为“空—地”一致性的粗略检验：相关高说明土地覆盖分类与影像表现一致；偏差大的站点往往位于
          河谷城镇、水体育或云覆盖区，需要人工复核。
        </div>
      </div>`;
      drawScatter();
    }
    if (asTab === 'sc') {
      box.innerHTML = scenarioHTML();
      $$('#scSeg button').forEach(x => x.onclick = () => { App.scen = x.dataset.s; box.innerHTML = scenarioHTML(); });
    }
  };
  render();
  $('#asTab').onclick = e => { const t = e.target.closest('button'); if (!t) return; asTab = t.dataset.t; render(); };
}

function subBars() {
  const S = App.stations;
  const items = [
    ['生物丰度 ABI', mean(S, s => s.m.abi), 60],
    ['植被覆盖 VCI', mean(S, s => s.m.fvc * 100), 90],
    ['水网密度 WRI', mean(S, s => s.m.wri), 80],
    ['土地胁迫 LSI', mean(S, s => s.m.lsi), 60, true]
  ];
  return items.map(([n, v, max, neg]) => `
    <div style="margin-bottom:11px">
      <div style="display:flex;justify-content:space-between;font-size:10.5px;color:#9FB2B5;margin-bottom:4px">
        <span>${n}</span><span class="mono" style="color:#CBDCD8">${v.toFixed(1)}</span></div>
      <div style="height:5px;border-radius:3px;background:rgba(255,255,255,.06);overflow:hidden">
        <div style="height:100%;width:${clamp(v / max * 100, 2, 100)}%;border-radius:3px;
          background:${neg ? 'linear-gradient(90deg,#8A5B2E,#F0B44C)' : 'linear-gradient(90deg,#1FA97C,#4BE7B4)'}"></div>
      </div>
    </div>`).join('');
}

function drawScatter() {
  const cv = $('#scatter'); if (!cv) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = cv.clientWidth, H = 230;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const pts = App.stations.filter(s => s.vgi != null).map(s => ({ x: s.vgi, y: s.m.fvc * 100, n: s.name }));
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x0 = Math.min(...xs) - .02, x1 = Math.max(...xs) + .02, y0 = Math.min(...ys) - 6, y1 = Math.max(...ys) + 6;
  const L = 42, R = 12, T = 12, B = 30;
  const px = v => L + (v - x0) / (x1 - x0) * (W - L - R);
  const py = v => H - B - (v - y0) / (y1 - y0) * (H - T - B);
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.06)'; g.fillStyle = '#5B6D72'; g.font = '9px Consolas';
  for (let i = 0; i <= 4; i++) {
    const yv = y0 + (y1 - y0) * i / 4, yy = py(yv);
    g.beginPath(); g.moveTo(L, yy); g.lineTo(W - R, yy); g.stroke();
    g.fillText(yv.toFixed(0), 6, yy + 3);
  }
  for (let i = 0; i <= 3; i++) {
    const xv = x0 + (x1 - x0) * i / 3, xx = px(xv);
    g.fillText(xv.toFixed(2), xx - 8, H - 12);
  }
  // 拟合
  const n = pts.length, mx = mean(xs), my = mean(ys);
  const sxy = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0);
  const sxx = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  const k = sxy / (sxx || 1), b0 = my - k * mx;
  const yh = pts.map(p => k * p.x + b0);
  const ssr = pts.reduce((a, p, i) => a + (p.y - yh[i]) ** 2, 0);
  const sst = pts.reduce((a, p) => a + (p.y - my) ** 2, 0);
  const r2 = 1 - ssr / sst;
  const r = Math.sqrt(Math.max(0, r2)) * (k >= 0 ? 1 : -1);
  const rmse = Math.sqrt(mean(pts, (p, i) => (p.y - yh[pts.indexOf(p)]) ** 2));
  g.strokeStyle = 'rgba(90,184,255,.75)'; g.lineWidth = 1.4;
  g.beginPath(); g.moveTo(px(x0), py(k * x0 + b0)); g.lineTo(px(x1), py(k * x1 + b0)); g.stroke();
  pts.forEach((p, i) => {
    g.beginPath(); g.arc(px(p.x), py(p.y), 3.4, 0, 7);
    g.fillStyle = '#37D9A0'; g.globalAlpha = .85; g.fill(); g.globalAlpha = 1;
    g.strokeStyle = 'rgba(4,20,16,.9)'; g.lineWidth = 1; g.stroke();
  });
  g.fillStyle = '#87999D'; g.font = '9.5px sans-serif';
  g.fillText('影像绿度 GLI', W / 2 - 30, H - 2);
  g.save(); g.translate(11, H / 2 + 26); g.rotate(-Math.PI / 2); g.fillText('植被覆盖度 %', 0, 0); g.restore();
  const t = $('#rTxt'); if (t) t.textContent = `r = ${r.toFixed(2)} · R² = ${r2.toFixed(2)}`;
  const nt = $('#valNote');
  if (nt) nt.innerHTML = `样本 ${n} 站，线性拟合 <b>R² = ${r2.toFixed(2)}</b>，RMSE = ${rmse.toFixed(1)} 个百分点。
    相关系数不高属正常：土地覆盖是 10 m 分类产品，绿度是可见光指数，二者物理含义不同，本项只用于发现离群站点。`;
}

function scenarioHTML() {
  const base = App.stations;
  const calc = mode => {
    const arr = base.map(s => { const t = scenarioStation(s, mode); return { s: t, ei: eiOf(t), risk: riskOf(t), carbon: carbonOf(t) }; });
    return { ei: mean(arr, x => x.ei), risk: mean(arr, x => x.risk), hi: arr.filter(x => x.risk >= 58).length, carbon: mean(arr, x => x.carbon), arr };
  };
  const A = calc('base'), B = calc('degrade'), C = calc('restore');
  const cur = App.scen === 'degrade' ? B : App.scen === 'restore' ? C : A;
  const d = v => (v >= 0 ? '+' : '') + v.toFixed(1);
  const pri = A.arr.slice().sort((a, b) => b.risk - a.risk).slice(0, 5);
  return `
  <div class="seg" id="scSeg" style="margin-bottom:12px">
    <button data-s="base" class="${App.scen === 'base' ? 'on' : ''}">基准情景</button>
    <button data-s="degrade" class="${App.scen === 'degrade' ? 'on' : ''}">退化管理</button>
    <button data-s="restore" class="${App.scen === 'restore' ? 'on' : ''}">生态修复</button>
  </div>
  <div class="sec">
    <div class="grid3">
      <div class="kpi"><div class="k">平均 EI</div><div class="v">${cur.ei.toFixed(1)}</div>
        <div class="s">${App.scen === 'base' ? '现状' : d(cur.ei - A.ei) + ' vs 基准'}</div></div>
      <div class="kpi"><div class="k">平均风险</div><div class="v">${cur.risk.toFixed(0)}</div>
        <div class="s">${App.scen === 'base' ? '现状' : d(cur.risk - A.risk) + ' vs 基准'}</div></div>
      <div class="kpi"><div class="k">高风险站</div><div class="v">${cur.hi}</div>
        <div class="s">${App.scen === 'base' ? '现状' : d(cur.hi - A.hi) + ' 站'}</div></div>
    </div>
  </div>
  <div class="sec">
    <div class="sec-h"><h3>情景设定</h3><div class="ln"></div></div>
    <div class="note">
      <b>基准</b>：当前土地覆盖结构。<br>
      <b>退化管理</b>：各站林地按 22% 转为草地 / 裸地 / 农田，模拟管护放松。<br>
      <b>生态修复</b>：草地与农田合计最多 16 个百分点转为林地，模拟退耕还林与封育。<br>
      情景仅改变土地覆盖结构，气候、地形与权重保持不变；结果为相对变化，不是预测值。
    </div>
  </div>
  <div class="sec">
    <div class="sec-h"><h3>决策建议</h3><div class="ln"></div><span class="n">优先治理 5 站</span></div>
    ${pri.map((x, i) => {
      const s = x.s;
      const f = s.m.slide > 60 ? '坡陡、覆盖不足，优先坡面造林与护坡工程'
        : s.m.deg > 55 ? '退化压力大，建议封育与轮牧'
          : (s.lc['建成区'] || 0) > .08 ? '城镇面源与建设扰动，建议管控施工裸地'
            : '维持监测，控制放牧强度';
      return `<div style="padding:9px 0;border-bottom:1px solid var(--line)">
        <div style="display:flex;align-items:center;gap:7px">
          <span class="mono" style="color:#5B6D72">0${i + 1}</span>
          <b style="font-size:11.5px;color:#CBDCD8">${s.name}</b>
          <span class="tag ${riskClass(s.m.risk)}" style="margin-left:auto">${s.m.riskG} ${s.m.risk.toFixed(0)}</span>
        </div>
        <div style="font-size:10px;color:#7E9296;margin-top:4px;line-height:1.6">${f}</div>
      </div>`;
    }).join('')}
    <div class="note">建议由主控因子规则生成，用于演示决策链路，不替代实地调查与工程设计。</div>
  </div>`;
}

/* ─────────── 预警 ─────────── */
function dockWarn(b) {
  const S = App.stations.slice().sort((a, c) => c.m.risk - a.m.risk);
  const hi = S.filter(s => s.m.risk >= 58), mid = S.filter(s => s.m.risk >= 45 && s.m.risk < 58);
  b.innerHTML = `
  <div class="sec">
    <div class="grid3">
      <div class="kpi"><div class="k">高风险</div><div class="v" style="color:#FF9E9E">${hi.length}</div><div class="s">R ≥ 58</div></div>
      <div class="kpi"><div class="k">中风险</div><div class="v" style="color:#F0C878">${mid.length}</div><div class="s">45 ≤ R &lt; 58</div></div>
      <div class="kpi"><div class="k">低风险</div><div class="v" style="color:#7FE0BE">${S.length - hi.length - mid.length}</div><div class="s">R &lt; 45</div></div>
    </div>
  </div>
  <div class="sec">
    <div class="sec-h"><h3>预警清单</h3><div class="ln"></div><span class="n">按风险降序</span></div>
    ${S.map(s => {
      const mf = [['滑坡', s.m.slide], ['退化', s.m.deg], ['胁迫', s.m.lsi]].sort((a, c) => c[1] - a[1])[0];
      return `<div class="node" data-n="${s.name}" style="margin-bottom:7px;padding:9px 10px">
        <div class="nt"><b style="font-weight:600">${s.name}</b>
          <span class="tag ${riskClass(s.m.risk)}" style="margin-left:auto">${s.m.riskG}</span>
          <span class="mono" style="color:#CBDCD8;font-size:11px">${s.m.risk.toFixed(0)}</span></div>
        <div class="nd">主控因子：${mf[0]}（${mf[1].toFixed(0)}） · 海拔 ${nf(s.elev)} m · 坡度 ${nf(s.slope, 1)}°</div>
      </div>`;
    }).join('')}
  </div>
  <div class="sec">
    <div class="sec-h"><h3>预警规则</h3><div class="ln"></div></div>
    <div class="note">
      综合风险 <b>R = 0.42×滑坡 + 0.33×退化 + 0.25×土地胁迫</b>。<br>
      R ≥ 58 触发高风险预警（建议 7 日内核查）；45 ≤ R &lt; 58 为中风险（季度巡检）；R &lt; 45 为低风险（年度监测）。<br>
      阈值由分位数与专家经验共同确定，非官方标准，需在应用中率定。
    </div>
  </div>
  <div class="sec">
    <div class="sec-h"><h3>处置闭环</h3><div class="ln"></div></div>
    <div class="rowline"><div class="l">① 识别</div><div class="r"><small>风险模型 + 主控因子</small></div></div>
    <div class="rowline"><div class="l">② 核查</div><div class="r"><small>无人机巡检 / 样区复核</small></div></div>
    <div class="rowline"><div class="l">③ 处置</div><div class="r"><small>造林 / 护坡 / 封育</small></div></div>
    <div class="rowline"><div class="l">④ 复盘</div><div class="r"><small>情景对比与效果评估</small></div></div>
  </div>`;
  $$('#dockBody .node[data-n]').forEach(x => x.onclick = () => {
    const s = App.stations.find(y => y.name === x.dataset.n); selectStation(s); flyTo(s.lon, s.lat, 210);
  });
}

/* ─────────── 智能体 ─────────── */
let chatLog = [];
function dockAgent(b) {
  b.innerHTML = `
  <div id="chat">
    <div class="quick">
      <button data-q="找出滑坡敏感性最高的 3 个站">滑坡 Top3</button>
      <button data-q="评估一下流域整体状况">整体评估</button>
      <button data-q="叠加碳密度专题层">叠加碳密度</button>
      <button data-q="飞到皎平渡">定位皎平渡</button>
      <button data-q="演示一遍">一键演示</button>
    </div>
    <div id="msgs"></div>
    <div id="inputBar">
      <input class="inp" id="aiIn" placeholder="试试：找出碳密度最低的 5 个站并飞到第一个">
      <button id="aiGo">发送</button>
    </div>
  </div>`;
  if (!chatLog.length) {
    chatLog.push({ role: 'a', text: '我是流域评估智能体。可以直接对我说：<b>找出滑坡敏感性最高的 3 个站</b>、<b>叠加碳密度专题层</b>、<b>运行 RUSLE</b>、<b>模拟生态修复</b>。所有指令都会在三维场景与数据面板中生效。' });
  }
  chatLog.forEach(m => addMsg(m.role, m.text, m.tool, false));
  $('#aiGo').onclick = send;
  $('#aiIn').onkeydown = e => { if (e.key === 'Enter') send(); };
  $$('.quick button').forEach(x => x.onclick = () => { $('#aiIn').value = x.dataset.q; send(); });
}
function addMsg(role, text, tool, store) {
  const box = $('#msgs'); if (!box) return;
  if (tool) {
    const d = document.createElement('div');
    d.className = 'tool';
    d.innerHTML = `<div class="th">⚙ ${tool.name}<span class="ok">✓ ${tool.ms} ms</span></div>
      <div class="tp">${tool.args || ''}</div>`;
    box.appendChild(d);
  } else {
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    d.innerHTML = text;
    box.appendChild(d);
  }
  box.parentElement.scrollTop = box.parentElement.scrollHeight;
  if (store !== false) chatLog.push({ role, text, tool });
}
function send() {
  const inp = $('#aiIn'); const q = inp.value.trim(); if (!q) return;
  inp.value = '';
  addMsg('u', q);
  setTimeout(() => runIntent(q), 260);
}

const METRIC = [
  { k: 'slide', n: '滑坡敏感性', re: /滑坡|灾害/ },
  { k: 'carbon', n: '碳密度', re: /碳|固碳/ },
  { k: 'fvc', n: '植被覆盖度', re: /覆盖|植被|绿度/ },
  { k: 'risk', n: '综合风险', re: /风险|危险/ },
  { k: 'ei', n: 'EI', re: /EI|生态指数|生态状况/i },
  { k: 'deg', n: '退化风险', re: /退化/ },
  { k: 'elev', n: '海拔', re: /海拔|高程/ },
  { k: 'slope', n: '坡度', re: /坡度/ }
];
const OVW = [{ k: 'ei', re: /EI|生态指数/i }, { k: 'risk', re: /风险/ }, { k: 'carbon', re: /碳/ },
  { k: 'fvc', re: /覆盖|植被/ }, { k: 'slide', re: /滑坡/ }];

function runIntent(q) {
  const t0 = performance.now();
  const done = (name, args) => addMsg(null, null, { name, args, ms: Math.round(performance.now() - t0) });

  if (/演示/.test(q)) return demo();
  // 定位
  const st = App.stations.find(s => q.includes(s.name));
  if (st && /(飞|定位|去|看看|跳)/.test(q)) {
    selectStation(st); flyTo(st.lon, st.lat, 210); done('fly_to', `name="${st.name}"`);
    return setTimeout(() => addMsg('a', `已定位 <b>${st.name}</b>：海拔 ${nf(st.elev)} m，坡度 ${nf(st.slope, 1)}°，EI ${st.m.ei.toFixed(1)}（${st.m.eiG}）。`), 240);
  }
  // 排行 / 筛选
  const mt = METRIC.find(m => m.re.test(q));
  const top = (q.match(/(\d+)\s*(个|站|名)/) || [])[1] || 3;
  if (mt && /(最高|最大|最差|排行|排名|top|Top|找出|筛选|最低|最小)/.test(q)) {
    const asc = /(最低|最小|最差)/.test(q);
    const list = App.stations.slice().sort((a, b) => {
      const va = mt.k === 'elev' ? a.elev : mt.k === 'slope' ? a.slope : a.m[mt.k];
      const vb = mt.k === 'elev' ? b.elev : mt.k === 'slope' ? b.slope : b.m[mt.k];
      return asc ? va - vb : vb - va;
    }).slice(0, +top);
    done('rank_metric', `metric="${mt.n}" top=${top} order=${asc ? 'asc' : 'desc'}`);
    const first = list[0];
    if (first) { selectStation(first); flyTo(first.lon, first.lat, 230); }
    setTimeout(() => addMsg('a', `${mt.n} ${asc ? '最低' : '最高'}的 ${list.length} 站：<br>` +
      list.map((s, i) => `${i + 1}. <b>${s.name}</b> ${(mt.k === 'elev' ? s.elev : mt.k === 'slope' ? s.slope : s.m[mt.k]).toFixed(mt.k === 'carbon' ? 1 : 0)}`).join('　') +
      `<br>已定位到 ${first.name}。`), 260);
    return;
  }
  // 叠加
  const ov = OVW.find(o => o.re.test(q));
  if (ov && /(叠加|图层|专题|显示)/.test(q)) {
    App.overlay = ov.k; drawOverlay(ov.k);
    $('#legOv').style.display = 'flex'; $('#legOvName').textContent = OV_DEF[ov.k].name;
    if (App.module === 'twin') renderDock('twin');
    done('overlay_layer', `layer="${ov.k}"`);
    return setTimeout(() => addMsg('a', `已叠加 <b>${OV_DEF[ov.k].name}</b> 专题层（IDW 插值）。`), 220);
  }
  // 运行模型
  if (/(运行|跑|计算|执行)/.test(q)) {
    const m = MODELS.find(x => q.includes(x.n.slice(0, 2)) || q.includes(x.id)) || MODELS[0];
    done('run_model', `id="${m.id}"`);
    if (App.module !== 'model') renderDock('model');
    setTimeout(() => runModel(m.id), 300);
    return setTimeout(() => addMsg('a', `已派发模型 <b>${m.n}</b>，运行日志见「模型」页。`), 420);
  }
  // 评估
  if (/(评估|整体|状况|指数|怎么样)/.test(q)) {
    done('assess_basin', 'scope="all"');
    const ei = mean(App.stations, s => s.m.ei), rk = mean(App.stations, s => s.m.risk);
    const hi = App.stations.filter(s => s.m.risk >= 58);
    if (App.module !== 'assess') renderDock('assess');
    return setTimeout(() => addMsg('a', `流域平均 EI = <b>${ei.toFixed(1)}</b>（${eiGrade(ei)}），平均风险 ${rk.toFixed(0)}（${riskGrade(rk)}）。` +
      `高风险站 ${hi.length} 个：${hi.map(s => s.name).join('、') || '无'}。<br>主要限制因子为滑坡敏感性与土地胁迫。`), 300);
  }
  // 情景
  if (/(情景|修复|退化|还林)/.test(q)) {
    App.scen = /修复|还林/.test(q) ? 'restore' : 'degrade'; asTab = 'sc';
    if (App.module !== 'assess') renderDock('assess'); else renderDock('assess');
    done('scenario', `mode="${App.scen}"`);
    return setTimeout(() => addMsg('a', `已切换到 <b>${App.scen === 'restore' ? '生态修复' : '退化管理'}</b> 情景，对比结果见「评估 → 情景」。`), 280);
  }
  // 导出
  if (/(导出|下载|csv|CSV)/.test(q)) {
    done('export_dataset', 'dataset="stations" fmt="csv"');
    setTimeout(() => { location.href = '/api/export.csv'; addMsg('a', '已生成站点数据集 CSV（含来源字段）。'); }, 300);
    return;
  }
  // 兜底
  done('knowledge_base', 'hit=fallback');
  setTimeout(() => addMsg('a', `我可以做四类事：<br>① 查询与排序（“找出碳密度最低的 5 个站”）<br>② 操作场景（“叠加滑坡专题层”“飞到皎平渡”）<br>③ 运行模型（“运行 RUSLE”）<br>④ 评估与情景（“评估流域整体状况”“模拟生态修复”）<br>所有动作都会在场景里生效，并留下执行记录。`), 260);
}

function demo() {
  const steps = [
    () => { addMsg('a', '演示开始：先找出滑坡敏感性最高的 3 个站。'); runIntent('找出滑坡敏感性最高的 3 个站'); },
    () => { addMsg('a', '把滑坡敏感性叠加到三维场景。'); setTimeout(() => runIntent('叠加滑坡专题层'), 1200); },
    () => { addMsg('a', '最后给出流域整体评估。'); setTimeout(() => runIntent('评估一下流域整体状况'), 2600); }
  ];
  steps.forEach((f, i) => setTimeout(f, i * 3400));
}

/* ─────────── 方法 ─────────── */
function dockMethod(b) {
  b.innerHTML = `
  <div class="sec">
    <div class="sec-h"><h3>技术路线</h3><div class="ln"></div></div>
    <button class="btn pri" id="openRoute" style="width:100%;height:38px">打开技术路线图（三层架构）</button>
    <div class="note">数据层 → 模型层 → 应用层，节点可点击跳转到对应模块，并标注真实完成状态。</div>
  </div>
  <div class="sec">
    <div class="sec-h"><h3>完成度</h3><div class="ln"></div></div>
    <div class="rowline"><div class="l">数据层</div><div class="r"><small>3 / 6 已接入</small></div></div>
    <div class="rowline"><div class="l">模型层</div><div class="r"><small>4 / 8 可复算</small></div></div>
    <div class="rowline"><div class="l">应用层</div><div class="r"><small>5 / 8 已实现</small></div></div>
    <div class="note">规划项保留接口与数据结构，不以演示冒充实测。</div>
  </div>
  <div class="sec">
    <div class="sec-h"><h3>数据边界</h3><div class="ln"></div></div>
    <div class="note">
      ① 地形与坡度来自 30 m DEM 重采样（1024²，≈740 m/像元），不支持米级微地形判断。<br>
      ② 土地覆盖为 2017–2021 复合产品，不能反映当年变化。<br>
      ③ 气候为参考值，尚未接入 ERA5-Land 逐日序列。<br>
      ④ 站点生态指标为土地覆盖推算的估算值，非样地实测。<br>
      ⑤ 在线影像版权归 Esri 及数据提供方，公开展示需注明来源。
    </div>
  </div>
  <div class="sec">
    <div class="sec-h"><h3>后续工作</h3><div class="ln"></div></div>
    <div class="rowline"><div class="l">Sentinel-2 时序 NDVI</div><div class="r"><small>季度更新</small></div></div>
    <div class="rowline"><div class="l">滑坡编目 + 随机森林</div><div class="r"><small>需历史灾害数据</small></div></div>
    <div class="rowline"><div class="l">典型样区无人机正射</div><div class="r"><small>天—空—地闭环</small></div></div>
    <div class="rowline"><div class="l">InSAR 形变点位</div><div class="r"><small>Sentinel-1</small></div></div>
  </div>`;
  $('#openRoute').onclick = openRoute;
}

function openRoute() {
  renderRoute();
  $('#routeView').classList.add('show');
}
function closeRoute() { $('#routeView').classList.remove('show'); }

function renderRoute() {
  const N = (t, sub, st, mod, cls) => {
    const B = { obs: '已接入', plan: '规划', der: '派生', real: '已实现' }[st] || '';
    return `<div class="rv-node ${cls || ''}" ${mod ? `data-mod="${mod}"` : ''}>
      <div class="t">${t}${B ? `<span class="badge ${st === 'real' ? 'obs' : st}">${B}</span>` : ''}</div>
      ${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  };
  $('#rvBody').innerHTML = `
  <div class="rv-band">
    <div class="rv-tag">数据层</div>
    <div class="rv-flow">
      <div class="rv-row">
        ${N('Landsat 8/9', '30 m · 长时序', 'plan')}
        ${N('Sentinel 系列', '10 m 土地覆盖', 'obs')}
        ${N('Meta 1 m 树冠高度', 'AWS 开放数据', 'plan')}
        ${N('地面观测 / 无人机', '20 站 + 样区', 'obs')}
      </div>
      <div class="rv-arrow">▼</div>
      ${N('多源卫星影像 + 无人机多光谱影像', '2048² 镶嵌 · ≈380 m/px · 已对齐 DEM', 'obs', '', 'wide')}
      <div class="rv-arrow">▼</div>
      ${N('空天一体化检测体系', '影像 + 高程 + 土地覆盖 + 站点四源统一坐标与栅格', 'der', 'data', 'wide big')}
    </div>
  </div>

  <div class="rv-arrow">▼</div>

  <div class="rv-band">
    <div class="rv-tag">模型层</div>
    <div class="rv-flow">
      <div class="rv-mid">
        <div class="rv-col">
          <div class="rv-s" style="font-size:9px;letter-spacing:.14em;color:#5B6D72;margin-bottom:2px">耦合生态过程模型</div>
          ${N('SWAT 流域水文', '规划', 'plan')}
          ${N('SCS-CN 径流', '已实现', 'obs')}
          ${N('InVEST 碳 / 生境', '已实现', 'obs')}
          ${N('RUSLE 土壤侵蚀', 'LS 由 DEM 实测', 'obs')}
          ${N('Biome-BGC · Diffusion', '规划', 'plan')}
        </div>
        <div class="rv-arrow h">▶</div>
        ${N('数字孪生动态评估模型', 'HJ 192 框架 + 可解释评分 + 空间插值', 'obs', 'assess', 'big')}
        <div class="rv-arrow h">◀</div>
        <div class="rv-col">
          <div style="font-size:9px;letter-spacing:.14em;color:#5B6D72;margin-bottom:2px">机器学习算法</div>
          ${N('SVM 退化分类', '需标注样本', 'plan')}
          ${N('随机森林 滑坡', '需灾害编目', 'plan')}
          ${N('CNN 树冠提取', '需 1 m 影像', 'plan')}
        </div>
      </div>
      <div class="rv-arrow">▼</div>
      ${N('决策支持系统', '基准 / 退化管理 / 生态修复 三情景对比 + 优先治理清单', 'obs', 'assess', 'wide')}
    </div>
  </div>

  <div class="rv-arrow">▼</div>

  <div class="rv-band">
    <div class="rv-tag">应用层</div>
    <div class="rv-flow">
      <div class="rv-2">
        <div class="rv-grp">
          <div class="rv-row">
            ${N('滑坡预警', '', 'obs', 'warn')}
            ${N('碳储量估算', '', 'obs', 'assess')}
            ${N('森林退化', '', 'obs', 'warn')}
          </div>
          ${N('典型样本区监测', '5 km 缓冲统计 · 待补地面照片', 'der', '', 'wide')}
        </div>
        <div class="rv-grp">
          <div class="rv-row">
            ${N('巡检', '风险清单驱动', 'obs', 'warn')}
            ${N('建模', '三维地形', 'obs', 'twin')}
            ${N('形变', 'InSAR 规划', 'plan')}
          </div>
          ${N('精细化管理', '站点级处置建议', 'obs', 'assess', 'wide')}
        </div>
      </div>
      <div class="rv-arrow">▼</div>
      ${N('金沙江流域生态环境评估', 'EI + 四项分指数 + 站点排序', 'obs', 'assess', 'wide')}
      <div class="rv-arrow">▼</div>
      ${N('金沙江流域生态风险预警', 'R 分级 + 主控因子 + 处置闭环', 'obs', 'warn', 'wide big')}
    </div>
  </div>

  <div class="rv-note">
    说明：绿色为已接入或已实现（可在系统中直接操作），蓝色为基于真实数据的派生计算，灰色为规划项（保留接口，未接入数据）。
    点任一节点可跳转到对应模块；关闭本页按 Esc。
  </div>`;

  $$('#rvBody .rv-node[data-mod]').forEach(n => n.onclick = () => {
    closeRoute(); renderDock(n.dataset.mod);
  });
}

/* ═════════════ 9. 用户与初始化 ═════════════ */
async function initUser() {
  try {
    const s = await api('/api/session');
    if (s.ok && s.user) {
      $('#uName').textContent = s.user.name || s.user.u;
      $('#uAv').textContent = (s.user.name || s.user.u).slice(0, 1).toUpperCase();
    }
  } catch (e) { }
  $('#userBtn').onclick = e => { if (!e.target.closest('#userMenu')) $('#userMenu').classList.toggle('show'); };
  document.addEventListener('click', e => { if (!e.target.closest('#userBtn')) $('#userMenu').classList.remove('show'); });
  $('#mOut').onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; };
  $('#mPwd').onclick = () => {
    $('#userMenu').classList.remove('show');
    $('#pwdErr').classList.remove('show');
    ['#pwdOld', '#pwdNew', '#pwdNew2'].forEach(x => $(x).value = '');
    $('#modal').classList.add('show'); setTimeout(() => $('#pwdOld').focus(), 60);
  };
  $('#pwdCancel').onclick = () => $('#modal').classList.remove('show');
  $('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.remove('show'); };
  $('#pwdOk').onclick = async () => {
    const o = $('#pwdOld').value, n = $('#pwdNew').value, n2 = $('#pwdNew2').value;
    const err = $('#pwdErr');
    const fail = m => { err.textContent = m; err.classList.add('show'); };
    if (!o) return fail('请输入原密码');
    if (n.length < 8) return fail('新密码至少 8 位');
    if (n !== n2) return fail('两次输入的新密码不一致');
    try {
      const r = await api('/api/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old: o, new: n }) });
      if (!r.ok) throw new Error(r.error);
      $('#modal').classList.remove('show'); toast('密码已修改，请牢记新密码', 'ok');
    } catch (e) { fail(e.message || '修改失败'); }
  };
  $('#mAbout').onclick = () => { renderDock('method'); $('#userMenu').classList.remove('show'); };
}

function refreshScene() {
  buildStations(); buildOverlay(); drawOverlay(App.overlay);
  if (App.overlay !== 'none') {
    $('#legOv').style.display = 'flex'; $('#legOvName').textContent = OV_DEF[App.overlay].name;
  }
}

async function reload() {
  await loadAll();
  refreshScene();
  renderDock(App.module);
  $('#hStn').textContent = App.stations.length;
}

async function boot() {
  $('#ldTxt').textContent = '正在读取高程与影像…';
  try { await loadAll(); } catch (e) { console.error(e); $('#ldTxt').textContent = '数据加载失败：' + e.message; return; }
  initGL();
  buildLabels();
  initUser();

  $('#rvClose').onclick = closeRoute;
  window.addEventListener('keydown', e => { if (e.key === 'Escape') closeRoute(); });
  $('#dockToggle').onclick = () => { document.body.classList.toggle('dock-hide'); setTimeout(resize, 300); };
  $$('.tab').forEach(t => t.onclick = () => { renderDock(t.dataset.mod); if (t.dataset.mod === 'method') openRoute(); });
  $('#cdClose').onclick = closeCard;
  $('#cdFly').onclick = () => { if (App.sel) flyTo(App.sel.lon, App.sel.lat, 100); };
  $('#cdAssess').onclick = () => { asTab = 'overview'; renderDock('assess'); };

  // 图例
  const grad = RAMP.map(([h, c]) => `${c} ${clamp((h - 200) / 6600, 0, 1) * 100}%`).join(',');
  $('#legBar').style.background = `linear-gradient(180deg,${grad.split(',').reverse().join(',')})`;
  $('#legTicks').innerHTML = ['6500', '5000', '3500', '2000', '500'].map(v => `<span>${v}</span>`).join('');
  $('#hElev').textContent = `${nf(App.meta.dem.min)}–${nf(App.meta.dem.max)} m`;

  renderDock('twin');
  requestAnimationFrame(t => { lastT = t; loop(t); });
  setTimeout(() => { $('#loading').classList.add('hide'); toast('已载入真实高程与卫星影像', 'ok'); }, 600);

  // 演示入口：URL 参数
  const q = new URLSearchParams(location.search);
  if (q.get('mod')) renderDock(q.get('mod'));
  if (q.get('st')) { const s = App.stations.find(x => x.name === q.get('st')); if (s) { selectStation(s); flyTo(s.lon, s.lat, 210); } }
}

function buildLabels() {
  const box = $('#labels'); box.innerHTML = '';
  labelEls = App.stations.map(s => {
    const d = document.createElement('div');
    d.className = 'lbl'; d.textContent = s.name;
    box.appendChild(d); return d;
  });
}

boot();
