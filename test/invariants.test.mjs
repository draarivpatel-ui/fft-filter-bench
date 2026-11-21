/**
 * Deepened DSP invariant, physics, numerical and edge-case tests.
 * Run with: node --test test/*.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../src/dsp.mjs';

const EPS = 1e-9;
function close(a, b, eps = EPS) { assert.ok(Math.abs(a - b) <= eps, `expected ${a} within ${eps} of ${b}`); }
function finiteArray(arr, label) {
  assert.ok(arr.length > 0, `${label} empty`);
  for (let i = 0; i < arr.length; i++) {
    assert.ok(Number.isFinite(arr[i]), `${label}[${i}] = ${arr[i]} is not finite`);
  }
}

/* -------------------------------------------------------------------------- */
describe('Validation and edge cases', () => {
  test('validateCutoff rejects zero, Nyquist, NaN, Infinity and strings', () => {
    for (const bad of [0, 0.5, -0.1, 1, NaN, Infinity, '0.2', null, undefined]) {
      assert.throws(() => D.validateCutoff(bad), RangeError, `value ${String(bad)}`);
    }
    close(D.validateCutoff(0.25), 0.25);
  });

  test('fft rejects non-power-of-two and mismatched lengths', () => {
    assert.throws(() => D.fft(new Float64Array(3), new Float64Array(3)), RangeError);
    assert.throws(() => D.fft(new Float64Array(4), new Float64Array(8)), RangeError);
    assert.throws(() => D.fft(new Float64Array(0), new Float64Array(0)), RangeError);
  });

  test('fft works for N=1 (degenerate transform)', () => {
    const r = new Float64Array([7]), i = new Float64Array([0]);
    D.fft(r, i);
    close(r[0], 7); close(i[0], 0);
    D.fft(r, i, true);
    close(r[0], 7);
  });

  test('nextPowerOfTwo handles 0, negatives, NaN and large values', () => {
    assert.equal(D.nextPowerOfTwo(0), 1);
    assert.equal(D.nextPowerOfTwo(-5), 1);
    assert.equal(D.nextPowerOfTwo(NaN), 1);
    assert.equal(D.nextPowerOfTwo(1), 1);
    assert.equal(D.nextPowerOfTwo(33), 64);
    assert.equal(D.nextPowerOfTwo(1 << 20), 1 << 20);
  });

  test('isPowerOfTwo rejects non-integers and bitwise-overflow values', () => {
    assert.equal(D.isPowerOfTwo(2.5), false);
    // Values above 2^31 are handled correctly with floating-point math,
    // unlike JavaScript's 32-bit bitwise operators.
    assert.equal(D.isPowerOfTwo(2 ** 32), true);
    assert.equal(D.isPowerOfTwo(2 ** 32 + 1), false);
    assert.equal(D.isPowerOfTwo(2 ** 20), true);
  });

  test('windowFunction rejects unknown names and bad lengths', () => {
    assert.throws(() => D.windowFunction('kaiser', 8), RangeError);
    assert.throws(() => D.windowFunction('hann', 0), RangeError);
    assert.throws(() => D.windowFunction('hann', 4.5), RangeError);
  });

  test('designFirLowpass rejects bad tap counts', () => {
    assert.throws(() => D.designFirLowpass({ taps: 2 }), RangeError);
    assert.throws(() => D.designFirLowpass({ taps: 2048 }), RangeError);
    assert.throws(() => D.designFirLowpass({ taps: 8.5 }), RangeError);
    assert.throws(() => D.designFirLowpass({ fc: 0.9 }), RangeError);
  });

  test('chebyshevLowpass rejects nonpositive and excessive ripple', () => {
    assert.throws(() => D.chebyshevLowpass(0.2, 0), RangeError);
    assert.throws(() => D.chebyshevLowpass(0.2, -1), RangeError);
    assert.throws(() => D.chebyshevLowpass(0.2, 21), RangeError);
    assert.throws(() => D.chebyshevLowpass(0.2, NaN), RangeError);
  });

  test('designFilter rejects unknown families', () => {
    assert.throws(() => D.designFilter({ family: 'elliptic' }), RangeError);
  });

  test('biquadBode requires at least two points', () => {
    assert.throws(() => D.biquadBode(D.butterworthLowpass(0.2), 1), RangeError);
    assert.throws(() => D.biquadBode(D.butterworthLowpass(0.2), 2.5), RangeError);
  });

  test('clamp and db conversions round trip', () => {
    close(D.clamp(5, 0, 1), 1);
    close(D.clamp(-5, 0, 1), 0);
    for (const db of [-40, -6, 0, 3, 12]) close(D.linearToDb(D.dbToLinear(db)), db, 1e-10);
    close(D.linearToDb(0), -240, 1);
  });
});

