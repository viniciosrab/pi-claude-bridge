/**
 * Fork-only helpers in src/fork.ts. The wiring into the provider is pinned by
 * unit-provider-setting-sources.mjs and unit-rate-limit-warnings.mjs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { providerSettingSourcesOption } from "../src/fork.js";

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
