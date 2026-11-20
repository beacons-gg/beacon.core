/**
 * beacon-internal-refs: pattern data. The lists below are what the check looks for, so this file
 * opts out of its own scan (see DIRECTIVE).
 *
 * Check: nothing in a repo's tracked text points at what a public reader cannot open.
 *
 *   beacon-check-internal-refs [--strict [--allow <rule>]...] [--patterns <file>]...
 *
 * `@beaconsgg/eslint-config`'s bin, run from the repo root.
 *
 * Code comments, READMEs, package descriptions and workflow comments drift toward the context their
 * author had at hand: the organization's private repos and registry, planning docs that are not
 * published, issue and pull request numbers, phases and decisions from a plan, and people. A public
 * reader can follow none of them. Cleaning a repo once does not keep it clean, so this check names
 * every such reference with its file and line.
 *
 * It reads the files git tracks in the repo it is run in, and nothing else. Lockfiles, build output
 * and binary files are skipped. Some rules look everywhere, since the names they match mean one
 * thing wherever they appear; the rest look only in comments, and in prose files as a whole,
 * because their patterns also match ordinary code (`#123` is a color in a stylesheet, `P1` a
 * variable). Issue references are also looked for in string literals, where test names carry
 * them. Report mode lists what it finds and exits 0; `--strict` fails on any finding, except those
 * of the rules named with `--allow`, which are still listed. A repo whose org names only change on
 * the day it moves runs `--strict --allow org-names`, so every other rule holds in the meantime.
 *
 * The rules that look for names know no names of their own. A repo lists its organization, its
 * unpublished docs and its people under `beacon.internalRefs.privatePatterns` in its root manifest,
 * or in a JSON file of the same shape passed with `--patterns` (see {@link readPatterns}). Built in
 * are only the shapes that mean the same in every repo: issue references, phase wording, and a
 * section of a doc the repo does not ship.
 *
 * This module only defines the check; `check-internal-refs.mjs` beside it is the bin that runs it
 * on the working directory, with no entry-point guard (through `node_modules/.bin` one never
 * matches).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

/**
 * A file that holds the check's own patterns says so with this text in its first lines, and is
 * not scanned. The report names every file that opted out, so the opt-out cannot hide anything.
 */
export const DIRECTIVE = "beacon-internal-refs: pattern data";
const DIRECTIVE_LINES = 10;

/**
 * A repo's private names, each list optional where they are written:
 *
 * - `orgNames`: the organization's names, its private registry and its private repos, matched in
 *   any case anywhere;
 * - `privateDocs`: planning docs that are not published, by file name in any case. A doc stops
 *   counting once the repo ships it, or once the root manifest lists it as published (see
 *   {@link readConfig});
 * - `people`: people's names, matched in any case and at the start of a handle (`NameOnGit`);
 * - `allow`: exact phrases, case and all, inside which a match is no finding, whatever its rule.
 *   A copyright holder's legal name is one.
 * @typedef {{ orgNames: string[], privateDocs: string[], people: string[], allow: string[] }}
 *   PrivatePatterns
 */
const PATTERN_FIELDS = /** @type {const} */ (["orgNames", "privateDocs", "people", "allow"]);

/** @returns {PrivatePatterns} */
const noPatterns = () => ({ orgNames: [], privateDocs: [], people: [], allow: [] });

/**
 * @typedef {{ publicDocs: Set<string>, publicUrls?: RegExp, names: Names }} Context `publicDocs`
 *   the doc file names, lowercased, that a reader can open: the ones the repo tracks and the ones
 *   its manifest lists as published. `publicUrls` matches the links into the public organization
 *   (see {@link publicUrlsOf}), whose docs a reader can open wherever they live. `names` are the
 *   repo's private names, ready to match (see {@link namesOf}).
 * @typedef {{ org?: RegExp, people?: RegExp, docs: Set<string>, allow?: RegExp }} Names
 * @typedef {{ id: string, title: string, scope: Scope,
 *   find: (line: string, context: Context) => RegExpMatchArray[] }} Rule
 * @typedef {"anywhere" | "comments" | "text"} Scope where in a code file a rule looks: every
 *   character, its comments, or its comments and string literals. A prose file is read whole.
 * @typedef {{ rule: string, file: string, line: number, match: string }} Finding
 */

