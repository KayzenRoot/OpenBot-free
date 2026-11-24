import { expect, test } from "bun:test";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAttachmentRoutes,
  LOCAL_ATTACHMENT_BYTES,
  LOCAL_ATTACHMENT_REQUEST_BYTES,
  type LocalAttachment,
} from "./attachments";

const conversationIds = new Set(["one", "two"]);
const pathFor = (conversationId: string, id?: string) =>
  `/api/local/conversations/${conversationId}/attachments${id ? `/${id}` : ""}`;

function routes(dbPath = ":memory:") {
  return createAttachmentRoutes({
    dbPath,
    conversationExists: (id) => conversationIds.has(id),
  });
}

async function request(
  store: ReturnType<typeof routes>,
  method: string,
  pathname: string,
  body?: FormData | ReadableStream<Uint8Array>,
  headers?: HeadersInit,
) {
  const response = await store.handle(
    new Request(`http://127.0.0.1${pathname}`, { method, body, headers }),
    pathname,
  );
  if (!response) throw new Error("The attachment route did not respond");
  return response;
}

function formWith(file: File) {
  const form = new FormData();
  form.set("file", file);
  return form;
}

test("persists bytes and metadata and isolates each attachment to its conversation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openbot-attachments-"));
  const dbPath = join(directory, "attachments.sqlite");
  const payload = new Uint8Array([0, 1, 2, 63, 255]);
  try {
    const original = routes(dbPath);
    let attachment: LocalAttachment;
    try {
      const response = await request(
        original,
        "POST",
        pathFor("one"),
        formWith(new File([payload], "diagram.png", { type: "image/png" })),
      );
      expect(response.status).toBe(201);
      ({ attachment } = (await response.json()) as {
        attachment: LocalAttachment;
      });
      expect(attachment).toMatchObject({
        filename: "diagram.png",
        mimeType: "image/png",
        size: 5,
      });
    } finally {
      original.close();
    }

    const reopened = routes(dbPath);
    try {
      expect(
        await (await request(reopened, "GET", pathFor("one"))).json(),
      ).toEqual({ attachments: [attachment] });
      expect(
        await (await request(reopened, "GET", pathFor("two"))).json(),
      ).toEqual({ attachments: [] });
      expect(
        (await request(reopened, "GET", pathFor("two", attachment.id))).status,
      ).toBe(404);
      expect(
        (await request(reopened, "DELETE", pathFor("two", attachment.id)))
          .status,
      ).toBe(404);
      expect((await request(reopened, "GET", pathFor("gone"))).status).toBe(
        404,
      );

      const download = await request(
        reopened,
        "GET",
        pathFor("one", attachment.id),
      );
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(download.headers.get("content-disposition")).toStartWith(
        'attachment; filename="diagram.png";',
      );
      expect(download.headers.get("x-content-type-options")).toBe("nosniff");
      expect(download.headers.get("cache-control")).toBe("private, no-store");
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(payload);

      expect(
        (await request(reopened, "DELETE", pathFor("one", attachment.id)))
          .status,
      ).toBe(204);
      expect(
        (await request(reopened, "GET", pathFor("one", attachment.id))).status,
      ).toBe(404);
      expect(
        await (await request(reopened, "GET", pathFor("one"))).json(),
      ).toEqual({ attachments: [] });
    } finally {
      reopened.close();
    }
  } finally {
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      rmSync(file, { force: true });
    }
    rmdirSync(directory);
  }
});

test("normalizes a path-like name and MIME and serves active formats as opaque downloads", async () => {
  const store = routes();
  try {
    const upload = await request(
      store,
      "POST",
      pathFor("one"),
      formWith(
        new File(
          ["<p>Example</p>"],
          'C:\\temp/../report"\r\nX-Unwanted: header\u202e.html',
          { type: "Text/HTML; Charset=UTF-8" },
        ),
      ),
    );
    expect(upload.status).toBe(201);
    const { attachment } = (await upload.json()) as {
      attachment: LocalAttachment;
    };
    expect(attachment.filename).toStartWith("report");
    expect(attachment.filename).not.toMatch(/["\\/:\r\n\u202e]/u);
    expect(attachment.mimeType).toBe("text/html");

    const response = await request(store, "GET", pathFor("one", attachment.id));
    expect(response.headers.get("x-unwanted")).toBeNull();
    expect(response.headers.get("content-disposition")).toStartWith(
      "attachment;",
    );
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(await response.text()).toBe("<p>Example</p>");
  } finally {
    store.close();
  }
});

test("enforces the file and multipart body ceilings, including streaming uploads", async () => {
  const store = routes();
  try {
    const pathname = pathFor("one");
    const fullSize = formWith(
      new File([new Uint8Array(LOCAL_ATTACHMENT_BYTES)], "maximum.bin"),
    );
    const tooLarge = formWith(
      new File([new Uint8Array(LOCAL_ATTACHMENT_BYTES + 1)], "too-large.bin"),
    );
    expect((await request(store, "POST", pathname, fullSize)).status).toBe(201);
    expect((await request(store, "POST", pathname, tooLarge)).status).toBe(413);

    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(LOCAL_ATTACHMENT_REQUEST_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const rejected = await request(store, "POST", pathname, stream, {
      "content-type": "multipart/form-data; boundary=example",
    });
    expect(rejected.status).toBe(413);
    expect(cancelled).toBe(true);
    const listing = (await (await request(store, "GET", pathname)).json()) as {
      attachments: LocalAttachment[];
    };
    expect(listing.attachments).toHaveLength(1);
    expect(listing.attachments[0]?.size).toBe(LOCAL_ATTACHMENT_BYTES);

    const wrongField = new FormData();
    wrongField.set("metadata", "test");
    expect((await request(store, "POST", pathname, wrongField)).status).toBe(
      400,
    );
    expect((await request(store, "POST", pathname)).status).toBe(415);
  } finally {
    store.close();
  }
});
