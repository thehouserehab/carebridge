# Windows DB 서비스 자격증명 암호화 보관

후속 [실제 PostgreSQL 서비스 연결](windows-database-service.md)은 이 보관소의 가상 비밀번호로 실제 PG 로그인·새 프로세스 TLS/CA/IP 검증·연결 가드·종료를 확인했다. 합성 E 30·서버 625·로컬 87 통과. 운영 발급/OS 격리·독립 백업·API는 아직이다. 아래 DPAPI15/키13/611은 보관 단계 당시 결과이며 이번 후속에서 해당 standalone 명령을 재실행하지 않았다.

2026-10-07. **비API 내부 보관 모듈의 구현·합성 검증**이며 운영 비밀번호 발급/DB 로그인/서비스 시작/전체 개편 완료가 아니다. 독립 백업 매체가 아직 없으므로 실제 아동 자료 전환은 계속 보류한다. 유료 저장소·외부 접속을 만들지 않았다.

## 현재 상태와 변경 이유

[다섯 DB 역할과 연결 가드](database-service-admission.md)는 실제 로그인·DB/OID·권한을 검사하지만 비밀번호 보관 기능은 없었다. 복구 묶음 키를 DB 비밀번호 저장에 재사용하지 않고 별도 보관 모듈을 추가했다. 백엔드 아키텍처 스킬에 따라 보관·DB 입장 검사·작업자 시작을 서로 다른 책임으로 두고 기존 Node/PostgreSQL/E 구조·API 마지막 순서를 유지했다. Vercel 자원은 추가하지 않았다.

| 목적 | 계약 | 전용 경로 |
| --- | --- | --- |
| 복구 키 | 기존 32바이트·CurrentUser | private/secrets/recovery-keys |
| DB 비밀번호 | runtime/bootstrap/backup/worker만·CurrentUser | private/secrets/database-credentials |
| 합성 검사 | 새 UUID·가상 비밀번호/키만 | private/checks/credential-check-UUID 및 key-check-UUID |

최종 확인 시 **운영 secrets 파일 0개, PostgreSQL 프로세스 0개**였다. 자기 UUID의 합성 파일과 빈 폴더만 정리했으며 기존 아동/브라우저/DB 자료를 삭제하지 않았다. 실패 경로는 보존한다.

## 보관 계약

- 내부 API는 store(id, privileges, kind, password) / load(id, privileges, kind). 기존 v2 계획의 다섯 역할·DB 이름/OID/owner OID/확인값에서 바인딩을 도출한다. owner/알 수 없는 종류·중복/누락 역할·잘못된 계획을 거부한다.
- 비밀번호는 새 서비스용 **32~1024바이트 printable ASCII Buffer**만 받는다. 문자열·NUL·공백/제어문자·다중바이트를 받지 않는다. 길이가 난수 품질을 증명하지는 않는다. 생성기는 이번 범위가 아니며 사람/기존 비밀번호를 임의 변환하지 않는다.
- 역할 종류/이름·DB 이름/OID/owner OID와 UUIDv4·목적/범위/시각/Windows SID를 DPAPI 추가 엔트로피에 포함한다. 암호문 메타데이터와 기대 설정을 함께 바꾸어도 새 역할/DB로 재표시할 수 없다.
- 설정·계획·비밀번호 바이트를 첫 await 전에 캡처한다. 입력 Buffer는 호출자 소유다. load가 반환한 Buffer도 호출자가 finally에서 0으로 덮어써야 한다. 내부 복사/프레임/byte array는 정리하지만 JS/.NET 문자열·GC 메모리의 완전 소거는 보장하지 않는다.
- 배타적 생성·fsync·핸들/경로 동일성·ACL을 확인하며 덮어쓰지 않는다. 읽기는 크기/strict UTF-8/정규 JSON/중복 속성/링크를 검사한다. 불확실한 쓰기 후 암호문 자동 삭제/초기화/채택/재시도를 하지 않는다.

