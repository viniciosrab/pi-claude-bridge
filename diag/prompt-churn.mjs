#!/usr/bin/env node
// How often does a pi session's system prompt change, and where?
//
// Forwarding pi's whole system prompt (upstream #262) keys Claude Code's session on
// the whole prompt, so every change rebuilds it and re-caches the conversation.
// Today the bridge forwards only the portable parts (custom, append, context files,
// skills, sections). This reads the prompt captures the bridge already stores per pi
// session (claude-bridge-captures/ in pi's agent dir, kept 7 days) and reports, per
// session, how many distinct whole prompts it used against how many distinct
// portable projections, plus which section each whole-prompt change fell in.
// A store file does not say which captures are the session's own and which it
// inherited from a parent session, so the counts are reported twice: dropping every
// capture another one of the file contains (an inherited parent is embedded in its
// child; a lower bound, since a prompt that only grew is dropped too) and keeping
// every capture (an upper bound, since inherited parents count as changes).
// Prints counts and section names only, never prompt text.
//
//   node diag/prompt-churn.mjs [captures-dir]

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const dir = process.argv[2] ?? join(agentDir, "claude-bridge-captures");

const portable = (c) => JSON.stringify([c.custom ?? null, c.append ?? null, c.contextFiles, c.skills, c.sections ?? null]);

/** Name of the innermost `<tag>` still open at `offset`, or "(preamble)". */
function sectionAt(text, offset) {
	const open = [];
	for (const m of text.slice(0, offset).matchAll(/<(\/?)([a-z_][\w-]*)(?:\s[^>]*)?>/gi)) {
		if (m[1]) { const i = open.lastIndexOf(m[2]); if (i !== -1) open.length = i; }
		else open.push(m[2]);
	}
	return open.at(-1) ?? "(preamble)";
}

function firstDiff(a, b) {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
	return n;
}

const files = [];
for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
	try { files.push(JSON.parse(readFileSync(join(dir, name), "utf8")).captures ?? []); } catch {}
}

function report(label, keepContained) {
	const rows = [];
	const changeSections = new Map();
	for (const all of files) {
		const own = keepContained ? all : all.filter((c) => !all.some((o) => o !== c && o.assembledPrompt.length > c.assembledPrompt.length && o.assembledPrompt.includes(c.assembledPrompt)));
		if (own.length === 0) continue;
		const prompts = [...new Set(own.map((c) => c.assembledPrompt))];
		const projections = new Set(own.map(portable));
		for (let i = 1; i < prompts.length; i++) {
			const section = sectionAt(prompts[i], firstDiff(prompts[i - 1], prompts[i]));
			changeSections.set(section, (changeSections.get(section) ?? 0) + 1);
		}
		rows.push({ prompts: prompts.length, projections: projections.size, chars: Math.max(...prompts.map((p) => p.length)) });
	}
	const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
	const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
	console.log(`== ${label}`);
	console.log(`sessions: ${rows.length} (captures dir: ${dir})`);
	console.log(`whole prompt chars: median ${median(rows.map((r) => r.chars))}, max ${Math.max(0, ...rows.map((r) => r.chars))}`);
	console.log(`sessions whose whole prompt changed: ${rows.filter((r) => r.prompts > 1).length}; whole-prompt changes: ${sum((r) => r.prompts - 1)}`);
	console.log(`portable-projection changes (what rebuilds today): ${sum((r) => r.projections - 1)}`);
	const extra = rows.filter((r) => r.prompts > r.projections);
	console.log(`sessions where the whole prompt changed more often than the projection: ${extra.length} (+${sum((r) => r.prompts - r.projections)} changes)`);
	console.log("section where each whole-prompt change starts:");
	for (const [section, n] of [...changeSections].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${section}`);
}

report("dropping contained captures (lower bound)", false);
report("keeping every capture (upper bound)", true);
