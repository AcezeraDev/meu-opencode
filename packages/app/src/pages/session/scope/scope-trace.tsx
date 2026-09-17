import "./scope.css"

/**
 * The response signature: while the agent works, an RGB trace runs around the chat
 * panel's edge. Every moving layer only rotates (compositor work), and the halo's
 * blur is applied to the layer before it rotates, so nothing repaints per frame.
 */
export function ScopeTrace(props: { active: boolean }) {
  return (
    <div class="scope-trace" data-active={props.active ? "" : undefined} aria-hidden="true">
      <div class="scope-trace-halo">
        <span class="scope-trace-beam" />
        <span class="scope-trace-beam scope-trace-comet" />
      </div>
      <div class="scope-trace-ring">
        <span class="scope-trace-beam" />
        <span class="scope-trace-beam scope-trace-comet" />
      </div>
    </div>
  )
}
