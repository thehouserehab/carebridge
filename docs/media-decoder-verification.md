# 사진·영상 실제 디코더: 로컬 검증 기록

작성: 2026-10-04. P1 파일 처리의 내부 구성요소다. **파일 승인·메타데이터 제거·운영 전환·API 연결은 하지 않는다.** 합성 자료만 사용하며 기존 아동/계정/기록/첨부·브라우저 저장 키·DB·인증·배포를 변경하지 않는다.

## 현재 상태

전체 프레임을 디코딩하는 `LinuxMediaDecoder.decode()`와 명시적 격리 시험을 추가했다. Windows/관리자 프로세스는 거부한다. `inspect()`와 `verdict`는 없고 결과의 `mediaAcceptanceReady`는 항상 `false`다. 업로드 서비스의 기본 검사기는 계속 미설정이다. 안티멀웨어 clean과 정상 디코딩은 서로 다른 증거이며 두 모듈을 자동으로 파일 승인에 연결하지 않는다.

실제 FFmpeg 9.0.2에서 네이티브 시나리오 **38개와 시험 자원 정리**가 종료 코드 0으로 통과했다. 단위 정책 28개·제한 병렬 서버 전체 267개·기존 프로토타입 61개도 통과했다. 최초 23개에서 허용 코덱 전체·용량/출력/실행 시간 경계까지 확대했다. 이것은 로컬 합성 자료에 대한 디코딩 증거이며 전체 업로드 승인/운영 준비 완료는 아니다.

## 공급망과 빌드

