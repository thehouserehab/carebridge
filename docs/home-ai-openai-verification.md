# 홈 AI 실제 OpenAI 연결 확인

2026-11-17 · 가상 자료 전용 로컬 프로토타입

## 결과

홈 AI 자유 대화와 선택한 기록 요약을 실제 OpenAI Responses API에 연결했다. 기존 예시 실행기와 실제 실행기를 구분하고, 실제 실행기에서 키 누락·요청 실패 시 예시 응답으로 대체하지 않는다. 최신 로컬 UI의 인증·대화·기록·첨부 서비스를 그대로 사용한다.

- 실제 모델: `gpt-6-luna`
- 실제 API 요청: 질문 1회, 기록 요약 1회. 모두 HTTP 200.
- 입력: 제공된 새 가상 아동·블록 놀이 기록과 고정 가상 질문만 사용.
- 브라우저: PC 1440px 및 PC Chrome의 모바일 390/320px.
- 확인: 홈 직접 진입, 실제 답변 표시, 새로고침 후 대화 보존, 입력창 경계, 요약의 원기록 자동 저장 방지.
- 검증용 Chrome은 정리하고, 사용자가 이어서 사용할 가상 서버는 유지했다.

## 실행

`Carebridge-OpenAI.cmd` → 가려진 입력란에 키 입력 → 새 주소에서 터미널의 시연 계정으로 로그인 → 홈 **AI 도우미**. 종료는 `q` + Enter다. 키와 가상 자료는 서버 실행 중에만 사용하며 다음 실행은 새 세션이다. 기존 `Carebridge-Prototype.cmd`는 키 없는 오프라인 예시 모드다.

키를 명령 인수·파일·URL·브라우저 저장소에 넣지 않는다. PowerShell 7에서 자식 서버의 일시적 환경변수로 전달하고 초기화 직후 제거한다. 브라우저는 인증된 로컬 API만 호출하고 OpenAI 요청은 서버가 담당한다. 자동 검증 중 종료하면 검증 브라우저를 닫고 다음 요청을 막는다.

## 변경 파일

| 영역 | 파일 | 변경 이유 |
| --- | --- | --- |
| 실행 | `Carebridge-OpenAI.cmd`, `scripts/start-prototype-openai.ps1`, `scripts/prototype-openai.mjs` | 가려진 키 입력, 실제 공급자 구성, 안전한 상태 증거, 선택적 실제 검증 |
| 공통 실행 | `scripts/prototype.mjs`, `package.json` | 실행 모드 안내, 검증 훅과 종료 신호 전달, 실행 명령 |
| 서버 | `server/prototype-sandbox.mjs`, `server/local-api-sandbox.mjs`, `server/local-api-listener.mjs` | 명시적인 실제 공급자 선택과 호출 제한, 첫 화면 모드 표시 |
| 화면 | `local-api/ai-assistant-ui.js` | 서버 모드를 우선 적용하고 실제 OpenAI·예시 응답을 구분 |
| 브라우저 검증 | `scripts/lib/prototype-home-ai-check.mjs`, `tests/prototype-home-ai-browser.mjs` | 새 가상 세션에서 실제 UI→API→응답 흐름과 중단 검증 |
| 단위·통합 검사 | `tests/prototype-openai-cli.test.mjs`, `tests/prototype-home-ai-check.test.mjs`, `tests/local-ai-context-ui.test.mjs`, `server/tests/prototype-openai.test.mjs`, `server/tests/prototype-sandbox.test.mjs`, `server/tests/local-api-listener.test.mjs` | 인증·공급자 선택·오류·한도·키 미출력·취소·기존 모드 회귀 확인 |
| 안내 | `README.md`, `docs/prototype-demo.md`, 이 문서 | 실제 실행 경로와 확인 가능한 범위 명시 |

## 검증 명령과 결과

