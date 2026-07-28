import type { PlatformContext } from "jfrog-workers";
import { AfterCreateRequest, RepoType } from "./types";
import { createMock, DeepMocked } from "@golevelup/ts-jest";
import runWorker from "./worker";
import { config } from "./worker";

function makeRequest(overrides?: Partial<AfterCreateRequest>): AfterCreateRequest {
  return {
    metadata: {
      repoPath: {
        key: "models-local",
        path: "teams/nlp/bert/config.json",
        id: "models-local:teams/nlp/bert/config.json",
        isRoot: false,
        isFolder: false,
      },
      contentLength: 1024,
      lastModified: Date.now(),
      trustServerChecksums: false,
      servletContextUrl: "https://example.jfrog.io/artifactory",
      skipJarIndexing: false,
      disableRedirect: false,
      repoType: RepoType.REPO_TYPE_LOCAL,
    },
    headers: {},
    userContext: { id: "admin", isToken: false, realm: "ldap" },
    ...overrides,
  };
}

function makeFolderRequest(): AfterCreateRequest {
  return makeRequest({
    metadata: {
      repoPath: {
        key: "models-local",
        path: "teams/nlp/bert",
        id: "models-local:teams/nlp/bert",
        isRoot: false,
        isFolder: true,
      },
      contentLength: 0,
      lastModified: Date.now(),
      trustServerChecksums: false,
      servletContextUrl: "https://example.jfrog.io/artifactory",
      skipJarIndexing: false,
      disableRedirect: false,
      repoType: RepoType.REPO_TYPE_LOCAL,
    },
  });
}

const ALL_EIGHT_PROPERTIES = [
  "hiddenlayer.status",
  "hiddenlayer.scan_id",
  "hiddenlayer.scan_requested_at",
  "hiddenlayer.retry_count",
  "hiddenlayer.next_retry_at",
  "hiddenlayer.model_name",
  "hiddenlayer.severity",
  "hiddenlayer.detection_categories",
];

