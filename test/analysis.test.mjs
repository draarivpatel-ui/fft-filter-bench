/**
 * Analysis-suite tests for the v2 engine surface: phase unwrapping, FIR
 * response/group delay, companion-QR polynomial roots, FIR z-plane data,
 * spec-mask verification, SHA-256 hashing, embedded/Python/report exports,
 * URL-hash bookmarking and the self-test battery.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../src/dsp.mjs';

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} !~= ${b} (tol ${tol})`);
const PI = Math.PI;

/* ------------------------------- unwrapPhase ------------------------------ */
test('unwrapPhase leaves a smooth ramp untouched', () => {
  const ph = new Float64Array([0, -0.1, -0.2, -0.3, -0.4]);
  const out = D.unwrapPhase(ph);
  for (let i = 0; i < ph.length; i++) close(out[i], ph[i], 1e-15);
});

test('unwrapPhase removes a 2pi wrap jump', () => {
  const ph = new Float64Array([3.0, 3.1, -3.1, -3.0]);
  const out = D.unwrapPhase(ph);
  assert.ok(Math.abs(out[2] - out[1]) < 0.5, `jump ${out[2] - out[1]} not unwrapped`);
  close(out[3], -3.0 + 2 * Math.PI, 1e-9);
});

test('unwrapPhase of constant phase is constant', () => {
  const out = D.unwrapPhase(new Float64Array([1.2, 1.2, 1.2]));
  for (const v of out) close(v, 1.2, 1e-15);
});

test('unwrapPhase returns Float64Array of equal length', () => {
  const out = D.unwrapPhase([0, 1, 2]);
  assert.ok(out instanceof Float64Array);
  assert.equal(out.length, 3);
});

test('unwrapPhase on empty input returns empty', () => {
  assert.equal(D.unwrapPhase([]).length, 0);
});

test('unwrapPhase unwraps several wraps to a near-linear trend', () => {
  const n = 64, wrapped = new Float64Array(n);
  const slope = -0.4; // exceeds pi over a few samples
  for (let i = 0; i < n; i++) {
    const v = slope * i;
    wrapped[i] = Math.atan2(Math.sin(v), Math.cos(v));
  }
  const out = D.unwrapPhase(wrapped);
  for (let i = 1; i < n; i++) close(out[i] - out[i - 1], slope, 1e-9);
});

test('unwrapPhase keeps values inside [-pi, pi] continuous', () => {
  const ph = new Float64Array([3.1, -3.1, 3.1]);
  const out = D.unwrapPhase(ph);
  assert.ok(Math.abs(out[1] - out[0]) < 0.2);
  assert.ok(Math.abs(out[2] - out[1]) < 0.2);
});

test('unwrapPhase does not mutate its input', () => {
  const ph = new Float64Array([3.0, -3.0]);
  D.unwrapPhase(ph);
  close(ph[1], -3.0, 0);
});

/* --------------------------- firFrequencyResponseEx ------------------------ */
test('unit tap FIR has magnitude 1 and zero group delay', () => {
  const r = D.firFrequencyResponseEx([1], 0.7);
  close(r.magnitude, 1, 1e-12);
  close(r.groupDelay, 0, 1e-12);
});

test('pure two-sample delay has |H|=1 and group delay 2', () => {
  for (const w of [0.1, 0.9, 2.0, 3.0]) {
    const r = D.firFrequencyResponseEx([0, 0, 1], w);
    close(r.magnitude, 1, 1e-12);
    close(r.groupDelay, 2, 1e-9);
  }
});

test('symmetric FIR DC magnitude equals the tap sum', () => {
  const h = D.designFirLowpass({ taps: 33, fc: 0.12, window: 'hamming' }).coefficients;
  const r = D.firFrequencyResponseEx(h, 0);
  close(r.magnitude, Math.abs(h.reduce((a, b) => a + b, 0)), 1e-9);
});

test('linear-phase FIR group delay is (taps-1)/2 everywhere', () => {
  const h = D.designFirLowpass({ taps: 41, fc: 0.15, window: 'blackman' }).coefficients;
  for (const w of [0.01, 0.4, 1.1, 2.2, 3.0]) {
    const r = D.firFrequencyResponseEx(h, w);
    close(r.groupDelay, 20, 1e-6);
  }
});

test('phase stays wrapped inside (-pi, pi]', () => {
  const h = D.designFirLowpass({ taps: 25, fc: 0.1, window: 'hann' }).coefficients;
  for (let i = 0; i < 64; i++) {
    const r = D.firFrequencyResponseEx(h, PI * i / 63);
    assert.ok(r.phase <= PI + 1e-12 && r.phase > -PI - 1e-12);
  }
});

