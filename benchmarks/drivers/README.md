# Benchmark drivers

`run.sh` and `score.sh` do not know how to talk to an agent. A driver does.

One script per harness. `--driver NAME` resolves to `benchmarks/drivers/NAME.sh`;
`--driver PATH` (anything containing a `/`) runs a script of your own from
anywhere. `ALMAGEST_BENCH_DRIVER` sets the default. Default is `claude-code`.

| Driver | Drives | Verified |
|--------|--------|----------|
| `claude-code.sh` | the `claude` CLI | Yes — the reference driver, identical to the pre-driver harness |
| `codex.sh` | the `codex` CLI | **No.** Flags are a best understanding, marked in the file header |
| `gemini-cli.sh` | the `gemini` CLI | **No.** Flags are a best understanding, marked in the file header |
| `antigravity.sh` | the `agy` CLI (Google Antigravity — **not** the Gemini CLI) | Partly. The JSON envelope and `--json-schema` were exercised; `--sandbox` and a few others were not, and are marked in the file header. **Runs with `--dangerously-skip-permissions`** — arena only |
| `fake.sh` | nothing | Test double for `selftest.sh`. No API calls, no money |

## Interface

Three subcommands. Anything else must exit non-zero.

```
driver.sh capabilities   # TSV on stdout: <key><TAB><yes|no>, one per line
driver.sh version        # one line on stdout; non-zero exit if the CLI is missing
driver.sh run            # reads the env below, writes one JSON object to stdout
```

### `capabilities`

Exactly these six keys, each `yes` or `no`. The harness refuses to start if one
is missing or carries any other value.

| Key | `yes` means |
|-----|-------------|
| `tool_restriction` | the CLI can be held to the `ALM_TOOLS` allowlist |
| `budget_cap` | the CLI can be held to `ALM_BUDGET_USD` |
| `structured_output` | the CLI can be held to `ALM_SCHEMA_FILE` (the judge pass needs this) |
| `cost_reporting` | the run output carries a real per-call dollar cost |
| `session_isolation` | nothing is carried between calls |
| `sandbox` | the CLI can be run in a read-only / safe mode |

**Report `no` for anything the CLI cannot actually enforce.** These keys are
written into `run.env` and drive the report's Comparability block; a `no` costs
you a warning and, for `budget_cap`, an extra confirmation. A `yes` that is not
true costs the reader a number they cannot trust, which is worse. If the answer
depends on the installed build, probe for it — `codex.sh` and `gemini-cli.sh`
grep `--help` and report what they find.

`capabilities` must work with the CLI absent or broken, because the preflight
calls it before anything else. Report `no` in that case.

### `version`

One line identifying the CLI and its version, recorded as `driver_version` in
`run.env`. Exit non-zero (message on stderr) when the CLI is not installed —
`run.sh` turns that into a loud preflight failure before it spends anything, and
`--dry-run` into a `driver_version=unknown`.

### `run`

Reads the job from the environment. cwd is the arm's arena directory.

| Var | Meaning |
|-----|---------|
| `ALM_PROMPT` | the question, or the judge payload |
| `ALM_SYSTEM` | system prompt to append |
| `ALM_MODEL` | model name, spelled the way this CLI spells it |
| `ALM_TOOLS` | comma-separated allowlist. Empty string means **no tools** |
| `ALM_BUDGET_USD` | per-call spend cap |
| `ALM_SCHEMA_FILE` | path to a JSON schema file, or empty |
| `ALM_CLI` | override for the binary the driver invokes (optional) |

Writes **one flat JSON object** to stdout:

```json
{"result":"…","is_error":false,"duration_ms":0,"num_turns":0,"total_cost_usd":0,"session_id":"…"}
```

`result` is the answer text — for the judge, the JSON verdict as a string. Only
`result` is required. Omit any of the rest you cannot report honestly; the
harness records the missing ones as blank and falls back to its own wall clock
for latency. It never fills a gap with a number.

Top-level scalars only. `lib/json_scalar.awk` parses this and skips nested
objects and arrays rather than descending into them, so a value that matters
must not be nested. `lib/json_escape.awk` is there for drivers that have to wrap
a CLI's plain-text output:

```bash
printf '{"result":"%s","is_error":false}\n' "$(awk -f ../lib/json_escape.awk < out.txt)"
```

Exit non-zero if the call failed. `run.sh` records the arm as failed, keeps the
stderr log, and exits non-zero itself. Do not paper over a failed call with an
empty answer — an empty answer that scores is worse than a run that stops.

## Rules for a new driver

1. **Bash, awk, sed, coreutils.** No node, no python, no package manager. That
   property is advertised in `docs/benchmarks.md`.
2. **Never fake a capability.** See above.
3. **Say where you deviate.** No two CLIs take a system prompt the same way. If
   yours has no `--append-system-prompt` equivalent and you prepend `ALM_SYSTEM`
   to the prompt instead, put it in the file header — that difference is part of
   what a cross-harness comparison is measuring.
4. **Mark unverified flags in the header**, with the failure mode if they are
   wrong. `codex.sh` and `gemini-cli.sh` are written this way.
5. **One call in, one call out.** No retries, no fallbacks between models. A
   driver that silently retries turns a failure into a slower success and the
   harness cannot tell.
6. Run `benchmarks/selftest.sh` afterwards, then a real `--only q01 --arm both`
   and read both answers before trusting anything.

## Known limitation: parent-directory context

Most agent CLIs load instruction files from the working directory upwards —
`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`. The arena lives under
`benchmarks/results/`, inside this repository, so a driver may pick up
Almagest's own instruction files on top of the arm's system prompt. It affects
both arms equally and so does not favour one, but it is not nothing. Run the
arena from a directory outside the repo if you need that clean.
