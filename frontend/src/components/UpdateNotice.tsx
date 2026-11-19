import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, X } from "lucide-react";
import { BRAND } from "../brand";

// Kodelumi is a single-page app: a tab opened before a deploy keeps running the old JavaScript
// until it is reloaded (and its lazily loaded parts no longer exist on the server). This slim bar
// tells such a tab that a newer version is being served and offers a reload. It never reloads by
// itself, so nobody's lesson is interrupted, and it covers nothing: while it shows, the page makes
// room for it (--update-bar, its measured height; see styles.css).
const ENTRY = /\/assets\/index-[\w-]+\.js/;
const MIN_GAP = 60_000; // at most one check a minute (on focus / when the tab becomes visible)
const EVERY = 10 * 60_000; // and one every 10 minutes while the tab is visible

// The entry bundle this tab is running; null outside production builds (e.g. the dev server).
function runningBundle() {
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
    const match = script.getAttribute("src")?.match(ENTRY);
    if (match) return match[0];
  }
  return null;
}

export default function UpdateNotice() {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const running = runningBundle();
    if (!running) return;
    let last = 0;
    async function check() {
      // Hidden tabs never ask; visible ones at most once a minute. The request is the small HTML
      // page (about 1 KB), never cached, and nothing else runs unless the version changed.
      if (document.visibilityState !== "visible" || Date.now() - last < MIN_GAP) return;
      last = Date.now();
      try {
        const response = await fetch("/", { cache: "no-store", headers: { accept: "text/html" } });
        if (!response.ok) return;
        const served = (await response.text()).match(ENTRY)?.[0];
        if (served && served !== running) setAvailable(true);
      } catch {
        // Offline or the server is restarting: try again later.
      }
    }
    const onActive = () => void check();
    // A lazily loaded part of the old version is gone from the server: that tab is outdated.
    const onChunkError = () => setAvailable(true);
    document.addEventListener("visibilitychange", onActive);
    window.addEventListener("focus", onActive);
    window.addEventListener("vite:preloadError", onChunkError);
    const timer = setInterval(onActive, EVERY);
    return () => {
      document.removeEventListener("visibilitychange", onActive);
      window.removeEventListener("focus", onActive);
      window.removeEventListener("vite:preloadError", onChunkError);
      clearInterval(timer);
    };
  }, []);
  const show = available && !dismissed;
  // An open modal dialog sits above the page in the browser's top layer and makes everything
  // outside it inert (unclickable), so while one is open the bar is rendered inside it.
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!show) return;
    const update = () => setHost([...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter((d) => d.matches(":modal")).pop() ?? null);
    update();
    // At most one look per frame, however busy the page is (e.g. typing in the editor); only
    // while the bar is showing.
    let frame = 0;
    const dialogs = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), update()));
    });
    dialogs.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    return () => {
      dialogs.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [show]);
  // The page makes exactly as much room as the bar takes (it can wrap on narrow screens).
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = bar.current;
    const root = document.documentElement;
    if (!show || !element) return;
    const measure = () => root.style.setProperty("--update-bar", `${Math.ceil(element.getBoundingClientRect().height)}px`);
    measure();
    const size = new ResizeObserver(measure);
    size.observe(element);
    return () => {
      size.disconnect();
      root.style.removeProperty("--update-bar");
    };
  }, [show, host]);
  if (!show) return null;
  return createPortal(
    <div ref={bar} className="update-bar" role="status">
      <RefreshCw size={14} aria-hidden="true" />
      <span>A new version of {BRAND} is available.</span>
      <button className="button secondary" onClick={() => location.reload()}>
        Reload
      </button>
      <button className="icon-button" aria-label="Dismiss update notice" title="Dismiss" onClick={() => setDismissed(true)}>
        <X size={14} />
      </button>
    </div>,
    host ?? document.body,
  );
}
