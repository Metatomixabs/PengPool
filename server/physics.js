// physics.js — motor de física puro, compatible browser + Node.js
// Sin reglas de juego, UI, audio ni WebSocket.

// ── Constantes de tabla ──────────────────────────────────────────────────────
const _R         = 11;
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

// ── Collision shapes (precomputed at module load) ─────────────────────────────
if (typeof require !== 'undefined') {
  global.COLLISION_SHAPES = require('./collision_shapes.js').COLLISION_SHAPES;
}
// Browser: COLLISION_SHAPES already in global scope from collision_shapes.js <script>

function chamferedBox(x, y, w, h, cutTL, cutTR, cutBL, cutBR, angleTL, angleTR, angleBL, angleBR) {
  const maxC = Math.min(w, h) / 2;
  const clamp = c => Math.min(Math.abs(c), maxC);
  const deg2rad = a => a * Math.PI / 180;
  const tl = clamp(cutTL), tr = clamp(cutTR), bl = clamp(cutBL), br = clamp(cutBR);
  const cxTL = tl * Math.sin(deg2rad(angleTL)), cyTL = tl * Math.cos(deg2rad(angleTL));
  const cxTR = tr * Math.sin(deg2rad(angleTR)), cyTR = tr * Math.cos(deg2rad(angleTR));
  const cxBL = bl * Math.sin(deg2rad(angleBL)), cyBL = bl * Math.cos(deg2rad(angleBL));
  const cxBR = br * Math.sin(deg2rad(angleBR)), cyBR = br * Math.cos(deg2rad(angleBR));
  return [
    { x: x + cxTL,     y: y            },
    { x: x + w - cxTR, y: y            },
    { x: x + w,        y: y + cyTR     },
    { x: x + w,        y: y + h - cyBR },
    { x: x + w - cxBR, y: y + h        },
    { x: x + cxBL,     y: y + h        },
    { x: x,            y: y + h - cyBL },
    { x: x,            y: y + cyTL     },
  ];
}

function precomputeShapes(shapes) {
  const RAIL_POLYS = [];
  const POCKETS    = [];

  for (const shape of shapes) {
    if (shape.type === 'rail') {
      const vertices = chamferedBox(shape.x, shape.y, shape.w, shape.h, shape.cutTL, shape.cutTR, shape.cutBL, shape.cutBR, shape.angleTL, shape.angleTR, shape.angleBL, shape.angleBR);
      const edges = [];
      for (let i = 0; i < 8; i++) {
        const a  = vertices[i];
        const b  = vertices[(i + 1) % 8];
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        edges.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, ex, ey, lenSq: ex * ex + ey * ey });
      }
      RAIL_POLYS.push({ id: shape.id, label: shape.label, vertices, edges });
    } else if (shape.type === 'pocket') {
      POCKETS.push({
        id:     shape.id,
        label:  shape.label,
        cx:     shape.cx,
        cy:     shape.cy,
        rxInv2: 1 / (shape.rx * shape.rx),
        ryInv2: 1 / (shape.ry * shape.ry),
      });
    }
  }

  return { RAIL_POLYS, POCKETS };
}

const { RAIL_POLYS, POCKETS } = precomputeShapes(COLLISION_SHAPES);

// ── collideBallWithRails ──────────────────────────────────────────────────────
function collideBallWithRails(ball, onRailHit) {
  let anyHit = false;

  for (const rail of RAIL_POLYS) {
    let minDistSq = Infinity;
    let closestPx = 0;
    let closestPy = 0;

    for (const edge of rail.edges) {
      if (edge.lenSq === 0) continue;
      const t  = Math.max(0, Math.min(1,
        ((ball.x - edge.ax) * edge.ex + (ball.y - edge.ay) * edge.ey) / edge.lenSq
      ));
      const px  = edge.ax + t * edge.ex;
      const py  = edge.ay + t * edge.ey;
      const dx  = ball.x - px;
      const dy  = ball.y - py;
      const dSq = dx * dx + dy * dy;
      if (dSq < minDistSq) {
        minDistSq = dSq;
        closestPx = px;
        closestPy = py;
      }
    }

    if (minDistSq < _R * _R) {
      const dist = Math.sqrt(minDistSq);
      const nx   = dist > 0.001 ? (ball.x - closestPx) / dist : 0;
      const ny   = dist > 0.001 ? (ball.y - closestPy) / dist : 1;

      // Resolve penetration
      ball.x = closestPx + nx * _R;
      ball.y = closestPy + ny * _R;

      // Reflect velocity component along normal (restitution 0.82)
      const vn = ball.vx * nx + ball.vy * ny;
      if (vn < 0) {
        ball.vx -= (1 + 0.82) * vn * nx;
        ball.vy -= (1 + 0.82) * vn * ny;
      }
      anyHit = true;
    }
  }

  if (anyHit && onRailHit && Math.hypot(ball.vx, ball.vy) > 1.5) {
    onRailHit();
  }
}

