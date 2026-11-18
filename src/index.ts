import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type ImageContent, type Model, type SimpleStreamOptions, type TextContent, type Tool, type UserMessage } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { query, type EffortLevel, type ThinkingConfig, type SDKMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { rememberToolArgs, streamingToolArgs, toolArgsFallback } from "./fork-stream-args.js"; // fork: streaming tool args
import "./fork-tool-streaming.js"; // fork: eager tool input streaming
import { createSession, deleteSession, openSession, repairToolPairing } from "cc-session-io";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, realpathSync, statSync } from "fs";
import { abortedTurnAtStart, abortMark, deferUntilAbortSettles, dropMirror, ErrorResultFailure, errorResultMarkable, retryAfterError, historyFingerprint, loadMirror, mirrorAbortFields, persistedAbortMark, postAbortSync, saveMirror, trackCliProcess, withProviderSettingSources, withStderrTail, withRateLimitNoticeFilter, type AbortedTurn, type AbortMark } from "./fork.js";
import { dirname, join } from "path";
import { PROVIDER_ID, messageContentToText, convertPiMessages } from "./convert.js";
import { debugLogPath, diagLogPath } from "./log-paths.js";
import { applyLongContext, buildModels, claudeCodeModelId, extraUsageByChoice, type LongContextSettings } from "./models.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./skills.js";
import { withTurnTiming } from "./fork-turn-timing.js"; // fork: debug timing
import { rememberForkParent, startFromParentFork } from "./fork.js"; // fork: fork cache
import { removeObsoleteCaptureStore } from "./fork.js"; // fork: obsolete capture store
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { QueryContext, ctx, type PendingToolCall } from "./query-state.js";
import { makePromptStream, userMessage, type PromptStream } from "./prompt-stream.js";
import { claudeCodeSettings, loadConfig, removedAskClaudeNotice, systemPromptPresetEnabled, type Config } from "./config.js";
import { collectCarriedAttachments, placeCarriedAttachments, type CarriedAttachment } from "./attachments.js";
import { createToolServer } from "./mcp-server.js";
import { nonSystemMessages, toBridgeContext } from "./transcript.js";
import { forgetSessionCwd, rememberSessionCwd, rememberSummarySession, sessionCwdFor, summarySessionFor } from "./session-cwd.js";
import { updateUsage, type SdkUsage } from "./usage.js";
import { rateLimitResponse } from "./rate-limit.js";

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to the bridge log in pi's agent
// dir (log-paths.ts), not a fixed ~/.pi/agent.

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";

// Applied to every Claude Code subprocess the bridge spawns — provider and the
// compact summary. One place, so a guard is added once rather than per launch,
// and so a missing one is visible.
//
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep the user's claude.ai-connected MCP servers
//   out of a pi session, which serves its own tools.
// - DISABLE_AUTO_COMPACT=1: pi owns compaction; CC compacting its own copy would
//   diverge from pi's history, which is the source of truth for every rebuild.
// - CLAUDE_CODE_ELEGANT_MEADOW=0: stop CC (2.1.308+) logging every API request
//   into its session file (`api-request`, `api-request-shape`, `api-request-blob`
//   records). CC never reads them back to build a request; they only make the
//   file about a third larger.
// - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1: no update checks, MCP registry or
//   telemetry from the child. Set here rather than on pi's own process, so commands
//   pi runs do not inherit it.
// - CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS=1: a resumed session that ends at
//   a tool result (after a terminating tool, or a discarded parked query) reads to CC
//   as an interrupted turn, and behind a server flag CC inserts a "Continue from where
//   you left off." user message ahead of pi's prompt. pi supplies every prompt, so
//   every turn counts as too old to resume. The one exception is a continuation
//   query (a pi turn going on at a tool result with no parked query): its own env
//   overrides this with CC's interrupted-turn resume (continuationEnv), and
//   ccChildEnv drops the two resume variables if pi's environment carries them.
// - CLAUDE_CODE_SILENT_TURN_REMINDER=0: on some models CC adds "The user hasn't heard
//   from you in a while..." after several assistant messages with no visible text.
//   pi decides what the model is told; the message is not in pi's history and the
//   user never sees it.
const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
	CLAUDE_CODE_ELEGANT_MEADOW: "0",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "1",
	CLAUDE_CODE_SILENT_TURN_REMINDER: "0",
} as const;

// Set by Claude Code on its own child processes, or exported by that parent. When pi
// runs inside a Claude Code session they describe that session, not ours: the SDK
// stamps its own entrypoint and version only when they're unset, and CC's Bash tool
// runs CLAUDE_ENV_FILE's script. AI_AGENT is left alone: pi overwrites it at startup.
const PARENT_SESSION_VARS = [
	"CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_SESSION_ATTENDED",
	"CLAUDE_PID", "CLAUDE_EFFORT", "TRACEPARENT", "CLAUDE_CODE_INVOKED_SKILLS", "CLAUDE_ENV_FILE",
	"CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_EXECPATH",
	"CLAUDE_CODE_SSE_PORT", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN",
];

// Environment for every Claude Code subprocess. Config (ANTHROPIC_*, CLAUDE_CONFIG_DIR,
// CLAUDE_CODE_USE_BEDROCK, ...) always passes through; parent-session markers are
// dropped only when CLAUDECODE says pi was started from inside Claude Code.
// CC_CHILD_ENV goes last so its guards always hold.
function ccChildEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...parent };
	if (parent.CLAUDECODE) for (const name of PARENT_SESSION_VARS) delete env[name];
	// Only a continuation query resumes an interrupted turn, and only by its own env.
	delete env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN;
	delete env.CLAUDE_CODE_RESUME_PROMPT;
	return { ...env, ...CC_CHILD_ENV };
}

// The child env of a continuation query (upstream #274): a pi turn that goes on at a
// tool result with no query parked on it. Written on stdin, the continue text would
// follow the tool result as a second user message in a row, and CC inserts its
// <synthetic> "No response requested." between them, which the model sometimes takes as
// its finished answer. Instead CC resumes the turn itself, from a session file that
// ends at the tool result, recording `text` as a meta user record; nothing is read
// from stdin. MAX_AGE_MS=0 lifts the age bound CC_CHILD_ENV sets. Pinned against the
// installed CC in tests/int-cc-contracts.mjs.
function continuationEnv(text: string): NodeJS.ProcessEnv {
	return {
		...ccChildEnv(),
		CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1",
		CLAUDE_CODE_RESUME_PROMPT: text,
		CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "0",
	};
}

// Pi owns context files on the provider path, so Claude Code must not load its
// own on top: otherwise project CLAUDE.md/AGENTS.md files arrive twice, and
// ~/.claude/CLAUDE.md — a user persona written for a harness that is not the
// one running — arrives at all, stamped "These instructions OVERRIDE any default
// behavior" and outranking Pi's own AGENTS.md.
//
// Excludes rather than settingSources: the source gate that suppresses CLAUDE.md
// is the same one that reads settings.json, where Bedrock/Vertex users keep
// `env` and `apiKeyHelper`. Patterns are matched with picomatch against absolute
// paths; the filename globs cover user, ancestor, project and .claude/ copies,
// while rules need their own. Managed/policy memory is not excludable by design.
const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"];

// Unique per module evaluation — confirms whether subagents share module state
const moduleInstanceId = Math.random().toString(36).slice(2, 8);

function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const logPath = debugLogPath();
	try { mkdirSync(dirname(logPath), { recursive: true }); } catch { /* ignore */ }
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
		return JSON.stringify(a);
	};
	const msg = args.map(fmt).join(" ");
	// A debug line is never worth failing the caller over (a read-only or full disk).
	try { appendFileSync(logPath, `[${ts}] [${moduleInstanceId}] ${msg}\n`); } catch { /* ignore */ }
}

// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(debugLogPath()), "cc-cli-logs");
	try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

/** Unconditional diagnostic dump — for "should never happen" paths. Creates pi's agent
 *  dir itself: callers run inside streamSimple, where a missing dir must not throw. */
function diagDump(label: string, data: Record<string, unknown>) {
	const ts = new Date().toISOString();
	const entry = { ts, moduleInstanceId, label, ...data };
	const logPath = diagLogPath();
	// Diagnostics must never take down what they describe: a caller may be a timer
	// (the lost tool call watchdog) where a throw escapes uncaught and skips teardown.
	try {
		mkdirSync(dirname(logPath), { recursive: true });
		appendFileSync(logPath, JSON.stringify(entry) + "\n");
	} catch (error) {
		debug(`DIAG: ${label} could not be written to ${logPath}:`, error);
		return;
	}
	debug(`DIAG: ${label} (see ${logPath})`);
}

// --- Constants ---

// Marks which bridge module instance owns the registered provider's stream fn.
// Full registration policy (first vs later instances, shared vs own registry):
// see the "--- Provider ---" block in activate() below.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
const MODELS = buildModels(getModels("anthropic"));
let providerSettings: NonNullable<Config["provider"]> = {};
let longContextSettings: LongContextSettings = { plan: "pro", longContextExtraUsage: false };

// --- Error handling ---

function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try { return JSON.stringify(err); } catch {}
	}
	return String(err);
}

// --- Session persistence ---

interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// The pi session this CC conversation serves, from the provider call's
	// options.sessionId. Attribution for history rewrites: a subagent's
	// session_compact must not force a rebuild of a conversation that belongs
	// to a different pi session. Null until a provider call recorded it.
	piSessionId?: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY where we have just killed a CC subprocess: an abort, or a query
	// discarded because pi rewrote the history under it. The killed subprocess
	// may still be flushing a late "[Request interrupted by user]" record to the
	// session JSONL. Reusing the same sessionId/path would race that orphan write
	// into our fresh file and break CC's parent-uuid chain on the next resume.
	// When this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. A compact or tree navigation
	// with no query in flight does NOT set this — there's no concurrent CC writer
	// then, so in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
	abortedAt?: AbortMark["abortedAt"]; abortedPrompt?: AbortMark["abortedPrompt"]; abortedFileOffset?: AbortMark["abortedFileOffset"]; abortedProcess?: AbortMark["abortedProcess"]; // fork: abort resume
	errorResult?: AbortMark["errorResult"]; // fork: error resume
	// The system prompt this CC session was made with (promptDigestFor). CC records
	// a session's prompt on its first run and re-sends it on every --resume, ignoring
	// the one the resuming query passes (tests/int-cc-contracts.mjs), so a different
	// digest rebuilds the session from pi's history. Undefined: unknown (a mirror an
	// older version wrote), which rebuilds too.
	promptDigest?: string;
}

/** The system prompt the bridge sends Claude Code, as a digest: the preset setting
 *  and pi's whole prompt text. Upstream's promptDigest, on the normalized setting. */
function promptDigestFor(systemPrompt: string | undefined): string {
	return createHash("sha256").update(JSON.stringify([systemPromptPresetEnabled(providerSettings), systemPrompt ?? ""])).digest("hex");
}

/**
 * Claude Code's `@file` expansions from the session about to be replaced.
 *
 * Must be called before `deleteSession`, which wipes the file they live in —
 * reading after it yields nothing, with no error to notice.
 */
function readCarriedAttachments(sessionId: string, cwd: string): CarriedAttachment[] {
	try {
		const previous = openSession({ sessionId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
		return collectCarriedAttachments(previous.records);
	} catch (error) {
		// A post-abort rebuild reads a file the killed CC subprocess may have been
		// midway through writing, and cc-session-io parses each line with a bare
		// JSON.parse, so a truncated last line throws. Throwing here would turn a
		// lost attachment into a failed turn; carrying none is exactly what happened
		// before this existed, so the failure mode is bounded by the status quo.
		debug(`WARNING: could not read attachments from session ${sessionId.slice(0, 8)}:`, error);
		return [];
	}
}

/** The session key a pi session's provider calls address. Unattributed calls
 *  (no options.sessionId — a host that omits it)
 *  share the "(none)" bucket: they cannot be told apart, so they share the
 *  pre-existing single-slot semantics. */
function sessionKey(piSessionId: string | null | undefined): string {
	return piSessionId ?? "(none)";
}

/** Mirror of the CC conversation one pi session's turns are running on. One
 *  entry per pi session: a bridge process serves several sessions at once
 *  (pi-subagents children run their own AgentSessions), and a single shared
 *  slot forced them to fight over it — a length-matching foreign sync could
 *  REUSE or rebuild another session's CC file, and the completion capture was
 *  last-writer-wins (a foreground child in the parent's first turn permanently
 *  reassigned the parent's conversation). Keyed lookup removes the fight: each
 *  session's reads, writes and teardown marks touch only its own mirror. */
const sharedSessions = new Map<string, SessionState>();

/** The mirror for `piSessionId`, or null when this session has none yet. */
function sessionStateFor(piSessionId: string | null | undefined): SessionState | null {
	return sharedSessions.get(sessionKey(piSessionId)) ?? null;
}

/** Replace (or plant) the mirror for `piSessionId`. */
function setSessionStateFor(piSessionId: string | null | undefined, state: SessionState | null): void {
	if (state === null) sharedSessions.delete(sessionKey(piSessionId));
	else sharedSessions.set(sessionKey(piSessionId), state);
}

// pi replaced one of its sessions' history (compact, tree) rather than appending
// to it. Read on the tool-result path — the one provider call that never reaches
// syncSharedSession — so a query parked at a tool boundary is discarded rather
// than resumed (issue #101). Keyed by pi session id, not process-global: a bridge
// process serves several pi sessions at once (subagents run their own
// AgentSessions and can compact mid-run while the parent is parked), and
// marking across that boundary kills healthy queries (or, worse, rebuilds the
// parent around a compaction that never touched it).
//
// Holds real pi session ids only, never the "(none)" key: no production caller
// marks with null (the rewrite events attribute via ctx.sessionManager), and
// every reader guards on a non-null piSessionId — so a "(none)" entry could
// never be matched or consumed, only leaked.
const historyRewrittenBySession = new Set<string>();

/** Handlers that arm rewrite staleness, one per module instance. Worktree-
 *  spawned subagents can load this module fresh (pi's loader cache is keyed on
 *  cwd, and a worktree cwd clears it), while the serving instance — whose
 *  streamSimple the pi sessions actually call — is whoever registered first.
 *  A fresh instance must forward its session's rewrites to the serving one.
 *  Symbol.for: one registry per process, like SHARED_CAPTURES_KEY below. */
const MARK_REBUILD_HOOKS_KEY = Symbol.for("claude-bridge:markRebuildHooks");
type MarkRebuildHook = (piSession: string | null, event: string) => void;
const markRebuildHooks: Set<MarkRebuildHook> =
	((globalThis as Record<symbol, unknown>)[MARK_REBUILD_HOOKS_KEY] as Set<MarkRebuildHook> | undefined) ?? new Set();
(globalThis as Record<symbol, unknown>)[MARK_REBUILD_HOOKS_KEY] = markRebuildHooks;

/** pi mutated its messages array out from under us: force the next
 *  syncSharedSession down REBUILD, and arm the discard above. `piSession`
 *  is never null from an event handler (each pi session has its own runner).
 *  The "(none)" key still covers the mirror for a hypothetical direct caller
 *  with no session id, so such a rewrite forces the REBUILD side; the discard
 *  set holds real ids only — see the comment on historyRewrittenBySession. */
function markRebuildForSession(piSession: string | null, event: string): void {
	// The rewriting session's own mirror: the rewrite changed the history it was
	// built from, so its next sync must REBUILD rather than REUSE. Every other
	// session's mirror stays untouched — its conversation was never rewritten.
	const key = sessionKey(piSession);
	if (piSession) dropMirror(piSession); // fork: reopen resume
	const state = sharedSessions.get(key);
	if (!state) {
		debug(`${event}: history rewritten, no session to mark yet`);
	} else {
		sharedSessions.set(key, { ...state, needsRebuild: true });
		debug(`${event}: marking needsRebuild on session ${state.sessionId.slice(0, 8)}`);
	}
	// Arming parked contexts cannot wait for delivery: the entry checks
	// `resultCtx.historyStale`, and a rewrite usually lands *while* the query is
	// parked (compaction runs inside pi's turn loop, not between provider calls).
	if (piSession) historyRewrittenBySession.add(piSession);
	armStaleContexts();
}

/** Copy each armed session's mark onto the parked queries built from it. */
function armStaleContexts(): void {
	for (const c of activeQueryContexts) {
		if (c.piSessionId && historyRewrittenBySession.has(c.piSessionId)) c.historyStale = true;
	}
}

// This instance enlists. Session ids reaching any hook equal options.sessionId
// on the serving instance's provider calls, so forwarding is safe: only the
// owning instance's contexts and SessionState match the key.
markRebuildHooks.add(markRebuildForSession);

/** Event handlers call this: it fans the rewrite out to every module instance
 *  in the process, of which exactly one is serving provider traffic for any
 *  given pi session. */
function sponsorMarkRebuildForSession(piSession: string | null, event: string): void {
	for (const hook of markRebuildHooks) hook(piSession, event);
}

// Convert pi messages to Anthropic API format for session import.
// Lossy: only text, thinking and toolCall blocks survive, and thinking only when
// Claude Code itself minted the signature. An assistant message whose blocks all
// filter out keeps its slot with a placeholder, since dropping it can create a
// tool_result with no preceding tool_use. A turn aborted before anything streamed
// is dropped instead — it never had content, and inventing one diverges from the
// prefix Claude Code cached.
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
	carried?: readonly CarriedAttachment[],
): void {
	const { anthropicMessages, sanitizedIds, dropped } = convertPiMessages(messages, customToolNameToSdk);

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		if (Array.isArray(c)) return `[${i}]${m.role}:${(c).map((b) => b.type).join("+")}`;
		return `[${i}]${m.role}:?`;
	}).join(" "));
	// The roles line above shows only what survived, so a stripped block is
	// indistinguishable there from one that never existed. Name the losses.
	const droppedParts = [
		dropped.thinking ? `${dropped.thinking} thinking (${[...dropped.providers].sort().join(", ")})` : "",
		dropped.abortedTurns ? `${dropped.abortedTurns} aborted turn(s)` : "",
		...[...dropped.other].map(([type, n]) => `${n} ${type}`),
	].filter(Boolean);
	if (droppedParts.length > 0) {
		debug(`convertAndImportMessages: dropped ${droppedParts.join(", ")}`);
	}
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}
	// Pre-repair for debug logging; importMessages also repairs internally (idempotent).
	const repaired = repairToolPairing(anthropicMessages);
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	// Placement runs against the repaired array because that is the index space
	// importMessages reads. Attachments are links in CC's uuid chain, so they have
	// to be written in order with the messages, not appended afterwards.
	const placed = carried?.length
		? placeCarriedAttachments(carried, repaired as unknown as { role: string; content: unknown }[])
		: undefined;
	if (placed?.skipped.length) {
		debug(`convertAndImportMessages: dropped ${placed.skipped.length} carried attachment(s): ${placed.skipped.join("; ")}`);
	}
	if (placed?.attachments.length) {
		debug(`convertAndImportMessages: carrying ${placed.attachments.length} attachment(s) across the rebuild`);
	}
	if (repaired.length) {
		session.importMessages(repaired, placed?.attachments.length ? { attachments: placed.attachments } : undefined);
	}
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
function extractAllToolResults(context: Context): McpResult[] {
	const { results, stopIdx } = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
	return results;
}

