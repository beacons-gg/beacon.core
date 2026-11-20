// @beaconsgg/identity — [C] client-bound (RN-safe)
// Ed25519 (@noble, not node:crypto), did:key, account + device authorization,
// and offline op signing/verification. Framework-agnostic, pure TS.

export * from "./crypto";
export * from "./did";
export * from "./account";
export * from "./authorization";
export * from "./profile";
export * from "./provenance";
export * from "./descriptor";
export * from "./op";
export * from "./wallet";
// The signing vectors are deliberately absent: they ship as `@beaconsgg/identity/conformance`, so their
// fixed keys never reach app or server code through this barrel.
