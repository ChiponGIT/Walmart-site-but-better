/* NEON MIXER — Web Audio 2-deck mixer + master chain
   - Crossfader (equal-power)
   - 10-band EQ + 3-band parametric EQ
   - HPF/LPF + Bass boost
   - Delay + Reverb (generated impulse)
   - Stereo width + saturation
   - Compressor + limiter-like ceiling
   - Record master output (MediaRecorder)
*/

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const setStatus = (t) => statusEl.textContent = t;

const fmtTime = (sec) => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
};

let ctx = null;
let masterOut = null;
let recorder = null;
let recordedChunks = [];
let recordingUrl = null;

function ensureAudio() {
  if (ctx) return true;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  setStatus("audio context created");
  return true;
}

function dbToGain(db){ return Math.pow(10, db/20); }
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }

// ----- Deck helper -----
function makeDeck(label) {
  const deck = {
    label,
    fileEl: $(label === "A" ? "fileA" : "fileB"),
    playBtn: $(label === "A" ? "playA" : "playB"),
    pauseBtn: $(label === "A" ? "pauseA" : "pauseB"),
    stopBtn: $(label === "A" ? "stopA" : "stopB"),
    gainEl: $(label === "A" ? "gainA" : "gainB"),
    panEl:  $(label === "A" ? "panA"  : "panB"),
    rateEl: $(label === "A" ? "rateA" : "rateB"),
    gainVal: $(label === "A" ? "gainAVal" : "gainBVal"),
    panVal:  $(label === "A" ? "panAVal"  : "panBVal"),
    rateVal: $(label === "A" ? "rateAVal" : "rateBVal"),
    meterEl: $(label === "A" ? "meterA" : "meterB"),
    timeEl:  $(label === "A" ? "timeA"  : "timeB"),
    buffer: null,
    src: null,
    startedAt: 0,
    pausedAt: 0,
    isPlaying: false,

    // nodes
    inputGain: null,
    panner: null,
    deckGainToXFader: null,
    analyser: null
  };

  function buildNodes() {
    deck.inputGain = ctx.createGain();
    deck.panner = ctx.createStereoPanner();
    deck.deckGainToXFader = ctx.createGain();
    deck.analyser = ctx.createAnalyser();
    deck.analyser.fftSize = 2048;

    deck.inputGain.connect(deck.panner);
    deck.panner.connect(deck.deckGainToXFader);
    deck.deckGainToXFader.connect(deck.analyser);
    // deck.analyser connects later into the crossfader mix bus
  }

  function stopInternal() {
    if (deck.src) {
      try { deck.src.stop(); } catch {}
      try { deck.src.disconnect(); } catch {}
      deck.src = null;
    }
    deck.isPlaying = false;
    deck.startedAt = 0;
    deck.pausedAt = 0;
  }

  function currentTime() {
    if (!deck.buffer) return 0;
    if (!deck.isPlaying) return deck.pausedAt;
    return (ctx.currentTime - deck.startedAt) * deck.rateEl.value + deck.pausedAt;
  }

  function updateTimeUI() {
    const cur = currentTime();
    const dur = deck.buffer ? deck.buffer.duration : 0;
    deck.timeEl.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  }

  async function loadFile(file) {
    if (!file) return;
    ensureAudio();
    const arr = await file.arrayBuffer();
    deck.buffer = await ctx.decodeAudioData(arr);
    deck.pausedAt = 0;
    deck.startedAt = 0;
    deck.isPlaying = false;
    updateTimeUI();
    setStatus(`loaded ${label}: ${file.name}`);
  }

  function play() {
    if (!ctx) return setStatus("press Start Audio first");
    if (!deck.buffer) return setStatus(`load a file on Deck ${label}`);
    if (deck.isPlaying) return;

    const src = ctx.createBufferSource();
    src.buffer = deck.buffer;
    src.playbackRate.value = Number(deck.rateEl.value);

    src.connect(deck.inputGain);

    deck.src = src;
    deck.startedAt = ctx.currentTime;
    deck.isPlaying = true;

    const offset = clamp(deck.pausedAt, 0, deck.buffer.duration);
    src.start(0, offset);

    src.onended = () => {
      if (deck.isPlaying) {
        deck.isPlaying = false;
        deck.pausedAt = 0;
        updateTimeUI();
      }
    };

    setStatus(`playing Deck ${label}`);
  }

  function pause() {
    if (!deck.isPlaying) return;
    deck.pausedAt = currentTime();
    stopInternal();
    updateTimeUI();
    setStatus(`paused Deck ${label}`);
  }

  function stop() {
    deck.pausedAt = 0;
    stopInternal();
    updateTimeUI();
    setStatus(`stopped Deck ${label}`);
  }

  function bindUI() {
    deck.fileEl.addEventListener("change", (e) => loadFile(e.target.files[0]));

    deck.playBtn.addEventListener("click", async () => {
      ensureAudio();
      if (ctx.state === "suspended") await ctx.resume();
      play();
    });
    deck.pauseBtn.addEventListener("click", pause);
    deck.stopBtn.addEventListener("click", stop);

    const syncVals = () => {
      deck.gainVal.textContent = Number(deck.gainEl.value).toFixed(2);
      deck.panVal.textContent = Number(deck.panEl.value).toFixed(2);
      deck.rateVal.textContent = Number(deck.rateEl.value).toFixed(2);

      if (deck.inputGain) deck.inputGain.gain.value = Number(deck.gainEl.value);
      if (deck.panner) deck.panner.pan.value = Number(deck.panEl.value);
      if (deck.src) deck.src.playbackRate.value = Number(deck.rateEl.value);

      updateTimeUI();
    };

    [deck.gainEl, deck.panEl, deck.rateEl].forEach(el => el.addEventListener("input", syncVals));
    syncVals();
  }

  deck.buildNodes = buildNodes;
  deck.bindUI = bindUI;
  deck.updateTimeUI = updateTimeUI;
  deck.currentTime = currentTime;

  return deck;
}

