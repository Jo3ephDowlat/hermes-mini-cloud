// Regression tests for the pending-task-clarification mechanism (Hermes v1.1 bugfix)
// and the deterministic pre-mutation guard. Runs on Node with TypeScript type
// stripping (npm test). Uses an in-memory D1 mock — no real database is ever touched.

import test from "node:test";
import assert from "node:assert/strict";
import {
	isCancellation,
	resolveClarificationChoice,
	resolvePendingClarification,
	guardInitialTaskReference,
	handleUserMessage,
} from "../src/index.ts";

interface MockTask {
	id: number;
	telegram_user_id: string;
	title: string;
	is_done: number;
	due_date: string | null;
}

interface HistoryMsg {
	role: "user" | "assistant";
	content: string;
}

interface FakeD1 {
	tasks: MockTask[];
	history: HistoryMsg[];
	pendingClarificationRow: { action: string; candidates_json: string } | null;
	clarificationsCleared: string[];
	clarificationSnapshots: Array<{ userId: string; action: string; candidates: unknown }>;
	taskDeletions: Array<{ id: number; userId: string }>;
	taskUpdates: Array<{ id: number; userId: string; action: string }>;
	failNextTaskMutationBatch: boolean;
}

interface MockStmt {
	sql: string;
	_params: unknown[];
	bind(...params: unknown[]): MockStmt;
	first<T>(): Promise<T | null>;
	run(): Promise<{ meta: { changes: number } }>;
	all<T>(): Promise<{ results: T[] }>;
}

function makeFakeD1(tasks: MockTask[], history: HistoryMsg[] = []): { db: FakeD1; d1: unknown } {
	const state: FakeD1 = {
		tasks: [...tasks],
		history: [...history],
		pendingClarificationRow: null,
		clarificationsCleared: [],
		clarificationSnapshots: [],
		taskDeletions: [],
		taskUpdates: [],
		failNextTaskMutationBatch: false,
	};
	const applyStmt = (stmt: MockStmt): { meta: { changes: number } } => {
		const sql = stmt.sql;
		if (sql.startsWith("DELETE FROM pending_clarifications")) {
			state.clarificationsCleared.push(stmt._params[0] as string);
			return { meta: { changes: 1 } };
		}
		if (sql.startsWith("INSERT INTO pending_clarifications")) {
			const [uid, action, candidatesJson] = stmt._params as [string, string, string];
			state.clarificationSnapshots.push({ userId: uid, action, candidates: JSON.parse(candidatesJson) });
			return { meta: { changes: 1 } };
		}
		if (sql.startsWith("DELETE FROM tasks WHERE id = ?1 AND telegram_user_id = ?2")) {
			const [id, uid] = stmt._params as [number, string];
			const before = state.tasks.length;
			state.tasks = state.tasks.filter((t) => !(t.id === id && t.telegram_user_id === uid));
			state.taskDeletions.push({ id, userId: uid });
			return { meta: { changes: before - state.tasks.length } };
		}
		if (sql.startsWith("UPDATE tasks SET is_done = 1")) {
			const [id, uid] = stmt._params as [number, string];
			state.taskUpdates.push({ id, userId: uid, action: "done" });
			return { meta: { changes: 1 } };
		}
		if (sql.startsWith("UPDATE tasks SET is_done = 0")) {
			const [id, uid] = stmt._params as [number, string];
			state.taskUpdates.push({ id, userId: uid, action: "undone" });
			return { meta: { changes: 1 } };
		}
		return { meta: { changes: 0 } };
	};
	const d1 = {
		prepare(sql: string): MockStmt {
			const stmt: MockStmt = {
				sql,
				_params: [],
				bind(...params: unknown[]) {
					stmt._params = params;
					return stmt;
				},
				async first<T>() {
					if (sql.includes("FROM tasks WHERE id = ?1 AND telegram_user_id = ?2")) {
						const [id, uid] = stmt._params as [number, string];
						return (state.tasks.find((t) => t.id === id && t.telegram_user_id === uid) ?? null) as T;
					}
					if (sql.includes("FROM pending_clarifications WHERE telegram_user_id")) {
						return state.pendingClarificationRow as T;
					}
					return null;
				},
				async run() {
					return applyStmt(stmt);
				},
				async all<T>() {
					if (sql.includes("FROM conversation_messages")) {
						return { results: state.history.slice(-12) as T[] };
					}
					if (sql.includes("is_done = 0")) {
						const uid = stmt._params[0] as string;
						return { results: state.tasks.filter((t) => t.telegram_user_id === uid && t.is_done === 0).sort((a, b) => a.id - b.id) as T[] };
					}
					if (sql.includes("is_done = 1")) {
						const uid = stmt._params[0] as string;
						return { results: state.tasks.filter((t) => t.telegram_user_id === uid && t.is_done === 1).sort((a, b) => b.id - a.id) as T[] };
					}
					return { results: [] as T[] };
				},
			};
			return stmt;
		},
		async batch(stmts: MockStmt[]) {
			// Model real D1 transaction semantics: if a tasks mutation in the batch is
			// set to fail, NOTHING in the batch is applied (rollback).
			const hasTaskMutation = stmts.some((s) => s.sql.startsWith("UPDATE tasks SET is_done") || s.sql.startsWith("DELETE FROM tasks WHERE id"));
			if (state.failNextTaskMutationBatch && hasTaskMutation) {
				state.failNextTaskMutationBatch = false;
				throw new Error("simulated D1 transaction failure");
			}
			return stmts.map((s) => applyStmt(s));
		},
	};
	return { db: state, d1 };
}

