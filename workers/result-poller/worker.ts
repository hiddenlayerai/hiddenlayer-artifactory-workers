import type { PlatformContext } from "jfrog-workers";
import { ScheduledEventRequest, ScheduledEventResponse } from "./types";

declare function btoa(data: string): string;

// --- Configuration ---
// All tunable settings. Secrets (HL_CLIENT_ID, HL_CLIENT_SECRET) and the cron
// schedule live in manifest.json.
// Exported for test overrides; treat as immutable in production.

export const config = {
  monitoredRepositories: [] as string[],
  hlApiBaseUrl: "https://api.hiddenlayer.ai",
  hlAuthBaseUrl: "https://auth.hiddenlayer.ai",
  concurrencyLimit: 25,
  remainingTimeReserveMs: 10_000,
  perCallWaitBoundMs: 2_000,
  stalenessThresholdMs: 30 * 60 * 1_000,
  retryCap: 5,
  signedUrlTtlSecs: 4 * 60 * 60,
};

// --- End Configuration ---

interface AqlPropertyEntry {
  key: string;
  value: string;
}

interface AqlResultRow {
  repo: string;
  path: string;
  name: string;
  created: string;
  properties: AqlPropertyEntry[];
}

interface WorkItem {
  repo: string;
  path: string;
  name: string;
  created: string;
  scanId: string | undefined;
  retryCount: number;
  nextRetryAt: string | undefined;
  scanRequestedAt: string | undefined;
  modelName: string | undefined;
  source: "pending" | "failed";
}

interface RunCounters {
  discoveredUnresolved: number;
  discoveredRetryCandidates: number;
  resolvedSafe: number;
  resolvedUnsafe: number;
  markedFailed: number;
  reTriggered: number;
  guardSkipped: number;
  unprocessed: number;
  errored: number;
}

interface ScanReport {
  status?: string;
  summary?: {
    detection_count?: number;
    files_failed_to_scan?: number;
    unknown_files?: number;
    highest_severity?: string;
    detection_categories?: string[];
  };
}

type VerdictResult =
  | { outcome: "SAFE" | "UNSAFE"; severity?: string; categories?: string[] }
  | { outcome: "FAILED" }
  | { outcome: "skip" };

function readAqlProperty(properties: AqlPropertyEntry[], key: string): string | undefined {
  const matches = properties.filter((p) => p.key === key);
  if (matches.length !== 1) return undefined;
  return matches[0].value;
}

function buildAqlQuery(status: string, repos: string[]): string {
  const repoFilter = repos.map((r) => `{"repo": "${r}"}`).join(", ");
  return [
    `items.find({`,
    `  "type": "file",`,
    `  "@hiddenlayer.status": "${status}",`,
    `  "$or": [${repoFilter}]`,
    `}).include("repo", "path", "name", "created", "property.*")`,
  ].join("\n");
}

function artifactKey(item: { repo: string; path: string; name: string }): string {
  return `${item.repo}/${item.path}/${item.name}`;
}

function artifactPath(item: { repo: string; path: string; name: string }): string {
  if (item.path === ".") return `${item.repo}/${item.name}`;
  return `${item.repo}/${item.path}/${item.name}`;
}

function parseWorkItem(row: AqlResultRow, source: "pending" | "failed"): WorkItem {
  const props = row.properties || [];
  const retryRaw = readAqlProperty(props, "hiddenlayer.retry_count");
  let retryCount = 0;
  if (retryRaw !== undefined) {
    const parsed = parseInt(retryRaw, 10);
    if (!isNaN(parsed) && parsed >= 0) retryCount = parsed;
  }

  return {
    repo: row.repo,
    path: row.path,
    name: row.name,
    created: row.created,
    scanId: readAqlProperty(props, "hiddenlayer.scan_id"),
    retryCount,
    nextRetryAt: readAqlProperty(props, "hiddenlayer.next_retry_at"),
    scanRequestedAt: readAqlProperty(props, "hiddenlayer.scan_requested_at"),
    modelName: readAqlProperty(props, "hiddenlayer.model_name"),
    source,
  };
}

