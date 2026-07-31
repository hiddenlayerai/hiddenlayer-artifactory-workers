import type { PlatformContext } from "jfrog-workers";
import { AfterCreateRequest, AfterCreateResponse } from "./types";

// --- Configuration ---
// All tunable settings. Secrets (HL_CLIENT_ID, HL_CLIENT_SECRET) and the
// repository targeting (filterCriteria) live in manifest.json.
// Exported for test overrides; treat as immutable in production.

export const config = {
  signedUrlTtlSecs: 4 * 60 * 60,
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

async function patchProperties(
  context: PlatformContext,
  key: string,
  path: string,
  props: Record<string, string | null>,
): Promise<void> {
  await context.clients.platformHttp.patch(
    `/artifactory/api/metadata/${artifactPath(key, path)}?atomicProperties=1&recursiveProperties=0`,
    { props },
    { "Content-Type": "application/json" },
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
        console.error(
          `Reset failed after retry for ${artifactPath(key, path)}: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`,
        );
        return "failed";
      }
    }
  }

  return "failed";
}

async function mintSignedUrl(context: PlatformContext, key: string, path: string): Promise<string> {
  const response = await context.clients.platformHttp.post("/artifactory/api/signed/url", {
    repo_path: artifactPath(key, path),
    valid_for_secs: config.signedUrlTtlSecs,
  });
  return response.data as string;
}

function toBase64(str: string): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i);
    const b = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
    const c = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
    result += chars[a >> 2];
    result += chars[((a & 3) << 4) | (b >> 4)];
    result += i + 1 < str.length ? chars[((b & 15) << 2) | (c >> 6)] : "=";
    result += i + 2 < str.length ? chars[c & 63] : "=";
  }
  return result;
}

async function exchangeToken(context: PlatformContext, clientId: string, clientSecret: string): Promise<string> {
  const credentials = toBase64(`${clientId}:${clientSecret}`);
  const response = await context.clients.axios.post(
    `${config.hlAuthBaseUrl}/oauth2/token`,
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
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
  const url = `${config.hlApiBaseUrl}/scan/v3/jobs`;
  const body = {
    access: { source: "AWS_PRESIGNED" },
    inventory: {
      model_name: modelName,
      model_version: "",
      requesting_entity: "hiddenlayer-jfrog-worker",
      request_source: "Integration",
      origin: "JFrog Artifactory",
      scan_target: { deep_scan: { file_location: signedUrl } },
    },
  };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "hiddenlayer-jfrog-worker/1.0",
  };
  console.log(`DIAG submitScan url=${url}`);
  console.log(`DIAG submitScan body=${JSON.stringify(body)}`);
  console.log(`DIAG submitScan auth=Bearer ${token.substring(0, 10)}...`);
  try {
    const response = await context.clients.axios.post(url, body, { headers });
    console.log(`DIAG submitScan response status=${response.status}`);
    return response.data.scan_id;
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    console.error(`DIAG submitScan error status=${e.status} code=${e.code} message=${e.message}`);
    if (e.response) {
      const resp = e.response as Record<string, unknown>;
      console.error(
        `DIAG submitScan response status=${resp.status} headers=${JSON.stringify(resp.headers)} data=${JSON.stringify(resp.data)}`,
      );
    }
    throw err;
  }
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
      console.error(
        `Tag write failed for ${artifact}: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`,
      );
      return { message: `Abort: tag write failed for ${artifact}.` };
    }

    // Step 3: Submit (signed URL, token exchange, scan submission)
    let signedUrl: string;
    try {
      signedUrl = await mintSignedUrl(context, key, path);
    } catch (err: unknown) {
      console.error(
        `Signed URL minting failed for ${artifact}: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`,
      );
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
      console.error(
        `Token exchange failed for ${artifact}: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`,
      );
      return { message: `Abort: token exchange failed for ${artifact}.` };
    }

    const modelName = deriveModelName(key, path);

    let scanId: string;
    try {
      scanId = await submitScan(context, token, signedUrl, modelName);
    } catch (err: unknown) {
      const errObj = err as Record<string, unknown>;
      const responseData = errObj.response
        ? JSON.stringify((errObj.response as Record<string, unknown>).data)
        : "no response body";
      console.error(
        `Scan submission failed for ${artifact}: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))} | response body: ${responseData}`,
      );
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
      console.error(
        `Record write failed for ${artifact}: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`,
      );
      return { message: `Abort: record write failed for ${artifact}.` };
    }

    return {
      message: `Submitted scan ${scanId} for ${artifact}.`,
    };
  } catch (err: unknown) {
    console.error(`Unexpected error: ${JSON.stringify(err, Object.getOwnPropertyNames(err as object))}`);
    return { message: "Unexpected error during scan trigger." };
  }
};