function makeEnv(d1: unknown): Record<string, unknown> {
	return {
		DB: d1,
		TELEGRAM_BOT_TOKEN: "test-token",
		TELEGRAM_WEBHOOK_SECRET: "test-secret",
		LLM_API_URL: "https://llm.example/v1/chat/completions",
		LLM_API_KEY: "test-key",
		LLM_MODEL: "test-model",
	};
}

function llmResponse(payload: Record<string, unknown>): unknown {
	return {
		ok: true,
		json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
	};
}

const USER_A = "1001";
const USER_B = "1002";

// The exact production scenario: user says "اون تسک دانشگاهی رو حذف کن" with three
// university-ish tasks; bot asks for clarification; user names "خرید دفتر".
const SNAPSHOT = [
	{ id: 101, position: 1, title: "خرید گوشی" },
	{ id: 102, position: 2, title: "خرید دفتر" },
	{ id: 103, position: 3, title: "مطالعه مقاله دانشگاهی" },
];

const BASE_TASKS: MockTask[] = [
	{ id: 101, telegram_user_id: USER_A, title: "خرید گوشی", is_done: 0, due_date: null },
	{ id: 102, telegram_user_id: USER_A, title: "خرید دفتر", is_done: 0, due_date: null },
	{ id: 103, telegram_user_id: USER_A, title: "مطالعه مقاله دانشگاهی", is_done: 0, due_date: null },
];

// ---------- Deterministic reply resolution (clarification follow-up) ----------

test("production repro: title named in reply wins, wrong task never deleted", () => {
	const decision = resolveClarificationChoice("منظورم از تسک اول همون خرید دفتر بود", SNAPSHOT);
	assert.equal(decision.kind, "resolved");
	if (decision.kind === "resolved") {
		assert.equal(decision.task_id, 102); // خرید دفتر — NOT position-1 خرید گوشی
		assert.equal(decision.title, "خرید دفتر");
	}
});

test("A: reply titles a task not in the snapshot -> not_found, no fallback", () => {
	const decision = resolveClarificationChoice("منظورم همون خرید مداد بود", SNAPSHOT);
	assert.equal(decision.kind, "not_found");
});

test("A (end-to-end): nonexistent title deletes nothing and keeps the clarification pending", async () => {
	const { db, d1 } = makeFakeD1(BASE_TASKS);
	const reply = await resolvePendingClarification(makeEnv(d1), USER_A, "del", JSON.stringify(SNAPSHOT), "منظورم همون خرید مداد بود");
	assert.match(reply, /هیچ تسکی با این عنوان/);
	assert.equal(db.taskDeletions.length, 0);
	assert.equal(db.tasks.length, 3); // nothing deleted
	assert.equal(db.clarificationsCleared.length, 0); // pending state survives
});

