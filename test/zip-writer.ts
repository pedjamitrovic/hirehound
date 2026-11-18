// Test helper: builds small, valid ZIP archives in memory so tests never need binary fixtures.
import { crc32, deflateRawSync } from "node:zlib";

export type ZipFileSpec = {
  name: string;
  data: string | Uint8Array;
  /** 0 = stored, 8 = deflate (the default). */
  method?: 0 | 8;
  /** Sets the "encrypted" flag. The data itself is written as is. */
  encrypted?: boolean;
  /** Encode the name as latin1 without the UTF-8 flag, like older archivers do. */
  latin1Name?: boolean;
  /** Extra field bytes written to the local header only, so it differs from the central one. */
  localExtra?: Uint8Array;
};

// 2026-01-01 00:00 in MS-DOS format.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7e) return false;
  return true;
}

export function makeZip(
  files: ZipFileSpec[],
  options: { comment?: string | Uint8Array } = {},
): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const raw = Buffer.from(typeof file.data === "string" ? Buffer.from(file.data) : file.data);
    const method = file.method ?? (file.name.endsWith("/") ? 0 : 8);
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(file.name, file.latin1Name ? "latin1" : "utf8");
    const utf8 = !file.latin1Name && !isAscii(file.name);
    const flags = (file.encrypted ? 0x0001 : 0) | (utf8 ? 0x0800 : 0);
    const crc = crc32(raw);
    const extra = Buffer.from(file.localExtra ?? new Uint8Array());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    parts.push(local, name, extra, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(raw.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(file.name.endsWith("/") ? 0x10 : 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + extra.length + body.length;
  }

  const directory = Buffer.concat(central);
  const comment =
    typeof options.comment === "string"
      ? Buffer.from(options.comment, "latin1")
      : Buffer.from(options.comment ?? new Uint8Array());
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, directory, eocd, comment]);
}
