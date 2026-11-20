// Internal to the package: the index does not re-export this module. `buildProfile`'s doc states the
// rule for consumers, and a live set in the public API could be changed at runtime through a cast.

/**
 * The top-level profile fields `buildProfile` manages: the fields it writes, plus `keyAgreement`,
 * which it drops. Every other top-level field of `ProfileInput.supersedes` is carried into the new
 * profile (see `buildProfile`).
 */
export const PROFILE_OWNED_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "version",
  "handles",
  "displayName",
  "avatar",
  "devices",
  "revoked",
  "services",
  "updated",
  "proof",
  "keyAgreement",
]);