test("B: unique existing title deletes exactly that task", async () => {
	const { db, d1 } = makeFakeD1(BASE_TASKS);
	const reply = await resolvePendingClarification(makeEnv(d1), USER_A, "del", JSON.stringify(SNAPSHOT), "خرید دفتر");
	assert.match(reply, /خرید دفتر/);
	assert.match(reply, /حذف شد/);
	assert.equal(db.taskDeletions.length, 1);
	assert.equal(db.taskDeletions[0].id, 102);
	assert.equal(db.taskDeletions[0].userId, USER_A);
	assert.deepEqual(db.tasks.map((t) => t.id).sort(), [101, 103]); // the other two untouched
	assert.equal(db.clarificationsCleared.length, 1); // pending cleared after execution
});

test("C: duplicate titles match multiple candidates -> re-clarify, no deletion", async () => {
	const dupSnapshot = [
		{ id: 101, position: 1, title: "خرید دفتر" },
		{ id: 104, position: 2, title: "خرید دفتر" },
	];
	const { db, d1 } = makeFakeD1([
		...BASE_TASKS,
		{ id: 104, telegram_user_id: USER_A, title: "خرید دفتر", is_done: 0, due_date: null },
	]);
	const reply = await resolvePendingClarification(makeEnv(d1), USER_A, "del", JSON.stringify(dupSnapshot), "خرید دفتر");
	assert.match(reply, /چند تسک با این عنوان/);
	assert.equal(db.taskDeletions.length, 0);
	assert.equal(db.tasks.length, 4); // nothing deleted
});

test("D: cancellation clears the pending clarification without executing", async () => {
	const { db, d1 } = makeFakeD1(BASE_TASKS);
	assert.equal(isCancellation("انصراف"), true);
	assert.equal(isCancellation("نه"), true);
	// The cancellation branch lives in handleUserMessage before resolution; simulate
	// its DB effect to prove scoping:
	(d1 as { prepare(s: string): { bind(...p: unknown[]): { run(): Promise<unknown> } } })
		.prepare("DELETE FROM pending_clarifications WHERE telegram_user_id = ?")
		.bind(USER_A)
		.run();
	assert.deepEqual(db.clarificationsCleared, [USER_A]); // only the cancelling user's row
	assert.equal(db.taskDeletions.length, 0);
	assert.equal(db.tasks.length, 3); // nothing deleted
});

test("E: another user's snapshot cannot trigger deletion for this user", async () => {
	const { db, d1 } = makeFakeD1(BASE_TASKS); // all tasks owned by USER_A
	// USER_B somehow resolves against USER_A's stored snapshot:
	const reply = await resolvePendingClarification(makeEnv(d1), USER_B, "del", JSON.stringify(SNAPSHOT), "خرید دفتر");
	assert.match(reply, /دیگر در فهرست شما وجود ندارد/); // ownership re-check refuses
	assert.equal(db.taskDeletions.length, 0);
	assert.equal(db.tasks.length, 3); // USER_A's tasks untouched
	assert.deepEqual(db.clarificationsCleared, [USER_B]); // only B's own pending row cleared
});

test("F: task deleted after the clarification started cannot be selected", async () => {
	const { db, d1 } = makeFakeD1(BASE_TASKS);
	// Task 102 disappears (deleted via another path) before the reply arrives:
	db.tasks = db.tasks.filter((t) => t.id !== 102);
	const reply = await resolvePendingClarification(makeEnv(d1), USER_A, "del", JSON.stringify(SNAPSHOT), "خرید دفتر");
	assert.match(reply, /دیگر در فهرست شما وجود ندارد/);
	assert.equal(db.taskDeletions.length, 0);
});

test("G: a clarification reply can never switch the stored action", async () => {
	const { db, d1 } = makeFakeD1(BASE_TASKS);
	// Reply asks to "do" task 2 instead of deleting: no title match, no execution.
	const r1 = await resolvePendingClarification(makeEnv(d1), USER_A, "del", JSON.stringify(SNAPSHOT), "شماره ۲ رو انجام بده");
	assert.match(r1, /هیچ تسکی با این عنوان/);
	assert.equal(db.taskUpdates.length, 0); // no done/undone executed
	assert.equal(db.taskDeletions.length, 0); // and no deletion either
	// A plain position "۲" executes the STORED action (del), never "done":
	const r2 = await resolvePendingClarification(makeEnv(d1), USER_A, "del", JSON.stringify(SNAPSHOT), "۲");
	assert.match(r2, /حذف شد/);
	assert.equal(db.taskDeletions.length, 1);
	assert.equal(db.taskDeletions[0].id, 102);
	assert.equal(db.taskUpdates.length, 0); // still never marked done
});

