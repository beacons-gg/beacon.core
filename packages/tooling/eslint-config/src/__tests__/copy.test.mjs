/**
 * The copy check: each rule against what it must and must not find, how Markdown and source files
 * are read into passages, the bin over a made-up git repo, and the types a TypeScript repo imports.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as copy from "../../scripts/copy.mjs";
import { gitRepo, runMain } from "./repo.mjs";

const { checkProse, main, proseOfMarkdown, proseOfSource } = copy;

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(packageDir, "scripts/check-copy.mjs");

/** @param {string} text @param {boolean} [docs] */
const md = (text, docs = false) =>
  checkProse(proseOfMarkdown(text), { docs }).map((f) => [f.line, f.rule, f.fatal]);
/** @param {string} text */
const tsx = (text) => checkProse(proseOfSource(text)).map((f) => [f.line, f.rule]);

describe("the rules", () => {
  it("fails an em dash, an en dash and a spaced hyphen; passes a list bullet and a hyphenated word", () => {
    expect(md("One — two.")).toEqual([[1, "dash", true]]);
    expect(md("12–24 px.")).toEqual([[1, "dash", true]]);
    expect(md("One - two.")).toEqual([[1, "spaced hyphen", true]]);
    expect(md("- a list item\n- A point-in-time copy.")).toEqual([]);
  });

  it("fails a banned word as a whole word only, curly apostrophes included", () => {
    expect(md("The server is very fast.")).toEqual([[1, 'banned "very"', true]]);
    expect(md("Here’s how.")).toEqual([[1, 'banned "here’s"', true]]);
    expect(md("Every server.")).toEqual([]);
  });

  it("checks a paragraph whole, so a phrase or a sentence that wraps is still seen", () => {
    expect(md("Intro.\n\nThis is at a\nglance easy.")).toEqual([[3, 'banned "at a glance"', true]]);
    expect(md("Your texts, in each\nstyle, at the sizes.")).toEqual([[1, "comma", false]]);
    expect(md("- one item,\n- two, three")).toEqual([]);
  });

  it("warns on two commas unless they sit in a list of short items", () => {
    expect(md("Your texts, in each style, at the sizes you pick.")).toEqual([[1, "comma", false]]);
    expect(md("The app runs on iOS, Android, web or desktop.")).toEqual([]);
    expect(md("One, two. Three, four.")).toEqual([]);
  });

  it("reads each front matter field as its own passage", () => {
    expect(md("---\ntitle: A, b\ndescription: C, d\n---\nBody.")).toEqual([]);
    expect(md("---\ntitle: A — b\n---")).toEqual([[2, "dash", true]]);
    expect(md("---\r\ntitle: A, b\r\ndescription: C, d\r\n---\r\nBody.")).toEqual([]);
  });

  it("closes a fence only on its own bare marker, at least as long", () => {
    const text = ["~~~", "```", "a — b", "~~~", "After — this."].join("\n");
    expect(md(text)).toEqual([[5, "dash", true]]);
    const four = ["````", "```", "x — y", "```", "````", "Then — this."].join("\n");
    expect(md(four)).toEqual([[6, "dash", true]]);
    expect(md("Use `x - y` here.")).toEqual([]);
    expect(md(["```js", "a", "```js", "b — c", "```", "After — this."].join("\n"))).toEqual([
      [6, "dash", true],
    ]);
  });

  it("reads a source file's JSX text and strings; comments, class lists and code are not prose", () => {
    const text = [
      "// a comment — ignored", // 1
      'import x from "a — b";', // 2
      'const g = "docs/*.md";', // 3
      'const a = <p className="a — b">Hidden — text</p>;', // 4
      "const i = docs[i - 1];", // 5
      "const p = <p>", // 6
      "  placed — a room&apos;s policy", // 7
      "</p>;", // 8
      'const s = "a very good line";', // 9
      "const t = `2026 — the ${year}`;", // 10
      "/* a block */ const u = 'single — quoted';", // 11
      'const j = `{ "a": "b — c" }`;', // 12: a JSON sample is code
      "const q = sql`SELECT a - b, c, d FROM t`;", // 13: a tagged template is code
    ].join("\n");
    expect(tsx(text)).toEqual([
      [4, "dash"],
      [7, "dash"],
      [9, 'banned "very"'],
      [10, "dash"],
      [11, "dash"],
    ]);
  });

  it("warns on a sentence that opens on It, Its or It's; passes one with it inside", () => {
    expect(md("Your server's address. It can't change later.")).toEqual([[1, "it start", false]]);
    expect(md("Its database is out of reach.")).toEqual([[1, "it start", false]]);
    expect(md("It’s on.")).toEqual([[1, "it start", false]]);
    expect(md("**It** runs once a minute.")).toEqual([[1, "it start", false]]);
    expect(md("[It](/docs/x) signs each room.")).toEqual([[1, "it start", false]]);
    expect(md("Set it once. Items and iterators pass.")).toEqual([]);
  });

  it("fails British spellings; passes US spellings and look-alike words", () => {
    expect(md("Pick a colour.")).toEqual([[1, 'spelling "colour"', true]]);
    expect(md("The scout was cancelled.")).toEqual([[1, 'spelling "cancelled"', true]]);
    expect(md("Serialise the room.")).toEqual([[1, 'spelling "serialise"', true]]);
    expect(md("A realistic, licensed color in the center.")).toEqual([]);
    expect(md("The emphasis is on behavior.")).toEqual([]);
    expect(md("A grey marker.")).toEqual([[1, 'spelling "grey"', true]]);
    expect(md("In the neighbourhood.")).toEqual([[1, 'spelling "neighbourhood"', true]]);
    expect(md("The checker runs two analyses.")).toEqual([]);
    expect(md("A few kilometres across.")).toEqual([[1, 'spelling "kilometres"', true]]);
  });

  it("fails the minimizers and wrap-ups, and only warns on just", () => {
    expect(md("Simply run it.")).toEqual([[1, 'banned "simply"', true]]);
    expect(md("The map turns to landscape on a phone.")).toEqual([]);
    expect(md("In summary, the server runs.")).toEqual([[1, 'banned "in summary"', true]]);
    expect(md("Try again in a minute, just in case.")).toEqual([[1, 'filler "just"', false]]);
  });

  it("fails an exclamation mark anywhere and a question only in the docs", () => {
    expect(md("Done!")).toEqual([[1, "exclamation", true]]);
    expect(md("Use `a !== b` here.")).toEqual([]);
    expect(md("**You're done!**")).toEqual([[1, "exclamation", true]]);
    expect(md("Wow!! Done.")).toEqual([[1, "exclamation", true]]);
    expect(tsx('const base = "mt-0 px-4! mt-auto!";')).toEqual([]);
    expect(md("Which games?")).toEqual([]);
    expect(md("Which games?", true)).toEqual([[1, "question", true]]);
    expect(md("What happens next? The client retries.", true)).toEqual([[1, "question", true]]);
    expect(md("**Why does this matter?**", true)).toEqual([[1, "question", true]]);
    expect(md('The console asks "Which games?"', true)).toEqual([]);
  });

  it("reads emphasis and link text as their words, so every rule sees them", () => {
    expect(md("_Simply_ run the server.")).toEqual([[1, 'banned "simply"', true]]);
    expect(md("Pick a _colour_.")).toEqual([[1, 'spelling "colour"', true]]);
    expect(md("**Note.** It runs once.")).toEqual([[1, "it start", false]]);
    expect(md("[Done.](/x) It runs once.")).toEqual([[1, "it start", false]]);
    expect(md("*Why?* The server retries.", true)).toEqual([[1, "question", true]]);
    expect(md("Set `snake_case` and snake_case names.")).toEqual([]);
  });

  it("treats a class list held outside className as code, and prose with a hyphenated word as prose", () => {
    expect(tsx('const c = "bg-grey-500 px-4! flex";')).toEqual([]);
    expect(tsx('const s = "Sign up and try it hands-on!";')).toEqual([[1, "exclamation"]]);
    expect(tsx('const t = "just now";')).toEqual([[1, 'filler "just"']]);
  });

  it("reads a heading as one line, so the line after it starts a passage", () => {
    expect(md("## Setup\nIt runs once.")).toEqual([[2, "it start", false]]);
  });
});

