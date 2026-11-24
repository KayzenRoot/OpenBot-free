import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createPersonalBrowser } from "./personal-browser";

type Browser = ReturnType<typeof createPersonalBrowser>;
type Tab = { id: string; title: string; url: string };
type State = { open: boolean; tabs: Tab[] };

const api = "/api/local/browser";
const temporaryRoot = realpathSync(tmpdir());
const prefix = "openbot-personal-browser-";

function removeTemporaryProfile(directory: string) {
  const path = realpathSync(directory);
  if (dirname(path) !== temporaryRoot || !basename(path).startsWith(prefix)) {
    throw new Error("Unexpected test profile location");
  }
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 100,
  });
}

async function call(
  browser: Browser,
  method: string,
  action = "",
  body?: object,
) {
  const pathname = api + action;
  const request = new Request(`http://127.0.0.1${pathname}`, {
    method,
    ...(body
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  });
  const response = await browser.handle(request, pathname);
  if (!response) throw new Error("Missing personal-browser route");
  return response;
}

async function open(browser: Browser, url?: string) {
  const response = await call(browser, "POST", "/open", url ? { url } : {});
  expect(response.status).toBe(200);
  return (await response.json()) as State;
}

test("metadata never starts the browser and only explicit JSON web addresses are accepted", async () => {
  const directory = mkdtempSync(join(temporaryRoot, prefix));
  const browser = createPersonalBrowser({
    profileDir: join(directory, "profile"),
    headless: true,
  });
  try {
    expect(await (await call(browser, "GET")).json()).toEqual({
      open: false,
      tabs: [],
    });
    expect((await call(browser, "GET", "/open")).status).toBe(405);
    expect((await call(browser, "POST", "/open")).status).toBe(415);
    expect((await call(browser, "GET", "/tabs/missing/text")).status).toBe(404);
    expect((await call(browser, "GET", "/tabs/missing/screen")).status).toBe(
      404,
    );
    expect((await call(browser, "POST", "/close")).status).toBe(204);

    const urls = [
      "file:///C:/example.txt",
      "edge://settings",
      "javascript:void(0)",
      "data:text/plain,example",
      "https://test:password@example.invalid",
      "ftp://example.invalid",
      "relative/address",
    ];
    for (const url of urls) {
      const rejected = await call(browser, "POST", "/open", { url });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: "INVALID_BROWSER_URL" });
    }
    expect(
      await browser.handle(
        new Request("http://127.0.0.1/api/local/other"),
        "/api/local/other",
      ),
    ).toBeNull();
  } finally {
    await browser.close();
    removeTemporaryProfile(directory);
  }
});

test("refuses directories owned by another browser profile", async () => {
  const directory = mkdtempSync(join(temporaryRoot, prefix));
  writeFileSync(join(directory, "unrelated.txt"), "Existing profile data");
  const existing = createPersonalBrowser({
    profileDir: directory,
    headless: true,
  });
  const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const defaultEdge = createPersonalBrowser({
    profileDir: join(local, "Microsoft", "Edge", "User Data", "OpenBot"),
    headless: true,
  });
  try {
    for (const browser of [existing, defaultEdge]) {
      const response = await call(browser, "POST", "/open", {});
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "BROWSER_PROFILE_IN_USE",
      });
    }
  } finally {
    await existing.close();
    await defaultEdge.close();
    removeTemporaryProfile(directory);
  }
});

test.skipIf(process.env.OPENBOT_TEST_EDGE !== "1")(
  "uses the dedicated Edge profile, shows local tabs and reads only the chosen page",
  async () => {
    const directory = mkdtempSync(join(temporaryRoot, prefix));
    const browser = createPersonalBrowser({
      profileDir: join(directory, "profile"),
      headless: true,
    });
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname === "/probe") {
          return new Response(
            request.headers.get("cookie")?.includes("personal_probe=kept")
              ? "<title>Probe</title><p>Profile cookie persisted</p>"
              : "<title>Probe</title><p>Profile cookie missing</p>",
            { headers: { "content-type": "text/html" } },
          );
        }
        return new Response(
          `<!doctype html><title>Visible fixture</title>
          <main><p>Visible fixture text</p>
          <input value="input-secret"><textarea>textarea-secret</textarea>
          <select><option>option-secret</option></select>
          <div contenteditable>editable-secret</div>
          <div hidden>hidden-secret</div>
          <div style="opacity:0">transparent-secret</div>
          <div style="position:absolute;top:5000px">offscreen-secret</div>
          <div style="height:1px;overflow:hidden">clipped-secret</div>
          <div style="color:transparent">color-secret</div>
          <div style="position:absolute;top:550px;left:50px">covered-secret</div>
          <div style="position:absolute;top:548px;left:48px;width:200px;height:40px;background:white"></div>
          <script>localStorage.setItem("fixture", "storage-secret")</script>
          </main>`,
          {
            headers: {
              "content-type": "text/html",
              "set-cookie":
                "personal_probe=kept; Path=/; Max-Age=3600; HttpOnly; SameSite=Strict",
            },
          },
        );
      },
    });
    try {
      const blank = await open(browser);
      const second = await open(browser);
      expect(second.tabs.length).toBe(blank.tabs.length + 1);
      const blankTab = blank.tabs.find(({ url }) => url === "about:blank");
      if (!blankTab) throw new Error("Edge did not provide a blank tab");
      expect(
        (await call(browser, "GET", `/tabs/${blankTab.id}/text`)).status,
      ).toBe(403);

      const opened = await open(
        browser,
        `${fixture.url.origin}/fixture?secret=hidden#fragment`,
      );
      const page = opened.tabs.find(({ title }) => title === "Visible fixture");
      if (!page) throw new Error("The local fixture was not loaded");
      expect(page.url).toBe(`${fixture.url.origin}/fixture`);
      expect(
        (await call(browser, "POST", `/tabs/${page.id}/focus`)).status,
      ).toBe(204);
      const excerpt = await call(browser, "GET", `/tabs/${page.id}/text`);
      expect(excerpt.status).toBe(200);
      expect(excerpt.headers.get("cache-control")).toBe("private, no-store");
      const { text } = (await excerpt.json()) as { text: string };
      expect(text).toContain("Visible fixture text");
      expect(text).not.toContain("-secret");

      const image = await call(browser, "GET", `/tabs/${page.id}/screen`);
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toBe("image/png");
      expect(image.headers.get("cache-control")).toBe("private, no-store");
      expect(
        Array.from(new Uint8Array(await image.arrayBuffer()).slice(0, 8)),
      ).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

      expect(
        (await call(browser, "POST", `/tabs/${blankTab.id}/close`)).status,
      ).toBe(204);
      expect(
        (await call(browser, "GET", `/tabs/${blankTab.id}/screen`)).status,
      ).toBe(404);
      expect((await call(browser, "POST", "/close")).status).toBe(204);
      expect(await (await call(browser, "GET")).json()).toEqual({
        open: false,
        tabs: [],
      });

      const reopened = await open(browser, `${fixture.url.origin}/probe`);
      const probe = reopened.tabs.find(({ title }) => title === "Probe");
      if (!probe) throw new Error("The profile probe was not loaded");
      expect(probe.id).not.toBe(page.id);
      expect(
        await (await call(browser, "GET", `/tabs/${probe.id}/text`)).json(),
      ).toEqual({
        text: "Profile cookie persisted",
      });
    } finally {
      await browser.close();
      fixture.stop();
      removeTemporaryProfile(directory);
    }
  },
  { timeout: 60_000 },
);
