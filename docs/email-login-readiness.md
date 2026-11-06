# 이메일 인증 로그인과 관리자 역할 적용 — 준비 상태

작성: 2026-10-11 KST. 이 문서는 운영 활성화 완료 보고서가 아니다.

## 현재 상태

- 공개 Vercel 사이트는 기존 가상 자료 체험판이다. 이번 단계에서 공개 소스·배포·환경변수·실제 계정·DNS를 변경하지 않았다.
- 기존 Node/PostgreSQL `Auth`와 센터 소속을 재사용하는 이메일 코드 서비스를 **새 메모리 DB의 합성 루프백 실행기**에 연결했다. 코드 요청→프로세스 내부 시험 메일함→코드 입력→기존 세션→서버 역할/승인 대기→로그아웃을 검증했다. 공개 HTTP·실제 메일·E 실행기에는 연결하지 않았다.
- 로컬 API의 비밀번호/이메일 코드 로그인 모두 역할이 없는 계정은 승인 대기로 진입한다. 화면에는 승인 상태 확인과 로그아웃만 있고 아동·대화·기록 메뉴나 역할 선택은 없다.
- 서버가 반환한 현재 역할만 화면에 반영한다. 승인된 보호자 역할이 있어도 별도 아동 관계가 없으면 아동 정보는 보이지 않는다.
- 기존 관리자 초대는 같은 센터의 치료사/보호자 역할만 부여하며 감사 기록을 남긴다. 이번에 관리자 생성·승격 또는 기존 역할 변경 API를 새로 제공하지 않았다.

인증·백엔드 스킬에 따라 이메일 소유 확인과 센터/아동 접근 권한을 분리하고 기존 인증 구조를 유지했다. 별도 공급자·의존성은 추가하지 않았다. 검증 스킬에 따라 화면→세션 API→현재 DB 역할→화면 전환까지 가상 환경에서 확인했다.

## 2026-10-11 로컬 가상 이메일 연결 단계

### 변경 파일과 이유

| 파일 | 변경과 범위 |
| --- | --- |
| `server/local-email-login.mjs` | 기존 `EmailLogin`을 감싼 메모리 큐·시험 메일함·브라우저 nonce·같은 요청 재확인·로그아웃 경쟁 처리 |
| `server/local-api-http.mjs` | 정확한 POST start/request/verify와 HttpOnly nonce 쿠키. 기존 Host/Origin/CSRF/세션 경계를 유지하고 입력은 1KiB로 제한 |
| `server/local-api-listener.mjs` | 동일 Auth 인스턴스의 명시적 시험 서비스가 있을 때만 이메일 화면 표식·모듈·API 활성화 |
| `server/local-api-sandbox.mjs` | 새로 소유한 메모리 PGlite에만 SQL 제안 적용, 임시 키와 내부 전달 기능 생성/종료 |
| `server/email-login.mjs` | 현재 연결 범위를 설명하는 주석만 수정. 기존 인증 알고리즘 재사용 |
| `local-api/email-login-client.js`, `email-login-ui.js` | .test 이메일·8자리 코드 입력, 동일 요청 재시도, 60초 재요청 안내, 숨김/폐기·늦은 응답 처리 |
| `local-api/client.js`, `app.js` | 쿠키 기반 코드 로그인 응답을 검증한 뒤 기존 역할 화면과 연결. 역할/센터 선택값을 신원으로 보내지 않음 |
| `scripts/local-api.mjs` | 대화형 터미널에서만 `mail guardian`, `mail therapist`, `mail center`로 시험 코드 확인. Ctrl+C/입력 종료 시 서버 종료 |
| `server/tests/local-email-login-http.test.mjs`, `tests/local-email-login-ui.test.mjs` | 새 HTTP 18개·클라이언트/화면 13개 시험 |
| `server/tests/local-api-listener.test.mjs`, `local-api-sandbox.test.mjs` | 서비스 없는 실행기의 모듈 비공개와 가상 실행기의 조건부 자산 제공 확인 |
| 이 문서, `docs/communication-acceptance.md` | 현재 완료 경계와 시험 증거 갱신 |

### 보안 경계

