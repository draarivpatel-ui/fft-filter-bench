/* FFT Filter Bench controller. Uses the shared DSP engine (window.DSP). */
'use strict';
(function () {
  const D = globalThis.DSP;
  const $ = id => document.getElementById(id);
  const canvasIds = ['signalCanvas', 'spectrumCanvas', 'bodeCanvas', 'firCanvas', 'firBodeCanvas', 'specCanvas'];

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
    bodeView: 'mag', firView: 'mag',
    specEdge1Hz: 2000, specEdge2Hz: 9000, specRippleDb: 1.5, specAttenDb: 40, specSymmetryErr: 0.001,
    probe: { signal: null, spectrum: 0, bode: 0, fir: 0, firBode: 0 },
    pinned: false,
    data: null,
    lastExport: '',
    hashRestored: false
  };

  let dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
  // Fixed aspect ratios from the HTML attributes. canvas.width/height are
  // mutable DPI-scaled values, so they cannot be used to derive the ratio.
  const RATIOS = {
    signalCanvas: 220 / 880, spectrumCanvas: 220 / 880, bodeCanvas: 240 / 880,
    firCanvas: 180 / 880, firBodeCanvas: 240 / 880, specCanvas: 220 / 880
  };

  function fmt(v, digits = 4) { return Number(v).toFixed(digits); }
  function finite(v, fallback = 0) { return Number.isFinite(v) ? v : fallback; }

  function showError(message) {
    const node = $('errorStatus');
    node.textContent = message;
    node.hidden = !message;
    for (const id of ['jsonBtn', 'coeffCsvBtn', 'bodeCsvBtn', 'spectrumCsvBtn', 'cHeaderBtn',
      'embeddedHeaderBtn', 'pythonBtn', 'reportJsonBtn', 'reportCsvBtn', 'wavInputBtn', 'wavOutputBtn']) {
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
    state.specEdge1Hz = Number($('specEdge1Hz').value) || 0;
    state.specEdge2Hz = Number($('specEdge2Hz').value) || 0;
    state.specRippleDb = Math.abs(Number($('specRippleDb').value)) || 0.01;
    state.specAttenDb = Math.abs(Number($('specAttenDb').value)) || 1;
    state.specSymmetryErr = Math.abs(Number($('specSymmetryErr').value)) || 0;
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

  /**
   * Map the filter family plus the two user edges (normalized, e1 <= e2)
   * onto the specMaskCheck shape. For a bandpass, the edges bracket the
   * passband and the stopbands sit a transition-width away on each side.
   * Returns null when the edges cannot form a valid mask.
   */
  function buildSpecMask(family, e1, e2, transNorm, s) {
    // Both edges must sit strictly inside (0, Nyquist); anything else is an
    // invalid spec rather than a silently degenerate mask.
    if (!(e1 > 0 && e1 < 1 && e2 > 0 && e2 < 1 && e1 < e2)) return null;
    const spec = {
      rippleDb: s.specRippleDb,
      attenDb: s.specAttenDb,
      transitionWidth: Math.max(transNorm, 1e-6)
    };
    if (family === 'highpass') {
      spec.passband = [Math.min(e2, 0.9999), 1];
      spec.stopbands = [[0, e1]];
    } else if (family === 'bandpass') {
      const loStop = Math.max(0, e1 - spec.transitionWidth);
      const hiStop = Math.min(1, e2 + spec.transitionWidth);
      spec.passband = [e1, e2];
      spec.stopbands = [];
      if (loStop > 1e-6) spec.stopbands.push([0, loStop]);
      if (hiStop < 1 - 1e-6) spec.stopbands.push([hiStop, 1]);
    } else {
      spec.passband = [0, e1];
      spec.stopbands = [[e2, 1]];
    }
    if (!(spec.passband[0] < spec.passband[1])) return null;
    return spec;
  }

  function compute() {
    const config = {
      family: state.family, fc: state.fc, rippleDb: state.rippleDb, Q: state.Q,
      sampleRate: state.sampleRate, fftSize: state.fftSize,
      tone1Hz: state.tone1Hz, tone2Hz: state.tone2Hz, noise: state.noise, seed: state.seed,
      firTaps: state.firTaps, firWindow: state.window, spectrumWindow: state.spectrumWindow
    };
    // Only bandpass exposes a Q control; other families must not inherit the
    // hidden slider's value (a highpass built with bandpass Q is a resonator).
    const coeffs = D.designFilter({
      family: config.family, fc: config.fc, rippleDb: config.rippleDb,
      Q: config.family === 'bandpass' ? config.Q : undefined
    });
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

    const firBode = D.firBode(firDesign.coefficients, 512);
    const firPz = D.firPoleZero(firDesign.coefficients);
    const firStab = D.firStability(firDesign.coefficients);
    const symmetryError = D.firSymmetryError(firDesign.coefficients);

    // Spec-mask verification on the normalized axis (1 = Nyquist).
    const nyq = config.sampleRate / 2;
    const e1 = Math.min(state.specEdge1Hz, state.specEdge2Hz) / nyq;
    const e2 = Math.max(state.specEdge1Hz, state.specEdge2Hz) / nyq;
    const transNorm = Math.abs(e2 - e1);
    const spec = buildSpecMask(config.family, e1, e2, transNorm, state);
    // The reference FIR is always a lowpass design, so the mask only applies
    // to it for the lowpass families. For highpass and bandpass the verdict
    // comes from the IIR alone and the FIR check reports n/a.
    const firSpecApplies = config.family === 'butterworth' || config.family === 'chebyshev';
    const specCheckFir = spec && firSpecApplies ? D.specMaskCheck(
      { freq: firBode.freq, mag: firBode.mag },
      { ...spec, symmetryErrorMax: state.specSymmetryErr },
      { symmetryError }
    ) : null;
    const specCheckIir = spec ? D.specMaskCheck(
      { freq: bode.freq, mag: bode.mag }, spec, {}
    ) : null;

    // Windowed FFT spectra of input and IIR output. Amplitudes are normalized
    // by the window's coherent gain so a bin-centered unit tone reads ~0 dB
    // for every window, with DC/Nyquist on the single-sided scale.
    const win = D.windowFunction(config.spectrumWindow, input.length);
    const xw = Float64Array.from(input, (v, i) => v * win[i]);
    const specIn = D.fftReal(xw);
    const specOut = D.fftReal(Float64Array.from(iir, (v, i) => v * win[i]));
    const magIn = D.magnitude(specIn.real, specIn.imag);
    const magOut = D.magnitude(specOut.real, specOut.imag);
    const coherentGain = Array.from(win).reduce((a, v) => a + v, 0) / input.length;
    const N = input.length, halfN = Math.floor(N / 2);
    const scale = k => (k === 0 || k === halfN ? N * coherentGain : N * coherentGain / 2);
    const spectrum = {
      bins: Float64Array.from({ length: halfN + 1 }, (_, k) => k / N),
      magInDb: Float64Array.from({ length: halfN + 1 }, (_, k) => D.linearToDb(magIn[k] / scale(k))),
      magOutDb: Float64Array.from({ length: halfN + 1 }, (_, k) => D.linearToDb(magOut[k] / scale(k)))
    };
    const { timeEnergy, freqEnergy } = D.parsevalEnergy(xw, null, specIn.real, specIn.imag);
    const parsevalError = Math.abs(timeEnergy - freqEnergy) / Math.max(timeEnergy, 1e-12);

    const diagnostics = D.filterDiagnostics(input, iir, coeffs, config.tone1Hz, config.sampleRate);
    const responseAtCutoff = D.biquadFrequencyResponse(coeffs, D.TAU * config.fc);
    const dcDelay = D.biquadFrequencyResponse(coeffs, 0).groupDelay;

    for (const arr of [input, iir, firOut, bode.mag, bode.phase, bode.grpDelay]) {
      for (let i = 0; i < arr.length; i++) if (!Number.isFinite(arr[i])) throw new Error('Nonfinite computed sample');
    }

    return {
      config, coeffs, input, iir, firOut, firDesign, bode, pz, stability,
      firBode, firPz, firStab, symmetryError, spec, specCheckFir, specCheckIir,
      spectrum, parsevalError, diagnostics, responseAtCutoff, dcDelay,
      allFinite: true
    };
  }

  function recompute() {
    try {
      readControls();
      state.data = compute();
      // A new design invalidates any picked z-plane coordinate, and a
      // sounding audition must not keep playing the stale filter.
      $('poleZeroNote').removeAttribute('data-picked');
      $('firZeroNote').removeAttribute('data-picked');
      if (audio.playing) auditionPlay(audio.playing);
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
    $('bodeReadout').textContent = `freq ${fmt(b.freq[idx], 4)} x PI | ${fmt(b.mag[idx], 3)} dB | ${fmt(b.phase[idx], 3)} rad | group delay ${fmt(b.grpDelay[idx], 3)} samples`;
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

  /** Group roots that sit within `tol` of each other for multiplicity labels. */
  function clusterRoots(points, tol) {
    const used = new Array(points.length).fill(false);
    const clusters = [];
    for (let i = 0; i < points.length; i++) {
      if (used[i]) continue;
      const members = [i];
      let x = points[i].x ?? points[i].real, y = points[i].y ?? points[i].imag;
      used[i] = true;
      for (let j = i + 1; j < points.length; j++) {
        if (used[j]) continue;
        const xj = points[j].x ?? points[j].real, yj = points[j].y ?? points[j].imag;
        if (Math.hypot(x - xj, y - yj) <= tol) { used[j] = true; members.push(j); }
      }
      // Centroid of the cluster for the marker position.
      let mx = 0, my = 0;
      for (const k of members) { mx += points[k].x ?? points[k].real; my += points[k].y ?? points[k].imag; }
      clusters.push({ x: mx / members.length, y: my / members.length, multiplicity: members.length });
    }
    return clusters;
  }

  function fmtComplex(x, y) {
    return `${fmt(x, 4)}${y >= 0 ? '+' : ''}${fmt(y, 4)}i`;
  }

  /**
   * Draw a z-plane plot into an SVG node. `zeros`/`poles` are {x,y} or
   * {real,imag}; markers carry <title> tooltips and update `noteEl` with
   * exact coordinates and multiplicity on click/tap.
   */
  function drawZPlane(svg, zeros, poles, noteEl, caption) {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const ns = 'http://www.w3.org/2000/svg';
    const add = (parent, tag, attrs) => {
      const node = document.createElementNS(ns, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
      parent.appendChild(node);
      return node;
    };
    const title = add(svg, 'title', {}); title.textContent = caption;
    const desc = add(svg, 'desc', {}); desc.textContent = 'Zeros as circles, poles as crosses, dashed unit circle. Activate a marker for coordinates.';
    const cx = 200, cy = 200;
    // Auto-fit keeps every pole/zero inside the viewBox, capped at radius 4:
    // beyond that, reciprocal zeros would shrink the unit circle to a speck.
    // Far zeros render as edge markers pointing outward instead.
    let maxR = 1.2;
    for (const z of zeros) maxR = Math.max(maxR, Math.hypot(z.x, z.y));
    for (const p of poles) maxR = Math.max(maxR, Math.hypot(p.x, p.y));
    maxR = Math.ceil(Math.min(maxR, 4) * 2) / 2 + 0.15;
    const scale = 195 / maxR;
    const edgePx = 195 - 16;
    const grid = cssVar('--grid', '#26344f'), axis = cssVar('--muted', '#8296b4');
    for (let r = 0.5; r <= maxR; r += 0.5) add(svg, 'circle', { cx, cy, r: r * scale, fill: 'none', stroke: grid, 'stroke-width': 0.6 });
    add(svg, 'line', { x1: 0, y1: cy, x2: 400, y2: cy, stroke: axis, 'stroke-width': 1 });
    add(svg, 'line', { x1: cx, y1: 0, x2: cx, y2: 400, stroke: axis, 'stroke-width': 1 });
    add(svg, 'circle', { cx, cy, r: scale, fill: 'none', stroke: cssVar('--fir', '#4ade80'), 'stroke-width': 2, 'stroke-dasharray': '4,4' });

    const pick = info => {
      noteEl.textContent = info;
      noteEl.dataset.picked = '1';
    };
    const tol = 0.02;
    for (const c of clusterRoots(zeros, tol)) {
      const cRad = Math.hypot(c.x, c.y);
      const far = cRad > maxR;
      const px = far ? cx + (c.x / cRad) * edgePx : cx + c.x * scale;
      const py = far ? cy - (c.y / cRad) * edgePx : cy - c.y * scale;
      const g = add(svg, 'g', { class: 'pz-mark' + (far ? ' pz-far' : ''), tabindex: '0', role: 'button', 'aria-label': 'zero marker' });
      const t = add(g, 'title', {});
      const label = `zero ${fmtComplex(c.x, c.y)} | multiplicity ${c.multiplicity} | radius ${fmt(cRad, 5)}${far ? ' (off chart)' : ''}`;
      t.textContent = label;
      add(g, 'circle', { cx: px, cy: py, r: 14, fill: 'none', stroke: 'none', 'pointer-events': 'all' });
      if (far) {
        // A triangle at the chart edge pointing outward to the true radius.
        const ux = c.x / cRad, uy = c.y / cRad;
        add(g, 'polygon', {
          points: `${px + ux * 9},${py - uy * 9} ${px - uy * 5 - ux * 4},${py + ux * 5 + uy * 4} ${px + uy * 5 - ux * 4},${py - ux * 5 + uy * 4}`,
          fill: 'none', stroke: cssVar('--signal-a', '#62a6ff'), 'stroke-width': 2
        });
      }
      add(g, 'circle', { cx: px, cy: py, r: 7, fill: 'none', stroke: cssVar('--signal-a', '#62a6ff'), 'stroke-width': 2 });
      if (c.multiplicity > 1) {
        add(g, 'circle', { cx: px, cy: py, r: 11, fill: 'none', stroke: cssVar('--signal-a', '#62a6ff'), 'stroke-width': 1 });
        const mt = add(g, 'text', { x: px + 12, y: py - 9, class: 'pz-mult' });
        mt.textContent = 'x' + c.multiplicity;
      }
      const hit = () => pick(label);
      g.addEventListener('click', hit);
      g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); hit(); } });
    }
    for (const c of clusterRoots(poles, tol)) {
      const px = cx + c.x * scale, py = cy - c.y * scale, s = 7;
      const g = add(svg, 'g', { class: 'pz-mark', tabindex: '0', role: 'button', 'aria-label': 'pole marker' });
      const t = add(g, 'title', {});
      const label = `pole ${fmtComplex(c.x, c.y)} | multiplicity ${c.multiplicity} | radius ${fmt(Math.hypot(c.x, c.y), 5)}`;
      t.textContent = label;
      add(g, 'circle', { cx: px, cy: py, r: 14, fill: 'none', stroke: 'none', 'pointer-events': 'all' });
      const col = cssVar('--signal-b', '#ff87b2');
      add(g, 'line', { x1: px - s, y1: py - s, x2: px + s, y2: py + s, stroke: col, 'stroke-width': 2 });
      add(g, 'line', { x1: px + s, y1: py - s, x2: px - s, y2: py + s, stroke: col, 'stroke-width': 2 });
      if (c.multiplicity > 1) {
        const mt = add(g, 'text', { x: px + 11, y: py - 10, class: 'pz-mult' });
        mt.textContent = 'x' + c.multiplicity;
      }
      const hit = () => pick(label);
      g.addEventListener('click', hit);
      g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); hit(); } });
    }
  }

  function drawPoleZero() {
    const d = state.data;
    drawZPlane($('poleZeroSvg'), d.pz.zeros, d.pz.poles, $('poleZeroNote'), 'Pole-zero plane');
    if ($('poleZeroNote').dataset.picked !== '1') {
      $('poleZeroNote').textContent = `${d.stability.stable ? 'Stable' : 'Unstable'}: max pole radius ${fmt(d.stability.maxPoleRadius, 5)}, ${d.stability.minPhase ? 'minimum-phase zeros' : 'zeros outside unit circle'}.`;
    }
  }

  function drawFirPoleZero() {
    const d = state.data, pz = d.firPz;
    const zeros = pz.zeros.map(z => ({ x: z.real, y: z.imag }));
    // The pole at the origin has multiplicity M; feed M copies so the
    // clustering pass renders the xM multiplicity label correctly.
    const poles = Array.from({ length: Math.max(1, pz.poleMultiplicity) }, () => ({ x: 0, y: 0 }));
    drawZPlane($('firZeroSvg'), zeros, poles, $('firZeroNote'), 'FIR z-plane zeros');
    if ($('firZeroNote').dataset.picked !== '1') {
      const status = pz.converged ? 'converged' : `unverified (${pz.uncertified} roots)`;
      $('firZeroNote').textContent =
        `${zeros.length} finite zeros${pz.droppedRoots ? ` + ${pz.droppedRoots} at infinity` : ''}, pole z=0 x${pz.poleMultiplicity}. ` +
        `Solver ${status}, max backward error ${pz.maxResidual.toExponential(2)}.`;
    }
  }

  function drawFirBode() {
    const { ctx, w, h } = prepareCanvas('firBodeCanvas');
    const d = state.data, b = d.firBode, m = { l: 54, r: 12, t: 12, b: 24 };
    frame(ctx, w, h, m, 4);
    const key = state.firView;
    const values = Array.from(b[key], v => key === 'grpDelay' ? D.clamp(v, -100, 100) : key === 'mag' ? Math.max(v, -120) : v);
    let min = Math.min(...values), max = Math.max(...values);
    if (!Number.isFinite(min) || !Number.isFinite(max)) { min = -1; max = 1; }
    if (max - min < 1e-9) { min -= 1; max += 1; }
    const pad = (max - min) * 0.08; min -= pad; max += pad;
    polyline(ctx, values, m, w, h, min, max, cssVar('--signal-b', '#ff87b2'), 2);
    const fcX = m.l + (w - m.l - m.r) * (D.TAU * d.config.fc / Math.PI);
    if (fcX <= w - m.r) {
      ctx.strokeStyle = cssVar('--signal-a', '#62a6ff'); ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(fcX, m.t); ctx.lineTo(fcX, h - m.b); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle = cssVar('--muted', '#8296b4'); ctx.font = '10px ui-monospace, monospace';
    for (let i = 0; i <= 4; i++) ctx.fillText((max - (max - min) * i / 4).toFixed(1), 3, m.t + (h - m.t - m.b) * i / 4 + 3);
    ctx.fillText('DC', m.l, h - 6); ctx.fillText('Nyquist', w - 52, h - 6);
    const unit = { mag: 'dB', phase: 'rad', phaseUnwrapped: 'rad', grpDelay: 'samples' }[key];
    ctx.fillText(key === 'mag' ? 'Magnitude' : key === 'grpDelay' ? 'Group delay' : 'Phase (unwrapped)', m.l + 4, m.t + 10);
    const n = b.freq.length, idx = Math.min(n - 1, Math.max(0, Math.round(state.probe.firBode)));
    const x = m.l + (w - m.l - m.r) * idx / (n - 1);
    ctx.strokeStyle = cssVar('--accent', '#62a6ff'); ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, h - m.b); ctx.stroke(); ctx.setLineDash([]);
    const alt = key === 'mag' ? `phase ${fmt(b.phase[idx], 2)} rad` : `mag ${fmt(b.mag[idx], 2)} dB`;
    $('firBodeReadout').textContent = `freq ${fmt(b.freq[idx], 4)} x PI | ${key} ${fmt(b[key][idx], 4)} ${unit} | ${alt} | group delay ${fmt(b.grpDelay[idx], 3)} samples`;
  }

  function drawSpecMask() {
    const { ctx, w, h } = prepareCanvas('specCanvas');
    const d = state.data, spec = d.spec, m = { l: 54, r: 12, t: 12, b: 24 };
    frame(ctx, w, h, m, 4);
    const yMin = -Math.max(90, state.specAttenDb + 20), yMax = 6;
    const xOf = f => m.l + (w - m.l - m.r) * f;
    const yOf = db => m.t + (h - m.t - m.b) * (1 - (db - yMin) / (yMax - yMin));
    const passFill = 'rgba(74, 222, 128, 0.10)', stopFill = 'rgba(255, 135, 178, 0.10)';
    if (spec) {
      const pb = spec.passband;
      // The ripple check is peak-to-peak, so the box rides on the measured
      // passband peak rather than assuming 0 dB.
      const peaks = [d.specCheckFir, d.specCheckIir]
        .map(c => c && c.measured.passbandMaxDb).filter(Number.isFinite);
      const pbTop = peaks.length ? Math.min(0, Math.max(...peaks)) : 0;
      ctx.fillStyle = passFill;
      ctx.fillRect(xOf(pb[0]), yOf(pbTop), Math.max(1, xOf(pb[1]) - xOf(pb[0])), Math.max(1, yOf(pbTop - spec.rippleDb) - yOf(pbTop)));
      ctx.strokeStyle = cssVar('--fir', '#4ade80'); ctx.setLineDash([4, 4]);
      ctx.strokeRect(xOf(pb[0]), yOf(pbTop), Math.max(1, xOf(pb[1]) - xOf(pb[0])), Math.max(1, yOf(pbTop - spec.rippleDb) - yOf(pbTop)));
      ctx.fillStyle = stopFill;
      for (const sb of spec.stopbands) {
        ctx.fillRect(xOf(sb[0]), m.t, Math.max(1, xOf(sb[1]) - xOf(sb[0])), Math.max(1, yOf(-spec.attenDb) - m.t));
      }
      ctx.strokeStyle = cssVar('--signal-b', '#ff87b2');
      for (const sb of spec.stopbands) {
        ctx.strokeRect(xOf(sb[0]), m.t, Math.max(1, xOf(sb[1]) - xOf(sb[0])), Math.max(1, yOf(-spec.attenDb) - m.t));
      }
      ctx.setLineDash([]);
    }
    polyline(ctx, Array.from(d.firBode.mag, v => Math.max(v, yMin)), m, w, h, yMin, yMax, cssVar('--fir', '#4ade80'), 1.8);
    polyline(ctx, Array.from(d.bode.mag, v => Math.max(v, yMin)), m, w, h, yMin, yMax, cssVar('--signal-a', '#62a6ff'), 1.8);
    ctx.fillStyle = cssVar('--muted', '#8296b4'); ctx.font = '10px ui-monospace, monospace';
    for (let i = 0; i <= 4; i++) ctx.fillText((yMax - (yMax - yMin) * i / 4).toFixed(0), 3, m.t + (h - m.t - m.b) * i / 4 + 3);
    ctx.fillText('DC', m.l, h - 6); ctx.fillText('Nyquist', w - 52, h - 6);
    ctx.fillStyle = cssVar('--fir', '#4ade80'); ctx.fillText('FIR', w - m.r - 62, m.t + 10);
    ctx.fillStyle = cssVar('--signal-a', '#62a6ff'); ctx.fillText('IIR', w - m.r - 34, m.t + 10);
    updateSpecBadge();
  }

  function updateSpecBadge() {
    const d = state.data, badge = $('specBadge');
    if (!d || !d.spec || !d.specCheckIir) {
      badge.textContent = 'SPEC --';
      badge.className = 'badge';
      badge.removeAttribute('title');
      $('specReadout').textContent = 'Mask: enter both band edges inside (0, Nyquist) to activate the verifier.';
      return;
    }
    const fir = d.specCheckFir, iir = d.specCheckIir;
    // Every applicable check contributes to the verdict: on lowpass masks
    // both filters are checked, on highpass/bandpass masks the IIR alone.
    const pass = (fir ? fir.pass : true) && iir.pass;
    badge.textContent = pass ? 'SPEC PASS' : 'SPEC FAIL';
    badge.className = 'badge ' + (pass ? 'badge-ok' : 'badge-fail');
    const fmtCheck = c => `${c.name}: ${Number.isFinite(c.measured) ? fmt(c.measured, 3) : 'inf'} vs ${c.spec} ${c.pass ? 'PASS' : 'FAIL'}`;
    badge.setAttribute('title', (fir ? 'FIR: ' + fir.checks.map(fmtCheck).join(' | ') + '   ' : '') +
      'IIR: ' + iir.checks.map(fmtCheck).join(' | '));
    const lines = [];
    if (fir) {
      lines.push(`FIR ${fir.pass ? 'PASS' : 'FAIL'}: ripple ${fmt(fir.measured.passbandRippleDb, 2)} dB (spec ${d.spec.rippleDb}), ` +
        `atten ${fmt(fir.measured.stopbandMaxDb, 1)} dB (spec <= -${d.spec.attenDb}), ` +
        `transition ${fmt(fir.measured.worstTransitionWidth * state.sampleRate / 2, 0)} Hz (spec ${fmt(d.spec.transitionWidth * state.sampleRate / 2, 0)} Hz), ` +
        `symmetry error ${d.symmetryError.toExponential(2)}.`);
    } else {
      lines.push('FIR n/a: the lowpass reference is not checked against a ' +
        `${d.config.family === 'highpass' ? 'highpass' : 'bandpass'} mask.`);
    }
    lines.push(`IIR ${iir.pass ? 'PASS' : 'FAIL'}: ripple ${fmt(iir.measured.passbandRippleDb, 2)} dB, atten ${fmt(iir.measured.stopbandMaxDb, 1)} dB, ` +
      `transition ${fmt(iir.measured.worstTransitionWidth * state.sampleRate / 2, 0)} Hz.`);
    $('specReadout').textContent = lines.join(' ');
  }

  function redraw() {
    if (!state.data) return;
    drawSignal(); drawSpectrum(); drawBode(); drawFir(); drawPoleZero();
    drawFirBode(); drawFirPoleZero(); drawSpecMask();
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

  // Deep-copy a value, replacing non-finite numbers with null so
  // canonicalJson (which throws on Infinity/NaN) always accepts it.
  function finiteDeep(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (ArrayBuffer.isView(v)) return Array.from(v);
    if (Array.isArray(v)) return v.map(finiteDeep);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = finiteDeep(v[k]);
      return o;
    }
    return v;
  }

  function currentReport() {
    const d = state.data;
    return finiteDeep({
      config: { ...d.config, specEdge1Hz: state.specEdge1Hz, specEdge2Hz: state.specEdge2Hz,
        specRippleDb: state.specRippleDb, specAttenDb: state.specAttenDb, specSymmetryErr: state.specSymmetryErr },
      iir: { b0: d.coeffs.b0, b1: d.coeffs.b1, b2: d.coeffs.b2, a1: d.coeffs.a1, a2: d.coeffs.a2 },
      fir: { taps: d.firDesign.taps, window: d.firDesign.window, coefficients: Array.from(d.firDesign.coefficients) },
      stability: {
        stable: d.stability.stable, maxPoleRadius: d.stability.maxPoleRadius, minPhase: d.stability.minPhase,
        firStable: d.firStab.stable, firMaxZeroRadius: d.firStab.maxZeroRadius,
        firPoleMultiplicity: d.firStab.poleMultiplicity, firConverged: d.firStab.converged,
        firMaxResidual: d.firStab.maxResidual, firSymmetryError: d.symmetryError
      },
      specCheck: d.specCheckIir ? {
        spec: d.spec,
        fir: d.specCheckFir ? { pass: d.specCheckFir.pass, measured: d.specCheckFir.measured } : null,
        iir: { pass: d.specCheckIir.pass, measured: d.specCheckIir.measured }
      } : null,
      metrics: { parsevalError: d.parsevalError, inputRms: d.diagnostics.inputRms, outputRms: d.diagnostics.outputRms }
    });
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
    $('embeddedHeaderBtn').addEventListener('click', () => {
      if (!state.data) return;
      download('filter_coeffs.h', D.exportEmbeddedHeader({
        name: 'filter', iir: state.data.coeffs, fir: Array.from(state.data.firDesign.coefficients)
      }), 'text/plain');
    });
    $('pythonBtn').addEventListener('click', () => {
      if (!state.data) return;
      download('filter_design.py', D.exportPythonSnippet({
        name: 'filter', iir: state.data.coeffs,
        fir: Array.from(state.data.firDesign.coefficients), sampleRate: state.data.config.sampleRate
      }), 'text/plain');
    });
    $('reportJsonBtn').addEventListener('click', () => {
      if (!state.data) return;
      download('design_report.json', D.exportDesignReport(currentReport()), 'application/json');
    });
    $('reportCsvBtn').addEventListener('click', () => {
      if (!state.data) return;
      download('design_report.csv', D.exportDesignReportCSV(currentReport()), 'text/csv');
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
  // Plot-area margins used by each draw routine; the probe must map pointer x
  // to data only inside that rectangle, not across the whole canvas.
  const PLOT_MARGINS = {
    signalCanvas: { l: 48, r: 12 },
    spectrumCanvas: { l: 48, r: 12 },
    bodeCanvas: { l: 54, r: 12 },
    firCanvas: { l: 48, r: 12 },
    firBodeCanvas: { l: 54, r: 12 }
  };
  let announceTimer = null;
  function announceProbe(text) {
    const el = $('probeAnnounce');
    if (!el) return;
    if (typeof clearTimeout === 'function' && typeof setTimeout === 'function') {
      if (announceTimer) clearTimeout(announceTimer);
      announceTimer = setTimeout(() => { el.textContent = text; }, 350);
    } else {
      el.textContent = text;
    }
  }
  function probeFromPointer(id, ev, key) {
    const canvas = $(id);
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { left: 0, width: 880 };
    const x = Number(ev.clientX) - (rect.left || 0);
    const m = PLOT_MARGINS[id] || { l: 0, r: 0 };
    const width = rect.width || 880;
    const t = D.clamp((x - m.l) / Math.max(1, width - m.l - m.r), 0, 1);
    if (key === 'signal') state.probe.signal = t;
    else if (key === 'spectrum') state.probe.spectrum = Math.round(t * (state.data.spectrum.bins.length - 1));
    else if (key === 'bode') state.probe.bode = Math.round(t * (state.data.bode.freq.length - 1));
    else if (key === 'fir') state.probe.fir = Math.round(t * (state.data.firDesign.coefficients.length - 1));
    else if (key === 'firBode') state.probe.firBode = Math.round(t * (state.data.firBode.freq.length - 1));
    redraw();
    const readoutIds = { signal: 'signalReadout', spectrum: 'spectrumReadout', bode: 'bodeReadout', fir: 'firReadout', firBode: 'firBodeReadout' };
    if (key === 'signal') {
      const i = Math.min(state.data.input.length - 1, Math.round(t * (state.data.input.length - 1)));
      $('signalReadout').textContent = `sample ${i} | input ${fmt(state.data.input[i], 5)} | iir ${fmt(state.data.iir[i], 5)} | fir ${fmt(state.data.firOut[i], 5)}`;
    }
    announceProbe($(readoutIds[key]).textContent);
  }

  function bindProbes() {
    for (const [id, key] of [['signalCanvas', 'signal'], ['spectrumCanvas', 'spectrum'], ['bodeCanvas', 'bode'], ['firCanvas', 'fir'], ['firBodeCanvas', 'firBode']]) {
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
            key === 'bode' ? state.data.bode.freq.length - 1 :
            key === 'firBode' ? state.data.firBode.freq.length - 1 : state.data.firDesign.coefficients.length - 1;
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
          const readoutIds = { signal: 'signalReadout', spectrum: 'spectrumReadout', bode: 'bodeReadout', fir: 'firReadout', firBode: 'firBodeReadout' };
          announceProbe($(readoutIds[key]).textContent);
        }
      });
    }
  }

  /* ------------------------- WebAudio A/B audition ------------------------ */
  // Pure synthesized audition: the benchmark stimulus is rebuilt at the
  // playback sample rate and pushed through a looping AudioBufferSourceNode.
  // No audio files, no MediaElements, no network. Level is clamped to 0.8
  // and samples to [-1, 1]; the mute button forces the gain to zero.
  const audio = { ctx: null, src: null, gain: null, muted: false, playing: null };

  function auditionSamples(kind) {
    const d = state.data;
    if (!d) return null;
    const ctxFs = audio.ctx ? audio.ctx.sampleRate : 48000;
    const n = Math.floor(ctxFs * 1.6);
    // Tone frequencies are stored as Hz at the configured rate; scale them
    // into the device's rate so each tone keeps its normalized position
    // relative to the filters' normalized cutoff.
    const hzScale = ctxFs / d.config.sampleRate;
    const cap = f => Math.min(f * hzScale, ctxFs * 0.45);
    const sig = D.synthesizeSignal({
      n, fs: ctxFs, noise: d.config.noise, seed: d.config.seed,
      tones: [
        { freqHz: cap(d.config.tone1Hz), amp: 0.8 },
        { freqHz: cap(d.config.tone2Hz), amp: 0.5 },
        { freqHz: Math.min(ctxFs * 0.47, (d.config.tone2Hz + 8000) * hzScale), amp: 0.3 }
      ]
    });
    // Normalize every variant by the dry peak so the A/B comparison is fair:
    // the raw stimulus peaks above 1.0 on all presets.
    let peak = 0;
    for (const v of sig.samples) peak = Math.max(peak, Math.abs(v));
    audio.norm = 0.98 / Math.max(1, peak);
    const scale = arr => Float64Array.from(arr, v => v * audio.norm);
    if (kind === 'dry') return scale(sig.samples);
    if (kind === 'fir') return scale(D.firFilter(sig.samples, d.firDesign.coefficients));
    return scale(D.biquadFilter(sig.samples, d.coeffs));
  }

  function auditionLevel() {
    return D.clamp(Number($('audGain').value) || 0, 0, 0.8);
  }

  function auditionStop() {
    if (audio.src) { try { audio.src.stop(); } catch (e) { /* already stopped */ } audio.src = null; }
    audio.playing = null;
  }

  function auditionPlay(kind) {
    const d = state.data;
    if (!d) return;
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) { $('audNote').textContent = 'WebAudio is not available in this browser.'; return; }
    if (!audio.ctx) {
      audio.ctx = new AC();
      audio.gain = audio.ctx.createGain();
      audio.gain.connect(audio.ctx.destination);
    }
    if (audio.ctx.state === 'suspended' && audio.ctx.resume) audio.ctx.resume();
    auditionStop();
    const samples = auditionSamples(kind);
    if (!samples) return;
    const buf = audio.ctx.createBuffer(1, samples.length, audio.ctx.sampleRate);
    buf.copyToChannel(Float32Array.from(samples, v => D.clamp(v, -1, 1)), 0);
    const src = audio.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    src.connect(audio.gain);
    audio.gain.gain.value = audio.muted ? 0 : auditionLevel();
    src.start();
    audio.src = src; audio.playing = kind;
    const normNote = audio.norm < 0.999 ? ` | normalized x${fmt(audio.norm, 2)} (dry peak was ${fmt(0.98 / audio.norm, 2)})` : '';
    $('audNote').textContent = `Playing ${kind} | ${fmt(samples.length / audio.ctx.sampleRate, 2)} s loop at ${audio.ctx.sampleRate} Hz | level ${fmt(audio.gain.gain.value, 2)} (clamped to 0.8)${normNote}`;
  }

  /* --------------------------- URL hash bookmark -------------------------- */
  function currentHashConfig() {
    return {
      preset: state.preset, family: state.family, fc: state.fc, rippleDb: state.rippleDb, Q: state.Q,
      sampleRate: state.sampleRate, fftSize: state.fftSize, tone1Hz: state.tone1Hz, tone2Hz: state.tone2Hz,
      noise: state.noise, seed: state.seed, firTaps: state.firTaps, window: state.window,
      spectrumWindow: state.spectrumWindow, plotMode: state.plotMode, bodeView: state.bodeView,
      firView: state.firView,
      specEdge1Hz: state.specEdge1Hz, specEdge2Hz: state.specEdge2Hz, specRippleDb: state.specRippleDb,
      specAttenDb: state.specAttenDb, specSymmetryErr: state.specSymmetryErr
    };
  }

  function applyConfigToControls(cfg) {
    const set = (id, v) => { if (v !== undefined && v !== null && $(id)) $(id).value = String(v); };
    set('sampleRate', cfg.sampleRate); set('fftSize', cfg.fftSize);
    set('tone1Hz', cfg.tone1Hz); set('tone2Hz', cfg.tone2Hz);
    set('noiseLevel', cfg.noise); set('seedInput', cfg.seed);
    if (cfg.family) $('filterFamily').value = cfg.family;
    set('cutoff', cfg.fc); set('rippleDb', cfg.rippleDb); set('qFactor', cfg.Q);
    set('firTaps', cfg.firTaps);
    if (cfg.window) $('windowSelect').value = cfg.window;
    if (cfg.spectrumWindow) $('windowForSpectrum').value = cfg.spectrumWindow;
    if (cfg.plotMode) $('plotMode').value = cfg.plotMode;
    set('specEdge1Hz', cfg.specEdge1Hz); set('specEdge2Hz', cfg.specEdge2Hz);
    set('specRippleDb', cfg.specRippleDb); set('specAttenDb', cfg.specAttenDb);
    set('specSymmetryErr', cfg.specSymmetryErr);
    if (cfg.bodeView === 'mag' || cfg.bodeView === 'phase' || cfg.bodeView === 'phaseUnwrapped' || cfg.bodeView === 'grpDelay') {
      state.bodeView = cfg.bodeView;
    }
    if (cfg.firView === 'mag' || cfg.firView === 'phaseUnwrapped' || cfg.firView === 'grpDelay') {
      state.firView = cfg.firView;
    }
  }

  function syncSegStates() {
    for (const btn of document.querySelectorAll('[data-bode]')) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-bode') === state.bodeView));
    }
    for (const btn of document.querySelectorAll('[data-firview]')) {
      btn.setAttribute('aria-pressed', String(btn.getAttribute('data-firview') === state.firView));
    }
  }

  /* ------------------------------ Self-tests ------------------------------ */
  function runSelfTestPanel() {
    const list = $('selfTestList');
    list.textContent = '';
    const r = D.runSelfTests();
    for (const t of r.results) {
      const li = document.createElement('li');
      li.className = 'selftest-item ' + (t.pass ? 'pass' : 'fail');
      li.textContent = `${t.pass ? 'PASS' : 'FAIL'} ${t.name}${t.detail ? ' - ' + t.detail : ''}`;
      list.appendChild(li);
    }
    const li = document.createElement('li');
    li.className = 'selftest-item summary ' + (r.ok ? 'pass' : 'fail');
    li.textContent = `Self-test battery: ${r.pass}/${r.total} passing${r.ok ? ' - 100% PASS, 0 failures' : ''}`;
    list.appendChild(li);
    $('selfTestBtn').textContent = 'Re-run self-tests';
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
      'windowForSpectrum', 'plotMode',
      'specEdge1Hz', 'specEdge2Hz', 'specRippleDb', 'specAttenDb', 'specSymmetryErr'];
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
    for (const btn of document.querySelectorAll('[data-firview]')) {
      btn.addEventListener('click', () => {
        state.firView = btn.getAttribute('data-firview');
        for (const other of document.querySelectorAll('[data-firview]')) {
          other.setAttribute('aria-pressed', String(other === btn));
        }
        redraw();
      });
    }
    $('bookmarkBtn').addEventListener('click', () => {
      const hash = D.serializeConfigHash(currentHashConfig());
      const base = globalThis.location ? String(globalThis.location.href || '').split('#')[0] : '';
      const url = base + '#' + hash;
      try {
        if (globalThis.history && globalThis.history.replaceState) {
          globalThis.history.replaceState(null, '', '#' + hash);
        } else if (globalThis.location) {
          globalThis.location.hash = hash;
        }
      } catch (e) { /* history may be unavailable */ }
      const done = msg => { $('exportNote').textContent = msg; };
      if (globalThis.navigator && globalThis.navigator.clipboard && globalThis.navigator.clipboard.writeText) {
        Promise.resolve(globalThis.navigator.clipboard.writeText(url))
          .then(() => done('Bookmark URL copied to clipboard (' + hash.length + ' chars).'))
          .catch(() => done('Bookmark URL set in the address bar.'));
      } else {
        done('Bookmark URL set in the address bar.');
      }
      state.lastExport = 'bookmark:' + hash;
    });
    $('audDryBtn').addEventListener('click', () => auditionPlay('dry'));
    $('audWetBtn').addEventListener('click', () => auditionPlay('iir'));
    $('audFirBtn').addEventListener('click', () => auditionPlay('fir'));
    $('audStopBtn').addEventListener('click', () => {
      auditionStop();
      $('audNote').textContent = 'Stopped. Looping the current benchmark stimulus through the WebAudio engine. Level is safety-clamped.';
    });
    $('audMuteBtn').addEventListener('click', () => {
      audio.muted = !audio.muted;
      $('audMuteBtn').setAttribute('aria-pressed', String(audio.muted));
      $('audMuteBtn').textContent = audio.muted ? 'Unmute' : 'Mute';
      if (audio.gain) audio.gain.gain.value = audio.muted ? 0 : auditionLevel();
      if (audio.playing) {
        $('audNote').textContent = `Playing ${audio.playing} | level ${fmt(audio.gain.gain.value, 2)}${audio.muted ? ' (muted)' : ''}`;
      }
    });
    $('audGain').addEventListener('input', () => {
      if (audio.gain && !audio.muted) audio.gain.gain.value = auditionLevel();
      if (audio.playing) {
        $('audNote').textContent = `Playing ${audio.playing} | level ${fmt(audio.gain.gain.value, 2)} (clamped to 0.8)`;
      }
    });
    $('selfTestBtn').addEventListener('click', runSelfTestPanel);
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
    // A bookmark hash fully describes a benchmark; it wins over the default
    // preset so a shared URL reproduces the sender's exact state.
    const hashCfg = D.parseConfigHash
      ? D.parseConfigHash(globalThis.location ? globalThis.location.hash : '')
      : null;
    if (hashCfg) {
      state.hashRestored = true;
      applyConfigToControls(hashCfg);
      if (hashCfg.preset && PRESETS[hashCfg.preset]) {
        state.preset = hashCfg.preset;
        $('presetSelect').value = hashCfg.preset;
        $('presetNote').textContent = PRESETS[hashCfg.preset].note + ' Restored from URL hash.';
      } else {
        state.preset = 'custom';
        $('presetSelect').value = 'custom';
        $('presetNote').textContent = 'Custom synthetic benchmark restored from URL hash.';
      }
      readControls(); syncControlLabels(); syncSegStates(); recompute();
    } else {
      applyPreset('voiceBand');
      syncSegStates();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
