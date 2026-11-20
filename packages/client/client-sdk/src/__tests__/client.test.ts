/**
 * client.ts: the signed writes, the platform reads and the game slug, against an injected
 * `fetch` and clock. What an app configures is tested with the app; this suite holds the SDK's own
 * contract, including the two things only a second consumer would notice: nothing is attached when
 * no game is configured, and the injected clock is the one read.
 */
import {
  buildProfile,
  createAccount,
  createWallet,
  signUtf8,
  verifyOp,
  verifyProfile,
} from "@beaconsgg/identity";
import {
  canonicalJson,
  opEnvelopeSchema,
  type OpEnvelope,
  type PlaceParams,
  UNDERSTANDS_HEADER,
} from "@beaconsgg/protocol-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../client";
import {
  ApiError,
  isFault,
  isRefusal,
  NetworkError,
  REQUEST_TIMEOUT_MS,
  ServerError,
  type WireFetch,
  type WireRequest,
  type WireResponse,
} from "../transport";
import {
  fetchPlatformReply,
  fetchProxyNotFound,
  fetchReturning,
  LOCKED,
  platformReply,
  otherSignedDescriptor,
  reply,
  signDescriptorFor,
  sent,
  signedTestDescriptor,
} from "./fixtures";

const wallet = createWallet();
const SRV = "http://srv";
const N1 = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PINNED = "01ARZ3NDEKTSV4RRFFQ69G5FBW";

/** The envelope POSTed on the `call`th request, checked against the wire schema. */
function envelope(fetch: ReturnType<typeof fetchReturning>, call = 0): OpEnvelope {
  return opEnvelopeSchema.parse(JSON.parse(sent(fetch, call).init.body ?? ""));
}

