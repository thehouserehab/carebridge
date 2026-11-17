// Explicit offline prototype responses. Never imported by production or live-AI launchers.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const prototypeAudioSample = Object.freeze({
  name: 'carebridge-demo-session.wav', type: 'audio/wav',
  size: 997372,
  url: new URL('../assets/prototype/carebridge-demo-session.wav', import.meta.url),
  sha256: 'eed0768308f358bb54e516aa7d7fe7a944fb5e8285df9a3c075987f9d9c52880',
});
export async function readPrototypeAudioSample() {
  const bytes = await readFile(prototypeAudioSample.url);
  if (createHash('sha256').update(bytes).digest('hex') !== prototypeAudioSample.sha256) throw new Error('PROTOTYPE_SAMPLE_CHANGED');
  return bytes;
}
const segments = [
  { id: 0, start: 0, end: 2.6, text: '가상 수업 테스트입니다.' },
  { id: 1, start: 2.6, end: 7.12, text: '치료사는 블록 2개 중 하나를 고르도록 말했습니다.' },
  { id: 2, start: 7.12, end: 12.06, text: '가상 아동이 파란 블록을 골랐다고 치료사가 기록했습니다.' },
  { id: 3, start: 12.06, end: 18.36, text: '다음 수업에서는 같은 블록을 준비하고 선택할 시간을 충분히 주기로 했습니다.' },
  { id: 4, start: 18.36, end: 21.88, text: '실제 아동이나 상담 내용은 포함하지 않았습니다.' },
];
const audioExample = {
  transcript: { text: segments.map(s => s.text).join(' '), durationSeconds: 22.61, segments },
  analysis: {
    performed: [{ text: '블록 2개 중 하나를 고르도록 안내했다고 기록했습니다.', segmentIds: [1] }],
    response: [{ text: '기록에 따르면 가상 아동은 파란 블록을 골랐습니다.', segmentIds: [2] }],
    reflection: [],
    nextPlan: [{ text: '다음 수업에 같은 블록을 준비하고 선택할 시간을 충분히 주기로 했습니다.', segmentIds: [3] }],
    summary: [{ text: '두 블록 중 하나를 고르도록 안내했고, 기록에 따르면 파란 블록을 골랐습니다.', segmentIds: [1, 2] }],
    warnings: ['제공된 가상 녹음의 시연용 응답입니다. 이번 실행에서 외부 AI를 호출하지 않았습니다.'],
  },
};
function active(signal) {
  if (signal?.aborted) { const error = new Error('AI_CANCELLED'); error.code = 'AI_CANCELLED'; throw error; }
}
export function createPrototypeProviders() {
  return {
    summaryProvider: { mode: 'fixture', model: 'prototype-record-example', async generate(source, { signal } = {}) {
      active(signal);
      const parts = [source.performed?.trim(), source.response?.trim()].filter(Boolean);
      return { summary: parts.join('\n').slice(0, 1100) || '활동과 아이의 반응을 먼저 기록해 주세요.',
        reviewNotes: ['시연 모드에서는 입력한 활동·반응을 그대로 묶어 보여줍니다. 실제 AI 요약은 별도 연결 모드에서 사용할 수 있습니다.'],
        usage: { inputTokens: 0, outputTokens: 0 } };
    } },
    chatProvider: { mode: 'fixture', model: 'prototype-chat-example', async respond({ messages }, { signal } = {}) {
      active(signal);
      const prompt = messages.at(-1)?.content ?? '';
      const answer = /사진|영상|첨부/.test(prompt)
        ? '대화 입력창 왼쪽 + 버튼에서 사진·동영상을 첨부할 수 있어요. 시연에서는 제공된 샘플을 선택하세요. 가정 활동 답변에도 첨부할 수 있습니다.'
        : /녹음|음성/.test(prompt)
          ? '녹음 정리에서 저장된 수업 기록을 선택한 뒤 제공된 WAV 샘플을 올려 주세요. 전사·활동·반응·다음 준비를 검토하고 필요한 항목만 기록에 넣을 수 있어요.'
          : /가정|보호자|공유/.test(prompt)
            ? '공유할 보고서를 미리 확인한 뒤 보호자에게 전달해 보세요. 보호자는 보고서에서 활동 경험을 남기고, 날짜별 소식은 아이 정보의 일정에서 다시 확인할 수 있어요.'
            : '오늘 한 활동, 아이가 보인 반응, 다음에 준비할 내용을 짧게 적어 보세요. 기록 도우미에서 초안을 확인한 뒤 직접 수정하고 저장·공유하는 흐름을 시연할 수 있어요.';
      return { text: '시연용 예시 답변입니다.\n\n' + answer, usage: { inputTokens: 0, outputTokens: 0 } };
    } },
    audioProvider: { mode: 'fixture', model: 'prototype-audio-example', transcriptionModel: 'prototype-transcript-example',
      async generate({ bytes, type }, { signal, authorizeStage } = {}) {
        active(signal);
        if (type !== prototypeAudioSample.type || createHash('sha256').update(bytes).digest('hex') !== prototypeAudioSample.sha256) {
          const error = new Error('AI_OUTPUT_INVALID'); error.code = 'AI_OUTPUT_INVALID'; throw error;
        }
        await authorizeStage?.('transcription'); active(signal);
        await authorizeStage?.('analysis'); active(signal);
        return structuredClone(audioExample);
      },
    },
  };
}
