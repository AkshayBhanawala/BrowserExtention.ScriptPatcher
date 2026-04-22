window.addEventListener('message', async (event) => {
	const payload = event.data;
	if (!payload || payload.type !== 'RUN_PATCH_RULE') {
		return;
	}

	let result = payload.scriptBody;
	let error = null;

	try {
		const factory = new Function(`"use strict"; return (${payload.scriptSource});`);
		const userFunction = factory();
		if (typeof userFunction !== 'function') {
			throw new Error('Patch code must evaluate to a function.');
		}

		const output = await userFunction(payload.scriptBody);
		if (typeof output !== 'string') {
			throw new Error('Patch function must return a string.');
		}

		result = output;
	} catch (caughtError) {
		error = caughtError instanceof Error ? caughtError.message : String(caughtError);
	}

	event.source.postMessage(
		{
			type: 'PATCH_RULE_RESULT',
			requestId: payload.requestId,
			result,
			error,
		},
		'*',
	);
});
