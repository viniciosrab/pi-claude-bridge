/**
 * After an API error result, the next prompt resumes Claude Code's own session file
 * instead of rebuilding it from pi's history (upstream #103).
 *
 * The bridge used to drop the session at every error result, so the next turn (pi's
 * retry of the same prompt, or a new one) rebuilt the conversation into a file that
 * lacks the context blocks CC writes at its head, and re-cached all of it. CC persists
 * the failed prompt and an `isApiErrorMessage` record it strips from later requests, so
 * the next turn resumes that file as after an abort: plainly for a new prompt, and cut
 * back to before the failed prompt (`resumeSessionAt`) for pi's retry of it. These tests
 * drive the provider with a mocked SDK query() and stand in for CC's writes to its file.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createSession, getSessionPath } from "cc-session-io";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-error-resume-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const { __test } = await import("../src/index.js");
const { ErrorResultFailure, errorResultMarkable } = await import("../src/fork.js");
const { setQuery, getSharedSession, resetSharedSession, markRebuildForSession, activeQueryContexts } = __test;

const mod = await import("../src/index.js");
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

// --- fake SDK query, as in unit-abort-resume.mjs ---
const calls = [];
const scripts = [];
const children = [];
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const ev = (event) => ({ type: "stream_event", event });
const result = (t) => ({ type: "result", subtype: "success", is_error: false, result: t });
const errorResult = { type: "result", subtype: "success", is_error: true, result: "API Error: 500 probe failure" };
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
	activeQueryContexts.clear();
	calls.length = 0;
	scripts.length = 0;
	setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		calls.push({ label: script.label, resume: options.resume, resumeSessionAt: options.resumeSessionAt });
		if (script.cli) {
			script.proc = options.spawnClaudeCodeProcess({ command: process.execPath, args: ["-e", script.cli], env: process.env, signal: new AbortController().signal });
			children.push(script.proc);
		}
		const gen = (async function* () {
			await prompt[Symbol.asyncIterator]().next();
			for (const step of script.steps) {
				if (typeof step === "function") { await step(script); continue; }
				yield options.resume && step.type === "system" ? { ...step, session_id: options.resume } : step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => { script.proc?.stdin.end(); };
		return gen;
	});
});

afterEach(() => {
	setQuery(null);
	for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
});

const CLI_EXITS = `process.stdin.on("end", () => process.exit(0)); process.stdin.resume();`;
const CLI_STUCK = `process.on("SIGTERM", () => {}); process.stdin.resume(); setInterval(() => {}, 1000);`;
const exited = (proc) => proc.exitCode !== null || proc.signalCode !== null;

// --- pi-side message builders ---
let clock = 0;
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const asst = (content, stopReason = "stop", errorMessage) => ({ role: "assistant", content, api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: clock++ });
const say = (t) => asst([{ type: "text", text: t }]);
const failed = () => asst([], "error", errorResult.result);
const toolCall = (id) => asst([{ type: "toolCall", id, name: "read", arguments: { path: "a" } }], "toolUse");
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: clock++ });
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];

const call = (sessionId, messages) => streamSimple(model, { messages, tools }, { sessionId });
const settle = () => new Promise((r) => setTimeout(r, 20));
// Tolerates no mark, so the fallbacks below also pin the drop the bridge did before.
const pastSettleWindow = (P) => { const state = getSharedSession(P); if (state) state.abortedAt -= 60_000; };

// --- what the real CLI writes to its session file; the fake SDK writes none ---
const sessionFile = (id) => getSessionPath(id, process.cwd(), claudeDir);
const fileRecords = (id) => readFileSync(sessionFile(id), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const ccHas = (id, messages) => {
	const session = createSession({ sessionId: id, projectPath: process.cwd(), claudeDir });
	session.importMessages(messages);
	session.save();
};
/** As the CLI does at a failed request: the prompt (after any attachment records it
 *  writes for the turn), then the API error as an assistant record. */