function determineVerdict(report: ScanReport): VerdictResult {
  if (report.status === "failed" || report.status === "canceled") {
    return { outcome: "FAILED" };
  }

  if (report.status !== "done") return { outcome: "skip" };

  const summary = report.summary;
  const detectionCount = summary?.detection_count;

  if (detectionCount !== undefined && detectionCount > 0) {
    return {
      outcome: "UNSAFE",
      severity: summary?.highest_severity,
      categories: summary?.detection_categories,
    };
  }

  if (
    detectionCount !== undefined &&
    detectionCount === 0 &&
    (summary?.files_failed_to_scan === undefined || summary.files_failed_to_scan === 0) &&
    (summary?.unknown_files === undefined || summary.unknown_files === 0)
  ) {
    return {
      outcome: "SAFE",
      severity: summary?.highest_severity,
      categories: summary?.detection_categories,
    };
  }

  return { outcome: "FAILED" };
}

async function checkOverwriteGuard(context: PlatformContext, item: WorkItem, expectedScanId: string): Promise<boolean> {
  try {
    const response = await boundedPlatformCall(
      context.clients.platformHttp.get(`/artifactory/api/storage/${artifactPath(item)}?properties=hiddenlayer.scan_id`),
    );
    const values = response.data?.properties?.["hiddenlayer.scan_id"] as unknown;
    if (!Array.isArray(values) || values.length !== 1) return false;
    return values[0] === expectedScanId;
  } catch (err) {
    console.log(`Overwrite guard skip for ${artifactKey(item)}:`, err);
    return false;
  }
}

async function writeProperties(context: PlatformContext, item: WorkItem, props: Record<string, string>): Promise<void> {
  await boundedPlatformCall(
    context.clients.platformHttp.patch(
      `/artifactory/api/metadata/${artifactPath(item)}?atomicProperties=1&recursiveProperties=0`,
      { props },
      { "Content-Type": "application/json" },
    ),
  );
}

async function markFailed(context: PlatformContext, item: WorkItem): Promise<void> {
  const props: Record<string, string> = {
    "hiddenlayer.status": "FAILED",
  };
  if (item.retryCount < config.retryCap) {
    const backoffMs = Math.pow(2, item.retryCount + 1) * 60 * 1000;
    const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
    props["hiddenlayer.next_retry_at"] = nextRetryAt;
  }
  await writeProperties(context, item, props);
}

