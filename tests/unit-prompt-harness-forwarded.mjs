#!/usr/bin/env node
// The bridge no longer refuses a prompt carrying pi's harness or the docs-path pair.
// Upstream measured both pi 1.5.1's and 1.5.2's full system prompt served on the plan
// (elidickinson/pi-claude-bridge diag/third-party-gate/, diag/EXTRA-USAGE-400.md): the
// gate reacted to pi 1.4's wording, which pi >= 1.5.1 no longer renders, and the pair
// `docs/custom-provider.md` + `docs/packages.md` passes on its own.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectPromptCapture, PromptCaptures } from "../src/prompt-capture.js";

const PI_1_5_PREAMBLE = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
const PI_1_4_PREAMBLE = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const TRIGGER_PAIR = "see docs/custom-provider.md and docs/packages.md";

function project(fields) {
	const captures = new PromptCaptures();
	captures.record("prompt", { contextFiles: [], skills: [], ...fields }, "before_agent_start");
	const found = captures.resolve("prompt");
	assert.ok(found);
	return projectPromptCapture(found, { skillReadTool: "none" });
}

describe("pi's harness text is forwarded, not refused", () => {
	it("sends a custom prompt opening with pi 1.5's preamble", () => {
		const custom = `${PI_1_5_PREAMBLE}\n\n<tools>\n- read: Read a file\n</tools>`;
		assert.equal(project({ custom }), custom);
	});

	it("sends pi 1.5's preamble at the start of a later line", () => {
		const custom = `child wrapper\n${PI_1_5_PREAMBLE}`;
		assert.equal(project({ custom }), custom);
	});

	it("sends pi 1.4's preamble too", () => {
		const custom = `${PI_1_4_PREAMBLE}\n\nchild instructions`;
		assert.equal(project({ custom }), custom);
	});

	it("sends the docs-path pair in a context file and in a section", () => {
		const fromContext = project({ contextFiles: [{ path: "/AGENTS.md", content: TRIGGER_PAIR }] });
		assert.ok(fromContext?.includes(TRIGGER_PAIR), fromContext);
		assert.equal(project({ sections: { triggers: TRIGGER_PAIR } }), `<triggers>\n${TRIGGER_PAIR}\n</triggers>`);
	});
});
