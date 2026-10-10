import { createHash } from 'node:crypto';

export const BASELINE_COMMIT = '580b873d7cbc71ddf7d1589f50286ed5c11fd3e1';
export const STUDY_STORAGE_KEY = 'child-development-demo-v2';
export const STUDY_MARKER = 'carebridge-synthetic-p0-study';
export const PUBLIC_ASSET = /^(?:index\.html|favicon\.svg|src\/[a-z-]+\.(?:js|css))$/;
export const TASK_A = Object.freeze({
  result: 'partial', reaction: '가상 사례: 놀이를 직접 골랐어요.',
  difficulty: '가상 사례: 오래 이어가기 어려웠어요.',
});
export const TASK_B = Object.freeze({
  title: '비교용 가상 기록', performed: '가상 놀이 두 가지 중 선택',
  response: '가상 관찰: 손으로 가리킴', nextPlan: '다음 회기에 가상 관찰 조건 재확인',
  summary: '가상 놀이를 선택해 참여했어요.',
  assessments: Object.freeze([
    Object.freeze({ tool: '직접 관찰', item: '참여 시간', value: 3, unit: '분', context: '동일한 가상 놀이 공간' }),
    Object.freeze({ tool: '직접 관찰', item: '도움 횟수', value: 0, unit: '회', context: '동일한 가상 놀이 공간' }),
  ]),
});
export const LEGACY_NOTE = [
  `활동: ${TASK_B.performed}`, `반응: ${TASK_B.response}`,
  `측정 2: ${Object.values(TASK_B.assessments[1]).join(' / ')}`,
].join('\n');

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Child processes must not inherit application credentials, DB URLs or .env.
export function studyChildEnvironment(env = process.env) {
  const names = new Set(['systemroot', 'windir', 'comspec', 'path', 'pathext',
    'temp', 'tmp', 'userprofile', 'localappdata', 'appdata', 'home', 'lang', 'lc_all']);
  return Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    names.has(key.toLowerCase()) && typeof value === 'string'));
}

export function studyOptions(args) {
  const allowed = new Set(['--confirm-synthetic-local', '--interactive', '--task=A', '--task=B',
    '--order=baseline-first', '--order=revised-first']);
  if (args.some((arg) => !allowed.has(arg)) || new Set(args).size !== args.length)
    throw new Error('Unknown or duplicate study option');
  if (!args.includes('--confirm-synthetic-local')) throw new Error('Explicit synthetic-local confirmation is required');
  const interactive = args.includes('--interactive');
  const tasks = args.filter((arg) => arg.startsWith('--task='));
  const orders = args.filter((arg) => arg.startsWith('--order='));
  if ((interactive && (tasks.length !== 1 || orders.length !== 1)) ||
      (!interactive && (tasks.length || orders.length))) throw new Error('Interactive mode requires one task and one order; automatic mode accepts neither');
  return Object.freeze({ interactive, task: tasks[0]?.slice(7),
    versions: orders[0] === '--order=revised-first' ? ['revised', 'baseline'] : ['baseline', 'revised'] });
}

// Only for a newly owned non-persistent context. Never overwrite existing data
// or silently reseed data lost during an experiment.
export function seedStudyStorage({ origin, fixture, task, storageKey, marker }) {
  if (location.origin !== origin) return 'outside-origin';
  const previous = localStorage.getItem(storageKey), marked = localStorage.getItem(marker);
  if (marked !== null) {
    if (marked !== 'synthetic-v1' || previous === null) throw new Error('Study storage changed or disappeared');
    return 'preserved';
  }
  if (localStorage.length !== 0 || sessionStorage.length !== 0) throw new Error('Study context must be empty');
  localStorage.setItem(storageKey, JSON.stringify(fixture));
  localStorage.setItem(marker, 'synthetic-v1');
  sessionStorage.setItem('child-development-view', JSON.stringify({
    account: task === 'A' ? 'guardian' : 'therapist', childId: 'c1', view: 'home',
  }));
  return 'seeded';
}
