#!/usr/bin/env node
// Does a system prompt trip Anthropic's third-party gate on the bridge's route?
//
// Anthropic bills some system prompts to Extra Usage even with plan limits left,
// or refuses them with "You're out of extra usage" when Extra Usage is off
// (diag/EXTRA-USAGE-400.md). Each arm is one Agent SDK query shaped like a bridge
// turn (src/index.ts provider path: no tools, user settings, auto memory off). A
// file arm sends the prompt as the `claude_code` preset's append (the bridge's
// default); a `plain:` arm sends it as a plain string (systemPromptPreset: false). Default Haiku 5.5 (--model to change), "Reply with just: OK".
//
//   node --import tsx diag/probe-third-party-gate.mjs [--model <id>] control diag/third-party-gate/pi-1.5.1.txt ...
//   node --import tsx diag/probe-third-party-gate.mjs --render <pi-bin> <out.txt>
//   node --import tsx diag/probe-third-party-gate.mjs --render-mine <pi-bin> <project-dir> <out.txt>
//
// An arm is `control` (no append), a prompt file (sent as the preset's append),
// or `plain:<file>` (sent as a plain string, no preset). Interleave arms and repeat
// them; results append to .test-output/third-party-gate/results.jsonl.
// --render writes the default system prompt a pi binary renders in an empty
// project with an empty agent dir (no context files or skills), with install
// and project paths normalized so only pi's wording differs between versions.
// --render-mine writes the whole prompt your own pi renders in <project-dir>, with
// your agent dir and extensions loaded (what forwarding the whole system prompt,
// upstream #262, would send), read at agent_start like the bridge's capture.
// Keep that file out of git: it carries your context files and extension prompts.
//
// Reading a row: billed to Extra Usage shows as `overageInUse: true` with
// `isUsingOverage: false` (CC sets the latter only for a rejected plan window),
// `rateLimitType: "overage"` and no `unifiedWindows`. With Extra Usage off the
// same prompt fails 400 with no rate_limit_event.
//
// Costs: a gated request with Extra Usage on is real money (about $0.015 for the
// first, cache reads after). Run it with a small Extra Usage cap.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { __test } from "../src/index.ts";

// Same as src/index.ts CLAUDE_MD_EXCLUDES: pi owns context files on the provider path.
const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];
const { ccChildEnv } = __test;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTDIR = join(ROOT, ".test-output", "third-party-gate");
const args = process.argv.slice(2);
const mi = args.indexOf("--model");
const MODEL = mi === -1 ? "claude-haiku-5-5" : args[mi + 1];
if (mi !== -1) args.splice(mi, 2);

if (args[0] === "--render-mine") {
	const [, piBin, projectArg, outArg] = args;
	const out = resolve(outArg);
	const scratch = mkdtempSync(join(tmpdir(), "gate-render-"));
	const dump = join(scratch, "dump.ts");
	// agent_start sees the prompt after every extension's before_agent_start, the one
	// the provider queries with. Exits there, before any provider request.
	writeFileSync(dump, `import { writeFileSync } from "node:fs";
export default function (pi: any) {
	pi.on("agent_start", (_event: any, ctx: any) => {
		try { writeFileSync(${JSON.stringify(out)}, ctx.getSystemPrompt()); process.exit(0); }
		catch (error) { console.error(error); process.exit(1); }
	});
}
`);
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ANTHROPIC_")));
	execFileSync(piBin, ["--no-session", "-e", dump, "--model", "anthropic/claude-haiku-5-5", "-p", "hi"], {
		cwd: resolve(projectArg), stdio: "inherit",
		env: { ...env, PI_OFFLINE: "1", ANTHROPIC_API_KEY: "sk-ant-dummy" },
	});
	console.log(`wrote ${out} (${readFileSync(out, "utf8").length} chars)`);
	process.exit(0);
}

