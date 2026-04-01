// ═══════════════════════════
// WEB3 / MATCHMAKING STATE
// ═══════════════════════════
let gameMode        = 'practice';  // 'practice' | 'multiplayer'
let currentGameId   = null;        // on-chain game ID (Number)
let currentGameData = null;        // { player1, player2, betAmount, betUSD, status, winner }
let myPlayerNum     = 1;           // 1 | 2 — our seat in the current game
let myGameId        = null;        // ID of a game we created (waiting for P2)
let selectedBetUSD  = 1;           // bet tier chosen in matchmaking
let _mmCountdown    = 10;
let _mmCdInterval   = null;
let _liveGamesInterval = null;
let _receivedGameOver = false; // guard to avoid echo when we receive gameover from WS
let _matchReady     = false;   // true once the pre-match countdown finishes
let _matchCdInterval = null;
let _oppCueAngle = 0;          // opponent's current aim angle (radians)
let _oppCueActive = false;     // true while opponent is aiming
let _lastCueUpdateWs = 0;      // throttle timestamp for cueUpdate sends
let _dragOrigin = null;        // mouse position at mousedown (drag-to-shoot)
let _lockedAngle = 0;          // angle frozen at mousedown
let _myLevel = 1;
let _mmWs = null;
let _mmBetKey = null;
let _mmSearchInterval = null;
let _mmElapsed = 0;
let _mmRange = 5;
let _mmOpponentAlias = '';
let _mmOpponentAddr  = '';
let _notifWs = null;

function _connectNotifWs(addr) {
  if (_notifWs && _notifWs.readyState === WebSocket.OPEN) return;
  if (_notifWs) { try { _notifWs.close(); } catch(_){} }
  _notifWs = new WebSocket(WS_URL);
  _notifWs.onopen = () => {
    _notifWs.send(JSON.stringify({
      type: 'join',
      gameId: 'notif_' + addr.toLowerCase(),
      playerNum: 0,
      addr: addr,
      alias: getStoredUsername(addr) || ''
    }));
    console.log('[notifWs] connected for', addr.slice(0,8));
  };
  _notifWs.onmessage = (evt) => {
    let msg; try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.type === 'tournament_match_ready')        _tOnMatchReady(msg);
    else if (msg.type === 'tournament_prize_available') _tOnPrizeAvailable(msg);
    else if (msg.type === 'tournament_player_timeout') {
      const myAddr = window.PengPoolWeb3?.getAddress?.()?.toLowerCase();
      if (myAddr && msg.disqualifiedAddr?.toLowerCase() === myAddr) {
        toast('You were disqualified — did not join your match in time.', 1);
      } else {
        toast('Opponent did not join — you advance! 🏆', 0);
      }
    }
    else if (msg.type === 'tournament_finished') _tOnFinished(msg);
  };
  _notifWs.onerror = () => console.warn('[notifWs] error');
  _notifWs.onclose = () => {
    _notifWs = null;
    setTimeout(() => {
      const w = window.PengPoolWeb3;
      if (w && w.isConnected()) _connectNotifWs(w.getAddress());
    }, 5000);
  };
}

// ── Tournament state ───────────────────────────────────────────
let _tCurrentTab    = 'open';
let _tDetailId      = null;
let _tDetailData    = null;
let _tRefreshTimer  = null;
let _tPendingChainId = null;

// ═══════════════════════════
// AUDIO CONTEXT UNLOCK
// ═══════════════════════════
function _resumeAudioCtx() {
  if (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}
['click', 'keydown', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, _resumeAudioCtx, { once: false, passive: true })
);

// ═══════════════════════════
// WEBSOCKET SYNC
// ═══════════════════════════
let _ws = null;
const WS_URL   = window.location.hostname === 'localhost' ? 'ws://localhost:8080'   : 'wss://pengpool-production.up.railway.app';
const HTTP_URL = window.location.hostname === 'localhost' ? 'http://localhost:8080' : 'https://pengpool-production.up.railway.app';

const _AG_KEY = 'pengpool_active_game';
function _saveActiveGame(gameId, playerNum, addr) {
  localStorage.setItem(_AG_KEY, JSON.stringify({ gameId: String(gameId), playerNum, addr }));
}
function _clearActiveGame() { localStorage.removeItem(_AG_KEY); }
function _loadActiveGame()  { try { return JSON.parse(localStorage.getItem(_AG_KEY)); } catch { return null; } }

function _connectWS(gameId, playerNum, addr) {
  if (_ws)   { try { _ws.close();   } catch(_){} _ws   = null; }
  if (_mmWs) { try { _mmWs.close(); } catch(_){} _mmWs = null; }
  try {
    _ws = new WebSocket(WS_URL);
  } catch(e) {
    console.warn('[WS] Cannot connect:', e.message);
    toast('Sync server offline — shots won\'t sync', 1);
    return;
  }
  _ws.onopen = () => {
    const joinMsg = { type: 'join', gameId, playerNum, addr, alias: getStoredUsername(addr) || '', betUSD: _mmBetKey };
    console.log('[WS] Sending join:', JSON.stringify(joinMsg));
    _ws.send(JSON.stringify(joinMsg));
  };
  _ws.onmessage = (evt) => {
    let msg; try { msg = JSON.parse(evt.data); } catch { return; }
    _wsOnMessage(msg);
  };
  _ws.onerror = () => toast('Sync server offline — shots won\'t sync', 1);
  _ws.onclose = () => console.log('[WS] Disconnected');
}

async function _fetchMyLevel(addr) {
  try {
    const res = await fetch(HTTP_URL + '/api/player/' + encodeURIComponent(addr));
    const p = await res.json();
    _myLevel = Number(p.level) || 1;
  } catch(e) {
    _myLevel = 1;
  }
  return _myLevel;
}

function _connectMmWs() {
  if (_mmWs && _mmWs.readyState === WebSocket.OPEN) return;
  if (_mmWs) { try { _mmWs.close(); } catch(_){} }
  _mmWs = new WebSocket(WS_URL);
  _mmWs.onmessage = (evt) => {
    let msg; try { msg = JSON.parse(evt.data); } catch { return; }
    _mmOnMessage(msg);
  };
  _mmWs.onerror = () => toast('Matchmaking server offline', 1);
  _mmWs.onclose = () => { _mmWs = null; };
  return _mmWs;
}

function _mmSend(obj) {
  if (_mmWs && _mmWs.readyState === WebSocket.OPEN) {
    _mmWs.send(JSON.stringify(obj));
  }
}

async function _mmOnMessage(msg) {
  const w = window.PengPoolWeb3;
  if (msg.type === 'mm_queue_counts') {
    const el1 = document.getElementById('mmCount1');
    const el5 = document.getElementById('mmCount5');
    if (el1) el1.textContent = msg.counts['1'] + ' waiting';
    if (el5) el5.textContent = msg.counts['5'] + ' waiting';
  }

  else if (msg.type === 'mm_queue_joined') {
    _mmElapsed = 0;
    _mmRange   = 5;
    // Tick every second for live timer display
    _mmSearchInterval = setInterval(() => {
      _mmElapsed++;
      // Expand range every 15s, max ±15
      if (_mmElapsed % 15 === 0) {
        _mmRange = Math.min(15, 5 + Math.floor(_mmElapsed / 15) * 2);
        const elRange = document.getElementById('mmSearchRange');
        if (elRange) elRange.textContent = '±' + _mmRange;
      }
      const elTime = document.getElementById('mmSearchTime');
      if (elTime) elTime.textContent = _mmElapsed + 's';
    }, 1000);
    show('mmSearching');
  }

  else if (msg.type === 'mm_you_are_p1') {
    clearInterval(_mmSearchInterval);
    _mmOpponentAlias = msg.opponentAlias || '';
    _mmOpponentAddr  = msg.opponentAddr  || '';
    opponentAlias    = msg.opponentAlias || '';
    opponentAddr     = msg.opponentAddr  || '';
    const w    = window.PengPoolWeb3;
    const addr = w.getAddress();
    currentGameId   = String(msg.matchId);
    currentGameData = { betUSD: Number(_mmBetKey), betAmount: '0' };
    // Fetch real betAmount from chain after match is created
    const _w = window.PengPoolWeb3;
    if (_w && currentGameId) {
      _w.getMatch(currentGameId).then(m => {
        if (m && m.betAmount) currentGameData.betAmount = m.betAmount.toString();
      }).catch(() => {});
    }
    myPlayerNum     = 1;
    gameMode        = 'multiplayer';
    _saveActiveGame(currentGameId, 1, addr);
    toast('Match found! Connecting…');
    show('game');
    _showWaitingOverlay();
    _connectWS(currentGameId, 1, addr);
  }

  else if (msg.type === 'mm_wait_for_p1') {
    clearInterval(_mmSearchInterval);
    toast('Match found! Waiting for game…');
    show('mmWaiting');
  }

  else if (msg.type === 'mm_join_game') {
    clearInterval(_mmSearchInterval);
    _mmOpponentAlias = msg.opponentAlias || '';
    _mmOpponentAddr  = msg.opponentAddr  || '';
    opponentAlias    = msg.opponentAlias || '';
    opponentAddr     = msg.opponentAddr  || '';
    const w    = window.PengPoolWeb3;
    const addr = w.getAddress();
    currentGameId   = String(msg.matchId);
    currentGameData = { betUSD: Number(_mmBetKey), betAmount: '0' };
    // Fetch real betAmount from chain after match is created
    const _w = window.PengPoolWeb3;
    if (_w && currentGameId) {
      _w.getMatch(currentGameId).then(m => {
        if (m && m.betAmount) currentGameData.betAmount = m.betAmount.toString();
      }).catch(() => {});
    }
    myPlayerNum     = 2;
    gameMode        = 'multiplayer';
    _saveActiveGame(currentGameId, 2, addr);
    toast('Match found! Connecting…');
    show('game');
    _showWaitingOverlay();
    _connectWS(currentGameId, 2, addr);
  }

  else if (msg.type === 'mm_match_cancelled') {
    clearInterval(_mmSearchInterval);
    toast('Opponent cancelled — searching again…', 1);
    if (_mmBetKey) {
      await _enterQueue(Number(_mmBetKey));
    } else {
      show('matchmaking');
    }
  }

  else if (msg.type === 'mm_requeue') {
    // Stay in queue — opponent had an issue, keep searching
    toast('Opponent issue — still searching…', 2);
  }

  else if (msg.type === 'mm_error') {
    if (msg.reason === 'deposit_not_found') {
      toast('Deposit not detected on-chain. Please try again.', 3);
    } else {
      toast('Matchmaking error: ' + msg.reason, 1);
    }
    _leaveMmQueue();
  }
}

