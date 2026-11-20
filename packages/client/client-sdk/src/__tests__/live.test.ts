/**
 * live.ts: the socket wiring, against an injected socket factory. The factory is the seam that keeps
 * socket.io-client out of the SDK, so this suite drives a fake socket by hand: fire `connect`, check
 * what the channel emitted.
 */
import { formatUnderstands, type OpEnvelope } from "@beaconsgg/protocol-types";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "../client";
import { pushCells, type LiveConnect, type LiveSocket, type LiveSocketOptions } from "../live";

/** A socket whose events a test fires by hand, recording every emit. */
class FakeSocket implements LiveSocket {
  connected = false;
  readonly emitted: [string, unknown][] = [];
  private readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: string, listener: (...args: never[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener as (...args: unknown[]) => void);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, payload?: unknown): this {
    this.emitted.push([event, payload]);
    return this;
  }
  disconnect(): this {
    this.connected = false;
    return this;
  }
  /** The server side: fire `event` at every listener. */
  fire(event: string, ...args: unknown[]): void {
    if (event === "connect") this.connected = true;
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
}

/** A factory that hands out fake sockets and remembers what each was opened with. */
function fakeConnect() {
  const opened: { url: string; options: LiveSocketOptions; socket: FakeSocket }[] = [];
  const connect: LiveConnect = (url, options) => {
    const socket = new FakeSocket();
    opened.push({ url, options, socket });
    return socket;
  };
  return { connect, opened };
}

describe("opening a socket", () => {
  it("declares the configured codes in the handshake, on websocket only", () => {
    const { connect, opened } = fakeConnect();
    createClient({ connect, understands: ["code:clockSkew"] }).subscribeRoom(
      "http://srv",
      "r",
      () => {},
    );
    expect(opened[0]?.url).toBe("http://srv");
    expect(opened[0]?.options).toStrictEqual({
      transports: ["websocket"],
      auth: { understands: formatUnderstands(["code:clockSkew"]) },
    });
  });

  it("names the client's game in every socket's handshake, which scopes what it receives", () => {
    const { connect, opened } = fakeConnect();
    const client = createClient({ connect, understands: ["code:clockSkew"], game: "kites" });
    client.subscribeRoom("http://srv", "r", () => {});
    client.subscribeMap(
      "http://srv",
      () => [],
      () => {},
    );
    client.subscribeMailbox(
      "http://srv",
      () => ({}) as never,
      () => {},
    );
    for (const { options } of opened) {
      expect(options.auth).toStrictEqual({
        understands: formatUnderstands(["code:clockSkew"]),
        game: "kites",
      });
    }
    expect(opened[0]?.options.auth).not.toBe(opened[1]?.options.auth);
  });

  it("declares nothing when the client configured nothing, as on REST", () => {
    const { connect, opened } = fakeConnect();
    createClient({ connect }).subscribeRoom("http://srv", "r", () => {});
    expect(opened[0]?.options.auth).toStrictEqual({});
  });

  it("hands every socket its own options, since socket.io writes into them", () => {
    const { connect, opened } = fakeConnect();
    const client = createClient({ connect, understands: [] });
    client.subscribeRoom("http://a", "r", () => {});
    client.subscribeRoom("http://b", "r", () => {});
    expect(opened[0]?.options).not.toBe(opened[1]?.options);
  });

  it("calls the factory as a plain function", () => {
    const connect = vi.fn(function (this: unknown): LiveSocket {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return new FakeSocket();
    });
    expect(() =>
      createClient({ connect }).subscribeRoom("http://srv", "r", () => {}),
    ).not.toThrow();
  });

  it("says what is missing when no factory was configured", () => {
    expect(() => createClient().subscribeRoom("http://srv", "r", () => {})).toThrow(
      "pass `connect` to createClient",
    );
  });
});

describe("the room channel", () => {
  it("subscribes on every connect, delivers deltas, and reports reconnects only", () => {
    const { connect, opened } = fakeConnect();
    const onDelta = vi.fn();
    const onReconnect = vi.fn();
    createClient({ connect }).subscribeRoom("http://srv", "r@srv", onDelta, onReconnect);
    const socket = opened[0]!.socket;

    socket.fire("connect");
    expect(socket.emitted).toEqual([["subscribe", { room: "r@srv" }]]);
    expect(onReconnect).not.toHaveBeenCalled();

    socket.fire("delta", { version: 2 });
    expect(onDelta).toHaveBeenCalledWith({ version: 2 });

    socket.fire("connect");
    expect(socket.emitted).toEqual([
      ["subscribe", { room: "r@srv" }],
      ["subscribe", { room: "r@srv" }],
    ]);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});

describe("the map channel", () => {
  it("re-declares the current cells on every connect and reports reconnects only", () => {
    const { connect, opened } = fakeConnect();
    let cells = ["9q8yy"];
    const onMap = vi.fn();
    const onReconnect = vi.fn();
    createClient({ connect }).subscribeMap("http://srv", () => cells, onMap, onReconnect);
    const socket = opened[0]!.socket;

    socket.fire("connect");
    cells = ["9q8yz"];
    socket.fire("connect");
    expect(socket.emitted).toEqual([
      ["setCells", { cells: ["9q8yy"] }],
      ["setCells", { cells: ["9q8yz"] }],
    ]);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    socket.fire("map", { kind: "roomGone", id: "x" });
    expect(onMap).toHaveBeenCalledWith({ kind: "roomGone", id: "x" });
  });

  it("pushCells re-declares on an open socket and does nothing on a closed one", () => {
    const socket = new FakeSocket();
    pushCells(socket, ["a"]);
    expect(socket.emitted).toEqual([]);
    socket.fire("connect");
    pushCells(socket, ["b"]);
    expect(socket.emitted).toEqual([["setCells", { cells: ["b"] }]]);
  });
});

describe("the mailbox channel", () => {
  it("opens the /mailbox namespace and signs a fresh subscribe on every connect", () => {
    const { connect, opened } = fakeConnect();
    let n = 0;
    const build = vi.fn(() => ({ nonce: `n${++n}` }) as unknown as OpEnvelope);
    const onMail = vi.fn();
    const onReconnect = vi.fn();
    createClient({ connect }).subscribeMailbox("http://mail", build, onMail, onReconnect);
    const socket = opened[0]!.socket;
    expect(opened[0]?.url).toBe("http://mail/mailbox");

    socket.fire("connect");
    socket.fire("connect");
    expect(socket.emitted).toEqual([
      ["mailbox:subscribe", { env: { nonce: "n1" } }],
      ["mailbox:subscribe", { env: { nonce: "n2" } }],
    ]);
    expect(onReconnect).toHaveBeenCalledTimes(1);

    socket.fire("mail", { id: "m1" });
    expect(onMail).toHaveBeenCalledWith({ id: "m1" });
  });
});
