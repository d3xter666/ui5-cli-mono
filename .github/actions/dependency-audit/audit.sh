#!/usr/bin/env bash
#
# Audits dependencies with audit-ci and writes comparison tables to the GitHub job summary
# (or stdout when run locally). Two groups of scopes are covered:
#
# Source code (the checked-out workspace):
#   locked · ci (dev + prod)   What the committed package-lock.json pins — the reproducible
#                              tree we build and test against.
#   latest (dev + prod)        What the repo resolves to today with the lockfile ignored —
#                              early warning across everything we pull in.
#   latest (prod only)         What a fresh install gives consumers today (production deps only).
#
# Released artifacts (what consumers install today, audited OUTSIDE the repo so the repo's own
# package.json / lockfiles are never used): the latest published UI5 CLI v4 & v5, UI5 linter and
# UI5 MCP server. This catches a vulnerability that is already fixed in source but not yet released.
#
# audit-ci runs every scope, so each repository/branch's own audit-ci config (allowlist, severity
# threshold, registry) is honoured — the config file is auto-detected from the checkout.
# "--ignore-scripts" is used for every install: the audit only needs the resolved dependency tree,
# and never running dependency lifecycle code keeps this safe on untrusted/unpinned versions.

# No "-e": a failing scope must not stop the remaining scopes from running.
set -uo pipefail

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

failed=0

# Auto-detect this repo/branch's audit-ci config so audit-ci honours it (allowlist, levels, ...).
config_file=""
config_arg=""
for f in audit-ci.jsonc audit-ci.json .audit-ci.jsonc .audit-ci.json; do
	if [ -f "${f}" ]; then
		config_file="${f}"
		config_arg="--config ${f}"
		echo "Using audit-ci config: ${f}"
		break
	fi
done

# Absolute form of the config path. The released-artifact scans run audit-ci from a temp dir
# OUTSIDE the repo, where the repo-relative "${config_arg}" would not resolve — they use this.
config_abs_arg=""
if [ -n "${config_file}" ]; then
	config_abs_arg="--config $(cd "$(dirname "${config_file}")" && pwd)/$(basename "${config_file}")"
fi

# audit_scope <label> <snapshot-name> [extra audit-ci args]
# Runs audit-ci once against the current workspace: exit code gates pass/fail, JSON feeds the summary.
audit_scope() {
	local label="$1" name="$2"
	shift 2
	local rc=0
	echo "::group::Audit — ${label}"
	# shellcheck disable=SC2086 # intentional word-splitting of config_arg
	npx --yes audit-ci ${config_arg} "$@" --output-format json \
		> "${work}/${name}.json" 2> "${work}/${name}.log" || rc=$?
	cat "${work}/${name}.log" 2>/dev/null || true
	if [ "${rc}" -eq 0 ]; then
		echo "✓ ${label}: passed"
	else
		echo "✗ ${label}: audit-ci reported findings (exit ${rc})"
		failed=1
	fi
	echo "::endgroup::"
}