/** `matches` in order, dropping any that overlaps the one before it. */
function inOrder(/** @type {RegExpMatchArray[]} */ matches) {
  let end = -1;
  return matches
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .filter((m) => {
      const start = m.index ?? 0;
      if (start < end) return false;
      end = start + m[0].length;
      return true;
    });
}

/** Every match of each pattern in `line`, in order. */
const matchesOf = (/** @type {RegExp[]} */ patterns, /** @type {string} */ line) =>
  inOrder(patterns.flatMap((pattern) => [...line.matchAll(pattern)]));

const escape = (/** @type {string} */ text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const unpublished = (/** @type {string} */ doc, /** @type {Context} */ context) =>
  !context.publicDocs.has(doc.toLowerCase());

/**
 * A pattern for the links into the public GitHub organization `org`: its repos
 * (`https://github.com/org/…`), their raw files (`https://raw.githubusercontent.com/org/…`) and
 * its pages (`https://org.github.io/…`). A doc linked by such a URL is public even when the
 * scanning repo does not hold it.
 * @param {string} org
 */
export const publicUrlsOf = (org) =>
  new RegExp(
    `https?://(?:(?:www\\.)?github\\.com/${escape(org)}|raw\\.githubusercontent\\.com/${escape(org)}|` +
      `${escape(org)}\\.github\\.io)(?![^/\\s#?])[^\\s<>()"'\`\\]]*`,
    "gi",
  );

/** `matches` less those that start inside one of `spans`, the `[from, to)` of each. */
function outside(
  /** @type {RegExpMatchArray[]} */ matches,
  /** @type {RegExpMatchArray[]} */ spans,
) {
  if (spans.length === 0) return matches;
  return matches.filter((m) => {
    const start = m.index ?? 0;
    return !spans.some(
      (span) => start >= (span.index ?? 0) && start < (span.index ?? 0) + span[0].length,
    );
  });
}

const NAMED_DOC = /(?<![\w.-])([A-Za-z][\w.-]*\.md)\b(?:\s*§\s*\d[\d.]*)?/g;
// A section reference with the doc named just before it: `release-plan §6.2`, `handbook.md §10`,
// `docs/plans §3`. The name must look like a file (a `.md`, a hyphen or a path) so that "see §4"
// is not read as a doc called "see".
const SECTION_REF = /(?<![\w./-])([A-Za-z][\w./-]*?)(\.md)?\s*§\s*\d[\d.]*/g;
// A name in any case, also at the start of a handle (`NameOnGit`), but not inside a longer
// lowercase word.
const anyCase = (/** @type {string} */ name) =>
  [...name]
    .map((c) => (/[a-z]/i.test(c) ? `[${c.toUpperCase()}${c.toLowerCase()}]` : escape(c)))
    .join("");

/**
 * The repo's private names, ready to match. A list left empty matches nothing.
 * @param {PrivatePatterns} patterns
 * @returns {Names}
 */
export function namesOf(patterns) {
  const { orgNames, privateDocs, people, allow } = patterns;
  return {
    org: orgNames.length > 0 ? new RegExp(orgNames.map(escape).join("|"), "gi") : undefined,
    people:
      people.length > 0
        ? new RegExp(`\\b(?:${people.map(anyCase).join("|")})(?![a-z])`, "g")
        : undefined,
    docs: new Set(privateDocs.map((doc) => basename(doc).toLowerCase())),
    allow: allow.length > 0 ? new RegExp(allow.map(escape).join("|"), "g") : undefined,
  };
}

// `#123` or `org/repo#123`. A bare `#123` stands at the start of a line or after whitespace, `(`
// or `-`, which no color, anchor or entity does (`"#123"`, `color:#123`, `bg-[#123]`, `page#12`,
// `&#123;`); an `org/repo` never starts inside a path or a host (`example.com/docs#12`). Neither
// is followed by a word character (`#123abc`) or `;` (`color: #123;`), starts with `0`, or runs
// past five digits, so a six- or eight-digit color is never one. A three-digit color written after
// a space in a string, `"1px solid #333"`, still reads as a reference.
const ISSUE_REFS = [
  /(?<![\w./-])[\w.-]+\/[\w.-]+#[1-9]\d{0,4}(?![\w;-])/g,
  /(?<![^\s(-])#[1-9]\d{0,4}(?![\w;-])/g,
];
const PHASE_WORDING = [
  /\brelease-\d+ decisions?\b/gi,
  /\bdecisions?\s+#?\d+\b/gi,
  // `P1`, `P2.4`: one digit, so a Wikidata property such as `P649` is not one.
  /\bP[1-9](?:\.\d+)?[a-z]?\b/g,
  /\b[Tt]rack [A-Z]\b/g,
  /\bphases?\s+\d+[a-z]?\b/gi,
];

/** @type {Rule[]} */
const RULES = [
  {
    id: "org-names",
    title: "The organization, its registry and its private repos",
    scope: "anywhere",
    find: (line, { names }) => (names.org ? matchesOf([names.org], line) : []),
  },
  {
    id: "issue-refs",
    title: "Issue and pull request references",
    scope: "text",
    find: (line) => matchesOf(ISSUE_REFS, line),
  },
  {
    id: "private-docs",
    title: "Private planning docs and their sections",
    scope: "anywhere",
    find: (line, context) => {
      const listed = context.names.docs;
      const named = [...line.matchAll(NAMED_DOC)].filter(
        ([, doc]) => listed.has(doc.toLowerCase()) && unpublished(doc, context),
      );
      const sections = [...line.matchAll(SECTION_REF)].filter(([, name, md]) => {
        const doc = `${basename(name)}.md`;
        // A listed doc written with its `.md` is already a named match above, section and all.
        return (
          (md || /[-/]/.test(name)) &&
          !(md && listed.has(doc.toLowerCase())) &&
          unpublished(doc, context)
        );
      });
      const links = context.publicUrls ? [...line.matchAll(context.publicUrls)] : [];
      return inOrder(outside([...named, ...sections], links));
    },
  },
  {
    id: "phase-wording",
    title: "Internal phase and decision wording",
    scope: "comments",
    find: (line) => matchesOf(PHASE_WORDING, line),
  },
  {
    id: "people",
    title: "People's names",
    scope: "anywhere",
    find: (line, { names }) => (names.people ? matchesOf([names.people], line) : []),
  },
];

/**
 * How a language writes comments. `line` markers run to the end of the line (`afterSpace`: only at
 * the start of a line or after whitespace, as `#` in a shell or YAML file); `blocks` are
 * open/close pairs; `quotes` open strings, which hide comment markers; `regex` says the language
 * has regex literals, which do too; `stringPrefix` matches what may stand right before a quote
 * that opens a string (otherwise a quote after a word character is an apostrophe).
 * @typedef {{ line?: string[], afterSpace?: boolean, blocks?: [string, string][], quotes?: string,
 *   regex?: boolean, stringPrefix?: RegExp }} Lang
 */

const SLASH_STAR = /** @type {[string, string]} */ (["/*", "*/"]);
const MARKUP = /** @type {[string, string]} */ (["<!--", "-->"]);
/** @type {Record<string, Lang>} */
const LANGS = {
  c: { line: ["//"], blocks: [SLASH_STAR], quotes: "'\"`", regex: true },
  css: { blocks: [SLASH_STAR], quotes: "'\"" },
  scss: { line: ["//"], blocks: [SLASH_STAR], quotes: "'\"" },
  hash: { line: ["#"], afterSpace: true, quotes: "'\"" },
  // Python's string prefixes: `f"…"`, `rb'…'`.
  py: { line: ["#"], afterSpace: true, quotes: "'\"", stringPrefix: /(?:^|\W)[rbfu]{1,2}$/i },
  dash: { line: ["--"], blocks: [SLASH_STAR], quotes: "'\"" },
  markup: { blocks: [MARKUP] },
  // A page or component file: markup comments, and script comments in its `<script>`.
  page: { line: ["//"], blocks: [MARKUP, SLASH_STAR], quotes: "'\"`", regex: true },
};

const LANG_BY_EXTENSION = Object.fromEntries(
  Object.entries({
    c: "js mjs cjs jsx ts mts cts tsx jsonc json5",
    css: "css",
    scss: "scss less",
    hash: "yml yaml sh bash zsh toml rb ini conf cfg properties",
    py: "py",
    dash: "sql lua",
    markup: "xml svg",
    page: "html htm vue svelte astro",
  }).flatMap(([lang, extensions]) => extensions.split(" ").map((ext) => [`.${ext}`, LANGS[lang]])),
);
const HASH_FILES =
  /^(?:Dockerfile.*|.*\.Dockerfile|Makefile|CODEOWNERS|\.[\w.-]*ignore|\.npmrc|\.editorconfig|\.gitattributes|\.env.*)$/;

/**
 * The comment syntax of the file at `path`, or undefined for prose: Markdown, plain text, JSON and
 * anything unknown are read whole.
 * @param {string} path
 * @returns {Lang | undefined}
 */
export function langOf(path) {
  const name = basename(path);
  return HASH_FILES.test(name) ? LANGS.hash : LANG_BY_EXTENSION[extname(name).toLowerCase()];
}

// The tokens after which a `/` starts a regex literal rather than dividing.
const BEFORE_REGEX = /[(,=:[!&|?{};+\-*%>~^]/;
const KEYWORDS_BEFORE_REGEX = new Set(
  "return typeof case do else in of void yield await delete throw new".split(" "),
);

function regexMayStart(/** @type {string} */ text, /** @type {number} */ at) {
  // Only the last few characters before the `/` decide, so read only those.
  let end = at;
  while (end > 0 && /\s/.test(text[end - 1])) end -= 1;
  if (end === 0) return true;
  const before = text.slice(Math.max(0, end - 16), end);
  if (/(?:\+\+|--)$/.test(before)) return false; // `a++ / 2` divides
  if (BEFORE_REGEX.test(before.at(-1) ?? "")) return true;
  return KEYWORDS_BEFORE_REGEX.has(/\w+$/.exec(before)?.[0] ?? "");
}

/** The index after a regex literal whose body starts at `i`, or -1 when the line ends first. */
function skipRegex(/** @type {string} */ text, /** @type {number} */ i) {
  let inClass = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "\n") return -1;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
  }
  return -1;
}

/** The index after a string closed by `quote`, or at the end of its line if it is never closed. */
function skipString(
  /** @type {string} */ text,
  /** @type {number} */ i,
  /** @type {string} */ quote,
) {
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === quote) return i + 1;
    else if (c === "\n") return i;
  }
  return text.length;
}

