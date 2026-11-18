# Carebridge 배포 안내

## 구성

- HTML/CSS/JavaScript 화면과 `api/ai/`, `api/chat/`의 Node.js Vercel Functions로 구성한다. AI 함수는 기존 OpenAI provider를, 공용 대화 함수는 기존 인증·대화 서비스와 공용 PostgreSQL을 사용한다.
- `local-api/`와 `server/`의 PostgreSQL 저장·기존 계정 인증·대화·첨부 API는 별도 로컬 환경이다. 이를 Vercel 운영 API로 배포하지 않는다. 해당 서버 변경은 별도로 `npm --prefix server ci --ignore-scripts`와 `npm run test:server`를 실행한다.
- Node.js 24, `npm ci --ignore-scripts`, `npm test && npm run build`, 출력 `dist/`를 사용한다.
- Vercel 프로젝트는 이 저장소의 `main`을 Production Branch로 사용한다.
- `vercel.json`에 로컬과 같은 CSP를 정의하고 blob 이미지·영상만 허용한다. 클릭재킹·MIME 추측을 제한하고 검색엔진 색인을 요청하지 않는다. noindex는 접근 제어가 아니다.
- 배포에는 코드와 가상 초기 데이터만 포함한다. 브라우저 기록·첨부 저장소 전체를 GitHub나 Vercel로 업로드하지 않는다. AI 요청 시에는 사용자가 직접 전송한 질문·최근 AI 대화 또는 미리 확인한 활동·반응 두 항목만 서버를 거쳐 OpenAI로 전달한다.
- 웹 AI는 별도 체험 코드 세션을 사용한다. 서버 환경변수·쿠키·입력 제한과 가상 자료 검수 절차는 [웹 AI 배포 구성](web-ai-deployment.md)을 따른다. 이 문서는 구성 안내이며 실제 배포·실제 모델 응답 성공 기록은 아니다.
- 공용 텍스트 대화는 [웹 공용 대화 시연](shared-chat-demo.md)의 별도 계정·DB·HTTPS 어댑터로 제공한다. 기존 로컬 전용 HTTP 어댑터의 접속 제한은 유지한다. 웹 빌드가 로그인 정보를 포함하거나 DB를 자동 초기화하지 않는다.

## 확인

1. `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run build`를 실행한다.
2. 배포 URL에서 제목 Carebridge, 역할 전환, 기록 저장→공유→피드백 흐름을 확인한다.
3. 가상 사진·영상 첨부, 새로고침, 공유 제외를 확인한다. 실제 아동정보를 입력하지 않는다.
4. `/README.md`, `/docs/deployment.md`, `/.env`, `/tests/domain.test.mjs`가 404인지 확인한다.
5. HTTP 보안 헤더, 모바일 가로 넘침, JavaScript 오류를 확인한다.
6. [웹 AI 확인 항목](web-ai-deployment.md#배포-확인)을 가상 자료로 수행한다. 서버 환경변수와 접근 코드가 없을 때 실제 모델을 호출하지 않는지도 확인한다.

### 2026-10-10 서버 의존성 없는 정적 빌드 확인

루트 설치만 수행하는 새 빌드에서는 `synthetic-e-resume-cli.test.mjs`가 E 실행기를 import할 때 서버 전용 `pg`까지 정적으로 읽어 `ERR_MODULE_NOT_FOUND`로 실패했다. `scripts/synthetic-e-api.mjs`에서 인자·TTY 확인 후 실제 실행에만 서버 모듈을 지연 로드하도록 수정했다. 로딩 중 취소·TTY 종료·실패의 정리와 기존 재개 동작을 포함한 관련 21개 검사를 통과했다. 서버 의존성이나 정적 배포 대상을 확대하지 않았다.

별도의 현재 소스 사본에서 서버 `node_modules` 없이 `npm ci --ignore-scripts --no-audit --no-fund` → `npm test` **1,368/1,368** → `npm run build`를 실행해 모두 종료 0을 확인했다. 출력의 `server/`·`local-api/`는 없으며 결과는 `test-results/static-clean-build-20261010.log`에 보존했다. Windows/Node 24의 깨끗한 로컬 빌드 증거이며 Vercel 원격 빌드·배포 완료나 실제 E 세션 재실행을 의미하지 않는다.

## 복구 및 운영 한계

배포 문제가 있으면 Vercel의 이전 정상 배포로 되돌리거나 해당 Git 변경을 revert한다. 브랜치 강제 푸시 없이 과거 커밋을 유지한다. 코드 롤백은 브라우저 데이터를 복구하지 않는다.

별도 로컬 시험판에는 인증·초대/담당 관계·대화 HTTP API·E 파일 저장이 연결되어 있다([최신 범위](communication-acceptance.md)). 공개 웹의 공용 텍스트 대화와 별개로, 기록·첨부의 기기 간 전달, 실제 메일 전달, 운영 계정과 독립 백업은 추가 준비가 필요하다. 정적 화면의 역할 전환은 인증이 아니며, AI 체험 코드도 공용 대화 계정을 대신하지 않는다. 실제 아동정보를 입력하면 안 된다.