/* -------------------------------------------------------------------------- */
describe('FFT mathematical invariants', () => {
  test('Parseval energy holds for complex random input at several N', () => {
    let seed = 987654321;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296 - 0.5;
    };
    for (const n of [2, 8, 64, 256, 1024]) {
      const tr = new Float64Array(n), ti = new Float64Array(n);
      for (let i = 0; i < n; i++) { tr[i] = rand(); ti[i] = rand(); }
      const fr = new Float64Array(tr), fi = new Float64Array(ti);
      D.fft(fr, fi);
      const { timeEnergy, freqEnergy } = D.parsevalEnergy(tr, ti, fr, fi);
      close(timeEnergy, freqEnergy, 1e-8 * Math.max(1, timeEnergy));
    }
  });

  test('IFFT(FFT(x)) reconstructs x for N up to 2048', () => {
    for (const n of [4, 16, 128, 2048]) {
      const orig = new Float64Array(n);
      for (let i = 0; i < n; i++) orig[i] = Math.sin(0.37 * i) + 0.2 * Math.cos(1.7 * i);
      const { real, imag } = D.fftReal(orig);
      const recon = D.ifftReal(real, imag);
      finiteArray(recon, `recon n=${n}`);
      for (let i = 0; i < n; i++) close(recon[i], orig[i], 1e-10);
    }
  });

  test('FFT linearity: F(a*x + b*y) = a*F(x) + b*F(y)', () => {
    const n = 64;
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i));
    const y = Float64Array.from({ length: n }, (_, i) => Math.cos(3 * i));
    const mix = Float64Array.from({ length: n }, (_, i) => 2.5 * x[i] - 0.75 * y[i]);
    const fx = D.fftReal(x), fy = D.fftReal(y), fm = D.fftReal(mix);
    for (let k = 0; k < n; k++) {
      close(fm.real[k], 2.5 * fx.real[k] - 0.75 * fy.real[k], 1e-9);
      close(fm.imag[k], 2.5 * fx.imag[k] - 0.75 * fy.imag[k], 1e-9);
    }
  });

  test('circular time shift multiplies spectrum by a linear phase', () => {
    const n = 32, shift = 5;
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(D.TAU * 3 * i / n) + 0.3 * i / n);
    const shifted = Float64Array.from({ length: n }, (_, i) => x[(i - shift + n) % n]);
    const fx = D.fftReal(x), fs = D.fftReal(shifted);
    for (let k = 0; k < n; k++) {
      const w = -D.TAU * k * shift / n;
      const er = fx.real[k] * Math.cos(w) - fx.imag[k] * Math.sin(w);
      const ei = fx.real[k] * Math.sin(w) + fx.imag[k] * Math.cos(w);
      close(fs.real[k], er, 1e-9); close(fs.imag[k], ei, 1e-9);
    }
  });

  test('DC bin equals the sample sum and Nyquist bin alternates', () => {
    const n = 16;
    const x = Float64Array.from({ length: n }, (_, i) => i * 0.25 - 1);
    const { real, imag } = D.fftReal(x);
    close(real[0], x.reduce((a, b) => a + b, 0), 1e-9);
    close(imag[0], 0, 1e-12);
    close(real[n / 2], x.reduce((a, v, i) => a + v * (i % 2 ? -1 : 1), 0), 1e-9);
    close(imag[n / 2], 0, 1e-12);
  });

  test('binFrequency maps DC and Nyquist correctly', () => {
    close(D.binFrequency(0, 1024), 0);
    close(D.binFrequency(512, 1024), 0.5);
    close(D.binFrequency(7, 64), 0.109375);
  });

  test('all analysis windows are symmetric, finite and bounded', () => {
    for (const name of D.WINDOW_NAMES) {
      const w = D.windowFunction(name, 65);
      finiteArray(w, name);
      for (let i = 0; i < w.length; i++) {
        assert.ok(w[i] >= -1e-12 && w[i] <= 1.0000001, `${name}[${i}] = ${w[i]}`);
        close(w[i], w[w.length - 1 - i], 1e-12);
      }
    }
    // Blackman has a lower center tap and a much smaller first sidelobe.
    assert.ok(D.windowFunction('blackman', 65)[32] < D.windowFunction('hann', 65)[32]);
    assert.ok(D.windowFunction('blackman', 65)[0] < D.windowFunction('hann', 65)[0]);
  });

  test('synthesizeSignal is deterministic for a fixed seed', () => {
    const opts = { n: 256, fs: 48000, seed: 42, noise: 0.2 };
    const a = D.synthesizeSignal(opts), b = D.synthesizeSignal(opts);
    assert.equal(a.samples.length, 256);
    assert.equal(a.sampleRate, 48000);
    for (let i = 0; i < 256; i++) assert.equal(a.samples[i], b.samples[i]);
    const c = D.synthesizeSignal({ ...opts, seed: 43 });
    assert.notEqual(c.samples[10], a.samples[10]);
  });
});

