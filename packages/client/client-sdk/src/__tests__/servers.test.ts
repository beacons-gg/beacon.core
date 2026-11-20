/**
 * servers.ts: the approved-server entry and the routing over a list of them
 * (`doc/spec/discovery.md` §7). Descriptors are really signed by a server account, so the shape
 * can't drift from the wire.
 */
import { encode } from "@beaconsgg/geo";
import { describe, expect, it } from "vitest";
import {
  normalizeServerUrl,
  resolveServerForId,
  selectCoveringServer,
  serversCovering,
  scoutReportServers,
  selectMailboxHost,
  serverHasCapability,
  serversForCells,
  serversForCellsWithCapability,
  serversWithCapability,
  mailboxEndpoint,
  serverHost,
  mailboxOrigin,
  mediaUrl,
  selectMediaHost,
  serverEntryFor,
  serverLabel,
  type ServerEntry,
} from "../servers";
import { emptyRegistry, registryOf, serverRegistryReducer } from "../registry";
import { signedTestDescriptor } from "./fixtures";

describe("capability advertisement", () => {
  const entry = (verified: boolean, capabilities?: string[]): ServerEntry => ({
    origin: "http://srv",
    descriptor: signedTestDescriptor([], capabilities),
    verified,
  });

  it("reads an advertised capability off a verified descriptor", () => {
    expect(serverHasCapability(entry(true, ["mailbox", "media"]), "mailbox")).toBe(true);
    expect(serverHasCapability(entry(true, ["media"]), "mailbox")).toBe(false);
    expect(serverHasCapability(entry(true), "mailbox")).toBe(false); // none advertised
  });

  it("does not trust an unverified server's capabilities", () => {
    expect(serverHasCapability(entry(false, ["mailbox"]), "mailbox")).toBe(false);
  });

  it("lists verified servers advertising a capability, in priority order", () => {
    const entries: ServerEntry[] = [
      { origin: "http://a", descriptor: signedTestDescriptor([], ["mailbox"]), verified: true },
      { origin: "http://b", descriptor: signedTestDescriptor([], ["media"]), verified: true },
      { origin: "http://c", descriptor: signedTestDescriptor([], ["mailbox"]), verified: false },
      { origin: "http://d", descriptor: signedTestDescriptor([], ["mailbox"]), verified: true },
    ];
    expect(serversWithCapability(registryOf(entries), "mailbox")).toEqual(["http://a", "http://d"]);
  });
});

describe("selectMailboxHost", () => {
  const entry = (origin: string, verified: boolean, caps?: string[]): ServerEntry => ({
    origin,
    descriptor: signedTestDescriptor([], caps),
    verified,
  });

  /** The registry state of `entries` with `mailboxOrigin` chosen, as a `setMailbox` leaves it. */
  const chosen = (entries: ServerEntry[], mailboxOrigin?: string) => ({
    ...registryOf(entries),
    ...(mailboxOrigin === undefined ? {} : { mailboxOrigin }),
  });

  it("honors the user's chosen host when it's a verified mailbox-capable server", () => {
    const entries = [entry("http://a", true, ["mailbox"]), entry("http://b", true, ["mailbox"])];
    expect(selectMailboxHost(chosen(entries, "http://b"))).toBe("http://b");
  });

  it("returns undefined when no host is chosen — there is NO default/auto-pick", () => {
    const entries = [entry("http://a", true, ["mailbox"]), entry("http://b", true, ["mailbox"])];
    expect(selectMailboxHost(chosen(entries))).toBeUndefined();
  });

  it("returns undefined when the chosen host isn't a verified mailbox-capable server", () => {
    const entries = [entry("http://a", true, ["mailbox"]), entry("http://b", true, ["media"])];
    expect(selectMailboxHost(chosen(entries, "http://b"))).toBeUndefined(); // b: no mailbox
    expect(selectMailboxHost(chosen(entries, "http://gone"))).toBeUndefined(); // chosen, removed
  });

  it("returns undefined when no server advertises mailbox", () => {
    const entries = [entry("http://a", true, ["media"])];
    expect(selectMailboxHost(chosen(entries, "http://a"))).toBeUndefined();
  });

  it("follows the registry's setMailbox choice", () => {
    const added = serverRegistryReducer(emptyRegistry, {
      type: "add",
      entry: entry("http://a", true, ["mailbox"]),
    });
    expect(selectMailboxHost(added)).toBeUndefined();
    const set = serverRegistryReducer(added, { type: "setMailbox", origin: "http://a" });
    expect(selectMailboxHost(set)).toBe("http://a");
  });
});

