# Third-Party Notices

Last updated: 2026-08-20

Autochart includes the software and model artifacts listed below. Autochart's
own license does not replace the licenses of these components.

## Electron

- Upstream: https://github.com/electron/electron
- Copyright: Electron contributors; 2013-2020 GitHub Inc.
- License: MIT
- Use: Electron is the bundled desktop application shell. Electron also embeds
  Chromium, Node.js, and their third-party components.

The Electron MIT notice is reproduced by the MIT License section below.
Electron distributions also contain Electron's `LICENSE` and Chromium's full
`LICENSES.chromium.html` notice bundle alongside the Electron executable.

## Standalone Node.js runtime

- Upstream: https://nodejs.org/
- Copyright: Node.js contributors
- License: MIT and the licenses of its bundled third-party components
- Use: Node.js v24.19.0 is bundled as a separate executable so the local ONNX
  generator can initialize GPU providers outside Electron's run-as-Node mode.

The exact `LICENSE` file from the hash-pinned Node.js release archive, including
Node.js's MIT terms and bundled third-party notices, ships beside the executable
at `resources/node-runtime/LICENSE`.

## React and React DOM

- Upstream: https://github.com/facebook/react
- Copyright: Facebook, Inc. and its affiliates
- License: MIT
- Use: The `react` and `react-dom` npm packages provide the bundled user
  interface runtime.

The applicable license text is reproduced by the MIT License section below.

## ONNX Runtime

- Upstream: https://github.com/microsoft/onnxruntime
- Copyright: Microsoft Corporation
- License: MIT
- Use: The `onnxruntime-node` npm package and its native runtime libraries run
  Autochart's local ONNX inference pipeline.

The applicable license text is reproduced by the MIT License section below.
ONNX Runtime's compiled distributions contain additional third-party software.
The complete notice for the shipped version (v1.27.0) ships with packaged
Autochart distributions as `docs/onnxruntime-third-party-notices.txt`.

## node-tar

- Upstream: https://github.com/isaacs/node-tar
- Copyright: Isaac Z. Schlueter and contributors
- License: Blue Oak Model License 1.0.0
- Use: Application-side tar and tar.zst inspection and extraction after strict
  archive-entry validation.

The shipped `tar` 7.5.22 runtime is the package's self-contained
`dist/commonjs/index.min.js` bundle. It embeds `minipass` 7.1.3, `chownr`
3.0.0, and `yallist` 5.0.0, which—like `tar` itself—declare the Blue Oak
Model License 1.0.0. The complete license text covering those four components
ships as `docs/blueoak-1.0.0.txt`.

The same bundle embeds two components with distinct notices:

- `@isaacs/fs-minipass` 4.0.1 — ISC. Its exact upstream copyright and license
  notice ships as `docs/fs-minipass-isc.txt`.
- `minizlib` 3.1.0 — MIT. Its exact upstream attribution, Node.js/Joyent
  copyrights, and MIT license notice ship as `docs/minizlib-mit.txt`.

## yauzl and pend

- Upstream: https://github.com/thejoshwolfe/yauzl and
  https://github.com/andrewrk/node-pend
- Copyright: Josh Wolfe, Andrew Kelley, and contributors
- License: MIT
- Use: Application-side streaming ZIP inspection and extraction.

The applicable license text is reproduced by the MIT License section below.

## FFmpeg, libogg, libvorbis, libvpx and dav1d

- FFmpeg 9.0.1: https://ffmpeg.org/, copyright 2000-2026 the FFmpeg developers.
  License: LGPL-2.1-or-later; full text in `docs/lgpl-2.1.txt`.
- libogg 1.3.6 and libvorbis 1.3.7: https://xiph.org/, copyright the Xiph.Org
  Foundation and contributors. BSD license texts in `docs/xiph-bsd.txt`.
- libvpx 1.16.0: https://github.com/webmproject/libvpx, copyright 2010 the
  WebM Project authors. BSD license text in `docs/libvpx-bsd.txt`.
- dav1d 1.5.4: https://www.videolan.org/projects/dav1d.html, copyright 2018-2025
  VideoLAN and dav1d authors. BSD-2-Clause license text in `docs/dav1d-bsd.txt`.
- Use: a separately executed audio/video conversion tool at
  `resources/ffmpeg/ffmpeg` (`ffmpeg.exe` on Windows).

All supported platforms build the same pinned sources using
`scripts/ffmpeg-build.sh`. GPL, version-3-only and nonfree components are disabled.
The Xiph, WebM and dav1d libraries are linked statically; ordinary operating-system libraries
remain system dependencies. Autochart's own license remains AGPL-3.0-or-later.