/** Index of the first message of the current user turn — the trailing run of
 *  user messages that has not been written into the Claude Code session yet.
 *  Equals messages.length when the last message is not a user message.
 *
 *  Single source of truth for the history/prompt split: everything before this
 *  index is replayed as session history, everything from it onward becomes the
 *  prompt. Deriving both halves from one index is what keeps a message from
 *  landing in both — an extension appending a display-only user message after
 *  the real one (see issue #34) makes the turn longer than one message. */
function turnStart(messages: Context["messages"]): number {
	let i = messages.length;
	while (i > 0 && messages[i - 1].role === "user") i--;
	return i;
}

/** Extract the current user turn as a prompt string. Returns null if the last message is not a user message. */
function extractUserPrompt(messages: Context["messages"]): string | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;
	// Drop empties before joining so an all-empty turn still yields "" and trips
	// the caller's empty-prompt guard rather than sending bare newlines.
	return turn
		.map((m) => (typeof m.content === "string" ? m.content : messageContentToText(m.content)))
		.filter((text) => text)
		.join("\n");
}

/** Extract the current user turn as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const turn = messages.slice(turnStart(messages)) as UserMessage[];
	if (turn.length === 0) return null;

	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const message of turn) {
		const content: (TextContent | ImageContent)[] = typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content;
		// Off-type content violates UserMessage's contract, so fail rather than
		// degrade — but name the shape, since the cause is almost always another
		// extension appending a malformed message, not this file.
		if (!Array.isArray(content)) {
			throw new Error(
				`extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content} — likely a malformed message from another extension`,
			);
		}
		for (const block of content) {
			if (block.type === "text" && block.text) {
				blocks.push({ type: "text", text: block.text });
			} else if (block.type === "image") {
				// Guard before logging: data-less image blocks do occur, and reading
				// .length off the missing field in the debug template would throw
				// before this check ever runs (template args evaluate unconditionally).
				if (!block.data || !block.mimeType) {
					debug(`image block missing data or mimeType, skipping: keys=${Object.keys(block).join(",")}`);
					continue;
				}
				debug(`image block: mimeType=${block.mimeType}, data length=${block.data.length}`);
				hasImage = true;
				blocks.push({
					type: "image",
					source: {
						type: "base64",
						media_type: block.mimeType as Base64ImageSource["media_type"],
						data: block.data,
					},
				});
			}
		}
	}
	debug(`extractUserPromptBlocks: ${turn.length} msgs in turn, ${blocks.length} blocks, types=${blocks.map((b) => b.type).join(",")}`);
	return hasImage ? blocks : null;
}

function newAssistantOutput(model: Model<any>, text: string, stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function extractIsolatedSummaryPrompt(messages: Context["messages"]): string {
	if (messages.length !== 1 || messages[0].role !== "user") {
		throw new Error(
			`isolatedStreamFn: expected exactly 1 user message, got ${messages.length} ` +
			`(${messages.map((m) => m.role).join(",")})`,
		);
	}
	const promptText = extractUserPrompt(messages);
	if (!promptText) throw new Error("isolatedStreamFn: summarization prompt is empty");
	return promptText;
}

/** Failure text for an SDK result, or undefined when it succeeded. CC reports API failures
 *  (429 capacity, overload, prompt-too-long) with `is_error` on an otherwise success-shaped
 *  result; the dedicated error subtypes carry `errors` instead. */
function resultErrorText(message: SDKMessage): string | undefined {
	const result = message as SDKMessage & { subtype?: string; is_error?: boolean; result?: string; errors?: unknown; error?: unknown };
	if (result.subtype === "success") return result.is_error ? result.result || "Claude Code reported an error" : undefined;
	if (Array.isArray(result.errors) && result.errors.length) return result.errors.map(String).join("\n");
	if (typeof result.error === "string") return result.error;
	return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
}

/** Name a failure as a rate limit when a rejection preceded it.
 *
 *  pi has no typed rate-limit error — `stopReason` is only ever `"error"` and the sole carrier
 *  is `errorMessage` — so everything that reacts to a rate limit pattern-matches that string:
 *  pi-subagents gates `fallbackModels` on its own pattern list, and key-rotating extensions use
 *  their own. Claude Code words a subscription limit as "You're out of extra usage · resets
 *  6:30pm", which matches none of them, so an exhausted quota reads as a fatal error and the
 *  fallback chain never runs (issue #58).
 *
 *  Leading with "Claude quota exceeded — rate limit" rather than appending keeps both phrases
 *  in any truncated render, and avoids the `<tool> failed (exit N):` shape that pi-subagents
 *  treats as a tool failure and refuses to retry. "quota exceeded" is on pi-ai's non-retryable
 *  list, which wins over its retryable "rate limit" pattern, so pi hands the rejected window
 *  straight to fallback instead of retrying a limit that resets in hours (issue #183). */
function describeRateLimitFailure(rejection: { rateLimitType?: string; resetsAt?: number }, failure: string): string {
	const kind = rejection.rateLimitType ? ` (${rejection.rateLimitType})` : "";
	const resets = rejection.resetsAt ? ` — resets ${new Date(rejection.resetsAt * 1000).toLocaleTimeString()}` : ""; // resetsAt: Unix seconds (unit undocumented in the SDK; observed)
	return `Claude quota exceeded — rate limit${kind}${resets}: ${failure}`;
}

/** Why Anthropic would bill or refuse Extra Usage with the plan limit not reached: it
 *  classifies some system prompts as a third-party app's (upstream f14f2ed). */
const THIRD_PARTY_SUSPECT = "no plan limit was reported as reached, so Anthropic may have read the system prompt as a third-party app";

/** Reports to the call that owns the open stream, before its next event, as pi's own
 *  providers do. A failing consumer must not end the turn it is observing. */
async function reportHeldRateLimit(c: QueryContext, model: Model<any>): Promise<void> {
	const info = c.heldRateLimit;
	if (!info || !c.currentPiStream || !c.currentOnResponse) return;
	c.heldRateLimit = undefined;
	try {
		await c.currentOnResponse(rateLimitResponse(info), model);
	} catch (error) {
		debug("rate limit: onResponse failed", error);
	}
}

function isolatedStreamFn(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runIsolatedSummary(model, context, options, stream);
	return stream;
}

