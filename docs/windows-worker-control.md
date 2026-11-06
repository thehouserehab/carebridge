# Windows 파일 작업자 — 상속 IPC 종료 제어

2026-10-07. **비API 준비 단계이며 전체 개편 완료가 아니다.** 기존 E·Node·PostgreSQL 구성에, 직접 만든 자식 프로세스에만 전달하는 협력적 종료 채널을 추가했다. 운영 Windows 서비스·전용 계정·외부 접속·실제 아동 자료·API/화면 연결·배포는 활성화하지 않았다. 독립 백업 매체는 사용자 답변상 아직 없으므로 실제 자료 베타 전환을 계속 보류한다.

## 목적과 책임 분리

이전 [DB 소유·작업자 수명](windows-media-worker-lifetime.md)은 같은 프로세스의 AbortSignal로 drain을 요청했다. 이번에는 별도 Windows 자식 프로세스의 종료 요청과 실제 종료 확인을 연결한다. 백엔드 아키텍처 스킬의 조립/실행 책임 분리에 따라 제어 통신과 기존 DB·큐·파일 작업은 분리했다. 새 의존성·유료/Vercel 자원·자동 실행 CLI는 추가하지 않았다.

```text
직접 소유한 부모                    전용 Node 자식
     │             control-ready ← IPC handler 등록
stop 요청 ───────────────────────→ AbortSignal 종료 요청
     │             stop-accepted ← 요청 수락(완료 아님)
     │                             진행 작업·원장 정산/회수
     │                             전용 DPAPI/TLS DB close
     │                    drained ← 자체 drain 보고(종료 아님)
     │                             자기 IPC 연결 해제·자연 종료
     └─ 실제 exit → close + send callback 완료 → 정상 판정
        단절 오류만: 실제 exit + 채널/모든 pipe 닫힘 → 실패 확정
```

