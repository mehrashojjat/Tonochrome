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
 * Hue → Frequency (primary) with purple-to-red blend
 *
 * Zone A — 0°–270° (red to purple):
 *   Logarithmic 3-octave ramp, 110 Hz → 880 Hz.
 *   freq = 110 × 2^(hue/270 × 3)
 *
 * Zone B — 270°–360° (purple to red):
 *   The pitch no longer rises. Instead, a SECOND oscillator at 110 Hz
 *   cross-fades with the 880 Hz primary using a linear complementary curve:
 *     t = (hue − 270) / 90   (0 at purple, 1 at red/360°)
 *     gainA (880 Hz) = 1 − t
 *     gainB (110 Hz) = t
 *   At hue 270° only 880 Hz is heard; at hue 360° only 110 Hz is heard.
 *
 * Returns { freqA, gainA, freqB, gainB }.
 * In zone A, freqB = 110 and gainB = 0 (second oscillator is silent).
 *
 * @param {number} hue - 0..360
 * @returns {{ freqA: number, gainA: number, freqB: number, gainB: number }}
 */
const CONFIG = {
  hue: {
    freqMin: 110,
    freqMax: 880,
    blendStart: 270,
    blendEnd: 360,
    blendFreqLow: 110,
    blendFreqHigh: 880,
  },
  saturation: {
    noiseStart: 0.1,
    noiseEnd: 0.7,
    noiseGainMin: 0,
    noiseGainMax: 1,
  },
  lightness: {
    volumeStart: 0,
    volumeEnd: 0.50,
    volumeMin: 0,
    volumeMax: 1,
    bellBlendStart: 0.50,
    bellBlendEnd: 1,
  },
  noise: {
    type: 'pink', // pink | white | brown
  },
  theremin: {
    waveform: 'sine',
    lfoRate: 5,
    lfoDepthRatio: 0.012,
  },
  bell: {
    inharmonicRatio: 4,
    brightness: 10,
  },
};

function clamp01(v) {
  return Math.min(Math.max(v, 0), 1);
}

function invLerp(value, a, b) {
  const d = b - a;
  if (d === 0) return 0;
  return clamp01((value - a) / d);
}

function getBellHarmonics() {
  const bright = CONFIG.bell.brightness;
  return [
    { ratio: 1, gain: 1.00 * bright },
    { ratio: 2, gain: 0.50 * bright },
    { ratio: 3, gain: 0.20 * bright },
    { ratio: CONFIG.bell.inharmonicRatio, gain: 0.08 * bright },
  ];
}

function hueToFrequencyBlend(hue) {
  const { freqMin, freqMax, blendStart, blendEnd, blendFreqLow, blendFreqHigh } = CONFIG.hue;

  if (hue <= blendStart) {
    // Zone A: logarithmic interpolation from freqMin -> freqMax
    const t = invLerp(hue, 0, blendStart);
    const freq = freqMin * Math.pow(freqMax / freqMin, t);
    return { freqA: freq, gainA: 1, freqB: blendFreqLow, gainB: 0 };
  }

  // Zone B: linear complementary crossfade from blendFreqHigh -> blendFreqLow
  const t = invLerp(hue, blendStart, blendEnd);
  const gainA = 1 - t;
  const gainB = t;
  return { freqA: blendFreqHigh, gainA, freqB: blendFreqLow, gainB };
}

/**
 * Hue → primary frequency (used for display / note-name purposes only).
 * Returns the dominant perceived frequency at any hue.
 *
 * @param {number} hue - 0..360
 * @returns {number} frequency in Hz
 */
