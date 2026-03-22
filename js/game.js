// ═══════════════════════════
// BILLIARDS ENGINE
// (same as working test file)
// ═══════════════════════════
const C  = document.getElementById('pool');
const cx = C.getContext('2d');
const W = C.width, H = C.height;
const ABSTRACT_LOGO = new Image(); ABSTRACT_LOGO.src = 'data:image/png;base64,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';
const R=11, FRIC=0.9875, MINS=0.1, MAXP=20, PR=21;

const BD = {
  1:{c:'#e8b800',s:0},2:{c:'#1255c7',s:0},3:{c:'#d42020',s:0},
  4:{c:'#7b2fbe',s:0},5:{c:'#e05a00',s:0},6:{c:'#0d8a3c',s:0},
  7:{c:'#8b2000',s:0},8:{c:'#111111',s:0},
  9:{c:'#e8b800',s:1},10:{c:'#1255c7',s:1},11:{c:'#d42020',s:1},
  12:{c:'#7b2fbe',s:1},13:{c:'#e05a00',s:1},14:{c:'#0d8a3c',s:1},
  15:{c:'#8b2000',s:1}
};
const PRAIL=28;
const PKT=[
  {x:PRAIL,   y:PRAIL,   r:22,type:'corner'},
  {x:W/2,     y:12,      r:20,type:'mid'},
  {x:W-PRAIL, y:PRAIL,   r:22,type:'corner'},
  {x:PRAIL,   y:H-PRAIL, r:22,type:'corner'},
  {x:W/2,     y:H-12,    r:20,type:'mid'},
  {x:W-PRAIL, y:H-PRAIL, r:22,type:'corner'}
];

let balls,cue,moving,aiming,angle,pwr,charging,cs,cur,p1t,p2t,p1T,p2T,typed,anyP,cueP,shots,running,guideOn,spinX,spinY;


// ═══════════════════════════
// PARTICLE SYSTEM
// ═══════════════════════════
let particles=[];

function spawnPocketParticles(x,y,color){
  const rect=C.getBoundingClientRect();
  const sx=rect.left+(x/W)*rect.width;
  const sy=rect.top+(y/H)*rect.height;
  for(let i=0;i<18;i++){
    const ang=Math.random()*Math.PI*2;
    const spd=1.5+Math.random()*3.5;
    particles.push({
      x:sx,y:sy,
      vx:Math.cos(ang)*spd,vy:Math.sin(ang)*spd-1.5,
      life:1,decay:0.025+Math.random()*0.02,
      size:2+Math.random()*4,
      color:color||'#00C951',
      type:'spark'
    });
  }
  // big flash circle
  particles.push({x:sx,y:sy,life:1,decay:0.07,size:28,color:color||'#ffdd55',type:'flash',vx:0,vy:0});
}

function spawnHitParticles(x,y){
  const rect=C.getBoundingClientRect();
  const sx=rect.left+(x/W)*rect.width;
  const sy=rect.top+(y/H)*rect.height;
  for(let i=0;i<6;i++){
    const ang=Math.random()*Math.PI*2;
    particles.push({
      x:sx,y:sy,
      vx:Math.cos(ang)*1.5,vy:Math.sin(ang)*1.5,
      life:1,decay:0.08,size:2,color:'rgba(255,255,255,0.6)',type:'spark'
    });
  }
}

function updateParticles(){
  const cvs=document.getElementById('particle-canvas');
  if(!cvs)return;
  const pctx=cvs.getContext('2d');
  cvs.width=window.innerWidth;cvs.height=window.innerHeight;
  pctx.clearRect(0,0,cvs.width,cvs.height);
  particles=particles.filter(p=>p.life>0);
  for(const p of particles){
    p.x+=p.vx;p.y+=p.vy;p.vy+=0.08;p.life-=p.decay;
    if(p.life<=0)continue;
    pctx.save();pctx.globalAlpha=p.life;
    if(p.type==='flash'){
      const grad=pctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.size*(2-p.life));
      grad.addColorStop(0,p.color);grad.addColorStop(1,'transparent');
      pctx.fillStyle=grad;
      pctx.beginPath();pctx.arc(p.x,p.y,p.size*(2-p.life),0,Math.PI*2);pctx.fill();
    }else{
      pctx.fillStyle=p.color;
      pctx.beginPath();pctx.arc(p.x,p.y,p.size*p.life,0,Math.PI*2);pctx.fill();
    }
    pctx.restore();
  }
}

