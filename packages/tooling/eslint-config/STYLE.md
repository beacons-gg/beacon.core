# Writing style guide

This guide covers all public-facing Beacon text, in every Beacon repository:

- the docs, the specs and the `llms` files;
- the READMEs;
- the website;
- the operator console;
- the hosting dashboard;
- emails.

Use this guide when you write or review any of them. Games built on Beacon keep a style of their
own.

The `beacon-check-copy` bin of `@beaconsgg/eslint-config` checks the rules a script can see. The
rest are for review.

## Who reads

Two kinds of reader use Beacon.

- **Game developers** build on the SDK. They know TypeScript and HTTP. Beacon is new to them.
- **Operators** run servers. They know Linux, Docker, Postgres and reverse proxies. They care about
  defaults, limits, failure modes, upgrades and their players' data.

Both are busy and technical. Many read in their second language. Many arrive from a search or an AI
assistant in the middle of a task, so every page has to make sense on its own.

## Tone

Write the way a senior engineer explains something to a colleague they respect. Be direct and exact.

- **Plain sentences.** Write in the second person and the present tense, in the active voice. Steps
  are commands such as "Run" and "Set".
- **Assume skill.** Don't explain Docker or HTTP. Explain a Beacon term in one line the first time a
  page uses it. Link the page that covers it.
- **Describe what Beacon does.** The docs and the apps never praise Beacon. A reader here has usually
  chosen Beacon already. A reader who is still choosing trusts facts over adjectives.
- **Be exact.** Give the default, the limit and the unit. Name the setting, the route and the error
  code. "Up to 256 cells per request" beats "a large number of cells".
- **Be honest about limits.** Say what Beacon doesn't do. Work in progress goes under a heading
  called _Coming_ that links its issue.
- **Warn before harm.** Say so before any step that deletes data or can't be undone. The same goes
  for a step that weakens security.

Two examples:

- ✗ "Beacon makes backups effortless, so you can rest easy knowing your data is safe."
- ✓ "With media turned on images are in the `media` volume. Make sure to back them up with the
  database."

<!-- -->

- ✗ "Don't worry, restoring is simple!"
- ✓ "A restore gives the server the backup's name and key."

## Leave out

Readers have learned to spot these patterns, and they stop trusting the text once they see them.
Rules marked **gate** fail `beacon-check-copy`. Rules marked **warn** are reported for review.

1. **Dashes between words** (gate). No em dash, no en dash and no spaced hyphen. Write two sentences
   or join the parts with "and" or a colon. A range uses "to": "12 to 24".

   - ✗ "One container — one Postgres."
   - ✓ "Each server runs in a single container with one Postgres database."

2. **Contrast framing.** "Not X but Y", "X, not Y" and "it isn't just X, it's Y". Say what the
   thing is and leave out what it isn't.

   - ✗ "The directory is a finding aid, not a root of trust."
   - ✓ "The directory lists servers. Your game still checks a server's signature before adding the
     server."

3. **Comma chains** (warn). Use at most one comma in a sentence. A plain list of short items doesn't
   count. Split the sentence or make a list. Leave out the comma after a short opening phrase.

   - ✗ "The checker, once a minute, fetches each listed server's descriptor, checks its signature,
     and reports the result."
   - ✓ "Once a minute the checker fetches each listed server's descriptor. The checker then verifies
     the signature."

4. **Lists of three for rhythm.** "Fast, simple and secure." A list has as many items as are true.
   One reason is enough when there is one.

5. **Preamble and signposting** (gate). "In this guide", "Let's", "Here's how", "It's worth
   noting", "It's important to" and "As mentioned". Start with the content.

   - ✗ "In this guide, we'll walk through how to turn on the API docs. Let's get started."
   - ✓ "Set `BEACON_DOCS=on` to serve the OpenAPI document at `/docs/openapi.json`."

6. **Wrap-ups and cheer** (gate). "That's it", "You're all set", "In summary", recap paragraphs and
   exclamation marks. The page ends when the task ends, and the last line links the next step.

7. **Minimizers** (gate, and "just" warns). "Simply", "easily", "of course", "obviously",
   "straightforward" and "just". They help no one, and they insult the reader whose step failed.

8. **Hype, filler and hedges** (gate). Words picked for their sound, such as robust, seamless,
   powerful, leverage, supercharge, delve, crucial and comprehensive. Vague hedges such as "various"
   and "a number of". Name the number or the case. The full list is in `scripts/copy.mjs` beside this
   guide.

9. **Rhetorical questions and reveals** (gate in the docs). "Why does this matter?", "The result? A
   faster server." and "Here's the catch:". State the point. In the apps a label or a dialog may ask
   the reader to choose: "Which games?"

   - ✗ "What happens when a room is gone? You get a 404."
   - ✓ "`GET /rooms/:id` answers `404` with `unknownRoom` when the room is gone or never existed."

10. **Formatting as decoration.** Bold-led bullets standing in for paragraphs, a heading over every
    paragraph, bold scattered for emphasis, emoji, or a callout in every section. Use a list when
    the items are parallel and a table when they share columns.

11. **Sentences that start with "It"** (warn, gate after the docs rewrite). The rule covers "It",
    "Its" and "It's". Name the subject instead, even when the sentence before named it. Any pronoun
    needs one clear referent, so repeat the noun when in doubt.

    - ✗ "Your server's address. It can't change later."
    - ✓ "Your server's address can't be changed later."

