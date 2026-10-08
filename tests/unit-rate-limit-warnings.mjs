/**
 * provider.rateLimitWarnings wiring: the rate-limit notices consumeQuery shows in
 * pi (a warning per 5% step of allowed_warning, and "rate limited" on rejected)
 * appear by default and not at all with `rateLimitWarnings: false`, while a
 * rejected event still names the failure it caused as a rate limit.
 * unit-config.mjs pins the helper; this pins the wiring. Config is loaded the way
 * pi activates the extension, and consumeQuery is driven with a fake SDK stream —
 * no Claude Code subprocess runs.
 */
import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { QueryContext } from "../src/query-state.js";

// Before importing the module: point HOME (and so the global config dir) and CC
// state at throwaway dirs so no real ~/.pi or ~/.claude state is read or written.
const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-rate-limit-cc-"));
const home = mkdtempSync(join(tmpdir(), "claude-bridge-rate-limit-home-"));
const oldHome = process.env.HOME;
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.HOME = home;
// pi resolves the agent dir from PI_CODING_AGENT_DIR before HOME, and the unit-suite
// preload sets it; drop it so the agent dir follows the temp HOME.
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
delete process.env.PI_CODING_AGENT_DIR;
const agentDir = getAgentDir();
// An agent-dir env override would redirect writes to a real config dir.
assert.ok(agentDir.startsWith(home), `agent dir escaped the temp HOME: ${agentDir}`);
mkdirSync(agentDir, { recursive: true });
process.on("exit", () => {
	rmSync(claudeDir, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

const mod = await import("../src/index.js");
const { consumeQuery, setPiUI } = mod.__test;

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };

// Load the given global config the way pi activates the extension.
function loadGlobalConfig(config) {
	writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify(config));
	mod.default({ on: () => {}, registerProvider: () => {}, registerTool: () => {} });
}

// Run the messages through consumeQuery with the given config; return the notices
// pi was shown and the turn's error message.
async function consume(config, messages) {
	loadGlobalConfig(config);
	const notices = [];
	setPiUI({ notify: (message, type) => notices.push({ message, type }) });
	const c = new QueryContext();
	c.currentPiStream = { push: () => {}, end: () => {} };
	c.resetTurnState(fakeModel);
	async function* gen() { for (const m of messages) yield m; }
	await consumeQuery(gen(), new Map(), fakeModel, () => false, c);
	return { notices, errorMessage: c.turnOutput.errorMessage };
}

const warning = {
	type: "rate_limit_event",
	rate_limit_info: { status: "allowed_warning", utilization: 0.8, surpassedThreshold: 0.75, rateLimitType: "five_hour" },
};
const rejection = {
	type: "rate_limit_event",
	rate_limit_info: { status: "rejected", resetsAt: 1786141800, rateLimitType: "five_hour" },
};
const limitResult = {
	type: "result", subtype: "success", is_error: true,
	result: "You're out of extra usage · resets 6:30pm (America/New_York)",
};

after(() => {
	if (oldHome === undefined) delete process.env.HOME;
	else process.env.HOME = oldHome;
	if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
});
afterEach(() => setPiUI(null));

describe("rate-limit notices", () => {
	it("are shown by default", async () => {
		const { notices } = await consume({ provider: {} }, [warning, rejection, limitResult]);
		assert.deepEqual(notices.map((n) => n.type), ["warning", "warning"]);
		assert.match(notices[0].message, /^Claude rate limit warning: 80% used \(five_hour\)/);
		assert.match(notices[1].message, /^Claude rate limited \(five_hour\)/);
	});

	it("are shown when rateLimitWarnings is true", async () => {
		const { notices } = await consume({ provider: { rateLimitWarnings: true } }, [warning, rejection, limitResult]);
		assert.equal(notices.length, 2);
	});

	it("are not shown when rateLimitWarnings is false", async () => {
		const { notices } = await consume({ provider: { rateLimitWarnings: false } }, [warning, rejection, limitResult]);
		assert.deepEqual(notices, []);
	});

	it("still name a rejected failure as a rate limit when rateLimitWarnings is false", async () => {
		const { errorMessage } = await consume({ provider: { rateLimitWarnings: false } }, [rejection, limitResult]);
		assert.match(errorMessage, /^Claude rate limit \(five_hour\)/);
		assert.ok(errorMessage.includes(limitResult.result), "keeps Claude Code's own wording");
	});
});