async function runIsolatedSummary(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	// pi delivers compaction/branch-summary requests as a transcript: the summarization
	// prompt folded into a leading system message ahead of the lone user message
	// (issue #106). toBridgeContext restores the prompt/tools fields the extraction
	// assertion below assumes; the summarization prompt still reaches CC as its systemPrompt.
	context = toBridgeContext(context);
	let sdkQuery: ReturnType<typeof query> | undefined;
	let wasAborted = false;
	const onAbort = () => {
		wasAborted = true;
		void sdkQuery?.interrupt().catch(() => {});
		try { sdkQuery?.close(); } catch {}
	};

	try {
		// One-off summarizer calls (compaction, branch summary, turn prefix, bug report —
		// anything routed through pi's completeSummarization) are marked cacheRetention:
		// "none". Any of them may appear in a future pi release without a bridge change,
		// so route on the marker, not on which summarizer is calling. Non-summarizer calls
		// must still match the [system,user] compaction shape exactly.
		const isOneOffSummary = options?.cacheRetention === "none";
		const promptText = isOneOffSummary
			? extractUserPrompt(context.messages)
			: extractIsolatedSummaryPrompt(context.messages);
		if (!promptText) throw new Error("runIsolatedSummary: one-off summary without a user prompt (last message is not user?)");
		const cwd = sessionCwdFor(summarySessionFor(options?.signal) ?? options?.sessionId);
		const compactProviderSettings = loadConfig().provider;
		const claudeExecutable = compactProviderSettings?.pathToClaudeCodeExecutable;
		const cliModel = claudeCodeModelId(model, longContextSettings);
		// Honour the caller's reasoning level, same mapping as the provider path.
		const effort = effortForReasoning(model, options?.reasoning);
		const thinking = thinkingForReasoning(model, options?.reasoning);
		debug(`compact summary: spawn model=${cliModel} registeredModel=${model.id} effort=${effort ?? "default"}${thinking ? " thinking=disabled" : ""} promptLen=${promptText.length}`);

		sdkQuery = queryImpl({
			prompt: promptText,
			options: {
				cwd,
				env: ccChildEnv(),
				settings: { autoMemoryEnabled: false },
				tools: [],
				strictMcpConfig: true,
				settingSources: [] as SettingSource[],
				skills: [],
				persistSession: false,
				systemPrompt: context.systemPrompt,
				model: cliModel,
				maxTurns: 1,
				...(effort ? { effort } : {}),
				...(thinking ? { thinking } : {}),
				...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
				...makeCliDebugOptions("compact-summary"),
			},
		});

		if (options?.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		let assistantText = "";
		let finalText = "";
		let errorText: string | undefined;
		let firstEventLogged = false;

		for await (const message of sdkQuery) {
			if (!firstEventLogged) {
				debug(`compact summary: first event type=${message.type}`);
				firstEventLogged = true;
			}
			if (wasAborted) break;

			if (message.type === "assistant") {
				for (const block of (message as any).message?.content ?? []) {
					if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
				}
			} else if (message.type === "result") {
				logServedContextWindow("compact summary", message, model);
				errorText = resultErrorText(message);
				if (!errorText && message.subtype === "success") finalText = message.result || assistantText;
			}
		}

		if (wasAborted) {
			const output = newAssistantOutput(model, "", "aborted", "Operation aborted");
			debug("compact summary: aborted");
			stream.push({ type: "error", reason: "aborted", error: output });
			stream.end();
			return;
		}

		const text = finalText || assistantText;
		if (errorText || !text.trim()) {
			const msg = errorText ?? "Claude Code summary returned empty text";
			debug(`compact summary: error ${msg}`);
			stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
			stream.end();
			return;
		}

		debug(`compact summary: done textLen=${text.length}`);
		stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") });
		stream.end();
	} catch (err) {
		const msg = errorMessage(err);
		debug("runIsolatedSummary threw; pushing terminal error", err);
		stream.push({ type: "error", reason: "error", error: newAssistantOutput(model, "", "error", msg) });
		stream.end();
	} finally {
		options?.signal?.removeEventListener("abort", onAbort);
		try { sdkQuery?.close(); } catch {}
	}
}

interface SyncResult {
	sessionId: string | null;
	preserveSharedSession?: boolean;
	resumeSessionAt?: string; // fork: error resume
}

/**
 * Ensure the shared session has all messages up to (but not including) the last user message.
 * Returns session ID to resume from, or null if no resume needed.
 */
// Read the session file we just wrote and sanity-check it. Warns instead of
// throwing — CC may be more tolerant than our checks, so a false positive
// shouldn't block the user. Pure logic is in session-verify.js; this wrapper
// fans each warning out to debug log + piUI notify + diagDump.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		piUI?.notify(
			`Session file issue: ${msg}\n` +
			`cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
			`Please copy and paste this message into a new issue at https://github.com/viniciosrab/pi-claude-bridge/issues/new` +
			(DEBUG ? ` and attach ${debugLogPath()}` : ` (rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log)`),
			"warning",
		);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null });
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`);
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the existing sharedSession (or drifted
//     only by the trailing final-assistant message that pi appends after
//     streamSimple returns, which CC's own persisted session already has).
//     Returns the existing sessionId. Keeps CC's prompt cache warm.
//   REBUILD — no session yet, or pi's history has diverged (non-trailing
//     missed messages, e.g. another provider took a turn). Wipes the existing
//     session file (if any) and writes a fresh one containing all prior
//     messages, reusing the same sessionId across rebuilds so UUIDs stay
//     stable for the lifetime of pi's session.
//
// Why a full rebuild rather than patching:
//   Injecting deltas into an existing session creates a branch that CC's
//   --resume doesn't follow (documented attempt prior to this). A complete
//   overwrite at the same path is simpler and correct.
//
// Why reuse the sessionId across rebuilds:
//   CC re-reads the JSONL on every --resume call — no in-process UUID
//   caching, including when CC had appended its own tool_use/tool_result
//   records between rebuilds (validated by an experiment no longer in the tree). Preserving the UUID means stable log correlation across
//   provider switches and no orphaned session files.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics (int-cache.sh,
// int-session-resume.mjs) keep grepping the same anchors.
	function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	customToolNameToSdk?: Map<string, string>,
	modelId?: string,
	piSessionId?: string | null,
	isReentrant = true,
	promptDigest?: string,
	continuation = false,
): SyncResult {
	// System messages are pi's transcript representation of prompt and tool state, not
	// conversation history — they are never imported into a CC session, so exclude them from
	// the history space (priorMessages, cursor, missed) everywhere below (issue #106).
	// The mirror this sync coordinates belongs to the syncing pi session alone:
	// every read and write below addresses sessionStateFor(piSessionId), so a
	// foreign session's shape-matching context can never REUSE or rebuild another
	// session's CC file.
	if (piSessionId && !sessionStateFor(piSessionId)) restoreMirror(piSessionId, nonSystemMessages(messages), cwd); // fork: reopen resume
	const sharedSession = sessionStateFor(piSessionId);
	// CC re-sends the prompt a session was made with on every resume, plain, after an
	// abort or cut back after an error: a different prompt rebuilds from pi's history,
	// like a rewrite. A rebuild after an abort or error result still rotates (forceRotate).
	// Without a digest (a direct caller) the prompt is not compared. Nor for a query
	// reentrant on the session (an extension's one-shot or a foreground subagent inside
	// the owner's turn, under its own prompt): its prompt is not the session's, and
	// comparing it would rebuild the owner's session and drop its mirror.
	if (promptDigest !== undefined && !isReentrant && sharedSession && !sharedSession.needsRebuild && sharedSession.promptDigest !== promptDigest) {
		debug(`sync: system prompt changed (${sharedSession.promptDigest?.slice(0, 8) ?? "unknown"} -> ${promptDigest.slice(0, 8)}), rebuilding session ${sharedSession.sessionId.slice(0, 8)} from pi's history`);
		sharedSession.needsRebuild = true;
		if (piSessionId) dropMirror(piSessionId);
	}
	const history = nonSystemMessages(messages);
	const priorMessages = history.slice(0, turnStart(history)); // everything before the current user turn
	// A continuation (upstream #274) has CC resume its turn from the file it is handed,
	// so that file must end at the tool result: never CC's own file after an abort or an
	// error result, nor a REUSE, which can hold records past it. It rebuilds.
	if (continuation && sharedSession && !sharedSession.needsRebuild) {
		debug(`sync: continuation at a tool result, rebuilding session ${sharedSession.sessionId.slice(0, 8)} from pi's history`);
		sharedSession.needsRebuild = true;
		if (piSessionId) dropMirror(piSessionId);
	}
	const forkRetry = retryAfterError(sharedSession, priorMessages.length, history.length, abortedTurnAtStart(extractUserPromptBlocks(messages), extractUserPrompt(messages) ?? "", null, cwd).prompt, cwd); // fork: error resume
	if (forkRetry) return { ...resumeAfterAbort(piSessionId, sharedSession!, priorMessages.length, cwd), resumeSessionAt: forkRetry }; // fork: error resume
	const forkAbort = postAbortSync(sharedSession, priorMessages, cwd); // fork: abort resume
	if (forkAbort === "resume") return resumeAfterAbort(piSessionId, sharedSession!, priorMessages.length, cwd); // fork: abort resume
	if (forkAbort === "rebuild") { sharedSession!.needsRebuild = true; if (piSessionId) dropMirror(piSessionId); } // fork: abort resume

	// REUSE path
	//
	// Guard on priorMessages.length >= cursor: a shorter incoming context cannot
	// be a continuation of the cached session. This is the general invariant for
	// pi-side history rewrites such as /compact and session_tree: without it,
	// missed = [].slice(cursor) can falsely hit REUSE and resume an unrelated
	// longer CC session. See issue #25.
	if (sharedSession && !sharedSession.needsRebuild && priorMessages.length >= sharedSession.cursor) {
		const missed = priorMessages.slice(sharedSession.cursor);
		const trailingAssistantOnly =
			missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
		if (missed.length === 0 || trailingAssistantOnly) {
		if (trailingAssistantOnly) {
			setSessionStateFor(piSessionId, { ...sharedSession, cursor: priorMessages.length, cwd });
			debug(`Case 3: advanced cursor past trailing assistant, resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${priorMessages.length}`);
		} else {
			debug(`Case 3: resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
		}
		debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${sharedSession?.cursor}`);
		return { sessionId: sharedSession.sessionId };
		}
	}
	// This is what keeps a caller with a pruned or short context from resuming
	// — then overwriting — the bucket's session: shorter-than-cursor means the
	// incoming history cannot be a continuation, so start clean and preserve.
	// Historically this also caught reentrant subagents (a subagent's priors are
	// shorter than the parent's cursor); with per-session mirrors it now catches
	// the pruned-context shapes on a session's own bucket, and the same shapes
	// from callers without a session id on the "(none)" bucket. The captured ephemeral session is
	// deleted once its query completes (see preserveSharedSession in the
	// completion handler).
	//
	// It is NOT, despite an earlier comment here, the isolated compact-summary
	// path: runIsolatedSummary never calls syncSharedSession at all.
	//
	// Reentrancy is the test rather than the message count, which is a superset:
	// an extension that rewrites pi's history in place also shortens priors, and
	// markRebuild only covers pi's own /compact and session_tree — there is no
	// generic history-mutation event to hang an extension's rewrite off. Without
	// this, a rewrite reaches CC for one query, has its session deleted here to
	// preserve the parent's, and the next turn resumes the pre-rewrite transcript
	// (issues #77, #55). A non-reentrant shorter context falls through to REBUILD.
	if (sharedSession && !sharedSession.needsRebuild && priorMessages.length < sharedSession.cursor && isReentrant) {
		debug(`Case 1 synthetic: clean start for shorter context, preserving shared session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`);
		debug(`syncResult: path=clean-start preserve-shared sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
		return { sessionId: null, preserveSharedSession: true };
	}

	// REBUILD path
	if (priorMessages.length === 0) {
		// A retry of a failed first turn starts clean: drop the error mark with the
		// state, or it would survive this query and rebuild the next turn. // fork: error resume
		if (sharedSession?.errorResult) { setSessionStateFor(piSessionId, null); if (piSessionId) dropMirror(piSessionId); }
		debug(`Case 1: clean start, ${history.length} total messages`);
		debug(`syncResult: path=clean-start`);
		return { sessionId: null };
	}
	const previousSessionId = sharedSession?.sessionId;
	const previousCursor = sharedSession?.cursor ?? 0;
	// preserveId: rebuild in place (deleteSession + createSession with the
	// existing UUID), so prompt-cache UUIDs stay stable for log correlation
	// and for any tools that key off them. Skipped when there's a concurrent
	// writer we shouldn't race (forceRotate).
	const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate;
	// Before deleteSession — it wipes the file these live in.
	const carried = previousSessionId !== undefined ? readCarriedAttachments(previousSessionId, cwd) : [];
	// createSession and the import only build records in memory, so a history that
	// cannot be converted throws here while the old file is still intact.
	const session = createSession({
		projectPath: cwd,
		claudeDir: process.env.CLAUDE_CONFIG_DIR,
		...(preserveId ? { sessionId: previousSessionId } : {}),
		...(modelId ? { model: modelId } : {}),
	});
	convertAndImportMessages(session, priorMessages, customToolNameToSdk, carried);
	if (preserveId) {
		// Wipe prior jsonl + companion dir (no-op if nothing to wipe).
		deleteSession(previousSessionId!, cwd, process.env.CLAUDE_CONFIG_DIR);
	}
	try {
		session.save();
	} catch (error) {
		// The old file may be gone and the new one is not whole: no state may name either.
		setSessionStateFor(piSessionId, null);
		if (piSessionId) dropMirror(piSessionId);
		throw error;
	}
	// records, not messages: `messages` filters out the attachment records that
	// carrying an `@file` expansion across a rebuild writes into the same file.
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.records.length, cwd);
	setSessionStateFor(piSessionId, { sessionId: session.sessionId, cursor: priorMessages.length, cwd, piSessionId: piSessionId ?? undefined, promptDigest });
	if (piSessionId) dropMirror(piSessionId); // fork: fork cache, the turns recorded for the old file no longer hold
	if (previousSessionId === undefined) {
		debug(`Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.records.length} records`);
	} else if (preserveId) {
		const missedCount = priorMessages.length - previousCursor;
		debug(`Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.records.length} records`);
	} else {
		debug(`Case 4 post-abort: ${priorMessages.length} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.records.length} records`);
	}
	debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath);
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`);
	return { sessionId: session.sessionId };
}

// The SDK's query(), or a test double (see setQuery).
let queryImpl: typeof query = query;
queryImpl = withProviderSettingSources(queryImpl, () => providerSettings); // fork: provider.loadClaudeSettings
if (DEBUG) queryImpl = withTurnTiming(queryImpl, debug); // fork: debug timing

// @internal
export const __test = {
	setSwitchModelWaitMs(ms: number | null) {
		switchModelWaitMs = ms ?? SWITCH_MODEL_WAIT_MS;
	},
	resolveMcpTools,
	setQuery(fn: typeof query | null) {
		queryImpl = fn ?? query;
		queryImpl = withProviderSettingSources(queryImpl, () => providerSettings); // fork: provider.loadClaudeSettings
		if (DEBUG) queryImpl = withTurnTiming(queryImpl, debug); // fork: debug timing
	},
	resetSharedSession(piSessionId?: string | null) {
		// No id: full reset (the pre-map semantics — tests start from a blank slate).
		if (piSessionId === undefined) sharedSessions.clear();
		else setSessionStateFor(piSessionId, null);
		historyRewrittenBySession.clear();
	},
	markRebuildForSession,
	historyRewrittenBySession,
	armStaleContexts,
	discardRewrittenQuery,
	contextForToolResults,
	isQueryAbandoned: (q: object) => abandonedQueries.has(q),
	get activeQueryContexts() {
		return activeQueryContexts;
	},
	setSharedSession(piSessionId: string | null, state: SessionState | null) {
		setSessionStateFor(piSessionId, state);
	},
	getSharedSession(piSessionId: string | null = null) {
		return sessionStateFor(piSessionId);
	},
	setPiUI(ui: ExtensionUIContext | null) {
		piUI = ui;
		piUI = withRateLimitNoticeFilter(piUI, () => providerSettings); // fork: provider.rateLimitWarnings
	},
	/** Returns the previous settings so a test can restore them. */
	setLongContextSettings(settings: LongContextSettings): LongContextSettings {
		const previous = longContextSettings;
		longContextSettings = settings;
		return previous;
	},
	toBridgeContext,
	isolatedStreamFn,
	effortForReasoning,
	thinkingForReasoning,
	syncSharedSession,
	promptDigestFor,
	extractUserPromptBlocks,
	consumeQuery,
	finalizeCurrentStream,
	resultErrorText,
	deliverToolResults,
	toMcpToolDefs,
	drainForAbort,
	CC_CHILD_ENV,
	ccChildEnv,
	buildMcpServers,
};

// --- Provider helpers: tool name mapping ---

// Provider path: the query runs with `tools: []`, so the only tools CC can
// legitimately call are the pi tools we serve over MCP. Any other name is the
// model hallucinating a builtin (`bash`, `Bash`, `Edit`, an MCP server we don't
// serve). CC answers those itself with "No such tool available" and retries
// inside the same query, never dispatching them to our MCP server — so a tool
// call under such a name must not reach pi. Forwarding one ran a tool CC never
// dispatched (real side effects) and, because the retry carries a fresh
// tool_use id, left the handler for the retry with no result to release it:
// pi's result arrived keyed to the dead id, and both sides deadlocked.
// Names match exactly: CC dispatches only the name we serve, so a served name
// in the wrong case is one of these too.
function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
	return customToolNameToPi.get(name);
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	return result;
}

// --- Query state ---
// QueryContext lives in query-state.js so tests can import it without
// activating the extension.

// Global (not query state):
let piUI: ExtensionUIContext | null = null;
let piMode: ExtensionContext["mode"] | null = null;
const activeQueryContexts = new Set<QueryContext>();

// Set at each session_start for a user whose config still enables the removed AskClaude
// tool, so every session shows it once: on its first bridge query, and only to a
// terminal user (`hasUI` is true in RPC mode too — it means dialogs are possible, not
// that a human is watching).
let removedAskClaudeNoticeText: string | undefined;

function showRemovedAskClaudeNoticeOnce(): void {
	if (!removedAskClaudeNoticeText || piMode !== "tui") return;
	piUI?.notify(removedAskClaudeNoticeText, "warning");
	removedAskClaudeNoticeText = undefined;
}

/** Close every query a shutting-down pi session still holds. Scoped to that
 *  session: subagents run in the parent's process and shut down while the
 *  parent's query is still live.
 *
 *  A live query here is expected: a tool that returns `terminate: true` ends pi's
 *  run with Claude Code still parked on its result, and that child would keep the
 *  process alive after pi is done (upstream #210). A context with no query is a
 *  leak that costs something real: it routes a later orphaned tool result into the
 *  delivery path and returns a stream nobody ends — so assert it where the real
 *  sessions are, and let diag/audit-warnings.mjs scan for it. */
function closeSessionQueries(piSessionId: string): void {
	for (const c of [...activeQueryContexts]) {
		if (c.piSessionId !== piSessionId) continue;
		// An abort already killing this CLI ends its own turn and records the abort mark
		// a later resume needs; discarding it here would skip both.
		if (c.aborting) { debug("session_shutdown: leaving an aborting query to its own teardown"); continue; }
		debug(
			`${c.activeQuery ? "session_shutdown: closing parked query" : "WARNING: session_shutdown left a context with no query"} — `
			+ `pendingToolCalls=${c.pendingToolCalls.size} promptStream=${c.promptStream !== null}`,
		);
		discardRewrittenQuery(c);
	}
}

function contextForToolResults(results: McpResult[]): QueryContext | undefined {
	for (const result of results) {
		const id = result.toolCallId;
		if (!id) continue;
		for (const queryCtx of activeQueryContexts) {
			if (queryCtx.pendingToolCalls.has(id) || queryCtx.pendingResults.has(id) || queryCtx.turnToolCallIds.includes(id)) {
				return queryCtx;
			}
		}
	}
	return undefined;
}

// The tool_call hook below gives a Claude model's bash call 120 s when it sets no
// timeout, but pi's schema tells the model there is no default, so a long command
// run without one dies at 120 s (upstream #270). Say what the bridge does in the
// schema Claude Code reads; pi's own tool definition is left alone.
const PI_BASH_NO_DEFAULT = "(optional, no default timeout)";
function withBashTimeoutDefault(tool: Tool): Tool {
	const params = tool.parameters as { properties?: Record<string, Record<string, unknown>> } | undefined;
	const timeout = params?.properties?.timeout;
	if (!timeout) return tool;
	const said = typeof timeout.description === "string" ? timeout.description : "";
	const description = said.includes(PI_BASH_NO_DEFAULT)
		? said.replace(PI_BASH_NO_DEFAULT, "(optional; 120 when omitted)")
		: said ? `${said} (120 when omitted)` : "Timeout in seconds (optional; 120 when omitted)";
	return {
		...tool,
		parameters: { ...params, properties: { ...params!.properties, timeout: { ...timeout, description } } } as Tool["parameters"],
	};
}

