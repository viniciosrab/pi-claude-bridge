/**
 * Provider level: the system prompt handed to Claude Code (the SDK's `systemPrompt`
 * option). By default Claude Code's `claude_code` preset goes first with pi's whole
 * prompt, as pi renders it, as its append; `provider.systemPromptPreset: false` sends
 * pi's prompt alone as a plain string. No prompt capture is consulted, so a prompt
 * nothing recorded (a replaced prompt, a subagent's wrapper) still starts a query.
 *
 * Claude Code re-sends the prompt a session was created with on every resume
 * (tests/int-cc-contracts.mjs), so a changed prompt, or a changed preset setting,
 * rebuilds the session from pi's history instead of resuming it.
 *
 * The SDK is stubbed through __test.setQuery: no Claude Code process runs.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";

// The config file is read at activation; CLAUDE_BRIDGE_CONFIG lets each test supply its own.
const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-system-prompt-"));
const configPath = join(tmpRoot, "claude-bridge.json");
const originalConfig = process.env.CLAUDE_BRIDGE_CONFIG;
process.env.CLAUDE_BRIDGE_CONFIG = configPath;
process.on("exit", () => {
	if (originalConfig === undefined) delete process.env.CLAUDE_BRIDGE_CONFIG;
	else process.env.CLAUDE_BRIDGE_CONFIG = originalConfig;
	rmSync(tmpRoot, { recursive: true, force: true });
});

const mod = await import("../src/index.js");
const { __test } = mod;
const { formatSkillsForPrompt } = await import("@earendil-works/pi-coding-agent");
const { buildSystemPrompt, buildSystemPromptState } =
	await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url).href);

const cwd = "/tmp/project";
let provider;
function activate(providerConfig) {
	writeFileSync(configPath, JSON.stringify({ provider: providerConfig }));
	mod.default({ on: () => {}, registerProvider: (_id, value) => { provider = value; }, registerTool: () => {} });
}
const model = () => provider.models[0];

let clock = 0;
/** A transcript head exactly as pi writes it: buildSystemPromptState's content + sections. */
const head = (opts) => { const state = buildSystemPromptState(opts); return { role: "system", ...state, timestamp: clock++ }; };
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const say = (text) => ({ role: "assistant", content: [{ type: "text", text }], api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/x",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: clock++ });

let launches;
beforeEach(() => {
	launches = [];
	__test.resetSharedSession();
	__test.setQuery(({ options }) => {
		launches.push(options);
		const sessionId = options.resume ?? `cc-${launches.length}`;
		const gen = (async function* () {
			yield { type: "system", subtype: "init", session_id: sessionId };
			yield { type: "result", subtype: "success", is_error: false, result: "ok" };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});
afterEach(() => {
	__test.setQuery(null);
	__test.resetSharedSession();
});

async function turn(sessionId, messages) {
	const output = await provider.streamSimple(model(), { messages, tools: [] }, { sessionId }).result();
	assert.equal(output.stopReason, "stop", output.errorMessage);
	return launches.at(-1);
}

describe("system prompt sent to Claude Code", () => {
	it("default: Claude Code's preset with pi's whole prompt as its append", async () => {
		activate({});
		const options = await turn("sp-default", [head({ cwd }), user("hello")]);
		assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code", append: buildSystemPrompt({ cwd }) });
	});

	it("systemPromptPreset false: pi's whole prompt as a plain string", async () => {
		activate({ systemPromptPreset: false });
		const options = await turn("sp-plain", [head({ cwd }), user("hello")]);
		assert.equal(options.systemPrompt, buildSystemPrompt({ cwd }));
	});

	it("a prompt no capture recorded (replaced by an extension) starts a query", async () => {
		activate({});
		const replaced = { role: "system", content: "Replaced by a context_with_system handler.", timestamp: clock++ };
		const options = await turn("sp-replaced", [replaced, user("hello")]);
		assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code", append: "Replaced by a context_with_system handler." });
	});

	it("a subagent's prompt wrapping its parent's is forwarded whole, wrapper included", async () => {
		activate({});
		const opts = { cwd, customPrompt: `${buildSystemPrompt({ cwd: "/tmp/parent" })}\n\n<sub_agent_context>be concise</sub_agent_context>` };
		const options = await turn("sp-child", [head(opts), user("hello")]);
		assert.equal(options.systemPrompt.append, buildSystemPrompt(opts));
		assert.match(options.systemPrompt.append, /<sub_agent_context>be concise<\/sub_agent_context>/);
	});

	it("pi's skills block reaches Claude Code as pi rendered it", async () => {
		activate({});
		const skill = { name: "browser", description: "Drive a headless browser.", filePath: "/skills/browser/SKILL.md", baseDir: "/skills/browser", sourceInfo: { path: "/skills/browser/SKILL.md", source: "local", scope: "project", origin: "top-level" }, disableModelInvocation: false };
		const opts = { cwd, skills: [skill], selectedTools: ["read", "bash"] };
		const options = await turn("sp-skills", [head(opts), user("hello")]);
		const block = formatSkillsForPrompt([skill], "read").trim();
		assert.ok(block.includes("/skills/browser/SKILL.md"), "the fixture renders a skills block");
		assert.ok(options.systemPrompt.append.includes(block), "the skills block is forwarded byte for byte");
		assert.equal(options.systemPrompt.append, buildSystemPrompt(opts));
	});

	// The fake SDK writes no session file: stand in for the CLI writing its own, so a
	// resume (the file untouched) tells apart from a rebuild (pi's history imported).
	const sessionFile = (id) => getSessionPath(id, process.cwd(), process.env.CLAUDE_CONFIG_DIR);
	const ccWritesSession = (id) => {
		const session = createSession({ sessionId: id, projectPath: process.cwd(), claudeDir: process.env.CLAUDE_CONFIG_DIR });
		session.importMessages([{ role: "user", content: "written by claude code" }]);
		session.save();
	};
	const resumedOwnFile = (id) => readFileSync(sessionFile(id), "utf8").includes("written by claude code");

	it("an unchanged prompt resumes the same Claude Code session", async () => {
		activate({});
		const u1 = user("one");
		await turn("sp-same", [head({ cwd }), u1]);
		ccWritesSession("cc-1");
		const options = await turn("sp-same", [head({ cwd }), u1, say("ok"), user("two")]);
		assert.equal(options.resume, "cc-1");
		assert.ok(resumedOwnFile("cc-1"), "CC's own file is resumed, not rebuilt");
	});

	it("a prompt changed on the next turn rebuilds the session from pi's history", async () => {
		activate({});
		const u1 = user("one");
		await turn("sp-change", [head({ cwd }), u1]);
		ccWritesSession("cc-1");
		const changed = { cwd, appendSystemPrompt: "A new rule from an extension." };
		const a1 = say("ok"), u2 = user("two");
		const options = await turn("sp-change", [head(changed), u1, a1, u2]);
		assert.equal(options.systemPrompt.append, buildSystemPrompt(changed), "the new prompt is the one sent");
		assert.ok(!resumedOwnFile(options.resume), "a resume would re-send the prompt CC recorded: pi's history is imported instead");
		assert.match(readFileSync(sessionFile(options.resume), "utf8"), /"one"/, "the rebuilt session holds pi's history");

		// The rebuilt session now carries the new prompt: the next turn resumes it.
		ccWritesSession(options.resume);
		const next = await turn("sp-change", [head(changed), u1, a1, u2, say("ok"), user("three")]);
		assert.equal(next.resume, options.resume);
		assert.ok(resumedOwnFile(next.resume), "an unchanged prompt after the rebuild resumes");
	});

	it("a changed systemPromptPreset setting rebuilds the session", async () => {
		activate({});
		const u1 = user("one");
		await turn("sp-preset", [head({ cwd }), u1]);
		ccWritesSession("cc-1");
		activate({ systemPromptPreset: false });
		const options = await turn("sp-preset", [head({ cwd }), u1, say("ok"), user("two")]);
		assert.equal(options.systemPrompt, buildSystemPrompt({ cwd }), "the same text, now without the preset");
		assert.ok(!resumedOwnFile(options.resume), "the preset change rebuilds rather than resumes");
	});
});

// One-off calls (cacheRetention "none": compaction, branch summary) send pi's
// summarization prompt alone, as upstream does, whatever systemPromptPreset says:
// Claude Code's agent preset has nothing to add to a one-turn, tool-less summary.
describe("system prompt on the one-off path", () => {
	for (const providerConfig of [{}, { systemPromptPreset: false }]) {
		it(`is pi's whole prompt as a plain string (${JSON.stringify(providerConfig)})`, async () => {
			activate(providerConfig);
			const summarizer = { role: "system", content: "You are a context summarization assistant.", sections: { cwd: "<cwd>\n/tmp/project\n</cwd>" }, timestamp: clock++ };
			const output = await provider.streamSimple(model(), { messages: [summarizer, user("Summarize.")], tools: [] }, { cacheRetention: "none" }).result();
			assert.equal(output.stopReason, "stop", output.errorMessage);
			assert.equal(launches.at(-1).systemPrompt, "You are a context summarization assistant.\n\n<cwd>\n/tmp/project\n</cwd>");
		});
	}
});
