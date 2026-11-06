# 영상 공유용 메타데이터 처리

2026-10-05. 소통 개편 P1 사진·영상 첨부의 후속이다. **MP4·WebM 후보 생성과 합성 검증을 추가했다. 운영 파일 승인·저장·API 연결이나 전체 개편 완료는 아니다.** 원본·첨부 ID·SQL 001~012·인증·담당 관계·브라우저 저장·배포는 유지한다.

## 현재 계약

2026-10-05 후속 [원본/후보 결합](media-preparation.md)에 이 변환을 같은 고정 오프라인 worker의 준비 경로로 추가했다. 원본 전체 디코딩 → 변환·재실행 canonical 동일성 → 후보 전체 디코딩과 각 프레임 timeline·manifest/반환 바이트를 확인한다. 최소 artifact의 영상/음성 전체 허용 조합도 실제 준비/별도 반환 재디코딩을 했다. 실제 ClamAV 결합 native 12개는 이미지 사례이며 모든 실제 영상의 두 검사·실물 기기 표시를 검증했다는 뜻은 아니다. 영구 원본/후보 객체·queue·업로드 승인/운영 배포/API/화면은 아직 아니며 아래 영상 정책을 유지한다.

`server/video-metadata.mjs`의 `prepareVideoDerivative(Buffer, MIME)`는 최대 50MiB의 MP4·WebM을 받아 별도 Buffer를 반환한다. 원본을 수정하지 않고 영상/음성을 재인코딩·리사이즈하거나 프레임을 생략하지 않는다. 제거 대상은 **동일 길이의 0으로 채운 free/Void**로 대체해 미디어·인덱스 위치를 유지한다. 파일 크기 축소 기능이 아니다.

내부 결과는 원본/후보 크기·SHA-256, `carebridge-video-metadata-v1`, 구조상 미디어 단위 수, 압축 payload/지원 수치 표시 정보의 해시다. 단위는 MP4의 mdat 또는 WebM의 Block/SimpleBlock 수이며 **프레임 수나 재생 시간으로 사용하면 안 된다.** 파일명·사용자/아동 ID·경로·URL·메타데이터 원문은 입력/결과에 없다.

`mediaAcceptanceReady:false`이며 `inspect`/`verdict`/`carebridge-media-v1` 승인을 제공하지 않는다. `MediaUploads` 기본 검사기는 계속 미설정이다. 이 동기 변환은 운영 시 별도 파일 작업자 안에서 CPU·RAM·전체 시간을 제한해야 하며 signal만으로 CPU 취소가 된다고 주장하지 않는다.

| 형식 | 제거·정규화 | 유지 |
| --- | --- | --- |
| MP4 | moov/trak의 udta·meta, 알려진 XMP UUID, free/skip 내용, 생성·수정 시각, handler/압축기 설명, producer reference time | mdat·코덱 설정, 시간 척도·duration·edit list·샘플/청크 표·오프셋, movie/track matrix·크기·aspect/aperture·지원 수치 색/HDR, 분할 저장·sidx/mfra |
| WebM | 제목·UTC 생성일·선택적 Segment 식별/파일명·트랙 이름/CodecName·Tags·Attachments·Void 내용. MuxingApp/WritingApp은 고정 처리기 문구로 정규화 | Block/SimpleBlock·lacing·CodecPrivate, TimestampScale·duration·block/reference/discard 시간·CodecDelay·SeekPreRoll, Tracks·Cues, 크기/crop/aspect/colour·HDR 수치·Projection pose |

WebM 보조 SeekHead는 삭제 대상에 대한 오래된 참조를 남기지 않도록 제거한다. Cues와 미디어 위치는 유지한다. 기술적 트랙 번호/UID·코덱 ID·언어는 보존한다. 알 수 없는 트랙·암호화·확장/chapter 구조를 삭제해서 통과시키지는 않는다.

