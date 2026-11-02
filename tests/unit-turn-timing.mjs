// With CLAUDE_BRIDGE_DEBUG=1 the bridge log splits each query's latency into
// Claude Code's start-up, the first token, and Claude Code vs API time.
import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// Read at import: debug() is a no-op unless this is set first.
process.env.CLAUDE_BRIDGE_DEBUG = "1";
const { default: activate, __test } = await import("../src/index.js");
const { forgetSessionCwd } = await import("../src/session-cwd.ts");

it("logs start-up, first token and result timing for a provider query", async (t) => {
	const handlers = {};
	let providerConfig;
	activate({
		on: (name, fn) => { (handlers[name] ??= []).push(fn); },
		registerProvider: (_name, config) => { providerConfig = config; },
		registerTool: () => {},
	});
	for (const fn of handlers.session_start) fn({}, { cwd: process.cwd(), sessionManager: { getSessionId: () => "s-timing" } });
	t.after(() => forgetSessionCwd("s-timing"));

	__test.setQuery(() => {
		const gen = (async function* () {
			yield { type: "system", subtype: "init", session_id: "cc-timing" };
			yield { type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: "msg_1", usage: {} } } };
			yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
			yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } };
			yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index: 0 } };
			yield { type: "result", subtype: "success", is_error: false, result: "ok", duration_ms: 900, duration_api_ms: 700 };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
	t.after(() => __test.setQuery(null));

	await providerConfig.streamSimple(providerConfig.models[0], { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [] }, { sessionId: "s-timing" }).result();

	const logPath = process.env.CLAUDE_BRIDGE_DEBUG_PATH;
	assert.ok(existsSync(logPath), "the bridge log was written");
	const lines = readFileSync(logPath, "utf8").split("\n").filter((line) => line.includes("timing:"));
	assert.equal(lines.length, 3, lines.join("\n"));
	assert.match(lines[0], /timing: query=q\d+ spawn→init=\d+ms$/);
	assert.match(lines[1], /timing: query=q\d+ first token=\d+ms$/);
	assert.match(lines[2], /timing: query=q\d+ result elapsed=\d+ms cc=900ms api=700ms$/);
	const ids = lines.map((line) => line.match(/query=(q\d+)/)[1]);
	assert.equal(new Set(ids).size, 1, "all three lines name the same query");
});
