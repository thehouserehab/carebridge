# E 베타 DB 권한 v2 — 파일 검사 작업자 분리

> **v2 도입 당시 기록**: 아래23개/585개·54테이블/42함수와 `FixturePreparation`·`localTestMode:true`는 당시 실행이다. 후속 [DB 연결 가드](database-service-admission.md)는 같은 연결에서 매 트랜잭션 권한을 검사한다. 현재 [계정 보안 사건019·권한 v3](account-security-events.md)는 다섯 역할/55테이블/43함수/2sequence이며 worker 기존 권한을 늘리지 않고 새 사건 접근도 금지한다. 최신 합성 E 권한34·서버723·실제 PG47·복원14 통과. v2에 자동 migration/권한 적용을 하지 않으며 운영/독립 백업·실제 자료·마지막 API는 미완료다.

2026-10-07. **비API 구성요소 단계이며 실제 자료 베타 전환은 보류한다.** 독립 백업 매체는 아직 없다는 사용자 답변을 반영한다. E 내부 복원 시험은 독립 백업이 아니며 유료 자원·외부 접속·실제 자료 수집을 승인한 것으로 해석하지 않는다.

## 현재 상태와 변경 이유

[종전 v1 네 역할 검증](database-privilege-separation.md)에서는 앱 runtime에 파일 검사 원장과 승인 증거 생성 권한도 있었다. v2는 별도의 `worker` 역할을 필수로 요구하고 앱에서 그 권한을 제거한다. 백엔드 아키텍처 지침의 요청 처리/백그라운드 작업 경계 검토를 적용했으며 기존 로컬 E·Node·PostgreSQL 구성은 유지했다. 새로운 외부 저장소나 유료 서비스를 선택하지 않았다.

검토 대상은 SQL 001~018의 테이블 54개·함수 42개·sequence 2개다. migration·인증/세션·담당 관계·파일 승인 비즈니스 규칙은 바꾸지 않았다. 실제 권한 적용은 **이번 실행이 새로 생성한 가상 DB/역할에만** 수행했다. 기존 DB/진단 cluster·운영 계정·Windows 서비스의 권한은 변경하지 않았다.

| 역할 | v2의 책임/접근 | 남는 신뢰 경계 |
| --- | --- | --- |
| 소유자 | migration·명시적 권한 관리 | 자기 객체의 DDL 권한이 있으므로 요청 처리에 사용하지 않는다. |
| 앱 runtime | 계정/관계/대화/기록·업로드 접수/첨부 연결/조회, 검토한 helper 4개 | 검사 엔진/작업 원장 접근 없음. 준비 증거는 읽기만 가능하며 생성 불가. 앱 테이블 접근은 여전히 넓은 신뢰 서버 역할이다. |
| 최초 관리자 bootstrap | 새 센터/최초 관리자·생성 영수증 | 기존 계정 복구/추가 관리자·HTTP 경로가 아니다. 종전 제한 유지. |
| 백업 | 검토한 테이블 54개·sequence 2개 읽기 | 인증 검증자/세션/임상 원문도 읽으므로 고신뢰 내부 역할이다. 쓰기/sequence 진행/helper 실행 불가. |
| 파일 검사 worker | 미디어/원장 테이블 7개 SELECT, 객체/증거/이벤트/원장 5개 INSERT, 전이/임대의 명시적 컬럼 UPDATE와 helper 3개 | 계정 비밀번호/세션/초대·대화 본문·임상/가족/프로필·운영 검토 원문 조회 불가. 파일명/manifest와 필요한 관계 ID/활성 상태는 읽는다. 실제 OS/프로세스 격리와는 다르다. |

worker는 대화방의 센터/방/아동 ID·관계 revision, 참여/소속의 역할·활성 상태·과거 열람 경계, 사용자의 ID/활성 상태만 **컬럼 지정 SELECT**로 읽는다. 대화 sequence 변경, 관계/계정 활성화, 원본 이름/형식/크기/해시·바인딩·만료 변경, 재시도 추가 승인/자원 예산 변경은 허용하지 않는다. 삭제는 객체 상태 전이와 파일 저장소의 삭제 차단 정보로 처리하며 테이블 DELETE/TRUNCATE 권한을 주지 않는다.