async function _enterQueue(betUSD) {
  const w = window.PengPoolWeb3;
  const addr = w?.getAddress();
  if (!addr) { toast('Connect wallet first', 1); return; }
  await _fetchMyLevel(addr);

  const statusRes = await fetch(HTTP_URL + '/api/player-status/' + addr).then(r => r.json());
  if (statusRes.status === 'settling') {
    toast('Previous match is still closing, please wait a few seconds.', 3);
    return;
  }
  if (statusRes.status === 'in_room') {
    toast('You already have an active match. Use Recovery Panel to rejoin.', 3);
    return;
  }

  _mmBetKey = String(betUSD);

  // Populate search screen fields
  const elLevel = document.getElementById('mmMyLevel');
  const elBet   = document.getElementById('mmSearchBet');
  const elRange = document.getElementById('mmSearchRange');
  const elTime  = document.getElementById('mmSearchTime');
  if (elLevel) elLevel.textContent = _myLevel;
  if (elBet)   elBet.textContent   = '$' + _mmBetKey;
  if (elRange) elRange.textContent = '±5';
  if (elTime)  elTime.textContent  = '0s';

  // Step 1: deposit on-chain (user gesture — no popup block)
  try {
    toast('Depositing wager…');
    await w.deposit(Number(betUSD));
  } catch(e) {
    console.error('[mm] deposit failed:', e);
    toast('Transaction cancelled: ' + (e?.message || JSON.stringify(e)), 1);
    return;
  }

  toast('Finding match…');
  show('mmSearching');

  // Step 2: connect MM WebSocket and join queue
  _connectMmWs();
  const ws = _mmWs;
  ws.onopen = () => {
    _mmSend({
      type:   'mm_join_queue',
      betUSD: _mmBetKey,
      level:  _myLevel,
      addr:   addr,
      alias:  getStoredUsername(addr) || shortenAddr(addr)
    });
  };
}

async function _leaveMmQueue() {
  clearInterval(_mmSearchInterval);
  _mmSend({ type: 'mm_leave_queue' });
  if (_mmWs) { try { _mmWs.close(); } catch(_){} _mmWs = null; }
  const w = window.PengPoolWeb3;
  if (w && w.isConnected()) {
    try {
      await w.withdrawDeposit();
      toast('Deposit withdrawn — ETH refunded');
    } catch(e) {
      console.warn('[mm] withdrawDeposit failed:', e.message);
    }
  }
  show('lobby');
}

function _wsSend(obj) {
  if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send(JSON.stringify(obj));
}

function _showWaitingOverlay() {
  const el = document.getElementById('waitingOverlay');
  if (el) el.classList.add('on');
}
function _hideWaitingOverlay() {
  const el = document.getElementById('waitingOverlay');
  if (el) el.classList.remove('on');
}

function _showReconnectOverlay(timeLeft) {
  console.log('[reconnect] _showReconnectOverlay called, timeLeft=', timeLeft);
  let el = document.getElementById('reconnectOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'reconnectOverlay';
    el.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.72);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:900;color:#fff;font-family:"Space Mono",monospace;gap:14px';
    el.innerHTML = '<div style="font-size:15px;letter-spacing:1px">OPPONENT DISCONNECTED</div>'
      + '<div id="reconnectCountdown" style="font-size:36px;font-weight:700;color:#f0c040"></div>'
      + '<div style="font-size:11px;color:rgba(255,255,255,.55)">Waiting for reconnection…</div>';
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
  _updateReconnectOverlay(timeLeft);
}
function _updateReconnectOverlay(timeLeft) {
  const cd = document.getElementById('reconnectCountdown');
  if (cd) cd.textContent = timeLeft + 's';
}
function _hideReconnectOverlay() {
  const el = document.getElementById('reconnectOverlay');
  if (el) el.style.display = 'none';
}

function _wsOnMessage(msg) {
  const G = window.PengPoolGame;
  if (msg.type === 'ready') {
    console.log('Ready received, opponentAlias:', msg.opponentAlias);
    if (msg.yourPlayerNum) {
      myPlayerNum = msg.yourPlayerNum;
      console.log('[WS] playerNum corrected to', myPlayerNum);
    }
    _hideWaitingOverlay();
    _startMatchCountdown(msg.opponentAddr, msg.opponentAlias || '');
  }
  else if (msg.type === 'state') {
    // P2 applies P1's rack layout so both boards are identical
    if (G) { G.applyBallsState(msg.balls); toast('Board synced!'); }
  }
  else if (msg.type === 'rack') {
    // P1 restarted mid-session — rack is deterministic so just reset local state
    initState();
  }
  else if (msg.type === 'cueUpdate') {
    // Ignore if opponent's shot is already in flight (guards against stale in-flight messages)
    if (gameMode === 'multiplayer' && cur === myPlayerNum) return;
    _oppCueAngle = msg.angle;
    if (msg.ballInHand) { _oppCueActive = false; } else { _oppCueActive = true; }
    if (msg.x != null && msg.y != null && cue && !cue.out) { cue.x = msg.x; cue.y = msg.y; }
  }
  else if (msg.type === 'shoot') {
    // Opponent fired — cue disappears, no local physics; animation comes via 'frame' messages
    _oppCueActive = false;
    console.log('[SYNC] received shoot notification from opponent');
    if (G) G.applyRemoteShoot();
  }
  else if (msg.type === 'frame') {
    // Live ball positions from shooter — cue must not be visible during shot
    _oppCueActive = false;
    if (G) G.applyFrame(msg.balls);
  }
  else if (msg.type === 'result') {
    // Authoritative final state from the shooter — apply and update turn
    _oppCueActive = false;
    console.log('[SYNC] received result from server — cur='+msg.cur+' balls='+(msg.balls&&msg.balls.length));
    if (G) G.applyResult(msg); else console.warn('[SYNC] PengPoolGame not ready!');
  }
  else if (msg.type === 'sound') {
    _resumeAudioCtx();
    if (msg.sound === 'collision') playCollision(msg.param != null ? msg.param : 1);
    else if (msg.sound === 'rail') playRailHit();
    else if (msg.sound === 'pocket') playPocket();
  }
  else if (msg.type === 'timerTick') {
    // Sync the active player's countdown on this client
    _timerSec = msg.sec;
    _updateTimerDisplay();
  }
  else if (msg.type === 'timeout') {
    // Active player's turn timer expired — sync the turn change locally
    _oppCueActive = false;
    toast('Opponent ran out of time!', 0);
    switchTurn();
  }
  else if (msg.type === 'gameover') {
    if (document.getElementById('modal')?.classList.contains('on')) return; // already settled
    _receivedGameOver = true;
    _clearActiveGame();
    _hideReconnectOverlay();
    const reason = msg.reason === 'opponent_timeout' ? 'You win — opponent didn\'t reconnect'
                 : msg.reason === 'opponent_left'    ? 'You win — opponent abandoned the match'
                 : msg.reason;
    endGame(msg.winnerNum, reason);
  }
  else if (msg.type === 'opponent_disconnected') {
    console.log('[reconnect] opponent_disconnected received, timeLeft=', msg.timeLeft);
    _showReconnectOverlay(msg.timeLeft);
  }
  else if (msg.type === 'reconnect_countdown') {
    _updateReconnectOverlay(msg.timeLeft);
  }
  else if (msg.type === 'request_state') {
    // Server is asking us to send current game state to a reconnecting opponent
    if (G && gameMode === 'multiplayer') {
      const data = G.gatherResult();
      _wsSend(Object.assign({ type: 'sync_state', gameId: currentGameId }, data));
    }
  }
  else if (msg.type === 'rejoin_state') {
    // Restore game state for the player who just rejoined
    if (msg.gameState && G) {
      G.applyResult(msg.gameState);
    }

    // Restore player labels from server-provided aliases
    if (msg.p1addr || msg.p1alias) {
      const p1lbl = document.getElementById('p1label');
      const p2lbl = document.getElementById('p2label');
      const _w = window.PengPoolWeb3;
      const myAddr = _w?.getAddress()?.toLowerCase() || '';
      const isP1   = myAddr === (msg.p1addr || '').toLowerCase();
      const myName  = _w ? getDisplayName(_w.getAddress()) : (myPlayerNum === 1 ? 'Player 1' : 'Player 2');
      const oppName = isP1
        ? (msg.p2alias || shortenAddr(msg.p2addr || ''))
        : (msg.p1alias || shortenAddr(msg.p1addr || ''));
      if (p1lbl) p1lbl.textContent = isP1 ? myName : oppName;
      if (p2lbl) p2lbl.textContent = isP1 ? oppName : myName;
    }

    // Restore currentGameData from chain if missing
    if (!currentGameData && currentGameId) {
      const _w = window.PengPoolWeb3;
      if (_w) {
        _w.getMatch(currentGameId)
          .then(data => { currentGameData = data; })
          .catch(e => console.warn('[rejoin] getMatch failed:', e));
      }
    }

    // Allow shooting again
    _matchReady = true;
    _hideWaitingOverlay();
    _hideReconnectOverlay();
  }
  else if (msg.type === 'opponent_reconnected') {
    _hideReconnectOverlay();
    // If we are the one who reconnected, _matchReady was already set by rejoin_state.
    // If we are the waiting player, just re-enable play.
    _matchReady = true;
    toast('Opponent reconnected!');
  }
  else if (msg.type === 'settled') {
    const sub = document.getElementById('msub');
    if (!sub) return;
    if (msg.error) {
      sub.innerHTML = sub.innerHTML.replace('Settling on-chain\u2026',
        '<span style="font-size:11px;color:#ff6b6b">Settlement failed: '+msg.error+'</span>');
    } else {
      const iWon = (msg.winnerNum === myPlayerNum);
      if (iWon && currentGameId && String(msg.gameId) === String(currentGameId)) {
        // Show claim button — let the winner trigger the wallet popup manually
        sub.innerHTML = sub.innerHTML.replace('Settling on-chain\u2026', 'You won! Claim your reward below.');
        const btnClaim  = document.getElementById('btnClaim');
        const btnMlobby = document.getElementById('btnMlobby');
        btnClaim.disabled = false;
        btnClaim.textContent = 'CLAIM REWARD';
        btnClaim.style.display = 'block';
        btnMlobby.disabled = true;
        btnMlobby.classList.add('btn-disabled');
        btnClaim.onclick = function() {
          btnClaim.disabled  = true;
          btnMlobby.disabled = true;
          btnClaim.textContent = 'Claiming\u2026';
          const w = window.PengPoolWeb3;
          w.claimWinnings(currentGameId)
            .then(tx => {
              const short = tx ? String(tx).slice(0,14)+'\u2026' : '';
              sub.innerHTML = '<span style="font-family:\'Space Mono\',monospace;font-size:9px;color:var(--t2)">Claimed \xb7 '+short+'</span>';
              btnClaim.style.display = 'none';
              btnMlobby.disabled = false;
              btnMlobby.classList.remove('btn-disabled');
              const _claimAddr = window.PengPoolWeb3?.getAddress();
              if (_claimAddr) {
                fetch(HTTP_URL + '/api/pending-claim/' + _claimAddr, {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ matchId: currentGameId })
                }).catch(e => console.warn('[claim] pending-claim cleanup failed:', e));
              }
            })
            .catch(e => {
              sub.innerHTML = '<span style="font-size:11px;color:#ff6b6b">Claim failed \u2014 try again.</span>';
              btnClaim.disabled = false;
              btnClaim.textContent = 'CLAIM REWARD';
            });
        };
      } else {
        const short = msg.txHash ? msg.txHash.slice(0,14)+'\u2026' : '';
        sub.innerHTML = sub.innerHTML.replace('Settling on-chain\u2026',
          '<span style="font-family:\'Space Mono\',monospace;font-size:9px;color:var(--t2)">Settled \xb7 '+short+'</span>');
      }
    }
  }
  else if (msg.type === 'spectate_start') {
    if (msg.gameState && G) G.applyResult(msg.gameState);
    const p1label = document.getElementById('p1label');
    const p2label = document.getElementById('p2label');
    if (p1label) p1label.textContent = msg.p1alias || 'Player 1';
    if (p2label) p2label.textContent = msg.p2alias || 'Player 2';
    const badge = document.getElementById('spectatorBadge');
    if (badge) badge.style.display = 'block';
    _matchReady = true;
    _hideWaitingOverlay();
  }
  else if (msg.type === 'disconnect') {
    toast('Opponent disconnected!', 1);
  }
  else if (msg.type === 'error') {
    if (msg.code === 'ALREADY_IN_GAME') {
      toast('Ya tenés una partida abierta en otra pestaña', 1);
      // Return to matchmaking so the player sees their existing game
      if (typeof show === 'function') { stopMusic(); _resetGS(); show('matchmaking'); _mmStart(); }
    }
  }
  else if (msg.type === 'tournament_match_ready') { _tOnMatchReady(msg); }
  else if (msg.type === 'tournament_player_timeout') {
    const myAddr = window.PengPoolWeb3?.getAddress?.()?.toLowerCase();
    if (myAddr && msg.disqualifiedAddr?.toLowerCase() === myAddr) {
      toast('You were disqualified — did not join your match in time.', 1);
    } else {
      toast('Opponent did not join — you advance! 🏆', 0);
    }
  }
  else if (msg.type === 'tournament_finished')       { _tOnFinished(msg); }
  else if (msg.type === 'tournament_prize_available'){ _tOnPrizeAvailable(msg); }
}