| 명령 / 검사 | 결과 |
| --- | --- |
| 루트 `node --test --test-concurrency=2 tests/*.test.mjs` | 1,983 통과, 실패 0, 조건부 제외 76 |
| server 폴더에서 같은 명령 | 2,128 통과, 실패 0, 조건부 제외 44 |
| `node scripts/check.mjs` 및 새 하위 검증 모듈 구문 검사 | 통과 |
| `node scripts/build.mjs` | 통과 |
| `git diff --check`, PowerShell 7 구문 검사 | 통과 |
| `node tests/prototype-home-ai-browser.mjs --confirm-synthetic-local` | 시험 공급자 2회, 실제 외부 호출 0회. 정상 흐름 및 첫 요청 후 취소 흐름 통과 |
| PowerShell 7 `scripts/start-prototype-openai.ps1 -VerifyHome` | 실제 OpenAI 2회 성공, PC·모바일 및 브라우저 정리 통과 |
| 실행 중 화면 파일 비교 | 앱 JS·AI UI JS·CSS 모두 현재 검증 소스와 일치 |

조건부 제외는 해당 환경이 없는 검사를 뜻하며 통과에 포함하지 않는다. 최종 실제 검증의 브라우저 오류와 예상 밖 요청은 0건이었다.

로컬 증거는 Git에서 제외된 `test-results/prototype-openai-live-4c2225df-b9ac-4520-b9b0-926c3443f14e/`의 `live-result.json`, `report.json`, `source-and-tests.json`과 합성 화면이다. 보고서는 키·비밀번호·요청 본문을 저장하지 않고 상태 코드·응답 길이·해시를 남긴다. 별도 정적 파일 확인의 최초 잘못된 URL 경로(404)는 `asset-check-wrong-path.json`에 보존했고, 서버에 정의된 `/local-api/` 경로로 확인한 최종 결과는 모두 200 및 일치다.

## 범위와 다음 단계

자유 대화는 입력 질문과 최근 AI 대화만 전달한다. 기록 요약은 확인한 활동·반응 두 항목만 전달하고, 적용·저장·공유는 사용자가 결정한다. 실제 개인정보·아동 자료는 사용하지 않았으며, 물리적 아이폰이나 공개 서비스 운영을 검증한 결과가 아니다.

녹음 샘플 정리는 기존 예시 모드로 유지했다. 이번 요청은 홈 AI 연결이며 녹음 처리 범위를 함께 변경하지 않았다. 이 실제 응답 검증은 로컬 앱 기준이며 GitHub 소스 게시나 공개 서비스 배포 성공을 뜻하지 않는다. 다음 확인은 현재 실제 AI 세션에서 가상 질문을 직접 사용하며 답변의 길이·표현을 평가하는 것이다.

## GitHub 게시 전 확인 — 2026-11-17

후속 소스 게시 요청에 맞춰 변경 파일과 가상 샘플을 검토했다. 실제 키·개인정보·로컬 시험 로그는 게시 대상에 포함하지 않는다. 고정 PNG·MP4와 가상 음성 WAV는 승인된 샘플과 해시가 일치한다.

서버 개발 의존성이 없는 깨끗한 사본에서 새 실행기 테스트의 정적 DB import 때문에 초기 빌드 조건이 실패했다. `scripts/prototype.mjs`와 `scripts/prototype-openai.mjs`가 실제 세션을 생성할 때만 sandbox를 불러오도록 수정했다. 검사를 제외하거나 DB 의존성을 정적 프런트 빌드에 추가하지 않았다.

같은 사본에서 `npm ci --ignore-scripts --no-audit --no-fund`, `npm test`(1,983 통과·실패 0·조건부 제외 76), `npm run build`를 다시 실행해 모두 성공했다. 정적 출력은 37파일이다. 두 기본 실행기의 가상 세션 시작·종료도 추가 모델 호출 없이 확인했다. 상세 로그는 로컬 `test-results/github-clean-build-545702d0-6933-469f-84a2-c6a3497b53ac/`에 보존한다. Vercel 정적 출력은 여전히 기존 `src/`이며 최신 로컬 AI 서버를 공개 운영하는 배포가 아니다.
