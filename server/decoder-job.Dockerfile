FROM docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS compiled
RUN apk add --no-cache build-base nasm pkgconf gnupg zlib-dev dav1d-dev
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
    --disable-doc --disable-debug --disable-shared --enable-static --enable-zlib --enable-libdav1d \
    --enable-ffprobe --disable-ffmpeg --disable-ffplay --enable-protocol=fd \
    --enable-demuxer=image_png_pipe,image_jpeg_pipe,image_webp_pipe,webp_anim,gif,apng,mov,matroska \
    --enable-decoder=png,apng,mjpeg,gif,webp,webp_anim,h264,hevc,vp8,vp9,libdav1d,mpeg4,aac,mp3,alac,opus,vorbis \
    --enable-parser=png,mjpeg,gif,webp,h264,hevc,vp8,vp9,av1,mpeg4video,aac,mpegaudio,opus,vorbis \
    && make -j2 && make install \
    && cp COPYING.LGPLv2.1 /opt/carebridge/ffmpeg/COPYING.LGPLv2.1 \
    && apk info -vv > /opt/carebridge/ffmpeg/build-packages.txt \
    && /opt/carebridge/ffmpeg/bin/ffprobe -version \
    && sha256sum /opt/carebridge/ffmpeg/bin/ffprobe

FROM docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS worker
RUN apk add --no-cache dav1d zlib
COPY --from=compiled /opt/carebridge/ffmpeg/ /opt/carebridge/ffmpeg/
WORKDIR /app/server
COPY package.json /app/package.json
COPY src/media-policy.js /app/src/media-policy.js
COPY server/errors.mjs server/media-decoder-policy.mjs server/media-container-validation.mjs server/media-decoder.mjs server/decoder-job-protocol.mjs server/decoder-job-worker.mjs ./
COPY server/media-preparation-policy.mjs server/media-preparation-protocol.mjs server/media-preparation-worker.mjs server/image-metadata.mjs server/icc-profile.mjs server/video-metadata.mjs server/mp4-metadata.mjs server/webm-metadata.mjs ./
USER node
CMD ["node", "decoder-job-worker.mjs"]