// ═══════════════════════════════════════════════════════
// TOURNAMENT UI
// ═══════════════════════════════════════════════════════

function _tShowTab(tab) {
  _tCurrentTab = tab;
  ['open','active','finished'].forEach(t => {
    const el = document.getElementById('tTab' + t.charAt(0).toUpperCase() + t.slice(1));
    if (el) el.classList.toggle('active', t === tab);
  });
  _tLoadList();
}

async function _tLoadList() {
  const list = document.getElementById('tList');
  if (!list) return;
  list.innerHTML = '<div class="level-loading">Loading…</div>';
  try {
    const statusMap = { open: 'registration', active: 'active', finished: 'finished' };
    const res = await fetch(HTTP_URL + '/api/tournaments');
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) {
      list.innerHTML = '<div class="level-noconn">No tournaments found.</div>';
      return;
    }
    list.innerHTML = data.map(t => {
      const start = new Date(t.start_time).toLocaleString();
      return `<div class="t-card" onclick="_tOpenDetail(${t.id})">
        <div class="t-card-name">${t.name}</div>
        <div class="t-card-meta">Buy-in: <b>$${t.buy_in_usd}</b> · ${t.participant_count} players · ${start}</div>
        <div class="t-card-status t-status-${t.status}">${t.status.toUpperCase()}</div>
      </div>`;
    }).join('');
  } catch(e) {
    list.innerHTML = '<div class="level-noconn">Failed to load tournaments.</div>';
  }
}

async function _tOpenDetail(tId) {
  _tDetailId = tId;
  clearInterval(_tRefreshTimer);
  show('tournamentDetail');
  document.getElementById('tDetailName').textContent = 'TOURNAMENT';
  document.getElementById('tDetailMeta').innerHTML = '<div class="level-loading">Loading…</div>';
  document.getElementById('tBracket').innerHTML = '';
  await _tRefreshDetail();
  _tRefreshTimer = setInterval(_tRefreshDetail, 10000);
}
window._tOpenDetail = _tOpenDetail;

async function _tRefreshDetail() {
  if (!_tDetailId) return;
  try {
    const res = await fetch(HTTP_URL + '/api/tournament/' + _tDetailId);
    _tDetailData = await res.json();
    _tRenderDetail(_tDetailData);
  } catch(e) {
    console.warn('[tournament] detail fetch failed:', e.message);
  }
}

function _tRenderDetail(t) {
  const nameEl = document.getElementById('tDetailName');
  if (nameEl) nameEl.textContent = (t.name || 'TOURNAMENT').toUpperCase();

  const metaEl = document.getElementById('tDetailMeta');
  if (metaEl) {
    const start = new Date(t.start_time).toLocaleString();
    const pool  = t.prize_pool_eth ? Number(t.prize_pool_eth).toFixed(6) + ' ETH' : '—';
    metaEl.innerHTML = `
      <div class="t-detail-row"><span>Buy-in</span><b>$${t.buy_in_usd}</b></div>
      <div class="t-detail-row"><span>Players</span><b>${t.participant_count}</b></div>
      <div class="t-detail-row"><span>Prize pool</span><b>${pool}</b></div>
      <div class="t-detail-row"><span>Start</span><b>${start}</b></div>
      <div class="t-detail-row"><span>Status</span><b class="t-status-${t.status}">${t.status.toUpperCase()}</b></div>`;
  }

  const bracketEl = document.getElementById('tBracket');
  if (bracketEl) {
    if (t.matches && t.matches.length > 0) {
      const rounds = {};
      t.matches.forEach(m => { if (!rounds[m.round]) rounds[m.round] = []; rounds[m.round].push(m); });
      bracketEl.innerHTML = Object.keys(rounds).sort((a,b)=>a-b).map(r => {
        const ms = rounds[r];
        return `<div class="t-round">
          <div class="t-round-label">Round ${r}</div>
          ${ms.map(m => {
            const p1 = m.player1_alias || shortenAddr(m.player1_addr || '') || 'TBD';
            const p2 = m.is_bye ? 'BYE' : (m.player2_alias || shortenAddr(m.player2_addr || '') || 'TBD');
            const w1 = m.winner_addr && m.winner_addr === m.player1_addr;
            const w2 = m.winner_addr && m.winner_addr === m.player2_addr;
            const winnerName = m.winner_addr ? (m.winner_alias || shortenAddr(m.winner_addr)) : '';
            return `<div class="t-match t-match-${m.status}">
              <span class="${w1?'t-winner':''}">${p1}</span>
              <span class="t-match-vs">vs</span>
              <span class="${w2?'t-winner':''}">${p2}</span>
              ${winnerName ? `<span class="t-match-result">→ ${winnerName}</span>` : ''}
            </div>`;
          }).join('')}
        </div>`;
      }).join('');
    } else {
      bracketEl.innerHTML = '<div class="level-noconn" style="padding:12px 0">Bracket not yet generated.</div>';
    }
  }

  const btnReg = document.getElementById('tBtnRegister');
  if (btnReg) {
    const w = window.PengPoolWeb3;
    const myAddr = w?.getAddress?.()?.toLowerCase();
    const isRegistered = myAddr && t.participants && t.participants.some(p => p.player_addr.toLowerCase() === myAddr);
    const canRegister  = t.status === 'registration';
    btnReg.textContent = isRegistered ? 'REGISTERED ✓' : 'REGISTER';
    btnReg.disabled    = isRegistered || !canRegister;
  }
}

async function _tRegister() {
  if (!_tDetailId || !_tDetailData) return;
  const w = window.PengPoolWeb3;
  if (!w || !w.isConnected()) { toast('Connect wallet first', 1); return; }
  const btnReg = document.getElementById('tBtnRegister');
  if (btnReg) { btnReg.disabled = true; btnReg.textContent = 'Registering…'; }
  try {
    await w.registerTournament(_tDetailData.chain_id, _tDetailData.buy_in_usd);
    toast('Registered! You\'re in the tournament.');
    await _tRefreshDetail();
  } catch(e) {
    toast('Registration failed: ' + (e?.message || '').replace('[PengPool] ',''), 1);
    if (btnReg) { btnReg.disabled = false; btnReg.textContent = 'REGISTER'; }
  }
}

function _tOnMatchReady(msg) {
  const modal = document.getElementById('tMatchModal');
  if (!modal) return;
  document.getElementById('tMatchRound').textContent    = msg.round || '—';
  document.getElementById('tMatchOpponent').textContent = msg.opponentAlias || shortenAddr(msg.opponentAddr || '');
  document.getElementById('tMatchTname').textContent    = 'Tournament #' + msg.tournamentId;
  const btn = document.getElementById('tBtnJoin');
  btn.onclick = function() {
    modal.classList.remove('on');
    const w = window.PengPoolWeb3;
    const addr = w?.getAddress?.() || '0x0';
    currentGameId   = String(msg.roomId);
    currentGameData = { betUSD: msg.buyInUSD || 0, betAmount: '0' };
    myPlayerNum     = 1; // server corrects this via addr matching on join
    gameMode        = 'multiplayer';
    show('game');
    _showWaitingOverlay();
    _connectWS(msg.roomId, 1, addr);
  };
  modal.classList.add('on');
}

function _tOnFinished(msg) {
  toast('Tournament #' + msg.tournamentId + ' has finished!', 0);
  if (_tDetailId && String(_tDetailId) === String(msg.tournamentId)) _tRefreshDetail();
}

function _tOnPrizeAvailable(msg) {
  _tPendingChainId = msg.tournamentId; // will be resolved to chain_id when claiming
  const modal = document.getElementById('tPrizeModal');
  if (!modal) return;
  const prizeEth = msg.estimatedPrizeETH ? Number(msg.estimatedPrizeETH).toFixed(6) + ' ETH' : '—';
  const prizeSub = document.getElementById('tPrizeSub');
  const prizeAmt = document.getElementById('tPrizeAmount');
  if (prizeAmt) prizeAmt.textContent = prizeEth;
  if (prizeSub) prizeSub.textContent = 'Tournament #' + msg.tournamentId + ' · Position #' + msg.position;
  modal.classList.add('on');
}

async function _tClaimPrize() {
  if (_tPendingChainId == null) return;
  const w = window.PengPoolWeb3;
  if (!w || !w.isConnected()) { toast('Connect wallet first', 1); return; }
  const btn = document.getElementById('tBtnClaim');
  if (btn) { btn.disabled = true; btn.textContent = 'Claiming…'; }
  try {
    await w.claimTournamentPrize(_tPendingChainId);
    toast('Prize claimed!');
    document.getElementById('tPrizeModal').classList.remove('on');
    _tPendingChainId = null;
  } catch(e) {
    toast('Claim failed: ' + (e?.message || '').replace('[PengPool] ',''), 1);
    if (btn) { btn.disabled = false; btn.textContent = 'CLAIM PRIZE'; }
  }
}