describe("mailbox endpoint format (scheme-less, assume HTTPS)", () => {
  it("mailboxEndpoint drops the protocol → bare authority", () => {
    expect(mailboxEndpoint("https://mail.example:3001")).toBe("mail.example:3001");
    expect(mailboxEndpoint("http://mail.example")).toBe("mail.example");
    expect(mailboxEndpoint("https://mail.example/")).toBe("mail.example"); // trailing slash trimmed
    expect(mailboxEndpoint("mail.example:3001")).toBe("mail.example:3001"); // already bare
  });

  it("serverHost prefers the advertised descriptor host, else the origin's authority", () => {
    expect(serverHost("srv.example", "https://other.example:3001")).toBe("srv.example"); // descriptor wins
    expect(serverHost(undefined, "https://mail.example:3001")).toBe("mail.example:3001"); // fall back to origin
    expect(serverHost(undefined, "http://mail.example/")).toBe("mail.example"); // via mailboxEndpoint (scheme + slash)
  });

  it("mailboxOrigin assumes HTTPS for a real domain", () => {
    expect(mailboxOrigin("mail.example:3001")).toBe("https://mail.example:3001");
    expect(mailboxOrigin("mail.example")).toBe("https://mail.example");
  });

  it("mailboxOrigin falls back to HTTP for loopback / private-LAN / .local (dev)", () => {
    expect(mailboxOrigin("localhost:3001")).toBe("http://localhost:3001");
    expect(mailboxOrigin("127.0.0.1:3001")).toBe("http://127.0.0.1:3001");
    expect(mailboxOrigin("192.168.1.50:3001")).toBe("http://192.168.1.50:3001");
    expect(mailboxOrigin("10.0.2.2:3001")).toBe("http://10.0.2.2:3001");
    expect(mailboxOrigin("mac.local:3001")).toBe("http://mac.local:3001");
  });

  it("mailboxOrigin honors an explicit scheme if one is present", () => {
    expect(mailboxOrigin("http://mail.example:3001")).toBe("http://mail.example:3001");
  });

  it("round-trips a real origin (http → scheme-less → https)", () => {
    expect(mailboxOrigin(mailboxEndpoint("http://mail.example:3001"))).toBe(
      "https://mail.example:3001",
    );
  });
});

describe("normalizeServerUrl", () => {
  it("trims and rejects empty", () => {
    expect(normalizeServerUrl("  http://x/  ")).toBe("http://x");
    expect(normalizeServerUrl("   ")).toBeNull();
  });

  it("gives a typed address the platform's scheme, as every client does", () => {
    expect(normalizeServerUrl("beacon.example")).toBe("https://beacon.example");
    expect(normalizeServerUrl("beacon.example:8443/")).toBe("https://beacon.example:8443");
    expect(normalizeServerUrl("192.168.10.10:3001")).toBe("http://192.168.10.10:3001");
  });
});

