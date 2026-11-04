// Tests for persistent natural-language reminders (Hermes v2, phase 1).
// All D1 and Telegram interactions are mocked — no real database or API is touched.

import test from "node:test";
import assert from "node:assert/strict";
import { deliverDueReminders, executeReminder, parseLLMAction } from "../src/index.ts";

const NOW_MS = 1_700_000_000_000;
const NOW = Math.floor(NOW_MS / 1000);
const USER = "1001";

interface ReminderRow {
	id: number;
	telegram_user_id: string;
	message: string;
	due_at: number;
	status: "pending" | "claimed" | "sent" | "cancelled" | "failed";
	created_at: number;
	claimed_at: number | null;
	sent_at: number | null;
	attempt_count: number;
	next_attempt_at: number | null;
}

interface FakeState {
	reminders: ReminderRow[];
	authorized: Set<string>;
	nextId: number;
	telegramCalls: Array<{ url: string; body: string }>;
	telegramOk: boolean;
}

function baseState(): FakeState {
	return { reminders: [], authorized: new Set([USER]), nextId: 1, telegramCalls: [], telegramOk: true };
}

function seed(state: FakeState, row: Partial<ReminderRow>): ReminderRow {
	const full: ReminderRow = {
		id: state.nextId++,
		telegram_user_id: USER,
		message: "یادآوری تست",
		due_at: NOW - 5,
		status: "pending",
		created_at: NOW - 60,
		claimed_at: null,
		sent_at: null,
		attempt_count: 0,
		next_attempt_at: null,
		...row,
	};
	state.reminders.push(full);
	return full;
}

