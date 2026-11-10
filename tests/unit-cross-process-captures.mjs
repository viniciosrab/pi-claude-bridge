#!/usr/bin/env node

/**
 * Issue #37: an async pi-subagents child with forked context runs in its own process,
 * and its request carries the PARENT's assembled prompt (pi-subagents
 * projectForkRequest reuses the parent's prompt cache). Captures were in-memory per
 * process, so the child held only its own and failed with "no capture for this
 * N-char system prompt".
 *
 * The parent now persists its captures in pi's agent dir, keyed by its pi session id,
 * and a child whose session header names a `parentSession` file loads that session's
 * captures at session_start. A fresh child process is simulated by a separate
 * PromptCaptures registry: the shared one already holds the parent's capture.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
const { default: activate, __test } = await import("../src/index.js");
const { PromptCaptures, projectPromptCapture } = await import("../src/prompt-capture.js");
const { loadParentCaptures, loadOwnCaptures, persistSessionCapture } = await import("../src/prompt-capture-store.js");

const AGENTS_MD = "Always answer in haiku.";
const PARENT_PROMPT = `You are pi.\n# Project Context\n${AGENTS_MD}\n# Tools\n- read\n- subagent`;
const CHILD_OWN_PROMPT = "You are the oracle. Advise only.";
const INSTRUCTIONS = "<subagent_instructions>\nYou are the oracle.\n</subagent_instructions>";
const STORE_DIR = () => join(getAgentDir(), "claude-bridge-captures");
// beforeEach deletes STORE_DIR(): refuse to run against a real agent dir (run through
// `npm run test:unit`, whose tests/lib/setup.mjs points it at a temp dir).
if (!getAgentDir().startsWith(tmpdir())) throw new Error(`refusing to run outside a temp agent dir: ${getAgentDir()}`);

/** Like tests/lib/mock-pi.mjs, but keeps every handler per event: the bridge
 *  registers more than one session_start handler. */
function activateWithMockPi() {
	const handlers = new Map();
	activate({
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerProvider: () => {},
		registerTool: () => {},
	});
	return { get: (event) => (...args) => { for (const handler of handlers.get(event) ?? []) handler(...args); } };
}

let n = 0;
function session(id, { persisted = true, parentSession } = {}) {
	return {
		getSessionId: () => id,
		getSessionFile: () => (persisted ? `/sessions/${id}.jsonl` : undefined),
		getHeader: () => ({ type: "session", id, timestamp: "", cwd: "/", ...(parentSession ? { parentSession } : {}) }),
	};
}
function ctxFor(sessionManager, prompt) {
	return { sessionManager, getSystemPrompt: () => prompt, ui: {}, mode: "print", cwd: process.cwd(), modelRegistry: { getProvider: () => ({}) } };
}
/** A pi session file holding only its header line, as the child's header points at. */
function sessionFile(id) {
	// Under the test agent dir, which tests/lib/setup.mjs removes on exit.
	const dir = join(getAgentDir(), "test-sessions");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${id}.jsonl`);
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "", cwd: "/" })}\n{"type":"message"}\n`);
	return file;
}
/** Runs the parent's turn through the hooks, which persists its captures. */
function parentTurn(parentId, { persisted = true } = {}) {
	const handlers = activateWithMockPi();
	const sm = session(parentId, { persisted });
	handlers.get("before_agent_start")({
		systemPrompt: PARENT_PROMPT,
		systemPromptOptions: { contextFiles: [{ path: "/repo/AGENTS.md", content: AGENTS_MD }], skills: [] },
	}, ctxFor(sm, PARENT_PROMPT));
	handlers.get("agent_start")({}, ctxFor(sm, PARENT_PROMPT));
	handlers.get("turn_start")({}, ctxFor(sm, PARENT_PROMPT));
}
const project = (capture) => projectPromptCapture(capture, { skillReadTool: "mcp" });