async function boundedPlatformCall<T>(call: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("JFrog call timed out")), config.perCallWaitBoundMs);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function processPool<T>(
  items: T[],
  limit: number,
  shouldAdmit: () => boolean,
  processor: (item: T) => Promise<void>,
): Promise<void> {
  const executing: Set<Promise<void>> = new Set();

  for (const item of items) {
    if (!shouldAdmit()) {
      break;
    }

    const p = processor(item).finally(() => {
      executing.delete(p);
    });
    executing.add(p);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
}

function deriveModelName(item: WorkItem): string {
  if (item.path === ".") return `jfrog:${item.repo}:${item.name}`;
  return `jfrog:${item.repo}/${item.path}:${item.name}`;
}

async function mintSignedUrl(context: PlatformContext, item: WorkItem): Promise<string> {
  const response = await boundedPlatformCall(
    context.clients.platformHttp.post("/artifactory/api/signed/url", {
      repo_path: artifactPath(item),
      valid_for_secs: config.signedUrlTtlSecs,
    }),
  );
  return response.data as string;
}

async function submitScan(
  context: PlatformContext,
  token: string,
  signedUrl: string,
  modelName: string,
): Promise<string> {
  const response = await context.clients.axios.post(
    `${config.hlApiBaseUrl}/scan/v3/jobs`,
    {
      access: { source: "AWS_PRESIGNED" },
      inventory: {
        model_name: modelName,
        model_version: "",
        requesting_entity: "hiddenlayer-jfrog-worker",
        request_source: "Integration",
        origin: "JFrog Artifactory",
        scan_target: { deep_scan: { file_location: signedUrl } },
      },
    },
    {
      headers: { Authorization: `Bearer ${token}` },
      timeout: config.perCallWaitBoundMs,
    },
  );
  return response.data.scan_id;
}

function formatMessage(counters: RunCounters): string {
  const parts: string[] = [];
  parts.push(
    `Discovered ${counters.discoveredUnresolved} unresolved, ${counters.discoveredRetryCandidates} retry candidates.`,
  );

  if (counters.resolvedSafe > 0) {
    parts.push(`Resolved SAFE: ${counters.resolvedSafe}.`);
  }
  if (counters.resolvedUnsafe > 0) {
    parts.push(`Resolved UNSAFE: ${counters.resolvedUnsafe}.`);
  }
  if (counters.markedFailed > 0) {
    parts.push(`Marked FAILED: ${counters.markedFailed}.`);
  }
  if (counters.reTriggered > 0) {
    parts.push(`Re-triggered: ${counters.reTriggered}.`);
  }
  if (counters.guardSkipped > 0) {
    parts.push(`Guard-skipped: ${counters.guardSkipped}.`);
  }
  parts.push(`Unprocessed: ${counters.unprocessed}.`);
  if (counters.errored > 0) {
    parts.push(`Errored: ${counters.errored}.`);
  }

  return parts.join(" ");
}

export default async (context: PlatformContext, _data: ScheduledEventRequest): Promise<ScheduledEventResponse> => {
  try {
    const clientId = context.secrets.get("HL_CLIENT_ID");
    const clientSecret = context.secrets.get("HL_CLIENT_SECRET");

    let token: string;
    try {
      const credentials = btoa(`${clientId}:${clientSecret}`);
      const response = await context.clients.axios.post(
        `${config.hlAuthBaseUrl}/oauth2/token`,
        "grant_type=client_credentials",
        {
          headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          timeout: config.perCallWaitBoundMs,
        },
      );
      token = response.data.access_token;
    } catch (err) {
      console.error("Token exchange failed:", err);
      return { message: "Token exchange failed." };
    }

    let pendingRows: AqlResultRow[];
    let failedRows: AqlResultRow[];
    try {
      const pendingResponse = await boundedPlatformCall(
        context.clients.platformHttp.post(
          "/artifactory/api/search/aql",
          buildAqlQuery("PENDING", config.monitoredRepositories),
          { "Content-Type": "text/plain" },
        ),
      );
      pendingRows = pendingResponse.data.results;

      const failedResponse = await boundedPlatformCall(
        context.clients.platformHttp.post(
          "/artifactory/api/search/aql",
          buildAqlQuery("FAILED", config.monitoredRepositories),
          { "Content-Type": "text/plain" },
        ),
      );
      failedRows = failedResponse.data.results;
    } catch (err) {
      console.error("Discovery failed:", err);
      return { message: "Discovery failed." };
    }

    const seen = new Map<string, WorkItem>();
    for (const row of pendingRows) {
      const key = artifactKey(row);
      if (!seen.has(key)) {
        seen.set(key, parseWorkItem(row, "pending"));
      }
    }
    for (const row of failedRows) {
      const key = artifactKey(row);
      if (!seen.has(key)) {
        seen.set(key, parseWorkItem(row, "failed"));
      }
    }

    const workList = Array.from(seen.values());
    if (workList.length === 0) {
      return { message: "No work found." };
    }

    workList.sort((a, b) => new Date(a.created).getTime() - new Date(b.created).getTime());

    const counters: RunCounters = {
      discoveredUnresolved: workList.filter((w) => w.source === "pending").length,
      discoveredRetryCandidates: workList.filter((w) => w.source === "failed").length,
      resolvedSafe: 0,
      resolvedUnsafe: 0,
      markedFailed: 0,
      reTriggered: 0,
      guardSkipped: 0,
      unprocessed: workList.length,
      errored: 0,
    };

    const resolutionCandidates = workList.filter((w) => w.source === "pending" && w.scanId !== undefined);

    await processPool(
      resolutionCandidates,
      config.concurrencyLimit,
      () => context.getRemainingExecutionTime() >= config.remainingTimeReserveMs,
      async (item) => {
        try {
          const reportResponse = await context.clients.axios.get(
            `${config.hlApiBaseUrl}/scan/v3/results/${item.scanId}?has_detections=true`,
            {
              headers: { Authorization: `Bearer ${token}` },
              timeout: config.perCallWaitBoundMs,
            },
          );
          const report: ScanReport = reportResponse.data;
          const verdict = determineVerdict(report);

          if (verdict.outcome === "skip") {
            console.log(`Skipping ${artifactKey(item)}: status=${report.status ?? "unknown"}`);
            counters.unprocessed--;
            return;
          }

          if (!(await checkOverwriteGuard(context, item, item.scanId as string))) {
            counters.guardSkipped++;
            counters.unprocessed--;
            return;
          }

          if (verdict.outcome === "SAFE" || verdict.outcome === "UNSAFE") {
            const props: Record<string, string> = {
              "hiddenlayer.status": verdict.outcome,
            };
            if (verdict.severity !== undefined) {
              props["hiddenlayer.severity"] = verdict.severity;
            }
            if (verdict.categories && verdict.categories.length > 0) {
              props["hiddenlayer.detection_categories"] = verdict.categories.join(",");
            }
            await writeProperties(context, item, props);

            if (verdict.outcome === "SAFE") {
              counters.resolvedSafe++;
            } else {
              counters.resolvedUnsafe++;
            }
          } else {
            await markFailed(context, item);
            counters.markedFailed++;
          }

          counters.unprocessed--;
        } catch (err: unknown) {
          const axiosStatus =
            typeof err === "object" &&
            err !== null &&
            "response" in err &&
            typeof (err as { response?: { status?: number } }).response?.status === "number"
              ? (err as { response: { status: number } }).response.status
              : undefined;

          if (axiosStatus === 404) {
            if (await checkOverwriteGuard(context, item, item.scanId as string)) {
              await markFailed(context, item);
              counters.markedFailed++;
            } else {
              counters.guardSkipped++;
            }
            counters.unprocessed--;
            return;
          }

          console.error(`Error processing ${artifactKey(item)}:`, err);
          counters.errored++;
          counters.unprocessed--;
        }
      },
    );

    const now = Date.now();

    const retriggerCandidates = workList.filter((w) => {
      if (w.source === "failed") {
        if (w.retryCount >= config.retryCap) return false;
        if (w.nextRetryAt !== undefined) {
          const retryAt = new Date(w.nextRetryAt).getTime();
          if (!isNaN(retryAt) && retryAt > now) return false;
        }
        return true;
      }

      if (w.source === "pending" && w.scanId === undefined) {
        if (w.scanRequestedAt !== undefined) {
          const requestedAt = new Date(w.scanRequestedAt).getTime();
          if (!isNaN(requestedAt) && now - requestedAt < config.stalenessThresholdMs) {
            return false;
          }
        }
        return true;
      }

      return false;
    });

    counters.unprocessed -= workList.length - resolutionCandidates.length - retriggerCandidates.length;

    await processPool(
      retriggerCandidates,
      config.concurrencyLimit,
      () => context.getRemainingExecutionTime() >= config.remainingTimeReserveMs,
      async (item) => {
        try {
          if (item.source === "pending" && item.retryCount >= config.retryCap) {
            await writeProperties(context, item, {
              "hiddenlayer.status": "FAILED",
            });
            counters.markedFailed++;
            counters.unprocessed--;
            return;
          }

          await writeProperties(context, item, {
            "hiddenlayer.retry_count": String(item.retryCount + 1),
          });

          const signedUrl = await mintSignedUrl(context, item);
          const modelName = item.modelName || deriveModelName(item);
          const newScanId = await submitScan(context, token, signedUrl, modelName);

          const recordProps: Record<string, string> = {
            "hiddenlayer.scan_id": newScanId,
            "hiddenlayer.scan_requested_at": new Date(Date.now()).toISOString(),
            "hiddenlayer.status": "PENDING",
          };
          if (!item.modelName) {
            recordProps["hiddenlayer.model_name"] = modelName;
          }
          await writeProperties(context, item, recordProps);

          counters.reTriggered++;
          counters.unprocessed--;
        } catch (err) {
          console.error(`Error re-triggering ${artifactKey(item)}:`, err);
          counters.errored++;
          counters.unprocessed--;
        }
      },
    );

    return { message: formatMessage(counters) };
  } catch (err: unknown) {
    console.error("Unexpected error in result-poller:", err);
    return { message: "Unexpected error in result-poller." };
  }
};