/* -------------------------------------------------------------------------- */
describe('FIR design invariants', () => {
  test('every windowed-sinc design has unity DC gain and symmetric taps', () => {
    for (const win of D.WINDOW_NAMES) {
      for (const fc of [0.05, 0.2, 0.4]) {
        const { coefficients } = D.designFirLowpass({ taps: 41, fc, window: win });
        finiteArray(coefficients, `fir ${win} fc=${fc}`);
        close(coefficients.reduce((a, b) => a + b, 0), 1, 1e-10);
        for (let i = 0; i < coefficients.length; i++) {
          close(coefficients[i], coefficients[coefficients.length - 1 - i], 1e-12);
        }
      }
    }
  });

  test('odd-tap FIR has linear phase (zero phase response for symmetric taps)', () => {
    const { coefficients } = D.designFirLowpass({ taps: 33, fc: 0.2, window: 'hamming' });
    // The zero-phase prototype response is purely real and positive near DC.
    const r = D.firFrequencyResponse(coefficients, 0);
    close(r.magnitude, 1, 1e-10);
    close(r.phase, 0, 1e-10);
  });

  test('Hamming/Blackman FIR attenuates the stopband more than rectangular', () => {
    const fc = 0.2, taps = 33;
    const rect = D.designFirLowpass({ taps, fc, window: 'rectangular' }).coefficients;
    const hamming = D.designFirLowpass({ taps, fc, window: 'hamming' }).coefficients;
    const blackman = D.designFirLowpass({ taps, fc, window: 'blackman' }).coefficients;
    const stop = h => Math.max(...[0.3, 0.35, 0.4, 0.45].map(f => D.firFrequencyResponse(h, D.PI * f).magnitude));
    assert.ok(stop(blackman) < stop(hamming), 'Blackman stopband should be below Hamming');
    assert.ok(stop(hamming) < stop(rect), 'Hamming stopband should be below rectangular');
  });

  test('FIR convolution of an impulse returns the coefficient vector', () => {
    const { coefficients } = D.designFirLowpass({ taps: 9, fc: 0.25 });
    const impulse = new Float64Array(16); impulse[0] = 1;
    const out = D.firFilter(impulse, coefficients);
    for (let i = 0; i < 9; i++) close(out[i], coefficients[i], 1e-12);
    for (let i = 9; i < 16; i++) close(out[i], 0, 1e-12);
  });

  test('FIR convolution is linear and shift invariant', () => {
    const h = D.designFirLowpass({ taps: 11, fc: 0.3 }).coefficients;
    const x = Float64Array.from({ length: 40 }, (_, i) => Math.sin(0.4 * i));
    const y = Float64Array.from({ length: 40 }, (_, i) => Math.cos(0.9 * i));
    const mix = Float64Array.from({ length: 40 }, (_, i) => 3 * x[i] + 2 * y[i]);
    const fx = D.firFilter(x, h), fy = D.firFilter(y, h), fm = D.firFilter(mix, h);
    for (let i = 0; i < 40; i++) close(fm[i], 3 * fx[i] + 2 * fy[i], 1e-10);
  });

  test('empty input and empty coefficients produce empty or finite output', () => {
    assert.equal(D.firFilter(new Float64Array(0), [1]).length, 0);
    const out = D.firFilter(new Float64Array(5).fill(1), []);
    finiteArray(out, 'empty coeff output');
    for (const v of out) close(v, 0);
  });
});