test('group delay stays finite at a transmission-zero frequency', () => {
  // First-order notch FIR: H(z) = 1 + z^-1 has a zero at w = pi.
  const r = D.firFrequencyResponseEx([1, 1], PI);
  assert.ok(Number.isFinite(r.groupDelay));
  assert.ok(Number.isFinite(r.magnitude));
});

test('firFrequencyResponseEx rejects nonfinite taps', () => {
  assert.throws(() => D.firFrequencyResponseEx([1, NaN, 1], 0.5));
});

test('lowpass FIR attenuates at Nyquist and passes DC', () => {
  const h = D.designFirLowpass({ taps: 49, fc: 0.1, window: 'blackman' }).coefficients;
  const dc = D.firFrequencyResponseEx(h, 0).magnitude;
  const ny = D.firFrequencyResponseEx(h, PI).magnitude;
  close(dc, 1, 0.02);
  assert.ok(ny < 0.01, `Nyquist magnitude ${ny}`);
});

/* --------------------------------- firBode -------------------------------- */
test('firBode returns four aligned sweeps of nPoints', () => {
  const h = D.designFirLowpass({ taps: 17, fc: 0.1, window: 'hamming' }).coefficients;
  const b = D.firBode(h, 128);
  for (const k of ['freq', 'mag', 'phase', 'phaseUnwrapped', 'grpDelay']) {
    assert.equal(b[k].length, 128, k);
  }
});

test('firBode frequency axis runs 0 to 1 uniformly', () => {
  const b = D.firBode([1, 0.5, 0.25], 64);
  close(b.freq[0], 0, 0);
  close(b.freq[63], 1, 1e-15);
  close(b.freq[32] - b.freq[31], 1 / 63, 1e-15);
});

test('firBode phaseUnwrapped matches unwrapPhase of wrapped phase', () => {
  const h = D.designFirLowpass({ taps: 33, fc: 0.2, window: 'hamming' }).coefficients;
  const b = D.firBode(h, 256);
  const ref = D.unwrapPhase(b.phase);
  for (let i = 0; i < 256; i++) close(b.phaseUnwrapped[i], ref[i], 1e-9);
});

test('firBode group delay is constant for a linear-phase FIR', () => {
  const h = D.designFirLowpass({ taps: 33, fc: 0.1, window: 'hann' }).coefficients;
  const b = D.firBode(h, 256);
  let worst = 0;
  for (const g of b.grpDelay) worst = Math.max(worst, Math.abs(g - 16));
  assert.ok(worst < 1e-4, `group delay ripple ${worst}`);
});

test('firBode magnitudes stay finite across the sweep', () => {
  const h = D.designFirLowpass({ taps: 25, fc: 0.08, window: 'rectangular' }).coefficients;
  const b = D.firBode(h, 512);
  assert.ok(b.mag.every(Number.isFinite));
  assert.ok(b.phaseUnwrapped.every(Number.isFinite));
});

test('firBode validates nPoints', () => {
  assert.throws(() => D.firBode([1], 1));
  assert.throws(() => D.firBode([1], 2.5));
});

/* ------------------------------- polyRoots -------------------------------- */
test('polyRoots solves a degree-1 polynomial exactly', () => {
  const r = D.polyRoots([1, -2]);
  assert.equal(r.roots.length, 1);
  close(r.roots[0].real, 2, 1e-12);
  close(r.roots[0].imag, 0, 1e-12);
  assert.equal(r.converged, true);
});

test('polyRoots solves a quadratic with real roots', () => {
  // (z - 1)(z - 3) = z^2 - 4z + 3
  const r = D.polyRoots([1, -4, 3]);
  const re = r.roots.map(z => z.real).sort((a, b) => a - b);
  close(re[0], 1, 1e-9); close(re[1], 3, 1e-9);
});

test('polyRoots solves z^2 + 1 as conjugate pair on the unit circle', () => {
  const r = D.polyRoots([1, 0, 1]);
  const im = r.roots.map(z => z.imag).sort((a, b) => a - b);
  close(im[0], -1, 1e-9); close(im[1], 1, 1e-9);
  for (const z of r.roots) close(z.real, 0, 1e-9);
});

test('polyRoots on (z-0.5)(z+0.5)(z-2) returns all three roots', () => {
  // z^3 - 2z^2 - 0.25z + 0.5
  const r = D.polyRoots([1, -2, -0.25, 0.5]);
  assert.equal(r.roots.length, 3);
  const re = r.roots.map(z => z.real).sort((a, b) => a - b);
  close(re[0], -0.5, 1e-6); close(re[1], 0.5, 1e-6); close(re[2], 2, 1e-6);
});

