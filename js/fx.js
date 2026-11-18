/* ============================================================
   打击感特效层：粒子 / 冲击环 / 残影 / 飘字 / 震屏 / 顿帧
   ============================================================ */

class FX {
  constructor() { this.reset(); }

  reset() {
    this.parts = [];
    this.rings = [];
    this.ghosts = [];
    this.texts = [];
    this.lines = [];
    this.cones = [];
    this.shakeT = 0; this.shakeDur = 0; this.shakeMag = 0;
    this.flashT = 0; this.flashDur = 0; this.flashCol = '#fff'; this.flashA = 0.8;
    this.hitstop = 0;
    this.sx = 0; this.sy = 0;
    this.timeScale = 1;
  }

  /* ---------- 生成 ---------- */
  spark(x, y, color, power = 1, count = 10) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (60 + Math.random() * 240) * power;
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40 * power,
        life: 0.18 + Math.random() * 0.3, max: 0.5,
        size: 1 + Math.round(Math.random() * 2.2), color, g: 620, drag: 4
      });
    }
  }

  dust(x, y, color = '#cfd6e6', count = 8, power = 1, dir = 0) {
    for (let i = 0; i < count; i++) {
      const a = dir ? (dir > 0 ? -0.5 + Math.random() * 0.9 : Math.PI + 0.5 - Math.random() * 0.9)
        : Math.random() * Math.PI * 2;
      const sp = 30 + Math.random() * 110 * power;
      this.parts.push({
        x: x + (Math.random() - 0.5) * 8, y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6 - 20,
        life: 0.3 + Math.random() * 0.4, max: 0.7,
        size: 2 + Math.round(Math.random() * 3), color, g: 60, drag: 5
      });
    }
  }

  blockSpark(x, y, color = '#9fe6ff') {
    for (let i = 0; i < 7; i++) {
      this.parts.push({
        x, y, vx: (Math.random() - 0.5) * 220, vy: -60 - Math.random() * 140,
        life: 0.18 + Math.random() * 0.2, max: 0.4,
        size: 2, color, g: 500, drag: 3
      });
    }
    this.rings.push({ x, y, r: 4, maxR: 26, life: 0.18, max: 0.18, color, w: 2 });
  }

  ring(x, y, maxR, color, dur = 0.35, w = 3) {
    this.rings.push({ x, y, r: 2, maxR, life: dur, max: dur, color, w });
  }

  /* 扇形冲击波（犬吠音波 / 大招用） */
  cone(x, y, dir, len, color, dur = 0.4, spread = 0.62) {
    this.cones.push({ x, y, dir, len, color, life: dur, max: dur, spread });
  }

  dustRing(x, y, color = 'rgba(220,225,240,.5)') {
    this.rings.push({ x, y, r: 4, maxR: 46, life: 0.4, max: 0.4, color, w: 3, flat: 0.34 });
  }

  text(x, y, str, color = '#fff', size = 12, vy = -46) {
    this.texts.push({ x, y, str, color, size, life: 0.75, max: 0.75, vy });
  }

  ghost(sp, x, y, flip, rot, alpha, tint = null, sx = 1, sy = 1, k = 1, ax = 0.5, ay = 1) {
    this.ghosts.push({
      canvas: tint === 'ghost' ? (sp.ghost || sp.tint || sp.img) : (tint ? (sp.tint || sp.img) : sp.img),
      w: sp.w, h: sp.h, x, y, flip, rot, alpha, life: 0.3, max: 0.3, sx, sy, k, ax, ay
    });
  }

  speedLine(x, y, dir) {
    this.lines.push({
      x, y, dir, len: 40 + Math.random() * 60,
      life: 0.22, max: 0.22, off: (Math.random() - 0.5) * 120,
      color: Math.random() < 0.5 ? '#fff' : '#ffd27a'
    });
  }

  shake(mag, dur = 0.24) {
    if (mag > this.shakeMag || this.shakeT < 0.02) { this.shakeMag = mag; }
    this.shakeT = Math.max(this.shakeT, dur);
    this.shakeDur = Math.max(this.shakeDur, dur);
  }

  flash(color = '#fff', alpha = 0.7, dur = 0.12) {
    this.flashCol = color; this.flashA = alpha; this.flashT = dur; this.flashDur = dur;
  }

  stop(t) { this.hitstop = Math.max(this.hitstop, t); }

  /* ---------- 更新 ---------- */
  update(dt) {
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const k = Math.max(0, this.shakeT / Math.max(0.001, this.shakeDur));
      const m = this.shakeMag * k * k;
      this.sx = (Math.random() - 0.5) * 2 * m;
      this.sy = (Math.random() - 0.5) * 2 * m;
      if (this.shakeT <= 0) { this.shakeMag = 0; this.sx = this.sy = 0; this.shakeDur = 0; }
    }
    if (this.flashT > 0) this.flashT -= dt;

    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life -= dt;
      p.vy += p.g * dt;
      p.vx -= p.vx * p.drag * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.life <= 0) this.parts.splice(i, 1);
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      const k = 1 - r.life / r.max;
      r.r = 2 + (r.maxR - 2) * (1 - Math.pow(1 - k, 2.2));
      if (r.life <= 0) this.rings.splice(i, 1);
    }
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i];
      g.life -= dt;
      if (g.life <= 0) this.ghosts.splice(i, 1);
    }
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const t = this.texts[i];
      t.life -= dt; t.y += t.vy * dt; t.vy += 90 * dt;
      if (t.life <= 0) this.texts.splice(i, 1);
    }
    for (let i = this.cones.length - 1; i >= 0; i--) {
      const c = this.cones[i];
      c.life -= dt;
      if (c.life <= 0) this.cones.splice(i, 1);
    }
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i];
      l.life -= dt;
      if (l.life <= 0) this.lines.splice(i, 1);
    }
  }

  /* ---------- 绘制 ---------- */
  drawGhosts(ctx, camX) {
    for (const g of this.ghosts) {
      const a = Math.max(0, g.life / g.max) * g.alpha;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = a;
      ctx.translate(g.x - camX, g.y);
      ctx.rotate(g.rot || 0);
      const k = g.k || 1;
      ctx.scale((g.flip || 1) * (g.sx || 1) * k, (g.sy || 1) * k);
      ctx.drawImage(g.canvas, -g.w * (g.ax === undefined ? 0.5 : g.ax), -g.h * (g.ay === undefined ? 1 : g.ay), g.w, g.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  drawRings(ctx, camX) {
    for (const r of this.rings) {
      const a = Math.max(0, r.life / r.max);
      ctx.save();
      ctx.globalAlpha = a * 0.95;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = Math.max(1, r.w * a);
      ctx.beginPath();
      if (r.flat) ctx.ellipse(r.x - camX, r.y, r.r, r.r * r.flat, 0, 0, Math.PI * 2);
      else ctx.arc(r.x - camX, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawCones(ctx, camX) {
    for (const c of this.cones) {
      const k = 1 - c.life / c.max;
      const r = c.len * (0.3 + 0.7 * (1 - Math.pow(1 - k, 2)));
      const a = Math.max(0, 1 - k);
      const x = c.x - camX;
      const a0 = c.dir > 0 ? -c.spread : Math.PI - c.spread;
      const a1 = c.dir > 0 ? c.spread : Math.PI + c.spread;
      const g = ctx.createRadialGradient(x, c.y, 4, x, c.y, r);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.9 * a).toFixed(3) + ')');
      g.addColorStop(0.45, c.color);
      g.addColorStop(1, 'rgba(255,170,60,0)');
      ctx.save();
      ctx.globalAlpha = 0.75 * a;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x, c.y);
      ctx.arc(x, c.y, r, a0, a1);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.85 * a;
      ctx.strokeStyle = '#fffdf2';
      ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(x, c.y, r * (0.55 + i * 0.2), a0 * 0.9, a1 * 0.9);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawParts(ctx, camX) {
    for (const p of this.parts) {
      const a = Math.max(0, Math.min(1, p.life / p.max * 1.6));
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x - camX), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  drawLines(ctx, camX) {
    for (const l of this.lines) {
      const a = Math.max(0, l.life / l.max);
      ctx.globalAlpha = a * 0.85;
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 1;
      const x = l.x - camX;
      ctx.beginPath();
      ctx.moveTo(x, l.y + l.off);
      ctx.lineTo(x + l.dir * l.len, l.y + l.off);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawTexts(ctx, camX) {
    for (const t of this.texts) {
      const a = Math.max(0, Math.min(1, t.life / t.max * 1.8));
      ctx.save();
      ctx.globalAlpha = a;
      ctx.font = `bold ${t.size}px "Courier New", monospace`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(8,10,18,.85)';
      ctx.strokeText(t.str, t.x - camX, t.y);
      ctx.fillStyle = t.color;
      ctx.fillText(t.str, t.x - camX, t.y);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  drawFlash(ctx) {
    if (this.flashT <= 0) return;
    const a = (this.flashT / this.flashDur) * this.flashA;
    ctx.save();
    ctx.globalAlpha = Math.max(0, a);
    ctx.fillStyle = this.flashCol;
    ctx.fillRect(0, 0, VIEW.W, VIEW.H);
    ctx.restore();
  }
}
