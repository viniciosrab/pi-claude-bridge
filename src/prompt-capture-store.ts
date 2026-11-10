import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { piSessionFileId } from "./fork.js";
import type { PromptCapture, PromptCaptureInput, PromptCaptures } from "./prompt-capture.js";

// Prompt captures on disk, so a pi session running in another process can resolve its
// parent's prompt (issue #37). pi-subagents runs a background child in its own process
// and, for a forked context, sends the PARENT's assembled prompt to reuse its prompt
// cache; the child's in-memory registry holds only the child's own capture.
//
// The parent writes its captures under its pi session id; a child whose session header
// names a `parentSession` file loads that session's captures at session_start. Found
// through the session link rather than a hash of the prompt: a request that is the
// parent's prompt plus one section (pi-subagents' subagent_instructions branch) matches
// no stored key, but resolves through the embedding route once the parent's capture is
// in the registry.
//
// A session resumed in a new process (resume, a new window, /reload) loads its own
// earlier file at session_start too, so its next write keeps what the earlier process
// recorded.
//
// The files hold the assembled system prompt and what the projection forwards: context
// files (AGENTS.md text), skill metadata, prompt sections, the custom and appended
// prompts. They sit in pi's agent dir next to the
// session files that already hold the conversation, owner-only.

const STORE_VERSION = 1;
/** As the session mirrors: long enough to revive a failed background child later. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Keys kept per session. A child needs the prompt its parent ran with when it
 *  dispatched; a few recent rebuilds (tool-list changes) cover that with margin. */
const MAX_KEYS_PER_SESSION = 16;
/** Sessions whose keys and last write this process keeps: the state outlives /reload. */
const MAX_SESSIONS = 64;
/** How often a long-running process sweeps old files. */
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

type StoredCapture = PromptCaptureInput & { assembledPrompt: string; source?: string };
type StoredFile = { version: number; sessionId: string; captures: StoredCapture[] };

type StoreState = { keys: Map<string, string[]>; written: Map<string, string>; lastPruned?: number };
const STATE_KEY = Symbol.for("claude-bridge:promptCaptureStore");
/** On globalThis, as the registry itself: isolated agents re-evaluate this module. */
function state(): StoreState {
	const g = globalThis as Record<symbol, StoreState | undefined>;
	const s = (g[STATE_KEY] ??= { keys: new Map(), written: new Map() });
	// A state left by an earlier version of this module (before /reload) lacks these.
	s.keys ??= new Map();
	s.written ??= new Map();
	return s;
}

/** Marks a session most recently used and drops the oldest beyond MAX_SESSIONS from
 *  both maps. Map order is insertion order, so re-inserting moves a key to the end. */
function touchSession(piSessionId: string): void {
	const { keys, written } = state();
	for (const map of [keys, written] as Map<string, unknown>[]) {
		if (!map.has(piSessionId)) continue;
		const value = map.get(piSessionId);
		map.delete(piSessionId);
		map.set(piSessionId, value);
	}
	const sessions = new Set([...keys.keys(), ...written.keys()]);
	if (sessions.size <= MAX_SESSIONS) return;
	// Oldest first: a session's position in `keys` is refreshed on every use.
	const recent = new Set([...keys.keys()].slice(-MAX_SESSIONS));
	for (const id of sessions) {
		if (recent.has(id)) continue;
		keys.delete(id);
		written.delete(id);
	}
}

/** Hooked at pi's session_shutdown: drops what this process keeps for a session. The
 *  file stays: a revived child, or the session resumed later, needs it. */
export function forgetSessionStore(piSessionId: string): void {
	state().keys.delete(piSessionId);
	state().written.delete(piSessionId);
}

function storeDir(): string {
	return join(getAgentDir(), "claude-bridge-captures");
}

function storePath(piSessionId: string): string {
	return join(storeDir(), `${encodeURIComponent(piSessionId)}.json`);
}

function prune(now: number): void {
	const s = state();
	if (s.lastPruned !== undefined && now - s.lastPruned < PRUNE_INTERVAL_MS) return;
	s.lastPruned = now;
	let names: string[];
	try { names = readdirSync(storeDir()); } catch { return; }
	for (const name of names) {
		// Per file: another process may remove or replace one while this loops.
		try {
			const file = join(storeDir(), name);
			if (now - statSync(file).mtimeMs > MAX_AGE_MS) rmSync(file, { force: true });
		} catch {}
	}
}

function rememberKey(piSessionId: string, systemPrompt: string, oldest = false): void {
	const keys = state().keys.get(piSessionId)?.filter((key) => key !== systemPrompt) ?? [];
	if (oldest) keys.unshift(systemPrompt);
	else keys.push(systemPrompt);
	state().keys.set(piSessionId, keys.slice(-MAX_KEYS_PER_SESSION));
	touchSession(piSessionId);
}

