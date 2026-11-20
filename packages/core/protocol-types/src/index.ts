// @beaconsgg/protocol-types — [C] client-bound (RN-safe)
// The wire contract: zod schemas + inferred TS types + the JCS canonical-serialization
// helper shared by signing. Framework-agnostic, pure TS.

export * from "./jcs";
export * from "./read";
export * from "./primitives";
export * from "./identity";
export * from "./mintedBy";
export * from "./mediaEntry";
export * from "./item";
export * from "./room";
export * from "./reaction";
export * from "./op";
export * from "./mailbox";
export * from "./media";
export * from "./geocode";
export * from "./places";
export * from "./admin";
export * from "./access";
export * from "./backup";
export * from "./scoutConfig";
export * from "./discovery";
export * from "./scout";
// The server-only names of these three modules are exported from `./server` instead
// (`@beaconsgg/protocol-types/server`), so each one is listed here by name.
export {
  ERROR_CODES,
  errorCodeSchema,
  type ErrorCode,
  grantReceiptSchema,
  type GrantReceipt,
  okResultSchema,
  type OkResult,
  errorResultSchema,
  type ErrorResult,
  opResultSchema,
  type OpResult,
} from "./result";
export { UNDERSTANDS_HEADER, formatUnderstands } from "./understands";
export {
  BASELINE_OPS,
  BASELINE_POLICY_FEATURES,
  BASELINE_RULE_OPERATORS,
  RULE_OPERATOR_NAMES,
  policyFeaturesOf,
  ruleOperatorsOf,
  acceptsOp,
  unsupportedPolicyFeatures,
} from "./markers";
export * from "./liveEvent";
export * from "./mapEvent";
