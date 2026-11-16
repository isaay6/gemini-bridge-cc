# Contributing

## Setup

Node.js 18.18+; there are no runtime npm dependencies.

```bash
npm test                 # unit and integration tests (fake agy)
bash scripts/smoke.sh    # real agy smoke test; needs an installed, signed-in agy
```

`scripts/smoke.sh` makes real model calls (using `gemini-3.8-flash-low`) in a temporary repo under `$HOME`. It is not part of `npm test`.

## Versioning

The version lives in several files. Use the script, never edit them by hand:

```bash
npm run bump-version -- 0.2.0
npm run check-version
```

## Guidelines

- Keep public docs, command descriptions and prompts in English.
- Never pass `--dangerously-skip-permissions` or `--mode plan` to `agy`.
- Add or update tests with every behavior change, and add a CHANGELOG entry.
- Keep the read-only allow-list (`git, ls, cat, grep, find, rg, head, tail, wc`) as is unless there is a security review.
