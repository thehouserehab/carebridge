import { workspaceRoom, workspaceView } from './local-workspace-browser-helpers.mjs';

// Uses only the caller's owned synthetic page. No server, injected application
// state, forced actions, submitted messages or human timing measurements.
const failure = 'LOCAL_DESKTOP_CHAT_LAYOUT';
const longDraft = Array.from({ length: 12 }, (_, index) =>
  `${index + 1}. 가상 대화 작성 시험입니다. 화면의 글을 읽고 천천히 수정합니다. 실제 아동 정보가 아닙니다.`).join('\n') + '\n가상 마지막 줄';
const settle = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function geometry(page) {
  return page.evaluate(() => {
    const rectangle = element => {
      const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom,
        width: value.width, height: value.height };
    };
    const inspect = element => {
      if (!element) return null;
      const rect = rectangle(element), style = getComputedStyle(element);
      let inViewport = element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden'
        && rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
      for (let parent = element.parentElement; inViewport && parent; parent = parent.parentElement) {
        const clip = rectangle(parent), overflow = getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(overflow.overflowX))
          inViewport = rect.left >= clip.left - 1 && rect.right <= clip.right + 1;
        if (inViewport && /(auto|scroll|hidden|clip)/.test(overflow.overflowY))
          inViewport = rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1;
      }
      const owns = (x, y) => { const hit = document.elementFromPoint(x, y); return hit === element || element.contains(hit); };
      const x = Math.min(8, rect.width / 4), y = Math.min(8, rect.height / 4);
      return { rect, inViewport, centerUnobscured: inViewport && owns(rect.left + rect.width / 2, rect.top + rect.height / 2),
        cornersUnobscured: inViewport && [[rect.left + x, rect.top + y], [rect.right - x, rect.top + y],
          [rect.left + x, rect.bottom - y], [rect.right - x, rect.bottom - y]].every(point => owns(...point)),
        fontSize: Number.parseFloat(style.fontSize), lineHeight: Number.parseFloat(style.lineHeight),
        paddingTop: Number.parseFloat(style.paddingTop), paddingBottom: Number.parseFloat(style.paddingBottom),
        position: style.position, focused: document.activeElement === element, disabled: element.disabled === true,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    };
    const list = document.querySelector('[data-testid="message-list"]'), input = document.querySelector('.composer textarea');
    const listRect = rectangle(list), top = listRect.top + list.clientTop;
    const rows = [...list.querySelectorAll('[data-testid="message-row"][data-message-id]')];
    const anchor = rows.findIndex(node => node.getBoundingClientRect().bottom > top);
    return { viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth,
      outerScrollY: scrollY, bodyFontSize: Number.parseFloat(getComputedStyle(document.body).fontSize),
      nav: inspect(document.querySelector('.main-nav')),
      navigation: [...document.querySelectorAll('.main-nav button')].map(inspect),
      header: inspect(document.querySelector('.room-head')), messages: inspect(list),
      bubbleFontSizes: [...list.querySelectorAll('.bubble')].map(node => Number.parseFloat(getComputedStyle(node).fontSize)),
      composer: inspect(document.querySelector('.composer')), input: inspect(input), send: inspect(document.querySelector('.composer button[type="submit"]')),
      participants: inspect(document.querySelector('.room-participants > summary')),
      participantsOpen: document.querySelector('.room-participants')?.open === true,
      primaryOpen: document.querySelector('.primary-communicator-details')?.open === true,
      reading: { rowCount: rows.length, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight, scrollTop: list.scrollTop,
        bottomGap: Math.max(0, list.scrollHeight - list.scrollTop - list.clientHeight), anchor,
        offset: anchor < 0 ? null : rows[anchor].getBoundingClientRect().top - top },
      editing: { length: input.value.length, scrollTop: input.scrollTop, clientHeight: input.clientHeight, scrollHeight: input.scrollHeight,
        bottomGap: Math.max(0, input.scrollHeight - input.scrollTop - input.clientHeight),
        start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } };
  });
}

