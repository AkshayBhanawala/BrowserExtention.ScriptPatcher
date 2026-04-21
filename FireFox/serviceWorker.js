let configOptions = null;

function wildcardToRegex(str) {
	if (!str) return null;
	const escaped = str.replace(/([.+?^=!:${}()|[\]\\/\\\\])/g, "\\$1");
	const regex = '^' + escaped.replace(/\*/g, '.*') + '$';
	return new RegExp(regex);
}

// Function to load config
async function getConfigOptions() {
	if (configOptions) {
		return configOptions;
	}

	configOptions = await browser.storage.sync.get({
		alertOnScriptPatched: true,
		rules: []
	});
	console.log('`configOptions` Loaded :', configOptions);
	return configOptions;
}

getConfigOptions();

browser.storage.onChanged.addListener(async (changes, area) => {
	if ((area === 'sync')) {
		const config = await getConfigOptions();
		for (let [key, { newValue }] of Object.entries(changes)) {
			if (config) config[key] = newValue;
		}
		console.log('Updated `config`:', config);
	}
});


browser.webRequest.onBeforeRequest.addListener(
	async (details) => {
		// Only target JS files
		if (!details.url || !details.url.includes('.js')) return;

		const config = await getConfigOptions();
		const rules = config.rules || [];

		// determine if any rule matches host
		const matchingRules = rules.filter(r => r.host && details.url.includes(r.host));
		if (!matchingRules.length) return;

		let filter = browser.webRequest.filterResponseData(details.requestId);
		let decoder = new TextDecoder("utf-8");
		let encoder = new TextEncoder();

		let scriptContent = "";
		filter.ondata = (event) => {
			scriptContent += decoder.decode(event.data, { stream: true });
		};

		filter.onstop = (event) => {
			let modified = false;
			for (const rule of matchingRules) {
				// pattern check
				if (rule.pattern) {
					const reg = wildcardToRegex(rule.pattern);
					if (reg && !reg.test(details.url)) continue;
				}

				// execute user script
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
					console.error('Error executing user script for', details.url, e);
				}
			}

			if (modified && config?.alertOnScriptPatched) {
				const successMessage = `✅ Script patched successfully!\\r\\nURL: ${details.url}`;
				scriptContent = `alert("${successMessage}");` + scriptContent;
				console.log(successMessage.replace(/\\r\\n/g, '\r\n'));
			}

			filter.write(encoder.encode(scriptContent));
			filter.close();
		};

		return {};
	},
	{
		urls: ["<all_urls>"],
		types: ["script"]
	},
	["blocking"]
);