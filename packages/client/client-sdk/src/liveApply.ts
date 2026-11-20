/**
 * Pure live-delta application (no socket, no React): the testable core of the live map channel
 * (`doc/spec/discovery.md` §6). Kept separate from the socket wiring (./live.ts) so the
 * viewport-filter rules can be unit-tested with plain objects.
 */
import type { Media, MapDelta } from "@beaconsgg/protocol-types";

/**
 * The map area the player sees in degrees of latitude and longitude, for {@link applyMapDelta}.
 *
 * `applyMapDelta` widens the area on every side before testing a point: by `roomMargin` of its span
 * for rooms (default 25%), and by `scoutMargin` for scouts (default 50%), which move into view
 * between updates.
 */
export interface Viewport {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
  /**
   * How far the area is widened on each side for rooms, as a fraction of its span. Defaults to
   * 0.25.
   */
  roomMargin?: number;
  /**
   * How far the area is widened on each side for scouts, as a fraction of its span. Defaults to
   * 0.5.
   */
  scoutMargin?: number;
}

// The default margins of a `Viewport`: scouts get the wider one, since they move into view.
const ROOM_MARGIN = 0.25;
const SCOUT_MARGIN = 0.5;

/** Is `(lat,lng)` inside `view` expanded by `pad` (fraction of span)? No view ⇒ always true. */
export function inViewport(
  view: Viewport | null,
  lat: number,
  lng: number,
  pad = ROOM_MARGIN,
): boolean {
  if (!view) return true;
  const latPad = (view.maxLat - view.minLat) * pad;
  const lngPad = (view.maxLng - view.minLng) * pad;
  return (
    lat >= view.minLat - latPad &&
    lat <= view.maxLat + latPad &&
    lng >= view.minLng - lngPad &&
    lng <= view.maxLng + lngPad
  );
}

/** Upsert `item` into `list` by `id` (append if new, replace in place if present). Deduped by id. */
export function upsertById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

/**
 * Drop `id` from `list`, returning the SAME list when it isn't there. The identity is the point:
 * removals arrive for things the map never held (a room outside the viewport, an ineligible
 * object on every one of its deltas), and a fresh array would republish the whole marker set to
 * native for nothing.
 */
export function removeById<T extends { id: string }>(list: T[], id: string): T[] {
  return list.some((x) => x.id === id) ? list.filter((x) => x.id !== id) : list;
}

/**
 * A room marker on the map: the room's id, position and display fields. Your `toRoom` function in
 * {@link applyMapDelta} builds one from a map update.
 */
export interface MapRoom {
  /** The room's `unique@host` id. */
  id: string;
  /** The room's type, as the game named it at placement. */
  type: string;
  lat: number;
  lng: number;
  /** The room's public summary fields, as the server sends them. */
  summary?: Record<string, unknown> | undefined;
  /** The origin of the room's live channel, for `client.subscribeRoom`. */
  live?: string | undefined;
  /** The room's thumbnail image, which your `toRoom` reads from the room summary. */
  thumb?: Media | undefined;
}

/**
 * The markers a live map holds: rooms, and scouts of your own type `S`. {@link applyMapDelta}
 * returns the next state.
 */
export interface MapState<S extends { id: string }> {
  rooms: MapRoom[];
  scouts: S[];
}

/**
 * Apply one update from the live map channel (`client.subscribeMap`) to the map's markers.
 *
 * A `room` or `scout` update adds or replaces the marker with the same `id` when the point is
 * inside the widened viewport (see {@link Viewport}). A room or scout that is not eligible is
 * removed instead. A `roomGone` or `scoutGone` update always removes the marker. Pass `null` as
 * `view` to keep every eligible marker.
 *
 * The viewport, and not the size of the channel's cells, decides what is drawn, so a coarse cell
 * never puts a room far off screen on the map (`doc/spec/discovery.md` §6).
 *
 * @param fns - Your functions: `toRoom` and `toScout` build markers, `scoutPosition` gives a
 * scout's current point (pass {@link scoutPosition}), and `roomEligible` and `scoutEligible` apply
 * the same rule your discovery read applies, such as your game's room types.
 * @returns The next state. The result is the same `state` object when the update changed nothing,
 * so you can skip a redraw. The result is `undefined` for an update kind this version does not
 * know: read discovery again to bring the markers up to date.
 */
export function applyMapDelta<S extends { id: string }>(
  state: MapState<S>,
  delta: MapDelta,
  view: Viewport | null,
  fns: {
    toRoom: (o: Extract<MapDelta, { kind: "room" }>["room"]) => MapRoom;
    toScout: (s: Extract<MapDelta, { kind: "scout" }>["scout"]) => S;
    scoutPosition: (s: Extract<MapDelta, { kind: "scout" }>["scout"]) => {
      lat: number;
      lng: number;
    };
    /**
     * Return `true` for a room that belongs on the map, with the same rule your discovery read
     * applies. A room that stops being eligible, such as a room that settles, is removed.
     */
    // Required on purpose: an optional filter that defaulted to "everything" is how the update path
    // once showed rooms that discovery filtered out.
    roomEligible: (o: Extract<MapDelta, { kind: "room" }>["room"]) => boolean;
    /** Return `true` for a scout that belongs on the map, such as a scout your game can read. */
    scoutEligible: (s: Extract<MapDelta, { kind: "scout" }>["scout"]) => boolean;
  },
): MapState<S> | undefined {
  switch (delta.kind) {
    case "room": {
      if (!fns.roomEligible(delta.room)) {
        const rooms = removeById(state.rooms, delta.room.id);
        return rooms === state.rooms ? state : { ...state, rooms };
      }
      const m = fns.toRoom(delta.room);
      if (!inViewport(view, m.lat, m.lng, view?.roomMargin)) return state;
      return { ...state, rooms: upsertById(state.rooms, m) };
    }
    case "roomGone": {
      const rooms = removeById(state.rooms, delta.id);
      return rooms === state.rooms ? state : { ...state, rooms };
    }
    case "scout": {
      if (!fns.scoutEligible(delta.scout)) {
        const scouts = removeById(state.scouts, delta.scout.id);
        return scouts === state.scouts ? state : { ...state, scouts };
      }
      const pos = fns.scoutPosition(delta.scout);
      if (!inViewport(view, pos.lat, pos.lng, view?.scoutMargin ?? SCOUT_MARGIN)) return state;
      return { ...state, scouts: upsertById(state.scouts, fns.toScout(delta.scout)) };
    }
    case "scoutGone": {
      const scouts = removeById(state.scouts, delta.id);
      return scouts === state.scouts ? state : { ...state, scouts };
    }
    default: {
      // A new MapDelta member must get a case above, or every one re-reads discovery. Still tolerant
      // at runtime: a newer server sends kinds this build never compiled against.
      const unfolded: never = delta;
      void unfolded;
      return undefined;
    }
  }
}
