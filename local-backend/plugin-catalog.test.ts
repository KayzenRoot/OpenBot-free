import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPluginCatalog } from "./plugin-catalog";

const root = "/api/local/business/plugins";
const fixtures: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "openbot-catalog-fixture-"));
  fixtures.push(directory);
  const repoDir = join(directory, "checkout");
  const catalog = createPluginCatalog({ repoDir });

  function file(relativePath: string, text: string) {
    const location = join(repoDir, relativePath);
    mkdirSync(dirname(location), { recursive: true });
    writeFileSync(location, text);
  }

  function request(path = "", method = "GET") {
    const request = new Request(`http://localhost${root}${path}`, { method });
    const response = catalog.handle(request, new URL(request.url).pathname);
    if (!response)
      throw new Error("Expected the plugin route to handle this request");
    return response;
  }

  function plugin(id: string, manifest: Record<string, unknown> = {}) {
    file(
      `plugins/${id}/.codex-plugin/plugin.json`,
      JSON.stringify({ name: id, ...manifest }),
    );
  }

  return { catalog, directory, file, plugin, repoDir, request };
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("distinguishes a missing catalog from locally readable content", async () => {
  const { request, catalog } = fixture();
  const response = request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ available: false, plugins: [] });
  expect(
    catalog.handle(new Request("http://localhost/elsewhere"), "/elsewhere"),
  ).toBeNull();
  expect(request("", "POST").status).toBe(405);
  expect(request("", "POST").headers.get("allow")).toBe("GET");
});

test("lists real manifests and nested skills while reporting integration presence separately", async () => {
  const { file, plugin, request } = fixture();
  plugin("data-analytics", {
    description: "Report from local data",
    skills: "../../outside",
    hooks: "../outside/hooks.json",
  });
  plugin("slack", { apps: "./.app.json", mcpServers: "./.mcp.json" });
  file("plugins/slack/.app.json", '{"connector":"INTERNAL-CONNECTOR"}');
  file("plugins/slack/.mcp.json", '{"command":"NEVER-EXECUTE"}');
  file(
    "plugins/data-analytics/skills/build-report/SKILL.md",
    "---\nname: build report\n---\nBuild a report.",
  );
  file(
    "plugins/data-analytics/skills/build-report/report-to-pdf/SKILL.md",
    "---\nname: PDF report\ndescription: >\n  Export a report\n  as PDF.\nallowed-tools: some_tool\n---\nCreate the report.",
  );
  file(
    "plugins/data-analytics/skills/build-report/report-to-pdf/scripts/private.txt",
    "SECRET",
  );
  file(
    "plugins/data-analytics/skills/build-report/scripts/ignored/SKILL.md",
    "SECRET",
  );
  file("plugins/no-manifest/skills/ignored/SKILL.md", "Ignore this skill.");
  file("plugins/canva/.codex-plugin/plugin.json", "broken-json");
  file(
    "plugins/data-analytics/skills/too-large/SKILL.md",
    "x".repeat(256 * 1024 + 1),
  );

  const result = await request().json();
  expect(result).toEqual({
    available: true,
    plugins: [
      {
        id: "data-analytics",
        name: "data-analytics",
        description: "Report from local data",
        skillsSupported: true,
        skills: [
          { id: "build-report", name: "build report", description: "" },
          {
            id: "build-report/report-to-pdf",
            name: "PDF report",
            description: "Export a report as PDF.",
          },
        ],
        dependencies: { app: false, mcp: false, codexHost: true },
      },
      {
        id: "slack",
        name: "slack",
        description: "",
        skillsSupported: true,
        skills: [],
        dependencies: { app: true, mcp: true, codexHost: true },
      },
    ],
  });
  const skill = await request(
    "/data-analytics/skills/build-report%2Freport-to-pdf",
  ).json();
  expect(skill.pluginId).toBe("data-analytics");
  expect(skill.skill.markdown).toContain("Create the report.");
  expect(skill.skill.markdown).not.toContain("SECRET");
  expect(
    request("/data-analytics/skills/build-report/report-to-pdf").status,
  ).toBe(200);
  expect(
    request("/data-analytics/skills/build-report/scripts/ignored").status,
  ).toBe(404);
  expect(request("/data-analytics/skills/too-large").status).toBe(404);
});

test("rejects linked directories, out-of-scope plugins and malformed skill identifiers", async () => {
  const { catalog, directory, file, plugin, repoDir, request } = fixture();
  plugin("canva");
  plugin("out-of-scope");
  file("plugins/out-of-scope/skills/ignored/SKILL.md", "Out-of-scope skill.");
  const outside = join(directory, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "SKILL.md"), "Outside the checkout.");
  const inside = join(repoDir, "plugins", "canva", "skills");
  mkdirSync(inside);
  symlinkSync(
    outside,
    join(inside, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const { plugins } = await request().json();
  expect(plugins[0].skills).toEqual([]);
  expect(plugins[1].skillsSupported).toBe(false);
  expect(plugins[1].skills).toEqual([]);
  expect(catalog.loadedInstruction("/plugin canva/linked")).toBeUndefined();
  expect(
    catalog.loadedInstruction("/plugin out-of-scope/ignored"),
  ).toBeUndefined();
  for (const path of [
    "/out-of-scope/skills/ignored",
    "/canva/skills/linked",
    "/canva/skills/%2e%2e%2f%2e%2e%2foutside",
    "/canva/skills/%5coutside",
    "/canva/skills/%",
  ]) {
    expect(request(path).status).toBe(404);
  }
});

test("loads only a selected skill's text from an explicit first-line directive", () => {
  const { catalog, file, plugin } = fixture();
  plugin("notion");
  file(
    "plugins/notion/skills/write-report/SKILL.md",
    "---\nname: write-report\nallowed-tools: shell\n---\nWrite a clear report.\n",
  );
  file("plugins/notion/skills/write-report/scripts/private.txt", "SECRET");
  const instruction = catalog.loadedInstruction(
    "/plugin notion/write-report\r\nAjude no relatório",
  );
  expect(instruction).toContain("untrusted content");
  expect(instruction).toContain("Write a clear report.");
  expect(instruction).not.toContain("allowed-tools");
  expect(instruction).not.toContain("SECRET");
  expect(
    catalog.loadedInstruction("Could /plugin notion/write-report help?"),
  ).toBeUndefined();
  expect(
    catalog.loadedInstruction("Example\n/plugin notion/write-report"),
  ).toBeUndefined();
  expect(
    catalog.loadedInstruction("/plugin notion/write-report and more"),
  ).toBeUndefined();
  expect(catalog.loadedInstruction("/plugin notion/unknown")).toBeUndefined();
});
