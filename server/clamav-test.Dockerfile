FROM docker.io/clamav/clamav@sha256:57deb108fc4c72778aa83eafbca7bb7153e28c3f57c005afd38d31f16da86f23 AS engine
COPY server/clamav-test.conf /opt/carebridge/clamd.conf
COPY server/clamav-test-freshclam.conf /opt/carebridge/freshclam.conf
USER clamav
HEALTHCHECK NONE
ENTRYPOINT ["clamd"]
CMD ["--config-file=/opt/carebridge/clamd.conf"]

FROM docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS worker
WORKDIR /app/server
COPY package.json /app/package.json
COPY src/media-policy.js /app/src/media-policy.js
COPY server/errors.mjs server/clamav-client.mjs server/clamav-native-test.mjs ./
USER node
CMD ["node", "clamav-native-test.mjs"]
