// @beaconsgg/geo — [C] client-bound (RN-safe)
// Geohash coverage + cell queries: the client computes query cells; the server indexes
// rooms and tests coverage. Framework-agnostic, pure TS (wraps ngeohash).

export * from "./geohash";
export * from "./coverage";
export * from "./spatial";
export * from "./contains";
export * from "./contains-conformance";
