const isChrome = typeof chrome !== 'undefined' && typeof browser === 'undefined';
const extensionApi = isChrome ? chrome : typeof browser !== 'undefined' ? browser : null;
const api =
	extensionApi && extensionApi.storage
		? extensionApi
		: {
				tabs: { getCurrent: (cb) => cb && cb(null) },
				runtime: { lastError: null },
				storage: {
					local: {
						get: (defaults, cb) => {
							try {
								const data = JSON.parse(localStorage.getItem('script_patcher_config') || 'null') || defaults;
								if (cb) cb(data);
								return Promise.resolve(data);
							} catch (e) {
								if (cb) cb(defaults);
								return Promise.resolve(defaults);
							}
						},
						set: (values, cb) => {
							try {
								localStorage.setItem('script_patcher_config', JSON.stringify(values));
							} catch (e) {}
							if (cb) cb();
							return Promise.resolve();
						},
					},
				},
			};
const usesPromiseStorage = !isChrome && Boolean(extensionApi);

let popupNewTab = false;

if (api.tabs && api.tabs.getCurrent) {
	api.tabs.getCurrent((tab) => {
		if (api.runtime?.lastError || !tab) {
			console.log('Opened in a popup (embedded)');
		} else {
			popupNewTab = true;
			console.log('Opened in a new tab');
		}
	});
}

const DEFAULT_RULE_SCRIPT = `/**
 * @param {string} scriptBody Original script body content
 * @returns {string} Modified script body content
 */
(scriptBody) => {
	// Example: Replace 'searchStrs' with 'replaceStrs' in their index order
	const searchStrs = ['CodeToFind', /RegExToFind/];
	const replaceStrs = ['CodeToReplaceWith', 'RegexToReplaceWith'];
	for (let i = 0; i < searchStrs.length; i++) {
		scriptBody = scriptBody.replaceAll(searchStrs[i], replaceStrs[i]);
	}
	return scriptBody;
}`;

const DEFAULT_CONFIG = {
	enabled: true,
	rules: [],
	groups: [],
};

document.addEventListener('DOMContentLoaded', () => {
	initOptions().catch((error) => {
		console.error('Failed to initialize options UI.', error);
	});
});

async function initOptions() {
	const addBtn = document.getElementById('add-rule');
	const addGroupBtn = document.getElementById('add-group');
	const exportBtn = document.getElementById('export-config');
	const importBtn = document.getElementById('import-config');
	const importInput = document.getElementById('import-config-input');
	const container = document.getElementById('rules-container');
	const emptyState = document.getElementById('rules-empty');
	const status = document.getElementById('save-status');
	const enabledCheckbox = document.getElementById('extension-enabled');

	const storedConfig = normalizeConfig(await storageGet(DEFAULT_CONFIG));
	enabledCheckbox.checked = storedConfig.enabled;
	renderRules(container, emptyState, storedConfig.rules, storedConfig.groups);

	addBtn.addEventListener('click', async () => {
		createItemElement('rule', createEmptyRule(), container, emptyState, { expanded: true });
		await saveAllRules(container, status, enabledCheckbox.checked, emptyState);
	});

	if (addGroupBtn) {
		addGroupBtn.addEventListener('click', async () => {
			const groupName = prompt('Enter group name:');
			if (groupName && groupName.trim()) {
				createItemElement('group', { name: groupName.trim(), enabled: true }, container, emptyState);
				setupGroupToggles(container);
				await saveAllRules(container, status, enabledCheckbox.checked, emptyState);
			}
		});
	}

	document.addEventListener('dragover', (e) => {
		const draggingElement = document.querySelector('.dragging');
		if (!draggingElement) return;
		e.preventDefault();

		let dropZone;
		if (draggingElement.classList.contains('rule-group')) {
			dropZone = document.getElementById('rules-container');
		} else {
			const groupEl = e.target.closest('.rule-group');
			if (groupEl && !groupEl.classList.contains('group-disabled')) {
				dropZone = groupEl.querySelector('.rule-group-items');
			} else {
				dropZone = document.getElementById('rules-container');
			}
		}

		if (dropZone === document.getElementById('rules-container') && e.target.closest('.rule-group-items')) {
			return; // Let the inner group container handle it
		}

		const selector = draggingElement.classList.contains('rule-group')
			? '.rule-group, .rule-card:not(.rule-group-items .rule-card)'
			: '.rule-card';
		const afterElement = getDragAfterElement(dropZone, e.clientY, selector);
		if (afterElement == null) {
			dropZone.appendChild(draggingElement);
		} else {
			dropZone.insertBefore(draggingElement, afterElement);
		}
	});

	enabledCheckbox.addEventListener('change', async () => {
		await saveAllRules(container, status, enabledCheckbox.checked, emptyState);
	});

	exportBtn.addEventListener('click', async () => {
		const config = normalizeConfig(readConfigFromContainer(container, enabledCheckbox.checked));
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
			enabledCheckbox.checked = importedConfig.enabled;
			renderRules(container, emptyState, importedConfig.rules, importedConfig.groups);
			await storageSet(importedConfig);
			showStatus('Config imported.', status);
		} catch (error) {
			console.error('Import failed.', error);
			showStatus('Import failed. Check the JSON file.', status, true);
		} finally {
			importInput.value = '';
		}
	});

	window.addEventListener('keydown', async (event) => {
		if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 's' || event.code === 'KeyS')) {
			event.preventDefault();

			const active = document.activeElement;
			if (active && active.classList.contains('header-name-input')) {
				active.blur();
				return;
			}

			await saveAllRules(container, status, enabledCheckbox.checked, emptyState);
		}
	});
}

