import * as Crypto from "expo-crypto";
import { getDatabase } from "./database";

export interface Task {
  id: string;
  date: string;
  slot_id: string;
  completed: boolean;
  skipped: boolean;
  stopped: boolean;
  auto_skipped: boolean;
  notes?: string | null;
  name?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  duration?: number | null;
  started_at?: string | null;
  completed_at?: string | null;
  stopped_at?: string | null;
}

export interface TaskUpdate {
  completed?: boolean;
  skipped?: boolean;
  stopped?: boolean;
  auto_skipped?: boolean;
  notes?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  stopped_at?: string | null;
}

interface TaskRow {
  id: string;
  date: string;
  slot_id: string;
  completed: number;
  skipped: number;
  stopped: number;
  auto_skipped: number;
  notes: string | null;
  name: string | null;
  start_time: string | null;
  end_time: string | null;
  duration: number | null;
  started_at: string | null;
  completed_at: string | null;
  stopped_at: string | null;
}

interface SlotRow {
  id: string;
  label: string;
  start_time: string;
  end_time: string;
  days: string;
  specific_date: string | null;
  notes: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    date: row.date,
    slot_id: row.slot_id,
    completed: !!row.completed,
    skipped: !!row.skipped,
    stopped: !!row.stopped,
    auto_skipped: !!row.auto_skipped,
    notes: row.notes,
    name: row.name,
    start_time: row.start_time,
    end_time: row.end_time,
    duration: row.duration,
    started_at: row.started_at,
    completed_at: row.completed_at,
    stopped_at: row.stopped_at,
  };
}

const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function getDayAbbr(dateStr: string): string {
  // new Date("YYYY-MM-DD") parses as UTC midnight; getUTCDay keeps that
  // consistent regardless of the device's own timezone offset.
  const d = new Date(dateStr + "T00:00:00Z");
  const jsDay = d.getUTCDay(); // 0=Sun..6=Sat
  return ALL_DAYS[(jsDay + 6) % 7]; // convert to 0=Mon..6=Sun
}

function slotDurationMinutes(startTime: string, endTime: string): number {
  const [sh, sm] = startTime.split(":").map(Number);
  const [eh, em] = endTime.split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return mins;
}

/** Refreshes name/start_time/end_time/duration on each row from the
 * *current* Routine slot, same as the old backend's _enrich_tasks_with_
 * slot_info did on every read — editing or reordering an activity in
 * Routine should be reflected on an already-generated day's task. notes is
 * deliberately left untouched: it's seeded from the slot once, then becomes
 * this task's own per-day, user-editable field. If the source slot no
 * longer exists (deleted from Routine), the row is left as last known. */
async function enrichWithSlotInfo(
  db: Awaited<ReturnType<typeof getDatabase>>,
  rows: TaskRow[]
): Promise<TaskRow[]> {
  const slotIds = Array.from(new Set(rows.map(r => r.slot_id)));
  if (slotIds.length === 0) return rows;

  const placeholders = slotIds.map(() => "?").join(",");
  const slots = await db.getAllAsync<{ id: string; label: string; start_time: string; end_time: string }>(
    `SELECT id, label, start_time, end_time FROM schedule_slots WHERE id IN (${placeholders})`,
    ...slotIds
  );
  const slotsById = new Map<string, { id: string; label: string; start_time: string; end_time: string }>(
    slots.map(s => [s.id, s])
  );

  return rows.map(r => {
    const slot = slotsById.get(r.slot_id);
    if (!slot) return r;
    return {
      ...r,
      name: slot.label,
      start_time: slot.start_time,
      end_time: slot.end_time,
      duration: slotDurationMinutes(slot.start_time, slot.end_time),
    };
  });
}

/** Fetches (and lazily generates from the Routine template) the tasks for
 * one date — the local equivalent of the old GET /api/daily-tasks/{date}.
 * clientToday, when passed, resolves any still-open task on an already-past
 * date to skipped (auto_skipped), same as the backend used to. */