MP4는 부모-자식 문법·일반/64bit 길이·v0/v1 시간 header·counted table·flags·self-contained reference를 확인한다. 외부 참조·암호화/미지원 sample entry·알 수 없는 UUID/기술 box·영상 ICC colr는 보류하며 숫자 nclx/nclc는 유지한다. 누락되거나 서로 충돌하는 sample-size/chunk-offset 표도 거부한다.

WebM은 EBML ID/길이·범위·중복·필수 트랙/코덱 종류·유한 수치/pose 범위·boolean을 확인한다. 미정 길이는 Segment/Cluster만 허용하고 미정 Cluster는 다음 상위 요소에서 끝낸다. **유지하는 master의 CRC**는 원본부터 검증하고 안쪽부터 다시 계산한다. CRC는 첫 요소·4byte·little-endian이어야 한다. 전체 삭제하는 Tags/Attachments 내부를 파싱·검사한 것으로 주장하지 않는다. 원본 전체 검사도 별도로 필요하다.

손상된 지원 구조는 `SCAN_INVALID`, 안전한 해석 경로가 없는 구조는 `SCAN_UNAVAILABLE`이다. 미지원은 악성 판정이 아니라 검증 경로의 부재다. 전체 MP4/Matroska 표준 적합성 인증은 아니다.

## 개인정보·동일성의 한계

컨테이너의 설명/촬영 정보를 줄이는 처리이며 **익명화나 모든 메타데이터 제거가 아니다.** 얼굴·목소리·배경·문서·픽셀에 숨긴 정보, 압축 비트스트림의 SEI/user-data, 코덱 설정/CodecPrivate의 문자열/식별자는 남을 수 있다. 재생용 트랙/수치 정보도 개인정보와 무관하다고 단정하지 않는다.

원본은 비공개 이력을 보존하는 방향이며 이번에는 저장 객체를 덮어쓰거나 삭제하지 않았다. 원본에 포함된 권리/저작권/라이선스 고지의 이용·공유 권한도 확정하지 않았다. 이미지 ICC의 고지/기술 생성일 보존 예외는 [이미지 문서](image-metadata-processing.md)에 따로 유지한다.

운영 승인에는 원본 안티멀웨어·전체 디코딩 → 변환 → 후보 안티멀웨어·전체 디코딩/동일성 → 별도 원본/변환본 manifest·내구성 저장·현재 권한 확인이 모두 필요하다. 변환만 성공했다고 ready/share로 옮기거나 원본 검사 경고를 숨기면 안 된다.

## 실제 검증과 재현

```powershell
node --test server/tests/video-metadata.test.mjs server/tests/decoder-container-policy.test.mjs
npm run test:video-metadata:local
npm run test:image-metadata:local
npm run test:decoder:local
cd server
node --test --test-concurrency=2 tests/*.test.mjs
cd ..
npm test
npm run check
npm run build
git diff --check
```