// ----- Master chain -----
const EQ10_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const Master = {
  // mixing + nodes
  mixBus: null,
  xGainA: null,
  xGainB: null,

  eq10: [],
  peq: { b1:null, b2:null, b3:null },
  hpf: null,
  lpf: null,
  bass: null,

  delay: null,
  delayFb: null,
  delayMix: null,
  delayWet: null,
  delayDry: null,

  convolver: null,
  revMix: null,
  revWet: null,
  revDry: null,

  widthSplitter: null,
  widthMerger: null,
  widthMid: null,
  widthSide: null,

  sat: null,

  compressor: null,
  makeup: null,

  limiterDrive: null,
  limiter: null, // dynamics compressor configured as limiter
  ceiling: null,

  masterGain: null,

  analyserM: null
};

function makeImpulse(seconds = 2.2, decay = 2.0) {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const ir = ctx.createBuffer(2, length, rate);
  for (let ch=0; ch<2; ch++){
    const data = ir.getChannelData(ch);
    for (let i=0; i<length; i++){
      const t = i / length;
      data[i] = (Math.random()*2-1) * Math.pow(1 - t, decay);
    }
  }
  return ir;
}

function buildMasterChain(deckA, deckB) {
  Master.mixBus = ctx.createGain();

  // Crossfader gains
  Master.xGainA = ctx.createGain();
  Master.xGainB = ctx.createGain();

  // Deck analyser output -> xfade gains -> mixBus
  deckA.analyser.connect(Master.xGainA);
  deckB.analyser.connect(Master.xGainB);
  Master.xGainA.connect(Master.mixBus);
  Master.xGainB.connect(Master.mixBus);

  // 10-band EQ
  let node = Master.mixBus;
  Master.eq10 = EQ10_FREQS.map((f) => {
    const biq = ctx.createBiquadFilter();
    biq.type = "peaking";
    biq.frequency.value = f;
    biq.Q.value = 1.1;
    biq.gain.value = 0;
    node.connect(biq);
    node = biq;
    return biq;
  });

  // Parametric EQ 3 bands
  Master.peq.b1 = ctx.createBiquadFilter();
  Master.peq.b2 = ctx.createBiquadFilter();
  Master.peq.b3 = ctx.createBiquadFilter();
  [Master.peq.b1, Master.peq.b2, Master.peq.b3].forEach((b) => {
    b.type = "peaking";
    b.gain.value = 0;
    b.Q.value = 1;
  });
  Master.peq.b1.frequency.value = 120;
  Master.peq.b2.frequency.value = 1200;
  Master.peq.b3.frequency.value = 8000;

  node.connect(Master.peq.b1); node = Master.peq.b1;
  node.connect(Master.peq.b2); node = Master.peq.b2;
  node.connect(Master.peq.b3); node = Master.peq.b3;

  // HPF / LPF
  Master.hpf = ctx.createBiquadFilter();
  Master.hpf.type = "highpass";
  Master.hpf.frequency.value = 20;
  Master.hpf.Q.value = 0.707;

  Master.lpf = ctx.createBiquadFilter();
  Master.lpf.type = "lowpass";
  Master.lpf.frequency.value = 20000;
  Master.lpf.Q.value = 0.707;

  node.connect(Master.hpf); node = Master.hpf;
  node.connect(Master.lpf); node = Master.lpf;

  // Bass shelf
  Master.bass = ctx.createBiquadFilter();
  Master.bass.type = "lowshelf";
  Master.bass.frequency.value = 90;
  Master.bass.gain.value = 0;
  node.connect(Master.bass); node = Master.bass;

  // Stereo width (mid/side)
  Master.widthSplitter = ctx.createChannelSplitter(2);
  Master.widthMerger = ctx.createChannelMerger(2);
  Master.widthMid = ctx.createGain();
  Master.widthSide = ctx.createGain();

  // L/R -> mid/side approx:
  // mid = (L+R)/2 ; side = (L-R)/2
  // We'll do: split L/R, then route into mid and side using gains + invert one path.
  const l = ctx.createGain();
  const r = ctx.createGain();
  const rInv = ctx.createGain();
  rInv.gain.value = -1;

  node.connect(Master.widthSplitter);
  Master.widthSplitter.connect(l, 0);
  Master.widthSplitter.connect(r, 1);

  r.connect(rInv);

  // mid
  l.connect(Master.widthMid);
  r.connect(Master.widthMid);

  // side
  l.connect(Master.widthSide);
  rInv.connect(Master.widthSide);

  // back to L/R:
  // L = mid + side ; R = mid - side
  const sideInv = ctx.createGain();
  sideInv.gain.value = -1;

  Master.widthSide.connect(sideInv);

  // L
  Master.widthMid.connect(Master.widthMerger, 0, 0);
  Master.widthSide.connect(Master.widthMerger, 0, 0);
  // R
  Master.widthMid.connect(Master.widthMerger, 0, 1);
  sideInv.connect(Master.widthMerger, 0, 1);

  node = Master.widthMerger;

  // Saturation (waveshaper)
  Master.sat = ctx.createWaveShaper();
  Master.sat.oversample = "4x";
  node.connect(Master.sat); node = Master.sat;

  // Delay send
  Master.delay = ctx.createDelay(1.5);
  Master.delay.delayTime.value = 0;
  Master.delayFb = ctx.createGain();
  Master.delayFb.gain.value = 0;
  Master.delayMix = ctx.createGain();
  Master.delayMix.gain.value = 0;

  Master.delayWet = ctx.createGain();
  Master.delayDry = ctx.createGain();
  Master.delayWet.gain.value = 0;
  Master.delayDry.gain.value = 1;

  // route delay loop
  Master.delay.connect(Master.delayFb);
  Master.delayFb.connect(Master.delay);

  // split dry/wet
  node.connect(Master.delayDry);
  node.connect(Master.delay);
  Master.delay.connect(Master.delayWet);

  // sum dry+wet
  const afterDelay = ctx.createGain();
  Master.delayDry.connect(afterDelay);
  Master.delayWet.connect(afterDelay);
  node = afterDelay;

  // Reverb (convolver) send
  Master.convolver = ctx.createConvolver();
  Master.convolver.buffer = makeImpulse(2.2, 2.0);

  Master.revWet = ctx.createGain();
  Master.revDry = ctx.createGain();
  Master.revWet.gain.value = 0;
  Master.revDry.gain.value = 1;

  node.connect(Master.revDry);
  node.connect(Master.convolver);
  Master.convolver.connect(Master.revWet);

  const afterRev = ctx.createGain();
  Master.revDry.connect(afterRev);
  Master.revWet.connect(afterRev);
  node = afterRev;

  // Compressor
  Master.compressor = ctx.createDynamicsCompressor();
  Master.compressor.threshold.value = -18;
  Master.compressor.ratio.value = 4;
  Master.compressor.attack.value = 0.01;
  Master.compressor.release.value = 0.25;

  node.connect(Master.compressor); node = Master.compressor;

  // Makeup gain
  Master.makeup = ctx.createGain();
  Master.makeup.gain.value = 1;
  node.connect(Master.makeup); node = Master.makeup;

  // Limiter drive + limiter
  Master.limiterDrive = ctx.createGain();
  Master.limiterDrive.gain.value = 1;

  Master.limiter = ctx.createDynamicsCompressor();
  Master.limiter.threshold.value = -1;
  Master.limiter.ratio.value = 20;
  Master.limiter.attack.value = 0.003;
  Master.limiter.release.value = 0.12;

  node.connect(Master.limiterDrive);
  Master.limiterDrive.connect(Master.limiter);
  node = Master.limiter;

  // Ceiling (post limiter)
  Master.ceiling = ctx.createGain();
  Master.ceiling.gain.value = dbToGain(-1);
  node.connect(Master.ceiling); node = Master.ceiling;

  // Master output gain
  Master.masterGain = ctx.createGain();
  Master.masterGain.gain.value = 1;
  node.connect(Master.masterGain);

  // Master analyser + destination
  Master.analyserM = ctx.createAnalyser();
  Master.analyserM.fftSize = 2048;
  Master.masterGain.connect(Master.analyserM);

  masterOut = ctx.createMediaStreamDestination();
  Master.masterGain.connect(masterOut);

  Master.masterGain.connect(ctx.destination);
}

