// Where the bridge keeps the state it writes on its own: one `claude-bridge/` folder
// in pi's agent dir, so pi's root holds only configuration (claude-bridge.json stays
// there, beside settings.json and mcp.json). Earlier versions wrote this state straight
// into the root; migrateLegacyState moves it here.
//
//   claude-bridge/usage/<account>.json   plan usage shared across processes
//   claude-bridge/mirrors/<session>.json  pi session -> Claude Code session records
//   claude-bridge/logs/bridge.log         debug log (CLAUDE_BRIDGE_DEBUG=1)
//   claude-bridge/logs/diag.log           unconditional diagnostics
//   claude-bridge/logs/cc-cli-logs/       Claude Code's own debug logs
//
// Paths resolve per call, so tests can swap PI_CODING_AGENT_DIR mid-process.

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, linkSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function stateDir(): string {
	return join(getAgentDir(), "claude-bridge");
}

export function usageDir(): string {
	return join(stateDir(), "usage");
}

export function mirrorsDir(): string {
	return join(stateDir(), "mirrors");
}

export function logsDir(): string {
	return join(stateDir(), "logs");
}

const LEGACY_USAGE_PREFIX = "claude-bridge-usage-";
/** Usage snapshots untouched this long belong to an account no longer used. */
export const USAGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A writer's temp file (`<name>.<pid>.tmp`) still younger than this may be renamed
 *  into place any moment by an older bridge in another window: left alone. */
const TEMP_GRACE_MS = 60_000;

/** Moves `from` to `to` unless `to` already exists; returns whether it moved. A file
 *  moves by link then unlink, so a `to` another process creates meanwhile fails the
 *  link (EEXIST) instead of being replaced, as rename would. A directory (cc-cli-logs)
 *  cannot be linked; rename never replaces one that holds files. */
function moveIfAbsent(from: string, to: string): boolean {
	if (statSync(from).isDirectory()) {
		if (existsSync(to)) return false;
		renameSync(from, to);
		return true;
	}
	try { linkSync(from, to); } catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
		throw error;
	}
	unlinkSync(from);
	return true;
}

/** A writer's leftover temp file, old enough that no writer will rename it any more. */
function staleTemp(path: string, now: number): boolean {
	return path.endsWith(".tmp") && now - statSync(path).mtimeMs > TEMP_GRACE_MS;
}

/** Moves the state earlier versions wrote into the agent dir's root into stateDir(),
 *  removes the session store an earlier version kept there, and drops usage snapshots
 *  no process has refreshed in USAGE_MAX_AGE_MS. Runs on every activation: an older
 *  bridge still running in another window may write a root file again, and the next
 *  activation moves it. Best effort and idempotent: each step's failure is collected and
 *  returned for the debug log, never thrown, so several processes starting at once only
 *  race to the same result. */
export function migrateLegacyState(now = Date.now()): string[] {
	const errors: string[] = [];
	const step = (what: string, run: () => void) => {
		try { run(); } catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			// Another process moved or removed it first.
			if (code !== "ENOENT") errors.push(`${what}: ${(error as Error)?.message ?? error}`);
		}
	};
	const root = getAgentDir();
	let rootNames: string[] = [];
	step("list agent dir", () => { rootNames = readdirSync(root); });

	// Usage snapshots: a newer snapshot already in usage/ wins; the root one is stale.
	const usage = rootNames.filter((name) => name.startsWith(LEGACY_USAGE_PREFIX));
	if (usage.length) step("create usage dir", () => mkdirSync(usageDir(), { recursive: true }));
	for (const name of usage) {
		const from = join(root, name);
		step(`move ${name}`, () => {
			const account = name.slice(LEGACY_USAGE_PREFIX.length);
			if (account.endsWith(".json")) { if (!moveIfAbsent(from, join(usageDir(), account))) rmSync(from, { force: true }); }
			// A write's leftover temp file holds nothing to keep; any other name is not ours.
			else if (staleTemp(from, now)) rmSync(from, { force: true });
		});
	}

	// Mirrors: owner-only, since an aborted turn's record holds its prompt.
	const legacyMirrors = join(root, "claude-bridge-mirrors");
	if (rootNames.includes("claude-bridge-mirrors")) {
		step("create mirrors dir", () => mkdirSync(mirrorsDir(), { recursive: true, mode: 0o700 }));
		let names: string[] = [];
		step("list legacy mirrors", () => { names = readdirSync(legacyMirrors); });
		for (const name of names) {
			const from = join(legacyMirrors, name);
			step(`move mirror ${name}`, () => {
				if (name.endsWith(".json")) { if (!moveIfAbsent(from, join(mirrorsDir(), name))) rmSync(from, { force: true }); }
				else if (staleTemp(from, now)) rmSync(from, { force: true });
			});
		}
		// Still holding a fresh temp file: the next activation removes it.
		step("remove legacy mirrors dir", () => { if (readdirSync(legacyMirrors).length === 0) rmdirSync(legacyMirrors); });
	}

	// Logs, only at their default place: CLAUDE_BRIDGE_DEBUG_PATH names its own file.
	const logs: Array<[string, string]> = [["claude-bridge-diag.log", "diag.log"]];
	if (!process.env.CLAUDE_BRIDGE_DEBUG_PATH) logs.push(["claude-bridge.log", "bridge.log"], ["cc-cli-logs", "cc-cli-logs"]);
	for (const [name, target] of logs) {
		if (!rootNames.includes(name)) continue;
		// A log already at the new place is kept as is, and so is the old one: logs are
		// never deleted to tidy up.
		step(`move ${name}`, () => { mkdirSync(logsDir(), { recursive: true }); moveIfAbsent(join(root, name), join(logsDir(), target)); });
	}

	// The per-session store a removed module kept (session-store.ts); nothing reads it.
	step("remove obsolete session store", () => rmSync(join(stateDir(), "sessions"), { recursive: true, force: true }));

	step("prune usage", () => {
		if (!existsSync(usageDir())) return;
		for (const name of readdirSync(usageDir())) {
			const file = join(usageDir(), name);
			step(`prune ${name}`, () => { if (now - statSync(file).mtimeMs > USAGE_MAX_AGE_MS) rmSync(file, { force: true }); });
		}
	});
	return errors;
}
