/* ============================================================
   Fighter：角色状态机 / 招式判定 / 绘制
   ============================================================ */

const GRAVITY = 1650;

const C01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const SM = (v) => { v = C01(v); return v * v * (3 - 2 * v); };

/* 姿势贴图的锚点表（python tools/build_poses.py 自动生成 → js/pose-data.js）
   ax/ay：脚底中心在贴图中的相对位置；flip：原画朝向（+1 朝右，-1 朝左） */
const POSE_META = window.POSE_META || {};
/* 贴图归一化身高：两个角色不同分辨率的设定图统一到同一视觉身高 */
const POSE_BODY_H = 180;
/* 没有对应姿势时退回到哪一张 */
const POSE_FALLBACK = { dog: 'idle', whalie: 'idle' };

/* 被举过头顶时绕身体中段旋转的支点高度（世界像素），和 drawPoseSprite 保持一致 */
function liftPivot(f) { return POSE_BODY_H * 0.44 * (f.def.scale || 1); }

class Fighter {
  constructor(def, side, game) {
    this.def = def;
    this.side = side;
    this.game = game;
    this.sp = null;
    this.reset(side === 'p1' ? 260 : 540);
  }

  reset(x) {
    this.x = x;
    this.y = VIEW.GROUND;
    this.vx = 0; this.vy = 0;
    this.facing = this.side === 'p1' ? 1 : -1;
    this.maxHp = this.def.hp;
    this.hp = this.maxHp;
    this.rage = 0;
    this.state = 'idle';
    this.stateT = 0;
    this.t = Math.random() * 5;
    this.moveId = null; this.moveT = 0; this.moveHits = 0;
    this.skill = null;
    this.hitstun = 0; this.blockstun = 0;
    this.invuln = 0; this.flash = 0;
    this.combo = 0; this.comboT = 0;
    this.grounded = true;
    this.airAttacked = false;
    this.airLock = 0;
    this.prone = false;
    this.liftRot = 0; this.liftUp = 0;   // 被举过头顶时的横躺角度与旋转支点
    this.grabT = 0;
    this.ghostT = 0;
    this.lean = 0;
    this.blocking = false;
    this.dodgeT = 0;
    this.dead = false;
    this.knockTimer = 0;
    this.pendingSkill = null;
    /* BVN 连段引擎字段 */
    this.dashT = 0; this.dashDir = 1; this.dashCd = 0;   // 疾步（双击方向）
    this.dodgeCd = 0;                                    // 闪避内置锁定（防同帧重复触发）
    this.dodgePhantom = false;                           // 本次闪避是否为幻影闪避
    this.dodgeAir = false;                               // 本次是否为空中闪避
    this.airDodged = false;                              // 本次滞空是否已用过空中闪避
    this.dodgeCharges = 2;                               // 闪避次数（上限 2）
    this.dodgeChargeCd = 0;                              // 闪避次数恢复计时（每 2 秒回 1 次）
    this.tapT = { '-1': -9, '1': -9 };                   // 上次单击方向的时间
    this.prevL = false; this.prevR = false;
    this.juggle = 0;                                     // 浮空中被追击的次数
    this.escapeCd = 0;                                   // 幻影闪避脱身冷却
    this.lockT = 0;                                      // 被锁定（黑桃「抱歉」等）：期间无法移动，但可用幻影闪避脱身
    this.lockedTarget = null;                            // 「抱歉」锁定的对手，技能被打断时要解除
    this.ghostTick = 0;
    this.bufPunch = 0; this.bufKick = 0; this.bufJump = 0;
    this.bufS1 = 0; this.bufS2 = 0; this.bufS3 = 0;
    this.s1Cd = 0;                                       // 技能1（U）冷却（放完后 1 秒）
    this.s1Active = false;                               // 当前是否正在释放技能1（用于结束时触发冷却）
    this.castNo = 0;                                     // 当前释放的技能编号（0 = 普攻），用于怒气结算
    this.rageHitUsed = 0;                                // 已结算过命中怒气的技能编号（I/O 每个技能只结算一次）
    this.recoveryT = 0;                                  // 必杀 O 收招后摇（期间可被打、不能行动）
  }

  get color() { return this.def.color; }
  get elem() { return this.def.elem; }

  gainRage(n) {
    this.rage = Math.min(MAX_RAGE, this.rage + n);
  }

  /* 命中怒气结算：普攻每次结算；U 每段结算；I / O 每个技能只结算一次 */
  payHitRage(opp, no = this.castNo) {
    const sr = skillRage(no);
    if (!sr) { this.gainRage(RAGE.hit); opp.gainRage(RAGE.hurt); return; }
    if (no !== 1) {
      if (this.rageHitUsed === no) return;   // 同一发 I / O 的多段伤害不再重复给
      this.rageHitUsed = no;
    }
    this.gainRage(sr.hit);
    opp.gainRage(sr.taken);
  }

  canAct() {
    return this.state !== 'attack' && this.state !== 'skill' && this.state !== 'hurt'
      && this.state !== 'dodge' && this.state !== 'ko' && this.state !== 'grabbed'
      && this.hitstun <= 0 && this.blockstun <= 0 && this.recoveryT <= 0;
  }

