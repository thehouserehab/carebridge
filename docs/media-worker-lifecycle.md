# 파일 검사 작업자 종료·상태·복구 경계

최신 [Windows 작업자의 DB 소유·준비 중 종료·복구](windows-media-worker-lifetime.md)는 공통 process 수명을 준비 전부터 pool close 후까지 유지하고 명시적 AbortSignal 접점을 추가한다. 합성 E32·서버638·로컬87 통과. 실제 Windows 서비스 제어/IPC·native 검사 결합·전원 장애·독립 백업·마지막 API는 미완료이며 아래 Linux 신호/native 시험은 당시 범위다. Windows process.kill 신호를 cooperative drain 증거로 간주하지 않는다.

2026-10-07 후속 [DB 연결 가드·명시적 작업자 조립](database-service-admission.md)을 추가했다. 실제 worker 신원/권한을 같은 트랜잭션에서 검사하고 원장/준비/업로드 서비스를 직접 조립하되 시작하지 않는다. 아래 518개/35개/native 18개는 당시 lifecycle 기록이고 최신 서버 회귀는 599개, Windows/E 합성 경계·복원은 25개다. 새 시험의 scanner/decoder는 대역이므로 종전 실제 native 엔진 시험과 구분한다.

2026-10-06. 개편안 P1의 사진·영상 전달 준비 후속이다. 작업 중 종료 신호와 저장 오류가 겹쳐도 실패를 정상 종료로 숨기지 않도록 보완했다. **운영 프로세스 감독 서비스 설치, 자동 시작/재시작, HTTP/API·화면 연결, 공개 배포는 하지 않았다.** 전체 개편안은 계속 진행 중이다.

## 문제와 변경

기존 `MediaWorkQueueWorker.start`는 오류가 발생했을 때 중단 신호가 이미 설정되어 있으면 정상 중단을 반환했다. 이 경로는 DB 정산 실패나 격리 작업 회수 실패까지 숨길 수 있었다. 또한 디코더 회수를 선점 전에만 수행해 검사 결과가 quarantine으로 정산됐다는 사실과 격리 작업이 정리됐다는 사실을 구분하지 못했다.

현재 경로는 다음과 같다.

```text
명시적 시작 → 잔존 디코더 회수 → 업로드 유지보수 → 한 건 선점·검사·DB 정산
                                                        ↓
                                 검사 후 잔존 디코더 회수·확인 → 다음 poll
                                                        ↓
                         종료 요청: 작업/정산/회수 완료를 기다린 뒤 stopped
                         실제 오류: 중단 요청과 겹쳐도 failed / 실패 종료
```

- 정상 중단은 outstanding 작업이 없는 명시적 checkpoint 또는 polling 대기의 실제 `ABORT_ERR`에서만 인정한다. 복구·DB 오류에 대한 포괄적인 abort 예외 처리를 제거했다.
- 검사/정산 오류가 있어도 검사 후 `recoverRetained`를 먼저 기다린다. 회수가 불확실하면 성공 또는 정상 중단으로 반환하지 않는다. 영속 디코더 원장과 업로드/큐의 원래 임대·generation이 재시작 복구의 근거다.
- `start` 중 유휴 간격에도 외부 `runOne`의 끼어들기를 거부한다. 다른 프로세스의 선점 경쟁은 기존 DB 잠금/임대와 원장 한도를 따른다.
- 정상 결과와 누적 업로드 시도, 원본/후보, 현재 소유자 권한, 보관 기한, 016 재개 영수증을 바꾸지 않는다. 001~016 SQL도 변경하지 않았다.

## 조회 가능한 상태

`worker.status`는 읽기 전용의 새로운 frozen 객체를 반환한다. 예전 snapshot은 다음 상태 변경으로 바뀌지 않는다.

