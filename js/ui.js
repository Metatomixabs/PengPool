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
let _receivedGameOver = false; // guard to avoid echo when we receive gameover from WS
let _matchReady     = false;   // true once the pre-match countdown finishes
let _matchCdInterval = null;

// ═══════════════════════════
// WEBSOCKET SYNC
// ═══════════════════════════
let _ws = null;
const WS_URL   = window.location.hostname === 'localhost' ? 'ws://localhost:8080'   : 'wss://pengpool-production.up.railway.app';
const HTTP_URL = window.location.hostname === 'localhost' ? 'http://localhost:8080' : 'https://pengpool-production.up.railway.app';

function _connectWS(gameId, playerNum, addr) {
  if (_ws) { try { _ws.close(); } catch(_){} _ws = null; }
  try {
    _ws = new WebSocket(WS_URL);
  } catch(e) {
    console.warn('[WS] Cannot connect:', e.message);
    toast('Sync server offline — shots won\'t sync', 1);
    return;
  }
  _ws.onopen = () => {
    const joinMsg = { type: 'join', gameId, playerNum, addr, alias: getStoredUsername(addr) || '' };
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

function _wsSend(obj) {
  if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send(JSON.stringify(obj));
}

function _wsOnMessage(msg) {
  const G = window.PengPoolGame;
  if (msg.type === 'ready') {
    console.log('Ready received, opponentAlias:', msg.opponentAlias);
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
  else if (msg.type === 'shoot') {
    // Opponent fired — no local physics; animation comes via 'frame' messages
    console.log('[SYNC] received shoot notification from opponent');
    if (G) G.applyRemoteShoot();
  }
  else if (msg.type === 'frame') {
    // Live ball positions from shooter — update directly for real-time animation
    if (G) G.applyFrame(msg.balls);
  }
  else if (msg.type === 'result') {
    // Authoritative final state from the shooter — apply and update turn
    console.log('[SYNC] received result from server — cur='+msg.cur+' balls='+(msg.balls&&msg.balls.length));
    if (G) G.applyResult(msg); else console.warn('[SYNC] PengPoolGame not ready!');
  }
  else if (msg.type === 'timeout') {
    // Active player's turn timer expired — sync the turn change locally
    toast('Opponent ran out of time!', 0);
    switchTurn();
  }
  else if (msg.type === 'gameover') {
    _receivedGameOver = true;
    endGame(msg.winnerNum, msg.reason);
  }
  else if (msg.type === 'settled') {
    const sub = document.getElementById('msub');
    if (!sub) return;
    if (msg.error) {
      sub.innerHTML = sub.innerHTML.replace('Settling on-chain\u2026',
        '<span style="font-size:11px;color:#ff6b6b">Settlement failed: '+msg.error+'</span>');
    } else {
      const short = msg.txHash ? msg.txHash.slice(0,14)+'\u2026' : '';
      sub.innerHTML = sub.innerHTML.replace('Settling on-chain\u2026',
        '<span style="font-family:\'Space Mono\',monospace;font-size:9px;color:var(--t2)">Settled \xb7 '+short+'</span>');
    }
  }
  else if (msg.type === 'disconnect') {
    toast('Opponent disconnected!', 1);
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
  _ws.send(JSON.stringify({ type: 'frame', balls: payload }));
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
  const modal = document.getElementById('usernameModal');
  const input = document.getElementById('usernameInput');
  const btn   = document.getElementById('usernameSubmit');
  if (!modal || !input || !btn) { if (onSave) onSave(null); return; }
  input.value = getStoredUsername(addr) || '';
  modal.classList.add('on');
  setTimeout(() => input.focus(), 50);
  const save = () => {
    const name = input.value.trim().slice(0, 20);
    if (!name) { input.focus(); return; }
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
  _timerInterval = setInterval(() => {
    if (!running || document.getElementById('game').classList.contains('hidden')) { stopTurnTimer(); return; }
    _timerSec--;
    _updateTimerDisplay();
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
  ['intro','lobby','game','matchmaking'].forEach(s => {
    const el = document.getElementById(s); if (el) el.classList.add('hidden');
  });
  if (id !== 'matchmaking') { clearInterval(_mmCdInterval); _mmCdInterval = null; }
  const el = document.getElementById(id); if (el) el.classList.remove('hidden');
}


function renderUI(){
  const mk=(id,arr)=>{
    const el=document.getElementById(id);el.innerHTML='';
    arr.forEach(n=>{
      const d=document.createElement('div');
      d.className='mb'+(BD[n].s?' stripe':'');
      d.style.background=BD[n].c;
      d.textContent=n;
      el.appendChild(d);
    });
  };
  mk('p1t',p1t);mk('p2t',p2t);
  // Update type labels
  const l1=document.getElementById('p1type-lbl');
  const l2=document.getElementById('p2type-lbl');
  if(l1&&p1T){l1.textContent='TYPE: '+p1T.toUpperCase();l1.style.color=p1T==='solid'?'#e8b800':'#4488ff';}
  if(l2&&p2T){l2.textContent='TYPE: '+p2T.toUpperCase();l2.style.color=p2T==='solid'?'#e8b800':'#4488ff';}
  const tb=document.getElementById('tbt');tb.innerHTML='';
  balls.filter(b=>b.id!==0&&!b.out).forEach(b=>{
    const d=document.createElement('div');
    d.className='mb'+(BD[b.id].s?' stripe':'');
    d.style.background=BD[b.id].c;
    d.textContent=b.id;
    tb.appendChild(d);
  });
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
    const fee=(pot*0.05).toFixed(2);
    const payout=(pot*0.95).toFixed(2);
    document.getElementById('pPot').textContent=pot.toFixed(2)+' USD';
    document.getElementById('pFee').textContent=fee+' USD';
    document.getElementById('pWinner').textContent=payout+' USD';
  }else{
    document.getElementById('pPot').textContent='Practice';
    document.getElementById('pFee').textContent='—';
    document.getElementById('pWinner').textContent='No wager';
  }
  if(gameMode==='multiplayer'&&currentGameId!==null){
    document.getElementById('msub').innerHTML='<strong>'+reason+'</strong><br>Settling on-chain\u2026';
    document.getElementById('modal').classList.add('on');
  }else{
    document.getElementById('msub').innerHTML='<strong>'+reason+'</strong><br>Practice game \u2014 no wager.';
    document.getElementById('modal').classList.add('on');
  }
}

C.addEventListener('mousemove',e=>{
  const r=C.getBoundingClientRect();
  const mx=(e.clientX-r.left)*(W/r.width),my=(e.clientY-r.top)*(H/r.height);
  if(!moving&&cue&&!cue.out&&running){
    if(gameMode==='multiplayer'&&cur!==myPlayerNum)return;
    if(ballInHand){
      // Drag cue ball preview along the vertical head-string (x fixed, y free)
      const MARGIN=R+24;
      cue.x=BIH_X;
      cue.y=Math.max(MARGIN,Math.min(H-MARGIN,my));
      aiming=false;
    } else {
      angle=Math.atan2(my-cue.y,mx-cue.x);
      document.getElementById('angdisp').textContent=Math.round((angle*180/Math.PI+360)%360)+'°';
      aiming=true;
    }
  }
});
C.addEventListener('mousedown',e=>{
  if(moving||!running||!cue||cue.out||e.button!==0)return;
  if(gameMode==='multiplayer'&&(!_matchReady||cur!==myPlayerNum))return;
  if(ballInHand){
    // Confirm placement only — do NOT start charging on this same click.
    // Player must release and click again to charge the shot.
    ballInHand=false;
    if(typeof _updateBonusUI==='function')_updateBonusUI();
    document.getElementById('gstatus').textContent='HOLD TO CHARGE — RELEASE TO SHOOT';
    return;
  }
  charging=true;cs=Date.now();pwr=0;
});
C.addEventListener('mouseup',()=>{if(!charging)return;charging=false;if(pwr>2)shoot();pwr=0;document.getElementById('pwf').style.width='0%';document.getElementById('pwpct').textContent='0%';});
C.addEventListener('mouseleave',()=>{aiming=false;if(charging){charging=false;if(pwr>2)shoot();pwr=0;}});

// ── BUTTONS ──
document.getElementById('btnEnter').addEventListener('click',()=>show('lobby'));
document.getElementById('btnPlay').addEventListener('click',()=>_onWager());
document.getElementById('btnPractice').addEventListener('click',()=>_onPractice());
document.getElementById('cWager').addEventListener('click',()=>_onWager());
document.getElementById('cPractice').addEventListener('click',()=>_onPractice());
document.getElementById('btnLobby').addEventListener('click',()=>_confirmLeaveLobby(false));
document.getElementById('btnLobby2').addEventListener('click',()=>_confirmLeaveLobby(true));
document.getElementById('btnMlobby').addEventListener('click',()=>{document.getElementById('modal').classList.remove('on');_resetGS();show('lobby');});
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
document.getElementById('btnMMBack').addEventListener('click',()=>show('lobby'));
document.getElementById('btnCreateGame').addEventListener('click',_createGame);
document.getElementById('btnCancelMyGame').addEventListener('click',_cancelMyGame);
document.querySelectorAll('.bet-opt').forEach(b=>b.addEventListener('click',()=>{
  selectedBetUSD=Number(b.dataset.usd);
  document.querySelectorAll('.bet-opt').forEach(x=>x.classList.toggle('active',x===b));
}));

// ════════════════════════════════════════════════
// WEB3 / MATCHMAKING LOGIC
// ════════════════════════════════════════════════

function _resetGS(){
  gameMode='practice';currentGameId=null;currentGameData=null;myPlayerNum=1;
  _matchReady=false;
  clearInterval(_matchCdInterval);_matchCdInterval=null;
  const ov=document.getElementById('matchCountdown');if(ov)ov.classList.remove('on');
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
    _resetGS();
    show('lobby');
  };
  dlg.classList.add('on');
}

function _onPractice(){
  _resetGS();
  show('game');
  const w=window.PengPoolWeb3;
  const p1lbl=document.getElementById('p1label');
  if(p1lbl&&w&&w.isConnected())p1lbl.textContent=getDisplayName(w.getAddress());
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
}

function _openMM(){
  const w=window.PengPoolWeb3;
  const el=document.getElementById('mmAddr');if(el&&w)el.textContent=getDisplayName(w.getAddress());
  show('matchmaking');
  _mmStart();
}

function _mmStart(){
  _loadGames();
  _mmCountdown=10;_updCd();
  clearInterval(_mmCdInterval);
  _mmCdInterval=setInterval(()=>{_mmCountdown--;_updCd();if(_mmCountdown<=0){_mmCountdown=10;_loadGames();}},1000);
}

function _updCd(){const e=document.getElementById('mmCountdownBadge');if(e)e.textContent=_mmCountdown+'s';}

async function _loadGames(){
  if(gameMode==='multiplayer')return; // game already started — never reconnect from polling
  const list=document.getElementById('openGamesList');if(!list)return;
  const w=window.PengPoolWeb3;
  if(!w){list.innerHTML='<div class="mm-empty">Web3 unavailable</div>';return;}
  let _aliasMap={};
  try{_aliasMap=await fetch(HTTP_URL+'/aliases').then(r=>r.json());}catch{}
  try{
    // If I created a game, check if someone joined while the panel was open
    if(myGameId!==null){
      const mg=await w.getGame(myGameId);
      if(Number(mg.status)===1){ // ACTIVE — P2 joined
        currentGameId=myGameId;currentGameData=mg;myPlayerNum=1;gameMode='multiplayer';
        myGameId=null;clearInterval(_mmCdInterval);_mmCdInterval=null;
        show('game');
        _connectWS(currentGameId,1,w.getAddress());
        return;
      }
    }

    const ids=await w.getOpenGames();
    if(!ids||!ids.length){
      list.innerHTML='<div class="mm-empty">No open games yet\u2014\u200bbe the first to create one!</div>';
      document.getElementById('myGameBanner').classList.add('hidden');
      return;
    }

    const games=await Promise.all(ids.map(id=>w.getGame(id).then(g=>({id:Number(id),...g}))));
    const me=w.getAddress()?.toLowerCase();
    list.innerHTML='';
    let myG=null;

    games.forEach(g=>{
      const isMe=g.player1?.toLowerCase()===me;
      if(isMe)myG=g;
      const row=document.createElement('div');row.className='mm-row';
      row.innerHTML=
        '<div>'+
          '<div class="mm-gid">GAME #'+g.id+'</div>'+
          '<div class="mm-gusd">$'+g.betUSD+' USD</div>'+
          '<div class="mm-gaddr">'+(_aliasMap[g.player1?.toLowerCase()]||shortenAddr(g.player1))+'</div>'+
        '</div>'+
        '<button class="mm-join" '+(isMe?'disabled':'')+'>'+
          (isMe?'YOUR GAME':'JOIN \u2192')+
        '</button>';
      if(!isMe)row.querySelector('.mm-join').addEventListener('click',()=>_joinGame(g.id,g));
      list.appendChild(row);
    });

    const banner=document.getElementById('myGameBanner');
    const lbl=document.getElementById('myGameLabel');
    if(myG){lbl.textContent='GAME #'+myG.id+' \xb7 $'+myG.betUSD+' USD';banner.classList.remove('hidden');myGameId=myG.id;}
    else banner.classList.add('hidden');

  }catch(e){list.innerHTML='<div class="mm-empty">Error: '+e.message.replace('[PengPool] ','')+'</div>';}
}

async function _createGame(){
  const w=window.PengPoolWeb3;
  if(!w||!w.isConnected()){toast('Connect wallet first',1);return;}
  const btn=document.getElementById('btnCreateGame');btn.disabled=true;btn.textContent='Creating\u2026';
  try{
    await w.createGame(selectedBetUSD);
    toast('Game created! Waiting for opponent\u2026');
  }catch(e){toast(e.message.replace('[PengPool] ',''),1);}
  btn.disabled=false;btn.textContent='🎮 CREATE GAME';
}

async function _joinGame(gameId,gameData){
  const w=window.PengPoolWeb3;
  if(!w||!w.isConnected()){toast('Connect wallet first',1);return;}
  // Disable all join buttons to prevent double-click
  document.querySelectorAll('.mm-join').forEach(b=>{b.disabled=true;});
  try{
    toast('Joining game #'+gameId+'\u2026');
    await w.joinGame(gameId);
    const fresh=await w.getGame(gameId);
    currentGameId=gameId;currentGameData=fresh;myPlayerNum=2;gameMode='multiplayer';
    clearInterval(_mmCdInterval);_mmCdInterval=null;
    show('game');
    _connectWS(currentGameId,2,w.getAddress());
  }catch(e){
    toast(e.message.replace('[PengPool] ',''),1);
    document.querySelectorAll('.mm-join').forEach(b=>{b.disabled=false;});
  }
}

async function _cancelMyGame(){
  const w=window.PengPoolWeb3;
  if(!w||!w.isConnected()){toast('Connect wallet first',1);return;}
  const btn=document.getElementById('btnCancelMyGame');btn.disabled=true;btn.textContent='Cancelling\u2026';
  try{
    const ids=await w.getOpenGames();
    const me=w.getAddress()?.toLowerCase();
    let target=null;
    for(const id of ids){const g=await w.getGame(id);if(g.player1?.toLowerCase()===me){target=Number(id);break;}}
    if(target===null){toast('No open game to cancel',1);btn.disabled=false;btn.textContent='CANCEL & REFUND';return;}
    await w.cancelGame(target);
    myGameId=null;toast('Game cancelled \u2014 refund sent!');
    setTimeout(_loadGames,2000);
  }catch(e){toast(e.message.replace('[PengPool] ',''),1);}
  btn.disabled=false;btn.textContent='CANCEL & REFUND';
}

// ── Spin pad ──────────────────────────────────────────────────────────────────
(function(){
  const pad=document.getElementById('spinPad');
  const dot=document.getElementById('spinDot');
  const lbl=document.getElementById('spinName');
  const R_PAD=27; // radius of pad in px
  let dragging=false;

  const SPIN_NAMES={
    'top':'Efecto alto (follow)',
    'bottom':'Efecto bajo (draw)',
    'left':'Efecto izquierda',
    'right':'Efecto derecha',
    'top-left':'Efecto alto-izq',
    'top-right':'Efecto alto-der',
    'bottom-left':'Efecto bajo-izq',
    'bottom-right':'Efecto bajo-der',
    'center':'Centro (sin efecto)'
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
    lbl.textContent=SPIN_NAMES[key]||'Centro';
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
    lbl.textContent='Centro (sin efecto)';
  });
})();

// ── START — init and loop run immediately, game screen just hidden visually ──
initState();
loop();
