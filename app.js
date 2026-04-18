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
 *  Lig  (0–1)    → Master vol  0–0.80 (0..50%), then Bell blend 0–100% (50..100%)
 *
 * The core mapping functions are pure (no DOM / Web Audio references)
 * so they can be reused in React Native or other environments.
 * ─────────────────────────────────────────────────────────────
 */

/* ============================================================
   1. AUDIO MAPPING  (pure functions, no browser dependencies)
   ============================================================ */

/**
 * Convert an average RGB color (0–255 each channel) to HSL.
 * Returns { hue: 0..360, saturation: 0..1, lightness: 0..1 }.
 *
 * @param {number} r - 0..255
 * @param {number} g - 0..255
 * @param {number} b - 0..255
 * @returns {{ hue: number, saturation: number, lightness: number }}
 */
function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break;
      case gn: h = ((bn - rn) / d + 2) / 6; break;
      default:  h = ((rn - gn) / d + 4) / 6; break;
    }
  }
  return { hue: h * 360, saturation: s, lightness: l };
}

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
 * Saturation → Noise gain
 * Noise is active from sat = 0 up to NOISE_CEIL (0.70); above that it is
 * silent.  The peak noise level is capped at 0.5 (50% blend) so the tone
 * is always at least half the mix.
 *
 *   sat = 0         → noise = 0.5  (50% blend)
 *   sat = NOISE_CEIL → noise = 0
 *   sat > NOISE_CEIL → noise = 0
 *
 * @param {number} saturation - 0..1
 * @returns {number} noise gain 0..0.5
 */
const NOISE_CEIL = 0.70;   // saturation above which noise is fully silent
const NOISE_MAX  = 0.50;   // maximum noise gain (50% blend)

function saturationToNoiseGain(saturation) {
  if (saturation >= NOISE_CEIL) return 0;
  // normalise to 0..1 within the active range, then invert with sqrt curve
  const t = saturation / NOISE_CEIL;
  return NOISE_MAX * Math.sqrt(1 - t);
}

/**
 * Saturation → Oscillator gain
 * Ramps from 0 at sat = 0 to full (1.0) at sat = NOISE_CEIL, then stays
 * at 1.0 above that (pure tone once noise is gone).
 *
 *   sat = 0         → osc gain = 0
 *   sat = NOISE_CEIL → osc gain = 1.0
 *   sat > NOISE_CEIL → osc gain = 1.0
 *
 * @param {number} saturation - 0..1
 * @returns {number} oscillator gain 0..1.0
 */
function saturationToOscGain(saturation) {
  const t = Math.min(saturation / NOISE_CEIL, 1);
  return Math.sqrt(t);
}

/**
 * Lightness → Master volume
 * Volume is controlled in the first half only:
 *   L = 0..0.5 => vol = 0..MAX_VOL
 *   L = 0.5..1 => vol = MAX_VOL
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
  const t = Math.min(lightness / 0.5, 1);
  return MAX_VOL * Math.pow(t, 0.7);
}

/**
 * Lightness → Bell blend amount
 *   L = 0..0.5 → 0
 *   L = 0.5..1 → 0..1
 *
 * @param {number} lightness - 0..1
 * @returns {number} bell blend 0..1
 */
