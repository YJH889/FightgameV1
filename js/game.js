/* ============================================================
   主程序：资源、场景、战斗循环、界面
   ============================================================ */

const $ = (id) => document.getElementById(id);
const SPRITES = {};
const PORTRAITS = {};
let BIKE_IMG = null;   // 跳跳外卖车贴图（美团外卖电动车）
let MILK_IMG = null;   // 野生狗奶贴图（大狗 O 技能投射物）

/* ---------------- 资源 ---------------- */
function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('加载失败: ' + src));
    im.src = src;
  });
}

function mixHex(hex, target, k) {
  const p = (h) => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16));
  const a = p(hex), b = p(target);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * k));
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
}

function makeSprite(img, color) {
  const w = img.width, h = img.height;
  const mk = (col) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = col;
    x.fillRect(0, 0, w, h);
    return c;
  };
  return {
    img, w, h,
    white: mk('#ffffff'),
    tint: mk(color),
    ghost: mk(mixHex(color, '#ffffff', 0.62))
  };
}

/* 每名角色需要预载的姿势贴图；走路帧 walk_0..3 额外按 4 张计入进度 */
const POSE_SETS = {
  dog: ['idle', 'punch', 'kick', 'block', 'jkick', 'bite', 'walk', 'jump', 'hurt', 'ko', 'milk_0', 'milk_1', 'milk_2'],
  whalie: ['idle', 'walk', 'punch', 'kick', 'block', 'jump', 'hurt', 'sing'],
  frost: ['idle', 'punch', 'kick', 'walk', 'jump', 'block', 'hurt', 'skill'],
  hopper: ['idle', 'punch', 'kick', 'jump', 'block', 'skill', 'skykick'],
  naiwa: ['idle', 'punch', 'kick', 'jump', 'block', 'hurt', 'laugh', 'slam_0', 'slam_1', 'slam_2'],
  spade: ['idle', 'punch', 'kick', 'jump', 'block', 'hurt', 'sorry']
};

let loadDone = 0, loadTotal = 1;
function loadTick() {
  loadDone++;
  const p = Math.min(1, loadDone / loadTotal);
  $('load-fill').style.width = (p * 100).toFixed(0) + '%';
  $('load-txt').textContent = 'LOADING… ' + Math.round(p * 100) + '%';
}
/* 计数版加载：无论成功失败都推进一次进度，失败交给调用方兜底 */
function trackedImage(src) {
  return loadImage(src).then(
    (im) => { loadTick(); return im; },
    (e) => { loadTick(); throw e; }
  );
}

async function loadAll() {
  loadDone = 0;
  loadTotal = ORDER.length * 2
    + Object.keys(POSE_SETS).reduce((n, id) => n + POSE_SETS[id].length + 4, 0)
    + 2 /* 外卖车 + 狗奶 */ + STAGE_SRCS.length;
  $('load-fill').style.width = '0%';
  $('load-txt').textContent = 'LOADING… 0%';

  await Promise.all(ORDER.map(async (id) => {
    const [px, full] = await Promise.all([
      trackedImage(characterAsset(id, 'images', 'px.webp')),
      trackedImage(characterAsset(id, 'images', 'portrait.webp'))
    ]);
    SPRITES[id] = makeSprite(px, CHARACTERS[id].elem);
    PORTRAITS[id] = full;
  }));
  // 姿势贴图（从 AI 设定图切出来的整套动作）：六名角色统一走贴图
  await Promise.all(Object.keys(POSE_SETS).map((id) => loadPoses(id, POSE_SETS[id])));

  // 跳跳外卖车贴图
  try { BIKE_IMG = await trackedImage(characterAsset('hopper', 'images', 'bike.webp')); }
  catch (e) { console.warn('外卖车贴图加载失败', e); }
  // 野生狗奶贴图
  try { MILK_IMG = await trackedImage(characterAsset('dog', 'images', 'milk.webp')); }
  catch (e) { console.warn('狗奶贴图加载失败', e); }
  // 四张场景地图
  await Promise.all(STAGE_SRCS.map(async (src, i) => {
    try { STAGE_IMGS[i] = await trackedImage(src); }
    catch (e) { console.warn('场景图加载失败', src, e); }
  }));
}

/* 加载整套姿势贴图：assets/characters/<id>/pose/<pose>.webp */
async function loadPoses(id, names) {
  try {
    const imgs = await Promise.all(names.map((n) => trackedImage(characterAsset(id, 'pose', `${n}.webp`))));
    const poses = {};
    names.forEach((n, i) => { poses[n] = makeSprite(imgs[i], CHARACTERS[id].elem); });
    SPRITES[id].poses = poses;
    // 尝试加载 Python 预生成的走路帧（连续形变，不切割穿模）
    try {
      const wimgs = await Promise.all([0, 1, 2, 3].map((i) => trackedImage(characterAsset(id, 'pose', `walk_${i}.webp`))));
      SPRITES[id].walkFrames = wimgs.map((im) => makeSprite(im, CHARACTERS[id].elem));
    } catch (e) { /* 无走路帧的角色退回整体摇摆 */ }
  } catch (e) {
    console.warn('姿势贴图加载失败，退回矢量模型：', id, e);
  }
}

/* ---------------- 场景 ---------------- */
function makeRng(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

/* 场景：四张参考图作为背景，各配一层空气感 */
const STAGE_SRCS = [
  'assets/stage/pyramid.webp',   // 黄沙金字塔遗迹
  'assets/stage/inferno.webp',   // 火海废墟都市
  'assets/stage/shrine.webp',    // 月下神社
  'assets/stage/neon.webp'       // 霓虹天台
];
const STAGE_IMGS = [];

function buildStage(idx = 0) {
  const n = STAGE_SRCS.length;
  idx = ((idx % n) + n) % n;
  const c = document.createElement('canvas');
  c.width = VIEW.W; c.height = VIEW.H;
  const g = c.getContext('2d');
  const img = STAGE_IMGS[idx];

  if (img) {
    // 原图 16:9，按 cover 铺满整个战斗视野
    const k = Math.max(VIEW.W / img.width, VIEW.H / img.height);
    g.drawImage(img, (VIEW.W - img.width * k) / 2, (VIEW.H - img.height * k) / 2,
      img.width * k, img.height * k);
  } else {
    const sky = g.createLinearGradient(0, 0, 0, VIEW.GROUND);
    sky.addColorStop(0, '#0b1024');
    sky.addColorStop(1, '#3a2233');
    g.fillStyle = sky;
    g.fillRect(0, 0, VIEW.W, VIEW.H);
  }

  const rnd = makeRng(20261117 + idx * 977);

  if (idx === 0) {
    // 黄沙遗迹：底部暖光 + 飘沙
    const haze = g.createLinearGradient(0, VIEW.GROUND - 150, 0, VIEW.H);
    haze.addColorStop(0, 'rgba(255,206,120,0)');
    haze.addColorStop(1, 'rgba(255,190,96,.18)');
    g.fillStyle = haze;
    g.fillRect(0, VIEW.GROUND - 150, VIEW.W, VIEW.H - VIEW.GROUND + 150);
    for (let i = 0; i < 90; i++) {
      const x = rnd() * VIEW.W, y = 100 + rnd() * (VIEW.GROUND - 60);
      g.fillStyle = 'rgba(255,226,160,' + (0.12 + rnd() * 0.3).toFixed(2) + ')';
      g.fillRect(Math.round(x), Math.round(y), 1 + (rnd() < 0.2 ? 1 : 0), 1);
    }
  } else if (idx === 1) {
    // 火海废墟：底部火光 + 余烬
    const fire = g.createRadialGradient(VIEW.W / 2, VIEW.H, 40, VIEW.W / 2, VIEW.H, 520);
    fire.addColorStop(0, 'rgba(255,120,30,.26)');
    fire.addColorStop(0.5, 'rgba(255,90,20,.12)');
    fire.addColorStop(1, 'rgba(120,20,0,0)');
    g.fillStyle = fire;
    g.fillRect(0, 0, VIEW.W, VIEW.H);
    for (let i = 0; i < 70; i++) {
      const x = rnd() * VIEW.W, y = 120 + rnd() * (VIEW.GROUND - 80);
      g.fillStyle = 'rgba(255,' + Math.round(150 + rnd() * 80) + ',60,' + (0.2 + rnd() * 0.5).toFixed(2) + ')';
      g.fillRect(Math.round(x), Math.round(y), 1 + (rnd() < 0.35 ? 1 : 0), 1 + (rnd() < 0.25 ? 1 : 0));
    }
  } else if (idx === 2) {
    // 月下神社：贴地冷雾 + 月光
    for (let i = 0; i < 3; i++) {
      const y = VIEW.GROUND - 24 - i * 26;
      const fog = g.createLinearGradient(0, y, 0, y + 60);
      fog.addColorStop(0, 'rgba(190,215,255,0)');
      fog.addColorStop(0.5, 'rgba(190,215,255,' + (0.14 - i * 0.03).toFixed(2) + ')');
      fog.addColorStop(1, 'rgba(190,215,255,0)');
      g.fillStyle = fog;
      g.fillRect(0, y, VIEW.W, 60);
    }
    const moon = g.createRadialGradient(500, 90, 4, 500, 90, 130);
    moon.addColorStop(0, 'rgba(200,225,255,.16)');
    moon.addColorStop(1, 'rgba(160,200,255,0)');
    g.fillStyle = moon;
    g.fillRect(370, 0, 260, 240);
  } else {
    // 霓虹天台：两侧青光 / 洋红光晕
    const gl = g.createRadialGradient(90, VIEW.GROUND - 120, 10, 90, VIEW.GROUND - 120, 260);
    gl.addColorStop(0, 'rgba(60,220,255,.16)');
    gl.addColorStop(1, 'rgba(40,180,255,0)');
    g.fillStyle = gl;
    g.fillRect(0, 0, 400, VIEW.H);
    const gr = g.createRadialGradient(VIEW.W - 90, VIEW.GROUND - 120, 10, VIEW.W - 90, VIEW.GROUND - 120, 260);
    gr.addColorStop(0, 'rgba(255,70,200,.18)');
    gr.addColorStop(1, 'rgba(255,40,180,0)');
    g.fillStyle = gr;
    g.fillRect(VIEW.W - 400, 0, 400, VIEW.H);
  }

  // 地面交界轻压 + 前景暗角，让人物从背景里站出来
  const floor = g.createLinearGradient(0, VIEW.GROUND - 10, 0, VIEW.GROUND + 26);
  floor.addColorStop(0, 'rgba(0,0,0,0)');
  floor.addColorStop(1, 'rgba(0,0,0,.22)');
  g.fillStyle = floor;
  g.fillRect(0, VIEW.GROUND - 10, VIEW.W, 36);

  const vg = g.createRadialGradient(VIEW.W / 2, VIEW.H * 0.52, 180, VIEW.W / 2, VIEW.H * 0.52, 540);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,.42)');
  g.fillStyle = vg;
  g.fillRect(0, 0, VIEW.W, VIEW.H);

  return c;
}

