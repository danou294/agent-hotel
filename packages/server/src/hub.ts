import type { HotelEvent } from "@hotel/shared";
import type { WebSocket } from "@fastify/websocket";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type HotelEventInput = DistributiveOmit<HotelEvent, "ts"> & { ts?: number };

export interface SeqEvent {
  seq: number;
  event: HotelEvent;
}

/**
 * Bus d'événements : diffuse aux spectateurs WebSocket et garde un historique
 * récent que les agents (via l'API / le MCP) peuvent consulter par numéro de séquence.
 */
export class Hub {
  private sockets = new Set<WebSocket>();
  private history: SeqEvent[] = [];
  private seq = 0;
  private readonly maxHistory = 1000;

  addSocket(ws: WebSocket) {
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    ws.on("error", () => this.sockets.delete(ws));
  }

  get lastSeq() {
    return this.seq;
  }

  emit(event: HotelEventInput): SeqEvent {
    const full = { ...event, ts: event.ts ?? Date.now() } as HotelEvent;
    const item: SeqEvent = { seq: ++this.seq, event: full };
    this.history.push(item);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    const payload = JSON.stringify(full);
    for (const ws of this.sockets) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
    return item;
  }

  since(seq: number, filter?: (e: HotelEvent) => boolean): SeqEvent[] {
    const out = this.history.filter((e) => e.seq > seq);
    return filter ? out.filter((e) => filter(e.event)) : out;
  }

  get spectatorCount() {
    return this.sockets.size;
  }
}
