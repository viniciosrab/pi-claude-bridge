/**
 * The bridge no longer shows a one-time "Are you using a Max plan?" notice, and no
 * longer writes `startupNoticeShown` to the user's global config to remember it.
 *
 * The notice was wrong: current Opus models get [1m] on every plan (src/models.ts
 * MEASURED_ONE_M); `provider.plan` only matters for claude-opus-4-6. These tests drive
 * a fresh first turn in TUI mode with a mocked SDK query() and a config without `plan`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The global config the bridge reads, written before the extension loads it.
const configPath = join(process.env.PI_CODING_AGENT_DIR, "claude-bridge.json");
mkdirSync(dirname(configPath), { recursive: true });
const configText = `${JSON.stringify({ provider: { strictMcpConfig: true } }, null, 2)}\n`;
writeFileSync(configPath, configText);

const mod = await import("../src/index.js");
const { setQuery } = mod.__test;
let providerConfig;
const handlers = {};
mod.default({
	on: (name, fn) => { (handlers[name] ??= []).push(fn); },
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});

describe("first turn without provider.plan", () => {
	it("shows no Max plan notice and leaves the global config byte-identical", async () => {
		const notices = [];
		const ctx = { ui: { notify: (message, level) => notices.push({ message, level }) }, mode: "tui", cwd: process.cwd(), sessionManager: { getSessionId: () => "pi-notice" }, hasUI: true };
		for (const fn of handlers.session_start ?? []) await fn({ type: "session_start", reason: "startup" }, ctx);

		setQuery(({ prompt }) => {
			const gen = (async function* () {
				await prompt[Symbol.asyncIterator]().next();
				yield { type: "system", subtype: "init", session_id: "cc-notice" };
				yield { type: "result", subtype: "success", is_error: false, result: "ok" };
			})();
			gen.interrupt = async () => {};
			gen.close = () => {};
			return gen;
		});
		try {
			const model = providerConfig.models[0];
			await providerConfig.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { sessionId: "pi-notice" }).result();
		} finally {
			setQuery(null);
		}

		assert.deepEqual(notices.filter((n) => /Max plan|provider\.plan|Welcome to pi-claude-bridge/.test(n.message)), []);
		assert.equal(readFileSync(configPath, "utf8"), configText, "the bridge does not write the user's config");
	});
});
