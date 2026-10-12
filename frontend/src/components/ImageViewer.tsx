import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Maximize, Minus, Plus, X } from "lucide-react";

type View = { scale: number; x: number; y: number };
const MAX_SCALE = 8;

// Full-screen viewer for document images: opens fitted to the screen, then zooms (wheel,
// pinch, buttons, keyboard, double-click) and pans (drag, arrow keys) over the original
// full-resolution image, so small diagram labels become readable.
export default function ImageViewer({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ moved: boolean; distance?: number; startScale?: number }>({ moved: false });

  const size = () => {
    const box = stage.current?.getBoundingClientRect();
    return { width: box?.width ?? innerWidth, height: box?.height ?? innerHeight };
  };
  const fitScale = useCallback(() => {
    if (!natural) return 1;
    const { width, height } = size();
    return Math.min(1, (width - 32) / natural.width, (height - 32) / natural.height);
  }, [natural]);
  const centered = useCallback(
    (scale: number): View => {
      const { width, height } = size();
      return {
        scale,
        x: (width - natural!.width * scale) / 2,
        y: (height - natural!.height * scale) / 2,
      };
    },
    [natural],
  );
  const fit = useCallback(() => natural && setView(centered(fitScale())), [natural, centered, fitScale]);
  // Zooms keeping the point under (px, py) fixed on screen. `next` is a target scale or
  // a function of the current scale.
  const zoomAt = useCallback(
    (next: number | ((scale: number) => number), px?: number, py?: number) =>
      setView((current) => {
        const { width, height } = size();
        const target = typeof next === "function" ? next(current.scale) : next;
        const scale = Math.min(MAX_SCALE, Math.max(Math.min(fitScale(), 1) / 2, target));
        const cx = px ?? width / 2,
          cy = py ?? height / 2;
        return {
          scale,
          x: cx - ((cx - current.x) * scale) / current.scale,
          y: cy - ((cy - current.y) * scale) / current.scale,
        };
      }),
    [fitScale],
  );

  useEffect(() => {
    fit();
  }, [fit]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const resize = () => fit();
    addEventListener("resize", resize);
    return () => {
      removeEventListener("resize", resize);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [fit]);
  // Wheel zoom needs a non-passive listener so the page itself never scrolls.
  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = node.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      zoomAt((scale) => scale * factor, event.clientX - box.left, event.clientY - box.top);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [zoomAt]);

  // Keys work wherever focus is (dragging the image leaves focus on the page), and the
  // viewer is modal, so they never reach the document underneath.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandler.current = (event: KeyboardEvent) => {
    const step = 60;
    if (event.key === "Escape") onClose();
    else if (event.key === "+" || event.key === "=") zoomAt((s) => s * 1.25);
    else if (event.key === "-" || event.key === "_") zoomAt((s) => s / 1.25);
    else if (event.key === "0") fit();
    else if (event.key === "1") natural && setView(centered(1));
    else if (event.key.startsWith("Arrow")) {
      const dx = event.key === "ArrowLeft" ? step : event.key === "ArrowRight" ? -step : 0;
      const dy = event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0;
      setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
    } else if (event.key === "Tab") {
      // Keep keyboard focus inside the viewer.
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>("button, a[href]") ?? [])];
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = index < 0 ? 0 : event.shiftKey ? index - 1 : index + 1;
      if (index < 0 || next < 0 || next >= items.length) {
        event.preventDefault();
        items[index >= 0 && event.shiftKey ? items.length - 1 : 0]?.focus();
      }
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    addEventListener("keydown", listener, true);
    return () => removeEventListener("keydown", listener, true);
  }, []);
  function onPointerDown(event: ReactPointerEvent) {
    if ((event.target as HTMLElement).closest(".image-viewer-bar")) return;
    stage.current?.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gesture.current = { moved: false };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { moved: true, distance: Math.hypot(a.x - b.x, a.y - b.y), startScale: view.scale };
    }
  }
  function onPointerMove(event: ReactPointerEvent) {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const point = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, point);
    if (pointers.current.size === 2 && gesture.current.distance) {
      const [a, b] = [...pointers.current.values()];
      const box = stage.current!.getBoundingClientRect();
      zoomAt(
        (gesture.current.startScale! * Math.hypot(a.x - b.x, a.y - b.y)) / gesture.current.distance,
        (a.x + b.x) / 2 - box.left,
        (a.y + b.y) / 2 - box.top,
      );
      return;
    }
    const dx = point.x - previous.x,
      dy = point.y - previous.y;
    if (Math.abs(dx) + Math.abs(dy) > 1) gesture.current.moved = true;
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  }
  function onPointerUp(event: ReactPointerEvent) {
    pointers.current.delete(event.pointerId);
    // A plain click on the dark backdrop (not the image, not a drag) closes the viewer.
    if (
      !pointers.current.size &&
      !gesture.current.moved &&
      event.target === stage.current
    )
      onClose();
  }

  const percent = Math.round(view.scale * 100);
  return createPortal(
    <div
      ref={dialog}
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={alt ? `Image: ${alt}` : "Image viewer"}
    >
      <div className="image-viewer-bar">
        <span className="image-viewer-title">
          {alt || "Image"}
          {natural && (
            <small>
              {natural.width.toLocaleString()} × {natural.height.toLocaleString()} px
            </small>
          )}
        </span>
        <span className="image-viewer-tools">
          <button className="icon-button" aria-label="Zoom out" title="Zoom out (−)" onClick={() => zoomAt((s) => s / 1.25)}>
            <Minus size={16} />
          </button>
          <output className="image-viewer-zoom" aria-live="polite" aria-label="Zoom level">
            {percent}%
          </output>
          <button className="icon-button" aria-label="Zoom in" title="Zoom in (+)" onClick={() => zoomAt((s) => s * 1.25)}>
            <Plus size={16} />
          </button>
          <button className="text-button" title="Fit to screen (0)" onClick={fit}>
            <Maximize size={14} /> Fit
          </button>
          <button
            className="text-button"
            title="Actual size, one image pixel per screen pixel (1)"
            onClick={() => natural && setView(centered(1))}
          >
            1:1
          </button>
          <a className="text-button" href={src} target="_blank" rel="noopener noreferrer" title="Open the original file in a new tab">
            <ExternalLink size={14} /> Original
          </a>
          <button ref={closeButton} className="icon-button image-viewer-close" aria-label="Close image viewer" title="Close (Esc)" onClick={onClose}>
            <X size={18} />
          </button>
        </span>
      </div>
      <div
        ref={stage}
        className="image-viewer-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={(event) => {
          const box = stage.current!.getBoundingClientRect();
          const fitted = Math.abs(view.scale - fitScale()) < 0.01;
          if (fitted) zoomAt(fitScale() >= 1 ? 2 : 1, event.clientX - box.left, event.clientY - box.top);
          else fit();
        }}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(event) =>
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          style={{
            width: natural?.width,
            height: natural?.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            visibility: natural ? "visible" : "hidden",
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
