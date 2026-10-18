import OpenAI from "openai";

const apiKey = process.env.LLM_API_KEY;
const baseURL = process.env.LLM_BASE_URL;
const model = process.env.LLM_MODEL;

if (!apiKey || !baseURL || !model) {
    throw new Error("Missing env variable")
}

export const llm = new OpenAI({ apiKey, baseURL });
export const llmModel = model;