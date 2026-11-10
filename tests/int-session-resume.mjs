#!/usr/bin/env node
// Context continuity test for pi-claude-bridge provider.
// Verifies that switching away from the provider and back correctly
// preserves conversation context (all messages are flattened into
// each query, so "missed" messages are automatically included).
//
// Requires: pi CLI, Claude Code (for Agent SDK subprocess).
// Requires: CLAUDE_BRIDGE_TESTING_ALT_PROVIDER (e.g. "minimax")
// Requires: CLAUDE_BRIDGE_TESTING_ALT_MODEL (e.g. "MiniMax-M2.7-highspeed")

console.log("=== session-resume-test.mjs ===");

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRpcHarness, requireEnv } from "./lib/rpc-harness.mjs";

const OTHER_PROVIDER = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_PROVIDER");
const OTHER_MODEL = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_MODEL");

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";

// Random words to avoid Claude memorizing test values across runs
const WORD_A = `alpha${Math.random().toString(36).slice(2, 6)}`;
const WORD_B = `beta${Math.random().toString(36).slice(2, 6)}`;
const WORD_C = `gamma${Math.random().toString(36).slice(2, 6)}`;

const TEST_CWD_PREFIX = join(tmpdir(), "pi-claude-bridge-session-resume-");
const TEST_CWD = mkdtempSync(TEST_CWD_PREFIX);

// Use harness but with custom args - start on non-provider model
const harness = createRpcHarness({
	name: "session-resume",
	args: ["--model", `${OTHER_PROVIDER}/${OTHER_MODEL}`],
	cwd: TEST_CWD,
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, send, addListener, collectText, DEBUG_LOG, RPC_LOG } = harness;

// Resolves on the next agent_end.
function waitForIdle(timeout = TIMEOUT) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timeout waiting for idle")), timeout);
		const remove = addListener((msg) => {
			if (msg.type === "agent_end") {
				clearTimeout(timer);
				remove();
				resolve(msg);
			}
		});
	});
}

async function promptAndWait(message) {
	const collector = collectText();
	await send({ type: "prompt", message });
	await waitForIdle();
	return collector.stop();
}

// Start pi
await startAndWait();

