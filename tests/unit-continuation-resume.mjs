/**
 * A pi turn that goes on at a tool result with no query parked on it (a history
 * rewritten mid-turn, a restart, a discarded query) continues through Claude
 * Code's own interrupted-turn resume (upstream #274).
 *
 * Written as a user message on stdin, the continue text follows the tool result,
 * CC sees two user records in a row and inserts its <synthetic> assistant "No
 * response requested." between them, which the model sometimes takes as its own
 * finished answer. The bridge instead hands CC the continue text in its
 * environment, writes nothing on stdin, and resumes a file that ends at the tool
 * result. If CC shows no sign of working on the turn, the old prompt is written
 * after all, so the turn never hangs. tests/int-cc-contracts.mjs pins the CC side.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionPath } from "cc-session-io";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-continuation-resume-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const mod = await import("../src/index.js");
const { ctx } = await import("../src/query-state.js");
const { setQuery, resetSharedSession, activeQueryContexts, getSharedSession, discardRewrittenQuery } = mod.__test;
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

const FALLBACK_MS = 60;
const CONTINUE_AFTER_RESUME = "[Your session was interrupted and resumed. What precedes this ends with the tool result "
	+ "you were waiting for. Continue the task from there.]";

// --- fake SDK query ---
// Records what the bridge hands CC (env, resume) and everything written on its
// stdin, read in the background as CC does. A function step is awaited with the
// call; close() (the bridge's kill) releases a step parked on `killed`.
const calls = [];
const scripts = [];
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const ev = (event) => ({ type: "stream_event", event });
const text = (t) => [
	ev({ type: "message_start", message: { id: `msg_${t}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const result = (t) => ({ type: "result", subtype: "success", is_error: false, result: t });
const errorResult = (t) => ({ type: "result", subtype: "error_during_execution", is_error: true, errors: [t] });

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	calls.length = 0;
	scripts.length = 0;
	ctx().continuationFallbackMs = FALLBACK_MS;
	setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		let gotStdin;
		const call = { label: script.label, resume: options.resume, cwd: options.cwd, env: options.env, stdin: [], at: Date.now() };
		call.firstStdin = new Promise((r) => { gotStdin = r; });
		calls.push(call);
		void (async () => {
			try {
				for await (const m of prompt) { call.stdin.push(m.message.content[0].text); call.stdinAt ??= Date.now(); gotStdin(); }
			} catch {}
		})();
		let closed = false, onClose;
		call.killed = new Promise((r) => { onClose = r; });
		const gen = (async function* () {
			for (const step of script.steps) {
				if (closed) return;
				if (typeof step === "function") { await step(call); continue; }
				yield options.resume && step.type === "system" && step.subtype === "init" ? { ...step, session_id: options.resume } : step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => { closed = true; onClose(); };
		return gen;
	});
});

afterEach(() => setQuery(null));

// --- pi-side message builders ---
let clock = 0;
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const toolCall = (id) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
	api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse", timestamp: clock++ });
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: clock++ });
const atToolResult = (id) => [user("read a"), toolCall(id), toolResult(id)];
const replyText = (message) => message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (sessionId, messages, signal) => streamSimple(model, { messages, tools: [] }, { sessionId, signal });

/** The records of CC session `id`'s file, in order. */
const records = (id, cwd) => readFileSync(getSessionPath(id, cwd, claudeDir), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
/** What the real CLI appends while it runs a continuation: the continue text as a meta
 *  user record (a user record when it came on stdin), then the start of its answer.
 *  The fake SDK writes nothing itself. */
const ccRunsTurn = (c) => {
	const path = getSessionPath(c.resume, c.cwd, claudeDir);
	const last = records(c.resume, c.cwd).at(-1);
	appendFileSync(path, `${JSON.stringify({ type: "user", isMeta: true, uuid: "meta-1", parentUuid: last.uuid, sessionId: c.resume, message: { role: "user", content: CONTINUE_AFTER_RESUME } })}\n`);
	appendFileSync(path, `${JSON.stringify({ type: "assistant", uuid: "asst-1", parentUuid: "meta-1", sessionId: c.resume, message: { role: "assistant", content: [{ type: "text", text: "partial" }] } })}\n`);
};
const endsAtToolResult = (c) => {
	const last = records(c.resume, c.cwd).at(-1);
	assert.equal(last.type, "user", `the resumed file ends at ${last.type}, not the tool result`);
	assert.ok(Array.isArray(last.message.content) && last.message.content.some((b) => b.type === "tool_result"),
		"the resumed file's last record is the tool result");
};

describe("continuation at a tool result with no parked query (upstream #274)", () => {
	it("writes the old continue prompt when Claude Code stays silent past the fallback, and the turn completes", async () => {
		scripts.push({ label: "silent", steps: [init("cc-silent"), (c) => c.firstStdin, ...text("answer"), result("answer")] });
		const reply = await call("pi-silent", atToolResult("toolu_1")).result();

		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].stdin, [CONTINUE_AFTER_RESUME], "the fallback wrote the continue prompt, once");
		assert.ok(calls[0].stdinAt - calls[0].at >= FALLBACK_MS - 5, `written ${calls[0].stdinAt - calls[0].at} ms in, not after the fallback window`);
		assert.equal(replyText(reply), "answer");
		assert.equal(reply.stopReason, "stop");
	});

	it("writes nothing on stdin when Claude Code answers before the fallback", async () => {
		scripts.push({ label: "answers", steps: [init("cc-answers"), ...text("answer"), result("answer")] });
		const reply = await call("pi-answers", atToolResult("toolu_2")).result();
		await sleep(FALLBACK_MS * 3);

		assert.equal(replyText(reply), "answer");
		assert.deepEqual(calls[0].stdin, []);
	});

	it("writes nothing on stdin when Claude Code works on the turn past the fallback before answering", async () => {
		// A first stream event counts as the turn started; a long answer is not a silent CC.
		const [start, ...rest] = text("slow answer");
		scripts.push({ label: "slow", steps: [init("cc-slow"), start, () => sleep(FALLBACK_MS * 3), ...rest, result("slow answer")] });
		const reply = await call("pi-slow", atToolResult("toolu_3")).result();

		assert.equal(replyText(reply), "slow answer");
		assert.deepEqual(calls[0].stdin, []);
	});

	for (const [what, signal] of [
		["system status requesting", { type: "system", subtype: "status", status: "requesting" }],
		["system status compacting", { type: "system", subtype: "status", status: "compacting" }],
		["session state running", { type: "system", subtype: "session_state_changed", state: "running" }],
	]) {
		it(`writes nothing on stdin when Claude Code reports ${what} and its first stream event comes after the fallback`, async () => {
			// CC 2.1.327 emits status "requesting" right before the API call of the turn it
			// resumes; a slow first response (a cold cache on a long history) is not a silent CC.
			scripts.push({ label: "slow-start", steps: [init("cc-slow-start"), signal, () => sleep(FALLBACK_MS * 3), ...text("late answer"), result("late answer")] });
			const reply = await call(`pi-slow-${what.replaceAll(" ", "-")}`, atToolResult("toolu_3b")).result();

			assert.equal(replyText(reply), "late answer");
			assert.deepEqual(calls[0].stdin, []);
		});
	}

	it("still writes the continue prompt when Claude Code reports only an idle state", async () => {
		scripts.push({ label: "idle", steps: [{ type: "system", subtype: "session_state_changed", state: "idle" }, { type: "system", subtype: "status", status: null },
			(c) => c.firstStdin, init("cc-idle"), ...text("after prompt"), result("after prompt")] });
		const reply = await call("pi-idle", atToolResult("toolu_3c")).result();

		assert.equal(replyText(reply), "after prompt");
		assert.deepEqual(calls[0].stdin, [CONTINUE_AFTER_RESUME]);
	});

	it("an ordinary prompt never carries the resume variables, even when pi's environment has them", async () => {
		const saved = { turn: process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, prompt: process.env.CLAUDE_CODE_RESUME_PROMPT };
		process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = "1";
		process.env.CLAUDE_CODE_RESUME_PROMPT = "inherited";
		try {
			scripts.push({ label: "prompt", steps: [init("cc-prompt"), ...text("hi"), result("hi")] });
			await call("pi-prompt", [user("hello")]).result();
			scripts.push({ label: "continuation", steps: [init("cc-continued"), ...text("ok"), result("ok")] });
			await call("pi-continued", atToolResult("toolu_4")).result();
		} finally {
			if (saved.turn === undefined) delete process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN; else process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = saved.turn;
			if (saved.prompt === undefined) delete process.env.CLAUDE_CODE_RESUME_PROMPT; else process.env.CLAUDE_CODE_RESUME_PROMPT = saved.prompt;
		}

		const [ordinary, continuation] = calls;
		assert.ok(!("CLAUDE_CODE_RESUME_INTERRUPTED_TURN" in ordinary.env));
		assert.ok(!("CLAUDE_CODE_RESUME_PROMPT" in ordinary.env));
		assert.equal(ordinary.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS, "1");
		assert.deepEqual(ordinary.stdin, ["hello"]);
		// The continuation's own text, not the inherited one.
		assert.equal(continuation.env.CLAUDE_CODE_RESUME_PROMPT, CONTINUE_AFTER_RESUME);
		assert.equal(continuation.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS, "0");
	});

	for (const [shape, ending] of [
		["aborted", (c, controller) => { controller.abort(); return c.killed; }],
		["ended at an error result", () => {}],
	]) {
		it(`a continuation ${shape} and continued again resumes a file that ends at the tool result`, async () => {
			const P = `pi-again-${shape.split(" ")[0]}`;
			const history = atToolResult("toolu_5");
			const controller = new AbortController();
			scripts.push({ label: "first", steps: [init("cc-first"), ...text("partial").slice(0, 3), (c) => { ccRunsTurn(c); return ending(c, controller); },
				errorResult("overloaded")] });
			const first = await call(P, history, controller.signal).result();
			assert.equal(first.stopReason, shape === "aborted" ? "aborted" : "error");
			await sleep(10); // the query's teardown runs after its stream ends
			// CC wrote the continue text, so the mark would resume its file once settled.
			assert.ok(getSharedSession(P).abortedAt !== undefined, "the failed continuation left a resume mark");
			getSharedSession(P).abortedAt -= 60_000;

			scripts.push({ label: "again", steps: [init("cc-again"), ...text("done"), result("done")] });
			const reply = await call(P, history, new AbortController().signal).result();

			assert.equal(replyText(reply), "done");
			assert.ok(calls[1].resume, "the continuation resumes a session");
			endsAtToolResult(calls[1]);
			assert.equal(calls[1].env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN, "1");
		});
	}

	describe("the fallback never fires once the query is gone", () => {
		const armed = () => assert.notEqual(ctx().continuationFallback, null, "a silent continuation arms the fallback");
		const disarmed = () => assert.equal(ctx().continuationFallback, null, "the fallback is disarmed");

		it("after an abort", async () => {
			const controller = new AbortController();
			scripts.push({ label: "aborted", steps: [init("cc-x"), (c) => c.killed] });
			const turn = call("pi-x-abort", atToolResult("toolu_6"), controller.signal);
			await sleep(10);
			armed();
			controller.abort();
			await turn.result();
			disarmed();
			await sleep(FALLBACK_MS * 3);
			assert.deepEqual(calls[0].stdin, []);
		});

		it("after the query was discarded", async () => {
			scripts.push({ label: "discarded", steps: [init("cc-y"), (c) => c.killed] });
			void call("pi-x-discard", atToolResult("toolu_7"), new AbortController().signal);
			await sleep(10);
			armed();
			discardRewrittenQuery(ctx());
			disarmed();
			await sleep(FALLBACK_MS * 3);
			assert.deepEqual(calls[0].stdin, []);
		});

		it("after the query ended without a word", async () => {
			scripts.push({ label: "ended", steps: [init("cc-z")] });
			await call("pi-x-end", atToolResult("toolu_8"), new AbortController().signal).result();
			await sleep(10); // the query's teardown runs after its stream ends
			disarmed();
			await sleep(FALLBACK_MS * 3);
			assert.deepEqual(calls[0].stdin, []);
		});
	});
});
