# Windows 가상 자료 전용 PostgreSQL·미디어 API 연결

작성 2026-10-09. 이 문서는 별도 로컬 API 자식 프로세스와 실제 검사 작업자를 연결하는 합성 자료 시험 범위를 설명한다. **원 개편안 전체 완료, 실제 아동 자료 수집, 외부 접속·배포 승인을 뜻하지 않는다.**

후속 구현은 [가상 사진·영상 송수신 화면](local-prepared-media-ui.md)을 따른다. 신뢰된 native 시험 실행기에 명시적 `prepared` 화면이 추가됐다. **아래는 그 이전 API-only 단계의 구현·54개 시험·실패 보존 기록**이며 최신 파일 수·화면·검증 결과로 혼용하지 않는다. 기본 메모리/격리 실행기와 Windows 서비스의 기본 API-only 모드는 유지된다.

## 현재 상태와 기존 화면의 차이

| 구분 | 기본 로컬 화면 | 이번 Windows 연결 시험 |
| --- | --- | --- |
| 실행 | `npm run dev:local-api` | `test:native-worker:e-drive`의 소유 API 자식 프로세스 |
| DB | 실행마다 사라지는 메모리 PGlite | 새 가상 E 시험 클러스터의 실제 PostgreSQL |
| 화면 | 기존 홈·대화·기록·아이 정보, 격리 업로드 안내 | **API-only**: `/`를 포함한 정적 화면 요청은 404 |
| 미디어 | 비공개 격리 업로드·상태 확인·취소 | 별도 실제 작업자 검사 후 승인 후보 연결·인증 열람 |
| 증거 | 기존 UI 회귀와 메모리 DB 시험 | 최종 실제 E 결합 시험 54/54 통과; 준비 첨부 화면 검증은 별도 |

기본 실행기에 검사 성공 대역이나 자동 승인 기능을 넣지 않았다. 준비 완료 파일을 선택·전송·열람하는 브라우저 UI는 아직 연결하지 않았으며, 이번 API 시험을 그 화면의 완료 증거로 사용하지 않는다.

## 프로세스와 책임 분리

```text
새 가상 E 시험 소유자
  ├─ API 자식: runtime DB 계정 → 공통 루프백 listener → 기존 도메인 서비스
  └─ 검사 작업자 자식: worker DB 계정 → 실제 ClamAV·FFmpeg → 후보·증거 저장
시험 HTTP 클라이언트 → 로그인 → 예약·수신 → 준비 상태 → 메시지 연결 → 인증 파일 읽기
```

1. 시험 소유자가 매 실행 새 가상 센터·관리자·보호자·치료사·아동·대화와 전용 디렉터리를 준비한다. 부모의 owner 연결은 새 센터 bootstrap과 그 센터의 시험 자원 정책에만 사용하고, 초대·수락·아동·관계는 runtime 서비스로 구성한다. 기존 시험 센터나 사용자의 역할을 변경하지 않는다.
2. API 자식은 고정 진입점과 상속 IPC로만 시작한다. 부트스트랩에는 검증된 DB 설정·자격증명 ID·전용 미디어 루트만 전달한다. 평문 DB 암호, 임의 실행 파일·명령, 검사 어댑터나 caller-selected DB 역할을 받지 않는다.
3. `createWindowsLocalApiService`는 `openWindowsDatabaseService(..., kind: 'runtime')`를 사용한다. 기존 DPAPI 자격증명 저장소, 명시적 TLS CA, DB 대상·역할·권한 확인을 재사용하며 환경변수의 임의 DB 주소로 대체하지 않는다.
4. 기존 `Auth`·`Conversations`·기록·피드백·목표·일정·미디어 서비스를 조합한다. API 안에서 마이그레이션·seed·Docker 실행·검사·직접 파일 삭제를 수행하지 않는다.
5. API의 `MediaUploads`에는 `preparation: null`을 사용한다. 실제 검사와 후보 생성은 별도 작업자 책임이며, 승인 증거 없는 업로드를 메시지에 붙일 수 없다.
6. `mediaMaintenance: 'worker'`는 취소·삭제 의도를 DB 상태로 남기되 API에서 정리 콜백을 호출하지 않는 명시적 모드다. 실제 파일 정리와 후속 상태 전이는 작업자가 맡는다. 무동작 콜백을 성공한 정리처럼 사용하지 않는다.

## 루프백·인증·파일 경계

