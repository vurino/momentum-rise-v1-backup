import { getDatabase } from "./database";

const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_DAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export interface ExportedSlot {
  id: string;
  label: string;
  icon: string;
  start_time: string;
  end_time: string;
  group: string;
  order_index: number;
  days: string[];
  specific_date: string | null;
  notes: string | null;
}

export interface ExportedTask {
  id: string;
  date: string;
  slot_id: string;
  completed: boolean;
  skipped: boolean;
  stopped: boolean;
  auto_skipped: boolean;
  notes: string | null;
  name: string | null;
  start_time: string | null;
  end_time: string | null;
  duration: number | null;
  started_at: string | null;
  completed_at: string | null;
  stopped_at: string | null;
}

export interface BackupFile {
  exported_at: string;
  schedule_slots: ExportedSlot[];
  daily_tasks: ExportedTask[];
}

export async function exportAllData(): Promise<BackupFile> {
  const db = await getDatabase();

  const slotRows = await db.getAllAsync<{
    id: string; label: string; icon: string; start_time: string; end_time: string;
    "group": string; order_index: number; days: string; specific_date: string | null; notes: string | null;
  }>(`SELECT id, label, icon, start_time, end_time, "group", order_index, days, specific_date, notes
      FROM schedule_slots ORDER BY order_index ASC`);

  const taskRows = await db.getAllAsync<{
    id: string; date: string; slot_id: string; completed: number; skipped: number;
    stopped: number; auto_skipped: number; notes: string | null; name: string | null;
    start_time: string | null; end_time: string | null; duration: number | null;
    started_at: string | null; completed_at: string | null; stopped_at: string | null;
  }>(`SELECT * FROM daily_tasks ORDER BY date ASC`);

  return {
    exported_at: new Date().toISOString(),
    schedule_slots: slotRows.map(r => ({
      id: r.id, label: r.label, icon: r.icon, start_time: r.start_time, end_time: r.end_time,
      group: r["group"], order_index: r.order_index, days: JSON.parse(r.days),
      specific_date: r.specific_date, notes: r.notes,
    })),
    daily_tasks: taskRows.map(r => ({
      id: r.id, date: r.date, slot_id: r.slot_id,
      completed: !!r.completed, skipped: !!r.skipped, stopped: !!r.stopped, auto_skipped: !!r.auto_skipped,
      notes: r.notes, name: r.name, start_time: r.start_time, end_time: r.end_time, duration: r.duration,
      started_at: r.started_at, completed_at: r.completed_at, stopped_at: r.stopped_at,
    })),
  };
}

class ImportValidationError extends Error {}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function isStringOrNull(v: unknown): v is string | null {
  return v === null || v === undefined || typeof v === "string";
}
function isBoolLike(v: unknown): boolean {
  return typeof v === "boolean" || v === undefined || v === null;
}

/** Validates and normalizes one raw slot record. Throws with a specific,
 * user-facing reason on the first problem found — nothing is written to the
 * database until every record in the file has passed this. */
function validateSlot(raw: any, index: number): ExportedSlot {
  if (typeof raw !== "object" || raw === null) {
    throw new ImportValidationError(`Activity #${index + 1} is not a valid entry.`);
  }
  if (!isNonEmptyString(raw.id)) throw new ImportValidationError(`Activity #${index + 1} is missing a valid id.`);
  if (!isNonEmptyString(raw.label)) throw new ImportValidationError(`Activity #${index + 1} ("${raw.id}") is missing a name.`);
  if (!isNonEmptyString(raw.start_time) || !TIME_RE.test(raw.start_time)) {
    throw new ImportValidationError(`Activity "${raw.label}" has an invalid start time.`);
  }
  if (!isNonEmptyString(raw.end_time) || !TIME_RE.test(raw.end_time)) {
    throw new ImportValidationError(`Activity "${raw.label}" has an invalid end time.`);
  }
  if (typeof raw.order_index !== "number" || !Number.isFinite(raw.order_index)) {
    throw new ImportValidationError(`Activity "${raw.label}" has an invalid order.`);
  }
  let days: string[] = ALL_DAYS;
  if (raw.days !== undefined && raw.days !== null) {
    if (!Array.isArray(raw.days) || !raw.days.every((d: unknown) => typeof d === "string" && VALID_DAYS.has(d))) {
      throw new ImportValidationError(`Activity "${raw.label}" has an invalid days list.`);
    }
    days = raw.days;
  }
  if (raw.specific_date !== undefined && raw.specific_date !== null && !(typeof raw.specific_date === "string" && DATE_RE.test(raw.specific_date))) {
    throw new ImportValidationError(`Activity "${raw.label}" has an invalid specific date.`);
  }
  if (!isStringOrNull(raw.notes)) throw new ImportValidationError(`Activity "${raw.label}" has an invalid notes field.`);

  return {
    id: raw.id,
    label: raw.label,
    icon: isNonEmptyString(raw.icon) ? raw.icon : "clock",
    start_time: raw.start_time,
    end_time: raw.end_time,
    group: isNonEmptyString(raw.group) ? raw.group : "general",
    order_index: raw.order_index,
    days,
    specific_date: raw.specific_date ?? null,
    notes: raw.notes ?? null,
  };
}