describe("scan-trigger", () => {
  let context: DeepMocked<PlatformContext>;
  let savedConfig: typeof config;

  function setupSecrets(): void {
    (context.secrets.get as jest.Mock).mockImplementation((key: string) => {
      if (key === "HL_CLIENT_ID") {
        return "test-client-id";
      }
      if (key === "HL_CLIENT_SECRET") {
        return "test-client-secret";
      }
      return "";
    });
  }

  function setupResetSuccess(): void {
    (context.clients.platformHttp.patch as jest.Mock).mockResolvedValueOnce({ status: 204, headers: {}, data: null });
  }

  function getResetProps(): Record<string, unknown> {
    const patchMock = context.clients.platformHttp.patch as jest.Mock;
    expect(patchMock.mock.calls.length).toBeGreaterThan(0);
    return patchMock.mock.calls[0][1].props;
  }

  beforeEach(() => {
    savedConfig = { ...config };
    context = createMock<PlatformContext>({
      secrets: { get: jest.fn().mockReturnValue("") },
      clients: {
        platformHttp: {
          get: jest.fn(),
          post: jest.fn(),
          put: jest.fn(),
          patch: jest.fn(),
          delete: jest.fn(),
          request: jest.fn(),
        },
        axios: {
          post: jest.fn(),
          get: jest.fn(),
        } as unknown as PlatformContext["clients"]["axios"],
      },
    });
  });

  afterEach(() => {
    Object.assign(config, savedConfig);
    jest.restoreAllMocks();
  });

  describe("row 18: unexpected exception boundary", () => {
    it("catches unexpected errors, logs them, and returns a well-formed response", async () => {
      const request = makeRequest();
      setupSecrets();
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      (context.clients.platformHttp.patch as jest.Mock).mockImplementation(() => {
        throw new TypeError("something completely unexpected");
      });

      const result = await runWorker(context, request);

      expect(result).toHaveProperty("message");
      expect(typeof result.message).toBe("string");
      expect(result.message.length).toBeGreaterThan(0);
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe("row 1: folder event early exit", () => {
    it("returns immediately without reads, writes, or submissions", async () => {
      const request = makeFolderRequest();
      const result = await runWorker(context, request);

      expect(result).toHaveProperty("message");
      expect(result.message.toLowerCase()).toContain("folder");
      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
      expect(context.clients.platformHttp.post).not.toHaveBeenCalled();
      expect(context.clients.platformHttp.get).not.toHaveBeenCalled();
      expect(context.clients.axios.post).not.toHaveBeenCalled();
    });
  });

  describe("row 3: missing metadata or repoPath", () => {
    it("returns immediately when data.metadata is undefined", async () => {
      const request = makeRequest({ metadata: undefined });
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      const result = await runWorker(context, request);

      expect(result).toHaveProperty("message");
      expect(result.message).toMatch(/metadata|payload|identify/i);
      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
      expect(context.clients.axios.post).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();
    });

    it("returns immediately when metadata.repoPath is undefined", async () => {
      const request = makeRequest({
        metadata: {
          repoPath: undefined,
          contentLength: 0,
          lastModified: Date.now(),
          trustServerChecksums: false,
          servletContextUrl: "",
          skipJarIndexing: false,
          disableRedirect: false,
          repoType: RepoType.REPO_TYPE_LOCAL,
        },
      });
      const consoleSpy = jest.spyOn(console, "log").mockImplementation();

      const result = await runWorker(context, request);

      expect(result).toHaveProperty("message");
      expect(result.message).toMatch(/metadata|payload|identify/i);
      expect(context.clients.platformHttp.patch).not.toHaveBeenCalled();
      expect(context.clients.axios.post).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe("row 5: reset completeness (security-critical)", () => {
    it("nulls all eight hiddenlayer.* properties in one PATCH on overwrite", async () => {
      const request = makeRequest();
      setupSecrets();
      setupResetSuccess();

      await runWorker(context, request);

      const props = getResetProps();
      for (const prop of ALL_EIGHT_PROPERTIES) {
        expect(props).toHaveProperty([prop], null);
      }
      expect(Object.keys(props)).toHaveLength(ALL_EIGHT_PROPERTIES.length);
    });
  });

  describe("row 6: reset on artifact with no existing properties", () => {
    it("succeeds and the handler does not abort", async () => {
      const request = makeRequest();
      setupFullHappyPath();

      const result = await runWorker(context, request);

      expect(context.clients.platformHttp.patch).toHaveBeenCalled();
      expect(result.message).not.toMatch(/abort|reset failed/i);
    });
  });

  describe("row 7: reset returns 404 (item deleted)", () => {
    it("abandons quietly with no further calls and names the reason", async () => {
      const request = makeRequest();
      setupSecrets();
      (context.clients.platformHttp.patch as jest.Mock).mockRejectedValueOnce({ message: "Not Found", status: 404 });

      const result = await runWorker(context, request);

      expect(result.message).toMatch(/deleted|gone|404|no longer/i);
      expect(context.clients.platformHttp.patch).toHaveBeenCalledTimes(1);
      expect(context.clients.platformHttp.post).not.toHaveBeenCalled();
      expect(context.clients.axios.post).not.toHaveBeenCalled();
    });
  });

  describe("row 8: reset fails once, retry succeeds", () => {
    it("retries the reset and the handler does not abort", async () => {
      const request = makeRequest();
      setupSecrets();
      (context.clients.platformHttp.patch as jest.Mock)
        .mockRejectedValueOnce({ message: "Server Error", status: 500 })
        .mockResolvedValueOnce({ status: 204, headers: {}, data: null });
      setupTagSuccess();
      setupSignedUrl();
      setupTokenExchange();
      setupScanSubmission();
      setupRecordSuccess();

      const result = await runWorker(context, request);

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls.length).toBeGreaterThanOrEqual(2);
      expect(result.message).not.toMatch(/abort|reset failed/i);
    });
  });

  describe("row 9: reset fails twice, abort", () => {
    it("aborts after exactly 2 patch calls, names the failed step, and logs", async () => {
      const request = makeRequest();
      setupSecrets();
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();
      (context.clients.platformHttp.patch as jest.Mock)
        .mockRejectedValueOnce({ message: "Server Error", status: 500 })
        .mockRejectedValueOnce({ message: "Server Error", status: 500 });

      const result = await runWorker(context, request);

      expect(result.message).toMatch(/reset/i);
      expect(context.clients.platformHttp.patch).toHaveBeenCalledTimes(2);
      expect(context.clients.platformHttp.post).not.toHaveBeenCalled();
      expect(context.clients.axios.post).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  function setupTagSuccess(): void {
    (context.clients.platformHttp.patch as jest.Mock).mockResolvedValueOnce({ status: 204, headers: {}, data: null });
  }

  function setupSignedUrl(url = "https://example.jfrog.io/signed/abc"): void {
    (context.clients.platformHttp.post as jest.Mock).mockResolvedValueOnce({ status: 201, headers: {}, data: url });
  }

  function setupTokenExchange(token = "test-bearer-token"): void {
    (context.clients.axios.post as jest.Mock).mockResolvedValueOnce({
      data: { access_token: token },
    });
  }

  function setupScanSubmission(scanId = "scan-abc-123"): void {
    (context.clients.axios.post as jest.Mock).mockResolvedValueOnce({ data: { scan_id: scanId } });
  }

  function setupRecordSuccess(): void {
    (context.clients.platformHttp.patch as jest.Mock).mockResolvedValueOnce({ status: 204, headers: {}, data: null });
  }

  function setupFullHappyPath(): void {
    setupSecrets();
    setupResetSuccess();
    setupTagSuccess();
    setupSignedUrl();
    setupTokenExchange();
    setupScanSubmission();
    setupRecordSuccess();
  }

  describe("row 11: step-2 tag write fails", () => {
    it("aborts with no submission and artifact left propertyless", async () => {
      const request = makeRequest();
      setupSecrets();
      setupResetSuccess();
      (context.clients.platformHttp.patch as jest.Mock).mockRejectedValueOnce({ message: "Server Error", status: 500 });

      const result = await runWorker(context, request);

      expect(result.message).toMatch(/tag/i);
      expect(context.clients.platformHttp.post).not.toHaveBeenCalled();
      expect(context.clients.axios.post).not.toHaveBeenCalled();
    });
  });

  describe("row 12: signed-URL minting fails", () => {
    it("ends the invocation with artifact left PENDING, no scan_id", async () => {
      const request = makeRequest();
      setupSecrets();
      setupResetSuccess();
      setupTagSuccess();
      (context.clients.platformHttp.post as jest.Mock).mockRejectedValueOnce({ message: "Server Error", status: 500 });

      const result = await runWorker(context, request);

      expect(result.message).toMatch(/signed|url/i);
      expect(context.clients.axios.post).not.toHaveBeenCalled();
    });
  });

  describe("row 13: token exchange fails", () => {
    it("ends the invocation with artifact left PENDING, no scan_id", async () => {
      const request = makeRequest();
      setupSecrets();
      setupResetSuccess();
      setupTagSuccess();
      setupSignedUrl();
      (context.clients.axios.post as jest.Mock).mockRejectedValueOnce(new Error("auth failed"));

      const result = await runWorker(context, request);

      expect(result.message).toMatch(/token|exchange|auth/i);
      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls.length).toBe(2);
    });
  });

  describe("row 14: scan submission fails", () => {
    it("ends the invocation with artifact left PENDING, no scan_id", async () => {
      const request = makeRequest();
      setupSecrets();
      setupResetSuccess();
      setupTagSuccess();
      setupSignedUrl();
      setupTokenExchange();
      (context.clients.axios.post as jest.Mock).mockRejectedValueOnce(new Error("submission failed"));

      const result = await runWorker(context, request);

      expect(result.message).toMatch(/submit|scan/i);
      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls.length).toBe(2);
    });
  });

  describe("row 15: step-4 record write fails", () => {
    it("ends the invocation, artifact left PENDING with no scan_id, logged", async () => {
      const request = makeRequest();
      setupSecrets();
      setupResetSuccess();
      setupTagSuccess();
      setupSignedUrl();
      setupTokenExchange();
      setupScanSubmission();
      (context.clients.platformHttp.patch as jest.Mock).mockRejectedValueOnce({ message: "Server Error", status: 500 });
      const consoleSpy = jest.spyOn(console, "error").mockImplementation();

      const result = await runWorker(context, request);

      expect(result).toHaveProperty("message");
      expect(result.message).toMatch(/record/i);
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe("row 16: model name derivation", () => {
    it("nested path yields jfrog:<repo>/<dirs>:<file>", async () => {
      const request = makeRequest();
      setupFullHappyPath();

      await runWorker(context, request);

      const axiosCalls = (context.clients.axios.post as jest.Mock).mock.calls;
      const submitCall = axiosCalls.find((c: unknown[]) => typeof c[0] === "string" && c[0].includes("/scan/v3/jobs"));
      expect(submitCall).toBeDefined();
      const body = submitCall[1];
      expect(body.inventory.model_name).toBe("jfrog:models-local/teams/nlp/bert:config.json");
    });

    it("root-level path yields jfrog:<repo>:<file>", async () => {
      const request = makeRequest({
        metadata: {
          repoPath: {
            key: "models-local",
            path: "model.safetensors",
            id: "models-local:model.safetensors",
            isRoot: false,
            isFolder: false,
          },
          contentLength: 1024,
          lastModified: Date.now(),
          trustServerChecksums: false,
          servletContextUrl: "https://example.jfrog.io/artifactory",
          skipJarIndexing: false,
          disableRedirect: false,
          repoType: RepoType.REPO_TYPE_LOCAL,
        },
      });
      setupFullHappyPath();

      await runWorker(context, request);

      const axiosCalls = (context.clients.axios.post as jest.Mock).mock.calls;
      const submitCall = axiosCalls.find((c: unknown[]) => typeof c[0] === "string" && c[0].includes("/scan/v3/jobs"));
      expect(submitCall).toBeDefined();
      const body = submitCall[1];
      expect(body.inventory.model_name).toBe("jfrog:models-local:model.safetensors");
    });
  });

  describe("row 17: token exchange wire format", () => {
    it("POSTs to auth host with Basic auth and form-encoded body", async () => {
      const request = makeRequest();
      setupFullHappyPath();

      await runWorker(context, request);

      const axiosCalls = (context.clients.axios.post as jest.Mock).mock.calls;
      const tokenCall = axiosCalls.find((c: unknown[]) => typeof c[0] === "string" && c[0].includes("/oauth2/token"));
      expect(tokenCall).toBeDefined();

      const [url, body, options] = tokenCall;
      expect(url).toBe(`${config.hlAuthBaseUrl}/oauth2/token`);
      expect(url).not.toContain(config.hlApiBaseUrl);
      expect(body).toBe("grant_type=client_credentials");
      expect(options.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      const expectedCredentials = Buffer.from("test-client-id:test-client-secret").toString("base64");
      expect(options.headers.Authorization).toBe(`Basic ${expectedCredentials}`);
    });
  });

  describe("row 20: timestamps are ISO 8601 UTC", () => {
    it("writes scan_requested_at in ISO 8601 UTC format", async () => {
      const request = makeRequest();
      jest.spyOn(Date, "now").mockReturnValue(new Date("2025-06-15T12:00:00.000Z").getTime());
      setupFullHappyPath();

      await runWorker(context, request);

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      const tagCall = patchCalls.find((c: unknown[]) => {
        const props = (c as [string, { props: Record<string, unknown> }])[1]?.props;
        return props && "hiddenlayer.status" in props && props["hiddenlayer.status"] === "PENDING";
      });
      expect(tagCall).toBeDefined();
      const tagProps = tagCall[1].props;
      expect(tagProps["hiddenlayer.scan_requested_at"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
    });
  });

  describe("row 4: happy path end-to-end", () => {
    it("executes all four steps in order with correct call sequence", async () => {
      const request = makeRequest();
      setupFullHappyPath();

      const result = await runWorker(context, request);

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls.length).toBe(3);

      const resetProps = patchCalls[0][1].props;
      expect(Object.values(resetProps).every((v: unknown) => v === null)).toBe(true);

      const tagProps = patchCalls[1][1].props;
      expect(tagProps["hiddenlayer.status"]).toBe("PENDING");
      expect(tagProps).toHaveProperty(["hiddenlayer.scan_requested_at"]);

      const postCalls = (context.clients.platformHttp.post as jest.Mock).mock.calls;
      expect(postCalls.length).toBe(1);
      expect(postCalls[0][0]).toContain("/artifactory/api/signed/url");
      expect(postCalls[0][1].valid_for_secs).toBe(config.signedUrlTtlSecs);
      expect(postCalls[0][1].repo_path).toBe("models-local/teams/nlp/bert/config.json");

      const axiosCalls = (context.clients.axios.post as jest.Mock).mock.calls;
      expect(axiosCalls.length).toBe(2);

      const submitBody = axiosCalls[1][1];
      expect(submitBody.access.source).toBe("AWS_PRESIGNED");
      expect(submitBody.inventory.model_version).toBe("");
      expect(submitBody.inventory.requesting_entity).toBe("hiddenlayer-jfrog-worker");
      expect(submitBody.inventory.request_source).toBe("Integration");
      expect(submitBody.inventory.origin).toBe("JFrog Artifactory");
      expect(submitBody.inventory.scan_target.deep_scan.file_location).toBe("https://example.jfrog.io/signed/abc");
      expect(submitBody.inventory).not.toHaveProperty("requested_scan_location");

      const submitOptions = axiosCalls[1][2];
      expect(submitOptions.headers.Authorization).toBe("Bearer test-bearer-token");

      const recordProps = patchCalls[2][1].props;
      expect(recordProps["hiddenlayer.scan_id"]).toBe("scan-abc-123");
      expect(recordProps["hiddenlayer.model_name"]).toBe("jfrog:models-local/teams/nlp/bert:config.json");

      expect(result.message).toContain("scan-abc-123");
      expect(result.message).toContain("models-local");
    });
  });

  describe("row 2: overwrite runs the full sequence", () => {
    it("executes identically to a first upload", async () => {
      const request = makeRequest();
      setupFullHappyPath();

      const result = await runWorker(context, request);

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls.length).toBe(3);

      const resetProps = patchCalls[0][1].props;
      expect(Object.values(resetProps).every((v: unknown) => v === null)).toBe(true);

      expect(patchCalls[1][1].props["hiddenlayer.status"]).toBe("PENDING");
      expect(patchCalls[2][1].props["hiddenlayer.scan_id"]).toBeDefined();

      expect(result.message).toContain("scan-abc-123");
    });
  });

  describe("row 10 (complete): all writes use PATCH contract", () => {
    it("every property operation uses PATCH with atomicProperties=1", async () => {
      const request = makeRequest();
      setupFullHappyPath();

      await runWorker(context, request);

      const patchCalls = (context.clients.platformHttp.patch as jest.Mock).mock.calls;
      expect(patchCalls.length).toBe(3);
      for (const call of patchCalls) {
        const [url, body, headers] = call;
        expect(url).toContain("/artifactory/api/metadata/");
        expect(url).toContain("atomicProperties=1");
        expect(url).toContain("recursiveProperties=0");
        expect(body).toHaveProperty("props");
        expect(headers).toEqual(
          expect.objectContaining({
            "Content-Type": "application/json",
          }),
        );
      }
      expect(context.clients.platformHttp.put).not.toHaveBeenCalled();
    });
  });

  describe("row 19: every exit path returns a meaningful message", () => {
    it("success names the artifact and scan ID", async () => {
      const request = makeRequest();
      setupFullHappyPath();

      const result = await runWorker(context, request);

      expect(result.message).toContain("models-local");
      expect(result.message).toContain("scan-abc-123");
    });

    it("folder skip names folder", async () => {
      const request = makeFolderRequest();
      const result = await runWorker(context, request);

      expect(result.message.toLowerCase()).toContain("folder");
    });

    it("missing metadata names the reason", async () => {
      const request = makeRequest({ metadata: undefined });
      jest.spyOn(console, "log").mockImplementation();
      const result = await runWorker(context, request);

      expect(result.message).toMatch(/identify|metadata|payload/i);
    });

    it("reset abort names the step", async () => {
      const request = makeRequest();
      setupSecrets();
      jest.spyOn(console, "error").mockImplementation();
      (context.clients.platformHttp.patch as jest.Mock)
        .mockRejectedValueOnce({ message: "err", status: 500 })
        .mockRejectedValueOnce({ message: "err", status: 500 });

      const result = await runWorker(context, request);

      expect(result.message).toMatch(/reset/i);
    });

    it("tag failure names the step", async () => {
      const request = makeRequest();
      setupSecrets();
      setupResetSuccess();
      (context.clients.platformHttp.patch as jest.Mock).mockRejectedValueOnce({ message: "err", status: 500 });

      const result = await runWorker(context, request);

      expect(result.message).toMatch(/tag/i);
    });

    it("submission failure names the step", async () => {
      const request = makeRequest();
      setupSecrets();
      setupResetSuccess();
      setupTagSuccess();
      setupSignedUrl();
      setupTokenExchange();
      (context.clients.axios.post as jest.Mock).mockRejectedValueOnce(new Error("fail"));

      const result = await runWorker(context, request);

      expect(result.message).toMatch(/submit|scan/i);
    });
  });

  describe("row 10 (partial): reset uses correct PATCH contract", () => {
    it("uses PATCH with atomicProperties=1 and JSON props body", async () => {
      const request = makeRequest();
      setupSecrets();
      setupResetSuccess();

      await runWorker(context, request);

      const patchMock = context.clients.platformHttp.patch as jest.Mock;
      expect(patchMock).toHaveBeenCalled();
      const [url, body, headers] = patchMock.mock.calls[0];
      expect(url).toContain("/artifactory/api/metadata/");
      expect(url).toContain("atomicProperties=1");
      expect(url).toContain("recursiveProperties=0");
      expect(body).toHaveProperty("props");
      expect(headers).toEqual(
        expect.objectContaining({
          "Content-Type": "application/json",
        }),
      );
    });
  });
});
