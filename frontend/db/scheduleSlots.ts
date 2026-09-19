import * as Crypto from "expo-crypto";
import { getDatabase } from "./database";

export interface Slot {
  id: string;
  label: string;
  start_time: string;
  end_time: string;
  order_index: number;
  days: string[];
  notes?: string | null;
  specific_date?: string | null;
}

export interface SlotInput {
  label: string;
  start_time: string;
  end_time: string;
  order_index: number;
  days: string[];
  notes?: string | null;
  specific_date?: string | null;
}

export interface SlotUpdate {
  label?: string;
  start_time?: string;
  end_time?: string;
  order_index?: number;
  days?: string[];
  notes?: string | null;
  // "" is the explicit "clear this field" sentinel (mirrors the old
  // backend's convention) since undefined already means "not provided".
  specific_date?: string;
}

interface SlotRow {
  id: string;
  label: string;
  start_time: string;
  end_time: string;
  order_index: number;
  days: string;
  specific_date: string | null;
  notes: string | null;
}

function rowToSlot(row: SlotRow): Slot {
  return {
    id: row.id,
    label: row.label,
    start_time: row.start_time,
    end_time: row.end_time,
    order_index: row.order_index,
    days: JSON.parse(row.days),
    notes: row.notes,
    specific_date: row.specific_date,
  };
}

export async function getScheduleSlots(): Promise<Slot[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<SlotRow>(
    `SELECT id, label, start_time, end_time, order_index, days, specific_date, notes
     FROM schedule_slots ORDER BY order_index ASC`
  );
  return rows.map(rowToSlot);
}

export async function createScheduleSlot(data: SlotInput): Promise<Slot> {
  const db = await getDatabase();
  const id = Crypto.randomUUID();
  await db.runAsync(
    `INSERT INTO schedule_slots (id, label, icon, start_time, end_time, "group", order_index, days, specific_date, notes)
     VALUES (?, ?, 'clock', ?, ?, 'general', ?, ?, ?, ?)`,
    id,
    data.label,
    data.start_time,
    data.end_time,
    data.order_index,
    JSON.stringify(data.days),
    data.specific_date ?? null,
    data.notes ?? null
  );
  return {
    id,
    label: data.label,
    start_time: data.start_time,
    end_time: data.end_time,
    order_index: data.order_index,
    days: data.days,
    notes: data.notes ?? null,
    specific_date: data.specific_date ?? null,
  };
}

export async function updateScheduleSlot(id: string, updates: SlotUpdate): Promise<Slot> {
  const db = await getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.label !== undefined) { fields.push("label = ?"); values.push(updates.label); }
  if (updates.start_time !== undefined) { fields.push("start_time = ?"); values.push(updates.start_time); }
  if (updates.end_time !== undefined) { fields.push("end_time = ?"); values.push(updates.end_time); }
  if (updates.order_index !== undefined) { fields.push("order_index = ?"); values.push(updates.order_index); }
  if (updates.days !== undefined) { fields.push("days = ?"); values.push(JSON.stringify(updates.days)); }
  if (updates.notes !== undefined) { fields.push("notes = ?"); values.push(updates.notes); }
  if (updates.specific_date !== undefined) {
    fields.push("specific_date = ?");
    values.push(updates.specific_date === "" ? null : updates.specific_date);
  }

  if (fields.length === 0) throw new Error("No update data provided");

  values.push(id);
  const result = await db.runAsync(
    `UPDATE schedule_slots SET ${fields.join(", ")} WHERE id = ?`,
    ...values
  );
  if (result.changes === 0) throw new Error("Slot not found");

  const row = await db.getFirstAsync<SlotRow>(
    `SELECT id, label, start_time, end_time, order_index, days, specific_date, notes
     FROM schedule_slots WHERE id = ?`,
    id
  );
  if (!row) throw new Error("Slot not found");
  return rowToSlot(row);
}

export async function deleteScheduleSlot(id: string): Promise<void> {
  const db = await getDatabase();
  const result = await db.runAsync(`DELETE FROM schedule_slots WHERE id = ?`, id);
  if (result.changes === 0) throw new Error("Slot not found");
}

/** Wipes all activities (used by Settings' "Clear Routine" and "Reset all data"). */
export async function deleteAllScheduleSlots(): Promise<number> {
  const db = await getDatabase();
  const result = await db.runAsync(`DELETE FROM schedule_slots`);
  return result.changes;
}
