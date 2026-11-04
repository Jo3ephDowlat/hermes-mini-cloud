import test from "node:test";
import assert from "node:assert/strict";
import { transcribeTelegramVoice } from "../src/index.ts";

const env = {
  TELEGRAM_BOT_TOKEN: "mock-telegram-token",
  LLM_API_KEY: "mock-workers-ai-token",
  LLM_API_URL: "https://api.cloudflare.com/client/v4/accounts/test-account/ai/v1/chat/completions",
} as never;

function mockFetch(t: { after(fn: () => void): void }, handler: typeof fetch): void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
}

test("downloads Telegram voice and returns the Whisper transcription", async (t) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  mockFetch(t, (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.includes("/getFile?")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/file.oga", file_size: 3 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/file/botmock-telegram-token/")) {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    if (url.endsWith("/ai/run/@cf/openai/whisper")) {
      return new Response(JSON.stringify({ success: true, result: { text: "سلام، حالت چطوره؟" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected URL", { status: 500 });
  }) as typeof fetch);

  const text = await transcribeTelegramVoice(env, {
    file_id: "telegram-file-id",
    duration: 12,
    mime_type: "audio/ogg",
    file_size: 3,
  });

  assert.equal(text, "سلام، حالت چطوره؟");
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /getFile\?file_id=telegram-file-id$/);
  assert.match(calls[1].url, /file\/botmock-telegram-token\/voice\/file\.oga$/);
  assert.ok(calls[2].url.endsWith("/ai/run/@cf/openai/whisper"));
  assert.equal(calls[2].init?.headers && new Headers(calls[2].init.headers).get("Authorization"), "Bearer mock-workers-ai-token");
  assert.equal(calls[2].init?.headers && new Headers(calls[2].init.headers).get("Content-Type"), "application/octet-stream");
  assert.ok(calls[2].init?.body instanceof ArrayBuffer);
});

test("rejects voice messages longer than 60 seconds without network calls", async (t) => {
  let calls = 0;
  mockFetch(t, (async () => {
    calls++;
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch);

  await assert.rejects(
    transcribeTelegramVoice(env, { file_id: "file", duration: 61 }),
    /Unsupported Telegram voice duration/
  );
  assert.equal(calls, 0);
});

test("rejects files over Telegram's 20 MB download limit without network calls", async (t) => {
  let calls = 0;
  mockFetch(t, (async () => {
    calls++;
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch);

  await assert.rejects(
    transcribeTelegramVoice(env, { file_id: "file", duration: 10, file_size: 20 * 1024 * 1024 + 1 }),
    /exceeds the download limit/
  );
  assert.equal(calls, 0);
});

test("rejects empty Whisper transcriptions", async (t) => {
  mockFetch(t, (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/getFile?")) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: "voice/file.oga", file_size: 2 } }), { status: 200 });
    }
    if (url.includes("/file/botmock-telegram-token/")) {
      return new Response(new Uint8Array([1, 2]), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, result: { text: "   " } }), { status: 200 });
  }) as typeof fetch);

  await assert.rejects(
    transcribeTelegramVoice(env, { file_id: "file", duration: 10 }),
    /empty transcription/
  );
});
