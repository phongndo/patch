const paths = {
  branch:
    "M6 3v12a3 3 0 0 0 3 3h3m0-12a6 6 0 0 1-6 6M6 3a2 2 0 1 0 0 .01M14 6a2 2 0 1 0 0 .01M14 18a2 2 0 1 0 0 .01",
  chevron: "m8 5 5 5-5 5",
  down: "m6 8 4 4 4-4",
  search: "m14 14 4 4M8.5 15a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z",
  check: "m4 10 4 4 8-8",
  circle: "M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  plus: "M10 4v12M4 10h12",
  note: "M17 13a2 2 0 0 1-2 2H8l-5 3V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8ZM6 7h8M6 10h5",
  open: "M7 3H3v14h14v-4M10 3h7v7M9 11l8-8",
  upload: "M10 13V2m-4 4 4-4 4 4M3 12v5h14v-5",
  copy: "M7 7h10v11H7zM13 7V2H2v11h5",
  download: "M10 2v11m-4-4 4 4 4-4M3 15v3h14v-3",
  close: "m5 5 10 10M15 5 5 15",
  split: "M2 3h16v14H2zM10 3v14",
  unified: "M2 3h16v14H2zM5 7h10M5 10h10M5 13h6",
  refresh: "M17 7a7 7 0 1 0 0 6M17 2v5h-5",
  sun: "M10 1v2m0 14v2M1 10h2m14 0h2M3.6 3.6 5 5m10 10 1.4 1.4M3.6 16.4 5 15m10-10 1.4-1.4M14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M17 12A7.5 7.5 0 0 1 8 3a7.5 7.5 0 1 0 9 9Z",
  folder: "M2 5h6l2 2h8v10H2z",
  terminal: "m4 6 4 4-4 4M11 14h5",
  left: "m12 5-5 5 5 5",
  right: "m8 5 5 5-5 5",
  files: "M6 2h7l4 4v12H6zM13 2v5h4M3 5v12",
  panel: "M2 3h16v14H2zM7 3v14",
  keyboard:
    "M2 5h16v11H2zM5 8h.01M8 8h.01M11 8h.01M14 8h.01M5 11h.01M8 11h.01M11 11h.01M14 11h.01M6 14h7",
  trash: "M3 5h14M7 5V2h6v3M5 5l1 13h8l1-13M8 8v7m4-7v7",
} as const;

export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 18,
  className = "",
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function Mark() {
  return (
    <svg
      className="brand-mark"
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      <rect x="1" y="1" width="26" height="26" rx="7" fill="currentColor" />
      <path
        d="M8 9h12M8 14h8M8 19h12"
        stroke="var(--surface)"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M17 12v4m-2-2h4" stroke="var(--surface)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
