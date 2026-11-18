import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import { makeZip } from "../../../test/zip-writer.ts";
import { ImportError, type ImportErrorCode } from "./errors.ts";
import { listZip, MAX_ZIP_ENTRIES, MAX_ZIP_ENTRY_BYTES, readZipEntry, readZipText } from "./zip.ts";

function importError(code: ImportErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof ImportError, `expected an ImportError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

const EOCD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

/** Offset of the first central directory header, read from the EOCD record. */
function centralHeader(zip: Buffer): number {
  return zip.readUInt32LE(zip.lastIndexOf(EOCD) + 16);
}

describe("listZip", () => {
  it("lists files and directories with sizes and methods", () => {
    const zip = makeZip([
      { name: "docs/", data: "" },
      { name: "docs/stored.txt", data: "hello", method: 0 },
      { name: "docs/deflated.txt", data: "hello ".repeat(100), method: 8 },
    ]);
    const entries = listZip(zip);
    assert.deepEqual(
      entries.map(({ name, size, method, isDirectory }) => ({ name, size, method, isDirectory })),
      [
        { name: "docs/", size: 0, method: 0, isDirectory: true },
        { name: "docs/stored.txt", size: 5, method: 0, isDirectory: false },
        { name: "docs/deflated.txt", size: 600, method: 8, isDirectory: false },
      ],
    );
    assert.equal(entries[1]?.compressedSize, 5);
    assert.ok((entries[2]?.compressedSize ?? 0) < 600);
  });

  it("decodes UTF-8 names when flagged and latin1 names otherwise", () => {
    const zip = makeZip([
      { name: "Lebenslauf_M\u00fcller.docx", data: "a" },
      { name: "CV_Jos\u00e9.txt", data: "b", latin1Name: true },
    ]);
    assert.deepEqual(
      listZip(zip).map((entry) => entry.name),
      ["Lebenslauf_M\u00fcller.docx", "CV_Jos\u00e9.txt"],
    );
  });

  it("normalises backslashes in names to forward slashes", () => {
    const zip = makeZip([{ name: "export\\Positions.csv", data: "x" }]);
    assert.equal(listZip(zip)[0]?.name, "export/Positions.csv");
    assert.equal(readZipText(zip, "export/Positions.csv"), "x");
  });

  it("finds the directory behind a trailing archive comment", () => {
    const files = [{ name: "a.txt", data: "alpha" }];
    const short = makeZip(files, { comment: "Exported by a synthetic test" });
    assert.equal(readZipText(short, "a.txt"), "alpha");

    const longest = makeZip(files, { comment: "c".repeat(0xffff) });
    assert.equal(readZipText(longest, "a.txt"), "alpha");

    // A comment that contains the EOCD signature must not be mistaken for the record.
    const tricky = makeZip(files, {
      comment: Buffer.concat([EOCD, Buffer.from("not a real record, just text")]),
    });
    assert.equal(readZipText(tricky, "a.txt"), "alpha");
  });

  it("lists an empty archive", () => {
    assert.deepEqual(listZip(makeZip([])), []);
  });

  it("refuses data that is not a ZIP archive", () => {
    assert.throws(
      () => listZip(Buffer.from("just some text, no archive here")),
      importError("corrupt"),
    );
    assert.throws(() => listZip(new Uint8Array()), importError("corrupt"));
  });

  it("refuses truncated archives", () => {
    const zip = makeZip([{ name: "a.txt", data: "alpha ".repeat(50) }]);
    assert.throws(() => listZip(zip.subarray(0, zip.length - 5)), importError("corrupt"));
    // Cutting the start keeps the EOCD record but its offsets now point past the data.
    assert.throws(() => listZip(zip.subarray(20)), importError("corrupt"));
  });

  it("refuses ZIP64 archives", () => {
    const zip = makeZip([{ name: "a.txt", data: "alpha" }]);
    zip.writeUInt16LE(0xffff, zip.lastIndexOf(EOCD) + 10);
    zip.writeUInt16LE(0xffff, zip.lastIndexOf(EOCD) + 8);
    assert.throws(() => listZip(zip), importError("zip64"));
  });

  it("refuses split archives", () => {
    const zip = makeZip([{ name: "a.txt", data: "alpha" }]);
    zip.writeUInt16LE(1, zip.lastIndexOf(EOCD) + 4);
    assert.throws(() => listZip(zip), importError("unsupported-type"));
  });

  it(`refuses more than ${MAX_ZIP_ENTRIES} entries`, () => {
    const files = Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({
      name: `f${i}.txt`,
      data: "",
      method: 0 as const,
    }));
    assert.throws(() => listZip(makeZip(files)), importError("too-large"));
    assert.equal(listZip(makeZip(files.slice(1))).length, MAX_ZIP_ENTRIES);
  });
});

describe("readZipEntry", () => {
  it("reads stored and deflated entries", () => {
    const binary = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
    const zip = makeZip([
      { name: "stored.bin", data: binary, method: 0 },
      { name: "deflated.bin", data: binary, method: 8 },
      { name: "empty.txt", data: "", method: 8 },
    ]);
    assert.deepEqual(readZipEntry(zip, "stored.bin"), Buffer.from(binary));
    assert.deepEqual(readZipEntry(zip, "deflated.bin"), Buffer.from(binary));
    assert.equal(readZipEntry(zip, "empty.txt").length, 0);
  });

  it("reads empty entries labelled as deflated without deflate data", () => {
    const zip = makeZip([{ name: "dir/", data: "", method: 0 }]);
    zip.writeUInt16LE(8, centralHeader(zip) + 10);
    assert.equal(readZipEntry(zip, "dir/").length, 0);
  });

  it("uses the local header's own name and extra field lengths", () => {
    const zip = makeZip([
      { name: "first.txt", data: "one", localExtra: new Uint8Array(17).fill(7) },
      { name: "second.txt", data: "two", method: 0, localExtra: new Uint8Array(3) },
    ]);
    assert.equal(readZipText(zip, "first.txt"), "one");
    assert.equal(readZipText(zip, "second.txt"), "two");
  });

  it("reads a ZIP held in a slice of a larger buffer", () => {
    const zip = makeZip([{ name: "a.txt", data: "alpha" }]);
    const padded = new Uint8Array(zip.length + 64);
    padded.set(zip, 32);
    assert.equal(readZipText(padded.subarray(32, 32 + zip.length), "a.txt"), "alpha");
  });

  it("matches names exactly", () => {
    const zip = makeZip([{ name: "Profile.csv", data: "x" }]);
    assert.throws(() => readZipEntry(zip, "profile.csv"), importError("corrupt"));
    assert.throws(() => readZipEntry(zip, "missing.txt"), importError("corrupt"));
  });

  it("refuses encrypted entries but still lists them", () => {
    const zip = makeZip([
      { name: "secret.txt", data: "ciphertext", method: 0, encrypted: true },
      { name: "open.txt", data: "plain" },
    ]);
    assert.equal(listZip(zip).length, 2);
    assert.throws(() => readZipEntry(zip, "secret.txt"), importError("encrypted"));
    assert.equal(readZipText(zip, "open.txt"), "plain");
  });

  it("refuses entries with ZIP64 size markers", () => {
    const zip = makeZip([{ name: "a.txt", data: "alpha", method: 0 }]);
    zip.writeUInt32LE(0xffffffff, centralHeader(zip) + 20);
    assert.throws(() => readZipEntry(zip, "a.txt"), importError("zip64"));
  });

  it("refuses unknown compression methods", () => {
    const zip = makeZip([{ name: "a.txt", data: "alpha" }]);
    zip.writeUInt16LE(14, centralHeader(zip) + 10); // LZMA
    assert.equal(listZip(zip)[0]?.method, 14);
    assert.throws(() => readZipEntry(zip, "a.txt"), importError("unsupported-type"));
  });

  it("refuses entries whose data runs past the end", () => {
    const zip = makeZip([{ name: "a.txt", data: "alpha", method: 0 }]);
    const header = centralHeader(zip);
    zip.writeUInt32LE(5000, header + 20);
    zip.writeUInt32LE(5000, header + 24);
    assert.throws(() => readZipEntry(zip, "a.txt"), importError("corrupt"));
  });

  it("refuses a local header offset that points at garbage", () => {
    const zip = makeZip([{ name: "a.txt", data: "alpha" }]);
    zip.writeUInt32LE(3, centralHeader(zip) + 42);
    assert.throws(() => readZipEntry(zip, "a.txt"), importError("corrupt"));
  });

  it("refuses damaged compressed data", () => {
    const zip = makeZip([{ name: "a.txt", data: "alpha beta gamma ".repeat(40) }]);
    const dataStart = 30 + "a.txt".length;
    for (let i = dataStart + 2; i < dataStart + 12; i++) zip[i] = 0xff;
    assert.throws(() => readZipEntry(zip, "a.txt"), importError("corrupt"));
  });

  it("refuses data that does not match its checksum", () => {
    const zip = makeZip([{ name: "a.txt", data: "alpha", method: 0 }]);
    zip[30 + "a.txt".length] = "A".charCodeAt(0);
    assert.throws(() => readZipEntry(zip, "a.txt"), importError("corrupt"));
  });

  it("refuses entries declared larger than the limit", () => {
    const zip = makeZip([{ name: "big.txt", data: "small" }]);
    zip.writeUInt32LE(MAX_ZIP_ENTRY_BYTES + 1, centralHeader(zip) + 24);
    assert.throws(() => readZipEntry(zip, "big.txt"), importError("too-large"));
  });

  it("stops inflating at the limit even when the declared size is small", () => {
    const bomb = deflateRawSync(Buffer.alloc(MAX_ZIP_ENTRY_BYTES + 1));
    const zip = makeZip([{ name: "bomb.txt", data: bomb, method: 0 }]);
    // Relabel the stored entry as deflated with a harmless declared size.
    const header = centralHeader(zip);
    zip.writeUInt16LE(8, header + 10);
    zip.writeUInt32LE(1000, header + 24);
    assert.throws(() => readZipEntry(zip, "bomb.txt"), importError("too-large"));
  });
});

describe("readZipText", () => {
  it("decodes UTF-8, strips the BOM and normalises line endings", () => {
    const zip = makeZip([{ name: "a.txt", data: "\ufeffline one\r\nline two\rline three \u00e9" }]);
    assert.equal(readZipText(zip, "a.txt"), "line one\nline two\nline three \u00e9");
  });
});
