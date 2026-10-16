import { PlatformError } from "../../../platform/public";
import type { FlowIssueRow } from "../../issues/public";

const DAY = 86400;
type Granularity = "day" | "week";
type Distribution = { count: number; avg: number | null; p50: number | null; p90: number | null };
export type FlowMetricsInput = {
  projectId: string;
  since?: number;
  until?: number;
  granularity?: Granularity;
};
export type FlowMetricsData = {
  loaded: readonly FlowIssueRow[];
  comments: Readonly<Record<string, number>>;
  leaseSeconds: Readonly<Record<string, number>>;
  bugTypeTracked: boolean;
  doneBeforeWindow: number;
  factoryHealth: {
    leaseExpiries: number;
    abandonedClaims: number;
    gateRejections: number;
    wipCapPressure: number;
  };
};
function monday(t: number): number {
  const day = Math.floor(t / DAY);
  return (day - (((day % 7) + 7 - 4) % 7)) * DAY;
}
export function flowMetricsDefaultStarts(now: number) {
  return { bucketSince: monday(now) - 35 * DAY, wipSince: now - 30 * DAY };
}
function invalid(message: string): never {
  throw new PlatformError("validation", message);
}
export function validateFlowMetrics(
  input: FlowMetricsInput,
  now: number,
): Required<FlowMetricsInput> & { wipSince: number; bucketSince: number } {
  if (!input.projectId || typeof input.projectId !== "string") invalid("Invalid projectId");
  const granularity = input.granularity ?? "week";
  if (granularity !== "day" && granularity !== "week") invalid("Invalid granularity");
  for (const n of [input.since, input.until])
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 0)) invalid("Invalid time bound");
  const defaults = flowMetricsDefaultStarts(now);
  const effectiveSince = input.since ?? Math.min(defaults.bucketSince, defaults.wipSince);
  const effectiveUntil = input.until ?? now;
  if (input.since !== undefined && effectiveUntil < effectiveSince)
    invalid("until must be >= since");
  if (
    (input.since !== undefined || input.until !== undefined) &&
    effectiveUntil - effectiveSince > (granularity === "day" ? 366 : 5 * 365) * DAY
  )
    invalid(
      granularity === "day"
        ? 'Window too large for granularity "day": max 366 days'
        : 'Window too large for granularity "week": max 5 years',
    );
  return {
    projectId: input.projectId,
    since: input.since ?? defaults.bucketSince,
    until: effectiveUntil,
    granularity,
    wipSince: input.since ?? defaults.wipSince,
    bucketSince: input.since ?? defaults.bucketSince,
  };
}
function label(t: number) {
  return new Date(t * 1000).toISOString().slice(0, 10);
}
function summarize(values: readonly number[]): Distribution {
  if (!values.length) return { count: 0, avg: null, p50: null, p90: null };
  const ordered = [...values].sort((a, b) => a - b);
  return {
    count: ordered.length,
    avg: ordered.reduce((a, b) => a + b, 0) / ordered.length,
    p50: ordered[Math.floor(0.5 * ordered.length)],
    p90: ordered[Math.floor(0.9 * ordered.length)],
  };
}
function buckets(since: number, until: number, granularity: Granularity) {
  const size = granularity === "day" ? DAY : 7 * DAY;
  const first = granularity === "day" ? since - (since % DAY) : monday(since);
  const result: { at: number; from: number; to: number }[] = [];
  for (let at = first; at <= until; at += size)
    result.push({ at, from: Math.max(at, since), to: Math.min(at + size, until + 1) });
  return result;
}
function band(issue: FlowIssueRow, t: number) {
  if (issue.createdAt > t) return null;
  if (issue.doneAt !== null && issue.doneAt <= t) return "done";
  if (issue.inReviewAt !== null && issue.inReviewAt <= t) return "inReview";
  if (issue.claimedAt !== null && issue.claimedAt <= t) return "inProgress";
  return "backlogTodo";
}
export function computeFlowMetrics(input: FlowMetricsInput, data: FlowMetricsData, now: number) {
  const options = validateFlowMetrics(input, now);
  const since = input.since,
    until = input.until;
  const inWindow = (t: number) =>
    (since === undefined || t >= since) && (until === undefined || t <= until);
  const createdUntil = until ?? now;
  const doneBefore = since === undefined ? null : since - (since % DAY);
  const issues = data.loaded.filter(
    (i) =>
      i.createdAt <= createdUntil &&
      (doneBefore === null || i.doneAt === null || i.doneAt >= doneBefore),
  );
  const completed = issues.filter((i) => i.doneAt !== null && inWindow(i.doneAt));
  const lead = completed
    .filter((i) => i.readyAt !== null)
    .map((i) => (i.doneAt ?? 0) - (i.readyAt ?? 0));
  const cycle = completed
    .filter((i) => i.claimedAt !== null)
    .map((i) => (i.doneAt ?? 0) - (i.claimedAt ?? 0));
  const review = completed
    .filter((i) => i.inReviewAt !== null)
    .map((i) => (i.doneAt ?? 0) - (i.inReviewAt ?? 0));
  const progress = completed
    .filter((i) => i.claimedAt !== null)
    .map((i) => (i.inReviewAt ?? i.doneAt ?? 0) - (i.claimedAt ?? 0));
  const held = (i: FlowIssueRow) => data.leaseSeconds[i.id] ?? 0;
  const ratio = (n: number, d: number) => (d <= 0 ? 0 : Math.min(1, n / d));
  const spans = buckets(options.bucketSince, options.until, options.granularity);
  const throughputOverTime = [];
  const bugShareOverTime = [];
  const reviewLatencyOverTime = [];
  const arrivalVsCompletionOverTime = [];
  const cfdOverTime = [];
  for (const b of spans) {
    const done = issues.filter((i) => i.doneAt !== null && i.doneAt >= b.from && i.doneAt < b.to);
    const created = issues.filter((i) => i.createdAt >= b.from && i.createdAt < b.to).length;
    const bugCount = done.filter((i) => i.typeKey === "bug").length;
    const bucketStart = label(b.at);
    throughputOverTime.push({ bucketStart, count: done.length });
    bugShareOverTime.push({
      bucketStart,
      total: done.length,
      bugCount,
      bugSharePercent: done.length ? bugCount / done.length : null,
    });
    reviewLatencyOverTime.push({
      bucketStart,
      p50: summarize(
        done.filter((i) => i.inReviewAt !== null).map((i) => (i.doneAt ?? 0) - (i.inReviewAt ?? 0)),
      ).p50,
    });
    arrivalVsCompletionOverTime.push({
      bucketStart,
      created,
      completed: done.length,
      net: created - done.length,
    });
    const bands = { backlogTodo: 0, inProgress: 0, inReview: 0, done: data.doneBeforeWindow };
    const sampleAt = Math.min(b.to - 1, now);
    for (const i of issues) {
      const current = band(i, sampleAt);
      if (current) bands[current]++;
    }
    cfdOverTime.push({ bucketStart, ...bands });
  }
  const wipOverTime = [];
  for (let t = options.wipSince - (options.wipSince % DAY); t <= options.until; t += DAY)
    wipOverTime.push({
      date: label(t),
      count: issues.filter(
        (i) => i.claimedAt !== null && i.claimedAt <= t && (i.doneAt === null || i.doneAt > t),
      ).length,
    });
  return {
    leadTime: summarize(lead),
    leadTimeExcluded: completed.filter((i) => i.readyAt === null).length,
    cycleTime: summarize(cycle),
    wipOverTime,
    throughputOverTime,
    bugShareOverTime,
    bugTypeTracked: data.bugTypeTracked,
    reviewLatency: summarize(review),
    reviewLatencyOverTime,
    humanInterventions: summarize(
      completed.map((i) => (data.comments[i.id] ?? 0) + i.reviewBounceCount),
    ),
    autonomyRatio: summarize(
      completed
        .filter((i) => i.claimedAt !== null)
        .map((i) => ratio(held(i), (i.doneAt ?? 0) - (i.claimedAt ?? 0))),
    ),
    cfdOverTime,
    timeInProgress: summarize(progress),
    arrivalVsCompletionOverTime,
    flowEfficiency: summarize(
      completed
        .filter((i) => i.readyAt !== null)
        .map((i) => ratio(held(i), (i.doneAt ?? 0) - (i.readyAt ?? 0))),
    ),
    agingWip: data.loaded
      .filter(
        (i) => i.claimedAt !== null && (i.status === "in_progress" || i.status === "in_review"),
      )
      .map((i) => ({
        id: i.id,
        status: i.status as "in_progress" | "in_review",
        ageSeconds: now - (i.claimedAt ?? now),
      })),
    factoryHealth: data.factoryHealth,
  };
}
export type FlowMetrics = ReturnType<typeof computeFlowMetrics>;