// ═══════════════════════════
// BALL TRAILS
// ═══════════════════════════
let trails={};  // keyed by ball id
const TRAIL_MAX=10;

function updateTrails(){
  for(const b of balls){
    if(b.out)continue;
    const spd=Math.sqrt(b.vx*b.vx+b.vy*b.vy);
    if(spd>0.5){
      if(!trails[b.id])trails[b.id]=[];
      trails[b.id].unshift({x:b.x,y:b.y,spd});
      if(trails[b.id].length>TRAIL_MAX)trails[b.id].pop();
    }else{
      trails[b.id]=[];
    }
  }
}

function drawTrails(){
  for(const [id,pts] of Object.entries(trails)){
    if(!pts||pts.length<2)continue;
    const b=balls.find(b=>b.id==id);
    if(!b||b.out)continue;
    const color=id=='0'?'rgba(255,255,255':'rgba(255,220,80';
    for(let i=1;i<pts.length;i++){
      const alpha=(1-i/TRAIL_MAX)*0.25;
      const r=R*(1-i/TRAIL_MAX)*0.6;
      cx.beginPath();cx.arc(pts[i].x,pts[i].y,Math.max(1,r),0,Math.PI*2);
      cx.fillStyle=`${color},${alpha})`;cx.fill();
    }
  }
}

function initState() {
  balls=[]; cur=1; p1t=[]; p2t=[]; p1T=null; p2T=null; typed=false;
  anyP=false; cueP=false; foulThisTurn=false; shots=0; running=true; guideOn=true;
  aiming=false; angle=0; pwr=0; charging=false; moving=false; spinX=0; spinY=0;
  trails={}; particles=[];
  cue={id:0,x:180,y:H/2,vx:0,vy:0,out:false};
  balls.push(cue);
  const rx=490,ry=H/2,sp=R*2.08,S=Math.sin(Math.PI/3);
  const pos=[[0,0],[1,-S],[1,S],[2,-2*S],[2,0],[2,2*S],[3,-3*S],[3,-S],[3,S],[3,3*S],[4,-4*S],[4,-2*S],[4,0],[4,2*S],[4,4*S]];
  let nums=[1,2,3,4,5,6,7,9,10,11,12,13,14,15];
  for(let i=nums.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[nums[i],nums[j]]=[nums[j],nums[i]];}
  nums.splice(4,0,8);
  for(let i=0;i<15;i++){
    const n=nums[i],d=BD[n],[px,py]=pos[i];
    balls.push({id:n,x:rx+px*sp+(Math.random()-.5)*.4,y:ry+py*sp+(Math.random()-.5)*.4,vx:0,vy:0,c:d.c,s:d.s,out:false});
  }
  document.getElementById('shotsv').textContent='0';
  document.getElementById('pwf').style.width='0%';
  document.getElementById('pwpct').textContent='0%';
  document.getElementById('gstatus').textContent='MOVE MOUSE TO AIM — HOLD CLICK TO CHARGE';
  document.getElementById('pr1').className='pr on';
  document.getElementById('pr2').className='pr';
  document.getElementById('pt1').textContent='—';
  document.getElementById('pt2').textContent='—';
  renderUI();
  resetTurnTimer();
}

