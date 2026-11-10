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

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-abort-resume-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const { __test } = await import("../src/index.js");
const { deferUntilAbortSettles } = await import("../src/fork.js");
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
// Whether the bridge may treat the CLI as gone: reaped, or a zombie this process has not
// reaped yet. After a reload the bridge polls /proc and proceeds on a zombie, which can come
// before this process dispatches the child's exit event, so `exited` alone races (#40).
const goneForBridge = (proc) => {
	if (exited(proc)) return true;
	try {
		return readFileSync(`/proc/${proc.pid}/stat`, "utf8").replace(/^.*\) /s, "").startsWith("Z");
	} catch {
		return process.platform === "linux"; // no /proc entry on Linux: already reaped
	}
};

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

	it("rebuilds on a fresh session id inside the settle window when the CLI's exit cannot be observed", async () => {
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

	it("resumes at once when the aborted CLI has already exited", async () => {
		const P = "pi-abort-exited";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([{ type: "text", text: "partial" }]), u3 = user("next");
		const proc = await completeThenAbort(P, [u1, a1, u2], { cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");

		const startedAt = Date.now();
		scripts.push({ label: "turn 3", steps: [init("cc-1"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		assert.equal(calls.at(-1).resume, `cc-${P}`, "no settle window to wait out once the CLI is gone");
		assert.ok(calls.at(-1).at - startedAt < 500, `the next query started ${calls.at(-1).at - startedAt}ms late`);
		assert.equal(getSharedSession(P).abortedAt, undefined);
	});

	it("waits for a CLI still shutting down, then resumes the file it finished", async () => {
		const P = "pi-abort-lagging";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("lagging essay"), a2 = aborted([]), u3 = user("next");
		// CC has only turn 1 on file when the abort lands, and writes the aborted
		// prompt as it exits: the persisted-prompt check must run after the wait.
		const id = `cc-${P}`;
		const env = { LAG_MS: "400", APPEND_PATH: sessionFile(id), APPEND_LINE: `${JSON.stringify({ type: "user", message: { role: "user", content: "lagging essay" } })}\n` };
		const proc = await completeThenAbort(P, [u1, a1, u2], { ccWrote: "before", cli: CLI_LAGS, env });
		assert.ok(!exited(proc), "the CLI is still shutting down when the next prompt arrives");

		const startedAt = Date.now();
		scripts.push({ label: "turn 3", steps: [init("cc-1"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		assert.ok(exited(proc), "the next query waited for the CLI to exit");
		assert.equal(calls.at(-1).resume, id, "the finished file is resumed");
		assert.ok(calls.at(-1).at - startedAt < 2_000, `the wait lasted ${calls.at(-1).at - startedAt}ms, not just until the exit`);
	});

	it("rebuilds when the aborted CLI outlives the settle bound", async () => {
		const P = "pi-abort-stuck";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), u3 = user("next");
		const proc = await completeThenAbort(P, [u1, a1, u2], { cli: CLI_STUCK });
		// 400 ms of the bound left, rather than sleeping through all of it.
		getSharedSession(P).abortedAt -= 2_600;

		const startedAt = Date.now();
		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		const waited = calls.at(-1).at - startedAt;
		assert.ok(waited >= 300 && waited < 2_000, `waited ${waited}ms, not until the bound`);
		assert.ok(!exited(proc));
		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== `cc-${P}`, "a CLI that may still write is never shared: rebuild on a rotated id");
		assert.equal(existsSync(sessionFile(resumed)), true);
	});

	it("stops waiting when the next turn is aborted during the wait", async () => {
		const P = "pi-abort-stuck-abort";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), u3 = user("next");
		await completeThenAbort(P, [u1, a1, u2], { cli: CLI_STUCK });

		const proc = children.at(-1);
		const queriesBefore = calls.length;

		const controller = new AbortController();
		const startedAt = Date.now();
		const turn3 = call(P, [u1, a1, u2, a2, u3], controller.signal);
		setTimeout(() => controller.abort(), 100);
		const out = await turn3.result();

		assert.equal(out.stopReason, "aborted");
		assert.equal(out.errorMessage, "Operation aborted");
		assert.ok(Date.now() - startedAt < 1_500, "the abort ends the wait, not the bound");
		assert.equal(calls.length, queriesBefore, "an abort during the wait starts no query and spawns no CLI");
		const state = getSharedSession(P);
		assert.equal(state.sessionId, `cc-${P}`, "the session is not rotated away from CC's own file");
		assert.notEqual(state.abortedAt, undefined, "the first abort's mark stays for the next prompt");

		// Once the first CLI is gone, retrying the prompt resumes CC's file.
		proc.kill("SIGKILL");
		if (!exited(proc)) await once(proc, "exit");
		scripts.push({ label: "turn 3 retry", steps: [init("cc-y"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();
		assert.equal(calls.at(-1).resume, `cc-${P}`);
	});

	it("rebuilds at once when a CLI past the bound is still alive", async () => {
		const P = "pi-abort-stuck-late";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), u3 = user("next");
		await completeThenAbort(P, [u1, a1, u2], { cli: CLI_STUCK });
		pastSettleWindow(P);

		const startedAt = Date.now();
		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		assert.ok(calls.at(-1).at - startedAt < 300, "no wait past the bound");
		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== `cc-${P}`, "the settle timer alone no longer resumes a file a live CLI holds");
	});

	it("still rebuilds after an exit when the aborted prompt never reached the file", async () => {
		const P = "pi-abort-exited-prompt-lost";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("aborted at startup"), a2 = aborted([]), u3 = user("next");
		const proc = await completeThenAbort(P, [u1, a1, u2], { ccWrote: "before", cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== `cc-${P}`);
		assert.match(readFileSync(sessionFile(resumed), "utf8"), /aborted at startup/);
	});

	it("still rebuilds after an exit when a user message never reached Claude Code", async () => {
		const P = "pi-abort-exited-missed-user";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), steer = user("queued steer"), a3 = say("x"), u3 = user("next");
		const proc = await completeThenAbort(P, [u1, a1, u2], { cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, steer, a3, u3]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== `cc-${P}`);
	});

	it("still rebuilds after an exit when pi rewrote the history", async () => {
		const P = "pi-abort-exited-rewrite";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), u3 = user("next");
		const proc = await completeThenAbort(P, [u1, a1, u2], { cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");
		markRebuildForSession(P, "session_compact");

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== `cc-${P}`);
	});

	it("keeps the CLI's redacted stderr tail on an exit error", async () => {
		const P = "pi-exit-stderr";
		const cli = `process.stderr.write("Error: Failed to authenticate. Bearer abc.def key sk-ant-api03-SECRET_value-1 token=hunter2\\n"); process.exit(1);`;
		const failWithExit = async (script) => {
			if (!exited(script.proc)) await once(script.proc, "exit");
			throw new Error("Claude Code process exited with code 1");
		};
		scripts.push({ label: "turn 1", steps: [init("cc-e"), failWithExit], cli });
		const out = await call(P, [user("hi")]).result();

		assert.equal(out.stopReason, "error");
		assert.match(out.errorMessage, /^Claude Code process exited with code 1\. stderr: Error: Failed to authenticate\./);
		assert.doesNotMatch(out.errorMessage, /SECRET|hunter2|abc\.def/, "secrets in the tail are redacted");
		assert.match(out.errorMessage, /\[REDACTED\]/);
	});

	it("leaves an exit error that already carries a stderr tail alone", async () => {
		const P = "pi-exit-stderr-once";
		const cli = `process.stderr.write("boom\\n"); process.exit(1);`;
		const failWithExit = async (script) => {
			if (!exited(script.proc)) await once(script.proc, "exit");
			throw new Error("Claude Code process exited with code 1. stderr: boom");
		};
		scripts.push({ label: "turn 1", steps: [init("cc-e2"), failWithExit], cli });
		const out = await call(P, [user("hi")]).result();
		assert.equal(out.errorMessage, "Claude Code process exited with code 1. stderr: boom");
	});

	it("survives an error on the CLI's stderr stream", async () => {
		const P = "pi-stderr-error";
		scripts.push({ label: "turn 1", steps: [init("cc-s"), (script) => { script.proc.stderr.emit("error", new Error("EPIPE")); }, result("ok")], cli: CLI_EXITS });
		const out = await call(P, [user("hi")]).result();
		assert.equal(out.stopReason, "stop");
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

describe("the deferred turn's relay", () => {
	it("turns a throw from the provider into one error event and ends the stream", async () => {
		const state = { abortedAt: Date.now(), abortedProcess: { spawned: true, exited: false, exit: Promise.resolve() } };
		const stream = deferUntilAbortSettles(() => { throw new Error("provider blew up"); }, state, model, { messages: [] }, {});
		assert.ok(stream, "a live CLI defers the turn");
		const events = [];
		for await (const event of stream) events.push(event);
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "error");
		assert.equal(events[0].reason, "error");
		assert.equal(events[0].error.stopReason, "error");
		assert.equal(events[0].error.errorMessage, "provider blew up");
		assert.equal(events[0].error.model, model.id);
		assert.equal((await stream.result()).errorMessage, "provider blew up");
	});
});

// --- /reload between the abort and the next prompt ---
// pi's /reload re-imports the extension in the same OS process: every in-memory
// mirror is gone, the files on disk and the aborted CLI (if still shutting down) are
// not. The abort mark rides the session's mirror file to the next module instance.
const mirrorFile = (P) => join(process.env.PI_CODING_AGENT_DIR, "claude-bridge-mirrors", `${encodeURIComponent(P)}.json`);
const readMirror = (P) => JSON.parse(readFileSync(mirrorFile(P), "utf8"));
const editMirror = (P, edit) => writeFileSync(mirrorFile(P), JSON.stringify(edit(readMirror(P))));
/** A reloaded module: no mirror and no query in memory. */
const reload = () => { resetSharedSession(); __test.activeQueryContexts.clear(); };

describe("the turn after an abort and a /reload", () => {
	it("resumes Claude Code's own session once the aborted CLI has exited", async () => {
		const P = "pi-reload-exited";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([{ type: "text", text: "partial" }]), u3 = user("next");
		const proc = await completeThenAbort(P, [u1, a1, u2], { cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");
		reload();

		const startedAt = Date.now();
		let markOnDiskMidTurn;
		scripts.push({ label: "turn 3", steps: [init("cc-1"), () => { markOnDiskMidTurn = existsSync(mirrorFile(P)); }, result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		assert.equal(calls.at(-1).resume, `cc-${P}`, "the reloaded module resumes the aborted turn's CC session");
		assert.equal(markOnDiskMidTurn, false, "the used-up mark leaves the disk at the resume, so a reload mid-turn cannot reuse it");
		assert.ok(calls.at(-1).at - startedAt < 500, `the next query started ${calls.at(-1).at - startedAt}ms late`);
		assert.doesNotMatch(readFileSync(sessionFile(`cc-${P}`), "utf8"), /first answer/, "CC's own file is resumed, not rewritten");
		const state = getSharedSession(P);
		assert.equal(state.cursor, 5);
		assert.equal(state.abortedAt, undefined, "the abort mark is consumed by the resume");
		assert.equal(readMirror(P).abortedAt, undefined, "the completed turn records a mirror without the mark");
	});

	it("waits for a CLI still shutting down, then resumes the file it finished", async () => {
		const P = "pi-reload-lagging";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("lagging essay"), a2 = aborted([]), u3 = user("next");
		const id = `cc-${P}`;
		const env = { LAG_MS: "400", APPEND_PATH: sessionFile(id), APPEND_LINE: `${JSON.stringify({ type: "user", message: { role: "user", content: "lagging essay" } })}\n` };
		const proc = await completeThenAbort(P, [u1, a1, u2], { ccWrote: "before", cli: CLI_LAGS, env });
		assert.ok(!exited(proc), "the CLI is still shutting down when the module reloads");
		reload();

		const startedAt = Date.now();
		let cliGoneAtQuery;
		scripts.push({ label: "turn 3", steps: [init("cc-1"), () => { cliGoneAtQuery = goneForBridge(proc); }, result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		assert.equal(cliGoneAtQuery, true, "the next query waited for the CLI to exit");
		assert.equal(calls.at(-1).resume, id, "the finished file is resumed");
		assert.ok(calls.at(-1).at - startedAt < 2_000, `the wait lasted ${calls.at(-1).at - startedAt}ms, not just until the exit`);
	});

	it("rebuilds on a fresh id when the aborted CLI outlives the settle bound", async () => {
		const P = "pi-reload-stuck";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), u3 = user("next");
		const proc = await completeThenAbort(P, [u1, a1, u2], { cli: CLI_STUCK });
		reload();
		// 400 ms of the bound left, rather than sleeping through all of it.
		editMirror(P, (m) => ({ ...m, abortedAt: m.abortedAt - 2_600 }));

		const startedAt = Date.now();
		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		const waited = calls.at(-1).at - startedAt;
		assert.ok(waited >= 300 && waited < 2_000, `waited ${waited}ms, not until the bound`);
		assert.ok(!exited(proc));
		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== `cc-${P}`, "a CLI that may still write is never shared: rebuild on a rotated id");
		assert.equal(existsSync(sessionFile(resumed)), true);
	});

	it("rebuilds when a user message after the abort point never reached Claude Code", async () => {
		const P = "pi-reload-missed-user";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), steer = user("queued steer"), a3 = say("x"), u3 = user("next");
		const proc = await completeThenAbort(P, [u1, a1, u2], { cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");
		reload();

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, steer, a3, u3]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== `cc-${P}`, "CC's file lacks the steer, so pi's history is imported");
		assert.match(readFileSync(sessionFile(resumed), "utf8"), /queued steer/);
	});

	it("rebuilds when Claude Code was killed before writing the aborted prompt", async () => {
		const P = "pi-reload-prompt-lost";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("aborted at startup"), a2 = aborted([]), u3 = user("next");
		const proc = await completeThenAbort(P, [u1, a1, u2], { ccWrote: "before", cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");
		reload();

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== `cc-${P}`);
		assert.match(readFileSync(sessionFile(resumed), "utf8"), /aborted at startup/, "the rebuilt session carries the prompt");
	});

	it("rebuilds when pi's history no longer matches what Claude Code saw", async () => {
		const P = "pi-reload-rewritten";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), u3 = user("next");
		const proc = await completeThenAbort(P, [u1, a1, u2], { cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");
		reload();

		const compacted = user("summary of the conversation so far");
		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [compacted, a1, u2, a2, u3]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== `cc-${P}`, "a different history is imported into a new session");
		assert.match(readFileSync(sessionFile(resumed), "utf8"), /summary of the conversation/);
	});

	it("falls back to the settle window when the aborted CLI's exit cannot be observed", async () => {
		const P = "pi-reload-untracked";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), u3 = user("next");
		await completeThenAbort(P, [u1, a1, u2]);
		assert.equal(readMirror(P).abortedCliPid, undefined, "no process was tracked");
		reload();

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();
		const early = calls.at(-1).resume;
		assert.ok(early && early !== `cc-${P}`, "inside the window the session is rotated, as before");

		const Q = "pi-reload-untracked-late";
		await completeThenAbort(Q, [u1, a1, u2]);
		reload();
		editMirror(Q, (m) => ({ ...m, abortedAt: m.abortedAt - 60_000 }));
		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(Q, [u1, a1, u2, a2, u3]).result();
		assert.equal(calls.at(-1).resume, `cc-${Q}`, "past the window CC's own file is resumed");
	});

	it("does not let a reused pid pass for the aborted CLI", async () => {
		const P = "pi-reload-pid-reused";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), u3 = user("next");
		const proc = await completeThenAbort(P, [u1, a1, u2], { cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");
		reload();
		// The CLI's pid now names a live process started at another time.
		editMirror(P, (m) => ({ ...m, abortedCliPid: process.pid }));

		const startedAt = Date.now();
		scripts.push({ label: "turn 3", steps: [init("cc-1"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		assert.equal(calls.at(-1).resume, `cc-${P}`, "a different start time means the aborted CLI is gone");
		assert.ok(calls.at(-1).at - startedAt < 500, "nothing waits on the unrelated process");
	});

	it("rebuilds when another running pi process still owns the session", async () => {
		const P = "pi-reload-owned";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay"), a2 = aborted([]), u3 = user("next");
		const proc = await completeThenAbort(P, [u1, a1, u2], { cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");
		reload();
		editMirror(P, (m) => ({ ...m, pid: process.ppid }));

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, u3]).result();

		const resumed = calls.at(-1).resume;
		assert.ok(resumed && resumed !== `cc-${P}`, "two processes never share one CC session file");
	});
});