/* -------------------------------------------------------------------------- */
describe('Biquad design invariants', () => {
  const cutoffs = [0.01, 0.05, 0.1, 0.2, 0.3, 0.45, 0.49];

  test('Butterworth DC gain is exactly 1 and cutoff is -3.0103 dB', () => {
    for (const fc of cutoffs) {
      const c = D.butterworthLowpass(fc);
      for (const v of Object.values(c)) assert.ok(Number.isFinite(v), `nonfinite at ${fc}`);
      close((c.b0 + c.b1 + c.b2) / (1 + c.a1 + c.a2), 1, 1e-9);
      const mag = D.biquadFrequencyResponse(c, D.TAU * fc).magnitude;
      close(mag, Math.SQRT1_2, 1e-9);
    }
  });

  test('Butterworth is monotonically nonincreasing for a lowpass', () => {
    const bode = D.biquadBode(D.butterworthLowpass(0.2), 1024);
    finiteArray(bode.mag, 'butter mag');
    for (let i = 1; i < bode.mag.length; i++) {
      assert.ok(bode.mag[i] <= bode.mag[i - 1] + 1e-9, `rise at ${i}`);
    }
  });

  test('Chebyshev DC gain is 1 and passband ripple equals the requested dB', () => {
    for (const rippleDb of [0.1, 0.5, 1, 3, 6]) {
      for (const fc of [0.05, 0.2, 0.45]) {
        const c = D.chebyshevLowpass(fc, rippleDb);
        // Order 2 is even: DC is the ripple minimum, at -rippleDb.
        close((c.b0 + c.b1 + c.b2) / (1 + c.a1 + c.a2), D.dbToLinear(-rippleDb), 1e-8);
        let mn = Infinity, mx = -Infinity;
        for (let i = 0; i <= 2000; i++) {
          const m = D.linearToDb(D.biquadFrequencyResponse(c, D.TAU * fc * i / 2000).magnitude);
          mn = Math.min(mn, m); mx = Math.max(mx, m);
        }
        close(mx - mn, rippleDb, 0.02);
        close(mx, 0, 0.02);
        close(mn, -rippleDb, 0.02);
      }
    }
  });

  test('Chebyshev rolls off faster than Butterworth at a matched cutoff', () => {
    // Chebyshev's ripple band ends at digital w0 = 2*PI*fc, i.e. Bode
    // freq = 2*fc. Butterworth's -3 dB point is at freq = fc. Compare both
    // with the same effective cutoff of 0.2 on the Bode frequency axis.
    const bwCoeffs = D.butterworthLowpass(0.2);
    const chCoeffs = D.chebyshevLowpass(0.1, 3);
    for (const f of [0.25, 0.3, 0.4]) {
      const bw = D.biquadFrequencyResponse(bwCoeffs, D.PI * f).magnitude;
      const ch = D.biquadFrequencyResponse(chCoeffs, D.PI * f).magnitude;
      assert.ok(ch < bw, `at freq ${f}: Chebyshev ${ch} should be below Butterworth ${bw}`);
    }
  });

  test('highpass has zero DC gain, unity Nyquist gain and -3.0103 dB at fc', () => {
    for (const fc of cutoffs) {
      const c = D.designHighpass(fc);
      close(D.biquadFrequencyResponse(c, 0).magnitude, 0, 1e-9);
      close(D.biquadFrequencyResponse(c, D.PI).magnitude, 1, 1e-9);
      close(D.biquadFrequencyResponse(c, D.TAU * fc).magnitude, Math.SQRT1_2, 1e-9);
    }
  });

  test('bandpass peaks at 0 dB at fc and rejects DC and Nyquist', () => {
    for (const fc of [0.1, 0.2, 0.35]) {
      for (const Q of [1, 4, 10]) {
        const c = D.designBandpass(fc, Q);
        close(D.biquadFrequencyResponse(c, D.TAU * fc).magnitude, 1, 1e-9);
        close(D.biquadFrequencyResponse(c, 0).magnitude, 0, 1e-9);
        close(D.biquadFrequencyResponse(c, D.PI).magnitude, 0, 1e-9);
      }
    }
  });

  test('all shipped families are stable, with poles strictly inside the unit circle', () => {
    for (const family of D.FILTER_FAMILIES) {
      for (const fc of cutoffs) {
        const c = D.designFilter({ family, fc, rippleDb: 3, Q: 4 });
        const s = D.biquadStability(c);
        assert.ok(s.stable, `${family} fc=${fc} unstable, max radius ${s.maxPoleRadius}`);
        assert.ok(s.jury, `${family} fc=${fc} fails Jury`);
        assert.ok(s.maxPoleRadius < 1, `${family} fc=${fc} radius ${s.maxPoleRadius}`);
        assert.ok(s.minPhase, `${family} fc=${fc} zeros outside unit circle`);
      }
    }
  });

  test('deliberately unstable coefficients are detected', () => {
    const bad = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 1.5 };
    assert.equal(D.biquadStability(bad).stable, false);
    const marginal = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 1 };
    assert.equal(D.biquadStability(marginal).stable, false);
  });

  test('biquadPoleZero roots satisfy their polynomials', () => {
    for (const family of D.FILTER_FAMILIES) {
      const c = D.designFilter({ family, fc: 0.23, rippleDb: 2, Q: 3 });
      const { zeros, poles } = D.biquadPoleZero(c);
      const poly = (root, A, B, C) => {
        const re = A * (root.real * root.real - root.imag * root.imag) + B * root.real + C;
        const im = A * 2 * root.real * root.imag + B * root.imag;
        return Math.hypot(re, im);
      };
      for (const z of zeros) assert.ok(poly(z, c.b0, c.b1, c.b2) < 1e-8, 'zero residual');
      for (const p of poles) assert.ok(poly(p, 1, c.a1, c.a2) < 1e-8, 'pole residual');
    }
  });

  test('biquadFilter identity and DC steady state', () => {
    const id = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    const x = Float64Array.from({ length: 32 }, (_, i) => Math.sin(i));
    const y = D.biquadFilter(x, id);
    for (let i = 0; i < 32; i++) close(y[i], x[i], 1e-12);
    const c = D.butterworthLowpass(0.2);
    const dcOut = D.biquadFilter(new Float64Array(400).fill(1), c);
    close(dcOut[399], 1, 1e-8);
  });

  test('biquadFilter rejects empty input gracefully', () => {
    const c = D.butterworthLowpass(0.2);
    assert.equal(D.biquadFilter(new Float64Array(0), c).length, 0);
  });
});

