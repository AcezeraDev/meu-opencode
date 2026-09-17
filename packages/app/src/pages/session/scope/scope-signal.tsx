import "./scope.css"

/** A small screen with a running waveform: the "armed and acquiring" state. */
export function ScopeSignal(props: { class?: string }) {
  // Two periods side by side; sliding by one period loops without a seam.
  const wave = "M0 9 C4 1 8 1 12 9 S20 17 24 9 S32 1 36 9 S44 17 48 9 S56 1 60 9 S68 17 72 9 S80 1 84 9 S92 17 96 9"
  return (
    <span class={`scope-signal ${props.class ?? ""}`} data-chroma aria-hidden="true">
      <svg viewBox="0 0 48 18" width="48" height="18">
        <line x1="0" y1="9" x2="48" y2="9" class="scope-signal-axis" />
        <g class="scope-signal-wave">
          <path d={wave} fill="none" />
        </g>
      </svg>
    </span>
  )
}
