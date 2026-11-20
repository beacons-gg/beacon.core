/**
 * transport.ts: the timed fetch, the `understands` declaration and the 5xx split, against an
 * injected `fetch`, since the platform one is exactly what the SDK does not import.
 */
import { formatUnderstands, UNDERSTANDS_HEADER } from "@beaconsgg/protocol-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  absentOrThrow,
  ApiError,
  fieldIssues,
  isFault,
  isRefusal,
  NetworkError,
  jsonOrRefuse,
  jsonOrThrow,
  on404,
  parseOrThrow,
  REQUEST_TIMEOUT_MS,
  RequestTimeoutError,
  ServerError,
  timedFetch,
  trimUrl,
  type WireFetch,
  type WireRequest,
  type WireResponse,
} from "../transport";
import { fetchReturning, LOCKED, platformReply, proxyNotFound, reply, sent } from "./fixtures";

/**
 * A `fetch` that never settles until its `AbortSignal` fires: a stalled mobile socket. Like a real
 * `fetch`, it rejects at once when handed a signal that has already fired.
 */
function hangingFetch(): WireFetch {
  return (_url: string, init: WireRequest) =>
    new Promise((_resolve, reject) => {
      if (init.signal?.aborted) reject(new Error("aborted"));
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
}

const POST: WireRequest = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
};

describe("trimUrl", () => {
  it("strips trailing slashes", () => {
    expect(trimUrl("http://srv///")).toBe("http://srv");
    expect(trimUrl("http://srv")).toBe("http://srv");
  });
});

describe("jsonOrThrow", () => {
  it("throws a retryable ServerError on a 5xx instead of parsing the error envelope", async () => {
    await expect(jsonOrThrow(reply({ statusCode: 503 }, 503))).rejects.toBeInstanceOf(ServerError);
  });

  it("hands a 4xx body back as the answer", async () => {
    await expect(jsonOrThrow(reply({ ok: false, error: "full" }, 409))).resolves.toEqual({
      ok: false,
      error: "full",
    });
  });

  it("hands the server's own 404 refusal back as the answer", async () => {
    const unknown = { ok: false, error: "unknownRoom" };
    await expect(jsonOrThrow(reply(unknown, 404))).resolves.toEqual(unknown);
    await expect(jsonOrThrow(platformReply(JSON.stringify(unknown), 404))).resolves.toEqual(
      unknown,
    );
  });

  it("throws a ServerError for a 404 the server did not send, such as a proxy's page", async () => {
    const res = proxyNotFound();
    const text = vi.spyOn(res, "text");
    await expect(jsonOrThrow(res)).rejects.toSatisfy(
      (err) => err instanceof ServerError && err.status === 404 && err.code === undefined,
    );
    expect(text).not.toHaveBeenCalled();
    // A framework's own 404 names its status in `error`, which is not a refusal.
    const framework = JSON.stringify({ statusCode: 404, error: "Not Found" });
    await expect(jsonOrThrow(platformReply(framework, 404))).rejects.toBeInstanceOf(ServerError);
    await expect(jsonOrThrow(reply({}, 404))).rejects.toBeInstanceOf(ServerError);
  });
});

// Discovery and `resolveRoom` decode with `jsonOrRefuse`: a refusal throws an `ApiError` with its
// code, so a proxy's 404 must stay a retryable `ServerError` and never read as a refused query.
describe("jsonOrRefuse", () => {
  it("throws a ServerError for a proxy's 404, as discovery does during a restart", async () => {
    const res = proxyNotFound();
    const text = vi.spyOn(res, "text");
    await expect(jsonOrRefuse(res)).rejects.toSatisfy(
      (err) => err instanceof ServerError && err.status === 404 && err.code === undefined,
    );
    expect(text).not.toHaveBeenCalled();
    const framework = JSON.stringify({ statusCode: 404, error: "Not Found" });
    await expect(jsonOrRefuse(platformReply(framework, 404))).rejects.toBeInstanceOf(ServerError);
  });

  it("throws the server's own 404 refusal as an ApiError with its code", async () => {
    const unknownRoute = { ok: false, error: "unknownRoute", message: "no such route" };
    const refused = jsonOrRefuse(platformReply(JSON.stringify(unknownRoute), 404));
    await expect(refused).rejects.not.toBeInstanceOf(ServerError);
    await expect(refused).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      code: "unknownRoute",
      message: "no such route",
    });
  });

  it("throws another 4xx as an ApiError, a 5xx as a ServerError, and returns a 2xx body", async () => {
    await expect(jsonOrRefuse(reply({ ok: false, error: "invalid" }, 400))).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      code: "invalid",
    });
    await expect(jsonOrRefuse(reply({}, 503))).rejects.toBeInstanceOf(ServerError);
    await expect(jsonOrRefuse(reply({ rooms: [] }))).resolves.toEqual({ rooms: [] });
  });
});

