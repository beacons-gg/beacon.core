# Mailbox client

How a client uses a server's mailbox: where a player's mailbox lives, how the client sends and
reads mail and how the live channel pushes new mail while the game is open. `@beaconsgg/client-sdk`
implements the client side. The mailbox and media spec in `doc/spec/` of the Beacon server
repository covers the server side: the mailbox's model, routes, limits and storage.

Checked against Beacon 0.3.

## 0. Overview

A mailbox lets one player reach another who may not be connected. A typical use is a short note sent
to a player whose room or profile is on screen. The mailbox has no contact list and no first-contact
gate.

Delivery has two paths. While the game is open the client holds a live socket, and the server
pushes new mail to it. A signed `POST /mailbox/fetch` catches up on a cold start and after a
reconnect, and serves as the fallback when the socket is down.

### 0.1 Transport rule

The live socket carries events from the server to the client only. Every state change is a REST
`POST` with a signed envelope.

- `mailbox:subscribe` is a control message. The client signs the message to prove who is joining.
  The subscribe joins a fan-out room and changes no state.
- Sending and acknowledging mail are REST calls (§5). No op is ever applied over the socket.
- Mailbox requests go to their own paths and never to `/rooms/:id/ops`. The client's `postSigned`
  signs an envelope with no `room` and posts the envelope to such a path. Placement, the scout relay
  and the places routes use the same helper.
- The server never parses a message body. The server checks the envelope and stores the body as
  opaque text.

## 2. The server contract

Every mailbox request is a signed op envelope. The server takes the actor from the signature, so a
send is attributed and a read is limited to the verified reader. Mail is kept per game, and the
envelope's `game` names the game.

| Op                  | Transport                        | Params         | Answer                            |
| ------------------- | -------------------------------- | -------------- | --------------------------------- |
| `mailbox.send`      | `POST /mailbox`                  | `{ to, body }` | `{ ok, id }`, idempotent by nonce |
| `mailbox.fetch`     | `POST /mailbox/fetch`            | `{}`           | `{ ok, messages }`                |
| `mailbox.ack`       | `POST /mailbox/ack`              | `{ ids }`      | `{ ok, deleted }`                 |
| `mailbox.subscribe` | socket event `mailbox:subscribe` | `{}`           | `{ ok }`, then `mail` events      |

A message is `{ id, from, body, receivedAt, expiresAt }`. The server sets the time to live and the
largest body. The default body limit is 256 bytes of UTF-8. The wire schema caps a body at 4096
bytes of UTF-8 whatever the server's setting, and `mailboxBodyBytes` measures a body in that unit.

## 3. The live channel

The server runs the mailbox live channel on its own socket.io namespace, `/mailbox`. The public room
and map channel is a separate namespace. Keeping the two apart keeps a private, signed channel out of
the public one.

A client subscribes with a signed envelope:

```jsonc
// the client emits mailbox:subscribe:
{ "env": { "op": "mailbox.subscribe", "params": {} } } // a full signed envelope, abbreviated here
// the server acknowledges:
{ "ok": true }
```

