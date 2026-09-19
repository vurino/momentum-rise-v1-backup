import React, { useState, useCallback, useEffect, useRef } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSimpleTheme, ThemeTokens } from "../context/SimpleTheme";
import { getAnalyticsTrends } from "../db/history";

const RANGES: { key: number; label: string }[] = [
  { key: 7, label: "7 Days" },
  { key: 30, label: "30 Days" },
  { key: 90, label: "90 Days" },
];

interface Metrics {
  scheduled_count: number;
  completed_count: number;
  incomplete_count: number;
  skipped_count: number;
  missed_count: number;
  started_count: number;
  scheduled_minutes: number;
  followed_minutes: number;
  lost_minutes: number;
  follow_through_rate: number | null;
  completion_rate: number | null;
  start_rate: number | null;
  completion_after_start: number | null;
  miss_rate: number | null;
  skip_rate: number | null;
  avg_scheduled_duration: number | null;
  median_actual_duration: number | null;
}
interface Bucket { label: string; start_date: string; end_date: string; metrics: Metrics }
interface Diagnostic { key: string; text: string; metrics: Record<string, any> }
interface FollowThrough { buckets: Bucket[]; diagnostic: Diagnostic }
interface Activity extends Metrics { slot_id: string; name: string; lost_share: number }
interface LostTime { diagnostic: Diagnostic; activities: Activity[]; selected: Activity | null }
interface Period extends Metrics { key: string; label: string }
interface TimeOfDay { diagnostic: Diagnostic; periods: Period[] | null; current_period: string | null }
interface RecAction { type: string; slot_id: string | null; label: string }
interface Recommendation { title: string; reason: string; experiment: string; success_measure: string; action: RecAction | null }
interface TrendsPayload { range: number; follow_through: FollowThrough; lost_time: LostTime; time_of_day: TimeOfDay; recommendation: Recommendation }

