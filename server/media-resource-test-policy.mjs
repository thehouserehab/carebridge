// Synthetic fixtures ONLY. These are deliberately generous test limits,
// never an operating plan, migration default or automatic service startup.
export async function configureSyntheticMediaPolicy(tx,centerId) {
  await tx.query(`UPDATE cb_media_resource_limits SET revision = 1,storage_bytes = 10737418240,
    pending_uploads = 10000,uploads_per_window = 10000,window_milliseconds = 3600000,accepting_uploads = true
    WHERE center_id = $1 AND revision = 0`,[centerId]);
}
