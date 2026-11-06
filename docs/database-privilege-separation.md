# E 베타 DB 역할 분리 — 합성 검증

> **현재 소스의 정책 v6 (2026-10-09)**: [일반 소식 반영 메모022](local-api-connection.md#2026-10-09-일반-소식의-비공개-반영-메모)로 63테이블/53함수/2sequence를 명시한다. 새 영수증은 runtime SELECT/INSERT·backup SELECT만 허용하며 worker/bootstrap은 접근하지 않는다. 신규 trigger 함수의 직접 실행 권한을 앱에 부여하지 않는다. 이번에는 메모리 PGlite의 schema/정책 계약과 기존 메모 업그레이드 보존을 검증했으며 기존 E/native DB·계정에 v6를 적용하거나 실제 역할/복원 검증을 재실행하지 않았다. 아래 v1~v3 수치는 각 단계 당시 기록이며 최신 native 승인 근거가 아니다.

> **v1 역사적 기록**: 아래 네 역할/19개/576개는 당시 결과다. [v2 파일 검사 작업자 분리](database-worker-privileges.md) 이후 현재는 [계정 보안 사건019·권한 v3](account-security-events.md)다. 다섯 역할·55테이블/43함수/2sequence를 검토하며 새 사건은 앱 INSERT-only·백업 SELECT·bootstrap/worker 접근 없음이다. v1의 넓은 권한은 자동 회수/운영 전환하지 않는다. 최신 합성 E 권한34·서버723·실제 PG47·복원14를 통과했지만 독립 백업/실제 자료 전환·API는 여전히 보류한다. 아래54/42·001~018은 당시 범위다.

2026-10-07. 요청 처리와 운영 관리 권한을 분리하는 비API 준비 단계다. 기존 Node/PostgreSQL 구조와 SQL 001~018, 인증·담당 관계 검사는 유지한다. **실제 운영 DB/계정·아동 자료·외부 접속·API·배포는 활성화하지 않았다.**

사용자는 독립 백업 매체가 아직 없다고 답했다. 같은 E의 원본/복원 DB와 암호화 묶음은 독립 백업이 아니며 실제 자료 베타 전환은 계속 보류한다. 유료 자원·기존 DB 권한 변경·무백업 운영 승인이 아니다.

## 변경 이유와 경계

종전 E 시험의 일반 서비스 호출도 테이블 소유자 연결을 사용했다. 비슈퍼유저라도 소유자는 자기 테이블 구조·트리거를 바꿀 수 있으므로 앱 실행 계정으로 적절하지 않다. 이번에는 새 시험 cluster에서만 네 역할을 만들고 실제 서비스 호출을 비소유자 runtime으로 실행했다. [PostgreSQL 권한 설명](https://www.postgresql.org/docs/18/ddl-priv.html)

| 역할 | 검토한 권한 | 제한/신뢰 경계 |
| --- | --- | --- |
| migration 소유자 | 스키마/불변 migration·명시적 권한 관리 | 테이블 소유 권한은 남는다. 요청 처리 연결로 사용하지 않는다. |
| 앱 runtime | 검토한 앱 테이블 읽기/쓰기·5개 invoker helper·감사 sequence USAGE | 최초 관리자 영수증·복원 격리·migration 원장 접근, DDL/TRUNCATE/감사 삭제, 역할 승격 불가. DELETE는 관계 재진입 때 읽음 위치 초기화용 `cb_read_states`만 허용. |
| 최초 관리자 bootstrap | 센터/사용자/인증 계정/소속/생성 영수증 SELECT·INSERT, 센터 생성 trigger의 기본 미디어 정책 INSERT | 임상/메시지/세션/초대 조회와 비밀번호 해시·활성 상태·소속 역할 UPDATE 불가. 기존 관리자 복구/추가 기능이 아님. |
| 백업 | 검토한 54개 테이블 SELECT·2개 sequence SELECT | 쓰기·sequence 진행·앱 helper 실행 불가. 백업 대상의 개인정보/비밀번호 검증자/세션 행을 읽으므로 고신뢰 내부 운영 역할이다. |

`FOR SHARE/FOR UPDATE` 잠금에는 최소 한 컬럼의 UPDATE 권한이 필요하다. 필요한 식별자 컬럼과 일정 counter에 한정했지만 직접 SQL 사용자의 식별자 변경을 완전히 봉쇄하는 호출 전용 권한은 아니다. [PostgreSQL 권한 설명](https://www.postgresql.org/docs/18/ddl-priv.html)

runtime은 **신뢰하는 서버 공용 DB 역할**이지 보호자/치료사별 DB 계정이 아니다. 자격증명이 탈취되면 앱 테이블 전반에 접근할 수 있다. SQL 행 단위 격리(RLS)·센터 간 직접 SQL 격리·검사 작업자의 별도 역할을 구현했다고 하지 않는다. 기존 서버 세션/담당 관계/공유본 검사는 계속 필요하다.

## 내부 정책 모듈

`server/database-privilege-policy.mjs`는 001~018의 테이블 54개·함수 42개·sequence 2개를 명시한다. 미래 객체에 일괄 GRANT하지 않으며 새 migration이 생기면 정책/검증도 다시 검토한다. 역할/DB 이름은 제한된 식별자, 역할 네 개는 서로 달라야 하며 DB 이름·OID·소유자 OID와 이름 재확인을 요구한다.

`server/database-privileges.mjs`의 내부 운영자 트랜잭션:

1. 직접 로그인한 비슈퍼유저 owner·확인한 DB/OID·PostgreSQL 18인지 확인한다.
2. 네 역할의 LOGIN/NOINHERIT, superuser/CREATEDB/CREATEROLE/replication/BYPASSRLS 없음과 역할 membership 없음, 다른 DB 소유 없음, 공개 schema 객체 목록/소유자·함수 인자/반환형/SECURITY DEFINER 경계를 검사한다.
3. 실제 테이블·컬럼·함수·sequence 권한과 재부여 가능한 GRANT OPTION을 검사한다. 과도한 객체 권한을 자동 회수해 기존 역할을 채택하지 않고 거부한다. 검토한 권한의 누락만 명시적 재실행으로 추가할 수 있다.
4. 대상 DB/PUBLIC·public schema·검토한 객체의 PUBLIC 권한을 닫고 명시한 역할에만 권한을 부여한다. 소유자의 전역/해당 schema 기본 PUBLIC 권한도 닫는다.
5. 같은 트랜잭션에서 실제 권한과 미래 함수의 명시적 전역 기본 ACL을 다시 검사한다. 오류는 내용 없는 `DATABASE_PRIVILEGES_UNAVAILABLE`로 처리하며 임의 SQL/드라이버 원문을 노출하지 않는다. 커밋 응답 유실은 성공으로 가정하거나 자동 재시도하지 않는다.

PostgreSQL은 기본적으로 함수에 PUBLIC EXECUTE를 부여하며 schema 단위 REVOKE만으로 전역 기본값을 취소할 수 없다. 그래서 둘 다 닫고, 기본 ACL 행이 없다는 사실을 ‘닫힘’으로 오인하지 않는다. [ALTER DEFAULT PRIVILEGES](https://www.postgresql.org/docs/18/sql-alterdefaultprivileges.html)

이 모듈은 역할/비밀번호·운영 DB를 생성하거나 서비스 시작/HTTP/API를 제공하지 않는다. 입력 영수증/객체 이름은 임의 DB나 dump의 신뢰성을 증명하지 않는다. 신뢰하는 새 전용 역할·검증한 migration·조용한 운영자 작업 창을 전제로 한다. 함수 본문/모든 schema·cluster 전체를 악의적 소유자로부터 증명하는 도구는 아니다. 다른 DB의 기존 권한/HBA, DB별 역할 설정, OS 계정·자격증명 회수도 별도 검토해야 한다.

## E 합성 실행과 복원

설치/소유/ACL 확인은 [기존 E Windows 도구 검증](windows-e-postgres-verification.md)을 재사용한다. 새 `private/checks/postgres-check-<UUID>`에서만 원본/대상 cluster와 임의 시험 자격증명을 만든다. 기존 DB/중단된 진단 cluster를 채택하지 않는다. 시험 owner와 나머지 역할 모두 비슈퍼유저·NOINHERIT이며 역할 변경은 이 새 fixture에 한한다.

```powershell
npm run test:database-privileges:e-drive -- --base E:/CarebridgeBeta --powershell C:\Tools\PowerShell\pwsh.exe --confirm-synthetic-e-drive
```

`--powershell`에는 설치된 PowerShell 7의 절대 경로를 지정한다. 일반 `npm test`/`npm run test:server`는 이 E native 시험이나 운영 서비스를 자동 실행하지 않는다.

백업은 실제 읽기 전용 역할로 `pg_dump`를 실행했다. 복원 대상에는 같은 역할 이름을 **새 비밀번호로 독립 생성**하고 비슈퍼유저 소유자로 `pg_restore --single-transaction`을 실행한다. 역할 비밀번호 자체는 dump에 기대지 않는다.

이 시험은 기존 신규 DB에 복원하므로 `--create`를 쓰지 않는다. **DB 자체의 CONNECT/TEMP/PUBLIC ACL은 별도 명시적 절차**로 적용한다. 새 대상 신원을 확인한 정책에서 DB 관련 네 문장만 재적용하고, 테이블/컬럼/함수/sequence/default ACL은 수정하지 않은 상태로 검증한다. 누락된 객체 권한을 재부여해 dump 보존 성공처럼 보이게 하지 않는다. 이 시험용 helper는 운영 복원 승인/최신 권한 대조/격리 해제가 아니다. [pg_dump와 DB 자체 권한](https://www.postgresql.org/docs/18/app-pgdump.html)

## 실행 결과

- 최종 역할 검증 **19/19**, UUID `8e047084-e71e-49fe-b837-f7fa05c10a35`, UTC `2026-10-07T03:05:31.126Z`. 보고서 `test-results/database-privileges-results.json`.
- 기존 E 저장·재시작·복원 회귀 **9/9**, UUID `bddc5673-b2b1-4eb1-8b7b-88c07283ab92`, UTC `2026-10-07T03:03:56.420Z`. 보고서 `test-results/windows-postgres-results.json`. 19개에는 기본 흐름도 포함되므로 28개 독립 사례로 합산하지 않는다.
- `npm run test:server` **576/576**(신규 정책 계약 12개 포함), `npm test` **87/87**, 실패/취소/건너뜀 0. 서버 구성요소 결과이지 운영/실물 기기 결과가 아니다.
- 최종 `npm run check`, `npm run build`, `git diff --check` 통과. 변경 상태 문서 7개의 내부 파일 링크 116개와 신규 파일 5개의 공백/충돌 표식을 검사했다. 공개 `dist`는 허용한 UI 자산 32개뿐이며 서버/운영 코드·비밀정보·진단 자료는 포함하지 않는다. UI 변경이 없어 이전 브라우저 검사를 이번에 재실행한 것으로 표기하지 않는다.

19개는 다음을 묶은 수다: E PGDATA/SCRAM/내구 설정·001~018; owner 권한 적용/재실행/카탈로그 검증; bootstrap 신규 가상 관리자 생성/자격증명 보존 재시도; runtime 로그인/초대/수락/아동 등록/담당 연결/소식/가상 decoder 원장; 관리자 대화 존재 비노출; runtime 관리자 발급·운영 테이블·DDL·TEMP·TRUNCATE·감사 삭제·SET ROLE·OS 명령·서버 파일 접근 거부; bootstrap 임상/세션/민감 컬럼 수정 거부; 백업 54개 테이블 읽기/쓰기 거부; PUBLIC 접속·미래 객체 접근 거부; 잘못된 DB/OID·과도한 권한·NOINHERIT이어도 SET ROLE 가능한 membership·숨은 컬럼/GRANT OPTION/재개방 기본 함수 권한 거부; 기록/0/null/격리 PNG/fence 보존; 원본 재시작·백업 역할 dump·암호화·독립 대상 복원·권한/기본 ACL·대상 재시작.

초기 UUID `1eae4bb9-982b-446e-95a2-f822890c3120`은 역할 phase 3에서 중단됐다. 비참여 관리자 조회의 기대값을 실제 비노출 계약 `NOT_FOUND`로 수정한 다음 실행은 역할 8묶음을 통과했다. UUID `25eac291-6364-4da4-a559-5b902b0e7133`은 기본 복원 보호까지 16묶음 통과 후 중단됐고, DB 자체 ACL의 별도 적용을 추가한 새 실행은 19개 통과했다. 원시 오류는 보관하지 않았으므로 첫 실패 원문을 안다고 단정하지 않는다. 최종 실행에는 미래 함수 기본 권한 재개방 역검증과 helper 반환형 확인도 포함했다.

성공/실패 진단 DB·가상 사진·사본은 **종료 상태**로 E에 남겼다. 재귀 삭제·기존 자료 삭제 없음. 생성한 시험 비밀번호/암호화 키는 실행 종료 시 폐기하고 initdb 비밀번호 임시 파일은 제거한다. DB의 시험 비밀번호 검증자는 남지만 운영 자격증명은 아니다. 최종 시험 후 PostgreSQL 프로세스 0개·운영 `private/secrets` 파일 0개·최종 fixture의 init-password 파일 0개를 확인했다. 남은 사본은 키를 보관한 독립 운영 백업이 아니다.

## 변경 파일

- 정책/내부 운영자: `server/database-privilege-policy.mjs`, `server/database-privileges.mjs`.
- 합성 검증: `server/database-privileges-native-check.mjs`, `server/tests/database-privilege-policy.test.mjs`; 기존 `server/windows-postgres-check.mjs`에 명시적 역할 모드, runtime 서비스 호출/백업 역할 dump/복원 권한 검사 추가. 일반 9개 모드는 유지한다.
- 루트 `package.json`: opt-in `test:database-privileges:e-drive` 추가.
- 이 문서와 README·서버 기반·전체 완료표·E 저장·복구 준비·기존 Windows PostgreSQL 상태 링크.

의존성·SQL migration·서비스 인증/세션/담당 관계·UI·브라우저 저장소·Docker 전체 저장·OS 계정/서비스·방화벽·실제 자료·GitHub/Vercel 배포는 변경하지 않았다.

## 남은 위험과 우선순위

1. **독립 백업 매체와 키 회수**: 같은 E의 복원 성공은 디스크/프로필 상실에 대비한 증거가 아니다. 매체·키 회수 담당·RPO/RTO·보관/파기/경보를 정하고 실제 새 장애 도메인에서 검증한다.
2. **운영 프로세스/자격증명 분리**: Windows 전용 서비스 계정, DB별 연결/HBA/자격증명 보관/회수, 검사 작업자의 별도 DB 역할과 실제 Windows–검사 엔진 결합·자동 시작/정상 종료/경보를 준비한다. 현재 일반 runtime에는 검사 원장/미디어 관리도 함께 있다.
3. **안전한 복원 전환**: 별도 cluster의 새 role/OID mapping과 복원 격리, 최신 계정·참여/철회·삭제·엔진 원장 대조, 격리 해제/cutover를 검증한다. 기존 [복원 격리](recovery-quarantine.md)는 동일 cluster 조건이며 이번 별도 cluster에 적용했다고 하지 않는다.
4. **사용 범위/운영 정책과 사람 확인**: 외부 보호자 접속 여부·메시지/이력·실제 참여자/기기·보존/파기를 확정하고 P0 작성 시간/요약 이해도 등을 관찰한다.
5. 비API 준비 후 **마지막 API·화면·서로 다른 실제 기기**의 로그인/수신/사진·영상/재시도/재접속을 검증한다. 현재 프로토타입은 계속 가상 역할/브라우저 저장소다.

이번 증거는 BR-08의 DB 권한 일부이며 [전체 완료표](communication-acceptance.md)나 [BR-01~10](recovery-readiness.md)의 완료 판정이 아니다. 국내 디스크/권한 분리만으로 전체 국내 통제·법적 적합성·실제 자료 운영 준비를 선언하지 않는다.