/* ---------------- 界面 ---------------- */
const UI = {
  current: 'loading',
  mode: 'quick',
  selected: 'dog',
  cpu: 'frost',

  show(name) {
    ['screen-title', 'screen-select', 'screen-result', 'screen-pause', 'screen-quit'].forEach(id => $(id).classList.add('hidden'));
    $('hud').classList.add('hidden');
    if (name === 'fight') $('hud').classList.remove('hidden');
    else if (name === 'title') {
      $('screen-title').classList.remove('hidden');
      // 回到标题时重放入场动画（否则立绘停在初始的透明状态）
      const chars = document.querySelectorAll('.title-chars img');
      chars.forEach((im) => { im.style.animation = 'none'; });
      void $('screen-title').offsetWidth;
      chars.forEach((im) => { im.style.animation = ''; });
    }
    else if (name === 'select') $('screen-select').classList.remove('hidden');
    else if (name === 'result') $('screen-result').classList.remove('hidden');
    else if (name === 'pause') $('screen-pause').classList.remove('hidden');
    else if (name === 'quit') $('screen-quit').classList.remove('hidden');
    $('screen-help').classList.add('hidden');
    this.current = name;
  },

  buildCards() {
    const grid = $('card-grid');
    grid.innerHTML = '';
    ORDER.forEach((id) => {
      const d = CHARACTERS[id];
      const el = document.createElement('div');
      el.className = 'card' + (id === this.selected ? ' sel' : '');
      el.dataset.id = id;
      el.innerHTML = `
        <img src="${id === 'frost' ? characterAsset('frost', 'images', 'title.webp') : characterAsset(id, 'images', 'px.webp')}" alt="${d.name}"${id === 'frost' ? ' class="art"' : ''}>
        <div class="c-name">${d.name}</div>
        <div class="c-en">${d.en}</div>`;
      el.addEventListener('click', () => {
        this.selected = id;
        document.querySelectorAll('.card').forEach(c => c.classList.toggle('sel', c.dataset.id === id));
        this.preview(id);
        window.AUDIO.select();
      });
      grid.appendChild(el);
    });
    this.preview(this.selected);
  },

  preview(id) {
    const d = CHARACTERS[id];
    $('pv-img').src = id === 'frost' ? characterAsset('frost', 'images', 'title.webp') : PORTRAITS[id].src;
    $('pv-img').classList.toggle('art', id === 'frost');
    $('pv-name').textContent = d.name;
    $('pv-en').textContent = d.en;
    $('pv-tag').textContent = d.tag;
    $('pv-bio').textContent = d.bio;
    $('pv-skills').innerHTML = `
      <div><kbd>U</kbd><span><b>${d.skills.s1}</b> — ${d.desc.s1}</span></div>
      <div><kbd>I</kbd><span><b>${d.skills.s2}</b> — ${d.desc.s2}</span></div>
      ${d.skills.s3 ? `<div><kbd>O</kbd><span><b>${d.skills.s3}</b> — ${d.desc.s3}</span></div>` : ''}
      <div><kbd>S+L</kbd><span><b>${d.skills.dodge}</b> — ${d.desc.dodge}</span></div>`;
    if (this.cpu === id) this.pickCpu();
    this.updateFoeTag();
    this.syncFoeChips();
  },

  /* 进入选人：按模式切换标题、对手选择与提示 */
  enterSelect(mode) {
    this.mode = mode || 'quick';
    const cfg = {
      arcade: {
        kicker: 'ARCADE MODE', title: '闯关模式 · 选择你的斗士', fight: '开始闯关 →', side: '对手：',
        note: '连打 6 名斗士，每过一关 AI 都会更强。<br>全部通关后可以进入无尽模式，记录会保存在本地。'
      },
      training: {
        kicker: 'TRAINING MODE', title: '训练模式 · 选择角色', fight: '开始训练 →', side: '训练对手：',
        note: ''
      },
      versus: {
        kicker: 'VERSUS MODE', title: '双人对打 · 选择斗士', fight: '开始对战 →', side: '玩家2：',
        note: ''
      },
      quick: {
        kicker: 'SELECT YOUR FIGHTER', title: '选择你的斗士', fight: '进入战斗 →', side: 'CPU 对手：',
        note: '体力 · 速度 · 跳跃 六名斗士完全一致<br>差异只在技能与攻击动作'
      }
    }[this.mode] || {};
    $('select-kicker').textContent = cfg.kicker;
    $('select-title').textContent = cfg.title;
    $('btn-fight').textContent = cfg.fight;
    $('side-label').textContent = cfg.side;
    $('pv-note').innerHTML = cfg.note;
    $('foe-strip').classList.toggle('hidden', this.mode === 'arcade');
    $('foe-label').textContent = this.mode === 'versus' ? '玩家2' : '训练对手';
    if (this.mode !== 'arcade' && this.cpu === this.selected) this.pickCpu();
    this.updateFoeTag();
    this.syncFoeChips();
    UI.show('select');
  },

  pickCpu() {
    const pool = ORDER.filter((k) => k !== this.selected);
    this.cpu = pool[Math.floor(Math.random() * pool.length)];
  },

  updateFoeTag() {
    $('cpu-name').textContent = this.mode === 'arcade'
      ? '按关卡顺序（6 名斗士）' : CHARACTERS[this.cpu].name;
  },

  syncFoeChips() {
    document.querySelectorAll('.foe-chip').forEach((c) => c.classList.toggle('sel', c.dataset.id === this.cpu));
  },

  buildFoeStrip() {
    const box = $('foe-chips');
    box.innerHTML = '';
    ORDER.forEach((id) => {
      const d = CHARACTERS[id];
      const b = document.createElement('button');
      b.className = 'foe-chip' + (id === this.cpu ? ' sel' : '');
      b.dataset.id = id;
      b.innerHTML = `<img src="${id === 'frost' ? characterAsset('frost', 'images', 'title.webp') : characterAsset(id, 'images', 'px.webp')}" alt=""><span>${d.name}</span>`;
      b.addEventListener('click', () => {
        this.cpu = id;
        this.updateFoeTag();
        this.syncFoeChips();
        window.AUDIO.select();
      });
      box.appendChild(b);
    });
  },

  /* 标题页的闯关记录 */
  updateRecordLine() {
    const g = window.GAME || {};
    const r = g.records || {};
    const parts = [];
    if (r.cleared) parts.push(`全关通关 ${r.cleared} 次`);
    if (r.bestEndless) parts.push(`无尽 最高 ${r.bestEndless} 关`);
    if (r.bestStage) parts.push(`闯关 最高 第 ${r.bestStage} 关`);
    $('record-line').innerHTML = '闯关记录：' + (parts.length ? `<b>${parts.join(' · ')}</b>` : '暂无');
    // 有未打完的无尽存档时显示「继续」入口
    const cont = $('btn-continue');
    if (cont) {
      const run = g.run;
      cont.classList.toggle('hidden', !run);
      if (run) cont.textContent = `继续无尽 · 第 ${run.stageIndex + 1} 关（${CHARACTERS[run.heroId].name}）`;
    }
  }
};

/* ---------------- 游戏 ---------------- */
class Game {
  constructor() {
    this.canvas = $('game');
    this.ctx = this.canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
    this.audio = window.AUDIO;
    this.fx = new FX();
    this.stageId = 0;
    this.stage = buildStage(0);
    this.p1 = null; this.p2 = null; this.ai = null;
    this.projectiles = [];
    this.mode = 'menu';
    /* 游戏模式：quick 快速对战 / arcade 闯关 / training 训练 / versus 双人 */
    this.gameMode = 'quick';
    this.aiLevel = 1;
    this.dummy = false;
    this.records = this.loadRecords();
    this.stageIndex = 0; this.endless = false; this.heroId = null; this.opponents = [];
    this.reviveUsed = false;                    // 无尽模式每轮一次的复活机会
    this.run = this.loadRun();                  // 未打完的无尽存档
    this.resultActions = null;
    this.paused = false;
    this.over = false;
    this.winner = null;
    this.timeLeft = 99;
    this.ts = 1; this.slowT = 0; this.endT = 0; this.introT = 0;
    this.acc = 0; this.last = performance.now();
    this.keys = new Set(); this.pressed = new Set();
    this.p1AI = null; this.demo = null; this.demoT = 0; this.demoDone = false;
    this.demoFreeze = false;
    this.elapsed = 0; this.freezeAt = 0;
    this.lag1 = 1; this.lag2 = 1;
    this.motes = Array.from({ length: 26 }, () => ({
      x: Math.random() * VIEW.W, y: 100 + Math.random() * 240,
      s: Math.random() < 0.7 ? 1 : 2, v: 4 + Math.random() * 12, a: 0.1 + Math.random() * 0.3
    }));
    this.bindInput();
    requestAnimationFrame((t) => this.loop(t));
  }

