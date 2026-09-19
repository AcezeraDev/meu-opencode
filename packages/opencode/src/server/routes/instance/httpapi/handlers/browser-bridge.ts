import { Effect, Queue } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { BrowserBridge } from "@/browser/bridge"
import { BrowserBridgeApi } from "../groups/browser-bridge"

/**
 * Hands a connected extension's socket to the process-wide {@link BrowserBridge}.
 *
 * Outbound messages go through a queue drained by one writer so replies and
 * events keep their order; inbound raw frames are fed straight to the bridge,
 * which authenticates the first one and rejects a wrong token. Modeled on the
 * PTY connect handler.
 */
export const browserBridgeHandlers = HttpApiBuilder.group(BrowserBridgeApi, "browser-bridge", (handlers) =>
  Effect.succeed(
    handlers.handleRaw(
      "connect",
      Effect.fn("BrowserBridgeHttpApi.connect")(function* (ctx: { request: HttpServerRequest.HttpServerRequest }) {
        const bridge = BrowserBridge.instance()
        // Without a shared secret the bridge would trust anything on localhost.
        if (!bridge.paired) return HttpServerResponse.empty({ status: 403 })

        const socket = yield* Effect.orDie(ctx.request.upgrade)
        const write = yield* socket.writer
        const outbox = yield* Queue.unbounded<string | Socket.CloseEvent>()

        bridge.accept(
          (message) => Queue.offerUnsafe(outbox, JSON.stringify(message)),
          () => Queue.offerUnsafe(outbox, new Socket.CloseEvent(1000)),
        )

        const drain = Effect.gen(function* () {
          while (true) {
            const item = yield* Queue.take(outbox)
            yield* write(item)
            if (item instanceof Socket.CloseEvent) return
          }
        })

        yield* Effect.race(
          drain,
          socket.runRaw((message) =>
            bridge.receive(typeof message === "string" ? message : new TextDecoder().decode(message)),
          ),
        ).pipe(
          Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
          Effect.ensuring(Effect.sync(() => bridge.disconnect())),
          Effect.orDie,
        )
        return HttpServerResponse.empty()
      }),
    ),
  ),
)
