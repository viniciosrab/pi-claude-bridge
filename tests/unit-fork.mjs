/**
 * Fork-only helpers in src/fork.ts. The wiring into the provider is pinned by
 * unit-provider-setting-sources.mjs and unit-rate-limit-warnings.mjs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { providerSettingSourcesOption, withProviderSettingSources } from "../src/fork.js";

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

describe("withProviderSettingSources", () => {
	function launch(provider, options) {
		let seen;
		const wrapped = withProviderSettingSources((params) => { seen = params; return "query"; }, () => provider);
		const params = { prompt: "hi", options };
		assert.equal(wrapped(params), "query");
		return { params, seen };
	}

	it("passes a provider launch through untouched when loadClaudeSettings is unset", () => {
		const { params, seen } = launch({}, { tools: [], settingSources: ["user"] });
		assert.equal(seen, params);
	});

	it("empties settingSources on a provider launch when loadClaudeSettings is false", () => {
		const { seen } = launch({ loadClaudeSettings: false }, { tools: [], settingSources: ["user"], model: "m" });
		assert.deepEqual(seen.options, { tools: [], settingSources: [], model: "m" });
	});

	it("leaves AskClaude launches (Claude Code's own tools) alone", () => {
		const options = { settingSources: ["user"] };
		const { params, seen } = launch({ loadClaudeSettings: false }, options);
		assert.equal(seen, params);
		assert.deepEqual(seen.options, { settingSources: ["user"] });
	});
});
