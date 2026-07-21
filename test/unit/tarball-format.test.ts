import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The ext-deploy endpoint's minimal tar reader accepts only plain USTAR.
// bsdtar (macOS) defaults to PAX and GNU tar to GNU format, so tarball
// creation MUST pass --format=ustar. This exercises the exact flag set
// publishTarball uses and asserts the on-disk magic.
describe("artifact tarball format", () => {
  it("tar --format=ustar produces a plain USTAR archive with no PAX entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "ustar-"));
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "api.js"), "export default 1;\n");
    writeFileSync(join(dir, "package.json"), "{}\n");

    const out = join(dir, "a.tar");
    const args = ["-C", dir, "--format=ustar"];
    if (process.platform === "darwin") args.push("--no-mac-metadata");
    args.push("-cf", out, "dist", "package.json");
    execFileSync("tar", args, { env: { ...process.env, COPYFILE_DISABLE: "1" } });

    const buf = readFileSync(out);
    // USTAR magic at offset 257 is "ustar\0" (PAX uses the same magic but adds
    // x/g typeflag entries; GNU format uses "ustar  \0"). Assert magic AND the
    // absence of PAX extended-header entries (typeflag 'x'/'g' at offset 156).
    expect(buf.subarray(257, 263).toString("binary")).toBe("ustar\0");
    for (let off = 0; off + 512 <= buf.length; off += 512) {
      const name = buf.subarray(off, off + 100).toString().replace(/\0.*$/, "");
      if (!name) break; // end-of-archive blocks
      const typeflag = String.fromCharCode(buf[off + 156]!);
      expect(["x", "g", "X"]).not.toContain(typeflag);
      // advance past file content blocks
      const size = parseInt(buf.subarray(off + 124, off + 136).toString().trim() || "0", 8);
      off += Math.ceil(size / 512) * 512;
    }
  });
});