const ccRecordsFailure = (id, prompt, { attachment = false } = {}) => () => {
	let parent = fileRecords(id).at(-1).uuid;
	const lines = [];
	if (attachment) {
		lines.push({ type: "attachment", uuid: `att-${id}`, parentUuid: parent, attachment: { type: "deferred_tools_delta" } });
		parent = `att-${id}`;
	}
	lines.push({ type: "user", uuid: `prompt-${id}`, parentUuid: parent, message: { role: "user", content: prompt } });
	lines.push({ type: "assistant", uuid: `err-${id}`, parentUuid: `prompt-${id}`, isApiErrorMessage: true, message: { role: "assistant", content: [{ type: "text", text: errorResult.result }] } });
	appendFileSync(sessionFile(id), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
};

/** Turn 1 completes on CC session `id` (one per pi session); turn 2 fails at an error
 *  result. `ccWrote`: CC recorded the failed prompt (true) or failed before (false). */
async function completeThenFail(P, u1, u2, { id = `cc-${P}`, ccWrote = true, attachment, cli } = {}) {
	scripts.push({ label: "turn 1", steps: [init(id), result("first answer")] });
	await call(P, [u1]).result();
	ccHas(id, [{ role: "user", content: u1.content }, { role: "assistant", content: [{ type: "text", text: "first answer" }] }]);
	const a1 = say("first answer");

	const script = { label: "turn 2", steps: [init(id), ...(ccWrote ? [ccRecordsFailure(id, u2.content, { attachment })] : []), errorResult], cli };
	scripts.push(script);
	const out = await call(P, [u1, a1, u2]).result();
	assert.equal(out.stopReason, "error");
	assert.equal(out.errorMessage, errorResult.result);
	await settle();
	return { a1, proc: script.proc };
}

const rebuilt = (P) => {
	const resumed = calls.at(-1).resume;
	assert.ok(resumed && resumed !== `cc-${P}`, `rebuilt on a rotated id, not resumed (${resumed})`);
	assert.equal(calls.at(-1).resumeSessionAt, undefined);
	return resumed;
};

describe("the turn after an API error result", () => {
	it("keeps the session with an error mark instead of dropping it", async () => {
		const P = "pi-error-mark";
		await completeThenFail(P, user("first"), user("long essay"));
		const state = getSharedSession(P);
		assert.ok(state, "the session survives the error result");
		assert.equal(state.sessionId, `cc-${P}`);
		assert.equal(state.cursor, 3, "the cursor covers the failed prompt");
		assert.equal(state.errorResult, true);
		assert.notEqual(state.abortedAt, undefined);
	});

	it("resumes Claude Code's own session for a new prompt", async () => {
		const P = "pi-error-new";
		const u1 = user("first"), u2 = user("long essay"), u3 = user("next");
		const { a1 } = await completeThenFail(P, u1, u2);
		pastSettleWindow(P);
		const before = readFileSync(sessionFile(`cc-${P}`), "utf8");

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, failed(), u3]).result();

		assert.equal(calls.at(-1).resume, `cc-${P}`, "the same CC session is resumed");
		assert.equal(calls.at(-1).resumeSessionAt, undefined, "a new prompt resumes plainly: CC merges it after the failed one");
		assert.equal(readFileSync(sessionFile(`cc-${P}`), "utf8"), before, "CC's own file is resumed, not rebuilt");
		const state = getSharedSession(P);
		assert.equal(state.cursor, 5);
		assert.equal(state.abortedAt, undefined, "the mark is consumed");
		assert.equal(state.errorResult, undefined);
	});

	it("resumes before the failed prompt when pi retries it", async () => {
		const P = "pi-error-retry";
		const u1 = user("first"), u2 = user("long essay");
		const { a1 } = await completeThenFail(P, u1, u2);
		pastSettleWindow(P);
		const answerUuid = fileRecords(`cc-${P}`).find((r) => r.type === "assistant").uuid;

		scripts.push({ label: "retry", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2]).result();

		assert.equal(calls.at(-1).resume, `cc-${P}`, "the same CC session is resumed");
		assert.equal(calls.at(-1).resumeSessionAt, answerUuid, "cut at the entry before the failed prompt, so it is sent once");
		const state = getSharedSession(P);
		assert.equal(state.cursor, 3);
		assert.equal(state.abortedAt, undefined);
	});

	it("cuts before the records the failed query wrote ahead of its prompt", async () => {
		const P = "pi-error-retry-attachment";
		const u1 = user("first"), u2 = user("long essay");
		const { a1 } = await completeThenFail(P, u1, u2, { attachment: true });
		pastSettleWindow(P);
		const answerUuid = fileRecords(`cc-${P}`).find((r) => r.type === "assistant").uuid;

		scripts.push({ label: "retry", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2]).result();

		assert.equal(calls.at(-1).resumeSessionAt, answerUuid, "the failed turn's attachment is cut with its prompt");
	});

	it("waits for the failed CLI to exit, then resumes", async () => {
		const P = "pi-error-cli-exits";
		const u1 = user("first"), u2 = user("long essay");
		const { a1, proc } = await completeThenFail(P, u1, u2, { cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");

		scripts.push({ label: "retry", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2]).result();
		assert.equal(calls.at(-1).resume, `cc-${P}`, "no settle window to wait out once the CLI is gone");
		assert.ok(calls.at(-1).resumeSessionAt);
	});
});

describe("the turn after a failure that cannot resume", () => {
	it("rebuilds after an SDK exception with no result", async () => {
		const P = "pi-error-crash";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay");
		scripts.push({ label: "turn 1", steps: [init(`cc-${P}`), result("first answer")] });
		await call(P, [u1]).result();
		ccHas(`cc-${P}`, [{ role: "user", content: "first" }]);
		scripts.push({ label: "turn 2", steps: [init(`cc-${P}`), async () => { throw new Error("Claude Code process exited with code 1"); }] });
		const out = await call(P, [u1, a1, u2]).result();
		assert.equal(out.stopReason, "error");
		assert.equal(getSharedSession(P), null, "the session is dropped, as before");

		scripts.push({ label: "retry", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2]).result();
		rebuilt(P);
	});

	it("rebuilds when the failed turn had run tool calls", async () => {
		const P = "pi-error-mid-turn";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("read a");
		scripts.push({ label: "turn 1", steps: [init(`cc-${P}`), result("first answer")] });
		await call(P, [u1]).result();
		ccHas(`cc-${P}`, [{ role: "user", content: "first" }, { role: "assistant", content: [{ type: "text", text: "first answer" }] }]);
		const g = gate();
		scripts.push({ label: "turn 2", steps: [init(`cc-${P}`), ccRecordsFailure(`cc-${P}`, "read a"), ...toolUse("toolu_1"), g.wait, errorResult] });
		const parked = await call(P, [u1, a1, u2]).result();
		assert.equal(parked.stopReason, "toolUse");
		const continued = call(P, [u1, a1, u2, toolCall("toolu_1"), toolResult("toolu_1")]);
		await settle();
		g.open();
		assert.equal((await continued.result()).stopReason, "error");
		assert.equal(getSharedSession(P), null, "a mid-turn failure drops the session, as before");
	});

	it("rebuilds when a steer was pending at the failure", async () => {
		const P = "pi-error-steer";
		const u1 = user("first"), a1 = say("first answer"), u2 = user("long essay");
		scripts.push({ label: "turn 1", steps: [init(`cc-${P}`), result("first answer")] });
		await call(P, [u1]).result();
		ccHas(`cc-${P}`, [{ role: "user", content: "first" }, { role: "assistant", content: [{ type: "text", text: "first answer" }] }]);
		const steered = () => { for (const c of activeQueryContexts) if (c.piSessionId === P) c.pendingSteerUuids.add("steer-uuid"); };
		scripts.push({ label: "turn 2", steps: [init(`cc-${P}`), ccRecordsFailure(`cc-${P}`, "long essay"), steered, errorResult] });
		await call(P, [u1, a1, u2]).result();
		assert.equal(getSharedSession(P), null, "a steer CC never incorporated is rebuilt from pi's history");
	});

	it("rebuilds when Claude Code never recorded the failed prompt", async () => {
		const P = "pi-error-prompt-lost";
		const u1 = user("first"), u2 = user("long essay");
		const { a1 } = await completeThenFail(P, u1, u2, { ccWrote: false });
		pastSettleWindow(P);

		scripts.push({ label: "retry", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2]).result();
		assert.match(readFileSync(sessionFile(rebuilt(P)), "utf8"), /first answer/, "pi's history is imported; the retried prompt is this turn's");
	});

	it("rebuilds a new prompt when Claude Code never recorded the failed one", async () => {
		const P = "pi-error-prompt-lost-new";
		const u1 = user("first"), u2 = user("long essay");
		const { a1 } = await completeThenFail(P, u1, u2, { ccWrote: false });
		pastSettleWindow(P);

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, failed(), user("next")]).result();
		assert.match(readFileSync(sessionFile(rebuilt(P)), "utf8"), /long essay/);
	});

	it("rebuilds when the next context is neither a new prompt nor the same one", async () => {
		const P = "pi-error-unrelated";
		const u1 = user("first"), u2 = user("long essay");
		const { a1 } = await completeThenFail(P, u1, u2);
		pastSettleWindow(P);

		// The failed prompt edited and resent in its place: CC's file holds the old text.
		scripts.push({ label: "edited", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, user("a different essay")]).result();
		rebuilt(P);
	});

	it("rebuilds when pi drops the failed answer and sends another prompt after the failed one", async () => {
		const P = "pi-error-two-prompts";
		const u1 = user("first"), u2 = user("long essay");
		const { a1 } = await completeThenFail(P, u1, u2);
		pastSettleWindow(P);

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, user("next")]).result();
		rebuilt(P);
	});

	it("rebuilds when pi rewrote the history after the error", async () => {
		const P = "pi-error-rewrite";
		const u1 = user("first"), u2 = user("long essay");
		const { a1 } = await completeThenFail(P, u1, u2);
		pastSettleWindow(P);
		markRebuildForSession(P, "session_compact");

		scripts.push({ label: "retry", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2]).result();
		rebuilt(P);
	});

	it("rebuilds when the failed CLI outlives the settle bound", async () => {
		const P = "pi-error-stuck";
		const u1 = user("first"), u2 = user("long essay");
		const { a1, proc } = await completeThenFail(P, u1, u2, { cli: CLI_STUCK });
		pastSettleWindow(P);

		scripts.push({ label: "retry", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2]).result();
		assert.ok(!exited(proc));
		rebuilt(P);
	});

	it("rebuilds inside the settle window when the CLI's exit cannot be observed", async () => {
		const P = "pi-error-early";
		const u1 = user("first"), u2 = user("long essay");
		const { a1 } = await completeThenFail(P, u1, u2);

		scripts.push({ label: "retry", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2]).result();
		rebuilt(P);
	});

	it("rebuilds the retry of a failed first turn: there is nothing before its prompt to resume", async () => {
		const P = "pi-error-first-turn";
		const id = `cc-${P}`, u1 = user("first prompt");
		// CC's new file: the failed prompt heads the chain.
		const writeFirst = () => ccHas(id, [{ role: "user", content: "first prompt" }]);
		scripts.push({ label: "turn 1", steps: [init(id), writeFirst, errorResult] });
		await call(P, [u1]).result();
		assert.equal(getSharedSession(P)?.errorResult, true);
		pastSettleWindow(P);

		scripts.push({ label: "retry", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1]).result();
		assert.notEqual(calls.at(-1).resume, id, "never resumed with the failed prompt still in the chain");
		assert.equal(calls.at(-1).resumeSessionAt, undefined);

		// The retry's clean start owns the session now: the next prompt resumes it
		// instead of rebuilding off the stale error mark (CodeRabbit on PR #24).
		assert.equal(getSharedSession(P)?.sessionId, "cc-x");
		assert.equal(getSharedSession(P)?.errorResult, undefined, "the error mark is gone");
		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, say("ok"), user("next")]).result();
		assert.equal(calls.at(-1).resume, "cc-x", "resumes the retry's session, no rebuild");
	});
});

