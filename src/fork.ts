// Fork-only additions of @viniciosrab/pi-claude-bridge.
//
// The fork's npm mirror cherry-picks its fix commits onto every upstream release, and
// any upstream edit next to a line those commits touch stops the release. So the fork's
// code lives here, in a file upstream never edits, and src/index.ts only carries
// one-line hooks into it: one import and one call per feature. Keep it that way: do not
// edit upstream lines (shared imports, the Config interface, upstream tests or README),
// add a hook line next to them instead.

import type { query, SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getSessionPath } from "cc-session-io";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

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

/** Wrap the SDK's query() so provider launches get providerSettingSourcesOption. Hooked
 *  where src/index.ts assigns queryImpl, which upstream leaves alone, rather than in the
 *  provider block it keeps rewriting. Provider launches run Claude Code with `tools: []`
 *  (so does the isolated summary, already sourceless); AskClaude keeps CC's own tools and
 *  is left alone. Calls pass through untouched unless the option is set. */
export function withProviderSettingSources(impl: typeof query, getProvider: () => object | undefined): typeof query {
	return ((params: Parameters<typeof query>[0]) => {
		const override = providerSettingSourcesOption(getProvider());
		const tools = params.options?.tools;
		if (!override.settingSources || !Array.isArray(tools) || tools.length > 0) return impl(params);
		return impl({ ...params, options: { ...params.options, ...override } });
	}) as typeof query;
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
// the cache back; once the aborted CLI has exited, the bridge does the same.

/** How long after an abort the next prompt waits for the aborted CLI to exit. The SDK
 *  closes stdin, sends SIGTERM about 2 s later and SIGKILL about 5 s after that; a CLI
 *  still alive past this bound may still write, so the next sync rebuilds on a rotated id,
 *  as upstream does after every abort, rather than share the file. When the exit cannot
 *  be observed (no process was tracked), nothing waits: a sync less than this long after
 *  the abort rebuilds, and one later resumes. */
export const ABORT_SETTLE_MS = 3_000;

/** The aborted query's CLI process, as the next sync sees it. */
export interface CliProcess {
	// False when no process was launched through the tracked spawner: its exit
	// cannot be observed, so the settle timer decides instead.
	spawned: boolean;
	exited: boolean;
	// Resolves when the process exits, or at once when none was spawned.
	exit: Promise<void>;
	// The last STDERR_TAIL_CHARS of its stderr, for exit errors.
	stderr: string;
	// Its OS pid and start identity (cliStartTime), recorded on the mirror file so a
	// reloaded module can still tell whether it may write.
	pid?: number;
	startTime?: string;
}

/** The fields an abort leaves on a session mirror for the next sync. */
export interface AbortMark {
	abortedAt?: number;
	// The aborted query's prompt and the size of CC's session file when that query
	// started: the resume checks CC wrote the prompt past that point, since a CLI
	// killed before writing it leaves a file that lacks the prompt.
	abortedPrompt?: string;
	abortedFileOffset?: number;
	abortedProcess?: CliProcess;
}

/** What a query records at its start, for the abort mark should it be aborted. */
export interface AbortedTurn {
	prompt: string;
	resumedId: string | null;
	fileOffset: number;
	process?: CliProcess;
}

// The SDK's own spawn keeps this much stderr for its exit errors.
const STDERR_TAIL_CHARS = 2_048;
// How long the SDK's own spawn holds an exit back for stderr to drain.
const STDERR_DRAIN_MS = 200;
const EXIT_AFTER_STDERR = "fork-exit-after-stderr-drained";

/** Launches the CLI as the SDK's own local spawn does: stderr goes to `onStderr`, and
 *  'exit' reaches listeners once stderr has drained (bounded), so an exit error built
 *  on it sees the whole tail. The SDK adds that tail itself only for its own spawn;
 *  withStderrTail puts it back. */
function spawnCli(options: SpawnOptions, onStderr: (data: string) => void): SpawnedProcess & { pid?: number; stderr: Readable } {
	const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, signal: options.signal, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", onStderr);
	child.stderr.on("error", () => {});
	child.on("error", () => {});
	let stderrClosed = false, exited = false, delivered = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deliver = () => {
		if (delivered) return;
		delivered = true;
		clearTimeout(timer);
		child.emit(EXIT_AFTER_STDERR, child.exitCode, child.signalCode);
	};
	child.stderr.once("close", () => { stderrClosed = true; if (exited) deliver(); });
	child.once("exit", () => { exited = true; if (stderrClosed) deliver(); else timer = setTimeout(deliver, STDERR_DRAIN_MS); });
	const event = (name: string) => (name === "exit" ? EXIT_AFTER_STDERR : name);
	return {
		stdin: child.stdin,
		stdout: child.stdout,
		stderr: child.stderr,
		get pid() { return child.pid; },
		get killed() { return child.killed; },
		get exitCode() { return child.exitCode; },
		get signalCode() { return child.signalCode; },
		kill: (signal: NodeJS.Signals) => child.kill(signal),
		on: (name: string, listener: (...args: any[]) => void) => { child.on(event(name), listener); },
		once: (name: string, listener: (...args: any[]) => void) => { child.once(event(name), listener); },
		off: (name: string, listener: (...args: any[]) => void) => { child.off(event(name), listener); },
	};
}

// Secrets a stderr tail may carry, masked before it reaches pi's error message.
const STDERR_SECRETS: [RegExp, string][] = [
	[/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]"],
	[/Bearer\s+\S+/gi, "Bearer [REDACTED]"],
	[/\b(token|secret|password|api[_-]?key)(\s*[=:]\s*)\S+/gi, "$1$2[REDACTED]"],
];

/** The SDK's exit error ("Claude Code process exited with code 1") with the CLI's
 *  redacted stderr tail, as the SDK's own spawn reports it: auth failures that end the
 *  CLI before any result only say so on stderr. Other messages pass through. */
export function withStderrTail(message: string | undefined, cli: CliProcess | undefined): string | undefined {
	if (!message || !cli?.stderr || !/^Claude Code process (exited|terminated)/.test(message) || message.includes(". stderr: ")) return message;
	const tail = STDERR_SECRETS.reduce((text, [pattern, mask]) => text.replace(pattern, mask), cli.stderr).slice(-STDERR_TAIL_CHARS).trim();
	return tail ? `${message}. stderr: ${tail}` : message;
}

/** Launch the query's CLI through a spawner that records its exit on `turn`, so the sync
 *  after an abort can tell a CLI that may still write from one that is gone. Wraps a
 *  spawner already set rather than replace it. */
export function trackCliProcess(
	options: { spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess; stderr?: (data: string) => void },
	turn: AbortedTurn,
): void {
	let settle!: () => void;
	const cli: CliProcess = { spawned: false, exited: false, exit: new Promise((resolve) => { settle = resolve; }), stderr: "" };
	const onStderr = (data: string) => {
		cli.stderr = (cli.stderr + data).slice(-2 * STDERR_TAIL_CHARS);
		options.stderr?.(data);
	};
	const launch = options.spawnClaudeCodeProcess ?? ((o: SpawnOptions) => spawnCli(o, onStderr));
	options.spawnClaudeCodeProcess = (spawnOptions) => {
		const proc = launch(spawnOptions);
		cli.spawned = true;
		cli.pid = (proc as { pid?: number }).pid;
		cli.startTime = cli.pid === undefined ? undefined : cliStartTime(cli.pid);
		const done = () => { cli.exited = true; settle(); };
		if (proc.exitCode !== null || proc.signalCode) done();
		else {
			proc.once("exit", done);
			// A failed spawn leaves no process behind to write. Other errors, such as the
			// AbortError of the force-kill signal, come while the process may still live.
			proc.once("error", () => { if ((proc as { pid?: number }).pid === undefined) done(); });
		}
		return proc;
	};
	turn.process = cli;
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
export function abortMark(turn: AbortedTurn, sessionId: string, now = Date.now()): AbortMark & Required<Omit<AbortMark, "abortedProcess">> {
	return { abortedAt: now, abortedPrompt: turn.prompt, abortedFileOffset: sessionId === turn.resumedId ? turn.fileOffset : 0, abortedProcess: turn.process };
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

/** Whether the aborted CLI can no longer write its session file: it exited, or, when
 *  its exit cannot be observed, the settle window has passed. */
function abortSettled(cli: CliProcess | undefined, abortedAt: number, now: number): boolean {
	return cli?.spawned ? cli.exited : now - abortedAt >= ABORT_SETTLE_MS;
}

/** How long the next prompt should wait for the aborted CLI to exit: the rest of the
 *  bound while a tracked CLI is alive, else 0 (gone, untracked, or a rebuild that does
 *  not touch its file anyway). */
export function abortSettleWait(state: (AbortMark & { needsRebuild?: boolean }) | null, now = Date.now()): number {
	const cli = state?.abortedProcess;
	if (!state || state.abortedAt === undefined || state.needsRebuild || !cli?.spawned || cli.exited) return 0;
	// Clamped: a clock set back or a mark from the future never waits past the bound.
	return Math.min(ABORT_SETTLE_MS, Math.max(0, state.abortedAt + ABORT_SETTLE_MS - now));
}

/** An empty assistant message ending a turn, as src/index.ts newAssistantOutput builds it. */
function failedTurn(model: Model<any>, stopReason: "aborted" | "error", errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

type StreamFn = (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

/** Hooked at the top of the provider's streamSimple, which is synchronous: while the
 *  session's aborted CLI is still shutting down, return a stream that relays `streamFn`'s
 *  once the CLI exits or the bound passes, so the sync inside it sees the settled file.
 *  `undefined`: nothing to wait for, run now. */
export function deferUntilAbortSettles(
	streamFn: StreamFn,
	state: (AbortMark & { needsRebuild?: boolean }) | null,
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream | undefined {
	if (options?.cacheRetention === "none" || options?.signal?.aborted) return undefined;
	const waitMs = abortSettleWait(state);
	if (!waitMs) return undefined;
	const stream = createAssistantMessageEventStream();
	void (async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort = () => {};
		await Promise.race([
			state!.abortedProcess!.exit,
			new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); }),
			new Promise<void>((resolve) => { onAbort = () => resolve(); options?.signal?.addEventListener("abort", onAbort, { once: true }); }),
		]);
		clearTimeout(timer);
		options?.signal?.removeEventListener("abort", onAbort);
		// Aborted while waiting: end the turn as the provider ends an aborted one, without
		// a query, so the session keeps its abort mark and is not rotated off CC's file.
		if (options?.signal?.aborted) {
			stream.push({ type: "error", reason: "aborted", error: failedTurn(model, "aborted", "Operation aborted") });
			stream.end();
			return;
		}
		try {
			for await (const event of streamFn(model, context, options)) stream.push(event);
		} catch (error) {
			stream.push({ type: "error", reason: "error", error: failedTurn(model, "error", error instanceof Error ? error.message : String(error)) });
		}
		stream.end();
	})();
	return stream;
}

/** How the sync after an abort proceeds. `undefined`: no abort mark, or a history
 *  rewrite already forces a rebuild. `"resume"`: the aborted CLI has exited (or, when
 *  its exit cannot be observed, the settle window has passed), CC wrote the aborted
 *  prompt, and every message pi has past the cursor belongs to the aborted turn (its
 *  partial answer, tool calls and their results). `"rebuild"`: anything else, including
 *  a user message CC never saw and a CLI still alive past the bound. */
export function postAbortSync(
	state: (AbortMark & { sessionId: string; cursor: number; needsRebuild?: boolean }) | null,
	priorMessages: { role?: string }[],
	cwd: string,
	now = Date.now(),
): "resume" | "rebuild" | undefined {
	if (!state || state.abortedAt === undefined || state.needsRebuild) return undefined;
	const resumable = abortSettled(state.abortedProcess, state.abortedAt, now)
		&& priorMessages.length >= state.cursor
		&& priorMessages.slice(state.cursor).every((m) => m.role !== "user")
		&& abortedPromptPersisted(state.sessionId, state, cwd);
	return resumable ? "resume" : "rebuild";
}

// Resume after reopening. The bridge keeps each pi session's Claude Code session in
// memory, so a pi session continued in a new process (a new window, `pi --continue`,
// `/resume`) found none and rebuilt the whole conversation, re-caching all of it. Each
// completed turn now records its CC session in a small file per pi session, and the
// first sync of a new process resumes that session when pi's history still matches it.

/** What a completed turn records about its pi session's CC session. */
export interface MirrorRecord {
	sessionId: string;
	// History messages CC's session covers, as syncSharedSession counts them.
	cursor: number;
	cwd: string;
	// Of the history the cursor covers, which a reopened history must start with.
	fingerprint: string;
	fingerprintLength: number;
	// The process that wrote it: a CC session file never has two live writers.
	pid: number;
	// Set when the recorded turn was aborted: the abort mark, and the aborted CLI's
	// pid and start identity when it was tracked. The cursor then covers the aborted
	// prompt instead of a completed answer.
	abortedAt?: number;
	abortedPrompt?: string;
	abortedFileOffset?: number;
	abortedCliPid?: number;
	abortedCliStartTime?: string;
}

const MIRROR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function mirrorDir(): string {
	return join(getAgentDir(), "claude-bridge-mirrors");
}

function mirrorPath(piSessionId: string): string {
	return join(mirrorDir(), `${encodeURIComponent(piSessionId)}.json`);
}

/** Identifies a history by each message's role and timestamp, which pi keeps
 *  across processes and changes whenever it rewrites a message. */
export function historyFingerprint(messages: { role?: string; timestamp?: number }[]): string {
	const hash = createHash("sha256");
	for (const m of messages) hash.update(`${m.role}:${m.timestamp}\n`);
	return hash.digest("hex");
}

let mirrorsPruned = false;
function pruneMirrors(now: number): void {
	if (mirrorsPruned) return;
	mirrorsPruned = true;
	try {
		for (const name of readdirSync(mirrorDir())) {
			const file = join(mirrorDir(), name);
			if (now - statSync(file).mtimeMs > MIRROR_MAX_AGE_MS) rmSync(file, { force: true });
		}
	} catch {}
}

/** Records a pi session's CC session after a completed turn. Best effort: a
 *  failure only means the next process rebuilds, as before. */
export function saveMirror(piSessionId: string, record: Omit<MirrorRecord, "pid">, now = Date.now()): void {
	try {
		mkdirSync(mirrorDir(), { recursive: true });
		pruneMirrors(now);
		const file = mirrorPath(piSessionId);
		writeFileSync(`${file}.tmp`, JSON.stringify({ ...record, pid: process.pid }));
		renameSync(`${file}.tmp`, file);
	} catch {}
}

/** Forgets a pi session's CC session, so no process resumes a file pi's history has left. */
export function dropMirror(piSessionId: string): void {
	try { rmSync(mirrorPath(piSessionId), { force: true }); } catch {}
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** A process's start time in clock ticks since boot (Linux /proc/<pid>/stat field 22),
 *  so a pid the kernel has since handed to another process does not pass for the CLI
 *  that had it. `undefined` where /proc is unavailable: liveness then rests on the pid
 *  alone, and a reused pid at worst costs a rebuild, since every wait is bounded. */
function cliStartTime(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		// The fields after the command name, which is parenthesized and may hold spaces.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return fields[0] === "Z" ? "zombie" : fields[19];
	} catch {
		return undefined;
	}
}

/** Whether the CLI recorded as `pid`, started at `startTime`, may still write. */
function cliAlive(pid: number, startTime: string | undefined): boolean {
	if (!processAlive(pid)) return false;
	const now = startTime === undefined ? undefined : cliStartTime(pid);
	return now === undefined || now === startTime;
}

// How often a reloaded module checks whether the aborted CLI has exited: it is not
// this module's child, so no exit event reaches it.
const CLI_POLL_MS = 25;

/** The aborted CLI a mirror file records, as the next sync sees it. Its exit resolves
 *  once the pid is gone or the settle bound passes, whichever comes first. Untracked
 *  (no pid recorded): `undefined`, so the settle timer decides. */
function recordedCli(record: MirrorRecord): CliProcess | undefined {
	const pid = record.abortedCliPid;
	if (pid === undefined) return undefined;
	const alive = () => cliAlive(pid, record.abortedCliStartTime);
	const deadline = Math.min((record.abortedAt ?? 0), Date.now()) + ABORT_SETTLE_MS;
	const exit = new Promise<void>((resolve) => {
		const poll = () => { if (!alive() || Date.now() >= deadline) resolve(); else setTimeout(poll, CLI_POLL_MS).unref(); };
		poll();
	});
	return { spawned: true, get exited() { return !alive(); }, exit, stderr: "", pid, startTime: record.abortedCliStartTime };
}

/** The fields a mirror file keeps of an abort mark. */
export function mirrorAbortFields(mark: AbortMark): Pick<MirrorRecord, "abortedAt" | "abortedPrompt" | "abortedFileOffset" | "abortedCliPid" | "abortedCliStartTime"> {
	const cli = mark.abortedProcess?.spawned ? mark.abortedProcess : undefined;
	return { abortedAt: mark.abortedAt, abortedPrompt: mark.abortedPrompt, abortedFileOffset: mark.abortedFileOffset, abortedCliPid: cli?.pid, abortedCliStartTime: cli?.startTime };
}

function recordedAbortMark(record: MirrorRecord): AbortMark | undefined {
	if (record.abortedAt === undefined) return undefined;
	return { abortedAt: record.abortedAt, abortedPrompt: record.abortedPrompt, abortedFileOffset: record.abortedFileOffset, abortedProcess: recordedCli(record) };
}

function readMirror(piSessionId: string): MirrorRecord | null {
	try {
		return JSON.parse(readFileSync(mirrorPath(piSessionId), "utf8")) as MirrorRecord;
	} catch {
		return null;
	}
}

/** The abort mark a mirror file carries for a pi session this module has no mirror of
 *  (after /reload, or in a new process), so the next prompt can wait for the aborted
 *  CLI as it would have in the module that aborted it. Null when there is none, or
 *  another live process owns the session. */
export function persistedAbortMark(piSessionId: string | undefined): AbortMark | null {
	const record = piSessionId ? readMirror(piSessionId) : null;
	if (!record || (record.pid !== process.pid && processAlive(record.pid))) return null;
	return recordedAbortMark(record) ?? null;
}

/** The CC session a new process may resume for `piSessionId`, or null to rebuild:
 *  nothing recorded, another cwd, CC's file gone, another live process using it,
 *  or a history that no longer starts with the turn CC completed. */
export function loadMirror(piSessionId: string, history: { role?: string; timestamp?: number }[], cwd: string): { sessionId: string; cursor: number; abort?: AbortMark } | null {
	const record = readMirror(piSessionId);
	if (!record) return null;
	if (record.cwd !== cwd || !existsSync(getSessionPath(record.sessionId, cwd, process.env.CLAUDE_CONFIG_DIR))) return null;
	if (record.pid !== process.pid && processAlive(record.pid)) return null;
	// The cursor's messages unchanged, followed by the turn's final answer: a history
	// branched inside that turn (say, /tree back to a tool result) dropped the answer
	// CC's file still ends with. An aborted turn's cursor covers its prompt instead,
	// and postAbortSync judges what follows it, as it does without a reload.
	const abort = recordedAbortMark(record);
	if (record.fingerprintLength !== record.cursor || history.length <= record.cursor) return null;
	if (!abort && (history[record.cursor] as { role?: string }).role !== "assistant") return null;
	if (historyFingerprint(history.slice(0, record.cursor)) !== record.fingerprint) return null;
	return { sessionId: record.sessionId, cursor: record.cursor, ...(abort ? { abort } : {}) };
}
