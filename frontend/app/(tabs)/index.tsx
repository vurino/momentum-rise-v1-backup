import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, Animated, ActivityIndicator,
  RefreshControl, TextInput,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { router, useFocusEffect } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSimpleTheme, ThemeTokens } from "../../context/SimpleTheme";
import { scheduleTaskReminders } from "../../utils/notifications";
import ConfirmModal from "../../components/ConfirmModal";
import { notify } from "../../utils/confirm";
import { getDailyTasks, updateDailyTask, getStreak } from "../../db/dailyTasks";

const LIST_OPEN_KEY = "todayListOpen";

interface Task {
  id: string;
  name: string;
  done: boolean;
  completed: boolean;
  skipped: boolean;
  stopped: boolean;
  auto_skipped: boolean;
  notes?: string | null;
  slot_id: string;
  date: string;
  start_time?: string;
  end_time?: string;
  duration?: number;
  started_at?: string | null;
  completed_at?: string | null;
  stopped_at?: string | null;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function formatDate() {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric",
  });
}

// Local calendar date — NOT UTC. Using toISOString() here caused the app to
// fetch tomorrow's task list during local evenings and mass-skip it.
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nowISO() {
  return new Date().toISOString();
}

function getTaskTime(task: Task): string {
  return task.start_time ?? "";
}

function getTaskDuration(task: Task): number {
  return task.duration ?? 30;
}