  /* ---------------- 主更新 ---------------- */
  update(dt, opp, cmd) {
    this.t += dt;
    this.stateT += dt;
    this.invuln = Math.max(0, this.invuln - dt);
    this.flash = Math.max(0, this.flash - dt * 5);
    this.airLock = Math.max(0, this.airLock - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    this.escapeCd = Math.max(0, this.escapeCd - dt);
    this.lockT = Math.max(0, this.lockT - dt);
    this.s1Cd = Math.max(0, this.s1Cd - dt);
    this.recoveryT = Math.max(0, this.recoveryT - dt);
    // 必杀 O：整段释放过程无敌
    if (this.state === 'skill' && this.castNo === 3) this.invuln = Math.max(this.invuln, 0.05);
    // 闪避次数恢复：每 2 秒回 1 次，上限 2
    if (this.dodgeCharges < 2) {
      this.dodgeChargeCd -= dt;
      if (this.dodgeChargeCd <= 0) {
        this.dodgeCharges = Math.min(2, this.dodgeCharges + 1);
        this.dodgeChargeCd = this.dodgeCharges < 2 ? 2.0 : 0;
      }
    }
    if (this.hitstun > 0) this.hitstun -= dt;
    if (this.blockstun > 0) this.blockstun -= dt;
    if (this.comboT > 0) { this.comboT -= dt; if (this.comboT <= 0) this.combo = 0; }

    if (this.state === 'ko') { this.physics(dt, opp); return; }
    if (this.state === 'grabbed') { return; }

    // 幻影闪避（S+L）：被打的硬直里也能用，被「抱歉」锁住时同样可以脱身
    if (cmd && cmd.dodge && cmd.block && this.escapeCd <= 0 && this.rage >= 50
      && (this.state === 'hurt' || (this.hitstun > 0 && this.state !== 'skill' && this.state !== 'attack') || this.lockT > 0)
      && this.state !== 'ko' && this.state !== 'grabbed') {
      this.startEscape(opp);
      return;
    }

    // 双击方向 = 疾步（瞬步）：边沿检测两次单击间隔
    if (cmd && this.state !== 'hurt' && this.hitstun <= 0 && this.recoveryT <= 0) {
      if (cmd.left && !this.prevL) { this.tryDash(-1); }
      if (cmd.right && !this.prevR) { this.tryDash(1); }
      this.prevL = !!cmd.left; this.prevR = !!cmd.right;
    }

    // 空中攒下的技能：落地站稳后才放出来（空中按 U/I/O 不会变成"跳起来放技能"）
    if (this.pendingSkill) {
      this.pendingSkill.t -= dt;
      // 被打断 / 倒地就作废
      if (this.pendingSkill.t <= 0 || this.hitstun > 0 || this.state === 'hurt' || this.state === 'ko') {
        this.pendingSkill = null;
      } else this.tryPending(opp);
    }

    if (this.state === 'attack') this.updateAttack(dt, opp, cmd);
    else if (this.state === 'skill') this.updateSkill(dt, opp);
    else if (this.state === 'dodge') this.updateDodge(dt, opp);
    else if (this.state === 'hurt') {
      if (this.hitstun <= 0) {
        // 倒地起身：短暂无敌，防对面无限压起身
        if (this.prone) { this.prone = false; this.invuln = Math.max(this.invuln, 0.3); }
        this.setState('idle');
      }
    }
    else if (cmd) this.handleCmd(cmd, opp);

    // 疾步推进：覆盖普通移动速度，攻击/技能会自动打断它
    if (this.dashT > 0) {
      this.dashT -= dt;
      if (this.state === 'idle' || this.state === 'walk' || this.state === 'block') {
        if (this.state === 'block') { this.blocking = false; this.setState('walk'); }
        this.vx = this.dashDir * 560;
        this.ghostTick -= dt;
        if (this.ghostTick <= 0) { this.ghostTick = 0.07; this.spawnGhost(0.34); }
        if (this.dashT <= 0) this.vx *= 0.35;
      } else {
        this.dashT = 0;
      }
    }

    this.physics(dt, opp);
    // 落地的当帧就把攒下的技能放出来
    if (this.pendingSkill && this.grounded && this.canAct()) this.tryPending(opp);
    if (this.state !== 'attack' && this.state !== 'skill') this.faceOpponent(opp);
  }

  tryPending(opp) {
    if (!this.pendingSkill || !this.grounded || !this.canAct()) return;
    const n = this.pendingSkill.n;
    this.pendingSkill = null;
    this.castSkill(n, opp);
  }

  setState(s) {
    // 已被打倒：不允许再切回跳跃/受击/抓取等状态，否则 KO 动画会被抓取收招覆盖
    if (this.hp <= 0 && s !== 'ko' && this.state === 'ko') s = 'ko';
    this.state = s;
    this.stateT = 0;
  }

  faceOpponent(opp) {
    if (!opp || this.state === 'ko') return;
    this.facing = opp.x >= this.x ? 1 : -1;
  }

  /* ---------------- 输入处理 ---------------- */
  handleCmd(cmd, opp) {
    const free = this.canAct();
    if (!free) return;

    // 被「抱歉」锁住：站着不能动，只能靠上面的幻影闪避脱身
    if (this.lockT > 0) {
      this.vx = 0;
      if (this.grounded) this.setState('idle');
      return;
    }

    // 技能：U 技能1（免费） / I 技能2（50 怒气） / O 技能3（100 怒气）
    const skillNo = cmd.skill3 ? 3 : cmd.skill2 ? 2 : cmd.skill1 ? 1 : 0;
    if (skillNo) {
      // 空中也可以直接放技能
      this.castSkill(skillNo, opp);
      return;
    }

    // 闪避：L 朝面向 / A+L 左 / D+L 右；S+L 幻影闪避（消耗 50 怒气）
    if (cmd.dodge) {
      const dir = cmd.left ? -1 : cmd.right ? 1 : this.facing;
      if (this.grounded) {
        if (cmd.block) this.startPhantomDodge(dir, opp);
        else this.startDodge(dir);
        return;
      }
      // 空中闪避：消耗闪避次数，纯横向冲刺后自然下落
      if (!cmd.block) { this.startAirDodge(dir); return; }
    }

    // 跳跃
    if (cmd.jump && this.grounded) {
      this.vy = -this.def.jump;
      this.vx = (cmd.left ? -1 : cmd.right ? 1 : 0) * this.def.speed * 0.85;
      this.grounded = false;
      this.airAttacked = false;
      this.airDodged = false;
      this.setState('jump');
      this.game.audio.jump();
      this.game.fx.dust(this.x, this.y, '#c9d2e6', 6, 0.7);
      return;
    }

    // 空中攻击
    if (!this.grounded) {
      if (cmd.punch && !this.airAttacked) { this.airAttacked = true; this.startMove('jpunch'); return; }
      if (cmd.kick && !this.airAttacked) { this.airAttacked = true; this.startMove('jkick'); return; }
      if (cmd.left) this.vx = -this.def.speed * 0.8;
      else if (cmd.right) this.vx = this.def.speed * 0.8;
      this.setState('jump');
      return;
    }

    // 防御
    if (cmd.block) {
      this.blocking = true;
      this.vx = 0;
      this.setState('block');
      return;
    }
    this.blocking = false;

    // 地面攻击（疾步中出拳 / 出腿 = 瞬步强化版，伤害 ×1.2）
    if (cmd.punch) { this.startMove(this.dashT > 0 ? 'dashatk' : 'punch'); return; }
    if (cmd.kick) { this.startMove(this.dashT > 0 ? 'dashkick' : 'kick'); return; }

    // 移动
    if (cmd.left || cmd.right) {
      const dir = cmd.left ? -1 : 1;
      this.vx = dir * this.def.speed * (dir === this.facing ? 1 : 0.86);
      this.setState('walk');
      if (Math.random() < 0.12) this.game.fx.dust(this.x, this.y, '#8b93a8', 1, 0.3);
    } else {
      this.vx *= 0.6;
      this.setState('idle');
    }
  }

  /* ---------------- 普通攻击 ---------------- */
  startMove(id) {
    const M = MOVES[id];
    this.moveId = id;
    this.moveT = 0;
    this.moveHits = 0;
    this.setState('attack');
    this.blocking = false;
    // 起手清掉输入缓冲，否则按一下 J 会自动接下一式
    this.bufPunch = this.bufKick = this.bufJump = 0;
    this.bufS1 = this.bufS2 = this.bufS3 = 0;
    if (!M.air) this.vx = this.facing * M.lunge * 5;
    this.game.audio.whiff();
    this.game.audio.cry(this.def.id, 'atk');
  }

  updateAttack(dt, opp, cmd) {
    const M = MOVES[this.moveId];
    this.moveT += dt;

    // 输入缓冲：提前 0.2 秒按的键也作数（BVN 式 lenient input）
    if (cmd) {
      if (cmd.punch) this.bufPunch = 0.2;
      if (cmd.kick) this.bufKick = 0.2;
      if (cmd.jump) this.bufJump = 0.2;
      if (cmd.skill1) this.bufS1 = 0.2;
      if (cmd.skill2) this.bufS2 = 0.2;
      if (cmd.skill3) this.bufS3 = 0.2;
    }
    this.bufPunch = Math.max(0, this.bufPunch - dt);
    this.bufKick = Math.max(0, this.bufKick - dt);
    this.bufJump = Math.max(0, this.bufJump - dt);
    this.bufS1 = Math.max(0, this.bufS1 - dt);
    this.bufS2 = Math.max(0, this.bufS2 - dt);
    this.bufS3 = Math.max(0, this.bufS3 - dt);

    const inActive = this.moveT >= M.startup && this.moveT < M.startup + M.active;

    if (inActive && this.moveHits === 0) {
      if (this.checkHit(opp, M)) {
        this.moveHits = 1;
        this.applyHit(opp, M, 1);
      }
    }

    /* ---- BVN 连段取消窗口：活跃帧后半段 ~ 恢复期 ---- */
    if (this.moveT >= M.startup + M.active * 0.55 && this.moveT <= M.startup + M.active + M.recovery) {
      // 命中确认 → 可以直接取消进技能（U / I / O）
      if (this.grounded && this.moveHits > 0) {
        const cancelSkill = this.bufS3 > 0 ? 3 : this.bufS2 > 0 ? 2 : this.bufS1 > 0 ? 1 : 0;
        if (cancelSkill) {
          this.bufS1 = this.bufS2 = this.bufS3 = 0;
          this.dashT = 0;
          this.castSkill(cancelSkill, opp);
          return;
        }
      }
      // 浮空技命中 → 跳跃取消，起跳追击（空中 J 继续连）
      if (this.bufJump > 0 && this.grounded && M.launch && this.moveHits > 0) {
        this.bufJump = 0;
        this.vy = -this.def.jump * 1.02;
        this.vx = this.facing * this.def.speed * 0.7;
        this.grounded = false;
        this.airAttacked = false;
        this.dashT = 0;
        this.setState('jump');
        this.game.audio.jump();
        this.game.fx.dust(this.x, this.y, '#c9d2e6', 5, 0.6);
        return;
      }
      // 普攻链：J 接下一式；K 直接接重踢收尾
      if (this.grounded && M.next) {
        if (this.bufPunch > 0) {
          this.bufPunch = 0;
          this.startMove(M.next);
          return;
        }
        if (this.bufKick > 0) {
          this.bufKick = 0;
          this.startMove('kick');
          return;
        }
      }
    }

    if (this.moveT > M.startup + M.active + M.recovery) {
      this.moveId = null;
      this.setState('idle');
      this.vx *= 0.3;
    }
  }

  checkHit(opp, M) {
    if (!opp || opp.state === 'ko') return false;
    const hb = this.hitRect(M);
    const tb = opp.hurtBox;
    return hb.x0 < tb.x1 && hb.x1 > tb.x0 && hb.y0 < tb.y1 && hb.y1 > tb.y0;
  }

  hitRect(M) {
    const k = this.def.scale || 1;
    const reach = M.reach * Math.max(k, 0.85);   // 距离衰减设下限，小体型不至于打不着
    const x0 = this.facing > 0 ? this.x + 6 : this.x - 6 - reach;
    return { x0, x1: x0 + reach, y0: this.y + M.hi * k, y1: this.y + M.lo * k };
  }

  get hurtBox() {
    const k = this.def.scale || 1;
    const w = 20 * k;
    const top = this.prone ? -46 * k : -140 * k;
    return { x0: this.x - w, x1: this.x + w, y0: this.y + top, y1: this.y - 4 };
  }

  /* ---------------- 受击 / 命中 ---------------- */
  applyHit(opp, M, mult = 1) {
    const fx = this.game.fx, audio = this.game.audio;
    const dir = Math.sign(opp.x - this.x) || this.facing;

    if (opp.invuln > 0) {
      fx.text(opp.x, opp.y - 150, 'MISS', '#9aa6c0', 10);
      return;
    }

    const blocked = opp.blocking && opp.state === 'block' && Math.sign(opp.facing) === -dir;

    if (blocked) {
      const dmg = M.dmg * mult * 0.16;
      opp.hp -= dmg;
      opp.blockstun = M.blockstun;
      opp.vx = dir * 60;
      opp.gainRage(RAGE.block);
      this.gainRage(4);
      this.combo = 0;
      fx.blockSpark(opp.x - dir * 22, opp.y - 88, opp.elem);
      fx.text(opp.x - dir * 22, opp.y - 122, 'GUARD', '#9fe6ff', 10);
      fx.shake(3, 0.1); fx.stop(0.035);
      if (!M.voice) audio.block();
      this.game.checkKO(opp);
      return;
    }

    /* 连段伤害衰减：每连击一次 -5%，最多 -25%；仅普攻与 U 技能受衰减，I / O 固定伤害 */
    const wasAir = !opp.grounded;
    const decayed = this.castNo !== 2 && this.castNo !== 3;
    const scale = decayed ? Math.max(0.75, 1 - this.combo * 0.05) : 1;
    const dmg = M.dmg * mult * scale * (this.dmgMul || 1);
    opp.hp -= dmg;
    opp.flash = 1;
    opp.blocking = false;
    opp.liftRot = 0;
    opp.setState('hurt');
    opp.skill = null;
    opp.s1Active = false;
    opp.castNo = 0;
    opp.releaseLock();          // 施法者被打断，立刻解除对对手的锁定
    if (this.lockedTarget === opp) this.releaseLock();   // 时停技能命中后恢复行动
    opp.vx = dir * M.kb;

    if (M.launch) {
      // 浮空技：把对手打上天，追击计数清零
      opp.vy = -440;
      opp.grounded = false;
      opp.y = Math.min(opp.y, VIEW.GROUND - 2);
      opp.juggle = 0;
      opp.hitstun = M.hitstun;
      fx.text(opp.x, opp.y - 156, '浮空!', '#ffe9a8', 13);
      fx.shake(6, 0.2);
    } else if (M.knockdown) {
      // 击飞技：直接倒地
      opp.vy = -250;
      opp.grounded = false;
      opp.juggle = Math.max(opp.juggle || 0, 1);
      opp.hitstun = M.hitstun;
    } else if (wasAir) {
      // 空中追击：把人维持在空中，硬直逐次缩短，连段自然终结
      opp.vy = Math.min(opp.vy, -175);
      opp.juggle = (opp.juggle || 0) + 1;
      opp.hitstun = M.hitstun * Math.max(0.45, 1 - opp.juggle * 0.13);
    } else {
      opp.hitstun = M.hitstun;
      if (M.kb > 120) opp.vy = -110;
    }

    this.combo++;
    this.comboT = 1.4;
    // 怒气：按对方当时释放的技能等级结算（0 = 普攻）
    this.payHitRage(opp);

    const hx = opp.x - dir * 16;
    const hy = opp.y - 92;
    fx.spark(hx, hy, '#fff2c2', M.dmg > 30 ? 1.4 : 1, M.dmg > 30 ? 14 : 9);
    fx.spark(hx, hy, this.elem, 1, 5);
    fx.ring(hx, hy, M.dmg > 30 ? 34 : 24, '#ffffff', 0.22, 3);
    fx.text(hx, hy - 26, '-' + Math.round(dmg), M.dmg > 30 ? '#ffd166' : '#ffffff', M.dmg > 30 ? 14 : 12);
    fx.shake(M.dmg > 30 ? 7 : 4.5, M.dmg > 30 ? 0.24 : 0.16);
    fx.stop(M.dmg > 30 ? 0.07 : 0.05);
    if (M.dmg > 30) fx.flash('#fff', 0.18, 0.07);

    if (M.voice && this.def.id === 'hopper') audio.cry('hopper', M.voice);
    else audio.charHit(this.def.id, M.sfx === 'kick' ? 'kick' : 'punch', M.dmg > 30 ? 1.3 : 1);
    audio.cry(opp.def.id, 'hurt');
    this.game.checkKO(opp);
  }

  /* ---------------- 疾步（双击 A/D）· BVN 瞬步 ---------------- */
  tryDash(dir) {
    if (!this.grounded || this.dashCd > 0 || this.dashT > 0) { this.tapT[dir] = this.t; return; }
    if (this.state !== 'idle' && this.state !== 'walk' && this.state !== 'block') { this.tapT[dir] = this.t; return; }
    // 0.24 秒内两次同向单击 → 疾步
    if (this.t - this.tapT[dir] < 0.24) {
      this.dashT = 0.17;
      this.dashDir = dir;
      this.dashCd = 0.42;
      this.ghostTick = 0;
      this.game.audio.dodge();
      this.game.fx.dust(this.x, this.y, '#c9d2e6', 4, 0.5);
      this.game.fx.ring(this.x, this.y - 80, 26, this.elem, 0.18, 2);
      this.tapT[dir] = -9;
    } else {
      this.tapT[dir] = this.t;
    }
  }

  /* ---------------- 幻影闪避：受击硬直中 S+L 脱身 ---------------- */
  startEscape(opp) {
    if (this.dodgeCharges <= 0) { this.dodgeToast(); return; }
    this.consumeDodgeCharge();
    this.lockT = 0;                       // 脱身时解除「抱歉」的锁定
    const fx = this.game.fx;
    this.rage -= 50;
    this.escapeCd = 1.5;
    const oldX = this.x, oldY = this.y;

    // 瞬移到对手背后
    if (opp && opp.state !== 'ko') {
      this.x = Math.max(30, Math.min(VIEW.W - 30, opp.x - opp.facing * 76));
    }
    this.y = VIEW.GROUND;
    this.grounded = true;
    this.vy = 0; this.vx = 0;
    this.hitstun = 0; this.blockstun = 0;
    this.prone = false; this.juggle = 0;
    this.invuln = 0.55;
    this.dashT = 0;
    this.setState('idle');
    if (opp) this.faceOpponent(opp);

    // 原地留一缕烟 + 残影，交代"人已经不在了"
    for (let i = 0; i < 10; i++) {
      fx.parts.push({
        x: oldX + (Math.random() - 0.5) * 30, y: oldY - 20 - Math.random() * 110,
        vx: (Math.random() - 0.5) * 50, vy: -30 - Math.random() * 60,
        life: 0.4, max: 0.4, size: 3 + Math.random() * 2, color: '#dfe8ff', g: -60, drag: 2
      });
    }
    fx.ring(oldX, oldY - 80, 44, '#ffffff', 0.28, 3);
    fx.text(oldX, oldY - 170, '幻影闪避!', '#9fe6ff', 15);
    fx.spark(this.x, this.y - 80, this.elem, 1.1, 8);
    this.game.audio.dodge();
    this.spawnGhost(0.5);
  }

  /* ---------------- 普通闪避（L / A+L / D+L）：不消耗怒气，短无敌 ---------------- */
  startDodge(dir) {
    if (this.dodgeCharges <= 0) { this.dodgeToast(); return; }
    this.consumeDodgeCharge();
    this.dodgePhantom = false;
    this.dodgeAir = false;
    this.state = 'dodge';
    this.stateT = 0;
    this.dodgeT = 0;
    this.dodgeDir = dir || this.facing;
    this.invuln = 0.2;
    this.vx = this.dodgeDir * 720;
    this.ghostT = 0.06;
    this.blocking = false;
    this.game.audio.dodge();
    this.game.fx.dust(this.x, this.y, '#c9d2e6', 4, 0.5);
    this.spawnGhost(0.32);
  }

  /* ---------------- 空中闪避：横向冲刺 + 短暂滞空，然后自然下落 ---------------- */
  startAirDodge(dir) {
    if (this.dodgeCharges <= 0) { this.dodgeToast(); return; }
    this.consumeDodgeCharge();
    this.dodgePhantom = false;
    this.dodgeAir = true;
    this.state = 'dodge';
    this.stateT = 0;
    this.dodgeT = 0;
    this.dodgeDir = dir || this.facing;
    this.invuln = Math.max(this.invuln, 0.26);
    this.vx = this.dodgeDir * 620;
    // 纯横向冲刺：抹掉下坠速度，闪避结束后靠重力自然掉落
    this.vy = 0;
    this.ghostT = 0.05;
    this.blocking = false;
    this.game.audio.dodge();
    this.game.fx.ring(this.x, this.y - 70, 34, this.elem, 0.24, 2);
    this.game.fx.dust(this.x, this.y, '#c9d2e6', 4, 0.5);
    this.spawnGhost(0.34);
  }

  /* ---------------- 幻影闪避（S+L）：消耗 50 怒气，瞬移到对手身后 + 长无敌 ---------------- */
  startPhantomDodge(dir, opp) {
    if (this.rage < 50) { this.game.toast('怒气不足', this.x, this.y - 180, '#ff8080'); return; }
    if (this.dodgeCharges <= 0) { this.dodgeToast(); return; }
    this.consumeDodgeCharge();
    this.rage -= 50;
    const fx = this.game.fx;
    const oldX = this.x, oldY = this.y;
    this.dodgePhantom = true;
    this.dodgeAir = false;
    this.state = 'dodge';
    this.stateT = 0;
    this.dodgeT = 0;
    this.dodgeDir = dir || this.facing;
    this.invuln = 0.42;
    this.ghostT = 0;
    this.blocking = false;
    this.game.audio.dodge();
    this.spawnGhost(0.7);                    // 在原位留下残影
    // 必定瞬移到对手身后（与受击脱身一致）；身后贴墙出界时落到另一侧
    if (opp && opp.state !== 'ko') {
      const pad = 30;
      let tx = opp.x - opp.facing * 76;
      if (tx < pad || tx > VIEW.W - pad) tx = opp.x + opp.facing * 76;
      this.x = Math.max(pad, Math.min(VIEW.W - pad, tx));
      this.faceOpponent(opp);
    } else {
      this.x = Math.max(30, Math.min(VIEW.W - 30, this.x + this.dodgeDir * 120));
    }
    this.vx = 0;
    fx.ring(oldX, oldY - 70, 40, this.elem, 0.3, 2);
    fx.spark(this.x, this.y - 80, this.elem, 1.1, 8);
    this.game.toast('幻影闪避', this.x, this.y - 190, this.elem);
  }

  /* ---------------- 闪避次数：消耗 1 次，不足时提示冷却 ---------------- */
  consumeDodgeCharge() {
    this.dodgeCharges--;
    if (this.dodgeChargeCd <= 0) this.dodgeChargeCd = 2.0;
    this.dodgeCd = 0.05;   // 同帧锁定，避免一次按键触发两次
  }

  dodgeToast() {
    const t = this.dodgeCharges < 2 ? this.dodgeChargeCd.toFixed(1) : '0.0';
    this.game.toast('闪避冷却中 ' + t + 's', this.x, this.y - 180, '#ff8080');
  }

  spawnGhost(alpha = 0.5) {
    if (this.usePoseSprite()) {
      // 残影也用当前姿势贴图，尺寸和朝向跟本人一致
      const P = this.sp.poses;
      const key = this.poseSpriteKey();
      const p = P[key] || P.idle;
      const meta = (POSE_META[this.def.id] || {})[key] || { ax: 0.5, ay: 1 };
      const refH = ((POSE_META[this.def.id] || {}).idle || {}).h || p.h;
      const k = POSE_BODY_H * (this.def.scale || 1) / refH * (meta.k || 1);
      this.game.fx.ghost(p, this.x, this.y, this.facing * (meta.flip || 1), this.lean, alpha,
        'ghost', 1, 1, k, meta.ax, meta.ay);
      return;
    }
    this.game.fx.ghost(this.sp, this.x, this.y, this.facing, this.lean, alpha, 'ghost');
  }

  updateDodge(dt, opp) {
    this.dodgeT += dt;
    this.ghostT -= dt;
    if (this.dodgePhantom) this.invuln = Math.max(this.invuln, 0.04);
    if (this.ghostT <= 0) {
      this.ghostT = this.dodgePhantom ? 0.085 : 0.12;
      this.spawnGhost(this.dodgePhantom ? 0.6 : 0.3);
    }
    this.vx *= 0.985;
    if (this.grounded) {
      if (this.dodgeT > (this.dodgeAir ? 0.1 : 0.42)) {
        this.state = 'idle';
        this.vx *= 0.2;
        this.game.fx.dust(this.x, this.y, this.elem, 5, 0.6);
      }
    } else if (this.dodgeT > 0.3) {
      // 空中闪避结束：回到跳跃状态，继续正常下落/空中攻击
      this.setState('jump');
    }
  }

  /* ---------------- 技能入口 ---------------- */
  /* n: 1 = U 技能1（不耗怒气）, 2 = I 技能2（50 怒气）, 3 = O 技能3（100 怒气·暂未配置） */
  castSkill(n, opp) {
    if (n === 3) {
      if (!this.def.skills.s3) { this.game.toast('技能3 尚未开放', this.x, this.y - 180, '#9aa4b8'); return false; }
      if (this.rage < 100) { this.game.toast('怒气不足', this.x, this.y - 180, '#ff8080'); return false; }
      this.rage -= 100;
      this.setState('skill');
      this.blocking = false;
      this.vx = 0;
      this.startSkill3(opp);
      return true;
    }
    if (n === 2) {
      if (this.rage < 50) { this.game.toast('怒气不足', this.x, this.y - 180, '#ff8080'); return false; }
      this.startUltimate(opp);
      return true;
    }
    // 技能1（U）：冷却中则提示并阻止
    if (this.s1Cd > 0) {
      this.game.toast('技能冷却中 ' + this.s1Cd.toFixed(1) + 's', this.x, this.y - 180, '#ff8080');
      return false;
    }
    this.startSkill1(opp);
    return true;
  }

  startSkill1(opp) {
    if (this.s1Cd > 0) {
      this.game.toast('技能冷却中 ' + this.s1Cd.toFixed(1) + 's', this.x, this.y - 180, '#ff8080');
      return;
    }
    this.s1Active = true;
    this.castNo = 1;
    this.rageHitUsed = 0;
    this.gainRage(RAGE.s1.cast);        // U：释放即 +5，空放也给
    this.setState('skill');
    this.blocking = false;
    this.vx = 0;
    if (this.def.id === 'dog') this.startMilkThrow(opp);
    else if (this.def.id === 'whalie') this.startRice(opp);
    else if (this.def.id === 'frost') this.startIceSpike(opp);
    else if (this.def.id === 'hopper') this.startFlurry(opp);
    else if (this.def.id === 'naiwa') this.startMegaPunch(opp);
    else this.startRush(opp);
  }

  startUltimate(opp) {
    this.s1Active = false;
    this.castNo = 2;
    this.rageHitUsed = 0;
    this.rage -= 50;
    this.setState('skill');
    this.blocking = false;
    this.vx = 0;
    if (this.def.id === 'dog') this.startGrab(opp);
    else if (this.def.id === 'whalie') this.startSpray(opp);
    else if (this.def.id === 'frost') this.startDragonClaw(opp);
    else if (this.def.id === 'hopper') this.startSkyKick(opp);
    else if (this.def.id === 'naiwa') this.startSlam(opp);
    else if (this.def.id === 'spade') this.startShoulderThrow(opp);
    else this.startBurst(opp);
  }

  /* 技能3（O 键）：霜龙火球术 / 奶娃哈哈哈 / 小鲸鲸歌 */
  startSkill3(opp) {
    this.s1Active = false;
    this.castNo = 3;
    this.rageHitUsed = 0;
    this.setState('skill');
    this.blocking = false;
    this.vx = 0;
    if (this.def.id === 'frost') this.startFireball(opp);
    else if (this.def.id === 'naiwa') this.startBellyLaugh(opp);
    else if (this.def.id === 'whalie') this.startWhaleSong(opp);
    else if (this.def.id === 'dog') this.startBark(opp);
    else if (this.def.id === 'spade') this.startSorry(opp);
    else if (this.def.id === 'hopper') this.startBike(opp);
  }

  /* ================= 黑桃 · 抱歉（O）：感化扣血，一半转化为自身体力 ================= */
  startSorry(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    const windup = Math.max(0.9, Math.min(2.2, Number(audio.spadeSorryLen) || 1.05));
    this.skill = { id: 'sorry', t: 0, windup, released: false };
    this.invuln = windup + 0.45;
    // 锁定敌人：蓄力全程无法动弹，只能用幻影闪避（S+L）脱身
    this.releaseLock();
    if (opp && opp.state !== 'ko' && opp.state !== 'grabbed') {
      this.lockedTarget = opp;
      opp.lockT = windup + 0.05;
      opp.vx = 0;
    }
    audio.cry('spade', 'S3');
    audio.charge();
    this.game.announce(this.def.skills.s3, '#ffe6a1');
    this.game.cinematic(windup);
    fx.ring(this.x, this.y - 92, 72, '#ffe7a0', 0.5, 3);
  }

  updateSorry(dt, opp) {
    const s = this.skill, fx = this.game.fx;
    s.t += dt;
    this.vx = 0;
    this.invuln = Math.max(this.invuln, 0.04);
    const cx = this.x, cy = this.y - 94;

    if (!s.released) {
      // 圣光向张开的双臂汇聚，台词结束后才发生感化与体力转移
      for (let i = 0; i < 2; i++) {
        const a = Math.random() * Math.PI * 2, r = 52 + Math.random() * 48;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        fx.parts.push({ x, y, vx: (cx - x) * 3.8, vy: (cy - y) * 3.8,
          life: 0.26, max: 0.26, size: 1 + (Math.random() < 0.3 ? 1 : 0),
          color: Math.random() < 0.4 ? '#fff8d9' : '#ffd66e', g: 0, drag: 0 });
      }
      if (s.t < s.windup) return;
      s.released = true;
      fx.flash('#fff4c7', 0.38, 0.16);
      fx.ring(cx, cy, 138, '#fff0b0', 0.55, 5);
      fx.ring(cx, cy, 84, '#ffffff', 0.35, 2);
      this.game.audio.tone(660, 0.55, 'sine', 0.13, 1320);
      this.game.audio.tone(990, 0.65, 'sine', 0.1, 1480, 0.06);

      // 范围：横向覆盖半个地图
      if (opp && opp.state !== 'ko' && opp.invuln <= 0
        && Math.abs(opp.x - this.x) <= VIEW.W * 0.5 && Math.abs(opp.y - this.y) < 180) {
        opp.lockT = 0;
        this.payHitRage(opp);
        const before = Math.max(0, opp.hp);
        opp.hp = Math.max(0, before - Math.round(108 * (this.dmgMul || 1)));
        const dealt = before - opp.hp;
        opp.flash = 1;
        opp.blocking = false;
        opp.liftRot = 0;
        opp.vx = 0;
        opp.setState('hurt');
        opp.skill = null;
        opp.s1Active = false;
        opp.castNo = 0;
        opp.hitstun = 0.65;
        fx.text(opp.x, opp.y - 156, '感化了！-' + dealt, '#ffe388', 15);
        fx.ring(opp.x, opp.y - 86, 78, '#fff0b0', 0.5, 4);
        fx.spark(opp.x, opp.y - 86, '#ffe29a', 1.25, 16);
        this.game.audio.cry(opp.def.id, 'hurt');

        // 从敌人胸口流向黑桃的光点，直观表现体力转移
        for (let i = 0; i < 28; i++) {
          const life = 0.48 + Math.random() * 0.28;
          const x = opp.x + (Math.random() - 0.5) * 28;
          const y = opp.y - 90 + (Math.random() - 0.5) * 52;
          fx.parts.push({ x, y, vx: (cx - x) / life, vy: (cy - y) / life,
            life, max: life, size: 2 + (i % 3 === 0 ? 1 : 0),
            color: i % 3 === 0 ? '#ffffff' : '#ffd36b', g: 0, drag: 0 });
        }
        const oldHp = this.hp;
        this.hp = Math.min(this.maxHp, this.hp + dealt * 0.5);
        const healed = this.hp - oldHp;
        if (healed > 0) fx.text(this.x, this.y - 162, '+' + Math.round(healed), '#a8ffbd', 17);
        this.game.checkKO(opp);
      } else {
        fx.text(this.x + this.facing * 80, this.y - 150, '没有感化到', '#fff0c2', 11);
      }
    }

    if (s.t > s.windup + 0.75) this.endSkill();
  }

  /* 解除「抱歉」对对手的锁定 */
  releaseLock() {
    if (this.lockedTarget) {
      this.lockedTarget.lockT = 0;
      this.lockedTarget = null;
    }
  }

  /* 必杀时停：锁定对手，期间无法移动/攻击，只能用幻影闪避（S+L）脱身 */
  lockOpponent(opp, seconds = 1.5) {
    this.releaseLock();
    if (!opp || opp.state === 'ko' || opp.state === 'grabbed') return;
    this.lockedTarget = opp;
    opp.lockT = seconds;
    opp.vx = 0;
  }

  /* ================= 跳跳 · 神之一脚（I）：跃上高空，带火俯冲连踢 ================= */
  startSkyKick(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    this.skill = { id: 'skykick', t: 0, phase: 0, phaseT: 0, hits: 0, target: this.x };
    this.invuln = 0.42;
    audio.cry('hopper', 'UL');
    audio.charge();
    this.game.announce(this.def.skills.s2, this.def.color);
    fx.ring(this.x, this.y - 40, 48, '#ffe066', 0.3, 3);
  }

  updateSkyKick(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    s.phaseT += dt;
    const dir = Math.sign((opp ? opp.x : this.x + this.facing) - this.x) || this.facing;
    this.facing = dir;

    // 0 蹲身蓄力
    if (s.phase === 0) {
      this.vx = 0;
      if (s.phaseT < 0.2) return;
      s.phase = 1; s.phaseT = 0;
      this.grounded = false;
      this.y = Math.min(this.y, VIEW.GROUND - 2);
      this.vy = -700;
      this.vx = dir * 190;
      s.target = opp
        ? Math.max(70, Math.min(VIEW.W - 70, opp.x - dir * 58))
        : this.x + dir * 240;
      fx.dust(this.x, this.y, '#ffe9a8', 10, 1.0);
      fx.ring(this.x, this.y - 26, 54, '#ffe066', 0.32, 4);
      audio.jump();
      return;
    }

    // 1 起跳上升（用跳跃那张图）
    if (s.phase === 1) {
      if (this.vy < 0) {
        if (Math.random() < 0.4) {
          fx.parts.push({
            x: this.x + (Math.random() - 0.5) * 40, y: this.y - 20,
            vx: (Math.random() - 0.5) * 60, vy: 40 + Math.random() * 60,
            life: 0.3, max: 0.3, size: 2, color: '#ffe9a8', g: 0, drag: 0
          });
        }
        return;
      }
      // 到顶：翻成飞踢关键帧
      s.phase = 2; s.phaseT = 0;
      this.vy = 300;
      fx.flash('#fff3b0', 0.16, 0.1);
      fx.ring(this.x, this.y - 70, 66, '#ffb43c', 0.3, 4);
      return;
    }

    // 2 空中俯冲：朝右下方一帧一帧地踢
    if (s.phase === 2) {
      // 匀速俯冲，滞空够长，能一帧一帧踢完三段
      this.vy = 320;
      const d = s.target - this.x;
      const spd = Math.max(640, Math.min(1000, Math.abs(d) / 0.3));
      this.vx = Math.abs(d) < 12 ? 0 : Math.sign(d) * spd;

      // 脚底烈焰拖尾
      const footX = this.x + dir * 46, footY = this.y - 16;
      for (let i = 0; i < 2; i++) {
        fx.parts.push({
          x: footX - dir * (6 + Math.random() * 24), y: footY + (Math.random() - 0.5) * 16,
          vx: -dir * (140 + Math.random() * 160), vy: -20 - Math.random() * 70,
          life: 0.3, max: 0.3, size: 3 + ((Math.random() * 3) | 0),
          color: i ? '#ffb03c' : '#ff6a24', g: -30, drag: 1.4
        });
      }

      // 三段连踢：真正贴到敌人身上才结算，帧间隔 0.08 秒
      const near = opp && opp.state !== 'ko'
        && Math.abs(opp.x - footX) < 42 && this.y > VIEW.GROUND - 74;
      if (near && s.hits < 3 && s.phaseT - (s.lastHit || 0) > 0.08) {
        const last = s.hits === 2;
        s.hits++;
        s.lastHit = s.phaseT;
        this.applyHit(opp, {
          name: last ? 'hsky' : 'hsky1', dmg: last ? 40 : 20, reach: 60,
          hi: -130, lo: -10, kb: last ? 430 : 60,
          hitstun: last ? 0.5 : 0.24, blockstun: 0.22,
          sfx: 'kick', knockdown: last, rage: last ? RAGE.hit * 2 : RAGE.hit
        }, 1);
        fx.ring(footX, footY - 40, last ? 96 : 54,
          last ? '#ffd66a' : '#ffffff', 0.34, last ? 6 : 3);
        fx.spark(footX, footY - 40, '#ffb03c', last ? 1.8 : 1.1, last ? 18 : 10);
        fx.stop(last ? 0.08 : 0.03);
        if (last) fx.shake(14, 0.32);
      }

      if (this.grounded) {
        s.phase = 3; s.phaseT = 0;
        this.vx *= 0.3;
        fx.dust(this.x, this.y, '#e8dcc0', 10, 1.0);
        fx.shake(7, 0.22);
        audio.land();
      }
      return;
    }

    // 3 落地收招，恢复常态
    if (s.phaseT > 0.34) this.endSkill();
  }

  /* ================= 小鲸 · 鲸歌（O） ================= */
  startWhaleSong(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    // 有台词音频就按它的长度决定「喊完再开嗓」的时间
    const line = Math.max(0.9, Math.min(2.4, audio.whalieSongLen || 1.15));
    const lala = audio.whalieLalaLen || 0;
    // 时停：开嗓前的蓄力阶段对手无法行动
    this.lockOpponent(opp, Math.max(1.5, line + 0.15));
    this.skill = {
      id: 'whalesong', t: 0, sing: line, pulses: 0, noteT: 0, sang: false,
      // 有「啦啦啦」音频就按它的节奏排三段音波，否则用默认节奏
      pulseAt: lala ? [0.15, 0.66, 1.2] : [0, 0.36, 0.72],
      endAt: lala ? Math.max(1.35, Math.min(1.95, lala)) : 1.16
    };
    this.invuln = line + 0.55;
    audio.cry('whalie', 'S3');   // 必杀，鲸歌咏叹调
    this.game.announce('鲸歌', '#7fd8ff');
    this.game.cinematic(line);
    fx.flash('#8fe0ff', 0.18, 0.12);
    fx.ring(this.x, this.y - 90, 46, '#9fe6ff', 0.5, 2);
  }

  updateWhaleSong(dt, opp) {
    const s = this.skill, fx = this.game.fx;
    s.t += dt;
    this.vx = 0;
    this.invuln = Math.max(this.invuln, 0.04);

    // 前段：备战姿势，歌词音符一个个飘起
    if (s.t < s.sing) {
      s.noteT -= dt;
      if (s.noteT <= 0) {
        s.noteT = 0.13;
        const note = ['♪', '♫', '♬'][(Math.random() * 3) | 0];
        fx.text(this.x + (Math.random() - 0.5) * 54, this.y - 120 - Math.random() * 40,
          note, '#9fe6ff', 11, -55);
      }
      return;
    }

    // 开嗓：切唱歌姿势的同一帧放出「啦啦啦」
    if (!s.sang) { s.sang = true; this.game.audio.whalieLala(); }

    // 后段：朝正面扇形喷出三段鲸歌音波，越往后范围越大、命中越重
    const dir = this.facing;
    const ox = this.x + dir * 26, oy = this.y - 104;
    const at = s.pulseAt;
    const LEN = [390, 500, 620];
    const SPREAD = [0.34, 0.42, 0.52];
    const DMG = [33, 43, 63];
    while (s.pulses < 3 && s.t >= s.sing + at[s.pulses]) {
      const i = s.pulses++;
      const last = s.pulses === 3;
      const len = LEN[i], spread = SPREAD[i];

      // 扇形声浪：两层锥形冲击波 + 沿着扇形飞出去的音符和速度线
      fx.cone(ox, oy, dir, len, last ? '#d8f6ff' : '#8fe4ff', last ? 0.5 : 0.4, spread);
      fx.cone(ox, oy, dir, len * 0.62, 'rgba(200,245,255,.7)', 0.34, spread * 0.8);
      fx.ring(ox, oy, 26, '#bfefff', 0.25, 2);
      for (let k = 0; k < 10; k++) {
        fx.speedLine(ox + dir * (40 + Math.random() * len * 0.8),
          oy + (Math.random() - 0.5) * len * spread * 0.7, dir);
      }
      for (let k = 0; k < 4; k++) {
        fx.text(ox + dir * (60 + Math.random() * len * 0.7),
          oy + (Math.random() - 0.5) * 70,
          ['♪', '♫', '♬'][(Math.random() * 3) | 0], '#bfefff', 10, -40);
      }
      fx.shake(last ? 9 : 4, 0.24);
      fx.stop(last ? 0.07 : 0.035);
      if (last) fx.flash('#bfefff', 0.14, 0.1);

      // 扇形判定：正前方半角内且长度以内
      if (opp && opp.state !== 'ko') {
        const tx = opp.x - ox, ty = (opp.y - 82) - oy;
        const dist = Math.hypot(tx, ty);
        const ang = Math.abs(Math.atan2(ty, tx * dir));
        if (dist < len && ang < spread + 0.06) {
          this.applyHit(opp, {
            dmg: DMG[i], kb: last ? 380 : (i === 0 ? 56 : 96),
            hitstun: last ? 0.6 : 0.34, blockstun: 0.24,
            knockdown: last, voice: false
          }, 1);
        }
      }
    }
    if (s.t > s.sing + s.endAt) this.endSkill();
  }

  /* ================= 大狗 · 野生狗奶（U，不耗怒气） =================
     抱起狗奶蓄力 → 横挥脱手 → 奶盒高速旋转横飞，砸中小幅击飞
     整段节奏跟着台词「野生狗奶」的人声走：横挥 0.14s 刚好在人声收尾时脱手 */
  startMilkThrow(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    // 音频已裁掉尾部静音，这里就是台词真实长度（约 0.78s）
    const line = audio.dogMilkLen || 0.78;
    // 横挥占 0.14s，蓄力到人声结束前收尾，喊完正好把奶丢出去
    const charge = Math.max(0.45, Math.min(1.6, line - 0.16));
    this.skill = { id: 'milkthrow', t: 0, thrown: false, charge };
    this.invuln = charge + 0.2;
    audio.dogMilkVoice();
    audio.charge();
    this.game.announce(this.def.skills.s1, this.def.color);
    fx.ring(this.x + this.facing * 28, this.y - 84, 34, '#fff2d8', 0.36, 2);
  }

  updateMilkThrow(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.vx = 0;
    const dir = this.facing;

    // 蓄力：白色奶气向狗奶汇聚
    if (s.t < s.charge) {
      this.invuln = Math.max(this.invuln, 0.05);
      if (Math.random() < 0.65) {
        const a = Math.random() * Math.PI * 2, r = 46 + Math.random() * 30;
        const hx = this.x + dir * 28, hy = this.y - 84;
        fx.parts.push({
          x: hx + Math.cos(a) * r, y: hy + Math.sin(a) * r * 0.8,
          vx: -Math.cos(a) * r * 2.6, vy: -Math.sin(a) * r * 2.6,
          life: 0.3, max: 0.3, size: 2, color: Math.random() < 0.5 ? '#ffffff' : '#ffe9c0',
          g: 0, drag: 1.2
        });
      }
      return;
    }

    // 出手：横挥收尾帧上把狗奶甩出去（胸口高度，保证命中对手受击框）
    const release = s.charge + 0.14;
    if (!s.thrown && s.t >= release) {
      s.thrown = true;
      audio.heavy();
      fx.ring(this.x + dir * 60, this.y - 84, 40, '#ffe9c0', 0.25, 3);
      for (let i = 0; i < 5; i++) fx.speedLine(this.x + dir * 60, this.y - 84 - 24 + i * 12, dir);
      this.game.spawnProjectile({
        owner: this, type: 'milk',
        x: this.x + dir * 78, y: this.y - 84,
        vx: dir * 640, dmg: 30, radius: 26, life: 1.3,
        spin: dir * 15.5, kb: 230
      });
    }
    if (s.t > release + 0.26) this.endSkill();
  }

  /* ================= 大狗 · 猛犬扑咬 ================= */
  startGrab(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    // 大狗叫时长决定特写与喊台词无敌帧，边喊边扑
    const shout = Math.max(0.6, Math.min(2.0, audio.dogBarkLen || 1.0));
    this.skill = { id: 'grab', t: 0, phase: 0, bites: 0, grabbed: null, shout };
    this.invuln = Math.max(2.2, shout);
    audio.bark(1.0, 0.7);   // 完整真人配音大狗叫，与扑咬同步起手
    this.game.announce(this.def.skills.s2, this.def.color);
    this.game.cinematic(Math.min(1.2, shout));
    this.game.fx.flash('#ffb03a', 0.16, 0.1);
    fx.ring(this.x, this.y - 80, 60, this.def.color, 0.35, 3);
  }

  updateGrab(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);

    if (s.phase === 0) {
      this.vx = 0;
      if (s.t > 0.2) {
        s.phase = 1; s.t = 0;
        this.vx = this.facing * 660;
        fpDust(fx, this.x, this.y, this.def.color, 8, this.facing);
      }
      return;
    }

    if (s.phase === 1) {
      this.vx = this.facing * 660;
      const dx = Math.abs(opp.x - this.x);
      const reachable = dx < 86 && Math.abs(opp.y - this.y) < 90
        && opp.state !== 'ko' && opp.invuln <= 0;
      if (reachable) {
        s.phase = 2; s.t = 0; s.grabbed = opp;
        opp.state = 'grabbed';
        opp.blocking = false;
        opp.vx = 0; opp.vy = 0; opp.grabT = 0; opp.prone = false;
        opp.hitstun = 99;
        this.vx = 0;
        this.x = opp.x - this.facing * 30;
        fx.flash('#fff', 0.42, 0.07);
        fx.stop(0.09);
        fx.shake(5, 0.14);
        fx.ring(opp.x, opp.y - 80, 54, '#fff', 0.26, 4);
        fx.text(opp.x, opp.y - 170, '抓住了！', '#ffe9a8', 14);
        audio.heavy();
        return;
      }
      if (s.t > 0.5) {
        this.vx = 0;
        fx.dust(this.x, this.y, '#cfd6e6', 8, 0.9);
        audio.land();
        this.endSkill();
      }
      return;
    }

    // ---- 已抓住：抬举 → 砸地 → 连咬 → 甩飞 ----
    const g = s.grabbed;
    const dir = this.facing;
    if (s.phase === 2) {
      const k = Math.min(1, s.t / 0.18);
      g.x = this.x + dir * 34;
      g.y = VIEW.GROUND - Math.max(0, 108 * k);
      g.prone = false;
      g.facing = -dir;
      if (s.t > 0.18) { s.phase = 3; s.t = 0; }
    } else if (s.phase === 3) {
      const k = Math.min(1, s.t / 0.16);
      g.x = this.x + dir * (40 + 86 * k);
      g.y = VIEW.GROUND - (108 * (1 - k));
      g.prone = k > 0.35;
      if (s.t > 0.16) {
        s.phase = 4; s.t = 0;
        g.prone = true;
        g.y = VIEW.GROUND;
        fx.dustRing(g.x, VIEW.GROUND, 'rgba(240,220,180,.65)');
        fx.ring(g.x, VIEW.GROUND - 6, 70, '#ffe9a8', 0.3, 4);
        fx.shake(13, 0.34);
        fx.stop(0.1);
        fx.flash('#fff', 0.35, 0.09);
        fx.spark(g.x, VIEW.GROUND - 20, '#ffcf6b', 1.6, 18);
        audio.heavy();
        this.dealSkillDamage(g, 20, '#ffd166', 16, true);
        fx.text(g.x, VIEW.GROUND - 122, 'SLAM!', '#ffffff', 16);
      }
    } else if (s.phase === 4) {
      g.x = this.x + dir * 146;
      g.y = VIEW.GROUND;
      g.prone = true;
      const biteTimes = [0.02, 0.3, 0.58];
      if (s.bites < 3 && s.t >= biteTimes[s.bites]) {
        s.bites++;
        const biteX = g.x - dir * 62;
        fx.spark(biteX, VIEW.GROUND - 26, '#fff5d6', 1.2, 12);
        fx.spark(biteX, VIEW.GROUND - 26, '#ff9d3d', 1, 8);
        fx.ring(biteX, VIEW.GROUND - 24, 30, '#ffdb8a', 0.22, 3);
        fx.shake(6, 0.16);
        fx.stop(0.045);
        fx.text(g.x + (Math.random() - 0.5) * 20, VIEW.GROUND - 70, '咬!', '#ffe08a', 13);
        audio.charHit('dog', 'punch', 0.9);
        this.dealSkillDamage(g, 14, '#ffe9a8', 0, true);
      }
      if (s.t > 0.86) { s.phase = 5; s.t = 0; }
    } else if (s.phase === 5) {
      if (s.t < 0.05 && !s.thrown && g.state !== 'ko') {
        s.thrown = true;                 // 甩飞只结算一次（原先同一段会重复扣血）
        g.prone = false;
        g.setState('hurt');
        g.skill = null;
        g.s1Active = false;
        g.castNo = 0;
        g.hitstun = 0.55;
        g.vx = dir * 320;
        g.vy = -270;
        g.y = VIEW.GROUND;
        this.dealSkillDamage(g, 8, '#ffffff', 0, true);
        this.game.checkKO(g);
        fx.dustRing(g.x, VIEW.GROUND);
        audio.heavy();
        fx.shake(8, 0.2);
      }
      if (s.t > 0.3) this.endSkill();
    }
  }

