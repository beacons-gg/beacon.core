// `@beaconsgg/protocol-types/server`: the helpers only a server needs. A server reads a client's
// declared markers and picks the code to send it, derives the markers it advertises from what it
// runs, and builds the refusal for params it cannot parse. Not in the root, which every game
// imports, so a game's bundle never carries them. They stay public for anyone who writes a server.

export { parseUnderstands, codeFor, type CodeForOptions } from "./understands";
export { CODE_FALLBACKS, NOT_FOUND_FALLBACKS, unknownFields, paramsRefusal } from "./result";
export { policyFeatures, opMarkers, policyMarkers, ruleMarkers } from "./markers";
export { roomGames, roomOpenToGame } from "./roomGames";
