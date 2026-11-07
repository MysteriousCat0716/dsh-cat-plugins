// Client half of dsh-cat-think.
//
// The chat renderer draws every reasoning segment as a disclosure row marked
// with data-variant="think" (data-state="running" while the model is still
// thinking, "ok" once the segment closed). The renderer keeps the open state in
// React and folds a row by itself when the segment finishes, so the plugin has
// to re-open it and keep it open.
//
// Behaviour:
//   1. A freshly started segment expands by itself.
//   2. When it finishes the renderer folds it; the plugin opens it again, so it
//      stays readable after all thinking is done.
//   3. A row the user opened by hand stays open when later segments start; only
//      rows the plugin opened by itself are folded.
//   4. A row the user folded by hand stays folded.
//   5. Rows collapse at the start of the next session, not at the end of the
//      thinking, and history rows loaded by a page refresh are left alone.
//
// Escape hatch: add ?catthink=off to the URL to disable it for that page.
window.__ModuleLoader__.load({
	id: "dsh-cat-think",
	factory: (require) => {
		var module = { exports: {} };

		// Selector of one reasoning row, and the attributes the renderer sets.
		const ROW_SELECTOR = '[data-variant="think"]';
		const EXPANDED_ATTR = "data-expanded";
		const STATE_ATTR = "data-state";
		const RUNNING_STATE = "running";

		// Coalesce bursts of mutations into one pass.
		const DEBOUNCE_MS = 80;
		// Wait this long after a click before deciding its direction; React needs
		// a frame or two to commit the new data-expanded value.
		const CLICK_SETTLE_MS = 200;

		// The row this plugin expanded last; used to spot the next segment.
		let activeRow = null;
		// False until the first pass has seen the initial page state.
		let primed = false;
		// MutationObserver handle and debounce timer.
		let observer = null;
		let timer = null;
		// Session key, so switching sessions folds the rows of the previous one.
		let lastHref = null;

		// Rows the user opened by hand: never folded automatically.
		let userOpened = new Set();
		// Rows the user folded by hand: never opened automatically.
		let userClosed = new Set();
		// Rows this plugin opened by itself: the only ones it may fold.
		let autoOpened = new Set();

		// Click tracking, to tell a manual toggle apart from our own click.
		let suppressing = false;
		let pendingClick = null;
		let clickTimer = null;

		// All reasoning rows currently in the document, in DOM order.
		function allRows() {
			return Array.from(document.querySelectorAll(ROW_SELECTOR));
		}

		// Whether a row is currently open.
		function isOpen(row) {
			return row.getAttribute(EXPANDED_ATTR) !== null;
		}

		// Whether a row belongs to a segment that is still streaming.
		function isRunning(row) {
			return row.getAttribute(STATE_ATTR) === RUNNING_STATE;
		}

		// The clickable element that toggles a row: the renderer puts
		// aria-expanded on the disclosure switch; fall back to the first child
		// (the row itself handles clicks via bubbling).
		function switchOf(row) {
			const button = row.querySelector("[aria-expanded]");
			if (button !== null) return button;
			return row.firstElementChild;
		}

		// Click the switch when the row is not already in the wanted state.
		function setOpen(row, open) {
			if (row === null || isOpen(row) === open) return false;
			const target = switchOf(row);
			if (target === null || typeof target.click !== "function") return false;
			// Mark the synchronous click dispatch as ours, so the document
			// listener does not mistake it for a manual toggle.
			suppressing = true;
			try {
				target.click();
			} finally {
				suppressing = false;
			}
			return true;
		}

		// Fold the rows this plugin opened, leaving the user's own choices alone.
		function foldAuto(rows, keep) {
			for (const row of rows) {
				if (row === keep) continue;
				if (!autoOpened.has(row)) continue;
				if (userOpened.has(row)) continue;
				autoOpened.delete(row);
				setOpen(row, false);
			}
		}

		// Open a row on the plugin's initiative. A row the user already opened is
		// left out of autoOpened, so a later segment never folds it.
		function openAuto(row) {
			if (row === null) return false;
			if (userClosed.has(row)) return false;
			if (isOpen(row)) return false;
			autoOpened.add(row);
			return setOpen(row, true);
		}

		// Close everything this plugin or the user opened, then forget the rows.
		function closeSessionRows() {
			for (const row of allRows()) {
				if (autoOpened.has(row) || userOpened.has(row)) setOpen(row, false);
			}
			// 200ms 的点击判定窗里换了会话，旧的 pendingClick 会把旧行写进新会话的集合。
			if (clickTimer !== null) {
				window.clearTimeout(clickTimer);
				clickTimer = null;
			}
			pendingClick = null;
			userOpened = new Set();
			userClosed = new Set();
			autoOpened = new Set();
			activeRow = null;
			primed = false;
		}

		// One pass over the current DOM state.
		function sweep() {
			const href = typeof window.location?.href === "string" ? window.location.href : "";
			if (lastHref !== null && href !== lastHref) closeSessionRows();
			lastHref = href;

			const rows = allRows();
			if (rows.length === 0) {
				activeRow = null;
				return;
			}

			const latest = rows[rows.length - 1];

			// First pass sees whatever history the page already rendered. Only a
			// running segment is worth opening; finished rows keep their state.
			if (!primed) {
				primed = true;
				if (!isRunning(latest)) return;
				foldAuto(rows, latest);
				openAuto(latest);
				activeRow = latest;
				return;
			}

			// A new segment took over: fold the rows we opened earlier, open
			// this one. Rows the user opened stay open across segments.
			if (latest !== activeRow) {
				foldAuto(rows, latest);
				openAuto(latest);
				activeRow = latest;
				return;
			}

			// Same segment. Keep it open while streaming and after it finished,
			// because the renderer folds the row the moment the segment closes.
			if (userClosed.has(latest)) return;
			// A click is being decided right now; do not fight the user.
			if (pendingClick !== null && pendingClick.row === latest) return;
			openAuto(latest);
		}

		// Debounced pass, triggered by DOM mutations.
		function schedule() {
			if (timer !== null) return;
			timer = setTimeout(() => {
				timer = null;
				sweep();
			}, DEBOUNCE_MS);
		}

		// Remember which row a click landed on and whether it was open before the
		// click, then decide the direction after the renderer settled.
		function onDocumentClick(event) {
			const target = event !== null && event !== undefined ? event.target : null;
			if (target === null || typeof target.closest !== "function") return;
			const row = target.closest(ROW_SELECTOR);
			if (row === null || row === undefined) return;
			// Our own click: not a user decision.
			if (suppressing) return;
			pendingClick = { row, wasOpen: isOpen(row) };
			if (clickTimer !== null) clearTimeout(clickTimer);
			clickTimer = setTimeout(() => {
				clickTimer = null;
				const pending = pendingClick;
				pendingClick = null;
				if (pending === null) return;
				const clicked = pending.row;
				const nowOpen = isOpen(clicked);
				// Attribute did not move: not a toggle, or React has not committed.
				if (nowOpen === pending.wasOpen) return;
				if (nowOpen) {
					// The user opened it: remember that choice, so no later sweep
					// folds it. Other rows are left exactly as they are.
					userOpened.add(clicked);
					userClosed.delete(clicked);
					autoOpened.delete(clicked);
					return;
				}
				// The user closed it: keep it closed.
				userClosed.add(clicked);
				userOpened.delete(clicked);
				autoOpened.delete(clicked);
			}, CLICK_SETTLE_MS);
		}

		// Watch the document for new rows, state changes and row clicks.
		function watch() {
			if (observer !== null) return;
			observer = new MutationObserver(schedule);
			observer.observe(document.documentElement, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: [EXPANDED_ATTR, STATE_ATTR],
			});
			document.addEventListener("click", onDocumentClick, true);
		}

		// 卸载时把自己挂过的东西全摘掉。以前 apply 没有返回值，
		// HMR 重载一次就多挂一套 observer 和捕获阶段的 click 监听。
		function unwatch() {
			if (observer !== null) {
				observer.disconnect();
				observer = null;
			}
			document.removeEventListener("click", onDocumentClick, true);
			if (clickTimer !== null) {
				window.clearTimeout(clickTimer);
				clickTimer = null;
			}
			pendingClick = null;
			userOpened.clear();
			userClosed.clear();
			autoOpened.clear();
		}

		// Whether the page asked for the plugin to stay out of the way.
		function disabled() {
			try {
				return new URLSearchParams(window.location.search).get("catthink") === "off";
			} catch (error) {
				return false;
			}
		}

		// Entry point called by the client loader.
		function start() {
			if (disabled()) return;
			watch();
			sweep();
		}

		module.exports = {
			name: "dsh-cat-think",
			inject: [],
			apply() {
				start();
				return unwatch;
			},
			// Exposed for the offline check script.
			_internals: { sweep, setOpen, isOpen, isRunning, allRows, onDocumentClick },
		};
		return module.exports;
	},
});
