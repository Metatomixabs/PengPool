// ═══════════════════════════
// AUDIO ENGINE (Web Audio API)
// ═══════════════════════════
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
function getAudio(){ if(!audioCtx) audioCtx = new AudioCtx(); return audioCtx; }

// ═══════════════════════════
// JAZZ AMBIENT MUSIC ENGINE
// ═══════════════════════════
let musicCtx = null, musicPlaying = false, musicNodes = [];

function getMusicCtx(){
  if(!musicCtx) musicCtx = new (window.AudioContext||window.webkitAudioContext)();
  return musicCtx;
}

// Reverb impulse response (simple algorithmic)
function makeReverb(ac, duration=1.8, decay=2.0){
  const sr = ac.sampleRate;
  const len = sr * duration;
  const buf = ac.createBuffer(2, len, sr);
  for(let c=0;c<2;c++){
    const d = buf.getChannelData(c);
    for(let i=0;i<len;i++) d[i] = (Math.random()*2-1) * Math.pow(1-i/len, decay);
  }
  const conv = ac.createConvolver();
  conv.buffer = buf;
  return conv;
}

// Piano-like tone: sine + harmonics with quick attack, slow decay
function playPianoNote(ac, freq, time, dur, vol, dest){
  const env = ac.createGain();
  env.gain.setValueAtTime(0, time);
  env.gain.linearRampToValueAtTime(vol, time + 0.012);
  env.gain.exponentialRampToValueAtTime(vol*0.4, time + dur*0.3);
  env.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  env.connect(dest);

  // Fundamental + 2nd + 3rd harmonic
  [[1,1],[2,0.35],[3,0.12],[4,0.06]].forEach(([mult, amp])=>{
    const osc = ac.createOscillator();
    osc.type = mult===1 ? 'sine' : 'sine';
    osc.frequency.value = freq * mult;
    const g = ac.createGain();
    g.gain.value = amp;
    osc.connect(g); g.connect(env);
    osc.start(time); osc.stop(time + dur + 0.05);
    musicNodes.push(osc);
  });
}

// Bass note: sine with fast attack, medium decay, slightly detuned for warmth
function playBassNote(ac, freq, time, dur, vol, dest){
  const env = ac.createGain();
  env.gain.setValueAtTime(0, time);
  env.gain.linearRampToValueAtTime(vol, time + 0.02);
  env.gain.exponentialRampToValueAtTime(0.0001, time + dur * 0.7);
  env.connect(dest);

  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // Add slight 2nd harmonic for bass warmth
  const osc2 = ac.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.value = freq * 2.01;
  const g2 = ac.createGain(); g2.gain.value = 0.2;
  osc2.connect(g2); g2.connect(env);
  osc.connect(env);
  osc.start(time); osc.stop(time + dur);
  osc2.start(time); osc2.stop(time + dur);
  musicNodes.push(osc, osc2);
}

// Jazz chord voicings (frequencies in Hz, rootless voicings)
// Cmaj7, Am7, Dm7, G7 — ii-V-I-vi loop
const JAZZ_CHORDS = [
  // Cmaj7: E3 B3 D4 G4
  [164.81, 246.94, 293.66, 392.00],
  // Am7: E3 G3 C4 E4
  [164.81, 196.00, 261.63, 329.63],
  // Dm7: F3 A3 C4 F4
  [174.61, 220.00, 261.63, 349.23],
  // G7: F3 B3 D4 G4
  [174.61, 246.94, 293.66, 392.00],
];

// Walking bass lines (one note per beat, 4 beats per chord)
const BASS_LINES = [
  // Cmaj7 walk
  [130.81, 146.83, 164.81, 174.61],
  // Am7 walk
  [110.00, 123.47, 130.81, 146.83],
  // Dm7 walk
  [146.83, 130.81, 110.00, 123.47],
  // G7 walk
  [98.00, 110.00, 123.47, 130.81],
];

let _jazzTimeout = null;
let _chordIdx = 0;

