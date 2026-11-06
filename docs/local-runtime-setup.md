# 로컬 격리 실행환경 설치 상태

작성: 2026-10-03 · 갱신: 2026-10-04. 사용자가 이 PC에 필요한 실행환경 설치를 허용했다. 이는 로컬 개발·합성 파일 검증을 위한 승인이다. 유료 자원 생성·클라우드 파일 전송·운영 전환·실제 아동 자료 사용·자동 재부팅 승인으로 확대하지 않는다. API 연결은 마지막 단계로 유지한다.

## 확인한 PC와 권한

2026-10-05 재확인에서도 Docker Engine 29.8.1의 실제 서버 응답과 offline 합성 컨테이너 실행을 확인했다. Resource Saver의 미사용 절전은 시작 실패와 구분하고 재설치/초기화/WSL 삭제/보안 해제 없이 진행했다. 이 재개에서 Resume UI 클릭은 stale 관찰로 완료를 확인하지 못했으므로 클릭 성공으로 기록하지 않는다. 실제 network=none·read-only·비관리자 Node 작업이 엔진을 깨우고 종료 코드 0/자기 제거·Engine running을 확인한 것이 근거다. 이후 [원본/후보 결합 및 기존 회귀](media-preparation.md)를 새 UUID의 합성 자원으로 실행했다. 기존 파일/DB/base image·공개 build cache는 유지하며 운영 API/화면/국내 배포는 바꾸지 않았다.

- Windows 11 Home x64, 빌드 26200, 메모리 약 16GB, C 드라이브 여유 약 111GB.
- Windows 하이퍼바이저 실행이 확인됐다. 하이퍼바이저 아래의 CPU 가상화 속성만으로 BIOS가 꺼졌다고 판정하지 않으며 WSL 실제 시작으로 재확인해야 한다.
- 현재 Codex 프로세스는 관리자 권한이 아니다. WSL의 최초 Windows 기능 설정에는 Windows 관리자 승인이 필요하다.

## 현재 설치 결과

| 항목 | 확인 결과 |
| --- | --- |
| WSL | 최초 요청은 관리자 승인 취소로 시작하지 못했다. 사용자가 승인창 재요청을 명시한 뒤 같은 명령을 다시 실행했고 실제 설치 프로세스의 종료 코드 0을 확인했다. 독립 점검에서 WSL 3.0.1.0·커널 6.18.40.1-1·기본 버전 2와 실행 중인 WslService를 확인했다. 2026-10-03 22:07:40(한국 시각)의 사용자 재부팅 후 WSL2 가상화 오류가 사라졌다. 2026-10-04에는 Linux 컨테이너와 실제 PostgreSQL 시험까지 실행했다. |
| Docker Desktop | 공식 4.93.0 x64 설치 파일의 SHA-256·유효한 Docker Inc 서명을 실행 직전에 다시 확인하고 사용자별 WSL2 모드로 설치했다. 설치 프로세스 종료 코드 0, 설치된 Desktop 4.93.0.240920·CLI 29.8.1 및 유효한 Docker 서명을 확인했다. 첫 실행 종료 후 2026-10-04 사용자 복구 요청으로 재실행해 로컬 Linux 엔진 29.8.1의 실제 응답을 확인했다. 이후 새 창은 정상 Containers 대시보드였고, 네트워크 없는 합성 데이터 컨테이너에서 PostgreSQL 8개 시나리오·정리를 종료 코드 0으로 확인했다. 약관/계정 설정은 에이전트가 처리하지 않았다. |
| 검사/디코더 | 2026-10-04 공식 ClamAV 1.4.6 LTS 이미지를 digest 고정하고 정의 갱신·오프라인 합성 검사 13개를 실행했다. 이어 서명/해시를 검증해 직접 빌드한 FFmpeg 9.0.2에서 허용 코덱의 합성 조합·전체 프레임·최대 바이트/출력/시간·손상/취소/정리 등 38개를 통과했다. 후속 [파일별 최소 디코더 28개](decoder-job-isolation.md)에서 각각의 namespace/tmpfs와 종료/자기 자원 정리를 검증했다. 시험 자원만 정리한다. 운영 Linux transport·durable queue/장애 회수·metadata 제거·전체 검사 어댑터는 남아 있다. 기존 업로드 검사기 기본값은 미설정이며 파일을 사용 가능 상태로 승인하지 않는다. |
| 재부팅/약관 | 사용자 재부팅 후와 Docker 설치 후 모두 Component Based Servicing의 RebootPending이 없음을 확인했다. 사용자가 “docker 실행해”라고 요청해 첫 실행을 진행했다. Subscription Service Agreement와 Accept/Close 버튼을 확인했으며 어느 버튼도 대신 누르지 않았다. 자동 재부팅·약관 자동 동의·Docker 계정 로그인·유료 구독 신청을 하지 않았다. |

