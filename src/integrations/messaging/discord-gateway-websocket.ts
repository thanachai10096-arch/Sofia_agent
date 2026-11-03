import type { DiscordGatewaySocket } from "./discord-gateway-transport.js";

interface NodeWebSocketLike {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason?: string }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
type WebSocketConstructor = new (url: string) => NodeWebSocketLike;

/**
 * Uses Node's built-in WebSocket implementation (Node 22+). The wrapper keeps
 * the Gateway protocol independent from a particular socket library and avoids
 * adding an unneeded runtime dependency to the package.
 */
export function createNodeDiscordGatewaySocket(url: string): DiscordGatewaySocket {
  const Constructor = (globalThis as typeof globalThis & { WebSocket?: WebSocketConstructor }).WebSocket;
  if (typeof Constructor !== "function") {
    throw new Error("Discord Gateway requires Node.js 22 or newer with the built-in WebSocket API.");
  }
  const socket = new Constructor(url);
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of listeners.get(event) ?? []) {
      try { listener(...args); } catch { /* consumer callbacks cannot break the socket event loop */ }
    }
  };
  socket.addEventListener("open", () => emit("open"));
  socket.addEventListener("message", (event) => {
    const data = event.data;
    if (data && typeof data === "object" && "text" in data &&
        typeof (data as { text?: unknown }).text === "function") {
      void (data as { text(): Promise<string> }).text().then((value) => emit("message", value)).catch(() => undefined);
      return;
    }
    emit("message", data);
  });
  socket.addEventListener("close", (event) => emit("close", event.code, event.reason));
  socket.addEventListener("error", (event) => emit("error", event));
  return {
    on(event, listener) {
      const current = listeners.get(event) ?? [];
      current.push(listener as (...args: unknown[]) => void);
      listeners.set(event, current);
      return this;
    },
    send(data) { socket.send(data); },
    close(code, reason) { socket.close(code, reason); },
  };
}