테이블 권한과 컬럼 권한은 합산되므로 넓은 SELECT/UPDATE를 준 뒤 컬럼 제한으로 되돌렸다고 간주하지 않는다. 적용 전후 양쪽의 실제 권한과 재부여 권한까지 검사한다. 잠금에 필요한 일부 식별자 UPDATE 권한은 남으므로 직접 SQL을 호출 전용으로 봉쇄한 설계는 아니다. [GRANT](https://www.postgresql.org/docs/18/sql-grant.html), [권한 설명](https://www.postgresql.org/docs/18/ddl-priv.html)

## 적용/호환성 원칙

- 정책 결과는 `policyVersion: 2`, `roleCount: 5`다. 다섯 역할 이름은 모두 달라야 한다. worker가 없는 v1 입력이나 앱과 같은 이름의 worker는 DB 접속 전에 거부한다. 앱 연결로 자동 대체하지 않는다.
- 대상 DB 이름/OID·소유자 신원·직접 로그인·PG 18·역할 특성/membership·객체/함수 목록과 실제 권한 검사는 유지한다. 검토하지 않은 미래 객체에는 권한을 주지 않는다.
- **v1의 넓은 앱 권한은 v2 기준에서 과도한 권한이다.** 검증/적용 모두 거부하며 자동 REVOKE·기존 역할 채택을 하지 않는다. 운영 전환 시에는 전용 역할/자격증명·writer 중단·명시적 권한 회수/전환 계획을 별도 검토해야 한다. 이번에 운영 전환 도구를 만들지 않았다.
- 기존 PUBLIC/전역 기본 함수 권한·숨은 컬럼/GRANT OPTION·NOINHERIT이어도 SET ROLE 가능한 membership 역검증을 유지하고, 앱 원장 SELECT·승인 증거 INSERT와 worker 메시지 본문 컬럼의 추가 허용도 검증/적용 모두 거부하는지 확인했다.
- DB 역할은 보호자/치료사별 권한이 아니다. RLS나 센터 간 직접 SQL 격리를 제공하지 않는다. 앱과 worker의 자격증명 분리 보관·각 프로세스 연결 강제는 다음 구성 단계이며 현재 실제 운영 자격증명은 발급하지 않았다.

## Windows/E 합성 검증과 복원

```powershell
npm run test:database-privileges:e-drive -- --base E:/CarebridgeBeta --powershell C:\Tools\PowerShell\pwsh.exe --confirm-synthetic-e-drive
npm run test:postgres:e-drive -- --base E:/CarebridgeBeta --powershell C:\Tools\PowerShell\pwsh.exe --confirm-synthetic-e-drive
```

`--powershell`은 설치된 PowerShell 7의 실제 절대 경로로 바꾼다. 일반 테스트는 이 E native 실행이나 서비스를 자동 시작하지 않는다. 각 실행은 검증한 private/checks 아래 새 UUID 원본/복원 cluster만 사용하며 기존 대상은 채택하지 않는다.

작업자 추가 시험은 실제 PostgreSQL 역할·E 파일 IO와 기존 서비스 클래스를 사용한다. 단, 승인 후보를 만드는 `FixturePreparation`은 **명시적 시험용 대역**이고 worker에는 `localTestMode:true`를 지정했다. 실제 악성코드 검사/디코더·영속 서비스가 성공했다고 해석하면 안 된다. 이 시험 모듈을 운영 앱/작업자에 연결하지 않았다.

확인한 작업자 경계:

1. worker 원장 reserve → 회수 상태 인수 → close/조회, 앱의 원장 조회/생성·승인 증거 INSERT/helper 실행 거부.
2. 앱 업로드 접수 → worker의 가상 준비 계약 → ready → 앱의 메시지 첨부 연결 → 권한 있는 치료사의 후보 바이트 조회. 연결된 원본/후보는 cleanup 후에도 보존.
3. 준비 엔진 부재 시 격리/retry 유지, 사용자 취소 시 원본/후보 intent의 삭제 차단 처리, 관계 철회 후 검사 시도/증거 생성 없음.
4. worker의 인증/세션/대화/임상·운영 원문 조회, manifest/바인딩/정책/관계 변경, DDL/TEMP/TRUNCATE/SET ROLE/OS 명령/서버 파일 접근 거부.

작업자 시험으로 파일이 늘어나므로 복원 fixture도 보강했다. DB 객체 원장에 연결된 **모든 가상 원본/후보와 삭제 차단 파일**을 목록화하고 크기/해시/상태를 확인한다. 누락·잘못된 바이트/크기·승인되지 않은 후보·비어 있지 않은 차단 파일·원장 없는 blob·알 수 없는 상태/이름·디렉터리/hardlink는 실패한다. standalone 빈 차단 파일은 기존 삭제 방지 fixture로 명시적으로 허용한다. 새로 소유한 조용한 합성 경로에만 쓰는 수집기이며 운영용 백업 도구나 악의적 동시 writer 방어가 아니다.

23개 모드에서는 blob **4개**와 삭제 차단 정보 **3개**, 합계 **7개**를 암호화 묶음에 넣고 모두 새 E 대상에 복원했다. 일반 9개 모드에서는 기존 PNG 1개/차단 정보 1개를 보존했다. 백업 역할의 실제 `pg_dump`, 새 비밀번호의 다섯 대상 역할·비슈퍼유저 owner의 `pg_restore`, 명시적 DB 접속 ACL, 변경 없이 복원된 객체/컬럼/함수/기본 ACL, 양쪽의 정상 종료/재시작 검사를 유지한다. DB 접속 경계는 v2에서 PUBLIC REVOKE와 서비스 역할 4개의 CONNECT, 총 다섯 문장이다. `--create` 없는 복원에 DB 자체 ACL까지 담겼다고 주장하지 않는다. [pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html)

## 최종 실행 결과

| 검증 | 결과/식별자 |
| --- | --- |
| E DB 다섯 역할·작업자·복원 | **23/23**. UUID `1a77183c-ecec-4a52-a7ab-585f06c45e1e`, UTC `2026-10-07T03:27:24.620Z`; `test-results/database-privileges-results.json` |
| 기존 E 일반 회귀 | **9/9**. UUID `f263cd5f-81d9-46d7-85b8-f019aa8a04df`, UTC `2026-10-07T03:28:20.246Z`; `test-results/windows-postgres-results.json` |
| 서버 구성요소 | `npm run test:server` **585/585**, 실패/취소/건너뜀 0. 정책 계약 17개·미디어 목록 계약 4개 포함. |
| 로컬 UI/도메인 단위 | `npm test` **87/87**, 실패/취소/건너뜀 0. UI 변경 없음. 새 브라우저/실물 기기 시험으로 계산하지 않는다. |

23개에는 기존 기본 흐름이 포함되므로 9개와 합쳐 32개의 독립 사례로 계산하지 않는다. 종전 v1의 19개/576개는 역사적 결과이며 현재 정책의 증거는 위 v2 실행이다. 시험 비밀번호/암호화 키는 종료 시 폐기하고 양쪽 cluster는 정상 종료했다. 가상 DB/미디어/묶음은 E에 오프라인 진단 자료로 남겼으며 기존 파일의 재귀 삭제는 하지 않았다. 키를 폐기한 같은 디스크 사본은 운영 백업이 아니다.

최종 `npm run check`, `npm run build`, `git diff --check` 통과. Git의 LF→CRLF 안내는 있었지만 오류/공백 위반은 없었다. 이번 코드/상태 문서 16개의 공백·충돌 표식과 문서 8개의 내부 파일 링크 132개를 확인했다. 공개 `dist`는 허용한 UI 자산 32개만 있으며 원본과 바이트가 일치한다. 서버/검증/진단 자료를 포함하지 않으며 두 결과 JSON은 Git 제외를 확인했다. 종료 후 PostgreSQL 프로세스 0개, 운영 `private/secrets` 파일 0개, 이번 최종 두 fixture의 password 이름 임시 파일 0개를 재확인했다. 다른 서비스/Docker 프로세스의 상태나 실제 OS 프로세스 격리 전체를 검증했다는 뜻은 아니다.

## 변경 파일과 제외 범위

| 구분 | 파일 |
| --- | --- |
| 권한 정책/내부 적용·검증 | [database-privilege-policy.mjs](../server/database-privilege-policy.mjs), [database-privileges.mjs](../server/database-privileges.mjs) |
| E 역할/작업자 합성 시험 | [database-privileges-native-check.mjs](../server/database-privileges-native-check.mjs), [database-worker-privileges-native-check.mjs](../server/database-worker-privileges-native-check.mjs), [windows-postgres-check.mjs](../server/windows-postgres-check.mjs) |
| 전체 가상 파일 목록/계약 | [windows-postgres-media-fixture.mjs](../server/windows-postgres-media-fixture.mjs), [정책 테스트](../server/tests/database-privilege-policy.test.mjs), [파일 목록 테스트](../server/tests/windows-postgres-media-fixture.test.mjs) |
| 상태 문서 | 이 보고서, 종전 v1 보고서, README·서버 기반·전체 완료표·E 저장·복구 준비·Windows PG 검증의 후속 링크 |

의존성·SQL·인증/담당 관계·HTTP/API·UI/브라우저 저장·GitHub/Vercel 배포·Docker 자료·OS 계정/서비스·방화벽·운영 키/자격증명은 변경하지 않았다. 자격증명 보관과 실제 엔진 결합은 별도 검증 경계이므로 이번 SQL 권한 변경에 함께 구현하지 않았다.

## 남은 위험과 권장 순서

1. **독립 백업/키 회수 게이트**: 별도 매체·담당·RPO/RTO·보관/파기/경보와 계정/프로필 상실 후 키 회수를 준비한다. 그 전 실제 자료 수집은 시작하지 않는다.
2. **다음 안전한 비API 작업**: 역할별 자격증명 설정/보관·오류 비노출·앱 연결을 작업자로 대체하지 못하는 구성 검사와 명시적 작업자 조립 경로를 가상 자료로 준비한다. 운영 비밀번호를 공개 설정/프런트엔드·로그·dump에 넣지 않는다.
3. **운영 프로세스와 실제 엔진**: 전용 Windows 서비스 계정/DB 연결·HBA, E 원본/후보와 native 검사 엔진의 실제 결합, 정상 종료/회수/감독/경보·자원/전원 손실을 검증한다. SQL worker 역할을 별도 OS 프로세스 격리 완료로 보지 않는다. 격리 디코더는 계속 바이트만 받아야 하며 DB 자격증명을 전달하지 않는다.
4. **안전한 복원 전환**: 별도 cluster의 최신 계정/관계 철회·삭제/엔진 원장 대조와 복원 격리·해제/cutover를 마련한다. 기존 [격리 모듈](recovery-quarantine.md)은 동일 cluster 조건이며 이번 별도 cluster에 적용하지 않았다.
5. 외부 보호자 접속 범위/운영 정책·실제 사람/기기를 확정하고 비API 준비 후 **마지막 API·화면·기기 간 수신/재접속**을 검증한다.

[전체 완료표](communication-acceptance.md)와 [복구 운영 게이트](recovery-readiness.md)는 진행 중이다. 국내 디스크·SQL 권한 분리만으로 전체 국내 통제/법적 적합성이나 실제 자료 운영 준비를 선언하지 않는다.