describe("prompt captures across processes (issue #37)", () => {
	beforeEach(() => rmSync(STORE_DIR(), { recursive: true, force: true }));

	it("a child process resolves the parent's prompt after loading the parent session's captures", () => {
		const parentId = `parent-${++n}`;
		parentTurn(parentId);

		// The child process: its own registry knows only its own prompt.
		const child = new PromptCaptures();
		child.record(CHILD_OWN_PROMPT, { contextFiles: [], skills: [] }, "turn_start");
		assert.throws(() => child.resolveOrDerive(PARENT_PROMPT), /no capture for this/);

		const loaded = loadParentCaptures(sessionFile(parentId), `child-${n}`, child);
		assert.equal(loaded, 1);
		const capture = child.resolveOrDerive(PARENT_PROMPT);
		assert.equal(capture.assembledPrompt, PARENT_PROMPT);
		assert.match(project(capture), /Always answer in haiku\./, "the parent's AGENTS.md reaches Claude Code");
		assert.equal(child.resolveOrDerive(CHILD_OWN_PROMPT).assembledPrompt, CHILD_OWN_PROMPT, "the child's own capture is kept");
	});

	it("resolves the parent's prompt plus a subagent_instructions section, carrying the section through", () => {
		const parentId = `parent-${++n}`;
		parentTurn(parentId);
		const child = new PromptCaptures();
		loadParentCaptures(sessionFile(parentId), `child-${n}`, child);

		const projected = project(child.resolveOrDerive(`${PARENT_PROMPT}\n\n${INSTRUCTIONS}`));
		assert.match(projected, /Always answer in haiku\./);
		assert.match(projected, /<subagent_instructions>\nYou are the oracle\.\n<\/subagent_instructions>/);
		assert.doesNotMatch(projected, /You are pi\./, "the parent's harness text is replaced by its portable parts");
	});

	it("loads the parent's captures at the child's session_start", () => {
		// Written as another process's parent would leave it: this process's shared
		// registry has never seen this prompt.
		const parentId = `parent-${++n}`;
		const parentPrompt = `You are pi, run ${n}.\n# Tools\n- read`;
		mkdirSync(STORE_DIR(), { recursive: true });
		writeFileSync(join(STORE_DIR(), `${parentId}.json`), JSON.stringify({
			version: 1,
			sessionId: parentId,
			captures: [{ assembledPrompt: parentPrompt, contextFiles: [{ path: "/repo/AGENTS.md", content: `rule ${n}` }], skills: [], source: "turn_start" }],
		}));
		const key = `${parentPrompt}\n\n<subagent_instructions>\nfresh-${n}\n</subagent_instructions>`;
		assert.throws(() => __test.promptCaptures.resolveOrDerive(key), /no capture for this/);
		const handlers = activateWithMockPi();
		const childId = `child-${n}`;
		handlers.get("session_start")({ type: "session_start", reason: "startup" }, ctxFor(session(childId, { parentSession: sessionFile(parentId) }), CHILD_OWN_PROMPT));
		const projected = project(__test.promptCaptures.resolveOrDerive(key));
		assert.match(projected, new RegExp(`rule ${n}`));
		assert.match(projected, new RegExp(`fresh-${n}`));
	});

	it("writes the store owner-only, and nothing for a session pi does not persist", () => {
		const parentId = `parent-${++n}`;
		parentTurn(parentId);
		const file = join(STORE_DIR(), `${parentId}.json`);
		assert.ok(existsSync(file));
		assert.equal(statSync(file).mode & 0o777, 0o600);
		const stored = JSON.parse(readFileSync(file, "utf8"));
		assert.equal(stored.sessionId, parentId);
		assert.deepEqual(stored.captures.map((c) => c.assembledPrompt), [PARENT_PROMPT]);

		const ephemeral = `ephemeral-${++n}`;
		parentTurn(ephemeral, { persisted: false });
		assert.equal(existsSync(join(STORE_DIR(), `${ephemeral}.json`)), false);
	});

	it("loads nothing when the header names no parent, the parent file is gone, or the parent stored nothing", () => {
		const child = new PromptCaptures();
		assert.equal(loadParentCaptures(undefined, "c", child), 0);
		assert.equal(loadParentCaptures("/nonexistent/session.jsonl", "c", child), 0);
		assert.equal(loadParentCaptures(sessionFile(`never-ran-${++n}`), "c", child), 0);
		assert.equal(child.size, 0);
	});

	it("loads nothing from a malformed or foreign store file, without throwing", () => {
		const write = (id, content) => {
			mkdirSync(STORE_DIR(), { recursive: true });
			writeFileSync(join(STORE_DIR(), `${id}.json`), typeof content === "string" ? content : JSON.stringify(content));
		};
		const good = { assembledPrompt: "P", contextFiles: [], skills: [] };
		const cases = {
			truncated: "{\"version\":1,",
			otherVersion: { version: 2, sessionId: "otherVersion", captures: [good] },
			otherSession: { version: 1, sessionId: "someone-else", captures: [good] },
			badCustom: { version: 1, sessionId: "badCustom", captures: [{ ...good, custom: 42 }] },
			badContextFile: { version: 1, sessionId: "badContextFile", captures: [{ ...good, contextFiles: [{ path: "/a" }] }] },
			badSections: { version: 1, sessionId: "badSections", captures: [{ ...good, sections: { x: 1 } }] },
			oneBadOfTwo: { version: 1, sessionId: "oneBadOfTwo", captures: [good, { assembledPrompt: "Q", contextFiles: [], skills: "no" }] },
		};
		const child = new PromptCaptures();
		for (const [id, content] of Object.entries(cases)) {
			write(id, content);
			assert.equal(loadParentCaptures(sessionFile(id), "c", child), 0, id);
		}
		assert.equal(child.size, 0);
	});

	it("does not replace a capture the child's registry already holds", () => {
		const parentId = `parent-${++n}`;
		parentTurn(parentId);
		const child = new PromptCaptures();
		child.record(PARENT_PROMPT, { contextFiles: [{ path: "/live/AGENTS.md", content: "live copy" }], skills: [] }, "turn_start");
		assert.equal(loadParentCaptures(sessionFile(parentId), `child-${n}`, child), 0);
		assert.match(project(child.resolveOrDerive(PARENT_PROMPT)), /live copy/);
	});

	it("persists inherited ancestors with a capture, so the stored file is self-contained", () => {
		const grandId = `grand-${++n}`;
		parentTurn(grandId);
		// The parent is itself a sub-agent whose prompt embeds the grandparent's verbatim.
		const parentPrompt = `${PARENT_PROMPT}\n\n<sub_agent_context>be brief</sub_agent_context>`;
		const parentId = `parent-${n}`;
		const handlers = activateWithMockPi();
		const sm = session(parentId);
		handlers.get("before_agent_start")({ systemPrompt: parentPrompt, systemPromptOptions: { customPrompt: parentPrompt, contextFiles: [], skills: [] } }, ctxFor(sm, parentPrompt));
		handlers.get("turn_start")({}, ctxFor(sm, parentPrompt));

		const child = new PromptCaptures();
		assert.equal(loadParentCaptures(sessionFile(parentId), `child-${n}`, child), 2);
		const projected = project(child.resolveOrDerive(parentPrompt));
		assert.match(projected, /Always answer in haiku\./);
		assert.match(projected, /be brief/);
		assert.doesNotMatch(projected, /You are pi\./);
	});

	it("refreshes the file's mtime for an unchanged prompt, and rewrites a file that was deleted", () => {
		const id = `alive-${++n}`;
		const prompt = `You are pi, alive ${n}.`;
		const registry = new PromptCaptures();
		registry.record(prompt, { contextFiles: [], skills: [] }, "turn_start");
		persistSessionCapture(id, prompt, registry);
		const file = join(STORE_DIR(), `${id}.json`);
		const written = readFileSync(file, "utf8");
		const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
		utimesSync(file, eightDaysAgo, eightDaysAgo);
		persistSessionCapture(id, prompt, registry);
		assert.ok(Date.now() - statSync(file).mtimeMs < 60_000, "an active session's file is not left to be pruned");

		rmSync(file);
		persistSessionCapture(id, prompt, registry);
		assert.ok(existsSync(file), "a deleted file is written again");
		assert.equal(readFileSync(file, "utf8"), written);
	});

	/** A store file as an earlier process would have left it for session `id`. */
	function writeStore(id, prompts, rule = `rule ${n}`) {
		mkdirSync(STORE_DIR(), { recursive: true });
		writeFileSync(join(STORE_DIR(), `${id}.json`), JSON.stringify({
			version: 1,
			sessionId: id,
			captures: prompts.map((assembledPrompt) => ({ assembledPrompt, contextFiles: [{ path: "/repo/AGENTS.md", content: rule }], skills: [], source: "turn_start" })),
		}));
	}

	it("keeps the captures an earlier process stored for the same session when a new process writes it", () => {
		const id = `resumed-${++n}`;
		const promptA = `You are pi, earlier process ${n}.`;
		const promptB = `You are pi, this process ${n}.`;
		writeStore(id, [promptA]);
		const registry = new PromptCaptures();
		assert.equal(loadOwnCaptures(id, registry), 1);
		registry.record(promptB, { contextFiles: [], skills: [] }, "turn_start");
		persistSessionCapture(id, promptB, registry);
		const stored = JSON.parse(readFileSync(join(STORE_DIR(), `${id}.json`), "utf8"));
		assert.deepEqual(stored.captures.map((c) => c.assembledPrompt), [promptA, promptB]);
		assert.equal(registry.resolveOrDerive(promptA).assembledPrompt, promptA);
	});

	it("loads the session's own stored captures at session_start", () => {
		const id = `own-${++n}`;
		const prompt = `You are pi, resumed run ${n}.\n# Tools\n- read`;
		writeStore(id, [prompt], `own rule ${n}`);
		assert.throws(() => __test.promptCaptures.resolveOrDerive(prompt), /no capture for this/);
		const handlers = activateWithMockPi();
		handlers.get("session_start")({ type: "session_start", reason: "resume" }, ctxFor(session(id), prompt));
		assert.match(project(__test.promptCaptures.resolveOrDerive(prompt)), new RegExp(`own rule ${n}`));
	});
});