[FFmpeg 공식 다운로드](https://ffmpeg.org/download.html)에서 9.0.2 원본과 PGP 서명·공개 키를 받았다. 공식 페이지의 공개 키 fingerprint `FCF986EA15E6E293A5644F10B4322F04D67658D8`와 실제 `gpgv VALIDSIG`를 비교했다. SHA-256과 서명을 모두 확인한 뒤에만 소스를 풀고 컴파일한다. 임의 Windows 실행파일 설치·TLS 검증 해제·자동 latest 선택은 하지 않는다. PGP 키와 fingerprint 확인 경로의 신뢰를 모든 공급망/실행 증명으로 확대하지 않으며 PQ 서명은 검증하지 않았다.

| 공개 자료 | SHA-256 |
| --- | --- |
| `ffmpeg-9.0.2.tar.xz` | `8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e` |
| `ffmpeg-9.0.2.tar.xz.asc` | `d617fd94ea354dadd2a8bb16243d37c44e1e9729b06b6ad58fe30bfb0fa943f2` |
| `ffmpeg-devel.asc` | `397b3becedcd5a98769967ff1ff8501ddc89f8368b8f766e4701377d7dbaabe5` |

자료는 공개 저장소에서 제외된 `test-results/runtime-build/ffmpeg-9.0.2/`에 있다. Dockerfile 전용 deny-all allowlist가 공개 자료 3개와 필요한 내부 코드만 build context에 포함한다. `.env`, 조사 문서·실제 첨부·DB 의존성은 제외한다. 기반 Node 이미지의 불변 digest는 `docker.io/library/node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f`다.

컴파일은 외부 통신이 가능한 **공개 패키지 준비 단계**다. Alpine 공식 서명 저장소를 사용하며 실제 build 패키지 목록도 기록한다. 이 의존성 전체를 불변 버전으로 고정하거나 CVE/SBOM 감사를 완료한 것은 아니다. 파일 검사 작업자는 별도 오프라인 컨테이너다. 빌드의 외부 접속을 국내 통제 완료로 표시하지 않는다.

네트워크 기능·자동 기능 탐색을 비활성화하고 필요한 demuxer/decoder를 선택했다. 시험 자료 생성 때문에 FFmpeg encoder·lavfi·file/pipe와 libx264/libx265/GPL 옵션이 추가로 포함돼 있다. 운영 이미지는 시험 생성 기능을 분리·최소화해야 한다. 원본/빌드 구성/`COPYING.GPLv2`는 보존하며 외부 배포하지 않았다. 배포 전 라이선스·소스 제공·특허 검토가 남아 있다. [공식 라이선스 안내](https://ffmpeg.org/legal.html)를 참고하며 법적 적합성 완료를 뜻하지 않는다.

허용 코덱 전체의 시험 encoder를 추가한 현재 ffprobe SHA-256은 `12b72afac0becf6cc5a2d71faf55b83f275f5e8c81083f8ab73df99ce830f681`, 합성 자료 생성용 ffmpeg는 `d038f0fec3f7ea8b8eec4e90e8dcce330a6f7fcb1f3595d1ecb61877d310ab90`다. 같은 서명 원본으로 재빌드한 뒤 실제 9.0.2 버전·configure 기능·패키지 목록을 확인하고 시험 코드의 승인 hash를 명시적으로 갱신했다. 최초 23개 빌드의 ffprobe hash는 `591461a17ada48b811ada5fc5998a202f599484be63064bce8da3cd833cd8ef8`이며 현재 승인값이 아니다. 패키지/컴파일러 갱신으로 바이너리가 달라지면 거부하며 원본/구성/의존성을 재검토한 뒤 별도 승인해야 한다. hash를 테스트 시작 시 자동 재작성하지 않는다.

실제 빌드의 추가 공개 패키지는 x265 4.1-r0, aom 3.14.1-r0, lame 3.100-r5, opus 1.5.2-r1, libvorbis 1.3.7-r2이며 GCC 15.2.0-r2/musl 1.2.5-r23이었다. `build-packages.txt`를 이미지에 보존한다. 이 목록을 모든 동적 라이브러리의 암호학적 승인이나 운영 공급망 감사로 확대하지 않는다.

## 디코딩 경계와 반환값

입력은 서버 소유 바이트 Readable, 기존 MIME, 사진 10MiB/영상 50MiB 이내의 크기, 전체 SHA-256만 받는다. 사용자 경로·URL·파일명·추가 필드와 이미 끝난/문자열/객체 모드 스트림은 거부한다. 전체 EOF·바이트 수·해시를 검사하고 내부 0700/0600 임시 파일을 O_EXCL/O_NOFOLLOW로 생성한다. 읽기 전용 핸들로 다시 해시를 확인한 뒤 **파일과 디렉터리 이름을 제거하고 열린 fd 3만** 네이티브 도구에 전달한다. MP4의 moov가 뒤에 있는 파일도 seek 가능한 핸들로 처리한다.

검사 명령은 고정된 실행파일과 shell 없는 argv를 사용한다. 프로토콜 whitelist는 `fd`만 허용하고 MP4 외부 data reference도 끈다. 입력 URL은 고정 `fd:`이고 사용자 문자열을 실행 명령으로 만들지 않는다. [공식 fd 규약](https://ffmpeg.org/ffmpeg-protocols.html#fd)에 따라 descriptor는 URL이 아닌 `-fd 3`으로 전달한다.

고정된 ffprobe 경로의 실제 경로·root 소유·그룹/전체 쓰기 금지·승인 SHA-256·버전을 검사 전후 확인한다. 설치된 파일을 해시해서 자동 승인하지 않는다. 실행파일 hash만으로 동적 라이브러리·OS 격리를 증명하지 않으므로 호출자가 별도 sandbox를 강제해야 한다.

`-show_frames`/`-count_frames`로 전체 영상·음성 프레임을 읽는다. 선택 프레임, 첫 프레임, 헤더의 duration만으로 통과시키지 않는다. 실제 프레임의 치수·각 스트림의 읽은 프레임 수·프레임 제어 수를 비교하고 진행 시간은 프레임 시간과 실제 음성 샘플로 계산한다. [ffprobe 공식 기능](https://ffmpeg.org/ffprobe.html)을 이용하지만 구현한 정책과 실제 시험 범위만 검증으로 판정한다.

| 한도 | 정책 |
| --- | --- |
| 전체 작업 시간/동시 작업 | 기본 90초, 설정 상한 120초, 인스턴스당 1개. 무한 대기열 없음 |
| 한 프레임 | 한 변 8192 이하·전체 4천만 픽셀 이하, 프레임 간 치수 변화 거부 |
| 전체 프레임/작업량 | 영상·음성 합계 144,000개 이하·영상 누적 200억 픽셀 이하 |
| 영상·애니메이션 진행 시간 | 실제 측정 0초 초과·600초 이하. 단일 프레임 GIF/APNG/WebP 애니메이션에도 적용하며 정적 이미지에는 재생 시간 필드를 만들지 않음 |
| 출력/단일 할당 | JSON 16MiB, 단일 native allocation 256MiB. 이것이 전체 메모리 한도는 아님 |
| 스트림/코덱 | 영상 1개·음성 최대 1개. 허용 codec만, 자막/데이터/숨은 추가 트랙 거부 |

PNG CRC·IEND와 APNG 제어 수, GIF 끝/서브블록·프레임 수, WebP RIFF 길이·프레임 수, JPEG 최종 마커/단일 프레임, MP4 atom 크기·moov/mdat, WebM bounded EBML/webm doctype를 먼저 확인한다. 이 검사는 자체 완전한 컨테이너/코덱 구현이 아니며 실제 디코딩을 대체하지 않는다. APNG의 별도 정적 기본 이미지 변형, 중간 해상도 전환, 다중 음성/자막 등은 현재 지원하지 않는다.

경고/오류 stderr는 보관·반환하지 않고 작업을 거부한다. 종료 코드 0으로도 일부 프레임만 해석될 수 있어서다. 취소/시간/출력 한도 초과에는 네이티브 자식을 kill하고 실제 close를 기다린 뒤 핸들·자원을 닫는다. 임시 정리가 실패하면 성공 결과를 반환하지 않는다. 결과는 제한된 엔진/버전, 측정 type/치수/영상 duration, 프레임 수·확인 크기/해시와 준비 불가 표시뿐이다. 원문 probe JSON, EXIF/GPS·태그·파일명·오류 내용은 반환하지 않는다. **반환에서 metadata를 생략한 것과 원본에서 metadata를 제거한 것은 다르다.**

## 실제 격리·재현·정리

`npm run test:decoder:local`은 명시적 합성 시험이다. 자동 설치·pull·로그인·약관 처리·유료 자원·API 기동을 하지 않는다. 준비된 기반 이미지/공개 소스가 없으면 실패한다. Windows의 검증된 설치 경로 CLI, 로컬 `desktop-linux` named pipe와 로컬 builder만 사용한다.

작업자는 `node`, `network=none`, 읽기 전용 rootfs, capability ALL 제거, no-new-privileges, CPU 1·RAM/swap 동일 1GiB·PID 128·`/tmp` noexec/nosuid/nodev tmpfs 256MiB다. 호스트 파일·Docker socket·사용자 볼륨·공개 포트·장치·호스트 PID/IPC/UTS는 없고 로그 드라이버 none·재시작 없음이다. 실제 inspect 값과 정책을 실행 전/후 확인한다. 시험은 여러 합성 파일을 하나의 컨테이너에서 순차 처리하므로 **운영에서 파일당 별도 작업 namespace/큐를 보장하는 launcher**는 아직 구현하지 않았다.

매 실행 UUID 이름/label·전체 컨테이너 ID·이미지 ID로 소유권을 확인한다. 실제 작업 종료를 확인한 뒤 자기 컨테이너와 이미지 태그만 삭제한다. CLI 관찰 시간 초과만으로 종료를 추정하지 않고 결과가 불명확하면 보존한다. prune/force/WSL 초기화/기존 데이터 삭제는 하지 않는다. 기반/공개 빌드 캐시와 서명 원본은 남을 수 있다.

```powershell
npm run test:decoder:local
node --test server/tests/media-decoder-policy.test.mjs server/tests/decoder-container-policy.test.mjs
node --test --test-concurrency=2 server/tests/*.test.mjs
npm test
npm run check
npm run build
git diff --check
```

기본 단위 시험에 Docker를 숨겨서 기동하지 않는다. 일반 서버 회귀는 이전 파일 수준 병렬 실패의 원인이 아직 확정되지 않아 concurrency 2로 검증했다. 기존 UI/DB/API는 변경하지 않아 브라우저/실제 PostgreSQL/ClamAV 시험을 이번 단계에서 다시 실행한 것으로 표시하지 않는다.

변경 파일은 `server/media-decoder.mjs`, `media-decoder-policy.mjs`, `media-container-validation.mjs`, `decoder-container-policy.mjs`, `decoder-container-test.mjs`, `decoder-native-test.mjs`, `decoder-test.Dockerfile`과 전용 `.dockerignore`, `server/tests/media-decoder-policy.test.mjs`, `decoder-container-policy.test.mjs`다. 루트/서버 `package.json`에는 명시적 재현 명령만 추가했다. `README.md`, 이 문서와 기존 실행환경·검사·업로드·ClamAV·서버 현황 문서의 현재 범위/후속 순서를 갱신했다. 새로운 npm 의존성·HTTP 경로·SQL 변경은 없다.

최초 작업에서는 23개를 두 번 통과했다. 후속에서는 허용 코덱 전체·최대 파일 바이트·출력/활성 프로세스 시간 초과·애니메이션 재생 한도를 추가해 38개로 확대했다. 관측 루틴을 보완한 최종 코드로 **38개와 시험 자원 정리를 세 번 연속 통과**했다. 두 번째 반복에서는 실제 관측 접근 거부를 재시도한 뒤 안정된 fd 검증까지 성공했음을 별도 고정 marker로 확인했다. 서버 전체 267개·로컬 도메인 61개·syntax/build/diff도 통과했다. 정적 `dist/`는 `src/`, `index.html`, `favicon.svg`, `build.json`만 포함한다. 서버 검사 코드·서명 원본·문서·임시 자료는 정적 배포에 포함하지 않는다. UUID 시험 자원만 전체 ID/태그/label/참조 확인 후 정리하고 서명 원본과 공개 빌드 캐시는 재빌드용으로 남길 수 있다. 마지막 Desktop 상태는 running, 기존 공식 기반 이미지 3개·컨테이너 0개였고 decoder label 이미지 태그도 없었다. 기존 사용자 데이터는 삭제하지 않았다.

이번 확대 단계의 변경 파일은 `server/media-decoder-policy.mjs`, `server/decoder-native-test.mjs`, `server/decoder-container-test.mjs`, `server/decoder-test.Dockerfile`, `server/tests/media-decoder-policy.test.mjs`, `server/tests/decoder-container-policy.test.mjs` 6개다. 관련 문서 7개는 `README.md`, 이 문서, `server-foundation.md`, `local-runtime-setup.md`, `media-scanning.md`, `media-upload-storage.md`, `clamav-native-verification.md`다. `media-decoder.mjs`의 IO/실행·기본 검사기·SQL·인증·화면·API·배포는 이번 확대에서 변경하지 않았다.

## 실제로 통과한 38개 시나리오

1. JPEG의 읽기 전용 fd 디코딩·단일 프레임·전체 크기/해시.
2. PNG의 전체 디코딩·측정 치수/해시.
3. 정적 WebP의 전체 디코딩.
4. GIF 애니메이션 4개 프레임 전체 디코딩.
5. WebP 애니메이션 4개 프레임 전체 디코딩.
6. APNG 2개 프레임 전체 디코딩·컨테이너 프레임 수 비교.
7. mdat 뒤에 moov가 있는 MP4 H.264의 seekable fd·4개 프레임.
8. WebM VP8의 4개 프레임 전체 디코딩.
9. MP4의 영상 4개·AAC 음성 94개 프레임 전체 디코딩.
10. 앞쪽은 정상이고 마지막 H.264 packet이 손상된 영상 거부.
11. 끝이 잘린 PNG/JPEG/WebP/GIF 거부.
12. 끝이 잘린 MP4/WebM 거부. warning을 정상 종료로 승인하지 않음.
13. 선언 MIME과 바이트가 다른 파일 거부.
14. 전체 내용 hash 불일치 거부.
15. 선언 크기보다 짧은 바이트 스트림 거부.
16. 호출자의 URL 추가 필드 거부. 경로/명령 선택을 받지 않음.
17. CRC를 다시 맞춘 8193 너비 PNG 헤더의 치수 제한 거부.
18. 합성 PNG text metadata가 반환값에 나타나지 않음. 원본 제거 시험은 아님.
19. 실제 source 읽기가 시작된 작업 중단·두 번째 동시 작업 거부·후속 정상 작업.
20. 8000×4000 합성 PNG의 **실제 ffprobe 실행을 관찰한 뒤 취소**. 전달된 fd 3가 read-only·unlinked임과 작업 반환 전에 해당 child가 reaped됨을 확인하고 후속 정상 작업.
21. 끝나지 않는 source의 전체 작업 시간 초과·정리·후속 정상 작업.
22. 승인되지 않은 실행파일 hash는 입력 처리 전 검사 불가.
23. 성공/거부/취소/시간 초과 후 자기 임시 폴더/파일이 없음.
24. HEVC MP4의 64×64 영상 4개 프레임 전체 디코딩.
25. AV1 MP4의 영상 4개 프레임 전체 디코딩.
26. MPEG-4 MP4의 영상 4개 프레임 전체 디코딩.
27. VP9 WebM의 영상 4개 프레임 전체 디코딩.
28. AV1 WebM의 영상 4개 프레임 전체 디코딩.
29. H.264/MP3 MP4의 전체 영상·음성 디코딩.
30. H.264/ALAC MP4의 전체 영상·음성 디코딩.
31. VP8/Opus WebM의 전체 영상·음성 디코딩.
32. VP8/Vorbis WebM의 전체 영상·음성 디코딩. 새 9개 코덱 조합은 생성 후 별도 고정 경로 probe로 실제 stream codec 이름을 확인하고, 이후 전체 디코더를 시험한다. 헤더 검사를 전체 디코딩으로 대신하지 않는다.
33. 정확히 10MiB PNG의 전체 스트리밍·CRC·해시·디코딩.
34. 정확히 50MiB MP4의 전체 스트리밍·atom·해시·디코딩. 두 최대 파일은 유효한 ancillary PNG chunk/MP4 free atom으로 크기를 맞춘 합성 자료다. 최대 크기의 복잡한 압축 비트스트림·메모리 복잡도 시험은 아니다.
35. 사진 10MiB+1/영상 50MiB+1 선언은 source를 읽기 전에 거부하고 스트림을 닫음.
36. 655.35초 지연을 가진 단일/복수 프레임 GIF의 실제 측정 재생 한도 초과 거부.
37. 유효한 3프레임 GIF 대조군과 100,000프레임 합성 GIF. 같은 선택 argv로 probe stdout을 저장 없이 세어 16MiB 초과를 확인한 뒤, 디코더가 90초 기본 deadline 전에 출력 한도로 검사 불가를 반환하고 실제 child를 회수·정리·후속 정상 처리함을 확인.
38. 8000×4000·60프레임의 유효한 APNG를 먼저 제한 없는 대조군으로 전체 디코딩한 뒤, 같은 파일의 실제 fd 3 ffprobe child 시작을 관찰하고 1초 deadline 후 검사 불가·child 회수·후속 정상 처리를 확인. APNG 자체는 10MiB 이하·누적 19.2억 픽셀·30초이며 JSON이 작아 출력 한도와 분리된다. 반환 시간도 설정 deadline 근처인지 확인해 입력 대기/출력 실패를 시간 초과로 오인하지 않음.

28개 순수 단위 정책 시험에는 600초 경계·8192 치수·4천만 픽셀·누적 200억 픽셀·프레임 수/타임스탬프·음성 샘플·숨은 트랙·CRC/끝/긴 atom 헤더·격리/소유권 변조·build context 제외를 포함했다. 새 2개는 GIF/APNG/애니메이션 WebP의 시간·단일 프레임 지연·정적 이미지의 기존 계약을 확인한다. **이 단위 경계 시험을 동일한 최악의 파일을 실제 native 엔진으로 모두 시험한 것으로 표시하지 않는다.** 허용 codec 조합은 위 합성 범위에서 검증했지만 다양한 profile/bit-depth/채널·고해상도 최대 압축 비트스트림·OOM/CPU 최악 조건·동적 라이브러리 장애·fuzz·실제 모바일 카메라 파일은 후속 검증이다. 공급자 보안 패치 선택은 전체 취약점 감사나 무해함 보장이 아니다.

## 발견한 문제와 남은 순서

공개 서명 검증 후 소스 압축 해제가 오래 정지한 첫 빌드는 실제 상태와 자기 helper의 공개 source hash/명령을 확인한 뒤 해당 GPG agent만 종료했고 종료 코드 1을 확인했다. Docker/WSL을 다시 설치하거나 전체 프로세스를 정지하지 않았다. agent를 시작하지 않는 dearmor+gpgv 방식으로 바꾼 다음 빌드는 압축 해제/컴파일이 정상 종료했다.

초기 worker에서는 WebP mux 공유 라이브러리와 합성 raw frame decoder가 빠져 시험 파일 생성이 실패했다. 이를 보완한 뒤에는 FFmpeg 9의 **build component 이름 `image_jpeg_pipe` 등과 실제 형식 이름 `jpeg_pipe`가 다름**을 확인했다. 빌드 기능 선택을 수정한 뒤 네이티브 23개가 실제 통과했다. 실패한 시험도 컨테이너 종료를 확인한 뒤 해당 run의 자원만 정리했다. 임시 합성 진단 코드/출력은 최종본에서 제거했다. 공급자 소스의 compiler 경고도 있었으므로 무경고/전체 취약점 감사 완료로 주장하지 않는다.

후속에서 애니메이션 이미지는 전체 프레임을 읽어도 재생 시간 검증에서 빠지는 결함을 발견했다. 영상뿐 아니라 GIF/APNG/애니메이션 WebP에도 실제 시간 한도를 적용했고, 단일 프레임의 긴 지연도 거부한다. 정적 이미지의 반환값은 유지한다. 승인 MIME/코덱·업로드 상태·인증·DB·화면·HTTP는 변경하지 않았다.

38개 확대 시험 중에는 출력 한도·취소·시간 초과 시나리오에서 간헐 실패가 있었다. 최초 로그만으로 모든 실패 원인을 확정하지 않았으며 성공 재시도만으로 장애 해결을 주장하지 않는다. 실패 이유를 원문 없이 고정 코드/시험 코드 줄 번호로 구분하고 `/proc`의 fd target을 flags 확인 전후 비교하도록 보강했다. 시간 초과 시험에 큰 JSON GIF를 재사용하면 출력 제한이 먼저 걸릴 수 있으므로, 정상 대조군이 있는 고해상도 APNG로 두 한도를 분리했다. 실제 실패한 컨테이너도 terminal 상태/소유권 확인 후 자기 자원만 정리했다.

추가 진단에서는 관측 시 `EACCES`를 실제로 확인했다. `/proc/PID/fd` 조회에는 별도의 접근 검사가 적용된다([Linux 공식 man-pages](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html)). 불완전한 관측만 제한 시간 안에서 다시 시도하며 성공한 동일 fd target·read-only flags 검증은 필수로 유지한다. 권한을 높이거나 실제 디코더 오류를 성공 처리하지 않았다. 최종 반복에서 접근 거부 후 실제 fd 확인까지 성공한 증거를 얻었지만, 이전의 모든 간헐 실패가 동일한 원인이었다고 확대 해석하지 않는다.

후속 [파일별 디코더 격리 실행](decoder-job-isolation.md)을 추가했다. 매 파일의 새 namespace/tmpfs·바이트 전용 stdin·실제 종료/자기 자원 정리와 별도 encoder 없는 최소 artifact를 마련했다. 합성 28개와 새 실행 계약 21개를 검증했다. 기존 38개의 encoder 포함 시험과는 artifact/검증 범위가 다르며, 이 문서의 과거 실행 당시 267개 결과를 최신 전체 회귀 288개와 혼동하지 않는다.

다음은 ① 운영 Linux transport·durable queue/장애 회수와 최소 artifact의 최악 자원/실제 카메라 검증 ② metadata 제거·원본/변환본·보존/파기 정책과 안티멀웨어 통합 ③ 국내 운영·메일/계정 복구·백업/복원 준비 ④ 마지막 API·화면 서버 연결·기기 간 시험 순서다. 실제 아동/건강 자료 사용은 계속 금지한다.
