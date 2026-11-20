/**
 * Check: a repo's prose keeps the writing rules a script can see (STYLE.md beside this package,
 * "What the gate checks").
 *
 *   beacon-check-copy [--strict | --report] <path or glob>...   (`@beaconsgg/eslint-config`'s bin)
 *
 * The rest of STYLE.md is for review. Markdown files are read as docs pages, where a question
 * fails. A .ts, .tsx, .js or .jsx file is read for the words a reader sees in it: its JSX text and
 * its string literals. Which rules fail and which only warn is set in RULES; `--strict` fails on
 * the warnings too, and `--report` lists everything and exits 0.
 *
 * Text is checked a passage at a time: a Markdown paragraph, list item or table row with its
 * wrapped lines joined, or one JSX text run or string literal. A finding carries the line its
 * passage starts on.
 *
 * This module defines the check and exports its parts, so a repo can run the rules over text of
 * its own; `check-copy.mjs` beside it is the bin that runs `main` on the working directory.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * The shapes are declared, with their docs, in copy.d.mts beside this file.
 * @typedef {import("./copy.d.mts").Passage} Passage
 * @typedef {import("./copy.d.mts").Finding} Finding
 * @typedef {import("./copy.d.mts").Rule} Rule
 */

/**
 * TypeScript, loaded on the first source file: a run over Markdown alone never needs the compiler,
 * which takes most of such a run's time to load.
 * @type {typeof import("typescript") | undefined}
 */
let typescript;
const require = createRequire(import.meta.url);

/**
 * Hype, filler, hedges, minimizers, preamble and wrap-ups (STYLE.md "Leave out" 5 to 8). Matched as
 * whole words, case-insensitive.
 */
export const BANNED = Object.freeze([
  "really",
  "truly",
  "actually",
  "very",
  "effortless",
  "effortlessly",
  "robust",
  "seamless",
  "seamlessly",
  "powerful",
  "leverage",
  "delve",
  "elevate",
  "empower",
  "journey",
  "streamline",
  "at a glance",
  "in one place",
  "whether you're",
  "let's",
  "here's",
  // Minimizers.
  "simply",
  "easily",
  "of course",
  "obviously",
  "straightforward",
  // Hype and hedges.
  "supercharge",
  "dive into",
  "deep dive",
  "crucial",
  "comprehensive",
  "various",
  "a number of",
  // Preamble and wrap-ups.
  "in this guide",
  "it's worth noting",
  "it's important to",
  "as mentioned",
  "that's it",
  "you're all set",
  "in summary",
]);

/** @param {readonly string[]} words */
const wordsRe = (words) =>
  new RegExp(
    `(?<![\\w'’])(${words.map((w) => w.replace(/'/g, "['’]").replace(/ /g, "\\s+")).join("|")})(?![\\w'’])`,
    "i",
  );

/** British spellings, for US English (STYLE.md "Mechanics"). The -ise verbs are listed by stem. */
const BRITISH_RE = new RegExp(
  "\\b(" +
    [
      "colour(s|ed|ing|ful)?",
      "licence[sd]?",
      "behaviour(s|al)?",
      "honour(s|ed|ing)?",
      "favour(s|ed|ing|ite|ites)?",
      "centre[sd]?",
      "(kilo|centi|milli)?metres?",
      "catalogues?",
      "neighbour\\w*",
      "grey(s|ed|ing)?",
      "defence",
      "offence",
      "programmes?",
      "fulfil(s|ment)?",
      // Not "analyses": the US plural of "analysis" is spelled the same.
      "analys(e|ed|ing)",
      "(cancel|label|model|signal|travel|level|fuel)l(ed|ing)",
      "whilst",
      "amongst",
      "(apolog|author|categor|custom|emphas|final|initial|local|maxim|minim|normal|optim|organ|priorit|real|recogn|serial|special|standard|summar|synchron|util|visual)is(e|ed|es|ing|ation|ations)",
    ].join("|") +
    ")\\b",
  "i",
);