// Stateful in-memory D1 mock replicating the exact statement shapes used by the
// reminders code, including compare-and-set claim semantics.
function makeD1(state: FakeState): unknown {
	return {
		prepare(sql: string) {
			const stmt = {
				sql,
				p: [] as unknown[],
				bind(...params: unknown[]) {
					stmt.p = params;
					return stmt;
				},
				async first<T>() {
					if (sql.includes("FROM authorized_users")) {
						const uid = stmt.p[0] as string;
						return (state.authorized.has(uid) ? 1 : null) as T;
					}
					return null as T;
				},
				async run() {
					if (sql.startsWith("INSERT INTO reminders")) {
						const [uid, message, due_at, created_at] = stmt.p as [string, string, number, number];
						state.reminders.push({
							id: state.nextId++,
							telegram_user_id: uid,
							message,
							due_at,
							status: "pending",
							created_at,
							claimed_at: null,
							sent_at: null,
							attempt_count: 0,
							next_attempt_at: null,
						});
						return { meta: { changes: 1 } };
					}
					// stale-claim recovery: counts as a failed attempt (bounded at 5)
					if (sql.startsWith("UPDATE reminders") && sql.includes("attempt_count = attempt_count + 1")) {
						const [now, cutoff] = stmt.p as [number, number];
						let n = 0;
						for (const r of state.reminders) {
							if (r.status === "claimed" && r.claimed_at !== null && r.claimed_at < cutoff) {
								r.attempt_count += 1;
								if (r.attempt_count >= 5) {
									r.status = "failed";
									r.next_attempt_at = null;
								} else {
									r.status = "pending";
									r.next_attempt_at = now + 60 * r.attempt_count;
								}
								r.claimed_at = null;
								n++;
							}
						}
						return { meta: { changes: n } };
					}
					// CAS claim
					if (sql.startsWith("UPDATE reminders SET status = 'claimed'")) {
						const [claimed_at, id] = stmt.p as [number, number];
						const row = state.reminders.find((r) => r.id === id && r.status === "pending");
						if (!row) return { meta: { changes: 0 } };
						row.status = "claimed";
						row.claimed_at = claimed_at;
						return { meta: { changes: 1 } };
					}
					if (sql.startsWith("UPDATE reminders SET status = 'cancelled'")) {
						const [id] = stmt.p as [number];
						const row = state.reminders.find((r) => r.id === id && r.status === "claimed");
						if (!row) return { meta: { changes: 0 } };
						row.status = "cancelled";
						return { meta: { changes: 1 } };
					}
					if (sql.startsWith("UPDATE reminders SET status = 'failed'")) {
						const [attempts, id] = stmt.p as [number, number];
						const row = state.reminders.find((r) => r.id === id && r.status === "claimed");
						if (!row) return { meta: { changes: 0 } };
						row.status = "failed";
						row.attempt_count = attempts;
						row.claimed_at = null;
						row.next_attempt_at = null;
						return { meta: { changes: 1 } };
					}
					if (sql.startsWith("UPDATE reminders SET status = 'pending', attempt_count")) {
						const [attempts, next_attempt_at, id] = stmt.p as [number, number, number];
						const row = state.reminders.find((r) => r.id === id && r.status === "claimed");
						if (!row) return { meta: { changes: 0 } };
						row.status = "pending";
						row.attempt_count = attempts;
						row.claimed_at = null;
						row.next_attempt_at = next_attempt_at;
						return { meta: { changes: 1 } };
					}
					if (sql.startsWith("UPDATE reminders SET status = 'sent'")) {
						const [sent_at, id] = stmt.p as [number, number];
						const row = state.reminders.find((r) => r.id === id && r.status === "claimed");
						if (!row) return { meta: { changes: 0 } };
						row.status = "sent";
						row.sent_at = sent_at;
						return { meta: { changes: 1 } };
					}
					// release claim by id (delivery failure)
					if (sql.startsWith("UPDATE reminders SET status = 'pending', claimed_at = NULL WHERE id")) {
						const [id] = stmt.p as [number];
						const row = state.reminders.find((r) => r.id === id && r.status === "claimed");
						if (!row) return { meta: { changes: 0 } };
						row.status = "pending";
						row.claimed_at = null;
						return { meta: { changes: 1 } };
					}
					return { meta: { changes: 0 } };
				},
				async all<T>() {
					if (sql.includes("FROM reminders WHERE status = 'pending' AND due_at")) {
						const [now, limit] = stmt.p as [number, number];
						const rows = state.reminders
							.filter(
								(r) =>
									r.status === "pending" &&
									r.due_at <= now &&
									(r.next_attempt_at === null || r.next_attempt_at <= now)
							)
							.sort((a, b) => a.due_at - b.due_at)
							.slice(0, limit)
							.map((r) => ({
								id: r.id,
								telegram_user_id: r.telegram_user_id,
								message: r.message,
								attempt_count: r.attempt_count,
							}));
						return { results: rows as T[] };
					}
					return { results: [] as T[] };
				},
			};
			return stmt;
		},
		async batch() {
			throw new Error("batch is not expected in reminder delivery");
		},
	};
}

function mockTelegram(t: test.TestContext, state: FakeState): void {
	t.mock.method(globalThis, "fetch", async (url: unknown, init?: { body?: unknown }) => {
		state.telegramCalls.push({ url: String(url), body: String(init?.body ?? "") });
		return { ok: state.telegramOk, status: state.telegramOk ? 200 : 500 } as Response;
	});
}

function reminderIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		action: "remind",
		title: null,
		task_id: null,
		due_date: null,
		delete_all: false,
		include_completed: false,
		reminder_text: "به مامان زنگ بزن",
		delay_minutes: 10,
		needs_clarification: false,
		clarification_question: null,
		reply: null,
		...overrides,
	};
}

// ---------- intent parsing ----------

test("remind intent parses reminder text and integer delay", () => {
	const parsed = parseLLMAction(reminderIntent({ reminder_text: " آب بخورم ", delay_minutes: 10 }));
	assert.ok(parsed);
	assert.equal(parsed.action, "remind");
	assert.equal(parsed.reminder_text, "آب بخورم");
	assert.equal(parsed.delay_minutes, 10);
});