describe("signed writes", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sendOp signs the op for the room with the given nonce and posts to /rooms/:id/ops", async () => {
    const fetch = fetchReturning({ ok: true, version: 2 });
    const res = await createClient({ fetch }).sendOp(
      `${SRV}/`,
      wallet,
      "r1@srv",
      "add",
      { n: 1 },
      N1,
    );
    expect(res).toEqual({ ok: true, version: 2 });
    expect(sent(fetch).url).toBe(`${SRV}/rooms/r1%40srv/ops`);
    const env = envelope(fetch);
    expect(env).toMatchObject({ op: "add", room: "r1@srv", nonce: N1, params: { n: 1 } });
    expect(verifyOp(env).ok).toBe(true);
  });

  it("sendOpWithRetry retries a transport failure with the SAME nonce", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<WireFetch>()
      .mockRejectedValueOnce(new Error("lost reply"))
      .mockResolvedValueOnce(reply({}, 502))
      .mockResolvedValue(reply({ ok: true, version: 7 }));
    const res = createClient({ fetch }).sendOpWithRetry(SRV, wallet, "r1@srv", "take", {});
    await vi.runAllTimersAsync();
    await expect(res).resolves.toEqual({ ok: true, version: 7 });
    const nonces = fetch.mock.calls.map(
      ([, init]) => (JSON.parse(init.body ?? "") as { nonce: string }).nonce,
    );
    expect(new Set(nonces).size).toBe(1);
    expect(nonces).toHaveLength(3);
  });

  describe("after a timeout", () => {
    afterEach(() => vi.useRealTimers());

    it("sendOpWithRetry recovers a timed-out op by retrying with the SAME nonce", async () => {
      vi.useFakeTimers();
      const nonces: string[] = [];
      const fetch = vi.fn<WireFetch>((_url: string, init: WireRequest) => {
        nonces.push((JSON.parse(init.body ?? "") as { nonce: string }).nonce);
        if (nonces.length === 1) {
          // The first attempt hangs until the timeout aborts it.
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return Promise.resolve(reply({ ok: true, version: 7 })); // the server replays the result
      });
      const res = createClient({ fetch }).sendOpWithRetry(SRV, wallet, "r1@srv", "take", {});
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
      await vi.runAllTimersAsync(); // the wait before the second attempt
      await expect(res).resolves.toEqual({ ok: true, version: 7 });
      expect(nonces).toHaveLength(2);
      expect(nonces[0]).toBe(nonces[1]);
    });
  });

  it("sendOpWithRetry returns a real answer, even a refusal, without retrying", async () => {
    const fetch = fetchReturning({ ok: false, error: "full" }, 409);
    await expect(
      createClient({ fetch }).sendOpWithRetry(SRV, wallet, "r1@srv", "add", {}),
    ).resolves.toEqual({
      ok: false,
      error: "full",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sendOpWithRetry rethrows once every attempt has failed", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<WireFetch>().mockRejectedValue(new Error("down"));
    const res = createClient({ fetch })
      .sendOpWithRetry(SRV, wallet, "r1@srv", "add", {}, 2)
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = await res;
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).toMatchObject({ cause: new Error("down") });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sendOpWithRetry retries a fault: a proxy's page, or a 2xx body that is not JSON", async () => {
    const page = vi.fn<WireFetch>().mockResolvedValue(platformReply("<h1>Not Found</h1>", 404));
    const retried = await createClient({ fetch: page })
      .sendOpWithRetry(SRV, wallet, "r1@srv", "add", {}, { delayMs: 0 })
      .catch((e: unknown) => e);
    expect(isFault(retried)).toBe(true);
    expect(page).toHaveBeenCalledTimes(3);
    const notJson = vi.fn<WireFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError("Unexpected token <")),
    });
    // A captive portal answers 200 with its own page: no answer from the server, so a fault.
    const portal = await createClient({ fetch: notJson })
      .sendOpWithRetry(SRV, wallet, "r1@srv", "add", {}, { delayMs: 0 })
      .catch((e: unknown) => e);
    expect(portal).toMatchObject({ name: "ServerError", status: 200 });
    expect(notJson).toHaveBeenCalledTimes(3);
  });

  it("resolveRoom throws a fault for a 2xx body that is no room object, and never reads it as null", async () => {
    // A JSON `null` read as `unknownRoom` before, and a caller may delete a saved room on that.
    for (const body of [null, [], "room", 7]) {
      const err = await createClient({ fetch: fetchReturning(body) })
        .resolveRoom(SRV, "r@srv")
        .catch((e: unknown) => e);
      expect(err, JSON.stringify(body)).toMatchObject({ name: "ServerError", status: 200 });
    }
    // Anything else is handed back as received, a field a newer server adds included.
    const room = { id: "r@srv", type: "jar", addedLater: true };
    await expect(
      createClient({ fetch: fetchReturning(room) }).resolveRoom(SRV, "r@srv"),
    ).resolves.toEqual(room);
  });

  it("resolveRoom and the location reads throw a fault for a 2xx body that is not JSON", async () => {
    const notJson = vi
      .fn<WireFetch>()
      .mockResolvedValue(platformReply("<html>wifi login</html>", 200));
    const client = createClient({ fetch: notJson });
    for (const read of [
      () => client.resolveRoom(SRV, "r@srv"),
      () => client.getGeocode(SRV, "9q8yy"),
    ])
      expect(isFault(await read().catch((e: unknown) => e))).toBe(true);
  });

  it("sendOpWithRetry waits about 0.5 s and then 1.5 s between attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter: the base waits exactly
    const fetch = vi.fn<WireFetch>().mockResolvedValue(reply({}, 500));
    const res = createClient({ fetch })
      .sendOpWithRetry(SRV, wallet, "r1@srv", "add", {})
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1499);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(res).resolves.toBeInstanceOf(ServerError);
  });

  it("sendOpWithRetry jitters each wait by up to a quarter either way", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random");
    const fetch = vi.fn<WireFetch>().mockResolvedValue(reply({}, 500));
    const client = createClient({ fetch });
    for (const [r, wait] of [
      [0, 375],
      [0.98, 620],
    ] as const) {
      random.mockReturnValue(r);
      fetch.mockClear();
      const res = client.sendOpWithRetry(SRV, wallet, "r1@srv", "add", {}, 2).catch(() => null);
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      await res;
    }
  });

  it("sendOpWithRetry caps a wait at 5 s on a long run of attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetch = vi.fn<WireFetch>().mockResolvedValue(reply({}, 500));
    const res = createClient({ fetch })
      .sendOpWithRetry(SRV, wallet, "r1@srv", "add", {}, 5)
      .catch(() => null);
    // 500, 1500, 4500, then 5000 rather than 13500.
    await vi.advanceTimersByTimeAsync(500 + 1500 + 4500 + 4999);
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(5);
    await res;
  });

  it("sendOpWithRetry takes its attempts and first wait as options", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fetch = vi.fn<WireFetch>().mockResolvedValue(reply({}, 500));
    const res = createClient({ fetch })
      .sendOpWithRetry(SRV, wallet, "r1@srv", "add", {}, { attempts: 4, delayMs: 100 })
      .catch(() => null);
    // 100, 300, then 900 capped at 10 times the first wait, 1000.
    await vi.advanceTimersByTimeAsync(100 + 300 + 899);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(4);
    await res;
  });

  it("sendOpWithRetry retries at once with delayMs 0, and keeps 3 attempts by default", async () => {
    const fetch = vi.fn<WireFetch>().mockResolvedValue(reply({}, 500));
    await expect(
      createClient({ fetch }).sendOpWithRetry(SRV, wallet, "r1@srv", "add", {}, { delayMs: 0 }),
    ).rejects.toBeInstanceOf(ServerError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("sendOpWithRetry throws writeLocked at once, with the server's Retry-After", async () => {
    const locked = platformReply(JSON.stringify(LOCKED), 503, { "retry-after": "60" });
    const fetch = vi.fn<WireFetch>().mockResolvedValue(locked);
    const err = await createClient({ fetch })
      .sendOpWithRetry(SRV, wallet, "r1@srv", "add", {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(isRefusal(err)).toBe(true);
    expect(err).toMatchObject({ status: 503, code: "writeLocked", retryAfterSec: 60 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sendOpWithRetry wraps a non-Error failure in a NetworkError", async () => {
    const fetch = vi.fn<WireFetch>().mockRejectedValue("not an error");
    const err = await createClient({ fetch })
      .sendOpWithRetry(SRV, wallet, "r1@srv", "add", {}, 1)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).toMatchObject({ cause: "not an error" });
  });

  it("sendOpWithRetry throws without sending when asked for no attempts", async () => {
    const fetch = fetchReturning({ ok: true });
    await expect(
      createClient({ fetch }).sendOpWithRetry(SRV, wallet, "r1@srv", "add", {}, 0),
    ).rejects.toThrow("exhausted attempts");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("placeRoom signs a `place` op with the params as given and posts to /rooms", async () => {
    const fetch = fetchReturning({ ok: true, id: "u@srv" });
    const params = {
      type: "widget",
      unique: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      mintedBy: { minter: wallet.account.did, sig: "x" },
      location: { lat: 1, lng: 2 },
      policy: {},
    } as unknown as PlaceParams;
    await createClient({ fetch }).placeRoom(SRV, wallet, params);
    expect(sent(fetch).url).toBe(`${SRV}/rooms`);
    expect(envelope(fetch)).toMatchObject({ op: "place", params });
  });

  it("reportScout stamps the expiry from the injected clock, and cancelScout tombstones", async () => {
    const fetch = fetchReturning({ ok: true });
    const client = createClient({ fetch, now: () => Date.UTC(2026, 0, 1) });
    const scout = {
      unique: "s1",
      config: { type: "scout" },
      mintedBy: { minter: wallet.account.did, sig: "x" },
      movement: { from: { lat: 0, lng: 0 } },
    } as unknown as Parameters<typeof client.reportScout>[2];
    await client.reportScout(SRV, wallet, { ...scout, name: "Kite", ttlSec: 60 });
    await client.reportScout(SRV, wallet, scout);
    await client.cancelScout(SRV, wallet, "s1");
    expect(sent(fetch).url).toBe(`${SRV}/scouts`);
    expect(envelope(fetch, 0)).toMatchObject({
      op: "report",
      params: { name: "Kite", expiresAt: "2026-01-01T00:01:00.000Z" },
    });
    expect(envelope(fetch, 1).params).toMatchObject({ expiresAt: "2026-01-01T00:05:00.000Z" });
    expect(envelope(fetch, 1).params).not.toHaveProperty("name");
    expect(envelope(fetch, 2)).toMatchObject({ op: "cancel", params: { unique: "s1" } });
  });

  it("putMedia sends the signed attestation beside the bytes", async () => {
    const fetch = fetchReturning({ ok: true, id: "h@srv" });
    await createClient({ fetch }).putMedia(SRV, wallet, {
      hash: "h",
      type: "image/webp",
      size: 3,
      base64: "AAAA",
    });
    const body = JSON.parse(sent(fetch).init.body ?? "") as { env: OpEnvelope; data: string };
    expect(sent(fetch).url).toBe(`${SRV}/media`);
    expect(body.data).toBe("AAAA");
    expect(body.env).toMatchObject({
      op: "media.put",
      params: { hash: "h", type: "image/webp", size: 3 },
    });
    expect(verifyOp(body.env).ok).toBe(true);
  });

  it("proposePlace pins a caller's nonce; fetchMyProposals signs a fresh one", async () => {
    const fetch = fetchReturning({ ok: true });
    const client = createClient({ fetch });
    await client.proposePlace(SRV, wallet, { name: "Park" } as never, PINNED);
    await client.proposePlace(SRV, wallet, { name: "Park" } as never);
    await client.fetchMyProposals(SRV, wallet);
    expect(sent(fetch, 0).url).toBe(`${SRV}/places/propose`);
    expect(envelope(fetch, 0)).toMatchObject({ op: "places.propose", nonce: PINNED });
    expect(envelope(fetch, 1).nonce).not.toBe(PINNED);
    expect(sent(fetch, 2).url).toBe(`${SRV}/places/proposals/fetch`);
    expect(envelope(fetch, 2)).toMatchObject({
      op: "places.proposals.fetch",
      params: { limit: 50 },
    });
  });

  describe("fetchMyProposals pages", () => {
    const proposals = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, "0")}`,
      }));

    it("gives the last id as nextCursor when the page is full", async () => {
      const fetch = fetchReturning({ ok: true, proposals: proposals(2) });
      const res = await createClient({ fetch }).fetchMyProposals(SRV, wallet, {
        status: "pending",
        limit: 2,
      });
      expect(res.nextCursor).toBe("01ARZ3NDEKTSV4RRFFQ69G5F01");
      expect(envelope(fetch).params).toEqual({ status: "pending", limit: 2 });
    });

    it("gives no nextCursor on a short page, an empty one or a refusal", async () => {
      for (const body of [
        { ok: true, proposals: proposals(49) },
        { ok: true, proposals: [] },
        { ok: false, error: "rateLimited" },
      ]) {
        const res = await createClient({ fetch: fetchReturning(body) }).fetchMyProposals(
          SRV,
          wallet,
        );
        expect(res).toEqual(body);
      }
    });

    it("pages with the default limit of 50", async () => {
      const fetch = fetchReturning({ ok: true, proposals: proposals(50) });
      const res = await createClient({ fetch }).fetchMyProposals(SRV, wallet, { cursor: N1 });
      expect(res.nextCursor).toBe("01ARZ3NDEKTSV4RRFFQ69G5F49");
      expect(envelope(fetch).params).toEqual({ cursor: N1, limit: 50 });
    });
  });

  it("the access ops post to their routes and read the reply through its read twin", async () => {
    const fetch = fetchReturning({ ok: true, accessLevel: "someday", status: "invited", x: 1 });
    const client = createClient({ fetch });
    expect(await client.requestAccess(SRV, wallet, "hi, it's Sam")).toEqual({
      ok: true,
      accessLevel: "private",
      status: "none",
    });
    await client.requestAccess(SRV, wallet);
    await client.fetchAccess(SRV, wallet);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${SRV}/access/request`,
      `${SRV}/access/request`,
      `${SRV}/access/status`,
    ]);
    expect(envelope(fetch, 0)).toMatchObject({
      op: "access.request",
      params: { note: "hi, it's Sam" },
    });
    expect(envelope(fetch, 1).params).toEqual({});
    expect(envelope(fetch, 2)).toMatchObject({ op: "access.status", params: {} });
  });

  it("the access ops hand back a refusal as their result", async () => {
    const refused = { ok: false, error: "denied", message: "this server takes no requests" };
    const client = createClient({ fetch: fetchReturning(refused, 403) });
    expect(await client.requestAccess(SRV, wallet)).toEqual(refused);
  });

  it("the access ops send an empty note as none, and throw a body that is no answer", async () => {
    const fetch = fetchReturning({ ok: true, accessLevel: "request", status: "pending" });
    await createClient({ fetch }).requestAccess(SRV, wallet, "");
    expect(envelope(fetch).params).toEqual({});
    const odd = createClient({ fetch: fetchReturning({ ok: true }) });
    await expect(odd.fetchAccess(SRV, wallet)).rejects.toBeInstanceOf(ServerError);
  });

  it("the mailbox ops post to their standalone routes", async () => {
    const fetch = fetchReturning({ ok: true });
    const client = createClient({ fetch });
    const to = createAccount().did;
    await client.sendMail(SRV, wallet, to, "hi");
    await client.fetchMail(SRV, wallet);
    await client.ackMail(SRV, wallet, ["m1"]);
    await client.fetchMail(SRV, wallet);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${SRV}/mailbox`,
      `${SRV}/mailbox/fetch`,
      `${SRV}/mailbox/ack`,
      `${SRV}/mailbox/fetch`,
    ]);
    // A re-used read nonce 409s, so every fetch signs a fresh one.
    expect(envelope(fetch, 1).nonce).not.toBe(envelope(fetch, 3).nonce);
    expect(envelope(fetch, 0)).toMatchObject({ op: "mailbox.send", params: { to, body: "hi" } });
    expect(envelope(fetch, 2)).toMatchObject({ op: "mailbox.ack", params: { ids: ["m1"] } });
    const sub = client.buildMailboxSubscribe(wallet);
    expect(sub).toMatchObject({ op: "mailbox.subscribe", params: {} });
    expect(verifyOp(sub).ok).toBe(true);
  });
});

describe("the game slug", () => {
  it("rides every signing path, and survives a retry, which re-signs", async () => {
    const fetch = vi
      .fn<WireFetch>()
      .mockRejectedValueOnce(new Error("lost reply"))
      .mockResolvedValue(reply({ ok: true }));
    const client = createClient({ fetch, game: "kites" });
    await client.sendOpWithRetry(SRV, wallet, "r@srv", "take", {});
    await client.placeRoom(SRV, wallet, { type: "widget" } as unknown as PlaceParams);
    await client.reportScout(SRV, wallet, {
      unique: "s1",
      config: {},
      mintedBy: { minter: wallet.account.did, sig: "x" },
      movement: { from: { lat: 0, lng: 0 } },
    } as unknown as Parameters<typeof client.reportScout>[2]);
    await client.cancelScout(SRV, wallet, "s1");
    await client.putMedia(SRV, wallet, { hash: "h", type: "image/webp", size: 1, base64: "AA==" });
    await client.sendMail(SRV, wallet, createAccount().did, "hi");
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init.body ?? "") as object);
    const envs = bodies.map((b) => ("env" in b ? b.env : b) as OpEnvelope);
    expect(envs.map((e) => [e.op, e.game])).toEqual([
      ["take", "kites"],
      ["take", "kites"],
      ["place", "kites"],
      ["report", "kites"],
      ["cancel", "kites"],
      ["media.put", "kites"],
      ["mailbox.send", "kites"],
    ]);
    expect(envs.every((e) => verifyOp(e).ok)).toBe(true);
    expect(client.buildMailboxSubscribe(wallet).game).toBe("kites");
    expect(client.sign(wallet, { op: "x", params: {} }).game).toBe("kites");
  });

  it("filters discovery and room fetch to this game by default, and widens on request", async () => {
    const fetch = fetchReturning({ coveredBy: "srv", rooms: [], scouts: [] });
    const client = createClient({ fetch, game: "kites" });
    await client.discoverCells(SRV, ["9q8yy"], { rooms: ["jar"], scouts: false });
    await client.discoverCells(SRV, ["9q8yy"], {
      rooms: ["jar"],
      scouts: false,
      games: ["kites", "gulls"],
    });
    await client.discoverCells(SRV, ["9q8yy"], { rooms: ["jar"], scouts: false, games: null });
    await client.resolveRoom(SRV, "r@srv");
    await client.resolveRoom(SRV, "r@srv", null);
    const games = fetch.mock.calls.map((_, i) =>
      new URL(sent(fetch, i).url).searchParams.get("games"),
    );
    expect(games).toEqual(["kites", "kites,gulls", null, "kites", null]);
    expect(sent(fetch, 4).url).toBe(`${SRV}/rooms/r%40srv`);
  });

  it("refuses an empty or malformed games list, which is neither a filter nor every game", async () => {
    const client = createClient({ fetch: fetchReturning({}), game: "kites" });
    await expect(
      client.discoverCells(SRV, ["9q8yy"], { rooms: ["jar"], scouts: false, games: [] }),
    ).rejects.toThrow("or null");
    await expect(client.resolveRoom(SRV, "r@srv", ["Not A Slug"])).rejects.toThrow("or null");
  });

  it("refuses a malformed slug when the client is built, not on every call after", () => {
    expect(() => createClient({ game: "My Game" })).toThrow("is not a game slug");
  });

  it("a client with no game, an operator console, attaches nothing and filters nothing", async () => {
    const fetch = fetchReturning({ ok: true, coveredBy: "srv", rooms: [], scouts: [] });
    const client = createClient({ fetch });
    await client.sendOp(SRV, wallet, "r@srv", "add", {});
    await client.discoverCells(SRV, ["9q8yy"], { rooms: ["jar"], scouts: true });
    await client.resolveRoom(SRV, "r@srv");
    expect(envelope(fetch)).not.toHaveProperty("game");
    expect(client.buildMailboxSubscribe(wallet)).not.toHaveProperty("game");
    expect(new URL(sent(fetch, 1).url).searchParams.has("games")).toBe(false);
    expect(new URL(sent(fetch, 2).url).searchParams.has("games")).toBe(false);
  });
});

describe("reads", () => {
  it("getDescriptor GETs /server/descriptor", async () => {
    const d = signedTestDescriptor([]);
    const fetch = fetchReturning(d);
    await expect(createClient({ fetch }).getDescriptor(`${SRV}/`)).resolves.toEqual(d);
    expect(sent(fetch).url).toBe(`${SRV}/server/descriptor`);
    const limited = fetchReturning({ ok: false, error: "rateLimited" }, 429);
    const err = await createClient({ fetch: limited })
      .getDescriptor(SRV)
      .catch((e: unknown) => e);
    expect(isRefusal(err)).toBe(true);
  });

  it("pingServer times the round trip on the injected clock, and is null when it fails", async () => {
    let t = 1000;
    const now = () => (t += 40);
    await expect(createClient({ fetch: fetchReturning({}), now }).pingServer(SRV)).resolves.toBe(
      40,
    );
    await expect(
      createClient({ fetch: fetchReturning({}, 503), now }).pingServer(SRV),
    ).resolves.toBeNull();
    const down = vi.fn<WireFetch>().mockRejectedValue(new Error("down"));
    await expect(createClient({ fetch: down, now }).pingServer(SRV)).resolves.toBeNull();
  });

  it("discoverCells sends the cells, the room types and scouts when asked, as one types list", async () => {
    const fetch = fetchReturning({ rooms: [] });
    const client = createClient({ fetch });
    await client.discoverCells(SRV, ["9q8yy", "9q8yz"], { rooms: ["widget"], scouts: true });
    await client.discoverCells(SRV, ["9q8yy"], { rooms: ["widget", "jar"], scouts: false });
    await client.discoverCells(SRV, ["9q8yy"], { rooms: [], scouts: true });
    // Every room type: an empty `types` leaves scouts out, and no `types` at all brings them.
    await client.discoverCells(SRV, ["9q8yy"], { rooms: null, scouts: false });
    await client.discoverCells(SRV, ["9q8yy"], { rooms: null, scouts: true });
    const url = new URL(sent(fetch).url);
    expect(url.pathname).toBe("/discovery");
    expect(url.searchParams.get("cells")).toBe("9q8yy,9q8yz");
    const types = [0, 1, 2, 3, 4].map((i) => new URL(sent(fetch, i).url).searchParams.get("types"));
    expect(types).toEqual(["widget,scout", "widget,jar", "scout", "", null]);
  });

  it("discoverCells refuses options that ask for nothing or name scouts as a room type", async () => {
    const fetch = fetchReturning({ rooms: [] });
    const client = createClient({ fetch });
    await expect(
      client.discoverCells(SRV, ["9q8yy"], { rooms: [], scouts: false }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      client.discoverCells(SRV, ["9q8yy"], { rooms: ["scout"], scouts: false }),
    ).rejects.toThrow("scouts: true");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("discoverCells throws a refusal as an ApiError with its code, and a fault as a ServerError", async () => {
    const tooMany = { ok: false, error: "invalid", message: "at most 256 cells" };
    const refused = createClient({ fetch: fetchReturning(tooMany, 400) }).discoverCells(
      SRV,
      ["9q8yy"],
      { rooms: ["jar"], scouts: false },
    );
    await expect(refused).rejects.toBeInstanceOf(ApiError);
    await expect(refused).rejects.not.toBeInstanceOf(ServerError);
    await expect(refused).rejects.toMatchObject({
      status: 400,
      code: "invalid",
      message: "at most 256 cells",
    });
    await expect(
      createClient({ fetch: fetchReturning({}, 502) }).discoverCells(SRV, ["9q8yy"], {
        rooms: ["jar"],
        scouts: false,
      }),
    ).rejects.toBeInstanceOf(ServerError);
    // A proxy's 404 while the server restarts is a fault, not a refused query with no code.
    await expect(
      createClient({ fetch: fetchProxyNotFound() }).discoverCells(SRV, ["9q8yy"], {
        rooms: ["jar"],
        scouts: false,
      }),
    ).rejects.toSatisfy((err) => err instanceof ServerError && err.status === 404);
  });

  const resolve = (fetch: WireFetch) => createClient({ fetch }).resolveRoom(SRV, "r@srv");

  it("resolveRoom: the room on 200, null on 404 unknownRoom, an ApiError on another 4xx, a ServerError on a 5xx", async () => {
    await expect(resolve(fetchReturning({ id: "r" }))).resolves.toEqual({ id: "r" });
    const unknownRoom = { ok: false, error: "unknownRoom" };
    await expect(resolve(fetchReturning(unknownRoom, 404))).resolves.toBeNull();
    await expect(resolve(fetchPlatformReply(unknownRoom, 404))).resolves.toBeNull();
    await expect(resolve(fetchReturning({}, 500))).rejects.toBeInstanceOf(ServerError);
    for (const [status, code] of [
      [400, "invalid"],
      [429, "rateLimited"],
    ] as const) {
      const refused = resolve(fetchReturning({ ok: false, error: code }, status));
      await expect(refused).rejects.not.toBeInstanceOf(ServerError);
      await expect(refused).rejects.toMatchObject({ name: "ApiError", status, code });
    }
  });

  // A reverse proxy answers its own 404 while the server behind it restarts. A game that deletes a
  // saved room on `null` would lose it for good, so only the server's `unknownRoom` is `null`.
  it("resolveRoom throws a ServerError for a 404 the server did not send", async () => {
    await expect(resolve(fetchProxyNotFound())).rejects.toSatisfy(
      (err) => err instanceof ServerError && err.status === 404 && err.code === undefined,
    );
    // The server's own 404 with another code is its refusal, and still never `null`.
    const other = await resolve(
      fetchPlatformReply({ ok: false, error: "unknownRoute" }, 404),
    ).catch((e: unknown) => e);
    expect(isRefusal(other)).toBe(true);
    expect(other).toMatchObject({ status: 404, code: "unknownRoute" });
    await expect(resolve(fetchReturning({ statusCode: 404 }, 404))).rejects.toBeInstanceOf(
      ServerError,
    );
  });

  it("sendOp, discoverCells and the signed POSTs throw a ServerError for a proxy's 404", async () => {
    const client = createClient({ fetch: fetchProxyNotFound() });
    const calls = [
      () => client.sendOp(SRV, wallet, "r@srv", "list", {}),
      () => client.discoverCells(SRV, ["9q8yy"], { rooms: ["jar"], scouts: false }),
      () => client.fetchMail(SRV, wallet),
      () => client.fetchMyProposals(SRV, wallet),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ status: 404 });
  });

  it("sendOp hands back the server's own 404 refusal as its result", async () => {
    const expired = { ok: false, error: "expired" };
    await expect(
      createClient({ fetch: fetchPlatformReply(expired, 404) }).sendOp(
        SRV,
        wallet,
        "r@srv",
        "take",
        {},
      ),
    ).resolves.toEqual(expired);
  });

  it("resolveRoom carries the refusal of a reply it throws for", async () => {
    await expect(resolve(fetchPlatformReply(LOCKED, 503))).rejects.toMatchObject({
      status: 503,
      code: "writeLocked",
    });
  });

  describe("the location reads share one status split", () => {
    const LABEL = {
      geohash: "9q8yy",
      city: "San Francisco",
      country: "United States",
      countryCode: "US",
      source: "nominatim",
      attribution: "© OpenStreetMap contributors (ODbL)",
      cachedAt: "2026-07-22T00:00:00Z",
    };
    const reads = (fetch: WireFetch) => {
      const c = createClient({ fetch });
      return [
        () => c.getGeocode(SRV, "9q8yy"),
        () => c.getPlaces(SRV, ["9q8yy"]),
        () => c.getPlaceTaxonomy(SRV),
        () => c.getPlaceDetail(SRV, "p1"),
      ];
    };

    it("parses a good body", async () => {
      const fetch = fetchReturning(LABEL);
      await expect(createClient({ fetch }).getGeocode(`${SRV}/`, "9q8yy")).resolves.toEqual(LABEL);
      expect(sent(fetch).url).toBe(`${SRV}/geocode?geohash=9q8yy`);
    });

    it("sends categories only when there are some", async () => {
      const fetch = fetchReturning({ places: [], attribution: [], truncated: false });
      const c = createClient({ fetch });
      await c.getPlaces(SRV, ["a", "b"], ["sweets"] as never);
      await c.getPlaces(SRV, ["a"], []);
      expect(new URL(sent(fetch, 0).url).searchParams.get("categories")).toBe("sweets");
      expect(new URL(sent(fetch, 1).url).searchParams.has("categories")).toBe(false);
    });

    describe("past a field a newer server adds", () => {
      const PLACE = {
        unique: "01J2X6M0R9V8Q4T5N7B3C1D2E4",
        category: "sweets",
        name: "Blue Bottle",
        point: { lat: 37.77, lng: -122.42 },
        hasGeometry: false,
        hasDescription: false,
        updatedAt: "2026-07-23T00:00:00Z",
      };
      const PLACES = { places: [PLACE], attribution: ["© OSM"], truncated: false };
      const DETAIL = { ...PLACE, sources: [{ source: "osm", attribution: "© OSM" }] };
      const TAXONOMY = { categories: [{ category: "sweets", subcategories: ["bakery"] }] };
      const read = (body: unknown) => createClient({ fetch: fetchReturning(body) });

      it("keeps the label, the list, the vocabulary and the detail, and drops the field", async () => {
        await expect(read({ ...LABEL, timezone: "PT" }).getGeocode(SRV, "9q8yy")).resolves.toEqual(
          LABEL,
        );
        await expect(
          read({ ...PLACES, places: [{ ...PLACE, rating: 4 }], total: 1 }).getPlaces(SRV, ["c"]),
        ).resolves.toEqual(PLACES);
        await expect(
          read({
            categories: [{ ...TAXONOMY.categories[0]!, label: "Sweets" }],
            version: 3,
          }).getPlaceTaxonomy(SRV),
        ).resolves.toEqual(TAXONOMY);
        await expect(
          read({
            ...DETAIL,
            sources: [{ ...DETAIL.sources[0]!, url: "https://osm.org" }],
            rating: 4,
          }).getPlaceDetail(SRV, PLACE.unique),
        ).resolves.toEqual(DETAIL);
      });
    });

    // A newer server adds a VALUE: a category this build has never heard of. An older build
    // returned null for the whole list over one such row, so every place that server holds vanished
    // from the scanner.
    describe("past a value a newer server adds", () => {
      const KNOWN = {
        unique: "01J2X6M0R9V8Q4T5N7B3C1D2E4",
        category: "sweets",
        name: "Blue Bottle",
        point: { lat: 37.77, lng: -122.42 },
        hasGeometry: false,
        hasDescription: false,
        updatedAt: "2026-07-23T00:00:00Z",
      };
      const VOLCANO = { ...KNOWN, unique: "01J2X6M0R9V8Q4T5N7B3C1D2E5", category: "volcano" };
      const read = (body: unknown) => createClient({ fetch: fetchReturning(body) });

      it("getPlaces leaves out the one place it cannot read, and keeps the rest", async () => {
        const places = { places: [KNOWN], attribution: ["© OSM"], truncated: false };
        await expect(
          read({ ...places, places: [KNOWN, VOLCANO] }).getPlaces(SRV, ["c"]),
        ).resolves.toEqual(places);
      });

      it("getPlaceTaxonomy offers the categories it knows", async () => {
        const known = { category: "sweets", subcategories: ["bakery"] };
        await expect(
          read({
            categories: [known, { category: "volcano", subcategories: [] }],
          }).getPlaceTaxonomy(SRV),
        ).resolves.toEqual({ categories: [known] });
      });
    });

    it("reads the server's own 404 unknownRoute (capability off) as null", async () => {
      const off = { ok: false, error: "unknownRoute" };
      for (const read of reads(fetchReturning(off, 404))) await expect(read()).resolves.toBeNull();
      for (const read of reads(fetchPlatformReply({ ...off, message: "unknown place" }, 404)))
        await expect(read()).resolves.toBeNull();
    });

    it("throws a ServerError for a 404 the server did not send", async () => {
      for (const read of reads(fetchProxyNotFound()))
        await expect(read()).rejects.toSatisfy(
          (err) => err instanceof ServerError && err.status === 404,
        );
      for (const read of reads(fetchReturning({}, 404)))
        await expect(read()).rejects.toBeInstanceOf(ServerError);
    });

    it("throws the server's other refusals, as resolveRoom does, and never reads them as null", async () => {
      const refusals: [unknown, number][] = [
        [{ ok: false, error: "unknownRoom" }, 404],
        [{ ok: false, error: "invalid", message: "geohash too coarse" }, 400],
        [{ ok: false, error: "rateLimited" }, 429],
      ];
      for (const [body, status] of refusals) {
        for (const read of reads(fetchPlatformReply(body, status))) {
          const err = await read().catch((e: unknown) => e);
          expect(isRefusal(err), `${status}`).toBe(true);
          expect(err).toMatchObject({ status, code: (body as { error: string }).error });
        }
      }
      // A 4xx with no Beacon body came from something in front of the server: a fault.
      for (const read of reads(fetchReturning({ message: "blocked" }, 403)))
        await expect(read()).rejects.toBeInstanceOf(ServerError);
    });

    it("throws a fault for a 2xx body of the wrong shape, and never reads it as null", async () => {
      // A game may forget a place or hide a layer on `null`, so only `unknownRoute` may give it.
      for (const body of [{ nonsense: true }, null, [], "ok"])
        for (const read of reads(fetchReturning(body))) {
          const err = await read().catch((e: unknown) => e);
          expect(err, JSON.stringify(body)).toMatchObject({ name: "ServerError", status: 200 });
        }
    });

    it("throws a retryable ServerError on a 5xx", async () => {
      for (const read of reads(fetchReturning({}, 503)))
        await expect(read()).rejects.toBeInstanceOf(ServerError);
    });

    it("carries the refusal code of a 5xx", async () => {
      for (const read of reads(fetchPlatformReply({ ok: false, error: "upstreamDown" }, 503)))
        await expect(read()).rejects.toMatchObject({ code: "upstreamDown" });
    });
  });
});

describe("profiles", () => {
  const account = createAccount();
  const doc = buildProfile(account, { version: 1, devices: [] });

  it("publishProfile posts the doc, and returns the server's refusal", async () => {
    const ok = fetchReturning({ ok: true });
    await expect(createClient({ fetch: ok }).publishProfile(SRV, doc)).resolves.toEqual({
      ok: true,
    });
    expect(sent(ok).url).toBe(`${SRV}/profiles`);
    const stale = fetchReturning({ ok: false, error: "stale" }, 409);
    await expect(createClient({ fetch: stale }).publishProfile(SRV, doc)).resolves.toEqual({
      ok: false,
      error: "stale",
    });
  });

  it("publishProfile throws a fault and a lock, and never returns either", async () => {
    const publish = (answer: WireResponse) =>
      createClient({ fetch: vi.fn<WireFetch>().mockResolvedValue(answer) })
        .publishProfile(SRV, doc)
        .catch((e: unknown) => e);
    const noBody = { ok: false, status: 500, json: () => Promise.reject(new Error("x")) };
    const fault = await publish(noBody);
    expect(fault).toBeInstanceOf(ServerError);
    expect(isFault(fault)).toBe(true);
    // A proxy's 404 page and a 4xx with no Beacon body are faults too, not a failed publish.
    for (const reply of [platformReply("404 page not found", 404), platformReply("{}", 403)]) {
      expect(isFault(await publish(reply))).toBe(true);
    }
    const locked = await publish(
      platformReply(JSON.stringify(LOCKED), 503, { "retry-after": "60" }),
    );
    expect(isRefusal(locked)).toBe(true);
    expect(locked).toMatchObject({ status: 503, code: "writeLocked", retryAfterSec: 60 });
    const down = vi.fn<WireFetch>().mockRejectedValue(new TypeError("Network request failed"));
    const lost = await createClient({ fetch: down })
      .publishProfile(SRV, doc)
      .catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(NetworkError);
  });

  it("fetchProfile is best-effort: a doc, or null for absent, malformed or unreachable", async () => {
    await expect(
      createClient({ fetch: fetchReturning(doc) }).fetchProfile(SRV, account.did),
    ).resolves.toEqual(doc);
    await expect(
      createClient({ fetch: fetchReturning({}, 404) }).fetchProfile(SRV, account.did),
    ).resolves.toBeNull();
    await expect(
      createClient({ fetch: fetchReturning({ id: 3 }) }).fetchProfile(SRV, account.did),
    ).resolves.toBeNull();
    const down = vi.fn<WireFetch>().mockRejectedValue(new Error("down"));
    await expect(createClient({ fetch: down }).fetchProfile(SRV, account.did)).resolves.toBeNull();
    // `null` means "no copy read from here", never "no copy exists", so a proxy's 404 is one too.
    await expect(
      createClient({ fetch: fetchProxyNotFound() }).fetchProfile(SRV, account.did),
    ).resolves.toBeNull();
  });

  it("fetchProfile hands back a newer app's doc as received, so its signature still checks", async () => {
    // The doc is signed over its whole body. Strict-parsing a field this build doesn't know away made
    // the profile unreadable from that server; stripping it would make the signature fail. So it stays.
    const { proof: _proof, ...body } = doc;
    const newer = { ...body, pronouns: "they/them" };
    const sig = signUtf8(canonicalJson(newer), account.root.privateKey);
    const received = { ...newer, proof: { type: "Ed25519", key: account.did, sig } };
    const fetched = await createClient({ fetch: fetchReturning(received) }).fetchProfile(
      SRV,
      account.did,
    );
    expect(fetched).toEqual(received);
    expect(verifyProfile(fetched)).toBe(true);
  });

  it("fetchBestProfile believes the highest verified copy across servers", async () => {
    const newer = buildProfile(account, { version: 2, devices: [] });
    const fetch = vi.fn<WireFetch>((url) =>
      Promise.resolve(reply(url.startsWith("http://b") ? newer : doc)),
    );
    await expect(
      createClient({ fetch }).fetchBestProfile(["http://a", "http://b"], account.did),
    ).resolves.toEqual(newer);
    const down = vi.fn<WireFetch>().mockRejectedValue(new Error("down"));
    await expect(
      createClient({ fetch: down }).fetchBestProfile(["http://a"], account.did),
    ).resolves.toBeNull();
  });

  it("probeDevice reads the server's verdict for the device without side effects", async () => {
    const verdict = (body: unknown, status = 200) =>
      createClient({ fetch: fetchReturning(body, status) }).probeDevice(SRV, wallet);
    await expect(verdict({ ok: false, error: "unknownRoom" }, 404)).resolves.toEqual({
      status: "allowed",
    });
    await expect(verdict({ ok: false, error: "deviceRevoked" }, 403)).resolves.toEqual({
      status: "revoked",
    });
    // With `code:deviceRevoked` declared, `denied` is only the operator's block.
    await expect(verdict({ ok: false, error: "denied" }, 403)).resolves.toEqual({
      status: "blocked",
    });
    await expect(verdict({ ok: false, error: "rateLimited" }, 429)).resolves.toEqual({
      status: "unknown",
      code: "rateLimited",
    });
    await expect(verdict({ ok: false, error: "clockSkew" }, 400)).resolves.toEqual({
      status: "unknown",
      code: "clockSkew",
    });
    await expect(verdict({ ok: true })).resolves.toEqual({ status: "allowed" });
  });

  it("probeDevice throws a fault rather than make up a verdict", async () => {
    const probe = (fetch: WireFetch) =>
      createClient({ fetch })
        .probeDevice(SRV, wallet)
        .catch((e: unknown) => e);
    // A 4xx with no code, a 5xx and a proxy's 404 page say nothing about the device.
    expect(isFault(await probe(fetchReturning({ ok: false }, 400)))).toBe(true);
    // Every `unknown` carries a code, so a 2xx with neither `ok` nor a code is no verdict either.
    for (const body of [{ ok: false }, { error: "denied" }, {}, null])
      expect(await probe(fetchReturning(body)), JSON.stringify(body)).toMatchObject({
        name: "ServerError",
        status: 200,
      });
    expect(await probe(fetchReturning({}, 500))).toBeInstanceOf(ServerError);
    const page = vi.fn<WireFetch>().mockResolvedValue(platformReply("404 page not found", 404));
    expect(await probe(page)).toMatchObject({ name: "ServerError", status: 404 });
    const down = vi.fn<WireFetch>().mockRejectedValue(new Error("down"));
    expect(await probe(down)).toBeInstanceOf(NetworkError);
  });

  it("probeDevice declares code:deviceRevoked on its own request, whatever the client declares", async () => {
    const answer = { ok: false, error: "unknownRoom" };
    const bare = fetchReturning(answer, 404);
    await createClient({ fetch: bare }).probeDevice(SRV, wallet);
    expect(sent(bare).init.headers).toMatchObject({ [UNDERSTANDS_HEADER]: "code:deviceRevoked" });

    const declaring = fetchReturning(answer, 404);
    const client = createClient({ fetch: declaring, understands: ["code:clockSkew"] });
    await client.probeDevice(SRV, wallet);
    expect(sent(declaring).init.headers).toMatchObject({
      [UNDERSTANDS_HEADER]: "code:deviceRevoked,code:clockSkew",
    });
    // The client's other writes declare only what the client declares.
    await client.sendOp(SRV, wallet, "r@srv", "list", {});
    expect(sent(declaring, 1).init.headers).toMatchObject({
      [UNDERSTANDS_HEADER]: "code:clockSkew",
    });
    expect(envelope(declaring)).toMatchObject({ op: "list", params: {} });
  });
});

describe("addServer (descriptor verify)", () => {
  const addServerAnswering = (descriptor: unknown) =>
    createClient({ fetch: fetchReturning(descriptor) }).addServer;

  it("fetches a typed address at the origin the platform's scheme rule gives it", async () => {
    const fetch = fetchReturning(signedTestDescriptor([]));
    const entry = await createClient({ fetch }).addServer("  beacon.example/ ");
    expect(sent(fetch).url).toBe("https://beacon.example/server/descriptor");
    // The fixture names itself `srv.example` and answers there too, so that is the saved origin.
    expect(entry.origin).toBe("https://srv.example");
  });

  it("marks a server verified when its descriptor signature checks, and saves it under its own name when that name answers with the same key", async () => {
    // The fixture's descriptor names `srv.example`; reached as `http://srv`, the server is asked
    // again by its own name, answers the same, and is saved under it.
    const fetch = fetchReturning(signedTestDescriptor(["u4"]));
    const entry = await createClient({ fetch }).addServer("http://srv/");
    expect(entry.origin).toBe("https://srv.example");
    expect(entry.verified).toBe(true);
    expect(entry.descriptor).not.toBeNull();
    expect(sent(fetch, 0).url).toBe("http://srv/server/descriptor");
    expect(sent(fetch, 1).url).toBe("https://srv.example/server/descriptor");
  });

  it("saves the descriptor fetched from the server's own name, and asks again when only a default port or case differs (the router compares authorities exactly)", async () => {
    const fetch = fetchReturning(signedTestDescriptor(["u4"]));
    const entry = await createClient({ fetch }).addServer("http://srv/");
    expect(entry.descriptor).toEqual(await (await fetch.mock.results[1]!.value).json());
    const ported = fetchReturning(signDescriptorFor("srv.example:443"));
    const byPort = await createClient({ fetch: ported }).addServer("https://srv.example");
    expect(byPort.origin).toBe("https://srv.example:443");
    expect(ported).toHaveBeenCalledTimes(2);
  });

  it("adopts nothing a server names outside the id host class, and never a step down from https", async () => {
    for (const host of [
      "http://evil.example",
      "srv.example/evil/path",
      "user:pw@srv.example",
      "",
    ]) {
      const fetch = fetchReturning(signDescriptorFor(host));
      const entry = await createClient({ fetch }).addServer("https://alias.example");
      expect(entry.origin, host).toBe("https://alias.example");
      expect(fetch, host).toHaveBeenCalledTimes(1);
    }
    // A LAN name is in the class but answers over http: a player who typed https stays on https.
    const lan = fetchReturning(signDescriptorFor("192.168.1.20:3001"));
    const kept = await createClient({ fetch: lan }).addServer("https://alias.example");
    expect(kept.origin).toBe("https://alias.example");
    expect(lan).toHaveBeenCalledTimes(1);
    // Typed over http, a LAN name is adopted like any other.
    const fromHttp = fetchReturning(signDescriptorFor("192.168.1.20:3001"));
    expect((await createClient({ fetch: fromHttp }).addServer("http://alias.local")).origin).toBe(
      "http://192.168.1.20:3001",
    );
  });

  it("asks once when the typed address is the server's own name", async () => {
    const fetch = fetchReturning(signedTestDescriptor(["u4"]));
    const entry = await createClient({ fetch }).addServer("srv.example");
    expect(entry.origin).toBe("https://srv.example");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the typed address when the server's own name does not answer, or answers with another key", async () => {
    const descriptor = signedTestDescriptor(["u4"]);
    const unreachable = vi.fn<WireFetch>((url) =>
      url.startsWith("https://srv.example")
        ? Promise.reject(new Error("ENOTFOUND"))
        : Promise.resolve(reply(descriptor)),
    );
    const kept = await createClient({ fetch: unreachable }).addServer("http://192.168.1.20:3001");
    expect(kept.origin).toBe("http://192.168.1.20:3001");
    expect(kept.verified).toBe(true);

    const impostor = vi.fn<WireFetch>((url) =>
      Promise.resolve(
        reply(url.startsWith("https://srv.example") ? otherSignedDescriptor(["u4"]) : descriptor),
      ),
    );
    const typed = await createClient({ fetch: impostor }).addServer("http://srv");
    expect(typed.origin).toBe("http://srv");
    expect(typed.verified).toBe(true);
  });

  it("does NOT trust a descriptor with a broken signature", async () => {
    const tampered = { ...signedTestDescriptor(["u4"]), name: "spoofed" }; // body changed after signing
    const entry = await addServerAnswering(tampered)("http://srv");
    expect(entry.verified).toBe(false);
    expect(entry.descriptor).toBeNull();
  });

  it("returns unverified (not a throw) when the server is unreachable", async () => {
    const fetch = vi.fn<WireFetch>().mockRejectedValue(new Error("ECONNREFUSED"));
    const entry = await createClient({ fetch }).addServer("http://down");
    expect(entry.verified).toBe(false);
  });
});

describe("the default fetch", () => {
  it("is the global one, looked up per call so a swapped global is the one used", async () => {
    const original = globalThis.fetch;
    const swapped = vi.fn().mockResolvedValue(reply({ ok: true }));
    const client = createClient();
    globalThis.fetch = swapped as unknown as typeof fetch;
    try {
      await client.fetchMail(SRV, wallet);
    } finally {
      globalThis.fetch = original;
    }
    expect(swapped).toHaveBeenCalledTimes(1);
  });
});

describe("an injected fetch", () => {
  it("is called as a plain function, as a browser's native fetch requires", async () => {
    // A browser's `fetch` throws "Illegal invocation" when its `this` is not the global object.
    const strict = vi.fn<WireFetch>(function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(reply({ ok: true }));
    });
    await expect(createClient({ fetch: strict }).fetchMail(SRV, wallet)).resolves.toEqual({
      ok: true,
    });
  });
});

describe("the throwing calls (an operator console's model)", () => {
  const ACCEPT_JSON = { accept: "application/json" };

  it("getOrThrow GETs as JSON and throws a refusal or a fault for any non-2xx", async () => {
    const fetch = fetchReturning({ ok: true });
    await expect(createClient({ fetch }).getOrThrow(SRV, "/x")).resolves.toEqual({ ok: true });
    expect(sent(fetch)).toMatchObject({ url: `${SRV}/x`, init: { headers: ACCEPT_JSON } });
    const body = { ok: false, error: "denied", message: "nope" };
    const refused = await createClient({ fetch: fetchReturning(body, 403) })
      .getOrThrow(SRV, "/x")
      .catch((e: unknown) => e);
    expect(isRefusal(refused)).toBe(true);
    expect(refused).toMatchObject({ status: 403, message: "nope", code: "denied" });
    // A 403 without the server's body came from something in front of it: a fault.
    const cdn = await createClient({ fetch: fetchReturning({ message: "nope" }, 403) })
      .getOrThrow(SRV, "/x")
      .catch((e: unknown) => e);
    expect(cdn).toBeInstanceOf(ServerError);
    expect(isFault(cdn)).toBe(true);
    // A 5xx is a fault from the strict calls too.
    const down = await createClient({ fetch: fetchReturning({ ok: false, error: "x" }, 500) })
      .getOrThrow(SRV, "/x")
      .catch((e: unknown) => e);
    expect(down).toMatchObject({ name: "ServerError", status: 500, code: "x" });
  });

  it("postSignedOrThrow signs and posts, throwing where postSigned would answer", async () => {
    const fetch = fetchReturning({ ok: true });
    await createClient({ fetch }).postSignedOrThrow(SRV, "/admin/status", wallet, {
      op: "admin.status",
      params: {},
    });
    expect(sent(fetch).init.headers).toEqual({
      "content-type": "application/json",
      ...ACCEPT_JSON,
    });
    expect(envelope(fetch)).toMatchObject({ op: "admin.status", params: {} });
    expect(verifyOp(envelope(fetch)).ok).toBe(true);
    const body = { ok: false, error: "denied", message: "not an admin" };
    const refused = createClient({ fetch: fetchReturning(body, 403) });
    const err: unknown = await refused
      .postSignedOrThrow(SRV, "/admin/status", wallet, { op: "admin.status", params: {} })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: "denied", message: "not an admin" });
  });

  it("uploadSignedOrThrow sends the attestation beside the bytes", async () => {
    const fetch = fetchReturning({ ok: true, id: "h@srv" });
    await createClient({ fetch }).uploadSignedOrThrow(
      SRV,
      "/media",
      wallet,
      { op: "media.put", params: { hash: "h", type: "image/webp", size: 3 } },
      "AAAA",
    );
    const body = JSON.parse(sent(fetch).init.body ?? "") as { env: OpEnvelope; data: string };
    expect(body.data).toBe("AAAA");
    expect(body.env).toMatchObject({ op: "media.put", params: { hash: "h" } });
    expect(sent(fetch).init.headers).toMatchObject(ACCEPT_JSON);
  });

  it("sign returns the envelope a route would get, without sending it", () => {
    const fetch = fetchReturning({});
    const env = createClient({ fetch }).sign(wallet, { op: "x", params: { a: 1 } });
    expect(verifyOp(env).ok).toBe(true);
    expect(env).toMatchObject({ op: "x", params: { a: 1 } });
    expect(fetch).not.toHaveBeenCalled();
  });

  describe("verifyServer", () => {
    it("saves the server under its own name, as addServer does, when that name answers with the same key", async () => {
      const d = signedTestDescriptor([]);
      const fetch = fetchReturning(d);
      await expect(createClient({ fetch }).verifyServer("beacon.example")).resolves.toEqual({
        origin: "https://srv.example",
        descriptor: d,
        verified: true,
      });
      expect(sent(fetch, 0).url).toBe("https://beacon.example/server/descriptor");
      expect(sent(fetch, 1).url).toBe("https://srv.example/server/descriptor");
    });

    it("keeps the typed address with keepAddress, for a console on an internal address", async () => {
      const d = signedTestDescriptor([]);
      const fetch = fetchReturning(d);
      const client = createClient({ fetch });
      await expect(
        client.verifyServer("http://beacon-server:3000", { keepAddress: true }),
      ).resolves.toEqual({ origin: "http://beacon-server:3000", descriptor: d, verified: true });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("never takes an https address to http for the server's own name", async () => {
      const fetch = fetchReturning(signDescriptorFor("192.168.1.20:3001"));
      const entry = await createClient({ fetch }).verifyServer("https://alias.example");
      expect(entry.origin).toBe("https://alias.example");
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("refuses a blank address instead of asking the caller's own origin", async () => {
      const fetch = fetchReturning(signedTestDescriptor([]));
      await expect(createClient({ fetch }).verifyServer("   ")).rejects.toThrow(
        "no server address",
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it("throws the reason: a refusal, or a signature that does not check", async () => {
      await expect(
        createClient({ fetch: fetchReturning({}, 404) }).verifyServer(SRV),
      ).rejects.toBeInstanceOf(ApiError);
      const tampered = { ...signedTestDescriptor([]), name: "spoofed" };
      await expect(
        createClient({ fetch: fetchReturning(tampered) }).verifyServer(SRV),
      ).rejects.toThrow("does not verify");
    });
  });
});

describe("timeoutMs: null in the config", () => {
  it("survives the default: no signal reaches the fetch", async () => {
    const fetch = fetchReturning({ ok: true });
    await createClient({ fetch, timeoutMs: null }).getOrThrow(SRV, "/x");
    expect(sent(fetch).init.signal).toBeUndefined();
  });

  it("while an unset timeout still gets the default one", async () => {
    const fetch = fetchReturning({ ok: true });
    await createClient({ fetch }).getOrThrow(SRV, "/x");
    expect(sent(fetch).init.signal).toBeDefined();
  });
});
