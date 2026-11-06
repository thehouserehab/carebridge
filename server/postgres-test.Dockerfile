# Test worker only. No registry/npm downloads during build, no application API.
FROM docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
WORKDIR /app/server
COPY package.json /app/package.json
COPY src/media-policy.js src/record-fields.js src/message-preview.js /app/src/
COPY server/database.mjs server/conversations.mjs server/message-read-states.mjs server/conversation-visibility.mjs server/errors.mjs server/media-bindings.mjs server/migrate.mjs ./
COPY server/postgres-integration.mjs server/postgres-test-harness.mjs server/postgres-container-fixture.mjs ./
COPY server/records.mjs server/record-drafts-native-tests.mjs ./
COPY server/message-lifecycle-native-tests.mjs ./
COPY server/auth.mjs server/auth-password-change-native-tests.mjs server/auth-password-recovery-native-tests.mjs ./
COPY server/decoder-journal.mjs server/decoder-journal-native-tests.mjs server/decoder-job-protocol.mjs server/media-decoder-policy.mjs ./
COPY server/media-storage-native-tests.mjs server/media-storage-test-evidence.mjs ./
COPY server/media-queue-native-tests.mjs server/media-queue-native-child.mjs server/media-work-queue.mjs server/media-uploads.mjs ./
COPY server/media-worker-native-tests.mjs server/media-worker-native-child.mjs server/media-work-queue-worker.mjs server/media-worker-process.mjs ./
COPY server/private-file-store.mjs server/image-metadata-test-fixtures.mjs ./
COPY server/media-resource-policy.mjs server/media-resource-test-policy.mjs ./
COPY server/media-resource-native-tests.mjs ./
COPY server/center-access.mjs server/media-work-reviews.mjs server/media-review-native-tests.mjs server/relationships.mjs server/schedule-gate.mjs ./
COPY server/media-preparation.mjs server/media-preparation-evidence.mjs server/media-preparation-protocol.mjs server/media-preparation-policy.mjs ./
COPY server/clamav-client.mjs server/decoder-jobs.mjs server/decoder-container-policy.mjs server/media-serving.mjs ./
COPY server/migrations/ ./migrations/
COPY server/node_modules/ ./node_modules/
USER node
CMD ["node", "postgres-container-fixture.mjs"]
