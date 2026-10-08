import { useId } from "react";

// Product identity. Internal identifiers (localStorage keys, cookie names, the WebSocket
// subprotocol, database and Docker names) intentionally keep the original "devshare"
// prefix so existing sessions, settings and data keep working.
export const BRAND = "Kodelumi";
export const TAGLINE = "Code • Learn • Create • Share";

// Logo mark: an open book (learning) holding </> (code), with a gold sparkle.
export function LogoMark({ size = 32, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className="logo-mark"
    >
      <defs>
        <linearGradient id={id + "l"} x1="6" y1="16" x2="32" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#6366F1" />
        </linearGradient>
        <linearGradient id={id + "r"} x1="32" y1="16" x2="58" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4F7BF7" />
          <stop offset="1" stopColor="#22D3EE" />
        </linearGradient>
      </defs>
      <path d="M32 21C25 15.5 15 14.6 6 17.2V51C15 48.6 25 49.4 32 55Z" fill={`url(#${id}l)`} />
      <path d="M32 21C39 15.5 49 14.6 58 17.2V51C49 48.6 39 49.4 32 55Z" fill={`url(#${id}r)`} />
      <path d="M32 21V55" stroke="#fff" strokeOpacity=".35" strokeWidth="1.4" />
      <g fill="none" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21.5 29.5L14.5 36L21.5 42.5" />
        <path d="M42.5 29.5L49.5 36L42.5 42.5" />
        <path d="M35.2 27.5L28.8 44.5" />
      </g>
      <path
        d="M32 1.5C32.9 5.6 34.4 7.1 38.5 8C34.4 8.9 32.9 10.4 32 14.5C31.1 10.4 29.6 8.9 25.5 8C29.6 7.1 31.1 5.6 32 1.5Z"
        fill="#FBBF24"
      />
    </svg>
  );
}

// Horizontal logo: mark + wordmark. The wordmark follows the theme's text colour.
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={"brand" + (compact ? " compact" : "")}>
      <LogoMark size={compact ? 28 : 34} />
      <span className="brand-name">{BRAND}</span>
    </span>
  );
}