| 필드 | 해석 |
| --- | --- |
| state | `new`, `running`, `stopping`, `stopped`, `failed` |
| phase | `recovering`, `cleanup`, `inspection`, `verification`, `idle` 또는 null |
| loopRunning / inFlight | 해당 인스턴스의 loop/await 작업 여부. 중단 요청 직후에도 작업이 남으면 true다. |
| completedPolls / processed | 이 인스턴스에서 정산 후 회수까지 완료한 poll/처리 수. DB의 전체 완료 건수나 모든 시도 수가 아니다. |
| lastOutcome | 마지막 확인된 `ready`, `rejected`, `quarantined` 또는 null. 파일 승인이나 사용자 전달 완료를 뜻하지 않는다. |
| cleanupFailures | 가장 최근 업로드 유지보수의 물리 정리 실패 수. 0이 아니면 기존 ledger/용량 부담이 유지된다. stopped가 모든 대기 파일 삭제를 뜻하지 않는다. |
| startedAt / lastPollCompletedAt / stoppedAt | 해당 프로세스의 UTC 관찰 시각. DB 시각이나 여러 호스트 간 순서 증거가 아니다. |
| failureCode | 실패 시 고정 `MEDIA_WORKER_UNAVAILABLE`, 그 외 null. 원문 예외는 노출하지 않는다. |

파일명·바이트·해시·저장 키·업로드/아동/사용자/대화 ID·임상 내용·DB 주소/자격증명은 포함하지 않는다. 이 객체는 **메모리 관찰값**이며 영속 heartbeat, 멈춘/종료된 다른 프로세스의 현재 상태, fleet 건강 상태 또는 운영 경보가 아니다. HTTP 상태 endpoint도 추가하지 않았다.

실패하면 현재 loop가 종료된다. 같은 인스턴스의 기존 명시적 재시도 계약은 유지하지만 자동으로 다시 시작하지 않으며 재시도도 선점 전 원장 회수를 다시 수행한다. 운영 복구에서는 원인을 확인한 뒤 별도 구성한 새 인스턴스를 명시적으로 실행한다.

## 명시적인 프로세스 종료 연결

`server/media-worker-process.mjs`의 `runMediaWorkerProcess(worker)`는 전용 신뢰 프로세스에서 **호출했을 때만** SIGTERM/SIGINT handler를 등록한다. import/생성만으로 실행하지 않는다. 기존 handler나 동일 프로세스의 다른 runner가 있으면 덮어쓰지 않고 거부한다. 등록한 자기 handler는 완료/오류/부분 등록 실패 때 제거한다.

종료 요청은 AbortController에 전달하고 기존 작업자가 drain할 때까지 기다린다. `process.exit`, 종료 타이머와의 조기 경합, 강제 kill, 자동 재시작을 넣지 않는다. 실행/등록 실패는 고정 오류로 거부하며 기존 nonzero exitCode를 보존하고, unset/0이면 1로 설정한다. 성공이 이전 프로세스 오류 코드를 0으로 지우지 않는다. DB pool·파일 저장소의 소유와 종료 책임은 호출자에게 있다.

```js
// 내부 운영 조합 예시. 실제 구성/승인 없이 실행할 CLI가 아니다.
const worker = new MediaWorkQueueWorker(configuredUploads);
try {
  await runMediaWorkerProcess(worker);
} finally {
  await ownedDatabase.close();
}
```

기본 생성자는 실제 일치하는 `DecoderJobJournal`을 계속 요구한다. 별도 프로세스마다 준비 서비스를 따로 구성하며 같은 승인 엔진/이미지와 영속 원장 한도를 사용한다. `localTestMode:true`와 synthetic gate는 시험 전용이고 운영/브라우저 입력에 사용하면 안 된다.

SIGKILL·PC 종료는 이 helper로 가로챌 수 없다. durable lease 만료·기존 후보 fence·새 인스턴스 회수 경로를 사용하며, 시간 초과를 정리 성공으로 간주하거나 원본을 삭제/자동 승인하지 않는다. 외부 감독자의 강제 종료 정책·backoff·경보·최대 drain 시간은 운영 자원/장애 기준을 확정한 뒤 별도 구성해야 한다.

## 실제 검증

