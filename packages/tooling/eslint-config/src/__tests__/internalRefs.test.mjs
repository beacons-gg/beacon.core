// beacon-internal-refs: pattern data. The fixtures below are the references the check must find.
/**
 * The internal-reference check: the comment lexer, each rule against what it must and must not
 * match, and the scan of a made-up git repo with what it skips, what its manifest allows and how
 * the bin reports.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  DIRECTIVE,
  lex,
  langOf,
  main,
  namesOf,
  publicUrlsOf,
  readConfig,
  readPatterns,
  scanRepo,
  scanText,
  skipReason,
  withoutPatterns,
} from "../../scripts/internal-refs.mjs";
import { gitRepo, runMain } from "./repo.mjs";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const repoRoot = resolve(packageDir, "../../..");
const BIN = join(packageDir, "scripts/check-internal-refs.mjs");

/** A made-up repo's private names, as its manifest or a `--patterns` file would list them. */
const PRIVATE = {
  orgNames: ["acme.dev", "acme-mono", "acme-plans", "AcmeCorp"],
  privateDocs: ["widgets-v2.md", "accounts.md", "sketch.md", "kickoff-handoff.md", "search.md"],
  people: ["Robin"],
  allow: ["AcmeCorp LLC"],
};
const NAMES = namesOf(readPatterns(PRIVATE, "test"));
const NO_NAMES = { publicDocs: new Set(), names: namesOf(readPatterns({}, "test")) };
const NO_CONTEXT = { publicDocs: new Set(), names: NAMES };
/** `context` with the made-up names. */
const withNames = (context) => ({ ...context, names: NAMES });

/** What each rule finds in `text`, read as the file at `path`, as `rule: match` strings. */
const found = (path, text, context = NO_CONTEXT) =>
  scanText(path, text, context).map((f) => `${f.rule}: ${f.match}`);