/**
 * The index after a template literal's text from `i`: past its closing backtick, or past a `${`,
 * in which case a new brace depth is pushed so the matching `}` resumes the template.
 */
function skipTemplate(
  /** @type {string} */ text,
  /** @type {number} */ i,
  /** @type {number[]} */ braces,
) {
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === "`") return i + 1;
    else if (c === "$" && text[i + 1] === "{") {
      braces.push(0);
      return i + 2;
    }
  }
  return text.length;
}

/**
 * Two views of `text`, each with the rest blanked to spaces and its newlines kept, so a line and
 * column in either are the same line and column in the file: `comments` keeps its comments, and
 * `text` its comments and the contents of its string and template literals. A small lexer, not a
 * parser: it knows strings, template literals and regex literals well enough that a `//` or `#`
 * inside one is not read as a comment.
 * @param {string} text
 * @param {Lang} lang
 * @returns {{ comments: string, text: string }}
 */
export function lex(text, lang) {
  const { line = [], afterSpace = false, blocks = [], quotes = "", regex = false } = lang;
  const blank = text.replace(/[^\n]/g, " ");
  const comments = blank.split("");
  const withStrings = blank.split("");
  /** Keep `from` to `to` in `views`, and return `to`. */
  const keep = (
    /** @type {number} */ from,
    /** @type {number} */ to,
    /** @type {string[][]} */ ...views
  ) => {
    for (const view of views) for (let k = from; k < to; k++) view[k] = text[k];
    return to;
  };
  const comment = (/** @type {number} */ from, /** @type {number} */ to) =>
    keep(from, to, comments, withStrings);
  const literal = (/** @type {number} */ from, /** @type {number} */ to) =>
    keep(from, to, withStrings);
  /** @type {number[]} open `${` expressions of template literals, by brace depth */
  const braces = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const block = blocks.find(([open]) => text.startsWith(open, i));
    if (block) {
      const end = text.indexOf(block[1], i + block[0].length);
      i = comment(i, end === -1 ? text.length : end + block[1].length);
    } else if (
      line.some((marker) => text.startsWith(marker, i)) &&
      (!afterSpace || i === 0 || /\s/.test(text[i - 1]))
    ) {
      const end = text.indexOf("\n", i);
      i = comment(i, end === -1 ? text.length : end);
    } else if (c === "`" && quotes.includes(c)) {
      i = literal(i, skipTemplate(text, i + 1, braces));
    } else if (
      quotes.includes(c) &&
      (!/\w/.test(text[i - 1] ?? "") || lang.stringPrefix?.test(text.slice(Math.max(0, i - 3), i)))
    ) {
      // After a word character a quote is an apostrophe ("Don't"), not a string.
      i = literal(i, skipString(text, i + 1, c));
    } else if (regex && c === "/" && regexMayStart(text, i)) {
      const end = skipRegex(text, i + 1);
      i = end === -1 ? i + 1 : end;
    } else {
      if (braces.length > 0 && c === "{") braces[braces.length - 1] += 1;
      else if (braces.length > 0 && c === "}") {
        if (braces.at(-1) === 0) {
          braces.pop();
          i = literal(i, skipTemplate(text, i + 1, braces));
          continue;
        }
        braces[braces.length - 1] -= 1;
      }
      i += 1;
    }
  }
  return { comments: comments.join(""), text: withStrings.join("") };
}