if (args[0] === "--render") {
	const [, piBin, outArg] = args;
	const out = resolve(outArg);
	const scratch = mkdtempSync(join(tmpdir(), "gate-render-"));
	mkdirSync(join(scratch, "project"));
	const project = realpathSync(join(scratch, "project"));
	const dump = join(scratch, "dump.ts");
	// Exits in before_agent_start whatever happens: pi reports a handler's throw and
	// carries on to the provider request.
	writeFileSync(dump, `import { writeFileSync } from "node:fs";
export default function (pi: any) {
	pi.on("before_agent_start", (event: any) => {
		try { writeFileSync(${JSON.stringify(out)}, event.systemPrompt); process.exit(0); }
		catch (error) { console.error(error); process.exit(1); }
	});
}
`);
	// The dummy key only gets pi to before_agent_start. No other Anthropic credential
	// reaches it: the agent dir is empty and the ANTHROPIC_* env is dropped.
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("ANTHROPIC_")));
	execFileSync(piBin, ["--no-session", "-ne", "-e", dump, "--model", "anthropic/claude-haiku-5-5", "-p", "hi"], {
		cwd: project, stdio: "inherit",
		env: { ...env, PI_CODING_AGENT_DIR: join(scratch, "agent"), PI_OFFLINE: "1", ANTHROPIC_API_KEY: "sk-ant-dummy" },
	});
	const rendered = readFileSync(out, "utf8")
		.replace(/\/\S*?\/node_modules\/@earendil-works\/pi-coding-agent/g, "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent")
		.replaceAll(project, "/tmp/project");
	writeFileSync(out, rendered);
	console.log(`wrote ${out} (${rendered.length} chars)`);
	process.exit(0);
}

const env = ccChildEnv();
// Subscription login only: an API key or gateway would bill elsewhere. A parent
// SDK's attribution would mislabel the request; the SDK stamps its own when unset.
for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_ENTRYPOINT"]) delete env[name];
const cwd = mkdtempSync(join(tmpdir(), "gate-probe-"));
mkdirSync(OUTDIR, { recursive: true });

for (const arm of args) {
	const plain = arm.startsWith("plain:");
	const file = plain ? arm.slice(6) : arm;
	if (plain && file === "control") throw new Error("plain:control is not an arm; use control");
	const text = file === "control" ? undefined : readFileSync(file, "utf8");
	const record = { arm: file === "control" ? "control" : (plain ? "plain:" : "") + basename(file), model: MODEL, at: new Date().toISOString(), rateLimits: [] };
	try {
		for await (const m of query({
			prompt: "Reply with just: OK",
			options: {
				cwd, env,
				tools: [],
				permissionMode: "bypassPermissions",
				settingSources: ["user"],
				settings: { claudeMdExcludes: CLAUDE_MD_EXCLUDES, includeGitInstructions: false, outputStyle: "default", autoMemoryEnabled: false },
				systemPrompt: plain ? text : { type: "preset", preset: "claude_code", append: text },
				model: MODEL,
				strictMcpConfig: true,
				persistSession: false,
				maxTurns: 1,
			},
		})) {
			if (m.type === "system" && m.subtype === "init") Object.assign(record, { apiKeySource: m.apiKeySource, ccVersion: m.claude_code_version });
			else if (m.type === "rate_limit_event") record.rateLimits.push(m.rate_limit_info);
			else if (m.type === "result") Object.assign(record, {
				isError: m.is_error, apiErrorStatus: m.api_error_status, result: String(m.result ?? "").slice(0, 300),
				usage: m.usage, sdkCostUsd: m.total_cost_usd,
			});
		}
	} catch (error) {
		// The SDK throws after an error result; the result is already recorded.
		record.thrown = String(error?.message ?? error).slice(0, 300);
	}
	appendFileSync(join(OUTDIR, "results.jsonl"), JSON.stringify(record) + "\n");
	const rl = record.rateLimits.map((r) => `${r.rateLimitType}:${r.status} overageInUse=${r.overageInUse ?? false} isUsingOverage=${r.isUsingOverage}${r.overageDisabledReason ? ` (${r.overageDisabledReason})` : ""}`).join("; ") || "no rate_limit_event";
	// "ok" only for a successful result: a CLI that never started or an SDK throw before
	// any result is a failed probe, not a prompt the gate let through.
	const outcome = record.isError === false ? "ok"
		: record.isError ? `ERROR ${record.apiErrorStatus ?? ""} ${record.result}`
		: `FAILED (no result) ${record.thrown ?? ""}`;
	console.log(`${record.arm.padEnd(14)} ${outcome} | ${rl} | sdk $${record.sdkCostUsd ?? 0}`);
}
