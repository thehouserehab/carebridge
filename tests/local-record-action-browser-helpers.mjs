import assert from 'node:assert/strict';

// Observe a real, already-open synthetic record form. This module never starts
// a browser/server, changes application state through evaluate, or sends API
// requests. All mutations below are normal field, focus and keyboard actions.
const failure = 'LOCAL_RECORD_ACTION_LAYOUT';
const actionSelectors = [
  'button[name="intent"][value="draft"]',
  'button[name="intent"][value="saved"]',
  'button[name="intent"][value="prepare-share"]',
  'button[data-care-action="discard"]',
];

async function geometry(dialog, targetSelector = null) {
  return dialog.evaluate((node, selector) => {
    const form = node.querySelector('[data-care-form="record"]');
    const fields = form?.querySelector('.care-fields');
    const header = node.querySelector('.care-dialog-head');
    const footer = form?.querySelector('.care-submit');
    const rectangle = element => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left,
        width: rect.width, height: rect.height };
    };
    const inspect = element => {
      if (!element) return null;
      const rect = rectangle(element);
      let visible = rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0
        && rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
      for (let parent = element.parentElement; visible && parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), clip = rectangle(parent);
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX))
          visible = rect.left >= clip.left - 1 && rect.right <= clip.right + 1;
        if (visible && /(auto|scroll|hidden|clip)/.test(style.overflowY))
          visible = rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1;
      }
      const insetX = Math.min(12, rect.width / 4), insetY = Math.min(8, rect.height / 4);
      const points = [
        [rect.left + insetX, rect.top + insetY], [rect.right - insetX, rect.top + insetY],
        [rect.left + insetX, rect.bottom - insetY], [rect.right - insetX, rect.bottom - insetY],
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
      ];
      const unobscured = visible && points.every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return hit === element || element.contains(hit);
      });
      return { rect, visible, unobscured, focused: document.activeElement === element,
        formOwned: element.form === form, disabled: element.disabled === true,
        type: element.type ?? null,
        intent: element.tagName === 'BUTTON' ? element.value || element.dataset.careAction || null : null };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      open: node.open === true, formPresent: !!form,
      pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      dialogOverflow: node.scrollWidth > node.clientWidth + 1,
      fieldsOverflow: !!fields && fields.scrollWidth > fields.clientWidth + 1,
      dialog: rectangle(node), header: rectangle(header), footer: rectangle(footer), fields: rectangle(fields),
      fixedBody: !!fields && ['auto', 'scroll'].includes(getComputedStyle(fields).overflowY),
      buttons: [...(footer?.querySelectorAll('button') ?? [])].map(inspect),
      target: selector ? inspect(node.querySelector(selector)) : null,
      notice: inspect(form?.querySelector('[data-care-error]')),
    };
  }, targetSelector);
}

function assertShell(observed) {
  assert(observed.open && observed.formPresent, failure);
  assert(!observed.pageOverflow && !observed.dialogOverflow && !observed.fieldsOverflow, failure);
  assert(observed.fields?.height > 0 && observed.fields.width > 0, failure);
}

function assertTarget(target, { focused = false, button = false } = {}) {
  assert(target?.visible && target.unobscured, failure);
  if (focused) assert.equal(target.focused, true, failure);
  if (button) { assert(target.rect.height >= 43.5, failure); assert.equal(target.formOwned, true, failure); }
}

function assertActions(observed, { count = 4, disabled = false, allVisible = true } = {}) {
  assertShell(observed); assert.equal(observed.buttons.length, count, failure);
  for (const button of observed.buttons) {
    assert.equal(button.formOwned, true, failure); assert.equal(button.disabled, disabled, failure);
    assert(button.rect.height >= 43.5, failure);
    if (allVisible) assertTarget(button, { button: true });
  }
}

async function revealSharing(dialog) {
  const sharing = dialog.locator('.care-sharing-fields');
  if (await sharing.getAttribute('open') === null) await sharing.locator(':scope > summary').click();
}