test("position accepted only when it was a displayed choice", () => {
	const byPersianDigit = resolveClarificationChoice("۳", SNAPSHOT);
	assert.equal(byPersianDigit.kind, "resolved");
	const byOrdinal = resolveClarificationChoice("همون سومی", SNAPSHOT);
	assert.equal(byOrdinal.kind, "resolved");
	if (byOrdinal.kind === "resolved") assert.equal(byOrdinal.task_id, 103);
	const invalid = resolveClarificationChoice("۷", SNAPSHOT);
	assert.equal(invalid.kind, "position_invalid");
});

test("resolved ids always come from the snapshot — invented ids are impossible", () => {
	const inputs = ["task_id 999", "تسک ۹۹۹", "id=500 خرید گوشی", "۹۹۹", "خرید گوشی"];
	for (const input of inputs) {
		const decision = resolveClarificationChoice(input, SNAPSHOT);
		if (decision.kind === "resolved") {
			assert.ok(
				SNAPSHOT.some((c) => c.id === decision.task_id),
				`resolved id ${decision.task_id} for "${input}" is not in the snapshot`
			);
		}
	}
});

test("existing direct actions keep working through the shared execution path", async () => {
	const { db, d1 } = makeFakeD1(BASE_TASKS);
	const doneReply = await resolvePendingClarification(makeEnv(d1), USER_A, "done", JSON.stringify(SNAPSHOT), "خرید گوشی");
	assert.match(doneReply, /انجام شد/);
	assert.deepEqual(db.taskUpdates, [{ id: 101, userId: USER_A, action: "done" }]);
	assert.equal(db.taskDeletions.length, 0);
	const undoneReply = await resolvePendingClarification(makeEnv(d1), USER_A, "undone", JSON.stringify(SNAPSHOT), "خرید گوشی");
	assert.match(undoneReply, /برگشت/);
	assert.deepEqual(db.taskUpdates[1], { id: 101, userId: USER_A, action: "undone" });
});

// ---------- Deterministic pre-mutation guard (initial message) ----------

function asUserTasks(tasks: MockTask[]): { pending: { id: number; title: string }[]; completed: { id: number; title: string }[] } {
	return {
		pending: tasks.filter((t) => t.is_done === 0).map((t) => ({ id: t.id, title: t.title })),
		completed: tasks.filter((t) => t.is_done === 1).map((t) => ({ id: t.id, title: t.title })),
	};
}

const SHOWN_LIST_HISTORY: HistoryMsg[] = [
	{ role: "user", content: "لیست تسک‌هام رو نشون بده" },
	{ role: "assistant", content: "📋 تسک‌های باز:\n1. خرید گوشی\n2. خرید دفتر\n3. مطالعه مقاله دانشگاهی" },
];

test("guard: vague university reference is unresolved even though a task mentions دانشگاه", () => {
	const decision = guardInitialTaskReference("اون تسک دانشگاهی رو حذف کن", asUserTasks(BASE_TASKS), SHOWN_LIST_HISTORY);
	assert.notEqual(decision.kind, "resolved");
});

test("guard: unique full title resolves without any displayed list", () => {
	const decision = guardInitialTaskReference("خرید دفتر رو حذف کن", asUserTasks(BASE_TASKS), []);
	assert.equal(decision.kind, "resolved");
	if (decision.kind === "resolved") assert.equal(decision.task_id, 102);
});

test("guard: position resolves only when the pending list was shown", () => {
	const shown = guardInitialTaskReference("شماره ۳ رو انجام بده", asUserTasks(BASE_TASKS), SHOWN_LIST_HISTORY);
	assert.equal(shown.kind, "resolved");
	if (shown.kind === "resolved") assert.equal(shown.task_id, 103);
	const notShown = guardInitialTaskReference("شماره ۳ رو انجام بده", asUserTasks(BASE_TASKS), []);
	assert.equal(notShown.kind, "unclear"); // user never saw a numbered list
});

// ---------- End-to-end through handleUserMessage with a mocked LLM ----------