try {
  // Turn 1: Non-provider prompt — establishes context before our provider is used
  console.log("Turn 1: Non-provider prompt (establish context)...");
  const text1 = await promptAndWait(`The first word is '${WORD_A}'. Acknowledge and be very brief.`);
  if (!text1) throw new Error("Turn 1 produced no text");
  console.log(`  Response: ${text1.slice(0, 80)}`);

  // Switch to provider — first provider turn with prior history (Case 2)
  const [bridgeProvider, bridgeModelId] = BRIDGE_MODEL.split("/");
  console.log(`Switching to ${BRIDGE_MODEL}...`);
  await send({ type: "set_model", provider: bridgeProvider, modelId: bridgeModelId });


  // Turn 2: First provider turn — should see WORD_A from prior non-provider history
  console.log("Turn 2: First provider turn with prior history (Case 2)...");
  const text2 = await promptAndWait(
    `The second word is '${WORD_B}'. Also, what was the first word? Reply with both words separated by a comma.`
  );
  console.log(`  Response: ${text2.slice(0, 80)}`);
  const lower2 = text2.toLowerCase();
  if (!lower2.includes(WORD_A)) throw new Error(`Turn 2 response missing '${WORD_A}': ${text2}`);
  if (!lower2.includes(WORD_B)) throw new Error(`Turn 2 response missing '${WORD_B}': ${text2}`);

  console.log(`Switching to ${OTHER_PROVIDER}/${OTHER_MODEL}...`);
  await send({ type: "set_model", provider: OTHER_PROVIDER, modelId: OTHER_MODEL });

  // Turn 3: Non-provider prompt — adds context that provider must see on switch-back
  console.log("Turn 3: Non-provider prompt (creates missed messages)...");
  const text3 = await promptAndWait(`The third word is '${WORD_C}'. Acknowledge and be very brief.`);
  if (!text3) throw new Error("Turn 3 produced no text");
  console.log(`  Response: ${text3.slice(0, 80)}`);

  // Switch back to provider — context includes all prior turns (Case 4)
  console.log(`Switching back to ${BRIDGE_MODEL}...`);
  await send({ type: "set_model", provider: bridgeProvider, modelId: bridgeModelId });


  // Turn 4: Provider resumes with missed messages (Case 4)
  console.log("Turn 4: Provider resume with missed messages (Case 4)...");
  const text4 = await promptAndWait(
    "What were all three words? Reply with just the three words separated by commas."
  );
  console.log(`  Response: ${text4.slice(0, 80)}`);
  const lower4 = text4.toLowerCase();
  if (!lower4.includes(WORD_A)) throw new Error(`Turn 4 response missing '${WORD_A}': ${text4}`);
  if (!lower4.includes(WORD_B)) throw new Error(`Turn 4 response missing '${WORD_B}': ${text4}`);
  if (!lower4.includes(WORD_C)) throw new Error(`Turn 4 response missing '${WORD_C}': ${text4}`);

  // Turn 5: Abort mid-stream — session should be invalidated, next turn should recover
  console.log("Turn 5: Abort mid-stream (session recovery)...");
  await send({ type: "prompt", message: "Write a detailed 500-word essay about the history of timekeeping." });
  // Set up idle listener before abort so we don't miss agent_end
  const idle5 = waitForIdle();
  await new Promise((r) => setTimeout(r, 2000));
  await send({ type: "abort" });
  await idle5;


  // Turn 6: Provider turn after abort — should NOT get "conversation not found"
  console.log("Turn 6: Provider turn after abort (should recover)...");
  const text6 = await promptAndWait(
    "What were all three words? Reply with just the three words separated by commas."
  );
  console.log(`  Response: ${text6.slice(0, 80)}`);
  const lower6 = text6.toLowerCase();
  if (!lower6.includes(WORD_A)) throw new Error(`Turn 6 response missing '${WORD_A}': ${text6}`);
  if (!lower6.includes(WORD_B)) throw new Error(`Turn 6 response missing '${WORD_B}': ${text6}`);
  if (!lower6.includes(WORD_C)) throw new Error(`Turn 6 response missing '${WORD_C}': ${text6}`);

  // sessionId stability: normal rebuilds (Case 2 → Case 4) keep the session id. After
  // the abort (Turn 5) the bridge recovers one of two ways (postAbortSync in src/fork.ts):
  // it resumes the session the killed CLI finished, keeping the prompt cache, or, when
  // the abort landed before Claude Code saved the prompt, it rebuilds on a fresh id.
  // Either is correct; exactly one of them must happen, and only a rebuild adds an id.
  const debugLog = readFileSync(DEBUG_LOG, "utf8");
  const sessionIds = new Set();
  let resumed = 0;
  let rotated = 0;
  for (const match of debugLog.matchAll(/syncResult: path=(reuse|rebuild) sessionId=([a-f0-9-]+)([^\n]*)/g)) {
    sessionIds.add(match[2]);
    if (match[1] === "reuse" && / post-abort$/.test(match[3])) resumed++;
    if (match[1] === "rebuild" && / rotated-post-abort$/.test(match[3])) rotated++;
  }
  if (sessionIds.size === 0) throw new Error("no syncResult markers found in debug log");
  if (resumed + rotated !== 1) throw new Error(`expected exactly 1 post-abort recovery, got ${resumed} resumes and ${rotated} rebuilds`);
  if (sessionIds.size !== 1 + rotated) throw new Error(`expected ${1 + rotated} sessionIds, got ${sessionIds.size}: ${[...sessionIds].join(", ")}`);
  console.log(`  sessionIds observed: ${sessionIds.size}, recovered after the abort by ${resumed ? "resuming" : "rebuilding"}`);

  console.log("PASS");
} catch (e) {
  process.exitCode = 1;
  console.log(`FAIL: ${e.message}\n${e.stack}`);
  console.log(`  RPC log:    ${RPC_LOG}`);
  console.log(`  Debug log:  ${DEBUG_LOG}`);
  console.log(`  CC CLI:     ${join(dirname(DEBUG_LOG), "cc-cli-logs")} (look for *-provider-*.log near the failing turn)`);
} finally {
  await stop();
  if (TEST_CWD.startsWith(TEST_CWD_PREFIX) && TEST_CWD.length > TEST_CWD_PREFIX.length) {
    rmSync(TEST_CWD, { recursive: true, force: true });
  }
}
