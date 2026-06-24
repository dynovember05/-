const app = document.querySelector("#app");

const storageKeys = {
  history: "ipe-study-history-v1",
  draftPrefix: "ipe-study-draft-v1:"
};

const state = {
  sessions: [],
  sources: [],
  dataNotice: "",
  dataMode: "sample",
  filters: {
    search: "",
    year: "all",
    status: "all"
  },
  attempt: null,
  questionIndex: 0,
  result: null
};

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${path} ${response.status}`);
  }
  return response.json();
}

async function loadData() {
  const sources = await fetchJson("./data/sources.json").catch(() => ({ sources: [] }));
  state.sources = sources.sources || [];

  try {
    const generated = await fetchJson("./data/questions.generated.json");
    state.sessions = generated.sessions || [];
    state.dataNotice = generated.sourceNotice || "";
    state.dataMode = "generated";
  } catch {
    const sample = await fetchJson("./data/questions.sample.json");
    state.sessions = sample.sessions || [];
    state.dataNotice = sample.sourceNotice || "";
    state.dataMode = "sample";
  }
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(storageKeys.history) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(storageKeys.history, JSON.stringify(history.slice(0, 30)));
}

function draftKey(attemptId) {
  return `${storageKeys.draftPrefix}${attemptId}`;
}

function saveDraft() {
  if (!state.attempt) {
    return;
  }
  localStorage.setItem(draftKey(state.attempt.id), JSON.stringify(state.attempt));
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isCodeLine(line = "") {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return (
    /^(#include|import\s|from\s+\w+\s+import|package\s)/.test(trimmed) ||
    /^(public|private|protected|static|class|interface|struct|typedef|enum)\b/.test(trimmed) ||
    /^(int|char|double|float|long|short|void|boolean|String|def|for|while|if|else|elif|return|print|printf|System\.out|scanf)\b/.test(trimmed) ||
    /^(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|GROUP BY|ORDER BY|HAVING|CREATE|ALTER|INSERT|UPDATE|DELETE|CONSTRAINT|FOREIGN|PRIMARY|REFERENCES)\b/i.test(trimmed) ||
    /^[{}();]+$/.test(trimmed) ||
    /[;{}]$/.test(trimmed) ||
    /^\w+\s*=\s*.+/.test(trimmed) ||
    /^\w+\s*\(.*\)\s*[:{]?$/.test(trimmed)
  );
}

function nextMeaningfulLineIsCode(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    return isCodeLine(lines[index]);
  }
  return false;
}

function renderPromptHtml(prompt = "") {
  const lines = String(prompt).split("\n");
  const blocks = [];
  let current = { type: "text", lines: [] };

  function pushCurrent() {
    const content = current.lines.join("\n").trim();
    if (content) {
      blocks.push({ type: current.type, content });
    }
    current = { type: "text", lines: [] };
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const codeLine = isCodeLine(line) || (current.type === "code" && !line.trim() && nextMeaningfulLineIsCode(lines, index + 1));
    const type = codeLine ? "code" : "text";

    if (current.type !== type) {
      pushCurrent();
      current = { type, lines: [] };
    }

    current.lines.push(line);
  }

  pushCurrent();

  return blocks
    .map((block) => {
      if (block.type === "code") {
        return `<pre class="code-block"><code>${escapeHtml(block.content)}</code></pre>`;
      }
      return `<div class="question-text">${escapeHtml(block.content)}</div>`;
    })
    .join("");
}

function normalizeAnswer(value = "") {
  return String(value)
    .toLowerCase()
    .replace(/[()\[\]{}'"`.,:;!?/\\|_\-+=~·•<>]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let row = 0; row <= a.length; row += 1) matrix[row][0] = row;
  for (let col = 0; col <= b.length; col += 1) matrix[0][col] = col;

  for (let row = 1; row <= a.length; row += 1) {
    for (let col = 1; col <= b.length; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      matrix[row][col] = Math.min(
        matrix[row - 1][col] + 1,
        matrix[row][col - 1] + 1,
        matrix[row - 1][col - 1] + cost
      );
    }
  }
  return matrix[a.length][b.length];
}

