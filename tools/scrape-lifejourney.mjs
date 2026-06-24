import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const sourcePath = resolve("public/data/sources.json");
const outputPath = resolve("public/data/questions.generated.json");
const reportPath = resolve("public/data/scrape-report.json");

const questionStartPattern = /(^|\n)(\d{1,2})\.\s*/g;

function decodeEntities(value) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " "
  };
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, entity) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return named[entity] ?? "";
  });
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h1|h2|h3|h4|tr|pre|blockquote|summary|details)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

function extractArticleHtml(html) {
  const candidates = [
    /<div[^>]+class=["'][^"']*tt_article_useless_p_margin[^"']*["'][^>]*>([\s\S]*?)<div[^>]+class=["'][^"']*container_postbtn/gi,
    /<article[^>]*>([\s\S]*?)<\/article>/gi,
    /<div[^>]+class=["'][^"']*article-view[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi
  ];

  for (const pattern of candidates) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      return match[1];
    }
  }

  return html;
}

function clipBody(text, source) {
  const header = new RegExp(`\\[${source.year}년\\s*${source.round}회\\][^\\n]*`, "m");
  const headerMatch = header.exec(text);
  let body = headerMatch ? text.slice(headerMatch.index + headerMatch[0].length) : text;
  const firstQuestion = body.search(/(?:^|\n)1\.\s+/);
  if (firstQuestion >= 0) {
    body = body.slice(firstQuestion);
  }
  const endMarkers = [
    "\n클릭하면 해당 페이지로 이동됩니다.",
    "\n반응형\n\n공유하기",
    "\n공유하기",
    "\n댓글"
  ];
  const endIndex = endMarkers
    .map((marker) => body.indexOf(marker))
    .filter((index) => index > 0)
    .sort((a, b) => a - b)[0];
  if (endIndex) {
    body = body.slice(0, endIndex);
  }
  return body.replace(/\n{3,}/g, "\n\n").trim();
}

function removeSequentialLineNumbers(value) {
  const lines = value.split("\n");
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!/^\s*1\s*$/.test(line)) {
      output.push(line);
      index += 1;
      continue;
    }

    const block = [];
    const numbers = [];
    let cursor = index;
    while (cursor < lines.length && (/^\s*$/.test(lines[cursor]) || /^\s*\d{1,3}\s*$/.test(lines[cursor]))) {
      block.push(lines[cursor]);
      if (/^\s*\d{1,3}\s*$/.test(lines[cursor])) {
        numbers.push(Number(lines[cursor].trim()));
      }
      cursor += 1;
    }

    const isLineNumberBlock =
      numbers.length >= 2 && numbers.every((number, numberIndex) => number === numberIndex + 1);

    if (isLineNumberBlock) {
      index = cursor;
      continue;
    }

    output.push(line);
    index += 1;
  }
  return output.join("\n");
}

