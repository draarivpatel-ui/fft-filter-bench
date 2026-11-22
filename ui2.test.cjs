/**
 * UI tests for the v2 workbench surface: spec-mask verifier, FIR response and
 * z-plane panels, interactive markers, WebAudio audition, URL-hash bookmarking,
 * self-test battery and the new export set. Runs through the deterministic
 * DOM/canvas adapter exactly like ui.test.cjs.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./dom-harness.cjs');

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
      assert.ok(!(typeof arg === 'number' && !Number.isFinite(arg)), `nonfinite ${call.name} arg in ${id}`);
    }
  }
}
// Minimal WebAudio stub: enough surface for the audition path to run fully.
function fakeAudioContext() {
  const gainNodes = [];
  const sources = [];
  class FakeParam { constructor() { this.value = 0; } }
  class FakeGainNode { constructor() { this.gain = new FakeParam(); this.connected = null; gainNodes.push(this); } connect(n) { this.connected = n; } }
  class FakeBuffer {
    constructor(channels, length, sampleRate) { this.channels = channels; this.length = length; this.sampleRate = sampleRate; this.data = new Float32Array(length); }
    copyToChannel(arr, ch) { this.data.set(arr); }
  }
  class FakeSource { constructor() { this.buffer = null; this.loop = false; this.started = false; this.stopped = false; sources.push(this); } connect(n) { this.dest = n; } start() { this.started = true; } stop() { this.stopped = true; } }
  return {
    FakeAudioContext: class {
      constructor() { this.sampleRate = 48000; this.state = 'running'; this.destination = { dest: true }; }
      createGain() { return new FakeGainNode(); }
      createBuffer(ch, len, sr) { return new FakeBuffer(ch, len, sr); }
      createBufferSource() { return new FakeSource(); }
      resume() { this.state = 'running'; }
    },
    gainNodes, sources
  };
}

/* ------------------------------ Spec verifier ------------------------------ */
test('spec badge shows a live combined verdict at the default spec', () => {
  const h = bench();
  const badge = h.get('specBadge');
  // The biquad cannot meet the strict mask, so the combined verdict is FAIL
  // even though the designed FIR passes.
  assert.equal(badge.textContent, 'SPEC FAIL');
  assert.equal(badge.getAttribute('class'), 'badge badge-fail');
  assert.match(badge.getAttribute('title'), /passbandRipple/);
  assert.match(badge.getAttribute('title'), /FIR: /);
  h.dispose();
});

test('spec badge passes when both filters meet the mask', () => {
  const h = bench();
  input(h, 'specAttenDb', '12');
  const badge = h.get('specBadge');
  assert.equal(badge.textContent, 'SPEC PASS');
  assert.equal(badge.getAttribute('class'), 'badge badge-ok');
  assert.match(h.get('specReadout').textContent, /FIR PASS/);
  assert.match(h.get('specReadout').textContent, /IIR PASS/);
  h.dispose();
});

test('spec readout reports measured FIR and IIR compliance numbers', () => {
  const h = bench();
  const text = h.get('specReadout').textContent;
  assert.match(text, /FIR PASS/);
  assert.match(text, /IIR FAIL/);           // biquad cannot meet the strict mask
  assert.match(text, /ripple [-\d.]+ dB/);
  assert.match(text, /atten [-\d.]+ dB/);
  assert.match(text, /transition [\d.]+ Hz/);
  assert.match(text, /symmetry error [\d.e+-]+/);
  h.dispose();
});

test('spec mask canvas draws the mask regions and both responses', () => {
  const h = bench();
  const ctx = h.get('specCanvas').getContext('2d');
  assert.ok(ctx.calls.length > 20, 'spec canvas drew nothing');
  assert.ok(ctx.calls.some(c => c.name === 'fillRect'), 'mask regions not drawn');
  noNaNInCanvas(h, 'specCanvas');
  h.dispose();
});

test('tightening the attenuation spec flips the badge to FAIL', () => {
  const h = bench();
  input(h, 'specAttenDb', '90');
  const badge = h.get('specBadge');
  assert.equal(badge.textContent, 'SPEC FAIL');
  assert.equal(badge.getAttribute('class'), 'badge badge-fail');
  assert.match(h.get('specReadout').textContent, /FIR FAIL/);
  h.dispose();
});

