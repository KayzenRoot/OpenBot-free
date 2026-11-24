import { expect, test } from "bun:test";
import { createBrowserRecorder } from "./browser-recorder";
import { createLocalLearning } from "./learning";
import { localSkillProposer } from "./learning-proposer";
import { createLearningRoutes } from "./learning-routes";

const BASE = "http://127.0.0.1/api/local/learning";

function post(path: string, body: unknown, key: string) {
  return new Request(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

test("imports minimized recording events and publishes a local draft after review", async () => {
  const learning = createLocalLearning({
    dbPath: ":memory:",
    propose: localSkillProposer(undefined),
  });
  const handle = createLearningRoutes(learning, createBrowserRecorder());
  try {
    const imported = await handle(
      post(
        "/recordings",
        {
          events: [
            {
              type: "CUSTOM",
              name: "click",
              timestamp: Date.now(),
              value: {
                seq: 1,
                target: { tag: "button", name: "private-button-name" },
              },
            },
          ],
        },
        "recording-import-test-key",
      ),
    );
    expect(imported?.status).toBe(201);
    const { evidence } = await imported!.json();
    expect(evidence.text).toContain("Activated a button.");
    expect(evidence.text).not.toContain("private-button-name");

    const generated = await handle(
      post(
        "/proposals",
        { evidenceIds: [evidence.id] },
        "local-proposal-test-key",
      ),
    );
    expect(generated?.status).toBe(201);
    const { proposal } = await generated!.json();
    expect(proposal.status).toBe("pending");
    expect(proposal.markdown).toContain("Activated a button.");
    expect(learning.publishedSkills()).toHaveLength(0);

    const editBody = {
      title: "Edited skill",
      markdown: "# Edited steps\n\nReview the preview before continuing.",
      previousTitle: proposal.title,
      previousMarkdown: proposal.markdown,
    };
    const edit = (body: object) =>
      handle(
        new Request(`${BASE}/proposals/${proposal.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    expect((await edit(editBody))?.status).toBe(200);
    expect((await edit(editBody))?.status).toBe(200);
    expect((await edit({ ...editBody, title: "Stale edit" }))?.status).toBe(
      409,
    );

    const approved = await handle(
      post(
        `/proposals/${proposal.id}/approve`,
        {},
        "approve-local-skill-test-key",
      ),
    );
    expect(approved?.ok).toBe(true);
    expect(learning.publishedSkills()[0]?.slug).toBe(proposal.slug);
    expect(learning.publishedSkills()[0]?.markdown).toContain(
      "Review the preview",
    );
    expect((await edit(editBody))?.status).toBe(409);
  } finally {
    learning.close();
  }
});

test("drafts unprocessed recordings locally once and keeps manual notes out of the schedule", async () => {
  let remoteCalls = 0;
  const learning = createLocalLearning({
    dbPath: ":memory:",
    propose: async () => {
      remoteCalls += 1;
      throw new Error("Scheduled recording drafts are local");
    },
  });
  const handle = createLearningRoutes(learning, createBrowserRecorder());
  try {
    const recording = await handle(
      post(
        "/evidence",
        { source: "recording", text: "Opened a tab and reviewed its title." },
        "recorded-evidence",
      ),
    );
    const manual = await handle(
      post(
        "/evidence",
        { source: "manual", text: "Private note for manual review" },
        "manual-evidence",
      ),
    );
    expect(recording?.status).toBe(201);
    expect(manual?.status).toBe(201);
    const { evidence } = await recording!.json();
    const local = localSkillProposer(undefined);
    expect(
      await Promise.all([
        learning.draftNextRecording(local),
        learning.draftNextRecording(local),
      ]),
    ).toEqual([true, false]);
    const list = await handle(new Request(`${BASE}/proposals`));
    expect(await list?.json()).toMatchObject({
      proposals: [{ evidenceIds: [evidence.id], status: "pending" }],
    });
    expect(learning.publishedSkills()).toHaveLength(0);
    expect(await learning.draftNextRecording(local)).toBe(false);
    expect(remoteCalls).toBe(0);
  } finally {
    learning.close();
  }
});

test.skipIf(process.env.OPENBOT_TEST_EDGE !== "1")(
  "records a real Edge navigation and stores metadata only",
  async () => {
    const page = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          '<form><input type="password" value="private-page-fixture"><button>Test</button></form>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    const learning = createLocalLearning({
      dbPath: ":memory:",
      propose: localSkillProposer(undefined),
    });
    const recorder = createBrowserRecorder({
      headless: true,
      initialUrl: new URL("/private-url-fixture", page.url).href,
    });
    const handle = createLearningRoutes(learning, recorder);
    try {
      const started = await handle(
        post("/recording/start", {}, "recording-start-test-key"),
      );
      expect(started?.status).toBe(201);
      const { recording } = await started!.json();
      expect(recording).toMatchObject({ active: true, events: 1 });
      const stopped = await handle(
        post("/recording/stop", {}, "recording-stop-test-key"),
      );
      expect(stopped?.status).toBe(201);
      const { evidence, proposal } = await stopped!.json();
      expect(evidence.text).toContain("Navigated to another browser page.");
      expect(evidence.text).not.toContain("private-");
      expect(proposal.status).toBe("pending");
      expect(proposal.evidenceIds).toEqual([evidence.id]);
      expect(recorder.status()).toBeNull();
      const replay = await handle(
        post("/recording/stop", {}, "recording-stop-test-key"),
      );
      expect(await replay?.json()).toEqual({ evidence, proposal });
    } finally {
      if (recorder.status()) await recorder.stop();
      await page.stop(true);
      learning.close();
    }
  },
  35_000,
);
