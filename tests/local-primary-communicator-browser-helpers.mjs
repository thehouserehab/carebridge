// The caller owns the synthetic session, page and masked screenshots. This
// helper only observes rendered UI and uses native disclosure/focus controls;
// it never creates a server, writes application state or submits a message.
const failure = 'LOCAL_PRIMARY_COMMUNICATOR_LAYOUT';
const selector = '.primary-communicator-compact';

const settleLayout = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

async function geometry(page) {
  return page.evaluate(sectionSelector => {
    const section = document.querySelector(sectionSelector);
    const details = section?.querySelector('details'), summary = details?.querySelector('summary');
    const permission = details?.querySelector('p'), audience = section?.querySelector('[data-primary-audience]');
    const list = document.querySelector('[data-testid="message-list"]');
    const composer = document.querySelector('.composer'), input = composer?.querySelector('textarea');
    const send = composer?.querySelector('button[type="submit"]');
    const rectangle = element => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height };
    };
    const inspect = element => {
      if (!element) return null;
      const rect = rectangle(element), style = getComputedStyle(element);
      // Chromium can retain geometry for a closed details descendant. Its
      // positive rectangle alone is not evidence that the content is shown.
      let disclosureHidden = false;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS' && !parent.open) {
          const heading = parent.querySelector(':scope > summary');
          if (heading !== element && !heading?.contains(element)) disclosureHidden = true;
        }
      }
      const rendered = element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && style.visibility !== 'hidden' && style.display !== 'none' && !disclosureHidden;
      let inViewport = rendered && rect.left >= -1 && rect.top >= -1
        && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
      for (let parent = element.parentElement; inViewport && parent; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent), clip = rectangle(parent);
        if (/(auto|scroll|hidden|clip)/.test(overflow.overflowX))
          inViewport = rect.left >= clip.left - 1 && rect.right <= clip.right + 1;
        if (inViewport && /(auto|scroll|hidden|clip)/.test(overflow.overflowY))
          inViewport = rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1;
      }
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const corners = [[rect.left + 8, rect.top + 8], [rect.right - 8, rect.top + 8],
        [rect.left + 8, rect.bottom - 8], [rect.right - 8, rect.bottom - 8]];
      return { rect, rendered, inViewport, centerUnobscured: inViewport && (hit === element || element.contains(hit)),
        cornersUnobscured: inViewport && corners.every(([x, y]) => {
          const target = document.elementFromPoint(x, y); return target === element || element.contains(target);
        }),
        focused: document.activeElement === element, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        disabled: element.disabled === true };
    };
    const listRect = rectangle(list), rows = list
      ? [...list.querySelectorAll('[data-testid="message-row"][data-message-id]')] : [];
    const listTop = listRect ? listRect.top + list.clientTop : 0;
    const anchorIndex = rows.findIndex(row => row.getBoundingClientRect().bottom > listTop);
    return {
      viewport: { width: innerWidth, height: innerHeight }, pageWidth: document.documentElement.scrollWidth,
      section: inspect(section), summary: inspect(summary), permission: inspect(permission), audience: inspect(audience),
      input: inspect(input), send: inspect(send), open: details?.open === true,
      personCharacters: section?.querySelector('[data-primary-person]')?.textContent.length ?? 0,
      audienceOutsideDisclosure: !!audience && !details?.contains(audience),
      audienceWording: audience?.textContent.trim() === '일반 소식은 현재 참여자에게 함께 전달됩니다.',
      permissionWording: permission?.textContent.includes('개인 대화·동의 완료·기록 열람 권한을 뜻하지 않습니다.') === true,
      messages: list ? { rect: listRect, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight,
        scrollTop: list.scrollTop, bottomGap: Math.max(0, list.scrollHeight - list.scrollTop - list.clientHeight),
        rowCount: rows.length, anchorIndex,
        anchorOffset: anchorIndex < 0 ? null : rows[anchorIndex].getBoundingClientRect().top - listTop } : null,
    };
  }, selector);
}

