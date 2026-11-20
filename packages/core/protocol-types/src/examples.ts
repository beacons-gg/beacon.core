import potPolicy from "./examples/pot-policy.json";
import { policySchema, type Policy } from "./room";

// `@beaconsgg/protocol-types/examples`: the example policies `doc/game-author.md` walks an author
// through, as data. Not in the barrel, like `@beaconsgg/identity/conformance`: they are there to
// be read, copied and run in tests, never shipped inside a game.
//
// Each one is held twice over. The engine's suite places and plays it exactly as the document
// describes (`game-author-example.test.ts` in `@beaconsgg/policy-engine`), and
// `scripts/check-doc-examples.mjs` checks that the policy the document shows is this file, value for
// value. Parsed here, so a file that is not a valid policy fails the moment anything loads it.

/**
 * The pot policy from the game author guide (`doc/game-author.md` §10), parsed and ready to place.
 *
 * Anyone may add a stone while the pot is open. The pot settles at most an hour after placement:
 * sooner the heavier its stones are, and never earlier than 10 minutes. Once settled, its
 * contributors may claim from it. Copy it as a starting point for a policy of your own.
 */
export const POT_POLICY: Policy = policySchema.parse(potPolicy);
