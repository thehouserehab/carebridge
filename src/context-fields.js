const field = (value, label, max, required = true) => {
  if (typeof value !== 'string') throw new Error(`${label}을(를) 확인해 주세요.`);
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`${label}을(를) 입력해 주세요.`);
  if (normalized.length > max) throw new Error(`${label}은(는) ${max}자 이내로 입력해 주세요.`);
  return normalized;
};
export function contextDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000') ||
      Number.isNaN(Date.parse(`${value}T12:00:00Z`)) || new Date(`${value}T12:00:00Z`).toISOString().slice(0,10) !== value)
    throw new Error('날짜를 확인해 주세요.');
  return value;
}
export const startMinute = (time) => Number(time.slice(0,2)) * 60 + Number(time.slice(3));
export function intervalsOverlap(a, b) {
  return startMinute(a.time) < startMinute(b.time) + b.duration && startMinute(b.time) < startMinute(a.time) + a.duration;
}
function contextText(value, label, max, required) {
  const controls = required ? /[\x00-\x1f\x7f-\x9f]/ : /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
  // Check the submitted string before trimming: malformed Unicode, hidden
  // controls or overlong input must not become a different accepted request.
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > max || controls.test(value))
    throw new Error(`${label}을(를) 확인해 주세요.`);
  return field(value,label,max,required);
}
export function goalFields(input) {
  const status = input.status === undefined ? 'active' : input.status;
  if (!['active','achieved','paused'].includes(status)) throw new Error('목표 상태를 확인해 주세요.');
  return { title: contextText(input.title,'목표',100,true),
    description: contextText(input.description === undefined ? '' : input.description,'설명',2000,false), status };
}
export function appointmentFields(input) {
  if (typeof input.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('시간을 확인해 주세요.');
  if (!['string','number'].includes(typeof input.duration) ||
      (typeof input.duration === 'string' && !/^\d{1,3}$/.test(input.duration))) throw new Error('진행 시간을 확인해 주세요.');
  const duration = Number(input.duration);
  if (!Number.isInteger(duration) || duration < 10 || duration > 180) throw new Error('진행 시간은 10~180분으로 입력해 주세요.');
  if (startMinute(input.time) + duration > 1440) throw new Error('일정은 같은 날 안에 끝나야 합니다.');
  const status = input.status === undefined ? 'scheduled' : input.status;
  if (!['scheduled','attended','absent','cancelled'].includes(status)) throw new Error('일정 상태를 확인해 주세요.');
  return { date: contextDate(input.date), time: input.time, duration,
    title: contextText(input.title,'일정 이름',100,true), room: contextText(input.room,'장소',60,true), status };
}
