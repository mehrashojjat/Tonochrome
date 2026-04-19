# Tonochrome

**Color → Sound (HSL)**

A minimal, zero-dependency web app that converts any HSL color into a real-time audio experience using the Web Audio API. Every HSL dimension drives a distinct audio parameter, so you *hear* color as you drag the sliders.

---

## How It Works

Tonochrome maps the three HSL channels to three acoustic dimensions:

| HSL Channel | Audio Parameter | Range | Curve |
|---|---|---|---|
| **Hue** (0–360°) | Frequency (pitch) | 110 Hz (red) → 880 Hz (purple), then 880→110 Hz blend (purple→red) | Logarithmic + linear complementary crossfade |
| **Saturation** (0–100%) | Noise blend | 100%→0% (inverted) | Linear |
| **Lightness** (0–100%) | Volume + Bell blend | 0–80% (first half), then Bell 0–100% | Linear + linear blend |

### Hue → Pitch

Hue is split into two zones:

**Zone A — 0° to 270° (red → purple):** Logarithmic ramp across three octaves. Equal angular steps feel like equal pitch intervals.

```
freq = 110 × 2^(hue/270 × 3)
```

| Hue | Colour | Frequency |
|-----|--------|-----------|
| 0° | Red | 110 Hz |
| 90° | Yellow | ~220 Hz |
| 180° | Cyan | ~440 Hz |
| 270° | Purple | 880 Hz |

**Zone B — 270° to 360° (purple → red):** The pitch stops rising. A second oscillator at 110 Hz fades in while the 880 Hz voice fades out — a **linear complementary crossfade**. The colour shift is purely a blend; no new note is introduced.

```
t = (hue − 270) / 90
gain_880Hz = 1 − t
gain_110Hz = t
```

At hue 360° only 110 Hz remains, so the circle closes seamlessly back to red/0°.

### Saturation → Noise blend

Saturation controls the balance between a **pure sine tone** and **pink noise**:

- Saturation **0%** (grey) → **100% noise**, 0% tone — you hear only textured noise
- Saturation **100%** (vivid) → **0% noise**, 100% tone — you hear a clean sine wave

The two channels are complementary and linear in the active range (`sat/NOISE_CEIL` and `1−sat/NOISE_CEIL`).

### Lightness → Volume + Bell blend

Lightness has two zones, and the behaviour applies in **Synth and Theremin modes** (in Bell mode harmonics always play at full strength):

- **0–50%**: controls master volume from silence up to maximum (capped at 80%) with a linear ramp.
- **50–100%**: volume stays at maximum while **Bell harmonics blend in** from 0% to 100% using a linear complementary blend (`base = 1−blend`, `bell = blend`). As the colour becomes brighter, the sound grows richer — a warm, piano-like harmonic layer fades in on top of the base voice.

This bell enrichment applies to **every component of the current hue sound** — including both sides of the purple→red crossfade. If the hue slider is in the 270°–360° blend zone, the 880 Hz voice gains its own bell harmonic layer (scaled by `gainA`) and the 110 Hz voice gains its own independent bell harmonic layer (scaled by `gainB`). The result is that the L slider's tonal effect is always consistent with whatever pitch blend the H slider is producing.

In **Bell mode** Lightness only controls volume (0–50% zone); the harmonic layer always runs at full strength regardless of Lightness.

---

## Sound Modes

Tonochrome has three selectable sound modes, each with a distinct audio character. All three modes share the same HSL→audio mapping rules; only the synthesis method changes.

### Synth

Two sine oscillators mixed with pink noise. Simple and neutral. In hue zone A (0°–270°) only the primary oscillator is audible; in zone B (270°–360°) a second oscillator at 110 Hz cross-fades in as the first fades toward silence.

```
OscillatorNode  (freqA) ──► gainOsc  ──┐
OscillatorNode2 (freqB) ──► gainOsc2 ──┤
AudioBufferSourceNode (noise) ──► gainNoise ──┤──► masterGain ──► DynamicsCompressor ──► destination
```

When L > 50%, a bell harmonic layer (4 partials) is added for **each** oscillator, scaled by its crossfade gain so the tonal enrichment tracks the hue blend continuously.

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