test("non-integer, zero or missing delays do not parse as valid delays", () => {
	for (const delay_minutes of [1.5, 0, undefined]) {
		const parsed = parseLLMAction(reminderIntent({ delay_minutes }));
		assert.ok(parsed);
		assert.equal(parsed.delay_minutes, null, `delay ${delay_minutes} must not parse as valid`);
	}
});

test("unknown actions are still rejected by the parser", () => {
	assert.equal(parseLLMAction(reminderIntent({ action: "alarm" })), null);
});

// ---------- creation & strict validation ----------

test("valid reminder is persisted with UTC unix due timestamp and Persian confirmation", async () => {
	const state = baseState();
	const reply = await executeReminder({ DB: makeD1(state) } as never, USER, reminderIntent() as never, NOW_MS);
	assert.equal(state.reminders.length, 1);
	const row = state.reminders[0];
	assert.equal(row.telegram_user_id, USER);
	assert.equal(row.message, "به مامان زنگ بزن");
	assert.equal(row.due_at, NOW + 600); // worker computes due_at, not the LLM
	assert.equal(row.created_at, NOW);
	assert.equal(row.status, "pending");
	assert.equal(row.sent_at, null);
	assert.match(reply, /به مامان زنگ بزن/);
	assert.match(reply, /10 دقیقه/);
});

test("hourly delays are converted to minutes (two hours = 120)", async () => {
	const state = baseState();
	const reply = await executeReminder({ DB: makeD1(state) } as never, USER, reminderIntent({ delay_minutes: 120 }) as never, NOW_MS);
	assert.equal(state.reminders[0].due_at, NOW + 7200);
	assert.match(reply, /2 ساعت/);
});

test("delay label keeps exact hours and minutes (90 minutes = 1 ساعت و 30 دقیقه)", async () => {
	const state = baseState();
	const reply = await executeReminder({ DB: makeD1(state) } as never, USER, reminderIntent({ delay_minutes: 90 }) as never, NOW_MS);
	assert.equal(state.reminders[0].due_at, NOW + 5400);
	assert.match(reply, /1 ساعت و 30 دقیقه/);
});

test("invalid delays are rejected without creating a reminder", async () => {
	for (const delay_minutes of [0, -5, 1.5, 43_201, null]) {
		const state = baseState();
		const reply = await executeReminder({ DB: makeD1(state) } as never, USER, reminderIntent({ delay_minutes }) as never, NOW_MS);
		assert.equal(state.reminders.length, 0, `delay ${delay_minutes} must not create a row`);
		assert.match(reply, /معتبر نیست/);
	}
});

test("invalid reminder text is rejected without creating a reminder", async () => {
	const state = baseState();
	const blank = await executeReminder({ DB: makeD1(state) } as never, USER, reminderIntent({ reminder_text: "   " }) as never, NOW_MS);
	assert.equal(state.reminders.length, 0);
	assert.match(blank, /چه چیزی/);

	const state2 = baseState();
	const tooLong = await executeReminder(
		{ DB: makeD1(state2) } as never,
		USER,
		reminderIntent({ reminder_text: "x".repeat(501) }) as never,
		NOW_MS
	);
	assert.equal(state2.reminders.length, 0);
	assert.match(tooLong, /طولانی/);
});

// ---------- scheduled delivery ----------

