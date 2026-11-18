// Replay-order contract for toBridgeContext (issue #106).
//
// The transcript replays section patches in Map order: a deleted-then-re-added section
// (skills vanishes while `read` and `bash` are both disabled, then returns) or a late
// custom section such as `mcp_servers` lands at the tail. The bridge forwards pi-ai's own
// join of that state (getSystemMessageText), in replay order, with no re-ranking: it is
// the prompt pi itself would send another provider.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { __test } from "../src/index.js";

const { toBridgeContext } = __test;

function systemMessage(overrides) {
	return { role: "system", content: "", timestamp: 0, ...overrides };
}

function userMessage(text) {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

/** A transcript from pi: a content-only head carrying the initial tool set, then
 *  full-section and diff patches. `skills` is deleted then re-added, as when `read` and
 *  `bash` are disabled for a turn and later re-enabled. */
const SKILLS_REORDERED = [
	systemMessage({ content: "", toolsAdded: [{ name: "read", description: "", parameters: {} }] }),
	systemMessage({
		sections: { preamble: "P", tools: "T", rules: "R", docs: "D", cwd: "/w" },
	}),
	systemMessage({ sections: { skills: null } }),
	systemMessage({ sections: { skills: "S", cwd: "/w" } }),
	userMessage("go"),
];

/** A section pi does not know today (say a future `environment`) present from the first
 *  patch, before `cwd`. */
const UNKNOWN_SECTION_CANONICAL = [
	systemMessage({ content: "", toolsAdded: [{ name: "read", description: "", parameters: {} }] }),
	systemMessage({
		sections: { preamble: "P", tools: "T", rules: "R", docs: "D", environment: "E", cwd: "/w" },
	}),
	userMessage("go"),
];

/** The issue #153 shape: the built-ins (including `cwd`) are in the replay Map from the
 *  first patch, and a later patch introduces `mcp_servers` — the section pi's MCP extension
 *  adds once its servers connect — alongside an `addendum` that the first render did not
 *  have. */
const MCP_SECTION_LATE = [
	systemMessage({ content: "", toolsAdded: [{ name: "read", description: "", parameters: {} }] }),
	systemMessage({
		sections: {
			preamble: "P", tools: "T", rules: "R", docs: "D",
			project_context: "C", skills: "S", cwd: "/w",
		},
	}),
	systemMessage({ sections: { addendum: "A", mcp_servers: "M" } }),
	userMessage("go"),
];

function replayedSystemPrompt(messages) {
	const context = toBridgeContext({ messages, tools: undefined, systemPrompt: undefined });
	return context.systemPrompt;
}

describe("toBridgeContext section replay order", () => {
	it("keeps a deleted-then-re-added section where the replay puts it", () => {
		// Map replay order after the skills re-add: preamble, tools, rules, docs, cwd, skills.
		assert.equal(replayedSystemPrompt(SKILLS_REORDERED), ["P", "T", "R", "D", "/w", "S"].join("\n\n"));
	});

	it("keeps a section pi does not know about where the patch put it", () => {
		assert.equal(replayedSystemPrompt(UNKNOWN_SECTION_CANONICAL), ["P", "T", "R", "D", "E", "/w"].join("\n\n"));
	});

	it("appends late-introduced sections in replay order", () => {
		assert.equal(
			replayedSystemPrompt(MCP_SECTION_LATE),
			["P", "T", "R", "D", "C", "S", "/w", "A", "M"].join("\n\n"),
		);
	});

	it("keeps a custom section appended after the built-ins", () => {
		const messages = [
			systemMessage({ content: "", toolsAdded: [{ name: "read", description: "", parameters: {} }] }),
			systemMessage({ sections: { preamble: "P", tools: "T", cwd: "/w", myextension: "X" } }),
			userMessage("go"),
		];
		assert.equal(replayedSystemPrompt(messages), ["P", "T", "/w", "X"].join("\n\n"));
	});

	it("renders the canonical head alone unchanged (fresh-session shape)", () => {
		const messages = [
			systemMessage({
				sections: { preamble: "P", tools: "T", rules: "R", docs: "D", skills: "S", cwd: "/w" },
			}),
			userMessage("go"),
		];
		assert.equal(replayedSystemPrompt(messages), ["P", "T", "R", "D", "S", "/w"].join("\n\n"));
	});

	it("joins text-array content like string content", () => {
		const messages = [
			systemMessage({ content: [{ type: "text", text: "A" }, { type: "text", text: "B" }] }),
			systemMessage({ sections: { cwd: "/w" } }),
			userMessage("go"),
		];
		assert.equal(replayedSystemPrompt(messages), ["A\nB", "/w"].join("\n\n"));
	});

	it("reconstructs the tool set through removals and re-adds", () => {
		const grepTool = { name: "grep", description: "", parameters: {} };
		const readTool = { name: "read", description: "", parameters: {} };
		const context = toBridgeContext({
			messages: [
				systemMessage({ toolsAdded: [readTool, grepTool] }),
				systemMessage({ toolsRemoved: [{ name: "read" }] }),
				systemMessage({ toolsAdded: [readTool] }),
				userMessage("go"),
			],
			tools: undefined,
			systemPrompt: undefined,
		});
		assert.deepEqual(context.tools, [grepTool, readTool]);
	});

	it("returns a context without system messages unchanged (systemless call shape)", () => {
		const context = { messages: [userMessage("go")], systemPrompt: "P", tools: [] };
		assert.equal(toBridgeContext(context), context, "same object reference — a true no-op");
	});
});