test('polyRoots returns exactly M roots for a sextic', () => {
  const r = D.polyRoots([1, -3, 3.5, -2, 0.9, -0.3, 0.1]);
  assert.equal(r.roots.length, 6);
});

test('polyRoots reports trailing zeros as roots at z = 0', () => {
  // z^2 - 2z = z(z - 2): one root at 0, one at 2.
  const r = D.polyRoots([1, -2, 0]);
  assert.equal(r.roots.length, 2);
  const mags = r.roots.map(z => Math.hypot(z.real, z.imag)).sort((a, b) => a - b);
  close(mags[0], 0, 1e-9); close(mags[1], 2, 1e-9);
});

test('polyRoots strips only exact leading zeros', () => {
  // 0*z^3 + z^2 - 1 -> quadratic with roots +-1.
  const r = D.polyRoots([0, 1, 0, -1]);
  assert.equal(r.roots.length, 2);
  const re = r.roots.map(z => z.real).sort((a, b) => a - b);
  close(re[0], -1, 1e-9); close(re[1], 1, 1e-9);
});

test('polyRoots of a pure monomial lands all roots at the origin', () => {
  const r = D.polyRoots([1, 0, 0, 0, 0]);
  assert.equal(r.roots.length, 4);
  for (const z of r.roots) assert.ok(Math.hypot(z.real, z.imag) < 1e-6);
});

test('polyRoots converges on a degree-16 polynomial with known unit roots', () => {
  // Product of (z - e^{ik*pi/4}) pairs: build via roots-of-unity polynomial z^8 - 1.
  const coeffs = [1, 0, 0, 0, 0, 0, 0, 0, -1];
  const r = D.polyRoots(coeffs);
  assert.equal(r.roots.length, 8);
  for (const z of r.roots) close(Math.hypot(z.real, z.imag), 1, 1e-6);
});

test('polyRoots certifies backward error below 1e-10 on a FIR-like polynomial', () => {
  const h = D.designFirLowpass({ taps: 33, fc: 0.1, window: 'hamming' }).coefficients;
  const r = D.polyRoots(h);
  assert.equal(r.converged, true);
  assert.ok(r.maxResidual <= 1e-10, `maxResidual ${r.maxResidual}`);
});

test('polyRoots rejects nonfinite and empty inputs', () => {
  assert.throws(() => D.polyRoots([]));
  assert.throws(() => D.polyRoots([1, NaN]));
  assert.throws(() => D.polyRoots([1, Infinity, 0]));
});

test('polyRoots accepts iteration/tolerance overrides', () => {
  const r = D.polyRoots([1, -4, 3], { maxIterations: 500, tolerance: 1e-14 });
  assert.equal(r.roots.length, 2);
});

test('polyRoots exposes iteration accounting', () => {
  const r = D.polyRoots([1, -4, 3]);
  assert.ok(Number.isFinite(r.iterations));
  assert.ok(Number.isFinite(r.maxResidual));
});

test('degree-64 companion-QR solve returns 64 finite roots', () => {
  const h = D.designFirLowpass({ taps: 65, fc: 0.2, window: 'hamming' }).coefficients;
  const r = D.polyRoots(h);
  assert.equal(r.roots.length, 64);
  assert.ok(r.roots.every(z => Number.isFinite(z.real) && Number.isFinite(z.imag)));
});

/* ------------------------------- firPoleZero ------------------------------- */
test('firPoleZero on a 9-tap FIR returns 8 zeros and a pole at 0 of order 8', () => {
  const h = D.designFirLowpass({ taps: 9, fc: 0.15, window: 'hamming' }).coefficients;
  const pz = D.firPoleZero(h);
  assert.equal(pz.zeros.length, 8);
  assert.deepEqual(pz.poles, [{ real: 0, imag: 0 }]);
  assert.equal(pz.poleMultiplicity, 8);
});

test('firPoleZero on a 33-tap hamming FIR converges with no uncertified roots', () => {
  const h = D.designFirLowpass({ taps: 33, fc: 0.1, window: 'hamming' }).coefficients;
  const pz = D.firPoleZero(h);
  assert.equal(pz.zeros.length, 32);
  assert.equal(pz.converged, true);
  assert.equal(pz.uncertified, 0);
  assert.ok(pz.maxResidual <= 1e-10);
});

