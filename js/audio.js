// ═══════════════════════════
// MUSIC PLAYER (MP3)
// ═══════════════════════════
const _TRACKS = [
  'audio/Side Pocket Blue.mp3',
  'audio/Side Pocket Blue (1).mp3'
];

let _trackIdx  = 0;
let _audio     = null;
let _musicOn   = false;
let _volume    = 0.5;

function _initAudio() {
  if (_audio) return;
  _audio = new Audio();
  _audio.volume = _volume;
  _audio.addEventListener('ended', () => {
    if (!_musicOn) return;
    _trackIdx = (_trackIdx + 1) % _TRACKS.length;
    _audio.src = _TRACKS[_trackIdx];
    _audio.play().catch(() => {});
  });
}

function startMusic() {
  if (_musicOn) return;
  _initAudio();
  _audio.src = _TRACKS[_trackIdx];
  _audio.volume = _volume;
  _musicOn = true;
  _audio.play().catch(() => {});
  _setBtns('♪ ON');
}

function stopMusic() {
  _musicOn = false;
  if (_audio) { _audio.pause(); _audio.currentTime = 0; }
  _setBtns('♪ OFF');
}

function toggleMusic() {
  if (_musicOn) stopMusic(); else startMusic();
}

function setMusicVolume(v) {
  _volume = Math.max(0, Math.min(1, Number(v)));
  if (_audio) _audio.volume = _volume;
}

function _setBtns(label) {
  const b1 = document.getElementById('btnMusic');
  const b2 = document.getElementById('btnMusicNav');
  if (b1) b1.textContent = label;
  if (b2) b2.textContent = label;
}

// ── Sound effect stubs (called from game.js) ─────────────────────────────
function _load() {}
function playHit() {}
function playCollision() {}
function playPocket() {}
function playVictory() {}