Docker 설치 파일은 공개 저장소/배포에서 제외된 `test-results/runtime-install/docker-desktop-4.93.0-installer.exe`에 보관한다. 크기는 627,791,792바이트이며 SHA-256은 `c139124c9cf71477dc565c3c0ea5a18f90b93d68ebe9aaa848a065960416c0bc`이다. 다운로드 URL과 checksum은 같은 공식 빌드 240920이다. 실행 직전에 해시·서명을 다시 확인하며, 일치하지 않으면 실행/덮어쓰기/자동 삭제하지 않는다.

최초 실행 요청 셸은 Start-Process 오류 후에도 종료 코드 0을 반환했지만, 오류 내용에 관리자 승인 취소가 명시됐고 설치 프로세스 ID/완료 코드가 없었다. 셸 종료 코드만으로 WSL 설치 성공으로 판단하지 않았다. 사용자 재요청 후에는 `-ErrorAction Stop`으로 시작 실패를 구분하고 실제 설치 프로세스의 종료까지 동일한 핸들로 관찰했다. 설치 프로세스 종료 후 `wsl --version`·`wsl --status`와 서비스/기능/재부팅 상태를 별도로 확인했다. 동일한 설치를 중복 실행하거나 Windows 승인 취소 후 자동으로 재요청하지 않는다.

`VirtualMachinePlatform`은 Win32_OptionalFeature에서 설치 상태 1(활성화)이고 하이퍼바이저도 실행 중이다. 그러나 재부팅 전 `wsl --status`는 WSL2 가상화 준비 불가를 보고한다. 이 메시지만으로 BIOS 가상화가 꺼졌다고 단정하지 않으며 재부팅 후 실제 엔진 시작을 확인한다. `Microsoft-Windows-Subsystem-Linux` 기능은 상태 2(비활성화)로 WSL1 관련 안내도 나오지만, 이번 목표는 WSL2이며 WSL1을 임의 활성화하지 않는다.

재부팅 후 `wsl --status`는 기본 버전 2와 WSL1 선택 기능 안내만 반환하며 이전 WSL2 가상화 오류는 없다. 설치 명령은 반복하지 않았다. Docker 설치는 `install --user --backend=wsl-2 --no-windows-containers --quiet`로 실행했다. `--accept-license`·`--always-run-service`는 사용하지 않았다. 설치 후 시스템 전체 설치 경로와 `com.docker.service`는 없고, 재부팅 대기도 없다. 설치된 실행 파일은 `%LOCALAPPDATA%\Programs\DockerDesktop`에 있다. 현재 셸의 PATH에 의존하지 않고 검증한 설치 경로의 CLI로 확인했다.

`docker --version`은 CLI 29.8.1을 반환했다. 설치 직후 `docker desktop status`는 Desktop이 실행 중이 아니어서 상태를 조회할 수 없다고 반환했다. Computer Use의 신규 앱 실행 확인 규칙에 따라 첫 실행 승인을 요청했고 사용자의 명시적 실행 요청을 받은 뒤 창을 띄웠다. 앱 실행 호출은 처음에 대상 창을 찾지 못했다고 반환했지만 새 창 목록·실행 프로세스·CLI 상태를 다시 확인해 실제 실행된 것을 확인했다. 중복 실행하지 않았다. 선택한 Docker 창의 접근성 텍스트와 화면에서 Subscription Service Agreement를 확인했다.

첫 실행 당시 `docker desktop status`의 앱 상태는 `running`이고 조회 종료 코드는 0이었다. **앱 상태 running은 약관 동의, Linux 엔진 시작, 컨테이너 격리 또는 파일 검사 준비 완료의 증거가 아니다.** 후속 점검에서는 Desktop/백엔드 프로세스와 대상 창이 없고 앱 상태 조회가 종료 코드 1을 반환했다. 설치된 `desktop-linux` 컨텍스트의 endpoint가 로컬 named pipe인지 먼저 확인한 뒤 조회한 엔진 버전도 연결 불가/종료 코드 1이었다. 당시에는 종료 원인 또는 사용자의 약관 동의 여부를 추정하지 않았다. 약관은 사용자가 직접 확인·동의하며 계정 생성·유료 결제는 자동 진행하지 않는다.

## 2026-10-04 시작 장애 진단과 복구

사용자가 “docker 안켜져 해결해”라고 요청해 현재 프로세스·창·WSL·로컬 엔진과 최근 시작/종료 로그를 확인했다. WSL 3.0.1과 `docker-desktop` WSL2 배포가 있으며 진단 시작 당시 앱/엔진은 정지 상태였다. 이전 백엔드 로그에는 2026-10-03 22:51:52(한국 시각) `POST /license/reject` 성공 후 Electron·백엔드·엔진 소켓을 종료한 순서가 기록돼 있었다. 설치 실패나 가상화 고장을 원인으로 단정하거나 누가 어떤 의도로 조작했는지 추정하지 않는다.