test('firPoleZero on 129 taps converges and reports the solver method', () => {
  const h = D.designFirLowpass({ taps: 129, fc: 0.09, window: 'hamming' }).coefficients;
  const pz = D.firPoleZero(h);
  assert.equal(pz.method, 'companion-qr');
  assert.equal(pz.converged, true);
  assert.equal(pz.zeros.length, pz.expectedFinite);
});

test('firPoleZero honestly reports roots at infinity for zero-edge windows', () => {
  const h = D.designFirLowpass({ taps: 65, fc: 0.15, window: 'blackman' }).coefficients;
  const pz = D.firPoleZero(h);
  assert.ok(pz.droppedRoots >= 1, 'edge taps snap to zero and drop roots');
  assert.equal(pz.zeros.length, pz.expectedFinite);
});

test('firPoleZero zeros of a type-1 FIR satisfy conjugate pairing', () => {
  const h = D.designFirLowpass({ taps: 33, fc: 0.1, window: 'hamming' }).coefficients;
  const pz = D.firPoleZero(h);
  const imags = pz.zeros.map(z => z.imag).sort((a, b) => a - b);
  // Symmetric imag part: first half mirrors the second half.
  const n = imags.length;
  for (let i = 0; i < n / 2; i++) close(imags[i], -imags[n - 1 - i], 1e-6);
});

test('firPoleZero marks finite zero radius for a real FIR', () => {
  const h = D.designFirLowpass({ taps: 25, fc: 0.12, window: 'hann' }).coefficients;
  const pz = D.firPoleZero(h);
  for (const z of pz.zeros) {
    const r = Math.hypot(z.real, z.imag);
    assert.ok(Number.isFinite(r) && r < 100, `zero radius ${r}`);
  }
});

test('firPoleZero rejects empty and nonfinite taps', () => {
  assert.throws(() => D.firPoleZero([]));
  assert.throws(() => D.firPoleZero([1, NaN, 1]));
});

/* --------------------------- firSymmetryError ------------------------------ */
test('firSymmetryError is ~0 for a designed windowed-sinc FIR', () => {
  const h = D.designFirLowpass({ taps: 33, fc: 0.1, window: 'hamming' }).coefficients;
  assert.ok(D.firSymmetryError(h) < 1e-15);
});

test('firSymmetryError reports the worst mirrored tap difference', () => {
  close(D.firSymmetryError([1, 2, 3]), 2, 1e-15);
  close(D.firSymmetryError([0.5, 2, 1, 2, 0.5]), 0, 1e-15);
});

test('firSymmetryError tolerates a single tap', () => {
  close(D.firSymmetryError([0.7]), 0, 1e-15);
});

/* ------------------------------- firStability ------------------------------ */
test('firStability reports BIBO stability with poles only at the origin', () => {
  const h = D.designFirLowpass({ taps: 33, fc: 0.1, window: 'hamming' }).coefficients;
  const s = D.firStability(h);
  assert.equal(s.stable, true);
  assert.equal(s.maxPoleRadius, 0);
  assert.equal(s.poleMultiplicity, 32);
  assert.equal(s.zeros.length, 32);
});

test('firStability exposes min-phase flag and solver convergence', () => {
  const h = D.designFirLowpass({ taps: 17, fc: 0.2, window: 'hann' }).coefficients;
  const s = D.firStability(h);
  assert.equal(typeof s.minPhase, 'boolean');
  assert.equal(typeof s.converged, 'boolean');
  assert.ok(Number.isFinite(s.maxZeroRadius));
  assert.ok(Number.isFinite(s.maxResidual));
});

test('firStability stays stable even for a non-symmetric tap set', () => {
  const s = D.firStability([1, 0.9, 0.3, 0.05]);
  assert.equal(s.stable, true);
  assert.ok(s.symmetryError > 0);
});

/* ------------------------------- specMaskCheck ----------------------------- */
function brickSweep() {
  const freq = new Float64Array(101), mag = new Float64Array(101);
  for (let i = 0; i <= 100; i++) { freq[i] = i / 100; mag[i] = freq[i] <= 0.2 ? -0.4 : -80; }
  return { freq, mag };
}
const LP_SPEC = { passband: [0, 0.2], stopbands: [[0.4, 1]], rippleDb: 1, attenDb: 40, transitionWidth: 0.25 };

test('specMaskCheck passes a brick-wall lowpass sweep', () => {
  const r = D.specMaskCheck(brickSweep(), LP_SPEC);
  assert.equal(r.pass, true);
  assert.equal(r.checks.every(c => c.pass), true);
});