function phys() {
  let mv=false;
  for(const b of balls){
    if(b.out)continue;
    if(Math.abs(b.vx)>MINS||Math.abs(b.vy)>MINS){
      mv=true;
      // Continuous spin: side spin (english) curves the cue ball
      if(b.id===0&&b.spinX&&!b.spun){
        const spd=Math.sqrt(b.vx*b.vx+b.vy*b.vy);
        if(spd>0.5){
          const perpX=-b.vy/spd, perpY=b.vx/spd;
          const spinForce=b.spinX*0.018*spd;
          b.vx+=perpX*spinForce; b.vy+=perpY*spinForce;
        }
      }
      b.x+=b.vx;b.y+=b.vy;b.vx*=FRIC;b.vy*=FRIC;
      if(Math.abs(b.vx)<MINS)b.vx=0;if(Math.abs(b.vy)<MINS)b.vy=0;
      const WL=22,WR=W-22,WT=22,WB=H-22;
      const midGap=20;
      const atMidX=(b.x>W/2-midGap && b.x<W/2+midGap);
      let hitRail=false;
      if(b.x-R<WL){b.x=WL+R;b.vx*=-.82;hitRail=true;}if(b.x+R>WR){b.x=WR-R;b.vx*=-.82;hitRail=true;}
      if(!atMidX && b.y-R<WT){b.y=WT+R;b.vy*=-.82;hitRail=true;}
      if(!atMidX && b.y+R>WB){b.y=WB-R;b.vy*=-.82;hitRail=true;}
      if(hitRail){const spd=Math.sqrt(b.vx*b.vx+b.vy*b.vy);if(spd>1.5)playRailHit();}
      // Mid pocket corner deflection — ball near the mouth corner gets pushed away
      const corners=[
        {cx:W/2-midGap, cy:WT},  // top-left corner of top mid pocket mouth
        {cx:W/2+midGap, cy:WT},  // top-right corner of top mid pocket mouth
        {cx:W/2-midGap, cy:WB},  // bottom-left corner
        {cx:W/2+midGap, cy:WB}   // bottom-right corner
      ];
      for(const c of corners){
        const dx=b.x-c.cx,dy=b.y-c.cy,dist=Math.sqrt(dx*dx+dy*dy);
        if(dist<R+2&&dist>.01){
          const nx=dx/dist,ny=dy/dist;
          
          b.x+=nx*(R+2-dist);b.y+=ny*(R+2-dist);
          const dot=b.vx*nx+b.vy*ny;
          if(dot<0){b.vx-=2*dot*nx;b.vy-=2*dot*ny;b.vx*=.72;b.vy*=.72;}
        }
      }
    }
  }
  for(let i=0;i<balls.length;i++)for(let j=i+1;j<balls.length;j++){
    const a=balls[i],b=balls[j];if(a.out||b.out)continue;
    const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy),mn=R*2;
    if(d<mn&&d>.001){
      const nx=dx/d,ny=dy/d,ov=(mn-d)/2;
      a.x-=nx*ov;a.y-=ny*ov;b.x+=nx*ov;b.y+=ny*ov;
      const dv=(a.vx-b.vx)*nx+(a.vy-b.vy)*ny;
      if(dv>0){
        a.vx-=dv*nx;a.vy-=dv*ny;b.vx+=dv*nx;b.vy+=dv*ny;
        // Collision sound based on impact speed
        const impactSpd=Math.abs(dv);
        if(impactSpd>0.8) playCollision(Math.min(1,impactSpd/MAXP));
        spawnHitParticles((a.x+b.x)/2,(a.y+b.y)/2);
      }
      // Apply spin to cue ball on first collision (topspin/draw affects post-collision direction)
      const isCue=(a.id===0||b.id===0);
      const cueBall=(a.id===0)?a:(b.id===0)?b:null;
      if(cueBall&&!cueBall.spun){
        const spd=Math.sqrt(cueBall.vx*cueBall.vx+cueBall.vy*cueBall.vy);
        // Follow (top spin): adds momentum along direction of travel
        // Draw (back spin): reverses some of the forward momentum
        cueBall.vx+=Math.cos(angle)*cueBall.spinY*cueBall.shotSpd*0.22;
        cueBall.vy+=Math.sin(angle)*cueBall.spinY*cueBall.shotSpd*0.22;
        // English (side spin) applied immediately at collision
        cueBall.vx+=Math.cos(angle+Math.PI/2)*cueBall.spinX*cueBall.shotSpd*0.16;
        cueBall.vy+=Math.sin(angle+Math.PI/2)*cueBall.spinX*cueBall.shotSpd*0.16;
        cueBall.spun=true;
      }
    }
  }
  for(const b of balls){
    if(b.out)continue;
    for(const p of PKT){
      if(Math.sqrt((b.x-p.x)**2+(b.y-p.y)**2)<p.r){b.out=true;b.vx=0;b.vy=0;pocketed(b);break;}
    }
  }
  return mv;
}

