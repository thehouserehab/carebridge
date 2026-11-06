# Carebridge 계정 보안 사건 기록 — 비API 준비

2026-10-08 추가 후속: [내부 비밀번호 분실 복구](password-recovery.md)의 신규021·권한 v5에서 `password.recovered` 사건을 추가했다. 이 사건만 폐기 세션 0건을 허용하며, 기존 두 사건의 양수 조건은 유지한다. 아래는 도입 당시 기록이고 공개 복구·메일·화면 연결은 아직 아니다.

2026-10-08. 비밀번호 변경과 전체 세션 폐기의 **최소 보안 기록 구성요소**를 추가했다. 실제 계정 운영·비밀번호 분실 복구·알림·HTTP/화면 연결 완료가 아니다. 독립 백업 매체가 아직 없으므로 실제 아동 자료 수집과 외부 접속은 계속 보류한다. API는 마지막에 연결한다.

## 현재 상태와 변경 이유

[직전 비밀번호 변경 구현](password-change.md)은 해시·변경 시각·모든 기존 세션 폐기를 원자적으로 처리했지만, 그 성공을 별도로 보존하는 계정 공통 기록은 없었다. 기존 센터/초대 감사 테이블에 임의 센터를 붙이면 여러 센터에 속한 계정의 사건을 잘못 귀속할 수 있어 새 전역 테이블을 분리했다.

인증·백엔드 스킬의 서버 자격 재확인과 책임 분리 원칙을 적용했다. 국내 E·기존 Node/pg 구조를 유지하며 새 클라우드·인증 공급자·의존성은 추가하지 않았다. 기록에서 비밀번호·세션 토큰·건강 원문을 제외하고 별도 접근 통제를 두는 방향은 [OWASP Logging 지침](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)을 참고했다. 아래의 트랜잭션 실패 정책은 이 두 보안 변경에 대한 프로젝트의 선택이며, 모든 일반 로그 실패가 서비스를 중단해야 한다는 지침으로 해석하지 않는다.

## 저장 계약과 원자성

신규 [019 마이그레이션](../server/migrations/019-account-security-events.sql)은 `public.cb_account_security_events`만 추가한다. 001~018 원문은 바꾸지 않았고, 기존 사용자/계정/세션을 변환하거나 과거 사건을 임의로 만들지 않는다. 업그레이드 직후 사건 테이블은 비어 있다.

| 필드 | 저장 범위 |
| --- | --- |
| `id` | 무작위 UUID v4 사건 ID |
| `user_id` | 영향을 받은 계정의 내부 식별자. 이메일/표시 이름이 아님 |
| `action` | `password.changed` 또는 `sessions.revoked`만 허용 |
| `revoked_sessions` | 이번 UPDATE로 폐기한 미폐기 세션 행 수. 만료되었지만 아직 폐기 표시가 없던 행도 포함하며, 현재 접속 기기 수가 아님 |
| `occurred_at` | INSERT 시 DB `clock_timestamp()`로 확정. 호출자가 제출한 시각은 사용하지 않음 |

비밀번호·해시·원문 토큰·세션 ID/목록·이메일·IP·브라우저 정보·센터/아동/임상 원문·자유 서술은 저장하지 않는다. 식별자는 다른 내부 자료와 연결될 수 있는 가명 정보이므로 익명 데이터라고 하지 않는다.

| 내부 명령 | 성공 기록과 실패 동작 |
| --- | --- |
| `Auth.changePassword` | 실제 미만료 서버 세션·활성 계정·현재 비밀번호를 확인한 뒤 새 해시/시각·실패 상태 초기화·전체 세션 폐기·`password.changed` 1개를 같은 트랜잭션에서 커밋 |
| `Auth.revokeAll` | 계정→세션 잠금 순서를 유지하고 실제 변경 행이 있을 때 `sessions.revoked` 1개를 같은 트랜잭션에서 저장. 변경 0건이면 사건도 0개 |

기록 쓰기가 실패하면 해당 비밀번호/세션 변경도 롤백한다. 보안 변경이 성공했는데 기록만 빠지는 상태를 허용하지 않는 대신, 기록 테이블의 장애/권한 누락은 이 두 명령의 가용성에 영향을 준다. 외부 로그 서버를 기다리는 구조가 아니라 같은 DB의 짧은 INSERT이며 기존 응답 형식은 유지한다. 운영 모니터링은 별도로 필요하다.

