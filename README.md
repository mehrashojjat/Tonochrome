# Tonochrome

**Color → Sound (HSL)**

A minimal, zero-dependency web app that converts any HSL color into a real-time audio experience using the Web Audio API. Every HSL dimension drives a distinct audio parameter, so you *hear* color as you drag the sliders.

---

## How It Works

Tonochrome maps the three HSL channels to three acoustic dimensions:

| HSL Channel | Audio Parameter | Range | Curve |
|---|---|---|---|
| **Hue** (0–360°) | Frequency (pitch) | 110–880 Hz | Logarithmic / 3-octave |
| **Saturation** (0–100%) | Noise blend | 100%→0% (inverted) | Square-root |
| **Lightness** (0–100%) | Master volume | 0–80% | Power curve (0.7) |

### Hue → Pitch

Hue is mapped logarithmically across three octaves (110–880 Hz) so that equal angular steps feel like equal pitch intervals. Hue 0° and 360° wrap to the same perceived pitch.

```
freq = 110 × 2^(hue/360 × 3)
```

### Saturation → Noise blend

Saturation controls the balance between a **pure sine tone** and **pink noise**:

- Saturation **0%** (grey) → **100% noise**, 0% tone — you hear only textured noise
- Saturation **100%** (vivid) → **0% noise**, 100% tone — you hear a clean sine wave

The two channels are complementary (`√sat` and `√(1−sat)`), so the total perceived loudness stays constant as you sweep across the range.

### Lightness → Volume

Lightness linearly controls the master gain with a mild power curve (`L^0.7`) for a more natural perceptual loudness ramp. Complete darkness is silence; full brightness is maximum volume (capped at 80% to protect hearing).

---

## Audio Architecture

```
OscillatorNode (sine)         ──► gainOsc   ──┐
AudioBufferSourceNode (noise) ──► gainNoise ──┤──► masterGain ──► DynamicsCompressor ──► destination
```

- **OscillatorNode** — pure sine wave, frequency set by hue
- **AudioBufferSourceNode** — pre-generated 2-second looping pink noise buffer (Paul Kellett approximation)
- **gainOsc / gainNoise** — cross-fade the two sources based on saturation
- **masterGain** — overall volume controlled by lightness; instantly ramps to 0 on mute
- **DynamicsCompressor** — acts as a limiter to prevent clipping and protect against loud transients

All parameter changes use `setTargetAtTime` with a 25 ms ramp to eliminate clicks and pops when dragging sliders.

---

## UI

| Element | Description |
|---|---|
| **Color swatch** | Live preview of the current HSL color |
| **HSL label** | Shows the exact `hsl(H, S%, L%)` string |
| **Hue slider** | 0–360°, rendered over a full-spectrum gradient |
| **Saturation slider** | 0–100%, rendered over a grey→vivid gradient |
| **Lightness slider** | 0–100%, rendered over a black→grey→white gradient |
| **Play / Stop** | Starts or stops the audio engine |
| **Mute / Unmute** | Silences audio without stopping the engine |
| **Info panel** | Live readout: Frequency (Hz), Noise blend (%), Volume (%) |

---

## Running Locally

No build tools or dependencies required. Open `index.html` directly in any modern browser:

```bash
# Option 1 — just open the file
open index.html

# Option 2 — serve with any static server
npx serve .
python3 -m http.server 8080
```

The app uses the Web Audio API, which requires a user gesture (clicking Play) before audio can start — this is a browser security requirement, not a bug.

---

## File Structure

```
Tonochrome/
├── index.html   — HTML structure and UI markup
├── app.js       — Audio engine and UI controller (vanilla JS)
└── styles.css   — Dark monochrome theme with responsive layout
```

### `app.js` modules

- **Section 1 — Audio mapping** (pure functions, no browser dependencies): `hueToFrequency`, `saturationToNoiseGain`, `saturationToOscGain`, `lightnessToVolume`
- **Section 2 — AudioEngine** (IIFE): manages the Web Audio graph, exposes `start`, `stop`, `update`, `setMute`
- **Section 3 — UI** (IIFE): reads sliders, updates visuals, wires DOM events
- **Section 4 — Bootstrap**: `DOMContentLoaded` entry point

---

## Browser Support

Requires Web Audio API support. Works in all modern browsers:

| Browser | Support |
|---|---|
| Chrome / Edge | ✅ |
| Firefox | ✅ |
| Safari (iOS & macOS) | ✅ |
| Samsung Internet | ✅ |

---

## Accessibility

- All sliders have descriptive `aria-label` attributes
- Play and Mute buttons use `aria-pressed` to reflect state
- Focus rings are visible (accent-coloured outline)
- Font is monospace (`SF Mono`, `Fira Code`, `Menlo`, `Consolas`) for readability
- Layout is responsive down to 360 px viewport width

---

## Design

Dark scientific-instrument aesthetic with a neon-chartreuse (`#c8ff00`) accent on a near-black background (`#0d0d0d`). Slider thumbs are white circles for maximum contrast against all gradient tracks. All transitions are short (80–180 ms) to feel immediate without being jarring.
