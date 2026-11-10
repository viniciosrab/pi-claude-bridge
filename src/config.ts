// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/claude-bridge.json,
// or the file CLAUDE_BRIDGE_CONFIG names) and the project Pi config directory. `provider` is read
// from the global file only: a cloned repo could otherwise point the bridge
// at its own Claude Code executable, load its own Claude Code settings or turn
// on metered billing. Only the one-time notice mark still reads the project
// file. Unknown sections (such as the removed `askClaude`) are ignored. Missing
// or unparseable files are ignored (error to console.error, empty object
// returned) so the extension always starts.

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

export interface Config {
	/** Date (YYYY-MM-DD) the one-time startup notice was shown. Written by the extension, not the user. */
	startupNoticeShown?: string;
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

/** Record today's date in the global config so the startup notice shows once, preserving every
 *  other field. Returns the config path for display either way.
 *
 *  Parses directly rather than through tryParseJson, which reports an unparseable file as `{}`:
 *  spreading that would replace a user's whole config with just this marker the first time they
 *  leave a trailing comma in it. Losing the notice is the cheaper failure, so the write is
 *  skipped and the notice simply shows again next session. */
export function markStartupNoticeShown(): string {
	const path = globalConfigPath();
	let existing: Partial<Config> = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf-8"));
		} catch (e) {
			console.error(`claude-bridge: leaving ${path} alone, it does not parse: ${e}`);
			return path;
		}
	}
	// en-CA renders YYYY-MM-DD in local time; toISOString() would report UTC.
	const next = { ...existing, startupNoticeShown: new Date().toLocaleDateString("en-CA") };
	// Temp file and rename: writing in place empties the user's config first, and a pi
	// starting in that moment would read it as unparseable and run without its settings.
	// The rename lands on the symlink's target, with its permissions, so a config kept in
	// a dotfiles repo stays linked and a private one stays private. Best effort, like the
	// parse failure above: a config that cannot be rewritten only shows the notice again.
	let tmp: string | undefined;
	try {
		const target = writeTarget(path);
		mkdirSync(dirname(target), { recursive: true });
		const mode = existsSync(target) ? statSync(target).mode & 0o777 : undefined;
		tmp = `${target}.${process.pid}.tmp`;
		// Owner-only while the contents land, so a private config is never readable in
		// between; then the target's own mode, set explicitly because the umask masks
		// writeFileSync's mode.
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		if (mode !== undefined) chmodSync(tmp, mode);
		renameSync(tmp, target);
	} catch (e) {
		if (tmp) rmSync(tmp, { force: true });
		console.error(`claude-bridge: could not record the startup notice in ${path}: ${e}`);
	}
	return path;
}

/** The file a rewrite of `path` must replace: the end of its symlink chain, also a chain
 *  whose last target does not exist yet, so the rename never replaces a link. */
function writeTarget(path: string): string {
	if (existsSync(path)) return realpathSync(path);
	let target = path;
	// A bound, like the kernel's, so a link cycle cannot loop forever.
	for (let hops = 0; hops < 40; hops++) {
		try {
			if (!lstatSync(target).isSymbolicLink()) break;
		} catch {
			break; // the chain ends at a file that does not exist yet
		}
		target = resolve(dirname(target), readlinkSync(target));
	}
	return target;
}

/** The notice for a user whose global config still turns on the removed AskClaude tool,
 *  or undefined. Shown until the section is gone, so no marker has to be written for it. */
export function removedAskClaudeNotice(): string | undefined {
	const path = globalConfigPath();
	const askClaude = (tryParseJson(path) as { askClaude?: { enabled?: unknown } }).askClaude;
	if (askClaude?.enabled !== true) return undefined;
	return `AskClaude was removed from pi-claude-bridge; its settings are ignored. Select a claude-bridge model with /model to use Claude, and delete the "askClaude" section from ${path} to hide this notice.`;
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(globalConfigPath());
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	return {
		startupNoticeShown: project.startupNoticeShown ?? global.startupNoticeShown,
		provider: { ...global.provider },
	};
}
