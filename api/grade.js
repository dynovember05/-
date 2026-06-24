import { gradeWithOpenAI } from "../lib/grader.mjs";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  try {
    const payload = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body || {};
    const result = await gradeWithOpenAI(payload);
    response.status(200).json(
      result ?? {
        items: null,
        summary: "OPENAI_API_KEY 또는 OPENAI_MODEL이 없어 브라우저 채점으로 전환합니다."
      }
    );
  } catch (error) {
    response.status(500).json({ error: String(error.message || error) });
  }
}
