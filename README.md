# Tonochrome

**Color → Sound (HSL)**

A minimal, zero-dependency web app that converts any HSL color into a real-time audio experience using the Web Audio API. Every HSL dimension drives a distinct audio parameter, so you *hear* color as you drag the sliders.

---

## How It Works

Tonochrome maps the three HSL channels to three acoustic dimensions:

| HSL Channel | Audio Parameter | Range | Curve |
|---|---|---|---|
| **Hue** (0–360°) | Frequency (pitch) | 110 Hz (red) → 880 Hz (purple), then 880→110 Hz blend (purple→red) | Logarithmic + equal-power crossfade |
| **Saturation** (0–100%) | Noise blend | 100%→0% (inverted) | Square-root |
| **Lightness** (0–100%) | Volume + Bell blend | 0–80% (first half), then Bell 0–100% | Power + linear blend |

### Hue → Pitch

Hue is split into two zones:

**Zone A — 0° to 270° (red → purple):** Logarithmic ramp across three octaves. Equal angular steps feel like equal pitch intervals.

```
freq = 110 × 2^(hue/360 × 3)
```

| Hue | Colour | Frequency |
|-----|--------|-----------|
| 0° | Red | 110 Hz |
| 90° | Yellow | ~220 Hz |
| 180° | Cyan | ~440 Hz |
| 270° | Purple | 880 Hz |

**Zone B — 270° to 360° (purple → red):** The pitch stops rising. A second oscillator at 110 Hz fades in while the 880 Hz voice fades out — an **equal-power crossfade** (cosine/sine curve). The colour shift is purely a blend; no new note is introduced.

```
t = (hue − 270) / 90
gain_880Hz = cos(t × π/2)
gain_110Hz = sin(t × π/2)
```

At hue 360° only 110 Hz remains, so the circle closes seamlessly back to red/0°.

### Saturation → Noise blend

Saturation controls the balance between a **pure sine tone** and **pink noise**:

- Saturation **0%** (grey) → **100% noise**, 0% tone — you hear only textured noise
- Saturation **100%** (vivid) → **0% noise**, 100% tone — you hear a clean sine wave

The two channels are complementary (`√sat` and `√(1−sat)`), so the total perceived loudness stays constant as you sweep across the range.

### Lightness → Volume + Bell blend

Lightness has two zones, and the behaviour applies in **Synth and Theremin modes** (in Bell mode harmonics always play at full strength):

- **0–50%**: controls master volume from silence up to maximum (capped at 80%) with a mild power curve for natural loudness.
- **50–100%**: volume stays at maximum while **Bell harmonics blend in** from 0% to 100% using an **equal-power crossfade** (square-root curve). As the colour becomes brighter, the sound grows richer — a warm, piano-like harmonic layer fades in on top of the base voice. At L = 100% the base voice and the bell layer sit at equal perceived loudness (each at √0.5 ≈ 71% gain).

In **Bell mode** Lightness only controls volume (0–50% zone); the harmonic layer always runs at full strength regardless of Lightness.

---

## Sound Modes

Tonochrome has three selectable sound modes, each with a distinct audio character. All three modes share the same HSL→audio mapping rules; only the synthesis method changes.

### Synth

A pure sine wave mixed with pink noise. Simple, neutral, and great for exploring the HSL mapping.

```
OscillatorNode (sine)         ──► gainOsc   ──┐
AudioBufferSourceNode (noise) ──► gainNoise ──┤──► masterGain ──► DynamicsCompressor ──► destination
```

### Bell

Additive harmonic synthesis layered with pink noise. Four sine partials (including a slightly inharmonic 4th) recreate the bright, piano-like timbre of a struck bell. Saturation sweeps from a noisy, distressed bell tone to clean, resonant harmonics.

```
OscillatorNode × 4 (harmonics, each ──► gainHarmonic) ──┐
AudioBufferSourceNode (noise)        ──► gainNoise     ──┤──► masterGain ──► DynamicsCompressor ──► destination
```

Harmonic partials:

| Partial | Ratio | Peak gain |
|---------|-------|-----------|
| Fundamental | 1× | 1.00 |
| 1st overtone (octave) | 2× | 0.50 |
| 2nd overtone | 3× | 0.20 |
| 4th overtone (inharmonic) | 4.2× | 0.08 |

### Theremin (default)

A sine oscillator with a slow LFO vibrato (~5 Hz) modulating its frequency, mixed with the same pink-noise path. This recreates the wavering, ethereal quality of a theremin. The LFO depth tracks the fundamental frequency (≈1.2% of pitch) so the vibrato intensity stays perceptually constant across the full hue range.

```
lfoOsc (sine, 5 Hz) ──► lfoGain (depth ≈ 1.2% of freq) ──► oscillator.frequency
OscillatorNode (sine) ──► gainOsc   ──┐
AudioBufferSourceNode (noise) ──► gainNoise ──┤──► masterGain ──► DynamicsCompressor ──► destination
```

---

## Audio Architecture

All parameter changes use `setTargetAtTime` with a 25 ms ramp to eliminate clicks and pops when dragging sliders or switching modes. Switching modes while audio is playing tears down the current graph and rebuilds it immediately in the new mode with no audible gap.

Common nodes across all modes:

