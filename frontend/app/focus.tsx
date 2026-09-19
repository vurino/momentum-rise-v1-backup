import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Animated, Dimensions, StatusBar, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useTheme, SPACING, RADIUS, FONT } from '../context/ThemeContext';
import { getDailyTasks, updateDailyTask } from '../db/dailyTasks';

const { width: SW } = Dimensions.get('window');

const iconMap: Record<string, string> = {
  'restaurant': 'restaurant-outline', 'sunny': 'sunny-outline', 'briefcase': 'briefcase-outline',
  'cafe': 'cafe-outline', 'trending-up': 'trending-up-outline', 'book': 'book-outline',
  'fitness': 'fitness-outline', 'fast-food': 'fast-food-outline', 'analytics': 'analytics-outline',
  'code': 'code-slash-outline', 'moon': 'moon-outline', 'bed': 'bed-outline', 'time': 'time-outline',
  'heart': 'heart-outline', 'musical-notes': 'musical-notes-outline',
  'game-controller': 'game-controller-outline', 'car': 'car-outline', 'home': 'home-outline',
  'pencil': 'pencil-outline', 'school': 'school-outline', 'walk': 'walk-outline',
  'water': 'water-outline', 'leaf': 'leaf-outline', 'medkit': 'medkit-outline',
  'settings': 'settings-outline',
};
const getIcon = (name: string): keyof typeof Ionicons.glyphMap => {
  if (!name) return 'time-outline';
  if (iconMap[name]) return iconMap[name] as keyof typeof Ionicons.glyphMap;
  if (name.endsWith('-outline')) return name as keyof typeof Ionicons.glyphMap;
  return (name + '-outline') as keyof typeof Ionicons.glyphMap;
};

const parseTimeToDate = (t: string): Date => {
  const [h, m] = t.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
};

const formatRemaining = (ms: number) => {
  if (ms <= 0) return { hours: 0, minutes: 0, seconds: 0 };
  const total = Math.floor(ms / 1000);
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
};

const pad = (n: number) => n.toString().padStart(2, '0');

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type Outcome = 'none' | 'completed' | 'stopped' | 'skipped';

