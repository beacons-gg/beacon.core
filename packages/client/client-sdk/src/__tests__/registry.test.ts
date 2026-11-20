/**
 * registry.ts: the server registry reducer (`doc/spec/discovery.md` §7), the pure transitions
 * behind the approved server list: add/remove/dedupe, reorder (priority), the designated mailbox
 * host, the approved (verified) selector, and the gate predicate. No home server; list order =
 * priority.
 */
import type { ServerDescriptor } from "@beaconsgg/protocol-types";
import { describe, expect, it } from "vitest";
import {
  approvedServers,
  emptyRegistry,
  registryOf,
  hasApprovedServer,
  receivesScoutReports,
  relaysScoutsTo,
  reportsScoutsEverywhere,
  reportsScoutsNowhere,
  scoutRelayServers,
  serverKeyRefused,
  serverRegistryReducer,
  serverIdentityChanged,
  serverSnapshotChanged,
  toggleScoutRelay,
  type ServerRegistryState,
} from "../registry";
import { serversForCells, type ServerEntry } from "../servers";

const verified = (origin: string): ServerEntry => ({ origin, descriptor: null, verified: true });

const desc = (over: Partial<ServerDescriptor> = {}): ServerDescriptor =>
  ({
    host: "a.example",
    key: "did:key:zA",
    coverage: ["u1", "u2"],
    version: "0.0.1",
    startedAt: "2026-01-01T00:00:00.000Z",
    accessLevel: "open",
    updated: "2026-01-01T00:00:00.000Z",
    proof: {} as ServerDescriptor["proof"],
    ...over,
  }) as ServerDescriptor;

/** A verified entry at `http://a` with a full descriptor. */
const entry = (over: Partial<ServerDescriptor> = {}): ServerEntry => ({
  origin: "http://a",
  descriptor: desc(over),
  verified: true,
});
const unverified = (origin: string): ServerEntry => ({ origin, descriptor: null, verified: false });

describe("serverRegistryReducer — add", () => {
  it("appends a new server", () => {
    const s = serverRegistryReducer(emptyRegistry, { type: "add", entry: verified("http://a") });
    expect(s.servers).toHaveLength(1);
    expect(s.servers[0]?.origin).toBe("http://a");
  });

  it("never lets an unverified re-add replace a verified entry, or its pin with it", () => {
    const saved = serverRegistryReducer(emptyRegistry, { type: "add", entry: entry() });
    const failed = serverRegistryReducer(saved, { type: "add", entry: unverified("http://a") });
    expect(failed).toBe(saved);
    // A verified re-add (the player adding the address again, deliberately) still replaces it.
    const readded = serverRegistryReducer(saved, {
      type: "add",
      entry: entry({ key: "did:key:zB" }),
    });
    expect(readded.servers[0]?.descriptor?.key).toBe("did:key:zB");
  });

  it("dedupes by origin (re-adding replaces the record, e.g. after re-verification)", () => {
    const once = serverRegistryReducer(emptyRegistry, {
      type: "add",
      entry: unverified("http://a"),
    });
    const twice = serverRegistryReducer(once, { type: "add", entry: verified("http://a") });
    expect(twice.servers).toHaveLength(1);
    expect(twice.servers[0]?.verified).toBe(true);
  });

  it("folds the same server under another name into the entry it already has, in its place, designations carried", () => {
    // Saved by an alias first (the way an older build saved it, or a name the server's own one
    // could not answer from).
    let s = serverRegistryReducer(emptyRegistry, { type: "add", entry: verified("http://z") });
    s = serverRegistryReducer(s, {
      type: "add",
      entry: { ...entry(), origin: "https://alias.example" },
    });
    s = serverRegistryReducer(s, { type: "setMailbox", origin: "https://alias.example" });
    s = serverRegistryReducer(s, { type: "setScoutRelay", origins: ["https://alias.example"] });
    // Then the same key arrives under the server's own name.
    const folded = serverRegistryReducer(s, {
      type: "add",
      entry: { ...entry(), origin: "https://a.example" },
    });
    expect(folded.servers.map((e) => e.origin)).toEqual(["http://z", "https://a.example"]);
    expect(folded.mailboxOrigin).toBe("https://a.example");
    expect(folded.scoutRelay).toEqual(["https://a.example"]);
    // Another key under a new origin is simply another server.
    const other = serverRegistryReducer(folded, {
      type: "add",
      entry: { ...entry({ key: "did:key:zB" }), origin: "https://b.example" },
    });
    expect(other.servers).toHaveLength(3);
  });

  it("keeps multiple verified servers (the app talks to all of them)", () => {
    const a = serverRegistryReducer(emptyRegistry, { type: "add", entry: verified("http://a") });
    const ab = serverRegistryReducer(a, { type: "add", entry: verified("http://b") });
    expect(ab.servers).toHaveLength(2);
    expect(approvedServers(ab).map((e) => e.origin)).toEqual(["http://a", "http://b"]);
  });
});

