# 파일별 디코더 격리 실행

2026-10-04. P1 첨부 처리의 내부 실행 계층이다. **실제 업로드 승인, API/화면 연결, 국내 운영 배포 완료가 아니다.** 기존 브라우저 파일·기록·공유본·인증·DB 상태를 바꾸지 않는다. [디코더 38개 검증](media-decoder-verification.md)과 별개로 파일마다 새 작업 환경을 만드는 경로를 추가했다.

후속 [실행 원장·복구 기반](decoder-job-journal.md)을 추가했다. 명시적으로 주입하면 PostgreSQL에 opaque intent/receipt를 저장하고 engine 전체 capacity·소유권/generation을 검사한다. 기존 이 문서의 288개/원장 없는 28개 native 결과는 해당 단계의 범위이며, 최신 서버 회귀는 326개다. heartbeat 실패/즉시 취소 때 입력 오류 관찰을 유지하는 후속 수정도 포함한다. [Linux 후속](linux-decoder-runtime.md)에서 원장+실제 decoder의 8개 결합·SIGKILL/자연 임대 만료 회수를 확인했으며 운영 배치/전체 장애 행렬은 남아 있다.

## 구현과 신뢰 경계

2026-10-05 [원본/후보 결합](media-preparation.md)에서 같은 고정 offline worker에 별도 `prepare()`와 길이 프레임 바이너리 응답을 추가했다. 기존 decode 프로토콜/4KiB 한도는 유지하며 encoder·네트워크·engine mount를 넣지 않는다. 최소 artifact의 전체 허용 코덱/음성·애니메이션 준비/반환 재디코딩·오류/취소·불법 PNG 행 거부 등 **49개**를 확인했다. 원본 decode가 성공하기 전에 metadata를 제거하지 않는다. 종료 명령과 자연 종료의 경합은 같은 엔진·exact full ID·소유권·독립 terminal 확인으로만 해결하며 불확실하면 기존처럼 보류한다. 아래 28개/288개는 당시 기록이고 최신 증거·실패·회귀/지원 부분집합과 운영 파일 승인 미완료 범위는 결합 문서에 있다.

`server/decoder-jobs.mjs`의 `IsolatedMediaDecoder.decode()`는 운영자가 제공한 로컬 실행 어댑터·불변 이미지 ID·엔진 신원을 요구한다. 요청 본문이나 환경변수로 실행 대상을 자동 선택하지 않는다. 웹앱/HTTP 프로세스에 Docker socket, 관리자 권한 또는 임의 명령 실행 기능을 주지 않는다. 이 단계의 실제 어댑터는 **승인된 Windows PC의 합성 시험 전용**이었다. 이후 `linuxDecoderRuntime()`을 별도로 구현/검증했지만 자동 운영 서비스·국내 배포를 구성한 것은 아니다.

파일 하나마다 UUID와 전체 컨테이너 ID가 다른 작업을 생성한다. 같은 인스턴스에서는 기본 최대 2개이며 초과 요청은 검사 불가로 반환한다. 대기열을 무한히 쌓거나 같은 작업 공간을 다음 파일에 재사용하지 않는다. 이미지가 Linux/amd64·비관리자이며 volume/공개 포트를 선언하지 않았는지 확인한 다음, 실제 생성된 컨테이너의 설정을 검사한다. 검사가 끝나기 전에는 입력을 읽지 않는다.

| 실행 경계 | 강제/확인 항목 |
| --- | --- |
| 네트워크·호스트 | `network=none`, 공개 포트/호스트 폴더/장치/engine socket 없음, 호스트 PID·IPC·UTS 공유 금지 |
| 권한 | `node` 사용자, root filesystem 읽기 전용, capabilities 전체 제거, 정확한 `no-new-privileges`; 별도 seccomp 해제 옵션 거부 |
| 자원 | CPU 1개, 메모리 1GiB·추가 swap 없음, PID 128, 파일 descriptor soft/hard 1024 |
| 임시 파일 | 작업 전용 `/tmp` tmpfs 256MiB·noexec/nosuid/nodev; 원본은 Linux 디코더의 0700 디렉터리/0600 파일, 디코딩 전 unlink와 읽기 전용 fd 3 |
| 실행·로그 | 고정 Node entrypoint와 고정 worker 파일, stdin 사용·TTY 없음, 재시작 금지, Docker log driver `none` |
| 시간 | 호스트 기본 작업 deadline 120초, worker 헤더 대기 5초, 디코더 기본 90초, worker 전체 생존 110초 |

