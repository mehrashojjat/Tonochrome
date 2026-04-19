/**
 * Tonochrome — app.js
 * Color → Sound (HSL) engine using the Web Audio API.
 *
 * Architecture
 * ─────────────────────────────────────────────────────────────
 *  OscillatorNode (sine)  ──► gainOsc ──┐
 *  AudioBufferSourceNode (pink/brown noise) ──► gainNoiseUpper/gainNoiseLower ──┤
 *                                              masterGain ──► DynamicsCompressorNode ──► destination
 *
 * Mapping rules
 *  Hue  (0–360)  → Frequency  110–880 Hz  (logarithmic / octave-loop)
 *  Sat  (0–1)    → Bell blend  100%–0%  (grey=max bell, vivid=min bell)
 *  Lig  (0–1)    → Brown noise 100%–0% (0..50%), oscillator volume 0–100% (0..50%), then pink noise 0–100% (50..100%)
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
const FALLBACK_CONFIG = {
  hue: {
    freqMin: 110,
    freqMax: 880,
    blendStart: 270,
    blendEnd: 360,
    blendFreqLow: 110,
    blendFreqHigh: 880,
  },
  saturation: {
    bellBlendStart: 0,
    bellBlendEnd: 0.7,
  },
  lightness: {
    volumeStart: 0,
    volumeEnd: 0.50,
    volumeMin: 0,
    volumeMax: 1,
    brownNoiseStart: 0,
    brownNoiseEnd: 0.50,
    pinkNoiseStart: 0.50,
    pinkNoiseEnd: 1,
  },
  noise: {
    upperType: 'pink', // pink | white | brown
    lowerType: 'brown', // pink | white | brown
    bellType: 'pink', // pink | white | brown
    upperMaxGain: 0.5,
    lowerMaxGain: 0.35,
    bellResonanceBoost: 1.2,
  },
  theremin: {
    waveform: 'sine',
    lfoRate: 5,
    lfoDepthRatio: 0.012,
  },
  bell: {
    inharmonicRatio: 4.2,
    brightness: 1,
  },
  synth: {
    waveform: 'sine',
  },
  tone: {
    filterType: 'lowpass',
    filterFrequency: 20000,
    filterQ: 0.0001,
    drive: 1,
  },
  sound: {
    character: 'default',
  },
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeConfigObjects(target, patch) {
  Object.keys(patch).forEach((key) => {
    const value = patch[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      target[key] = value;
      return;
    }
    if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
      target[key] = {};
    }
    mergeConfigObjects(target[key], value);
  });
}

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function parseSettingsJSONC(text) {
  return JSON.parse(stripJsonComments(text));
}

function loadDefaultConfig() {
  const config = deepClone(FALLBACK_CONFIG);
  if (typeof window !== 'undefined' && typeof window.TONOCHROME_DEFAULT_SETTINGS_JSON === 'string') {
    try {
      mergeConfigObjects(config, parseSettingsJSONC(window.TONOCHROME_DEFAULT_SETTINGS_JSON));
    } catch (err) {
      console.warn('[Config] Failed to parse default-settings.js, using fallback config.', err);
    }
  }

  // Backward compatibility for older exported defaults.
  if (typeof config.noise.type === 'string' && !config.noise.upperType) {
    config.noise.upperType = config.noise.type;
  }
  if (typeof config.noise.maxGain === 'number' && typeof config.noise.upperMaxGain !== 'number') {
    config.noise.upperMaxGain = config.noise.maxGain;
  }
  if (typeof config.lightness.noiseStart === 'number' && typeof config.lightness.pinkNoiseStart !== 'number') {
    config.lightness.pinkNoiseStart = config.lightness.noiseStart;
  }
  if (typeof config.lightness.noiseEnd === 'number' && typeof config.lightness.pinkNoiseEnd !== 'number') {
    config.lightness.pinkNoiseEnd = config.lightness.noiseEnd;
  }
  return config;
}

const CONFIG = loadDefaultConfig();

/**
 * Instrument character presets.
 * Each preset defines synth/theremin/bell/noise parameters that together
 * shape the timbre produced by the Hue (pitch) slider.
 * The 'default' preset preserves the original sound unchanged.
 */