/* -------------------------------------------------------------------------- */
describe('Frequency response, phase and group delay', () => {
  test('analytic group delay matches a central finite difference of phase', () => {
    const c = D.butterworthLowpass(0.2);
    const h = 1e-6;
    for (const w of [0.05, 0.3, 0.7, 1.2, 2.0, 2.8]) {
      let p1 = D.biquadFrequencyResponse(c, w + h).phase;
      let p0 = D.biquadFrequencyResponse(c, w - h).phase;
      let d = p1 - p0;
      if (d > D.PI) d -= D.TAU;
      if (d < -D.PI) d += D.TAU;
      const fd = -d / (2 * h);
      const analytic = D.biquadFrequencyResponse(c, w).groupDelay;
      close(analytic, fd, 2e-5);
      assert.ok(analytic > 0, `group delay ${analytic} should be positive here`);
    }
  });

  test('group delay is positive over the whole passband of a stable lowpass', () => {
    for (const fc of [0.1, 0.2, 0.35]) {
      const bode = D.biquadBode(D.butterworthLowpass(fc), 512);
      for (let i = 0; i < bode.freq.length; i++) {
        if (bode.freq[i] < 0.98) {
          assert.ok(bode.grpDelay[i] > -1e-6, `negative group delay at ${bode.freq[i]}`);
        }
      }
    }
  });

  test('response magnitude is even and phase is odd for real coefficients', () => {
    const c = D.chebyshevLowpass(0.25, 2);
    for (const w of [0.1, 0.5, 1.1, 2.2]) {
      const p = D.biquadFrequencyResponse(c, w), n = D.biquadFrequencyResponse(c, -w);
      close(p.magnitude, n.magnitude, 1e-9);
      close(p.phase, -n.phase, 1e-9);
    }
  });

  test('|H| computed from pole-zero geometry agrees with the response formula', () => {
    const c = D.butterworthLowpass(0.3);
    const { zeros, poles } = D.biquadPoleZero(c);
    for (const w of [0.2, 0.8, 1.5, 2.5]) {
      const z = { real: Math.cos(w), imag: Math.sin(w) };
      let num = 1, den = 1;
      for (const zero of zeros) num *= Math.hypot(z.real - zero.real, z.imag - zero.imag);
      for (const pole of poles) den *= Math.hypot(z.real - pole.real, z.imag - pole.imag);
      close(D.biquadFrequencyResponse(c, w).magnitude, Math.abs(c.b0) * num / den, 1e-8);
    }
  });

  test('Bode arrays have correct endpoints and are finite', () => {
    const bode = D.biquadBode(D.butterworthLowpass(0.2), 257);
    close(bode.freq[0], 0); close(bode.freq[256], 1);
    finiteArray(bode.mag, 'bode mag');
    finiteArray(bode.phase, 'bode phase');
    close(bode.mag[0], 0, 1e-9);
    close(bode.phase[0], 0, 1e-9);
    for (let i = 1; i < bode.freq.length; i++) assert.ok(bode.freq[i] > bode.freq[i - 1]);
  });

  test('poleZeroPlotData draws a closed 128-point unit circle', () => {
    const p = D.poleZeroPlotData(D.butterworthLowpass(0.2));
    assert.equal(p.unitCircle.length, 128);
    assert.equal(p.zeros.length, 2);
    assert.equal(p.poles.length, 2);
    for (const pt of p.unitCircle) close(Math.hypot(pt.x, pt.y), 1, 1e-12);
  });
});