function answerSimilarity(expected, actual) {
  const expectedNorm = normalizeAnswer(expected);
  const actualNorm = normalizeAnswer(actual);
  if (!expectedNorm && !actualNorm) return 1;
  if (!expectedNorm || !actualNorm) return 0;
  if (expectedNorm === actualNorm) return 1;
  if (actualNorm.includes(expectedNorm) || expectedNorm.includes(actualNorm)) return 0.92;
  const distance = levenshtein(expectedNorm, actualNorm);
  return 1 - distance / Math.max(expectedNorm.length, actualNorm.length);
}

function splitExpectedAnswers(question) {
  const answers = [
    ...(Array.isArray(question.acceptedAnswers) ? question.acceptedAnswers : []),
    question.answer || ""
  ];
  return [...new Set(answers.map((answer) => String(answer).trim()).filter(Boolean))];
}

function gradeQuestion(question, actualAnswer) {
  const expectedAnswers = splitExpectedAnswers(question);
  const best = expectedAnswers.reduce(
    (bestMatch, answer) => {
      const similarity = answerSimilarity(answer, actualAnswer);
      return similarity > bestMatch.similarity ? { answer, similarity } : bestMatch;
    },
    { answer: expectedAnswers[0] || "", similarity: 0 }
  );

  const score =
    best.similarity >= 0.98 ? 5 : best.similarity >= 0.88 ? 4 : best.similarity >= 0.72 ? 3 : best.similarity >= 0.48 ? 2 : 0;
  const verdict = score === 5 ? "correct" : score >= 3 ? "partial" : "wrong";

  const feedback =
    verdict === "correct"
      ? "기준 답안과 충분히 일치합니다."
      : verdict === "partial"
        ? `핵심 키워드는 일부 맞지만 표현이나 빠진 요소가 있습니다. 기준 답안: ${best.answer}`
        : `기준 답안과 거리가 큽니다. 기준 답안: ${best.answer}`;

  return {
    id: question.id,
    score,
    maxScore: 5,
    verdict,
    feedback,
    expected: best.answer,
    actual: actualAnswer || ""
  };
}

async function gradeAttempt(attempt) {
  const payload = {
    session: {
      id: attempt.session.id,
      title: attempt.session.title,
      sourceUrl: attempt.session.sourceUrl
    },
    questions: attempt.questions.map((question) => ({
      id: question.id,
      number: question.number,
      prompt: question.prompt,
      expectedAnswer: question.answer,
      acceptedAnswers: question.acceptedAnswers || []
    })),
    answers: attempt.answers
  };

  try {
    const response = await fetch("/api/grade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      const remoteResult = await response.json();
      if (Array.isArray(remoteResult.items)) {
        return {
          items: remoteResult.items,
          summary: remoteResult.summary || "AI 채점을 완료했습니다.",
          mode: "ai"
        };
      }
    }
  } catch {
    // Browser-only fallback is expected when index.html is opened without the local server.
  }

  const items = attempt.questions.map((question) => gradeQuestion(question, attempt.answers[question.id] || ""));
  const total = items.reduce((sum, item) => sum + item.score, 0);
  return {
    items,
    summary: `브라우저 채점으로 ${total}/${items.length * 5}점을 계산했습니다.`,
    mode: "local"
  };
}

function sessionStats() {
  const questions = state.sessions.reduce((sum, session) => sum + session.questions.length, 0);
  const histories = loadHistory();
  const latestScore = histories[0] ? `${histories[0].score}/${histories[0].maxScore}` : "-";
  return { sessions: state.sessions.length, questions, histories: histories.length, latestScore };
}

function filteredSessions() {
  return state.sessions.filter((session) => {
    const searchText = `${session.title} ${session.year} ${session.round} ${session.questions.map((question) => question.prompt).join(" ")}`.toLowerCase();
    const matchesSearch = !state.filters.search || searchText.includes(state.filters.search.toLowerCase());
    const matchesYear = state.filters.year === "all" || String(session.year) === state.filters.year;
    const matchesStatus = state.filters.status === "all" || (state.filters.status === "restored" ? session.restored : !session.restored);
    return matchesSearch && matchesYear && matchesStatus;
  });
}

