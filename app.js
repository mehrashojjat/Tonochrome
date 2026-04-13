/**
 * Tonochrome — app.js
 * Color → Sound (HSL) engine using the Web Audio API.
 *
 * Architecture
 * ─────────────────────────────────────────────────────────────
 *  OscillatorNode (sine)  ──► gainOsc ──┐
 *  AudioBufferSourceNode (noise) ──► gainNoise ──┤
 *                                              masterGain ──► DynamicsCompressorNode ──► destination
 *
 * Mapping rules
 *  Hue  (0–360)  → Frequency  110–880 Hz  (logarithmic / octave-loop)
 *  Sat  (0–1)    → Noise gain  1.0–0    (inverted full range: grey=100% noise, vivid=silent)
 *  Lig  (0–1)    → Master vol  0–0.80    (linear power curve: dark=silent, bright=loud)
 *
 * The core mapping functions are pure (no DOM / Web Audio references)
 * so they can be reused in React Native or other environments.
 * ─────────────────────────────────────────────────────────────
 */

/* ============================================================
   1. AUDIO MAPPING  (pure functions, no browser dependencies)
   ============================================================ */

/**
 * Hue → Frequency
 * Logarithmic (exponential) mapping over one octave so that
 * hue 0° and 360° produce the same perceptual pitch (110 Hz).
 *
 * Formula: freq = 110 * 2^(hue/360)
 * Range: 110 Hz (hue=0) → 220 Hz (hue=360, wraps back to 110)
 * We use a 3-octave span (110–880 Hz) by scaling:
 *   freq = 110 * 2^(hue/360 * 3)
 * This keeps the full circle within a 3-octave band while
 * ensuring 0° and 360° remain perceptually equivalent.
 *
 * @param {number} hue - 0..360
 * @returns {number} frequency in Hz (110–880)
 */
function hueToFrequency(hue) {
  const OCTAVES = 3;
  const F_MIN = 110;
  return F_MIN * Math.pow(2, (hue / 360) * OCTAVES);
}

/**
 * Saturation → Noise gain (inverted, full range)
 * Low saturation (grey) = full noise (1.0); high saturation (vivid) = no noise (0).
 * Uses a square-root curve so the transition feels natural.
 *
 *   sat = 0   → noise = 1.0 (100%)
 *   sat = 1   → noise = 0
 *
 * @param {number} saturation - 0..1
 * @returns {number} noise gain 0..1.0
 */
function saturationToNoiseGain(saturation) {
  return Math.sqrt(1 - saturation);
}

/**
 * Saturation → Oscillator gain (complement of noise, full range)
 * Low saturation = noise dominant, osc silent;
 * high saturation = clean tone, osc at full volume.
 *
 *   sat = 0   → osc gain = 0
 *   sat = 1   → osc gain = 1.0
 *
 * @param {number} saturation - 0..1
 * @returns {number} oscillator gain 0..1.0
 */
function saturationToOscGain(saturation) {
  return Math.sqrt(saturation);
}

/**
 * Lightness → Master volume
 * Linear mapping: dark (L=0) is silent, bright (L=1) is loudest.
 * Uses a mild power curve for a more natural perceptual ramp.
 *
 *   L = 0   → vol = 0
 *   L = 1   → vol = MAX_VOL (0.80)
 *
 * @param {number} lightness - 0..1
 * @returns {number} master gain 0..0.80
 */
function lightnessToVolume(lightness) {
  const MAX_VOL = 0.80;
  return MAX_VOL * Math.pow(lightness, 0.7);
}

/* Bell mode harmonic partials: ratio relative to fundamental and peak gain */
const BELL_HARMONICS = [
  { ratio: 1,   gain: 1.00 }, // fundamental
  { ratio: 2,   gain: 0.50 }, // 1st overtone (octave)
  { ratio: 3,   gain: 0.20 }, // 2nd overtone
  { ratio: 4.2, gain: 0.08 }, // slightly inharmonic — gives bell/piano colour
];

/* ============================================================
   2. AUDIO ENGINE
   ============================================================ */