describe("the understands declaration", () => {
  it("adds it to a write and keeps the caller's own headers", async () => {
    const fetch = fetchReturning({});
    await timedFetch({ fetch, timeoutMs: REQUEST_TIMEOUT_MS, understands: ["code:clockSkew"] })(
      "http://srv/x",
      POST,
    );
    expect(sent(fetch).init.headers).toEqual({
      "content-type": "application/json",
      [UNDERSTANDS_HEADER]: formatUnderstands(["code:clockSkew"]),
    });
  });

  it("sends an empty declaration when the build declares nothing, which is still a declaration", async () => {
    const fetch = fetchReturning({});
    await timedFetch({ fetch, timeoutMs: REQUEST_TIMEOUT_MS, understands: [] })(
      "http://srv/x",
      POST,
    );
    expect(sent(fetch).init.headers).toHaveProperty(UNDERSTANDS_HEADER, formatUnderstands([]));
  });

  it("leaves a GET alone, so a browser pays no CORS preflight for it", async () => {
    const fetch = fetchReturning({});
    await timedFetch({ fetch, timeoutMs: REQUEST_TIMEOUT_MS, understands: ["code:clockSkew"] })(
      "http://srv/x",
    );
    expect(sent(fetch).init.headers).toBeUndefined();
  });

  it("sends no header at all when the client configured none", async () => {
    const fetch = fetchReturning({});
    await timedFetch({ fetch, timeoutMs: REQUEST_TIMEOUT_MS, understands: undefined })(
      "http://srv/x",
      POST,
    );
    expect(sent(fetch).init.headers).toStrictEqual({ "content-type": "application/json" });
  });
});

