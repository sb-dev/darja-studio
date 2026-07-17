import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import { config } from "./config.js";

let client: OpenAI | undefined;

export function getOpenAI(): OpenAI {
  client ??= new OpenAI({
    timeout: config.openAITimeoutMs,
    // Task retries are handled by the runner so every retry is visible and persisted.
    maxRetries: 0,
    // `timeout` above only arms the SDK's own AbortController. The fetch underneath
    // enforces its own headersTimeout (300s by default), and reasoning + web_search
    // tasks send no response headers until they finish — so that default fires first
    // and surfaces as a bare "Request timed out." long before `timeout` is reached.
    // Node's bundled fetch rejects a dispatcher from this undici version, so take
    // undici's fetch too and keep both on the same implementation.
    fetch: undiciFetch as unknown as typeof globalThis.fetch,
    fetchOptions: {
      dispatcher: new Agent({
        headersTimeout: config.openAITimeoutMs,
        bodyTimeout: config.openAITimeoutMs
      })
    }
  });
  return client;
}
