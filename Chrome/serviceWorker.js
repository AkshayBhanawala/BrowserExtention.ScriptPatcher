let runtimeConfig = { alertOnScriptPatched: true, rules: [] };

function wildcardToRegex(str) {
	if (!str) return null;
	// escape regex special chars except *
	const escaped = str.replace(/([.+?^=!:${}()|[\]\/\\])/g, "\\$1");
	const regex = '^' + escaped.replace(/\*/g, '.*') + '$';
	return new RegExp(regex);
}

chrome.storage.sync.get({ alertOnScriptPatched: true, rules: [] }, (data) => {
	runtimeConfig.alertOnScriptPatched = data.alertOnScriptPatched;
	runtimeConfig.rules = data.rules || [];
	console.log('Loaded config:', runtimeConfig);
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === 'sync') {
		if (changes.alertOnScriptPatched) runtimeConfig.alertOnScriptPatched = changes.alertOnScriptPatched.newValue;
		if (changes.rules) runtimeConfig.rules = changes.rules.newValue || [];
		console.log('Config updated:', runtimeConfig);
	}
});

// Attach debugger when a tab loads a host that matches any rule
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (changeInfo.status !== 'loading' || !tab.url) return;
	try {
		const anyMatch = runtimeConfig.rules.some(r => r.host && tab.url.includes(r.host));
		if (!anyMatch) return;

		chrome.debugger.attach({ tabId }, '1.3', () => {
			if (chrome.runtime.lastError) return;
			// Enable fetch interception for scripts (catch all script requests and filter later)
			chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
				patterns: [{ urlPattern: '*', resourceType: 'Script' }]
			});
		});
	} catch (e) {
		console.error(e);
	}
});

chrome.debugger.onEvent.addListener(async (source, method, params) => {
	if (method !== 'Fetch.requestPaused') return;
	const { requestId, request } = params;

	try {
		const response = await fetch(request.url);
		let scriptContent = await response.text();
		let modified = false;

		for (const rule of runtimeConfig.rules || []) {
			if (!rule.host || !rule.script) continue;
			if (!request.url.includes(rule.host)) continue;

			// pattern check
			let matches = true;
			if (rule.pattern) {
				const reg = wildcardToRegex(rule.pattern);
				matches = reg ? reg.test(request.url) : true;
			}

			if (!matches) continue;

			// run user-supplied function
			try {
				const userFunc = eval('(' + rule.script + ')');
				if (typeof userFunc === 'function') {
					const result = userFunc(scriptContent);
					if (typeof result === 'string') {
						scriptContent = result;
						modified = true;
					}
				}
			} catch (e) {
				console.error('Error executing user script for', request.url, e);
			}
		}

		if (modified && runtimeConfig.alertOnScriptPatched) {
			const successMessage = `✅ Script patched successfully!\\r\\nURL: ${request.url}`;
			scriptContent = `alert("${successMessage}");` + scriptContent;
			console.log(successMessage.replace(/\\r\\n/g, '\r\n'));
		}

		chrome.debugger.sendCommand(source, 'Fetch.fulfillRequest', {
			requestId: requestId,
			responseCode: 200,
			body: btoa(unescape(encodeURIComponent(scriptContent)))
		});
	} catch (err) {
		console.error('Fetch/modify error', err);
		// if error, just continue the request without modification
		chrome.debugger.sendCommand(source, 'Fetch.continueRequest', { requestId: requestId });
	}
});