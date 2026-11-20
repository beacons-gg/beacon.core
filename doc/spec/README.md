# Core specs

These specs describe the protocol that the core packages implement and why it works that way: the
design, the reasoning behind it and the rules the code holds to. Each spec names the release it was
checked against. Code comments cite a spec by its section number, as in "identity §5.2". A section
keeps its number for good. A number missing from a spec belongs to a section that was removed.

| Spec                                  | Covers                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| [Identity](identity.md)               | device keys; signing ops, provenance and profiles; revocation; key recovery        |
| [Discovery](discovery.md)             | geohash coverage; the server descriptor; the discovery query; scouts; the live map |
| [Item properties](item-properties.md) | the item property model, the JSONLogic formula profile and the `accept` predicate  |
| [Mailbox client](mailbox-client.md)   | the mailbox host, the client's send and fetch calls and the mailbox live channel   |

The server's specs live in `doc/spec/` of the Beacon server repository. They cover:

- room operation;
- the mailbox and media store;
- places and place proposals;
- location lookups;
- the admin API;
- runtime settings.

Section 2 and section 3 of [the game author guide](../game-author.md) describe rooms and
policies for game authors.