- 공통 `createLocalApiListener({ port, services, screen })`는 `127.0.0.1`만 수신한다. origin·쿠키 이름은 내부에서 생성하고, 첫 비동기 작업 전에 허용된 서비스 맵을 캡처한다. 임의 host·파일 경로·요청 처리기·환경 옵션은 받지 않는다.
- 기본 `quarantine` 화면의 정확한 정적 파일 12개·CSP를 보존한다. 실제 `MediaAccess`를 전달하는 준비 모드는 `api-only`에서만 허용한다. 서버 코드나 비공개 파일을 정적 경로로 제공하지 않는다.
- 실제 소켓, Host·Origin·Fetch-Site, 중복 헤더·프록시 헤더 거부를 유지한다. 변경 요청의 전용 헤더와 쿠키 인증, 화면이 확인한 예상 계정의 일치 조건도 그대로 적용한다. 예상 계정 헤더 자체가 권한은 아니다.
- 연결 32개, 소켓당 요청 100개, 헤더 8KiB 및 기존 요청·헤더·소켓 시간 제한을 유지한다. CORS나 외부 수신 주소를 열지 않는다.
- 전용 루트는 `E:/CarebridgeBeta\private\checks\postgres-check-<UUID>\source-media`다. 정확한 합성 목적·run ID와 `.carebridge-check.json` 영수증을 대조한다. 누락된 루트를 생성하거나 다른 디렉터리를 입양하지 않는다.
- 시작 전과 runtime DB 개방 후에 루트·상위 경로를 확인한다. 영수증은 읽기 전용으로 최대 2,049바이트만 읽고, 2,048바이트 이내의 단일 일반 파일·경로/핸들 동일성·크기·시간 변경 여부를 재검사한 뒤 핸들을 닫는다.
- 공개 업로드 응답은 원본 `source`와 후보 `upload`의 이름·형식·크기를 분리한다. 해시·파일 키·경로·검사 증거·DB 암호·세션 토큰을 JSON·일반 오류·시험 보고서에 넣지 않는다. 로그인 비밀번호와 세션 쿠키는 인증 경로에서만 사용한다.
- 메시지 첨부 입력은 ID 목록뿐이다. 기존 트랜잭션이 소유권·준비 상태와 현재 관계를 확인하고 메시지 저장과 파일 연결을 함께 확정한다. 같은 요청의 재시도는 중복 메시지를 만들지 않는다.
- 파일은 메시지에 종속된 인증 `/attachments/:id/content` 경로로만 읽는다. 현재 열람 범위와 후보 증거·바이트를 확인하며 원본 파일로 대체하지 않는다. 전체 200 응답·정확한 형식/길이·`no-store`를 유지하고 Range는 무시한다.

## 종료는 실제 수명까지 확인

정리 순서는 **새 요청 차단 → 소유 소켓 종료 → HTTP 처리 완료 → 미디어 실제 작업 drain → API DB 종료 → API 자식 정상 종료 관측 → 작업자·시험 기반 자원 정리**다.

`drainLocalMediaContent(mediaAccess)`는 호출 즉시 해당 서비스의 새 읽기를 영구 차단한다. 파일 열기 전에 등록한 실제 `open → stream → dispose` 수명이 모두 끝날 때까지 기다린다. HTTP 연결이 끊기거나 응답 시간이 끝나도 늦은 파일 열기·비동기 스트림 해제는 계속 관측한다. `end` 이벤트만으로 `close`를 대신하지 않는다.

listener는 DB·파일 저장소를 직접 정리하지 않는다. 종료 관측 제한을 넘으면 실패로 남기고 DB·파일을 보존하며, 동일 수명의 명시적 종료 재확인을 허용한다. 제한 시간이 지났다는 이유로 작업이 중단됐다고 보고하거나 새 프로세스를 자동 재시작하지 않는다.

부모는 부트스트랩 전부터 자식 소유권을 등록한다. 정상 성공은 `stopped` 통지뿐 아니라 실제 `close`, 출력 파이프 닫힘, 종료 코드 0, 신호·실패 없음이 함께 있어야 한다. 정지 요청 뒤 늦은 `ready`는 시작 성공이 아니며, spawn 실패도 정상 종료로 바꾸지 않는다. 소유 자식이 아직 종료되지 않았다면 그 아래 DB·시험 자원을 먼저 정리하지 않는다.

## 실행 방법