function pocketed(b){
  anyP=true;
  playPocket();
  const ballColor=b.id===0?'#ffffff':(BD[b.id]?BD[b.id].c:'#ffdd55');
  for(const p of PKT){
    if(Math.sqrt((b.x-p.x)**2+(b.y-p.y)**2)<p.r*2){
      spawnPocketParticles(p.x,p.y,ballColor);break;
    }
  }
  if(b.id===0){cueP=true;toast('⚠️ FOUL — Scratch!',1);return;}
  if(b.id===8){eight();return;}
  if(!typed){
    typed=true;
    const sol=b.id<=7;
    p1T=cur===1?(sol?'solid':'stripe'):(sol?'stripe':'solid');
    p2T=p1T==='solid'?'stripe':'solid';
    toast('P'+cur+' → '+(sol?'SOLIDS 1-7':'STRIPES 9-15')+'!');
    document.getElementById('pt1').textContent=p1T.toUpperCase();
    document.getElementById('pt2').textContent=p2T.toUpperCase();
  }
  const sol=b.id<=7;
  const mine=(cur===1&&((p1T==='solid'&&sol)||(p1T==='stripe'&&!sol)))||
             (cur===2&&((p2T==='solid'&&sol)||(p2T==='stripe'&&!sol)));
  if(mine){
    (cur===1?p1t:p2t).push(b.id);
  } else {
    foulThisTurn=true;
    toast('⚠️ FOUL — wrong ball!',1);
  }
  renderUI();
}

function eight(){
  const my=cur===1?(p1T==='solid'?[1,2,3,4,5,6,7]:[9,10,11,12,13,14,15])
                  :(p2T==='solid'?[1,2,3,4,5,6,7]:[9,10,11,12,13,14,15]);
  const rem=balls.filter(b=>!b.out&&my.includes(b.id));
  endGame(rem.length===0?cur:(cur===1?2:1),rem.length===0?'Pocketed the 8! 🎉':'P'+cur+' potted 8 too early!');
}

function shoot(){
  if(!running)return;
  const spd=pwr/100*MAXP;
  cue.vx=Math.cos(angle)*spd;
  cue.vy=Math.sin(angle)*spd;
  cue.spinX=spinX;
  cue.spinY=spinY;
  cue.shotSpd=spd;  // save initial speed for spin reference
  cue.spun=false;
  shots++;anyP=false;cueP=false;foulThisTurn=false;
  stopTurnTimer();
  playHit(pwr/100);
  if(!_bh&&!_al)_load();
  document.getElementById('shotsv').textContent=shots;
}

function shotEnd(){
  if(!running)return;
  if(cueP){cue.out=false;cue.x=180;cue.y=H/2;cue.vx=0;cue.vy=0;foul();switchTurn();return;}
  if(foulThisTurn){switchTurn();return;}
  if(!anyP)switchTurn();
}

function switchTurn(){
  cur=cur===1?2:1;
  document.getElementById('pr1').className='pr'+(cur===1?' on':'');
  document.getElementById('pr2').className='pr'+(cur===2?' on':'');
  document.getElementById('gstatus').textContent='P'+cur+' — YOUR TURN';
  resetTurnTimer();
}

function lx(h,a){let r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);return'rgb('+(Math.min(255,r+a))+','+(Math.min(255,g+a))+','+(Math.min(255,b+a))+')'}
function dk(h,a){let r=parseInt(h.slice(1,3),16),g=parseInt(h.slice(3,5),16),b=parseInt(h.slice(5,7),16);return'rgb('+(Math.max(0,r-a))+','+(Math.max(0,g-a))+','+(Math.max(0,b-a))+')'}