Like Synth but the primary oscillator is modulated by a slow LFO vibrato (~5 Hz), recreating the wavering, ethereal quality of a theremin. The LFO depth tracks the primary frequency (≈1.2% of pitch) so vibrato intensity stays perceptually constant across the hue range. The secondary 110 Hz blend oscillator is a steady sine (no LFO) — its stillness creates a subtle anchoring contrast when the hue is in the purple→red zone.

```
lfoOsc (sine, 5 Hz) ──► lfoGain (depth ≈ 1.2% of freqA) ──► oscillator.frequency
OscillatorNode  (freqA, vibrato) ──► gainOsc  ──┐
OscillatorNode2 (freqB, steady)  ──► gainOsc2 ──┤
AudioBufferSourceNode (noise) ──► gainNoise    ──┤──► masterGain ──► DynamicsCompressor ──► destination
```

As with Synth, when L > 50% a bell harmonic layer is added per oscillator, gated by each voice's crossfade gain.

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

Tonochrome now features a three-mode system that lets users choose their interaction style:

### Mode Selection Screen

The app launches on a **landing screen** with three mode cards displayed in a row:

| Icon | Mode | Description |
|------|------|-------------|
| 👁️ | **Blind Mode** | Real-time camera-based color detection. Designed for blind and low-vision users. |
| 🖼️ | **Photo Mode** | Load a photo and tap anywhere to sample colors. Interactive canvas-based exploration. |
| 🎛️ | **Advance Mode** | Manual HSL sliders with full audio settings and controls. Best for sighted users. |

Each card displays an icon (left), title (top right), and description (bottom right) for clarity. Clicking a card opens an instruction dialog with setup guidance.

### Blind Mode

**Design:** Two-pane vertical layout. Top half shows live camera feed; bottom half shows the current color, note name, frequency, and playback controls.

**How it works:**
1. Choose Blind Mode from the landing screen.
2. Read the intro dialog explaining camera permission and what to expect.
3. Read the **Sound Guide** — a detailed explanation of how pitch maps to hue, how noise indicates saturation, and how rumble/hiss indicate brightness.
4. Grant camera access when prompted.
5. Use the camera to point at any object. The app continuously detects and converts the color to sound in real time.
6. Tap **Play** to enable audio. Tap **Stop** to disable it. Both the app and audio engine stay in their current state — this is not a pause.
7. If your device has a flash, a **Flash button** appears in the top-right corner of the camera view.

**Sound Guide (from the dialog):**
- **Pitch (0°–360° hue) → Color:**
  - Low pitch = Red / Orange  
  - Mid pitch = Yellow / Green  
  - High pitch = Blue / Violet  
  - Highest pitch = approaching Red again (circle closes)

- **Noise (saturation 0–100%) → Vividness:**
  - Clean tone = Vivid, saturated color  
  - Rough / noisy = Muted, desaturated color  
  - Mostly noise = Grey or nearly grey

- **Rumble vs Hiss (lightness 0–100%) → Brightness:**
  - Low rumbling noise = Dark, near-black  
  - Clear tone (no noise) = Mid-brightness, natural  
  - Bright hissing noise = Light, near-white

**Accessibility:** Fully designed for blind and low-vision users with continuous audio feedback and keyboard-friendly controls.

### Photo Mode

**Design:** Three-pane vertical layout. Top bar shows the current detected color, note name, and frequency. Middle area is the interactive canvas with the loaded image. Bottom bar has Pick Image, Play, and Mute buttons.

**How it works:**
1. Choose Photo Mode from the landing screen.
2. Read the intro dialog.
3. Tap **Pick Image** to load a photo from your device gallery.
4. The image is automatically scaled and centered in the canvas (letterboxed if necessary).
5. Tap **Play** to enable audio.
6. **Tap or drag your finger** anywhere on the canvas:
   - Inside the image → the sound plays from that pixel's color
   - Outside the image (black area) → the audio engine runs but produces no sound (this is not mute — sound resumes when you tap back into the image)
7. The color bar above the canvas updates in real time showing the current detected color.

**Accessibility:** Canvas-based interaction with clear on-screen feedback. The entire canvas is clickable; tapping the letterbox area does not produce sound but does not stop the engine.