Node의 send callback은 수신자의 처리 완료를 보장하지 않고, send의 false 반환은 역압 또는 닫힌 채널을 뜻할 수 있다. close는 프로세스 종료와 표준 IO 종료를 관찰하는 별도 이벤트다. 따라서 전달 callback·요청 수락·drain 보고·실제 종료를 각각 확인한다. [Node child_process 문서](https://nodejs.org/api/child_process.html#subprocesssendmessage-sendhandle-options-callback), [close 이벤트](https://nodejs.org/api/child_process.html#event-close).

Windows의 process.kill/subprocess.kill 신호를 정상 정리 요청으로 사용하지 않는다. [Node 24 신호 문서](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events)는 Windows SIGINT/SIGTERM/SIGKILL 전송이 대상을 무조건 종료시킬 수 있음을 명시한다.

## 제품 계약

- [프로토콜](../server/media-worker-control-protocol.mjs)은 schema/purpose/instanceId/kind/requestId 다섯 필드만 허용한다. 상속 Node IPC 외부에 HTTP·명명 파이프·소켓 endpoint를 열지 않는다. 설정·비밀번호·임상/파일 내용·OS handle은 거부한다.
- instanceId/requestId는 소문자 UUIDv4다. 실행·요청 일치를 위한 값이지 비밀 토큰이나 OS 신원 인증이 아니다. 직접 상속한 채널과 신뢰된 부모의 소유를 전제로 하며, 같은 사용자/관리자 공격을 격리하지 않는다. 파싱 후 정확한 schema 검사이지 악성 IPC 직렬화 입력의 메모리 한도 증명이 아니다.
- [자식 어댑터](../server/media-worker-controlled-process.mjs)는 IPC handler를 먼저 등록하고 control-ready를 보고한다. 동일 stop의 반복은 한 번만 수락하고, 다른 요청/실행·형식 오류·채널 상실은 오류를 고정하고 내부 AbortSignal을 종료한다. 이미 시작한 작업은 기다린다.
- runWindowsMediaWorkerControlledProcess는 기존 Windows worker 전용 DPAPI/TLS·같은 연결 권한 검사·큐/원장·DB close를 그대로 사용한다. 앱/owner 연결로 대체하지 않으며 준비/실행/close 오류는 성공으로 바꾸지 않는다.
- 자식은 단일 송신 체인과 최대 ready/acceptance/terminal 보고를 사용한다. terminal 보고를 시작하면 큐를 봉인한다. 뒤늦은 새 stop이 drained 뒤에 acceptance를 추가하거나 종료 후 송신을 남기지 못한다. disconnect/protocol fault는 drain을 기다린 뒤 고정 오류를 반환하고, 기존 nonzero exitCode를 보존한다.
- [부모 어댑터](../server/media-worker-child-control.mjs)는 호출자가 직접 만든 ChildProcess handle만 관찰한다. spawn·PID 채택·kill·disconnect·강제 종료·자동 재시작은 하지 않는다. 중복 소유/외부 handler가 있으면 거부한다. process 생성·안전한 bootstrap·운영 설정·OS 접근제어 책임은 호출자에게 남는다.
- requestStop()은 같은 Promise를 재사용하며 ready 전 요청을 보류한다. 송신은 최대 한 번이고 결과는 일치하는 stop-accepted에서만 수락된다. 전달 결과가 불명확해도 재전송하지 않는다. 고정 오류를 처음 관찰하면 가능한 기존 채널에 단 한 번 협력적 stop을 요청한다.
- waitForExit()의 **정상 성공**은 실제 exit와 close, 일치하는 code 0/signal null·drain과 요청 수락을 확인한다. close 뒤 늦은 송신 callback까지 기다리므로 뒤늦은 송신 오류가 성공으로 바뀌지 않는다. nonzero/signal·drain 없는 종료·채널 상실·송신/프로토콜 오류는 고정 오류 MEDIA_WORKER_CONTROL_UNAVAILABLE다.
- 현재 Node 24.15의 부모 주도 disconnect에서 close 누락을 실제 재현했다. 이 **실패 경로만** 실제 exit·실제 disconnect 및 channel 없음·사전에 캡처한 모든 stdio의 공개 closed=true를 독립 확인해 실패를 확정한다. exit 없는 소실·열린 pipe·건강한 정상 종료에는 이 경로를 사용하지 않는다. private counter를 변경하거나 가짜 close를 emit하지 않는다. 제어 어댑터는 스트림을 소비/파괴하지 않는다.
- status()는 frozen 프로세스 로컬 상태다. terminal은 실제 close 또는 위의 실패 종료 증거이며 drain/timeout/heartbeat가 아니다. closeObserved/stdioClosed를 따로 제공하므로 누락된 close를 관찰했다고 숨기지 않는다. 임상/파일/자격증명/실행 ID·원문 오류/cause는 내보내지 않는다. terminal=true 후에도 송신 callback이 미완료이면 최종 Promise는 아직 완료되지 않을 수 있다.

## 검증

```powershell
node --test server/tests/media-worker-control.test.mjs server/tests/media-worker-control-native.test.mjs server/tests/windows-media-worker-process.test.mjs server/tests/media-worker-service.test.mjs server/tests/media-worker-lifecycle.test.mjs server/tests/decoder-journal.test.mjs
npm run test:server
npm test
npm run check
npm run build
git diff --check
node server/windows-postgres-check.mjs --verify-role-privileges --base E:/CarebridgeBeta --powershell C:\Tools\PowerShell\pwsh.exe --confirm-synthetic-e-drive
node server/windows-postgres-check.mjs --base E:/CarebridgeBeta --powershell C:\Tools\PowerShell\pwsh.exe --confirm-synthetic-e-drive
```

PowerShell 7은 실제 설치 경로로 바꾼다. 이전 중단 DB는 채택하지 않고 새 UUID만 사용한다. 제품 어댑터는 자체 실행 CLI/테스트 bootstrap을 제공하지 않는다.

| 범위 | 이번 실행 증거 |
| --- | --- |
| 집중 회귀 | **69/69**. 제어 18·실제 Windows 프로세스 2·Windows 수명 13·조립 5·lifecycle 17·decoder journal 14. callback/drain/close 경합, 단절 후 close 누락/실제 스트림 종료, 중복 소유·요청, 컨테이너 ID 재사용 차단 포함. |
| 전체 서버 | **659/659**, 실패/취소/건너뜀 0. |
| 로컬 단위 | **87/87**, 실패/취소/건너뜀 0. UI 변경·새 브라우저/실물 기기 관측 없음. |
| 구문·정적 빌드 | npm run check/build 통과. |
| 실제 Windows/E 결합 | **34/34**, UUID 71fb0677-45f4-4520-8932-a3e770008dbd, UTC 2026-10-07T09:34:50.184Z. source/restored 종료 true, 시험 자격증명 8개·TLS 정리 true. 전체 파일 15개(바이트 객체 4·삭제 fence 11) 복원·재시작 포함. |
| 일반 E 저장·복원 회귀 | **9/9**, UUID eaa1c5ff-ff32-414b-a911-61f565694e49, UTC 2026-10-07T09:35:43.105Z. 양쪽 cluster 종료 true, credential/TLS 결합 옵션 없는 기존 경로다. |

최종 산출물 검사: 이번 파일 16개·로컬 링크 143개·whitespace 통과, 정적 배포물은 원본과 바이트가 같은 공개 자산 31개+build metadata 1개뿐이다. server/docs/tests/secret은 포함되지 않는다. 두 결과 JSON의 UUID/시각/개수·보고서를 대조했고 Git/배포 제외도 확인했다. PostgreSQL/자기 시험 프로세스와 운영 secret 파일은 0개다. 성공 실행의 시험 자격증명 8개·TLS 폴더는 제거됐으며 실패 fixture 세 개는 보존했다. 삭제한 합성 키/비밀번호는 재사용할 수 없고 남은 source는 삭제한 시험 TLS를 참조하므로 재시작 가능한 운영 백업이 아니다. 사용자 데이터·운영 비밀은 삭제하지 않았다.

실제 E 결합의 [부모 시험](../server/windows-worker-control-native-check.mjs)과 [자식 시험](../server/windows-worker-control-native-child.mjs)은 fresh Windows 자식 두 개를 순차 소유하며 실제 DPAPI·SCRAM/TLS·SQL/E 원본과 제품 어댑터를 연결한다. scanner/decoder는 명시적인 **합성 상대**다.

1. 첫 자식은 합성 decoder 응답을 보류한다. 중복 stop 요청이 같은 Promise를 반환하고 한 번 수락되는지, release 전 실제 종료하지 않는지 확인한다. release 후 drain→DB backend 종료→실제 exit/close 0과 원본 바이트·quarantine/retry·닫힌 원장을 확인한다.
2. 두 번째 자식은 같은 진행 지점에서 부모 IPC만 끊는다. release 전 완료되지 않고, release 후 실제 nonzero exit 1·고정 오류가 되는지 확인한다. 원본 바이트·retry·닫힌 원장·worker backend 0은 별도로 대조한다. 실제 결과는 stop의 closeObserved=true/exitCode=0, disconnect의 closeObserved=false/exitCode=1이며 둘 다 stdioClosed=true·terminal=true다. 누락된 close를 성공 증거로 사용하지 않았다.

결합 옵션의 9묶음은 기존 자격증명 5·같은 프로세스 수명 2·새 IPC 2이며 전체 E34에 포함된다. 일반 E9·집중 69·전체 서버 숫자와 독립 건수로 합산하지 않는다. test-results/database-privileges-results.json은 Git/배포 제외 합성 진단이다. 기본 서버 시험에도 [실제 프로세스 회귀 2개](../server/tests/media-worker-control-native.test.mjs)를 추가했으며 Windows 이외에서는 명시적 skip이다. 이번 Windows에서는 두 개 모두 실행됐다. 이 빠른 시험에는 DB/E·검사 엔진이 없고 E 결합을 대신하지 않는다.

stdin release와 한 번의 설정 bootstrap은 **합성 시험 장치**다. 제품 stop 프로토콜에 설정을 섞지 않는다. 15초 관측 한도는 시험 실패를 찾는 데만 사용하며 종료 증거가 아니다. finally에서도 협력적 stop/release 후 정확한 handle의 실제 종료를 계속 기다리고 kill/재시작/불확실 파일 정리를 하지 않는다. 후속 업로드 취소·검증된 임시 자격증명/TLS 삭제는 명시적인 합성 후처리다.

### 중간 실패와 수정

- c6b0461e-e97d-4103-9dcb-1e9df744f90b: UTC 2026-10-07T05:14:47.528Z, passed:false/phase5022, sourceStopped=true. 당시 상세 단계가 부족해 finer phase와 고정된 최소 상태 진단을 추가했다. 뒤의 결과를 이 실행의 성공으로 대체하지 않는다.
- f8399c1e-8ef3-4edd-b768-a29ccb900325: UTC 2026-10-07T05:17:41.232Z, passed:false/phase50221, 자식 2개 모두 실제 terminal=true/마지막 exit 1·sourceStopped=true. 두 번째 자식이 PREPARING 이전에 실패한 것을 확인했다.
- 원인 코드 경로는 fresh fakePreparation의 container counter가 매 프로세스 1부터 시작하지만 엔진 이름을 두 자식이 공유한 것이다. 012의 UNIQUE(engine_id,container_id)는 닫힌 작업에도 유지된다. 새 journal 회귀가 같은 엔진 재사용 거부·독립 엔진 허용을 재현했다. 독립적인 메모리 시험 엔진마다 instance UUID로 식별자를 분리했으며 SQL fence·운영 엔진 식별·원장 보호 규칙은 **완화하지 않았다**. 최종 새 E34로 재검증했다.
- e3f6f110-6853-4170-969c-43cc4c924385: 엔진 식별 수정 후에도 credential-service에서 대기했고 최종 JSON을 남기지 않았다. 별도 최소 재현에서 실제 자식 exit 1과 모든 pipe 닫힘/채널 없음인데 ChildProcess close가 오지 않는 것을 확인했다. [사용 중인 Node 24.15 소스](https://raw.githubusercontent.com/nodejs/node/v24.15.0/lib/internal/child_process.js)의 직접 disconnect 경로와 channel EOF의 close 집계 경로가 다르며, 실측으로 누락을 확인했다. Node 내부 값을 수정하는 우회는 하지 않았다.
- e3f6 진단 정리는 fresh receipt·정확한 source 경로·postmaster PID21124/부모13416·실행 파일·작업 자식 부재를 대조한 뒤 그 합성 PostgreSQL만 pg_ctl fast/wait로 정상 정지했다. root·자격증명/TLS는 보존했다. 실행기는 미완료 top-level await/exit 1로 끝났고 중지 호출 시 이미 없었다. 따라서 실행기를 강제 종료해서 정상 drain을 증명한 것이 아니다. 별도 최소 재현의 자식이 끝난 뒤 남은 진단 타이머 부모 2개만 정확한 PID/명령·자식 부재를 확인해 종료했다. 운영 프로세스/사용자 브라우저·서버는 건드리지 않았다.
- 실패 root 세 개의 합성 원장·암호화 자격증명/TLS는 보호된 E checks에 보존한다. 삭제/초기화/재시작하지 않았다. 당시 최신 JSON은 f839의 실패로 남아 있어 e3f6 성공으로 취급하지 않았다. [이전 수명 단계](windows-media-worker-lifetime.md#실패-기록-보존)의 원인 미확정 종료나 더 이전 키/PG 실패 원인을 이번 수정으로 확정하지 않는다.

## 남은 위험과 다음 순서

1. 승인된 전용 Windows 계정·SCM/서비스 실행·부모 제어 권한/신원·설정 전달과 native 검사 엔진의 실제 결합이 남았다. 현재 코드는 CurrentUser DPAPI·상속 채널만 다루며 운영 감독자·영속 heartbeat/경보·자동 재시작 정책이 아니다.
2. 내부 작업/송신 callback/native 회수가 끝나지 않으면 종료 대기가 계속될 수 있다. 이를 타이머 성공이나 강제 종료 후 정상 정리로 숨기지 않는다. 부모 자체가 비정상 종료/전원 손실됐을 때 lease·원본/candidate fence·권한/삭제 원장 대조 및 승인된 복구/재시작은 별도 증거가 필요하다.
3. 독립 백업·기기/Windows 프로필 상실 후 키 복구·운영 TLS/HBA·보존/파기·회전/회수·RPO/RTO가 미완료다. 같은 E의 사본/복원 시험은 독립 백업이 아니며 삭제한 시험 키와 남은 합성 source는 운영 백업이 아니다.
4. P0 사람의 답변/상세 기록 시간·공유 요약 이해도, 실물 iOS/Android, 보호자 접속 범위·메시지 정책·계정/메일 운영을 확인하고 **마지막 API/화면·독립 기기 전달/재접속**을 검증한다. [전체 완료표](communication-acceptance.md)의 원 목표를 축소하지 않는다.

### 변경 파일

- 제품: [제어 프로토콜](../server/media-worker-control-protocol.mjs), [자식 어댑터](../server/media-worker-controlled-process.mjs), [부모 관측기](../server/media-worker-child-control.mjs).
- 시험: [제어 18개](../server/tests/media-worker-control.test.mjs), [빠른 실제 Windows 회귀](../server/tests/media-worker-control-native.test.mjs)와 [합성 자식](../server/tests/fixtures/media-worker-control-child.mjs), [journal 회귀](../server/tests/decoder-journal.test.mjs), [실제 E 부모](../server/windows-worker-control-native-check.mjs), [실제 E 자식](../server/windows-worker-control-native-child.mjs), [자격증명 결합](../server/database-credential-service-native-check.mjs), [E 진입점](../server/windows-postgres-check.mjs).
- 문서: 이 보고서와 README·전체 완료표·서버 기반·이전 수명 보고서의 후속 링크. SQL/권한 v2·의존성·인증/세션·기존 임상/첨부·UI·배포·Windows 계정/서비스·방화벽·기존 Docker 자료는 변경하지 않았다.

전체 개편 목표는 진행 중이다.