function nowMinutes(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function toMinutes(t?: string | null): number | null {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function calcRemaining(timeStr: string, duration: number) {
  if (!timeStr) return { remaining: 0, pct: 0 };
  const [h, m] = timeStr.split(":").map(Number);
  const start = h * 60 + m;
  const cur = nowMinutes();
  const pct = Math.min(100, Math.max(0, ((cur - start) / duration) * 100));
  const remaining = Math.max(0, (start + duration) - cur);
  return { remaining, pct };
}

function formatDur(min: number) {
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
  }
  return `${min} min`;
}

function isUnresolved(t: Task) {
  return !t.done && !t.skipped && !t.stopped;
}

// TEMPORARY DIAGNOSTIC: the looping pulse animation is disabled (static dot
// instead) to test whether an active Animated.loop being unmounted/swapped
// out mid-loop — which is exactly what happens when Stop or Start-early
// changes which task is "active" and the hero card's layout structurally
// changes — is the native crash trigger reported on Stop/Open-focus-timer.
// If the crash stops happening with this change, we've found it.
function PulsingDot({ color }: { color: string }) {
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

// Staggered fade: rows appear top-to-bottom on expand and disappear
// bottom-to-top on collapse.
function FadeRow({ index, total, open, children }: {
  index: number; total: number; open: boolean; children: React.ReactNode;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const delay = open ? index * 55 : (total - 1 - index) * 45;
    Animated.timing(anim, {
      toValue: open ? 1 : 0,
      duration: 200,
      delay,
      useNativeDriver: true,
    }).start();
  }, [open, index, total]);
  return (
    <Animated.View style={{
      opacity: anim,
      transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
    }}>
      {children}
    </Animated.View>
  );
}

function NoteEditor({
  task, T, onSaveNote,
}: {
  task: Task; T: ThemeTokens; onSaveNote: (id: string, notes: string) => void;
}) {
  const [text, setText] = useState(task.notes ?? "");
  return (
    <View style={styles.noteEditor}>
      <TextInput
        style={[styles.noteInput, { backgroundColor: T.bg, borderColor: T.border, color: T.t1 }]}
        value={text}
        onChangeText={setText}
        placeholder="Add a note for today..."
        placeholderTextColor={T.t2}
        multiline
      />
      <TouchableOpacity
        style={[styles.noteSaveBtn, { backgroundColor: T.orange }]}
        onPress={() => onSaveNote(task.id, text.trim())}
      >
        <Text style={styles.noteSaveBtnText}>Save note</Text>
      </TouchableOpacity>
    </View>
  );
}

function HeroCard({
  task, T, onSkip, onSaveNote, onStart, onComplete, onStopRequest, upcoming,
}: {
  task: Task; T: ThemeTokens;
  onSkip: (id: string, name: string) => void;
  onSaveNote: (id: string, notes: string) => void;
  onStart: (task: Task) => void;
  onComplete: (task: Task) => void;
  onStopRequest: (task: Task) => void;
  upcoming: boolean;
}) {
  const timeStr = getTaskTime(task);
  const duration = getTaskDuration(task);
  const { remaining, pct } = calcRemaining(timeStr, duration);
  const [noteOpen, setNoteOpen] = useState(false);

  const started = !!task.started_at;
  const accent = started ? T.orange : upcoming ? T.t2 : T.orange;
  const statusLabel = started ? "In progress" : upcoming ? "Up next" : "Now active";
  const startMin = toMinutes(timeStr);
  const minsUntil = startMin !== null ? Math.max(0, startMin - nowMinutes()) : 0;

  const openFocus = () => router.push({
    pathname: "/focus",
    params: {
      id: task.id,
      date: todayStr(),
      label: task.name,
      start_time: timeStr,
      end_time: task.end_time ?? "",
    },
  });

  return (
    <View style={[
      styles.hero,
      { backgroundColor: T.surface, borderColor: T.border, borderLeftColor: accent, shadowColor: accent },
    ]}>
      <LinearGradient
        colors={[accent, "transparent"]}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
        style={styles.heroGlow}
      />
      <View style={styles.heroTopRow}>
        <View style={styles.heroLabel}>
          <PulsingDot color={accent} />
          <Text style={[styles.heroLabelText, { color: accent }]}>{statusLabel}</Text>
        </View>
        <View style={styles.heroLinks}>
          <TouchableOpacity
            onPress={() => setNoteOpen(o => !o)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.noteLinkBtn}
          >
            <Text style={[styles.heroLinkText, { color: T.t2 }]}>Note</Text>
            {!!task.notes && <View style={[styles.noteIndicatorDot, { backgroundColor: T.orange }]} />}
          </TouchableOpacity>
          {!started && (
            <TouchableOpacity onPress={() => onSkip(task.id, task.name || "This task")} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={[styles.heroLinkText, { color: T.t2 }]}>Skip</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
      <Text style={[styles.heroName, { color: T.t1 }]}>{task.name}</Text>
      <Text style={[styles.heroMeta, { color: T.t2 }]}>
        {timeStr} · {formatDur(duration)}
      </Text>

      {upcoming && !started ? (
        <Text style={[styles.heroRemain, { color: T.t2, marginTop: 2 }]}>
          Starts {minsUntil <= 60 ? `in ${minsUntil} min` : `at ${timeStr}`}
        </Text>
      ) : (
        <>
          <View style={[styles.progressTrack, { backgroundColor: T.border }]}>
            <View style={[styles.progressFill, { width: `${pct}%` as any, backgroundColor: T.orange }]} />
          </View>
          {remaining > 0 && (
            <Text style={[styles.heroRemain, { color: T.t2 }]}>{remaining} min remaining</Text>
          )}
        </>
      )}

      {noteOpen && (
        <NoteEditor task={task} T={T} onSaveNote={(id, notes) => { onSaveNote(id, notes); setNoteOpen(false); }} />
      )}

      {!started ? (
        <TouchableOpacity
          style={[styles.focusBtn, { backgroundColor: T.orange, shadowColor: T.orange }]}
          onPress={() => onStart(task)}
        >
          <Text style={styles.focusBtnText}>{upcoming ? "Start early" : "Start"}</Text>
        </TouchableOpacity>
      ) : (
        <>
          <View style={styles.heroActionsRow}>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: T.orange, shadowColor: T.orange }]}
              onPress={() => onComplete(task)}
            >
              <Text style={styles.focusBtnText}>Complete</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.stopBtn, { borderColor: T.danger }]}
              onPress={() => onStopRequest(task)}
            >
              <Text style={[styles.focusBtnText, { color: T.danger }]}>Stop</Text>
            </TouchableOpacity>
          </View>
          <TouchableOpacity onPress={openFocus} style={styles.focusLink}>
            <Text style={[styles.focusLinkText, { color: T.t2 }]}>Open focus timer</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

function TaskRow({
  task, isLast, onSaveNote, T,
}: {
  task: Task; isLast: boolean;
  onSaveNote: (id: string, notes: string) => void;
  T: ThemeTokens;
}) {
  const [noteOpen, setNoteOpen] = useState(false);

  const timeStr = getTaskTime(task);
  const duration = getTaskDuration(task);

  return (
    <View style={[
      !isLast && { borderBottomWidth: 1, borderBottomColor: T.border },
    ]}>
      <View style={[styles.taskRow, task.done && styles.taskDone]}>
        <View style={{ flex: 1 }}>
          <Text style={[
            styles.taskName,
            { color: T.t1 },
            task.done && { color: T.t3, textDecorationLine: "line-through", textDecorationColor: T.t4 },
          ]}>
            {task.name}
          </Text>
          <Text style={[
            styles.taskMeta,
            { color: T.t2 },
            task.done && { color: T.t3 },
          ]}>
            {timeStr} · {formatDur(duration)}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => setNoteOpen(o => !o)}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.noteLinkBtn}
        >
          <Text style={[styles.taskLinkText, { color: T.t3 }]}>note</Text>
          {!!task.notes && <View style={[styles.noteIndicatorDot, { backgroundColor: T.orange }]} />}
        </TouchableOpacity>
      </View>
      {noteOpen && (
        <View style={{ paddingBottom: 10 }}>
          <NoteEditor task={task} T={T} onSaveNote={(id, notes) => { onSaveNote(id, notes); setNoteOpen(false); }} />
        </View>
      )}
    </View>
  );
}