- nonce는 서버가 발급하고 HttpOnly·SameSite=Strict·`/api/local/` 쿠키로만 전달한다. localhost HTTP 시험이므로 Secure 쿠키/운영 HTTPS 검증이라고 주장하지 않는다.
- 요청 응답은 계정 조회·전달을 기다리지 않는 공통 접수 안내다. 없는/잠긴/비활성 계정, 발급 제한, 전달 실패에서 계정 생성이나 역할 자동 부여가 없다. 발송 완료를 보장하는 문구를 쓰지 않는다.
- 같은 브라우저의 같은 요청 ID는 중복 발급하지 않는다. 응답 유실 시 입력했던 동일 코드만 다시 검증한다. 다른 로그인 세션을 덮어쓰지 않는다. 코드 검증 중 로그아웃이 먼저 완료되면 늦게 생성된 세션도 폐기한다.
- 코드는 기존 10분·5회·60초/시간당 3회 정책을 따른다. 추가 제한은 프로세스 내 nonce 64개, 진행 항목 128개, 대기열 16개, 1분 접수 32개다. 분산/공개 서비스용 공격 방어가 아니다.
- 코드·키·nonce·시험 전달 정보는 프로세스 메모리에만 둔다. 늦은 성공 응답을 로그아웃할 수 있도록 항목 수명 동안 세션 토큰 참조도 내부에 보관한다. 비열거 속성은 실수 방지일 뿐 암호화·RAM 소거·디버거 보호가 아니다. HTTP 메일함·토큰 JSON 응답·localStorage 저장은 없다.
- SQL 파일은 여전히 `schema-proposals`에 있다. 번호형 마이그레이션은 22개 그대로이며 E/native/운영 DB에는 적용하지 않았다. 프로세스 재시작 후 이메일 인증/계정 재개는 이번 시험의 기능이 아니다.

### 최종 검증

프로젝트 루트에서 다음을 실행했다. 최종 **280/280 통과**, 실패·취소·누락 0. 새 테스트 31개와 기존 코드 인증·비밀번호·복구·초대·리스너·가상 실행기·권한/제품 UI 회귀를 포함한다. 로그: `test-results/local-email-login-regression-20261011.tap`.

```powershell
node --test --test-reporter=tap --test-concurrency=1 server/tests/local-email-login-http.test.mjs server/tests/email-login.test.mjs server/tests/auth.test.mjs server/tests/auth-password-change.test.mjs server/tests/auth-password-recovery.test.mjs server/tests/local-invitations-http.test.mjs server/tests/local-api-listener.test.mjs server/tests/local-api-sandbox.test.mjs server/tests/local-api-http.test.mjs server/tests/local-recovery-http.test.mjs tests/local-email-login-ui.test.mjs tests/local-api-client.test.mjs tests/local-approval-pending-ui.test.mjs tests/local-product-ui.test.mjs tests/local-recovery-ui.test.mjs
node scripts/check.mjs
node scripts/build.mjs
git diff --check
```

문법·빌드·diff 검사 종료 코드 0. Git의 기존 LF→CRLF 경고만 있었다. 공개 `src`, `index.html`, `vercel.json`은 변경하지 않았고 HEAD `9eb252df4167276f2924ef2464af915e2b8a1c16` 유지, 커밋·push·배포 없음.

실제 브라우저 증거:

1. 가상 보호자: 이메일 요청→내부 메일함 코드 확인→잘못된 코드 거부→정상 코드→보호자 홈→로그아웃.
2. 소속 없는 가상 계정: 이메일 요청→코드→승인 대기. 보호 메뉴·역할 선택 없음. 로그아웃 정상.
3. 최종 소스의 일반 대화형 실행기에서도 `mail guardian`으로 받은 코드로 보호자 홈→로그아웃을 재검증했다. 출력·전달은 .test 가상 계정에 한정했다.
4. 브라우저 경고/오류 기록 없음. 390×844 뷰포트 설정에서 스크롤바를 제외한 문서 폭/scrollWidth 모두 375px, 카드 좌우 14px/361.2px로 가로 넘침 없음. 실제 iPhone/Safari 시험은 아니다.
5. 화면: `test-results/email-code-pending-20261011.jpg`, `email-code-guardian-final-20261011.jpg`. 앞의 메모리 fixture는 명시 종료, 일반 실행기는 Ctrl+C로 종료 코드 0을 확인했다. 두 소유 포트의 LISTEN 없음, 시험 탭 종료와 뷰포트 복구 완료. 정상 종료에서 시험 계정·메모리 DB와 소유한 임시 격리 파일을 정리했다. 사용자의 기존 자료는 지우지 않았다.

