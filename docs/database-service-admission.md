# 파일 검사 작업자의 DB 연결 가드와 명시적 조립

2026-10-08 현재 정책은 [계정 보안 사건019·권한 v3](account-security-events.md)다. 다섯 역할·55테이블/43함수/2sequence의 목록/권한을 같은 연결에서 검사하며 새 사건은 앱 INSERT-only·백업 SELECT·worker/bootstrap 접근 없음이다. 이전 v2는 019와 명시적 권한 적용 없이는 새 admission 조건을 충족하지 못하며 자동 복구/GRANT는 하지 않는다. 새 합성 E 권한34·서버723·실제 PG47·복원14 통과. 아래 v2/25·599는 도입 당시 증거이며 운영 계정/서비스·독립 백업·API 활성화는 아니다.

최신 [DPAPI→PostgreSQL/TLS 연결](windows-database-service.md)은 구체적 보관소·전용 pool·이 보고서의 매 트랜잭션 가드를 조립한다. 합성 E 30·서버 625·로컬 87 통과. 운영 worker/OS·독립 백업·마지막 API는 미완료이며 아래 25/599는 당시 기록이다. 현재 worker 시험의 scanner/decoder 상대는 계속 합성 대역이다.

후속 [Windows DB 서비스 자격증명 보관](windows-database-credential-store.md)은 이 보고서의 연결 가드와 별개 책임으로 구현했다. 네 역할·DB/OID를 묶은 DPAPI 합성 E 15·기존 키 최종 13·서버 611·로컬 87 통과. 아직 회수한 비밀번호의 실제 PG 로그인/운영 서비스는 아니며 일시 실패 원인은 미확정이다. 아래 PG25/일반 E9는 당시 증거이고 후속 단계에서 재실행하지 않았다.

2026-10-07. [권한 정책 v2](database-worker-privileges.md)의 후속 비API 단계다. 정책 버전/다섯 역할의 권한 자체는 유지하고 **실제 실행 연결에 그 정책을 적용하는 경로**를 추가했다. 전체 개편안/P1은 진행 중이다. 사용자 답변상 독립 백업 매체가 아직 없으므로 실제 아동 자료 베타 전환은 계속 보류한다.

## 문제와 변경

기존 `MediaWorkQueueWorker`는 주입받은 DB가 worker인지 확인하지 않았다. SQL 권한 분리만 마련해도 조립 과정에서 앱/소유자 연결을 잘못 주면 작업자가 넓은 권한으로 실행될 수 있었다. 백엔드 아키텍처 스킬의 요청 처리/백그라운드 경계 원칙을 적용해 기존 E·Node·PostgreSQL 구성 안에서 보완했다. 외부 서비스/유료 자원을 추가하지 않았다.

`databaseForService(database, confirmedPrivileges, kind)`는 호출자가 소유한 DB pool 위에 역할 지정 포트를 만든다. 자격증명 공급자나 새 pool이 아니며 env/비밀번호를 읽지 않는다. `runtime`, `worker`, `bootstrap`, `backup`만 허용하고 소유자 목적·worker 누락·중복 이름·확인되지 않은 DB/OID는 거부한다.

- 작업을 실행할 **같은 연결/같은 트랜잭션**에서 실제 DB 이름/OID·소유자 OID, `current_user`와 `session_user`, PG 18·역할 특성/membership·검토한 객체·실제 테이블/컬럼/함수/sequence/default ACL을 확인한다. 기존 owner 전용 적용/검증 함수는 계속 owner만 허용한다.
- 시작 때 한 번 검사한 결과를 캐시하지 않는다. 풀의 다음 연결이 앱 역할로 바뀌거나 추가 권한이 생기면 다음 작업 콜백 전에 거부한다. 현재는 다섯 역할 정책 전체를 검사하므로 다른 서비스 역할의 권한 이상도 작업자를 멈춘다.
- 내부 작업에는 frozen `query/exec` 포트만 빌려준다. 콜백 성공/실패 후 포트를 보관해 늦게 호출하면 원래 pool client를 다시 사용하지 못한다. 정상 콜백은 자기 쿼리를 모두 await해야 한다.
- 가드는 GRANT/REVOKE·SET ROLE·자동 회수/재시도·pool 종료를 하지 않는다. 연결/입장 검사/커밋 실패는 고정 오류로 처리하며 응답 유실을 성공으로 간주하지 않는다. 작업 콜백의 기존 내부 오류/rollback 계약은 유지하므로 공개 서비스층의 오류 비노출 처리는 계속 필요하다.