Computer Use로 설치된 Docker 앱을 한 번 재실행했다. 호출의 대상 창 관찰 시간 초과만으로 다시 시작하지 않고 새 창/프로세스 목록을 확인해 실제 앱을 찾았다. 2026-10-04 00:02경 앱 상태 `running`과 `docker --context desktop-linux version --format '{{json .Server}}'`의 실제 서버 응답/종료 코드 0을 확인했다. 서버는 Linux/amd64, Engine 29.8.1, WSL2 커널 6.18.40.1을 보고했다. 단순 설치된 CLI 버전이나 앱 상태만으로 엔진 실행을 판정한 것이 아니다.

복구 직후에는 Subscription Service Agreement 창을 화면 앞으로 가져왔다. 약관/개인정보 동의는 사용자에게 남겨두고 Accept/Close·로그인·결제·보안 설정을 대신 처리하지 않았다. 약관 창이 보이는 동안 엔진이 응답한다는 사실만으로 약관 완료로 해석하지 않았다. 초기화/재설치/WSL 배포 삭제/자동 재부팅은 하지 않았다.

후속 신규 창 점검에서는 약관 창이 아닌 정상 Containers 대시보드와 Engine running을 확인했다. `desktop-linux` endpoint가 로컬 named pipe임을 확인한 뒤 `docker info`가 Engine 29.8.1/Linux/x86_64를 반환했다. 공식 PostgreSQL/Node 이미지를 실제 다운로드하고 네트워크 없는 비관리자·읽기 전용 컨테이너에서 [PostgreSQL 통합 시험 8개와 정리](postgres-integration.md)를 통과했다. 앱 상태만으로 실행 성공을 보고한 것이 아니다. 약관·계정 로그인·결제 절차를 자동 처리하지 않았다.

첫 이미지 pull은 `docker-credential-desktop`을 현재 Codex 프로세스 PATH에서 찾지 못해 실패했다. 설치 폴더의 해당 보조 프로그램과 유효한 Docker 서명을 확인하고 **시험 자식 프로세스의 PATH만** 설치 폴더로 보완한 뒤 정상 다운로드됐다. 시스템 전체 PATH·로그인 정보·인증 저장소·보안 설정은 바꾸지 않았다. 재현 명령에도 같은 로컬 보완을 포함했다.

## 재개 순서

2026-10-05 재실행 요청에서도 현재 창의 Resource Saver/Resume을 확인해 재개한 뒤, 임시 오프라인·비관리자·읽기 전용 Node 컨테이너의 `docker-runtime-ok`·종료 코드 0·실제 Engine running을 확인했다. 이후 실제 PostgreSQL 18개와 ClamAV/격리 FFmpeg/Linux 저장 결합 18개가 모두 통과했고 자기 시험 컨테이너/볼륨/image tag를 정리했다. 재설치·초기화·기존 데이터 삭제·절전 설정 변경은 하지 않았다. 최신 저장 범위와 남은 운영 한계는 [분리 저장 문서](media-preparation-storage.md)를 참고한다.

2026-10-04 19시 후속 실행 요청에서는 Docker 창의 `Resource Saver mode`와 `Resume`을 실제 확인했다. CLI의 `desktop status`는 `stopped`였지만 `version`/`info`는 응답했다. 이 응답만으로 worker 실행이 가능하다고 판단하지 않고, 창의 `Resume`으로 재개한 뒤 외부 네트워크·호스트 폴더 접근 없는 임시 Node 컨테이너의 `DOCKER_RUNTIME_OK`, 종료 코드 0, 자기 자원 자동 제거 및 화면의 `Engine running`을 확인했다. 재설치/초기화/기존 데이터 삭제/Resource Saver 설정 변경은 하지 않았다. 미사용 절전과 실제 실행 실패를 구분한다. 이후 [실행 원장 검증](decoder-job-journal.md)의 실제 PostgreSQL 13개·정리를 다시 확인했다.

