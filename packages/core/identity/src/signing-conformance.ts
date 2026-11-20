import type {
  DeviceAuthorization,
  DidKey,
  ProfileDoc,
  UnsignedOpEnvelope,
} from "@beaconsgg/protocol-types";
import type { ServerDescriptorBody } from "./descriptor";
import type { RoomBirth, ItemBirth, ScoutBirth } from "./provenance";

/**
 * The two fixed keys every vector is signed with, given both ways. `privateKey`/`publicKey` are the
 * raw Ed25519 material (hex), so an implementation can check its JCS and Ed25519 without BIP39. The
 * phrase and `did` pin `accountFromMnemonic`'s bespoke rule on top (the first 32 bytes of the BIP39
 * seed are the private key; not SLIP-0010).
 *
 * Fixed keys are how signature vectors work (RFC 8032 §7.1 publishes its secret keys too): Ed25519 is
 * deterministic, so a pinned signature needs a pinned key. These phrases were generated for this file
 * and identify nothing else in the repo, so a did found here is only ever a vector key. They are
 * public: never use them for anything real.
 */
export const SIGNING_VECTOR_KEYS = {
  /** The account root: signs authorizations, provenance, descriptors and profiles. */
  account: {
    mnemonic:
      "chief naive arrest curve maximum blossom enhance stairs practice concert tackle sheriff",
    did: "did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9",
    privateKey: "9a9e16b5a9e41f36de7be22f2d1c3337cbedd3a65278cbe38719e094b8f22523",
    publicKey: "5810498461f3310198c1819eaaaef29a245099ded862f839c787765828733bc6",
  },
  /** The device key the account authorizes: signs ops. */
  device: {
    mnemonic: "strategy simple apple either chef share enemy office giggle acquire goose minute",
    did: "did:key:z6MkvA7BbUeaH9b8DNGnb7NJaCufAXF6ykkBbRKbxYwUcRXP",
    privateKey: "6d987fc3abe948e55c734964ea4de1327550450823ff10bb9313fe04dc45b2d0",
    publicKey: "e95618c6077bade02c635999b339c5d357e6706b58252549e683346fbf432f6a",
  },
} as const;

/**
 * The instant every vector is verified at. It falls after every `issued`, `issuedAt`, `updated` and
 * `startedAt`, and before every `expires`. **Verify against this, never the wall clock:** one
 * authorization expires, and checked with the current time it would one day read as a broken signature.
 */
export const SIGNING_VECTOR_NOW = "2026-09-15T00:00:00.000Z";

interface VectorBase {
  name: string;
  /** The did:key whose private key produced `sig`. */
  signer: DidKey;
  /**
   * The exact object that is canonicalized and signed, written in non-canonical key order so that
   * canonicalizing it exercises the key sort. For provenance it is not `input`: the birth fields are
   * flattened and the `minter` is bound in.
   */
  signed: Record<string, unknown>;
  /** JCS (RFC 8785) of `signed`: the string that is UTF-8 encoded and signed. */
  signingInput: string;
  /** The expected Ed25519 signature over `signingInput`, base64url with no padding. */
  sig: string;
}

/**
 * One signed artifact, pinned to its bytes. `input` is what the exported signer for `kind` takes; the
 * signer must turn it into `signed`, canonicalize that to `signingInput`, and produce `sig`.
 */
export type SigningVector = VectorBase &
  (
    | { kind: "deviceAuthorization"; input: Omit<DeviceAuthorization, "sig"> }
    | { kind: "op"; input: UnsignedOpEnvelope }
    | { kind: "room"; input: RoomBirth }
    | { kind: "scout"; input: ScoutBirth }
    | { kind: "item"; input: ItemBirth }
    | { kind: "descriptor"; input: ServerDescriptorBody }
    | { kind: "profile"; input: Omit<ProfileDoc, "proof"> }
  );

const { account, device } = SIGNING_VECTOR_KEYS;

// Where a signer signs its input as is (authorizations, ops, descriptors, profiles), `signed` and
// `input` share one object below. Provenance `signed` objects are written out in full.

const authorizationBody = {
  authorizes: device.did,
  account: account.did,
  issued: "2026-09-14T00:00:00.000Z",
};

const expiringAuthorizationBody = { ...authorizationBody, expires: "2027-09-14T00:00:00.000Z" };