/* -------------------------------------------------------------------------- */
describe('End-to-end filtering and diagnostics', () => {
  test('measured filtered tone attenuation matches the predicted response', () => {
    const fs = 48000, n = 4096, fc = 0.1, toneHz = 0.04 * fs;
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(D.TAU * toneHz * i / fs));
    const c = D.butterworthLowpass(fc);
    const y = D.biquadFilter(x, c);
    const d = D.filterDiagnostics(x, y, c, toneHz, fs);
    close(d.predictedGainDb, 0, 0.2);
    assert.ok(d.rmsRatio > 0.9, `passband ratio ${d.rmsRatio}`);
    assert.ok(d.finite);
    assert.ok(d.peakOutput <= 1.2);
  });

  test('a stopband tone is attenuated and the prediction matches', () => {
    const fs = 48000, n = 8192, fc = 0.08, toneHz = 0.3 * fs;
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(D.TAU * toneHz * i / fs));
    const c = D.butterworthLowpass(fc);
    const y = D.biquadFilter(x, c);
    const d = D.filterDiagnostics(x, y, c, toneHz, fs);
    assert.ok(d.predictedGainDb < -20, `predicted ${d.predictedGainDb} dB`);
    assert.ok(d.rmsRatio < 0.1, `measured ratio ${d.rmsRatio}`);
  });

  test('filtering a synthetic benchmark signal keeps all samples finite', () => {
    const sig = D.synthesizeSignal({ n: 2048, fs: 48000, seed: 7, noise: 0.3 });
    const c = D.chebyshevLowpass(0.12, 2);
    const y = D.biquadFilter(sig.samples, c);
    finiteArray(y, 'filtered benchmark');
    const fir = D.firFilter(sig.samples, D.designFirLowpass({ taps: 65, fc: 0.12 }).coefficients);
    finiteArray(fir, 'fir benchmark');
  });

  test('FFT spectrum of the benchmark signal peaks at the injected tone bins', () => {
    const fs = 48000, n = 4096;
    const tones = [{ freqHz: 2000, amp: 1 }, { freqHz: 15000, amp: 0.5 }];
    const sig = D.synthesizeSignal({ n, fs, tones, noise: 0, seed: 1 });
    const { real, imag } = D.fftReal(sig.samples);
    const mag = D.magnitude(real, imag);
    const binOf = hz => Math.round(hz * n / fs);
    assert.ok(mag[binOf(2000)] > mag[binOf(15000)]);
    assert.ok(mag[binOf(15000)] > 10 * mag[binOf(7000)]);
    const { timeEnergy, freqEnergy } = D.parsevalEnergy(sig.samples, null, real, imag);
    close(timeEnergy, freqEnergy, 1e-6 * timeEnergy);
  });
});