describe("serverRegistryReducer — remove", () => {
  it("removes a server by origin", () => {
    let s: ServerRegistryState = emptyRegistry;
    s = serverRegistryReducer(s, { type: "add", entry: verified("http://a") });
    s = serverRegistryReducer(s, { type: "add", entry: verified("http://b") });
    s = serverRegistryReducer(s, { type: "remove", origin: "http://a" });
    expect(s.servers.map((e) => e.origin)).toEqual(["http://b"]);
  });
});

describe("serverRegistryReducer — move (priority order)", () => {
  const seed = (): ServerRegistryState => ({
    servers: [verified("http://a"), verified("http://b"), verified("http://c")],
  });
  const order = (s: ServerRegistryState): string[] => s.servers.map((e) => e.origin);

  it("moves a server up one slot (higher priority)", () => {
    expect(
      order(serverRegistryReducer(seed(), { type: "move", origin: "http://c", direction: "up" })),
    ).toEqual(["http://a", "http://c", "http://b"]);
  });

  it("moves a server down one slot", () => {
    expect(
      order(serverRegistryReducer(seed(), { type: "move", origin: "http://a", direction: "down" })),
    ).toEqual(["http://b", "http://a", "http://c"]);
  });

  it("is a no-op at the edges and for an unknown origin", () => {
    expect(
      order(serverRegistryReducer(seed(), { type: "move", origin: "http://a", direction: "up" })),
    ).toEqual(order(seed()));
    expect(
      order(serverRegistryReducer(seed(), { type: "move", origin: "http://c", direction: "down" })),
    ).toEqual(order(seed()));
    expect(
      order(serverRegistryReducer(seed(), { type: "move", origin: "http://z", direction: "up" })),
    ).toEqual(order(seed()));
  });

  it("moves a server to the top in one step, preserving the rest of the order", () => {
    expect(order(serverRegistryReducer(seed(), { type: "moveToTop", origin: "http://c" }))).toEqual(
      ["http://c", "http://a", "http://b"],
    );
  });

  it("moveToTop is a no-op for the already-first server and an unknown origin", () => {
    expect(order(serverRegistryReducer(seed(), { type: "moveToTop", origin: "http://a" }))).toEqual(
      order(seed()),
    );
    expect(order(serverRegistryReducer(seed(), { type: "moveToTop", origin: "http://z" }))).toEqual(
      order(seed()),
    );
  });
});

describe("serverRegistryReducer — mailbox host", () => {
  const two = (): ServerRegistryState => ({
    servers: [verified("http://a"), verified("http://b")],
  });

  it("designates and clears the mailbox host", () => {
    const set = serverRegistryReducer(two(), { type: "setMailbox", origin: "http://b" });
    expect(set.mailboxOrigin).toBe("http://b");
    const cleared = serverRegistryReducer(set, { type: "setMailbox", origin: null });
    expect(cleared.mailboxOrigin).toBeUndefined();
  });

  it("clears the mailbox host when its server is removed, keeps it when a different one is", () => {
    const set = serverRegistryReducer(two(), { type: "setMailbox", origin: "http://b" });
    expect(
      serverRegistryReducer(set, { type: "remove", origin: "http://b" }).mailboxOrigin,
    ).toBeUndefined();
    expect(serverRegistryReducer(set, { type: "remove", origin: "http://a" }).mailboxOrigin).toBe(
      "http://b",
    );
  });

  it("add + move preserve the designated mailbox host", () => {
    let s = serverRegistryReducer(two(), { type: "setMailbox", origin: "http://b" });
    s = serverRegistryReducer(s, { type: "add", entry: verified("http://c") });
    s = serverRegistryReducer(s, { type: "move", origin: "http://c", direction: "up" });
    expect(s.mailboxOrigin).toBe("http://b");
  });
});