# audit_released <label> <snapshot-name> <package-spec>
# Installs a published package into a throwaway dir OUTSIDE the repo and audits that tree, so the
# scan reflects what "npm install <package-spec>" gives consumers today — not the repo source.
audit_released() {
	local label="$1" name="$2" pkg_spec="$3"
	local rc=0
	local pkg_work
	pkg_work="$(mktemp -d)"
	echo "::group::Audit — ${label}"

	# Isolated install: throwaway package.json, --ignore-scripts for safety on unpinned versions.
	if ! (
		cd "${pkg_work}" || exit 1
		printf '{"name":"audit-temp","version":"0.0.0","private":true}\n' > package.json
		npm install --no-audit --no-fund --ignore-scripts "${pkg_spec}"
	) > "${work}/${name}.install.log" 2>&1; then
		echo "✗ ${label}: install of ${pkg_spec} failed"
		cat "${work}/${name}.install.log" 2>/dev/null || true
		failed=1
		rm -rf "${pkg_work}"
		echo "::endgroup::"
		return
	fi

	# Config is passed as an ABSOLUTE path — audit-ci runs from the temp dir, not the repo root.
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

# --- Source-code scopes ---------------------------------------------------------
# 1) Locked tree, as committed.
npm ci --ignore-scripts
audit_scope "locked · ci (dev + prod)" locked

# Re-resolve every range to its latest satisfying version.
rm -rf node_modules package-lock.json
npm install --no-audit --no-fund --ignore-scripts

# 2) Latest, full tree. 3) Latest, production only (same install, narrower scope).
audit_scope "latest (dev + prod)" devprod
audit_scope "latest (prod only)" prod --skip-dev

# --- Released-artifact scopes ---------------------------------------------------
# Latest published versions consumers actually install. CLI v5 ships under the "next" dist-tag
# while it is pre-release; adjust the specs here as release lines change.
audit_released "CLI v4 (released)" released-cli-v4 "@ui5/cli@^4.0.0"
audit_released "CLI v5 (released)" released-cli-v5 "@ui5/cli@next"
audit_released "Linter (released)" released-linter "@ui5/linter@latest"
audit_released "MCP (released)"    released-mcp    "@ui5/mcp-server@latest"

# --- Comparison summary ---------------------------------------------------------
# Advisory ids the repo config allowlists, so the tables match audit-ci's effective verdict.
allowlist="${work}/allowlist.txt"
: > "${allowlist}"
if [ -n "${config_file}" ]; then
	# shellcheck disable=SC2016 # this is a Node.js program, not shell — no expansion wanted
	node -e '
		const fs = require("fs");
		const text = fs.readFileSync(process.argv[1], "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")      // strip block comments
			.replace(/(^|[^:])\/\/.*$/gm, "$1");   // strip line comments (keep http://)
		const cfg = JSON.parse(text);
		for (const entry of (cfg.allowlist || [])) {
			console.log(String(entry).split("|")[0]); // advisory id, before any "|path"
		}
	' "${config_file}" > "${allowlist}" 2>/dev/null || true
fi

# extract <snapshot>: "ghsa <tab> package <tab> severity <tab> url", allowlisted ids removed.
extract() {
	jq -r --rawfile allow "${allowlist}" '
		($allow | split("\n") | map(select(length > 0))) as $al
		| [ (.advisories // {}) | to_entries[] | .value.via[]?
		    | select(type == "object")
		    | {g: ((.url // ("src-" + (.source|tostring))) | sub(".*/"; "")),
		       p: .name, s: .severity, u: (.url // "")} ]
		| map(select(.g as $g | ($al | index($g)) == null))
		| unique_by(.g)[] | [.g, .p, .s, .u] | @tsv
	' "${work}/$1.json" 2>/dev/null || true
}

# Source-code table: three scopes (prod · latest / locked · ci / dev + prod · latest).
extract prod    > "${work}/prod.tsv"
extract locked  > "${work}/locked.tsv"
extract devprod > "${work}/devprod.tsv"

# Join per advisory, mark presence per scope, sort ships-first then by severity.
rows="$(
	{
		awk -F'\t' '{print $1"\t1\t"$2"\t"$3"\t"$4}' "${work}/prod.tsv"
		awk -F'\t' '{print $1"\t2\t"$2"\t"$3"\t"$4}' "${work}/locked.tsv"
		awk -F'\t' '{print $1"\t3\t"$2"\t"$3"\t"$4}' "${work}/devprod.tsv"
	} | awk -F'\t' '
		{ g=$1; col=$2; pkg[g]=$3; sev[g]=$4; url[g]=$5; seen[g]=1; have[g SUBSEP col]=1 }
		END {
			rank["critical"]=0; rank["high"]=1; rank["moderate"]=2; rank["low"]=3; rank["info"]=4
			for (g in seen) {
				p=(have[g SUBSEP 1]?"✓":"–"); l=(have[g SUBSEP 2]?"✓":"–"); d=(have[g SUBSEP 3]?"✓":"–")
				adv=(url[g]!=""?"["g"]("url[g]")":g)
				sr=(sev[g] in rank)?rank[sev[g]]:4
				ships=(have[g SUBSEP 1]?0:1)
				printf "%d%d\t| %s | `%s` | %s | %s | %s | %s |\n", ships, sr, adv, pkg[g], sev[g], p, l, d
			}
		}' | sort | cut -f2-
)"

# Released-artifact table: one presence column per published package.
extract released-cli-v4 > "${work}/released-cli-v4.tsv"
extract released-cli-v5 > "${work}/released-cli-v5.tsv"
extract released-linter > "${work}/released-linter.tsv"
extract released-mcp    > "${work}/released-mcp.tsv"

released_rows="$(
	{
		awk -F'\t' '{print $1"\t1\t"$2"\t"$3"\t"$4}' "${work}/released-cli-v4.tsv"
		awk -F'\t' '{print $1"\t2\t"$2"\t"$3"\t"$4}' "${work}/released-cli-v5.tsv"
		awk -F'\t' '{print $1"\t3\t"$2"\t"$3"\t"$4}' "${work}/released-linter.tsv"
		awk -F'\t' '{print $1"\t4\t"$2"\t"$3"\t"$4}' "${work}/released-mcp.tsv"
	} | awk -F'\t' '
		{ g=$1; col=$2; pkg[g]=$3; sev[g]=$4; url[g]=$5; seen[g]=1; have[g SUBSEP col]=1 }
		END {
			rank["critical"]=0; rank["high"]=1; rank["moderate"]=2; rank["low"]=3; rank["info"]=4
			for (g in seen) {
				v4=(have[g SUBSEP 1]?"✓":"–"); v5=(have[g SUBSEP 2]?"✓":"–")
				lint=(have[g SUBSEP 3]?"✓":"–"); mcp=(have[g SUBSEP 4]?"✓":"–")
				adv=(url[g]!=""?"["g"]("url[g]")":g)
				sr=(sev[g] in rank)?rank[sev[g]]:4
				printf "%d\t| %s | `%s` | %s | %s | %s | %s | %s |\n", sr, adv, pkg[g], sev[g], v4, v5, lint, mcp
			}
		}' | sort | cut -f2-
)"

{
	echo "## Security audit comparison — source code"
	echo
	echo "| Advisory | Package | Severity | prod · latest (ships) | locked · ci | dev + prod · latest |"
	echo "|---|---|---|:--:|:--:|:--:|"
	if [ -n "${rows}" ]; then echo "${rows}"; else echo "| _none_ | | | | | |"; fi
	echo
	echo "**How to read:** \`✓\` under **prod · latest** reaches a fresh install today — fix first." \
		"A row \`✓\` only under **locked · ci** clears by refreshing the lockfile." \
		"Advisories allowlisted in this repo's audit-ci config are excluded."
	echo
	echo "## Security audit comparison — released artifacts"
	echo
	echo "| Advisory | Package | Severity | CLI v4 | CLI v5 | Linter | MCP |"
	echo "|---|---|---|:--:|:--:|:--:|:--:|"
	if [ -n "${released_rows}" ]; then echo "${released_rows}"; else echo "| _none_ | | | | | | |"; fi
	echo
	echo "**How to read:** \`✓\` under a package means a consumer installing that package today" \
		"is exposed to the advisory, even if it is already fixed in source. Allowlisted advisories" \
		"are excluded."
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"

exit "${failed}"