/** @param {RegExp} re @param {string} label */
const when = (re, label) => (/** @type {string} */ text) => (re.test(text) ? label : null);
/** @param {RegExp} re @param {string} kind */
const named = (re, kind) => (/** @type {string} */ text) => {
  const match = re.exec(text);
  return match ? `${kind} "${match[1].toLowerCase().replace(/\s+/g, " ")}"` : null;
};

/**
 * True when every comma in the sentence sits in a list of short items ("iOS, Android or web"),
 * which STYLE.md allows: the items between commas are a word or two, and the last part holds the
 * "and" or "or".
 * @param {string} sentence
 */
function commasAreAList(sentence) {
  const parts = sentence.split(",");
  const last = parts.at(-1) ?? "";
  return (
    /\b(and|or)\b/.test(last) && parts.slice(1, -1).every((p) => p.trim().split(/\s+/).length <= 2)
  );
}

/**
 * Every rule the check runs (STYLE.md, "What the gate checks"), in the order it reports them.
 * @type {readonly Rule[]}
 */
export const RULES = Object.freeze([
  { id: "dash", scope: "passage", fatal: true, match: when(/[–—]/, "dash") },
  // A hyphen with a space on each side, between words: "one - two".
  { id: "spaced hyphen", scope: "passage", fatal: true, match: when(/\S - \S/, "spaced hyphen") },
  { id: "banned", scope: "passage", fatal: true, match: named(wordsRe(BANNED), "banned") },
  // Often filler, sometimes meant ("just now"), so a reviewer decides.
  { id: "filler", scope: "passage", fatal: false, match: named(wordsRe(["just"]), "filler") },
  { id: "spelling", scope: "passage", fatal: true, match: named(BRITISH_RE, "spelling") },
  {
    id: "exclamation",
    scope: "passage",
    fatal: true,
    match: when(/[A-Za-z][)"'’]?!+(?=[\s)"'’]|$)/, "exclamation"),
  },
  {
    id: "comma",
    scope: "sentence",
    fatal: false,
    match: (s) => ((s.match(/,/g) ?? []).length > 1 && !commasAreAList(s) ? "comma" : null),
  },
  // A warning until the docs written before the rule are rewritten.
  { id: "it start", scope: "sentence", fatal: false, match: when(/^["'“‘(]?Its?\b/, "it start") },
  // A question in quotes is cited, such as a dialog's label, and passes.
  {
    id: "question",
    scope: "sentence",
    fatal: true,
    docsOnly: true,
    match: when(/\?\)?$/, "question"),
  },
]);

/** A line that starts a Markdown block of its own: a heading, a list item, a quote or a table row. */
const BLOCK_START_RE = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/;
const HEADING_RE = /^\s*#{1,6}\s/;

/**
 * Markdown prose as passages, with code left out: fenced blocks entirely, inline code as `x`. A
 * link or an image reads as its text, and emphasis markers are dropped.
 * @param {string} text
 * @returns {Passage[]}
 */
export function proseOfMarkdown(text) {
  /** @type {Passage[]} */
  const passages = [];
  /** @type {{ char: string, length: number } | null} */
  let fence = null;
  /** @type {Passage | null} */
  let current = null;
  const lines = text.split("\n");
  // Front matter: each field is its own passage, without its key.
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    for (let i = 1; i < end; i++) {
      const value = lines[i].replace(/^[\w-]+:\s*/, "");
      if (value) passages.push({ line: i + 1, text: value });
      lines[i] = "";
    }
    lines[0] = lines[end] = "";
  }
  lines.forEach((line, i) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      // A fence closes only on its own character, at least as long as it opened, with nothing after.
      const closes = marker && line.trim() === marker;
      if (closes && marker[0] === fence.char && marker.length >= fence.length) fence = null;
      return;
    }
    if (marker || !line.trim()) {
      if (current) passages.push(current);
      current = null;
      if (marker) fence = { char: marker[0], length: marker.length };
      return;
    }
    const prose = line
      .replace(/`[^`]*`/g, "x")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s*([-*+]|\d+[.)])\s+/, "")
      // Emphasis markers, so a rule sees "**Done!**" as "Done!". An underscore inside a word stays.
      .replace(/\*+|~~|(?<!\w)_+|_+(?!\w)/g, "")
      .replace(/^\s*>\s?/, "")
      .replace(/\|/g, " . ");
    if (current && !BLOCK_START_RE.test(line)) {
      current.text += ` ${prose.trim()}`;
    } else {
      if (current) passages.push(current);
      current = { line: i + 1, text: prose };
    }
    // A heading is one line: the line after it starts a passage of its own.
    if (HEADING_RE.test(line)) {
      passages.push(current);
      current = null;
    }
  });
  if (current) passages.push(current);
  return passages;
}

/**
 * A Tailwind class list held outside `className`, such as `const card = "bg-panel border p-3.5"`:
 * every token has a class's shape, and at least half of them carry a "-", ":" or "[".
 * @param {string} words
 */
function isClassList(words) {
  const tokens = words.split(" ");
  return (
    tokens.every((t) => /^!?[a-z0-9][\w:[\]/.%#-]*!?$/.test(t)) &&
    tokens.filter((t) => /[-:[]/.test(t)).length * 2 >= tokens.length
  );
}

/** Attributes whose values are code, never words a reader sees. */
const CODE_ATTRIBUTES = new Set([
  "className",
  "href",
  "key",
  "id",
  "src",
  "type",
  "rel",
  "target",
  "style",
]);

/**
 * The words a reader sees in a .ts, .tsx, .js or .jsx file, as passages: JSX text and string and
 * template literals. Comments, imports, class lists, object keys and type positions are code.
 * @param {string} text
 * @param {string} [fileName] the file's name, whose extension says how to parse it
 * @returns {Passage[]}
 */
export function proseOfSource(text, fileName = "x.tsx") {
  const ts = (typescript ??= require("typescript"));
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  /** @type {Passage[]} */
  const passages = [];
  /** @param {import("typescript").Node} node @param {string} value */
  const add = (node, value) => {
    const words = value
      .replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
    // No letters, a JSON sample or a class list: code either way.
    if (!/[A-Za-z]{2}/.test(words) || /^[[{]/.test(words) || isClassList(words)) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    passages.push({ line, text: words });
  };
  /** @param {import("typescript").Node} node @returns {boolean} */
  const isCode = (node) => {
    const parent = node.parent;
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
    if (ts.isLiteralTypeNode(parent) || ts.isElementAccessExpression(parent)) return true;
    if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
    if (ts.isExpressionStatement(parent)) return true; // a directive: "use client"
    // A tagged template is a query or a style, written for a machine: sql`SELECT …`.
    if (ts.isTaggedTemplateExpression(parent)) return true;
    for (let p = parent; !ts.isSourceFile(p) && !ts.isBlock(p); p = p.parent) {
      if (ts.isJsxAttribute(p)) return CODE_ATTRIBUTES.has(p.name.getText(source));
    }
    return false;
  };
  /** @param {import("typescript").Node} node */
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      add(node, node.getText(source));
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isCode(node)) add(node, node.text);
    } else if (ts.isTemplateExpression(node)) {
      if (!isCode(node)) {
        add(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" x "));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return passages;
}

/**
 * The findings for one file's passages. `docs` is set for a docs page, which adds the docs-only
 * rules.
 * @param {Passage[]} passages
 * @param {{ docs?: boolean }} [options]
 * @returns {Finding[]}
 */
export function checkProse(passages, { docs = false } = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const rules = RULES.filter((rule) => docs || !rule.docsOnly);
  for (const { line, text } of passages) {
    /** @param {Rule["scope"]} scope @param {string} what */
    const check = (scope, what) => {
      for (const rule of rules) {
        const label = rule.scope === scope ? rule.match(what) : null;
        if (label) {
          findings.push({
            line,
            id: rule.id,
            rule: label,
            text: what.trim().slice(0, 120),
            fatal: rule.fatal,
          });
        }
      }
    };
    check("passage", text);
    for (const sentence of text.split(/(?<=[.!?])\s+/)) check("sentence", sentence.trim());
  }
  return findings;
}

const MARKDOWN_RE = /\.md$/;
const SOURCE_RE = /\.[cm]?[jt]sx?$/;
const USAGE = "Usage: beacon-check-copy [--strict | --report] <path or glob>...";

/**
 * The files git tracks, or would track, that match `pattern`: a path, a directory or a glob in
 * git's glob syntax, where `**` crosses directories. Ignored files are left out.
 * @param {string} cwd
 * @param {string} pattern
 * @returns {string[]}
 */
function filesMatching(cwd, pattern) {
  return execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", `:(glob)${pattern}`],
    { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
}

/**
 * The bin: check the files `args` names in the repo at `cwd`, print each finding, and return the
 * exit code. A Markdown file is read as a docs page; a source file for its JSX text and strings.
 * Files of another type that a pattern matches are skipped.
 * @param {string[]} args the command-line arguments
 * @param {string} cwd
 * @param {{ log: (line: string) => void, error: (line: string) => void }} [io]
 * @returns {number}
 */
export function main(args, cwd, io = { log: console.log, error: console.error }) {
  const flags = args.filter((arg) => arg.startsWith("--"));
  const patterns = args.filter((arg) => !arg.startsWith("--"));
  const unknown = flags.filter((flag) => flag !== "--strict" && flag !== "--report");
  const strict = flags.includes("--strict");
  const report = flags.includes("--report");
  if (unknown.length > 0) {
    io.error(`Unknown argument: ${unknown.join(" ")}. ${USAGE}`);
    return 2;
  }
  if (patterns.length === 0 || (strict && report)) {
    io.error(USAGE);
    return 2;
  }
  /** @type {Set<string>} */
  const files = new Set();
  for (const pattern of patterns) {
    const matched = filesMatching(cwd, pattern);
    if (matched.length === 0) {
      io.error(`No file matches ${pattern}. ${USAGE}`);
      return 2;
    }
    for (const file of matched) files.add(file);
  }
  /** @type {Array<Finding & { file: string }>} */
  const found = [];
  let checked = 0;
  for (const file of [...files].sort()) {
    const markdown = MARKDOWN_RE.test(file);
    if (!markdown && !SOURCE_RE.test(file)) continue;
    /** @type {string} */
    let text;
    try {
      text = readFileSync(join(cwd, file), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    checked += 1;
    const passages = markdown ? proseOfMarkdown(text) : proseOfSource(text, file);
    for (const f of checkProse(passages, { docs: markdown })) found.push({ file, ...f });
  }
  let failing = 0;
  for (const f of found) {
    const fails = f.fatal || strict;
    if (fails) failing += 1;
    io.log(`${fails ? "error" : "warn "} ${f.file}:${f.line} rule ${f.rule}: ${f.text}`);
  }
  const filesWith = new Set(found.map((f) => f.file)).size;
  io.log(
    `\nbeacon-check-copy: ${failing} error(s) and ${found.length - failing} warning(s) in ` +
      `${filesWith} of the ${checked} files checked${report ? " (report mode)" : ""}`,
  );
  for (const rule of RULES) {
    const count = found.filter((f) => f.id === rule.id).length;
    if (count > 0)
      io.log(`${String(count).padStart(6)}  ${rule.id}${rule.fatal ? "" : " (warns)"}`);
  }
  if (failing > 0 && !report) {
    io.error(`beacon-check-copy: ${failing} finding(s) break STYLE.md`);
    return 1;
  }
  return 0;
}
