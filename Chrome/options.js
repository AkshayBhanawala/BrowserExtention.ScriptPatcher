// Select API based on browser compatibility (browser for Firefox, chrome for Chrome)
const api = typeof chrome !== 'undefined' ? chrome : browser;

const DEFAULT_RULE = {
	host: '',
	pattern: '',
	script: `/**\n * @param {string} scriptBody Original script body content\n * @returns {string} Modified script body content\n */\nfunction (scriptBody) {\n return scriptBody;\n}`
};

document.addEventListener('DOMContentLoaded', () => {
	initOptions();
});

async function initOptions() {
	const addBtn = document.getElementById('add-rule');
	const container = document.getElementById('rules-container');
	const status = document.getElementById('save-status');
	const alertCheckbox = document.getElementById('alert-on-script-patched');

	// Load stored data
	api.storage.sync.get({ rules: [], alertOnScriptPatched: true }, (items) => {
		const rules = items.rules || [];
		alertCheckbox.checked = items.alertOnScriptPatched;
		renderRules(container, rules);
	});

	addBtn.addEventListener('click', () => {
		addRule(container, DEFAULT_RULE);
	});

	alertCheckbox.addEventListener('change', () => {
		api.storage.sync.set({ alertOnScriptPatched: alertCheckbox.checked }, () => {
			showStatus('Saved alert preference', status);
		});
	});
}

function renderRules(container, rules) {
	container.innerHTML = '';
	rules.forEach((r, idx) => {
		addRule(container, r, idx);
	});
	// ensure there's at least one empty row
	if (rules.length === 0) addRule(container, DEFAULT_RULE);
}

function addRule(container, rule = DEFAULT_RULE, idx = null) {
	const wrapper = document.createElement('div');
	wrapper.className = 'setting-row';
	wrapper.style.flexDirection = 'column';
	wrapper.style.alignItems = 'stretch';
	wrapper.style.gap = '8px';
	wrapper.style.padding = '8px';
	wrapper.style.border = '1px solid rgba(255,255,255,0.06)';

	const inputs = document.createElement('div');
	inputs.style.display = 'flex';
	inputs.style.gap = '8px';

	const hostInput = document.createElement('input');
	hostInput.placeholder = 'Host (required) e.g. example.com';
	hostInput.style.flex = '1';
	hostInput.value = rule.host || '';

	const patternInput = document.createElement('input');
	patternInput.placeholder = 'Target file pattern (optional) e.g. *-*.js';
	patternInput.style.width = '260px';
	patternInput.value = rule.pattern || '';

	const removeBtn = document.createElement('button');
	removeBtn.textContent = 'Remove';

	inputs.appendChild(hostInput);
	inputs.appendChild(patternInput);
	inputs.appendChild(removeBtn);

	const scriptArea = document.createElement('textarea');
	scriptArea.style.width = '100%';
	scriptArea.style.minHeight = '140px';
	scriptArea.value = rule.script || DEFAULT_RULE.script;

	wrapper.appendChild(inputs);
	wrapper.appendChild(scriptArea);

	container.appendChild(wrapper);

	// Event handlers
	removeBtn.addEventListener('click', () => {
		wrapper.remove();
		saveAllRules(container);
	});

	hostInput.addEventListener('change', () => saveAllRules(container));
	patternInput.addEventListener('change', () => saveAllRules(container));
	scriptArea.addEventListener('change', () => saveAllRules(container));
}

function readRulesFromContainer(container) {
	const rows = Array.from(container.children);
	const rules = rows.map(row => {
		const inputs = row.querySelectorAll('input');
		const host = inputs[0].value.trim();
		const pattern = inputs[1].value.trim();
		const script = row.querySelector('textarea').value;
		return { host, pattern, script };
	}).filter(r => r.host && r.script);
	return rules;
}

function saveAllRules(container) {
	const status = document.getElementById('save-status');
	const rules = readRulesFromContainer(container);
	api.storage.sync.set({ rules }, () => {
		showStatus('Saved rules', status);
	});
}

function showStatus(msg, el) {
	el.textContent = msg;
	setTimeout(() => { el.textContent = ''; }, 2000);
}