describe("serversForCells (coverage fan-out)", () => {
  it("returns only verified servers whose coverage intersects the query cells", () => {
    const covering = {
      origin: "http://a",
      descriptor: signedTestDescriptor(["u4"]),
      verified: true,
    };
    const elsewhere = {
      origin: "http://b",
      descriptor: signedTestDescriptor(["9q"]),
      verified: true,
    };
    const unverified = {
      origin: "http://c",
      descriptor: signedTestDescriptor(["u4"]),
      verified: false,
    };
    const targets = serversForCells(registryOf([covering, elsewhere, unverified]), ["u4pruy"]);
    expect(targets).toEqual(["http://a"]);
  });

  it("treats a server with no declared coverage as covering the whole world (dev assumption)", () => {
    const worldwide = { origin: "http://a", descriptor: signedTestDescriptor([]), verified: true };
    const elsewhere = {
      origin: "http://b",
      descriptor: signedTestDescriptor(["9q"]),
      verified: true,
    };
    expect(serversForCells(registryOf([worldwide, elsewhere]), ["u4pruy"])).toEqual(["http://a"]);
  });
});

describe("selectCoveringServer (most-specific coverage wins, tie → priority)", () => {
  const coord = { lat: 37.7749, lng: -122.4194 };
  const cell = encode(coord); // the 7-char point cell
  const prefix = cell.slice(0, 3); // a coverage prefix that contains the point

  it("picks the covering server even when a non-covering one is listed first", () => {
    const covering = {
      origin: "http://a",
      descriptor: signedTestDescriptor([prefix]),
      verified: true,
    };
    const elsewhere = {
      origin: "http://b",
      descriptor: signedTestDescriptor(["zz"]),
      verified: true,
    };
    expect(selectCoveringServer(registryOf([elsewhere, covering]), coord)).toBe("http://a");
  });

  it("prefers the server with the most specific coverage regardless of list order", () => {
    const coarse = {
      origin: "http://a",
      descriptor: signedTestDescriptor([cell.slice(0, 2)]),
      verified: true,
    };
    const fine = {
      origin: "http://b",
      descriptor: signedTestDescriptor([cell.slice(0, 5)]),
      verified: true,
    };
    expect(selectCoveringServer(registryOf([coarse, fine]), coord)).toBe("http://b"); // fine wins though listed 2nd
    expect(selectCoveringServer(registryOf([fine, coarse]), coord)).toBe("http://b"); // and when listed 1st
  });

  it("breaks an equal-precision tie by priority (the earlier server wins)", () => {
    const a = { origin: "http://a", descriptor: signedTestDescriptor([prefix]), verified: true };
    const b = { origin: "http://b", descriptor: signedTestDescriptor([prefix]), verified: true };
    expect(selectCoveringServer(registryOf([b, a]), coord)).toBe("http://b"); // b listed first → higher priority
    expect(selectCoveringServer(registryOf([a, b]), coord)).toBe("http://a");
  });

  it("prefers a specifically-covering server over a whole-world (dev) server", () => {
    const world = { origin: "http://a", descriptor: signedTestDescriptor([]), verified: true };
    const covering = {
      origin: "http://b",
      descriptor: signedTestDescriptor([prefix]),
      verified: true,
    };
    expect(selectCoveringServer(registryOf([world, covering]), coord)).toBe("http://b"); // specificity 3 > 0
  });

  it("returns null when no server covers the point", () => {
    const a = { origin: "http://a", descriptor: signedTestDescriptor(["zz"]), verified: true };
    expect(selectCoveringServer(registryOf([a]), coord)).toBeNull();
  });
});