보관 메타데이터는 실제 DB 인증/권한 증거가 아니다. 미래 연결 조립자는 회수한 비밀번호로 직접 로그인하고 기존 databaseForService의 실제 같은 연결 검사도 통과해야 한다. .env fallback·접속 URI·실제 비밀번호 발급/ALTER ROLE·TLS/HBA 변경·운영 CLI/계정/서비스·HTTP/API는 이번에 만들지 않았다.

## 보안 경계와 한계

고정 native provider를 비대화형·20초 제한·16KiB 프레임으로 실행한다. 비밀번호는 argv/env/평문 파일이 아닌 pipe로 전달한다. 자식 환경은 Windows 필수 값만 허용하며 DB 자격증명·NODE_OPTIONS·PSModulePath·기존 PATH를 상속하지 않는다. 오류는 고정 코드 WINDOWS_DATABASE_CREDENTIAL_UNAVAILABLE이고 원래 오류/SQL/경로/암호문을 cause나 로그에 넣지 않는다.

E/정상 NTFS·기존 private 소유 영수증과 운영자/SYSTEM/Administrators ACL을 공통 저장 정책으로 확인한다. 모르는 폴더를 채택하거나 넓어진 권한을 자동 고치지 않는다. 복구 키와 파일/프로세스 IO만 공통화했으며 목적별 provider·엔트로피·영수증·스키마는 분리했다. 복구 키의 기존 목적·32바이트·CurrentUser 계약은 유지한다.

DPAPI CurrentUser는 보통 동일 로그인 자격과 기기에 결합하며 추가 엔트로피는 복호화에도 동일해야 한다. [Microsoft DPAPI 문서](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata). **같은 Windows 사용자의 다른 프로세스/관리자와의 격리 수단은 아니다.** 네 DB 역할을 같은 OS 사용자로 보관한 시험이 전용 OS 계정별 격리를 입증하지 않는다. LocalMachine fallback은 없다.

암호문 파일만 다른 디스크에 복사해도 프로필/기기 상실 후 복구가 보장되지 않는다. 독립 매체·복구 키 회수·OS 계정 상실/재부팅/정전 검증은 필요하며 같은 E의 암호문/복원 폴더는 독립 백업이 아니다.

## 실행한 검증

~~~powershell
node --test server/tests/windows-database-credential-policy.test.mjs server/tests/windows-recovery-key-policy.test.mjs
npm run test:database-credentials:e-drive -- --base E:/CarebridgeBeta --powershell C:\Tools\PowerShell\pwsh.exe --confirm-synthetic-credential-store
npm run test:recovery-keys:e-drive -- --base E:/CarebridgeBeta --powershell C:\Tools\PowerShell\pwsh.exe --confirm-synthetic-key-store
npm run test:server
npm test
npm run check
npm run build
git diff --check
~~~

PowerShell 7 경로는 실제 설치 경로로 바꾼다. native 명령은 새 UUID만 생성한다.

| 범위 | 결과 |
| --- | --- |
| 집중 정책 단위 | **22/22**: 새 자격증명 12·기존 키 10 |
| 전체 서버 | **611/611**, 실패/취소/건너뜀 0 |
| 로컬 단위 | **87/87**, 실패/취소/건너뜀 0. UI/새 브라우저·실물 검사는 없음 |
| 새 Windows/E 자격증명 | **15/15**, UUID 8fabe47e-7d6c-452c-8ea0-62c618a60bfa, UTC 2026-10-07T04:07:21.007Z, cleanup true |
| 기존 Windows/E 복구 키 최종 회귀 | **13/13**, UUID 23d4ed40-dd96-4a87-b7d6-807cce8fe136, UTC 2026-10-07T04:09:00.587Z, cleanup true |

