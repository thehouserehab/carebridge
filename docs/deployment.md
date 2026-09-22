# Carebridge 배포 안내

## 구성

- 런타임 의존성이 없는 HTML/CSS/JavaScript 정적 앱이다.
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

## 복구 및 운영 한계

배포 문제가 있으면 Vercel의 이전 정상 배포로 되돌리거나 해당 Git 변경을 revert한다. 브랜치 강제 푸시 없이 과거 커밋을 유지한다. 코드 롤백은 브라우저 데이터를 복구하지 않는다.

실제 인증, 계정별 서버 접근 통제, 서버 파일 저장, 기기 간 동기화, 중앙 백업, 감사·삭제 정책은 구현되지 않았다. 화면 역할 전환만으로 개인정보를 보호할 수 없다. 정적 배포이므로 서버 함수 로그 기반 오류 모니터링은 적용되지 않으며, 실제 운영 전 브라우저 오류 수집·동의·보안 설계가 필요하다.
