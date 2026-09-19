import { getDatabase } from "./database";
import {
  RawTask,
  Activity,
  Diag,
  DisplayBucket,
  Recommendation,
  TimeOfDayResult,
  normalizeTask,
  computeMetrics,
  buildDisplayBuckets,
  computeHeavyDayPattern,
  followThroughDiagnosis,
  lostTimeDiagnosis,
  timeOfDayDiagnosis,
  combineDiagnostics,
} from "./analyticsEngine";

export interface HistoryRecord {
  date: string;
  done: number;
  total: number;
  pct: number;
}

export interface DayProgress {
  date: string;
  day: number;
  total: number;
  completed: number;
  percentage: number;
  tracked: boolean;
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

function addDaysStr(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

/** Local equivalent of GET /api/history?days=N&today=... — recent-days
 * completion counts, used by History's "Recent" list. */
export async function getHistory(days: number, todayStr: string): Promise<HistoryRecord[]> {
  const db = await getDatabase();
  const records: HistoryRecord[] = [];

  for (let i = 0; i < days; i++) {
    const dateStr = addDaysStr(todayStr, -i);
    const rows = await db.getAllAsync<{ completed: number }>(
      `SELECT completed FROM daily_tasks WHERE date = ?`, dateStr
    );
    const total = rows.length;
    const done = rows.filter(r => r.completed === 1).length;
    const pct = total > 0 ? Math.round((done / total) * 1000) / 10 : 0;
    records.push({ date: dateStr, done, total, pct });
  }

  return records;
}

/** Local equivalent of GET /api/monthly-progress/{year}/{month}. Days with no
 * daily_tasks rows yet are reported with tracked=false and an "expected"
 * total computed from the current Routine template, same as the backend. */
export async function getMonthlyProgress(year: number, month: number): Promise<DayProgress[]> {
  const db = await getDatabase();
  const numDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const progress: DayProgress[] = [];

  const slots = await db.getAllAsync<{ id: string; days: string; specific_date: string | null }>(
    `SELECT id, days, specific_date FROM schedule_slots`
  );

  for (let day = 1; day <= numDays; day++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const rows = await db.getAllAsync<{ completed: number }>(
      `SELECT completed FROM daily_tasks WHERE date = ?`, dateStr
    );

    if (rows.length > 0) {
      const total = rows.length;
      const completed = rows.filter(r => r.completed === 1).length;
      progress.push({
        date: dateStr, day, total, completed,
        percentage: Math.round((completed / total) * 100),
        tracked: true,
      });
    } else {
      const dayAbbr = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(dateStr + "T00:00:00Z").getUTCDay()];
      let expected = 0;
      for (const slot of slots) {
        if (slot.specific_date) {
          if (slot.specific_date === dateStr) expected += 1;
        } else {
          const slotDays: string[] = JSON.parse(slot.days);
          if (slotDays.includes(dayAbbr)) expected += 1;
        }
      }
      progress.push({ date: dateStr, day, total: expected, completed: 0, percentage: 0, tracked: false });
    }
  }

  return progress;
}

function rowToRawTask(row: TaskRow): RawTask {
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

export interface TrendsPayload {
  range: number;
  follow_through: { buckets: DisplayBucket[]; diagnostic: Diag };
  lost_time: { diagnostic: Diag; activities: Activity[]; selected: Activity | null };
  time_of_day: TimeOfDayResult;
  recommendation: Recommendation;
}

/** Local equivalent of GET /api/analytics/trends. clientNow is the device's
 * local timestamp (YYYY-MM-DDTHH:MM[:SS]); tzOffsetMinutes matches
 * Date.prototype.getTimezoneOffset(). */
export async function getAnalyticsTrends(
  rangeInput: number,
  clientNow: string,
  tzOffsetMinutes: number
): Promise<TrendsPayload> {
  const db = await getDatabase();
  const rangeDays = rangeInput === 7 || rangeInput === 30 || rangeInput === 90 ? rangeInput : 30;

  const nowDt = new Date(clientNow.length > 10 ? clientNow : clientNow + "T00:00:00");
  const clientToday = clientNow.slice(0, 10);
  const nowMinutes = nowDt.getHours() * 60 + nowDt.getMinutes();

  const rangeStart = addDaysStr(clientToday, -(rangeDays - 1));
  const rows = await db.getAllAsync<TaskRow>(
    `SELECT * FROM daily_tasks WHERE date >= ? AND date <= ?`, rangeStart, clientToday
  );

  const tasks = rows.map(r => normalizeTask(rowToRawTask(r), clientToday, nowMinutes));

  const displayBucketsRaw = buildDisplayBuckets(tasks, rangeDays, clientToday);
  const displayBuckets: DisplayBucket[] = displayBucketsRaw.map(b => ({
    label: b.label, start_date: b.start_date, end_date: b.end_date,
    metrics: computeMetrics(b.tasks, tzOffsetMinutes),
  }));
  const heavyPattern = computeHeavyDayPattern(tasks);

  const ftDiag = followThroughDiagnosis(tasks, rangeDays, clientToday, displayBuckets, heavyPattern);
  const followThrough = { buckets: displayBuckets, diagnostic: ftDiag };

  const lostTime = lostTimeDiagnosis(tasks, tzOffsetMinutes);

  // Narrow exception mirroring the backend: Time of Day needs the selected
  // activity's *current* schedule time, which lives in schedule_slots.
  let currentSlotStartTime: string | null = null;
  if (lostTime.selected) {
    const slot = await db.getFirstAsync<{ start_time: string }>(
      `SELECT start_time FROM schedule_slots WHERE id = ?`, lostTime.selected.slot_id
    );
    if (slot) currentSlotStartTime = slot.start_time;
  }

  const timeOfDay = timeOfDayDiagnosis(tasks, lostTime.selected, currentSlotStartTime, tzOffsetMinutes);
  const recommendation = combineDiagnostics(ftDiag, lostTime, timeOfDay, rangeDays);

  return { range: rangeDays, follow_through: followThrough, lost_time: lostTime, time_of_day: timeOfDay, recommendation };
}