export default function TodayScreen() {
  const { T } = useSimpleTheme();
  const [tasks, setTasks]       = useState<Task[]>([]);
  const [streak, setStreak]     = useState(0);
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState<{ id: string; name: string } | null>(null);
  const [confirmStop, setConfirmStop] = useState<{ id: string; name: string } | null>(null);

  // Collapsible task list. listOpen drives the animation; listRendered keeps
  // rows mounted until the collapse animation finishes.
  const [listOpen, setListOpen] = useState(false);
  const [listRendered, setListRendered] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(LIST_OPEN_KEY).then(v => {
      if (v === "true") { setListOpen(true); setListRendered(true); }
    }).catch(() => {});
  }, []);

  const patchTask = async (id: string, body: Record<string, unknown>) => {
    try {
      await updateDailyTask(id, body, todayStr());
    } catch (e) {
      console.error(e);
    }
  };

  const fetchData = useCallback(async () => {
    try {
      const [raw, streak] = await Promise.all([
        getDailyTasks(todayStr()),
        getStreak(todayStr()),
      ]);
      const mapped: Task[] = raw.map((t: any) => ({
        ...t,
        done: t.completed ?? false,
        skipped: t.skipped ?? false,
        stopped: t.stopped ?? false,
        auto_skipped: t.auto_skipped ?? false,
      }));

      // Auto-resolution: a task whose window fully passed without being
      // completed becomes stopped (if it was started) or skipped (if it was
      // never touched). Premature auto-skips — possible leftovers of the old
      // UTC-date bug — are healed back to pending while their window is open.
      const nowMin = nowMinutes();
      const patches: { id: string; body: Record<string, unknown> }[] = [];
      for (const t of mapped) {
        const start = toMinutes(t.start_time);
        if (start === null) continue;
        const windowEnded = start + (t.duration ?? 30) < nowMin;
        if (windowEnded && isUnresolved(t)) {
          if (t.started_at) {
            t.stopped = true;
            t.stopped_at = nowISO();
            patches.push({ id: t.id, body: { stopped: true, stopped_at: t.stopped_at } });
          } else {
            t.skipped = true;
            t.auto_skipped = true;
            patches.push({ id: t.id, body: { skipped: true, auto_skipped: true } });
          }
        } else if (!windowEnded && t.skipped && t.auto_skipped && !t.done) {
          t.skipped = false;
          t.auto_skipped = false;
          patches.push({ id: t.id, body: { skipped: false, auto_skipped: false } });
        }
      }
      if (patches.length > 0) {
        await Promise.all(patches.map(p => patchTask(p.id, p.body)));
      }

      setTasks(mapped);
      setStreak(streak ?? 0);

      const remindersPref = await AsyncStorage.getItem("taskReminders");
      const remindersOn = remindersPref !== null ? JSON.parse(remindersPref) : true;
      if (remindersOn) {
        const leadPref = await AsyncStorage.getItem("reminderLeadMinutes");
        const leadMinutes = leadPref !== null ? JSON.parse(leadPref) : 5;
        scheduleTaskReminders(mapped.filter((t: Task) => isUnresolved(t)), leadMinutes).catch(err => console.error(err));
      }
    } catch (e) {
      console.error("Fetch error:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { fetchData(); }, [fetchData]));

  const toggleList = () => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    if (!listOpen) {
      setListRendered(true);
      setListOpen(true);
      AsyncStorage.setItem(LIST_OPEN_KEY, "true").catch(() => {});
    } else {
      setListOpen(false);
      AsyncStorage.setItem(LIST_OPEN_KEY, "false").catch(() => {});
      collapseTimer.current = setTimeout(() => setListRendered(false), collapsibleCount * 45 + 260);
    }
  };

  const skipTask = (id: string, name: string) => {
    setConfirmSkip({ id, name });
  };

  // TEMPORARY DIAGNOSTIC: every one of these is being reported as crashing
  // the whole app, while Note (which never touches this screen's state)
  // isn't. Wrapping each body in try/catch means a catchable JS error will
  // now surface as a themed dialog with the real message instead of taking
  // the app down silently — and if it crashes even with this wrapper in
  // place, that tells us it's a native-level crash, not a JS exception, and
  // we'll know a device crash log is the only way to pin it down further.
  const confirmSkipNow = async () => {
    try {
      if (!confirmSkip) return;
      const { id } = confirmSkip;
      setConfirmSkip(null);
      setTasks(prev => prev.map(t => t.id === id ? { ...t, skipped: true, auto_skipped: false } : t));
      await patchTask(id, { skipped: true, auto_skipped: false });
    } catch (e: any) {
      notify("Debug: skip failed", e?.message || String(e));
    }
  };

  const startTask = async (task: Task) => {
    try {
      const startedAt = nowISO();
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, started_at: startedAt } : t));
      await patchTask(task.id, { started_at: startedAt });
      router.push({
        pathname: "/focus",
        params: {
          id: task.id,
          date: todayStr(),
          label: task.name,
          start_time: task.start_time ?? "",
          end_time: task.end_time ?? "",
        },
      });
    } catch (e: any) {
      notify("Debug: start failed", e?.message || String(e));
    }
  };

  const completeTask = async (task: Task) => {
    try {
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, done: true, completed: true } : t));
      await patchTask(task.id, { completed: true, completed_at: nowISO(), skipped: false, stopped: false, auto_skipped: false });
    } catch (e: any) {
      notify("Debug: complete failed", e?.message || String(e));
    }
  };

  const stopRequest = (task: Task) => {
    setConfirmStop({ id: task.id, name: task.name || "This task" });
  };

  const confirmStopNow = async () => {
    try {
      if (!confirmStop) return;
      const { id } = confirmStop;
      setConfirmStop(null);
      const stoppedAt = nowISO();
      setTasks(prev => prev.map(t => t.id === id ? { ...t, stopped: true, stopped_at: stoppedAt } : t));
      await patchTask(id, { stopped: true, stopped_at: stoppedAt });
    } catch (e: any) {
      notify("Debug: stop failed", e?.message || String(e));
    }
  };

  const saveNote = async (id: string, notes: string) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, notes } : t));
    await patchTask(id, { notes });
  };

  const sortedTasks = [...tasks].sort((a, b) =>
    (a.start_time ?? "").localeCompare(b.start_time ?? "")
  );

  // A started task stays the hero until resolved, even after its window ends.
  const inProgress = sortedTasks.find(t => isUnresolved(t) && t.started_at);
  const nextPending = sortedTasks.find(isUnresolved);
  const activeTask = inProgress ?? nextPending ?? null;

  const listTasks = sortedTasks.filter(t => !t.skipped && !t.stopped && t.id !== activeTask?.id);
  const stoppedTasks = sortedTasks.filter(t => t.stopped);
  const skippedTasks = sortedTasks.filter(t => t.skipped);

  const doneCount = tasks.filter(t => t.done).length;
  const totalCount = tasks.length;

  const activeStartMin = activeTask ? toMinutes(activeTask.start_time) : null;
  const isUpcoming = activeTask !== null && activeStartMin !== null && activeStartMin > nowMinutes();

  // Everything inside the collapsible region, flattened so the stagger
  // animation can index across rows and section headers alike.
  const collapsibleItems: React.ReactNode[] = [];
  listTasks.forEach((task, i) => {
    collapsibleItems.push(
      <TaskRow
        key={task.id}
        task={task}
        isLast={i === listTasks.length - 1}
        onSaveNote={saveNote}
        T={T}
      />
    );
  });
  if (stoppedTasks.length > 0) {
    collapsibleItems.push(
      <Text key="stopped-label" style={[styles.listLabel, { color: T.t3, marginTop: 20 }]}>Stopped</Text>
    );
    stoppedTasks.forEach(task => {
      collapsibleItems.push(
        <View key={task.id} style={styles.resolvedRow}>
          <Text style={[styles.resolvedText, { color: T.t3 }]}>{task.name}</Text>
          <Text style={[styles.resolvedTag, { color: T.orange }]}>stopped</Text>
        </View>
      );
    });
  }
  if (skippedTasks.length > 0) {
    collapsibleItems.push(
      <Text key="skipped-label" style={[styles.listLabel, { color: T.t3, marginTop: 20 }]}>Skipped</Text>
    );
    skippedTasks.forEach(task => {
      collapsibleItems.push(
        <View key={task.id} style={styles.resolvedRow}>
          <Text style={[styles.resolvedText, styles.struck, { color: T.t3 }]}>{task.name}</Text>
          <Text style={[styles.resolvedTag, { color: T.t3 }]}>skipped</Text>
        </View>
      );
    });
  }
  const collapsibleCount = collapsibleItems.length;

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: T.bg }]}>
        <ActivityIndicator color={T.orange} />
      </View>
    );
  }

  return (
    <View style={[styles.screen, { backgroundColor: T.bg }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); fetchData(); }}
            tintColor={T.orange}
          />
        }
      >
        <View style={styles.header}>
          <Text style={[styles.greeting, { color: T.orange }]}>{getGreeting()}</Text>
          <Text style={[styles.dateText, { color: T.t1 }]}>{formatDate()}</Text>
        </View>

        {activeTask
          ? <HeroCard
              task={activeTask}
              T={T}
              onSkip={skipTask}
              onSaveNote={saveNote}
              onStart={startTask}
              onComplete={completeTask}
              onStopRequest={stopRequest}
              upcoming={isUpcoming}
            />
          : totalCount === 0 ? (
            <View style={[styles.hero, styles.heroEmpty, { backgroundColor: T.surface, borderColor: T.border, borderLeftColor: T.t3 }]}>
              <Text style={[styles.emptyIcon, { color: T.t3 }]}>○</Text>
              <Text style={[styles.emptyText, { color: T.t2 }]}>Nothing scheduled today</Text>
            </View>
          ) : (
            <View style={[styles.hero, styles.heroEmpty, { backgroundColor: T.surface, borderColor: T.border, borderLeftColor: T.orange }]}>
              <Text style={[styles.emptyIcon, { color: T.orange }]}>✓</Text>
              <Text style={[styles.emptyText, { color: T.t2 }]}>All done for today</Text>
            </View>
          )
        }

        <View style={[styles.footer, { borderBottomColor: T.border }]}>
          <Text style={[styles.footerLeft, { color: T.t2 }]}>{doneCount} of {totalCount} done</Text>
          <Text style={[styles.footerRight, { color: T.t1 }]}>{streak}d streak</Text>
        </View>

        {collapsibleCount > 0 && (
          <TouchableOpacity style={styles.listHeaderRow} onPress={toggleList} activeOpacity={0.6}>
            <Text style={[styles.listLabel, { color: T.t2, marginTop: 0, marginBottom: 0 }]}>Today&apos;s tasks</Text>
            <Text style={[styles.chevron, { color: T.t2 }]}>{listOpen ? "▲" : "▼"}</Text>
          </TouchableOpacity>
        )}

        {listRendered && collapsibleItems.map((item, i) => (
          <FadeRow key={`fade-${i}`} index={i} total={collapsibleCount} open={listOpen}>
            {item}
          </FadeRow>
        ))}

        <View style={{ height: 24 }} />
      </ScrollView>

      <LinearGradient
        colors={["transparent", T.bg]}
        style={styles.fade}
        pointerEvents="none"
      />

      <ConfirmModal
        visible={!!confirmSkip}
        title="Skip today?"
        message={confirmSkip ? `"${confirmSkip.name}" will be marked as not attempted. It still counts toward today's total.` : ""}
        confirmLabel="Skip"
        T={T}
        onCancel={() => setConfirmSkip(null)}
        onConfirm={confirmSkipNow}
      />

      <ConfirmModal
        visible={!!confirmStop}
        title="Stop this task?"
        message={confirmStop ? `"${confirmStop.name}" will count as attempted but not finished.` : ""}
        confirmLabel="Stop"
        T={T}
        onCancel={() => setConfirmStop(null)}
        onConfirm={confirmStopNow}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen:        { flex: 1 },
  scroll:        { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 80 },
  centered:      { flex: 1, alignItems: "center", justifyContent: "center" },

  header:        { paddingTop: 24, paddingBottom: 22 },
  greeting:      { fontFamily: "Montserrat_600SemiBold", fontSize: 11, letterSpacing: 3, textTransform: "uppercase", marginBottom: 6 },
  dateText:      { fontFamily: "Montserrat_700Bold", fontSize: 18, letterSpacing: 0.3 },

  hero: {
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 16, padding: 20, marginBottom: 28,
    overflow: "hidden", position: "relative",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15, shadowRadius: 12, elevation: 4,
  },
  heroEmpty:     { alignItems: "center", justifyContent: "center", minHeight: 100, gap: 8 },
  heroGlow:      { position: "absolute", top: 0, left: 0, right: 0, height: 1, opacity: 0.4 },
  heroTopRow:    { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  heroLabel:     { flexDirection: "row", alignItems: "center", gap: 8 },
  heroLabelText: { fontFamily: "Montserrat_700Bold", fontSize: 10, letterSpacing: 3, textTransform: "uppercase" },
  heroLinks:     { flexDirection: "row", gap: 14 },
  heroLinkText:  { fontFamily: "Montserrat_600SemiBold", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5 },
  dot:           { width: 6, height: 6, borderRadius: 99 },
  heroName:      { fontFamily: "Montserrat_700Bold", fontSize: 22, lineHeight: 28, marginBottom: 6, letterSpacing: -0.3 },
  heroMeta:      { fontFamily: "Montserrat_500Medium", fontSize: 13, marginBottom: 18, letterSpacing: 0.3 },
  heroRemain:    { fontFamily: "Montserrat_500Medium", fontSize: 11, letterSpacing: 1, marginTop: 7 },

  progressTrack: { height: 2, borderRadius: 99, overflow: "hidden" },
  progressFill:  { height: "100%", borderRadius: 99 },

  focusBtn:      { borderRadius: 10, marginTop: 16, padding: 13, alignItems: "center", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 20, elevation: 6 },
  focusBtnText:  { fontFamily: "Montserrat_700Bold", fontSize: 12, color: "#fff", letterSpacing: 2, textTransform: "uppercase" },

  heroActionsRow: { flexDirection: "row", gap: 8, marginTop: 16 },
  actionBtn:      { flex: 1, borderRadius: 10, padding: 13, alignItems: "center", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 20, elevation: 6 },
  stopBtn:        { backgroundColor: "transparent", borderWidth: 1.5, shadowOpacity: 0, elevation: 0 },
  focusLink:      { alignItems: "center", marginTop: 12 },
  focusLinkText:  { fontFamily: "Montserrat_600SemiBold", fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase" },

  emptyIcon:     { fontFamily: "Montserrat_700Bold", fontSize: 28 },
  emptyText:     { fontFamily: "Montserrat_600SemiBold", fontSize: 15 },

  listHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 18, marginBottom: 10 },
  listLabel:     { fontFamily: "Montserrat_700Bold", fontSize: 11, letterSpacing: 3, textTransform: "uppercase", marginBottom: 10, marginTop: 18 },
  chevron:       { fontFamily: "Montserrat_700Bold", fontSize: 12 },

  taskRow:       { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  taskDone:      { opacity: 0.4 },
  checkbox:      { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  checkmark:     { fontFamily: "Montserrat_700Bold", fontSize: 9 },
  taskName:      { fontFamily: "Montserrat_600SemiBold", fontSize: 13 },
  taskMeta:      { fontFamily: "Montserrat_500Medium", fontSize: 10, marginTop: 2 },
  taskLinkText:  { fontFamily: "Montserrat_600SemiBold", fontSize: 10, textTransform: "uppercase" },

  noteLinkBtn:      { flexDirection: "row", alignItems: "center", gap: 5 },
  noteIndicatorDot: { width: 6, height: 6, borderRadius: 99 },

  noteEditor:    { marginTop: 4, marginBottom: 4, gap: 8 },
  noteInput:     { borderWidth: 1, borderRadius: 10, padding: 10, fontFamily: "Montserrat_500Medium", fontSize: 12, minHeight: 44, textAlignVertical: "top" },
  noteSaveBtn:   { alignSelf: "flex-start", borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  noteSaveBtnText: { fontFamily: "Montserrat_700Bold", fontSize: 10, color: "#fff", textTransform: "uppercase", letterSpacing: 1 },

  resolvedRow:   { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6 },
  resolvedText:  { fontFamily: "Montserrat_500Medium", fontSize: 12 },
  struck:        { textDecorationLine: "line-through" },
  resolvedTag:   { fontFamily: "Montserrat_600SemiBold", fontSize: 9, letterSpacing: 1, textTransform: "uppercase" },

  footer:        { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingBottom: 16, borderBottomWidth: 1 },
  footerLeft:    { fontFamily: "Montserrat_600SemiBold", fontSize: 12, letterSpacing: 1, textTransform: "uppercase" },
  footerRight:   { fontFamily: "Montserrat_700Bold", fontSize: 12 },

  fade:          { position: "absolute", bottom: 0, left: 0, right: 0, height: 56 } as any,
});
