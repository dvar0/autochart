# GitHub release preparation

Use the verified `public-unsigned` artifacts after completing
[testing-status.md](testing-status.md). The current workflow uploads Actions
artifacts and intentionally does not publish a GitHub Release.

## Public repository snapshot

Start the public repository from a reviewed, source-only snapshot. Copy only the
files in the public source inventory, including dotfiles and build scripts, into
a new directory. Initialize a new Git repository there using the intended public
author name and email
before making its first commit. Do not copy `.git`, old branches or tags,
environment files, build output, logs, installed models, or personal projects.

Prepare a candidate without touching the working app or its storage:

```bash
node scripts/prepare-public-source.cjs /absolute/path/to/new-review-directory
```

The destination's parent must exist; the destination itself must not. The script
copies exactly the paths in `config/public-source-files.json` into `source/`
and records file hashes in a separate `review.json`. It refuses source symlinks
and existing destinations. It does not install packages, run generation, create
Git history, or publish anything. Review and publish only `source/`.

The explicit file list includes application code, build/test scripts, licenses,
synthetic fixtures, and public documentation. Files outside this list are not
included. The public testing summary is `docs/testing-status.md`.
Update the file list when adding source, tests, or screenshot assets; new files
are deliberately not included automatically.

Read the candidate and scan for credentials, private URLs/paths, personal media,
and unexpected binaries. File hashes alone do not perform that review. Confirm
the included fixtures have their provenance notes and all local links resolve.

The snapshot needs its own final release commit and version tag, using the
intended public author identity. Initialize Git history in the reviewed snapshot.
The pinned public model source is already configured. Build release artifacts
from the new tagged commit.

## Before the announcement

- Choose the GitHub destination and public author identity; create the initial
  repository from the reviewed `source/` folder.
- Enable Issues and private vulnerability reporting, matching `SECURITY.md`.
- Add the selected real screenshots/demo and update the explicit source list.
- Replace the README's beta-preparation notice with the real release link only
  when downloads exist. Keep game/platform testing claims accurate.
- Review the README, generation tips, model/application attribution, and the
  draft below. Retain generated-difficulty labels and imported charter credit
  in example exports.
- Finish native verification and record the final artifact evidence. The
  existing model limits are documented beta limitations, not a new model-work
  requirement for source preparation.

## Build and publish

1. Verify the configured public model source, finish testing, and commit the intended release
   changes. The public verifier requires a clean checkout tagged `v0.1.0`
   while `package.json` is version `0.1.0`.
2. Run the native public-unsigned workflow; it builds FFmpeg and packages
   the matching sources automatically. Download each successful target's artifacts.
3. Keep each target's extracted Actions artifacts in its own directory. Run
   `npm run release:stage -- /new/output /linux/artifacts /windows/artifacts /mac/artifacts`.
   This checks hashes and matching source commits, then produces exactly six
   files: the four app packages, one `Autochart-0.1.0-sources.zip`, and one
   `SHA256SUMS.txt`. It preserves the exact source archives, individual sidecars,
   notices, and native checksum records inside the bundle. Windows source line
   endings may differ; no platform's source is discarded or rewritten.
4. Verify the output checksums. Keep native input directories as private build
   evidence. Omit unused update blockmaps from the public release. Put the
   unsigned Windows/macOS warning and opening steps in the release description.
5. Create a GitHub draft release from the final tag and attach only those six
   files. Lead with direct Windows, Mac, and Linux installer links; put portable
   Windows in a secondary link. Link the source bundle and checksum file in a
   collapsible section. The bundle's manifest maps each download to its matching
   application and FFmpeg sources. GitHub additionally lists two automatic
   repository source downloads; they do not replace this complete source bundle.
6. Fill in the tested-machine results, remove untested platforms, check every
   download/source link, and publish when ready.

## Release description draft

<!-- Fill the tested-platform list and source asset links after the final builds.
     Copy the content below into GitHub's release description. -->

Autochart 0.1.0 is a free hobby project that turns audio into Clone Hero/YARG
charts. Generation runs locally; songs are not uploaded. Generated charts may
need timing or note edits.

**Installation:** download the package matching your computer, verify its hash
against `SHA256SUMS.txt`, and follow the installation instructions in the README.
The first run downloads approximately 693 MB of models, with additional room
needed for temporary files, songs, and caches. CPU generation is supported;
GPU acceleration is optional and depends on your hardware and drivers.

**Unsigned downloads:** Windows and macOS packages are unsigned, and macOS
packages are not notarized. SmartScreen/Gatekeeper warnings are expected.
Apple and Microsoft have not verified the publisher. Use the documented
per-app opening instructions only if you trust the verified download.

**Tested platforms and hardware:** fill in results from the machine checklist
before publication, including full-song elapsed time and any known issues.

**Source and licenses:** link `Autochart-0.1.0-sources.zip` beside the installer
links. It contains the exact application and FFmpeg source archives for each
platform, their notices, and checksums. The application is AGPL-3.0-or-later. Fretformer weights are
CC BY-NC-SA 4.0; Demucs and Beat This derivatives retain MIT notices.

Report problems through GitHub Issues with your app version, OS, hardware mode,
and reproduction steps. The in-app highway is a visual preview; play exported
charts in Clone Hero or YARG.
