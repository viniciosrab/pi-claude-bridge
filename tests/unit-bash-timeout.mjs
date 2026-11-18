import { it } from "node:test";
import assert from "node:assert/strict";
import { activateWithMockPi } from "./lib/mock-pi.mjs";

const onToolCall = activateWithMockPi().get("tool_call");
const run = (provider, toolName, input) => {
	onToolCall({ type: "tool_call", toolCallId: "t", toolName, input }, { model: { provider } });
	return input;
};

it("bash runs with a 120s default timeout only under the bridge's models", () => {
	assert.deepEqual(run("claude-bridge", "bash", { command: "ls" }), { command: "ls", timeout: 120 });
	assert.deepEqual(run("claude-bridge", "bash", { command: "ls", timeout: 5 }), { command: "ls", timeout: 5 });
	assert.deepEqual(run("claude-bridge", "read", { path: "a" }), { path: "a" });
	assert.deepEqual(run("anthropic", "bash", { command: "ls" }), { command: "ls" });
});

// Upstream #270: the schema Claude Code reads must say what an omitted timeout does.
it("the bash tool advertised to Claude Code says an omitted timeout is 120 seconds", async () => {
	const { __test } = await import("../src/index.ts");
	const piBash = {
		name: "bash",
		description: "Execute a bash command",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to execute" },
				timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
			},
			required: ["command"],
		},
	};
	const read = { name: "read", description: "Read", parameters: { type: "object", properties: { timeout: { type: "number", description: "no default timeout" } } } };
	const before = structuredClone(piBash);
	const { mcpTools } = __test.resolveMcpTools({ messages: [], tools: [piBash, read] });
	assert.equal(mcpTools[0].parameters.properties.timeout.description, "Timeout in seconds (optional; 120 when omitted)");
	assert.deepEqual(mcpTools[0].parameters.properties.command, piBash.parameters.properties.command);
	assert.equal(mcpTools[1], read, "other tools are advertised unchanged");
	assert.deepEqual(piBash, before, "pi's own tool definition is not modified");
	// A bash whose timeout says something else still learns the default.
	const other = structuredClone(piBash);
	other.parameters.properties.timeout.description = "Seconds before the command is killed";
	assert.equal(__test.resolveMcpTools({ messages: [], tools: [other] }).mcpTools[0].parameters.properties.timeout.description,
		"Seconds before the command is killed (120 when omitted)");
	// No timeout parameter: nothing to describe.
	const plain = { name: "bash", description: "x", parameters: { type: "object", properties: { command: { type: "string" } } } };
	assert.equal(__test.resolveMcpTools({ messages: [], tools: [plain] }).mcpTools[0], plain);
});