const AudioEngine = (() => {
  let ctx = null;
  let oscillator = null;
  let noiseSource = null;
  let gainOsc = null;
  let gainNoise = null;
  let masterGain = null;
  let compressor = null;
  let noiseBuffer = null;
  let running = false;
  let muted = false;
  let soundMode = 'synth'; // 'synth' | 'bell'
  let lastHSL = { hue: 0, saturation: 1, lightness: 0.5 };
  let harmonicOscs = [];
  let harmonicGains = []; // array of { node: GainNode, baseGain: number }

  // Ramp time for smooth parameter changes (avoids clicks/pops)
  const RAMP_TIME = 0.025; // seconds

  /**
   * Create (or resume) the AudioContext.
   * Must be called from a user-gesture handler.
   */
  function ensureContext() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === "suspended") {
      return ctx.resume();
    }
    return Promise.resolve();
  }

  /**
   * Build a 2-second pink-ish noise buffer (offline, once).
   * We use a first-order IIR approximation for pink noise:
   * each white-noise sample is weighted by a simple pole filter.
   */
  function createNoiseBuffer() {
    if (noiseBuffer) return;
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * 2; // 2 s loop
    noiseBuffer = ctx.createBuffer(1, length, sampleRate);
    const data = noiseBuffer.getChannelData(0);

    // Simple pink-noise approximation (Paul Kellett method)
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      // Normalise to approx ±1 range
      data[i] = pink * 0.11;
    }
  }

  /**
   * Build the audio graph.
   * Called once per play session.
   */
  function buildSynthGraph(hsl) {
    createNoiseBuffer();

    // Oscillator (sine — clean, neutral)
    oscillator = ctx.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = hueToFrequency(hsl.hue);

    // Noise source (looping buffer)
    noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;

    // Gain nodes
    gainOsc = ctx.createGain();
    gainOsc.gain.value = saturationToOscGain(hsl.saturation);

    gainNoise = ctx.createGain();
    gainNoise.gain.value = saturationToNoiseGain(hsl.saturation);

    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : lightnessToVolume(hsl.lightness);

    // Limiter/compressor — prevents clipping
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -6;
    compressor.knee.value = 6;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;

    // Connect graph
    oscillator.connect(gainOsc);
    noiseSource.connect(gainNoise);
    gainOsc.connect(masterGain);
    gainNoise.connect(masterGain);
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    // Start sources
    oscillator.start();
    noiseSource.start();
  }

  /**
   * Build the bell/piano audio graph using additive harmonic synthesis
   * layered with the same pink-noise path as Synth mode.
   * Saturation low  → noisy (grey, distressed bell)
   * Saturation high → clean harmonics (vivid, pure bell/piano tone)
   */
  function buildBellGraph(hsl) {
    createNoiseBuffer();

    const freq = hueToFrequency(hsl.hue);

    // Noise source (same as Synth)
    noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;

    gainNoise = ctx.createGain();
    gainNoise.gain.value = saturationToNoiseGain(hsl.saturation);

    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : lightnessToVolume(hsl.lightness);

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -6;
    compressor.knee.value = 6;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;

    noiseSource.connect(gainNoise);
    gainNoise.connect(masterGain);
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    // Additive harmonic oscillators — gain scaled by saturation
    BELL_HARMONICS.forEach((h, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * h.ratio;

      const g = ctx.createGain();
      g.gain.value = h.gain * saturationToOscGain(hsl.saturation);

      osc.connect(g);
      g.connect(masterGain);
      osc.start();

      harmonicOscs.push(osc);
      harmonicGains.push({ node: g, baseGain: h.gain });
    });

    noiseSource.start();
  }

  /**
   * Dispatch to the appropriate graph builder based on current sound mode.
   */
  function buildGraph(hsl) {
    if (soundMode === 'bell') {
      buildBellGraph(hsl);
    } else {
      buildSynthGraph(hsl);
    }
  }

  /**
   * Tear down the audio graph (stop & disconnect).
   */
  function teardownGraph() {
    if (oscillator) {
      try { oscillator.stop(); } catch (_) {}
      oscillator.disconnect();
      oscillator = null;
    }
    if (noiseSource) {
      try { noiseSource.stop(); } catch (_) {}
      noiseSource.disconnect();
      noiseSource = null;
    }
    if (gainOsc) { gainOsc.disconnect(); gainOsc = null; }
    if (gainNoise) { gainNoise.disconnect(); gainNoise = null; }
    if (masterGain) { masterGain.disconnect(); masterGain = null; }
    if (compressor) { compressor.disconnect(); compressor = null; }
    harmonicOscs.forEach(osc => {
      try { osc.stop(); } catch (_) {}
      osc.disconnect();
    });
    harmonicOscs = [];
    harmonicGains = [];
  }

  /**
   * Start audio playback.
   * @param {object} hsl - { hue, saturation, lightness }
   * @returns {Promise<void>}
   */
  async function start(hsl) {
    if (running) return;
    await ensureContext();
    buildGraph(hsl);
    lastHSL = { ...hsl };
    running = true;
  }

  /**
   * Stop audio playback.
   */
  function stop() {
    if (!running) return;
    // Fade out smoothly before stopping to avoid clicks
    if (masterGain) {
      const now = ctx.currentTime;
      masterGain.gain.setTargetAtTime(0, now, 0.03);
      setTimeout(() => {
        teardownGraph();
        running = false;
      }, 150);
    } else {
      teardownGraph();
      running = false;
    }
  }

  /**
   * Update audio parameters in real time (smooth ramps).
   * @param {object} hsl - { hue, saturation, lightness }
   */
  function update(hsl) {
    if (!running || !ctx) return;
    lastHSL = { ...hsl };
    const now = ctx.currentTime;

    if (soundMode === 'bell') {
      const freq = hueToFrequency(hsl.hue);
      const oscScale = saturationToOscGain(hsl.saturation);
      harmonicOscs.forEach((osc, i) => {
        osc.frequency.setTargetAtTime(freq * BELL_HARMONICS[i].ratio, now, RAMP_TIME);
      });
      harmonicGains.forEach(h => {
        h.node.gain.setTargetAtTime(h.baseGain * oscScale, now, RAMP_TIME);
      });
      if (gainNoise) {
        gainNoise.gain.setTargetAtTime(saturationToNoiseGain(hsl.saturation), now, RAMP_TIME);
      }
    } else {
      if (oscillator) {
        oscillator.frequency.setTargetAtTime(hueToFrequency(hsl.hue), now, RAMP_TIME);
      }
      if (gainNoise) {
        gainNoise.gain.setTargetAtTime(saturationToNoiseGain(hsl.saturation), now, RAMP_TIME);
      }
      if (gainOsc) {
        gainOsc.gain.setTargetAtTime(saturationToOscGain(hsl.saturation), now, RAMP_TIME);
      }
    }

    if (masterGain) {
      const targetVol = muted ? 0 : lightnessToVolume(hsl.lightness);
      masterGain.gain.setTargetAtTime(targetVol, now, RAMP_TIME);
    }
  }

  /**
   * Toggle mute without stopping the audio graph.
   * @param {boolean} shouldMute
   * @param {number} lightness - current lightness (0..1) to restore correct volume on unmute
   */
  function setMute(shouldMute, lightness) {
    muted = shouldMute;
    if (!masterGain || !ctx) return;
    const now = ctx.currentTime;
    const targetVol = muted ? 0 : lightnessToVolume(lightness);
    masterGain.gain.setTargetAtTime(targetVol, now, RAMP_TIME);
  }

  /**
   * Switch sound mode ('synth' | 'bell').
   * If audio is running, tears down and rebuilds the graph in the new mode.
   */
  async function setMode(mode) {
    if (mode === soundMode) return;
    soundMode = mode;
    if (running) {
      teardownGraph();
      running = false;
      await ensureContext();
      buildGraph(lastHSL);
      running = true;
    }
  }

  return { start, stop, update, setMute, setMode, get isRunning() { return running; }, get isMuted() { return muted; }, get soundMode() { return soundMode; } };
})();

