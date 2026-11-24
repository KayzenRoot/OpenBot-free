import {
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type BrowserContext, chromium, type Page } from "playwright-core";

const basePath = "/api/local/browser";
const tabPath =
  /^\/api\/local\/browser\/tabs\/([A-Za-z0-9_-]{1,128})\/(focus|close|screen|text)$/;
const headers = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};
const markerName = ".openbot-personal-profile";
const markerContent = "openbot-personal-browser-v1\n";
const maxText = 8_000;
const readTimeout = 5_000;

type Tab = { id: string; page: Page; navigation: number };
type Session = { context: BrowserContext; tabs: Map<string, Tab> };

class BrowserProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function problem(status: number, code: string, allow?: string) {
  return Response.json(
    { error: code },
    {
      status,
      headers: allow ? { ...headers, allow } : headers,
    },
  );
}

function webUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function listedUrl(value: string): string {
  const url = webUrl(value);
  if (!url) return value === "about:blank" ? value : "";
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

function requireDedicatedPath(path: string) {
  const home = homedir();
  const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  const browserRoots = [
    ...["Edge", "Edge Beta", "Edge Dev", "Edge SxS"].map((channel) =>
      join(local, "Microsoft", channel, "User Data"),
    ),
    ...["Chrome", "Chrome Beta", "Chrome Dev", "Chrome SxS"].map((channel) =>
      join(local, "Google", channel, "User Data"),
    ),
    join(home, "Library", "Application Support", "Microsoft Edge"),
    join(home, "Library", "Application Support", "Google", "Chrome"),
    join(home, ".config", "microsoft-edge"),
    join(home, ".config", "google-chrome"),
    join(home, ".config", "chromium"),
  ];
  for (const root of browserRoots) {
    const through = relative(root, path);
    if (
      !through ||
      (!isAbsolute(through) &&
        through !== ".." &&
        !through.startsWith(`..${sep}`))
    ) {
      throw new BrowserProblem(409, "BROWSER_PROFILE_IN_USE");
    }
  }
}

async function prepareProfile(directory: string) {
  const requested = resolve(directory);
  requireDedicatedPath(requested);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const path = await realpath(requested);
  requireDedicatedPath(path);
  const contents = await readdir(path, { withFileTypes: true });
  const marker = contents.find(({ name }) => name === markerName);
  const markerPath = join(path, markerName);
  if (!marker && !contents.length) {
    await writeFile(markerPath, markerContent, { flag: "wx", mode: 0o600 });
    return path;
  }
  if (
    !marker?.isFile() ||
    (await readFile(markerPath, "utf8")) !== markerContent
  ) {
    throw new BrowserProblem(409, "BROWSER_PROFILE_IN_USE");
  }
  return path;
}

async function openTarget(request: Request): Promise<string | undefined> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new BrowserProblem(415, "JSON_REQUIRED");
  }
  const value: unknown = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserProblem(400, "INVALID_BROWSER_REQUEST");
  }
  if (!("url" in value)) return undefined;
  if (
    typeof value.url !== "string" ||
    !value.url.trim() ||
    value.url.length > 4_096
  ) {
    throw new BrowserProblem(400, "INVALID_BROWSER_URL");
  }
  const url = webUrl(value.url);
  if (!url || url.username || url.password) {
    throw new BrowserProblem(400, "INVALID_BROWSER_URL");
  }
  return url.href;
}

async function bounded<T>(action: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new BrowserProblem(504, "BROWSER_READ_TIMEOUT")),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// This function runs in the page. It reads only text nodes in the main frame.
function visibleExcerpt(limit: number) {
  if (!/^https?:$/.test(location.protocol) || !document.body) return "";
  const excluded =
    "script, style, noscript, template, input, textarea, select, option, [contenteditable], [role=textbox], [role=combobox], [role=spinbutton], [aria-hidden=true]";
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const parts: string[] = [];
  let total = 0;
  for (let visited = 0; total < limit && visited < 5_000; visited += 1) {
    const node = walker.nextNode();
    if (!node) break;
    const element = node.parentElement;
    const value = node.nodeValue;
    if (
      !element ||
      !value ||
      value.length > limit ||
      !/\S/.test(value) ||
      element.closest(excluded)
    )
      continue;
    if (
      !element.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        contentVisibilityAuto: true,
      })
    )
      continue;

    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (
      !rect.width ||
      !rect.height ||
      rect.left < 0 ||
      rect.top < 0 ||
      rect.right > innerWidth ||
      rect.bottom > innerHeight
    )
      continue;

    let clipped = false;
    for (
      let parent: HTMLElement | null = element;
      parent && parent !== document.body;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      if (style.overflowX === "visible" && style.overflowY === "visible")
        continue;
      const box = parent.getBoundingClientRect();
      if (
        (style.overflowX !== "visible" &&
          (rect.left < box.left || rect.right > box.right)) ||
        (style.overflowY !== "visible" &&
          (rect.top < box.top || rect.bottom > box.bottom))
      ) {
        clipped = true;
        break;
      }
    }
    if (clipped) continue;
    const covering = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    if (!covering || !element.contains(covering)) continue;
    const { color } = getComputedStyle(element);
    if (color.startsWith("rgba(") && color.endsWith(", 0)")) continue;
    const text = value
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, limit - total);
    parts.push(text);
    total += text.length + 1;
  }
  return parts.join("\n");
}

