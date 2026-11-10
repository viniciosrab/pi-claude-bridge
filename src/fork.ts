// Fork-only additions of @viniciosrab/pi-claude-bridge.
//
// The fork's npm mirror cherry-picks its fix commits onto every upstream release, and
// any upstream edit next to a line those commits touch stops the release. So the fork's
// code lives here, in a file upstream never edits, and src/index.ts only carries
// one-line hooks into it: one import and one call per feature. Keep it that way: do not
// edit upstream lines (shared imports, the Config interface, upstream tests or README),
// add a hook line next to them instead.

import { forkSession, type query, type SettingSource, type SpawnedProcess, type SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { getClaudeDir, getSessionPath } from "cc-session-io";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { sessionCwdFor } from "./session-cwd.js";
import { nonSystemMessages } from "./transcript.js";

/** Provider settings only the fork reads, from `provider` in claude-bridge.json. */
export interface ForkProviderSettings {
	// Which Claude Code settings files (hooks, plugins, env, apiKeyHelper) the
	// provider's subprocess loads. Absent or "user": ~/.claude/settings.json only.
	// "all" (or true): also the repository's .claude/settings.json and
	// .claude/settings.local.json. false: none.
	loadClaudeSettings?: boolean | "user" | "all";
	// Set to false to hide the Claude rate-limit notices (usage warnings and
	// "rate limit reached") shown in pi. Failures are still named as rate limits.
	rateLimitWarnings?: boolean;
}

// Config["provider"] does not declare the fork's keys, but loadConfig keeps every key
// of the JSON, so they are read through this cast rather than by editing config.ts.
function forkSettings(provider: object | undefined): ForkProviderSettings {
	return (provider ?? {}) as ForkProviderSettings;
}

/** Provider-path `settingSources`. The default is the user's own settings only: pi has
 *  no trust prompt, so a cloned repository's hooks, `apiKeyHelper` and `env` would
 *  otherwise run as soon as it is opened. `loadClaudeSettings: "all"` (or `true`) adds
 *  the repository's project and local settings; `false` loads no settings files. */
export function providerSettingSourcesOption(provider?: object): { settingSources: SettingSource[] } {
	const choice = forkSettings(provider).loadClaudeSettings;
	if (choice === false) return { settingSources: [] };
	if (choice === true || choice === "all") return { settingSources: ["user", "project", "local"] };
	return { settingSources: ["user"] };
}

/** Wrap the SDK's query() so provider launches get providerSettingSourcesOption. Hooked
 *  where src/index.ts assigns queryImpl, which upstream leaves alone, rather than in the
 *  provider block it keeps rewriting. Provider launches run Claude Code with `tools: []`
 *  and name no sources of their own. The isolated summary also has `tools: []` but names
 *  its own sources, and a launch with CC's own tools is not a provider launch: both
 *  are left alone. */
export function withProviderSettingSources(impl: typeof query, getProvider: () => object | undefined): typeof query {
	return ((params: Parameters<typeof query>[0]) => {
		const override = providerSettingSourcesOption(getProvider());
		const tools = params.options?.tools;
		if (!Array.isArray(tools) || tools.length > 0 || params.options?.settingSources) return impl(params);
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
 *  spawns gets `ccChildEnv()` (pi's environment plus CC_CHILD_ENV), so this reaches all of them
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
	// Set when the turn ended at an API error result rather than an abort (see
	// errorResultMarkable): pi may then retry the same prompt, which retryAfterError resumes.
	errorResult?: boolean;
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
export function abortMark(turn: AbortedTurn, sessionId: string, now = Date.now()): AbortMark & Required<Omit<AbortMark, "abortedProcess" | "errorResult">> {
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

/** A stream that relays `streamFn`'s once `before` settles. Aborted meanwhile: the turn
 *  ends as the provider ends an aborted one, without a query. */
function streamAfter(before: () => Promise<void>, streamFn: StreamFn, model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		await before();
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
	// Aborted while waiting: streamAfter ends the turn without a query, so the session
	// keeps its abort mark and is not rotated off CC's file.
	return streamAfter(async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort = () => {};
		await Promise.race([
			state!.abortedProcess!.exit,
			new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); }),
			new Promise<void>((resolve) => { onAbort = () => resolve(); options?.signal?.addEventListener("abort", onAbort, { once: true }); }),
		]);
		clearTimeout(timer);
		options?.signal?.removeEventListener("abort", onAbort);
	}, streamFn, model, context, options);
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

// Resume after an API error result. An error result (overloaded, rate limit, 5xx, quota)
// ends the query, and the bridge used to drop the session and rebuild it from pi's
// history on the next turn, re-caching everything (upstream #103). CC has persisted the
// failed prompt and an `isApiErrorMessage` record it strips from later requests, so the
// turn after the error resumes CC's own file as after an abort: a new prompt (pi keeps
// the failed turn) through postAbortSync, and pi's retry of the same prompt (pi drops the
// failed turn) cut back to the entry before it, through retryAfterError.

/** The error result that ended a query, as consumeQuery fails it: unlike an SDK
 *  exception or a CLI that died without a result, the turn reached CC's session file. */
export class ErrorResultFailure extends Error {
	constructor(message: string, readonly capturedSessionId?: string) {
		super(message);
	}
}

/** Whether a failed query may leave an error mark instead of dropping its session: it
 *  ended at an error result, left no steer unincorporated, and ran no tool calls (CC's
 *  file then holds a partial turn the next context may not match). */
export function errorResultMarkable(
	error: unknown,
	c: { pendingSteerUuids: Set<string>; missedSteer: boolean; deliveredToolCallIds: Set<string>; turnToolCallIds: string[] },
): error is ErrorResultFailure {
	return error instanceof ErrorResultFailure && c.pendingSteerUuids.size === 0 && !c.missedSteer && c.deliveredToolCallIds.size === 0 && c.turnToolCallIds.length === 0;
}

function recordTexts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	return (content as { type?: string; text?: unknown }[]).filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
}

/** The last chain entry of CC's session file written before the failed query started:
 *  the failed prompt's record is the first user record past the mark's offset carrying
 *  its text, and its ancestors are followed back past every record that query wrote.
 *  `undefined` when there is no such record or entry (a failed first turn). */
function entryBeforeFailedTurn(sessionId: string, mark: AbortMark, cwd: string): string | undefined {
	let bytes: Buffer;
	try {
		bytes = readFileSync(getSessionPath(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR));
	} catch {
		return undefined;
	}
	const offset = mark.abortedFileOffset ?? 0;
	const entries = new Map<string, { parentUuid: unknown; before: boolean }>();
	let prompt: string | undefined;
	for (let start = 0; start < bytes.length;) {
		const newline = bytes.indexOf(0x0a, start);
		const end = newline < 0 ? bytes.length : newline;
		const before = start < offset;
		let record: { type?: string; uuid?: unknown; parentUuid?: unknown; isMeta?: boolean; message?: { content?: unknown } };
		try { record = JSON.parse(bytes.subarray(start, end).toString("utf8")); } catch { record = {}; }
		start = end + 1;
		if (typeof record.uuid !== "string") continue;
		entries.set(record.uuid, { parentUuid: record.parentUuid, before });
		if (!before && !prompt && record.type === "user" && !record.isMeta && recordTexts(record.message?.content).some((t) => t.includes(mark.abortedPrompt!))) prompt = record.uuid;
	}
	let at = prompt ? entries.get(prompt)?.parentUuid : undefined;
	while (typeof at === "string") {
		const entry = entries.get(at);
		if (!entry) return undefined;
		if (entry.before) return at;
		at = entry.parentUuid;
	}
	return undefined;
}

/** Where pi's retry of a prompt that failed at an error result resumes CC's session:
 *  the entry before the failed prompt, as `resumeSessionAt`, so the prompt is sent once
 *  rather than twice. `undefined`: no error mark, a rewrite pending, a CLI that may still
 *  write, a context other than the failed turn's own messages ending in the same prompt,
 *  or no such entry; postAbortSync then rebuilds. */
export function retryAfterError(
	state: (AbortMark & { sessionId: string; cursor: number; needsRebuild?: boolean }) | null,
	priorLength: number,
	historyLength: number,
	prompt: string,
	cwd: string,
	now = Date.now(),
): string | undefined {
	if (!state?.errorResult || state.abortedAt === undefined || state.needsRebuild || !state.abortedPrompt) return undefined;
	if (historyLength !== state.cursor || priorLength >= state.cursor || prompt !== state.abortedPrompt) return undefined;
	if (!abortSettled(state.abortedProcess, state.abortedAt, now)) return undefined;
	return entryBeforeFailedTurn(state.sessionId, state, cwd);
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
	abortedByError?: boolean;
	// The completed turns of this CC session, oldest first, for a /fork of the pi
	// session to start from (see forkPoint).
	turns?: TurnBoundary[];
}

/** Where a completed turn left CC's session file: the history it covered, as the
 *  record's cursor and fingerprint, and the file's size at its completion. */
export interface TurnBoundary {
	cursor: number;
	fingerprint: string;
	fileSize: number;
	// sha256 of the file's first min(fileSize, HEAD_BYTES) bytes. CC only appends to its
	// session file; a rewrite (a rebuild in place, same id) starts with new random
	// uuids, so a changed head means the turn's offsets point into another file.
	head: string;
}

const HEAD_BYTES = 64 * 1024;

function headHash(head: Buffer, fileSize: number): string {
	return createHash("sha256").update(head.subarray(0, Math.min(fileSize, HEAD_BYTES))).digest("hex");
}

/** A session file's size and first HEAD_BYTES bytes, or null when unreadable. */
function readHead(sessionId: string, cwd: string): { size: number; head: Buffer } | null {
	let fd: number | undefined;
	try {
		fd = openSync(getSessionPath(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR), "r");
		const buf = Buffer.alloc(HEAD_BYTES);
		const head = buf.subarray(0, readSync(fd, buf, 0, HEAD_BYTES, 0));
		return { size: fstatSync(fd).size, head };
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

// Enough for any fork point a user picks; older turns fall back to a rebuild.
const MAX_TURN_BOUNDARIES = 200;

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
		// Owner-only, like the capture store: an aborted turn's record holds its prompt.
		mkdirSync(mirrorDir(), { recursive: true, mode: 0o700 });
		// mkdir's mode applies only on creation: tighten a directory an older version made.
		chmodSync(mirrorDir(), 0o700);
		pruneMirrors(now);
		const file = mirrorPath(piSessionId);
		const turns = turnBoundaries(readMirror(piSessionId), record);
		// A temp name per process: two windows saving one session must not write one temp file.
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ ...record, pid: process.pid, ...(turns.length ? { turns } : {}) }), { mode: 0o600 });
		renameSync(tmp, file);
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
export function mirrorAbortFields(mark: AbortMark): Pick<MirrorRecord, "abortedAt" | "abortedPrompt" | "abortedFileOffset" | "abortedCliPid" | "abortedCliStartTime" | "abortedByError"> {
	const cli = mark.abortedProcess?.spawned ? mark.abortedProcess : undefined;
	return { abortedAt: mark.abortedAt, abortedPrompt: mark.abortedPrompt, abortedFileOffset: mark.abortedFileOffset, abortedCliPid: cli?.pid, abortedCliStartTime: cli?.startTime, ...(mark.errorResult ? { abortedByError: true } : {}) };
}

function recordedAbortMark(record: MirrorRecord): AbortMark | undefined {
	if (record.abortedAt === undefined) return undefined;
	return { abortedAt: record.abortedAt, abortedPrompt: record.abortedPrompt, abortedFileOffset: record.abortedFileOffset, abortedProcess: recordedCli(record), ...(record.abortedByError ? { errorResult: true } : {}) };
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
	// A failed turn pi retries ends at the prompt the cursor covers (retryAfterError).
	const abort = recordedAbortMark(record);
	if (record.fingerprintLength !== record.cursor || history.length < record.cursor) return null;
	if (history.length === record.cursor && !abort?.errorResult) return null;
	if (!abort && (history[record.cursor] as { role?: string }).role !== "assistant") return null;
	if (historyFingerprint(history.slice(0, record.cursor)) !== record.fingerprint) return null;
	return { sessionId: record.sessionId, cursor: record.cursor, ...(abort ? { abort } : {}) };
}

// Fork from the parent's CC session. pi's /fork starts a new pi session holding a
// prefix of its parent's history, with no CC session of its own, so the bridge rebuilt
// one from pi's history, and the rebuilt file re-cached the whole conversation, as after
// an abort. A CC fork of the parent's session reproduces the parent's request bytes and
// reads them back (diag/probe-fork-cache.mjs). Each completed turn records where it left
// CC's file; the forked session's first prompt forks that file at the turn its history
// ends with, under its own CC session id, so nothing ever writes the parent's file.

/** The mirror's turn list after a completed turn on `record`: the earlier turns of the
 *  same CC session, then this one. An aborted turn adds none; a file that shrank or
 *  whose head changed was rewritten, and none of its earlier turns hold. */
function turnBoundaries(prior: MirrorRecord | null, record: Omit<MirrorRecord, "pid">): TurnBoundary[] {
	const file = readHead(record.sessionId, record.cwd);
	if (!file || file.size === 0) return [];
	const earlier = prior?.sessionId === record.sessionId ? (prior.turns ?? []).filter((t) => t.cursor < record.cursor) : [];
	const kept = earlier.every((t) => t.fileSize <= file.size && t.head === headHash(file.head, t.fileSize)) ? earlier : [];
	const turn = record.abortedAt === undefined ? [{ cursor: record.cursor, fingerprint: record.fingerprint, fileSize: file.size, head: headHash(file.head, file.size) }] : [];
	return [...kept, ...turn].slice(-MAX_TURN_BOUNDARIES);
}

// Child pi session id -> the pi session it was forked from, set at session_start and
// taken by the child's first prompt. On globalThis, as session-cwd's map, because the
// module instance that sees a session's start may not be the one serving its prompts.
const FORK_PARENTS_KEY = Symbol.for("claude-bridge:forkParents");
function forkParents(): Map<string, string> {
	const g = globalThis as Record<symbol, Map<string, string> | undefined>;
	return (g[FORK_PARENTS_KEY] ??= new Map());
}

/** The id in a pi session file's header line, its first. Reads only the file's head:
 *  a session file holds the whole conversation. */
export function piSessionFileId(file: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const buf = Buffer.alloc(64 * 1024);
		const head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString("utf8").split("\n", 1)[0];
		const header = JSON.parse(head) as { type?: string; id?: unknown };
		return header.type === "session" && typeof header.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Hooked at pi's session_start: a session started by /fork remembers its parent, the
 *  pi session in `previousSessionFile`. Any other start forgets it. */
export function rememberForkParent(event: { reason: string; previousSessionFile?: string }, piSessionId: string): void {
	forkParents().delete(piSessionId);
	if (event.reason !== "fork" || !event.previousSessionFile) return;
	const parent = piSessionFileId(event.previousSessionFile);
	if (parent && parent !== piSessionId) forkParents().set(piSessionId, parent);
}

function lastText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	return (content as { type?: string; text?: string }[]).filter((b) => b.type === "text").at(-1)?.text;
}

// The record types forkSession accepts as upToMessageId: its transcript holds only these
// (sdk.mjs, 0.3.308); a uuid of any other type (custom-title, ...) is "not found". Not
// progress, which the fork drops.
const FORK_POINT_TYPES = new Set(["user", "assistant", "attachment", "system"]);

/** The last chain entry CC had written when `turn` completed, when that turn ends with
 *  pi's final `answer`: the file still starts with the bytes it had then, the records
 *  up to its size parse, the last assistant record among them carries the answer's
 *  text, and no user record follows it. `undefined` otherwise. */
function turnEndEntry(sessionId: string, cwd: string, turn: TurnBoundary, answer: { content?: unknown }): string | undefined {
	const want = lastText(answer.content);
	if (!want) return undefined;
	let text: string;
	try {
		const bytes = readFileSync(getSessionPath(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR));
		if (bytes.length < turn.fileSize || headHash(bytes, turn.fileSize) !== turn.head) return undefined;
		text = bytes.subarray(0, turn.fileSize).toString("utf8");
	} catch {
		return undefined;
	}
	// The turn's records end at its last newline; a line CC was still writing is not one.
	const lines = text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean);
	let last: string | undefined;
	for (let i = lines.length - 1; i >= 0; i--) {
		let record: { type?: string; uuid?: unknown; message?: { content?: unknown } };
		try { record = JSON.parse(lines[i]); } catch { return undefined; }
		if (typeof record.uuid !== "string" || !FORK_POINT_TYPES.has(record.type ?? "")) continue;
		last ??= record.uuid;
		if (record.type === "user") return undefined;
		if (record.type === "assistant") return lastText(record.message?.content) === want ? last : undefined;
	}
	return undefined;
}

