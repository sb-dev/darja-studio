import OpenAI from "openai";

let client: OpenAI | undefined;

export function getOpenAI(): OpenAI {
  client ??= new OpenAI();
  return client;
}