// ── checkPocketEntry ──────────────────────────────────────────────────────────
function checkPocketEntry(ball, onPocketed) {
  for (let pi = 0; pi < POCKETS.length; pi++) {
    const p  = POCKETS[pi];
    const dx = ball.x - p.cx;
    const dy = ball.y - p.cy;
    if (dx * dx * p.rxInv2 + dy * dy * p.ryInv2 <= 1) {
      ball.vx = 0; ball.vy = 0; ball.out = true;
      onPocketed(ball, pi);
      break;
    }
  }
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
        const overlap = mn - d;
        const spdA = Math.hypot(a.vx, a.vy);
        const spdB = Math.hypot(b.vx, b.vy);
        const total = spdA + spdB;
        const wA = total > 0 ? spdA / total : 0.5;
        const wB = total > 0 ? spdB / total : 0.5;
        a.x -= nx * overlap * wA; a.y -= ny * overlap * wA;
        b.x += nx * overlap * wB; b.y += ny * overlap * wB;

        const dv = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
        if (dv > 0) {
          const impulse = dv > 0.01 ? dv : 0;
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
// state      : { angle, ballInHand, firstContactId }
// callbacks  : { onPocketed(ball,pi), onCollision(spd,x,y), onRailHit() }
// Retorna    : true si alguna bola sigue en movimiento
function _phys(frameDelta, balls, state, callbacks) {
  const onPocketed = callbacks?.onPocketed || ((ball) => { ball.out = true; ball.vx = 0; ball.vy = 0; });
  const onRailHit  = callbacks?.onRailHit  || null;

  const cue = balls.find(b => b.id === 0);

  const dt        = frameDelta / 16.667;
  const fricFrame = Math.pow(_FRIC_BASE, dt);
  const cueSpeed  = cue && !cue.out ? Math.hypot(cue.vx, cue.vy) : 0;
  const minSubs   = Math.max(6, Math.ceil(dt / 4));
  const substeps  = Math.max(minSubs, Math.min(32, Math.ceil(cueSpeed * dt / (_R * 0.3))));
  let mv = false;

  // CCD para la bola blanca
  if (cue && !cue.out) {
    const speed = Math.sqrt(cue.vx * cue.vx + cue.vy * cue.vy);
    if (speed > _R) {
      const nx0 = cue.vx / speed, ny0 = cue.vy / speed;
      let minTC = Infinity, minO = null;
      for (const o of balls) {
        if (o === cue || o.out) continue;
        const bx = o.x - cue.x, by = o.y - cue.y;
        const tCA = bx * nx0 + by * ny0;
        if (tCA < 0 || tCA > speed) continue;
        const perpSq = bx * bx + by * by - tCA * tCA;
        if (perpSq > _R * 2 * (_R * 2)) continue;
        const tC = tCA - Math.sqrt(_R * 2 * (_R * 2) - perpSq);
        if (tC > 0 && tC <= speed && tC < minTC) { minTC = tC; minO = o; }
      }
      if (minO !== null) {
        const o = minO;
        cue.x += nx0 * minTC; cue.y += ny0 * minTC;
        const dxC = o.x - cue.x, dyC = o.y - cue.y;
        const dC = Math.sqrt(dxC * dxC + dyC * dyC);
        if (dC < _R * 2) {
          const correction = (_R * 2 - dC);
          cue.x -= (dxC / dC) * correction;
          cue.y -= (dyC / dC) * correction;
        }
        const dx = o.x - cue.x, dy = o.y - cue.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const cnx = dx / d, cny = dy / d;
        const ov = _R * 2 - d;
        cue.x -= cnx * ov;
        cue.y -= cny * ov;
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
        for (let step = 0; step < substeps; step++) {
          b.x += b.vx * dt / substeps;
          b.y += b.vy * dt / substeps;

          collideBallWithRails(b, onRailHit);
          checkPocketEntry(b, onPocketed);
          if (b.out) break;
        }
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
  };

  const pocketedInfo    = {}; // ballId → pocket index
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