async function _tSubmitCreate() {
  const name    = document.getElementById('tFormName')?.value?.trim();
  const buyIn   = Number(document.getElementById('tFormBuyIn')?.value);
  const startStr = document.getElementById('tFormStart')?.value;
  if (!name)    { toast('Enter a tournament name', 1); return; }
  if (!startStr){ toast('Set a start time', 1); return; }
  const w = window.PengPoolWeb3;
  if (!w || !w.isConnected()) { toast('Connect wallet first', 1); return; }
  const btn = document.getElementById('tFormSubmit');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
  try {
    const startTimeUnix = Math.floor(new Date(startStr).getTime() / 1000);
    const res = await fetch(HTTP_URL + '/api/tournament/create-custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creatorAddr: w.getAddress(), name, buyInUSD: buyIn, startTimeUnix }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    toast('Tournament created!');
    document.getElementById('tForm').style.display = 'none';
    _tShowTab('open');
  } catch(e) {
    toast('Create failed: ' + (e?.message || ''), 1);
    if (btn) { btn.disabled = false; btn.textContent = 'CREATE'; }
  }
}

// Pre-match countdown overlay shown to both players when server sends 'ready'
function _startMatchCountdown(opponentAddr, opponentAlias) {
  // Update game panel labels: local player gets their alias, opponent gets their alias (or shortened addr)
  const w = window.PengPoolWeb3;
  const myName  = w ? getDisplayName(w.getAddress()) : (myPlayerNum === 1 ? 'Player 1' : 'Player 2');
  const oppName = opponentAlias || shortenAddr(opponentAddr);
  console.log('Setting rival name:', oppName);
  const p1lbl = document.getElementById('p1label');
  const p2lbl = document.getElementById('p2label');
  if (p1lbl && p2lbl) {
    p1lbl.textContent = myPlayerNum === 1 ? myName : oppName;
    p2lbl.textContent = myPlayerNum === 2 ? myName : oppName;
  }

  let overlay = document.getElementById('matchCountdown');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'matchCountdown';
    document.body.appendChild(overlay);
  }
  let sec = 10;
  overlay.innerHTML =
    '<div class="mcd-box">' +
      '<div class="mcd-found">OPPONENT FOUND!</div>' +
      '<div class="mcd-vs">VS</div>' +
      '<div class="mcd-addr">' + oppName + '</div>' +
      '<div class="mcd-num" id="mcdNum">' + sec + '</div>' +
      '<div class="mcd-sublabel">Match starts in</div>' +
    '</div>';
  overlay.classList.add('on');

  clearInterval(_matchCdInterval);
  _matchCdInterval = setInterval(function () {
    sec--;
    const el = document.getElementById('mcdNum');
    if (el) {
      el.textContent = sec;
      el.classList.remove('mcd-pulse');
      void el.offsetWidth; // reflow to restart animation
      el.classList.add('mcd-pulse');
    }
    if (sec <= 0) {
      clearInterval(_matchCdInterval); _matchCdInterval = null;
      overlay.classList.remove('on');
      _matchReady = true;
      _updateMatchStakes();
      startMusic();
      initState(); // both players init; P1's initState sends 'rack' to P2 via _wsOnInit
    }
  }, 1000);
}

function _updateMatchStakes() {
  const bet = selectedBetUSD;
  const pot = bet * 2;
  const fee = +(pot * 0.05).toFixed(2);
  const win = +(pot * 0.95).toFixed(2);
  const fmt = n => (n === Math.floor(n) ? n : n.toFixed(2)) + ' USDC';
  const el  = id => document.getElementById(id);
  if (el('stBet'))      el('stBet').textContent      = fmt(bet);
  if (el('stPot'))      el('stPot').textContent      = fmt(pot);
  if (el('stProtocol')) el('stProtocol').textContent = fmt(fee);
  if (el('stWinner'))   el('stWinner').textContent   = fmt(win);
}

// Hook called by game.js at the end of initState()
// Rack is now fixed/deterministic — just tell opponent to reset their state too
window._wsOnInit = function() {
  if (gameMode === 'multiplayer' && myPlayerNum === 1 && _ws && _ws.readyState === WebSocket.OPEN) {
    _wsSend({ type: 'rack', gameId: currentGameId });
  }
};

// Hook called by game.js after every local shot in multiplayer
window._wsOnShoot = function() {
  if (gameMode === 'multiplayer') _wsSend({ type: 'shoot', gameId: currentGameId });
};

// Hook called by game.js when balls stop moving (authoritative final state)
window._wsOnResult = function(data) {
  if (gameMode === 'multiplayer') {
    // Guard: only the machine that fired the last shot should broadcast the result.
    // Spurious calls can happen when phys() resolves overlapping balls in applyResult().
    // NOTE: use window.PengPoolGame directly — G is a local var inside _wsOnMessage, not in scope here.
    const _G = window.PengPoolGame;
    if (!_G || !_G.isMyLastShot()) {
      console.warn('[SYNC] _wsOnResult suppressed — not the shooter (_myLastShot=false)');
      return;
    }
    console.log('[SYNC] _wsOnResult fired — sending to server, cur='+data.cur+' balls='+data.balls.length);
    _wsSend(Object.assign({ type: 'result', gameId: currentGameId }, data));
    // If the shooter keeps their turn (pocketed a ball without foul), reset the timer.
    // This must happen after the result is sent so it doesn't interfere with the sync flow.
    // resetTurnTimer() will also broadcast timerTick sec:20 so the opponent's display resets too.
    if (data.cur === myPlayerNum) {
      resetTurnTimer();
    }
  }
};

// Hook called every frame while balls are moving (live animation stream)
window._wsOnFrame = function(balls) {
  if (gameMode !== 'multiplayer' || !_ws || _ws.readyState !== WebSocket.OPEN) return;
  // Only include balls that are actively moving or just got pocketed
  const payload = [];
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (!b.out && Math.abs(b.vx) < 0.1 && Math.abs(b.vy) < 0.1) continue;
    payload.push({ id: b.id, x: b.x, y: b.y, out: b.out });
  }
  if (payload.length === 0) return;
  _wsSend({ type: 'frame', gameId: currentGameId, balls: payload });
};

function shortenAddr(a) {
  if (!a || a === '0x0000000000000000000000000000000000000000') return '—';
  return a.slice(0, 6) + '\u2026' + a.slice(-4);
}

// ═══════════════════════════
// USERNAME / ALIAS
// ═══════════════════════════
function _usernameKey(addr) { return 'pengpool_username_' + addr.toLowerCase(); }
function getStoredUsername(addr) { return addr ? localStorage.getItem(_usernameKey(addr)) : null; }
function setStoredUsername(addr, name) { localStorage.setItem(_usernameKey(addr), name); }
function getDisplayName(addr) { return getStoredUsername(addr) || shortenAddr(addr); }

function _showUsernameModal(addr, onSave) {
  const modal     = document.getElementById('usernameModal');
  const input     = document.getElementById('usernameInput');
  const btn       = document.getElementById('usernameSubmit');
  const closeBtn  = document.getElementById('usernameClose');
  if (!modal || !input || !btn) { if (onSave) onSave(null); return; }
  input.value = getStoredUsername(addr) || '';
  // Clear any leftover error from a previous attempt
  const oldErr = modal.querySelector('.umodal-err');
  if (oldErr) oldErr.remove();
  // Show X button only when renaming (player already has a username stored)
  const hasExisting = !!getStoredUsername(addr);
  if (closeBtn) {
    closeBtn.classList.toggle('hidden', !hasExisting);
    closeBtn.onclick = () => { modal.classList.remove('on'); };
  }
  modal.classList.add('on');
  setTimeout(() => input.focus(), 50);
  const save = async () => {
    const name = input.value.trim().slice(0, 20);
    if (!name) { input.focus(); return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    // Remove previous inline error
    const prevErr = modal.querySelector('.umodal-err');
    if (prevErr) prevErr.remove();
    try {
      const res = await fetch(HTTP_URL + '/api/player/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet: addr, username: name }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const err = document.createElement('div');
        err.className = 'umodal-err';
        err.textContent = data.error || 'Name unavailable — try another';
        btn.after(err);
        btn.disabled = false; btn.textContent = 'SAVE';
        input.focus();
        return;
      }
    } catch (_) {
      // Server unreachable — allow saving locally anyway
    }
    btn.disabled = false; btn.textContent = 'SAVE';
    setStoredUsername(addr, name);
    modal.classList.remove('on');
    if (onSave) onSave(name);
  };
  btn.onclick = save;
  input.onkeydown = (e) => { if (e.key === 'Enter') save(); };
}

function _registerAlias(addr, alias) {
  if (!alias || !addr) return;
  fetch(HTTP_URL + '/alias', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addr, alias }),
  }).catch(() => {});
  // Also register in the player profile DB (upserts username, no-op if taken)
  fetch(HTTP_URL + '/api/player/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ wallet: addr, username: alias }),
  }).catch(() => {});
}

function _afterConnect(agw) {
  _setWBtn(agw);
  if (!getStoredUsername(agw)) {
    _showUsernameModal(agw, (name) => {
      _setWBtn(agw);
      toast('Welcome, ' + (name || shortenAddr(agw)) + '!');
    });
  } else {
    toast('Wallet connected!');
  }
}

// ═══════════════════════════
// TURN TIMER
// ═══════════════════════════
const TURN_TIME = 20;
const TIMER_CIRC = 2 * Math.PI * 22; // r=22 → 138.23
let _timerInterval = null;
let _timerSec = TURN_TIME;

function _updateTimerDisplay() {
  const num = document.getElementById('timerNum');
  const ring = document.getElementById('timerCircle');
  if (!num || !ring) return;
  num.textContent = _timerSec;
  ring.style.strokeDashoffset = TIMER_CIRC * (1 - _timerSec / TURN_TIME);
  const urgent = _timerSec <= 5;
  num.classList.toggle('urgent', urgent);
  ring.classList.toggle('urgent', urgent);
}

function stopTurnTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
}

function resetTurnTimer() {
  stopTurnTimer();
  if (!running || document.getElementById('game').classList.contains('hidden')) return;
  _timerSec = TURN_TIME;
  _updateTimerDisplay();
  if (gameMode === 'multiplayer') _wsSend({ type: 'timerTick', gameId: currentGameId, sec: _timerSec });
  _timerInterval = setInterval(() => {
    if (!running || document.getElementById('game').classList.contains('hidden')) { stopTurnTimer(); return; }
    _timerSec--;
    _updateTimerDisplay();
    if (gameMode === 'multiplayer') _wsSend({ type: 'timerTick', gameId: currentGameId, sec: _timerSec });
    if (_timerSec <= 0) {
      stopTurnTimer();
      toast('Time up — turn passes!', 1);
      if (gameMode === 'multiplayer') _wsSend({ type: 'timeout', gameId: currentGameId });
      switchTurn();
    }
  }, 1000);
}

