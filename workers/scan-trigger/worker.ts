import type { PlatformContext } from "jfrog-workers";
import { AfterCreateRequest, AfterCreateResponse } from "./types";

declare function btoa(data: string): string;

// --- Configuration ---
// All tunable settings. Secrets (HL_CLIENT_ID, HL_CLIENT_SECRET) and the
// repository targeting (filterCriteria) live in manifest.json.
// Exported for test overrides; treat as immutable in production.

export const config = {
  signedUrlTtlSecs: 4 * 60 * 60,
  perCallWaitBoundMs: 2_000,
  hlApiBaseUrl: "https://api.hiddenlayer.ai",
  hlAuthBaseUrl: "https://auth.hiddenlayer.ai",
};

// --- End Configuration ---

const ALL_PROPERTIES = [
  "hiddenlayer.status",
  "hiddenlayer.scan_id",
  "hiddenlayer.scan_requested_at",
  "hiddenlayer.retry_count",
  "hiddenlayer.next_retry_at",
  "hiddenlayer.model_name",
  "hiddenlayer.severity",
  "hiddenlayer.detection_categories",
];

function artifactPath(key: string, path: string): string {
  return `${key}/${path}`;
}

function deriveModelName(key: string, path: string): string {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) {
    return `jfrog:${key}:${path}`;
  }
  const dirPath = path.substring(0, lastSlash);
  const fileName = path.substring(lastSlash + 1);
  return `jfrog:${key}/${dirPath}:${fileName}`;
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

async function patchProperties(
  context: PlatformContext,
  key: string,
  path: string,
  props: Record<string, string | null>,
): Promise<void> {
  await boundedPlatformCall(
    context.clients.platformHttp.patch(
      `/artifactory/api/metadata/${artifactPath(key, path)}?atomicProperties=1&recursiveProperties=0`,
      { props },
      { "Content-Type": "application/json" },
    ),
  );
}

function isPlatformHttpError(err: unknown): err is { message: string; status: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  );
}

async function resetProperties(
  context: PlatformContext,
  key: string,
  path: string,
): Promise<"ok" | "deleted" | "failed"> {
  const nullProps: Record<string, null> = {};
  for (const prop of ALL_PROPERTIES) {
    nullProps[prop] = null;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await patchProperties(context, key, path, nullProps);
      return "ok";
    } catch (err: unknown) {
      if (attempt === 0 && isPlatformHttpError(err) && err.status === 404) {
        return "deleted";
      }
      if (attempt === 1) {
        console.error(`Reset failed after retry for ${artifactPath(key, path)}:`, err);
        return "failed";
      }
    }
  }

  return "failed";
}

async function mintSignedUrl(context: PlatformContext, key: string, path: string): Promise<string> {
  const response = await boundedPlatformCall(
    context.clients.platformHttp.post("/artifactory/api/signed/url", {
      repo_path: artifactPath(key, path),
      valid_for_secs: config.signedUrlTtlSecs,
    }),
  );
  return response.data as string;
}

async function exchangeToken(context: PlatformContext, clientId: string, clientSecret: string): Promise<string> {
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
  return response.data.access_token;
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

export default async (context: PlatformContext, data: AfterCreateRequest): Promise<AfterCreateResponse> => {
  try {
    if (!data.metadata || !data.metadata.repoPath) {
      console.log("Skipped: unable to identify artifact from payload.");
      return { message: "Skipped: unable to identify artifact from payload." };
    }

    const repoPath = data.metadata.repoPath;

    if (repoPath.isFolder) {
      return {
        message: `Skipped: folder event for ${repoPath.key}/${repoPath.path}.`,
      };
    }

    const key = repoPath.key;
    const path = repoPath.path;
    const artifact = artifactPath(key, path);

    // Step 1: Reset
    const resetResult = await resetProperties(context, key, path);

    if (resetResult === "deleted") {
      return {
        message: `Skipped: artifact ${artifact} was deleted before reset.`,
      };
    }

    if (resetResult === "failed") {
      return { message: `Abort: reset failed for ${artifact}.` };
    }

    // Step 2: Tag
    try {
      await patchProperties(context, key, path, {
        "hiddenlayer.status": "PENDING",
        "hiddenlayer.scan_requested_at": new Date(Date.now()).toISOString(),
      });
    } catch (err: unknown) {
      console.error(`Tag write failed for ${artifact}:`, err);
      return { message: `Abort: tag write failed for ${artifact}.` };
    }

    // Step 3: Submit (signed URL, token exchange, scan submission)
    let signedUrl: string;
    try {
      signedUrl = await mintSignedUrl(context, key, path);
    } catch (err: unknown) {
      console.error(`Signed URL minting failed for ${artifact}:`, err);
      return {
        message: `Abort: signed URL minting failed for ${artifact}.`,
      };
    }

    const clientId = context.secrets.get("HL_CLIENT_ID");
    const clientSecret = context.secrets.get("HL_CLIENT_SECRET");

    let token: string;
    try {
      token = await exchangeToken(context, clientId, clientSecret);
    } catch (err: unknown) {
      console.error(`Token exchange failed for ${artifact}:`, err);
      return { message: `Abort: token exchange failed for ${artifact}.` };
    }

    const modelName = deriveModelName(key, path);

    let scanId: string;
    try {
      scanId = await submitScan(context, token, signedUrl, modelName);
    } catch (err: unknown) {
      console.error(`Scan submission failed for ${artifact}:`, err);
      return {
        message: `Abort: scan submission failed for ${artifact}.`,
      };
    }

    // Step 4: Record
    try {
      await patchProperties(context, key, path, {
        "hiddenlayer.scan_id": scanId,
        "hiddenlayer.model_name": modelName,
      });
    } catch (err: unknown) {
      console.error(`Record write failed for ${artifact}:`, err);
      return { message: `Abort: record write failed for ${artifact}.` };
    }

    return {
      message: `Submitted scan ${scanId} for ${artifact}.`,
    };
  } catch (err: unknown) {
    console.error("Unexpected error:", err);
    return { message: "Unexpected error during scan trigger." };
  }
};
