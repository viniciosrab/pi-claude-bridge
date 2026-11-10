// fork: pi 1.5 preamble guard. Fork-only, in a file of its own like src/fork.ts.
//
// Upstream's prompt guard (assertSendablePrompt in src/prompt-capture.ts) refuses a
// prompt whose line starts with pi's preamble: forwarding pi's harness makes Claude
// Code's subscription path read the request as a third-party app, which fails with 400
// or is billed as extra usage (upstream issue #88). Pi 1.5.0 reworded that preamble, so
// upstream's PI_PREAMBLE matches nothing on pi >= 1.5. This adds the new wording; the
// docs-path pair half of upstream's guard still works on its own.

import { debugLogPath } from "./log-paths.js";

/** How pi's system prompt opens since pi 1.5.0. */
export const PI_PREAMBLES_SINCE_1_5 = ["You are a coding assistant running inside pi, a coding agent harness"];

/** Refuse `parts` when one carries a pi >= 1.5 preamble at a line start. Hooked right
 *  after upstream's guard, with the same parts, so it sees exactly what will be sent. */
export function assertNoPiPreamble(
	parts: readonly { label: string; text: string }[],
	capture: { source?: string; inherited: readonly unknown[] },
): void {
	const findings: string[] = [];
	for (const { label, text } of parts) {
		for (const preamble of PI_PREAMBLES_SINCE_1_5) {
			const offset = atLineStart(text, preamble);
			if (offset !== -1) findings.push(`pi's preamble ("${preamble}") in ${label}, at offset ${offset} of ${text.length} chars`);
		}
	}
	if (findings.length === 0) return;

	throw new Error([
		"prompt-capture: refusing to send this prompt. Claude Code's Anthropic path reads a request",
		"  carrying pi's harness as a third-party app: it fails with 400 or is billed as extra usage.",
		...findings.map((finding) => `  Found: ${finding}.`),
		`  Capture: ${capture.source ?? "unknown"}, ${capture.inherited.length} inherited capture(s) substituted.`,
		"  If this came from an inherited pi prompt, see \"Compatibility with other extensions\":",
		"  https://github.com/viniciosrab/pi-claude-bridge/blob/main/docs/reference.md#compatibility-with-other-extensions",
		"  If it is your own text, reword or remove it. CLAUDE_BRIDGE_DEBUG=1 writes the full prompt to",
		`  ${debugLogPath()}.`,
	].join("\n"));
}

/** Offset of `phrase` at the start of a line in `text`, or -1. A mid-line mention is
 *  someone describing pi's prompt, not pi's prompt. */
function atLineStart(text: string, phrase: string): number {
	for (let offset = text.indexOf(phrase); offset !== -1; offset = text.indexOf(phrase, offset + phrase.length)) {
		if (offset === 0 || text[offset - 1] === "\n") return offset;
	}
	return -1;
}
