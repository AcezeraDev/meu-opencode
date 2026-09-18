import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit(eventName: "event", event: GlobalEvent): boolean
  // Newer EventEmitter typings declare emit generically over every event name,
  // so an override has to accept that shape too; callers still get the typed
  // overload above.
  override emit(eventName: string | symbol, ...args: any[]): boolean
  override emit(eventName: string | symbol, ...args: any[]): boolean {
    const event = args[0] as GlobalEvent | undefined
    if (eventName === "event" && event?.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName as "event", ...(args as [GlobalEvent]))
  }
}

export const GlobalBus = new GlobalBusEmitter()
