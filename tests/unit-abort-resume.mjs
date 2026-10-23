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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createSession, getSessionPath } from "cc-session-io";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-abort-resume-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const { __test } = await import("../src/index.js");
const { setQuery, getSharedSession, resetSharedSession, markRebuildForSession } = __test;

const mod = await import("../src/index.js");
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

// --- fake SDK query ---
// A step that is a function is awaited; close() releases a turn parked on
// `hang` so the aborted query ends the way a killed CLI does.
const calls = [];
const scripts = [];
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
		calls.push({ label: script.label, resume: options.resume });
		let release;
		const closed = new Promise((r) => { release = r; });
		const gen = (async function* () {
			for (const step of script.steps) {
				if (step === HANG) { await closed; continue; }
				yield options.resume && step.type === "system" ? { ...step, session_id: options.resume } : step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => release();
		return gen;
	});
});

afterEach(() => {
	setQuery(null);
});

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
async function completeThenAbort(P, turn2Messages, { ccWrote = "prompt", id = `cc-${P}` } = {}) {
	const first = turn2Messages[0].content, prompt = turn2Messages.at(-1).content;
	scripts.push({ label: "turn 1", steps: [init(id), result("first answer")] });
	await call(P, turn2Messages.slice(0, 1)).result();
	assert.equal(getSharedSession(P).sessionId, id);
	if (ccWrote === "before") ccWritesSession(id, [first]);

	const controller = new AbortController();
	scripts.push({ label: "turn 2", steps: [init(id), ...text("partial"), HANG, result("never")] });
	const turn2 = call(P, turn2Messages, controller.signal);
	await settle();
	controller.abort();
	const out = await turn2.result();
	assert.equal(out.stopReason, "aborted");
	await settle();
	if (ccWrote === "prompt") ccWritesSession(id, [first, prompt]);
}

const sessionFile = (id) => getSessionPath(id, process.cwd(), claudeDir);

describe("the turn after an abort", () => {
	it("resumes Claude Code's own session instead of rebuilding it", async () => {
		const P = "pi-abort-resume";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([{ type: "text", text: "partial" }]), u3 = user("next");
		await completeThenAbort(P, [u1, a1, u2]);
		pastSettleWindow(P);

		scripts.push({ label: "turn 3", steps: [init("cc-1"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		assert.equal(calls.at(-1).resume, `cc-${P}`, "the next prompt resumes the aborted turn's CC session");
		assert.doesNotMatch(readFileSync(sessionFile(`cc-${P}`), "utf8"), /first answer/, "CC's own file is resumed, not rewritten from pi's history");
		const state = getSharedSession(P);
		assert.equal(state.cursor, 5, "the cursor covers the aborted turn and the completed one after it");
		assert.equal(state.abortedAt, undefined, "the abort mark is consumed by the resume");
		assert.ok(!state.forceRotate, "nor is a later rebuild forced to rotate");
	});

	it("resumes when the aborted turn ended inside a tool call", async () => {
		const P = "pi-abort-tool";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("read a"), a2 = toolCall("toolu_1"), tr = toolResult("toolu_1"), u3 = user("next");
		await completeThenAbort(P, [u1, a1, u2]);
		pastSettleWindow(P);

		scripts.push({ label: "turn 3", steps: [init("cc-1"), result("ok")] });
		await call(P, [u1, a1, u2, a2, tr, u3]).result();

		assert.equal(calls.at(-1).resume, `cc-${P}`, "an aborted tool call and its result belong to the aborted turn");
		assert.equal(getSharedSession(P).cursor, 6);
	});

	it("rebuilds on a fresh session id when it starts while the killed CLI may still write", async () => {
		const P = "pi-abort-early";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), u3 = user("next");
		await completeThenAbort(P, [u1, a1, u2]);

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== `cc-${P}`, "inside the settle window the session is rotated, as before");
		assert.equal(existsSync(sessionFile(resumed)), true, "the rotated session is rebuilt from pi's history");
	});

	it("rebuilds when Claude Code never wrote the aborted session's file", async () => {
		const P = "pi-abort-no-file";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), u3 = user("next");
		await completeThenAbort(P, [u1, a1, u2], { ccWrote: "nothing", id: "cc-never-written" });
		pastSettleWindow(P);

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== "cc-never-written", "a resume would fail with no conversation to find, so pi's history is imported");
		assert.equal(existsSync(sessionFile(resumed)), true);
	});

	it("rebuilds when Claude Code was killed before writing the aborted prompt", async () => {
		const P = "pi-abort-prompt-lost";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("aborted at startup"), a2 = aborted([]), u3 = user("next");
		await completeThenAbort(P, [u1, a1, u2], { ccWrote: "before", id: "cc-prompt-lost" });
		pastSettleWindow(P);

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== "cc-prompt-lost", "resuming would drop a prompt pi's history shows, so the history is imported");
		assert.match(readFileSync(sessionFile(resumed), "utf8"), /aborted at startup/, "the rebuilt session carries the prompt");
	});

	it("rebuilds when pi rewrote the history after the abort", async () => {
		const P = "pi-abort-rewrite";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), u3 = user("next");
		await completeThenAbort(P, [u1, a1, u2]);
		pastSettleWindow(P);
		markRebuildForSession(P, "session_compact");

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== `cc-${P}`, "a rewrite still rebuilds, on a rotated id");
		assert.equal(existsSync(sessionFile(resumed)), true);
	});

	it("rebuilds when a user message after the abort point never reached Claude Code", async () => {
		const P = "pi-abort-missed-user";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), steer = user("queued steer"), a3 = say("x"), u3 = user("next");
		await completeThenAbort(P, [u1, a1, u2]);
		pastSettleWindow(P);

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, steer, a3, u3]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== `cc-${P}`, "CC's file lacks the steer, so pi's history is imported");
		assert.equal(existsSync(sessionFile(resumed)), true);
	});

	it("still resumes after a turn that completed normally", async () => {
		const P = "pi-normal";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("next");
		scripts.push({ label: "turn 1", steps: [init("cc-n"), result("first answer")] });
		await call(P, [u1]).result();
		scripts.push({ label: "turn 2", steps: [init("cc-n"), result("ok")] });
		await call(P, [u1, a1, u2]).result();
		assert.equal(calls.at(-1).resume, "cc-n");
		assert.equal(getSharedSession(P).abortedAt, undefined);
	});
});