describe("serversCovering (the scout relay's fan-out)", () => {
  const coord = { lat: 37.7749, lng: -122.4194 }; // San Francisco: the departure end
  const away = { lat: 47.6062, lng: -122.3321 }; // Seattle: the destination end
  const cell = encode(coord);
  const prefix = cell.slice(0, 3);
  const awayPrefix = encode(away).slice(0, 3);

  it("returns EVERY covering server, unlike the single-server placement pick", () => {
    const coarse = {
      origin: "http://a",
      descriptor: signedTestDescriptor([cell.slice(0, 2)]),
      verified: true,
    };
    const fine = {
      origin: "http://b",
      descriptor: signedTestDescriptor([cell.slice(0, 5)]),
      verified: true,
    };
    expect(serversCovering(registryOf([coarse, fine]), [coord])).toEqual(["http://a", "http://b"]);
    expect(selectCoveringServer(registryOf([coarse, fine]), coord)).toBe("http://b"); // the contrast that motivates it
  });

  it("takes a server that covers EITHER end of the trip, so the destination's server hears about it", () => {
    const start = {
      origin: "http://a",
      descriptor: signedTestDescriptor([prefix]),
      verified: true,
    };
    const end = {
      origin: "http://b",
      descriptor: signedTestDescriptor([awayPrefix]),
      verified: true,
    };
    expect(serversCovering(registryOf([start, end]), [coord, away])).toEqual([
      "http://a",
      "http://b",
    ]);
    // The pre-fix behaviour, for contrast: matching the departure point alone left the far end out.
    expect(serversCovering(registryOf([start, end]), [coord])).toEqual(["http://a"]);
  });

  it("lists a server covering both ends once, not twice", () => {
    const both = {
      origin: "http://a",
      descriptor: signedTestDescriptor([prefix, awayPrefix]),
      verified: true,
    };
    expect(serversCovering(registryOf([both]), [coord, away])).toEqual(["http://a"]);
  });

  it("keeps priority (list) order and drops the servers that cover neither end", () => {
    const covering = {
      origin: "http://a",
      descriptor: signedTestDescriptor([prefix]),
      verified: true,
    };
    const elsewhere = {
      origin: "http://b",
      descriptor: signedTestDescriptor(["zz"]),
      verified: true,
    };
    const world = { origin: "http://c", descriptor: signedTestDescriptor([]), verified: true };
    expect(serversCovering(registryOf([elsewhere, world, covering]), [coord, away])).toEqual([
      "http://c",
      "http://a",
    ]);
  });

  it("excludes unverified servers and returns empty when nothing covers the trip", () => {
    const unverified = {
      origin: "http://a",
      descriptor: signedTestDescriptor([prefix]),
      verified: false,
    };
    const elsewhere = {
      origin: "http://b",
      descriptor: signedTestDescriptor(["zz"]),
      verified: true,
    };
    expect(serversCovering(registryOf([unverified, elsewhere]), [coord, away])).toEqual([]);
  });
});

describe("resolveServerForId (host routing)", () => {
  const at = (origin: string, verified = true): ServerEntry => ({
    origin,
    descriptor: verified ? signedTestDescriptor([]) : null,
    verified,
  });
  const entries = [at("http://a"), at("http://b")];

  it("routes a unique@host id to the server whose authority matches", () => {
    expect(resolveServerForId("room1@a", registryOf(entries))).toBe("http://a");
    expect(resolveServerForId("room1@b", registryOf(entries))).toBe("http://b");
  });

  it("reaches a server not on the list over https, and a local or private one over http", () => {
    expect(resolveServerForId("room1@z.example", registryOf(entries))).toBe("https://z.example");
    expect(resolveServerForId("room1@z.example:8443", registryOf(entries))).toBe(
      "https://z.example:8443",
    );
    expect(resolveServerForId("room1@localhost:3017", registryOf(entries))).toBe(
      "http://localhost:3017",
    );
    expect(resolveServerForId("room1@192.168.1.20:3001", registryOf([]))).toBe(
      "http://192.168.1.20:3001",
    );
  });

  it("routes a bare id (a scout, no host) to the first verified server, or null with none", () => {
    expect(resolveServerForId("scout1", registryOf(entries))).toBe("http://a");
    expect(resolveServerForId("scout1", registryOf([at("http://x", false), ...entries]))).toBe(
      "http://a",
    );
    expect(resolveServerForId("scout1", registryOf([]))).toBeNull();
  });
});