function toStored(capture: PromptCapture): StoredCapture {
	return {
		assembledPrompt: capture.assembledPrompt,
		...(capture.custom !== undefined ? { custom: capture.custom } : {}),
		...(capture.append !== undefined ? { append: capture.append } : {}),
		contextFiles: capture.contextFiles,
		skills: capture.skills,
		...(capture.sections ? { sections: capture.sections } : {}),
		...(capture.source ? { source: capture.source } : {}),
	};
}

/** Records that a pi session ran with this prompt and rewrites its store file with
 *  the session's recent captures and everything they inherit. When nothing changed it
 *  only refreshes the file's mtime, so another process does not prune an active
 *  session's file, and rewrites the file if it is gone. Best effort: a failure only means another process cannot resolve
 *  this prompt, as before. */
export function persistSessionCapture(piSessionId: string, systemPrompt: string, captures: PromptCaptures, now = Date.now()): void {
	try {
		rememberKey(piSessionId, systemPrompt);
		const body = JSON.stringify({
			version: STORE_VERSION,
			sessionId: piSessionId,
			captures: captures.lineage(state().keys.get(piSessionId) ?? []).map(toStored),
		} satisfies StoredFile);
		const file = storePath(piSessionId);
		if (state().written.get(piSessionId) === body) {
			try {
				utimesSync(file, now / 1000, now / 1000);
				prune(now);
				return;
			} catch {} // missing: write it again below
		}
		mkdirSync(storeDir(), { recursive: true, mode: 0o700 });
		prune(now);
		// Per-process temp name: a revived child and its parent can write one session's file.
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, body, { mode: 0o600 });
		chmodSync(tmp, 0o600); // a leftover temp file keeps its mode through writeFileSync
		renameSync(tmp, file);
		state().written.set(piSessionId, body);
	} catch {}
}

const isString = (value: unknown): value is string => typeof value === "string";
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The shape `record` and the projection rely on. A file another version or a crash
 *  left behind must not throw inside session_start. */
function isStoredCapture(value: unknown): value is StoredCapture {
	if (!isRecord(value) || !isString(value.assembledPrompt) || value.assembledPrompt.length === 0) return false;
	if (value.custom !== undefined && !isString(value.custom)) return false;
	if (value.append !== undefined && !isString(value.append)) return false;
	if (value.source !== undefined && !isString(value.source)) return false;
	if (!Array.isArray(value.contextFiles) || !value.contextFiles.every((f) => isRecord(f) && isString(f.path) && isString(f.content))) return false;
	if (!Array.isArray(value.skills) || !value.skills.every((s) => isRecord(s) && isString(s.name) && isString(s.description) && isString(s.filePath))) return false;
	return value.sections === undefined || (isRecord(value.sections) && Object.values(value.sections).every(isString));
}

function readStore(piSessionId: string): StoredCapture[] {
	try {
		const stored = JSON.parse(readFileSync(storePath(piSessionId), "utf8")) as Partial<StoredFile>;
		if (stored.version !== STORE_VERSION || stored.sessionId !== piSessionId || !Array.isArray(stored.captures)) return [];
		// All or nothing: a capture whose ancestor was dropped would re-record without its
		// inheritance edge and forward the ancestor's harness text verbatim.
		return stored.captures.every(isStoredCapture) ? stored.captures : [];
	} catch {
		return [];
	}
}

/** Loads the captures stored under `storeSessionId` into the registry, ancestors first.
 *  A key the registry already holds is left alone: this process recorded it live. The
 *  loaded keys join `ownSessionId`'s store, oldest, so its next write keeps them and a
 *  session forked from it in yet another process finds them too. Returns how many it
 *  added. */
function loadStoredSession(storeSessionId: string, ownSessionId: string, captures: PromptCaptures, label: string): number {
	const stored = readStore(storeSessionId);
	let added = 0;
	for (const capture of stored) {
		if (captures.has(capture.assembledPrompt)) continue;
		const { assembledPrompt, source, ...input } = capture;
		captures.record(assembledPrompt, input, `${label}${source ? ` (${source})` : ""}`);
		added++;
	}
	for (const capture of [...stored].reverse()) rememberKey(ownSessionId, capture.assembledPrompt, true);
	return added;
}

/** Hooked at pi's session_start: loads the captures of the session named by this
 *  session's header `parentSession` (a session file path). See loadStoredSession. */
export function loadParentCaptures(parentSessionFile: string | undefined, piSessionId: string, captures: PromptCaptures): number {
	if (!parentSessionFile) return 0;
	const parentId = piSessionFileId(parentSessionFile);
	if (!parentId || parentId === piSessionId) return 0;
	return loadStoredSession(parentId, piSessionId, captures, `parent session ${parentId}`);
}

/** Hooked at pi's session_start: loads the captures an earlier process stored for this
 *  same session (resume, a new window, /reload), so this process's next write does not
 *  replace them with only its own. See loadStoredSession. */
export function loadOwnCaptures(piSessionId: string, captures: PromptCaptures): number {
	return loadStoredSession(piSessionId, piSessionId, captures, `earlier process of session ${piSessionId}`);
}
