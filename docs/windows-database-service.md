# 암호화 자격증명 기반 PostgreSQL 서비스 연결

후속 [Windows 작업자의 DB 소유·종료·복구](windows-media-worker-lifetime.md)는 이 연결을 worker 목적에 고정하고 준비 단계부터 종료 요청을 받아 작업 drain 후 pool을 닫는다. 실제 합성 E32·서버638·로컬87 통과. 실제 OS 서비스/IPC·native 검사·독립 백업·마지막 API 성공은 아니며 아래 E30/625는 이 연결 구현 당시 증거다.

2026-10-07. **비API 준비 단계**다. 실제 Windows DPAPI 보관소에서 회수한 합성 비밀번호로 PostgreSQL에 직접 로그인하고 TLS·같은 연결의 역할/DB/OID·권한 검사를 통과하는 조립 경로를 구현했다. 운영 계정/서비스·실제 아동 자료·외부 접속·API/화면/배포는 활성화하지 않았다. 독립 백업 매체가 없으므로 실제 자료 전환은 계속 보류한다.

## 1. 현재 상태와 목적

직전 [자격증명 보관](windows-database-credential-store.md)은 암호화 저장/회수만 검증했고 실제 DB 로그인은 하지 않았다. 새 openWindowsDatabaseService가 보관·연결·입장 검사·종료를 연결한다. 기존 Node/PostgreSQL/E 구조를 유지하며 백엔드 아키텍처 스킬에 따라 연결 생성과 작업자 실행을 분리했다. Vercel 서비스/외부 저장소·새 의존성은 추가하지 않았다.

~~~text
역할·대상 계획 + 보관 ID + 명시적 로컬 endpoint
                  ↓
새 물리 연결의 비밀번호 callback → 전용 DPAPI 보관소
                  ↓
PostgreSQL 직접 로그인 + TLS 인증서/주소 검증
                  ↓
같은 연결의 DB/OID·로그인·전체 v2 권한 검사
                  ↓
내부 transaction 포트 · close · isAvailable
~~~

기존 저장소가 반환한 비밀번호를 테스트 코드만 수동으로 접속 문자열에 복사하는 방식이 아니라, 제품 연결 함수가 구체적인 보관소와 전용 pool을 직접 조립한다. 외부에서 password/store/pool/createDatabase/force를 넣는 옵션은 받지 않는다.

## 2. 설정·수명 계약

- 필수 설정은 storage, credentialId, privileges, kind, endpoint다. 기존 다섯 역할 계획의 owner는 연결 용도로 허용하지 않는다. 설정은 첫 await 전에 검증/캡처한다.
- DB 주소는 literal 127.0.0.1 또는 ::1과 명시적 정수 port만 받는다. localhost/DNS/다른 IP·socket·URL·누락된 기본값·추가 옵션을 거부한다. 이는 E 베타의 DB 연결 경계이고 보호자 웹 접속 범위를 정한 것은 아니다.
- 기본 transport는 TLS. 인증서 검증·최소 TLS1.2·명시적 IP의 SAN 검증을 적용한다. 사용자 정의 검증 함수/servername/rejectUnauthorized/sslmode/connectionString을 받지 않는다. 선택 CA는 유효한 단일 PEM 인증서만 받으며 OS 신뢰 저장소에 설치하지 않는다.
- synthetic-loopback 비TLS는 보관 설정에도 합성 UUID가 있을 때만 허용한다. 운영 secrets 경로와 결합할 수 없다. 테스트용 예외가 운영 기본값이나 원격 비암호화 접속으로 확대되지 않는다.
- endpoint/역할/DB/비밀번호 callback·SSL 협상·UTF-8·replication=false·search_path·application_name·연결/쿼리 제한을 명시한다. 실제 새 프로세스에서 관련 PG 환경값을 오염시켜도 이 설정으로 연결되는지 확인했다. 호출 프로세스의 환경 전체를 삭제했다고 주장하지 않는다.
- pool은 최대 2개, 연결 25초·쿼리 15초·idle 1초 제한이다. 비밀번호 callback은 새 물리 연결 때 회수하며 반환 Buffer는 finally에서 0으로 덮어쓴다. 이미 인증된 pool 연결 재사용 때마다 DPAPI를 다시 읽지는 않는다. 매 트랜잭션의 DB/역할/권한 검사는 재실행한다.
- 시작은 읽기 전용 입장 검사만 한다. 호출자에는 frozen transaction/close/isAvailable만 반환하며 원래 pool/client·비밀번호·보관소를 노출하지 않는다. DDL/GRANT·역할 변경·마이그레이션·작업자 loop·Windows 서비스/HTTP를 시작하지 않는다.
- isAvailable은 종료/백그라운드 연결 오류의 동기 상태 신호일 뿐이다. 새 로그인·현재 자격증명 파일·권한 또는 전체 서비스 준비 완료를 확인하지 않는다. 현재 권한은 매 transaction의 실제 가드 통과로 확인한다.
- close는 즉시 새 작업을 막고 pool drain과 이미 진행 중인 native 비밀번호 회수를 기다린다. 중복 close는 같은 Promise이며 자동 재연결/재시도는 없다. 늦게 회수한 비밀번호도 0으로 정리한다. close 오류는 종료 확인 실패이지 정상 종료 증거가 아니다. 내부 작업 콜백이 끝나지 않으면 drain도 기다릴 수 있다.
- 시작/보관/종료 오류는 DATABASE_SERVICE_UNAVAILABLE로 고정한다. 시작 후 권한 입장 실패는 기존 DATABASE_PRIVILEGES_UNAVAILABLE 계약을 유지한다. 업무 콜백의 내부 오류는 기존 동작대로 유지하므로 공개 서비스층에서 계속 안전하게 변환해야 한다.