### 다시 확인하는 방법

프로젝트 루트의 대화형 터미널에서 `node scripts/local-api.mjs --confirm-synthetic-local --port=0` 실행→출력된 주소 접속→‘가상 이메일 인증번호로 로그인’→터미널에 표시된 .test 계정 입력→같은 터미널에서 `mail guardian` 등 해당 역할 명령→코드 입력. 종료는 Ctrl+C. 실제 주소/자료/비밀번호는 사용하지 않는다. 신규 실행마다 시험 계정이 달라지고 종료 시 사라진다.

운영 공급자·계정 입력 없이 수행할 수 있는 **이번 가상 연결 단계는 완료**다. 실제 발송/독립 백업/운영 DB·키 수명/감사·보존/native 다중 연결 경합/공개 HTTPS/최초 관리자 승인/실물 두 기기 시험은 완료하지 않았다. 아이폰 IP 미확인은 이 가상 구현을 막지 않았으며 LAN·방화벽·인증서 설정은 그대로 두었다. 다음은 가상 흐름 변경 없이 실물 시험의 정확한 기기·HTTPS 범위를 확정하는 단계다.

## 이전 내부 서비스 단계의 코드와 보안 계약

| 파일 | 변경 내용 |
| --- | --- |
| `server/email-login.mjs` | 기존 계정용 코드 발급 준비·검증·기존 Auth 세션 발급. 운영 진입점에서 import하지 않음 |
| `server/schema-proposals/email-login.sql` | 검토용 SQL. 자동 마이그레이션 경로 밖에 두며 E/운영 DB에는 적용하지 않음 |
| `server/tests/email-login.test.mjs` | 메모리 PGlite 기반 25개 인증·권한·경계 테스트 |
| `local-api/approval-pending-ui.js`, `local-api/app.js` | 역할 없음→승인 대기, 같은 계정의 서버 역할 재조회→허용 화면, 로그아웃/중단/늦은 응답 무효화 |
| `server/local-api-listener.mjs` | 새 화면 모듈을 기존 고정 정적 자산 목록에 추가. 새 API나 공개 접속 추가 없음 |
| `tests/local-approval-pending-ui.test.mjs`, `server/tests/local-api-listener.test.mjs` | 승인 대기 컨트롤러 10개 테스트와 정적 모듈 접근 회귀 검사 |

`EmailLogin.prepare({ email }, browserNonce)`와 `verify({ challenge, code }, browserNonce)`만 제공한다. 역할·센터·사용자 ID·redirect 등을 추가 입력하면 거부한다. nonce는 향후 신뢰하는 HTTP 경계가 발급·보호해야 하며 요청 JSON의 사용자 입력으로 대신하면 안 된다.

- 코드는 8자리, 유효 시간 최대 10분, 5회 실패 시 사용 불가다. 계정별 60초 재발급 간격과 시간당 3회 발급 제한을 DB에서 검사한다.
- 재발급은 이전 미사용 코드를 무효화한다. 이메일·비밀번호 변경과 계정 비활성화도 미사용 코드를 무효화한다. 비밀번호 잠금을 우회하지 않는다.
- DB에는 코드와 브라우저 nonce 원문이 아닌 서버 전용 키를 사용하는 HMAC을 저장한다. 키는 32바이트를 주입해야 하며 기본 키·환경변수 대체값은 없다. 시험 키는 메모리에만 생성했다.
- 코드 소비와 세션 발급은 하나의 트랜잭션이다. 소비 순간 DB 시계가 만료를 넘은 경우도 실패로 처리한다.
- 성공 응답 유실은 같은 브라우저·같은 코드로 30초 이내 같은 기존 세션을 재확인할 수 있다. 새 세션 생성이나 만료 연장을 하지 않으며 로그아웃한 세션은 살리지 않는다.
- 역할은 기존 `Auth.authenticate`가 매번 현재 활성 센터 소속에서 조회한다. 코드 인증은 계정·센터·아동 관계를 자동 생성하거나 재활성화하지 않는다.
- 전달 주소·코드·세션 토큰은 일반 JSON에서 빠지는 비열거 속성이다. 이는 실수 방지 장치이지 암호화나 메모리/로그 유출 방지 보장이 아니다. 명시적으로 읽는 내부 코드가 외부 응답·로그에 넣지 않아야 한다.
- 유효 요청의 공통 응답 형태만 구현했다. 공개 요청의 시간 차이, 전체 요청 제한, 비동기 발송과 전달 실패 처리까지 해결한 것은 아니다.

