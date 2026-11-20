/**
 * liveApply.ts, plus live.ts's pure helpers: viewport cells, viewport-filtered map-delta
 * application and the poll fallback. No socket, no network.
 */
import { cellsForView, liveCellsForView } from "@beaconsgg/geo";
import type { MapDelta } from "@beaconsgg/protocol-types";
import { describe, expect, it, vi } from "vitest";
import { pollDiscovery, scoutPosition } from "../live";
import { applyMapDelta, inViewport, upsertById, type MapState, type Viewport } from "../liveApply";

const SEATTLE = { minLat: 47.5, minLng: -122.45, maxLat: 47.7, maxLng: -122.25 };

describe("viewport cell computation (@beaconsgg/geo)", () => {
  it("cellsForView returns a bounded, non-empty cell set for a normal view", () => {
    const { cells, precision } = cellsForView(SEATTLE, 14);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(64);
    expect(precision).toBeGreaterThanOrEqual(1);
  });

  it("liveCellsForView caps a world-wide view (poll fallback), not a local one", () => {
    expect(liveCellsForView(SEATTLE).capped).toBe(false);
    const world = { minLat: -80, minLng: -170, maxLat: 80, maxLng: 170 };
    expect(liveCellsForView(world).capped).toBe(true);
  });
});

describe("inViewport / upsertById", () => {
  it("inViewport respects the pad margin and a null (no) view", () => {
    expect(inViewport(SEATTLE, 47.6, -122.35)).toBe(true);
    expect(inViewport(SEATTLE, 10, 10)).toBe(false);
    expect(inViewport(null, 10, 10)).toBe(true); // no view ⇒ everything is "in"
    // Just outside the raw bounds but within a 25% pad.
    const justOutside = 47.7 + (47.7 - 47.5) * 0.2;
    expect(inViewport(SEATTLE, justOutside, -122.35, 0.25)).toBe(true);
  });

  it("upsertById appends new items and replaces existing ones (dedupe by id)", () => {
    const a = upsertById<{ id: string; v: number }>([], { id: "x", v: 1 });
    expect(a).toHaveLength(1);
    const b = upsertById(a, { id: "x", v: 2 });
    expect(b).toHaveLength(1);
    expect(b[0]?.v).toBe(2);
    const c = upsertById(b, { id: "y", v: 9 });
    expect(c).toHaveLength(2);
  });
});

