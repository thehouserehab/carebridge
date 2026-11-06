# 디코더 실행 원장·재시작 복구 기반

2026-10-04. 개편안 P1 첨부 처리 후속이다. **운영 서비스·업로드 대기열·파일 승인·기기 간 소통 완료가 아니다.** API/화면 연결은 마지막 단계로 유지한다. 실제 아동/건강 자료를 사용하지 않는다.

## 현재 문제와 선택

후속 [Linux 실행 경로·실제 복구 검증](linux-decoder-runtime.md)에서 PostgreSQL 원장과 실제 per-file container를 결합한 8개를 추가했다. 별도 프로세스 SIGKILL·자연 임대 만료·새 owner/실행기 회수·다음 정상 처리까지 확인했다. 아래 원장 단계의 가상 runtime/시각 fixture 결과와 분리하며, 운영 서비스·daemon/PC 재부팅·전체 장애 행렬을 검증했다는 뜻은 아니다. 최신 서버 회귀는 326개다.

[파일별 격리 실행](decoder-job-isolation.md)은 이미 원본 바이트와 파일명을 분리하고 actual worker 종료·자기 자원 정리를 확인했다. 그러나 생성/정리 영수증이 호출 프로세스의 메모리에만 남았다. 종료된 인스턴스의 메모리가 없으면 잔존 작업을 찾기 어렵고, 여러 인스턴스가 각자의 최대 2개를 사용하면 전체 한도가 늘어난다.

파일 본문을 새 queue에 복사하거나 임의 label의 모든 컨테이너를 채택하지 않는다. `server/decoder-journal.mjs`의 `DecoderJobJournal`과 새 **012 마이그레이션**으로, 실행 허가/소유권/전체 컨테이너 ID만 PostgreSQL에 저장한다. 기존 001~011 SQL/checksum과 기존 아동·기록·공유본·첨부·인증 행은 변경하지 않는다.

저장 열은 run UUID, 승인 engine/image, worker owner UUID, generation, phase, container ID, 복구 필요 여부, lease 및 생성/정리 시각이다. 파일명·MIME·아동/계정/센터/업로드 ID·파일 해시·캡션·내용·검사 결과·오류 원문은 저장하지 않는다. 기존 임시 파일의 소유권·검사 임대는 `MediaUploads`가 계속 담당한다. 실행 원장을 업로드 접근 권한으로 사용하지 않는다.

두 표 모두 `PUBLIC` 권한을 회수했다. 운영에서는 별도의 worker DB 역할에만 필요한 권한을 부여하고 **앱 DB 계정이 owner/superuser이거나 새 표 접근 권한을 상속하지 않도록 별도 확인**해야 한다. 운영 역할/TLS/암호화·backup·접속 timeout을 실제 구성했다는 의미는 아니다.

## 상태와 안전 규칙

| 원장 상태 | 확인된 사실 | 복구 처리 |
| --- | --- | --- |
| `reserved` | slot 확보. create 허가는 아직 저장하지 않음 | 소유권 전환 뒤 닫을 수 있음. 엔진 장애여도 원본/컨테이너에 손대지 않음 |
| `creating` | create 허가 저장. create 발행/응답은 불명확할 수 있음 | 정확한 UUID name·label·image의 container를 실제 발견/검증해야 full ID를 붙임. 발견되지 않았다는 이유로 slot 해제/재생성 금지 |
| `attached` | 실제 소유권 확인 후 전체 ID를 저장했고 start 전 DB 응답도 확인 | 같은 engine의 해당 full ID만 종료/정리. 삭제 응답 유실은 성공한 full-ID listing·같은 engine 재확인의 부재 증거로 회수 가능 |
| `closed` | create 미허가 또는 자기 container 정리 확인 뒤 저장한 receipt | 불변. 늦은 호출을 새 create 권한으로 바꾸지 않음 |

새 run의 `reserve()`는 동일 engine row를 잠그고 전체 unclosed 작업 수와 복구 필요 상태를 확인한다. 상한은 DB에 고정한 1~2개다. lease가 만료된 작업도 slot을 차지하며 만료만으로 다시 실행하지 않는다. 복구 필요/만료 작업이 하나라도 있으면 새로운 작업을 막는다. INSERT trigger도 같은 경계를 검사해 직접 SQL 우회를 거부한다. 서로 다른 DB/engine으로 원장을 분산 구성하면 이 전역 한도는 공유되지 않는다.

create 전에 `creating` 전환을 저장/확인하고, run당 **한 번만 create**한다. timeout/응답 유실을 이유로 같은 create를 재시도하지 않는다. full ID·소유권·격리를 확인하고 `attached`를 저장/확인한 뒤에만 stdin payload를 보낸다. 원장 저장 실패가 성공한 파일 처리나 생성 허가처럼 취급되지 않는다.

