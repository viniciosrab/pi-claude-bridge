/**
 * The bridge keeps the state it writes in claude-bridge/ in pi's agent dir. Earlier
 * versions wrote it straight into the root; activation moves it, removes the session
 * store a removed module kept, and drops usage snapshots no process refreshed in 30 days.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: activate } = await import("../src/index.js");
const { migrateLegacyState, USAGE_MAX_AGE_MS } = await import("../src/state-dir.js");
const { sharedUsagePath } = await import("../src/shared-usage.js");
const { debugLogPath, diagLogPath } = await import("../src/log-paths.js");

function withAgentDir(fn, { debugPath } = {}) {
	const previous = { agent: process.env.PI_CODING_AGENT_DIR, debug: process.env.CLAUDE_BRIDGE_DEBUG_PATH };
	const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-state-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	if (debugPath) process.env.CLAUDE_BRIDGE_DEBUG_PATH = debugPath;
	else delete process.env.CLAUDE_BRIDGE_DEBUG_PATH;
	try {
		return fn(agentDir);
	} finally {
		for (const [key, value] of [["PI_CODING_AGENT_DIR", previous.agent], ["CLAUDE_BRIDGE_DEBUG_PATH", previous.debug]]) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(agentDir, { recursive: true, force: true });
	}
}

const state = (agentDir, ...parts) => join(agentDir, "claude-bridge", ...parts);
const read = (path) => readFileSync(path, "utf8");
const pi = () => ({ on: () => {}, registerProvider: () => {}, registerTool: () => {}, events: { emit: () => {}, on: () => {} } });

describe("the bridge's state dir", () => {
	it("is where the bridge writes usage, mirrors and logs", () => withAgentDir((agentDir) => {
		assert.equal(sharedUsagePath("abc"), state(agentDir, "usage", "abc.json"));
		assert.equal(debugLogPath(), state(agentDir, "logs", "bridge.log"));
		assert.equal(diagLogPath(), state(agentDir, "logs", "diag.log"));
	}));

	it("moves the root's usage snapshots, mirrors and logs into it, and leaves everything else", () => withAgentDir((agentDir) => {
		writeFileSync(join(agentDir, "claude-bridge-usage-aaa.json"), "usage-a");
		writeFileSync(join(agentDir, "claude-bridge-usage-bbb.json.123.tmp"), "half");
		const old = (Date.now() - 120_000) / 1000;
		utimesSync(join(agentDir, "claude-bridge-usage-bbb.json.123.tmp"), old, old);
		mkdirSync(join(agentDir, "claude-bridge-mirrors"));
		writeFileSync(join(agentDir, "claude-bridge-mirrors", "s1.json"), "mirror-1");
		writeFileSync(join(agentDir, "claude-bridge.log"), "debug");
		writeFileSync(join(agentDir, "claude-bridge-diag.log"), "diag");
		mkdirSync(join(agentDir, "cc-cli-logs"));
		writeFileSync(join(agentDir, "cc-cli-logs", "q.log"), "cli");
		writeFileSync(join(agentDir, "claude-bridge.json"), "{}");
		writeFileSync(join(agentDir, "settings.json"), "{}");

		assert.deepEqual(migrateLegacyState(), []);

		assert.deepEqual(readdirSync(agentDir).sort(), ["claude-bridge", "claude-bridge.json", "settings.json"]);
		assert.equal(read(state(agentDir, "usage", "aaa.json")), "usage-a");
		assert.deepEqual(readdirSync(state(agentDir, "usage")), ["aaa.json"], "a leftover temp file is dropped");
		assert.equal(read(state(agentDir, "mirrors", "s1.json")), "mirror-1");
		assert.equal(statSync(state(agentDir, "mirrors")).mode & 0o777, 0o700, "mirrors stay owner-only");
		assert.equal(read(state(agentDir, "logs", "bridge.log")), "debug");
		assert.equal(read(state(agentDir, "logs", "diag.log")), "diag");
		assert.equal(read(state(agentDir, "logs", "cc-cli-logs", "q.log")), "cli");
	}));

	it("keeps a file already in the state dir over the root's copy, and never deletes a log", () => withAgentDir((agentDir) => {
		mkdirSync(state(agentDir, "usage"), { recursive: true });
		mkdirSync(state(agentDir, "mirrors"), { recursive: true });
		mkdirSync(state(agentDir, "logs"), { recursive: true });
		writeFileSync(state(agentDir, "usage", "aaa.json"), "new-usage");
		writeFileSync(state(agentDir, "mirrors", "s1.json"), "new-mirror");
		writeFileSync(state(agentDir, "logs", "diag.log"), "new-diag");
		writeFileSync(join(agentDir, "claude-bridge-usage-aaa.json"), "old-usage");
		mkdirSync(join(agentDir, "claude-bridge-mirrors"));
		writeFileSync(join(agentDir, "claude-bridge-mirrors", "s1.json"), "old-mirror");
		writeFileSync(join(agentDir, "claude-bridge-diag.log"), "old-diag");

		assert.deepEqual(migrateLegacyState(), []);

		assert.equal(read(state(agentDir, "usage", "aaa.json")), "new-usage");
		assert.equal(existsSync(join(agentDir, "claude-bridge-usage-aaa.json")), false);
		assert.equal(read(state(agentDir, "mirrors", "s1.json")), "new-mirror");
		assert.equal(existsSync(join(agentDir, "claude-bridge-mirrors")), false);
		assert.equal(read(state(agentDir, "logs", "diag.log")), "new-diag");
		assert.equal(read(join(agentDir, "claude-bridge-diag.log")), "old-diag");
	}));

	it("leaves the debug log alone when CLAUDE_BRIDGE_DEBUG_PATH names it", () => {
		const debugDir = mkdtempSync(join(tmpdir(), "claude-bridge-state-debug-"));
		const debugPath = join(debugDir, "elsewhere.log");
		try { withAgentDir((agentDir) => {
			writeFileSync(join(agentDir, "claude-bridge.log"), "debug");
			mkdirSync(join(agentDir, "cc-cli-logs"));
			assert.deepEqual(migrateLegacyState(), []);
			assert.equal(read(join(agentDir, "claude-bridge.log")), "debug");
			assert.equal(existsSync(join(agentDir, "cc-cli-logs")), true);
			assert.equal(debugLogPath(), debugPath);
		}, { debugPath }); } finally { rmSync(debugDir, { recursive: true, force: true }); }
	});

	it("drops a writer's stale temp file, leaves a fresh one and any name it does not know", () => withAgentDir((agentDir) => {
		const now = Date.now();
		const old = (now - 120_000) / 1000;
		const make = (path) => { writeFileSync(path, "x"); return path; };
		mkdirSync(join(agentDir, "claude-bridge-mirrors"));
		utimesSync(make(join(agentDir, "claude-bridge-mirrors", "s1.json.11.tmp")), old, old);
		make(join(agentDir, "claude-bridge-mirrors", "s2.json.12.tmp"));
		utimesSync(make(join(agentDir, "claude-bridge-usage-aaa.json.13.tmp")), old, old);
		make(join(agentDir, "claude-bridge-usage-bbb.json.14.tmp"));
		make(join(agentDir, "claude-bridge-usage-ccc.json.bak"));

		assert.deepEqual(migrateLegacyState(now), []);

		assert.deepEqual(readdirSync(join(agentDir, "claude-bridge-mirrors")), ["s2.json.12.tmp"], "an older bridge may still rename the fresh one");
		assert.deepEqual(readdirSync(agentDir).filter((n) => n.startsWith("claude-bridge-usage-")).sort(), ["claude-bridge-usage-bbb.json.14.tmp", "claude-bridge-usage-ccc.json.bak"]);
		utimesSync(join(agentDir, "claude-bridge-mirrors", "s2.json.12.tmp"), old, old);
		assert.deepEqual(migrateLegacyState(now), []);
		assert.equal(existsSync(join(agentDir, "claude-bridge-mirrors")), false, "the next activation finishes the move");
	}));

	it("removes the obsolete session store and usage snapshots older than 30 days", () => withAgentDir((agentDir) => {
		const now = Date.now();
		mkdirSync(state(agentDir, "sessions"), { recursive: true });
		writeFileSync(state(agentDir, "sessions", "s-abc.json"), "{}");
		mkdirSync(state(agentDir, "usage"), { recursive: true });
		writeFileSync(state(agentDir, "usage", "stale.json"), "{}");
		writeFileSync(state(agentDir, "usage", "fresh.json"), "{}");
		const stale = (now - USAGE_MAX_AGE_MS - 60_000) / 1000;
		utimesSync(state(agentDir, "usage", "stale.json"), stale, stale);

		assert.deepEqual(migrateLegacyState(now), []);

		assert.equal(existsSync(state(agentDir, "sessions")), false);
		assert.deepEqual(readdirSync(state(agentDir, "usage")), ["fresh.json"]);
	}));

	it("an agent dir with nothing to move stays as it was", () => withAgentDir((agentDir) => {
		writeFileSync(join(agentDir, "settings.json"), "{}");
		assert.deepEqual(migrateLegacyState(), []);
		assert.deepEqual(readdirSync(agentDir), ["settings.json"]);
	}));

	it("a step that fails is reported, not thrown, and the other steps still run", () => withAgentDir((agentDir) => {
		writeFileSync(join(agentDir, "claude-bridge-usage-aaa.json"), "usage-a");
		writeFileSync(join(agentDir, "claude-bridge"), "a file where the state dir goes");
		let errors;
		assert.doesNotThrow(() => { errors = migrateLegacyState(); });
		assert.ok(errors.length > 0, "the blocked moves are reported");
		assert.equal(read(join(agentDir, "claude-bridge-usage-aaa.json")), "usage-a", "nothing is lost");
	}));

	it("runs at activation", () => withAgentDir((agentDir) => {
		writeFileSync(join(agentDir, "claude-bridge-usage-aaa.json"), "usage-a");
		activate(pi());
		assert.equal(read(state(agentDir, "usage", "aaa.json")), "usage-a");
		assert.equal(existsSync(join(agentDir, "claude-bridge-usage-aaa.json")), false);
	}));
});
