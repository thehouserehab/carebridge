# Carebridge 배포 안내

## 구성

- 런타임 의존성이 없는 HTML/CSS/JavaScript 정적 앱이다.
- `server/`에는 PostgreSQL 저장·인증 패키지가 있다. 현재 정적 출력에는 포함되지 않으며 Vercel 정적 배포에서 운영 API로 배포하지 않는다. 서버 변경은 별도로 `npm --prefix server ci --ignore-scripts`와 `npm run test:server`를 실행한다.
- Node.js 24, `npm ci --ignore-scripts`, `npm test && npm run build`, 출력 `dist/`를 사용한다.
- Vercel 프로젝트는 이 저장소의 `main`을 Production Branch로 사용한다.
- `vercel.json`에 로컬과 같은 CSP를 정의하고 blob 이미지·영상만 허용한다. 클릭재킹·MIME 추측을 제한하고 검색엔진 색인을 요청하지 않는다. noindex는 접근 제어가 아니다.
- 배포에는 코드와 가상 초기 데이터만 포함한다. 브라우저 localStorage/IndexedDB 내용은 GitHub나 Vercel로 업로드되지 않는다.

## 확인

1. `npm ci --ignore-scripts`, `npm run check`, `npm test`, `npm run build`를 실행한다.
2. 배포 URL에서 제목 Carebridge, 역할 전환, 기록 저장→공유→피드백 흐름을 확인한다.
3. 가상 사진·영상 첨부, 새로고침, 공유 제외를 확인한다. 실제 아동정보를 입력하지 않는다.
4. `/README.md`, `/docs/deployment.md`, `/.env`, `/tests/domain.test.mjs`가 404인지 확인한다.
5. HTTP 보안 헤더, 모바일 가로 넘침, JavaScript 오류를 확인한다.

### 2026-10-10 서버 의존성 없는 정적 빌드 확인

루트 설치만 수행하는 새 빌드에서는 `synthetic-e-resume-cli.test.mjs`가 E 실행기를 import할 때 서버 전용 `pg`까지 정적으로 읽어 `ERR_MODULE_NOT_FOUND`로 실패했다. `scripts/synthetic-e-api.mjs`에서 인자·TTY 확인 후 실제 실행에만 서버 모듈을 지연 로드하도록 수정했다. 로딩 중 취소·TTY 종료·실패의 정리와 기존 재개 동작을 포함한 관련 21개 검사를 통과했다. 서버 의존성이나 정적 배포 대상을 확대하지 않았다.

별도의 현재 소스 사본에서 서버 `node_modules` 없이 `npm ci --ignore-scripts --no-audit --no-fund` → `npm test` **1,368/1,368** → `npm run build`를 실행해 모두 종료 0을 확인했다. 출력의 `server/`·`local-api/`는 없으며 결과는 `test-results/static-clean-build-20261010.log`에 보존했다. Windows/Node 24의 깨끗한 로컬 빌드 증거이며 Vercel 원격 빌드·배포 완료나 실제 E 세션 재실행을 의미하지 않는다.

## 복구 및 운영 한계

배포 문제가 있으면 Vercel의 이전 정상 배포로 되돌리거나 해당 Git 변경을 revert한다. 브랜치 강제 푸시 없이 과거 커밋을 유지한다. 코드 롤백은 브라우저 데이터를 복구하지 않는다.

별도 로컬 시험판에는 인증·초대/담당 관계·대화 HTTP API·E 파일 저장이 연결되어 있다([최신 범위](communication-acceptance.md)). 이 기능은 정적 `dist/`에 포함되지 않으므로 Vercel에 정적 앱을 배포해도 다른 기기와 실제 자료를 주고받는 서비스가 되지는 않는다. 실물 기기 전달/재접속·사람 검증, 실제 메일 전달, 운영 계정·서비스 경계와 독립 백업 등은 별도 수용 조건이다. 정적 배포의 역할 전환은 인증이 아니며 실제 아동정보를 입력하면 안 된다. 이 단계에서 운영 배포나 네트워크·인증서 설정은 변경하지 않았다.