const scratch = mkdtempSync(join(tmpdir(), "internal-refs-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const run = (dir, args) => runMain(main, dir, args);

describe("lex", () => {
  const ts = langOf("a.ts");
  const comments = (text, lang = ts) => lex(text, lang).comments.trim().split(/\s+/).join(" ");

  it("keeps line and block comments in place, and blanks the code", () => {
    const text = "const a = 1; // one\n/* two\n three */ const b = 2;\n";
    const kept = lex(text, ts).comments;
    expect(kept).toHaveLength(text.length);
    expect(kept.split("\n").map((l) => l.trim())).toEqual(["// one", "/* two", "three */", ""]);
  });

  it("reads no comment inside a string, a template or a regex literal", () => {
    expect(comments(`const url = "https://x.example"; const q = 'a // b';`)).toBe("");
    expect(comments("const t = `a ${f(`b // c`)} // d ${'e'}`; // f")).toBe("// f");
    expect(comments("const r = /\\/\\//g; const s = x.replace(/[/]/, ''); // g")).toBe("// g");
    expect(comments("const d = a / b; // h\nreturn /#1/.test(c); // i")).toBe("// h // i");
    expect(comments("const e = `${{ a: 1 }.a}`; // j")).toBe("// j");
    expect(comments("const f = a++ / 2; // k / l")).toBe("// k / l");
  });

  it("keeps string and template contents too when asked", () => {
    const kept = lex('it("names #12", () => `x ${y} z`); // c', ts).text;
    // The quotes stay, so a rule can tell `"#123"` (a whole string) from a reference inside one.
    expect(kept.trim().split(/\s+/)).toEqual(['"names', '#12"', "`x", "${", "}", "z`", "//", "c"]);
  });

  it("tells an apostrophe from a quote, and a hash comment from a hash in a value", () => {
    const yaml = langOf("ci.yml");
    expect(comments("name: Robin's job # a comment\nurl: x#y\nv: '#z' # b", yaml)).toBe(
      "# a comment # b",
    );
    expect(comments("echo ${#list[@]} # count", langOf("run.sh"))).toBe("# count");
    expect(comments("x = f\"#1\" + rb'#2' # m", langOf("a.py"))).toBe("# m");
  });

  it("knows each language's markers", () => {
    expect(comments("a { b: url(http://x); } /* c */", langOf("a.css"))).toBe("/* c */");
    expect(comments("a { b: c; } // d", langOf("a.scss"))).toBe("// d");
    expect(comments("select 1; -- e", langOf("0001_init.sql"))).toBe("-- e");
    expect(comments("<p>f</p><!-- g -->", langOf("icon.svg"))).toBe("<!-- g -->");
    expect(comments("<!-- g --><script>\n// h\n</script>", langOf("App.vue"))).toBe(
      "<!-- g --> // h",
    );
    expect(comments("FROM node # h", langOf("Dockerfile"))).toBe("# h");
    expect(comments("dist # i", langOf(".gitignore"))).toBe("# i");
    expect(comments("let a = 'x // unterminated\n// j", ts)).toBe("// j");
    expect(comments("/* never closed", ts)).toBe("/* never closed");
  });

  it("reads prose and unknown files whole", () => {
    for (const path of ["README.md", "package.json", "public-api.txt", "LICENSE"]) {
      expect(langOf(path)).toBeUndefined();
    }
  });
});

describe("the rules", () => {
  it("finds the organization, its registry and its private repos anywhere", () => {
    expect(
      found(
        "package.json",
        '"url": "https://github.com/AcmeCorp/x.git", "registry": "https://packages.acme.dev/"',
      ),
    ).toEqual(["org-names: AcmeCorp", "org-names: acme.dev"]);
    expect(found("a.ts", 'const repo = "acme-mono"; // see acme-plans')).toEqual([
      "org-names: acme-mono",
      "org-names: acme-plans",
    ]);
  });

  it("knows no private name of its own: the names rules match only what a repo lists", () => {
    const text = "// AcmeCorp, acme.dev, Robin, sketch.md and search.md";
    expect(found("a.ts", text, NO_NAMES)).toEqual([]);
    expect(found("a.ts", text)).toEqual([
      "org-names: AcmeCorp",
      "org-names: acme.dev",
      "private-docs: sketch.md",
      "private-docs: search.md",
      "people: Robin",
    ]);
  });

  it("finds nothing inside an allowed phrase, whatever the rule", () => {
    expect(found("NOTICE", "Copyright 2026 AcmeCorp LLC (#12)")).toEqual(["issue-refs: #12"]);
    // The phrase is exact: another case, or the name outside the phrase, still counts.
    expect(found("NOTICE", "ACMECORP LLC and AcmeCorp, AcmeCorp LLC")).toEqual([
      "org-names: ACMECORP",
      "org-names: AcmeCorp",
    ]);
    const allowRef = namesOf(readPatterns({ allow: ["see #12"] }, "test"));
    expect(
      found("README.md", "see #12, not #13", { publicDocs: new Set(), names: allowRef }),
    ).toEqual(["issue-refs: #13"]);
  });

  it("finds issue and pull request references in comments, strings and prose", () => {
    expect(found("a.ts", "// fixed in #12, and AcmeCorp/widgets#7 (#104)")).toEqual([
      "org-names: AcmeCorp",
      "issue-refs: #12",
      "issue-refs: AcmeCorp/widgets#7",
      "issue-refs: #104",
    ]);
    expect(found("a.test.ts", 'it("holds the cap (#175)", () => {});')).toEqual([
      "issue-refs: #175",
    ]);
    expect(found("ci.yml", "on: push # since #55")).toEqual(["issue-refs: #55"]);
    expect(found("README.md", "Shipped in #9.")).toEqual(["issue-refs: #9"]);
    expect(found("a.ts", "// the pre-#26 way")).toEqual(["issue-refs: #26"]);
  });

  it("never reads a color, an anchor, an entity or code as an issue reference", () => {
    const notRefs = [
      ["a.css", "a { color: #123; background: #123456 } /* #000, #0f0 and #1a2b3c */"],
      ["a.ts", 'const c = "#123"; const d = { fill: "#999" }; const e = x.#field1;'],
      ["a.ts", 'const css = ":root{--a:#131316;--b: #212126}"; const tw = "bg-[#131]";'],
      ["a.ts", "const n = items.length; // the list's #1abc color and #123456"],
      ["page.html", '<a href="#1">&#123;</a><rect fill=#123 />'],
      ["README.md", "See [setup](#setup), `color: #333;` and #1234567."],
      ["a.ts", "if (a #1) {}"],
      ["a.ts", "// https://example.com/docs#12 and page#3"],
    ];
    for (const [path, text] of notRefs) expect(found(path, text), text).toEqual([]);
  });

  it("finds a private doc by name, with its section, anywhere", () => {
    expect(found("a.ts", "// widgets-v2.md §7 and docs/accounts.md")).toEqual([
      "private-docs: widgets-v2.md §7",
      "private-docs: accounts.md",
    ]);
    expect(found("a.ts", 'const doc = "sketch.md";')).toEqual(["private-docs: sketch.md"]);
    expect(found("README.md", "game-sketch.md and SKETCH.MD.bak")).toEqual([]);
  });

  it("finds a section of a doc the repo does not ship, and leaves its own docs alone", () => {
    expect(
      found("a.ts", "// release-plan §6.2, kickoff-handoff.md §4.5, v2/reactions §3, see §4"),
    ).toEqual([
      "private-docs: release-plan §6.2",
      "private-docs: kickoff-handoff.md §4.5",
      "private-docs: v2/reactions §3",
    ]);
    const shipped = withNames({ publicDocs: new Set(["core-compatibility.md"]) });
    expect(found("a.ts", "// doc/core-compatibility.md §7 (§3)", shipped)).toEqual([]);
  });

  it("lets a doc through once it is published, or once the repo ships it", () => {
    const published = withNames({ publicDocs: new Set(["sketch.md"]) });
    expect(found("a.ts", "// sketch.md §4, search.md §3", published)).toEqual([
      "private-docs: search.md §3",
    ]);
    const shipped = withNames({ publicDocs: new Set(["accounts.md"]) });
    expect(found("README.md", "accounts.md §10", shipped)).toEqual([]);
  });

  it("lets a doc through when it is linked in the public organization", () => {
    const context = withNames({ publicDocs: new Set(), publicUrls: publicUrlsOf("beacons-gg") });
    const spec =
      "https://github.com/beacons-gg/beacon.server/blob/main/doc/spec/kickoff-handoff.md";
    expect(found("README.md", `See [the spec](${spec}#joins) §6.2.`, context)).toEqual([]);
    expect(found("a.ts", `// ${spec} §6.2`, context)).toEqual([]);
    for (const link of [
      "https://beacons-gg.github.io/docs/accounts.md",
      "https://raw.githubusercontent.com/beacons-gg/x/main/accounts.md",
    ]) {
      expect(found("README.md", link, context), link).toEqual([]);
    }
    // The same doc anywhere else, or linked in another organization, still counts.
    expect(
      found(
        "README.md",
        "kickoff-handoff.md, https://github.com/beacons-gg-old/x/blob/main/accounts.md and " +
          "https://example.com/beacons-gg/sketch.md (https://github.com/beacons-gg/x)",
        context,
      ),
    ).toEqual([
      "private-docs: kickoff-handoff.md",
      "private-docs: accounts.md",
      "private-docs: sketch.md",
    ]);
    expect(found("README.md", `See ${spec}.`)).toEqual(["private-docs: kickoff-handoff.md"]);
  });

  it("finds internal phase and decision wording in comments and prose", () => {
    expect(
      found("a.ts", "// the release-1 decision (decision 16), P1, P2.4 of track P, phase 3"),
    ).toEqual([
      "phase-wording: release-1 decision",
      "phase-wording: decision 16",
      "phase-wording: P1",
      "phase-wording: P2.4",
      "phase-wording: track P",
      "phase-wording: phase 3",
    ]);
    expect(found("README.md", "Reserved for Phase 2.")).toEqual(["phase-wording: Phase 2"]);
  });

  it("never reads phase wording into code, a Wikidata property or an ordinary word", () => {
    const notWording = [
      ["a.ts", 'const P1 = phase(2); const claim = "P649"; const p = "track P";'],
      ["a.ts", "// the P649 claim, a P2P link, keep track of it, the next phase"],
      ["README.md", "Tracks A and B; a decision is made."],
    ];
    for (const [path, text] of notWording) expect(found(path, text), text).toEqual([]);
  });

  it("finds people's names anywhere, in any word they begin", () => {
    expect(found("a.ts", 'const author = "RobinOnGit"; // asked Robin')).toEqual([
      "people: Robin",
      "people: Robin",
    ]);
    expect(found("README.md", "In /home/robin/ and ROBIN, not Robins")).toEqual([
      "people: robin",
      "people: ROBIN",
    ]);
  });

  it("gives each finding its file and line", () => {
    expect(scanText("src/a.ts", "const a = 1;\n// #7\n", NO_CONTEXT)).toEqual([
      { rule: "issue-refs", file: "src/a.ts", line: 2, match: "#7" },
    ]);
  });
});

describe("skipReason", () => {
  it("skips lockfiles and generated output by path, and nothing else", () => {
    expect(skipReason("pnpm-lock.yaml")).toBe("lockfile");
    expect(skipReason("apps/web/package-lock.json")).toBe("lockfile");
    expect(skipReason("packages/a/dist/index.js")).toBe("generated");
    expect(skipReason("src/__snapshots__/a.test.ts.snap")).toBe("generated");
    expect(skipReason("public/app.min.js")).toBe("generated");
    // A binary file is told by its content, in scanRepo.
    expect(skipReason("app/fonts/Inter.woff2")).toBeUndefined();
    expect(skipReason("src/lockfile.ts")).toBeUndefined();
    expect(skipReason("scripts/build/release.mjs")).toBeUndefined();
    expect(skipReason("README.md")).toBeUndefined();
  });
});

describe("readConfig", () => {
  it("reads the published docs from the root manifest", () => {
    const dir = join(scratch, "config");
    mkdirSync(dir, { recursive: true });
    const none = { orgNames: [], privateDocs: [], people: [], allow: [] };
    expect(readConfig(dir)).toEqual({ publishedDocs: [], patterns: none });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    expect(readConfig(dir)).toEqual({ publishedDocs: [], publicOrg: undefined, patterns: none });
    const config = {
      publishedDocs: ["specs/Design.md"],
      publicOrg: "beacons-gg",
      privatePatterns: { people: ["Robin"], allow: ["AcmeCorp LLC"] },
    };
    writeFileSync(join(dir, "package.json"), JSON.stringify({ beacon: { internalRefs: config } }));
    expect(readConfig(dir)).toEqual({
      publishedDocs: ["design.md"],
      publicOrg: "beacons-gg",
      patterns: { ...none, people: ["Robin"], allow: ["AcmeCorp LLC"] },
    });
  });

  it("refuses a list that is not one of names, and an organization that is not a name", () => {
    const dir = join(scratch, "bad-config");
    mkdirSync(dir, { recursive: true });
    const write = (config) =>
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ beacon: { internalRefs: config } }),
      );
    write({ publishedDocs: "design.md" });
    expect(() => readConfig(dir)).toThrow(/must be a list of doc file names/);
    for (const publicOrg of [["beacons-gg"], "github.com/beacons-gg", ""]) {
      write({ publicOrg });
      expect(() => readConfig(dir), JSON.stringify(publicOrg)).toThrow(/must be an organization/);
    }
    write({ privatePatterns: { people: ["Robin"], orgs: ["AcmeCorp"] } });
    expect(() => readConfig(dir)).toThrow(
      /beacon\.internalRefs\.privatePatterns: unknown field "orgs"/,
    );
  });
});

