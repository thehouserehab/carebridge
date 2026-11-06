import { workspaceView } from './local-workspace-browser-helpers.mjs';

// An existing owned synthetic workspace only. This helper uses native menu,
// focus and keyboard actions; it never submits a form or activates account actions.
const failure = 'LOCAL_RESPONSIVE_SHELL';
const views = ['home', 'records', 'child'];
const accountActions = ['self-profile', 'refresh', 'logout'];
const settle = page => page.evaluate(() => new Promise(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function geometry(page) {
  return page.evaluate(() => {
    const rectangle = element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        width: box.width, height: box.height };
    };
    const inspect = element => {
      if (!element) return null;
      const box = rectangle(element), style = getComputedStyle(element);
      const rendered = element.getClientRects().length > 0 && box.width > 0 && box.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden';
      let visible = rendered && box.left >= -1 && box.top >= -1
        && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
      for (let parent = element.parentElement; visible && parent; parent = parent.parentElement) {
        const clip = rectangle(parent), overflow = getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(overflow.overflowX))
          visible = box.left >= clip.left - 1 && box.right <= clip.right + 1;
        if (visible && /(auto|scroll|hidden|clip)/.test(overflow.overflowY))
          visible = box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1;
      }
      const owns = (x, y) => { const hit = document.elementFromPoint(x, y); return hit === element || element.contains(hit); };
      const dx = Math.min(6, box.width / 4), dy = Math.min(6, box.height / 4);
      const accessible = visible && [[box.left + box.width / 2, box.top + box.height / 2],
        [box.left + dx, box.top + dy], [box.right - dx, box.bottom - dy]].every(point => owns(...point));
      return { box, rendered, visible, accessible, position: style.position,
        focused: document.activeElement === element, disabled: element.disabled === true,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    };
    const activeView = document.querySelector('#app')?.dataset.view;
    const navs = [...document.querySelectorAll('.main-nav')].filter(node => node.getClientRects().length > 0);
    const labels = { home: '홈', chat: '대화', records: '기록', child: '아이 정보' };
    const normalText = element => element?.textContent.replace(/\s+/g, ' ').trim();
    const menu = document.querySelector('.workspace-head .account-menu');
    const summary = menu?.querySelector(':scope > summary');
    const actionLabels = { 'self-profile': '계정 설정', refresh: '새로고침', logout: '로그아웃' };
    const home = document.querySelector('[data-testid="home"] .home-layout');
    const content = document.querySelector(`[data-page="${activeView}"]`);
    return { viewport: { width: innerWidth, height: innerHeight }, activeView, outerScrollY: scrollY,
      pageWidth: document.documentElement.scrollWidth, navCount: navs.length, nav: inspect(navs[0]),
      navigation: [...document.querySelectorAll('button[data-view]')]
        .filter(node => node.getClientRects().length > 0).map(node => ({ view: node.dataset.view,
          labelMatches: normalText(node) === labels[node.dataset.view], current: node.getAttribute('aria-current'),
          iconsDecorative: node.querySelectorAll('svg').length > 0
            && [...node.querySelectorAll('svg')].every(icon => icon.getAttribute('aria-hidden') === 'true'),
          ...inspect(node) })),
      content: inspect(content), homeColumns: activeView === 'home' && home
        ? [...home.children].map(node => ({ ...rectangle(node), clientWidth: node.clientWidth, scrollWidth: node.scrollWidth })) : null,
      accountOpen: menu?.open === true, accountSummary: inspect(summary), accountLabelMatches: normalText(summary) === '내 계정',
      accountActions: Object.entries(actionLabels).map(([action, label]) => {
        const button = menu?.querySelector(`button[data-action="${action}"]`);
        return { action, labelMatches: normalText(button) === label, ...inspect(button) };
      }) };
  });
}

