# Carebridge 실제 PostgreSQL 검증

2026-10-08 최신: [계정 보안 사건019](account-security-events.md)까지 적용한 실제 PG 명령은 **47개**다. 직전45개에 DB 제약으로 인한 자격/세션/사건 롤백과 보존 2개를 추가했다. UUID `1023ed35-615a-4887-96bb-dcb68a697aa7`, UTC `2026-10-07T14:59:06.190Z`, PG18.6/Node24.15.0에서 47/47·종료0·자기 일회용 자원 정리를 확인했다. 합성 내부 서비스 증거이며 HTTP/운영/독립 백업·사람/실물/P1 전체 완료는 아니다. 아래 수치는 각 단계 당시 기록이다.

작성일: 2026-10-03 · 갱신: 2026-10-04. **실제 PostgreSQL 18.6에서 아래 8개 시나리오가 통과했고 일회용 DB 정리까지 확인했다.** 초기 준비 시점에는 Docker가 준비되지 않았으나 후속 실행에서 확인했다. API·화면 서버 연결·운영 배포는 변경하지 않았다.

2026-10-04 후속: 새 Docker 화면은 약관 창이 아닌 Containers 대시보드였고 로컬 Linux 엔진 29.8.1이 실제로 응답했다. 에이전트가 약관·로그인·결제를 처리한 것은 아니다. 전용 합성 데이터 인스턴스를 구성해 시험했다. [복구 기록](local-runtime-setup.md#2026-10-04-시작-장애-진단과-복구)을 참고한다. 아래 2026-10-03의 미실행/회귀 결과는 당시 증거다.

2026-10-07 직전 명령은 **45개**, migration 018까지 적용했다. 아래 35개 + 기록 초안 1개 + [비밀번호 변경/세션 경합 9개](password-change.md)다. UUID `98f15d8b-e0ae-439b-9e58-644100c5a2ec`, PostgreSQL18.6/Node24.15.0에서 45/45·종료0·일회용 DB 및 자기 컨테이너/이미지 정리까지 확인했다. 앞선 엔진 pipe 부재 중단은 실패로 보존한다. 합성 내부 서비스 시험이며 운영 계정·HTTP·독립 백업·사람/실물·P1 전체 완료 증거는 아니다.

2026-10-06 당시 명령은 **35개**를 실행하며 016까지 적용했다. 기존 8개 + 원장 5개 + 준비 저장 5개 + 큐 5개 + 센터 자원 5개 + 명시적 보류 재개 4개 + 작업자 종료 3개다. 당시 최종 실행에서 자식의 실제 SIGINT 정상 종료, SIGTERM active drain/원본 바이트 보존, 종료 신호와 정산 오류가 겹친 실패 종료 및 임대 만료 후 새 인스턴스 회수·이전 정산 거부를 추가로 검증했다. 기존 재개 영수증/추가 권한 한 번·단일 승자·원 소유자 해제의 실제 행 잠금·정산 롤백/응답 유실과 센터 경쟁·큐 자식 SIGKILL·준비 증거/ready 롤백·현재 접근도 유지한다. 종료 코드 0과 일회용 DB/정확한 자기 컨테이너/worker 이미지 정리까지 확인했다. 새 종료 사례는 실제 private Linux tmpfs IO/합성 바이트와 controlled preparation을 사용하며 native AV/디코더나 운영 영구 매체/전원 장애 증거가 아니다. 나머지 파일 준비 증거는 SQL 경계용 합성 fixture다. 상세는 [작업자 종료·상태](media-worker-lifecycle.md), [016 보류 재개](media-work-reviews.md), [015 자원 제한](media-resource-limits.md), [014 큐 검증](media-work-queue.md), [013 저장 검증](media-preparation-storage.md) 및 [원장 검증](decoder-job-journal.md)을 참고한다. 아래 최초 8개는 당시 범위다.

## 목적과 검증 범위

기존 서버 테스트의 PGlite는 단일 연결로 처리하므로 실제 PostgreSQL 연결 간 잠금 경쟁과 연결 종료를 입증하지 못한다. `npm run test:postgres`는 별도 명시적 명령으로, 기존 운영용 `databaseFromPool`·마이그레이션·`Conversations`를 실제 `pg` 연결 풀 두 개에서 실행한다. 새 드라이버·HTTP 경로·검사 승인 우회는 추가하지 않았다.

2026-10-04에 실행·통과한 네이티브 시나리오는 다음 8개다.

1. 새 DB에 001~011 마이그레이션 적용 후 다른 풀의 재실행에서 추가 적용 0개 확인.
2. 동시에 체크아웃한 서로 다른 두 PostgreSQL 백엔드 PID 확인.
3. 같은 메시지 요청의 동시 재시도에서 메시지·순번·감사 이벤트가 한 번만 저장되는지 확인.
4. 같은 요청 ID에 서로 다른 내용이 동시에 전달되면 한 건만 성공하고 나머지는 `IDEMPOTENCY_CONFLICT`인지 확인.
5. 서로 다른 12건의 동시 전송에서 순번 1~12와 페이지 커서의 누락 없는 후속 조회 확인.
6. 동시에 처리한 읽음 위치의 단조 증가, 자신의 메시지 제외, 다른 보호자의 읽음 상태 분리 확인.
7. 시험 트랜잭션 자신의 백엔드만 커밋 전에 종료해 미확정 행 롤백과 풀의 후속 사용 확인. 종료 호출 도달·연결 종료 오류·해당 PID 소멸도 확인해 단순히 다른 풀 연결이 선택된 경우를 통과로 오인하지 않는다.
8. 참여 해제 커밋 후 이전 성공 요청의 재시도와 조회가 모두 거부되는지 확인. 담당 관계 변경과 전송이 경쟁하는 시험은 아니다.

## 실행 전제와 데이터 보호

- **합성 데이터 전용 로컬 PostgreSQL 인스턴스**를 사용한다. 운영 DB·원격 연결·실제 아동/사용자 자료는 금지한다.
- 주소는 리터럴 `127.0.0.1` 또는 `::1`, 명시적 포트 1024~65535만 허용한다. `localhost`·DNS 이름·다른 IP·URL 쿼리/fragment는 거부한다.
- 접속 DB는 `carebridge_integration_control`, 로그인은 `carebridge_test`로 고정한다. 비밀번호가 필요하며 실행 시에만 주입한다. `DATABASE_URL`·`.env`는 사용하지 않는다. 대상·SSL·검색 경로·제한 시간은 명시적 연결 설정으로 지정한다.
- 관리 DB의 소유자·현재 사용자·세션 사용자가 모두 `carebridge_test`여야 한다. 이 시험 전용 계정은 `CREATEDB`가 필요하지만 `SUPERUSER`, `CREATEROLE`, `REPLICATION`, `BYPASSRLS`는 허용하지 않는다. Docker 이미지의 기본 슈퍼유저를 그대로 전달하면 거부된다. 앱 운영 계정에 `CREATEDB`를 부여하라는 의미가 아니다.
- 서버 버전은 PostgreSQL 15~18 범위만 허용한다. 이 범위를 모두 검증했다는 뜻은 아니며 실제 실행한 버전은 후속 결과에 기록해야 한다.
- `CAREBRIDGE_POSTGRES_TEST_CONFIRM=create-disposable-local-database`라는 명시적 확인값이 없으면 연결 전에 종료 코드 1로 거부한다.

연결이 loopback이라는 사실만으로 로컬 인스턴스나 국내 보관이 증명되는 것은 아니다. 터널·프록시·변조된 로컬 서비스 여부와 전용 계정/DB 구성은 실행 전에 별도로 확인한다. 이 도구는 신뢰할 수 있는 시험 인스턴스에서의 오접속 방지 장치이며 악의적인 DB 관리자나 같은 권한의 다른 프로세스를 격리하는 보안 경계가 아니다.

## 일회용 DB 수명주기

매 실행마다 무작위 UUID-v4 기반 `carebridge_it_<32자리 hex>` DB를 `template0`에서 새로 생성한다. 기존 DB를 채택하거나 운영 DB를 복제하지 않는다. 일부 기존 마이그레이션은 보안상 `public` 검색 경로를 명시하므로, 임시 스키마로 SQL 의미를 바꾸지 않고 별도 DB의 원래 `public` 스키마에 그대로 적용한다.

시험이 끝나면 두 작업 풀을 모두 닫고, 이번 생성에서 받은 **DB 이름·OID·소유자 OID** 및 관리 DB/현재 계정을 다시 확인한 경우에만 해당 일회용 DB를 삭제한다. 관리 DB는 삭제하지 않는다. `FORCE`·다른 세션 강제 종료·기존 DB `TRUNCATE`·데이터 초기화는 사용하지 않는다. 연결 종료 실패·소유권 불일치·다른 활성 연결 등으로 정리가 거부되면 DB를 남기고 실패 종료한다. 생성 확인이 불완전하면 이름만 보고 삭제하지 않는다.

정리된 시험 DB는 복구용 백업을 만들지 않는다. 따라서 실제 자료를 넣어서는 안 된다. 잔존 DB가 출력되면 UUID 대상·소유자·활성 연결을 사람이 확인하고 처리한다. 이름 패턴에 해당하는 DB를 일괄 삭제하지 않는다.

DB 생성이 확인되면 안전한 시험 대상 이름을 먼저 출력한다. 프로세스 강제 종료·PC 장애에서는 자동 정리를 보장하지 않으므로 이 식별자를 기준으로 잔존 여부를 확인한다. 비밀번호·주소·원본 내용은 출력하지 않는다.

## 실행 방법

직접 `test:postgres`를 실행하려면 승인된 로컬 런타임에서 전용 시험 계정/관리 DB를 구성하고 엔진·포트 바인딩·비원격 연결을 확인한다. 아래 로컬 컨테이너 명령은 전용 인스턴스와 계정을 매번 생성한다. Docker 약관·로그인·결제·재부팅을 자동 처리하지 않는다. [로컬 런타임 준비](local-runtime-setup.md)를 참고한다.

Node.js 24와 서버 의존성이 준비된 저장소 루트에서 실행한다. 아래 주소는 **치환해야 하는 형식 예시**다. 실제 시험 비밀번호는 로컬 비밀 입력 경로로 주입하며 저장소·대화·명령 출력에 기록하지 않는다.

```powershell
# 주소 예시: postgresql://carebridge_test:<URL-encoded-test-password>@127.0.0.1:<local-test-port>/carebridge_integration_control
# CAREBRIDGE_POSTGRES_TEST_URL은 위 기준의 전용 시험 주소를 로컬에서 주입한다.
$env:CAREBRIDGE_POSTGRES_TEST_CONFIRM = 'create-disposable-local-database'
npm run test:postgres
```

설정 누락·허용하지 않은 대상은 `POSTGRES_TEST_CONFIGURATION`와 종료 코드 1로 거부된다. 실제 연결 불가·시험 실패·정리 실패도 성공으로 처리하거나 건너뛰지 않는다. 드라이버 오류 본문·비밀번호·URL을 출력하지 않고 고정 오류 코드와 안전한 시험 DB 식별자만 출력한다. 모든 시나리오가 끝나도 정리에 실패하면 종료 코드 1이다.

일반 회귀 명령은 기존대로 유지한다.

```powershell
npm run check
npm test
npm run test:server
npm run build
git diff --check
```

`npm run test:server`에 포함된 새 안전장치 테스트는 URL/확인값 검증, 가짜 관리 연결을 통한 생성·정리 보호, 별도 명령의 거부 동작을 확인한다. **네이티브 PostgreSQL 통과 수로 합산하지 않는다.** 정적 빌드는 이 도구·서버·문서·DB 드라이버를 공개하지 않는다.

### 2026-10-03 준비 단계 결과

- 안전장치 단위/명령 거부 시험 10개 통과. 생성/삭제 SQL은 가짜 관리 연결에서만 확인했으며 실제 DB를 생성하거나 삭제하지 않았다.
- `npm test` 61개, `npm run test:server` 218개 통과. 실패/취소/건너뜀은 모두 0이며 서버 합계는 기존 208개와 새 안전장치 10개다.
- 설정을 비운 `npm run test:postgres`가 `POSTGRES_TEST_CONFIGURATION`와 종료 코드 1로 거부되는 것을 별도 확인했다. 이는 예상한 안전장치 성공이며 네이티브 시나리오 통과가 아니다.
- `npm run check`, `npm run build`, `git diff --check` 통과. 정적 빌드에서 서버/문서 디렉터리·DB 시험 도구·시험 설정 코드 제외를 확인했다. Git의 LF→CRLF 안내는 있었으나 검사 오류는 없었다.
- UI·API·운영 저장 계층을 바꾸지 않아 이번 단계에서는 브라우저 시험을 다시 실행하지 않았다. 신규 의존성·실제 계정/DB·컨테이너·GitHub push/Vercel 배포는 추가하지 않았다.

## 2026-10-04 로컬 컨테이너 실행과 실제 결과

현재 Windows 사용자별 Docker 설치 경로와 `desktop-linux`의 로컬 named pipe만 사용하는 별도 명령이다. Node.js 24와 `npm --prefix server ci --ignore-scripts`로 준비한 의존성, 아래 공식 이미지가 로컬에 있어야 한다. 명령은 이미지 자동 다운로드·설치·로그인·기존 컨테이너 채택을 하지 않는다.

```powershell
npm run test:postgres:local
```

| 실행 구성 | 실제 사용 값 |
| --- | --- |
| 엔진 | Docker Desktop 4.93.0.240920 / Linux Engine 29.8.1, linux/amd64 |
| PostgreSQL | 공식 `18.6-alpine3.24`, digest `sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873` |
| 시험 Node | 공식 `24.15.0-alpine3.23`, digest `sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f`. 현재 PC의 개발 런타임과 버전을 맞췄으며 최신 운영 권장 버전이라는 뜻은 아니다. |
| DB 컨테이너 | `--network=none`, PostgreSQL은 내부 `127.0.0.1:5432`만 listen, 사용자 `postgres`, 읽기 전용 root, RAM 임시 볼륨 512MiB/4MiB/64MiB, 메모리·swap 상한 768MiB, CPU 1, PID 128 |
| 시험 컨테이너 | 이번 DB 컨테이너의 network namespace만 공유. 사용자 `node`, 읽기 전용 root, 메모리·swap 상한 256MiB, CPU 1, PID 64, 임시 공간 16MiB |
| 공통 제한 | 추가 capability 없음/모두 제거, `no-new-privileges`, host port·호스트 bind·기존 volume·Docker socket·원격 builder 없음. 자동 재시작/컨테이너 로그 저장 안 함. |

처음 시도한 internal bridge + Windows loopback publish에서는 Docker의 실제 `NetworkSettings.Ports`에 바인딩이 없었다. 요청 설정만 보고 성공으로 판단하지 않고 중단·정리했다. 안전 기준을 완화하거나 외부 네트워크를 연결하지 않고, **네트워크가 없는 DB 컨테이너 안의 loopback에 시험 컨테이너가 접속**하도록 변경했다. [Docker의 network namespace 공유](https://docs.docker.com/engine/containers/run/#network-settings)와 [포트 동작](https://docs.docker.com/engine/network/port-publishing/)을 참고한다.

`server/postgres-test.Dockerfile`과 전용 `.dockerignore`는 시험에 필요한 코드·마이그레이션·순수 JS DB 의존성만 로컬 builder에 전달한다. 문서·첨부·환경파일·PGlite 개발 의존성은 제외한다. 빌드 중 npm 설치/실행이나 파일 전송 API는 없고 작업 단계의 네트워크는 `none`이다. 기반 공식 이미지 캐시·허용된 코드의 빌드 캐시는 남을 수 있으므로 이를 모든 PC 데이터의 영구 삭제로 해석하지 않는다. 실제 임상 데이터를 빌드 경로에 추가해서는 안 된다.

관리 비밀번호는 매번 런타임에 생성해 자식 환경으로만 전달하고, worker가 별도의 시험 역할 비밀번호를 생성한다. SQL/명령 출력·파일·이미지에 저장하지 않는다. 컨테이너 관리 권한이 있는 사람은 실행 중 환경을 열람할 수 있으므로 호스트 관리자에 대한 비밀 보호 경계가 아니다. 해당 비밀번호는 운영 계정에 사용하지 않는다.

실제 연결 종료 시험에서 체크아웃된 pg 연결의 `error` 이벤트가 처리되지 않아 Node가 종료되는 결함을 재현했다. `server/database.mjs`에 사용 중인 연결의 오류 수신을 추가하고, 끊긴 연결은 재사용하지 않고 고정 `DATABASE_CONNECTION_LOST`로 실패한다. 정상 SQL 오류는 기존 롤백을 유지하며 자동 재전송·인증 약화는 없다. 오류 listener는 pool에 반환한 후 해제한다. 이 경로에 5개 회귀 시험을 추가했고 컨테이너 설정/소유권 안전장치 6개도 추가했다.

- 실제 PostgreSQL 8개 시나리오, 일회용 DB 잔존 0개 확인, 소유한 컨테이너/시험 이미지 정리까지 새 환경에서 **두 번 연속 종료 코드 0**으로 통과했다. 실제 PID 소멸·행 롤백·후속 연결 사용도 검증했다.
- 실패 원인 진단 중에는 worker 종료 코드 1과 남은 DB를 보존했다. 진단/수정 이후 생성 당시 full ID·이름·run label·이미지와 worker 종료 상태를 재확인한 3개 시험 세트만 정리했다. 합성 DB는 RAM-only이며 삭제한 내용을 복구할 백업은 없다. 현재 시험 label의 컨테이너·네트워크·worker 이미지가 없음을 확인했다. 공식 기반 이미지 캐시는 유지했다.
- `npm test` 61개, 기본 `npm run test:server`와 서버 제한 병렬 명령 `node --test --test-concurrency=2 tests/*.test.mjs` 모두 229개 통과(제한 병렬은 서버 폴더에서 실행). 최종 실패/취소/건너뜀 0. 합계는 기존 218 + 컨테이너 정책 6 + 연결 종료 회귀 5이며 네이티브 8개를 이 합계에 넣지 않는다.
- 첫 기본 병렬 `npm run test:server`는 `clamav-client.test.mjs` 파일 수준 프로세스 실패로 203개 통과/1개 실패였다. 이 파일 단독 26개, 제한 병렬 전체 229개 및 기본 명령 전체 재실행 229개는 통과했다. Windows 오류 이벤트에서 관련 Node 장애 기록을 찾지 못했고 최초 프로세스 실패 원인은 확정하지 않았다. 재실행 통과만으로 원인이 해결됐다고 주장하거나 실제 ClamAV 준비 완료로 해석하지 않는다.
- `npm run check`, `npm run build`, `git diff --check`와 정적 공개 산출물의 서버/문서/시험 설정 제외 검사를 통과했다. UI·API 연결·운영 계정·실제 사용자 파일·GitHub push/Vercel 배포는 변경하지 않았다. UI를 바꾸지 않아 브라우저 시험은 다시 실행하지 않았다.

현재 명령 성공 여부는 18개 통과 문구만이 아니라 **최종 종료 코드 0과 정리 확인**으로 판정한다. 실패/관찰 시간 초과/소유권 불일치에서는 자료 보존을 위해 컨테이너를 남길 수 있다. 해당 run의 full ID/label과 실행 상태를 확인해야 하며 `prune`·이름 패턴 일괄 삭제·임의 강제 종료는 하지 않는다. 연결 종료 시점의 불확정 커밋을 자동 재시도하는 기능도 없다.

### 변경 파일

- `server/database.mjs`, `server/tests/database.test.mjs`: 체크아웃된 연결의 오류 이벤트·폐기/실패 반환·listener 회수와 회귀 시험.
- `server/postgres-integration.mjs`: 실제 단절의 고정 오류 코드 허용, PID 소멸/롤백 증명 유지, 내용 없는 fatal 진단.
- `server/postgres-container-test.mjs`, `server/postgres-container-policy.mjs`, `server/postgres-container-fixture.mjs`: 로컬 엔진/이미지/builder 확인, 새로운 DB/worker 구성·격리·실행·소유권 정리.
- `server/postgres-test.Dockerfile`, `server/postgres-test.Dockerfile.dockerignore`, `server/tests/postgres-container-policy.test.mjs`: 고정 Node 이미지, 빌드 입력 allowlist와 정책 회귀 6개.
- 루트/서버 `package.json`: 기존 기본 시험을 유지하고 별도 `test:postgres:local` 명령 추가. 신규 의존성은 없다.
- `README.md`, `docs/local-runtime-setup.md`, `docs/postgres-integration.md`, `docs/server-foundation.md`, `docs/media-scanning.md`: 실제 복구·실행 증거와 아직 남은 범위 구분.

## 남은 한계와 다음 순서

위 실제 실행은 Docker 29.8.1/Windows 로컬 환경과 PostgreSQL 18.6의 합성 데이터에 한정한다. PostgreSQL 15~17·운영 TLS/권한·다른 OS/설치 경로·실제 배포 환경까지 검증한 것은 아니다. 테스트 도구의 타임아웃은 운영 트랜잭션 전체 시간 제한을 대신하지 않는다.

이 8개 시나리오만으로 커밋 성공 응답 유실, 프로세스/디스크 장애, 백업·복원, 운영 권한/TLS, 부하/지연, 담당자 변경 경쟁, 파일 엔진 또는 여러 실제 기기의 동기화를 입증하지 못한다. 소켓 단절 시나리오는 같은 서버 안에서 자신의 PostgreSQL 백엔드를 종료하는 시험이며 인터넷/모바일 통신 단절 시험도 아니다. 실제 검사 엔진·디코더·국내 운영/메일·복구 준비를 계속하고, API 및 화면 서버 연결은 사용자 요청대로 마지막에 진행한다.

설계 참고: [node-postgres 트랜잭션](https://node-postgres.com/features/transactions), [연결 풀](https://node-postgres.com/apis/pool), [PostgreSQL DB 생성](https://www.postgresql.org/docs/18/sql-createdatabase.html), [DB 삭제](https://www.postgresql.org/docs/18/sql-dropdatabase.html), [백엔드 종료 권한](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-ADMIN-SIGNAL).
