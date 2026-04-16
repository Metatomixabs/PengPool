// physics.js — motor de física puro, compatible browser + Node.js
// Sin reglas de juego, UI, audio ni WebSocket.

// ── Constantes de tabla ──────────────────────────────────────────────────────
const _W  = 800;
const _H  = 500;
const _WL = 55;
const _WR = _W - 56;   // 744
const _WT = 76;
const _WB = _H - 63;   // 437
const _R  = 11;
const _FRIC_BASE = 0.9875;
const _MINS      = 0.1;
const _MAXP      = 18;

// ── Input validation & snapshot helpers (for server-side use) ────────────────
function sanitizeSnapshot(balls) {
  return balls.map(b => ({
    ...b,
    vx: Math.abs(b.vx) < 0.15 ? 0 : b.vx,
    vy: Math.abs(b.vy) < 0.15 ? 0 : b.vy,
  }));
}

function validateShotParams(angle, power, spinX, spinY) {
  if (typeof angle !== 'number' || !isFinite(angle))            return false;
  if (typeof power !== 'number' || power < 0.01 || power > 100) return false;
  if (typeof spinX !== 'number' || spinX < -1   || spinX > 1)   return false;
  if (typeof spinY !== 'number' || spinY < -1   || spinY > 1)   return false;
  return true;
}

const _PKT = [
  { x: 46,         y: 66,       r: 24, type: 'corner' },
  { x: _W / 2.015, y: 55,       r: 24, type: 'mid'    },
  { x: _W - 47,    y: 67,       r: 24, type: 'corner' },
  { x: 40,         y: _H - 50,  r: 24, type: 'corner' },
  { x: _W / 2.01,  y: _H - 39,  r: 24, type: 'mid'    },
  { x: _W - 47,    y: _H - 52,  r: 24, type: 'corner' },
];

const _corners = [
  { cx: 369,   cy: 73    }, // central top izq
  { cx: 431,   cy: 73    }, // central top der
  { cx: 368,   cy: 440   }, // central bot izq
  { cx: 429,   cy: 440   }, // central bot der
  { cx: 84,    cy: 73    }, // TL horizontal
  { cx: 52,    cy: 106.5 }, // TL vertical
  { cx: 713.5, cy: 73    }, // TR horizontal
  { cx: 747,   cy: 107.5 }, // TR vertical
  { cx: 83,    cy: 440   }, // BL horizontal
  { cx: 52,    cy: 407   }, // BL vertical
  { cx: 713,   cy: 440   }, // BR horizontal
  { cx: 746.5, cy: 409   }, // BR vertical
];

