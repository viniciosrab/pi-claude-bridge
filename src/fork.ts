// Fork-only additions of @viniciosrab/pi-claude-bridge.
//
// The fork's npm mirror cherry-picks its fix commits onto every upstream release, and
// any upstream edit next to a line those commits touch stops the release. So the fork's
// code lives here, in a file upstream never edits, and src/index.ts only carries
// one-line hooks into it: one import and one call per feature. Keep it that way: do not
// edit upstream lines (shared imports, the Config interface, upstream tests or README),
// add a hook line next to them instead.

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/** Provider settings only the fork reads, from `provider` in claude-bridge.json. */
export interface ForkProviderSettings {
	// Set to false to stop the provider's Claude Code subprocess from loading
	// user/project/local settings (hooks, plugins, env, apiKeyHelper).
	loadClaudeSettings?: boolean;
	// Set to false to hide the Claude rate-limit notices (usage warnings and
	// "rate limit reached") shown in pi. Failures are still named as rate limits.
	rateLimitWarnings?: boolean;
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

/** Whether to show the Claude rate-limit notices in pi. Absent keeps them on;
 *  `rateLimitWarnings: false` hides them. */
export function rateLimitNoticesEnabled(provider?: object): boolean {
	return forkSettings(provider).rateLimitWarnings !== false;
}

// Upstream's rate-limit notices all read "Claude ... rate limit ..." ("Claude rate limit
// warning: 80% used", "Claude subscription rate limit reached"). Filtering on the text
// keeps the hook out of consumeQuery, which upstream rewrites often;
// unit-rate-limit-warnings.mjs fails if the wording drifts past this pattern.
const RATE_LIMIT_NOTICE = /^Claude\b.*\brate limit/i;

/** Wrap pi's UI so its rate-limit notices are dropped while `rateLimitWarnings` is
 *  false. Settings are read per notice because config reloads after the UI is set. */
export function withRateLimitNoticeFilter(
	ui: ExtensionUIContext | null,
	getProvider: () => object | undefined,
): ExtensionUIContext | null {
	if (!ui) return ui;
	return new Proxy(ui, {
		get(target, prop) {
			if (prop === "notify") {
				return (message: string, type?: Parameters<ExtensionUIContext["notify"]>[1]) => {
					if (RATE_LIMIT_NOTICE.test(message) && !rateLimitNoticesEnabled(getProvider())) return;
					target.notify(message, type);
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