틀린 현재 비밀번호, 동일 비밀번호, 만료/폐기 세션은 변경 성공 사건을 만들지 않는다. 커밋 응답 유실을 자동 재시도하거나 성공으로 간주하지 않는다. 커밋된 변경은 이전 세션을 폐기하므로 같은 세션 재요청으로 두 번째 사건을 만들지 않는다. 개별 로그아웃·로그인 실패·복원 격리의 직접 SQL까지 이 두 사건으로 포괄한다고 하지 않는다.

`user_id`는 **변경 대상**이지 검증된 운영자 ID가 아니다. 특히 `revokeAll`은 기존 내부 원시 기능이며 호출자 권한 확인을 대신하지 않는다. 공개 관리 API/행위자 감사가 필요하면 별도 승인 경계를 설계해야 한다.

## 보존·최소 권한·업그레이드

사건은 사용자/계정 FK를 두지 않는다. 계정 행 삭제가 사건 삭제로 연쇄되거나 다른 신원 수명주기를 막지 않게 하려는 의도다. 합성 계정/세션/사용자 삭제 뒤에도 사건이 남는 것을 검증했다. 삭제 이후에도 남는 식별자의 보존 기간·파기 책임·ID 재사용 금지 운영 정책은 실제 서비스 전에 확정해야 한다.

