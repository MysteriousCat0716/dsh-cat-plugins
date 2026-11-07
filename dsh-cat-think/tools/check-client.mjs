// Offline check for dsh-cat-think/lib/client.js.
//
// Replays the behaviours asked for:
//   1. a new reasoning row opens by itself,
//   2. when the renderer folds it at the end of the segment it opens again and
//      stays open after all thinking is done,
//   3. rows the plugin opened fold when the next segment starts, rows the user
//      opened by hand do not,
//   4. a row the user folded by hand stays folded,
//   5. opening more rows by hand leaves the earlier ones open,
//   6. rows collapse at the start of the next session, and history rows
//      rendered on page load are left untouched.
//
// Run: node tools/check-client.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "lib", "client.js"), "utf8");

// ---- DOM stub -----------------------------------------------------------

const clickListeners = [];

class StubRow {
	constructor() {
		this.attrs = new Map();
		this.children = [];
		const row = this;
		this.switch = {
			attrs: new Map(),
			click() {
				// Capture listeners run before the renderer toggles the attribute,
				// exactly like a real click (capture phase, then the target).
				for (const listener of clickListeners) {
					listener({ target: row });
				}
				if (row.attrs.has("data-expanded")) row.attrs.delete("data-expanded");
				else row.attrs.set("data-expanded", "");
			},
		};
		this.switch.attrs.set("aria-expanded", "false");
	}
	getAttribute(name) {
		return this.attrs.has(name) ? this.attrs.get(name) : null;
	}
	setAttribute(name, value) {
		this.attrs.set(name, value);
	}
	hasAttribute(name) {
		return this.attrs.has(name);
	}
	querySelector(selector) {
		return selector === "[aria-expanded]" ? this.switch : null;
	}
	closest(selector) {
		return selector === '[data-variant="think"]' ? this : null;
	}
	get firstElementChild() {
		return this.children.length > 0 ? this.children[0] : this.switch;
	}
	// Screen position of the row: document offset minus the scroll container offset.
	getBoundingClientRect() {
		return { top: rowTop(this) - scroller.scrollTop, bottom: 0, height: 0 };
	}
}

const rows = [];

// Layout model: an expanded row is 100px tall, a folded one 20px, so folding a
// row above another moves the lower one up by 80px.
const ROW_OPEN_HEIGHT = 100;
const ROW_CLOSED_HEIGHT = 20;
function rowTop(row) {
	let top = 0;
	for (const candidate of rows) {
		if (candidate === row) return top;
		top += candidate.attrs.has("data-expanded") ? ROW_OPEN_HEIGHT : ROW_CLOSED_HEIGHT;
	}
	return top;
}

// 真实的 DSH 对话区由内部 div 滚动，window 不滚动；桩里用同一个滚动容器模拟。
const scroller = {
	scrollTop: 200,
	scrollHeight: 2000,
	clientHeight: 500,
	parentElement: null,
};

const document = {
	documentElement: {},
	querySelectorAll(selector) {
		return selector === '[data-variant="think"]' ? rows : [];
	},
	querySelector(selector) {
		return selector === '[data-variant="think"]' ? (rows.length > 0 ? rows[rows.length - 1] : null) : null;
	},
	addEventListener(type, listener) {
		if (type === "click") clickListeners.push(listener);
	},
};

class StubObserver {
	constructor(callback) {
		this.callback = callback;
	}
	observe() {}
}

let descriptor = null;
const scrollCalls = [];
const window = {
	location: { search: "", href: "http://127.0.0.1:1/?session=a" },
	scrollY: 0,
	scrollBy(x, y) {
		scrollCalls.push(y);
		this.scrollY += y;
	},
	getComputedStyle(node) {
		return { overflowY: node === scroller ? "auto" : "visible" };
	},
	__ModuleLoader__: {
		load(value) {
			descriptor = value;
		},
	},
};

// Timers are queued, not run inline: a real click's settle timer only fires
// after the renderer has toggled data-expanded.
const queuedTimers = [];
function flush() {
	while (queuedTimers.length > 0) {
		const fn = queuedTimers.shift();
		fn();
	}
}

