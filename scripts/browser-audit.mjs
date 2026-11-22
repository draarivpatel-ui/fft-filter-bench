// Headless Chromium audit for the FFT-Filter-Bench single-page app.
// Exercises the new analysis UI with real pointer/keyboard input at two
// viewports and asserts: no console errors, no uncaught page errors, no
// external network requests, and no horizontal overflow.
// Run: node scripts/browser-audit.mjs

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import path from 'node:path';

// The repo itself stays zero-dependency; Playwright is resolved from a local
// install first, then the global npm root, then a globally installed
// omniroute package (which vendors playwright + a matching Chromium).
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const candidates = [];
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try { candidates.push(execFileSync(npmCmd, ['root', '-g'], { encoding: 'utf8' }).trim() + '/package.json'); } catch { /* npm absent */ }
  candidates.push(path.join(homedir(), '.npm-global/lib/node_modules/omniroute/package.json'));
  let loaded = false;
  for (const anchor of candidates) {
    try {
      const req = createRequire(anchor);
      ({ chromium } = req('playwright'));
      loaded = true;
      break;
    } catch { /* try next anchor */ }
  }
  if (!loaded) throw new Error('Playwright not found: install it (npm i -D playwright) or run on a machine with a global playwright.');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageUrl = pathToFileURL(path.join(root, 'index.html')).href;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`);
};
const assert = (name, cond, detail = '') => {
  if (!cond) throw new Error(`${name}${detail ? ': ' + detail : ''}`);
};

const EXPORT_BUTTONS = [
  ['jsonBtn', 'fft-filter-bench-experiment.json'],
  ['coeffCsvBtn', 'biquad_coefficients.csv'],
  ['bodeCsvBtn', 'bode_response.csv'],
  ['spectrumCsvBtn', 'spectrum.csv'],
  ['cHeaderBtn', 'biquad_coeffs.h'],
  ['embeddedHeaderBtn', 'filter_coeffs.h'],
  ['pythonBtn', 'filter_design.py'],
  ['reportJsonBtn', 'design_report.json'],
  ['reportCsvBtn', 'design_report.csv'],
  ['wavInputBtn', 'fft-filter-bench-input.wav'],
  ['wavOutputBtn', 'fft-filter-bench-filtered.wav'],
];

const canvasPainted = id => {
  const c = document.getElementById(id);
  const g = c.getContext('2d');
  const data = g.getImageData(0, 0, c.width, c.height).data;
  const base = data[0] + ',' + data[1] + ',' + data[2] + ',' + data[3];
  let diff = 0;
  for (let i = 0; i < data.length; i += 4 * 17) {
    const px = data[i] + ',' + data[i + 1] + ',' + data[i + 2] + ',' + data[i + 3];
    if (px !== base) diff++;
  }
  return diff;
};

async function auditViewport(browser, width, height) {
  const tag = `${width}x${height}`;
  const context = await browser.newContext({
    viewport: { width, height },
    acceptDownloads: true,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const requests = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(String(e)));
  page.on('request', r => requests.push(r.url()));
  page.on('requestfailed', r => consoleErrors.push('requestfailed ' + r.url()));

  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__FFTB__ && window.__FFTB__.data && window.__FFTB__.data.firBode);

  // Favicon is an inline data URI and the page must not 404 anything.
  const favicon = await page.getAttribute('link[rel="icon"]', 'href');
  check(`${tag} favicon is a data URI`, favicon && favicon.startsWith('data:'), favicon ? favicon.slice(0, 30) : 'missing');

  // Spec badge + readout.
  const badge = await page.textContent('#specBadge');
  check(`${tag} spec badge verdict`, /SPEC (PASS|FAIL)/.test(badge), badge.trim());
  const readout = await page.textContent('#specReadout');
  check(`${tag} spec readout reports ripple/attenuation`, /ripple .+ atten/.test(readout));

  // Bode segmented views (magnitude, phase, unwrapped phase, group delay).
  for (const view of ['mag', 'phase', 'phaseUnwrapped', 'grpDelay']) {
    await page.click(`[data-bode="${view}"]`);
    await page.waitForTimeout(30);
    const pressed = await page.getAttribute(`[data-bode="${view}"]`, 'aria-pressed');
    const painted = await page.evaluate(canvasPainted, 'bodeCanvas');
    assert(`bode view ${view}`, pressed === 'true' && painted > 50, `pressed=${pressed} painted=${painted}`);
  }
  check(`${tag} IIR bode: all 4 views paint`, true);

  for (const view of ['mag', 'phaseUnwrapped', 'grpDelay']) {
    await page.click(`[data-firview="${view}"]`);
    await page.waitForTimeout(30);
    const pressed = await page.getAttribute(`[data-firview="${view}"]`, 'aria-pressed');
    const painted = await page.evaluate(canvasPainted, 'firBodeCanvas');
    assert(`fir view ${view}`, pressed === 'true' && painted > 50, `pressed=${pressed} painted=${painted}`);
  }
  check(`${tag} FIR response: all 3 views paint`, true);

  // Group-delay curves must be finite numbers on screen (probe readout).
  await page.click('[data-firview="grpDelay"]');
  const gdSample = await page.evaluate(() => {
    const g = window.__FFTB__.data.firBode.grpDelay;
    return { len: g.length, finite: Array.from(g).every(Number.isFinite) };
  });
  check(`${tag} FIR group delay is finite`, gdSample.len > 100 && gdSample.finite, `n=${gdSample.len}`);

  // Pole-zero markers: real pointer click + keyboard activation.
  const iirMark = page.locator('#poleZeroSvg .pz-mark').first();
  await iirMark.scrollIntoViewIfNeeded();
  await iirMark.click();
  let note = await page.textContent('#poleZeroNote');
  check(`${tag} IIR pz marker pointer click`, /(zero|pole) .+multiplicity .+radius/.test(note), note.slice(0, 60));

  const firMark = page.locator('#firZeroSvg .pz-mark').nth(1);
  await firMark.scrollIntoViewIfNeeded();
  await firMark.click();
  note = await page.textContent('#firZeroNote');
  check(`${tag} FIR zero marker pointer click`, /zero .+multiplicity/.test(note), note.slice(0, 60));

  await page.locator('#firZeroSvg .pz-mark').nth(2).focus();
  await page.keyboard.press('Enter');
  note = await page.textContent('#firZeroNote');
  check(`${tag} FIR zero marker keyboard activation`, /zero .+multiplicity/.test(note), note.slice(0, 60));

  const firZeroCount = await page.locator('#firZeroSvg .pz-mark').count();
  const expectedZeros = await page.evaluate(() => window.__FFTB__.data.firPz.zeros.length);
  check(`${tag} FIR z-plane marker count`, firZeroCount >= expectedZeros, `${firZeroCount} markers, ${expectedZeros} zeros`);

  // Spec canvas paints mask + response.
  const specPaint = await page.evaluate(canvasPainted, 'specCanvas');
  check(`${tag} spec mask canvas painted`, specPaint > 80, `diff px=${specPaint}`);

  // Change spec edges to an impossible spec via real typing -> badge flips.
  await page.fill('#specAttenDb', '160');
  await page.waitForTimeout(40);
  const badge2 = await page.textContent('#specBadge');
  check(`${tag} spec badge flips to FAIL on impossible spec`, /FAIL/.test(badge2), badge2.trim());
  await page.fill('#specAttenDb', '40');
  await page.waitForTimeout(40);

  // Exports: every button must run the exporter with the right filename
  // (exportNote), and real download events must fire. Chrome may coalesce
  // back-to-back programmatic downloads, so collect them asynchronously.
  const downloads = [];
  page.on('download', d => downloads.push(d.suggestedFilename()));
  for (const [id, name] of EXPORT_BUTTONS) {
    await page.click('#' + id);
    await page.waitForTimeout(250);
    const noteText = await page.textContent('#exportNote');
    assert(`export ${id}`, noteText.includes('Generated ' + name), `note="${noteText}"`);
  }
  for (let i = 0; i < 50 && downloads.length < EXPORT_BUTTONS.length; i++) await page.waitForTimeout(100);
  check(`${tag} all ${EXPORT_BUTTONS.length} exports produce downloads`,
    EXPORT_BUTTONS.every(([, n]) => downloads.includes(n)),
    `${downloads.length}/${EXPORT_BUTTONS.length} events; missing: ${EXPORT_BUTTONS.map(([, n]) => n).filter(n => !downloads.includes(n)).join(',')}`);

  // Report JSON must carry a 64-hex fingerprint.
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#reportJsonBtn')]);
  const report = JSON.parse((await import('node:fs')).readFileSync(await dl2.path(), 'utf8'));
  check(`${tag} design report fingerprinted`, /^[0-9a-f]{64}$/.test(report.fingerprint || ''));

  // Bookmark -> hash restore in a fresh page.
  await page.fill('#firTaps', '65');
  await page.waitForTimeout(60);
  await page.click('#bookmarkBtn');
  await page.waitForFunction(() => location.hash.length > 8);
  const hash = await page.evaluate(() => location.hash);
  check(`${tag} bookmark writes v2 hash`, hash.startsWith('#v=2'), hash.slice(0, 24));

  const page2 = await context.newPage();
  const ext2 = [];
  page2.on('request', r => ext2.push(r.url()));
  await page2.goto(pageUrl + hash, { waitUntil: 'load' });
  await page2.waitForFunction(() => window.__FFTB__ && window.__FFTB__.state);
  const restored = await page2.inputValue('#firTaps');
  check(`${tag} hash restores design state`, restored === '65', `firTaps=${restored}`);
  await page2.close();
  await page.fill('#firTaps', '33');
  await page.waitForTimeout(60);

  // Self-test battery.
  await page.click('#selfTestBtn');
  await page.waitForSelector('#selfTestList li');
  const st = await page.evaluate(() => {
    const items = [...document.querySelectorAll('#selfTestList li')];
    return {
      total: items.length,
      failed: items.filter(li => li.classList.contains('fail')).length,
      summary: items.at(-1).textContent,
    };
  });
  check(`${tag} self-test battery all pass`, st.failed === 0 && /100% PASS/.test(st.summary), st.summary);

  // WebAudio audition: dry -> filtered -> stop -> mute -> gain clamp.
  await page.click('#audDryBtn');
  await page.waitForTimeout(120);
  note = await page.textContent('#audNote');
  check(`${tag} audition dry plays`, /Playing dry/.test(note), note.slice(0, 50));
  await page.click('#audFirBtn');
  await page.waitForTimeout(120);
  note = await page.textContent('#audNote');
  check(`${tag} audition FIR plays`, /Playing fir/.test(note), note.slice(0, 50));
  await page.click('#audMuteBtn');
  await page.waitForTimeout(60);
  note = await page.textContent('#audNote');
  check(`${tag} audition mute toggles`, /muted/.test(note), note.slice(0, 60));
  // Slam the level slider to max; engine must clamp at 0.8.
  await page.locator('#audGain').evaluate(el => { el.value = '1'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForTimeout(60);
  note = await page.textContent('#audNote');
  const level = parseFloat((note.match(/level ([0-9.]+)/) || [])[1] || '9');
  check(`${tag} audition level clamped to 0.8`, level <= 0.80001, `level=${level}`);
  await page.click('#audStopBtn');
  await page.waitForTimeout(60);
  note = await page.textContent('#audNote');
  check(`${tag} audition stops`, /Stopped/.test(note), note.slice(0, 40));

  // Horizontal overflow.
  const overflow = await page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  check(`${tag} zero horizontal overflow`, overflow <= 0, `${overflow}px`);

  // Global hygiene: no console errors, no page errors, no external requests.
  const external = requests.filter(u =>
    !u.startsWith('file:') && !u.startsWith('data:') && !u.startsWith('blob:') &&
    !u.startsWith('about:') && !u.startsWith('chrome:'));
  check(`${tag} zero external network requests`, external.length === 0, external.slice(0, 3).join(', ') || 'clean');
  check(`${tag} zero console errors`, consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || 'clean');
  check(`${tag} zero uncaught page errors`, pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ') || 'clean');

  await context.close();
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
});

let failed = 0;
for (const [w, h] of [[1440, 900], [390, 844]]) {
  try {
    await auditViewport(browser, w, h);
  } catch (e) {
    check(`${w}x${h} fatal`, false, String(e).slice(0, 200));
  }
}
await browser.close();

failed = results.filter(r => !r.ok).length;
console.log(`\nBrowser audit: ${results.length} checks, ${results.length - failed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
