# 이미지 공유용 메타데이터 처리

2026-10-04. 소통 개편 P1 사진·영상 첨부의 후속이다. **이미지 변환 구성요소와 합성 검증을 구현했다. 운영 업로드 승인·공유·API 연결이나 전체 개편 완료는 아니다.** 기존 원본, 첨부 ID, 브라우저 저장, SQL 001~012, 인증·담당 관계와 공유 조회 정책은 변경하지 않았다.

## 현재 구현과 내부 계약

2026-10-05 최신 [검사 결합](media-preparation.md)은 원본 전체 디코딩이 성공한 뒤 이 변환을 실행하고 후보를 다시 정규화·동일성/전체 디코딩/안티멀웨어 확인한다. 공통 PNG 검사에 CRC 이후 실제 zlib 행 길이·필터 0~4·Adam7/각 APNG frame·압축 EOF와 자원 한도를 추가했다. 미사용 IDAT padding 및 별도 APNG poster는 지원 부분집합 밖이다. 색/회전·원본 불변·재압축 없음 정책을 완화하지 않았으며 이 단계에서도 원본/후보 영구 저장·업로드 승인·기기 품질/익명화 보장은 아니다. 최신 계약/native 회귀와 실패 이력은 위 문서를 참고한다.

`server/image-metadata.mjs`의 `prepareImageDerivative(Buffer, MIME)`는 원본을 덮어쓰지 않고 별도 공유 후보 바이트를 만든다. 재인코딩·리사이즈·프레임 생략을 하지 않는다. 원본/후보의 크기·SHA-256, 처리 정책 `carebridge-image-metadata-v2`, 방향, 구조상 프레임 수를 내부 호출자에게 반환한다. 지원 ICC를 처리했으면 `iccProfilePolicy:carebridge-icc-matrix-trc-v1`, 없으면 null이다. 이 필드는 후속 작업자가 보존 예외를 판단하기 위한 내부 표식이지 공개 승인 결과가 아니다. 파일명·사용자/아동 ID·경로·URL은 입력에 없고 원본 메타데이터 원문을 보고서에 넣지 않는다.

이 함수는 구조 변환이지 안티멀웨어/전체 디코더가 아니다. `inspect`/`verdict`/업로드 승인 정책 `carebridge-media-v1`이 없고 `mediaAcceptanceReady:false`다. 현재 `MediaUploads`에 연결하지 않으며 기본 검사기는 계속 미설정이다. 결과를 HTTP/사용자에게 반환하거나 새 객체로 자동 저장하지 않는다.

JPG·PNG·GIF·WebP의 Buffer만 받으며 최대 10MiB다. 기존 시그니처·컨테이너 크기/CRC/종결 검사를 통과한 뒤 처리하고 결과의 형식/구조상 프레임 수를 재확인한다. 구조와 제어 블록을 유한하게 순회한다. TIFF에서는 IFD0의 방향만 읽으며 GPS·MakerNote·썸네일 포인터를 따라가지 않는다. PNG 텍스트 메타데이터는 압축 해제하지 않는다. iCCP만 출력 1MiB 상한·정상 압축 종결·입력 전체 소비를 확인해 압축 해제한다.

메모리 내 변환이므로 **격리된 파일 작업자 안에서** 사용하도록 설계했다. 이번 native 실행은 오프라인 합성 시험 작업자다. 운영 per-file 작업자의 입출력 프로토콜·변환본 전송·원장·저장으로 연결한 것은 아니다. 동기 함수에 signal을 전달하는 것만으로 CPU 취소가 된다고 주장하지 않으며 운영 작업자의 시간/메모리 제한을 유지해야 한다.

