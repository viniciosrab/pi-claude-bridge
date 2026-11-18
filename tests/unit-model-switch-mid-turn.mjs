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
import { ctx } from "../src/query-state.js";

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
const setModels = [];
/** applyFlagSettings calls, with the setModel count at the time. */
const flagSettings = [];
let release;
let release2;
/** A query that makes a second tool call after the first result. */
let secondTool = false;
/** The continuation pauses this long after its message_start (a slow first token). */
let pauseAfterStartMs = 0;
let setModelFails = false;
let setModelDelayMs = 5;
/** Results the bridge had handed the query when each setModel call was made. */
const resultsAtSwitch = [];
beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	started.length = 0;
	setModels.length = 0;
	flagSettings.length = 0;
	setModelFails = false;
	setModelDelayMs = 5;
	secondTool = false;
	pauseAfterStartMs = 0;
	mod.__test.setSwitchModelWaitMs(null);
	resultsAtSwitch.length = 0;
	setQuery(({ prompt, options }) => {
		started.push(options.extraArgs?.model ?? options.model);
		const gate = new Promise((r) => { release = r; });
		const gate2 = new Promise((r) => { release2 = r; });
		const twice = secondTool;
		let onClose;
		const killed = new Promise((r) => { onClose = () => r("killed"); });
		const fresh = started.length === 1;
		const gen = (async function* () {
			await prompt[Symbol.asyncIterator]().next();
			yield { type: "system", subtype: "init", session_id: "cc-switch" };
			if (fresh) {
				for (const step of toolUse) yield step;
				if (await Promise.race([gate, killed]) === "killed") return;
				if (twice) {
					for (const step of toolUse) yield JSON.parse(JSON.stringify(step).replaceAll("toolu_1", "toolu_2").replaceAll("msg_tool", "msg_tool_2"));
					if (await Promise.race([gate2, killed]) === "killed") return;
				}
				const [start, ...rest] = answer("continued");
				yield start;
				if (pauseAfterStartMs) await new Promise((r) => setTimeout(r, pauseAfterStartMs));
				for (const step of rest) yield step;
			} else {
				for (const step of answer("fresh")) yield step;
			}
		})();
		gen.setModel = async (m) => {
			await new Promise((r) => setTimeout(r, setModelDelayMs));
			setModels.push(m);
			resultsAtSwitch.push(ctx().pendingResults.size);
			if (setModelFails) throw new Error("setModel refused");
		};
		gen.applyFlagSettings = async (settings) => { flagSettings.push({ settings, afterSetModels: setModels.length, resultsQueued: ctx().pendingResults.size }); };
		gen.interrupt = async () => {};
		gen.close = () => onClose();
		return gen;
	});
});
afterEach(() => setQuery(null));

const escape = (id) => new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

async function switchAtToolResult(sid) {
	const ask = user("read a");
	const parked = await streamSimple(first, { messages: [ask], tools }, { sessionId: sid, signal: new AbortController().signal }).result();
	assert.equal(parked.stopReason, "toolUse");
	const continuation = streamSimple(second, { messages: [ask, parked, toolResult], tools }, { sessionId: sid, signal: new AbortController().signal });
	// Claude Code continues once the result reaches it; this fake has no MCP handler
	// waiting, so the bridge queues the result, and the fake goes on once it is there.
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_1"); i++) await new Promise((r) => setTimeout(r, 5));
	release();
	return { ask, parked, continued: await continuation.result() };
}

it("switches the running query to the model requested at a tool result, and labels the continuation with it", async () => {
	assert.ok(second && first.id !== second.id, "the provider registers two models");
	const { ask, parked, continued } = await switchAtToolResult("pi-switch");
	assert.equal(started.length, 1, "the result went to the running query, no rebuild");
	assert.equal(setModels.length, 1, "the running query was switched once");
	assert.match(setModels[0], escape(second.id), "to the requested model");
	assert.deepEqual(resultsAtSwitch, [0], "before the tool result reached the query");
	assert.equal(continued.content.find((b) => b.type === "text")?.text, "continued");
	assert.equal(continued.model, second.id, "labeled with the model that served it");
	assert.equal(continued.provider, second.provider);
	assert.equal(continued.api, second.api);

	// The query now runs on the second model: the next prompt switches nothing.
	const next = await streamSimple(second, { messages: [ask, parked, toolResult, continued, user("again")], tools },
		{ sessionId: "pi-switch", signal: new AbortController().signal }).result();
	assert.equal(next.model, second.id);
	assert.equal(setModels.length, 1);
});