export async function verifyResponsiveShell({ page, capture }) {
  const originalViewport = page.viewportSize();
  const originalView = await page.locator('#app').getAttribute('data-view');
  const originalScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  const menu = page.locator('.workspace-head .account-menu'), summary = menu.locator(':scope > summary');
  const evidence = []; let stage = 'setup', latest = null, mainError = null;
  const check = (condition, name) => {
    if (!condition) throw Object.assign(new Error(failure), { shellStage: `${stage}:${name}`, shellGeometry: latest });
  };
  const observe = async label => {
    stage = label; await settle(page); latest = await geometry(page); evidence.push({ label, ...latest });
    check(latest.pageWidth <= latest.viewport.width + 1, 'page-overflow');
    check(latest.content?.rendered && latest.content.scrollWidth <= latest.content.clientWidth + 1, 'active-content-overflow');
    return latest;
  };
  const assertNavigation = (value, view) => {
    check(value.activeView === view, 'active-view');
    check(value.navCount === 1 && value.nav?.accessible, 'single-accessible-navigation');
    check(value.nav.position === (value.viewport.width <= 700 ? 'fixed' : 'sticky'), 'responsive-navigation-placement');
    check(value.navigation.length === 4 && new Set(value.navigation.map(item => item.view)).size === 4,
      'four-unique-menu-actions');
    for (const item of value.navigation) {
      check(item.labelMatches && item.iconsDecorative, 'menu-label-and-decorative-icon');
      check(item.accessible && item.box.height >= 43.5 && item.box.width >= 43.5, 'menu-touch-target');
      check(item.current === (item.view === view ? 'page' : null), 'single-current-page');
    }
  };
  const closeAccount = async () => {
    if (await menu.getAttribute('open') !== null) await page.keyboard.press('Escape');
    await settle(page); check(await menu.getAttribute('open') === null, 'account-closed');
  };
  try {
    check(originalViewport && views.includes(originalView) && typeof capture === 'function', 'arguments');
    check(await menu.count() === 1, 'account-menu-present');
    await closeAccount();
    for (const viewport of [{ width: 320, height: 740 }, { width: 700, height: 900 },
      { width: 701, height: 900 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
      const label = `shell-${viewport.width}x${viewport.height}`;
      stage = `${label}:resize`; await page.setViewportSize(viewport);
      for (const view of views) {
        await workspaceView(page, view);
        await page.locator(`[data-page="${view}"] [data-page-title]`).waitFor();
        const value = await observe(`${label}:${view}`); assertNavigation(value, view);
        check(!value.accountOpen, 'account-default-closed');
        if (view === 'home') {
          check(value.homeColumns?.length === 2, 'home-two-regions');
          const [main, aside] = value.homeColumns;
          check([main, aside].every(region => region.width > 0 && region.scrollWidth <= region.clientWidth + 1), 'home-region-overflow');
          if (viewport.width <= 700) check(Math.abs(main.left - aside.left) <= 1 && main.bottom <= aside.top + 1, 'home-single-column');
          else check(main.right <= aside.left + 1 && Math.abs(main.top - aside.top) <= 1, 'home-two-columns');
        }
        await capture(`${label}-${view}`);
      }

      await workspaceView(page, 'home');
      await summary.scrollIntoViewIfNeeded(); await summary.focus();
      const closed = await observe(`${label}:account-before-open`);
      check(closed.accountLabelMatches && closed.accountSummary?.accessible && closed.accountSummary.focused
        && closed.accountSummary.box.height >= 43.5, 'account-summary-accessible');
      check(closed.accountActions.every(item => !item.rendered), 'closed-account-actions-hidden');
      await summary.press('Enter');
      const opened = await observe(`${label}:account-open`);
      check(opened.accountOpen && opened.accountSummary.focused, 'native-account-open');
      check(opened.accountActions.every(item => item.labelMatches && item.accessible
        && item.box.height >= 43.5 && item.box.width >= 43.5 && !item.disabled), 'account-actions-accessible');
      await capture(`${label}-account-open`);
      for (const action of accountActions) {
        await page.keyboard.press('Tab');
        const focused = await observe(`${label}:account-${action}-focus`);
        const button = focused.accountActions.find(item => item.action === action);
        check(focused.accountOpen && button?.focused && button.accessible, 'account-native-tab-order');
      }
      await page.keyboard.press('Escape');
      const escaped = await observe(`${label}:account-escape`);
      check(!escaped.accountOpen && escaped.accountSummary.focused && escaped.accountSummary.accessible, 'escape-restores-summary-focus');
      check(escaped.accountActions.every(item => !item.rendered), 'escape-hides-actions');
      assertNavigation(escaped, 'home');
    }
  } catch (error) {
    mainError = error.shellStage ? error : Object.assign(new Error(failure), { shellStage: stage, shellGeometry: latest });
    try { await capture(`shell-failure-${page.viewportSize()?.width ?? 0}`); } catch { /* Keep sanitized original failure. */ }
  } finally {
    try {
      await closeAccount();
      if (originalViewport) await page.setViewportSize(originalViewport);
      if (views.includes(originalView)) await workspaceView(page, originalView);
      await settle(page);
      const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
      if (Math.abs(scroll.x - originalScroll.x) > 1 || Math.abs(scroll.y - originalScroll.y) > 1) {
        await page.mouse.move(1, 1); await page.mouse.wheel(originalScroll.x - scroll.x, originalScroll.y - scroll.y);
        await page.waitForFunction(({ x, y }) => Math.abs(scrollX - x) <= 1 && Math.abs(scrollY - y) <= 1,
          originalScroll, { timeout: 3000 });
      }
      check(await page.locator('#app').getAttribute('data-view') === originalView, 'original-view-restored');
    } catch { mainError ??= Object.assign(new Error(failure), { shellStage: 'restore', shellGeometry: latest }); }
  }
  if (mainError) throw mainError;
  return { evidence, noAccountActionActivated: true, noMessageSubmitted: true, physicalDeviceVerified: false };
}
