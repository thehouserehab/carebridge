# 실제 ClamAV 로컬 격리 검증

검증일: 2026-10-04. **안티멀웨어 엔진 검증은 진행했지만 파일 승인·정상 디코딩·운영 전환·전체 P1은 완료하지 않았다.** 사용자가 허용한 로컬 PC에서 합성 자료만 사용했다. API·화면·기존 원본/저장 키·운영 DB·배포를 바꾸지 않았다.

## 결과와 환경

명시적 `npm run test:clamav:local`을 실행해 실제 엔진 13개 시나리오와 시험 자원 정리를 종료 코드 0으로 확인했다. 가상 daemon이 아닌 ClamAV 프로세스에 기존 `LocalClamAvClient`가 INSTREAM으로 바이트를 보냈다. 로컬 Docker Linux 엔진 29.8.1, Linux/amd64, 약 7.5GiB의 Docker VM 메모리를 사용했다.

- ClamAV 1.4.6 LTS. 공급자 공식 `clamav/clamav:1.4.6`을 다운로드하고 실제 RepoDigest·플랫폼을 검사한 뒤 아래 불변 digest로 고정했다. 태그를 자동 갱신하거나 `latest`를 쓰지 않는다.
- 엔진 이미지: `docker.io/clamav/clamav@sha256:57deb108fc4c72778aa83eafbca7bb7153e28c3f57c005afd38d31f16da86f23`.
- 합성 작업자 이미지: `docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f`; Node v24.15.0. 호스트 개발 버전과 일치시키기 위한 시험 버전이며 최신 운영 패치 승인이라는 뜻은 아니다.
- 별도 FreshClam 실행 종료 코드 0·OOM 없음. 실제 daemon이 보고한 정의 버전 `28142`, UTC 시각 `2026-10-03T06:24:16.000Z`를 확인했다. 시험 당시 실제 시계에 대해 48시간 제한을 적용했고 시계/정의 최대 나이를 조작하지 않았다.
- 정의 다운로드 후 해당 updater는 종료했다. scanner에는 같은 정의 볼륨을 읽기 전용으로 제공했고 파일 검사 중 정의 갱신 프로세스를 돌리지 않았다.

