# Windows 파일 작업자 — DB 소유와 종료·복구 경계

2026-10-07. **비API 준비 단계**다. 실제 운영 Windows 서비스가 아니라, 호출한 프로세스에서 DB 연결과 파일 작업자의 수명을 함께 소유하는 코드다. 실제 아동 자료·운영 계정/서비스·외부 접속·UI/API·배포는 활성화하지 않았다. 사용자 답변상 독립 백업 매체가 없으므로 실제 자료 베타 전환은 계속 보류한다.

후속 [상속 IPC 종료 제어](windows-worker-control.md)는 이 실행기를 별도 Windows 자식에 연결한다. stop 수락·drain·실제 종료를 구분하며 부모 단절/close 누락을 실패로 확정하는 경계를 실제 시험했다. 합성 E34·서버659·로컬87·집중69 통과. 운영 SCM/전용 계정·native 검사 결합·독립 백업·마지막 API 완료는 아니다. 아래는 이 단계 당시 기록이다.

## 문제와 변경

기존 [작업자 실행기](media-worker-lifecycle.md)는 준비된 worker를 받아 시작하고 종료 요청을 전달했지만, DB 준비 중 종료와 pool 종료 책임은 호출자에게 남았다. [Windows DB 연결](windows-database-service.md)은 암호화 비밀번호 회수·TLS·권한 검사를 제공하지만 작업자 drain 순서를 소유하지 않았다.

백엔드 아키텍처 스킬의 조립/실행 책임 분리에 따라 기존 E·Node·PostgreSQL 구성에서 다음 경로를 만들었다. 새 의존성·Vercel 자원·자동 실행 CLI는 추가하지 않았다.

```text
설정 캡처·작업자 조립(아직 IO 없음)
       ↓
전용 프로세스/종료 요청 소유권 확보
       ↓
DPAPI → worker 전용 DB/TLS·권한 입장
       ↓
영속 원장 회수 → 큐 처리 → 작업/정산/정리 drain
       ↓
DB pool·진행 중 비밀번호 회수 종료
       ↓
자기 listener 해제 → 성공 또는 고정 오류
```

### 제품 계약

- `runWindowsMediaWorkerProcess({database, media}, {signal, targetProcess})`를 명시적으로 호출해야 실행한다. import·설정 준비만으로 파일/원장·서비스·엔진을 시작하지 않는다.
- database는 storage/credentialId/privileges/endpoint만 받는다. worker 목적은 코드가 고정한다. raw pool·평문 비밀번호·owner/app 역할 선택·자동 역할 변경·fallback은 받지 않는다. 기존 loopback/TLS·DPAPI/DB/OID와 매 트랜잭션 권한 검사를 유지한다.
- media는 구체적인 PrivateFileStore/LocalClamAvClient, 승인된 runtime/image/engine, 기존 capacity·poll 한도다. journal/preparation/worker/localTestMode/force 주입은 거부한다. DB 설정·runtime 함수·worker 구성은 첫 await 전에 캡처하고 검증한다. 저장소 ACL·runtime 신뢰성은 별도 운영 게이트다.
- `prepareMediaWorkerService`는 IO 없는 조립과 명시적인 읽기 전용 입장 검사를 분리한다. 기존 createMediaWorkerService의 동작은 그대로 조립→입장→아직 시작하지 않은 worker 반환이다.
- 공유 `withMediaWorkerProcessLifetime`은 DB 준비 **전부터 pool 종료 후까지** 프로세스 소유권·SIGINT/SIGTERM listener·선택 AbortSignal을 보유한다. 기존 handler/다른 runner가 있으면 덮어쓰지 않고 거부한다. 자신의 listener만 완료·오류·부분 등록 실패 때 해제한다.
- 미리 종료된 signal은 자격증명/DB/작업자 IO를 하지 않는다. DPAPI/DB 준비 중 종료는 이미 시작한 준비의 결과를 기다리고, 성공하면 큐를 시작하지 않은 채 연결을 닫는다. 준비 오류가 종료와 겹쳐도 정상 종료로 숨기지 않는다.
- 처리 중 종료는 기존 worker의 원장 회수·검사·정산·후속 정리를 기다린다. **DB를 먼저 닫지 않는다.** close도 종료 확인의 일부이며 실패하면 성공 결과를 반환하지 않는다. 성공 결과는 frozen stopped/processed뿐이다. 상태 endpoint·비밀·파일/아동 ID를 반환하지 않는다.
- 실행/정리 오류는 MEDIA_WORKER_UNAVAILABLE로 고정하고 원문/cause를 내보내지 않는다. 기존 nonzero exitCode를 보존하며 unset/0의 실행 실패만 1로 설정한다. 성공으로 이전 오류를 0으로 지우지 않는다. process.exit·강제 kill·drain 타이머 경합·자동 재시작/권한 복구는 없다.

