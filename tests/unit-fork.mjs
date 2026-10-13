/**
 * Fork-only helpers in src/fork.ts. The wiring into the provider is pinned by
 * unit-provider-setting-sources.mjs and unit-rate-limit-warnings.mjs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FORK_CHILD_ENV, applyForkChildEnv, providerSettingSourcesOption, rateLimitNoticesEnabled, withRateLimitNoticeFilter } from "../src/fork.js";

describe("providerSettingSourcesOption", () => {
	it("leaves settingSources at the SDK default when unset", () => {
		assert.deepEqual(providerSettingSourcesOption(), {});
		assert.deepEqual(providerSettingSourcesOption({}), {});
	});

	it("leaves settingSources at the SDK default when loadClaudeSettings is true", () => {
		assert.deepEqual(providerSettingSourcesOption({ loadClaudeSettings: true }), {});
	});

	it("disables every setting source when loadClaudeSettings is false", () => {
		assert.deepEqual(providerSettingSourcesOption({ loadClaudeSettings: false }), { settingSources: [] });
	});
});

describe("rateLimitNoticesEnabled", () => {
	it("shows rate-limit notices by default", () => {
		assert.equal(rateLimitNoticesEnabled(), true);
		assert.equal(rateLimitNoticesEnabled({}), true);
	});

	it("shows rate-limit notices when rateLimitWarnings is true", () => {
		assert.equal(rateLimitNoticesEnabled({ rateLimitWarnings: true }), true);
	});

	it("hides rate-limit notices when rateLimitWarnings is false", () => {
		assert.equal(rateLimitNoticesEnabled({ rateLimitWarnings: false }), false);
	});
});

describe("withRateLimitNoticeFilter", () => {
	function recordingUI() {
		const notices = [];
		return {
			notices,
			ui: {
				prefix: "ui:",
				notify(message, type) { notices.push({ message, type }); },
				label(text) { return this.prefix + text; },
			},
		};
	}
	const rateLimitNotices = [
		"Claude rate limit warning: 80% used (five_hour)",
		"Claude subscription rate limit reached (five_hour) — resets at 6:30 PM",
		"Claude rate limited (five_hour) — resets at 6:30 PM",
	];

	it("passes a null UI through", () => {
		assert.equal(withRateLimitNoticeFilter(null, () => ({})), null);
	});

	it("drops rate-limit notices when rateLimitWarnings is false", () => {
		const { ui, notices } = recordingUI();
		const filtered = withRateLimitNoticeFilter(ui, () => ({ rateLimitWarnings: false }));
		for (const message of rateLimitNotices) filtered.notify(message, "warning");
		assert.deepEqual(notices, []);
	});

	it("keeps rate-limit notices when rateLimitWarnings is unset", () => {
		const { ui, notices } = recordingUI();
		const filtered = withRateLimitNoticeFilter(ui, () => ({}));
		for (const message of rateLimitNotices) filtered.notify(message, "warning");
		assert.deepEqual(notices.map((n) => n.message), rateLimitNotices);
	});

	it("keeps every other notice when rateLimitWarnings is false", () => {
		const { ui, notices } = recordingUI();
		const filtered = withRateLimitNoticeFilter(ui, () => ({ rateLimitWarnings: false }));
		filtered.notify("Claude Code exited with code 1", "error");
		assert.deepEqual(notices, [{ message: "Claude Code exited with code 1", type: "error" }]);
	});

	it("reads the setting on each notice, so a config reload applies", () => {
		const { ui, notices } = recordingUI();
		let provider = {};
		const filtered = withRateLimitNoticeFilter(ui, () => provider);
		provider = { rateLimitWarnings: false };
		filtered.notify(rateLimitNotices[0], "warning");
		assert.deepEqual(notices, []);
	});

	it("forwards the UI's other members bound to the UI", () => {
		const { ui } = recordingUI();
		const filtered = withRateLimitNoticeFilter(ui, () => ({}));
		const { label } = filtered;
		assert.equal(label("x"), "ui:x");
		assert.equal(filtered.prefix, "ui:");
	});
});

describe("applyForkChildEnv", () => {
	it("lifts Claude Code's MCP description cap", () => {
		assert.deepEqual(FORK_CHILD_ENV, { CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "1000000" });
	});

	it("overrides a lower user-set limit", () => {
		const env = { CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "2048", PATH: "/bin" };
		applyForkChildEnv(env);
		assert.deepEqual(env, { CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "1000000", PATH: "/bin" });
	});

	it("is applied to pi's environment once the bridge loads", async () => {
		await import("../src/index.js");
		assert.equal(process.env.CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH, "1000000");
	});
});
