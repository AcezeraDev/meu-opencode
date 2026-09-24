import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

/**
 * The WebSocket the OpenCode Browser Bridge extension connects to.
 *
 * It is a global route: the browser is one machine resource, so it carries no
 * directory and belongs to no single instance. The shared `browser.extensionToken`
 * is what authorizes it, sent as the first message, so the route itself needs no
 * credential middleware.
 */
export const BrowserBridgePaths = {
  connect: "/experimental/browser/extension",
  pdf: "/experimental/browser/pdf/:id",
  pdfFile: "/experimental/browser/pdf/:id/file",
} as const

export const BrowserBridgeApi = HttpApi.make("browser-bridge").add(
  HttpApiGroup.make("browser-bridge")
    .add(
      HttpApiEndpoint.get("connect", BrowserBridgePaths.connect, {
        success: described(Schema.Boolean, "Connected"),
        error: HttpApiError.Forbidden,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "browser.extension.connect",
          summary: "Connect the browser extension",
          description:
            "WebSocket the OpenCode Browser Bridge extension connects to so the agent can drive the user's own browser. Gated by the browser.extensionToken secret, which the extension sends as its first message.",
        }),
      ),
    )
    // A PDF the agent met while browsing, shown in the browser. The browser
    // opening it carries no credentials of this server: the unguessable id is
    // what grants access, to that one file only.
    .add(
      HttpApiEndpoint.get("pdf", BrowserBridgePaths.pdf, {
        params: { id: Schema.String },
        success: described(Schema.String, "PDF viewer page"),
        error: HttpApiError.NotFound,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "browser.pdf.viewer",
          summary: "Show a PDF the agent downloaded",
          description: "HTML page that draws a PDF the browsing agent downloaded, so the browser can show it.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("pdfFile", BrowserBridgePaths.pdfFile, {
        params: { id: Schema.String },
        success: described(Schema.String, "PDF file"),
        error: HttpApiError.NotFound,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "browser.pdf.file",
          summary: "Get a PDF the agent downloaded",
          description: "The bytes of a PDF the browsing agent downloaded.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "browser-bridge", description: "Browser extension websocket route." })),
)
