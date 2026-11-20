/**
 * Shared SDK test fixtures: a descriptor REALLY signed by a server account, so `verifyDescriptor`
 * runs its true path, and a `fetch` double that answers JSON the way a server would.
 */
import { createAccount, signDescriptor } from "@beaconsgg/identity";
import type { ServerDescriptor } from "@beaconsgg/protocol-types";
import { vi, type Mock } from "vitest";
import type { WireFetch, WireRequest, WireResponse } from "../transport";

const serverAccount = createAccount();
const otherServerAccount = createAccount();

/** A really-signed descriptor for `srv.example`; `coverage: []` is the whole-world dev bypass. */
export function signedTestDescriptor(
  coverage: string[],
  capabilities?: string[],
): ServerDescriptor {
  return signDescriptor(serverAccount, {
    host: "srv.example",
    key: serverAccount.did,
    coverage,
    version: "0.0.1",
    startedAt: new Date().toISOString(),
    accessLevel: "open",
    updated: new Date().toISOString(),
    ...(capabilities ? { capabilities } : {}),
  });
}

/** A response with this status and JSON body. */
export function reply(body: unknown, status = 200): WireResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

/**
 * A platform reply: a real `Response` with this text body, a JSON content type unless `headers`
 * says otherwise, and a body stream, as a server's 5xx arrives.
 */
export function platformReply(
  body: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * What a reverse proxy in front of a server answers for a few seconds while the server restarts:
 * Traefik's plain-text 404, which says nothing about the room or route asked for.
 */
export function proxyNotFound(): Response {
  return platformReply("404 page not found", 404, { "content-type": "text/plain; charset=utf-8" });
}

/** A `fetch` answering every call with a new reply from `make`, since a body reads only once. */
export function fetchEach(make: () => WireResponse): Mock<WireFetch> {
  return vi.fn<WireFetch>().mockImplementation(() => Promise.resolve(make()));
}

/** A `fetch` answering every call with a new {@link proxyNotFound}. */
export function fetchProxyNotFound(): Mock<WireFetch> {
  return fetchEach(proxyNotFound);
}

/** A `fetch` answering every call with a new JSON {@link platformReply}. */
export function fetchPlatformReply(body: unknown, status: number): Mock<WireFetch> {
  return fetchEach(() => platformReply(JSON.stringify(body), status));
}

/** The body a read-only (locked) server answers every write with, at 503. */
export const LOCKED = { ok: false, error: "writeLocked", message: "the server is locked" };

/** A `fetch` double answering every call with `body` (at `status`), for URL and body assertions. */
export function fetchReturning(body: unknown, status = 200): Mock<WireFetch> {
  return vi.fn<WireFetch>().mockResolvedValue(reply(body, status));
}

/** The request `fetch` was handed on its `call`th call. */
export function sent(fetch: Mock<WireFetch>, call = 0): { url: string; init: WireRequest } {
  const args = fetch.mock.calls[call];
  if (!args) throw new Error(`fetch was not called ${call + 1} time(s)`);
  return { url: args[0], init: args[1] };
}

/** A descriptor for the same `srv.example` signed by a different account: a name that answers with another key. */
export function otherSignedDescriptor(coverage: string[]): ServerDescriptor {
  return signDescriptor(otherServerAccount, {
    host: "srv.example",
    key: otherServerAccount.did,
    coverage,
    version: "0.0.1",
    startedAt: new Date().toISOString(),
    accessLevel: "open",
    updated: new Date().toISOString(),
  });
}

/** A really-signed descriptor whose `host` is whatever the test needs, by the usual server account. */
export function signDescriptorFor(host: string): ServerDescriptor {
  return signDescriptor(serverAccount, {
    host,
    key: serverAccount.did,
    coverage: [],
    version: "0.0.1",
    startedAt: new Date().toISOString(),
    accessLevel: "open",
    updated: new Date().toISOString(),
  });
}