// ═══════════════════════════
// SCREEN MANAGER
// Key: game screen is always in DOM (never display:none)
// so canvas always has real pixel dimensions
// ═══════════════════════════
function show(id) {
  if (id !== 'game') stopTurnTimer();
  ['intro','lobby','matchmaking','mmSearching','mmWaiting','tournamentLobby','tournamentDetail'].forEach(s => {
    const el = document.getElementById(s); if (el) el.classList.add('hidden');
  });
  // Hide game screen only when navigating away from it
  if (id !== 'game') {
    const gameEl = document.getElementById('game');
    if (gameEl) gameEl.classList.add('hidden');
    const badge = document.getElementById('spectatorBadge');
    if (badge) badge.style.display = 'none';
  }
  if (id !== 'matchmaking') { clearInterval(_mmCdInterval); _mmCdInterval = null; clearInterval(_liveGamesInterval); _liveGamesInterval = null; }
  if (id !== 'game') _hideWaitingOverlay();
  const el = document.getElementById(id); if (el) el.classList.remove('hidden');
}


function renderUI(){
  const mkCanvas=(id)=>{const cv=document.createElement('canvas');cv.width=24;cv.height=24;cv.style.cssText='display:block;flex-shrink:0';drawBallIcon(id,cv);return cv;};
  const mk=(id,arr)=>{const el=document.getElementById(id);el.innerHTML='';arr.forEach(n=>el.appendChild(mkCanvas(n)));};
  mk('p1t',p1t);mk('p2t',p2t);
  // Update type labels
  const l1=document.getElementById('p1type-lbl');
  const l2=document.getElementById('p2type-lbl');
  if(l1&&p1T){l1.textContent='TYPE: '+p1T.toUpperCase();l1.style.color=p1T==='solid'?'#e8b800':'#4488ff';}
  if(l2&&p2T){l2.textContent='TYPE: '+p2T.toUpperCase();l2.style.color=p2T==='solid'?'#e8b800':'#4488ff';}
  const pt1=document.getElementById('pt1');
  const pt2=document.getElementById('pt2');
  if(pt1)pt1.textContent=p1T?p1T.toUpperCase():'—';
  if(pt2)pt2.textContent=p2T?p2T.toUpperCase():'—';
  const tb=document.getElementById('tbt');tb.innerHTML='';
  balls.filter(b=>b.id!==0&&!b.out).forEach(b=>tb.appendChild(mkCanvas(b.id)));
}

let toastT;
function toast(msg,bad=0){
  const t=document.getElementById('toast');t.textContent=msg;t.className='on'+(bad?' bad':'');
  clearTimeout(toastT);toastT=setTimeout(()=>t.className='',2200);
}
function foul(){const f=document.getElementById('ff');f.classList.add('on');setTimeout(()=>f.classList.remove('on'),350);}
function endGame(winner,reason){
  running=false;
  stopTurnTimer();
  // Broadcast game-over to opponent + trigger server-side settlement
  if(gameMode==='multiplayer'&&!_receivedGameOver){
    _wsSend({type:'gameover',gameId:currentGameId,winnerNum:winner,reason});
  }
  _receivedGameOver=false;
  playVictory();
  const _wlbl=document.getElementById('p'+winner+'label');
  document.getElementById('mtitle').textContent=(_wlbl?_wlbl.textContent.toUpperCase():'PLAYER '+winner)+' WINS!';
  // Calculate and display prize breakdown from real game data
  const betUSD=currentGameData?Number(currentGameData.betUSD):0;
  if(betUSD>0){
    const pot=betUSD*2;
    const fee=(pot*0.10).toFixed(2);
    const payout=(pot*0.90).toFixed(2);
    document.getElementById('pPot').textContent=pot.toFixed(2)+' USD';
    document.getElementById('pFee').textContent=fee+' USD';
    const betAmt=currentGameData?.betAmount;
    if(betAmt&&betAmt!=='0'){
      const potWei=BigInt(betAmt)*2n;
      const payoutWei=potWei*90n/100n;
      const payoutEth=(Number(payoutWei)/1e18).toFixed(6);
      document.getElementById('pWinner').textContent=payoutEth+' ETH ($'+payout+')';
    }else{
      document.getElementById('pWinner').textContent=payout+' USD';
    }
  }else{
    document.getElementById('pPot').textContent='Practice';
    document.getElementById('pFee').textContent='—';
    document.getElementById('pWinner').textContent='No wager';
  }
  if(gameMode==='multiplayer'&&currentGameId!==null){
    const isTournamentRoom = String(currentGameId).startsWith('t_');
    if (isTournamentRoom) {
      // Tournament match — no per-match settlement, prize comes at end of tournament
      document.getElementById('msub').innerHTML='<strong>'+reason+'</strong><br>Tournament match complete. Prize distributed at tournament end.';
      document.getElementById('modal').classList.add('on');
      const btnClaim = document.getElementById('btnClaim');
      if (btnClaim) btnClaim.style.display = 'none';
      const btnMlobby = document.getElementById('btnMlobby');
      if (btnMlobby) { btnMlobby.disabled = false; btnMlobby.classList.remove('btn-disabled'); }
    } else {
      document.getElementById('msub').innerHTML='<strong>'+reason+'</strong><br>Settling on-chain\u2026';
      document.getElementById('modal').classList.add('on');
      const iWon = (winner === myPlayerNum);
      if (iWon) {
        const btnMlobby = document.getElementById('btnMlobby');
        if (btnMlobby) { btnMlobby.disabled = true; btnMlobby.classList.add('btn-disabled'); }
      }
    }
  }else{
    document.getElementById('msub').innerHTML='<strong>'+reason+'</strong><br>Practice game \u2014 no wager.';
    document.getElementById('modal').classList.add('on');
  }
}

function _cueMouseMove(e){
  const r=C.getBoundingClientRect();
  const mx=(e.clientX-r.left)*(W/r.width),my=(e.clientY-r.top)*(H/r.height);
  if(!moving&&cue&&!cue.out&&running){
    if((gameMode==='multiplayer'&&cur!==myPlayerNum)||gameMode==='spectator')return;
    if(gameMode==='bot'&&cur!==myPlayerNum)return;
    if(ballInHand){
      // Drag cue ball preview along the vertical head-string (x fixed, y free)
      cue.x=BIH_X;
      cue.y=Math.max(WT+R,Math.min(WB-R,my));
      cue.vx=0;cue.vy=0;
      aiming=false;
      if(gameMode==='multiplayer'&&typeof _wsSend==='function'&&currentGameId){
        const _n=Date.now();
        if(_n-_lastCueUpdateWs>32){_lastCueUpdateWs=_n;_wsSend({type:'cueUpdate',gameId:currentGameId,angle,x:cue.x,y:cue.y,ballInHand:true});}
      }
    } else if(charging&&_dragOrigin){
      // Drag mode: angle frozen, distance from origin controls power
      const dx=mx-_dragOrigin.x, dy=my-_dragOrigin.y;
      const dirX=Math.cos(_lockedAngle), dirY=Math.sin(_lockedAngle);
      const dist=-(dx*dirX+dy*dirY); // negative = pulling back (away from ball)
      pwr=Math.max(0,Math.min(100,dist/250*100));
      angle=_lockedAngle;
      document.getElementById('angdisp').textContent=Math.round((angle*180/Math.PI+360)%360)+'°';
      document.getElementById('pwf').style.width=pwr+'%';
      document.getElementById('pwpct').textContent=Math.round(pwr)+'%';
      aiming=true;
    } else {
      angle=Math.atan2(my-cue.y,mx-cue.x);
      document.getElementById('angdisp').textContent=Math.round((angle*180/Math.PI+360)%360)+'°';
      aiming=true;
      if(gameMode==='multiplayer'&&typeof _wsSend==='function'&&currentGameId){
        const _n=Date.now();
        if(_n-_lastCueUpdateWs>32){_lastCueUpdateWs=_n;_wsSend({type:'cueUpdate',gameId:currentGameId,angle,x:cue.x,y:cue.y});}
      }
    }
  }
}
function _cueMouseUp(){
  document.removeEventListener('mousemove',_cueMouseMove);
  document.removeEventListener('mouseup',_cueMouseUp);
  if(!charging)return;
  charging=false;
  if(pwr>2){shoot();if(typeof window.resetSpin==='function')window.resetSpin();}
  pwr=0;document.getElementById('pwf').style.width='0%';document.getElementById('pwpct').textContent='0%';
}
C.addEventListener('mousedown',e=>{
  if(moving||!running||!cue||cue.out||e.button!==0)return;
  if(gameMode==='spectator'||(gameMode==='multiplayer'&&(!_matchReady||cur!==myPlayerNum)))return;
  if(gameMode==='bot'&&cur!==myPlayerNum)return;
  if(ballInHand){
    // Confirm placement only — do NOT start charging on this same click.
    // Player must release and click again to charge the shot.
    const blocked=balls.some(b=>b!==cue&&!b.out&&Math.sqrt((b.x-cue.x)**2+(b.y-cue.y)**2)<R*2);
    if(blocked)return; // no confirmar si hay una bola en ese lugar
    ballInHand=false;
    if(typeof _updateBonusUI==='function')_updateBonusUI();
    document.getElementById('gstatus').textContent='HOLD TO CHARGE — RELEASE TO SHOOT';
    return;
  }
  const _r=C.getBoundingClientRect();
  _dragOrigin={x:(e.clientX-_r.left)*(W/_r.width),y:(e.clientY-_r.top)*(H/_r.height)};
  _lockedAngle=angle;
  charging=true;pwr=0;
  document.addEventListener('mousemove',_cueMouseMove);
  document.addEventListener('mouseup',_cueMouseUp);
});
C.addEventListener('mousemove',_cueMouseMove);
C.addEventListener('mouseleave',()=>{aiming=false;});

// ── BUTTONS ──
document.getElementById('btnEnter').addEventListener('click',()=>show('lobby'));
document.getElementById('btnPlay').addEventListener('click',()=>_onWager());
document.getElementById('btnPractice').addEventListener('click',()=>_showPracticeModal());
document.getElementById('cWager').addEventListener('click',()=>_onWager());
document.getElementById('cPractice').addEventListener('click',()=>_showPracticeModal());
document.getElementById('btnLobby').addEventListener('click',()=>_confirmLeaveLobby(false));
document.getElementById('btnLobby2').addEventListener('click',()=>_confirmLeaveLobby(true));
document.getElementById('btnMlobby').addEventListener('click',()=>{document.getElementById('modal').classList.remove('on');stopMusic();_resetGS();show('lobby');});
document.getElementById('btnGuide').addEventListener('click',()=>{guideOn=!guideOn;document.getElementById('guidetxt').textContent=guideOn?'ON':'OFF';});

// ── Rules modal ──────────────────────────────────────────────────────────────
(function(){
  const overlay=document.getElementById('rulesModal');
  const open=()=>overlay.classList.add('on');
  const close=()=>overlay.classList.remove('on');
  document.getElementById('btnRules').addEventListener('click',open);
  document.getElementById('btnRulesLobby').addEventListener('click',open);
  document.getElementById('btnRulesClose').addEventListener('click',close);
  overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')close();});
})();

