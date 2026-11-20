// @ts-check
/**
 * The mechanism under every gate: "these files may not import these names", spelled so that no
 * import form slips past it, with or without the RN-safety ban in the same block.
 */

/**
 * The expression forms `no-restricted-imports` cannot see: a type-position `import("x").T`, a
 * dynamic `import("x")` and a `require("x")`. It checks `import` and `export ... from` declarations
 * only, so each ban is also spelled as three `no-restricted-syntax` selectors over the same names.
 * `base` rejects every `require` anyway (`@typescript-eslint/no-require-imports`); a game app's
 * own config has that rule as a warning and uses lazy `require` as an idiom, so the third selector is
 * what holds there, and Metro bundles a `require` like an `import`.
 *
 * `names` use the `no-restricted-imports` pattern spelling (`*` is one path segment), and match their
 * subpaths too. esquery ends a regex literal at the first raw slash, so `slash` below spells every one
 * as its unicode escape instead.
 *
 * @param {string[]} names
 * @param {string} message
 */
export function importExpressionBans(names, message) {
  const slash = "\\u002F";
  const escaped = names.map((name) =>
    name
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\//g, slash)
      .replace(/\*/g, `[^${slash}]+`),
  );
  const source = `/^(${escaped.join("|")})(${slash}.*)?$/`;
  return [
    { selector: `ImportExpression[source.value=${source}]`, message },
    { selector: `TSImportType[argument.literal.value=${source}]`, message },
    { selector: `CallExpression[callee.name="require"][arguments.0.value=${source}]`, message },
  ];
}

/**
 * The RN-safety gate.
 *
 * The client-bound [C] tiers carry into the Expo/RN client and so must be RN-safe: pure TS, no Node
 * built-ins. That is every package in the `core/` wire contract + primitives, the `client/` SDK, and
 * every game tier. The `server/` packages are server-only [S] and exempt.
 */
const NODE_BUILTINS = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "crypto",
  "dgram",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
];

const rnSafetyMessage =
  "Node built-ins are banned in client-bound (RN-safe) packages. Keep this package pure TS; move Node-only code into a server package.";

const RN_SAFE_PATHS = NODE_BUILTINS.map((name) => ({ name, message: rnSafetyMessage }));
const RN_SAFE_PATTERN = { group: ["node:*"], message: rnSafetyMessage };
const RN_SAFE_EXPRESSIONS = importExpressionBans([...NODE_BUILTINS, "node:*"], rnSafetyMessage);

/**
 * A client-bound tier's gate: the RN-safety ban plus that tier's own, if it has one. Both are the
 * one rule `no-restricted-imports` (plus `no-restricted-syntax` for the expression forms), and flat
 * config replaces a rule's options when a later block names it again, so the two have to travel
 * together: split into separate blocks, whichever came first would silently stop applying.
 *
 * @param {string[]} files
 * @param {string[]} [banned]
 * @param {string} [message]
 */
export function clientBound(files, banned = [], message = "") {
  const group = unique(banned);
  const own = group.length > 0;
  return {
    files,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: RN_SAFE_PATHS,
          patterns: [RN_SAFE_PATTERN, ...(own ? [{ group, message }] : [])],
        },
      ],
      "no-restricted-syntax": [
        "error",
        ...RN_SAFE_EXPRESSIONS,
        ...(own ? importExpressionBans(group, message) : []),
      ],
    },
  };
}

/**
 * A tier gate with no RN-safety half: the same two rules over the same names, in one block for the
 * same reason as {@link clientBound}.
 *
 * A tier with nothing to ban is the normal state of a repository that holds one tier: the server's
 * has no game, client or console package in its workspace and names none as foreign. ESLint rejects
 * an empty `patterns` list, so that block sets both rules off instead, which also says what it
 * means: nothing is banned here, and no earlier block's bans stand in for the tier's own (flat
 * config replaces a rule's options per block).
 *
 * @param {string[]} files
 * @param {string[]} banned
 * @param {string} message
 */
export function tierBound(files, banned, message) {
  const group = unique(banned);
  if (group.length === 0) {
    return { files, rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" } };
  }
  return {
    files,
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ group, message }] }],
      "no-restricted-syntax": ["error", ...importExpressionBans(group, message)],
    },
  };
}

/**
 * A ban list with each name once: `no-restricted-imports` rejects a duplicate in a group, and a name
 * can arrive by two routes (a game's plugin is both "another game's package" and "a console plugin"
 * to an app that belongs to no game tier).
 *
 * @param {string[]} names
 */
export const unique = (names) => [...new Set(names)];

/**
 * The RN-safety gate alone, for a repo whose client-bound code has no tier ban to add: no Node
 * built-in, in any import form.
 *
 * @param {string[]} files
 */
export const rnSafe = (files) => clientBound(files);