describe("which failures leave an error mark", () => {
	const clean = () => ({ pendingSteerUuids: new Set(), missedSteer: false, deliveredToolCallIds: new Set(), turnToolCallIds: [] });
	it("only an error result with no steer and no tool call", () => {
		assert.equal(errorResultMarkable(new ErrorResultFailure("API Error: 529"), clean()), true);
		assert.equal(errorResultMarkable(new Error("Claude Code process exited with code 1"), clean()), false);
		assert.equal(errorResultMarkable(new ErrorResultFailure("x"), { ...clean(), pendingSteerUuids: new Set(["s"]) }), false);
		assert.equal(errorResultMarkable(new ErrorResultFailure("x"), { ...clean(), missedSteer: true }), false);
		assert.equal(errorResultMarkable(new ErrorResultFailure("x"), { ...clean(), deliveredToolCallIds: new Set(["t"]) }), false);
		assert.equal(errorResultMarkable(new ErrorResultFailure("x"), { ...clean(), turnToolCallIds: ["t"] }), false);
	});
});

// --- /reload between the error and the next prompt ---
const mirrorFile = (P) => join(process.env.PI_CODING_AGENT_DIR, "claude-bridge-mirrors", `${encodeURIComponent(P)}.json`);
const readMirror = (P) => JSON.parse(readFileSync(mirrorFile(P), "utf8"));
const reload = () => { resetSharedSession(); activeQueryContexts.clear(); };

