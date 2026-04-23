/**
 * @typedef StaticResources
 * @property {string} webpageNotificationScriptStr - The script string to inject in patched scripts for showing webpage notification.
 *
 * @typedef ExtensionConfig
 * @property {boolean} enabled - Whether the extension is enabled globally.
 * @property {Array<Rule>} rules - Array of rules for patching scripts.

 * @typedef Rule
 * @property {boolean} enabled - Whether this rule is enabled.
 * @property {string} name - The user-facing name for the rule.
 * @property {string} host - The host to match against.
 * @property {string} pattern - The pattern to match against the request URL.
 * @property {boolean} webpageNotificationOnScriptPatched - Whether to inject the webpage notification when this rule patches a script.
 * @property {boolean} alertOnScriptPatched - Whether to alert when this rule patches a script.
 * @property {string} script - The script to run in the sandbox.
 */

/**
 * @type {StaticResources}
 */
const STATIC_RESOURCES = {
	WebpageNotificationOnScript: '', // THIS GETS OVERRIDDEN IN LOAD
};

/**
 * @type {ExtensionConfig}
 */
const DEFAULT_CONFIG = {
	enabled: true,
	rules: [],
};

/**
 * @type {ExtensionConfig}
 */
let configOptions = null;

/**
 * @type {Promise<any>}
 */
let sandboxFramePromise = null;

/**
 * @type {Map<any, any>}
 */
const pendingSandboxRuns = new Map();

loadWebpageNotificationScriptStr();
getConfigOptions();

/**
 * Loads the webpage notification helper script once.
 * @returns {void}
 */
async function loadWebpageNotificationScriptStr() {
	if (!STATIC_RESOURCES.webpageNotificationScriptStr) {
		try {
			const response = await fetch(chrome.runtime.getURL('assets/js/WebpageNotification.js'));
			if (!response.ok) {
				throw new Error(`Failed to load webpage notification script: ${response.status}`);
			}
			STATIC_RESOURCES.webpageNotificationScriptStr = await response.text();
			console.log('Loaded WebpageNotification.js:', STATIC_RESOURCES.webpageNotificationScriptStr);
		} catch (error) {
			console.error('Unable to load WebpageNotification.js.', error);
		}
	}
}

/**
 * Initializes the configuration options and loads the default config.
 * @returns {Promise<ExtensionConfig>} The loaded configuration options.
 */
async function getConfigOptions() {
	if (configOptions) {
		return configOptions;
	}

	const storedConfig = await browser.storage.sync.get(DEFAULT_CONFIG);
	configOptions = normalizeConfig(storedConfig);
	return configOptions;
}

window.addEventListener('message', handleSandboxMessage);

browser.storage.onChanged.addListener(async (changes, area) => {
	if (area !== 'sync') {
		return;
	}

	const currentConfig = await getConfigOptions();
	const nextConfig = { ...currentConfig };
	for (const [key, change] of Object.entries(changes)) {
		nextConfig[key] = change.newValue;
	}

	configOptions = normalizeConfig(nextConfig);
});

browser.webRequest.onBeforeRequest.addListener(
	async (details) => {
		if (!details.url || !isJavaScriptFile(details.url)) {
			return;
		}

		const config = await getConfigOptions();
		if (!config.enabled) {
			return;
		}

		const matchingRules = getMatchingRules(
			config.rules,
			details.documentUrl || details.originUrl || details.url,
			details.url,
		);
		if (!matchingRules.length) {
			return;
		}

		const filter = browser.webRequest.filterResponseData(details.requestId);
		const decoder = new TextDecoder('utf-8');
		const encoder = new TextEncoder();
		let scriptBody = '';

		filter.ondata = (event) => {
			scriptBody += decoder.decode(event.data, { stream: true });
		};

		filter.onstop = async () => {
			try {
				scriptBody += decoder.decode();
				let modified = false;

				for (const rule of matchingRules) {
					try {
						const nextBody = await runRuleInSandbox(rule.script, scriptBody, config);
						if (typeof nextBody === 'string' && nextBody !== scriptBody) {
							scriptBody = nextBody;
							modified = true;
						}
					} catch (error) {
						console.error(`Rule failed for ${details.url}`, error);
					}
				}

				if (modified) {
					const shouldShowWebpageNotification = matchingRules.some((rule) => rule.webpageNotificationOnScriptPatched);
					const shouldAlert = matchingRules.some((rule) => rule.alertOnScriptPatched);
					scriptBody = prependPatchSuccessMessage(scriptBody, details.url, shouldShowWebpageNotification, shouldAlert);
				}

				filter.write(encoder.encode(scriptBody));
			} catch (error) {
				console.error(`Failed to patch ${details.url}`, error);
				filter.write(encoder.encode(scriptBody));
			} finally {
				filter.close();
			}
		};

		return {};
	},
	{
		urls: ['<all_urls>'],
		types: ['script'],
	},
	['blocking'],
);