test('specMaskCheck fails when passband ripple exceeds the spec', () => {
  const s = brickSweep();
  s.mag[5] = -3; // -3 dB dip inside the passband -> ripple 2.6 > 1.
  const r = D.specMaskCheck(s, LP_SPEC);
  assert.equal(r.pass, false);
  assert.equal(r.checks.find(c => c.name === 'passbandRipple').pass, false);
});

test('specMaskCheck fails when stopband attenuation is short', () => {
  const s = brickSweep();
  s.mag[80] = -20;
  const r = D.specMaskCheck(s, LP_SPEC);
  assert.equal(r.pass, false);
  assert.equal(r.checks.find(c => c.name === 'stopbandAttenuation').pass, false);
});

test('specMaskCheck fails a too-wide transition and reports its width', () => {
  const s = brickSweep();
  for (let i = 0; i <= 100; i++) s.mag[i] = -80 * Math.min(1, Math.max(0, (s.freq[i] - 0.2) / 0.6)); // 0.6-wide rolloff
  const r = D.specMaskCheck(s, LP_SPEC);
  assert.equal(r.checks.find(c => c.name === 'transitionWidth').pass, false);
  assert.ok(r.measured.worstTransitionWidth > 0.25);
});

test('specMaskCheck measures a finite transition width for a real FIR', () => {
  const h = D.designFirLowpass({ taps: 65, fc: 0.12, window: 'blackman' }).coefficients;
  const b = D.firBode(h, 512);
  const r = D.specMaskCheck({ freq: b.freq, mag: b.mag }, {
    passband: [0, 0.14], stopbands: [[0.4, 1]], rippleDb: 1, attenDb: 50, transitionWidth: 0.4,
    symmetryErrorMax: 1e-6
  }, { symmetryError: D.firSymmetryError(h) });
  assert.equal(r.pass, true);
  assert.ok(r.measured.worstTransitionWidth < 0.4);
  assert.ok(r.measured.passbandRippleDb < 1);
});

test('specMaskCheck appends the symmetry check only when a max is given', () => {
  const withSym = D.specMaskCheck(brickSweep(), { ...LP_SPEC, symmetryErrorMax: 0.01 }, { symmetryError: 0 });
  const without = D.specMaskCheck(brickSweep(), LP_SPEC, {});
  assert.equal(withSym.checks.length, 4);
  assert.equal(without.checks.length, 3);
});

test('specMaskCheck fails the symmetry check on an asymmetric tap set', () => {
  const r = D.specMaskCheck(brickSweep(), { ...LP_SPEC, symmetryErrorMax: 0.001 }, { symmetryError: 0.5 });
  assert.equal(r.checks.find(c => c.name === 'phaseSymmetry').pass, false);
  assert.equal(r.pass, false);
});

test('specMaskCheck verifies both stopbands of a bandpass mask', () => {
  const freq = new Float64Array(101), mag = new Float64Array(101);
  for (let i = 0; i <= 100; i++) {
    freq[i] = i / 100;
    mag[i] = (freq[i] >= 0.3 && freq[i] <= 0.5) ? -0.5 : -70;
  }
  const r = D.specMaskCheck({ freq, mag }, {
    passband: [0.3, 0.5], stopbands: [[0, 0.15], [0.7, 1]], rippleDb: 1, attenDb: 50, transitionWidth: 0.25
  });
  assert.equal(r.transitions.length, 2);
  assert.ok(r.transitions.some(t => t.edge === 'lower'));
  assert.ok(r.transitions.some(t => t.edge === 'upper'));
  assert.equal(r.pass, true);
});

test('specMaskCheck supports a highpass orientation', () => {
  const freq = new Float64Array(101), mag = new Float64Array(101);
  for (let i = 0; i <= 100; i++) { freq[i] = i / 100; mag[i] = freq[i] >= 0.6 ? -0.3 : -75; }
  const r = D.specMaskCheck({ freq, mag }, {
    passband: [0.6, 1], stopbands: [[0, 0.3]], rippleDb: 1, attenDb: 60, transitionWidth: 0.35
  });
  assert.equal(r.pass, true);
  assert.equal(r.transitions[0].edge, 'lower');
});

test('specMaskCheck fails when a declared stopband holds no sweep points', () => {
  // A stopband that misses the sampled range must not pass vacuously.
  const r = D.specMaskCheck(brickSweep(), { ...LP_SPEC, stopbands: [[1.05, 1.2]] });
  assert.equal(r.checks.find(c => c.name === 'stopbandAttenuation').pass, false);
  assert.equal(r.pass, false);
  const r2 = D.specMaskCheck(brickSweep(), { ...LP_SPEC, stopbands: [] });
  assert.equal(r2.checks.find(c => c.name === 'stopbandAttenuation').pass, false);
  const r3 = D.specMaskCheck(brickSweep(), { ...LP_SPEC, stopbands: [[0.7, 0.5]] });
  assert.equal(r3.checks.find(c => c.name === 'stopbandAttenuation').pass, false);
});

