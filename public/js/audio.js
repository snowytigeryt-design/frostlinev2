// All sound is synthesised with WebAudio — no audio files needed.
export class Sfx {
  constructor() {
    this.ctx = null;
    this.lx = 0; this.ly = 0; this.lz = 0; // listener position
    this.volume = 0.8;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const c = (this.ctx = new AC());

    this.master = c.createGain();
    this.master.gain.value = this.volume;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.master.connect(comp);
    comp.connect(c.destination);

    // 2 s of white noise, reused by every effect
    const len = c.sampleRate * 2;
    this.noise = c.createBuffer(1, len, c.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) nd[i] = Math.random() * 2 - 1;

    // reverb: a decaying noise impulse = open snowy valley slap-back
    const rl = Math.floor(c.sampleRate * 2.0);
    const ir = c.createBuffer(2, rl, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < rl; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / rl, 3.4);
    }
    this.rev = c.createConvolver();
    this.rev.buffer = ir;
    const revOut = c.createGain();
    revOut.gain.value = 0.32;
    this.rev.connect(revOut);
    revOut.connect(this.master);

    this._startWind();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  setListener(pos, fwd) {
    this.lx = pos.x; this.ly = pos.y; this.lz = pos.z;
    if (!this.ctx) return;
    const l = this.ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
      l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z;
      l.upX.value = 0; l.upY.value = 1; l.upZ.value = 0;
    } else if (l.setPosition) {
      l.setPosition(pos.x, pos.y, pos.z);
      l.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
  }

  _dist(pos) {
    const dx = pos.x - this.lx, dy = pos.y - this.ly, dz = pos.z - this.lz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // Returns a GainNode to connect a sound source to. With `pos` the sound is
  // 3D-positioned and low-passed by distance; without, it plays "in your head".
  _route(pos, reverbSend, level) {
    const c = this.ctx;
    const inp = c.createGain();
    inp.gain.value = level == null ? 1 : level;
    if (pos) {
      const d = this._dist(pos);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.max(900, 18000 / (1 + d / 16));
      const pan = c.createPanner();
      pan.panningModel = 'equalpower';
      pan.distanceModel = 'inverse';
      pan.refDistance = 6;
      pan.rolloffFactor = 1.25;
      pan.maxDistance = 600;
      if (pan.positionX) {
        pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z;
      } else {
        pan.setPosition(pos.x, pos.y, pos.z);
      }
      inp.connect(lp); lp.connect(pan); pan.connect(this.master);
      if (reverbSend) pan.connect(this.rev);
    } else {
      inp.connect(this.master);
      if (reverbSend) inp.connect(this.rev);
    }
    return inp;
  }

  _noise(out, t, dur, type, f0, f1, g0, offset) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(g0, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(t, offset == null ? Math.random() * 1.5 : offset);
    src.stop(t + dur + 0.02);
  }

  _tone(out, t, dur, f0, f1, g0, type) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(g0, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(out);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  shot(pos) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const own = !pos;
    const out = this._route(pos, true, own ? 0.95 : 1.4);
    this._noise(out, t, 0.08, 'highpass', 1400, 1400, 1.0);          // crack
    this._noise(out, t, 0.28, 'lowpass', 6000, 260, 0.9);            // blast
    this._noise(out, t + 0.01, 0.5, 'lowpass', 900, 120, 0.45);      // rumble
    this._tone(out, t, 0.2, 170, 40, 1.1);                           // thump
  }

  footstep(pos, vol) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const out = this._route(pos, false, (vol == null ? 0.35 : vol) * (0.8 + Math.random() * 0.4));
    this._noise(out, t, 0.09, 'bandpass', 1800 + Math.random() * 1200, 900, 0.9);
    this._noise(out, t + 0.035, 0.07, 'bandpass', 3200, 2200, 0.5);
  }

  reload() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const out = this._route(null, false, 0.7);
    this._noise(out, t + 0.25, 0.04, 'bandpass', 2200, 1200, 0.9);             // mag out
    this._tone(out, t + 0.25, 0.05, 220, 120, 0.4, 'square');
    this._noise(out, t + 1.05, 0.05, 'bandpass', 2600, 1500, 0.9);             // mag in
    this._tone(out, t + 1.05, 0.06, 300, 160, 0.45, 'square');
    this._noise(out, t + 1.65, 0.06, 'bandpass', 1500, 900, 1.0);              // charging handle
    this._tone(out, t + 1.7, 0.07, 180, 90, 0.4, 'square');
  }

  empty() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this._tone(this._route(null, false, 0.5), t, 0.04, 900, 500, 0.5, 'square');
  }

  hitmarker(head, kill) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const out = this._route(null, false, 0.6);
    this._tone(out, t, 0.06, head ? 2600 : 1700, head ? 2000 : 1400, 0.6, 'triangle');
    if (kill) this._tone(out, t + 0.05, 0.18, 900, 500, 0.7, 'sine');
  }

  hurt() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const out = this._route(null, false, 0.9);
    this._tone(out, t, 0.18, 110, 50, 0.9);
    this._noise(out, t, 0.12, 'lowpass', 800, 300, 0.6);
  }

  die() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const out = this._route(null, false, 0.9);
    this._tone(out, t, 0.6, 90, 30, 1.0);
    this._noise(out, t, 0.5, 'lowpass', 600, 120, 0.6);
  }

  spawn() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const out = this._route(null, false, 0.35);
    this._tone(out, t, 0.25, 440, 880, 0.4, 'sine');
  }

  _startWind() {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.6;
    const g = c.createGain();
    g.gain.value = 0.05;
    const lfo = c.createOscillator();
    lfo.frequency.value = 0.11;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 0.03;
    lfo.connect(lfoGain);
    lfoGain.connect(g.gain);
    const lfo2 = c.createOscillator();
    lfo2.frequency.value = 0.07;
    const lfo2Gain = c.createGain();
    lfo2Gain.gain.value = 160;
    lfo2.connect(lfo2Gain);
    lfo2Gain.connect(bp.frequency);
    src.connect(bp); bp.connect(g); g.connect(this.master);
    src.start(); lfo.start(); lfo2.start();
  }
}
