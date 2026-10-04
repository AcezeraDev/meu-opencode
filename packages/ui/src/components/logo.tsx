import { type ComponentProps, createUniqueId } from "solid-js"

/*
 * Lynx Code: a command prompt (>_) lit inside a cyan-to-indigo circle. The
 * same drawing as branding/lynx-code.svg, without the app icon's navy tile so
 * it sits on any ground.
 */

const CYAN = "#22D3EE"
const INDIGO = "#6366F1"

function Disc(props: { id: string }) {
  return (
    <>
      <defs>
        <radialGradient id={props.id} cx="0.5" cy="0.38" r="0.65">
          <stop offset="0" stop-color={CYAN} />
          <stop offset="1" stop-color={INDIGO} />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="21" fill={`url(#${props.id})`} />
      <path
        d="M22 24 L30 31 L22 38"
        fill="none"
        stroke="#FFFFFF"
        stroke-width="4.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <path d="M33 40 H43" stroke="#FFFFFF" stroke-width="4.5" stroke-linecap="round" />
    </>
  )
}

export const Mark = (props: { class?: string }) => {
  const id = createUniqueId()
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="11 11 42 42"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <Disc id={`lynx-mark-${id}`} />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  const id = createUniqueId()
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="11 11 42 42"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <Disc id={`lynx-splash-${id}`} />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  const id = createUniqueId()
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="11 11 262 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <Disc id={`lynx-logo-${id}`} />
      <text
        x="64"
        y="45.5"
        font-size="36"
        font-weight="700"
        letter-spacing="-1"
        style={{ "font-family": "var(--font-family-sans, system-ui, sans-serif)" }}
        fill="var(--icon-strong-base, currentColor)"
      >
        lynx code
      </text>
    </svg>
  )
}
