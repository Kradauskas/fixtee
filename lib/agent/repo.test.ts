import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractTarball, RepoCheckoutError } from "./repo";

type Entry = { name: string; type?: string; body?: string; linkname?: string; prefix?: string };

function header(name: string, size: number, type: string, linkname = "", prefix = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148); // checksum placeholder
  h.write(type, 156);
  h.write(linkname, 157, 100);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.write(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return h;
}

function pad(buf: Buffer): Buffer {
  const rem = buf.length % 512;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem)]);
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = body.length;
  while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
  return `${len}${body}`;
}

function tar(entries: Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "", "utf8");
    parts.push(header(e.name, body.length, e.type ?? "0", e.linkname, e.prefix), pad(body));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

let dest: string;
beforeEach(async () => {
  dest = await mkdtemp(path.join(os.tmpdir(), "fixtee-repo-test-"));
});
afterEach(async () => {
  await rm(dest, { recursive: true, force: true });
});

describe("extractTarball", () => {
  it("extracts a GitHub-style tarball, stripping the top-level dir", async () => {
    const longName = `${"d".repeat(120)}/file.txt`;
    const archive = gzipSync(
      tar([
        { name: "pax_global_header", type: "g", body: paxRecord("comment", "abc123") },
        { name: "owner-repo-abc123/", type: "5" },
        { name: "owner-repo-abc123/package.json", body: '{"name":"x"}' },
        { name: "owner-repo-abc123/src/", type: "5" },
        { name: "owner-repo-abc123/src/a.js", body: "export const a = 1;\n" },
        { name: "PaxHeader", type: "x", body: paxRecord("path", `owner-repo-abc123/${longName}`) },
        { name: "truncated", body: "long" },
        { name: "b.js", prefix: "owner-repo-abc123/lib", body: "b" },
      ]),
    );
    await extractTarball(archive, dest);

    expect((await readdir(dest)).sort()).toEqual(["d".repeat(120), "lib", "package.json", "src"]);
    expect(await readFile(path.join(dest, "src/a.js"), "utf8")).toBe("export const a = 1;\n");
    expect(await readFile(path.join(dest, longName), "utf8")).toBe("long");
    expect(await readFile(path.join(dest, "lib/b.js"), "utf8")).toBe("b");
  });

  it("skips symlinks and hard links", async () => {
    await extractTarball(
      tar([
        { name: "r/ok.txt", body: "ok" },
        { name: "r/link", type: "2", linkname: "/etc/passwd" },
        { name: "r/hard", type: "1", linkname: "r/ok.txt" },
      ]),
      dest,
    );
    expect(await readdir(dest)).toEqual(["ok.txt"]);
  });

  it.each(["r/../../evil.txt", "/abs/evil.txt", "r/a\\..\\..\\evil.txt"])("rejects unsafe path %s", async (name) => {
    await expect(extractTarball(tar([{ name, body: "x" }]), dest)).rejects.toBeInstanceOf(RepoCheckoutError);
  });

  it("rejects a truncated archive", async () => {
    const full = tar([{ name: "r/a.txt", body: "x".repeat(2000) }]);
    await expect(extractTarball(full.subarray(0, 1024), dest)).rejects.toThrow(/Truncated/);
  });
});
