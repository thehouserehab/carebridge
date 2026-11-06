# Linux 검사 작업자 실행 경로와 실제 재시작 복구 검증

2026-10-04. 개편안 P1 첨부 처리 후속이다. **내부 실행 경로이며 운영 서비스·파일 승인·국내 인프라·기기 간 소통 완료가 아니다.** 앱의 API/화면 연결은 마지막 단계로 유지한다. 실제 아동·건강 자료는 사용하지 않았다.

## 구현한 경로

2026-10-05 후속 [원본/후보 검사 결합](media-preparation.md)에서 공통 CLI transport에 정확히 제한된 바이너리 후보 응답을 추가했다. Linux 구성/명령 allowlist·권한·socket 경계는 유지한다. 기존 신뢰 controller target은 명시적으로 `controller`를 선택하고 검사 결합은 별도 `media-preparation` target에서만 실행한다. 두 test controller에만 명시적 engine socket을 주며 비신뢰 파일 worker에는 제공하지 않는다. `prepare()`도 기존 job 원장의 한도/소유권/generation/회수 경로를 사용하지만 업로드 객체·queue·운영 승인으로 연결한 것은 아니다. 최신 실행 결과/지원 부분집합·실패 기록은 결합 문서를 따른다.

앞선 [파일별 격리](decoder-job-isolation.md)는 Windows 로컬 시험 adapter만 있었고, [실행 원장](decoder-job-journal.md)은 native DB와 가상 Docker를 각각 시험했다. 이번에는 `linuxDecoderRuntime()`이 실제 Linux CLI/Unix 소켓을 통해 같은 `IsolatedMediaDecoder`를 실행하고, PostgreSQL 원장과 실제 컨테이너를 함께 사용하도록 구현했다. 웹/HTTP 프로세스에서는 이 모듈을 가져오거나 엔진 소켓을 제공하지 않는다. 실행기·원장·기존 검사 정책의 인터페이스는 유지한다.

운영자가 명시적으로 주입할 설정은 CLI의 고정 절대 경로·승인 SHA-256, 로컬 Unix 소켓 경로·예상 owner UID, 엔진 신원, 승인 이미지의 전체 SHA-256 ID이다. 상대 경로·원격 URL·context·추가 environment/역할/파일명 입력은 거부한다. Windows에서는 활성화하지 않는다. Linux wrapper는 다음을 검사한다.

- CLI는 root 소유 일반 파일이며 그룹/다른 사용자에게 쓰기 가능하면 거부한다. 최초 전체 해시와 descriptor metadata를 확인한다. 이후에도 inode/크기/수정 시각/권한/소유권 및 root 소유·쓰기 금지 부모 경로가 같아야 한다.
- Unix 소켓은 실제 socket이고 예상 owner UID여야 하며 다른 사용자에게 쓰기 가능하면 거부한다. 심볼릭 링크/바뀐 socket identity도 거부한다. 기본 socket discovery나 원격 context로 자동 대체하지 않는다.
- 매 작업에서 승인 엔진의 Linux/x86_64 신원을 확인하고 승인 이미지의 Linux/amd64·`node` 사용자·볼륨/노출 포트 없음도 확인한다. 파일별 생성 설정과 실제 isolation 확인은 공통 정책을 재사용한다.
- 허용 명령은 고정 `info`, 승인 이미지/작업 container `inspect`, 정확한 UUID name/full ID 조회, 고정 job 생성, 전체 ID의 attach/start·kill·rm뿐이다. build/pull/exec/copy/log/prune·볼륨/네트워크/이미지 삭제를 받지 않는다.
- 정지/삭제/start 전에 전체 ID·UUID name/label·승인 이미지 소유권을 검사한다. 직접 stdin 전달 전 실제 job isolation과 `created` 상태도 확인한다. 다른 이미지의 시험 DB를 지우려는 호출은 native 시험에서 거부됐다.
- CLI 자식에는 별도 최소 environment와 `--host unix://...`만 전달한다. `DOCKER_HOST`, `DOCKER_CONTEXT`, 원래 PATH/HOME/DOCKER_CONFIG·앱 DB 비밀번호를 상속하지 않는다. shell을 사용하지 않는다.

`decoder-cli-transport.mjs`는 이 신뢰된 launch 정책 아래의 내부 파이프 모듈이다. 일반 HTTP launcher가 아니다. 제어 명령은 최대 15초·응답 1MiB, 파일 exchange는 최대 120초·stdout 4KiB·입력 50MiB+헤더 한도다. UTF-8 조각을 안전하게 합치고 잘못된 인코딩/과다 출력/stderr/입력 실패/취소를 내용 없는 오류로 처리한다. typed 입력 오류도 새 고정 오류로 바꿔 message 원문을 전달하지 않는다. CLI 종료 코드는 실제 worker exit 및 nonce/protocol 확인을 대신하지 않는다. CLI가 끝났어도 engine 생성/종료/정리가 불명확하면 원장/실행기가 작업을 보류한다.