function resolveMcpTools(context: Context): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool.name === "bash" ? withBashTimeoutDefault(tool) : tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// A handler waits for the result of a tool call Claude Code dispatched, and results
// come only from pi running the calls it was handed. When a call reaches Claude Code
// but never pi (for example a parallel call dropped after a non-streaming fallback),
// nothing can ever answer it: the handler waits forever and the turn sits on
// "Working" until a person aborts it. Whether pi has the call is checked after the
// timeout, not on arrival, because a handler can legitimately run ahead of the stream
// event that tells the bridge about its call. A call pi did receive is never failed:
// its tool may run for an hour.
function watchForLostToolCall(c: QueryContext, toolCallId: string, pending: PendingToolCall, parkedAt = Date.now()): void {
	pending.watchdog = setTimeout(() => {
		if (c.pendingToolCalls.get(toolCallId) !== pending) return; // answered, released or replaced
		if (c.knowsToolCall(toolCallId)) {
			watchForLostToolCall(c, toolCallId, pending, parkedAt);
			return;
		}
		failLostToolCall(c, toolCallId, pending.toolName, Date.now() - parkedAt);
	}, c.lostCallTimeoutMs);
	pending.watchdog.unref?.();
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers receive their toolCallId from Claude's tools/call _meta, so results
// are matched by ID end to end.
//
// The handler and pi's result can arrive in either order, hence the two maps:
// a result that lands first waits in `pendingResults` for the handler to claim
// it, and a handler that runs first parks its resolver in `pendingToolCalls`.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state while multiple queries run concurrently.
function toMcpToolDefs(tools: Tool[], queryCtx: QueryContext) {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters,
		handler: async (toolCallId: string) => {
			queryCtx.dispatchedToolCalls.add(toolCallId);
			if (queryCtx.pendingResults.has(toolCallId)) {
				const result = queryCtx.pendingResults.get(toolCallId)!;
				queryCtx.pendingResults.delete(toolCallId);
				debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
				return result;
			}
			debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
			return new Promise<McpResult>((resolve) => {
				const pending: PendingToolCall = {
					toolName: tool.name,
					resolve: (result) => {
						clearTimeout(pending.watchdog);
						resolve(result);
					},
				};
				watchForLostToolCall(queryCtx, toolCallId, pending);
				queryCtx.pendingToolCalls.set(toolCallId, pending);
			});
		},
	}));
}

function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, ReturnType<typeof createToolServer>> | undefined {
	if (!tools.length) return undefined;
	return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, toMcpToolDefs(tools, queryCtx)) };
}

// --- Usage helpers ---

// The counter mapping lives in usage.ts; the debug line is this side's job, so every
// call site logs the same way rather than three times over.
function recordUsage(output: AssistantMessage, usage: SdkUsage, model: Model<any>): void {
	const { cachePct, reasoning } = updateUsage(output, usage, model);
	const reasoningText = reasoning == null ? "" : ` reasoning=${reasoning}`;
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`);
}

// Log the *served* context window reported by an SDK result message
// (modelUsage[id].contextWindow), which can differ from the window pi
// registered (model.contextWindow) when the runtime entitlement doesn't
// match the docs — e.g. bare Opus served 200K on Pro, or [1m] not honored.
// The result message's modelUsage is otherwise discarded; this makes the
// gap observable. See issue #18.
function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
	const modelUsage = (message as any).modelUsage as Record<string, { contextWindow?: number; maxOutputTokens?: number }> | undefined;
	if (!modelUsage) return;
	for (const [k, v] of Object.entries(modelUsage)) {
		debug(`${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`);
	}
}

// --- Effort level mapping ---
// Pi reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max",
};

const VALID_EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

// Prefer the model's own thinkingLevelMap (per-model overrides — e.g. a map can
// route xhigh→xhigh where the generic table maps xhigh→max). pi-ai's catalog
// ships a map for most Claude models; the table above covers models without
// one, and the levels a map leaves unnamed. A null entry means the level is
// unsupported on that model: no effort argument is sent, so Claude Code's own
// default applies rather than the generic table's value. Map values are
// provider-generic strings, so a map value is trusted only when it names a
// level CC accepts.
function effortForReasoning(model: Model<any>, reasoning: string | undefined): EffortLevel | undefined {
	if (!reasoning) return undefined;
	const mapped = levelMap(model)?.[reasoning];
	if (mapped === undefined) return REASONING_TO_EFFORT[reasoning];
	return VALID_EFFORTS.has(mapped as EffortLevel) ? mapped as EffortLevel : undefined;
}

// Pi sends no reasoning level when thinking is off, and Claude Code then applies
// its own default (thinking on). Disable thinking the way pi-ai's Anthropic
// provider does: for reasoning models, unless the model's thinkingLevelMap marks
// "off" unsupported (null), as on models that always think.
function thinkingForReasoning(model: Model<any>, reasoning: string | undefined): ThinkingConfig | undefined {
	if (reasoning || !model.reasoning || levelMap(model)?.off === null) return undefined;
	return { type: "disabled" };
}

// pi-ai 1.5 declares Model.thinkingLevelMap through pi-schema's Static, which
// resolves to `unknown` under this tsconfig. Read it with the shape pi-ai's
// ThinkingLevelMapSchema declares (level -> provider string, or null when the
// level is unsupported). Type-only: the value is used as is.
type ThinkingLevelMapShape = Partial<Record<string, string | null>>;
function levelMap(model: Model<any>): ThinkingLevelMapShape | undefined {
	return model.thinkingLevelMap as ThinkingLevelMapShape | undefined;
}

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}


// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. This is safe because step 3 nulls
// currentPiStream, so any leftover messages hit the `!ctx().currentPiStream` guard
// in consumeQuery and are skipped before resetTurnState runs.

const completedStreams = new WeakSet<object>();

function markStreamComplete(stream: AssistantMessageEventStream | null): void {
	if (stream) completedStreams.add(stream as object);
}

function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext, options: SimpleStreamOptions | undefined): void {
	if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
		debug(`WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`);
	}
	c.currentPiStream = stream;
	c.currentOnResponse = options?.onResponse;
}

function ensureTurnStarted(c: QueryContext): void {
	if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
		c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
		c.turnStarted = true;
	}
}

function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage})}`);
	if (!c.turnStarted) ensureTurnStarted(c);
	const stream = c.currentPiStream;
	if (c.turnOutput.stopReason === "error") {
		stream!.push({ type: "error", reason: "error", error: c.turnOutput });
	} else {
		const reason = stopReason === "length" ? "length" : "stop";
		stream!.push({ type: "done", reason, message: c.turnOutput });
	}
	markStreamComplete(stream);
	stream!.end();
	c.currentPiStream = null;
}

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	c: QueryContext,
): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	c.turnSawStreamEvent = true;
	const event = (message as SDKMessage & { event: any }).event;

	if (event?.type === "message_start") {
		// Still open from an earlier message_start: Claude Code gave up on that
		// stream and is retrying it. Its blocks were never completed.
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `restreamed as ${event.message?.id}`);
		c.turnToolCallIds = [];
		c.turnStreamMessageId = event.message?.id;
		c.turnStreamOpen = true;
		c.turnStreamBlockStart = c.turnBlocks.length;
		if (event.message?.usage) recordUsage(c.turnOutput, event.message.usage, model);
		return;
	}

	if (event?.type === "content_block_start") {
		ensureTurnStarted(c);
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use") {
			const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
			if (!piName) {
				debug(`processStreamEvent: skipping tool_use for unserved tool ${event.content_block.name} [${event.content_block.id}] — CC rejects it and retries`);
				return;
			}
			c.turnToolCallIds.push(event.content_block.id);
			c.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: piName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			rememberToolArgs(block); // fork: streaming tool args
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			block.arguments = streamingToolArgs(block); // fork: streaming tool args
			c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) return;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = toolArgsFallback(block); // fork: streaming tool args
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments),
			);
			delete block.partialJson;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
		}
		return;
	}

	if (event?.type === "message_delta") {
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) recordUsage(c.turnOutput, event.usage, model);
		return;
	}

	if (event?.type === "message_stop") {
		dropUnfinishedStreamBlocks(c, `message_stop for ${c.turnStreamMessageId}`);
		c.turnStreamOpen = false;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Tool call complete — end this pi stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		endTurnOnToolUse(c);

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

/** End pi's stream on the tool calls the turn holds, so pi can run them. Whatever
 *  the SDK yields for this turn afterwards finds no stream and is skipped. */
function endTurnOnToolUse(c: QueryContext): void {
	if (!c.currentPiStream || !c.turnOutput) return;
	c.clearToolUseSettle();
	for (const block of c.turnOutput.content) {
		if (block.type !== "toolCall") continue;
		c.deliveredToolCallIds.add(block.id);
		c.deliveredToolCallNames.set(block.id, block.name);
	}
	c.turnOutput.stopReason = "toolUse";
	const stream = c.currentPiStream;
	stream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
	markStreamComplete(stream);
	stream.end();
	c.currentPiStream = null;
}

/** How long a non-streaming fallback's tool-use stop waits for another block. Claude
 *  Code writes all of the message's blocks in one go, so this only has to outlast the
 *  gaps between reads of the SDK's stdout; it is paid once per fallback turn, which a
 *  stalled stream makes rare and slow already. */
const FALLBACK_SETTLE_MS = 100;

/** End the stream on a fallback's tool calls once no further block has followed the
 *  last for FALLBACK_SETTLE_MS.
 *
 *  A non-streaming answer reaches the SDK as one `assistant` message per content
 *  block, all under one message id, and nothing marks the last (every block carries
 *  stop_reason "tool_use"). Ending the stream at the first tool_use lost the rest of
 *  the message, which Claude Code had dispatched and waited on. Waiting for the next
 *  SDK message cannot work: CC sends none until its tool calls are answered, and pi
 *  cannot answer a stream that has not ended. */
function settleFallbackToolUse(c: QueryContext, stream: AssistantMessageEventStream): void {
	c.clearToolUseSettle();
	const seq = c.toolUseSettleSeq;
	const timer = setTimeout(() => {
		// Timers run ahead of the poll phase, so after a stalled event loop this can fire
		// with the next block already read but not yet delivered. Check again once it has been.
		setImmediate(() => {
			// clearToolUseSettle cannot recall this callback once the timer has fired; an
			// error result or abort read in between leaves the wait cleared or replaced.
			if (c.toolUseSettle?.timer !== timer) return;
			if (c.currentPiStream !== stream || c.toolUseSettleSeq !== seq) return;
			debug(`processAssistantMessage: fallback settled on ${c.turnToolCallIds.length} tool call(s)`);
			endTurnOnToolUse(c);
		});
	}, FALLBACK_SETTLE_MS);
	timer.unref?.();
	c.toolUseSettle = { timer, stream };
}

/** End a pending fallback stop now: the SDK moved past the message's blocks, or ended. */
function flushFallbackToolUse(c: QueryContext): void {
	if (c.toolUseSettle?.stream === c.currentPiStream) endTurnOnToolUse(c);
}

/** Remove the blocks of the message that just stopped which never got their own
 *  content_block_stop, because the stream was cut inside them. A tool call left
 *  that way carries whatever JSON survived the cut — `{}` when no delta landed at
 *  all — under an id Claude Code drops from its own conversation before resuming
 *  the turn, so it will never dispatch that id and nothing could answer a result
 *  keyed to it; pi would reject the call, and its result would sit unmatched while
 *  the resumed call waited in a handler. A thinking block left that way has no
 *  signature.
 *
 *  Per block rather than per message: Claude Code keeps the blocks that did
 *  complete, tool calls included, and one it dispatched while pi was never told is
 *  the same deadlock the other way round. Nothing here ends the pi turn — with no
 *  finished tool call left the resume is more of this same turn, and a turn ended
 *  here would leave the real call with no stream to arrive on. */
function dropUnfinishedStreamBlocks(c: QueryContext, why: string): void {
	const dropped: string[] = [];
	for (let i = c.turnBlocks.length - 1; i >= c.turnStreamBlockStart; i--) {
		// `index` is deleted at content_block_stop, so it marks a block that never closed.
		if (c.turnBlocks[i].index === undefined) continue;
		dropped.push(`${c.turnBlocks[i].type}${c.turnBlocks[i].id ? `[${c.turnBlocks[i].id}]` : ""}`);
		c.turnBlocks.splice(i, 1);
	}
	if (!dropped.length) return;
	debug(`dropUnfinishedStreamBlocks: ${why}; dropped ${dropped.reverse().join(",")}`);
	c.turnToolCallIds = c.turnBlocks.filter((b: any) => b.type === "toolCall").map((b: any) => b.id);
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
}

/** Remove the blocks a stream Claude Code abandoned mid-message. Their own
 *  content_block_stop never came, so a thinking block has no signature and a tool
 *  call is one CC will never dispatch; left in, pi would run the tool and the turn
 *  would wait on a handler that never comes, or the next request would replay a
 *  broken block.
 *  The fallback then restarts those indices. pi's normal provider path tolerates that;
 *  pi-agent-core's experimental harness frame encoder keys blocks by contentIndex and
 *  rejects a repeated start, so it would need a change there to drive this provider. */
function dropAbandonedStreamBlocks(c: QueryContext, why: string): void {
	const dropped = c.turnBlocks.splice(c.turnStreamBlockStart);
	debug(`dropAbandonedStreamBlocks: ${why}; dropped ${dropped.length} blocks from ${c.turnStreamMessageId} types=${dropped.map((b: any) => b.type).join(",")}`);
	c.turnToolCallIds = [];
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
	c.turnStreamOpen = false;
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
//
// It is also the content path when a stream stalls: Claude Code drops it and asks
// again without streaming ("Error streaming, falling back to non-streaming mode"),
// and the answer arrives as one assistant message, under a new message id, with no
// stream_events of its own. turnSawStreamEvent is already set by the dead stream,
// so gating on it alone dropped that message: its tool calls never reached pi, CC
// sat in the MCP handler waiting for their results, and the turn hung on "Working"
// until the user aborted it.
function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>, c: QueryContext): void {
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	// Claude Code reports API failures and its own quota/context notices as a
	// `<synthetic>` assistant message: a report, not model output. Streaming its text
	// pins the turn's output before the failure it describes, and a consumer that only
	// fails over before output commits (pi-model-fallback-alias) then cannot reach the
	// next provider. Keep the wording on the failed turn — the error event carries it —
	// but emit no events, so the turn still reads as a call that produced no output.
	// Issue #162.
	if (assistantMsg.model === "<synthetic>") {
		// The report can follow a stalled stream whose non-streaming retry also failed;
		// drop the abandoned partial blocks (unsigned thinking, a tool call CC will never
		// dispatch) the way the fallback path below would.
		if (c.turnSawStreamEvent && c.turnStreamOpen) dropAbandonedStreamBlocks(c, "synthetic failure report");
		debug(`processAssistantMessage: <synthetic> message, keeping ${assistantMsg.content.length} block(s) off the stream`);
		for (const block of assistantMsg.content) {
			if (block.type === "text" && block.text) c.turnBlocks.push({ type: "text", text: block.text });
			else debug("processAssistantMessage: unhandled <synthetic> block type", block.type);
		}
		if (assistantMsg.usage && c.turnOutput) recordUsage(c.turnOutput, assistantMsg.usage, model);
		return;
	}
	if (c.turnSawStreamEvent) {
		// Same id was already delivered; a new id is CC's non-streaming fallback.
		// Drop the stalled stream's partial blocks if it never stopped. Deliberately
		// deliver even if it stopped, at the risk of duplication if CC renumbers it.
		const id = assistantMsg.id;
		if (!id || !c.turnStreamMessageId || id === c.turnStreamMessageId) return;
		if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `non-streaming fallback ${id}`);
	}
	// A fallback arrives as one assistant message per block, all under one id: only the
	// message's first block starts the turn's tool call ids over.
	if (!assistantMsg.id || assistantMsg.id !== c.turnFallbackMessageId) c.turnToolCallIds = [];
	c.turnFallbackMessageId = assistantMsg.id;
	c.toolUseSettleSeq++;
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			ensureTurnStarted(c);
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
		} else if (block.type === "tool_use") {
			const piName = piToolNameFor(block.name, customToolNameToPi);
			if (!piName) {
				debug(`processAssistantMessage: skipping tool_use for unserved tool ${block.name} [${block.id}] — CC rejects it and retries`);
				continue;
			}
			ensureTurnStarted(c);
			c.turnSawToolCall = true;
			c.turnToolCallIds.push(block.id);
			c.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: piName,
				arguments: mapToolArgs(piName, block.input),
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage && c.turnOutput) recordUsage(c.turnOutput, assistantMsg.usage, model);

	// End the stream on tool_use, same as processStreamEvent's message_stop handler —
	// once the message's other blocks are in, which only a pause can tell.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) settleFallbackToolUse(c, c.currentPiStream);
}

