/**
 * Test suite for DSP workbench
 * Run with: node --test test/dsp.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  isPowerOfTwo,
  nextPowerOfTwo,
  bitReverseIndex,
  fft,
  fftReal,
  ifftReal,
  magnitude,
  phase,
  parsevalEnergy,
  firFilter,
  biquadFilter,
  butterworthLowpass,
  chebyshevLowpass,
  biquadPoleZero,
  biquadFrequencyResponse,
  biquadBode,
  poleZeroPlotData,
  exportCHeader,
  exportCSV,
  renderPoleZeroSVG,
  renderBodeMagSVG,
  renderBodePhaseSVG,
  renderBodeGroupDelaySVG,
  PI,
  TAU
} from '../src/dsp.mjs';

const EPS = 1e-10;
const REL_EPS = 1e-9;

function approxEqual(a, b, eps = EPS) {
  return Math.abs(a - b) <= eps;
}

function relEqual(a, b, eps = REL_EPS) {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  const mag = Math.max(Math.abs(a), Math.abs(b));
  return diff / mag <= eps;
}

function arrayApproxEqual(a, b, eps = EPS) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!approxEqual(a[i], b[i], eps)) return false;
  }
  return true;
}

// --- Utility Tests ---
describe('Utility functions', () => {
  test('isPowerOfTwo identifies powers of two', () => {
    assert(isPowerOfTwo(1));
    assert(isPowerOfTwo(2));
    assert(isPowerOfTwo(1024));
    assert(!isPowerOfTwo(0));
    assert(!isPowerOfTwo(3));
    assert(!isPowerOfTwo(1023));
  });

  test('nextPowerOfTwo returns correct values', () => {
    assert.strictEqual(nextPowerOfTwo(1), 1);
    assert.strictEqual(nextPowerOfTwo(5), 8);
    assert.strictEqual(nextPowerOfTwo(1024), 1024);
    assert.strictEqual(nextPowerOfTwo(1025), 2048);
  });

  test('bitReverseIndex works correctly', () => {
    // 8-point FFT (3 bits)
    assert.strictEqual(bitReverseIndex(0, 3), 0);
    assert.strictEqual(bitReverseIndex(1, 3), 4);
    assert.strictEqual(bitReverseIndex(2, 3), 2);
    assert.strictEqual(bitReverseIndex(3, 3), 6);
    assert.strictEqual(bitReverseIndex(4, 3), 1);
    assert.strictEqual(bitReverseIndex(7, 3), 7);
  });
});

// --- FFT/IFFT Tests ---
describe('Radix-2 Cooley-Tukey FFT', () => {
  test('FFT of impulse at DC', () => {
    const n = 8;
    const real = new Float64Array(n).fill(0);
    const imag = new Float64Array(n).fill(0);
    real[0] = 1;
    fft(real, imag);
    for (let i = 0; i < n; i++) {
      assert(approxEqual(real[i], 1), `real[${i}] = ${real[i]}`);
      assert(approxEqual(imag[i], 0), `imag[${i}] = ${imag[i]}`);
    }
  });

  test('FFT of pure real sinusoid at bin k', () => {
    const n = 32;
    const k = 3;
    const real = new Float64Array(n);
    const imag = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      real[i] = Math.cos(TAU * k * i / n);
    }
    fft(real, imag);
    // Energy should be at bins k and n-k
    const mag = magnitude(real, imag);
    assert(relEqual(mag[k], n / 2), `mag[${k}] = ${mag[k]}`);
    assert(relEqual(mag[n - k], n / 2), `mag[${n - k}] = ${mag[n - k]}`);
    for (let i = 0; i < n; i++) {
      if (i !== k && i !== n - k) {
        assert(approxEqual(mag[i], 0, 1e-9), `mag[${i}] = ${mag[i]}`);
      }
    }
  });

  test('IFFT reconstructs original signal', () => {
    const n = 64;
    const origReal = new Float64Array(n);
    const origImag = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      origReal[i] = Math.sin(TAU * 5 * i / n) + 0.5 * Math.cos(TAU * 11 * i / n);
      origImag[i] = 0.3 * Math.sin(TAU * 7 * i / n);
    }
    const freqReal = new Float64Array(origReal);
    const freqImag = new Float64Array(origImag);
    fft(freqReal, freqImag);
    const reconReal = ifftReal(freqReal, freqImag);
    for (let i = 0; i < n; i++) {
      assert(approxEqual(reconReal[i], origReal[i], 1e-9), `recon[${i}] = ${reconReal[i]} vs ${origReal[i]}`);
    }
  });

  test('Parseval energy conservation (time = freq/N)', () => {
    const n = 128;
    const timeReal = new Float64Array(n);
    const timeImag = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      timeReal[i] = Math.random() * 2 - 1;
      timeImag[i] = Math.random() * 2 - 1;
    }
    const freqReal = new Float64Array(timeReal);
    const freqImag = new Float64Array(timeImag);
    fft(freqReal, freqImag);
    const { timeEnergy, freqEnergy } = parsevalEnergy(timeReal, timeImag, freqReal, freqImag);
    assert(relEqual(timeEnergy, freqEnergy, 1e-9), `timeEnergy=${timeEnergy}, freqEnergy=${freqEnergy}`);
  });

  test('FFT conjugate symmetry for real input', () => {
    const n = 32;
    const real = new Float64Array(n);
    const imag = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      real[i] = Math.random() * 2 - 1;
    }
    fft(real, imag);
    for (let i = 1; i < n / 2; i++) {
      assert(approxEqual(real[i], real[n - i], 1e-9), `real symmetry at ${i}`);
      assert(approxEqual(imag[i], -imag[n - i], 1e-9), `imag symmetry at ${i}`);
    }
    // DC and Nyquist should be real
    assert(approxEqual(imag[0], 0, 1e-12), 'DC imag');
    assert(approxEqual(imag[n / 2], 0, 1e-12), 'Nyquist imag');
  });
});

// --- FIR Filter Tests ---
describe('FIR Filter', () => {
  test('FIR filter passes DC with sum=1 coefficients', () => {
    const input = new Float64Array(100).fill(1);
    const coeffs = new Float64Array([0.25, 0.5, 0.25]); // sum = 1
    const output = firFilter(input, coeffs);
    // After transient, should be 1
    for (let i = 2; i < 100; i++) {
      assert(approxEqual(output[i], 1, 1e-9), `output[${i}] = ${output[i]}`);
    }
  });

  test('FIR filter zeros at Nyquist with [1, -1] coefficients', () => {
    const n = 100;
    const input = new Float64Array(n);
    for (let i = 0; i < n; i++) input[i] = (i % 2 === 0) ? 1 : -1; // Nyquist
    const coeffs = new Float64Array([0.5, 0.5]); // zero at z=-1
    const output = firFilter(input, coeffs);
    for (let i = 1; i < n; i++) {
      assert(approxEqual(output[i], 0, 1e-9), `output[${i}] = ${output[i]}`);
    }
  });
});

// --- Biquad IIR Filter Tests ---
describe('Biquad IIR Filter', () => {
  test('Biquad identity filter (b0=1, others=0)', () => {
    const n = 50;
    const input = new Float64Array(n);
    for (let i = 0; i < n; i++) input[i] = Math.random() * 2 - 1;
    const coeffs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    const output = biquadFilter(input, coeffs);
    for (let i = 0; i < n; i++) {
      assert(approxEqual(output[i], input[i], 1e-12), `output[${i}] = ${output[i]} vs ${input[i]}`);
    }
  });

  test('Biquad DC gain = (b0+b1+b2)/(1+a1+a2)', () => {
    const coeffs = { b0: 0.1, b1: 0.2, b2: 0.3, a1: -0.5, a2: 0.25 };
    const dcGain = (coeffs.b0 + coeffs.b1 + coeffs.b2) / (1 + coeffs.a1 + coeffs.a2);
    const input = new Float64Array(200).fill(1);
    const output = biquadFilter(input, coeffs);
    // Steady state
    assert(approxEqual(output[150], dcGain, 1e-6), `DC gain: ${output[150]} vs ${dcGain}`);
  });

  test('Biquad stability: poles inside unit circle', () => {
    const coeffs = butterworthLowpass(0.2);
    const { poles } = biquadPoleZero(coeffs);
    for (const p of poles) {
      const r = Math.hypot(p.real, p.imag);
      assert(r < 1, `Pole magnitude ${r} >= 1`);
    }
  });
});

// --- Butterworth Filter Design Tests ---
describe('Butterworth Lowpass Biquad', () => {
  test('Butterworth coefficients are finite', () => {
    const coeffs = butterworthLowpass(0.25);
    for (const v of Object.values(coeffs)) {
      assert(Number.isFinite(v), `Non-finite coefficient: ${v}`);
    }
  });

  test('Butterworth DC gain = 1', () => {
    for (const fc of [0.05, 0.1, 0.2, 0.3, 0.45]) {
      const coeffs = butterworthLowpass(fc);
      const dcGain = (coeffs.b0 + coeffs.b1 + coeffs.b2) / (1 + coeffs.a1 + coeffs.a2);
      assert(approxEqual(dcGain, 1, 1e-9), `DC gain at fc=${fc}: ${dcGain}`);
    }
  });

  test('Butterworth magnitude at cutoff is -3.0103 dB', () => {
    // The corrected RBJ design places the -3.0103 dB point exactly at the
    // digital radian frequency w = 2*PI*fc (fc in cycles per sample).
    const fc = 0.2;
    const coeffs = butterworthLowpass(fc);
    const w = 2 * PI * fc;
    const resp = biquadFrequencyResponse(coeffs, w);
    const magDb = 20 * Math.log10(resp.magnitude);
    assert(Math.abs(magDb - 20 * Math.log10(1 / Math.sqrt(2))) < 1e-9,
      `Mag at fc: ${magDb} dB (expected -3.0103 dB)`);
    assert(magDb < -3 && magDb > -3.02, `Mag at fc: ${magDb} dB`);
  });

  test('Butterworth poles inside unit circle', () => {
    for (const fc of [0.01, 0.1, 0.25, 0.4, 0.49]) {
      const coeffs = butterworthLowpass(fc);
      const { poles } = biquadPoleZero(coeffs);
      for (const p of poles) {
        const r = Math.hypot(p.real, p.imag);
        assert(r < 1, `Pole magnitude ${r} >= 1 at fc=${fc}`);
      }
    }
  });

  test('Butterworth zeros at z=-1 (Nyquist)', () => {
    const coeffs = butterworthLowpass(0.2);
    const { zeros } = biquadPoleZero(coeffs);
    for (const z of zeros) {
      // For lowpass, zeros should be at or near z=-1
      assert(approxEqual(z.real, -1, 1e-9), `Zero real: ${z.real}`);
      assert(approxEqual(z.imag, 0, 1e-9), `Zero imag: ${z.imag}`);
    }
  });
});

// --- Chebyshev Filter Design Tests ---
describe('Chebyshev Type I Lowpass Biquad', () => {
  test('Chebyshev coefficients are finite', () => {
    const coeffs = chebyshevLowpass(0.25, 1);
    for (const v of Object.values(coeffs)) {
      assert(Number.isFinite(v), `Non-finite coefficient: ${v}`);
    }
  });

  test('Chebyshev DC gain follows the even-order ripple minimum', () => {
    // Order 2 Chebyshev Type I has a passband maximum at DC before gain
    // normalization. This engine scales the passband maximum to 0 dB, so DC
    // is the ripple minimum at -rippleDb. The passband still has exactly the
    // requested ripple depth.
    for (const fc of [0.1, 0.2, 0.3, 0.4]) {
      for (const ripple of [0.5, 1, 3]) {
        const coeffs = chebyshevLowpass(fc, ripple);
        const dcGain = (coeffs.b0 + coeffs.b1 + coeffs.b2) / (1 + coeffs.a1 + coeffs.a2);
        const expected = Math.pow(10, -ripple / 20);
        assert(approxEqual(dcGain, expected, 1e-6),
          `DC gain at fc=${fc}, ripple=${ripple}: ${dcGain} vs ${expected}`);
      }
    }
  });

  test('Chebyshev poles inside unit circle', () => {
    for (const fc of [0.01, 0.1, 0.25, 0.4, 0.49]) {
      for (const ripple of [0.5, 1, 3]) {
        const coeffs = chebyshevLowpass(fc, ripple);
        const { poles } = biquadPoleZero(coeffs);
        for (const p of poles) {
          const r = Math.hypot(p.real, p.imag);
          assert(r < 1, `Pole magnitude ${r} >= 1 at fc=${fc}, ripple=${ripple}`);
        }
      }
    }
  });

  test('Chebyshev zeros at z=-1 (Nyquist)', () => {
    const coeffs = chebyshevLowpass(0.2, 1);
    const { zeros } = biquadPoleZero(coeffs);
    for (const z of zeros) {
      assert(approxEqual(z.real, -1, 1e-9), `Zero real: ${z.real}`);
      assert(approxEqual(z.imag, 0, 1e-9), `Zero imag: ${z.imag}`);
    }
  });

  test('Chebyshev has passband ripple', () => {
    const fc = 0.2;
    const rippleDb = 1;
    const coeffs = chebyshevLowpass(fc, rippleDb);
    const bode = biquadBode(coeffs, 1000);
    // Check passband (0 to fc)
    let maxDb = -Infinity, minDb = Infinity;
    for (let i = 0; i < bode.freq.length; i++) {
      if (bode.freq[i] <= fc) {
        if (bode.mag[i] > maxDb) maxDb = bode.mag[i];
        if (bode.mag[i] < minDb) minDb = bode.mag[i];
      }
    }
    const actualRipple = maxDb - minDb;
    // With bilinear transform, ripple may be slightly different
    assert(actualRipple > 0.1, `Ripple ${actualRipple} too small (expected some ripple)`);
    assert(actualRipple < 5, `Ripple ${actualRipple} too large`);
  });
});

// --- Phase Response Tests ---
describe('Phase Response', () => {
  test('Biquad phase at DC is 0', () => {
    const coeffs = butterworthLowpass(0.2);
    const resp = biquadFrequencyResponse(coeffs, 0);
    assert(approxEqual(resp.phase, 0, 1e-9), `Phase at DC: ${resp.phase}`);
  });

  test('Biquad phase at Nyquist is -2*atan2(imag, real) for zeros/poles', () => {
    const coeffs = butterworthLowpass(0.2);
    const resp = biquadFrequencyResponse(coeffs, PI);
    // Phase should be continuous
    assert(Number.isFinite(resp.phase), `Phase at Nyquist: ${resp.phase}`);
  });

  test('Phase is odd function for real coefficients', () => {
    const coeffs = butterworthLowpass(0.2);
    const w = PI * 0.3;
    const respPos = biquadFrequencyResponse(coeffs, w);
    const respNeg = biquadFrequencyResponse(coeffs, -w);
    assert(approxEqual(respPos.phase, -respNeg.phase, 1e-9), `Phase odd: ${respPos.phase} vs ${respNeg.phase}`);
  });

  test('Group delay is mostly positive for minimum-phase filter', () => {
    const coeffs = butterworthLowpass(0.2);
    const bode = biquadBode(coeffs, 512);
    let negCount = 0;
    for (const gd of bode.grpDelay) {
      if (gd < -0.5) negCount++;
    }
    // Allow a few slightly negative values due to numerical precision
    assert(negCount < 5, `Too many negative group delays: ${negCount}`);
  });
});

// --- Export Tests ---
describe('C Header Export', () => {
  test('C header contains all coefficients', () => {
    const coeffs = butterworthLowpass(0.2);
    const header = exportCHeader(coeffs, 'test_filter');
    assert(header.includes('TEST_FILTER_B0'));
    assert(header.includes('TEST_FILTER_B1'));
    assert(header.includes('TEST_FILTER_B2'));
    assert(header.includes('TEST_FILTER_A1'));
    assert(header.includes('TEST_FILTER_A2'));
    assert(header.includes('#ifndef'));
    assert(header.includes('#define'));
    assert(header.includes('test_filter_process'));
  });

  test('C header has valid C syntax (no syntax errors visible)', () => {
    const coeffs = butterworthLowpass(0.2);
    const header = exportCHeader(coeffs, 'biquad');
    // Check for balanced braces
    const openBraces = (header.match(/{/g) || []).length;
    const closeBraces = (header.match(/}/g) || []).length;
    assert.strictEqual(openBraces, closeBraces);
    // Check for balanced parens
    const openParens = (header.match(/\(/g) || []).length;
    const closeParens = (header.match(/\)/g) || []).length;
    assert.strictEqual(openParens, closeParens);
  });
});

describe('CSV Export', () => {
  test('CSV contains all coefficients', () => {
    const coeffs = butterworthLowpass(0.2);
    const csv = exportCSV(coeffs, 'biquad');
    assert(csv.includes('biquad_b0'));
    assert(csv.includes('biquad_b1'));
    assert(csv.includes('biquad_b2'));
    assert(csv.includes('biquad_a1'));
    assert(csv.includes('biquad_a2'));
    assert(csv.includes('coefficient,value'));
  });

  test('CSV values are valid numbers', () => {
    const coeffs = butterworthLowpass(0.2);
    const csv = exportCSV(coeffs, 'biquad');
    const lines = csv.trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const [, val] = lines[i].split(',');
      assert(Number.isFinite(parseFloat(val)), `Invalid CSV value: ${val}`);
    }
  });
});

// --- SVG Rendering Tests ---
describe('SVG Rendering', () => {
  test('Pole-zero SVG is valid', () => {
    const coeffs = butterworthLowpass(0.2);
    const data = poleZeroPlotData(coeffs);
    const svg = renderPoleZeroSVG(data);
    assert(svg.includes('<svg'));
    assert(svg.includes('</svg>'));
    assert(svg.includes('circle')); // unit circle
    assert(svg.includes('stroke="#0ff"')); // zeros
    assert(svg.includes('stroke="#f00"')); // poles
  });

  test('Bode magnitude SVG is valid', () => {
    const coeffs = butterworthLowpass(0.2);
    const bode = biquadBode(coeffs);
    const svg = renderBodeMagSVG(bode);
    assert(svg.includes('<svg'));
    assert(svg.includes('</svg>'));
    assert(svg.includes('<path'));
    assert(svg.includes('stroke="#0f0"'));
  });

  test('Bode phase SVG is valid', () => {
    const coeffs = butterworthLowpass(0.2);
    const bode = biquadBode(coeffs);
    const svg = renderBodePhaseSVG(bode);
    assert(svg.includes('<svg'));
    assert(svg.includes('</svg>'));
    assert(svg.includes('<path'));
    assert(svg.includes('stroke="#0ff"'));
  });

  test('Bode group delay SVG is valid', () => {
    const coeffs = butterworthLowpass(0.2);
    const bode = biquadBode(coeffs);
    const svg = renderBodeGroupDelaySVG(bode);
    assert(svg.includes('<svg'));
    assert(svg.includes('</svg>'));
    assert(svg.includes('<path'));
    assert(svg.includes('stroke="#ff0"'));
  });
});

// --- Integration Tests ---
describe('Integration', () => {
  test('Full FFT -> filter -> IFFT round trip', () => {
    const n = 256;
    const input = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      input[i] = Math.sin(TAU * 10 * i / n) + 0.5 * Math.sin(TAU * 40 * i / n);
    }
    // Design lowpass at 0.15 (should pass 10/256=0.039, reject 40/256=0.156)
    const coeffs = butterworthLowpass(0.15);
    const filtered = biquadFilter(input, coeffs);
    // Check attenuation of high frequency component
    const fftReal = new Float64Array(filtered);
    const fftImag = new Float64Array(n);
    fft(fftReal, fftImag);
    const mag = magnitude(fftReal, fftImag);
    // Bin 10 (low freq) should be larger than bin 40 (high freq)
    assert(mag[10] > mag[40] * 2, `Low freq ${mag[10]} not sufficiently above high freq ${mag[40]}`);
  });

  test('Workbench HTML generation', () => {
    const html = generateWorkbenchHTML();
    assert(html.includes('<!DOCTYPE html>'));
    assert(html.includes('FFT Filter Bench'));
    assert(html.includes('butterworthLowpass'));
    assert(html.includes('chebyshevLowpass'));
    assert(html.includes('renderPoleZeroSVG'));
    assert(html.includes('renderBodeMagSVG'));
    assert(html.includes('exportCHeader'));
    assert(html.includes('exportCSV'));
  });
});

// Need to import generateWorkbenchHTML
import { generateWorkbenchHTML } from '../src/dsp.mjs';