- 신규 구조 계약 24개·기존 컨테이너 정책 6개: 원본/manifest·멱등성·오프셋·v0/v1/64bit·분할 구조·색/방향·표/참조/flags·CRC·미정 길이·lacing·손상/미지원 거부·50MiB 경계. 이 구조 fixture를 실제 디코딩/최악 압축 복잡도 증거로 사용하지 않는다.
- 실제 native 19개: MP4 H.264/HEVC/AV1/MPEG-4, WebM VP8/VP9/AV1, 영상+AAC/MP3/ALAC/Opus/Vorbis, MP4 faststart/fragmented/90도 matrix, WebM 미정 Segment/90도 Projection roll, 타이밍 변조 대조, raw-title 원본 경고 거부.
- 승인된 기존 FFmpeg 9.0.2 시험 artifact로 원본/후보의 모든 영상/음성 프레임을 디코딩했다. 전체 RGBA→lossless PNG 픽셀, 프레임 시각/길이·audio sample 수·stream 코덱/채널/표시/색·rotation을 비교했다. 음성은 PCM s16으로 디코딩한 모든 패킷의 데이터 해시/시각/길이도 비교했다. manifest 해시는 서로 달라질 수 있으므로 각각 자기 바이트와 비교한다.
- 음성 fixture는 합성 무음이다. 실제 목소리·다채널·변동 시간/모든 코덱 옵션을 검증한 것은 아니다. 압축 payload 동일성도 별도로 확인한다. 브라우저/실물 장치의 자동 회전·색/HDR·랜덤 seek·임상 표시 품질은 남아 있다.
- 픽셀은 `noautorotate`의 코드화된 프레임이다. MP4/WebM 90도 표시는 ffprobe에서 독립 확인했지만 모든 자동 회전 화면/변환 조합의 동일성 인증은 아니다.
- 기존 실제 이미지/ICC 27개·디코더 38개를 재실행했다. 전체 서버 387개(기존 363+24), 로컬 61개·check/build/diff 검증을 통과했다. 새 파일 whitespace·공개 dist의 서버/시험 소스 비포함도 별도 확인한다.
- 시험은 비관리자·read-only·network none·CPU/RAM/PID/tmpfs 제한, 호스트 파일/포트/소켓 없음이다. 운영 최소 decoder artifact/프로토콜에 변환기나 encoder를 추가하지 않았다. PC 설치·운영 계정/유료 자원·배포도 하지 않았다.
- 새 UUID의 terminal·소유권을 확인한 뒤 자기 시험 파일/컨테이너/이미지 태그만 정리했다. 공개 build cache·기존 base images는 유지한다. 실제 아동/운영 파일·DB는 사용하지 않았다.

초기 native 실패는 FFmpeg가 MP4 트랙 title을 raw UDTA로 내보내 기존 디코더의 경고 거부에 걸린 경우였다. 정상 자료에는 global title/handler name을 쓰고 raw-title 원본은 거부 대조로 남겼다. **경고 거부 정책은 완화하지 않았다.** WebM `MaxBlockAdditionID`는 명세 확인 후 유지했다. 타이밍을 늘린 대조는 movie duration 밖 프레임이 잘려, 프레임 수를 유지하는 짧아진 시각 대조로 바꿨다. 정상 자료의 전체 프레임/음성/타이밍 일치 조건은 유지했고 실패 run도 terminal·자기 자원 정리를 확인했다.

## 변경 파일과 다음 순서

- `server/video-metadata.mjs`: byte-only 계약·크기/manifest.
- `server/mp4-metadata.mjs`, `server/webm-metadata.mjs`: 형식별 bounded 변환.
- `server/video-metadata-test-fixtures.mjs`, `server/tests/video-metadata.test.mjs`: 별도 합성 구조·24개 계약.
- `server/video-metadata-native-test.mjs`, `server/video-metadata-container-test.mjs`: all-stream 비교·격리/소유권/정리.
- `server/decoder-test.Dockerfile`·전용 dockerignore·정책 시험·두 `package.json`: 명시적 test-only stage·정확한 allowlist·재현 명령. 새 npm 의존성/lock 변경 없음.
- 이 문서와 README·서버/검사/업로드/이미지 문서: 증거와 미완료 경계 구분.

다음은 ① per-file 격리에서 원본/후보 안티멀웨어·전체 디코딩/동일성 결합 ② 별도 객체/manifest 수명·durable queue·취소/철회/장애 복구 ③ 국내 운영 권한·암호화/보존·메일·백업 복원·실제 파일/자원 조건 검증 ④ **마지막으로** API/화면·기기 간 전달/재접속이다. 실제 사용성 이동 수/시간·보호자 이해도와 전체 국내 통제도 미입증이므로 전체 목표는 진행 중이다.

구조 기준은 [EBML RFC 8794](https://www.rfc-editor.org/rfc/rfc8794.html), [Matroska 요소](https://www.matroska.org/technical/elements.html), [WebM guidelines](https://www.webmproject.org/docs/container/)와 [FFmpeg 9.0.2 MOV parser](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavformat/mov.c), [MOV writer](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavformat/movenc.c)를 확인했다. 완전한 표준 인증/기기 호환성으로 확대 해석하지 않는다.