/** Removes the file of fork `sessionId` from whichever project directory the SDK wrote
 *  it to, when the bridge does not resolve it there: the fork is ours, made a moment ago
 *  under a fresh id, and nothing resumes it. Never the parent's. */
function removeForkFile(sessionId: string, parentSessionId: string): void {
	if (sessionId === parentSessionId) return;
	try {
		const projects = join(getClaudeDir(process.env.CLAUDE_CONFIG_DIR), "projects");
		for (const dir of readdirSync(projects)) rmSync(join(projects, dir, `${sessionId}.jsonl`), { force: true });
	} catch {}
}

/** The SDK call startFromParentFork makes, replaceable by tests. */
export const forkSeams = { forkSession };

/** Where a forked pi session can start from its parent's CC session. */
export interface ForkPoint {
	// The parent's CC session, and its entry the fork keeps up to.
	sessionId: string;
	upToMessageId: string;
	// History messages the fork covers, as syncSharedSession counts them.
	cursor: number;
}

/** The fork point for a pi session forked from `parentPiSessionId` whose history
 *  before its first prompt is `prior`, or null to rebuild: as loadMirror, nothing
 *  recorded, another cwd, CC's file gone or another live process using it, plus an
 *  aborted parent turn; and a `prior` that is not exactly the history some completed
 *  turn of the parent covered followed by that turn's final answer. */
