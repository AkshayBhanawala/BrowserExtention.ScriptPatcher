/**
 * @typedef {Object} ExtensionConfig
 * @property {boolean} alertOnScriptPatched - Whether to show an alert when a script is patched
 * @property {Array<Rule>} rules - List of patching rules defined by the user
 *
 * @typedef {Object} Rule
 * @property {string} host - Host pattern to match against the document URL (supports wildcards)
 * @property {string} pattern - URL pattern to match against the script URL (supports wildcards)
 * @property {string} script - JavaScript code to run for patching the matched script
 */

/**
 * @type {ExtensionConfig}
 */
const DEFAULT_CONFIG = {
	alertOnScriptPatched: true,
	rules: []
};

/**
 * @type {ExtensionConfig}
 */
let runtimeConfig = normalizeConfig(DEFAULT_CONFIG);

/**
 * @type {Set<number>}
 */
const attachedTabIds = new Set();

/**
 * @type {Promise<void>|null}
 */
let offscreenReadyPromise = null;

loadConfig();

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== "sync") {
		return;
	}

	const nextConfig = { ...runtimeConfig };
	if (changes.alertOnScriptPatched) {
		nextConfig.alertOnScriptPatched = changes.alertOnScriptPatched.newValue;
	}
	if (changes.rules) {
		nextConfig.rules = changes.rules.newValue;
	}

	runtimeConfig = normalizeConfig(nextConfig);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
	if (changeInfo.status !== "loading" || !tab.url) {
		return;
	}

	try {
		const shouldAttach = hasMatchingHost(runtimeConfig.rules, tab.url);
		if (shouldAttach && !attachedTabIds.has(tabId)) {
			await attachDebugger(tabId);
			return;
		}

		if (!shouldAttach && attachedTabIds.has(tabId)) {
			await detachDebugger(tabId);
		}
	} catch (error) {
		console.error("Tab update handling failed.", error);
	}
});

chrome.tabs.onRemoved.addListener((tabId) => {
	if (!attachedTabIds.has(tabId)) {
		return;
	}

	detachDebugger(tabId).catch((error) => {
		console.error("Failed to detach debugger on tab removal.", error);
	});
});

chrome.debugger.onDetach.addListener((source) => {
	if (typeof source.tabId === "number") {
		attachedTabIds.delete(source.tabId);
	}
});

chrome.debugger.onEvent.addListener(async (source, method, params) => {
	if (method !== "Fetch.requestPaused" || typeof source.tabId !== "number") {
		return;
	}

	const requestUrl = params?.request?.url;
	if (!requestUrl || !isJavaScriptFile(requestUrl)) {
		await continueDebuggerRequest(source, params.requestId);
		return;
	}

	try {
		const tab = await getTab(source.tabId);
		const documentUrl = tab?.url || "";
		const matchingRules = getMatchingRules(runtimeConfig.rules, documentUrl, requestUrl);
		if (!matchingRules.length) {
			await continueDebuggerRequest(source, params.requestId);
			return;
		}

		const responseBody = await sendDebuggerCommand(source, "Fetch.getResponseBody", {
			requestId: params.requestId
		});
		let scriptBody = decodeDebuggerBody(responseBody);
		let modified = false;

		for (const rule of matchingRules) {
			try {
				const nextBody = await runRuleInSandbox(rule.script, scriptBody);
				if (typeof nextBody === "string" && nextBody !== scriptBody) {
					scriptBody = nextBody;
					modified = true;
				}
			} catch (error) {
				console.error(`Rule failed for ${requestUrl}`, error);
			}
		}

		if (modified) {
			scriptBody = prependPatchSuccessMessage(scriptBody, requestUrl, runtimeConfig.alertOnScriptPatched);
		}

		await sendDebuggerCommand(source, "Fetch.fulfillRequest", {
			requestId: params.requestId,
			responseCode: params.responseStatusCode || 200,
			responseHeaders: sanitizeResponseHeaders(params.responseHeaders),
			body: encodeDebuggerBody(scriptBody)
		});
	} catch (error) {
		console.error(`Failed to patch ${requestUrl}`, error);
		await continueDebuggerRequest(source, params.requestId);
	}
});

async function loadConfig() {
	const storedConfig = await new Promise((resolve) => {
		chrome.storage.sync.get(DEFAULT_CONFIG, resolve);
	});
	runtimeConfig = normalizeConfig(storedConfig);
}

function normalizeConfig(config) {
	return {
		alertOnScriptPatched: config?.alertOnScriptPatched !== false,
		rules: Array.isArray(config?.rules)
			? config.rules.map((rule) => normalizeRule(rule)).filter((rule) => rule.host && rule.script)
			: []
	};
}

function normalizeRule(rule) {
	return {
		host: String(rule?.host || "").trim(),
		pattern: String(rule?.pattern || "").trim(),
		script: String(rule?.script || "").trim()
	};
}

function hasMatchingHost(rules, url) {
	return rules.some((rule) => matchesHost(rule.host, url));
}

function getMatchingRules(rules, documentUrl, requestUrl) {
	return rules.filter((rule) => {
		return matchesHost(rule.host, documentUrl || requestUrl) && matchesPattern(rule.pattern, requestUrl);
	});
}

function matchesHost(filterValue, url) {
	const hostPattern = normalizeHostPattern(filterValue);
	if (!hostPattern) {
		return false;
	}

	try {
		const hostname = new URL(url).hostname.toLowerCase();
		const regex = patternStrToRegex(hostPattern);
		return Boolean(regex && regex.test(hostname));
	} catch (error) {
		return false;
	}
}