function lightnessToBellBlend(lightness) {
  if (lightness <= 0.5) return 0;
  return Math.min((lightness - 0.5) / 0.5, 1);
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
  let soundMode = 'theremin'; // 'synth' | 'bell' | 'theremin'
  let lastHSL = { hue: 0, saturation: 1, lightness: 0.5 };
  let harmonicOscs = [];
  let harmonicGains = []; // array of { node: GainNode, baseGain: number }
  let lfoOsc = null;  // Theremin vibrato LFO oscillator
  let lfoGain = null; // Theremin vibrato depth gain

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
   * Equal-power scale for the base voice as Bell blend increases.
   * @param {number} lightness - 0..1
   * @returns {number} scale 0..1
   */
  function bellBlendBaseScale(lightness) {
    return Math.sqrt(1 - lightnessToBellBlend(lightness));
  }

  /**
   * Equal-power scale for the Bell harmonic layer from Lightness.
   * @param {number} lightness - 0..1
   * @returns {number} scale 0..1
   */
  function bellBlendLayerScale(lightness) {
    return Math.sqrt(lightnessToBellBlend(lightness));
  }

  /**
   * Create and start Bell harmonic oscillators connected to masterGain.
   * Also stores oscillator/gain references for realtime updates and teardown.
   * @param {number} freq - fundamental frequency
   * @param {number} gainScale - shared blend/saturation gain scale
   */
  function createBellHarmonics(freq, gainScale) {
    BELL_HARMONICS.forEach((h) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * h.ratio;

      const g = ctx.createGain();
      g.gain.value = h.gain * gainScale;

      osc.connect(g);
      g.connect(masterGain);
      osc.start();

      harmonicOscs.push(osc);
      harmonicGains.push({ node: g, baseGain: h.gain });
    });
  }

  /**
   * Build the audio graph.
   * Called once per play session.
   */
  function buildSynthGraph(hsl) {
    createNoiseBuffer();
    const freq = hueToFrequency(hsl.hue);
    const oscScale = saturationToOscGain(hsl.saturation);
    const baseScale = bellBlendBaseScale(hsl.lightness);
    const bellScale = bellBlendLayerScale(hsl.lightness);

    // Oscillator (sine — clean, neutral)
    oscillator = ctx.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = freq;

    // Noise source (looping buffer)
    noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;

    // Gain nodes
    gainOsc = ctx.createGain();
    gainOsc.gain.value = oscScale * baseScale;

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

    // Bell harmonics layer blended in by Lightness upper half
    createBellHarmonics(freq, oscScale * bellScale);
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
    createBellHarmonics(freq, saturationToOscGain(hsl.saturation));

    noiseSource.start();
  }

  /**
   * Build the Theremin audio graph.
   * A pure sine oscillator with LFO vibrato layered with the same
   * pink-noise path as Synth/Bell so saturation noise works identically.
   *
   * Graph:
   *   lfoOsc (sine ~5 Hz) ──► lfoGain (depth ≈ 1.2% of freq) ──► oscillator.frequency
   *   oscillator (sine) ──► gainOsc ──┐
   *   noiseSource ──► gainNoise ───────┤
   *                                masterGain ──► compressor ──► destination
   */
  function buildThereminGraph(hsl) {
    createNoiseBuffer();

    const freq = hueToFrequency(hsl.hue);
    const oscScale = saturationToOscGain(hsl.saturation);
    const baseScale = bellBlendBaseScale(hsl.lightness);
    const bellScale = bellBlendLayerScale(hsl.lightness);

    // Main oscillator
    oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = freq;

    // Vibrato LFO — modulates oscillator frequency
    lfoOsc = ctx.createOscillator();
    lfoOsc.type = 'sine';
    lfoOsc.frequency.value = 5; // 5 Hz vibrato rate

    lfoGain = ctx.createGain();
    lfoGain.gain.value = freq * 0.012; // ~1.2% of fundamental = subtle vibrato depth

    lfoOsc.connect(lfoGain);
    lfoGain.connect(oscillator.frequency);

    gainOsc = ctx.createGain();
    gainOsc.gain.value = oscScale * baseScale;

    // Noise source (same as Synth/Bell)
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

    oscillator.connect(gainOsc);
    noiseSource.connect(gainNoise);
    gainOsc.connect(masterGain);
    gainNoise.connect(masterGain);
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    oscillator.start();
    lfoOsc.start();
    noiseSource.start();

    // Bell harmonics layer blended in by Lightness upper half
    createBellHarmonics(freq, oscScale * bellScale);
  }

  /**
   * Dispatch to the appropriate graph builder based on current sound mode.
   */
  function buildGraph(hsl) {
    if (soundMode === 'bell') {
      buildBellGraph(hsl);
    } else if (soundMode === 'theremin') {
      buildThereminGraph(hsl);
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
    if (lfoOsc) { try { lfoOsc.stop(); } catch (_) {} lfoOsc.disconnect(); lfoOsc = null; }
    if (lfoGain) { lfoGain.disconnect(); lfoGain = null; }
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
    try {
      buildGraph(hsl);
      lastHSL = { ...hsl };
      running = true;
    } catch (err) {
      console.error('[AudioEngine] Failed to start:', err);
      teardownGraph();
      running = false;
      throw err;
    }
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
    } else if (soundMode === 'theremin') {
      const freq = hueToFrequency(hsl.hue);
      const oscScale = saturationToOscGain(hsl.saturation);
      const baseScale = bellBlendBaseScale(hsl.lightness);
      const bellScale = bellBlendLayerScale(hsl.lightness);
      if (oscillator) {
        oscillator.frequency.setTargetAtTime(freq, now, RAMP_TIME);
      }
      // Update LFO vibrato depth to track the new fundamental frequency
      if (lfoGain) {
        lfoGain.gain.setTargetAtTime(freq * 0.012, now, RAMP_TIME);
      }
      if (gainNoise) {
        gainNoise.gain.setTargetAtTime(saturationToNoiseGain(hsl.saturation), now, RAMP_TIME);
      }
      if (gainOsc) {
        gainOsc.gain.setTargetAtTime(oscScale * baseScale, now, RAMP_TIME);
      }
      harmonicOscs.forEach((osc, i) => {
        osc.frequency.setTargetAtTime(freq * BELL_HARMONICS[i].ratio, now, RAMP_TIME);
      });
      harmonicGains.forEach(h => {
        h.node.gain.setTargetAtTime(h.baseGain * oscScale * bellScale, now, RAMP_TIME);
      });
    } else {
      const freq = hueToFrequency(hsl.hue);
      const oscScale = saturationToOscGain(hsl.saturation);
      const baseScale = bellBlendBaseScale(hsl.lightness);
      const bellScale = bellBlendLayerScale(hsl.lightness);
      if (oscillator) {
        oscillator.frequency.setTargetAtTime(freq, now, RAMP_TIME);
      }
      if (gainNoise) {
        gainNoise.gain.setTargetAtTime(saturationToNoiseGain(hsl.saturation), now, RAMP_TIME);
      }
      if (gainOsc) {
        gainOsc.gain.setTargetAtTime(oscScale * baseScale, now, RAMP_TIME);
      }
      harmonicOscs.forEach((osc, i) => {
        osc.frequency.setTargetAtTime(freq * BELL_HARMONICS[i].ratio, now, RAMP_TIME);
      });
      harmonicGains.forEach(h => {
        h.node.gain.setTargetAtTime(h.baseGain * oscScale * bellScale, now, RAMP_TIME);
      });
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
   * Switch sound mode ('synth' | 'bell' | 'theremin').
   * If audio is running, tears down and rebuilds the graph in the new mode.
   * If graph building fails, the mode is reverted to avoid an inconsistent state.
   */
  async function setMode(mode) {
    if (mode === soundMode) return;
    const previousMode = soundMode;
    soundMode = mode;
    if (running) {
      teardownGraph();
      running = false;
      await ensureContext();
      try {
        buildGraph(lastHSL);
        running = true;
      } catch (err) {
        console.error('[AudioEngine] Failed to build graph for mode "' + mode + '":', err);
        soundMode = previousMode; // revert so UI stays consistent with audio state
      }
    }
  }

  return { start, stop, update, setMute, setMode, get isRunning() { return running; }, get isMuted() { return muted; }, get soundMode() { return soundMode; } };
})();

