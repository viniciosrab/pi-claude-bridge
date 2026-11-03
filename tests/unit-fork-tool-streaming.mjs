/**
 * Fork-only: ask Claude Code for eager tool input streaming (src/fork-tool-streaming.ts).
 * Without it the API holds back each tool argument until it is complete, so pi shows a
 * bare `$` row and then the whole command at once.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { TOOL_STREAMING_ENV, applyToolStreamingEnv } from "../src/fork-tool-streaming.js";

const NAME = "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING";

describe("applyToolStreamingEnv", () => {
	it("names Claude Code's eager tool input streaming switch", () => {
		assert.equal(TOOL_STREAMING_ENV, NAME);
	});

	it("turns eager tool input streaming on when the user has not set it", () => {
		const env = { HOME: "/home/u" };
		applyToolStreamingEnv(env);
		assert.deepEqual(env, { HOME: "/home/u", [NAME]: "1" });
	});

	it("keeps a value the user set, so exporting 0 turns it off", () => {
		for (const value of ["0", "false", "1"]) {
			const env = { [NAME]: value };
			applyToolStreamingEnv(env);
			assert.deepEqual(env, { [NAME]: value });
		}
	});

	// Every Claude Code child gets `{ ...process.env, ...CC_CHILD_ENV }`, so loading the
	// provider has to leave the switch on pi's own environment. A fresh process, since
	// this one may already carry the user's value.
	function envAfterProviderLoads(value) {
		const env = { ...process.env };
		if (value === undefined) delete env[NAME];
		else env[NAME] = value;
		const script = `await import("./src/index.ts"); process.stdout.write(JSON.stringify(process.env["${NAME}"] ?? null));`;
		const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env, encoding: "utf8" });
		return JSON.parse(out.trim().split("\n").at(-1));
	}

	it("is on in pi's environment once the provider loads", () => {
		assert.equal(envAfterProviderLoads(undefined), "1");
	});

	it("leaves the user's value in pi's environment once the provider loads", () => {
		assert.equal(envAfterProviderLoads("0"), "0");
	});
});
