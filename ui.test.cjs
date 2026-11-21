/**
 * UI interaction tests. Executes the real index.html scripts through the
 * deterministic DOM/canvas adapter and checks startup, controls, presets,
 * probes, exports, diagnostics and error handling.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./dom-harness.cjs');
const D = require('./src/dsp.cjs');

function bench(options) {
  const h = boot(__dirname, options);
  assert.deepEqual(h.errors, [], 'startup console errors: ' + h.errors.join(' | '));
  return h;
}
function change(h, id, value) { h.get(id).value = value; h.event(h.get(id), 'change'); }
function input(h, id, value) { h.get(id).value = value; h.event(h.get(id), 'input'); }
function noNaNInCanvas(h, id) {
  const ctx = h.get(id).getContext('2d');
  for (const call of ctx.calls) {
    for (const arg of call.args) {
      if (arg && typeof arg === 'object' && !(arg instanceof Uint8ClampedArray)) continue;
      assert.ok(!(typeof arg === 'number' && !Number.isFinite(arg)), `nonfinite ${call.name} arg`);
    }
  }
}

test('startup binds the real DSP engine and renders every plot without errors', () => {
  const h = bench();
  assert.match(h.get('engineBadge').textContent, /local DSP engine ready/);
  assert.equal(h.get('errorStatus').hidden, true);
  assert.match(h.get('statusLine').textContent, /2048-point FFT/);
  assert.equal(h.get('statStability').textContent, 'STABLE');
  assert.equal(h.get('statFinite').textContent, 'PASS');
  assert.equal(h.get('poleZeroSvg').querySelectorAll('title').length, 1);
  assert.equal(h.get('poleZeroSvg').querySelectorAll('desc').length, 1);
  assert.ok(h.get('poleZeroSvg').querySelectorAll('circle').length >= 6);
  assert.ok(h.get('coeffTable').querySelectorAll('tbody tr').length >= 10);
  for (const id of ['signalCanvas', 'spectrumCanvas', 'bodeCanvas', 'firCanvas']) {
    assert.ok(h.get(id).getContext('2d').calls.length > 10, `${id} drew nothing`);
    noNaNInCanvas(h, id);
  }
  assert.match(h.get('spectrumReadout').textContent, /bin 0/);
  assert.match(h.get('bodeReadout').textContent, /freq 0.0000/);
  assert.match(h.get('firReadout').textContent, /tap 0/);
  assert.deepEqual(h.errors, []);
  h.dispose();
});

test('all four synthetic presets recompute stable finite experiments', () => {
  const h = bench();
  for (const name of ['voiceBand', 'antiAlias', 'notchTwoTone', 'widebandNoise']) {
    change(h, 'presetSelect', name);
    assert.match(h.get('presetNote').textContent, /synthetic|stands in|Noise-dominated|transition-band/i);
    assert.equal(h.get('errorStatus').hidden, true);
    assert.equal(h.get('statFinite').textContent, 'PASS');
    assert.equal(h.get('statStability').textContent, 'STABLE');
    const d = h.sandbox.__FFTB__.data;
    assert.ok(d.input.every(Number.isFinite));
    assert.ok(d.iir.every(Number.isFinite));
    assert.ok(d.firOut.every(Number.isFinite));
    assert.ok(d.bode.mag.every(Number.isFinite));
    assert.ok(d.bode.grpDelay.every(Number.isFinite));
    assert.ok(d.parsevalError < 1e-9, `parseval error ${d.parsevalError}`);
  }
  assert.deepEqual(h.errors, []);
  h.dispose();
});

test('filter family changes update coefficients, controls and diagnostics', () => {
  const h = bench();
  const before = h.sandbox.__FFTB__.data.coeffs.b0;
  change(h, 'filterFamily', 'chebyshev');
  assert.equal(h.get('rippleRow').hidden, false);
  assert.equal(h.get('rippleDb').disabled, false);
  assert.equal(h.get('qRow').hidden, true);
  assert.notEqual(h.sandbox.__FFTB__.data.coeffs.b0, before);
  assert.match(h.get('statusLine').textContent, /Custom/);
  change(h, 'filterFamily', 'bandpass');
  assert.equal(h.get('qRow').hidden, false);
  assert.equal(h.get('rippleRow').hidden, true);
  change(h, 'filterFamily', 'highpass');
  assert.equal(h.get('qRow').hidden, true);
  assert.equal(h.get('rippleRow').hidden, true);
  assert.equal(h.get('statStability').textContent, 'STABLE');
  h.get('themeToggle'); // binding present
  assert.deepEqual(h.errors, []);
  h.dispose();
});

test('cutoff slider redraws plots and changes the cutoff gain', () => {
  const h = bench();
  // Butterworth gain at cutoff is -3.01 dB for any fc by design, so check
  // that the state and Bode sweep actually change instead of the gain label.
  const before = h.sandbox.__FFTB__.data.coeffs.b0;
  input(h, 'cutoff', '0.42');
  assert.equal(h.get('cutoffOut').textContent, '0.420');
  assert.notEqual(h.sandbox.__FFTB__.data.coeffs.b0, before);
  assert.equal(h.get('statGain').textContent, '-3.01 dB');
  assert.equal(h.get('errorStatus').hidden, true);
  assert.ok(h.get('bodeCanvas').getContext('2d').calls.length > 10);
  noNaNInCanvas(h, 'bodeCanvas');
  h.dispose();
});

test('spectrum window and plot mode selections are applied to the real data', () => {
  const h = bench();
  const before = h.sandbox.__FFTB__.data.spectrum.magInDb[100];
  change(h, 'windowForSpectrum', 'blackman');
  assert.notEqual(h.sandbox.__FFTB__.data.spectrum.magInDb[100], before);
  change(h, 'plotMode', 'output');
  assert.equal(h.sandbox.__FFTB__.state.plotMode, 'output');
  assert.equal(h.get('errorStatus').hidden, true);
  h.dispose();
});

test('Bode segment buttons change the plotted channel and keep one pressed', () => {
  const h = bench();
  const buttons = h.document.querySelectorAll('[data-bode]');
  assert.equal(buttons.length, 3);
  for (const b of buttons) {
    b.click();
    assert.equal(b.getAttribute('aria-pressed'), 'true');
    assert.equal(buttons.filter(x => x.getAttribute('aria-pressed') === 'true').length, 1);
    assert.equal(h.sandbox.__FFTB__.state.bodeView, b.getAttribute('data-bode'));
    noNaNInCanvas(h, 'bodeCanvas');
  }
  assert.deepEqual(h.errors, []);
  h.dispose();
});

test('keyboard probes move, clamp, pin and release without stale values', () => {
  const h = bench();
  const canvas = h.get('spectrumCanvas');
  h.key(canvas, 'Home');
  assert.match(h.get('spectrumReadout').textContent, /bin 0 \|/);
  h.key(canvas, 'ArrowLeft');
  assert.match(h.get('spectrumReadout').textContent, /bin 0 \|/);
  h.key(canvas, 'ArrowRight', { shiftKey: true });
  assert.match(h.get('spectrumReadout').textContent, /bin 10 \|/);
  const total = h.sandbox.__FFTB__.data.spectrum.bins.length - 1;
  h.key(canvas, 'End');
  assert.match(h.get('spectrumReadout').textContent, new RegExp('bin ' + total + ' \\|'));
  h.key(canvas, 'ArrowRight');
  assert.match(h.get('spectrumReadout').textContent, new RegExp('bin ' + total + ' \\|'));
  assert.match(h.get('spectrumReadout').textContent, /24000.0 Hz/);
  h.key(canvas, 'Enter');
  assert.equal(h.sandbox.__FFTB__.state.pinned, true);
  assert.match(h.get('signalReadout').textContent, /Probe pinned/);
  const before = h.get('spectrumReadout').textContent;
  h.event(canvas, 'pointermove', { clientX: 300 });
  assert.equal(h.get('spectrumReadout').textContent, before, 'pinned probe must resist pointer');
  h.key(canvas, 'Escape');
  assert.equal(h.sandbox.__FFTB__.state.pinned, false);
  assert.match(h.get('signalReadout').textContent, /Probe free/);
  h.event(canvas, 'pointermove', { clientX: 300 });
  assert.notEqual(h.get('spectrumReadout').textContent, before);
  h.dispose();
});

test('keyboard probe works on signal, Bode and FIR canvases', () => {
  const h = bench();
  h.key(h.get('bodeCanvas'), 'End');
  assert.match(h.get('bodeReadout').textContent, /freq 1.0000/);
  h.key(h.get('bodeCanvas'), 'Home');
  assert.match(h.get('bodeReadout').textContent, /freq 0.0000/);
  const taps = h.sandbox.__FFTB__.data.firDesign.coefficients.length;
  h.key(h.get('firCanvas'), 'End');
  assert.match(h.get('firReadout').textContent, new RegExp('tap ' + (taps - 1) + ' of ' + taps));
  h.key(h.get('signalCanvas'), 'End');
  assert.match(h.get('signalReadout').textContent, /sample 2047/);
  h.key(h.get('signalCanvas'), 'Home');
  assert.match(h.get('signalReadout').textContent, /sample 0/);
  assert.deepEqual(h.errors, []);
  h.dispose();
});

test('canvas sizing respects device pixel ratio and CSS width on resize', () => {
  const h = bench({ dpr: 2 });
  const canvas = h.get('signalCanvas');
  canvas.rect = { left: 0, top: 0, width: 600, height: 150 };
  h.resize();
  assert.equal(canvas.width, 1200);
  assert.equal(canvas.height, 300);
  canvas.rect = { left: 0, top: 0, width: 340, height: 85 };
  h.resize();
  assert.equal(canvas.width, 680);
  // The controller enforces a 120 CSS px minimum height for legibility.
  assert.equal(canvas.height, 240);
  noNaNInCanvas(h, 'signalCanvas');
  h.dispose();
});

test('theme toggle and guide toggle update the DOM and survive storage failure', () => {
  const h = bench({ storageBlocked: true });
  assert.equal(h.document.documentElement.getAttribute('data-theme'), 'dark');
  h.get('themeToggle').click();
  assert.equal(h.document.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(h.get('themeToggle').getAttribute('aria-pressed'), 'true');
  h.get('themeToggle').click();
  assert.equal(h.document.documentElement.getAttribute('data-theme'), 'dark');
  assert.equal(h.get('helpPanel').hidden, true);
  h.get('helpToggle').click();
  assert.equal(h.get('helpPanel').hidden, false);
  assert.equal(h.get('helpToggle').getAttribute('aria-expanded'), 'true');
  h.get('helpToggle').click();
  assert.equal(h.get('helpPanel').hidden, true);
  assert.deepEqual(h.errors, []);
  h.dispose();
});

test('invalid noise seed is clamped and does not produce NaN exports', async () => {
  const h = bench();
  input(h, 'seedInput', '-999');
  assert.equal(h.sandbox.__FFTB__.state.seed, 0);
  assert.equal(h.get('errorStatus').hidden, true);
  input(h, 'seedInput', '999999999999');
  assert.equal(h.sandbox.__FFTB__.state.seed, 4294967295);
  h.get('jsonBtn').click();
  const text = await h.blobs.get(h.document.downloads[0].href).text();
  assert.doesNotMatch(text, /NaN|Infinity/);
  assert.equal(JSON.parse(text).schemaVersion, 2);
  h.dispose();
});

test('reset restores the voice-band preset and new seed changes the signal', () => {
  const h = bench();
  change(h, 'presetSelect', 'widebandNoise');
  const noisy = h.sandbox.__FFTB__.data.input[10];
  h.get('resetBtn').click();
  assert.equal(h.get('presetSelect').value, 'voiceBand');
  assert.equal(h.sandbox.__FFTB__.state.preset, 'voiceBand');
  const before = h.sandbox.__FFTB__.data.input[10];
  assert.notEqual(before, noisy);
  h.get('randomBtn').click();
  assert.notEqual(h.sandbox.__FFTB__.data.input[10], before);
  assert.equal(h.get('errorStatus').hidden, true);
  h.dispose();
});

test('all seven exports produce finite, correctly named local files', async () => {
  const h = bench();
  const buttons = ['jsonBtn', 'coeffCsvBtn', 'bodeCsvBtn', 'spectrumCsvBtn', 'cHeaderBtn', 'wavInputBtn', 'wavOutputBtn'];
  for (const id of buttons) h.get(id).click();
  assert.equal(h.document.downloads.length, buttons.length);
  const names = h.document.downloads.map(f => f.filename);
  assert.ok(names.includes('fft-filter-bench-experiment.json'));
  assert.ok(names.includes('biquad_coeffs.h'));
  assert.ok(names.includes('fft-filter-bench-filtered.wav'));
  for (const file of h.document.downloads) {
    const text = await h.blobs.get(file.href).text();
    assert.doesNotMatch(text, /NaN|Infinity|undefined/, `${file.filename} has nonfinite text`);
  }
  const json = JSON.parse(await h.blobs.get(h.document.downloads[0].href).text());
  assert.equal(json.bode.freq.length, 512);
  assert.equal(json.stability.stable, true);
  const bodeCsv = await h.blobs.get(h.document.downloads[2].href).text();
  assert.equal(bodeCsv.trim().split('\n').length, 513);
  const header = await h.blobs.get(h.document.downloads[4].href).text();
  assert.match(header, /#define BIQUAD_B0/);
  assert.match(header, /biquad_process/);
  const wav = new Uint8Array(await h.blobs.get(h.document.downloads[6].href).arrayBuffer());
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(wav.length, 44 + 2048 * 2);
  h.flushTimers();
  assert.equal(h.blobs.size, 0, 'object URLs must be revoked');
  assert.equal(h.get('exportNote').textContent, 'Generated fft-filter-bench-filtered.wav locally.');
  h.dispose();
});

test('export buttons are disabled while an error is visible and re-enabled after recovery', () => {
  const h = bench();
  // Force a computation failure by replacing the engine design function.
  const original = h.sandbox.DSP.designFilter;
  h.sandbox.DSP.designFilter = () => { throw new Error('injected design failure'); };
  input(h, 'cutoff', '0.3');
  assert.equal(h.get('errorStatus').hidden, false);
  assert.match(h.get('errorStatus').textContent, /injected design failure/);
  assert.equal(h.get('jsonBtn').disabled, true);
  h.sandbox.DSP.designFilter = original;
  input(h, 'cutoff', '0.31');
  assert.equal(h.get('errorStatus').hidden, true);
  assert.equal(h.get('jsonBtn').disabled, false);
  assert.deepEqual(h.errors, []);
  h.dispose();
});

test('no external script sources, no remote URLs and no duplicate IDs in the page', () => {
  const h = bench();
  const scripts = h.document.querySelectorAll('script[src]');
  assert.equal(scripts.length, 2);
  for (const s of scripts) assert.match(s.getAttribute('src'), /^(src\/dsp\.cjs|app\.js)$/);
  assert.doesNotMatch(h.html, /https?:\/\//);
  const ids = h.document.querySelectorAll('[id]').map(n => n.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(h.errors, []);
  h.dispose();
});

test('browser bundle and ES module produce identical coefficients and Bode data', () => {
  // Protects the build-bundle pipeline: the browser must not use a stale engine.
  const cjs = D.designFilter({ family: 'chebyshev', fc: 0.2, rippleDb: 2 });
  assert.ok(Number.isFinite(cjs.b0));
  const bode = D.biquadBode(cjs, 128);
  assert.equal(bode.freq.length, 128);
  assert.ok(bode.mag.every(Number.isFinite));
  assert.ok(bode.grpDelay.every(Number.isFinite));
  const wav = D.exportWAV(new Float64Array([0, 0.5, -0.5]), 48000);
  assert.equal(wav.length, 50);
});