/** The authorization the op and profile vectors carry, itself pinned by the first vector. */
const authorization: DeviceAuthorization = {
  ...authorizationBody,
  sig: "qCcALcsUqryXF7IPiXh48QJ28K6XwqvVFbScUBLm91YUz8OFf1mY-kE1f8WzEVXaJReNA6s64lZEZ7XCcJnpBA",
};

const boxPolicy = {
  type: "box",
  ops: { contribute: { role: "contributor" as const, max: 1 } },
  claimTtl: "7d",
  maxContributors: 4,
};

/** The room vector's signature, which the `place` op carries as its `mintedBy`. */
const roomSig =
  "WddezLciecSn7BZpHkIcdbgAu_G2ys7h1-NBMsHUpi29cftuzTAKFesPrnn1PE_rIzQWAFWeaVRzd6i1EiOfCg";

const addOp: UnsignedOpEnvelope = {
  op: "add",
  room: "01J8XR4M0NQ9Z6T2W3K4Y5B7CD@beacon.example",
  actor: account.did,
  device: device.did,
  auth: authorization,
  nonce: "01K52A7Q3V9M8XH2B6T4R0N1ZE",
  issuedAt: "2026-09-14T12:00:00.000Z",
  baseVersion: 3,
  params: { unique: "01K52A7Q3V9M8XH2B6T4R0N1ZF" },
};

const addOpWithGame: UnsignedOpEnvelope = { ...addOp, game: "example" };

const placeOp: UnsignedOpEnvelope = {
  op: "place",
  actor: account.did,
  device: device.did,
  auth: authorization,
  game: "example",
  nonce: "01K52A7Q3V9M8XH2B6T4R0N1ZN",
  issuedAt: "2026-09-14T12:00:00.000Z",
  params: {
    type: "box",
    unique: "01K52A7Q3V9M8XH2B6T4R0N1ZG",
    mintedBy: { id: account.did, sig: roomSig },
    location: { lat: 37.7749, lng: -122.4194 },
    policy: boxPolicy,
  },
};

const descriptorBody: ServerDescriptorBody = {
  host: "beacon.example",
  key: account.did,
  coverage: ["9q8", "c2"],
  name: "Test Server",
  description: "A server for signing vectors",
  contact: "ops@beacon.example",
  version: "0.0.1",
  startedAt: "2026-09-14T00:00:00.000Z",
  accessLevel: "open",
  capabilities: ["mailbox", "media", "game-slug"],
  updated: "2026-09-14T00:00:00.000Z",
};

const profileBody: Omit<ProfileDoc, "proof"> = {
  id: account.did,
  version: 2,
  handles: ["zoe@beacon.example"],
  displayName: "Zoë 🦊",
  avatar: "emoji:🦊",
  devices: [{ key: device.did, auth: { issued: authorization.issued, sig: authorization.sig } }],
  revoked: ["did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"],
  services: [{ type: "mailbox", endpoint: "https://beacon.example" }],
  updated: "2026-09-14T00:00:00.000Z",
};

const fullMedia = [
  {
    type: "image",
    role: "full",
    hash: "hFull",
    uris: ["hFull@beacon.example"],
    credit: { author: "Zoë", license: "CC-BY-4.0" },
  },
  { type: "image", role: "thumb", hash: "hThumb", uris: ["hThumb@beacon.example"] },
];

/**
 * The signing test-vector suite: the canonical bytes and signatures every signed artifact in the
 * protocol must reproduce. A `canonicalize` bump, a refactor of a birth-field selection, or a
 * second implementation that changes these bytes would make every existing signature stop verifying,
 * and nothing else notices until real items fail.
 *
 * **Never regenerate a vector to make it pass.** A changed byte here is a wire break, not a test to
 * update. Adding a vector is always safe. Changing a vector's example data means re-signing it, so it
 * lands alone, in a change that touches no signer.
 */
