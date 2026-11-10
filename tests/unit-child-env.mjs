/**
 * Every Claude Code subprocess the bridge spawns has to be told to keep its hands
 * off state pi owns. These are silent when missing: CC compacts or writes memory
 * on its own, nothing throws, and the damage shows up in the user's ~/.claude
 * rather than in a test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test, default: activate } = await import("../src/index.js");

describe("Claude Code child environment", () => {
	it("disables auto-compaction, claude.ai MCP servers, request logging, non-essential traffic, interrupted-turn resume and the silent-turn reminder", () => {
		assert.deepEqual(__test.CC_CHILD_ENV, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
			CLAUDE_CODE_ELEGANT_MEADOW: "0",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "1",
			CLAUDE_CODE_SILENT_TURN_REMINDER: "0",
		});
	});

	it("passes pi's environment through and puts the guards last", () => {
		const env = __test.ccChildEnv({ ANTHROPIC_BASE_URL: "http://proxy", DISABLE_AUTO_COMPACT: "0", CLAUDE_CODE_ENTRYPOINT: "cli" });
		assert.equal(env.ANTHROPIC_BASE_URL, "http://proxy");
		assert.equal(env.DISABLE_AUTO_COMPACT, "1");
		// Not started from inside Claude Code: nothing is dropped.
		assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "cli");
	});

	it("drops the parent Claude Code session's markers when pi runs inside Claude Code", () => {
		const markers = [
			"CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
			"CLAUDE_PID", "CLAUDE_EFFORT", "TRACEPARENT", "CLAUDE_CODE_INVOKED_SKILLS", "CLAUDE_ENV_FILE",
			"CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_EXECPATH",
			"CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
		];
		const parent = {
			...Object.fromEntries(markers.map((name) => [name, "parent"])),
			CLAUDE_CONFIG_DIR: "/cfg", ANTHROPIC_API_KEY: "k", AI_AGENT: "pi",
		};
		const env = __test.ccChildEnv(parent);
		for (const name of markers) assert.ok(!(name in env), `${name} reached the child`);
		assert.equal(env.CLAUDE_CONFIG_DIR, "/cfg");
		assert.equal(env.ANTHROPIC_API_KEY, "k");
		assert.equal(env.AI_AGENT, "pi");
		// The caller's object is not modified.
		assert.equal(parent.CLAUDECODE, "parent");
	});

	it("does not set the non-essential-traffic flag on pi's own process", () => {
		const saved = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		try {
			activate({ on: () => {}, registerProvider: () => {}, registerTool: () => {} });
			assert.equal(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
		} finally {
			if (saved !== undefined) process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = saved;
		}
	});

	// Deliberately not asserted here: that every `query()` call site spreads the
	// constant. The only way to check that from a unit test is to grep src/index.ts,
	// which fails on innocent indirection (`env: childEnv`) and would have to be
	// taught about it — a brittle test that reads as coverage. The three sites
	// calling ccChildEnv() are the guard, and a fourth is a review question.
});