/**
 * Every finding in one file's `text`, each rule reading the part of each line its scope names.
 * @param {string} path the file's path, for its language and the findings
 * @param {string} text
 * @param {Context} context
 * @returns {Finding[]}
 */
export function scanText(path, text, context) {
  const lang = langOf(path);
  const lines = text.split("\n");
  const views = lang ? lex(text, lang) : undefined;
  /** @type {Record<Scope, string[]>} */
  const scoped = {
    anywhere: lines,
    comments: views ? views.comments.split("\n") : lines,
    text: views ? views.text.split("\n") : lines,
  };
  const { allow } = context.names;
  return lines.flatMap((line, index) => {
    const allowed = allow ? [...line.matchAll(allow)] : [];
    return RULES.flatMap((rule) =>
      outside(rule.find(scoped[rule.scope][index], context), allowed).map((m) => ({
        rule: rule.id,
        file: path,
        line: index + 1,
        match: m[0],
      })),
    );
  });
}

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
]);
const GENERATED_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".next",
  ".turbo",
  ".expo",
  "__snapshots__",
]);
const GENERATED_FILES = /\.(?:min\.js|min\.css|map|snap|tsbuildinfo)$/;
/**
 * Why a tracked file is not scanned by its path, or undefined. A binary file is told by its
 * content instead: a NUL byte, as git tells one.
 * @param {string} path
 */