function cleanPrompt(value, number) {
  return removeSequentialLineNumbers(value)
    .replace(new RegExp(`^${number}\\.\\s*`), "")
    .replace(/\n?더보기[\s\S]*$/m, "")
    .replace(/Colored by Color Scripter/gi, "")
    .replace(/\ncs\s*$/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanAnswer(value) {
  const lines = value
    .replace(/정답\s*[:：]/g, "")
    .replace(/Colored by Color Scripter/gi, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const cutoff = lines.findIndex((line) => /^(반응형|LIST|공유하기|태그|댓글)$/.test(line));
  return lines.slice(0, cutoff >= 0 ? cutoff : lines.length).join("\n").trim();
}

function inferType(prompt) {
  if (/설명|서술|약술|개념|목적/.test(prompt)) return "서술형";
  if (/코드|출력|SQL|C언어|Java|파이썬|Python/.test(prompt)) return "코드/계산형";
  return "단답형";
}

function acceptedAnswersFrom(answer) {
  const compactLines = answer
    .split("\n")
    .map((line) => line.replace(/^\d+[.)]\s*/, "").trim())
    .filter(Boolean);
  const firstLines = compactLines.slice(0, Math.min(5, compactLines.length));
  const joined = firstLines.join(" ");
  return [...new Set([joined, ...firstLines].filter((item) => item.length <= 160 && item.length > 0))];
}

function parseQuestions(text, source) {
  const body = clipBody(text, source);
  const candidates = [...body.matchAll(questionStartPattern)];
  const matches = [];
  let expectedNumber = 1;
  let previousStart = 0;

  for (const candidate of candidates) {
    const number = Number(candidate[2]);
    const index = candidate.index + candidate[1].length;
    const isFirstQuestion = expectedNumber === 1;
    const previousQuestionHasAnswer = body.slice(previousStart, index).includes("더보기");

    if (number === expectedNumber && (isFirstQuestion || previousQuestionHasAnswer)) {
      matches.push({
        number,
        index,
        markerLength: candidate[0].length - candidate[1].length
      });
      previousStart = index;
      expectedNumber += 1;
    }
  }

  const questions = [];

  for (let index = 0; index < matches.length; index += 1) {
    const number = matches[index].number;
    const start = matches[index].index;
    const end = index + 1 < matches.length ? matches[index + 1].index : body.length;
    const chunk = body.slice(start, end).trim();
    const answerIndex = chunk.indexOf("더보기");
    if (answerIndex < 0) {
      continue;
    }

    const prompt = cleanPrompt(chunk.slice(0, answerIndex), number);
    const answer = cleanAnswer(chunk.slice(answerIndex).replace(/^더보기\s*/, ""));
    if (!prompt || !answer) {
      continue;
    }

    questions.push({
      id: `${source.id}-${number}`,
      number,
      type: inferType(prompt),
      prompt,
      answer,
      acceptedAnswers: acceptedAnswersFrom(answer),
      sourceUrl: source.url
    });
  }

  return questions;
}

function applyKnownCorrections(session) {
  if (session.id === "2023-3" && !session.questions.some((question) => question.number === 5)) {
    session.questions.push({
      id: "2023-3-5",
      number: 5,
      type: "코드/계산형",
      prompt:
        "C언어에서 구조체의 멤버에 접근하기 위해 괄호안의 기호를 작성하시오.\n\n#include <stdio.h>\n#include <stdlib.h>\n\ntypedef struct Data{\n    char c;\n    int *numPtr;\n} Data;\n\nint main(){\n    int num = 10;\n    Data d1;\n    Data *d2 = malloc(sizeof(struct Data));\n    d1.numPtr = &num;\n    d2 ( ) numPtr = &num;\n    printf(\"%d\\n\", *d1.numPtr);\n    printf(\"%d\\n\", *d2 ( ) numPtr);\n    free(d2);\n    return 0;\n}\n\n출력결과\n10\n10",
      answer: "→",
      acceptedAnswers: ["→", "->"],
      sourceUrl: session.sourceUrl,
      correctionNote: "원문에 존재하지만 자동 번호 경계 파싱에서 누락되어 보정했습니다."
    });
    session.questions.sort((left, right) => left.number - right.number);
  }
  return session;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 ipe-practical-study/0.1"
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function main() {
  const sourceConfig = JSON.parse(await readFile(sourcePath, "utf8"));
  const sessions = [];
  const report = [];

  for (const source of sourceConfig.sources) {
    try {
      const html = await fetchText(source.url);
      const text = htmlToText(extractArticleHtml(html));
      const questions = parseQuestions(text, source);
      const session = applyKnownCorrections({
        id: source.id,
        year: source.year,
        round: source.round,
        title: `${source.year}년 ${source.round}회 정보처리기사 실기 복원 문제`,
        description: "응시자 기억 기반 복원 문제입니다. 원문 출처와 함께 검토하세요.",
        sourceUrl: source.url,
        restored: true,
        questions
      });
      sessions.push(session);
      report.push({ id: source.id, url: source.url, ok: true, questions: session.questions.length });
      console.log(`${source.id}: ${session.questions.length} questions`);
    } catch (error) {
      report.push({ id: source.id, url: source.url, ok: false, error: error.message });
      console.error(`${source.id}: ${error.message}`);
    }
  }

  const dataset = {
    generatedAt: new Date().toISOString(),
    sourceNotice:
      "이 데이터는 공개 웹의 복원 자료를 파싱한 것입니다. 공식 문제지가 아니므로 답안은 원문 출처와 대조해 검수하세요.",
    sessions
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
  await writeFile(reportPath, `${JSON.stringify({ generatedAt: dataset.generatedAt, report }, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
