# 정보처리기사 실기 문제 카드

2020년 1회부터 2026년 현재 진행 완료 회차까지의 정보처리기사 실기 복원 문제를 카드와 시험 화면으로 공부하는 웹앱입니다.

## 실행

```powershell
node server.mjs
```

브라우저에서 `http://localhost:5173`을 엽니다.

## 데이터 갱신

```powershell
node tools/scrape-lifejourney.mjs
```

스크립트는 `public/data/sources.json`의 회차별 원문 URL을 읽어 `public/data/questions.generated.json`을 생성합니다. 2026년 6월 24일 기준 수집 대상은 20회차이며, 현재 생성 데이터는 총 400문항입니다.

2026년 정보처리기사 실기 2회는 2026년 7월 19일 시행 예정이므로, 2026년 6월 24일 현재 진행 완료된 2026년 회차는 1회까지입니다.

## 채점

- 기본 채점은 브라우저에서 기준 답안과 작성 답안을 비교하는 로컬 채점입니다.
- 서버 AI 채점을 쓰려면 `OPENAI_API_KEY`와 `OPENAI_MODEL`을 환경 변수로 지정합니다.

```powershell
$env:OPENAI_API_KEY="..."
$env:OPENAI_MODEL="..."
node server.mjs
```

## Vercel 배포

이 프로젝트는 `public/` 정적 파일과 `api/grade.js` 서버리스 함수로 동작합니다.

1. GitHub 저장소를 Vercel에서 Import 합니다.
2. Build Command는 비워둡니다.
3. Output Directory는 `public`으로 설정합니다.
4. Environment Variables에 아래 값을 추가합니다.

```text
OPENAI_API_KEY=...
OPENAI_MODEL=...
```

`.env` 파일은 로컬 전용이므로 Vercel에는 업로드하지 않습니다. Vercel Storage, Blob, KV, Postgres는 사용하지 않습니다.

배포 후 `/api/grade`가 JSON을 반환하면 함수가 정상입니다. 제출 시 `/api/grade` 서버리스 함수가 OpenAI로 채점합니다.

## 주의

정보처리기사 실기 문제와 답은 공식 공개본이 아니라 응시자 기억 기반 복원 자료로 확인됩니다. 앱은 각 문항의 출처 URL을 보존하며, 중요한 답안은 원문과 한 번 더 대조하는 용도로 설계했습니다.