describe("serverRegistryReducer — media host", () => {
  const two = (): ServerRegistryState => ({
    servers: [verified("http://a"), verified("http://b")],
  });

  it("designates and clears the media host independently of the mailbox host", () => {
    let s = serverRegistryReducer(two(), { type: "setMailbox", origin: "http://a" });
    s = serverRegistryReducer(s, { type: "setMedia", origin: "http://b" });
    expect(s.mediaOrigin).toBe("http://b");
    expect(s.mailboxOrigin).toBe("http://a"); // the two designations don't interfere
    const cleared = serverRegistryReducer(s, { type: "setMedia", origin: null });
    expect(cleared.mediaOrigin).toBeUndefined();
    expect(cleared.mailboxOrigin).toBe("http://a");
  });

  it("clears the media host when its server is removed, keeps it when a different one is", () => {
    const set = serverRegistryReducer(two(), { type: "setMedia", origin: "http://b" });
    expect(
      serverRegistryReducer(set, { type: "remove", origin: "http://b" }).mediaOrigin,
    ).toBeUndefined();
    expect(serverRegistryReducer(set, { type: "remove", origin: "http://a" }).mediaOrigin).toBe(
      "http://b",
    );
  });

  it("clears both designations when a server that is BOTH mailbox and media host is removed", () => {
    let s = serverRegistryReducer(two(), { type: "setMailbox", origin: "http://b" });
    s = serverRegistryReducer(s, { type: "setMedia", origin: "http://b" });
    const removed = serverRegistryReducer(s, { type: "remove", origin: "http://b" });
    expect(removed.mailboxOrigin).toBeUndefined();
    expect(removed.mediaOrigin).toBeUndefined();
  });
});

