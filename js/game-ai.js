/* ============================================================
   简易 CPU 对手 AI
   ============================================================ */

class AI {
  constructor(self, game, level = 1) {
    this.self = self;
    this.game = game;
    this.level = Math.max(1, level || 1);
    this.reset();
  }

  reset() {
    this.thinkT = 0;
    this.mode = 'approach';
    this.modeT = 0;
    this.atkCool = 0.6;
    this.skillCool = 1.5;
    this.jumpCool = 2;
    this.hold = { left: false, right: false };
  }

  cmd() {
    const c = {
      left: this.hold.left, right: this.hold.right,
      up: false, jump: false, block: false,
      punch: false, kick: false,
      dodge: false, skill1: false, skill2: false, skill3: false
    };
    return c;
  }

  update(dt, opp) {
    const c = this.cmd();
    const self = this.self;
    this.atkCool -= dt; this.skillCool -= dt; this.jumpCool -= dt;
    this.modeT -= dt;
    this.thinkT -= dt;

    if (self.state === 'grabbed' || self.state === 'ko' || this.game.over) {
      this.hold.left = this.hold.right = false;
      return c;
    }

    const dx = opp.x - self.x;
    const dist = Math.abs(dx);
    const toward = dx > 0 ? 'right' : 'left';
    const away = dx > 0 ? 'left' : 'right';
    // 难度：关卡越高，出手越快、防御/技能反应越好（封顶，避免变成纯读指令）
    const lv = Math.min(8, this.level);

    // 反应式防御
    const oppTelegraph = opp.state === 'attack' && opp.moveT < MOVES[opp.moveId || 'punch'].startup + 0.02;
    if (oppTelegraph && dist < 100 + lv * 6 && Math.random() < 0.04 + lv * 0.04) {
      this.mode = 'block'; this.modeT = 0.3;
    }

    // 外卖车 incoming：有怒气就幻影闪避躲开
    if (self.rage >= 50 && self.state !== 'dodge') {
      const projs = this.game.projectiles;
      for (const p of projs) {
        if (p.type !== 'bike' || p.owner === self) continue;
        const pdir = Math.sign(p.vx) || 1;
        const coming = (pdir > 0 && p.x < self.x) || (pdir < 0 && p.x > self.x);
        if (!coming) continue;
        const pd = Math.abs(p.x - self.x);
        if (pd < 260 && Math.abs(p.y - (self.y - 60)) < 120) {
          // 车快到脸上了，赌一把幻影闪避
          if (Math.random() < 0.35 + lv * 0.06) {
            this.mode = 'dodge'; this.modeT = 0.25;
            break;
          }
        }
      }
    }

    if (this.thinkT <= 0) {
      this.thinkT = Math.max(0.1, 0.24 - lv * 0.013) + Math.random() * 0.1;
      const skillReady = this.skillCool <= 0;
      if (self.rage >= 50 && dist < 240 && skillReady && Math.random() < 0.62 + lv * 0.04) {
        this.mode = 'ult'; this.modeT = 0.4;
      } else if (self.rage >= 50 && dist < 130 + lv * 10 && opp.state === 'attack' && skillReady && Math.random() < 0.38 + lv * 0.05) {
        this.mode = 'dodge'; this.modeT = 0.2;
      } else if (dist < 110 + lv * 6 && skillReady && Math.random() < 0.45 + lv * 0.05) {
        this.mode = 'skill'; this.modeT = 0.4;
      } else if (opp.recoveryT > 0 && dist < 130 && Math.random() < 0.45 + lv * 0.05) {
        // 对手必杀收招后摇：抓这个timing压上去反打
        this.mode = 'attack'; this.modeT = 0.35;
      } else if (opp.hitstun > 0.12 && dist < 96 && Math.random() < 0.35 + lv * 0.06) {
        // 抓到对手硬直就压上去追击
        this.mode = 'attack';
      } else if (dist > 100) {
        this.mode = 'approach';
      } else if (dist < 46) {
        this.mode = Math.random() < 0.4 ? 'retreat' : 'attack';
      } else {
        this.mode = Math.random() < 0.7 + lv * 0.02 ? 'attack' : 'approach';
      }
    }

    switch (this.mode) {
      case 'approach':
        this.hold[toward] = true; this.hold[away] = false;
        if (dist > 190 && this.jumpCool <= 0 && Math.random() < 0.02 + lv * 0.004) {
          c.jump = true; c.up = true; this.jumpCool = 2.2;
        }
        break;
      case 'retreat':
        this.hold[away] = true; this.hold[toward] = false;
        if (this.modeT <= 0) this.mode = 'approach';
        break;
      case 'block':
        this.hold.left = this.hold.right = false;
        c.block = true;
        if (this.modeT <= 0) this.mode = 'approach';
        break;
      case 'attack':
        this.hold.left = this.hold.right = false;
        if (dist > 78) { this.hold[toward] = true; break; }
        if (this.atkCool <= 0) {
          if (Math.random() < 0.65) c.punch = true; else c.kick = true;
          // 出手更快 → J·J·J 能自然接成连段链
          this.atkCool = (0.18 + Math.random() * 0.24) / (0.8 + lv * 0.2);
          if (this.modeT <= 0) this.mode = 'approach';
        }
        break;
      case 'skill':
        c.skill1 = true;
        this.skillCool = 3.6 / (0.75 + lv * 0.12);
        this.mode = 'approach';
        break;
      case 'dodge':
        this.hold[away] = true; this.hold[toward] = false;
        c.dodge = true; c.block = true;
        this.skillCool = 2.8 / (0.75 + lv * 0.12);
        this.mode = 'approach';
        break;
      case 'ult':
        c.skill2 = true;
        this.skillCool = 4.6 / (0.75 + lv * 0.1);
        this.mode = 'approach';
        break;
    }

    return c;
  }
}