### Advance Mode

The original full UI with manual HSL sliders, all settings panels, and instrument presets. Identical to the previous version but now accessible from the mode selection screen.

**Additional control:** A **Back button** in the top-left corner returns to the mode selection screen.

### Dialog System

Each mode has an **intro dialog** explaining what happens next:
- All dialogs have a dark overlay (`#000000 @ 82% opacity`) and are centered on screen.
- Dialogs trap keyboard focus (Tab/Shift-Tab stay within the dialog).
- Press **Escape** to close any dialog and return focus to the button that opened it.
- Buttons include Cancel and OK / Accept actions.
- The Blind Mode includes a second dialog (**Sound Guide**) that explains the audio-to-color mapping before entering the mode.

---

## Accessibility

Tonochrome is designed with comprehensive accessibility in mind across all three modes.

### Screen Reader Support

**All three screens and dialogs:**
- Every focusable element has an explicit `aria-label` describing its purpose and current state.
- Regions are marked with `role="main"`, `role="img"`, `role="group"`, `role="application"`, `role="dialog"`, etc.
- A **skip link** at the top of every screen allows keyboard users to jump directly to the main content.

**Blind Mode:**
- The camera feed is labeled `aria-label="Live camera preview for color detection"`.
- The color swatch is labeled `role="img" aria-label="Current detected color swatch"`.
- The color label, note name, and frequency display use `aria-live="polite"` to announce updates as the camera detects new colors.
- The Flash button's state is reflected via `aria-pressed="true|false"`.
- Play and Mute buttons show state via `aria-pressed` and dynamically update their icon and text.

**Photo Mode:**
- The canvas is labeled `role="application"` with a detailed `aria-label` explaining how to interact.
- The color swatch and label use `aria-live="polite"` to announce changes as you tap.
- Play and Mute buttons show state via `aria-pressed`.
- The file picker is hidden but labeled with `aria-label="Choose an image file from your device"`.

**Advance Mode:**
- All sliders have `aria-label` describing the parameter (e.g. *"Hue (0–360 degrees), controls pitch"*).
- Sliders update `aria-valuetext` with meaningful descriptions as you move them:
  - Hue: *"180 degrees — A3, 220 Hz"*
  - Saturation: *"30% — 18% noise blend"*
  - Lightness: *"75% — full volume, bell blend 50%"*
- The play button shows state via `aria-pressed`.
- Settings dropdowns and numeric inputs all have associated labels.

**Global announcements:**
- A polite `aria-live` region announces key events:
  - *"Playing."* / *"Stopped."*
  - *"Muted."* / *"Unmuted."*
  - *"Synth mode."* when switching sound modes via keyboard (1 / 2 / 3).

### Keyboard Navigation

**All three screens:**
- **Tab / Shift-Tab:** Navigate between all interactive controls (buttons, sliders, inputs, links).
- **Enter / Space:** Activate focused buttons.
- **Escape:** Close any open dialog and restore focus to the button that opened it.

**Blind Mode:**
- Play button: Space or click
- Mute button: Space or click
- Back button: Space or click
- Flash button (if available): Space or click

**Photo Mode:**
- Pick Image button: Space or click (opens file picker)
- Play button: Space or click
- Mute button: Space or click
- Back button: Space or click
- Canvas: Click or tap to sample colors

**Advance Mode:**
- All keyboard shortcuts from the original version:
  - **Space** *(no focus on button)* → Play / Stop
  - **M** *(no focus on button)* → Mute / Unmute
  - **1** → Synth mode
  - **2** → Bell mode
  - **3** → Theremin mode
- Sliders use arrow keys (← → ↑ ↓) to adjust, as per native browser range input behaviour.

### Focus Management

- When a dialog opens, focus automatically moves to the first focusable element inside (usually the Cancel or OK button). A focus trap prevents Tab/Shift-Tab from leaving the dialog.
- When a dialog closes, focus returns to the button that opened it, so the user's navigation context is preserved.
- When switching screens (e.g. from Mode Selection to Blind Mode), focus moves to the Back button or the main heading of the new screen.
- All focusable elements display a bright **#c8ff00 focus ring** with a soft halo when reached by keyboard.

### Semantic HTML