  dealSkillDamage(target, dmg, color, extraShake = 0, deferKO = false) {
    if (target.state === 'ko') return;
    dmg = Math.round(dmg * (this.dmgMul || 1));   // 无尽模式敌方伤害加成
    target.hp -= dmg;
    target.flash = 1;
    this.game.fx.text(target.x + (Math.random() - 0.5) * 30, target.y - 104 - Math.random() * 26, '-' + dmg, color, 13);
    this.payHitRage(target);        // 怒气按技能档位结算（I / O 只算一次）
    if (!deferKO) this.game.checkKO(target);
    if (extraShake) this.game.fx.shake(extraShake, 0.2);
  }

  /* ================= 小鲸 · 鲸鱼摆尾 ================= */
  /* 摆尾时间轴：蓄力 → 转身（背对镜头）→ 尾巴贴着身前抽出弧光 → 收势 */
  tailTimeline() {
    const s = this.skill;
    const t = (s && s.id === 'tail') ? C01((s.t || 0) / 0.95) : 0;
    const wind = SM(C01(t / 0.20));
    const whip = SM(C01((t - 0.20) / 0.24));
    const back = SM(C01((t - 0.66) / 0.30));
    // 转身：0 = 面朝对手，1 = 背朝对手（横向缩放穿过 0，视觉上原地转过去）
    const turn = SM(C01((t - 0.14) / 0.18)) * (1 - SM(C01((t - 0.56) / 0.24)));
    return { t, wind, whip, back, turn };
  }

