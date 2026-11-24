// The "ai" Edge Function: one endpoint, four modes (tag, questions, view, chat).
// Rules: only the allowed Supabase user may call it; request and response bodies are never logged;
// only the current entry is sent to the model; every model reply is validated before it is returned.
import Anthropic from "npm:@anthropic-ai/sdk@1.7.0";
import {
  CHAT_SYSTEM, DISTORTIONS, EMOTIONS, QUESTIONS_SCHEMA, QUESTIONS_SYSTEM, RETRY_NOTE, TAG_SCHEMA, TAG_SYSTEM,
  VIEW_SYSTEM, entryBlock, sessionContext, tagsLine, type QA, type Tags,
} from "./prompts.ts";

export const MODEL = "claude-haiku-5-5";
const ALLOWED_ORIGINS = ["https://sunreet1999-afk.github.io"];
const MAX_BODY = 64 * 1024;
const MAX_TEXT = 8000;

class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

// ---------- auth ----------
function apiKeyForAuth(): string {
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (anon) return anon;
  try { return JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") ?? "{}").default ?? ""; } catch { return ""; }
}

// Asks Supabase Auth who the token belongs to. Works with both legacy and new signing keys.
async function userIdFrom(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(auth)) return null;
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) throw new HttpError(500, "not_configured");
  const res = await fetch(`${url}/auth/v1/user`, { headers: { authorization: auth, apikey: apiKeyForAuth() } });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  return typeof user?.id === "string" ? user.id : null;
}

// ---------- input checks ----------
const str = (v: unknown, max: number, field: string, required = false): string => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `missing_${field}`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `bad_${field}`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(413, `${field}_too_long`);
  if (required && !s) throw new HttpError(400, `missing_${field}`);
  return s;
};

function cleanTags(v: unknown): Tags | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const pick = (arr: unknown, list: readonly string[]) =>
    Array.isArray(arr) ? [...new Set(arr.map((x) => String(x).toLowerCase().trim()).filter((x) => list.includes(x)))] : [];
  const intensity = Number(o.intensity);
  return {
    emotions: pick(o.emotions, EMOTIONS).slice(0, 3),
    intensity: Number.isInteger(intensity) && intensity >= 1 && intensity <= 5 ? intensity : 3,
    distortions: pick(o.distortions, DISTORTIONS),
  };
}

function cleanQA(v: unknown): QA[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 3) throw new HttpError(400, "bad_qa");
  return v.map((x) => ({ q: str(x?.q, 500, "qa", true), a: str(x?.a, 2000, "qa") }));
}

function cleanMessages(v: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(v) || !v.length || v.length > 12) throw new HttpError(400, "bad_messages");
  const out = v.map((m) => {
    const role = m?.role;
    if (role !== "user" && role !== "assistant") throw new HttpError(400, "bad_messages");
    return { role, content: str(m?.content, 2000, "messages", true) } as { role: "user" | "assistant"; content: string };
  });
  if (out[out.length - 1].role !== "user") throw new HttpError(400, "bad_messages");
  return out;
}

// ---------- model output checks ----------
export function validateTag(o: unknown) {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (!Array.isArray(r.emotions) || !Array.isArray(r.distortions) || typeof r.crisis !== "boolean") return null;
  const t = cleanTags(r);
  if (!t || !t.emotions.length || r.intensity !== t.intensity) return null;
  return { ...t, crisis: r.crisis };
}

export function validateQuestions(o: unknown) {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  if (!Array.isArray(r.questions) || typeof r.distortion_note !== "string") return null;
  const questions = r.questions.map((q) => String(q).trim()).filter(Boolean).slice(0, 3);
  if (questions.length < 2) return null;
  return { distortion_note: r.distortion_note.trim(), questions };
}

// ---------- model calls ----------
let client: Anthropic | null = null;
function anthropic(): Anthropic {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new HttpError(500, "not_configured");
  return client ??= new Anthropic({ apiKey, maxRetries: 1, timeout: 45_000 });
}

