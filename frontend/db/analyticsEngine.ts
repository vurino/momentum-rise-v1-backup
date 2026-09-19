/** TypeScript port of backend/analytics.py — see that file's module docstring
 * for the overall architecture (three independent diagnostics + one combiner).
 * Ported function-for-function, keeping the same names/shape, so behavior can
 * be diffed against the original Python for the same input. Two Python
 * behaviors that don't have a direct JS equivalent are reproduced explicitly:
 * `round()`'s banker's-rounding (ties round to even, not always up), and
 * `sorted(..., reverse=True)`'s stability (ties keep original relative
 * order, not literally-reversed order). */

export interface RawTask {
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

export interface NormalizedTask extends RawTask {
  status: string;
  actual_minutes: number | null;
  lost_minutes: number | null;
  is_legacy_completed: boolean;
  started: boolean;
  eligible: boolean;
  tracked_start_eligible: boolean;
}

export interface Metrics {
  scheduled_count: number;
  completed_count: number;
  incomplete_count: number;
  skipped_count: number;
  missed_count: number;
  started_count: number;
  tracked_eligible_count: number;
  distinct_dates: number;
  scheduled_minutes: number;
  followed_minutes: number;
  lost_minutes: number;
  missed_lost_minutes: number;
  skipped_lost_minutes: number;
  incomplete_lost_minutes: number;
  follow_through_rate: number | null;
  completion_rate: number | null;
  start_rate: number | null;
  completion_after_start: number | null;
  miss_rate: number | null;
  skip_rate: number | null;
  incomplete_rate: number | null;
  avg_scheduled_duration: number | null;
  median_actual_duration: number | null;
  avg_start_delay: number | null;
}

export interface Diag { key: string; text: string; metrics: Record<string, any> }
export interface Bucket { label: string; start_date: string; end_date: string; tasks: NormalizedTask[] }
export interface DisplayBucket { label: string; start_date: string; end_date: string; metrics: Metrics }
export interface Activity extends Metrics { slot_id: string; name: string; dates: string[]; lost_share: number }
export interface LostTimeResult { diagnostic: Diag; activities: Activity[]; selected: Activity | null }
export interface Period extends Metrics { key: string; label: string }
export interface TimeOfDayResult { diagnostic: Diag; periods: Period[] | null; current_period: string | null; current_period_method?: string }
export interface RecAction { type: string; slot_id: string | null; label: string }
export interface Recommendation { title: string; reason: string; experiment: string; success_measure: string; action: RecAction | null }
export interface HeavyPattern {
  heavy_rate: number;
  light_rate: number;
  heavy_lost_share: number;
  heavy_dates: Set<string>;
  light_dates: Set<string>;
}

const RESOLVED_STATUSES = new Set(["completed", "incomplete", "skipped", "missed"]);

// (key, label, start_hour, end_hour). end_hour may exceed 24 to express a
// span that wraps past midnight (Evening: 18:00-05:00 the next day).
const TIME_PERIODS: [string, string, number, number][] = [
  ["early_morning", "Early Morning", 5, 8],
  ["morning", "Morning", 8, 12],
  ["midday", "Midday", 12, 14],
  ["afternoon", "Afternoon", 14, 18],
  ["evening", "Evening", 18, 29],
];

// --- small numeric/date helpers -------------------------------------------

/** Python round(): ties round to even, not always up. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function mean(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}

function dayOfWeekShort(dateStr: string): string {
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const d = new Date(dateStr + "T00:00:00Z");
  return names[d.getUTCDay()];
}

/** ISO-8601 (year, week) for a date, matching Python's date.isocalendar()[:2]. */
function isoWeekInfo(dateStr: string): [number, number] {
  const d = new Date(dateStr + "T00:00:00Z");
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return [d.getUTCFullYear(), weekNum];
}

function distinctWeekCount(dates: string[]): number {
  const weeks = new Set<string>();
  for (const d of dates) {
    const [y, w] = isoWeekInfo(d);
    weeks.add(`${y}-${w}`);
  }
  return weeks.size;
}

function hmToMin(t?: string | null): number {
  if (!t) return 0;
  const parts = t.split(":");
  if (parts.length !== 2) return 0;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

function windowEndMinutes(t: RawTask): number {
  const start = hmToMin(t.start_time);
  let end = hmToMin(t.end_time);
  if (end <= start) end += 24 * 60;
  return end;
}

export function periodForStartTime(startTime?: string | null): string {
  const m = hmToMin(startTime) % (24 * 60);
  if (m >= 5 * 60 && m < 8 * 60) return "early_morning";
  if (m >= 8 * 60 && m < 12 * 60) return "morning";
  if (m >= 12 * 60 && m < 14 * 60) return "midday";
  if (m >= 14 * 60 && m < 18 * 60) return "afternoon";
  return "evening";
}

function parseIso(ts?: string | null): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

function minutesBetween(a?: string | null, b?: string | null): number | null {
  const da = parseIso(a);
  const db = parseIso(b);
  if (da === null || db === null) return null;
  return Math.abs(db.getTime() - da.getTime()) / 60000;
}

function startDelayMinutes(t: RawTask, tzOffsetMinutes: number): number | null {
  const started = parseIso(t.started_at);
  if (started === null) return null;
  const localStarted = new Date(started.getTime() - tzOffsetMinutes * 60000);
  const scheduledMinute = hmToMin(t.start_time);
  const actualMinute = localStarted.getUTCHours() * 60 + localStarted.getUTCMinutes();
  return actualMinute - scheduledMinute;
}

function diag(key: string, text: string, metrics: Record<string, any> = {}): Diag {
  return { key, text, metrics };
}

// --- normalize + metrics ----------------------------------------------------

export function normalizeTask(t: RawTask, clientToday: string, nowMinutes: number | null): NormalizedTask {
  const dateStr = t.date;
  const completed = !!t.completed;
  const stopped = !!t.stopped;
  const skipped = !!t.skipped;
  const startedAt = t.started_at;
  const scheduledMinutes = t.duration || 0;

  let status: string;
  if (completed) status = "completed";
  else if (stopped) status = "incomplete";
  else if (skipped) status = "skipped";
  else if (dateStr < clientToday) status = "missed";
  else if (dateStr > clientToday) status = "scheduled_not_due";
  else {
    const windowEnd = windowEndMinutes(t);
    if (nowMinutes !== null && nowMinutes >= windowEnd) status = "missed";
    else status = startedAt ? "in_progress" : "scheduled_not_due";
  }

  const isLegacyCompleted = completed && !startedAt;

  const clip = (mins: number): number => {
    const clamped = Math.max(0, mins);
    return scheduledMinutes ? Math.min(clamped, scheduledMinutes) : clamped;
  };

  let actualMinutes: number | null;
  let lostMinutes: number | null;

  if (status === "completed") {
    if (isLegacyCompleted) {
      actualMinutes = scheduledMinutes;
    } else {
      const m = minutesBetween(startedAt, t.completed_at);
      actualMinutes = m !== null ? clip(m) : scheduledMinutes;
    }
    lostMinutes = 0;
  } else if (status === "incomplete") {
    const m = minutesBetween(startedAt, t.stopped_at);
    actualMinutes = m !== null ? clip(m) : 0;
    lostMinutes = Math.max(0, scheduledMinutes - actualMinutes);
  } else if (status === "missed") {
    actualMinutes = 0;
    lostMinutes = scheduledMinutes;
  } else if (status === "skipped") {
    actualMinutes = 0;
    lostMinutes = scheduledMinutes;
  } else {
    actualMinutes = null;
    lostMinutes = null;
  }

  const eligible = RESOLVED_STATUSES.has(status);

  return {
    ...t,
    status,
    actual_minutes: actualMinutes,
    lost_minutes: lostMinutes,
    is_legacy_completed: isLegacyCompleted,
    started: startedAt != null,
    eligible,
    tracked_start_eligible: eligible && !isLegacyCompleted,
  };
}

export function computeMetrics(tasks: NormalizedTask[], tzOffsetMinutes: number = 0): Metrics {
  const eligible = tasks.filter(t => t.eligible);
  const completed = eligible.filter(t => t.status === "completed");
  const incomplete = eligible.filter(t => t.status === "incomplete");
  const skipped = eligible.filter(t => t.status === "skipped");
  const missed = eligible.filter(t => t.status === "missed");

  const trackedEligible = eligible.filter(t => t.tracked_start_eligible);
  const started = trackedEligible.filter(t => t.started);
  const completedStarted = started.filter(t => t.status === "completed");

  const scheduledMinutes = eligible.reduce((s, t) => s + (t.duration || 0), 0);
  const followedMinutes = eligible
    .filter(t => t.status === "completed" || t.status === "incomplete")
    .reduce((s, t) => s + (t.actual_minutes || 0), 0);
  const lostMinutes = eligible.reduce((s, t) => s + (t.lost_minutes || 0), 0);
  const missedLostMinutes = missed.reduce((s, t) => s + (t.lost_minutes || 0), 0);
  const skippedLostMinutes = skipped.reduce((s, t) => s + (t.lost_minutes || 0), 0);
  const incompleteLostMinutes = incomplete.reduce((s, t) => s + (t.lost_minutes || 0), 0);

  const durations = eligible
    .filter(t => (t.status === "completed" || t.status === "incomplete") && t.actual_minutes !== null)
    .map(t => t.actual_minutes as number);
  const delays = started
    .map(t => startDelayMinutes(t, tzOffsetMinutes))
    .filter((d): d is number => d !== null);
  const distinctDates = new Set(eligible.map(t => t.date)).size;

  const pct = (n: number, d: number): number | null => (d ? pyRound((n / d) * 100) : null);
  const followThroughRate = scheduledMinutes > 0 ? pyRound((followedMinutes / scheduledMinutes) * 100) : null;

  return {
    scheduled_count: eligible.length,
    completed_count: completed.length,
    incomplete_count: incomplete.length,
    skipped_count: skipped.length,
    missed_count: missed.length,
    started_count: started.length,
    tracked_eligible_count: trackedEligible.length,
    distinct_dates: distinctDates,
    scheduled_minutes: pyRound(scheduledMinutes),
    followed_minutes: pyRound(followedMinutes),
    lost_minutes: pyRound(lostMinutes),
    missed_lost_minutes: pyRound(missedLostMinutes),
    skipped_lost_minutes: pyRound(skippedLostMinutes),
    incomplete_lost_minutes: pyRound(incompleteLostMinutes),
    follow_through_rate: followThroughRate,
    completion_rate: pct(completed.length, eligible.length),
    start_rate: pct(started.length, trackedEligible.length),
    completion_after_start: pct(completedStarted.length, started.length),
    miss_rate: pct(missed.length, eligible.length),
    skip_rate: pct(skipped.length, eligible.length),
    incomplete_rate: pct(incomplete.length, started.length),
    avg_scheduled_duration: eligible.length ? pyRound(mean(eligible.map(t => t.duration || 0))) : null,
    median_actual_duration: durations.length ? pyRound(median(durations)) : null,
    avg_start_delay: delays.length ? pyRound(mean(delays)) : null,
  };
}

function recentImprovement(member: NormalizedTask[]): boolean {
  const ordered = [...member].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (ordered.length < 6) return false;
  const mid = Math.floor(ordered.length / 2);
  const firstRate = computeMetrics(ordered.slice(0, mid)).completion_rate || 0;
  const secondRate = computeMetrics(ordered.slice(mid)).completion_rate || 0;
  return secondRate - firstRate >= 15;
}

// --- display buckets + heavy-day pattern ------------------------------------

export function buildDisplayBuckets(tasks: NormalizedTask[], rangeDays: number, clientToday: string): Bucket[] {
  const end = clientToday;
  const rangeStart = addDays(end, -(rangeDays - 1));
  const spanDays = rangeDays === 90 ? 7 : 1;

  const buckets: Bucket[] = [];
  let cursor = rangeStart;
  while (cursor <= end) {
    const candidateEnd = addDays(cursor, spanDays - 1);
    const bEnd = candidateEnd > end ? end : candidateEnd;
    const dStr = cursor, eStr = bEnd;
    const member = tasks.filter(t => dStr <= t.date && t.date <= eStr);
    let label: string;
    if (spanDays === 1) {
      const day = new Date(cursor + "T00:00:00Z").getUTCDate();
      label = `${dayOfWeekShort(cursor)} ${String(day).padStart(2, "0")}`;
    } else {
      const [, w] = isoWeekInfo(cursor);
      label = `W${w}`;
    }
    buckets.push({ label, start_date: dStr, end_date: eStr, tasks: member });
    cursor = addDays(bEnd, 1);
  }
  return buckets;
}

export function computeHeavyDayPattern(tasks: NormalizedTask[]): HeavyPattern | null {
  const byDate = new Map<string, NormalizedTask[]>();
  for (const t of tasks) {
    if (!t.eligible) continue;
    if (!byDate.has(t.date)) byDate.set(t.date, []);
    byDate.get(t.date)!.push(t);
  }

  const days: (Metrics & { date: string })[] = [];
  for (const [d, dayTasks] of byDate) {
    const m = computeMetrics(dayTasks);
    if (m.scheduled_count === 0) continue;
    days.push({ date: d, ...m });
  }

  if (days.length < 6) return null;

  const daysSorted = [...days].sort((a, b) => a.scheduled_minutes - b.scheduled_minutes);
  const third = Math.floor(daysSorted.length / 3);
  if (third < 2) return null;
  const light = daysSorted.slice(0, third);
  const heavy = daysSorted.slice(daysSorted.length - third);

  const lightMedian = median(light.map(d => d.scheduled_minutes));
  const heavyMedian = median(heavy.map(d => d.scheduled_minutes));
  if (lightMedian <= 0 || heavyMedian < lightMedian * 1.3) return null;

  const lightRates = light.map(d => d.follow_through_rate).filter((r): r is number => r !== null);
  const heavyRates = heavy.map(d => d.follow_through_rate).filter((r): r is number => r !== null);
  if (!lightRates.length || !heavyRates.length) return null;
  const lightAvg = mean(lightRates), heavyAvg = mean(heavyRates);
  if (lightAvg - heavyAvg < 15) return null;

  const totalLost = days.reduce((s, d) => s + d.lost_minutes, 0) || 1;
  const heavyLostShare = (heavy.reduce((s, d) => s + d.lost_minutes, 0) / totalLost) * 100;
  if (heavyLostShare < 35) return null;

  return {
    heavy_rate: pyRound(heavyAvg),
    light_rate: pyRound(lightAvg),
    heavy_lost_share: pyRound(heavyLostShare),
    heavy_dates: new Set(heavy.map(d => d.date)),
    light_dates: new Set(light.map(d => d.date)),
  };
}

// --- 1. Follow-Through -------------------------------------------------------

function diagnosticWindows(
  tasks: NormalizedTask[], rangeDays: number, clientToday: string
): [NormalizedTask[], NormalizedTask[]] | [null, null] {
  const end = clientToday;
  const rangeStart = addDays(end, -(rangeDays - 1));

  if (rangeDays === 7) {
    const activeDates = Array.from(new Set(tasks.filter(t => t.eligible).map(t => t.date))).sort();
    if (activeDates.length < 7) return [null, null];
    const earlierDates = new Set(activeDates.slice(0, 3));
    const laterDates = new Set(activeDates.slice(-4));
    return [tasks.filter(t => earlierDates.has(t.date)), tasks.filter(t => laterDates.has(t.date))];
  }

  if (rangeDays === 30) {
    const mid = addDays(rangeStart, 14);
    const earlier = tasks.filter(t => rangeStart <= t.date && t.date <= mid);
    const laterStart = addDays(mid, 1);
    const later = tasks.filter(t => laterStart <= t.date && t.date <= end);
    return [earlier, later];
  }

  const chunkEnds: string[] = [];
  let cursor = end;
  while (addDays(cursor, -6) >= rangeStart) {
    chunkEnds.push(cursor);
    cursor = addDays(cursor, -7);
  }
  chunkEnds.reverse();
  if (chunkEnds.length < 13) return [null, null];
  const earlierChunks = chunkEnds.slice(0, 6);
  const laterChunks = chunkEnds.slice(-7);

  const chunkTasks = (chunkEnd: string): NormalizedTask[] => {
    const chunkStart = addDays(chunkEnd, -6);
    return tasks.filter(t => chunkStart <= t.date && t.date <= chunkEnd);
  };

  return [earlierChunks.flatMap(chunkTasks), laterChunks.flatMap(chunkTasks)];
}

function windowEvidenceOk(m: Metrics): boolean {
  return m.scheduled_count >= 3 && m.distinct_dates >= 2;
}

export function followThroughDiagnosis(
  tasks: NormalizedTask[], rangeDays: number, clientToday: string,
  displayBuckets: DisplayBucket[], heavyPattern: HeavyPattern | null
): Diag {
  const summary = computeMetrics(tasks);

  if (summary.scheduled_count < 5 || summary.distinct_dates < 3 || summary.scheduled_minutes === 0) {
    return diag("more_history", "Complete a few more scheduled activities to reveal a reliable follow-through pattern.",
      { sample: summary.scheduled_count });
  }

  const [earlier, later] = diagnosticWindows(tasks, rangeDays, clientToday);
  if (earlier !== null && later !== null) {
    const earlierM = computeMetrics(earlier);
    const laterM = computeMetrics(later);
    if (windowEvidenceOk(earlierM) && windowEvidenceOk(laterM)) {
      const er = earlierM.follow_through_rate, lr = laterM.follow_through_rate;
      if (er !== null && lr !== null && er - lr >= 15) {
        return diag("declining", `Your Follow-Through Rate fell from ${er}% to ${lr}% over the last ${rangeDays} days.`,
          { earlier_rate: er, later_rate: lr, range_days: rangeDays });
      }
    }
  }

  if (heavyPattern) {
    return diag("heavy_day_overload", "Your follow-through is lower on days with more scheduled time.",
      { heavy_rate: heavyPattern.heavy_rate, light_rate: heavyPattern.light_rate });
  }

  const startRate = summary.start_rate, compAfterStart = summary.completion_after_start;
  const neverStartedShare = summary.lost_minutes ? (summary.missed_lost_minutes / summary.lost_minutes) * 100 : 0;
  const incompleteShare = summary.lost_minutes ? (summary.incomplete_lost_minutes / summary.lost_minutes) * 100 : 0;

  if (startRate !== null && startRate < 60 && compAfterStart !== null && compAfterStart >= 70 && neverStartedShare >= 50) {
    return diag("difficulty_starting", "Many activities are not started, but the activities you begin are usually completed.",
      { start_rate: startRate, completion_after_start: compAfterStart });
  }

  if (startRate !== null && startRate >= 60 && compAfterStart !== null && compAfterStart < 60 && incompleteShare >= 40) {
    return diag("difficulty_finishing", "You start most scheduled activities, but many sessions end before completion.",
      { start_rate: startRate, completion_after_start: compAfterStart });
  }

  const populated = displayBuckets.filter(b => b.metrics.scheduled_count > 0);
  if (populated.length >= 3) {
    const last3 = populated.slice(-3);
    const rates = last3.map(b => b.metrics.follow_through_rate || 0);
    const [r1, r2, r3] = rates;
    if (r2 - r1 >= 5 && r3 - r2 >= 5 && r3 - r1 >= 15) {
      return diag("improving", "Your follow-through has improved across the last three periods.",
        { earlier_rate: r1, later_rate: r3 });
    }
  }

  const ft = summary.follow_through_rate || 0;
  if (ft >= 80 && (summary.miss_rate || 0) < 15 && (summary.skip_rate || 0) < 20) {
    return diag("strong", "You are following through consistently, and no overall schedule problem stands out.",
      { follow_through_rate: ft });
  }

  return diag("no_clear_pattern", "No single overall pattern clearly explains your unfinished scheduled time.",
    { follow_through_rate: ft });
}

// --- 2. Lost Time by Activity ------------------------------------------------

export function lostTimeDiagnosis(tasks: NormalizedTask[], tzOffsetMinutes: number = 0): LostTimeResult {
  const bySlot = new Map<string, NormalizedTask[]>();
  for (const t of tasks) {
    const slotId = t.slot_id;
    if (!slotId) continue;
    if (!bySlot.has(slotId)) bySlot.set(slotId, []);
    bySlot.get(slotId)!.push(t);
  }

  const activities: Activity[] = [];
  let totalLostAll = 0;
  for (const [slotId, member] of bySlot) {
    const m = computeMetrics(member, tzOffsetMinutes);
    if (m.scheduled_count === 0) continue;
    let latest = member[0];
    for (const t of member) if (t.date >= latest.date) latest = t;
    activities.push({
      slot_id: slotId,
      name: latest.name || "Untitled activity",
      dates: Array.from(new Set(member.map(t => t.date))).sort(),
      ...m,
      lost_share: 0,
    });
    totalLostAll += m.lost_minutes;
  }
  for (const a of activities) {
    a.lost_share = totalLostAll ? pyRound((a.lost_minutes / totalLostAll) * 100) : 0;
  }
  activities.sort((a, b) => b.lost_minutes - a.lost_minutes);

  const candidates = activities.filter(a => a.scheduled_count >= 3);

  if (!candidates.length) {
    return { diagnostic: diag("more_activity_history", "Repeat your activities a few more times before comparing their lost time."), activities, selected: null };
  }

  const overallFt = computeMetrics(tasks, tzOffsetMinutes).follow_through_rate || 0;
  if (totalLostAll === 0 || (overallFt >= 90 && totalLostAll < 30)) {
    return { diagnostic: diag("no_meaningful_lost_time", "Your activities are creating very little unfinished scheduled time."), activities, selected: null };
  }

  const top = candidates[0];
  const second = candidates.length > 1 ? candidates[1] : null;
  const dominant = top.lost_minutes >= 30 && top.lost_share >= 35 &&
    (second === null || top.lost_minutes >= second.lost_minutes * 1.25);

  if (!dominant) {
    const lostActivities = candidates.filter(a => a.lost_minutes > 0);
    if (candidates.length >= 3 && lostActivities.length >= 2) {
      return { diagnostic: diag("no_single_activity_dominates", "Your unfinished time is distributed across several activities rather than one clear problem area."), activities, selected: null };
    }
  }

  const a = top;
  const member = bySlot.get(a.slot_id)!;
  const lost = a.lost_minutes || 1;
  const missedShare = (a.missed_lost_minutes / lost) * 100;
  const skippedShare = (a.skipped_lost_minutes / lost) * 100;
  const incompleteShare = (a.incomplete_lost_minutes / lost) * 100;
  const startRate = a.start_rate, compAfterStart = a.completion_after_start;

  const actDiag = (key: string, text: string, extra: Record<string, any> = {}): Diag =>
    diag(key, text, { activity: a.name, slot_id: a.slot_id, lost_minutes: a.lost_minutes, lost_share: a.lost_share, ...extra });

  if (a.scheduled_count >= 4 && (a.skip_rate || 0) >= 40 && skippedShare >= 50) {
    return { diagnostic: actDiag("frequently_skipped", `${a.name} creates the largest gap because it is frequently skipped.`, { skip_rate: a.skip_rate }), activities, selected: a };
  }

  if (startRate !== null && startRate < 50 && compAfterStart !== null && compAfterStart >= 70 && missedShare >= 50) {
    return {
      diagnostic: actDiag("difficult_to_start",
        `${a.name} creates the largest gap because many sessions are never started, although sessions are usually completed once begun.`,
        { start_rate: startRate, completion_after_start: compAfterStart }),
      activities, selected: a,
    };
  }

  const scheduledDur = a.avg_scheduled_duration || 0;
  const medianActual = a.median_actual_duration;
  const completedPortion = medianActual && scheduledDur ? medianActual / scheduledDur : null;
  const finishingPattern = startRate !== null && startRate >= 60 && compAfterStart !== null && compAfterStart < 60 && incompleteShare >= 40;

  if (finishingPattern && scheduledDur >= 90 && completedPortion !== null && completedPortion >= 0.35 && completedPortion <= 0.70) {
    return {
      diagnostic: actDiag("split", `${a.name} is usually started, but the scheduled block appears too long to finish consistently.`,
        { scheduled_duration: scheduledDur, median_actual_duration: medianActual }),
      activities, selected: a,
    };
  }

  if (finishingPattern && scheduledDur < 90 && medianActual !== null && scheduledDur - medianActual >= 20) {
    return {
      diagnostic: actDiag("shorten", `${a.name} is usually started, but its sessions often finish earlier than scheduled.`,
        { scheduled_duration: scheduledDur, median_actual_duration: medianActual }),
      activities, selected: a,
    };
  }

  if (a.scheduled_count >= 6 && distinctWeekCount(a.dates) >= 3 && (a.completion_rate || 0) < 25
      && ((startRate !== null && startRate < 40) || (a.skip_rate || 0) >= 50)
      && a.lost_share >= 35 && !recentImprovement(member)) {
    return { diagnostic: actDiag("may_not_fit_routine", `${a.name} repeatedly receives scheduled time but is rarely followed through on.`), activities, selected: a };
  }

  if (a.scheduled_count >= 5 && (a.follow_through_rate || 0) >= 80 && a.lost_share < 25 && a.lost_minutes < 30) {
    return { diagnostic: actDiag("activity_working_well", `${a.name} is being followed through on consistently and does not need adjustment.`), activities, selected: a };
  }

  return { diagnostic: actDiag("mixed_activity_problem", `${a.name} accounts for the most lost time, but the gap is divided between missed, skipped and incomplete sessions.`), activities, selected: a };
}

// --- 3. Time of Day Performance ----------------------------------------------

function periodBreakdown(tasks: NormalizedTask[], slotId: string, tzOffsetMinutes: number): Record<string, Metrics> {
  const buckets: Record<string, NormalizedTask[]> = {};
  for (const [key] of TIME_PERIODS) buckets[key] = [];
  for (const t of tasks) {
    if (t.slot_id === slotId && t.eligible) buckets[periodForStartTime(t.start_time)].push(t);
  }
  const result: Record<string, Metrics> = {};
  for (const [key] of TIME_PERIODS) result[key] = computeMetrics(buckets[key], tzOffsetMinutes);
  return result;
}

function resolveCurrentPeriod(perPeriod: Record<string, Metrics>, currentSlotStartTime: string | null): [string, string] {
  if (currentSlotStartTime) return [periodForStartTime(currentSlotStartTime), "live_slot"];
  let bestKey = "", bestCount = -1;
  for (const [key] of TIME_PERIODS) {
    const c = perPeriod[key].scheduled_count;
    if (c > bestCount) { bestKey = key; bestCount = c; }
  }
  return [bestKey, "historical_frequency"];
}

function sortKeyTuple(m: Metrics): number[] {
  return [m.follow_through_rate ?? -1, m.completion_rate ?? -1, m.start_rate ?? -1, m.scheduled_count];
}
function cmpTuples(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function timeOfDayDiagnosis(
  tasks: NormalizedTask[], selectedActivity: Activity | null,
  currentSlotStartTime: string | null, tzOffsetMinutes: number = 0
): TimeOfDayResult {
  const labelByKey: Record<string, string> = {};
  for (const [key, label] of TIME_PERIODS) labelByKey[key] = label;

  if (!selectedActivity) {
    const overallBuckets: Record<string, NormalizedTask[]> = {};
    for (const [key] of TIME_PERIODS) overallBuckets[key] = [];
    for (const t of tasks) if (t.eligible) overallBuckets[periodForStartTime(t.start_time)].push(t);
    const overallPeriods: Period[] = TIME_PERIODS.map(([k]) => ({
      key: k, label: labelByKey[k], ...computeMetrics(overallBuckets[k], tzOffsetMinutes),
    }));
    return { diagnostic: diag("no_activity_available", "There is no single activity available for a focused time-of-day comparison."), periods: overallPeriods, current_period: null };
  }

  const name = selectedActivity.name;
  const perPeriod = periodBreakdown(tasks, selectedActivity.slot_id, tzOffsetMinutes);
  const [currentKey, method] = resolveCurrentPeriod(perPeriod, currentSlotStartTime);
  const periodsPayload: Period[] = TIME_PERIODS.map(([k]) => ({ key: k, label: labelByKey[k], ...perPeriod[k] }));
  const current = perPeriod[currentKey];
  const alternatives: [string, Metrics][] = TIME_PERIODS.filter(([k]) => k !== currentKey).map(([k]) => [k, perPeriod[k]]);
  const qualifyingAlts = alternatives.filter(([, m]) => m.scheduled_count >= 3);

  const result = (key: string, text: string, extra: Record<string, any> = {}): TimeOfDayResult => ({
    diagnostic: diag(key, text, { activity: name, ...extra }),
    periods: periodsPayload, current_period: currentKey, current_period_method: method,
  });

  if (current.scheduled_count < 3 || !qualifyingAlts.length) {
    const noAltHistoryAtAll = alternatives.every(([, m]) => m.scheduled_count === 0);
    if (current.scheduled_count >= 5 && noAltHistoryAtAll) {
      const fallback = timeOfDayOverallFallback(tasks, selectedActivity, currentKey, tzOffsetMinutes);
      if (fallback) {
        return { diagnostic: fallback, periods: periodsPayload, current_period: currentKey, current_period_method: method };
      }
    }
    return result("more_time_data_needed", `Complete ${name} a few more times at different times before changing its schedule.`, { sample: current.scheduled_count });
  }

  let [bestKey, bestM] = qualifyingAlts[0];
  for (const alt of qualifyingAlts.slice(1)) {
    if (cmpTuples(sortKeyTuple(alt[1]), sortKeyTuple(bestM)) > 0) [bestKey, bestM] = alt;
  }
  const curRate = current.follow_through_rate || 0, bestRate = bestM.follow_through_rate || 0;
  const diff = bestRate - curRate;
  const dateGuard = current.distinct_dates >= 2 && bestM.distinct_dates >= 2;
  const startGuard = (bestM.start_rate || 0) >= (current.start_rate || 0) - 10;

  if (diff >= 15 && dateGuard && startGuard) {
    return result("better_at_another_time", `${name} performs better in the ${labelByKey[bestKey]} than in the ${labelByKey[currentKey]}.`,
      { current_rate: curRate, better_rate: bestRate, current_time: labelByKey[currentKey], better_time: labelByKey[bestKey] });
  }

  const topPeriods = [...qualifyingAlts, [currentKey, current] as [string, Metrics]]
    .sort((a, b) => cmpTuples(sortKeyTuple(b[1]), sortKeyTuple(a[1])));
  const [topKey, topM] = topPeriods[0];
  const isCurrentBest = topKey === currentKey || ((topM.follow_through_rate || 0) - curRate <= 5 && current.scheduled_count > topM.scheduled_count);
  if (isCurrentBest && diff < 10) {
    return result("current_time_best", `${name} currently performs best at its scheduled time.`, { current_rate: curRate, current_time: labelByKey[currentKey] });
  }

  if (diff < 10) {
    return result("no_meaningful_time_difference", `Time of day does not appear to meaningfully affect ${name}.`, { current_rate: curRate, best_rate: bestRate });
  }

  return result("more_time_data_needed", `Complete ${name} a few more times at different times before changing its schedule.`, { sample: current.scheduled_count });
}

function timeOfDayOverallFallback(
  tasks: NormalizedTask[], selectedActivity: Activity, currentKey: string, tzOffsetMinutes: number = 0
): Diag | null {
  const labelByKey: Record<string, string> = {};
  for (const [key, label] of TIME_PERIODS) labelByKey[key] = label;

  const otherOverall: [string, Metrics][] = TIME_PERIODS
    .filter(([k]) => k !== currentKey)
    .map(([k]) => [k, computeMetrics(tasks.filter(t => t.eligible && periodForStartTime(t.start_time) === k), tzOffsetMinutes)]);
  const overallCurrent = computeMetrics(tasks.filter(t => t.eligible && periodForStartTime(t.start_time) === currentKey), tzOffsetMinutes);
  const curRate = overallCurrent.follow_through_rate || 0;
  let best: [string, Metrics] | null = null;
  for (const [k, m] of otherOverall) {
    if (m.scheduled_count >= 8 && m.distinct_dates >= 3 && (m.follow_through_rate || 0) - curRate >= 20) {
      if (best === null || (m.follow_through_rate || 0) > (best[1].follow_through_rate || 0)) best = [k, m];
    }
  }
  if (!best) return null;
  return diag("another_time_may_be_worth_testing",
    `The ${labelByKey[best[0]]} may be worth testing, although this is not yet an activity-specific result.`,
    { activity: selectedActivity.name, better_time: labelByKey[best[0]], better_rate: best[1].follow_through_rate });
}

// --- 4. Combined recommendation ----------------------------------------------

interface CoreAction {
  rank: number; kind: string; title: string; experiment: string; success: string; action_label: string | null;
}

function coreAction(ltaKey: string, ltaDiag: Diag, todKey: string, todDiag: Diag, activity: string | null): CoreAction | null {
  const betterTime: string | undefined = todDiag.metrics?.better_time;
  const todHasMove = todKey === "better_at_another_time" && !!betterTime;

  if (ltaKey === "frequently_skipped") {
    return {
      rank: 5, kind: "reduce_frequency", title: `Reduce how often ${activity} is scheduled`,
      experiment: `Schedule ${activity} fewer days per week for the next two weeks.`,
      success: "A lower Skip Rate without lowering completion when it is scheduled.", action_label: "Change Days",
    };
  }

  if (ltaKey === "difficult_to_start") {
    const exp = todHasMove
      ? `Move ${activity} to the ${betterTime!.toLowerCase()} and prepare one small first step before its scheduled start.`
      : `Keep ${activity} at its current time, but make its first step smaller and easier to begin.`;
    return { rank: 6, kind: "fix_starting", title: `Make ${activity} easier to start`, experiment: exp, success: "A higher Start Rate for this activity.", action_label: "Edit Schedule" };
  }

  if (ltaKey === "split") {
    const exp = todHasMove
      ? `Split ${activity} into smaller sessions first. Keep the current time during the test so only one variable changes.`
      : `Replace the long block with two shorter sessions for ${activity}.`;
    return { rank: 7, kind: "split", title: `Split ${activity} into smaller sessions`, experiment: exp, success: "A higher Completion After Start rate for this activity.", action_label: "Edit Schedule" };
  }

  if (ltaKey === "shorten") {
    const med = ltaDiag.metrics?.median_actual_duration;
    const scheduled = ltaDiag.metrics?.scheduled_duration;
    const exp = med && scheduled
      ? `Schedule ${activity} for about ${med} minutes for the next two weeks.`
      : `Reduce the scheduled duration of ${activity} toward its typical completed length.`;
    return { rank: 8, kind: "shorten", title: `Shorten ${activity}`, experiment: exp, success: "A higher Completion After Start rate without reducing how often it is started.", action_label: "Shorten Activity" };
  }

  if (ltaKey === "may_not_fit_routine") {
    return {
      rank: 4, kind: "review_remove", title: `Review whether ${activity} still belongs in your routine`,
      experiment: `Remove or redefine ${activity} — or move it somewhere it can realistically fit — for the next two weeks.`,
      success: "Either the activity starts being completed, or it's removed and stops costing scheduled time.", action_label: "Review Routine",
    };
  }

  if (ltaKey === "mixed_activity_problem") {
    if (todHasMove) {
      return {
        rank: 9, kind: "move_time", title: `Test ${activity} at the ${betterTime!.toLowerCase()}`,
        experiment: `Test ${activity} at the ${betterTime!.toLowerCase()} for two weeks, since no single duration or frequency issue stands out yet.`,
        success: "A higher Follow-Through Rate for this activity.", action_label: "Move Activity",
      };
    }
    return {
      rank: 9, kind: "review_mixed", title: `Review ${activity}`,
      experiment: `Review ${activity}'s duration, frequency and purpose — no single cause dominates its lost time yet.`,
      success: "A clearer single pattern in its lost time, or a lower lost-time share overall.", action_label: "Review Routine",
    };
  }

  if (ltaKey === "activity_working_well") {
    if (todHasMove) {
      return {
        rank: 9, kind: "move_time", title: `Test moving ${activity}`,
        experiment: `Moving ${activity} to the ${betterTime!.toLowerCase()} may offer a small additional improvement.`,
        success: "A higher Follow-Through Rate for this activity.", action_label: "Move Activity",
      };
    }
    return {
      rank: 10, kind: "keep", title: "Keep the current setup",
      experiment: `Keep ${activity} and its current time unchanged.`,
      success: "Continued consistency for this activity.", action_label: null,
    };
  }

  return null;
}

export function combineDiagnostics(ft: Diag, lta: LostTimeResult, tod: TimeOfDayResult, rangeDays: number): Recommendation {
  const ftKey = ft.key;
  const ltaDiag = lta.diagnostic, selected = lta.selected;
  const ltaKey = ltaDiag.key;
  const todDiag = tod.diagnostic;
  const todKey = todDiag.key;
  const activity = selected ? selected.name : null;

  const actionFor = (kindLabel: string | null): RecAction | null => {
    if (kindLabel === null) return null;
    if (selected) return { type: "edit_schedule", slot_id: selected.slot_id, label: kindLabel };
    return { type: "info", slot_id: null, label: "Review Routine" };
  };

  const rec = (title: string, reason: string, experiment: string, success: string, actionLabel: string | null = null): Recommendation => ({
    title, reason, experiment, success_measure: success, action: actionFor(actionLabel),
  });

  if (ftKey === "more_history") {
    return rec("Collect more data", "There isn't enough scheduled-activity history yet to identify a reliable pattern.",
      "Keep your current schedule for now and complete a few more activities before making changes.",
      "At least 5 eligible scheduled activities across 3 separate days.");
  }
  if (ltaKey === "more_activity_history") {
    return rec("Keep tracking", "The same activities haven't repeated enough times yet for a fair comparison.",
      "Continue using the schedule until the same activities have been repeated enough for a fair comparison.",
      "At least 3 occurrences for your most-scheduled activities.");
  }
  const core = coreAction(ltaKey, ltaDiag, todKey, todDiag, activity);

  if (ftKey === "strong" && ltaKey === "no_meaningful_lost_time") {
    return rec("Keep the current schedule", "Your plan is working well overall, with very little unfinished scheduled time.",
      "Keep the current schedule. Your plan is working well.", "Follow-Through Rate holding at its current level.");
  }
  if (ftKey === "improving" && ltaKey === "no_meaningful_lost_time") {
    return rec("Continue the current approach", "Your Follow-Through Rate is improving and there's very little unfinished scheduled time.",
      "Continue the current approach. Your results are improving.", "Follow-Through Rate continuing to rise or hold steady.");
  }
  if ((ftKey === "strong" || ftKey === "improving") && ltaKey === "no_single_activity_dominates" && !core) {
    return rec("Keep the current setup", "Your overall follow-through looks healthy and no single activity stands out as a problem.",
      "Keep the current setup and continue monitoring.", "Follow-Through Rate staying steady or improving.");
  }
  if (ftKey === "strong" && ltaKey === "activity_working_well" && todKey !== "better_at_another_time") {
    return rec("Keep the current setup",
      `${activity} is being followed through on consistently at its current time, and your overall schedule is healthy.`,
      `Keep the current activity and its current time unchanged.`, "Continued consistency for this activity.");
  }

  if (ftKey === "heavy_day_overload") {
    const heavyRate = ft.metrics?.heavy_rate;
    const lightRate = ft.metrics?.light_rate;
    const baseReason = heavyRate !== undefined && heavyRate !== null
      ? `Your average Follow-Through Rate is ${heavyRate}% on your busiest days, compared with ${lightRate}% on lighter days.`
      : "Your follow-through is lower on your busiest scheduled days.";
    if (core && (core.kind === "reduce_frequency" || core.kind === "review_remove")) {
      return rec(core.title, `${baseReason} ${activity} also has its own execution problem.`,
        core.experiment + " Prioritize lighter days for it if possible.", core.success, core.action_label);
    }
    if (core && core.kind === "move_time" && todDiag.metrics?.better_time) {
      return rec(`Move ${activity} to a lighter day`, `${baseReason} ${activity} also performs better at a different time.`,
        `Move ${activity} to the ${todDiag.metrics.better_time.toLowerCase()} on a lighter day.`,
        "A higher Follow-Through Rate on the days this activity now falls on.", "Edit Schedule");
    }
    if (activity) {
      return rec(`Move ${activity} away from your busiest days`, baseReason,
        `Move ${activity} away from your busiest days before changing its duration or frequency.`,
        "A smaller gap between busy-day and light-day Follow-Through Rate.", "Edit Schedule");
    }
    return rec("Reduce your busiest days' workload", baseReason,
      "Move or remove one flexible activity from your busiest days.",
      "A smaller gap between busy-day and light-day Follow-Through Rate.");
  }

  if (ftKey === "declining") {
    const er = ft.metrics?.earlier_rate, lr = ft.metrics?.later_rate;
    const baseReason = er !== undefined && er !== null
      ? `Your Follow-Through Rate fell from ${er}% to ${lr}% over the selected range.`
      : "Your follow-through has declined recently.";
    if (core) {
      return rec(core.title, baseReason, core.experiment + " Avoid making other schedule changes during the test.", core.success, core.action_label);
    }
    return rec("Temporarily simplify your schedule", baseReason,
      "Temporarily simplify the schedule and compare the next two weeks with the declining period.",
      "Follow-Through Rate recovering toward its earlier level.");
  }

  if (core) {
    const reasonBits: string[] = [];
    if (ltaKey === "difficult_to_start") {
      reasonBits.push(`${activity} accounts for ${ltaDiag.metrics?.lost_share ?? 0}% of your lost scheduled time, mostly because sessions are never started.`);
    } else if (ltaKey === "split" || ltaKey === "shorten") {
      const sched = ltaDiag.metrics?.scheduled_duration;
      const med = ltaDiag.metrics?.median_actual_duration;
      if (sched && med) {
        reasonBits.push(`${activity} accounts for ${ltaDiag.metrics?.lost_share ?? 0}% of your lost time, and its typical completed duration is ${med} minutes rather than the scheduled ${sched}.`);
      }
    } else if (ltaKey === "frequently_skipped") {
      reasonBits.push(`${activity} is skipped often, accounting for ${ltaDiag.metrics?.lost_share ?? 0}% of your lost scheduled time.`);
    } else if (ltaKey === "may_not_fit_routine") {
      reasonBits.push(`${activity} repeatedly receives scheduled time but is rarely followed through on.`);
    }
    if (todKey === "no_meaningful_time_difference") reasonBits.push("Time of day does not show a meaningful difference.");
    const reason = reasonBits.length ? reasonBits.join(" ") : `${activity} is the largest source of lost scheduled time.`;

    if (ftKey === "improving") {
      return rec(`Continue overall, and ${core.title.toLowerCase()}`, `Overall performance is improving. ${reason}`, core.experiment, core.success, core.action_label);
    }
    if (ftKey === "no_clear_pattern") {
      return rec(core.title, reason, core.experiment, core.success, core.action_label);
    }
    return rec(core.title, `Your overall schedule is healthy, but ${reason}`, core.experiment, core.success, core.action_label);
  }

  if (todKey === "no_activity_available" || ltaKey === "no_single_activity_dominates" || ltaKey === "no_meaningful_lost_time") {
    return rec("Keep tracking", "No single change has enough evidence yet.",
      "Keep tracking. No single change has enough evidence yet.", "A clear pattern emerging in one of the three graphs above.");
  }

  return rec("Keep the current setup", "No single higher-priority issue was identified.",
    "Keep the current setup and continue collecting data.", "A clear pattern emerging as more data comes in.");
}
