import type { PlatformContext, PlatformClients, PlatformHttpClient } from "jfrog-workers";
import { createMock, DeepMocked } from "@golevelup/ts-jest";
import runWorker, { config } from "./worker";
import { BeforeDownloadRequest, DownloadStatus, RepoPath } from "./types";

// --- Test helpers ---

function makeRepoPath(key = "my-repo", path = "models/bert/config.bin"): RepoPath {
  return {
    key,
    path,
    id: `${key}:${path}`,
    isRoot: false,
    isFolder: false,
  };
}

function makeRequest(repoPath?: RepoPath): BeforeDownloadRequest {
  return {
    metadata: undefined,
    headers: {},
    userContext: undefined,
    repoPath,
  };
}

function setupPropertyRead(context: DeepMocked<PlatformContext>, values: string[] | undefined): void {
  const properties: Record<string, string[]> = {};
  if (values !== undefined) {
    properties["hiddenlayer.status"] = values;
  }
  (context.clients.platformHttp.get as jest.Mock).mockResolvedValueOnce({
    status: 200,
    data: { properties },
  });
}

// --- Tests ---

describe("download-gate", () => {
  let context: DeepMocked<PlatformContext>;
  const defaultConfig = { ...config };

  beforeEach(() => {
    context = createMock<PlatformContext>({
      clients: createMock<PlatformClients>({
        platformHttp: createMock<PlatformHttpClient>(),
      }),
    });
    Object.assign(config, defaultConfig);
  });

  afterEach(() => {
    Object.assign(config, defaultConfig);
    jest.restoreAllMocks();
  });

  // --- Row 1: SAFE → PROCEED ---

  it("row 1: SAFE status returns DOWNLOAD_PROCEED", async () => {
    setupPropertyRead(context, ["SAFE"]);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_PROCEED);
  });

  // --- Row 2: UNSAFE → STOP, message names UNSAFE and path ---

  it("row 2: UNSAFE status returns DOWNLOAD_STOP with message naming UNSAFE and path", async () => {
    setupPropertyRead(context, ["UNSAFE"]);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_STOP);
    expect(result.message).toMatch(/^HiddenLayer:/);
    expect(result.message).toMatch(/UNSAFE/);
    expect(result.message).toContain("my-repo/models/bert/config.bin");
  });

  // --- Row 3: PENDING → configurable ---

  it("row 3: PENDING status returns DOWNLOAD_STOP under default config", async () => {
    setupPropertyRead(context, ["PENDING"]);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_STOP);
    expect(result.message).toMatch(/^HiddenLayer:/);
    expect(result.message).toContain("my-repo/models/bert/config.bin");
  });

  it("row 3: PENDING status returns DOWNLOAD_WARN when PENDING_VERDICT = WARN", async () => {
    config.PENDING_VERDICT = DownloadStatus.DOWNLOAD_WARN;
    setupPropertyRead(context, ["PENDING"]);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_WARN);
  });

  // --- Row 4: FAILED → configurable ---

  it("row 4: FAILED status returns DOWNLOAD_STOP under default config", async () => {
    setupPropertyRead(context, ["FAILED"]);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_STOP);
    expect(result.message).toMatch(/^HiddenLayer:/);
    expect(result.message).toContain("my-repo/models/bert/config.bin");
  });

  it("row 4: FAILED status returns DOWNLOAD_WARN when FAILED_VERDICT = WARN", async () => {
    config.FAILED_VERDICT = DownloadStatus.DOWNLOAD_WARN;
    setupPropertyRead(context, ["FAILED"]);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_WARN);
  });

  // --- Row 5: Unrecognized status → FAILED_VERDICT ---

  it("row 5: unrecognized status value follows FAILED_VERDICT (default STOP)", async () => {
    setupPropertyRead(context, ["BANANA"]);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_STOP);
    expect(result.message).toMatch(/^HiddenLayer:/);
    expect(result.message).toContain("my-repo/models/bert/config.bin");
  });

  it("row 5: unrecognized status value follows FAILED_VERDICT = WARN", async () => {
    config.FAILED_VERDICT = DownloadStatus.DOWNLOAD_WARN;
    setupPropertyRead(context, ["BANANA"]);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_WARN);
  });

  // --- Row 6: Multi-valued → FAILED_VERDICT, no backfill ---

  it("row 6: multi-valued status follows FAILED_VERDICT with no backfill tag", async () => {
    setupPropertyRead(context, ["SAFE", "UNSAFE"]);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_STOP);
    expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
  });

  // --- Row 7: Empty-array → FAILED_VERDICT, no backfill ---

  it("row 7: empty-array status follows FAILED_VERDICT with no backfill tag", async () => {
    setupPropertyRead(context, []);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_STOP);
    expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
  });

  // --- Row 8: Lowercase "safe" → FAILED_VERDICT (case-sensitive) ---

  it("row 8: lowercase 'safe' does not proceed (case-sensitive allowlist)", async () => {
    setupPropertyRead(context, ["safe"]);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_STOP);
  });

  // --- Row 13: Unexpected exception → MISSING_VERDICT ---

  it("row 13: unexpected exception returns MISSING_VERDICT with well-formed response and no writes", async () => {
    (context.clients.platformHttp.get as jest.Mock).mockImplementation(() => {
      throw new TypeError("boom");
    });
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(config.MISSING_VERDICT);
    expect(result.message).toMatch(/^HiddenLayer:/);
    expect(result.headers).toBeDefined();
    expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
  });

  // --- Row 14: Response mapping ---

  it("row 14: PROCEED verdict produces numeric DOWNLOAD_PROCEED", async () => {
    setupPropertyRead(context, ["SAFE"]);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(1);
  });

  it("row 14: STOP verdict produces numeric DOWNLOAD_STOP with message", async () => {
    setupPropertyRead(context, ["UNSAFE"]);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(2);
    expect(result.message).toMatch(/^HiddenLayer:/);
  });

  it("row 14: WARN verdict produces numeric DOWNLOAD_WARN with message", async () => {
    config.PENDING_VERDICT = DownloadStatus.DOWNLOAD_WARN;
    setupPropertyRead(context, ["PENDING"]);
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(3);
    expect(result.message).toMatch(/^HiddenLayer:/);
  });

  // --- Row 16: data.repoPath undefined → MISSING_VERDICT, no read, no writes ---

  it("row 16: undefined repoPath logs and returns MISSING_VERDICT with no reads or writes", async () => {
    const consoleSpy = jest.spyOn(console, "log").mockImplementation();
    const result = await runWorker(context, makeRequest());
    expect(result.status).toBe(config.MISSING_VERDICT);
    expect(result.message).toMatch(/^HiddenLayer:/);
    expect(result.message).toMatch(/could not determine/i);
    expect(consoleSpy).toHaveBeenCalled();
    expect(context.clients.platformHttp.get).not.toHaveBeenCalled();
    expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
  });

  // --- Row 9: No hiddenlayer.status → MISSING_VERDICT, writes backfill tag ---

  it("row 9: missing status returns MISSING_VERDICT = STOP and writes backfill tag", async () => {
    setupPropertyRead(context, undefined);
    (context.clients.platformHttp.patch as jest.Mock).mockResolvedValueOnce({
      status: 204,
    });
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_STOP);
    expect(result.message).toMatch(/^HiddenLayer:/);
    expect(result.message).toMatch(/no scan status/i);

    const patchCall = (context.clients.platformHttp.patch as jest.Mock).mock.calls[0];
    expect(patchCall[0]).toContain("atomicProperties=1");
    const props = patchCall[1].props;
    expect(props["hiddenlayer.status"]).toBe("PENDING");
    expect(props["hiddenlayer.scan_requested_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(context.clients.platformHttp.put).not.toHaveBeenCalled();
  });

  it("row 9: missing status returns MISSING_VERDICT = WARN when configured", async () => {
    config.MISSING_VERDICT = DownloadStatus.DOWNLOAD_WARN;
    setupPropertyRead(context, undefined);
    (context.clients.platformHttp.patch as jest.Mock).mockResolvedValueOnce({
      status: 204,
    });
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_WARN);
    expect(context.clients.platformHttp.patch).toHaveBeenCalled();
  });

  it("row 9: missing status returns MISSING_VERDICT = PROCEED when configured", async () => {
    config.MISSING_VERDICT = DownloadStatus.DOWNLOAD_PROCEED;
    setupPropertyRead(context, undefined);
    (context.clients.platformHttp.patch as jest.Mock).mockResolvedValueOnce({
      status: 204,
    });
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(DownloadStatus.DOWNLOAD_PROCEED);
    expect(context.clients.platformHttp.patch).toHaveBeenCalled();
  });

  // --- Row 10: 404 → same as missing status (backfill tag, MISSING_VERDICT) ---

  it("row 10: property read 404 triggers backfill tag and returns MISSING_VERDICT", async () => {
    (context.clients.platformHttp.get as jest.Mock).mockRejectedValueOnce({
      message: "No properties could be found.",
      status: 404,
    });
    (context.clients.platformHttp.patch as jest.Mock).mockResolvedValueOnce({
      status: 204,
    });
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(config.MISSING_VERDICT);
    expect(result.message).toMatch(/no scan status/i);

    const patchCall = (context.clients.platformHttp.patch as jest.Mock).mock.calls[0];
    expect(patchCall[0]).toContain("atomicProperties=1");
    const props = patchCall[1].props;
    expect(props["hiddenlayer.status"]).toBe("PENDING");
    expect(props["hiddenlayer.scan_requested_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // --- Row 11: Read error (5xx/network) → MISSING_VERDICT, no writes ---

  it("row 11: property read 500 returns MISSING_VERDICT with no writes", async () => {
    (context.clients.platformHttp.get as jest.Mock).mockRejectedValueOnce({
      message: "Internal Server Error",
      status: 500,
    });
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(config.MISSING_VERDICT);
    expect(result.message).toMatch(/could not determine/i);
    expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
  });

  // --- Row 12: Backfill write fails → logged, still MISSING_VERDICT ---

  it("row 12: backfill tag write failure is logged and verdict is still MISSING_VERDICT", async () => {
    const consoleSpy = jest.spyOn(console, "log").mockImplementation();
    setupPropertyRead(context, undefined);
    (context.clients.platformHttp.patch as jest.Mock).mockRejectedValueOnce({
      message: "Service Unavailable",
      status: 503,
    });
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(config.MISSING_VERDICT);
    expect(consoleSpy).toHaveBeenCalled();
  });

  // --- Row 15: Only 404 takes no-properties path; other errors take read-error path ---

  it("row 15: a 403 error does not trigger backfill (only 404 does)", async () => {
    (context.clients.platformHttp.get as jest.Mock).mockRejectedValueOnce({
      message: "Forbidden",
      status: 403,
    });
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(config.MISSING_VERDICT);
    expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
  });

  it("row 15: error with only nested response.status 404 does not trigger backfill", async () => {
    (context.clients.platformHttp.get as jest.Mock).mockRejectedValueOnce({
      message: "Not Found",
      response: { status: 404 },
    });
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(config.MISSING_VERDICT);
    expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
  });

  // --- Row 17: Per-call wait bound ---

  it("row 17: property read that never settles times out to read-failure path (no writes)", async () => {
    config.perCallWaitBoundMs = 50;
    (context.clients.platformHttp.get as jest.Mock).mockReturnValueOnce(new Promise(() => {}));
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(config.MISSING_VERDICT);
    expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
  });

  it("row 17: backfill write that never settles times out but verdict is unchanged", async () => {
    config.perCallWaitBoundMs = 50;
    setupPropertyRead(context, undefined);
    (context.clients.platformHttp.patch as jest.Mock).mockReturnValueOnce(new Promise(() => {}));
    const result = await runWorker(context, makeRequest(makeRepoPath()));
    expect(result.status).toBe(config.MISSING_VERDICT);
  });
});
