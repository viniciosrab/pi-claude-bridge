#!/usr/bin/env node
// Fork-only executable contracts: undocumented Claude Code behavior the fork's own
// code relies on, asserted against the installed CC + SDK. Kept out of upstream's
// tests/int-cc-contracts.mjs so the fork's commits never edit an upstream file.
//
// Requires: ANTHROPIC_API_KEY or CC logged in. Must run OUTSIDE the sandbox —
// CC persists session state under ~/.claude.

import { test } from "node:test";
import assert from "node:assert/strict";
import { forkSession, query } from "@anthropic-ai/claude-agent-sdk";
import { getSessionPath } from "cc-session-io";
import { readFileSync, statSync } from "node:fs";
import { ABORT_SETTLE_MS, trackCliProcess } from "../src/fork.js";

const CWD = process.cwd();
const MODEL = "claude-haiku-4-5";

/** Options of a provider-path query: no tools, no MCP, one turn. */
function providerOptions(extra = {}) {
	return {
		cwd: CWD,
		model: MODEL,
		tools: [],
		permissionMode: "bypassPermissions",
		env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" },
		extraArgs: { "strict-mcp-config": null },
		maxTurns: 1,
		...extra,
	};
}

/** The query's result message. */
async function resultOf(q) {
	let result = null;
	for await (const message of q) {
		if (message.type === "result") result = message;
	}
	return result;
}

test("an aborted CLI exits on its own within the settle bound and writes nothing after its exit", { timeout: 180_000 }, async () => {
	// The turn after an abort resumes CC's session file once the aborted CLI has
	// exited (src/fork.ts postAbortSync), waiting at most ABORT_SETTLE_MS for it.
	// Pin that the CLI goes on stdin EOF well inside that bound rather than at the
	// SDK's SIGTERM (~2 s) or SIGKILL (~7 s), through the spawner the bridge
	// installs, and that the exit is the last write: the file is final by then.
	const prompt = "Count from 1 to 2000, numbers separated by single spaces, nothing else.";
	const options = providerOptions({ includePartialMessages: true });
	const turn = { prompt, resumedId: null, fileOffset: 0 };
	trackCliProcess(options, turn);
	const q = query({ prompt, options });
	let sessionId, abortedAt, aborted = false;
	for await (const message of q) {
		if (message.type === "system" && message.subtype === "init") sessionId = message.session_id;
		if (aborted) break; // consumeQuery: stop at the next message after an abort
		if (message.type === "stream_event" && message.event.type === "content_block_delta") {
			// src/index.ts requestAbort: interrupt, then close.
			aborted = true;
			abortedAt = performance.now();
			void q.interrupt().catch(() => {});
			try { q.close(); } catch {}
		}
	}
	const iteratorMs = performance.now() - abortedAt;
	assert.ok(aborted, "the turn streamed no text to abort on");
	assert.ok(turn.process?.spawned, "the SDK did not launch the CLI through the tracked spawner");
	let bound;
	await Promise.race([turn.process.exit, new Promise((resolve) => { bound = setTimeout(resolve, ABORT_SETTLE_MS); })]);
	clearTimeout(bound);
	const exitMs = performance.now() - abortedAt;
	assert.ok(turn.process.exited, `the aborted CLI was still alive ${ABORT_SETTLE_MS}ms after the abort`);

	const file = getSessionPath(sessionId, CWD, process.env.CLAUDE_CONFIG_DIR);
	const atExit = statSync(file);
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	const later = statSync(file);
	console.log(`aborted CLI: exit observed +${Math.round(exitMs)}ms, SDK iterator ended +${Math.round(iteratorMs)}ms; session file ${atExit.size} bytes at exit, ${later.size} 2s later`);
	assert.ok(exitMs < 1_500, `the CLI took ${Math.round(exitMs)}ms to exit: it no longer goes on stdin EOF before the SDK's SIGTERM`);
	assert.equal(later.size, atExit.size, "the session file grew after the CLI exited");
	assert.equal(later.mtimeMs, atExit.mtimeMs, "the session file was written after the CLI exited");
	assert.ok(readFileSync(file, "utf8").includes(JSON.stringify(prompt).slice(1, -1)), "the aborted prompt is not on file");

	const resumed = await resultOf(query({ prompt: "Reply OK.", options: providerOptions({ resume: sessionId }) }));
	assert.equal(resumed?.subtype, "success", `resuming the aborted session failed: ${JSON.stringify(resumed)}`);
	assert.equal(resumed.session_id, sessionId);
});