  /* 尾尖扫过的弧光：从身后低位抡过背脊，抽到身前 */
  drawTailSweep(ctx, px, py, pose) {
    const TL = this.tailTimeline();
    if (TL.whip <= 0.02 || !window.drawTailArc) return;
    const fade = 1 - C01((TL.t - 0.68) / 0.24);
    if (fade <= 0.01) return;
    ctx.save();
    ctx.translate(px, py - 50 * (this.def.scale || 1));
    window.drawTailArc(ctx, {
      facing: this.facing,
      scale: this.def.scale || 1,
      r0: 26, r1: 60,
      aEnd: 140 + 210 * TL.whip,          // 140°=身后下侧 → 350°=身前上侧（屏幕坐标，y 向下）
      aLen: 92,
      alpha: 0.95 * fade * C01(TL.whip * 2.4)
    });
    ctx.restore();
  }

  startTail(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    this.skill = { id: 'tail', t: 0, hits: 0, ghostT: 0 };
    this.invuln = 1.05;            // 整个技能全程无敌
    audio.charge();
    this.game.announce(this.def.skills.s1, this.def.color);
    fx.ring(this.x, this.y - 92, 34, this.def.color, 0.3, 3);
    fx.spark(this.x - this.facing * 26, this.y - 96, this.elem, 1.2, 8);
    fx.text(this.x, this.y - 168, '无敌', '#9fd8ff', 11);
  }

  updateTail(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    // 无敌帧：整个摆尾过程都不吃伤害
    this.invuln = Math.max(this.invuln, 0.08);
    this.vx *= 0.82;

    const TL = this.tailTimeline();

    // 尾巴甩出去的水花
    s.ghostT -= dt;
    if (s.ghostT <= 0 && TL.whip > 0.02 && TL.whip < 0.9) {
      s.ghostT = 0.05;
      const ang = (140 + 210 * TL.whip) * Math.PI / 180;
      const len = 50 * (this.def.scale || 1);
      fx.parts.push({
        x: this.x + this.facing * Math.cos(ang) * len,
        y: this.y - 50 * (this.def.scale || 1) + Math.sin(ang) * len,
        vx: this.facing * 110 + (Math.random() - 0.5) * 70,
        vy: -70 - Math.random() * 80,
        life: 0.34, max: 0.4, size: 2.4, color: Math.random() < 0.5 ? '#bfe4ff' : '#ffffff',
        g: 420, drag: 1.2
      });
    }

    const sweep = (t0, range, dmg, kb, heavy) => {
      if (s.hits >= 1 && !heavy) return;
      if (heavy && s.hits >= 2) return;
      if (s.t < t0) return;
      s.hits = heavy ? 2 : 1;
      const dx = Math.abs(opp.x - this.x);
      if (dx < range && Math.abs(opp.y - this.y) < 120 && opp.state !== 'ko' && opp.invuln <= 0) {
        const M = {
          name: heavy ? '尾扫' : '摆尾', dmg, reach: range, hi: -120, lo: -16, kb,
          hitstun: heavy ? 0.45 : 0.26, blockstun: 0.16, sfx: 'kick', rage: RAGE.hit
        };
        this.applyHit(opp, M, 1);
        fx.spark(this.x + this.facing * 52, this.y - (heavy ? 70 : 58), '#bfe4ff', 1.3, heavy ? 18 : 10);
      } else {
        audio.whiff();
      }
      // 尾巴扫出去的气流
      fx.ring(this.x + this.facing * 56, this.y - 62, 26, '#9fd8ff', 0.2, 2);
      if (heavy) { audio.heavy(); fx.shake(9, 0.26); }
      else audio.whiff();
    };

    sweep(0.40, 74, 26, 46, false);
    sweep(0.60, 86, 34, 300, true);

    if (s.t > 0.95) this.endSkill();
  }

  /* ================= 小鲸 · 三碗大米饭（U 技能1，不耗怒气） ================= */
  startRice(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    this.skill = { id: 'rice', t: 0, fired: 0 };
    this.invuln = 0.72;
    audio.riceVoice();
    audio.charge();
    this.game.announce(this.def.skills.s1, this.def.color);
    fx.ring(this.x, this.y - 96, 44, this.def.color, 0.32, 2);
    fx.spark(this.x + this.facing * 22, this.y - 106, '#fff6e2', 1.1, 8);
  }

  updateRice(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);
    this.vx *= 0.9;

    if (s.t < 0.26 && Math.random() < 0.5) {
      const a = Math.random() * Math.PI * 2, r = 40 + Math.random() * 22;
      fx.parts.push({
        x: this.x + Math.cos(a) * r, y: this.y - 100 + Math.sin(a) * r,
        vx: -Math.cos(a) * 100, vy: -Math.sin(a) * 100,
        life: 0.26, max: 0.26, size: 2, color: '#fff6e2', g: 0, drag: 0
      });
    }

    // 连丢三碗：全部直线平飞（不同高度不同速度），前两碗推人、最后一碗轰飞倒地
    const BOWLS = [
      { at: 0.24, vx: 430, dy: -96, dmg: 9.66, kb: 260 },
      { at: 0.34, vx: 450, dy: -108, dmg: 9.66, kb: 260 },
      { at: 0.44, vx: 480, dy: -100, dmg: 12.41, kb: 430 }
    ];
    for (let i = s.fired; i < BOWLS.length; i++) {
      const b = BOWLS[i];
      if (s.t < b.at) break;
      s.fired = i + 1;
      if (i === 0) audio.heavy();
      fx.spark(this.x + this.facing * 34, this.y + b.dy, '#fff6e2', 1.2, 10);
      this.game.spawnProjectile({
        owner: this,
        x: this.x + this.facing * 26,
        y: this.y + b.dy,
        vx: this.facing * b.vx,
        vy: 0,
        g: 0,
        color: '#fff6e2',
        dmg: b.dmg,
        type: 'rice',
        life: 2.6,
        radius: 24,
        kb: b.kb
      });
    }