`SET ROLE`은 실행 사용자만 바꿀 수 있으므로 로그인 세션 사용자까지 함께 비교한다. 실제 PostgreSQL에서 owner의 SET ROLE 가장도 거부하는지 확인했다. 이것은 악의적인 superuser/cluster 관리자의 변조나 최초 인증 신원·TLS를 증명하는 장치는 아니다. [SET ROLE](https://www.postgresql.org/docs/18/sql-set-role.html), [세션 정보 함수](https://www.postgresql.org/docs/18/functions-info.html)

## 작업자 조립 경로

`createMediaWorkerService(options)`는 검증된 worker DB 포트 하나로 다음 구성요소를 직접 조립한다.

```text
호출자 소유 DB → worker 연결 가드 → 영속 DecoderJobJournal
                                      ↓
승인된 runtime/image + 로컬 scanner → IsolatedMediaDecoder/MediaPreparation
                                      ↓
비공개 파일 저장소 → MediaUploads → MediaWorkQueueWorker (아직 시작하지 않음)
```

구체적인 `PrivateFileStore`/`LocalClamAvClient`와 승인 엔진/image·1~2개 capacity·기존 bounded poll을 요구한다. 미리 만든 journal/preparation, `localTestMode`, force나 알 수 없는 옵션은 받지 않는다. 모든 의존성/설정은 첫 await 전에 캡처한다. 생성은 읽기 전용 DB 입장 검사만 수행하며 파일 경로 초기화·원장/큐 할당·native 엔진 호출·signal 등록·loop 시작을 하지 않는다. 파일 ACL·실제 runtime의 신뢰성/버전·자격증명/종료 책임은 호출자에게 남는다.

실행은 별도 운영 조립자가 반환된 작업자를 기존 [프로세스 종료 연결](media-worker-lifecycle.md)의 `runMediaWorkerProcess`에 명시적으로 전달해야 한다. 자동 시작 CLI/Windows 서비스나 env fallback을 만들지 않았다. 격리 디코더에는 계속 바이트만 전달하며 DB 자격증명을 넘기지 않는다. 기존 저수준 클래스는 내부 구성요소로 남으므로 이 새 경로를 모든 HTTP/앱에 이미 강제했다고 주장하지 않는다.

## 검증 결과와 재현

```powershell
node --test server/tests/database-service-privileges.test.mjs server/tests/media-worker-service.test.mjs server/tests/database-privilege-policy.test.mjs
npm run test:server
npm test
npm run check
npm run build
git diff --check
npm run test:database-privileges:e-drive -- --base E:/CarebridgeBeta --powershell C:\Tools\PowerShell\pwsh.exe --confirm-synthetic-e-drive
npm run test:postgres:e-drive -- --base E:/CarebridgeBeta --powershell C:\Tools\PowerShell\pwsh.exe --confirm-synthetic-e-drive
```

PowerShell 7 경로는 실제 설치 경로로 바꾼다. 최종 역할 실행은 위 npm 명령과 같은 Node 진입점을 직접 호출했다. 기존 DB/중단 fixture를 재사용하지 않고 각 실행의 새 UUID 경로만 사용한다.

| 범위 | 실제 결과 |
| --- | --- |
| 집중 단위 | **31/31**: 새 연결 가드 9개·조립 5개와 기존 정책 17개. catalog 대역이며 PostgreSQL 실행 증거와 구분한다. |
| 전체 서버 | `npm run test:server` **599/599**, 실패/취소/건너뜀 0. |
| 로컬 단위 | `npm test` **87/87**, 실패/취소/건너뜀 0. UI 변경/새 브라우저·실물 시험은 없음. |
| 최종 Windows/E 역할·작업자·복원 | **25/25**, UUID `54357f7b-7838-4f85-a7a2-adddff07f78f`, UTC `2026-10-07T03:47:16.977Z`, `test-results/database-privileges-results.json`. 양쪽 cluster 정상 종료 확인. |
| 일반 Windows/E 회귀 | **9/9**, UUID `a55dfa84-eda3-4a59-b81c-f7e3b9e3ba19`, UTC `2026-10-07T03:42:53.541Z`, `test-results/windows-postgres-results.json`. |

E에서는 실제 DB의 네 서비스 로그인 허용, worker 목적에 owner/app/다른 역할·잘못된 OID 거부, 회전한 pool 연결·나중에 추가된 메시지 본문 컬럼 권한·owner SET ROLE의 작업 전 거부를 확인했다. 작업자 조립도 실제 owner/app 연결을 거부하고 정상 worker에서 원장 reserve/create/attach/회수/close와 기존 승인/연결/조회·취소/철회 경계를 실행했다. 파일 4개와 삭제 차단 정보 3개 전체 복원·ACL·재시작은 유지한다. 25개에는 기본 흐름이 포함되므로 일반 9개와 합산해 독립 34개로 세지 않는다.

이번 E 시험의 검사 상대는 **합성 scanner 응답 서버와 합성 decoder runtime**이다. 실제 `LocalClamAvClient`·`IsolatedMediaDecoder`·`MediaPreparation`·DB 원장을 새 조립 경로로 연결했으며 `localTestMode:true`/`FixturePreparation` 직접 우회는 제거했지만, 실제 ClamAV/FFmpeg 성공이나 OS 프로세스 격리/운영 서비스 성공은 아니다.

중간 UUID `76b4ec19-5057-44d7-96c7-96e14293ddb1`은 migration까지 3개 출력 후 프로세스 exit 1로 종료되고 최종 JSON을 생성하지 않았다. 원인은 확정하지 못했다. 당시 남은 postmaster PID 파일의 PID 5028은 실제 프로세스가 없음을 재확인했고 init-password 파일도 0개였다. 정상 종료를 입증하지 못한 이 경로는 삭제/채택/재시작하지 않고 진단 자료로 보존했다. 기존 성공 JSON을 이 실행의 결과로 오인하지 않았으며, 실제 실행 handle의 종료 확인 후 최종 새 UUID로 25개 전체를 다시 통과했다. 반복 25개를 서로 다른 종류의 증거로 중복 합산하지 않는다.

초기 조립 단위 시험 1개는 요청 설정과 catalog 대역의 기준 데이터가 같은 객체를 참조해 실패했다. 대역 데이터를 분리한 뒤 통과했으며 제품 검증을 완화하지 않았다. 마지막에는 반환된 트랜잭션 포트의 수명 제한과 거부 시험을 추가하고 전체 서버/최종 E를 다시 실행했다.

구문 검사·최종 정적 빌드·`git diff --check` 통과. 이번 코드/문서 17개의 공백/충돌 표식, 문서 9개의 내부 링크 145개와 최종 JSON의 UUID/결과/종료 상태를 대조했다. 공개 `dist`는 UI 자산 32개만 있고 원본과 바이트가 일치하며 서버/시험/문서/비밀정보 경로를 포함하지 않는다. 두 결과 JSON의 Git 제외를 확인했다. 최종 확인 시 PostgreSQL 프로세스 0개·운영 secrets 파일 0개·최종 두 fixture의 password 이름 임시 파일 0개였다. 중단 fixture의 정상 종료를 입증한 것으로 확대하지 않는다.

## 변경 파일

- 제품: [database-privileges.mjs](../server/database-privileges.mjs), 신규 [media-worker-service.mjs](../server/media-worker-service.mjs).
- 단위: 신규 [가드 계약](../server/tests/database-service-privileges.test.mjs), [조립 계약](../server/tests/media-worker-service.test.mjs), [catalog 대역](../server/tests/database-service-fixtures.mjs).
- E 시험: 신규 [서비스 연결 검사](../server/database-service-privileges-native-check.mjs), [작업자 검사](../server/database-worker-privileges-native-check.mjs), [Windows 진입점](../server/windows-postgres-check.mjs).
- 문서: 이 보고서·종전 v2 기록·작업자 lifecycle·README·서버 기반·완료표·E 저장·복구 준비·Windows 검증 후속 링크.

의존성·SQL/권한 정책 v2·인증/세션/담당 관계·HTTP/API·UI/브라우저 저장·기존 데이터·배포·유료 자원·Windows 계정/서비스·방화벽·운영 자격증명/키를 변경하지 않았다. 가상 DB/파일/사본은 오프라인 진단 자료로 남기며 재귀 삭제하지 않는다. 시험 키/비밀번호를 보관한 운영 백업이 아니다.

## 남은 위험과 다음 단계

1. **실제 자료 전환 게이트**: 별도 백업 매체·프로필 상실 후 키 회수·RPO/RTO/담당·보관/파기/경보가 필요하다. 같은 E 복원으로 대체하지 않는다.
2. **다음 비API 구성**: 역할별 자격증명 암호화 보관/회수·DB 연결 설정/TLS/HBA와 전용 OS 계정 경계. 이번 가드는 자격증명 보관 기능이 아니다. 운영 비밀번호 발급/서비스 활성화는 아직 하지 않았다.
3. E와 실제 native 검사 엔진의 결합·서비스 감독/종료/복구/전원 손실 및 중간 프로세스 종료 원인 조사. 권한 전체를 매 트랜잭션 조회하므로 운영 부하 측정도 필요하다. 권한/DDL 변경은 조용한 운영 작업 창에서 처리하며 검사 직후 악의적 관리자 변조를 원자적으로 봉쇄한다고 주장하지 않는다.
4. 별도 cluster 복원 후 최신 계정/담당 철회·삭제/검사 원장 대조·격리 해제/cutover. 기존 [격리](recovery-quarantine.md)는 동일 cluster 조건이며 이번 대상에 적용하지 않았다.
5. 접속 범위/운영 정책·사람과 실물 기기를 확정하고 **마지막 API·UI·기기 간 소통/재접속**을 연결한다. [전체 완료표](communication-acceptance.md)·[복구 게이트](recovery-readiness.md)는 진행 중이다.
