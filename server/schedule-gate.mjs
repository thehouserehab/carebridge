import { fail } from './errors.mjs';

// Shared allocation gate; must precede child-room/participant locks.
export async function lockCenterSchedule(tx, centerId) {
  const { rows } = await tx.query('SELECT schedule_version FROM cb_centers WHERE id = $1 FOR NO KEY UPDATE', [centerId]);
  if (!rows.length) fail('NOT_FOUND');
  return Number(rows[0].schedule_version);
}
export function scheduleError(error) {
  if (error.code === '23P01' && error.constraint === 'cb_schedule_overlap') fail('SCHEDULE_CONFLICT');
  throw error;
}