프로젝트 루트에서 실행한다. 이미 준비된 Windows Node 24·PowerShell, 검증된 PostgreSQL 시험 런타임, Docker Linux 엔진·기존 이미지가 필요하다. 운영 서버 시작 명령이 아니다.

```powershell
npm run test:native-worker:e-drive -- --base E:/CarebridgeBeta --powershell 'C:/Users/USER\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe' --confirm-synthetic-e-drive
```

위 PowerShell 경로는 이 PC에서 확인한 경로이며 다른 PC에서는 검증된 절대경로로 바꾼다. 시험용 새 소유 자원을 생성하며 기존 운영 클러스터·미디어 폴더를 재사용하지 않는다. API child를 독립 운영 서버처럼 직접 실행하거나 자격증명을 명령행에 넣지 않는다.

이번 준비에서는 Docker를 숨김 창으로 시작했고 8GiB 메모리 및 기존 이미지를 확인했다. 공개 백신 정의 갱신이나 공개 소스 빌드에는 네트워크가 필요할 수 있으므로 완전 오프라인 시험으로 표현하지 않는다. 실제 자료를 전송하는 경로는 사용하지 않는다.

## 주요 변경 파일

| 영역 | 파일 | 변경 목적 |
| --- | --- | --- |
| 공통 HTTP | `server/local-api-listener.mjs`, `server/local-api-sandbox.mjs` | 기존 보안 경계를 보존한 listener 추출, 메모리 실행기 재사용 |
| Windows 조합 | `server/windows-local-api-service.mjs` | 전용 루트·runtime DB·API-only 서비스 결합 |
| 자식 제어 | `server/windows-native-api-test-policy.mjs`, `windows-native-api-test-control.mjs`, `windows-native-api-test-child.mjs`, `windows-native-api-test-parent.mjs` | 고정 부트스트랩·IPC·소유권·실제 종료 관측 |
| 미디어 수명 | `server/local-media-http.mjs`, `server/local-media-content-http.mjs` | worker 정리 모드와 실제 열기·전송·해제 drain |
| native 시험 | `server/windows-native-api-test-http.mjs`, `server/windows-native-worker-check.mjs`, `server/native-api-seed-testfixture.mjs` | 독립 가상 센터 HTTP 흐름과 기존 실제 검사 증거 결합 |
| listener·service 시험 | `server/tests/local-api-listener.test.mjs`, `server/tests/windows-local-api-service.test.mjs` | 설정 거부·소유권·권한·시작 실패·종료 순서 |
| 제어·전달 시험 | `server/tests/windows-native-api-test-*.test.mjs`, `server/tests/local-media-delivery.test.mjs`, `server/tests/local-media-content-http.test.mjs`, `server/tests/native-api-seed-testfixture.test.mjs` | 지연·실패·재시도·실제 수명·worker 정리 모드·기존 센터 불변 |
| 문서 | `docs/windows-local-api-connection.md`, `docs/local-api-connection.md`, `docs/communication-acceptance.md`, `README.md` | 연결 구조와 완료/미확인/운영 보류 구분 |

이번 연결은 SQL 스키마·DB 권한 정책을 변경하지 않는다. 기존 UI·공개 정적 빌드·배포·도메인도 변경하지 않는다. 기존 권한 검증을 runtime 계정에 적용하며, 작업자 계정을 API 계정으로 사용하지 않는다.

## 검증 결과

아래 수치는 서로 겹치는 집중 시험이므로 합산하지 않는다. 실제 실행한 경계와 대역으로 확인한 경계를 구분한다.