test('degenerate spec edges deactivate the verifier honestly', () => {
  const h = bench();
  input(h, 'specEdge1Hz', '0');
  input(h, 'specEdge2Hz', '0');
  assert.equal(h.get('specBadge').textContent, 'SPEC --');
  assert.match(h.get('specReadout').textContent, /enter both band edges/);
  h.dispose();
});

test('spec ripple and symmetry fields feed the checker', () => {
  const h = bench();
  const before = h.sandbox.__FFTB__.data.specCheckFir.measured;
  assert.ok(Number.isFinite(before.passbandRippleDb));
  input(h, 'specSymmetryErr', '0');
  // symmetry error of a designed FIR is ~1e-16, still under 0? No: 0 spec -> fail check
  const chk = h.sandbox.__FFTB__.data.specCheckFir.checks.find(c => c.name === 'phaseSymmetry');
  assert.equal(chk.spec, 0);
  h.dispose();
});

test('spec verifier works for the highpass family orientation', () => {
  const h = bench();
  change(h, 'filterFamily', 'highpass');
  const d = h.sandbox.__FFTB__.data;
  assert.ok(d.spec, 'spec built');
  assert.ok(d.spec.passband[0] < d.spec.passband[1]);
  // The lowpass reference FIR is n/a on a highpass mask; the IIR carries the verdict.
  assert.equal(d.specCheckFir, null);
  assert.ok(d.specCheckIir);
  assert.equal(typeof d.specCheckIir.pass, 'boolean');
  assert.match(h.get('specBadge').textContent, /SPEC (PASS|FAIL)/);
  assert.match(h.get('specReadout').textContent, /FIR n\/a/);
  h.dispose();
});

test('spec verifier works for the bandpass family with two stopbands', () => {
  const h = bench();
  change(h, 'filterFamily', 'bandpass');
  const d = h.sandbox.__FFTB__.data;
  assert.ok(d.spec.stopbands.length >= 1);
  assert.equal(d.specCheckFir, null);
  assert.ok(d.specCheckIir.transitions.length <= 2);
  h.dispose();
});

test('spec badge follows the IIR verdict when the family is not lowpass', () => {
  const h = bench();
  // Generous spec: any sane highpass passes -> badge PASS, not FIR FAIL.
  change(h, 'filterFamily', 'highpass');
  input(h, 'specEdge1Hz', '1000');
  input(h, 'specEdge2Hz', '3000');
  input(h, 'specRippleDb', '6');
  input(h, 'specAttenDb', '10');
  assert.equal(h.get('specBadge').textContent, 'SPEC PASS');
  h.dispose();
});

test('edges outside Nyquist deactivate the verifier instead of a vacuous pass', () => {
  const h = bench();
  change(h, 'sampleRate', '16000');
  // Default edge2 of 9000 Hz exceeds the 8000 Hz Nyquist at 16 kHz.
  assert.equal(h.sandbox.__FFTB__.data.spec, null);
  assert.equal(h.get('specBadge').textContent, 'SPEC --');
  assert.match(h.get('specReadout').textContent, /inside \(0, Nyquist\)/);
  h.dispose();
});

/* ------------------------------ FIR response ------------------------------- */
test('FIR response segment buttons switch views and stay exclusive', () => {
  const h = bench();
  const buttons = h.document.querySelectorAll('[data-firview]');
  assert.equal(buttons.length, 3);
  for (const b of buttons) {
    b.click();
    assert.equal(b.getAttribute('aria-pressed'), 'true');
    assert.equal(buttons.filter(x => x.getAttribute('aria-pressed') === 'true').length, 1);
    assert.equal(h.sandbox.__FFTB__.state.firView, b.getAttribute('data-firview'));
    noNaNInCanvas(h, 'firBodeCanvas');
  }
  h.dispose();
});

test('FIR response canvas draws the magnitude view at startup', () => {
  const h = bench();
  const ctx = h.get('firBodeCanvas').getContext('2d');
  assert.ok(ctx.calls.length > 20, 'firBode canvas drew nothing');
  assert.match(h.get('firBodeReadout').textContent, /freq 0\.0000 x PI/);
  assert.match(h.get('firBodeReadout').textContent, /mag [-\d.]+ dB/);
  assert.match(h.get('firBodeReadout').textContent, /group delay [-\d.]+ samples/);
  h.dispose();
});

