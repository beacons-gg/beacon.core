# @beaconsgg/prettier-config

The Prettier options every Beacon repository formats with: semicolons, double quotes, 100 columns,
two spaces and trailing commas everywhere. Name the preset in the repository's root `package.json`:

```json
{
  "prettier": "@beaconsgg/prettier-config",
  "devDependencies": { "@beaconsgg/prettier-config": "…" }
}
```

A workspace that differs on purpose spreads the preset in a `prettier.config.mjs` of its own and
names the difference:

```js
import base from "@beaconsgg/prettier-config";

export default { ...base, printWidth: 120, trailingComma: "es5" };
```

A package can't carry `.prettierignore` or `.editorconfig`, so each repository keeps its own copy.

The preset moves on the version of the seven core packages
([`doc/core-compatibility.md`](../../../doc/core-compatibility.md) §7). Changing an option reformats
every file of every consumer and is therefore a major version.