test('specMaskCheck measures a transition when the edge is already below ripple', () => {
  // Response dips under -rippleDb right at the passband edge but still reaches
  // the stopband level: the width must be a finite number, not Infinity.
  const s = brickSweep();
  for (let i = 0; i <= 100; i++) s.mag[i] = s.freq[i] <= 0.2 ? -1.5 : -80;
  s.mag[20] = -80; // dip exactly at the passband edge
  const r = D.specMaskCheck(s, { ...LP_SPEC, rippleDb: 0.5 });
  assert.ok(Number.isFinite(r.transitions[0].width), `width ${r.transitions[0].width}`);
});

test('specMaskCheck rejects malformed sweeps and specs', () => {
  assert.throws(() => D.specMaskCheck({ freq: [0, 1], mag: [0] }, LP_SPEC));
  assert.throws(() => D.specMaskCheck({ freq: [0, 0.5, 1], mag: [0, NaN, 0] }, LP_SPEC));
  assert.throws(() => D.specMaskCheck(brickSweep(), { passband: [0.5, 0.2], stopbands: [], rippleDb: 1, attenDb: 40, transitionWidth: 0.1 }));
  assert.throws(() => D.specMaskCheck(brickSweep(), { ...LP_SPEC, rippleDb: -1 }));
});

test('specMaskCheck reports measured passband extrema', () => {
  const r = D.specMaskCheck(brickSweep(), LP_SPEC);
  close(r.measured.passbandMaxDb, -0.4, 1e-9);
  close(r.measured.stopbandMaxDb, -80, 1e-9);
});