owner UUID는 서비스 인스턴스 식별자이며 인증 토큰이 아니다. 기본 새 UUID를 사용하고 요청/사용자가 선택하지 않는다. lease는 DB 시각을 사용해 기본 180초(구성 상한 600초)이며 실행 중 최대 한 건씩 10초 heartbeat를 갱신한다. heartbeat 실패/만료/소유권 변경은 입력을 중단하고 결과를 폐기한다. 호스트/DB의 시각 동기화와 유한한 pool connection/statement/lock timeout은 운영 요구다.

다른 owner는 유효한 lease를 빼앗지 않는다. 복구 시 generation을 증가시키고 `requires_recovery`를 설정한다. 이전 generation의 attach/heartbeat/close와 늦은 정상 응답은 거부한다. 일반 처리도 정리 단계에서는 heartbeat를 멈추고 자신의 복구 lease를 확보한 뒤 정리한다. 원장 갱신을 worker 실행 이후 자동 인증 우회로 사용하지 않는다.

원장 reserve 결과를 받지 못했어도 동일 engine row lock 뒤에 조회해 이전 트랜잭션의 결정을 확인한다. 해당 run의 원장이 없고 **그 인스턴스가 create를 발행하지 않았을 때만** 미실행 intent를 정리한다. 생성 요청을 이미 발행했거나 복구에서 얻은 불명 `creating` 작업에는 이 규칙을 적용하지 않는다. 실패한 inspect/listing을 없다는 증거로 바꾸지 않는다.

`recoverRetained()`는 현재 인스턴스가 쉬고 있을 때 DB의 자기/만료 run을 최대 100개씩 읽는다. 과거 인스턴스 메모리나 broad label scan에 의존하지 않는다. 실제 ownership/image/engine 확인은 기존 실행기가 담당하며 타인·다른 engine의 컨테이너를 정지하지 않는다. 아직 진행 중인 다른 owner 작업은 정리하지 않는다.

## 명시적 사용과 기존 경계

원장 연결은 신뢰된 내부 구성이며 환경변수/HTTP로 자동 활성화하지 않는다. 같은 승인 engine/image와 원장 capacity에 맞는 `DecoderJobJournal` 인스턴스를 `IsolatedMediaDecoder`의 `journal`에 주입한다. 별도 worker service가 소유하며 웹 서비스에 engine socket/관리자 권한을 주지 않는다.

`journal:null`은 이전 합성/로컬 시험 호환 경로다. 프로세스 간 한도/재시작 저장이 없으므로 **운영 준비된 경로로 사용하면 안 된다.** 기존 실제 decoder 28개 시험은 이 경로의 native regression이며 PostgreSQL과 실제 Docker를 합친 운영 장애 시험을 했다고 표시하지 않는다. 원장을 연결한 실행기 시험은 PGlite 실제 트랜잭션 + 가상 Docker runtime으로 수행했다.

engine configuration과 image binding은 불변이다. 이미지 교체는 승인 재검토·기존 작업 확인·통제된 운영 마이그레이션이 필요하며 자동 회전 기능은 없다. closed receipt도 현재는 자동 삭제하지 않는다. 원장 보존/아카이브·백업/복원 정책과 계정별 권한은 운영 준비에 남아 있다. 원장에는 health payload가 없지만 운영 메타데이터라고 해서 무제한 공개해도 되는 것은 아니다.

## 검증 범위·실패 이력

명시적 재현 명령:

```powershell
node --test server/tests/decoder-journal.test.mjs server/tests/decoder-jobs.test.mjs
npm run test:server
npm run test:postgres:local
npm run test:decoder-jobs:local
npm test
npm run check
npm run build
git diff --check
```

새 계약 시험은 원장 13개, 실행기 연결 10개, 읽지 않은 입력의 즉시 중단 1개로 총 **24개**다. 기존 실행기 21개를 포함한 관련 시험은 **45개**다. SQL/commit·부분 실패·full ID·권한 기본값·동시 slot·만료·소유권/generation·불명 생성·늦은 결과·미실행 예약·새 인스턴스 복원·삭제 응답 유실·불명 listing·실제 10초 heartbeat 실패 시 입력 중단을 확인한다. 실제 DB 트랜잭션을 실행하지만 PGlite는 단일 연결이고, Docker는 이 연결 시험에서 가상 runtime이다.

별도 **실제 PostgreSQL 18.6** 시험은 기존 8개와 다음 원장 5개를 합쳐 **13개**다:

1. 다른 native pool에서 8개 예약을 경쟁시켜 2개만 성공.
2. 만료 후 소유권/generation 전환과 이전 heartbeat/attach/close 거부.
3. 불명 `creating` 작업은 lease가 만료돼도 slot을 자동 반환하지 않음.
4. 실제 commit 뒤 호출 wrapper에서 응답 유실을 주입하고 다른 pool에서 저장된 상태 확인.
5. 동시 복구 경쟁에서 한 owner만 성공하고 이전 generation 거부.