function renderHome() {
  state.attempt = null;
  state.result = null;
  const stats = sessionStats();
  const years = [...new Set(state.sessions.map((session) => session.year))].sort((a, b) => b - a);
  const sessions = filteredSessions();
  const histories = loadHistory();

  app.innerHTML = `
    <header class="topbar">
      <div class="title-group">
        <h1>정보처리기사 실기 문제 카드</h1>
        <p>2020년 1회부터 2026년 현재 진행 회차까지, 복원 문제를 출처와 함께 관리합니다.</p>
      </div>
      <div class="toolbar">
        <button class="button secondary" data-action="show-sources">출처 보기</button>
        <button class="button warning" data-action="start-random">랜덤 20문제</button>
      </div>
    </header>

    <section class="stats-grid">
      <div class="stat"><strong>${stats.sessions}</strong><span>회차</span></div>
      <div class="stat"><strong>${stats.questions}</strong><span>등록 문제</span></div>
      <div class="stat"><strong>${stats.histories}</strong><span>풀이 기록</span></div>
      <div class="stat"><strong>${stats.latestScore}</strong><span>최근 점수</span></div>
    </section>

    <div class="notice">
      ${state.dataMode === "generated" ? "스크래퍼로 생성한 복원 문제 데이터를 사용 중입니다." : "현재는 샘플 데이터입니다. 전체 복원 문제는 `node tools/scrape-lifejourney.mjs` 실행 후 자동으로 불러옵니다."}
      ${escapeHtml(state.dataNotice)}
    </div>

    <section class="filter-row">
      <input class="input" type="search" placeholder="문제, 회차, 키워드 검색" value="${escapeHtml(state.filters.search)}" data-filter="search" />
      <select class="select" data-filter="year">
        <option value="all">전체 연도</option>
        ${years.map((year) => `<option value="${year}" ${state.filters.year === String(year) ? "selected" : ""}>${year}년</option>`).join("")}
      </select>
      <select class="select" data-filter="status">
        <option value="all">전체 자료</option>
        <option value="restored" ${state.filters.status === "restored" ? "selected" : ""}>복원 문제</option>
        <option value="official" ${state.filters.status === "official" ? "selected" : ""}>공식/샘플</option>
      </select>
    </section>

    <section class="session-grid">
      ${sessions.map(renderSessionCard).join("")}
    </section>

    <section class="panel" style="margin-top:18px">
      <h2>풀이 기록</h2>
      ${renderHistory(histories)}
    </section>
  `;
}

function renderSessionCard(session) {
  const answeredCount = loadHistory().filter((item) => item.sessionId === session.id).length;
  return `
    <article class="card session-card">
      <div>
        <div class="card-meta">
          <span class="pill green">${session.year}년 ${session.round}회</span>
          <span class="pill">${session.questions.length}문제</span>
          <span class="pill orange">${session.restored ? "복원" : "샘플"}</span>
        </div>
        <h2>${escapeHtml(session.title)}</h2>
        <p>${escapeHtml(session.description || "주관식과 서술형 답안을 직접 작성하고 채점할 수 있습니다.")}</p>
        <p>${answeredCount ? `이 회차 풀이 기록 ${answeredCount}개가 있습니다.` : "아직 풀이 기록이 없습니다."}</p>
      </div>
      <div class="session-actions">
        <button class="button" data-action="start-session" data-session-id="${session.id}">문제 풀기</button>
        <button class="button secondary" data-action="preview-session" data-session-id="${session.id}">카드 보기</button>
      </div>
    </article>
  `;
}

function renderHistory(histories) {
  if (!histories.length) {
    return `<p class="history-empty">제출한 문제 세트가 여기에 기록됩니다.</p>`;
  }
  return `
    <div class="history-list">
      ${histories
        .map(
          (item) => `
          <div class="history-item">
            <div>
              <strong>${escapeHtml(item.title)}</strong>
              <p>${new Date(item.submittedAt).toLocaleString("ko-KR")} · ${item.score}/${item.maxScore}점 · ${item.mode === "ai" ? "AI 채점" : "브라우저 채점"}</p>
            </div>
            <button class="button secondary" data-action="view-history" data-history-id="${escapeHtml(item.id)}">기록 보기</button>
          </div>
        `
        )
        .join("")}
    </div>
  `;
}

