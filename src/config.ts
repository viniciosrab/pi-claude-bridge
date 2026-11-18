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

export function loadConfig(): Config {
	const global = tryParseJson(globalConfigPath());
	return { provider: { ...global.provider } };
}