// ----- UI: Tabs (slide transitions) -----
function setupTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));
  const line = document.querySelector(".tabLine");

  function moveLine(btn){
    const r = btn.getBoundingClientRect();
    const pr = btn.parentElement.getBoundingClientRect();
    const x = r.left - pr.left;
    line.style.transform = `translateX(${x}px)`;
    line.style.width = `${r.width}px`;
  }

  tabs.forEach(btn => {
    btn.addEventListener("click", () => {
      tabs.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      moveLine(btn);

      const name = btn.dataset.tab;
      document.querySelectorAll(".tabPage").forEach(p => p.classList.remove("show"));
      const page = $(`tab-${name}`);
      page.classList.add("show");
    });
  });

  // init
  moveLine(document.querySelector(".tab.active"));
  window.addEventListener("resize", () => moveLine(document.querySelector(".tab.active")));
}

// ----- EQ UI builder -----
function setupEQ10UI() {
  const wrap = $("eq10");
  wrap.innerHTML = "";
  EQ10_FREQS.forEach((f, i) => {
    const col = document.createElement("div");
    col.className = "eqCol";
    col.innerHTML = `
      <div class="eqDb" id="eqDb${i}">0.0dB</div>
      <input type="range" min="-24" max="24" value="0" step="0.1" id="eq${i}">
      <div class="eqHz">${f < 1000 ? f+"Hz" : (f/1000)+"k"}</div>
    `;
    wrap.appendChild(col);

    const slider = col.querySelector(`#eq${i}`);
    const db = col.querySelector(`#eqDb${i}`);

    slider.addEventListener("input", () => {
      const v = Number(slider.value);
      db.textContent = `${v.toFixed(1)}dB`;
      if (Master.eq10[i]) Master.eq10[i].gain.value = v;
    });
  });

  const setPreset = (arr) => arr.forEach((v,i) => {
    const s = $(`eq${i}`);
    const db = $(`eqDb${i}`);
    s.value = v;
    db.textContent = `${Number(v).toFixed(1)}dB`;
    if (Master.eq10[i]) Master.eq10[i].gain.value = Number(v);
  });

  $("eqFlat").addEventListener("click", ()=> setPreset([0,0,0,0,0,0,0,0,0,0]));
  $("eqSmile").addEventListener("click", ()=> setPreset([5,4,2,0,-2,-1,0,2,4,5]));
  $("eqBass").addEventListener("click", ()=> setPreset([8,6,4,2,0,-1,-1,0,1,2]));
  $("eqVocal").addEventListener("click", ()=> setPreset([-2,-1,0,2,4,4,2,0,-1,-2]));
}

