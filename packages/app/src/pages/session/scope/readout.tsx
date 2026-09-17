import { splitProps, type ComponentProps } from "solid-js"

/**
 * A measurement readout: digits in fixed slots so values never jitter while they
 * change, with the unused leading zeros drawn as faint ghost segments.
 */
export function Readout(props: ComponentProps<"span"> & { value: number; digits: number; decimals?: number }) {
  const [local, rest] = splitProps(props, ["value", "digits", "decimals", "class"])
  const parts = () => {
    const fixed = Math.max(0, Number.isFinite(local.value) ? local.value : 0).toFixed(local.decimals ?? 0)
    const [whole, fraction] = fixed.split(".")
    const padded = whole.padStart(local.digits, "0")
    const lit = whole === "0" ? 1 : whole.length
    return { ghost: padded.slice(0, padded.length - lit), lit: padded.slice(padded.length - lit), fraction }
  }
  return (
    <span {...rest} class={`scope-readout ${local.class ?? ""}`}>
      <span class="scope-readout-ghost">{parts().ghost}</span>
      {parts().lit}
      {parts().fraction !== undefined ? `.${parts().fraction}` : ""}
    </span>
  )
}

/** mm:ss with ghost minutes, e.g. 00:42. */
export function ClockReadout(props: { ms: number; class?: string }) {
  const total = () => Math.max(0, Math.floor(props.ms / 1000))
  return (
    <span class={`scope-readout ${props.class ?? ""}`}>
      <Readout value={Math.floor(total() / 60)} digits={2} class="!contents" />:{String(total() % 60).padStart(2, "0")}
    </span>
  )
}
