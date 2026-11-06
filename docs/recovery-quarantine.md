# Carebridge 복원 대상의 계정·작업 격리

2026-10-08 후속: [복원본과 최신 상태 대조](recovery-state-comparison.md)를 추가했다. 같은 서버의 원본/격리 대상·영수증·접근 닫힘을 검증하고 60개 데이터 테이블을 쓰기 없이 비교한다. 실제 합성 E22·서버748·로컬124 통과. 기존 격리를 수정/해제하거나 최신 삭제 상태를 자동 병합하지 않는다. 별도 cluster·최신 외부 파일/원장/키·독립 백업·운영 cutover는 남아 있다. 아래는 기존 단계 당시 기록이다.

2026-10-08 후속: [최소 계정 보안 사건019](account-security-events.md)을 포함해 native 복원/격리14개를 재검증했다. 격리 대상 계정/세션의 폐기와 무관하게 기존 사건2행·임상/작업 이력이 보존된다. 격리 직접 SQL에 일반 `sessions.revoked` 사건을 추가한 것은 아니며 격리의 기존 영수증 계약을 유지한다. 운영 전환·독립 백업/키 회수·실제 자료 수집 승인은 아니다. 아래는017 도입 당시 기록이다.

2026-10-06. 소통 중심 개편안 P1의 저장 안전성 후속이다. 오래된 사본의 권한·검사 작업이 다시 유효해지지 않도록 **복원 대상에만 명시적 격리**를 적용한다. 운영 복원·자동 서비스 전환·계정 복구·API 연결은 하지 않았다.

## 현재 상태와 문제

[DB·첨부 복원 시험](recovery-native-verification.md) 이후 백업 원본에서 합성 보호자를 정지하고 세션·초대를 철회했다. 그 전에 만든 사본의 복원본에서는 과거 세션과 비밀번호가 여전히 유효했다. 복원 성공이 최신 접근 승인을 의미하지 않는 위험을 실제 PostgreSQL에서 재현했다.

SQL 001~016을 변경하지 않고 017을 추가했다. 보통 DB에는 격리 영수증이 없어 기존 동작을 유지한다. migration만으로 계정을 정지시키거나 작업자를 시작하지 않는다. 실제 실행은 새 합성 DB·PNG·작업 원장만 사용했으며 실제 사용자 자료는 사용하지 않았다.

## 내부 실행 계약과 보호 경계

`quarantineRestoredDatabase(database, input)`는 운영자 내부 모듈이다. HTTP/CLI/환경변수 자동 실행 경로가 없다. 호출자는 사본 출처·전체 인증·DB/파일 복원 결과를 검증하고 모든 writer를 먼저 정지해야 한다. **신규 생성 영수증을 받은 사실 자체가 사본 검증/정지의 증거는 아니다.** 현재는 같은 cluster의 서로 다른 생성 DB만 지원한다.

| 단계/경계 | 구현 결과 |
| --- | --- |
| 대상 확인 | 원본/대상 이름·OID·owner OID, 현재 접속 DB, 직접 접속한 owner 역할과 영수증 INSERT 권한을 대조. 원본 접속·잘못된 대상/역할 거부. system/template DB 제외. |
| 직렬화 | 대상의 계정·세션·초대·미디어·원장·큐·영수증 쓰기를 트랜잭션 잠금으로 직렬화. 실패는 롤백이며 다른 프로세스/세션을 강제로 종료하지 않음. |
| 원자적 종료 | 활성 사용자를 비활성화하고 미종료 세션·미수락/미철회 초대를 종료한 뒤 영수증과 함께 커밋. 비밀번호 해시·소속/참여 이력·대화/임상·파일·횟수/generation은 변경하지 않음. |
| 최소 영수증 | 원본/대상 식별, operation/bundle UUID, 처리 개수와 DB 시각만 보관. 이메일·암호·토큰·임상·객체 내용 없음. |
| 정확한 재시도 | 같은 요청은 원 영수증을 조회. 다른 operation/bundle/출처·대상은 충돌. 연결/잠금 대기 중 호출자가 입력을 바꿔도 최초 확인한 값을 사용. 커밋 응답 유실은 자동 재실행/성공으로 처리하지 않음. |
| 계정·조회 | 기존 자체 인증과 대화/기록의 활성 사용자 검사를 유지. 이전 세션·초대, 올바른 이전 비밀번호로도 접근 불가. 활성 사용자 INSERT/UPDATE와 계정/세션/초대 변경을 trigger로 차단. 비활성 사용자 등록은 접근 승인이 아님. |
| 과거 검사 상태 | engine/job, upload/object/proof와 queue 쓰기를 차단. 늦은 heartbeat/attach/take, 새 reserve·정산 불가. 원장/횟수/불확실 상태를 임의로 closed/ready로 고치지 않음. |
| 격리 유지 | 영수증 UPDATE/DELETE/TRUNCATE와 보호 대상 TRUNCATE를 거부. 일반 역할의 삭제/초기화로 격리를 해제하지 못함. |

