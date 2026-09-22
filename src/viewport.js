// Mobile keyboards can shrink the visual viewport without resizing CSS vh.
// Keeping the composer within this area does not require UA-specific detection.
export function observeViewport() {
  const update = () =>
    document.documentElement.style.setProperty(
      "--visible-height",
      `${Math.round(window.visualViewport?.height || window.innerHeight)}px`,
    );
  update();
  window.visualViewport?.addEventListener("resize", update);
  window.addEventListener("resize", update);
}