## 이전 내부 서비스 단계의 검증 증거

1. `server` 디렉터리에서 실행:

   `node --test --test-concurrency=1 tests/email-login.test.mjs tests/auth.test.mjs tests/auth-password-change.test.mjs tests/auth-password-recovery.test.mjs tests/local-invitations-http.test.mjs tests/local-api-http.test.mjs`

   **127/127 통과**. 새 인증 25개 포함. 기록: `test-results/email-login-auth-regression-20261010.tap`.

2. 프로젝트 루트에서 실행:

   `node --test --test-concurrency=1 tests/local-approval-pending-ui.test.mjs tests/local-product-ui.test.mjs tests/local-api-client.test.mjs server/tests/local-api-listener.test.mjs`

   **75/75 통과**. 기록: `test-results/email-login-pending-ui-regression-20261010.tap`.

3. 로컬 메모리 DB와 `.test` 가상 계정으로 실제 브라우저 확인:
   - 기존 비밀번호 로그인→승인 대기. 보호 메뉴·자기 역할 선택 없음.
   - 승인 대기에서 로그아웃→로그인 화면. 다시 로그인해도 역할이 없으면 대기.
   - 시험 DB fixture에서만 보호자 소속 추가→동일 세션 재조회→보호자 홈. 아동 관계는 추가하지 않아 ‘연결된 아동이 없습니다’ 표시.
   - 역할 적용 뒤 로그아웃 정상. 브라우저 오류/경고 기록 없음.
   - 데스크톱 화면 확인. 390px 뷰포트의 DOM `clientWidth`와 `scrollWidth` 모두 390, 카드 왼쪽 14px·오른쪽 약 376.4px로 가로 넘침 없음. 실물 iPhone/Safari 검증은 아니다.
   - 이미지: `test-results/approval-pending-desktop-20261010.jpg`, `test-results/approval-assigned-no-child-20261010.jpg`. 모바일 캡처는 도구의 축소 출력이므로 가독성 증거로 사용하지 않고 DOM 치수만 기록한다.
   - 시험 프로세스와 두 시험 포트의 종료를 재확인했다. 운영 계정·E DB를 사용하지 않았다.

4. `node scripts/check.mjs`, `node scripts/build.mjs`, `git diff --check` 모두 종료 코드 0. 정적 빌드는 `dist`에 생성했으며 배포하지 않았다. 공개 `src`, `index.html`, `vercel.json` 변경 없음과 HEAD `9eb252df4167276f2924ef2464af915e2b8a1c16` 유지도 확인했다. Git 검사는 기존 작업 파일의 LF→CRLF 경고만 출력했다.

PGlite는 실제 SQL을 실행하지만 단일 프로세스 시험이다. 동시 요청 테스트를 native PostgreSQL의 다중 연결 경합 검증으로 주장하지 않는다. 위 브라우저 검증은 **기존 비밀번호 로그인과 승인 대기 UI** 증거이며, 이메일 발송→코드 입력→로그인 전체 흐름의 증거가 아니다.

## 공급자 확인 상태와 추천

Vercel 연결 도구의 읽기 전용 조회에서 다음을 확인하지 못했다. 비밀값을 복호화하지 않았고 권한 오류를 다른 경로로 우회하지 않았다.

| 조회 | 실제 결과 | 의미 |
| --- | --- | --- |
| 프로젝트 환경변수 목록, 복호화 끔 | 403 Forbidden | 기존 메일 설정 존재 여부 미확인 |
| 프로젝트 통합 목록 | 403 Forbidden | 기존 공급자 통합 미확인 |
| 프로젝트 커넥터 연결 | 404 | 해당 도구에서 연결 목록을 확인하지 못함. 공급자 부재의 증거로 사용하지 않음 |