describe("serverRegistryReducer — scout relay (which servers scouts are reported to)", () => {
  const seed = (): ServerRegistryState => ({
    servers: [verified("http://a"), verified("http://b"), verified("http://c")],
  });

  it("defaults to every server, with the key genuinely absent", () => {
    const s = seed();
    expect(s.scoutRelay).toBeUndefined();
    expect(reportsScoutsEverywhere(s)).toBe(true);
    expect(reportsScoutsNowhere(s)).toBe(false); // absent is not empty
    expect(relaysScoutsTo(s, "http://a")).toBe(true);
    expect(scoutRelayServers(s).map((e) => e.origin)).toEqual(["http://a", "http://b", "http://c"]);
  });

  it("stores an explicit list, and an empty one means nowhere", () => {
    const only = serverRegistryReducer(seed(), { type: "setScoutRelay", origins: ["http://b"] });
    expect(reportsScoutsEverywhere(only)).toBe(false);
    expect(scoutRelayServers(only).map((e) => e.origin)).toEqual(["http://b"]);

    const none = serverRegistryReducer(seed(), { type: "setScoutRelay", origins: [] });
    expect(reportsScoutsEverywhere(none)).toBe(false);
    expect(reportsScoutsNowhere(none)).toBe(true);
    expect(scoutRelayServers(none)).toEqual([]);
  });

  it("null means off, as for the mailbox and media hosts: the empty list, not the default", () => {
    const off = serverRegistryReducer(seed(), { type: "setScoutRelay", origins: null });
    expect(off.scoutRelay).toEqual([]);
    expect(reportsScoutsNowhere(off)).toBe(true);
    expect(reportsScoutsEverywhere(off)).toBe(false);
    expect(scoutRelayServers(off)).toEqual([]);
  });

  it("resetScoutRelay restores the default (the key absent), which follows servers added later", () => {
    const only = serverRegistryReducer(seed(), { type: "setScoutRelay", origins: ["http://b"] });
    const back = serverRegistryReducer(only, { type: "resetScoutRelay" });
    expect("scoutRelay" in back).toBe(false);
    expect(reportsScoutsEverywhere(back)).toBe(true);
    const grown = serverRegistryReducer(back, { type: "add", entry: verified("http://d") });
    expect(relaysScoutsTo(grown, "http://d")).toBe(true);
  });

  it("only reports to a chosen server that is also VERIFIED", () => {
    const state: ServerRegistryState = {
      servers: [verified("http://a"), unverified("http://b")],
      scoutRelay: ["http://a", "http://b"],
    };
    expect(relaysScoutsTo(state, "http://b")).toBe(true); // the player chose it
    expect(receivesScoutReports(state, unverified("http://b"))).toBe(false); // ...it just can't receive yet
    expect(scoutRelayServers(state).map((e) => e.origin)).toEqual(["http://a"]);
  });

  it("receivesScoutReports is the conjunction every factual surface needs", () => {
    const chosenAndVerified: ServerRegistryState = {
      servers: [verified("http://a")],
      scoutRelay: ["http://a"],
    };
    expect(receivesScoutReports(chosenAndVerified, verified("http://a"))).toBe(true);

    const notChosen: ServerRegistryState = { servers: [verified("http://a")], scoutRelay: [] };
    expect(receivesScoutReports(notChosen, verified("http://a"))).toBe(false);

    // On the default every server is chosen, so verification is the only thing left to decide it.
    const onDefault: ServerRegistryState = {
      servers: [verified("http://a"), unverified("http://b")],
    };
    expect(receivesScoutReports(onDefault, verified("http://a"))).toBe(true);
    expect(receivesScoutReports(onDefault, unverified("http://b"))).toBe(false);
  });

  it("removing a chosen server PRUNES the list rather than clearing it (never widens the choice)", () => {
    const only = serverRegistryReducer(seed(), { type: "setScoutRelay", origins: ["http://b"] });
    const gone = serverRegistryReducer(only, { type: "remove", origin: "http://b" });
    expect(gone.scoutRelay).toEqual([]); // "only b" degrades to "nowhere"...
    expect(reportsScoutsEverywhere(gone)).toBe(false); // ...and NOT to "everywhere"
  });

  it("removing a server leaves the default alone", () => {
    const gone = serverRegistryReducer(seed(), { type: "remove", origin: "http://b" });
    expect(gone.scoutRelay).toBeUndefined();
  });

  it("adding a server is inherited on the default and ignored by an explicit list", () => {
    const added = serverRegistryReducer(seed(), { type: "add", entry: verified("http://d") });
    expect(relaysScoutsTo(added, "http://d")).toBe(true);

    const only = serverRegistryReducer(seed(), { type: "setScoutRelay", origins: ["http://b"] });
    const alsoAdded = serverRegistryReducer(only, { type: "add", entry: verified("http://d") });
    expect(relaysScoutsTo(alsoAdded, "http://d")).toBe(false);
  });
});

describe("toggleScoutRelay", () => {
  const seed = (): ServerRegistryState => ({
    servers: [verified("http://a"), verified("http://b"), verified("http://c")],
  });

  it("writes out the rest of the list when the first row is switched off", () => {
    expect(toggleScoutRelay(seed(), "http://b")).toEqual(["http://a", "http://c"]);
  });

  it("switches a row back on in priority order, not tap order", () => {
    const s: ServerRegistryState = { ...seed(), scoutRelay: ["http://c"] };
    expect(toggleScoutRelay(s, "http://a")).toEqual(["http://a", "http://c"]);
  });

  it("goes to and from the empty list one row at a time", () => {
    const s: ServerRegistryState = { ...seed(), scoutRelay: ["http://a"] };
    const off = toggleScoutRelay(s, "http://a");
    expect(off).toEqual([]);
    expect(toggleScoutRelay({ ...s, scoutRelay: off }, "http://c")).toEqual(["http://c"]);
  });

  it("ticking every row leaves an explicit list, NOT the follow-the-list default", () => {
    const s = seed();
    const off = toggleScoutRelay(s, "http://a");
    const backOn = toggleScoutRelay({ ...s, scoutRelay: off }, "http://a");
    expect(backOn).toEqual(["http://a", "http://b", "http://c"]);
    expect(reportsScoutsEverywhere({ ...s, scoutRelay: backOn })).toBe(false);
  });
});

