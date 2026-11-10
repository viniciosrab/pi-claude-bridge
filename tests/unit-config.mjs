import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { claudeCodeSettings, globalConfigPath, loadConfig, markStartupNoticeShown, removedAskClaudeNotice } from "../src/config.js";

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
				startupNoticeShown: undefined,
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
				assert.equal(config.startupNoticeShown, undefined, `startupNoticeShown for ${body}`);
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
				startupNoticeShown: undefined,
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
				startupNoticeShown: undefined,
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

	it("markStartupNoticeShown records today's date without dropping existing settings", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			mkdirSync(globalDir, { recursive: true });
			const path = join(globalDir, "claude-bridge.json");
			writeFileSync(path, JSON.stringify({
				provider: { strictMcpConfig: false },
			}));

			assert.equal(markStartupNoticeShown(), path);
			const written = JSON.parse(readFileSync(path, "utf-8"));
			assert.match(written.startupNoticeShown, /^\d{4}-\d{2}-\d{2}$/);
			assert.deepEqual(written.provider, { strictMcpConfig: false });
			assert.equal(loadConfig(cwd).startupNoticeShown, written.startupNoticeShown);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("markStartupNoticeShown keeps a symlinked config linked and its permissions", () => withTempHome((home) => {
		const globalDir = getAgentDir();
		mkdirSync(globalDir, { recursive: true });
		const real = join(home, "dotfiles-claude-bridge.json");
		writeFileSync(real, JSON.stringify({ provider: { plan: "max" } }), { mode: 0o600 });
		chmodSync(real, 0o600);
		const link = join(globalDir, "claude-bridge.json");
		symlinkSync(real, link);

		markStartupNoticeShown();

		assert.ok(lstatSync(link).isSymbolicLink(), "the config must stay a symlink");
		const written = JSON.parse(readFileSync(real, "utf-8"));
		assert.equal(written.provider.plan, "max");
		assert.match(written.startupNoticeShown, /^\d{4}-\d{2}-\d{2}$/);
		assert.equal(statSync(real).mode & 0o777, 0o600);
		assert.deepEqual(readdirSync(home).filter((name) => name.endsWith(".tmp")), []);
	}));

	it("markStartupNoticeShown writes through a dangling config symlink", () => withTempHome((home) => {
		const globalDir = getAgentDir();
		mkdirSync(globalDir, { recursive: true });
		const real = join(home, "dotfiles-not-yet.json");
		const link = join(globalDir, "claude-bridge.json");
		symlinkSync(real, link);

		markStartupNoticeShown();

		assert.ok(lstatSync(link).isSymbolicLink(), "the config must stay a symlink");
		assert.match(JSON.parse(readFileSync(real, "utf-8")).startupNoticeShown, /^\d{4}-\d{2}-\d{2}$/);
	}));

	it("markStartupNoticeShown follows a chain of links to a missing file", () => withTempHome((home) => {
		const globalDir = getAgentDir();
		mkdirSync(globalDir, { recursive: true });
		const real = join(home, "dotfiles-final.json");
		const middle = join(home, "dotfiles-link.json");
		symlinkSync(real, middle);
		const link = join(globalDir, "claude-bridge.json");
		symlinkSync(middle, link);

		markStartupNoticeShown();

		assert.ok(lstatSync(link).isSymbolicLink(), "the config must stay a symlink");
		assert.ok(lstatSync(middle).isSymbolicLink(), "the link in the middle must stay a symlink");
		assert.match(JSON.parse(readFileSync(real, "utf-8")).startupNoticeShown, /^\d{4}-\d{2}-\d{2}$/);
	}));

	it("markStartupNoticeShown keeps the config's mode under a restrictive umask", () => withTempHome(() => {
		const globalDir = getAgentDir();
		mkdirSync(globalDir, { recursive: true });
		const path = join(globalDir, "claude-bridge.json");
		writeFileSync(path, "{}");
		chmodSync(path, 0o644);
		const oldUmask = process.umask(0o077);
		try {
			markStartupNoticeShown();
		} finally {
			process.umask(oldUmask);
		}
		assert.equal(statSync(path).mode & 0o777, 0o644);
	}));

	it("markStartupNoticeShown does not throw when the config cannot be rewritten", () => withTempHome((home) => {
		const globalDir = getAgentDir();
		mkdirSync(globalDir, { recursive: true });
		const lockedDir = join(home, "locked");
		mkdirSync(lockedDir);
		const real = join(lockedDir, "claude-bridge.json");
		writeFileSync(real, JSON.stringify({ provider: { plan: "max" } }));
		symlinkSync(real, join(globalDir, "claude-bridge.json"));
		chmodSync(lockedDir, 0o500);
		try {
			assert.equal(markStartupNoticeShown(), join(globalDir, "claude-bridge.json"));
			assert.deepEqual(JSON.parse(readFileSync(real, "utf-8")), { provider: { plan: "max" } });
			assert.deepEqual(readdirSync(lockedDir), ["claude-bridge.json"]);
		} finally {
			chmodSync(lockedDir, 0o700);
		}
	}));

	it("markStartupNoticeShown leaves an unparseable config untouched", () => withTempHome(() => {
		const globalDir = getAgentDir();
		mkdirSync(globalDir, { recursive: true });
		const path = join(globalDir, "claude-bridge.json");
		const malformed = '{ "provider": { "plan": "max" }, }';
		writeFileSync(path, malformed);

		markStartupNoticeShown();
		assert.equal(readFileSync(path, "utf-8"), malformed, "a typo must not cost the user their config");
	}));

	it("markStartupNoticeShown creates the config when there is none", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			assert.equal(loadConfig(cwd).startupNoticeShown, undefined);
			markStartupNoticeShown();
			assert.match(loadConfig(cwd).startupNoticeShown, /^\d{4}-\d{2}-\d{2}$/);
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
				startupNoticeShown: undefined,
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
