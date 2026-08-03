import type { PlatformContext, PlatformClients, PlatformHttpClient } from "jfrog-workers";
import { createMock, DeepMocked } from "@golevelup/ts-jest";
import runWorker, { config } from "./worker";

function setupSecrets(context: DeepMocked<PlatformContext>) {
  (context.secrets.get as jest.Mock).mockImplementation((name: string) => {
    if (name === "HL_CLIENT_ID") return "test-client-id";
    if (name === "HL_CLIENT_SECRET") return "test-client-secret";
    return "";
  });
}

function setupTokenExchange(context: DeepMocked<PlatformContext>, token = "test-token") {
  setupSecrets(context);
  (context.clients.axios.post as jest.Mock).mockResolvedValueOnce({
    data: { access_token: token },
  });
}

function setupEmptyDiscovery(context: DeepMocked<PlatformContext>) {
  (context.clients.platformHttp.post as jest.Mock)
    .mockResolvedValueOnce({ status: 200, data: { results: [] } })
    .mockResolvedValueOnce({ status: 200, data: { results: [] } });
}

function makeAqlRow(
  repo: string,
  path: string,
  name: string,
  properties: Array<{ key: string; value: string }>,
  created = "2024-01-01T00:00:00.000Z",
) {
  return { repo, path, name, created, properties };
}

// Contradictory deprecated fields catch implementations that read the wrong one.

const SAFE_REPORT = {
  status: "done",
  detection_count: 99,
  severity: "safe",
  summary: {
    detection_count: 0,
    files_failed_to_scan: 0,
    unknown_files: 0,
    highest_severity: "none",
    severity: "safe",
    detection_categories: [],
  },
};

const UNSAFE_REPORT = {
  status: "done",
  detection_count: 0,
  severity: "none",
  summary: {
    detection_count: 3,
    highest_severity: "critical",
    severity: "safe",
    detection_categories: ["Trojan", "Backdoor"],
  },
};

function setupResolution(
  context: DeepMocked<PlatformContext>,
  options: {
    scanId?: string;
    retryCount?: number;
    report?: object;
    guardScanId?: string;
  } = {},
) {
  const { scanId = "scan-123", retryCount = 0, report = SAFE_REPORT, guardScanId = scanId } = options;

  setupTokenExchange(context);

  const properties: Array<{ key: string; value: string }> = [
    { key: "hiddenlayer.status", value: "PENDING" },
    { key: "hiddenlayer.scan_id", value: scanId },
  ];
  if (retryCount > 0) {
    properties.push({
      key: "hiddenlayer.retry_count",
      value: String(retryCount),
    });
  }

  (context.clients.platformHttp.post as jest.Mock)
    .mockResolvedValueOnce({
      status: 200,
      data: {
        results: [makeAqlRow("repo-a", "models/bert", "config.json", properties)],
      },
    })
    .mockResolvedValueOnce({ status: 200, data: { results: [] } });

  (context.clients.axios.get as jest.Mock).mockResolvedValueOnce({
    data: report,
  });

  (context.clients.platformHttp.get as jest.Mock).mockResolvedValueOnce({
    status: 200,
    data: { properties: { "hiddenlayer.scan_id": [guardScanId] } },
  });

  (context.clients.platformHttp.patch as jest.Mock).mockResolvedValueOnce({
    status: 204,
  });
}

function getWrittenProps(context: DeepMocked<PlatformContext>): Record<string, string> {
  const calls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[0][1].props;
}