```powershell
node --test --test-concurrency=2 server/tests/media-worker-lifecycle.test.mjs server/tests/media-work-queue.test.mjs
npm run test:server
npm run test:postgres:local
npm run test:media-preparation:local
npm test
npm run check
npm run build
git diff --check
```

- 신규 lifecycle 17개 + 기존 queue 17개 = **34개 통과**. 합성 preparation/PGlite/실제 임시 비공개 디스크를 사용한다. 불변/최소 상태, 시작하지 않는 생성자, 명시적 재시도, abort와 recovery/maintenance/정산 오류 경합, 검사 후 회수 실패, drain 대기, 원본 보존, 물리 삭제 실패 집계, signal/중복/기존 handler/부분 등록/exitCode 보호를 확인했다.
- 전체 서버 **518개 통과**, 실패·취소·건너뜀 0. 최종 전체 실행은 제품 코드 변경 후 재실행했다.
- 실제 **PostgreSQL 18.6 / Node 24.15.0의 35개 통과**. 기존 32개와 새 자식 프로세스 3개다. 실제 SIGINT의 유휴 종료 0, SIGTERM의 active drain/원본 바이트 보존/queue retry, 정산 오류가 겹친 종료 1과 임대 만료 후 새 인스턴스 회수·이전 정산 거부·후보 fence를 확인했다. preparation은 명시적 synthetic gate이며 native AV/디코더 증거가 아니다. 임시 디스크는 Linux tmpfs이고 운영 영구 디스크/전원 손실 증거가 아니다. 테스트 자식의 실제 terminal을 확인하지 못하면 시험 root를 보존한다. 최종 구현에서 새 일회용 DB/정확한 자기 컨테이너·이미지 tag 정리까지 확인했다.
- 실제 **ClamAV 1.4.6 / 격리 FFmpeg 9.0.2 / Linux IO / PGlite 결합 18개 통과**. 정의 28144, UTC 2026-10-05T06:24:24. worker의 변경된 검사 후 회수 경로를 포함하는 기존 명시적 재개 → source/candidate 실제 검사·디코딩·저장 → ready/completed 사례가 통과했다. controller 종료 0·OOM false·정확한 namespace/정의 volume/image tag 정리도 확인했다. 같은 native 파이프라인에서 프로세스 신호/DB 정산 오류/전원 장애 전체 행렬을 검증한 것은 아니다.
- 루트 로컬 **61개**, 구문 검사·정적 빌드·whitespace 검증 통과. 공개 dist에 server/docs/작업자 helper·시험 파일이 없음을 확인했다. 이번 변경은 화면을 바꾸지 않아 브라우저/실물 기기 시험을 다시 실행한 것으로 주장하지 않는다.

단위/native 검증을 건너뛰거나 완료 조건을 낮추지 않았다. Docker의 Resource Saver 해제는 별도 로컬 복구이며 운영 서비스 감독 구현이 아니다.

## 변경 파일과 다음 우선순위

- 제품: `server/media-work-queue-worker.mjs`, 신규 `server/media-worker-process.mjs`.
- 시험: 신규 lifecycle 단위·native 사례·native 자식, `postgres-integration.mjs`, PG 시험 Dockerfile/allowlist, fixture/host의 35개 완료 조건.
- 문서: 본 문서, 큐/PG 검증/서버 기반/README의 현재 결과. UI·API·SQL·의존성/lock·기존 자료·GitHub/Vercel·운영 설정은 변경하지 않았다.

다음은 ① 실제 감독자·영속 상태/경보·비공개 영구 매체와 보존/파기·과거 파일 전환·백업/복원 준비 ② 국내 공급자/예산/키·로그·지원·메일·관리자 운영 발급/추가·계정 복구 결정과 구현 ③ 마지막 API·현재 화면 서버 연결·서로 다른 실제 기기의 전송/통신 단절/재접속 검증이다. P0의 사람 작성 시간/요약 이해도와 실물 iOS/Android 키보드·영상 확인도 남아 있다. 공급자·비용·운영 보관 기한을 임의로 확정하거나 유료 자원을 만들지 않는다.
