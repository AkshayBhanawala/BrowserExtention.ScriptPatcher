const isChrome = typeof chrome !== 'undefined' && typeof browser === 'undefined';
const api = isChrome ? chrome : browser;
const usesPromiseStorage = !isChrome;

let popupNewTab = false;

api.tabs.getCurrent((tab) => {
	if (api.runtime.lastError || !tab) {
		console.log('Opened in a popup (embedded)');
	} else {
		popupNewTab = true;
		console.log('Opened in a new tab');
	}
});

const DEFAULT_RULE_SCRIPT = `/**
 * @param {string} scriptBody Original script body content
 * @returns {string} Modified script body content
 */
(scriptBody) => {
	if (scriptBody.includes('search-string')) {
		// Example: Replace 'search-string' with 'replace-string'
		return scriptBody.replaceAll('search-string', 'replace-string');
	}
	return scriptBody;
}`;

const DEFAULT_CONFIG = {
	alertOnScriptPatched: true,
	rules: [],
};

document.addEventListener('DOMContentLoaded', () => {
	initOptions().catch((error) => {
		console.error('Failed to initialize options UI.', error);
	});
});

async function initOptions() {
	const addBtn = document.getElementById('add-rule');
	const exportBtn = document.getElementById('export-config');
	const importBtn = document.getElementById('import-config');
	const importInput = document.getElementById('import-config-input');
	const container = document.getElementById('rules-container');
	const emptyState = document.getElementById('rules-empty');
	const status = document.getElementById('save-status');
	const alertCheckbox = document.getElementById('alert-on-script-patched');

	const storedConfig = normalizeConfig(await storageGet(DEFAULT_CONFIG));
	alertCheckbox.checked = storedConfig.alertOnScriptPatched;
	renderRules(container, emptyState, storedConfig.rules);

	addBtn.addEventListener('click', async () => {
		addRule(container, emptyState, createEmptyRule(), { expanded: true });
		await saveAllRules(container, status, alertCheckbox.checked, emptyState);
	});

	alertCheckbox.addEventListener('change', async () => {
		await saveAllRules(container, status, alertCheckbox.checked, emptyState);
	});

	exportBtn.addEventListener('click', async () => {
		const config = normalizeConfig({
			alertOnScriptPatched: alertCheckbox.checked,
			rules: readRulesFromContainer(container),
		});
		downloadConfig(config);
		showStatus('Config exported.', status);
	});

	importBtn.addEventListener('click', () => {
		if (isChrome || popupNewTab) {
			importInput.click();
		} else {
			api.runtime.openOptionsPage();
			window.close();
		}
	});

	importInput.addEventListener('change', async (event) => {
		const file = event.target.files && event.target.files[0];
		if (!file) {
			return;
		}

		try {
			const importedText = await file.text();
			const importedConfig = normalizeConfig(JSON.parse(importedText));
			alertCheckbox.checked = importedConfig.alertOnScriptPatched;
			renderRules(container, emptyState, importedConfig.rules);
			await storageSet(importedConfig);
			showStatus('Config imported.', status);
		} catch (error) {
			console.error('Import failed.', error);
			showStatus('Import failed. Check the JSON file.', status, true);
		} finally {
			importInput.value = '';
		}
	});
}

function createEmptyRule() {
	return {
		name: '',
		host: '',
		pattern: '',
		script: DEFAULT_RULE_SCRIPT,
	};
}

function normalizeConfig(config) {
	const alertOnScriptPatched = config?.alertOnScriptPatched !== false;
	const rules = Array.isArray(config?.rules)
		? config.rules.map((rule, index) => normalizeRule(rule, index)).filter((rule) => rule.host && rule.script)
		: [];

	return { alertOnScriptPatched, rules };
}

function normalizeRule(rule, index = 0) {
	return {
		name: String(rule?.name || '').trim() || getDefaultRuleName(index + 1),
		host: String(rule?.host || '').trim(),
		pattern: String(rule?.pattern || '').trim(),
		script: String(rule?.script || '').trim() || DEFAULT_RULE_SCRIPT,
	};
}

function renderRules(container, emptyState, rules) {
	container.innerHTML = '';
	rules.forEach((rule) => addRule(container, emptyState, rule, { expanded: false }));
	updateEmptyState(container, emptyState);
}

