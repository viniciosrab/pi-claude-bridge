/**
 * The turn after an API error result resumes Claude Code's own session, end to end:
 * the provider drives the real SDK and CLI against a localhost API stub that fails one
 * request with a 500 (upstream #103; see tests/unit-error-resume.mjs for the rules).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";

const root = mkdtempSync(join(tmpdir(), "claude-bridge-error-resume-cli-"));
after(() => rmSync(root, { recursive: true, force: true }));

// The CLI inherits pi's environment: only test credentials and the loopback endpoint,
// never the caller's API credentials or remote base URL. HOME and CLAUDE_CONFIG_DIR are
// already temporary (tests/lib/setup.mjs).
for (const key of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"]) delete process.env[key];
Object.assign(process.env, {
	ANTHROPIC_API_KEY: "offline-test", ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0",
});

const { __test } = await import("../src/index.js");
const { rememberSessionCwd } = await import("../src/session-cwd.js");
const mod = await import("../src/index.js");
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models.find((m) => /haiku/.test(m.id)) ?? providerConfig.models[0];

// --- localhost API stub: answers every turn, fails the first request carrying FAIL_ONCE ---
const FAIL_ONCE = "SECOND-PROMPT-FAILS";
const requests = [];
let failed = new Set();
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const server = createServer(async (req, res) => {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (req.method !== "POST" || !req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) {
		res.writeHead(200, { "content-type": "application/json" }).end('{"input_tokens":10}');
		return;
	}
	const body = JSON.parse(Buffer.concat(chunks).toString());
	if (!body.stream) {
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_side", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "t" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
		return;
	}
	const n = requests.push(body);
	const text = JSON.stringify(body.messages);
	const tag = text.match(/TAG-[a-z0-9-]+/)?.[0];
	if (tag && text.includes(FAIL_ONCE) && !failed.has(tag)) {
		failed.add(tag);
		res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "api_error", message: "stub failure" } }));
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.end([
		event("message_start", { message: { id: `msg_${n}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
		event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
		event("content_block_delta", { index: 0, delta: { type: "text_delta", text: `ANSWER-${n}` } }),
		event("content_block_stop", { index: 0 }),
		event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
		event("message_stop", {}),
	].join(""));
});
before(async () => {
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

// --- pi side ---
let clock = 1;
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const asst = (content, stopReason, errorMessage) => ({ role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, ...(errorMessage ? { errorMessage } : {}), timestamp: clock++ });

const sessionFiles = () => {
	const projects = join(process.env.CLAUDE_CONFIG_DIR, "projects");
	if (!existsSync(projects)) return [];
	return readdirSync(projects).flatMap((dir) => readdirSync(join(projects, dir)).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)));
};
const withoutCacheControl = (x) => JSON.stringify(x, (k, v) => (k === "cache_control" ? undefined : v));
const requestFor = (marker) => requests.findLast((r) => JSON.stringify(r.messages).includes(marker));
const count = (text, needle) => text.split(needle).length - 1;

/** A completed turn, then a turn whose request fails with a 500, on pi session `P`. */
async function completeThenFail(P) {
	const cwd = mkdtempSync(join(root, "work-"));
	rememberSessionCwd(P, cwd);
	const call = (messages) => streamSimple(model, { messages, tools: [] }, { sessionId: P });
	const u1 = user(`TAG-${P} FIRST-PROMPT`);
	const first = await call([u1]).result();
	assert.equal(first.stopReason, "stop", first.errorMessage);
	const a1 = first;
	const sessionId = __test.getSharedSession(P).sessionId;

	const u2 = user(`TAG-${P} ${FAIL_ONCE}`);
	const second = await call([u1, a1, u2]).result();
	assert.equal(second.stopReason, "error");
	assert.match(second.errorMessage, /500/);
	assert.equal(__test.getSharedSession(P)?.errorResult, true, "the error result leaves a mark, not a dropped session");
	return { call, u1, a1, u2, failedTurn: second, sessionId };
}

describe("after an API error result, with the real CLI", { timeout: 90_000 }, () => {
	it("a new prompt resumes the same Claude Code session", async () => {
		const P = "cli-new";
		const { call, u1, a1, u2, failedTurn, sessionId } = await completeThenFail(P);
		const failedRequest = requestFor(`TAG-${P} ${FAIL_ONCE}`);
		const filesBefore = sessionFiles();

		const third = await call([u1, a1, u2, failedTurn, user(`TAG-${P} THIRD-PROMPT`)]).result();
		assert.equal(third.stopReason, "stop", third.errorMessage);

		assert.equal(__test.getSharedSession(P).sessionId, sessionId, "the same CC session id");
		assert.deepEqual(sessionFiles(), filesBefore, "no new .jsonl");
		const request = requestFor(`TAG-${P} THIRD-PROMPT`);
		assert.equal(withoutCacheControl(request.messages.slice(0, 2)), withoutCacheControl(failedRequest.messages.slice(0, 2)), "the prior [user, assistant] prefix is unchanged");
		assert.doesNotMatch(JSON.stringify(request.messages), /stub failure/, "CC strips its API error record");
	});

	it("pi's retry of the failed prompt resumes the same session and sends the prompt once", async () => {
		const P = "cli-retry";
		const { call, u1, a1, u2, sessionId } = await completeThenFail(P);
		const failedRequest = requestFor(`TAG-${P} ${FAIL_ONCE}`);
		const filesBefore = sessionFiles();
		const sent = requests.length;

		const retry = await call([u1, a1, u2]).result();
		assert.equal(retry.stopReason, "stop", retry.errorMessage);

		assert.equal(__test.getSharedSession(P).sessionId, sessionId, "the same CC session id");
		assert.deepEqual(sessionFiles(), filesBefore, "no new .jsonl");
		const request = requests.slice(sent).findLast((r) => JSON.stringify(r.messages).includes(`TAG-${P} ${FAIL_ONCE}`));
		assert.ok(request, "the retry reached the API");
		assert.equal(withoutCacheControl(request.messages.slice(0, 2)), withoutCacheControl(failedRequest.messages.slice(0, 2)), "the prior [user, assistant] prefix is unchanged");
		assert.equal(count(JSON.stringify(request.messages), FAIL_ONCE), 1, "the failed prompt is sent once, not twice");

		// The next turn resumes plainly and follows the retried branch, not the failed one.
		const next = await call([u1, a1, u2, retry, user(`TAG-${P} FOURTH-PROMPT`)]).result();
		assert.equal(next.stopReason, "stop", next.errorMessage);
		assert.equal(__test.getSharedSession(P).sessionId, sessionId);
		const later = JSON.stringify(requestFor(`TAG-${P} FOURTH-PROMPT`).messages);
		assert.equal(count(later, FAIL_ONCE), 1, "the failed attempt stays cut");
		assert.ok(later.includes(retry.content[0].text), "the retry's answer is in the history");
	});
});