test("due reminders are delivered once, marked sent, and never delivered twice", async (t) => {
	const state = baseState();
	seed(state, { message: "به مامان زنگ بزن", due_at: NOW - 5 });
	mockTelegram(t, state);
	const d1 = makeD1(state);
	const stats = await deliverDueReminders({ DB: d1, TELEGRAM_BOT_TOKEN: "test-token" } as never, NOW_MS);
	assert.deepEqual(stats, { sent: 1, failed: 0, skipped: 0 });
	assert.equal(state.telegramCalls.length, 1);
	assert.ok(state.telegramCalls[0].url.includes("api.telegram.org"));
	assert.match(state.telegramCalls[0].body, /⏰ یادآوری: به مامان زنگ بزن/);
	assert.equal(state.reminders[0].status, "sent");
	assert.equal(state.reminders[0].sent_at, NOW);

	// Duplicate-processing check: a second cron run must not deliver again.
	const stats2 = await deliverDueReminders({ DB: d1, TELEGRAM_BOT_TOKEN: "test-token" } as never, NOW_MS);
	assert.deepEqual(stats2, { sent: 0, failed: 0, skipped: 0 });
	assert.equal(state.telegramCalls.length, 1);
});

test("a reminder claimed by a concurrent run is skipped via CAS (no double delivery)", async (t) => {
	const state = baseState();
	seed(state, { message: "همزمان", due_at: NOW - 5, status: "claimed", claimed_at: NOW - 1 });
	mockTelegram(t, state);
	const stats = await deliverDueReminders({ DB: makeD1(state), TELEGRAM_BOT_TOKEN: "test-token" } as never, NOW_MS);
	assert.equal(stats.sent, 0);
	assert.equal(state.telegramCalls.length, 0); // another run owns the fresh claim
	assert.equal(state.reminders[0].status, "claimed");
});

test("telegram failure schedules a linear backoff retry and never marks sent", async (t) => {
	const state = baseState();
	seed(state, { message: "شکست", due_at: NOW - 5 });
	state.telegramOk = false;
	mockTelegram(t, state);
	const d1 = makeD1(state);
	const stats = await deliverDueReminders({ DB: d1, TELEGRAM_BOT_TOKEN: "test-token" } as never, NOW_MS);
	assert.deepEqual(stats, { sent: 0, failed: 1, skipped: 0 });
	assert.equal(state.reminders[0].status, "pending");
	assert.equal(state.reminders[0].attempt_count, 1);
	assert.equal(state.reminders[0].next_attempt_at, NOW + 60);
	assert.equal(state.reminders[0].sent_at, null);

	// Before the backoff elapses the reminder is not even selected:
	const early = await deliverDueReminders({ DB: d1, TELEGRAM_BOT_TOKEN: "test-token" } as never, NOW_MS);
	assert.equal(early.sent, 0);
	assert.equal(state.telegramCalls.length, 1);

	state.telegramOk = true;
	// After the backoff elapses exactly one retry happens:
	const stats2 = await deliverDueReminders({ DB: d1, TELEGRAM_BOT_TOKEN: "test-token" } as never, NOW_MS + 60_000);
	assert.equal(stats2.sent, 1);
	assert.equal(state.reminders[0].status, "sent");
	assert.equal(state.reminders[0].attempt_count, 1);
	assert.equal(state.telegramCalls.length, 2); // exactly one retry — no duplicate sends
});

test("reminders stop retrying after 5 failed attempts and are marked failed", async (t) => {
	const state = baseState();
	seed(state, { message: "ناتمام", due_at: NOW - 5, attempt_count: 4 });
	state.telegramOk = false;
	mockTelegram(t, state);
	const stats = await deliverDueReminders({ DB: makeD1(state), TELEGRAM_BOT_TOKEN: "test-token" } as never, NOW_MS);
	assert.deepEqual(stats, { sent: 0, failed: 1, skipped: 0 });
	assert.equal(state.reminders[0].status, "failed");
	assert.equal(state.reminders[0].attempt_count, 5);
	assert.equal(state.reminders[0].next_attempt_at, null);
	assert.equal(state.telegramCalls.length, 1);

	// A failed reminder is never retried again, no matter how much time passes:
	const stats2 = await deliverDueReminders({ DB: makeD1(state), TELEGRAM_BOT_TOKEN: "test-token" } as never, NOW_MS + 3_600_000);
	assert.deepEqual(stats2, { sent: 0, failed: 0, skipped: 0 });
	assert.equal(state.telegramCalls.length, 1);
	assert.equal(state.reminders[0].status, "failed");
});