describe("the turn after an API error result and a /reload", () => {
	it("keeps the error mark on the mirror file", async () => {
		const P = "pi-error-reload-mark";
		const proc = (await completeThenFail(P, user("first"), user("long essay"), { cli: CLI_EXITS })).proc;
		if (!exited(proc)) await once(proc, "exit");
		const mirror = readMirror(P);
		assert.equal(mirror.sessionId, `cc-${P}`);
		assert.equal(mirror.abortedByError, true);
		assert.equal(mirror.cursor, 3);
	});

	it("resumes for a new prompt", async () => {
		const P = "pi-error-reload-new";
		const u1 = user("first"), u2 = user("long essay");
		const { a1, proc } = await completeThenFail(P, u1, u2, { cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");
		reload();

		scripts.push({ label: "turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, failed(), user("next")]).result();
		assert.equal(calls.at(-1).resume, `cc-${P}`);
		assert.equal(calls.at(-1).resumeSessionAt, undefined);
		assert.equal(readMirror(P).abortedByError, undefined, "the completed turn records a mirror without the mark");
	});

	it("resumes before the failed prompt for pi's retry", async () => {
		const P = "pi-error-reload-retry";
		const u1 = user("first"), u2 = user("long essay");
		const { a1, proc } = await completeThenFail(P, u1, u2, { cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");
		const answerUuid = fileRecords(`cc-${P}`).find((r) => r.type === "assistant").uuid;
		reload();

		scripts.push({ label: "retry", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2]).result();
		assert.equal(calls.at(-1).resume, `cc-${P}`);
		assert.equal(calls.at(-1).resumeSessionAt, answerUuid);
	});

	it("rebuilds when pi's history no longer matches", async () => {
		const P = "pi-error-reload-rewritten";
		const u1 = user("first"), u2 = user("long essay");
		const { a1, proc } = await completeThenFail(P, u1, u2, { cli: CLI_EXITS });
		if (!exited(proc)) await once(proc, "exit");
		reload();

		scripts.push({ label: "retry", steps: [init("cc-x"), result("ok")] });
		await call(P, [user("summary of the conversation so far"), a1, u2]).result();
		const resumed = calls.at(-1).resume;
		assert.ok(resumed !== `cc-${P}`);
		assert.equal(calls.at(-1).resumeSessionAt, undefined);
		assert.ok(!resumed || existsSync(sessionFile(resumed)));
	});
});
