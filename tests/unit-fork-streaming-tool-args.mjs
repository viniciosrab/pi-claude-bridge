/**
 * fork: streaming tool args (src/fork-stream-args.ts). Tool call arguments stream
 * into pi as they arrive. Upstream parses each input_json_delta with JSON.parse, which
 * rejects every prefix of an object, so the call's arguments stayed `{}` until
 * the last delta closed the JSON: pi showed a bare `$` or `edit` row on
 * "Working" and then the whole call at once. pi's own Anthropic provider parses
 * the prefix, so the command grows as it streams.
 *
 * Only the display may see a prefix. The arguments pi runs come from the whole
 * input at content_block_stop, and a prefix must never become them.
 *
 * With pi-ai's ToolCallArgumentsStream (pi-ai 1.5+) each delta is parsed once
 * instead of the whole text on every delta. Every case runs without it and with
 * a double of it, and with pi-ai's own class when the installed pi-ai has one.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseStreamingJson } from "@earendil-works/pi-ai";
import { QueryContext } from "../src/query-state.js";
import { setToolCallArgumentsStreamForTests } from "../src/fork-stream-args.js";

const { __test } = await import("../src/index.js");

/** ToolCallArgumentsStream's surface (append/text/finish), recording each append. */
class RecordingArgumentsStream {
	static appends = [];
	#text = "";
	get text() { return this.#text; }
	append(delta) {
		RecordingArgumentsStream.appends.push(delta);
		this.#text += delta;
		const value = parseStreamingJson(this.#text);
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	}
	finish() {
		try { return { arguments: JSON.parse(this.#text) }; } catch (e) { return { arguments: {}, argumentsError: String(e) }; }
	}
}

const detected = setToolCallArgumentsStreamForTests(undefined);
setToolCallArgumentsStreamForTests(detected);
const modes = [
	["without ToolCallArgumentsStream", undefined],
	["with an incremental arguments stream", RecordingArgumentsStream],
	...(detected ? [["with pi-ai's ToolCallArgumentsStream", detected]] : []),
];

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
const toolMap = new Map([["mcp__custom-tools__run_script", "run_script"]]);

// `partial` is the live turn output, mutated after each push: copy the tool call's
// arguments as they were when the event went out.
function fakeStream() {
	const events = [];
	const push = (e) => {
		const call = e.partial?.content?.[e.contentIndex];
		events.push({
			type: e.type,
			arguments: call?.type === "toolCall" ? structuredClone(call.arguments) : undefined,
			partialJson: call?.type === "toolCall" ? call.partialJson : undefined,
			toolCall: e.toolCall && structuredClone(e.toolCall),
		});
	};
	return { events, push, end: () => events.push({ type: "end" }) };
}

function makeCtx() {
	const c = new QueryContext();
	c.currentPiStream = fakeStream();
	c.resetTurnState(fakeModel);
	return c;
}

async function consume(c, messages) {
	async function* gen() { for (const m of messages) yield m; }
	await __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c);
}

const streamEvent = (event) => ({ type: "stream_event", event });

const toolCall = (deltas) => [
	streamEvent({ type: "message_start", message: { id: "msg_1" } }),
	streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "mcp__custom-tools__run_script", id: "toolu_1", input: {} } }),
	...deltas.map((partial_json) => streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } })),
	streamEvent({ type: "content_block_stop", index: 0 }),
	streamEvent({ type: "message_stop" }),
];

for (const [mode, argumentsStream] of modes) describe(`a streaming tool call's arguments, ${mode}`, () => {
	before(() => setToolCallArgumentsStreamForTests(argumentsStream));
	after(() => setToolCallArgumentsStreamForTests(detected));

	it("grow with each delta instead of staying empty until the JSON closes", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		await consume(c, toolCall(['{"command":"cd /ho', 'me/x; pnpm test', '"}']));

		assert.deepStrictEqual(stream.events.filter((e) => e.type === "toolcall_delta").map((e) => e.arguments), [
			{ command: "cd /ho" },
			{ command: "cd /home/x; pnpm test" },
			{ command: "cd /home/x; pnpm test" },
		]);
		const end = stream.events.find((e) => e.type === "toolcall_end");
		assert.deepStrictEqual(end.toolCall.arguments, { command: "cd /home/x; pnpm test" });
		assert.deepStrictEqual(c.turnOutput.content.map((b) => [b.type, b.id, b.arguments]), [["toolCall", "toolu_1", { command: "cd /home/x; pnpm test" }]]);
		assert.strictEqual(c.turnOutput.stopReason, "toolUse");
	});

	it("never run a streamed prefix when the closed input is not valid JSON", async () => {
		const c = makeCtx();
		const stream = c.currentPiStream;
		await consume(c, toolCall(['{"command":"rm -rf /tmp/build', ' && echo done']));

		const end = stream.events.find((e) => e.type === "toolcall_end");
		assert.deepStrictEqual(end.toolCall.arguments, {});
		assert.deepStrictEqual(c.turnOutput.content.map((b) => [b.type, b.arguments]), [["toolCall", {}]]);
	});

	it("never run a first delta that was complete JSON when a later delta breaks it", async () => {
		// The first delta parses on its own, so upstream's parse has replaced the
		// arguments before the fork's display hook runs; the fallback must still be
		// the content_block_start input, not that parsed prefix.
		const c = makeCtx();
		const stream = c.currentPiStream;
		await consume(c, toolCall(['{"command":"rm"}', ' && echo done']));

		const end = stream.events.find((e) => e.type === "toolcall_end");
		assert.deepStrictEqual(end.toolCall.arguments, {});
		assert.deepStrictEqual(c.turnOutput.content.map((b) => [b.type, b.arguments]), [["toolCall", {}]]);
	});
});

describe("a streaming tool call with an incremental arguments stream", () => {
	before(() => setToolCallArgumentsStreamForTests(RecordingArgumentsStream));
	after(() => setToolCallArgumentsStreamForTests(detected));

	it("parses each delta once instead of the whole text on every delta", async () => {
		RecordingArgumentsStream.appends = [];
		const c = makeCtx();
		const stream = c.currentPiStream;
		const deltas = ['{"path":"a.ts",', '"content":"const x', ' = 1;\\n', 'export {x};"}'];
		await consume(c, toolCall(deltas));

		// Only the new text reaches the stream, once per delta.
		assert.deepStrictEqual(RecordingArgumentsStream.appends, deltas);
		const partials = stream.events.filter((e) => e.type === "toolcall_delta");
		assert.deepStrictEqual(partials.map((e) => e.arguments), [
			{ path: "a.ts" },
			{ path: "a.ts", content: "const x" },
			{ path: "a.ts", content: "const x = 1;\n" },
			{ path: "a.ts", content: "const x = 1;\nexport {x};" },
		]);
		// Upstream's JSON.parse of partialJson sees nothing to parse while the call streams.
		assert.deepStrictEqual(partials.map((e) => e.partialJson), ["", "", "", ""]);
		const end = stream.events.find((e) => e.type === "toolcall_end");
		assert.deepStrictEqual(end.toolCall.arguments, { path: "a.ts", content: "const x = 1;\nexport {x};" });
		assert.strictEqual(end.toolCall.partialJson, undefined);
	});
});
