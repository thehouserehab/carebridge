import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrototypeProviders, readPrototypeAudioSample } from '../prototype-ai-fixtures.mjs';
import { validateAudioAnalysisResult } from '../../src/audio-note-contract.js';

test('prototype audio only replays its supplied synthetic source and validates the normal result contract', async () => {
  const provider = createPrototypeProviders().audioProvider, bytes = await readPrototypeAudioSample(), stages = [];
  const result = await provider.generate({ bytes, type: 'audio/wav' }, { authorizeStage: async stage => stages.push(stage) });
  assert.equal(provider.mode, 'fixture');
  assert.deepEqual(stages, ['transcription', 'analysis']);
  assert.deepEqual(validateAudioAnalysisResult(result), result);
  result.analysis.summary[0].text = 'changed';
  assert.notEqual((await provider.generate({ bytes, type: 'audio/wav' })).analysis.summary[0].text, 'changed');
  const altered = Buffer.from(bytes); altered[50] ^= 1;
  await assert.rejects(provider.generate({ bytes: altered, type: 'audio/wav' }), { code: 'AI_OUTPUT_INVALID' });
  await assert.rejects(provider.generate({ bytes, type: 'audio/mpeg' }), { code: 'AI_OUTPUT_INVALID' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(provider.generate({ bytes, type: 'audio/wav' }, { signal: controller.signal }), { code: 'AI_CANCELLED' });
});
test('prototype summary preserves supplied words and chat clearly identifies example responses', async () => {
  const {summaryProvider,chatProvider}=createPrototypeProviders();
  const result=await summaryProvider.generate({performed:'블록 고르기',response:'파란 블록을 골랐어요.'});
  assert.equal(summaryProvider.mode,'fixture');
  assert.equal(result.summary,'블록 고르기\n파란 블록을 골랐어요.');
  assert.match(result.reviewNotes[0],/시연 모드/);
  const response=await chatProvider.respond({messages:[{role:'user',content:'사진 첨부 방법'}]});
  assert.equal(chatProvider.mode,'fixture'); assert.match(response.text,/시연용 예시/); assert.match(response.text,/왼쪽 \+/);
  assert.deepEqual(response.usage,{inputTokens:0,outputTokens:0});
});
