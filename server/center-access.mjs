import { fail } from './errors.mjs';
const id = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('INVALID_INPUT');
  return value;
};
// No role from the caller is authority. Held until the surrounding transaction
// ends, so an account/membership revocation cannot race the authorized action.
export async function currentCenterManager(tx,actor) {
  const centerId = id(actor?.centerId),userId = id(actor?.userId);
  const { rows } = await tx.query(`SELECT 1 FROM cb_memberships m JOIN cb_users u ON u.id = m.user_id
    WHERE m.center_id = $1 AND m.user_id = $2 AND m.role = 'center' AND m.active AND u.active FOR SHARE OF m,u`,[centerId,userId]);
  if (rows.length !== 1) fail('NOT_FOUND');
  return { centerId,userId };
}
