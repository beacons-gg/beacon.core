import type {
  DeviceAuthorization,
  GameSlug,
  GlobalId,
  Identity,
  IsoTimestamp,
  OpEnvelope,
  Ulid,
  UnsignedOpEnvelope,
} from "@beaconsgg/protocol-types";
import {
  accountFromMnemonic,
  createAccount,
  createDevice,
  type Account,
  type Device,
} from "./account";
import { authorizeDevice, type DeviceAuthorizationOptions } from "./authorization";
import { signOp } from "./op";

/**
 * Everything needed to sign ops as a player: the account, one device key and the account root's
 * authorization of that device.
 *
 * Every signing method of the client takes a wallet. On a phone, get one from `loadOrCreateWallet`
 * in `@beaconsgg/client-sdk`. In a browser, use `passphraseVault`.
 */
export interface Wallet {
  /** The player's account, with its root key. */
  readonly account: Account;
  /** The device key that signs ops. */
  readonly device: Device;
  /** The account root's authorization of `device`. */
  readonly auth: DeviceAuthorization;
}

/** The options of {@link walletFromMnemonic}: the device's authorization, and the BIP39 passphrase. */
export interface MnemonicWalletOptions extends DeviceAuthorizationOptions {
  /**
   * The BIP39 passphrase the account was made with, as `accountFromMnemonic` takes it. A different
   * passphrase gives a different account without any error, so a mistyped passphrase looks like a
   * new, empty account. Leave it out unless your onboarding asks for it clearly.
   */
  passphrase?: string | undefined;
}

/**
 * Create a wallet for a new random account, with one new device key that the account authorizes.
 *
 * The account has no recovery phrase, which suits tests and bots. For a player, use
 * {@link walletFromMnemonic} with a phrase from `createRecoveryPhrase`.
 *
 * @param options - The device authorization's `issued` (defaults to now) and `expires` (leave it
 * out for no expiry).
 */
export function createWallet(options?: DeviceAuthorizationOptions): Wallet {
  const account = createAccount();
  const device = createDevice();
  return { account, device, auth: authorizeDevice(account, device.did, options) };
}

/**
 * Build a wallet from a recovery phrase: the account the phrase gives, and a new device key that
 * the account authorizes.
 *
 * Each call makes a new device key, while the account stays the same (`doc/spec/identity.md`
 * §10.1). Spaces around the phrase are ignored. Inside it the words must be lowercase and separated
 * by single spaces, so normalize typed input first.
 *
 * Every app uses this one rule from phrase to wallet, so the shape of a device authorization cannot
 * drift between apps.
 *
 * @param options - The device authorization's `issued` (defaults to now) and `expires`, and the
 * account's BIP39 `passphrase`. Leave `expires` out for no expiry, as on a phone that keeps the
 * device key in secure storage. A session that keeps no key, such as a browser tab, sets one.
 * @throws `Error` when `mnemonic` is not a valid phrase from the English word list.
 */
export function walletFromMnemonic(mnemonic: string, options: MnemonicWalletOptions = {}): Wallet {
  const account = accountFromMnemonic(mnemonic.trim(), options.passphrase);
  const device = createDevice();
  return { account, device, auth: authorizeDevice(account, device.did, options) };
}

/**
 * Return the public part of a wallet, as the wire carries it: the account and device `did:key`s
 * and the device's authorization.
 */
export function walletIdentity(wallet: Wallet): Identity {
  return { account: wallet.account.did, device: wallet.device.did, auth: wallet.auth };
}

/**
 * The parts of an op you choose, for {@link signOpWithWallet}. The wallet adds `actor`, `device`
 * and `auth`.
 */
export interface OpIntent {
  /** The op name, such as `place` or `take`. */
  op: string;
  /** A new ULID for each op. Reuse the nonce only to retry the same op. */
  nonce: Ulid;
  /** The op's params. */
  params: Record<string, unknown>;
  /** The `unique@host` id of the room the op acts on, for a room op. */
  room?: GlobalId;
  /** When the op was signed, as an ISO 8601 timestamp. Defaults to now. */
  issuedAt?: IsoTimestamp;
  /** The room version the op expects. The server refuses the op as `stale` when the room changed. */
  baseVersion?: number;
  /**
   * Your game's slug (`doc/game-author.md` §5.6). Every write from a game must carry the slug.
   * Leave the field out only for an operator console, which is not a game.
   */
  // The caller's rather than a wallet field, because one wallet can play several games. Omitted, the
  // key is absent from the signed bytes entirely.
  game?: GameSlug;
}

/**
 * Build an op envelope from `intent` and sign it with the wallet's device key.
 *
 * The client signs for you. Use this when you send an op without the client.
 */
export function signOpWithWallet(wallet: Wallet, intent: OpIntent): OpEnvelope {
  const unsigned: UnsignedOpEnvelope = {
    op: intent.op,
    actor: wallet.account.did,
    device: wallet.device.did,
    auth: wallet.auth,
    nonce: intent.nonce,
    issuedAt: intent.issuedAt ?? new Date().toISOString(),
    params: intent.params,
    ...(intent.room !== undefined ? { room: intent.room } : {}),
    ...(intent.baseVersion !== undefined ? { baseVersion: intent.baseVersion } : {}),
    ...(intent.game !== undefined ? { game: intent.game } : {}),
  };
  return signOp(unsigned, wallet.device.key.privateKey);
}