export function skipReason(path) {
  if (LOCKFILES.has(basename(path))) return "lockfile";
  if (path.split("/").some((part) => GENERATED_DIRS.has(part)) || GENERATED_FILES.test(path)) {
    return "generated";
  }
  return undefined;
}

/**
 * A repo's private names as written in `source`, the manifest's `privatePatterns` or a
 * `--patterns` file: an object with any of the lists of {@link PrivatePatterns}, each a list of
 * names. A field the check does not know is an error, so a misspelled list cannot pass unnoticed.
 * @param {unknown} value
 * @param {string} source where `value` was read, for the error
 * @returns {PrivatePatterns}
 */
export function readPatterns(value, source) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be an object of lists: ${PATTERN_FIELDS.join(", ")}`);
  }
  const patterns = noPatterns();
  for (const [field, list] of Object.entries(value)) {
    if (!(/** @type {readonly string[]} */ (PATTERN_FIELDS).includes(field))) {
      throw new Error(`${source}: unknown field "${field}" (known: ${PATTERN_FIELDS.join(", ")})`);
    }
    if (!Array.isArray(list) || !list.every((name) => typeof name === "string" && name !== "")) {
      throw new Error(`${source}: ${field} must be a list of names`);
    }
    patterns[/** @type {keyof PrivatePatterns} */ (field)] = list;
  }
  return patterns;
}

/** Every list of `all` joined. */
export const mergePatterns = (/** @type {PrivatePatterns[]} */ ...all) => {
  const merged = noPatterns();
  for (const patterns of all)
    for (const field of PATTERN_FIELDS) merged[field].push(...patterns[field]);
  return merged;
};

/**
 * The repo's configuration, from its root manifest:
 *
 *   { "beacon": { "internalRefs": {
 *       "publishedDocs": ["handbook.md"], "publicOrg": "beacons-gg",
 *       "privatePatterns": { "orgNames": ["example-org"], "people": ["Robin"] } } } }
 *
 * `publishedDocs` names docs that are published, so citing them is fine. A path counts by its file
 * name, as references do. `publicOrg` names the organization the repos are public under, so a doc
 * linked by its URL there is fine too (see {@link publicUrlsOf}). `privatePatterns` holds the
 * repo's private names (see {@link readPatterns}).
 * @param {string} repoRoot
 * @returns {{ publishedDocs: string[], publicOrg?: string, patterns: PrivatePatterns }} the
 *   published docs' file names, lowercased, the public organization if the manifest names one, and
 *   the private names
 */
export function readConfig(repoRoot) {
  /** @type {any} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  } catch {
    return { publishedDocs: [], patterns: noPatterns() };
  }
  const { publishedDocs = [], publicOrg, privatePatterns } = manifest?.beacon?.internalRefs ?? {};
  if (!Array.isArray(publishedDocs) || !publishedDocs.every((doc) => typeof doc === "string")) {
    throw new Error(
      "package.json: beacon.internalRefs.publishedDocs must be a list of doc file names",
    );
  }
  if (publicOrg !== undefined && !(typeof publicOrg === "string" && /^[\w.-]+$/.test(publicOrg))) {
    throw new Error("package.json: beacon.internalRefs.publicOrg must be an organization's name");
  }
  const patterns =
    privatePatterns === undefined
      ? noPatterns()
      : readPatterns(privatePatterns, "package.json: beacon.internalRefs.privatePatterns");
  return {
    publishedDocs: publishedDocs.map((doc) => basename(doc).toLowerCase()),
    publicOrg,
    patterns,
  };
}

/**
 * `manifest`, the text of the root `package.json`, with the value of its `privatePatterns` blanked
 * to spaces and its newlines kept: the names listed there are the check's own pattern data.
 * @param {string} manifest
 */
export function withoutPatterns(manifest) {
  const key = /"privatePatterns"\s*:\s*\{/.exec(manifest);
  if (!key) return manifest;
  const from = key.index + key[0].length - 1;
  let depth = 0;
  let to = from;
  for (; to < manifest.length; to++) {
    const c = manifest[to];
    if (c === '"') to = skipString(manifest, to + 1, '"') - 1;
    else if (c === "{") depth += 1;
    else if (c === "}" && --depth === 0) break;
  }
  const blanked = manifest.slice(from, to + 1).replace(/[^\n]/g, " ");
  return manifest.slice(0, from) + blanked + manifest.slice(to + 1);
}

/**
 * Scan every file git tracks in the repo at `repoRoot`, with the private names of its manifest and
 * those of each `--patterns` file. A patterns file the repo tracks is not scanned, as a file with
 * the {@link DIRECTIVE} is not.
 * @param {string} repoRoot
 * @param {{ file: string, patterns: PrivatePatterns }[]} [extra] each file's absolute path and names
 * @returns {{ findings: Finding[], scanned: number, optedOut: string[],
 *   skipped: Record<string, number> }} `skipped` counts the files left out, by reason
 */
export function scanRepo(repoRoot, extra = []) {
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const { publishedDocs, publicOrg, patterns } = readConfig(repoRoot);
  /** @type {Context} */
  const context = {
    publicDocs: new Set([
      ...publishedDocs,
      ...tracked.filter((path) => path.endsWith(".md")).map((path) => basename(path).toLowerCase()),
    ]),
    publicUrls: publicOrg ? publicUrlsOf(publicOrg) : undefined,
    names: namesOf(mergePatterns(patterns, ...extra.map((e) => e.patterns))),
  };
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const optedOut = [];
  /** @type {Record<string, number>} */
  const skipped = {};
  const skip = (/** @type {string} */ reason) => (skipped[reason] = (skipped[reason] ?? 0) + 1);
  let scanned = 0;
  const patternFiles = new Set(extra.map((e) => e.file));
  for (const path of tracked) {
    const reason = skipReason(path);
    if (reason) {
      skip(reason);
      continue;
    }
    /** @type {string} */
    let text;
    try {
      text = readFileSync(join(repoRoot, path), "utf8");
    } catch {
      continue; // deleted in the working tree, or a submodule's directory
    }
    if (text.includes("\0")) {
      skip("binary"); // whatever its name
      continue;
    }
    if (
      patternFiles.has(resolve(repoRoot, path)) ||
      text.split("\n", DIRECTIVE_LINES).some((line) => line.includes(DIRECTIVE))
    ) {
      optedOut.push(path);
      continue;
    }
    scanned += 1;
    findings.push(
      ...scanText(path, path === "package.json" ? withoutPatterns(text) : text, context),
    );
  }
  return { findings, scanned, optedOut, skipped };
}

const USAGE =
  "Usage: beacon-check-internal-refs [--strict [--allow <rule>]...] [--patterns <file>]...";

/** The value of `--name <value>` or `--name=<value>` at `args[i]`, and the index it ends at. */
function valueOf(
  /** @type {string[]} */ args,
  /** @type {number} */ i,
  /** @type {string} */ name,
) {
  return args[i] === name
    ? { value: args[i + 1], i: i + 1 }
    : { value: args[i].slice(name.length + 1), i };
}

/**
 * The bin's arguments: `--strict`; each `--allow <rule>` (or `--allow=<rule>`) naming a rule whose
 * findings are listed but do not fail; and each `--patterns <file>` (or `--patterns=<file>`), a
 * JSON file of private names (see {@link readPatterns}) relative to `cwd`, added to the manifest's.
 * An error message instead when they make no sense.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ strict: boolean, allowed: Set<string>,
 *   patterns: { file: string, patterns: PrivatePatterns }[] } | { error: string }}
 */
function parseArgs(args, cwd) {
  let strict = false;
  const allowed = new Set();
  /** @type {{ file: string, patterns: PrivatePatterns }[]} */
  const patterns = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--strict") strict = true;
    else if (arg === "--patterns" || arg.startsWith("--patterns=")) {
      const { value: file, i: next } = valueOf(args, i, "--patterns");
      i = next;
      if (!file) return { error: `--patterns takes a JSON file. ${USAGE}` };
      const path = resolve(cwd, file);
      const source = `--patterns ${file}`;
      try {
        const value = JSON.parse(readFileSync(path, "utf8"));
        patterns.push({ file: path, patterns: readPatterns(value, source) });
      } catch (error) {
        // readPatterns names its source; a file that can't be read or parsed is named here.
        const { message } = /** @type {Error} */ (error);
        return { error: message.startsWith(source) ? message : `${source}: ${message}` };
      }
    } else if (arg === "--allow" || arg.startsWith("--allow=")) {
      const { value: id, i: next } = valueOf(args, i, "--allow");
      i = next;
      if (!RULES.some((rule) => rule.id === id)) {
        const ids = RULES.map((rule) => rule.id).join(", ");
        return { error: `--allow takes a rule: one of ${ids}. ${USAGE}` };
      }
      allowed.add(id);
    } else return { error: `Unknown argument: ${arg}. ${USAGE}` };
  }
  // Report mode fails on nothing, so an allowance there means a `--strict` was left out.
  if (allowed.size > 0 && !strict) return { error: `--allow needs --strict. ${USAGE}` };
  return { strict, allowed, patterns };
}

/**
 * The bin: scan the repo at `cwd`, print the findings grouped by rule, and return the exit code.
 * @param {string[]} args the command-line arguments
 * @param {string} cwd
 * @param {{ log: (line: string) => void, error: (line: string) => void }} [io]
 * @returns {number}
 */
export function main(args, cwd, io = { log: console.log, error: console.error }) {
  const parsed = parseArgs(args, cwd);
  if ("error" in parsed) {
    io.error(parsed.error);
    return 2;
  }
  const { strict, allowed, patterns } = parsed;
  const { findings, scanned, optedOut, skipped } = scanRepo(cwd, patterns);
  const files = new Set(findings.map((f) => f.file)).size;
  const failing = findings.filter((f) => !allowed.has(f.rule));
  const mode = !strict
    ? " (report mode)"
    : allowed.size > 0
      ? `, ${findings.length - failing.length} of them allowed (${[...allowed].join(", ")})`
      : "";
  io.log(
    `${findings.length} internal reference${findings.length === 1 ? "" : "s"} in ${files} of the ` +
      `${scanned} files scanned${mode}`,
  );
  const byRule = Object.groupBy(findings, (f) => f.rule);
  for (const rule of RULES) {
    const own = byRule[rule.id] ?? [];
    const mark = allowed.has(rule.id) ? ", allowed" : "";
    if (own.length > 0) io.log(`\n${rule.title} (${rule.id}${mark}): ${own.length}`);
    for (const f of own) io.log(`  ${f.file}:${f.line}  ${f.match}`);
  }
  io.log("");
  for (const rule of RULES) {
    const count = String(byRule[rule.id]?.length ?? 0).padStart(6);
    io.log(`${count}  ${rule.id}${allowed.has(rule.id) ? " (allowed)" : ""}`);
  }
  const left = Object.entries(skipped).map(([reason, count]) => `${count} ${reason}`);
  if (left.length > 0) io.log(`\nNot scanned: ${left.join(", ")}`);
  if (optedOut.length > 0) {
    io.log(
      `\nNot scanned, as the check's own pattern data (a "${DIRECTIVE}" line or a --patterns ` +
        `file): ${optedOut.join(", ")}`,
    );
  }
  if (strict && failing.length > 0) {
    io.error(
      "\nPublic code points at what a public reader cannot open. Reword each line above so that " +
        "it stands on its own. A published doc goes under beacon.internalRefs.publishedDocs in " +
        "the root package.json, and a phrase that is fine where it stands, such as a legal name, " +
        "under beacon.internalRefs.privatePatterns.allow.",
    );
    return 1;
  }
  return 0;
}
