import OpenAI from "openai";
import { config } from "./config.js";

let client: OpenAI | undefined;

export function getOpenAI(): OpenAI {
  client ??= new OpenAI({
    timeout: config.openAITimeoutMs,
    // Task retries are handled by the runner so every retry is visible and persisted.
    maxRetries: 0
  });
  return client;
}
