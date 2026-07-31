import { gzip as gzipCb, gunzip as gunzipCb } from "node:zlib";
import { promisify } from "node:util";
import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityError, EXIT } from "../run/receipt.js";
import { shapeHashOfBody } from "./shape.js";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

/** Width of the zero-padded sequence prefix in a filename, e.g. `0007`. */
const SEQ_WIDTH = 4;

/** What the caller hands the archive for one captured response. */
export type CaptureInput = {
  body: string | Uint8Array;
  url: string;
  status: number;
  method?: string;
  requestId?: string;
  pattern?: string;
  contentType?: string;
  capturedAt?: string;
};

/** A capture that landed, but not intact. Never a failure — see `archive()`. */
export type CaptureWarning = { code: "ARCHIVE_SIDECAR_FAILED"; message: string };

/**
 * What `archive()` and `list()` return: everything needed to find, identify,
 * and re-read one capture without touching the body itself. `bytes` is the
 * *uncompressed* length — that is the number a receipt or a fixture picker
 * cares about, not the on-disk gzip size.
 */
export type ArchivedCapture = {
  seq: number;
  id: string;
  file: string;
  path: string;
  shapeHash: string;
  url: string;
  status: number;
  method?: string;
  requestId?: string;
  pattern?: string;
  contentType?: string;
  capturedAt: string;
  bytes: number;
  /** Present only when the capture landed degraded — the body is on disk and
   *  readable, but something beside it did not. Callers put this on the
   *  receipt's `warnings`; it is never a reason to stop. */
  warning?: CaptureWarning;
};

/** The sidecar's on-disk shape. Everything `ArchivedCapture` needs except
 *  the parts derivable from the filename (`seq`, `id`, `file`, `path`). */
type Meta = {
  url: string;
  status: number;
  method?: string;
  requestId?: string;
  pattern?: string;
  contentType?: string;
  capturedAt: string;
  bytes: number;
};

function archiveError(code: string, op: string, cause: unknown): CapabilityError {
  return new CapabilityError({
    code,
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: `raw archive ${op} failed: ${String(cause)}`,
    evidence: cause instanceof Error ? cause.stack ?? cause.message : String(cause),
  });
}

/** A capture that never reached disk. Nothing downstream can recover it. */
function writeFailed(op: string, cause: unknown): CapabilityError {
  return archiveError("ARCHIVE_WRITE_FAILED", op, cause);
}

/** The archive could not be read back. Split from `ARCHIVE_WRITE_FAILED`
 *  because receipts and `log:why` group by code: folding a failed read into
 *  the write bucket permanently miscounts how runs actually fail. */
function readFailed(op: string, cause: unknown): CapabilityError {
  return archiveError("ARCHIVE_READ_FAILED", op, cause);
}

/** The file is there and readable but is not valid gzip — a truncated or
 *  damaged archive, which is a different problem from an I/O failure and
 *  points at a different fix. */
function corrupt(op: string, cause: unknown): CapabilityError {
  return archiveError("ARCHIVE_CORRUPT", op, cause);
}

function entryMissing(id: string): CapabilityError {
  return new CapabilityError({
    code: "ARCHIVE_ENTRY_MISSING",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: `no archived capture matching "${id}"`,
  });
}

function bodyBuffer(body: string | Uint8Array): Buffer {
  return typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
}

/**
 * Raw-first storage over one directory (D2): every captured response body is
 * gzipped and written to disk before anything parses it, alongside a shape
 * hash that groups responses by structure regardless of their data.
 *
 * Layout: `<seq>-<shapeHash>.json.gz` holds the compressed body; a sidecar
 * `<seq>-<shapeHash>.meta.json` beside it holds the rest of the metadata.
 * Two files, not one `index.ndjson` — a crash between writing the body and
 * appending to an index would leave an archived body invisible to every
 * later step, which is exactly the failure raw-first storage exists to
 * prevent. A sidecar fails the other way: the body is always enumerable by
 * scanning the directory, and only its metadata can go missing. See
 * DECISIONS.md D30 and D31.
 */
