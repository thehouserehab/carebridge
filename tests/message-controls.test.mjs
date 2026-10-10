import test from 'node:test';
import assert from 'node:assert/strict';
import {field, select} from '../src/ui.js';

test('message control names are explicitly bound to escaped label IDs, not saved content', () => {
  const text = field('수정할 소식', 'body', '<기존 내용>', {type: 'textarea', id: 'edit"body'});
  assert.match(text, /<span id="edit&quot;body-label">수정할 소식<\/span>/);
  assert.match(text, /<textarea id="edit&quot;body" aria-labelledby="edit&quot;body-label"/);
  assert.ok(text.includes('&lt;기존 내용&gt;</textarea>'));
  const scope = select('삭제 범위', 'scope', [['self', '나에게서만 삭제'], ['all', '모든 참여자에게서 삭제']], 'self', 'delete-scope');
  assert.match(scope, /<span id="delete-scope-label">삭제 범위<\/span>/);
  assert.match(scope, /<select id="delete-scope" aria-labelledby="delete-scope-label"/);
  assert.match(scope, /value="self" selected/);
  assert.equal(field('기존 입력', 'legacy').includes('aria-labelledby'), false);
  assert.equal(select('기존 선택', 'legacy', [['v', '항목']], 'v').includes('aria-labelledby'), false);
});