/** Errors of queries that ended on a tool call Claude Code rejected while pi was
 *  running it, by pi session. That session's next provider call takes its entry. */
const rejectedToolCalls = new Map<string | null, { toolCallId: string; error: string }>();

/** Claude Code's own tool_result for a call pi got that never reached our MCP
 *  handler: CC rejected it (a permission rule, a hook, input that is not JSON).
 *  Never matches an unserved tool name (pi never gets that id) or what CC writes
 *  for a dispatched call on interrupt. */
function toolCallRejection(message: SDKMessage, c: QueryContext): { toolCallId: string; describe: (when: string) => string } | undefined {
	if (message.type !== "user" || message.parent_tool_use_id !== null || !Array.isArray(message.message.content)) return undefined;
	const block = message.message.content.find((b) => b.type === "tool_result" && c.turnToolCallIds.includes(b.tool_use_id) && !c.dispatchedToolCalls.has(b.tool_use_id));
	if (block?.type !== "tool_result") return undefined;
	const id = block.tool_use_id;
	const inTurn = c.turnOutput?.content.find((b) => b.type === "toolCall" && b.id === id);
	const name = (inTurn?.type === "toolCall" ? inTurn.name : undefined) ?? c.deliveredToolCallNames.get(id) ?? id;
	const reason = typeof block.content === "string" ? block.content : (block.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
	return { toolCallId: id, describe: (when) => `Claude Code rejected pi's tool call "${name}" ${when}. Claude Code said: ${JSON.stringify(reason.trim())}` };
}

/** Take a call Claude Code rejected before pi was handed it out of the turn, and let
 *  the query go on: CC answers the call with its own rejection and asks the model
 *  again, as it does for a call Claude Code makes natively, so the model's retry
 *  streams into this same pi turn. Nothing reached pi or the MCP handler, so nothing
 *  ran. False when the call is not in the open stream (pi has it, or ran it).
 *
 *  The turn's message is replaced, not edited in place: the events already pushed
 *  carry the old one as `partial`, and a consumer that reads its queue late (pi's JSON
 *  mode) resolves each toolcall_start against it, so its indices must not move. */
function dropRejectedToolCall(c: QueryContext, rejection: { toolCallId: string; describe: (when: string) => string }): boolean {
	if (!c.currentPiStream || !c.turnOutput) return false;
	const index = c.turnBlocks.findIndex((b: any) => b.type === "toolCall" && b.id === rejection.toolCallId);
	if (index < 0) return false;
	debug(`consumeQuery: ${rejection.describe("before pi got it")}; dropped it, Claude Code asks the model again`);
	c.turnOutput = { ...c.turnOutput, content: c.turnBlocks.filter((_: unknown, i: number) => i !== index) };
	if (index < c.turnStreamBlockStart) c.turnStreamBlockStart--;
	c.turnToolCallIds = c.turnToolCallIds.filter((id) => id !== rejection.toolCallId);
	c.turnSawToolCall = c.turnBlocks.some((b: any) => b.type === "toolCall");
	// A fallback's pending stop would end the turn on no tool calls at all.
	if (!c.turnSawToolCall) c.clearToolUseSettle();
	return true;
}

/** End a query whose tool call Claude Code rejected itself. Nothing will ever answer
 *  the call pi was handed, and CC goes on to retry a tool pi may already be running,
 *  so the query goes the way failLostToolCall's does: discarded, its parked handlers
 *  settled, its CLI killed and the session's mirror marked for rebuild — pi's history,
 *  which holds pi's result rather than CC's rejection, is what the next turn imports.
 *  A stream pi is waiting on fails with the reason; when pi is still running the call,
 *  its next provider call carrying that result fails instead (rejectedToolCalls). */
function failRejectedToolCall(c: QueryContext, rejection: { toolCallId: string; describe: (when: string) => string }): void {
	const running = !c.currentPiStream;
	debug(`consumeQuery: Claude Code rejected tool call [${rejection.toolCallId}] ${running ? "while pi runs it" : "after pi ran it"}, ending the query`);
	const error = rejection.describe(running ? "after pi had started running it" : "after pi ran it");
	if (running) rejectedToolCalls.set(c.piSessionId, { toolCallId: rejection.toolCallId, error });
	c.clearToolUseSettle();
	discardQuery(c, `Claude Code rejected tool call ${rejection.toolCallId}; the turn was ended.`);
	if (c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "error";
		c.turnOutput.errorMessage = error;
		finalizeCurrentStream(c);
	}
}

/** Whether `message` shows Claude Code working on the turn: model output, the turn's
 *  end, an API retry, or a request or compaction under way (status "requesting",
 *  which CC 2.1.327 emits right before the API call of the turn it resumes, so a slow
 *  first response is not taken for a silent CC), or the session running. Init, hooks
 *  and an idle state come before CC has decided whether there is a turn to run at all. */
function showsTurnWork(message: SDKMessage): boolean {
	if (message.type === "stream_event" || message.type === "assistant" || message.type === "result") return true;
	if (message.type !== "system") return false;
	const m = message as { subtype?: string; status?: unknown; state?: unknown };
	return m.subtype === "api_retry"
		|| (m.subtype === "status" && (m.status === "requesting" || m.status === "compacting"))
		|| (m.subtype === "session_state_changed" && m.state === "running");
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result. */
async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	wasAborted: () => boolean,
	queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string; failure?: Error }> {
	let capturedSessionId: string | undefined;
	let failure: Error | undefined;

	for await (const message of sdkQuery) {
		// CLAUDE_BRIDGE_RECORD_STREAM=<path> appends every SDK message consumeQuery
		// sees, one JSON object per line. Used by tests/lib/record-sdk-streams.mjs to
		// capture replay fixtures, so unit tests assert against message shapes Claude
		// Code really emitted rather than ones we imagined.
		const recordStreamPath = process.env.CLAUDE_BRIDGE_RECORD_STREAM;
		if (recordStreamPath) appendFileSync(recordStreamPath, `${JSON.stringify(message)}\n`);
		if (wasAborted()) break;
		// The model serving this query: a switch at a tool result changes it mid-query (upstream #273).
		const served = queryCtx.servedModel ?? model;
		// A continuation's fallback waits for this (upstream #274). Only this context's live
		// query marks it: a discarded one still flushing must not disarm its replacement's.
		if (!queryCtx.sawTurnWork && queryCtx.activeQuery === sdkQuery && showsTurnWork(message)) {
			queryCtx.sawTurnWork = true;
			queryCtx.clearContinuationFallback();
		}
		// Checked before the stream guard: pi may be running the rejected call, with
		// no stream open. The discarded query's completion leaves everything alone.
		const rejection = toolCallRejection(message, queryCtx);
		if (rejection) {
			if (dropRejectedToolCall(queryCtx, rejection)) continue;
			failRejectedToolCall(queryCtx, rejection);
			return { capturedSessionId };
		}
		await reportHeldRateLimit(queryCtx, served);
		// Everything below the currentPiStream guard is content, which there is
		// nowhere to put once a turn has ended on a tool call. Handle lifecycle
		// messages before that gate:
		//
		// - replay acknowledgements: clear a queued steer even after its pi turn
		//   stream has ended.
		// - stdin: nothing else closes the CLI's stdin now that the prompt is a
		//   streamed generator (isSingleUserTurn=false), so missing this hangs the query.
		// - the failure a `result` carries: it is the only record that the turn
		//   failed at all. Behind the guard, a 429 arriving at a tool boundary
		//   logged nothing. It fails turnOutput only while the turn's stream is
		//   open; once ended, turnOutput is the message pi already recorded.
		// - rate-limit events: notifications to the user, which are most likely to
		//   fire during exactly the long tool-using turns the guard was skipping.
		if (message.type === "user" && message.parent_tool_use_id === null && "isReplay" in message && message.isReplay === true) {
			// For fresh steer UUIDs, replay marks incorporation into the turn, not
			// completion. Its MCP calls still need stdin until the following result.
			queryCtx.pendingSteerUuids.delete(message.uuid);
		}
		let resultError: string | undefined;
		if (message.type === "result") {
			logServedContextWindow("result", message, served);
			resultError = resultErrorText(message);
			// A result ends a turn, not necessarily the query: steers not yet replayed
			// can still start a later turn.
			if (resultError !== undefined || queryCtx.pendingSteerUuids.size === 0) queryCtx.promptStream?.end();
			if (resultError !== undefined) {
				// Consume the rejection alongside the failure it caused, so a later
				// unrelated failure on this query doesn't inherit the label.
				if (queryCtx.rateLimitRejection) {
					resultError = describeRateLimitFailure(queryCtx.rateLimitRejection, resultError);
					queryCtx.rateLimitRejection = null;
				} else if (resultError.includes("out of extra usage") && !extraUsageByChoice(served, longContextSettings)) {
					// Extra Usage off or empty, and no plan window was rejected first.
					resultError += ` (${THIRD_PARTY_SUSPECT})`;
				}
				debug(`consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`);
				if (queryCtx.turnOutput && queryCtx.currentPiStream) {
					queryCtx.turnOutput.stopReason = "error";
					queryCtx.turnOutput.errorMessage = resultError;
				}
				// The failure ends the query. Closing stdin does not: Claude Code still
				// runs a steer it had queued, and that turn's stop reason would overwrite
				// this one. The caller tears the query down as a failed one.
				failure = new ErrorResultFailure(resultError, capturedSessionId); // fork: error resume
				break;
			}
		}
		if (message.type === "rate_limit_event") {
			const info = (message as any).rate_limit_info;
			debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
			if (info) queryCtx.heldRateLimit = info;
			await reportHeldRateLimit(queryCtx, served);
			// CC sets isUsingOverage only when a rejected plan window is served from Extra
			// Usage; overageInUse alone means the request was billed there anyway.
			if (info?.overageInUse === true && info.status !== "rejected" && info.isUsingOverage !== true
				&& !extraUsageByChoice(served, longContextSettings) && !queryCtx.warnedUnplannedOverage) {
				queryCtx.warnedUnplannedOverage = true;
				piUI?.notify(`Claude Code request billed to Extra Usage: ${THIRD_PARTY_SUSPECT}, or this model needs usage credits on your plan`, "warning");
			}
			if (info?.status === "rejected") {
				// Held so the failure Claude Code sends next can be named as a rate limit.
				queryCtx.rateLimitRejection = info;
				// The "rate limit reached" notice below supersedes warnings; re-arm so the next
				// window's warnings fire even if it opens straight into allowed_warning.
				queryCtx.lastRateLimitWarnStep = null;
				queryCtx.lastRateLimitWarnThreshold = undefined;
				// resetsAt is Unix seconds, not milliseconds.
				const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "unknown";
				piUI?.notify(`Claude subscription rate limit reached (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, "warning");
			} else if (info?.status === "allowed") {
				// Back under the threshold (window reset) — re-arm the warning dedupe.
				queryCtx.lastRateLimitWarnStep = null;
				queryCtx.lastRateLimitWarnThreshold = undefined;
			} else if (info?.status === "allowed_warning") {
				// utilization is a fraction (0..1); allowed_warning fires once it crosses surpassedThreshold.
				const percent = Math.round((info.utilization ?? 0) * 100);
				// The SDK emits one event per request, so only re-notify when the level
				// rises past a new 5% step or the threshold changes.
				const step = Math.floor(percent / 5);
				const rose = queryCtx.lastRateLimitWarnStep === null || step > queryCtx.lastRateLimitWarnStep;
				if (rose || info.surpassedThreshold !== queryCtx.lastRateLimitWarnThreshold) {
					queryCtx.lastRateLimitWarnStep = step;
					queryCtx.lastRateLimitWarnThreshold = info.surpassedThreshold;
					piUI?.notify(`Claude rate limit warning: ${percent}% used (${info.rateLimitType ?? ""})`, "warning");
				}
			}
			continue;
		}
		if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

		// A fallback's blocks come back to back, so any of these means the SDK is past them.
		if (message.type === "stream_event" || message.type === "user" || message.type === "result") flushFallbackToolUse(queryCtx);

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, served, queryCtx);
				break;
			case "assistant":
				processAssistantMessage(message, served, customToolNameToPi, queryCtx);
				break;
			case "result": {
					// The failure itself was recorded above the guard, along with the served
					// context window. What is left here is the success path: push the result
					// text when no assistant message already delivered it. A text block already in
					// the turn is that delivery: an answer that came only as an assistant message
					// (a fallback before any stream event) sees no stream event either.
					const textDelivered = queryCtx.turnBlocks.some((b: any) => b.type === "text");
					if (resultError === undefined && !queryCtx.turnSawStreamEvent && !textDelivered && message.subtype === "success") {
					ensureTurnStarted(queryCtx);
					const text = message.result || "";
					queryCtx.turnBlocks.push({ type: "text", text });
					const idx = queryCtx.turnBlocks.length - 1;
					queryCtx.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: queryCtx.turnOutput });
					queryCtx.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: queryCtx.turnOutput });
				}
				break;
			}
			case "system":
				if ((message as any).subtype === "init" && (message as any).session_id) {
					capturedSessionId = (message as any).session_id;
				}
				break;
			case "user":
				// Prompt/tool-result echoes have no content events to emit. With
				// replay-user-messages, queued steers also arrive as user replays;
				// their lifecycle acknowledgement is handled above the stream guard.
				break;
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	// The query ended behind a fallback's last block: nothing more is coming to wait for.
	// An abort or a failure is not that — the caller ends the stream as aborted or
	// failed, and the calls Claude Code dispatched will never be answered, so only
	// drop the wait.
	if (wasAborted() || failure) queryCtx.clearToolUseSettle();
	else flushFallbackToolUse(queryCtx);

	// DEBUG: trace when consumeQuery exits
	debug(`consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);

	return { capturedSessionId, failure };
}

/** The trailing user turn as content blocks, or null if there isn't one.
 *  Blocks rather than text so image steers keep their images. */
function steerBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
	const blocks = extractUserPromptBlocks(messages);
	if (blocks) return blocks;
	const text = extractUserPrompt(messages);
	return text ? [{ type: "text", text }] : null;
}

/** A steer that never made it into CC's session. The cursor has already counted
 *  it, so count-based sync would skip it forever — rebuild instead, which
 *  re-imports the message from pi's context. */
function steerMissedSession(c: QueryContext, text: string): void {
	c.missedSteer = true;
	const state = sessionStateFor(c.piSessionId);
	if (state) setSessionStateFor(c.piSessionId, { ...state, needsRebuild: true });
	debug(`provider: steer never reached CC, marked query for rebuild: ${text.slice(0, 60)}`);
}

/** Releases this turn's tool results to their MCP handlers, after first pushing
 *  any steer to CC.
 *
 *  The ordering is mandatory, not an optimization. The steer and the MCP tool
 *  result travel back to CC over the same stdin FIFO. Awaiting the push ack
 *  (which resolves only once the SDK's write to stdin completed) before
 *  resolving any handler guarantees CC enqueues the steer *before* it reads the
 *  tool result, so its post-tool-call drain sees it and acts on it this turn.
 *  Resolve first and the steer misses the drain, silently degrading to
 *  follow-up semantics.
 *
 *  Both the post-tool-call drain and the FIFO ordering are CC CLI internals,
 *  not SDK contract — tests/int-tool-message.mjs is the tripwire if they move. */
/** How long tool results wait for a model switch: setModel makes a validation request
 *  to the API, and a result held back on it holds the turn. */
const SWITCH_MODEL_WAIT_MS = 15_000;
let switchModelWaitMs = SWITCH_MODEL_WAIT_MS;

/** Switch a query parked at a tool boundary to `model` before its results go in.
 *  Never rejects: a refused switch leaves the query on the model serving it. A switch
 *  that outlasts the wait lets the results go; if it lands later, the model it set
 *  serves from then on and labels the turn. */
async function switchRunningModel(c: QueryContext, model: Model<any>, waitMs = switchModelWaitMs): Promise<void> {
	const served = c.servedModel;
	const cliModel = claudeCodeModelId(model, longContextSettings);
	const q = c.activeQuery as { setModel?: (m?: string) => Promise<void> } | null;
	const switched = (async () => {
		try {
			if (!q?.setModel) throw new Error("the query cannot switch models");
			await q.setModel(cliModel);
		} catch (error) {
			debug(`provider: ${model.id} requested at a tool result, switch refused, query continues on ${served?.id ?? "?"} until the next prompt:`, error);
			return;
		}
		// A query that ended or was replaced meanwhile serves nothing more.
		if (c.activeQuery !== q) return;
		debug(`provider: switched the running query from ${served?.id ?? "?"} to ${cliModel} at a tool result`);
		c.servedModel = model;
		if (c.turnOutput) Object.assign(c.turnOutput, { api: model.api, provider: model.provider, model: model.id });
	})();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const waited = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), waitMs); timer.unref?.(); });
	if (await Promise.race([switched, waited]) === "timeout") {
		debug(`provider: switch to ${cliModel} still pending after ${waitMs} ms, delivering the tool results`);
	}
	clearTimeout(timer);
}

