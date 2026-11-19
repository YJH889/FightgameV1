/* ============================================================
   音频系统：真人语音采样 + WebAudio 合成音效
   ============================================================ */

class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.hopperGain = 0.7;   // 跳跳语音整体音量（0~1，越大越响）
    this.noise = null;
    this.failed = false;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.failed = true; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1.25;   // 整体音量调大
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -8;
    comp.knee.value = 8;
    comp.ratio.value = 5;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    this.noise = this.makeNoise();
    this.loadHopperVoice();
    this.loadFrostVoice();
    this.loadFrostAtk();
    this.loadFrostHurt();
    this.loadFrostIceSpike();
    this.loadFrostFireball();
    this.loadFrostClaw();
    this.loadNaiwaVoice();
    this.loadSpadeVoice();
    this.loadDogVoice();
    this.loadWhalieVoice();
    this.loadWhalieSong();
  }

  makeNoise() {
    const len = this.ctx.sampleRate * 1.2;
    const b = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  decode(ab) {
    // 兼容旧版 Safari 的回调式 decodeAudioData
    return new Promise((res, rej) => {
      const r = this.ctx.decodeAudioData(ab, res, rej);
      if (r && r.then) r.then(res).catch(rej);
    });
  }

  /* 去掉录音尾部的静音，让技能按真实人声长度对齐出手时机
     按 20ms 窗口能量判断，避免 MP3 解码尾音/单击干扰 */
  trimTail(buf, pad = 0.04) {
    if (!buf) return null;
    const sr = buf.sampleRate;
    const win = Math.max(1, Math.round(sr * 0.02));
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const len = chans[0].length;
    const rms = (i) => {
      let s = 0, n = 0;
      for (const ch of chans) {
        for (let j = 0; j < win && i + j < len; j++) { s += ch[i + j] * ch[i + j]; n++; }
      }
      return n ? Math.sqrt(s / n) : 0;
    };
    let peak = 0;
    for (let i = 0; i + win <= len; i += win) peak = Math.max(peak, rms(i));
    if (peak <= 0) return buf;
    const th = peak * 0.08;
    let last = 0;
    for (let i = 0; i + win <= len; i += win) if (rms(i) > th) last = i + win;
    if (!last) return buf;
    const end = Math.min(len, last + Math.round(sr * pad));
    if (end >= len) return buf;
    const out = this.ctx.createBuffer(buf.numberOfChannels, end, sr);
    chans.forEach((ch, c) => out.copyToChannel(ch.subarray(0, end), c));
    return out;
  }

  /* 霜龙火球：中文版「豪火球之术」 */
  fireVoice(rate = 1, vol = 1.3, delay = 0) {
    this.playSkillSample(this.frostFireBuf, rate, vol, delay);
  }

  /* 跳跳：攻击 / 受击 / 百万吨拳踢(U) / 神之一脚(I) / 胆子肥嘟嘟(O) */
  async loadHopperVoice() {
    const load = async (file) => {
      try {
        const res = await fetch(characterAsset('hopper', 'audio', file));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await this.decode(await res.arrayBuffer());
      } catch (e) {
        console.warn('跳跳音效加载失败：' + file, e);
        return null;
      }
    };
    const [atk, hurt, l, ul, s3] = await Promise.all([
      load('hopper_atk.mp3'), load('hopper_hurt.mp3'),
      load('hopper_l.mp3'), load('hopper_ul.mp3'), load('hopper_s3.mp3')
    ]);
    this.hopperAtkBuf = atk;
    this.hopperHurtBuf = hurt;
    this.hopperLBuf = l;
    this.hopperULBuf = ul;
    this.hopperS3Buf = s3;
  }

  /* 大狗：三条用户提供的真人配音 —— 攻击 / 受击 / 技能大狗叫 */
  async loadDogVoice() {
    const load = async (file) => {
      try {
        const res = await fetch(characterAsset('dog', 'audio', file));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await this.decode(await res.arrayBuffer());
      } catch (e) {
        console.warn('大狗音效加载失败：' + file, e);
        return null;
      }
    };
    const [atk, hurt, bark, milk] = await Promise.all([
      load('dog_atk.mp3'), load('dog_hurt.mp3'), load('dog_bark.mp3'), load('dog_milk.mp3')
    ]);
    this.dogAtkBuf = atk;
    this.dogHurtBuf = hurt;
    this.dogBarkBuf = bark;
    // 拿到大狗叫时长，供技能无敌帧/特齐对齐
    this.dogBarkLen = bark ? bark.duration : 0;
    // 新录音「野生狗奶」尾部有约 1 秒静音，裁掉后人声约 0.78s
    this.dogMilkBuf = this.trimTail(milk);
    this.dogMilkLen = this.dogMilkBuf ? this.dogMilkBuf.duration : 0;
  }

  /* 大狗 · 野生狗奶台词（起手喊，喊完把奶丢出去） */
  dogMilkVoice() {
    if (!this.on) return;
    if (this.dogMilkBuf) this.playSkillSample(this.dogMilkBuf, 1, 1.0);
  }

  /* 小鲸：用户真人配音 —— 攻击 / 受击 / 大米饭(U) / 水弹术(I) / 啦啦啦(O 演唱) */
  async loadWhalieVoice() {
    const load = async (file) => {
      try {
        const res = await fetch(characterAsset('whalie', 'audio', file));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await this.decode(await res.arrayBuffer());
      } catch (e) {
        console.warn('小鲸音效加载失败：' + file, e);
        return null;
      }
    };
    const [atk, hurt, spray, rice, lala] = await Promise.all([
      load('whalie_atk.mp3'), load('whalie_hurt.mp3'),
      load('whalie_spray.mp3'), load('whalie_rice.mp3'), load('whalie_lala.mp3')
    ]);
    this.whalieAtkBuf = atk;
    this.whalieHurtBuf = hurt;
    this.whalieSprayBuf = spray;
    this.whalieRiceBuf = rice;
    this.whalieLalaBuf = lala;
    this.whalieSprayLen = spray ? spray.duration : 0;
    this.whalieRiceLen = rice ? rice.duration : 0;
    this.whalieLalaLen = lala ? lala.duration : 0;
  }

  /* 小鲸 · 鲸歌台词（「必杀，鲸歌咏叹调」） */
  async loadWhalieSong() {
    try {
      const res = await fetch(characterAsset('whalie', 'audio', 'whalie_song.mp3'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.whalieSongBuf = await this.decode(await res.arrayBuffer());
      this.whalieSongLen = this.whalieSongBuf.duration;
    } catch (e) {
      console.warn('鲸歌台词加载失败，暂用大招配音', e);
      this.whalieSongBuf = null;
    }
  }

  /* 小鲸人声：atk 出拳/踢腿；hurt/ko 受击；L 大米饭；UL 水弹术 */
  whalieSay(kind = 'atk', delay = 0) {
    if (!this.on) return;
    if (kind === 'L') {
      if (this.whalieRiceBuf) this.playSkillSample(this.whalieRiceBuf, 1, 0.95, delay);
      return;
    }
    if (kind === 'UL') {
      if (this.whalieSprayBuf) this.playSkillSample(this.whalieSprayBuf, 1, 1.0, delay);
      return;
    }
    if (kind === 'S3') {
      // 鲸歌台词；音频缺失时退回水弹术配音
      if (this.whalieSongBuf) this.playSkillSample(this.whalieSongBuf, 1, 1.05, delay);
      else if (this.whalieSprayBuf) this.playSkillSample(this.whalieSprayBuf, 1, 1.0, delay);
      return;
    }
    if (kind === 'hurt') {
      if (this.whalieHurtBuf) this.playSample(this.whalieHurtBuf, 1, 0.6, delay);
      return;
    }
    if (kind === 'ko') {
      if (this.whalieHurtBuf) this.playSample(this.whalieHurtBuf, 0.85, 0.65, delay);
      return;
    }
    // atk / hit / kick 都走攻击音，靠音高区分
    if (this.whalieAtkBuf) {
      const rate = kind === 'hit' ? 1.15 : kind === 'kick' ? 0.9 : 1.0;
      const vol = kind === 'kick' ? 0.68 : 0.55;
      this.playSample(this.whalieAtkBuf, rate, vol, delay);
    }
  }

  /* 大狗人声：atk 出拳/踢腿（音高区分）；hurt/ko 受击 */
  dogSay(kind = 'atk', delay = 0) {
    if (!this.on) return;
    if (kind === 'hurt') {
      if (this.dogHurtBuf) this.playSample(this.dogHurtBuf, 1, 0.6, delay);
      return;
    }
    if (kind === 'ko') {
      if (this.dogHurtBuf) this.playSample(this.dogHurtBuf, 0.82, 0.65, delay);
      return;
    }
    // atk / hit / kick 都走攻击音，靠音高区分
    if (this.dogAtkBuf) {
      const rate = kind === 'hit' ? 1.15 : kind === 'kick' ? 0.9 : 1.0;
      const vol = kind === 'kick' ? 0.65 : 0.55;
      this.playSample(this.dogAtkBuf, rate, vol, delay);
    }
  }

  /* 掐掉音频首尾的静音，喊完立刻能接下一步 */
  voiceSpan(buf) {
    const ch = buf.getChannelData(0);
    const step = 256;
    const loud = (i) => {
      let sum = 0;
      for (let k = 0; k < step; k++) { const v = ch[i + k] || 0; sum += v * v; }
      return Math.sqrt(sum / step) > 0.012;
    };
    let s = 0, e = ch.length;
    for (let i = 0; i < ch.length; i += step) { if (loud(i)) { s = i; break; } }
    for (let i = ch.length - step; i >= 0; i -= step) { if (loud(i)) { e = Math.min(ch.length, i + step); break; } }
    return {
      start: Math.max(0, s / buf.sampleRate - 0.03),
      end: Math.min(buf.duration, e / buf.sampleRate + 0.05)
    };
  }

  get hopperVoiceLen() {
    if (this.hopperS3Buf) return this.hopperS3Buf.duration;
    if (this.hopperULBuf) return this.hopperULBuf.duration;
    if (this.hopperBuf) {
      const t = this.hopperTrim;
      return t ? t.end - t.start : this.hopperBuf.duration;
    }
    return 0;
  }

  /* 霜龙：整段换成用户提供的真人语音，原速原调（火球喊招仍用日语原声） */
  async loadFrostVoice() {
    try {
      const res = await fetch(characterAsset('frost', 'audio', 'frost_voice.mp3'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.frostBuf = await this.decode(await res.arrayBuffer());
      this.frostTrim = this.voiceSpan(this.frostBuf);
      this.frostGrunts = this.loudestSpots(this.frostBuf, 8);
    } catch (e) {
      console.warn('霜龙语音加载失败，使用原配音', e);
      this.frostBuf = null;
      this.frostTrim = null;
      this.frostGrunts = null;
    }
  }

  /* 霜龙 · 攻击音效 */
  async loadFrostAtk() {
    try {
      const res = await fetch(characterAsset('frost', 'audio', 'frost_atk.mp3'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.frostAtkBuf = await this.decode(await res.arrayBuffer());
      this.frostAtkTrim = this.voiceSpan(this.frostAtkBuf);
    } catch (e) {
      console.warn('霜龙攻击音效加载失败', e);
      this.frostAtkBuf = null;
    }
  }

  /* 霜龙 · 受击音效 */
  async loadFrostHurt() {
    try {
      const res = await fetch(characterAsset('frost', 'audio', 'frost_hurt.mp3'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.frostHurtBuf = await this.decode(await res.arrayBuffer());
      this.frostHurtTrim = this.voiceSpan(this.frostHurtBuf);
    } catch (e) {
      console.warn('霜龙受击音效加载失败', e);
      this.frostHurtBuf = null;
    }
  }

  /* 霜龙 · 冰晶穿刺 */
  async loadFrostIceSpike() {
    try {
      const res = await fetch(characterAsset('frost', 'audio', 'frost_icespike.mp3'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.frostIceBuf = await this.decode(await res.arrayBuffer());
    } catch (e) {
      console.warn('霜龙冰晶穿刺音效加载失败', e);
      this.frostIceBuf = null;
    }
  }

  /* 霜龙 · 豪火球之术（中文版） */
  async loadFrostFireball() {
    try {
      const res = await fetch(characterAsset('frost', 'audio', 'frost_fireball.mp3'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.frostFireBuf = await this.decode(await res.arrayBuffer());
    } catch (e) {
      console.warn('霜龙豪火球之术音效加载失败', e);
      this.frostFireBuf = null;
    }
  }

  /* 霜龙 · 龙爪手 */
  async loadFrostClaw() {
    try {
      const res = await fetch(characterAsset('frost', 'audio', 'frost_claw.mp3'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      this.frostClawBuf = await this.decode(await res.arrayBuffer());
      // 「秘技……龙爪手」中间有换气停顿，先找出来，出手时好分两段喊
      this.frostClawSplit = this.splitVoice(this.frostClawBuf);
    } catch (e) {
      console.warn('霜龙龙爪手音效加载失败', e);
      this.frostClawBuf = null;
      this.frostClawSplit = null;
    }
  }

  /* 在整段语音的中段找最安静的一处（换气口），返回去掉首尾静音后的区间和切点 */
  splitVoice(buf) {
    const span = this.voiceSpan(buf);
    const ch = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const step = Math.max(64, Math.floor(sr * 0.02));
    const a = Math.floor(span.start * sr), b = Math.floor(span.end * sr);
    const n = Math.max(1, Math.floor((b - a) / step));
    const rms = [];
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const o = a + i * step;
      for (let k = 0; k < step; k++) { const v = ch[o + k] || 0; sum += v * v; }
      rms.push(Math.sqrt(sum / step));
    }
    const i0 = Math.floor(n * 0.25), i1 = Math.max(i0 + 1, Math.ceil(n * 0.75));
    let best = i0, bestV = Infinity;
    for (let i = i0; i < i1; i++) if (rms[i] < bestV) { bestV = rms[i]; best = i; }
    return Object.assign({}, span, { split: span.start + (best + 1) * step / sr });
  }

  /* 龙爪手台词拆两段：part 1 =「秘技」（蓄力时喊），part 2 =「龙爪手」（爪子拍出时喊） */
  clawVoice(part = 1, delay = 0) {
    const buf = this.frostClawBuf;
    if (!this.on || !buf) return;
    const s = this.frostClawSplit || { start: 0, end: buf.duration, split: buf.duration / 2 };
    if (part === 2) {
      this.playSkillSample(buf, 1, 1.25, delay, s.split, Math.max(0.1, s.end - s.split));
    } else {
      this.playSkillSample(buf, 1, 1.2, delay, s.start, Math.max(0.1, s.split - s.start));
    }
  }

  /* 奶娃 · 通用攻击 / 受击 / 宇宙无敌大力拳 / 捧腹大笑 */
  async loadNaiwaVoice() {
    const load = async (file) => {
      try {
        const res = await fetch(characterAsset('naiwa', 'audio', file));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await this.decode(await res.arrayBuffer());
      } catch (e) {
        console.warn('奶娃音效加载失败：' + file, e);
        return null;
      }
    };
    const [atk, hurt, punch, laugh, slam] = await Promise.all([
      load('naiwa_atk.mp3'), load('naiwa_hurt.mp3'),
      load('naiwa_punch.mp3'), load('naiwa_laugh.mp3'), load('naiwa_slam.mp3')
    ]);
    this.naiwaAtkBuf = atk;
    this.naiwaHurtBuf = hurt;
    this.naiwaPunchBuf = punch;
    this.naiwaLaughBuf = laugh;
    this.naiwaSlamBuf = slam;
  }

  /* 黑桃：攻击 / 受击 / 黑桃乱舞(U) / 过肩摔(I) / 抱歉(O) */
  async loadSpadeVoice() {
    const load = async (file) => {
      try {
        const res = await fetch(characterAsset('spade', 'audio', file));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await this.decode(await res.arrayBuffer());
      } catch (e) {
        console.warn('黑桃音效加载失败：' + file, e);
        return null;
      }
    };
    const [atk, hurt, rush, thr, sorry] = await Promise.all([
      load('spade_atk.mp3'), load('spade_hurt.mp3'),
      load('spade_rush.mp3'), load('spade_throw.mp3'), load('spade_sorry.mp3')
    ]);
    this.spadeAtkBuf = atk;
    this.spadeHurtBuf = hurt;
    this.spadeRushBuf = rush;
    this.spadeThrowBuf = thr;
    this.spadeSorryBuf = sorry;
    this.spadeSorryLen = sorry ? sorry.duration : 0;
  }

  spadeSay(kind = 'atk') {
    if (!this.on) return;
    if (kind === 'L') {
      if (this.spadeRushBuf) this.playSkillSample(this.spadeRushBuf, 1, 1.05);
      return;
    }
    if (kind === 'UL') {
      if (this.spadeThrowBuf) this.playSkillSample(this.spadeThrowBuf, 1, 1.05);
      return;
    }
    if (kind === 'S3') {
      if (this.spadeSorryBuf) this.playSkillSample(this.spadeSorryBuf, 1, 1.05);
      return;
    }
    if (kind === 'hurt') {
      if (this.spadeHurtBuf) this.playSample(this.spadeHurtBuf, 1, 0.58);
      return;
    }
    if (kind === 'ko') {
      if (this.spadeHurtBuf) this.playSample(this.spadeHurtBuf, 0.9, 0.62);
      return;
    }
    if (this.spadeAtkBuf) this.playSample(this.spadeAtkBuf, 1, 0.55);
  }

  /* 奶娃四种喊声：atk 出招 / hurt 受击 / L 大力拳 / UL 捧腹大笑
     奶娃声音整体压低，避免盖过其他角色 */
  naiwaSay(kind = 'atk') {
    if (!this.on) return;
    if (kind === 'L') {
      if (this.naiwaPunchBuf) this.playSkillSample(this.naiwaPunchBuf, 1, 0.62);
      return;
    }
    // 暴砸：跃起瞬间喊
    if (kind === 'S2') {
      if (this.naiwaSlamBuf) this.playSkillSample(this.naiwaSlamBuf, 1, 0.72);
      return;
    }
    if (kind === 'UL') {
      if (this.naiwaLaughBuf) this.playSkillSample(this.naiwaLaughBuf, 1, 0.62);
      return;
    }
    // 「猴啦」一条音频同时用于挥拳 / 踢腿 / 受击，靠音高和音量区分
    if (kind === 'hurt') {
      if (this.naiwaHurtBuf) this.playSample(this.naiwaHurtBuf, 1.06, 0.4);
      return;
    }
    if (kind === 'ko') {
      if (this.naiwaHurtBuf) this.playSample(this.naiwaHurtBuf, 0.88, 0.45);
      return;
    }
    if (this.naiwaAtkBuf) {
      const rate = kind === 'hit' ? 1.14 : kind === 'kick' ? 0.9 : 1.0;
      const vol = kind === 'kick' ? 0.34 : 0.38;
      this.playSample(this.naiwaAtkBuf, rate, vol);
    }
  }

  /* 找出录音里最响的几处（大概率是张嘴的元音），用来做「哈／啊／呃」这种语气词
     整句台词只留给技能喊招，普攻/受击绝不整句朗诵 */
  loudestSpots(buf, count = 8) {
    const ch = buf.getChannelData(0);
    const win = Math.round(buf.sampleRate * 0.06);
    const hop = Math.round(buf.sampleRate * 0.03);
    const env = [];
    for (let i = 0; i + win < ch.length; i += hop) {
      let sum = 0;
      for (let k = 0; k < win; k++) sum += ch[i + k] * ch[i + k];
      env.push({ t: i / buf.sampleRate, r: Math.sqrt(sum / win) });
    }
    env.sort((a, b) => b.r - a.r);
    const out = [];
    for (const e of env) {
      if (e.t < 0.2) continue;
      if (out.some((o) => Math.abs(o - e.t) < 0.22)) continue;
      out.push(Math.max(0, e.t - 0.03));
      if (out.length >= count) break;
    }
    return out;
  }

  /* 短促的真人切片 + 快速包络 + 高通：听感是清脆的「哈／呃／啊」而不是半句台词 */
  playSnippet(buf, offset, dur, vol = 0.8, rate = 1, hp = 0) {
    if (!this.on || !buf) return;
    const t0 = this.ctx.currentTime;
    const level = vol * (this._cryScale || 1);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(level, t0 + 0.008);
    g.gain.setValueAtTime(level, t0 + Math.max(0.02, dur - 0.03));
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    let node = src;
    if (hp > 0) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = hp;
      f.Q.value = 0.7;
      src.connect(f);
      node = f;
    }
    node.connect(g); g.connect(this.master);
    src.start(t0, offset, dur + 0.02);
  }

  /* 普攻/踢腿/受击/倒地/技能喊招：分别使用对应的专用音频（冷却由 cry() 统一处理）
     龙娘声音整体提亮一档，比默认更突出 */
  frostSay(kind = 'atk') {
    if (!this.on) return;

    // 技能喊招
    if (kind === 'L') {
      if (this.frostIceBuf) { this.playSkillSample(this.frostIceBuf, 1, 1.2); return; }
      if (this.frostBuf) { const t = this.frostTrim || { start: 0, end: this.frostBuf.duration }; this.playSkillSample(this.frostBuf, 1, 1.2, 0, t.start, 0); }
      return;
    }
    if (kind === 'UL') {
      this.fireVoice();
      return;
    }
    // 技能2 龙爪手：独立喊招音频，蓄力时先喊「秘技」
    if (kind === 'S2') {
      if (this.frostClawBuf) { this.clawVoice(1); return; }
      if (this.frostIceBuf) { this.playSkillSample(this.frostIceBuf, 1, 1.2); return; }
      return;
    }

    if (kind === 'hurt' || kind === 'ko') {
      if (this.frostHurtBuf) {
        const rate = kind === 'ko' ? 0.92 : 1;
        const vol = kind === 'ko' ? 1.2 : 1.15;
        this.playSample(this.frostHurtBuf, rate, vol);
        return;
      }
    }

    // 挥拳 / 踢腿
    if (kind === 'atk') {
      if (this.frostAtkBuf) { this.playSample(this.frostAtkBuf, 1, 1.15); return; }
    }

    // 回退到旧逻辑（使用整段语音切片）
    if (!this.frostBuf) return;
    const t = this.frostTrim || { start: 0, end: this.frostBuf.duration };
    const pts = (this.frostGrunts && this.frostGrunts.length) ? this.frostGrunts : [t.start + 0.2];
    const pick = () => pts[(Math.random() * pts.length) | 0];

    if (kind === 'ko') {
      this.playSnippet(this.frostBuf, pick(), 0.34, 1.2, 0.98 + Math.random() * 0.06, 620);
      return;
    }
    if (kind === 'hurt') {
      this.playSnippet(this.frostBuf, pick(), 0.1, 1.15, 1.12 + Math.random() * 0.12, 780);
      return;
    }
    this.playSnippet(this.frostBuf, pick(), 0.075, 1.1, 1.22 + Math.random() * 0.2, 950);
  }

  /* 跳跳：atk 出拳/命中/踢飞 复用攻击音（音高区分）；hurt/ko 用受击音；
     L 百万吨拳踢、UL 神之一脚、S3 胆子肥嘟嘟各自使用专属语音 */
  hopperSay(kind = 'atk', delay = 0) {
    if (!this.on) return;

    if (kind === 'L') {
      if (this.hopperLBuf) this.playSkillSample(this.hopperLBuf, 1, 1.0 * this.hopperGain, delay);
      return;
    }
    if (kind === 'UL') {
      if (this.hopperULBuf) this.playSkillSample(this.hopperULBuf, 1, 1.05 * this.hopperGain, delay);
      return;
    }
    if (kind === 'S3') {
      if (this.hopperS3Buf) this.playSkillSample(this.hopperS3Buf, 1, 1.05 * this.hopperGain, delay);
      return;
    }
    if (kind === 'hurt') {
      if (this.hopperHurtBuf) this.playSample(this.hopperHurtBuf, 1, 0.62 * this.hopperGain, delay);
      return;
    }
    if (kind === 'ko') {
      if (this.hopperHurtBuf) this.playSample(this.hopperHurtBuf, 0.82, 0.68 * this.hopperGain, delay);
      return;
    }
    // atk / hit / kick 都走攻击音，靠音高区分：hit 最亮、kick 最低沉
    if (this.hopperAtkBuf) {
      const rate = kind === 'hit' ? 1.18 : kind === 'kick' ? 0.88 : 1.0;
      const vol = (kind === 'kick' ? 0.68 : 0.55) * this.hopperGain;
      this.playSample(this.hopperAtkBuf, rate, vol, delay);
    }
  }

  /* 技能台词独占一小段清晰窗口：其他喊声暂停，合成音效自动降低 */
  playSkillSample(buf, rate = 1, vol = 0.85, delay = 0, offset = 0, dur = 0) {
    if (!this.on || !buf) return;
    const length = (dur > 0 ? dur : Math.max(0, buf.duration - offset)) / rate;
    this.duckUntil = Math.max(this.duckUntil || 0, this.ctx.currentTime + delay + length + 0.12);
    this.playSample(buf, rate, vol, delay, offset, dur);
  }

  playSample(buf, rate = 1, vol = 0.85, delay = 0, offset = 0, dur = 0) {
    if (!this.on || !buf) return;
    const t0 = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = vol * (this._cryScale || 1);
    src.connect(g); g.connect(this.master);
    if (dur > 0) src.start(t0, offset, dur);
    else src.start(t0, offset);
  }

  /* 鲸歌开嗓「啦啦啦」：对着麦克风唱出音波 */
  whalieLala(delay = 0) {
    if (!this.on) return;
    if (this.whalieLalaBuf) this.playSkillSample(this.whalieLalaBuf, 1, 0.95, delay);
  }

  /* 水弹术台词 */
  waterVoice(rate = 1, vol = 1, delay = 0) {
    if (this.whalieSprayBuf) this.playSkillSample(this.whalieSprayBuf, 1, 1.0, delay);
  }

  /* 角色短喊声：atk 出招 / hurt 受击 / ko 倒地 / L、UL 技能喊招 */
  cry(id, kind = 'atk') {
    if (!this.on) return;
    const now = this.ctx.currentTime;
    // 技能窗口由 playSkillSample() 按实际台词长度设置，期间屏蔽其他喊声
    const isSkill = (kind === 'L' || kind === 'UL' || kind === 'S2' || kind === 'S3');
    const isAttack = (kind === 'atk' || kind === 'hit' || kind === 'kick');
    if (!isSkill && now < (this.duckUntil || 0)) return;
    const gap = isSkill ? 0 : isAttack ? 0.34 : kind === 'hurt' ? 0.46 : 0.9;
    const cd = this.cryCd || (this.cryCd = {});
    const key = id + ':' + (isAttack ? 'atk' : kind);
    if (now - (cd[key] || -99) < gap) return;
    if (!isSkill && kind !== 'ko' && Math.random() < (isAttack ? 0.4 : 0.15)) return;
    cd[key] = now;
    this._cryScale = isSkill ? 1 : 0.78;   // 普攻/受击音量再降，技能台词保持原样
    try {
      if (id === 'hopper') { this.hopperSay(kind); return; }
      if (id === 'dog') { this.dogSay(kind); return; }
      if (id === 'naiwa' && (this.naiwaAtkBuf || this.naiwaHurtBuf || this.naiwaPunchBuf || this.naiwaLaughBuf || this.naiwaSlamBuf)) { this.naiwaSay(kind); return; }
      if (id === 'frost' && (this.frostBuf || this.frostAtkBuf || this.frostHurtBuf || this.frostIceBuf || this.frostFireBuf || this.frostClawBuf)) { this.frostSay(kind); return; }
      if (id === 'spade' && (this.spadeAtkBuf || this.spadeHurtBuf || this.spadeRushBuf || this.spadeThrowBuf || this.spadeSorryBuf)) { this.spadeSay(kind); return; }
      if (id === 'whalie' && (this.whalieAtkBuf || this.whalieHurtBuf || this.whalieRiceBuf || this.whalieSprayBuf || this.whalieSongBuf)) { this.whalieSay(kind); return; }
    } finally {
      this._cryScale = 1;
    }
  }

  /* 三碗大米饭：日语「ご飯三杯！」 */
  riceVoice(delay = 0) {
    if (this.whalieRiceBuf) this.playSkillSample(this.whalieRiceBuf, 1, 0.95, delay);
  }

  get on() { return this.ctx && !this.muted; }

  /* 大狗叫声：rate 控制音高（咬 1.25 / 咆哮 1.0 / 低吼 0.72） */
  bark(rate = 1, vol = 0.9, delay = 0) {
    if (!this.on) return;
    const buf = this.dogBarkBuf;
    if (buf) {
      const t0 = this.ctx.currentTime + delay;
      this.duckUntil = Math.max(this.duckUntil || 0, t0 + buf.duration / rate + 0.12);
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = this.ctx.createGain();
      g.gain.value = vol;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 9000;
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start(t0);
    } else {
      this.synthBark(rate, vol, delay);
    }
  }

  synthBark(rate, vol, delay) {
    const t = this.ctx.currentTime + delay;
    for (let i = 0; i < 2; i++) {
      const s = this.ctx.createBufferSource();
      s.buffer = this.noise;
      s.playbackRate.value = 1.4 * rate;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(700 * rate, t + i * 0.07);
      bp.frequency.exponentialRampToValueAtTime(360 * rate, t + i * 0.07 + 0.1);
      bp.Q.value = 3;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.07);
      g.gain.exponentialRampToValueAtTime(this.sfxVolume(vol * 0.5, delay + i * 0.07), t + i * 0.07 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.07 + 0.12);
      s.connect(bp); bp.connect(g); g.connect(this.master);
      s.start(t + i * 0.07, 0, 0.16);
    }
  }

  sfxVolume(vol, delay = 0) {
    const duck = this.ctx.currentTime + delay < (this.duckUntil || 0) ? 0.38 : 1;
    return vol * 0.64 * duck;
  }

  tone(freq, dur, type = 'sine', vol = 0.2, slideTo = null, delay = 0) {
    if (!this.on) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(this.sfxVolume(vol, delay), t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  hitNoise(dur, freq, q, vol, type = 'lowpass', delay = 0) {
    if (!this.on) return;
    const t = this.ctx.currentTime + delay;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(this.sfxVolume(vol, delay), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master);
    s.start(t, Math.random() * 0.3, dur + 0.02);
  }

  punch() { this.tone(150, 0.1, 'sine', 0.19, 60); this.hitNoise(0.09, 1100, 1, 0.17); }
  kick() { this.tone(110, 0.16, 'triangle', 0.23, 45); this.hitNoise(0.14, 800, 0.8, 0.2); }
  heavy() { this.tone(95, 0.28, 'sine', 0.27, 32); this.hitNoise(0.26, 620, 0.7, 0.23); }
  block() { this.tone(1500, 0.06, 'square', 0.08, 900); this.hitNoise(0.09, 2600, 2, 0.13, 'highpass'); }
  whiff() { this.hitNoise(0.14, 2400, 0.6, 0.1, 'bandpass'); }
  jump() { this.tone(320, 0.1, 'square', 0.07, 620); }
  land() { this.tone(90, 0.12, 'sine', 0.16, 50); this.hitNoise(0.1, 500, 0.7, 0.12); }
  dodge() { this.tone(880, 0.2, 'sine', 0.12, 1800); this.hitNoise(0.3, 3200, 0.8, 0.09, 'highpass'); }
  charge() { this.tone(70, 0.5, 'sawtooth', 0.12, 260); this.tone(140, 0.5, 'sine', 0.08, 520); }
  boom() { this.tone(70, 0.5, 'sine', 0.4, 26); this.hitNoise(0.5, 400, 0.6, 0.34); }
  ko() { this.tone(400, 0.7, 'sawtooth', 0.22, 50); this.hitNoise(0.8, 900, 0.5, 0.2); }
  ui() { this.tone(660, 0.06, 'square', 0.06); }
  select() { this.tone(520, 0.08, 'square', 0.07); this.tone(780, 0.1, 'square', 0.06, null, 0.07); }
  ready() { this.tone(880, 0.1, 'triangle', 0.12); this.tone(1320, 0.16, 'triangle', 0.1, null, 0.09); }

  /* 角色专属打击音：在通用拳脚声上按角色叠加音色层，打起来能听出是谁 */
  charHit(id, kind = 'punch', power = 1) {
    if (!this.on) return;
    const now = this.ctx.currentTime;
    if (now - (this.lastHitAt || -99) < 0.13) return;   // 多段命中不逐帧叠音
    this.lastHitAt = now;
    if (kind === 'heavy') this.heavy();
    else if (kind === 'kick') this.kick();
    else this.punch();
    const v = 0.29 + 0.24 * Math.min(power, 1.5);
    const p = (Math.random() - 0.5) * 0.08;   // 轻微音高随机，避免机械重复
    switch (id) {
      case 'whalie':   // 小鲸：水团闷响 + 水花四溅
        this.tone(240, 0.11, 'sine', 0.26 * v, 85);
        this.hitNoise(0.18, 1700 * (1 + p), 0.8, 0.2 * v, 'bandpass');
        this.hitNoise(0.1, 4200, 1.2, 0.09 * v, 'highpass', 0.02);
        break;
      case 'frost':    // 霜龙：冰晶清脆叮当
        this.tone(2400 * (1 + p), 0.08, 'triangle', 0.1 * v);
        this.tone(3300, 0.13, 'triangle', 0.07 * v, 2600, 0.05);
        this.hitNoise(0.1, 5200, 1.4, 0.08 * v, 'highpass');
        break;
      case 'hopper':   // 跳跳：弹簧先压后弹
        this.tone(300, 0.15, 'triangle', 0.15 * v, 720);
        this.hitNoise(0.07, 2000 * (1 + p), 1.2, 0.1 * v, 'bandpass');
        break;
      case 'naiwa':    // 奶娃：肉弹闷响
        this.tone(82, 0.2, 'sine', 0.26 * v, 42);
        this.hitNoise(0.18, 430, 0.6, 0.16 * v, 'lowpass');
        break;
      case 'spade':    // 黑桃：短打脆响
        this.hitNoise(0.06, 2900 * (1 + p), 1.6, 0.14 * v, 'bandpass');
        this.tone(720, 0.05, 'square', 0.05 * v);
        break;
    }
  }
}

window.AUDIO = new GameAudio();
