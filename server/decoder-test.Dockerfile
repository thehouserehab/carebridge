FROM docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS compiled
# Public build dependencies only. No uploaded file or secret enters this stage.
RUN apk add --no-cache build-base nasm pkgconf gnupg zlib-dev dav1d-dev libvpx-dev libwebp-dev x264-dev x265-dev aom-dev lame-dev opus-dev libvorbis-dev
COPY test-results/runtime-build/ffmpeg-9.0.2/ /verified/
WORKDIR /verified
RUN printf '%s\n' \
    '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e  ffmpeg-9.0.2.tar.xz' \
    'd617fd94ea354dadd2a8bb16243d37c44e1e9729b06b6ad58fe30bfb0fa943f2  ffmpeg-9.0.2.tar.xz.asc' \
    '397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5  ffmpeg-devel.asc' | sha256sum -c - \
    && gpg --no-options --batch --no-autostart --dearmor --output /verified/release-key.gpg ffmpeg-devel.asc \
    && gpgv --keyring /verified/release-key.gpg --status-fd 1 ffmpeg-9.0.2.tar.xz.asc ffmpeg-9.0.2.tar.xz >signature.status \
    && grep -E '^\[GNUPG:\] VALIDSIG FCF986EA15E6E293A5644F10B4322F04D67658D8 ' signature.status \
    && tar -xf ffmpeg-9.0.2.tar.xz
WORKDIR /verified/ffmpeg-9.0.2
RUN ./configure --prefix=/opt/carebridge/ffmpeg --disable-autodetect --disable-network --disable-everything \
    --disable-doc --disable-debug --disable-shared --enable-static --enable-gpl --enable-zlib \
    --enable-libdav1d --enable-libvpx --enable-libwebp --enable-libx264 --enable-libx265 --enable-libaom \
    --enable-libmp3lame --enable-libopus --enable-libvorbis --enable-ffprobe --enable-ffmpeg --disable-ffplay \
    --enable-protocol=file,pipe,fd \
    --enable-demuxer=image_png_pipe,image_jpeg_pipe,image_webp_pipe,webp_anim,gif,apng,mov,matroska,image2,rawvideo \
    --enable-indev=lavfi --enable-filter=color,testsrc2,anullsrc,format,scale,aresample,null,anull \
    --enable-decoder=png,apng,mjpeg,gif,webp,webp_anim,h264,hevc,vp8,vp9,libdav1d,mpeg4,aac,mp3,alac,opus,vorbis,rawvideo,pcm_s16le,pcm_u8,wrapped_avframe \
    --enable-parser=png,mjpeg,gif,webp,h264,hevc,vp8,vp9,av1,mpeg4video,aac,mpegaudio,opus,vorbis \
    --enable-encoder=png,mjpeg,gif,libwebp,libwebp_anim,libvpx_vp8,libvpx_vp9,libx264,libx265,libaom_av1,mpeg4,aac,libmp3lame,alac,libopus,libvorbis,pcm_s16le,wrapped_avframe \
    --enable-muxer=image2,gif,webp,mp4,webm,null,matroska,rawvideo \
    && make -j2 && make install \
    && cp COPYING.GPLv2 /opt/carebridge/ffmpeg/COPYING.GPLv2 \
    && apk info -vv > /opt/carebridge/ffmpeg/build-packages.txt \
    && /opt/carebridge/ffmpeg/bin/ffprobe -version \
    && sha256sum /opt/carebridge/ffmpeg/bin/ffprobe /opt/carebridge/ffmpeg/bin/ffmpeg

FROM docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS worker
RUN apk add --no-cache dav1d libvpx libwebp libwebpmux x264-libs x265-libs aom-libs lame-libs opus libvorbis zlib
COPY --from=compiled /opt/carebridge/ffmpeg/ /opt/carebridge/ffmpeg/
WORKDIR /app/server
COPY package.json /app/package.json
COPY src/media-policy.js /app/src/media-policy.js
COPY server/media-preparation-policy.mjs ./
COPY server/errors.mjs server/media-decoder-policy.mjs server/media-container-validation.mjs server/media-decoder.mjs server/decoder-native-test.mjs ./
USER node
CMD ["node", "decoder-native-test.mjs"]

# Test-only exporter reuses the reviewed encoder stage; never ship encoders
# into the separate decoder-job.Dockerfile artifact.
FROM worker AS fixtures
COPY server/decoder-fixtures.mjs ./
CMD ["node", "decoder-fixtures.mjs"]

# Lossless structural image metadata transformation test only. This does not
# change the production/minimal decoder image or its execution protocol.
FROM compiled AS image-color-compiled
RUN apk add --no-cache lcms2-dev=2.19-r0
COPY server/icc-color-test.c /verified/icc-color-test.c
RUN mkdir -p /opt/carebridge/color-test \
    && cc -std=c11 -O2 -Wall -Wextra -Werror /verified/icc-color-test.c -llcms2 -lm -o /opt/carebridge/color-test/icc-color-test

FROM worker AS image-metadata
USER root
RUN apk add --no-cache lcms2=2.19-r0
COPY --from=image-color-compiled /opt/carebridge/color-test/ /opt/carebridge/color-test/
COPY server/image-metadata.mjs server/image-metadata-test-fixtures.mjs server/image-metadata-native-test.mjs ./
COPY server/icc-profile.mjs server/icc-profile-test-fixtures.mjs server/icc-profile-native-test.mjs ./
USER node
CMD ["node", "image-metadata-native-test.mjs"]

# Video structural rewrite and all-stream equivalence use the existing test
# encoder artifact. It is never copied into the production decoder-job image.
FROM worker AS video-metadata
COPY server/video-metadata.mjs server/mp4-metadata.mjs server/webm-metadata.mjs ./
COPY server/video-metadata-test-fixtures.mjs server/video-metadata-native-test.mjs server/image-metadata-test-fixtures.mjs ./
CMD ["node", "video-metadata-native-test.mjs"]
