import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  Platform,
  Keyboard,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useSimpleTheme, ThemeTokens } from "../../context/SimpleTheme";
import ConfirmModal from "../../components/ConfirmModal";
import { notify } from "../../utils/confirm";
import {
  Slot,
  getScheduleSlots,
  createScheduleSlot,
  updateScheduleSlot,
  deleteScheduleSlot,
} from "../../db/scheduleSlots";

const ALL_DAYS: { key: string; label: string; full: string }[] = [
  { key: "mon", label: "M", full: "Mon" },
  { key: "tue", label: "T", full: "Tue" },
  { key: "wed", label: "W", full: "Wed" },
  { key: "thu", label: "T", full: "Thu" },
  { key: "fri", label: "F", full: "Fri" },
  { key: "sat", label: "S", full: "Sat" },
  { key: "sun", label: "S", full: "Sun" },
];
const DAY_ORDER = ALL_DAYS.map(d => d.key);
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
const WEEKENDS = ["sat", "sun"];
const EVERY_DAY = DAY_ORDER;

const PRESETS: { key: string; label: string; days: string[] }[] = [
  { key: "daily",    label: "Every day", days: EVERY_DAY },
  { key: "weekdays", label: "Weekdays",  days: WEEKDAYS },
  { key: "weekends", label: "Weekends",  days: WEEKENDS },
];

const FILTER_OPTIONS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  ...PRESETS,
];

function daysToRecurrenceKey(days: string[] | undefined): string {
  const set = new Set(days ?? []);
  if (set.size === 7 && EVERY_DAY.every(d => set.has(d))) return "daily";
  if (set.size === 5 && WEEKDAYS.every(d => set.has(d))) return "weekdays";
  if (set.size === 2 && WEEKENDS.every(d => set.has(d))) return "weekends";
  return "custom";
}

function recurrenceLabel(days: string[] | undefined): string {
  const key = daysToRecurrenceKey(days);
  const preset = PRESETS.find(o => o.key === key);
  if (preset) return preset.label;
  const set = new Set(days ?? []);
  const shortMap: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
  const list = DAY_ORDER.filter(d => set.has(d)).map(d => shortMap[d]);
  return list.length ? list.join(", ") : "No days";
}

function diffMinutes(start: string, end: string) {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return mins;
}

