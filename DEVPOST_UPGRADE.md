# FFT Filter Bench: inspect the filter from every angle at once

## Inspiration

A filter is usually judged from one graph. Magnitude alone hides the delay, the pole positions hide the stability margin, and a spectrum alone hides what the time-domain output actually looks like. We wanted one bench where changing a cutoff updates the waveform, the spectrum, the Bode response, the pole-zero plane and the numerical diagnostics together, and where every number on screen can be exported and checked.

## What it does

FFT Filter Bench is an offline browser workbench. A seeded synthetic benchmark stimulus feeds both an IIR biquad and an FIR windowed-sinc filter. Four clearly labeled synthetic presets cover voice-band cleanup, an anti-alias transition band, two-tone isolation and wideband noise.

The page draws source and filtered waveforms, windowed FFT magnitude spectra, selectable Bode magnitude / phase / group delay, the FIR impulse response and an SVG pole-zero plane. Live readouts show stability, maximum pole radius, gain at cutoff, DC group delay, input and output RMS, Parseval relative error and finite-sample status.

Four synthetic presets and every control recompute the whole experiment synchronously. Pointer and keyboard probes expose exact numerical values at any sample, bin, frequency or tap. Seven exports are generated locally: a schema-v2 JSON snapshot, coefficient CSV, Bode CSV, spectrum CSV, a C header, and 16-bit PCM WAV files of the input and the filtered output.

## How we built it

The canonical engine is `src/dsp.mjs`. It implements an in-place radix-2 decimation-in-time Cooley-Tukey FFT with bit-reversal permutation, direct-form FIR convolution, direct-form II transposed biquad filtering, windowed-sinc FIR design, RBJ-style Butterworth lowpass and highpass sections, a constant-peak bandpass, a Chebyshev Type I lowpass from analog prototype poles with a prewarped bilinear transform, quadratic pole-zero roots, the second-order Jury stability criterion and an analytic complex frequency response.

`scripts/build-bundle.mjs` strips the ES module exports and wraps the same source in a UMD factory to create `src/dsp.cjs`. The browser loads that file with a plain script tag; the Node tests require the same file and also import the canonical module. There is no duplicated algorithm.

Group delay is computed as `-d/dw arg H(e^jw)` from the logarithmic derivative of the numerator and denominator polynomials. At a transmission zero the expression becomes 0/0, so the engine evaluates the finite limit from a nearby frequency. That keeps the Bode CSV, the group-delay plot and the JSON snapshot free of NaN.

The controller keeps one state object, recomputes all derived arrays on each control change, and redraws every Canvas with a fixed aspect ratio that is independent of the mutable DPI-scaled canvas dimensions. Canvases are sized from `devicePixelRatio` with a legible minimum height. The SVG pole-zero plot is rebuilt from scratch on each redraw so no stale marks accumulate.

## Challenges

The original filter designs in this repository did not pass their own test suite. The Chebyshev lowpass had a DC gain that ranged from about 0.14 to 3.4 depending on cutoff, the Butterworth section reported +0.41 dB instead of about -3 dB at its stated cutoff, and the analytic group delay had the wrong sign, producing hundreds of negative values across the passband. Three of the original 37 tests failed.

Correcting them required choosing one frequency convention and holding it everywhere. `fc` is now cycles per sample with `w0 = 2*pi*fc`, while Bode plots use `w/pi`. The Chebyshev prewarp had to change to `wc = 2*tan(w0/2)`. Even-order Chebyshev has its passband maximum at DC, so the numerator is normalized to a 0 dB passband peak rather than a 1.0 DC gain; the ripple depth is preserved exactly. The corresponding legacy assertion was updated to check that correct invariant instead of being weakened.

Other numerical edges surfaced during deeper testing. JavaScript's 32-bit bitwise operators misclassify powers of two above 2^31, so `isPowerOfTwo` now uses safe-integer floating-point math. The double zero at Nyquist produced NaN in the Bode group-delay CSV and SVG, which the nearby-frequency limit resolves. Display clamping is applied only inside the group-delay renderer, never to exported data.

On the controller side, deriving the canvas aspect ratio from `canvas.width` and `canvas.height` made the plots grow on every resize because those attributes are rewritten for DPI scaling. Fixing that required stable per-canvas ratios. The theme toggle's `aria-pressed` state also had to reflect the active light theme rather than the button's next action.

## Accomplishments

- A 53-function DSP engine is shared between the browser bundle and the Node suite through a generated UMD build.
- Butterworth lowpass now measures -3.0103 dB at `w0` for every tested cutoff from 0.01 to 0.49.
- Chebyshev I lowpass produces the requested ripple depth within 0.02 dB across five ripple values and three cutoffs, with a 0 dB passband maximum.
- All four filter families are stable across seven cutoffs, with Jury checks passing and every pole inside the unit circle.
- Analytic group delay agrees with a central finite difference of phase to 2e-5 samples and remains positive across the lowpass passband.
- Parseval energy holds to 1e-8 relative error at transform sizes from 2 to 1024, and to 8.305e-13 on the 65,536-point timing benchmark.
- Seven local exports are verified finite, correctly named and structurally valid, including a RIFF/WAVE header with clipped PCM.
- Every shipped synthetic preset runs with all-finite samples and zero console errors in the DOM harness.

## Verification numbers

Verified on Node v26.8.1 with:

```sh
npm test
```

which runs:

```sh
node --test --test-reporter=spec test/dsp.test.mjs test/invariants.test.mjs ui.test.cjs
```

**109 passed, 0 failed, 0 skipped.**

| Verification | Observed result |
| --- | --- |
| Original engine checks | 37 tests |
| Deepened invariant and edge-case checks | 56 tests |
| DOM and controller checks | 16 tests |
| Test files | 3 |
| Browser bundle exports | 53 |
| Bode sweep points in the workbench | 512 |
| WAV export length for 2,048 samples | 4,140 bytes |
| Captured DOM console / reference errors | 0 |
| Remote script sources in index.html | 0 |
| Parseval relative error at 65,536 points | 8.305e-13 |

These results verify the implemented double-precision DSP algorithms and the local controller. They do not establish agreement with a reference filter-design library, fixed-point hardware behavior or any measured acoustic system.

## What's next

Equiripple and least-squares FIR design, higher-order cascaded biquads with stability margins per section, overlap-add FFT convolution, coefficient quantization studies and a comparison suite against an independent reference implementation would make this a stronger quantitative tool. The JSON schema already records the configuration, coefficients, stability and Bode data needed to reproduce an experiment.

## Judge demo

Open `index.html`, choose **Synthetic preset: voice-band cleanup**, then drag the cutoff slider and watch the spectrum, Bode magnitude and pole-zero markers move together. Switch the Bode view to group delay and probe near Nyquist with the arrow keys. Choose **Synthetic preset: wideband noise** to see Chebyshev ripple, then export the JSON snapshot and the filtered WAV to take the exact experiment away.
