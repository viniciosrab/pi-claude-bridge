/**
 * Upstream #273: pi switches the model at a tool-result boundary (a `/model` while a
 * tool runs, or a router picking a stronger model after the first results). The
 * result goes to the Claude Code query already running, which keeps the model it was
 * started with, so the continuation is served by that model. The bridge labeled it
 * with the newly requested one, misattributing the answer. The switch
 * takes effect at the next prompt, which opens a fresh query.
 */
import { it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-model-switch-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const mod = await import("../src/index.js");
const { setQuery, resetSharedSession, activeQueryContexts } = mod.__test;
let providerConfig;
mod.default({ on: () => {}, registerProvider: (_name, config) => { providerConfig = config; }, registerTool: () => {} });
const streamSimple = providerConfig.streamSimple;
const [first, second] = providerConfig.models.filter((m, i, all) => all.findIndex((o) => o.id === m.id) === i);

const ev = (event) => ({ type: "stream_event", event });
const toolUse = [
	ev({ type: "message_start", message: { id: "msg_tool", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const answer = (text) => [
	ev({ type: "message_start", message: { id: `msg_${text}`, usage: { input_tokens: 1000, output_tokens: 0 } } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1000 } }),
	ev({ type: "message_stop" }),
	{ type: "result", subtype: "success", is_error: false, result: text },
];

let clock = 0;
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const toolResult = { role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "MARKER_OK" }], isError: false, timestamp: clock++ };
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];

const started = [];
let release;
beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	started.length = 0;
	setQuery(({ prompt, options }) => {
		started.push(options.extraArgs?.model ?? options.model);
		const gate = new Promise((r) => { release = r; });
		const fresh = started.length === 1;
		const gen = (async function* () {
			await prompt[Symbol.asyncIterator]().next();
			yield { type: "system", subtype: "init", session_id: "cc-switch" };
			if (fresh) {
				for (const step of toolUse) yield step;
				await gate;
				for (const step of answer("continued")) yield step;
			} else {
				for (const step of answer("fresh")) yield step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});
afterEach(() => setQuery(null));

it("labels a tool-result continuation with the model that served it; the next prompt switches", async () => {
	assert.ok(second && first.id !== second.id, "the provider registers two models");
	const ask = user("read a");
	const parked = await streamSimple(first, { messages: [ask], tools }, { sessionId: "pi-switch", signal: new AbortController().signal }).result();
	assert.equal(parked.stopReason, "toolUse");

	const continuation = streamSimple(second, { messages: [ask, parked, toolResult], tools }, { sessionId: "pi-switch", signal: new AbortController().signal });
	release();
	const continued = await continuation.result();
	assert.equal(started.length, 1, "the result went to the running query");
	assert.equal(continued.content.find((b) => b.type === "text")?.text, "continued");
	assert.equal(continued.model, first.id, "labeled with the model that served it");
	assert.equal(continued.provider, first.provider);
	assert.equal(continued.api, first.api);

	const next = await streamSimple(second, { messages: [ask, parked, toolResult, continued, user("again")], tools },
		{ sessionId: "pi-switch", signal: new AbortController().signal }).result();
	assert.equal(started.length, 2, "the next prompt opened a fresh query");
	assert.match(started[1], new RegExp(second.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "on the requested model");
	assert.equal(next.model, second.id);
});
