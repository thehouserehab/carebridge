// Exercise the real synthetic chat textarea. The caller owns its server, page,
// authenticated refresh observation and masked screenshots. No message is sent.
const failure = 'LOCAL_COMPOSER_EDITING';
const draft = Array.from({ length: 12 }, (_, index) =>
  `${index + 1}번째 가상 편집 확인 🌱 움직임을 보고 천천히 기다렸어요. 이 문장은 실제 아동 정보가 없는 긴 입력과 줄바꿈 시험용 문장입니다.`).join('\n') + '\n가상 끝줄';
const replacement = '수정한 가상 마지막 줄';
const settleLayout = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function geometry(page) {
  return page.evaluate(() => {
    const input = document.querySelector('.composer textarea');
    const send = document.querySelector('.composer button[type="submit"]');
    const rectangle = element => {
      const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom,
        width: value.width, height: value.height };
    };
    const inspect = element => {
      if (!element) return null;
      const rect = rectangle(element), style = getComputedStyle(element);
      let visible = element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden'
        && rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
      for (let parent = element.parentElement; visible && parent; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent), clip = rectangle(parent);
        if (/(auto|scroll|hidden|clip)/.test(overflow.overflowX))
          visible = rect.left >= clip.left - 1 && rect.right <= clip.right + 1;
        if (visible && /(auto|scroll|hidden|clip)/.test(overflow.overflowY))
          visible = rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1;
      }
      const ownsPoint = (x, y) => {
        const hit = document.elementFromPoint(x, y); return hit === element || element.contains(hit);
      };
      const insetX = Math.min(8, rect.width / 4), insetY = Math.min(8, rect.height / 4);
      return { rect, visible, focused: document.activeElement === element, disabled: element.disabled === true,
        centerUnobscured: visible && ownsPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
        cornersUnobscured: visible && [[rect.left + insetX, rect.top + insetY], [rect.right - insetX, rect.top + insetY],
          [rect.left + insetX, rect.bottom - insetY], [rect.right - insetX, rect.bottom - insetY]]
          .every(([x, y]) => ownsPoint(x, y)),
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    };
    const style = input ? getComputedStyle(input) : null;
    return { viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth,
      input: inspect(input), send: inspect(send),
      editing: input ? { length: input.value.length, lineCount: input.value.split('\n').length,
        selectionStart: input.selectionStart, selectionEnd: input.selectionEnd,
        backwards: input.selectionDirection === 'backward', scrollTop: input.scrollTop,
        clientHeight: input.clientHeight, scrollHeight: input.scrollHeight,
        bottomGap: Math.max(0, input.scrollHeight - input.scrollTop - input.clientHeight),
        paddingTop: Number.parseFloat(style.paddingTop), paddingBottom: Number.parseFloat(style.paddingBottom),
        fontSize: Number.parseFloat(style.fontSize), lineHeight: Number.parseFloat(style.lineHeight) } : null };
  });
}

