# @beaconsgg/event-bus

**`[C]` client-bound (RN-safe).** The package is a small typed publish and subscribe event bus that
any client framework can use.
A game builds its app-wide event map and its single shared bus on this package.

## What the package gives you

```ts
import { TypedEventBus, type Listener, type Unsubscribe } from "@beaconsgg/event-bus";

type AppEvents = { "net/room-delta": { room: string; version: number } };

const bus = new TypedEventBus<AppEvents>();
const off = bus.on("net/room-delta", (p) => { /* p is typed */ });
bus.emit("net/room-delta", { room: "x@h", version: 3 }); // compile-time checked
off();
```

- **Typed.** The bus is generic over a fixed event map `E` from event name to payload type. The
  compiler checks `emit`, `on`, `once` and `off` against the payload for each name.
- **Isolated dispatch.** The bus catches and logs a handler that throws, and the other handlers
  still run. One faulty subscriber can't stop the rest of the app's events.
- **Pure TypeScript with no Node built-ins.** An Expo or React Native client can import the package,
  and the ESLint RN-safety gate holds the package to that.

`clear()` detaches every handler, for test teardown or when a feature shuts down.

## What the bus doesn't do

The bus leaves out these layers:

- middleware;
- payload validation;
- a handler registry;
- an async `emitAsync`;
- a transport between servers.

A consumer that needs one of these wraps the bus. The public surface is
small and stable, so such a wrapper doesn't break the code that already uses the bus.

## Commands

```bash
pnpm --filter @beaconsgg/event-bus build       # tsc -> dist
pnpm --filter @beaconsgg/event-bus typecheck
pnpm --filter @beaconsgg/event-bus test        # vitest
```
