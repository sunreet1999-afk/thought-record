// Offline tests for the "ai" function: auth, input checks, validation, retry, and that nothing is logged.
// Run: deno test --allow-env --allow-net=registry.npmjs.org supabase/tests/ai_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.13";

Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
Deno.env.set("SUPABASE_ANON_KEY", "anon");
Deno.env.set("ANTHROPIC_API_KEY", "test-key");
Deno.env.set("ALLOWED_USER_ID", "me-123");

const { handle } = await import("../functions/ai/handler.ts");

type Reply = { text?: string; stop?: string; status?: number };
let modelReplies: Reply[] = [];
let modelCalls: Record<string, unknown>[] = [];
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/auth/v1/user")) {
    const auth = new Headers(init?.headers).get("authorization");
    if (auth === "Bearer good") return Response.json({ id: "me-123" });
    if (auth === "Bearer other") return Response.json({ id: "someone-else" });
    return new Response("{}", { status: 401 });
  }
  if (url.includes("/v1/messages")) {
    modelCalls.push(JSON.parse(String(init?.body ?? (input as Request).body)));
    const r = modelReplies.shift() ?? { text: "{}" };
    if (r.status) return Response.json({ type: "error", error: { type: "api_error", message: "x" } }, { status: r.status });
    return Response.json({
      id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5",
      content: [{ type: "text", text: r.text ?? "" }], stop_reason: r.stop ?? "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
  return realFetch(input, init);
}) as typeof fetch;

const call = (body: unknown, token = "good", method = "POST") =>
  handle(new Request("https://fn.local/ai", {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: "https://sunreet1999-afk.github.io" },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  }));

const ENTRY = "Kal mock test hai, pakka fail ho jaunga. Sab hasenge.";
const reset = () => { modelReplies = []; modelCalls = []; };

Deno.test("no token is 401, other user is 403, preflight is 204", async () => {
  reset();
  assertEquals((await handle(new Request("https://fn.local/ai", { method: "POST", body: "{}" }))).status, 401);
  assertEquals((await call({ mode: "tag", text: ENTRY }, "other")).status, 403);
  const pre = await handle(new Request("https://fn.local/ai", { method: "OPTIONS", headers: { origin: "https://sunreet1999-afk.github.io" } }));
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get("access-control-allow-origin"), "https://sunreet1999-afk.github.io");
  assertEquals(modelCalls.length, 0);
});

Deno.test("tag: valid reply passes, sends only this entry, uses the right model", async () => {
  reset();
  modelReplies = [{ text: JSON.stringify({ emotions: ["anxiety", "fear"], intensity: 4, distortions: ["fortune telling"], crisis: false }) }];
  const res = await call({ mode: "tag", text: ENTRY });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { emotions: ["anxiety", "fear"], intensity: 4, distortions: ["fortune telling"], crisis: false });
  assertEquals(modelCalls[0].model, "claude-haiku-5-5");
  const sent = JSON.stringify(modelCalls[0].messages);
  assert(sent.includes("mock test"));
});

Deno.test("tag: bad JSON is retried once, then 502", async () => {
  reset();
  modelReplies = [{ text: "not json" }, { text: JSON.stringify({ emotions: ["anger"], intensity: 2, distortions: [], crisis: false }) }];
  assertEquals((await call({ mode: "tag", text: ENTRY })).status, 200);
  assertEquals(modelCalls.length, 2);
  reset();
  modelReplies = [{ text: "nope" }, { text: JSON.stringify({ emotions: ["made-up"], intensity: 9, distortions: [], crisis: false }) }];
  const res = await call({ mode: "tag", text: ENTRY });
  assertEquals(res.status, 502);
  assertEquals((await res.json()).error, "bad_model_output");
});

Deno.test("tag: labels outside the list are dropped, max 3 emotions", async () => {
  reset();
  modelReplies = [{ text: JSON.stringify({ emotions: ["anxiety", "stress", "fear", "sadness", "guilt"], intensity: 3, distortions: ["doom", "labeling"], crisis: true }) }];
  const body = await (await call({ mode: "tag", text: ENTRY })).json();
  assertEquals(body, { emotions: ["anxiety", "fear", "sadness"], intensity: 3, distortions: ["labeling"], crisis: true });
});

Deno.test("refusal becomes 422", async () => {
  reset();
  modelReplies = [{ text: "", stop: "refusal" }];
  assertEquals((await call({ mode: "tag", text: ENTRY })).status, 422);
});

Deno.test("questions need tags and return 2-3 questions", async () => {
  reset();
  assertEquals((await call({ mode: "questions", text: ENTRY })).status, 400);
  modelReplies = [{ text: JSON.stringify({ distortion_note: "Fortune telling lag raha hai.", questions: ["Kya saboot hai?", "Dost ko kya bolte?"] }) }];
  const res = await call({ mode: "questions", text: ENTRY, tags: { emotions: ["anxiety"], intensity: 4, distortions: ["fortune telling"] } });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).questions.length, 2);
  assert(JSON.stringify(modelCalls[0].messages).includes("fortune telling"));
});

Deno.test("view needs an alternative thought; chat must end on a user turn", async () => {
  reset();
  assertEquals((await call({ mode: "view", text: ENTRY })).status, 400);
  modelReplies = [{ text: "Ek aur nazariya." }];
  const v = await call({ mode: "view", text: ENTRY, alt: "Ek test se sab tay nahi hota", qa: [{ q: "Saboot?", a: "Pichhli baar pass hua" }] });
  assertEquals((await v.json()).text, "Ek aur nazariya.");
  assertEquals((await call({ mode: "chat", text: ENTRY, messages: [{ role: "assistant", content: "hi" }] })).status, 400);
  modelReplies = [{ text: "Kaunsa option theek lagta hai?" }];
  const c = await call({ mode: "chat", text: ENTRY, messages: [{ role: "user", content: "Mujhe ek suggestion do" }] });
  assertEquals(c.status, 200);
});

Deno.test("input limits and unknown mode", async () => {
  reset();
  assertEquals((await call({ mode: "tag", text: "x".repeat(8001) })).status, 413);
  assertEquals((await call({ mode: "tag", text: "" })).status, 400);
  assertEquals((await call({ mode: "poem", text: ENTRY })).status, 400);
  assertEquals(modelCalls.length, 0);
});

Deno.test("upstream 5xx becomes 502 and logs carry no entry text", async () => {
  reset();
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    modelReplies = [{ status: 500 }, { status: 500 }];
    const res = await call({ mode: "tag", text: ENTRY });
    assertEquals(res.status, 502);
    modelReplies = [{ text: JSON.stringify({ emotions: ["anxiety"], intensity: 2, distortions: [], crisis: false }) }];
    await call({ mode: "tag", text: ENTRY });
  } finally { console.log = orig; }
  assert(logs.length >= 2);
  for (const l of logs) assert(!l.includes("mock test") && !l.includes("anxiety"), "log leaked content: " + l);
});