it("keeps the served model's label when Claude Code refuses the switch; the next prompt switches", async () => {
	setModelFails = true;
	const { ask, parked, continued } = await switchAtToolResult("pi-refused");
	assert.equal(setModels.length, 1, "the switch was attempted");
	assert.equal(started.length, 1, "the result still went to the running query");
	assert.equal(continued.content.find((b) => b.type === "text")?.text, "continued", "the turn still continued");
	assert.equal(continued.model, first.id, "labeled with the model that served it");
	assert.equal(continued.provider, first.provider);
	assert.equal(continued.api, first.api);

	const next = await streamSimple(second, { messages: [ask, parked, toolResult, continued, user("again")], tools },
		{ sessionId: "pi-refused", signal: new AbortController().signal }).result();
	assert.equal(started.length, 2, "the next prompt opened a fresh query");
	assert.match(started[1], escape(second.id), "on the requested model");
	assert.equal(next.model, second.id);
});

it("does not switch when the model requested at a tool result is the one serving", async () => {
	const ask = user("read a");
	const parked = await streamSimple(first, { messages: [ask], tools }, { sessionId: "pi-same", signal: new AbortController().signal }).result();
	const continuation = streamSimple(first, { messages: [ask, parked, toolResult], tools }, { sessionId: "pi-same", signal: new AbortController().signal });
	release();
	const continued = await continuation.result();
	assert.equal(continued.model, first.id);
	assert.deepEqual(setModels, []);
});

it("delivers the tool result when the switch outlasts the wait, so a slow switch never holds the turn", async () => {
	mod.__test.setSwitchModelWaitMs(20);
	setModelDelayMs = 300;
	const started = Date.now();
	const { continued } = await switchAtToolResult("pi-slow-switch");
	assert.ok(Date.now() - started < 250, "the result waited for the switch past the bound");
	assert.equal(continued.content.find((b) => b.type === "text")?.text, "continued");
	assert.equal(continued.model, first.id, "labeled with the model that served it while the switch was pending");
	assert.deepEqual(setModels, [], "the switch had not landed");
	await new Promise((r) => setTimeout(r, 350));
	assert.equal(setModels.length, 1, "the switch still went through");
	assert.equal(continued.model, first.id, "a switch landing after the turn ended does not relabel the message pi recorded");
	assert.equal(continued.provider, first.provider);
});

it("drops tool results held by a switch when their query ended meanwhile, so they never reach the next query", async () => {
	mod.__test.setSwitchModelWaitMs(1_000);
	setModelDelayMs = 100;
	const ask = user("read a");
	const parked = await streamSimple(first, { messages: [ask], tools }, { sessionId: "pi-ended", signal: new AbortController().signal }).result();
	const controller = new AbortController();
	const continuation = streamSimple(second, { messages: [ask, parked, toolResult], tools }, { sessionId: "pi-ended", signal: controller.signal });
	controller.abort();
	await continuation.result();
	release();
	await new Promise((r) => setTimeout(r, 20)); // the aborted query's teardown
	const next = streamSimple(second, { messages: [ask, parked, toolResult, user("again")], tools }, { sessionId: "pi-ended", signal: new AbortController().signal });
	await new Promise((r) => setTimeout(r, 150)); // the switch settles
	assert.ok(!ctx().pendingResults.has("toolu_1"), "the ended query's result reached the next query");
	await next.result();
});

/** A switch at the first tool result that outlasts the wait, the query going on to a
 *  second tool call before it lands. */
async function slowSwitchThenSecondTool(sid) {
	mod.__test.setSwitchModelWaitMs(20);
	setModelDelayMs = 150;
	secondTool = true;
	const ask = user("read a");
	const parked = await streamSimple(first, { messages: [ask], tools }, { sessionId: sid, signal: new AbortController().signal }).result();
	const continuation = streamSimple(second, { messages: [ask, parked, toolResult], tools }, { sessionId: sid, signal: new AbortController().signal });
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_1"); i++) await new Promise((r) => setTimeout(r, 5));
	release();
	const parkedAgain = await continuation.result();
	assert.equal(parkedAgain.stopReason, "toolUse", "the query went on to a second tool call");
	return { ask, parked, parkedAgain };
}
const secondResult = { role: "toolResult", toolCallId: "toolu_2", toolName: "read", content: [{ type: "text", text: "MARKER_2" }], isError: false, timestamp: clock++ };

