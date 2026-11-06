// Caller-owned native synthetic session only. All writes use visible controls.
// Existing worker-processed files are downloaded again; no media/DB doubles.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { workspaceRoom } from './local-workspace-browser-helpers.mjs';

const code = 'NATIVE_HISTORY_MEDIA_BROWSER_FAILED';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const uploadId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');

// Persist only identifiers/cursors/counts, never authored message contents.
export function nativeHistorySnapshot(payload) {
  assert(payload?.resetRequired === false && Array.isArray(payload.messages) &&
    payload.messages.length > 0 && payload.messages.length <= 100, code);
  const messages = payload.messages.map(message => {
    assert(validId(message?.id) && Number.isSafeInteger(message.sequence) && message.sequence > 0, code);
    return { id: message.id, sequence: message.sequence };
  });
  assert(new Set(messages.map(message => message.id)).size === messages.length, code);
  assert(messages.every((message, index) => index === 0 || message.sequence > messages[index - 1].sequence), code);
  const window = payload.window;
  assert(window && typeof window.hasOlder === 'boolean' && typeof window.hasNewer === 'boolean' &&
    window.startCursor === messages[0].sequence && window.endCursor === messages.at(-1).sequence, code);
  return { messages, count: messages.length, start: window.startCursor, end: window.endCursor,
    hasOlder: window.hasOlder, hasNewer: window.hasNewer };
}

export function assertNativeHistoryContent(expected, observed, bytes) {
  assert(validId(expected?.messageId) && uploadId(expected.uploadId) &&
    ['image/png', 'video/mp4', 'video/webm'].includes(expected.type) &&
    Number.isSafeInteger(expected.size) && expected.size > 0 && expected.size <= 50 * 1024 ** 2 &&
    /^[a-f0-9]{64}$/.test(expected.sha256), code);
  assert(Buffer.isBuffer(bytes) && bytes.length === expected.size, code);
  for (const key of ['messageId', 'uploadId', 'type', 'size']) assert.equal(observed?.[key], expected[key], code);
  assert.equal(sha(bytes), expected.sha256, code);
  return { messageId: expected.messageId, uploadId: expected.uploadId,
    type: expected.type, size: expected.size, sha256: expected.sha256 };
}

