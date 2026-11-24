import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { analyzeSales } from "./business-content";

const maximumBytes = 128 * 1024;

export function createSalesInbox(directory: string) {
  const file = join(directory, "vendas.csv");
  let status: "waiting" | "ready" | "error" = "waiting";
  let report: ReturnType<typeof analyzeSales> | undefined;
  let updatedAt: string | undefined;
  let previousDigest: string | undefined;
  let problem: string | undefined;
  let busy = false;

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const folder = await lstat(directory);
      const source = await lstat(file);
      if (!folder.isDirectory() || !source.isFile())
        throw new Error("SALES_INBOX_INVALID_FILE");
      if (source.size > maximumBytes) throw new Error("SALES_INBOX_TOO_LARGE");
      const handle = await open(file, "r");
      let bytes: Buffer;
      try {
        const current = await handle.stat();
        if (
          !current.isFile() ||
          current.ino !== source.ino ||
          current.dev !== source.dev
        ) {
          throw new Error("SALES_INBOX_INVALID_FILE");
        }
        const buffer = Buffer.alloc(maximumBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > maximumBytes) throw new Error("SALES_INBOX_TOO_LARGE");
        const final = await handle.stat();
        if (final.size !== bytesRead || final.mtimeMs !== current.mtimeMs) {
          throw new Error("SALES_INBOX_FILE_CHANGED");
        }
        bytes = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }

      const digest = createHash("sha256").update(bytes).digest("hex");
      if (status === "ready" && digest === previousDigest) return;
      report = analyzeSales(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      previousDigest = digest;
      updatedAt = new Date().toISOString();
      problem = undefined;
      status = "ready";
    } catch (error) {
      const missing =
        error instanceof Error && "code" in error && error.code === "ENOENT";
      status = missing ? "waiting" : "error";
      problem = missing ? undefined : "SALES_INBOX_IMPORT_FAILED";
      report = undefined;
      updatedAt = undefined;
    } finally {
      busy = false;
    }
  }

  function handle(request: Request, pathname: string): Response | null {
    if (pathname !== "/api/local/business/sales/inbox") return null;
    const headers = { "cache-control": "no-store" };
    if (request.method !== "GET") {
      return Response.json(
        { error: "METHOD_NOT_ALLOWED" },
        { status: 405, headers },
      );
    }
    return Response.json(
      { directory, status, report, updatedAt, problem },
      { headers },
    );
  }

  return { handle, tick };
}
