import { useRef, type KeyboardEvent, type PointerEvent } from "react";

// Smallest useful Connected panel (heading plus one person) and Explorer (heading plus rows).
export const PEOPLE_MIN = 96;
const EXPLORER_MIN = 120;
const KEY_STEP = 24;

// Divider between the Explorer (above) and Connected (below). Dragging down gives the
// Explorer more room; dragging up gives Connected more. Like the Explorer's width resizer,
// pointer events cover mouse, touch and pen, and while dragging the height is written straight
// to the sidebar's CSS variables, so the workspace re-renders only once, on release.
export default function SidebarSplitter({
  height,
  onChange,
}: {
  height: number | null;
  onChange: (height: number | null) => void;
}) {
  const drag = useRef<{ y: number; start: number; max: number; current: number } | null>(null);
  const handle = useRef<HTMLDivElement>(null);
  const explorer = () => handle.current?.previousElementSibling as HTMLElement | null;
  const people = () => handle.current?.nextElementSibling as HTMLElement | null;
  const sidebar = () => handle.current?.parentElement ?? null;
  // The tallest Connected can be right now: the Explorer keeps at least EXPLORER_MIN.
  const limits = () => {
    const now = people()?.getBoundingClientRect().height ?? PEOPLE_MIN;
    const spare = (explorer()?.getBoundingClientRect().height ?? EXPLORER_MIN) - EXPLORER_MIN;
    return { now, max: Math.max(PEOPLE_MIN, now + Math.max(0, spare)) };
  };
  const clamp = (value: number, max: number) => Math.round(Math.min(max, Math.max(PEOPLE_MIN, value)));
  const preview = (next: number) => {
    const style = sidebar()?.style;
    style?.setProperty("--people-height", next + "px");
    style?.setProperty("--people-cap", "none");
    style?.setProperty("--people-min", PEOPLE_MIN + "px");
    handle.current?.setAttribute("aria-valuenow", String(next));
  };

  function down(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const { now, max } = limits();
    drag.current = { y: event.clientY, start: now, max, current: Math.round(now) };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-sidebar-split");
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    // Moving the divider down shrinks Connected; moving it up grows Connected.
    const next = clamp(drag.current.start - (event.clientY - drag.current.y), drag.current.max);
    drag.current.current = next;
    preview(next);
  }
  function up(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const { start, current } = drag.current;
    drag.current = null;
    document.body.classList.remove("resizing-sidebar-split");
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    // A click without movement keeps the default layout untouched.
    if (Math.round(start) !== current || height !== null) onChange(current);
  }
  function reset() {
    drag.current = null;
    document.body.classList.remove("resizing-sidebar-split");
    const style = sidebar()?.style;
    for (const name of ["--people-height", "--people-cap", "--people-min"]) style?.removeProperty(name);
    onChange(null);
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      reset();
      return;
    }
    const { now, max } = limits();
    // Arrow up moves the divider up, giving Connected more room.
    const next =
      event.key === "ArrowUp"
        ? now + KEY_STEP
        : event.key === "ArrowDown"
          ? now - KEY_STEP
          : event.key === "Home"
            ? max
            : event.key === "End"
              ? PEOPLE_MIN
              : null;
    if (next === null) return;
    event.preventDefault();
    const clamped = clamp(next, max);
    preview(clamped);
    onChange(clamped);
  }

  return (
    <div
      ref={handle}
      className="sidebar-splitter"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize Connected panel"
      aria-valuemin={PEOPLE_MIN}
      aria-valuenow={height ?? undefined}
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