function scheduleJazzLoop(){
  if(!musicPlaying) return;
  const ac = getMusicCtx();
  if(ac.state === 'suspended') ac.resume();

  // Master chain: gain → reverb → master gain → output
  const master = ac.createGain();
  master.gain.value = 0.18;

  const reverb = makeReverb(ac, 1.6, 2.2);
  const dryGain = ac.createGain(); dryGain.gain.value = 0.65;
  const wetGain = ac.createGain(); wetGain.gain.value = 0.35;

  master.connect(dryGain); dryGain.connect(ac.destination);
  master.connect(reverb); reverb.connect(wetGain); wetGain.connect(ac.destination);

  const BPM = 76;  // relaxed jazz tempo
  const beat = 60 / BPM;
  const chord = JAZZ_CHORDS[_chordIdx];
  const bass = BASS_LINES[_chordIdx];
  const now = ac.currentTime + 0.05;

  // Play chord: stagger notes slightly for realism
  chord.forEach((freq, i) => {
    const jitter = i * 0.018;
    // Play on beat 1 and beat 3
    playPianoNote(ac, freq, now + jitter, beat*1.8, 0.28, master);
    playPianoNote(ac, freq, now + beat*2 + jitter, beat*1.6, 0.22, master);
  });

  // Walking bass: one note per beat
  bass.forEach((freq, beat_i) => {
    const swing = beat_i % 2 === 1 ? beat * 0.06 : 0; // swing feel
    playBassNote(ac, freq, now + beat_i * beat + swing, beat * 0.75, 0.55, master);
  });

  // Occasional melody note on off-beats (jazz comping feel)
  if(Math.random() > 0.4){
    const melNote = chord[2 + Math.floor(Math.random()*2)]; // upper voice
    const melTime = now + beat * (1 + Math.random() * 2);
    playPianoNote(ac, melNote * 2, melTime, beat * 0.9, 0.18, master);
  }

  _chordIdx = (_chordIdx + 1) % JAZZ_CHORDS.length;

  // Schedule next chord (4 beats)
  const nextIn = beat * 4 * 1000 - 30;
  _jazzTimeout = setTimeout(scheduleJazzLoop, nextIn);
}

function startMusic(){
  if(musicPlaying) return;
  musicPlaying = true;
  _chordIdx = 0;
  scheduleJazzLoop();
  document.getElementById('btnMusic').textContent = '♪ ON';
  const nb = document.getElementById('btnMusicNav'); if(nb) nb.textContent = '♪ ON';
}

function stopMusic(){
  musicPlaying = false;
  if(_jazzTimeout){ clearTimeout(_jazzTimeout); _jazzTimeout = null; }
  musicNodes.forEach(n=>{ try{ n.stop(); }catch(e){} });
  musicNodes = [];
  document.getElementById('btnMusic').textContent = '♪ OFF';
  const nb = document.getElementById('btnMusicNav'); if(nb) nb.textContent = '♪ OFF';
}

function toggleMusic(){
  if(musicPlaying) stopMusic(); else startMusic();
}


