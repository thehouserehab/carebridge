// Test-only numeric observation. No process, filesystem, timers or app data.
const phases = new Set(['SANDBOX', 'REGISTER_COMMIT_LOSS', 'EXISTING_MEMBER_EXPLICIT_CONNECTION',
  'UI_PRIVATE_RECORD_AND_OLD_NEWS', 'FROM_NOW_USES_COMMIT_BOUNDARY', 'DISCONNECT_AND_RECONNECT_FROM_NOW',
  'ALL_HISTORY_NEEDS_EXTRA_CONFIRMATION', 'THERAPIST_RECORD_HISTORY_IS_NOT_OWNERSHIP_BYPASS',
  'OLD_RECEIPT_CANNOT_REAPPLY_RELATIONSHIPS', 'REAL_RELATIONSHIP_VERSION_CONFLICT',
  'LATE_RELATIONSHIP_OTHER_CHILD', 'LATE_RELATIONSHIP_CHANGED_ACCOUNT',
  'MANAGER_AUTHORITY_AND_NO_CLINICAL_SIDE_EFFECTS', 'WIDTH_CLEANUP']);
const steps = Object.freeze({
  THERAPIST_RECORD_HISTORY_IS_NOT_OWNERSHIP_BYPASS: Object.freeze([
    'DISCONNECT_EDITOR_READY', 'DISCONNECT_SAVED', 'DISCONNECTED_ACCESS_DENIED', 'DISCONNECTED_READER_REFRESHED',
    'FROM_NOW_EDITOR_READY', 'FROM_NOW_SAVED', 'FROM_NOW_RECORD_HIDDEN', 'ALL_HISTORY_EDITOR_READY',
    'ALL_HISTORY_SAVED', 'ORIGINAL_RECORD_VERIFIED', 'RESTORED_READER_VISIBLE',
  ]),
  WIDTH_CLEANUP: Object.freeze(['CONTEXTS_CLOSED', 'SANDBOX_CLOSED']),
  CLEANUP: Object.freeze(['ROUTES_SETTLED', 'CONTEXTS_CLOSED', 'BROWSER_STOPPED', 'SANDBOXES_CLOSED']),
});
const memoryKeys = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'];
const countKeys = ['contexts', 'sandboxes', 'routeWork', 'retainedSandboxHandles'];
const fail = () => { throw new Error('ENROLLMENT_CHECKPOINT_INVALID'); };
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const numeric = value => { if (!Number.isSafeInteger(value) || value < 0) fail(); return value; };

export function enrollmentCheckpoint(input) {
  try {
    if (!object(input)) fail();
    const { runId, sourceSha256, phase, step = null, elapsedMs, memory, counts } = input;
    if (typeof runId !== 'string' || runId.length !== 36 || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId) ||
        typeof sourceSha256 !== 'string' || sourceSha256.length !== 64 || !/^[a-f0-9]{64}$/.test(sourceSha256) || typeof phase !== 'string' || phase.length > 120) fail();
    const match = /^(390|768|1440):([A-Z_]+)$/.exec(phase), name = match?.[2] ?? phase;
    if (!['STARTUP', 'CLEANUP'].includes(phase) && (!match || match[0] !== phase || !phases.has(name))) fail();
    if (step !== null && !steps[name]?.includes(step)) fail();
    if (!object(memory) || !object(counts)) fail();
    // Explicit projection: unknown keys/getters are never visited. These are
    // this Node process's bytes, not browser RSS or an arbitrary runtime dump.
    const output = Object.freeze({ runId, sourceSha256, phase, step, width: match ? Number(match[1]) : null,
      elapsedMs: numeric(elapsedMs),
      memory: Object.freeze(Object.fromEntries(memoryKeys.map(key => [key, numeric(memory[key])]))),
      counts: Object.freeze(Object.fromEntries(countKeys.map(key => [key, numeric(counts[key])]))),
    });
    if (JSON.stringify(output).length > 2048) fail();
    return output;
  } catch {
    // Even a malformed known-field accessor must not disclose its exception.
    fail();
  }
}
