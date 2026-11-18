/**
 * A tool call answered by another provider. Claude calls a tool and its Claude Code
 * query parks, an MCP handler waiting for the result. While the tool runs the user
 * switches pi to a model of another provider, so pi hands the result to that provider
 * and the conversation goes on there. The parked query never gets the result: the
 * watchdog leaves it alone (pi did receive the call), so it lived until
 * session_shutdown, and every later Claude prompt of that session saw a running query
 * and was treated as nested (reentrant). The next prompt now discards a parked query
 * whose call already has a result in pi's history, and runs as a top-level query.
 */
import { it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ctx } from "../src/query-state.js";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-moved-past-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const mod = await import("../src/index.js");
const { setQuery, resetSharedSession, activeQueryContexts } = mod.__test;
let providerConfig;
mod.default({ on: () => {}, registerProvider: (_name, config) => { providerConfig = config; }, registerTool: () => {} });
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

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
	ev({ type: "message_start", message: { id: `msg_${text}`, usage: { input_tokens: 10, output_tokens: 0 } } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } }),
	ev({ type: "message_stop" }),
	{ type: "result", subtype: "success", is_error: false, result: text },
];

let clock = 0;
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const toolResult = () => ({ role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "MARKER_OK" }], isError: false, timestamp: clock++ });
/** The answer the other provider gave after it got the tool result. */
const otherProviderAnswer = () => ({
	role: "assistant",
	content: [{ type: "text", text: "answered elsewhere" }],
	api: "openai-responses",
	provider: "openai",
	model: "gpt-5",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: clock++,
});
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];

/** Every query started, in order: its generator, whether close/interrupt reached it,
 *  its parked tool call (the MCP call Claude Code made, settled or not), and whether
 *  it ran on the top-level context. */
const queries = [];
const clients = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what) {
	for (let i = 0; i < 400; i++) { if (cond()) return; await sleep(5); }
	assert.fail(`timed out waiting for ${what}`);
}

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	queries.length = 0;
	setQuery(({ prompt, options }) => {
		const record = { closed: false, interrupted: false, toolCall: null, toolCallSettled: false, topLevel: null };
		queries.push(record);
		const first = queries.length === 1;
		let onClose;
		const killed = new Promise((r) => { onClose = r; });
		const gen = (async function* () {
			await prompt[Symbol.asyncIterator]().next();
			yield { type: "system", subtype: "init", session_id: `cc-moved-${queries.length}` };
			record.topLevel = ctx().activeQuery === gen;
			if (first) {
				for (const step of toolUse) yield step;
				// Claude Code calls the tool through the bridge's MCP server, as the CLI does.
				const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
				await options.mcpServers["custom-tools"].instance.connect(serverSide);
				const client = new Client({ name: "fake-cc", version: "1.0.0" });
				await client.connect(clientSide);
				clients.push(client);
				record.toolCall = client.callTool({ name: "read", arguments: { path: "a" }, _meta: { "claudecode/toolUseId": "toolu_1" } });
				record.toolCall.then(() => { record.toolCallSettled = true; }, () => { record.toolCallSettled = true; });
				await killed;
				return;
			}
			for (const step of answer("fresh")) yield step;
		})();
		gen.interrupt = async () => { record.interrupted = true; };
		gen.close = () => { record.closed = true; onClose(); };
		return gen;
	});
});
afterEach(async () => {
	for (const c of activeQueryContexts) {
		c.releasePendingToolCalls("test cleanup");
		c.activeQuery?.close?.();
	}
	activeQueryContexts.clear();
	for (const client of clients.splice(0)) await client.close().catch(() => {});
	setQuery(null);
});

/** Query 1 parks on toolu_1, its MCP handler waiting for the result. */
async function park(sid) {
	const ask = user("read a");
	const parked = await streamSimple(model, { messages: [ask], tools }, { sessionId: sid, signal: new AbortController().signal }).result();
	assert.equal(parked.stopReason, "toolUse");
	await until(() => ctx().pendingToolCalls.has("toolu_1"), "the MCP handler to park");
	const owner = ctx();
	return { ask, parked, owner };
}

it("discards a parked query whose tool call pi answered through another provider; the next prompt runs top-level", async () => {
	const { ask, parked, owner } = await park("pi-moved-past");
	const old = queries[0];

	const next = await streamSimple(model, { messages: [ask, parked, toolResult(), otherProviderAnswer(), user("next")], tools },
		{ sessionId: "pi-moved-past", signal: new AbortController().signal }).result();

	assert.ok(old.closed, "the parked Claude Code query was closed");
	assert.ok(old.interrupted, "and interrupted");
	await until(() => old.toolCallSettled, "the parked tool call to settle");
	const settled = await old.toolCall;
	assert.match(settled.content[0].text, /without this tool result/, "the parked handler was answered with the reason");
	assert.equal(owner.pendingToolCalls.size, 0, "no handler left waiting");
	assert.equal(queries.length, 2, "a new query was started");
	assert.equal(queries[1].topLevel, true, "the new query runs on the top-level context, not as a nested one");
	assert.equal(next.content.find((b) => b.type === "text")?.text, "fresh", "the new query answered");
	assert.equal(next.stopReason, "stop");
});

it("leaves a parked query alone when pi's history holds no result for its call", async () => {
	const { ask, parked, owner } = await park("pi-still-parked");
	const old = queries[0];
	const parkedQuery = owner.activeQuery;

	const nested = await streamSimple(model, { messages: [ask, parked, user("unrelated")], tools },
		{ sessionId: "pi-still-parked", signal: new AbortController().signal }).result();

	assert.equal(nested.content.find((b) => b.type === "text")?.text, "fresh", "the nested query answered");
	assert.equal(queries.length, 2);
	assert.equal(queries[1].topLevel, false, "it ran as a nested query, the parked one holding the top-level context");
	assert.ok(!old.closed && !old.interrupted, "the parked query was not killed");
	assert.ok(activeQueryContexts.has(owner), "the parked query still routes results");
	assert.equal(owner.activeQuery, parkedQuery);
	await sleep(20);
	assert.equal(old.toolCallSettled, false, "its handler still waits for the result");
	assert.ok(owner.pendingToolCalls.has("toolu_1"));
});