function createEmptyRule() {
	return {
		enabled: true,
		name: '',
		group: '',
		host: '',
		pattern: '',
		webpageNotificationOnScriptPatched: true,
		alertOnScriptPatched: false,
		script: DEFAULT_RULE_SCRIPT,
	};
}

function normalizeConfig(config) {
	const legacyAlertDefault = config?.alertOnScriptPatched !== false;
	const enabled = config?.enabled !== false;
	const rules = Array.isArray(config?.rules)
		? config.rules
				.map((rule, index) => normalizeRule(rule, index, legacyAlertDefault))
				.filter((rule) => rule.host && rule.script)
		: [];
	const groups = Array.isArray(config?.groups)
		? config.groups.map((group) => ({
				name: String(group?.name || '').trim(),
				enabled: group?.enabled !== false,
			}))
		: [];

	return { enabled, rules, groups };
}

function normalizeRule(rule, index = 0, legacyAlertDefault = true) {
	return {
		enabled: rule?.enabled !== false,
		name: String(rule?.name || '').trim() || getDefaultRuleName(index + 1),
		group: String(rule?.group || '').trim(),
		host: String(rule?.host || '').trim(),
		pattern: String(rule?.pattern || '').trim(),
		webpageNotificationOnScriptPatched: rule?.webpageNotificationOnScriptPatched === true,
		alertOnScriptPatched: rule?.alertOnScriptPatched || false,
		script: String(rule?.script || '').trim() || DEFAULT_RULE_SCRIPT,
	};
}

function renderRules(container, emptyState, rules, groups = []) {
	container.innerHTML = '';

	const groupElements = new Map();

	groups.forEach((g) => {
		const groupWrapper = createItemElement('group', g, container, emptyState, { expanded: false });
		groupElements.set(g.name, groupWrapper);
	});

	rules.forEach((rule) => {
		if (rule.group) {
			let groupWrapper = groupElements.get(rule.group);
			if (!groupWrapper) {
				groupWrapper = createItemElement('group', { name: rule.group, enabled: true }, container, emptyState, {
					expanded: false,
				});
				groupElements.set(rule.group, groupWrapper);
			}
			const itemsContainer = groupWrapper.querySelector('.rule-group-items');
			createItemElement('rule', rule, itemsContainer, emptyState, { expanded: false });
		} else {
			createItemElement('rule', rule, container, emptyState, { expanded: false });
		}
	});

	updateEmptyState(container, emptyState);
	setupGroupToggles(container);
}

