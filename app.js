/* FFT Filter Bench controller. Uses the shared DSP engine (window.DSP). */
'use strict';
(function () {
  const D = globalThis.DSP;
  const $ = id => document.getElementById(id);
  const canvasIds = ['signalCanvas', 'spectrumCanvas', 'bodeCanvas', 'firCanvas'];

  const PRESETS = {
    voiceBand: {
      label: 'Synthetic preset: voice-band cleanup',
      note: 'A 1 kHz tone stands in for speech; tones at 7 kHz and 17 kHz stand in for interference. Lowpass at fc 0.08.',
      tone1Hz: 1000, tone2Hz: 7000, noise: 0.10, family: 'butterworth', fc: 0.08, rippleDb: 1, Q: 4,
      sampleRate: 48000, fftSize: 2048, firTaps: 33, window: 'hamming'
    },
    antiAlias: {
      label: 'Synthetic preset: anti-alias study',
      note: 'A tone close to Nyquist illustrates transition-band behavior. Lowpass at fc 0.22 with a Blackman FIR.',
      tone1Hz: 3000, tone2Hz: 19000, noise: 0.05, family: 'butterworth', fc: 0.22, rippleDb: 1, Q: 4,
      sampleRate: 48000, fftSize: 2048, firTaps: 65, window: 'blackman'
    },
    notchTwoTone: {
      label: 'Synthetic preset: two-tone isolation',
      note: 'Synthetic preset: two well-separated tones with a bandpass centered on tone A. Q controls selectivity.',
      tone1Hz: 4000, tone2Hz: 14000, noise: 0.08, family: 'bandpass', fc: 0.083, rippleDb: 1, Q: 6,
      sampleRate: 48000, fftSize: 2048, firTaps: 41, window: 'hamming'
    },
    widebandNoise: {
      label: 'Synthetic preset: wideband noise',
      note: 'Noise-dominated benchmark signal with a Chebyshev I lowpass showing passband ripple.',
      tone1Hz: 2000, tone2Hz: 9000, noise: 0.45, family: 'chebyshev', fc: 0.12, rippleDb: 2, Q: 4,
      sampleRate: 48000, fftSize: 1024, firTaps: 25, window: 'hann'
    }
  };

  const state = {
    preset: 'voiceBand', sampleRate: 48000, fftSize: 2048,
    tone1Hz: 1000, tone2Hz: 7000, noise: 0.10, seed: 12345,
    family: 'butterworth', fc: 0.08, rippleDb: 1, Q: 4,
    firTaps: 33, window: 'hamming', spectrumWindow: 'rectangular', plotMode: 'both',
    bodeView: 'mag',
    probe: { signal: null, spectrum: 0, bode: 0, fir: 0 },
    pinned: false,
    data: null,
    lastExport: ''
  };

  let dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
  // Fixed aspect ratios from the HTML attributes. canvas.width/height are
  // mutable DPI-scaled values, so they cannot be used to derive the ratio.
  const RATIOS = { signalCanvas: 220 / 880, spectrumCanvas: 220 / 880, bodeCanvas: 240 / 880, firCanvas: 180 / 880 };

  function fmt(v, digits = 4) { return Number(v).toFixed(digits); }
  function finite(v, fallback = 0) { return Number.isFinite(v) ? v : fallback; }

  function showError(message) {
    const node = $('errorStatus');
    node.textContent = message;
    node.hidden = !message;
    for (const id of ['jsonBtn', 'coeffCsvBtn', 'bodeCsvBtn', 'spectrumCsvBtn', 'cHeaderBtn', 'wavInputBtn', 'wavOutputBtn']) {
      $(id).disabled = !!message;
    }
  }

  function readControls() {
    state.sampleRate = Number($('sampleRate').value);
    state.fftSize = Number($('fftSize').value);
    state.tone1Hz = Number($('tone1Hz').value);
    state.tone2Hz = Number($('tone2Hz').value);
    state.noise = Number($('noiseLevel').value);
    state.seed = Math.max(0, Math.min(4294967295, Math.floor(Number($('seedInput').value) || 0)));
    state.family = $('filterFamily').value;
    state.fc = Number($('cutoff').value);
    state.rippleDb = Number($('rippleDb').value);
    state.Q = Number($('qFactor').value);
    state.firTaps = Number($('firTaps').value);
    state.window = $('windowSelect').value;
    state.spectrumWindow = $('windowForSpectrum').value;
    state.plotMode = $('plotMode').value;
  }

  function syncControlLabels() {
    $('tone1Out').textContent = String(state.tone1Hz);
    $('tone2Out').textContent = String(state.tone2Hz);
    $('noiseOut').textContent = fmt(state.noise, 2);
    $('cutoffOut').textContent = fmt(state.fc, 3);
    $('rippleOut').textContent = fmt(state.rippleDb, 1);
    $('qOut').textContent = fmt(state.Q, 1);
    $('firTapsOut').textContent = String(state.firTaps);
    const isCheb = state.family === 'chebyshev';
    const needsQ = state.family === 'bandpass';
    $('rippleRow').hidden = !isCheb;
    $('rippleDb').disabled = !isCheb;
    $('qRow').hidden = !needsQ;
    $('qFactor').disabled = !needsQ;
  }

  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    $('sampleRate').value = String(p.sampleRate);
    $('fftSize').value = String(p.fftSize);
    $('tone1Hz').value = String(p.tone1Hz);
    $('tone2Hz').value = String(p.tone2Hz);
    $('noiseLevel').value = String(p.noise);
    $('filterFamily').value = p.family;
    $('cutoff').value = String(p.fc);
    $('rippleDb').value = String(p.rippleDb);
    $('qFactor').value = String(p.Q);
    $('firTaps').value = String(p.firTaps);
    $('windowSelect').value = p.window;
    state.preset = name;
    $('presetNote').textContent = p.note;
    readControls(); syncControlLabels(); recompute();
  }

  function compute() {
    const config = {
      family: state.family, fc: state.fc, rippleDb: state.rippleDb, Q: state.Q,
      sampleRate: state.sampleRate, fftSize: state.fftSize,
      tone1Hz: state.tone1Hz, tone2Hz: state.tone2Hz, noise: state.noise, seed: state.seed,
      firTaps: state.firTaps, firWindow: state.window, spectrumWindow: state.spectrumWindow
    };
    const coeffs = D.designFilter({ family: config.family, fc: config.fc, rippleDb: config.rippleDb, Q: config.Q });
    for (const v of Object.values(coeffs)) if (!Number.isFinite(v)) throw new Error('Nonfinite filter coefficients');
    D.validateCutoff(config.fc);

    const tones = [
      { freqHz: config.tone1Hz, amp: 0.8 },
      { freqHz: config.tone2Hz, amp: 0.5 },
      { freqHz: Math.min(config.sampleRate * 0.47, config.tone2Hz + 8000), amp: 0.3 }
    ];
    const sig = D.synthesizeSignal({
      n: config.fftSize, fs: config.sampleRate, tones, noise: config.noise, seed: config.seed
    });
    const input = sig.samples;
    const iir = D.biquadFilter(input, coeffs);
    const firDesign = D.designFirLowpass({ taps: config.firTaps, fc: config.fc, window: config.firWindow });
    const firOut = D.firFilter(input, firDesign.coefficients);

    const bode = D.biquadBode(coeffs, 512);
    const pz = D.poleZeroPlotData(coeffs);
    const stability = D.biquadStability(coeffs);

    // Windowed FFT spectra of input and IIR output.
    const win = D.windowFunction(config.spectrumWindow, input.length);
    const specIn = D.fftReal(Float64Array.from(input, (v, i) => v * win[i]));
    const specOut = D.fftReal(Float64Array.from(iir, (v, i) => v * win[i]));
    const magIn = D.magnitude(specIn.real, specIn.imag);
    const magOut = D.magnitude(specOut.real, specOut.imag);
    const spectrum = {
      bins: Float64Array.from({ length: Math.floor(input.length / 2) + 1 }, (_, k) => k / input.length),
      magInDb: Float64Array.from({ length: Math.floor(input.length / 2) + 1 }, (_, k) => D.linearToDb(magIn[k] / (input.length / 2))),
      magOutDb: Float64Array.from({ length: Math.floor(input.length / 2) + 1 }, (_, k) => D.linearToDb(magOut[k] / (input.length / 2)))
    };
    const { timeEnergy, freqEnergy } = D.parsevalEnergy(input, null, specIn.real, specIn.imag);
    const parsevalError = Math.abs(timeEnergy - freqEnergy) / Math.max(timeEnergy, 1e-12);

    const diagnostics = D.filterDiagnostics(input, iir, coeffs, config.tone1Hz, config.sampleRate);
    const responseAtCutoff = D.biquadFrequencyResponse(coeffs, D.TAU * config.fc);
    const dcDelay = D.biquadFrequencyResponse(coeffs, 0).groupDelay;

    for (const arr of [input, iir, firOut, bode.mag, bode.phase, bode.grpDelay]) {
      for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) throw new Error('Nonfinite computed sample');
    }

    return {
      config, coeffs, input, iir, firOut, firDesign, bode, pz, stability,
      spectrum, parsevalError, diagnostics, responseAtCutoff, dcDelay,
      allFinite: true
    };
  }

  function recompute() {
    try {
      readControls();
      state.data = compute();
      showError('');
      syncControlLabels();
      redraw();
      updateDiagnostics();
      updateTables();
      $('statusLine').textContent = `${PRESETS[state.preset] ? PRESETS[state.preset].label : 'Custom synthetic benchmark'} | ${state.fftSize}-point FFT | ${state.sampleRate} Hz | ${state.data.bode.freq.length}-point Bode sweep | ${state.data.firTaps || state.data.firDesign.taps}-tap FIR`;
      $('statusLine').classList.remove('warn');
      $('footerStatus').textContent = 'Computed locally, no network requests';
      $('exportNote').textContent = 'Files are generated locally from the current state.';
    } catch (err) {
      state.data = null;
      showError('Computation failed: ' + err.message);
      $('statusLine').textContent = 'Invalid parameters: ' + err.message;
      $('statusLine').classList.add('warn');
    }
  }

  function updateDiagnostics() {
    const d = state.data;
    $('statStability').textContent = d.stability.stable ? 'STABLE' : 'UNSTABLE';
    $('statStability').style.color = d.stability.stable ? 'var(--fir)' : 'var(--warn)';
    $('statPole').textContent = fmt(d.stability.maxPoleRadius, 5);
    $('statGain').textContent = fmt(D.linearToDb(d.responseAtCutoff.magnitude), 2) + ' dB';
    $('statDelay').textContent = fmt(d.dcDelay, 3) + ' samples';
    $('statInputRms').textContent = fmt(d.diagnostics.inputRms, 4);
    $('statOutputRms').textContent = fmt(d.diagnostics.outputRms, 4);
    $('statParseval').textContent = d.parsevalError.toExponential(2);
    $('statFinite').textContent = d.allFinite ? 'PASS' : 'FAIL';
  }

  function updateTables() {
    const d = state.data, c = d.coeffs;
    const rows = [
      ['b0', fmt(c.b0, 9)], ['b1', fmt(c.b1, 9)], ['b2', fmt(c.b2, 9)],
      ['a1', fmt(c.a1, 9)], ['a2', fmt(c.a2, 9)],
      ['FIR taps', String(d.firDesign.taps)],
      ['FIR window', d.firDesign.window],
      ['FIR DC sum', fmt(Array.from(d.firDesign.coefficients).reduce((a, b) => a + b, 0), 9)],
      ['Max pole radius', fmt(d.stability.maxPoleRadius, 6)],
      ['Passband ripple dB', fmt(d.config.rippleDb, 2)],
      ['RMS ratio', fmt(d.diagnostics.rmsRatio, 5)]
    ];
    const body = $('coeffTable').querySelector('tbody');
    body.textContent = '';
    for (const [k, v] of rows) {
      const tr = document.createElement('tr');
      const th = document.createElement('th'); th.scope = 'row'; th.textContent = k;
      const td = document.createElement('td'); td.textContent = v;
      tr.appendChild(th); tr.appendChild(td); body.appendChild(tr);
    }
    const table = $('bodeTable');
    table.textContent = 'Normalized frequency, magnitude dB, phase rad, group delay samples. ' +
      d.bode.freq.length + ' computed points. Sample at DC: ' + fmt(d.bode.mag[0], 3) +
      ' dB, group delay ' + fmt(d.bode.grpDelay[0], 3) + ' samples.';
  }

  /* ---------------------------- Canvas drawing ---------------------------- */
  function prepareCanvas(id) {
    const canvas = $(id);
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 880 };
    const cssW = Math.max(280, Math.round(rect.width || 880));
    const ratio = RATIOS[id] || 0.25;
    const cssH = Math.max(120, Math.round(cssW * ratio));
    const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { canvas, ctx, w: cssW, h: cssH };
  }

  function cssVar(name, fallback) {
    let v = '';
    if (globalThis.getComputedStyle) v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  function frame(ctx, w, h, m, rows) {
    const grid = cssVar('--grid', '#26344f'), muted = cssVar('--muted', '#8296b4');
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = muted;
    for (let i = 0; i <= rows; i++) {
      const y = m.t + (h - m.t - m.b) * i / rows;
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(w - m.r, y); ctx.stroke();
    }
    for (let i = 0; i <= 8; i++) {
      const x = m.l + (w - m.l - m.r) * i / 8;
      ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, h - m.b); ctx.stroke();
    }
    ctx.strokeStyle = muted;
    ctx.beginPath(); ctx.moveTo(m.l, m.t); ctx.lineTo(m.l, h - m.b); ctx.lineTo(w - m.r, h - m.b); ctx.stroke();
  }

  function polyline(ctx, values, m, w, h, min, max, color, width) {
    const n = values.length;
    if (n < 2) return;
    const range = (max - min) || 1;
    ctx.strokeStyle = color; ctx.lineWidth = width || 1.6;
    ctx.beginPath();
    const stride = Math.max(1, Math.floor(n / Math.max(1, (w - m.l - m.r))));
    for (let i = 0; i < n; i += stride) {
      const x = m.l + (w - m.l - m.r) * i / (n - 1);
      const y = m.t + (h - m.t - m.b) * (1 - (finite(values[i], min) - min) / range);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function marker(ctx, x, y, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, y.canvasH || 10000); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
  }

  function drawSignal() {
    const { ctx, w, h } = prepareCanvas('signalCanvas');
    const d = state.data, m = { l: 48, r: 12, t: 12, b: 24 };
    frame(ctx, w, h, m, 4);
    const values = d.input;
    let peak = 0.0001;
    for (const v of values) peak = Math.max(peak, Math.abs(v));
    peak *= 1.12;
    if (state.plotMode === 'both') polyline(ctx, values, m, w, h, -peak, peak, cssVar('--muted', '#8296b4'), 1.1);
    polyline(ctx, d.iir, m, w, h, -peak, peak, cssVar('--signal-a', '#62a6ff'), 1.8);
    polyline(ctx, d.firOut, m, w, h, -peak, peak, cssVar('--signal-b', '#ff87b2'), 1.3);
    ctx.fillStyle = cssVar('--muted', '#8296b4'); ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('+' + fmt(peak, 2), 4, m.t + 9);
    ctx.fillText('-' + fmt(peak, 2), 4, h - m.b);
    ctx.fillText('0 to ' + (values.length - 1) + ' samples', m.l, h - 6);
    if (state.probe.signal != null) {
      const x = m.l + (w - m.l - m.r) * state.probe.signal;
      ctx.strokeStyle = cssVar('--accent', '#62a6ff'); ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, h - m.b); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  function drawSpectrum() {
    const { ctx, w, h } = prepareCanvas('spectrumCanvas');
    const d = state.data, s = d.spectrum, m = { l: 48, r: 12, t: 12, b: 24 };
    frame(ctx, w, h, m, 4);
    const n = s.bins.length;
    const min = -110, max = 5;
    polyline(ctx, s.magInDb, m, w, h, min, max, cssVar('--muted', '#8296b4'), 1.1);
    polyline(ctx, s.magOutDb, m, w, h, min, max, cssVar('--signal-a', '#62a6ff'), 1.7);
    ctx.fillStyle = cssVar('--muted', '#8296b4'); ctx.font = '10px ui-monospace, monospace';
    for (let i = 0; i <= 4; i++) ctx.fillText((max - (max - min) * i / 4).toFixed(0) + ' dB', 3, m.t + (h - m.t - m.b) * i / 4 + 3);
    ctx.fillText('0', m.l, h - 6);
    ctx.fillText((d.config.sampleRate / 2000).toFixed(1) + ' kHz', w - 58, h - 6);
    const k = Math.min(n - 1, Math.max(0, Math.round(state.probe.spectrum)));
    const x = m.l + (w - m.l - m.r) * k / (n - 1);
    ctx.strokeStyle = cssVar('--accent', '#62a6ff'); ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, h - m.b); ctx.stroke(); ctx.setLineDash([]);
    $('spectrumReadout').textContent = `bin ${k} | ${fmt(s.bins[k] * d.config.sampleRate, 1)} Hz | input ${fmt(s.magInDb[k], 2)} dB | output ${fmt(s.magOutDb[k], 2)} dB`;
  }

  function drawBode() {
    const { ctx, w, h } = prepareCanvas('bodeCanvas');
    const d = state.data, b = d.bode, m = { l: 54, r: 12, t: 12, b: 24 };
    frame(ctx, w, h, m, 4);
    const key = state.bodeView;
    const values = Array.from(b[key], v => key === 'grpDelay' ? D.clamp(v, -100, 100) : v);
    let min = Math.min(...values), max = Math.max(...values);
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = -1; max = 1; }
    if (max - min < 1e-9) { min -= 1; max += 1; }
    const pad = (max - min) * 0.08; min -= pad; max += pad;
    polyline(ctx, values, m, w, h, min, max, cssVar('--fir', '#4ade80'), 2);
    // Mark the designed cutoff frequency on the Bode axis.
    const fcX = m.l + (w - m.l - m.r) * (D.TAU * d.config.fc / Math.PI);
    if (fcX <= w - m.r) {
      ctx.strokeStyle = cssVar('--signal-b', '#ff87b2'); ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(fcX, m.t); ctx.lineTo(fcX, h - m.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = cssVar('--signal-b', '#ff87b2');
      ctx.fillText('w0', Math.min(fcX + 3, w - m.r - 14), m.t + 10);
    }
    ctx.fillStyle = cssVar('--muted', '#8296b4'); ctx.font = '10px ui-monospace, monospace';
    for (let i = 0; i <= 4; i++) ctx.fillText((max - (max - min) * i / 4).toFixed(1), 3, m.t + (h - m.t - m.b) * i / 4 + 3);
    ctx.fillText('DC', m.l, h - 6); ctx.fillText('Nyquist', w - 52, h - 6);
    const n = b.freq.length, idx = Math.min(n - 1, Math.max(0, Math.round(state.probe.bode)));
    const x = m.l + (w - m.l - m.r) * idx / (n - 1);
    ctx.strokeStyle = cssVar('--accent', '#62a6ff'); ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, h - m.b); ctx.stroke(); ctx.setLineDash([]);
    const units = key === 'mag' ? 'dB' : key === 'phase' ? 'rad' : 'samples';
    $('bodeReadout').textContent = `freq ${fmt(b.freq[idx], 4)} x PI | ${fmt(b.mag[idx], 3)} dB | ${fmt(b.phase[idx], 3)} rad | group delay ${fmt(b.grpDelay[idx], 3)} ${units}`;
  }

  function drawFir() {
    const { ctx, w, h } = prepareCanvas('firCanvas');
    const d = state.data, taps = d.firDesign.coefficients, m = { l: 48, r: 12, t: 12, b: 24 };
    frame(ctx, w, h, m, 4);
    let peak = 0.0001;
    for (const v of taps) peak = Math.max(peak, Math.abs(v));
    peak *= 1.15;
    const zeroY = m.t + (h - m.t - m.b) / 2;
    const color = cssVar('--fir', '#4ade80');
    ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    for (let i = 0; i < taps.length; i++) {
      const x = m.l + (w - m.l - m.r) * i / Math.max(1, taps.length - 1);
      const y = zeroY - (h - m.t - m.b) / 2 * taps[i] / peak;
      ctx.beginPath(); ctx.moveTo(x, zeroY); ctx.lineTo(x, y); ctx.stroke();
      ctx.fillStyle = i === Math.round(state.probe.fir) ? cssVar('--signal-b', '#ff87b2') : color;
      ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
    }
    const i = Math.min(taps.length - 1, Math.max(0, Math.round(state.probe.fir)));
    $('firReadout').textContent = `tap ${i} of ${taps.length} | h[${i}] = ${fmt(taps[i], 7)} | ${d.firDesign.window} window | fc ${fmt(d.firDesign.fc, 3)}`;
  }

  function drawPoleZero() {
    const svg = $('poleZeroSvg');
    const d = state.data;
    // Rebuild children deterministically: one title, one desc, then plot marks.
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const ns = 'http://www.w3.org/2000/svg';
    const add = (tag, attrs) => {
      const node = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      svg.appendChild(node);
      return node;
    };
    const title = add('title', {}); title.textContent = 'Pole-zero plane';
    const desc = add('desc', {}); desc.textContent = 'Zeros as circles, poles as crosses, dashed unit circle.';
    const cx = 200, cy = 200, scale = 155;
    const grid = cssVar('--grid', '#26344f'), axis = cssVar('--muted', '#8296b4');
    for (let r = 0.25; r <= 1.5; r += 0.25) add('circle', { cx, cy, r: r * scale, fill: 'none', stroke: grid, 'stroke-width': 0.6 });
    add('line', { x1: 0, y1: cy, x2: 400, y2: cy, stroke: axis, 'stroke-width': 1 });
    add('line', { x1: cx, y1: 0, x2: cx, y2: 400, stroke: axis, 'stroke-width': 1 });
    add('circle', { cx, cy, r: scale, fill: 'none', stroke: cssVar('--fir', '#4ade80'), 'stroke-width': 2, 'stroke-dasharray': '4,4' });
    for (const z of d.pz.zeros) add('circle', { cx: cx + z.x * scale, cy: cy - z.y * scale, r: 7, fill: 'none', stroke: cssVar('--signal-a', '#62a6ff'), 'stroke-width': 2 });
    for (const p of d.pz.poles) {
      const x = cx + p.x * scale, y = cy - p.y * scale, s = 7;
      const c = cssVar('--signal-b', '#ff87b2');
      add('line', { x1: x - s, y1: y - s, x2: x + s, y2: y + s, stroke: c, 'stroke-width': 2 });
      add('line', { x1: x + s, y1: y - s, x2: x - s, y2: y + s, stroke: c, 'stroke-width': 2 });
    }
    $('poleZeroNote').textContent = `${d.stability.stable ? 'Stable' : 'Unstable'}: max pole radius ${fmt(d.stability.maxPoleRadius, 5)}, ${d.stability.minPhase ? 'minimum-phase zeros' : 'zeros outside unit circle'}.`;
  }

  function redraw() {
    if (!state.data) return;
    drawSignal(); drawSpectrum(); drawBode(); drawFir(); drawPoleZero();
  }

  /* ------------------------------- Exports -------------------------------- */
  function download(name, content, mime) {
    const blob = content instanceof Uint8Array ? new Blob([content], { type: mime }) : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    state.lastExport = name;
    $('exportNote').textContent = 'Generated ' + name + ' locally.';
  }

  function currentExperiment() {
    const d = state.data;
    return {
      config: d.config, coeffs: d.coeffs, bode: d.bode,
      spectrum: { bins: d.spectrum.bins, mag: d.spectrum.magOutDb },
      diagnostics: d.diagnostics
    };
  }

  function bindExports() {
    $('jsonBtn').addEventListener('click', () => {
      if (!state.data) return;
      download('fft-filter-bench-experiment.json', D.exportExperimentJSON(currentExperiment()), 'application/json');
    });
    $('coeffCsvBtn').addEventListener('click', () => {
      if (!state.data) return;
      download('biquad_coefficients.csv', D.exportCSV(state.data.coeffs, 'biquad'), 'text/csv');
    });
    $('bodeCsvBtn').addEventListener('click', () => {
      if (!state.data) return;
      download('bode_response.csv', D.exportBodeCSV(state.data.bode), 'text/csv');
    });
    $('spectrumCsvBtn').addEventListener('click', () => {
      if (!state.data) return;
      download('spectrum.csv', D.exportSpectrumCSV(state.data.input, state.data.config.sampleRate), 'text/csv');
    });
    $('cHeaderBtn').addEventListener('click', () => {
      if (!state.data) return;
      download('biquad_coeffs.h', D.exportCHeader(state.data.coeffs, 'biquad'), 'text/plain');
    });
    $('wavInputBtn').addEventListener('click', () => {
      if (!state.data) return;
      download('fft-filter-bench-input.wav', D.exportWAV(state.data.input, state.data.config.sampleRate), 'audio/wav');
    });
    $('wavOutputBtn').addEventListener('click', () => {
      if (!state.data) return;
      download('fft-filter-bench-filtered.wav', D.exportWAV(state.data.iir, state.data.config.sampleRate), 'audio/wav');
    });
  }

  /* --------------------------- Probe interaction -------------------------- */
  function probeFromPointer(id, ev, key) {
    const canvas = $(id);
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, width: 880 };
    const x = Number(ev.clientX) - (rect.left || 0);
    const t = D.clamp(x / Math.max(1, rect.width || 880), 0, 1);
    if (key === 'signal') state.probe.signal = t;
    else if (key === 'spectrum') state.probe.spectrum = Math.round(t * (state.data.spectrum.bins.length - 1));
    else if (key === 'bode') state.probe.bode = Math.round(t * (state.data.bode.freq.length - 1));
    else if (key === 'fir') state.probe.fir = Math.round(t * (state.data.firDesign.coefficients.length - 1));
    redraw();
    if (key === 'signal') {
      const i = Math.min(state.data.input.length - 1, Math.round(t * (state.data.input.length - 1)));
      $('signalReadout').textContent = `sample ${i} | input ${fmt(state.data.input[i], 5)} | iir ${fmt(state.data.iir[i], 5)} | fir ${fmt(state.data.firOut[i], 5)}`;
    }
  }

  function bindProbes() {
    for (const [id, key] of [['signalCanvas', 'signal'], ['spectrumCanvas', 'spectrum'], ['bodeCanvas', 'bode'], ['firCanvas', 'fir']]) {
      const canvas = $(id);
      canvas.addEventListener('pointermove', ev => {
        if (state.pinned || !state.data) return;
        probeFromPointer(id, ev, key);
      });
      canvas.addEventListener('keydown', ev => {
        if (!state.data) return;
        const step = ev.shiftKey ? 10 : 1;
        let handled = true;
        if (key === 'signal') {
          const cur = state.probe.signal == null ? 0.5 : state.probe.signal;
          if (ev.key === 'ArrowLeft') state.probe.signal = D.clamp(cur - step / 100, 0, 1);
          else if (ev.key === 'ArrowRight') state.probe.signal = D.clamp(cur + step / 100, 0, 1);
          else if (ev.key === 'Home') state.probe.signal = 0;
          else if (ev.key === 'End') state.probe.signal = 1;
          else handled = false;
        } else {
          const max = key === 'spectrum' ? state.data.spectrum.bins.length - 1 :
            key === 'bode' ? state.data.bode.freq.length - 1 : state.data.firDesign.coefficients.length - 1;
          if (ev.key === 'ArrowLeft') state.probe[key] = Math.max(0, state.probe[key] - step);
          else if (ev.key === 'ArrowRight') state.probe[key] = Math.min(max, state.probe[key] + step);
          else if (ev.key === 'Home') state.probe[key] = 0;
          else if (ev.key === 'End') state.probe[key] = max;
          else handled = false;
        }
        if (ev.key === 'Enter') {
          state.pinned = !state.pinned;
          $('pinHint').textContent = state.pinned ? 'Probe pinned' : 'Probe free';
          handled = true;
        } else if (ev.key === 'Escape') {
          state.pinned = false;
          $('pinHint').textContent = 'Probe free';
          handled = true;
        }
        if (handled) {
          ev.preventDefault();
          redraw();
          if (key === 'signal') {
            const i = Math.min(state.data.input.length - 1, Math.round(state.probe.signal * (state.data.input.length - 1)));
            $('signalReadout').textContent = `sample ${i} | input ${fmt(state.data.input[i], 5)} | iir ${fmt(state.data.iir[i], 5)} | fir ${fmt(state.data.firOut[i], 5)}`;
          }
        }
      });
    }
  }

  /* ------------------------------ Bindings -------------------------------- */
  function bindControls() {
    const onChange = ev => {
      if (ev.target.id !== 'presetSelect') {
        const custom = $('presetSelect');
        state.preset = 'custom';
        custom.value = 'custom';
        $('presetNote').textContent = 'Custom synthetic benchmark parameters. Presets are labeled as synthetic benchmarks.';
      }
      recompute();
    };
    const ids = ['sampleRate', 'fftSize', 'tone1Hz', 'tone2Hz', 'noiseLevel', 'seedInput',
      'filterFamily', 'cutoff', 'rippleDb', 'qFactor', 'windowSelect', 'firTaps',
      'windowForSpectrum', 'plotMode'];
    for (const id of ids) {
      $(id).addEventListener('input', onChange);
      $(id).addEventListener('change', onChange);
    }
    $('presetSelect').addEventListener('change', ev => {
      const name = ev.target.value;
      if (name === 'custom') {
        state.preset = 'custom';
        $('presetNote').textContent = 'Custom synthetic benchmark parameters.';
        recompute();
      } else applyPreset(name);
    });
    $('resetBtn').addEventListener('click', () => { $('presetSelect').value = 'voiceBand'; applyPreset('voiceBand'); });
    $('randomBtn').addEventListener('click', () => {
      $('seedInput').value = String(Math.floor(Math.random() * 4294967295));
      onChange({ target: { id: 'seedInput' } });
    });
    for (const btn of document.querySelectorAll('[data-bode]')) {
      btn.addEventListener('click', () => {
        state.bodeView = btn.getAttribute('data-bode');
        for (const other of document.querySelectorAll('[data-bode]')) {
          other.setAttribute('aria-pressed', String(other === btn));
        }
        redraw();
      });
    }
    $('themeToggle').addEventListener('click', () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
      $('themeToggle').setAttribute('aria-pressed', String(dark));
      $('themeToggle').textContent = dark ? 'Dark theme' : 'Light theme';
      try { localStorage.setItem('fftb-theme', dark ? 'light' : 'dark'); } catch (e) { /* storage may be unavailable */ }
      redraw();
    });
    try {
      if (localStorage.getItem('fftb-theme') === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        $('themeToggle').setAttribute('aria-pressed', 'true');
        $('themeToggle').textContent = 'Dark theme';
      }
    } catch (e) { /* storage may be unavailable */ }
    $('helpToggle').addEventListener('click', () => {
      const panel = $('helpPanel');
      panel.hidden = !panel.hidden;
      $('helpToggle').setAttribute('aria-expanded', String(!panel.hidden));
    });
    globalThis.addEventListener('resize', () => { if (state.data) redraw(); });
    document.addEventListener('visibilitychange', () => { /* synchronous redraws need no scheduling */ });
    // Expose a small hook for external smoke checks without touching internals.
    globalThis.__FFTB__ = {
      get state() { return state; },
      recompute, redraw,
      get data() { return state.data; },
      get engine() { return D; }
    };
  }

  function start() {
    if (!D) {
      $('engineBadge').textContent = 'engine unavailable';
      showError('DSP engine failed to load. Verify src/dsp.cjs exists.');
      return;
    }
    $('engineBadge').textContent = 'local DSP engine ready';
    bindControls(); bindExports(); bindProbes();
    // Add a pin hint node that keyboard probing updates.
    const hint = document.createElement('span');
    hint.id = 'pinHint'; hint.className = 'hint';
    hint.textContent = 'Probe free';
    $('signalReadout').appendChild(hint);
    applyPreset('voiceBand');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
