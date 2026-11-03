// fork: streaming tool args. Fork-only, like src/fork.ts, and in a file of its own so
// its cherry-pick never depends on what the rest of the fork code looks like.
//
// Upstream parses each input_json_delta with JSON.parse, which rejects every prefix of an
// object, so a tool call's arguments stay `{}` until its last delta: pi shows a bare `$`
// or `edit` row and then the whole call at once. These hooks show the prefix pi's own
// Anthropic provider would, and keep it off the arguments pi runs.

import { parseStreamingJson } from "@earendil-works/pi-ai";

/** The arguments a tool call had before any streamed prefix: its content_block_start
 *  input. */
const toolArgsBeforeStream = new WeakMap<object, Record<string, unknown>>();

/** Record a tool call's arguments before the stream touches them. Hooked before
 *  upstream's parse of each input_json_delta: when the first delta is complete JSON on
 *  its own, that parse replaces the arguments, and a later delta can still make the
 *  whole input invalid. Only the first call records. */
export function rememberToolArgs(block: { arguments: Record<string, unknown> }): void {
	if (!toolArgsBeforeStream.has(block)) toolArgsBeforeStream.set(block, block.arguments);
}

/** The arguments to show while a tool call streams: whatever its JSON prefix holds.
 *  Hooked after upstream's parse of each input_json_delta. Display only, never run. */
export function streamingToolArgs(block: { arguments: Record<string, unknown>; partialJson?: string }): Record<string, unknown> {
	rememberToolArgs(block);
	const before = toolArgsBeforeStream.get(block)!;
	return block.partialJson ? { ...before, ...parseStreamingJson<Record<string, unknown>>(block.partialJson) } : before;
}

/** The fallback upstream's parse gets at content_block_stop: the arguments before the
 *  stream, so input that is not valid JSON never runs as a streamed prefix. Hooked just
 *  before that parse. */
export function toolArgsFallback(block: { arguments: Record<string, unknown> }): Record<string, unknown> {
	return toolArgsBeforeStream.get(block) ?? block.arguments;
}