// ── RECOVERY PANEL ───────────────────────────────────────────────────────────
(function(){
  document.getElementById('btnRecovery').addEventListener('click', _openRecoveryPanel);

  function _openRecoveryPanel() {
    if (document.getElementById('recoveryPanel')) return;

    const overlay = document.createElement('div');
    overlay.id = 'recoveryPanel';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.82);display:flex;align-items:center;justify-content:center;z-index:970;font-family:"Space Mono",monospace';

    overlay.innerHTML =
      '<div style="background:#0d1b2a;border:1px solid rgba(120,200,255,.25);border-radius:10px;padding:32px 28px;max-width:380px;width:92%;color:#e8f4ff;position:relative">'
      + '<button id="recoveryClose" style="position:absolute;top:12px;right:14px;background:none;border:none;color:#7eb8d8;font-size:18px;cursor:pointer;line-height:1">✕</button>'
      + '<div style="font-size:13px;letter-spacing:2px;color:#00c951;margin-bottom:6px">🔧 RECOVERY PANEL</div>'
      + '<div style="font-size:10px;color:#7eb8d8;margin-bottom:24px;letter-spacing:.5px">Recover pending matches or prizes</div>'

      // Section 1 — Pending match
      + '<div style="border:1px solid rgba(120,200,255,.15);border-radius:7px;padding:16px;margin-bottom:16px">'
      + '<div style="font-size:11px;letter-spacing:1px;margin-bottom:12px;color:#c8e8f8">PENDING MATCH</div>'
      + '<button id="recBtnMatch" style="width:100%;background:rgba(120,200,255,.1);border:1px solid rgba(120,200,255,.3);color:#c8e8f8;font-family:inherit;font-size:10px;letter-spacing:1px;padding:9px 0;border-radius:5px;cursor:pointer">🔍 Find Pending Match</button>'
      + '<div id="recMatchResult" style="margin-top:12px;font-size:10px;color:#7eb8d8;min-height:18px;line-height:1.6"></div>'
      + '</div>'

      // Section 2 — Pending prize
      + '<div style="border:1px solid rgba(0,201,81,.15);border-radius:7px;padding:16px">'
      + '<div style="font-size:11px;letter-spacing:1px;margin-bottom:12px;color:#c8e8f8">PENDING PRIZE</div>'
      + '<button id="recBtnClaim" style="width:100%;background:rgba(0,201,81,.1);border:1px solid rgba(0,201,81,.3);color:#00c951;font-family:inherit;font-size:10px;letter-spacing:1px;padding:9px 0;border-radius:5px;cursor:pointer">💰 Claim Pending Prize</button>'
      + '<div id="recClaimResult" style="margin-top:12px;font-size:10px;color:#7eb8d8;min-height:18px;line-height:1.6"></div>'
      + '</div>'
      + '</div>';

    document.body.appendChild(overlay);

    document.getElementById('recoveryClose').onclick = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    const _w = window.PengPoolWeb3;
    const addr = _w?.getAddress?.();

    // No wallet connected
    if (!addr) {
      document.getElementById('recMatchResult').innerHTML = '<span style="color:#ff6b6b">Connect your wallet first.</span>';
      document.getElementById('recClaimResult').innerHTML = '<span style="color:#ff6b6b">Connect your wallet first.</span>';
      document.getElementById('recBtnMatch').disabled = true;
      document.getElementById('recBtnClaim').disabled = true;
      return;
    }

    // Find pending match
    document.getElementById('recBtnMatch').onclick = async function() {
      const btn = this;
      btn.disabled = true;
      btn.textContent = 'Searching…';
      const resultEl = document.getElementById('recMatchResult');
      resultEl.innerHTML = '';
      try {
        const resp = await fetch(HTTP_URL + '/api/pending-match/' + addr.toLowerCase());
        const data = await resp.json();
        if (data.found) {
          const opponent = data.opponentAlias || shortenAddr(data.opponentAddr || '');
          resultEl.innerHTML =
            '<div style="color:#00c951;margin-bottom:8px">✅ Match found</div>'
            + '<div>Game <b>#' + data.matchId + '</b> · Opponent: <b>' + opponent + '</b> · $' + data.betUSD + '</div>'
            + '<button id="recBtnRejoin" style="margin-top:10px;width:100%;background:rgba(0,201,81,.15);border:1px solid rgba(0,201,81,.4);color:#00c951;font-family:inherit;font-size:10px;letter-spacing:1px;padding:8px 0;border-radius:5px;cursor:pointer">REJOIN</button>';
          document.getElementById('recBtnRejoin').onclick = () => {
            overlay.remove();
            currentGameId = data.matchId;
            myPlayerNum = data.playerNum;
            gameMode = 'multiplayer';
            show('game');
            _showWaitingOverlay();
            _connectWS(data.matchId, data.playerNum, addr);
          };
        } else {
          resultEl.innerHTML = '<span style="color:#7eb8d8">No pending match found.</span>';
        }
      } catch(e) {
        resultEl.innerHTML = '<span style="color:#ff6b6b">Search error: ' + e.message + '</span>';
      }
      btn.disabled = false;
      btn.textContent = '🔍 Find Pending Match';
    };

    // Claim pending prize
    document.getElementById('recBtnClaim').onclick = async function() {
      const btn = this;
      btn.disabled = true;
      btn.textContent = 'Searching…';
      const resultEl = document.getElementById('recClaimResult');
      resultEl.innerHTML = '';
      try {
        const resp = await fetch(HTTP_URL + '/api/pending-claim/' + addr.toLowerCase());
        const data = await resp.json();
        if (data.found) {
          resultEl.innerHTML = '<div style="color:#00c951;margin-bottom:10px">✅ ' + data.claims.length + ' pending prize' + (data.claims.length > 1 ? 's' : '') + ' found</div>';
          data.claims.forEach(function(claim) {
            const rowId = 'recClaimRow_' + claim.matchId;
            const row = document.createElement('div');
            row.id = rowId;
            row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid rgba(120,200,255,.1);font-size:10px;';
            row.innerHTML =
              '<span>Match <b>#' + claim.matchId + '</b> · Bet: <b>$' + claim.betUSD + '</b></span>'
              + '<button style="background:rgba(0,201,81,.15);border:1px solid rgba(0,201,81,.4);color:#00c951;font-family:inherit;font-size:10px;letter-spacing:1px;padding:5px 12px;border-radius:5px;cursor:pointer;white-space:nowrap">CLAIM</button>';
            resultEl.appendChild(row);

            row.querySelector('button').onclick = async function() {
              const claimBtn = this;
              claimBtn.disabled = true;
              claimBtn.textContent = 'Processing…';
              try {
                await _w.claimWinnings(claim.matchId);
                row.innerHTML = '<span style="color:#00c951">Match <b>#' + claim.matchId + '</b> · ✅ Claimed</span>';
                fetch(HTTP_URL + '/api/pending-claim/' + addr.toLowerCase(), {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ matchId: claim.matchId })
                }).catch(e => console.warn('[recovery] DELETE pending-claim failed:', e.message));
              } catch(err) {
                row.querySelector('span').innerHTML = 'Match <b>#' + claim.matchId + '</b> · <span style="color:#ff6b6b">❌ Failed</span>';
                claimBtn.disabled = false;
                claimBtn.textContent = 'CLAIM';
              }
            };
          });
        } else {
          resultEl.innerHTML = '<span style="color:#7eb8d8">No pending prizes found.</span>';
        }
      } catch(e) {
        resultEl.innerHTML = '<span style="color:#ff6b6b">Search error: ' + e.message + '</span>';
      }
      btn.disabled = false;
      btn.textContent = '💰 Claim Pending Prize';
    };
  }
})();

// ── TOURNAMENT BUTTONS ────────────────────────────────────────────────────────
(function(){
  document.getElementById('btnTournament').addEventListener('click', function() {
    const w = window.PengPoolWeb3;
    if (!w || !w.isConnected()) { toast('Connect wallet first', 1); return; }
    document.getElementById('tForm').style.display = 'none';
    show('tournamentLobby');
    _tShowTab('open');
  });
  document.getElementById('cTournament').addEventListener('click', function() {
    document.getElementById('btnTournament').click();
  });
  document.getElementById('tBtnLobby').addEventListener('click', function() {
    clearInterval(_tRefreshTimer); _tRefreshTimer = null;
    show('lobby');
  });
  document.getElementById('tBtnCreate').addEventListener('click', function() {
    const form = document.getElementById('tForm');
    form.style.display = form.style.display === 'none' ? '' : 'none';
  });
  document.getElementById('tFormSubmit').addEventListener('click', _tSubmitCreate);
  document.getElementById('tBtnBack').addEventListener('click', function() {
    clearInterval(_tRefreshTimer); _tRefreshTimer = null;
    _tDetailId = null; _tDetailData = null;
    show('tournamentLobby');
    _tLoadList();
  });
  document.getElementById('tBtnRegister').addEventListener('click', _tRegister);
  document.getElementById('tBtnClaim').addEventListener('click', _tClaimPrize);
  document.getElementById('tBtnPrizeLater').addEventListener('click', function() {
    document.getElementById('tPrizeModal').classList.remove('on');
  });
})();

// ── LEADERBOARD ──────────────────────────────────────────────────────────────
(function(){
  const overlay=document.getElementById('lbModal');
  const content=document.getElementById('lbContent');
  const close=()=>overlay.classList.remove('on');

  function _lbRow(r, isMe){
    const name=r.username||shortenAddr(r.wallet);
    return `<tr class="lb-row${isMe?' lb-me':''}">
      <td class="lb-rank">${r.rank}</td>
      <td class="lb-player">${name}</td>
      <td class="lb-wins">${r.games_won}</td>
      <td class="lb-matches">${r.games_played}</td>
      <td class="lb-wr">${r.win_rate}%</td>
      <td class="lb-level">Lv.${r.level}</td>
    </tr>`;
  }

  async function openLeaderboard(){
    overlay.classList.add('on');
    content.innerHTML='<div class="level-loading">Loading…</div>';
    try{
      const w=window.PengPoolWeb3;
      const myAddr=(w&&w.isConnected())?w.getAddress().toLowerCase():null;
      const url=HTTP_URL+'/api/leaderboard'+(myAddr?'?wallet='+encodeURIComponent(myAddr):'');
      const res=await fetch(url);
      const data=await res.json();
      if(!data||data.error||!Array.isArray(data.top)){
        content.innerHTML='<div class="level-noconn">Failed to load leaderboard.</div>';
        return;
      }
      const{top,caller}=data;
      const tbody=top.map(r=>_lbRow(r,r.wallet===myAddr)).join('');
      content.innerHTML=`
        <div class="lb-table-wrap">
          <table class="lb-table">
            <thead class="lb-thead"><tr>
              <th class="lb-th">#</th>
              <th class="lb-th">Player</th>
              <th class="lb-th lb-th-wins">Wins</th>
              <th class="lb-th lb-th-r">Matches</th>
              <th class="lb-th lb-th-r">Win %</th>
              <th class="lb-th lb-th-r">Level</th>
            </tr></thead>
            <tbody>${tbody||'<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--t3)">No players yet</td></tr>'}</tbody>
          </table>
        </div>`;
      // If connected and not in top 100, show caller row at footer
      if(myAddr&&caller){
        const name=caller.username||shortenAddr(caller.wallet);
        content.innerHTML+=`
          <div class="lb-footer">
            <div class="lb-footer-row">
              <span class="lb-footer-rank">#${caller.rank}</span>
              <span class="lb-footer-name">${name} <span style="color:var(--g);font-size:9px">YOU</span></span>
              <span class="lb-footer-wins">${caller.games_won}</span>
              <span class="lb-footer-extra">${caller.games_played} played</span>
              <span class="lb-footer-extra">${caller.win_rate}%</span>
              <span class="lb-footer-extra">Lv.${caller.level}</span>
            </div>
          </div>`;
      } else if(myAddr&&!top.find(r=>r.wallet===myAddr)){
        content.innerHTML+=`<div class="lb-footer"><div class="level-noconn" style="padding:10px 0">Play PvP matches to appear on the leaderboard!</div></div>`;
      }
    }catch(e){
      content.innerHTML='<div class="level-noconn">Failed to load leaderboard.</div>';
    }
  }

  document.getElementById('btnLeaderboard').addEventListener('click',openLeaderboard);
  document.getElementById('btnLbClose').addEventListener('click',close);
  overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&overlay.classList.contains('on'))close();});
})();