browser.webRequest.onBeforeSendHeaders.addListener(
	async (details) => {
		const config = await getConfigOptions();
		if (!config.enabled || !hasMatchingHost(config.rules, details.originUrl || details.documentUrl || details.url)) {
			return;
		}

		const requestHeaders = Array.isArray(details.requestHeaders) ? [...details.requestHeaders] : [];
		upsertHeader(requestHeaders, 'Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
		upsertHeader(requestHeaders, 'Pragma', 'no-cache');

		return { requestHeaders };
	},
	{
		urls: ['<all_urls>'],
	},
	['blocking', 'requestHeaders'],
);

browser.webRequest.onHeadersReceived.addListener(
	async (details) => {
		const config = await getConfigOptions();
		if (!config.enabled || !hasMatchingHost(config.rules, details.originUrl || details.documentUrl || details.url)) {
			return;
		}

		const responseHeaders = Array.isArray(details.responseHeaders) ? [...details.responseHeaders] : [];
		upsertHeader(responseHeaders, 'Cache-Control', 'no-cache, no-store, max-age=0, must-revalidate');
		upsertHeader(responseHeaders, 'Pragma', 'no-cache');
		upsertHeader(responseHeaders, 'Expires', '0');

		return { responseHeaders };
	},
	{
		urls: ['<all_urls>'],
	},
	['blocking', 'responseHeaders'],
);

/**
 * Normalizes the configuration options, ensuring they are valid and well-structured.
 * @param {ExtensionConfig} config - The configuration to normalize.
 * @returns {ExtensionConfig} The normalized configuration.
 */
function normalizeConfig(config) {
	return {
		enabled: config?.enabled !== false,
		rules: Array.isArray(config?.rules)
			? config.rules.map((rule, index) => normalizeRule(rule, index)).filter((rule) => rule.host && rule.script)
			: [],
	};
}

/**
 * Normalizes a single rule, ensuring it has valid properties.
 * @param {Rule} rule - The rule to normalize.
 * @param {number} [index=0] - The index of the rule.
 * @returns {Rule} The normalized rule.
 */
function normalizeRule(rule, index = 0) {
	return {
		enabled: rule?.enabled !== false,
		name: String(rule?.name || '').trim() || `JS-Rule-${index + 1}`,
		host: String(rule?.host || '').trim(),
		pattern: String(rule?.pattern || '').trim(),
		webpageNotificationOnScriptPatched: rule?.webpageNotificationOnScriptPatched === true,
		alertOnScriptPatched: rule?.alertOnScriptPatched || false,
		script: String(rule?.script || '').trim(),
	};
}

function hasMatchingHost(rules, url) {
	return rules.some((rule) => rule.enabled && matchesHost(rule.host, url));
}

/**
 * Retrieves matching rules for a given URL and document URL.
 * @param {Array<Rule>} rules - The list of rules to check against.
 * @param {string} documentUrl - The document URL.
 * @param {string} requestUrl - The request URL.
 * @returns {Array<Rule>} An array of matching rules.
 */
function getMatchingRules(rules, documentUrl, requestUrl) {
	return rules.filter((rule) => {
		return (
			rule.enabled && matchesHost(rule.host, documentUrl || requestUrl) && matchesPattern(rule.pattern, requestUrl)
		);
	});
}

/**
 * Checks if the hostname of a URL matches a given host pattern.
 * @param {string} filterValue - The host pattern to match against.
 * @param {string} url - The URL to check.
 * @returns {boolean} True if the host matches the pattern, false otherwise.
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
	const trimmed = String(filterValue || '')
		.trim()
		.toLowerCase();
	if (!trimmed) {
		return '';
	}

	try {
		return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
	} catch (error) {
		return trimmed.split('/')[0];
	}
}

/**
 * Checks if a request URL matches a given pattern.
 * @param {string} pattern - The pattern to match against.
 * @param {string} requestUrl - The request URL to check.
 * @returns {boolean} True if the URL matches the pattern, false otherwise.
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
 * @returns {RegExp} The resulting regular expression.
 */
function patternStrToRegex(value) {
	if (!value) {
		return null;
	}

	return new RegExp(value, 'gi');
}

/**
 * Determines if a URL is a JavaScript file.
 * @param {string} url - The URL to check.
 * @returns {boolean} True if the URL is a JavaScript file, false otherwise.
 */
function isJavaScriptFile(url) {
	try {
		return new URL(url).pathname.toLowerCase().endsWith('.js');
	} catch (error) {
		return false;
	}
}

/**
 * Prepends a success message to the script body and optionally shows an alert.
 * @param {string} scriptBody - The original script body.
 * @param {string} requestUrl - The URL of the script being patched.
 * @param {boolean} webpageNotificationOnScriptPatched - Whether to inject the webpage notification.
 * @param {boolean} alertOnScriptPatched - Whether to show an alert.
 * @returns {string} The modified script body with a success message.
 */
function prependPatchSuccessMessage(scriptBody, requestUrl, webpageNotificationOnScriptPatched, alertOnScriptPatched) {
	const baseMessage = `✅ Script patched successfully!`;
	const successConsoleMessage = `${baseMessage}\nURL: ${requestUrl}`;
	const successHtmlNotification = `${baseMessage}<br />URL: ${escapeHtml(requestUrl)}`;
	scriptBody = `console.log(${JSON.stringify(successConsoleMessage)});\n${scriptBody}`;

	if (webpageNotificationOnScriptPatched) {
		if (STATIC_RESOURCES.webpageNotificationScriptStr) {
			scriptBody = `${STATIC_RESOURCES.webpageNotificationScriptStr};\nwindow.scriptPatcherShowWebpageNotification?.(${JSON.stringify(successHtmlNotification)});\n${scriptBody}`;
		}
	}

	if (alertOnScriptPatched) {
		scriptBody = `alert(${JSON.stringify(successConsoleMessage)});\n${scriptBody}`;
	}

	return scriptBody;
}

/**
 * Get the WebpageNotification script as a string.
 * @returns {string}
 */
function getWebpageNotificationScript() {
	return STATIC_RESOURCES.webpageNotificationScriptStr;
}

/**
 * Escapes HTML-sensitive characters in a string.
 * @param {string} value - The string to escape.
 * @returns {string} The escaped string.
 */
function escapeHtml(value) {
	return String(value || '').replace(/[&<>"']/g, (character) => {
		return (
			{
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&#39;',
			}[character] || character
		);
	});
}

function upsertHeader(headers, name, value) {
	const existingHeader = headers.find((header) => header?.name?.toLowerCase() === name.toLowerCase());
	if (existingHeader) {
		existingHeader.value = value;
		return;
	}

	headers.push({ name, value });
}

/**
 * Runs a patch rule in a sandboxed environment.
 * @param {string} scriptSource - The source code of the patch rule.
 * @param {string} scriptBody - The body of the script to be patched.
 * @param {ExtensionConfig} config - The current configuration options.
 * @returns {Promise<string>} A promise resolving to the modified script body.
 */
async function runRuleInSandbox(scriptSource, scriptBody, config) {
	const frame = await ensureSandboxFrame();
	const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

	return new Promise((resolve, reject) => {
		pendingSandboxRuns.set(requestId, {
			resolve,
			reject,
			source: frame.contentWindow,
		});

		frame.contentWindow.postMessage(
			{
				type: 'RUN_PATCH_RULE',
				requestId,
				scriptSource,
				scriptBody,
			},
			'*',
		);
	});
}

/**
 * Handles messages from the sandbox frame.
 * @param {MessageEvent} event - The message event received from the sandbox.
 */
function handleSandboxMessage(event) {
	const data = event.data;
	if (!data || data.type !== 'PATCH_RULE_RESULT') {
		return;
	}

	const pending = pendingSandboxRuns.get(data.requestId);
	if (!pending || event.source !== pending.source) {
		return;
	}

	pendingSandboxRuns.delete(data.requestId);
	if (data.error) {
		pending.reject(new Error(data.error));
		return;
	}

	pending.resolve(data.result);
}

/**
 * Ensures the existence of a sandbox frame and returns it.
 * @returns {Promise<HTMLIFrameElement>} A promise resolving to the sandbox iframe.
 */
function ensureSandboxFrame() {
	if (sandboxFramePromise) {
		return sandboxFramePromise;
	}

	sandboxFramePromise = new Promise((resolve) => {
		const createFrame = () => {
			const frame = document.createElement('iframe');
			frame.setAttribute('sandbox', 'allow-scripts');
			frame.src = browser.runtime.getURL('sandbox.html');
			frame.style.display = 'none';
			frame.addEventListener('load', () => resolve(frame), { once: true });
			document.body.appendChild(frame);
		};

		if (document.body) {
			createFrame();
			return;
		}

		window.addEventListener('DOMContentLoaded', createFrame, { once: true });
	});

	return sandboxFramePromise;
}
