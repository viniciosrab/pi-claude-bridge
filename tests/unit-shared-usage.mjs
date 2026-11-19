/**
 * Plan usage shared across pi processes: a subagent's rate_limit_event reaches the
 * parent's Gentle Shell usage bar while the subagent is still working.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { QueryContext } from "../src/query-state.js";
import { USAGE_SOURCE_EVENT, publishUsage, sharedProviderUsage, sharedUsagePath } from "../src/shared-usage.js";

const mod = await import("../src/index.js");
const { __test, default: activate } = mod;

const model = {
	api: "claude-bridge", provider: "claude-bridge", id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const info = {
	status: "allowed",
	resetsAt: 1789770600,
	rateLimitType: "five_hour",
	unifiedWindows: {
		five_hour: { utilization: 0.14, resetsAt: 1789770600 },
		seven_day: { utilization: 0.5, resetsAt: 1790042400 },
		seven_day_overage_included: { utilization: 0.9, resetsAt: 1790042400 },
	},
};
const expected = (fetchedAt) => ({
	provider: "claude-bridge",
	plan: undefined,
	limits: [{
		name: "claude",
		limitReached: false,
		windows: [
			{ label: "5h", usedPercent: 14.000000000000002, windowSeconds: 18_000, resetAt: 1789770600_000 },
			{ label: "week", usedPercent: 50, windowSeconds: 604_800, resetAt: 1790042400_000 },
		],
	}],
	fetchedAt,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;

afterEach(() => {
	rmSync(sharedUsagePath(), { force: true });
	if (token === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
	else process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
});

/** The extension under a stub pi that records every handler and every pi.events emit. */
function activated() {
	const handlers = {};
	const emitted = [];
	activate({
		on: (event, handler) => (handlers[event] ??= []).push(handler),
		registerProvider: () => {},
		events: { emit: (channel, payload) => emitted.push({ channel, payload }), on: () => () => {} },
	});
	const ctx = (mode) => ({ mode, cwd: process.cwd(), ui: { notify: () => {} }, sessionManager: { getSessionId: () => `shared-usage-${mode}` } });
	return {
		emitted,
		start: (mode) => { for (const fn of handlers.session_start) fn({ reason: "startup" }, ctx(mode)); },
		shutdown: (mode) => { for (const fn of handlers.session_shutdown) fn({}, ctx(mode)); },
	};
}

describe("shared plan usage", () => {
	it("publishes a rate_limit_event even with no pi stream open, as at a subagent's tool boundary", async () => {
		const c = new QueryContext();
		c.resetTurnState(model);
		async function* stream() { yield { type: "rate_limit_event", rate_limit_info: info }; }
		const before = Date.now();

		await __test.consumeQuery(stream(), new Map(), model, () => false, c);

		const usage = sharedProviderUsage("claude-bridge");
		assert.ok(usage && usage.fetchedAt >= before && usage.fetchedAt <= Date.now());
		assert.deepEqual(usage, expected(usage.fetchedAt));
	});

	it("keeps another account's usage out of this process", () => {
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "account-a";
		publishUsage(info, 1000);
		assert.deepEqual(sharedProviderUsage("claude-bridge"), expected(1000));

		process.env.CLAUDE_CODE_OAUTH_TOKEN = "account-b";
		assert.equal(sharedProviderUsage("claude-bridge"), undefined);
	});

	it("re-registers the usage source in the interactive parent when another process reports", async () => {
		const pi = activated();
		pi.start("tui");
		try {
			publishUsage(info, Date.now());
			await sleep(500);

			assert.equal(pi.emitted.length, 1);
			const [{ channel, payload }] = pi.emitted;
			assert.equal(channel, USAGE_SOURCE_EVENT);
			assert.equal(payload.schema, "gentle-pi.usage-source/v1");
			assert.equal(payload.provider, "claude-bridge");
			const usage = await payload.fetch(undefined, fetch, Date.now());
			assert.deepEqual(usage, expected(usage.fetchedAt));

			// Another account's report, from a process on another token, is not this bar's.
			writeFileSync(sharedUsagePath(), JSON.stringify({ version: 1, account: "0123456789abcdef", at: Date.now() + 1, info }));
			await sleep(500);
			assert.equal(pi.emitted.length, 1);
		} finally {
			pi.shutdown("tui");
		}

		publishUsage(info, Date.now() + 2);
		await sleep(500);
		assert.equal(pi.emitted.length, 1, "a shut-down session stops watching");
	});

	it("does not watch from a subagent's rpc process", async () => {
		const pi = activated();
		pi.start("rpc");
		try {
			publishUsage(info, Date.now());
			await sleep(500);
			assert.deepEqual(pi.emitted, []);
		} finally {
			pi.shutdown("rpc");
		}
	});
});