describe("routing by id to a server refused for a changed key", () => {
  const entry = (origin: string): ServerEntry => ({
    origin,
    descriptor: signedTestDescriptor([]),
    verified: true,
  });
  // Built directly: the fixture signs every descriptor with one key, and an `add` of a second
  // origin with the same key would replace the first as the same server.
  const state = { ...emptyRegistry, servers: [entry("http://a"), entry("http://b")] };
  const refused = serverRegistryReducer(state, { type: "identityChanged", origin: "http://a" });

  it("refuses the server by default, from the state or from its marked entries", () => {
    for (const servers of [refused, registryOf(refused.servers)]) {
      expect(resolveServerForId("room1@a", servers)).toBeNull();
      expect(mediaUrl("h@a", servers)).toBeNull();
      // Neither falls back to the host, which is the same server.
      expect(resolveServerForId("room1@b", servers)).toBe("http://b");
      expect(resolveServerForId("scout1", servers)).toBe("http://b");
    }
  });

  it("reads the refusal from a saved state's list when its entries carry no mark", () => {
    const saved = { ...state, identityChanged: ["http://a"] }; // as an older build stored it
    expect(resolveServerForId("room1@a", saved)).toBeNull();
    expect(resolveServerForId("scout1", saved)).toBe("http://b");
    expect(mediaUrl("h@a", saved)).toBeNull();
    expect(selectCoveringServer(saved, { lat: 0, lng: 0 })).toBe("http://b");
    expect(serversForCells(saved, ["s000"])).toEqual(["http://b"]);
    // The entries alone carry no mark, so nothing refuses the server.
    expect(resolveServerForId("room1@a", registryOf(saved.servers))).toBe("http://a");
  });

  it("refuses a host when any entry for it is refused, whatever the scheme", () => {
    // The reducer keys entries by exact origin, so one host can have two entries.
    const twins = registryOf([
      { origin: "http://beacon.example", descriptor: null, verified: false },
      { ...entry("https://beacon.example"), keyRefused: true },
    ]);
    expect(resolveServerForId("r@beacon.example", twins)).toBeNull();
    expect(mediaUrl("h@beacon.example", twins)).toBeNull();
  });

  it("routes an id to its listed server even when that server never verified", () => {
    // The id names its server, so nothing is chosen: the saved origin (here plain `http`, as the
    // player typed it) is how to reach that host. Only a choice among servers needs `verified`.
    const listed = registryOf([
      { origin: "http://beacon.example", descriptor: null, verified: false },
      entry("http://b"),
    ]);
    expect(resolveServerForId("r@beacon.example", listed)).toBe("http://beacon.example");
    expect(mediaUrl("h@beacon.example", listed)).toBe("http://beacon.example/media/h");
    // A bare id names no server, so it chooses, and skips the one that never verified.
    expect(resolveServerForId("scout1", listed)).toBe("http://b");
  });

  it("prefers a verified entry over one that never verified for the same host", () => {
    const twins = registryOf([
      { origin: "http://beacon.example", descriptor: null, verified: false },
      entry("https://beacon.example"),
    ]);
    expect(resolveServerForId("r@beacon.example", twins)).toBe("https://beacon.example");
  });

  it("routes to the refused server when allowKeyRefused asks to", () => {
    const allow = { allowKeyRefused: true };
    expect(resolveServerForId("room1@a", refused, allow)).toBe("http://a");
    expect(resolveServerForId("scout1", refused, allow)).toBe("http://a");
    expect(mediaUrl("h@a", refused, allow)).toBe("http://a/media/h");
  });
});