describe("selectors", () => {
  it("approvedServers returns only the verified servers", () => {
    let s = serverRegistryReducer(emptyRegistry, { type: "add", entry: verified("http://a") });
    s = serverRegistryReducer(s, { type: "add", entry: unverified("http://b") });
    expect(approvedServers(s).map((e) => e.origin)).toEqual(["http://a"]);
    expect(hasApprovedServer(s)).toBe(true);
  });

  it("hasApprovedServer is false with no verified server", () => {
    const s = serverRegistryReducer(emptyRegistry, { type: "add", entry: unverified("http://a") });
    expect(hasApprovedServer(s)).toBe(false);
    expect(approvedServers(s)).toHaveLength(0);
  });

  it("replaces the whole state on rehydrate", () => {
    const seed: ServerRegistryState = { servers: [verified("http://x")] };
    const s = serverRegistryReducer(emptyRegistry, { type: "rehydrate", state: seed });
    expect(s).toEqual(seed);
  });
});

describe("serverSnapshotChanged", () => {
  it("ignores volatile fields — a re-signed / longer-running server is NOT a change", () => {
    const prev = entry({
      startedAt: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-01T00:00:00.000Z",
    });
    const next = entry({
      startedAt: "2026-02-02T00:00:00.000Z",
      updated: "2026-02-02T09:09:09.000Z",
    });
    expect(serverSnapshotChanged(prev, next)).toBe(false);
  });

  it("treats an unchanged descriptor as no change", () => {
    expect(serverSnapshotChanged(entry(), entry())).toBe(false);
  });

  it("detects a newly-advertised capability (e.g. mailbox)", () => {
    expect(
      serverSnapshotChanged(entry({ capabilities: [] }), entry({ capabilities: ["mailbox"] })),
    ).toBe(true);
  });

  it("ignores capability / coverage reordering (compared as sets)", () => {
    expect(
      serverSnapshotChanged(
        entry({ capabilities: ["mailbox", "media"] }),
        entry({ capabilities: ["media", "mailbox"] }),
      ),
    ).toBe(false);
    expect(
      serverSnapshotChanged(entry({ coverage: ["u1", "u2"] }), entry({ coverage: ["u2", "u1"] })),
    ).toBe(false);
  });

  it("detects coverage, version, and name changes", () => {
    expect(serverSnapshotChanged(entry(), entry({ coverage: ["u1"] }))).toBe(true);
    expect(serverSnapshotChanged(entry(), entry({ version: "0.0.2" }))).toBe(true);
    expect(serverSnapshotChanged(entry(), entry({ name: "Renamed" }))).toBe(true);
  });

  it("detects a verification change (unverified → verified upgrade)", () => {
    expect(serverSnapshotChanged(unverified("http://a"), verified("http://a"))).toBe(true);
  });
});

describe("serverIdentityChanged (the pin)", () => {
  it("is false for a fresh descriptor signed by the pinned key", () => {
    expect(serverIdentityChanged(entry(), entry({ coverage: ["u9"] }))).toBe(false);
  });

  it("is true for one signed by any other key", () => {
    expect(serverIdentityChanged(entry(), entry({ key: "did:key:zB" }))).toBe(true);
  });

  it("is false for an answer that did not verify, whatever key it claims", () => {
    expect(
      serverIdentityChanged(entry(), { ...entry({ key: "did:key:zB" }), verified: false }),
    ).toBe(false);
    expect(serverIdentityChanged(entry(), unverified("http://a"))).toBe(false);
  });

  it("pins nothing for a saved entry that never verified, so its first verified key is accepted", () => {
    expect(
      serverIdentityChanged({ ...entry(), verified: false }, entry({ key: "did:key:zB" })),
    ).toBe(false);
    expect(serverIdentityChanged(unverified("http://a"), entry({ key: "did:key:zB" }))).toBe(false);
  });
});