function drawFelt(){
  // Clean smooth felt — no lines
  const g=cx.createRadialGradient(W/2,H/2,0,W/2,H/2,W*.7);
  g.addColorStop(0,'#006b2e');g.addColorStop(.6,'#005525');g.addColorStop(1,'#004420');
  cx.fillStyle=g;cx.fillRect(0,0,W,H);
  // ── Wooden rails ─────────────────────────────────────────────────────────
  const RAIL=22,CS=6,mx=W/2,mGap=20,cPad=PRAIL+2;
  cx.save();
  const wg=cx.createLinearGradient(0,0,0,H);
  wg.addColorStop(0,'#3d2010');wg.addColorStop(.5,'#2a1508');wg.addColorStop(1,'#1c0e05');
  cx.fillStyle=wg;
  cx.fillRect(0,0,W,RAIL);cx.fillRect(0,H-RAIL,W,RAIL);cx.fillRect(0,0,RAIL,H);cx.fillRect(W-RAIL,0,RAIL,H);
  cx.strokeStyle='rgba(190,130,40,0.22)';cx.lineWidth=1.5;cx.strokeRect(0.8,0.8,W-1.6,H-1.6);
  let rg;
  // Cushion strips — flush against inner edge of rail, no visible gap
  const C0=RAIL-CS,C1=RAIL;
  rg=cx.createLinearGradient(0,C0,0,C1);rg.addColorStop(0,'#00b84a');rg.addColorStop(1,'#006b2e');
  cx.fillStyle=rg;cx.fillRect(cPad,C0,mx-mGap-cPad,CS);cx.fillRect(mx+mGap,C0,W-RAIL-cPad-(mx+mGap),CS);
  rg=cx.createLinearGradient(0,H-C1,0,H-C0);rg.addColorStop(0,'#006b2e');rg.addColorStop(1,'#00b84a');
  cx.fillStyle=rg;cx.fillRect(cPad,H-C1,mx-mGap-cPad,CS);cx.fillRect(mx+mGap,H-C1,W-RAIL-cPad-(mx+mGap),CS);
  rg=cx.createLinearGradient(C0,0,C1,0);rg.addColorStop(0,'#00b84a');rg.addColorStop(1,'#006b2e');
  cx.fillStyle=rg;cx.fillRect(C0,cPad,CS,H-2*cPad);
  rg=cx.createLinearGradient(W-C1,0,W-C0,0);rg.addColorStop(0,'#006b2e');rg.addColorStop(1,'#00b84a');
  cx.fillStyle=rg;cx.fillRect(W-C1,cPad,CS,H-2*cPad);
  cx.restore();
  // ── Abstract logo markers on rails ───────────────────────────────────────
  if(false){ // logos now drawn as HTML divs
    const s=14; // size in canvas px
    cx.save();
    cx.globalAlpha=0.85;
    // top outer rail
    cx.drawImage(ABSTRACT_LOGO, W/2-90-s/2, 4, s, s);
    cx.drawImage(ABSTRACT_LOGO, W/2+90-s/2, 4, s, s);
    // bottom outer rail
    cx.drawImage(ABSTRACT_LOGO, W/2-90-s/2, H-4-s, s, s);
    cx.drawImage(ABSTRACT_LOGO, W/2+90-s/2, H-4-s, s, s);
    // left outer rail
    cx.drawImage(ABSTRACT_LOGO, 4, H/2-70-s/2, s, s);
    cx.drawImage(ABSTRACT_LOGO, 4, H/2+70-s/2, s, s);
    // right outer rail
    cx.drawImage(ABSTRACT_LOGO, W-4-s, H/2-70-s/2, s, s);
    cx.drawImage(ABSTRACT_LOGO, W-4-s, H/2+70-s/2, s, s);
    cx.restore();
  }
  for(const p of PKT){
    const pr=p.r,collarW=Math.round(pr*0.30),isMid=p.type==='mid';
    if(!isMid){
      const halo=cx.createRadialGradient(p.x,p.y,pr*.4,p.x,p.y,pr*2.1);
      halo.addColorStop(0,'rgba(0,0,0,0.88)');halo.addColorStop(0.5,'rgba(0,0,0,0.40)');halo.addColorStop(1,'rgba(0,0,0,0)');
      cx.beginPath();cx.arc(p.x,p.y,pr*2.1,0,Math.PI*2);cx.fillStyle=halo;cx.fill();
      const collarG=cx.createRadialGradient(p.x-pr*.2,p.y-pr*.2,pr*.1,p.x,p.y,pr+collarW);
      collarG.addColorStop(0,'#7a4420');collarG.addColorStop(0.35,'#4e2a0e');collarG.addColorStop(0.72,'#2e1607');collarG.addColorStop(1,'#180b03');
      cx.beginPath();cx.arc(p.x,p.y,pr+collarW,0,Math.PI*2);cx.fillStyle=collarG;cx.fill();
      cx.beginPath();cx.arc(p.x,p.y,pr+collarW,0,Math.PI*2);cx.strokeStyle='rgba(190,140,40,0.40)';cx.lineWidth=1.5;cx.stroke();
      cx.beginPath();cx.arc(p.x,p.y,pr+1,0,Math.PI*2);cx.strokeStyle='rgba(190,140,40,0.25)';cx.lineWidth=1;cx.stroke();
    }
    const holeG=cx.createRadialGradient(p.x-pr*.3,p.y-pr*.3,0,p.x,p.y,pr);
    holeG.addColorStop(0,'#141414');holeG.addColorStop(0.45,'#050505');holeG.addColorStop(1,'#000');
    cx.beginPath();cx.arc(p.x,p.y,pr,0,Math.PI*2);cx.fillStyle=holeG;cx.fill();
    if(!isMid){
      const gleam=cx.createRadialGradient(p.x-pr*.6,p.y-pr*.6,0,p.x-pr*.35,p.y-pr*.35,pr*.7);
      gleam.addColorStop(0,'rgba(255,210,120,0.14)');gleam.addColorStop(1,'rgba(255,210,120,0)');
      cx.beginPath();cx.arc(p.x,p.y,pr+collarW,0,Math.PI*2);cx.fillStyle=gleam;cx.fill();
    }
  }
}