function normalizeHostPattern(filterValue) {
	const trimmed = String(filterValue || "").trim().toLowerCase();
	if (!trimmed) {
		return "";
	}

	try {
		return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
	} catch (error) {
		return trimmed.split("/")[0];
	}
}

function matchesPattern(pattern, requestUrl) {
	if (!isJavaScriptFile(requestUrl)) {
		return false;
	}

	if (!pattern) {
		return true;
	}

	const regex = patternStrToRegex(pattern.trim());
	return Boolean(regex && regex.test(requestUrl.toLowerCase()));
}

function patternStrToRegex(value) {
	if (!value) {
		return null;
	}

	// const escaped = value.replace(/([.+?^=!:${}()|[\]/\\])/g, "\\$1");
	// return new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);

	return new RegExp(value, 'gi');
}

function isJavaScriptFile(url) {
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".js");
	} catch (error) {
		return false;
	}
}

async function attachDebugger(tabId) {
	try {
		await sendDebuggerCommand({ tabId }, "Target.setAutoAttach", {
			autoAttach: false,
			waitForDebuggerOnStart: false,
			flatten: true
		});
	} catch (error) {
		// Ignore when not attached yet.
	}

	await new Promise((resolve, reject) => {
		chrome.debugger.attach({ tabId }, "1.3", () => {
			const lastError = chrome.runtime.lastError;
			if (lastError && !lastError.message.includes("Another debugger is already attached")) {
				reject(new Error(lastError.message));
				return;
			}
			resolve();
		});
	});

	attachedTabIds.add(tabId);
	await sendDebuggerCommand({ tabId }, "Fetch.enable", {
		patterns: [
			{
				urlPattern: "*",
				resourceType: "Script",
				requestStage: "Response"
			}
		]
	});
}

async function detachDebugger(tabId) {
	try {
		await sendDebuggerCommand({ tabId }, "Fetch.disable", {});
	} catch (error) {
		// Ignore disable errors during teardown.
	}

	await new Promise((resolve) => {
		chrome.debugger.detach({ tabId }, () => resolve());
	});
	attachedTabIds.delete(tabId);
}

function sendDebuggerCommand(target, method, params) {
	return new Promise((resolve, reject) => {
		chrome.debugger.sendCommand(target, method, params, (result) => {
			const lastError = chrome.runtime.lastError;
			if (lastError) {
				reject(new Error(lastError.message));
				return;
			}
			resolve(result);
		});
	});
}

async function continueDebuggerRequest(source, requestId) {
	try {
		await sendDebuggerCommand(source, "Fetch.continueRequest", { requestId });
	} catch (error) {
		console.error("Failed to continue debugger request.", error);
	}
}

function decodeDebuggerBody(bodyPayload) {
	if (!bodyPayload?.body) {
		return "";
	}

	if (!bodyPayload.base64Encoded) {
		return bodyPayload.body;
	}

	return decodeURIComponent(escape(atob(bodyPayload.body)));
}

function encodeDebuggerBody(scriptBody) {
	return btoa(unescape(encodeURIComponent(scriptBody)));
}

function sanitizeResponseHeaders(headers) {
	if (!Array.isArray(headers)) {
		return [];
	}

	return headers.filter((header) => {
		return header?.name && header.name.toLowerCase() !== "content-length";
	});
}

function prependPatchSuccessMessage(scriptBody, requestUrl, alertOnScriptPatched) {
	const successMessage = `✅ Script patched successfully!\nURL: ${requestUrl}`;
	scriptBody = `console.log(${JSON.stringify(successMessage)});\n${scriptBody}`;
	return alertOnScriptPatched ? `alert(${JSON.stringify(successMessage)});\n${scriptBody}` : scriptBody;
}

async function getTab(tabId) {
	return new Promise((resolve) => {
		chrome.tabs.get(tabId, (tab) => resolve(tab));
	});
}

async function runRuleInSandbox(scriptSource, scriptBody) {
	await ensureOffscreenRunner();
	const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const response = await new Promise((resolve, reject) => {
		chrome.runtime.sendMessage({
			type: "RUN_PATCH_RULE",
			payload: {
				requestId,
				scriptSource,
				scriptBody
			}
		}, (message) => {
			const lastError = chrome.runtime.lastError;
			if (lastError) {
				reject(new Error(lastError.message));
				return;
			}
			resolve(message);
		});
	});

	if (!response?.ok) {
		throw new Error(response?.error || "Sandbox execution failed.");
	}

	return response.result;
}

async function ensureOffscreenRunner() {
	if (offscreenReadyPromise) {
		return offscreenReadyPromise;
	}

	offscreenReadyPromise = (async () => {
		if (chrome.runtime.getContexts) {
			const contexts = await chrome.runtime.getContexts({
				contextTypes: ["OFFSCREEN_DOCUMENT"],
				documentUrls: [chrome.runtime.getURL("runnerHost.html")]
			});
			if (contexts.length > 0) {
				return;
			}
		}

		try {
			await chrome.offscreen.createDocument({
				url: "runnerHost.html",
				reasons: ["IFRAME_SCRIPTING"],
				justification: "Run user-defined patch functions inside a sandboxed iframe."
			});
		} catch (error) {
			if (!String(error?.message || error).includes("single offscreen document")) {
				throw error;
			}
		}
	})();

	return offscreenReadyPromise;
}