export function createPersonalBrowser({
  profileDir,
  headless = false,
}: {
  profileDir: string;
  headless?: boolean;
}) {
  let active: Session | null = null;
  let queue: Promise<void> = Promise.resolve();
  let capturing = false;

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = queue.then(operation);
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async function launch(): Promise<Session> {
    const directory = await prepareProfile(profileDir);
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(directory, {
        channel: "msedge",
        headless,
        chromiumSandbox: true,
        viewport: headless ? { width: 1280, height: 800 } : null,
        timeout: 20_000,
      });
    } catch {
      throw new BrowserProblem(503, "BROWSER_UNAVAILABLE");
    }
    const session: Session = { context, tabs: new Map() };
    function register(page: Page) {
      const id = crypto.randomUUID();
      const state = { id, page, navigation: 0 };
      session.tabs.set(id, state);
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) state.navigation += 1;
      });
      page.once("close", () => session.tabs.delete(id));
    }
    for (const page of context.pages()) register(page);
    context.on("page", register);
    context.once("close", () => {
      session.tabs.clear();
      if (active === session) active = null;
    });
    active = session;
    return session;
  }

  async function snapshot() {
    const session = active;
    if (!session) return { open: false, tabs: [] };
    const tabs = await Promise.all(
      Array.from(session.tabs.values(), async ({ id, page }) => {
        const url = listedUrl(page.url());
        const title = url
          ? await bounded(page.title(), 750).catch(() => "")
          : "";
        return { id, title: title.slice(0, 200), url };
      }),
    );
    if (active !== session) return { open: Boolean(active), tabs: [] };
    return { open: true, tabs: tabs.filter(({ id }) => session.tabs.has(id)) };
  }

  function browserTab(id: string): Tab {
    const tab = active?.tabs.get(id);
    if (!tab || tab.page.isClosed())
      throw new BrowserProblem(404, "BROWSER_TAB_NOT_FOUND");
    return tab;
  }

  function close(): Promise<void> {
    return mutate(async () => {
      const session = active;
      if (!session) return;
      await session.context.close();
      if (active === session) active = null;
    });
  }

  async function open(request: Request) {
    const target = await openTarget(request);
    return mutate(async () => {
      const existing = active;
      const session = existing ?? (await launch());
      const pages = Array.from(session.tabs.values(), ({ page }) => page);
      const reusable = existing
        ? undefined
        : pages.find((page) => page.url() === "about:blank");
      const page = reusable ?? (await session.context.newPage());
      if (target) {
        try {
          await page.goto(target, {
            waitUntil: "domcontentloaded",
            timeout: 15_000,
          });
        } catch {
          throw new BrowserProblem(502, "BROWSER_NAVIGATION_FAILED");
        }
      }
      await page.bringToFront();
      return Response.json(await snapshot(), { headers });
    });
  }

  async function capture(id: string, kind: "screen" | "text") {
    if (capturing) throw new BrowserProblem(409, "BROWSER_READ_BUSY");
    const tab = browserTab(id);
    const { page, navigation } = tab;
    const url = page.url();
    if (!webUrl(url) && !(kind === "screen" && url === "about:blank")) {
      throw new BrowserProblem(403, "BROWSER_PAGE_NOT_READABLE");
    }
    capturing = true;
    try {
      if (kind === "text") {
        const text = await bounded(
          page.evaluate(visibleExcerpt, maxText),
          readTimeout,
        );
        requireCurrentRead(tab, navigation, url);
        return Response.json({ text: text.slice(0, maxText) }, { headers });
      }
      const screenshot = await page.screenshot({
        type: "png",
        fullPage: false,
        scale: "css",
        timeout: readTimeout,
      });
      requireCurrentRead(tab, navigation, url);
      if (screenshot.byteLength > 10 * 1024 * 1024) {
        throw new BrowserProblem(413, "BROWSER_SCREEN_TOO_LARGE");
      }
      return new Response(new Uint8Array(screenshot), {
        headers: { ...headers, "content-type": "image/png" },
      });
    } finally {
      capturing = false;
    }
  }

  function requireCurrentRead(tab: Tab, navigation: number, url: string) {
    if (
      browserTab(tab.id) !== tab ||
      tab.navigation !== navigation ||
      tab.page.url() !== url
    ) {
      throw new BrowserProblem(409, "BROWSER_PAGE_CHANGED");
    }
  }

  return {
    close,
    async handle(request: Request, pathname: string): Promise<Response | null> {
      const tab = tabPath.exec(pathname);
      const id = tab?.[1];
      const action = tab?.[2];
      const method = request.method;
      try {
        switch (pathname) {
          case basePath:
            return method === "GET"
              ? Response.json(await snapshot(), { headers })
              : problem(405, "METHOD_NOT_ALLOWED", "GET");
          case `${basePath}/open`:
            return method === "POST"
              ? await open(request)
              : problem(405, "METHOD_NOT_ALLOWED", "POST");
          case `${basePath}/close`:
            if (method !== "POST")
              return problem(405, "METHOD_NOT_ALLOWED", "POST");
            await close();
            return new Response(null, { status: 204, headers });
        }
        if (!id) return null;
        if (action === "screen" || action === "text") {
          return method === "GET"
            ? await capture(id, action)
            : problem(405, "METHOD_NOT_ALLOWED", "GET");
        }
        if (method !== "POST")
          return problem(405, "METHOD_NOT_ALLOWED", "POST");
        return await mutate(async () => {
          const { page } = browserTab(id);
          if (action === "focus") await page.bringToFront();
          else await page.close();
          return new Response(null, { status: 204, headers });
        });
      } catch (error) {
        if (error instanceof BrowserProblem)
          return problem(error.status, error.code);
        return problem(503, "BROWSER_UNAVAILABLE");
      }
    },
  };
}