// ----- Sliders wiring -----
function bindMasterControls() {
  // HPF/LPF/Bass
  const bind = (id, cb, fmt = (x)=>x) => {
    const el = $(id);
    const val = $(`${id}Val`);
    const sync = () => { val.textContent = fmt(Number(el.value)); cb(Number(el.value)); };
    el.addEventListener("input", sync);
    sync();
  };

  bind("hpf", (v)=> Master.hpf && (Master.hpf.frequency.value = v), (v)=> `${Math.round(v)}Hz`);
  bind("lpf", (v)=> Master.lpf && (Master.lpf.frequency.value = v), (v)=> `${Math.round(v)}Hz`);
  bind("bass",(v)=> Master.bass && (Master.bass.gain.value = v), (v)=> `${v.toFixed(1)}dB`);

  // Delay
  bind("delayTime",(v)=> Master.delay && (Master.delay.delayTime.value = v), (v)=> `${v.toFixed(3)}s`);
  bind("delayFb",(v)=> Master.delayFb && (Master.delayFb.gain.value = v), (v)=> `${v.toFixed(3)}`);
  bind("delayMix",(v)=>{
    if (!Master.delayWet || !Master.delayDry) return;
    Master.delayWet.gain.value = v;
    Master.delayDry.gain.value = 1 - v;
  }, (v)=> `${v.toFixed(3)}`);

  // Reverb
  bind("revSize",(v)=>{
    if (!Master.convolver) return;
    Master.convolver.buffer = makeImpulse(v, 2.0);
  }, (v)=> `${v.toFixed(1)}s`);

  bind("revMix",(v)=>{
    if (!Master.revWet || !Master.revDry) return;
    Master.revWet.gain.value = v;
    Master.revDry.gain.value = 1 - v;
  }, (v)=> `${v.toFixed(3)}`);

  // Width + saturation
  bind("width",(v)=>{
    if (!Master.widthSide || !Master.widthMid) return;
    // width: 0..2 -> side gain
    Master.widthSide.gain.value = v;
    Master.widthMid.gain.value = 1;
  }, (v)=> `${v.toFixed(2)}`);

  bind("sat",(v)=>{
    if (!Master.sat) return;
    Master.sat.curve = makeSaturationCurve(v);
  }, (v)=> `${v.toFixed(3)}`);

  // Compressor
  bind("compThresh",(v)=> Master.compressor && (Master.compressor.threshold.value = v), (v)=> `${v.toFixed(1)}dB`);
  bind("compRatio",(v)=> Master.compressor && (Master.compressor.ratio.value = v), (v)=> `${v.toFixed(1)}:1`);
  bind("compAtk",(v)=> Master.compressor && (Master.compressor.attack.value = v), (v)=> `${v.toFixed(3)}s`);
  bind("compRel",(v)=> Master.compressor && (Master.compressor.release.value = v), (v)=> `${v.toFixed(3)}s`);
  bind("makeup",(v)=> Master.makeup && (Master.makeup.gain.value = dbToGain(v)), (v)=> `${v.toFixed(1)}dB`);

  // Limiter / master
  bind("ceil",(v)=> {
    if (!Master.ceiling || !Master.limiter) return;
    Master.ceiling.gain.value = dbToGain(v);
    Master.limiter.threshold.value = v; // push threshold to ceiling for behavior
  }, (v)=> `${v.toFixed(1)}dB`);

  bind("limDrive",(v)=> Master.limiterDrive && (Master.limiterDrive.gain.value = dbToGain(v)), (v)=> `${v.toFixed(1)}dB`);
  bind("master",(v)=> Master.masterGain && (Master.masterGain.gain.value = v), (v)=> `${v.toFixed(2)}`);

  // Parametric EQ
  const bindPEQ = (n) => {
    const f = $(`p${n}Freq`), g = $(`p${n}Gain`), q = $(`p${n}Q`);
    const fv = $(`p${n}FreqVal`), gv = $(`p${n}GainVal`), qv = $(`p${n}QVal`);
    const band = Master.peq[`b${n}`];

    const sync = () => {
      const freq = Number(f.value);
      const gain = Number(g.value);
      const Q = Number(q.value);

      fv.textContent = `${Math.round(freq)}Hz`;
      gv.textContent = `${gain.toFixed(1)}dB`;
      qv.textContent = `${Q.toFixed(1)}`;

      if (band){
        band.frequency.value = freq;
        band.gain.value = gain;
        band.Q.value = Q;
      }
    };
    [f,g,q].forEach(el => el.addEventListener("input", sync));
    sync();
  };
  bindPEQ(1); bindPEQ(2); bindPEQ(3);
}