function drawBall(b){
  if(b.out)return;
  cx.save();cx.translate(b.x,b.y);
  cx.beginPath();cx.arc(2,3,R,0,Math.PI*2);cx.fillStyle='rgba(0,0,0,.3)';cx.fill();
  if(b.id===0){
    const g=cx.createRadialGradient(-3,-3,1,0,0,R);g.addColorStop(0,'#fff');g.addColorStop(1,'#ccc');
    cx.beginPath();cx.arc(0,0,R,0,Math.PI*2);cx.fillStyle=g;cx.fill();
  }else if(b.s){
    const g=cx.createRadialGradient(-2,-2,1,0,0,R);g.addColorStop(0,'#fff');g.addColorStop(1,'#e0e0e0');
    cx.beginPath();cx.arc(0,0,R,0,Math.PI*2);cx.fillStyle=g;cx.fill();
    cx.save();cx.beginPath();cx.arc(0,0,R,0,Math.PI*2);cx.clip();
    cx.fillStyle=b.c;cx.fillRect(-R,-R*.42,R*2,R*.84);cx.restore();
  }else{
    const g=cx.createRadialGradient(-3,-3,1,0,0,R);
    g.addColorStop(0,lx(b.c,50));g.addColorStop(.5,b.c);g.addColorStop(1,dk(b.c,40));
    cx.beginPath();cx.arc(0,0,R,0,Math.PI*2);cx.fillStyle=g;cx.fill();
  }
  if(b.id!==0){
    cx.beginPath();cx.arc(0,0,R*.4,0,Math.PI*2);cx.fillStyle='rgba(255,255,255,.9)';cx.fill();
    cx.fillStyle='#111';cx.font='bold '+(R*.5)+'px sans-serif';
    cx.textAlign='center';cx.textBaseline='middle';cx.fillText(b.id,0,.5);
  }
  cx.beginPath();cx.arc(-3,-3,R*.27,0,Math.PI*2);cx.fillStyle='rgba(255,255,255,.22)';cx.fill();
  cx.beginPath();cx.arc(0,0,R,0,Math.PI*2);cx.strokeStyle='rgba(0,0,0,.3)';cx.lineWidth=1;cx.stroke();
  cx.restore();
}

// Overlay canvas for cue (draws over everything)
const OC = document.getElementById('cue-overlay');
const ox = OC.getContext('2d');

function resizeOverlay(){
  OC.width = window.innerWidth;
  OC.height = window.innerHeight;
}
resizeOverlay();
window.addEventListener('resize', resizeOverlay);

// Get cue ball position in screen coordinates
function cueScreenPos(){
  const rect = C.getBoundingClientRect();
  const scaleX = rect.width / W;
  const scaleY = rect.height / H;
  return {
    x: rect.left + cue.x * scaleX,
    y: rect.top  + cue.y * scaleY,
    sx: scaleX,
    sy: scaleY
  };
}