기존 서비스가 없다면 국내 후보는 **네이버 클라우드 SENS MAIL** 하나를 우선 검토한다. Cloud Outbound Mailer는 2026-09-17 SENS에 통합됐고 신규 프로젝트는 통합 API 대상이다. 한국 리전 MAIL을 제공하며 무료 구간 초과 발송 건수에 과금한다. 현재 확정 단가는 검증하지 못했으므로 이전 단가를 견적으로 사용하지 않는다. [통합 안내](https://guide.ncloud-docs.com/docs/sens-integrationguide), [지원 기능·과금 기준](https://guide.ncloud-docs.com/docs/sens-spec).

발신 도메인 소유권·SPF·DKIM과 DMARC 정책 검토가 필요하다. 기존 DNS 레코드를 덮어쓰지 않아야 한다. [발신 도메인 관리](https://guide.ncloud-docs.com/docs/cloudoutboundmailer-use-domain).

휴대전화 인증은 SMS 발송비, 발신번호 등록, 번호 변경·재사용 대응이 추가된다. 현 단계는 이메일 우선이며 SMS를 중복 구현하지 않았다. 이메일 코드는 신분·임상 자격 증명이 아니고 다중 요소 인증도 아니다. 메일함 침해·피싱 위험이 있어 관리자의 고위험 권한 변경에는 별도 강화 인증 검토가 필요하다.

## 활성화 전 남은 일과 필요한 입력

우선순위 순서:

1. **사용자 입력:** 기존 메일 공급자 유무/서비스명, 발신 주소·관리 가능한 도메인, 국내 인증 API·영속 DB 운영 위치, 최초 관리자 대상과 승인 방식. 키·비밀번호는 대화에 보내지 않는다.
2. **운영 승인:** 공급자 프로젝트/유료 이용/최소 권한 키 생성·서버 비밀 저장·DNS 설정은 정확한 범위를 확인한 뒤 별도 승인한다. 실제 발송은 정확한 시험 수신자와 발송 동의가 있어야 한다. 아직 어느 것도 실행하지 않았다.
3. **운영 서버 연결:** 위 가상 화면·HttpOnly nonce·Origin/CSRF·입력 제한·오류 정규화는 로컬 연결 완료다. 운영 HTTPS·분산 전체 제한·계정 열거 방지, 실제 메일 큐의 비밀 보존·중복·실패·지연·재시도·파기 정책과 전송 어댑터는 별도 검증한다. 메모리 시험 큐를 운영 발송자로 전용하지 않는다.
4. **DB 운영 편입:** SQL 제안의 최소 권한·백업/복구 manifest·보존/정리·보안 사건 감사·native PostgreSQL 경합 검증을 완료한 뒤 마이그레이션으로 승격한다. 제안 파일을 그대로 E/운영에 수동 적용하지 않는다.
5. **역할 운영:** 기존 초대 기반 최초 부여를 재사용한다. 이미 임상 참여 이력이 있는 계정의 역할 변경은 관계의 외래키와 기록 보존을 함께 처리하는 별도 API/관리 UI가 필요하다. 단순 role UPDATE나 과거 관계 삭제로 구현하지 않는다. 최초 관리자 자동 승격은 금지한다.
6. **최종 검증/배포:** 승인된 시험 메일의 수신·만료·실패·재발송·로그아웃, 역할 없는 계정/센터 간 격리/관리자 변경, 실제 기기 간 재접속을 검증한다. 공개 체험판 역할 선택을 실서비스 로그인으로 전환하는 것은 이 연결 이후 단계다.

국내 메일 공급자만 선택한다고 전체 국내 통제가 보장되지 않는다. 수신 메일 사업자, 메일 처리·로그 보존, 글로벌 Vercel 프런트와 국내 API의 경계를 별도로 확인해야 한다. 아동·치료 자료는 인증 메일에 넣지 않는다. 독립 백업이 준비되지 않은 실제 아동 자료 수집·공개 접속 보류는 유지한다.
