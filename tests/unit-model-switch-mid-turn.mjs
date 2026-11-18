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
/** The effort and thinking options of each query started. */
const startedSettings = [];
const setModels = [];
/** applyFlagSettings calls, with the setModel count at the time. */
const flagSettings = [];
let flagDelayMs = 0;
let flagFails = false;
let release;
let release2;
let release3;
/** A query that makes a second tool call after the first result. */
let secondTool = false;
/** With secondTool, a query that makes a third tool call after the second result. */
let thirdTool = false;
/** The continuation pauses this long after its message_start (a slow first token). */
let pauseAfterStartMs = 0;
let setModelFails = false;
let setModelDelayMs = 5;
/** When set, setModel waits for it instead of setModelDelayMs (a test settles it). */
let setModelGate = null;
/** Results the bridge had handed the query when each setModel call was made. */
const resultsAtSwitch = [];
beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	started.length = 0;
	startedSettings.length = 0;
	setModels.length = 0;
	flagSettings.length = 0;
	flagDelayMs = 0;
	flagFails = false;
	setModelFails = false;
	setModelDelayMs = 5;
	setModelGate = null;
	secondTool = false;
	thirdTool = false;
	pauseAfterStartMs = 0;
	mod.__test.setSwitchModelWaitMs(null);
	resultsAtSwitch.length = 0;
	setQuery(({ prompt, options }) => {
		started.push(options.extraArgs?.model ?? options.model);
		startedSettings.push({ effort: options.effort, thinking: options.thinking });
		const gate = new Promise((r) => { release = r; });
		const gate2 = new Promise((r) => { release2 = r; });
		const gate3 = new Promise((r) => { release3 = r; });
		const twice = secondTool;
		const thrice = thirdTool;
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
					if (thrice) {
						for (const step of toolUse) yield JSON.parse(JSON.stringify(step).replaceAll("toolu_1", "toolu_3").replaceAll("msg_tool", "msg_tool_3"));
						if (await Promise.race([gate3, killed]) === "killed") return;
					}
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
			await (setModelGate ?? new Promise((r) => setTimeout(r, setModelDelayMs)));
			setModels.push(m);
			resultsAtSwitch.push(ctx().pendingResults.size);
			if (setModelFails) throw new Error("setModel refused");
		};
		gen.applyFlagSettings = async (settings) => { if (flagDelayMs) await new Promise((r) => setTimeout(r, flagDelayMs)); flagSettings.push({ settings, afterSetModels: setModels.length, resultsQueued: ctx().pendingResults.size }); if (flagFails) throw new Error("applyFlagSettings refused"); };
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

it("does not try a refused switch again at the next tool result of the same query; the next prompt switches", async () => {
	setModelFails = true;
	secondTool = true;
	const ask = user("read a");
	const parked = await streamSimple(first, { messages: [ask], tools }, { sessionId: "pi-refused-twice", signal: new AbortController().signal }).result();
	const continuation = streamSimple(second, { messages: [ask, parked, toolResult], tools }, { sessionId: "pi-refused-twice", signal: new AbortController().signal });
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_1"); i++) await new Promise((r) => setTimeout(r, 5));
	release();
	const parkedAgain = await continuation.result();
	assert.equal(parkedAgain.stopReason, "toolUse", "the query went on to a second tool call");
	assert.equal(setModels.length, 1, "the switch was attempted at the first tool result");

	const last = streamSimple(second, { messages: [ask, parked, toolResult, parkedAgain, secondResult], tools }, { sessionId: "pi-refused-twice", signal: new AbortController().signal });
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_2"); i++) await new Promise((r) => setTimeout(r, 5));
	release2();
	const continued = await last.result();
	assert.equal(setModels.length, 1, "the refused switch was not tried again");
	assert.equal(started.length, 1, "the result still went to the running query");
	assert.equal(continued.content.find((b) => b.type === "text")?.text, "continued", "the turn still continued");
	assert.equal(continued.model, first.id, "labeled with the model that served it");
	assert.equal(continued.provider, first.provider);

	const next = await streamSimple(second, { messages: [ask, parked, toolResult, parkedAgain, secondResult, continued, user("again")], tools },
		{ sessionId: "pi-refused-twice", signal: new AbortController().signal }).result();
	assert.equal(started.length, 2, "the next prompt opened a fresh query");
	assert.match(started[1], escape(second.id), "on the requested model");
	assert.equal(next.model, second.id);
});

it("remembers every model refused in the query: one refused earlier is not tried again after another refusal", async () => {
	setModelFails = true;
	secondTool = true;
	thirdTool = true;
	const [a, b, c] = [byId("claude-fable-5-2"), byId("claude-fable-5-1"), byId("claude-fable-5")];
	assert.ok(a && b && c, "the provider registers the three Fable models");
	const opts = { sessionId: "pi-refused-two", reasoning: "high", signal: new AbortController().signal };
	const ask = user("read a");
	const parked = await streamSimple(a, { messages: [ask], tools }, opts).result();
	const toB = streamSimple(b, { messages: [ask, parked, toolResult], tools }, opts);
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_1"); i++) await new Promise((r) => setTimeout(r, 5));
	release();
	const parked2 = await toB.result();
	const toC = streamSimple(c, { messages: [ask, parked, toolResult, parked2, secondResult], tools }, opts);
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_2"); i++) await new Promise((r) => setTimeout(r, 5));
	release2();
	const parked3 = await toC.result();
	assert.equal(parked3.stopReason, "toolUse", "the query went on to a third tool call");
	assert.equal(setModels.length, 2, "both switches were attempted");
	const thirdResult = { role: "toolResult", toolCallId: "toolu_3", toolName: "read", content: [{ type: "text", text: "MARKER_3" }], isError: false, timestamp: clock++ };
	const backToB = streamSimple(b, { messages: [ask, parked, toolResult, parked2, secondResult, parked3, thirdResult], tools }, opts);
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_3"); i++) await new Promise((r) => setTimeout(r, 5));
	release3();
	const continued = await backToB.result();
	assert.equal(setModels.length, 2, "the model refused first was not tried again");
	assert.equal(continued.content.find((blk) => blk.type === "text")?.text, "continued");
	assert.equal(continued.model, a.id, "labeled with the model that served it");
});

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

it("labels the continuation with the new model once setModel lands, even when the effort call outlasts the wait", async () => {
	mod.__test.setSwitchModelWaitMs(30);
	flagDelayMs = 150;
	const { continued } = await switchWith("pi-slow-effort", byId("claude-fable-5-2"), byId("claude-fable-5-1"), "high");
	assert.equal(setModels.length, 1, "the model switched before the results went in");
	assert.equal(continued.model, "claude-fable-5-1", "the new model served the continuation");
	await new Promise((r) => setTimeout(r, 200));
	assert.deepEqual(flagSettings.map((f) => f.settings), [{ effortLevel: "high" }], "the effort still went through");
});

/** Parks on `model` at pi reasoning `from`, then delivers the tool result on the same model at `to`. */
async function effortChange(sid, model, from, to) {
	const ask = user("read a");
	const parked = await streamSimple(model, { messages: [ask], tools }, { sessionId: sid, reasoning: from, signal: new AbortController().signal }).result();
	assert.equal(parked.stopReason, "toolUse");
	const continuation = streamSimple(model, { messages: [ask, parked, toolResult], tools }, { sessionId: sid, reasoning: to, signal: new AbortController().signal });
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_1"); i++) await new Promise((r) => setTimeout(r, 5));
	release();
	return { ask, parked, continued: await continuation.result() };
}

it("sets the new effort before the result when only the thinking level changes at a tool result", async () => {
	const opus = byId("claude-opus-5-5");
	const { continued } = await effortChange("pi-effort-only", opus, "high", "medium");
	assert.deepEqual(startedSettings.map((s) => s.effort), ["high"], "the query started at high");
	assert.deepEqual(setModels, [], "no model switch");
	assert.deepEqual(flagSettings, [{ settings: { effortLevel: "medium" }, afterSetModels: 0, resultsQueued: 0 }]);
	assert.equal(started.length, 1, "the result went to the running query");
	assert.equal(continued.content.find((b) => b.type === "text")?.text, "continued");
	assert.equal(continued.model, opus.id);
});

it("sets no effort when the thinking level at a tool result is the one the query serves", async () => {
	const { continued } = await effortChange("pi-effort-same", byId("claude-opus-5-5"), "high", "high");
	assert.deepEqual(setModels, []);
	assert.deepEqual(flagSettings, []);
	assert.equal(continued.content.find((b) => b.type === "text")?.text, "continued");
});

it("does not change the effort mid-turn when the new level turns thinking off; the next prompt does", async () => {
	// Haiku 5.5 can disable thinking, and a running query keeps the thinking it started with.
	const haiku = byId("claude-haiku-5-5");
	const { ask, parked, continued } = await effortChange("pi-effort-thinking", haiku, "high", undefined);
	assert.deepEqual(flagSettings, [], "nothing applied mid-turn");
	assert.deepEqual(setModels, []);
	assert.equal(continued.content.find((b) => b.type === "text")?.text, "continued");
	await streamSimple(haiku, { messages: [ask, parked, toolResult, continued, user("again")], tools },
		{ sessionId: "pi-effort-thinking", signal: new AbortController().signal }).result();
	assert.equal(started.length, 2, "the next prompt opened a fresh query");
	assert.deepEqual(startedSettings[1], { effort: undefined, thinking: { type: "disabled" } }, "with thinking off");
});

it("sets a changed effort once: the next tool result at the same level applies nothing", async () => {
	secondTool = true;
	const opus = byId("claude-opus-5-5");
	const ask = user("read a");
	const at = (reasoning) => ({ sessionId: "pi-effort-twice", reasoning, signal: new AbortController().signal });
	const parked = await streamSimple(opus, { messages: [ask], tools }, at("high")).result();
	const toMedium = streamSimple(opus, { messages: [ask, parked, toolResult], tools }, at("medium"));
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_1"); i++) await new Promise((r) => setTimeout(r, 5));
	release();
	const parkedAgain = await toMedium.result();
	assert.equal(parkedAgain.stopReason, "toolUse", "the query went on to a second tool call");
	const last = streamSimple(opus, { messages: [ask, parked, toolResult, parkedAgain, secondResult], tools }, at("medium"));
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_2"); i++) await new Promise((r) => setTimeout(r, 5));
	release2();
	const continued = await last.result();
	assert.equal(continued.content.find((b) => b.type === "text")?.text, "continued");
	assert.deepEqual(flagSettings.map((f) => f.settings), [{ effortLevel: "medium" }], "one effort change in total");
	assert.equal(started.length, 1);
});

it("does not set the effort computed for a model whose pending switch is then refused", async () => {
	// Haiku 5.5 to Opus 5.5 at "high" (same thinking settings); the switch outlasts the
	// wait and is refused, and pi asks Opus at "medium" at the next tool result.
	mod.__test.setSwitchModelWaitMs(20);
	let refuse;
	setModelGate = new Promise((r) => { refuse = r; });
	setModelFails = true;
	secondTool = true;
	const [haiku, opus] = [byId("claude-haiku-5-5"), byId("claude-opus-5-5")];
	const opts = (reasoning) => ({ sessionId: "pi-refused-then-effort", reasoning, signal: new AbortController().signal });
	const ask = user("read a");
	const parked = await streamSimple(haiku, { messages: [ask], tools }, opts("high")).result();
	const toOpus = streamSimple(opus, { messages: [ask, parked, toolResult], tools }, opts("high"));
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_1"); i++) await new Promise((r) => setTimeout(r, 5));
	release();
	const parked2 = await toOpus.result();
	const medium = streamSimple(opus, { messages: [ask, parked, toolResult, parked2, secondResult], tools }, opts("medium"));
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_2"); i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(setModels.length, 0, "the switch to Opus is still pending at the second tool result");
	refuse();
	for (let i = 0; i < 200 && setModels.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
	await new Promise((r) => setTimeout(r, 20)); // the chained effort change settles after the refusal
	release2();
	const continued = await medium.result();
	assert.equal(setModels.length, 1, "the switch was attempted once");
	assert.deepEqual(flagSettings, [], "no effort was set on the query still serving Haiku");
	assert.equal(continued.model, haiku.id, "labeled with the model that served it");
});

it("applies an effort requested behind a pending switch after the switch lands, so the newer effort wins", async () => {
	// Haiku 5.5 to Opus 5.5 at "high"; the switch outlasts the wait, pi asks Opus at
	// "medium" at the next tool result, and only then the switch lands.
	mod.__test.setSwitchModelWaitMs(20);
	let land;
	setModelGate = new Promise((r) => { land = r; });
	secondTool = true;
	const [haiku, opus] = [byId("claude-haiku-5-5"), byId("claude-opus-5-5")];
	const opts = (reasoning) => ({ sessionId: "pi-landed-then-effort", reasoning, signal: new AbortController().signal });
	const ask = user("read a");
	const parked = await streamSimple(haiku, { messages: [ask], tools }, opts("high")).result();
	const toOpus = streamSimple(opus, { messages: [ask, parked, toolResult], tools }, opts("high"));
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_1"); i++) await new Promise((r) => setTimeout(r, 5));
	release();
	const parked2 = await toOpus.result();
	const medium = streamSimple(opus, { messages: [ask, parked, toolResult, parked2, secondResult], tools }, opts("medium"));
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_2"); i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(setModels.length, 0, "the switch to Opus is still pending at the second tool result");
	land();
	for (let i = 0; i < 200 && flagSettings.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
	release2();
	const continued = await medium.result();
	assert.equal(setModels.length, 1, "the switch landed");
	assert.deepEqual(flagSettings.map((f) => f.settings.effortLevel), ["high", "medium"], "the switch's effort, then the newer one");
	assert.equal(continued.model, opus.id, "the new model served the rest of the turn");
});

it("does not try an effort refused on a model again when a switch comes back to that model", async () => {
	// Fable 5.2 at "high"; "medium" is refused on it at the first tool result. The query then
	// switches to Fable 5.1 and back to Fable 5.2, both at "medium".
	flagFails = true;
	secondTool = true;
	thirdTool = true;
	const [a, b] = [byId("claude-fable-5-2"), byId("claude-fable-5-1")];
	const at = (reasoning) => ({ sessionId: "pi-effort-refused-back", reasoning, signal: new AbortController().signal });
	const ask = user("read a");
	const parked = await streamSimple(a, { messages: [ask], tools }, at("high")).result();
	const deliver = async (model, messages, id, go) => {
		const s = streamSimple(model, { messages, tools }, at("medium"));
		for (let i = 0; i < 200 && !ctx().pendingResults.has(id); i++) await new Promise((r) => setTimeout(r, 5));
		go();
		return s.result();
	};
	const parked2 = await deliver(a, [ask, parked, toolResult], "toolu_1", () => release());
	const parked3 = await deliver(b, [ask, parked, toolResult, parked2, secondResult], "toolu_2", () => release2());
	const thirdResult = { role: "toolResult", toolCallId: "toolu_3", toolName: "read", content: [{ type: "text", text: "MARKER_3" }], isError: false, timestamp: clock++ };
	const continued = await deliver(a, [ask, parked, toolResult, parked2, secondResult, parked3, thirdResult], "toolu_3", () => release3());
	assert.equal(continued.content.find((blk) => blk.type === "text")?.text, "continued");
	assert.equal(setModels.length, 2, "switched to Fable 5.1 and back");
	assert.deepEqual(flagSettings.map((f) => [f.settings.effortLevel, f.afterSetModels]), [["medium", 0], ["medium", 1]],
		"medium was tried on Fable 5.2 and on Fable 5.1, not again on Fable 5.2");
});

it("does not try a refused effort again at the next tool result; the next prompt starts with it", async () => {
	flagFails = true;
	secondTool = true;
	const opus = byId("claude-opus-5-5");
	const ask = user("read a");
	const at = (reasoning) => ({ sessionId: "pi-effort-refused", reasoning, signal: new AbortController().signal });
	const parked = await streamSimple(opus, { messages: [ask], tools }, at("high")).result();
	const toMedium = streamSimple(opus, { messages: [ask, parked, toolResult], tools }, at("medium"));
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_1"); i++) await new Promise((r) => setTimeout(r, 5));
	release();
	const parkedAgain = await toMedium.result();
	const last = streamSimple(opus, { messages: [ask, parked, toolResult, parkedAgain, secondResult], tools }, at("medium"));
	for (let i = 0; i < 200 && !ctx().pendingResults.has("toolu_2"); i++) await new Promise((r) => setTimeout(r, 5));
	release2();
	const continued = await last.result();
	assert.equal(continued.content.find((b) => b.type === "text")?.text, "continued", "the turn still continued");
	assert.equal(flagSettings.length, 1, "the refused effort was not tried again");
	await streamSimple(opus, { messages: [ask, parked, toolResult, parkedAgain, secondResult, continued, user("again")], tools }, at("medium")).result();
	assert.equal(started.length, 2, "the next prompt opened a fresh query");
	assert.equal(startedSettings[1].effort, "medium");
});
