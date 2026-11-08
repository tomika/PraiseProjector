import assert from "node:assert/strict";
import { test } from "node:test";
import { PpdControlHost, type PpdHighlightUpdate, type PpdPeer, type PpdWireMessage } from "../ppd-control";

const peer: PpdPeer = { deviceId: "viewer", address: "192.0.2.1", transport: "udp" };

function host(allowed = true) {
  const highlights: PpdHighlightUpdate[] = [];
  const control = new PpdControlHost(
    {
      getHostId: () => "host",
      isLeaderAllowed: () => allowed,
      requestHighlightAccess: () => false,
      applyDisplayUpdate: () => undefined,
      applyHighlight: (_peer, update) => {
        highlights.push(update);
      },
      getSongData: () => undefined,
    },
    () => "control-token"
  );
  const token = control.sessionMessage(peer).token;
  return {
    highlights,
    send: async (highlight: unknown) => {
      let result: PpdWireMessage | undefined;
      await control.handle(
        { op: "command", version: 2, requestId: `request-${highlights.length}`, token, command: "highlight", highlight } as PpdWireMessage,
        peer,
        (message) => {
          result = message;
        }
      );
      return result;
    },
  };
}

test("PPD keeps a valid source highlight when its optional ABC range is absent, null or malformed", async () => {
  for (const abcRange of [undefined, null, "null", {}, { source: 5, from: 2, to: 2 }, { source: -1, from: 0, to: 1 }, "broken"]) {
    const runtime = host();
    const response = await runtime.send({ from: 5, to: 6, section: 2, abcRange });
    assert.equal(response?.status, "ok", JSON.stringify(abcRange));
    assert.deepEqual(runtime.highlights, [{ from: 5, to: 6, section: 2, abcRange: undefined }]);
  }
});

test("PPD normalizes a valid ABC range object or JSON string before applying the highlight", async () => {
  const range = { source: 5, from: 2, to: 4 };
  for (const abcRange of [range, JSON.stringify(range)]) {
    const runtime = host();
    assert.equal((await runtime.send({ from: 5, to: 6, abcRange }))?.status, "ok");
    assert.deepEqual(runtime.highlights, [{ from: 5, to: 6, abcRange: range }]);
  }
});

test("PPD optional-range recovery still requires valid source coordinates and authorization", async () => {
  const invalid = host();
  assert.equal((await invalid.send({ from: "5", to: 6, abcRange: null }))?.status, "invalid");
  assert.deepEqual(invalid.highlights, []);
  const denied = host(false);
  assert.equal((await denied.send({ from: 5, to: 6, abcRange: null }))?.status, "denied");
  assert.deepEqual(denied.highlights, []);
});