// ── Real ball samples ─────────────────────────────────────────────────────
const _BB='UklGRiYFAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIFAACO9BkBKg9EGqkgryCIGVkMTPtk6ITVncNUtvmw0bVExpvhkAOPJy9IOWDLbMxrm1ybQJMc4fMPzEisQpnblrCkysDF5iUPqjLmSgFUgU20OQ8dvv3S4MvLL8PTxSzQRN5U7aT7owbwDhQXrh+wJ20tMjCVLn0njRtYCy359uea2ZbQfM+P1y/nG/qoC+IXzRxLHFMZMhQXDi0Hwf228Yzk6dkI1GPUq9qz5rr35ApqH5Ey5EAVRwhDPzUbH54DduaJzOy4Lq5MsJa9uNE06c//FBITH0UnQCnzJooh9hfMC33/v/Jc6JXjmeSI7I/62gnpFlIdCBoLEMYDPfjo72jtHvFU+VYE6A/7Gf8gKCR+IvMb1RBVAufxiOKt12/SOtMH2WXi0O3H+gcJ9BQ4HBod4Bb/Clr8Hu5Y43vfL+OY7sL+fg9OHoYm2CctJHIcrRI9CFj+O/Ya8ODr0Ogw5//nl+uw8qn8tAb2DXER6A+uCUgAifUp7FzmLeZ87ML3IQVkEToZIhqvE+0HWvt38Y/sD+/r920EshEgHV0jwyGhGEMJtPY741fTzcvozYHZMO2QBNEZHyqeM+Q0ui7XIfsQ4P4M7QndRdFlzNbNRNVn4gXzKAY3GlctyTxBRjhI7EHfM5cfgAet7r3XJsVbuf62g76Jzl/k5PsPEpkkzTDONf0y+ijZGKgEnO+E3ZvRts2a0wTivvXmCc4YOR8RHi4WCQvWAAH4VfLC7gfsq+vd7S/y5PYj/OEASAWZCsUPLROQFAMTOw/lCwkJ+QVpAjr9ofYC8LTpTOQt4Xnht+V47tv5LgaHEjwckiEXIb8aYhE5Btj6G/HX6kPqnO4k9wcDUA+4GM4c8htXF1MRVAs8Bef+WvcM7vrjPtps0lXQVdZ/46b1HwlOGhAnjC7pL7EsbyZZHZkTcgl7/jr0VexG5pnhBN8d3h/g5uVp7pL4NQJHCYMMXAt0BwQCQPz39+r28PlwAN0JNRR8HakjRCSyH2IXawzJAEj2zO3h57zkn+RO6PjuNfdw/5IGBgwyD2YQnA9ODVoK5gYeAxL/Mfsw+LH2zPaj+HH77P3F/ib9ifmT9N3vo+yw6/rtHvRs/ooLJBnwI/ko7yb1HbMPiP6p7R3g39ez1vLcw+hD9zMF5A/lFWoXcRUvEeIL/wUZAAX7qfZg8/zxG/L085j3rPt//xwD1wVxBxgIlQerBf0CdgDc/lr+nf4//8r/6f+e/x7/sP6y/mT/vADSAjQFPgerCI0IXwZ2Aof9mfjb9Hnz8vQH+ZP+KwTRCLULQQxiCpcGoAGg/HT4rfXZ9B/2C/nv/BkBrwTOBvcGVgV8AmP/5Pxj+wn7nPvh/J3+bwAYAk4D9wMCBGgDYAImAe//AP98/lT+pP44/6T/zP/l/+z/sv95/1X/SP9//wgAxwCfAYYCSQOxA4wDnQLgAMD+sfwY+076gPqZ+1L9X/9vASsDRQSQBAsE7gJ0AfH/tv74/b396P1c/ur+bP/R/wMAEAAhAEQAhwDmADEBSwElAcUATwDv/7L/jv+E/4r/l/+w/9T/BwBBAHYAnAC3AMAArgCGAEgA/P+x/2//SP9B/1z/lv/g/ycAWABrAGEARAAeAPr/4P/R/9D/2P/i/+z/8P/t/+f/4P/Z/9j/3v/n//H//P8FAAwAEQAUABUAFAARAAsAAwD7//P/7f/p/+j/6v/v//X/';
const _RL='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';
function _dw(b,ac){const n=atob(b),a=new ArrayBuffer(n.length),v=new Uint8Array(a);for(let i=0;i<n.length;i++)v[i]=n.charCodeAt(i);return ac.decodeAudioData(a);}
let _bh=null,_rh=null,_al=false;
function _load(){if(_al||(_bh&&_rh))return;_al=true;const ac=getAudio();Promise.all([_dw(_BB,ac),_dw(_RL,ac)]).then(([b,r])=>{_bh=b;_rh=r;_al=false;}).catch(()=>{_al=false;});}

function playHit(power=1){
  try{
    const ac=getAudio();
    if(!_bh){_load();return;}
    const src=ac.createBufferSource();src.buffer=_bh;
    src.playbackRate.value=0.95+power*0.12;
    const g=ac.createGain();g.gain.value=0.5+power*0.6;
    src.connect(g);g.connect(ac.destination);src.start();
  }catch(e){}
}

function playCollision(speed=1){
  try{
    const ac=getAudio();
    if(!_bh){_load();return;}
    const src=ac.createBufferSource();src.buffer=_bh;
    src.playbackRate.value=0.88+speed*0.18;
    const g=ac.createGain();g.gain.value=0.5+speed*0.5;
    src.connect(g);g.connect(ac.destination);src.start();
  }catch(e){}
}

