// Plan usage shared across pi processes. A subagent runs in its own `pi` process,
// so the rate_limit_events its Claude Code reports reach only that process's
// onResponse: the parent's usage bar stood still until the parent's own next
// request. Every bridge writes its latest event to its account's file in the
// bridge's state dir (state-dir.ts); the interactive parent watches its account's file and re-registers a
// usage source with Gentle Shell, which refreshes the bar from it at once.

import { createHash } from "crypto";
import { mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "fs";
import { basename, dirname, join } from "path";
import type { RateLimitInfo } from "./rate-limit.js";
import { usageDir } from "./state-dir.js";

/** Gentle Shell's generic usage-source hook (gentle-pi lib/shell-usage.ts). */
export const USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
const USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";

const FILE_VERSION = 1;
const WATCH_DEBOUNCE_MS = 200;

/** Window name → [label, length in seconds], the windows Gentle Shell draws for Claude. */
const WINDOWS: ReadonlyArray<[name: string, label: string, seconds: number]> = [
	["five_hour", "5h", 18_000],
	["seven_day", "week", 604_800],
];

type SharedUsage = { version: number; at: number; info: RateLimitInfo };

type UsageWindow = { label: string; usedPercent: number; windowSeconds: number; resetAt: number | null };
export type ProviderUsage = {
	provider: string;
	plan: undefined;
	limits: Array<{ name: string; windows: UsageWindow[]; limitReached: boolean }>;
	fetchedAt: number;
};

/** Which Claude account a snapshot belongs to: pi-claude-accounts selects it per
 *  process through CLAUDE_CODE_OAUTH_TOKEN, so a parent and a subagent can differ.
 *  Hashed, so the token itself never reaches the disk. */
export function accountKey(env: NodeJS.ProcessEnv = process.env): string {
	const token = env.CLAUDE_CODE_OAUTH_TOKEN;
	return token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : "login";
}

/** One file per account, so one account's report never replaces another's. */
export function sharedUsagePath(account = accountKey()): string {
	return join(usageDir(), `${account}.json`);
}

/** Atomic (write then rename), so a reader never sees half a file. Best effort: the
 *  usage bar is a display, never a reason to fail a turn. */
export function publishUsage(info: RateLimitInfo, now = Date.now()): void {
	const path = sharedUsagePath();
	const temp = `${path}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		const snapshot: SharedUsage = { version: FILE_VERSION, at: now, info };
		writeFileSync(temp, JSON.stringify(snapshot));
		renameSync(temp, path);
	} catch {
		// Unwritable agent dir: the bar keeps updating from this process's own responses.
	}
}

function readSharedUsage(): SharedUsage | undefined {
	try {
		const raw = JSON.parse(readFileSync(sharedUsagePath(), "utf8"));
		if (raw?.version !== FILE_VERSION || typeof raw.at !== "number" || !raw.info || typeof raw.info !== "object") return undefined;
		return raw as SharedUsage;
	} catch {
		return undefined;
	}
}

/** The same snapshot Gentle Shell builds from the unified headers rateLimitResponse
 *  sends, so the bar reads alike whichever path delivered it. */
export function toProviderUsage(info: RateLimitInfo, provider: string, fetchedAt: number): ProviderUsage | undefined {
	const windows: UsageWindow[] = [];
	for (const [name, label, seconds] of WINDOWS) {
		const window = info.unifiedWindows?.[name];
		if (typeof window?.utilization !== "number" || !Number.isFinite(window.utilization)) continue;
		const resetAt = typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt) ? window.resetsAt * 1000 : null;
		windows.push({ label, usedPercent: window.utilization * 100, windowSeconds: seconds, resetAt });
	}
	if (windows.length === 0) return undefined;
	return { provider, plan: undefined, limits: [{ name: "claude", windows, limitReached: info.status === "rejected" }], fetchedAt };
}

/** Highest utilization seen per account, window and resetsAt, in this process. */
const highWater = new Map<string, number>();

/** info with each window's utilization raised to the highest seen for the same window
 *  and resetsAt: every process measures at response start but reports after it, so a
 *  later report can carry an older measurement. A new resetsAt starts over. */
function raiseToHighWater(info: RateLimitInfo, account: string, floor?: RateLimitInfo): RateLimitInfo {
	if (!info.unifiedWindows) return info;
	const windows: NonNullable<RateLimitInfo["unifiedWindows"]> = {};
	for (const [name, window] of Object.entries(info.unifiedWindows)) {
		// No reset time: nothing tells one window from the next, so keep no maximum.
		if (typeof window?.utilization !== "number" || !Number.isFinite(window.utilization)
			|| typeof window.resetsAt !== "number" || !Number.isFinite(window.resetsAt)) {
			windows[name] = window;
			continue;
		}
		const key = `${account}\0${name}\0${window.resetsAt}`;
		const other = floor?.unifiedWindows?.[name];
		const fromFloor = other?.resetsAt === window.resetsAt && typeof other.utilization === "number" && Number.isFinite(other.utilization) ? other.utilization : -Infinity;
		const utilization = Math.max(window.utilization, fromFloor, highWater.get(key) ?? -Infinity);
		highWater.set(key, utilization);
		windows[name] = { ...window, utilization };
	}
	return { ...info, unifiedWindows: windows };
}

/** The info to publish and report: never below this account's shared file or this
 *  process's high-water mark within the same window. */
export function monotonicUsage(info: RateLimitInfo): RateLimitInfo {
	return raiseToHighWater(info, accountKey(), readSharedUsage()?.info);
}

/** The latest shared snapshot of this process's account, as the provider's usage.
 *  Raised to the high-water mark, so a race between two writers never lowers the bar. */
export function sharedProviderUsage(provider: string): ProviderUsage | undefined {
	const shared = readSharedUsage();
	return shared && toProviderUsage(raiseToHighWater(shared.info, accountKey()), provider, shared.at);
}

export function usageSource(provider: string) {
	return {
		schema: USAGE_SOURCE_SCHEMA,
		provider,
		fetch: async () => sharedProviderUsage(provider),
	};
}

/** Calls onUpdate once per burst of new snapshots of this process's account, read
 *  when the event comes, since pi-claude-accounts can switch it. Watches the
 *  directory, not the file: each publish replaces the file's inode. */
export function watchSharedUsage(onUpdate: () => void): () => void {
	const dir = dirname(sharedUsagePath());
	const lastAt = new Map<string, number>([[accountKey(), readSharedUsage()?.at ?? 0]]);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let watcher: FSWatcher | undefined;
	const check = () => {
		timer = undefined;
		const account = accountKey();
		const shared = readSharedUsage();
		if (!shared || shared.at <= (lastAt.get(account) ?? 0)) return;
		lastAt.set(account, shared.at);
		try { onUpdate(); } catch { /* a listener never breaks the watcher */ }
	};
	try {
		mkdirSync(dir, { recursive: true });
		watcher = watch(dir, { persistent: false }, (_event, filename) => {
			if (filename !== null && filename.toString() !== basename(sharedUsagePath())) return;
			if (timer) return;
			timer = setTimeout(check, WATCH_DEBOUNCE_MS);
			timer.unref?.();
		});
		watcher.on("error", () => watcher?.close());
	} catch {
		// No watch support: the bar falls back to updating on the parent's own requests.
	}
	return () => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		watcher?.close();
		watcher = undefined;
	};
}