| 형식 | 제거 또는 정규화 | 보존 |
| --- | --- | --- |
| JPEG | EXIF의 촬영/설명/GPS/썸네일, XMP·기타 APP·COM. 여러 SOS 사이도 검사 | 압축 스캔·stuffing/restart, JFIF 수치 헤더(썸네일 제외), Adobe 색 변환, 1~8 방향만 새 최소 EXIF로 재작성 |
| PNG/APNG | text/zTXt/iTXt·촬영 정보·private ancillary, EXIF의 방향 이외 내용 | IDAT/fdAT, 팔레트/투명도·지원 수치 색/감마/밀도, acTL/fcTL 재생·blend/disposal, 필요한 최소 방향 |
| GIF | 주석·임의 application/private extension | 프레임·색표·GCE·표준 loop 제어. 렌더링되는 Plain Text는 삭제하지 않고 처리 보류 |
| WebP | EXIF의 방향 이외 내용·XMP·unknown chunk, ANMF 내부 unknown/private chunk | VP8/VP8L/ALPH, 애니메이션·프레임 제어, 필요한 최소 방향. RIFF 길이와 EXIF/XMP 플래그 재작성 |

위 네 형식 모두 아래 지원 범위의 ICC 색 수치·필수 고지를 보존한 재작성 프로필을 포함할 수 있다.

손상/중복 EXIF 방향·잘못된 CRC/크기·알 수 없는 PNG critical chunk·잘못된 제어/패딩은 `SCAN_INVALID`다. **ICC 프로필은 색을 바꿔가며 삭제하지 않는다.** 아래 지원 범위는 색 수치를 보존해 재작성하며, 미지원 의미/색 모델은 `SCAN_UNAVAILABLE`을 반환한다. 손상된 ICC나 컨테이너의 불일치는 `SCAN_INVALID`다. Adobe APP14의 미지원 형태도 보류한다. 미지원은 파일이 무조건 악성이라는 뜻이 아니라 검증된 처리 경로가 없다는 뜻이다.

이 정책은 알려진 컨테이너의 구조화된 촬영/주석 정보를 줄인다. 사진 속 얼굴·문서·명찰, 픽셀에 숨긴 정보나 압축 비트스트림의 임의 데이터까지 제거하거나 익명화하지 않는다. 모든 EXIF 색 해석·컬러 관리·비표준 확장과 브라우저 렌더링의 동일성을 보장하는 것도 아니다. 미지원 ICC·임상 표시 품질과 다양한 실제 기기 자료의 검증은 남아 있다.

## ICC 색상 보존 후속

`server/icc-profile.mjs`는 최대 1MiB, 태그 최대 256개인 v2/v4 matrix/TRC RGB·그레이스케일의 input/display 프로필만 재구성한다. XYZ PCS, 필수 태그, 길이/정렬·중복·부분 중첩, reserved, 날짜/조명/intent·지원 flags/attributes, 곡선 종류/크기·문자 인코딩을 검사한다. 같은 태그 데이터의 정확한 alias는 허용하고, 결과는 ASCII 순서·연속 데이터·0 패딩·동일 곡선 공유로 구성한다. v4 Profile ID는 flags·intent·ID를 0으로 놓고 다시 계산한다. 이 MD5는 ICC 식별자이며 보안 해시는 계속 SHA-256이다.