// ── LEVEL PANEL ──────────────────────────────────────────────────────────────
(function(){
  const overlay=document.getElementById('levelModal');
  const content=document.getElementById('levelContent');
  const close=()=>overlay.classList.remove('on');

  async function openLevelPanel(){
    overlay.classList.add('on');
    const w=window.PengPoolWeb3;
    if(!w||!w.isConnected()){
      content.innerHTML='<div class="level-noconn">Connect your wallet to view your profile.</div>';
      return;
    }
    const addr=w.getAddress().toLowerCase();
    content.innerHTML='<div class="level-loading">Loading…</div>';
    try{
      const res=await fetch(HTTP_URL+'/api/player/'+encodeURIComponent(addr));
      const player=await res.json();
      if(!player||player.error){
        content.innerHTML='<div class="level-noconn">Play your first PvP match to create your profile.<br><span style="font-size:10px;color:var(--t3)">+20 pts per match · +30 pts bonus if you win</span></div>';
        return;
      }
      const winRate=player.games_played>0?Math.round(player.games_won/player.games_played*100):0;
      const lvlLabel=player.level>=50?'LEVEL MAX':'LEVEL '+player.level;
      const nextInfo=player.level<50?player.points_to_next_level+' pts to LEVEL '+(player.level+1):'Max level reached';
      content.innerHTML=`
        <div class="level-name">${player.username||shortenAddr(addr)}</div>
        <div class="level-badge">⭐ ${lvlLabel} &nbsp;·&nbsp; ${player.points} pts</div>
        <div class="level-progress-wrap">
          <div class="level-progress-label">
            <span>Progress</span>
            <span>${nextInfo}</span>
          </div>
          <div class="level-progress-bar">
            <div class="level-progress-fill" style="width:${player.level_progress_pct}%"></div>
          </div>
        </div>
        <div class="level-stats">
          <div class="level-stat">
            <div class="level-stat-val">${player.games_played}</div>
            <div class="level-stat-lbl">PvP Matches</div>
          </div>
          <div class="level-stat">
            <div class="level-stat-val">${player.games_won}</div>
            <div class="level-stat-lbl">Wins</div>
          </div>
          <div class="level-stat">
            <div class="level-stat-val">${winRate}%</div>
            <div class="level-stat-lbl">Win Rate</div>
          </div>
        </div>`;
    }catch(e){
      content.innerHTML='<div class="level-noconn">Failed to load profile.</div>';
    }
  }

  document.getElementById('btnLevel').addEventListener('click',openLevelPanel);
  document.getElementById('btnLevelLobby').addEventListener('click',openLevelPanel);
  document.getElementById('btnLevelClose').addEventListener('click',close);
  overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
})();

// ── CONNECT WALLET ──
document.getElementById('btnConnectWallet').addEventListener('click',async()=>{
  const w=window.PengPoolWeb3;
  if(!w){toast('Web3 loading\u2026',1);return;}
  if(w.isConnected()){toast('Connected: '+getDisplayName(w.getAddress()));return;}
  const btn=document.getElementById('btnConnectWallet');
  btn.textContent='Connecting\u2026';btn.disabled=true;
  try{const{agw}=await w.connectWallet();_afterConnect(agw);}
  catch(e){btn.textContent='🔌 CONNECT WALLET';btn.disabled=false;toast(e.message.replace('[PengPool] ',''),1);}
});

// ── RENAME ──
document.getElementById('btnRename').addEventListener('click',()=>{
  const w=window.PengPoolWeb3;if(!w||!w.isConnected())return;
  _showUsernameModal(w.getAddress(),(name)=>{_setWBtn(w.getAddress());if(name)toast('Alias saved: '+name);});
});

// ── MATCHMAKING PANEL ──

// ════════════════════════════════════════════════
// WEB3 / MATCHMAKING LOGIC
// ════════════════════════════════════════════════

function _resetGS(alreadySentLeave){
  // Signal voluntary leave to server before closing socket (skip if already sent)
  if(!alreadySentLeave && _ws && _ws.readyState===WebSocket.OPEN && gameMode==='multiplayer'){
    try{_ws.send(JSON.stringify({type:'leave'}));}catch(_){}
  }
  _clearActiveGame();
  gameMode='practice';currentGameId=null;currentGameData=null;myPlayerNum=1;
  _matchReady=false;
  clearInterval(_matchCdInterval);_matchCdInterval=null;
  const ov=document.getElementById('matchCountdown');if(ov)ov.classList.remove('on');
  _hideReconnectOverlay();
  if(_ws){try{_ws.close();}catch(_){}  _ws=null;}
  const p1lbl=document.getElementById('p1label');const p2lbl=document.getElementById('p2label');
  if(p1lbl)p1lbl.textContent='Player 1';if(p2lbl)p2lbl.textContent='Player 2';
}

function _confirmLeaveLobby(withMusic) {
  let dlg = document.getElementById('leaveConfirm');
  if (!dlg) {
    dlg = document.createElement('div');
    dlg.id = 'leaveConfirm';
    dlg.innerHTML =
      '<div class="lc-box">' +
        '<div class="lc-msg">Are you sure you want to leave the match?</div>' +
        '<div class="lc-btns">' +
          '<button class="lc-leave" id="lcLeave">Leave</button>' +
          '<button class="lc-stay"  id="lcStay">Stay</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dlg);
    document.getElementById('lcStay').addEventListener('click', () => dlg.classList.remove('on'));
  }
  document.getElementById('lcLeave').onclick = () => {
    dlg.classList.remove('on');
    if (withMusic) stopMusic();
    // Send "leave" first, then wait 200ms before closing WS so the message reaches server
    if (_ws && _ws.readyState === WebSocket.OPEN && gameMode === 'multiplayer') {
      try { _ws.send(JSON.stringify({ type: 'leave' })); } catch(_) {}
      setTimeout(() => { _resetGS(true); show('lobby'); }, 200);
      return;
    }
    _resetGS();
    show('lobby');
  };
  dlg.classList.add('on');
}

function _showPracticeModal(){
  document.getElementById('pracStep1').style.display='';
  document.getElementById('pracStep2').style.display='none';
  document.getElementById('pracModal').classList.add('on');
}

function _hidePracticeModal(){
  document.getElementById('pracModal').classList.remove('on');
}

document.getElementById('pracClose').addEventListener('click',()=>_hidePracticeModal());
document.getElementById('pracSolo').addEventListener('click',()=>{_hidePracticeModal();_onPractice();});
document.getElementById('pracVsBot').addEventListener('click',()=>{
  document.getElementById('pracStep1').style.display='none';
  document.getElementById('pracStep2').style.display='';
});
document.getElementById('pracBack').addEventListener('click',()=>{
  document.getElementById('pracStep1').style.display='';
  document.getElementById('pracStep2').style.display='none';
});
['Easy','Medium','Hard'].forEach(function(d){
  document.getElementById('prac'+d).addEventListener('click',function(){
    _hidePracticeModal();
    _onBotPractice(d.toLowerCase());
  });
});

function _onPractice(){
  _resetGS();
  show('game');
  const w=window.PengPoolWeb3;
  const p1lbl=document.getElementById('p1label');
  if(p1lbl&&w&&w.isConnected())p1lbl.textContent=getDisplayName(w.getAddress());
  initState();startMusic();
}

function _onBotPractice(difficulty){
  _resetGS();
  gameMode='bot';
  myPlayerNum=1;
  show('game');
  const w=window.PengPoolWeb3;
  const p1lbl=document.getElementById('p1label');
  if(p1lbl&&w&&w.isConnected())p1lbl.textContent=getDisplayName(w.getAddress());
  if(typeof window.setBotDifficulty==='function')window.setBotDifficulty(difficulty);
  initState();startMusic();
}

async function _onWager(){
  const w=window.PengPoolWeb3;
  if(!w){toast('Web3 loading, try again\u2026',1);return;}
  if(!w.isConnected()){
    const btn=document.getElementById('btnConnectWallet');
    btn.textContent='Connecting\u2026';btn.disabled=true;
    try{const{agw}=await w.connectWallet();_setWBtn(agw);if(!getStoredUsername(agw)){_showUsernameModal(agw,(name)=>{_setWBtn(agw);toast('Welcome, '+(name||shortenAddr(agw))+'!');_openMM();});}else{toast('Connected! Choose a game.');_openMM();}}
    catch(e){btn.textContent='🔌 CONNECT WALLET';btn.disabled=false;toast(e.message.replace('[PengPool] ',''),1);}
    return;
  }
  _openMM();
}

function _setWBtn(addr){
  const btn=document.getElementById('btnConnectWallet');if(!btn)return;
  btn.textContent=getDisplayName(addr);
  btn.style.color='var(--g)';btn.style.borderColor='rgba(0,201,81,.4)';
  btn.style.background='rgba(0,201,81,.08)';btn.disabled=false;
  const rb=document.getElementById('btnRename');if(rb)rb.style.display='';
  const name=getStoredUsername(addr);if(name)_registerAlias(addr,name);
  _checkRejoin(addr);
  _connectNotifWs(addr);
}