export async function exerciseNativeHistoryMediaBrowser({ origin, centerId, conversationId, guardian, therapist,
  deliveries, expectedContent, capture, onPhase } = {}) {
  const report = { passed: false, phase: 'CONFIGURATION', uiMessages: 0, checks: {
    latestBoundaryPinned: false, previousWindowFiles: false, delayedSendPreservesViewer: false,
    exactStoredMessage: false, explicitLatest: false,
  }, latestBoundary: null, widths: [], contentEvidence: [], maxDomRows: 0,
  humanMetricsCollected: false, failure: null,
  limitations: ['Real native processed files and 105 sequential UI text sends in the caller-owned synthetic session.',
    '320/390/1440 CSS pixels in Chrome; not a physical device or human usability measurement.',
    'Only successful message responses are briefly delayed; no endpoint, body, permission or stored result is replaced.',
    'DOM row bounds are measured at the named checkpoints, not every animation frame.'] };
  const phase = value => { report.phase = value; onPhase(value); };
  try {
    const url = new URL(origin);
    assert(url.origin === origin && url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
      Number(url.port) >= 1024 && Number(url.port) <= 65535 && !url.username && !url.password && !url.search && !url.hash &&
      validId(centerId) && validId(conversationId) && guardian?.page && therapist?.page && guardian.page !== therapist.page &&
      typeof capture === 'function' && typeof onPhase === 'function', code);
    assert(Array.isArray(deliveries) && deliveries.length === 2 && Array.isArray(expectedContent), code);
    const files = deliveries.map(delivery => {
      assert(validId(delivery.messageId) && uploadId(delivery.uploadId), code);
      const candidate = expectedContent.find(item => item.messageId === delivery.messageId && item.uploadId === delivery.uploadId);
      assert(candidate && candidate.type === delivery.type, code);
      return { ...candidate };
    });
    assert(files[0].type === 'image/png' && ['video/mp4', 'video/webm'].includes(files[1].type) &&
      files[0].messageId !== files[1].messageId && files[0].uploadId !== files[1].uploadId, code);
    const base = `${origin}/api/local/centers/${centerId}/conversations/${conversationId}`;
    const messagePath = `${base}/messages`;
    const rows = who => who.page.getByTestId('message-row');
    const fileButton = (who, file) => who.page.locator(`[data-testid="message-row"][data-message-id="${file.messageId}"]`)
      .locator(`[data-open-attachment="${file.uploadId}"][data-message-id="${file.messageId}"]`);
    const viewer = who => who.page.getByTestId('media-viewer');
    const history = action => therapist.page.locator(`button[data-action="history-${action}"]`);
    const response = (who, suffix, method, status) => who.page.waitForResponse(value =>
      value.url() === base + suffix && value.request().method() === method && value.status() === status);
    const timeline = (who, selector, predicate = () => true) => {
      // A response already in flight when this observation starts cannot prove
      // that the app has re-read a later commit. Match new real requests only.
      const requested = new WeakSet(), observe = request => requested.add(request);
      who.page.on('request', observe);
      return who.page.waitForResponse(async value => {
      const target = new URL(value.url());
      if (!requested.has(value.request()) || `${target.origin}${target.pathname}` !== messagePath || value.request().method() !== 'GET' || value.status() !== 200 ||
        target.searchParams.get('view') !== 'timeline') return false;
      for (const key of ['from', 'before', 'after', 'around']) {
        if (selector[key] === undefined ? target.searchParams.has(key) : target.searchParams.get(key) !== String(selector[key])) return false;
      }
      const payload = await value.json();
      if (payload.resetRequired) return false;
      return predicate(nativeHistorySnapshot(payload));
      }).then(async value => nativeHistorySnapshot(await value.json())).finally(() => who.page.off('request', observe));
    };
    const dom = async (who, expected) => {
      await who.page.waitForFunction(messages => {
        const rows = [...document.querySelectorAll('[data-testid="message-row"]')];
        return rows.length === messages.length && rows.every((row, index) =>
          row.dataset.messageId === messages[index].id && Number(row.dataset.sequence) === messages[index].sequence);
      }, expected.messages);
      const count = await rows(who).count(); assert(count > 0 && count <= 100, code);
      report.maxDomRows = Math.max(report.maxDomRows, count);
    };
    const send = async (who, body) => {
      await who.page.getByLabel('메시지', { exact: true }).fill(body);
      const [sent] = await Promise.all([response(who, '/messages', 'POST', 201),
        who.page.getByRole('button', { name: '보내기', exact: true }).click()]);
      const message = (await sent.json()).message;
      assert(validId(message?.id) && Number.isSafeInteger(message.sequence) && message.body === body &&
        message.type === 'text' && message.attachments?.length === 0, code);
      await who.page.locator(`[data-testid="message-row"][data-message-id="${message.id}"]`).waitFor();
      await who.page.waitForFunction(() => document.querySelector('#message')?.value === '' &&
        document.querySelector('#message')?.readOnly === false);
      report.uiMessages++;
      return { id: message.id, sequence: message.sequence };
    };
    const contentResponse = (who, file) => response(who,
      `/messages/${file.messageId}/attachments/${file.uploadId}/content`, 'GET', 200);
    const decode = async (who, file, content) => {
      const bytes = await content.body();
      try {
        const headers = content.headers();
        report.contentEvidence.push(assertNativeHistoryContent(file, { messageId: file.messageId,
          uploadId: file.uploadId, type: headers['content-type'], size: Number(headers['content-length']) }, bytes));
      } finally { bytes.fill(0); }
      await viewer(who).waitFor();
      if (file.type === 'image/png') {
        await who.page.waitForFunction(() => {
          const image = document.querySelector('[data-media-viewer-content] img');
          return image?.complete && image.naturalWidth > 0;
        });
        assert(await viewer(who).locator('img').evaluate(async image => {
          await image.decode(); return image.naturalWidth > 0 && image.currentSrc.startsWith('blob:');
        }), code);
      } else {
        await who.page.waitForFunction(() => {
          const video = document.querySelector('[data-media-viewer-content] video');
          return video?.readyState >= 1 && video.videoWidth > 0;
        });
        const video = viewer(who).locator('video'); assert.equal(await video.evaluate(node => node.autoplay), false, code);
        await video.focus(); await video.press('Space');
        await who.page.waitForFunction(() => {
          const video = document.querySelector('[data-media-viewer-content] video');
          return video && !video.error && video.currentTime > 0 && (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0) > 0;
        });
      }
    };
    const open = async (who, file) => {
      const [content] = await Promise.all([contentResponse(who, file), fileButton(who, file).click()]);
      await decode(who, file, content);
    };
    const close = async (who, file) => {
      const control = viewer(who).locator('[data-media-viewer-close]'); await control.focus(); await control.press('Enter');
      await viewer(who).waitFor({ state: 'detached' });
      assert.equal(await fileButton(who, file).evaluate(node => node === document.activeElement), true, code);
    };
    const loadLatest = async (who, predicate = () => true) => {
      // Reload is a user action and intentionally resets the per-page cursor.
      await who.page.reload(); await who.page.getByTestId('home').waitFor();
      const [snapshot] = await Promise.all([timeline(who, {}, predicate), workspaceRoom(who.page, conversationId)]);
      await dom(who, snapshot); return snapshot;
    };
    phase('HISTORY_MEDIA_UI_SEED_98');
    await workspaceRoom(guardian.page, conversationId);
    await guardian.page.setViewportSize({ width: 390, height: 900 });
    for (let index = 1; index <= 98; index++) await send(guardian, `가상 이력 첨부 확인 ${index}: 실제 사람 정보가 없는 시험 소식입니다.`);
    phase('HISTORY_MEDIA_LATEST_BOUNDARY');
    await therapist.page.setViewportSize({ width: 1440, height: 900 });
    const latest = await loadLatest(therapist, snapshot => snapshot.count === 100 &&
      snapshot.messages[0].id === files[0].messageId && snapshot.messages[1].id === files[1].messageId);
    await open(therapist, files[0]);
    const incoming = await send(guardian, '가상 이력 첨부 확인 99: 첨부를 보는 동안 도착하는 소식입니다.');
    const pinned = await timeline(therapist, { from: latest.start }, snapshot => snapshot.hasNewer === true);
    await dom(therapist, pinned); assert.deepEqual(pinned.messages, latest.messages, code);
    assert.equal(await viewer(therapist).isVisible(), true, code);
    assert.equal(await viewer(therapist).locator('img').evaluate(image => image.complete && image.naturalWidth > 0), true, code);
    await capture(therapist, '1440-history-latest-boundary-pinned');
    await close(therapist, files[0]);
    const [afterIncoming] = await Promise.all([timeline(therapist, {}, snapshot => snapshot.messages.at(-1).id === incoming.id), history('latest').click()]);
    await dom(therapist, afterIncoming); assert(!afterIncoming.messages.some(message => message.id === files[0].messageId), code);
    report.latestBoundary = { before: { start: latest.start, end: latest.end, count: latest.count },
      pinned: { start: pinned.start, end: pinned.end, count: pinned.count }, incomingSequence: incoming.sequence,
      afterExplicitLatest: { start: afterIncoming.start, end: afterIncoming.end, count: afterIncoming.count } };
    report.checks.latestBoundaryPinned = true;
    phase('HISTORY_MEDIA_UI_SEED_105');
    for (let index = 100; index <= 105; index++) await send(guardian, `가상 이력 첨부 확인 ${index}: 이전 소식 탐색을 위한 시험 소식입니다.`);

    for (const width of [320, 390, 1440]) {
      phase(`HISTORY_MEDIA_${width}_PREVIOUS_WINDOW`);
      await therapist.page.setViewportSize({ width, height: 900 });
      const recent = await loadLatest(therapist);
      assert(recent.count === 100 && files.every(file => !recent.messages.some(message => message.id === file.messageId)), code);
      const [older] = await Promise.all([timeline(therapist, { before: recent.start }), history('older').click()]);
      await dom(therapist, older);
      // A short exclusive-before page is stabilized by the app's normal from
      // poll. Observe that actual bounded response before measuring a race.
      const stable = await timeline(therapist, { from: older.start }, snapshot => snapshot.count === 100);
      await dom(therapist, stable);
      assert(files.every(file => stable.messages.some(message => message.id === file.messageId)), code);
      const result = { width, start: stable.start, end: stable.end, count: stable.count,
        photo: false, video: false, delayedSend: false, exactReceipt: false, explicitLatest: false };
      report.widths.push(result);
      for (const [index, file] of files.entries()) {
        await open(therapist, file);
        await capture(therapist, `${width}-history-${index === 0 ? 'photo' : 'video'}`);
        await close(therapist, file); await dom(therapist, stable);
        result[index === 0 ? 'photo' : 'video'] = true;
      }
      phase(`HISTORY_MEDIA_${width}_DELAYED_SEND`);
      const body = `가상 ${width} 화면: 과거 첨부를 여는 동안 완료되는 전송입니다.`;
      let release, committed, intercepted = false, heldResponse, sentMessage;
      let delayExpired = false, holdTimer, readyTimer;
      const gate = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { committed = resolve; });
      const tasks = [];
      const match = target => `${target.origin}${target.pathname}` === messagePath;
      const handler = route => {
        if (intercepted || route.request().method() !== 'POST') return route.fallback();
        intercepted = true;
        const task = (async () => {
          try {
            heldResponse = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
            assert.equal(heldResponse.status(), 201, code);
            sentMessage = (await heldResponse.json()).message;
            assert(validId(sentMessage?.id) && sentMessage.body === body && sentMessage.attachments?.length === 0, code);
            // Release the real response if a browser action stalls; the test
            // still fails rather than silently testing the opposite ordering.
            holdTimer = setTimeout(() => { delayExpired = true; release(); }, 7000);
            committed(); await gate; clearTimeout(holdTimer);
            await route.fulfill({ response: heldResponse });
          } catch {
            committed(); await route.abort('failed').catch(() => {}); throw new Error(code);
          } finally { await heldResponse?.dispose(); }
        })(); tasks.push(task); void task.catch(() => {}); return task;
      };
      await therapist.page.route(match, handler);
      try {
        await therapist.page.getByLabel('메시지', { exact: true }).fill(body);
        const readyDeadline = new Promise((resolve, reject) => {
          readyTimer = setTimeout(() => reject(new Error(code)), 15_000);
          ready.then(resolve);
        });
        await Promise.all([readyDeadline, therapist.page.getByRole('button', { name: '보내기', exact: true }).click()]);
        clearTimeout(readyTimer);
        assert(intercepted && sentMessage && !delayExpired, code);
        const media = contentResponse(therapist, files[0]); void media.catch(() => {});
        await fileButton(therapist, files[0]).click(); await viewer(therapist).waitFor();
        // The dialog is visible after pinHistoryForMedia. Do not keep the
        // message response held while image decoding or polling completes.
        release(); await Promise.all(tasks); assert.equal(delayExpired, false, code);
        await decode(therapist, files[0], await media);
        await therapist.page.waitForFunction(() => document.querySelector('#message')?.value === '' &&
          document.querySelector('#message')?.readOnly === false);
        const after = await timeline(therapist, { from: stable.start }); await dom(therapist, after);
        assert.deepEqual(after.messages, stable.messages, code);
        assert.equal(await viewer(therapist).isVisible(), true, code);
        assert.equal(await viewer(therapist).locator('img').evaluate(image => image.complete && image.naturalWidth > 0), true, code);
        await capture(therapist, `${width}-history-viewer-after-delayed-send`);
        await close(therapist, files[0]); await dom(therapist, stable);
        result.delayedSend = true; result.delayedResponse = { status: 201, messageId: sentMessage.id,
          sequence: sentMessage.sequence, delivered: true, deadlineExpired: delayExpired };
        const [end] = await Promise.all([timeline(therapist, {}, snapshot => snapshot.messages.at(-1).id === sentMessage.id), history('latest').click()]);
        await dom(therapist, end);
        assert.equal(end.messages.filter(message => message.id === sentMessage.id).length, 1, code);
        const actual = await therapist.context.request.get(`${messagePath}/${sentMessage.id}`, {
          maxRedirects: 0, timeout: 15_000, headers: { 'X-Carebridge-Account': therapist.userId } });
        try {
          assert.equal(actual.status(), 200, code); const message = (await actual.json()).message;
          assert(message.id === sentMessage.id && message.sequence === sentMessage.sequence && message.body === body &&
            message.attachments?.length === 0, code);
        } finally { await actual.dispose(); }
        result.exactReceipt = true; result.explicitLatest = true;
      } finally {
        clearTimeout(readyTimer); clearTimeout(holdTimer); release(); await Promise.allSettled(tasks);
        await therapist.page.unroute(match, handler);
      }
    }
    report.checks.previousWindowFiles = report.widths.every(result => result.photo && result.video);
    report.checks.delayedSendPreservesViewer = report.widths.every(result => result.delayedSend);
    report.checks.exactStoredMessage = report.widths.every(result => result.exactReceipt);
    report.checks.explicitLatest = report.widths.every(result => result.explicitLatest);
    assert(report.uiMessages === 105 && report.widths.length === 3 && Object.values(report.checks).every(Boolean), code);
    phase('HISTORY_MEDIA_COMPLETE'); report.passed = true; return report;
  } catch (error) {
    report.failure = { phase: report.phase, category: error?.name === 'AssertionError' ? 'assertion' : 'runtime-or-timeout' };
    const safe = new Error(code); Object.defineProperty(safe, 'historyMediaObservation', { value: report, enumerable: true }); throw safe;
  }
}