export class RawArchive {
  readonly #dir: string;
  /** Lazily seeded from the directory on first use, so a resumed run
   *  continues numbering instead of overwriting what is already there. */
  #seq: number | undefined;

  constructor(dir: string) {
    this.#dir = dir;
  }

  /**
   * Persists one capture. Order is: shape hash, then gzip, then the body
   * file, then the sidecar. The body must never be invisible because the
   * sidecar write failed — so the sidecar is written last and its own failure
   * is a warning on the returned record, never a throw.
   *
   * The hash is computed before the body reaches disk because the filename
   * embeds it. That reads as an inversion of raw-first (D2), and is not one:
   * the body is already fully buffered in memory by then, `shapeHashOfBody`
   * is total (it cannot throw — a non-JSON body gets `NON_JSON_SHAPE`), and
   * the only failure it could add is an OOM on a pathological body, which no
   * ordering survives and which `NETWORK_RESOURCE_BUFFER_BYTES` caps at 20MB
   * upstream anyway. See D31.
   */
  async archive(input: CaptureInput): Promise<ArchivedCapture> {
    const bytes = bodyBuffer(input.body);
    const shapeHash = shapeHashOfBody(bytes);
    const capturedAt = input.capturedAt ?? new Date().toISOString();

    let compressed: Buffer;
    try {
      compressed = await gzip(bytes);
    } catch (cause) {
      throw writeFailed("gzip", cause);
    }

    await this.#ensureDir();

    const { seq, file, path } = await this.#claimSeq(shapeHash, compressed);

    const meta: Meta = {
      url: input.url,
      status: input.status,
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.pattern !== undefined ? { pattern: input.pattern } : {}),
      ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
      capturedAt,
      bytes: bytes.length,
    };
    let warning: CaptureWarning | undefined;
    try {
      await this.#writeExclusive(this.#metaPath(file), Buffer.from(JSON.stringify(meta), "utf8"));
    } catch (cause) {
      // Deliberately not a throw. The body is already on disk and already
      // enumerable by `list()` — this is precisely the degraded case the
      // sidecar layout was chosen to produce instead of a lost capture (D30),
      // and halting the run here would discard that advantage at the one
      // moment it pays off. It surfaces as a receipt warning instead.
      warning = {
        code: "ARCHIVE_SIDECAR_FAILED",
        message:
          `the body for ${file} is archived and readable; only its metadata sidecar ` +
          `could not be written: ${String(cause)}`,
      };
    }