// ── ballSegmentCollision ─────────────────────────────────────────────────────
function ballSegmentCollision(b, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return false;
  let t = ((b.x - x1) * dx + (b.y - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx, cy = y1 + t * dy;
  const ex = b.x - cx, ey = b.y - cy;
  const dist = Math.sqrt(ex * ex + ey * ey);
  if (dist < _R && dist > 0.01) {
    const nx = ex / dist, ny = ey / dist;
    b.x = cx + nx * (_R + 0.5);
    b.y = cy + ny * (_R + 0.5);
    const dot = b.vx * nx + b.vy * ny;
    if (dot < 0) {
      b.vx -= 2 * dot * nx;
      b.vy -= 2 * dot * ny;
      b.vx *= 0.78;
      b.vy *= 0.78;
    }
    return true;
  }
  return false;
}

// ── _resolveCollisions ───────────────────────────────────────────────────────
// state     = { angle, ballInHand, firstContactId }  (firstContactId se muta)
// callbacks = { onCollision(normalizedSpeed, x, y) } — opcional
function _resolveCollisions(balls, state, callbacks) {
  const cue         = balls.find(b => b.id === 0);
  const onCollision = callbacks?.onCollision || null;

  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const a = balls[i], b = balls[j];
      if (a.out || b.out) continue;
      if (state.ballInHand && (a === cue || b === cue)) continue;

      const dx = b.x - a.x, dy = b.y - a.y;
      const d  = Math.sqrt(dx * dx + dy * dy);
      const mn = _R * 2;

      if (d < mn && d > 0.001) {
        if (state.firstContactId === null && (a.id === 0 || b.id === 0))
          state.firstContactId = a.id === 0 ? b.id : a.id;

        const nx = dx / d, ny = dy / d;
        const ov = (mn - d) / 2;
        a.x -= nx * ov; a.y -= ny * ov;
        b.x += nx * ov; b.y += ny * ov;

        const dv = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (dv > 0) {
          const impulse = dv > 0.01
            ? Math.max(dv, ov * 0.5, 0.02)
            : Math.max(dv, ov * 0.5);
          a.vx -= impulse * nx; a.vy -= impulse * ny;
          b.vx += impulse * nx; b.vy += impulse * ny;

          const impactSpd = Math.abs(dv);
          if (impactSpd > 0.8 && onCollision) {
            onCollision(
              Math.min(1, impactSpd / _MAXP),
              (a.x + b.x) / 2,
              (a.y + b.y) / 2
            );
          }
        }

        // Spin en primer contacto con la blanca
        const cueBall = a.id === 0 ? a : b.id === 0 ? b : null;
        if (cueBall && !cueBall.spun) {
          cueBall.vx += Math.cos(state.angle) * cueBall.spinY * cueBall.shotSpd * 0.22;
          cueBall.vy += Math.sin(state.angle) * cueBall.spinY * cueBall.shotSpd * 0.22;
          cueBall.vx += Math.cos(state.angle + Math.PI / 2) * cueBall.spinX * cueBall.shotSpd * 0.16;
          cueBall.vy += Math.sin(state.angle + Math.PI / 2) * cueBall.spinX * cueBall.shotSpd * 0.16;
          cueBall.spun = true;
        }
      }
    }
  }
}