describe("serversForCellsWithCapability (coverage AND capability)", () => {
  it("returns only verified servers that cover the cell AND advertise the capability, in order", () => {
    const cell = encode({ lat: 47.61, lng: -122.34 }); // Seattle
    const prefix = cell.slice(0, 3);
    const entries: ServerEntry[] = [
      {
        origin: "http://covers-and-has",
        descriptor: signedTestDescriptor([prefix], ["geocode"]),
        verified: true,
      },
      {
        origin: "http://covers-no-cap",
        descriptor: signedTestDescriptor([prefix], ["media"]),
        verified: true,
      },
      {
        origin: "http://has-cap-no-cover",
        descriptor: signedTestDescriptor(["zz"], ["geocode"]),
        verified: true,
      },
      {
        origin: "http://unverified",
        descriptor: signedTestDescriptor([prefix], ["geocode"]),
        verified: false,
      },
      {
        origin: "http://world-and-has",
        descriptor: signedTestDescriptor([], ["geocode"]),
        verified: true,
      },
    ];
    expect(serversForCellsWithCapability(registryOf(entries), [cell], "geocode")).toEqual([
      "http://covers-and-has",
      "http://world-and-has", // empty coverage = whole-world (dev convenience)
    ]);
  });

  it("is empty when a covering server doesn't advertise the capability", () => {
    const cell = encode({ lat: 47.61, lng: -122.34 });
    const entries: ServerEntry[] = [
      {
        origin: "http://a",
        descriptor: signedTestDescriptor([cell.slice(0, 3)], ["media"]),
        verified: true,
      },
    ];
    expect(serversForCellsWithCapability(registryOf(entries), [cell], "places")).toEqual([]);
  });
});

describe("selectMediaHost", () => {
  const media = {
    origin: "http://m",
    descriptor: signedTestDescriptor([], ["media"]),
    verified: true,
  };
  const plain = { origin: "http://p", descriptor: signedTestDescriptor([], []), verified: true };

  it("honors the choice only while it is still a verified media server, with no default", () => {
    const servers = registryOf([media, plain]);
    expect(selectMediaHost({ ...servers, mediaOrigin: "http://m" })).toBe("http://m");
    expect(selectMediaHost({ ...servers, mediaOrigin: "http://p" })).toBeUndefined();
    expect(selectMediaHost(servers)).toBeUndefined();
  });
});

describe("serverLabel / serverEntryFor", () => {
  const named: ServerEntry = {
    origin: "http://n",
    descriptor: { ...signedTestDescriptor([]), name: "  North  " },
    verified: true,
  };

  it("calls a server by its advertised name, else its origin", () => {
    expect(serverLabel(named, "http://n")).toBe("North");
    expect(
      serverLabel(
        { ...named, descriptor: { ...signedTestDescriptor([]), name: "  " } },
        "http://n",
      ),
    ).toBe("http://n");
    expect(serverLabel(undefined, "http://gone")).toBe("http://gone");
  });

  it("finds an entry by origin", () => {
    expect(serverEntryFor([named], "http://n")).toBe(named);
    expect(serverEntryFor([named], "http://x")).toBeUndefined();
  });
});

describe("mediaUrl", () => {
  const listed: ServerEntry = { origin: "http://srv.example/", descriptor: null, verified: true };

  it("routes a content address to its host's public media path", () => {
    expect(mediaUrl("abc@srv.example", registryOf([listed]))).toBe("http://srv.example/media/abc");
  });

  it("reaches a host not on the list over https, and a local one over http", () => {
    expect(mediaUrl("abc@cdn.example", registryOf([listed]))).toBe("https://cdn.example/media/abc");
    expect(mediaUrl("abc@localhost:3017", registryOf([]))).toBe("http://localhost:3017/media/abc");
  });

  it("builds no URL for an address that is not unique@host", () => {
    for (const address of [
      "no-host",
      "@srv.example",
      "abc@",
      "a@b@srv.example",
      "",
      "\ud800@srv.example",
    ])
      expect(mediaUrl(address, registryOf([listed])), address).toBeNull();
  });

  it("builds no URL for a host that carries a scheme or a path of its own", () => {
    for (const address of ["h@http://evil.example", "h@file:///etc", "h@evil.example/x"])
      expect(mediaUrl(address, registryOf([listed])), address).toBeNull();
    expect(resolveServerForId("room1@http://evil.example", registryOf([listed]))).toBeNull();
  });
});

