import React, { useState, useEffect } from "react";
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, ActivityIndicator, Platform,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import AsyncStorage from "@react-native-async-storage/async-storage";
// SDK 54 replaced expo-file-system's API with File/Directory classes and
// moved the classic documentDirectory/EncodingType/writeAsStringAsync/
// readAsStringAsync surface (still used below) to this legacy subpath.
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import Toggle from "../../components/Toggle";
import { useSimpleTheme, ThemeMode } from "../../context/SimpleTheme";
import {
  requestNotificationPermissions,
  scheduleDailySummary,
  cancelDailySummary,
  cancelTaskReminders,
} from "../../utils/notifications";
import { notify } from "../../utils/confirm";
import ConfirmModal from "../../components/ConfirmModal";
import { exportAllData, importAllData } from "../../db/backup";
import { deleteAllScheduleSlots } from "../../db/scheduleSlots";
import { clearTodayTasks, deleteAllDailyTasks } from "../../db/dailyTasks";

const APPEARANCE_OPTIONS: { key: ThemeMode; label: string }[] = [
  { key: "light",  label: "Light" },
  { key: "dark",   label: "Dark" },
  { key: "system", label: "System" },
];

interface Prefs {
  taskReminders:        boolean;
  dailySummary:         boolean;
  reminderLeadMinutes:  number;
  dailySummaryHour:     number;
}

const DEFAULTS: Prefs = {
  taskReminders:        true,
  dailySummary:         false,
  reminderLeadMinutes:  5,
  dailySummaryHour:     21,
};

const LEAD_OPTIONS = [5, 10, 15, 30];
const SUMMARY_HOUR_OPTIONS = [18, 19, 20, 21, 22, 23];

function formatHour12(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const period = hour < 12 ? "AM" : "PM";
  return `${h} ${period}`;
}

function todayStr() {
  return new Date().toISOString().split("T")[0];
}