test('FIR group-delay view plots the constant delay of a linear-phase FIR', () => {
  const h = bench();
  h.document.querySelectorAll('[data-firview]').find(b => b.getAttribute('data-firview') === 'grpDelay').click();
  const d = h.sandbox.__FFTB__.data.firBode;
  const expected = (d.grpDelay.length, h.sandbox.__FFTB__.data.firDesign.taps - 1) / 2;
  assert.match(h.get('firBodeReadout').textContent, new RegExp(`grpDelay ${expected.toFixed(1)}`));
  noNaNInCanvas(h, 'firBodeCanvas');
  h.dispose();
});

test('FIR unwrapped-phase view is continuous, not sawtooth', () => {
  const h = bench();
  h.document.querySelectorAll('[data-firview]').find(b => b.getAttribute('data-firview') === 'phaseUnwrapped').click();
  const b = h.sandbox.__FFTB__.data.firBode;
  // Circle-zero pi jumps are absorbed: adjacent samples stay within pi.
  for (let i = 1; i < b.phaseUnwrapped.length; i++) {
    assert.ok(Math.abs(b.phaseUnwrapped[i] - b.phaseUnwrapped[i - 1]) < Math.PI + 0.5, `jump at ${i}`);
  }
  const last = b.phaseUnwrapped[b.phaseUnwrapped.length - 1];
  assert.ok(last < -3, `unwrapped endpoint ${last}`);
  noNaNInCanvas(h, 'firBodeCanvas');
  h.dispose();
});

test('FIR response probe tracks pointer and keyboard', () => {
  const h = bench();
  const canvas = h.get('firBodeCanvas');
  h.event(canvas, 'pointermove', { clientX: 54 });
  assert.match(h.get('firBodeReadout').textContent, /freq 0\.0000/);
  h.key(canvas, 'End');
  assert.match(h.get('firBodeReadout').textContent, /freq 1\.0000/);
  h.key(canvas, 'Home');
  assert.match(h.get('firBodeReadout').textContent, /freq 0\.0000/);
  h.dispose();
});

test('IIR Bode panel includes an unwrapped-phase view', () => {
  const h = bench();
  const buttons = h.document.querySelectorAll('[data-bode]');
  const uw = buttons.find(b => b.getAttribute('data-bode') === 'phaseUnwrapped');
  assert.ok(uw, 'missing unwrapped phase button');
  uw.click();
  assert.equal(h.sandbox.__FFTB__.state.bodeView, 'phaseUnwrapped');
  noNaNInCanvas(h, 'bodeCanvas');
  h.dispose();
});

test('biquad unwrapped-phase data is continuous under wraps', () => {
  const h = bench();
  const b = h.sandbox.__FFTB__.data.bode;
  // vm-realm typed array: check length + values rather than instanceof.
  assert.equal(b.phaseUnwrapped.length, b.freq.length);
  assert.ok(b.phaseUnwrapped.every(Number.isFinite));
  for (let i = 1; i < b.phaseUnwrapped.length; i++) {
    assert.ok(Math.abs(b.phaseUnwrapped[i] - b.phaseUnwrapped[i - 1]) < Math.PI + 0.5, `jump at ${i}`);
  }
  h.dispose();
});

/* ------------------------------- FIR z-plane ------------------------------- */
test('FIR z-plane panel renders every finite zero and the origin pole', () => {
  const h = bench();
  const svg = h.get('firZeroSvg');
  const marks = svg.querySelectorAll('.pz-mark');
  const d = h.sandbox.__FFTB__.data.firPz;
  // Zero clusters + the single origin-pole cluster.
  assert.ok(marks.length >= d.zeros.length * 0.9, `markers ${marks.length} vs zeros ${d.zeros.length}`);
  assert.match(h.get('firZeroNote').textContent, /finite zeros/);
  assert.match(h.get('firZeroNote').textContent, /pole z=0 x\d+/);
  h.dispose();
});

test('FIR z-plane note reports solver convergence honestly', () => {
  const h = bench();
  const note = h.get('firZeroNote').textContent;
  assert.match(note, /Solver (converged|unverified)/);
  assert.match(note, /max backward error [\d.e+-]+/);
  h.dispose();
});

test('clicking an FIR zero marker reports its exact coordinates and multiplicity', () => {
  const h = bench();
  const marks = h.get('firZeroSvg').querySelectorAll('.pz-mark');
  assert.ok(marks.length > 0);
  const zeroMark = marks.find(m => m.getAttribute('aria-label') === 'zero marker');
  zeroMark.dispatchEvent({ type: 'click' });
  const note = h.get('firZeroNote').textContent;
  assert.match(note, /zero [-0-9.]+\+?[-0-9.]+i/);
  assert.match(note, /multiplicity \d+/);
  assert.match(note, /radius [\d.]+/);
  h.dispose();
});

