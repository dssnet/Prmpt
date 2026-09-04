import { describe, expect, it } from "vitest";

import type { SshHostRow } from "../db";
import { scoreHost, searchHosts } from "./hostSearch";

function host(over: Partial<SshHostRow> & { id: number; label: string }): SshHostRow {
  return {
    hostname: "example.com",
    port: 22,
    username: "root",
    auth_method: "agent",
    has_password: false,
    key_id: null,
    key_label: null,
    host_fp_sha256: null,
    host_key_alg: null,
    group_id: null,
    broken: false,
    disable_sftp: false,
    disable_ssh: false,
    created_at: "",
    updated_at: "",
    ...over,
  };
}

const noGroups = () => null;

describe("scoreHost", () => {
  it("scores everything equal for an empty query", () => {
    expect(scoreHost("", host({ id: 1, label: "web" }))).toBe(0);
    expect(scoreHost("   ", host({ id: 1, label: "web" }))).toBe(0);
  });

  it("rejects a host when any term is unmatched", () => {
    const h = host({ id: 1, label: "web01", hostname: "10.0.0.5" });
    expect(scoreHost("web", h)).toBeGreaterThan(0);
    expect(scoreHost("web nope-not-here", h)).toBe(-1);
  });

  it("matches hostname, username, port and the displayed user@host:port form", () => {
    const h = host({ id: 1, label: "box", hostname: "srv.example.com", username: "deploy", port: 2222 });
    expect(scoreHost("srv", h)).toBeGreaterThan(0);
    expect(scoreHost("deploy", h)).toBeGreaterThan(0);
    expect(scoreHost("2222", h)).toBeGreaterThan(0);
    expect(scoreHost("deploy@srv", h)).toBeGreaterThan(0);
  });

  it("matches the group name, which lives outside the host row", () => {
    const h = host({ id: 1, label: "box", group_id: 7 });
    expect(scoreHost("staging", h, null)).toBe(-1);
    expect(scoreHost("staging", h, "Staging")).toBeGreaterThan(0);
  });

  it("ranks a prefix above a mid-string hit above a fuzzy scatter", () => {
    const prefix = scoreHost("db", host({ id: 1, label: "db-main", hostname: "x.invalid" }));
    const boundary = scoreHost("db", host({ id: 2, label: "prod-db", hostname: "x.invalid" }));
    const mid = scoreHost("db", host({ id: 3, label: "senddbx", hostname: "x.invalid" }));
    const fuzzy = scoreHost("db", host({ id: 4, label: "dark blue", hostname: "x.invalid" }));
    expect(prefix).toBeGreaterThan(boundary);
    expect(boundary).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(fuzzy);
    expect(fuzzy).toBeGreaterThan(0);
  });

  it("is case-insensitive", () => {
    const h = host({ id: 1, label: "Production Web" });
    expect(scoreHost("PRODUCTION", h)).toBe(scoreHost("production", h));
  });
});

describe("searchHosts", () => {
  const hosts = [
    host({ id: 1, label: "alpha", hostname: "alpha.example.com" }),
    host({ id: 2, label: "prod-db", hostname: "10.0.0.9", group_id: 1 }),
    host({ id: 3, label: "db-replica", hostname: "10.0.0.10", group_id: 1 }),
  ];

  it("returns the input untouched for an empty query", () => {
    expect(searchHosts("", hosts, noGroups)).toEqual(hosts);
  });

  it("drops non-matches and ranks the prefix hit first", () => {
    const out = searchHosts("db", hosts, noGroups);
    expect(out.map((h) => h.id)).toEqual([3, 2]);
  });

  it("ANDs terms across different fields", () => {
    const groupLabelOf = (id: number | null) => (id === 1 ? "Production" : null);
    expect(searchHosts("db production", hosts, groupLabelOf).map((h) => h.id)).toEqual([3, 2]);
    expect(searchHosts("alpha production", hosts, groupLabelOf)).toEqual([]);
  });

  it("keeps input order for equally scoring hosts", () => {
    const tied = [
      host({ id: 10, label: "web-a", hostname: "a.invalid" }),
      host({ id: 11, label: "web-b", hostname: "b.invalid" }),
    ];
    expect(searchHosts("web", tied, noGroups).map((h) => h.id)).toEqual([10, 11]);
  });
});