Each release automatically creates
`Autochart-${version}-${os}-${arch}-ffmpeg-corresponding-source.tar.gz` and its
`.sha256` sidecar. Publish these beside the installer at no additional charge.
The archive contains the unmodified upstream sources (with their licenses),
the exact offline build script, configure log, configuration header and build
information linking the source package to the executable. See its `README.txt`
for rebuilding and replacing the separately executed FFmpeg binary.

## Fretformer

- Title: Fretformer v1 model weights and ONNX export
- Creator and copyright: 2026 Autochart contributors
- Source: Autochart engine catalog component `fretformer-v1-onnx`, version
  1.0.0
- License: Creative Commons Attribution-NonCommercial-ShareAlike 4.0
  International (CC BY-NC-SA 4.0)
- License URI: https://creativecommons.org/licenses/by-nc-sa/4.0/
- Use: Separately downloaded Fretformer transcription weights and their ONNX
  export.

The trained model was exported and adapted to Autochart's local ONNX Runtime
graph/session format. Sharing and adaptation are restricted to NonCommercial
purposes and require Attribution and ShareAlike. Autochart's AGPL application
license does not remove that model restriction. The complete attribution and
legal code ship in `engine/licenses/model-pack-attribution.txt` and
`engine/licenses/cc-by-nc-sa-4.0.txt`; setup installs identical, hash-pinned
copies from the packaged app rather than relying on the model host for legal
texts.

## Demucs / Hybrid Transformer Demucs

- Upstream: https://github.com/facebookresearch/demucs
- Copyright: Meta Platforms, Inc. and affiliates
- License: MIT
- Use: Separately downloaded ONNX graphs in the Autochart model pack are
  converted from the released `htdemucs` pretrained weights; Autochart's
  inference implementation is an independent JavaScript port.

Demucs publishes the code and pretrained model catalog under the repository's
MIT license and publishes no separate license for the `htdemucs` weights. The
app therefore preserves the repository MIT notice for the converted weights.
The applicable license text is reproduced by the MIT License section below.

Research citation requested by the upstream project:

> Simon Rouard, Francisco Massa, and Alexandre Defossez, "Hybrid Transformers
> for Music Source Separation," ICASSP 2023.

## Beat This!

- Upstream: https://github.com/CPJKU/beat_this
- Copyright: 2024 Institute of Computational Perception, JKU Linz, Austria
- License: MIT
- Use: Separately downloaded ONNX graphs in the Autochart model pack are
  derived from a Beat This published checkpoint and subsequent Autochart
  fine-tuning; Autochart's inference implementation is an independent
  JavaScript port.

The upstream README expressly releases both the code and published model
weights under MIT. The applicable license text is reproduced by the MIT License
section below.

Research citation requested by the upstream project:

> Francesco Foscarin, Jan Schluter, and Gerhard Widmer, "Beat This! Accurate
> Beat Tracking Without DBN Postprocessing," ISMIR 2024.

## Baloo 2

- Upstream: https://github.com/EkType/Baloo2
- Package: https://fontsource.org/fonts/baloo-2
- Copyright: 2019 The Baloo 2 Project Authors
- License: SIL Open Font License 1.1
- Use: Font files and CSS from the `@fontsource/baloo-2` npm package are bundled
  in the user interface.

The npm package itself declares `OFL-1.1`; it does not declare MIT. The
applicable license text is reproduced by the SIL Open Font License section
below.

## Inter

- Upstream: https://github.com/rsms/inter
- Package: https://fontsource.org/fonts/inter
- Copyright: 2016 The Inter Project Authors
- License: SIL Open Font License 1.1
- Use: Font files and CSS from the `@fontsource/inter` npm package are bundled
  in the user interface.

The npm package itself declares `OFL-1.1`; it does not declare MIT. The
applicable license text is reproduced by the SIL Open Font License section
below.

## JetBrains Mono

- Upstream: https://github.com/JetBrains/JetBrainsMono
- Package: https://fontsource.org/fonts/jetbrains-mono
- Copyright: 2020 The JetBrains Mono Project Authors
- License: SIL Open Font License 1.1
- Use: Font files and CSS from the `@fontsource/jetbrains-mono` npm package are
  bundled in the user interface.

The npm package itself declares `OFL-1.1`; it does not declare MIT. The
applicable license text is reproduced by the SIL Open Font License section
below.

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## SIL Open Font License 1.1

SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
