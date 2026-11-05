import test from "node:test";
import assert from "node:assert/strict";
import { createRefresh, connectLiveUI } from "../src/shared/live-ui.js";

test("event bursts coalesce and a manual refresh cannot overlap an earlier refresh", async () => {
  let release;
  let count = 0;
  let active = 0;
  const refresh = createRefresh(async () => {
    assert.equal(++active, 1);
    count++;
    if (count === 1) await new Promise((resolve) => { release = resolve; });
    active--;
  });
  const first = refresh();
  const second = refresh();
  assert.equal(first, second);
  refresh(); refresh(); release();
  await first;
  assert.equal(count, 2);
  await refresh();
  assert.equal(count, 3);
});

test("a failed refresh releases its queue for the next event", async () => {
  let calls = 0;
  const refresh = createRefresh(async () => { if (++calls === 1) throw new Error("fixture"); });
  await assert.rejects(refresh(), /fixture/);
  await refresh();
  assert.equal(calls, 2);
});

test("live subscription reconnects after worker restart and stops while hidden or closed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pageEvents = {};
  const documentEvents = {};
  globalThis.window = { addEventListener: (name, listener) => { pageEvents[name] = listener; } };
  globalThis.document = { hidden: false, addEventListener: (name, listener) => { documentEvents[name] = listener; } };
  const ports = [];
  globalThis.chrome = { runtime: { connect: () => {
    const events = {};
    const port = { events, onMessage: { addListener: (listener) => { events.message = listener; } },
      onDisconnect: { addListener: (listener) => { events.disconnect = listener; } },
      disconnect: () => events.disconnect() };
    ports.push(port);
    return port;
  } } };
  let refreshes = 0;
  connectLiveUI(async () => { refreshes++; }, (error) => { throw error; });
  ports[0].events.message({ type: "stateChanged" });
  assert.equal(refreshes, 1);
  ports[0].events.disconnect();
  t.mock.timers.tick(500);
  assert.equal(ports.length, 2);
  assert.equal(refreshes, 2);
  document.hidden = true;
  documentEvents.visibilitychange();
  t.mock.timers.tick(1000);
  assert.equal(ports.length, 2, "hidden pages must not reconnect in the background");
  document.hidden = false;
  documentEvents.visibilitychange();
  assert.equal(ports.length, 3);
  assert.equal(refreshes, 3);
  pageEvents.pagehide();
  t.mock.timers.tick(1000);
  assert.equal(ports.length, 3);
});