The server passes the envelope through the same gate as a REST request. The gate checks the op name,
the signature, `issuedAt` freshness, the blocklist and revocation
([identity §5.2](identity.md#52-verification)). The server then joins the socket to a room keyed on
the verified actor DID and the envelope's game. A subscribe that names no game is refused with
`gameNotAdmitted`.

**The subscribe needs no nonce check.** The room is keyed on the DID the signature proves. A replayed
or forged subscribe can only rejoin the mailbox of whoever holds the signing key, and the freshness
window bounds a replay.

**A socket serves one identity at a time.** A subscribe that passes the gate leaves any earlier
mailbox room before it joins the new one. A subscribe the gate refuses leaves the socket in the room
it was already in.

**The server pushes after it stores.** The server emits `mail` to the recipient's room once the
message is in the database. A retried send that the store dedupes isn't pushed again. A late or lost push costs liveness and never
consistency, because the recipient's next fetch returns the message.

## 5. The REST calls

The client SDK exposes one function for each op:

- `sendMail(server, wallet, to, body)` posts `mailbox.send` to the recipient's mailbox host.
- `fetchMail(server, wallet)` posts `mailbox.fetch` with a fresh nonce on every call. A reused read
  nonce answers `409`, so a captured read can't be replayed.
- `ackMail(server, wallet, ids)` posts `mailbox.ack` to delete delivered messages.
- `buildMailboxSubscribe(wallet)` signs the `mailbox.subscribe` envelope for the socket.

Every call signs a new envelope with a fresh ULID nonce.

## 6. The mailbox host

A player names the server that holds their mailbox in their signed profile, as a `services` entry:

```jsonc
"services": [{ "type": "mailbox", "endpoint": "beacon.example" }]
```

- **Publishing.** The endpoint is the player's chosen host, stored without a scheme as `host` or
  `host:port`. `mailboxEndpoint(origin)` strips the scheme when the client publishes. Changing the
  host means publishing a new profile version.
- **Resolving.** To send mail, a client fetches the recipient's profile and verifies the profile. The
  client then reads the `mailbox` entry. `mailboxOrigin(endpoint)` rebuilds an origin with `https`. A
  loopback, private-network or `.local` host gets `http`. A recipient with no mailbox
  entry can't receive mail.
- **No default host.** The player picks a mailbox host, which the registry keeps as
  `mailboxOrigin`. `selectMailboxHost(state)` honors the choice only while that server is still
  verified and still advertises the `mailbox` capability. Otherwise the
  result is `undefined`, and mail is off until the player picks another host. Removing the server from
  the list clears the choice.

The media host follows the same choice rule (`selectMediaHost`). The media host is only a local
upload preference and isn't published, because a media address already names its host.

## 7. Message bodies

The body belongs to the game. Beacon defines no message catalog. A game encodes a small template id
and payload into the body and decodes it against its own catalog on the receiving side. A client
should render an unknown template as an unsupported message. Template bodies keep messages small,
and they leave the server only volume to police.

## 8. Client delivery

`subscribeMailbox(host, buildSubscribe, onMail, onReconnect)` opens the `/mailbox` namespace on the
player's own mailbox host:

1. On connect and on every reconnect, the client emits `mailbox:subscribe` with a freshly signed
   envelope.
2. Each `mail` event calls `onMail` with the message.
3. On a reconnect the client also calls `onReconnect`. The caller runs a `mailbox.fetch` catch-up
   there and merges the result by `id`, because the socket pushes only what arrives while the socket
   is subscribed.

A client should keep the socket open only while the game is in the foreground. A client should also
acknowledge each message once the player has seen the message. When the socket can't connect, the
client polls `mailbox.fetch` at a low rate while the game is in the foreground.

## 10. Errors and privacy

- **Best effort.** A failed send or an unreachable mailbox host is a message to the player and never
  a crash.
- **Status codes.** The server answers with a status and an error code:

  | Status | Error code                  | Meaning                                                    |
  | ------ | --------------------------- | ---------------------------------------------------------- |
  | `400`  | `invalid`                   | a malformed envelope, the wrong op name or bad params      |
  | `400`  | `clockSkew`                 | `issuedAt` is more than five minutes from the server clock |
  | `401`  | `badsig`                    | the signature doesn't verify                               |
  | `403`  | `denied` or `deviceRevoked` | the sender is blocked or the device is revoked             |
  | `403`  | `gameNotAdmitted`           | the server doesn't admit the envelope's game               |
  | `404`  | `unknownRoute`              | the server has the mailbox turned off                      |
  | `409`  | `replayed`                  | a reused read nonce: retry with a fresh one                |
  | `413`  | `tooLarge`                  | the body is over the server's limit                        |
  | `429`  | `rateLimited`               | the sender is over the rate limit and should back off      |

  The server sends `clockSkew` and `deviceRevoked` only to a client that declares them
  ([identity §5.2](identity.md#52-verification)). Any other client gets `invalid` and `denied`.

- **Muting is local.** A player mutes a sender in their own client, and the server keeps no state for
  it. The server-side blocklist is for senders who abuse the network.
- **Bodies are public to the server.** The server doesn't encrypt bodies, and its operator can read
  them. A profile reserves `keyAgreement` for an X25519 key a game could use to encrypt
  ([identity §6](identity.md#6-profiles-and-privacy-tiers)).