function hueToFrequency(hue) {
  const { freqA, gainA, freqB, gainB } = hueToFrequencyBlend(hue);
  // Return whichever partial is louder (useful for note-name label)
  return gainA >= gainB ? freqA : freqB;
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
function saturationToNoiseGain(saturation) {
  const { noiseStart, noiseEnd, noiseGainMin, noiseGainMax } = CONFIG.saturation;
  if (saturation <= noiseStart) return noiseGainMax;
  if (saturation >= noiseEnd) return noiseGainMin;
  const t = invLerp(saturation, noiseStart, noiseEnd);
  return noiseGainMax + (noiseGainMin - noiseGainMax) * t;
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
  const { noiseStart, noiseEnd } = CONFIG.saturation;
  return invLerp(saturation, noiseStart, noiseEnd);
}

/**
 * Lightness → Master volume
 * Volume is controlled in the first half only:
 *   L = 0..0.5 => vol = 0..MAX_VOL
 *   L = 0.5..1 => vol = MAX_VOL
 * Uses a linear ramp for an even response.
 *
 *   L = 0   → vol = 0
 *   L = 1   → vol = MAX_VOL (0.80)
 *
 * @param {number} lightness - 0..1
 * @returns {number} master gain 0..0.80
 */
function lightnessToVolume(lightness) {
  const { volumeStart, volumeEnd, volumeMin, volumeMax } = CONFIG.lightness;
  const t = invLerp(lightness, volumeStart, volumeEnd);
  return volumeMin + (volumeMax - volumeMin) * t;
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
  const { bellBlendStart, bellBlendEnd } = CONFIG.lightness;
  return invLerp(lightness, bellBlendStart, bellBlendEnd);
}

/**
 * Frequency → Musical note name (e.g. 440 → "A4").
 * Uses equal-temperament based on A4 = 440 Hz.
 *
 * @param {number} freq - frequency in Hz
 * @returns {string} note name with octave (e.g. "C3", "F#4")
 */
function frequencyToNoteName(freq) {
  const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const semitones = Math.round(12 * Math.log2(freq / 440)) + 69; // MIDI note number
  const octave = Math.floor(semitones / 12) - 1;
  const name = NOTE_NAMES[((semitones % 12) + 12) % 12];
  return `${name}${octave}`;
}

/* Bell harmonics are generated from CONFIG.bell at runtime. */

/* ============================================================
   2. AUDIO ENGINE
   ============================================================ */

const AudioEngine = (() => {
  let ctx = null;
  let oscillator = null;
  let oscillator2 = null;  // second oscillator for hue blend zone (purple → red)
  let noiseSource = null;
  let gainOsc = null;
  let gainOsc2 = null;     // gain for oscillator2 blend
  let gainNoise = null;
  let masterGain = null;
  let compressor = null;
  let noiseBuffer = null;
  let running = false;
  let muted = false;
  let soundMode = 'theremin'; // 'synth' | 'bell' | 'theremin'
  let lastHSL = { hue: 0, saturation: 1, lightness: 0.5 };
  let harmonicOscs = [];
  let harmonicGains = [];  // bell layer for primary voice (freqA)
  let harmonicOscsB = [];
  let harmonicGainsB = []; // bell layer for blend voice (freqB, hue 270°–360°)
  let lfoOsc = null;  // Theremin vibrato LFO oscillator
  let lfoGain = null; // Theremin vibrato depth gain
  let noiseBellFilters = [];  // bandpass filters for noise bell resonance (one per harmonic)
  let gainNoiseWets = [];     // additive gain nodes for each filtered noise harmonic

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
   * Build a 2-second noise buffer (offline, once).
   * Supports pink, white, and brown noise via CONFIG.noise.type.
   */
  function createNoiseBuffer() {
    if (noiseBuffer) return;
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * 2; // 2 s loop
    noiseBuffer = ctx.createBuffer(1, length, sampleRate);
    const data = noiseBuffer.getChannelData(0);
    const noiseType = CONFIG.noise.type;

    if (noiseType === 'white') {
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      return;
    }

    if (noiseType === 'brown') {
      let last = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      }
      return;
    }

    // Pink noise (Paul Kellett approximation)
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
      data[i] = pink * 0.11;
    }
  }

  /**
   * Linear scale for the base voice as Bell blend increases.
   * @param {number} lightness - 0..1
   * @returns {number} scale 0..1
   */
  function bellBlendBaseScale(lightness) {
    return 1 - lightnessToBellBlend(lightness);
  }

  /**
   * Linear scale for the Bell harmonic layer from Lightness.
   * @param {number} lightness - 0..1
   * @returns {number} scale 0..1
   */
  function bellBlendLayerScale(lightness) {
    return lightnessToBellBlend(lightness);
  }

  /**
   * Create and start Bell harmonic oscillators connected to masterGain.
   * Also stores oscillator/gain references for realtime updates and teardown.
   * @param {number} freq - fundamental frequency
   * @param {number} gainScale - shared blend/saturation gain scale
   */
  /**
   * Build additive bandpass-filter layers on the noise signal — one filter per
   * bell harmonic, tuned to freq * ratio with Q=8.  Adds a pitched resonance to
   * the noise that mirrors the oscillator bell effect.  Gain = bellScale * relGain * 5
   * (the *5 compensates for the energy attenuation of a Q=8 bandpass on pink noise).
   */
  function _buildNoiseHarmonicsInto(freq, bellScale) {
    const harmonics = getBellHarmonics();
    const bright = CONFIG.bell.brightness || 1;
    harmonics.forEach(h => {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq * h.ratio;
      f.Q.value = 8;
      const g = ctx.createGain();
      g.gain.value = bellScale * (h.gain / bright) * 5;
      gainNoise.connect(f);
      f.connect(g);
      g.connect(masterGain);
      noiseBellFilters.push(f);
      gainNoiseWets.push({ node: g, relGain: h.gain / bright });
    });
  }

  function _buildBellHarmonicsInto(freq, gainScale, oscArr, gainArr) {
    const harmonics = getBellHarmonics();
    harmonics.forEach((h) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * h.ratio;
      const g = ctx.createGain();
      g.gain.value = h.gain * gainScale;
      osc.connect(g);
      g.connect(masterGain);
      osc.start();
      oscArr.push(osc);
      gainArr.push({ node: g, baseGain: h.gain });
    });
  }

  // Bell harmonics for the primary (freqA) voice
  function createBellHarmonics(freq, gainScale) {
    _buildBellHarmonicsInto(freq, gainScale, harmonicOscs, harmonicGains);
  }

  // Bell harmonics for the blend (freqB) voice in the hue 270°–360° zone
  function createBellHarmonicsB(freq, gainScale) {
    _buildBellHarmonicsInto(freq, gainScale, harmonicOscsB, harmonicGainsB);
  }

  /**
   * Build the audio graph.
   * Called once per play session.
   */
  function buildSynthGraph(hsl) {
    createNoiseBuffer();
    const { freqA, gainA, freqB, gainB } = hueToFrequencyBlend(hsl.hue);
    const oscScale = saturationToOscGain(hsl.saturation);
    const baseScale = bellBlendBaseScale(hsl.lightness);
    const bellScale = bellBlendLayerScale(hsl.lightness);

    // Primary oscillator
    oscillator = ctx.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = freqA;

    gainOsc = ctx.createGain();
    gainOsc.gain.value = oscScale * baseScale * gainA;

    // Secondary oscillator — active only in hue blend zone (purple→red)
    oscillator2 = ctx.createOscillator();
    oscillator2.type = "sine";
    oscillator2.frequency.value = freqB;

    gainOsc2 = ctx.createGain();
    gainOsc2.gain.value = oscScale * baseScale * gainB;

    // Noise source (looping buffer)
    noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;

    gainNoise = ctx.createGain();
    gainNoise.gain.value = saturationToNoiseGain(hsl.saturation);

    // Bell-filter resonance layer — per-harmonic bandpass filters (mirroring oscillator bell)
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
    oscillator2.connect(gainOsc2);
    noiseSource.connect(gainNoise);
    gainNoise.connect(masterGain);
    gainOsc.connect(masterGain);
    gainOsc2.connect(masterGain);
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    // Start sources
    oscillator.start();
    oscillator2.start();
    noiseSource.start();

    // Bell harmonics for primary voice (freqA) and blend voice (freqB)
    createBellHarmonics(freqA, oscScale * bellScale * gainA);
    createBellHarmonicsB(freqB, oscScale * bellScale * gainB);
    _buildNoiseHarmonicsInto(freqA, bellScale);
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

    const bellScaleBell = bellBlendLayerScale(hsl.lightness);

    // Bell-filter resonance layer — per-harmonic bandpass filters on noise
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
    _buildNoiseHarmonicsInto(freq, bellScaleBell);

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

    const { freqA, gainA, freqB, gainB } = hueToFrequencyBlend(hsl.hue);
    const oscScale = saturationToOscGain(hsl.saturation);
    const baseScale = bellBlendBaseScale(hsl.lightness);
    const bellScale = bellBlendLayerScale(hsl.lightness);

    // Main oscillator (with LFO vibrato)
    oscillator = ctx.createOscillator();
    oscillator.type = CONFIG.theremin.waveform;
    oscillator.frequency.value = freqA;

    // Vibrato LFO — modulates primary oscillator frequency
    lfoOsc = ctx.createOscillator();
    lfoOsc.type = 'sine';
    lfoOsc.frequency.value = CONFIG.theremin.lfoRate;

    lfoGain = ctx.createGain();
    lfoGain.gain.value = freqA * CONFIG.theremin.lfoDepthRatio;

    lfoOsc.connect(lfoGain);
    lfoGain.connect(oscillator.frequency);

    gainOsc = ctx.createGain();
    gainOsc.gain.value = oscScale * baseScale * gainA;

    // Secondary oscillator for hue blend zone — no LFO (stationary 110 Hz tone)
    oscillator2 = ctx.createOscillator();
    oscillator2.type = 'sine';
    oscillator2.frequency.value = freqB;

    gainOsc2 = ctx.createGain();
    gainOsc2.gain.value = oscScale * baseScale * gainB;

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
    oscillator2.connect(gainOsc2);
    noiseSource.connect(gainNoise);
    gainNoise.connect(masterGain);
    gainOsc.connect(masterGain);
    gainOsc2.connect(masterGain);
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    oscillator.start();
    oscillator2.start();
    lfoOsc.start();
    noiseSource.start();

    // Bell harmonics for primary voice (freqA) and blend voice (freqB)
    createBellHarmonics(freqA, oscScale * bellScale * gainA);
    createBellHarmonicsB(freqB, oscScale * bellScale * gainB);
    _buildNoiseHarmonicsInto(freqA, bellScale);
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
    if (oscillator2) {
      try { oscillator2.stop(); } catch (_) {}
      oscillator2.disconnect();
      oscillator2 = null;
    }
    if (noiseSource) {
      try { noiseSource.stop(); } catch (_) {}
      noiseSource.disconnect();
      noiseSource = null;
    }
    if (gainOsc)  { gainOsc.disconnect();  gainOsc = null; }
    if (gainOsc2) { gainOsc2.disconnect(); gainOsc2 = null; }
    if (gainNoise) { gainNoise.disconnect(); gainNoise = null; }
    noiseBellFilters.forEach(f => f.disconnect());
    noiseBellFilters = [];
    gainNoiseWets.forEach(g => g.node.disconnect());
    gainNoiseWets = [];
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
    harmonicOscsB.forEach(osc => {
      try { osc.stop(); } catch (_) {}
      osc.disconnect();
    });
    harmonicOscsB = [];
    harmonicGainsB = [];
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
    const harmonics = getBellHarmonics();

    if (soundMode === 'bell') {
      const freq = hueToFrequency(hsl.hue);
      const oscScale = saturationToOscGain(hsl.saturation);
      const bellScaleB = bellBlendLayerScale(hsl.lightness);
      harmonicOscs.forEach((osc, i) => {
        osc.frequency.setTargetAtTime(freq * harmonics[i].ratio, now, RAMP_TIME);
      });
      harmonicGains.forEach(h => {
        h.node.gain.setTargetAtTime(h.baseGain * oscScale, now, RAMP_TIME);
      });
      if (gainNoise) {
        gainNoise.gain.setTargetAtTime(saturationToNoiseGain(hsl.saturation), now, RAMP_TIME);
      }
      noiseBellFilters.forEach((f, i) => {
        f.frequency.setTargetAtTime(freq * harmonics[i].ratio, now, RAMP_TIME);
      });
      gainNoiseWets.forEach((g, i) => {
        g.node.gain.setTargetAtTime(bellScaleB * g.relGain * 5, now, RAMP_TIME);
      });
    } else if (soundMode === 'theremin') {
      const { freqA, gainA, freqB, gainB } = hueToFrequencyBlend(hsl.hue);
      const oscScale = saturationToOscGain(hsl.saturation);
      const baseScale = bellBlendBaseScale(hsl.lightness);
      const bellScale = bellBlendLayerScale(hsl.lightness);
      if (oscillator) {
        oscillator.frequency.setTargetAtTime(freqA, now, RAMP_TIME);
      }
      if (oscillator2) {
        oscillator2.frequency.setTargetAtTime(freqB, now, RAMP_TIME);
      }
      // LFO depth tracks the primary frequency
      if (lfoGain) {
        lfoGain.gain.setTargetAtTime(freqA * CONFIG.theremin.lfoDepthRatio, now, RAMP_TIME);
      }
      if (gainOsc) {
        gainOsc.gain.setTargetAtTime(oscScale * baseScale * gainA, now, RAMP_TIME);
      }
      if (gainOsc2) {
        gainOsc2.gain.setTargetAtTime(oscScale * baseScale * gainB, now, RAMP_TIME);
      }
      if (gainNoise) {
        gainNoise.gain.setTargetAtTime(saturationToNoiseGain(hsl.saturation), now, RAMP_TIME);
      }
      noiseBellFilters.forEach((f, i) => {
        f.frequency.setTargetAtTime(freqA * harmonics[i].ratio, now, RAMP_TIME);
      });
      gainNoiseWets.forEach((g, i) => {
        g.node.gain.setTargetAtTime(bellScale * g.relGain * 5, now, RAMP_TIME);
      });
      harmonicOscs.forEach((osc, i) => {
        osc.frequency.setTargetAtTime(freqA * harmonics[i].ratio, now, RAMP_TIME);
      });
      harmonicGains.forEach(h => {
        h.node.gain.setTargetAtTime(h.baseGain * oscScale * bellScale * gainA, now, RAMP_TIME);
      });
      harmonicOscsB.forEach((osc, i) => {
        osc.frequency.setTargetAtTime(freqB * harmonics[i].ratio, now, RAMP_TIME);
      });
      harmonicGainsB.forEach(h => {
        h.node.gain.setTargetAtTime(h.baseGain * oscScale * bellScale * gainB, now, RAMP_TIME);
      });
    } else {
      // synth mode
      const { freqA, gainA, freqB, gainB } = hueToFrequencyBlend(hsl.hue);
      const oscScale = saturationToOscGain(hsl.saturation);
      const baseScale = bellBlendBaseScale(hsl.lightness);
      const bellScale = bellBlendLayerScale(hsl.lightness);
      if (oscillator) {
        oscillator.frequency.setTargetAtTime(freqA, now, RAMP_TIME);
      }
      if (oscillator2) {
        oscillator2.frequency.setTargetAtTime(freqB, now, RAMP_TIME);
      }
      if (gainOsc) {
        gainOsc.gain.setTargetAtTime(oscScale * baseScale * gainA, now, RAMP_TIME);
      }
      if (gainOsc2) {
        gainOsc2.gain.setTargetAtTime(oscScale * baseScale * gainB, now, RAMP_TIME);
      }
      if (gainNoise) {
        gainNoise.gain.setTargetAtTime(saturationToNoiseGain(hsl.saturation), now, RAMP_TIME);
      }
      noiseBellFilters.forEach((f, i) => {
        f.frequency.setTargetAtTime(freqA * harmonics[i].ratio, now, RAMP_TIME);
      });
      gainNoiseWets.forEach((g, i) => {
        g.node.gain.setTargetAtTime(bellScale * g.relGain * 5, now, RAMP_TIME);
      });
      harmonicOscs.forEach((osc, i) => {
        osc.frequency.setTargetAtTime(freqA * harmonics[i].ratio, now, RAMP_TIME);
      });
      harmonicGains.forEach(h => {
        h.node.gain.setTargetAtTime(h.baseGain * oscScale * bellScale * gainA, now, RAMP_TIME);
      });
      harmonicOscsB.forEach((osc, i) => {
        osc.frequency.setTargetAtTime(freqB * harmonics[i].ratio, now, RAMP_TIME);
      });
      harmonicGainsB.forEach(h => {
        h.node.gain.setTargetAtTime(h.baseGain * oscScale * bellScale * gainB, now, RAMP_TIME);
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

  /**
   * Apply partial settings and rebuild graph if needed.
   * @param {object} partial
   */
  async function applySettings(partial) {
    if (!partial || typeof partial !== 'object') return;
    Object.keys(partial).forEach((k) => {
      if (partial[k] && typeof partial[k] === 'object' && CONFIG[k]) {
        Object.assign(CONFIG[k], partial[k]);
      }
    });

    // Noise changes require a new buffer build.
    noiseBuffer = null;

    if (running) {
      teardownGraph();
      running = false;
      await ensureContext();
      buildGraph(lastHSL);
      running = true;
    }
  }

  return {
    start,
    stop,
    update,
    setMute,
    setMode,
    applySettings,
    get config() { return CONFIG; },
    get isRunning() { return running; },
    get isMuted() { return muted; },
    get soundMode() { return soundMode; }
  };
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
  const noteDisplay = document.getElementById("noteDisplay");

  const satHint = document.getElementById("satHint");

  const cameraBtn = document.getElementById("cameraBtn");
  const flashBtn = document.getElementById("flashBtn");
  const cameraPreview = document.getElementById("cameraPreview");
  const swatchWrapper = document.querySelector(".swatch-wrapper");

  const srAnnounce = document.getElementById("srAnnounce");

  // Advanced settings controls
  const cfgHueFreqMinRange = document.getElementById("cfgHueFreqMinRange");
  const cfgHueFreqMaxRange = document.getElementById("cfgHueFreqMaxRange");
  const cfgHueFreqMinInput = document.getElementById("cfgHueFreqMinInput");
  const cfgHueFreqMaxInput = document.getElementById("cfgHueFreqMaxInput");

  const cfgHueBlendStartRange = document.getElementById("cfgHueBlendStartRange");
  const cfgHueBlendEndRange = document.getElementById("cfgHueBlendEndRange");
  const cfgHueBlendStartInput = document.getElementById("cfgHueBlendStartInput");
  const cfgHueBlendEndInput = document.getElementById("cfgHueBlendEndInput");

  const cfgHueBlendLowFreqRange = document.getElementById("cfgHueBlendLowFreqRange");
  const cfgHueBlendHighFreqRange = document.getElementById("cfgHueBlendHighFreqRange");
  const cfgHueBlendLowFreqInput = document.getElementById("cfgHueBlendLowFreqInput");
  const cfgHueBlendHighFreqInput = document.getElementById("cfgHueBlendHighFreqInput");

  const cfgSatNoiseStartRange = document.getElementById("cfgSatNoiseStartRange");
  const cfgSatNoiseEndRange = document.getElementById("cfgSatNoiseEndRange");
  const cfgSatNoiseStartInput = document.getElementById("cfgSatNoiseStartInput");
  const cfgSatNoiseEndInput = document.getElementById("cfgSatNoiseEndInput");

  const cfgNoiseGainMinRange = document.getElementById("cfgNoiseGainMinRange");
  const cfgNoiseGainMaxRange = document.getElementById("cfgNoiseGainMaxRange");
  const cfgNoiseGainMinInput = document.getElementById("cfgNoiseGainMinInput");
  const cfgNoiseGainMaxInput = document.getElementById("cfgNoiseGainMaxInput");

  const cfgVolStartRange = document.getElementById("cfgVolStartRange");
  const cfgVolEndRange = document.getElementById("cfgVolEndRange");
  const cfgVolStartInput = document.getElementById("cfgVolStartInput");
  const cfgVolEndInput = document.getElementById("cfgVolEndInput");

  const cfgVolMinRange = document.getElementById("cfgVolMinRange");
  const cfgVolMaxRange = document.getElementById("cfgVolMaxRange");
  const cfgVolMinInput = document.getElementById("cfgVolMinInput");
  const cfgVolMaxInput = document.getElementById("cfgVolMaxInput");

  const cfgBellBlendStartRange = document.getElementById("cfgBellBlendStartRange");
  const cfgBellBlendEndRange = document.getElementById("cfgBellBlendEndRange");
  const cfgBellBlendStartInput = document.getElementById("cfgBellBlendStartInput");
  const cfgBellBlendEndInput = document.getElementById("cfgBellBlendEndInput");

  const cfgNoiseType = document.getElementById("cfgNoiseType");
  const cfgThereminWaveform = document.getElementById("cfgThereminWaveform");
  const cfgThereminLfoRateInput = document.getElementById("cfgThereminLfoRateInput");
  const cfgThereminLfoDepthInput = document.getElementById("cfgThereminLfoDepthInput");
  const cfgBellInharmonicInput = document.getElementById("cfgBellInharmonicInput");
  const cfgBellBrightnessInput = document.getElementById("cfgBellBrightnessInput");

  // --- Screen-reader announcement helpers ---
  let _announceTimer = null;
  function announce(msg) {
    if (!srAnnounce) return;
    srAnnounce.textContent = '';
    clearTimeout(_announceTimer);
    _announceTimer = setTimeout(() => { srAnnounce.textContent = msg; }, 60);
  }

  let _settingsTimer = null;
  let _pendingSettings = {};

  function mergeSettingsPatch(target, patch) {
    Object.keys(patch).forEach((k) => {
      if (!target[k]) target[k] = {};
      Object.assign(target[k], patch[k]);
    });
  }

  function scheduleSettingsApply(patch) {
    mergeSettingsPatch(_pendingSettings, patch);
    clearTimeout(_settingsTimer);
    _settingsTimer = setTimeout(async () => {
      const payload = _pendingSettings;
      _pendingSettings = {};
      await AudioEngine.applySettings(payload);
      const hsl = getHSL();
      updateVisuals(hsl);
      AudioEngine.update(hsl);
    }, 60);
  }

  function bindDualPair(options) {
    const {
      minRange,
      maxRange,
      minInput,
      maxInput,
      min,
      max,
      step,
      integer,
      minGap,
      onChange,
    } = options;

    const clamp = (v) => Math.min(Math.max(v, min), max);
    const parse = (v) => integer ? parseInt(v, 10) : parseFloat(v);

    const sync = (source) => {
      let a = clamp(parse(minRange.value));
      let b = clamp(parse(maxRange.value));

      if (source === 'minInput') a = clamp(parse(minInput.value));
      if (source === 'maxInput') b = clamp(parse(maxInput.value));

      if (b < a + minGap) {
        if (source === 'minRange' || source === 'minInput') {
          a = b - minGap;
        } else {
          b = a + minGap;
        }
      }

      a = clamp(a);
      b = clamp(b);

      minRange.min = min;
      minRange.max = max;
      maxRange.min = min;
      maxRange.max = max;
      minRange.step = step;
      maxRange.step = step;

      minRange.value = a;
      maxRange.value = b;
      minInput.value = a;
      maxInput.value = b;

      onChange(a, b);
    };

    ['input', 'change'].forEach(evt => {
      minRange.addEventListener(evt, () => sync('minRange'));
      maxRange.addEventListener(evt, () => sync('maxRange'));
      minInput.addEventListener(evt, () => sync('minInput'));
      maxInput.addEventListener(evt, () => sync('maxInput'));
    });

    sync('minRange');
  }

  function initSettingsPanel() {
    // Seed all inputs from CONFIG so it is the single source of truth.
    const C = CONFIG;
    cfgHueFreqMinRange.value   = cfgHueFreqMinInput.value   = C.hue.freqMin;
    cfgHueFreqMaxRange.value   = cfgHueFreqMaxInput.value   = C.hue.freqMax;
    cfgHueBlendStartRange.value = cfgHueBlendStartInput.value = C.hue.blendStart;
    cfgHueBlendEndRange.value   = cfgHueBlendEndInput.value   = C.hue.blendEnd;
    cfgHueBlendLowFreqRange.value  = cfgHueBlendLowFreqInput.value  = C.hue.blendFreqLow;
    cfgHueBlendHighFreqRange.value = cfgHueBlendHighFreqInput.value = C.hue.blendFreqHigh;
    cfgSatNoiseStartRange.value = cfgSatNoiseStartInput.value = C.saturation.noiseStart;
    cfgSatNoiseEndRange.value   = cfgSatNoiseEndInput.value   = C.saturation.noiseEnd;
    cfgNoiseGainMinRange.value  = cfgNoiseGainMinInput.value  = C.saturation.noiseGainMin;
    cfgNoiseGainMaxRange.value  = cfgNoiseGainMaxInput.value  = C.saturation.noiseGainMax;
    cfgVolStartRange.value = cfgVolStartInput.value = C.lightness.volumeStart;
    cfgVolEndRange.value   = cfgVolEndInput.value   = C.lightness.volumeEnd;
    cfgVolMinRange.value   = cfgVolMinInput.value   = C.lightness.volumeMin;
    cfgVolMaxRange.value   = cfgVolMaxInput.value   = C.lightness.volumeMax;
    cfgBellBlendStartRange.value = cfgBellBlendStartInput.value = C.lightness.bellBlendStart;
    cfgBellBlendEndRange.value   = cfgBellBlendEndInput.value   = C.lightness.bellBlendEnd;
    cfgNoiseType.value           = C.noise.type;
    cfgThereminWaveform.value    = C.theremin.waveform;
    cfgThereminLfoRateInput.value  = C.theremin.lfoRate;
    cfgThereminLfoDepthInput.value = C.theremin.lfoDepthRatio;
    cfgBellInharmonicInput.value   = C.bell.inharmonicRatio;
    cfgBellBrightnessInput.value   = C.bell.brightness;

    bindDualPair({
      minRange: cfgHueFreqMinRange, maxRange: cfgHueFreqMaxRange,
      minInput: cfgHueFreqMinInput, maxInput: cfgHueFreqMaxInput,
      min: 40, max: 2000, step: 1, integer: true, minGap: 1,
      onChange: (a, b) => scheduleSettingsApply({ hue: { freqMin: a, freqMax: b } }),
    });

    bindDualPair({
      minRange: cfgHueBlendStartRange, maxRange: cfgHueBlendEndRange,
      minInput: cfgHueBlendStartInput, maxInput: cfgHueBlendEndInput,
      min: 0, max: 360, step: 1, integer: true, minGap: 1,
      onChange: (a, b) => scheduleSettingsApply({ hue: { blendStart: a, blendEnd: b } }),
    });

    bindDualPair({
      minRange: cfgHueBlendLowFreqRange, maxRange: cfgHueBlendHighFreqRange,
      minInput: cfgHueBlendLowFreqInput, maxInput: cfgHueBlendHighFreqInput,
      min: 40, max: 2000, step: 1, integer: true, minGap: 1,
      onChange: (a, b) => scheduleSettingsApply({ hue: { blendFreqLow: a, blendFreqHigh: b } }),
    });

    bindDualPair({
      minRange: cfgSatNoiseStartRange, maxRange: cfgSatNoiseEndRange,
      minInput: cfgSatNoiseStartInput, maxInput: cfgSatNoiseEndInput,
      min: 0, max: 1, step: 0.01, integer: false, minGap: 0.01,
      onChange: (a, b) => scheduleSettingsApply({ saturation: { noiseStart: a, noiseEnd: b } }),
    });

    bindDualPair({
      minRange: cfgNoiseGainMinRange, maxRange: cfgNoiseGainMaxRange,
      minInput: cfgNoiseGainMinInput, maxInput: cfgNoiseGainMaxInput,
      min: 0, max: 1, step: 0.01, integer: false, minGap: 0,
      onChange: (a, b) => scheduleSettingsApply({ saturation: { noiseGainMin: a, noiseGainMax: b } }),
    });

    bindDualPair({
      minRange: cfgVolStartRange, maxRange: cfgVolEndRange,
      minInput: cfgVolStartInput, maxInput: cfgVolEndInput,
      min: 0, max: 1, step: 0.01, integer: false, minGap: 0.01,
      onChange: (a, b) => scheduleSettingsApply({ lightness: { volumeStart: a, volumeEnd: b } }),
    });

    bindDualPair({
      minRange: cfgVolMinRange, maxRange: cfgVolMaxRange,
      minInput: cfgVolMinInput, maxInput: cfgVolMaxInput,
      min: 0, max: 1, step: 0.01, integer: false, minGap: 0,
      onChange: (a, b) => scheduleSettingsApply({ lightness: { volumeMin: a, volumeMax: b } }),
    });

    bindDualPair({
      minRange: cfgBellBlendStartRange, maxRange: cfgBellBlendEndRange,
      minInput: cfgBellBlendStartInput, maxInput: cfgBellBlendEndInput,
      min: 0, max: 1, step: 0.01, integer: false, minGap: 0.01,
      onChange: (a, b) => scheduleSettingsApply({ lightness: { bellBlendStart: a, bellBlendEnd: b } }),
    });

    cfgNoiseType.addEventListener('change', () => {
      scheduleSettingsApply({ noise: { type: cfgNoiseType.value } });
    });

    cfgThereminWaveform.addEventListener('change', () => {
      scheduleSettingsApply({ theremin: { waveform: cfgThereminWaveform.value } });
    });

    [cfgThereminLfoRateInput, cfgThereminLfoDepthInput, cfgBellInharmonicInput, cfgBellBrightnessInput]
      .forEach((el) => {
        el.addEventListener('input', () => {
          scheduleSettingsApply({
            theremin: {
              lfoRate: parseFloat(cfgThereminLfoRateInput.value),
              lfoDepthRatio: parseFloat(cfgThereminLfoDepthInput.value),
            },
            bell: {
              inharmonicRatio: parseFloat(cfgBellInharmonicInput.value),
              brightness: parseFloat(cfgBellBrightnessInput.value),
            },
          });
        });
      });
  }

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
    const noteName = frequencyToNoteName(freq);

    freqDisplay.textContent = `${Math.round(freq)} Hz`;
    noiseDisplay.textContent = `${Math.round(noise * 100)}%`;
    volDisplay.textContent = `${Math.round(vol * 100)}%`;
    if (noteDisplay) noteDisplay.textContent = noteName;

    // aria-valuetext: meaningful descriptions for screen readers
    hueSlider.setAttribute('aria-valuetext',
      `${hueRounded} degrees — ${noteName}, ${Math.round(freq)} Hz`);

    const noisePct = Math.round(noise * 100);
    let satDesc;
    if (satPct === 0)        satDesc = 'pure noise, no tone';
    else if (satPct >= 70)   satDesc = 'pure tone, no noise';
    else                     satDesc = `${noisePct}% noise blend`;
    satSlider.setAttribute('aria-valuetext', `${satPct}% — ${satDesc}`);

    const bellBlendPct = Math.round(lightnessToBellBlend(hsl.lightness) * 100);
    let ligDesc;
    if (ligPct === 0)         ligDesc = 'silent';
    else if (ligPct <= 50)    ligDesc = `volume ${Math.round(vol * 100)}%`;
    else                      ligDesc = `full volume, bell blend ${bellBlendPct}%`;
    ligSlider.setAttribute('aria-valuetext', `${ligPct}% — ${ligDesc}`);
  }

  /**
   * Sync play button appearance to state.
   */
  function updatePlayBtn(playing) {
    playBtn.setAttribute("aria-pressed", String(playing));
    playBtn.querySelector(".btn-icon").textContent = playing ? "■" : "▶";
    playBtn.querySelector(".btn-text").textContent = playing ? "Stop" : "Play";
    muteBtn.disabled = !playing;

    if (playing) {
      const hsl = getHSL();
      const note = frequencyToNoteName(hueToFrequency(hsl.hue));
      announce(`Playing. ${note}.`);
    } else {
      announce('Stopped.');
    }
  }

  function updateMuteBtn(muted) {
    muteBtn.setAttribute("aria-pressed", String(muted));
    muteBtn.querySelector(".btn-icon").textContent = muted ? "🔇" : "🔊";
    muteBtn.querySelector(".btn-text").textContent = muted ? "Unmute" : "Mute";
    if (AudioEngine.isRunning) announce(muted ? 'Muted.' : 'Unmuted.');
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
   * Global keyboard shortcuts.
   * Not triggered when focus is inside an input, button, or select so as not
   * to clobber native control behaviour.
   */
  function onGlobalKeydown(e) {
    // Only fire when focus is not on an interactive form element
    const tag = (document.activeElement && document.activeElement.tagName.toLowerCase()) || '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    // Allow button keyboard shortcuts only when focus is NOT on a button (Space / Enter already trigger it)
    const onButton = tag === 'button';

    switch (e.key) {
      case ' ':
        if (!onButton) { e.preventDefault(); onPlayClick(); }
        break;
      case 'm':
      case 'M':
        if (!onButton && AudioEngine.isRunning) { e.preventDefault(); onMuteClick(); }
        break;
      case '1':
        e.preventDefault();
        AudioEngine.setMode('synth');
        announce('Synth mode.');
        break;
      case '2':
        e.preventDefault();
        AudioEngine.setMode('bell');
        announce('Bell mode.');
        break;
      case '3':
        e.preventDefault();
        AudioEngine.setMode('theremin');
        announce('Theremin mode.');
        break;
    }
  }

  /**
   * Initialise UI.
   */
  function init() {
    initSettingsPanel();

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

    document.addEventListener("keydown", onGlobalKeydown);
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