호스트 deadline은 취소를 시작하는 시각이지 모든 엔진 제어 요청이 즉시 끝나는 보장이 아니다. 생성/조회/정지/삭제에는 별도의 유한한 제어 시간 제한이 있으며, 실제 종료와 정리를 확인할 때까지 결과를 성공으로 반환하지 않는다. Linux kernel·Docker daemon·운영자/승인 이미지 자체가 신뢰 경계다. 설정 검사가 호스트 침해나 모든 kernel 취약점을 막는 증명은 아니다.

## 입력·응답·실패

`decoder-job-protocol.mjs`는 4바이트 big-endian 길이, 1KiB 이하 UTF-8 JSON 헤더, 이후 원본 바이트 EOF로 구성한다. 헤더는 protocol·작업 nonce·MIME·바이트 수·전체 SHA-256만 포함한다. 아동/계정 ID·파일명·URL·보관 경로·캡션은 보내지 않는다. 허용 6개 MIME와 사진 10MiB/영상 50MiB 한도를 유지한다.

호스트와 worker가 각각 전체 크기·해시·EOF를 확인한다. 호스트 전송은 최대 64KiB 복사 조각과 backpressure를 사용한다. EOF 검증 전 조기 성공, 다른 nonce, 추가 JSON 필드, 잘못된 엔진/크기/프레임/치수/진행 시간, 원문 진단은 받아들이지 않는다. worker 응답은 4KiB 이하이며 native stdout은 별도로 16MiB 제한이다. native stderr는 원문을 보존/전달하지 않는다.

성공 결과는 제한된 디코딩 증거뿐이다. `mediaAcceptanceReady:false`이며 `inspect()`/`verdict`가 없다. 이미지를 디코딩할 수 있다는 결과를 안티멀웨어 검사, EXIF/GPS 제거, 안전한 파일 또는 공유 허가로 바꾸지 않는다. `MediaUploads` 기본 검사기는 계속 미설정이다.

입력/내용 문제는 `SCAN_INVALID`, 실행·정책·취소·시간·정리 문제는 `SCAN_UNAVAILABLE`만 반환한다. `docker start --attach`가 worker 종료 코드 1을 전달할 수 있다는 실제 시험 결과를 반영했다. 비정상 CLI 종료를 성공 처리하지 않으며, 실제 terminal 컨테이너의 종료 코드와 nonce가 맞는 제한된 오류 envelope가 있을 때만 파일 거부 오류로 구분한다. 정상 결과는 실제 종료 코드 0이 필수다.

취소/실패에도 입력을 닫고, 확인된 자기 UUID·전체 ID·이름·label·이미지·엔진만 정지/삭제한다. CLI 프로세스 종료를 컨테이너 종료로 간주하지 않는다. 원본/작업이 남거나 정리가 불확실하면 정상 디코딩 결과도 폐기한다. 이후 그 인스턴스는 새 작업을 거부하며 `retainedJobs()`에 opaque 작업 영수증만 남긴다. `recoverRetained()`는 운영자 내부 회수이며 재확인된 자기 자원만 처리한다. 생성 응답이 불확실하고 대상이 발견되지 않는 경우, 없다는 조회만으로 원래 생성 요청이 종료됐다고 추측하지 않는다.

## 최소 디코더 artifact

`decoder-job.Dockerfile`은 기존 시험 encoder 이미지와 분리했다. 동일한 서명/해시 확인 FFmpeg 9.0.2 소스와 고정 Node 기반 image digest를 사용한다. 새 빌드는 ffprobe와 허용 decoder만 포함하며 **ffmpeg encoder executable·network/file/pipe protocol·GPL 빌드 옵션은 넣지 않는다.** 외부 입력 protocol은 seekable fd만 활성화한다. 서명 원본의 정확한 hash/fingerprint는 [기존 검증 기록](media-decoder-verification.md)에 있다.

