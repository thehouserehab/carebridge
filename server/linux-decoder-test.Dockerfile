# Synthetic trusted controller ONLY, not the untrusted per-file media image.
# No remote downloads or automatic engine installation in this build.
FROM docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f AS controller
COPY --chmod=0555 test-results/runtime-build/docker-cli-29.8.1/docker/docker /usr/local/bin/docker
RUN printf '%s\n' '9c46230f41e4263b3a9d93ae9284722709923c50d138bc64eed2bb6c02af0581  /usr/local/bin/docker' | sha256sum -c -
WORKDIR /app/server
COPY package.json /app/package.json
COPY src/media-policy.js /app/src/media-policy.js
COPY server/errors.mjs server/database.mjs server/migrate.mjs server/decoder-job-protocol.mjs server/media-decoder-policy.mjs ./
COPY server/media-preparation-policy.mjs server/media-preparation-protocol.mjs ./
COPY server/decoder-container-policy.mjs server/decoder-jobs.mjs server/decoder-journal.mjs ./
COPY server/decoder-cli-transport.mjs server/linux-decoder-runtime.mjs ./
COPY server/linux-decoder-test-fixtures.mjs server/linux-decoder-native-child.mjs server/linux-decoder-native-test.mjs ./
COPY server/migrations/ ./migrations/
COPY server/node_modules/ ./node_modules/
USER node
CMD ["node", "linux-decoder-native-test.mjs"]

# Separate opt-in synthetic native pipeline controller. Neither stage is a web
# service or untrusted per-file image. No additional executable/dependency.
FROM controller AS media-preparation
COPY server/clamav-client.mjs server/media-preparation.mjs server/media-preparation-evidence.mjs server/media-preparation-native-test.mjs server/image-metadata-test-fixtures.mjs ./
COPY src/record-fields.js src/message-preview.js /app/src/
COPY server/media-uploads.mjs server/media-access.mjs server/media-bindings.mjs server/media-serving.mjs server/private-file-store.mjs server/conversations.mjs server/message-read-states.mjs server/conversation-visibility.mjs server/records.mjs ./
COPY server/media-preparation-storage-native-test.mjs server/media-work-queue.mjs server/media-work-queue-worker.mjs ./
COPY server/media-resource-policy.mjs server/media-resource-test-policy.mjs ./
COPY server/center-access.mjs server/media-work-reviews.mjs server/relationships.mjs server/schedule-gate.mjs ./
COPY server/node_modules/@electric-sql/pglite/ ./node_modules/@electric-sql/pglite/
CMD ["node", "media-preparation-native-test.mjs"]