async function _checkRejoin(addr){
  // If localStorage is empty, check if there's a pending match on the server
  // (covers the case where WS failed before mm_you_are_p1/mm_join_game was received)
  if (!_loadActiveGame()) {
    try {
      const _web3 = window.PengPoolWeb3;
      if (_web3) {
        const deposit = await _web3.getDeposit(addr);
        if (deposit && deposit.matched === true) {
          const resp = await fetch(HTTP_URL + '/api/pending-match/' + addr);
          const data = await resp.json();
          if (data.found) {
            _saveActiveGame(String(data.matchId), data.playerNum, addr);
          }
        }
      }
    } catch(e) { console.warn('[rejoin] pending-match check failed:', e.message); }
  }

  const saved=_loadActiveGame();
  if(!saved||!saved.gameId)return;
  // Only offer rejoin if the saved addr matches the connected wallet
  if(saved.addr?.toLowerCase()!==addr.toLowerCase())return;

  // Verify the room still exists on the server before showing any UI
  const _rejoinGameId = String(saved.gameId);
  console.log('[rejoin] checking game status for gameId:', _rejoinGameId);
  try{
    const resp=await fetch(HTTP_URL+'/api/game-status/'+_rejoinGameId);
    const data=await resp.json();
    console.log('[rejoin] game-status response:', data);
    if(!data.active){
      // Room not on server — check on-chain: match may still be ACTIVE if WS failed before room was created
      let onChainActive = false;
      try {
        const _web3 = window.PengPoolWeb3;
        if (_web3) {
          const match = await _web3.getMatch(_rejoinGameId);
          if (match && Number(match.status) === 0) onChainActive = true; // 0 = ACTIVE
        }
      } catch(e) { console.warn('[rejoin] getMatch failed:', e.message); }
      if (!onChainActive) {
        console.log('[rejoin] game ended, clearing...');
        _clearActiveGame();
        const _endDlg=document.createElement('div');
        _endDlg.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:960;font-family:"Space Mono",monospace';
        _endDlg.innerHTML=
          '<div style="background:#0d1b2a;border:1px solid #00c951;border-radius:8px;padding:36px 32px;text-align:center;max-width:320px;width:90%;color:#fff">'
          +'<div style="font-size:28px;margin-bottom:12px">⏱️</div>'
          +'<div style="font-size:13px;letter-spacing:1px;color:#00c951;margin-bottom:12px">MATCH ENDED</div>'
          +'<div style="font-size:11px;color:rgba(255,255,255,.65);line-height:1.6;margin-bottom:24px">Your previous match has ended<br>while you were disconnected.</div>'
          +'<button id="_endDlgOk" style="background:rgba(0,201,81,.15);border:1px solid rgba(0,201,81,.4);color:#00c951;font-family:inherit;font-size:11px;letter-spacing:1px;padding:10px 28px;border-radius:6px;cursor:pointer">OK</button>'
          +'</div>';
        document.body.appendChild(_endDlg);
        document.getElementById('_endDlgOk').onclick=()=>_endDlg.remove();
        return;
      }
      console.log('[rejoin] server room missing but match is ACTIVE on-chain — proceeding to rejoin');
    }
    console.log('[rejoin] game still active, showing modal');
  }catch(e){
    // If the check fails (server unreachable), fall through and show modal anyway
    console.warn('[rejoin] game-status check failed:', e.message);
  }

  const dlg=document.createElement('div');
  dlg.id='rejoinDlg';
  dlg.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;z-index:950;font-family:"Space Mono",monospace';
  dlg.innerHTML=
    '<div style="background:#0d1b2a;border:1px solid rgba(120,200,255,.2);border-radius:8px;padding:32px;text-align:center;max-width:320px;width:90%;color:#fff">'
    +'<div style="font-size:13px;letter-spacing:1px;margin-bottom:8px">MATCH IN PROGRESS</div>'
    +'<div style="font-size:11px;color:rgba(255,255,255,.55);margin-bottom:24px">Game #'+saved.gameId+' — you were P'+saved.playerNum+'</div>'
    +'<div style="display:flex;gap:12px;justify-content:center">'
    +'<button id="rejoinYes" style="background:rgba(0,201,81,.15);border:1px solid rgba(0,201,81,.4);color:#00c951;font-family:inherit;font-size:11px;padding:10px 20px;border-radius:6px;cursor:pointer;letter-spacing:1px">REJOIN</button>'
    +'<button id="rejoinNo"  style="background:rgba(255,100,100,.1);border:1px solid rgba(255,100,100,.3);color:#ff6b6b;font-family:inherit;font-size:11px;padding:10px 20px;border-radius:6px;cursor:pointer;letter-spacing:1px">ABANDON</button>'
    +'</div></div>';
  document.body.appendChild(dlg);

  document.getElementById('rejoinYes').onclick=()=>{
    dlg.remove();
    currentGameId=saved.gameId;myPlayerNum=saved.playerNum;gameMode='multiplayer';
    show('game');_showWaitingOverlay();
    _connectWS(saved.gameId,saved.playerNum,addr);
  };
  document.getElementById('rejoinNo').onclick=()=>{
    dlg.remove();
    _clearActiveGame();
  };
}

async function _loadLiveGames() {
  const list = document.getElementById('mmLiveList');
  if (!list) return;
  try {
    const res  = await fetch(HTTP_URL + '/api/active-games');
    const data = await res.json();
    if (!data.games || data.games.length === 0) {
      list.innerHTML = '<div class="mm-live-empty">No active games</div>';
      return;
    }
    const me = window.PengPoolWeb3?.getAddress()?.toLowerCase() || null;
    list.innerHTML = data.games.map(g => {
      const isPlayer = me && (g.p1addr.toLowerCase() === me || g.p2addr.toLowerCase() === me);
      const btn = isPlayer
        ? `<button class="mm-live-btn mm-live-btn--rejoin" onclick="_rejoinFromList('${g.gameId}')">REJOIN</button>`
        : `<button class="mm-live-btn" onclick="_watchGame('${g.gameId}')">WATCH</button>`;
      const bet = g.betUSD ? `$${g.betUSD}` : '';
      return `<div class="mm-live-row">
        <span class="mm-live-players">${g.p1alias} vs ${g.p2alias}</span>
        ${bet ? `<span class="mm-live-bet">${bet}</span>` : ''}
        ${btn}
      </div>`;
    }).join('');
  } catch(e) {
    list.innerHTML = '<div class="mm-live-empty">—</div>';
  }
}

function _rejoinFromList(gameId) {
  // placeholder — lógica de rejoin existente
  console.log('[live] rejoin from list:', gameId);
}

async function _watchGame(gameId) {
  const addr = await window.PengPoolWeb3?.getAddress?.() || '0x0';
  gameMode      = 'spectator';
  currentGameId = gameId;
  myPlayerNum   = 0;
  show('game');
  _showWaitingOverlay('Connecting to game…');
  _connectWS(gameId, 0, addr);
}
window._watchGame      = _watchGame;
window._rejoinFromList = _rejoinFromList;

function _openMM(){
  const w=window.PengPoolWeb3;
  const el=document.getElementById('mmAddr');if(el&&w)el.textContent=getDisplayName(w.getAddress());
  show('matchmaking');
  _mmStart();
  _loadLiveGames();
  clearInterval(_liveGamesInterval);
  _liveGamesInterval = setInterval(_loadLiveGames, 5000);
}

function _mmStart(){}

function _updCd(){const e=document.getElementById('mmCountdownBadge');if(e)e.textContent=_mmCountdown+'s';}

// ── Spin pad ──────────────────────────────────────────────────────────────────
(function(){
  const pad=document.getElementById('spinPad');
  const dot=document.getElementById('spinDot');
  const lbl=document.getElementById('spinName');
  const R_PAD=27; // radius of pad in px
  let dragging=false;

  const SPIN_NAMES={
    'top':'Top spin (follow)',
    'bottom':'Back spin (draw)',
    'left':'Left spin',
    'right':'Right spin',
    'top-left':'Top-left spin',
    'top-right':'Top-right spin',
    'bottom-left':'Bottom-left spin',
    'bottom-right':'Bottom-right spin',
    'center':'Center (no spin)'
  };

  function updateSpin(ex,ey){
    const rect=pad.getBoundingClientRect();
    const cx=rect.left+R_PAD, cy=rect.top+R_PAD;
    let dx=ex-cx, dy=ey-cy;
    const dist=Math.sqrt(dx*dx+dy*dy);
    const maxR=R_PAD-8;
    if(dist>maxR){dx=dx/dist*maxR;dy=dy/dist*maxR;}
    // normalize to -1..1
    spinX=dx/maxR;
    spinY=-dy/maxR; // y inverted: up=topspin positive
    dot.style.left=(R_PAD+dx)+'px';
    dot.style.top=(R_PAD+dy)+'px';
    // name
    const tx=Math.abs(spinX)>0.25?( spinX>0?'right':'left'):'';
    const ty=Math.abs(spinY)>0.25?( spinY>0?'top':'bottom'):'';
    const key=(ty&&tx)?ty+'-'+tx:ty||tx||'center';
    lbl.textContent=SPIN_NAMES[key]||'Center';
  }

  pad.addEventListener('mousedown',e=>{dragging=true;updateSpin(e.clientX,e.clientY);e.preventDefault();});
  window.addEventListener('mousemove',e=>{if(dragging)updateSpin(e.clientX,e.clientY);});
  window.addEventListener('mouseup',()=>{dragging=false;});
  pad.addEventListener('touchstart',e=>{dragging=true;updateSpin(e.touches[0].clientX,e.touches[0].clientY);e.preventDefault();},{passive:false});
  window.addEventListener('touchmove',e=>{if(dragging)updateSpin(e.touches[0].clientX,e.touches[0].clientY);},{passive:false});
  window.addEventListener('touchend',()=>{dragging=false;});
  // double-click resets to center
  pad.addEventListener('dblclick',()=>{
    spinX=0;spinY=0;
    dot.style.left='50%';dot.style.top='50%';
    lbl.textContent='Center (no spin)';
  });

  window.resetSpin = function(){
    spinX=0;spinY=0;
    dot.style.left='50%';dot.style.top='50%';
    lbl.textContent='Center (no spin)';
  };
})();

// ── Table selector ────────────────────────────────────────────────────────────
(function(){
  const STORAGE_KEY='pengpool_table';
  const mesaImg=document.getElementById('mesa-img');
  const overlay=document.getElementById('tableModal');
  const open=()=>{updateThumbs();overlay.classList.add('on');};
  const close=()=>overlay.classList.remove('on');

  function applyTable(src){
    mesaImg.src=src;
    localStorage.setItem(STORAGE_KEY,src);
    updateThumbs();
  }

  function updateThumbs(){
    const current=mesaImg.src.split('/').pop();
    document.querySelectorAll('.table-thumb').forEach(el=>{
      el.classList.toggle('selected', el.dataset.table.split('/').pop()===current);
    });
  }

  // Apply saved table on load
  const saved=localStorage.getItem(STORAGE_KEY);
  if(saved) mesaImg.src=saved;

  document.getElementById('btnTable').addEventListener('click',open);
  document.getElementById('btnTableClose').addEventListener('click',close);
  overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
  document.querySelectorAll('.table-thumb').forEach(el=>{
    el.addEventListener('click',()=>applyTable(el.dataset.table));
  });
  updateThumbs();
})();

// ── START — init and loop run immediately, game screen just hidden visually ──
initState();
loop();

// Emergency: withdraw stuck deposit (callable from browser console)
window._debugWithdrawDeposit = async function() {
  const w = window.PengPoolWeb3;
  if (!w || !w.isConnected()) { console.error('Wallet not connected'); return; }
  try {
    const dep = await w.getDeposit(w.getAddress());
    console.log('Current deposit:', dep);
    if (!dep || dep.amount === 0n) { console.log('No deposit to withdraw'); return; }
    const tx = await w.withdrawDeposit();
    console.log('withdrawDeposit tx:', tx);
  } catch(e) {
    console.error('withdrawDeposit failed:', e);
  }
};