- Main content is marked with `<main id="main-content">` or `role="main"`.
- Sections use `<section aria-label="...">` with clear labels.
- Headings follow a logical hierarchy (h1 on landing screen, h2 inside screens, h3 in dialogs).
- Form controls use `<label>` elements or `aria-label` where labels are not practical.
- List structures (`<ul>`, `<ol>`, `<dl>`) are used for grouped information (e.g. color sound guide).

### Colour Contrast

- All text and interactive elements meet **WCAG AA** contrast ratios (4.5:1 for normal text, 3:1 for large elements) against the `#0d0d0d` background.
- The neon chartreuse accent (`#c8ff00`) is used for focus rings, active states, and emphasis, providing high contrast.
- Audio-only feedback (sound) complements all visual feedback so information is not conveyed by colour alone.

### Touch Accessibility

- All touch targets (buttons, sliders) are at least **36 × 36 px** (8 mm) for finger-friendly interaction.
- Canvas in Photo Mode responds to both click and pointer events (pointer down + move).
- Layout is fully responsive down to **360 px viewport width** (small phones).

### High Contrast Mode Support

- All interactive elements use explicit borders and focus rings so they remain visible in **Windows High Contrast Mode** (`forced-colors: active`).
- State is conveyed using `aria-pressed`, text labels, and icons — not colour alone.

### Accessible Dialogs

- All dialogs have `role="dialog"` and `aria-modal="true"`.
- Dialogs are labeled via `aria-labelledby` pointing to the dialog title.
- Escape key closes the dialog (implemented in `ModeController._trapFocus`).
- Focus is trapped inside the dialog while it is open.
- The dialog overlay is keyboard-opaque; interactions only work on the dialog itself.

### Summary

| Dimension | Support |
|-----------|---------|
| **Keyboard navigation** | Full (Tab, Escape, arrow keys, Space, M, 1/2/3) |
| **Screen readers** | Full (ARIA labels, roles, live regions, semantic HTML) |
| **Focus management** | Full (visible focus ring, focus trapping in dialogs, focus restoration) |
| **Audio feedback** | Full (all three modes provide rich audio description of colors) |
| **High contrast** | Full (explicit borders, no colour-only feedback) |
| **Touch accessibility** | Full (36+ px targets, responsive layout) |

---

## Previous UI (Advance Mode)

| Element | Description |
|---|---|
| **Color swatch** | Live preview of the current HSL color |
| **HSL label** | Shows the exact `hsl(H, S%, L%)` string |
| **Hue slider** | 0–360°, rendered over a full-spectrum gradient |
| **Saturation slider** | 0–100%, rendered over a grey→vivid gradient |
| **Lightness slider** | 0–100%, rendered over a black→grey→white gradient |
| **Play / Stop** | Starts or stops the audio engine (default mode: Theremin) |
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

- **Section 1 — Audio mapping** (pure functions, no browser dependencies): `hueToFrequencyBlend`, `hueToFrequency`, `saturationToNoiseGain`, `saturationToOscGain`, `lightnessToVolume`, `lightnessToBellBlend`, `frequencyToNoteName`
- **Section 2 — AudioEngine** (IIFE): manages the Web Audio graph, exposes `start`, `stop`, `update`, `setMute`, `setMode`
  - `buildSynthGraph` — dual sine oscillators (hue blend) + optional dual bell harmonics (L > 50%) + pink noise
  - `buildBellGraph` — additive harmonic synthesis + pink noise
  - `buildThereminGraph` — primary oscillator with LFO vibrato + steady secondary oscillator (hue blend) + optional dual bell harmonics + pink noise
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

## Design

Tonochrome uses a dark scientific-instrument aesthetic with a neon-chartreuse (`#c8ff00`) accent on a near-black background (`#0d0d0d`):

- **Slider thumbs** are white circles for maximum contrast against all gradient tracks
- **Mode cards** display icons (left), title, and description for clear affordance
- **Dialogs** use a semi-transparent overlay and are centered on screen
- **Transitions** are short (80–180 ms) to feel immediate without being jarring
- **Focus rings** are bright neon with a soft halo for maximum visibility
- **Audio is the primary interface** — all visual information is supplemented with sound

## Running Locally
