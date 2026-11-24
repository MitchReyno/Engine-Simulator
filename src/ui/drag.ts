// Lets a floating panel be moved by dragging its header (or any part of it that is not a control).

const INTERACTIVE = 'button, input, select, textarea, a, label, canvas, summary';

/**
 * `handle` is where a drag may start; the panel is moved by setting its left and top, in the
 * coordinates of whatever it is positioned against. `onMoved` fires once per drag that actually moved it.
 */
export function makeDraggable(panel: HTMLElement, handle: HTMLElement = panel, onMoved: () => void = () => {}): void {
  handle.style.cursor = 'move';
  handle.style.touchAction = 'none';
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(INTERACTIVE)) return;
    const rect = panel.getBoundingClientRect();
    // position: fixed measures from the window; position: absolute from the offset parent
    const fixed = getComputedStyle(panel).position === 'fixed';
    const base = fixed ? { left: 0, top: 0 } : (panel.offsetParent ?? document.body).getBoundingClientRect();
    const grabX = e.clientX - rect.left, grabY = e.clientY - rect.top;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
        moved = true;
        panel.style.right = panel.style.bottom = 'auto';
        panel.style.transform = 'none';
        panel.style.margin = '0';
        onMoved();
      }
      // keep a strip of the panel on screen so it can always be grabbed again
      const x = Math.min(window.innerWidth - 40, Math.max(40 - rect.width, ev.clientX - grabX));
      const y = Math.min(window.innerHeight - 30, Math.max(0, ev.clientY - grabY));
      panel.style.left = `${x - base.left}px`;
      panel.style.top = `${y - base.top}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    e.preventDefault();
  });
}
