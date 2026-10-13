// Fork-only additions of @viniciosrab/pi-claude-bridge.
//
// The fork's npm mirror cherry-picks its fix commits onto every upstream release, and
// any upstream edit next to a line those commits touch stops the release. So the fork's
// code lives here, in a file upstream never edits, and src/index.ts only carries
// one-line hooks into it: one import and one call per feature. Keep it that way: do not
// edit upstream lines (shared imports, the Config interface, upstream tests or README),
// add a hook line next to them instead.

/** Provider settings only the fork reads, from `provider` in claude-bridge.json. */
export interface ForkProviderSettings {
	// Set to false to stop the provider's Claude Code subprocess from loading
	// user/project/local settings (hooks, plugins, env, apiKeyHelper).
	loadClaudeSettings?: boolean;
}

// Config["provider"] does not declare the fork's keys, but loadConfig keeps every key
// of the JSON, so they are read through this cast rather than by editing config.ts.
function forkSettings(provider: object | undefined): ForkProviderSettings {
	return (provider ?? {}) as ForkProviderSettings;
}

/** Provider-path `settingSources` override. Absent keeps the SDK default (all sources);
 *  `loadClaudeSettings: false` passes an empty list so no settings files are loaded. */
export function providerSettingSourcesOption(provider?: object): { settingSources?: [] } {
	return forkSettings(provider).loadClaudeSettings === false ? { settingSources: [] } : {};
}