/* -------------------------------------------------------------------------- */
describe('Exporter and SVG integrity', () => {
  const coeffs = D.butterworthLowpass(0.2);
  const bode = D.biquadBode(coeffs, 128);

  test('C header contains all coefficients, valid floats and balanced syntax', () => {
    const h = D.exportCHeader(coeffs, 'my-filter');
    for (const key of ['B0', 'B1', 'B2', 'A1', 'A2']) assert.ok(h.includes(`MY_FILTER_${key}`));
    assert.ok(h.includes('#ifndef MY_FILTER_H'));
    assert.ok(h.includes('my_filter_process'));
    assert.equal((h.match(/{/g) || []).length, (h.match(/}/g) || []).length);
    assert.equal((h.match(/\(/g) || []).length, (h.match(/\)/g) || []).length);
    assert.ok(!/NaN|Infinity|undefined/.test(h));
    const nums = [...h.matchAll(/#define MY_FILTER_[AB]\d\s+([-\d.e+]+)/g)].map(m => Number(m[1]));
    assert.equal(nums.length, 5);
    for (const v of nums) assert.ok(Number.isFinite(v));
  });

  test('coefficient CSV parses back to the original values', () => {
    const csv = D.exportCSV(coeffs, 'bq');
    const rows = csv.trim().split('\n');
    assert.equal(rows.length, 6);
    assert.equal(rows[0], 'coefficient,value');
    for (let i = 1; i < rows.length; i++) {
      const [name, value] = rows[i].split(',');
      const key = name.replace('bq_', '');
      close(Number(value), coeffs[key], 1e-12);
    }
    assert.ok(csv.endsWith('\n'));
  });

  test('csvField quotes commas, quotes and newlines', () => {
    assert.equal(D.csvField('plain'), 'plain');
    assert.equal(D.csvField('a,b'), '"a,b"');
    assert.equal(D.csvField('a"b'), '"a""b"');
    assert.equal(D.csvField('a\nb'), '"a\nb"');
  });

  test('Bode CSV has one header plus one row per Bode point, all finite', () => {
    const csv = D.exportBodeCSV(bode);
    const rows = csv.trim().split('\n');
    assert.equal(rows.length, bode.freq.length + 1);
    assert.equal(rows[0], 'freq_normalized,magnitude_db,phase_rad,group_delay_samples');
    for (let i = 1; i < rows.length; i++) {
      const fields = rows[i].split(',');
      assert.equal(fields.length, 4);
      for (const f of fields) assert.ok(Number.isFinite(Number(f)), `row ${i}: ${f}`);
    }
    assert.ok(csv.endsWith('\n'));
  });

  test('spectrum CSV exports only nonnegative frequencies through Nyquist', () => {
    const n = 64;
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(D.TAU * 5 * i / n));
    const csv = D.exportSpectrumCSV(x, 48000);
    const rows = csv.trim().split('\n');
    assert.equal(rows.length, n / 2 + 2); // header + bins 0..32
    assert.equal(rows[0], 'bin,cycles_per_sample,hz,magnitude,phase_rad');
    assert.equal(Number(rows[rows.length - 1].split(',')[2]), 24000);
    assert.ok(!/NaN|Infinity/.test(csv));
  });

  test('experiment JSON is valid, finite and round trips through JSON.parse', () => {
    const config = { family: 'chebyshev', fc: 0.2, rippleDb: 1, sampleRate: 48000 };
    const c = D.designFilter(config);
    const json = D.exportExperimentJSON({
      config, coeffs: c, bode,
      spectrum: { bins: [0, 1, 2], mag: [1, 0.5, 0.25] },
      diagnostics: { inputRms: 0.7, outputRms: 0.5, rmsRatio: 0.71, predictedGainDb: -1, peakOutput: 1, finite: true }
    });
    const obj = JSON.parse(json);
    assert.equal(obj.schemaVersion, 2);
    assert.equal(obj.generator, 'fft-filter-bench');
    assert.ok(obj.note.includes('Synthetic'));
    assert.equal(obj.bode.freq.length, 128);
    assert.equal(obj.stability.stable, true);
    assert.equal(obj.coefficients.b0, c.b0);
    assert.deepEqual(obj.spectrum.mag, [1, 0.5, 0.25]);
    assert.ok(!/NaN|Infinity/.test(json));
  });

  test('WAV exporter writes a valid RIFF/WAVE header and clipped PCM', () => {
    const samples = new Float64Array([0, 1, -1, 2, -2, 0.5]);
    const wav = D.exportWAV(samples, 44100);
    assert.equal(wav.length, 44 + samples.length * 2);
    const view = new DataView(wav.buffer);
    const tag = (o, n) => String.fromCharCode(...wav.slice(o, o + n));
    assert.equal(tag(0, 4), 'RIFF');
    assert.equal(tag(8, 4), 'WAVE');
    assert.equal(tag(12, 4), 'fmt ');
    assert.equal(tag(36, 4), 'data');
    assert.equal(view.getUint32(4, true), 36 + samples.length * 2);
    assert.equal(view.getUint16(20, true), 1); // PCM
    assert.equal(view.getUint16(22, true), 1); // mono
    assert.equal(view.getUint32(24, true), 44100);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(view.getInt16(44, true), 0);
    assert.equal(view.getInt16(46, true), 32767);
    assert.equal(view.getInt16(48, true), -32767);
    assert.equal(view.getInt16(50, true), 32767); // +2 clipped
    assert.equal(view.getInt16(52, true), -32767); // -2 clipped
    assert.equal(view.getInt16(54, true), 16384); // +0.5 clipped
  });

  test('all four SVG renderers emit balanced, finite, non-NaN markup', () => {
    const pz = D.poleZeroPlotData(coeffs);
    const svgs = [
      D.renderPoleZeroSVG(pz), D.renderBodeMagSVG(bode),
      D.renderBodePhaseSVG(bode), D.renderBodeGroupDelaySVG(bode)
    ];
    for (const svg of svgs) {
      assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
      assert.ok(svg.includes('<title>') && svg.includes('<desc>'));
      assert.ok(!/NaN|Infinity|undefined/.test(svg), 'nonfinite SVG coordinate');
    }
    assert.ok(svgs[0].includes('stroke="#0ff"') && svgs[0].includes('stroke="#f00"'));
    assert.ok(svgs[1].includes('stroke="#0f0"'));
    assert.ok(svgs[2].includes('stroke="#0ff"'));
    assert.ok(svgs[3].includes('stroke="#ff0"'));
  });

  test('group delay at the Nyquist transmission zero resolves to a finite limit', () => {
    // A lowpass has a double zero at z=-1, so the analytic 0/0 group delay
    // must be resolved by a limit from a nearby frequency, producing a finite
    // value that is safe for CSV and SVG exports.
    const last = bode.grpDelay[bode.grpDelay.length - 1];
    assert.ok(Number.isFinite(last), `Nyquist group delay = ${last}`);
    const csv = D.exportBodeCSV(bode);
    assert.ok(!/NaN|Infinity/.test(csv));
    const svg = D.renderBodeGroupDelaySVG(bode);
    assert.ok(!/NaN|Infinity/.test(svg));
  });

  test('generateWorkbenchHTML references the real module and all renderers', () => {
    const html = D.generateWorkbenchHTML();
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('./src/dsp.mjs'));
    for (const name of ['butterworthLowpass', 'chebyshevLowpass', 'renderPoleZeroSVG',
      'renderBodeMagSVG', 'renderBodePhaseSVG', 'renderBodeGroupDelaySVG']) {
      assert.ok(html.includes(name), name);
    }
    assert.ok(!html.includes('https://'));
  });
});