describe("a saved server refused for a changed key", () => {
  const A = "http://a";
  const B = "http://b";
  const seeded = (): ServerRegistryState => ({
    servers: [verified(A), verified(B)],
    mailboxOrigin: A,
    mediaOrigin: A,
  });
  const refuse = (s: ServerRegistryState, origin = A) =>
    serverRegistryReducer(s, { type: "identityChanged", origin });

  it("is recorded once, and only for a saved server", () => {
    let s = refuse(seeded());
    s = refuse(s);
    s = refuse(s, "http://unsaved");
    expect(s.identityChanged).toEqual([A]);
    expect(serverKeyRefused(s, A)).toBe(true);
    expect(serverKeyRefused(s, B)).toBe(false);
  });

  it("gets nothing routed to it, while its designations are kept for when it's accepted again", () => {
    const s = refuse(seeded());
    expect(approvedServers(s).map((e) => e.origin)).toEqual([B]);
    expect(scoutRelayServers(s).map((e) => e.origin)).toEqual([B]);
    expect(receivesScoutReports(s, verified(A))).toBe(false);
    expect(s.mailboxOrigin).toBe(A);
    expect(s.mediaOrigin).toBe(A);
    expect(hasApprovedServer(refuse(refuse(seeded()), B))).toBe(true); // still set up
  });

  it("is cleared by an entry written for it (a re-add, or a refresh that finds the pinned key)", () => {
    const s = serverRegistryReducer(refuse(seeded()), { type: "add", entry: verified(A) });
    expect(s).toEqual(seeded()); // the key genuinely absent again
    expect(approvedServers(s).map((e) => e.origin)).toEqual([A, B]);
  });

  it("stands when the re-add is refused (an unverified answer never replaces a verified entry)", () => {
    const s = serverRegistryReducer(refuse(seeded()), { type: "add", entry: unverified(A) });
    expect(s.identityChanged).toEqual([A]);
  });

  it("keeps the others listed when one is cleared", () => {
    const both = refuse(refuse(seeded()), B);
    expect(
      serverRegistryReducer(both, { type: "add", entry: verified(B) }).identityChanged,
    ).toEqual([A]);
  });

  it("goes with the server when it is removed", () => {
    const s = serverRegistryReducer(refuse(seeded()), { type: "remove", origin: A });
    expect(s).toEqual({ servers: [verified(B)] });
  });

  it("marks the entry itself, so routing over its entries alone skips it too", () => {
    const s = refuse(seeded());
    expect(s.servers).toEqual([{ ...verified(A), keyRefused: true }, verified(B)]);
    const covering = (state: ServerRegistryState) =>
      registryOf(state.servers.map((e) => ({ ...e, descriptor: desc({ coverage: [] }) })));
    expect(serversForCells(covering(s), ["u1"])).toEqual([B]);
  });

  it("reads a state saved before the mark the same way: rehydrate sets it from the list", () => {
    const saved: ServerRegistryState = { ...seeded(), identityChanged: [A] }; // as 0.3.2 saved it
    const s = serverRegistryReducer(emptyRegistry, { type: "rehydrate", state: saved });
    expect(s.servers).toEqual([{ ...verified(A), keyRefused: true }, verified(B)]);
    expect(s.identityChanged).toEqual([A]);
  });

  it("takes the list as the truth on rehydrate, so a mark an older build left behind goes", () => {
    // An older build accepted B again: it cleared the list but kept B's entry as it was.
    const saved: ServerRegistryState = {
      servers: [verified(A), { ...verified(B), keyRefused: true }],
    };
    const s = serverRegistryReducer(emptyRegistry, { type: "rehydrate", state: saved });
    expect(s.servers).toEqual([verified(A), verified(B)]);
  });

  it("is cleared even from an entry re-added with the mark on it", () => {
    const s = serverRegistryReducer(refuse(seeded()), {
      type: "add",
      entry: { ...verified(A), keyRefused: true },
    });
    expect(s).toEqual(seeded());
  });
});

describe("one usable rule for showing and routing", () => {
  it("leaves out an entry marked keyRefused even in a state with no identityChanged list", () => {
    const marked: ServerEntry = { ...verified("http://a"), keyRefused: true };
    const state = registryOf([marked, verified("http://b")]);
    expect(approvedServers(state).map((e) => e.origin)).toEqual(["http://b"]);
    expect(receivesScoutReports(state, marked)).toBe(false);
    expect(scoutRelayServers(state).map((e) => e.origin)).toEqual(["http://b"]);
  });
});