- **AudioBufferSourceNode** — pre-generated 2-second looping pink noise buffer (Paul Kellett approximation)
- **gainOsc / gainNoise** — cross-fade tone and noise based on saturation
- **masterGain** — overall volume controlled by lightness; ramps smoothly to 0 on mute
- **DynamicsCompressor** — limiter to prevent clipping and protect against loud transients

---

## UI

| Element | Description |
|---|---|
| **Color swatch** | Live preview of the current HSL color |
| **HSL label** | Shows the exact `hsl(H, S%, L%)` string |
| **Hue slider** | 0–360°, rendered over a full-spectrum gradient |
| **Saturation slider** | 0–100%, rendered over a grey→vivid gradient |
| **Lightness slider** | 0–100%, rendered over a black→grey→white gradient |
| **Synth / Bell / Theremin** | Sound mode selector — switches the synthesis method in real time |
| **Play / Stop** | Starts or stops the audio engine |
| **Mute / Unmute** | Silences audio without stopping the engine |
| **Info panel** | Live readout: Note name, Frequency (Hz), Noise blend (%), Volume (%) |

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

- **Section 1 — Audio mapping** (pure functions, no browser dependencies): `hueToFrequency`, `saturationToNoiseGain`, `saturationToOscGain`, `lightnessToVolume`, `lightnessToBellBlend`, `frequencyToNoteName`
- **Section 2 — AudioEngine** (IIFE): manages the Web Audio graph, exposes `start`, `stop`, `update`, `setMute`, `setMode`
  - `buildSynthGraph` — sine oscillator + pink noise
  - `buildBellGraph` — additive harmonic synthesis + pink noise
  - `buildThereminGraph` — sine oscillator with LFO vibrato + pink noise
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

Tonochrome is designed to be fully usable by blind and disabled users. The audio output **is** the interface — colour is just one way to drive it. Every visual element has an accessible equivalent.

### Screen Reader Support

- **Skip link** — a visually hidden "Skip to main content" link becomes visible on focus, letting keyboard users bypass the header.
- **ARIA live regions** — two regions (polite and assertive) announce playback events:
  - When Play is pressed: *"Playing. A4, Theremin mode."*
  - When Stop is pressed: *"Stopped."*
  - When Mute / Unmute is pressed: *"Muted."* / *"Unmuted."*
  - When a sound mode is selected: *"Bell mode."*
- **Note name display** — the info panel shows both the frequency in Hz and the musical note name (e.g. *A4*, *C3*) for any hue position.
- **`aria-valuetext` on all sliders** — as you drag, the screen reader reads a meaningful description instead of a bare number:

  | Slider | Example `aria-valuetext` |
  |--------|--------------------------|
  | Hue | *"180 degrees — A3, 220 Hz"* |
  | Saturation | *"30% — 18% noise blend"* / *"0% — pure noise, no tone"* / *"100% — pure tone, no noise"* |
  | Lightness | *"75% — full volume, bell blend 50%"* / *"30% — volume 57%"* |

- **Sound Mode selector** uses `role="radiogroup"` / `role="radio"` with `aria-checked` state so screen readers announce the active mode correctly.
- All buttons use `aria-pressed` to reflect toggle state (Play/Stop, Mute/Unmute, Camera, Flash).
- The keyboard shortcuts reference is provided as a screen-reader-only `<p>` linked to the main landmark via `aria-describedby`.

### Keyboard Navigation

All functionality is reachable without a mouse or touch screen:

| Key | Action |
|-----|--------|
| **Tab / Shift-Tab** | Move focus between all interactive controls |
| **Space / Enter** | Activate the focused button or slider |
| **← → ↑ ↓** on sliders | Adjust slider value (native range behaviour) |
| **← → ↑ ↓** on Sound Mode | Navigate between Synth / Bell / Theremin and activate |
| **Space** *(no focus on button/input)* | Play / Stop |
| **M** *(no focus on button/input)* | Mute / Unmute |
| **1** | Switch to Synth mode |
| **2** | Switch to Bell mode |
| **3** | Switch to Theremin mode |

The Sound Mode selector follows the WAI-ARIA radiogroup keyboard pattern: arrow keys both move focus and activate the new mode. Only the active mode button is in the Tab order; the others are skipped and reached via arrows.

### Focus Visibility

Every focusable element shows a bright `#c8ff00` (neon chartreuse) focus ring when reached by keyboard — a ring plus a soft halo for maximum contrast against the dark background. The focus ring is visible in all supported browsers, including Firefox and Safari.

### Colour Contrast and High-Contrast Mode

- Text and interactive elements meet WCAG AA contrast ratios against the `#0d0d0d` background.
- Windows High Contrast Mode (`forced-colors: active`) is fully supported — borders, focus rings, and active states use system colours so the UI remains clear regardless of the user's colour scheme.

### Touch Accessibility

- All touch targets (sliders, buttons) are at least 36 × 36 px.
- Layout is responsive down to 360 px viewport width.
- Camera and flash buttons include clear `aria-label` text that updates dynamically (e.g. *"Switch to color mode"* when camera is active).

---

## Design

Dark scientific-instrument aesthetic with a neon-chartreuse (`#c8ff00`) accent on a near-black background (`#0d0d0d`). Slider thumbs are white circles for maximum contrast against all gradient tracks. All transitions are short (80–180 ms) to feel immediate without being jarring.
