#!/usr/bin/env node
// fork: pi 1.5 preamble guard (src/fork-prompt-guard.ts). Pi 1.5.0 reworded the line
// that opens its system prompt, so upstream's PI_PREAMBLE no longer finds pi's harness
// in a prompt about to reach Claude Code. The fork's guard refuses the new wording.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PI_PREAMBLE, projectPromptCapture, PromptCaptures } from "../src/prompt-capture.js";
import { PI_PREAMBLES_SINCE_1_5 } from "../src/fork-prompt-guard.js";

const PI_SYSTEM_PROMPT = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url));
const PI_1_5_PREAMBLE = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";

function project(custom, source = "before_agent_start") {
	const captures = new PromptCaptures();
	captures.record("prompt", { contextFiles: [], skills: [], custom }, source);
	const found = captures.resolve("prompt");
	assert.ok(found);
	return () => projectPromptCapture(found, { skillReadTool: "none" });
}

describe("fork prompt guard", () => {
	it("refuses a custom prompt opening with pi 1.5's preamble", () => {
		assert.throws(project(`${PI_1_5_PREAMBLE}\n\n<tools>\n- read: Read a file\n</tools>`), (error) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /^prompt-capture: refusing to send this prompt/);
			assert.ok(error.message.includes("You are a coding assistant running inside pi"), error.message);
			assert.match(error.message, /in the custom prompt, at offset 0 of \d+ chars/);
			assert.match(error.message, /Capture: before_agent_start, 0 inherited capture\(s\) substituted/);
			return true;
		});
	});

	it("refuses pi 1.5's preamble at the start of a later line", () => {
		assert.throws(project(`child wrapper\n${PI_1_5_PREAMBLE}`), /at offset 14 of \d+ chars/);
	});

	it("sends a mid-line mention of pi 1.5's preamble", () => {
		const custom = `note: ${PI_1_5_PREAMBLE}`;
		assert.equal(project(custom)(), custom);
	});

	it("knows the preamble of the pi installed here", async () => {
		assert.ok(existsSync(PI_SYSTEM_PROMPT), `pi's system prompt module is not at ${PI_SYSTEM_PROMPT}`);
		const { buildSystemPrompt } = await import(PI_SYSTEM_PROMPT);
		const harness = buildSystemPrompt({ cwd: "/tmp" });
		assert.ok(
			[PI_PREAMBLE, ...PI_PREAMBLES_SINCE_1_5].some((preamble) => harness.startsWith(preamble)),
			`neither upstream's nor the fork's guard knows this pi's preamble: ${harness.split("\n")[0]}`,
		);
	});
});
