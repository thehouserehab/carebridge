import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';

// Use the visible user navigation, never force-click an inactive surface or
// inject application state. The responsive shell must expose one active nav.
async function showWorkspaceView(page, view, timeout = () => undefined, observe = (_stage, operation) => operation()) {
  assert(['home', 'chat', 'records', 'child'].includes(view), 'LOCAL_WORKSPACE_TEST_VIEW');
  // The #app shell also exposes data-view for layout; it is not navigation.
  const button = page.locator(`button[data-view="${view}"]:visible`);
  await observe('NAV_VISIBLE', () => button.first().waitFor({ timeout: timeout() }));
  assert.equal(await observe('NAV_COUNT', () => button.count()), 1, 'LOCAL_WORKSPACE_VISIBLE_NAV_UNIQUE');
  if (await observe('NAV_CURRENT', () => button.getAttribute('aria-current', { timeout: timeout() })) !== 'page')
    await observe('NAV_CLICK', () => button.click({ timeout: timeout() }));
  await observe('NAV_ACTIVE', () => page.waitForFunction((view) => [...document.querySelectorAll(`button[data-view="${view}"]`)]
    .some((node) => node.getAttribute('aria-current') === 'page' && node.getClientRects().length > 0), view, { timeout: timeout() }));
}

export async function workspaceView(page, view) {
  await showWorkspaceView(page, view);
}

// Account actions share a native disclosure in the clinical workspace. The
// center workspace still exposes ordinary visible buttons. Use the same user
// path for both; never force a hidden control or alter the disclosure in JS.
export async function workspaceAccountButton(page, action) {
  const labels = { 'self-profile': '계정 설정', refresh: '새로고침', logout: '로그아웃' };
  assert(Object.hasOwn(labels, action), 'LOCAL_WORKSPACE_ACCOUNT_ACTION');
  const button = page.getByRole('button', { name: labels[action], exact: true, includeHidden: true });
  await button.waitFor({ state: 'attached' });
  if (!await button.isVisible()) {
    const menu = page.locator('.account-menu');
    await menu.locator(':scope > summary').click();
  }
  await button.waitFor({ state: 'visible' });
  return button;
}

export async function workspaceAccountAction(page, action) {
  const alreadyOpen = await page.locator('.account-menu[open]').count() > 0;
  const button = await workspaceAccountButton(page, action);
  await button.click();
  // Preserve a pre-existing menu and a self-profile modal's return target.
  // A refresh may replace the shell after authority changes, so only close a
  // still-present open menu that this helper opened for that one action.
  if (action === 'refresh' && !alreadyOpen && await page.locator('.account-menu[open]').count())
    await page.keyboard.press('Escape');
}

