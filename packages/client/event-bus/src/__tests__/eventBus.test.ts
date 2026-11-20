import { describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "../eventBus";

type Events = {
  ping: { n: number };
  pong: string;
};

describe("TypedEventBus", () => {
  it("delivers a payload to every registered handler", () => {
    const bus = new TypedEventBus<Events>();
    const a = vi.fn();
    const b = vi.fn();
    bus.on("ping", a);
    bus.on("ping", b);
    bus.emit("ping", { n: 7 });
    expect(a).toHaveBeenCalledWith({ n: 7 });
    expect(b).toHaveBeenCalledWith({ n: 7 });
  });

  it("unsubscribe detaches a handler; other events are unaffected", () => {
    const bus = new TypedEventBus<Events>();
    const handler = vi.fn();
    const off = bus.on("pong", handler);
    off();
    bus.emit("pong", "x");
    expect(handler).not.toHaveBeenCalled();
  });

  it("once fires exactly one time", () => {
    const bus = new TypedEventBus<Events>();
    const handler = vi.fn();
    bus.once("ping", handler);
    bus.emit("ping", { n: 1 });
    bus.emit("ping", { n: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing handler so the others still run", () => {
    const bus = new TypedEventBus<Events>();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    bus.on("ping", bad);
    bus.on("ping", good);
    expect(() => bus.emit("ping", { n: 0 })).not.toThrow();
    expect(good).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("clear() detaches all handlers", () => {
    const bus = new TypedEventBus<Events>();
    const handler = vi.fn();
    bus.on("ping", handler);
    bus.clear();
    bus.emit("ping", { n: 1 });
    expect(handler).not.toHaveBeenCalled();
  });
});