2026-10-04 실제 version/configuration·빌드 패키지 목록을 별도 검토한 최소 ffprobe SHA-256:

`4ef9928dcf1137bba3f36e4c9e78259d28a6213d1bb7b3d8b341bd6a60230aef`

worker 코드에 승인 값을 명시한다. 실행할 때 설치된 파일을 해시해 자동 승인하지 않는다. 빌드가 달라지면 다시 검토하기 전에는 거부한다. Alpine 공개 빌드 패키지/컴파일러와 모든 동적 라이브러리가 완전히 재현 가능한 lock/SBOM으로 고정됐다는 의미는 아니다. 포함한 LGPL 원문만으로 전체 배포 license·특허·고지 검토가 끝난 것도 아니다.

Docker build context는 deny-all에 정확한 내부 모듈과 공개 서명 소스만 허용한다. `.env`·DB·실제 첨부·사용자 폴더를 보내지 않는다. 공개 빌드만 인터넷을 사용할 수 있으며 검사 작업은 오프라인이다. Windows 시험에서 payload·생성/정리 명령은 고정 로컬 named pipe를 사용한다. Buildx가 요구하는 named context는 공개 소스 빌드에만 사용하고, 빌드마다 그 endpoint가 같은 로컬 pipe인지 다시 확인한다. 사용자 컨텍스트/설정을 변경하지 않는다.

## 합성 검증과 재현

다음 명령은 자동 API 실행/배포 없이 명시적으로 실행하는 시험이다. 기존 공식 Node 이미지, 로컬 Docker Linux 엔진, 검증된 공개 소스가 필요하다. 실사용 파일을 가져오거나 새로운 계정/유료 자원을 만들지 않는다.

```powershell
node --test server/tests/decoder-jobs.test.mjs server/tests/decoder-container-policy.test.mjs
npm run test:decoder-jobs:local
npm run test:server
npm test
npm run check
npm run build
git diff --check
```

계약 시험은 새 21개와 기존 컨테이너 정책 6개다. 새 namespace·입력 EOF·nonce·응답 한도/형태·취소/시간 초과·최대 동시 작업·정리 실패 시 성공 폐기·회수·불명 생성/엔진/소유권 변경·직접 command 변조·private build context를 검증한다. 가상 runtime 보고서는 실제 디코딩 증거가 아니다.

별도 로컬 Docker 시험은 **28개**로 구성한다:

- 실제 최소 artifact로 18종의 전체 디코딩: PNG/JPEG/정적 WebP/GIF/애니메이션 WebP/APNG, MP4 H.264/HEVC/AV1/MPEG4, WebM VP8/VP9/AV1, MP4 AAC/MP3/ALAC 및 WebM Opus/Vorbis 음성 조합. 전체 프레임·치수·바이트/해시·음성 유무를 확인한다.
- 조각난 헤더/바이트, 과대 헤더, 입력 없는 5초 헤더 deadline, worker 직접 SHA 불일치.
- 호스트 전체 크기/해시 불일치, 실제 손상/MIME 불일치/끝 잘림 거부, 입력 IO 오류의 원문 비노출.
- 실제 running worker를 확인한 후 취소, 실제 running worker의 입력 정지 deadline, 두 파일의 동시 독립 처리. 후속 정상 처리와 각 전체 ID의 실제 삭제를 확인한다.

고정 합성 패턴은 별도 **시험용 encoder artifact**에서만 생성한다. 실제 source stream codec을 확인한 후 바이트를 시험 호스트 메모리로 반환하고 새로운 각 decoder 작업의 stdin으로 전달한다. encoder 기능을 decoding artifact에 추가하지 않는다. 시험 컨테이너와 단일 소유 tag/image는 참조가 없고 ID/label이 맞을 때만 제거하며 공식 기반 이미지·공개 소스·빌드 캐시는 보존한다.