test('keyboard Enter on a pole marker reports the pole multiplicity', () => {
  const h = bench();
  const marks = h.get('firZeroSvg').querySelectorAll('.pz-mark');
  const poleMark = marks.find(m => m.getAttribute('aria-label') === 'pole marker');
  assert.ok(poleMark, 'no pole marker');
  h.event(poleMark, 'keydown', { key: 'Enter' });
  const note = h.get('firZeroNote').textContent;
  assert.match(note, /pole 0\.0000\+0\.0000i/);
  assert.match(note, /multiplicity 32/);
  h.dispose();
});

test('IIR pole-zero markers expose coordinate tooltips and pick readouts', () => {
  const h = bench();
  const marks = h.get('poleZeroSvg').querySelectorAll('.pz-mark');
  assert.ok(marks.length >= 3);
  const poleMark = marks.find(m => m.getAttribute('aria-label') === 'pole marker');
  poleMark.dispatchEvent({ type: 'click' });
  const note = h.get('poleZeroNote').textContent;
  assert.match(note, /pole [-0-9.]+\+?[-0-9.]+i/);
  assert.match(note, /multiplicity \d+/);
  h.dispose();
});

test('multiplicity badges appear for repeated roots', () => {
  const h = bench();
  // The default biquad has a double zero at z = -1 -> x2 label.
  const labels = h.get('poleZeroSvg').querySelectorAll('text.pz-mult').map(t => t.textContent);
  assert.ok(labels.includes('x2'), `multiplicity labels: ${JSON.stringify(labels)}`);
  // The FIR origin pole carries xM for the whole tap count.
  const firLabels = h.get('firZeroSvg').querySelectorAll('text.pz-mult').map(t => t.textContent);
  assert.ok(firLabels.some(t => t === 'x32'), `FIR pole labels: ${JSON.stringify(firLabels)}`);
  h.dispose();
});

test('FIR z-plane marker count tracks the tap count', () => {
  const h = bench();
  input(h, 'firTaps', '17');
  const d = h.sandbox.__FFTB__.data.firPz;
  assert.equal(d.zeros.length, 16);
  const zeroMarks = h.get('firZeroSvg').querySelectorAll('.pz-mark').filter(m => m.getAttribute('aria-label') === 'zero marker');
  assert.ok(zeroMarks.length >= 14, `zero markers ${zeroMarks.length} for 16 zeros`);
  h.dispose();
});

test('z-plane markers carry a title tooltip with exact coordinates', () => {
  const h = bench();
  const mark = h.get('firZeroSvg').querySelectorAll('.pz-mark').find(m => m.getAttribute('aria-label') === 'zero marker');
  const tip = mark.querySelectorAll('title')[0];
  assert.ok(tip, 'marker missing tooltip');
  assert.match(tip.textContent, /zero [-0-9.]+\+?[-0-9.]+i/);
  assert.match(tip.textContent, /multiplicity \d+/);
  h.dispose();
});

/* ------------------------------- WebAudio ---------------------------------- */
test('audition panel reports unavailable without an AudioContext', () => {
  const h = bench();
  h.get('audDryBtn').click();
  assert.match(h.get('audNote').textContent, /not available/i);
  assert.deepEqual(h.errors, []);
  h.dispose();
});

test('audition plays a synthesized loop through the stubbed WebAudio graph', () => {
  const stub = fakeAudioContext();
  const h = bench({ beforeBoot: ({ sandbox }) => { sandbox.AudioContext = stub.FakeAudioContext; } });
  h.get('audDryBtn').click();
  assert.equal(stub.sources.length, 1);
  assert.equal(stub.sources[0].started, true);
  assert.equal(stub.sources[0].loop, true);
  assert.ok(stub.sources[0].buffer.length > 60000);
  assert.match(h.get('audNote').textContent, /Playing dry/);
  h.dispose();
});

test('audition wet and FIR paths use the designed filters and connect to a gain node', () => {
  const stub = fakeAudioContext();
  const h = bench({ beforeBoot: ({ sandbox }) => { sandbox.AudioContext = stub.FakeAudioContext; } });
  h.get('audWetBtn').click();
  h.get('audFirBtn').click();
  assert.equal(stub.sources.length, 2);
  assert.match(h.get('audNote').textContent, /Playing fir/);
  assert.ok(stub.sources[1].dest === stub.gainNodes[0]);
  h.dispose();
});