이 signal은 **신뢰된 내부 종료 채널**이지 인증 없는 HTTP/IPC 명령이 아니다. Windows에서 Node의 process.kill/subprocess.kill로 SIGTERM/SIGINT를 보내면 무조건 종료될 수 있으므로 cooperative drain 시험으로 간주할 수 없다. [Node 24 신호 문서](https://nodejs.org/docs/latest-v24.x/api/process.html#signal-events). 새 AbortSignal 접점은 향후 승인된 Windows 서비스 제어 어댑터용이며, 현재 SCM·서비스 래퍼/IPC 접근제어·재부팅/정전 안전성이 구현됐다는 의미가 아니다.

## 검증과 한계

```powershell
node --test server/tests/windows-media-worker-process.test.mjs server/tests/media-worker-service.test.mjs server/tests/media-worker-lifecycle.test.mjs
npm run test:server
npm test
npm run check
npm run build
git diff --check
node server/windows-postgres-check.mjs --verify-role-privileges --base E:/CarebridgeBeta --powershell C:\Tools\PowerShell\pwsh.exe --confirm-synthetic-e-drive
```

PowerShell 7 경로는 실제 설치 경로로 바꾼다. 기존 DB/중단 fixture는 채택하지 않고 새 UUID만 사용한다.

| 범위 | 현재 증거 |
| --- | --- |
| 집중 단위 | 35/35: 신규 수명 13·기존 조립 5·기존 lifecycle 17. driver/catalog/worker 대역과 기존 PGlite·임시 디스크 시험이다. |
| 전체 서버 | 638/638, 실패/취소/건너뜀 0. |
| 로컬 단위 | 87/87, 실패/취소/건너뜀 0. UI 변경이나 새 브라우저/실물 기기 시험은 없음. |
| Windows/E 결합 | **32/32**, UUID b3c42eab-7a14-46db-a05d-a278268fab47, UTC 2026-10-07T04:58:22.489Z. source/restored 종료 true, 시험 자격증명 8개·TLS 파일 정리 true. 파일 11개(원본/후보 4·삭제 fence 7) 전체 복원·재시작 포함. |
| 일반 E 저장/복원 회귀 | **9/9**, UUID b7f47121-6d0d-4377-9723-1cb933f1c595, UTC 2026-10-07T05:00:33.121Z. 양쪽 cluster 종료 true, credential/TLS 결합 옵션 없는 경로다. |

check/build·whitespace 검증도 통과했다. 신규 Windows 전용 수명 8개는 다른 OS에서 실행한 것처럼 조용히 성공하지 않고 명시적 skip으로 표시한다. 이번 Windows에서는 35개 모두 실제 실행됐다. 최종 확인에서 PostgreSQL 프로세스·운영 secret 파일은 0개였고, 정상 실행의 시험 자격증명/TLS 폴더는 제거됐으며 두 실패 fixture는 보존됐다. 삭제한 시험 키는 이 실행에서 다시 사용할 수 없고, 남은 합성 source의 설정은 삭제한 시험 TLS 키를 참조하므로 재시작 가능한 운영 백업이 아니다.

새 실제 E 시험 2묶음은 제품 실행기와 실제 CurrentUser DPAPI·SCRAM/TLS·같은 연결 권한 가드·SQL 원장·비공개 원본 바이트를 연결한다. scanner/decoder 상대는 **합성 대역**이다.

1. 실행 중인 합성 decoder 응답을 보류하고 cooperative stop을 요청한다. release 전 결과가 완료되지 않으며, release 후 원장 정리·quarantine/retry·원본 바이트 보존·전용 PG backend 종료·listener 해제를 확인한다. 취소/삭제는 명시적 합성 후처리다.
2. 준비 중 fixture worker 권한을 명시적으로 회수하고 stop을 겹친다. 성공/자동 재승인 대신 오류·원본/미정산 running 원장을 보존한다. **시험 소유자만** 권한을 되돌리고 합성 lease를 만료시킨 뒤 새 실행기를 만든다. 새 인스턴스가 정확한 namespace와 원장을 회수하고 DB를 닫는지 확인한다. 제품의 자동 GRANT/시계 변경/운영 복구 승인 기능이 아니다.

native 추가 2개는 기존 30개에 포함시켜 총 32개로 판정한다. 결과는 Git/배포 제외 test-results/database-privileges-results.json에 저장했다. 기존 일반 E9와 기본 흐름이 겹치므로 독립 41개로 합산하지 않는다. 같은 프로세스의 EventEmitter/AbortSignal 관측은 실제 Windows 서비스 제어·별도 프로세스 IPC·PC 전원 손실 증거가 아니다. 직전 standalone DPAPI15/복구 키13·실제 ClamAV/FFmpeg·사람/실물 검사를 이번에 다시 했다고 하지 않는다.

### 실패 기록 보존

- 첫 UUID dbe5a650-dff2-44f6-95a5-49ce58fca770은 새 DB 시작 단계에서 exit 1로 끝나 최종 JSON을 남기지 않았다. stale PID16504는 실제 프로세스가 없고 PostgreSQL 프로세스/임시 init-password 파일도 0개였다. 원인은 미확정이며 폴더를 초기화/삭제/재시작하지 않았다. 당시 최신 결과 JSON은 직전 E30의 것이어서 이번 성공으로 취급하지 않았다.
- 두 번째 dc85753a-7205-4cf5-92e3-76bab5e9d672는 최종 passed:false/phase401로 source 종료를 확인했다. TLS 신원 변경 시험으로 닫힌 owner pool을 후속 시험이 재사용하는 코드 경로를 확인해 새 owner 연결을 명시적으로 열도록 수정했다. 새 시험의 decoder 원장 영역도 기존 시험과 분리했다. 미확정 첫 종료나 [이전 진단](windows-database-credential-store.md)의 실패 원인을 이 수정으로 확정하지 않는다. 실패 fixture는 암호화 시험 자격증명·TLS 키를 포함할 수 있으며 보호된 E 경로에 보존한다. 운영 비밀이 아니다.

## 남은 위험과 다음 우선순위

1. 승인된 전용 Windows 계정·서비스 제어/실행·IPC/권한 격리, native 검사 엔진과 이 실행기의 실제 결합, 영속 heartbeat/경보·감독자 정책이 남아 있다. 현재 사용자 DPAPI는 같은 사용자 프로세스/관리자를 격리하지 않는다.
2. 막힌 내부 작업·native 회수가 끝나지 않으면 drain이 기다릴 수 있다. 강제 종료를 정상 정리로 취급하지 않는다. OS 중단 후 lease/원본/candidate fence·최신 삭제/검사 원장 대조·격리 해제 및 운영 cutover는 별도 검증이 필요하다.
3. 독립 백업 매체·기기/프로필 상실 후 키 복구·운영 TLS/HBA·보존/파기·자격증명 회전/회수·RPO/RTO·전체 권한 검사 부하가 미완료다. 같은 E 복원으로 대신하지 않는다.
4. 사람의 기록 작성/요약 이해도와 실물 iOS/Android, 보호자 접속 범위·정책·계정/메일 운영 후 **마지막 API/화면·독립 기기 전달/재접속**을 검증한다. [전체 완료표](communication-acceptance.md)의 원 목표를 축소하지 않는다.

### 변경 파일

- 제품: [소유 실행기](../server/windows-media-worker-process.mjs), [공유 프로세스 수명](../server/media-worker-process.mjs), [2단계 작업자 조립](../server/media-worker-service.mjs).
- 시험: [수명 13개](../server/tests/windows-media-worker-process.test.mjs), [E 결합 2묶음](../server/windows-media-worker-native-check.mjs), [자격증명 결합](../server/database-credential-service-native-check.mjs), [E 진입점](../server/windows-postgres-check.mjs).
- 문서: 이 보고서와 README·완료표·서버 기반·이전 DB 연결/worker 수명의 후속 링크. SQL/권한 v2·의존성·인증/세션·임상/기존 첨부·UI·배포·Windows 계정/서비스·방화벽·기존 Docker 자료는 변경하지 않았다.

전체 개편 목표는 진행 중이다.
