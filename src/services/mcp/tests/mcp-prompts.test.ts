/** The import prompts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonRpcResponse } from "../../../../common/mcp-bridge";
import { createMcpPrompts } from "../prompts";
import { createMcpDispatcher } from "../protocol";
import { fakeHost, fakeState } from "./fakeHost";

test("the two import prompts are offered in the UI language and carry the app's chord system", async () => {
  const state = fakeState();
  const handle = createMcpDispatcher({
    tools: [],
    resources: [],
    prompts: createMcpPrompts(),
    host: fakeHost(state),
    permissions: () => ({ allowChanges: false, allowLiveControl: false, confirmChanges: true }),
  });
  const request = async (method: string, params?: Record<string, unknown>) =>
    (await handle({ jsonrpc: "2.0", id: 1, method, params })) as JsonRpcResponse;

  const list = (await request("prompts/list")).result as {
    prompts: { name: string; title: string; arguments: { name: string; required: boolean }[] }[];
  };
  assert.deepEqual(
    list.prompts.map((prompt) => prompt.name),
    ["import_song_from_picture", "import_song_from_recording"]
  );
  assert.equal(list.prompts[0].title, "Import a song from a picture");
  assert.deepEqual(
    list.prompts[1].arguments.map((argument) => [argument.name, argument.required]),
    [
      ["source", true],
      ["title", false],
    ]
  );

  const text = async (name: string, args?: Record<string, unknown>) => {
    const result = (await request("prompts/get", { name, arguments: args })).result as {
      messages: { role: string; content: { type: string; text: string } }[];
    };
    assert.equal(result.messages[0].role, "user");
    return result.messages[0].content.text;
  };
  const picture = await text("import_song_from_picture", { notes: "két dal van rajta" });
  assert.ok(picture.includes("Notes from the user: két dal van rajta"));
  assert.ok(picture.includes("chord system is G (German/Hungarian"));
  assert.ok(picture.indexOf("validate_chordpro") < picture.indexOf("Call import_song"));
  assert.ok(!(await text("import_song_from_picture")).includes("Notes from the user"));
  assert.ok(!(await text("import_song_from_picture")).includes("\n\n\n"));

  state.settings.defaultChordSystem = "S";
  const recording = await text("import_song_from_recording", { source: "https://youtu.be/abc" });
  assert.ok(recording.includes("from this recording: https://youtu.be/abc"));
  assert.ok(recording.includes("Do not download or copy the audio or video"));
  assert.ok(recording.includes("do not invent lyrics or chords"));
  assert.ok(recording.includes("chord system S (standard"));

  assert.equal((await request("prompts/get", { name: "import_song_from_recording" })).error?.code, -32602);
  assert.equal((await request("prompts/get", { name: "nope" })).error?.code, -32602);
});