describe("the timeout", () => {
  afterEach(() => vi.useRealTimers());

  it("rejects a hung request with a typed RequestTimeoutError", async () => {
    vi.useFakeTimers();
    const request = timedFetch({ fetch: hangingFetch(), timeoutMs: 1000, understands: undefined });
    const settled = expect(request("http://srv/x")).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(1001);
    await settled;
  });

  it("takes a per-call timeout over the configured one", async () => {
    vi.useFakeTimers();
    const request = timedFetch({
      fetch: hangingFetch(),
      timeoutMs: 60_000,
      understands: undefined,
    });
    const settled = expect(request("http://srv/x", {}, 50)).rejects.toThrow(
      "request timed out after 50ms",
    );
    await vi.advanceTimersByTimeAsync(51);
    await settled;
  });

  it("passes a caller's own abort through as-is, not as a timeout", async () => {
    const request = timedFetch({
      fetch: hangingFetch(),
      timeoutMs: 60_000,
      understands: undefined,
    });
    const external = new AbortController();
    const p = request("http://srv/x", { signal: external.signal });
    external.abort();
    await expect(p).rejects.toThrow("aborted");
    await expect(p).rejects.not.toBeInstanceOf(RequestTimeoutError);
    const err = await p.catch((e: unknown) => e);
    // The caller's own cancellation is neither the server's answer nor its fault.
    expect(isFault(err)).toBe(false);
    expect(isRefusal(err)).toBe(false);
  });

  it("aborts at once for a signal that was already aborted", async () => {
    const request = timedFetch({
      fetch: hangingFetch(),
      timeoutMs: 60_000,
      understands: undefined,
    });
    const external = new AbortController();
    external.abort();
    await expect(request("http://srv/x", { signal: external.signal })).rejects.toThrow("aborted");
  });

  it("wraps any other network failure in a NetworkError with the platform's error as cause", async () => {
    const cause = new TypeError("Network request failed");
    const fetch = vi.fn<WireFetch>().mockRejectedValue(cause);
    for (const timeoutMs of [60_000, null]) {
      const request = timedFetch({ fetch, timeoutMs, understands: undefined });
      const err = await request("http://srv/x").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(NetworkError);
      expect(err).toMatchObject({
        cause,
        message: expect.stringContaining("Network request failed"),
      });
      expect(isFault(err)).toBe(true);
    }
  });

  it("wraps a fetch that throws at once, with no timeout too", async () => {
    const fetch: WireFetch = () => {
      throw new TypeError("Illegal invocation");
    };
    const request = timedFetch({ fetch, timeoutMs: null, understands: undefined });
    await expect(request("http://srv/x")).rejects.toBeInstanceOf(NetworkError);
  });

  it("passes a caller's abort through as-is with no timeout too", async () => {
    const external = new AbortController();
    const fetch = vi.fn<WireFetch>(() => {
      external.abort();
      return Promise.reject(new Error("aborted"));
    });
    const request = timedFetch({ fetch, timeoutMs: null, understands: undefined });
    const err = await request("http://srv/x", { signal: external.signal }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(NetworkError);
  });
});

describe("a refusal or a fault", () => {
  it("is a refusal only for an ApiError with the server's code", () => {
    expect(isRefusal(new ApiError(429, "slow down", "rateLimited"))).toBe(true);
    expect(isRefusal(new ApiError(503, "locked", "writeLocked", 60))).toBe(true);
    // A ServerError carries a code from a 5xx body and is still a fault.
    expect(isRefusal(new ServerError(500, "internal"))).toBe(false);
    expect(isRefusal(new ApiError(404, "no route"))).toBe(false);
    expect(isRefusal(new Error("x"))).toBe(false);
    expect(isRefusal("rateLimited")).toBe(false);
  });

  it("is a fault for a ServerError, a timeout and a lost connection", () => {
    expect(isFault(new ServerError(404))).toBe(true);
    expect(isFault(new RequestTimeoutError("http://srv/x", 10))).toBe(true);
    expect(isFault(new NetworkError("http://srv/x", new TypeError("x")))).toBe(true);
    expect(isFault(new ApiError(429, "slow down", "rateLimited"))).toBe(false);
    expect(isFault(new TypeError("discoverCells: ask for something"))).toBe(false);
  });

  it("gives every reply outside 2xx exactly one of the two", async () => {
    const replies: WireResponse[] = [
      reply({ ok: false, error: "full" }, 409),
      reply({ statusCode: 413, message: "request entity too large" }, 413),
      reply("<html>blocked</html>", 403),
      reply({ ok: false, error: "unknownRoom" }, 404),
      proxyNotFound(),
      reply({ ok: false, error: "internal" }, 500),
      reply(LOCKED, 503),
    ];
    for (const res of replies) {
      const err = await parseOrThrow(res).catch((e: unknown) => e);
      expect(isRefusal(err) !== isFault(err), `${res.status}`).toBe(true);
    }
  });
});

describe("absentOrThrow", () => {
  it("gives null only for the server's own 404 with the code asked for", async () => {
    await expect(
      absentOrThrow(reply({ ok: false, error: "unknownRoom" }, 404), "unknownRoom"),
    ).resolves.toBeNull();
    const other = await absentOrThrow(
      reply({ ok: false, error: "unknownRoute" }, 404),
      "unknownRoom",
    ).catch((e: unknown) => e);
    expect(isRefusal(other)).toBe(true);
    expect(other).toMatchObject({ status: 404, code: "unknownRoute" });
    const page = await absentOrThrow(proxyNotFound(), "unknownRoom").catch((e: unknown) => e);
    expect(page).toMatchObject({ name: "ServerError", status: 404 });
    const limited = await absentOrThrow(
      reply({ ok: false, error: "rateLimited" }, 429),
      "unknownRoom",
    ).catch((e: unknown) => e);
    expect(limited).toMatchObject({ name: "ApiError", code: "rateLimited" });
  });
});

describe("the throwing decoder", () => {
  it("ServerError is an ApiError, so a caller catching one catches both", () => {
    const err = new ServerError(503);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(503);
    expect(err.name).toBe("ServerError");
  });

  it("parseOrThrow returns a 2xx body and throws the wire message of a refusal", async () => {
    await expect(parseOrThrow(reply({ ok: true }))).resolves.toEqual({ ok: true });
    const refusal = { ok: false, error: "denied", message: "not an admin" };
    await expect(parseOrThrow(reply(refusal, 403))).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      message: "not an admin",
    });
  });

  it.each([
    ["gameNotAdmitted", 403],
    ["writeLocked", 503],
  ])(
    "parseOrThrow carries the refusal code %s, so a caller need not read the message",
    async (code, status) => {
      const refused = { ok: false, error: code, message: "refused" };
      await expect(parseOrThrow(reply(refused, status))).rejects.toMatchObject({
        status,
        code,
        message: "refused",
      });
    },
  );

  it("parseOrThrow gives no code for a body that is not a refusal", async () => {
    const codeOf = (res: WireResponse) =>
      parseOrThrow(res).catch((err: unknown) => (err as ApiError).code);
    // A framework's reply names its status in `error`, which is not a refusal code.
    await expect(codeOf(reply({ statusCode: 404, error: "Not Found" }, 404))).resolves.toBe(
      undefined,
    );
    await expect(codeOf(reply({ error: 7, ok: false }, 400))).resolves.toBe(undefined);
    await expect(codeOf(reply("denied", 403))).resolves.toBe(undefined);
    const notJson = { ok: false, status: 502, json: () => Promise.reject(new Error("html")) };
    await expect(codeOf(notJson)).resolves.toBe(undefined);
  });

  it("parseOrThrow says HTTP <status> for a refusal with no message", async () => {
    await expect(parseOrThrow(reply({ ok: false, error: "x" }, 400))).rejects.toThrow("HTTP 400");
  });

  it("parseOrThrow throws a fault for a reply with no refusal, 4xx or 5xx", async () => {
    for (const res of [
      reply({ message: "denied" }, 403),
      reply({}, 404),
      { ok: false, status: 502, json: () => Promise.reject(new Error("html")) },
    ]) {
      const err = await parseOrThrow(res).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ServerError);
      expect(err).toMatchObject({ status: res.status, message: `server error ${res.status}` });
    }
  });

  it("on404 turns a 404 into the fallback and rethrows everything else", () => {
    expect(on404("fallback")(new ApiError(404, "gone"))).toBe("fallback");
    expect(() => on404(null)(new ApiError(500, "boom"))).toThrow("boom");
    expect(() => on404(null)(new Error("network"))).toThrow("network");
  });

  describe("fieldIssues", () => {
    const zod400 = (issues: unknown) => new ApiError(400, JSON.stringify(issues));

    it("puts each refusal on the row that earned it", () => {
      const err = zod400([
        { code: "custom", path: ["admins"], message: "deploy-time: set BEACON_ADMINS" },
        { code: "too_small", path: ["mailboxTtlSeconds"], message: "must be greater than 0" },
      ]);
      expect(fieldIssues(err)).toEqual([
        { key: "admins", path: "", message: "deploy-time: set BEACON_ADMINS" },
        { key: "mailboxTtlSeconds", path: "", message: "must be greater than 0" },
      ]);
    });

    it("keeps the rest of the path, so a bad list element says which one", () => {
      expect(fieldIssues(zod400([{ path: ["tags", 2, "name"], message: "too long" }]))).toEqual([
        { key: "tags", path: "2.name", message: "too long" },
      ]);
    });

    it("declines anything that is not that shape", () => {
      // A well-formed issue array under another status: only a 400 is a refusal about the body.
      expect(
        fieldIssues(new ApiError(403, JSON.stringify([{ path: ["name"], message: "nope" }]))),
      ).toBeUndefined();
      expect(fieldIssues(new Error("x"))).toBeUndefined();
      expect(fieldIssues(new ApiError(400, "not json"))).toBeUndefined();
      expect(fieldIssues(zod400([]))).toBeUndefined();
      expect(fieldIssues(zod400(["x"]))).toBeUndefined();
      expect(fieldIssues(zod400([{ path: [], message: "m" }]))).toBeUndefined();
      expect(fieldIssues(zod400([{ message: "no path" }]))).toBeUndefined();
    });
  });
});

