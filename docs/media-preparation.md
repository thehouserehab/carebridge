# 원본 검사와 공유 후보 처리의 결합

2026-10-05. 개편안 P1의 사진·동영상 전달 기반 후속이다. **원본 안티멀웨어 → 별도 격리 작업의 원본 디코딩·변환·후보 디코딩 → 후보 안티멀웨어**를 실제 호출 흐름으로 연결했다. 본 문서의 기본 준비 모듈은 미승인 메모리 후보를 반환한다. 이후 [분리 저장·원자적 사용 가능 전환](media-preparation-storage.md)에서 `MediaUploads`의 명시적 preparation 경로에 비공개 파일 저장·불변 증거·후보 제공을 연결했다. 기본 서비스 미설정 시 격리, 기존 첨부 ID·001~012 SQL·UI/인증/관계와 API 마지막 원칙은 유지한다. 아래 434개/12개 등은 결합 모듈 단계의 당시 검증이며 최신 저장 검증은 후속 문서를 참고한다.

## 실행 흐름과 계약

```text
비공개 원본의 새 읽기 스트림
  → 로컬 ClamAV: 정확한 바이트·SHA-256·EOF 및 정의 상태 확인
  → 원본의 새 읽기 스트림
  → UUID 오프라인 컨테이너: 원본 전체 디코딩
      → 별도 후보 생성·정규화 재실행/동일성 확인
      → 후보 전체 디코딩·측정한 재생 정보 비교
  → 실제 컨테이너 종료·소유권 정리 확인
  → 길이 프레임으로 받은 후보의 크기·SHA-256 재검사
  → 같은 정의 상태의 로컬 ClamAV: 후보 바이트·SHA-256·EOF 확인
  → 미승인 후보와 제한된 내부 검사 증거 반환
```

`MediaPreparation`은 명시적 `LocalClamAvClient`와 `IsolatedMediaDecoder`를 받는 **신뢰 작업자 서비스 구성요소**다. 웹/HTTP 프로세스에 엔진 소켓을 주거나 이 서비스를 자동 실행하지 않는다. `prepare({ type, size, sha256, openSource }, { signal? })`의 `openSource`는 서버가 작성한 비공개 원본 읽기 함수다. 요청 본문에서 코드·경로·URL·파일명·사용자/아동 ID를 받는 함수가 아니다. 두 읽기는 같은 전체 원본 해시에 결합되므로 중간에 원본이 바뀌면 실패한다.

원본 탐지는 작업 환경 생성 전에 중단한다. 후보 탐지는 후보 바이트를 반환하지 않는다. 검사 정의/엔진이 두 검사 사이에 달라지거나 검사·IO·프로토콜·종료·정리·취소가 불확실하면 성공을 폐기한다. 입력/바이트 오류는 `SCAN_INVALID`, 처리 불가/장애는 `SCAN_UNAVAILABLE`로 정규화하며 내부 경로·원문 오류·탐지명·프로브 원문을 노출하지 않는다.

정상 결과는 `status: 'prepared'`, `bytes`, 원본/후보 manifest, 각각의 안티멀웨어 및 디코딩 증거다. **`prepared`는 저장하거나 공유해도 된다는 뜻이 아니다.** 모든 결과의 `mediaAcceptanceReady`는 false이며 `inspect`, 업로드 승인용 `carebridge-media-v1`, DB 변경 또는 사용자 파일 URL은 제공하지 않는다. `MediaUploads` 생성자에 이 객체를 검사기로 직접 주입하면 거부한다.

## 격리·프로토콜·측정 정보