// ── _phys ────────────────────────────────────────────────────────────────────
// frameDelta : ms desde el último frame
// balls      : array mutable de objetos bola
// state      : { angle, ballInHand, firstContactId, debugSegments }
// callbacks  : { onPocketed(ball,pi), onCollision(spd,x,y), onRailHit() }
// Retorna    : true si alguna bola sigue en movimiento
function _phys(frameDelta, balls, state, callbacks) {
  const debugSegments = state.debugSegments || [];
  const onPocketed    = callbacks?.onPocketed || ((ball) => { ball.out = true; ball.vx = 0; ball.vy = 0; });
  const onRailHit     = callbacks?.onRailHit  || null;

  const cue = balls.find(b => b.id === 0);

  const dt       = frameDelta / 16.667;
  const fricFrame = Math.pow(_FRIC_BASE, dt);
  const cueSpeed  = cue && !cue.out ? Math.hypot(cue.vx, cue.vy) : 0;
  const minSubs   = Math.max(6, Math.ceil(dt / 4));
  const substeps  = Math.max(minSubs, Math.min(16, Math.ceil(cueSpeed * dt / (_R * 0.5))));
  let mv = false;

  // CCD para la bola blanca
  if (cue && !cue.out) {
    const speed = Math.sqrt(cue.vx * cue.vx + cue.vy * cue.vy);
    if (speed > _R) {
      const nx0 = cue.vx / speed, ny0 = cue.vy / speed;
      for (const o of balls) {
        if (o === cue || o.out) continue;
        const bx = o.x - cue.x, by = o.y - cue.y;
        const tCA = bx * nx0 + by * ny0;
        if (tCA < 0 || tCA > speed) continue;
        const perpSq = bx * bx + by * by - tCA * tCA;
        if (perpSq > _R * 2 * (_R * 2)) continue;
        const tC = tCA - Math.sqrt(_R * 2 * (_R * 2) - perpSq);
        if (tC > 0 && tC <= speed) {
          cue.x += nx0 * tC; cue.y += ny0 * tC;
          const dx = o.x - cue.x, dy = o.y - cue.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          const cnx = dx / d, cny = dy / d;
          const ov = (_R * 2 - d) / 2;
          cue.x -= cnx * ov; o.x += cnx * ov;
          cue.y -= cny * ov; o.y += cny * ov;
          const dv = (cue.vx - o.vx) * cnx + (cue.vy - o.vy) * cny;
          if (dv > 0) {
            cue.vx -= dv * cnx; cue.vy -= dv * cny;
            o.vx   += dv * cnx; o.vy   += dv * cny;
          }
          if (state.firstContactId === null) state.firstContactId = o.id;
          if (!cue.spun) {
            cue.vx += Math.cos(state.angle) * cue.spinY * cue.shotSpd * 0.22;
            cue.vy += Math.sin(state.angle) * cue.spinY * cue.shotSpd * 0.22;
            cue.vx += Math.cos(state.angle + Math.PI / 2) * cue.spinX * cue.shotSpd * 0.16;
            cue.vy += Math.sin(state.angle + Math.PI / 2) * cue.spinX * cue.shotSpd * 0.16;
            cue.spun = true;
          }
          cue._ccdDone = true;
          break;
        }
      }
    }
  }

  for (const b of balls) {
    if (b.out) continue;
    if (b.vx * b.vx + b.vy * b.vy > _MINS * _MINS) {
      mv = true;
      const spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy);

      if (b === cue && b._ccdDone) {
        b._ccdDone = false;
      } else {
        const _hitCorners = new Set();
        for (let step = 0; step < substeps; step++) {
          b.x += b.vx * dt / substeps;
          b.y += b.vy * dt / substeps;

          const midGap    = 31;
          const cornerGap = 31;
          const nearTL = b.x < _WL + cornerGap && b.y < _WT + cornerGap;
          const nearTR = b.x > _WR - cornerGap && b.y < _WT + cornerGap;
          const nearBL = b.x < _WL + cornerGap && b.y > _WB - cornerGap;
          const nearBR = b.x > _WR - cornerGap && b.y > _WB - cornerGap;
          const atMidX = b.x > _W / 2 - midGap && b.x < _W / 2 + midGap;

          let hitRail = false;
          if (!nearTL && !nearBL && b.x - _R < _WL) { b.x = _WL + _R; b.vx *= -0.82; hitRail = true; }
          if (!nearTR && !nearBR && b.x + _R > _WR) { b.x = _WR - _R; b.vx *= -0.82; hitRail = true; }
          if (!atMidX && !nearTL && !nearTR && b.y - _R < _WT) { b.y = _WT + _R; b.vy *= -0.82; hitRail = true; }
          if (!atMidX && !nearBL && !nearBR && b.y + _R > _WB) { b.y = _WB - _R; b.vy *= -0.82; hitRail = true; }

          if (hitRail && onRailHit) {
            if (Math.sqrt(b.vx * b.vx + b.vy * b.vy) > 1.5) onRailHit();
          }

          for (let ci = 0; ci < _corners.length; ci++) {
            if (_hitCorners.has(ci)) continue;
            const c = _corners[ci];
            const dx = b.x - c.cx, dy = b.y - c.cy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < _R + 2 && dist > 0.01) {
              const nx = dx / dist, ny = dy / dist;
              b.x += nx * (_R + 2 - dist); b.y += ny * (_R + 2 - dist);
              const dot = b.vx * nx + b.vy * ny;
              if (dot < 0) { b.vx -= 2 * dot * nx; b.vy -= 2 * dot * ny; b.vx *= 0.72; b.vy *= 0.72; }
              _hitCorners.add(ci);
            } else {
              const prevX = b.x - b.vx / substeps, prevY = b.y - b.vy / substeps;
              const pdx = prevX - c.cx, pdy = prevY - c.cy;
              const prevDist = Math.sqrt(pdx * pdx + pdy * pdy);
              if (prevDist < _R + 2) {
                const nx = pdx / prevDist, ny = pdy / prevDist;
                b.x = c.cx + nx * (_R + 2); b.y = c.cy + ny * (_R + 2);
                const dot = b.vx * nx + b.vy * ny;
                if (dot < 0) { b.vx -= 2 * dot * nx; b.vy -= 2 * dot * ny; b.vx *= 0.72; b.vy *= 0.72; }
                _hitCorners.add(ci);
              }
            }
          }

          for (const s of debugSegments)
            ballSegmentCollision(b, s[0], s[1], s[2], s[3]);
        } // end SUBSTEPS
      }

      b.vx *= fricFrame; b.vy *= fricFrame;
      b.totalRotation = (b.totalRotation || 0) + spd * 0.075;
      if (b.id === 0) {
        const spd2 = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        if (spd2 > 0.1) b.wbFrame = ((b.wbFrame || 0) + spd2 * 1.0 + 120) % 120;
      }
      if (b.vx * b.vx + b.vy * b.vy < _MINS * _MINS) { b.vx = 0; b.vy = 0; }

      {
        const curSpd = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
        if (curSpd > 0.3) {
          const tgt = Math.atan2(b.vy, b.vx);
          let diff = tgt - (b.visualAngle || 0);
          while (diff < -Math.PI) diff += Math.PI * 2;
          while (diff > Math.PI) diff -= Math.PI * 2;
          b.visualAngle = (b.visualAngle || 0) + diff * 0.3;
        }
      }
    }
  }

  _resolveCollisions(balls, state, callbacks);
  _resolveCollisions(balls, state, callbacks);
  _resolveCollisions(balls, state, callbacks);

  for (const b of balls) {
    if (b.out) continue;
    for (let pi = 0; pi < _PKT.length; pi++) {
      const p = _PKT[pi];
      if (Math.sqrt((b.x - p.x) ** 2 + (b.y - p.y) ** 2) < p.r) {
        b.vx = 0; b.vy = 0; b.out = true;
        onPocketed(b, pi);
        break;
      }
    }
  }

  return mv;
}