    return {
      seq,
      id: file,
      file,
      path,
      shapeHash,
      url: input.url,
      status: input.status,
      method: input.method,
      requestId: input.requestId,
      pattern: input.pattern,
      contentType: input.contentType,
      capturedAt,
      bytes: bytes.length,
      ...(warning ? { warning } : {}),
    };
  }

  /** Every capture in the directory, sorted by sequence number. Metadata is
   *  attached when its sidecar is present; a missing sidecar still yields an
   *  entry, just with only what the filename itself carries. */
  async list(): Promise<ArchivedCapture[]> {
    const names = await this.#tryReaddir();
    const bodies = names.filter((n) => n.endsWith(".json.gz")).sort();

    const entries: ArchivedCapture[] = [];
    for (const file of bodies) {
      const parsed = parseFileName(file);
      if (!parsed) continue; // not one of ours: ignore rather than choke on it

      const path = join(this.#dir, file);
      const meta = await this.#readMeta(file);

      entries.push({
        seq: parsed.seq,
        id: file,
        file,
        path,
        shapeHash: parsed.shapeHash,
        url: meta?.url ?? "",
        status: meta?.status ?? 0,
        method: meta?.method,
        requestId: meta?.requestId,
        pattern: meta?.pattern,
        contentType: meta?.contentType,
        capturedAt: meta?.capturedAt ?? "",
        bytes: meta?.bytes ?? 0,
      });
    }

    return entries.sort((a, b) => a.seq - b.seq);
  }

  /** Reads one archived body back, gunzipped and byte-identical to what was
   *  passed to `archive()`. Accepts either the `ArchivedCapture` `archive()`
   *  returned or the bare filename (`id`/`file`). */
  async read(entry: ArchivedCapture | string): Promise<Buffer> {
    const file = typeof entry === "string" ? entry : entry.file;
    const path = typeof entry === "string" ? join(this.#dir, file) : entry.path;

    let compressed: Buffer;
    try {
      compressed = await readFile(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw entryMissing(file);
      throw readFailed(`read ${file}`, cause);
    }

    try {
      return await gunzip(compressed);
    } catch (cause) {
      throw corrupt(`gunzip ${file}`, cause);
    }
  }

  /** Same as `read()`, decoded as UTF-8 text. */
  async readText(entry: ArchivedCapture | string): Promise<string> {
    return (await this.read(entry)).toString("utf8");
  }

  async #ensureDir(): Promise<void> {
    try {
      await mkdir(this.#dir, { recursive: true });
    } catch (cause) {
      throw writeFailed("create directory", cause);
    }
  }

  /**
   * Picks the next sequence number and writes the gzipped body to it in one
   * exclusive-create (`wx`) open — claim and write are the same operation,
   * so there is never a window with an empty, half-claimed body file on
   * disk. Two `RawArchive` instances racing over the same directory bump
   * past each other's claims on `EEXIST` instead of one clobbering the
   * other's body.
   */
  async #claimSeq(
    shapeHash: string,
    compressed: Buffer,
  ): Promise<{ seq: number; file: string; path: string }> {
    if (this.#seq === undefined) this.#seq = await this.#seedSeq();

    for (;;) {
      const seq = this.#seq++;
      const file = fileName(seq, shapeHash);
      const path = join(this.#dir, file);
      try {
        await this.#writeExclusive(path, compressed);
        return { seq, file, path };
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "EEXIST") continue; // seq taken, try the next
        throw writeFailed(`write ${file}`, cause);
      }
    }
  }

  /** Writes with `wx` (exclusive create): the destination must not already
   *  exist, which is what makes both the body claim and the sidecar write
   *  safe against a second instance racing over the same directory. */
  async #writeExclusive(path: string, data: Buffer): Promise<void> {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
  }

  /** Scans the directory once for the highest existing `seq` so a resumed
   *  run continues numbering instead of restarting at 0 and colliding. */
  async #seedSeq(): Promise<number> {
    const names = await this.#tryReaddir();
    let max = -1;
    for (const name of names) {
      const parsed = parseFileName(name);
      if (parsed && parsed.seq > max) max = parsed.seq;
    }
    return max + 1;
  }

  async #tryReaddir(): Promise<string[]> {
    try {
      return await readdir(this.#dir);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw readFailed("read directory", cause);
    }
  }

  #metaPath(bodyFile: string): string {
    return join(this.#dir, this.#metaFileName(bodyFile));
  }

  #metaFileName(bodyFile: string): string {
    return bodyFile.replace(/\.json\.gz$/, ".meta.json");
  }

  async #readMeta(bodyFile: string): Promise<Meta | undefined> {
    try {
      const raw = await readFile(this.#metaPath(bodyFile), "utf8");
      return JSON.parse(raw) as Meta;
    } catch {
      return undefined; // missing or unreadable sidecar: the body still lists, just thinner
    }
  }
}

function fileName(seq: number, shapeHash: string): string {
  return `${String(seq).padStart(SEQ_WIDTH, "0")}-${shapeHash}.json.gz`;
}

/** Parses `<seq>-<shapeHash>.json.gz` back into its parts. Returns undefined
 *  for anything else found in the directory (stray files, sidecars). */
function parseFileName(name: string): { seq: number; shapeHash: string } | undefined {
  const m = /^(\d+)-([0-9a-f]+)\.json\.gz$/.exec(name);
  if (!m) return undefined;
  return { seq: Number(m[1]), shapeHash: m[2]! };
}