describe("readPatterns", () => {
  it("reads each list, and leaves out none of the four", () => {
    expect(readPatterns({ people: ["Robin"] }, "x")).toEqual({
      orgNames: [],
      privateDocs: [],
      people: ["Robin"],
      allow: [],
    });
    expect(readPatterns(PRIVATE, "x")).toEqual(PRIVATE);
  });

  it("refuses anything but an object of known lists of names", () => {
    const refused = [
      [["Robin"], /x must be an object of lists: orgNames, privateDocs, people, allow/],
      [null, /x must be an object/],
      [{ person: ["Robin"] }, /x: unknown field "person"/],
      [{ people: "Robin" }, /x: people must be a list of names/],
      [{ allow: [""] }, /x: allow must be a list of names/],
      [{ orgNames: [7] }, /x: orgNames must be a list of names/],
    ];
    for (const [value, message] of refused) {
      expect(() => readPatterns(value, "x"), JSON.stringify(value)).toThrow(message);
    }
  });
});

describe("withoutPatterns", () => {
  it("blanks the manifest's own private names, and keeps every line where it was", () => {
    const manifest = JSON.stringify(
      { name: "x", beacon: { internalRefs: { privatePatterns: PRIVATE, publicOrg: "acme" } } },
      null,
      2,
    );
    const blanked = withoutPatterns(manifest);
    expect(blanked).toHaveLength(manifest.length);
    expect(blanked.split("\n")).toHaveLength(manifest.split("\n").length);
    expect(blanked).not.toMatch(/Acme|Robin|sketch/);
    expect(blanked).toContain('"privatePatterns": ');
    expect(blanked).toContain('"publicOrg": "acme"');
    // A brace inside a name does not end the value early.
    expect(withoutPatterns('{"privatePatterns": {"people": ["}Robin"]}, "a": 1}')).toMatch(
      /^\{"privatePatterns": {2,}, "a": 1\}$/,
    );
    expect(withoutPatterns('{"name": "AcmeCorp"}')).toBe('{"name": "AcmeCorp"}');
  });
});