const run = (dir, args) => runMain(main, dir, args);

describe("the bin", () => {
  const repo = gitRepo(
    {
      "README.md": "# Repo\n\nThe server runs.\n",
      "doc/a.md": "Why? The server is very fast.\n",
      "doc/b.md": "Try again, just in case.\n",
      "app/page.tsx": "export const P = () => <p>Which games?</p>;\n",
      "doc/c.png": "not text",
      ".gitignore": "doc/ignored.md\n",
    },
    { "doc/new.md": "Done!\n", "doc/ignored.md": "Done!\n" },
  );

  it("fails on a finding that fails, and prints each one with its file and line", () => {
    const { code, out, err } = run(repo, ["doc"]);
    expect(code).toBe(1);
    expect(out).toContain('error doc/a.md:1 rule banned "very": Why? The server is very fast.');
    expect(out).toContain("error doc/a.md:1 rule question: Why?");
    expect(out).toContain('warn  doc/b.md:1 rule filler "just"');
    // A file git would track is read; an ignored one and an image are not.
    expect(out).toContain("error doc/new.md:1 rule exclamation");
    expect(out).not.toContain("ignored.md");
    expect(out).toContain("3 error(s) and 1 warning(s) in 3 of the 3 files checked");
    expect(err).toBe("beacon-check-copy: 3 finding(s) break STYLE.md");
  });

  it("reads a source file for its words, where a question passes", () => {
    expect(run(repo, ["app/**/*.tsx"])).toMatchObject({ code: 0 });
  });

  it("passes on warnings alone, and fails on them with --strict", () => {
    expect(run(repo, ["doc/b.md"]).code).toBe(0);
    const strict = run(repo, ["--strict", "doc/b.md"]);
    expect(strict.code).toBe(1);
    expect(strict.out).toContain('error doc/b.md:1 rule filler "just"');
    expect(strict.out).toContain("1 error(s) and 0 warning(s)");
  });

  it("lists everything and exits 0 with --report, with a count per rule", () => {
    const { code, out } = run(repo, ["--report", "doc/*.md", "*.md"]);
    expect(code).toBe(0);
    expect(out).toContain("in 3 of the 4 files checked (report mode)");
    expect(out).toMatch(/ {5}1 {2}banned\n/);
    expect(out).toMatch(/ {5}1 {2}filler \(warns\)/);
  });

  it("refuses an unknown flag, no paths, both modes and a path that matches nothing", () => {
    expect(run(repo, ["--fix", "doc"])).toMatchObject({ code: 2, err: /Unknown argument: --fix/ });
    expect(run(repo, [])).toMatchObject({ code: 2, err: /^Usage/ });
    expect(run(repo, ["--strict", "--report", "doc"])).toMatchObject({ code: 2 });
    expect(run(repo, ["docs"])).toMatchObject({ code: 2, err: /No file matches docs/ });
  });

  it("runs as a bin on the working directory", () => {
    const result = spawnSync(execPath, [BIN, "doc/b.md"], { cwd: repo, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 error(s) and 1 warning(s)");
  });
});

describe("the types", () => {
  it("declare every export, and a TypeScript repo can call the check through them", () => {
    const file = join(packageDir, "scripts/use-copy.ts");
    const text = [
      'import { BANNED, RULES, checkProse, main, proseOfMarkdown, proseOfSource } from "./copy.mjs";',
      'import type { Finding, Passage, Rule } from "./copy.mjs";',
      'const passages: Passage[] = [...proseOfMarkdown("# A"), ...proseOfSource("<p>B</p>", "b.tsx")];',
      "const findings: Finding[] = checkProse(passages, { docs: true });",
      "const rules: readonly Rule[] = RULES;",
      "export const used = [findings, rules, BANNED.length, main(['--report'], '.')];",
    ].join("\n");
    const host = ts.createCompilerHost({});
    const readFile = host.readFile;
    host.readFile = (path) => (path === file ? text : readFile(path));
    host.fileExists = (path) => path === file || ts.sys.fileExists(path);
    const program = ts.createProgram({
      rootNames: [file],
      options: {
        strict: true,
        noEmit: true,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        types: [],
      },
      host,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => d.messageText);
    expect(diagnostics).toEqual([]);
    const declarations = program.getSourceFile(join(packageDir, "scripts/copy.d.mts"));
    const checker = program.getTypeChecker();
    const declared = checker
      .getExportsOfModule(checker.getSymbolAtLocation(declarations))
      .filter((s) => s.flags & ts.SymbolFlags.Value)
      .map((s) => s.getName());
    expect(declared.sort()).toEqual(Object.keys(copy).sort());
  });
});
