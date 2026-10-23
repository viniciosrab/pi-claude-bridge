/**
 * A pi session continued in a new process (a new window, `pi --continue`, or
 * `/resume`) resumes the Claude Code session it was using instead of rebuilding
 * it from pi's history.
 *
 * The bridge keeps each pi session's CC session in memory, so a new process
 * started without one and rebuilt the whole conversation. A rebuilt file lacks
 * the context blocks CC writes at the head of its own sessions, so the first
 * request re-cached everything; native Claude Code's --resume reads the cache
 * back. These tests drive the provider with a mocked SDK query() and reset the
 * in-memory mirrors to stand in for a new process.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createSession, getSessionPath } from "cc-session-io";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-reopen-resume-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const { __test } = await import("../src/index.js");
const { setQuery, getSharedSession, resetSharedSession } = __test;

const mod = await import("../src/index.js");
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

const calls = [];
const scripts = [];
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const result = (t) => ({ type: "result", subtype: "success", is_error: false, result: t });
const ev = (event) => ({ type: "stream_event", event });
const toolUse = (id) => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; };

beforeEach(() => {
	resetSharedSession();
	calls.length = 0;
	scripts.length = 0;
	setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		calls.push({ label: script.label, resume: options.resume });
		const gen = (async function* () {
			// Like the CLI, read the prompt before answering.
			await prompt[Symbol.asyncIterator]().next();
			for (const step of script.steps) {
				if (typeof step === "function") { await step(); continue; }
				yield options.resume && step.type === "system" ? { ...step, session_id: options.resume } : step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});

afterEach(() => {
	setQuery(null);
});

let clock = 1_000;
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const say = (t) => ({ role: "assistant", content: [{ type: "text", text: t }], api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: clock++ });

const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const call = (sessionId, messages) => streamSimple(model, { messages, tools }, { sessionId });
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: clock++ });
const settle = () => new Promise((r) => setTimeout(r, 20));
/** The transcript the real CLI writes for its own session; the fake SDK writes none. */
const ccWritesSession = (id) => {
	const session = createSession({ sessionId: id, projectPath: process.cwd(), claudeDir });
	session.importMessages([{ role: "user", content: "written by claude code" }]);
	session.save();
};
const sessionFile = (id) => getSessionPath(id, process.cwd(), claudeDir);
const mirrorDir = () => join(process.env.PI_CODING_AGENT_DIR, "claude-bridge-mirrors");
/** A new pi process: no session mirror and no query in memory. */
const newProcess = () => { resetSharedSession(); __test.activeQueryContexts.clear(); };

/** One completed turn on CC session `id` in the first process. */
async function firstWindow(P, id, u1) {
	scripts.push({ label: "turn 1", steps: [init(id), result("first answer")] });
	await call(P, [u1]).result();
	assert.equal(getSharedSession(P).sessionId, id);
	ccWritesSession(id);
}

/** One completed turn that ran a tool round, on CC session `id`. */
async function toolTurn(P, id) {
	const u1 = user("read a");
	const g = gate();
	scripts.push({ label: "turn 1", steps: [init(id), ...toolUse("toolu_1"), g.wait, result("final answer")] });
	const parked = await call(P, [u1]).result();
	assert.equal(parked.stopReason, "toolUse");
	const tr = toolResult("toolu_1");
	const continued = call(P, [u1, parked, tr]);
	await settle();
	g.open();
	await continued.result();
	assert.equal(getSharedSession(P).cursor, 3, "the cursor covers the tool round");
	ccWritesSession(id);
	return { u1, parked, tr, final: say("final answer") };
}

describe("a pi session continued in a new process", () => {
	it("resumes the Claude Code session it was using", async () => {
		const P = "pi-reopen";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("next");
		await firstWindow(P, "cc-reopen", u1);
		newProcess();

		scripts.push({ label: "turn 2", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2]).result();

		assert.equal(calls.at(-1).resume, "cc-reopen", "the new window resumes CC's own session");
		assert.match(readFileSync(sessionFile("cc-reopen"), "utf8"), /written by claude code/, "CC's file is resumed, not rebuilt from pi's history");
	});

	it("rebuilds when pi's history no longer matches what Claude Code saw", async () => {
		const P = "pi-reopen-changed";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("next");
		await firstWindow(P, "cc-reopen-changed", u1);
		newProcess();

		const compacted = user("summary of the conversation so far");
		scripts.push({ label: "turn 2", steps: [init("cc-x"), result("ok")] });
		await call(P, [compacted, a1, u2]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== "cc-reopen-changed", "a different history is imported into a new session");
		assert.equal(existsSync(sessionFile(resumed)), true);
	});

	it("rebuilds when Claude Code's session file is gone", async () => {
		const P = "pi-reopen-no-file";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("next");
		await firstWindow(P, "cc-reopen-no-file", u1);
		rmSync(sessionFile("cc-reopen-no-file"));
		newProcess();

		scripts.push({ label: "turn 2", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== "cc-reopen-no-file", "with nothing to resume, pi's history is imported");
	});

	it("rebuilds when another running process still uses that session", async () => {
		const P = "pi-reopen-owned";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("next");
		await firstWindow(P, "cc-reopen-owned", u1);
		// The other window is still open: its pi process (our parent here) is alive.
		const file = join(mirrorDir(), readdirSync(mirrorDir()).find((f) => f.includes(P)));
		writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), pid: process.ppid }));
		newProcess();

		scripts.push({ label: "turn 2", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== "cc-reopen-owned", "two processes never share one CC session file");
	});

	it("resumes after a turn that ran tools", async () => {
		const P = "pi-reopen-tools";
		const { u1, parked, tr, final } = await toolTurn(P, "cc-reopen-tools");
		newProcess();

		scripts.push({ label: "turn 2", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, parked, tr, final, user("next")]).result();

		assert.equal(calls.at(-1).resume, "cc-reopen-tools");
	});

	it("rebuilds when the new window branched off inside a tool-using turn", async () => {
		const P = "pi-reopen-branch";
		const { u1, parked, tr } = await toolTurn(P, "cc-reopen-branch");
		newProcess();

		// /tree back to the tool result, then a new prompt: pi's history drops the
		// final answer CC's session still holds.
		scripts.push({ label: "turn 2", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, parked, tr, user("try something else")]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== "cc-reopen-branch", "a branch CC never saw is imported into a new session");
	});

	it("does not resume, even in the same process, a session whose last turn failed", async () => {
		const P = "pi-reopen-error";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("next");
		await firstWindow(P, "cc-reopen-error", u1);

		scripts.push({ label: "turn 2", steps: [init("cc-reopen-error"), async () => { throw new Error("API Error: 529 overloaded"); }] });
		await call(P, [u1, a1, u2]).result();
		assert.equal(getSharedSession(P), null, "upstream drops the mirror of a failed turn");

		scripts.push({ label: "retry", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== "cc-reopen-error", "the retry rebuilds rather than resume the failed attempt's session");
	});

	it("a new pi session still starts clean", async () => {
		mkdirSync(mirrorDir(), { recursive: true });
		scripts.push({ label: "turn 1", steps: [init("cc-fresh"), result("ok")] });
		await call("pi-fresh", [user("hello")]).result();
		assert.equal(calls.at(-1).resume, undefined);
	});
});
