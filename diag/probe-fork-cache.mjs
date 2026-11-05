#!/usr/bin/env node
// Does a Claude Code fork of a session read the parent's conversation back from the
// prompt cache? Builds a two-turn session A on the provider path (no tools), then
// prompts each way of continuing from it and prints the first request's usage:
//
//   reuse        resume A itself (control: reads the whole conversation)
//   sdk-fork     SDK forkSession(A), then resume the copy
//   opt-fork     resume A with the query options forkSession: true
//   sdk-fork-mid forkSession(A, { upToMessageId: turn 1's last entry }), resume
//   opt-fork-mid resume A, forkSession: true, resumeSessionAt: turn 1's last entry
//   rebuild      a cc-session-io file holding A's messages (control: floor only)
//
// The mid forks are compared with turn 2 of A, whose request was turn 1 plus a prompt.
// Run outside the sandbox: node diag/probe-fork-cache.mjs [model]

import { forkSession, query } from "@anthropic-ai/claude-agent-sdk";
import { createSession, getSessionPath } from "cc-session-io";
import { readFileSync } from "node:fs";

const CWD = process.cwd();
const MODEL = process.argv[2] ?? "claude-haiku-4-5";
const PAD = Array.from({ length: 600 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join("\n");

function options(extra = {}) {
	return {
		cwd: CWD,
		model: MODEL,
		tools: [],
		permissionMode: "bypassPermissions",
		env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" },
		extraArgs: { "strict-mcp-config": null },
		settings: { includeGitInstructions: false },
		maxTurns: 1,
		...extra,
	};
}

/** Runs one prompt; returns the session id and the first API request's usage. */
async function turn(prompt, extra) {
	let sessionId, usage;
	for await (const m of query({ prompt, options: options(extra) })) {
		if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
		if (m.type === "assistant" && !usage) usage = m.message.usage;
	}
	return { sessionId, usage };
}

function show(label, usage) {
	const { input_tokens: i = 0, cache_read_input_tokens: r = 0, cache_creation_input_tokens: w = 0 } = usage ?? {};
	console.log(`${label.padEnd(13)} input=${i} cacheRead=${r} cacheWrite=${w} total=${i + r + w}`);
}

function records(sessionId) {
	return readFileSync(getSessionPath(sessionId, CWD, process.env.CLAUDE_CONFIG_DIR), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

const t1 = await turn(`Remember this text, then reply with just "ok".\n\n${PAD}`);
show("A turn 1", t1.usage);
const A = t1.sessionId;
// Turn 1's last chain entry: the fork point of a fork before turn 2.
const turn1Last = records(A).filter((r) => r.uuid && (r.type === "user" || r.type === "assistant")).at(-1).uuid;
const t2 = await turn("What is line 7? Answer in five words.", { resume: A });
show("A turn 2", t2.usage);

const next = "Reply with just the word: done.";
const f1 = await forkSession(A, { dir: CWD });
show("sdk-fork", (await turn(next, { resume: f1.sessionId })).usage);
show("opt-fork", (await turn(next, { resume: A, forkSession: true })).usage);
const f2 = await forkSession(A, { dir: CWD, upToMessageId: turn1Last });
show("sdk-fork-mid", (await turn(next, { resume: f2.sessionId })).usage);
show("opt-fork-mid", (await turn(next, { resume: A, forkSession: true, resumeSessionAt: turn1Last })).usage);

// Control: what the bridge does today, a file rebuilt from the messages alone.
const rebuilt = createSession({ projectPath: CWD, claudeDir: process.env.CLAUDE_CONFIG_DIR, model: MODEL });
for (const r of records(A)) {
	if (r.type !== "user" && r.type !== "assistant") continue;
	if (r.isMeta) continue;
	const content = r.message?.content;
	if (r.type === "user") rebuilt.addUserMessage(typeof content === "string" ? content : content);
	else rebuilt.addAssistantMessage(content);
}
rebuilt.save();
show("rebuild", (await turn(next, { resume: rebuilt.sessionId })).usage);
console.log(`A=${A} parent turns read: turn-2 request ≈ ${(t2.usage.cache_read_input_tokens ?? 0) + (t2.usage.cache_creation_input_tokens ?? 0) + (t2.usage.input_tokens ?? 0)} tokens`);