export async function getDailyTasks(dateStr: string, clientToday?: string): Promise<Task[]> {
  const db = await getDatabase();

  let rows = await db.getAllAsync<TaskRow>(
    `SELECT * FROM daily_tasks WHERE date = ?`, dateStr
  );

  const marker = await db.getFirstAsync<{ value: string; slot_ids: string }>(
    `SELECT value, slot_ids FROM app_meta WHERE key = 'cleared_today_date'`
  );
  const wasCleared = !!marker && marker.value === dateStr;
  const clearedSlotIds = new Set<string>(wasCleared ? JSON.parse(marker!.slot_ids || "[]") : []);

  const dayAbbr = getDayAbbr(dateStr);
  const slots = await db.getAllAsync<SlotRow>(
    `SELECT id, label, start_time, end_time, days, specific_date, notes
     FROM schedule_slots ORDER BY order_index ASC`
  );
  const existingSlotIds = new Set(rows.map(r => r.slot_id));

  let insertedAny = false;
  for (const slot of slots) {
    if (existingSlotIds.has(slot.id)) continue;
    if (wasCleared && clearedSlotIds.has(slot.id)) continue;

    if (slot.specific_date) {
      if (slot.specific_date !== dateStr) continue;
    } else {
      const slotDays: string[] = JSON.parse(slot.days);
      if (!slotDays.includes(dayAbbr)) continue;
    }

    await db.runAsync(
      `INSERT INTO daily_tasks (id, date, slot_id, completed, skipped, stopped, auto_skipped, notes, name, start_time, end_time, duration, started_at, completed_at, stopped_at)
       VALUES (?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      Crypto.randomUUID(),
      dateStr,
      slot.id,
      slot.notes,
      slot.label,
      slot.start_time,
      slot.end_time,
      slotDurationMinutes(slot.start_time, slot.end_time)
    );
    insertedAny = true;
  }

  if (insertedAny) {
    rows = await db.getAllAsync<TaskRow>(`SELECT * FROM daily_tasks WHERE date = ?`, dateStr);
  }

  if (clientToday && dateStr < clientToday) {
    await db.runAsync(
      `UPDATE daily_tasks SET skipped = 1, auto_skipped = 1
       WHERE date = ? AND completed = 0 AND stopped = 0 AND skipped = 0`,
      dateStr
    );
    rows = await db.getAllAsync<TaskRow>(`SELECT * FROM daily_tasks WHERE date = ?`, dateStr);
  }

  rows = await enrichWithSlotInfo(db, rows);
  return rows.map(rowToTask);
}

export async function updateDailyTask(
  taskId: string,
  updates: TaskUpdate,
  clientToday?: string
): Promise<Task> {
  const db = await getDatabase();

  const existing = await db.getFirstAsync<TaskRow>(`SELECT * FROM daily_tasks WHERE id = ?`, taskId);
  if (!existing) throw new Error("Task not found");

  const statusKeys: (keyof TaskUpdate)[] = ["completed", "skipped", "stopped"];
  const touchesStatus = statusKeys.some(k => updates[k] !== undefined);
  if (touchesStatus) {
    const limit = clientToday ?? isoDatePlusOneDayUTC();
    if (existing.date > limit) {
      throw new Error("Cannot set task status for a future date");
    }
  }

  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  const boolFields: (keyof TaskUpdate)[] = ["completed", "skipped", "stopped", "auto_skipped"];
  const textFields: (keyof TaskUpdate)[] = ["notes", "started_at", "completed_at", "stopped_at"];

  for (const key of boolFields) {
    if (updates[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(updates[key] ? 1 : 0);
    }
  }
  for (const key of textFields) {
    if (updates[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(updates[key] as string | null);
    }
  }

  if (fields.length === 0) throw new Error("No update data provided");

  values.push(taskId);
  await db.runAsync(`UPDATE daily_tasks SET ${fields.join(", ")} WHERE id = ?`, ...values);

  const row = await db.getFirstAsync<TaskRow>(`SELECT * FROM daily_tasks WHERE id = ?`, taskId);
  if (!row) throw new Error("Task not found");
  const [enriched] = await enrichWithSlotInfo(db, [row]);
  return rowToTask(enriched);
}

function isoDatePlusOneDayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

export async function getStreak(todayStr?: string): Promise<number> {
  const db = await getDatabase();
  const base = todayStr ? new Date(todayStr + "T00:00:00Z") : new Date();
  let streak = 0;

  for (let i = 0; i < 365; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - i);
    const dateStr = d.toISOString().split("T")[0];

    const rows = await db.getAllAsync<{ completed: number }>(
      `SELECT completed FROM daily_tasks WHERE date = ?`, dateStr
    );
    if (rows.length === 0) continue;

    const total = rows.length;
    const done = rows.filter(r => r.completed === 1).length;
    if (done < total) break;

    streak += 1;
  }

  return streak;
}

/** Deletes today's (and any later) tasks, and records which activities
 * existed at that moment so they aren't silently regenerated the next time
 * this date is viewed — the local equivalent of DELETE /api/reset/today. */
export async function clearTodayTasks(todayStr: string): Promise<number> {
  const db = await getDatabase();
  const result = await db.runAsync(`DELETE FROM daily_tasks WHERE date >= ?`, todayStr);

  const slots = await db.getAllAsync<{ id: string }>(`SELECT id FROM schedule_slots`);
  const slotIds = JSON.stringify(slots.map(s => s.id));

  await db.runAsync(
    `INSERT INTO app_meta (key, value, slot_ids) VALUES ('cleared_today_date', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, slot_ids = excluded.slot_ids`,
    todayStr,
    slotIds
  );

  return result.changes;
}

export async function deleteAllDailyTasks(): Promise<number> {
  const db = await getDatabase();
  const result = await db.runAsync(`DELETE FROM daily_tasks`);
  return result.changes;
}
