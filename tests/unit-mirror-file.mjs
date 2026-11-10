/**
 * The mirror file pi's sessions record their Claude Code session in. It can hold the
 * text of an aborted prompt, and several pi windows can save the same session.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { saveMirror } from "../src/fork.js";

const mirrorDir = () => join(getAgentDir(), "claude-bridge-mirrors");

describe("saveMirror", () => {
	it("writes an owner-only file, via a temp name of this process", () => {
		saveMirror("pi-session-modes", { sessionId: "cc-1", cursor: 2, cwd: "/nowhere", fingerprint: "f", fingerprintLength: 2, abortedAt: 1, abortedPrompt: "secret prompt" });

		const file = join(mirrorDir(), "pi-session-modes.json");
		assert.equal(JSON.parse(readFileSync(file, "utf8")).abortedPrompt, "secret prompt");
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.equal(statSync(mirrorDir()).mode & 0o777, 0o700);
		assert.deepEqual(readdirSync(mirrorDir()).filter((name) => name.endsWith(".tmp")), []);
	});

	// A directory an older bridge created with the default mode is tightened too, or the
	// owner-only files would sit in a directory anyone can list.
	it("tightens a mirror directory an older version created world-readable", () => {
		mkdirSync(mirrorDir(), { recursive: true });
		chmodSync(mirrorDir(), 0o755);

		saveMirror("pi-session-old-dir", { sessionId: "cc-2", cursor: 2, cwd: "/nowhere", fingerprint: "f", fingerprintLength: 2 });

		assert.equal(statSync(mirrorDir()).mode & 0o777, 0o700);
	});
});