async function deliverToolResults(
	c: QueryContext,
	results: McpResult[],
	steer: ContentBlockParam[] | null,
	contextLength: number,
): Promise<void> {
	if (steer) {
		const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
		if (!c.promptStream) {
			debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
			steerMissedSession(c, text);
		} else {
			const uuid = randomUUID();
			// Register before awaiting stdin: a result can arrive during the write.
			c.pendingSteerUuids.add(uuid);
			try {
				await c.promptStream.push({ ...userMessage(steer, "next"), uuid });
				debug(`provider: steer written to CC stdin before tool result: ${text.slice(0, 60)}`);
			} catch (error) {
				// The query is ending — pushing further input would wedge tool-result
				// delivery, so the steer doesn't reach this query. It is still in
				// pi's context, and the caller has already advanced the session
				// cursor past it, so force a rebuild or CC would never see it.
				c.pendingSteerUuids.delete(uuid);
				debug(`provider: steer push rejected, delivering tool result anyway:`, error);
				steerMissedSession(c, text);
			}
		}
	}

	debug(`provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers, ctx.msgs=${contextLength}`);
	for (const result of results) {
		const id = result.toolCallId;
		if (id && c.pendingToolCalls.has(id)) {
			const pending = c.pendingToolCalls.get(id)!;
			c.pendingToolCalls.delete(id);
			debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
			pending.resolve(result);
		} else if (id) {
			c.pendingResults.set(id, result);
			debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
		} else {
			debug(`WARNING: tool result without toolCallId, cannot match`);
		}
		if (c.pendingToolCalls.size > 0 && c.pendingResults.size > 0) {
			debug(`BUG: both maps non-empty! handlers=${c.pendingToolCalls.size} results=${c.pendingResults.size}`);
		}
	}
	if (c.pendingToolCalls.size > 0) {
		debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`);
		piUI?.notify(`Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`, "warning");
	}
}

/** fork: reopen resume. A pi session with no mirror in this process (a new window,
 *  `pi --continue`, `/resume`) takes back the CC session its last completed turn
 *  recorded, when pi's history still matches it; see src/fork.ts loadMirror. A turn
 *  aborted before a /reload brings its abort mark, so postAbortSync decides the resume
 *  as it would have in the module that aborted it, rotating if it rebuilds. */
function restoreMirror(piSessionId: string, history: Context["messages"], cwd: string): void {
	const restored = loadMirror(piSessionId, history, cwd);
	if (!restored) return;
	setSessionStateFor(piSessionId, { sessionId: restored.sessionId, cursor: restored.cursor, cwd, piSessionId, promptDigest: restored.promptDigest, ...(restored.abort ? { ...restored.abort, forceRotate: true } : {}) });
	debug(`reopen: restored session ${restored.sessionId.slice(0, 8)} for pi session ${piSessionId.slice(0, 8)}, cursor=${restored.cursor}${restored.abort ? ", aborted turn" : ""}`);
}

/** fork: reopen resume. The newest context a query was sent: the one carrying the
 *  tool results delivered to it, which its completion's cursor counts. */
const latestSent = new WeakMap<QueryContext, Context["messages"]>();

/** fork: reopen resume. Records a completed turn's CC session for a later process,
 *  fingerprinting every message the cursor covers; a mirror due for a rebuild, or
 *  one whose covered messages this query never saw, is forgotten instead. An aborted
 *  query records its abort mark with it. */
function recordMirror(c: QueryContext, sent: Context["messages"], cwd: string, abort?: AbortMark): void {
	if (!c.piSessionId) return;
	const state = sessionStateFor(c.piSessionId);
	const latest = latestSent.get(c);
	const history = nonSystemMessages(latest && latest.length > sent.length ? latest : sent);
	if (!state || state.needsRebuild || state.cursor !== history.length) return dropMirror(c.piSessionId);
	saveMirror(c.piSessionId, { sessionId: state.sessionId, cursor: state.cursor, cwd, promptDigest: state.promptDigest, fingerprint: historyFingerprint(history), fingerprintLength: history.length, ...(abort ? mirrorAbortFields(abort) : {}) });
}

/** fork: abort resume. Records an aborted query on its own session's mirror, after
 *  upstream's needsRebuild + forceRotate marking: the next sync resumes CC's own file
 *  once src/fork.ts postAbortSync allows it, and rebuilds on a rotated id otherwise.
 *  `prior` is the mirror before the abort, so a rewrite or missed steer still rebuilds.
 *  The mark goes on the mirror file too, with the aborted CLI's pid, so the same
 *  decision survives a /reload or a new process. An ephemeral (preserve-shared) query
 *  keeps upstream's marking of its parent. fork: error resume: a query that ended at an
 *  error result is recorded the same way, with `errorResult` set. */
function markAbortedSession(c: QueryContext, prior: SessionState | null, capturedSessionId: string | undefined, cursor: number, cwd: string, preserveShared: boolean, turn: AbortedTurn, sent: Context["messages"], errorResult = false): void {
	const sessionId = capturedSessionId ?? prior?.sessionId;
	if (preserveShared || !sessionId) {
		if (c.piSessionId) dropMirror(c.piSessionId);
		return;
	}
	const mark = { ...abortMark(turn, sessionId), errorResult: errorResult || undefined };
	setSessionStateFor(c.piSessionId, {
		...prior,
		sessionId,
		cursor: Math.max(cursor, prior?.cursor ?? 0),
		cwd,
		piSessionId: c.piSessionId ?? undefined,
		needsRebuild: c.missedSteer || prior?.needsRebuild,
		forceRotate: true,
		promptDigest: c.promptDigest ?? prior?.promptDigest,
		...mark,
	});
	recordMirror(c, sent, cwd, mark);
	debug(`provider: ${errorResult ? "error result" : "abort"} recorded, session ${sessionId.slice(0, 8)} resumes once settled`);
}

/** fork: abort resume. REUSE across an aborted turn, clearing the abort mark, on disk
 *  too: this turn's completion records the mirror again. */
function resumeAfterAbort(piSessionId: string | null, state: SessionState, cursor: number, cwd: string): SyncResult {
	if (piSessionId) dropMirror(piSessionId);
	setSessionStateFor(piSessionId, { ...state, cursor, cwd, abortedAt: undefined, abortedPrompt: undefined, abortedFileOffset: undefined, abortedProcess: undefined, errorResult: undefined, forceRotate: undefined });
	debug(`Case 3 post-abort: resuming session ${state.sessionId.slice(0, 8)} across the aborted turn, cursor=${cursor}`);
	debug(`syncResult: path=reuse sessionId=${state.sessionId} cursor=${cursor} post-abort`);
	return { sessionId: state.sessionId };
}

/** Abort teardown for one query: settle everything that would otherwise be left
 *  awaiting a subprocess we are about to kill. The pump abandons iteration on
 *  abort, so an in-flight prompt-stream push would hang forever and take
 *  tool-result delivery with it. */
function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
	promptStream.fail(new Error("Operation aborted"));
	c.releasePendingToolCalls("Operation aborted");
}

/** Queries pi's history moved out from under. Their completion must not touch
 *  `sharedSession` or the pi stream: the query that took over the turn has
 *  already rebuilt both from the new history, and this one's session id names the
 *  conversation pi just discarded. */
const abandonedQueries = new WeakSet<object>();

/** The prompt a continuation query is opened with: the pi turn goes on, but its
 *  last message is a tool result rather than a prompt, and query() cannot resume
 *  a session without one. */
const CONTINUE_AFTER_REWRITE_PROMPT =
	"[Your context was compacted. What precedes this is a summary plus the most recent messages, "
	+ "ending with the tool result you were waiting for. Continue the task from there.]";

/** The prompt a resumed tool result is opened with: no query of this process
 *  was parked on it (a restart, a crash, a stall), so the turn goes on from
 *  history that ends at the result. */
const CONTINUE_AFTER_RESUME_PROMPT =
	"[Your session was interrupted and resumed. What precedes this ends with the tool result "
	+ "you were waiting for. Continue the task from there.]";

/** Drop a Claude Code query parked at a tool boundary whose conversation pi has
 *  since rewritten (/compact, tree navigation).
 *
 *  Delivering the turn's tool result into that query hands Claude Code the
 *  context pi just shrank: one pi turn is one CC query, and the query keeps its
 *  own context inside the CLI whatever pi does to its transcript. It answers off
 *  the pre-compaction conversation, reports the pre-compaction usage back, and pi
 *  crosses the same threshold at the next boundary — measured as one compaction
 *  per tool call with usage never dropping (issue #101). `needsRebuild` does not
 *  prevent it: only syncSharedSession reads that flag, and tool-result delivery
 *  is the one call that never syncs.
 *
 *  The caller then takes the fresh-query path, where REBUILD imports pi's
 *  rewritten history — this tool result included, since it is already in that
 *  history — so the turn continues instead of ending here. Nothing is lost by
 *  killing the subprocess: pi owns the only copy of the conversation that counts. */
function discardRewrittenQuery(c: QueryContext): void {
	discardQuery(c, "Context was compacted; this query was discarded.");
	if (c.piSessionId) historyRewrittenBySession.delete(c.piSessionId);
	debug("provider: history rewritten under a parked query — discarded it, rebuilding from current history");
}

/** Kill a query whose conversation can no longer be continued in place, settling its
 *  parked handlers with `reason`. What follows rebuilds from pi's history, so the
 *  session's mirror is marked for it. */
function discardQuery(c: QueryContext, reason: string): void {
	const discarded = c.activeQuery as { interrupt?: () => Promise<unknown>; close?: () => void } | null;
	if (discarded) abandonedQueries.add(discarded);
	c.activeQuery = null;
	// Leaving the routing set is what stops this result coming straight back here:
	// contextForToolResults only matches ids against contexts still in it.
	activeQueryContexts.delete(c);
	c.turnToolCallIds = [];
	c.clearContinuationFallback();
	c.promptStream?.fail(new Error("query discarded"));
	c.promptStream = null;
	// Settle the parked handlers before killing the CLI, for drainForAbort's
	// reason: one left awaiting a dead subprocess never settles.
	c.releasePendingToolCalls(reason);
	void discarded?.interrupt?.().catch(() => {});
	try { discarded?.close?.(); } catch {}
	// The CLI we just killed may still flush a record into the session JSONL, and
	// the rebuild is the next thing that happens — so rotate rather than race it,
	// exactly as after an abort. Only this session's mirror: the discarding query
	// proves its own conversation is the one being rebuilt around.
	const state = sessionStateFor(c.piSessionId);
	if (state) setSessionStateFor(c.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
}

/** End a turn whose handler waits on a tool call pi never received (watchForLostToolCall).
 *  Waiting longer cannot help: pi runs only the calls it was handed, so no result for
 *  this one will ever be delivered. The query goes the way an aborted one does, and a
 *  stream pi is waiting on fails with the reason. When pi is still running the calls it
 *  did get, there is no stream yet; its results then find no parked query and resume
 *  the turn from pi's history, which never held the lost call. */
function failLostToolCall(c: QueryContext, toolCallId: string, toolName: string, waitedMs: number): void {
	const waitedSeconds = Math.round(waitedMs / 1000);
	const message = `Claude Code called ${toolName} [${toolCallId}], a tool call pi never received, and waited ${waitedSeconds}s for a result that cannot arrive. `
		+ `The turn was ended instead of waiting; send a message to continue.`;
	debug(`WARNING: ${message}`);
	diagDump("lost_tool_call", {
		toolName, toolCallId, waitedSeconds,
		turnToolCallIds: c.turnToolCallIds,
		deliveredToolCallIds: [...c.deliveredToolCallIds],
		pendingToolCallIds: [...c.pendingToolCalls.keys()],
		turnBlockTypes: c.turnOutput?.content.map((b: any) => b.type) ?? null,
		streamOpen: Boolean(c.currentPiStream),
	});
	discardQuery(c, `The bridge never received tool call ${toolCallId} from Claude Code's message; the turn was ended.`);
	if (c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "error";
		c.turnOutput.errorMessage = message;
		finalizeCurrentStream(c);
	}
	piUI?.notify(`Claude bridge: ${message}`, "error");
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const afterAbort = deferUntilAbortSettles(streamClaudeAgentSdk, sessionStateFor(options?.sessionId) ?? persistedAbortMark(options?.sessionId), model, context, options); if (afterAbort) return afterAbort; // fork: abort resume
	const forkStart = startFromParentFork(streamClaudeAgentSdk, sessionStateFor(options?.sessionId), (s) => setSessionStateFor(options?.sessionId, { ...s, piSessionId: options?.sessionId }), debug, model, context, options, () => promptDigestFor(toBridgeContext(context).systemPrompt || undefined)); if (forkStart) return forkStart; // fork: fork cache
	showRemovedAskClaudeNoticeOnce();
	// pi hands providers a transcript (prompt/tools folded into system messages) — fold it
	// back out to the prompt/tools fields every cursor write and syncSharedSession call
	// below assumes (issue #106).
	context = toBridgeContext(context);

	// Pi's compaction, branch-summary and bug-report calls use cacheRetention:"none"
	// in completeSummarization. Their prompts are one-off, so route them to an isolated
	// persistSession:false CC process without session sync.
	if (options?.cacheRetention === "none") {
		debug(`provider: one-off summarizer call (cacheRetention none) routed to isolated summary, msgs=${context.messages.length}`);
		return isolatedStreamFn(model, context, options);
	}

	const stream = createAssistantMessageEventStream();

	// DEBUG: trace followUp message triggering
	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`);

	// The result of a call Claude Code rejected while pi ran it ends the turn with
	// that error. Taken on every call, so it never outlives this one.
	const rejected = rejectedToolCalls.get(options?.sessionId ?? null);
	rejectedToolCalls.delete(options?.sessionId ?? null);
	if (rejected && extractAllToolResults(context).some((r) => r.toolCallId === rejected.toolCallId)) {
		debug(`provider: tool result for [${rejected.toolCallId}], which Claude Code rejected, ends the turn`);
		const output = newAssistantOutput(model, "", "error", rejected.error);
		queueMicrotask(() => {
			stream.push({ type: "error", reason: "error", error: output });
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}

	let activeQuery = ctx().activeQuery !== null;
	const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
	let resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;

	// pi rewrote its history while this query sat parked at a tool boundary, so the
	// query answers about a conversation that no longer exists. Discard it and let
	// this tool result carry the turn into a fresh query over the rewritten history.
	// The staleness mark is per pi session: a subagent's compaction (its own
	// AgentSession, sharing this process) must not discard the parent's parked
	// query, and vice versa.
	const rewrittenUnderQuery = Boolean(resultCtx?.historyStale);
	if (resultCtx && rewrittenUnderQuery) {
		discardRewrittenQuery(resultCtx);
		resultCtx = undefined;
		// Recomputed, not cleared: a reentrant subagent may still hold a query of its own.
		activeQuery = ctx().activeQuery !== null;
	}

	const isReentrantUserQuery = activeQuery && lastMsgRole === "user" && allResults.length === 0;
	if (isReentrantUserQuery) {
		debug(`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`);
	}

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (resultCtx) {
		claimCurrentPiStream(stream, "tool-result", resultCtx, options);
		// pi switched models between a tool call and its result (`/model` while a tool
		// runs, or a router): switch the running query before the result reaches it,
		// since CC applies setModel to the same turn's next request (upstream #273,
		// pinned in tests/int-cc-contracts.mjs). The turn is labeled with the serving
		// model until the switch succeeds; a refused switch keeps it, and the next
		// prompt opens a fresh query on the requested model.
		const served = resultCtx.servedModel ?? model;
		const switchTo = claudeCodeModelId(served, longContextSettings) !== claudeCodeModelId(model, longContextSettings) ? model : null;
		resultCtx.resetTurnState(served);
		resultCtx.bindRunSignal?.(options?.signal, stream);
		// A rewrite that armed the mark after this query parked gets copied here,
		// though markRebuildForSession usually reaches it directly.
		if (!resultCtx.historyStale && resultCtx.piSessionId && historyRewrittenBySession.has(resultCtx.piSessionId)) {
			resultCtx.historyStale = true;
		}
		// User messages (steer/followUp) pi injected into context during the
		// active query: a steer sent while a tool was executing, drained by pi at
		// the turn boundary and appended alongside the tool result.
		const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
		// Delivery is async because the steer must reach CC's stdin *before* the
		// tool result does — see deliverToolResults. Detached so the provider
		// still returns its stream synchronously.
		const deliverTo = resultCtx;
		const delivering = switchTo ? switchRunningModel(deliverTo, switchTo) : Promise.resolve();
		void delivering.then(() => deliverToolResults(deliverTo, allResults, steer, context.messages.length));
		// The shared cursor tracks the top-level conversation. A reentrant subagent
		// delivering its own results would drag it to that subagent's message count
		// — observed pulling a parent from 5 back to 3, which cost the parent's next
		// turn a full rebuild and a flushed prompt cache.
		const state = sessionStateFor(resultCtx.piSessionId);
		if (state) state.cursor = context.messages.length;
		resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
		latestSent.set(resultCtx, context.messages); // fork: reopen resume
		return stream;
	}

	// --- Orphaned tool result (e.g. user aborted a tool call) ---
	// The query is gone but pi still delivered the result. Nothing to do — just
	// emit end_turn so pi waits for the next real user message. The discard
	// branch above already siphoned off the stale-query case, which goes on to a
	// rebuild instead — that one has somewhere to deliver the result to.
	// Only when this call's own signal is aborted: after an abort during a tool
	// call, pi calls back with the run's (already aborted) signal. A result that
	// arrives otherwise -- after a restart (a durable host resuming a run), a
	// crash, a stall, or an overflow/quota retry -- has no parked query either, and
	// falls through to the fresh-query path, which resumes the CC session and
	// delivers it.
	const lastMsg = context.messages[context.messages.length - 1];
	const unparkedToolResult = lastMsg?.role === "toolResult" && !rewrittenUnderQuery;
	if (unparkedToolResult && options?.signal?.aborted) {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		// With no query in flight anywhere, the top-level session this result
		// belongs to is the one whose turn just ended: its cursor advances to
		// count the result (options.sessionId is that session — pi emits the
		// result event through the same session's streamSimple call).
		const orphanState = sessionStateFor(options?.sessionId ?? null);
		if (orphanState && activeQueryContexts.size === 0) orphanState.cursor = context.messages.length;
		// No query owns this result, so there is no context to reset: resetTurnState
		// on the top-level ctx() would replace a live parent's turnOutput mid-stream,
		// stranding the blocks it had already emitted. A throwaway context just
		// supplies the empty message this turn ends with.
		const c = new QueryContext();
		c.resetTurnState(model);
		queueMicrotask(() => {
			stream.push({ type: "done", reason: "stop", message: c.turnOutput });
			markStreamComplete(stream);
			stream.end();
		});
		return stream;
	}

	// --- Fresh query ---

	// 1. Determine reentrancy. Reentrant queries get their own QueryContext so
	//    background subagents can run concurrently with the parent query.
	const isReentrant = activeQuery;
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);
	// pi's own prompt, whole: toBridgeContext joined pi's sections through pi-ai, as pi
	// renders them (tools, rules, docs, context files, skills, extensions' sections). No
	// capture lookup: a prompt nothing recorded (a replaced prompt, a subagent's wrapper)
	// is forwarded as it is.
	const systemPromptText = context.systemPrompt || undefined;
	const usePreset = systemPromptPresetEnabled(providerSettings);
	const promptDigest = promptDigestFor(systemPromptText);

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	claimCurrentPiStream(stream, "fresh-query", queryCtx, options);
	// A held event belongs to the query that received it, not to this request.
	queryCtx.heldRateLimit = undefined;
	// The Extra Usage warning is once per query: a fresh query on a reused
	// top-level context warns again (tool-result continuations share it).
	queryCtx.warnedUnplannedOverage = false;
	// Per query: a continuation's fallback waits for this query's first sign of work.
	queryCtx.sawTurnWork = false;
	queryCtx.pendingToolCalls.clear();
	queryCtx.pendingResults.clear();
	queryCtx.pendingSteerUuids.clear();
	queryCtx.deliveredToolCallIds.clear();
	queryCtx.deliveredToolCallNames.clear();
	queryCtx.dispatchedToolCalls.clear();
	// Stale ids would let a late result from the previous query route here via
	// contextForToolResults — which now means pushing its steer into this
	// query's stdin, not just mismatching a map.
	queryCtx.turnToolCallIds = [];
	queryCtx.resetTurnState(model);
	queryCtx.servedModel = model;
	queryCtx.latestCursor = 0;
	latestSent.delete(queryCtx); // fork: reopen resume
	// The served pi session, for rewrite attribution on delivery (issue #101
	// follow-up) and on SessionState. A fresh instance of this module inside a
	// worktree-spawned subagent has its own contexts; each records its own.
	queryCtx.piSessionId = options?.sessionId ?? null;
	// A discarded query's replacement reuses this context; without the reset its
	// first tool result would sit on armed staleness again (the mark is consumed
	// from the set, not from here) and re-discard a healthy query.
	queryCtx.historyStale = false;
	queryCtx.missedSteer = false;

	const cwd = sessionCwdFor(options?.sessionId);
	// cliModel is the actual id sent to Claude Code (may carry [1m]); model.id is the
	// pi-registered id. Log cliModel so debug lines reflect what CC actually received.
	const cliModel = claudeCodeModelId(model, longContextSettings);
	// Which pi session this query serves — the attribution key for history
	// rewrites (session_compact / session_tree) and for SessionState above.
	const piSessionId = options?.sessionId ?? null;
	// Read before the consume below: with no query parked (an overflow retried
	// after compaction), the session's mark is the only sign of the rewrite.
	const historyRewritten = rewrittenUnderQuery || (piSessionId !== null && historyRewrittenBySession.has(piSessionId));
	// Reentrant for this session's mirror only: a query of another pi session (a
	// background subagent holding the top-level context) writes another CC file, so
	// it must not send this session's rewritten history down the subagent path.
	const sessionReentrant = [...activeQueryContexts].some((c) => c !== queryCtx && c.activeQuery !== null && sessionKey(c.piSessionId) === sessionKey(piSessionId));
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	// A turn continuing past a rewrite, or at a tool result no query of this process
	// was parked on (a restart, a crash, a stall), ends at its tool result, not at a
	// prompt, so say what happened rather than falling into the empty-prompt recovery
	// below — that one is for a shape we do not expect, and this is one we do.
	const atToolResult = lastMsg?.role === "toolResult" && !promptText && !promptBlocks;
	const continuationText = atToolResult && historyRewritten ? CONTINUE_AFTER_REWRITE_PROMPT
		: atToolResult && unparkedToolResult ? CONTINUE_AFTER_RESUME_PROMPT
		: null;
	if (continuationText) {
		promptText = continuationText;
		debug(historyRewritten
			? `provider: continuing the turn after a rewritten history, ${context.messages.length} msgs rebuilt`
			: `provider: resuming the turn at a tool result with no parked query, ${context.messages.length} msgs`);
	}
	// Claude Code resumes the turn itself, with nothing on stdin (upstream #274), over a
	// file the sync rebuilds to end at the tool result. Not for a query reentrant on the
	// session: its sync must not rebuild the owner's file, so it writes the prompt.
	let continuation = continuationText !== null && !sessionReentrant;
	const syncResult = syncSharedSession(context.messages, cwd, customToolNameToSdk, cliModel, piSessionId, sessionReentrant, promptDigest, continuation);
	// This query starts from the history pi has now: consume this session's
	// armed rewrite — a sibling pi session's stays armed for its own queries.
	if (piSessionId) historyRewrittenBySession.delete(piSessionId);
	const { sessionId: resumeSessionId } = syncResult;
	// The prompt the session this query runs on records: CC keeps the one it was made
	// with. A resumed session's is its state's (the owner resumes only on a match; a
	// reentrant query must not overwrite the owner's); a fresh or rebuilt one records
	// this query's. Completion and an abort write it back.
	queryCtx.promptDigest = resumeSessionId ? sessionStateFor(piSessionId)?.promptDigest : promptDigest;
	// With no session to resume there is no turn for CC to resume: write the prompt.
	if (continuation && !resumeSessionId) continuation = false;

	// Guard: empty prompt means the last context message isn't a user message.
	// This should never happen with per-query state — dump diagnostics if it does.
	if (!promptText && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
			isReentrant,
			activeQueryContexts: activeQueryContexts.size,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: sessionStateFor(piSessionId) ? { sessionId: sessionStateFor(piSessionId)!.sessionId.slice(0, 8), cursor: sessionStateFor(piSessionId)!.cursor } : (sessionStateFor(null) ? { sessionId: sessionStateFor(null)!.sessionId.slice(0, 8), cursor: sessionStateFor(null)!.cursor } : null),
			messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
		});
		// Recover: use a continuation prompt so the SDK doesn't send an empty text block
		promptText = "[continue]";
	}

	// Always stream the prompt rather than passing a string: a parked input
	// generator is what lets us write steers to CC's stdin mid-turn. The cost is
	// that `isSingleUserTurn` is false, so the SDK no longer closes stdin on the
	// first result — consumeQuery ends the stream explicitly instead, or the
	// query would never terminate.
	// A continuation writes nothing (upstream #274); its prompt is still the one an
	// abort or error mark looks for, since CC records it as a meta user record.
	const abortedTurn = abortedTurnAtStart(promptBlocks, promptText, resumeSessionId, cwd); // fork: abort resume
	const promptStream = makePromptStream();
	const pushPrompt = (what: string) => void promptStream.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
		.catch((error) => debug(`provider: ${what} push rejected:`, error));
	if (!continuation) pushPrompt("initial prompt");
	queryCtx.promptStream = promptStream;
	const mcpServers = buildMcpServers(mcpTools, queryCtx);

	// MCP auto-loading suppression: CC reads MCP servers from ~/.claude.json (top-level
	// + per-project) and .mcp.json. Since pi executes tools (not CC), those are pure
	// token overhead. --strict-mcp-config tells the binary to use ONLY mcpServers passed
	// programmatically and ignore filesystem MCP entries — applied unconditionally because
	// the user's settings are loaded (see providerSettingSourcesOption in fork.ts).
	const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;
	const claudeExecutable = providerSettings.pathToClaudeCodeExecutable;

	const effort = effortForReasoning(model, options?.reasoning);
	const thinking = thinkingForReasoning(model, options?.reasoning);

	const extraArgs: Record<string, string | null> = { model: cliModel, "replay-user-messages": null };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.
	if (effort) extraArgs["thinking-display"] = "summarized";

	// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth
	// when the user is logged into Anthropic). These are a separate code path from
	// filesystem MCP and are NOT blocked by --strict-mcp-config or settingSources.
	// The native CC binary gates them on env var ENABLE_CLAUDEAI_MCP_SERVERS: setting it
	// to "0"/"false"/"no"/"off" makes the loader return early before any cloud fetch.
	// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
	// /compact via session_compact (see handler in default export). Letting CC
	// also autocompact would double-flush the prompt cache and races pi's
	// threshold with CC's, including CC's anti-thrashing guard (issue #8).
	// Manual /compact in CC still works (we never invoke it).
	const childEnv = continuation ? continuationEnv(promptText) : ccChildEnv();
	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		env: childEnv,
		tools: [],
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		// includeGitInstructions:false drops the gitStatus block from the preset.
		// That block is the trailing suffix of the cached system block, and a
		// git-state transition (new file, staging, commit) rewrites it — busting
		// the prompt cache for the whole conversation from there on (see
		// diag/probe-git-cache.mjs). The bridge re-invokes CC per turn, so this
		// hit on every transition. Cost here is nil: the setting also strips
		// CC's git-workflow guidance from its Bash tool prompt, but the provider
		// path runs CC with `tools: []`, so those definitions never ship.
		settings: {
			...claudeCodeSettings(providerSettings),
			claudeMdExcludes: CLAUDE_MD_EXCLUDES,
			includeGitInstructions: false,
			// An output style is persona text written for standalone Claude Code, like
			// the CLAUDE.md excluded above; pi owns the persona here (#220). This flag
			// layer outranks user/project/local settings.
			outputStyle: "default",
		},
		// Claude Code's preset first with pi's prompt as its append, or, with
		// provider.systemPromptPreset false, pi's prompt alone.
		systemPrompt: usePreset
			? { type: "preset", preset: "claude_code", append: systemPromptText }
			: systemPromptText,
		extraArgs,
		...(effort ? { effort } : {}),
		...(thinking ? { thinking } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(syncResult.resumeSessionAt ? { resumeSessionAt: syncResult.resumeSessionAt } : {}), // fork: error resume
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		...makeCliDebugOptions("provider"),
	};
	trackCliProcess(queryOptions, abortedTurn); // fork: abort resume

	debug("provider: fresh query",
		`model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
		`promptChars=${systemPromptText?.length ?? 0} preset=${usePreset} strictMcp=${strictMcpConfigEnabled}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}${continuation ? " [resume env, no stdin]" : ""}`);

	// 3. Start SDK query and claim it for this context
	let wasAborted = false;
	// A continuation's fallback (armed below), disarmed on abort and when the query ends.
	let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
	const sdkQuery = queryImpl({ prompt: promptStream.stream, options: queryOptions });
	queryCtx.activeQuery = sdkQuery;
	queryCtx.aborting = false; // the top-level context is reused across queries
	activeQueryContexts.add(queryCtx);

	// 4. Capture context for abort handling
	const abortCtx = queryCtx;

	const requestAbort = () => {
		// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
		// Both are needed — interrupt alone lets the current API call finish.
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch {}
	};
	const onAbort = () => {
		if (wasAborted) return;
		wasAborted = true;
		if (fallbackTimer) abortCtx.clearContinuationFallback(fallbackTimer);
		abortCtx.aborting = true;
		drainForAbort(abortCtx, promptStream);
		requestAbort();
	};
	// Safety net for a continuation (upstream #274): CC that judged the turn complete
	// shows nothing and waits on stdin, so after a quiet spell write the old continue
	// prompt after all, rather than let the turn hang. Only while this is still the
	// context's live query, not aborted or discarded.
	if (continuation) {
		const timer = setTimeout(() => {
			queryCtx.clearContinuationFallback(timer);
			if (queryCtx.sawTurnWork || wasAborted || abandonedQueries.has(sdkQuery) || queryCtx.activeQuery !== sdkQuery || queryCtx.promptStream !== promptStream) return;
			debug(`provider: continuation showed no sign of working on the turn in ${queryCtx.continuationFallbackMs} ms, writing the continue prompt`);
			pushPrompt("continuation fallback");
		}, queryCtx.continuationFallbackMs);
		timer.unref?.();
		fallbackTimer = timer;
		queryCtx.continuationFallback = timer;
	}
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}
	// A later run continuing this query from a tool result brings its own signal;
	// only the latest one is bound, and it is unbound when the query ends. Its abort
	// counts only while that run's stream is live: hosts that abort each request's
	// signal after it ends would otherwise kill the query parked at the next tool call.
	let unbindRunSignal = () => {};
	const bindRunSignal = (signal: AbortSignal | undefined, runStream: AssistantMessageEventStream) => {
		unbindRunSignal();
		unbindRunSignal = () => {};
		if (!signal || signal === options?.signal) return;
		const onRunAbort = () => { if (!completedStreams.has(runStream as object)) onAbort(); };
		if (signal.aborted) return onRunAbort();
		signal.addEventListener("abort", onRunAbort, { once: true });
		unbindRunSignal = () => signal.removeEventListener("abort", onRunAbort);
	};
	queryCtx.bindRunSignal = bindRunSignal;

	// Background consumer — runs until query ends
	consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
		.then(async ({ capturedSessionId, failure }) => {
			debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`);
			// The same teardown as the SDK's own throw after an error result: the
			// session mirror is dropped, so a steer never incorporated is rebuilt
			// (fork: error resume, otherwise the session is marked for resume).
			if (failure) throw failure;

			// Discarded out from under: the query continuing the turn owns the context,
			// the session and the stream. Capturing this one's session id here would put
			// Claude Code back on the conversation it was discarded for.
			if (abandonedQueries.has(sdkQuery)) {
				debug("provider: discarded query completed, leaving session and stream to its replacement");
				return;
			}

			// --- Abort detection in normal completion path ---
			if (wasAborted || options?.signal?.aborted) {
				// The killed subprocess may flush a late record into this session's
				// JSONL — its own mirror's next sync must rebuild and rotate.
				const state = sessionStateFor(queryCtx.piSessionId);
				if (state) setSessionStateFor(queryCtx.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
				markAbortedSession(queryCtx, state, capturedSessionId, Math.max(context.messages.length, queryCtx.latestCursor), cwd, Boolean(syncResult.preserveSharedSession), abortedTurn, context.messages); // fork: abort resume
				debug(`provider: abort detected, marked sharedSession needsRebuild + forceRotate`);
				// A turn whose stream already ended was returned to pi; failing it now
				// would rewrite a message pi has recorded (issue #181).
				const stream = queryCtx.currentPiStream;
				if (stream && queryCtx.turnOutput) {
					queryCtx.turnOutput.stopReason = "aborted";
					queryCtx.turnOutput.errorMessage = "Operation aborted";
				}
				stream?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
				markStreamComplete(stream);
				stream?.end();
				queryCtx.currentPiStream = null;
				queryCtx.heldRateLimit = undefined;
				return;
			}

			// --- Capture session ID ---
			// This query's own mirror — a reentrant subagent completing does not
			// reassign the parent's conversation to the child's CC file.
			if (syncResult.preserveSharedSession) {
				const state = sessionStateFor(queryCtx.piSessionId);
				if (capturedSessionId && capturedSessionId !== state?.sessionId) {
					deleteSession(capturedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
					debug(`provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`);
				}
				debug(`provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`);
			} else {
				const state = sessionStateFor(queryCtx.piSessionId);
				const sessionId = capturedSessionId ?? state?.sessionId;
				if (sessionId) {
					const cursor = Math.max(context.messages.length, queryCtx.latestCursor, state?.cursor ?? 0);
					debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
					// A missed steer may precede the first mirror or arrive while this
					// query is still able to complete. Preserve both rebuild signals.
					setSessionStateFor(queryCtx.piSessionId, { ...state, sessionId, cursor, cwd, piSessionId: queryCtx.piSessionId ?? undefined, needsRebuild: queryCtx.missedSteer || state?.needsRebuild, promptDigest: queryCtx.promptDigest ?? state?.promptDigest });
					recordMirror(queryCtx, context.messages, cwd); // fork: reopen resume
				}
			}

			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				debug("provider: clearing activeQuery before final stream completion");
				queryCtx.activeQuery = null;
			}
			finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
		})
		.catch((error) => {
			debug(`provider: query error, model=${cliModel}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
			if (abandonedQueries.has(sdkQuery)) {
				debug("provider: discarded query ended in error, leaving session and stream to its replacement");
				return;
			}
			if ((wasAborted || options?.signal?.aborted)) {
				const state = sessionStateFor(queryCtx.piSessionId);
				if (state) setSessionStateFor(queryCtx.piSessionId, { ...state, needsRebuild: true, forceRotate: true });
				markAbortedSession(queryCtx, state, undefined, Math.max(context.messages.length, queryCtx.latestCursor), cwd, Boolean(syncResult.preserveSharedSession), abortedTurn, context.messages); // fork: abort resume
				queryCtx.heldRateLimit = undefined;
			} else if (errorResultMarkable(error, queryCtx) && !syncResult.preserveSharedSession && !sessionStateFor(queryCtx.piSessionId)?.needsRebuild) { // fork: error resume
				// CC recorded the failed turn, so the next one resumes its file, as after an abort.
				markAbortedSession(queryCtx, sessionStateFor(queryCtx.piSessionId), error.capturedSessionId, Math.max(context.messages.length, queryCtx.latestCursor), cwd, false, abortedTurn, context.messages, true);
			} else {
				// Drop this session's mirror: its conversation is in an unknown
				// state after the error. Other sessions' mirrors stay — one
				// session's failure says nothing about another's conversation.
				setSessionStateFor(queryCtx.piSessionId, null);
				if (queryCtx.piSessionId) dropMirror(queryCtx.piSessionId); // fork: reopen resume
			}
			promptStream.fail(error instanceof Error ? error : new Error(String(error)));
			if (queryCtx.turnOutput && queryCtx.currentPiStream) {
				queryCtx.turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
				// The SDK drops its copy of the result text if any message follows the error
				// result, so prefer the cause consumeQuery recorded off the result itself.
				queryCtx.turnOutput.errorMessage ??= error instanceof Error ? error.message : String(error);
				queryCtx.turnOutput.errorMessage = withStderrTail(queryCtx.turnOutput.errorMessage, abortedTurn.process); // fork: abort resume
			}
			if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
				queryCtx.releasePendingToolCalls("Query ended");
				debug("provider: clearing activeQuery before error stream completion");
				queryCtx.activeQuery = null;
			}
			const stream = queryCtx.currentPiStream;
			stream?.push({ type: "error", reason: (queryCtx.turnOutput?.stopReason ?? "error") as "aborted" | "error", error: queryCtx.turnOutput! });
			markStreamComplete(stream);
			stream?.end();
			queryCtx.currentPiStream = null;
		})
		.finally(() => {
			if (fallbackTimer) queryCtx.clearContinuationFallback(fallbackTimer);
			if (options?.signal) options.signal.removeEventListener("abort", onAbort);
			unbindRunSignal();
			if (queryCtx.bindRunSignal === bindRunSignal) queryCtx.bindRunSignal = null;
			// Settle any ack still parked in the generator — the CLI is gone, so
			// nothing will resume it. Clear the handle only if a later query
			// hasn't already claimed the shared context.
			promptStream.fail(new Error("query ended"));
			if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
			// A later query claiming this context sets activeQuery to its own handle;
			// null means the .then/.catch above cleared ours and nothing replaced it.
			// Testing only for `=== sdkQuery` would never fire on the non-reentrant
			// path, leaving the top-level context in the routing set forever — where a
			// later orphaned tool result matches its stale turnToolCallIds and takes
			// the delivery branch, returning a stream nothing ends.
			if (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null) {
				queryCtx.releasePendingToolCalls("Query ended");
				queryCtx.activeQuery = null;
				activeQueryContexts.delete(queryCtx);
			}
			sdkQuery.close();
		});

	return stream;
}

