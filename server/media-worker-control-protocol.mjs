// Inherited parent/child IPC only. Run IDs bind a session, not an OS identity
// or a secret. No config, credentials, clinical/file data or handles on wire.
import {RepositoryError} from './errors.mjs';
export const controlUnavailable = () => new RepositoryError('MEDIA_WORKER_CONTROL_UNAVAILABLE');
const purpose = 'carebridge-media-worker-control';
export function mediaWorkerControlId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) throw controlUnavailable();
  return value;
}
export function mediaWorkerControlMessage(instanceId,kind,requestId = null) {
  mediaWorkerControlId(instanceId);
  if (!['stop','control-ready','stop-accepted','drained','failed'].includes(kind) ||
      requestId !== null && mediaWorkerControlId(requestId) !== requestId ||
      ['stop','stop-accepted'].includes(kind) && requestId === null || kind === 'control-ready' && requestId !== null) throw controlUnavailable();
  return Object.freeze({schema:1,purpose,instanceId,kind,requestId});
}
export function parseMediaWorkerControlMessage(value,instanceId,direction,handle) {
  if (handle !== undefined || !value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'instanceId,kind,purpose,requestId,schema' ||
      value.schema !== 1 || value.purpose !== purpose || value.instanceId !== instanceId ||
      !['parent','child'].includes(direction) || (direction === 'parent' ? value.kind !== 'stop' : value.kind === 'stop')) throw controlUnavailable();
  return mediaWorkerControlMessage(instanceId,value.kind,value.requestId);
}