일반 INSERT의 시각은 trigger가 DB 시간으로 확정하며 UPDATE/DELETE와 빈 테이블을 포함한 TRUNCATE는 거부한다. trigger는 invoker 방식이며 고정 검색 경로, 동적 SQL 없음, 권한 상승/다른 원문 조회 없음이다. [PostgreSQL trigger](https://www.postgresql.org/docs/18/sql-createtrigger.html)와 [권한](https://www.postgresql.org/docs/18/ddl-priv.html)의 경계를 따른다. DB 소유자/슈퍼유저가 trigger나 스키마를 바꿀 수 있으므로 암호학적 불변 원장 또는 외부 변조 방지 증거는 아니다.

권한 정책은 **v3 / 다섯 역할 / 테이블 55개 / 함수 43개 / sequence 2개**로 갱신했다. 앱 helper 허용 목록과 기존 worker/임상 제한은 유지한다.

| 역할 | 새 사건 테이블 권한 |
| --- | --- |
| migration 소유자 | 명시적 schema/권한 관리. 사용자 요청 처리에 사용하지 않음 |
| 앱 runtime | INSERT만. SELECT·UPDATE·DELETE·TRUNCATE와 guard 직접 실행 없음 |
| 백업 | SELECT만. 인증/임상 자료도 읽는 고신뢰 내부 역할이며 보호자/센터 조회용이 아님 |
| bootstrap / worker | 접근 없음. 기존 역할을 앱으로 대체하지 않음 |
| PUBLIC / 미래 객체 | 권한 없음. 미검토 객체를 자동 허용하지 않음 |

기존 v2 대상에는 019 적용·목록/권한 재검토·소유자의 명시적 권한 적용이 필요하다. 새로운 목록/권한을 충족하지 않는 연결은 서비스 admission에서 닫힌 상태로 거부하며 런타임이 migration/GRANT/REVOKE를 자동 실행하지 않는다. 이번 적용은 새 UUID 합성 DB뿐이며 기존 운영/진단 DB의 권한은 변경하지 않았다.

앱 runtime은 신뢰하는 서버 공용 역할이므로 자격증명 탈취 시 허용 INSERT로 거짓 사건을 만들 수도 있다. 행 제약만으로 실제 행위의 진위를 증명하지 못한다. 일반 관리자/센터가 사건을 읽는 API, 운영 경보, 외부 보관/정합성 대조는 이번 범위에 넣지 않았다.

## 실행한 검증

| 명령 | 최종 결과 |
| --- | --- |
| `node --test --test-concurrency=2 server/tests/account-security-events.test.mjs server/tests/auth-password-change.test.mjs server/tests/database-privilege-policy.test.mjs` | 52/52. 새 사건 12 + 비밀번호 22 + 권한 정책 18 |
| `npm run test:server` | 723/723, 실패/취소/누락 0. 최신 빈 테이블 TRUNCATE 역검증도 포함 |
| `npm run test:postgres:local` | 실제 PostgreSQL 18.6 / Node 24.15.0, 47/47. 기존 45 + 실제 사건 제약 실패/롤백 및 보존 2 |
| `npm run test:recovery:local` | 실제 native dump/restore·격리 14/14. 실제 사건 2개를 포함한 전체 행/schema fingerprint와 격리 후 사건 보존 검사 |
| `npm run test:database-privileges:e-drive -- --base E:/CarebridgeBeta --powershell <설치된-pwsh.exe-절대경로> --confirm-synthetic-e-drive` | 새 E cluster의 실제 역할·TLS/DPAPI·작업자 경계·재시작/복원 34/34. 앱 INSERT-only와 백업 SELECT를 실제 비소유자 계정으로 확인 |
| `npm test` / `npm run check` / `npm run build` / `git diff --check` | 로컬 95/95 및 검사/빌드/공백 검사 통과. 브라우저/실물 기기 재실행 결과는 아님 |

위 항목은 중복을 포함한 서로 다른 층위의 시험이다. 숫자를 모두 더해 독립 사용자 시나리오 수로 제시하지 않는다. E 역할 suite의 scanner/decoder 상대는 합성이며 직전 실제 ClamAV/FFmpeg 40개 suite를 이번에 재실행한 것은 아니다.

새 단위 시험은 최소 5필드, 대상/다른 사용자 보존, 무변경·잘못된 자격의 사건 부재, 기록 실패 시 자격/실패 횟수/세션 롤백, 응답 유실의 비재시도, DB 시각, 닫힌 값 제약, 행/문장 보존, 신원 삭제 보존, 018→019 업그레이드/재실행을 검사한다. 실제 PG 시험에서는 감사 INSERT의 양수 제약을 의도적으로 위반해 DB 자체가 거부한 뒤 해시·세션·사건이 함께 원복되는 것을 확인했다. 기존 실제 두 연결 잠금 경합에도 단일 사건/세션 수 확인을 추가했다.

### 실행 식별자와 중간 실패

- PG 최종 UUID `1023ed35-615a-4887-96bb-dcb68a697aa7`, UTC `2026-10-07T14:59:06.190Z`, 종료 0. `test-results/postgres-1023ed35-615a-4887-96bb-dcb68a697aa7-results.json`. 일회용 DB `carebridge_it_3c90eb46777448c4bbcd798575b6acc3`와 자기 컨테이너/이미지 정리를 확인했다.
- 복원 최종 UUID `6e1a9a7a-2963-4912-954c-36688197e85a`, UTC `2026-10-07T15:02:53.651Z`, 종료 0. `test-results/recovery-results.json`. 자기 DB/컨테이너/이미지 정리를 확인했다. 같은 cluster의 새 DB를 쓰는 정지형 합성 시험이며 독립 운영 백업/실제 cutover 증거가 아니다.
- E 최종 UUID `e6a5d3eb-a3ad-4253-b3b3-67b5862858db`, UTC `2026-10-07T15:04:07.617Z`, 종료 0. `test-results/database-privileges-results.json`. `sourceStopped`, `restoredStopped`, `tlsFixtureCleanup`, DPAPI fixture cleanup 및 자식 2개 terminal 상태를 확인했다. 중단/부모 단절 자식의 의도된 종료 1을 성공 종료 0으로 바꾸지 않았다.
- 최초 서버 회귀는 722/723이었다. `media-work-reviews.test.mjs`의 같은 줄 두 예상 migration 배열 중 한 곳이 019를 빠뜨린 시험 기대값 오류를 수정한 뒤 전체 723개를 다시 실행했다. 제품 보호 조건은 완화하지 않았다.
- E 첫 UUID `468a10c0-1860-4746-a1d9-b07f6712a507`은 명시적 실행 인자가 없어 사전 거부, 다음 `b3c6680c-4b41-412a-a6a4-57b2dabf3243`은 문서 예시 `C:\Tools\PowerShell\pwsh.exe`가 실제 설치 경로가 아니어서 프로세스 실행 전에 중단됐다. 둘 다 0개/실패로 집계한다. 기존 번들의 실제 PowerShell 7 경로를 확인해 최종 실행에 사용했으며 설치/보호 우회는 하지 않았다.
- 복원 UUID `a81e9ac5-869e-4b47-82f7-2ca762332eb1`은 migration 적용 뒤 일반 실패를 반환했다. 새 UUID `26cd2086-b654-4a83-a69e-54c57840e391`에서 내용 없는 파일 행 번호 진단으로 245행의 이전 migration 개수 18 기대값을 확인했다. 첫 원시 오류를 보존한 것은 아니므로 첫 실행의 세부 오류까지 단정하지 않는다. 기대값을 19로 수정하고 사건 2행 존재 확인을 추가한 뒤 위 최종 새 실행이 통과했다.

실패한 두 복원 실행의 DB/worker 컨테이너 4개와 전용 이미지 2개는 실행 UUID·정확한 ID·이미지/격리 설정을 재검사했다. worker가 종료 1로 확정된 것을 확인한 다음 자기 DB를 정상 정지하고 해당 자원만 제거했다. 두 UUID의 잔존 컨테이너/이미지 0개를 확인했으며 force/prune·다른 사용자 자원 삭제는 하지 않았다. 제거한 합성 RAM 자료는 운영 자료가 아니고 위 명령으로 재생성할 수 있다. 기존 Docker Desktop은 켜 둔다.

E의 `E:/CarebridgeBeta\private\checks\postgres-check-e6a5d3eb-a3ad-4253-b3b3-67b5862858db`에는 정지한 합성 DB·파일·암호화 묶음을 진단용으로 남겼다. 시험 키/비밀번호는 종료 후 폐기하며 TLS 키도 제거한다. 같은 디스크에 있고 키를 운영 보관하지 않은 사본이므로 운영 백업이 아니며 재시작 가능한 운영 환경으로 사용하면 안 된다. 기존 E 자료는 재귀 삭제하지 않았다.

## 변경 파일과 유지한 범위

- 제품: [auth.mjs](../server/auth.mjs), [019 SQL](../server/migrations/019-account-security-events.sql), [권한 정책](../server/database-privilege-policy.mjs).
- 새 계약: [account-security-events.test.mjs](../server/tests/account-security-events.test.mjs). 기존 권한 정책 시험과 실제 인증 경합·역할/worker/E·복원 실행기도 확장했다.
- 시험 기대값: `server/postgres-integration.mjs`와 기존 migration 목록을 검사하는 `server/tests` 13개 파일에 019를 추가했다. 이전 migration/기존 서비스 자료를 재작성하지 않았다. PG 완료 수는 47로, E migration 기대 수는 19로 맞췄다.
- 문서: 이 보고서와 README·완료표·서버 기반·비밀번호·PG/권한/연결·복원 보고서의 최신 상태 링크. 역사적 실행 수치는 당시 결과로 보존한다.

프런트엔드·브라우저 저장소·새 HTTP 경로·운영 자격증명/계정·Windows 서비스/방화벽·유료 자원·GitHub/Vercel 배포는 변경하지 않았다. 공개 빌드에는 서버/시험/문서/진단 자료를 넣지 않는다.

최종 산출물 점검은 변경 파일37개(문서11개 포함)의 엄격 UTF-8/뒤 공백·충돌 표식, `.mjs`25개의 구문, 로컬 문서 링크188개를 확인했다. 공개 소스31개와 `dist`가 바이트 단위로 일치하며 추가 출력은 `build.json`뿐이다. `npm run check`/`build`/`git diff --check` 종료0이고 Git의 LF→CRLF 안내는 오류가 아니다. 종료 뒤 Windows PostgreSQL 프로세스0개·운영 `private/secrets` 파일0개를 재확인했다. 이는 다른 OS/Docker 서비스 전체의 상태 검사가 아니다.

## 남은 위험과 다음 우선순위

1. **독립 백업/복구 책임:** E와 물리적으로 분리한 국내 매체, 담당자, 키 회수, RPO/RTO, 보관/파기/실패 경보를 먼저 확정한다. 그 전 실제 아동 자료를 받지 않는다.
2. **P0 사람/실물 확인:** 기존·개편 화면에서 실제 사용자의 작성 시간·이동·정보 완전성·요약 이해와 물리 기기를 관찰한다. 자동 구성요소 통과로 대신하지 않는다.
3. **계정 복구·운영 보안:** 이메일 소유 증명/일회용 만료/실패 제한·분실 복구·변경 통지·행위자/로그인 실패 감사·최소 조회·감시·보존/파기 정책을 마련한다. 이번 최소 사건 두 종류만으로 전체 인증 감사를 완료했다고 하지 않는다.
4. **운영 실행/복원:** 전용 OS 계정/서비스 감독·HBA/TLS·전원/디스크/프로필 손실·최신 권한/삭제 대조·안전한 복원 전환은 별도 검증한다.
5. **마지막 API/P1:** 쿠키·CSRF/same-origin·TLS·요청 제한·공개 오류 비노출을 갖춘 연결 후 실제 서로 다른 기기의 로그인/메시지/사진·영상/실패 재시도·재접속을 완주한다.

[전체 완료표](communication-acceptance.md)의 P101/P1·전체 개편과 국내 통제/법적 적합성은 여전히 미완료다. 다음 안전한 내부 작업 후보는 분실 복구의 본인 확인·일회성 상태 계약 설계이며, 실제 메일 발송/운영 계정 변경은 별도 운영 결정 전에는 하지 않는다.
