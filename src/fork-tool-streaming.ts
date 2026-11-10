// fork: eager tool input streaming. Fork-only, in a file of its own like
// src/fork-stream-args.ts, so its cherry-pick never depends on the rest of the fork code.
//
// Without tools[].eager_input_streaming the API holds back each tool argument until it is
// complete, so pi shows a bare `$` or `edit` row and then the whole call at once, even
// with the streamed-prefix parse of src/fork-stream-args.ts. Pi's own Anthropic provider
// always asks for it; Claude Code only does behind a remote flag that is off by default,
// or when this variable is set. Measured with the SDK (Haiku, one Bash call of 120 words):
// unset, the first argument byte came 1.6 s after the tool call started and the rest in
// 0.1 s; set, 0.2 s after the start and spread over 1.6 s.

/** Claude Code's switch for tools[].eager_input_streaming. */
export const TOOL_STREAMING_ENV = "CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING";

/** Turn eager tool input streaming on in pi's own environment unless the user set it.
 *  Every Claude Code child the bridge spawns gets `ccChildEnv()` (pi's environment plus CC_CHILD_ENV),
 *  so this reaches all of them without editing CC_CHILD_ENV, which upstream owns. A user
 *  value wins, so exporting `0` turns it off. */
export function applyToolStreamingEnv(env: NodeJS.ProcessEnv = process.env): void {
	if (env[TOOL_STREAMING_ENV] === undefined) env[TOOL_STREAMING_ENV] = "1";
}

applyToolStreamingEnv();