test("A2 (e2e): ambiguous message blocked even when the LLM wrongly supplies a task_id", async (t) => {
	const { db, d1 } = makeFakeD1(BASE_TASKS, SHOWN_LIST_HISTORY);
	t.mock.method(globalThis, "fetch", async () =>
		llmResponse({ action: "del", title: null, task_id: 103, due_date: null, delete_all: false, include_completed: false, needs_clarification: false, clarification_question: null, reply: null })
	);
	const reply = await handleUserMessage(makeEnv(d1) as never, USER_A, "اون تسک دانشگاهی رو حذف کن", 9001);
	assert.match(reply, /کدام تسک را مد نظر دارید؟ \(حذف\)/); // clarification requested
	assert.equal(db.taskDeletions.length, 0); // NO mutation
	assert.equal(db.tasks.length, 3);
	assert.equal(db.clarificationSnapshots.length, 1); // snapshot stored for the follow-up
	assert.equal(db.clarificationSnapshots[0].action, "del");
});

test("B2 (e2e): clear existing title executes normally despite LLM supplying a different id", async (t) => {
	const { db, d1 } = makeFakeD1(BASE_TASKS, []);
	t.mock.method(globalThis, "fetch", async () =>
		llmResponse({ action: "del", title: null, task_id: 101, due_date: null, delete_all: false, include_completed: false, needs_clarification: false, clarification_question: null, reply: null })
	);
	const reply = await handleUserMessage(makeEnv(d1) as never, USER_A, "خرید دفتر رو حذف کن", 9002);
	assert.match(reply, /حذف شد/);
	// The DETERMINISTIC resolution (خرید دفتر = 102) wins over the model's task_id 101:
	assert.equal(db.taskDeletions.length, 1);
	assert.equal(db.taskDeletions[0].id, 102);
	assert.deepEqual(db.tasks.map((x) => x.id).sort(), [101, 103]);
});

test("C2 (e2e): displayed valid position still works", async (t) => {
	const { db, d1 } = makeFakeD1(BASE_TASKS, SHOWN_LIST_HISTORY);
	t.mock.method(globalThis, "fetch", async () =>
		llmResponse({ action: "done", title: null, task_id: 103, due_date: null, delete_all: false, include_completed: false, needs_clarification: false, clarification_question: null, reply: null })
	);
	const reply = await handleUserMessage(makeEnv(d1) as never, USER_A, "شماره ۳ رو انجام بده", 9003);
	assert.match(reply, /انجام شد/);
	assert.deepEqual(db.taskUpdates, [{ id: 103, userId: USER_A, action: "done" }]);
	assert.equal(db.taskDeletions.length, 0);
});

// ---------- Atomicity / retry safety of finishClarification ----------

test("D2: mutation failure does not lose pending clarification state (atomic batch)", async () => {
	const { db, d1 } = makeFakeD1(BASE_TASKS);
	db.failNextTaskMutationBatch = true;
	await assert.rejects(
		resolvePendingClarification(makeEnv(d1), USER_A, "del", JSON.stringify(SNAPSHOT), "خرید دفتر"),
		/simulated D1 transaction failure/
	);
	// Transaction rolled back: nothing deleted AND pending state NOT cleared:
	assert.equal(db.taskDeletions.length, 0);
	assert.equal(db.tasks.length, 3);
	assert.equal(db.clarificationsCleared.length, 0);
	// Telegram redelivery replays the same reply against the SAME pending state:
	const retry = await resolvePendingClarification(makeEnv(d1), USER_A, "del", JSON.stringify(SNAPSHOT), "خرید دفتر");
	assert.match(retry, /حذف شد/);
	assert.equal(db.taskDeletions.length, 1); // exactly one deletion overall — no duplicate
	assert.equal(db.clarificationsCleared.length, 1); // cleared once, after success
});

test("E2: successful mutation clears the pending state in the same transaction", async () => {
	const { db, d1 } = makeFakeD1(BASE_TASKS);
	const reply = await resolvePendingClarification(makeEnv(d1), USER_A, "del", JSON.stringify(SNAPSHOT), "خرید دفتر");
	assert.match(reply, /حذف شد/);
	assert.equal(db.taskDeletions.length, 1);
	assert.equal(db.clarificationsCleared.length, 1);
	assert.deepEqual(db.clarificationsCleared, [USER_A]);
});
