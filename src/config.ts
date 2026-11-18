// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/claude-bridge.json,
// or the file CLAUDE_BRIDGE_CONFIG names). `provider` is read
// from the global file only: a cloned repo could otherwise point the bridge
// at its own Claude Code executable, load its own Claude Code settings or turn
// on metered billing, so the project file is not read at all. Unknown keys (such
// as the removed `askClaude` section or `startupNoticeShown` mark) are ignored. Missing
// or unparseable files are ignored (error to console.error, empty object
// returned) so the extension always starts.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface Config {
	/** Low-level Claude Agent SDK plumbing. Most users won't need these. */
	provider?: {
		strictMcpConfig?: boolean;
		autoMemoryEnabled?: boolean;
		pathToClaudeCodeExecutable?: string;
		// Subscription plan tier. Setting to "max" enables Opus 4.6 at 1M context
		plan?: "pro" | "max";
		// Set to true to opt into metered 1M context usage ("extra usage" in
		// Anthropic billing). Enables Sonnet 4.6 [1m] on every plan and Opus 4.6
		// [1m] on Pro.
		longContextExtraUsage?: boolean;
		// Model ids (e.g. "claude-future-9") whose declared 1M context Claude Code
		// does not actually serve; pins them to the bare id at 200K.
		forceTwoHundredK?: string[];
		// Claude Code's own `claude_code` preset goes first, with pi's whole system
		// prompt as its append. On by default; false sends pi's prompt alone as a plain
		// string. Upstream's spellings are accepted too: "claude_code" means on, null off.
		systemPromptPreset?: boolean | "claude_code" | null;
	};
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		// Valid JSON is not necessarily a config: `null` would throw at the first field read.
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Partial<Config>;
		console.error(`claude-bridge: ignoring ${path}, it is not a JSON object`);
		return {};
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

// CLAUDE_BRIDGE_CONFIG names another file to use as the global config, so a test or a
// wrapper script can supply one without replacing pi's agent dir (and its login).
export function globalConfigPath(): string {
	return process.env.CLAUDE_BRIDGE_CONFIG || join(getAgentDir(), "claude-bridge.json");
}

/** The notice for a user whose global config still turns on the removed AskClaude tool,
 *  or undefined. Shown until the section is gone, so no marker has to be written for it. */
export function removedAskClaudeNotice(): string | undefined {
	const path = globalConfigPath();
	const askClaude = (tryParseJson(path) as { askClaude?: { enabled?: unknown } }).askClaude;
	if (askClaude?.enabled !== true) return undefined;
	return `AskClaude was removed from pi-claude-bridge; its settings are ignored. Select a claude-bridge model with /model to use Claude, and delete the "askClaude" section from ${path} to hide this notice.`;
}

/** Whether the provider path sends Claude Code's preset with pi's prompt as its append
 *  (default) or pi's prompt alone as a plain string. */
export function systemPromptPresetEnabled(provider: Config["provider"] = {}): boolean {
	return provider.systemPromptPreset !== false && provider.systemPromptPreset !== null;
}

// Warnings already printed, process-wide: the config is loaded again on every
// compaction and branch summary, and a module instance a worktree subagent loads
// fresh would print its own copy. A different value (the user edited it) is new.
const WARNED_KEY = Symbol.for("claude-bridge:configWarnings");
function warnOnce(message: string): void {
	const g = globalThis as Record<symbol, Set<string> | undefined>;
	const warned = (g[WARNED_KEY] ??= new Set());
	if (warned.has(message)) return;
	warned.add(message);
	console.error(message);
}

export function loadConfig(): Config {
	const global = tryParseJson(globalConfigPath());
	const provider = { ...global.provider };
	const preset: unknown = provider.systemPromptPreset;
	// Reported and dropped rather than thrown: the extension always starts, and an unknown
	// value keeps the default, the preset on.
	if (preset !== undefined && preset !== null && typeof preset !== "boolean" && preset !== "claude_code") {
		warnOnce(`claude-bridge: ignoring provider.systemPromptPreset ${JSON.stringify(preset)} in ${globalConfigPath()}: use true (default, or "claude_code") or false (or null)`);
		delete provider.systemPromptPreset;
	}
	return { provider };
}