// --- Extension registration ---

export default function (pi: ExtensionAPI) {
	const captureStoreLeft = removeObsoleteCaptureStore(); // fork: obsolete capture store
	if (captureStoreLeft) debug(`activation: ${captureStoreLeft}`); // fork: obsolete capture store
	const config = loadConfig();
	debug("loadConfig:", JSON.stringify(config));
	providerSettings = config.provider ?? {};
	// We need these settings to know if we're eligible for 1M context on certain models
	// Validate at the boundary: a non-array here would throw inside every
	// claudeCodeModelId call and brick the extension at activation.
	const forceTwoHundredK = Array.isArray(providerSettings.forceTwoHundredK)
		? providerSettings.forceTwoHundredK.filter((id): id is string => typeof id === "string")
		: undefined;
	longContextSettings = {
		plan: providerSettings.plan ?? "pro",
		longContextExtraUsage: providerSettings.longContextExtraUsage ?? false,
		forceTwoHundredK,
	};
	const registeredModels = applyLongContext(MODELS, longContextSettings);
	if (registeredModels.length === 0) {
		console.error("claude-bridge: no models available from pi-ai's anthropic catalog — update @earendil-works/pi-ai (requires >=1.5.1)");
	}

	// Reset shared session on pi session lifecycle events
	const clearSession = (event: string) => {
		debug(`${event}: clearing ${sharedSessions.size} shared session${sharedSessions.size === 1 ? "" : "s"}`);
		// Whole map: children never emit session_shutdown (only runtime teardown
		// and /reload do), so there is no per-entry removal to do here — the
		// top-level transition takes every mirror with it.
		sharedSessions.clear();
		historyRewrittenBySession.clear();

		// Clear the global streamSimple if this instance registered it.
		// This allows /reload to work — the old instance clears the flag so
		// the new instance can register fresh without wrapping stale state.
		const g = globalThis as Record<symbol, any>;
		if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
			debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
			g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
		}
	};
	pi.on("session_start", (event, ctx) => {
		piUI = ctx.ui;
		piUI = withRateLimitNoticeFilter(piUI, () => providerSettings); // fork: provider.rateLimitWarnings
		piMode = ctx.mode;
		rememberSessionCwd(ctx.sessionManager.getSessionId(), ctx.cwd);
		removedAskClaudeNoticeText = removedAskClaudeNotice();
		rememberForkParent(event, ctx.sessionManager.getSessionId()); // fork: fork cache
		if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
			clearSession(`session_start:${event.reason}`);
		}
	});
	pi.on("session_before_compact", (event, ctx) => {
		rememberSummarySession(event.signal, ctx.sessionManager.getSessionId());
	});
	pi.on("session_before_tree", (event, ctx) => {
		rememberSummarySession(event.signal, ctx.sessionManager.getSessionId());
	});
	// The provider forwards pi's system message whole (toBridgeContext), so there is
	// nothing to record here. agent_start still clears a stale tool rejection: a
	// terminating tool can end the previous run without consuming its rejection.
	pi.on("agent_start", (_event, ctx) => {
		rejectedToolCalls.delete(ctx?.sessionManager?.getSessionId?.() ?? null);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		forgetSessionCwd(ctx.sessionManager.getSessionId());
		closeSessionQueries(ctx.sessionManager.getSessionId());
		clearSession("session_shutdown");
	});

	// Pi and summary extensions own compaction and branch summaries; native calls use the
	// isolated provider path. Observe the completed rewrite below, not its owner.

	// pi /compact and session-tree navigation (rewind / fork-at-point /
	// branch switch) both mutate pi's messages array out from under the
	// bridge. syncSharedSession's REUSE check would otherwise see
	// slice(cursor) === [] (or skip entries) and keep --resume'ing a CC
	// session that no longer matches pi's history. /compact in particular
	// triggers CC's autocompact-thrashing guard (issue #8). Force the next
	// call down the REBUILD path so CC sees the current history — and, when a
	// query is parked at a tool boundary while this fires, discard that query
	// instead of resuming it (markRebuild, discardRewrittenQuery).
	//
	// Attributed to the compacting session (ctx.sessionManager belongs to the
	// session whose runner fired this), so a subagent compacting while its
	// parent sits parked on the Agent tool result discards nothing — the parent's
	// query is live and its conversation untouched. Registered by every instance
	// of this module; instances sponsoring stale marks forward them to the
	// serving instance via sponsorMarkRebuildForSession.
	pi.on("session_compact", (event, ctx) =>
		sponsorMarkRebuildForSession(ctx.sessionManager.getSessionId(), `session_compact:${event.reason}:willRetry=${event.willRetry}`));
	pi.on("session_tree", (_event, ctx) => sponsorMarkRebuildForSession(ctx.sessionManager.getSessionId(), "session_tree"));

	// Claude Code models expect bash to time out (CC's default is 120s); pi's bash has none.
	// Set it on the execution copy pi hands tool_call handlers, not in the stored call, so
	// pi's history keeps the arguments CC sent and a rebuild matches CC's records (#203).
	pi.on("tool_call", (event, ctx) => {
		if (isToolCallEventType("bash", event) && event.input.timeout == null && ctx.model?.provider === PROVIDER_ID) {
			event.input.timeout = 120;
		}
	});

	// --- Provider ---
	//
	// Registration policy across module instances (a subagent session can load
	// this module fresh): the FIRST instance registers unconditionally at load,
	// which is what puts claude-bridge models in the picker before any session
	// starts. Later instances decide at session_start, when ctx.modelRegistry
	// reveals who owns this session's registry:
	//
	// - Registry already has the provider (host passes the parent's registry down,
	//   e.g. pi-subagents >=0.14.3): skip. Re-registering would overwrite the
	//   parent's pinned streamSimple with this instance's fresh — empty-state —
	//   stream fn, and the parent's next tool-result delivery would route into it.
	// - Registry lacks the provider (host gives the child its own, e.g. older
	//   pi-subagents forks): register, or every claude-bridge/* dispatch in the
	//   child fails with "Model not found" (#91). Even loading the bridge via the
	//   agent's `extensions:` frontmatter didn't help there — the module loaded,
	//   hit the old skip-guard, and the child's registry stayed empty.
	//
	// A per-instance stream fn registered into a per-instance registry is
	// self-consistent: that session's traffic flows through this module state,
	// which starts clean and serves only that session.
	//
	// On session_shutdown (including /reload), clearSession() resets
	// ACTIVE_STREAM_SIMPLE_KEY so a freshly loaded module can register as first
	// again.

	const g = globalThis as Record<symbol, any>;
	const providerConfig = {
		baseUrl: "claude-bridge",
		apiKey: "not-used",
		api: "claude-bridge",
		models: registeredModels,
		// Cast: the Provider interface passes a TranscriptContext; the bridge takes plain
		// Context models (toBridgeContext normalizes at the stream entry points).
		streamSimple: streamClaudeAgentSdk as any,
	};
	if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
		// First instance: store our streamSimple and register.
		g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
		pi.registerProvider(PROVIDER_ID, providerConfig);
	} else {
		// Later instance: register only if this session's registry lacks the provider.
		debug(`provider: deferring registration decision to session_start (module=${moduleInstanceId})`);
		pi.on("session_start", (_event, ctx) => {
			if (ctx.modelRegistry.getProvider(PROVIDER_ID)) {
				debug(`provider: registry already has ${PROVIDER_ID}, skipping registration (module=${moduleInstanceId})`);
				return;
			}
			debug(`provider: registry lacks ${PROVIDER_ID}, registering (module=${moduleInstanceId})`);
			pi.registerProvider(PROVIDER_ID, providerConfig);
		});
	}
}
