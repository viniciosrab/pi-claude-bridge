/**
 * After an aborted turn, the next prompt resumes Claude Code's own session file
 * instead of rebuilding it from pi's history.
 *
 * A rebuilt file lacks the context blocks CC writes at the head of its own
 * sessions, so the first request after a rebuild diverges at messages[0] and
 * re-caches the whole conversation (diag/AUDIT.md, "since CC 2.1.263"). Native
 * Claude Code resumes its own file after Esc, Ctrl-C or SIGTERM and reads the
 * cache back. These tests drive the provider with a mocked SDK query() and pin
 * which session the turn after an abort resumes, and when it must still rebuild.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createSession, getSessionPath } from "cc-session-io";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-shutdown-parked-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const { __test } = await import("../src/index.js");
const { deferUntilAbortSettles } = await import("../src/fork.js");
const { setQuery, getSharedSession, resetSharedSession, markRebuildForSession } = __test;

const mod = await import("../src/index.js");
let providerConfig; const handlers = {};
mod.default({
	on: (name, fn) => { (handlers[name] ??= []).push(fn); },
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

// --- fake SDK query ---
// A step that is a function is awaited; close() releases a turn parked on
// `hang` so the aborted query ends the way a killed CLI does. A script with a
// `cli` launches it as a real child through the spawnClaudeCodeProcess option
// the bridge passes, and close() ends its stdin as the SDK does, so the child
// stands in for the CLI's exit.
const calls = [];
const scripts = [];
const children = [];
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const ev = (event) => ({ type: "stream_event", event });
const text = (t) => [
	ev({ type: "message_start", message: { id: `msg_${t}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }),
];
const result = (t) => ({ type: "result", subtype: "success", is_error: false, result: t });
const HANG = Symbol("hang");

beforeEach(() => {
	resetSharedSession();
	calls.length = 0;
	scripts.length = 0;
	setQuery(({ options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		calls.push({ label: script.label, resume: options.resume, at: Date.now() });
		if (script.cli) {
			assert.equal(typeof options.spawnClaudeCodeProcess, "function", "the bridge launches the CLI through a spawner it can watch");
			script.proc = options.spawnClaudeCodeProcess({ command: process.execPath, args: ["-e", script.cli], env: { ...process.env, ...script.env }, signal: new AbortController().signal });
			children.push(script.proc);
		}
		let release;
		const closed = new Promise((r) => { release = r; });
		const gen = (async function* () {
			for (const step of script.steps) {
				if (step === HANG) { await closed; continue; }
				if (typeof step === "function") { await step(script); continue; }
				yield options.resume && step.type === "system" ? { ...step, session_id: options.resume } : step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => { script.proc?.stdin.end(); release(); };
		return gen;
	});
});

afterEach(() => {
	setQuery(null);
	for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

// Stand-ins for the aborted CLI. Each waits for the stdin EOF the SDK sends on close().
const CLI_EXITS = `process.stdin.on("end", () => process.exit(0)); process.stdin.resume();`;
// Exits LAG_MS after the EOF, first appending APPEND_LINE to APPEND_PATH when set:
// a CLI still writing its session file as it shuts down.
const CLI_LAGS = `process.stdin.on("end", () => setTimeout(() => {
	if (process.env.APPEND_PATH) require("node:fs").appendFileSync(process.env.APPEND_PATH, process.env.APPEND_LINE);
	process.exit(0);
}, Number(process.env.LAG_MS))); process.stdin.resume();`;
// Ignores the EOF and SIGTERM: alive until afterEach kills it.
const CLI_STUCK = `process.on("SIGTERM", () => {}); process.stdin.resume(); setInterval(() => {}, 1000);`;
const exited = (proc) => proc.exitCode !== null || proc.signalCode !== null;

// --- pi-side message builders ---
let clock = 0;
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const asst = (content, stopReason = "stop") => ({ role: "assistant", content, api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: clock++ });
const say = (t) => asst([{ type: "text", text: t }]);
const aborted = (content) => asst(content, "aborted");
const toolCall = (id) => asst([{ type: "toolCall", id, name: "read", arguments: { path: "a" } }], "aborted");
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "Operation aborted" }], isError: true, timestamp: clock++ });

const call = (sessionId, messages, signal) => streamSimple(model, { messages, tools: [] }, { sessionId, signal });
const settle = () => new Promise((r) => setTimeout(r, 20));
// The settle window guards against the killed CLI still writing; tests step past
// it by backdating the abort rather than sleeping.
const pastSettleWindow = (P) => { getSharedSession(P).abortedAt -= 60_000; };

/** The transcript the real CLI writes for its own session; the fake SDK writes none. */
const ccWritesSession = (id, prompts) => {
	const session = createSession({ sessionId: id, projectPath: process.cwd(), claudeDir });
	session.importMessages(prompts.map((content) => ({ role: "user", content })));
	session.save();
};

