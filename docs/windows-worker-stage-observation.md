# 가상 E 검사 작업자 단계 관측

후속으로 [DB 준비·종료 관측](windows-database-startup-observation.md)을 세분화했다. 아래 수치는 이 문서를 처음 작성한 단계의 결과이며, 이후 실제 readiness 대기와 ND1·API 종료 진단 및 최신 재검증은 후속 문서를 따른다.

작성일: 2026-10-09. 실제 자료·외부 접속·운영 활성화 없이, 가상 계정/자료의 로컬 API 연결을 검증하는 후속 작업이다.

## 현재 문제와 변경

이전 실행 `eaa479a9-bc7b-44f6-b319-dc7944a7e87c`의 작업자는 `0xC0000409`로 종료했다. 기존 phase 4는 DB 연결부터 전체 검사 작업까지 포함하므로 마지막으로 관측한 내부 호출을 구분할 수 없었다. 같은 소스의 후속 55/55 성공은 이 실패 원인의 해결을 의미하지 않는다. 이전 상세 증거는 [준비 첨부 화면 보고서](local-prepared-media-ui.md)에 보존한다.

이번에는 검사 정책을 바꾸지 않고 선택적 process-local 관측을 추가했다. callback은 서버의 신뢰된 구성에서만 주입하며 HTTP·SQL·IPC 입력으로 받지 않는다. 기본값은 관측 없음이다. 이벤트는 고정된 단계명과 `begin` / `complete` / `failed`뿐이고 파일명·내용·ID·경로·해시·계정·오류 원문을 포함하지 않는다.

| 영역 | 변경 파일 | 역할 |
| --- | --- | --- |
| 공통 관측 | `server/media-worker-observation.mjs` | frozen 15단계 계약, callback 예외/거절로 실제 작업 결과를 변경하지 않음 |
| 실제 호출 경계 | `media-preparation.mjs`, `media-uploads.mjs`, `media-work-queue-worker.mjs`, `media-worker-service.mjs`, `windows-media-worker-process.mjs` | DB 시작·admission·복구·정리·claim·원본 검사·변환·후보 검사/쓰기/확인·settlement·DB 종료를 실제 await 기준으로 관측 |
| 가상 native 관측 | `windows-native-worker-test-policy.mjs`, `windows-native-worker-test-child.mjs`, `windows-native-worker-check.mjs` | 고정 version 1 frame, 조각 출력 처리, 제한된 이력과 native 관측 범위 검증 |
| 실행 환경 | `windows-postgres-check.mjs` | Node/V8/libuv/OS 종류/아키텍처를 결과에 남김; 실행 경로나 자격증명은 추가하지 않음 |
| 회귀 | 관련 `server/tests` 7개 | callback 오류, 결과/예외 보존, 실제 저장·close 대기, 파서·출력 한도 검증 |

DB 역할·스키마·인증/권한·검사 승인·재시도·timeout·실제 종료 기준은 변경하지 않았다. 전역 Node·JIT·Windows 보안/WER 설정, 사용자 4173 앱과 배포도 변경하지 않았다.

## 진단 의미와 제한

- `complete`는 해당 호출의 정상 반환이다. 악성 파일의 검사도 rejected 결과로 정상 반환할 수 있고, 정리 호출이 일부 실패를 결과로 반환할 수 있다. 따라서 승인·모든 파일 삭제의 증거가 아니다.
- `settlement failed`는 커밋 뒤 응답 유실일 수도 있다. rollback을 뜻하지 않는다. 해당 경우도 저장 회귀 시험으로 구분한다.
- 실제 종료는 여전히 exit/close/파이프 종료·DB/컨테이너 정리를 별도로 확인한다. `control-ready`나 단계 이벤트를 준비 완료·정상 종료로 대체하지 않는다.
- version 1 frame은 단계 순번과 상태만 기록한다. polling(복구/정리/claim)은 128개, 파일 처리는 1,024개, DB 시작/admission/종료는 16개까지 기록하고 각 그룹의 생략 시작을 고정 marker로 알린다. polling이 파일 처리·종료의 한도를 소진하지 않는다.
- 전체 stderr 16KiB 제한은 그대로다. 파서는 줄 prefix 최대 256바이트, 최근 이벤트 32개, 고정 15단계별 횟수만 보관한다. 완성된 줄을 한 번만 처리하므로 분할 chunk에서 중복 집계하지 않는다. 원문 stderr는 결과에 저장하지 않는다.
- `lastStage`는 마지막으로 **관측된** 단계이며 실제 충돌 위치의 확정 증거가 아니다. 그룹 한도 도달·프로세스 급종료·출력 유실 시 이벤트가 없을 수 있다. callback은 신뢰된 내부 코드이므로 임의 비신뢰 코드 실행을 격리하는 장치는 아니다.

