import { useRef, type KeyboardEvent, type PointerEvent } from "react";

export const EXPLORER_MIN = 180;
export const EXPLORER_MAX = 480;
// The editor keeps at least this much room however wide the Explorer is dragged.
const MAIN_MIN = 340;
const KEY_STEP = 16;

export function clampExplorerWidth(width: number, viewport = window.innerWidth) {
  const max = Math.max(EXPLORER_MIN, Math.min(EXPLORER_MAX, viewport - MAIN_MIN));
  return Math.round(Math.min(max, Math.max(EXPLORER_MIN, width)));
}

// VS Code-style splitter between the Explorer and the editor. Pointer events cover mouse,
// touch and pen; while dragging, the width is written straight to the layout's CSS
// variable so the large workspace component only re-renders once, on release.
export default function ExplorerResizer({
  width,
  onChange,
}: {
  width: number | null;
  onChange: (width: number | null) => void;
}) {
  const drag = useRef<{ x: number; start: number; current: number } | null>(null);
  const handle = useRef<HTMLDivElement>(null);
  const sidebar = () => handle.current?.previousElementSibling as HTMLElement | null;
  const layout = () => handle.current?.parentElement ?? null;
  const preview = (next: number) => {
    layout()?.style.setProperty("--sidebar-width", next + "px");
    handle.current?.setAttribute("aria-valuenow", String(next));
  };
  const current = () => width ?? sidebar()?.getBoundingClientRect().width ?? EXPLORER_MIN;

  function down(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = sidebar()?.getBoundingClientRect().width ?? current();
    drag.current = { x: event.clientX, start, current: start };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-explorer");
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const next = clampExplorerWidth(drag.current.start + event.clientX - drag.current.x);
    drag.current.current = next;
    preview(next);
  }
  function up(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const { start, current: next } = drag.current;
    drag.current = null;
    document.body.classList.remove("resizing-explorer");
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    // A click without movement keeps the responsive default untouched.
    if (Math.round(start) !== next || width !== null) onChange(next);
  }
  function reset() {
    drag.current = null;
    document.body.classList.remove("resizing-explorer");
    layout()?.style.removeProperty("--sidebar-width");
    onChange(null);
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    const now = current();
    const next =
      event.key === "ArrowLeft"
        ? now - KEY_STEP
        : event.key === "ArrowRight"
          ? now + KEY_STEP
          : event.key === "Home"
            ? EXPLORER_MIN
            : event.key === "End"
              ? EXPLORER_MAX
              : null;
    if (event.key === "Enter") {
      event.preventDefault();
      reset();
    } else if (next !== null) {
      event.preventDefault();
      const clamped = clampExplorerWidth(next);
      preview(clamped);
      onChange(clamped);
    }
  }

  return (
    <div
      ref={handle}
      className="explorer-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Explorer"
      aria-valuemin={EXPLORER_MIN}
      aria-valuemax={EXPLORER_MAX}
      aria-valuenow={width ?? undefined}
      title="Drag to resize · Double-click to reset"
      tabIndex={0}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={up}
      onDoubleClick={reset}
      onKeyDown={key}
    />
  );
}