// Separate, correct local-date helper — todayStr() above uses toISOString(),
// which gives the UTC date, not the device's local date. That's harmless
// for its current use (an export filename) but would be a real bug for
// "clear today": near midnight, it could delete the wrong day's tasks for
// anyone not on UTC (the exact class of bug _heal_premature_skips was
// written to clean up on the backend.
function localTodayStr() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function SettingsScreen() {
  const { T, themeMode, setThemeMode } = useSimpleTheme();
  const [prefs, setPrefs]         = useState<Prefs>(DEFAULTS);
  const [loading, setLoading]     = useState(true);
  const [resetting, setResetting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ slots: any[]; tasks: any[]; fileName: string } | null>(null);

  const [clearingToday, setClearingToday] = useState(false);
  const [clearingRoutine, setClearingRoutine] = useState(false);
  const [confirmClearToday, setConfirmClearToday] = useState(false);
  const [confirmClearRoutine, setConfirmClearRoutine] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const keys = ["taskReminders", "dailySummary", "reminderLeadMinutes", "dailySummaryHour"];
        const stored = await AsyncStorage.multiGet(keys);
        const parsed: Partial<Prefs> = {};
        stored.forEach(([key, val]) => {
          if (val !== null) (parsed as any)[key] = JSON.parse(val);
        });
        const merged = { ...DEFAULTS, ...parsed };
        setPrefs(merged);
        if (merged.dailySummary) {
          const granted = await requestNotificationPermissions();
          if (granted) scheduleDailySummary(merged.dailySummaryHour);
        }
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const setPref = async (key: keyof Prefs, val: boolean) => {
    setPrefs(p => ({ ...p, [key]: val }));
    try {
      await AsyncStorage.setItem(key, JSON.stringify(val));
    } catch (e) { console.error(e); }

    if (val) {
      const granted = await requestNotificationPermissions();
      if (!granted) {
        // Browsers (and the Emergent web preview in particular) often block
        // the notification permission prompt entirely. On web we keep the
        // toggle on and the preference saved rather than silently reverting
        // it — actual scheduling just gets skipped until permission is
        // available. Native keeps the old strict revert-on-denial behavior.
        if (Platform.OS !== "web") {
          setPrefs(p => ({ ...p, [key]: false }));
          await AsyncStorage.setItem(key, JSON.stringify(false));
          notify("Notifications blocked", "Enable notifications for this app in your device settings, then try again.");
        }
        return;
      }
    }

    if (key === "dailySummary") {
      if (val) await scheduleDailySummary();
      else await cancelDailySummary();
    }

    if (key === "taskReminders" && !val) {
      await cancelTaskReminders();
    }
  };

  const setReminderLead = async (minutes: number) => {
    setPrefs(p => ({ ...p, reminderLeadMinutes: minutes }));
    try {
      await AsyncStorage.setItem("reminderLeadMinutes", JSON.stringify(minutes));
    } catch (e) { console.error(e); }
    // Today re-reads this pref and reschedules the next time it fetches
    // (on focus), same as how turning taskReminders on isn't scheduled
    // from here either — there's no task list available on this screen.
  };

  const setDailySummaryHour = async (hour: number) => {
    setPrefs(p => ({ ...p, dailySummaryHour: hour }));
    try {
      await AsyncStorage.setItem("dailySummaryHour", JSON.stringify(hour));
    } catch (e) { console.error(e); }
    if (prefs.dailySummary) await scheduleDailySummary(hour);
  };

  const handleReset = () => {
    setConfirmReset(true);
  };

  const confirmResetNow = async () => {
    setConfirmReset(false);
    setResetting(true);
    try {
      const tasksDeleted = await deleteAllDailyTasks();
      const slotsDeleted = await deleteAllScheduleSlots();
      notify("Done", `Wiped ${tasksDeleted} tasks and ${slotsDeleted} activities.`);
    } catch (e: any) {
      notify("Reset failed", e?.message || "Could not reset your data.");
    } finally {
      setResetting(false);
    }
  };

  const confirmClearTodayNow = async () => {
    setConfirmClearToday(false);
    setClearingToday(true);
    try {
      const deleted = await clearTodayTasks(localTodayStr());
      notify("Done", `Cleared ${deleted} current/upcoming tasks. History is untouched.`);
    } catch (e: any) {
      notify("Clear failed", e?.message || "Could not clear today's tasks.");
    } finally {
      setClearingToday(false);
    }
  };

  const confirmClearRoutineNow = async () => {
    setConfirmClearRoutine(false);
    setClearingRoutine(true);
    try {
      const deleted = await deleteAllScheduleSlots();
      notify("Done", `Cleared ${deleted} activities from Routine. History is untouched.`);
    } catch (e: any) {
      notify("Clear failed", e?.message || "Could not clear Routine.");
    } finally {
      setClearingRoutine(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const data = await exportAllData();
      const json = JSON.stringify(data, null, 2);
      const fileName = `momentum-export-${todayStr()}.json`;

      if (Platform.OS === "web") {
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else if (Platform.OS === "android" && FileSystem.StorageAccessFramework) {
        // The share sheet (below, used as a fallback) only lists apps that
        // can *receive* a shared file — Drive, Mail, etc. — never a plain
        // "save to this folder on my phone" option. The Storage Access
        // Framework is Android's actual mechanism for that: it opens a
        // native folder picker and lets the file be written directly
        // wherever the user points it (Downloads included).
        try {
          const perm = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
          if (!perm.granted) {
            setExporting(false);
            return;
          }
          const destUri = await FileSystem.StorageAccessFramework.createFileAsync(
            perm.directoryUri, fileName, "application/json"
          );
          await FileSystem.writeAsStringAsync(destUri, json, { encoding: FileSystem.EncodingType.UTF8 });
          notify("Saved", `Backup saved as ${fileName} in the folder you chose.`);
        } catch (safErr) {
          console.error("SAF export failed, falling back to share sheet:", safErr);
          const fileUri = FileSystem.documentDirectory + fileName;
          await FileSystem.writeAsStringAsync(fileUri, json, { encoding: FileSystem.EncodingType.UTF8 });
          const canShare = await Sharing.isAvailableAsync();
          if (canShare) {
            await Sharing.shareAsync(fileUri, {
              mimeType: "application/json",
              dialogTitle: "Save your Momentum Rise backup",
            });
          } else {
            notify("Saved", `Backup saved as ${fileName}, but sharing isn't available on this device to move it elsewhere.`);
          }
        }
      } else {
        // iOS has no Storage Access Framework equivalent — the share sheet
        // (which does include a "Save to Files" option on iOS) is the
        // normal way to get a file onto the device there.
        const fileUri = FileSystem.documentDirectory + fileName;
        await FileSystem.writeAsStringAsync(fileUri, json, { encoding: FileSystem.EncodingType.UTF8 });
        const canShare = await Sharing.isAvailableAsync();
        if (canShare) {
          await Sharing.shareAsync(fileUri, {
            mimeType: "application/json",
            dialogTitle: "Save your Momentum Rise backup",
          });
        } else {
          notify("Saved", `Backup saved as ${fileName}, but sharing isn't available on this device to move it elsewhere.`);
        }
      }
    } catch (e: any) {
      notify("Export failed", e?.message || "Could not export your data. Check your connection.");
    } finally {
      setExporting(false);
    }
  };

  const parseBackupJson = (raw: string, fileName: string) => {
    // Strip a leading byte-order-mark — some transfer paths (email, cloud
    // storage, certain editors) silently prepend one to text files, and
    // JSON.parse rejects it outright even though the rest of the content
    // is otherwise valid JSON.
    const bomStripped = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const cleaned = bomStripped.trim();
    try {
      const parsed = JSON.parse(cleaned);
      const slots = Array.isArray(parsed.schedule_slots) ? parsed.schedule_slots : [];
      const tasks = Array.isArray(parsed.daily_tasks) ? parsed.daily_tasks : [];
      setPendingImport({ slots, tasks, fileName });
    } catch (err: any) {
      const preview = cleaned.slice(0, 80).replace(/\s+/g, " ");
      notify(
        "Invalid file",
        `That doesn't look like a Momentum Rise backup file.\n\n${err?.message || "Parse error"}\nFile starts with: ${preview || "(empty)"}`
      );
    }
  };

  const handleImportPress = async () => {
    if (Platform.OS === "web") {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json";
      input.onchange = (e: any) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => parseBackupJson(String(reader.result), file.name);
        reader.readAsText(file);
      };
      input.click();
      return;
    }

    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "application/json",
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const content = await FileSystem.readAsStringAsync(asset.uri);
      parseBackupJson(content, asset.name || "backup.json");
    } catch (e: any) {
      notify("Import failed", e?.message || "Could not read that file. Please try again.");
    }
  };

  const confirmImportNow = async () => {
    if (!pendingImport) return;
    const { slots, tasks } = pendingImport;
    setPendingImport(null);
    setImporting(true);
    try {
      await importAllData(slots, tasks);
      notify("Done", "Your backup has been restored. Reopen Today, Routine, and History to see it.");
    } catch (e: any) {
      notify("Import failed", e?.message || "That backup file couldn't be imported.");
    } finally {
      setImporting(false);
    }
  };

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
          <Text style={[s.eyebrow, { color: T.orange }]}>Preferences</Text>
          <Text style={[s.title, { color: T.t1 }]}>Settings</Text>
        </View>

        {/* Display */}
        <Text style={[s.sectionLabel, { color: T.t2 }]}>Display</Text>
        <View style={[s.appearanceCard, { backgroundColor: T.surface, borderColor: T.border }]}>
          <Text style={[s.rowLabel, { color: T.t1 }]}>Appearance</Text>
          <Text style={[s.rowSub, { color: T.t2, marginBottom: 12 }]}>
            {themeMode === "system" ? "Matches your device" : themeMode === "dark" ? "Always dark" : "Always light"}
          </Text>
          <View style={s.appearanceRow}>
            {APPEARANCE_OPTIONS.map(opt => {
              const active = themeMode === opt.key;
              return (
                <TouchableOpacity
                  key={opt.key}
                  style={[
                    s.appearanceBtn,
                    { borderColor: T.border },
                    active && { backgroundColor: T.orange, borderColor: T.orange },
                  ]}
                  onPress={() => setThemeMode(opt.key)}
                >
                  <Text style={[s.appearanceBtnText, { color: active ? "#fff" : T.t2 }]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Notifications */}
        <Text style={[s.sectionLabel, { color: T.t2, marginTop: 24 }]}>Notifications</Text>
        <View style={[s.row, s.rowColumn, { backgroundColor: T.surface, borderColor: T.border }]}>
          <View style={s.rowTop}>
            <View style={s.rowInfo}>
              <Text style={[s.rowLabel, { color: T.t1 }]}>Task reminders</Text>
              <Text style={[s.rowSub, { color: T.t2 }]}>{prefs.reminderLeadMinutes} min before each task</Text>
            </View>
            <Toggle
              value={prefs.taskReminders}
              onValueChange={v => setPref("taskReminders", v)}
            />
          </View>
          {prefs.taskReminders && (
            <View style={s.chipRow}>
              {LEAD_OPTIONS.map(min => {
                const active = prefs.reminderLeadMinutes === min;
                return (
                  <TouchableOpacity
                    key={min}
                    style={[
                      s.chip,
                      { borderColor: T.border },
                      active && { backgroundColor: T.orange, borderColor: T.orange },
                    ]}
                    onPress={() => setReminderLead(min)}
                  >
                    <Text style={[s.chipText, { color: active ? "#fff" : T.t2 }]}>{min} min</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>
        <View style={[s.row, s.rowColumn, { backgroundColor: T.surface, borderColor: T.border }]}>
          <View style={s.rowTop}>
            <View style={s.rowInfo}>
              <Text style={[s.rowLabel, { color: T.t1 }]}>Daily summary</Text>
              <Text style={[s.rowSub, { color: T.t2 }]}>Evening recap at {formatHour12(prefs.dailySummaryHour)}</Text>
            </View>
            <Toggle
              value={prefs.dailySummary}
              onValueChange={v => setPref("dailySummary", v)}
            />
          </View>
          {prefs.dailySummary && (
            <View style={s.chipRow}>
              {SUMMARY_HOUR_OPTIONS.map(hour => {
                const active = prefs.dailySummaryHour === hour;
                return (
                  <TouchableOpacity
                    key={hour}
                    style={[
                      s.chip,
                      { borderColor: T.border },
                      active && { backgroundColor: T.orange, borderColor: T.orange },
                    ]}
                    onPress={() => setDailySummaryHour(hour)}
                  >
                    <Text style={[s.chipText, { color: active ? "#fff" : T.t2 }]}>{formatHour12(hour)}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </View>

        {/* Data */}
        <Text style={[s.sectionLabel, { color: T.t2, marginTop: 24 }]}>Data</Text>
        <View style={[s.row, { backgroundColor: T.surface, borderColor: T.border }]}>
          <View style={s.rowInfo}>
            <Text style={[s.rowLabel, { color: T.t1 }]}>Export data</Text>
            <Text style={[s.rowSub, { color: T.t2 }]}>Download a backup file</Text>
          </View>
          <TouchableOpacity
            style={[s.exportBtn, { borderColor: T.border }]}
            onPress={handleExport}
            disabled={exporting}
          >
            {exporting
              ? <ActivityIndicator size="small" color={T.t1} />
              : <Text style={[s.exportBtnText, { color: T.t1 }]}>Export</Text>
            }
          </TouchableOpacity>
        </View>
        <View style={[s.row, { backgroundColor: T.surface, borderColor: T.border }]}>
          <View style={s.rowInfo}>
            <Text style={[s.rowLabel, { color: T.t1 }]}>Import data</Text>
            <Text style={[s.rowSub, { color: T.t2 }]}>Restore from a backup file</Text>
          </View>
          <TouchableOpacity
            style={[s.exportBtn, { borderColor: T.border }]}
            onPress={handleImportPress}
            disabled={importing}
          >
            {importing
              ? <ActivityIndicator size="small" color={T.t1} />
              : <Text style={[s.exportBtnText, { color: T.t1 }]}>Import</Text>
            }
          </TouchableOpacity>
        </View>

        <View style={[s.row, s.dangerRow, { backgroundColor: T.surface }]}>
          <View style={s.rowInfo}>
            <Text style={[s.rowLabel, { color: T.danger }]}>Clear today's tasks</Text>
            <Text style={[s.rowSub, { color: T.t2 }]}>Wipe current/upcoming tasks only</Text>
          </View>
          <TouchableOpacity
            style={s.resetBtn}
            onPress={() => setConfirmClearToday(true)}
            disabled={clearingToday}
          >
            {clearingToday
              ? <ActivityIndicator size="small" color={T.danger} />
              : <Text style={[s.resetBtnText, { color: T.danger }]}>Clear</Text>
            }
          </TouchableOpacity>
        </View>
        <View style={[s.row, s.dangerRow, { backgroundColor: T.surface }]}>
          <View style={s.rowInfo}>
            <Text style={[s.rowLabel, { color: T.danger }]}>Clear Routine</Text>
            <Text style={[s.rowSub, { color: T.t2 }]}>Wipe the activity template only</Text>
          </View>
          <TouchableOpacity
            style={s.resetBtn}
            onPress={() => setConfirmClearRoutine(true)}
            disabled={clearingRoutine}
          >
            {clearingRoutine
              ? <ActivityIndicator size="small" color={T.danger} />
              : <Text style={[s.resetBtnText, { color: T.danger }]}>Clear</Text>
            }
          </TouchableOpacity>
        </View>
        <View style={[s.row, s.dangerRow, { backgroundColor: T.surface }]}>
          <View style={s.rowInfo}>
            <Text style={[s.rowLabel, { color: T.danger }]}>Reset all data</Text>
            <Text style={[s.rowSub, { color: T.t2 }]}>Wipe tasks and history</Text>
          </View>
          <TouchableOpacity
            style={s.resetBtn}
            onPress={handleReset}
            disabled={resetting}
          >
            {resetting
              ? <ActivityIndicator size="small" color={T.danger} />
              : <Text style={[s.resetBtnText, { color: T.danger }]}>Reset</Text>
            }
          </TouchableOpacity>
        </View>

        <Text style={[s.version, { color: T.t3 }]}>Momentum Rise</Text>
        <View style={{ height: 24 }} />
      </ScrollView>

      <LinearGradient
        colors={["transparent", T.bg]}
        style={s.fade}
        pointerEvents="none"
      />

      <ConfirmModal
        visible={confirmReset}
        title="Reset all data?"
        message="This will wipe all tasks and history. This cannot be undone."
        confirmLabel="Reset"
        T={T}
        onCancel={() => setConfirmReset(false)}
        onConfirm={confirmResetNow}
      />

      <ConfirmModal
        visible={confirmClearToday}
        title="Clear today's tasks?"
        message="This deletes today's (and any already-created upcoming) tasks so Today starts fresh from your current Routine. Past history and Trends are not affected."
        confirmLabel="Clear"
        T={T}
        onCancel={() => setConfirmClearToday(false)}
        onConfirm={confirmClearTodayNow}
      />

      <ConfirmModal
        visible={confirmClearRoutine}
        title="Clear Routine?"
        message="This removes all activities from your Routine template. Today's already-generated tasks and all past history are not affected."
        confirmLabel="Clear"
        T={T}
        onCancel={() => setConfirmClearRoutine(false)}
        onConfirm={confirmClearRoutineNow}
      />

      <ConfirmModal
        visible={!!pendingImport}
        title="Import data?"
        message={pendingImport
          ? `This replaces all current activities and tasks with "${pendingImport.fileName}" (${pendingImport.slots.length} activities, ${pendingImport.tasks.length} tasks). This cannot be undone.`
          : ""}
        confirmLabel="Import"
        T={T}
        onCancel={() => setPendingImport(null)}
        onConfirm={confirmImportNow}
      />
    </View>
  );
}

const s = StyleSheet.create({
  screen:        { flex: 1 },
  scroll:        { flex: 1 },
  scrollContent: { paddingHorizontal: 20, paddingBottom: 80 },
  centered:      { flex: 1, alignItems: "center", justifyContent: "center" },

  header:        { paddingTop: 24, paddingBottom: 22 },
  eyebrow:       { fontFamily: "Montserrat_700Bold", fontSize: 11, letterSpacing: 4, textTransform: "uppercase", marginBottom: 6 },
  title:         { fontFamily: "Montserrat_700Bold", fontSize: 28, lineHeight: 34 },

  sectionLabel:  { fontFamily: "Montserrat_700Bold", fontSize: 10, letterSpacing: 3, textTransform: "uppercase", marginBottom: 10, paddingLeft: 2 },

  row:           { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, borderWidth: 1, borderRadius: 14, padding: 16, marginBottom: 8 },
  rowColumn:     { flexDirection: "column", alignItems: "stretch" },
  rowTop:        { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  dangerRow:     { borderWidth: 1, borderColor: "rgba(192,64,64,0.25)" },
  rowInfo:       { flex: 1 },
  rowLabel:      { fontFamily: "Montserrat_600SemiBold", fontSize: 14 },
  rowSub:        { fontFamily: "Montserrat_500Medium", fontSize: 11, marginTop: 3 },

  chipRow:       { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  chip:          { borderWidth: 1, borderRadius: 99, paddingVertical: 7, paddingHorizontal: 14 },
  chipText:      { fontFamily: "Montserrat_600SemiBold", fontSize: 11 },

  appearanceCard:   { borderWidth: 1, borderRadius: 14, padding: 16, marginBottom: 8 },
  appearanceRow:    { flexDirection: "row", gap: 8 },
  appearanceBtn:    { flex: 1, borderWidth: 1, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  appearanceBtnText: { fontFamily: "Montserrat_600SemiBold", fontSize: 12 },

  exportBtn:      { borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, minWidth: 64, alignItems: "center" },
  exportBtnText:  { fontFamily: "Montserrat_700Bold", fontSize: 11, letterSpacing: 1, textTransform: "uppercase" },

  resetBtn:      { borderWidth: 1, borderColor: "rgba(192,64,64,0.35)", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, minWidth: 64, alignItems: "center" },
  resetBtnText:  { fontFamily: "Montserrat_700Bold", fontSize: 11, letterSpacing: 1, textTransform: "uppercase" },

  version:       { fontFamily: "Montserrat_500Medium", fontSize: 11, textAlign: "center", letterSpacing: 2, paddingTop: 20 },

  fade:          { position: "absolute", bottom: 0, left: 0, right: 0, height: 56 } as any,
});