function createItemElement(type, data = {}, container = null, emptyState = null, options = {}) {
	const isGroup = type === 'group';
	const shouldExpand = options.expanded === true;

	let groupName = '';
	let isEnabled = true;
	let normalizedRule = null;

	if (isGroup) {
		if (typeof data === 'string') {
			groupName = data;
			isEnabled = true;
		} else if (data && typeof data === 'object') {
			groupName = String(data.name || '').trim();
			isEnabled = data.enabled !== false;
		}
	} else {
		const parentContainer = container || document.getElementById('rules-container');
		const existingCount = parentContainer ? parentContainer.querySelectorAll('.rule-card').length : 0;
		normalizedRule = normalizeRule(data, existingCount);
		isEnabled = normalizedRule.enabled;
	}

	const wrapper = document.createElement(isGroup ? 'div' : 'section');
	wrapper.className = isGroup ? 'rule-group' : 'rule-card';
	if (isGroup) {
		if (!isEnabled) {
			wrapper.classList.add('group-disabled');
		}
		wrapper.dataset.group = groupName;
	}
	wrapper.dataset.expanded = shouldExpand ? 'true' : 'false';
	wrapper.draggable = false;

	wrapper.addEventListener('mousedown', (e) => {
		if (!isGroup && wrapper.closest('.rule-group.group-disabled')) {
			wrapper.draggable = false;
			return;
		}
		wrapper.draggable = Boolean(e.target.closest('.drag-anchor'));
	});

	wrapper.addEventListener('dragstart', (e) => {
		if (!isGroup && wrapper.closest('.rule-group.group-disabled')) {
			e.preventDefault();
			return;
		}
		if (!wrapper.draggable) {
			e.preventDefault();
			return;
		}
		if (
			e.target.tagName.toLowerCase() === 'input' ||
			e.target.tagName.toLowerCase() === 'textarea' ||
			(isGroup && e.target.closest('.rule-card'))
		) {
			e.preventDefault();
			return;
		}
		e.stopPropagation();
		wrapper.classList.add('dragging');
		document.body.classList.add('is-dragging');
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', '');
		}
	});

	wrapper.addEventListener('dragend', async () => {
		wrapper.classList.remove('dragging');
		document.body.classList.remove('is-dragging');
		if (!isGroup) {
			const parentGroup = wrapper.closest('.rule-group');
			if (parentGroup) {
				parentGroup.dataset.expanded = 'true';
				const groupHeader = parentGroup.querySelector('.rule-group-header');
				if (groupHeader) groupHeader.setAttribute('aria-expanded', 'true');
			}
		}
		const rulesContainer = document.getElementById('rules-container');
		syncAllDisabledStates(rulesContainer);
		await saveAllRules(
			rulesContainer,
			document.getElementById('save-status'),
			document.getElementById('extension-enabled').checked,
			document.getElementById('rules-empty') || emptyState,
		);
	});

	const header = document.createElement('div');
	header.className = isGroup ? 'rule-group-header' : 'rule-header';
	header.tabIndex = 0;
	header.setAttribute('role', 'button');
	header.setAttribute('aria-expanded', shouldExpand ? 'true' : 'false');

	const dragAnchor = document.createElement('span');
	dragAnchor.className = 'drag-anchor';
	dragAnchor.innerHTML = `<img src='assets/img/DragAnchor.svg' />`;

	const expandIcon = document.createElement('span');
	expandIcon.className = 'expand-icon';
	expandIcon.innerHTML = `<img src='assets/img/${isGroup ? 'DoubleRight' : 'Right'}.svg' />`;

	const title = document.createElement(isGroup ? 'h2' : 'h3');
	title.className = 'rule-title';

	const titleText = document.createElement('span');
	titleText.textContent = isGroup ? groupName : normalizedRule.name;
	title.appendChild(titleText);

	const editBtn = document.createElement('button');
	editBtn.type = 'button';
	editBtn.className = `secondary-button name-edit pseudo-tooltip`;
	editBtn.dataset.pseudoTooltip = isGroup ? 'Rename group' : 'Rename rule';
	editBtn.setAttribute('aria-label', isGroup ? 'Rename group' : 'Rename rule');
	editBtn.innerHTML = '<span class="edit-icon"><img src="assets/img/Edit.svg" /></span>';
	title.appendChild(editBtn);

	const toggle = isGroup
		? createToggle('group-enabled', isEnabled, 'Enable Group', 'Toggle Group')
		: createToggle('rule-enabled', normalizedRule.enabled, 'Enable rule', 'Rule Enabled?');
	toggle.classList.add(isGroup ? 'group-switch' : 'rule-switch');

	const deleteBtn = document.createElement('button');
	deleteBtn.type = 'button';
	deleteBtn.className = `secondary-button danger-button ${isGroup ? 'group-delete' : 'rule-delete'} pseudo-tooltip`;
	deleteBtn.dataset.pseudoTooltip = isGroup ? 'Delete group (keeps rules)' : 'Delete this rule';
	if (!isGroup) {
		deleteBtn.setAttribute('aria-label', 'Delete rule');
	}
	deleteBtn.innerHTML = '<span class="delete-icon"><img src="assets/img/Delete.svg" /></span>';

	header.append(dragAnchor, expandIcon, title, toggle, deleteBtn);
	wrapper.appendChild(header);

	let lastBlurTime = 0;
	function startEditing() {
		if (!isGroup && wrapper.closest('.rule-group.group-disabled')) {
			return;
		}
		if (header.querySelector('.header-name-input')) {
			return;
		}

		const currentName = isGroup ? wrapper.dataset.group || titleText.textContent : titleText.textContent;
		const nameInput = document.createElement('input');
		nameInput.type = 'text';
		nameInput.className = 'header-name-input';
		nameInput.value = currentName;
		nameInput.placeholder = isGroup ? 'Group Name' : wrapper.querySelector('.name-input')?.placeholder || 'Rule Name';

		let committed = false;

		const finishEdit = async (save) => {
			if (committed) return;
			committed = true;

			if (save) {
				const nextName = nameInput.value.trim() || nameInput.placeholder || (isGroup ? 'Group' : 'Rule');
				titleText.textContent = nextName;
				if (isGroup) {
					groupName = nextName;
					wrapper.dataset.group = nextName;
				} else {
					normalizedRule.name = nextName;
					const ruleNameField = wrapper.querySelector('.name-input');
					if (ruleNameField) {
						ruleNameField.value = nextName;
					}
				}
			}

			if (nameInput.parentNode === header) {
				header.replaceChild(title, nameInput);
			}

			if (save) {
				const rulesContainer = document.getElementById('rules-container');
				await saveAllRules(
					rulesContainer,
					document.getElementById('save-status'),
					document.getElementById('extension-enabled').checked,
					document.getElementById('rules-empty') || emptyState,
				);
			}
		};

		nameInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				finishEdit(true);
			} else if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				finishEdit(false);
			} else if (e.key === ' ') {
				e.stopPropagation();
			}
		});

		nameInput.addEventListener('blur', () => {
			lastBlurTime = Date.now();
			finishEdit(true);
		});

		nameInput.addEventListener('click', (e) => e.stopPropagation());
		nameInput.addEventListener('dblclick', (e) => e.stopPropagation());
		nameInput.addEventListener('mousedown', (e) => e.stopPropagation());

		header.replaceChild(nameInput, title);
		nameInput.focus();
		nameInput.select();
	}

	editBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		if (header.querySelector('.header-name-input') || Date.now() - lastBlurTime < 200) {
			return;
		}
		startEditing();
	});

	title.addEventListener('dblclick', (e) => {
		e.stopPropagation();
		startEditing();
	});

	header.addEventListener('click', (event) => {
		if (
			event.target.tagName.toLowerCase() === 'input' ||
			event.target.tagName.toLowerCase() === 'button' ||
			event.target.closest('button') ||
			event.target.closest('.switch') ||
			event.target.closest('.drag-anchor') ||
			(!isGroup && wrapper.closest('.rule-group.group-disabled'))
		) {
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
		if (
			event.target.tagName.toLowerCase() === 'input' ||
			event.target.tagName.toLowerCase() === 'button' ||
			event.target.closest('button') ||
			event.target.closest('.switch')
		) {
			return;
		}
		event.preventDefault();
		header.click();
	});

	if (isGroup) {
		const items = document.createElement('div');
		items.className = 'rule-group-items';
		wrapper.appendChild(items);

		deleteBtn.addEventListener('click', async () => {
			const rulesContainer = document.getElementById('rules-container');
			while (items.firstChild) {
				rulesContainer.insertBefore(items.firstChild, wrapper);
			}
			wrapper.remove();
			syncAllDisabledStates(rulesContainer);
			await saveAllRules(
				rulesContainer,
				document.getElementById('save-status'),
				document.getElementById('extension-enabled').checked,
				document.getElementById('rules-empty') || emptyState,
			);
		});
	} else {
		const details = document.createElement('div');
		details.className = 'rule-details';

		const parentContainer = container || document.getElementById('rules-container');
		const existingCount = parentContainer ? parentContainer.querySelectorAll('.rule-card').length : 0;

		const fields = [
			{
				tag: 'input',
				label: 'Rule Name',
				className: 'name-input',
				placeholder: getDefaultRuleName(existingCount + 1),
				value: normalizedRule.name,
				required: true,
			},
			{
				tag: 'input',
				label: 'Host',
				className: 'host-input',
				placeholder: '*.example.com',
				value: normalizedRule.host || '',
				required: true,
			},
			{
				tag: 'input',
				label: 'Target File Path Pattern RegExp',
				className: 'pattern-input',
				placeholder: '/some/path/name/.*.js',
				value: normalizedRule.pattern || '',
			},
			{
				tag: 'checkbox',
				label: 'Show Website Toast Notification',
				className: 'webpage-notification-on-script-patched-input',
				checked: normalizedRule.webpageNotificationOnScriptPatched,
				description: 'Show a toast notification on the website when this rule patches a matched script.',
				pseudoTooltip: 'Toast Notification?',
			},
			{
				tag: 'checkbox',
				label: 'Alert On Script Patched',
				className: 'alert-on-script-patched-input',
				checked: normalizedRule.alertOnScriptPatched,
				description: 'Show a browser alert when this rule patches a matched script.',
				pseudoTooltip: 'Alert?',
			},
			{
				tag: 'textarea',
				label: 'JavaScript Code To Run On Matched URLs',
				className: 'script-input',
				placeholder: DEFAULT_RULE_SCRIPT,
				value: normalizedRule.script || DEFAULT_RULE_SCRIPT,
				required: true,
			},
		];

		fields.forEach((field) => {
			if (field.tag === 'checkbox') {
				const row = document.createElement('div');
				row.className = 'setting-row inline-setting';

				const text = document.createElement('div');
				const label = document.createElement('div');
				label.className = 'field-label inline-label';
				label.textContent = field.label;

				const description = document.createElement('div');
				description.className = 'description';
				description.textContent = field.description;

				text.append(label, description);
				row.append(text, createToggle(field.className, field.checked, field.label, field.pseudoTooltip || 'Alert?'));
				details.appendChild(row);
				return;
			}

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

		const persist = debounce(async () => {
			await saveAllRules(
				document.getElementById('rules-container'),
				document.getElementById('save-status'),
				document.getElementById('extension-enabled').checked,
				document.getElementById('rules-empty') || emptyState,
			);
		}, 250);

		wrapper.querySelectorAll('input, textarea').forEach((input) => {
			input.addEventListener('input', persist);
			input.addEventListener('change', persist);
		});

		const nameInput = wrapper.querySelector('.name-input');
		nameInput.addEventListener('input', () => {
			titleText.textContent = nameInput.value.trim() || nameInput.placeholder;
		});
		nameInput.addEventListener('change', () => {
			if (!nameInput.value.trim()) {
				nameInput.value = nameInput.placeholder;
				titleText.textContent = nameInput.value;
			}
		});

		deleteBtn.addEventListener('click', async () => {
			document.body.classList.add('blur');
			setTimeout(async () => {
				const deleteConfirm = confirm('Are you sure you want to delete this rule?');
				document.body.classList.remove('blur');
				if (deleteConfirm) {
					wrapper.remove();
					const rulesContainer = document.getElementById('rules-container');
					updateEmptyState(rulesContainer, document.getElementById('rules-empty') || emptyState);
					await saveAllRules(
						rulesContainer,
						document.getElementById('save-status'),
						document.getElementById('extension-enabled').checked,
						document.getElementById('rules-empty') || emptyState,
					);
				}
			}, 0);
		});
	}

	if (container) {
		container.appendChild(wrapper);
		if (emptyState) {
			updateEmptyState(document.getElementById('rules-container') || container, emptyState);
		}
	}

	return wrapper;
}

function createGroupElement(groupName, enabled = true, options = {}) {
	return createItemElement('group', { name: groupName, enabled }, null, null, options);
}

function addRule(container, emptyState, rule, options = {}) {
	return createItemElement('rule', rule, container, emptyState, options);
}

function updateGroupDisabledState(groupWrapper, isDisabled) {
	groupWrapper.classList.toggle('group-disabled', isDisabled);
	const items = groupWrapper.querySelector('.rule-group-items');
	if (items) {
		const controls = items.querySelectorAll('input, textarea, button');
		controls.forEach((control) => {
			control.disabled = isDisabled;
		});
	}
}

function setupGroupToggles(container) {
	container.querySelectorAll('.rule-group').forEach((group) => {
		const toggle = group.querySelector('.group-enabled, .group-switch input');
		if (!toggle) return;

		updateGroupDisabledState(group, !toggle.checked);

		toggle.onchange = async () => {
			updateGroupDisabledState(group, !toggle.checked);
			await saveAllRules(
				container,
				document.getElementById('save-status'),
				document.getElementById('extension-enabled').checked,
				document.getElementById('rules-empty'),
			);
		};
	});
}

function syncAllDisabledStates(container) {
	container
		.querySelectorAll(':scope > .rule-card input, :scope > .rule-card textarea, :scope > .rule-card button')
		.forEach((el) => {
			el.disabled = false;
		});
	setupGroupToggles(container);
}

function readRuleFromCard(card, groupName) {
	const enabled = card.querySelector('.rule-enabled').checked;
	const nameInput = card.querySelector('.name-input');
	const name = (nameInput?.value || nameInput?.placeholder || '').trim();
	const host = card.querySelector('.host-input').value.trim();
	const pattern = card.querySelector('.pattern-input').value.trim();
	const webpageNotificationOnScriptPatched = card.querySelector(
		'.webpage-notification-on-script-patched-input',
	).checked;
	const alertOnScriptPatched = card.querySelector('.alert-on-script-patched-input').checked;
	const script = card.querySelector('.script-input').value.trim();
	return {
		enabled,
		name,
		host,
		pattern,
		webpageNotificationOnScriptPatched,
		alertOnScriptPatched,
		script,
		group: groupName,
	};
}

function readConfigFromContainer(container, enabledCheckboxChecked) {
	const rules = [];
	const groups = [];
	const elements = container.children;

	for (const el of elements) {
		if (el.classList.contains('rule-card')) {
			rules.push(readRuleFromCard(el, ''));
		} else if (el.classList.contains('rule-group')) {
			const groupName = el.dataset.group;
			const groupToggle = el.querySelector('.group-enabled, .group-switch input');
			const groupEnabled = groupToggle ? groupToggle.checked : true;
			groups.push({ name: groupName, enabled: groupEnabled });

			const items = el.querySelectorAll('.rule-card');
			for (const item of items) {
				rules.push(readRuleFromCard(item, groupName));
			}
		}
	}

	return {
		enabled: enabledCheckboxChecked,
		rules: rules.filter((rule) => rule.host && rule.script),
		groups: groups,
	};
}

async function saveAllRules(container, status, enabled, emptyState) {
	const config = normalizeConfig(readConfigFromContainer(container, enabled));
	updateEmptyState(container, emptyState);
	await storageSet(config);
	showStatus('Saved.', status);
}

function createToggle(inputClassName, checked, ariaLabel, pseudoTooltip) {
	const toggle = document.createElement('label');
	toggle.className = 'switch';

	if (pseudoTooltip) {
		toggle.classList.add('pseudo-tooltip');
		toggle.dataset.pseudoTooltip = pseudoTooltip;
	}

	const input = document.createElement('input');
	input.type = 'checkbox';
	input.className = inputClassName;
	input.checked = checked;
	input.setAttribute('aria-label', ariaLabel);

	const slider = document.createElement('span');
	slider.className = 'slider';

	toggle.append(input, slider);
	return toggle;
}

function updateEmptyState(container, emptyState) {
	emptyState.hidden = container.children.length > 0;
}

function downloadConfig(config) {
	const blob = new Blob([JSON.stringify(config, null, '\t')], { type: 'application/json' });
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
		return api.storage.local.get(defaults);
	}

	return new Promise((resolve) => {
		api.storage.local.get(defaults, resolve);
	});
}

function storageSet(values) {
	if (usesPromiseStorage) {
		return api.storage.local.set(values);
	}

	return new Promise((resolve) => {
		api.storage.local.set(values, resolve);
	});
}

function getDragAfterElement(container, y, selector = '.rule-card:not(.dragging)') {
	const draggableElements = [...container.querySelectorAll(selector)];

	return draggableElements.reduce(
		(closest, child) => {
			const box = child.getBoundingClientRect();
			const offset = y - box.top - box.height / 2;
			if (offset < 0 && offset > closest.offset) {
				return { offset: offset, element: child };
			} else {
				return closest;
			}
		},
		{ offset: Number.NEGATIVE_INFINITY },
	).element;
}
