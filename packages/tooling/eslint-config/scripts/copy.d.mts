// The types of copy.mjs, for a TypeScript repo that imports `@beaconsgg/eslint-config/copy`.
// This file is the one declaration of the shapes, which copy.mjs imports; copy.mjs documents the
// functions. The package's suite checks that this file declares every export.

/** A Markdown paragraph, list item or table row, or one JSX text run or string, and its line. */
export type Passage = { line: number; text: string };

/** `id` names the rule; `rule` is its label, which adds the word it matched: `banned "very"`. */
export type Finding = { line: number; id: string; rule: string; text: string; fatal: boolean };

/**
 * One rule the check runs. A passage rule reads a whole passage; a sentence rule reads one sentence
 * at a time. `match` returns the finding's label, or null. A rule that isn't `fatal` warns, and
 * `--strict` fails on it too. A `docsOnly` rule is checked only in a docs page, where a question is
 * rhetorical; a label in an app may ask.
 */
export type Rule = {
  id: string;
  scope: "passage" | "sentence";
  fatal: boolean;
  docsOnly?: boolean;
  match: (text: string) => string | null;
};

export declare const BANNED: readonly string[];
export declare const RULES: readonly Rule[];
export declare function proseOfMarkdown(text: string): Passage[];
export declare function proseOfSource(text: string, fileName?: string): Passage[];
export declare function checkProse(passages: Passage[], options?: { docs?: boolean }): Finding[];
export declare function main(
  args: string[],
  cwd: string,
  io?: { log: (line: string) => void; error: (line: string) => void },
): number;