| 검사 | 확인된 결과 | 증거 범위 |
| --- | --- | --- |
| listener·sandbox·격리·파일 전송 집중 | **70/70 통과** | 메모리 DB·소유 루프백·합성 파일·서비스 대역 포함; native 검사 증거 아님 |
| 준비 전달·worker 정리 모드 | **16/16 통과** | HTTP·도메인 계약; 검사 대역 성공을 실제 ClamAV·FFmpeg 증거로 사용하지 않음 |
| Windows API service | **12/12 통과** | 파일/자격증명/DB 드라이버 대역과 소유 루프백; 실제 E·native DB 미사용 |
| IPC 정책·부모·자식 | **25/25 통과** | 실제 Node 상속 IPC 3종 및 ENOENT 포함; 서비스는 명시적 대역이며 E·DB 시험 아님 |
| 합성 센터 격리 | **1/1 통과** | 실제 PGlite에서 두 번 seed 후 기존 센터 13개 테이블 불변, 서로 다른 계정·센터 간 거부 |
| 최종 서버 전체 회귀 | **1,056/1,056 통과** | 직렬 실행, 실패·취소·건너뜀 0. `test-results/native-api-server-final-serial-20261009.xml` 및 `.tap` |
| 최종 로컬 전체 단위 | **410/410 통과** | `test-results/native-api-local-unit-final-20261009.xml`, 실패·취소·건너뜀 0 |
| 기본 브라우저 화면 | **2흐름 × 320/390/1440px 통과** | 격리 업로드·4메뉴 각각 폭별 12경계. 아래 UUID 결과 참조; 준비 첨부 UI 검증 아님 |
| 구문·정적 빌드 | **통과** | `node scripts/check.mjs`, `node scripts/build.mjs`; 공개 자산 35개는 소스와 동일, `dist/local-api` 없음 |
| 이번 실제 E native·API child 결합 | **54/54 통과, 실제 종료 코드 0** | 최종 `c8221481-c7f0-4a86-a9c6-16ad90507152`; API·작업자·두 클러스터 종료 및 시험 자원 정리 확인 |

```powershell
node --test --test-concurrency=1 server/tests/local-api-listener.test.mjs server/tests/local-api-sandbox.test.mjs server/tests/local-synthetic-media.test.mjs server/tests/local-media-http.test.mjs server/tests/local-media-content-http.test.mjs
node --test server/tests/local-media-delivery.test.mjs
node --test server/tests/windows-local-api-service.test.mjs
node --test --test-concurrency=1 server/tests/*.test.mjs
node --test --test-concurrency=1 tests/*.test.mjs
node tests/local-media-browser.mjs --confirm-synthetic-local
node tests/local-product-browser.mjs --confirm-synthetic-local
```

브라우저 최종 실행은 미디어 `af371519-2f36-4cfa-9edc-5e748f145dfb`, 제품 흐름 `0360d3e9-a279-46f7-831d-e24430cc838a`다. 각각 `test-results/local-media-<UUID>`와 `test-results/local-product-<UUID>`에 결과·소유 영수증을 보관한다. 오류·예상 밖 요청 0, 시작/종료/현재 소스 해시 일치, 자체 브라우저/서버 종료 및 소유 PID 잔존 0을 확인했다. 미디어 임시 폴더도 정리됐다. 중간 `9608f9b2-e9ce-4ee0-b06b-eda41ff1a2cf` 실행은 UI 경계는 수행했지만 병행 개발의 소스 변경을 감지해 실패로 남겼고 최종 증거로 계산하지 않았다.

기존 단계에서 관측한 병렬 Node 시험의 `0xC0000409` 비정상 종료 원인은 여전히 미확정이다. 이번 전체 성공은 동시성 1의 결과이며 그 원인 해결을 주장하지 않는다. 격리 변경 전 서버 1,055개 성공 결과도 별도로 보존하고 최신 1,056개와 합산하지 않는다.

중간 제어 시험에서는 잘못된 부트스트랩이 실제 종료 코드 1·파이프 닫힘·실패 terminal로 종료됐지만, 시험이 추가 `closeObserved`까지 요구해 불일치했다. 실패 terminal 기대값만 보정했고 정상 종료의 `close` 요구는 유지했다. 별도로 발견한 정지 후 늦은 `ready`와 PID 없는 spawn 실패의 미완료 대기 경로를 보완했으며 회귀를 포함한 25/25가 통과했다.

첫 E 실행 `16eadefe-6779-4821-b864-c07ac6094dde`는 native 첨부 **6/6** 및 API/작업자 종료는 통과했지만, 후속 `role-worker-source` 단계의 101번 경계에서 멈췄다(전체 28개 확인 후 실패). 기존 시험 센터에 새 보호자·치료사를 추가해 후속 시험의 역할별 1명 전제와 충돌했다. 해당 전제를 완화하지 않고 새 센터 seed로 격리했다. 실패 JSON은 `test-results/windows-native-worker-16eadefe-6779-4821-b864-c07ac6094dde-results.json`에 보존했으며 E 진단 자료도 보존했다. 검사 Docker 자원과 API/worker 자식은 종료됐고 원본 클러스터도 정지했다. TLS 진단 자료는 전체 실패 보존 정책에 따라 남았다.

