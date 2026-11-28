# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/fft-filter-bench/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## Supported versions

| Version | Status |
| --- | --- |
| latest `main` | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the static FFT Filter Bench browser application, including FFT and filter calculations, pole-zero rendering, URL bookmarks, audio audition, generated coefficients, report exports and browser rendering.

In scope:

- A cross-site scripting or HTML injection path through design parameters, plotted labels, filter output, URL state, imported text or report output.
- A bookmark decoder or serialization flaw that bypasses validation, corrupts another filter design, or executes attacker-controlled code.
- A CSV, JSON, WAV, Python or C-header export flaw that makes generated output execute a formula, script or unintended code when opened or compiled.
- An audio-generation boundary flaw that emits unsafe output levels or misrepresents local-only processing.
- A browser storage or offline-serving flaw that leaks sensitive user input or serves attacker-controlled application code across an update.

Out of scope:

- Browser vulnerabilities, operating system compromise or physical access to the machine.
- Damage caused by modified copies of the static application that do not come from this repository.
- Numerical accuracy limits documented for FFT, filter design and polynomial root solving, unless a report shows a specific validation or output integrity failure.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial triage: within 14 calendar days.
- Fix or mitigation target: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.
