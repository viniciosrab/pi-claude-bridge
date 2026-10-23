// Fork-only additions of @viniciosrab/pi-claude-bridge.
//
// The fork's npm mirror cherry-picks its fix commits onto every upstream release, and
// any upstream edit next to a line those commits touch stops the release. So the fork's
// code lives here, in a file upstream never edits, and src/index.ts only carries
// one-line hooks into it: one import and one call per feature. Keep it that way: do not
// edit upstream lines (shared imports, the Config interface, upstream tests or README),
// add a hook line next to them instead.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getSessionPath } from "cc-session-io";
import { readFileSync, statSync } from "node:fs";

/** Provider settings only the fork reads, from `provider` in claude-bridge.json. */
export interface ForkProviderSettings {
	// Set to false to stop the provider's Claude Code subprocess from loading
	// user/project/local settings (hooks, plugins, env, apiKeyHelper).
	loadClaudeSettings?: boolean;
	// Set to false to hide the Claude rate-limit notices (usage warnings and
	// "rate limit reached") shown in pi. Failures are still named as rate limits.
	rateLimitWarnings?: boolean;
}

// Config["provider"] does not declare the fork's keys, but loadConfig keeps every key
// of the JSON, so they are read through this cast rather than by editing config.ts.
function forkSettings(provider: object | undefined): ForkProviderSettings {
	return (provider ?? {}) as ForkProviderSettings;
}

/** Provider-path `settingSources` override. Absent keeps the SDK default (all sources);
 *  `loadClaudeSettings: false` passes an empty list so no settings files are loaded. */
export function providerSettingSourcesOption(provider?: object): { settingSources?: [] } {
	return forkSettings(provider).loadClaudeSettings === false ? { settingSources: [] } : {};
}

/** Whether to show the Claude rate-limit notices in pi. Absent keeps them on;
 *  `rateLimitWarnings: false` hides them. */
export function rateLimitNoticesEnabled(provider?: object): boolean {
	return forkSettings(provider).rateLimitWarnings !== false;
}

// Upstream's rate-limit notices all read "Claude ... rate limit ..." ("Claude rate limit
// warning: 80% used", "Claude subscription rate limit reached"). Filtering on the text
// keeps the hook out of consumeQuery, which upstream rewrites often;
// unit-rate-limit-warnings.mjs fails if the wording drifts past this pattern.
const RATE_LIMIT_NOTICE = /^Claude\b.*\brate limit/i;

/** Wrap pi's UI so its rate-limit notices are dropped while `rateLimitWarnings` is
 *  false. Settings are read per notice because config reloads after the UI is set. */
