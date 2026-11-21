import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../src/dsp.cjs');

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !~= ${b} (tol ${tol})`);
const lcg = seed => () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// ---------- FFT core ----------
test('fft of a DC signal puts all energy in bin 0', () => {
  const x = new Array(16).fill(2);
  const { real, imag } = D.fftReal(x);
  close(real[0], 32, 1e-9);
  for (let k = 1; k < 16; k++) close(Math.hypot(real[k], imag[k]), 0, 1e-12);
});

test('fft twin-array form agrees with fftReal', () => {
  const x = [1, 0.5, -0.25, 0.75, 0.1, -0.4, 0.3, 0.6];
  const r = new Float64Array(x), i = new Float64Array(8);
  D.fft(r, i, false);
  const ref = D.fftReal(x);
  for (let k = 0; k < 8; k++) { close(r[k], ref.real[k], 1e-12); close(i[k], ref.imag[k], 1e-12); }
});

test('inverse fft recovers the input through the twin-array API', () => {
  const x = [1, -2, 0.5, 0.25];
  const r = new Float64Array(x), i = new Float64Array(4);
  D.fft(r, i, false);
  D.fft(r, i, true);
  for (let k = 0; k < 4; k++) close(r[k], x[k], 1e-12);
});

test('ifftReal inverts fftReal', () => {
  const rand = lcg(7);
  const x = Array.from({ length: 32 }, () => rand() * 2 - 1);
  const { real, imag } = D.fftReal(x);
  const back = D.ifftReal(real, imag);
  for (let k = 0; k < 32; k++) close(back[k], x[k], 1e-12);
});

test('Parseval randomized sweep over several sizes', () => {
  const rand = lcg(42);
  for (const N of [8, 16, 32, 64, 128, 256]) {
    const x = Array.from({ length: N }, () => rand() * 2 - 1);
    const { real, imag } = D.fftReal(x);
    const t = x.reduce((a, v) => a + v * v, 0);
    const f = Array.from(real).reduce((a, v, k) => a + v * v + imag[k] * imag[k], 0) / N;
    close(t, f, 1e-8);
    const p = D.parsevalEnergy(x, null, real, imag);
    close(p.timeEnergy, t, 1e-9);
    close(p.freqEnergy, f, 1e-9);
  }
});

test('Parseval with zero padding to nextPowerOfTwo', () => {
  const raw = [1, 2, 3, 4, 5];
  const N = D.nextPowerOfTwo(raw.length);
  assert.equal(N, 8);
  const x = raw.concat(new Array(N - raw.length).fill(0));
  const { real, imag } = D.fftReal(x);
  const t = x.reduce((a, v) => a + v * v, 0);
  const f = Array.from(real).reduce((a, v, k) => a + v * v + imag[k] * imag[k], 0) / N;
  close(t, f, 1e-9);
});

test('fft rejects non power of two lengths', () => {
  assert.throws(() => D.fftReal([1, 2, 3]));
  assert.throws(() => D.fft(new Float64Array(3), new Float64Array(3), false));
});

test('isPowerOfTwo edge cases', () => {
  assert.equal(D.isPowerOfTwo(0), false);
  assert.equal(D.isPowerOfTwo(-8), false);
  assert.equal(D.isPowerOfTwo(1), true);
  assert.equal(D.isPowerOfTwo(3), false);
  assert.equal(D.isPowerOfTwo(1024), true);
  assert.equal(D.isPowerOfTwo(2.5), false);
});

test('bitReverseIndex maps indices correctly', () => {
  assert.equal(D.bitReverseIndex(0, 3), 0);
  assert.equal(D.bitReverseIndex(1, 3), 4);
  assert.equal(D.bitReverseIndex(3, 3), 6);
  assert.equal(D.bitReverseIndex(5, 3), 5);
  assert.equal(D.bitReverseIndex(7, 3), 7);
});

test('binFrequency maps k to cycles per sample', () => {
  close(D.binFrequency(0, 8), 0);
  close(D.binFrequency(4, 8), 0.5);
  close(D.binFrequency(8, 16), 0.5);
});

test('magnitude and phase return element-wise arrays', () => {
  const m = D.magnitude([3, 1], [4, 0]);
  close(m[0], 5); close(m[1], 1);
  const p = D.phase([1, 0], [0, 1]);
  close(p[0], 0); close(p[1], Math.PI / 2);
});

// ---------- windows and FIR ----------
test('every window family produces symmetric taps', () => {
  for (const name of D.WINDOW_NAMES) {
    const w = D.windowFunction(name, 33);
    assert.equal(w.length, 33);
    for (let i = 0; i < 16; i++) close(w[i], w[32 - i], 1e-12);
  }
});

test('window endpoints follow the analytic definitions', () => {
  close(D.windowFunction('hann', 33)[0], 0, 1e-12);
  close(D.windowFunction('hamming', 33)[0], 0.08, 1e-12);
  close(D.windowFunction('blackman', 33)[0], 0, 1e-12);
  close(D.windowFunction('rectangular', 33)[0], 1);
  assert.throws(() => D.windowFunction('nope', 8), RangeError);
  assert.throws(() => D.windowFunction('hann', 0), RangeError);
});

test('designFirLowpass gives unity DC gain for every window', () => {
  for (const name of D.WINDOW_NAMES) {
    const { coefficients } = D.designFirLowpass({ fc: 0.1, taps: 33, window: name });
    close(Array.from(coefficients).reduce((a, v) => a + v, 0), 1, 1e-9);
  }
});

test('firFilter(input, taps) matches direct convolution', () => {
  const taps = [0.25, 0.5, 0.25];
  const x = [1, 2, 3, 4];
  const y = D.firFilter(x, taps);
  close(y[0], 0.25);
  close(y[1], 0.5 * 1 + 0.25 * 2);
  close(y[2], 0.25 * 1 + 0.5 * 2 + 0.25 * 3);
  close(y[3], 0.25 * 2 + 0.5 * 3 + 0.25 * 4);
});

test('designed FIR attenuates a stopband tone', () => {
  const { coefficients } = D.designFirLowpass({ fc: 0.1, taps: 63, window: 'blackman' });
  const lo = D.firFrequencyResponse(coefficients, 0.05 * D.TAU).magnitude;
  const hi = D.firFrequencyResponse(coefficients, 0.4 * D.TAU).magnitude;
  assert.ok(lo > 0.9, `passband ${lo}`);
  assert.ok(hi < 0.01, `stopband ${hi}`);
});

test('designFirLowpass validates the options', () => {
  assert.throws(() => D.designFirLowpass({ taps: 2 }), RangeError);
  assert.throws(() => D.designFirLowpass({ fc: 0.9 }), RangeError);
  assert.throws(() => D.designFirLowpass({ window: 'bartlett' }), RangeError);
});

// ---------- IIR design and stability ----------
test('lowpass biquad poles stay inside the unit circle across fc', () => {
  for (const fc of [0.001, 0.01, 0.05, 0.1, 0.25, 0.4, 0.49]) {
    const st = D.biquadStability(D.designLowpass(fc));
    assert.equal(st.stable, true, `fc=${fc} unstable`);
    assert.ok(st.maxPoleRadius < 1, `fc=${fc} pole radius ${st.maxPoleRadius}`);
  }
});

test('highpass biquad poles stay inside the unit circle across fc', () => {
  for (const fc of [0.001, 0.01, 0.1, 0.3, 0.49]) {
    const st = D.biquadStability(D.designHighpass(fc));
    assert.equal(st.stable, true, `fc=${fc} unstable`);
  }
});

test('bandpass biquad poles stay inside the unit circle across fc and Q', () => {
  for (const fc of [0.01, 0.1, 0.25, 0.4]) {
    for (const Q of [0.5, 2, 10]) {
      const st = D.biquadStability(D.designBandpass(fc, Q));
      assert.equal(st.stable, true, `fc=${fc} Q=${Q} unstable`);
    }
  }
});

test('butterworthLowpass is an alias for designLowpass at Butterworth Q', () => {
  const a = D.butterworthLowpass(0.1), b = D.designLowpass(0.1);
  for (const k of ['b0', 'b1', 'b2', 'a1', 'a2']) close(a[k], b[k], 1e-15);
  assert.equal(D.biquadStability(a).stable, true);
});

test('chebyshev poles stay inside the circle across ripple values', () => {
  for (const rp of [0.1, 0.5, 1, 3, 6]) {
    const st = D.biquadStability(D.chebyshevLowpass(0.1, rp));
    assert.equal(st.stable, true, `ripple ${rp}`);
  }
});

test('bilinear-transformed RBJ lowpass puts -3.01 dB at fc', () => {
  for (const fc of [0.01, 0.05, 0.1, 0.2, 0.3]) {
    const b = D.designLowpass(fc);
    const r = D.biquadFrequencyResponse(b, D.TAU * fc);
    close(D.linearToDb(r.magnitude), -3.0103, 0.05);
  }
});

test('chebyshev prewarped bilinear ends the ripple band at fc', () => {
  const fc = 0.1, ripple = 1;
  const b = D.chebyshevLowpass(fc, ripple);
  const atFc = D.linearToDb(D.biquadFrequencyResponse(b, D.TAU * fc).magnitude);
  // Ripple band edge must sit at -ripple dB (even order, 0 dB max).
  close(atFc, -ripple, 0.15);
  const below = D.linearToDb(D.biquadFrequencyResponse(b, D.TAU * fc * 0.5).magnitude);
  assert.ok(below >= -ripple - 0.05 && below <= 0.05, `in-band ${below}`);
});

test('designFilter dispatches every family and validates input', () => {
  for (const family of D.FILTER_FAMILIES) {
    const c = D.designFilter({ family, fc: 0.1 });
    assert.ok(Number.isFinite(c.b0));
    assert.equal(D.biquadStability(c).stable, true, family);
  }
  assert.throws(() => D.designFilter({ family: 'elliptic' }), RangeError);
});

test('validateCutoff enforces the open interval', () => {
  for (const bad of [0, -0.1, 0.5, 1, NaN, Infinity, 'x']) {
    assert.throws(() => D.validateCutoff(bad), RangeError);
  }
  close(D.validateCutoff(0.25), 0.25);
});

test('design functions reject bad Q and ripple', () => {
  assert.throws(() => D.designLowpass(0.1, 0), RangeError);
  assert.throws(() => D.designLowpass(0.1, -1), RangeError);
  assert.throws(() => D.chebyshevLowpass(0.1, 0), RangeError);
  assert.throws(() => D.chebyshevLowpass(0.1, 25), RangeError);
});

test('biquadFilter(input, coeffs) step response settles to DC gain', () => {
  const b = D.designLowpass(0.05);
  const y = D.biquadFilter(new Array(1024).fill(1), b);
  const dcGain = (b.b0 + b.b1 + b.b2) / (1 + b.a1 + b.a2);
  close(y[1023], dcGain, 1e-6);
  close(dcGain, 1, 1e-9);
});

test('highpass biquad kills DC and passes Nyquist', () => {
  const b = D.designHighpass(0.1);
  const dc = D.biquadFrequencyResponse(b, 0).magnitude;
  const ny = D.biquadFrequencyResponse(b, Math.PI).magnitude;
  close(dc, 0, 1e-9);
  close(ny, 1, 1e-6);
});

test('unstable synthetic biquad is reported unstable', () => {
  // a1 = -2.5, a2 = 1 puts a pole outside the unit circle.
  const st = D.biquadStability({ b0: 1, b1: 0, b2: 0, a1: -2.5, a2: 1 });
  assert.equal(st.stable, false);
  assert.ok(st.maxPoleRadius > 1);
});

// ---------- bode, group delay, diagnostics ----------
test('biquadBode produces n finite points over 0..1 normalized', () => {
  const b = D.designLowpass(0.1);
  const bode = D.biquadBode(b, 256);
  assert.equal(bode.freq.length, 256);
  close(bode.freq[0], 0); close(bode.freq[255], 1);
  for (const v of bode.mag) assert.ok(Number.isFinite(v));
  for (const v of bode.phase) assert.ok(Number.isFinite(v));
  for (const v of bode.grpDelay) assert.ok(Number.isFinite(v));
  assert.throws(() => D.biquadBode(b, 1), RangeError);
});

test('group delay stays finite at a transmission zero', () => {
  const b = D.designHighpass(0.1); // zeros at w=0
  const r = D.biquadFrequencyResponse(b, 0);
  assert.ok(Number.isFinite(r.groupDelay), `gd=${r.groupDelay}`);
});

test('renderBodeMagSVG never leaks NaN into the path (regression)', () => {
  const bode = { freq: [0, 0.5, 1], mag: [-Infinity, -Infinity, -Infinity], phase: [0, 0, 0], grpDelay: [0, 0, 0] };
  const svg = D.renderBodeMagSVG(bode);
  assert.ok(!svg.includes('NaN'), 'NaN leaked into SVG');
  assert.match(svg, /<svg/);
});

test('renderBodeMagSVG skips nonfinite interior samples (regression)', () => {
  const bode = { freq: [0, 0.25, 0.5, 0.75, 1], mag: [-10, NaN, -12, -Infinity, -11], phase: [0, 0, 0, 0, 0], grpDelay: [0, 0, 0, 0, 0] };
  const svg = D.renderBodeMagSVG(bode);
  assert.ok(!svg.includes('NaN'));
  assert.ok(!svg.includes('Infinity'));
});

test('phase and group delay SVGs carry img roles and labels', () => {
  const b = D.designLowpass(0.1);
  const bode = D.biquadBode(b, 128);
  for (const svg of [D.renderBodePhaseSVG(bode), D.renderBodeGroupDelaySVG(bode)]) {
    assert.ok(!svg.includes('NaN'));
    assert.match(svg, /role="img"/);
    assert.match(svg, /aria-label/);
  }
});

test('renderPoleZeroSVG emits a clean plot for a designed filter', () => {
  const data = D.poleZeroPlotData(D.designLowpass(0.1));
  const svg = D.renderPoleZeroSVG(data);
  assert.match(svg, /<svg/);
  assert.ok(!svg.includes('NaN'));
  assert.equal(data.poles.length, 2);
  assert.equal(data.unitCircle.length, 128);
});

test('filterDiagnostics reports RMS ratio, predicted gain and finiteness', () => {
  const b = D.designLowpass(0.05);
  const input = new Array(512).fill(1);
  const output = Array.from(D.biquadFilter(input, b));
  const d = D.filterDiagnostics(input, output, b, 100, 48000);
  assert.ok(d.inputRms > 0 && d.outputRms > 0);
  assert.ok(Number.isFinite(d.predictedGainDb));
  assert.equal(d.finite, true);
});

// ---------- exporters ----------
test('csvField escapes commas quotes and newlines', () => {
  assert.equal(D.csvField('plain'), 'plain');
  assert.equal(D.csvField('a,b'), '"a,b"');
  assert.equal(D.csvField('say "hi"'), '"say ""hi"""');
  assert.equal(D.csvField('a\nb'), '"a\nb"');
  assert.equal(D.csvField(7), '7');
});

test('exportCSV emits coefficient rows for a designed biquad', () => {
  const csv = D.exportCSV(D.designLowpass(0.1));
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'coefficient,value');
  assert.equal(lines.length, 6);
  assert.match(lines[1], /biquad_b0,/);
});

test('exportBodeCSV row count matches the bode length', () => {
  const bode = D.biquadBode(D.designLowpass(0.1), 16);
  const csv = D.exportBodeCSV(bode);
  assert.match(csv.split('\n')[0], /freq_normalized/);
  assert.equal(csv.trim().split('\n').length, 17);
});

test('exportSpectrumCSV covers the half spectrum with Hz column', () => {
  const csv = D.exportSpectrumCSV([1, 0, 0, 0, 0, 0, 0, 0], 8000);
  const lines = csv.trim().split('\n');
  assert.match(lines[0], /bin,cycles_per_sample,hz,magnitude,phase_rad/);
  assert.equal(lines.length, 6); // header + bins 0..4
  assert.match(lines[5], /^4,0\.50000000,4000\.0000/);
});

test('exportExperimentJSON round-trips through JSON.parse with schema', () => {
  const b = D.designLowpass(0.1);
  const bode = D.biquadBode(b, 16);
  const json = D.exportExperimentJSON({ config: { fc: 0.1 }, coeffs: b, bode, spectrum: null, diagnostics: null });
  const parsed = JSON.parse(json);
  assert.equal(parsed.schemaVersion, D.SCHEMA_VERSION);
  assert.equal(parsed.stability.stable, true);
  assert.equal(parsed.bode.freq.length, 16);
});

test('exportCHeader emits a guarded inline filter', () => {
  const h = D.exportCHeader(D.designLowpass(0.1), 'my filter!');
  assert.match(h, /#ifndef MY_FILTER__H/);
  assert.match(h, /static inline float my_filter__process/);
  assert.ok(!h.includes('NaN'));
});

test('exportWAV writes a well-formed RIFF/WAVE with matching sizes', () => {
  const wav = D.exportWAV([0, 0.5, -0.5, 0.25], 8000);
  assert.ok(wav instanceof Uint8Array);
  const str = n => String.fromCharCode(...wav.slice(n, n + 4));
  assert.equal(str(0), 'RIFF'); assert.equal(str(8), 'WAVE'); assert.equal(str(12), 'fmt '); assert.equal(str(36), 'data');
  const dv = new DataView(wav.buffer);
  assert.equal(dv.getUint32(4, true), wav.length - 8);
  assert.equal(dv.getUint32(24, true), 8000);
  assert.equal(dv.getUint16(34, true), 16);
  assert.equal(dv.getUint32(40, true), 8);
});

test('exportWAV clamps out-of-range samples to 16-bit rails', () => {
  const wav = D.exportWAV([2, -2], 8000);
  const dv = new DataView(wav.buffer);
  assert.equal(dv.getInt16(44, true), 32767);
  assert.equal(dv.getInt16(46, true), -32767);
});

// ---------- synthesis and misc ----------
test('synthesizeSignal is deterministic for a fixed seed', () => {
  const a = D.synthesizeSignal({ n: 64, noise: 0.5, seed: 9 });
  const b = D.synthesizeSignal({ n: 64, noise: 0.5, seed: 9 });
  assert.deepEqual(Array.from(a.samples), Array.from(b.samples));
  assert.equal(a.sampleRate, 48000);
  const c = D.synthesizeSignal({ n: 64, noise: 0.5, seed: 10 });
  assert.notDeepEqual(Array.from(a.samples), Array.from(c.samples));
});

test('synthesizeSignal n rounds up to a power of two', () => {
  const s = D.synthesizeSignal({ n: 100 });
  assert.equal(s.samples.length, 128);
});

test('dbToLinear and linearToDb invert', () => {
  close(D.linearToDb(D.dbToLinear(-6)), -6, 1e-9);
  close(D.dbToLinear(0), 1);
  close(D.dbToLinear(-6.0206), 0.5, 1e-3);
});

test('clamp and isFiniteNumber guard helpers', () => {
  assert.equal(D.clamp(5, 0, 3), 3);
  assert.equal(D.clamp(-5, 0, 3), 0);
  assert.equal(D.isFiniteNumber(1), true);
  assert.equal(D.isFiniteNumber(NaN), false);
  assert.equal(D.isFiniteNumber(Infinity), false);
  assert.equal(D.isFiniteNumber('1'), false);
});

test('generateWorkbenchHTML is self-contained markup', () => {
  const html = D.generateWorkbenchHTML();
  assert.match(html, /svg/i);
  assert.ok(!/src="https?:\/\//.test(html));
});

test('constants and catalogs are present', () => {
  assert.equal(D.SCHEMA_VERSION, 2);
  close(D.TAU, 2 * Math.PI);
  assert.ok(D.FILTER_FAMILIES.length >= 3);
  assert.ok(D.WINDOW_NAMES.length >= 3);
});

// ---------- stress ----------
test('fft 512-point Parseval under random input', () => {
  const rand = lcg(3);
  const x = Array.from({ length: 512 }, () => rand());
  const { real, imag } = D.fftReal(x);
  const t = x.reduce((a, v) => a + v * v, 0);
  const f = Array.from(real).reduce((a, v, k) => a + v * v + imag[k] * imag[k], 0) / 512;
  close(t, f, 1e-6);
});

test('filtered noise energy drops in a designed lowpass', () => {
  const sig = D.synthesizeSignal({ n: 256, noise: 0, tones: [{ freqHz: 20000, amp: 1 }], seed: 5 });
  const b = D.designLowpass(0.1);
  const y = D.biquadFilter(sig.samples, b);
  const rms = a => Math.sqrt(Array.from(a).reduce((s, v) => s + v * v, 0) / a.length);
  const inRms = rms(sig.samples), outRms = rms(Array.from(y).slice(64));
  assert.ok(outRms < inRms * 0.05, `ratio ${outRms / inRms}`);
});

test('fir lowpass of odd and even-len designs stays normalized', () => {
  for (const taps of [15, 33, 63, 101]) {
    const { coefficients } = D.designFirLowpass({ fc: 0.15, taps, window: 'hann' });
    assert.equal(coefficients.length, taps);
    close(Array.from(coefficients).reduce((a, v) => a + v, 0), 1, 1e-9);
  }
});

// ---------- adversarial regressions (Pass 2) ----------
test('designLowpass at the cutoff floor stays finite and stable (regression)', () => {
  const b = D.designLowpass(1e-6);
  for (const v of Object.values(b)) assert.ok(Number.isFinite(v));
  const st = D.biquadStability(b);
  assert.equal(st.stable, true);
  assert.ok(st.maxPoleRadius < 1);
});

test('cutoff floor rejects the degenerate underflow zone (regression)', () => {
  assert.throws(() => D.designLowpass(1e-9), RangeError);
  assert.throws(() => D.designHighpass(1e-9), RangeError);
  assert.throws(() => D.chebyshevLowpass(1e-9, 1), RangeError);
  assert.throws(() => D.validateCutoff(5e-7), RangeError);
});

test('near-zero Q and near-zero ripple are rejected, not NaN (regression)', () => {
  assert.throws(() => D.designLowpass(0.2, Number.MIN_VALUE), RangeError);
  assert.throws(() => D.designHighpass(0.2, 1e-9), RangeError);
  assert.throws(() => D.designBandpass(0.2, 0), RangeError);
  assert.throws(() => D.chebyshevLowpass(0.2, 1e-100), RangeError);
});

test('Jury flag agrees with pole radius at the stable boundary (regression)', () => {
  for (const fc of [1e-6, 1e-4, 0.4999]) {
    const st = D.biquadStability(D.designLowpass(fc));
    assert.equal(st.stable, true, `fc=${fc}`);
    assert.equal(st.jury, true, `fc=${fc} jury disagreement`);
  }
  const st = D.biquadStability({ b0: 1, b1: 0, b2: 0, a1: -2, a2: 1 });
  assert.equal(st.stable, false);
});

test('exportCHeader sanitizes a leading digit and rejects NaN coeffs (regression)', () => {
  const h = D.exportCHeader(D.designLowpass(0.1), '2filter');
  assert.match(h, /#ifndef _2FILTER_H/);
  assert.match(h, /_2filter_process/);
  assert.throws(() => D.exportCHeader({ b0: NaN, b1: 0, b2: 0, a1: 0, a2: 0 }), RangeError);
});

test('exportWAV validates rate and samples (regression)', () => {
  assert.throws(() => D.exportWAV([0.5], 1e10), RangeError);
  assert.throws(() => D.exportWAV([0.5], -8000), RangeError);
  assert.throws(() => D.exportWAV([0.5], 44100.5), RangeError);
  assert.throws(() => D.exportWAV([NaN], 8000), RangeError);
  assert.throws(() => D.exportWAV([Infinity], 8000), RangeError);
});

test('exportBodeCSV rejects non-finite bode values (regression)', () => {
  const bode = { freq: [0, 0.5], mag: [-3, NaN], phase: [0, 0], grpDelay: [0, 0] };
  assert.throws(() => D.exportBodeCSV(bode), RangeError);
});

test('parsevalEnergy rejects mismatched lengths (regression)', () => {
  assert.throws(() => D.parsevalEnergy([1, 2, 3, 4], null, [1, 2], [0, 0]), RangeError);
});

test('fft stage loop uses multiplication, not int32 shifts', () => {
  const { fileURLToPath } = require('node:url');
  const src = require('node:fs').readFileSync(
    fileURLToPath(new URL('../src/dsp.mjs', import.meta.url)), 'utf8');
  assert.ok(!/len\s*<<=\s*1/.test(src), 'len <<= 1 overflows int32 for N >= 2^30');
});