export async function workspaceRoom(page, roomId, { keyboard = false } = {}) {
  const started = performance.now(), deadline = started + 20_000;
  const diagnostic = { iterations: 0, attemptsPerSecond: Array(20).fill(0), stages: {}, lastStage: null, transientCount: 0, lastTransient: null };
  const attachDiagnostic = (error) => {
    if (!Object.hasOwn(error, 'workspaceDiagnostics')) Object.defineProperty(error, 'workspaceDiagnostics', {
      value: Object.freeze({ ...structuredClone(diagnostic), elapsedMs: Math.round(performance.now() - started) }), enumerable: true,
    });
    return error;
  };
  const observe = async (stage, operation) => {
    diagnostic.lastStage = stage;
    const counts = diagnostic.stages[stage] ??= { started: 0, completed: 0 };
    counts.started++;
    const result = await operation(); counts.completed++; return result;
  };
  const timeout = () => {
    const remaining = Math.floor(deadline - performance.now());
    try { assert(remaining > 0, 'LOCAL_WORKSPACE_ROOM_TIMEOUT'); }
    catch (error) { throw attachDiagnostic(error); }
    // Allow normal browser actionability checks to finish before re-observing.
    // The shared deadline still bounds the complete navigation to 20 seconds.
    return Math.min(3000, remaining);
  };
  const entry = page.getByTestId('inbox').locator(`[data-room-id="${roomId}"]`);
  const composer = page.getByLabel('메시지', { exact: true });
  const back = page.locator('[data-action="room-list"]:visible');
  const pendingRoom = page.locator('.workspace-grid.room-open [data-testid="room"] .loading-surface[aria-busy="true"]:visible');
  while (true) {
    timeout();
    diagnostic.iterations++;
    diagnostic.attemptsPerSecond[Math.min(19, Math.floor((performance.now() - started) / 1000))]++;
    try {
      await showWorkspaceView(page, 'chat', timeout, observe);
      if (await observe('COMPOSER_VISIBLE', () => composer.isVisible())
        && await observe('ROOM_SELECTED', () => entry.getAttribute('aria-current', { timeout: timeout() })) === 'true') return;
      // A permission refresh may detach an entry after any preceding await.
      // Absence is NOT evidence of a mobile room: desktop has no visible back
      // button. Re-evaluate real controls instead of waiting on an impossible one.
      // Selecting the same not-yet-authorized room restarts its read. Wait for
      // the app's visible busy state instead of continuously cancelling the
      // request with repeated clicks. A busy DIFFERENT room is not our target.
      const selectedRoomPending = await observe('ROOM_LOADING', () => pendingRoom.isVisible())
        && await observe('LOADING_ROOM_SELECTED', () => entry.getAttribute('aria-current', { timeout: timeout() })) === 'true';
      if (selectedRoomPending) {
        // Success still requires the visible composer and selected entry on
        // the next observation; busy state alone never counts as completion.
      } else if (await observe('ENTRY_VISIBLE', () => entry.isVisible())) {
        if (keyboard) {
          await observe('ENTRY_FOCUS', () => entry.focus({ timeout: timeout() }));
          await observe('ENTRY_ENTER', () => entry.press('Enter', { timeout: timeout() }));
        } else await observe('ENTRY_CLICK', () => entry.click({ timeout: timeout() }));
      } else if (await observe('BACK_VISIBLE', () => back.isVisible())) await observe('BACK_CLICK', () => back.click({ timeout: timeout() }));
    } catch (error) {
      const detached = /element (?:is not attached to|was detached from|has been detached from|is detached from) the DOM/i.test(error?.message ?? '');
      if (error?.name !== 'TimeoutError' && !detached) throw attachDiagnostic(error);
      // Never retain the raw call log: selectors/HTML can contain user data.
      // Fixed classifications and stage counters are sufficient to locate an
      // actionability stall without weakening the action or success checks.
      const message = error?.message ?? '';
      diagnostic.transientCount++;
      diagnostic.lastTransient = { stage: diagnostic.lastStage, timeout: error?.name === 'TimeoutError', detached,
        waitingForVisibility: /waiting for.*visible/i.test(message),
        waitingForStability: /waiting for.*stable/i.test(message),
        notVisible: /element is not visible/i.test(message),
        notEnabled: /element is not enabled/i.test(message),
        notStable: /element is not stable/i.test(message),
        actionable: /element is visible, enabled and stable/i.test(message),
        pointerIntercepted: /intercepts pointer events/i.test(message),
        outsideViewport: /outside of the viewport/i.test(message),
        waitingForNavigation: /waiting for.*(?:navigation|navigations)/i.test(message),
      };
    }
    // Success still requires the selected room AND its visible composer on a
    // subsequent observation. No forced clicks or application state injection.
    await wait(Math.min(50, timeout()));
  }
}

export async function workspaceRecords(page, roomId) {
  await workspaceView(page, 'records');
  const select = page.locator('#child-select');
  await page.locator('#child-select:not([disabled])').waitFor();
  if (await select.inputValue() !== roomId) await select.selectOption(roomId);
  await page.waitForFunction((id) => {
    const select = document.querySelector('#child-select');
    return select && !select.disabled && select.value === id;
  }, roomId);
  await page.getByTestId('care').waitFor();
}
