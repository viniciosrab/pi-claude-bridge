#!/usr/bin/env node
// The bridge no longer refuses a prompt carrying pi's harness or the docs-path pair.
// Upstream measured both pi 1.5.1's and 1.5.2's full system prompt served on the plan
// (elidickinson/pi-claude-bridge diag/third-party-gate/, diag/EXTRA-USAGE-400.md): the
// gate reacted to pi 1.4's wording, which pi >= 1.5.1 no longer renders, and the pair
// `docs/custom-provider.md` + `docs/packages.md` passes on its own. The bridge forwards
// pi's whole prompt, so each of these reaches Claude Code unchanged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { __test } from "../src/index.js";

const PI_1_5_PREAMBLE = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
const PI_1_4_PREAMBLE = "You are an expert coding assistant operating inside pi, a coding agent harness.";
const TRIGGER_PAIR = "see docs/custom-provider.md and docs/packages.md";

const { buildSystemPrompt, buildSystemPromptState } =
	await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url).href);

/** The system prompt the provider forwards for pi's prompt built from `opts`. */
function forwarded(opts) {
	const head = { role: "system", ...buildSystemPromptState({ cwd: "/w", ...opts }), timestamp: 0 };
	return __test.toBridgeContext({ messages: [head, { role: "user", content: "hi", timestamp: 0 }] }).systemPrompt;
}
function project({ custom, contextFiles, sections }) {
	return forwarded({ customPrompt: custom, contextFiles, sections });
}

describe("pi's harness text is forwarded, not refused", () => {
	it("sends a custom prompt opening with pi 1.5's preamble", () => {
		const custom = `${PI_1_5_PREAMBLE}\n\n<tools>\n- read: Read a file\n</tools>`;
		assert.ok(project({ custom }).startsWith(custom));
	});

	it("sends pi 1.5's preamble at the start of a later line", () => {
		const custom = `child wrapper\n${PI_1_5_PREAMBLE}`;
		assert.ok(project({ custom }).startsWith(custom));
	});

	it("sends pi 1.4's preamble too", () => {
		const custom = `${PI_1_4_PREAMBLE}\n\nchild instructions`;
		assert.ok(project({ custom }).startsWith(custom));
	});

	it("sends the docs-path pair in a context file and in a section", () => {
		const fromContext = project({ contextFiles: [{ path: "/AGENTS.md", content: TRIGGER_PAIR }] });
		assert.ok(fromContext?.includes(TRIGGER_PAIR), fromContext);
		const fromSection = project({ sections: { triggers: TRIGGER_PAIR } });
		assert.ok(fromSection.includes(`<triggers>\n${TRIGGER_PAIR}\n</triggers>`), fromSection);
	});

	it("sends pi's own prompt, docs-path pair included, unchanged", () => {
		const prompt = forwarded({});
		assert.equal(prompt, buildSystemPrompt({ cwd: "/w" }));
		assert.ok(prompt.includes("docs/custom-provider.md") && prompt.includes("docs/packages.md"));
	});
});