export async function verifyDesktopChatLayout({ page, roomId, capture, refreshWhileFocused }) {
  const originalViewport = page.viewportSize(), input = page.locator('.composer textarea');
  const participantDetails = page.locator('.room-participants'), primaryDetails = page.locator('.primary-communicator-details');
  let originalDraft, originalParticipants, originalPrimary, handle, stage = 'setup', latest = null, mainError = null;
  const evidence = [], initialWidths = [];
  const check = (condition, name) => {
    if (condition) return;
    const error = new Error(failure); error.desktopStage = `${stage}:${name}`; error.desktopGeometry = latest; throw error;
  };
  const observe = async label => {
    stage = label; await settle(page); latest = await geometry(page); evidence.push({ label, ...latest });
    check(latest.pageWidth <= latest.viewport.width + 1, 'page-overflow');
    check(latest.messages.scrollWidth <= latest.messages.clientWidth + 1, 'message-overflow');
    return latest;
  };
  const reachable = value => value?.inViewport && value.centerUnobscured && value.cornersUnobscured;
  const retainedReading = (before, after) => {
    check(before.rowCount === after.rowCount && before.rowCount > 0, 'reading-same-rows');
    if (before.bottomGap < 48) check(after.bottomGap < 48, 'reading-end-retained');
    else check(before.anchor === after.anchor && Math.abs(before.offset - after.offset) <= 3, 'reading-anchor-retained');
  };
  const setDisclosure = async (details, open) => {
    if (!await details.count() || (await details.getAttribute('open') !== null) === open) return;
    const summary = details.locator(':scope > summary'); await summary.focus(); await summary.press('Enter'); await settle(page);
    check((await details.getAttribute('open') !== null) === open, 'native-disclosure-state');
  };
  try {
    check(originalViewport && typeof capture === 'function' && typeof refreshWhileFocused === 'function', 'arguments');
    await input.waitFor(); originalDraft = await input.inputValue();
    originalParticipants = await participantDetails.getAttribute('open') !== null;
    originalPrimary = await primaryDetails.count() ? await primaryDetails.getAttribute('open') !== null : null;
    for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      const label = `desktop-chat-${viewport.width}x${viewport.height}`;
      stage = `${label}:navigation`;
      await page.setViewportSize(viewport);
      await workspaceView(page, 'home'); await workspaceRoom(page, roomId);
      const initial = await observe(`${label}:entry`);
      // Observe before any trial click, manual scroll or focused textarea can
      // rescue the layout. These are the actual explicit-entry positions.
      check(!initial.participantsOpen && !initial.primaryOpen, 'default-disclosures-closed');
      check(initial.reading.clientHeight >= 320 && initial.reading.scrollHeight > initial.reading.clientHeight, 'readable-history-space');
      check(initial.input.rect.height >= 96, 'writing-space');
      check(initial.bodyFontSize >= 16 && initial.input.fontSize >= 16 && initial.bubbleFontSizes.length > 0
        && initial.bubbleFontSizes.every(value => value >= 16), 'readable-text-size');
      check(initial.nav.position === 'sticky' && reachable(initial.nav)
        && initial.navigation.every(item => reachable(item) && item.rect.height >= 43.5), 'sticky-navigation-accessible');
      check(reachable(initial.header) && reachable(initial.messages) && reachable(initial.composer)
        && reachable(initial.input) && reachable(initial.send), 'entry-chat-and-composer-visible');
      check(await input.inputValue() === originalDraft, 'draft-retained-on-entry');
      initialWidths.push(initial.messages.rect.width); await capture(`${label}-entry`);

      if (viewport.width === 1366) {
        stage = `${label}:participants-open`;
        await setDisclosure(participantDetails, true);
        const opened = await observe(`${label}:participants-open`);
        check(opened.participantsOpen && opened.participants.focused && reachable(opened.participants), 'participants-keyboard-open');
        check(opened.reading.clientHeight >= 320, 'expanded-readable-space');
        retainedReading(initial.reading, opened.reading);
        check(await input.inputValue() === originalDraft, 'expanded-draft-retained');
        await capture(`${label}-participants-open`);
        await setDisclosure(participantDetails, false);
        const closed = await observe(`${label}:participants-closed`);
        retainedReading(opened.reading, closed.reading);
        check(!closed.participantsOpen && closed.participants.focused, 'participants-keyboard-close');
      }
      if (viewport.width === 1440) {
        stage = `${label}:long-draft`;
        await input.fill(longDraft); await input.press('Control+End');
        const edited = await observe(`${label}:long-draft-end`);
        check(reachable(edited.input) && edited.input.focused && edited.editing.scrollHeight > edited.editing.clientHeight, 'long-draft-accessible');
        const endAllowance = edited.input.paddingBottom + Math.max(0, (edited.input.lineHeight - edited.input.fontSize) / 2) + 1;
        check(Number.isFinite(endAllowance) && edited.editing.end === longDraft.length && edited.editing.start === longDraft.length
          && edited.editing.bottomGap <= endAllowance, 'last-line-accessible');
        await input.press('Shift+Home');
        const selected = await observe(`${label}:long-draft-selected`);
        check(selected.editing.start === longDraft.lastIndexOf('\n') + 1 && selected.editing.end === longDraft.length, 'native-selection');
        handle = await input.elementHandle(); check(handle, 'textarea-handle');
        await refreshWhileFocused();
        const refreshed = await observe(`${label}:focused-poll`);
        check(await handle.evaluate(node => node === document.querySelector('.composer textarea')), 'textarea-node-retained');
        check(reachable(refreshed.input) && refreshed.input.focused && await input.inputValue() === longDraft, 'focused-value-retained');
        check(refreshed.editing.start === selected.editing.start && refreshed.editing.end === selected.editing.end
          && refreshed.editing.direction === selected.editing.direction && Math.abs(refreshed.editing.scrollTop - selected.editing.scrollTop) <= 1,
        'native-selection-and-scroll-retained');
        check(Math.abs(refreshed.outerScrollY - selected.outerScrollY) <= 1, 'poll-does-not-scroll-page');
        retainedReading(selected.reading, refreshed.reading);
        await handle.dispose(); handle = null;
        await page.keyboard.press('Tab');
        const send = await observe(`${label}:send-keyboard-focus`);
        check(send.send.focused && !send.send.disabled && reachable(send.send), 'send-keyboard-accessible');
        check(await input.inputValue() === longDraft, 'draft-not-submitted');
        await capture(`${label}-long-draft-send-focus`);
        await input.fill(originalDraft);
      }
    }
    check(initialWidths[2] > initialWidths[0] + 1 && initialWidths[1] >= initialWidths[0], 'wide-screen-space-used');
  } catch (error) {
    mainError = error.desktopStage ? error : Object.assign(new Error(failure), { desktopStage: stage, desktopGeometry: latest });
    try { await capture(`desktop-chat-failure-${page.viewportSize()?.width ?? 0}`); } catch { /* Preserve sanitized failure. */ }
  } finally {
    try {
      if (handle) await handle.dispose();
      if (originalViewport) await page.setViewportSize(originalViewport);
      await workspaceRoom(page, roomId);
      if (originalDraft !== undefined) { await input.fill(originalDraft); check(await input.inputValue() === originalDraft, 'restore-draft'); }
      if (originalParticipants !== undefined) await setDisclosure(participantDetails, originalParticipants);
      if (originalPrimary !== null && originalPrimary !== undefined) await setDisclosure(primaryDetails, originalPrimary);
      await settle(page);
    } catch { mainError ??= Object.assign(new Error(failure), { desktopStage: 'restore', desktopGeometry: latest }); }
  }
  if (mainError) throw mainError;
  return { initialWidths, evidence, noMessageSubmitted: true };
}
