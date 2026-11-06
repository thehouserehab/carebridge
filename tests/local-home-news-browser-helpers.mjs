import assert from 'node:assert/strict';

// Inspect the real application's existing synthetic home. The caller owns its
// browser, server, authorization and screenshot masking. Evaluation only reads
// rendered geometry: this helper never writes DOM, application state or APIs.
const failure = 'LOCAL_HOME_NEWS_LAYOUT';
const rowSelector = '[data-home-news] > .home-news-row';
const check = (condition, stage) => assert(condition, `${failure}:${stage}`);

async function inspectHome(page) {
  return page.locator('[data-home-news]').evaluate(host => {
    const rect = element => {
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return { left: value.left, top: value.top, right: value.right, bottom: value.bottom,
        width: value.width, height: value.height };
    };
    const rows = [...host.querySelectorAll(':scope > .home-news-row')];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      pageWidth: document.documentElement.scrollWidth,
      host: rect(host), hostWidth: host.clientWidth, hostScrollWidth: host.scrollWidth,
      rows: rows.map(element => {
        const name = element.querySelector('.room-name'), title = name?.querySelector('strong');
        const meta = element.querySelector('.news-meta'), sender = meta?.querySelector('.news-sender');
        const timestamp = meta?.lastElementChild, preview = element.querySelector('.preview');
        const badge = name?.querySelector('.badge'), arrow = name?.querySelector('.room-cta');
        const titleRect = rect(title), nameRect = rect(name), arrowRect = rect(arrow);
        const nameGap = name ? Number.parseFloat(getComputedStyle(name).columnGap) : NaN;
        return {
          role: element.getAttribute('role') || (element.tagName === 'BUTTON' ? 'button' : null),
          rect: rect(element), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
          name: nameRect, title: titleRect, meta: rect(meta), sender: rect(sender),
          timestamp: rect(timestamp), preview: rect(preview), badge: rect(badge), arrow: arrowRect,
          metaLineHeight: meta ? Number.parseFloat(getComputedStyle(meta).lineHeight) : NaN,
          previewLineHeight: preview ? Number.parseFloat(getComputedStyle(preview).lineHeight) : NaN,
          badgeTrackWidth: nameRect && titleRect && arrowRect
            ? nameRect.width - titleRect.width - arrowRect.width - 2 * nameGap : null,
          textLengths: { title: title?.textContent.length ?? 0, sender: sender?.textContent.length ?? 0,
            timestamp: timestamp?.textContent.length ?? 0, preview: preview?.textContent.length ?? 0,
            badge: badge?.textContent.length ?? 0 },
        };
      }),
    };
  });
}

function assertHome(value, label) {
  check(value.rows.length > 0, `${label}:rows`);
  check(value.pageWidth <= value.viewport.width + 1, `${label}:page-overflow`);
  check(value.hostScrollWidth <= value.hostWidth + 1, `${label}:host-overflow`);
  for (const [index, row] of value.rows.entries()) {
    const stage = `${label}:row-${index}`;
    check(row.role === 'button', `${stage}:role`);
    check(row.rect.height >= 43.5 && row.rect.width > 0, `${stage}:touch-size`);
    check(row.rect.left >= -1 && row.rect.right <= value.viewport.width + 1, `${stage}:viewport-width`);
    check(row.scrollWidth <= row.clientWidth + 1, `${stage}:row-overflow`);
    check(row.name && row.title && row.meta && row.sender && row.timestamp && row.preview
      && row.badge && row.arrow, `${stage}:parts`);
    check(row.name.bottom <= row.meta.top + 1 && row.meta.bottom <= row.preview.top + 1,
      `${stage}:hierarchy`);
    check(Math.abs(row.sender.top - row.timestamp.top) <= 1
      && row.sender.right <= row.timestamp.left + 1, `${stage}:metadata-one-row`);
    check(Number.isFinite(row.metaLineHeight)
      && Math.abs(row.meta.height - row.metaLineHeight) <= 1, `${stage}:metadata-height`);
    check(Number.isFinite(row.previewLineHeight)
      && Math.abs(row.preview.height - 2 * row.previewLineHeight) <= 1, `${stage}:preview-two-lines`);
    check(row.badgeTrackWidth >= 75.5 && row.badge.width <= 77
      && row.title.right <= row.badge.left + 1 && row.badge.right <= row.arrow.left + 1,
    `${stage}:badge-reservation`);
    for (const part of ['name', 'meta', 'preview', 'badge', 'arrow']) {
      check(row[part].left >= row.rect.left - 1 && row[part].right <= row.rect.right + 1,
        `${stage}:${part}-horizontal-containment`);
      check(row[part].top >= row.rect.top - 1 && row[part].bottom <= row.rect.bottom + 1,
        `${stage}:${part}-vertical-containment`);
    }
  }
}