/** Turn 1 completes on CC session `id` (one per pi session, so files never
 *  carry over between tests); turn 2 is aborted mid-stream. `ccWrote`:
 *  "prompt" — CC wrote turn 2's prompt before the kill; "before" — CC had written
 *  only turn 1 (killed before recording turn 2's prompt); "nothing" — no file. */
async function completeThenAbort(P, turn2Messages, { ccWrote = "prompt", id = `cc-${P}`, cli, env } = {}) {
	const first = turn2Messages[0].content, prompt = turn2Messages.at(-1).content;
	scripts.push({ label: "turn 1", steps: [init(id), result("first answer")] });
	await call(P, turn2Messages.slice(0, 1)).result();
	assert.equal(getSharedSession(P).sessionId, id);
	if (ccWrote === "before") ccWritesSession(id, [first]);

	const controller = new AbortController();
	const script = { label: "turn 2", steps: [init(id), ...text("partial"), HANG, result("never")], cli, env };
	scripts.push(script);
	const turn2 = call(P, turn2Messages, controller.signal);
	await settle();
	controller.abort();
	const out = await turn2.result();
	assert.equal(out.stopReason, "aborted");
	await settle();
	if (ccWrote === "prompt") ccWritesSession(id, [first, prompt]);
	return script.proc;
}

// scratch port of upstream #210 checks
const toolUse = (id) => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const shutdown = (P) => { for (const fn of handlers.session_shutdown) fn({}, { sessionManager: { getSessionId: () => P } }); };
const mirrorFile = (P) => join(process.env.PI_CODING_AGENT_DIR, "claude-bridge-mirrors", `${encodeURIComponent(P)}.json`);
const reload = () => { resetSharedSession(); __test.activeQueryContexts.clear(); };

describe("session_shutdown (upstream #210 port)", () => {
	it("closes its own parked query (a terminate:true tool's) and leaves other sessions' alone", { timeout: 5000 }, async () => {
		const { QueryContext } = await import("../src/query-state.js");
		const park = (P) => {
			const events = [];
			const c = new QueryContext();
			c.activeQuery = { interrupt: async () => { events.push("interrupt"); }, close: () => { events.push("close"); } };
			c.piSessionId = P; c.turnToolCallIds = ["t"];
			c.pendingToolCalls.set("t", { toolName: "read", resolve: () => { events.push("release"); } });
			c.promptStream = { fail: () => { events.push("fail"); } };
			__test.activeQueryContexts.add(c);
			return events;
		};
		const mine = park("pi-mine"), other = park("pi-other");
		shutdown("pi-mine");
		assert.deepEqual([...__test.activeQueryContexts].map((c) => c.piSessionId), ["pi-other"]);
		assert.ok(mine.includes("close") && mine.includes("release"));
		assert.deepEqual(other, []);
		__test.activeQueryContexts.clear();
	});

	it("an abort followed at once by shutdown (/reload) keeps its mark and resumes CC's own session", { timeout: 8000 }, async () => {
		const P = "pi-shutdown-abort";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([{ type: "text", text: "partial" }]), u3 = user("next");
		const proc = await completeThenAbort(P, [u1, a1, u2], { cli: CLI_EXITS });
		shutdown(P);
		assert.equal(existsSync(mirrorFile(P)), true, "the abort mark is on disk after shutdown");
		assert.ok(JSON.parse(readFileSync(mirrorFile(P), "utf8")).abortedAt, "with the mark");
		if (!exited(proc)) await once(proc, "exit");
		reload();
		scripts.push({ label: "turn 3", steps: [init("cc-1"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();
		assert.equal(calls.at(-1).resume, `cc-${P}`);
	});
});
