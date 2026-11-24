import { isIP } from "node:net";

export const DEFAULT_INSTAGRAM_API_VERSION = "v26.0";

export type InstagramOutcome =
  | { kind: "published"; mediaId: string }
  | { kind: "failed" | "needs_review"; error: string };

export type InstagramVerification = "confirmed" | "unconfirmed" | "unavailable";

export type PublishInstagram = ((input: {
  imageUrl: string;
  caption: string;
  signal: AbortSignal;
  recordContainer: (containerId: string) => void;
}) => Promise<InstagramOutcome>) & {
  readonly accountId: string;
  verify?: (
    containerId: string,
    signal: AbortSignal,
  ) => Promise<InstagramVerification>;
};

type InstagramFetch = (input: string, init: RequestInit) => Promise<Response>;
const graphId = /^[0-9]{1,40}$/;
const definiteRejections = new Set([10, 100, 190, 200, 9004, 9007, 80002]);

export function instagramImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, "").toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      isIP(host) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/i.test(host) ||
      /(?:^|\.)(localhost|local|internal|home\.arpa|invalid|test)$/.test(host)
    ) {
      return null;
    }
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function instagramId(value: unknown): value is string {
  return typeof value === "string" && graphId.test(value);
}

function identifier(payload: unknown) {
  if (
    payload &&
    typeof payload === "object" &&
    "id" in payload &&
    instagramId(payload.id)
  ) {
    return payload.id;
  }
  return null;
}

function rejected(status: number, payload: unknown) {
  if (
    status < 400 ||
    status >= 500 ||
    !payload ||
    typeof payload !== "object" ||
    !("error" in payload)
  )
    return false;
  const { error } = payload;
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "number" &&
      definiteRejections.has(error.code) &&
      (!("is_transient" in error) || error.is_transient !== true),
  );
}

export function createInstagramPublisher({
  accountId,
  accessToken,
  apiVersion = DEFAULT_INSTAGRAM_API_VERSION,
  fetcher = fetch,
}: {
  accountId: string;
  accessToken: string;
  apiVersion?: string;
  fetcher?: InstagramFetch;
}): PublishInstagram {
  if (
    !instagramId(accountId) ||
    !accessToken ||
    /[^\x21-\x7e]/.test(accessToken) ||
    !/^v[1-9][0-9]{0,2}\.[0-9]{1,2}$/.test(apiVersion)
  ) {
    throw new Error("Invalid Instagram publisher configuration");
  }
  const base = `https://graph.instagram.com/${apiVersion}/${accountId}`;

  async function post(
    edge: "media" | "media_publish",
    body: Record<string, string>,
    signal: AbortSignal,
  ) {
    const response = await fetcher(`${base}/${edge}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      payload: (await response.json().catch(() => null)) as unknown,
    };
  }

  const publish = async ({
    imageUrl,
    caption,
    signal,
    recordContainer,
  }: Parameters<PublishInstagram>[0]): Promise<InstagramOutcome> => {
    const image = instagramImageUrl(imageUrl);
    if (!image) return { kind: "failed", error: "INVALID_INSTAGRAM_IMAGE" };
    let containerId: string | null;
    try {
      signal.throwIfAborted();
      const result = await post("media", { image_url: image, caption }, signal);
      containerId = result.ok ? identifier(result.payload) : null;
      if (!containerId)
        return { kind: "failed", error: "INSTAGRAM_CONTAINER_FAILED" };
    } catch {
      // This stage cannot publish a post, even if Meta created the container.
      return { kind: "failed", error: "INSTAGRAM_CONTAINER_FAILED" };
    }

    recordContainer(containerId);
    if (signal.aborted)
      return { kind: "failed", error: "INSTAGRAM_PUBLISH_NOT_SENT" };

    try {
      const result = await post(
        "media_publish",
        { creation_id: containerId },
        signal,
      );
      const mediaId = result.ok ? identifier(result.payload) : null;
      if (mediaId) return { kind: "published", mediaId };
      if (rejected(result.status, result.payload)) {
        return { kind: "failed", error: "INSTAGRAM_PUBLISH_REJECTED" };
      }
    } catch {
      // The connection may fail after Meta receives the request.
    }
    return { kind: "needs_review", error: "INSTAGRAM_PUBLISH_OUTCOME_UNKNOWN" };
  };
  async function verify(
    containerId: string,
    signal: AbortSignal,
  ): Promise<InstagramVerification> {
    if (!instagramId(containerId)) return "unavailable";
    try {
      const response = await fetcher(
        `https://graph.instagram.com/${apiVersion}/${containerId}?fields=status_code`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${accessToken}` },
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(8_000)]),
        },
      );
      const payload = await response.json();
      if (!response.ok || identifier(payload) !== containerId)
        return "unavailable";
      return payload.status_code === "PUBLISHED" ? "confirmed" : "unconfirmed";
    } catch {
      return "unavailable";
    }
  }
  return Object.assign(publish, { accountId, verify }) as PublishInstagram;
}

export function instagramPublisherFromEnv(
  env: Record<string, string | undefined> = process.env,
) {
  const accountId = env.OPENBOT_INSTAGRAM_ACCOUNT_ID?.trim();
  const accessToken = env.OPENBOT_INSTAGRAM_ACCESS_TOKEN?.trim();
  if (!accountId || !accessToken) return undefined;
  return createInstagramPublisher({
    accountId,
    accessToken,
    apiVersion: env.OPENBOT_INSTAGRAM_API_VERSION?.trim() || undefined,
  });
}
