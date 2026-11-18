import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { claudeCodeSettings, globalConfigPath, loadConfig, removedAskClaudeNotice } from "../src/config.js";

function withTempHome(fn) {
	const oldHome = process.env.HOME;
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const home = mkdtempSync(join(tmpdir(), "claude-bridge-home-"));
	try {
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = join(home, "agent");
		return fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(home, { recursive: true, force: true });
	}
}

describe("claudeCodeSettings", () => {
	it("disables auto-memory by default", () => {
		assert.deepEqual(claudeCodeSettings(), { autoMemoryEnabled: false });
	});

	it("allows auto-memory to be enabled", () => {
		assert.deepEqual(claudeCodeSettings({ autoMemoryEnabled: true }), { autoMemoryEnabled: true });
	});
});

describe("loadConfig", () => {
	it("ignores a project's provider config", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
			}));

			assert.deepEqual(loadConfig(cwd), {
				provider: {},
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("treats a config file that is not a JSON object as empty", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const oldConfig = process.env.CLAUDE_BRIDGE_CONFIG;
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			const globalPath = join(home, "global.json");
			process.env.CLAUDE_BRIDGE_CONFIG = globalPath;
			for (const body of ["null", "[]", '"x"', "1"]) {
				writeFileSync(join(configDir, "claude-bridge.json"), body);
				writeFileSync(globalPath, body);
				const config = loadConfig(cwd);
				assert.deepEqual(config.provider, {}, `provider for ${body}`);
			}
		} finally {
			if (oldConfig === undefined) delete process.env.CLAUDE_BRIDGE_CONFIG;
			else process.env.CLAUDE_BRIDGE_CONFIG = oldConfig;
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("reads the global config from CLAUDE_BRIDGE_CONFIG when it is set", () => withTempHome((home) => {
		const path = join(home, "elsewhere.json");
		writeFileSync(path, JSON.stringify({ provider: { plan: "max" } }));
		const oldConfig = process.env.CLAUDE_BRIDGE_CONFIG;
		process.env.CLAUDE_BRIDGE_CONFIG = path;
		try {
			assert.equal(globalConfigPath(), path);
			assert.deepEqual(loadConfig(home).provider, { plan: "max" });
		} finally {
			if (oldConfig === undefined) delete process.env.CLAUDE_BRIDGE_CONFIG;
			else process.env.CLAUDE_BRIDGE_CONFIG = oldConfig;
		}
	}));

	it("keeps the global provider config when a project sets its own", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "pro", strictMcpConfig: true },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max", autoMemoryEnabled: true },
			}));

			assert.deepEqual(loadConfig(cwd), {
				provider: { plan: "pro", strictMcpConfig: true },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	// AskClaude was removed: a config written for it must still load, its section ignored.
	it("ignores a leftover askClaude section and its notice mark", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				askClaudeDeprecationShown: "2026-01-01",
				askClaude: { enabled: true, defaultMode: "full" },
				provider: { plan: "max" },
			}));

			assert.deepEqual(loadConfig(cwd), {
				provider: { plan: "max" },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("tells a user who still enables AskClaude that it was removed", () => withTempHome(() => {
		const globalDir = getAgentDir();
		mkdirSync(globalDir, { recursive: true });
		const path = join(globalDir, "claude-bridge.json");

		assert.equal(removedAskClaudeNotice(), undefined, "no config file");
		writeFileSync(path, JSON.stringify({ askClaude: { enabled: false } }));
		assert.equal(removedAskClaudeNotice(), undefined, "AskClaude was off");
		writeFileSync(path, JSON.stringify({ askClaude: { enabled: true } }));
		const notice = removedAskClaudeNotice();
		assert.match(notice, /AskClaude was removed/);
		assert.ok(notice.includes(path), "names the file to edit");
	}));

	// The removed startup notice wrote startupNoticeShown to the global config (and read it
	// from a project's): a config that still holds it must load, the key ignored.
	it("ignores a leftover startupNoticeShown mark", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				startupNoticeShown: true,
				provider: { strictMcpConfig: false },
			}));
			mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
			writeFileSync(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"), JSON.stringify({ startupNoticeShown: "2026-01-01" }));

			assert.deepEqual(loadConfig(cwd), {
				provider: { strictMcpConfig: false },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("resolves global config via PI_CODING_AGENT_DIR override, not hardcoded ~/.pi/agent", () => withTempHome(() => {
		const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const oldEnv = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
			}));

			assert.deepEqual(loadConfig(cwd), {
				provider: { plan: "max" },
			});
		} finally {
			if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldEnv;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	}));
});