function renderHistoryDetail(historyId) {
  const history = loadHistory().find((item) => item.id === historyId);
  if (!history) {
    renderHome();
    return;
  }

  app.innerHTML = `
    <header class="topbar">
      <div class="title-group">
        <h1>${escapeHtml(history.title)}</h1>
        <p>${new Date(history.submittedAt).toLocaleString("ko-KR")} · ${history.score}/${history.maxScore}점 · ${history.mode === "ai" ? "AI 채점" : "브라우저 채점"}</p>
      </div>
      <button class="button secondary" data-action="home">메인으로</button>
    </header>
    <section class="stats-grid">
      <div class="stat"><strong>${history.score}</strong><span>획득 점수</span></div>
      <div class="stat"><strong>${history.maxScore}</strong><span>총점</span></div>
      <div class="stat"><strong>${Math.round((history.score / history.maxScore) * 100)}%</strong><span>정답률</span></div>
      <div class="stat"><strong>${history.items?.filter((item) => item.verdict === "wrong").length ?? 0}</strong><span>오답</span></div>
    </section>
    <section class="result-list">
      ${(history.questions || [])
        .map((question, index) => {
          const item = (history.items || []).find((resultItem) => resultItem.id === question.id) || {};
          const answer = history.answers?.[question.id] || "";
          return `
            <article class="result-item ${item.verdict || "wrong"}">
              <div class="card-meta">
                <span class="pill">${index + 1}번</span>
                <span class="pill">${Number(item.score || 0)}/${Number(item.maxScore || 5)}</span>
                <span class="pill ${item.verdict === "correct" ? "green" : "orange"}">${escapeHtml(item.verdict || "wrong")}</span>
              </div>
              <div class="question-body">${renderPromptHtml(question.prompt || "")}</div>
              <div class="answer-preview"><strong>내 답안</strong><br>${escapeHtml(answer || "(미작성)")}</div>
              <div class="answer-preview"><strong>기준 답안</strong><br>${escapeHtml(item.expected || question.answer || "")}</div>
              <p>${escapeHtml(item.feedback || "피드백이 저장되지 않았습니다.")}</p>
            </article>
          `;
        })
        .join("")}
    </section>
  `;
}

function renderSources() {
  app.innerHTML = `
    <header class="topbar">
      <div class="title-group">
        <h1>복원 문제 출처</h1>
        <p>2026년 6월 24일 기준으로 확인한 진행 회차 URL 목록입니다.</p>
      </div>
      <button class="button secondary" data-action="home">돌아가기</button>
    </header>
    <section class="panel">
      <h2>수집 대상</h2>
      <ul class="source-list">
        ${state.sources
          .map(
            (source) => `
            <li>
              <strong>${source.year}년 ${source.round}회</strong>
              · <a href="${source.url}" target="_blank" rel="noreferrer">${escapeHtml(source.url)}</a>
            </li>
          `
          )
          .join("")}
      </ul>
    </section>
  `;
}

function renderPreview(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return renderHome();

  app.innerHTML = `
    <header class="topbar">
      <div class="title-group">
        <h1>${escapeHtml(session.title)}</h1>
        <p>${session.questions.length}개 문제와 기준 답안을 매핑했습니다.</p>
      </div>
      <div class="toolbar">
        <button class="button" data-action="start-session" data-session-id="${session.id}">문제 풀기</button>
        <button class="button secondary" data-action="home">돌아가기</button>
      </div>
    </header>
    <section class="result-list">
      ${session.questions
        .map(
          (question) => `
            <article class="result-item">
              <div class="card-meta">
                <span class="pill">${question.number}번</span>
                <span class="pill">${escapeHtml(question.type || "주관식")}</span>
              </div>
              <div class="question-body">${renderPromptHtml(question.prompt)}</div>
              <details class="answer-preview">
                <summary>답 보기</summary>
                ${escapeHtml(question.answer || "")}
              </details>
            </article>
          `
        )
        .join("")}
    </section>
  `;
}

