# Florist Work Environment Screening

RULA 기반 꽃집 작업환경 자가진단형 스크리닝 웹사이트 초안입니다.

## 실행 방법

```bash
npm install
npm run dev
```

브라우저에서 http://localhost:3000 접속.

## AI 연결

`.env.example`을 `.env.local`로 복사한 뒤 `OPENAI_API_KEY`를 입력하면 `/api/analyze`가 OpenAI API 분석을 시도합니다. 키가 없으면 규칙 기반 분석으로 자동 대체됩니다.

## 핵심 구조

- `app/page.tsx`: 메인 페이지
- `components/SelfCheckApp.tsx`: 랜딩, 체크리스트, 결과 화면
- `lib/checklist.ts`: 문항 데이터
- `lib/scoring.ts`: 점수 계산 및 규칙 기반 분석
- `app/api/analyze/route.ts`: AI 분석 API 라우트
