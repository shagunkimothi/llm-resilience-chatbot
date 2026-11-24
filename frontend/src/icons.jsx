const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
}

export const PlusIcon = () => (
  <svg {...base}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
export const ArrowUpIcon = () => (
  <svg {...base}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
)
export const MenuIcon = () => (
  <svg {...base}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
)
export const CloseIcon = () => (
  <svg {...base}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)
export const ChevronIcon = () => (
  <svg {...base} className="chevron">
    <path d="M6 9l6 6 6-6" />
  </svg>
)
export const ChatIcon = () => (
  <svg {...base} width={16} height={16}>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
  </svg>
)
export const BrandIcon = () => (
  <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-4.5 3.6A.6.6 0 0 1 6.5 20v-3H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill="#fff" />
    <circle cx="8.5" cy="10.5" r="1.3" fill="#7c5cfc" />
    <circle cx="12" cy="10.5" r="1.3" fill="#7c5cfc" />
    <circle cx="15.5" cy="10.5" r="1.3" fill="#7c5cfc" />
  </svg>
)
export const SparkIcon = () => (
  <svg {...base}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />
  </svg>
)
export const DatabaseIcon = () => (
  <svg {...base}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </svg>
)
export const ShuffleIcon = () => (
  <svg {...base}>
    <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
  </svg>
)