function validateTask(raw: any, index: number): ExportedTask {
  if (typeof raw !== "object" || raw === null) {
    throw new ImportValidationError(`Task #${index + 1} is not a valid entry.`);
  }
  if (!isNonEmptyString(raw.id)) throw new ImportValidationError(`Task #${index + 1} is missing a valid id.`);
  if (!isNonEmptyString(raw.date) || !DATE_RE.test(raw.date)) {
    throw new ImportValidationError(`Task "${raw.id}" has an invalid date.`);
  }
  if (!isNonEmptyString(raw.slot_id)) throw new ImportValidationError(`Task "${raw.id}" is missing its activity reference.`);
  if (!isBoolLike(raw.completed) || !isBoolLike(raw.skipped) || !isBoolLike(raw.stopped) || !isBoolLike(raw.auto_skipped)) {
    throw new ImportValidationError(`Task "${raw.id}" has an invalid status field.`);
  }
  for (const field of ["notes", "name", "start_time", "end_time", "started_at", "completed_at", "stopped_at"]) {
    if (!isStringOrNull(raw[field])) throw new ImportValidationError(`Task "${raw.id}" has an invalid "${field}" field.`);
  }
  if (raw.duration !== undefined && raw.duration !== null && (typeof raw.duration !== "number" || !Number.isFinite(raw.duration))) {
    throw new ImportValidationError(`Task "${raw.id}" has an invalid duration.`);
  }

  return {
    id: raw.id,
    date: raw.date,
    slot_id: raw.slot_id,
    completed: !!raw.completed,
    skipped: !!raw.skipped,
    stopped: !!raw.stopped,
    auto_skipped: !!raw.auto_skipped,
    notes: raw.notes ?? null,
    name: raw.name ?? null,
    start_time: raw.start_time ?? null,
    end_time: raw.end_time ?? null,
    duration: raw.duration ?? null,
    started_at: raw.started_at ?? null,
    completed_at: raw.completed_at ?? null,
    stopped_at: raw.stopped_at ?? null,
  };
}

/** Validates a whole backup file (throws a specific, human-readable reason
 * on the first problem found) and, only if every record passes, replaces
 * all current data inside a single transaction — an invalid or corrupted
 * file is rejected before anything is touched, and if anything still goes
 * wrong mid-write, the transaction rolls back automatically rather than
 * leaving a half-imported state. */
export async function importAllData(
  rawSlots: unknown,
  rawTasks: unknown
): Promise<{ schedule_slots_imported: number; daily_tasks_imported: number }> {
  if (!Array.isArray(rawSlots)) throw new ImportValidationError("Backup file's activities list is missing or malformed.");
  if (!Array.isArray(rawTasks)) throw new ImportValidationError("Backup file's tasks list is missing or malformed.");
  if (rawSlots.length > 5000) throw new ImportValidationError("Backup file has an implausible number of activities.");
  if (rawTasks.length > 500000) throw new ImportValidationError("Backup file has an implausible number of tasks.");

  const slots = rawSlots.map(validateSlot);
  const tasks = rawTasks.map(validateTask);

  const slotIds = new Set<string>();
  for (const s of slots) {
    if (slotIds.has(s.id)) throw new ImportValidationError(`Duplicate activity id "${s.id}" in backup file.`);
    slotIds.add(s.id);
  }
  const taskIds = new Set<string>();
  for (const t of tasks) {
    if (taskIds.has(t.id)) throw new ImportValidationError(`Duplicate task id "${t.id}" in backup file.`);
    taskIds.add(t.id);
  }

  const db = await getDatabase();

  await db.withTransactionAsync(async () => {
    await db.runAsync(`DELETE FROM schedule_slots`);
    await db.runAsync(`DELETE FROM daily_tasks`);
    // A stale "cleared today" marker from before the import would otherwise
    // silently block Today from regenerating tasks for any imported activity
    // that happens to reuse one of the old slot ids (e.g. re-importing an
    // earlier export of the same data) — an import should always start clean.
    await db.runAsync(`DELETE FROM app_meta WHERE key = 'cleared_today_date'`);

    for (const s of slots) {
      await db.runAsync(
        `INSERT INTO schedule_slots (id, label, icon, start_time, end_time, "group", order_index, days, specific_date, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s.id, s.label, s.icon, s.start_time, s.end_time, s.group, s.order_index,
        JSON.stringify(s.days), s.specific_date, s.notes
      );
    }

    for (const t of tasks) {
      await db.runAsync(
        `INSERT INTO daily_tasks (id, date, slot_id, completed, skipped, stopped, auto_skipped, notes, name, start_time, end_time, duration, started_at, completed_at, stopped_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t.id, t.date, t.slot_id, t.completed ? 1 : 0, t.skipped ? 1 : 0, t.stopped ? 1 : 0, t.auto_skipped ? 1 : 0,
        t.notes, t.name, t.start_time, t.end_time, t.duration, t.started_at, t.completed_at, t.stopped_at
      );
    }
  });

  return { schedule_slots_imported: slots.length, daily_tasks_imported: tasks.length };
}
