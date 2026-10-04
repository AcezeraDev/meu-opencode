import type { JSX } from "solid-js"
import "./attachment-card-v2.css"

/** The file's kind as a short tag for the card's thumbnail: PDF, MD, PNG… */
function kind(title: string) {
  const ext = title.includes(".") ? title.split(".").pop()!.toUpperCase() : ""
  return ext.length > 0 && ext.length <= 4 ? ext : "ARQ"
}

const TONES: Record<string, string> = {
  PDF: "pdf",
  PNG: "img",
  JPG: "img",
  JPEG: "img",
  GIF: "img",
  WEBP: "img",
  SVG: "img",
  MD: "doc",
  TXT: "doc",
  DOCX: "doc",
  DOC: "doc",
  CSV: "data",
  XLSX: "data",
  JSON: "data",
}

/**
 * Shared card used by v2 file and comment attachments in the composer and
 * timeline: a small thumbnail tagged with the file's kind beside its name,
 * dropping in with a little spring when it is added.
 */
export function AttachmentCardV2(props: {
  title: string
  active?: boolean
  clickable?: boolean
  wide?: boolean
  surface?: "base"
  /** native title attribute */
  hover?: string
  titleRef?: (element: HTMLSpanElement) => void
  onClick?: () => void
  children: JSX.Element
}) {
  return (
    <div
      data-component="attachment-card-v2"
      data-active={props.active ? "true" : undefined}
      data-clickable={props.clickable ? "true" : undefined}
      data-wide={props.wide ? "true" : undefined}
      data-surface={props.surface}
      title={props.hover}
      onClick={() => props.onClick?.()}
    >
      <span data-slot="attachment-card-v2-thumb" data-tone={TONES[kind(props.title)] ?? "other"} aria-hidden="true">
        {kind(props.title)}
      </span>
      <span data-slot="attachment-card-v2-text">
        <span ref={(element) => props.titleRef?.(element)} data-slot="attachment-card-v2-title">
          {props.title}
        </span>
        <span data-slot="attachment-card-v2-subtitle">{props.children}</span>
      </span>
    </div>
  )
}
