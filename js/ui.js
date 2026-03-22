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
  document.getElementById('intro').classList.add('hidden');
  document.getElementById('lobby').classList.add('hidden');
  document.getElementById('game').classList.add('hidden');
  document.getElementById(id).classList.remove('hidden');
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
  playVictory();
  document.getElementById('mtitle').textContent='PLAYER '+winner+' WINS!';
  document.getElementById('msub').innerHTML='<strong>'+reason+'</strong><br>Smart contract releases the pot.';
  document.getElementById('modal').classList.add('on');
}

C.addEventListener('mousemove',e=>{
  const r=C.getBoundingClientRect();
  const mx=(e.clientX-r.left)*(W/r.width),my=(e.clientY-r.top)*(H/r.height);
  if(!moving&&cue&&!cue.out&&running){
    angle=Math.atan2(my-cue.y,mx-cue.x);
    document.getElementById('angdisp').textContent=Math.round((angle*180/Math.PI+360)%360)+'°';
    aiming=true;
  }
});
C.addEventListener('mousedown',e=>{if(moving||!running||!cue||cue.out||e.button!==0)return;charging=true;cs=Date.now();pwr=0;});
C.addEventListener('mouseup',()=>{if(!charging)return;charging=false;if(pwr>2)shoot();pwr=0;document.getElementById('pwf').style.width='0%';document.getElementById('pwpct').textContent='0%';});
C.addEventListener('mouseleave',()=>{aiming=false;if(charging){charging=false;if(pwr>2)shoot();pwr=0;}});

// ── BUTTONS ──
document.getElementById('btnEnter').addEventListener('click',()=>show('lobby'));
document.getElementById('btnPlay').addEventListener('click',()=>{show('game');initState();startMusic();});
document.getElementById('btnPractice').addEventListener('click',()=>{show('game');initState();startMusic();});
document.getElementById('cWager').addEventListener('click',()=>{show('game');initState();startMusic();});
document.getElementById('cPractice').addEventListener('click',()=>{show('game');initState();startMusic();});
document.getElementById('btnLobby').addEventListener('click',()=>show('lobby'));
document.getElementById('btnLobby2').addEventListener('click',()=>{stopMusic();show('lobby');});
document.getElementById('btnNew').addEventListener('click',()=>initState());
document.getElementById('btnAgain').addEventListener('click',()=>{document.getElementById('modal').classList.remove('on');initState();});
document.getElementById('btnMlobby').addEventListener('click',()=>{document.getElementById('modal').classList.remove('on');show('lobby');});
document.getElementById('btnGuide').addEventListener('click',()=>{guideOn=!guideOn;document.getElementById('guidetxt').textContent=guideOn?'ON':'OFF';});

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