- 색 수치: RGB matrix, white/black point, TRC(표·gamma·지원 parametric 함수), chad와 지원 chrm/lumi/meas/view/tech 수치를 바꾸지 않는다. 수치 태그의 숨은 임의 suffix는 수용하지 않는다.
- 설명/식별: 프로필 설명은 중립적 고정 문구로, 제조사/모델/관찰 조건의 설명 태그와 사용하지 않는 틈새 바이트는 제거한다. 선택적 platform/manufacturer/model/creator 식별 필드를 0으로 만든다. CMM 선택 정보·유효한 기술적 프로필 생성 시각·표준 색 의미의 header는 유지한다.
- **개인정보 예외:** copyright의 실제 고지는 번역·대체·소유권 주장 없이 유지한다. 고지 문자열 및 기술적 프로필 생성 날짜에는 식별 정보가 있을 수 있다. 따라서 ‘모든 메타데이터 제거’나 익명화라고 안내하면 안 된다. 원본의 프로필이 임의 재작성/재배포 가능한지 승인한 것은 아니며 실제 서비스 전에 사용 권한과 공유 안내/정책을 검토해야 한다.
- 미지원: LUT/CMYK/HDR, 미지원 class/PCS·vendor flags, 비단조 곡선·정의되지 않은 거듭제곱 영역/비유한 값/역행 분기, 알 수 없는 태그/타입은 색에 관여할 수 있으므로 삭제해서 통과시키지 않는다. PNG의 iCCP+cICP 조합도 해석 우선순위 검증 전에는 보류한다. 전체 ICC 지원이나 표준 인증이 아니다.
- 컨테이너: JPEG APP2의 1~255 순번/분할/완전성·용량, PNG iCCP 이름/압축/위치·색 채널/sRGB 충돌, GIF ICC application sub-block과 RGB, WebP ICCP 위치·RGB·VP8X 플래그/중복을 확인하고 길이/CRC/분할을 재작성한다. JPEG의 회색/RGB 채널과 프로필이 일치해야 한다. 이미지/재생 데이터는 재압축하지 않는다.

LittleCMS 2.19-r0의 독립 C 시험 도구가 실제 sRGB·P3·회색 gamma/표 곡선을 v2/v4로 생성한다. 기본 8개와 v4 파라미터 함수 1/2/4의 추가 3개, 총 11개 조합에서 네 rendering intent, 최적화 유무×black-point compensation 유무, 양방향 profile↔XYZ 변환을 비교한다. 기본 자료의 함수 0/3과 합쳐 지원하는 파라미터 함수 0~4 모두 실제 CMM 비교를 수행한다. RGB 729개 격자·회색 257개 입력(역방향 XYZ는 729개)에서 유한한 결과와 차이 ≤1e-12를 요구한다. 일부러 RGB matrix를 바꾼 음성 대조 시험은 거부되어 비교기가 실제 색 변화에 반응함도 확인한다.

실제 ICC를 넣은 PNG/JPEG/WebP/GIF/APNG/애니메이션 WebP 및 회색 PNG에서 프로필을 추출해 같은 CMM 비교를 수행하고, 원본/후보의 전체 디코딩·전체 코드화된 픽셀·재생을 비교한다. 촬영/주석 제거와 ICC가 함께 작동하며 JPEG 방향 6도 유지한다. 이는 **LittleCMS의 합성 벡터 및 코드화된 프레임 증거**다. 브라우저가 ICC/방향/애니메이션을 선택·적용하는 방식, 모든 CMM/실물 장치·실제 임상 촬영 자료·색 정확도 인증까지 입증한 것은 아니다.

시험 도구는 별도 build stage에 고정 버전의 공개 signed-repository 개발 패키지로 컴파일한다. runtime에는 lcms2만 넣으며 plugin을 로드하지 않는다. 해당 CMM/encoder·합성 파일·시험 소스는 운영 최소 디코더/웹 dist에 포함하지 않는다. PC 설치·운영 검사기 연결·파일 승인·API/화면은 변경하지 않는다.

## 원본과 공유본의 수명

원본은 임상 이력/재검사를 위해 비공개로 보존하고 공유 후보를 별도로 관리하는 방향이다. **이번에는 보존 기간을 확정하거나 실제 파일을 삭제하지 않았다.** 기존 `object_key`를 새 바이트로 덮어쓰거나 기존 불변 upload manifest를 변경하지 않는다.

운영 연결에서는 원본/변환본 객체·매니페스트·처리 정책·검사 결과를 별도 저장하고, 예약의 원본 추적과 공유 접근 대상인 검증된 변환본을 구분해야 한다. 두 객체의 바이트 쓰기/DB 확정 사이 장애, 취소/철회/미연결 정리, 원본 이력과 삭제 펜스도 함께 처리해야 한다. 해당 저장 마이그레이션은 아직 하지 않았다.

