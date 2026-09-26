# Contributing to Autochart

Autochart is a personal hobby project. Bug reports, documentation improvements,
and focused fixes are welcome. Response times vary; there is no promised support
schedule.

## Report a problem

Use the bug report form in GitHub Issues. Include your app version, operating
system and architecture, hardware mode, what you expected, and what happened.
For a generation problem, include the song duration, difficulty, timing detector,
and whether the problem repeats with the same settings. A description of the
affected passage is useful even if you cannot share the audio.

Review logs for personal paths before attaching them. Share a minimal example
you are comfortable making public. Do not include model files, your whole song
library, credentials, or private download URLs. For vulnerabilities, follow
[SECURITY.md](SECURITY.md).

## Suggest a change

Explain the problem and your current workaround. Open an issue before a
substantial feature or generation change so the scope can be discussed. Venue
authoring is maintained separately and is outside this application's scope.

## Make a pull request

1. Follow the [development guide](docs/development.md).
2. Keep the change focused and follow the existing JSX, CSS, and CommonJS style.
3. Run relevant checks and describe the behavior verified. For UI changes,
   include screenshots and check light and dark themes.
4. Explain the problem, resulting behavior, and any remaining limitations.

| Change | Checks |
| --- | --- |
| Documentation | `npm run test:release-docs`; review links and instructions |
| React UI | `npm run build`, `npm run test:v010:frontend`; inspect affected UI |
| Library/persistence | `npm run test:v010:backend`, `npm run test:imported-final-chart` |
| Chart metadata/export | `npm run test:chart-metadata`, `npm run test:clone-hero-export` |
| Generation | Read `docs/engine-integration.md`; run relevant engine gates and an isolated generation smoke |

Some tests need Electron, a display, model files, or native FFmpeg. Report checks
you could not run. Release maintainers run the full native release gate before
publishing. A documentation-only change does not require another model download.

Keep generated outputs, installed models, personal media, credentials, and local
machine settings out of commits. Synthetic fixtures have provenance notes under
`fixtures/`. Preserve existing licenses and attribution.