const context = vm.createContext({
	window,
	document,
	MutationObserver: StubObserver,
	URLSearchParams,
	setTimeout: (fn) => {
		queuedTimers.push(fn);
		return queuedTimers.length;
	},
	clearTimeout: () => {},
	requestAnimationFrame: (fn) => {
		queuedTimers.push(fn);
		return queuedTimers.length;
	},
	Date,
	console,
});

vm.runInContext(source, context, { filename: "client.js" });

if (descriptor === null) {
	console.error("FAIL: __ModuleLoader__.load was not called");
	process.exit(1);
}

const exported = descriptor.factory(() => ({}));
const api = exported._internals;
exported.apply();

// ---- scenarios ----------------------------------------------------------

let failures = 0;

function addRow(state, open = false) {
	const row = new StubRow();
	row.setAttribute("data-state", state);
	row.setAttribute("data-variant", "think");
	if (open) row.setAttribute("data-expanded", "");
	row.parentElement = scroller;
	rows.push(row);
	return row;
}

// The renderer folds a row when its segment closes.
function finishRow(row) {
	row.setAttribute("data-state", "ok");
	row.attrs.delete("data-expanded");
}

function switchSession(id) {
	rows.length = 0;
	window.location.href = `http://127.0.0.1:1/?session=${id}`;
}

function userClick(row) {
	row.switch.click();
	flush();
}

function assert(label, condition) {
	if (condition) {
		console.log(`PASS ${label}`);
	} else {
		failures += 1;
		console.log(`FAIL ${label}`);
	}
}

// 0. First pass sees history rows only: nothing is opened.
const old1 = addRow("ok");
const old2 = addRow("ok");
api.sweep();
assert("history rows stay closed on load", api.isOpen(old1) === false && api.isOpen(old2) === false);

// 1. A new running segment opens itself.
const first = addRow("running");
api.sweep();
assert("new running row expands", api.isOpen(first) === true);

// 2. The renderer folds the row when the segment ends; the plugin re-opens it.
finishRow(first);
api.sweep();
assert("finished row is re-opened after the renderer folds it", api.isOpen(first) === true);

// 3. Repeated passes during tool calls keep it open.
api.sweep();
api.sweep();
assert("row stays open after all thinking is done", api.isOpen(first) === true);

// 4. A manual fold is respected and survives later passes.
userClick(first);
api.sweep();
assert("manual fold is respected", api.isOpen(first) === false);

// 5. The user opens it again by hand: that choice must survive the next segment.
userClick(first);
api.sweep();
assert("manual expand is respected", api.isOpen(first) === true);

// 6. A new segment folds rows the plugin opened, keeps rows the user opened.
const second = addRow("running");
api.sweep();
assert("user-opened row stays open when the next segment starts", api.isOpen(first) === true);
assert("new row expands", api.isOpen(second) === true);

// 7. The second (last) segment ends and stays open.
finishRow(second);
api.sweep();
assert("last row stays open after all thinking is done", api.isOpen(second) === true);

// 8. A row the plugin opened earlier is folded by the next segment.
const third = addRow("running");
api.sweep();
assert("auto-opened previous row folds on the next segment", api.isOpen(second) === false);
assert("user-opened row still open", api.isOpen(first) === true);
assert("third row expands", api.isOpen(third) === true);

// 9. Opening another row by hand leaves the previous manual one alone.
userClick(old1);
api.sweep();
assert("manual open of a history row works", api.isOpen(old1) === true);
assert("previously opened row stays open", api.isOpen(first) === true);

// 9b. A second manual open keeps both rows open, with no scroll compensation.
userClick(old2);
api.sweep();
assert("second manual open works", api.isOpen(old2) === true);
assert("earlier manual row stays open", api.isOpen(old1) === true);

// 10. Switching sessions collapses the rows of the previous session.
switchSession("b");
api.sweep();
assert("session switch clears the rows", rows.length === 0);

// 11. History rows of the new session are left alone.
const newOld = addRow("ok");
api.sweep();
assert("history rows of the new session stay closed", api.isOpen(newOld) === false);

// 12. A new segment in the new session opens itself again.
const fourth = addRow("running");
api.sweep();
assert("new session segment expands", api.isOpen(fourth) === true);

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