동적 비밀번호 callback은 문자열을 반환해야 하므로 driver 내부의 인증된 client에는 비밀번호 문자열이 남을 수 있다. JS/GC 전체 메모리 소거를 보장하지 않는다. [node-postgres 연결 문서](https://node-postgres.com/features/connecting). 파일 삭제만으로 기존 로그인 세션을 철회할 수 없으며 새 ID 발급·DB 비밀번호/LOGIN 정책 변경·pool 종료 등 운영 회수/회전 절차는 아직 구현하지 않았다.

접속 URL의 SSL 옵션은 driver의 ssl 객체를 덮어쓸 수 있어 URL 자체를 받지 않는다. [node-postgres SSL 문서](https://node-postgres.com/features/ssl). pool 종료는 활성 연결을 drain하는 동작이므로 내부 작업/감독 정책도 필요하다. [pool 문서](https://node-postgres.com/apis/pool).

## 3. 실제 Windows/E 검증

~~~powershell
node --test server/tests/windows-database-service.test.mjs server/tests/database-service-privileges.test.mjs server/tests/windows-database-credential-policy.test.mjs
npm run test:database-privileges:e-drive -- --base E:/CarebridgeBeta --powershell C:\Tools\PowerShell\pwsh.exe --confirm-synthetic-e-drive
npm run test:postgres:e-drive -- --base E:/CarebridgeBeta --powershell C:\Tools\PowerShell\pwsh.exe --confirm-synthetic-e-drive
npm run test:server
npm test
npm run check
npm run build
git diff --check
~~~

PowerShell 경로는 실제 PowerShell 7 설치 경로로 바꾼다. 실행은 기존/중단 DB를 채택하지 않고 매번 새 UUID를 쓴다.

| 범위 | 결과 |
| --- | --- |
| 집중 단위 | **35/35**: 새 연결/수명 14·기존 가드 9·자격증명 정책 12. native 증거와 구분한다. |
| 최종 실제 DPAPI/PG/TLS·역할/worker·복원 | **30/30**, UUID cbcc0879-5a8d-4334-b0d1-33a303fa10b3, UTC 2026-10-07T04:32:40.948Z. 양쪽 cluster 정상 종료·가상 자격증명 8개/시험 TLS 파일 정리 true. |
| 전체 서버 | **625/625**, 실패/취소/건너뜀 0. |
| 로컬 단위 | **87/87**, 실패/취소/건너뜀 0. UI/새 브라우저·실물 검사는 없음. |
| 일반 E 저장/복원 | **9/9**, UUID 65d1a9da-f779-46ef-b4ca-cfb49cd7daa0, UTC 2026-10-07T04:37:41.821Z. 양쪽 cluster 정상 종료. role/자격증명/TLS 옵션 없는 경로 회귀다. |

30개는 직전 25개에 새 결합 5묶음을 더한 것이다. 최초 실행 49159d48-47a7-49ef-b9af-939fc310d9fc도 30개를 통과했지만 보강 전/후 반복을 독립 60개로 합산하지 않는다. 최종 보강판은 다음을 실행했다.

일반 E9는 30개의 기본 흐름과 겹치므로 독립 39개로 합산하지 않는다. 두 결과 JSON은 Git/배포 제외 test-results에 저장했다. 이번에 standalone DPAPI15/복구 키13이나 브라우저/실물/사람 검사를 재실행했다고 하지 않는다.

1. 실제 DPAPI로 네 역할 비밀번호 저장 → 제품 함수를 통한 SCRAM 로그인 → 실제 역할/session/DB·전체 v2 권한 검사. 비TLS는 명시적 합성 예외에서만 시험했다.
2. 비밀번호/접속 URL을 argv/env/평문 파일로 전달하지 않고 새 Node 프로세스가 네 암호문을 회수해 TLS 로그인했다. 관련 PG endpoint/비밀번호/SSL/encoding/options/replication 환경값 오염에도 실제 TLS/role/session을 확인했다.
3. 잘못 암호화한 비밀번호, 기대 역할 불일치, 잘못된 DB/owner OID, 앱 역할을 worker로 재표시한 계획을 거부했다. 메타데이터만 맞춘다고 실제 DB 권한 가드를 통과하지 못한다.
4. CA 없음/잘못된 CA와, 신뢰했지만 다른 IP의 인증서를 거부했다. 직접 driver probe에서 인증서 오류 코드만 대조하고 **비밀번호 callback 이전 실패**도 확인했다. 제품 함수의 오류는 계속 고정 코드였다.
5. 올바른 인증서 복원 후 실제 TLS 작업·종료·종료 후 접근 거부를 확인했다. 기존 전체 파일 7개(원본/후보 4·삭제 fence 3)와 권한/DB/복원/독립 재시작 검증은 유지했다.

임시 TLS 인증서·키는 소유 영수증이 있는 새 E 시험 경로에서 .NET으로 생성했다. Windows 인증서/신뢰 저장소에는 쓰지 않았다. PostgreSQL 테스트를 위한 임시 키 PEM은 보호된 시험 폴더에만 존재했고 두 cluster 종료 후 정확한 이름/해시/정상 파일/링크 아님을 확인해 개별 삭제했다. 가상 DPAPI 자격증명 8개와 빈 자기 UUID 폴더도 정리했다. 기존 자료나 중단 fixture를 삭제/초기화하지 않았다.

시험 인증서는 운영 CA 설계가 아니다. PostgreSQL은 TLS를 켜도 기본적으로 같은 포트에서 비TLS를 함께 받을 수 있으므로 운영 hostssl/HBA 정책은 별도 구성해야 한다. [PostgreSQL SSL 문서](https://www.postgresql.org/docs/18/ssl-tcp.html). 남겨둔 합성 source cluster의 설정은 삭제한 시험 TLS 키를 참조하므로 재시작 가능한 운영 백업이라고 하지 않는다.

## 4. 남은 위험·다음 순서

- 독립 매체 없음, 프로필/기기 상실 후 DPAPI/복구 키 회수, 최신 권한·삭제·검사 원장 대조/격리 해제·cutover 미완료. 같은 E의 복원 성공으로 대체하지 않는다.
- 전용 Windows 서비스 계정별 자격증명 격리·운영 TLS 인증서/HBA·회전/회수·실제 native 검사 엔진/worker 결합·supervisor/경보·재부팅/정전 검증이 필요하다. CurrentUser는 같은 사용자 프로세스/관리자 격리가 아니다.
- 기존 worker 시험은 합성 scanner/decoder 통신 상대를 사용한다. 새 연결 함수가 운영 worker/API 전체에 이미 강제된 것은 아니다. 전체 권한을 매 트랜잭션 조회하는 부하도 측정해야 한다.
- 이전 원인 미확정 PG 중단/키 회귀 실패는 [직전 진단](windows-database-credential-store.md)에 보존했다. 이번 두 E 성공으로 원인을 확정/해결했다고 주장하지 않는다.
- 실제 치료사/보호자·실물 기기 관측, 접속 범위/정책 선택, 마지막 API/화면·기기 간 전달/재접속은 미완료다. [전체 완료표](communication-acceptance.md)의 목표를 가상 시험으로 축소하지 않는다.

다음 비API 우선순위는 전용 OS 계정/서비스·worker 연결 소유권과 종료/복구 경계 준비다. 운영 계정 발급/서비스 활성화는 필요한 사용자 결정과 보호/복구 게이트 전에 하지 않는다. 독립 매체 확보 후 복구 리허설, 사람·실물 기기 확인을 거쳐 API를 마지막에 연결한다.

## 5. 변경 파일

- 제품: [서비스 연결](../server/windows-database-service.mjs). 기존 보관소/권한 가드를 재사용한다.
- 단위: [설정·수명 14개](../server/tests/windows-database-service.test.mjs).
- 실제 시험: [DPAPI/PG/TLS 결합](../server/database-credential-service-native-check.mjs), [합성 인증서 생성](../server/tests/windows-postgres-tls-fixture.ps1), [E 진입점/정리](../server/windows-postgres-check.mjs).
- 문서: 이 보고서와 README·완료표·E 저장·복구 준비·서버 기반·직전 자격증명/가드·Windows 검증 후속 링크.

의존성·SQL/권한 v2·사용자 인증/세션/담당 관계·UI/브라우저 데이터·배포·기존 E/Docker 자료·방화벽·Windows 계정/서비스는 변경하지 않았다. 전체 개편 목표는 진행 중이다.