describe("map delta application (viewport filter)", () => {
  const summary = (
    id: string,
    lat: number,
    lng: number,
  ): Extract<MapDelta, { kind: "room" }>["room"] => ({
    id,
    type: "thing",
    location: { lat, lng },
  });
  const toMarker = (o: Extract<MapDelta, { kind: "room" }>["room"]) => ({
    id: o.id,
    type: o.type,
    lat: o.location.lat,
    lng: o.location.lng,
  });
  const identityScout = (s: { id: string }) => s;
  // Use the REAL wire-layer scoutPosition (wraps @beaconsgg/scout-interp) so the filter is fed the
  // position the client would actually render.
  const scoutPos = scoutPosition;

  const empty: MapState<{ id: string }> = { rooms: [], scouts: [] };
  /** The caller's four functions; `eligible` is what the vocabulary-owning caller supplies. */
  const apply = (
    state: MapState<{ id: string }>,
    delta: MapDelta,
    eligible: (o: Extract<MapDelta, { kind: "room" }>["room"]) => boolean = () => true,
    scoutEligible: (s: Extract<MapDelta, { kind: "scout" }>["scout"]) => boolean = () => true,
    view: Viewport = SEATTLE,
  ): MapState<{ id: string }> => {
    const next = applyMapDelta(state, delta, view, {
      toRoom: toMarker,
      toScout: identityScout as never,
      scoutPosition: scoutPos as never,
      roomEligible: eligible,
      scoutEligible,
    });
    if (next === undefined) throw new Error(`a known kind must fold: ${delta.kind}`);
    return next;
  };

  it("applies an in-view object upsert and dedupes by id", () => {
    const s1 = apply(empty, {
      cell: "u4pru",
      kind: "room",
      room: summary("o1", 47.6, -122.35),
    });
    expect(s1.rooms).toHaveLength(1);
    // Re-upsert same id (moved slightly) — still one marker.
    const s2 = apply(s1, { cell: "u4pru", kind: "room", room: summary("o1", 47.61, -122.34) });
    expect(s2.rooms).toHaveLength(1);
    expect(s2.rooms[0]?.lat).toBe(47.61);
  });

  it("drops an out-of-view object upsert (viewport filter, not cell size, decides)", () => {
    const s = apply(empty, { cell: "xxxxx", kind: "room", room: summary("far", 10, 10) });
    expect(s.rooms).toHaveLength(0);
  });

  it("ALWAYS applies a removal, even for an object we don't hold (no-op) and one we do", () => {
    const held: MapState<{ id: string }> = {
      rooms: [{ id: "o1", type: "thing", lat: 47.6, lng: -122.35 }],
      scouts: [],
    };
    const removed = apply(held, { cell: "u4pru", kind: "roomGone", id: "o1" });
    expect(removed.rooms).toHaveLength(0);
    // Removing an unknown id changes nothing — and says so by IDENTITY, so the live map can skip
    // republishing its whole marker set (deltas for things we don't hold are the common case).
    expect(apply(held, { cell: "u4pru", kind: "roomGone", id: "unknown" })).toBe(held);
  });

  it("an INELIGIBLE object is removed, never painted — the delta path can't leak what discovery filters", () => {
    const held: MapState<{ id: string }> = {
      rooms: [{ id: "o1", type: "challenge", lat: 47.6, lng: -122.35 }],
      scouts: [],
    };
    const delta: MapDelta = { cell: "u4pru", kind: "room", room: summary("o1", 47.6, -122.35) };
    // Held and now ineligible (a challenge that settled) → un-painted.
    expect(apply(held, delta, () => false).rooms).toHaveLength(0);
    // Never held and ineligible (a legacy room contributing all day) → unchanged, by identity.
    expect(apply(empty, delta, () => false)).toBe(empty);
    // Eligible → the ordinary upsert.
    expect(apply(empty, delta, () => true).rooms).toHaveLength(1);
  });

  const scoutDelta = (id: string, lat: number, lng: number): MapDelta => ({
    cell: "u4pru",
    kind: "scout",
    scout: {
      id,
      owner: { id: "did:key:zOwner" },
      config: {},
      mintedBy: { id: "did:key:z6MkStub", sig: "stub" },
      movement: {
        lastKnownLocation: { lat, lng },
        locationTimestamp: new Date().toISOString(),
        destination: { lat, lng },
        speedKmh: 30,
      },
      expiresAt: new Date().toISOString(),
    },
  });

  it("upserts an in-view scout and drops an out-of-view one; removals always apply", () => {
    expect(apply(empty, scoutDelta("s1", 47.6, -122.35)).scouts).toHaveLength(1);
    expect(apply(empty, scoutDelta("s2", 10, 10)).scouts).toHaveLength(0);

    const held: MapState<{ id: string }> = { rooms: [], scouts: [{ id: "s1" }] };
    expect(apply(held, { cell: "u4pru", kind: "scoutGone", id: "s1" }).scouts).toHaveLength(0);
  });

  it("widens the view by the margins the caller sets, 25% and 50% of the span by default", () => {
    // The view spans 0.2° of latitude up to 47.7: 47.74 is inside a quarter, 47.78 inside a half.
    const room = (lat: number) =>
      ({ cell: "u4pru", kind: "room", room: summary("o", lat, -122.35) }) as const;
    const yes = () => true;
    expect(apply(empty, room(47.74)).rooms).toHaveLength(1);
    expect(apply(empty, room(47.78)).rooms).toHaveLength(0);
    expect(apply(empty, room(47.74), yes, yes, { ...SEATTLE, roomMargin: 0 }).rooms).toHaveLength(
      0,
    );
    expect(apply(empty, room(47.78), yes, yes, { ...SEATTLE, roomMargin: 0.5 }).rooms).toHaveLength(
      1,
    );

    expect(apply(empty, scoutDelta("s", 47.78, -122.35)).scouts).toHaveLength(1);
    const narrow = { ...SEATTLE, scoutMargin: 0.25 };
    expect(apply(empty, scoutDelta("s", 47.78, -122.35), yes, yes, narrow).scouts).toHaveLength(0);
  });

  it("a scout the caller cannot read is never drawn, and one already held is removed", () => {
    const delta = scoutDelta("s1", 47.6, -122.35);
    // Ineligible and not held → nothing changed, the same state back.
    expect(apply(empty, delta, undefined, () => false)).toBe(empty);
    // Ineligible and held → removed, as `roomEligible` removes a room that turns ineligible.
    const held: MapState<{ id: string }> = { rooms: [], scouts: [{ id: "s1" }] };
    expect(apply(held, delta, undefined, () => false).scouts).toHaveLength(0);
  });
});

describe("an unknown map delta kind", () => {
  it("is not folded: the caller is told, so it can re-read discovery", () => {
    // A newer server's kind, say an object that moved.
    const moved = {
      cell: "u4pru",
      kind: "roomMoved",
      id: "o1",
      to: { lat: 47.61, lng: -122.34 },
    };
    expect(
      applyMapDelta({ rooms: [], scouts: [] }, moved as never, SEATTLE, {} as never),
    ).toBeUndefined();
  });
});

describe("pollDiscovery (capped-view fallback)", () => {
  it("invokes the poll on each interval and stops when disposed", () => {
    vi.useFakeTimers();
    const poll = vi.fn();
    const stop = pollDiscovery(poll, 1000);
    vi.advanceTimersByTime(3000);
    expect(poll).toHaveBeenCalledTimes(3);
    stop();
    vi.advanceTimersByTime(3000);
    expect(poll).toHaveBeenCalledTimes(3); // no more after stop
    vi.useRealTimers();
  });
});