/* ============================================================
   3. CAMERA ENGINE
   ============================================================ */

/**
 * CameraEngine
 * ─────────────────────────────────────────────────────────────
 * Manages camera access, continuous frame sampling, average-colour
 * extraction, and torch (flash) control.
 *
 * Usage:
 *   const ok = await CameraEngine.start(videoElement, (hsl) => { … });
 *   CameraEngine.stop();
 *   await CameraEngine.toggleFlash(true);
 *
 * The supplied callback receives a normalised HSL object on every
 * sample tick (~15 fps by default) so that the caller can update the
 * audio engine and slider visuals without knowing about camera internals.
 * ─────────────────────────────────────────────────────────────
 */
const CameraEngine = (() => {
  const SAMPLE_W = 16;            // down-scale width  (px)
  const SAMPLE_H = 16;            // down-scale height (px)
  const SAMPLE_INTERVAL_MS = 67;  // ~15 fps

  let stream = null;
  let videoEl = null;
  let offCanvas = null;   // hidden 16×16 canvas — lives for the session
  let offCtx = null;
  let active = false;
  let _hasTorch = false;
  let _torchOn = false;
  let loopTimer = null;
  let onHSLCallback = null;

  /**
   * Extract a single average-colour HSL from the current video frame.
   *
   * Each pixel is converted to HSL individually, then:
   *   – hue is averaged using circular statistics (sin/cos) to correctly
   *     handle the 0°/360° wrap-around and avoid bias toward grey.
   *   – saturation and lightness are averaged arithmetically.
   *
   * This is far more accurate than averaging RGB channels first, which
   * would produce near-grey results for scenes with complementary colours.
   */
  function sampleFrame() {
    if (!offCtx || !videoEl || videoEl.readyState < 2) return null;

    // Compute the source rectangle that is actually visible in the viewport,
    // mirroring the browser's object-fit:cover behaviour:
    //   scale = max(displayW / videoW, displayH / videoH)
    //   visible source region is centred inside the intrinsic frame.
    const vW = videoEl.videoWidth  || SAMPLE_W;
    const vH = videoEl.videoHeight || SAMPLE_H;
    const dW = videoEl.clientWidth  || vW;
    const dH = videoEl.clientHeight || vH;
    const scale   = Math.max(dW / vW, dH / vH);
    const srcW    = dW / scale;
    const srcH    = dH / scale;
    const srcX    = (vW - srcW) / 2;
    const srcY    = (vH - srcH) / 2;

    offCtx.drawImage(videoEl, srcX, srcY, srcW, srcH, 0, 0, SAMPLE_W, SAMPLE_H);
    const { data } = offCtx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
    const pixels = SAMPLE_W * SAMPLE_H;
    let sinSum = 0, cosSum = 0, sSum = 0, lSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const { hue, saturation, lightness } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      const rad = hue * Math.PI / 180;
      sinSum += Math.sin(rad);
      cosSum += Math.cos(rad);
      sSum += saturation;
      lSum += lightness;
    }
    const avgHue = (Math.atan2(sinSum / pixels, cosSum / pixels) * 180 / Math.PI + 360) % 360;
    return { hue: avgHue, saturation: sSum / pixels, lightness: lSum / pixels };
  }

  /** Recurring sample loop — runs while `active` is true. */
  function loop() {
    if (!active) return;
    const hsl = sampleFrame();
    if (hsl && onHSLCallback) onHSLCallback(hsl);
    loopTimer = setTimeout(loop, SAMPLE_INTERVAL_MS);
  }

  /**
   * Start the camera.
   * @param {HTMLVideoElement} videoElement - preview element
   * @param {function} hslCallback - called with {hue,saturation,lightness} on each tick
   * @returns {Promise<boolean>} true on success, false if permission denied
   */
  async function start(videoElement, hslCallback) {
    if (active) return true;
    videoEl = videoElement;
    onHSLCallback = hslCallback;

    // Create the reusable off-screen canvas
    offCanvas = document.createElement('canvas');
    offCanvas.width = SAMPLE_W;
    offCanvas.height = SAMPLE_H;
    offCtx = offCanvas.getContext('2d', { willReadFrequently: true });

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (err) {
      console.warn('[CameraEngine] Camera access denied or unavailable:', err);
      offCanvas = null;
      offCtx = null;
      videoEl = null;
      return false;
    }

    videoEl.srcObject = stream;

    // iOS Safari requires an explicit play() call after setting srcObject;
    // the autoplay attribute alone is not sufficient on iOS.
    try {
      await videoEl.play();
    } catch (playErr) {
      console.warn('[CameraEngine] Video play failed:', playErr);
    }

    // Detect torch capability (only available after stream is granted)
    const track = stream.getVideoTracks()[0];
    if (track && typeof track.getCapabilities === 'function') {
      const caps = track.getCapabilities();
      _hasTorch = caps.torch === true;
    }

    active = true;
    loop();
    return true;
  }

  /** Stop the camera and clean up resources. */
  function stop() {
    if (!active) return;
    active = false;
    if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    if (videoEl) { videoEl.srcObject = null; videoEl = null; }
    _hasTorch = false;
    _torchOn = false;
    offCanvas = null;
    offCtx = null;
  }

  /**
   * Toggle the device torch/flash.
   * @param {boolean} on
   * @returns {Promise<void>}
   */
  async function toggleFlash(on) {
    if (!active || !_hasTorch || !stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: on }] });
      _torchOn = on;
    } catch (err) {
      console.warn('[CameraEngine] Torch control failed:', err);
    }
  }

  return {
    start,
    stop,
    toggleFlash,
    get isActive() { return active; },
    get hasTorch() { return _hasTorch; },
    get isTorchOn() { return _torchOn; },
  };
})();