승인 버전 선택은 [공식 지원표](https://docs.clamav.net/faq/faq-eol.html)와 [공급자 릴리스](https://github.com/Cisco-Talos/clamav/releases), 이미지 출처·실행 방식은 [공식 Docker 안내](https://docs.clamav.net/manual/Installing/Docker.html)를 확인했다. digest 고정과 VERSION 응답은 공급망 전체의 서명 검증/암호학적 실행 증명을 대신하지 않는다.

## 갱신·검사 분리와 실제 격리

| 경로 | 네트워크·파일 | 계정·자원 |
| --- | --- | --- |
| 정의 updater | 외부 통신이 있는 Docker bridge. 공식 공개 정의만 다운로드. 새 UUID 정의 볼륨에만 쓰기 가능. 임상/사용자 파일·호스트 폴더·공개 포트 없음. | `clamav`, 읽기 전용 rootfs, 3GiB RAM/swap 동일 한도, CPU 1, PID 64, `/tmp` 256MiB |
| 실제 scanner | `network=none`, 내부 `127.0.0.1:3310`. 정의 볼륨 읽기 전용. 외부 주소·호스트 포트·사용자 폴더 없음. | `clamav`, 읽기 전용 rootfs, 4GiB RAM/swap 동일 한도, CPU 1, PID 128, `/tmp` 256MiB |
| 합성 Node worker | 이번 scanner의 전체 ID로 network namespace만 공유. 내부 loopback에 연결. 정의/사용자 볼륨·외부 네트워크·호스트 포트 없음. | `node`, 읽기 전용 rootfs, 256MiB RAM/swap 동일 한도, CPU 1, PID 64, `/tmp` 16MiB |

세 프로필 모두 capability ALL 제거, no-new-privileges, 특권/호스트 PID·IPC·UTS 금지, 디바이스 없음, Docker 로그 드라이버 `none`, 자동 재시작 없음이다. 생성/실행 전 실제 `docker inspect` 값과 정책을 비교한다. 시간대를 `TZ=UTC`로 고정한다. 로컬 named-pipe 엔진과 `desktop-linux`의 로컬 Docker builder만 사용하며 클라우드 builder/Offload를 선택하지 않는다.

**정의 갱신은 외부 통신이다.** bridge는 공식 미러로만 접속하는 방화벽 allowlist가 아니다. 파일 검사가 오프라인이라는 사실을 전체 경로가 국내에만 머문다는 증거로 확대하지 않는다. 운영 미러·지원·로그·백업·키/보존 경로의 전체 국내 통제 검토는 별도다. FreshClam은 공식 미러와 `TestDatabases yes`를 사용한다. TLS 검증 해제·개인 미러·AV 예외·Windows 보안 해제는 하지 않았다.

엔진 구성은 공식 정의만 허용하고 `FailIfCvdOlderThan 2`, StreamMaxLength/MaxFileSize 50MiB, MaxScanSize 100MiB, 재귀 8, 파일 수 1000, 검사 thread 2/queue 4, `AlertExceedsMax yes`를 명시한다. clean/verbose/syslog·탐지 상세·metadata JSON·임시 원본 보존을 비활성화한다. `MaxScanTime 30000`은 이 버전의 ZIP 검사 한도이며 모든 파일에 대한 강제 종료 시간이 아니다. 클라이언트의 전체 90초 제한·실행 작업자 제한과 daemon 내부 검사 종료를 같은 보장으로 취급하지 않는다. 옵션 의미는 [해당 1.4.6의 공식 설정](https://github.com/Cisco-Talos/clamav/blob/clamav-1.4.6/etc/clamd.conf.sample)을 참고한다.

## 실제로 시험한 13개 시나리오

1. PING/필요 명령·승인 엔진·신선한 정의 확인. `mediaAcceptanceReady: false`, `inspect()` 없음.
2. 메모리에서 만든 1×1 PNG의 clean·정확한 전체 크기/해시.
3. 공식 무해 EICAR 68바이트의 rejected. Windows 파일을 만들거나 실행하지 않고 Linux worker 메모리에서만 조합했다. 원문 탐지명/파일명은 반환·출력하지 않는다.
4. 서로 다른 PNG 두 스트림의 동시 검사·독립 해시/결과.
5. 잘못된 해시의 `SCAN_INVALID`와 입력 스트림 폐기.
6. 짧은 바이트 스트림의 `SCAN_INVALID`와 입력 스트림 폐기.
7. 정상 ZIP 대조군과 제한 경계: 내부 파일 999개는 clean, 1000개와 1001개는 rejected. 각 파일 내용은 4바이트이며 ZIP은 128KiB 미만이다. 압축 폭탄/실제 악성 코드는 사용하지 않았다.
8. 사진 최대 10MiB 합성 바이트의 전체 전송·해시·clean.
9. 사진 10MiB+1 선언은 전송 전에 거부.
10. 영상 최대 50MiB 합성 바이트의 전체 전송·해시·clean.
11. 영상 50MiB+1 선언은 전송 전에 거부.
12. 닫힌 실제 loopback 포트는 원문 없는 `SCAN_UNAVAILABLE`.
13. 실제 스트림 읽기가 시작된 뒤 중단: 입력 폐기·검사 불가, 이후 daemon 상태 점검 가능.

**ZIP과 최대 용량 자료는 MIME을 검증하는 디코더 시험이 아니다.** 이 시험의 clean은 안티멀웨어 결과에 한정한다. 전체 프레임·코덱·EXIF/GPS·다중 프레임·변환본 안전성을 시험한 것처럼 표시하지 않는다.

처음 11개, 용량 경계 추가 후 13개가 통과했다. 대조군을 보강한 중간 실행에서는 “ZIP 내부 파일 1000개가 clean일 것”이라는 시험 가정이 실패했다. 안전 한도를 늘리거나 정상 결과로 바꾸지 않고 경계를 다시 측정했다. 최종 시험은 999/1000/1001의 위 결과를 확인하며 13개 통과했다. 실패한 실행도 작업자 종료를 확인하고 이번 실행의 시험 자원만 정리했다. 이 측정은 임의의 모든 압축 형식/제한 초과 동작을 증명하지 않는다.

## 재현·정리·변경 범위

먼저 사용자 승인과 실제 로컬 엔진/이미지 준비를 확인한다. 이 명령 자체는 설치·이미지 pull·로그인·약관 동의를 자동으로 하지 않는다. 승인 이미지가 없거나 엔진/로컬 builder가 다르면 파일을 보내기 전에 거부한다. scanner+worker+여유를 위한 Docker VM 메모리 최소 5376MiB를 요구하지만 실제 사용 가능 메모리/운영 용량 보장은 아니다.

```powershell
npm run test:clamav:local
node --test server/tests/clamav-container-policy.test.mjs server/tests/clamav-client.test.mjs
node --test --test-concurrency=2 server/tests/*.test.mjs
npm test
npm run check
npm run build
git diff --check
```

기본 `npm test`/서버 단위 시험에 실제 daemon 설치·기동을 숨겨 넣지 않는다. 명시적 실행마다 UUID 이름/소유 label·전체 컨테이너 ID·이미지 ID·정의 볼륨 생성 시각을 검사한다. 정리 때 기존 컨테이너/볼륨을 이름만 보고 채택하지 않는다. worker가 종료한 뒤에만 scanner를 정지하고 해당 run의 컨테이너·정의 볼륨·두 이미지 태그만 제거한다. `--force`, prune, WSL 초기화, 일반 자료 삭제는 사용하지 않는다. 공개 정의는 공식 서버에서 다시 받을 수 있으며 기반 이미지/빌드 캐시는 남을 수 있다.

CLI 관찰 시간 초과는 실제 작업 종료의 증거가 아니다. 결과를 모르면 시험 자원을 보존하고 고정 오류 코드와 이번 run의 ID만 출력한다. 자동 재실행·기존 daemon/DB 정지는 하지 않는다. 이 소유 검사도 악성 관리자 권한의 호스트 조작까지 방어하는 경계는 아니다.

전체 서버 회귀는 `node --test --test-concurrency=2 server/tests/*.test.mjs`로 239개, 로컬 `npm test`는 61개 통과했다. 이번 컨테이너 안전 정책 시험은 10개이고 기존 ClamAV 통신 계약 26개도 포함된다. 실패/취소/건너뜀은 0이다. `npm run check`, `npm run build`, `git diff --check`를 통과했고 `dist/`는 `src/`, `index.html`, `favicon.svg`, `build.json`뿐이며 검사 코드/서버/문서가 포함되지 않음을 확인했다. 브라우저 UI는 변경하지 않아 다시 검사하지 않았다. 최종 별도 재확인에서는 Desktop running·Engine 29.8.1/Linux, 컨테이너 0개·기반 이미지 3개이고 이번 시험 label의 잔존 볼륨/이미지 태그는 없었다.

신규 파일은 `server/local-docker-test-runtime.mjs`, `clamav-container-policy.mjs`, `clamav-container-test.mjs`, `clamav-native-test.mjs`, 두 시험 config, Dockerfile/전용 deny-all allowlist, `server/tests/clamav-container-policy.test.mjs`다. 루트/서버 package에는 명시적 실행 스크립트만 추가했다. 기존 업로드 검사기·ClamAV 클라이언트·DB·인증·SQL·API·UI 동작은 바꾸지 않았다. build context는 필요한 공개 코드/config만 허용하고 `.env`, DB 의존성, 문서/조사 자료, 업로드를 제외한다. 정적 `dist/`에도 서버/시험/문서를 넣지 않는다.

## 남은 위험과 다음 우선순위

후속 2026-10-04 [실제 FFmpeg 디코더 38개 시나리오](media-decoder-verification.md)를 별도로 통과했다. 이 문서의 13개 안티멀웨어 결과/239개 당시 회귀와 혼합하지 않는다. metadata 제거·다양한 실제 파일/최악 자원 조건·운영 파일당 격리·두 경로 통합·파일 승인은 남아 있으며 최신 전체 회귀는 디코더 단계에서 267개다.

1. 실제 이미지/영상 디코더: 전체 디코딩, 손상/다중 프레임/코덱·픽셀/시간/메모리 한도, metadata 제거·원본/변환본 정책. 검증 전 `scanner.inspect()`/파일 승인 기능을 연결하지 않는다.
2. 실제 engine의 정의 없음/오래됨·갱신 중·프로세스 장애/OOM 등 부정 사례와 운영 작업 큐·취소/회수·서명/설정 배포 통제. 가상 daemon 계약 시험을 이 실제 검증으로 바꿔 부르지 않는다.
3. 국내 비공개 저장소·보존/파기·백업/복원·메일/계정 복구·관리자 운영 준비. 실제 아동/건강 자료는 계속 금지한다.
4. 위 준비 후 마지막으로 API·서버 연결·기기 간 전송/재접속 검증. 실제 검사가 있어도 감염 없음·전체 보안/법적 적합성·개편안 완료를 보장하지 않는다.
