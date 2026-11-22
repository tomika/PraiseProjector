import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { CloudApiService } from "../cloudApi";
import { getEmptyDisplay } from "../pp-utils";

function recordBodies(context: TestContext): Record<string, string>[] {
  const bodies: Record<string, string>[] = [];
  context.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, string>);
    return new Response("DONE");
  });
  return bodies;
}

const SONG = { ...getEmptyDisplay(), songId: "song", transpose: 0, capo: 2, instructions: "" };

test("a normal display update leaves transpose 0, capo and empty instructions to the server", async (context) => {
  const bodies = recordBodies(context);
  await new CloudApiService().sendDisplayUpdate(SONG);
  assert.equal("transpose" in bodies[0], false);
  assert.equal("capo" in bodies[0], false);
  assert.equal("instructions" in bodies[0], false);
  assert.equal("sectionRepeatCounts" in bodies[0], false);
});

test("a complete display update sends transpose 0, capo and empty instructions too", async (context) => {
  const bodies = recordBodies(context);
  await new CloudApiService().sendDisplayUpdate(SONG, { complete: true });
  assert.equal(bodies[0].transpose, "0");
  assert.equal(bodies[0].capo, "2");
  assert.equal(bodies[0].instructions, "");
  assert.equal(bodies[0].sectionRepeatCounts, "[]", "the server keeps missing repeats, even across a song change");
  assert.equal(bodies[0].ppu, "true", "a complete update still never writes the profile's preferences");
});
