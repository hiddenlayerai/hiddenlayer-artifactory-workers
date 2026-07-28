import type { PlatformContext } from "jfrog-workers";
import { BeforeDownloadRequest, BeforeDownloadResponse, DownloadStatus } from "./types";

// --- Configuration ---
// All tunable settings. Repository targeting (filterCriteria) lives in
// manifest.json. This Worker requires no secrets.
// Exported for test overrides; treat as immutable in production.

export const config = {
  PENDING_VERDICT: DownloadStatus.DOWNLOAD_STOP as DownloadStatus,
  FAILED_VERDICT: DownloadStatus.DOWNLOAD_STOP as DownloadStatus,
  MISSING_VERDICT: DownloadStatus.DOWNLOAD_STOP as DownloadStatus,
  perCallWaitBoundMs: 2_000,
};

// --- End Configuration ---

function makeResponse(status: DownloadStatus, message: string): BeforeDownloadResponse {
  return { status, message, headers: {} };
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

function isPlatformHttpError(err: unknown): err is { message: string; status: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  );
}

async function backfillTag(context: PlatformContext, repoPath: string): Promise<void> {
  try {
    await boundedPlatformCall(
      context.clients.platformHttp.patch(
        `/artifactory/api/metadata/${repoPath}?atomicProperties=1&recursiveProperties=0`,
        {
          props: {
            "hiddenlayer.status": "PENDING",
            "hiddenlayer.scan_requested_at": new Date(Date.now()).toISOString(),
          },
        },
        { "Content-Type": "application/json" },
      ),
    );
  } catch (err: unknown) {
    console.log(`Backfill tag failed for ${repoPath}:`, err);
  }
}

export default async (context: PlatformContext, data: BeforeDownloadRequest): Promise<BeforeDownloadResponse> => {
  let repoPath = "unknown artifact";

  try {
    if (!data.repoPath) {
      console.log("Skipped: unable to identify artifact from payload.");
      return makeResponse(config.MISSING_VERDICT, `HiddenLayer: could not determine scan status for ${repoPath}`);
    }

    repoPath = `${data.repoPath.key}/${data.repoPath.path}`;

    let properties: Record<string, unknown> | undefined;

    try {
      const response = await boundedPlatformCall(
        context.clients.platformHttp.get(`/artifactory/api/storage/${repoPath}?properties`),
      );
      properties = response.data?.properties as Record<string, unknown> | undefined;
    } catch (readErr: unknown) {
      if (isPlatformHttpError(readErr) && readErr.status === 404) {
        await backfillTag(context, repoPath);
        return makeResponse(
          config.MISSING_VERDICT,
          `HiddenLayer: no scan status for ${repoPath}; a scan has been requested`,
        );
      }

      console.log(`Property read failed for ${repoPath}:`, readErr);
      return makeResponse(config.MISSING_VERDICT, `HiddenLayer: could not determine scan status for ${repoPath}`);
    }

    const values = properties?.["hiddenlayer.status"] as unknown;

    if (values === undefined) {
      await backfillTag(context, repoPath);
      return makeResponse(
        config.MISSING_VERDICT,
        `HiddenLayer: no scan status for ${repoPath}; a scan has been requested`,
      );
    }

    if (!Array.isArray(values) || values.length !== 1) {
      return makeResponse(
        config.FAILED_VERDICT,
        `HiddenLayer: model scan did not complete for ${repoPath}; scans retry automatically up to a limit—if this persists, contact your administrator.`,
      );
    }

    switch (values[0]) {
      case "SAFE":
        return makeResponse(DownloadStatus.DOWNLOAD_PROCEED, "");
      case "UNSAFE":
        return makeResponse(
          DownloadStatus.DOWNLOAD_STOP,
          `HiddenLayer: this artifact failed model scanning (UNSAFE): ${repoPath}`,
        );
      case "PENDING":
        return makeResponse(
          config.PENDING_VERDICT,
          `HiddenLayer: model scan in progress for ${repoPath}; retry after the scan completes`,
        );
      case "FAILED":
        return makeResponse(
          config.FAILED_VERDICT,
          `HiddenLayer: model scan did not complete for ${repoPath}; scans retry automatically up to a limit—if this persists, contact your administrator.`,
        );
      default:
        return makeResponse(
          config.FAILED_VERDICT,
          `HiddenLayer: model scan did not complete for ${repoPath}; scans retry automatically up to a limit—if this persists, contact your administrator.`,
        );
    }
  } catch (err: unknown) {
    console.error("Unexpected error:", err);
    return makeResponse(config.MISSING_VERDICT, `HiddenLayer: could not determine scan status for ${repoPath}`);
  }
};