function addRule(container, emptyState, rule, options = {}) {
	const shouldExpand = options.expanded === true;
	const normalizedRule = normalizeRule(rule, container.querySelectorAll('.rule-card').length);
	const wrapper = document.createElement('section');
	wrapper.className = 'rule-card';
	wrapper.dataset.expanded = shouldExpand ? 'true' : 'false';

	const header = document.createElement('div');
	header.className = 'rule-header';
	header.tabIndex = 0;
	header.setAttribute('role', 'button');
	header.setAttribute('aria-expanded', shouldExpand ? 'true' : 'false');

	const expandIcon = document.createElement('span');
	expandIcon.className = 'expand-icon';
	expandIcon.innerHTML = "<img src='assets/right.svg' />";

	const title = document.createElement('span');
	title.className = 'rule-title';
	title.textContent = normalizedRule.name;

	const deleteBtn = document.createElement('button');
	deleteBtn.type = 'button';
	deleteBtn.className = 'secondary-button danger-button rule-delete';
	deleteBtn.setAttribute('aria-label', 'Delete rule');
	deleteBtn.innerHTML =
		'<span class="delete-label">Delete</span><span class="delete-icon"><img src="assets/Delete.svg" /></span>';

	header.append(expandIcon, title, deleteBtn);
	wrapper.appendChild(header);

	const details = document.createElement('div');
	details.className = 'rule-details';

	const fields = [
		{
			label: 'Rule Name',
			className: 'name-input',
			tag: 'input',
			placeholder: getDefaultRuleName(container.querySelectorAll('.rule-card').length + 1),
			value: normalizedRule.name,
			required: true,
		},
		{
			label: 'Host',
			className: 'host-input',
			tag: 'input',
			placeholder: '*.example.com',
			value: normalizedRule.host || '',
			required: true,
		},
		{
			label: 'Target File Path Pattern RegExp',
			className: 'pattern-input',
			tag: 'input',
			placeholder: '/some/path/name/.*.js',
			value: normalizedRule.pattern || '',
		},
		{
			label: 'JavaScript Code To Run On Matched URLs',
			className: 'script-input',
			tag: 'textarea',
			placeholder: DEFAULT_RULE_SCRIPT,
			value: normalizedRule.script || DEFAULT_RULE_SCRIPT,
			required: true,
		},
	];

	fields.forEach((field) => {
		const label = document.createElement('label');
		label.className = 'field-label';
		label.textContent = field.label;

		const input = document.createElement(field.tag);
		input.className = `field-control ${field.className}`;
		input.placeholder = field.placeholder;
		input.value = field.value;
		if (field.required) {
			input.required = true;
		}
		if (field.tag === 'textarea') {
			input.rows = 9;
			input.spellcheck = false;
		}

		label.appendChild(input);
		details.appendChild(label);
	});

	wrapper.appendChild(details);

	container.appendChild(wrapper);
	updateEmptyState(container, emptyState);

	const persist = debounce(async () => {
		await saveAllRules(
			container,
			document.getElementById('save-status'),
			document.getElementById('alert-on-script-patched').checked,
			emptyState,
		);
	}, 250);

	wrapper.querySelectorAll('input, textarea').forEach((input) => {
		input.addEventListener('input', persist);
		input.addEventListener('change', persist);
	});

	const nameInput = wrapper.querySelector('.name-input');
	nameInput.addEventListener('input', () => {
		title.textContent = nameInput.value.trim() || nameInput.placeholder;
	});
	nameInput.addEventListener('change', () => {
		if (!nameInput.value.trim()) {
			nameInput.value = nameInput.placeholder;
			title.textContent = nameInput.value;
		}
	});

	header.addEventListener('click', (event) => {
		if (event.target.closest('.rule-delete')) {
			return;
		}

		const isExpanded = wrapper.dataset.expanded === 'true';
		const nextExpanded = isExpanded ? 'false' : 'true';
		wrapper.dataset.expanded = nextExpanded;
		header.setAttribute('aria-expanded', nextExpanded);
	});

	header.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter' && event.key !== ' ') {
			return;
		}

		event.preventDefault();
		header.click();
	});

	deleteBtn.addEventListener('click', async () => {
		document.body.classList.add('blur');
		setTimeout(async () => {
			const deleteConfirm = confirm('Are you sure you want to delete this rule?');
			document.body.classList.remove('blur');
			if (deleteConfirm) {
				wrapper.remove();
				updateEmptyState(container, emptyState);
				await saveAllRules(
					container,
					document.getElementById('save-status'),
					document.getElementById('alert-on-script-patched').checked,
					emptyState,
				);
			}
		}, 0);
	});
}

function readRulesFromContainer(container) {
	return Array.from(container.querySelectorAll('.rule-card'))
		.map((card) => {
			const nameInput = card.querySelector('.name-input');
			const name = (nameInput?.value || nameInput?.placeholder || '').trim();
			const host = card.querySelector('.host-input').value.trim();
			const pattern = card.querySelector('.pattern-input').value.trim();
			const script = card.querySelector('.script-input').value.trim();
			return { name, host, pattern, script };
		})
		.filter((rule) => rule.host && rule.script);
}

async function saveAllRules(container, status, alertOnScriptPatched, emptyState) {
	const config = normalizeConfig({
		alertOnScriptPatched,
		rules: readRulesFromContainer(container),
	});
	updateEmptyState(container, emptyState);
	await storageSet(config);
	showStatus('Saved.', status);
}

function updateEmptyState(container, emptyState) {
	emptyState.hidden = container.children.length > 0;
}

function downloadConfig(config) {
	const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = 'script-patcher-config.json';
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showStatus(message, element, isError = false) {
	element.textContent = message;
	element.dataset.error = isError ? 'true' : 'false';
	clearTimeout(showStatus.timeoutId);
	showStatus.timeoutId = setTimeout(() => {
		element.textContent = '';
		element.dataset.error = 'false';
	}, 2500);
}

function debounce(fn, delay) {
	let timeoutId = null;
	return (...args) => {
		clearTimeout(timeoutId);
		timeoutId = setTimeout(() => fn(...args), delay);
	};
}

function getDefaultRuleName(ruleNumber) {
	return `JS-Rule-${ruleNumber}`;
}

function storageGet(defaults) {
	if (usesPromiseStorage) {
		return api.storage.sync.get(defaults);
	}

	return new Promise((resolve) => {
		api.storage.sync.get(defaults, resolve);
	});
}

function storageSet(values) {
	if (usesPromiseStorage) {
		return api.storage.sync.set(values);
	}

	return new Promise((resolve) => {
		api.storage.sync.set(values, resolve);
	});
}