function createAttempt(session) {
  const existingDraftKey = Object.keys(localStorage).find((key) => key.startsWith(storageKeys.draftPrefix) && key.includes(session.id));
  if (existingDraftKey) {
    try {
      const draft = JSON.parse(localStorage.getItem(existingDraftKey));
      if (draft?.session?.id === session.id && !draft.submittedAt) {
        return draft;
      }
    } catch {
      localStorage.removeItem(existingDraftKey);
    }
  }

  return {
    id: `${session.id}-${Date.now()}`,
    session: {
      id: session.id,
      title: session.title,
      sourceUrl: session.sourceUrl
    },
    questions: session.questions.slice(0, 20),
    answers: {},
    startedAt: new Date().toISOString()
  };
}

function createRandomAttempt() {
  const allQuestions = state.sessions.flatMap((session) =>
    session.questions.map((question) => ({
      ...question,
      sourceTitle: session.title,
      sourceUrl: session.sourceUrl
    }))
  );
  const shuffled = allQuestions.sort(() => Math.random() - 0.5).slice(0, 20);
  return {
    id: `random-${Date.now()}`,
    session: {
      id: "random",
      title: "랜덤 20문제",
      sourceUrl: ""
    },
    questions: shuffled,
    answers: {},
    startedAt: new Date().toISOString()
  };
}

function startSession(sessionId) {
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  state.attempt = createAttempt(session);
  state.questionIndex = 0;
  saveDraft();
  renderExam();
}

function startRandom() {
  state.attempt = createRandomAttempt();
  state.questionIndex = 0;
  saveDraft();
  renderExam();
}

function renderExam() {
  const attempt = state.attempt;
  const question = attempt.questions[state.questionIndex];
  const answered = attempt.questions.filter((item) => (attempt.answers[item.id] || "").trim()).length;
  const percent = Math.round((answered / attempt.questions.length) * 100);

  app.innerHTML = `
    <header class="topbar">
      <div class="title-group">
        <h1>${escapeHtml(attempt.session.title)}</h1>
        <p>답안은 입력할 때마다 이 브라우저에 자동 저장됩니다.</p>
      </div>
      <button class="button secondary" data-action="home">나가기</button>
    </header>
    <section class="two-column">
      <article class="card question-card">
        <div class="question-header">
          <div class="card-meta">
            <span class="pill green">${state.questionIndex + 1}/${attempt.questions.length}</span>
            <span class="pill">${escapeHtml(question.type || "주관식")}</span>
          </div>
          <span class="pill">${answered}개 작성</span>
        </div>
        <div class="question-body">${renderPromptHtml(question.prompt)}</div>
        <textarea class="answer-box" data-answer-id="${question.id}" placeholder="답안을 작성하세요.">${escapeHtml(attempt.answers[question.id] || "")}</textarea>
        <div class="exam-nav">
          <button class="button secondary" data-action="prev-question" ${state.questionIndex === 0 ? "disabled" : ""}>이전</button>
          <button class="button secondary" data-action="next-question" ${state.questionIndex === attempt.questions.length - 1 ? "disabled" : ""}>다음</button>
          <button class="button warning" data-action="submit-attempt">제출하고 채점</button>
        </div>
      </article>
      <aside class="panel">
        <h2>진행률</h2>
        <div class="progress"><span style="width:${percent}%"></span></div>
        <div class="question-map">
          ${attempt.questions
            .map(
              (item, index) => `
              <button class="map-button ${index === state.questionIndex ? "active" : ""} ${(attempt.answers[item.id] || "").trim() ? "done" : ""}" data-action="go-question" data-index="${index}">
                ${index + 1}
              </button>
            `
            )
            .join("")}
        </div>
      </aside>
    </section>
  `;
}

function updateCurrentAnswer(target) {
  if (!state.attempt || !target?.dataset?.answerId) {
    return;
  }
  state.attempt.answers[target.dataset.answerId] = target.value;
  saveDraft();
}