최종 입력 EOF 검증·격리 정책 코드에서 **28개와 소유 자원 정리를 두 번 연속 통과**했다. 기존 encoder 포함 디코더 38개와 실제 PostgreSQL 18.6의 다중 연결 8개도 다시 종료 코드 0으로 통과했다. 새 실행 계약 21개를 포함해 서버 전체 288개·로컬 도메인 61개, syntax/build/diff가 통과했다. 실패/건너뜀/취소 없이 끝난 명령의 범위만 완료로 표시한다. 이 28개가 기존 38개의 최대 바이트·누적 pixel·출력/프로세스 경계를 최소 artifact에서 전부 재시험한 것은 아니다.

최초 artifact 구성 검토용 단일 image tag도 전체 ID/정확한 label/단일 tag/컨테이너 참조 없음 확인 후 제거했다. 최종 decoder 시험 label 이미지가 남지 않았음을 확인했다. 공식 기반 이미지·서명 소스·공개 빌드 캐시는 보존하며 사용자 파일/DB를 삭제하지 않았다. Resource Saver 설정을 변경하지 않았으므로 사용하지 않을 때 엔진은 다시 절전 상태가 될 수 있다.

변경 파일은 다음과 같다. 기존 사용자 변경·브라우저 코드·인증·SQL·기존 저장 데이터를 덮어쓰지 않았다.

- 실행: `server/decoder-jobs.mjs`, `decoder-job-protocol.mjs`, `decoder-job-worker.mjs`, `decoder-container-policy.mjs`, 시험 전용 `local-docker-test-runtime.mjs`.
- artifact: `server/decoder-job.Dockerfile`/`.dockerignore` 신규, 기존 `decoder-test.Dockerfile`/`.dockerignore`의 시험 exporter target 추가.
- 검증: `server/decoder-fixtures.mjs`, `decoder-job-container-test.mjs`, `tests/decoder-jobs.test.mjs`, `tests/decoder-container-policy.test.mjs`, root/서버 `package.json`의 명시적 시험 명령.
- 문서: 이 문서, `README.md`, `server-foundation.md`, `media-decoder-verification.md`, `media-scanning.md`, `media-upload-storage.md`, `local-runtime-setup.md`.

## 실패 이력과 남은 작업

첫 시험 빌드는 fixed `--host`와 named Buildx builder의 조합이 거부되어 종료 코드 1로 끝났다. 실제로 해당 이미지가 없음을 확인했고 이전 실행을 살아 있다고 간주해 중복 시작하지 않았다. payload에는 고정 pipe를 유지하면서 공개 build만 검증된 named context를 사용하도록 수정했다. 새 UUID 빌드 후 실제 합성 시험을 실행했다.

다음 시험에서는 17종 decode는 통과했으나 손상 파일 거부의 CLI/worker 종료 처리에서 실패했다. 직접 worker 대조군의 **CLI 1 / 실제 worker 1 / `SCAN_INVALID` envelope**를 확인한 뒤 host 구분을 수정했다. 실패를 성공으로 대체하거나 파일을 승인하지 않았다. APNG·헤더 정지/취소·EOF 검증도 추가했다.

남은 우선순위는 ① 최소 artifact의 최악 자원/실제 카메라 합성 범위 확대·fuzz와 운영 Linux adapter ② 여러 프로세스의 durable queue/중복 실행 방지·시작 시 orphan reconciliation·서비스 중단/엔진 장애 회수 ③ metadata 제거·원본/변환본·파기/복원과 안티멀웨어 통합 ④ 국내 운영 저장/암호화·권한·메일/복구·백업 준비 ⑤ 마지막 API/화면 연결과 서로 다른 기기에서 재접속/전송 검증이다.

worker 생존 제한은 정상 엔진이 살아 있을 때 자기 namespace를 종료시키는 장치다. 호스트 장애 후 컨테이너 객체 회수나 daemon 장애·여러 프로세스 전체 자원 통제를 해결하지 않는다. 국내 통제·개인정보 보호·전체 개편안/P1 완료를 주장하지 않으며 **실제 아동/건강 자료 사용은 계속 금지**한다. 보호자 이해도·실제 사용성 비교도 별도의 확인이 필요하다.