## 반드시 유지할 운영 경계

**소켓을 read-only mount했다고 Docker 권한이 읽기 전용으로 바뀌는 것은 아니다.** CLI allowlist는 애플리케이션 코드 경계이지 엔진 소켓의 OS 접근 권한을 제한하는 보안 프록시가 아니다. 검사 controller 코드/OS 계정이 침해되면 엔진에 강한 권한을 행사할 수 있다. 운영에서는 별도 통제된 검사 host/VM·서비스 계정·비공개 파일 경계·승인된 이미지/바이너리 배치가 필요하다. 엔진 소켓을 웹 앱, 비신뢰 파일별 worker, 공개 MCP/HTTP에 주면 안 된다. Docker도 daemon 접근 권한을 별도로 보호하도록 안내한다. [Docker daemon 접근 보호](https://docs.docker.com/engine/security/protect-access/)

root/operator와 엔진 자체는 신뢰 경계다. metadata 재확인만으로 악의적인 root가 내용을 바꾼 뒤 시각을 되돌리는 공격까지 증명하지 않는다. read-only 배치·패키지/이미지 승인·권한 분리와 실제 운영 감사를 병행해야 한다. 같은 Unix 주소라도 운영자가 원격 proxy로 바꾸면 국내 저장을 보장하지 못하므로 실제 host/네트워크 배치도 확인해야 한다.

이번 adapter는 서비스 자동 시작/감독, durable 업로드 queue, 파일 취소/파기 전체 수명, metadata/변환본·안티멀웨어 결합, 운영 DB 역할/TLS/암호화, 원장 보존/아카이브, 이미지 교체 절차, 운영 backup/restore를 설정하지 않았다. 성공 decode 결과는 계속 `mediaAcceptanceReady:false`이며 업로드 검사 기본값도 바꾸지 않는다.

## 실제 시험 환경과 공개 CLI

로컬 Windows Docker Desktop의 Linux 엔진에서 **신뢰된 시험 controller만** 소켓 1개를 bind했다. controller는 `node`·그룹 0·read-only root·CPU 1·RAM/swap 512MiB·PID 128·cap-drop ALL·no-new-privileges·로그/자동 재시작 없음이며, 자기 시험 PG의 network namespace만 사용한다. 공개 포트·외부 네트워크·개인 폴더/파일 mount는 없다. 이 소켓 예외를 기존 per-file worker 정책에 넣지 않았다. 비신뢰 decoder는 여전히 소켓/호스트 mount 없이 별도 namespace/tmpfs·고정 stdin만 사용한다.

PG 18.6은 새 RAM-only 시험 컨테이너이며 새 임시 DB/template0만 만든다. 이 결합 시험의 DB 계정은 해당 새 시험 인스턴스 관리자이고 **운영 worker 최소 DB 권한 검증은 아니다.** 기존 운영/아동/계정 DB에 연결하거나 채택하지 않았다. 기존 001~012 SQL/checksum·기록·관계 정책은 바꾸지 않았다.

검증 controller의 Linux CLI는 [Docker 공식 정적 바이너리 배포](https://download.docker.com/linux/static/stable/x86_64/)의 29.8.1 archive에서 `docker/docker`만 추출했다. archive는 86,055,881바이트, SHA-256 `d8db66739d2e28d4933786d73e918d9be643a67fbd835db1bf740d650a259e70`이다. CLI는 44,260,160바이트, SHA-256 `9c46230f41e4263b3a9d93ae9284722709923c50d138bc64eed2bb6c02af0581`이다. 공식 HTTPS 출처와 로컬 내용 해시를 기록한 것이며 별도 publisher 서명을 검증했다고 주장하지 않는다. 운영 artifact 승인/업데이트 절차는 별도다. 정적 배포는 수동 유지가 필요하므로 이 시험 cache를 자동 운영 설치로 사용하지 않는다. [Docker 바이너리 설치 안내](https://docs.docker.com/engine/install/binaries/)

archive/CLI는 Git/정적 배포에서 제외된 `test-results/runtime-build/docker-cli-29.8.1/`에 보관한다. Dockerfile은 정확한 CLI만 COPY/해시 검사하고 public/internal source allowlist만 사용한다. controller build는 offline이며 새 archive/CLI를 자동 다운로드하지 않는다. PC의 Docker daemon/WSL/보안 설정·설치 버전은 바꾸지 않았다. 다른 daemon 바이너리는 추출/실행하지 않았다.

## 검증과 한계

재현 명령(승인한 public artifact cache와 기존 검증 base image가 있는 로컬 PC에서):

```powershell
node --test server/tests/linux-decoder-runtime.test.mjs server/tests/decoder-service-test-policy.test.mjs
npm run test:decoder-linux:local
npm run test:server
npm test
npm run check
npm run build
git diff --check
```

신규 계약 14개는 설정/명령 제한·실제 Node 자식 stdin/stdout·UTF-8·최대 byte·stderr·취소·실패 원문 비노출·신뢰 controller 예외 정책을 검증한다. 계약 시험의 자식은 Node fixture이며 Docker 실제 실행 증거는 별도 다음 8개다.

1. 실제 Linux endpoint가 ambient 원격 설정을 무시하고 다른 CLI 해시를 거부.
2. native decode·실제 PostgreSQL 원장·정확한 자기 namespace 정리를 함께 완료. 파일 승인은 하지 않음.
3. 실제 MIME 불일치 거부와 container/DB receipt 정리.
4. 다른 owner의 두 작업이 engine 전체 한도를 공유하고 세 번째 작업은 생성되지 않음. 실제 취소 후 자기 namespace 정리.
5. 다른 이미지인 이 시험의 DB를 stop/remove하려는 호출 거부. DB 응답 유지.
6. 별도 Node worker 프로세스를 실제 SIGKILL하고 종료 signal 확인. 메모리를 잃은 뒤 유효한 DB lease를 다른 owner가 탈취하지 못함.
7. **SQL로 lease/시계를 바꾸지 않고 자연 만료(기본 180초)를 기다린 뒤**, 새 실행기/owner가 원장 full ID로 실제 잔존 container를 회수.
8. 회수 뒤 새 정상 파일을 새 namespace에서 한 번 처리. 이전 namespace를 재사용하지 않음.

최초 실행과 최종 오류/설정 타입 보강 후 재실행에서 각각 **8개 및 임시 DB/정확한 시험 controller·PG·decoder 이미지 정리**를 통과했다. 두 실행은 서로 다른 UUID/임시 DB/컨테이너를 사용했으며 실패·관찰 timeout을 이유로 같은 요청을 다시 시작하지 않았다. 최종 코드의 서버 회귀 **326개**, 로컬 **61개**, 문법·정적 빌드·`git diff --check` 및 신규/untracked 변경 파일의 공백 검사도 통과했다. 정적 `dist`에는 index/favicon/src/build manifest만 있고 worker/CLI/cache/문서/환경 파일을 포함하지 않는다. native 자료는 Node가 생성한 metadata 없는 PNG뿐이며 기존 28개 전체 형식 fixture를 이번 Linux 결합 시험에 모두 반복한 것은 아니다.

검증 후 Docker에서 잔존 container 0개·공식 base image 3개를 확인했다. 테스트가 만든 RAM-only DB/컨테이너/시험 이미지 태그만 소유권 확인 후 정리했다. 기존 사용자 자료·공식 base cache·공개 CLI/서명 소스 cache를 삭제하지 않았다. source/cache를 Git에 추가하거나 GitHub/Vercel에 push/deploy하지 않았다.

실제 PC 재부팅·Docker daemon 강제 중단·운영 DB 네트워크 단절/backup restore·지연 생성의 전체 장애 행렬·원장 이미지 교체·실사용 기기 전송은 이번 시험 범위 밖이다. SIGKILL 하나가 모든 운영 장애를 검증했다고 해석하지 않는다. 실제 worker crash 후 stdin EOF로 decoder가 먼저 종료해도, 원장은 lease/소유권·자기 terminal 상태/정리를 확인할 때까지 container를 보존한다.

## 변경 파일과 다음 작업

- 실행 경로: `server/linux-decoder-runtime.mjs`, `decoder-cli-transport.mjs`.
- 계약 시험: `server/tests/linux-decoder-runtime.test.mjs`, `decoder-service-test-policy.test.mjs`.
- native 시험/격리: `decoder-service-test-policy.mjs`, `linux-decoder-test-fixtures.mjs`, `linux-decoder-native-child.mjs`, `linux-decoder-native-test.mjs`, `linux-decoder-container-test.mjs`, `linux-decoder-test.Dockerfile`/`.dockerignore`.
- 재현 명령: 루트와 `server/package.json` scripts. 새 의존성은 추가하지 않음.
- 문서: 이 문서와 README/서버 기반/원장·격리/로컬 실행환경의 후속 경계.

다음 우선순위는 **metadata/변환본과 안티멀웨어 결합 → durable 업로드 queue·취소/장애 복구 → 국내 저장/암호화·메일/계정 복구·backup/restore → 마지막 API/화면 연결·두 기기 전송/재접속 검증**이다. 자동 실행/배포가 되었다고 표시하지 않는다. P2 검색/알림은 사용성 필요 확인 후 진행하며 전체 개편 목표는 계속 진행 중이다.