  bindInput() {
    window.addEventListener('keydown', (e) => {
      const k = e.code;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(k)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(k);
      this.pressed.add(k);
      this.onKey(k);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  onKey(k) {
    this.audio.init();
    if (k === 'Escape') {
      if (UI.current === 'quit') { UI.show('pause'); return; }
      if (this.mode === 'fight' || this.mode === 'ko') this.togglePause();
      return;
    }
    if (k === 'KeyM') { this.toggleMute(); return; }
    if (k === 'KeyH') { this.toggleHelp(); return; }
  }

  toggleMute() {
    this.audio.muted = !this.audio.muted;
    const b = $('btn-mute');
    b.classList.toggle('off', this.audio.muted);
    b.textContent = this.audio.muted ? '×' : '♪';
  }

  toggleHelp() {
    const el = $('screen-help');
    el.classList.toggle('hidden');
    if (!el.classList.contains('hidden')) this.audio.ui();
  }

  togglePause() {
    if (this.over) return;
    this.paused = !this.paused;
    if (this.paused) { UI.show('pause'); this.audio.ui(); }
    else { UI.show('fight'); this.audio.ui(); }
  }

  /* ---------- 流程 ---------- */
  loadRecords() {
    try {
      const raw = JSON.parse(localStorage.getItem('pixelclash.records') || '{}');
      return { cleared: raw.cleared || 0, bestStage: raw.bestStage || 0, bestEndless: raw.bestEndless || 0 };
    } catch (e) { return { cleared: 0, bestStage: 0, bestEndless: 0 }; }
  }

  saveRecords() {
    try { localStorage.setItem('pixelclash.records', JSON.stringify(this.records)); } catch (e) { /* 隐私模式下忽略 */ }
    UI.updateRecordLine();
  }

  /* 无尽进度存档：进入无尽 / 每通过一关时写入，失败后清除 */
  loadRun() {
    try {
      const raw = JSON.parse(localStorage.getItem('pixelclash.run') || 'null');
      if (!raw || !raw.heroId || !CHARACTERS[raw.heroId]) return null;
      return { heroId: raw.heroId, stageIndex: Math.max(0, raw.stageIndex | 0), reviveUsed: !!raw.reviveUsed };
    } catch (e) { return null; }
  }

  saveRun(nextIndex = this.stageIndex) {
    try {
      localStorage.setItem('pixelclash.run', JSON.stringify({
        heroId: this.heroId, stageIndex: Math.max(0, nextIndex | 0), reviveUsed: !!this.reviveUsed
      }));
    } catch (e) { /* 隐私模式下忽略 */ }
    this.run = this.loadRun();
    UI.updateRecordLine();
  }

  clearRun() {
    try { localStorage.removeItem('pixelclash.run'); } catch (e) { /* 忽略 */ }
    this.run = null;
    UI.updateRecordLine();
  }

  setStageTag(text) {
    const el = $('stage-tag');
    if (!text) { el.classList.add('hidden'); return; }
    el.textContent = text;
    el.classList.remove('hidden');
  }

  /* 切换场景（0 黄沙遗迹 / 1 火海废墟 / 2 月下神社 / 3 霓虹天台） */
  setStageId(id) {
    this.stageId = ((id % STAGE_SRCS.length) + STAGE_SRCS.length) % STAGE_SRCS.length;
    this.stage = buildStage(this.stageId);
  }

  startFight(p1Id, p2Id, level = 1, opts = {}) {
    this.gameMode = opts.mode || 'quick';
    this.aiLevel = level;
    this.dummy = !!opts.dummy;
    this.p1 = new Fighter(CHARACTERS[p1Id], 'p1', this);
    this.p2 = new Fighter(CHARACTERS[p2Id], 'p2', this);
    this.p1.sp = SPRITES[p1Id];
    this.p2.sp = SPRITES[p2Id];
    // 双人对打 / 训练木桩不需要 AI
    this.ai = (this.gameMode === 'versus' || this.dummy) ? null : new AI(this.p2, this, level);
    this.projectiles = [];
    this.fx.reset();
    this.over = false; this.paused = false; this.winner = null;
    this.timeLeft = 99; this.ts = 1; this.slowT = 0; this.endT = 0;
    this.lag1 = 1; this.lag2 = 1;
    this.p1Id = p1Id; this.p2Id = p2Id;
    this.mode = 'intro';
    this.introT = 1.15;
    // 场景：闯关按关卡轮换，其他模式随机
    this.setStageId(this.gameMode === 'arcade' ? this.stageIndex : Math.floor(Math.random() * STAGE_SRCS.length));
    this.hudInit(p1Id, p2Id);
    UI.show('fight');
    const intro = this.gameMode === 'arcade' ? (this.endless ? `ENDLESS ${this.stageIndex + 1}` : `STAGE ${this.stageIndex + 1}`)
      : this.gameMode === 'training' ? 'TRAINING'
        : this.gameMode === 'versus' ? 'VERSUS' : 'ROUND 1';
    this.announce(intro, '#ffffff', this.gameMode === 'arcade' ? CHARACTERS[p2Id].name : '准备');
    if (this.gameMode === 'training') this.setStageTag('训练模式 · 木桩不还手');
    else if (this.gameMode === 'versus') this.setStageTag('双人对打');
    else if (this.gameMode === 'arcade') {
      this.setStageTag(this.endless ? `无尽 第 ${this.stageIndex + 1} 关` : `第 ${this.stageIndex + 1} 关 / 共 ${this.opponents.length} 关`);
    } else this.setStageTag('');
    this.audio.init();
  }

  /* ---------- 闯关模式 ---------- */
  startArcade(p1Id) {
    this.heroId = p1Id;
    this.endless = false;
    this.reviveUsed = false;
    this.opponents = ORDER.slice();      // 六名斗士各出现一次
    for (let i = this.opponents.length - 1; i > 0; i--) {   // 随机打乱出场顺序
      const j = Math.floor(Math.random() * (i + 1));
      [this.opponents[i], this.opponents[j]] = [this.opponents[j], this.opponents[i]];
    }
    this.stageIndex = 0;
    this.beginStage();
  }

  /* 通关后的无尽模式：随机对手，越打越强 */
  startEndless(p1Id, stageIndex, reviveUsed) {
    this.heroId = p1Id || this.heroId;
    this.endless = true;
    this.reviveUsed = !!reviveUsed;
    this.opponents = [];
    this.stageIndex = stageIndex || 0;
    this.saveRun();                      // 进入无尽模式即存档
    this.beginStage();
  }

  beginStage() {
    let foe;
    if (this.endless) {
      const pool = ORDER.filter((k) => k !== this.heroId);
      foe = pool[Math.floor(Math.random() * pool.length)];
    } else {
      foe = this.opponents[this.stageIndex];
    }
    const lv = this.endless ? 4 + this.stageIndex * 0.35 : 1 + this.stageIndex * 0.6;
    this.stageFoe = foe;
    this.startFight(this.heroId, foe, lv, { mode: 'arcade' });
    // 无尽难度：敌人血量与伤害随关卡略微提升
    if (this.endless) {
      const hpMul = 1 + this.stageIndex * 0.05;
      this.p2.maxHp = Math.round(this.p2.maxHp * hpMul);
      this.p2.hp = this.p2.maxHp;
      this.p2.dmgMul = 1 + this.stageIndex * 0.04;
      this.saveRun();
    }
  }

  startTraining(p1Id, foeId) {
    this.gameMode = 'training';
    this.startFight(p1Id, foeId, 1, { mode: 'training', dummy: true });
  }

  startVersus(p1Id, p2Id) {
    this.gameMode = 'versus';
    this.startFight(p1Id, p2Id, 1, { mode: 'versus' });
  }

  restartMatch() {
    if (this.gameMode === 'arcade') { this.beginStage(); return; }
    this.startFight(this.p1Id, this.p2Id, this.aiLevel || 1,
      { mode: this.gameMode, dummy: this.dummy });
  }

  /* 结算界面的按钮：按当前模式决定行为 */
  onResultButton(btnId) {
    const act = (this.resultActions && this.resultActions[btnId]) || 'home';
    this.resultActions = null;
    if (act === 'next') { this.stageIndex++; this.beginStage(); }
    else if (act === 'endless') { this.startEndless(this.heroId); }
    else if (act === 'revive') { this.reviveUsed = true; this.beginStage(); }
    else if (act === 'restart-endless') { this.startEndless(this.heroId); }
    else if (act === 'settle') {
      this.records.bestEndless = Math.max(this.records.bestEndless, this.stageIndex);
      this.saveRecords();
      this.clearRun();
      this.backToTitle();
    }
    else if (act === 'retry') { this.restartMatch(); }
    else if (act === 'reselect') { UI.enterSelect(this.gameMode === 'arcade' ? 'arcade' : this.gameMode); }
    else this.backToTitle();
  }

  setResultButtons(list) {
    const ids = ['btn-rematch', 'btn-select', 'btn-home'];
    const map = {};
    ids.forEach((id) => {
      const btn = $(id);
      const conf = list.find((c) => c.id === id);
      btn.classList.toggle('hidden', !conf);
      if (conf) { btn.textContent = conf.text; map[id] = conf.act; }
    });
    this.resultActions = map;
  }


  hudInit(p1Id, p2Id) {
    const d1 = CHARACTERS[p1Id], d2 = CHARACTERS[p2Id];
    // 霜龙用选人界面同一张立绘，保持 HUD 里的形象和界面一致
    const portrait = (id) => id === 'frost' ? characterAsset('frost', 'images', 'title.webp') : characterAsset(id, 'images', 'portrait.webp');
    $('p1-portrait').src = portrait(p1Id);
    $('p2-portrait').src = portrait(p2Id);
    $('p1-name').textContent = d1.name;
    $('p2-name').textContent = d2.name;
    $('p1-tag').textContent = this.gameMode === 'versus' ? `玩家1 · ${d1.tag}` : d1.tag;
    $('p2-tag').textContent = this.gameMode === 'versus' ? `玩家2 · ${d2.tag}` : d2.tag;
    document.documentElement.style.setProperty('--p1', d1.color);
    document.documentElement.style.setProperty('--p2', d2.color);
    this.lag1 = 1; this.lag2 = 1;
  }

  announce(title, color = '#fff', sub = '') {
    const el = $('announce');
    const t = el.querySelector('.a-title');
    t.textContent = title;
    t.style.color = color;
    el.querySelector('.a-sub').textContent = sub;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
  }

  cinematic(dur = 0.6) {
    const el = $('cinema');
    el.classList.add('on');
    clearTimeout(this._cin);
    this._cin = setTimeout(() => el.classList.remove('on'), dur * 1000);
  }

  shakeScreenBig() {
    const app = $('app');
    app.classList.remove('shake-big');
    void app.offsetWidth;
    app.classList.add('shake-big');
    clearTimeout(this._shk);
    this._shk = setTimeout(() => app.classList.remove('shake-big'), 380);
  }

  toast(text, x, y, color) { this.fx.text(x, y, text, color || '#fff', 10); }

  spawnProjectile(p) {
    // 记录出手时释放的技能编号，技能结束后飞行中的弹体也能按正确档位结算怒气
    if (p.owner && p.owner.castNo) p.castNo = p.owner.castNo;
    this.projectiles.push({ ...p, t: 0, hit: false });
  }

  checkKO(target) {
    if (this.gameMode === 'training') return;   // 训练模式不结算
    if (target.hp > 0 || target.state === 'ko') return;
    target.hp = 0;
    target.setState('ko');
    target.prone = false;
    this.audio.ko();
    this.audio.cry(target.def.id, 'ko');
    this.fx.flash('#ffffff', 0.55, 0.22);
    this.fx.stop(0.14);
    this.fx.shake(16, 0.6);
    this.fx.spark(target.x, target.y - 100, '#fff0c0', 1.8, 24);
    this.over = true;
    this.mode = 'ko';
    this.ts = 0.35; this.slowT = 1.15; this.endT = 2.0;
    this.winner = target === this.p2 ? this.p1 : this.p2;
    this.announce('K.O.', '#ff5f56', this.winner.def.name + ' 制胜');
  }

  timeUp() {
    if (this.over) return;
    const r1 = this.p1.hp / this.p1.maxHp, r2 = this.p2.hp / this.p2.maxHp;
    this.over = true; this.mode = 'ko';
    this.ts = 0.5; this.slowT = 0.8; this.endT = 2.0;
    this.winner = r1 >= r2 ? this.p1 : this.p2;
    this.announce('TIME UP', '#ffb03a', '体力判定');
    this.audio.ko();
  }

  showResult() {
    this.mode = 'result';
    this.ts = 1;
    const w = this.winner;
    const playerWin = w === this.p1;
    const kicker = $('result-kicker'), title = $('result-winner');
    const sub = $('result-sub'), extra = $('result-extra');
    extra.textContent = '';

    /* 双人对打：分别报玩家1 / 玩家2 */
    if (this.gameMode === 'versus') {
      kicker.textContent = 'VERSUS';
      title.textContent = w === this.p1 ? '玩家1 获胜' : w === this.p2 ? '玩家2 获胜' : 'DRAW';
      title.style.color = w ? w.def.color : '#fff';
      sub.textContent = `${w ? w.def.name : ''} · 剩余体力 ${Math.round(w ? w.hp : 0)} / ${w ? w.maxHp : 0}`;
      this.setResultButtons([
        { id: 'btn-rematch', text: '再战一场', act: 'retry' },
        { id: 'btn-select', text: '重选角色', act: 'reselect' },
        { id: 'btn-home', text: '回到标题', act: 'home' }
      ]);
      UI.show('result');
      return;
    }

    /* 闯关 / 无尽 */
    if (this.gameMode === 'arcade') {
      const total = 6;
      if (playerWin) {
        if (!this.endless && this.stageIndex >= total - 1) {
          this.records.cleared += 1;
          this.records.bestStage = Math.max(this.records.bestStage, total);
          this.saveRecords();
          kicker.textContent = 'ALL CLEAR';
          title.textContent = '全角色通关！';
          sub.textContent = '六名斗士全部击破';
          extra.textContent = `闯关记录：全关通关 ${this.records.cleared} 次`;
          this.setResultButtons([
            { id: 'btn-rematch', text: '进入无尽模式', act: 'endless' },
            { id: 'btn-select', text: '换个角色', act: 'reselect' },
            { id: 'btn-home', text: '回到标题', act: 'home' }
          ]);
        } else if (this.endless) {
          this.records.bestEndless = Math.max(this.records.bestEndless, this.stageIndex + 1);
          this.saveRecords();
          this.saveRun(this.stageIndex + 1);      // 存档推进到下一关
          kicker.textContent = `ENDLESS ${this.stageIndex + 1} CLEAR`;
          title.textContent = '本关通过';
          sub.textContent = '继续挑战 · AI 会越来越强';
          extra.textContent = `无尽最高纪录：第 ${this.records.bestEndless} 关`;
          this.setResultButtons([
            { id: 'btn-rematch', text: '继续下一关 →', act: 'next' },
            { id: 'btn-select', text: '换个角色', act: 'reselect' },
            { id: 'btn-home', text: '回到标题', act: 'home' }
          ]);
        } else {
          this.records.bestStage = Math.max(this.records.bestStage, this.stageIndex + 1);
          this.saveRecords();
          kicker.textContent = `STAGE ${this.stageIndex + 1} / ${total} CLEAR`;
          title.textContent = '本关通过';
          sub.textContent = `下一关：${CHARACTERS[this.opponents[this.stageIndex + 1]].name}`;
          extra.textContent = `已通过 ${this.stageIndex + 1} / ${total} 关`;
          this.setResultButtons([
            { id: 'btn-rematch', text: '下一关 →', act: 'next' },
            { id: 'btn-select', text: '换个角色', act: 'reselect' },
            { id: 'btn-home', text: '回到标题', act: 'home' }
          ]);
        }
        title.style.color = '#ffd166';
      } else if (this.endless && !this.reviveUsed) {
        /* 无尽首次失败：给一次复活机会，不算结算 */
        kicker.textContent = 'DEFEAT';
        title.textContent = '挑战失败';
        title.style.color = '#ff7a6b';
        sub.textContent = `止步无尽 第 ${this.stageIndex + 1} 关 · 还有 1 次复活机会`;
        extra.textContent = '复活后将重新挑战本关，再失败则本轮结束';
        this.setResultButtons([
          { id: 'btn-rematch', text: '复活再战（1 次）', act: 'revive' },
          { id: 'btn-select', text: '放弃并结算', act: 'settle' },
          { id: 'btn-home', text: '回到标题', act: 'home' }
        ]);
      } else {
        if (this.endless) this.records.bestEndless = Math.max(this.records.bestEndless, this.stageIndex);
        else this.records.bestStage = Math.max(this.records.bestStage, this.stageIndex);
        this.saveRecords();
        if (this.endless) this.clearRun();   // 本轮结束，清除存档
        kicker.textContent = 'DEFEAT';
        title.textContent = '挑战失败';
        title.style.color = '#ff7a6b';
        sub.textContent = this.endless ? `止步无尽 第 ${this.stageIndex + 1} 关` : `止步第 ${this.stageIndex + 1} 关`;
        extra.textContent = this.endless
          ? `本轮通过 ${this.stageIndex} 关 · 无尽最高纪录：第 ${this.records.bestEndless} 关`
          : `闯关最高纪录：第 ${this.records.bestStage} 关`;
        this.setResultButtons([
          { id: 'btn-rematch', text: this.endless ? '重新挑战' : '重新挑战', act: this.endless ? 'restart-endless' : 'retry' },
          { id: 'btn-select', text: '换个角色', act: 'reselect' },
          { id: 'btn-home', text: '回到标题', act: 'home' }
        ]);
      }
      UI.show('result');
      return;
    }

    /* 快速对战 / 训练 */
    kicker.textContent = playerWin ? 'YOU WIN' : 'YOU LOSE';
    title.textContent = w ? `${w.def.name} WINS` : 'DRAW';
    title.style.color = w ? w.def.color : '#fff';
    sub.textContent = `剩余体力 ${Math.round(w ? w.hp : 0)} / ${w ? w.maxHp : 0}`;
    this.setResultButtons([
      { id: 'btn-rematch', text: '再战一场', act: 'retry' },
      { id: 'btn-select', text: '更换角色', act: 'reselect' },
      { id: 'btn-home', text: '回到标题', act: 'home' }
    ]);
    UI.show('result');
  }

  /* 无尽模式中途退出：先询问是否存档 */
  quitToTitle() {
    if (this.gameMode === 'arcade' && this.endless && !this.over) {
      $('quit-sub').textContent = `保存后可在标题页继续：第 ${this.stageIndex + 1} 关（${CHARACTERS[this.heroId].name}）`;
      UI.show('quit');
      return;
    }
    this.backToTitle();
  }

  backToTitle() {
    this.mode = 'menu';
    this.paused = false; this.over = false;
    this.p1 = null; this.p2 = null; this.ai = null;
    this.gameMode = 'quick';
    this.fx.reset();
    $('cinema').classList.remove('on');
    this.setStageTag('');
    UI.updateRecordLine();
    UI.show('title');
  }

  runDemo() {
    const p1 = this.p1, p2 = this.p2;
    this.demoFreeze = true;   // 演示模式下对手不反抗，便于复现
    p1.rage = 100;
    if (this.demo === 'grab') {
      p1.x = 246; p2.x = 352; p1.facing = 1; p2.facing = -1;
      p2.setState('idle'); p2.vx = 0;
      p1.setState('idle'); p1.startSkill1(p2);
    } else if (this.demo === 'bark') {
      p1.x = 196; p2.x = 468; p1.facing = 1; p2.facing = -1;
      p2.setState('idle'); p2.vx = 0;
      p1.setState('idle'); p1.startUltimate(p2);
    } else if (this.demo === 'dodge') {
      p1.setState('idle'); p1.startPhantomDodge(-1);
    } else if (this.demo === 'kick') {
      p1.x = 300; p2.x = 366; p1.facing = 1; p2.setState('idle');
      p1.startMove('kick');
    } else if (this.demo === 'punch') {
      p1.x = 300; p2.x = 360; p1.facing = 1; p1.startMove('punch');
    } else if (this.demo === 'rice' || this.demo === 'tail') {
      // 小鲸 L 技能：连丢饭碗
      p1.x = 268; p2.x = 336; p1.facing = 1; p2.facing = -1;
      p2.setState('idle'); p2.vx = 0;
      p1.setState('idle'); p1.startSkill1(p2);
    } else if (this.demo === 'spray') {
      // 小鲸 O 大招：喷水
      p1.x = 230; p2.x = 420; p1.facing = 1; p2.facing = -1;
      p2.setState('idle'); p2.vx = 0;
      p1.setState('idle'); p1.startUltimate(p2);
    } else if (this.demo === 'flurry' || this.demo === 'bike') {
      // 跳跳技能演示：U 百万吨拳踢 / O 胆子肥嘟嘟
      p1.x = 268; p2.x = 352; p1.facing = 1; p2.facing = -1;
      p2.setState('idle'); p2.vx = 0;
      p1.setState('idle');
      if (this.demo === 'flurry') p1.startSkill1(p2);
      else p1.startSkill3(p2);
    } else if (this.demo === 'fireball') {
      // 霜龙喷火球演示
      p1.x = 250; p2.x = 352; p1.facing = 1; p2.facing = -1;
      p2.setState('idle'); p2.vx = 0;
      p1.setState('idle');
      p1.startUltimate(p2);
    } else if (this.demo === 'jump') {
      p1.x = 250; p2.x = 470; p1.facing = 1; p2.facing = -1;
      p1.setState('idle'); p2.setState('idle');
      p1.vy = -p1.def.jump; p1.vx = p1.def.speed * 0.85; p1.grounded = false;
      p1.setState('jump');
    } else if (this.demo === 'chain') {
      // BVN 连段演示：J·J·J 浮空 → W 跳取消 → 空中追击
      p1.x = 256; p2.x = 322; p1.facing = 1; p2.facing = -1;
      p2.setState('idle'); p2.vx = 0; p2.hitstun = 0;
      this.chainT = 0;
    } else if (this.demo === 'dash') {
      p1.x = 170; p2.x = 470; p1.facing = 1; p2.facing = -1;
      p1.setState('idle');
      p1.dashT = 0.26; p1.dashDir = 1; p1.dashCd = 1; p1.ghostTick = 0;
    } else if (this.demo === 'escape') {
      p1.x = 250; p2.x = 330; p1.facing = 1; p2.facing = -1;
      p1.rage = 60; p1.setState('hurt'); p1.hitstun = 0.6;
      p1.startEscape(p2);
    } else if (this.demo === 'ko') {
      p1.x = 300; p2.x = 366; p1.facing = 1; p1.setState('idle');
      p2.hp = 20; p2.rage = 40;
      p1.startMove('punch');
    }
  }

  /* ---------- 输入指令 ---------- */
  /* which: 1 = 玩家1（WASD + J/K/L/U/I/O），2 = 玩家2（方向键 + 小键盘 1/2/3/4/5/6） */
  playerCmd(which = 1) {
    const k = this.keys, p = this.pressed;
    if (which === 2) {
      return {
        left: k.has('ArrowLeft'), right: k.has('ArrowRight'),
        up: k.has('ArrowUp'), jump: p.has('ArrowUp'),
        block: k.has('ArrowDown'),
        punch: p.has('Numpad1'), kick: p.has('Numpad2'),
        dodge: p.has('Numpad3'),
        skill1: p.has('Numpad4'), skill2: p.has('Numpad5'), skill3: p.has('Numpad6')
      };
    }
    // 双人对打时方向键归玩家2，玩家1 只用 WASD
    const solo = this.gameMode !== 'versus';
    return {
      left: k.has('KeyA') || (solo && k.has('ArrowLeft')),
      right: k.has('KeyD') || (solo && k.has('ArrowRight')),
      up: k.has('KeyW') || (solo && k.has('ArrowUp')),
      jump: p.has('KeyW') || (solo && p.has('ArrowUp')),
      block: k.has('KeyS') || (solo && k.has('ArrowDown')),
      punch: p.has('KeyJ'),
      kick: p.has('KeyK'),
      dodge: p.has('KeyL'),
      skill1: p.has('KeyU'),
      skill2: p.has('KeyI'),
      skill3: p.has('KeyO')
    };
  }

  /* ---------- 循环 ---------- */
  loop(now) {
    // 先排下一帧，任何单帧异常都不会让画面永久卡死
    requestAnimationFrame((t) => this.loop(t));
    try {
      const raw = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      if (!this.paused && !(this.freezeAt && this.elapsed >= this.freezeAt)) {
        this.acc += raw * this.ts;
        const STEP = 1 / 60;
        let guard = 0;
        while (this.acc >= STEP && guard < 5) {
          this.step(STEP);
          this.elapsed += STEP;
          this.acc -= STEP;
          guard++;
        }
        if (guard >= 5) this.acc = 0;
      } else {
        this.pressed.clear();
      }
      this.render();
      this.updateHUD();
    } catch (e) {
      if (!this._errOnce) {
        this._errOnce = true;
        console.error('[PIXEL CLASH] 运行异常：', e);
      }
    }
  }

  step(dt) {
    this.fx.update(dt);
    if (this.p1) {
      // 顿帧：命中瞬间冻结全场
      if (this.fx.hitstop > 0) { this.fx.hitstop -= dt; return; }
    }

    if (!this.p1 || !this.p2) return;

    if (this.mode === 'intro') {
      this.introT -= dt;
      if (this.introT <= 0) {
        this.mode = 'fight';
        this.announce('FIGHT!', '#ffb03a');
        this.audio.ready();
      }
    }

    if (this.mode === 'fight' && this.gameMode !== 'training') {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) { this.timeLeft = 0; this.timeUp(); }
    }

    const active = this.mode === 'fight';
    if (this.demo && !this.demoDone) {
      this.demoT -= dt;
      if (this.demoT <= 0) { this.demoDone = true; this.runDemo(); }
    }
    let c1 = active ? (this.p1AI ? this.p1AI.update(dt, this.p2) : this.playerCmd(1)) : null;
    let c2 = null;
    if (active) {
      if (this.gameMode === 'versus') c2 = this.playerCmd(2);
      else if (!this.demoFreeze && !this.dummy && this.ai) c2 = this.ai.update(dt, this.p1);
    }
    // 训练木桩：不还手、体力回满，方便反复练
    if (this.gameMode === 'training') this.p2.hp = this.p2.maxHp;
    // 连段演示：按时间表喂输入
    if (this.demo === 'chain' && this.demoDone && active) {
      this.chainT = (this.chainT || 0) + dt;
      const t = this.chainT;
      const hit = (t0) => t >= t0 && t < t0 + 1 / 60;
      c1 = {
        left: false, right: false, up: hit(0.45), jump: hit(0.45),
        block: false,
        punch: hit(0.02) || hit(0.17) || hit(0.29) || hit(0.62),
        kick: hit(0.80),
        dodge: false, skill1: false, skill2: false, skill3: false
      };
    }
    this.p1.update(dt, this.p2, c1);
    this.p2.update(dt, this.p1, c2);
    this.updateProjectiles(dt);
    this.pressed.clear();

    if (this.slowT > 0) {
      this.slowT -= dt;
      if (this.slowT <= 0) this.ts = 1;
    }
    if (this.endT > 0) {
      this.endT -= dt;
      if (this.endT <= 0) this.showResult();
    }
  }

  updateProjectiles(dt) {
    const arr = this.projectiles;
    for (let i = arr.length - 1; i >= 0; i--) {
      const p = arr[i];
      p.t += dt; p.life -= dt;
      p.x += p.vx * dt;
      if (p.vy !== undefined) {
        p.y += p.vy * dt;
        p.vy += (p.g || 0) * dt;
      }
      if (p.rMax) p.radius = Math.min(p.rMax, p.radius + dt * 90);
      if (p.spin) p.rot = (p.rot || 0) + p.spin * dt;   // 高速旋转（野生狗奶）

      // 拖尾
      if (p.type === 'milk') {
        // 狗奶：旋转甩出的奶珠
        if (Math.random() < 0.75) {
          this.fx.parts.push({
            x: p.x + (Math.random() - 0.5) * 26, y: p.y + (Math.random() - 0.5) * 26,
            vx: -p.vx * 0.1 + (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 80 - 30,
            life: 0.28, max: 0.28, size: 2,
            color: Math.random() < 0.5 ? '#ffffff' : '#ffe9c0',
            g: 320, drag: 2
          });
        }
      } else if (p.type === 'sonic') {
        if (Math.random() < 0.8) {
          this.fx.parts.push({
            x: p.x - Math.sign(p.vx) * 12 + (Math.random() - 0.5) * 16,
            y: p.y + (Math.random() - 0.5) * 26,
            vx: -p.vx * 0.12, vy: (Math.random() - 0.5) * 30,
            life: 0.25, max: 0.35, size: 2, color: p.color, g: 0, drag: 3
          });
        }
      } else if (p.type === 'rice') {
        if (Math.random() < 0.9) {
          this.fx.parts.push({
            x: p.x + (Math.random() - 0.5) * 20, y: p.y + (Math.random() - 0.5) * 20,
            vx: (Math.random() - 0.5) * 40 - p.vx * 0.12, vy: (Math.random() - 0.5) * 40,
            life: 0.34, max: 0.44, size: 2, color: Math.random() < 0.35 ? '#7fd0ff' : '#fffaf0',
            g: 260, drag: 0.6
          });
        }
      } else if (p.type === 'water') {
        // 水弹拖尾：一路甩水珠
        if (Math.random() < 0.9) {
          this.fx.parts.push({
            x: p.x - Math.sign(p.vx) * p.radius * 0.8 + (Math.random() - 0.5) * 14,
            y: p.y + (Math.random() - 0.5) * (p.radius + 8),
            vx: -p.vx * 0.1 + (Math.random() - 0.5) * 50, vy: (Math.random() - 0.5) * 60 - 20,
            life: 0.3, max: 0.3, size: 2 + (Math.random() < 0.3 ? 1 : 0),
            color: Math.random() < 0.4 ? '#ffffff' : '#9fd8ff',
            g: 320, drag: 1.4
          });
        }
      } else if (p.type === 'ice') {
        // 冰刺拖尾：细冰晶
        if (Math.random() < 0.9) {
          this.fx.parts.push({
            x: p.x - Math.sign(p.vx) * 14 + (Math.random() - 0.5) * 10,
            y: p.y + (Math.random() - 0.5) * 10,
            vx: -p.vx * 0.08, vy: (Math.random() - 0.5) * 24,
            life: 0.3, max: 0.3, size: 2, color: Math.random() < 0.4 ? '#ffffff' : '#bfe4ff',
            g: 0, drag: 2
          });
        }
      } else if (p.type === 'fire') {
        // 火球拖尾：火星 + 烟（持续型火球烧得更旺）
        const n = p.beam ? 3 : 1;
        for (let k = 0; k < n; k++) {
          if (Math.random() >= 0.95) continue;
          this.fx.parts.push({
            x: p.x - Math.sign(p.vx) * p.radius * 0.6 + (Math.random() - 0.5) * 18,
            y: p.y + (Math.random() - 0.5) * 18,
            vx: -p.vx * 0.12 + (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40 - 30,
            life: 0.32, max: 0.32, size: 2 + ((Math.random() * 3) | 0),
            color: Math.random() < 0.4 ? '#ffce6a' : Math.random() < 0.5 ? '#ff7a2c' : '#ff4a1c',
            g: -80, drag: 1.6
          });
        }
      } else if (p.type === 'bike') {
        // 外卖车：车尾金橙气流、轮下扬尘和连续速度线
        const dir = Math.sign(p.vx) || 1;
        for (let k = 0; k < 2; k++) {
          const c = Math.random();
          this.fx.parts.push({
            x: p.x - dir * (48 + Math.random() * 22), y: p.y - 40 + Math.random() * 40,
            vx: -p.vx * 0.22 + (Math.random() - 0.5) * 50, vy: -20 - Math.random() * 70,
            life: 0.26 + Math.random() * 0.18, max: 0.44, size: 2 + ((Math.random() * 4) | 0),
            color: c < 0.25 ? '#fff8d6' : c < 0.65 ? '#ffd64f' : '#ff762d', g: -40, drag: 2.6
          });
        }
        if (Math.random() < 0.8) {
          this.fx.parts.push({
            x: p.x - dir * 24 + (Math.random() - 0.5) * 38, y: VIEW.GROUND - 4,
            vx: -dir * (60 + Math.random() * 110), vy: -25 - Math.random() * 65,
            life: 0.34 + Math.random() * 0.2, max: 0.54, size: 3 + ((Math.random() * 4) | 0),
            color: Math.random() < 0.5 ? '#d8bd8d' : '#9c8c7a', g: 120, drag: 3
          });
        }
        if (Math.random() < 0.5) this.fx.speedLine(p.x - dir * 58, p.y - 34, -dir);
      } else {
        if (Math.random() < 0.9) {
          this.fx.parts.push({
            x: p.x + (Math.random() - 0.5) * 18, y: p.y + (Math.random() - 0.5) * 18,
            vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40,
            life: 0.3, max: 0.4, size: 2 + Math.round(Math.random() * 2), color: p.color, g: 0, drag: 4
          });
        }
      }

      // 多段投射物（外卖车）：冷却结束后可再次命中同一目标
      if (p.hitT > 0) {
        p.hitT -= dt;
        if (p.hitT <= 0) p.hit = false;
      }
      const target = p.owner === this.p1 ? this.p2 : this.p1;
      if (!p.hit && p.life > 0 && target.state !== 'ko') {
        const tb = target.hurtBox;
        const ry = Math.max(24, p.radius || 0);   // 竖向判定跟随视觉半径，大体积弹体不会“擦头而过”
        if (p.x + p.radius * 0.6 > tb.x0 && p.x - p.radius * 0.6 < tb.x1
          && p.y + ry > tb.y0 && p.y - ry < tb.y1) {
          p.hit = true;
          if (p.maxHits) {
            p.hits = (p.hits || 0) + 1;
            p.finalHit = p.hits >= p.maxHits;
            p.hitT = p.rehit || 0.24;
          }
          this.projectileHit(p, target);
          if (p.finalHit) { arr.splice(i, 1); continue; }
          if (!p.pierce && !p.maxHits) { arr.splice(i, 1); continue; }
          // 穿透型：命中后继续飞行（p.hit 已防止对同一目标重复判定）
        }
      }
      if (p.life <= 0 || p.x < -60 || p.x > VIEW.W + 60) arr.splice(i, 1);
    }
  }

  projectileHit(p, target) {
    const fx = this.fx, audio = this.audio;
    if (target.invuln > 0) {
      fx.text(target.x, target.y - 150, 'MISS', '#9aa6c0', 10);
      return;
    }
    const dir = p.beam ? ((p.owner && p.owner.facing) || 1) : (Math.sign(p.vx) || 1);
    const blocked = target.state === 'block' && Math.sign(target.facing) === -dir;
    target.flash = 1;
    // 必杀时停：命中瞬间解除锁定，让对手恢复行动
    if (p.owner && p.owner.lockedTarget === target) p.owner.releaseLock();

    if (blocked) {
      const dmg = p.dmg * 0.16;
      target.hp -= dmg;
      target.blockstun = 0.24;
      target.vx = dir * 90;
      target.gainRage(RAGE.block);
      p.owner.gainRage(4);
      fx.blockSpark(target.x - dir * 18, target.y - 90, target.elem);
      fx.text(target.x, target.y - 130, 'GUARD', '#9fe6ff', 11);
      audio.block();
      fx.shake(4, 0.14);
    } else {
      const decayed = p.castNo !== 2 && p.castNo !== 3;     // I / O 固定伤害，不吃连击衰减
      const scale = decayed ? Math.max(0.75, 1 - p.owner.combo * 0.05) : 1;
      const dmg = p.dmg * scale * (p.owner && p.owner.dmgMul ? p.owner.dmgMul : 1);
      target.hp -= dmg;
      target.setState('hurt');
      const kb = p.type === 'bike' && p.finalHit ? (p.finalKb || 320) : (p.kb || 280);

      // 外卖车：概率断连 —— 每次非首段命中有概率没连击起来，敌人触发无敌帧脱身
      let comboBroken = false;
      if (p.type === 'bike' && !p.finalHit && (p.hits || 0) > 1 && Math.random() < 0.22) {
        comboBroken = true;
      }

      if (p.type === 'bike' && p.finalHit) {
        // 最后一撞：连人带车狠狠撞飞
        target.hitstun = 0.5;
        target.vy = -320;
        target.grounded = false;
        target.juggle = Math.max(target.juggle || 0, 1);
        target.vx = dir * kb;
      } else if (p.type === 'bike') {
        // 连撞中段：每一下都把人撞飞起来，车减速跟着对手保持连击
        if (comboBroken) {
          // 没连击起来：敌人获得无敌帧脱身，车继续向前不再纠缠
          target.invuln = 0.6;
          target.hitstun = 0.12;
          target.vy = -120;
          target.grounded = false;
          target.vx = dir * 120;
          p.vx = dir * 300;   // 车加速冲过去，不再连撞
          fx.text(target.x, target.y - 150, '闪避!', '#9fe6ff', 11);
        } else {
          // 正常连撞：把人撞飞
          p.vx = dir * 120;   // 车减速，贴着对手继续撞
          target.hitstun = 0.34;
          target.vy = -260;
          target.grounded = false;
          target.juggle = Math.max(target.juggle || 0, 1);
          target.vx = dir * 100;
        }
      } else if (p.beam) {
        // 持续火球：火球减速贴着人烧，双方同速后退，形成连续判定
        p.vx = dir * 70;
        target.hitstun = 0.18;
        target.grounded = true;
        target.vy = 0;
        target.juggle = 0;
      } else if (p.type === 'ice' || ((p.type === 'water' || p.type === 'rice' || p.type === 'sonic') && kb < 400)) {
        // 穿透冰刺 / 多段投射物中段：轻击退，不击飞不倒地
        target.hitstun = p.type === 'ice' ? 0.18 : 0.2;
        target.grounded = true;
        target.vy = 0;
        target.juggle = 0;
      } else {
        target.hitstun = 0.38;
        target.vy = kb >= 400 ? -190 : -130;
        target.grounded = false;
        target.juggle = Math.max(target.juggle || 0, 1);   // 被砸飞 → 落地倒地
      }
      if (p.type !== 'bike') target.vx = dir * kb;
      p.owner.payHitRage(target, p.castNo || 0);
      p.owner.combo++;
      p.owner.comboT = 1.4;
      if (p.type === 'fire') {
        if (p.beam) {
          // 持续火球：每一下都是小火苗，不做爆炸
          fx.spark(p.x, p.y, '#ffce6a', 1.2, 8);
          fx.spark(p.x, p.y, '#ff6426', 1, 6);
          fx.shake(3, 0.08);
          audio.charHit('frost', 'punch', 0.6);
        } else {
          // 火球命中爆裂：双层火花 + 扩散火环
          fx.spark(p.x, p.y, '#ffce6a', 2, 24);
          fx.spark(p.x, p.y, '#ff6426', 1.6, 20);
          fx.ring(p.x, p.y, 96, '#ff8a2c', 0.42, 6);
          fx.flash('#ffb35c', 0.2, 0.1);
          fx.shake(13, 0.35);
          fx.stop(0.08);
          audio.boom();
        }
      } else if (p.type === 'milk') {
        // 狗奶砸中：奶花四溅 + 奶白冲击环
        fx.spark(p.x, p.y, '#ffffff', 1.7, 16);
        fx.spark(p.x, p.y, '#ffe9c0', 1.2, 10);
        fx.ring(p.x, p.y, 72, '#fff6e2', 0.34, 4);
        fx.shake(9, 0.26);
        fx.stop(0.06);
        audio.charHit('dog', 'kick', 1.0);
      } else if (p.type === 'bike') {
        // 外卖车连撞：中段是密集小火花，最后一撞才炸开
        fx.spark(p.x, p.y, p.finalHit ? '#ffd06a' : '#ffb27a', p.finalHit ? 1.8 : 1, p.finalHit ? 18 : 9);
        fx.spark(p.x, p.y, '#ff6a3c', 1.2, p.finalHit ? 14 : 7);
        fx.ring(p.x, p.y, p.finalHit ? 84 : 34, '#ffd06a', p.finalHit ? 0.38 : 0.2, p.finalHit ? 5 : 2);
        fx.shake(p.finalHit ? 12 : 5, p.finalHit ? 0.3 : 0.14);
        fx.stop(p.finalHit ? 0.07 : 0.03);
        audio.cry('hopper', p.finalHit ? 'kick' : 'hit');
      } else if (p.type === 'claw') {
        // 龙爪手命中：紫电迸裂 + 黑气炸开
        fx.spark(p.x, p.y, '#d8b4ff', 1.5, 16);
        fx.spark(p.x, p.y, '#4b2a7a', 1.1, 10);
        fx.ring(p.x, p.y, 56, '#a673ff', 0.26, 3);
        fx.shake(8, 0.2);
        fx.stop(0.03);
        audio.charHit(p.owner && p.owner.def ? p.owner.def.id : '', 'heavy', 1.1);
      } else if (p.type === 'ice') {
        fx.spark(p.x, p.y, '#ffffff', 1.1, 10);
        fx.spark(p.x, p.y, '#9fd8ff', 0.9, 8);
        fx.ring(p.x, p.y, 38, '#cfeaff', 0.22, 2);
        fx.shake(4, 0.12);
        fx.stop(0.025);
        audio.charHit(p.owner && p.owner.def ? p.owner.def.id : '', 'punch', 0.8);
      } else {
        fx.spark(p.x, p.y, '#fff6d0', 1.5, 16);
        fx.spark(p.x, p.y, p.color, 1.2, 10);
        fx.ring(p.x, p.y, 60, '#fff', 0.3, 4);
        fx.shake(10, 0.3);
        fx.stop(0.06);
        audio.charHit(p.owner && p.owner.def ? p.owner.def.id : '', 'heavy', 1.4);
      }
      fx.text(p.x, p.y - 30, '-' + Math.round(dmg), '#ffd166', 14);
    }
    this.checkKO(target);
  }

  /* ---------- 渲染 ---------- */
  render() {
    const ctx = this.ctx;
    const fx = this.fx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#04060b';
    ctx.fillRect(0, 0, 1280, 720);

    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.save();
    ctx.translate(Math.round(fx.sx), Math.round(fx.sy));

    ctx.drawImage(this.stage, -8, -6, VIEW.W + 16, VIEW.H + 12);
    this.drawMotes(ctx);

    fx.drawGhosts(ctx, 0);

    // 进攻方绘制在上层，避免贴身时被对手挡住
    let first = this.p1, second = this.p2;
    if (this.p1 && this.p2) {
      const p1Front = this.p1.state === 'attack' || this.p1.state === 'skill';
      const p2Front = this.p2.state === 'attack' || this.p2.state === 'skill';
      if (p1Front && !p2Front) { first = this.p2; second = this.p1; }
      else if (!p1Front && !p2Front) { first = this.p2.x <= this.p1.x ? this.p2 : this.p1; second = first === this.p1 ? this.p2 : this.p1; }
    }
    if (first) first.draw(ctx, 0);
    if (second) second.draw(ctx, 0);

    for (const p of this.projectiles) this.drawProjectile(ctx, p);

    fx.drawCones(ctx, 0);
    fx.drawRings(ctx, 0);
    fx.drawParts(ctx, 0);
    fx.drawLines(ctx, 0);
    fx.drawTexts(ctx, 0);

    if (this.mode === 'intro') this.drawIntro(ctx);

    ctx.restore();
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    this.drawMouthCutin(ctx);
    this.drawDragonClawCutin(ctx);
    this.drawSlamCutin(ctx);
    this.drawMegaPunchCutin(ctx);
    this.drawBellyLaughCutin(ctx);
    this.drawWhaleSongCutin(ctx);
    this.drawSorryCutin(ctx);
    this.drawBikeCutin(ctx);
    fx.drawFlash(ctx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /* 喷火前摇：嘴部特写，张嘴蓄火；喷出瞬间镜头里一道火柱冲出 */
  drawMouthCutin(ctx) {
    const f = [this.p1, this.p2].find((o) => o && o.skill && o.skill.id === 'fireball'
      && o.skill.t < o.skill.windup + 0.22);
    if (!f || !f.sp || !f.sp.poses) return;
    const sp = f.sp.poses.skill || f.sp.poses.idle;
    if (!sp) return;
    const s = f.skill;
    const W = s.windup;
    const p = Math.min(1, s.t / W);
    const blast = s.t > W ? Math.min(1, (s.t - W) / 0.22) : 0;
    const cx = VIEW.W / 2, cy = 142, R = 96;
    const ease = 1 - (1 - p) * (1 - p);

    ctx.save();
    // 背景压暗，焦点拉到嘴部
    ctx.fillStyle = 'rgba(4,6,11,' + (0.5 * Math.min(1, p * 4)).toFixed(3) + ')';
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);

    // 圆形取景框：对着贴图里的脸推近
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    const w = sp.w, h = sp.h;
    const mx = w * 0.735, my = h * 0.245;      // 嘴在贴图里的位置（白龙新姿势）
    const zoom = 1 + ease * 0.45;
    const side = w * 0.30 / zoom;
    ctx.drawImage(sp.img, mx - side / 2, my - side / 2, side, side, cx - R, cy - R, R * 2, R * 2);

    // 嘴里的火：越蓄越亮
    const glow = 0.18 + ease * 0.82;
    const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, R * 0.55);
    g.addColorStop(0, 'rgba(255,246,214,' + (0.95 * glow).toFixed(3) + ')');
    g.addColorStop(0.35, 'rgba(255,150,52,' + (0.5 * glow).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255,80,16,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    // 嘴前舔出的火舌
    const fl = 0.3 + ease * 0.7;
    for (let i = 0; i < 3; i++) {
      const wob = Math.sin(s.t * 26 + i * 2.1) * 5;
      const rr = (5 + i * 5) * fl;
      ctx.globalAlpha = (0.55 - i * 0.13) * fl;
      ctx.fillStyle = i === 0 ? '#fff6d6' : i === 1 ? '#ffb347' : '#ff6a1c';
      ctx.beginPath();
      ctx.arc(cx + wob * 0.4, cy - i * 3 * fl, rr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 喷出瞬间：特写里一道火柱从嘴里冲出（顺着镜头向右）
    if (blast > 0) {
      const len = R * (0.55 + blast * 1.7);
      const g2 = ctx.createLinearGradient(cx + 6, cy, cx + len, cy);
      g2.addColorStop(0, 'rgba(255,252,226,.98)');
      g2.addColorStop(0.32, 'rgba(255,200,96,.95)');
      g2.addColorStop(0.72, 'rgba(255,110,36,.8)');
      g2.addColorStop(1, 'rgba(255,70,20,0)');
      ctx.fillStyle = g2;
      ctx.beginPath();
      const wing = 9 + 14 * (1 - blast);
      ctx.moveTo(cx + 4, cy - 6);
      ctx.quadraticCurveTo(cx + len * 0.55, cy - wing, cx + len, cy);
      ctx.quadraticCurveTo(cx + len * 0.55, cy + wing, cx + 4, cy + 6);
      ctx.closePath();
      ctx.fill();
      // 火柱上的亮芯
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = 'rgba(255,255,235,.9)';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(cx + 6, cy);
      ctx.quadraticCurveTo(cx + len * 0.5, cy - 3, cx + len * 0.86, cy);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // 特写里的火星：蓄力时往嘴里吸，喷出后往前飞
    for (let i = 0; i < 10; i++) {
      const a = i * 1.7 + s.t * 5;
      const rr = R * (0.95 - ((s.t * 0.9 + i * 0.17) % 1) * 0.85);
      const px = cx + Math.cos(a) * rr, py = cy + 10 + Math.sin(a) * rr * 0.75;
      ctx.fillStyle = i % 3 === 0 ? '#fff0c0' : '#ff9a3c';
      ctx.globalAlpha = 0.35 + 0.6 * ease;
      ctx.fillRect(px, py, 2, 2);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // 取景框边框 + 蓄满时的白热闪光
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,174,86,' + (0.55 + ease * 0.45).toFixed(2) + ')';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    if (ease > 0.9 && blast <= 0) {
      ctx.fillStyle = 'rgba(255,240,200,' + ((ease - 0.9) * 2.2).toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /* 大力拳特写：镜头从肩臂一路推到拳套，蓄满后拳头猛地朝镜头打出去 */
  drawMegaPunchCutin(ctx) {
    const f = [this.p1, this.p2].find((o) => o && o.skill && o.skill.id === 'megapunch'
      && o.skill.t < o.skill.windup + 0.15);
    if (!f || !f.sp || !f.sp.poses) return;
    const sp = f.sp.poses.punch || f.sp.poses.idle;
    if (!sp) return;
    const s = f.skill;
    const W = s.windup;
    const p = Math.min(1, s.t / W);
    const easeIn = p * p * (3 - 2 * p);
    const burst = s.t > W ? Math.min(1, (s.t - W) / 0.15) : 0;
    const push = burst * burst;

    const R = 96 + push * 28;
    const cx = VIEW.W / 2 + push * 34;
    const cy = 150 - push * 12;

    ctx.save();
    // 蓄力时压暗画面，出拳瞬间暗场让位给冲击特效
    const dark = 0.68 * Math.min(1, p * 3) * (1 - push);
    ctx.fillStyle = 'rgba(4,6,11,' + dark.toFixed(3) + ')';
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);

    // 圆形取景
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;

    // 镜头推近：从肩臂滑到拳套，出拳时再猛推一把
    const w = sp.w, h = sp.h;
    const mx = w * (0.858 + 0.024 * easeIn);
    const my = h * (0.242 - 0.030 * easeIn);
    const zoom = 1 + easeIn * 0.5 + push * 1.0;
    const side = w * 0.34 / zoom;
    const ox = push * R * 0.55, oy = -push * R * 0.38;
    ctx.drawImage(sp.img, mx - side / 2, my - side / 2, side, side,
      cx - R + ox, cy - R + oy, R * 2, R * 2);

    // 放射速度线：蓄力时向内收紧，出拳时向外拉成冲击线
    const lines = 30;
    for (let i = 0; i < lines; i++) {
      const a = (i / lines) * Math.PI * 2 + s.t * 0.7;
      const inner = R * (0.42 + 0.3 * easeIn - push * 0.1);
      const outer = R * (1.02 + push * 0.5);
      ctx.strokeStyle = 'rgba(255,' + (200 + (i % 3) * 18) + ',130,'
        + (0.1 + easeIn * 0.3 + push * 0.4).toFixed(3) + ')';
      ctx.lineWidth = 1.6 + (i % 3) * 0.9;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
      ctx.stroke();
    }

    // 拳心的蓄力光球：蓄满后炸开
    const glow = Math.max(0, 0.28 + easeIn * 0.72 - push * 1.15);
    if (glow > 0) {
      const gr = R * (0.16 + easeIn * 0.5 + push * 1.8);
      const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, gr);
      g.addColorStop(0, 'rgba(255,252,226,' + (0.95 * glow).toFixed(3) + ')');
      g.addColorStop(0.4, 'rgba(255,205,70,' + (0.55 * glow).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(255,138,28,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    }

    // 蓄力气流：向拳心收束
    if (push <= 0) {
      for (let i = 0; i < 14; i++) {
        const a = i * 1.7 + s.t * 6;
        const rr = R * (0.95 - ((s.t * 1.2 + i * 0.14) % 1) * 0.84);
        ctx.globalAlpha = 0.35 + 0.65 * easeIn;
        ctx.fillStyle = i % 3 === 0 ? '#fffbe6' : '#ffd166';
        ctx.fillRect(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.85, 2.5, 2.5);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    // 取景框：蓄力时抖动，出拳时向外炸开
    const jit = Math.sin(s.t * 40) * easeIn * 2.4;
    ctx.lineWidth = 2.5 * (1 - push) + 0.6;
    ctx.strokeStyle = 'rgba(255,216,90,' + ((0.6 + easeIn * 0.4) * (1 - push)).toFixed(2) + ')';
    ctx.beginPath();
    ctx.arc(cx + jit * 0.3, cy + jit, R + push * 46, 0, Math.PI * 2);
    ctx.stroke();

    // 拳套撞上镜头的白闪
    if (push > 0) {
      ctx.fillStyle = 'rgba(255,250,232,' + (push * 0.38).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /* 捧腹大笑特写：圆形取景推到仰头大笑的脸，笑声化作一圈圈音波 */
  drawBellyLaughCutin(ctx) {
    const f = [this.p1, this.p2].find((o) => o && o.skill && o.skill.id === 'bellylaugh'
      && o.skill.t < o.skill.windup);
    if (!f || !f.sp || !f.sp.poses) return;
    const sp = f.sp.poses.laugh || f.sp.poses.idle;
    if (!sp) return;
    const s = f.skill;
    const p = Math.min(1, s.t / s.windup);
    const ease = Math.min(1, p * 1.2);
    const cx = VIEW.W / 2, cy = 172, R = 96;

    ctx.save();
    ctx.fillStyle = 'rgba(4,6,11,' + (0.6 * Math.min(1, p * 4)).toFixed(3) + ')';
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    const w = sp.w, h = sp.h;
    const mx = w * 0.49, my = h * 0.22;
    const zoom = 1 + ease * 0.24;
    const side = w * 0.74 / zoom;
    ctx.drawImage(sp.img, mx - side / 2, my - side / 2, side, side, cx - R, cy - R, R * 2, R * 2);

    // 笑声音波从嘴部一圈圈荡开
    const mouthY = cy + 20;
    for (let i = 0; i < 3; i++) {
      const t = (s.t * 2.4 + i / 3) % 1;
      const rr = R * (0.22 + t * 0.92);
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.strokeStyle = i % 2 ? '#ffffff' : '#ffe066';
      ctx.lineWidth = 3.2 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(cx, mouthY, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // 取景框：随笑声抖动
    const jit = Math.sin(s.t * 34) * ease * 2.2;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,224,102,' + (0.65 + ease * 0.35).toFixed(2) + ')';
    ctx.beginPath();
    ctx.arc(cx + jit * 0.3, cy + jit, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /* 跳跳胆子肥嘟嘟前半句特写：“你的胆子真”说完立即收镜出车 */
  drawBikeCutin(ctx) {
    const f = [this.p1, this.p2].find((o) => o && o.skill && o.skill.id === 'bike'
      && o.skill.t < (o.skill.release || o.skill.shout));
    if (!f || !f.sp || !f.sp.poses) return;
    const sp = f.sp.poses.skill || f.sp.poses.idle;
    if (!sp) return;
    const s = f.skill;
    const release = s.release || s.shout;
    // 前 80% 喊话推近，后 20% 快速拉回准备放车
    const p = Math.min(1, s.t / release);
    const ease = p < 0.8 ? Math.min(1, p / 0.3) : 1 - (p - 0.8) / 0.2;
    const cx = VIEW.W / 2, cy = 150, R = 100;

    ctx.save();
    // 背景压暗
    ctx.fillStyle = 'rgba(4,6,11,' + (0.62 * ease).toFixed(3) + ')';
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    const w = sp.w, h = sp.h;
    // 袋鼠脸在贴图上半部分
    const mx = w * 0.5, my = h * 0.18;
    const zoom = 1 + ease * 0.28;
    const side = w * 0.62 / zoom;
    ctx.drawImage(sp.img, mx - side / 2, my - side / 2, side, side, cx - R, cy - R, R * 2, R * 2);

    // 金色气场粒子从外向脸汇聚
    for (let i = 0; i < 14; i++) {
      const a = i * 1.7 + s.t * 4;
      const tt = (s.t * 0.8 + i * 0.13) % 1;
      const rr = R * (1.0 - tt * 0.82);
      const px = cx + Math.cos(a) * rr;
      const py = cy + Math.sin(a) * rr * 0.82;
      ctx.fillStyle = i % 2 ? '#ffe38a' : '#ffd86a';
      ctx.globalAlpha = (0.4 + 0.6 * ease) * (1 - tt);
      ctx.fillRect(px - 1, py - 1, 3, 3);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // 取景框边框（金色，随喊话抖动）
    const jit = Math.sin(s.t * 30) * ease * 1.8;
    ctx.lineWidth = 2.8;
    ctx.strokeStyle = 'rgba(255,208,90,' + (0.6 + ease * 0.4).toFixed(2) + ')';
    ctx.beginPath();
    ctx.arc(cx + jit * 0.3, cy + jit, R, 0, Math.PI * 2);
    ctx.stroke();

    // 台词字幕
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 16px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,' + (0.5 * ease).toFixed(3) + ')';
    ctx.fillText('你的胆子真是肥嘟嘟的！', cx + 1, cy + R + 26);
    ctx.fillStyle = '#ffe08a';
    ctx.fillText('你的胆子真是肥嘟嘟的！', cx, cy + R + 25);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }


  drawMotes(ctx) {
    for (const m of this.motes) {
      m.y -= m.v * 0.016;
      m.x += Math.sin((m.y + m.x) * 0.01) * 0.15;
      if (m.y < 60) { m.y = VIEW.GROUND - 20; m.x = Math.random() * VIEW.W; }
      ctx.globalAlpha = m.a;
      ctx.fillStyle = '#ffe6b0';
      ctx.fillRect(Math.round(m.x), Math.round(m.y), m.s, m.s);
    }
    ctx.globalAlpha = 1;
  }

  drawIntro(ctx) {
    const p1 = Math.round(this.p1.x), p2 = Math.round(this.p2.x);
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);
    ctx.restore();
    // 对手指示箭头
    const arrow = (x, dir, color) => {
      ctx.save();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      const b = Math.sin(performance.now() * 0.008) * 3;
      ctx.beginPath();
      ctx.moveTo(x + dir * (54 + b), VIEW.GROUND - 96);
      ctx.lineTo(x + dir * (70 + b), VIEW.GROUND - 88);
      ctx.lineTo(x + dir * (54 + b), VIEW.GROUND - 80);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    arrow(p1, 1, this.p1.def.color);
    arrow(p2, -1, this.p2.def.color);
  }

  /* 暴砸起跳特写：镜头怼到高举的双拳，随起跳推近、斗气上冲 */
  drawSlamCutin(ctx) {
    const f = [this.p1, this.p2].find((o) => o && o.skill && o.skill.id === 'slam'
      && !o.skill.struck && o.skill.t < 0.5);
    if (!f || !f.sp || !f.sp.poses) return;
    const s = f.skill;
    const sp = f.sp.poses.jump || f.sp.poses.slam_0 || f.sp.poses.idle;
    if (!sp) return;
    const p = Math.min(1, s.t / 0.5);
    const ease = p * p * (3 - 2 * p);
    const cx = VIEW.W / 2, cy = 142, R = 98;

    ctx.save();
    ctx.fillStyle = 'rgba(4,6,11,' + (0.6 * Math.min(1, p * 4)).toFixed(3) + ')';
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    const w = sp.w, h = sp.h;
    const mx = w * 0.72, my = h * 0.155;       // 脸部
    const zoom = 1 + ease * 0.3;
    const side = w * 0.34 / zoom;
    ctx.drawImage(sp.img, mx - side / 2, my - side / 2,
      side, side, cx - R, cy - R, R * 2, R * 2);

    // 斗气：黄色光核
    const g = ctx.createRadialGradient(cx, cy + 10, 4, cx, cy + 10, R);
    g.addColorStop(0, 'rgba(255,244,180,' + (0.5 * ease).toFixed(3) + ')');
    g.addColorStop(0.4, 'rgba(255,208,60,' + (0.26 * ease).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(120,80,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

    // 上冲的速度线
    ctx.strokeStyle = 'rgba(255,248,210,' + (0.5 * ease).toFixed(2) + ')';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 9; i++) {
      const x = cx - R + ((i * 37 + 18) % (R * 2));
      const off = (s.t * 620 + i * 73) % (R * 2.2);
      const y0 = cy + R - off;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + 26);
      ctx.stroke();
    }
    ctx.restore();

    // 取景框
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,224,102,' + (0.65 + ease * 0.35).toFixed(2) + ')';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    if (p > 0.88) {
      ctx.fillStyle = 'rgba(255,250,225,' + ((p - 0.88) / 0.12 * 0.75).toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /* 鲸歌：备战姿势的镜头特写，配「必杀，鲸歌咏叹调」台词 */
  drawWhaleSongCutin(ctx) {
    const f = [this.p1, this.p2].find((o) => o && o.skill && o.skill.id === 'whalesong'
      && o.skill.t < o.skill.sing);
    if (!f || !f.sp || !f.sp.poses) return;
    const s = f.skill;
    const sp = f.sp.poses.idle || f.sp.poses.block;
    if (!sp) return;
    const p = Math.min(1, s.t / s.sing);
    const ease = p * p * (3 - 2 * p);
    const cx = VIEW.W / 2, base = VIEW.H - 18;
    const h = 310 * (1 + ease * 0.05);
    const w = h * sp.w / sp.h;

    ctx.save();
    ctx.fillStyle = 'rgba(3,9,20,' + (0.66 * Math.min(1, p * 4)).toFixed(3) + ')';
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);

    // 蓝色聚光 + 环状音浪
    const g = ctx.createRadialGradient(cx, 250, 20, cx, 250, 330);
    g.addColorStop(0, 'rgba(120,220,255,.26)');
    g.addColorStop(0.55, 'rgba(60,150,220,.1)');
    g.addColorStop(1, 'rgba(10,40,80,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sp.img, cx - w / 2, base - h, w, h);

    ctx.strokeStyle = 'rgba(160,235,255,' + (0.32 + 0.4 * Math.sin(p * Math.PI)).toFixed(2) + ')';
    for (let i = 0; i < 4; i++) {
      ctx.lineWidth = 2.4 - i * 0.4;
      ctx.beginPath();
      ctx.arc(cx, 214, 74 + i * 44 + ease * 26, -0.72, 0.72);
      ctx.stroke();
    }

    // 电影黑边 + 台词字幕
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(0, 0, VIEW.W, 26);
    ctx.fillRect(0, VIEW.H - 44, VIEW.W, 44);
    ctx.fillStyle = '#d8f4ff';
    ctx.font = 'bold 17px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('必杀 · 鲸歌咏叹调', cx, VIEW.H - 21);
    ctx.restore();
  }

  /* 黑桃「抱歉」：张开双臂的圣洁特写，台词结束后圣光扩散 */
  drawSorryCutin(ctx) {
    const f = [this.p1, this.p2].find((o) => o && o.skill && o.skill.id === 'sorry'
      && o.skill.t < o.skill.windup + 0.22);
    if (!f || !f.sp || !f.sp.poses) return;
    const sp = f.sp.poses.sorry;
    if (!sp) return;
    const s = f.skill;
    const p = Math.min(1, s.t / s.windup);
    const ease = p * p * (3 - 2 * p);
    const fade = s.t <= s.windup ? 1 : 1 - (s.t - s.windup) / 0.22;
    const cx = VIEW.W / 2, base = 408;
    const h = 322 * (0.96 + ease * 0.04), w = h * sp.w / sp.h;

    ctx.save();
    ctx.globalAlpha = Math.max(0, fade);
    ctx.fillStyle = 'rgba(25,16,20,' + (0.62 * Math.min(1, p * 5)).toFixed(3) + ')';
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);

    const aura = ctx.createRadialGradient(cx, 196, 12, cx, 196, 310);
    aura.addColorStop(0, 'rgba(255,250,207,.6)');
    aura.addColorStop(0.38, 'rgba(255,208,105,.25)');
    aura.addColorStop(1, 'rgba(100,52,20,0)');
    ctx.fillStyle = aura;
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);

    // 参考图中的天堂拱门与放射状圣光
    ctx.save();
    ctx.translate(cx, 174);
    ctx.strokeStyle = 'rgba(255,237,166,' + (0.2 + ease * 0.35).toFixed(2) + ')';
    for (let i = 0; i < 18; i++) {
      const a = i * Math.PI * 2 / 18 + s.t * 0.05;
      ctx.lineWidth = i % 3 === 0 ? 3 : 1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 108, Math.sin(a) * 108);
      ctx.lineTo(Math.cos(a) * (205 + ease * 48), Math.sin(a) * (205 + ease * 48));
      ctx.stroke();
    }
    for (let i = 0; i < 3; i++) {
      ctx.lineWidth = 5 - i;
      ctx.beginPath();
      ctx.ellipse(0, 24, 72 + i * 14, 112 + i * 15, 0, Math.PI, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // 柔和云光铺在人物脚下
    for (let i = 0; i < 12; i++) {
      const x = 80 + i * 59, y = 360 + Math.sin(i * 1.7) * 16;
      const cloud = ctx.createRadialGradient(x, y, 2, x, y, 68);
      cloud.addColorStop(0, 'rgba(255,238,193,.2)');
      cloud.addColorStop(1, 'rgba(255,211,133,0)');
      ctx.fillStyle = cloud;
      ctx.fillRect(x - 70, y - 70, 140, 140);
    }

    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sp.img, cx - w / 2, base - h, w, h);
    for (let i = 0; i < 20; i++) {
      const a = i * 2.4 + s.t * 0.5;
      const x = cx + Math.sin(a) * (95 + i % 4 * 18);
      const y = 370 - ((s.t * 45 + i * 23) % 280);
      ctx.globalAlpha = fade * (0.3 + (i % 3) * 0.2);
      ctx.fillStyle = '#fff3bc';
      ctx.fillRect(x, y, 2, 2);
    }

    ctx.globalAlpha = fade;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(0, 0, VIEW.W, 26);
    ctx.fillRect(0, VIEW.H - 44, VIEW.W, 44);
    ctx.font = 'bold 17px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff0bb';
    ctx.fillText('抱歉，请把力量借给我吧', cx, VIEW.H - 21);
    ctx.restore();
  }

  /* 龙爪手蓄力特写：镜头推到手上，漆黑巨爪在紫电里成形（喊「秘技」的这段时间） */
  drawDragonClawCutin(ctx) {
    const f = [this.p1, this.p2].find((o) => o && o.skill && o.skill.id === 'dragonclaw'
      && o.skill.t < o.skill.windup + 0.08);
    if (!f || !f.sp || !f.sp.poses) return;
    const sp = f.sp.poses.skill || f.sp.poses.idle;
    if (!sp) return;
    const s = f.skill;
    const W = s.windup;
    const p = Math.min(1, s.t / W);
    const ease = p * p * (3 - 2 * p);
    const strike = s.t > W ? Math.min(1, (s.t - W) / 0.08) : 0;
    const cx = VIEW.W / 2, cy = 150, R = 100;

    ctx.save();
    // 压暗画面，把注意力拉到手上
    const dark = 0.62 * Math.min(1, p * 4) * (1 - strike);
    ctx.fillStyle = 'rgba(4,6,11,' + dark.toFixed(3) + ')';
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);

    // 圆形取景：对着她的手/上半身，随蓄力慢慢推近
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    const w = sp.w, h = sp.h;
    const mx = w * 0.80, my = h * 0.30;        // 手在贴图里的位置
    const zoom = 1 + ease * 0.5 + strike * 0.35;
    const side = w * 0.40 / zoom;
    ctx.drawImage(sp.img, mx - side / 2, my - side * (h / w) / 2,
      side, side * (h / w), cx - R, cy - R, R * 2, R * 2);

    // 掌心紫电光核（先铺底光，再画爪子，爪子才不会被冲淡）
    const g = ctx.createRadialGradient(cx - 8, cy, 2, cx - 8, cy, R * 0.95);
    g.addColorStop(0, 'rgba(226,199,255,' + (0.55 * ease).toFixed(3) + ')');
    g.addColorStop(0.35, 'rgba(150,92,240,' + (0.26 * ease).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(80,40,150,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

    // 黑爪在紫电中长出来：蓄力越满越大、越实
    const grow = 0.5 + ease * 1.0 + strike * 0.6;
    ctx.save();
    ctx.translate(cx + 2, cy + 6);
    ctx.rotate(-0.14 + ease * 0.08);
    ctx.scale(grow, grow);
    this.paintClaw(ctx, s.t, 0.55 + ease * 0.45);
    ctx.restore();

    // 蓄力火花：往掌心汇聚
    for (let i = 0; i < 12; i++) {
      const a = i * 1.9 + s.t * 6;
      const rr = R * (0.95 - ((s.t * 1.1 + i * 0.13) % 1) * 0.8);
      const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr * 0.85;
      ctx.fillStyle = i % 3 === 0 ? '#efe0ff' : '#b184ff';
      ctx.globalAlpha = 0.3 + 0.65 * ease;
      ctx.fillRect(px, py, 2, 2);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // 取景框
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(178,130,255,' + (0.6 + ease * 0.4).toFixed(2) + ')';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    if (strike > 0) {
      ctx.fillStyle = 'rgba(236,220,255,' + (strike * 0.9).toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  /* 黑紫色龙爪本体（局部坐标：原点在爪心，+x 朝前） */
  paintClaw(ctx, t, alpha) {
    ctx.globalAlpha = alpha;
    // 后方黑气
    ctx.fillStyle = 'rgba(28,16,48,.5)';
    ctx.beginPath();
    ctx.moveTo(-80, 0);
    ctx.quadraticCurveTo(-42, -28, -8, -20);
    ctx.lineTo(-8, 20);
    ctx.quadraticCurveTo(-42, 28, -80, 0);
    ctx.fill();
    // 爪心
    const cg = ctx.createRadialGradient(-4, 0, 4, -4, 0, 30);
    cg.addColorStop(0, '#3a2359');
    cg.addColorStop(0.6, '#1a0f2b');
    cg.addColorStop(1, '#0d0716');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.ellipse(-4, 0, 25, 21, 0, 0, Math.PI * 2);
    ctx.fill();
    // 四根尖爪
    const fingers = [
      { bx: -10, by: -15, tx: 44, ty: -27, w: 6 },
      { bx: 2, by: -6, tx: 56, ty: -8, w: 6.5 },
      { bx: 3, by: 5, tx: 53, ty: 9, w: 6 },
      { bx: -12, by: 15, tx: 36, ty: 27, w: 5.5 }
    ];
    ctx.shadowColor = '#7a4ad8';
    ctx.shadowBlur = 14;
    for (const f of fingers) {
      const mx = (f.bx + f.tx) / 2, my = (f.by + f.ty) / 2 - 5;
      ctx.beginPath();
      ctx.moveTo(f.bx, f.by - f.w);
      ctx.quadraticCurveTo(mx, my - f.w, f.tx, f.ty);
      ctx.quadraticCurveTo(mx, my + f.w, f.bx, f.by + f.w);
      ctx.closePath();
      ctx.fillStyle = '#150c22';
      ctx.fill();
      ctx.strokeStyle = 'rgba(160,110,255,.85)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.fillStyle = 'rgba(232,214,255,.92)';
      ctx.beginPath();
      ctx.arc(f.tx, f.ty, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    // 紫电
    ctx.strokeStyle = 'rgba(200,160,255,.95)';
    ctx.lineWidth = 1.8;
    for (let i = 0; i < 3; i++) {
      const yy = -20 + i * 20;
      ctx.beginPath();
      ctx.moveTo(-34, yy);
      for (let j = 1; j <= 4; j++) {
        ctx.lineTo(-34 + j * 20, yy + (Math.random() - 0.5) * 16);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawProjectile(ctx, p) {
    const dir = Math.sign(p.vx) || 1;
    ctx.save();
    if (p.type === 'rice') {
      const spin = Math.sin(p.t * 13) * 0.34 * dir;
      // 飞行气流
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 3; i++) {
        const yy = p.y - 10 + i * 10;
        ctx.beginPath();
        ctx.moveTo(p.x - dir * 20, yy);
        ctx.lineTo(p.x - dir * (46 + i * 10), yy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      ctx.translate(p.x, p.y);
      ctx.rotate(spin);
      // 米饭（碗口的几团饭）
      ctx.fillStyle = '#fffdf6';
      ctx.strokeStyle = '#c9bfa6';
      ctx.lineWidth = 1.2;
      const mound = [[-9, -6, 7], [0, -10, 8], [9, -6, 6.6], [-4, -12, 5.4], [5, -12, 5]];
      for (const [mx, my, mr] of mound) {
        ctx.beginPath();
        ctx.arc(mx, my, mr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      // 碗身
      ctx.beginPath();
      ctx.moveTo(-15, -2);
      ctx.quadraticCurveTo(-13, 13, 0, 14);
      ctx.quadraticCurveTo(13, 13, 15, -2);
      ctx.closePath();
      ctx.fillStyle = '#f2f6fb';
      ctx.fill();
      ctx.strokeStyle = '#3c5f9e';
      ctx.lineWidth = 2;
      ctx.stroke();
      // 碗上的两道青花蓝纹
      ctx.beginPath();
      ctx.moveTo(-13, 3); ctx.quadraticCurveTo(0, 8, 13, 3);
      ctx.strokeStyle = '#5b8ad6';
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, -2, 15, 4.6, 0, 0, Math.PI * 2);
      ctx.strokeStyle = '#3c5f9e';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    } else if (p.type === 'water') {
      // 水弹：拉长的水团 + 白色高光，飞行中轻微上下波动
      const wob = Math.sin(p.t * 22 + p.y * 0.1) * 2;
      const r = p.radius;
      // 尾流水雾
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#cfe9ff';
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(p.x - dir * (r * 0.9 + i * 7), p.y + wob + (i - 1) * 5, r * (0.42 - i * 0.09), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // 本体
      const grd = ctx.createRadialGradient(p.x - dir * r * 0.32, p.y - r * 0.36 + wob, 1, p.x, p.y + wob, r);
      grd.addColorStop(0, '#ffffff');
      grd.addColorStop(0.45, '#9fd8ff');
      grd.addColorStop(1, '#2f7fd6');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + wob, r * 1.18, r * 0.84, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = '#e8f6ff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 前端溅起的两颗水珠
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#dff1ff';
      ctx.beginPath();
      ctx.arc(p.x + dir * r * 1.1, p.y + wob - r * 0.5, r * 0.16, 0, Math.PI * 2);
      ctx.arc(p.x + dir * r * 0.7, p.y + wob - r * 0.72, r * 0.12, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else if (p.type === 'ice') {
      // 冰晶穿刺：飞行方向上的细长冰锥，命中后仍保留本体继续飞
      const k = p.radius / 22;
      ctx.globalAlpha = 0.38;
      ctx.strokeStyle = '#bfe4ff';
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 3; i++) {
        const yy = p.y + (i - 1) * 9;
        ctx.beginPath();
        ctx.moveTo(p.x - dir * (30 + i * 8), yy);
        ctx.lineTo(p.x - dir * (68 + i * 14), yy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.translate(p.x, p.y);
      ctx.scale(dir * k, k);
      ctx.shadowColor = '#78c9ff';
      ctx.shadowBlur = 12;
      const grd = ctx.createLinearGradient(-34, 0, 44, 0);
      grd.addColorStop(0, 'rgba(70,135,210,.3)');
      grd.addColorStop(0.42, '#75bde8');
      grd.addColorStop(0.78, '#d8f2ff');
      grd.addColorStop(1, '#ffffff');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(46, 0);
      ctx.lineTo(3, -12);
      ctx.lineTo(-34, -5);
      ctx.lineTo(-25, 0);
      ctx.lineTo(-34, 5);
      ctx.lineTo(3, 12);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#e8f7ff';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      // 冰芯和折面
      ctx.fillStyle = 'rgba(255,255,255,.82)';
      ctx.beginPath();
      ctx.moveTo(39, 0);
      ctx.lineTo(1, -3.5);
      ctx.lineTo(-24, 0);
      ctx.lineTo(1, 3.5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.72)';
      ctx.beginPath();
      ctx.moveTo(3, -11); ctx.lineTo(11, 0); ctx.lineTo(3, 11);
      ctx.moveTo(-25, 0); ctx.lineTo(40, 0);
      ctx.stroke();
    } else if (p.type === 'claw') {
      // 秘技·龙爪手：漆黑巨爪 + 紫色雷电 + 黑气拖尾（挥爪时从上方扫下来）
      const k = (p.radius || 40) / 40;
      const lifeK = Math.min(1, p.life / 0.18);
      const swing = Math.min(1, p.t / 0.16);
      ctx.translate(p.x, p.y);
      ctx.rotate(dir * (-0.3 + swing * 0.4));
      ctx.scale(dir * k, k);
      this.paintClaw(ctx, p.t, 0.55 + 0.45 * lifeK);
    } else if (p.type === 'fire') {
      // 豪火球：橙红尾焰、炽热外焰和黄白核心
      const r = p.radius;
      const pulse = 1 + Math.sin(p.t * 25) * 0.06;
      ctx.translate(p.x, p.y);
      ctx.scale(dir * pulse, pulse);
      for (let i = 2; i >= 0; i--) {
        ctx.globalAlpha = 0.26 + (2 - i) * 0.13;
        ctx.fillStyle = i === 0 ? '#ff9a32' : '#ff4b19';
        ctx.beginPath();
        ctx.ellipse(-r * (0.72 + i * 0.43), (i - 1) * r * 0.14,
          r * (0.9 - i * 0.13), r * (0.52 - i * 0.08), 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowColor = '#ff5a1f';
      ctx.shadowBlur = 22;
      const grd = ctx.createRadialGradient(r * 0.2, -r * 0.18, 2, 0, 0, r * 1.08);
      grd.addColorStop(0, '#ffffff');
      grd.addColorStop(0.2, '#fff3a6');
      grd.addColorStop(0.48, '#ffbd3e');
      grd.addColorStop(0.78, '#ff681f');
      grd.addColorStop(1, 'rgba(255,55,12,.18)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.06, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.72;
      ctx.strokeStyle = '#ffe293';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r * 0.08, 0, r * (0.62 + Math.sin(p.t * 19) * 0.05), -1.2, 1.45);
      ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (p.type === 'bike') {
      // 美团外卖电动车：出场弹放、金色光晕、长速度线和双层残影
      const appear = Math.min(1, p.t / 0.18);
      const sc = (p.radius || 50) / 50;   // 车体大小跟随判定半径，视觉与命中范围一致
      const bw = 132 * sc * (0.72 + appear * 0.28) * (1 + Math.sin(appear * Math.PI) * 0.18);
      const bh = BIKE_IMG ? bw * (BIKE_IMG.height / BIKE_IMG.width) : bw * 0.67;
      const bob = Math.sin(p.t * 32) * 1.5;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const glow = ctx.createRadialGradient(p.x, p.y - 24, 4, p.x, p.y - 24, 108 * sc);
      glow.addColorStop(0, 'rgba(255,248,196,.58)');
      glow.addColorStop(0.38, 'rgba(255,207,67,.3)');
      glow.addColorStop(1, 'rgba(255,112,32,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(p.x - 112 * sc, p.y - 132 * sc, 224 * sc, 168 * sc);
      ctx.restore();

      const lineColors = ['#fff8d0', '#ffd84e', '#ff9b38'];
      for (let i = 0; i < 8; i++) {
        const yy = p.y - bh * 0.72 + i * bh * 0.13;
        const len = 48 + (i % 4) * 20 + Math.sin(p.t * 30 + i) * 12;
        ctx.globalAlpha = 0.3 + (i % 3) * 0.16;
        ctx.strokeStyle = lineColors[i % lineColors.length];
        ctx.lineWidth = 1.5 + (i % 3) * 0.6;
        ctx.beginPath();
        ctx.moveTo(p.x - dir * (bw * 0.36 + 8), yy);
        ctx.lineTo(p.x - dir * (bw * 0.36 + len), yy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      if (BIKE_IMG) {
        ctx.imageSmoothingEnabled = true;
        for (let i = 2; i >= 1; i--) {
          ctx.save();
          ctx.globalAlpha = i === 2 ? 0.07 : 0.13;
          ctx.translate(p.x - dir * i * 28, p.y + bob);
          ctx.scale(-dir, 1);
          ctx.drawImage(BIKE_IMG, -bw / 2, -bh + 36, bw, bh);
          ctx.restore();
        }
        ctx.save();
        ctx.translate(p.x, p.y + bob);
        ctx.scale(-dir, 1);   // 图片车头朝左，翻转使其与飞行方向一致
        ctx.shadowColor = 'rgba(255,190,50,.85)';
        ctx.shadowBlur = 18;
        ctx.drawImage(BIKE_IMG, -bw / 2, -bh + 36, bw, bh);
        ctx.restore();
      } else {
        ctx.fillStyle = '#ffd100';
        ctx.fillRect(p.x - 52, p.y - 40, 104, 60);
      }
    } else if (p.type === 'milk') {
      // 野生狗奶：贴图本体高速旋转飞行，带残影拖尾
      const mw = 44, mh = MILK_IMG ? mw * (MILK_IMG.height / MILK_IMG.width) : 80;
      // 后方气流线
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = '#e8f2ff';
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 3; i++) {
        const yy = p.y - 22 + i * 22;
        ctx.beginPath();
        ctx.moveTo(p.x - dir * (mw * 0.5), yy);
        ctx.lineTo(p.x - dir * (mw * 0.5 + 26 + i * 8), yy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (MILK_IMG) {
        ctx.save();
        ctx.imageSmoothingEnabled = true;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot || 0);
        ctx.drawImage(MILK_IMG, -mw / 2, -mh / 2, mw, mh);
        ctx.restore();
      } else {
        ctx.fillStyle = '#cfe4ff';
        ctx.fillRect(p.x - 24, p.y - 34, 48, 68);
      }
    } else if (p.type === 'sonic') {
      const fade = Math.min(1, Math.max(0, p.life) * 3);
      // 后方音爆气流线
      ctx.globalAlpha = 0.4 * fade;
      ctx.strokeStyle = '#fff3cf';
      ctx.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        const yy = p.y - 26 + i * 10;
        ctx.beginPath();
        ctx.moveTo(p.x - dir * (28 + (i % 3) * 8), yy);
        ctx.lineTo(p.x - dir * (92 + (i % 3) * 26), yy);
        ctx.stroke();
      }
      // 音波核心
      const grd = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 34);
      grd.addColorStop(0, 'rgba(255,255,255,.98)');
      grd.addColorStop(0.42, p.color);
      grd.addColorStop(1, 'rgba(255,180,60,0)');
      ctx.globalAlpha = 0.95 * fade;
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 17, 33, 0, 0, Math.PI * 2);
      ctx.fill();
      // 三层声弧
      for (let i = 2; i >= 0; i--) {
        const r = 17 + i * 12 + Math.sin(p.t * 26 + i) * 2;
        ctx.globalAlpha = (0.9 - i * 0.24) * fade;
        ctx.strokeStyle = i === 0 ? '#ffffff' : p.color;
        ctx.lineWidth = 3.4 - i * 0.8;
        ctx.beginPath();
        const a0 = dir > 0 ? -1.15 : Math.PI - 1.15;
        const a1 = dir > 0 ? 1.15 : Math.PI + 1.15;
        ctx.arc(p.x - dir * i * 8, p.y, r, a0, a1);
        ctx.stroke();
      }
    } else {
      const r = p.radius;
      const grd = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, r);
      grd.addColorStop(0, '#ffffff');
      grd.addColorStop(0.35, p.color);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * 0.55 + Math.sin(p.t * 22) * 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------- HUD ---------- */
  updateHUD() {
    if (!this.p1 || !this.p2 || UI.current !== 'fight') return;
    const p1 = this.p1, p2 = this.p2;
    const r1 = Math.max(0, p1.hp / p1.maxHp), r2 = Math.max(0, p2.hp / p2.maxHp);

    this.lag1 += (r1 - this.lag1) * 0.08;
    this.lag2 += (r2 - this.lag2) * 0.08;

    $('p1-hp').style.width = (r1 * 100).toFixed(1) + '%';
    $('p2-hp').style.width = (r2 * 100).toFixed(1) + '%';
    $('p1-hp-lag').style.width = (this.lag1 * 100).toFixed(1) + '%';
    $('p2-hp-lag').style.width = (this.lag2 * 100).toFixed(1) + '%';

    $('p1-rage').style.width = p1.rage + '%';
    $('p2-rage').style.width = p2.rage + '%';
    $('p1-rage-num').textContent = Math.floor(p1.rage);
    $('p2-rage-num').textContent = Math.floor(p2.rage);
    $('p1-rage').parentElement.classList.toggle('ready', p1.rage >= 50);
    $('p2-rage').parentElement.classList.toggle('ready', p2.rage >= 50);

    const tn = $('timer-num');
    tn.textContent = this.gameMode === 'training' ? '∞' : String(Math.ceil(this.timeLeft)).padStart(2, '0');
    $('timer').classList.toggle('danger', this.gameMode !== 'training' && this.timeLeft <= 10);

    [['combo-p1', p1], ['combo-p2', p2]].forEach(([id, f]) => {
      const el = $(id);
      if (f.combo >= 2 && f.comboT > 0) {
        el.classList.add('on');
        el.innerHTML = `${f.combo}<i>HITS</i>`;
      } else {
        el.classList.remove('on');
      }
    });
  }
}

/* ---------------- 启动 ---------------- */
(async function boot() {
  try {
    await loadAll();
  } catch (e) {
    $('load-txt').textContent = '资源加载失败：' + e.message;
    console.error(e);
    return;
  }
  $('loading').style.opacity = '0';
  setTimeout(() => $('loading').classList.add('hidden'), 460);

  const game = new Game();
  window.GAME = game;
  UI.buildCards();
  UI.buildFoeStrip();
  UI.updateRecordLine();
  UI.show('title');

  const unlock = () => window.AUDIO.init();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  $('btn-arcade').addEventListener('click', () => { window.AUDIO.init(); window.AUDIO.select(); UI.enterSelect('arcade'); });
  $('btn-continue').addEventListener('click', () => {
    const run = window.GAME.run;
    if (!run) return;
    window.AUDIO.init(); window.AUDIO.select();
    window.GAME.startEndless(run.heroId, run.stageIndex, run.reviveUsed);
  });
  $('btn-training').addEventListener('click', () => { window.AUDIO.init(); window.AUDIO.select(); UI.enterSelect('training'); });
  $('btn-versus').addEventListener('click', () => { window.AUDIO.init(); window.AUDIO.select(); UI.enterSelect('versus'); });
  $('btn-moves').addEventListener('click', () => { $('screen-help').classList.remove('hidden'); window.AUDIO.init(); });
  $('btn-help-close').addEventListener('click', () => $('screen-help').classList.add('hidden'));
  $('btn-help').addEventListener('click', () => $('screen-help').classList.toggle('hidden'));
  $('btn-select-back').addEventListener('click', () => UI.show('title'));
  $('btn-fight').addEventListener('click', () => {
    if (UI.mode === 'arcade') game.startArcade(UI.selected);
    else if (UI.mode === 'training') game.startTraining(UI.selected, UI.cpu);
    else if (UI.mode === 'versus') game.startVersus(UI.selected, UI.cpu);
    else game.startFight(UI.selected, UI.cpu, 1);
  });
  ['btn-rematch', 'btn-select', 'btn-home'].forEach((id) => {
    $(id).addEventListener('click', () => game.onResultButton(id));
  });
  $('btn-resume').addEventListener('click', () => game.togglePause());
  $('btn-pause-restart').addEventListener('click', () => { game.paused = false; game.restartMatch(); });
  $('btn-pause-home').addEventListener('click', () => game.quitToTitle());
  $('btn-quit-save').addEventListener('click', () => { game.saveRun(); game.backToTitle(); });
  $('btn-quit-discard').addEventListener('click', () => { game.clearRun(); game.backToTitle(); });
  $('btn-quit-cancel').addEventListener('click', () => UI.show('pause'));
  $('btn-pause').addEventListener('click', () => game.togglePause());
  $('btn-mute').addEventListener('click', () => game.toggleMute());

  // 调试/演示直达：?screen=select 或 ?fight=1&p1=dog&p2=frost
  const q = new URLSearchParams(location.search);
  if (q.has('fight') || q.has('demo') || q.has('auto') || q.has('fast')) {
    const mode = q.get('mode') || 'quick';
    if (mode === 'training') game.startTraining(q.get('p1') || 'dog', q.get('p2') || 'frost');
    else if (mode === 'versus') game.startVersus(q.get('p1') || 'dog', q.get('p2') || 'frost');
    else game.startFight(q.get('p1') || 'dog', q.get('p2') || 'frost', 1);
    if (q.has('auto')) game.p1AI = new AI(game.p1, game, 1);
    // 调试：?map=0..3 指定场景
    if (q.has('map')) game.setStageId(parseInt(q.get('map'), 10) || 0);
    if (q.has('hp1')) game.p1.hp = parseInt(q.get('hp1'), 10) || 1;
    if (q.has('hp2')) game.p2.hp = parseInt(q.get('hp2'), 10) || 1;
    // 调试：?rage=100 直接给双方满怒气，方便演示/截图 U/I/O 技能
    if (q.has('rage')) {
      const r = Math.max(0, Math.min(100, parseInt(q.get('rage'), 10) || 0));
      game.p1.rage = r; game.p2.rage = r;
    }
    // 调试：?cast=1/2/3 让玩家1开场直接放一次技能（配合 fast/dump 截图）
    if (q.has('cast')) {
      game.p1.rage = 100;
      game.p1.castSkill(parseInt(q.get('cast'), 10) || 1, game.p2);
    }
    if (q.has('demo')) { game.demo = q.get('demo'); game.demoT = 1.5; }
    if (q.has('fast')) {
      const n = parseInt(q.get('fast'), 10) || 0;
      for (let i = 0; i < n; i++) game.step(1 / 60);
      if (q.has('dump')) {
        const f = (o) => o && { s: o.state, sk: o.skill && o.skill.id, ph: o.skill && o.skill.phase, x: Math.round(o.x), y: Math.round(o.y), hp: Math.round(o.hp), f: o.facing };
        document.title = 'D:' + JSON.stringify({ mode: game.mode, t: +game.timeLeft.toFixed(1), p1: f(game.p1), p2: f(game.p2), el: +game.elapsed.toFixed(2) });
      }
      game.paused = true;
      game.render(); game.updateHUD();
    }
  } else if (q.has('arcade')) {
    game.startArcade(q.get('p1') || 'dog');
    if (q.has('stage')) { game.stageIndex = Math.max(0, parseInt(q.get('stage'), 10) || 0); game.beginStage(); }
  } else if (q.has('endless')) {
    game.startEndless(q.get('p1') || 'dog');
    if (q.has('stage')) { game.stageIndex = Math.max(0, parseInt(q.get('stage'), 10) || 0); game.beginStage(); }
  } else if (q.get('screen') === 'select') UI.enterSelect(q.get('mode') || 'quick');
  else if (q.get('screen') === 'help') { UI.show('title'); $('screen-help').classList.remove('hidden'); }
})();