/** Call before filling the study's authoritative record values. */
export async function verifyRecordActionLayout({ page, dialog, capture, assertNoWrites }) {
  assert(typeof capture === 'function' && typeof assertNoWrites === 'function', failure);
  const originalViewport = page.viewportSize(); assert(originalViewport, failure);
  const date = dialog.locator('[name="date"]'), originalDate = await date.inputValue();
  assert(originalDate, failure);
  const evidence = [];
  const observe = async (label, selector = null, { focused = false, allActions = true } = {}) => {
    const value = await geometry(dialog, selector);
    try {
      assertActions(value, { allVisible: allActions });
      if (selector) assertTarget(value.target, { focused, button: selector.startsWith('button') });
    } catch (error) {
      // Fixed stage names and geometry only; no entered text or account data.
      error.recordActionStage = label; error.recordActionGeometry = value; throw error;
    }
    evidence.push({ label, ...value }); return value;
  };
  const keyboardRoute = async (label, fixedBody) => {
    await revealSharing(dialog);
    const last = dialog.locator('[name="activityCaution"]'); await last.focus();
    const end = await observe(`${label}:last-field`, '[name="activityCaution"]', { focused: true, allActions: fixedBody });
    assert.equal(end.fixedBody, fixedBody, failure);
    await capture(`${label}-last-field`);
    // Follow the visible secondary pair, then the main pair. Keep semantic
    // actionSelectors unchanged for the validation and submission checks.
    const keyboardActions = [0, 3, 1, 2].map(index => actionSelectors[index]);
    for (const [index, selector] of keyboardActions.entries()) {
      await page.keyboard.press('Tab');
      await observe(`${label}:tab-action-${index}`, selector, { focused: true, allActions: fixedBody });
    }
    for (let index = keyboardActions.length - 2; index >= 0; index--) {
      await page.keyboard.press('Shift+Tab');
      await observe(`${label}:back-action-${index}`, keyboardActions[index], { focused: true, allActions: fixedBody });
    }
    await page.keyboard.press('Shift+Tab');
    await observe(`${label}:back-field`, '[name="activityCaution"]', { focused: true, allActions: fixedBody });
    // Each action must also be reachable in the whole-dialog fallback; they do
    // not need to remain visible while a distant field is being read there.
    if (!fixedBody) for (const [index, selector] of actionSelectors.entries()) {
      await dialog.locator(selector).focus();
      await observe(`${label}:fallback-action-${index}`, selector, { focused: true, allActions: false });
    }
  };
  try {
    const initial = await observe('initial'); assert.equal(initial.fixedBody, true, failure);
    await capture('record-actions-initial');
    await keyboardRoute('record-actions-original', true);

    await date.fill('');
    await dialog.locator(actionSelectors[1]).click();
    await page.waitForFunction(() => document.activeElement?.name === 'date');
    await observe('invalid-date', '[name="date"]', { focused: true });
    assert.equal(await date.evaluate(node => node.validity.valid), false, failure);
    await assertNoWrites(); await capture('record-actions-invalid-date');
    await date.fill(originalDate);

    await revealSharing(dialog); await dialog.locator('[name="summary"]').fill('');
    // Close the disclosure through its real control, so preparation must open
    // it itself before focusing the missing summary.
    await dialog.locator('.care-sharing-fields > summary').click();
    assert.equal(await dialog.locator('.care-sharing-fields').getAttribute('open'), null, failure);
    await dialog.locator(actionSelectors[2]).click();
    await page.waitForFunction(() => document.activeElement?.name === 'summary');
    const summary = await observe('missing-share-summary', '[name="summary"]', { focused: true });
    assert.notEqual(await dialog.locator('.care-sharing-fields').getAttribute('open'), null, failure);
    assert.match(await dialog.locator('[data-care-error]').innerText(), /요약이 필요/);
    assertTarget(summary.notice); await assertNoWrites(); await capture('record-actions-missing-summary');

    if (originalViewport.width === 390) {
      await page.setViewportSize({ width: 320, height: 640 });
      await date.focus(); const narrow = await observe('narrow-initial', '[name="date"]', { focused: true });
      assert.equal(narrow.fixedBody, true, failure); await capture('record-actions-narrow-initial');
      await keyboardRoute('record-actions-narrow', true);
      await page.setViewportSize({ width: 844, height: 390 });
      await date.focus(); const low = await observe('low-height-initial', '[name="date"]', { focused: true, allActions: false });
      assert.equal(low.fixedBody, false, failure); await capture('record-actions-low-height-initial');
      await keyboardRoute('record-actions-low-height', false);
      await capture('record-actions-low-height-actions');
    }
    await assertNoWrites();
  } finally {
    await page.setViewportSize(originalViewport);
    // Restore the only nonempty input this helper clears; the caller will fill
    // its complete fixed synthetic study record after this helper returns.
    if (await dialog.isVisible()) { await date.fill(originalDate); await date.focus(); }
  }
  return evidence;
}

/** The caller holds the first real record POST and releases it in its finally. */
export async function verifyPendingRecordActions({ page, dialog }) {
  await dialog.locator('[data-care-action="retry"]').waitFor();
  const observed = await geometry(dialog);
  assertActions(observed, { count: 5, disabled: true });
  assert.equal(observed.fixedBody, true, failure);
  const controls = await dialog.locator('[data-care-form="record"]').evaluate(form =>
    [...form.querySelectorAll('input,textarea,select,button')].map(element => ({
      formOwned: element.form === form, disabled: element.disabled,
      mediaControl: !!element.closest('[data-record-upload],[data-feedback-upload],[data-reply-upload]'),
    })));
  assert(controls.length > 5, failure);
  for (const control of controls) {
    assert.equal(control.formOwned, true, failure);
    if (!control.mediaControl) assert.equal(control.disabled, true, failure);
  }
  assert.deepEqual(observed.viewport, page.viewportSize(), failure);
  return { label: 'pending-record-actions', ...observed, controls };
}