async function focusedRow(page, index, label) {
  const row = page.locator(rowSelector).nth(index);
  await page.waitForFunction(({ selector, position }) =>
    document.activeElement === document.querySelectorAll(selector)[position],
  { selector: rowSelector, position: index });
  const focused = await row.evaluate(element => {
    const value = element.getBoundingClientRect();
    const x = value.left + value.width / 2, y = value.top + value.height / 2;
    const hit = document.elementFromPoint(x, y);
    const points = [[value.left + 8, value.top + 8], [value.right - 8, value.top + 8],
      [value.left + 8, value.bottom - 8], [value.right - 8, value.bottom - 8]];
    return { focused: document.activeElement === element,
      centerInViewport: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight,
      centerUnobscured: hit === element || element.contains(hit),
      fullyInViewport: value.left >= -1 && value.top >= -1 && value.right <= innerWidth + 1 && value.bottom <= innerHeight + 1,
      cornersUnobscured: points.every(([px, py]) => {
        const corner = document.elementFromPoint(px, py); return corner === element || element.contains(corner);
      }),
      rect: { left: value.left, top: value.top, width: value.width, height: value.height } };
  });
  check(focused.focused, `${label}:keyboard-focus`);
  check(focused.centerInViewport && focused.centerUnobscured && focused.fullyInViewport && focused.cornersUnobscured,
    `${label}:focused-row-visible`);
  return { label, index, ...focused };
}

async function restoreScroll(page, original) {
  // Use normal wheel input, not a DOM mutation. A read-only wait confirms that
  // the helper did not leave the caller at its narrow-viewport scroll position.
  const current = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  if (Math.abs(current.x - original.x) <= 1 && Math.abs(current.y - original.y) <= 1) return;
  await page.mouse.move(1, 1);
  await page.mouse.wheel(original.x - current.x, original.y - current.y);
  try {
    await page.waitForFunction(({ x, y }) => Math.abs(scrollX - x) <= 1 && Math.abs(scrollY - y) <= 1,
      original, { timeout: 3000 });
  } catch {
    check(false, 'restore-scroll');
  }
}

export async function verifyHomeNewsLayout({ page, capture }) {
  check(typeof capture === 'function', 'capture-callback');
  const originalViewport = page.viewportSize(); check(originalViewport, 'viewport');
  const originalScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  const evidence = [];
  const verify = async () => {
    const viewport = page.viewportSize(), label = `home-news-${viewport.width}x${viewport.height}`;
    const rows = page.locator(rowSelector); await rows.first().waitFor({ state: 'visible' });
    const value = await inspectHome(page); assertHome(value, label);
    await rows.first().scrollIntoViewIfNeeded(); await rows.first().focus();
    const keyboard = [await focusedRow(page, 0, `${label}:first`)];
    if (value.rows.length > 1) {
      await page.keyboard.press('Tab'); keyboard.push(await focusedRow(page, 1, `${label}:next`));
      await page.keyboard.press('Shift+Tab'); keyboard.push(await focusedRow(page, 0, `${label}:previous`));
    }
    await capture(label);
    evidence.push({ label, ...value, keyboard });
  };
  try {
    await verify();
    if (originalViewport.width === 390) {
      await page.setViewportSize({ width: 320, height: 740 });
      await verify();
    }
  } catch (error) {
    // Preserve sanitized layout evidence before restoring the caller's viewport.
    // Otherwise a narrow-screen focus failure is captured only after resize.
    error.homeNewsGeometry = await inspectHome(page);
    await capture(`home-news-failure-${page.viewportSize().width}x${page.viewportSize().height}`);
    throw error;
  } finally {
    await page.setViewportSize(originalViewport);
    await restoreScroll(page, originalScroll);
  }
  return evidence;
}
