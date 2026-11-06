# Local synthetic recovery tools only; cached official images, no downloads.
FROM docker.io/library/postgres@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873 AS postgres_tools
# Node base has no inherited anonymous PG data VOLUME. Copy only tools and their
# ldd-reviewed libraries, never PG entrypoint/data/config or host binaries.
FROM docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
COPY --from=postgres_tools /usr/local/bin/pg_dump /usr/local/bin/pg_restore /usr/local/bin/
COPY --from=postgres_tools /usr/local/lib/libpq.so* /opt/pg/lib/
COPY --from=postgres_tools /usr/lib/libzstd.so* /usr/lib/liblz4.so* /usr/lib/libcrypto.so* /usr/lib/libssl.so* /usr/lib/libz.so* /opt/pg/lib/
COPY --from=postgres_tools /usr/lib/libgssapi_krb5.so* /usr/lib/libldap.so* /usr/lib/libkrb5.so* /usr/lib/libk5crypto.so* /usr/lib/libcom_err.so* /opt/pg/lib/
COPY --from=postgres_tools /usr/lib/libkrb5support.so* /usr/lib/liblber.so* /usr/lib/libsasl2.so* /usr/lib/libkeyutils.so* /opt/pg/lib/
ENV LD_LIBRARY_PATH=/opt/pg/lib
WORKDIR /app/server
COPY package.json /app/package.json
COPY src/media-policy.js src/record-fields.js src/message-preview.js /app/src/
COPY server/database.mjs server/errors.mjs server/migrate.mjs server/conversations.mjs server/message-read-states.mjs server/conversation-visibility.mjs server/records.mjs ./
COPY server/media-bindings.mjs server/media-serving.mjs server/media-decoder-policy.mjs server/decoder-job-protocol.mjs ./
COPY server/private-file-store.mjs server/recovery-bundle.mjs server/recovery-native-test.mjs ./
COPY server/recovery-native-contract.mjs ./
COPY server/recovery-recipient-native-check.mjs server/care-recipient-links.mjs server/primary-communicators.mjs server/relationships.mjs server/schedule-gate.mjs ./
COPY server/auth.mjs server/decoder-journal.mjs server/recovery-quarantine.mjs server/media-work-queue.mjs ./
COPY server/image-metadata-test-fixtures.mjs server/media-storage-test-evidence.mjs ./
COPY server/media-resource-test-policy.mjs ./
COPY server/postgres-test-harness.mjs server/postgres-container-fixture.mjs ./
COPY server/migrations/ ./migrations/
COPY server/node_modules/ ./node_modules/
USER node
CMD ["node", "postgres-container-fixture.mjs", "--recovery"]
