"use strict";

const { simulateShot } = require('./physics.js');

// ── Reproduce exactly the same constants as game.js ──────────────────────────
const W = 800, H = 500, R = 11;
const S   = Math.sin(Math.PI / 3);
const spx = Math.sqrt(3) * R * 1.05;
const spy = R / S;
const rx  = 525, ry = H / 2;

// Rack order (WPA): apex=1, center=8, back corners solid(6)+stripe(15)
const RACK = [1, 9, 10, 2, 8, 3, 11, 4, 12, 13, 5, 14, 6, 15, 7];
const pos  = [
  [0,  0      ], [1, -S      ], [1,  S      ],
  [2, -2*S    ], [2,  0      ], [2,  2*S    ],
  [3, -3*S    ], [3, -S      ], [3,  S      ], [3,  3*S    ],
  [4, -4*S    ], [4, -2*S    ], [4,  0      ], [4,  2*S    ], [4,  4*S    ],
];

function makeSnapshot() {
  const balls = [];
  // Cue ball
  balls.push({ id: 0, x: 223, y: H / 2, vx: 0, vy: 0, out: false,
               totalRotation: 0, visualAngle: 0, wbFrame: 0, lastAngle: 0 });
  // Rack balls
  for (let i = 0; i < 15; i++) {
    const id = RACK[i];
    const [px, py] = pos[i];
    balls.push({ id, x: rx + px * spx, y: ry + py * spy,
                 vx: 0, vy: 0, out: false, totalRotation: 0, visualAngle: 0 });
  }
  return balls;
}

// ── Run 3 identical simulations ───────────────────────────────────────────────
const ANGLE = 0.5, POWER = 60, SPIN_X = 0, SPIN_Y = 0;
const RUNS  = 3;
const results = [];

console.log(`Running ${RUNS} simulations — angle=${ANGLE} power=${POWER} spinX=${SPIN_X} spinY=${SPIN_Y}\n`);

for (let r = 0; r < RUNS; r++) {
  const snap = makeSnapshot();
  const res  = simulateShot(snap, ANGLE, POWER, SPIN_X, SPIN_Y);
  results.push(res);
  console.log(`Run ${r+1}: steps=${res.steps} timedOut=${res.timedOut} firstContact=${res.firstContactId}`);
  const pocketed = res.balls.filter(b => b.out).map(b => b.id);
  console.log(`  pocketed ids: [${pocketed.join(', ')}]`);
  res.balls.forEach(b => {
    console.log(`  ball ${String(b.id).padStart(2)}: x=${b.x.toFixed(4).padStart(10)}  y=${b.y.toFixed(4).padStart(10)}  out=${b.out}`);
  });
  console.log();
}

// ── Compare ───────────────────────────────────────────────────────────────────
let outMatch = true;
let xyMatch  = true;

for (let r = 1; r < RUNS; r++) {
  const a = results[0].balls;
  const b = results[r].balls;
  for (let i = 0; i < a.length; i++) {
    if (a[i].out !== b[i].out) {
      console.warn(`  MISMATCH out  — ball ${a[i].id}: run1.out=${a[i].out} run${r+1}.out=${b[i].out}`);
      outMatch = false;
    }
    if (a[i].x !== b[i].x || a[i].y !== b[i].y) {
      console.warn(`  MISMATCH xy   — ball ${a[i].id}: run1=(${a[i].x.toFixed(4)},${a[i].y.toFixed(4)}) run${r+1}=(${b[i].x.toFixed(4)},${b[i].y.toFixed(4)})`);
      xyMatch = false;
    }
  }
}

console.log('─'.repeat(60));
if (outMatch && xyMatch) {
  console.log('DETERMINISTIC: YES  (out-state and XY positions identical across all runs)');
} else if (outMatch && !xyMatch) {
  console.log('DETERMINISTIC: PARTIAL  (out-state matches, but XY positions differ)');
} else {
  console.log('DETERMINISTIC: NO  (out-state differs between runs)');
}