export function forkPoint(parentPiSessionId: string, prior: { role?: string; timestamp?: number; content?: unknown }[], cwd: string): ForkPoint | null {
	const record = readMirror(parentPiSessionId);
	if (!record || record.cwd !== cwd || record.abortedAt !== undefined) return null;
	if (record.pid !== process.pid && processAlive(record.pid)) return null;
	const cursor = prior.length - 1;
	const turn = record.turns?.find((t) => t.cursor === cursor);
	if (!turn || prior[cursor].role !== "assistant") return null;
	if (historyFingerprint(prior.slice(0, cursor)) !== turn.fingerprint) return null;
	const upToMessageId = turnEndEntry(record.sessionId, cwd, turn, prior[cursor]);
	return upToMessageId ? { sessionId: record.sessionId, upToMessageId, cursor } : null;
}

/** Hooked at the top of the provider's streamSimple: the first prompt of a pi session
 *  /fork started, with no CC session yet, forks its parent's CC session at the forked
 *  history's last turn (the SDK's forkSession, a copy under a new CC session id) and
 *  `plant`s it as the session's, so the sync REUSEs it. `undefined`: no fork to make,
 *  run now; a fork that fails also runs the prompt, which then rebuilds as before. */
export function startFromParentFork(
	streamFn: StreamFn,
	state: object | null,
	plant: (state: { sessionId: string; cursor: number; cwd: string }) => void,
	log: (message: string) => void,
	model: Model<any>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream | undefined {
	const child = options?.sessionId;
	if (!child || state || options?.cacheRetention === "none") return undefined;
	const parent = forkParents().get(child);
	if (!parent) return undefined;
	forkParents().delete(child);
	if (options?.signal?.aborted || readMirror(child)) return undefined;
	const cwd = sessionCwdFor(child);
	const history = nonSystemMessages(context.messages);
	let start = history.length;
	while (start > 0 && history[start - 1].role === "user") start--;
	const point = forkPoint(parent, history.slice(0, start), cwd);
	if (!point) {
		log(`fork: pi session ${child.slice(0, 8)} has no fork point in parent ${parent.slice(0, 8)}, rebuilding`);
		return undefined;
	}
	return streamAfter(async () => {
		try {
			const { sessionId } = await forkSeams.forkSession(point.sessionId, { dir: cwd, upToMessageId: point.upToMessageId });
			if (!existsSync(getSessionPath(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR))) {
				removeForkFile(sessionId, point.sessionId);
				throw new Error(`forked session ${sessionId} not at its session path`);
			}
			plant({ sessionId, cursor: point.cursor, cwd });
			log(`fork: pi session ${child.slice(0, 8)} starts from CC session ${sessionId.slice(0, 8)}, forked from ${point.sessionId.slice(0, 8)} at ${point.upToMessageId.slice(0, 8)}, cursor=${point.cursor}`);
		} catch (error) {
			log(`fork: forking CC session ${point.sessionId.slice(0, 8)} failed, rebuilding: ${error instanceof Error ? error.message : String(error)}`);
		}
	}, streamFn, model, context, options);
}