    if (s.t > 0.8) this.endSkill();
  }

  /* ================= 小鲸 · 鲸鱼喷水（I 技能2，50 怒气） ================= */
  startSpray(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    this.skill = { id: 'spray', t: 0, fired: 0, started: false };
    this.invuln = 1.5;
    audio.waterVoice();
    audio.charge();
    this.game.announce(this.def.skills.s2, this.def.color);
    fx.flash(this.def.color, 0.16, 0.12);
    this.game.cinematic(0.6);
    for (let i = 0; i < 2; i++) fx.ring(this.x, this.y - 110, 54 + i * 24, this.def.color, 0.5, 2);
  }

  updateSpray(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);
    this.vx *= 0.88;

    // 蓄力：水珠往嘴边汇
    if (s.t < 0.34 && Math.random() < 0.7) {
      const a = Math.random() * Math.PI * 2, r = 44 + Math.random() * 30;
      fx.parts.push({
        x: this.x + this.facing * 16 + Math.cos(a) * r,
        y: this.y - 116 + Math.sin(a) * r * 0.6,
        vx: -Math.cos(a) * 150, vy: -Math.sin(a) * 150 * 0.6,
        life: 0.26, max: 0.26, size: 2.2, color: Math.random() < 0.5 ? '#bfe4ff' : '#ffffff',
        g: 0, drag: 0
      });
    }

    // 喷水起手：一口老海水
    if (s.t >= 0.34 && !s.started) {
      s.started = true;
      audio.boom();
      fx.shake(7, 0.3);
      fx.stop(0.04);
      fx.text(this.x, this.y - 180, '噗——!', '#9fd8ff', 14);
    }

    // 水柱：连发水弹，每一发都把对手往后冲（击退）
    const START = 0.34, END = 1.22, GAP = 0.062;
    while (s.t >= START + s.fired * GAP && s.t < END) {
      const last = START + Math.floor((END - START) / GAP - 0.5) * GAP;
      const isLast = START + s.fired * GAP >= last;
      s.fired++;
      const wobble = (Math.random() - 0.5) * 36;
      this.game.spawnProjectile({
        owner: this,
        x: this.x + this.facing * 56,
        // 口腔高度约 y-96：正好落在对手受击框（离地 -4 ~ -90）的胸口位置
        y: this.y - 96 + wobble * 0.4,
        vx: this.facing * (430 + Math.random() * 60),
        vy: wobble * 0.5,
        color: '#8fd0ff',
        dmg: isLast ? 11.9 : 5.17,
        type: 'water',
        life: 1.15,
        radius: isLast ? 40 : 18,
        kb: isLast ? 430 : 300
      });
      if (isLast) {
        audio.heavy();
        fx.shake(8, 0.24);
      }
    }

    if (s.t > 1.5) this.endSkill();
  }

  /* ================= 大狗 · 犬吠音波 ================= */
  startBark(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    const shout = Math.max(0.6, Math.min(2.0, audio.dogBarkLen || 1.0));
    this.skill = { id: 'bark', t: 0, fired: 0, waves: 0, shout };
    this.invuln = Math.max(1.15, shout);
    // 时停：咆哮期间对手无法行动
    this.lockOpponent(opp, Math.max(1.5, shout + 0.15));
    audio.bark(1.0, 0.7);   // 起手完整大狗叫一次，作为整个技能配音
    audio.charge();
    this.game.announce(this.def.skills.s3, '#ffcf5c');
    fx.flash('#ffb03a', 0.14, 0.12);
    this.game.cinematic(Math.min(1.2, shout));
    for (let i = 0; i < 3; i++) {
      fx.ring(this.x, this.y - 95, 70 + i * 26, this.def.color, 0.5, 2);
    }
  }

  updateBark(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);
    this.vx *= 0.8;

    // 蓄力粒子向身体汇聚
    if (s.t < 0.42 && Math.random() < 0.55) {
      const a = Math.random() * Math.PI * 2, r = 70 + Math.random() * 40;
      fx.parts.push({
        x: this.x + Math.cos(a) * r, y: this.y - 90 + Math.sin(a) * r,
        vx: -Math.cos(a) * 130, vy: -Math.sin(a) * 130,
        life: 0.3, max: 0.3, size: 2, color: this.def.color, g: 0, drag: 0
      });
    }

    if (s.t >= 0.42 && s.fired === 0) {
      s.fired = 1;
      // 起手大狗叫已覆盖技能配音，三连吠只加很轻的高音点缀，不再重复整段配音
      audio.bark(1.3, 0.16);
      audio.bark(1.45, 0.14, 0.1);
      audio.bark(1.6, 0.12, 0.2);
      audio.boom();
      fx.flash('#ffffff', 0.42, 0.12);
      fx.shake(16, 0.5);
      fx.stop(0.1);
      fx.cone(this.x + this.facing * 74, this.y - 104, this.facing, 230, 'rgba(255,196,90,.8)', 0.5, 0.58);
      fx.cone(this.x + this.facing * 74, this.y - 104, this.facing, 140, 'rgba(255,255,255,.9)', 0.34, 0.4);
      fx.ring(this.x + this.facing * 30, this.y - 96, 76, '#fff6d0', 0.4, 4);
      fx.spark(this.x + this.facing * 50, this.y - 95, '#ffe9a8', 1.6, 22);
      for (let i = 0; i < 6; i++) fx.text(this.x + this.facing * (92 + i * 24), this.y - 108 - i * 14, '汪!', '#ffd166', 14);
      this.game.shakeScreenBig();
    }

    // 三道音波依次射出：前两道推人，第三道轰飞倒地
    const spawnAt = [0.42, 0.56, 0.7];
    const WAVE_DMG = [40, 43, 47];
    while (s.waves < 3 && s.t >= spawnAt[s.waves]) {
      s.waves++;
      const last = s.waves === 3;
      this.game.spawnProjectile({
        owner: this,
        x: this.x + this.facing * 76,
        y: this.y - 100 + (s.waves - 2) * 10,
        vx: this.facing * (400 + s.waves * 20),
        color: last ? '#fff2c2' : this.def.color,
        dmg: WAVE_DMG[s.waves - 1],
        type: 'sonic',
        life: 1.25,
        radius: 30,
        kb: last ? 430 : 260
      });
    }

    if (s.t > 1.15) this.endSkill();
  }

  /* ================= 通用技能 ================= */
  startRush(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    this.skill = { id: 'rush', t: 0, hits: 0 };
    this.invuln = 0.75;
    if (this.def.id === 'frost') audio.cry('frost', 'L');
    if (this.def.id === 'spade') audio.cry('spade', 'L');
    audio.charge();
    this.game.announce(this.def.skills.s1, this.def.color);
    fx.ring(this.x, this.y - 85, 56, this.def.color, 0.35, 3);
  }

  updateRush(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);
    const dir = Math.sign(opp.x - this.x) || this.facing;
    this.facing = dir;

    if (s.t < 0.12) { this.vx = 0; return; }
    this.vx = dir * 250 * (s.hits < 4 ? 1 : 0);

    const gap = 0.12;
    const nextT = 0.12 + s.hits * gap;
    if (s.hits < 4 && s.t >= nextT) {
      s.hits++;
      const inRange = Math.abs(opp.x - this.x) < 78;
      if (inRange && opp.state !== 'ko') {
        const M = {
          name: 'hl', dmg: 9.46, reach: 50, hi: -130, lo: -40, kb: s.hits === 4 ? 240 : 40,
          hitstun: 0.24, blockstun: 0.14, sfx: 'punch', rage: RAGE.hit
        };
        this.applyHit(opp, M, 1);
        fx.spark(this.x + dir * 40, this.y - 100, this.elem, 1.1, 8);
        if (s.hits === 4) {
          fx.ring(this.x + dir * 46, this.y - 100, 60, '#fff', 0.3, 4);
          fx.shake(9, 0.26);
          audio.heavy();
        }
      } else {
        audio.whiff();
      }
    }
    if (s.t > 0.12 + 4 * gap + 0.2) this.endSkill();
  }

  /* ================= 霜龙 · 冰晶穿刺（U） ================= */
  startIceSpike(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    this.skill = { id: 'icespike', t: 0, fired: false };
    this.invuln = 0.6;
    audio.cry('frost', 'L');
    audio.charge();
    this.game.announce(this.def.skills.s1, this.def.color);
    fx.ring(this.x, this.y - 95, 52, this.def.color, 0.35, 3);
    // 脚下生出的冰晶（参考设定图：一圈冰锥从地面炸开）
    fx.dustRing(this.x, this.y, 'rgba(200,235,255,.55)');
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI + Math.random() * Math.PI * 2;
      const r = 20 + Math.random() * 46;
      fx.parts.push({
        x: this.x + Math.cos(a) * r, y: this.y - 4,
        vx: Math.cos(a) * 40, vy: -140 - Math.random() * 120,
        life: 0.42, max: 0.42, size: 2 + ((Math.random() * 3) | 0),
        color: Math.random() < 0.5 ? '#dff3ff' : '#9fd8ff', g: 420, drag: 1.2
      });
    }
  }

  updateIceSpike(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);
    this.vx = 0;
    // 蓄力：碎冰朝掌心汇聚，四周浮起冰片
    if (s.t < 0.2) {
      const px = this.x + this.facing * 46, py = this.y - 104;
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2, r = 40 + Math.random() * 40;
        const sx = px + Math.cos(a) * r, sy = py + Math.sin(a) * r;
        fx.parts.push({
          x: sx, y: sy, vx: (px - sx) * 3.4, vy: (py - sy) * 3.4,
          life: 0.2, max: 0.2, size: 2 + ((Math.random() * 2) | 0),
          color: Math.random() < 0.5 ? '#eaf8ff' : '#bfe4ff', g: 0, drag: 0
        });
      }
      if (Math.random() < 0.35) {
        fx.parts.push({
          x: this.x + (Math.random() - 0.5) * 130, y: this.y - Math.random() * 150,
          vx: 0, vy: -26 - Math.random() * 26,
          life: 0.6, max: 0.6, size: 2 + ((Math.random() * 3) | 0),
          color: '#dff3ff', g: -10, drag: 0
        });
      }
    }
    if (!s.fired && s.t >= 0.2) {
      s.fired = true;
      audio.whiff(); audio.heavy();
      fx.flash('#cfeaff', 0.22, 0.08);
      // 巨型冰晶锥（图一里那根贯穿画面的菱形冰刺）
      this.game.spawnProjectile({
        owner: this, x: this.x + this.facing * 56, y: this.y - 104,
        vx: this.facing * 600, color: '#bfe4ff',
        dmg: 21.7, type: 'ice', life: 1.5, radius: 36,
        pierce: true, kb: 130
      });
      // 伴随碎裂的小冰锥（高度压在大冰锥下方，两枚都能打到胸口高度的对手）
      for (let i = 0; i < 2; i++) {
        this.game.spawnProjectile({
          owner: this, x: this.x + this.facing * 40, y: this.y - 92 + (i ? 16 : 0),
          vx: this.facing * (430 + i * 40), color: '#dff3ff',
          dmg: 4.49, type: 'ice', life: 1.0, radius: 16,
          pierce: true, kb: 60
        });
      }
      fx.spark(this.x + this.facing * 60, this.y - 104, '#e8f7ff', 1.6, 18);
      fx.ring(this.x + this.facing * 54, this.y - 104, 70, '#dff3ff', 0.3, 4);
      fx.shake(7, 0.16);
    }
    if (s.t > 0.55) this.endSkill();
  }

  /* ================= 霜龙 · 秘技·龙爪手（I）：近身固定范围，一爪挥出 ================= */
  startDragonClaw(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    this.skill = { id: 'dragonclaw', t: 0, windup: 0.72, struck: false };
    this.invuln = 1.0;
    audio.cry('frost', 'S2');
    audio.charge();
    this.game.announce(this.def.skills.s2, '#b07cff');
    fx.flash('#6a3fd6', 0.16, 0.1);
    this.game.cinematic(0.9);
    for (let i = 0; i < 2; i++) {
      fx.ring(this.x + this.facing * 24, this.y - 74, 28 + i * 22, '#a673ff', 0.4, 2);
    }
    fx.spark(this.x + this.facing * 26, this.y - 74, '#c9a4ff', 1.2, 12);
  }

  updateDragonClaw(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);
    const dir = Math.sign(opp.x - this.x) || this.facing;
    this.facing = dir;
    const hx = this.x + dir * 34, hy = this.y - 74;

    // 前摇：黑气与紫电在掌心汇聚（参考图：巨爪从手心伸出）
    if (s.t < s.windup) {
      this.vx = dir * 20;
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2, r = 24 + Math.random() * 26;
        const px = hx + Math.cos(a) * r, py = hy + Math.sin(a) * r;
        fx.parts.push({
          x: px, y: py, vx: (hx - px) * 4, vy: (hy - py) * 4,
          life: 0.18, max: 0.18, size: 2 + ((Math.random() * 2) | 0),
          color: Math.random() < 0.55 ? '#c9a4ff' : '#4b2a7a', g: 0, drag: 0
        });
      }
      if (Math.random() < 0.45) fx.ring(hx, hy, 14 + s.t * 50, '#a673ff', 0.16, 2);
    }

    // 一爪拍出：固定距离，命中即击飞
    if (!s.struck && s.t >= s.windup) {
      s.struck = true;
      audio.clawVoice(2);          // 爪子拍出的瞬间喊「龙爪手」
      audio.whiff(); audio.heavy();
      fx.flash('#7b4bd8', 0.2, 0.1);
      fx.shake(9, 0.24);
      fx.stop(0.04);
      this.game.spawnProjectile({
        owner: this, x: this.x + dir * 96, y: this.y - 74,
        vx: dir * 40, color: '#d8b4ff',
        dmg: 100, type: 'claw', life: 0.34, radius: 100,
        pierce: true, kb: 430
      });
      fx.ring(this.x + dir * 96, this.y - 74, 100, '#a673ff', 0.3, 4);
      fx.spark(this.x + dir * 130, this.y - 74, '#c9a4ff', 1.2, 14);
    }
    if (s.struck) this.vx *= 0.86;
    if (s.t > s.windup + 0.45) this.endSkill();
  }

  /* ================= 霜龙 · 秘技·火球术（O） ================= */
  startFireball(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    this.skill = { id: 'fireball', t: 0, fired: false, windup: 0.55 };
    this.invuln = 1.1;
    // 时停：蓄力期间对手无法行动
    this.lockOpponent(opp, 1.5);
    audio.fireVoice();
    audio.charge();
    this.game.announce(this.def.skills.s3, '#ff9a3c');
    fx.flash('#ffb060', 0.18, 0.12);
    this.game.cinematic(0.7);
    for (let i = 0; i < 2; i++) fx.ring(this.x, this.y - 167 * (this.def.scale || 1), 34 + i * 22, '#ff8a3c', 0.5, 2);
  }

  /* 嘴的位置（脚底往上一截，略微朝前）。高度按体型缩放，换模型大小后不会跑位 */
  mouthPos() {
    return { x: this.x + this.facing * 18, y: this.y - 180 * (this.def.scale || 1) };
  }

  updateFireball(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);
    this.vx = 0;
    const W = s.windup;
    const m = this.mouthPos();
    // 前摇：仰头，火光往嘴里吸
    if (s.t < W) {
      const p = s.t / W;
      for (let i = 0; i < 4; i++) {
        const a = Math.random() * Math.PI * 2, r = 34 + Math.random() * 26;
        const px = m.x + Math.cos(a) * r, py = m.y + Math.sin(a) * r;
        fx.parts.push({
          x: px, y: py,
          vx: (m.x - px) * 3.6, vy: (m.y - py) * 3.6,
          life: 0.22, max: 0.22, size: 2 + ((Math.random() * 2) | 0),
          color: Math.random() < 0.5 ? '#ffce6a' : '#ff7a2c', g: 0, drag: 0
        });
      }
      if (Math.random() < 0.5) fx.ring(m.x, m.y, 8 + p * 20, '#ffb060', 0.16, 2);
    }
    if (!s.fired && s.t >= W) {
      s.fired = true;
      fx.flash('#ffd9a0', 0.4, 0.12);
      audio.heavy();
      fx.spark(m.x + this.facing * 26, m.y, '#ffe08a', 1.6, 16);
      // 喷出一个持续燃烧的大火球：慢慢推进，碰到人就贴着烧，喷火结束就消失
      this.game.spawnProjectile({
        owner: this, x: m.x + this.facing * 52, y: this.y - 162 * (this.def.scale || 1),
        vx: this.facing * 190, color: '#ff8a2c',
        dmg: 16, type: 'fire', life: 1.3, radius: 30, rMax: 62,
        kb: 70, beam: true, maxHits: 8, rehit: 0.13
      });
    }
    // 喷火：从嘴前持续往火球上浇
    if (s.fired) {
      for (let i = 0; i < 4; i++) {
        const k = Math.random();
        fx.parts.push({
          x: m.x + this.facing * (14 + k * 26), y: m.y + (Math.random() - 0.5) * 14,
          vx: this.facing * (220 + Math.random() * 190), vy: (Math.random() - 0.5) * 50,
          life: 0.22, max: 0.22, size: 2 + ((Math.random() * 3) | 0),
          color: k < 0.4 ? '#ffe08a' : k < 0.75 ? '#ff9a3c' : '#ff5a1c', g: -40, drag: 1.2
        });
      }
      if (Math.random() < 0.3) {
        fx.parts.push({
          x: m.x + this.facing * (30 + Math.random() * 30), y: m.y + (Math.random() - 0.5) * 20,
          vx: this.facing * (60 + Math.random() * 80), vy: -30 - Math.random() * 40,
          life: 0.5, max: 0.5, size: 5 + ((Math.random() * 4) | 0),
          color: '#5a4640', g: -20, drag: 1.6
        });
      }
      if (Math.random() < 0.3) fx.ring(this.x + this.facing * 74, this.y - 126, 44 + Math.random() * 16, '#ff8a2c', 0.2, 2);
    }
    if (s.t > W + 1.35) this.endSkill();
  }

  /* ================= 跳跳 · 百万吨拳踢（U） ================= */
  startFlurry(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    this.skill = { id: 'flurry', t: 0, hits: 0, kicked: false };
    this.invuln = 0.9;
    audio.cry('hopper', 'L');
    this.game.announce(this.def.skills.s1, this.def.color);
    fx.ring(this.x, this.y - 90, 50, this.def.color, 0.3, 3);
  }

  updateFlurry(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);
    const dir = Math.sign(opp.x - this.x) || this.facing;
    this.facing = dir;
    const dist = Math.abs(opp.x - this.x);
    this.vx = dist > 62 ? dir * 210 : 0;

    // 四记快拳
    const gap = 0.18;
    const punchT = 0.12 + s.hits * gap;
    if (s.hits < 4 && s.t >= punchT) {
      s.hits++;
      if (dist < 88 && opp.state !== 'ko') {
        this.applyHit(opp, {
          name: 'hf', dmg: 5.95, reach: 50, hi: -130, lo: -40, kb: 24,
          hitstun: 0.16, blockstun: 0.12, sfx: 'punch', rage: RAGE.hit
        }, 1);
      }
    }

    // 收尾一脚踢飞（击退控制得比较近）
    if (!s.kicked && s.t >= 1.0) {
      s.kicked = true;
      this.vx = dir * 120;
      if (Math.abs(opp.x - this.x) < 96 && opp.state !== 'ko') {
        this.applyHit(opp, {
          name: 'hk', dmg: 16.23, reach: 70, hi: -120, lo: -30, kb: 205,
          hitstun: 0.36, blockstun: 0.2, sfx: 'kick', knockdown: true, rage: RAGE.hit
        }, 1);
        fx.ring(this.x + dir * 56, this.y - 90, 62, '#fff', 0.32, 4);
        fx.shake(9, 0.26);
      }
    }
    if (s.t > 1.35) this.endSkill();
  }

  /* ================= 跳跳 · 胆子肥嘟嘟（O）：召唤外卖车连撞 ================= */
  startBike(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    // 整段台词只播放一次；说到“你的胆子真”时提前出车，后半句继续播
    const shout = Math.max(0.8, Math.min(3.2, Number(audio.hopperVoiceLen) || 1.8));
    const release = Math.max(0.35, Math.min(shout - 0.2, shout * 0.52));
    this.skill = { id: 'bike', t: 0, fired: false, shout, release };
    this.invuln = shout;
    // 时停：喊台词蓄力期间对手动不了，只能用幻影闪避（S+L）脱身
    this.releaseLock();
    if (opp && opp.state !== 'ko' && opp.state !== 'grabbed') {
      this.lockedTarget = opp;
      opp.lockT = 1.5;
      opp.vx = 0;
    }
    audio.cry('hopper', 'S3');
    this.game.announce(this.def.skills.s3, '#ff7a3c');
    this.game.cinematic(Math.min(1.2, release));
    fx.flash('#ffd88a', 0.2, 0.12);
    fx.ring(this.x, this.y - 95, 58, '#ffcf5a', 0.45, 3);
  }

  updateBike(dt, opp) {
    const s = this.skill, fx = this.game.fx;
    s.t += dt;
    this.vx = 0;
    if (s.t < s.release) {
      // 前半句喊话蓄力：金色气场
      if (Math.random() < 0.5) {
        const a = Math.random() * Math.PI * 2;
        fx.parts.push({
          x: this.x + Math.cos(a) * 46, y: this.y - 92 + Math.sin(a) * 46,
          vx: -Math.cos(a) * 120, vy: -Math.sin(a) * 120,
          life: 0.3, max: 0.3, size: 2, color: '#ffe38a', g: 0, drag: 0
        });
      }
      return;
    }
    if (!s.fired) {
      s.fired = true;
      const dir = this.facing;
      const bx = this.x + dir * 52, by = this.y - 33;
      this.vx = dir * 90;
      this.game.spawnProjectile({
        owner: this, x: bx, y: by,
        vx: dir * 300, color: '#ff6a3c',
        dmg: 37.5, type: 'bike', life: 1.7, radius: 72, kb: 40,
        maxHits: 4, rehit: 0.26, finalKb: 360
      });
      // 召唤爆发：白黄爆闪、双层气浪、贴地尘环和放射速度线
      fx.flash('#fff1b0', 0.48, 0.14);
      fx.shake(16, 0.36);
      fx.stop(0.045);
      fx.ring(bx, by - 18, 152, '#fff2a8', 0.46, 8);
      fx.ring(bx, by - 18, 104, '#ff8732', 0.34, 5);
      fx.rings.push({ x: bx, y: VIEW.GROUND - 3, r: 4, maxR: 178, life: 0.52, max: 0.52,
        color: '#ffd76a', w: 7, flat: 0.24 });
      fx.spark(bx, by - 18, '#fff3b0', 2.2, 34);
      fx.spark(bx, by - 12, '#ff7a2e', 1.8, 24);
      fx.dust(bx, VIEW.GROUND - 3, '#ffe0a0', 24, 2.1, -dir);
      fx.dust(bx - dir * 18, VIEW.GROUND - 3, '#b9a68c', 18, 1.6, -dir);
      for (let i = 0; i < 12; i++) fx.speedLine(bx - dir * (18 + (i % 3) * 12), by - 30, -dir);
      fx.text(bx + dir * 36, by - 108, '轰！', '#fff0a0', 28);
    }
    if (s.t > s.shout + 0.6) this.endSkill();
  }

  /* ================= 黑桃 · 过肩摔（I） =================
     前冲抓人 → 扛到肩上 → 砸向地面 → 撞地反弹再击飞 */
  startShoulderThrow(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    this.skill = { id: 'shoulderthrow', t: 0, phase: 0, grabbed: null, bounced: false, gx0: 0 };
    this.invuln = 1.6;
    audio.cry('spade', 'UL');
    audio.charge();
    this.game.announce(this.def.skills.s2, this.def.color);
    this.game.shakeScreenBig();
    fx.flash('#fff', 0.2, 0.1);
    fx.ring(this.x, this.y - 90, 64, this.def.color, 0.42, 3);
  }

  updateShoulderThrow(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);
    const dir = this.facing;

    // 0 起手：压低重心
    if (s.phase === 0) {
      this.vx = 0;
      if (s.t > 0.22) {
        s.phase = 1; s.t = 0;
        this.vx = dir * 720;
        fx.dust(this.x, this.y, '#cfd6e6', 8, 0.9);
      }
      return;
    }

    // 1 前冲抓取
    if (s.phase === 1) {
      this.vx = dir * 720;
      const dx = Math.abs(opp.x - this.x);
      if (dx < 92 && Math.abs(opp.y - this.y) < 100 && opp.state !== 'ko' && opp.invuln <= 0) {
        s.phase = 2; s.t = 0; s.grabbed = opp;
        s.gx0 = opp.x;
        opp.state = 'grabbed'; opp.blocking = false;
        opp.vx = 0; opp.vy = 0; opp.grabT = 0; opp.prone = false; opp.hitstun = 99;
        this.vx = 0;
        this.x = opp.x - dir * 24;
        fx.flash('#fff', 0.4, 0.07); fx.stop(0.1); fx.shake(6, 0.16);
        fx.ring(opp.x, opp.y - 86, 58, '#fff', 0.28, 4);
        fx.text(opp.x, opp.y - 168, '抓住了！', '#ffe9a8', 14);
        audio.heavy();
        return;
      }
      if (s.t > 0.5) {
        this.vx = 0;
        fx.dust(this.x, this.y, '#cfd6e6', 8, 0.9);
        audio.land();
        this.endSkill();
      }
      return;
    }

    const g = s.grabbed;
    if (!g || g.state === 'ko') { this.endSkill(); return; }

    // 2 双手举过头顶：身体横过来，绕身体中段旋转（所有角色共用同一套举人模板）
    if (s.phase === 2) {
      const k = Math.min(1, s.t / 0.34);
      const e = k * k * (3 - 2 * k);
      const up = liftPivot(g);
      const rot = dir * 1.45 * e;
      const cx = s.gx0 + (this.x + dir * 26 - s.gx0) * e;
      const cy = (VIEW.GROUND - up) + (this.y - 120 - (VIEW.GROUND - up)) * e;
      g.liftUp = up; g.liftRot = rot;
      g.x = cx - Math.sin(rot) * up;
      g.y = cy + Math.cos(rot) * up;
      g.prone = false;
      if (s.t > 0.34) {
        s.phase = 3; s.t = 0;
        fx.ring(cx, cy, 46, '#cdb8ff', 0.34, 3);
        fx.dustRing(this.x, this.y, 'rgba(205,184,255,.55)');
      }
      return;
    }

    // 3 横着抡起来砸向地面
    if (s.phase === 3) {
      const k = Math.min(1, s.t / 0.2);
      const e = k * k;
      const up = liftPivot(g);
      const rot = dir * 1.45;
      const cx = this.x + dir * (26 + 92 * e);
      const cy = (this.y - 120) + (VIEW.GROUND - 26 - (this.y - 120)) * e;
      g.liftUp = up; g.liftRot = rot;
      g.x = cx - Math.sin(rot) * up;
      g.y = cy + Math.cos(rot) * up;
      g.prone = false;
      if (s.t > 0.2) {
        s.phase = 4; s.t = 0;
        g.liftRot = 0;
        g.x = this.x + dir * 118;
        g.y = VIEW.GROUND; g.prone = true;
        fx.dustRing(g.x, VIEW.GROUND, 'rgba(255,226,190,.7)');
        fx.ring(g.x, VIEW.GROUND - 6, 78, '#ffd166', 0.34, 5);
        fx.shake(17, 0.42); fx.stop(0.12); fx.flash('#fff', 0.42, 0.1);
        fx.spark(g.x, VIEW.GROUND - 18, '#ffcf6b', 1.8, 22);
        fx.text(g.x, VIEW.GROUND - 128, 'SLAM!', '#fff', 16);
        audio.heavy(); audio.boom();
        this.dealSkillDamage(g, 36, '#ffd166', 14);
      }
      return;
    }

    // 4 撞地反弹，再打飞出去
    if (s.phase === 4) {
      if (!s.bounced) {
        g.state = 'grabbed'; g.hitstun = 99; g.y = VIEW.GROUND; g.prone = true; g.liftRot = 0; g.invuln = 0;
        if (s.t > 0.14) {
          s.bounced = true;
          const M = {
            name: 'throw', dmg: 42, reach: 0, hi: -999, lo: 999, kb: 470, launch: true,
            hitstun: 0.7, blockstun: 0, sfx: 'heavy', rage: RAGE.hit
          };
          this.applyHit(g, M, 1);
          g.vx = dir * 560;
          fx.ring(g.x, g.y - 40, 66, '#fff', 0.3, 4);
          fx.spark(g.x, g.y - 52, '#ffe0a8', 1.5, 18);
          fx.shake(11, 0.32);
          audio.heavy();
        }
      } else if (s.t > 0.55) {
        this.endSkill();
      }
      return;
    }
  }

  startBurst(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    this.skill = { id: 'burst', t: 0, fired: false };
    this.invuln = 1.1;
    audio.charge();
    this.game.announce(this.def.skills.s2, this.def.color);
    fx.flash(this.def.color, 0.18, 0.12);
    this.game.cinematic(0.7);
    for (let i = 0; i < 2; i++) fx.ring(this.x, this.y - 95, 60 + i * 30, this.def.color, 0.5, 2);
  }

  updateBurst(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);
    if (s.t < 0.34 && Math.random() < 0.6) {
      const a = Math.random() * Math.PI * 2, r = 66 + Math.random() * 40;
      fx.parts.push({
        x: this.x + Math.cos(a) * r, y: this.y - 90 + Math.sin(a) * r,
        vx: -Math.cos(a) * 120, vy: -Math.sin(a) * 120,
        life: 0.3, max: 0.3, size: 2, color: this.def.color, g: 0, drag: 0
      });
    }
    if (!s.fired && s.t >= 0.34) {
      s.fired = true;
      audio.boom(); audio.heavy();
      fx.flash('#fff', 0.4, 0.12);
      fx.shake(12, 0.4);
      this.game.shakeScreenBig();
      this.game.spawnProjectile({
        owner: this, x: this.x + this.facing * 66, y: this.y - 92,
        vx: this.facing * GENERIC.burst.speed, color: this.def.color,
        dmg: GENERIC.burst.dmg, type: 'orb', life: 1.4, radius: 34
      });
      fx.spark(this.x + this.facing * 46, this.y - 96, this.elem, 1.4, 16);
    }
    if (s.t > 0.95) this.endSkill();
  }

  /* ================= 奶娃 · 宇宙无敌大力拳（U） =================
     蓄力后一记重拳：命中把对手打飞很远 */
  startMegaPunch(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    this.skill = { id: 'megapunch', t: 0, fired: false, windup: 0.5, dashT: 0, struck: false, ghostT: 0 };
    this.invuln = 0.85;
    audio.charge();
    this.game.announce(this.def.skills.s1, this.def.color);
    fx.flash('#ffd83d', 0.14, 0.1);
    fx.ring(this.x, this.y - 95, 40, this.def.color, 0.3, 3);
    this.game.cinematic(0.55);
  }

  updateMegaPunch(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);
    this.vx = 0;
    const W = s.windup;
    const px0 = this.x + this.facing * 46, py0 = this.y - 96;

    // 蓄力：气流往拳心收，拳头越攥越紧
    if (s.t < W) {
      const p = s.t / W;
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2, r = 40 + Math.random() * 30;
        const px = px0 + Math.cos(a) * r, py = py0 + Math.sin(a) * r;
        fx.parts.push({
          x: px, y: py,
          vx: (px0 - px) * 3.2, vy: (py0 - py) * 3.2,
          life: 0.2, max: 0.2, size: 2,
          color: Math.random() < 0.5 ? '#fff3c2' : this.elem, g: 0, drag: 0
        });
      }
      if (Math.random() < 0.4) fx.ring(px0, py0, 10 + p * 26, '#ffe066', 0.16, 2);
      if (Math.random() < 0.25) fx.shake(2, 0.08);
      return;
    }

    if (!s.fired) {
      s.fired = true;
      s.dashT = 0.3;
      audio.cry('naiwa', 'L');      // 拳头打出去的瞬间喊「安迪」
      audio.heavy(); audio.boom();
      fx.flash('#fff6cc', 0.3, 0.1);
      fx.shake(11, 0.3);
      // 出拳残影 + 极短慢动作，强化"大力拳"的冲击感
      this.spawnGhost(0.45);
      this.game.ts = 0.42;
      this.game.slowT = 0.16;
      fx.ring(this.x + this.facing * 60, this.y - 96, 52, '#ffe066', 0.26, 4);
    }

    // 出拳后连人带拳向前冲，把攻击距离顶出去
    if (!s.struck && s.dashT > 0) {
      s.dashT -= dt;
      this.vx = this.facing * 1060 * Math.max(0.4, s.dashT / 0.3);
      if (Math.random() < 0.5) fx.dust(this.x, this.y, '#8b93a8', 1, 0.35);
      s.ghostT -= dt;
      if (s.ghostT <= 0) { s.ghostT = 0.05; this.spawnGhost(0.24); }
    }

    // 冲刺途中持续判定：撞上就命中
    if (!s.struck) {
      const dx = (opp.x - this.x) * this.facing;
      if (dx > -26 && dx < 124 && Math.abs(opp.y - this.y) < 180 && opp.state !== 'ko') {
        s.struck = true;
        s.dashT = 0;
        this.vx = 0;
        this.applyHit(opp, {
          name: '宇宙无敌大力拳', dmg: 40, reach: 124, hi: -190, lo: -24,
          kb: 540, hitstun: 0.6, blockstun: 0.3, sfx: 'punch', rage: RAGE.hit,
          knockdown: true
        }, 1);
        fx.ring(this.x + this.facing * 96, this.y - 96, 76, '#ffffff', 0.32, 5);
        fx.spark(this.x + this.facing * 96, this.y - 96, '#fff3c2', 1.8, 20);
        fx.shake(15, 0.42);
        fx.stop(0.09);
        audio.boom();
      } else if (s.dashT <= 0) {
        // 冲到头也没碰到人
        s.struck = true;
        audio.whiff();
        fx.ring(this.x + this.facing * 70, this.y - 96, 46, this.elem, 0.22, 3);
      }
    }
    if (s.t > W + 0.72) this.endSkill();
  }

  /* ================= 奶娃 · 捧腹大笑（I） =================
     双手捧腹大笑，笑声化作环形音波，把周围的人震飞 */
  startBellyLaugh(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    this.skill = { id: 'bellylaugh', t: 0, fired: false, windup: 0.55, waves: 0, nextWave: 0 };
    this.invuln = 1.3;
    // 时停：蓄力期间对手无法行动
    this.lockOpponent(opp, 1.5);
    audio.cry('naiwa', 'UL');
    audio.charge();
    this.game.announce(this.def.skills.s3, this.def.color);
    fx.flash('#ffe066', 0.2, 0.14);
    this.game.cinematic(0.6);
    fx.ring(this.x, this.y - 96, 34, this.def.color, 0.4, 3);
  }

  updateBellyLaugh(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);
    this.vx = 0;
    const W = s.windup;

    // 捧腹前摇：笑到身体发抖，肚皮周围冒气流
    if (s.t < W) {
      const p = s.t / W;
      if (Math.random() < 0.8) {
        const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 22;
        fx.parts.push({
          x: this.x + Math.cos(a) * r, y: this.y - 92 + Math.sin(a) * r,
          vx: Math.cos(a) * 40, vy: -30 - Math.random() * 30,
          life: 0.26, max: 0.26, size: 2, color: '#ffe066', g: 0, drag: 0.6
        });
      }
      if (Math.random() < 0.3) fx.ring(this.x, this.y - 92, 22 + p * 26, '#ffe066', 0.2, 2);
      if (Math.random() < 0.3) fx.shake(2, 0.08);
      return;
    }

    // 释放：笑声化作连续多段环形音波，一段一段往外砸
    if (!s.fired) {
      s.fired = true;
      s.waves = 0;
      s.nextWave = W;
      audio.boom(); audio.heavy();
      fx.flash('#fff3c2', 0.36, 0.14);
      this.game.shakeScreenBig();
    }

    if (s.waves < 3 && s.t >= s.nextWave) {
      const last = s.waves === 2;
      s.waves++;
      s.nextWave += 0.18;

      // 每段音波：一圈圈扩开的声波环
      for (let i = 0; i < 2; i++) {
        fx.ring(this.x, this.y - 96, 46 + i * 26 + s.waves * 16,
          last ? '#ffffff' : '#ffe066', last ? 0.55 : 0.42, last ? 6 : 4);
      }
      fx.shake(last ? 14 : 6, last ? 0.4 : 0.16);
      if (last) fx.stop(0.08);

      const reach = last ? 470 : 390;
      const dist = Math.abs(opp.x - this.x);
      if (dist < reach && Math.abs(opp.y - this.y) < 240 && opp.state !== 'ko') {
        // 前两段只压住并轻推，最后一段把对手击飞
        this.applyHit(opp, {
          name: '捧腹大笑', dmg: last ? 59.6 : 36.7, reach,
          hi: -240, lo: 80,
          kb: last ? 430 : 60,
          hitstun: last ? 0.45 : 0.18,
          blockstun: last ? 0.25 : 0.12,
          sfx: 'punch', rage: last ? RAGE.hit : 2,
          knockdown: last
        }, 1);
      }
      if (last) audio.boom(); else audio.whiff();
    }

    // 余波：音波继续一圈圈往外荡
    if (Math.random() < 0.3) {
      fx.ring(this.x, this.y - 96, 130 + Math.random() * 150, '#ffe066', 0.34, 2);
    }
    if (s.t > W + 0.75) this.endSkill();
  }

  /* ================= 奶娃 · 暴砸（O） =================
     高高跃起，双手合拢从空中砸下，落地一记范围冲击 */
  startSlam(opp) {
    const fx = this.game.fx, audio = this.game.audio;
    const dir = Math.sign(opp.x - this.x) || this.facing;
    this.facing = dir;
    this.skill = { id: 'slam', t: 0, dir, frame: -1, struck: false, landT: 0 };
    this.invuln = 0.7;
    this.grounded = false;
    this.vy = -720;
    this.vx = dir * 230;
    this.blocking = false;
    audio.cry('naiwa', 'S2');
    audio.charge();
    this.game.announce(this.def.skills.s2, this.def.color);
    fx.flash('#ffd83d', 0.16, 0.1);
    fx.dustRing(this.x, this.y);
    fx.shake(4, 0.15);
    this.game.cinematic(0.45);
  }

  updateSlam(dt, opp) {
    const s = this.skill, fx = this.game.fx, audio = this.game.audio;
    s.t += dt;
    this.invuln = Math.max(this.invuln, 0.05);
    this.facing = s.dir;

    if (!s.struck) {
      if (!this.grounded) {
        // 起跳用普通跳跃图，落体途中切到双手合拢 / 抡下的关键帧
        if (this.vy < -150) {
          s.frame = -1;
          this.vx = s.dir * 240;
        } else if (this.y < VIEW.GROUND - 80) {
          s.frame = 0;
          this.vx = s.dir * 150;
        } else {
          s.frame = 1;
          this.vx = s.dir * 80;
          this.vy = Math.min(this.vy, 520);
        }
        if (Math.random() < 0.55) {
          fx.parts.push({
            x: this.x + (Math.random() - 0.5) * 40, y: this.y - 120,
            vx: (Math.random() - 0.5) * 40, vy: -60 - Math.random() * 90,
            life: 0.2, max: 0.2, size: 2 + ((Math.random() * 2) | 0),
            color: '#c9d2e6', g: 0, drag: 2
          });
        }
      } else {
        // 落地砸击：范围冲击 + 击飞
        s.struck = true;
        s.frame = 2;
        s.landT = 0;
        this.vx = 0; this.vy = 0;
        audio.boom(); audio.heavy();
        fx.flash('#fff3c2', 0.24, 0.12);
        fx.dustRing(this.x, this.y);
        fx.dustRing(this.x + s.dir * 45, this.y);
        fx.ring(this.x + s.dir * 60, this.y, 90, '#ffe066', 0.36, 6);
        fx.ring(this.x + s.dir * 60, this.y, 140, 'rgba(255,243,194,.7)', 0.5, 3);
        fx.spark(this.x + s.dir * 70, this.y - 10, '#fff3c2', 1.8, 22);
        fx.shake(17, 0.45);
        fx.stop(0.1);
        this.game.shakeScreenBig();
        for (let i = 0; i < 14; i++) {
          fx.parts.push({
            x: this.x + s.dir * 30 + (Math.random() - 0.5) * 90, y: this.y - 4,
            vx: (Math.random() - 0.5) * 420, vy: -160 - Math.random() * 260,
            life: 0.35 + Math.random() * 0.3, max: 0.6,
            size: 2 + ((Math.random() * 3) | 0),
            color: Math.random() < 0.5 ? '#6b5330' : '#8b93a8', g: 900, drag: 1.5
          });
        }
        const dx = (opp.x - this.x) * s.dir;
        if (dx > -70 && dx < 165 && Math.abs(opp.y - this.y) < 180 && opp.state !== 'ko') {
          this.applyHit(opp, {
            name: this.def.skills.s2, dmg: 78, reach: 165, hi: -180, lo: -6,
            kb: 460, hitstun: 0.7, blockstun: 0.35,
            sfx: 'punch', rage: RAGE.hit, knockdown: true
          }, 1);
        }
      }
    } else {
      s.landT += dt;
      if (s.landT > 0.4) this.endSkill();
    }
    if (s.t > 2.4) this.endSkill();
  }

  endSkill() {
    const wasS1 = this.s1Active;
    const no = this.castNo;
    this.releaseLock();
    this.s1Active = false;
    this.castNo = 0;
    this.skill = null;
    this.setState('idle');
    this.invuln = 0;
    this.vx *= 0.2;
    // 完整放完才结算：U 进入 1 秒冷却；I 返还 5；O 返还 10
    if (wasS1 || no === 1) this.s1Cd = 1.0;
    else if (no === 2) this.gainRage(RAGE.s2.refund);
    else if (no === 3) {
      this.gainRage(RAGE.s3.refund);
      this.recoveryT = 0.3;              // 必杀收招后摇：可被对手抓timing反打
      this.game.fx.text(this.x, this.y - 170, '后摇', '#ffb03a', 10);
    }
  }

  updateSkill(dt, opp) {
    if (!this.skill) { this.endSkill(); return; }
    switch (this.skill.id) {
      case 'grab': this.updateGrab(dt, opp); break;
      case 'tail': this.updateTail(dt, opp); break;
      case 'rice': this.updateRice(dt, opp); break;
      case 'spray': this.updateSpray(dt, opp); break;
      case 'bark': this.updateBark(dt, opp); break;
      case 'rush': this.updateRush(dt, opp); break;
      case 'burst': this.updateBurst(dt, opp); break;
      case 'icespike': this.updateIceSpike(dt, opp); break;
      case 'dragonclaw': this.updateDragonClaw(dt, opp); break;
      case 'fireball': this.updateFireball(dt, opp); break;
      case 'flurry': this.updateFlurry(dt, opp); break;
      case 'bike': this.updateBike(dt, opp); break;
      case 'megapunch': this.updateMegaPunch(dt, opp); break;
      case 'bellylaugh': this.updateBellyLaugh(dt, opp); break;
      case 'whalesong': this.updateWhaleSong(dt, opp); break;
      case 'milkthrow': this.updateMilkThrow(dt, opp); break;
      case 'slam': this.updateSlam(dt, opp); break;
      case 'shoulderthrow': this.updateShoulderThrow(dt, opp); break;
      case 'sorry': this.updateSorry(dt, opp); break;
      case 'skykick': this.updateSkyKick(dt, opp); break;
      default: this.endSkill();
    }
  }

  /* ---------------- 物理 ---------------- */
  physics(dt, opp) {
    if (!this.grounded && this.state !== 'grabbed') {
      this.vy += GRAVITY * dt;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    if (this.y >= VIEW.GROUND) {
      if (!this.grounded) {
        this.grounded = true;
        this.airDodged = false;          // 落地后恢复空中闪避
        this.y = VIEW.GROUND;
        this.vy = 0;
        this.game.fx.dust(this.x, this.y, '#c9d2e6', 7, 0.8);
        this.game.audio.land();
        if (this.state === 'jump') this.setState('idle');
        // 浮空追击中被打落：摔到地上倒一小会儿（BVN 式受身窗口）
        if (this.state === 'hurt' && (this.juggle > 0 || this.hitstun > 0.12)) {
          this.prone = true;
          this.juggle = 0;
          this.hitstun = Math.max(this.hitstun, 0.5);
          this.game.fx.dustRing(this.x, VIEW.GROUND);
          this.game.fx.shake(5, 0.18);
          this.game.fx.stop(0.03);
        }
      }
      this.y = VIEW.GROUND;
      if (this.state === 'dodge') {
        // 闪避的位移衰减由 updateDodge 控制，这里不再叠加地面摩擦
      } else if (this.state !== 'attack' && this.state !== 'skill') {
        this.vx -= this.vx * Math.min(1, 9 * dt);
      } else {
        this.vx -= this.vx * Math.min(1, 5 * dt);
      }
    } else {
      this.grounded = false;
      // 空中受击（浮空追击中）保持 hurt 状态，落地才会转倒地
      if (this.state !== 'attack' && this.state !== 'skill' && this.state !== 'hurt'
        && this.state !== 'dodge') this.setState('jump');
    }

    // 场地边界
    const pad = 26;
    if (this.x < pad) { this.x = pad; this.vx = Math.max(0, this.vx); }
    if (this.x > VIEW.W - pad) { this.x = VIEW.W - pad; this.vx = Math.min(0, this.vx); }

    // 角色推挤（随体型缩放，否则小体型角色会被推到攻击距离外）
    if (opp && opp.state !== 'grabbed' && this.state !== 'grabbed' && this.state !== 'dodge' && opp.state !== 'ko') {
      const minD = 68 * ((this.def.scale || 1) + (opp.def.scale || 1)) / 2;
      const d = this.x - opp.x;
      if (Math.abs(d) < minD) {
        const push = (minD - Math.abs(d)) / 2 * Math.sign(d || 1);
        this.x += push; opp.x -= push;
      }
    }
  }

  /* ---------------- 绘制 ---------------- */
  draw(ctx, camX) {
    const sp = this.sp;
    if (!sp) return;
    const x = Math.round(this.x - camX);
    const y = Math.round(this.y);

    // 地面阴影
    const airH = Math.max(0, VIEW.GROUND - this.y);
    const sh = Math.max(0.18, 1 - airH / 260);
    ctx.save();
    ctx.globalAlpha = 0.34 * sh;
    ctx.fillStyle = '#05070d';
    ctx.beginPath();
    const sw = 26 * sh * (this.def.scale || 1);
    ctx.ellipse(x, VIEW.GROUND + 3, sw, sw * 0.27, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const pose = this.getPose();
    const spr = sp;

    // 技能光环（鲸鱼摆尾自带尾迹，不再叠光环）
    const isTail = this.state === 'skill' && this.skill && this.skill.id === 'tail';
    if ((this.state === 'skill' || this.state === 'dodge') && !isTail) {
      const pulse = 0.32 + Math.sin(this.t * 26) * 0.12;
      ctx.save();
      ctx.globalAlpha = pulse;
      if (this.usePoseSprite()) {
        this.drawPoseSprite(ctx, x + pose.ox, y + pose.oy, pose, 'tint', 1.07);
      } else {
        ctx.translate(x + pose.ox, y + pose.oy);
        ctx.rotate(pose.rot);
        const kA = this.def.scale || 1;
        ctx.scale(this.facing * pose.sx * 1.07 * kA, pose.sy * 1.07 * kA);
        ctx.drawImage(spr.tint, -spr.w / 2, -spr.h, spr.w, spr.h);
      }
      ctx.restore();
    }

    // 小鲸：整套姿势贴图（尾巴是原画的一部分，跟着身体一起动）
    if (this.usePoseSprite()) {
      const bx = x + pose.ox, by = y + pose.oy;
      this.drawPoseSprite(ctx, bx, by, pose, 'img', 1);
      if (this.flash > 0.02) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, this.flash) * 0.7;
        this.drawPoseSprite(ctx, bx, by, pose, 'white', 1);
        ctx.restore();
      }
      // 摆尾：尾尖扫过的弧光压在人物之上，才看得出"抽过去"
      if (isTail) this.drawTailSweep(ctx, bx, by, pose);
    }


    // 没有姿势贴图时退回静态立绘
    if (!this.usePoseSprite()) {
      const ax = spr.w / 2;
      const ay = spr.h;

      ctx.save();
      ctx.globalAlpha = pose.alpha;
      ctx.translate(x + pose.ox, y + pose.oy);
      ctx.rotate(pose.rot);
      const kS = this.def.scale || 1;
      ctx.scale(this.facing * kS * pose.sx, kS * pose.sy);
      ctx.drawImage(spr.img, -ax, -ay, spr.w, spr.h);
      if (this.flash > 0.02) {
        ctx.globalAlpha = Math.min(1, this.flash) * 0.62;
        ctx.drawImage(spr.white, -ax, -ay, spr.w, spr.h);
      }
      ctx.restore();
    }

    // 防御护盾
    if (this.state === 'block') {
      const a = 0.35 + Math.sin(this.t * 12) * 0.1;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.strokeStyle = this.elem;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x + this.facing * 6, y - 88, 56, -0.9 + (this.facing > 0 ? 0 : Math.PI), 0.9 + (this.facing > 0 ? 0 : Math.PI));
      ctx.stroke();
      ctx.restore();
    }
  }

  /* 大狗 / 小鲸：有整套姿势贴图就优先用贴图，和设定图一模一样 */
  usePoseSprite() {
    return !!(this.sp && this.sp.poses && POSE_META[this.def.id]);
  }

  /* 当前该显示哪一张姿势 */
  poseSpriteKey() {
    const P = this.sp.poses;
    const pick = (k) => (P[k] ? k : (POSE_FALLBACK[this.def.id] || 'idle'));
    const forced = (location.search.match(/[?&]pose=(\w+)/) || [])[1];
    if (forced && P[forced]) return forced;
    const st = this.state;
    if (this.prone || st === 'ko') return pick('ko');   // 倒地/战败：直接躺平的那张
    if (st === 'attack') {
      const M = MOVES[this.moveId] || MOVES.punch;
      if (M.pose === 'jkick' && P.jkick) return 'jkick';    // 空中踢
      return pick((M.pose === 'kick' || M.pose === 'jkick') ? 'kick' : 'punch');
    }
    if (st === 'skill') {
      const s = this.skill;
      if (!s) return pick('idle');
      // 跳跳连打：左一拳右一拳交替，收尾换踢腿
      if (s.id === 'flurry') return pick(s.kicked ? 'kick' : (s.hits % 2 ? 'punch' : 'block'));
      // 黑桃乱舞 / 过肩摔：出拳与踢腿交替，摔投按阶段切换
      if (s.id === 'rush') return pick(s.hits % 2 ? 'kick' : 'punch');
      if (s.id === 'shoulderthrow') return s.phase >= 3 ? pick('punch') : pick('block');
      if (s.id === 'sorry') return pick('sorry');
      // 跳跳神之一脚：蹲身 → 起跳（跳跃图）→ 空中飞踢关键帧
      if (s.id === 'skykick') {
        return s.phase >= 2 ? pick('skykick') : s.phase === 1 ? pick('jump') : pick('block');
      }
      if (s.id === 'burst') return pick('punch');
      // 奶娃大力拳：蓄力时双拳收在身侧，出拳瞬间换成挥拳图
      if (s.id === 'megapunch') return s.t < s.windup ? pick('block') : pick('punch');
      // 奶娃捧腹大笑：双手抱在腹前
      if (s.id === 'bellylaugh') return pick('laugh');
      // 鲸歌：喊台词时保持待机姿势，开嗓后换成唱歌图
      if (s.id === 'whalesong') return s.t < s.sing ? pick('idle') : pick('sing');
      // 大狗野生狗奶：抱奶蓄力 → 横挥 → 出手三张关键帧（蓄力时长随音频）
      if (s.id === 'milkthrow') {
        return s.t < s.charge ? pick('milk_0') : s.t < s.charge + 0.14 ? pick('milk_1') : pick('milk_2');
      }
      // 奶娃暴砸：起跳用普通跳跃图，落体三张关键帧
      if (s.id === 'slam') return s.frame < 0 ? pick('jump') : pick('slam_' + Math.min(2, s.frame));
      if (s.id === 'rice' || s.id === 'spray') return pick('punch');
      if (s.id === 'tail') return pick('tail');
      if (s.id === 'grab' || s.id === 'bark') return pick('bite');
      if (P.skill) return 'skill';    // 通用技能角色（白龙娘等）用技能起手姿势
      return pick('idle');
    }
    if (st === 'block') return pick('block');
    if (st === 'grabbed' || st === 'hurt') return P.hurt ? 'hurt' : pick('block');
    if (st === 'walk') return pick('walk');
    if (st === 'jump') return pick('jump');
    return pick('idle');
  }

  /* 画姿势贴图。mode: 'img' | 'tint' | 'white' */
  drawPoseSprite(ctx, px, py, pose, mode, kMul) {
    const P = this.sp.poses;
    const key = this.poseSpriteKey();
    const isWalk = this.state === 'walk' && !this.prone && !this.liftRot;
    const wf = this.sp.walkFrames;
    let sp = P[key] || P.idle;
    if (isWalk && wf) sp = wf[Math.floor(this.t * 8) % wf.length];   // 轮播预生成走路帧
    const meta = (POSE_META[this.def.id] || {})[key] || { ax: 0.5, ay: 1 };
    // 用角色基准身高（idle）统一缩放：各姿势的 bbox 高矮不同（屈膝、腾空），
    // 若按每张自己的高度归一，姿势切换时人会突然变大变小
    const refH = ((POSE_META[this.def.id] || {}).idle || {}).h || sp.h;
    // meta.k：这一张与整套基准不是同一分辨率时（如霜龙沿用旧的 1002px 格挡图）做补偿
    const k = POSE_BODY_H * (this.def.scale || 1) / refH * (meta.k || 1) * (kMul || 1);
    const pic = mode === 'tint' ? sp.tint : (mode === 'white' ? sp.white : sp.img);
    const ax = sp.w * meta.ax;
    const ay = sp.h * meta.ay;

    ctx.save();
    ctx.imageSmoothingEnabled = true;      // 手绘立绘是高清图，缩小时要平滑
    if (this.prone || this.liftRot) {
      // 倒地 / 被举过头顶：绕身体中段转，避免绕脚底把整个人甩出去
      const up = this.prone
        ? sp.h * 0.44 * k
        : POSE_BODY_H * 0.44 * (this.def.scale || 1) * (kMul || 1);
      ctx.translate(px, py - up);
      ctx.rotate(this.prone ? pose.rot : this.liftRot);
      ctx.translate(0, up);
    } else {
      ctx.translate(px, py);
      ctx.rotate(pose.rot);
    }
    // 各张原画朝向不一，用 flip 统一到"朝右"基准，再按 facing 翻转
    const flip = meta.flip || 1;
    // 转身：横向缩放按 cos 过零，模拟原地转过去
    const turnS = Math.cos(pose.turn || 0);
    const sxAll = this.facing * flip * k * pose.sx * turnS;
    ctx.scale(Math.abs(sxAll) < 0.002 ? 0.002 : sxAll, k * pose.sy);
    // 走路：有预生成帧则帧已含扭动，只加整体起伏；无帧角色（四足/鱼尾）整体摇摆
    if (isWalk) {
      const bob = Math.abs(Math.sin(this.t * 10)) * sp.h * 0.012;
      const sway = wf ? 0 : Math.sin(this.t * 12) * sp.w * 0.015;
      ctx.drawImage(pic, -ax + sway, -ay - bob, sp.w, sp.h);
    } else {
      ctx.drawImage(pic, -ax, -ay, sp.w, sp.h);
    }
    ctx.restore();
  }

  /* 贴图在舞台上的实际身高 / 身宽（姿势贴图是高清原图，不能用原始像素算偏移） */
  bodyRef() {
    const s = this.def.scale || 1;
    if (this.usePoseSprite()) {
      const P = this.sp.poses;
      const p = P[this.poseSpriteKey()] || P.idle;
      return { h: POSE_BODY_H * s, w: POSE_BODY_H * s * (p.w / p.h) };
    }
    return { h: this.sp.h * s, w: this.sp.w * s };
  }

  getPose() {
    let rot = 0, sx = 1, sy = 1, ox = 0, oy = 0, alpha = 1, turn = 0;
    const t = this.t;
    const ref = this.bodyRef();

    // 已经有躺平的倒地贴图：不再把站姿整体转 90°，直接用横躺的那张
    if ((this.prone || this.state === 'ko') && this.sp && this.sp.poses && this.sp.poses.ko) {
      return { rot: 0, sx: 1, sy: 1, ox: 0, oy: 0, alpha: 1 };
    }

    if (this.prone) {
      // 倒地：以身体中段为轴，避免绕脚底旋转导致整体甩到一侧
      rot = this.facing * 1.42;
      if (this.usePoseSprite()) {
        ox = -this.facing * ref.h * 0.20;
        oy = ref.w * 0.06;          // 让躺平的身体贴住地面
      } else {
        ox = -this.facing * this.sp.h * 0.34;
        oy = -this.sp.w * 0.3;
      }
      return { rot, sx, sy, ox, oy, alpha };
    }

    switch (this.state) {
      case 'idle': {
        const b = Math.sin(t * 3.4);
        sy = 1 + b * 0.014; sx = 1 - b * 0.01;
        oy = Math.abs(Math.sin(t * 3.4)) * 1.2;
        break;
      }
      case 'walk': {
        const b = Math.sin(t * 13);
        rot = this.facing * 0.035 + b * 0.022;
        sy = 1 + Math.abs(b) * 0.018;
        oy = -Math.abs(b) * 2;
        break;
      }
      case 'jump': {
        sy = this.vy < 0 ? 1.05 : 0.99;
        sx = this.vy < 0 ? 0.97 : 1.02;
        rot = this.facing * 0.05;
        break;
      }
      case 'block': {
        rot = this.facing * 0.1;
        sx = 1.04; sy = 0.96;
        oy = 1;
        break;
      }
      case 'hurt': {
        rot = -this.facing * 0.2;
        sy = 0.95; sx = 1.05;
        break;
      }
      case 'attack': {
        const M = MOVES[this.moveId] || MOVES.punch;
        const total = M.startup + M.active + M.recovery;
        const p = Math.min(1, this.moveT / total);
        const swing = Math.sin(Math.min(1, p * 1.25) * Math.PI);
        if (M.launch) {
          // 上勾：先沉身再向上顶，和普通直拳区分开
          const up = Math.sin(Math.min(1, Math.max(0, (p - 0.22) / 0.5)) * Math.PI);
          rot = -this.facing * 0.26 * up;
          oy = -9 * up;
          sy = 1 + 0.05 * up; sx = 1 - 0.02 * up;
          ox = this.facing * 12 * up;
        } else if (this.moveId === 'dashatk') {
          // 冲刺拳：整个人压上去
          rot = this.facing * 0.24 * swing;
          ox = this.facing * 22 * swing;
          sx = 1 + 0.09 * swing; sy = 1 - 0.05 * swing;
        } else if (M.pose === 'kick' || M.pose === 'jkick') {
          rot = -this.facing * 0.2 * swing;
          sx = 1 + 0.05 * swing; sy = 1 - 0.03 * swing;
          ox = this.facing * 10 * swing;
        } else {
          rot = this.facing * 0.17 * swing;
          sx = 1 + 0.06 * swing; sy = 1 - 0.02 * swing;
          ox = this.facing * 13 * swing;
        }
        break;
      }
      case 'dodge': {
        alpha = 0.72;
        rot = -this.dodgeDir * 0.12;
        sy = 0.96;
        break;
      }
      case 'skill': {
        const s = this.skill;
        // 贴图角色整个人一起转，角度要收着用，不然像摔倒
        const pk = this.usePoseSprite() ? 0.42 : 1;
        if (s && s.id === 'megapunch') {
          const W = s.windup;
          if (s.t < W) {
            // 蓄力：越蓄越沉、越往后拉，身体抖得越来越厉害
            const p = Math.min(1, s.t / W);
            rot = -this.facing * (0.10 + p * 0.18) * pk + Math.sin(this.t * 36) * (0.01 + p * 0.025);
            sy = 1 - p * 0.11;
            sx = 1 + p * 0.06;
            ox = -this.facing * (8 + p * 16);
            oy = 1 + p * 3;
          } else {
            // 出拳：整个人向前压上去，横向拉伸，冲力快速衰减
            const e = Math.max(0, 1 - (s.t - W) / 0.28);
            const punch = Math.pow(e, 0.55);
            rot = this.facing * 0.30 * punch * pk;
            ox = this.facing * 52 * punch;
            sx = 1 + 0.18 * punch;
            sy = 1 - 0.08 * punch;
            oy = -2 * punch;
          }
          break;
        }
        if (s && s.id === 'bellylaugh') {
          const W = s.windup;
          if (s.t < W) {
            // 捧腹：抱着肚子笑得前后发抖
            const p = Math.min(1, s.t / W);
            const shake = Math.sin(this.t * 27) * (0.02 + p * 0.03);
            rot = this.facing * (0.07 + shake) * pk;
            sy = 1 - 0.07 * p + Math.sin(this.t * 27) * 0.012;
            sx = 1 + 0.05 * p;
            oy = 1 + Math.abs(Math.sin(this.t * 13.5)) * 2;
          } else {
            // 释放音波：身体一挺，微微后仰
            const e = Math.max(0, 1 - (s.t - W) / 0.34);
            rot = -this.facing * 0.16 * e * pk;
            sx = 1 + 0.12 * e;
            sy = 1 - 0.05 * e;
            oy = -3 * e;
          }
          break;
        }
        if (s && s.id === 'fireball') {
          // 嘴喷火前摇：先仰头蓄气，喷出瞬间向前一探
          if (s.t < s.windup) {
            const k = Math.sin(Math.min(1, s.t / s.windup) * Math.PI * 0.5);
            rot = -this.facing * 0.16 * pk * k;
            oy = -6 * k;
            sy = 1 - 0.03 * k; sx = 1 + 0.03 * k;
            ox = -this.facing * 10 * k;
          } else {
            const thrust = Math.max(0, 1 - (s.t - s.windup) / 0.22);
            rot = this.facing * 0.12 * thrust * pk;
            ox = this.facing * 14 * thrust;
            sy = 1 + 0.04 * thrust; sx = 1 - 0.02 * thrust;
          }
          break;
        }
        if (s && s.id === 'grab') {
          if (s.phase <= 1) { rot = this.facing * 0.22 * pk; sy = 0.94; sx = 1.06; }
          else if (s.phase === 4) {
            const b = Math.sin(this.t * 26);
            rot = this.facing * (0.74 + b * 0.045) * pk;
            oy = 8 + Math.abs(b) * 3;
            sy = 0.88;
            ox = this.facing * 28;
          } else { rot = this.facing * 0.34 * pk; sy = 0.94; ox = this.facing * 4; }
        } else if (s && s.id === 'bark') {
          if (s.t < 0.42) { rot = -this.facing * 0.16; sy = 0.95 + Math.sin(this.t * 20) * 0.01; }
          else { rot = this.facing * 0.24; sy = 1.03; ox = this.facing * 4; }
        } else if (s && s.id === 'rush') {
          rot = this.facing * 0.12; sx = 1.04;
        } else if (s && s.id === 'skykick') {
          // 神之一脚：蹲身压低 → 升空拉长 → 每次踢中身体往前一顿
          if (s.phase === 0) {
            const p = Math.min(1, s.phaseT / 0.2);
            rot = this.facing * 0.06 * pk;
            sy = 1 - 0.14 * p; sx = 1 + 0.08 * p;
            oy = 2 + p * 2;
          } else if (s.phase === 1) {
            sx = 0.94; sy = 1.08;
            rot = this.facing * 0.04 * pk;
          } else if (s.phase === 2) {
            // 每踢一帧压一次，一帧一帧地发力
            const beat = Math.max(0, 1 - (s.phaseT % 0.1) / 0.1);
            sx = 1 + 0.06 * beat; sy = 1 - 0.03 * beat;
            rot = this.facing * (0.05 + 0.05 * beat) * pk;
            ox = this.facing * 4 * beat;
          } else {
            const e = Math.max(0, 1 - s.phaseT / 0.34);
            sx = 1 + 0.05 * e; sy = 1 - 0.06 * e;
            rot = this.facing * 0.04 * e;
          }
        } else if (s && s.id === 'tail') {
          const TL = this.tailTimeline();
          const w = Math.sin(TL.t * Math.PI);
          rot = -this.facing * 0.2 * w;
          oy = -4 * w;
          sy = 1 - 0.03 * w;
          turn = Math.PI * TL.turn;      // 转身：横向缩放穿过 0，视觉上像原地转身
        } else {
          rot = -this.facing * 0.1;
        }
        break;
      }
      case 'ko': {
        rot = -this.facing * 1.4;
        oy = -ref.w * 0.4;
        break;
      }
    }
    return { rot, sx, sy, ox, oy, alpha, turn };
  }
}

function fpDust(fx, x, y, color, n, dir) {
  for (let i = 0; i < n; i++) {
    fx.parts.push({
      x: x + (Math.random() - 0.5) * 10, y: y - Math.random() * 6,
      vx: -dir * (40 + Math.random() * 140), vy: -30 - Math.random() * 90,
      life: 0.3 + Math.random() * 0.25, max: 0.55,
      size: 2 + Math.round(Math.random() * 2), color, g: 240, drag: 4
    });
  }
}
