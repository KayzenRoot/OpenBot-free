import { expect, test } from "bun:test";
import {
  createInstagramPublisher,
  DEFAULT_INSTAGRAM_API_VERSION,
  instagramImageUrl,
  instagramPublisherFromEnv,
} from "./social-instagram";
import { createLocalSocial } from "./social-queue";

const accountId = "1784000000000001";
const containerId = "1793000000000001";
const mediaId = "1793000000000002";

test("reconciles an uncertain publication with one read and never sends it again", async () => {
  const calls: [string, string][] = [];
  const publisher = createInstagramPublisher({
    accountId,
    accessToken: "fixture-token",
    fetcher: async (url, init) => {
      calls.push([init.method ?? "", url]);
      if (init.method === "GET")
        return Response.json({ id: containerId, status_code: "PUBLISHED" });
      if (url.endsWith("/media")) return Response.json({ id: containerId });
      throw new Error("Connection interrupted after sending");
    },
  });
  const social = createLocalSocial({
    dbPath: ":memory:",
    publishInstagram: publisher,
  });
  const root = "/api/local/social";
  function send(path: string, body: object) {
    return social.handle(
      new Request(`http://127.0.0.1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      path,
    );
  }
  try {
    const { item } = await (await send(root, {
      platform: "instagram",
      caption: "Rascunho",
      imageUrl: "https://media.example.com/photo.jpg",
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
    }))!.json();
    expect(
      (await send(`${root}/${item.id}/approve`, { revision: item.revision }))
        ?.ok,
    ).toBe(true);
    await social.tick();
    await social.tick();
    const result = await social.handle(
      new Request(`http://127.0.0.1${root}/${item.id}`),
      `${root}/${item.id}`,
    );
    expect(await result?.json()).toMatchObject({
      item: { status: "published", resultSource: "api", remoteId: null },
    });
    expect(calls.map(([method]) => method)).toEqual(["POST", "POST", "GET"]);
    expect(calls[2]?.[1]).toBe(
      `https://graph.instagram.com/${DEFAULT_INSTAGRAM_API_VERSION}/${containerId}?fields=status_code`,
    );
  } finally {
    await social.close();
  }
});

function input(onContainer: (id: string) => void = () => {}) {
  return {
    imageUrl: "https://media.example.com/sample.jpg",
    caption: "Texto aprovado 😊",
    signal: new AbortController().signal,
    recordContainer: onContainer,
  };
}

test("sends one photo to the official endpoints and records the container before publishing", async () => {
  const calls: string[] = [];
  const body: unknown[] = [];
  const publisher = createInstagramPublisher({
    accountId,
    accessToken: "fixture-token",
    fetcher: async (url, init) => {
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("authorization")).toBe(
        "Bearer fixture-token",
      );
      calls.push(url);
      body.push(JSON.parse(String(init.body)));
      return Response.json({
        id: url.endsWith("media_publish") ? mediaId : containerId,
      });
    },
  });

  const result = await publisher(input((id) => calls.push(`container:${id}`)));
  expect(result).toEqual({ kind: "published", mediaId });
  expect(calls).toEqual([
    `https://graph.instagram.com/${DEFAULT_INSTAGRAM_API_VERSION}/${accountId}/media`,
    `container:${containerId}`,
    `https://graph.instagram.com/${DEFAULT_INSTAGRAM_API_VERSION}/${accountId}/media_publish`,
  ]);
  expect(body).toEqual([
    {
      image_url: "https://media.example.com/sample.jpg",
      caption: "Texto aprovado 😊",
    },
    { creation_id: containerId },
  ]);
});

test("treats transport or malformed publish replies as indeterminate and never repeats a request", async () => {
  for (const fail of [
    () => {
      throw new Error("Connection ended after request");
    },
    () => Response.json({ accepted: true }),
    () => Response.json({ error: { code: 2 } }, { status: 500 }),
  ]) {
    let calls = 0;
    const publisher = createInstagramPublisher({
      accountId,
      accessToken: "fixture-token",
      apiVersion: "v25.0",
      fetcher: async (url) => {
        expect(url).toStartWith("https://graph.instagram.com/v25.0/");
        calls += 1;
        return calls === 1 ? Response.json({ id: containerId }) : fail();
      },
    });
    expect(await publisher(input())).toEqual({
      kind: "needs_review",
      error: "INSTAGRAM_PUBLISH_OUTCOME_UNKNOWN",
    });
    expect(calls).toBe(2);
  }
});

test("refuses private-appearing image addresses and distinguishes a definite publish rejection", async () => {
  for (const url of [
    "file:///C:/image.jpg",
    "https://localhost/image.jpg",
    "https://0x7f000001/image.jpg",
    "https://192.168.1.10/image.jpg",
    "https://[::1]/image.jpg",
    "https://host.local/image.jpg",
    "https://user:password@media.example.com/image.jpg",
    "http://media.example.com/image.jpg",
  ]) {
    expect(instagramImageUrl(url)).toBeNull();
  }
  expect(
    instagramImageUrl("https://MEDIA.example.com/file.jpg?size=large#label"),
  ).toBe("https://media.example.com/file.jpg?size=large");
  expect(
    instagramPublisherFromEnv({ OPENBOT_INSTAGRAM_ACCOUNT_ID: accountId }),
  ).toBeUndefined();

  let calls = 0;
  const publisher = createInstagramPublisher({
    accountId,
    accessToken: "fixture-token",
    fetcher: async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ id: containerId })
        : Response.json(
            { error: { code: 190, message: "Private response" } },
            { status: 400 },
          );
    },
  });
  expect(await publisher(input())).toEqual({
    kind: "failed",
    error: "INSTAGRAM_PUBLISH_REJECTED",
  });
  expect(calls).toBe(2);
});