test("a resumed result's duration_api_ms is the session's running total, its duration_ms this turn's", { timeout: 180_000 }, async () => {
	// The fork's debug timing line subtracts the total it last saw for the CC
	// session (src/fork-turn-timing.ts). If CC ever reports API time per turn,
	// that subtraction would log near-zero turns, so pin both fields. Turn 1 is
	// long and turn 2 short: a per-turn API time can never exceed its own turn.
	const turn = async (prompt, resume) => {
		const startedAt = performance.now();
		const result = await resultOf(query({ prompt, options: providerOptions(resume ? { resume } : {}) }));
		assert.equal(result?.subtype, "success", `turn failed: ${JSON.stringify(result)}`);
		return { result, wallMs: performance.now() - startedAt };
	};

	const first = await turn("Count from 1 to 80, numbers separated by single spaces, nothing else.");
	const second = await turn("Reply OK.", first.result.session_id);
	const [r1, r2] = [first.result, second.result];
	console.log(`turn 1: duration_ms=${r1.duration_ms} duration_api_ms=${r1.duration_api_ms}; turn 2 (resumed): duration_ms=${r2.duration_ms} duration_api_ms=${r2.duration_api_ms} wall=${Math.round(second.wallMs)}ms`);

	assert.equal(r2.session_id, r1.session_id, "the resume did not continue the same CC session");
	assert.ok(r2.duration_ms <= second.wallMs, `duration_ms ${r2.duration_ms} exceeds turn 2's own wall time ${Math.round(second.wallMs)}ms: no longer per turn`);
	assert.ok(r2.duration_api_ms > r1.duration_api_ms, `duration_api_ms ${r2.duration_api_ms} did not grow past turn 1's ${r1.duration_api_ms}: no longer a running total`);
	assert.ok(r2.duration_api_ms > r2.duration_ms, `duration_api_ms ${r2.duration_api_ms} fits inside turn 2's ${r2.duration_ms}ms: it may be per turn now`);
	assert.ok(r2.duration_api_ms - r1.duration_api_ms <= r2.duration_ms,
		`the growth ${r2.duration_api_ms - r1.duration_api_ms}ms exceeds turn 2's duration_ms ${r2.duration_ms}: the difference is not this turn's API time`);
});

test("a forkSession copy of a session cut at a turn's last entry reads the conversation back from the cache", { timeout: 300_000 }, async () => {
	// A pi session made by /fork starts from the SDK's forkSession of its parent's CC
	// session, cut at the last entry the kept turn left (src/fork.ts startFromParentFork),
	// instead of a rebuild, which re-caches the conversation. Pin that the copy gets a
	// new id, leaves the parent's file untouched, and reproduces the parent's request
	// bytes: resumed, its first request reads back all the parent's turn 2 wrote.
	const firstUsage = async (prompt, extra) => {
		let sessionId, usage;
		for await (const m of query({ prompt, options: providerOptions(extra) })) {
			if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
			if (m.type === "assistant" && !usage) usage = m.message.usage;
		}
		return { sessionId, usage };
	};
	const pad = Array.from({ length: 400 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join("\n");
	const { sessionId } = await firstUsage(`Remember this text, then reply with just "ok".\n\n${pad}`);
	const second = await firstUsage("What is line 7? Answer in five words.", { resume: sessionId });
	const file = getSessionPath(sessionId, CWD, process.env.CLAUDE_CONFIG_DIR);
	const parentBytes = readFileSync(file, "utf8");
	const lastEntry = parentBytes.trim().split("\n").map((l) => JSON.parse(l)).filter((r) => typeof r.uuid === "string").at(-1).uuid;

	const fork = await forkSession(sessionId, { dir: CWD, upToMessageId: lastEntry });
	assert.notEqual(fork.sessionId, sessionId, "the fork took the parent's session id");
	const forked = await firstUsage("Reply with just the word: done.", { resume: fork.sessionId });
	assert.equal(readFileSync(file, "utf8"), parentBytes, "forking or resuming the fork wrote the parent's file");

	// What the parent's turn 2 left in the cache: the prefix up to its breakpoint.
	const written = (u) => (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
	console.log(`parent turn 2 cached: ${written(second.usage)} tokens; fork's first request: cacheRead=${forked.usage.cache_read_input_tokens} cacheWrite=${forked.usage.cache_creation_input_tokens}`);
	assert.ok(forked.usage.cache_read_input_tokens >= written(second.usage),
		`the fork read ${forked.usage.cache_read_input_tokens} tokens from the cache, less than the ${written(second.usage)} the parent's turn 2 wrote: its request bytes differ from the parent's`);
});