describe("result-poller", () => {
  let context: DeepMocked<PlatformContext>;
  const defaultConfig = { ...config };

  beforeEach(() => {
    context = createMock<PlatformContext>({
      clients: createMock<PlatformClients>({
        platformHttp: createMock<PlatformHttpClient>(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        axios: { post: jest.fn(), get: jest.fn() } as any,
      }),
      secrets: { get: jest.fn().mockReturnValue("") },
    });
    Object.assign(config, defaultConfig);
    config.monitoredRepositories = ["repo-a", "repo-b"];
    context.getRemainingExecutionTime.mockReturnValue(20_000);
  });

  afterEach(() => {
    Object.assign(config, defaultConfig);
    jest.restoreAllMocks();
  });

  it("returns a message on every exit path", async () => {
    const result = await runWorker(context, { triggerID: "test" });
    expect(result).toEqual(expect.objectContaining({ message: expect.any(String) }));
  });

  it("catches unexpected exceptions and returns a well-formed response", async () => {
    (context.secrets.get as jest.Mock).mockImplementation(() => {
      throw new TypeError("boom");
    });
    const result = await runWorker(context, { triggerID: "test" });
    expect(result).toEqual(expect.objectContaining({ message: expect.any(String) }));
  });

  describe("token exchange", () => {
    it("POSTs to the auth host with Basic auth and form-encoded body", async () => {
      setupTokenExchange(context);
      setupEmptyDiscovery(context);

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.axios.post).toHaveBeenCalledWith(
        "https://auth.hiddenlayer.ai/oauth2/token",
        "grant_type=client_credentials",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Basic /),
            "Content-Type": "application/x-www-form-urlencoded",
          }),
        }),
      );

      const axiosCall = (context.clients.axios.post as jest.Mock).mock.calls[0];
      const authHeader = axiosCall[2].headers.Authorization as string;
      const decoded = Buffer.from(authHeader.replace("Basic ", ""), "base64").toString();
      expect(decoded).toBe("test-client-id:test-client-secret");
    });

    it("ends the run with no artifact modified when exchange fails", async () => {
      setupSecrets(context);
      (context.clients.axios.post as jest.Mock).mockRejectedValueOnce(new Error("401 Unauthorized"));

      const result = await runWorker(context, { triggerID: "test" });

      expect(result.message).toMatch(/token|auth/i);
      expect(context.clients.platformHttp.post).not.toHaveBeenCalled();
    });
  });

  describe("query composition", () => {
    it("composes AQL queries with property.*, type:file, repo scoping, and no .sort()", async () => {
      setupTokenExchange(context);
      setupEmptyDiscovery(context);

      await runWorker(context, { triggerID: "test" });

      const calls = (context.clients.platformHttp.post as jest.Mock).mock.calls;
      expect(calls).toHaveLength(2);

      for (const [endpoint, body, headers] of calls) {
        expect(endpoint).toBe("/artifactory/api/search/aql");
        expect(headers).toEqual(expect.objectContaining({ "Content-Type": "text/plain" }));

        expect(body).toContain("property.*");
        expect(body).toContain('"type": "file"');
        expect(body).toContain('"repo": "repo-a"');
        expect(body).toContain('"repo": "repo-b"');
        expect(body).not.toContain(".sort(");
      }

      const bodies = calls.map((c: unknown[]) => c[1] as string);
      expect(bodies.some((b) => b.includes('"PENDING"'))).toBe(true);
      expect(bodies.some((b) => b.includes('"FAILED"'))).toBe(true);
    });
  });

  describe("both discovery queries must succeed", () => {
    beforeEach(() => {
      setupTokenExchange(context);
    });

    it("ends the run when the first discovery query fails", async () => {
      (context.clients.platformHttp.post as jest.Mock).mockRejectedValueOnce({
        status: 500,
        message: "Internal Server Error",
      });

      const result = await runWorker(context, { triggerID: "test" });

      expect(result.message).toMatch(/discovery/i);
      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });

    it("ends the run when the second discovery query fails", async () => {
      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({ status: 200, data: { results: [] } })
        .mockRejectedValueOnce({
          status: 500,
          message: "Internal Server Error",
        });

      const result = await runWorker(context, { triggerID: "test" });

      expect(result.message).toMatch(/discovery/i);
      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });
  });

  describe("AQL row parsing", () => {
    beforeEach(() => {
      setupTokenExchange(context);
    });

    it("parses properties from a row's flat [{key, value}] list", async () => {
      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              makeAqlRow("repo-a", "models/bert", "config.json", [
                { key: "hiddenlayer.status", value: "PENDING" },
                { key: "hiddenlayer.scan_id", value: "scan-123" },
              ]),
            ],
          },
        })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      const result = await runWorker(context, { triggerID: "test" });

      expect(result.message).toMatch(/1\b.*unresolved/i);
    });

    it("treats a key appearing twice in one row as absent", async () => {
      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              makeAqlRow("repo-a", "models/bert", "config.json", [
                { key: "hiddenlayer.status", value: "PENDING" },
                { key: "hiddenlayer.scan_id", value: "scan-123" },
                { key: "hiddenlayer.scan_id", value: "scan-456" },
              ]),
            ],
          },
        })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      const result = await runWorker(context, { triggerID: "test" });

      // The artifact is discovered (from the PENDING query) but its scan_id
      // is treated as absent due to the duplicate key, so it routes into
      // the stale-PENDING re-trigger path rather than the results-check path.
      expect(result.message).toMatch(/1\b.*unresolved/i);
    });
  });

  describe("every exit path returns a message", () => {
    it("reports token exchange failure", async () => {
      setupSecrets(context);
      (context.clients.axios.post as jest.Mock).mockRejectedValueOnce(new Error("network error"));

      const result = await runWorker(context, { triggerID: "test" });

      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.message).toMatch(/token|auth/i);
    });

    it("reports discovery failure", async () => {
      setupTokenExchange(context);
      (context.clients.platformHttp.post as jest.Mock).mockRejectedValueOnce({
        status: 500,
        message: "fail",
      });

      const result = await runWorker(context, { triggerID: "test" });

      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.message).toMatch(/discovery/i);
    });

    it("reports no work found when both queries return empty", async () => {
      setupTokenExchange(context);
      setupEmptyDiscovery(context);

      const result = await runWorker(context, { triggerID: "test" });

      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
      expect(result.message).toMatch(/no work/i);
    });

    it("reports discovered and unprocessed counts when work exists", async () => {
      setupTokenExchange(context);

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              makeAqlRow("repo-a", "models/bert", "config.json", [
                { key: "hiddenlayer.status", value: "PENDING" },
                { key: "hiddenlayer.scan_id", value: "scan-123" },
              ]),
            ],
          },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              makeAqlRow("repo-a", "models/gpt", "weights.bin", [
                { key: "hiddenlayer.status", value: "FAILED" },
                { key: "hiddenlayer.retry_count", value: "1" },
                {
                  key: "hiddenlayer.next_retry_at",
                  value: "2020-01-01T00:00:00.000Z",
                },
              ]),
            ],
          },
        });

      const result = await runWorker(context, { triggerID: "test" });

      expect(result.message).toMatch(/discovered/i);
      expect(result.message).toMatch(/unprocessed/i);
    });
  });

  describe("done, count=0, no failures → SAFE with severity", () => {
    it("writes SAFE with severity from summary.highest_severity", async () => {
      setupResolution(context, { report: SAFE_REPORT });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).toHaveBeenCalledWith(
        "/artifactory/api/metadata/repo-a/models/bert/config.json?atomicProperties=1&recursiveProperties=0",
        expect.objectContaining({
          props: expect.objectContaining({
            "hiddenlayer.status": "SAFE",
            "hiddenlayer.severity": "none",
          }),
        }),
        expect.any(Object),
      );
    });
  });

  describe("done, count>0 → UNSAFE with severity and categories", () => {
    it("writes UNSAFE with severity and comma-joined categories", async () => {
      setupResolution(context, { report: UNSAFE_REPORT });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).toHaveBeenCalledWith(
        expect.stringContaining("atomicProperties=1"),
        expect.objectContaining({
          props: expect.objectContaining({
            "hiddenlayer.status": "UNSAFE",
            "hiddenlayer.severity": "critical",
            "hiddenlayer.detection_categories": "Trojan,Backdoor",
          }),
        }),
        expect.any(Object),
      );
    });
  });

  describe("done, empty categories → detection_categories not included", () => {
    it("omits detection_categories from the write", async () => {
      setupResolution(context, { report: SAFE_REPORT });

      await runWorker(context, { triggerID: "test" });

      const props = getWrittenProps(context);
      expect(props).not.toHaveProperty("hiddenlayer.detection_categories");
    });
  });

  describe("done, no highest_severity → severity not included", () => {
    it("omits severity from the write when report lacks it", async () => {
      const report = {
        status: "done",
        summary: {
          detection_count: 0,
          files_failed_to_scan: 0,
          unknown_files: 0,
          detection_categories: [],
        },
      };
      setupResolution(context, { report });

      await runWorker(context, { triggerID: "test" });

      const props = getWrittenProps(context);
      expect(props["hiddenlayer.status"]).toBe("SAFE");
      expect(props).not.toHaveProperty("hiddenlayer.severity");
    });
  });

  describe("done, detection_count absent → failed scan", () => {
    it("marks FAILED, not SAFE, when summary.detection_count is missing", async () => {
      const report = {
        status: "done",
        detection_count: 0,
        summary: {
          files_failed_to_scan: 0,
          unknown_files: 0,
          highest_severity: "none",
        },
      };
      setupResolution(context, { report });

      await runWorker(context, { triggerID: "test" });

      const props = getWrittenProps(context);
      expect(props["hiddenlayer.status"]).toBe("FAILED");
    });
  });

  describe("done, count=0, files_failed_to_scan>0 → failed scan", () => {
    it("marks FAILED when files failed to scan", async () => {
      const report = {
        status: "done",
        summary: {
          detection_count: 0,
          files_failed_to_scan: 2,
          unknown_files: 0,
          highest_severity: "none",
        },
      };
      setupResolution(context, { report });

      await runWorker(context, { triggerID: "test" });

      const props = getWrittenProps(context);
      expect(props["hiddenlayer.status"]).toBe("FAILED");
    });
  });

  describe("done, count=0, unknown_files>0 → failed scan", () => {
    it("marks FAILED when unknown files exist", async () => {
      const report = {
        status: "done",
        summary: {
          detection_count: 0,
          files_failed_to_scan: 0,
          unknown_files: 3,
          highest_severity: "none",
        },
      };
      setupResolution(context, { report });

      await runWorker(context, { triggerID: "test" });

      const props = getWrittenProps(context);
      expect(props["hiddenlayer.status"]).toBe("FAILED");
    });
  });

  describe("done, count>0, files_failed>0 → UNSAFE (detections take precedence)", () => {
    it("resolves UNSAFE despite failure signals", async () => {
      const report = {
        status: "done",
        summary: {
          detection_count: 2,
          files_failed_to_scan: 5,
          unknown_files: 1,
          highest_severity: "high",
          detection_categories: ["Malware"],
        },
      };
      setupResolution(context, { report });

      await runWorker(context, { triggerID: "test" });

      const props = getWrittenProps(context);
      expect(props["hiddenlayer.status"]).toBe("UNSAFE");
    });
  });

  describe("results check issued with has_detections=true", () => {
    it("passes has_detections=true on the results check URL", async () => {
      setupResolution(context);

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.axios.get).toHaveBeenCalledWith(
        expect.stringContaining("has_detections=true"),
        expect.any(Object),
      );
    });
  });

  describe("write contract", () => {
    it("writes via PATCH with atomicProperties=1, JSON props, not query-string PUT", async () => {
      setupResolution(context, { report: SAFE_REPORT });

      await runWorker(context, { triggerID: "test" });

      const calls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const [endpoint, body] = calls[0];
      expect(endpoint).toMatch(/^\/artifactory\/api\/metadata\/.+\?atomicProperties=1&recursiveProperties=0$/);
      expect(body).toHaveProperty("props");
      expect(typeof body.props).toBe("object");

      expect(context.clients.platformHttp.put).not.toHaveBeenCalled();
    });
  });

  describe("token sent as Bearer header on scan calls", () => {
    it("sends Authorization: Bearer on the HiddenLayer results check", async () => {
      setupResolution(context);

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.axios.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
          }),
        }),
      );
    });
  });

  describe("scan failed → FAILED with backoff", () => {
    it("marks FAILED with next_retry_at = now + 2^(count+1) minutes", async () => {
      jest.spyOn(Date, "now").mockReturnValue(new Date("2024-06-01T00:00:00.000Z").getTime());
      setupResolution(context, {
        retryCount: 2,
        report: { status: "failed" },
      });

      await runWorker(context, { triggerID: "test" });

      const props = getWrittenProps(context);
      expect(props["hiddenlayer.status"]).toBe("FAILED");
      expect(props["hiddenlayer.next_retry_at"]).toBe("2024-06-01T00:08:00.000Z");
      expect(props).not.toHaveProperty("hiddenlayer.retry_count");
    });
  });

  describe("scan canceled → identical handling to failed", () => {
    it("marks FAILED with backoff", async () => {
      jest.spyOn(Date, "now").mockReturnValue(new Date("2024-06-01T00:00:00.000Z").getTime());
      setupResolution(context, {
        retryCount: 0,
        report: { status: "canceled" },
      });

      await runWorker(context, { triggerID: "test" });

      const props = getWrittenProps(context);
      expect(props["hiddenlayer.status"]).toBe("FAILED");
      expect(props["hiddenlayer.next_retry_at"]).toBe("2024-06-01T00:02:00.000Z");
      expect(props).not.toHaveProperty("hiddenlayer.retry_count");
    });
  });

  describe("results check 404 → identical handling to failed", () => {
    it("marks FAILED with backoff when scan ID is unknown", async () => {
      jest.spyOn(Date, "now").mockReturnValue(new Date("2024-06-01T00:00:00.000Z").getTime());
      setupTokenExchange(context);

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              makeAqlRow("repo-a", "models/bert", "config.json", [
                { key: "hiddenlayer.status", value: "PENDING" },
                { key: "hiddenlayer.scan_id", value: "scan-gone" },
                { key: "hiddenlayer.retry_count", value: "1" },
              ]),
            ],
          },
        })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      (context.clients.axios.get as jest.Mock).mockRejectedValueOnce({
        response: { status: 404 },
      });

      (context.clients.platformHttp.get as jest.Mock).mockResolvedValueOnce({
        status: 200,
        data: { properties: { "hiddenlayer.scan_id": ["scan-gone"] } },
      });

      (context.clients.platformHttp.patch as jest.Mock).mockResolvedValueOnce({
        status: 204,
      });

      await runWorker(context, { triggerID: "test" });

      const props = getWrittenProps(context);
      expect(props["hiddenlayer.status"]).toBe("FAILED");
      expect(props["hiddenlayer.next_retry_at"]).toBe("2024-06-01T00:04:00.000Z");
      expect(props).not.toHaveProperty("hiddenlayer.retry_count");
    });
  });

  describe("marking FAILED at retry cap → terminal (no next_retry_at)", () => {
    it("writes FAILED without next_retry_at when at the cap", async () => {
      setupResolution(context, {
        retryCount: 5,
        report: { status: "failed" },
      });

      await runWorker(context, { triggerID: "test" });

      const props = getWrittenProps(context);
      expect(props["hiddenlayer.status"]).toBe("FAILED");
      expect(props).not.toHaveProperty("hiddenlayer.next_retry_at");
    });
  });

  describe("scan pending or running → untouched", () => {
    it("leaves the artifact unchanged", async () => {
      setupResolution(context, { report: { status: "running" } });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });
  });

  describe("unrecognized status / unparseable → untouched, logged", () => {
    it("leaves the artifact unchanged on unrecognized status", async () => {
      setupResolution(context, {
        report: { status: "some_new_status" },
      });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });

    it("leaves the artifact unchanged when the report has no status field", async () => {
      setupResolution(context, { report: {} });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });

    it("leaves the artifact unchanged on an unparseable report body", async () => {
      setupResolution(context, {
        report: "not-an-object" as unknown as object,
      });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });
  });

  describe("transport failures → untouched, retry_count NOT consumed", () => {
    it("does not consume a retry on a 5xx from HiddenLayer", async () => {
      setupTokenExchange(context);

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              makeAqlRow("repo-a", "models/bert", "config.json", [
                { key: "hiddenlayer.status", value: "PENDING" },
                { key: "hiddenlayer.scan_id", value: "scan-123" },
              ]),
            ],
          },
        })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      (context.clients.axios.get as jest.Mock).mockRejectedValueOnce({
        response: { status: 503 },
      });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
      expect(context.clients.platformHttp.get).not.toHaveBeenCalled();
    });

    it("does not consume a retry on a 429 from HiddenLayer", async () => {
      setupTokenExchange(context);

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              makeAqlRow("repo-a", "models/bert", "config.json", [
                { key: "hiddenlayer.status", value: "PENDING" },
                { key: "hiddenlayer.scan_id", value: "scan-123" },
              ]),
            ],
          },
        })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      (context.clients.axios.get as jest.Mock).mockRejectedValueOnce({
        response: { status: 429 },
      });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
      expect(context.clients.platformHttp.get).not.toHaveBeenCalled();
    });
  });

  describe("atomic result write fails → artifact unchanged", () => {
    it("leaves the artifact PENDING when the write fails", async () => {
      setupTokenExchange(context);

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              makeAqlRow("repo-a", "models/bert", "config.json", [
                { key: "hiddenlayer.status", value: "PENDING" },
                { key: "hiddenlayer.scan_id", value: "scan-123" },
              ]),
            ],
          },
        })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      (context.clients.axios.get as jest.Mock).mockResolvedValueOnce({
        data: SAFE_REPORT,
      });

      (context.clients.platformHttp.get as jest.Mock).mockResolvedValueOnce({
        status: 200,
        data: { properties: { "hiddenlayer.scan_id": ["scan-123"] } },
      });

      (context.clients.platformHttp.patch as jest.Mock).mockRejectedValueOnce({
        status: 500,
        message: "write failed",
      });

      const result = await runWorker(context, { triggerID: "test" });

      expect(result.message).toMatch(/errored/i);
    });
  });

  describe("overwrite guard mismatch → no write, skip", () => {
    it("skips writing when re-read scan_id differs", async () => {
      setupResolution(context, {
        scanId: "scan-original",
        guardScanId: "scan-replaced",
        report: SAFE_REPORT,
      });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });
  });

  describe("overwrite guard 404 or absent → skip", () => {
    it("skips when the guard re-read returns 404", async () => {
      setupTokenExchange(context);

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              makeAqlRow("repo-a", "models/bert", "config.json", [
                { key: "hiddenlayer.status", value: "PENDING" },
                { key: "hiddenlayer.scan_id", value: "scan-123" },
              ]),
            ],
          },
        })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      (context.clients.axios.get as jest.Mock).mockResolvedValueOnce({
        data: SAFE_REPORT,
      });

      (context.clients.platformHttp.get as jest.Mock).mockRejectedValueOnce({
        status: 404,
        message: "Not Found",
      });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });
  });

  describe("overwrite guard transport failure → skip", () => {
    it("skips when the guard re-read fails with 5xx", async () => {
      setupTokenExchange(context);

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              makeAqlRow("repo-a", "models/bert", "config.json", [
                { key: "hiddenlayer.status", value: "PENDING" },
                { key: "hiddenlayer.scan_id", value: "scan-123" },
              ]),
            ],
          },
        })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      (context.clients.axios.get as jest.Mock).mockResolvedValueOnce({
        data: SAFE_REPORT,
      });

      (context.clients.platformHttp.get as jest.Mock).mockRejectedValueOnce({
        status: 500,
        message: "Internal Server Error",
      });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });
  });

  describe("overwrite guard confirming → write proceeds", () => {
    it("allows the write when re-read scan_id matches", async () => {
      setupResolution(context, { report: SAFE_REPORT });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).toHaveBeenCalledTimes(1);
      const props = getWrittenProps(context);
      expect(props["hiddenlayer.status"]).toBe("SAFE");
    });
  });

  describe("storage-endpoint parsing", () => {
    it("parses a single-element value array to its value", async () => {
      setupResolution(context, {
        scanId: "scan-123",
        guardScanId: "scan-123",
        report: SAFE_REPORT,
      });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).toHaveBeenCalledTimes(1);
    });

    it("treats a multi-element array as absent", async () => {
      setupTokenExchange(context);

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              makeAqlRow("repo-a", "models/bert", "config.json", [
                { key: "hiddenlayer.status", value: "PENDING" },
                { key: "hiddenlayer.scan_id", value: "scan-123" },
              ]),
            ],
          },
        })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      (context.clients.axios.get as jest.Mock).mockResolvedValueOnce({
        data: SAFE_REPORT,
      });

      (context.clients.platformHttp.get as jest.Mock).mockResolvedValueOnce({
        status: 200,
        data: {
          properties: {
            "hiddenlayer.scan_id": ["scan-123", "scan-456"],
          },
        },
      });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });

    it("treats an empty array as absent", async () => {
      setupTokenExchange(context);

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              makeAqlRow("repo-a", "models/bert", "config.json", [
                { key: "hiddenlayer.status", value: "PENDING" },
                { key: "hiddenlayer.scan_id", value: "scan-123" },
              ]),
            ],
          },
        })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      (context.clients.axios.get as jest.Mock).mockResolvedValueOnce({
        data: SAFE_REPORT,
      });

      (context.clients.platformHttp.get as jest.Mock).mockResolvedValueOnce({
        status: 200,
        data: {
          properties: {
            "hiddenlayer.scan_id": [],
          },
        },
      });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });
  });

  function setupRetrigger(
    ctx: DeepMocked<PlatformContext>,
    artifact: {
      status: string;
      scanId?: string;
      retryCount?: string;
      nextRetryAt?: string;
      scanRequestedAt?: string;
      modelName?: string;
      path?: string;
    },
    options: {
      signedUrl?: string;
      newScanId?: string;
      retryCommitFails?: boolean;
      submissionFails?: boolean;
      recordingFails?: boolean;
    } = {},
  ) {
    const {
      signedUrl = "https://jfrog.example.com/signed?token=abc",
      newScanId = "new-scan-456",
      retryCommitFails = false,
      submissionFails = false,
      recordingFails = false,
    } = options;

    setupTokenExchange(ctx);

    const props: Array<{ key: string; value: string }> = [{ key: "hiddenlayer.status", value: artifact.status }];
    if (artifact.scanId) props.push({ key: "hiddenlayer.scan_id", value: artifact.scanId });
    if (artifact.retryCount)
      props.push({
        key: "hiddenlayer.retry_count",
        value: artifact.retryCount,
      });
    if (artifact.nextRetryAt)
      props.push({
        key: "hiddenlayer.next_retry_at",
        value: artifact.nextRetryAt,
      });
    if (artifact.scanRequestedAt)
      props.push({
        key: "hiddenlayer.scan_requested_at",
        value: artifact.scanRequestedAt,
      });
    if (artifact.modelName)
      props.push({
        key: "hiddenlayer.model_name",
        value: artifact.modelName,
      });

    const pendingResults =
      artifact.status === "PENDING" ? [makeAqlRow("repo-a", artifact.path ?? "models/bert", "config.json", props)] : [];
    const failedResults =
      artifact.status === "FAILED" ? [makeAqlRow("repo-a", artifact.path ?? "models/bert", "config.json", props)] : [];

    const postMock = ctx.clients.platformHttp.post as jest.Mock;
    postMock
      .mockResolvedValueOnce({ status: 200, data: { results: pendingResults } })
      .mockResolvedValueOnce({ status: 200, data: { results: failedResults } });

    if (!retryCommitFails) {
      postMock.mockResolvedValueOnce({ status: 201, data: signedUrl });
    }

    const patchMock = ctx.clients.platformHttp.patch as jest.Mock;
    if (retryCommitFails) {
      patchMock.mockRejectedValueOnce({ status: 500, message: "write failed" });
    } else {
      patchMock.mockResolvedValueOnce({ status: 204 });
      if (submissionFails) {
        // No recording mock needed
      } else if (recordingFails) {
        patchMock.mockRejectedValueOnce({
          status: 500,
          message: "write failed",
        });
      } else {
        patchMock.mockResolvedValueOnce({ status: 204 });
      }
    }

    if (!retryCommitFails) {
      if (submissionFails) {
        (ctx.clients.axios.post as jest.Mock).mockRejectedValueOnce(new Error("submission failed"));
      } else {
        (ctx.clients.axios.post as jest.Mock).mockResolvedValueOnce({
          data: { scan_id: newScanId },
        });
      }
    }
  }

  describe("full re-trigger sequence for FAILED artifact", () => {
    it("commits retry, mints URL, submits scan, records submission", async () => {
      jest.spyOn(Date, "now").mockReturnValue(new Date("2024-06-01T12:00:00.000Z").getTime());
      setupRetrigger(context, {
        status: "FAILED",
        retryCount: "1",
        nextRetryAt: "2024-06-01T11:00:00.000Z",
        modelName: "jfrog:repo-a/models/bert:config.json",
      });

      await runWorker(context, { triggerID: "test" });

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls).toHaveLength(2);

      expect(patchCalls[0][1].props["hiddenlayer.retry_count"]).toBe("2");

      const postCalls = (context.clients.platformHttp.post as jest.Mock).mock.calls;
      expect(postCalls[2][0]).toBe("/artifactory/api/signed/url");
      expect(postCalls[2][1]).toEqual(
        expect.objectContaining({
          repo_path: "repo-a/models/bert/config.json",
          valid_for_secs: 4 * 60 * 60,
        }),
      );

      const axiosPostCalls = (context.clients.axios.post as jest.Mock).mock.calls;
      const submitBody = axiosPostCalls[1][1];
      expect(submitBody.access.source).toBe("AWS_PRESIGNED");
      expect(submitBody.inventory.model_name).toBe("jfrog:repo-a/models/bert:config.json");
      expect(submitBody.inventory.model_version).toBe("");
      expect(submitBody.inventory.requesting_entity).toBe("hiddenlayer-jfrog-worker");
      expect(submitBody.inventory.request_source).toBe("Integration");
      expect(submitBody.inventory.origin).toBe("JFrog Artifactory");
      expect(submitBody.inventory.scan_target.deep_scan.file_location).toBe(
        "https://jfrog.example.com/signed?token=abc",
      );
      expect(submitBody.inventory).not.toHaveProperty("requested_scan_location");

      expect(patchCalls[1][1].props["hiddenlayer.scan_id"]).toBe("new-scan-456");
      expect(patchCalls[1][1].props["hiddenlayer.scan_requested_at"]).toBe("2024-06-01T12:00:00.000Z");
      expect(patchCalls[1][1].props["hiddenlayer.status"]).toBe("PENDING");
      expect(patchCalls[1][1].props).not.toHaveProperty("hiddenlayer.model_name");
    });
  });

  describe("FAILED within backoff window → untouched", () => {
    it("leaves the artifact alone when next_retry_at is in the future", async () => {
      setupRetrigger(context, {
        status: "FAILED",
        retryCount: "1",
        nextRetryAt: "2099-01-01T00:00:00.000Z",
      });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });
  });

  describe("FAILED at retry cap → untouched", () => {
    it("leaves the artifact alone when retry_count equals the cap", async () => {
      setupRetrigger(context, {
        status: "FAILED",
        retryCount: "5",
        nextRetryAt: "2020-01-01T00:00:00.000Z",
      });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });
  });

  describe("PENDING, no scan_id, within threshold → untouched", () => {
    it("leaves the artifact alone within the staleness threshold", async () => {
      jest.spyOn(Date, "now").mockReturnValue(new Date("2024-06-01T12:00:00.000Z").getTime());
      setupRetrigger(context, {
        status: "PENDING",
        scanRequestedAt: "2024-06-01T11:45:00.000Z",
      });

      await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
    });
  });

  describe("PENDING, no scan_id, past threshold, under cap → re-triggered", () => {
    it("runs the full re-trigger sequence for a stale PENDING artifact", async () => {
      jest.spyOn(Date, "now").mockReturnValue(new Date("2024-06-01T12:00:00.000Z").getTime());
      setupRetrigger(context, {
        status: "PENDING",
        retryCount: "0",
        scanRequestedAt: "2024-06-01T11:00:00.000Z",
      });

      await runWorker(context, { triggerID: "test" });

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls.length).toBeGreaterThanOrEqual(2);
      expect(patchCalls[0][1].props["hiddenlayer.retry_count"]).toBe("1");
      expect(patchCalls[1][1].props["hiddenlayer.status"]).toBe("PENDING");
      expect(patchCalls[1][1].props["hiddenlayer.model_name"]).toBe("jfrog:repo-a/models/bert:config.json");
    });
  });

  describe("PENDING, no scan_id, past threshold, at cap → terminal FAILED", () => {
    it("marks terminal FAILED without next_retry_at and no submission", async () => {
      jest.spyOn(Date, "now").mockReturnValue(new Date("2024-06-01T12:00:00.000Z").getTime());
      setupRetrigger(context, {
        status: "PENDING",
        retryCount: "5",
        scanRequestedAt: "2024-06-01T11:00:00.000Z",
      });

      await runWorker(context, { triggerID: "test" });

      const props = getWrittenProps(context);
      expect(props["hiddenlayer.status"]).toBe("FAILED");
      expect(props).not.toHaveProperty("hiddenlayer.next_retry_at");
      expect(context.clients.axios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry-count commit fails → abandoned", () => {
    it("abandons the re-trigger when the retry commit fails", async () => {
      setupRetrigger(
        context,
        {
          status: "FAILED",
          retryCount: "1",
          nextRetryAt: "2020-01-01T00:00:00.000Z",
        },
        { retryCommitFails: true },
      );

      await runWorker(context, { triggerID: "test" });

      expect((context.clients.platformHttp.patch as jest.Mock).mock.calls).toHaveLength(1);
      expect(context.clients.axios.post).toHaveBeenCalledTimes(1);
    });
  });

  describe("submission fails after retry-count commit → retry_count stands", () => {
    it("keeps the consumed retry_count when submission fails", async () => {
      setupRetrigger(
        context,
        {
          status: "FAILED",
          retryCount: "1",
          nextRetryAt: "2020-01-01T00:00:00.000Z",
        },
        { submissionFails: true },
      );

      const result = await runWorker(context, { triggerID: "test" });

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls).toHaveLength(1);
      expect(patchCalls[0][1].props["hiddenlayer.retry_count"]).toBe("2");
      expect(typeof result.message).toBe("string");
    });
  });

  describe("recording write fails → retry_count stands", () => {
    it("keeps the consumed retry_count when recording fails", async () => {
      setupRetrigger(
        context,
        {
          status: "FAILED",
          retryCount: "1",
          nextRetryAt: "2020-01-01T00:00:00.000Z",
        },
        { recordingFails: true },
      );

      const result = await runWorker(context, { triggerID: "test" });

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls).toHaveLength(2);
      expect(patchCalls[0][1].props["hiddenlayer.retry_count"]).toBe("2");
      expect(typeof result.message).toBe("string");
    });
  });

  describe("model_version submitted as empty string", () => {
    it("sends model_version as empty string in the submission body", async () => {
      setupRetrigger(context, {
        status: "FAILED",
        retryCount: "0",
        nextRetryAt: "2020-01-01T00:00:00.000Z",
      });

      await runWorker(context, { triggerID: "test" });

      const axiosPostCalls = (context.clients.axios.post as jest.Mock).mock.calls;
      expect(axiosPostCalls[1][1].inventory.model_version).toBe("");
    });
  });

  describe("model name derivation", () => {
    it("derives jfrog:repo/dirs:file for a nested path", async () => {
      setupRetrigger(context, {
        status: "FAILED",
        retryCount: "0",
        nextRetryAt: "2020-01-01T00:00:00.000Z",
        path: "teams/nlp/bert",
      });

      await runWorker(context, { triggerID: "test" });

      const axiosPostCalls = (context.clients.axios.post as jest.Mock).mock.calls;
      expect(axiosPostCalls[1][1].inventory.model_name).toBe("jfrog:repo-a/teams/nlp/bert:config.json");
    });

    it("derives jfrog:repo:file for a root-level artifact (path='.')", async () => {
      setupRetrigger(context, {
        status: "FAILED",
        retryCount: "0",
        nextRetryAt: "2020-01-01T00:00:00.000Z",
        path: ".",
      });

      await runWorker(context, { triggerID: "test" });

      const axiosPostCalls = (context.clients.axios.post as jest.Mock).mock.calls;
      expect(axiosPostCalls[1][1].inventory.model_name).toBe("jfrog:repo-a:config.json");
    });

    it("reuses an existing model_name rather than re-deriving", async () => {
      setupRetrigger(context, {
        status: "FAILED",
        retryCount: "0",
        nextRetryAt: "2020-01-01T00:00:00.000Z",
        modelName: "custom:stored-name",
      });

      await runWorker(context, { triggerID: "test" });

      const axiosPostCalls = (context.clients.axios.post as jest.Mock).mock.calls;
      expect(axiosPostCalls[1][1].inventory.model_name).toBe("custom:stored-name");
    });
  });

  describe("signed-URL repo_path assembly", () => {
    it("assembles repo/dirs/file for a nested path", async () => {
      setupRetrigger(context, {
        status: "FAILED",
        retryCount: "0",
        nextRetryAt: "2020-01-01T00:00:00.000Z",
        path: "teams/nlp",
      });

      await runWorker(context, { triggerID: "test" });

      const postCalls = (context.clients.platformHttp.post as jest.Mock).mock.calls;
      expect(postCalls[2][1].repo_path).toBe("repo-a/teams/nlp/config.json");
    });

    it("assembles repo/file for a root-level artifact (path='.')", async () => {
      setupRetrigger(context, {
        status: "FAILED",
        retryCount: "0",
        nextRetryAt: "2020-01-01T00:00:00.000Z",
        path: ".",
      });

      await runWorker(context, { triggerID: "test" });

      const postCalls = (context.clients.platformHttp.post as jest.Mock).mock.calls;
      expect(postCalls[2][1].repo_path).toBe("repo-a/config.json");
    });
  });

  describe("work-list dedup across queries", () => {
    it("processes a duplicate artifact only once", async () => {
      setupTokenExchange(context);

      const sharedRow = makeAqlRow("repo-a", "models/bert", "config.json", [
        { key: "hiddenlayer.status", value: "FAILED" },
        { key: "hiddenlayer.retry_count", value: "0" },
        { key: "hiddenlayer.next_retry_at", value: "2020-01-01T00:00:00.000Z" },
      ]);

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: { results: [sharedRow] },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { results: [sharedRow] },
        })
        .mockResolvedValueOnce({
          status: 201,
          data: "https://jfrog.example.com/signed",
        });

      (context.clients.platformHttp.patch as jest.Mock)
        .mockResolvedValueOnce({ status: 204 })
        .mockResolvedValueOnce({ status: 204 });

      (context.clients.axios.post as jest.Mock).mockResolvedValueOnce({
        data: { scan_id: "new-scan" },
      });

      await runWorker(context, { triggerID: "test" });

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls).toHaveLength(2);
      expect(patchCalls[0][1].props["hiddenlayer.retry_count"]).toBe("1");
    });
  });

  describe("absence fallbacks on re-trigger path", () => {
    it("treats absent retry_count as 0 and absent next_retry_at as eligible", async () => {
      setupRetrigger(context, {
        status: "FAILED",
      });

      await runWorker(context, { triggerID: "test" });

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls.length).toBeGreaterThanOrEqual(1);
      expect(patchCalls[0][1].props["hiddenlayer.retry_count"]).toBe("1");
    });

    it("treats absent scan_requested_at as past the staleness threshold", async () => {
      setupRetrigger(context, {
        status: "PENDING",
      });

      await runWorker(context, { triggerID: "test" });

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls.length).toBeGreaterThanOrEqual(1);
      expect(patchCalls[0][1].props["hiddenlayer.retry_count"]).toBe("1");
    });
  });

  describe("remaining-time reserve", () => {
    it("stops admitting artifacts when budget drops below the reserve", async () => {
      setupTokenExchange(context);

      const artifacts = [
        makeAqlRow(
          "repo-a",
          "models/a",
          "a.json",
          [
            { key: "hiddenlayer.status", value: "PENDING" },
            { key: "hiddenlayer.scan_id", value: "scan-a" },
          ],
          "2024-01-01T00:00:00.000Z",
        ),
        makeAqlRow(
          "repo-a",
          "models/b",
          "b.json",
          [
            { key: "hiddenlayer.status", value: "PENDING" },
            { key: "hiddenlayer.scan_id", value: "scan-b" },
          ],
          "2024-01-02T00:00:00.000Z",
        ),
        makeAqlRow(
          "repo-a",
          "models/c",
          "c.json",
          [
            { key: "hiddenlayer.status", value: "PENDING" },
            { key: "hiddenlayer.scan_id", value: "scan-c" },
          ],
          "2024-01-03T00:00:00.000Z",
        ),
      ];

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({ status: 200, data: { results: artifacts } })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      context.getRemainingExecutionTime
        .mockReturnValueOnce(15_000)
        .mockReturnValueOnce(15_000)
        .mockReturnValueOnce(5_000);

      (context.clients.axios.get as jest.Mock)
        .mockResolvedValueOnce({ data: SAFE_REPORT })
        .mockResolvedValueOnce({ data: SAFE_REPORT });

      (context.clients.platformHttp.get as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: { properties: { "hiddenlayer.scan_id": ["scan-a"] } },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { properties: { "hiddenlayer.scan_id": ["scan-b"] } },
        });

      (context.clients.platformHttp.patch as jest.Mock).mockResolvedValue({
        status: 204,
      });

      const result = await runWorker(context, { triggerID: "test" });

      expect(context.clients.axios.get).toHaveBeenCalledTimes(2);
      expect(result.message).toMatch(/unprocessed/i);
      expect(result.message).toMatch(/1/);
    });
  });

  describe("concurrency limit", () => {
    it("processes no more than the configured number of artifacts simultaneously", async () => {
      config.concurrencyLimit = 2;
      setupTokenExchange(context);

      const artifacts = Array.from({ length: 4 }, (_, i) =>
        makeAqlRow(
          "repo-a",
          "models",
          `${i}.json`,
          [
            { key: "hiddenlayer.status", value: "PENDING" },
            { key: "hiddenlayer.scan_id", value: `scan-${i}` },
          ],
          `2024-01-0${i + 1}T00:00:00.000Z`,
        ),
      );

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({ status: 200, data: { results: artifacts } })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      let maxConcurrent = 0;
      let currentConcurrent = 0;

      (context.clients.axios.get as jest.Mock).mockImplementation(() => {
        currentConcurrent++;
        if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
        return new Promise((resolve) => {
          setTimeout(() => {
            currentConcurrent--;
            resolve({ data: SAFE_REPORT });
          }, 10);
        });
      });

      (context.clients.platformHttp.get as jest.Mock).mockImplementation((url: string) => {
        const match = url.match(/\/(\d+)\.json\?/);
        const idx = match ? match[1] : "0";
        return Promise.resolve({
          status: 200,
          data: { properties: { "hiddenlayer.scan_id": [`scan-${idx}`] } },
        });
      });

      (context.clients.platformHttp.patch as jest.Mock).mockResolvedValue({
        status: 204,
      });

      await runWorker(context, { triggerID: "test" });

      expect(maxConcurrent).toBeLessThanOrEqual(2);
      expect(maxConcurrent).toBeGreaterThanOrEqual(2);
      expect(context.clients.axios.get).toHaveBeenCalledTimes(4);
      expect(context.clients.platformHttp.patch).toHaveBeenCalledTimes(4);
    }, 10_000);
  });

  describe("two-phase ordering", () => {
    it("processes all results checks before any re-trigger, oldest-first", async () => {
      setupTokenExchange(context);

      const pendingArtifact = makeAqlRow(
        "repo-a",
        "models",
        "newer.json",
        [
          { key: "hiddenlayer.status", value: "PENDING" },
          { key: "hiddenlayer.scan_id", value: "scan-pending" },
        ],
        "2024-01-02T00:00:00.000Z",
      );
      const failedArtifact = makeAqlRow(
        "repo-a",
        "models",
        "older.json",
        [
          { key: "hiddenlayer.status", value: "FAILED" },
          { key: "hiddenlayer.retry_count", value: "0" },
          {
            key: "hiddenlayer.next_retry_at",
            value: "2020-01-01T00:00:00.000Z",
          },
        ],
        "2024-01-01T00:00:00.000Z",
      );

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: { results: [pendingArtifact] },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { results: [failedArtifact] },
        })
        .mockResolvedValueOnce({
          status: 201,
          data: "https://jfrog.example.com/signed",
        });

      (context.clients.axios.get as jest.Mock).mockResolvedValueOnce({
        data: SAFE_REPORT,
      });

      (context.clients.platformHttp.get as jest.Mock).mockResolvedValueOnce({
        status: 200,
        data: { properties: { "hiddenlayer.scan_id": ["scan-pending"] } },
      });

      (context.clients.platformHttp.patch as jest.Mock).mockResolvedValue({
        status: 204,
      });

      (context.clients.axios.post as jest.Mock).mockResolvedValueOnce({
        data: { scan_id: "new-scan" },
      });

      await runWorker(context, { triggerID: "test" });

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls.length).toBeGreaterThanOrEqual(3);
      expect(patchCalls[0][1].props["hiddenlayer.status"]).toBe("SAFE");
      expect(patchCalls[1][1].props["hiddenlayer.retry_count"]).toBe("1");
    });
  });

  describe("per-artifact error isolation", () => {
    it("continues processing after one artifact throws", async () => {
      setupTokenExchange(context);

      const artifacts = [
        makeAqlRow(
          "repo-a",
          "models",
          "bad.json",
          [
            { key: "hiddenlayer.status", value: "PENDING" },
            { key: "hiddenlayer.scan_id", value: "scan-bad" },
          ],
          "2024-01-01T00:00:00.000Z",
        ),
        makeAqlRow(
          "repo-a",
          "models",
          "good.json",
          [
            { key: "hiddenlayer.status", value: "PENDING" },
            { key: "hiddenlayer.scan_id", value: "scan-good" },
          ],
          "2024-01-02T00:00:00.000Z",
        ),
      ];

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({ status: 200, data: { results: artifacts } })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      (context.clients.axios.get as jest.Mock)
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({ data: SAFE_REPORT });

      (context.clients.platformHttp.get as jest.Mock).mockResolvedValueOnce({
        status: 200,
        data: { properties: { "hiddenlayer.scan_id": ["scan-good"] } },
      });

      (context.clients.platformHttp.patch as jest.Mock).mockResolvedValue({
        status: 204,
      });

      const result = await runWorker(context, { triggerID: "test" });

      expect(context.clients.platformHttp.patch).toHaveBeenCalled();
      expect(result.message).toMatch(/errored/i);
    });
  });

  describe("processed-run message with counts", () => {
    it("includes discovered, resolved, and unprocessed in the message", async () => {
      setupTokenExchange(context);

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: {
            results: [
              makeAqlRow("repo-a", "models", "safe.json", [
                { key: "hiddenlayer.status", value: "PENDING" },
                { key: "hiddenlayer.scan_id", value: "scan-safe" },
              ]),
            ],
          },
        })
        .mockResolvedValueOnce({ status: 200, data: { results: [] } });

      (context.clients.axios.get as jest.Mock).mockResolvedValueOnce({
        data: SAFE_REPORT,
      });

      (context.clients.platformHttp.get as jest.Mock).mockResolvedValueOnce({
        status: 200,
        data: { properties: { "hiddenlayer.scan_id": ["scan-safe"] } },
      });

      (context.clients.platformHttp.patch as jest.Mock).mockResolvedValue({
        status: 204,
      });

      const result = await runWorker(context, { triggerID: "test" });

      expect(result.message).toMatch(/discovered/i);
      expect(result.message).toMatch(/1\b.*unresolved/i);
      expect(result.message).toMatch(/safe/i);
      expect(result.message).toMatch(/unprocessed.*0/i);
    });
  });

  describe("extra: snapshot invariant", () => {
    it("re-trigger phase uses the discovery snapshot, not recomputed state", async () => {
      setupTokenExchange(context);

      const pendingWithScan = makeAqlRow(
        "repo-a",
        "models",
        "resolvable.json",
        [
          { key: "hiddenlayer.status", value: "PENDING" },
          { key: "hiddenlayer.scan_id", value: "scan-1" },
        ],
        "2024-01-01T00:00:00.000Z",
      );
      const failedEligible = makeAqlRow(
        "repo-a",
        "models",
        "retriggerable.json",
        [
          { key: "hiddenlayer.status", value: "FAILED" },
          { key: "hiddenlayer.retry_count", value: "0" },
          {
            key: "hiddenlayer.next_retry_at",
            value: "2020-01-01T00:00:00.000Z",
          },
        ],
        "2024-01-02T00:00:00.000Z",
      );

      (context.clients.platformHttp.post as jest.Mock)
        .mockResolvedValueOnce({
          status: 200,
          data: { results: [pendingWithScan] },
        })
        .mockResolvedValueOnce({
          status: 200,
          data: { results: [failedEligible] },
        })
        .mockResolvedValueOnce({
          status: 201,
          data: "https://jfrog.example.com/signed",
        });

      (context.clients.axios.get as jest.Mock).mockResolvedValueOnce({
        data: { status: "failed" },
      });

      (context.clients.platformHttp.get as jest.Mock).mockResolvedValueOnce({
        status: 200,
        data: { properties: { "hiddenlayer.scan_id": ["scan-1"] } },
      });

      (context.clients.platformHttp.patch as jest.Mock).mockResolvedValue({
        status: 204,
      });

      (context.clients.axios.post as jest.Mock).mockResolvedValueOnce({
        data: { scan_id: "new-scan" },
      });

      await runWorker(context, { triggerID: "test" });

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls[0][1].props["hiddenlayer.status"]).toBe("FAILED");
      const retriggerPatches = patchCalls.filter(
        (c: unknown[]) => (c[1] as { props: Record<string, string> }).props["hiddenlayer.retry_count"] !== undefined,
      );
      expect(retriggerPatches).toHaveLength(1);
    });
  });
});