describe("no timeout", () => {
  it("hands the request over as given, with no signal and no timer", async () => {
    const fetch = fetchReturning({});
    await timedFetch({ fetch, timeoutMs: null, understands: undefined })("http://srv/x", POST);
    expect(sent(fetch).init).toStrictEqual(POST);
  });

  it("still declares on a write", async () => {
    const fetch = fetchReturning({});
    await timedFetch({ fetch, timeoutMs: null, understands: [] })("http://srv/x", POST);
    expect(sent(fetch).init.headers).toHaveProperty(UNDERSTANDS_HEADER);
  });
});

describe("the body of a 5xx", () => {
  afterEach(() => vi.useRealTimers());

  /** A 5xx whose headers arrive and whose body never does, until the request is aborted. */
  function stalledBody(init: WireRequest, headers: Record<string, string>): WireResponse {
    return {
      ok: false,
      status: 503,
      headers: new Headers(headers),
      json: () => Promise.reject(new Error("not read this way")),
      text: () =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
  }

  it("throws a lock as a refusal with its code and Retry-After, from both decoders", async () => {
    for (const decode of [jsonOrThrow, parseOrThrow]) {
      const err = await decode(
        platformReply(JSON.stringify(LOCKED), 503, { "retry-after": "60" }),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).not.toBeInstanceOf(ServerError);
      expect(err).toMatchObject({ status: 503, code: "writeLocked", retryAfterSec: 60 });
      expect((err as ApiError).message).toBe("the server is locked");
    }
  });

  it("gives a ServerError the code and Retry-After of any other 5xx", async () => {
    const body = JSON.stringify({ ok: false, error: "upstreamUnavailable" });
    const err = await jsonOrThrow(platformReply(body, 503, { "retry-after": "5" })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServerError);
    expect(err).toMatchObject({ status: 503, code: "upstreamUnavailable", retryAfterSec: 5 });
    // The message stays the status line: callers and the flows driver match on it.
    expect((err as ServerError).message).toBe("server error 503");
  });

  it("reads a JSON type with a suffix, such as a problem document", async () => {
    const res = platformReply(JSON.stringify(LOCKED), 503, {
      "content-type": "application/problem+json",
    });
    await expect(jsonOrThrow(res)).rejects.toMatchObject({ code: "writeLocked" });
  });

  it("reads a charset on the content type, and no Retry-After that is a date", async () => {
    const res = platformReply(JSON.stringify(LOCKED), 503, {
      "content-type": "application/json; charset=utf-8",
      "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT",
    });
    await expect(jsonOrThrow(res)).rejects.toMatchObject({
      code: "writeLocked",
      retryAfterSec: undefined,
    });
  });

  it("does not read a body that is not JSON, such as a proxy's page", async () => {
    const res = platformReply("<html>bad gateway</html>", 502, { "content-type": "text/html" });
    const text = vi.spyOn(res, "text");
    await expect(jsonOrThrow(res)).rejects.toMatchObject({ status: 502, code: undefined });
    expect(text).not.toHaveBeenCalled();
  });

  it("skips a body declared over 4 KiB, and releases the request", async () => {
    let signal: AbortSignal | undefined;
    const text = vi.fn(() => Promise.resolve(JSON.stringify(LOCKED)));
    const fetch: WireFetch = (_url, init) => {
      signal = init.signal;
      return Promise.resolve({
        ok: false,
        status: 503,
        headers: new Headers({ "content-type": "application/json", "content-length": "4097" }),
        json: () => Promise.reject(new Error("not read this way")),
        text,
      });
    };
    const request = timedFetch({ fetch, timeoutMs: 1000, understands: undefined });
    await expect(jsonOrThrow(await request("http://srv/x"))).rejects.toMatchObject({
      code: undefined,
    });
    expect(text).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
  });

  it("releases the request when it skips a body that is not JSON, such as a proxy's 404", async () => {
    let signal: AbortSignal | undefined;
    const fetch: WireFetch = (_url, init) => {
      signal = init.signal;
      return Promise.resolve(proxyNotFound());
    };
    const request = timedFetch({ fetch, timeoutMs: 1000, understands: undefined });
    await expect(jsonOrThrow(await request("http://srv/x"))).rejects.toBeInstanceOf(ServerError);
    expect(signal?.aborted).toBe(true);
  });

  it("gives no code for a body that says JSON and is not", async () => {
    await expect(jsonOrThrow(platformReply("{not json", 503))).rejects.toMatchObject({
      code: undefined,
    });
  });

  it("does not parse a body over 4 KiB that declared no length", async () => {
    const huge = JSON.stringify({ ...LOCKED, message: "x".repeat(5000) });
    await expect(jsonOrThrow(platformReply(huge, 503))).rejects.toMatchObject({ code: undefined });
  });

  it("gives up on a body that stalls after 2 seconds, and aborts the request", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch: WireFetch = (_url, init) => {
      signal = init.signal;
      return Promise.resolve(stalledBody(init, { "content-type": "application/json" }));
    };
    const request = timedFetch({ fetch, timeoutMs: 1000, understands: undefined });
    const thrown = jsonOrThrow(await request("http://srv/x")).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(thrown).resolves.toMatchObject({ status: 503, code: undefined });
    expect(signal?.aborted).toBe(true);
  });

  it("bounds the body of any other 4xx too, so a stalled CDN page cannot hang a call", async () => {
    vi.useFakeTimers();
    const fetch: WireFetch = (_url, init) =>
      Promise.resolve({
        ...stalledBody(init, { "content-type": "application/json" }),
        status: 429,
      });
    const request = timedFetch({ fetch, timeoutMs: 1000, understands: undefined });
    const thrown = parseOrThrow(await request("http://srv/x")).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(thrown).resolves.toMatchObject({ name: "ServerError", status: 429 });
  });

  it("reads a 4xx refusal of up to 64 KiB, such as a long validation message", async () => {
    const long = { ok: false, error: "invalid", message: "x".repeat(10_000) };
    await expect(parseOrThrow(platformReply(JSON.stringify(long), 400))).rejects.toMatchObject({
      name: "ApiError",
      code: "invalid",
    });
    const huge = { ...long, message: "x".repeat(70_000) };
    await expect(parseOrThrow(platformReply(JSON.stringify(huge), 400))).rejects.toMatchObject({
      name: "ServerError",
      status: 400,
    });
  });

  it("still stops waiting for a stalled body on a request with no timeout", async () => {
    vi.useFakeTimers();
    const fetch: WireFetch = (_url, init) =>
      Promise.resolve(stalledBody(init, { "content-type": "application/json" }));
    const request = timedFetch({ fetch, timeoutMs: null, understands: undefined });
    const thrown = jsonOrThrow(await request("http://srv/x")).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(thrown).resolves.toBeInstanceOf(ServerError);
  });

  it("reads the body with json() for a custom fetch whose reply has no headers or text", async () => {
    const json = vi.fn(() => Promise.resolve(LOCKED));
    const err = await jsonOrThrow({ ok: false, status: 503, json }).catch((e: unknown) => e);
    expect(isRefusal(err)).toBe(true);
    expect(err).toMatchObject({ code: "writeLocked", retryAfterSec: undefined });
    const down = await jsonOrThrow({
      ok: false,
      status: 500,
      json: () => Promise.resolve({}),
    }).catch((e: unknown) => e);
    expect(down).toMatchObject({ name: "ServerError", code: undefined });
  });

  it("parseOrThrow reads a 5xx under the same limits and keeps the server's message", async () => {
    await expect(parseOrThrow(platformReply(JSON.stringify(LOCKED), 503))).rejects.toMatchObject({
      status: 503,
      code: "writeLocked",
      message: "the server is locked",
    });
    // A body past the limit is not read, so nothing says the server is locked: a fault.
    const huge = JSON.stringify({ ...LOCKED, message: "x".repeat(5000) });
    await expect(parseOrThrow(platformReply(huge, 503))).rejects.toMatchObject({
      name: "ServerError",
      code: undefined,
      message: "server error 503",
    });
  });
});
