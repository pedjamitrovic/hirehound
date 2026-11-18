// A small read-only ZIP reader for imported files: CVs saved as .docx and LinkedIn data exports.
// Entries are read from memory and never extracted to disk, so hostile paths such as "../x" are
// harmless. Only stored and deflated entries are supported; encryption, ZIP64 and split archives
// are refused, and limits on entry count and size stop zip bombs.
import { crc32, inflateRawSync } from "node:zlib";
import { normalizeText } from "../../shared/frontmatter.ts";
import { ImportError } from "./errors.ts";

export type ZipEntry = {
  /** Path inside the archive with forward slashes. Directories end with "/". */
  name: string;
  /** Uncompressed size in bytes, as declared by the archive. */
  size: number;
  compressedSize: number;
  /** 0 = stored, 8 = deflate. Other methods cannot be read. */
  method: number;
  isDirectory: boolean;
};

export const MAX_ZIP_ENTRIES = 5000;
export const MAX_ZIP_ENTRY_BYTES = 50_000_000;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT_SIZE = 0xffff;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_UTF8 = 0x0800;
const STORED = 0;
const DEFLATED = 8;
const U16_MARKER = 0xffff;
const U32_MARKER = 0xffffffff;

type RawEntry = ZipEntry & { flags: number; crc: number; localOffset: number };

function damaged(): ImportError {
  return new ImportError(
    "corrupt",
    "This ZIP file is damaged or incomplete. Download it again and retry.",
  );
}

function zip64(): ImportError {
  return new ImportError(
    "zip64",
    "This ZIP file uses the ZIP64 format, which Hirehound cannot read. Try a smaller export.",
  );
}

/** Lists the entries of a ZIP archive without reading their contents. */
export function listZip(data: Uint8Array): ZipEntry[] {
  return readCentralDirectory(data).map(({ name, size, compressedSize, method, isDirectory }) => ({
    name,
    size,
    compressedSize,
    method,
    isDirectory,
  }));
}

/** The uncompressed bytes of the entry with exactly this name. */
export function readZipEntry(data: Uint8Array, name: string): Buffer {
  const entry = readCentralDirectory(data).find((candidate) => candidate.name === name);
  if (!entry) throw new ImportError("corrupt", `This ZIP file has no "${name}".`);
  return readEntryData(data, entry);
}

/** An entry as UTF-8 text with the BOM stripped and LF line endings. */
export function readZipText(data: Uint8Array, name: string): string {
  return normalizeText(readZipEntry(data, name).toString("utf8"));
}

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * The End Of Central Directory record sits at the very end, followed only by an optional
 * comment of up to 64 KB. Prefer a record whose comment ends exactly at the end of the data;
 * accept trailing bytes after it only when nothing better exists.
 */
function findEocd(data: Uint8Array, view: DataView): number {
  const last = data.length - EOCD_SIZE;
  const first = Math.max(0, last - MAX_COMMENT_SIZE);
  let fallback = -1;
  for (let pos = last; pos >= first; pos--) {
    if (data[pos] !== 0x50 || view.getUint32(pos, true) !== EOCD_SIGNATURE) continue;
    const end = pos + EOCD_SIZE + view.getUint16(pos + 20, true);
    if (end === data.length) return pos;
    if (end < data.length && fallback < 0) fallback = pos;
  }
  if (fallback >= 0) return fallback;
  throw new ImportError("corrupt", "This file is not a ZIP archive, or it is damaged.");
}

function readCentralDirectory(data: Uint8Array): RawEntry[] {
  const view = viewOf(data);
  const eocd = findEocd(data, view);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);

  if (
    count === U16_MARKER ||
    diskEntries === U16_MARKER ||
    centralSize === U32_MARKER ||
    centralOffset === U32_MARKER
  ) {
    throw zip64();
  }
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== count) {
    throw new ImportError(
      "unsupported-type",
      "This ZIP file is split into several parts. Combine them into one ZIP file and retry.",
    );
  }
  if (count > MAX_ZIP_ENTRIES) {
    throw new ImportError(
      "too-large",
      `This ZIP file holds more than ${MAX_ZIP_ENTRIES} files. Hirehound reads smaller archives only.`,
    );
  }
  const centralEnd = centralOffset + centralSize;
  if (centralEnd > eocd) throw damaged();

  const entries: RawEntry[] = [];
  let pos = centralOffset;
  for (let i = 0; i < count; i++) {
    if (pos + CENTRAL_SIZE > centralEnd || view.getUint32(pos, true) !== CENTRAL_SIGNATURE) {
      throw damaged();
    }
    const flags = view.getUint16(pos + 8, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const nameStart = pos + CENTRAL_SIZE;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > centralEnd) throw damaged();
    const name = decodeName(data.subarray(nameStart, nameStart + nameLength), flags);
    entries.push({
      name,
      size: view.getUint32(pos + 24, true),
      compressedSize: view.getUint32(pos + 20, true),
      method: view.getUint16(pos + 10, true),
      isDirectory: name.endsWith("/"),
      flags,
      crc: view.getUint32(pos + 16, true),
      localOffset: view.getUint32(pos + 42, true),
    });
    pos = next;
  }
  return entries;
}

/** UTF-8 when the archive says so, otherwise latin1 (close enough to CP437 for file names). */
function decodeName(bytes: Uint8Array, flags: number): string {
  const name =
    flags & FLAG_UTF8
      ? new TextDecoder("utf-8").decode(bytes)
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  return name.replaceAll("\\", "/");
}

function readEntryData(data: Uint8Array, entry: RawEntry): Buffer {
  if (entry.flags & FLAG_ENCRYPTED) {
    throw new ImportError(
      "encrypted",
      "This ZIP file is encrypted. Export it again without a password.",
    );
  }
  if (
    entry.size === U32_MARKER ||
    entry.compressedSize === U32_MARKER ||
    entry.localOffset === U32_MARKER
  ) {
    throw zip64();
  }
  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw new ImportError(
      "unsupported-type",
      "This ZIP file uses a compression method Hirehound cannot read. Compress it again with standard settings.",
    );
  }
  const tooLarge = new ImportError(
    "too-large",
    `"${entry.name}" in this ZIP file is larger than ${MAX_ZIP_ENTRY_BYTES / 1_000_000} MB.`,
  );
  if (entry.size > MAX_ZIP_ENTRY_BYTES) throw tooLarge;

  // The local header repeats the name and has its own extra field, whose length can differ
  // from the one in the central directory. The sizes in the central directory are the
  // reliable ones (the local copies are zero when a data descriptor follows the data).
  const view = viewOf(data);
  const local = entry.localOffset;
  if (local + LOCAL_SIZE > data.length || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
    throw damaged();
  }
  const start =
    local + LOCAL_SIZE + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
  const end = start + entry.compressedSize;
  if (end > data.length) throw damaged();
  const compressed = data.subarray(start, end);

  let output: Buffer;
  if (entry.compressedSize === 0 && entry.size === 0) {
    // Some writers label empty files and directories as deflated without any deflate data.
    output = Buffer.alloc(0);
  } else if (entry.method === STORED) {
    if (entry.compressedSize !== entry.size) throw damaged();
    output = Buffer.from(compressed);
  } else {
    try {
      output = inflateRawSync(compressed, { maxOutputLength: MAX_ZIP_ENTRY_BYTES });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") throw tooLarge;
      throw damaged();
    }
  }
  if (output.length !== entry.size || crc32(output) !== entry.crc) throw damaged();
  return output;
}
