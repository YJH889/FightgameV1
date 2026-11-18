/* ============================================================
   尾巴扫过的弧光（小鲸摆尾专用）
   原画里的尾巴是贴图的一部分，跟着身体一起动；这里补一道尾尖划过的
   水光：中间厚、两端收尖，颜色取原画尾巴的蓝 + 白高光。
   角度用屏幕坐标：0=正前，90=正下，-90/270=正上，180=正后。
   ============================================================ */
(function () {
  const D2R = Math.PI / 180;

  function drawTailArc(ctx, o) {
    const facing = o.facing || 1;
    const s = o.scale || 1;
    const r0 = (o.r0 !== undefined ? o.r0 : 24) * s;
    const r1 = (o.r1 !== undefined ? o.r1 : 82) * s;
    const aEnd = (o.aEnd || 0) * D2R;
    const aLen = (o.aLen || 90) * D2R;
    const aStart = aEnd - aLen;
    const alpha = o.alpha === undefined ? 0.9 : o.alpha;
    if (alpha <= 0.01 || r1 <= r0) return;

    const N = 30;
    const rMid = (r0 + r1) / 2;
    const th = (r1 - r0) * 0.50;            // 最厚处
    const at = (t) => aStart + (aEnd - aStart) * t;
    const thick = (t) => th * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.92)), 0.65);
    const P = (t, r) => ({ x: facing * Math.cos(at(t)) * r, y: Math.sin(at(t)) * r });

    ctx.save();

    // 主体：内缘去、外缘回，拼成一个纺锤形
    const path = new Path2D();
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = P(t, rMid - thick(t) / 2);
      i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y);
    }
    for (let i = N; i >= 0; i--) {
      const t = i / N;
      const p = P(t, rMid + thick(t) / 2);
      path.lineTo(p.x, p.y);
    }
    path.closePath();

    // 沿半径方向的渐变：中段最亮，两端透明
    const grd = ctx.createRadialGradient(0, 0, r0, 0, 0, r1);
    grd.addColorStop(0.00, 'rgba(120,190,255,0)');
    grd.addColorStop(0.28, 'rgba(96,168,246,' + (0.46 * alpha).toFixed(3) + ')');
    grd.addColorStop(0.62, 'rgba(214,238,255,' + (0.80 * alpha).toFixed(3) + ')');
    grd.addColorStop(1.00, 'rgba(150,205,255,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = grd;
    ctx.fill(path);

    // 前缘的一道亮线（尾尖位置）
    const tipR = rMid + th * 0.16;
    ctx.beginPath();
    for (let i = 0; i <= 12; i++) {
      const t = 0.72 + (i / 12) * 0.28;
      const p = P(t, tipR);
      i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
    }
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,' + (alpha * 0.95).toFixed(3) + ')';
    ctx.lineWidth = Math.max(1.6, 2.6 * s);
    ctx.stroke();

    // 拖尾的三道细线，做出"扫过去"的动感
    ctx.globalCompositeOperation = 'source-over';
    for (let k = 0; k < 3; k++) {
      const rr = rMid - th * (0.34 + k * 0.12);
      ctx.beginPath();
      for (let i = 0; i <= 16; i++) {
        const t = 0.18 + (i / 16) * 0.7;
        const p = P(t, rr);
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      }
      ctx.strokeStyle = 'rgba(120,190,255,' + (alpha * (0.34 - k * 0.08)).toFixed(3) + ')';
      ctx.lineWidth = Math.max(0.8, 1.4 * s);
      ctx.stroke();
    }

    ctx.restore();
  }

  window.drawTailArc = drawTailArc;
})();
