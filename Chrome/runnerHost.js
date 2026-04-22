const pendingRuns = new Map();
let sandboxFramePromise = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (!message || message.type !== 'RUN_PATCH_RULE') {
		return undefined;
	}

	runPatchInSandbox(message.payload)
		.then((result) => sendResponse({ ok: true, result }))
		.catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));

	return true;
});

window.addEventListener('message', (event) => {
	const data = event.data;
	if (!data || data.type !== 'PATCH_RULE_RESULT') {
		return;
	}

	const pending = pendingRuns.get(data.requestId);
	if (!pending || event.source !== pending.source) {
		return;
	}

	pendingRuns.delete(data.requestId);
	if (data.error) {
		pending.reject(new Error(data.error));
		return;
	}

	pending.resolve(data.result);
});

async function runPatchInSandbox(payload) {
	const frame = await ensureSandboxFrame();
	return new Promise((resolve, reject) => {
		pendingRuns.set(payload.requestId, {
			resolve,
			reject,
			source: frame.contentWindow,
		});

		frame.contentWindow.postMessage(
			{
				type: 'RUN_PATCH_RULE',
				requestId: payload.requestId,
				scriptSource: payload.scriptSource,
				scriptBody: payload.scriptBody,
			},
			'*',
		);
	});
}

function ensureSandboxFrame() {
	if (sandboxFramePromise) {
		return sandboxFramePromise;
	}

	sandboxFramePromise = new Promise((resolve) => {
		const frame = document.createElement('iframe');
		frame.setAttribute('sandbox', 'allow-scripts');
		frame.src = chrome.runtime.getURL('sandbox.html');
		frame.style.display = 'none';
		frame.addEventListener('load', () => resolve(frame), { once: true });
		document.body.appendChild(frame);
	});

	return sandboxFramePromise;
}
