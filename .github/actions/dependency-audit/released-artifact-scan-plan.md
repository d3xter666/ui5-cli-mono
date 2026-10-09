# Plan: Audit released npm artifacts (not just source)

> Status: proposal / not yet implemented.
> Scope: extend `.github/actions/dependency-audit/audit.sh` to also audit the
> **latest released versions** of UI5 packages, in addition to the current
> source-code scopes.

## Problem

Today `audit.sh` runs `audit-ci` only against the **repo source code** (three
scopes: locked `npm ci` tree, latest dev+prod, latest prod-only). A vulnerability
that is already fixed in source but **not yet released** looks clean here, while
consumers installing the released artifact are still exposed. We want to also
audit what `npm install <package>@<tag>` gives consumers **today**.

The released install must happen **outside the repository**, in a throwaway
directory, so the repo's own `package.json` / lockfiles are never used.

## Confirmed packages & version targets

| Project          | npm package        | Target spec                 | Latest observed   |
|------------------|--------------------|-----------------------------|-------------------|
| UI5 CLI v4       | `@ui5/cli`         | `^4.0.0` (or tag `latest`)  | 4.0.71            |
| UI5 CLI v5       | `@ui5/cli`         | tag `next` (v5 is pre-release) | 5.0.0-alpha.13 |
| UI5 linter       | `@ui5/linter`      | `latest`                    | 1.23.7            |
| UI5 MCP server   | `@ui5/mcp-server`  | `latest`                    | 0.3.2             |

Open decisions (need owner input):
- **CLI v5 dist-tag**: v5 has no stable `latest`; this plan uses `next`. Confirm
  the dist-tag v5 is actually published under.
- **Older majors**: `latest-2` / `latest-3` exist on npm. Start with v4+v5 only;
  add older lines only if consumers still install them in meaningful numbers.

## Approach: extend `audit.sh` (don't fork a new script)

Reuse the existing building blocks:
- `audit_scope` helper (audit.sh:37-55) — pattern to mirror.
- config auto-detection → `${config_arg}` (audit.sh:26-35).
- jq → TSV `extract` (audit.sh:87-98) and the awk join/sort (audit.sh:104-121).
- step-summary rendering (audit.sh:123-133).

### New helper: `audit_released`

Add after `audit_scope`. For each package: make a temp dir **outside the repo**,
write a throwaway `package.json`, install with `--ignore-scripts` (never run
dependency lifecycle code — same safety stance as the existing installs), run
`audit-ci`, capture JSON, clean up.

```bash
# audit_released <label> <snapshot-name> <package-spec>
# e.g. audit_released "CLI v4 (released)" released-cli-v4 "@ui5/cli@^4.0.0"
audit_released() {
	local label="$1" name="$2" pkg_spec="$3"
	local rc=0
	local pkg_work
	pkg_work="$(mktemp -d)"
	echo "::group::Audit — ${label}"

	if ! (
		cd "${pkg_work}" || exit 1
		printf '{"name":"audit-temp","version":"0.0.0","private":true}\n' > package.json
		npm install --no-audit --no-fund --ignore-scripts "${pkg_spec}"
	) > "${work}/${name}.install.log" 2>&1; then
		echo "✗ ${label}: install of ${pkg_spec} failed"
		cat "${work}/${name}.install.log"
		failed=1
		rm -rf "${pkg_work}"
		echo "::endgroup::"
		return
	fi

	# IMPORTANT: config must be an ABSOLUTE path — we run audit-ci from the temp
	# dir (outside the repo), so the repo-relative ${config_arg} would NOT resolve.
	# shellcheck disable=SC2086 # intentional word-splitting of config_abs_arg
	(cd "${pkg_work}" && npx --yes audit-ci ${config_abs_arg} --output-format json) \
		> "${work}/${name}.json" 2> "${work}/${name}.log" || rc=$?
	cat "${work}/${name}.log" 2>/dev/null || true

	if [ "${rc}" -eq 0 ]; then
		echo "✓ ${label}: passed"
	else
		echo "✗ ${label}: audit-ci reported findings (exit ${rc})"
		failed=1
	fi
	rm -rf "${pkg_work}"
	echo "::endgroup::"
}
```

