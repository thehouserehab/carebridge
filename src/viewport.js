// Mobile keyboards can shrink the visual viewport without resizing CSS vh.
// Keeping the composer within this area does not require UA-specific detection.
export function observeViewport() {
  const update = () => {
    const height = Math.round(window.visualViewport?.height || window.innerHeight);
    document.documentElement.style.setProperty("--visible-height", `${height}px`);
    document.documentElement.toggleAttribute("data-compact-viewport", height <= 500);
  };
  update();
  window.visualViewport?.addEventListener("resize", update);
  window.addEventListener("resize", update);
}
