/**
 * A pi session made by /fork starts from a Claude Code fork of its parent's CC
 * session instead of rebuilding it from pi's history.
 *
 * /fork gives pi a new session id with no CC session, so the bridge imported the
 * forked history into a new file. A rebuilt file lacks the context blocks CC writes
 * at the head of its own sessions, so the first request re-cached the whole
 * conversation; a CC fork of the parent's file reproduces the parent's request
 * bytes and reads them back (diag/probe-fork-cache.mjs). These tests drive the
 * provider with a mocked SDK query() and fire pi's session_start for the fork.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createSession, getSessionPath, openSession } from "cc-session-io";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-fork-cache-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
const piDir = mkdtempSync(join(tmpdir(), "claude-bridge-fork-cache-pi-"));
process.on("exit", () => { rmSync(claudeDir, { recursive: true, force: true }); rmSync(piDir, { recursive: true, force: true }); });

const mod = await import("../src/index.js");
const { setQuery, getSharedSession, resetSharedSession } = mod.__test;
let providerConfig;
const handlers = {};
mod.default({
	on: (name, fn) => { (handlers[name] ??= []).push(fn); },
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const { forkSeams } = await import("../src/fork.js");
const realForkSession = forkSeams.forkSession;
const model = providerConfig.models[0];

const calls = [];
const scripts = [];
const init = (id) => ({ type: "system", subtype: "init", session_id: id });
const result = (t) => ({ type: "result", subtype: "success", is_error: false, result: t });

beforeEach(() => {
	resetSharedSession();
	calls.length = 0;
	scripts.length = 0;
	setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		calls.push({ label: script.label, resume: options.resume });
		const gen = (async function* () {
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
	forkSeams.forkSession = realForkSession;
});

let clock = 1_000;
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const say = (t) => ({ role: "assistant", content: [{ type: "text", text: t }], api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: clock++ });
const call = (sessionId, messages, extra = {}) => streamSimple(model, { messages, ...(extra.tools ? { tools: extra.tools } : {}) }, { sessionId, ...(extra.signal ? { signal: extra.signal } : {}) });
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
const ev = (event) => ({ type: "stream_event", event });
const toolUse = (id) => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: clock++ });
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; };
const settle = () => new Promise((r) => setTimeout(r, 20));
const mirrorFile = (P) => join(process.env.PI_CODING_AGENT_DIR, "claude-bridge-mirrors", `${P}.json`);
const editMirror = (P, patch) => writeFileSync(mirrorFile(P), JSON.stringify({ ...JSON.parse(readFileSync(mirrorFile(P), "utf8")), ...patch }));
const sessionFile = (id) => getSessionPath(id, process.cwd(), claudeDir);

/** The CLI appends the turn to its own session file while the turn runs: the
 *  prompt marked "cc:", which a file rebuilt from pi's history never holds. */
const ccWritesTurn = (id, prompt, answer) => () => {
	const session = existsSync(sessionFile(id))
		? openSession({ sessionId: id, projectPath: process.cwd(), claudeDir })
		: createSession({ sessionId: id, projectPath: process.cwd(), claudeDir });
	session.addUserMessage(`cc:${prompt}`);
	session.addAssistantMessage([{ type: "text", text: answer }]);
	session.save();
};

/** A parent pi session `P` with two completed turns on CC session `id`. */
async function parentWithTwoTurns(P, id) {
	const u1 = user("first"), a1 = say("first answer"), u2 = user("second"), a2 = say("second answer");
	scripts.push({ label: "parent turn 1", steps: [init(id), ccWritesTurn(id, "first", "first answer"), result("first answer")] });
	await call(P, [u1]).result();
	scripts.push({ label: "parent turn 2", steps: [init(id), ccWritesTurn(id, "second", "second answer"), result("second answer")] });
	await call(P, [u1, a1, u2]).result();
	assert.equal(calls.at(-1).resume, id, "the parent's second turn reuses its CC session");
	return { u1, a1, u2, a2 };
}

/** pi's /fork: tear the parent down and start child session `C`, whose session
 *  file names the parent's as previousSessionFile. */
