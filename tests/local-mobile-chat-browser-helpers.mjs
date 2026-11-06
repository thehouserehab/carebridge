import { workspaceRoom, workspaceView } from './local-workspace-browser-helpers.mjs';

// An owned synthetic page only: native navigation, wheel and keyboard input.
// No application-state injection, message submission or human timing claims.
const failure = 'LOCAL_MOBILE_CHAT_LAYOUT';
const longDraft = Array.from({ length: 12 }, (_, index) =>
  `${index + 1}. 가상 대화 작성 시험입니다. 이전 내용을 읽으며 수정합니다. 실제 아동 정보가 아닙니다.`).join('\n') + '\n가상 마지막 줄';
const settle = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function geometry(page) {
  return page.evaluate(() => {
    const rectangle = element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height };
    };
    const inspect = element => {
      if (!element) return null;
      const rect = rectangle(element), style = getComputedStyle(element);
      let visible = element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden'
        && rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
      for (let parent = element.parentElement; visible && parent; parent = parent.parentElement) {
        const clip = rectangle(parent), overflow = getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(overflow.overflowX))
          visible = rect.left >= clip.left - 1 && rect.right <= clip.right + 1;
        if (visible && /(auto|scroll|hidden|clip)/.test(overflow.overflowY))
          visible = rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1;
      }
      const owns = (x, y) => { const hit = document.elementFromPoint(x, y); return hit === element || element.contains(hit); };
      const dx = Math.min(6, rect.width / 4), dy = Math.min(6, rect.height / 4);
      return { rect, visible, unobscured: visible && [[rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + dx, rect.top + dy], [rect.right - dx, rect.bottom - dy]].every(point => owns(...point)),
        position: style.position, focused: document.activeElement === element, disabled: element.disabled === true,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    };
    const list = document.querySelector('[data-testid="message-list"]'), input = document.querySelector('.composer textarea');
    return { viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth,
      outerScrollY: scrollY, nav: inspect(document.querySelector('.main-nav')),
      header: inspect(document.querySelector('.room-head')), room: inspect(document.querySelector('[data-testid="room"]')),
      messages: inspect(list), composer: inspect(document.querySelector('.composer')), input: inspect(input),
      send: inspect(document.querySelector('.composer button[type="submit"]')),
      newRecord: inspect(document.querySelector('[data-chat-care] [data-care-action="new-record"]')),
      mediaSummary: inspect(document.querySelector('[data-chat-media] [data-media-details]:not([open]) > summary')),
      primarySummary: inspect(document.querySelector('[data-primary-communicator] .primary-communicator-details:not([open]) > summary')),
      reading: { clientHeight: list.clientHeight, scrollHeight: list.scrollHeight, scrollTop: list.scrollTop,
        rowCount: list.querySelectorAll('[data-testid="message-row"]').length },
      editing: { length: input.value.length, start: input.selectionStart, end: input.selectionEnd,
        direction: input.selectionDirection, scrollTop: input.scrollTop } };
  });
}

