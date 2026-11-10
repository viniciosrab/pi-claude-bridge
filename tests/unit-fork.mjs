/**
 * Fork-only helpers in src/fork.ts. The wiring into the provider is pinned by
 * unit-provider-setting-sources.mjs and unit-rate-limit-warnings.mjs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FORK_CHILD_ENV, applyForkChildEnv, providerSettingSourcesOption, rateLimitNoticesEnabled, withProviderSettingSources, withRateLimitNoticeFilter } from "../src/fork.js";

describe("providerSettingSourcesOption", () => {
	it("loads only the user's settings when unset", () => {
		assert.deepEqual(providerSettingSourcesOption(), { settingSources: ["user"] });
		assert.deepEqual(providerSettingSourcesOption({}), { settingSources: ["user"] });
		assert.deepEqual(providerSettingSourcesOption({ loadClaudeSettings: "user" }), { settingSources: ["user"] });
	});

	it("adds the repository's project and local settings when loadClaudeSettings is \"all\" or true", () => {
		assert.deepEqual(providerSettingSourcesOption({ loadClaudeSettings: "all" }), { settingSources: ["user", "project", "local"] });
		assert.deepEqual(providerSettingSourcesOption({ loadClaudeSettings: true }), { settingSources: ["user", "project", "local"] });
	});

	it("disables every setting source when loadClaudeSettings is false", () => {
		assert.deepEqual(providerSettingSourcesOption({ loadClaudeSettings: false }), { settingSources: [] });
	});
});

describe("withProviderSettingSources", () => {
	function launch(provider, options) {
		let seen;
		const wrapped = withProviderSettingSources((params) => { seen = params; return "query"; }, () => provider);
		const params = { prompt: "hi", options };
		assert.equal(wrapped(params), "query");
		return { params, seen };
	}

	it("limits a provider launch to the user's settings when loadClaudeSettings is unset", () => {
		const { seen } = launch({}, { tools: [], model: "m" });
		assert.deepEqual(seen.options, { tools: [], settingSources: ["user"], model: "m" });
	});

	it("empties settingSources on a provider launch when loadClaudeSettings is false", () => {
		const { seen } = launch({ loadClaudeSettings: false }, { tools: [], model: "m" });
		assert.deepEqual(seen.options, { tools: [], settingSources: [], model: "m" });
	});

	it("leaves a launch that names its own settingSources alone (the isolated summary)", () => {
		const { params, seen } = launch({ loadClaudeSettings: "all" }, { tools: [], settingSources: [] });
		assert.equal(seen, params);
	});

	it("leaves a launch with Claude Code's own tools alone", () => {
		const options = { settingSources: ["user"] };
		const { params, seen } = launch({ loadClaudeSettings: false }, options);
		assert.equal(seen, params);
		assert.deepEqual(seen.options, { settingSources: ["user"] });
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