function makeSaturationCurve(amount){
  const n = 2048;
  const curve = new Float32Array(n);
  const k = amount * 40; // intensity
  for (let i=0;i<n;i++){
    const x = (i*2/n) - 1;
    curve[i] = (1 + k) * x / (1 + k * Math.abs(x)); // soft clip
  }
  return curve;
}

// ----- Crossfader -----
function setCrossfader(x){
  // equal-power crossfade
  const a = Math.cos(x * 0.5 * Math.PI);
  const b = Math.cos((1 - x) * 0.5 * Math.PI);
  if (Master.xGainA) Master.xGainA.gain.value = a;
  if (Master.xGainB) Master.xGainB.gain.value = b;
  $("xfVal").textContent = x.toFixed(2);
}

function setupCrossfaderUI(){
  const x = $("xfader");
  const sync = () => setCrossfader(Number(x.value));
  x.addEventListener("input", sync);
  sync();
}

// ----- Metering -----
function meterFromAnalyser(analyser){
  const arr = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(arr);
  let sum = 0;
  for (let i=0;i<arr.length;i++){
    const v = (arr[i] - 128) / 128;
    sum += v*v;
  }
  const rms = Math.sqrt(sum / arr.length);
  const db = 20 * Math.log10(rms || 1e-8);
  return { rms, db };
}

