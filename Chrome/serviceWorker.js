/**
 * @typedef ExtensionConfig
 * @property {boolean} alertOnScriptPatched - Whether to alert on script patched.
 * @property {Array<Rule>} rules - Array of rules for patching scripts.

 * @typedef Rule
 * @property {string} host - The host to match against.
 * @property {string} pattern - The pattern to match against the request URL.
 * @property {string} script - The script to run in the sandbox.
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

/**
 * Loads the configuration from chrome.storage.sync.
 */
async function loadConfig() {
	const storedConfig = await new Promise((resolve) => {
		chrome.storage.sync.get(DEFAULT_CONFIG, resolve);
	});
	runtimeConfig = normalizeConfig(storedConfig);
}

/**
 * Normalizes the runtime configuration.
 * @param {ExtensionConfig} config - The configuration to normalize.
 * @returns {ExtensionConfig} - The normalized configuration.
 */
function normalizeConfig(config) {
	return {
		alertOnScriptPatched: config?.alertOnScriptPatched !== false,
		rules: Array.isArray(config?.rules)
			? config.rules.map((rule) => normalizeRule(rule)).filter((rule) => rule.host && rule.script)
			: []
	};
}

/**
 * Normalizes a rule.
 * @param {Rule} rule - The rule to normalize.
 * @returns {Rule} - The normalized rule.
 */
function normalizeRule(rule) {
	return {
		host: String(rule?.host || "").trim(),
		pattern: String(rule?.pattern || "").trim(),
		script: String(rule?.script || "").trim()
	};
}

/**
 * Checks if there is a matching host for the given rules and URL.
 * @param {Array<Rule>} rules - The rules to check against.
 * @param {string} url - The URL to check.
 * @returns {boolean} - True if there is a matching host, false otherwise.
 */
function hasMatchingHost(rules, url) {
	return rules.some((rule) => matchesHost(rule.host, url));
}

/**
 * Gets the matching rules for the given document and request URLs.
 * @param {Array<Rule>} rules - The rules to check against.
 * @param {string} documentUrl - The document URL.
 * @param {string} requestUrl - The request URL.
 * @returns {Array<Rule>} - The matching rules.
 */
function getMatchingRules(rules, documentUrl, requestUrl) {
	return rules.filter((rule) => {
		return matchesHost(rule.host, documentUrl || requestUrl) && matchesPattern(rule.pattern, requestUrl);
	});
}

/**
 * Checks if the given URL matches the host pattern.
 * @param {string} filterValue - The host pattern to match against.
 * @param {string} url - The URL to check.
 * @returns {boolean} - True if there is a match, false otherwise.
 */
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

/**
 * Normalizes the host pattern.
 * @param {string} filterValue - The host pattern to normalize.
 * @returns {string} - The normalized host pattern.
 */
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

/**
 * Checks if the given URL matches the pattern.
 * @param {string} pattern - The pattern to match against.
 * @param {string} requestUrl - The request URL.
 * @returns {boolean} - True if there is a match, false otherwise.
 */
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

/**
 * Converts a pattern string to a regular expression.
 * @param {string} value - The pattern string to convert.
 * @returns {RegExp|null} - The resulting regular expression, or null if the input is empty.
 */
function patternStrToRegex(value) {
	if (!value) {
		return null;
	}

	return new RegExp(value, 'gi');
}

/**
 * Checks if the given URL is a JavaScript file.
 * @param {string} url - The URL to check.
 * @returns {boolean} - True if the URL is a JavaScript file, false otherwise.
 */
function isJavaScriptFile(url) {
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".js");
	} catch (error) {
		return false;
	}
}

/**
 * Attaches the debugger to the given tab ID.
 * @param {number} tabId - The tab ID to attach the debugger to.
 */
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

	try {
		await chrome.debugger.attach({ tabId }, "1.3");
		const lastError = chrome.runtime.lastError;
		if (lastError && !lastError.message.includes("Another debugger is already attached")) {
			throw new Error(lastError.message);
		}
	} catch (error) {
		throw new Error(error);
	}

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

/**
 * Detaches the debugger from the given tab ID.
 * @param {number} tabId - The tab ID to detach the debugger from.
 */