function localNowISO(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtMin(min: number): string {
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = Math.round(min % 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(min)}m`;
}

function DiagnosticBanner({ diagnostic, T }: { diagnostic: Diagnostic; T: ThemeTokens }) {
  return (
    <View style={[c.diagBanner, { backgroundColor: T.bg, borderColor: T.border }]}>
      <Text style={[c.diagText, { color: T.t1, opacity: 0.75 }]}>{diagnostic.text}</Text>
    </View>
  );
}

function FollowThroughChart({ buckets, T }: { buckets: Bucket[]; T: ThemeTokens }) {
  const CHART_H = 90;
  const maxScheduled = Math.max(1, ...buckets.map(b => b.metrics.scheduled_minutes));
  const scrollRef = useRef<ScrollView>(null);

  // Switching the 7/30/90-day range swaps in a differently-sized buckets
  // array, but the ScrollView keeps whatever horizontal offset it was
  // already at — on a shorter new range that offset can land past the end
  // of the new content, leaving the chart showing blank space until the
  // user manually swipes back. Snapping to the start whenever the bucket
  // set changes avoids that.
  useEffect(() => {
    scrollRef.current?.scrollTo({ x: 0, animated: false });
  }, [buckets]);

  if (!buckets.some(b => b.metrics.scheduled_count > 0)) return null;

  return (
    <ScrollView ref={scrollRef} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={c.chartRow}>
      {buckets.map((b, i) => {
        const trackH = b.metrics.scheduled_minutes > 0
          ? Math.max(6, Math.round((b.metrics.scheduled_minutes / maxScheduled) * CHART_H))
          : 0;
        const fillPct = b.metrics.scheduled_minutes > 0
          ? Math.min(100, Math.round((b.metrics.followed_minutes / b.metrics.scheduled_minutes) * 100))
          : 0;
        return (
          <View key={i} style={c.chartCol}>
            <View style={[c.chartTrackWrap, { height: CHART_H }]}>
              {trackH > 0 ? (
                <View style={[c.chartTrack, { height: trackH, backgroundColor: T.border }]}>
                  <View style={[c.chartFill, { height: `${fillPct}%` as any, backgroundColor: T.orange }]} />
                </View>
              ) : (
                <View style={[c.chartTrackEmpty, { backgroundColor: T.t4 }]} />
              )}
            </View>
            <Text style={[c.chartColLabel, { color: T.t1, opacity: 0.6 }]} numberOfLines={1}>{b.label}</Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

function ActivityRow({ activity, maxLost, onPress, T }: { activity: Activity; maxLost: number; onPress: () => void; T: ThemeTokens }) {
  const pct = maxLost > 0 ? Math.round((activity.lost_minutes / maxLost) * 100) : 0;
  return (
    <TouchableOpacity style={[c.actRow, { borderColor: T.border }]} onPress={onPress} activeOpacity={0.7}>
      <View style={c.actTop}>
        <Text style={[c.actName, { color: T.t1, opacity: 0.75 }]} numberOfLines={1}>{activity.name}</Text>
        <Text style={[c.actShare, { color: T.orangeHi }]}>{activity.lost_share}% of lost time</Text>
      </View>
      <View style={[c.actBarTrack, { backgroundColor: T.border }]}>
        <View style={[c.actBarFill, { width: `${pct}%` as any, backgroundColor: T.danger }]} />
      </View>
      <Text style={[c.actMeta, { color: T.t1, opacity: 0.6 }]}>
        {fmtMin(activity.lost_minutes)} lost · {activity.follow_through_rate ?? "—"}% follow-through · {activity.scheduled_count} occurrences
      </Text>
    </TouchableOpacity>
  );
}

function PeriodChart({ periods, currentKey, T }: { periods: Period[]; currentKey: string | null; T: ThemeTokens }) {
  const CHART_H = 80;
  return (
    <View style={c.periodRow}>
      {periods.map((p) => {
        const rate = p.follow_through_rate ?? 0;
        const h = p.scheduled_count > 0 ? Math.max(6, Math.round((rate / 100) * CHART_H)) : 0;
        const isCurrent = p.key === currentKey;
        return (
          <View key={p.key} style={c.periodCol}>
            <View style={[c.periodTrackWrap, { height: CHART_H }]}>
              {h > 0 ? (
                <View style={[c.periodBar, { height: h, backgroundColor: isCurrent ? T.orangeHi : T.orange }]} />
              ) : (
                <View style={[c.chartTrackEmpty, { backgroundColor: T.t4 }]} />
              )}
            </View>
            <Text style={[c.periodPct, { color: T.t2 }]}>{p.scheduled_count > 0 ? `${p.follow_through_rate}%` : "—"}</Text>
            <Text style={[c.periodLabel, isCurrent ? { color: T.orangeHi } : { color: T.t1, opacity: 0.6 }]} numberOfLines={1}>
              {p.label}{isCurrent ? " •" : ""}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export default function HistoryTrends() {
  const { T } = useSimpleTheme();
  const router = useRouter();
  const [range, setRange] = useState(7);
  const [data, setData] = useState<TrendsPayload | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchTrends = useCallback(async (r: number) => {
    setLoading(true);
    try {
      const tzOffset = new Date().getTimezoneOffset();
      const json = await getAnalyticsTrends(r, localNowISO(), tzOffset);
      setData(json as unknown as TrendsPayload);
    } catch (e) {
      console.error(e);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTrends(range); }, [range, fetchTrends]);

  const handleAction = (action: RecAction) => {
    if (action.slot_id) {
      router.push({ pathname: "/routine", params: { editSlotId: action.slot_id } });
    } else {
      router.push({ pathname: "/routine" });
    }
  };

  if (loading && !data) {
    return (
      <View style={c.centered}>
        <ActivityIndicator color={T.orange} />
      </View>
    );
  }
  if (!data) {
    return (
      <View style={c.centered}>
        <Text style={{ color: T.t2, fontFamily: "Montserrat_500Medium" }}>Couldn't load trends.</Text>
      </View>
    );
  }

  const { follow_through, lost_time, time_of_day, recommendation } = data;
  const maxLost = Math.max(1, ...lost_time.activities.map(a => a.lost_minutes));

  return (
    <View>
      {/* Range selector */}
      <View style={c.rangeRow}>
        {RANGES.map(r => {
          const active = range === r.key;
          return (
            <TouchableOpacity
              key={r.key}
              style={[c.rangeBtn, { borderColor: T.border }, active && { backgroundColor: T.orange, borderColor: T.orange }]}
              onPress={() => setRange(r.key)}
            >
              <Text style={[c.rangeBtnText, { color: active ? "#fff" : T.t2 }]}>{r.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {loading && (
        <View style={{ paddingVertical: 8 }}>
          <ActivityIndicator color={T.orange} />
        </View>
      )}

      {/* 1. Follow-Through — diagnostic only */}
      <View style={[c.card, { backgroundColor: T.surface, borderColor: T.border }]}>
        <Text style={[c.cardTitle, { color: T.t1 }]}>Follow-Through</Text>
        <Text style={[c.cardSub, { color: T.t3 }]}>Scheduled time vs. followed-through time</Text>

        <FollowThroughChart buckets={follow_through.buckets} T={T} />
        <DiagnosticBanner diagnostic={follow_through.diagnostic} T={T} />
      </View>

      {/* 2. Lost Time by Activity — diagnostic only */}
      <View style={[c.card, { backgroundColor: T.surface, borderColor: T.border }]}>
        <Text style={[c.cardTitle, { color: T.t1 }]}>Lost Time by Activity</Text>
        <Text style={[c.cardSub, { color: T.t3 }]}>Which activities account for the most unfinished scheduled time</Text>

        {lost_time.activities.slice(0, 6).map(a => (
          <ActivityRow
            key={a.slot_id}
            activity={a}
            maxLost={maxLost}
            onPress={() => router.push({ pathname: "/routine", params: { editSlotId: a.slot_id } })}
            T={T}
          />
        ))}
        <DiagnosticBanner diagnostic={lost_time.diagnostic} T={T} />
      </View>

      {/* 3. Performance by Time of Day — diagnostic only, no suggestion here */}
      <View style={[c.card, { backgroundColor: T.surface, borderColor: T.border }]}>
        <Text style={[c.cardTitle, { color: T.t1 }]}>Performance by Time of Day</Text>
        <Text style={[c.cardSub, { color: T.t3 }]}>
          {lost_time.selected ? `When ${lost_time.selected.name} performs best` : "Follow-through by time of day"}
        </Text>

        {time_of_day.periods && (
          <PeriodChart periods={time_of_day.periods} currentKey={time_of_day.current_period} T={T} />
        )}
        <DiagnosticBanner diagnostic={time_of_day.diagnostic} T={T} />
      </View>

      {/* 4. Final combined recommendation */}
      <View style={[c.card, c.recCardOuter, { backgroundColor: T.surface, borderColor: T.orange }]}>
        <View style={c.recHeader}>
          <Text style={[c.recEyebrow, { color: T.orange }]}>Suggested next step</Text>
          <View style={[c.recRangeBadge, { borderColor: T.orange }]}>
            <Text style={[c.recRangeBadgeText, { color: T.orange }]}>{RANGES.find(r => r.key === range)?.label}</Text>
          </View>
        </View>
        <Text style={[c.recReason, { color: T.t2 }]}>{recommendation.reason}</Text>
        <Text style={[c.recExperiment, { color: T.t1, opacity: 0.75 }]}>{recommendation.experiment}</Text>

        {recommendation.action && (
          <TouchableOpacity style={[c.actionBtn, { backgroundColor: T.orange }]} onPress={() => handleAction(recommendation.action!)}>
            <Text style={c.actionBtnText}>{recommendation.action.label}</Text>
          </TouchableOpacity>
        )}
      </View>

      <TouchableOpacity
        style={[c.reviewRoutineBtn, { borderColor: T.border }]}
        onPress={() => router.push({ pathname: "/routine" })}
      >
        <Text style={[c.reviewRoutineText, { color: T.t2 }]}>Review Routine</Text>
      </TouchableOpacity>

      <View style={c.disclaimerRow}>
        <Ionicons name="information-circle-outline" size={13} color={T.t3} style={c.disclaimerIcon} />
        <Text style={[c.disclaimerText, { color: T.t3 }]}>
          Diagnostics and recommendations are for guidance only. They may not always be accurate. Review the data and interpret the results accordingly.
        </Text>
      </View>
    </View>
  );
}

const c = StyleSheet.create({
  centered: { paddingVertical: 60, alignItems: "center", justifyContent: "center" },

  rangeRow: { flexDirection: "row", gap: 8, marginBottom: 28 },
  rangeBtn: { flex: 1, borderWidth: 1, borderRadius: 99, paddingVertical: 9, alignItems: "center" },
  rangeBtnText: { fontFamily: "Montserrat_600SemiBold", fontSize: 12 },

  card: { borderWidth: 1, borderRadius: 16, padding: 16, marginBottom: 28 },
  cardTitle: { fontFamily: "Montserrat_700Bold", fontSize: 15 },
  cardSub: { fontFamily: "Montserrat_500Medium", fontSize: 11, marginTop: 3, marginBottom: 14 },

  chartRow: { flexDirection: "row", alignItems: "flex-end", gap: 10, paddingBottom: 4, paddingRight: 4 },
  chartCol: { alignItems: "center", width: 34 },
  chartTrackWrap: { justifyContent: "flex-end", alignItems: "center", width: "100%" },
  chartTrack: { width: 14, borderRadius: 5, overflow: "hidden", justifyContent: "flex-end" },
  chartFill: { width: "100%", borderRadius: 5 },
  chartTrackEmpty: { width: 14, height: 3, borderRadius: 2, marginBottom: 0 },
  chartColLabel: { fontFamily: "Montserrat_500Medium", fontSize: 9, marginTop: 6 },

  diagBanner: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 14 },
  diagText: { fontFamily: "Montserrat_600SemiBold", fontSize: 12, lineHeight: 17 },

  actRow: { borderBottomWidth: 1, paddingVertical: 12 },
  actTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  actName: { fontFamily: "Montserrat_600SemiBold", fontSize: 13, flex: 1 },
  actShare: { fontFamily: "Montserrat_700Bold", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.4 },
  actBarTrack: { height: 6, borderRadius: 3, overflow: "hidden", marginTop: 8 },
  actBarFill: { height: "100%", borderRadius: 3 },
  actMeta: { fontFamily: "Montserrat_500Medium", fontSize: 10, marginTop: 6 },

  periodRow: { flexDirection: "row", justifyContent: "space-between" },
  periodCol: { alignItems: "center", flex: 1 },
  periodTrackWrap: { justifyContent: "flex-end", alignItems: "center", width: "100%" },
  periodBar: { width: 18, borderRadius: 5 },
  periodPct: { fontFamily: "Montserrat_700Bold", fontSize: 11, marginTop: 6 },
  periodLabel: { fontFamily: "Montserrat_500Medium", fontSize: 9, marginTop: 2, textAlign: "center" },

  recCardOuter: { borderWidth: 1.5 },
  recHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  recEyebrow: { fontFamily: "Montserrat_700Bold", fontSize: 10, textTransform: "uppercase", letterSpacing: 1.5 },
  recRangeBadge: { borderWidth: 1, borderRadius: 99, paddingVertical: 3, paddingHorizontal: 9 },
  recRangeBadgeText: { fontFamily: "Montserrat_700Bold", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5 },
  recReason: { fontFamily: "Montserrat_500Medium", fontSize: 12, lineHeight: 17, marginTop: 10 },
  recExperiment: { fontFamily: "Montserrat_700Bold", fontSize: 14, lineHeight: 20, marginTop: 6 },

  disclaimerRow: { flexDirection: "row", gap: 6, paddingHorizontal: 4, marginTop: 20 },
  disclaimerIcon: { marginTop: 1 },
  disclaimerText: { flex: 1, fontFamily: "Montserrat_500Medium", fontSize: 10, lineHeight: 15 },

  reviewRoutineBtn: { borderWidth: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center", marginTop: 4 },
  reviewRoutineText: { fontFamily: "Montserrat_700Bold", fontSize: 12, textTransform: "uppercase", letterSpacing: 1 },
  actionBtn: { marginTop: 16, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  actionBtnText: { fontFamily: "Montserrat_700Bold", fontSize: 12, color: "#fff", textTransform: "uppercase", letterSpacing: 0.5 },
});
