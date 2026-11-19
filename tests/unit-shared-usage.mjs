/**
 * Plan usage shared across pi processes: a subagent's rate_limit_event reaches the
 * parent's Gentle Shell usage bar while the subagent is still working.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Publishes as a process on another account would, leaving this process on its own. */
function publishAs(account, usage, at) {
	const own = process.env.CLAUDE_CODE_OAUTH_TOKEN;
	process.env.CLAUDE_CODE_OAUTH_TOKEN = account;
	try { publishUsage(usage, at); }
	finally {
		if (own === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		else process.env.CLAUDE_CODE_OAUTH_TOKEN = own;
	}
}

afterEach(() => {
	const dir = dirname(sharedUsagePath());
	for (const name of readdirSync(dir)) if (name.startsWith("claude-bridge-usage-")) rmSync(join(dir, name), { force: true });
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
			publishAs("another-account", info, Date.now() + 1);
			await sleep(500);
			assert.equal(pi.emitted.length, 1);
			assert.deepEqual(await payload.fetch(undefined, fetch, Date.now()), usage);
		} finally {
			pi.shutdown("tui");
		}

		publishUsage(info, Date.now() + 2);
		await sleep(500);
		assert.equal(pi.emitted.length, 1, "a shut-down session stops watching");
	});

	it("keeps this account's report when another account publishes right after it", async () => {
		const pi = activated();
		pi.start("tui");
		try {
			const at = Date.now();
			publishUsage(info, at);
			publishAs("another-account", { ...info, unifiedWindows: { five_hour: { utilization: 0.99, resetsAt: 1789770600 } } }, at + 1);
			await sleep(500);

			assert.equal(pi.emitted.length, 1);
			assert.deepEqual(await pi.emitted[0].payload.fetch(undefined, fetch, Date.now()), expected(at));
		} finally {
			pi.shutdown("tui");
		}
	});

	describe("within one usage window", () => {
		/** Five-hour usage only, so each test can pick its own window (the high-water mark is per process). */
		const fiveHour = (utilization, resetsAt) => ({
			status: "allowed", resetsAt, rateLimitType: "five_hour",
			unifiedWindows: { five_hour: { utilization, resetsAt } },
		});
		const percent = () => sharedProviderUsage("claude-bridge")?.limits[0].windows[0].usedPercent;

		/** Drives one rate_limit_event through consumeQuery, returning the 5h header pi's onResponse got. */
		async function report(usage) {
			const headers = [];
			const c = new QueryContext();
			c.currentPiStream = { push: () => {}, end: () => {} };
			c.currentOnResponse = (r) => { headers.push(r.headers["anthropic-ratelimit-unified-5h-utilization"]); };
			c.resetTurnState(model);
			async function* stream() { yield { type: "rate_limit_event", rate_limit_info: usage }; }
			await __test.consumeQuery(stream(), new Map(), model, () => false, c);
			return headers;
		}

		it("never moves backwards when a report carrying an older measurement arrives later", async () => {
			const resetsAt = 1789780000;
			// Another process reports 82% first; this one's report, measured earlier, arrives after.
			publishUsage(fiveHour(0.82, resetsAt), Date.now());

			assert.deepEqual(await report(fiveHour(0.81, resetsAt)), ["0.82"]);
			assert.equal(percent(), 82);

			assert.deepEqual(await report(fiveHour(0.85, resetsAt)), ["0.85"]);
			assert.equal(percent(), 85);
		});

		it("raises held usage to the current maximum when it is finally delivered", async () => {
			const resetsAt = 1789800000;
			const headers = [];
			const c = new QueryContext();
			c.resetTurnState(model);
			// The parent's stream is closed (parked on a tool): its 81% is held.
			async function* held() { yield { type: "rate_limit_event", rate_limit_info: fiveHour(0.81, resetsAt) }; }
			await __test.consumeQuery(held(), new Map(), model, () => false, c);
			// Meanwhile a subagent reports 85%.
			publishUsage(fiveHour(0.85, resetsAt), Date.now());
			// The tool returns and the next stream opens: the held report goes out now.
			c.currentPiStream = { push: () => {}, end: () => {} };
			c.currentOnResponse = (r) => { headers.push(r.headers["anthropic-ratelimit-unified-5h-utilization"]); };
			async function* next() { yield { type: "stream_event", event: { type: "ping" } }; }
			await __test.consumeQuery(next(), new Map(), model, () => false, c);

			assert.deepEqual(headers, ["0.85"]);
		});

		it("keeps no maximum for a window reported without a reset time", async () => {
			const noReset = (utilization) => ({ status: "allowed", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization } } });
			assert.deepEqual(await report(noReset(0.9)), ["0.9"]);
			assert.deepEqual(await report(noReset(0.03)), ["0.03"]);
		});

		it("never shows less than this process has seen, even when another writer lowers the file", async () => {
			const resetsAt = 1789790000;
			await report(fiveHour(0.6, resetsAt));
			publishUsage(fiveHour(0.55, resetsAt), Date.now());

			assert.equal(percent(), 60);
		});

		it("takes a new window's lower value after a reset", async () => {
			publishUsage(fiveHour(0.82, 1789800000), Date.now());
			await report(fiveHour(0.82, 1789800000));

			assert.deepEqual(await report(fiveHour(0.03, 1789818000)), ["0.03"]);
			assert.equal(percent(), 3);
		});
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