function textOf(msg: Anthropic.Message): string {
  if (msg.stop_reason === "refusal") throw new HttpError(422, "refused");
  return msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
}

// Structured output, validated in code; one retry if the reply is unusable.
async function askJSON<T>(system: string, user: string, schema: Record<string, unknown>, validate: (o: unknown) => T | null): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const msg = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: user + (attempt ? RETRY_NOTE : "") }],
      output_config: { effort: "low", format: { type: "json_schema", schema } },
    });
    let parsed: unknown = null;
    try { parsed = JSON.parse(textOf(msg)); } catch (e) { if (e instanceof HttpError) throw e; }
    const v = validate(parsed);
    if (v) return v;
  }
  throw new HttpError(502, "bad_model_output");
}

async function askText(system: string, messages: Anthropic.MessageParam[]): Promise<string> {
  const msg = await anthropic().messages.create({
    model: MODEL, max_tokens: 2000, system, messages, output_config: { effort: "low" },
  });
  const text = textOf(msg);
  if (!text) throw new HttpError(502, "bad_model_output");
  return text;
}

// ---------- modes ----------
async function run(body: Record<string, unknown>) {
  const mode = body.mode;
  const text = str(body.text, MAX_TEXT, "text", true);
  if (mode === "tag") {
    return await askJSON(TAG_SYSTEM, entryBlock(text), TAG_SCHEMA, validateTag);
  }
  const tags = cleanTags(body.tags);
  if (mode === "questions") {
    if (!tags) throw new HttpError(400, "missing_tags");
    return await askJSON(QUESTIONS_SYSTEM, `${entryBlock(text)}\n${tagsLine(tags)}`, QUESTIONS_SCHEMA, validateQuestions);
  }
  const qa = cleanQA(body.qa);
  const alt = str(body.alt, 2000, "alt");
  if (mode === "view") {
    if (!alt) throw new HttpError(400, "missing_alt");
    return { text: await askText(VIEW_SYSTEM, [{ role: "user", content: sessionContext(text, tags, qa, alt, "") }]) };
  }
  if (mode === "chat") {
    const view = str(body.view, 2000, "view");
    const turns = cleanMessages(body.messages);
    return {
      text: await askText(CHAT_SYSTEM, [
        { role: "user", content: sessionContext(text, tags, qa, alt, view) },
        { role: "assistant", content: "Theek hai, maine sab padh liya." },
        ...turns,
      ]),
    };
  }
  throw new HttpError(400, "bad_mode");
}

// ---------- entry point ----------
function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export async function handle(req: Request): Promise<Response> {
  const headers = { ...corsHeaders(req.headers.get("origin") ?? ""), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const started = Date.now();
  let mode = "-", status = 500, body: unknown;
  try {
    const uid = await userIdFrom(req);
    const allowed = Deno.env.get("ALLOWED_USER_ID");
    if (!allowed) throw new HttpError(500, "not_configured");
    if (!uid) throw new HttpError(401, "unauthorized");
    if (uid !== allowed) throw new HttpError(403, "forbidden");
    if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
    const raw = await req.text();
    if (raw.length > MAX_BODY) throw new HttpError(413, "too_large");
    let input: unknown;
    try { input = JSON.parse(raw); } catch { throw new HttpError(400, "bad_json"); }
    if (!input || typeof input !== "object") throw new HttpError(400, "bad_json");
    mode = String((input as Record<string, unknown>).mode).slice(0, 12);
    body = await run(input as Record<string, unknown>);
    status = 200;
  } catch (e) {
    if (e instanceof HttpError) { status = e.status; body = { error: e.code }; }
    else if (e instanceof Anthropic.RateLimitError) { status = 429; body = { error: "rate_limited" }; }
    else if (e instanceof Anthropic.APIError) { status = 502; body = { error: "upstream", retryable: (e.status ?? 500) >= 500 }; }
    else { status = 500; body = { error: "internal" }; }
  }
  // Metadata only: never the entry, tags, questions or model output.
  console.log(JSON.stringify({ mode, status, ms: Date.now() - started }));
  return new Response(JSON.stringify(body), { status, headers });
}