it("a switch landing while the query is parked on a later tool call does not relabel the message pi recorded", async () => {
	const { parkedAgain } = await slowSwitchThenSecondTool("pi-late-label");
	assert.deepEqual(setModels, [], "the response streamed before the switch landed");
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(setModels.length, 1, "the switch landed");
	assert.equal(parkedAgain.model, first.id, "the old model served that response");
	assert.equal(parkedAgain.provider, first.provider);
	release2();
	await new Promise((r) => setTimeout(r, 20)); // the query ends before the next test
});

it("a model requested again while a switch is still pending is switched to, not lost", async () => {
	const { ask, parked, parkedAgain } = await slowSwitchThenSecondTool("pi-back");
	// pi goes back to the first model while the switch to the second is still in flight.
	const back = streamSimple(first, { messages: [ask, parked, toolResult, parkedAgain, secondResult], tools }, { sessionId: "pi-back", signal: new AbortController().signal });
	await new Promise((r) => setTimeout(r, 400)); // both switches settle
	release2();
	const done = await back.result();
	assert.equal(setModels.length, 2, "the request at the second boundary was sent");
	assert.match(setModels[0], escape(second.id));
	assert.match(setModels[1], escape(first.id));
	assert.equal(done.model, first.id, "the last request won");
});

it("a switch landing after the old model's response started, before its first block, does not relabel it", async () => {
	mod.__test.setSwitchModelWaitMs(20);
	setModelDelayMs = 100;
	pauseAfterStartMs = 250;
	const { continued } = await switchAtToolResult("pi-started");
	assert.equal(setModels.length, 1, "the switch landed during the response");
	assert.equal(continued.content.find((b) => b.type === "text")?.text, "continued");
	assert.equal(continued.model, first.id, "the old model served the response it had started");
	assert.equal(continued.provider, first.provider);
});

const byId = (id) => providerConfig.models.find((m) => m.id === id);

/** Parks on `from`, then delivers the tool result under `to`, both at pi reasoning `reasoning`. */
async function switchWith(sid, from, to, reasoning) {
	const ask = user("read a");
	const parked = await streamSimple(from, { messages: [ask], tools }, { sessionId: sid, reasoning, signal: new AbortController().signal }).result();
	const continuation = streamSimple(to, { messages: [ask, parked, toolResult], tools }, { sessionId: sid, reasoning, signal: new AbortController().signal });
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_1"); i++) await new Promise((r) => setTimeout(r, 5));
	release();
	return { ask, parked, continued: await continuation.result() };
}

it("sets the effort the bridge computes for the new model, after the switch and before the result", async () => {
	const { continued } = await switchWith("pi-effort", byId("claude-fable-5-2"), byId("claude-fable-5-1"), "high");
	assert.equal(setModels.length, 1);
	assert.deepEqual(flagSettings, [{ settings: { effortLevel: "high" }, afterSetModels: 1, resultsQueued: 0 }]);
	assert.equal(continued.model, "claude-fable-5-1");
});

it("restores the new model's default effort when the bridge computes none for it", async () => {
	// Thinking off: Fable always thinks (no "off"), so the bridge sends no effort and no thinking config.
	const { continued } = await switchWith("pi-no-effort", byId("claude-fable-5-2"), byId("claude-fable-5-1"), undefined);
	assert.equal(setModels.length, 1);
	assert.deepEqual(flagSettings.map((f) => f.settings), [{ effortLevel: null }]);
	assert.equal(continued.model, "claude-fable-5-1");
});

it("does not switch mid-turn when the new model needs other thinking settings; the next prompt does", async () => {
	// Thinking off: Haiku 5.5 runs with thinking disabled, Opus 5.5 cannot disable it, and
	// a running query keeps the thinking it started with.
	const haiku = byId("claude-haiku-5-5");
	const opus = byId("claude-opus-5-5");
	const { ask, parked, continued } = await switchWith("pi-thinking", haiku, opus, undefined);
	assert.deepEqual(setModels, [], "no switch");
	assert.deepEqual(flagSettings, []);
	assert.equal(continued.model, haiku.id, "labeled with the model that served it");
	const next = await streamSimple(opus, { messages: [ask, parked, toolResult, continued, user("again")], tools },
		{ sessionId: "pi-thinking", signal: new AbortController().signal }).result();
	assert.equal(started.length, 2, "the next prompt opened a fresh query");
	assert.match(started[1], escape(opus.id));
	assert.equal(next.model, opus.id);
});
