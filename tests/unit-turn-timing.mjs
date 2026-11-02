// With CLAUDE_BRIDGE_DEBUG=1 the bridge log splits each query's latency into
// Claude Code's start-up, the first token, and Claude Code vs API time.
//
// A result's duration_api_ms is Claude Code's running total for the whole CC
// session, carried across --resume (tests/int-cc-contracts.mjs pins it live), so
// the log subtracts the total the bridge last saw for that session.
import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createSession } from "cc-session-io";

// Read at import: debug() is a no-op unless this is set first.
process.env.CLAUDE_BRIDGE_DEBUG = "1";
const { default: activate, __test } = await import("../src/index.js");
const { forgetSessionCwd } = await import("../src/session-cwd.ts");

const logPath = () => process.env.CLAUDE_BRIDGE_DEBUG_PATH;
const logSize = () => (existsSync(logPath()) ? statSync(logPath()).size : 0);
/** The timing lines written since `offset`. */
const timingSince = (offset) => {
	assert.ok(existsSync(logPath()), "the bridge log was written");
	return readFileSync(logPath()).subarray(offset).toString("utf8").split("\n").filter((line) => line.includes("timing:"));
};

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
const { handlers, providerConfig } = provider(activate);

let clock = 1_000;
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const say = (t) => ({ role: "assistant", content: [{ type: "text", text: t }], api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: clock++ });

/** A fake query() answering each call from `totals` in turn: one result per call,
 *  on the resumed CC session or on `freshId`, carrying that cumulative API time;
 *  a null total ends that call's turn without a result. */
function fakeQuery(test, freshId, totals, resumes) {
	test.setQuery(({ prompt, options }) => {
		resumes.push(options.resume);
		const sessionId = options.resume ?? freshId;
		const total = totals.shift();
		const gen = (async function* () {
			await prompt[Symbol.asyncIterator]().next();
			yield { type: "system", subtype: "init", session_id: sessionId };
			yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: `msg_${total}`, usage: {} } } };
			yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
			yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } };
			yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } };
			// null: the turn ends without a result (an abort, a dead CLI).
			if (total === null) return;
			yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: sessionId, duration_ms: 900, duration_api_ms: total };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
}

it("logs start-up, first token and result timing for a provider query", async (t) => {
	for (const fn of handlers.session_start) fn({}, { cwd: process.cwd(), sessionManager: { getSessionId: () => "s-timing" } });
	t.after(() => forgetSessionCwd("s-timing"));
	const resumes = [];
	fakeQuery(__test, "cc-timing", [700], resumes);
	t.after(() => __test.setQuery(null));

	const offset = logSize();
	await providerConfig.streamSimple(providerConfig.models[0], { messages: [user("hi")], tools: [] }, { sessionId: "s-timing" }).result();

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

it("logs only this turn's API time when a turn resumes a session it has seen", async (t) => {
	const resumes = [];
	fakeQuery(__test, "cc-timing-delta", [700, 1200, 1100], resumes);
	t.after(() => __test.setQuery(null));
	const call = (messages) => providerConfig.streamSimple(providerConfig.models[0], { messages, tools: [] }, { sessionId: "s-timing-delta" }).result();
	const u1 = user("first"), a1 = say("ok"), u2 = user("second"), a2 = say("ok"), u3 = user("third");

	await call([u1]);
	const offset = logSize();
	await call([u1, a1, u2]);
	assert.deepEqual(resumes, [undefined, "cc-timing-delta"], "the second turn resumes the first turn's session");
	const second = timingSince(offset).filter((line) => line.includes(" result "));
	assert.equal(second.length, 1, second.join("\n"));
	assert.match(second[0], / cc=900ms api=500ms apiTotal=1200ms$/);

	// A total below the last one seen is not a running total of the same session: unknown.
	const offset3 = logSize();
	await call([u1, a1, u2, a2, u3]);
	assert.equal(resumes[2], "cc-timing-delta");
	const third = timingSince(offset3).filter((line) => line.includes(" result "));
	assert.match(third[0], / cc=900ms api=\? apiTotal=1100ms$/);
});

it("logs api=? on the first turn of a session resumed in a new process", async (t) => {
	const P = "s-timing-reopen", cwd = process.cwd();
	const resumes = [];
	fakeQuery(__test, "cc-timing-reopen", [700], resumes);
	t.after(() => __test.setQuery(null));
	const u1 = user("first"), a1 = say("ok"), u2 = user("second");
	await providerConfig.streamSimple(providerConfig.models[0], { messages: [u1], tools: [] }, { sessionId: P }).result();
	// The transcript the real CLI writes for its own session; the fake writes none.
	const session = createSession({ sessionId: "cc-timing-reopen", projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
	session.importMessages([{ role: "user", content: "written by claude code" }]);
	session.save();

	// A new pi process: a fresh module instance that knows the session only from disk.
	// Its own process has no provider registered yet, so it registers as the first.
	const active = Symbol.for("claude-bridge:activeStreamSimple"), registered = globalThis[active];
	globalThis[active] = undefined;
	t.after(() => { globalThis[active] = registered; });
	const reopened = await import("../src/index.js?timing-new-process");
	const second = provider(reopened.default);
	const resumed = [];
	fakeQuery(reopened.__test, "unused", [1500], resumed);
	t.after(() => reopened.__test.setQuery(null));
	const offset = logSize();
	await second.providerConfig.streamSimple(second.providerConfig.models[0], { messages: [u1, a1, u2], tools: [] }, { sessionId: P }).result();

	assert.deepEqual(resumed, ["cc-timing-reopen"], "the new process resumes the CC session");
	const lines = timingSince(offset).filter((line) => line.includes(" result "));
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.match(lines[0], / cc=900ms api=\? apiTotal=1500ms$/);
});

it("logs api=? after a turn that ended without a result", async (t) => {
	const resumes = [];
	fakeQuery(__test, "cc-timing-unsettled", [700, null, 1500], resumes);
	t.after(() => __test.setQuery(null));
	const call = (messages) => providerConfig.streamSimple(providerConfig.models[0], { messages, tools: [] }, { sessionId: "s-timing-unsettled" }).result();
	const u1 = user("first"), a1 = say("ok"), u2 = user("second"), a2 = say("ok"), u3 = user("third");

	await call([u1]);
	await call([u1, a1, u2]);
	// The unfinished turn's API time is in CC's next total but was never logged, so
	// subtracting the last logged total would charge it to the next turn.
	const offset = logSize();
	await call([u1, a1, u2, a2, u3]);
	assert.equal(resumes[2], "cc-timing-unsettled", "the third turn resumes the same session");
	const lines = timingSince(offset).filter((line) => line.includes(" result "));
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.match(lines[0], / cc=900ms api=\? apiTotal=1500ms$/);
});