12. **Clipped writing.** Fragments, dropped articles and shortened names. Write whole sentences and
    give a thing its full name: "Postgres database" and "operator console". A label or a button may
    be a fragment. A sentence that explains something may not.

    - ✗ "Each server runs in one container with one Postgres."
    - ✓ "Each server runs in a single container with one Postgres database."

## Product copy

These rules are for the website, the console, the hosting dashboard and emails.

- **Buttons name the action:** _Submit a server_, _Copy address_ and _Claim this listing_.
- **An error says what happened and then what to do.** An error code alone is never enough.
  - ✗ "Error 503."
  - ✓ "The directory's database is out of reach. Try again in a minute."
- **A permanent choice says so** where the reader makes the choice.
- **Copy adds what the screen can't show.** Leave out what the screen already shows.
  - ✗ "Your runs show here, day by day, from the first one."
  - ✓ "Your runs will show here."
- **A confirmation names the thing and the consequence:** "Remove this room? Players will no longer
  see the room."
- **Machine values** such as addresses, keys and DIDs are set in a monospace font and can be copied.

## Kinds of docs page

Each docs page is one of four kinds. Don't mix them.

| Kind      | Answers               | Shape                                                                                                            |
| --------- | --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Tutorial  | "Show me it working." | One path from nothing to a working result, with every step shown. Only the quickstart is a tutorial.             |
| Task      | "How do I do X?"      | Opens with the result. Then the prerequisites and numbered steps. Ends with a check and a link to the next step. |
| Concept   | "How does X work?"    | What the thing is and why Beacon works that way. Diagrams and examples, with no steps.                           |
| Reference | "What exactly is X?"  | Every route, setting or error in the same shape. Generated from the code wherever possible.                      |

A task page starts like this:

```md
---
title: Serve the API docs
description: Turn on a server's OpenAPI document and its browsable UI.
section: Run a server
---

When you finish, your server serves its OpenAPI document at `/docs/openapi.json`.

You need:

- a running server;
- access to the server's environment settings.
```

## Mechanics

- **Spelling** is US English: color, license, behavior and canceled. The gate fails the common
  British spellings.
- **Headings** use sentence case and no end punctuation, so a heading is never a question. A task heading starts with a verb, as in
  "Back up a server".
- **Sentences** carry one idea each. Over 25 words is a sign to split.
- **Code font** marks anything a reader types or the machine prints: commands, paths, settings,
  routes, error codes and field names.
- **Settings** are written as their variable, with the default and the unit:
  "`BEACON_DOCS` (default `off`)".
- **Code blocks** name their language. A command block holds only what the reader types, with no `$`
  prompt. Output goes in a block of its own, introduced as output.
- **Placeholders** look like `<server-url>`, and the text under the block says what goes in each.
  Use working values everywhere else.
- **Snippets** come from files the repository typechecks, such as the website's `examples/`. Don't
  paste code into a page by hand.
- **Numbers** are digits with a space before the unit: "512 MB" and "30 seconds". A range uses "to":
  "12 to 24".
- **Links** name where they go. Never write "click here" or "this page". Link a term once per page
  at its first use.
- **Callouts** are _Note_ or _Warning_. Use a warning for data loss or a security risk, and for
  anything that can't be undone. Use one at most per section.
- **Versions.** Each docs page names the release it was checked against.
- **People** are "you" (the reader), "players" and "operators". Use "they" for anyone else.
- **Idioms** stay out. Second-language readers and translation tools trip on them.

## What the gate checks

`beacon-check-copy` reads the files its arguments name, in the repository it runs in. An argument
is a path, a directory or a glob. In a glob `**` crosses directories. Each repository names its own
files in a `package.json` script:

```sh
beacon-check-copy 'docs/**/*.md' 'app/**/*.tsx'  # fails on a finding marked Fails
beacon-check-copy --strict 'docs/**/*.md'        # fails on the warnings too
beacon-check-copy --report 'doc/**/*.md'         # lists every finding and exits 0
```

A Markdown file is read as a docs page. A `.ts`, `.tsx`, `.js` or `.jsx` file is read for the words
a reader sees: its JSX text and its string literals. Code blocks, inline code, class lists and other
code are skipped. The check reads only the files git tracks or would track. The rules are in
`scripts/copy.mjs` beside this guide, and `@beaconsgg/eslint-config/copy` exports them for a
repository that runs them over text of its own.

| Rule                                                 | Result                       |
| ---------------------------------------------------- | ---------------------------- |
| An em dash, an en dash or a spaced hyphen            | Fails                        |
| A word or phrase from the banned list                | Fails                        |
| A British spelling                                   | Fails                        |
| An exclamation mark                                  | Fails                        |
| A question in a docs page                            | Fails                        |
| More than one comma, unless the commas sit in a list | Warns                        |
| "Just"                                               | Warns                        |
| A sentence that starts with "It", "Its" or "It's"    | Warns until the docs rewrite |

A repository whose text predates this guide runs the check with `--report` until the text is clean.

## Before you merge

- [ ] The repository's `beacon-check-copy` script passes, and someone has read its warnings on the
      changed text.
- [ ] A docs page is one kind and sits in the right section.
- [ ] Every command was run, and every snippet comes from a typechecked file.
- [ ] Defaults, limits and units are stated.
- [ ] Anything destructive has a warning before the step.
- [ ] The text has none of the twelve patterns above.
