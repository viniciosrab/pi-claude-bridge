/**
 * An earlier version stored prompt captures in claude-bridge-captures/ in pi's agent
 * dir (issue #37). The bridge forwards pi's whole prompt now and reads none, so
 * activation removes the directory, best effort: a failure never stops the extension.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: activate } = await import("../src/index.js");
const { removeObsoleteCaptureStore } = await import("../src/fork.js");

function withAgentDir(fn) {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-captures-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return fn(agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

const pi = () => ({ on: () => {}, registerProvider: () => {}, registerTool: () => {} });

describe("the obsolete prompt-capture store", () => {
	it("is removed from pi's agent dir (PI_CODING_AGENT_DIR) at activation", () => withAgentDir((agentDir) => {
		const store = join(agentDir, "claude-bridge-captures");
		mkdirSync(store, { mode: 0o700 });
		writeFileSync(join(store, "session.json"), "{}", { mode: 0o600 });
		mkdirSync(join(agentDir, "claude-bridge-mirrors"));
		activate(pi());
		assert.equal(existsSync(store), false, "the captures dir is gone");
		assert.equal(existsSync(join(agentDir, "claude-bridge-mirrors")), true, "the mirrors stay");
	}));

	it("activation without the directory is fine", () => withAgentDir(() => {
		assert.doesNotThrow(() => activate(pi()));
	}));

	it("a removal that fails is ignored", () => withAgentDir((agentDir) => {
		let target;
		let left;
		assert.doesNotThrow(() => { left = removeObsoleteCaptureStore((path) => { target = path; throw Object.assign(new Error("EACCES"), { code: "EACCES" }); }); });
		assert.match(left, /could not remove .*claude-bridge-captures: EACCES/);
		assert.equal(target, join(agentDir, "claude-bridge-captures"));
	}));
});
