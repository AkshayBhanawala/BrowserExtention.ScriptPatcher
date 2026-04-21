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
let configOptions = null;

/**
 * @type {Promise<any>}
 */
let sandboxFramePromise = null;

/**
 * @type {Map<any, any>}
 */
const pendingSandboxRuns = new Map();

getConfigOptions();
window.addEventListener("message", handleSandboxMessage);

browser.storage.onChanged.addListener(async (changes, area) => {
	if (area !== "sync") {
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
		const matchingRules = getMatchingRules(config.rules, details.documentUrl || details.originUrl || details.url, details.url);
		if (!matchingRules.length) {
			return;
		}

		const filter = browser.webRequest.filterResponseData(details.requestId);
		const decoder = new TextDecoder("utf-8");
		const encoder = new TextEncoder();
		let scriptBody = "";

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
						if (typeof nextBody === "string" && nextBody !== scriptBody) {
							scriptBody = nextBody;
							modified = true;
						}
					} catch (error) {
						console.error(`Rule failed for ${details.url}`, error);
					}
				}

				if (modified) {
					scriptBody = prependPatchSuccessMessage(scriptBody, details.url, config.alertOnScriptPatched);
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
		urls: ["<all_urls>"],
		types: ["script"]
	},
	["blocking"]
);

async function getConfigOptions() {
	if (configOptions) {
		return configOptions;
	}

	const storedConfig = await browser.storage.sync.get(DEFAULT_CONFIG);
	configOptions = normalizeConfig(storedConfig);
	return configOptions;
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

function prependPatchSuccessMessage(scriptBody, requestUrl, alertOnScriptPatched) {
	const successMessage = `✅ Script patched successfully!\nURL: ${requestUrl}`;
	scriptBody = `console.log(${JSON.stringify(successMessage)});\n${scriptBody}`;
	return alertOnScriptPatched ? `alert(${JSON.stringify(successMessage)});\n${scriptBody}` : scriptBody;
}

async function runRuleInSandbox(scriptSource, scriptBody, config) {
	const frame = await ensureSandboxFrame();
	const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

	return new Promise((resolve, reject) => {
		pendingSandboxRuns.set(requestId, {
			resolve,
			reject,
			source: frame.contentWindow
		});

		frame.contentWindow.postMessage({
			type: "RUN_PATCH_RULE",
			requestId,
			scriptSource,
			scriptBody
		}, "*");
	});
}

function handleSandboxMessage(event) {
	const data = event.data;
	if (!data || data.type !== "PATCH_RULE_RESULT") {
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

function ensureSandboxFrame() {
	if (sandboxFramePromise) {
		return sandboxFramePromise;
	}

	sandboxFramePromise = new Promise((resolve) => {
		const createFrame = () => {
			const frame = document.createElement("iframe");
			frame.setAttribute("sandbox", "allow-scripts");
			frame.src = browser.runtime.getURL("sandbox.html");
			frame.style.display = "none";
			frame.addEventListener("load", () => resolve(frame), { once: true });
			document.body.appendChild(frame);
		};

		if (document.body) {
			createFrame();
			return;
		}

		window.addEventListener("DOMContentLoaded", createFrame, { once: true });
	});

	return sandboxFramePromise;
}
