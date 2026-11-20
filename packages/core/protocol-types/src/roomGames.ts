import { ANY_GAME, gameMayApply, type Room } from "./room";

// A server's routing and read filtering. Exported from `@beaconsgg/protocol-types/server` only: a
// game asks `gameMayApply` for the op it is about to send.

/**
 * List the games a room is open to: its own game and every game its op rules name. Returns
 * `[ANY_GAME]` when an op is open to every game.
 *
 * This is the listing form of {@link roomOpenToGame}, for a server routing a room's updates to the
 * games that may see them.
 */
export function roomGames(room: Pick<Room, "game" | "policy">): string[] {
  const games = new Set<string>(room.game === undefined ? [] : [room.game]);
  for (const rule of Object.values(room.policy.ops)) {
    for (const game of rule.games ?? []) {
      if (game === ANY_GAME) return [ANY_GAME];
      games.add(game);
    }
  }
  return [...games];
}

/**
 * Return `true` when `room` belongs to `game` or opens at least one op to it.
 *
 * A game-filtered read applies this rule: discovery, `GET /rooms/:id` and the live map show a game
 * the rooms it owns or may act on.
 */
export function roomOpenToGame(room: Pick<Room, "game" | "policy">, game: string): boolean {
  return (
    room.game === game || Object.keys(room.policy.ops).some((op) => gameMayApply(room, op, game))
  );
}
