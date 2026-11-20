import canonicalize from "canonicalize";

/**
 * Serialize a value as canonical JSON (JCS, RFC 8785): the exact string Beacon signs and verifies.
 *
 * Use it when you sign, verify or hash a signed shape yourself. `@beaconsgg/identity` uses it for
 * ops, profiles, provenance and server descriptors, and converts the string to UTF-8 bytes before
 * it signs. Two rules keep a signature valid:
 *
 * - Put only safe integers in a signed number field.
 * - Leave an optional field out instead of setting it to `undefined`. Keys whose value is
 *   `undefined` are dropped from the output.
 *
 * Spec: `doc/spec/identity.md` §5.2 and §5.3. This is the `canonicalize` library's JCS. Number
 * serialization defers to the JS engine's ECMAScript Number to String conversion (through
 * `JSON.stringify`), such as `1e21` to `"1e+21"` and `-0` to `"0"`, which is what RFC 8785
 * mandates, so any conformant verifier agrees. Every party must use this same serialization.
 * `levels` keeps its numbers safe through `.safe()`; keep that true for any value placed in a
 * signed field. The wallet builds envelopes with conditional spreads because of the `undefined`
 * rule.
 *
 * @throws `Error` when `value` is `undefined` or a function at the top level, or holds `NaN` or an
 * infinite number. A `BigInt` throws a `TypeError`.
 */
export function canonicalJson(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) {
    throw new Error("canonicalJson: cannot canonicalize `undefined`");
  }
  return out;
}