/* ------------------------------- sha256Hex -------------------------------- */
test('sha256Hex matches the FIPS known vector for "abc"', () => {
  assert.equal(D.sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256Hex matches the known vector for the empty string', () => {
  assert.equal(D.sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256Hex matches the multi-block known vector', () => {
  const msg = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
  assert.equal(D.sha256Hex(msg), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('sha256Hex accepts raw bytes', () => {
  const bytes = new Uint8Array([0x61, 0x62, 0x63]); // 'abc'
  assert.equal(D.sha256Hex(bytes), D.sha256Hex('abc'));
});

test('sha256Hex is deterministic and 64 lowercase hex chars', () => {
  const a = D.sha256Hex('fft-filter-bench'), b = D.sha256Hex('fft-filter-bench');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('sha256Hex distinguishes nearby inputs', () => {
  assert.notEqual(D.sha256Hex('seed=1'), D.sha256Hex('seed=2'));
});

/* ------------------------------ canonicalJson ------------------------------ */
test('canonicalJson sorts object keys recursively', () => {
  const s = D.canonicalJson({ b: 1, a: { d: 4, c: 3 } });
  assert.equal(s, '{"a":{"c":3,"d":4},"b":1}');
});

test('canonicalJson encodes typed arrays as plain arrays', () => {
  assert.equal(D.canonicalJson(new Float64Array([1, 2])), '[1,2]');
});

test('canonicalJson throws on non-finite numbers', () => {
  assert.throws(() => D.canonicalJson({ x: NaN }));
  assert.throws(() => D.canonicalJson([Infinity]));
});

test('canonicalJson is whitespace-free and stable across key order', () => {
  const a = D.canonicalJson({ z: 1, y: 2, x: [3, { b: 2, a: 1 }] });
  const b = D.canonicalJson({ x: [3, { a: 1, b: 2 }], y: 2, z: 1 });
  assert.equal(a, b);
  assert.doesNotMatch(a, /\s/);
});

/* --------------------------- exportEmbeddedHeader -------------------------- */
const IIR = D.butterworthLowpass(0.1);
const FIR = D.designFirLowpass({ taps: 17, fc: 0.1, window: 'hamming' }).coefficients;

test('embedded header declares FIR taps and both float and Q30 arrays', () => {
  const h = D.exportEmbeddedHeader({ name: 'filter', iir: IIR, fir: FIR });
  assert.match(h, /#define FILTER_FIR_TAPS 17/);
  assert.match(h, /static const float filter_b\[3\]/);
  assert.match(h, /static const int32_t filter_b_q30\[3\]/);
  assert.match(h, /static const float filter_fir_b\[17\]/);
  assert.match(h, /static const int32_t filter_fir_b_q30\[17\]/);
});

test('embedded header emits include guard, process function and define taps', () => {
  const h = D.exportEmbeddedHeader({ name: 'filter', iir: IIR });
  assert.match(h, /#ifndef FILTER_COEFFS_H/);
  assert.match(h, /#define FILTER_COEFFS_H/);
  assert.match(h, /#endif \/\* FILTER_COEFFS_H \*\//);
  assert.match(h, /filter_process/);
  assert.match(h, /#define FILTER_IIR_B0/);
  assert.match(h, /#define FILTER_IIR_A2/);
});

test('embedded header omits the FIR block when no taps are supplied', () => {
  const h = D.exportEmbeddedHeader({ name: 'filter', iir: IIR });
  assert.doesNotMatch(h, /FIR_TAPS/);
  assert.doesNotMatch(h, /fir_b/);
});

test('embedded header sanitizes a hostile name into a legal identifier', () => {
  const h = D.exportEmbeddedHeader({ name: '9bad name!', iir: IIR });
  assert.match(h, /#ifndef _9BAD_NAME__COEFFS_H/);
});

test('embedded header rejects nonfinite coefficients', () => {
  assert.throws(() => D.exportEmbeddedHeader({ iir: { ...IIR, b0: NaN } }));
  assert.throws(() => D.exportEmbeddedHeader({ fir: [0.1, Infinity] }));
});

test('embedded header Q30 values stay inside int32 range', () => {
  const h = D.exportEmbeddedHeader({ name: 'filter', iir: IIR, fir: FIR });
  const q30lines = h.split('\n').filter(l => l.includes('_q30['));
  assert.ok(q30lines.length >= 3);
  for (const line of q30lines) {
    const body = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'));
    for (const tok of body.split(',')) {
      const v = Number(tok.trim());
      assert.ok(Number.isInteger(v), `q30 token ${tok}`);
      assert.ok(Math.abs(v) <= 2147483647, `q30 overflow ${v}`);
    }
  }
});

/* --------------------------- exportPythonSnippet --------------------------- */
test('python snippet emits numpy arrays, freqz calls and the sample rate', () => {
  const s = D.exportPythonSnippet({ name: 'filter', iir: IIR, fir: FIR, sampleRate: 44100 });
  assert.match(s, /import numpy as np/);
  assert.match(s, /from scipy import signal/);
  assert.match(s, /SAMPLE_RATE = float\(44100\)/);
  assert.match(s, /filter_b = np\.array\(/);
  assert.match(s, /filter_a = np\.array\(\[1\.0,/);
  assert.match(s, /filter_fir = np\.array\(/);
  assert.match(s, /signal\.freqz\(filter_b, filter_a/);
});

test('python snippet is valid shape without FIR taps', () => {
  const s = D.exportPythonSnippet({ name: 'filter', iir: IIR });
  assert.match(s, /filter_b = np\.array/);
  assert.doesNotMatch(s, /filter_fir = np\.array/);
});

test('python snippet rejects nonfinite coefficients', () => {
  assert.throws(() => D.exportPythonSnippet({ iir: { ...IIR, a1: NaN } }));
});

/* ---------------------------- exportDesignReport --------------------------- */
const REPORT = {
  config: { family: 'butterworth', fc: 0.1, sampleRate: 48000 },
  iir: IIR,
  fir: { taps: 17, coefficients: Array.from(FIR) },
  stability: { stable: true, maxPoleRadius: 0.9 },
  metrics: { parsevalError: 1e-15 }
};

test('design report JSON carries a 64-hex SHA-256 fingerprint', () => {
  const r = JSON.parse(D.exportDesignReport(REPORT));
  assert.equal(r.fingerprintAlgorithm, 'SHA-256');
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
});

test('design report fingerprint is deterministic for identical input', () => {
  const a = JSON.parse(D.exportDesignReport(REPORT)).fingerprint;
  const b = JSON.parse(D.exportDesignReport(REPORT)).fingerprint;
  assert.equal(a, b);
});

test('design report fingerprint changes when any field changes', () => {
  const a = JSON.parse(D.exportDesignReport(REPORT)).fingerprint;
  const b = JSON.parse(D.exportDesignReport({ ...REPORT, config: { ...REPORT.config, fc: 0.11 } })).fingerprint;
  assert.notEqual(a, b);
});

test('design report fingerprint equals sha256Hex of the canonical report', () => {
  const parsed = JSON.parse(D.exportDesignReport(REPORT));
  const expect = D.sha256Hex(D.canonicalJson(parsed.report));
  assert.equal(parsed.fingerprint, expect);
});

test('design report embeds config, stability and metrics', () => {
  const r = JSON.parse(D.exportDesignReport(REPORT));
  assert.equal(r.report.config.family, 'butterworth');
  assert.equal(r.report.stability.stable, true);
  assert.equal(r.schemaVersion, 2);
});

test('design report CSV carries the fingerprint and config rows', () => {
  const csv = D.exportDesignReportCSV(REPORT);
  assert.match(csv, /fingerprint_sha256,[0-9a-f]{64}/);
  assert.match(csv, /config_family,butterworth/);
  assert.match(csv, /fir_taps,17/);
  assert.match(csv, /stable,true/);
});

test('JSON and CSV design reports carry the identical fingerprint', () => {
  const j = JSON.parse(D.exportDesignReport(REPORT));
  const csv = D.exportDesignReportCSV(REPORT);
  const csvFp = csv.match(/fingerprint_sha256,([0-9a-f]{64})/)[1];
  assert.equal(csvFp, j.fingerprint);
});

/* ---------------------------- URL hash codec ------------------------------- */
test('hash codec round-trips every serialized field', () => {
  const cfg = {
    preset: 'antiAlias', family: 'highpass', fc: 0.3, rippleDb: 2, Q: 6,
    sampleRate: 44100, fftSize: 1024, tone1Hz: 3000, tone2Hz: 19000,
    noise: 0.05, seed: 777, firTaps: 65, window: 'blackman',
    spectrumWindow: 'hann', plotMode: 'output', bodeView: 'grpDelay', firView: 'phaseUnwrapped',
    specEdge1Hz: 1000, specEdge2Hz: 8000, specRippleDb: 1.5,
    specAttenDb: 40, specSymmetryErr: 0.001
  };
  const parsed = D.parseConfigHash('#' + D.serializeConfigHash(cfg));
  for (const [k, v] of Object.entries(cfg)) {
    assert.equal(parsed[k], v, `field ${k}`);
  }
});

test('hash parser returns null for empty, missing or wrong versions', () => {
  assert.equal(D.parseConfigHash(''), null);
  assert.equal(D.parseConfigHash('#'), null);
  assert.equal(D.parseConfigHash('fc=0.3&fam=highpass'), null);
  assert.equal(D.parseConfigHash('v=1&fc=0.3'), null);
});

test('hash parser drops non-numeric junk per field', () => {
  const p = D.parseConfigHash('v=2&fc=junk&sr=44100');
  assert.equal(p.fc, undefined);
  assert.equal(p.sampleRate, 44100);
});

test('hash parser ignores unknown keys', () => {
  const p = D.parseConfigHash('v=2&bogus=1&fc=0.2');
  assert.equal(p.bogus, undefined);
  assert.equal(p.fc, 0.2);
});

test('hash serializer skips undefined, null and non-finite fields', () => {
  const h = D.serializeConfigHash({ fc: undefined, Q: null, rippleDb: NaN, fc2: 'x' });
  assert.equal(h, 'v=2');
});

test('hash serializer truncates integer fields and sanitizes strings', () => {
  const h = D.serializeConfigHash({ fftSize: 2048.9, preset: 'a b<c>' });
  assert.match(h, /n=2048/);
  assert.match(h, /p=abc/);
});

test('hash parser accepts a bare hash without the leading #', () => {
  const p = D.parseConfigHash(D.serializeConfigHash({ fc: 0.25 }));
  assert.equal(p.fc, 0.25);
});

/* ------------------------------- runSelfTests ------------------------------ */
test('self-test battery passes every check', () => {
  const r = D.runSelfTests();
  assert.equal(r.ok, true);
  assert.equal(r.pass, r.total);
  assert.equal(r.total, 13);
});

test('self-test battery reports a name and detail per check', () => {
  const r = D.runSelfTests();
  for (const t of r.results) {
    assert.ok(t.name.length > 3);
    assert.equal(typeof t.pass, 'boolean');
    assert.equal(typeof t.detail, 'string');
  }
});

test('self-test battery covers FFT round-trip, Parseval and SHA-256', () => {
  const names = D.runSelfTests().results.map(t => t.name).join(' | ');
  assert.match(names, /FFT\/IFFT round trip/);
  assert.match(names, /Parseval/);
  assert.match(names, /SHA-256/);
  assert.match(names, /BIBO/);
});

test('self-test battery is deterministic across runs', () => {
  const a = D.runSelfTests(), b = D.runSelfTests();
  assert.equal(a.pass, b.pass);
  assert.equal(a.ok, b.ok);
});