/* ============================================================
   4. UI CONTROLLER
   ============================================================ */

const UI = (() => {
  // DOM references
  const hueSlider = document.getElementById("hueSlider");
  const satSlider = document.getElementById("saturationSlider");
  const ligSlider = document.getElementById("lightnessSlider");
  const satTrack = document.getElementById("saturationTrack");

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

  const satHint = document.getElementById("satHint");

  const cameraBtn = document.getElementById("cameraBtn");
  const flashBtn = document.getElementById("flashBtn");
  const cameraPreview = document.getElementById("cameraPreview");
  const swatchWrapper = document.querySelector(".swatch-wrapper");

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
   * Update swatch, label, slider labels, and info display.
   * Optionally also move the slider thumbs (used by camera feed).
   * @param {object} hsl
   * @param {boolean} [updateSliders=false] - when true, also sets slider .value
   */
  function updateVisuals(hsl, updateSliders = false) {
    const satPct = Math.round(hsl.saturation * 100);
    const ligPct = Math.round(hsl.lightness * 100);
    const hueRounded = Math.round(hsl.hue);
    const hslStr = `hsl(${hueRounded}, ${satPct}%, ${ligPct}%)`;

    colorSwatch.style.background = hslStr;
    colorLabel.textContent = hslStr;
    hueValue.textContent = `${hueRounded}°`;
    satValue.textContent = `${satPct}%`;
    ligValue.textContent = `${ligPct}%`;

    // Keep the saturation track gradient in sync with the current hue
    satTrack.style.background =
      `linear-gradient(to right, hsl(${hueRounded}, 0%, 45%), hsl(${hueRounded}, 100%, 50%))`;

    if (updateSliders) {
      hueSlider.value = hueRounded;
      satSlider.value = satPct;
      ligSlider.value = ligPct;
    }

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
   * Update camera overlay button, video visibility, and slider interactivity.
   * @param {boolean} active
   */
  function updateCameraUI(active) {
    cameraBtn.setAttribute("aria-pressed", String(active));
    // Icon-only button — update the single <span> child
    cameraBtn.querySelector("span").textContent = active ? "🎨" : "📷";
    cameraBtn.setAttribute("aria-label", active ? "Switch to color mode" : "Switch to camera input");

    // Split view: camera on left half, colour swatch on right half
    swatchWrapper.classList.toggle("camera-active", active);
    cameraPreview.hidden = !active;
    // colorSwatch stays visible at all times — it becomes the right-half colour panel

    // Lock sliders while camera is active so the camera is the sole input source
    hueSlider.disabled = active;
    satSlider.disabled = active;
    ligSlider.disabled = active;

    // Flash button: show only if active AND device supports torch
    if (active && CameraEngine.hasTorch) {
      flashBtn.hidden = false;
      flashBtn.disabled = false;
    } else {
      flashBtn.hidden = true;
      flashBtn.disabled = true;
      // Ensure torch is visually reset
      flashBtn.setAttribute("aria-pressed", "false");
      flashBtn.querySelector("span").textContent = "⚡";
    }
  }

  /**
   * Callback invoked by CameraEngine on every colour sample tick.
   * Drives audio and refreshes visuals in real time.
   * @param {{ hue: number, saturation: number, lightness: number }} hsl
   */
  function onCameraHSL(hsl) {
    updateVisuals(hsl, true);
    AudioEngine.update(hsl);
  }

  /**
   * Handle camera toggle button click.
   */
  async function onCameraClick() {
    if (CameraEngine.isActive) {
      CameraEngine.stop();
      updateCameraUI(false);
    } else {
      // Disable button while waiting for permission
      cameraBtn.disabled = true;
      const ok = await CameraEngine.start(cameraPreview, onCameraHSL);
      cameraBtn.disabled = false;
      if (ok) {
        updateCameraUI(true);
      }
      // If permission denied, button stays in its original state (camera off)
    }
  }

  /**
   * Handle flash toggle button click.
   */
  async function onFlashClick() {
    if (!CameraEngine.isActive || !CameraEngine.hasTorch) return;
    const newState = !CameraEngine.isTorchOn;
    await CameraEngine.toggleFlash(newState);
    flashBtn.setAttribute("aria-pressed", String(newState));
    flashBtn.querySelector("span").textContent = newState ? "🔦" : "⚡";
    flashBtn.setAttribute("aria-label", newState ? "Turn off flash" : "Turn on flash");
  }

  /**
   * Handle any slider change.
   * Ignored while camera is active (camera is the sole source of truth).
   */
  function onSliderChange() {
    if (CameraEngine.isActive) return;
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
      try {
        await AudioEngine.start(hsl);
      } catch (err) {
        console.error('[UI] Play start failed:', err);
      }
      updatePlayBtn(AudioEngine.isRunning);
      updateMuteBtn(AudioEngine.isRunning ? AudioEngine.isMuted : false);
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

    hueSlider.addEventListener("input", onSliderChange);
    satSlider.addEventListener("input", onSliderChange);
    ligSlider.addEventListener("input", onSliderChange);

    playBtn.addEventListener("click", onPlayClick);
    muteBtn.addEventListener("click", onMuteClick);

    cameraBtn.addEventListener("click", onCameraClick);
    flashBtn.addEventListener("click", onFlashClick);

    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  return { init };
})();

/* ============================================================
   5. BOOTSTRAP
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  UI.init();
});