기존 `decode()`의 `carebridge-decoder-job-v1`과 4KiB 텍스트 응답은 유지한다. 같은 승인 artifact/고정 worker 명령에 별도 `carebridge-media-preparation-v1` 입력을 추가했다. 후보 응답은 **4바이트 big-endian 보고서 길이 + 최대 8KiB canonical JSON + 정확한 후보 바이트**다. base64, 임의 파일 경로 또는 JSON의 원본 메타데이터를 사용하지 않는다. nonce·MIME·원본/후보 해시·크기·보고서 필드·EOF·실제 worker 종료 코드를 함께 확인한다. 잘린/추가 바이트, 중복 JSON 키, 잘못된 UTF-8, 다른 job 응답은 거부한다. 후보 반환 Buffer는 비공유 backing allocation으로 복사해 transport/다른 job의 메모리 보기에 연결하지 않는다.

준비 작업도 파일마다 새로운 UUID·network=none·비관리자 node·읽기 전용 root·호스트/엔진 mount 없음·로그 없음·CPU 1개·메모리 1GiB·tmpfs 256MiB·PID 128의 동일 격리 정책을 사용한다. 엔진 신원·전체 container/image ID·정확한 명령·실제 종료/정리를 확인한 뒤에만 결과를 반환한다. 정리 실패는 기존 원장의 소유권/generation/회수 경로에 남기고 새 작업을 막는다. 원장이 없는 명시적 합성 시험은 운영 재시작 복구를 대체하지 않는다.

worker에 encoder·file/pipe/network 프로토콜·CMM을 추가하지 않았다. 최소 ffprobe 9.0.2 승인 SHA-256은 기존 `4ef9928dcf1137bba3f36e4c9e78259d28a6213d1bb7b3d8b341bd6a60230aef`다. 메타데이터 파서는 컨트롤러가 아니라 오프라인 worker에서 실행한다. 이미지/ICC/영상의 버전 상수는 IO 없는 공통 `media-preparation-policy.mjs`로 분리했다.

전후 디코딩의 MIME·가로/세로·전체 영상/음성 프레임 수·측정된 영상 진행 시간을 비교한다. 추가 `timelineSha256`은 검증한 코덱/스트림 정보와 **각 프레임의 시각·길이·음성 샘플 수**를 순서대로 해시한다. 같은 크기/프레임 수/전체 길이의 다른 타이밍도 구분한다. 이미지 애니메이션의 시각·길이도 포함한다. 원문 태그·경로·문자 설명은 넣지 않는다. 이 값은 **픽셀/PCM 해시, 색 품질, 임상 동등성 또는 악성 worker에 대한 암호학적 증명은 아니다.** 압축 바이트·표시 수치 보존과 이미지 색/실제 픽셀·음성 비교의 범위는 기존 [이미지](image-metadata-processing.md), [영상](video-metadata-processing.md) 검증과 함께 해석한다.

## 검사·자원·데이터 보호의 한계