export const SIGNING_VECTORS: readonly SigningVector[] = [
  // ── device authorizations ──
  {
    name: "device authorization, no expiry",
    kind: "deviceAuthorization",
    signer: account.did,
    input: authorizationBody,
    signed: authorizationBody,
    signingInput:
      '{"account":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","authorizes":"did:key:z6MkvA7BbUeaH9b8DNGnb7NJaCufAXF6ykkBbRKbxYwUcRXP","issued":"2026-09-14T00:00:00.000Z"}',
    sig: authorization.sig,
  },
  {
    name: "device authorization with an offline expiry",
    kind: "deviceAuthorization",
    signer: account.did,
    input: expiringAuthorizationBody,
    signed: expiringAuthorizationBody,
    signingInput:
      '{"account":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","authorizes":"did:key:z6MkvA7BbUeaH9b8DNGnb7NJaCufAXF6ykkBbRKbxYwUcRXP","expires":"2027-09-14T00:00:00.000Z","issued":"2026-09-14T00:00:00.000Z"}',
    sig: "snTWeJgF4Skn5NtavAO_OfqSY7XYcd9Y4U8zyG5YooKQSmIoq90JM_HZQocTpUzmG2uuU3jHgiwF853EZdlPCw",
  },

  // ── ops (signed by the device, not the account) ──
  {
    name: "op without a game slug",
    kind: "op",
    signer: device.did,
    input: addOp,
    signed: addOp,
    signingInput:
      '{"actor":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","auth":{"account":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","authorizes":"did:key:z6MkvA7BbUeaH9b8DNGnb7NJaCufAXF6ykkBbRKbxYwUcRXP","issued":"2026-09-14T00:00:00.000Z","sig":"qCcALcsUqryXF7IPiXh48QJ28K6XwqvVFbScUBLm91YUz8OFf1mY-kE1f8WzEVXaJReNA6s64lZEZ7XCcJnpBA"},"baseVersion":3,"device":"did:key:z6MkvA7BbUeaH9b8DNGnb7NJaCufAXF6ykkBbRKbxYwUcRXP","issuedAt":"2026-09-14T12:00:00.000Z","nonce":"01K52A7Q3V9M8XH2B6T4R0N1ZE","op":"add","params":{"unique":"01K52A7Q3V9M8XH2B6T4R0N1ZF"},"room":"01J8XR4M0NQ9Z6T2W3K4Y5B7CD@beacon.example"}',
    sig: "hzyxq3rwnhJi_V-gxbUD9o3yiidTGlvoDEFraRGt4T6aNRHGeLRGW-KOF7xuySHctAvsAOfIo9AxghXrYCyqBQ",
  },
  {
    name: "op with a game slug",
    kind: "op",
    signer: device.did,
    input: addOpWithGame,
    signed: addOpWithGame,
    signingInput:
      '{"actor":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","auth":{"account":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","authorizes":"did:key:z6MkvA7BbUeaH9b8DNGnb7NJaCufAXF6ykkBbRKbxYwUcRXP","issued":"2026-09-14T00:00:00.000Z","sig":"qCcALcsUqryXF7IPiXh48QJ28K6XwqvVFbScUBLm91YUz8OFf1mY-kE1f8WzEVXaJReNA6s64lZEZ7XCcJnpBA"},"baseVersion":3,"device":"did:key:z6MkvA7BbUeaH9b8DNGnb7NJaCufAXF6ykkBbRKbxYwUcRXP","game":"example","issuedAt":"2026-09-14T12:00:00.000Z","nonce":"01K52A7Q3V9M8XH2B6T4R0N1ZE","op":"add","params":{"unique":"01K52A7Q3V9M8XH2B6T4R0N1ZF"},"room":"01J8XR4M0NQ9Z6T2W3K4Y5B7CD@beacon.example"}',
    sig: "v7UsAX9lGrlf-UgXQ3ImpHmFpTRSo5kQyPenxvMg9or6DU5VDPVu_urf9gOyGGybYATMBhuaqgxC5_3svue8Ag",
  },
  {
    // A place op signs float coordinates, so ES number serialization is on the wire (RFC 8785 §3.2.2.3).
    name: "place op with a location",
    kind: "op",
    signer: device.did,
    input: placeOp,
    signed: placeOp,
    signingInput:
      '{"actor":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","auth":{"account":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","authorizes":"did:key:z6MkvA7BbUeaH9b8DNGnb7NJaCufAXF6ykkBbRKbxYwUcRXP","issued":"2026-09-14T00:00:00.000Z","sig":"qCcALcsUqryXF7IPiXh48QJ28K6XwqvVFbScUBLm91YUz8OFf1mY-kE1f8WzEVXaJReNA6s64lZEZ7XCcJnpBA"},"device":"did:key:z6MkvA7BbUeaH9b8DNGnb7NJaCufAXF6ykkBbRKbxYwUcRXP","game":"example","issuedAt":"2026-09-14T12:00:00.000Z","nonce":"01K52A7Q3V9M8XH2B6T4R0N1ZN","op":"place","params":{"location":{"lat":37.7749,"lng":-122.4194},"mintedBy":{"id":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","sig":"WddezLciecSn7BZpHkIcdbgAu_G2ys7h1-NBMsHUpi29cftuzTAKFesPrnn1PE_rIzQWAFWeaVRzd6i1EiOfCg"},"policy":{"claimTtl":"7d","maxContributors":4,"ops":{"contribute":{"max":1,"role":"contributor"}},"type":"box"},"type":"box","unique":"01K52A7Q3V9M8XH2B6T4R0N1ZG"}}',
    sig: "yqraq5IWkFblT0Hz04DW-HNdtA2deD1lQ9zgDBpI0J_la7X4kFzCB5BQZh2mqa4yoPRdEPllkpvH4f1rSMZFAA",
  },

  // ── provenance (`mintedBy`): the signed object is `{ ...birthFields, minter }` ──
  {
    name: "room birth",
    kind: "room",
    signer: account.did,
    input: { unique: "01K52A7Q3V9M8XH2B6T4R0N1ZG", kind: "box", policy: boxPolicy },
    signed: {
      unique: "01K52A7Q3V9M8XH2B6T4R0N1ZG",
      kind: "box",
      policy: boxPolicy,
      minter: account.did,
    },
    signingInput:
      '{"kind":"box","minter":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","policy":{"claimTtl":"7d","maxContributors":4,"ops":{"contribute":{"max":1,"role":"contributor"}},"type":"box"},"unique":"01K52A7Q3V9M8XH2B6T4R0N1ZG"}',
    sig: roomSig,
  },
  {
    name: "scout birth",
    kind: "scout",
    signer: account.did,
    input: {
      unique: "01K52A7Q3V9M8XH2B6T4R0N1ZH",
      config: {
        type: "survey",
        label: "Survey Scout",
        speedTier: 5,
        rangeMi: 1200,
        slots: 6,
      },
    },
    signed: {
      unique: "01K52A7Q3V9M8XH2B6T4R0N1ZH",
      config: {
        type: "survey",
        label: "Survey Scout",
        speedTier: 5,
        rangeMi: 1200,
        slots: 6,
      },
      minter: account.did,
    },
    signingInput:
      '{"config":{"label":"Survey Scout","rangeMi":1200,"slots":6,"speedTier":5,"type":"survey"},"minter":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","unique":"01K52A7Q3V9M8XH2B6T4R0N1ZH"}',
    sig: "xUDMlLZI9C_kVUGcSfi6ZebU5IoET-AdPRFtH1wJrpgBeXpu-6pC1aLrexeqiuWqsrGzIW0z68RE9mjlu8c5Cg",
  },
  {
    name: "item birth, one base level",
    kind: "item",
    signer: account.did,
    input: {
      unique: "01K52A7Q3V9M8XH2B6T4R0N1ZJ",
      birth: { class: "ColorSample", baseLevels: { hue: 200 } },
    },
    signed: {
      class: "ColorSample",
      baseLevels: { hue: 200 },
      unique: "01K52A7Q3V9M8XH2B6T4R0N1ZJ",
      minter: account.did,
    },
    signingInput:
      '{"baseLevels":{"hue":200},"class":"ColorSample","minter":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","unique":"01K52A7Q3V9M8XH2B6T4R0N1ZJ"}',
    sig: "V54p2Z513cWKIFs7NkMMjE7mOLZvjyenXPkg4uJDFqINL-oDUQDWuqRnc4_QbLAO08zeItiat5S3ghvfzhYjDw",
  },
  {
    name: "item birth, a class and base levels only",
    kind: "item",
    signer: account.did,
    input: {
      unique: "01K52A7Q3V9M8XH2B6T4R0N1ZK",
      birth: { class: "Widget", baseLevels: { alpha: 4, beta: 3, gamma: 2 } },
    },
    signed: {
      class: "Widget",
      baseLevels: { alpha: 4, beta: 3, gamma: 2 },
      unique: "01K52A7Q3V9M8XH2B6T4R0N1ZK",
      minter: account.did,
    },
    signingInput:
      '{"baseLevels":{"alpha":4,"beta":3,"gamma":2},"class":"Widget","minter":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","unique":"01K52A7Q3V9M8XH2B6T4R0N1ZK"}',
    sig: "hDbx7bfVN-QFDJKmkuvVOyciiO-GnlqMpJ8Jr2MZ3iRwq3hbwCakd3i5CgzSx9-og2DvXZ-Fl9-xRv4CHFsaCg",
  },
  {
    // Eight birth fields, with nested objects, a media list and non-ASCII text, plus the escapes JCS
    // mandates (a quote, a newline and a C0 control character, lowercase ``).
    name: "item birth, nested objects, media and escaped text",
    kind: "item",
    signer: account.did,
    input: {
      unique: "01K52A7Q3V9M8XH2B6T4R0N1ZM",
      birth: {
        class: "Widget",
        baseLevels: { alpha: 2, beta: 24, gamma: 3 },
        subClass: { source: "camera" },
        tags: { color: ["teal", "blue"] },
        media: fullMedia,
        foundAt: "9q8yyk8",
        mintedAt: "2026-09-14T12:00:00.000Z",
        description: 'a teal wall, «after rain» "wet"\n 🌧',
      },
    },
    signed: {
      class: "Widget",
      baseLevels: { alpha: 2, beta: 24, gamma: 3 },
      subClass: { source: "camera" },
      tags: { color: ["teal", "blue"] },
      media: fullMedia,
      foundAt: "9q8yyk8",
      mintedAt: "2026-09-14T12:00:00.000Z",
      description: 'a teal wall, «after rain» "wet"\n 🌧',
      unique: "01K52A7Q3V9M8XH2B6T4R0N1ZM",
      minter: account.did,
    },
    signingInput:
      '{"baseLevels":{"alpha":2,"beta":24,"gamma":3},"class":"Widget","description":"a teal wall, «after rain» \\"wet\\"\\n\\u001f 🌧","foundAt":"9q8yyk8","media":[{"credit":{"author":"Zoë","license":"CC-BY-4.0"},"hash":"hFull","role":"full","type":"image","uris":["hFull@beacon.example"]},{"hash":"hThumb","role":"thumb","type":"image","uris":["hThumb@beacon.example"]}],"mintedAt":"2026-09-14T12:00:00.000Z","minter":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","subClass":{"source":"camera"},"tags":{"color":["teal","blue"]},"unique":"01K52A7Q3V9M8XH2B6T4R0N1ZM"}',
    sig: "XHEu7kQ6AJvqGfYrd_OsCKyYgM6zg9M8LTjyzZknblXFaXrfJZhA56H6zwm4Klmzlq9FbNtezEa1FLA4bjpaDw",
  },

  // ── published documents: the signed object is the body without `proof` ──
  {
    name: "server descriptor",
    kind: "descriptor",
    signer: account.did,
    input: descriptorBody,
    signed: descriptorBody,
    signingInput:
      '{"accessLevel":"open","capabilities":["mailbox","media","game-slug"],"contact":"ops@beacon.example","coverage":["9q8","c2"],"description":"A server for signing vectors","host":"beacon.example","key":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","name":"Test Server","startedAt":"2026-09-14T00:00:00.000Z","updated":"2026-09-14T00:00:00.000Z","version":"0.0.1"}',
    sig: "WcnyUM3PdRHLIdFeUW2C8fOotZ60wI71HJKmn4pwa-c_BZhROHgGA7Jft20qS3n3b2ivmX30fyOTvuZ3dXl8Dg",
  },
  {
    // A device entry drops `authorizes` and `account`, which the doc already implies.
    name: "profile document",
    kind: "profile",
    signer: account.did,
    input: profileBody,
    signed: profileBody,
    signingInput:
      '{"avatar":"emoji:🦊","devices":[{"auth":{"issued":"2026-09-14T00:00:00.000Z","sig":"qCcALcsUqryXF7IPiXh48QJ28K6XwqvVFbScUBLm91YUz8OFf1mY-kE1f8WzEVXaJReNA6s64lZEZ7XCcJnpBA"},"key":"did:key:z6MkvA7BbUeaH9b8DNGnb7NJaCufAXF6ykkBbRKbxYwUcRXP"}],"displayName":"Zoë 🦊","handles":["zoe@beacon.example"],"id":"did:key:z6MkkP2KwSLsFRvob7BvvHW1HS689YhD4bRofDGH541P3CN9","revoked":["did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"],"services":[{"endpoint":"https://beacon.example","type":"mailbox"}],"updated":"2026-09-14T00:00:00.000Z","version":2}',
    sig: "Cz39wUUv0LJH-K00gcjpgeP7KxnocC5Iq1QeWhEjhUNux5zPE7ve3cWiFFd4BSYy_6bNXqbWyCgF2XztAD2BBg",
  },
];