// ── simulateShot ─────────────────────────────────────────────────────────────
// Simula un tiro completo de forma síncrona. Para validación server-side.
// angleRad: ángulo en radianes (mismo sistema que game.js)
// power:    0–85 (misma escala que _applyShot en game.js)
function simulateShot(ballsSnapshot, angleRad, power, spinX, spinY) {
  const balls = JSON.parse(JSON.stringify(ballsSnapshot));

  const cue = balls.find(b => b.id === 0);
  if (cue) {
    const spd   = (power / 85) * _MAXP;
    cue.vx      = Math.cos(angleRad) * spd;
    cue.vy      = Math.sin(angleRad) * spd;
    cue.spinX   = spinX  || 0;
    cue.spinY   = spinY  || 0;
    cue.shotSpd = spd;
    cue.spun    = false;
  }

  const state = {
    angle:          angleRad,
    ballInHand:     false,
    firstContactId: null,
    debugSegments:  []
  };

  const pocketedInfo = {}; // ballId → pocket index
  const collisionEvents = [];
  const railHitEvents   = [];
  const callbacks = {
    onPocketed:  (ball, pi) => { ball.out = true; ball.vx = 0; ball.vy = 0; pocketedInfo[ball.id] = pi; },
    onCollision: (spd, x, y) => { collisionEvents.push({ step: steps, spd, x, y }); },
    onRailHit:   () => { railHitEvents.push({ step: steps }); }
  };

  const DT          = 16;
  const MAX_STEPS   = 10000;
  const SAMPLE_RATE = 3; // Record every 3 steps (~48ms)
  let steps         = 0;
  let stillMoving   = true;

  const snapshots = [];
  snapshots.push({
    balls: balls.map(b => ({ id: b.id, x: b.x, y: b.y, out: b.out })),
    step: 0,
    collisions: [],
    railHits:   []
  });

  while (stillMoving && steps < MAX_STEPS) {
    const outBefore = balls.map(b => b.out);
    stillMoving = _phys(DT, balls, state, callbacks);
    steps++;

    const newPocket = balls.some((b, i) => b.out && !outBefore[i]);
    if (steps % SAMPLE_RATE === 0 || !stillMoving || newPocket) {
      snapshots.push({
        balls:      balls.map(b => ({ id: b.id, x: b.x, y: b.y, out: b.out })),
        step:       steps,
        collisions: collisionEvents.splice(0),
        railHits:   railHitEvents.splice(0)
      });
    }
  }

  return {
    balls,
    frames:         snapshots,
    firstContactId: state.firstContactId,
    pocketedInfo,
    steps,
    timedOut:       steps >= MAX_STEPS
  };
}

// ── Exporta para Node.js; registra en window para browser ────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { simulateShot, sanitizeSnapshot, validateShotParams, _phys, _resolveCollisions };
} else if (typeof window !== 'undefined') {
  window._phys = _phys;
}