- 안티멀웨어의 clean은 탐지되지 않았다는 뜻이다. 실제 합성 PNG의 tEXt에 넣은 무해 EICAR 문자열은 정의 28144에서 탐지되지 않았다. 이 실패한 탐지 가정을 삭제하지 않고 별도 대조군으로 유지한다. 검사 성공이 모든 원본의 무해함이나 모든 metadata 제거를 보증하지 않는다. 공식 원문 EICAR 대조군은 디코더 생성 전 거부되는지 따로 검사한다.
- 손상 PNG는 `AlertBrokenMedia` 경로에서 먼저 거부될 수 있다. CRC/zlib가 맞지만 행 필터가 99인 대조군은 실제 ClamAV에서 clean이었다. 승인 FFmpeg 소스의 행 필터 switch에는 알 수 없는 값의 거부 분기가 없다. 따라서 공통 `validateMediaContainer`에 **압축 해제 길이·checksum/EOF·필터 0~4·Adam7/프레임별 행 구조**를 추가했다. 이제 실제 clean 이후 격리 worker에서 `SCAN_INVALID`로 거부하며 후보 검사/반환은 하지 않는다. 이는 모든 PNG 오류나 픽셀 의미의 완전한 검증을 뜻하지 않는다. 필터·압축·인터레이스 기준은 [W3C PNG 3](https://www.w3.org/TR/png-3/)를 확인했다.
- PNG 래스터 검사는 재압축/픽셀 변경 없이 최대 예상 행 바이트까지만 inflate하고, 단일 래스터 256MiB·기존 치수/누적 픽셀 한도를 적용한다. `maxOutputLength`와 `info`의 소비 길이는 실제 사용하는 [Node 24.15.0 zlib 계약](https://nodejs.org/download/release/v24.15.0/docs/api/zlib.html)을 확인했다. PNG 명세상 무시할 수 있는 IDAT 뒤 미사용 padding도 현재 보안 부분집합에서는 거부한다. 기존처럼 별도 poster가 있는 APNG는 지원하지 않는다. 모든 표준 파일을 수용한다는 뜻이 아니다.
- ICC 고지/기술적 날짜·색/회전·코덱 내부 데이터와 얼굴·음성은 기존 정책대로 남는다. 익명화나 개인정보 동의·보존/파기·국내 운영 적합성 검토 완료가 아니다.
- 준비 서비스 기본 전체 제한은 240초, 인스턴스당 동시 처리 상한 2개다. 검사기/격리 작업자의 더 짧은 개별 제한도 유지한다. PNG 각 chunk/래스터 전후에는 monotonic 경과 시간과 취소를 확인해 제한시간이 지난 동기 검사 뒤 native 프로세스를 새로 시작하지 않는다. 이 checkpoint도 단일 zlib 호출을 선점하지 못하므로 별도 컨트롤러의 실제 container 종료/자원 제한을 대체하지 않는다. 유효 형식이더라도 자원/시간 한도로 처리되지 않을 수 있다. 최대 용량·복잡도·모든 실제 코덱/기기 표시를 이 단계의 합성 성공으로 보증하지 않는다.
- 취소된 원본 읽기 함수가 늦게 스트림을 반환해도 닫는다. 엔진 작업을 조기 Promise.race로 버리지 않아 실제 종료/정리 또는 보류 판정까지 처리 슬롯을 유지한다. Buffer 0 채우기는 정리 위생일 뿐 안전한 메모리 삭제 증명이 아니다.
- worker 소스가 추가됐으므로 승인 이미지 ID는 새 artifact다. 기존 운영 원장을 같은 엔진/다른 image 설정으로 임의 변경하지 않는다. 이전 artifact/구성으로 기존 job을 종료·회수하고, 검토된 rollout/원장 전환 정책을 확정해야 한다. 실제 운영 image 등록은 수행하지 않았다.

## 검증과 재현

계약 시험에는 실제 loopback TCP를 쓰는 ClamAV **대역** 및 Docker **대역**이 포함된다. 이 시험의 보고서는 native 디코딩/안티멀웨어를 했다는 증거가 아니다. 별도 실제 Docker 명령의 성공·종료·정리를 구분해 기록한다.

```powershell
npm run test:server
npm run test:decoder-jobs:local
npm run test:media-preparation:local
npm run test:decoder-linux:local
npm run check
npm test
npm run build
```

`test:media-preparation:local`의 신뢰 Linux 컨트롤러는 명시적으로 1개의 엔진 소켓을 받고 scanner의 network=none namespace에서 loopback 통신한다. 각 비신뢰 파일 worker에는 소켓·호스트 mount·scanner 네트워크를 제공하지 않는다. 새로운 일회용 UUID의 공개 정의 volume만 만들고 updater는 공개 정의만 다운로드한 뒤 종료한다. 실제 임상 파일·기존 DB·운영 저장소·외부 공개 포트는 사용하지 않는다. controller의 socket mount가 readonly여도 엔진 API 자체가 read-only인 것은 아니므로 웹/파일 worker에 이 시험 프로필을 적용하면 안 된다.

현재 종료까지 확인한 결과:

- `npm run test:server`: **434개 통과**, 실패/취소/건너뜀 0. 이전 387개 + 결합 계약 28개 + PNG 래스터/작업 한도 15개 + 종료 경합 계약 4개다. 실제 loopback 대역·PGlite·임시 디스크를 포함하지만 native 결과와 구분한다. 메모리/프로세스 재현성을 위해 서버 시험 동시성을 2개로 고정했고 의존성/lock은 바꾸지 않았다.
- `npm run test:media-preparation:local`: **12개 통과**, 실제 승인 ClamAV 1.4.6/정의 28144(UTC 2026-10-05T06:24:24.000Z)·Linux adapter·파일별 최소 worker의 결합을 실행했다. PNG/APNG/GIF의 두 검사와 바이너리 반환, 6가지 PNG 깊이/필터/Adam7 정상 조합, 원문 탐지, embedded-marker 한계, 두 종류의 손상, 실제 running 작업 취소·원본 변경·새 job 재시도·자기 자원 정리를 확인했다. 이 결합 native 시험은 이미지이며 영상의 전체 코덱 준비 검증과 구분한다.
- `npm run test:decoder-jobs:local`: **49개 통과**. 기존 전체 허용 코덱/음성·애니메이션 18조합의 격리 decode, 같은 조합의 원본/후보 준비와 별도 namespace에서 반환 후보 재디코딩, 입력/취소/시간/독립 작업 12개와 불법 PNG 필터 거부를 실제 확인했다. 최소 ffprobe 해시는 바꾸지 않았다. 모든 job 종료와 정확한 시험 image tag 정리도 확인했다.
- `npm run check`, `npm test` **61개**, `npm run build`: 종료 코드 0. 브라우저 UI는 수정하지 않아 UI 시험을 다시 실행했다고 주장하지 않는다.

- `npm run test:decoder:local`: **38개 통과**, 실제 전체 코덱·10/50MiB 경계·출력/손상·취소/제한시간·자기 scratch/container/image 정리. 제한시간 native 대조군은 실제 관찰한 private fd의 자기 ffprobe를 SIGSTOP하고 5초 설정의 deadline이 SIGKILL/회수하도록 했다. 원본 정상 디코딩 대조와 다음 처리도 확인한다.
- `npm run test:image-metadata:local` **27개**, `npm run test:video-metadata:local` **19개** 재통과. 독립 색/픽셀/음성/재생/회전 대조 범위는 각 문서를 따른다. 자기 자원 정리와 종료 코드 0 확인.
- tracked `git diff --check`와 변경/untracked 텍스트 196개 공백·merge-marker 검사 통과. `dist`는 index/favicon/src/build.json만 있고 서버/시험/문서/환경/worker protocol·합성 마커를 포함하지 않는다.

- `npm run test:decoder-linux:local`: **8개 재통과**. 최종 checkpoint/worker 코드에서 실제 PostgreSQL 원장·SIGKILL·자연 lease 만료(시계/SQL 조작 없음)·새 인스턴스 exact-ID 회수와 후속 정상 작업을 다시 확인했다. 새 임시 DB 및 자기 controller/PG/worker 태그 정리까지 종료 코드 0이다.

최종 PNG checkpoint 코드에서 최소 worker **49개**, 검사 결합 **12개**도 새 UUID로 다시 통과했다. 위 이미지 27개·영상 19개 역시 마지막 코드에서 재실행했다. 모든 실행은 terminal 종료/자기 자원 정리를 확인한 명령만 통과로 집계했다. 최종 Docker Engine 29.8.1 응답·**container 0개/volume 0개/base image 3개**를 확인했다. 시험 전용 객체/정의 volume/image tag만 정리했고 사용자 자료·운영 DB·기존 base/cache는 유지했다. Git commit/push, Vercel 배포, 유료 자원, 운영 파일/메일/API 활성화는 수행하지 않았다.

### 실패와 복구 기록

첫 파일별 실행의 GIF 회전 기대값 6은 잘못된 테스트 가정이었다. GIF 정책의 실제 기본값 1로 정정했고 허용 EXIF 지원 형식의 방향 보존은 유지했다. 초기 embedded EICAR 탐지 가정과 손상 원본의 실패 단계 가정도 위 실제 관찰대로 분리했다. 대조군 자체를 제거하거나 검사 정책을 완화하지 않았다.

PNG 필터 대조군이 실패해 검토한 서명 FFmpeg 소스에서 거부 분기 누락을 확인했다. 래스터 검사와 정상 색/depth/Adam7/APNG 계약을 추가한 뒤 실제 clean 원본 거부를 통과했다.

그다음 취소 시험에서는 이미 종료된 자기 worker가 정리 보류로 남았다. 종료 명령 직전 자연 종료할 수 있는 경합을 처리하도록 `decoder-jobs.mjs`를 보완했다. kill 응답이 실패해도 **같은 엔진·정확한 full ID·소유권·독립 terminal 상태**가 모두 확인된 경우만 정리를 계속하며, 살아 있거나 엔진/소유권/관찰이 불확실하면 계속 보류한다. 해당 경합과 3가지 거부 계약을 단위 시험했다. 초기 native 실패의 raw driver 오류를 수집/공개하지 않았으므로 그 실행의 모든 원인을 확정했다고 주장하지 않는다. 보류 자원은 exact ID/label/단일 image tag/참조·terminal/엔진을 독립 재검증한 뒤 자기 합성 자원만 회수했다. 회수 script의 첫 preflight는 controller image tag를 잘못 지정해 **삭제 전** 중단됐고, 실제 정확한 tag로 확인한 다음 정리했다. 새 UUID 실행에서 12개·정리를 통과했다.

기존 native 38개 재실행의 60-frame APNG/1초 deadline 대조군에서는 새 동기 래스터 검사 중 제한시간을 소모해 실제 ffprobe를 관찰하지 못했다. 이를 native 프로세스 종료 성공으로 집계하지 않았다. PNG 검사에는 래스터/chunk 전후 경과 시간 checkpoint를 추가했고, native deadline 대조는 디코딩 속도에 의존하지 않는 위 SIGSTOP 방식으로 변경했다. 실제 관찰·제한시간 이후 PID 부재·후속 정상 처리를 유지해 38개를 재통과했다. 운영 timeout·경고 거부·자원 설정을 늘리거나 partial decode를 수용하지 않았다.

## 변경 파일과 다음 순서

- 처리 계층: `media-preparation.mjs`, `media-preparation-policy.mjs`, `media-preparation-protocol.mjs`, `media-preparation-worker.mjs`.
- 기존 실행 계층: `decoder-jobs.mjs`, `decoder-job-worker.mjs`, `decoder-cli-transport.mjs`, `media-decoder.mjs`, `media-decoder-policy.mjs`, `media-container-validation.mjs`, `local-docker-test-runtime.mjs`. 종료 경합의 독립 terminal 증거와 공통 PNG 래스터 검사를 포함한다.
- 기존 metadata 모듈 3개: 공통 정책 상수 재사용, 변환 정책/지원 형식은 유지.
- 테스트/격리: `media-preparation-*-test.mjs`, `media-preparation-test-policy.mjs`, `tests/media-preparation*.mjs`, `tests/png-raster-validation.test.mjs`, 기존 `tests/decoder-jobs.test.mjs`, `decoder-native-test.mjs`, 합성 `image-metadata-test-fixtures.mjs`, `decoder-job-container-test.mjs`, 관련 Dockerfile/deny-all allowlist/정책 시험과 `linux-decoder-container-test.mjs`의 명시적 controller target.
- 문서 및 root/server package scripts: 명시적 재현 명령과 서버 시험 concurrency 2개. 새 의존성은 없음.

분리 저장·불변 증거·원자적 전환과 기존 권한 기반 후보 제공은 [013 후속](media-preparation-storage.md)에 연결했다. 남은 우선순위는 **durable queue·실제 프로세스 장애/재시작 복구 → 보존/파기·과거 파일 전환 → 국내 인프라·메일·백업/계정 운영 → 마지막 API/화면 연결·실제 다른 기기 검증**이다. 전체 개편 목표는 계속 진행 중이다.