test('audition level is clamped to 0.8 even with the slider at max', () => {
  const stub = fakeAudioContext();
  const h = bench({ beforeBoot: ({ sandbox }) => { sandbox.AudioContext = stub.FakeAudioContext; } });
  input(h, 'audGain', '1');
  h.get('audDryBtn').click();
  assert.equal(stub.gainNodes[0].gain.value, 0.8);
  assert.match(h.get('audNote').textContent, /level 0\.80/);
  h.dispose();
});

test('audition mute forces zero gain and restores on unmute', () => {
  const stub = fakeAudioContext();
  const h = bench({ beforeBoot: ({ sandbox }) => { sandbox.AudioContext = stub.FakeAudioContext; } });
  h.get('audDryBtn').click();
  h.get('audMuteBtn').click();
  assert.equal(stub.gainNodes[0].gain.value, 0);
  assert.equal(h.get('audMuteBtn').getAttribute('aria-pressed'), 'true');
  assert.equal(h.get('audMuteBtn').textContent, 'Unmute');
  h.get('audMuteBtn').click();
  assert.equal(stub.gainNodes[0].gain.value, 0.35);
  assert.equal(h.get('audMuteBtn').getAttribute('aria-pressed'), 'false');
  h.dispose();
});

test('audition stop halts the source and reports stopped', () => {
  const stub = fakeAudioContext();
  const h = bench({ beforeBoot: ({ sandbox }) => { sandbox.AudioContext = stub.FakeAudioContext; } });
  h.get('audDryBtn').click();
  h.get('audStopBtn').click();
  assert.equal(stub.sources[0].stopped, true);
  assert.match(h.get('audNote').textContent, /Stopped/);
  h.dispose();
});

test('audition buffer samples are clamped into [-1, 1]', () => {
  const stub = fakeAudioContext();
  const h = bench({ beforeBoot: ({ sandbox }) => { sandbox.AudioContext = stub.FakeAudioContext; } });
  input(h, 'noiseLevel', '0.6'); // loudest stimulus available
  h.get('audDryBtn').click();
  const data = stub.sources[0].buffer.data;
  for (let i = 0; i < data.length; i += 997) {
    assert.ok(Math.abs(data[i]) <= 1.000001, `sample ${i} = ${data[i]}`);
  }
  h.dispose();
});

/* ------------------------------ Self-test UI ------------------------------- */
test('self-test button renders the full battery results as list items', () => {
  const h = bench();
  h.get('selfTestBtn').click();
  const items = h.get('selfTestList').querySelectorAll('li.selftest-item');
  assert.equal(items.length, 14);           // 13 checks + summary
  assert.equal(items.filter(i => i.classList.contains('fail')).length, 0);
  assert.match(items[items.length - 1].textContent, /13\/13 passing/);
  assert.match(items[items.length - 1].textContent, /100% PASS, 0 failures/);
  h.dispose();
});

test('self-test button label changes after the first run', () => {
  const h = bench();
  assert.equal(h.get('selfTestBtn').textContent, 'Run self-tests');
  h.get('selfTestBtn').click();
  assert.equal(h.get('selfTestBtn').textContent, 'Re-run self-tests');
  h.dispose();
});

test('self-test list is a live region for screen readers', () => {
  const h = bench();
  assert.equal(h.get('selfTestList').getAttribute('aria-live'), 'polite');
  h.dispose();
});