export default function FocusScreen() {
  const { isDark, colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams();

  const taskId    = params.id as string | undefined;
  const taskDate  = params.date as string | undefined;
  const label     = (params.label as string)      || 'Focus Time';
  const icon      = (params.icon as string)       || 'time';
  const startTime = (params.start_time as string) || '09:00';
  const endTime   = (params.end_time as string)   || '10:00';

  const [timeRemaining, setTimeRemaining] = useState(0);
  const [isActive, setIsActive] = useState(true);
  const [outcome, setOutcome] = useState<Outcome>('none');

  // TEMPORARY DIAGNOSTIC: pulse/glow disabled (static values below) to test
  // whether an Animated.loop still running when this screen mounts on top
  // of Today (whose own hero card has a similar looping animation) is the
  // native crash trigger. shadowOpacity is also an iOS-only style property;
  // animating it with an Animated.Value on Android may not be safe either.
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const glowAnim  = useRef(new Animated.Value(0.3)).current;

  const patchTask = useCallback(async (body: Record<string, unknown>) => {
    if (!taskId) return;
    try {
      await updateDailyTask(taskId, body, localToday());
    } catch (e) {
      console.error(e);
    }
  }, [taskId]);

  useEffect(() => {
    const endDate = parseTimeToDate(endTime);
    const diff = endDate.getTime() - Date.now();
    setTimeRemaining(Math.max(0, diff));
    setIsActive(diff > 0);
  }, [endTime]);

  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => {
      setTimeRemaining(prev => {
        const next = prev - 1000;
        if (next <= 0) { setIsActive(false); return 0; }
        return next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isActive]);

  // When the timer runs out with no explicit action taken, resolve the task
  // honestly: completed stays completed, a started-but-unfinished task becomes
  // stopped, and an untouched one becomes skipped.
  useEffect(() => {
    if (isActive || outcome !== 'none' || !taskId || !taskDate) return;
    (async () => {
      try {
        const list = await getDailyTasks(taskDate);
        const current = list.find((t: any) => t.id === taskId);
        if (!current) return;
        if (current.completed) {
          setOutcome('completed');
        } else if (current.stopped) {
          setOutcome('stopped');
        } else if (current.skipped) {
          setOutcome('skipped');
        } else if (current.started_at) {
          await patchTask({ stopped: true, stopped_at: new Date().toISOString() });
          setOutcome('stopped');
        } else {
          await patchTask({ skipped: true, auto_skipped: true });
          setOutcome('skipped');
        }
      } catch (e) {
        console.error(e);
      }
    })();
  }, [isActive, outcome, taskId, taskDate, patchTask]);

  // Loop disabled for diagnostics — see note above pulseAnim/glowAnim.

  const { hours, minutes, seconds } = formatRemaining(timeRemaining);
  const totalDuration = parseTimeToDate(endTime).getTime() - parseTimeToDate(startTime).getTime();
  const progressPct = isActive && totalDuration > 0
    ? Math.max(0, Math.min(1, timeRemaining / totalDuration))
    : 0;

  const handleClose = useCallback(() => router.back(), [router]);

  const handleComplete = useCallback(async () => {
    await patchTask({
      completed: true,
      completed_at: new Date().toISOString(),
      skipped: false,
      stopped: false,
      auto_skipped: false,
    });
    setOutcome('completed');
    setIsActive(false);
  }, [patchTask]);

  const handleStop = useCallback(async () => {
    await patchTask({ stopped: true, stopped_at: new Date().toISOString() });
    setOutcome('stopped');
    setIsActive(false);
  }, [patchTask]);

  return (
    <View style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <LinearGradient
        colors={['#0f1218', '#141a22', '#1c2029']}
        style={StyleSheet.absoluteFillObject}
      />
      <View style={[styles.content, {
        paddingTop: insets.top + SPACING.lg,
        paddingBottom: insets.bottom + SPACING.lg,
      }]}>

        <View style={styles.iconSection}>
          <View style={[styles.iconRing, {
            shadowColor: colors.accent,
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: 0.4,
            shadowRadius: 28,
            elevation: 8,
          }]}>
            <View style={[styles.iconInner, { backgroundColor: `${colors.accent}22` }]}>
              <Ionicons name={getIcon(icon)} size={54} color={colors.accent} />
            </View>
          </View>
        </View>

        <Text style={styles.taskLabel}>{label}</Text>
        <Text style={[styles.timeRange, { color: '#7080a0' }]}>
          {startTime} — {endTime}
        </Text>

        <View style={styles.timerSection}>
          {isActive ? (
            <>
              <Text style={[styles.timerLabel, { color: '#4a5a72' }]}>TIME REMAINING</Text>
              <View style={styles.timerDisplay}>
                {hours > 0 && (
                  <>
                    <View style={styles.timerBlock}>
                      <Text style={[styles.timerNum, { color: colors.accent }]}>{pad(hours)}</Text>
                      <Text style={[styles.timerUnit, { color: '#4a5a72' }]}>HR</Text>
                    </View>
                    <Text style={[styles.timerSep, { color: '#3a4a62' }]}>:</Text>
                  </>
                )}
                <View style={styles.timerBlock}>
                  <Text style={[styles.timerNum, { color: colors.accent }]}>{pad(minutes)}</Text>
                  <Text style={[styles.timerUnit, { color: '#4a5a72' }]}>MIN</Text>
                </View>
                <Text style={[styles.timerSep, { color: '#3a4a62' }]}>:</Text>
                <View style={styles.timerBlock}>
                  <Text style={[styles.timerNum, { color: colors.accent }]}>{pad(seconds)}</Text>
                  <Text style={[styles.timerUnit, { color: '#4a5a72' }]}>SEC</Text>
                </View>
              </View>
            </>
          ) : outcome === 'completed' ? (
            <View style={styles.completedWrap}>
              <Ionicons name="checkmark-circle" size={64} color={colors.done} />
              <Text style={[styles.completedText, { color: colors.done }]}>Task Complete!</Text>
            </View>
          ) : outcome === 'stopped' ? (
            <View style={styles.completedWrap}>
              <Ionicons name="pause-circle-outline" size={64} color={colors.accent} />
              <Text style={[styles.completedText, { color: colors.accent }]}>Stopped</Text>
              <Text style={[styles.outcomeSub, { color: '#7080a0' }]}>
                Attempted but not finished
              </Text>
            </View>
          ) : (
            <View style={styles.completedWrap}>
              <Ionicons name="time-outline" size={64} color="#7080a0" />
              <Text style={[styles.completedText, { color: '#a0b0c4' }]}>Time is up</Text>
              <Text style={[styles.outcomeSub, { color: '#7080a0' }]}>
                Not marked done — counted as skipped
              </Text>
            </View>
          )}
        </View>

        {isActive && (
          <View style={styles.progressWrap}>
            <View style={[styles.progressTrack, { backgroundColor: '#1a2030' }]}>
              <View style={[styles.progressFill, {
                backgroundColor: colors.accent,
                width: `${(1 - progressPct) * 100}%` as any,
              }]} />
            </View>
          </View>
        )}

        <View style={{ flex: 1 }} />

        {isActive && taskId && (
          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.actionBtn, { backgroundColor: colors.accent }]}
              onPress={handleComplete}
            >
              <Text style={styles.actionBtnText}>Complete</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.actionBtn, styles.stopBtn]}
              onPress={handleStop}
            >
              <Text style={[styles.actionBtnText, { color: '#c05a5a' }]}>Stop</Text>
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity
          style={[styles.exitBtn, { backgroundColor: '#1a2030' }]}
          onPress={handleClose}
        >
          <Text style={[styles.exitText, { color: '#5a6880' }]}>Exit Focus Mode</Text>
        </TouchableOpacity>

      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen:  { flex: 1 },
  content: { flex: 1, paddingHorizontal: SPACING.xl, alignItems: 'center' },
  iconSection: { flex: 0.5, justifyContent: 'flex-end', paddingBottom: SPACING.xl },
  iconRing: {},
  iconInner: { width: 110, height: 110, borderRadius: 55, justifyContent: 'center', alignItems: 'center' },
  taskLabel:  { fontSize: FONT.xxl, fontWeight: '700', color: '#edf2fc', textAlign: 'center', letterSpacing: -0.5, marginBottom: SPACING.sm },
  timeRange:  { fontSize: FONT.md, fontWeight: '500', marginBottom: SPACING.xxl },
  timerSection: { alignItems: 'center', marginBottom: SPACING.xl },
  timerLabel:   { fontSize: 11, fontWeight: '600', letterSpacing: 2, marginBottom: SPACING.md },
  timerDisplay: { flexDirection: 'row', alignItems: 'flex-end' },
  timerBlock:   { alignItems: 'center', minWidth: 72 },
  timerNum:     { fontSize: 52, fontWeight: '200', letterSpacing: -2 },
  timerUnit:    { fontSize: 10, fontWeight: '600', letterSpacing: 1, marginTop: -4 },
  timerSep:     { fontSize: 40, fontWeight: '200', marginHorizontal: 4, marginBottom: 14 },
  completedWrap: { alignItems: 'center', gap: SPACING.md },
  completedText: { fontSize: FONT.xl, fontWeight: '600' },
  outcomeSub:    { fontSize: FONT.sm, fontWeight: '500', marginTop: -SPACING.sm },
  progressWrap:  { width: '80%', marginBottom: SPACING.xxl },
  progressTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  progressFill:  { height: '100%', borderRadius: 2 },
  actionRow:     { flexDirection: 'row', gap: SPACING.sm, width: '100%', marginBottom: SPACING.md },
  actionBtn:     { flex: 1, alignItems: 'center', paddingVertical: SPACING.md, borderRadius: RADIUS.lg },
  actionBtnText: { fontSize: FONT.sm, fontWeight: '700', color: '#fff', letterSpacing: 1, textTransform: 'uppercase' },
  stopBtn:       { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: '#c05a5a' },
  exitBtn:  { width: '100%', alignItems: 'center', paddingVertical: SPACING.md, borderRadius: RADIUS.lg },
  exitText: { fontSize: FONT.sm, fontWeight: '500' },
});