새 E 검사는 네 역할 암호문 저장·독립 프로세스 재읽기, await 전 스냅샷, 덮어쓰기·기대 설정 변경·암호문 재표시 거부, 범위/SID/시각/ID/암호문 변조, **실제 복구 키↔DB 자격증명 암호문의 양방향 교환 거부**, 중복 JSON/잘못된 UTF-8, 하드링크/권한 확장/미소유 폴더/junction, native 잘못된 요청·owner/문자열 입력 거부를 확인했다. 마지막에 다섯 가상 자격증명을 다시 읽었다.

PowerShell provider 2개·공통 정책·합성 ACL fixture의 AST 4개, JS 구문·정적 빌드·공백 검사도 통과했다. 결과 JSON은 Git/배포 제외 test-results/에 저장한다. 직전 **PG25/일반 E9는 이번에 재실행하지 않았다**. DPAPI15를 PostgreSQL 인증/복원 시나리오라고 부르지 않는다.

최종 코드/문서 18개 공백·충돌 표식, 문서 7개의 내부 링크 144개와 결과 UUID/시각/정리 상태를 대조했다. 공개 출력은 원본과 동일한 UI 자산 31개와 build.json 1개이며 서버/문서/시험/비밀정보 경로를 포함하지 않는다. 두 결과 JSON의 Git 제외도 확인했다.

## 실패·진단 기록

복구 키 첫 회귀 UUID 27c6ded0-fc3f-4789-8d86-8fe2550839bd는 저장 1개 후 재읽기 구간에서 실패했다. 상세 단계 진단이 없어 같은 프로세스/독립 reader 중 어느 지점인지 확정하지 못했다. 이후 해당 암호문은 두 프로세스에서 32바이트로 읽혔지만 **실패 원인을 확정/수정했다고 주장하지 않는다**. 암호문·영수증을 보존하고 단계명/reader 종료코드·고정 출력 여부만 기록하도록 보강한 후 새 UUID에서 13개를 통과했다. 오류 원문/키/평문을 진단으로 출력하지 않았다.

직전 PG 중단 UUID 76b4ec19-5057-44d7-96c7-96e14293ddb1도 보존했다. 해당 시각 Application 오류 이벤트 추가 조회에 일치 결과가 없고 현재 PG 프로세스도 0개였지만 원인이나 정상 종료를 입증하지 않는다. 원인 미확정 종료/일시 실패는 운영 전 해결할 위험이다. 기존 성공 JSON을 실패 실행의 증거로 쓰지 않는다.

## 변경 파일·다음 순서

- 제품: [자격증명 정책](../server/windows-database-credential-policy.mjs), [보관 모듈](../server/windows-database-credential-store.mjs), [전용 native provider](../scripts/windows-database-credential-provider.ps1).
- 공통화: [Windows 비공개 IO](../server/windows-private-secret-io.mjs), 기존 [복구 키 보관](../server/windows-recovery-key-store.mjs)·[정책](../server/windows-recovery-key-policy.mjs).
- 검사: [새 E 검사](../server/windows-database-credential-check.mjs), [단위 12개](../server/tests/windows-database-credential-policy.test.mjs), 기존 [ACL fixture](../server/tests/windows-recovery-key-fixture.ps1)·[키 진단](../server/windows-recovery-key-check.mjs), [npm 명령](../package.json).
- 연결 문서: README·E 저장·서버 기반·완료표·복구 준비·직전 연결 보고서. 의존성·SQL/권한 v2·인증/세션·UI·기존 데이터·배포는 변경하지 않았다.

우선순위는 ①원인 미확정 종료 진단/재현·회수한 가상 비밀번호로 실제 PG 직접 로그인+가드 결합 ②전용 OS 계정/서비스·TLS/HBA·native worker 조립/감독 ③독립 매체·프로필 상실 키 회수·최신 권한/삭제 대조와 복원/cutover ④사람·접속 범위/실물 기기 확인 ⑤**마지막 API·화면 연결**이다. 운영 비밀번호/계정은 필요한 사용자 결정과 보호/복구 게이트 전에 발급하지 않는다. 전체 목표는 진행 중이다.