/* ---------------------------- Hash bookmarking ----------------------------- */
test('bookmark button serializes state and copies a v2 hash URL', async () => {
  const h = bench();
  h.get('bookmarkBtn').click();
  await new Promise(r => setImmediate(r));
  assert.ok(h.copied.length >= 1, 'clipboard write missing');
  assert.match(h.copied[h.copied.length - 1], /#v=2&/);
  assert.match(h.copied[h.copied.length - 1], /sr=48000/);
  assert.match(h.get('exportNote').textContent, /Bookmark URL copied/);
  assert.match(h.sandbox.__FFTB__.state.lastExport, /^bookmark:v=2/);
  h.dispose();
});

test('bookmark hash contains the current spec edges', () => {
  const h = bench();
  input(h, 'specEdge1Hz', '1500');
  input(h, 'specEdge2Hz', '7000');
  h.get('bookmarkBtn').click();
  const hash = h.sandbox.__FFTB__.state.lastExport.slice(9);
  assert.match(hash, /e1=1500/);
  assert.match(hash, /e2=7000/);
  h.dispose();
});

test('a bookmarked URL hash restores the full state at startup', () => {
  const hash = '#v=2&p=antiAlias&fam=highpass&fc=0.3&sr=44100&n=1024&ft=65&wn=blackman&e1=1000&e2=8000&bv=grpDelay';
  const h = boot(__dirname, { beforeBoot: ({ sandbox }) => { sandbox.location = { hash }; } });
  assert.deepEqual(h.errors, []);
  assert.equal(h.get('filterFamily').value, 'highpass');
  assert.equal(h.get('sampleRate').value, '44100');
  assert.equal(h.get('fftSize').value, '1024');
  assert.equal(h.get('specEdge1Hz').value, '1000');
  assert.equal(h.get('specEdge2Hz').value, '8000');
  assert.equal(h.sandbox.__FFTB__.state.bodeView, 'grpDelay');
  assert.equal(h.sandbox.__FFTB__.state.hashRestored, true);
  assert.match(h.get('presetNote').textContent, /Restored from URL hash/);
  h.dispose();
});

test('an invalid hash falls back to the default preset cleanly', () => {
  const h = boot(__dirname, { beforeBoot: ({ sandbox }) => { sandbox.location = { hash: '#v=1&bogus=1' }; } });
  assert.deepEqual(h.errors, []);
  assert.equal(h.get('presetSelect').value, 'voiceBand');
  assert.equal(h.sandbox.__FFTB__.state.hashRestored, false);
  h.dispose();
});

test('hash restore recomputes data consistent with the restored controls', () => {
  const hash = '#v=2&fam=highpass&fc=0.3&sr=44100';
  const h = boot(__dirname, { beforeBoot: ({ sandbox }) => { sandbox.location = { hash }; } });
  const d = h.sandbox.__FFTB__.data;
  assert.equal(d.config.family, 'highpass');
  assert.equal(d.config.fc, 0.3);
  assert.equal(d.config.sampleRate, 44100);
  h.dispose();
});

test('a custom bookmark marks the preset as custom, not a named preset', () => {
  const hash = '#v=2&fc=0.31&sr=44100';
  const h = boot(__dirname, { beforeBoot: ({ sandbox }) => { sandbox.location = { hash }; } });
  assert.equal(h.get('presetSelect').value, 'custom');
  assert.match(h.get('presetNote').textContent, /restored from URL hash/i);
  h.dispose();
});

/* ------------------------------- New exports ------------------------------- */
test('embedded header export produces filter_coeffs.h with both filter sets', async () => {
  const h = bench();
  h.get('embeddedHeaderBtn').click();
  const file = h.document.downloads[0];
  assert.equal(file.filename, 'filter_coeffs.h');
  const text = await h.blobs.get(file.href).text();
  assert.match(text, /#define FILTER_FIR_TAPS 33/);
  assert.match(text, /#define FILTER_IIR_B0/);
  assert.match(text, /static const int32_t filter_b_q30\[3\]/);
  assert.match(text, /static const float filter_fir_b\[33\]/);
  assert.match(text, /filter_process/);
  assert.doesNotMatch(text, /NaN|Infinity|undefined/);
  h.dispose();
});

test('python export produces a SciPy snippet with b, a and FIR arrays', async () => {
  const h = bench();
  h.get('pythonBtn').click();
  const file = h.document.downloads[0];
  assert.equal(file.filename, 'filter_design.py');
  const text = await h.blobs.get(file.href).text();
  assert.match(text, /from scipy import signal/);
  assert.match(text, /filter_b = np\.array/);
  assert.match(text, /filter_a = np\.array\(\[1\.0/);
  assert.match(text, /filter_fir = np\.array/);
  assert.match(text, /SAMPLE_RATE = float\(48000\)/);
  h.dispose();
});

test('report JSON export embeds a SHA-256 fingerprint and spec verdict', async () => {
  const h = bench();
  h.get('reportJsonBtn').click();
  const file = h.document.downloads[0];
  assert.equal(file.filename, 'design_report.json');
  const r = JSON.parse(await h.blobs.get(file.href).text());
  assert.equal(r.fingerprintAlgorithm, 'SHA-256');
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(r.report.specCheck.fir.pass, true);
  assert.equal(r.report.stability.stable, true);
  assert.equal(r.report.fir.taps, 33);
  h.dispose();
});

test('report CSV export carries the fingerprint and stability verdict', async () => {
  const h = bench();
  h.get('reportCsvBtn').click();
  const file = h.document.downloads[0];
  assert.equal(file.filename, 'design_report.csv');
  const text = await h.blobs.get(file.href).text();
  assert.match(text, /fingerprint_sha256,[0-9a-f]{64}/);
  assert.match(text, /stable,true/);
  assert.match(text, /fir_taps,33/);
  h.dispose();
});

test('all four new export buttons are disabled while an error is visible', () => {
  const h = bench();
  const original = h.sandbox.DSP.designFilter;
  h.sandbox.DSP.designFilter = () => { throw new Error('injected design failure'); };
  input(h, 'cutoff', '0.3');
  for (const id of ['embeddedHeaderBtn', 'pythonBtn', 'reportJsonBtn', 'reportCsvBtn']) {
    assert.equal(h.get(id).disabled, true, id);
  }
  h.sandbox.DSP.designFilter = original;
  input(h, 'cutoff', '0.31');
  for (const id of ['embeddedHeaderBtn', 'pythonBtn', 'reportJsonBtn', 'reportCsvBtn']) {
    assert.equal(h.get(id).disabled, false, id);
  }
  h.dispose();
});

test('export note reports the generated file name for new exports', () => {
  const h = bench();
  h.get('reportJsonBtn').click();
  assert.equal(h.get('exportNote').textContent, 'Generated design_report.json locally.');
  h.get('embeddedHeaderBtn').click();
  assert.equal(h.get('exportNote').textContent, 'Generated filter_coeffs.h locally.');
  h.dispose();
});

test('report JSON stays finite even at an extreme spec', async () => {
  const h = bench();
  input(h, 'specAttenDb', '140');
  h.get('reportJsonBtn').click();
  const text = await h.blobs.get(h.document.downloads[0].href).text();
  assert.doesNotMatch(text, /NaN|Infinity(?!\w)/);
  h.dispose();
});

/* ------------------------------ Panel health ------------------------------- */
test('new canvases render finite output for every preset', () => {
  const h = bench();
  for (const name of ['voiceBand', 'antiAlias', 'notchTwoTone', 'widebandNoise']) {
    change(h, 'presetSelect', name);
    for (const id of ['firBodeCanvas', 'specCanvas']) noNaNInCanvas(h, id);
    const d = h.sandbox.__FFTB__.data;
    assert.ok(d.firBode.mag.every(Number.isFinite));
    assert.ok(d.firPz.zeros.every(z => Number.isFinite(z.real)));
  }
  h.dispose();
});

test('spec badge and z-plane survive a theme toggle redraw', () => {
  const h = bench();
  h.get('themeToggle').click();
  assert.match(h.get('specBadge').textContent, /SPEC (PASS|FAIL)/);
  assert.ok(h.get('firZeroSvg').querySelectorAll('.pz-mark').length > 0);
  noNaNInCanvas(h, 'specCanvas');
  noNaNInCanvas(h, 'firBodeCanvas');
  h.dispose();
});

test('resize redraws the new canvases at the right aspect', () => {
  const h = bench({ dpr: 2 });
  const canvas = h.get('firBodeCanvas');
  canvas.rect = { left: 0, top: 0, width: 600, height: 165 };
  h.resize();
  assert.equal(canvas.width, 1200);
  const spec = h.get('specCanvas');
  assert.ok(spec.width > 0);
  noNaNInCanvas(h, 'firBodeCanvas');
  h.dispose();
});

test('fir z-plane marks remain after probing the response canvas', () => {
  const h = bench();
  h.event(h.get('firBodeCanvas'), 'pointermove', { clientX: 200 });
  assert.ok(h.get('firZeroSvg').querySelectorAll('.pz-mark').length > 0);
  assert.match(h.get('firZeroNote').textContent, /finite zeros/);
  h.dispose();
});

test('status line reports FIR taps after recomputation', () => {
  const h = bench();
  assert.match(h.get('statusLine').textContent, /33-tap FIR/);
  input(h, 'firTaps', '65');
  assert.match(h.get('statusLine').textContent, /65-tap FIR/);
  h.dispose();
});