describe("an entry refused for a changed key", () => {
  const POINT = { lat: 37.77, lng: -122.42 };
  const cells = [encode(POINT)];
  const entry = (origin: string, keyRefused: boolean): ServerEntry => ({
    origin,
    // Whole-world coverage and both capabilities, so only the mark can keep the entry out.
    descriptor: signedTestDescriptor([], ["mailbox", "media", "places"]),
    verified: true,
    ...(keyRefused ? { keyRefused: true as const } : {}),
  });
  const refusedFirst = [entry("http://refused", true), entry("http://fine", false)];
  const onlyRefused = [entry("http://refused", true)];

  it("is skipped by every routing helper, even ahead of a usable one", () => {
    expect(serversForCells(registryOf(refusedFirst), cells)).toEqual(["http://fine"]);
    expect(serversCovering(registryOf(refusedFirst), [POINT])).toEqual(["http://fine"]);
    expect(selectCoveringServer(registryOf(refusedFirst), POINT)).toBe("http://fine");
    expect(serversWithCapability(registryOf(refusedFirst), "mailbox")).toEqual(["http://fine"]);
    expect(serversForCellsWithCapability(registryOf(refusedFirst), cells, "places")).toEqual([
      "http://fine",
    ]);
  });

  it("offers no capability, so it is never the mailbox or media host", () => {
    const chosen = {
      ...registryOf(onlyRefused),
      mailboxOrigin: "http://refused",
      mediaOrigin: "http://refused",
    };
    expect(serverHasCapability(onlyRefused[0]!, "mailbox")).toBe(false);
    expect(selectMailboxHost(chosen)).toBeUndefined();
    expect(selectMediaHost(chosen)).toBeUndefined();
    expect(selectCoveringServer(registryOf(onlyRefused), POINT)).toBeNull();
  });
});

describe("scoutReportServers (the scout relay)", () => {
  const POINT = { lat: 37.77, lng: -122.42 };
  const AWAY = { lat: 51.5, lng: -0.12 };
  const at = (origin: string, coverage: string[]): ServerEntry => ({
    origin,
    descriptor: signedTestDescriptor(coverage),
    verified: true,
  });
  const servers = [
    at("http://start", [encode(POINT).slice(0, 3)]),
    at("http://end", [encode(AWAY).slice(0, 3)]),
    at("http://elsewhere", ["s0"]),
  ];

  it("reports to every server covering either end while the player chose every server", () => {
    expect(scoutReportServers(registryOf(servers), [POINT, AWAY])).toEqual([
      "http://start",
      "http://end",
    ]);
  });

  it("leaves out a server the player turned reporting off for, and reports nowhere when off", () => {
    const state = { ...registryOf(servers), scoutRelay: ["http://end"] };
    expect(scoutReportServers(state, [POINT, AWAY])).toEqual(["http://end"]);
    expect(scoutReportServers({ ...state, scoutRelay: [] }, [POINT, AWAY])).toEqual([]);
    // Coverage still decides: a chosen server is reached only for a trip it covers.
    expect(scoutReportServers(state, [POINT])).toEqual([]);
  });

  it("leaves out a server refused for a changed key, even when the player chose it", () => {
    const state = { ...registryOf(servers), identityChanged: ["http://start"] };
    expect(scoutReportServers(state, [POINT, AWAY])).toEqual(["http://end"]);
  });
});

describe("registryOf", () => {
  it("makes a state of a fixed list, with no choices, that every helper takes", () => {
    const entry: ServerEntry = {
      origin: "http://one",
      descriptor: signedTestDescriptor([], ["mailbox"]),
      verified: true,
    };
    const list = [entry];
    const state = registryOf(list);
    expect(state).toEqual({ servers: [entry] });
    expect(state.servers).not.toBe(list); // a copy: the caller's list is never the state's
    expect(selectCoveringServer(state, { lat: 0, lng: 0 })).toBe("http://one");
    expect(resolveServerForId("r@one", state)).toBe("http://one");
    expect(selectMailboxHost(state)).toBeUndefined(); // no choice made
  });
});