function playPocket(){
  try{
    const ac=getAudio();
    const dur=0.35;
    const buf=ac.createBuffer(1,ac.sampleRate*dur,ac.sampleRate);
    const d=buf.getChannelData(0);
    for(let i=0;i<d.length;i++){
      const t=i/ac.sampleRate;
      // thump
      d[i]=Math.sin(2*Math.PI*(120-t*80)*t)*Math.exp(-t*12)*0.7;
      // rattle
      d[i]+=(Math.random()*2-1)*Math.exp(-t*20)*0.3;
    }
    const src=ac.createBufferSource();src.buffer=buf;
    const gain=ac.createGain();gain.gain.value=0.9;
    src.connect(gain);gain.connect(ac.destination);src.start();
  }catch(e){}
}

function playVictory(){
  try{
    const ac=getAudio();
    const notes=[523,659,784,1047];
    notes.forEach((freq,i)=>{
      const osc=ac.createOscillator();
      const gain=ac.createGain();
      osc.frequency.value=freq;
      osc.type='triangle';
      gain.gain.setValueAtTime(0,ac.currentTime+i*0.12);
      gain.gain.linearRampToValueAtTime(0.3,ac.currentTime+i*0.12+0.04);
      gain.gain.exponentialRampToValueAtTime(0.001,ac.currentTime+i*0.12+0.4);
      osc.connect(gain);gain.connect(ac.destination);
      osc.start(ac.currentTime+i*0.12);
      osc.stop(ac.currentTime+i*0.12+0.5);
    });
  }catch(e){}
}

const _RBR='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9//1//P/8f/v/+3/6//p/+f/5f/j/+H/4P/e/9z/2//Z/9f/1v/U/9P/0f/Q/8//zf/M/8v/yv/J/8j/x//G/8X/xP/D/8L/wf/B/8D/wP+//7//vv++/77/vf+9/73/vf+9/73/vf+9/73/vf+9/77/vv++/7//v//A/8D/wf/C/8L/w//E/8X/xv/G/8f/yP/J/8r/y//N/87/z//Q/9H/0//U/9X/1//Y/9n/2//c/97/3//g/+L/4//l/+f/6P/q/+v/7f/u//D/8v/z//X/9v/4//n/+//9//7/AAAAAAIAAwAFAAYACAAJAAsADAAOAA8AEQASABMAFQAWABcAGQAaABsAHAAdAB8AIAAhACIAIwAkACUAJgAnACcAKAApACoAKgArACwALAAtAC0ALgAuAC8ALwAwADAAMAAwADEAMQAxADEAMQAxADEAMQAxADEAMAAwADAAMAAvAC8ALwAuAC4ALQAtACwALAArACsAKgApACkAKAAnACYAJQAlACQAIwAiACEAIAAfAB4AHQAcABsAGgAZABgAFwAWABUAFAASABEAEAAPAA4ADQAMAAoACQAIAAcABgAFAAQAAgABAAAAAAD///7//f/7//r/+f/4//f/9v/1//T/8//y//H/8P/v/+7/7f/s/+z/6//q/+n/6P/o/+f/5v/l/+X/5P/j/+P/4v/i/+H/4f/g/+D/3//f/9//3v/e/97/3v/d/93/3f/d/93/3f/c/9z/3P/c/93/3f/d/93/3f/d/93/3v/e/97/3v/f/9//3//g/+D/4f/h/+L/4v/j/+P/5P/k/+X/5f/m/+f/5//o/+n/6f/q/+v/7P/s/+3/7v/v/+//8P/x//L/8//z//T/9f/2//f/+P/4//n/+v/7//z//f/+//7///8AAAAAAQACAAIAAwAEAAUABgAGAAcACAAJAAkACgALAAsADAANAA0ADgAPAA8AEAARABEAEgASABMAEwAUABQAFQAVABUAFgAWABcAFwAXABgAGAAYABgAGQAZABkAGQAZABkAGgAaABoAGgAaABoAGgAaABoAGgAaABkAGQAZABkAGQAZABgAGAAYABgAFwAXABcAFgA=';
let _rbr=null,_rbl=false;
function _lrbr(){if(_rbl||_rbr)return;_rbl=true;const ac=getAudio();_dw(_RBR,ac).then(b=>{_rbr=b;_rbl=false;}).catch(()=>{_rbl=false;});}
function playRailHit(){
  try{
    const ac=getAudio();
    if(!_rbr){_lrbr();return;}
    const src=ac.createBufferSource();src.buffer=_rbr;
    const g=ac.createGain();g.gain.value=0.65;
    src.connect(g);g.connect(ac.destination);src.start();
  }catch(e){}
}

