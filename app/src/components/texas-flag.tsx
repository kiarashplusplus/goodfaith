/**
 * The flag of Texas, the same drawing as the public site's `site/assets/texas-flag.svg` (2:3, blue band a third wide).
 * Decorative: it always sits next to the word "Texas", so screen readers skip it.
 */
export function TexasFlag({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 300 200"
      aria-hidden="true"
      className={`inline-block h-[0.8em] w-auto rounded-[2px] ring-1 ring-stone-200 ${className}`}
    >
      <rect width="300" height="200" fill="#fff" />
      <rect x="100" y="100" width="200" height="100" fill="#BF0D3E" />
      <rect width="100" height="200" fill="#002868" />
      <polygon
        fill="#fff"
        points="50.00,62.50 58.42,88.41 85.66,88.41 63.62,104.43 72.04,130.34 50.00,114.32 27.96,130.34 36.38,104.43 14.34,88.41 41.58,88.41"
      />
    </svg>
  );
}