test("fresh claims within the 16-minute threshold are left alone (Cron may run 15 minutes)", async (t) => {
	const state = baseState();
	seed(state, { message: "در حال ارسال", due_at: NOW - 900, status: "claimed", claimed_at: NOW - 900 });
	mockTelegram(t, state);
	const stats = await deliverDueReminders({ DB: makeD1(state), TELEGRAM_BOT_TOKEN: "test-token" } as never, NOW_MS);
	assert.equal(stats.sent, 0);
	assert.equal(state.telegramCalls.length, 0);
	assert.equal(state.reminders[0].status, "claimed");
});

test("stale claims older than 16 minutes are recovered (counted as an attempt) and delivered after backoff", async (t) => {
	const state = baseState();
	seed(state, { message: "گمشده", due_at: NOW - 1000, status: "claimed", claimed_at: NOW - 961 });
	mockTelegram(t, state);
	const d1 = makeD1(state);
	const stats = await deliverDueReminders({ DB: d1, TELEGRAM_BOT_TOKEN: "test-token" } as never, NOW_MS);
	assert.equal(stats.sent, 0); // backoff defers the retried delivery
	assert.equal(state.reminders[0].status, "pending");
	assert.equal(state.reminders[0].attempt_count, 1);
	assert.equal(state.reminders[0].next_attempt_at, NOW + 60);
	const stats2 = await deliverDueReminders({ DB: d1, TELEGRAM_BOT_TOKEN: "test-token" } as never, NOW_MS + 60_000);
	assert.equal(stats2.sent, 1);
	assert.equal(state.reminders[0].status, "sent");
});

test("repeated crashes cannot cause unlimited retries: recovery caps at 5 attempts", async (t) => {
	const state = baseState();
	seed(state, { message: "تصادفی", due_at: NOW + 100_000 }); // not due — scan never sends; pure crash-recovery cycles
	mockTelegram(t, state);
	const d1 = makeD1(state);
	for (let i = 0; i < 5; i++) {
		const tMs = NOW_MS + i * 200_000;
		// the previous invocation died mid-delivery, leaving a stale claim:
		state.reminders[0].status = "claimed";
		state.reminders[0].claimed_at = Math.floor(tMs / 1000) - 1000;
		const stats = await deliverDueReminders({ DB: d1, TELEGRAM_BOT_TOKEN: "test-token" } as never, tMs);
		assert.equal(stats.sent, 0);
	}
	assert.equal(state.reminders[0].status, "failed");
	assert.equal(state.reminders[0].attempt_count, 5);
	assert.equal(state.telegramCalls.length, 0); // a crashed loop never sent anything
});

test("reminders of unauthorized users are cancelled without any Telegram call", async (t) => {
	const state = baseState();
	state.authorized = new Set(); // owner was revoked from the whitelist
	seed(state, { message: "خصوصی", due_at: NOW - 5 });
	mockTelegram(t, state);
	const stats = await deliverDueReminders({ DB: makeD1(state), TELEGRAM_BOT_TOKEN: "test-token" } as never, NOW_MS);
	assert.equal(stats.skipped, 1);
	assert.equal(state.telegramCalls.length, 0);
	assert.equal(state.reminders[0].status, "cancelled");
});

test("not-yet-due reminders are left untouched", async (t) => {
	const state = baseState();
	seed(state, { message: "آینده", due_at: NOW + 600 });
	mockTelegram(t, state);
	const stats = await deliverDueReminders({ DB: makeD1(state), TELEGRAM_BOT_TOKEN: "test-token" } as never, NOW_MS);
	assert.deepEqual(stats, { sent: 0, failed: 0, skipped: 0 });
	assert.equal(state.telegramCalls.length, 0);
	assert.equal(state.reminders[0].status, "pending");
});
