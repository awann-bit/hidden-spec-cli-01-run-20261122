# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/awann-bit/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/awann-bit/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format. It applies an AI-written edit to a tree of text files, in any of four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls — finding the lines an edit names even when the model drifted their whitespace or indentation, and changing every file or none. Node 22, standard library only, no network, no model calls, deterministic.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` / absent for standard input. `--format=unified|search-replace|v4a|json|auto` picks the format (default `auto`), `--check` reports what would change without writing, `--strict` matches lines exactly. See `SPEC.md` in the kit for the whole contract (the kit is not part of this repository).

---

<sub>Entered on [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
