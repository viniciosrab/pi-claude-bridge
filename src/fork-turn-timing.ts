// Fork-only debug timing for provider queries (@viniciosrab/pi-claude-bridge).
//
// With CLAUDE_BRIDGE_DEBUG=1, `timing:` lines in the bridge log split each provider
// query's latency:
//   timing: query=q1 spawn→init=310ms                Claude Code's own start-up
//   timing: query=q1 first token=2400ms              measured from launch
//   timing: query=q1 result elapsed=3100ms cc=2900ms api=2600ms apiTotal=5200ms
// On a result, `cc` is this turn's Claude Code time and `api` this turn's API time,
// so `cc` minus `api` is the time Claude Code spent outside the API. `apiTotal` is
// Claude Code's running API total for the session, which it carries across --resume
// (pinned live in tests/int-fork-cc-contracts.mjs), so `api` is the difference from
// the total last seen for that session. `api=?` means the bridge cannot tell this
// turn's share: the first turn of a session this process did not see, the turn
// after one that ended without a result (an abort), or a total that went backwards.
//
// Like src/fork.ts, this lives in its own file and src/index.ts only carries one-line
// hooks: the import and a wrap where queryImpl is assigned, a seam upstream leaves
// alone, rather than lines inside consumeQuery, which it keeps rewriting.

import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

type Query = ReturnType<typeof query>;

/** Wrap the SDK's query() so provider launches log their timing through `log`.
 *  Provider launches stream their prompt; the isolated summary and AskClaude pass a
 *  string and go through untouched. The returned Query is the SDK's own object: only
 *  its async iterator is wrapped, so its methods and identity stay as they were. */
export function withTurnTiming(impl: typeof query, log: (line: string) => void): typeof query {
	let timedQueries = 0;
	// The last duration_api_ms seen per Claude Code session. A turn takes its session's
	// entry when it starts and puts it back only with its result, so a turn that ends
	// without one leaves the next turn's API time unknown rather than charged with the
	// unfinished turn's.
	const apiTotalBySession = new Map<string, number>();

	return ((params: Parameters<typeof query>[0]) => {
		const launchedAt = performance.now();
		const sdkQuery = impl(params);
		if (typeof params.prompt === "string") return sdkQuery;
		const observe = timeQuery(`q${++timedQueries}`, launchedAt, !params.options?.resume, apiTotalBySession, log);
		const iterate = sdkQuery[Symbol.asyncIterator].bind(sdkQuery);
		sdkQuery[Symbol.asyncIterator] = async function* () {
			for await (const message of { [Symbol.asyncIterator]: iterate }) {
				observe(message);
				yield message;
			}
		} as Query[typeof Symbol.asyncIterator];
		return sdkQuery;
	}) as typeof query;
}

function timeQuery(
	timingId: string,
	launchedAt: number,
	newSession: boolean,
	apiTotalBySession: Map<string, number>,
	log: (line: string) => void,
): (message: SDKMessage) => void {
	const sinceLaunch = () => Math.round(performance.now() - launchedAt);
	let sessionId: string | undefined;
	let timedInit = false, timedFirstToken = false;
	// The session total before the open turn: undefined while unknown.
	let turnOpen = false, turnPrev: number | undefined;
	// Spent before this turn: nothing on a session this query created; unknown on a
	// resumed one the bridge has not seen.
	const priorTotal = (id: string) => apiTotalBySession.get(id) ?? (newSession ? 0 : undefined);

	return (message) => {
		if (message.type === "system" && message.subtype === "init" && message.session_id) sessionId = message.session_id;
		if (!turnOpen && sessionId && message.type === "stream_event" && message.parent_tool_use_id === null && message.event.type === "message_start") {
			turnOpen = true;
			turnPrev = priorTotal(sessionId);
			apiTotalBySession.delete(sessionId);
		}
		if (!timedInit && message.type === "system" && message.subtype === "init") {
			timedInit = true;
			log(`timing: query=${timingId} spawn→init=${sinceLaunch()}ms`);
		} else if (!timedFirstToken && message.type === "stream_event" && message.parent_tool_use_id === null && message.event.type === "content_block_delta") {
			timedFirstToken = true;
			log(`timing: query=${timingId} first token=${sinceLaunch()}ms`);
		} else if (message.type === "result") {
			const total = message.duration_api_ms;
			const prev = turnOpen ? turnPrev : priorTotal(message.session_id);
			const api = prev !== undefined && total >= prev ? `${total - prev}ms` : "?";
			log(`timing: query=${timingId} result elapsed=${sinceLaunch()}ms cc=${message.duration_ms}ms api=${api} apiTotal=${total}ms`);
			apiTotalBySession.set(message.session_id, total);
			turnOpen = false;
		}
	};
}