1. 사용자 재부팅과 Docker 사용자별 설치는 완료됐으므로 동일한 설치를 반복하지 않는다. 관리자 비밀번호는 대화/코드/로그로 받지 않는다.
2. Desktop 재실행·정상 대시보드·로컬 Linux 엔진·실제 컨테이너 검증은 완료했다. 이후 다시 약관 창이 나타나면 사용자가 직접 확인한다. 에이전트는 Accept·로그인·결제·개인정보/보안 설정을 대신 처리하지 않는다. Windows 컨테이너·특권 시스템 서비스·원격 Docker API·클라우드 Offload는 임의 활성화하지 않는다.
3. 이후 재개할 때 `docker desktop status`·`docker version`·`docker info`로 엔진을 재확인한다. 기동 오류가 있으면 현재 상태를 진단하고 자동 재설치하지 않는다. 다운로드/설치 진행 중에는 동일한 작업 핸들을 확인하고 관찰 시간 초과만으로 재시작하지 않는다.
4. Docker의 실제 엔진/컨테이너 시작을 확인한 뒤, 승인 버전의 ClamAV·실제 디코더를 격리 환경에 구성한다. 검사 정의 갱신과 임상 파일 검사를 분리하고 실제 검사 경로의 네트워크·볼륨·권한·CPU/메모리/시간 한도를 검증한다.
5. 합성 정상·손상·용량/리소스 경계 파일로 검증하고 메타데이터/원본/변환본 정책을 확정한다. 안티멀웨어 통신 시험만으로 전체 프레임 디코딩이나 파일 승인 준비가 됐다고 판정하지 않는다.

Docker 복구 후 합성 데이터 컨테이너/실제 PostgreSQL을 검증하고, 이후 [실제 ClamAV 검증](clamav-native-verification.md)까지 진행했다. 시험 자원만 정리했고 공식 기반 이미지 캐시는 유지한다. 전체 파일 승인·P1 화면 서버 연결·기기 간 전송 또는 전체 국내 통제의 완료 증거는 아니다. PostgreSQL 연결 종료 시험에서 서버 DB adapter의 사용 중 오류 이벤트 처리 결함을 수정하고 회귀 검증했다. ClamAV 단계에서는 명시적 로컬 시험 도구만 추가했다. UI·API 연결·배포는 바꾸지 않았고 운영 계정/기존 자료를 삭제하지 않았다.

PostgreSQL 단계 종료 시에는 앱의 `docker desktop status`를 context 옵션 없이 실행하고, Linux 엔진은 `docker --context desktop-linux info`로 별도 확인했다. 당시 Desktop `running`, Engine 29.8.1/Linux, 잔존 컨테이너 0개·공식 기반 이미지 2개였다. 이후 ClamAV 단계 시작 시에는 Desktop 상태가 `stopped`였지만 같은 로컬 Linux 엔진은 응답했고 실제 컨테이너 검증도 실행됐다. ClamAV 단계 종료 시 재확인에서는 Desktop `running`, Engine 29.8.1/Linux, 컨테이너 0개·공식 기반 이미지 3개였다. 이번 검사 단계에서 앱 재실행/약관 처리를 하지 않았고 상태 변경의 행위자를 추정하지 않는다. 앱 창 상태와 엔진 상태를 동일한 조회로 간주하거나 창 종료만으로 재설치하지 않는다.

공식 참고: [Microsoft WSL 설치](https://learn.microsoft.com/en-us/windows/wsl/install), [WSL 명령 옵션](https://learn.microsoft.com/en-us/windows/wsl/basic-commands), [Docker Windows 설치·권한·약관](https://docs.docker.com/desktop/setup/install/windows-install/), [Docker 릴리스](https://docs.docker.com/desktop/release-notes/).

2026-10-04 [Linux 실행 경로 후속](linux-decoder-runtime.md)에서는 별도 신뢰된 로컬 시험 controller에만 engine socket을 부여해 실제 PostgreSQL 원장·per-file decoder와 결합한 8개를 통과했다. 실제 작업자 프로세스 SIGKILL·자연 lease 만료·새 인스턴스 회수 사례이며 PC 재부팅/daemon 강제 중단/운영 설치 완료가 아니다. 공식 공개 Linux CLI 29.8.1은 무시된 시험 cache에서만 준비하고 정확한 SHA-256으로 controller 이미지에 복사했다. PC Docker/WSL/daemon 설치·설정·보안 권한은 바꾸지 않았고 untrusted decoder에는 engine socket을 주지 않았다.

후속 [실제 디코더 검증](media-decoder-verification.md)은 같은 로컬 Linux 엔진에서 진행했다. 공개 서명 소스/빌드 패키지 준비만 외부 통신했고 실제 검사 worker에는 외부 네트워크·호스트 폴더·공개 포트가 없었다. 첫 소스 해제 중 자기 GPG helper가 남은 빌드를 진단해 해당 helper만 종료하고, agent 없는 서명 검증으로 바꾸었다. 누락된 시험 런타임 라이브러리·FFmpeg component 선택도 수정한 뒤 실제 23개 시험과 정리를 통과했다. Docker/WSL 재설치·보안 해제·자동 재부팅·약관 처리는 하지 않았다.
