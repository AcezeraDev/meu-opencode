import { Index, Show } from "solid-js"
import "./odometer.css"

/**
 * A readout whose digits roll to their new value, one strip per digit, so a
 * number that changes shows how it changed: only the digits that moved roll,
 * and a big jump rolls many of them. Digits are matched from the right, so a
 * value that gains a digit keeps its units in place.
 */
export function Odometer(props: { value: string; class?: string }) {
  const chars = () => [...props.value].reverse()
  return (
    <span class={`odometer ${props.class ?? ""}`}>
      <span class="sr-only">{props.value}</span>
      <span class="odometer-cells" aria-hidden="true">
        <Index each={chars()}>
          {(char) => (
            <Show when={/\d/.test(char()) ? char() : undefined} fallback={<span class="odometer-sign">{char()}</span>}>
              {(digit) => (
                <span class="odometer-digit">
                  <span
                    class="odometer-strip"
                    data-motion="l"
                    style={{ transform: `translateY(${-Number(digit()) * 10}%)` }}
                  >
                    <span>0</span>
                    <span>1</span>
                    <span>2</span>
                    <span>3</span>
                    <span>4</span>
                    <span>5</span>
                    <span>6</span>
                    <span>7</span>
                    <span>8</span>
                    <span>9</span>
                  </span>
                </span>
              )}
            </Show>
          )}
        </Index>
      </span>
    </span>
  )
}
