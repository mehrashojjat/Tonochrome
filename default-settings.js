// Tonochrome default settings.
// Replace this file with the text copied from the in-app "Copy Settings" button
// to make the current tuning the new startup default.
window.TONOCHROME_DEFAULT_SETTINGS_JSON = String.raw`{
  // Hue slider -> pitch mapping.
  "hue": {
    "freqMin": 110,
    "freqMax": 880,
    "blendStart": 270,
    "blendEnd": 360,
    "blendFreqLow": 110,
    "blendFreqHigh": 880
  },

  // Saturation slider -> bell blend.
  // bellBlendStart is the saturation with maximum bell tone.
  // bellBlendEnd is the saturation where the bell layer reaches zero.
  "saturation": {
    "bellBlendStart": 0,
    "bellBlendEnd": 0.7
  },

  // Lightness slider -> brown noise below mid, volume up to mid, pink noise above mid.
  "lightness": {
    "volumeStart": 0,
    "volumeEnd": 0.5,
    "volumeMin": 0,
    "volumeMax": 1,
    "brownNoiseStart": 0,
    "brownNoiseEnd": 0.5,
    "pinkNoiseStart": 0.5,
    "pinkNoiseEnd": 1
  },

  // Global noise settings.
  "noise": {
    "upperType": "pink",
    "lowerType": "brown",
    "bellType": "pink",
    "upperMaxGain": 0.5,
    "lowerMaxGain": 0.35,
    "bellResonanceBoost": 1.2
  },

  // Theremin mode settings.
  "theremin": {
    "waveform": "sine",
    "lfoRate": 5,
    "lfoDepthRatio": 0.012
  },

  // Bell harmonic settings.
  // inharmonicRatio = 4.2 and brightness = 1 match the legacy bell tone.
  // brightness changes overtone color while keeping overall level close to that legacy sound.
  "bell": {
    "inharmonicRatio": 4.2,
    "brightness": 1
  }
}`;