export async function verifyMobileChatLayout({ page, roomId, capture, refreshWhileFocused }) {
  const originalViewport = page.viewportSize(), input = page.locator('.composer textarea');
  const participantDetails = page.locator('.room-participants'), primaryDetails = page.locator('.primary-communicator-details');
  let originalDraft, originalParticipants, originalPrimary, handle, stage = 'setup', latest = null, mainError = null;
  const evidence = [];
  const check = (condition, name) => {
    if (condition) return;
    throw Object.assign(new Error(failure), { mobileStage: `${stage}:${name}`, mobileGeometry: latest });
  };
  const observe = async label => {
    stage = label; await settle(page); latest = await geometry(page); evidence.push({ label, ...latest });
    check(latest.pageWidth <= latest.viewport.width + 1, 'page-overflow');
    check(latest.messages.scrollWidth <= latest.messages.clientWidth + 1, 'message-overflow');
    return latest;
  };
  const reachable = element => element?.visible && element.unobscured;
  const fits = value => {
    check(value.nav.position === 'fixed' && reachable(value.nav), 'bottom-navigation-visible');
    check(reachable(value.header) && reachable(value.messages) && reachable(value.composer)
      && reachable(value.input) && reachable(value.send), 'header-history-composer-visible');
    check(value.reading.clientHeight >= 44 && value.reading.scrollHeight > value.reading.clientHeight, 'history-scroll-space');
    check(value.header.rect.top >= -1 && value.composer.rect.bottom <= value.nav.rect.top + 1
      && value.send.rect.bottom <= value.nav.rect.top + 1, 'composer-above-navigation');
    check(value.send.rect.height >= 43.5, 'send-touch-target');
  };
  const stableFrame = (before, after) => {
    check(Math.abs(before.outerScrollY - after.outerScrollY) <= 1, 'outer-page-stable');
    check(Math.abs(before.composer.rect.top - after.composer.rect.top) <= 1
      && Math.abs(before.composer.rect.bottom - after.composer.rect.bottom) <= 1
      && Math.abs(before.header.rect.top - after.header.rect.top) <= 1, 'header-composer-stable');
  };
  const initialControls = value => {
    // Guardian pages intentionally have no therapist record action. A present
    // control must still be fully visible through its scroll-container clip;
    // a clickable center alone would miss a cut-off lower edge.
    for (const [name, control] of [['new-record', value.newRecord], ['media-summary', value.mediaSummary],
      ['primary-summary', value.primarySummary]]) {
      if (!control) continue;
      check(reachable(control), `${name}-fully-accessible`);
      check(control.rect.height >= 43.5 && control.rect.width >= 43.5, `${name}-touch-target`);
    }
  };
  const setDisclosure = async (details, open) => {
    if (!await details.count() || (await details.getAttribute('open') !== null) === open) return;
    const summary = details.locator(':scope > summary'); await summary.focus(); await summary.press('Enter'); await settle(page);
    check((await details.getAttribute('open') !== null) === open, 'disclosure-restored');
  };
  try {
    check(originalViewport && typeof capture === 'function' && typeof refreshWhileFocused === 'function', 'arguments');
    await input.waitFor(); originalDraft = await input.inputValue();
    originalParticipants = await participantDetails.getAttribute('open') !== null;
    originalPrimary = await primaryDetails.count() ? await primaryDetails.getAttribute('open') !== null : null;
    for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 390, height: 420 }]) {
      const label = `mobile-chat-${viewport.width}x${viewport.height}`;
      stage = `${label}:navigation`;
      await page.setViewportSize(viewport);
      await workspaceView(page, 'home'); await workspaceRoom(page, roomId);
      // Observe before focus, trial clicks or manual scrolling can make an
      // overflowing page appear usable by bringing its composer into view.
      const initial = await observe(`${label}:entry`); fits(initial); initialControls(initial);
      check(await input.inputValue() === originalDraft, 'entry-draft-retained');
      await capture(`${label}-entry`);

      stage = `${label}:wheel`;
      const delta = Math.min(160, Math.max(60, initial.reading.clientHeight / 2))
        * (initial.reading.scrollTop > 40 ? -1 : 1);
      await page.mouse.move(initial.messages.rect.left + initial.messages.rect.width / 2,
        initial.messages.rect.top + initial.messages.rect.height / 2);
      await page.mouse.wheel(0, delta);
      await page.waitForFunction(before => {
        const list = document.querySelector('[data-testid="message-list"]');
        return list && Math.abs(list.scrollTop - before) > 1;
      }, initial.reading.scrollTop, { timeout: 5_000 });
      const scrolled = await observe(`${label}:history-wheel`); fits(scrolled); stableFrame(initial, scrolled);
      check(scrolled.reading.rowCount === initial.reading.rowCount, 'history-rows-retained');
      await capture(`${label}-history-wheel`);

      stage = `${label}:draft`;
      await input.fill(longDraft); await input.press('Control+End'); await input.press('Shift+Home');
      const selected = await observe(`${label}:selected-draft`); fits(selected);
      check(selected.input.focused && selected.editing.start === longDraft.lastIndexOf('\n') + 1
        && selected.editing.end === longDraft.length, 'native-selection');
      handle = await input.elementHandle(); check(handle, 'textarea-handle');
      await refreshWhileFocused();
      const refreshed = await observe(`${label}:focused-poll`); fits(refreshed); stableFrame(selected, refreshed);
      check(await handle.evaluate(node => node === document.querySelector('.composer textarea')), 'textarea-node-retained');
      check(refreshed.input.focused && await input.inputValue() === longDraft, 'draft-and-focus-retained');
      check(refreshed.editing.start === selected.editing.start && refreshed.editing.end === selected.editing.end
        && refreshed.editing.direction === selected.editing.direction
        && Math.abs(refreshed.editing.scrollTop - selected.editing.scrollTop) <= 1, 'selection-and-input-scroll-retained');
      await handle.dispose(); handle = null;
      await page.keyboard.press('Tab');
      const send = await observe(`${label}:send-focus`); fits(send);
      check(send.send.focused && !send.send.disabled && await input.inputValue() === longDraft, 'send-accessible-without-submission');
      await capture(`${label}-draft-poll-send-focus`);
      await input.fill(originalDraft);
    }

    stage = 'mobile-chat-resize:desktop-navigation';
    await page.setViewportSize({ width: 1440, height: 900 });
    await workspaceView(page, 'home'); await workspaceRoom(page, roomId);
    await settle(page);
    await page.setViewportSize({ width: 390, height: 844 });
    // Deliberately no navigation, focus or corrective scrolling after resize.
    const resized = await observe('mobile-chat-resize:already-open'); fits(resized); initialControls(resized);
    check(await input.inputValue() === originalDraft, 'resize-draft-retained');
    await capture('mobile-chat-resize-already-open');
  } catch (error) {
    mainError = error.mobileStage ? error : Object.assign(new Error(failure), { mobileStage: stage, mobileGeometry: latest });
    try { await capture(`mobile-chat-failure-${page.viewportSize()?.width ?? 0}`); } catch { /* Preserve sanitized failure. */ }
  } finally {
    try {
      if (handle) await handle.dispose();
      if (originalViewport) await page.setViewportSize(originalViewport);
      await workspaceRoom(page, roomId);
      if (originalDraft !== undefined) { await input.fill(originalDraft); check(await input.inputValue() === originalDraft, 'restore-draft'); }
      if (originalParticipants !== undefined) await setDisclosure(participantDetails, originalParticipants);
      if (originalPrimary !== null && originalPrimary !== undefined) await setDisclosure(primaryDetails, originalPrimary);
      await settle(page);
    } catch { mainError ??= Object.assign(new Error(failure), { mobileStage: 'restore', mobileGeometry: latest }); }
  }
  if (mainError) throw mainError;
  return { evidence, noMessageSubmitted: true, physicalKeyboardVerified: false };
}