두 번째 E 실행 `6aba1414-604c-4152-ac4e-4ea36a7a0030`은 native/API 6개 경계의 PASS 출력 이후 PowerShell 종료 코드 1로 중단됐으며 **최종 결과 JSON이 생성되지 않았다**. 따라서 부분 PASS를 전체 성공이나 정상 drain·정리 완료로 계산하지 않는다. 중단 후 해당 시험의 PostgreSQL·Node 프로세스 및 Docker fixture 컨테이너는 관측되지 않았지만, `source/postmaster.pid`에 PID 21456이 남아 있었고 TLS/E 진단 자료도 보존했다. 프로세스 부재만으로 정상 종료 순서를 증명할 수 없다.

두 번째 중단의 원인은 **미확정**이다. 확인한 Windows Application 로그에는 해당 Node/PostgreSQL의 1000/1001 이벤트가 없었으나, 이 사실만으로 충돌·메모리·종료 원인을 특정하거나 배제하지 않는다. 같은 코드로 세 번째 실행을 완료하고 `test-results/native-api-third-run-20261009.log`에 전체 출력을 보존했다. PowerShell의 후행 관측에서 실제 Node 종료 코드 0도 확인했다. 재실행 성공이 앞선 비정상 종료 원인을 해결했다는 뜻은 아니다.

최종 실행 `c8221481-c7f0-4a86-a9c6-16ad90507152`는 **54/54 통과**했다. 결과는 `test-results/windows-native-worker-c8221481-c7f0-4a86-a9c6-16ad90507152-results.json`에 별도 보존했고, 현재 `windows-native-worker-results.json`도 같은 실행이다. PNG·APNG·영상의 실제 검사와 후보 HTTP 열람, 취소 정리, 실패 시 원본·증거 보존을 포함한다. API 자식의 정상 종료 코드 0·실제 close·파이프 닫힘, 작업자 3개의 실제 terminal(정상 정지 0 및 의도한 연결 상실 실패 1), 원본·복원 클러스터 정지, DPAPI 시험 자격증명·TLS·검사 fixture 정리를 확인했다. 완료 후 관련 Node/PostgreSQL 프로세스와 검사 fixture 컨테이너도 남지 않았다. 성공 실행의 가상 DB·미디어 진단 자료는 오프라인 보존하며 Docker Desktop 자체는 종료하지 않았다.

최종 native 검증 코드 SHA-256: `server/windows-native-worker-check.mjs` = `54e78f81d449ec39ad815ae4b1b06183183b9716110b1a2a0e6553e488a4754f`, `server/native-api-seed-testfixture.mjs` = `a95043b23c7ebdc5dedfb88ca50f6d2229e446b1f3415fe41d063e5072adc52b`. 위 전체 회귀·브라우저 검증 이후 제품 코드를 변경하지 않았으며 최종 보고서만 갱신했다.

## 남은 위험과 다음 단계

1. API/worker의 DB 역할은 분리했지만 동일 Windows `CurrentUser` DPAPI·Docker 접근 권한까지 OS 수준에서 격리 완료한 것은 아니다. 운영 계정·권한 분리는 별도 작업이다.
2. 시작 시 루트 동일성 검사는 실행 내내 같은 inode를 연속 소유한다는 보장이 아니다. 로컬 경로 교체 공격과 지속적인 루트 소유권 검증은 남아 있다.
3. 독립 백업 매체가 없으므로 실제 아동 자료·외부 접속·유료 운영 전환은 계속 보류한다. 이번 시험은 운영 복구 시간·복구 시점 보장이 아니다.
4. 종합 검증은 통과했으나 두 번째 실행 및 과거 병렬 Node 비정상 종료의 원인은 미확정이다. 운영 안정성 해결로 표현하지 않으며, 재발 시 실제 종료 코드와 소유 프로세스·단계 기록을 보존해 조사한다. 기본 화면의 준비 첨부 모드는 아직 활성화하지 않는다.
5. 다음 구현은 가상 자료 전용 시험 화면에서 승인된 첨부만 선택·전송·열람하는 UI 연결이다. 계정/방별 초안, 불명 응답의 동일 요청 ID, 권한 종료 시 Blob/Object URL 폐기와 재열람 거부를 서로 독립된 실제 브라우저 세션으로 확인해야 한다.
6. 이미 수신자가 내려받은 파일을 원격 회수하는 기능은 없다. 실제 사용자·실물 기기 검증과 원 개편안 나머지 범위도 별도로 남는다.
