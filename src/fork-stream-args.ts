// fork: streaming tool args. Fork-only, like src/fork.ts, and in a file of its own so
// its cherry-pick never depends on what the rest of the fork code looks like.
//
// Upstream parses each input_json_delta with JSON.parse, which rejects every prefix of an
// object, so a tool call's arguments stay `{}` until its last delta: pi shows a bare `$`
// or `edit` row and then the whole call at once. These hooks show the prefix pi's own
// Anthropic provider would, and keep it off the arguments pi runs.
//
// Parsing the whole text on every delta costs O(n²): a 90 KB write in 10-byte deltas
// spent seconds of pi's main thread. When pi-ai has ToolCallArgumentsStream (1.5+), each
// delta goes to it once and partialJson is emptied, so upstream's per-delta parse returns
// at once; partialJson gets the whole text back just before the one parse at
// content_block_stop. Older pi-ai keeps the whole-text parse.

import * as piAi from "@earendil-works/pi-ai";

/** The surface of pi-ai's ToolCallArgumentsStream these hooks use. */
type ArgumentsStream = { append(delta: string): Record<string, unknown>; readonly text: string };
type ArgumentsStreamClass = new () => ArgumentsStream;

// A namespace import, so a pi-ai without the class loads and reads it as undefined.
let argumentsStreamClass = (piAi as Record<string, unknown>).ToolCallArgumentsStream as ArgumentsStreamClass | undefined;

/** Test-only: use `cls` instead of the class found in pi-ai, `undefined` for none.
 *  Returns the class in use before. */
export function setToolCallArgumentsStreamForTests(cls: ArgumentsStreamClass | undefined): ArgumentsStreamClass | undefined {
	const previous = argumentsStreamClass;
	argumentsStreamClass = cls;
	return previous;
}

/** The arguments a tool call had before any streamed prefix: its content_block_start
 *  input. */
const toolArgsBeforeStream = new WeakMap<object, Record<string, unknown>>();

/** A tool call's incremental parse and the partial arguments it last returned. */
const toolArgsStreams = new WeakMap<object, { stream: ArgumentsStream; partial: Record<string, unknown> }>();

/** Record a tool call's arguments before the stream touches them. Hooked before
 *  upstream's parse of each input_json_delta: when the first delta is complete JSON on
 *  its own, that parse replaces the arguments, and a later delta can still make the
 *  whole input invalid. Only the first call records. With an incremental stream, also
 *  moves the new text from partialJson into it, so a second call appends nothing. */
export function rememberToolArgs(block: { arguments: Record<string, unknown>; partialJson?: string }): void {
	if (!toolArgsBeforeStream.has(block)) toolArgsBeforeStream.set(block, block.arguments);
	if (!argumentsStreamClass || !block.partialJson) return;
	let state = toolArgsStreams.get(block);
	if (!state) toolArgsStreams.set(block, state = { stream: new argumentsStreamClass(), partial: {} });
	state.partial = state.stream.append(block.partialJson);
	block.partialJson = "";
}

/** The arguments to show while a tool call streams: whatever its JSON prefix holds.
 *  Hooked after upstream's parse of each input_json_delta. Display only, never run. */
export function streamingToolArgs(block: { arguments: Record<string, unknown>; partialJson?: string }): Record<string, unknown> {
	rememberToolArgs(block);
	const before = toolArgsBeforeStream.get(block)!;
	const state = toolArgsStreams.get(block);
	if (state) return { ...before, ...state.partial };
	return block.partialJson ? { ...before, ...piAi.parseStreamingJson<Record<string, unknown>>(block.partialJson) } : before;
}

/** The fallback upstream's parse gets at content_block_stop: the arguments before the
 *  stream, so input that is not valid JSON never runs as a streamed prefix. Hooked just
 *  before that parse, which reads the whole text from partialJson again. */
export function toolArgsFallback(block: { arguments: Record<string, unknown>; partialJson?: string }): Record<string, unknown> {
	const state = toolArgsStreams.get(block);
	if (state) block.partialJson = state.stream.text + (block.partialJson ?? "");
	return toolArgsBeforeStream.get(block) ?? block.arguments;
}
