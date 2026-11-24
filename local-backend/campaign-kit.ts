import { type createCampaignPilot, renderBundlePage } from "./campaign-pilot";
import { jsonError, jsonObject } from "./conversation-routes";
import { assembleZip } from "./epub";
import type { createStudioPilot } from "./studio-pilot";

export function createCampaignKit(
  studio: Pick<ReturnType<typeof createStudioPilot>, "getBook" | "handle">,
  campaign: Pick<ReturnType<typeof createCampaignPilot>, "getCampaign">,
) {
  let busy = false;
  return async (
    request: Request,
    pathname: string,
  ): Promise<Response | null> => {
    if (pathname !== "/api/local/business/campaign/kit") return null;
    if (request.method !== "POST") return jsonError(405, "METHOD_NOT_ALLOWED");
    const input = await jsonObject(request);
    const bookId = input?.bookId;
    const revision = input?.revision;
    if (
      typeof bookId !== "string" ||
      !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(bookId) ||
      typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      return jsonError(400, "CAMPAIGN_KIT_INVALID_BOOK");

    const current = campaign.getCampaign();
    const book = studio.getBook(bookId, revision);
    if (!current || !book || current.title !== book.title)
      return jsonError(409, "CAMPAIGN_KIT_BOOK_MISMATCH");
    if (busy) return jsonError(409, "CAMPAIGN_KIT_BUSY");

    async function asset(format: "sample" | "cover") {
      const assetPath = `/api/local/studio/books/${bookId}/export/${format}`;
      const target = new URL(assetPath, request.url);
      target.searchParams.set("revision", String(revision));
      const response = await studio.handle(
        new Request(target, { signal: request.signal }),
        assetPath,
      );
      if (!response) throw new Error("Studio export route not found");
      return response;
    }

    busy = true;
    try {
      const sample = await asset("sample");
      if (!sample.ok) return sample;
      const cover = await asset("cover");
      if (!cover.ok) return cover;
      const zip = assembleZip([
        ["index.html", renderBundlePage(current)],
        ["amostra.pdf", new Uint8Array(await sample.arrayBuffer())],
        ["capa.png", new Uint8Array(await cover.arrayBuffer())],
      ]);
      return new Response(zip, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${current.slug}-site.zip"`,
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return jsonError(500, "CAMPAIGN_KIT_FAILED");
    } finally {
      busy = false;
    }
  };
}
