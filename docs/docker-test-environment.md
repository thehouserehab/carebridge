# Docker 합성 시험 — 환경변수 상속 제한

2026-10-07. **시험 도구의 노출 범위만 줄인 비API 후속이며 운영 서비스 활성화가 아니다.** 사용자는 독립 백업 매체가 아직 없다고 답했다. 같은 E의 사본을 독립 백업으로 계산하지 않으며 실제 아동 자료 베타 전환은 계속 보류한다. 전체 개편 목표도 진행 중이다.

## 확인한 문제와 변경 범위

공통 Windows Docker 시험 런처와 별도 PostgreSQL 시험 런처가 process.env 전체를 CLI 자식에 전달하고 있었다. 바이너리 전송도 공통 런처의 같은 환경을 사용했다. 실제 유출을 관찰한 것은 아니지만, 앱 비밀이나 Docker·빌더·프록시 설정이 불필요하게 자식에 전달될 수 있는 코드 경로였다.

Docker는 환경변수로 context·host·설정 디렉터리·TLS·사용자 정의 헤더·프록시 등을 설정할 수 있다. 따라서 endpoint 인자를 고정하는 것과 자식 환경을 제한하는 것은 별도 책임이다. [Docker CLI 공식 문서](https://docs.docker.com/reference/cli/docker/)

백엔드 아키텍처 스킬의 책임 분리 원칙에 따라 시험 실행 설정을 순수 정책으로 분리했다. 제품 worker·DB·파일 승인 규칙은 바꾸지 않았다. 초기 확인에서 고려했던 Windows/E worker와 실제 ClamAV/디코더의 새 결합 시험은 이번 범위에서 **구현하지 않았다**. 먼저 발견한 런처 상속 문제를 해결했으며, 아래 실제 디코더 검사는 기존 합성 시험의 회귀다.

## 실행 정책

[환경 정책](../server/local-docker-test-environment.mjs)은 native IO 전에 설정을 캡처한다. 이후 호출자 객체를 바꿔도 승인된 값은 달라지지 않는다.

| 대상 | 명시적으로 전달하는 범위 |
| --- | --- |
| 기본 Windows 환경 | SYSTEMROOT·LOCALAPPDATA 필수, TEMP·TMP·USERPROFILE·APPDATA 선택. 로컬 절대 경로만 허용하고 대소문자 중복·getter·제어문자·UNC·상위 경로 이동을 거부한다. |
| 고정 실행 설정 | Docker Desktop의 기존 docker.exe 절대 경로. PATH는 그 bin·Windows System32·SYSTEMROOT로 재구성한다. WINDIR는 SYSTEMROOT, TZ는 UTC, LANG은 C로 고정한다. |
| 상속하지 않는 설정 | 기존 PATH, 앱/API·DB 자격증명, NODE_OPTIONS, DOCKER_*·BUILDX_*·BUILDKIT_HOST, 프록시·PowerShell 모듈 경로 등 기본 목록 밖의 값. |
| 합성 입력 | POSTGRES_PASSWORD·CAREBRIDGE_FIXTURE_PASSWORD는 명시적으로 전달된 64자리 소문자 hex만 허용한다. CAREBRIDGE_LINUX_TEST_ENGINE·IMAGE·DATABASE_ID도 각각 기존 엔진/불변 이미지/full ID 형식만 허용한다. 형식 검사 자체가 무작위 생성이나 엔진 신원의 증명은 아니다. |
| 컨테이너 생성 | create의 명시적 --env NAME에 지정된 합성 값만 해당 CLI 자식에 추가한다. DB는 자기 비밀번호만, DB worker는 자기 연결 비밀번호만, trusted controller는 필요한 연결/엔진 입력만 받는다. |
| 그 외 명령 | build·info·inspect·start/attach·바이너리 exchange·종료/정리는 합성 비밀번호나 엔진 입력도 받지 않는다. |

부모 환경에 합성 입력과 같은 이름/형식의 값이 있어도 자동 채택하지 않는다. 임의 extra override·오타/소문자 이름·상속 환경 import·비밀번호를 값으로 넣는 인자·env-file·짧은 -e 별칭·중복 이름·빈/희소/NUL 인자는 거부한다. 기존 정책의 고정 TZ/PostgreSQL 초기화 literal만 허용한다. 실패는 값이나 cause 없이 LOCAL_DOCKER_TEST_UNAVAILABLE로 처리한다. 합성 비밀번호는 기존처럼 시험 컨테이너 Config.Env에 저장되는 방식이며 운영 비밀 보관 수단이 아니다.

[공통 런처](../server/local-docker-test-runtime.mjs)의 명령과 바이너리 exchange, [PG 시험 런처](../server/postgres-container-test.mjs)가 이 정책을 사용한다. shell:false를 명시했다. 기존 엔진/context·로컬 builder 검사, 이미지 digest·UUID 영수증·자원/네트워크 격리·불확실 상태 보존·정확한 자기 자원 정리는 유지한다.

## 실제 Windows 관측과 첫 실패

첫 집중 검사는 **49/50**이었다. 실제 새 Node 자식의 환경이 명시적 env 객체와 정확히 같다고 가정한 시험 1개가 실패했다. 자식에서 HOMEDRIVE·HOMEPATH·LOGONSERVER·SYSTEMDRIVE·USERDOMAIN·USERNAME가 추가 관찰됐다. 값은 출력하지 않았다.

사용 중인 Node v24.15.0의 [Windows 프로세스 생성 소스](https://raw.githubusercontent.com/nodejs/node/v24.15.0/deps/uv/src/win/process.c)는 누락된 OS 필수 변수를 채우는 required_vars 경로를 갖는다. 시험을 임의의 추가 변수 허용으로 바꾸지 않고, Windows에서 이 **닫힌 6개 목록**만 추가될 수 있게 명시했다. 앱 비밀·Docker 설정 차단 검사는 그대로다. 따라서 ‘Windows 계정 정보까지 전혀 없는 환경’이나 OS 보안 격리라고 주장하지 않는다.

## 실행한 검증

```powershell
node --test server/tests/local-docker-test-environment.test.mjs server/tests/postgres-container-policy.test.mjs server/tests/clamav-container-policy.test.mjs server/tests/decoder-container-policy.test.mjs server/tests/decoder-service-test-policy.test.mjs server/tests/linux-decoder-runtime.test.mjs
npm run test:server
npm test
npm run check
npm run build
git diff --check
npm run test:postgres:local
npm run test:decoder-jobs:local
npm run test:decoder-linux:local
```

| 범위 | 이번 확인 |
| --- | --- |
| 집중 회귀 | **51/51**. 새 환경 정책 14개 포함. 실제 새 Node 자식 5가지 실행 환경에서 명시적 변수/OS 추가 변수/정확한 합성 입력 부분집합을 확인한다. Docker/DB 없는 이 시험을 native 검사로 계산하지 않는다. |
| 전체 서버 | **673/673**, 실패·취소·skip 0. 초기 새 시험 13개 시점의 672 통과 후 ambient 합성 입력 자동 채택 거부를 추가하고 최종 전체를 재실행했다. 집중 숫자와 별도 합산하지 않는다. |
| 로컬 단위 | **87/87**, 실패·취소·skip 0. 화면/브라우저/실물 기기 시험은 이번에 실행하지 않았다. |
| 구문·빌드 | check/build·tracked diff whitespace 통과. 최종 산출물/새 파일 검사는 아래에 기록한다. |
| 실제 Docker 읽기 전용 preflight | 일반 최소 환경 및 가짜 ambient Docker/TLS/context·빌더·프록시·PATH·앱 설정을 넣은 별도 진단 프로세스 모두에서 실제 local engine·로컬 builder 검사가 통과했다. 가짜 주소로의 접근을 실제 운영 설정으로 채택하지 않는다. |
| 실제 Docker PostgreSQL | **36/36**, run ffe96130-2f39-4a62-ab41-a48b4f01c576. 합성 DB/worker의 올바른 비밀번호 전달·동시성/원장/종료 및 자기 컨테이너·태그 정리 통과. E PG/운영 사용자 시험이 아니다. |
| 실제 Windows CLI→파일별 디코더 | **49/49**. worker build a48b864b-0133-4445-aeed-caacae306be2, fixture build c26a069c-94cb-40d2-9a07-66990b056e30. 합성 사진·영상의 stdin/binary 결과·손상 거부·취소/실제 종료·동시 작업·자기 자원 정리 통과. 마지막 변경은 입력 거부 경계 보강이며 이 실행은 그 직전에 시작됐다. 최종 정책의 유효 명령 부분집합은 집중 회귀 및 아래 새 결합 실행으로 재확인한다. |
| 실제 DB+Linux decoder 결합 | **8/8**, run 8c07cca0-1ca2-4399-9ab1-780c4080a1e0, decoder build b6c53d00-7800-418f-a84a-e3294d7b3a56. 최종 정책으로 새 실행했다. 명시적 비밀번호/엔진 입력 전달·실제 decode·다른 이미지의 DB 컨테이너 종료 거부·합성 자식 SIGKILL 후 자연 lease 만료/새 인스턴스 회수·원장과 자기 자원 정리 통과. Windows/E worker의 native 검사 결합 성공은 아니다. |

최종 산출물 확인: 이번 변경 파일 8개·로컬 링크 119개·새 파일의 UTF-8/whitespace를 검사했다. dist는 원본과 바이트가 같은 공개 자산 31개와 build metadata 1개뿐이며 server/docs/tests/secret·기타 파일은 없다. 위 native 실행의 영수증 5개를 다시 조회해 남은 자기 컨테이너·이미지 태그가 각각 0개임을 확인했다. 전역 prune/강제 이미지 삭제/기존 사용자 자원 정리는 하지 않았다. 삭제 대상은 새로 생성한 합성 시험 자원뿐이며 사용자 자료를 삭제하지 않았다. 마지막 조회에서 로컬 4173 listener는 0개였다. 이번에 사용자 서버 종료 명령은 실행하지 않았고 시작 시 listener를 대조하지 않았으므로 중단 시점/원인은 확정하지 않는다. 임의 재시작도 하지 않았다. 기존 E 실패 진단/운영 secrets/설정은 건드리지 않았다.

## 남은 위험과 다음 순서

1. **기존 Docker 사용자 설정은 유지한다.** 현재 사용자 profile의 Docker config/context·credential helper·proxy 설정은 이 변경의 격리 대상이 아니다. 해당 파일에는 인증 정보가 있을 수 있고 config의 proxy는 컨테이너/빌드에 설정될 수 있다. 사용자 설정을 읽어 출력하거나 덮어쓰지 않았다. [Docker config·proxy 설명](https://docs.docker.com/reference/cli/docker/)
2. 시험 런처의 Docker 명령 인터페이스는 trusted 시험 코드용이며 운영 allowlist/OS 권한 검사가 아니다. CLI/부모 경로 ACL·서명·named pipe 접근권한·전용 계정/SCM·신뢰된 설정 전달을 입증하지 않는다. 이 런처를 제품 worker/API에 가져다 쓰지 않는다. Docker 엔진 접근권한 자체도 강력한 권한이다.
3. Windows/E worker와 실제 검사 엔진의 결합, 운영 감독/경보·보존/파기·키 회수·독립 백업/실제 복원은 남아 있다. 이번에 E 시험이나 ClamAV native 전체를 새로 실행했다고 하지 않는다. 이전 [E34/IPC 근거](windows-worker-control.md)는 당시 기록으로 유지한다.
4. 가상 자료로 비API 준비를 계속하되 실제 자료 수신·외부 접속은 열지 않는다. 독립 백업 매체와 키 회수/복원 검증을 갖춘 뒤 운영 전환을 판단한다. 사람의 사용성 관측·실물 기기·메시지 정책을 확인하고 **API/화면 연결은 마지막**에 진행한다. [전체 완료표](communication-acceptance.md)의 범위를 줄이지 않는다.

변경 파일은 환경 정책·공통 Docker 런처·PG 시험 런처·환경 회귀와 이 보고서/README·전체 완료표·서버 기반 링크다. 제품 인증/세션·SQL/권한·큐/파일 승인·UI·의존성·E 자료·Windows 서비스·Docker 설정·GitHub/Vercel 배포는 변경하지 않았다.
