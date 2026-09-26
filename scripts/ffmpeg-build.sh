#!/usr/bin/env bash
# Offline rebuild: bash ffmpeg-build.sh SOURCE_DIRECTORY EMPTY_BUILD_DIRECTORY
# Autochart invokes this with a minimal environment: configure logs are public.
set -euo pipefail
sources="$(cd "$1" && pwd)"
mkdir -p "$2"
work="$(cd "$2" && pwd)"
if [[ -n "$(ls -A "$work")" ]]; then
  echo 'Choose an empty FFmpeg build directory.' >&2
  exit 1
fi
prefix="$work/install"
jobs="${AUTOCHART_BUILD_JOBS:-4}"
export LC_ALL=C
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export PKG_CONFIG_PATH=""
export CFLAGS="-O2"
export LDFLAGS=""
platform_flags=()
case "$(uname -s)" in
  MINGW*|MSYS*|UCRT*) export CC=gcc; export LDFLAGS="-static-libgcc -static"; platform_flags=(--target-os=mingw32 --arch=x86_64 --disable-pthreads --enable-w32threads); vpx_target=x86_64-win64-gcc ;;
  Darwin) export CC=clang; export MACOSX_DEPLOYMENT_TARGET=12.0; vpx_target=arm64-darwin20-gcc ;;
  Linux) export CC=cc; vpx_target=x86_64-linux-gcc ;;
  *) echo 'Unsupported build host' >&2; exit 1 ;;
esac
cd "$work"
tar -xf "$sources/libogg-1.3.6.tar.xz"
tar -xf "$sources/libvorbis-1.3.7.tar.xz"
tar -xf "$sources/ffmpeg-9.0.1.tar.xz"
tar -xf "$sources/libvpx-1.16.0.tar.gz"
tar -xf "$sources/dav1d-1.5.4.tar.xz"
meson setup "$work/dav1d-build" "$work/dav1d-1.5.4" \
  --prefix="$prefix" --libdir=lib --buildtype=release --default-library=static \
  --wrap-mode=nodownload -Db_staticpic=true -Denable_tools=false \
  -Denable_tests=false -Denable_examples=false -Denable_docs=false
meson compile -C "$work/dav1d-build" -j "$jobs"
meson install -C "$work/dav1d-build"
cd "$work/libogg-1.3.6"
./configure --prefix="$prefix" --disable-shared --enable-static --with-pic
make -j"$jobs"
make install
cd "$work/libvorbis-1.3.7"
# libvorbis's legacy Darwin flags include a PowerPC linker option removed from
# current Apple linkers. Keep the upstream archive intact and record this source
# adjustment in the shipped, reproducible build recipe.
if [[ "$(uname -s)" == Darwin ]]; then
  sed 's/ -force_cpusubtype_ALL//g' configure > configure.autochart
  mv configure.autochart configure
  chmod +x configure
fi
./configure --prefix="$prefix" --disable-shared --enable-static --with-pic --disable-oggtest
make -j"$jobs"
make install
cd "$work/libvpx-1.16.0"
# Match the supported native release targets. Runtime dispatch keeps x64 builds
# portable across CPUs; never use -march=native for distributed binaries.
# Apple Silicon uses its ARM/NEON implementation, without an x86 assembler.
# libvpx's unversioned arm64-darwin target selects iOS; darwin20 selects macOS.
./configure --prefix="$prefix" --target="$vpx_target" --enable-runtime-cpu-detect --disable-shared \
  --enable-static --enable-pic --disable-examples --disable-tools \
  --disable-docs --disable-unit-tests --disable-vp9 --disable-vp8-decoder
make -j"$jobs"
make install
cd "$work/ffmpeg-9.0.1"
./configure --prefix="$prefix" --disable-autodetect --disable-gpl --disable-nonfree \
  --disable-version3 --disable-shared --enable-static \
  --disable-doc --disable-debug --disable-network --disable-avdevice \
  --disable-ffplay --disable-ffprobe --disable-everything --enable-ffmpeg \
  --enable-libvorbis --enable-libvpx --enable-libdav1d --pkg-config-flags=--static \
  --enable-protocol=file,pipe \
  --enable-demuxer=aac,aiff,flac,matroska,mov,mp3,ogg,wav,image2,webp_pipe,gif \
  --enable-decoder='aac,aac_fixed,ac3,eac3,alac,flac,mp1,mp1float,mp2,mp2float,mp3,mp3float,opus,vorbis,pcm_*,adpcm_*,h264,hevc,vp8,vp9,libdav1d,theora,mpeg4,mpeg2video,mjpeg,webp,gif' \
  --enable-parser=aac,aac_latm,ac3,flac,mpegaudio,opus,vorbis,h264,hevc,vp8,vp9,av1,mpeg4video,mpegvideo,mjpeg \
  --enable-encoder=libvorbis,flac,pcm_f32le,pcm_s16le,libvpx_vp8,mjpeg \
  --enable-muxer=ogg,flac,pcm_f32le,wav,webm,image2 \
  --enable-filter=abuffer,abuffersink,aformat,anull,anullsrc,aresample,asetpts,atrim,concat,buffer,buffersink,null,scale,format,transpose,hflip,vflip,setsar \
  --extra-ldflags="$LDFLAGS" ${platform_flags[@]+"${platform_flags[@]}"}
# Configure can succeed after silently disabling a requested external encoder.
# Video previews and game exports require this codec on every supported target.
if ! grep -q '^#define CONFIG_LIBVPX_VP8_ENCODER 1$' config_components.h; then
  echo 'Required libvpx VP8 encoder was disabled; inspect ffbuild/config.log.' >&2
  exit 1
fi
make -j"$jobs"
make install
