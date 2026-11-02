import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const childBridge = await jiti.import("../src/child.ts", { default: true });
const { Controller } = await jiti.import("../src/controller.ts");
const { BridgeClient } = await jiti.import("../src/transport.ts");

async function workerFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "rex-test-"));
  const manifestFile = join(directory, "launch.json");
  const manifest = {
    version: 1, id: "worker", instance: "instance", sessionId: "session",
    directory, socketPath: join(directory, "worker.sock"),
    initialPrompt: join(directory, "assignment.md"),
  };
  writeFileSync(manifest.initialPrompt, "Parent assignment");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const previousManifest = process.env.PI_REX_WORKER;
  process.env.PI_REX_WORKER = manifestFile;
  const handlers = new Map();
  const entries = [];
  const sent = [];
  let idle = true;
  let client;
  const controller = new Controller("parent", undefined, () => {}, () => {});
  const worker = { reference: { id: manifest.id, directory }, manifest, connection: "connected" };
  const context = {
    mode: "tui",
    isIdle: () => idle,
    sessionManager: {
      getSessionId: () => manifest.sessionId,
      getLeafId: () => entries.at(-1)?.id ?? null,
      getSessionFile: () => join(directory, "session.jsonl"),
      getBranch: () => entries,
    },
    ui: { notify(message) { assert.fail(message); } },
    abort() {},
    shutdown() { assert.fail("Unexpected worker shutdown"); },
  };
  const emit = async (type, event = {}) => {
    for (const handler of handlers.get(type) ?? []) await handler(event, context);
  };
  const snapshot = () => {
    worker.state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
    return worker.state;
  };
  t.after(async () => {
    client?.close();
    try {
      await emit("session_shutdown", { reason: "exit" });
    } finally {
      controller.dispose();
      if (previousManifest === undefined) delete process.env.PI_REX_WORKER;
      else process.env.PI_REX_WORKER = previousManifest;
      rmSync(directory, { recursive: true, force: true });
    }
  });
  childBridge({
    on(type, handler) { handlers.set(type, [...(handlers.get(type) ?? []), handler]); },
    getThinkingLevel: () => "off",
    sendUserMessage(message) { sent.push(message); },
  });
  await emit("session_start");
  client = new BridgeClient(manifest.socketPath, (state) => { worker.state = state; }, () => {});
  await client.call("subscribe");
  return {
    snapshot, sent,
    prepare() { idle = false; },
    async begin() {
      idle = false;
      await emit("before_agent_start");
      await emit("agent_start");
    },
    async settle(text) {
      entries.push({
        id: `message-${entries.length}`, type: "message",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
      });
      idle = true;
      await emit("agent_settled", { aborted: false });
    },
    steer(message) { return client.call("steer", message); },
    result() { snapshot(); return controller.result(worker); },
    wait(signal) { snapshot(); return controller.wait(worker, signal); },
  };
}

test("private chats preserve the last parent result", async (t) => {
  const worker = await workerFixture(t);
  await worker.begin();
  await worker.settle("Parent result");
  assert.equal(worker.result().text, "Parent result");
  await worker.begin();
  await worker.settle("Private result");
  assert.equal(worker.snapshot().reportToParent, false);
  assert.equal(worker.snapshot().resultRevision, 2);
  assert.equal(worker.snapshot().parentResultRevision, 1);
  assert.equal(worker.result().text, "Parent result");
  assert.equal((await worker.wait()).text, "Parent result");
});

for (const timing of ["idle", "preparing", "running"]) {
  test(`parent steering while ${timing} reports the upcoming result`, async (t) => {
    const worker = await workerFixture(t);
    await worker.begin();
    await worker.settle("Previous parent result");
    if (timing === "preparing") worker.prepare();
    if (timing === "running") await worker.begin();

    const accepted = await worker.steer("Parent follow-up");
    assert.equal(accepted.run, 2);
    assert.equal(worker.snapshot().run, 2);
    assert.equal(worker.snapshot().reportToParent, true);
    assert.equal(worker.sent.at(-1), "Parent follow-up");
    // A waiter must target the reserved run as soon as steering is accepted.
    const waiting = worker.wait(AbortSignal.timeout(5_000));
    if (timing !== "running") await worker.begin();
    assert.equal(worker.snapshot().run, 2);
    assert.equal(worker.snapshot().reportToParent, true);
    await worker.settle("New parent result");
    assert.equal(worker.snapshot().parentResultRevision, 2);
    assert.equal(worker.result().text, "New parent result");
    assert.equal((await waiting).text, "New parent result");

    await worker.begin();
    await worker.settle("Later private result");
    assert.equal(worker.snapshot().reportToParent, false);
    assert.equal(worker.result().text, "New parent result");
  });
}