export async function verifyPrimaryCommunicatorLayout({ page, capture, expectedDraft }) {
  const originalViewport = page.viewportSize();
  const section = page.locator(selector), details = section.locator('details'), summary = details.locator('summary');
  const input = page.locator('.composer textarea');
  let stage = 'initial', latest = null, originalOpen = null, mainError = null;
  const evidence = [];
  const check = (condition, name) => {
    if (condition) return;
    const error = new Error(failure); error.primaryStage = `${stage}:${name}`; error.primaryGeometry = latest;
    throw error;
  };
  const observe = async (name, open) => {
    stage = name; await settleLayout(page); latest = await geometry(page);
    check(latest.open === open, 'disclosure-state');
    check(latest.pageWidth <= latest.viewport.width + 1, 'page-overflow');
    check(latest.section?.rendered && latest.summary?.rendered, 'summary-rendered');
    check(latest.section.scrollWidth <= latest.section.clientWidth + 1, 'section-overflow');
    check(latest.summary.rect.height >= 43.5 && latest.summary.scrollWidth <= latest.summary.clientWidth + 1, 'summary-size');
    check(latest.audience?.rendered && latest.audienceOutsideDisclosure && latest.audienceWording, 'audience-always-present');
    check(latest.permissionWording && latest.permission?.rendered === open, 'permission-disclosure');
    check(latest.messages?.clientHeight > 0, 'message-space');
    check(await input.inputValue() === expectedDraft, 'draft-preserved');
    evidence.push({ label: name, ...latest }); return latest;
  };
  const compareReading = (before, after, label) => {
    const prior = before.messages, next = after.messages;
    const applicable = prior.rowCount === next.rowCount && prior.rowCount > 0;
    const mode = !applicable ? 'not-comparable' : prior.bottomGap < 48 ? 'end' : 'anchor';
    if (mode === 'end') check(next.bottomGap < 48, `${label}:reading-end`);
    if (mode === 'anchor') check(next.anchorIndex === prior.anchorIndex
      && Math.abs(next.anchorOffset - prior.anchorOffset) <= 2, `${label}:reading-anchor`);
    evidence.push({ label, mode, applicable, before: prior, after: next });
  };
  const setOpen = async (open, key = 'Space') => {
    if ((await details.getAttribute('open') !== null) === open) return;
    await summary.scrollIntoViewIfNeeded(); await summary.focus(); await summary.press(key);
    await settleLayout(page);
    check((await details.getAttribute('open') !== null) === open, 'native-toggle');
  };
  try {
    check(originalViewport && typeof capture === 'function' && typeof expectedDraft === 'string', 'arguments');
    await section.waitFor({ state: 'visible' }); originalOpen = await details.getAttribute('open') !== null;
    for (const viewport of [originalViewport, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
      const label = `primary-${viewport.width}x${viewport.height}`; stage = `${label}:setup`;
      await page.setViewportSize(viewport); await settleLayout(page);
      await setOpen(false); await section.scrollIntoViewIfNeeded(); await summary.focus();
      const closed = await observe(`${label}:closed`, false);
      check(closed.summary.centerUnobscured && closed.audience.inViewport, 'closed-notice-visible');
      await capture(`${label}-closed`);

      stage = `${label}:enter-open`; await summary.press('Enter');
      const opened = await observe(`${label}:open`, true);
      check(opened.summary.focused, 'keyboard-focus-retained');
      compareReading(closed, opened, `${label}:open-reading-position`);
      await section.scrollIntoViewIfNeeded(); latest = await geometry(page);
      check(latest.permission.inViewport && latest.permission.centerUnobscured, 'permission-visible');
      await capture(`${label}-open`);

      stage = `${label}:space-close`; await summary.focus(); await summary.press('Space');
      const reclosed = await observe(`${label}:reclosed`, false);
      check(reclosed.summary.focused, 'keyboard-focus-retained');
      compareReading(opened, reclosed, `${label}:close-reading-position`);

      stage = `${label}:composer`; await input.scrollIntoViewIfNeeded(); await input.focus();
      latest = await geometry(page);
      check(latest.input.focused && latest.input.centerUnobscured && latest.input.cornersUnobscured
        && !latest.input.disabled, 'composer-accessible');
      await page.keyboard.press('Tab'); await settleLayout(page); latest = await geometry(page);
      check(latest.send.focused && latest.send.centerUnobscured && latest.send.cornersUnobscured && !latest.send.disabled
        && latest.send.rect.height >= 43.5, 'send-keyboard-accessible');
      check(await input.inputValue() === expectedDraft, 'composer-draft-preserved');
      evidence.push({ label: `${label}:composer-access`, ...latest });
      await capture(`${label}-composer`);
    }
  } catch (error) {
    mainError = error;
    if (!error.primaryStage) {
      const safe = new Error(failure); safe.primaryStage = stage; safe.primaryGeometry = latest;
      mainError = safe;
    }
    // Capture the failing viewport before restoration. A screenshot failure is
    // secondary and must not replace the original sanitized UI diagnosis.
    try {
      const viewport = page.viewportSize();
      if (viewport && typeof capture === 'function')
        await capture(`primary-failure-${viewport.width}x${viewport.height}`);
    } catch { /* Preserve mainError. */ }
  } finally {
    try {
      stage = 'restore';
      if (originalViewport) await page.setViewportSize(originalViewport);
      if (originalOpen !== null && await section.isVisible()) await setOpen(originalOpen);
      await settleLayout(page);
    } catch (error) {
      if (!mainError) {
        mainError = new Error(failure); mainError.primaryStage = 'restore'; mainError.primaryGeometry = latest;
      }
    }
  }
  if (mainError) throw mainError;
  return evidence;
}