비공개 영수증을 읽는 trigger는 제한된 `SECURITY DEFINER` 함수다. 관계를 명시적으로 `public`에 한정하고 search_path를 `pg_catalog,pg_temp`로 고정하며 PUBLIC EXECUTE를 철회했다. 일반 역할에 영수증 SELECT/함수 직접 EXECUTE를 주지 않고, 실제 trigger와 임시 look-alike 테이블 우회 거부를 확인했다. [PostgreSQL SECURITY DEFINER 안전 지침](https://www.postgresql.org/docs/18/sql-createfunction.html)

이 장치는 DB 전체 SELECT 권한을 회수하는 RLS나 DB owner/superuser 통제가 아니다. 운영 runtime에는 owner/DDL 권한을 주면 안 된다. 운영자의 원문 검사나 파일 저장소 직접 접근까지 trigger가 차단한다고 주장하지 않는다.

## 변경 파일과 이유

| 파일/영역 | 변경 이유 |
| --- | --- |
| `server/migrations/017-recovery-quarantine.sql` | 비공개 불변 영수증과 활성 사용자/작업 쓰기·TRUNCATE 방어. 기존 SQL 보존. |
| `server/recovery-quarantine.mjs` | 출처/대상·역할 확인, 원자적 종료, 최소 오류/응답과 정확한 재시도. |
| `server/tests/recovery-quarantine.test.mjs` | 입력/소유/쿼리 순서·실패/응답 유실·재시도·입력 변경 계약 9개. double 시험이며 실제 SQL 증거와 구분. |
| `server/recovery-native-test.mjs` | 최초 보존 9개에 실제 권한 rollback·격리 5개 추가. 합성 미검사 큐 원본도 암호화/복원 대상에 포함. |
| `server/recovery-test.Dockerfile`와 `.dockerignore` | 필요한 내부 모듈만 build allowlist에 추가. 환경변수 파일·실제 자료 제외. |
| `server/postgres-container-fixture.mjs`, `postgres-container-test.mjs` | 복원 시험에만 합성 NOLOGIN 최소 역할 생성. 성공 조건/보고 수를 14개로 갱신. |
| `server/postgres-integration.mjs`, 기존 서버 테스트 13개 파일 | 마이그레이션 기대 목록에 017만 추가. 기존 서비스 계약 유지. |
| README·서버 기반·복구 검토/검증 문서 | 최초 시험 이력과 최신 증거·운영 미완료 범위를 구분. |

화면·API·메일·외부 인증 provider·의존성/lockfile·환경변수·GitHub/Vercel 배포는 변경하지 않았다. 인증 스킬의 접근 보호 원칙은 적용하되 국내 통제 요구에 따라 외부 인증 서비스를 추가하지 않고 기존 자체 인증을 유지했다.

기대 목록만 갱신한 13개 파일은 `server/tests/`의 `auth.test.mjs`, `conversations.test.mjs`, `activity-feedback.test.mjs`, `care-contexts.test.mjs`, `center-bootstrap.test.mjs`, `media-bindings.test.mjs`, `media-resource-policy.test.mjs`, `media-uploads.test.mjs`, `media-work-queue.test.mjs`, `media-work-reviews.test.mjs`, `profiles.test.mjs`, `records.test.mjs`, `relationships.test.mjs`다.

## 실제 검증

재현 명령: `npm run test:recovery:local`, `npm run test:postgres:local`, `npm --prefix server test`, `npm test`, `npm run check`, `npm run build`, `git diff --check`.

최종 결과는 복원/격리 native **14개**, 기존 PG/작업자 **35개**, 서버 **547개**, 로컬 **61개** 모두 통과(exit 0)다. 변경 JS 구문·check/build·diff, 문서 링크/공백과 정적 출력 32개 파일의 비공개 모듈/사본/키/시험 결과 제외도 확인했다. 최종 복원 실행은 `f9ad2b5f-2906-4824-be23-159147c34b46`, PG 회귀는 `029dc584-4356-402f-ac7d-30c0906eb094`다. 비공개 `test-results/recovery-results.json`은 최신 합격 여부/개수/한계를 남긴다. 브라우저·실물 기기·ClamAV/FFmpeg 결합은 이번 단계에서 다시 실행하지 않았다.

복원 시험에 추가한 실제 PostgreSQL 사례는 다음 5개다.

1. 백업 이후 원 DB에서 세션/초대를 철회·사용자를 정지한 뒤 복원본의 과거 인증이 여전히 유효함을 확인. 잘못된 대상/일반 역할 호출 거부.
2. 사용자/세션 종료 후 영수증 직전에 합성 실패를 주입하면 실제 트랜잭션의 모든 변경 롤백.
3. 실제 커밋 후 응답만 유실시키면 자동 재시도 없음. 명시적 재시도로 원 처리 개수를 확인. 과거/복원 후 세션과 초대 모두 불가.
4. creating 원장·queued upload를 보존하되 늦은 정산·증거 수정·영수증 삭제/전체 초기화 거부. 임상·원장·첨부 이력 지문 불변.
5. pool을 닫고 새 연결/인증/조회 객체를 만들어도 차단 유지. 최소 역할의 임시 테이블/search_path 조작으로 재활성화 불가. 원 DB의 최신 합성 상태 불변.

creating 원장에는 실제 외부 컨테이너가 없으며 이번 결과는 알 수 없는 기존 컨테이너 회수/엔진 교체 증거가 아니다. 응답 유실은 제어된 wrapper 주입으로 실제 네트워크/전원 장애와 구분한다. 파일 검사 증거는 합성 SQL fixture이며 ClamAV/FFmpeg 승인 시험을 대신하지 않는다.

첫 복원 실행은 실패였고 이후 Docker 엔진도 내려가 있었다. 종료/소유를 확인한 해당 시험 컨테이너 2개·worker image만 제거했다. 로그가 남지 않아 최초 실패 원인을 단정하지 않는다. 잘못된 증거 열 이름을 바로잡고 새 실행에서 검증했다. 기존 PG 시험의 첫 재실행은 017이 빠진 기대 목록에서 실패하여 목록을 추가하고 재검증했다. 실패를 합격 수에 포함하지 않는다. 삭제 대상은 이 실행들이 만든 합성 RAM-only 시험 환경으로 영구 사용자 자료/범위 불명 볼륨은 삭제하지 않았다.

## 남은 위험과 다음 순서

**BR-06~07 전체 완료나 서비스 전환 승인은 아니다.** 격리 해제를 의도적으로 제공하지 않았다. 영수증 삭제·trigger 해제·횟수 reset을 복구 절차로 사용하면 안 된다.

1. 최신 비밀번호/정지·소속/담당/과거 열람·공유 철회·파일 삭제 의도와 별도 최신 fence 대조. 부족하면 계속 닫음.
2. 실제 engine 교체/불확실 이전 프로세스·컨테이너, 누적 시도·검사 증거와 새 실행 승인 대조. 자동 인수/삭제 금지.
3. 별도 cluster 최소 역할, 국내 영구 매체·키 보관/회수, 사본 보관/파기·RPO/RTO·담당자/예산 확정. 같은 cluster 생성 영수증으로 대체하지 않음.
4. 최신 권한/삭제/작업 상태를 검증한 새 서비스 대상으로 명시적 전환 설계·승인. 현재 격리 대상은 원문 보존/검증용이며 일반 계정으로 열지 않음.
5. 마지막 API·화면 연결, 서로 다른 실물 기기/재접속·통신 단절, 개편안 6개 흐름과 사람의 기록 시간/요약 이해도 검증.
