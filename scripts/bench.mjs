/** Optional timing benchmark. Run: npm run bench */
import { performance } from 'node:perf_hooks';
import * as D from '../src/dsp.mjs';

const n = 1 << 16;
const input = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.01));
const coeffs = D.butterworthLowpass(0.2);
const start = performance.now();
const { real, imag } = D.fftReal(input);
const fftMs = performance.now() - start;
const t2 = performance.now();
D.biquadFilter(input, coeffs);
const iirMs = performance.now() - t2;
const t3 = performance.now();
D.biquadBode(coeffs, 4096);
const bodeMs = performance.now() - t3;
const { timeEnergy, freqEnergy } = D.parsevalEnergy(input, null, real, imag);
console.log(`FFT ${n}: ${fftMs.toFixed(2)} ms | biquad ${n}: ${iirMs.toFixed(2)} ms | Bode 4096: ${bodeMs.toFixed(2)} ms`);
console.log(`Parseval relative error: ${(Math.abs(timeEnergy - freqEnergy) / timeEnergy).toExponential(3)}`);
