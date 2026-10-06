// Keep the app's WebView in place: WebKit's browser presentation changes its
// coordinate space and adds browser controls over plugin content.
export default function installFullscreen(
	setActive: (active: boolean) => Promise<void>,
) {
	let owner: HTMLElement | null = null;
	let restore: (() => void) | undefined;
	let queue = Promise.resolve();
	const backKeys = new WeakSet<Event>();
	const observer = new MutationObserver(() => {
		if (owner && !owner.isConnected) void exit();
	});
	Object.defineProperty(document, "fullscreenElement", {
		configurable: true,
		get() {
			return retarget(document);
		},
	});
	Object.defineProperty(ShadowRoot.prototype, "fullscreenElement", {
		configurable: true,
		get() {
			return retarget(this);
		},
	});
	Object.defineProperty(document, "fullscreenEnabled", {
		configurable: true,
		value: true,
	});
	Element.prototype.requestFullscreen = function () {
		const target = this;
		return schedule(async () => {
			if (
				!(target instanceof HTMLElement) ||
				target.ownerDocument !== document ||
				!target.isConnected
			)
				throw new TypeError("Fullscreen requires a connected app element.");
			if (owner === target) return;
			if (
				owner ||
				target.matches(":popover-open") ||
				target instanceof HTMLDialogElement
			)
				throw new TypeError("Another presentation is already active.");
			const style = document.createElement("style");
			style.textContent = `[data-acode-fullscreen] {
				position: fixed !important; inset: 0 !important;
				width: 100% !important; height: 100% !important;
				max-width: none !important; max-height: none !important;
				margin: 0 !important; padding: 0 !important; border: 0 !important;
				box-sizing: border-box !important;
			}`;
			const root = target.getRootNode();
			(root instanceof ShadowRoot ? root : document.head).append(style);
			const popover = target.getAttribute("popover");
			const marker = target.getAttribute("data-acode-fullscreen");
			restore = () => {
				target.hidePopover();
				if (popover === null) target.removeAttribute("popover");
				else target.setAttribute("popover", popover);
				if (marker === null) target.removeAttribute("data-acode-fullscreen");
				else target.setAttribute("data-acode-fullscreen", marker);
				style.remove();
			};
			try {
				target.setAttribute("popover", "manual");
				target.setAttribute("data-acode-fullscreen", "");
				target.showPopover();
				await setActive(true);
				if (!target.isConnected)
					throw new TypeError("Fullscreen element was removed.");
				owner = target;
				observer.observe(document, { childList: true, subtree: true });
				let ancestor: Node = target;
				while (ancestor.getRootNode() instanceof ShadowRoot) {
					const tree = ancestor.getRootNode() as ShadowRoot;
					observer.observe(tree, { childList: true, subtree: true });
					ancestor = tree.host;
				}
				target.addEventListener("toggle", toggled);
				await resized();
				changed(target);
			} catch (error) {
				owner = null;
				restore?.();
				restore = undefined;
				await setActive(false);
				throw error;
			}
		});
	};
	document.exitFullscreen = exit;
	document.addEventListener("fullscreenbackbutton", closeMenu, true);
	document.addEventListener("keydown", (event) => {
		if (
			event.key === "Escape" &&
			owner &&
			!event.defaultPrevented &&
			!backKeys.has(event)
		) {
			event.preventDefault();
			void exit();
		}
	});

	function closeMenu(event: Event) {
		if (!owner) return;
		let menu: Element | undefined;
		const trees: (Element | ShadowRoot)[] = [owner];
		for (const tree of trees) {
			const elements =
				tree instanceof Element
					? [tree, ...tree.querySelectorAll("*")]
					: tree.querySelectorAll("*");
			for (const element of elements) {
				if (element.shadowRoot) trees.push(element.shadowRoot);
				if (
					element.matches('dialog[open], [role="dialog"][aria-modal="true"]') &&
					!element.hasAttribute("hidden") &&
					element.checkVisibility({
						visibilityProperty: true,
						opacityProperty: true,
					})
				)
					menu = element;
			}
		}
		if (!menu) return;
		let focused = document.activeElement;
		while (focused?.shadowRoot?.activeElement)
			focused = focused.shadowRoot.activeElement;
		const escape = new KeyboardEvent("keydown", {
			key: "Escape",
			code: "Escape",
			bubbles: true,
			composed: true,
			cancelable: true,
		});
		backKeys.add(escape);
		(focused && menu.contains(focused) ? focused : menu).dispatchEvent(escape);
		if (escape.defaultPrevented) event.stopImmediatePropagation();
	}

	function schedule(action: () => Promise<void>) {
		const result = queue.then(action);
		queue = result.catch(() => {});
		return result;
	}
	function retarget(root: Document | ShadowRoot) {
		let target: Element | null = owner;
		while (target) {
			const tree = target.getRootNode();
			if (tree === root) return target;
			if (!(tree instanceof ShadowRoot)) return null;
			target = tree.host;
		}
		return null;
	}
	function exit() {
		return schedule(async () => {
			if (!owner) return;
			const target = owner;
			await setActive(false);
			owner = null;
			observer.disconnect();
			target.removeEventListener("toggle", toggled);
			restore?.();
			restore = undefined;
			await resized();
			changed(target);
		});
	}
	function toggled(event: Event) {
		if (owner && (event as ToggleEvent).newState === "closed") void exit();
	}
	function changed(target: HTMLElement) {
		const event = new Event("fullscreenchange", {
			bubbles: true,
			composed: true,
		});
		if (target.isConnected) target.dispatchEvent(event);
		else document.dispatchEvent(event);
	}
	function resized() {
		return new Promise<void>((resolve) =>
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					window.dispatchEvent(new Event("resize"));
					resolve();
				}),
			),
		);
	}
}