function drawCue(){
  ox.clearRect(0,0,OC.width,OC.height);
  if(!aiming||!running||moving||!cue||cue.out)return;

  const pos = cueScreenPos();
  const cx2 = pos.x, cy2 = pos.y;
  const pull = (26 + pwr/100*12) * pos.sx;
  const stickLen = 148 * pos.sx;
  const ballR = R * pos.sx;

  if(guideOn){
    ox.save();
    ox.strokeStyle='rgba(0,201,81,.15)';ox.lineWidth=1;ox.setLineDash([7,9]);
    ox.beginPath();ox.moveTo(cx2,cy2);
    ox.lineTo(cx2+Math.cos(angle)*370*pos.sx, cy2+Math.sin(angle)*370*pos.sy);
    ox.stroke();ox.setLineDash([]);
    ox.globalAlpha=.2;
    ox.beginPath();ox.arc(cx2+Math.cos(angle)*108*pos.sx, cy2+Math.sin(angle)*108*pos.sy, ballR,0,Math.PI*2);
    ox.strokeStyle='#00C951';ox.lineWidth=1.5;ox.stroke();
    ox.restore();
  }

  // Spin indicator on cue ball
  if(spinX!==0||spinY!==0){
    ox.save();
    // Spinning halo
    const spinMag=Math.sqrt(spinX*spinX+spinY*spinY);
    const halo=ox.createRadialGradient(cx2,cy2,ballR*0.5,cx2,cy2,ballR*1.8);
    halo.addColorStop(0,'rgba(0,201,81,0)');
    halo.addColorStop(0.6,`rgba(0,201,81,${spinMag*0.15})`);
    halo.addColorStop(1,'rgba(0,201,81,0)');
    ox.beginPath();ox.arc(cx2,cy2,ballR*1.8,0,Math.PI*2);
    ox.fillStyle=halo;ox.fill();
    // Spin direction arrow on ball surface
    const sdx=spinX*ballR*0.55, sdy=-spinY*ballR*0.55;
    ox.strokeStyle=`rgba(255,255,100,${0.5+spinMag*0.5})`;
    ox.lineWidth=2*pos.sx;ox.lineCap='round';
    ox.beginPath();ox.moveTo(cx2-sdx,cy2-sdy);ox.lineTo(cx2+sdx,cy2+sdy);ox.stroke();
    // arrowhead
    const arrAngle=Math.atan2(sdy,sdx);
    const arrSize=4*pos.sx;
    ox.beginPath();
    ox.moveTo(cx2+sdx,cy2+sdy);
    ox.lineTo(cx2+sdx-Math.cos(arrAngle-0.5)*arrSize,cy2+sdy-Math.sin(arrAngle-0.5)*arrSize);
    ox.moveTo(cx2+sdx,cy2+sdy);
    ox.lineTo(cx2+sdx-Math.cos(arrAngle+0.5)*arrSize,cy2+sdy-Math.sin(arrAngle+0.5)*arrSize);
    ox.stroke();
    ox.restore();
  }

  const sx = cx2 - Math.cos(angle)*(pull+ballR);
  const sy = cy2 - Math.sin(angle)*(pull+ballR);
  const ex = sx - Math.cos(angle)*stickLen;
  const ey = sy - Math.sin(angle)*stickLen;

  const sg = ox.createLinearGradient(sx,sy,ex,ey);
  sg.addColorStop(0,'#f0e090');sg.addColorStop(.15,'#c89840');sg.addColorStop(1,'#3a1a04');

  ox.save();
  ox.strokeStyle=sg;ox.lineWidth=6*(1-pwr/220)*pos.sx;ox.lineCap='round';
  ox.beginPath();ox.moveTo(sx,sy);ox.lineTo(ex,ey);ox.stroke();
  // Ferrule
  ox.strokeStyle='rgba(240,240,220,.7)';ox.lineWidth=2.5*pos.sx;
  ox.beginPath();ox.moveTo(sx,sy);ox.lineTo(sx-Math.cos(angle)*7*pos.sx,sy-Math.sin(angle)*7*pos.sy);ox.stroke();
  // Tip
  ox.strokeStyle='#3366dd';ox.lineWidth=4*pos.sx;
  ox.beginPath();ox.moveTo(sx,sy);ox.lineTo(sx-Math.cos(angle)*4*pos.sx,sy-Math.sin(angle)*4*pos.sy);ox.stroke();
  ox.restore();
}

function loop(){
  cx.clearRect(0,0,W,H);drawFelt();
  const was=moving;moving=phys();
  if(was&&!moving)shotEnd();
  updateTrails();
  drawTrails();
  for(const b of balls)drawBall(b);
  drawCue(); // draws on overlay canvas
  updateParticles();
  if(charging){
    pwr=Math.min(100,(Date.now()-cs)/24);
    document.getElementById('pwf').style.width=pwr+'%';
    document.getElementById('pwpct').textContent=Math.round(pwr)+'%';
  }
  requestAnimationFrame(loop);
}

