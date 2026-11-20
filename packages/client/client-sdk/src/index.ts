/**
 * `@beaconsgg/client-sdk`: what any game's client needs to talk to a Beacon server, with the platform
 * pieces (`fetch`, the clock, the socket, the key store) handed in rather than imported.
 */

// ── transport: the timed fetch, the refusal and fault split, the errors a caller can catch ──
export {
  trimUrl,
  ApiError,
  ServerError,
  NetworkError,
  isRefusal,
  isFault,
  parseOrThrow,
  on404,
  fieldIssues,
  type FieldIssue,
  RequestTimeoutError,
  REQUEST_TIMEOUT_MS,
  type WireFetch,
  type WireRequest,
  type WireResponse,
} from "./transport";

// ── the client: signed writes, platform reads, mailbox, profiles, descriptor verify, game slug ──
export {
  createClient,
  type BeaconClient,
  type ClientConfig,
  type PlaceResult,
  type ScoutReportInput,
  type ScoutResult,
  type DiscoverOptions,
  type DeviceProbe,
  type RetryOptions,
  type VerifyServerOptions,
  type MediaPutResult,
  type ProposeResult,
  type MyProposalsResult,
  type MailboxSendResult,
  type MailboxFetchResult,
  type AccessReply,
  type MailboxAckResult,
} from "./client";

// ── live: the read-only sockets (opened through the client) and the pure delta rules ──
export {
  pushCells,
  DISCOVERY_POLL_MS,
  pollDiscovery,
  scoutPosition,
  type LiveConnect,
  type LiveSocket,
} from "./live";
export { applyMapDelta, type Viewport, type MapRoom, type MapState } from "./liveApply";

// ── wallet: key custody over an injected secure store, and the extra devices an account manages ──
export {
  loadOrCreateWallet,
  loadWallet,
  resetWallet,
  deleteWallet,
  importWalletFromPhrase,
  revealRecoveryPhrase,
  newDevice,
  deviceWallet,
  type SecureKeyStore,
  type ManagedDevice,
} from "./wallet";

// ── vault: custody without secure storage (an encrypted phrase, a fresh device per unlock) ──
export {
  passphraseVault,
  isWrongPassphrase,
  WrongPassphraseError,
  VAULT_SESSION_TTL_SEC,
  type PassphraseVault,
  type VaultConfig,
  type VaultCrypto,
} from "./vault";

// ── servers: the approved-server entry and routing over the registry's state ──
export {
  normalizeServerUrl,
  serversForCells,
  serversCovering,
  scoutReportServers,
  selectCoveringServer,
  serverHasCapability,
  serversWithCapability,
  serversForCellsWithCapability,
  selectMailboxHost,
  selectMediaHost,
  mailboxEndpoint,
  serverHost,
  serverLabel,
  serverEntryFor,
  mailboxOrigin,
  resolveServerForId,
  mediaUrl,
  type ServerEntry,
  type RouteOptions,
} from "./servers";

// ── registry: the approved-server list's state machine and the questions asked of it ──
export {
  emptyRegistry,
  registryOf,
  serverRegistryReducer,
  approvedServers,
  serverKeyRefused,
  hasApprovedServer,
  reportsScoutsEverywhere,
  reportsScoutsNowhere,
  relaysScoutsTo,
  receivesScoutReports,
  scoutRelayServers,
  toggleScoutRelay,
  serverSnapshotChanged,
  serverIdentityChanged,
  type ServerRegistryState,
  type ServerRegistryAction,
} from "./registry";
