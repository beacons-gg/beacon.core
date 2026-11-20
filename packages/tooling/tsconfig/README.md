# @beaconsgg/tsconfig

The compiler options every Beacon workspace builds with. The server, the games, the operator console
and the core packages live in separate repositories. This preset keeps their strictness the same.
Add `"@beaconsgg/tsconfig"` to a workspace's `devDependencies`, extend the preset by name and add
only the options that belong to the workspace:

```json
{
  "extends": "@beaconsgg/tsconfig/base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"]
}
```

`base.json` emits CommonJS for ES2022 with declarations and source maps. The preset turns on these
strictness flags:

- `strict`;
- `noUncheckedIndexedAccess`;
- `exactOptionalPropertyTypes`;
- `noImplicitOverride`;
- `noFallthroughCasesInSwitch`;
- `noUnusedLocals`;
- `noUnusedParameters`.

A workspace that a bundler builds in another module format overrides `module` and `moduleResolution`
on top. The operator console and its plugins do this. No workspace loosens a strictness flag.

An Expo app extends `expo/tsconfig.base` instead, because Metro and Expo's tooling expect that
config. Such an app repeats the strictness flags in its own `tsconfig.json`.

`client.json` extends `base.json` with the host library (`lib: ["ES2022", "DOM"]`). Use
`client.json` for a client-bound package that relies on the globals a browser or React Native
provides and the ES library doesn't declare: `fetch`, `URL`, `TextEncoder`, `console` and timers.
`@beaconsgg/protocol-types`, `@beaconsgg/client-sdk` and `@beaconsgg/event-bus` extend
`client.json`. A server package keeps `base.json`, where `@types/node` declares those globals.

A preset is tooling and no part of the wire contract. The preset moves on the version of the seven core packages ([`doc/core-compatibility.md`](../../../doc/core-compatibility.md) §7). Tightening a flag
is a major version, since the tighter flag can fail a consumer's build.