최종 승인에는 원본 안티멀웨어·전체 디코딩, 처리 성공, 변환본 안티멀웨어·전체 디코딩/동일성 검증, 내구성 있는 저장·권한 확인이 필요하다. 일부 성공만으로 ready/share 상태로 옮기지 않는다. MP4·WebM은 이 변환기에서 처리하지 않으며 영상 메타데이터·회전/시간·음성·비트스트림 정책도 필요하다.

## 실제 검증

```powershell
node --test server/tests/icc-profile.test.mjs server/tests/image-metadata.test.mjs server/tests/decoder-container-policy.test.mjs
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

- 이미지 계약 17개 + ICC 신규 계약 20개: 원본/법적 고지·수치 보존, header·태그 표·언어·UTF16·범위/충돌·곡선·멀티파트·zip bomb/후행 입력 거부, 각 이미지 형식 삽입/추출·불일치 및 보존 예외 표식. 기존 컨테이너 정책 6개를 포함한 집중 검증은 43개다.
- native 27개: 기존 8개(6개 이미지/애니메이션, JPEG 방향, 손상 ICC 거부), 실제 CMM 11개, ICC 포함 6개 이미지/애니메이션과 회색 PNG, 색 matrix 변조 대조 1개. 승인된 기존 FFmpeg 9.0.2 test artifact로 원본·변환본 모두 전체 디코딩했다. 크기/프레임 수와 실제 재생 시각/길이를 비교하고, 전체 프레임을 같은 RGBA→lossless PNG로 인코딩한 픽셀 해시의 동일성을 확인했다.
- 픽셀 비교는 `noautorotate`의 코드화된 픽셀 비교다. 방향 태그는 별도 계약으로 검사했으며 모든 브라우저의 회전·컬러 관리 렌더링 증거는 아니다. 삭제되어 달라지는 metadata envelope는 제외하고 실제 측정 필드만 비교한다.
- 시험 컨테이너는 기존 비관리자·read-only·network none·CPU/RAM/PID/tmpfs 제한·호스트 파일/포트/소켓 없음 정책이다. encoder는 기존 별도 합성 시험 이미지에만 있으며 운영 최소 디코더에 추가하지 않았다. 생성 응답/종료가 불명확하면 자기 UUID 자원을 보류한다.
- 기존 실제 디코더 38개 회귀, 전체 서버 363개(343+20), 로컬 61개, 문법·정적 빌드를 통과했다. 신규 파일의 whitespace와 dist의 서버/시험/개인 파일 비포함을 별도 확인한다.
- 가상 패턴·가상 GPS/설명만 사용했다. 실제 아동 자료·운영 파일/DB·외부 저장소는 사용하지 않았다. 시험 파일/컨테이너/자기 이미지 태그는 정리했다. 공개 artifact cache와 기존 base images는 유지한다.

초기 test build의 exact allowlist에 신규 3개 파일을 추가해야 하는 실패를 수정했다. native 비교에서는 ffprobe의 빈 side-data envelope가 전후에 다른 점과 정지 WebP에 GIF 전용 loop 옵션을 적용한 시험 코드 오류를 수정했다. 픽셀/타이밍 일치 조건은 유지했다. 실패 시험도 실제 terminal을 확인한 뒤 자기 자원만 정리했다.

ICC 후속 초기 시험은 입력을 읽지 않는 생성기의 빈 stdin pipe 경로에서 실패했다. 불필요한 pipe를 제거하고 고정 진단만 출력하도록 보완한 뒤 초기 24개를 연속 통과했으며 추가 파라미터 함수까지 최종 27개를 통과했다. 색 일치 허용치나 지원 수치 보존 조건을 완화하지 않았다. 초기 실패 UUID 자원도 terminal·소유권을 확인한 뒤 정리했다.

## 변경 파일

- `server/image-metadata.mjs`: 공유 후보의 무손실 구조 변환.
- `server/media-container-validation.mjs`: 기존 CRC를 공통 함수로 공개해 검증/새 chunk 작성의 중복 제거. 기존 판정 유지.
- `server/image-metadata-test-fixtures.mjs`, `server/tests/image-metadata.test.mjs`: 합성 fixture·17개 계약.
- `server/image-metadata-native-test.mjs`, `server/image-metadata-container-test.mjs`: 실제 픽셀/재생 비교와 소유 자원 검증/정리.
- `server/icc-profile.mjs`: 공통 bounded ICC 변환, 고지/색 수치 보존·보류 경계.
- `server/icc-profile-test-fixtures.mjs`, `server/tests/icc-profile.test.mjs`: 독립 합성 구조와 신규 계약 20개.
- `server/icc-color-test.c`, `server/icc-profile-native-test.mjs`: 실제 CMM 합성 생성/색 비교와 이미지 디코딩 결합. 운영 프로그램이 아니다.
- `server/decoder-test.Dockerfile`, `.dockerignore`, `server/tests/decoder-container-policy.test.mjs`: 기존 test encoder를 재사용하는 stage와 정확한 source allowlist.
- 루트/서버 `package.json`: 명시적 재현 스크립트. dependency/lock 변경 없음.
- 이 문서, README, 서버/업로드/검사 문서: 구현·실제 증거와 미완료 경계 구분.

## 다음 우선순위

2026-10-05 영상 구성요소는 [별도 MP4/WebM 후속](video-metadata-processing.md)으로 추가했다. 신규 구조 계약 24개·실제 모든 stream/회전/타이밍/대조 19개를 검증하고 기존 이미지/ICC 27개·디코더 38개를 다시 확인했다. 아래 순서는 이미지 단계 당시의 목록이며 최신은 검사 결합·객체/manifest 수명·queue·국내 운영·API 마지막 연결이다. 전체 영상/실물 기기 지원·익명화나 파일 승인은 아니다.

1. MP4/WebM 메타데이터·회전/타이밍 보존 구현과 실제 검증. 미지원 ICC/장치별 임상 표시 품질·고지/프로필 생성 날짜의 공유 예외도 계속 검토한다.
2. per-file 격리 안에서 원본/변환본 검사 결합, 원본/변환본 객체 수명과 durable 업로드 작업 처리·복구.
3. 국내 운영 서비스 계정·저장/암호화·메일·백업/복구·보존/파기·동시 작업·전체 장애 검증.
4. **마지막에** API/화면 연결과 실제 계정의 기기 간 전달/재접속. 실제 장치 사용성·기존 대비 이동/시간·보호자 이해도도 남아 있다.

구조 기준은 [W3C PNG 3](https://www.w3.org/TR/png-3/), [JPEG T.81](https://www.w3.org/Graphics/JPEG/itu-t81.pdf), [GIF89a](https://www.w3.org/Graphics/GIF/spec-gif89a.txt), [Google WebP container](https://developers.google.com/speed/webp/docs/riff_container)를 확인했다. 명세를 근거로 구현/검사 범위를 정한 것이며 완전한 표준 적합성 인증은 아니다.

ICC 구현 기준은 [ICC.1:2022](https://archive.color.org/specification/ICC.1-2022-05.pdf)의 header/태그/필수·curve 규칙, [v2 형식](https://archive.color.org/files/ICC34.pdf), [ICC GIF embedding](https://www.color.org/ICC_Minor_Revision_for_Web.pdf)을 확인했다. 독립 C 시험은 [LittleCMS 2.19 public API](https://github.com/mm2/Little-CMS/blob/lcms2.19/include/lcms2.h)와 [Alpine 고정 패키지](https://pkgs.alpinelinux.org/package/v3.23/main/x86_64/lcms2)를 사용한다. 외부 malformed/상용 프로필을 내려받아 시험 fixture로 배포하지 않았다.
