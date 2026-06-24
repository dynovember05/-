async function gradeWithOpenAI(payload) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;

  if (!apiKey || !model) {
    return null;
  }

  const openAIResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content:
            "You are a strict Korean Information Processing Engineer practical exam grader. Grade by the provided reference answer, but accept semantically equivalent wording, minor spacing/case differences, and harmless Korean/English notation variants. Be strict about missing core keywords, wrong concepts, wrong output values, wrong SQL/code results, and answers that are only vaguely related. Award partial credit only when the answer contains clearly correct required elements. Feedback must be written in Korean. Return compact JSON only."
        },
        {
          role: "user",
          content:
            "Grade each answer from 0 to 5 by comparing the reference answer and the student's answer. Mark correct when the meaning is exactly equivalent or differs only by trivial notation, spacing, casing, or Korean/English variants. Strictly deduct for missing core keywords, confused concepts, wrong outputs, wrong calculations, and wrong SQL/code results. Give partial credit only when clearly correct required elements are present. Return JSON in this exact shape: {\"items\":[{\"id\":\"...\",\"score\":0,\"maxScore\":5,\"verdict\":\"correct|partial|wrong\",\"feedback\":\"Korean feedback\",\"expected\":\"reference answer summary\",\"actual\":\"student answer\"}],\"summary\":\"Korean summary\"}\n\n" +
            JSON.stringify(payload)
        }
      ],
      text: {
        format: {
          type: "json_object"
        }
      }
    })
  });

  if (!openAIResponse.ok) {
    const errorText = await openAIResponse.text().catch(() => "");
    throw new Error(`OpenAI grading failed: ${openAIResponse.status} ${errorText}`);
  }

  const data = await openAIResponse.json();
  const text =
    data.output_text ||
    (data.output || [])
      .flatMap((item) => item.content || [])
      .map((content) => content.text)
      .filter(Boolean)
      .join("\n");

  if (!text) {
    throw new Error("OpenAI grading response did not include text output.");
  }

  return JSON.parse(text);
}

module.exports = async function handler(request, response) {
  try {
    if (request.method === "GET") {
      response.status(200).json({ ok: true, route: "/api/grade" });
      return;
    }

    if (request.method !== "POST") {
      response.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    const payload = typeof request.body === "string" ? JSON.parse(request.body || "{}") : request.body || {};
    const result = await gradeWithOpenAI(payload);
    response.status(200).json(
      result || {
        items: null,
        summary: "OPENAI_API_KEY 또는 OPENAI_MODEL이 없어 브라우저 채점으로 전환합니다."
      }
    );
  } catch (error) {
    console.error(error);
    response.status(200).json({
      items: null,
      summary: `AI 채점 중 오류가 발생해 브라우저 채점으로 전환합니다. ${String(error.message || error)}`
    });
  }
};