function startMeters(deckA, deckB){
  const meterM = $("meterM");
  const dbM = $("dbM");

  function tick(){
    if (ctx && deckA.analyser && deckB.analyser && Master.analyserM){
      const a = meterFromAnalyser(deckA.analyser);
      const b = meterFromAnalyser(deckB.analyser);
      const m = meterFromAnalyser(Master.analyserM);

      deckA.meterEl.style.width = `${clamp(a.rms*140, 0, 100)}%`;
      deckB.meterEl.style.width = `${clamp(b.rms*140, 0, 100)}%`;
      meterM.style.width = `${clamp(m.rms*140, 0, 100)}%`;

      dbM.textContent = (m.db <= -80) ? "-∞ dB" : `${m.db.toFixed(1)} dB`;
    }

    if (deckA) deckA.updateTimeUI();
    if (deckB) deckB.updateTimeUI();

    requestAnimationFrame(tick);
  }
  tick();
}

// ----- Recording -----
function setupRecording(){
  const btnRecord = $("btnRecord");
  const btnDownload = $("btnDownload");

  btnRecord.addEventListener("click", async () => {
    ensureAudio();
    if (ctx.state === "suspended") await ctx.resume();
    if (!masterOut) return setStatus("audio not ready yet");

    if (!recorder || recorder.state === "inactive"){
      recordedChunks = [];
      if (recordingUrl){
        URL.revokeObjectURL(recordingUrl);
        recordingUrl = null;
      }

      recorder = new MediaRecorder(masterOut.stream, { mimeType: "audio/webm" });
      recorder.ondataavailable = (e) => { if (e.data.size) recordedChunks.push(e.data); };
      recorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: "audio/webm" });
        recordingUrl = URL.createObjectURL(blob);
        btnDownload.href = recordingUrl;
        btnDownload.setAttribute("aria-disabled", "false");
        btnDownload.removeAttribute("disabled");
        setStatus("recording stopped — ready to download");
      };

      recorder.start();
      btnRecord.textContent = "■ Stop";
      btnRecord.classList.add("hot");
      setStatus("recording…");
    } else {
      recorder.stop();
      btnRecord.textContent = "● Record";
      btnRecord.classList.remove("hot");
    }
  });
}