export function withRateLimitNoticeFilter(
	ui: ExtensionUIContext | null,
	getProvider: () => object | undefined,
): ExtensionUIContext | null {
	if (!ui) return ui;
	return new Proxy(ui, {
		get(target, prop) {
			if (prop === "notify") {
				return (message: string, type?: Parameters<ExtensionUIContext["notify"]>[1]) => {
					if (RATE_LIMIT_NOTICE.test(message) && !rateLimitNoticesEnabled(getProvider())) return;
					target.notify(message, type);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

// CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: CC truncates each MCP tool description to
// 2,048 chars. Pi tools reach CC as MCP tools and pi already budgets their descriptions
// (codemode.inlineBudget); the cap cut codemode's nested-tool listing, hiding every
// codemode-exposed MCP server from Claude (issue #4). Overrides a user-set value on
// purpose, since a lower limit brings the bug back.
export const FORK_CHILD_ENV = {
	CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "1000000",
} as const;

/** Put FORK_CHILD_ENV on pi's own environment. Every Claude Code child the bridge
 *  spawns gets `{ ...process.env, ...CC_CHILD_ENV }`, so this reaches all of them
 *  without editing CC_CHILD_ENV, which upstream owns and pins in its own test. */
export function applyForkChildEnv(env: NodeJS.ProcessEnv = process.env): void {
	Object.assign(env, FORK_CHILD_ENV);
}

applyForkChildEnv();

// Resume after an abort. Upstream rebuilds Claude Code's session from pi's history after
// every abort, and a rebuilt file lacks the context blocks CC writes at the head of its own
// sessions, so the next request re-caches the whole conversation (diag/AUDIT.md, "since CC
// 2.1.263"). Native Claude Code resumes its own file after Esc, Ctrl-C or SIGTERM and reads
// the cache back; past a settle window, the bridge does the same.

/** How long after an abort its killed CLI may still write to the session file. The SDK
 *  closes stdin and force-kills about 2 s later; a sync inside this window rebuilds on a
 *  rotated id, as upstream does after every abort, rather than share the file. */
export const ABORT_SETTLE_MS = 3_000;

/** The fields an abort leaves on a session mirror for the next sync. */
export interface AbortMark {
	abortedAt?: number;
	// The aborted query's prompt and the size of CC's session file when that query
	// started: the resume checks CC wrote the prompt past that point, since a CLI
	// killed before writing it leaves a file that lacks the prompt.
	abortedPrompt?: string;
	abortedFileOffset?: number;
}

/** What a query records at its start, for the abort mark should it be aborted. */
export interface AbortedTurn {
	prompt: string;
	resumedId: string | null;
	fileOffset: number;
}

function sessionFileSize(sessionId: string, cwd: string): number {
	try {
		return statSync(getSessionPath(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR)).size;
	} catch {
		return 0;
	}
}

/** The prompt CC must write for this query (its first text block when it carries
 *  images) and where the resumed session file stood before it. */
export function abortedTurnAtStart(promptBlocks: { type: string }[] | null, promptText: string, resumedId: string | null, cwd: string): AbortedTurn {
	const prompt = promptBlocks ? ((promptBlocks.find((b) => b.type === "text") as { text?: string } | undefined)?.text ?? "") : promptText;
	return { prompt, resumedId, fileOffset: resumedId ? sessionFileSize(resumedId, cwd) : 0 };
}

/** The mark for an aborted query on session `sessionId`. A file the query did not
 *  resume started empty. */
export function abortMark(turn: AbortedTurn, sessionId: string, now = Date.now()): Required<AbortMark> {
	return { abortedAt: now, abortedPrompt: turn.prompt, abortedFileOffset: sessionId === turn.resumedId ? turn.fileOffset : 0 };
}

/** Whether CC wrote the aborted prompt to its session file past the recorded offset.
 *  Records are JSON lines, so the prompt appears JSON-escaped. */
function abortedPromptPersisted(sessionId: string, mark: AbortMark, cwd: string): boolean {
	if (!mark.abortedPrompt) return false;
	try {
		const tail = readFileSync(getSessionPath(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR)).subarray(mark.abortedFileOffset ?? 0).toString("utf8");
		return tail.includes(JSON.stringify(mark.abortedPrompt).slice(1, -1));
	} catch {
		return false;
	}
}

/** How the sync after an abort proceeds. `undefined`: no abort mark, or a history
 *  rewrite already forces a rebuild. `"resume"`: the settle window has passed, CC wrote
 *  the aborted prompt, and every message pi has past the cursor belongs to the aborted
 *  turn (its partial answer, tool calls and their results). `"rebuild"`: anything else,
 *  including a user message CC never saw. */
export function postAbortSync(
	state: (AbortMark & { sessionId: string; cursor: number; needsRebuild?: boolean }) | null,
	priorMessages: { role?: string }[],
	cwd: string,
	now = Date.now(),
): "resume" | "rebuild" | undefined {
	if (!state || state.abortedAt === undefined || state.needsRebuild) return undefined;
	const resumable = now - state.abortedAt >= ABORT_SETTLE_MS
		&& priorMessages.length >= state.cursor
		&& priorMessages.slice(state.cursor).every((m) => m.role !== "user")
		&& abortedPromptPersisted(state.sessionId, state, cwd);
	return resumable ? "resume" : "rebuild";
}