> **Config-path correctness (do not skip):** the existing script passes a
> repo-relative `${config_arg}` (e.g. `--config audit-ci.jsonc`). That only works
> because the source scopes run from the repo root. The released scans run from a
> temp dir, so we must resolve the config to an **absolute** path once up front:
>
> ```bash
> config_abs_arg=""
> if [ -n "${config_file}" ]; then
> 	config_abs_arg="--config $(cd "$(dirname "${config_file}")" && pwd)/$(basename "${config_file}")"
> fi
> ```
>
> Using the relative `${config_arg}` from inside the temp dir would silently drop
> the repo's allowlist/severity config and produce misleading results.

### Wire-up (after the source scopes, ~audit.sh:67)

```bash
# --- Released artifacts (what consumers install today) ----------------------
audit_released "CLI v4 (released)"  released-cli-v4 "@ui5/cli@^4.0.0"
audit_released "CLI v5 (released)"  released-cli-v5 "@ui5/cli@next"
audit_released "Linter (released)"  released-linter "@ui5/linter@latest"
audit_released "MCP (released)"     released-mcp    "@ui5/mcp-server@latest"
```

## Summary rendering: a second table

The current table is scope-oriented (prod / locked / dev+prod). Released scans
are per-package, so render a **second** table beneath the existing one.

- Reuse `extract` to produce `released-*.tsv` from each `released-*.json`.
- Copy the awk join (audit.sh:104-121), remapping the three presence columns to
  the four packages (CLI v4 / CLI v5 / Linter / MCP), sorted by severity.
- Append the second table to `$GITHUB_STEP_SUMMARY` right after the first.

```markdown
## Security audit comparison — Released Artifacts

| Advisory | Package | Severity | CLI v4 | CLI v5 | Linter | MCP |
|---|---|---|:--:|:--:|:--:|:--:|
| [GHSA-xxxx](url) | `foo` | high | ✓ | – | – | ✓ |

**How to read:** `✓` under any package means a consumer installing that
package today is exposed to the advisory.
```

## Gating & exit code (coordinate with the parallel Task 1 fix)

Owner requirement: **the job must fail when findings exist, but the summary must
always be written.** The released scans use the same `failed=1` accumulator, so
they integrate with the single `exit "${failed}"` gate (audit.sh:135). The Task 1
fix must guarantee the summary block runs *before* that non-zero exit even when a
scope fails (e.g. the script aborting early under `set -e`); this plan depends on
that fix landing. Do not suppress the gate.

## Edge cases

- **Install failure** (bad spec, registry/network): log it, set `failed=1`, skip
  the package's table cells, continue to the next package. One bad install must
  not block the others.
- **No advisories**: `audit-ci` exits 0, empty TSV, no `✓` for that package; if
  every package is clean, render the `_none_` row (matches audit.sh:128).
- **Allowlist**: released findings respect the same repo allowlist via the
  absolute `--config`. Transitive deps unique to a released artifact may surface
  new advisories; maintainers add them to `audit-ci.jsonc` with justification.
- **Version drift**: `^4`/`next`/`latest` are point-in-time, consistent with the
  existing "latest" scopes; the daily cron catches newly introduced vulns.
- **Cleanup**: each helper does inline `rm -rf "${pkg_work}"`; the top-level
  `trap ... EXIT` (audit.sh:21) still covers the main work dir on interrupt.

## Phased task list

1. **Helper + absolute config arg**: add `config_abs_arg` resolution and the
   `audit_released` helper; wire up the four scan calls. Verify each produces a
   `released-*.json`.
2. **Second summary table**: add `extract` calls for the four snapshots, a second
   awk join remapped to four package columns, and append the table to the
   summary. Verify both tables render on a local dry run.
3. **Edge-case tests**: bad spec (`@ui5/cli@999.0.0`) → partial results + fail;
   all-clean → `_none_`; allowlisted GHSA excluded from the released table.
4. **CI**: push to a branch, trigger the workflow via `workflow_dispatch`, confirm
   both tables appear in the job summary and the job fails iff findings exist.
5. **Docs**: extend the header comment in `audit.sh` to describe released scans;
   note the new behavior where the workflows are documented.

## Optional niceties

- `SKIP_RELEASED_SCANS=true` env guard to skip released scans on fast local runs.
- Parallelize the four scans with `&` / `wait` only if scan time becomes a problem
  (sequential is fine for four packages).