function calcEndTime(startTime: string, durationMin: number): string {
  const [h, m] = startTime.split(":").map(Number);
  const total = h * 60 + m + durationMin;
  const endH = Math.floor(total / 60) % 24;
  const endM = total % 60;
  return `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
}

function formatDur(min: number) {
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
  }
  return `${min} min`;
}

function timesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const toMin = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const aS = toMin(aStart);
  let aE = toMin(aEnd);
  const bS = toMin(bStart);
  let bE = toMin(bEnd);
  if (aE <= aS) aE += 24 * 60;
  if (bE <= bS) bE += 24 * 60;
  return aS < bE && bS < aE;
}

function todayLocalStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatSpecificDateShort(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function getMonthMatrixLocal(year: number, month: number): (number | null)[][] {
  const firstDay = new Date(year, month - 1, 1);
  const numDays = new Date(year, month, 0).getDate();
  const firstWeekday = (firstDay.getDay() + 6) % 7;
  const cells: (number | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= numDays; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** After a reorder, repacks the affected index range [lo, hi] (in `data`,
 * the NEW order) with contiguous times based on each item's own duration —
 * starting from whatever time the range's first slot (by OLD position)
 * originally had, so the total time window the block occupies is
 * preserved; only who sits in which part of it changes. */
function resequenceRange(
  data: Slot[],
  lo: number,
  hi: number,
  anchorStart: string
): Record<string, { start_time: string; end_time: string }> {
  const changes: Record<string, { start_time: string; end_time: string }> = {};
  let cursor = anchorStart;
  for (let i = lo; i <= hi; i++) {
    const item = data[i];
    const dur = diffMinutes(item.start_time, item.end_time);
    const newEnd = calcEndTime(cursor, dur);
    changes[item.id] = { start_time: cursor, end_time: newEnd };
    cursor = newEnd;
  }
  return changes;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
const CHIP_STEP = 46;

function TimePicker({
  value, onChange, T,
}: {
  value: string; onChange: (v: string) => void; T: ThemeTokens;
}) {
  const [h, m] = value.split(":").map(Number);
  const hour = Number.isFinite(h) ? h : 9;
  const minute = Number.isFinite(m) ? m : 0;

  const hourScrollRef = useRef<ScrollView>(null);
  const minuteScrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    hourScrollRef.current?.scrollTo({ x: Math.max(0, hour - 2) * CHIP_STEP, animated: false });
    const closestIdx = MINUTES.reduce((best, val, i) =>
      Math.abs(val - minute) < Math.abs(MINUTES[best] - minute) ? i : best, 0);
    minuteScrollRef.current?.scrollTo({ x: Math.max(0, closestIdx - 2) * CHIP_STEP, animated: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setHour = (nh: number) => onChange(`${String(nh).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  const setMinute = (nm: number) => onChange(`${String(hour).padStart(2, "0")}:${String(nm).padStart(2, "0")}`);

  return (
    <View>
      <Text style={[tp.bigTime, { color: T.t1 }]}>
        {String(hour).padStart(2, "0")}:{String(minute).padStart(2, "0")}
      </Text>

      <Text style={[tp.subLabel, { color: T.t2 }]}>Hour</Text>
      <ScrollView
        ref={hourScrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={tp.chipRow}
      >
        {HOURS.map(hv => {
          const active = hv === hour;
          return (
            <TouchableOpacity
              key={hv}
              style={[tp.chip, { borderColor: T.border }, active && { backgroundColor: T.orange, borderColor: T.orange }]}
              onPress={() => setHour(hv)}
            >
              <Text style={[tp.chipText, { color: active ? "#fff" : T.t2 }]}>{String(hv).padStart(2, "0")}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <Text style={[tp.subLabel, { color: T.t2, marginTop: 12 }]}>Minute</Text>
      <ScrollView
        ref={minuteScrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={tp.chipRow}
      >
        {MINUTES.map(mv => {
          const active = mv === minute;
          return (
            <TouchableOpacity
              key={mv}
              style={[tp.chip, { borderColor: T.border }, active && { backgroundColor: T.orange, borderColor: T.orange }]}
              onPress={() => setMinute(mv)}
            >
              <Text style={[tp.chipText, { color: active ? "#fff" : T.t2 }]}>{String(mv).padStart(2, "0")}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

function MiniCalendar({
  value, onChange, T,
}: {
  value: string; onChange: (d: string) => void; T: ThemeTokens;
}) {
  const initial = value ? new Date(value + "T00:00:00") : new Date();
  const [year, setYear] = useState(initial.getFullYear());
  const [month, setMonth] = useState(initial.getMonth() + 1);

  const prevMonth = () => { if (month === 1) { setMonth(12); setYear(y => y - 1); } else setMonth(m => m - 1); };
  const nextMonth = () => { if (month === 12) { setMonth(1); setYear(y => y + 1); } else setMonth(m => m + 1); };

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });

  return (
    <View>
      <View style={mc.header}>
        <TouchableOpacity onPress={prevMonth} style={mc.navBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={[mc.navText, { color: T.t2 }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[mc.monthLabel, { color: T.t1 }]}>{monthLabel}</Text>
        <TouchableOpacity onPress={nextMonth} style={mc.navBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={[mc.navText, { color: T.t2 }]}>›</Text>
        </TouchableOpacity>
      </View>
      <View style={mc.weekRow}>
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <Text key={i} style={[mc.weekLabel, { color: T.t3 }]}>{d}</Text>
        ))}
      </View>
      {getMonthMatrixLocal(year, month).map((week, wi) => (
        <View key={wi} style={mc.weekRow}>
          {week.map((day, di) => {
            if (day === null) return <View key={di} style={mc.cell} />;
            const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const isSelected = value === dateStr;
            return (
              <View key={di} style={mc.cell}>
                <TouchableOpacity
                  style={[mc.dayBtn, isSelected && { backgroundColor: T.orange }]}
                  onPress={() => onChange(dateStr)}
                >
                  <Text style={[mc.dayText, { color: isSelected ? "#fff" : T.t1 }]}>{day}</Text>
                </TouchableOpacity>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function SlotModal({
  slot,
  allSlots,
  onClose,
  onSave,
  onDelete,
  totalSlots,
  T,
}: {
  slot: Partial<Slot> | null;
  allSlots: Slot[];
  onClose: () => void;
  onSave: (data: Partial<Slot>) => void;
  onDelete?: (id: string) => void;
  totalSlots: number;
  T: ThemeTokens;
}) {
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [kbHeight, setKbHeight] = useState(0);

  // KeyboardAvoidingView's built-in behaviors assume they're anchored near
  // the actual screen root; this sheet lives inside a manually absolutely-
  // positioned overlay, so its height heuristics miscalculate and the sheet
  // stays put while the keyboard covers it. Tracking the real keyboard
  // height and pushing the sheet up by exactly that amount is more direct
  // and doesn't depend on those heuristics working out.
  useEffect(() => {
    const showEvt = Platform.OS === "android" ? "keyboardDidShow" : "keyboardWillShow";
    const hideEvt = Platform.OS === "android" ? "keyboardDidHide" : "keyboardWillHide";
    const showSub = Keyboard.addListener(showEvt, (e) => setKbHeight(e.endCoordinates?.height ?? 0));
    const hideSub = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  const isNew = !slot?.id;
  const [label, setLabel] = useState(slot?.label ?? "");
  const [time, setTime] = useState(slot?.start_time ?? "09:00");
  const initialDuration = slot?.start_time && slot?.end_time ? diffMinutes(slot.start_time, slot.end_time) : 30;
  const [duration, setDuration] = useState(String(initialDuration));
  const [selectedDays, setSelectedDays] = useState<string[]>(slot?.days ?? EVERY_DAY);
  const [notes, setNotes] = useState(slot?.notes ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isOneOff, setIsOneOff] = useState(!!slot?.specific_date);
  const [specificDate, setSpecificDate] = useState(slot?.specific_date || todayLocalStr());

  const toggleDay = (key: string) => {
    setSelectedDays(prev => prev.includes(key) ? prev.filter(d => d !== key) : [...prev, key]);
  };

  const draftEnd = calcEndTime(time, parseInt(duration, 10) || 30);
  const conflicts = isOneOff ? [] : allSlots.filter(s =>
    s.id !== slot?.id &&
    s.days.some(d => selectedDays.includes(d)) &&
    timesOverlap(time, draftEnd, s.start_time, s.end_time)
  );

  const handleSave = () => {
    if (!label.trim()) {
      notify("Name required", "Please enter a name for this activity.");
      return;
    }
    if (!isOneOff && selectedDays.length === 0) {
      notify("Select at least one day", "Choose at least one day for this activity to repeat on.");
      return;
    }

    const dur = parseInt(duration, 10) || 30;

    const payload: Partial<Slot> = {
      id: slot?.id,
      label: label.trim(),
      start_time: time,
      end_time: calcEndTime(time, dur),
      order_index: slot?.order_index ?? totalSlots,
      notes: notes.trim() || undefined,
    };

    if (isOneOff) {
      payload.specific_date = specificDate;
      payload.days = EVERY_DAY;
    } else {
      payload.days = selectedDays;
      if (!isNew && slot?.specific_date) {
        payload.specific_date = "";
      }
    }

    onSave(payload);
  };

  const handleDelete = () => {
    if (!slot?.id) return;
    setConfirmDelete(true);
  };

  const confirmDeleteNow = () => {
    setConfirmDelete(false);
    if (slot?.id) onDelete?.(slot.id);
  };

  return (
    <View style={ms.overlay}>
      <TouchableOpacity style={ms.backdrop} activeOpacity={1} onPress={onClose} />
      <View style={[ms.sheetWrap, { marginBottom: kbHeight }]}>
        <ScrollView
          ref={scrollRef}
          style={[ms.sheet, { backgroundColor: T.surface, borderColor: T.border }]}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[ms.sheetTitle, { color: T.t1 }]}>{isNew ? "Add activity" : "Edit activity"}</Text>

          <Text style={[ms.fieldLabel, { color: T.t2 }]}>Name</Text>
          <TextInput
            style={[ms.input, { backgroundColor: T.bg, borderColor: T.border, color: T.t1 }]}
            value={label}
            onChangeText={setLabel}
            placeholder="Activity name"
            placeholderTextColor={T.t2}
          />

          <Text style={[ms.fieldLabel, { color: T.t2 }]}>Time</Text>
          <TimePicker value={time} onChange={setTime} T={T} />

          <Text style={[ms.fieldLabel, { color: T.t2 }]}>Duration (min)</Text>
          <TextInput
            style={[ms.input, { backgroundColor: T.bg, borderColor: T.border, color: T.t1 }]}
            value={duration}
            onChangeText={setDuration}
            keyboardType="number-pad"
            placeholder="30"
            placeholderTextColor={T.t2}
          />

          <Text style={[ms.fieldLabel, { color: T.t2 }]}>Schedule type</Text>
          <View style={ms.recurrenceRow}>
            <TouchableOpacity
              style={[
                ms.recurrenceBtn,
                { borderColor: T.border },
                !isOneOff && { backgroundColor: T.orange, borderColor: T.orange },
              ]}
              onPress={() => setIsOneOff(false)}
            >
              <Text style={[ms.recurrenceBtnText, { color: !isOneOff ? "#fff" : T.t2 }]}>Recurring</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                ms.recurrenceBtn,
                { borderColor: T.border },
                isOneOff && { backgroundColor: T.orange, borderColor: T.orange },
              ]}
              onPress={() => setIsOneOff(true)}
            >
              <Text style={[ms.recurrenceBtnText, { color: isOneOff ? "#fff" : T.t2 }]}>One-off</Text>
            </TouchableOpacity>
          </View>

          {isOneOff ? (
            <>
              <Text style={[ms.fieldLabel, { color: T.t2 }]}>Date</Text>
              <MiniCalendar value={specificDate} onChange={setSpecificDate} T={T} />
            </>
          ) : (
            <>
              {conflicts.length > 0 && (
                <View style={[ms.warningBox, { backgroundColor: `${T.danger}22`, borderColor: T.danger }]}>
                  <Text style={[ms.warningText, { color: T.danger }]}>
                    ⚠ Overlaps with {conflicts.map(c => c.label).join(", ")}
                  </Text>
                </View>
              )}

              <Text style={[ms.fieldLabel, { color: T.t2 }]}>Repeat</Text>
              <View style={ms.recurrenceRow}>
                {PRESETS.map(opt => {
                  const active = daysToRecurrenceKey(selectedDays) === opt.key;
                  return (
                    <TouchableOpacity
                      key={opt.key}
                      style={[
                        ms.recurrenceBtn,
                        { borderColor: T.border },
                        active && { backgroundColor: T.orange, borderColor: T.orange },
                      ]}
                      onPress={() => setSelectedDays(opt.days)}
                    >
                      <Text style={[ms.recurrenceBtnText, { color: active ? "#fff" : T.t2 }]}>
                        {opt.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <View style={ms.dayPickerRow}>
                {ALL_DAYS.map(d => {
                  const active = selectedDays.includes(d.key);
                  return (
                    <TouchableOpacity
                      key={d.key}
                      style={[
                        ms.dayChip,
                        { borderColor: T.border },
                        active && { backgroundColor: T.orange, borderColor: T.orange },
                      ]}
                      onPress={() => toggleDay(d.key)}
                    >
                      <Text style={[ms.dayChipText, { color: active ? "#fff" : T.t2 }]}>{d.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </>
          )}

          <Text style={[ms.fieldLabel, { color: T.t2 }]}>Notes (optional)</Text>
          <TextInput
            style={[ms.input, ms.notesInput, { backgroundColor: T.bg, borderColor: T.border, color: T.t1 }]}
            value={notes}
            onChangeText={setNotes}
            // Android's ScrollView doesn't auto-scroll a focused input into
            // view the way iOS does, so KeyboardAvoidingView's "height"
            // behavior alone isn't enough here — the Notes field sits near
            // the bottom, right where the keyboard covers it. Scrolling to
            // the end on focus reliably brings it above the keyboard.
            onFocus={() => {
              setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
            }}
            placeholder="Add a note..."
            placeholderTextColor={T.t2}
            multiline
          />

          <View style={ms.actionsRow}>
            <TouchableOpacity style={[ms.cancelBtn, { backgroundColor: T.border }]} onPress={onClose}>
              <Text style={[ms.cancelBtnText, { color: T.t2 }]}>Cancel</Text>
            </TouchableOpacity>

            <TouchableOpacity style={[ms.saveBtn, { backgroundColor: T.orange }]} onPress={handleSave}>
              <Text style={ms.saveBtnText}>Save</Text>
            </TouchableOpacity>
          </View>

          {!isNew && (
            <TouchableOpacity style={ms.deleteBtnFull} onPress={handleDelete}>
              <Text style={[ms.deleteBtnText, { color: T.danger }]}>Delete activity</Text>
            </TouchableOpacity>
          )}

          {/* Fixed 12px was fine on devices with no system nav bar, but on
              edge-to-edge Android (or the iPhone home indicator) it left the
              Save/Delete buttons sitting right at the true screen edge,
              underneath the system's own nav area. Padding by the actual
              bottom inset keeps them clear of it on every device. */}
          <View style={{ height: 12 + insets.bottom }} />
        </ScrollView>
      </View>

      <ConfirmModal
        visible={confirmDelete}
        title="Delete activity?"
        message="This cannot be undone."
        confirmLabel="Delete"
        T={T}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={confirmDeleteNow}
      />
    </View>
  );
}

function RoutineRow({
  slot,
  canReorder,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  T,
  onOpenEdit,
}: {
  slot: Slot;
  canReorder: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  T: ThemeTokens;
  onOpenEdit: (slot: Slot) => void;
}) {
  const duration = diffMinutes(slot.start_time, slot.end_time);
  const isOneOffSlot = !!slot.specific_date;

  return (
    <View style={[s.item, { backgroundColor: T.surface, borderColor: T.border }]}>
      <TouchableOpacity style={s.itemBody} onPress={() => onOpenEdit(slot)} activeOpacity={0.7}>
        <View style={s.itemInfo}>
          <View style={s.itemNameRow}>
            <Text style={[s.itemName, { color: T.t1 }]}>{slot.label}</Text>
            {!!slot.notes && <View style={[s.noteDot, { backgroundColor: T.orange }]} />}
          </View>
          <Text style={[s.itemMeta, { color: T.t2 }]}>
            {slot.start_time} · {formatDur(duration)}
            {isOneOffSlot ? ` · ${formatSpecificDateShort(slot.specific_date!)}` : ""}
          </Text>
        </View>
        <View style={[s.badge, { borderColor: isOneOffSlot ? T.orange : T.border }]}>
          <Text style={[s.badgeText, { color: isOneOffSlot ? T.orange : T.t2 }]}>
            {isOneOffSlot ? "One-off" : recurrenceLabel(slot.days)}
          </Text>
        </View>
      </TouchableOpacity>

      {canReorder && (
        <View style={s.reorderCol}>
          <TouchableOpacity
            onPress={onMoveUp}
            disabled={isFirst}
            style={s.reorderBtn}
            hitSlop={{ top: 6, bottom: 2, left: 8, right: 8 }}
          >
            <Ionicons name="chevron-up" size={16} color={isFirst ? T.border : T.t3} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onMoveDown}
            disabled={isLast}
            style={s.reorderBtn}
            hitSlop={{ top: 2, bottom: 6, left: 8, right: 8 }}
          >
            <Ionicons name="chevron-down" size={16} color={isLast ? T.border : T.t3} />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

export default function RoutineScreen() {
  const { T } = useSimpleTheme();
  const params = useLocalSearchParams<{ editSlotId?: string }>();
  const router = useRouter();
  const handledEditParam = useRef<string | null>(null);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Slot> | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [filter, setFilter] = useState("all");
  // A stack of reorder steps, most recent last. Undo always reverts the
  // last step and pops it, so repeated presses walk back through history.
  // Persists for as long as the user stays on this screen — cleared on
  // blur, not on a timer.
  const [undoStack, setUndoStack] = useState<{ id: string; start_time: string; end_time: string }[][]>([]);

  const fetchSlots = useCallback(async () => {
    try {
      const raw = await getScheduleSlots();
      setSlots([...raw].sort((a, b) => a.start_time.localeCompare(b.start_time)));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchSlots();
      return () => setUndoStack([]);
    }, [fetchSlots])
  );

  const openAdd = () => {
    setEditing({});
    setModalOpen(true);
  };

  const openEdit = useCallback((slot: Slot) => {
    setEditing(slot);
    setModalOpen(true);
  }, []);

  const closeModal = () => {
    setModalOpen(false);
    setEditing(null);
  };

  useEffect(() => {
    const targetId = params.editSlotId;
    if (!targetId || loading || handledEditParam.current === targetId) return;
    const slot = slots.find(s => s.id === targetId);
    if (slot) {
      handledEditParam.current = targetId;
      openEdit(slot);
      router.setParams({ editSlotId: undefined });
    }
  }, [params.editSlotId, loading, slots, openEdit]);

  const saveSlot = async (data: Partial<Slot>) => {
    try {
      if (data.id) {
        await updateScheduleSlot(data.id, {
          label: data.label,
          start_time: data.start_time,
          end_time: data.end_time,
          order_index: data.order_index,
          days: data.days,
          notes: data.notes ?? null,
          ...(data.specific_date !== undefined ? { specific_date: data.specific_date ?? "" } : {}),
        });
      } else {
        await createScheduleSlot({
          label: data.label!,
          start_time: data.start_time!,
          end_time: data.end_time!,
          order_index: data.order_index ?? slots.length,
          days: data.days ?? EVERY_DAY,
          notes: data.notes ?? null,
          specific_date: data.specific_date ?? null,
        });
      }

      closeModal();
      fetchSlots();
    } catch (e) {
      notify("Error", String(e));
    }
  };

  const deleteSlot = async (id: string) => {
    try {
      await deleteScheduleSlot(id);
      closeModal();
      fetchSlots();
    } catch (e) {
      console.error(e);
    }
  };

  // Applies a reorder of the affected range [lo, hi] (in `newData`, the new
  // order) by repacking it with contiguous times anchored to whatever time
  // the range's first slot (by OLD position) originally had.
  const applyReorder = useCallback((newData: Slot[], lo: number, hi: number) => {
    const anchorStart = slots[lo]?.start_time;
    if (!anchorStart) return;

    const changes = resequenceRange(newData, lo, hi, anchorStart);
    if (Object.keys(changes).length === 0) return;

    const snapshot = Object.keys(changes).map(id => {
      const orig = slots.find(s => s.id === id);
      return orig ? { id, start_time: orig.start_time, end_time: orig.end_time } : null;
    }).filter((s): s is { id: string; start_time: string; end_time: string } => s !== null);
    if (snapshot.length > 0) setUndoStack(prev => [...prev, snapshot]);

    Promise.all(Object.entries(changes).map(([id, ch]) => updateScheduleSlot(id, ch)))
      .catch(e => console.error(e));

    setSlots(prevSlots => {
      const next = prevSlots.map(s => changes[s.id] ? { ...s, ...changes[s.id] } : s);
      return [...next].sort((a, b) => a.start_time.localeCompare(b.start_time));
    });
  }, [slots]);

  // Swaps the slot at `index` with its immediate neighbor in the given
  // direction and repacks the two affected times. Only enabled while
  // filter === "all", so `index` here always lines up with `slots`' own
  // order (visibleSlots === slots in that case).
  const moveSlot = useCallback((index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= slots.length) return;
    const newData = [...slots];
    [newData[index], newData[target]] = [newData[target], newData[index]];
    applyReorder(newData, Math.min(index, target), Math.max(index, target));
  }, [slots, applyReorder]);

  const handleUndo = useCallback(() => {
    setUndoStack(prevStack => {
      if (prevStack.length === 0) return prevStack;
      const step = prevStack[prevStack.length - 1];

      setSlots(prevSlots => {
        const map: Record<string, { start_time: string; end_time: string }> = {};
        step.forEach(s => { map[s.id] = { start_time: s.start_time, end_time: s.end_time }; });

        Promise.all(step.map(s => updateScheduleSlot(s.id, map[s.id])))
          .catch(e => console.error(e));

        const next = prevSlots.map(s => map[s.id] ? { ...s, ...map[s.id] } : s);
        return [...next].sort((a, b) => a.start_time.localeCompare(b.start_time));
      });

      return prevStack.slice(0, -1);
    });
  }, []);

  const visibleSlots = filter === "all"
    ? slots
    : slots.filter(slot => daysToRecurrenceKey(slot.days) === filter);

  const canReorder = filter === "all";

  if (loading) {
    return (
      <View style={[s.centered, { backgroundColor: T.bg }]}>
        <ActivityIndicator color={T.orange} />
      </View>
    );
  }

  return (
    <View style={[s.screen, { backgroundColor: T.bg }]}>
      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.header}>
          <Text style={[s.eyebrow, { color: T.orange }]}>Daily template</Text>
          <Text style={[s.title, { color: T.t1 }]}>Routine</Text>
          <Text style={[s.subtitle, { color: T.t2 }]}>Activities repeat on your schedule</Text>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.filterRow}
          style={s.filterScroll}
        >
          {FILTER_OPTIONS.map(opt => {
            const active = filter === opt.key;
            return (
              <TouchableOpacity
                key={opt.key}
                style={[
                  s.filterBtn,
                  { borderColor: T.border },
                  active && { backgroundColor: T.orange, borderColor: T.orange },
                ]}
                onPress={() => setFilter(opt.key)}
              >
                <Text style={[s.filterBtnText, { color: active ? "#fff" : T.t2 }]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {visibleSlots.length === 0 && (
          <View style={s.emptyState}>
            <Text style={[s.emptyIcon, { color: T.orange }]}>↻</Text>
            <Text style={[s.emptyTitle, { color: T.t1 }]}>No activities yet</Text>
            <Text style={[s.emptyDesc, { color: T.t2 }]}>
              {slots.length === 0
                ? "Add your daily activities below. They'll repeat on your schedule and generate tasks each morning."
                : "No activities match this filter."}
            </Text>
          </View>
        )}

        {visibleSlots.map((slot, i) => (
          <RoutineRow
            key={slot.id}
            slot={slot}
            canReorder={canReorder}
            isFirst={i === 0}
            isLast={i === visibleSlots.length - 1}
            onMoveUp={() => moveSlot(i, -1)}
            onMoveDown={() => moveSlot(i, 1)}
            T={T}
            onOpenEdit={openEdit}
          />
        ))}

        <View style={{ height: 72 }} />
      </ScrollView>

      <LinearGradient colors={["transparent", T.bg]} style={s.fade} pointerEvents="none" />

      {undoStack.length > 0 && (
        <TouchableOpacity
          style={[s.fab, s.undoFab, { backgroundColor: T.orange }]}
          onPress={handleUndo}
          activeOpacity={0.85}
        >
          <Ionicons name="arrow-undo" size={24} color="#fff" />
          {undoStack.length > 1 && (
            <View style={[s.undoBadge, { backgroundColor: T.bg, borderColor: T.orange }]}>
              <Text style={[s.undoBadgeText, { color: T.orange }]}>{undoStack.length}</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={[s.fab, { backgroundColor: T.orange }]}
        onPress={openAdd}
        activeOpacity={0.85}
      >
        <Ionicons name="add" size={26} color="#fff" />
      </TouchableOpacity>

      {modalOpen && (
        <SlotModal
          slot={editing}
          allSlots={slots}
          onClose={closeModal}
          onSave={saveSlot}
          onDelete={deleteSlot}
          totalSlots={slots.length}
          T={T}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 20 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: { paddingTop: 24, paddingBottom: 22 },
  eyebrow: { fontFamily: "Montserrat_700Bold", fontSize: 11, letterSpacing: 4, textTransform: "uppercase", marginBottom: 6 },
  title: { fontFamily: "Montserrat_700Bold", fontSize: 28, lineHeight: 34 },
  subtitle: { fontFamily: "Montserrat_500Medium", fontSize: 13, marginTop: 5 },

  filterScroll: { marginBottom: 18, flexGrow: 0 },
  filterRow: { flexDirection: "row", gap: 8, paddingRight: 20 },
  filterBtn: { borderWidth: 1, borderRadius: 99, paddingVertical: 7, paddingHorizontal: 14 },
  filterBtnText: { fontFamily: "Montserrat_600SemiBold", fontSize: 11 },

  emptyState: { alignItems: "center", paddingVertical: 40, paddingHorizontal: 20 },
  emptyIcon: { fontSize: 40, marginBottom: 16 },
  emptyTitle: { fontFamily: "Montserrat_700Bold", fontSize: 18, marginBottom: 10, textAlign: "center" },
  emptyDesc: { fontFamily: "Montserrat_500Medium", fontSize: 13, textAlign: "center", lineHeight: 20 },
  item: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 6 },
  itemBody: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  itemInfo: { flex: 1 },
  itemNameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  itemName: { fontFamily: "Montserrat_600SemiBold", fontSize: 13 },
  noteDot: { width: 5, height: 5, borderRadius: 99 },
  itemMeta: { fontFamily: "Montserrat_500Medium", fontSize: 11, marginTop: 3 },
  badge: { borderWidth: 1, borderRadius: 99, paddingVertical: 4, paddingHorizontal: 10 },
  badgeText: { fontFamily: "Montserrat_600SemiBold", fontSize: 10 },
  fade: { position: "absolute", bottom: 0, left: 0, right: 0, height: 56 } as any,

  reorderCol: { paddingLeft: 10, alignItems: "center", justifyContent: "center" },
  reorderBtn: { paddingVertical: 3, paddingHorizontal: 4 },

  fab: {
    position: "absolute",
    right: 20,
    bottom: 28,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },

  undoFab: { position: "absolute", left: 20, right: undefined, bottom: 28 },
  undoBadge: {
    position: "absolute",
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  undoBadgeText: { fontFamily: "Montserrat_700Bold", fontSize: 11 },
});

const ms = StyleSheet.create({
  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.75)", zIndex: 999, elevation: 999 },
  backdrop: { flex: 1 },
  sheetWrap: { maxHeight: "88%" },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, borderTopWidth: 1 },
  sheetTitle: { fontFamily: "Montserrat_700Bold", fontSize: 18, marginBottom: 20 },
  fieldLabel: { fontFamily: "Montserrat_600SemiBold", fontSize: 11, letterSpacing: 2, textTransform: "uppercase", marginBottom: 8, marginTop: 14 },
  input: { borderWidth: 1, borderRadius: 10, padding: 13, fontFamily: "Montserrat_500Medium", fontSize: 14 },
  notesInput: { height: 70, textAlignVertical: "top" },
  warningBox: { borderWidth: 1, borderRadius: 10, padding: 10, marginTop: 10 },
  warningText: { fontFamily: "Montserrat_600SemiBold", fontSize: 11 },
  recurrenceRow: { flexDirection: "row", gap: 8 },
  recurrenceBtn: { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  recurrenceBtnText: { fontFamily: "Montserrat_600SemiBold", fontSize: 12 },
  dayPickerRow: { flexDirection: "row", gap: 6, marginTop: 10 },
  dayChip: { flex: 1, aspectRatio: 1, borderWidth: 1, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  dayChipText: { fontFamily: "Montserrat_700Bold", fontSize: 12 },
  actionsRow: { flexDirection: "row", gap: 8, marginTop: 24 },
  cancelBtn: { flex: 1, borderRadius: 10, padding: 13, alignItems: "center" },
  cancelBtnText: { fontFamily: "Montserrat_600SemiBold", fontSize: 13 },
  saveBtn: { flex: 1, borderRadius: 10, padding: 13, alignItems: "center" },
  saveBtnText: { fontFamily: "Montserrat_700Bold", fontSize: 13, color: "#fff" },
  deleteBtnFull: { marginTop: 10, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: "rgba(192,64,64,0.4)", alignItems: "center" },
  deleteBtnText: { fontFamily: "Montserrat_700Bold", fontSize: 12, letterSpacing: 0.5 },
});

const tp = StyleSheet.create({
  bigTime: { fontFamily: "Montserrat_700Bold", fontSize: 32, textAlign: "center", marginBottom: 10, letterSpacing: 1 },
  subLabel: { fontFamily: "Montserrat_600SemiBold", fontSize: 10, letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 },
  chipRow: { flexDirection: "row", gap: 6, paddingRight: 4 },
  chip: { minWidth: 40, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderRadius: 10, alignItems: "center" },
  chipText: { fontFamily: "Montserrat_700Bold", fontSize: 13 },
});

const mc = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  navBtn: { paddingHorizontal: 14, paddingVertical: 4 },
  navText: { fontFamily: "Montserrat_700Bold", fontSize: 18 },
  monthLabel: { fontFamily: "Montserrat_700Bold", fontSize: 14 },
  weekRow: { flexDirection: "row" },
  weekLabel: { flex: 1, textAlign: "center", fontFamily: "Montserrat_600SemiBold", fontSize: 10, textTransform: "uppercase", marginBottom: 6 },
  cell: { flex: 1, aspectRatio: 1, alignItems: "center", justifyContent: "center" },
  dayBtn: { width: "78%", height: "78%", borderRadius: 10, alignItems: "center", justifyContent: "center" },
  dayText: { fontFamily: "Montserrat_600SemiBold", fontSize: 12 },
});
