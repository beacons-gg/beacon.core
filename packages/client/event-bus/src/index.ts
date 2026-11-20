// @beaconsgg/event-bus — [C] client-bound (RN-safe)
//
// A minimal typed pub/sub event bus that any client framework can use. It ships the core the apps
// use: a typed event map, `on`/`once`/`off`/`emit`/`clear`, and isolated dispatch (one throwing
// handler can't wedge the others). Middleware, payload validation, a handler registry and a
// transport are left out; a consumer that needs one wraps the bus (see the package README).
//
// Pure TS, no Node built-ins → safe to import from the Expo/RN client.

export * from "./eventBus";