function forkTo(P, C, reason = "fork") {
	const previousSessionFile = join(piDir, `${P}.jsonl`);
	writeFileSync(previousSessionFile, `${JSON.stringify({ type: "session", version: 3, id: P, timestamp: new Date().toISOString(), cwd: process.cwd() })}\n`);
	for (const fn of handlers.session_shutdown ?? []) fn({ type: "session_shutdown", reason }, ctxFor(P));
	for (const fn of handlers.session_start ?? []) fn({ type: "session_start", reason, previousSessionFile }, ctxFor(C));
}
const ctxFor = (id) => ({ ui: { notify: () => {} }, mode: "tui", cwd: process.cwd(), sessionManager: { getSessionId: () => id }, hasUI: false });

/** The CC session the child's first query resumed, with its file's text. */
function resumedByChild(parentId) {
	const resumed = calls.at(-1).resume;
	assert.ok(resumed, "the child's first query resumes a CC session");
	assert.notEqual(resumed, parentId, "the child never writes the parent's CC file");
	return { resumed, text: readFileSync(sessionFile(resumed), "utf8") };
}

/** Whether the CC session file holds records the SDK's forkSession copied. */
const forked = (text) => text.includes('"forkedFrom"');

describe("a pi session made by /fork", () => {
	it("forked after the parent's last turn, resumes a CC fork of the whole parent session", async () => {
		const P = "pi-fork-end", C = "pi-fork-end-child", id = "11111111-1111-4111-8111-111111111111";
		const { u1, a1, u2, a2 } = await parentWithTwoTurns(P, id);
		const parentBytes = readFileSync(sessionFile(id), "utf8");
		forkTo(P, C);

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, u2, a2, user("third")]).result();

		const { resumed, text } = resumedByChild(id);
		assert.match(text, /cc:first[\s\S]*cc:second/, "CC's own records are forked, not rebuilt from pi's history");
		assert.match(text, /second answer/);
		assert.equal(readFileSync(sessionFile(id), "utf8"), parentBytes, "the parent's CC file is untouched");
		assert.equal(getSharedSession(C).sessionId, resumed);
		assert.equal(getSharedSession(C).cursor, 5, "the child's turn completed on the fork");
	});

	it("forked before the parent's last prompt, resumes a CC fork cut at the end of the earlier turn", async () => {
		const P = "pi-fork-mid", C = "pi-fork-mid-child", id = "22222222-2222-4222-8222-222222222222";
		const { u1, a1 } = await parentWithTwoTurns(P, id);
		forkTo(P, C);

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, user("instead")]).result();

		const { text } = resumedByChild(id);
		assert.match(text, /cc:first/);
		assert.match(text, /first answer/);
		assert.doesNotMatch(text, /cc:second|second answer/, "the fork stops at the end of the turn pi kept");
	});

	it("rebuilds when the forked history is not a prefix the parent's CC session covered", async () => {
		const P = "pi-fork-mismatch", C = "pi-fork-mismatch-child", id = "33333333-3333-4333-8333-333333333333";
		const { a1, u2, a2 } = await parentWithTwoTurns(P, id);
		forkTo(P, C);

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [user("first, edited"), a1, u2, a2, user("third")]).result();

		const { text } = resumedByChild(id);
		assert.doesNotMatch(text, /cc:/, "a history CC never saw is imported into a new session");
	});

	it("rebuilds when the parent's CC session file is gone", async () => {
		const P = "pi-fork-no-file", C = "pi-fork-no-file-child", id = "44444444-4444-4444-8444-444444444444";
		const { u1, a1, u2, a2 } = await parentWithTwoTurns(P, id);
		rmSync(sessionFile(id));
		forkTo(P, C);

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, u2, a2, user("third")]).result();

		const { text } = resumedByChild(id);
		assert.doesNotMatch(text, /cc:/);
	});

	it("rebuilds when the parent's CC file no longer ends that turn with pi's answer", async () => {
		const P = "pi-fork-rewritten", C = "pi-fork-rewritten-child", id = "77777777-7777-4777-8777-777777777777";
		const { u1, a1 } = await parentWithTwoTurns(P, id);
		// Rewritten since (a rebuild in place): same size, another answer at the turn's end.
		writeFileSync(sessionFile(id), readFileSync(sessionFile(id), "utf8").replace("first answer", "FIRST ANSWER"));
		forkTo(P, C);

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, user("instead")]).result();

		const { text } = resumedByChild(id);
		assert.doesNotMatch(text, /cc:/);
	});

	it("rebuilds when another running process owns the parent's CC session", async () => {
		const P = "pi-fork-owned", C = "pi-fork-owned-child", id = "88888888-8888-4888-8888-888888888888";
		const { u1, a1, u2, a2 } = await parentWithTwoTurns(P, id);
		const mirror = join(process.env.PI_CODING_AGENT_DIR, "claude-bridge-mirrors", `${P}.json`);
		writeFileSync(mirror, JSON.stringify({ ...JSON.parse(readFileSync(mirror, "utf8")), pid: process.ppid }));
		forkTo(P, C);

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, u2, a2, user("third")]).result();

		const { text } = resumedByChild(id);
		assert.doesNotMatch(text, /cc:/);
	});

	it("rebuilds a session started some other way, even with the same history", async () => {
		const P = "pi-fork-new", C = "pi-fork-new-child", id = "55555555-5555-4555-8555-555555555555";
		const { u1, a1, u2, a2 } = await parentWithTwoTurns(P, id);
		forkTo(P, C, "new");

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, u2, a2, user("third")]).result();

		const { text } = resumedByChild(id);
		assert.doesNotMatch(text, /cc:/);
	});

	it("leaves the parent pi session resuming its own CC session", async () => {
		const P = "pi-fork-parent", C = "pi-fork-parent-child", id = "66666666-6666-4666-8666-666666666666";
		const { u1, a1, u2, a2 } = await parentWithTwoTurns(P, id);
		forkTo(P, C);
		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, user("instead")]).result();
		resumedByChild(id);

		// Back to the parent (/resume): it still continues its own CC session.
		forkTo(C, P, "resume");
		scripts.push({ label: "parent turn 3", steps: [init("cc-x"), result("ok")] });
		await call(P, [u1, a1, u2, a2, user("third")]).result();
		assert.equal(calls.at(-1).resume, id);
	});

	it("rebuilds when the parent's CC file was rebuilt in place since the turn, even once it grew past it", async () => {
		const P = "pi-fork-rebuilt", C = "pi-fork-rebuilt-child", id = "99999999-9999-4999-8999-999999999999";
		const { u1, a1, u2, a2 } = await parentWithTwoTurns(P, id);
		// Turns on another model: pi's history gained messages CC never saw, so the next
		// sync rebuilds CC's file in place (same id), and this turn grows it again.
		const uX = user("asked another model"), aX = say("another model's answer");
		scripts.push({ label: "parent turn 3", steps: [init(id), ccWritesTurn(id, "third", "third answer"), result("third answer")] });
		await call(P, [u1, a1, u2, a2, uX, aX, user("third")]).result();
		assert.equal(calls.at(-1).resume, id, "the rebuild kept the CC session id");
		forkTo(P, C);

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, user("instead")]).result();

		const { text } = resumedByChild(id);
		assert.ok(!forked(text), "a turn recorded before the rebuild points into another file: rebuild");
	});

	it("rebuilds when the parent's CC file was rewritten with the same turns", async () => {
		const P = "pi-fork-same-turns", C = "pi-fork-same-turns-child", id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const { u1, a1 } = await parentWithTwoTurns(P, id);
		// The same records rewritten (new uuids, same sizes and answers).
		rmSync(sessionFile(id));
		ccWritesTurn(id, "first", "first answer")();
		ccWritesTurn(id, "second", "second answer")();
		forkTo(P, C);

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, user("instead")]).result();

		const { text } = resumedByChild(id);
		assert.ok(!forked(text), "a file rewritten since the turn is not forked");
	});

	it("forks at the answer when CC wrote a record outside the message chain after it", async () => {
		const P = "pi-fork-title", C = "pi-fork-title-child", id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		const u1 = user("first"), a1 = say("first answer");
		const title = () => appendFileSync(sessionFile(id), `${JSON.stringify({ type: "custom-title", customTitle: "a title", uuid: randomUUID(), sessionId: id })}\n`);
		scripts.push({ label: "parent turn 1", steps: [init(id), ccWritesTurn(id, "first", "first answer"), title, result("first answer")] });
		await call(P, [u1]).result();
		forkTo(P, C);

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, user("next")]).result();

		const { text } = resumedByChild(id);
		assert.ok(forked(text), "a custom-title uuid is not a fork point the SDK accepts: fork at the chain's last entry");
		assert.match(text, /first answer/);
	});

	it("removes a fork it cannot find at the session path and rebuilds", async () => {
		const P = "pi-fork-elsewhere", C = "pi-fork-elsewhere-child", id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		const { u1, a1, u2, a2 } = await parentWithTwoTurns(P, id);
		const elsewhere = join(claudeDir, "projects", "-somewhere-else");
		let orphan;
		// The SDK wrote the fork in another project directory than the bridge resolves.
		forkSeams.forkSession = async (sessionId, options) => {
			const fork = await realForkSession(sessionId, options);
			mkdirSync(elsewhere, { recursive: true });
			orphan = join(elsewhere, `${fork.sessionId}.jsonl`);
			renameSync(sessionFile(fork.sessionId), orphan);
			return fork;
		};
		forkTo(P, C);

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, u2, a2, user("third")]).result();

		const { text } = resumedByChild(id);
		assert.ok(!forked(text));
		assert.ok(orphan, "the fork ran");
		assert.equal(existsSync(orphan), false, "the fork's own file is not left behind");
		assert.equal(existsSync(sessionFile(id)), true, "the parent's file stays");
	});

	it("rebuilds when the parent's last turn was aborted", async () => {
		const P = "pi-fork-aborted", C = "pi-fork-aborted-child", id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		const { u1, a1 } = await parentWithTwoTurns(P, id);
		editMirror(P, { abortedAt: Date.now() - 60_000, abortedPrompt: "cc:second", abortedFileOffset: 0 });
		forkTo(P, C);

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, user("instead")]).result();

		assert.ok(!forked(resumedByChild(id).text));
	});

	it("rebuilds when the parent ran in another cwd", async () => {
		const P = "pi-fork-cwd", C = "pi-fork-cwd-child", id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
		const { u1, a1, u2, a2 } = await parentWithTwoTurns(P, id);
		editMirror(P, { cwd: "/somewhere/else" });
		forkTo(P, C);

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, u2, a2, user("third")]).result();

		assert.ok(!forked(resumedByChild(id).text));
	});

	it("rebuilds a fork that ends at a tool result inside the parent's turn", async () => {
		const P = "pi-fork-tool", C = "pi-fork-tool-child", id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
		const u1 = user("read a");
		const g = gate();
		scripts.push({ label: "parent turn 1", steps: [init(id), ...toolUse("toolu_1"), g.wait, ccWritesTurn(id, "read a", "final answer"), result("final answer")] });
		const parked = await call(P, [u1], { tools }).result();
		const tr = toolResult("toolu_1");
		const continued = call(P, [u1, parked, tr], { tools });
		await settle();
		g.open();
		await continued.result();
		assert.ok(JSON.parse(readFileSync(mirrorFile(P), "utf8")).turns?.some((t) => t.cursor === 3), "the parent recorded its tool turn");
		// /clone at the tool result: the final answer CC's file ends with is not in the fork.
		forkTo(P, C);
		// The parent's finished query still claims toolu_1, as in tests/unit-reopen-resume.mjs
		// newProcess: drop it so the child's prompt is not routed to it as a tool result.
		mod.__test.activeQueryContexts.clear();

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, parked, tr, user("try something else")], { tools }).result();

		assert.ok(!forked(resumedByChild(id).text));
	});

	it("forgets the parent when the forked session starts again some other way", async () => {
		const P = "pi-fork-reload", C = "pi-fork-reload-child", id = "12121212-1212-4121-8121-121212121212";
		const { u1, a1, u2, a2 } = await parentWithTwoTurns(P, id);
		forkTo(P, C);
		for (const fn of handlers.session_start ?? []) fn({ type: "session_start", reason: "reload" }, ctxFor(C));

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, u2, a2, user("third")]).result();

		assert.ok(!forked(resumedByChild(id).text));
	});

	it("ends the turn without a query when aborted during the fork, and the next prompt runs on it", async () => {
		const P = "pi-fork-abort", C = "pi-fork-abort-child", id = "13131313-1313-4131-8131-131313131313";
		const { u1, a1, u2, a2 } = await parentWithTwoTurns(P, id);
		const g = gate();
		forkSeams.forkSession = async (sessionId, options) => { await g.wait(); return realForkSession(sessionId, options); };
		forkTo(P, C);

		const controller = new AbortController();
		const queries = calls.length;
		const pending = call(C, [u1, a1, u2, a2, user("third")], { signal: controller.signal }).result();
		await settle();
		controller.abort();
		g.open();
		const aborted = await pending;
		assert.equal(aborted.stopReason, "aborted");
		assert.equal(calls.length, queries, "no query ran for the aborted turn");

		scripts.push({ label: "child turn", steps: [init("cc-x"), result("ok")] });
		await call(C, [u1, a1, u2, a2, user("third again")]).result();
		assert.ok(forked(resumedByChild(id).text), "the next prompt runs on the fork");
	});
});
