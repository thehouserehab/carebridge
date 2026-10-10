// Shared content rules only. Authorization, attachments and persistence remain
// the responsibility of the local/server services.
export function feedbackFields(input) {
  const date = input.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000') ||
      Number.isNaN(Date.parse(`${date}T12:00:00Z`)) ||
      new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date)
    throw new Error('날짜를 확인해 주세요.');
  if (!['done', 'partial', 'skipped'].includes(input.result)) throw new Error('수행 상태를 확인해 주세요.');
  const field = (value, label, required) => {
    if (typeof value !== 'string') throw new Error(`${label}을(를) 확인해 주세요.`);
    const normalized = value.trim();
    if (required && !normalized) throw new Error(`${label}을(를) 입력해 주세요.`);
    if (normalized.length > 1000) throw new Error(`${label}은(는) 1000자 이내로 입력해 주세요.`);
    return normalized;
  };
  return { date, result: input.result, reaction: field(input.reaction, '아이 반응', true),
    difficulty: field(input.difficulty ?? '', '어려움', false) };
}