/* ============================================================
   3. UI CONTROLLER
   ============================================================ */

const UI = (() => {
  // DOM references
  const hueSlider = document.getElementById("hueSlider");
  const satSlider = document.getElementById("saturationSlider");
  const ligSlider = document.getElementById("lightnessSlider");

  const hueValue = document.getElementById("hueValue");
  const satValue = document.getElementById("saturationValue");
  const ligValue = document.getElementById("lightnessValue");

  const colorSwatch = document.getElementById("colorSwatch");
  const colorLabel = document.getElementById("colorLabel");

  const playBtn = document.getElementById("playBtn");
  const muteBtn = document.getElementById("muteBtn");

  const freqDisplay = document.getElementById("freqDisplay");
  const noiseDisplay = document.getElementById("noiseDisplay");
  const volDisplay = document.getElementById("volDisplay");

  const modeSynthBtn = document.getElementById("modeSynth");
  const modeBellBtn = document.getElementById("modeBell");
  const satHint = document.getElementById("satHint");

  /**
   * Read current HSL values from sliders.
   * Returns normalised saturation and lightness (0..1).
   */
  function getHSL() {
    return {
      hue: parseInt(hueSlider.value, 10),
      saturation: parseInt(satSlider.value, 10) / 100,
      lightness: parseInt(ligSlider.value, 10) / 100,
    };
  }

  /**
   * Update swatch, label, and info display.
   */
  function updateVisuals(hsl) {
    const satPct = Math.round(hsl.saturation * 100);
    const ligPct = Math.round(hsl.lightness * 100);
    const hslStr = `hsl(${hsl.hue}, ${satPct}%, ${ligPct}%)`;

    colorSwatch.style.background = hslStr;
    colorLabel.textContent = hslStr;
    hueValue.textContent = `${hsl.hue}°`;
    satValue.textContent = `${satPct}%`;
    ligValue.textContent = `${ligPct}%`;

    // Info panel
    const freq = hueToFrequency(hsl.hue);
    const noise = saturationToNoiseGain(hsl.saturation);
    const vol = lightnessToVolume(hsl.lightness);

    freqDisplay.textContent = `${Math.round(freq)} Hz`;
    noiseDisplay.textContent = `${Math.round(noise * 100)}%`;
    volDisplay.textContent = `${Math.round(vol * 100)}%`;
  }

  /**
   * Sync play button appearance to state.
   */
  function updatePlayBtn(playing) {
    playBtn.setAttribute("aria-pressed", String(playing));
    playBtn.querySelector(".btn-icon").textContent = playing ? "■" : "▶";
    playBtn.querySelector(".btn-text").textContent = playing ? "Stop" : "Play";
    muteBtn.disabled = !playing;
  }

  /**
   * Sync mute button appearance to state.
   */
  function updateMuteBtn(muted) {
    muteBtn.setAttribute("aria-pressed", String(muted));
    muteBtn.querySelector(".btn-icon").textContent = muted ? "🔇" : "🔊";
    muteBtn.querySelector(".btn-text").textContent = muted ? "Unmute" : "Mute";
  }

  /**
   * Sync mode button appearance and saturation hint to current mode.
   */
  function updateModeButtons(mode) {
    modeSynthBtn.setAttribute("aria-pressed", String(mode === 'synth'));
    modeBellBtn.setAttribute("aria-pressed", String(mode === 'bell'));
    satHint.textContent = 'Controls noise texture';
  }

  /**
   * Handle sound mode button click.
   */
  async function onModeClick(mode) {
    await AudioEngine.setMode(mode);
    updateModeButtons(mode);
  }

  /**
   * Handle any slider change.
   */
  function onSliderChange() {
    const hsl = getHSL();
    updateVisuals(hsl);
    AudioEngine.update(hsl);
  }

  /**
   * Handle play/stop button click.
   */
  async function onPlayClick() {
    if (AudioEngine.isRunning) {
      AudioEngine.stop();
      updatePlayBtn(false);
      updateMuteBtn(false);
    } else {
      const hsl = getHSL();
      await AudioEngine.start(hsl);
      updatePlayBtn(true);
      updateMuteBtn(AudioEngine.isMuted);
    }
  }

  /**
   * Handle mute/unmute button click.
   */
  function onMuteClick() {
    const newMuted = !AudioEngine.isMuted;
    const hsl = getHSL();
    AudioEngine.setMute(newMuted, hsl.lightness);
    updateMuteBtn(newMuted);
  }

  /**
   * Re-activate audio context if the page was hidden and resumed.
   * Handles the "broken audio after tab switch" edge case.
   */
  function onVisibilityChange() {
    if (document.visibilityState === "visible" && AudioEngine.isRunning) {
      // AudioContext may have been auto-suspended by the browser on tab hide;
      // triggering an update lets ensureContext resume it on the next interaction.
      AudioEngine.update(getHSL());
    }
  }

  /**
   * Initialise UI.
   */
  function init() {
    const hsl = getHSL();
    updateVisuals(hsl);
    updatePlayBtn(false);
    updateMuteBtn(false);
    updateModeButtons('synth');

    hueSlider.addEventListener("input", onSliderChange);
    satSlider.addEventListener("input", onSliderChange);
    ligSlider.addEventListener("input", onSliderChange);

    playBtn.addEventListener("click", onPlayClick);
    muteBtn.addEventListener("click", onMuteClick);

    modeSynthBtn.addEventListener("click", () => onModeClick('synth'));
    modeBellBtn.addEventListener("click", () => onModeClick('bell'));

    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  return { init };
})();

/* ============================================================
   4. BOOTSTRAP
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  UI.init();
});
