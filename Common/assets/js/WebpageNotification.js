(() => {
	const notifierKey = 'scriptPatcherShowWebpageNotification';
	if (typeof window[notifierKey] === 'function') {
		return;
	}

	/**
	 * @param {string} message
	 */
	window[notifierKey] = (message) => {
		const styleId = 'script-patcher-webpage-notification-styles';
		const nClassName = 'script-patcher-webpage-notification';

		const messageKey = 'scriptPatcherWebpageNotificationMessage';
		if (!document.getElementById(styleId)) {
			if (window[messageKey]) {
				window[messageKey] += `<hr />${message}`;
				return;
			} else {
				window[messageKey] = message;
			}
		}

		const renderNotification = () => {
			if (!document.getElementById(styleId)) {
				const style = document.createElement('style');
				style.id = styleId;
				style.textContent = `
					.${nClassName} {
						--surface-color: #1c1f24;
						--surface-border: #2c3138;
						--primary-color: #1dd18f;
						--primary-strong: #13a872;
						--muted-text: #9ea8ad;

						position: fixed;
						left: 50%;
						top: -50px;
						transform: translateX(-50%);
						z-index: 9999999;
						padding: 10px 20px;
						background-color: var(--surface-color);
						color: var(--primary-color);
						border: 1px solid var(--primary-strong);
						border-radius: 20px;
						filter: drop-shadow(0px 9px 5px rgba(0, 0, 0, 0.5));
						font-family: 'Inter', system-ui, sans-serif;
						font-size: 1rem !important;
						font-weight: normal;
						font-style: normal;
						opacity: 0;
						transition: all 0.5s cubic-bezier(0.22, 1, 0.36, 1);
					}
					.${nClassName}.${nClassName}-visible {
						top: 50px;
						opacity: 1;
					}
					.${nClassName} hr {
						opacity: 0.5;
						border-top: 1px solid var(--muted-text);
						border-bottom: none;
					}`;
				(document.head || document.documentElement).appendChild(style);
			}

			const elemKey = 'scriptPatcherWebpageNotificationElement';
			const cleanupTimeoutKey = 'scriptPatcherWebpageNotificationCleanupTimeout';

			if (window[elemKey]) {
				clearTimeout(window[cleanupTimeoutKey]);
				window[elemKey].innerHTML += `<hr />${message}`;
			} else {
				window[elemKey] = document.createElement('div');
				window[elemKey].className = nClassName;
				window[elemKey].innerHTML = window[messageKey];
				(document.body || document.documentElement).append(window[elemKey]);

				setTimeout(() => {
					window[elemKey]?.classList?.add(`${nClassName}-visible`);
				}, 10);
			}

			window[cleanupTimeoutKey] = setTimeout(() => {
				window[elemKey]?.classList?.remove(`${nClassName}-visible`);
				window[elemKey]?.addEventListener('transitionend', () => window[elemKey]?.remove(), { once: true });

				window[cleanupTimeoutKey] = undefined;
				window[elemKey] = undefined;
				window[messageKey] = undefined;
				window[notifierKey] = undefined;
			}, 5000);
		};

		if (document.body || document.documentElement) {
			renderNotification();
			return;
		}

		document.addEventListener('DOMContentLoaded', renderNotification, { once: true });
	};
})();