## 조사 근거

Microsoft는 [0xC0000409를 fast-fail 예외로 설명](https://learn.microsoft.com/en-us/cpp/intrinsics/fastfail?view=msvc-170)하며 세부 원인은 첫 예외 파라미터로 구분한다. 현재 그 파라미터·충돌 stack을 확보하지 못했으므로 버퍼 손상·JIT·메모리 부족으로 단정하지 않는다.

[Node #61999](https://github.com/nodejs/node/pull/61999)는 Windows 종료 중 지연 작업 재등록에 따른 libuv assertion을 수정하며, [Node 24.20.0](https://nodejs.org/en/blog/release/v24.20.0)에 포함됐다. 이는 확인된 별도 upstream 수정이지 이번 충돌과 동일하다는 증거가 아니다. 현재 Node 24.15.0을 그대로 사용하고 이번 단계에서는 런타임 교체와 JIT 우회 실험을 하지 않는다.

## 검증 결과

| 실제 실행 | 결과 | 증거 |
| --- | --- | --- |
| 집중 회귀 | 136/136 통과 | 제품 관측 126개 + native 관측/구성 10개; 전체 회귀와 중복 합산하지 않음 |
| 서버 전체 직렬 회귀 | **1,087/1,087 통과**, 실패/취소/skip 0, exit 0 | `test-results/worker-observation-server-20261009.xml`, 같은 이름 `.tap` |
| 로컬 전체 직렬 회귀 | **446/446 통과**, 실패/취소/skip 0, exit 0 | `test-results/worker-observation-local-20261009.xml`, 같은 이름 `.tap` |
| 구문 검사·빌드 | 통과, exit 0 | `npm run check`, `npm run build`; 최종 파서 변경은 집중 10개 재검증 |
| 실제 native E·API·브라우저 | **55/55 통과**, 실제 Node exit 0 | `test-results/windows-native-worker-2347198c-f21f-416d-9b40-fc4c02d5cf0a-results.json` |

실행 UUID는 `2347198c-f21f-416d-9b40-fc4c02d5cf0a`, 전체 출력은 `test-results/worker-observation-native-20261009.log`다. Node 24.15.0 / V8 13.6.233.17-node.48 / libuv 1.51.0 / win32 x64를 그대로 사용했다. native 실행은 다른 회귀 시험과 병행하지 않았다. 약 6분 후 정상 종료했고 이번에는 간헐 fast-fail이 재현되지 않았다. **관측 추가가 충돌 원인을 해결했다거나 운영 안정성을 확보했다고 주장하지 않는다.**

실제 작업자 4개에서 DB 시작·admission·DB 종료 완료가 관측됐고, 전체 실제 호출 경로에서 원본 검사·변환·후보 검사/쓰기/검증·settlement를 확인했다. native 관측 범위 3조건이 모두 true였다. 이벤트 수는 순서대로 102 / 24 / 24 / 170개이며 모두 마지막 관측은 `db-close complete`였다. 브라우저용 작업자의 polling 한도만 도달했고 파일 처리·종료 한도와 stderr 16KiB는 소진되지 않았다. 실제 종료는 별도 증거로 정상 3개 exit 0, 의도한 IPC 상실 1개 exit 1·모두 terminal/close/파이프 종료를 확인했다.

독립 브라우저 시험 UUID는 `1a25fd9a-80bb-4ba9-838e-a15dc4337558`, Chromium 149.0.7827.55다. 사진은 390px 발신, 영상은 1440px 발신, 수신은 각각 1440px·320px에서 확인했다. 새로고침 후 수신·실제 사진 decode·영상 재생·PNG 저장 응답 유실 후 동일 요청 재시도·키보드 포커스 복원이 통과했다. 모든 종류/발신·수신 폭의 완전 조합이나 실물 기기 검증은 아니다. 오류/예상 밖 요청은 0개였다. 이번 320px 사진 뷰어와 1440px 영상 뷰어 PNG를 직접 확인했으며 가로 넘침은 보이지 않았다. 분홍 영역은 시험 계정 마스킹이다.

API child exit 0/close/파이프 종료, 브라우저 context/process 종료, 원본·복원 PostgreSQL 정지, DPAPI/TLS/검사 fixture 정리도 확인했다. 해당 실행의 ClamAV·decoder·encoder 고유 label 3개를 읽기 전용으로 재조회해 잔존 컨테이너 0개를 확인했다. 시험용 컨테이너·성공 가상 키는 실행기의 정상 정리 대상이며, E 합성 DB/미디어 진단 자료는 보존한다. Docker Desktop 자체나 사용자 앱을 종료하지 않았다.

브라우저 검증 시작/종료/현재의 소스 233개 해시가 일치한다. 집합 SHA-256은 `2a4a57b913828ce89493a4505482d008929ef4ea248a2f862cec7bea764a86de`, 현재 불일치 0개다. 결과 폴더는 `test-results/native-prepared-2347198c-f21f-416d-9b40-fc4c02d5cf0a`다.

최종 제품/실행 코드 10개의 `node --check`, 변경 범위 21파일의 UTF-8·충돌 표식·모든 줄 후행 공백 검사와 `git diff --check`를 통과했다. 공개 빌드에 `local-api`/`server` 디렉터리는 없다. 커밋·push·배포·전역 런타임 교체는 하지 않았다.

재현 명령은 프로젝트 루트에서 다음과 같다. native 명령에는 확인된 로컬 Playwright/Chromium 경로를 환경 변수 `PLAYWRIGHT_MODULE`, `STUDY_CHROMIUM_EXECUTABLE`로 지정한다.

```powershell
node --test --test-concurrency=1 tests/*.test.mjs
# server 폴더에서:
node --test --test-concurrency=1 tests/*.test.mjs
# 프로젝트 루트에서:
npm run check
npm run build
npm run test:native-worker:e-drive -- --base E:/CarebridgeBeta --powershell '<검증된 pwsh.exe 절대경로>' --confirm-synthetic-e-drive
```

## 원 개편안과 남은 작업

이 관측 보완은 P1의 안정성 확인 일부이지 개편안 전체 완료가 아니다. 현재 실제 E 검사·브라우저 경로는 자동 검증 실행기이며 장시간 직접 사용하는 서비스가 아니다.

1. 가상 E 전용 대화형 실행기를 분리해 실제 준비 완료·가상 계정 안내·정상 종료를 제공한다. 종료된 검증 UUID의 DB/TLS/자격증명을 운영 세션으로 재사용하지 않는다.
2. 기록·가정 피드백의 첨부 추가/교체·선택 공유 및 남은 계정·관계 API 흐름을 연결한다.
3. 실물 기기·실사용자 P0 비교와 P1 기기 간 접속을 검증한다. 같은 PC의 독립 브라우저를 독립 물리 기기로 표현하지 않는다.
4. 실제 아동 자료·외부 접속은 독립 백업·운영 계정 분리·복구·보안 준비 전까지 계속 보류한다.

백엔드·전체 흐름 검증 지침에 따라 기존 구성과 안전 경계를 유지하고, 대역 시험·native 실제 결과·미확인 원인을 구분한다.
