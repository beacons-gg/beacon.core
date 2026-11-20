// @beaconsgg/jsonlogic-profile — [C] client-bound (RN-safe)
// A bounded JSONLogic profile: whitelisted ops + 4 aggregators (sum/min/max/count),
// integers only / no division, an `accept` predicate, and the conformance vectors.
// The shared client+server contract for object-modifies-object math.

export * from "./profile";
export * from "./aggregators";
export * from "./evaluate";
export * from "./accept";
export * from "./conformance";
