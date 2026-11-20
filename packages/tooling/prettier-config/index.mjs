/**
 * The Prettier options every Beacon repo formats with. A repo names this package in its
 * root manifest (`"prettier": "@beaconsgg/prettier-config"`); one that differs on purpose spreads it
 * in a `prettier.config.mjs` and says what it changes, as a game's app may for its line width.
 *
 * @type {import("prettier").Config}
 */
export default {
  semi: true,
  singleQuote: false,
  printWidth: 100,
  tabWidth: 2,
  trailingComma: "all",
};
