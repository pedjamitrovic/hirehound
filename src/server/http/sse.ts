import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerEvent } from "../../shared/schemas/api.ts";

/** Server-Sent Events fan-out: index changes and (later) task progress to every open tab. */
export class SseHub {
  #clients = new Set<ServerResponse>();
  #heartbeat: NodeJS.Timeout;

  constructor(heartbeatMs = 20_000) {
    this.#heartbeat = setInterval(() => {
      for (const res of this.#clients) res.write(": ping\n\n");
    }, heartbeatMs);
    this.#heartbeat.unref();
  }

  get size(): number {
    return this.#clients.size;
  }

  add(req: IncomingMessage, res: ServerResponse, initial: ServerEvent[] = []): void {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    for (const event of initial) res.write(format(event));
    this.#clients.add(res);
    req.on("close", () => this.#clients.delete(res));
  }

  broadcast(event: ServerEvent): void {
    const message = format(event);
    for (const res of this.#clients) res.write(message);
  }

  close(): void {
    clearInterval(this.#heartbeat);
    for (const res of this.#clients) res.end();
    this.#clients.clear();
  }
}

function format(event: ServerEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