const SOUND_CHARACTER_PRESETS = {
  default: {
    label: 'Default',
    synth:    { waveform: 'sine' },
    theremin: { waveform: 'sine',     lfoRate: 5,   lfoDepthRatio: 0.012 },
    bell:     { inharmonicRatio: 4.2, brightness: 1 },
    noise:    { bellResonanceBoost: 1.2 },
    tone:     { filterType: 'lowpass', filterFrequency: 20000, filterQ: 0.0001, drive: 1 },
  },
  piano: {
    label: 'Piano',
    // Triangle wave: rich in odd harmonics, clearly different from sine.
    // Strong overtone ring + subtle drive for hammer-string character.
    // Near-zero vibrato: piano keys produce no mechanical vibrato.
    synth:    { waveform: 'triangle' },
    theremin: { waveform: 'triangle', lfoRate: 1,   lfoDepthRatio: 0.001 },
    bell:     { inharmonicRatio: 4.8, brightness: 4.5 },
    noise:    { bellResonanceBoost: 5.5 },
    tone:     { filterType: 'lowpass', filterFrequency: 4600, filterQ: 1.1, drive: 1.35 },
  },
  strings: {
    label: 'Strings',
    synth:    { waveform: 'sawtooth' },
    theremin: { waveform: 'sawtooth', lfoRate: 5.5, lfoDepthRatio: 0.020 },
    bell:     { inharmonicRatio: 4.2, brightness: 0.5 },
    noise:    { bellResonanceBoost: 0.6 },
    tone:     { filterType: 'lowpass', filterFrequency: 20000, filterQ: 0.0001, drive: 1 },
  },
  organ: {
    label: 'Organ',
    synth:    { waveform: 'square' },
    theremin: { waveform: 'square',   lfoRate: 5,   lfoDepthRatio: 0.007 },
    bell:     { inharmonicRatio: 4.2, brightness: 0.4 },
    noise:    { bellResonanceBoost: 0.3 },
    tone:     { filterType: 'lowpass', filterFrequency: 20000, filterQ: 0.0001, drive: 1 },
  },
  flute: {
    label: 'Flute',
    // Pure sine fundamental (flute is nearly a single partial).
    // High lfoDepthRatio gives the characteristic flute vibrato wobble.
    // Near-zero bell resonance: no harmonic overtones.
    synth:    { waveform: 'sine' },
    theremin: { waveform: 'sine',     lfoRate: 5.5, lfoDepthRatio: 0.048 },
    bell:     { inharmonicRatio: 4.2, brightness: 0.05 },
    noise:    { bellResonanceBoost: 0.05 },
    tone:     { filterType: 'highpass', filterFrequency: 450, filterQ: 0.8, drive: 1.02 },
  },
  brass: {
    label: 'Brass',
    synth:    { waveform: 'sawtooth' },
    theremin: { waveform: 'sawtooth', lfoRate: 3.8, lfoDepthRatio: 0.015 },
    bell:     { inharmonicRatio: 3.8, brightness: 1.8 },
    noise:    { bellResonanceBoost: 2.1 },
    tone:     { filterType: 'bandpass', filterFrequency: 1200, filterQ: 0.9, drive: 1.9 },
  },
  bass: {
    label: 'Bass',
    synth:    { waveform: 'square' },
    theremin: { waveform: 'square', lfoRate: 2.2, lfoDepthRatio: 0.006 },
    bell:     { inharmonicRatio: 2.4, brightness: 0.18 },
    noise:    { bellResonanceBoost: 0.2 },
    tone:     { filterType: 'lowpass', filterFrequency: 520, filterQ: 1.0, drive: 1.9 },
  },
  glass: {
    label: 'Glass',
    synth:    { waveform: 'triangle' },
    theremin: { waveform: 'triangle', lfoRate: 6.8, lfoDepthRatio: 0.010 },
    bell:     { inharmonicRatio: 6.2, brightness: 6.0 },
    noise:    { bellResonanceBoost: 3.8 },
    tone:     { filterType: 'highpass', filterFrequency: 1100, filterQ: 1.2, drive: 1.08 },
  },
  chip: {
    label: 'Chip',
    synth:    { waveform: 'square' },
    theremin: { waveform: 'square', lfoRate: 0.8, lfoDepthRatio: 0.0008 },
    bell:     { inharmonicRatio: 2.0, brightness: 0.1 },
    noise:    { bellResonanceBoost: 0.15 },
    tone:     { filterType: 'highpass', filterFrequency: 900, filterQ: 0.7, drive: 2.2 },
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

const LEGACY_BELL_HARMONICS = [
  { ratio: 1, gain: 1.00 },
  { ratio: 2, gain: 0.50 },
  { ratio: 3, gain: 0.20 },
  { ratio: 4.2, gain: 0.08 },
];

function getBellHarmonics() {
  const brightness = Math.max(CONFIG.bell.brightness, 0.1);
  const harmonics = [
    { ratio: 1, gain: LEGACY_BELL_HARMONICS[0].gain },
    { ratio: 2, gain: LEGACY_BELL_HARMONICS[1].gain * brightness },
    { ratio: 3, gain: LEGACY_BELL_HARMONICS[2].gain * Math.pow(brightness, 1.35) },
    { ratio: CONFIG.bell.inharmonicRatio, gain: LEGACY_BELL_HARMONICS[3].gain * Math.pow(brightness, 1.7) },
  ];

  const legacyEnergy = LEGACY_BELL_HARMONICS.reduce((sum, harmonic) => sum + harmonic.gain * harmonic.gain, 0);
  const currentEnergy = harmonics.reduce((sum, harmonic) => sum + harmonic.gain * harmonic.gain, 0);
  const normalization = currentEnergy > 0 ? Math.sqrt(legacyEnergy / currentEnergy) : 1;

  return harmonics.map((harmonic) => ({
    ratio: harmonic.ratio,
    gain: harmonic.gain * normalization,
  }));
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
 * Saturation → Bell blend amount
 * S = 0 → bell blend = 1.0 (maximum bell/resonance)
 * S = 0.7 → bell blend = 0 (no bell)
 *
 * @param {number} saturation - 0..1
 * @returns {number} bell blend 0..1
 */
function saturationToBellBlend(saturation) {
  const { bellBlendStart, bellBlendEnd } = CONFIG.saturation;
  return invLerp(saturation, bellBlendEnd, bellBlendStart);
}

/**
 * Lightness → Pink noise blend amount
 * L = pinkNoiseStart..pinkNoiseEnd → 0..1
 *
 * @param {number} lightness - 0..1
 * @returns {number} pink noise blend 0..1
 */
function lightnessToPinkNoiseBlend(lightness) {
  const { pinkNoiseStart, pinkNoiseEnd } = CONFIG.lightness;
  if (lightness < pinkNoiseStart) return 0;
  return invLerp(lightness, pinkNoiseStart, pinkNoiseEnd);
}

/**
 * Lightness → Brown noise blend amount
 * L = brownNoiseEnd..brownNoiseStart → 0..1 when moving downward.
 *
 * @param {number} lightness - 0..1
 * @returns {number} brown noise blend 0..1
 */
function lightnessToBrownNoiseBlend(lightness) {
  const { brownNoiseStart, brownNoiseEnd } = CONFIG.lightness;
  if (lightness > brownNoiseEnd) return 0;
  return invLerp(lightness, brownNoiseEnd, brownNoiseStart);
}

/**
 * Lightness → Oscillator scale (inverse to noise blend)
 * L = 0..0.5 → osc scale = 1 (full oscillator volume)
 * L = 0.5..1.0 → osc scale = 1..0 (inverse crossfade with noise)
 * At L=1.0, oscillators are silent and only noise is heard.
 *
 * @param {number} lightness - 0..1
 * @returns {number} oscillator scale 0..1
 */
function lightnessToOscillatorScale(lightness) {
  const { pinkNoiseStart, pinkNoiseEnd } = CONFIG.lightness;
  if (lightness < pinkNoiseStart) return 1;
  return 1 - invLerp(lightness, pinkNoiseStart, pinkNoiseEnd);
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
  let noiseSourceUpper = null;
  let noiseSourceLower = null;
  let noiseSourceBell = null;
  let gainOsc = null;
  let gainOsc2 = null;     // gain for oscillator2 blend
  let gainOscVolume = null; // volume control for oscillators and bell harmonics only
  let gainNoiseUpper = null;
  let gainNoiseLower = null;
  let gainNoiseBell = null;
  let masterGain = null;
  let compressor = null;
  let noiseBuffers = {};
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
  let toneFilter = null; // optional tonal path filter (does not process raw L-noise)
  let toneDrive = null;  // optional tonal path waveshaper (does not process raw L-noise)
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
  function getNoiseBuffer(noiseType) {
    if (noiseBuffers[noiseType]) return noiseBuffers[noiseType];
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * 2; // 2 s loop
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    if (noiseType === 'white') {
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      noiseBuffers[noiseType] = buffer;
      return buffer;
    }

    if (noiseType === 'brown') {
      let last = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        last = (last + 0.02 * white) / 1.02;
        data[i] = last * 3.5;
      }
      noiseBuffers[noiseType] = buffer;
      return buffer;
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

    noiseBuffers[noiseType] = buffer;
    return buffer;
  }

  function createLoopingNoiseSource(noiseType) {
    const source = ctx.createBufferSource();
    source.buffer = getNoiseBuffer(noiseType);
    source.loop = true;
    return source;
  }

  function createDriveCurve(drive) {
    const n = 1024;
    const curve = new Float32Array(n);
    const k = Math.max(1, drive);
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / norm;
    }
    return curve;
  }

  // Connect only the tonal path (H-driven oscillators/harmonics) through optional tone shaping.
  // Raw noise driven by L stays directly connected to masterGain.
  function connectTonalPath(sourceNode) {
    const toneCfg = CONFIG.tone || {};
    const filterType = toneCfg.filterType || 'lowpass';
    const filterFrequency = Math.min(Math.max(Number(toneCfg.filterFrequency) || 20000, 40), 20000);
    const filterQ = Math.max(Number(toneCfg.filterQ) || 0.0001, 0.0001);
    const drive = Math.max(Number(toneCfg.drive) || 1, 1);

    let node = sourceNode;

    // Skip neutral lowpass@20k to keep default signal path unchanged.
    if (!(filterType === 'lowpass' && filterFrequency >= 19950)) {
      toneFilter = ctx.createBiquadFilter();
      toneFilter.type = filterType;
      toneFilter.frequency.value = filterFrequency;
      toneFilter.Q.value = filterQ;
      node.connect(toneFilter);
      node = toneFilter;
    }

    if (drive > 1.01) {
      toneDrive = ctx.createWaveShaper();
      toneDrive.curve = createDriveCurve(drive);
      toneDrive.oversample = '4x';
      node.connect(toneDrive);
      node = toneDrive;
    }

    node.connect(masterGain);
  }

  /**
   * Linear scale for the base voice (inverted bell blend).
   * @param {number} saturation - 0..1
   * @returns {number} scale 0..1
   */
  function bellBlendBaseScale(saturation) {
    return 1 - saturationToBellBlend(saturation);
  }

  /**
   * Linear scale for the Bell harmonic layer from Saturation.
   * @param {number} saturation - 0..1
   * @returns {number} scale 0..1
   */
  function bellBlendLayerScale(saturation) {
    return saturationToBellBlend(saturation);
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
   * the noise that mirrors the oscillator bell effect.
   * Gain = bellScale * relGain * CONFIG.noise.bellResonanceBoost.
   */
  function _buildNoiseHarmonicsInto(freq, bellScale, outputGain) {
    const harmonics = getBellHarmonics();
    const noiseInput = gainNoiseBell;
    const out = outputGain || masterGain;
    const resonanceBoost = CONFIG.noise.bellResonanceBoost;
    const referenceGain = harmonics[0] ? harmonics[0].gain || 1 : 1;
    harmonics.forEach(h => {
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq * h.ratio;
      f.Q.value = 8;
      const g = ctx.createGain();
      g.gain.value = bellScale * (h.gain / referenceGain) * resonanceBoost;
      noiseInput.connect(f);
      f.connect(g);
      g.connect(out);
      noiseBellFilters.push(f);
      gainNoiseWets.push({ node: g, relGain: h.gain / referenceGain });
    });
  }

  function _buildBellHarmonicsInto(freq, gainScale, oscArr, gainArr, outputGain) {
    const harmonics = getBellHarmonics();
    const out = outputGain || masterGain; // default to masterGain if not provided
    harmonics.forEach((h) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * h.ratio;
      const g = ctx.createGain();
      g.gain.value = h.gain * gainScale;
      osc.connect(g);
      g.connect(out);
      osc.start();
      oscArr.push(osc);
      gainArr.push({ node: g, baseGain: h.gain });
    });
  }

  // Bell harmonics for the primary (freqA) voice
  function createBellHarmonics(freq, gainScale, outputGain) {
    _buildBellHarmonicsInto(freq, gainScale, harmonicOscs, harmonicGains, outputGain);
  }

  // Bell harmonics for the blend (freqB) voice in the hue 270°–360° zone
  function createBellHarmonicsB(freq, gainScale, outputGain) {
    _buildBellHarmonicsInto(freq, gainScale, harmonicOscsB, harmonicGainsB, outputGain);
  }

  /**
   * Build the audio graph.
   * Called once per play session.
   */
  function buildSynthGraph(hsl) {
    const { freqA, gainA, freqB, gainB } = hueToFrequencyBlend(hsl.hue);
    const baseScale = bellBlendBaseScale(hsl.saturation);
    const bellScale = bellBlendLayerScale(hsl.saturation);
    const pinkNoiseBlend = lightnessToPinkNoiseBlend(hsl.lightness);
    const brownNoiseBlend = lightnessToBrownNoiseBlend(hsl.lightness);
    const oscScale = lightnessToOscillatorScale(hsl.lightness);
    const volScale = lightnessToVolume(hsl.lightness);

    // Primary oscillator
    oscillator = ctx.createOscillator();
    oscillator.type = CONFIG.synth.waveform;
    oscillator.frequency.value = freqA;

    gainOsc = ctx.createGain();
    gainOsc.gain.value = oscScale * baseScale * gainA;

    // Secondary oscillator — active only in hue blend zone (purple→red)
    oscillator2 = ctx.createOscillator();
    oscillator2.type = CONFIG.synth.waveform;
    oscillator2.frequency.value = freqB;

    gainOsc2 = ctx.createGain();
    gainOsc2.gain.value = oscScale * baseScale * gainB;

    // Volume control for oscillators and bell harmonics only (not for noise)
    gainOscVolume = ctx.createGain();
    gainOscVolume.gain.value = muted ? 0 : volScale;

    // Noise source (looping buffer) — bypasses volume control
    noiseSourceUpper = createLoopingNoiseSource(CONFIG.noise.upperType);
    noiseSourceLower = createLoopingNoiseSource(CONFIG.noise.lowerType);
    noiseSourceBell = createLoopingNoiseSource(CONFIG.noise.bellType);

    gainNoiseUpper = ctx.createGain();
    gainNoiseUpper.gain.value = pinkNoiseBlend * CONFIG.noise.upperMaxGain;
    gainNoiseLower = ctx.createGain();
    gainNoiseLower.gain.value = brownNoiseBlend * CONFIG.noise.lowerMaxGain;
    gainNoiseBell = ctx.createGain();
    gainNoiseBell.gain.value = 1;

    // Master gain (mute control only, volume is in gainOscVolume)
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1;

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
    gainOsc.connect(gainOscVolume);
    gainOsc2.connect(gainOscVolume);
    connectTonalPath(gainOscVolume);
    noiseSourceUpper.connect(gainNoiseUpper);
    noiseSourceLower.connect(gainNoiseLower);
    noiseSourceBell.connect(gainNoiseBell);
    gainNoiseUpper.connect(masterGain);
    gainNoiseLower.connect(masterGain);
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    // Start sources
    oscillator.start();
    oscillator2.start();
    noiseSourceUpper.start();
    noiseSourceLower.start();
    noiseSourceBell.start();

    // Bell harmonics for primary voice (freqA) and blend voice (freqB)
    // Pass gainOscVolume as the output destination
    createBellHarmonics(freqA, oscScale * bellScale * gainA, gainOscVolume);
    createBellHarmonicsB(freqB, oscScale * bellScale * gainB, gainOscVolume);
    _buildNoiseHarmonicsInto(freqA, oscScale * bellScale, gainOscVolume);
  }

  /**
   * Build the bell/piano audio graph using additive harmonic synthesis
  * layered with the same upper/lower noise paths as Synth mode.
   * Saturation low  → noisy (grey, distressed bell)
   * Saturation high → clean harmonics (vivid, pure bell/piano tone)
   */
  function buildBellGraph(hsl) {
    const freq = hueToFrequency(hsl.hue);
    const bellScale = bellBlendLayerScale(hsl.saturation);
    const pinkNoiseBlend = lightnessToPinkNoiseBlend(hsl.lightness);
    const brownNoiseBlend = lightnessToBrownNoiseBlend(hsl.lightness);
    const oscScale = lightnessToOscillatorScale(hsl.lightness);
    const volScale = lightnessToVolume(hsl.lightness);

    // Noise source (same as Synth) — bypasses volume control
    noiseSourceUpper = createLoopingNoiseSource(CONFIG.noise.upperType);
    noiseSourceLower = createLoopingNoiseSource(CONFIG.noise.lowerType);
    noiseSourceBell = createLoopingNoiseSource(CONFIG.noise.bellType);

    gainNoiseUpper = ctx.createGain();
    gainNoiseUpper.gain.value = pinkNoiseBlend * CONFIG.noise.upperMaxGain;
    gainNoiseLower = ctx.createGain();
    gainNoiseLower.gain.value = brownNoiseBlend * CONFIG.noise.lowerMaxGain;
    gainNoiseBell = ctx.createGain();
    gainNoiseBell.gain.value = 1;

    // Volume control for bell harmonics only (not for noise)
    gainOscVolume = ctx.createGain();
    gainOscVolume.gain.value = muted ? 0 : volScale;

    // Master gain (mute control only, volume is in gainOscVolume)
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1;

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -6;
    compressor.knee.value = 6;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;

    connectTonalPath(gainOscVolume);
    noiseSourceUpper.connect(gainNoiseUpper);
    noiseSourceLower.connect(gainNoiseLower);
    noiseSourceBell.connect(gainNoiseBell);
    gainNoiseUpper.connect(masterGain);
    gainNoiseLower.connect(masterGain);
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    // Additive harmonic oscillators — gain scaled by bell blend, output through gainOscVolume
    createBellHarmonics(freq, oscScale * bellScale, gainOscVolume);
    _buildNoiseHarmonicsInto(freq, oscScale * bellScale, gainOscVolume);

    noiseSourceUpper.start();
    noiseSourceLower.start();
    noiseSourceBell.start();
  }

  /**
   * Build the Theremin audio graph.
   * A pure sine oscillator with LFO vibrato layered with the same
  * upper/lower noise paths as Synth/Bell so lightness noise works identically.
   *
   * Graph:
   *   lfoOsc (sine ~5 Hz) ──► lfoGain (depth ≈ 1.2% of freq) ──► oscillator.frequency
   *   oscillator (sine) ──► gainOsc ──┐
  *   noiseSourceUpper/lower ──► gainNoiseUpper/lower ──┤
   *                                masterGain ──► compressor ──► destination
   */
  function buildThereminGraph(hsl) {
    const { freqA, gainA, freqB, gainB } = hueToFrequencyBlend(hsl.hue);
    const baseScale = bellBlendBaseScale(hsl.saturation);
    const bellScale = bellBlendLayerScale(hsl.saturation);
    const pinkNoiseBlend = lightnessToPinkNoiseBlend(hsl.lightness);
    const brownNoiseBlend = lightnessToBrownNoiseBlend(hsl.lightness);
    const oscScale = lightnessToOscillatorScale(hsl.lightness);
    const volScale = lightnessToVolume(hsl.lightness);

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
    oscillator2.type = CONFIG.theremin.waveform;
    oscillator2.frequency.value = freqB;

    gainOsc2 = ctx.createGain();
    gainOsc2.gain.value = oscScale * baseScale * gainB;

    // Volume control for oscillators and bell harmonics only (not for noise)
    gainOscVolume = ctx.createGain();
    gainOscVolume.gain.value = muted ? 0 : volScale;

    // Noise source (same as Synth/Bell) — bypasses volume control
    noiseSourceUpper = createLoopingNoiseSource(CONFIG.noise.upperType);
    noiseSourceLower = createLoopingNoiseSource(CONFIG.noise.lowerType);
    noiseSourceBell = createLoopingNoiseSource(CONFIG.noise.bellType);

    gainNoiseUpper = ctx.createGain();
    gainNoiseUpper.gain.value = pinkNoiseBlend * CONFIG.noise.upperMaxGain;
    gainNoiseLower = ctx.createGain();
    gainNoiseLower.gain.value = brownNoiseBlend * CONFIG.noise.lowerMaxGain;
    gainNoiseBell = ctx.createGain();
    gainNoiseBell.gain.value = 1;

    // Master gain (mute control only, volume is in gainOscVolume)
    masterGain = ctx.createGain();
    masterGain.gain.value = muted ? 0 : 1;

    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -6;
    compressor.knee.value = 6;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;

    oscillator.connect(gainOsc);
    oscillator2.connect(gainOsc2);
    gainOsc.connect(gainOscVolume);
    gainOsc2.connect(gainOscVolume);
    connectTonalPath(gainOscVolume);
    noiseSourceUpper.connect(gainNoiseUpper);
    noiseSourceLower.connect(gainNoiseLower);
    noiseSourceBell.connect(gainNoiseBell);
    gainNoiseUpper.connect(masterGain);
    gainNoiseLower.connect(masterGain);
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    oscillator.start();
    oscillator2.start();
    lfoOsc.start();
    noiseSourceUpper.start();
    noiseSourceLower.start();
    noiseSourceBell.start();

    // Bell harmonics for primary voice (freqA) and blend voice (freqB)
    // Pass gainOscVolume as the output destination
    createBellHarmonics(freqA, oscScale * bellScale * gainA, gainOscVolume);
    createBellHarmonicsB(freqB, oscScale * bellScale * gainB, gainOscVolume);
    _buildNoiseHarmonicsInto(freqA, oscScale * bellScale, gainOscVolume);
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
    [noiseSourceUpper, noiseSourceLower, noiseSourceBell].forEach((source, index) => {
      if (!source) return;
      try { source.stop(); } catch (_) {}
      source.disconnect();
      if (index === 0) noiseSourceUpper = null;
      if (index === 1) noiseSourceLower = null;
      if (index === 2) noiseSourceBell = null;
    });
    if (gainOsc)  { gainOsc.disconnect();  gainOsc = null; }
    if (gainOsc2) { gainOsc2.disconnect(); gainOsc2 = null; }
    if (gainOscVolume) { gainOscVolume.disconnect(); gainOscVolume = null; }
    if (gainNoiseUpper) { gainNoiseUpper.disconnect(); gainNoiseUpper = null; }
    if (gainNoiseLower) { gainNoiseLower.disconnect(); gainNoiseLower = null; }
    if (gainNoiseBell) { gainNoiseBell.disconnect(); gainNoiseBell = null; }
    noiseBellFilters.forEach(f => f.disconnect());
    noiseBellFilters = [];
    gainNoiseWets.forEach(g => g.node.disconnect());
    gainNoiseWets = [];
    if (lfoOsc) { try { lfoOsc.stop(); } catch (_) {} lfoOsc.disconnect(); lfoOsc = null; }
    if (lfoGain) { lfoGain.disconnect(); lfoGain = null; }
    if (toneFilter) { toneFilter.disconnect(); toneFilter = null; }
    if (toneDrive) { toneDrive.disconnect(); toneDrive = null; }
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
    const bellScale = bellBlendLayerScale(hsl.saturation);
    const baseScale = bellBlendBaseScale(hsl.saturation);
    const pinkNoiseBlend = lightnessToPinkNoiseBlend(hsl.lightness);
    const brownNoiseBlend = lightnessToBrownNoiseBlend(hsl.lightness);
    const oscScale = lightnessToOscillatorScale(hsl.lightness);

    if (soundMode === 'bell') {
      const freq = hueToFrequency(hsl.hue);
      harmonicOscs.forEach((osc, i) => {
        osc.frequency.setTargetAtTime(freq * harmonics[i].ratio, now, RAMP_TIME);
      });
      harmonicGains.forEach(h => {
        h.node.gain.setTargetAtTime(h.baseGain * oscScale * bellScale, now, RAMP_TIME);
      });
      if (gainNoiseUpper) {
        gainNoiseUpper.gain.setTargetAtTime(pinkNoiseBlend * CONFIG.noise.upperMaxGain, now, RAMP_TIME);
      }
      if (gainNoiseLower) {
        gainNoiseLower.gain.setTargetAtTime(brownNoiseBlend * CONFIG.noise.lowerMaxGain, now, RAMP_TIME);
      }
      noiseBellFilters.forEach((f, i) => {
        f.frequency.setTargetAtTime(freq * harmonics[i].ratio, now, RAMP_TIME);
      });
      gainNoiseWets.forEach((g, i) => {
        g.node.gain.setTargetAtTime(oscScale * bellScale * g.relGain * CONFIG.noise.bellResonanceBoost, now, RAMP_TIME);
      });
    } else if (soundMode === 'theremin') {
      const { freqA, gainA, freqB, gainB } = hueToFrequencyBlend(hsl.hue);
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
      if (gainNoiseUpper) {
        gainNoiseUpper.gain.setTargetAtTime(pinkNoiseBlend * CONFIG.noise.upperMaxGain, now, RAMP_TIME);
      }
      if (gainNoiseLower) {
        gainNoiseLower.gain.setTargetAtTime(brownNoiseBlend * CONFIG.noise.lowerMaxGain, now, RAMP_TIME);
      }
      noiseBellFilters.forEach((f, i) => {
        f.frequency.setTargetAtTime(freqA * harmonics[i].ratio, now, RAMP_TIME);
      });
      gainNoiseWets.forEach((g, i) => {
        g.node.gain.setTargetAtTime(oscScale * bellScale * g.relGain * CONFIG.noise.bellResonanceBoost, now, RAMP_TIME);
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
      if (gainNoiseUpper) {
        gainNoiseUpper.gain.setTargetAtTime(pinkNoiseBlend * CONFIG.noise.upperMaxGain, now, RAMP_TIME);
      }
      if (gainNoiseLower) {
        gainNoiseLower.gain.setTargetAtTime(brownNoiseBlend * CONFIG.noise.lowerMaxGain, now, RAMP_TIME);
      }
      noiseBellFilters.forEach((f, i) => {
        f.frequency.setTargetAtTime(freqA * harmonics[i].ratio, now, RAMP_TIME);
      });
      gainNoiseWets.forEach((g, i) => {
        g.node.gain.setTargetAtTime(oscScale * bellScale * g.relGain * CONFIG.noise.bellResonanceBoost, now, RAMP_TIME);
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

    if (gainOscVolume) {
      const targetVol = muted ? 0 : lightnessToVolume(hsl.lightness);
      gainOscVolume.gain.setTargetAtTime(targetVol, now, RAMP_TIME);
    }
    if (masterGain) {
      masterGain.gain.setTargetAtTime(muted ? 0 : 1, now, RAMP_TIME);
    }
  }

  /**
   * Toggle mute without stopping the audio graph.
   * @param {boolean} shouldMute
   * @param {number} lightness - current lightness (0..1) to restore correct volume on unmute
   */
  function setMute(shouldMute, lightness) {
    muted = shouldMute;
    if (!gainOscVolume || !ctx) return;
    const now = ctx.currentTime;
    const targetVol = muted ? 0 : lightnessToVolume(lightness);
    gainOscVolume.gain.setTargetAtTime(targetVol, now, RAMP_TIME);
    if (masterGain) {
      masterGain.gain.setTargetAtTime(muted ? 0 : 1, now, RAMP_TIME);
    }
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

    // Noise changes require new buffer builds.
    noiseBuffers = {};

    if (running) {
      teardownGraph();
      running = false;
      await ensureContext();
      buildGraph(lastHSL);
      running = true;
    }
  }

  /**
   * Apply a named instrument character preset to CONFIG and rebuild the graph.
   * The 'default' preset restores the original sound.
   * @param {string} name - key from SOUND_CHARACTER_PRESETS
   */
  async function applyCharacterPreset(name) {
    const preset = SOUND_CHARACTER_PRESETS[name];
    if (!preset) return;
    CONFIG.sound.character = name;
    const { label: _label, ...params } = preset;
    await applySettings(params);
  }

  return {
    start,
    stop,
    update,
    setMute,
    setMode,
    applySettings,
    applyCharacterPreset,
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
  const ligHint = document.getElementById("ligHint");

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

  const cfgSatBellStartRange = document.getElementById("cfgSatBellStartRange");
  const cfgSatBellEndRange = document.getElementById("cfgSatBellEndRange");
  const cfgSatBellStartInput = document.getElementById("cfgSatBellStartInput");
  const cfgSatBellEndInput = document.getElementById("cfgSatBellEndInput");

  const cfgVolStartRange = document.getElementById("cfgVolStartRange");
  const cfgVolEndRange = document.getElementById("cfgVolEndRange");
  const cfgVolStartInput = document.getElementById("cfgVolStartInput");
  const cfgVolEndInput = document.getElementById("cfgVolEndInput");

  const cfgVolMinRange = document.getElementById("cfgVolMinRange");
  const cfgVolMaxRange = document.getElementById("cfgVolMaxRange");
  const cfgVolMinInput = document.getElementById("cfgVolMinInput");
  const cfgVolMaxInput = document.getElementById("cfgVolMaxInput");

  const cfgBrownNoiseStartRange = document.getElementById("cfgBrownNoiseStartRange");
  const cfgBrownNoiseEndRange = document.getElementById("cfgBrownNoiseEndRange");
  const cfgBrownNoiseStartInput = document.getElementById("cfgBrownNoiseStartInput");
  const cfgBrownNoiseEndInput = document.getElementById("cfgBrownNoiseEndInput");

  const cfgPinkNoiseStartRange = document.getElementById("cfgPinkNoiseStartRange");
  const cfgPinkNoiseEndRange = document.getElementById("cfgPinkNoiseEndRange");
  const cfgPinkNoiseStartInput = document.getElementById("cfgPinkNoiseStartInput");
  const cfgPinkNoiseEndInput = document.getElementById("cfgPinkNoiseEndInput");

  const cfgUpperNoiseType = document.getElementById("cfgUpperNoiseType");
  const cfgLowerNoiseType = document.getElementById("cfgLowerNoiseType");
  const cfgBellNoiseType = document.getElementById("cfgBellNoiseType");
  const cfgNoiseUpperMaxGainInput = document.getElementById("cfgNoiseUpperMaxGainInput");
  const cfgNoiseLowerMaxGainInput = document.getElementById("cfgNoiseLowerMaxGainInput");
  const cfgNoiseBellBoostInput = document.getElementById("cfgNoiseBellBoostInput");
  const cfgThereminWaveform = document.getElementById("cfgThereminWaveform");
  const cfgThereminLfoRateInput = document.getElementById("cfgThereminLfoRateInput");
  const cfgThereminLfoDepthInput = document.getElementById("cfgThereminLfoDepthInput");
  const cfgBellInharmonicInput = document.getElementById("cfgBellInharmonicInput");
  const cfgBellBrightnessInput = document.getElementById("cfgBellBrightnessInput");
  const cfgSoundCharacter = document.getElementById("cfgSoundCharacter");
  const copySettingsBtn = document.getElementById("copySettingsBtn");
  const settingsCopyStatus = document.getElementById("settingsCopyStatus");

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

  function setSettingsCopyStatus(message) {
    if (settingsCopyStatus) settingsCopyStatus.textContent = message;
  }

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

  function formatSettingsJSONC(config) {
    const C = config;
    return [
      '{',
      '  // Hue slider -> pitch mapping.',
      '  "hue": {',
      `    "freqMin": ${C.hue.freqMin},`,
      `    "freqMax": ${C.hue.freqMax},`,
      `    "blendStart": ${C.hue.blendStart},`,
      `    "blendEnd": ${C.hue.blendEnd},`,
      `    "blendFreqLow": ${C.hue.blendFreqLow},`,
      `    "blendFreqHigh": ${C.hue.blendFreqHigh}`,
      '  },',
      '',
      '  // Saturation slider -> bell blend.',
      '  // bellBlendStart is the saturation with maximum bell tone.',
      '  // bellBlendEnd is the saturation where the bell layer reaches zero.',
      '  "saturation": {',
      `    "bellBlendStart": ${C.saturation.bellBlendStart},`,
      `    "bellBlendEnd": ${C.saturation.bellBlendEnd}`,
      '  },',
      '',
      '  // Lightness slider -> brown noise below mid, volume up to mid, pink noise above mid.',
      '  "lightness": {',
      `    "volumeStart": ${C.lightness.volumeStart},`,
      `    "volumeEnd": ${C.lightness.volumeEnd},`,
      `    "volumeMin": ${C.lightness.volumeMin},`,
      `    "volumeMax": ${C.lightness.volumeMax},`,
      `    "brownNoiseStart": ${C.lightness.brownNoiseStart},`,
      `    "brownNoiseEnd": ${C.lightness.brownNoiseEnd},`,
      `    "pinkNoiseStart": ${C.lightness.pinkNoiseStart},`,
      `    "pinkNoiseEnd": ${C.lightness.pinkNoiseEnd}`,
      '  },',
      '',
      '  // Global noise settings.',
      '  "noise": {',
      `    "upperType": ${JSON.stringify(C.noise.upperType)},`,
      `    "lowerType": ${JSON.stringify(C.noise.lowerType)},`,
      `    "bellType": ${JSON.stringify(C.noise.bellType)},`,
      `    "upperMaxGain": ${C.noise.upperMaxGain},`,
      `    "lowerMaxGain": ${C.noise.lowerMaxGain},`,
      `    "bellResonanceBoost": ${C.noise.bellResonanceBoost}`,
      '  },',
      '',
      '  // Theremin mode settings.',
      '  "theremin": {',
      `    "waveform": ${JSON.stringify(C.theremin.waveform)},`,
      `    "lfoRate": ${C.theremin.lfoRate},`,
      `    "lfoDepthRatio": ${C.theremin.lfoDepthRatio}`,
      '  },',
      '',
      '  // Bell harmonic settings.',
      '  // inharmonicRatio = 4.2 and brightness = 1 match the legacy bell tone.',
      '  // brightness changes overtone color while keeping overall level close to the legacy sound.',
      '  "bell": {',
      `    "inharmonicRatio": ${C.bell.inharmonicRatio},`,
      `    "brightness": ${C.bell.brightness}`,
      '  },',
      '',
      '  // Synth mode oscillator waveform (used in Synth sound mode).',
      '  "synth": {',
      `    "waveform": ${JSON.stringify(C.synth ? C.synth.waveform : 'sine')}`,
      '  },',
      '',
      '  // Tonal shaping for H-driven oscillators and harmonics only (raw L noise is not affected).',
      '  "tone": {',
      `    "filterType": ${JSON.stringify(C.tone ? C.tone.filterType : 'lowpass')},`,
      `    "filterFrequency": ${C.tone ? C.tone.filterFrequency : 20000},`,
      `    "filterQ": ${C.tone ? C.tone.filterQ : 0.0001},`,
      `    "drive": ${C.tone ? C.tone.drive : 1}`,
      '  }',
      '}',
    ].join('\n');
  }

  function formatDefaultSettingsScript(config) {
    return [
      '// Tonochrome default settings.',
      '// Replace this file with the text copied from the in-app "Copy Settings" button',
      '// to make the current tuning the new startup default.',
      'window.TONOCHROME_DEFAULT_SETTINGS_JSON = String.raw`' + formatSettingsJSONC(config),
      '`;',
    ].join('\n');
  }

  async function copySettingsToClipboard() {
    const text = formatDefaultSettingsScript(CONFIG);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const temp = document.createElement('textarea');
        temp.value = text;
        temp.setAttribute('readonly', 'true');
        temp.style.position = 'absolute';
        temp.style.left = '-9999px';
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
      }
      setSettingsCopyStatus('Copied the current defaults script. Paste it into default-settings.js to make these settings the startup default.');
      announce('Settings copied.');
    } catch (err) {
      console.error('[UI] Settings copy failed:', err);
      setSettingsCopyStatus('Copy failed. Check clipboard permissions and try again.');
    }
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

  function bindNumericInput(input, onChange) {
    const sync = () => {
      const value = parseFloat(input.value);
      if (!Number.isNaN(value)) onChange(value);
    };
    ['input', 'change'].forEach(evt => input.addEventListener(evt, sync));
    sync();
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
    cfgSatBellStartRange.value = cfgSatBellStartInput.value = C.saturation.bellBlendStart;
    cfgSatBellEndRange.value   = cfgSatBellEndInput.value   = C.saturation.bellBlendEnd;
    cfgVolStartRange.value = cfgVolStartInput.value = C.lightness.volumeStart;
    cfgVolEndRange.value   = cfgVolEndInput.value   = C.lightness.volumeEnd;
    cfgVolMinRange.value   = cfgVolMinInput.value   = C.lightness.volumeMin;
    cfgVolMaxRange.value   = cfgVolMaxInput.value   = C.lightness.volumeMax;
    cfgBrownNoiseStartRange.value = cfgBrownNoiseStartInput.value = C.lightness.brownNoiseStart;
    cfgBrownNoiseEndRange.value   = cfgBrownNoiseEndInput.value   = C.lightness.brownNoiseEnd;
    cfgPinkNoiseStartRange.value = cfgPinkNoiseStartInput.value = C.lightness.pinkNoiseStart;
    cfgPinkNoiseEndRange.value   = cfgPinkNoiseEndInput.value   = C.lightness.pinkNoiseEnd;
    cfgUpperNoiseType.value      = C.noise.upperType;
    cfgLowerNoiseType.value      = C.noise.lowerType;
    cfgBellNoiseType.value       = C.noise.bellType;
    cfgNoiseUpperMaxGainInput.value = C.noise.upperMaxGain;
    cfgNoiseLowerMaxGainInput.value = C.noise.lowerMaxGain;
    cfgNoiseBellBoostInput.value = C.noise.bellResonanceBoost;
    cfgThereminWaveform.value    = C.theremin.waveform;
    cfgThereminLfoRateInput.value  = C.theremin.lfoRate;
    cfgThereminLfoDepthInput.value = C.theremin.lfoDepthRatio;
    cfgBellInharmonicInput.value   = C.bell.inharmonicRatio;
    cfgBellBrightnessInput.value   = C.bell.brightness;
    if (cfgSoundCharacter) cfgSoundCharacter.value = C.sound ? (C.sound.character || 'default') : 'default';

    // Syncs affected controls back to CONFIG after a preset is applied.
    function syncSoundCharacterUIFromConfig() {
      const cfg = CONFIG;
      cfgNoiseUpperMaxGainInput.value  = cfg.noise.upperMaxGain;
      cfgNoiseLowerMaxGainInput.value  = cfg.noise.lowerMaxGain;
      cfgNoiseBellBoostInput.value     = cfg.noise.bellResonanceBoost;
      cfgThereminWaveform.value        = cfg.theremin.waveform;
      cfgThereminLfoRateInput.value    = cfg.theremin.lfoRate;
      cfgThereminLfoDepthInput.value   = cfg.theremin.lfoDepthRatio;
      cfgBellInharmonicInput.value     = cfg.bell.inharmonicRatio;
      cfgBellBrightnessInput.value     = cfg.bell.brightness;
    }

    if (cfgSoundCharacter) {
      cfgSoundCharacter.addEventListener('change', async () => {
        await AudioEngine.applyCharacterPreset(cfgSoundCharacter.value);
        syncSoundCharacterUIFromConfig();
        const hsl = getHSL();
        updateVisuals(hsl);
        AudioEngine.update(hsl);
      });
    }

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
      minRange: cfgSatBellStartRange, maxRange: cfgSatBellEndRange,
      minInput: cfgSatBellStartInput, maxInput: cfgSatBellEndInput,
      min: 0, max: 1, step: 0.01, integer: false, minGap: 0.01,
      onChange: (a, b) => scheduleSettingsApply({ saturation: { bellBlendStart: a, bellBlendEnd: b } }),
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
      minRange: cfgBrownNoiseStartRange, maxRange: cfgBrownNoiseEndRange,
      minInput: cfgBrownNoiseStartInput, maxInput: cfgBrownNoiseEndInput,
      min: 0, max: 1, step: 0.01, integer: false, minGap: 0.01,
      onChange: (a, b) => scheduleSettingsApply({ lightness: { brownNoiseStart: a, brownNoiseEnd: b } }),
    });

    bindDualPair({
      minRange: cfgPinkNoiseStartRange, maxRange: cfgPinkNoiseEndRange,
      minInput: cfgPinkNoiseStartInput, maxInput: cfgPinkNoiseEndInput,
      min: 0, max: 1, step: 0.01, integer: false, minGap: 0.01,
      onChange: (a, b) => scheduleSettingsApply({ lightness: { pinkNoiseStart: a, pinkNoiseEnd: b } }),
    });

    cfgUpperNoiseType.addEventListener('change', () => {
      scheduleSettingsApply({ noise: { upperType: cfgUpperNoiseType.value } });
    });

    cfgLowerNoiseType.addEventListener('change', () => {
      scheduleSettingsApply({ noise: { lowerType: cfgLowerNoiseType.value } });
    });

    cfgBellNoiseType.addEventListener('change', () => {
      scheduleSettingsApply({ noise: { bellType: cfgBellNoiseType.value } });
    });

    bindNumericInput(cfgNoiseUpperMaxGainInput, (value) => {
      scheduleSettingsApply({ noise: { upperMaxGain: value } });
    });

    bindNumericInput(cfgNoiseLowerMaxGainInput, (value) => {
      scheduleSettingsApply({ noise: { lowerMaxGain: value } });
    });

    bindNumericInput(cfgNoiseBellBoostInput, (value) => {
      scheduleSettingsApply({ noise: { bellResonanceBoost: value } });
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

    if (copySettingsBtn) {
      copySettingsBtn.addEventListener('click', copySettingsToClipboard);
    }
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
    const pinkNoiseBlend = lightnessToPinkNoiseBlend(hsl.lightness);
    const brownNoiseBlend = lightnessToBrownNoiseBlend(hsl.lightness);
    const vol = lightnessToVolume(hsl.lightness);
    const bellBlend = saturationToBellBlend(hsl.saturation);
    const noteName = frequencyToNoteName(freq);
    const bellBlendEndPct = Math.round(CONFIG.saturation.bellBlendEnd * 100);
    const volumeEndPct = Math.round(CONFIG.lightness.volumeEnd * 100);
    const brownNoiseEndPct = Math.round(CONFIG.lightness.brownNoiseEnd * 100);
    const pinkNoiseStartPct = Math.round(CONFIG.lightness.pinkNoiseStart * 100);

    if (satHint) {
      satHint.textContent = `0-${bellBlendEndPct}%: bell blend`;
    }
    if (ligHint) {
      ligHint.textContent = `0-${brownNoiseEndPct}%: brown noise + volume · ${pinkNoiseStartPct}-100%: pink noise crossfade`;
    }

    freqDisplay.textContent = `${Math.round(freq)} Hz`;
    if (brownNoiseBlend > 0) {
      noiseDisplay.textContent = `${Math.round(brownNoiseBlend * 100)}% brown`;
    } else {
      noiseDisplay.textContent = `${Math.round(pinkNoiseBlend * 100)}% pink`;
    }
    volDisplay.textContent = `${Math.round(vol * 100)}%`;
    if (noteDisplay) noteDisplay.textContent = noteName;

    // aria-valuetext: meaningful descriptions for screen readers
    hueSlider.setAttribute('aria-valuetext',
      `${hueRounded} degrees — ${noteName}, ${Math.round(freq)} Hz`);

    const bellBlendPct = Math.round(bellBlend * 100);
    let satDesc;
    if (satPct <= Math.round(CONFIG.saturation.bellBlendStart * 100)) satDesc = 'maximum bell blend';
    else if (satPct >= bellBlendEndPct) satDesc = 'no bell blend';
    else satDesc = `${bellBlendPct}% bell blend`;
    satSlider.setAttribute('aria-valuetext', `${satPct}% — ${satDesc}`);

    let ligDesc;
    if (ligPct === 0) ligDesc = 'silent';
    else if (ligPct <= volumeEndPct) ligDesc = `volume ${Math.round(vol * 100)}%`;
    else if (ligPct < pinkNoiseStartPct) ligDesc = `volume ${Math.round(vol * 100)}%, brown noise ${Math.round(brownNoiseBlend * 100)}%`;
    else ligDesc = `full volume, pink noise ${Math.round(pinkNoiseBlend * 100)}%`;
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
