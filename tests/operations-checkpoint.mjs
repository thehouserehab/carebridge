// Test-only numeric observation. No process, filesystem, timers or app data.
const phases = new Set(['SANDBOX', 'UI_CLINICAL_SENTINELS', 'CENTER_ONLY_LIST_AND_EDITOR',
  'REAL_COMMIT_LOSS_AND_EXACT_RETRY', 'CLINICAL_READERS_REFRESH', 'NO_OP_AND_EXPLICIT_CLEAR',
  'DRAFT_LIST_RETURN', 'ACTUAL_PROFILE_CONFLICT', 'LATE_DETAIL_OTHER_CHILD',
  'LATE_DETAIL_ACCOUNT_SWITCH', 'MANAGER_MEMBERSHIP_REVOKED']);
const steps = Object.freeze({
  ACTUAL_PROFILE_CONFLICT: Object.freeze(['CONFLICT_CAPTURED', 'CONFLICT_INPUT_KEPT', 'CONFLICT_RECEIPT_RECEIVED', 'CONFLICT_DB_CHECKED']),
  LATE_DETAIL_OTHER_CHILD: Object.freeze(['LATE_CHILD_GET_HELD', 'LATE_CHILD_GATE_RELEASED']),
});
const memoryKeys = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'];
const countKeys = ['contexts', 'sandboxes', 'routeWork', 'retainedSandboxHandles'];
const fail = () => { throw new Error('OPERATIONS_CHECKPOINT_INVALID'); };
const numeric = value => { if (!Number.isSafeInteger(value) || value < 0) fail(); return value; };

export function operationsCheckpoint({ runId, sourceSha256, phase, step = null, elapsedMs, memory, counts }) {
  if (typeof runId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(runId) ||
      typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256) || typeof phase !== 'string') fail();
  const match = /^(390|768|1440):([A-Z_]+)$/.exec(phase), name = match?.[2];
  if (phase !== 'STARTUP' && (!match || !phases.has(name))) fail();
  if (step !== null && !steps[name]?.includes(step)) fail();
  if (!memory || typeof memory !== 'object' || !counts || typeof counts !== 'object') fail();
  // Explicit projection: unknown keys (including diagnostic objects) are never
  // read or serialized. These are this Node process's bytes, not browser RSS.
  const output = Object.freeze({ runId, sourceSha256, phase, step, width: match ? Number(match[1]) : null,
    elapsedMs: numeric(elapsedMs),
    memory: Object.freeze(Object.fromEntries(memoryKeys.map(key => [key, numeric(memory[key])]))),
    counts: Object.freeze(Object.fromEntries(countKeys.map(key => [key, numeric(counts[key])]))),
  });
  if (JSON.stringify(output).length > 2048) fail();
  return output;
}