위 원장 단계의 lease 만료는 시험 DB의 시각 fixture로 조정했다. owner/실행기의 새 인스턴스 복원은 같은 테스트 프로세스 안에서 검증했다. **위 시험 자체는 실제 worker 강제 종료/PC 재부팅·Docker daemon 중단·운영 pool 단절·원장과 실제 decoder의 종합 재시작 시험이 아니다.** 별도 Linux 후속의 실제 SIGKILL/자연 만료 결과와 혼동하지 않는다. commit wrapper의 응답 유실은 네트워크 전 구간의 packet loss를 재현했다는 뜻도 아니다.

최초 연결 시험에서는 slot 예약 거부를 받은 새 인스턴스가 DB에 존재하지 않는 임시 intent를 남겨, 다른 잔존 작업의 복원을 막았다. create 발행 여부를 별도로 추적하고 engine row lock 뒤 원장을 조회하도록 수정했다. 미발행·원장 없음만 정리하고 불명 생성은 계속 막는 차이를 유지했다. 수정 뒤 모든 관련 시험이 통과했으며 실패를 성공 처리하지 않았다.

그다음 실제 10초 heartbeat 시험은 처음 실패했다. 소유권을 잃은 입력을 `destroy(error)`로 중단한 직후 `closed`만 보고 오류 리스너를 제거했기 때문이다. Node.js 24.15.0에서는 아직 오류 이벤트를 내보내지 않은 스트림도 이때 `closed === true`일 수 있다. 별도의 최소 재현에서도 처리되지 않은 오류로 프로세스가 종료되는 것을 확인했다. `finished(source, { cleanup: true })`가 실제 종료/오류/닫힘을 관찰하도록 바꾸었고, 원문 IO 진단은 외부로 전달하지 않는다. 생성 전 즉시 취소하는 일반 `Readable`도 시험한다. 이 변경은 오류를 성공으로 바꾸지 않으며 이전 소유자의 결과/정리를 계속 거부한다.

2026-10-04 후속 검증에서 관련 **45개**와 서버 전체 **312개**, 로컬 **61개**, 문법 검사·정적 빌드·`git diff --check`가 통과했다. 실제 PostgreSQL의 **13개**와 해당 임시 DB/컨테이너/worker 이미지 정리도 다시 통과했다. 수정된 호스트 실행기로 파일별 최소 디코더 **28개** 및 자기 컨테이너/시험 이미지 정리까지 다시 통과했다. 이 native 디코더 시험은 `journal:null` 경로이며, DB 원장과 Docker의 종합 장애 검증으로 확대하지 않는다. 과거 288개/8개 결과를 현재 범위와 혼동하지 않는다.

이 후속 수정의 코드 변경은 `server/decoder-jobs.mjs`와 `server/tests/decoder-jobs.test.mjs`다. 실제 입력 종료 관찰을 고친 것이며 SQL/checksum·엔진 binary·승인 기준·로그인/권한·API·화면·배포는 변경하지 않았다. README와 서버 기반/디코더 격리/이 문서의 현재 시험 수를 갱신했고, 로컬 실행환경 문서에는 실제 확인한 Resource Saver 재개를 기록했다.

## 변경 파일과 다음 순서

- 신규: `server/decoder-journal.mjs`, `migrations/012-decoder-journal.sql`, `tests/decoder-journal.test.mjs`, `decoder-journal-native-tests.mjs`.
- 실행 연결/검증: `server/decoder-jobs.mjs`, `tests/decoder-jobs.test.mjs`, `postgres-integration.mjs`, `postgres-container-test.mjs`, `postgres-container-fixture.mjs`, `postgres-test.Dockerfile`/`.dockerignore`.
- 기존 10개 DB 시험 파일: 기존 데이터 보존 검증은 유지하고 적용 목록 끝에 012만 추가. 001~011 migration이나 기존 계정/임상 정책은 수정하지 않음.
- 현재 상태 문서: 이 문서, `README.md`, `server-foundation.md`, `decoder-job-isolation.md`, `postgres-integration.md`, `media-upload-storage.md`.

이후 Linux transport의 명시적 실행 경로와 실제 프로세스 장애 회수 사례는 별도 후속에서 구현/검증했다. 다음은 metadata/변환본·안티멀웨어 결합 및 durable 업로드 대기열/취소 → 국내 저장/암호화·메일/계정 복구·backup/restore → 마지막 API/화면 연결·두 기기의 전송/재접속 검증 순서다. 운영 서비스 배치/감독과 전체 장애 행렬도 남아 있다. P2 알림/검색은 사용성 검증에서 필요한 범위를 확인한 뒤 진행한다. 전체 개편안/P1은 계속 진행 중이다.