async function submitAttempt() {
  if (!state.attempt) return;
  const result = await gradeAttempt(state.attempt);
  const score = result.items.reduce((sum, item) => sum + Number(item.score || 0), 0);
  const maxScore = result.items.reduce((sum, item) => sum + Number(item.maxScore || 5), 0);
  const history = loadHistory();
  const submittedAt = new Date().toISOString();

  saveHistory([
    {
      id: state.attempt.id,
      sessionId: state.attempt.session.id,
      title: state.attempt.session.title,
      score,
      maxScore,
      mode: result.mode,
      submittedAt,
      summary: result.summary,
      questions: state.attempt.questions.map((question) => ({
        id: question.id,
        number: question.number,
        type: question.type,
        prompt: question.prompt,
        answer: question.answer,
        acceptedAnswers: question.acceptedAnswers || [],
        sourceUrl: question.sourceUrl || state.attempt.session.sourceUrl || ""
      })),
      answers: { ...state.attempt.answers },
      items: result.items.map((item) => ({ ...item }))
    },
    ...history
  ]);
  localStorage.removeItem(draftKey(state.attempt.id));
  state.result = { ...result, score, maxScore, submittedAt };
  renderResult();
}

function renderResult() {
  const attempt = state.attempt;
  const result = state.result;
  const byId = Object.fromEntries(result.items.map((item) => [item.id, item]));

  app.innerHTML = `
    <header class="topbar">
      <div class="title-group">
        <h1>채점 결과</h1>
        <p>${escapeHtml(result.summary)}</p>
      </div>
      <div class="toolbar">
        <button class="button" data-action="home">메인으로</button>
      </div>
    </header>
    <section class="stats-grid">
      <div class="stat"><strong>${result.score}</strong><span>획득 점수</span></div>
      <div class="stat"><strong>${result.maxScore}</strong><span>총점</span></div>
      <div class="stat"><strong>${Math.round((result.score / result.maxScore) * 100)}%</strong><span>정답률</span></div>
      <div class="stat"><strong>${result.mode === "ai" ? "AI" : "로컬"}</strong><span>채점 방식</span></div>
    </section>
    <section class="result-list">
      ${attempt.questions
        .map((question, index) => {
          const item = byId[question.id] || gradeQuestion(question, attempt.answers[question.id] || "");
          return `
            <article class="result-item ${item.verdict}">
              <div class="card-meta">
                <span class="pill">${index + 1}번</span>
                <span class="pill">${item.score}/${item.maxScore}</span>
                <span class="pill ${item.verdict === "correct" ? "green" : "orange"}">${item.verdict}</span>
              </div>
              <div class="question-body">${renderPromptHtml(question.prompt)}</div>
              <div class="answer-preview"><strong>내 답안</strong><br>${escapeHtml(attempt.answers[question.id] || "(미작성)")}</div>
              <div class="answer-preview"><strong>기준 답안</strong><br>${escapeHtml(item.expected || question.answer || "")}</div>
              <p>${escapeHtml(item.feedback || "")}</p>
            </article>
          `;
        })
        .join("")}
    </section>
  `;
}

app.addEventListener("input", (event) => {
  if (event.target.matches("[data-answer-id]")) {
    updateCurrentAnswer(event.target);
    return;
  }

  if (event.target.matches("[data-filter]")) {
    state.filters[event.target.dataset.filter] = event.target.value;
    renderHome();
  }
});

app.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;

  const action = target.dataset.action;
  if (action === "home") renderHome();
  if (action === "show-sources") renderSources();
  if (action === "view-history") renderHistoryDetail(target.dataset.historyId);
  if (action === "preview-session") renderPreview(target.dataset.sessionId);
  if (action === "start-session") startSession(target.dataset.sessionId);
  if (action === "start-random") startRandom();
  if (action === "prev-question" && state.questionIndex > 0) {
    state.questionIndex -= 1;
    renderExam();
  }
  if (action === "next-question" && state.questionIndex < state.attempt.questions.length - 1) {
    state.questionIndex += 1;
    renderExam();
  }
  if (action === "go-question") {
    state.questionIndex = Number(target.dataset.index);
    renderExam();
  }
  if (action === "submit-attempt") {
    target.disabled = true;
    target.textContent = "채점 중";
    await submitAttempt();
  }
});

loadData()
  .then(renderHome)
  .catch((error) => {
    app.innerHTML = `<section class="loading-panel"><h1>데이터 로드 실패</h1><p>${escapeHtml(error.message)}</p></section>`;
  });