export async function verifyComposerEditing({ page, capture, refreshWhileFocused }) {
  const input = page.locator('.composer textarea'), originalViewport = page.viewportSize();
  let originalDraft = null, stage = 'initial', latest = null, handle = null, mainError = null;
  const evidence = [];
  const check = (condition, name) => {
    if (condition) return;
    const error = new Error(failure); error.composerStage = `${stage}:${name}`; error.composerGeometry = latest;
    throw error;
  };
  const observe = async (label, expected) => {
    stage = label; await settleLayout(page); latest = await geometry(page);
    check(latest.input && latest.editing, 'textarea-present');
    check(latest.pageWidth <= latest.viewport.width + 1
      && latest.input.scrollWidth <= latest.input.clientWidth + 1, 'horizontal-overflow');
    check(await input.inputValue() === expected, 'exact-value');
    evidence.push({ label, ...latest }); return latest;
  };
  const focusedInput = value => check(value.input.focused && value.input.visible
    && value.input.centerUnobscured && value.input.cornersUnobscured && !value.input.disabled, 'focused-input-accessible');
  try {
    check(originalViewport && typeof capture === 'function' && typeof refreshWhileFocused === 'function', 'arguments');
    check(draft.length < 2000 && draft.split('\n').length >= 10, 'synthetic-fixture');
    await input.waitFor({ state: 'visible' }); originalDraft = await input.inputValue();
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
      const label = `composer-${viewport.width}x${viewport.height}`; stage = `${label}:setup`;
      await page.setViewportSize(viewport); await input.scrollIntoViewIfNeeded(); await input.fill(draft);
      await input.press('Control+Home');
      const first = await observe(`${label}:first`, draft); focusedInput(first);
      // Native caret scrolling can consume padding and empty half-leading.
      // The first-line screenshot checks actual glyph visibility; zero scroll
      // is not the accessibility contract of a padded native textarea.
      const halfLeading = Math.max(0, (first.editing.lineHeight - first.editing.fontSize) / 2);
      const firstGapAllowance = first.editing.paddingTop + halfLeading + 1;
      check(Number.isFinite(firstGapAllowance) && first.editing.selectionStart === 0
        && first.editing.selectionEnd === 0 && first.editing.scrollTop <= firstGapAllowance,
        'first-caret-and-scroll');
      check(first.editing.scrollHeight > first.editing.clientHeight, 'long-text-scrollable');
      evidence.push({ label: `${label}:first-scroll-tolerance`, paddingTop: first.editing.paddingTop,
        halfLeading, firstGapAllowance });
      await capture(`${label}-first`);

      await input.press('Control+End');
      const end = await observe(`${label}:end`, draft); focusedInput(end);
      check(end.editing.selectionStart === draft.length && end.editing.selectionEnd === draft.length, 'last-caret');
      // Use the same padding/half-leading rule at the end, rather than allow
      // an entire extra text line to be outside the textarea's visible area.
      const endGapAllowance = end.editing.paddingBottom + halfLeading + 1;
      check(Number.isFinite(endGapAllowance) && end.editing.scrollTop > 0
        && end.editing.bottomGap <= endGapAllowance, 'last-line-scroll');
      evidence.push({ label: `${label}:end-scroll-tolerance`, paddingBottom: end.editing.paddingBottom,
        halfLeading, endGapAllowance });
      await capture(`${label}-end`);

      await input.press('Shift+Home');
      const selected = await observe(`${label}:selection`, draft); focusedInput(selected);
      const { selectionStart: start, selectionEnd: finish } = selected.editing;
      // The final marker is deliberately short at 320px: Home can otherwise
      // mean the start of a wrapped visual line, not the logical final line.
      check(start === draft.lastIndexOf('\n') + 1 && start < finish && finish === draft.length, 'last-line-selection-bounds');
      // Native selection offsets use UTF-16. Do not accept a split emoji pair.
      check(!(draft.charCodeAt(start) >= 0xDC00 && draft.charCodeAt(start) <= 0xDFFF), 'selection-code-point-boundary');
      await capture(`${label}-selection`);
      handle = await input.elementHandle(); check(handle, 'original-textarea-node');
      stage = `${label}:authorized-refresh`; await refreshWhileFocused();
      const refreshed = await observe(`${label}:after-refresh`, draft); focusedInput(refreshed);
      check(await handle.evaluate(element => element === document.querySelector('.composer textarea')), 'textarea-node-preserved');
      check(refreshed.editing.selectionStart === start && refreshed.editing.selectionEnd === finish
        && refreshed.editing.backwards === selected.editing.backwards, 'selection-preserved');
      check(Math.abs(refreshed.editing.scrollTop - selected.editing.scrollTop) <= 1, 'internal-scroll-preserved');
      await handle.dispose(); handle = null;

      stage = `${label}:replace-selection`; await page.keyboard.insertText(replacement);
      const modifiedDraft = draft.slice(0, start) + replacement + draft.slice(finish);
      const modified = await observe(`${label}:modified`, modifiedDraft); focusedInput(modified);
      check(modified.editing.selectionStart === start + replacement.length
        && modified.editing.selectionEnd === start + replacement.length, 'replacement-caret');
      await input.press('Control+A');
      const all = await observe(`${label}:select-all`, modifiedDraft); focusedInput(all);
      check(all.editing.selectionStart === 0 && all.editing.selectionEnd === modifiedDraft.length, 'native-select-all');
      await page.keyboard.press('Tab');
      const sentFocus = await observe(`${label}:send-focus`, modifiedDraft);
      check(sentFocus.send?.focused && !sentFocus.send.disabled && sentFocus.send.rect.height >= 43.5
        && sentFocus.send.centerUnobscured && sentFocus.send.cornersUnobscured, 'send-focus-not-obscured');
      await capture(`${label}-edited-send-focus`);
    }
  } catch (error) {
    mainError = error;
    if (!error.composerStage) {
      mainError = new Error(failure); mainError.composerStage = stage; mainError.composerGeometry = latest;
    }
    try {
      const viewport = page.viewportSize();
      if (viewport && typeof capture === 'function') await capture(`composer-failure-${viewport.width}x${viewport.height}`);
    } catch { /* A screenshot failure must not replace the original diagnosis. */ }
  } finally {
    try {
      stage = 'restore';
      if (handle) { await handle.dispose(); handle = null; }
      if (originalViewport) await page.setViewportSize(originalViewport);
      if (originalDraft !== null) {
        await input.fill(originalDraft);
        check(await input.inputValue() === originalDraft, 'original-draft');
      }
    } catch {
      if (!mainError) {
        mainError = new Error(failure); mainError.composerStage = 'restore'; mainError.composerGeometry = latest;
      }
    }
  }
  if (mainError) throw mainError;
  return evidence;
}
