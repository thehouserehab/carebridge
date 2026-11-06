FROM docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
WORKDIR /app/server
COPY server/clamav-relay-peer-test.mjs ./
USER node
HEALTHCHECK NONE
ENTRYPOINT ["/usr/local/bin/node"]
CMD ["/app/server/clamav-relay-peer-test.mjs"]
