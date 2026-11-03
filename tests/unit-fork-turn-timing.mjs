// With CLAUDE_BRIDGE_DEBUG=1 the bridge log splits each provider query's latency
// into Claude Code's start-up, the first token, and Claude Code vs API time
// (src/fork-turn-timing.ts).
//
// A result's duration_api_ms is Claude Code's running total for the whole CC
// session, carried across --resume (tests/int-fork-cc-contracts.mjs pins it live), so
// the log subtracts the total the bridge last saw for that session.
//
// One test runs a provider query end to end, to prove the hook is wired. The rest
// drive withTurnTiming directly with each launch's `resume`, since which session the
// provider resumes is upstream's session sync, which the fork does not own.
import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";

// Read at import: debug() is a no-op unless this is set first.
process.env.CLAUDE_BRIDGE_DEBUG = "1";
const { default: activate, __test } = await import("../src/index.js");
const { forgetSessionCwd } = await import("../src/session-cwd.ts");
const { withTurnTiming } = await import("../src/fork-turn-timing.ts");

const logPath = () => process.env.CLAUDE_BRIDGE_DEBUG_PATH;
const logSize = () => (existsSync(logPath()) ? statSync(logPath()).size : 0);
/** The timing lines written since `offset`. */
const timingSince = (offset) => {
	assert.ok(existsSync(logPath()), "the bridge log was written");
	return readFileSync(logPath()).subarray(offset).toString("utf8").split("\n").filter((line) => line.includes("timing:"));
};

/** One launch's messages: init and a streamed turn on `sessionId`, then a result
 *  carrying the cumulative API time `total`; a null total ends the turn without a
 *  result (an abort, a dead CLI). */
async function* turnMessages(sessionId, total) {
	yield { type: "system", subtype: "init", session_id: sessionId };
	yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: `msg_${total}`, usage: {} } } };
	yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
	yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } };
	yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } };
	if (total === null) return;
	yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: sessionId, duration_ms: 900, duration_api_ms: total };
}

/** A timed fake query(): each launch runs on its `resume` session, else on `freshId`. */
function timedLaunches(freshId) {
	const logged = [];
	const timed = withTurnTiming(({ options }) => {
		const gen = turnMessages(options.resume ?? freshId, options.total);
		gen.interrupt = async () => {};
		return gen;
	}, (line) => logged.push(line));
	/** Launch and drain one query; returns the result line it logged. */
	const launch = async (total, resume) => {
		const before = logged.length;
		for await (const _ of timed({ prompt: (async function* () {})(), options: { total, ...(resume ? { resume } : {}) } }));
		return logged.slice(before).filter((line) => line.includes(" result "));
	};
	return { launch, logged };
}

function provider(mod) {
	const handlers = {};
	let providerConfig;
	mod({
		on: (name, fn) => { (handlers[name] ??= []).push(fn); },
		registerProvider: (_name, config) => { providerConfig = config; },
		registerTool: () => {},
	});
	return { handlers, providerConfig };
}

it("logs start-up, first token and result timing for a provider query", async (t) => {
	const { handlers, providerConfig } = provider(activate);
	for (const fn of handlers.session_start) fn({}, { cwd: process.cwd(), sessionManager: { getSessionId: () => "s-timing" } });
	t.after(() => forgetSessionCwd("s-timing"));
	const resumes = [];
	__test.setQuery(({ prompt, options }) => {
		resumes.push(options.resume);
		const gen = (async function* () {
			await prompt[Symbol.asyncIterator]().next();
			yield* turnMessages(options.resume ?? options.sessionId ?? "cc-timing", 700);
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
	t.after(() => __test.setQuery(null));

	const offset = logSize();
	const message = { role: "user", content: "hi", timestamp: 1_000 };
	await providerConfig.streamSimple(providerConfig.models[0], { messages: [message], tools: [] }, { sessionId: "s-timing" }).result();

	assert.deepEqual(resumes, [undefined], "a brand-new Claude Code session");
	const lines = timingSince(offset);
	assert.equal(lines.length, 3, lines.join("\n"));
	assert.match(lines[0], /timing: query=q\d+ spawn→init=\d+ms$/);
	assert.match(lines[1], /timing: query=q\d+ first token=\d+ms$/);
	// A new session has spent nothing before this turn: all of its total is this turn's.
	assert.match(lines[2], /timing: query=q\d+ result elapsed=\d+ms cc=900ms api=700ms apiTotal=700ms$/);
	const ids = lines.map((line) => line.match(/query=(q\d+)/)[1]);
	assert.equal(new Set(ids).size, 1, "all three lines name the same query");
});

it("logs only this turn's API time when a turn resumes a session it has seen", async () => {
	const { launch } = timedLaunches("cc-timing-delta");
	assert.match((await launch(700))[0], / cc=900ms api=700ms apiTotal=700ms$/);
	const second = await launch(1200, "cc-timing-delta");
	assert.equal(second.length, 1, second.join("\n"));
	assert.match(second[0], / cc=900ms api=500ms apiTotal=1200ms$/);

	// A total below the last one seen is not a running total of the same session: unknown.
	assert.match((await launch(1100, "cc-timing-delta"))[0], / cc=900ms api=\? apiTotal=1100ms$/);
});

it("logs api=? on the first turn of a session resumed in a new process", async () => {
	// A new pi process wraps its own query(), so it has seen none of the session's totals.
	await timedLaunches("cc-timing-reopen").launch(700);
	const lines = await timedLaunches("unused").launch(1500, "cc-timing-reopen");
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.match(lines[0], / cc=900ms api=\? apiTotal=1500ms$/);
});

it("logs api=? after a turn that ended without a result", async () => {
	const { launch } = timedLaunches("cc-timing-unsettled");
	await launch(700);
	assert.deepEqual(await launch(null, "cc-timing-unsettled"), [], "the unfinished turn logs no result");
	// The unfinished turn's API time is in CC's next total but was never logged, so
	// subtracting the last logged total would charge it to the next turn.
	const lines = await launch(1500, "cc-timing-unsettled");
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.match(lines[0], / cc=900ms api=\? apiTotal=1500ms$/);
});

it("times only streamed-prompt launches and keeps the SDK's Query object", async () => {
	const fake = () => {
		const gen = turnMessages("cc-wrap", 40);
		gen.interrupt = async () => {};
		return gen;
	};
	const logged = [];
	const timed = withTurnTiming(fake, (line) => logged.push(line));
	const drain = async (q) => { const seen = []; for await (const m of q) seen.push(m.type); return seen; };
	const types = ["system", "stream_event", "stream_event", "stream_event", "stream_event", "result"];

	// The isolated summary and AskClaude pass a string prompt: untouched, nothing logged.
	const plain = timed({ prompt: "summarize", options: {} });
	assert.equal(Object.hasOwn(plain, Symbol.asyncIterator), false, "a string-prompt query is not wrapped");
	assert.deepEqual(await drain(plain), types);
	assert.deepEqual(logged, []);

	// A provider launch streams its prompt: same object, same messages, timing logged.
	const q = timed({ prompt: (async function* () {})(), options: {} });
	assert.equal(typeof q.interrupt, "function", "the Query keeps its methods");
	assert.deepEqual(await drain(q), types, "every message still reaches the consumer");
	assert.equal(logged.length, 3, logged.join("\n"));
	assert.match(logged[0], /^timing: query=q1 spawn→init=\d+ms$/);
	assert.match(logged[1], /^timing: query=q1 first token=\d+ms$/);
	assert.match(logged[2], /^timing: query=q1 result elapsed=\d+ms cc=900ms api=40ms apiTotal=40ms$/);
});