describe("scanRepo and the report", () => {
  const dir = gitRepo({
    "package.json": JSON.stringify({
      name: "made-up",
      description: "Developed in AcmeCorp/made-up.",
      beacon: {
        internalRefs: {
          publishedDocs: ["specs/sketch.md"],
          privatePatterns: { orgNames: ["AcmeCorp"], privateDocs: ["sketch.md", "accounts.md"] },
        },
      },
    }),
    "src/a.ts": "// sketch.md §2 and accounts.md §5 (#12)\nexport const a = 1;\n",
    "src/gone.ts": "// #99\n",
    "doc/guide.md": "Phase 2 lands later. See doc/guide.md §2.\n",
    "pnpm-lock.yaml": "# AcmeCorp #1\n",
    "dist/index.js": "// AcmeCorp #1\n",
    "icon.svgz": "AcmeCorp\0",
    "data.txt": "AcmeCorp\0binary\n",
    "src/patterns.mjs": `// ${DIRECTIVE}\nexport const NAMES = ["AcmeCorp"];\n`,
  });
  // Tracked, then deleted in the working tree: the scan reads what is there.
  unlinkSync(join(dir, "src/gone.ts"));

  it("scans the tracked text files, skipping the rest, and names the files that opt out", () => {
    const { findings, scanned, optedOut, skipped } = scanRepo(dir);
    expect(scanned).toBe(3);
    expect(optedOut).toEqual(["src/patterns.mjs"]);
    expect(skipped).toEqual({ binary: 2, generated: 1, lockfile: 1 });
    expect(findings.map((f) => `${f.file}:${f.line} ${f.rule}: ${f.match}`)).toEqual([
      "doc/guide.md:1 phase-wording: Phase 2",
      "package.json:1 org-names: AcmeCorp",
      "src/a.ts:1 issue-refs: #12",
      "src/a.ts:1 private-docs: accounts.md §5",
    ]);
  });

  it("reports by rule with counts, and exits 0 in report mode", () => {
    const { code, out, err } = run(dir);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("4 internal references in 3 of the 3 files scanned (report mode)");
    expect(out).toContain(
      "The organization, its registry and its private repos (org-names): 1\n  package.json:1  AcmeCorp",
    );
    expect(out).toMatch(/^ {5}1 {2}issue-refs$/m);
    expect(out).toMatch(/^ {5}0 {2}people$/m);
    expect(out).toContain("Not scanned: 2 binary, 1 generated, 1 lockfile");
    expect(out).toContain(
      `Not scanned, as the check's own pattern data (a "${DIRECTIVE}" line or a --patterns file): ` +
        "src/patterns.mjs",
    );
  });

  it("fails with --strict when it finds any, and passes a clean repo", () => {
    const strict = run(dir, ["--strict"]);
    expect(strict.code).toBe(1);
    expect(strict.err).toMatch(/cannot open/);
    const clean = gitRepo({ "README.md": "A repo with nothing to hide.\n" });
    const passed = run(clean, ["--strict"]);
    expect(passed.code).toBe(0);
    expect(passed.out).toContain("0 internal references in 0 of the 1 files scanned\n");
  });

  it("with --allow, lists the allowed rules' findings but fails only on the others", () => {
    const failed = run(dir, ["--strict", "--allow", "org-names"]);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain(
      "4 internal references in 3 of the 3 files scanned, 1 of them allowed (org-names)",
    );
    expect(failed.out).toContain("(org-names, allowed): 1\n  package.json:1  AcmeCorp");
    expect(failed.out).toMatch(/^ {5}1 {2}org-names \(allowed\)$/m);
    expect(failed.out).toMatch(/^ {5}1 {2}issue-refs$/m);
    const allowedAll = [
      "--strict",
      "--allow=org-names",
      "--allow",
      "issue-refs",
      "--allow=private-docs",
      "--allow",
      "phase-wording",
    ];
    expect(run(dir, allowedAll).code).toBe(0);
    const orgOnly = gitRepo({
      "package.json": JSON.stringify({
        repository: "github:AcmeCorp/x",
        beacon: { internalRefs: { privatePatterns: { orgNames: ["AcmeCorp"] } } },
      }),
    });
    const passed = run(orgOnly, ["--strict", "--allow", "org-names"]);
    expect(passed.code).toBe(0);
    expect(passed.err).toBe("");
  });

  it("lets a doc through by its link in the manifest's public organization", () => {
    const spec = "https://github.com/beacons-gg/beacon.server/blob/main/doc/spec/accounts.md";
    const privatePatterns = { privateDocs: ["accounts.md"] };
    const linked = (publicOrg) =>
      gitRepo({
        "package.json": JSON.stringify({
          beacon: { internalRefs: { publicOrg, privatePatterns } },
        }),
        "README.md": `The [accounts spec](${spec}).\n`,
      });
    expect(scanRepo(linked("beacons-gg")).findings).toEqual([]);
    expect(scanRepo(linked(undefined)).findings.map((f) => f.match)).toEqual(["accounts.md"]);
  });

  it("adds the names of each --patterns file to the manifest's, and scans no patterns file", () => {
    const repo = gitRepo(
      {
        "package.json": JSON.stringify({
          beacon: { internalRefs: { privatePatterns: { orgNames: ["AcmeCorp"] } } },
        }),
        "README.md": "AcmeCorp LLC, by Robin of AcmeCorp. See search.md.\n",
        "refs.json": JSON.stringify({ people: ["Robin"] }),
      },
      { "more.json": JSON.stringify({ privateDocs: ["search.md"], allow: ["AcmeCorp LLC"] }) },
    );
    expect(run(repo, ["--strict"]).out).toContain("2 internal references in 1 of the 3 files");
    const both = run(repo, ["--strict", "--patterns", "refs.json", "--patterns=more.json"]);
    expect(both.code).toBe(1);
    expect(both.out).toContain("3 internal references in 1 of the 2 files scanned");
    expect(both.out).toContain("README.md:1  Robin");
    expect(both.out).toContain("README.md:1  AcmeCorp");
    expect(both.out).toContain("README.md:1  search.md");
    expect(both.out).toMatch(/--patterns file\): refs\.json$/m);
    // Report mode reads them too.
    expect(run(repo, ["--patterns", "refs.json"]).out).toContain("(report mode)");
  });

  it("refuses a --patterns file it cannot read or that holds an unknown field", () => {
    const repo = gitRepo(
      { "README.md": "Nothing here.\n" },
      { "bad.json": JSON.stringify({ persons: ["Robin"] }), "broken.json": "{" },
    );
    const refused = [
      [["--patterns"], /--patterns takes a JSON file/],
      [["--patterns", "missing.json"], /--patterns missing\.json: ENOENT/],
      [["--patterns", "broken.json"], /--patterns broken\.json: .*JSON/],
      [["--patterns", "bad.json"], /^--patterns bad\.json: unknown field "persons"/],
    ];
    for (const [args, message] of refused) {
      const { code, err } = run(repo, args);
      expect(code, args.join(" ")).toBe(2);
      expect(err).toMatch(message);
    }
  });

  it("refuses an unknown argument, an unknown rule and an allowance without --strict", () => {
    const refused = [
      [["--fix"], /Unknown argument: --fix/],
      [["--strict", "--allow", "orgs"], /--allow takes a rule: one of org-names, issue-refs/],
      [["--strict", "--allow"], /--allow takes a rule/],
      [["--allow", "org-names"], /--allow needs --strict/],
    ];
    for (const [args, message] of refused) {
      const { code, err } = run(dir, args);
      expect(code, args.join(" ")).toBe(2);
      expect(err).toMatch(message);
    }
  });

  it("runs as the bin, on the working directory", () => {
    const strict = spawnSync(execPath, [BIN, "--strict"], { cwd: dir, encoding: "utf8" });
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("4 internal references in 3 of the 3 files scanned");
  });

  // The names this repository's own manifest lists, which the check used to carry as its built-in
  // lists. The check is published, so it must name none of them itself.
  const own = readConfig(repoRoot).patterns;
  const ownNames = [...own.orgNames, ...own.privateDocs, ...own.people];

  it.runIf(ownNames.length > 0)("carries none of this repository's private names", () => {
    const source = readFileSync(
      join(packageDir, "scripts/internal-refs.mjs"),
      "utf8",
    ).toLowerCase();
    expect(ownNames.filter((name) => source.includes(name.toLowerCase()))).toEqual([]);
    for (const name of ownNames) {
      expect(found("README.md", `See ${name}.`, NO_NAMES), name).toEqual([]);
    }
  });

  it("never flags the check's own pattern data in this repository", () => {
    const { findings, optedOut } = scanRepo(repoRoot);
    const own = findings.filter(
      (f) => f.file.includes("internal-refs") || f.file.includes("internalRefs"),
    );
    expect(own).toEqual([]);
    expect(optedOut.every((path) => /internal-?refs/i.test(path))).toBe(true);
  });
});