// ----- Reset -----
function hardReset(deckA, deckB){
  // reset UI sliders + stop audio
  deckA.stopBtn.click();
  deckB.stopBtn.click();

  // EQ flat
  if (Master.eq10?.length){
    EQ10_FREQS.forEach((_,i)=>{
      const s = $(`eq${i}`), db = $(`eqDb${i}`);
      if (s && db){
        s.value = 0; db.textContent = "0.0dB";
        Master.eq10[i].gain.value = 0;
      }
    });
  }

  $("xfader").value = 0.5; setCrossfader(0.5);

  // Master sliders quick defaults
  const set = (id,val) => { const el=$(id); if(el){ el.value = val; el.dispatchEvent(new Event("input")); } };
  set("hpf", 20);
  set("lpf", 20000);
  set("bass", 0);
  set("delayTime", 0);
  set("delayFb", 0);
  set("delayMix", 0);
  set("revSize", 2.2);
  set("revMix", 0);
  set("width", 1);
  set("sat", 0);
  set("compThresh", -18);
  set("compRatio", 4);
  set("compAtk", 0.01);
  set("compRel", 0.25);
  set("makeup", 0);
  set("ceil", -1);
  set("limDrive", 0);
  set("master", 1);

  set("p1Freq", 120); set("p1Gain", 0); set("p1Q", 1);
  set("p2Freq", 1200); set("p2Gain", 0); set("p2Q", 1);
  set("p3Freq", 8000); set("p3Gain", 0); set("p3Q", 1);

  setStatus("reset done");
}

// ----- App init -----
function init(){
  setupTabs();

  const deckA = makeDeck("A");
  const deckB = makeDeck("B");

  $("btnAudio").addEventListener("click", async () => {
    ensureAudio();
    await ctx.resume();

    // Build nodes once
    if (!deckA.inputGain){
      deckA.buildNodes();
      deckB.buildNodes();
      buildMasterChain(deckA, deckB);

      // connect deck gain nodes to analyser inputs
      // (already: inputGain -> panner -> deckGainToXFader -> analyser)
      // now set initial gain/pan/rate from UI
      deckA.bindUI();
      deckB.bindUI();

      setupEQ10UI();
      bindMasterControls();
      setupCrossfaderUI();
      setupRecording();
      startMeters(deckA, deckB);

      // start default xfade
      setCrossfader(Number($("xfader").value));

      setStatus("audio started");
    } else {
      setStatus("audio already running");
    }
  });

  // Reset
  $("btnReset").addEventListener("click", ()=> hardReset(deckA, deckB));

  // Crossfader wiring needs nodes ready; still updates label early
  $("xfader").addEventListener("input", () => {
    $("xfVal").textContent = Number($("xfader").value).toFixed(2);
  });

  setStatus("idle");
}

init();