async function detachDebugger(tabId) {
	try {
		await sendDebuggerCommand({ tabId }, "Fetch.disable", {});
	} catch (error) {
		// Ignore disable errors during teardown.
	}

	await chrome.debugger.detach({ tabId });
	attachedTabIds.delete(tabId);
}

/**
 * Sends a debugger command to the given target.
 * @param {chrome._debugger.DebuggerSession} target - The target to send the command to.
 * @param {string} method - The method of the command.
 * @param {Object} params - The parameters for the command.
 * @returns {Promise<Object>} - A promise that resolves with the result of the command.
 */
async function sendDebuggerCommand(target, method, params) {
	try {
		const result = await chrome.debugger.sendCommand(target, method, params);
		const lastError = chrome.runtime.lastError;
		if (lastError) {
			throw new Error(lastError.message);
		}
		return result;
	} catch (error) {
		throw error;
	}
}

/**
 * Continues the debugger request.
 * @param {chrome._debugger.DebuggerSession} source - The source of the event.
 * @param {string} requestId - The request ID to continue.
 */
async function continueDebuggerRequest(source, requestId) {
	try {
		await sendDebuggerCommand(source, "Fetch.continueRequest", { requestId });
	} catch (error) {
		console.error("Failed to continue debugger request.", error);
	}
}

/**
 * Decodes the body of a debugger response.
 * @param {Object} bodyPayload - The payload containing the body.
 * @returns {string} - The decoded body.
 */
function decodeDebuggerBody(bodyPayload) {
	if (!bodyPayload?.body) {
		return "";
	}

	if (!bodyPayload.base64Encoded) {
		return bodyPayload.body;
	}

	return decodeURIComponent(escape(atob(bodyPayload.body)));
}

/**
 * Encodes the body of a debugger request.
 * @param {string} scriptBody - The script body to encode.
 * @returns {string} - The encoded body.
 */
function encodeDebuggerBody(scriptBody) {
	return btoa(unescape(encodeURIComponent(scriptBody)));
}

/**
 * Sanitizes response headers by removing the content-length header.
 * @param {Array<Object>} headers - The array of headers.
 * @returns {Array<Object>} - The sanitized array of headers.
 */
function sanitizeResponseHeaders(headers) {
	if (!Array.isArray(headers)) {
		return [];
	}

	return headers.filter((header) => {
		return header?.name && header.name.toLowerCase() !== "content-length";
	});
}

/**
 * Prepends a patch success message to the script body.
 * @param {string} scriptBody - The script body to prepend the message to.
 * @param {string} requestUrl - The request URL.
 * @param {boolean} alertOnScriptPatched - Whether to alert on script patched.
 * @returns {string} - The modified script body with the success message prepended.
 */
function prependPatchSuccessMessage(scriptBody, requestUrl, alertOnScriptPatched) {
	const successMessage = `✅ Script patched successfully!\nURL: ${requestUrl}`;
	scriptBody = `console.log(${JSON.stringify(successMessage)});\n${scriptBody}`;
	return alertOnScriptPatched ? `alert(${JSON.stringify(successMessage)});\n${scriptBody}` : scriptBody;
}

/**
 * Gets the tab with the given tab ID.
 * @param {number} tabId - The tab ID to get.
 * @returns {Promise<Object>} - A promise that resolves with the tab object.
 */
async function getTab(tabId) {
	return new Promise((resolve) => {
		chrome.tabs.get(tabId, (tab) => resolve(tab));
	});
}

/**
 * Runs a rule in a sandbox.
 * @param {string} scriptSource - The source of the script to run.
 * @param {string} scriptBody - The body of the script to run.
 * @returns {Promise<string>} - A promise that resolves with the result of running the script.
 */
async function runRuleInSandbox(scriptSource, scriptBody) {
	await ensureOffscreenRunner();
	const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
	let response;
	try {
		response = await chrome.runtime.sendMessage({
			type: "RUN_PATCH_RULE",
			payload: {
				requestId,
				scriptSource,
				scriptBody
			}
		});
		const lastError = chrome.runtime.lastError;
		if (lastError) {
			throw new Error(lastError.message);
		}
	} catch (error) {
		throw error;
	}

	if (!response?.ok) {
		throw new Error(response?.error || "Sandbox execution failed.");
	}

	return response.result;
}

/**
 * Ensures the offscreen runner is ready.
 * @returns {Promise<void>} - A promise that resolves when the offscreen runner is ready.
 */
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
