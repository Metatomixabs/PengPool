"use strict";
// ── Bot AI — vs Bot practice mode ─────────────────────────────────────────────
(function(){

  const DIFF = {
    easy:   { aimError:6,  powerMin:0.30, powerMax:0.50, thinkTime:1800 },
    medium: { aimError:3,  powerMin:0.45, powerMax:0.70, thinkTime:1000 },
    hard:   { aimError:1,  powerMin:0.55, powerMax:0.80, thinkTime:600  },
  };

  const NAMES = {
    hard:   ['The Shark','Viper','Ace','Legend','Pro Master'],
    medium: ['Alex','Jordan','Casey','Riley','Taylor','Jamie','Morgan','Sidney','Drew','Avery'],
    easy:   ['Rookie','Newbie','Novice','Beginner Bob','First Timer'],
  };

  let _diff  = 'medium';
  let _name  = 'Bot';
  let _timer = null;
  // Pocket index (into PKT[]) locked in when the bot first targets the 8-ball.
  // Null until then; reset to null whenever the bot is NOT targeting the 8-ball.
  let _botCalledPocket = null;

  window.setBotDifficulty = function(diff) {
    _diff = diff;
    _botCalledPocket = null;
    const roster = NAMES[diff] || NAMES.medium;
    _name = roster[Math.floor(Math.random() * roster.length)];
    const lbl = document.getElementById('p2label');
    if (lbl) lbl.textContent = _name;
    return _name;
  };

  window.getBotName = function() { return _name; };

  // ── Geometry helpers ──────────────────────────────────────────────────────────

  function _dist2(ax, ay, bx, by) { return (bx-ax)*(bx-ax) + (by-ay)*(by-ay); }

  // Minimum distance from point (px,py) to segment (ax,ay)→(bx,by)
  function _distToSegment(ax, ay, bx, by, px, py) {
    const dx = bx-ax, dy = by-ay;
    const len2 = dx*dx + dy*dy;
    if (len2 === 0) return Math.sqrt(_dist2(ax, ay, px, py));
    const t = Math.max(0, Math.min(1, ((px-ax)*dx + (py-ay)*dy) / len2));
    return Math.sqrt(_dist2(ax + t*dx, ay + t*dy, px, py));
  }

  // Returns { pocket, dist, idx } — the nearest PKT entry to ball b
  function _nearestPocket(b) {
    let bestIdx = 0, bestD = Infinity;
    for (let i = 0; i < PKT.length; i++) {
      const d = Math.sqrt(_dist2(b.x, b.y, PKT[i].x, PKT[i].y));
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    return { pocket: PKT[bestIdx], dist: bestD, idx: bestIdx };
  }

  // Ghost ball center: the cue must arrive here to send target toward pocket
  function _ghostBallPos(target, pocket) {
    const tx = pocket.x - target.x, ty = pocket.y - target.y;
    const tlen = Math.sqrt(tx*tx + ty*ty);
    if (tlen < 0.001) return { x: target.x, y: target.y };
    return {
      x: target.x - (tx/tlen) * 2 * R,
      y: target.y - (ty/tlen) * 2 * R,
    };
  }

  // ── Target helpers ────────────────────────────────────────────────────────────

  // Returns the list of balls the bot is legally allowed to target this turn
  function _validTargets() {
    const inPlay = balls.filter(b => !b.out && b.id !== 0);
    if (!inPlay.length) return [];

    if (typed && p2T) {
      const botGroup = p2T === 'solid'
        ? inPlay.filter(b => b.id >= 1 && b.id <= 7)
        : inPlay.filter(b => b.id >= 9 && b.id <= 15);
      if (!botGroup.length) {
        const eight = inPlay.find(b => b.id === 8);
        return eight ? [eight] : [];
      }
      return botGroup; // 8-ball is never in 1-7 or 9-15
    }

    // Table open — never target the 8-ball
    return inPlay.filter(b => b.id !== 8);
  }

  // Balls that must NOT be the first ball contacted by the cue (opponent + 8 when not targeting it)
  function _obstacles(targetId) {
    const obs = [];
    if (typed && p2T) {
      const oppGroup = p2T === 'solid' ? [9,10,11,12,13,14,15] : [1,2,3,4,5,6,7];
      for (const b of balls) {
        if (!b.out && oppGroup.includes(b.id)) obs.push(b);
      }
    }
    // The 8-ball is an obstacle unless we're aiming at it
    if (targetId !== 8) {
      const eight = balls.find(b => b.id === 8 && !b.out);
      if (eight) obs.push(eight);
    }
    return obs;
  }

  // True if any obstacle ball lies within 2R of the cue→ghostBall path
  function _pathBlocked(gx, gy, obs) {
    for (const b of obs) {
      if (_distToSegment(cue.x, cue.y, gx, gy, b.x, b.y) < 2 * R) return true;
    }
    return false;
  }

  // ── Main shot logic ───────────────────────────────────────────────────────────

  function _doShot() {
    if (typeof gameMode === 'undefined' || gameMode !== 'bot') return;
    if (cur !== 2 || !running || moving) return;

    const cfg = DIFF[_diff] || DIFF.medium;

    // Handle ball-in-hand: place cue ball before shooting
    if (ballInHand) {
      cue.out = false;
      cue.x = BIH_X + (Math.random() - 0.5) * 30;
      cue.y = H / 2  + (Math.random() - 0.5) * 30;
      cue.vx = 0; cue.vy = 0;
      ballInHand = false;
      if (typeof _updateBonusUI === 'function') _updateBonusUI();
    }

    if (!cue || cue.out) return;

    const candidates = _validTargets();
    if (!candidates.length) return;

    const targeting8 = candidates.length === 1 && candidates[0].id === 8;

    // Reset called pocket when no longer in 8-ball phase
    if (!targeting8) _botCalledPocket = null;

    // Sort candidates easiest first (closest ball to any pocket)
    const sorted = candidates.slice().sort((a, b) => _nearestPocket(a).dist - _nearestPocket(b).dist);

    // For each candidate (easiest first), compute ghost ball and check for blocked paths
    const obs = _obstacles(targeting8 ? 8 : -1);
    let target = null, chosenGhost = null, chosenPocket = null;

    for (const candidate of sorted) {
      let pocket;
      if (targeting8 && _botCalledPocket !== null) {
        pocket = PKT[_botCalledPocket];
      } else {
        pocket = _nearestPocket(candidate).pocket;
      }
      const ghost = _ghostBallPos(candidate, pocket);
      if (!_pathBlocked(ghost.x, ghost.y, obs)) {
        target = candidate;
        chosenGhost = ghost;
        chosenPocket = pocket;
        break;
      }
    }

    // Fallback: best target regardless of obstacles (better than skipping the turn)
    if (!target) {
      target = sorted[0];
      chosenPocket = (targeting8 && _botCalledPocket !== null)
        ? PKT[_botCalledPocket]
        : _nearestPocket(target).pocket;
      chosenGhost = _ghostBallPos(target, chosenPocket);
    }

    // Lock in the called pocket the first time the bot targets the 8-ball
    if (targeting8 && _botCalledPocket === null) {
      _botCalledPocket = _nearestPocket(target).idx;
      chosenPocket = PKT[_botCalledPocket];
      chosenGhost  = _ghostBallPos(target, chosenPocket);
    }

    // Aim from cue to ghost ball position, then add difficulty error
    let aimAngle = Math.atan2(chosenGhost.y - cue.y, chosenGhost.x - cue.x);
    const errRad = cfg.aimError * Math.PI / 180;
    aimAngle += (Math.random() - 0.5) * 2 * errRad;

    // Power: hard uses controlled medium-high range scaled to distance
    let power;
    if (_diff === 'hard') {
      const pocketDist = Math.sqrt(_dist2(target.x, target.y, chosenPocket.x, chosenPocket.y));
      power = pocketDist > 200
        ? (0.60 + Math.random() * 0.20) * 100   // far — up to 80%
        : (0.60 + Math.random() * 0.15) * 100;  // near — 60–75%
    } else {
      power = (cfg.powerMin + Math.random() * (cfg.powerMax - cfg.powerMin)) * 100;
    }

    _applyShot(aimAngle, power, 0, 0);
  }

  window._triggerBotIfNeeded = function() {
    if (typeof gameMode === 'undefined' || gameMode !== 'bot') return;
    if (cur !== 2 || !running || moving) return;
    if (_timer) clearTimeout(_timer);
    const cfg = DIFF[_diff] || DIFF.medium;
    _timer = setTimeout(_doShot, cfg.thinkTime);
  };

})();
