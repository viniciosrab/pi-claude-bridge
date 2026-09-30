/**
 * Every Claude Code subprocess the bridge spawns has to be told to keep its hands
 * off state pi owns. These are silent when missing: CC compacts or writes memory
 * on its own, nothing throws, and the damage shows up in the user's ~/.claude
 * rather than in a test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

describe("Claude Code child environment", () => {
	it("disables auto-compaction and claude.ai MCP servers and lifts the MCP description cap", () => {
		assert.deepEqual(__test.CC_CHILD_ENV, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
			CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "1000000",
		});
	});

	// CC truncates each MCP tool description to 2,048 chars by default. Pi's codemode
	// description lists its MCP servers past char ~6.9k, so a user-set lower limit
	// must not survive into the child: the bridge value wins over process.env.
	it("overrides a user-set MCP description limit", () => {
		const env = { CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "2048", ...__test.CC_CHILD_ENV };
		assert.equal(env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, "1000000");
	});

	// Deliberately not asserted here: that every `query()` call site spreads the
	// constant. The only way to check that from a unit test is to grep src/index.ts,
	// which fails on innocent indirection (`env: childEnv`) and would have to be
	// taught about it — a brittle test that reads as coverage. The three sites
	// referencing CC_CHILD_ENV are the guard, and a fourth is a review question.
});
