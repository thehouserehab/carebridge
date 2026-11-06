# Windows/E 작업자와 실제 사진·영상 검사 — 합성 결합 검증

2026-10-07. **실제 자료 베타는 보류하며 전체 개편 목표는 진행 중이다.** 독립 백업 매체가 아직 없고 API는 마지막 순서를 유지한다. 이 단계는 새 UUID 소유의 가상 E DB·파일만 사용하는 명시적 시험이다. 운영 사용자·서비스 설치·외부 접속·배포를 활성화하지 않는다.

## 목적과 변경 범위

앞선 [Windows 실제 엔진 전송](windows-native-media-verification.md)은 실제 ClamAV·FFmpeg를 검증했지만 DB/파일 원장·작업자 자격증명과 함께 실행한 증거는 아니었다. 이번에는 기존 제품 모듈을 수정하거나 대역 검사 결과를 승격하지 않고, Windows 자식 프로세스 → worker 전용 DPAPI/TLS PostgreSQL → E 비공개 파일 → 실제 검사/격리 디코더 → 영속 원장 → 전용 DB 종료를 하나의 합성 시험으로 연결한다.

백엔드 설계 스킬의 책임 분리 원칙을 사용해 시험 정책·자식·부모 관측을 분리했다. 기존 Windows/Node/PostgreSQL 스택을 유지하며 새 의존성·Vercel 자원·운영 API는 도입하지 않았다.

| 변경 파일 | 책임 |
| --- | --- |
| [시험 정책](../server/windows-native-worker-test-policy.mjs) | 가상 목적·새 E root·worker 자격증명 ID·필수 TLS CA·loopback scanner·고정 이미지 ID 검증. stderr는 제한된 단계/분류만 반환. |
| [시험 자식](../server/windows-native-worker-test-child.mjs) | 상속 IPC, 실제 제품 실행기, 실제 Docker/ClamAV 클라이언트를 조립. stdin은 합성 디코더 입력의 일회성 시험 gate뿐. |
| [결합 사례](../server/windows-native-worker-check.mjs) | 실제 큐·파일/검사 증거·접근 권한과 자식 종료/원장/컨테이너 상태를 대조. |
| [자격증명 사례](../server/database-credential-service-native-check.mjs) | 기존 DPAPI/TLS 시험 뒤 opt-in 결합 시험, 성공일 때만 정확한 가상 자격증명 파일 정리. |
| [E 시험 명령](../server/windows-postgres-check.mjs) / [인수 정책](../server/windows-postgres-policy.mjs) | `--verify-native-media`가 역할 분리를 포함. 전체 미디어 암호화 복원·독립 cluster 재시작과 최종 판정을 유지. |
| [기존 작업자 시험](../server/windows-media-worker-native-check.mjs) / [IPC 시험](../server/windows-worker-control-native-check.mjs) | 세션 종료 관측은 다른 계정에 가려질 수 있는 부가 필터 대신 worker 사용자/현재 DB로 검사. |
| [정책 회귀](../server/tests/windows-native-worker-test-policy.test.mjs) / [명령 등록](../package.json) | Docker 없는 6개 회귀와 명시적 `test:native-worker:e-drive`. 기본 시험은 native 엔진을 자동 실행하지 않음. |

UI·인증/세션·제품 worker/검사/저장 구현·SQL 마이그레이션/권한 정책·과거 자료는 변경하지 않았다. 문서 현황은 README·[전체 완료표](communication-acceptance.md)·[서버 현황](server-foundation.md)과 연결한다.

## 시험의 안전 경계

- 기존 E 합성 영수증의 정확한 root만 허용한다. 기존 cluster·운영 파일을 채택하거나 가상 ID를 실제 사용자 관계로 재사용하지 않는다.
- 자식에 비밀번호/임의 실행 명령/관리자 DB 포트를 전달하지 않는다. 전용 credential ID를 실제 CurrentUser DPAPI로 회수하고 worker 목적·DB/OID·권한을 실제 연결의 트랜잭션에서 검사한다. TLS CA/IP 검사·실패 시 거부를 유지한다.
- 실제 원본은 격리 상태로 남고, 원본/후보 AV·별도 디코딩·해시·timeline·metadata 검사를 거친 후보만 준비 증거와 함께 저장한다. 앱이 worker 원장이나 검사 증거를 만들지 않는다.
- IPC 수락/정리 보고는 실제 OS 종료의 대체 증거가 아니다. 정상 종료는 실제 exit 0·close·모든 pipe 닫힘과 DB 세션/정확한 native 컨테이너 부재를 요구한다. 채널 단절은 정리 후에도 실패로 남는다.
- 실패/취소 때 같은 관측 handle을 끝까지 기다린다. 소유/종료가 불확실하면 해당 fixture를 보존하며 전역 prune·강제 성공·자동 재시작을 하지 않는다.
- PostgreSQL 일반 역할은 다른 역할의 세션 통계를 일부 볼 수 없다. native 시험의 TLS/세션 부재는 기존 가상 관리자에 한정된 부모측 읽기 전용 관측으로 확인하고, 제품 역할에 모니터링 권한을 부여하지 않는다. [PostgreSQL 세션 통계 접근](https://www.postgresql.org/docs/18/monitoring-stats.html#MONITORING-STATS-VIEWING)
- scanner 연결은 앞선 임시 loopback 시험 중계다. 같은 PC의 다른 프로세스를 인증하는 운영 경계가 아니며 운영 어댑터로 채택하지 않는다. 검사 실행은 외부 네트워크 없이 하지만 공개 build/정의 갱신은 네트워크를 사용한다.

## 중간 실패 기록

| 실행 | 실제 결과와 보존 |
| --- | --- |
| `3650e4a2-d996-4a95-85b3-9b8eaacc8464` | phase 603 실패. 첫 실제 작업자 자식 exitCode 3221226505, drain 보고 없음. 실제 terminal/pipe 종료와 fixture 자기 자원 정리·PG 정지는 확인. stderr는 아직 관측하지 않았으므로 원인 미확정. |
| `a495f4b8-edd1-408a-ab5c-cb372f70b283` | 제한된 단계 진단 추가 후 phase 603 실패. 자식은 stop 수락·drain·실제 exit 0/close, 최종 단계 6을 보고했으나 TLS 관측은 false. 정상 자식 종료만으로 전체 사례를 통과시키지 않음. |
| `1c478458-af26-4cb1-9fb8-5bee19838b30` | 부모의 가상 관리자 TLS 관측으로 전환한 뒤 TLS true·정상 자식 종료를 확인. 큐는 completed 3개/retry 1개, 모두 attempts 1. 이후 phase 604의 권한 거부 코드 기대값에서 실패. 제품은 파일 존재를 숨기는 NOT_FOUND이고 새 시험의 FORBIDDEN 기대값이 잘못됐음을 기존 구현/회귀와 대조. 제품 접근 권한은 변경하지 않음. |

실패의 생성 JSON을 UUID별 파일로 보존했다. 각각 `E:/CarebridgeBeta\private\checks\postgres-check-<UUID>` 진단 자료는 정지 상태로 유지하며 실패 중 생성한 가상 TLS/DPAPI 파일도 자동 삭제하지 않았다. 운영 백업으로 사용할 수 없다. 평문 시험 비밀번호·암호화 bundle 키는 기록하지 않는다.

3221226505는 0xC0000409 fail-fast 계열이다. 하위 코드/덤프 없이 버퍼 손상이나 특정 Node/Windows 결함으로 단정하지 않는다. 제한된 stderr 관측 추가나 뒤 실행의 정상 종료만으로 첫 비정상 종료 원인이 해결됐다고 주장하지 않는다. [Microsoft fail-fast 설명](https://learn.microsoft.com/en-us/shows/inside/c0000409)

다른 역할의 TLS 통계를 일반 owner에서 확인하는 시험 관측을 부모의 가상 관리자 읽기 전용 관측으로 바꿨다. 원본/후보 승인 기준·제품 권한·실제 종료 확인은 완화하지 않았다. 후속 결과는 아래에 별도로 기록한다.

## 최종 검증

최종 새 실행 **eabee114-895c-4c04-9408-29d5b848d774**, UTC **2026-10-07T10:57:51.038Z**는 **40/40**, exit 0을 통과했다. 이 중 이번 실제 엔진 결합 사례는 6개이고 기존 역할/자격증명/복원 사례를 중복 합산하지 않는다. Node **24.15.0**, PostgreSQL **18.6-5**, 저장 증거의 실제 ClamAV **1.4.6**·FFmpeg **9.0.2**를 대조했다.

| 이번 실제 결합 사례 | 최종 관측 |
| --- | --- |
| PNG / APNG / 동영상 (3개) | 원본·후보 실제 AV 검사와 FFmpeg 디코딩, 프레임/timeline/hash 대조, 원본 불변·후보의 합성 metadata 제거. 실제 E 후보 미리보기와 메시지 바인딩/같은 요청 ID의 단일 발신. 타인 미공유 파일·센터의 원문 접근 NOT_FOUND. |
| 손상 PNG (1개) | AV clean이어도 불법 행 필터는 SCAN_INVALID. 준비 증거/미리보기 없음, 격리/retry 1회 후 명시적 취소·삭제 fence. |
| 실행 중 정상 stop (1개) | 실제 Running 디코더/full ID 확인 후 IPC stop 수락. 정확한 컨테이너/원장 정리와 TLS pool close 뒤 실제 exit 0·close·pipe 종료. 원본 보존, quarantine/retry 1회. |
| 실행 중 상속 채널 단절 (1개) | 실제 Running 확인 후 단절. 정확한 컨테이너/원장 정리와 TLS pool close 후 실제 exit 1/pipe 종료. close 누락을 정상 성공으로 승격하지 않음. 원본 보존, quarantine/retry 1회. |

native 자식 **3개 모두 실제 terminal**, 해당 durable decoder job **6개 모두 closed/컨테이너 부재**, fixture 자기 자원 정리를 확인했다. 첫 4개 큐는 completed 3개/retry 1개이며 모두 attempts 1이었다. 부모 가상 관리자에서는 실제 worker TLS true가 확인됐지만 같은 시점의 일반 owner 통계는 제한되어 `ownerStatisticsRestricted: true`였다. 따라서 일반 계정의 빈/가려진 관측을 연결 부재나 plaintext로 간주하지 않는다.

원본/후보와 삭제 fence를 포함한 **27파일(10 blob·17 fence)** 전체를 DB 덤프와 함께 암호화 bundle에 인증하고, 새 별도 E cluster에 복원하여 지문·바이트·권한과 독립 재시작을 확인했다. 원본/복원 cluster는 모두 정지했고 성공 fixture의 가상 DPAPI 자격증명 **8개** 및 TLS 키/영수증은 확인 후 정확히 정리했다. 실패 fixture는 보존했다. 모든 준비 증거의 `mediaAcceptanceReady`는 false이며 이는 운영 승인/익명화 보장과 구분한다.

기존 일반 E 명령도 새 run **fced0e7d-679e-4178-bf2c-90f32e98c787**, UTC **2026-10-07T10:53:08.334Z**에서 **9/9**, 원본/복원 정지로 통과했다. opt-in 추가가 기존 명령을 native 자동 실행으로 바꾸지 않았음을 확인했다.

현재 회귀: 서버 **688/688**, 로컬 **87/87**, 집중 **56/56**, 구문 검사·정적 빌드·tracked whitespace 통과. 실패/취소/skip 각각 0. 집중 회귀는 서버 수치에 별도 합산하지 않는다. 브라우저/실물 기기·사람 사용성·운영 계정/서비스 검증을 이번 회귀로 대신하지 않는다.

최종 QA는 이번 소스/문서 **15파일**의 UTF-8·whitespace와 로컬 링크 **141개**의 대상을 확인했다. dist는 원본과 바이트가 같은 공개 자산 **31개**와 build metadata **1개**뿐이며 서버/시험/문서/비밀·기타 파일은 없다. 같은 Docker 엔진에서 이번 실패/성공 AV run 4개와 decoder 이미지 run 8개의 자기 container/image/volume 잔여 **0**을 읽기 전용으로 재확인했다. E 진단 root 5개는 보존됐고 각 원본/복원 postmaster PID 파일·시험 Node 프로세스는 없었다. 성공 실행의 가상 credential/TLS root 부재도 확인했다. 재생성 가능한 시험 컨테이너·이미지·정의 볼륨과 성공 가상 키만 정리했으며 전역 prune·무관 자원/기존 E 자료 삭제는 하지 않았다.

```powershell
npm run test:native-worker:e-drive -- --base E:/CarebridgeBeta --powershell 'C:/Users/USER\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe' --confirm-synthetic-e-drive
npm run test:postgres:e-drive -- --base E:/CarebridgeBeta --powershell 'C:/Users/USER\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe' --confirm-synthetic-e-drive
npm run test:server
npm test
npm run check
npm run build
git diff --check
```

집중 명령은 다음과 같다.

```powershell
node --test server/tests/windows-native-worker-test-policy.test.mjs server/tests/windows-media-worker-process.test.mjs server/tests/media-worker-control.test.mjs server/tests/media-worker-control-native.test.mjs server/tests/windows-database-service.test.mjs server/tests/windows-postgres-policy.test.mjs
```

실행 전제: 기존 보호된 E 경로와 PostgreSQL 18.6-5 vendor-checksum 검증 runtime, Windows/Node 24, 기존 Docker Desktop Linux engine/context/local builder, pinned base 이미지/FFmpeg 공개 소스 build 준비, 충분한 RAM. 설치·엔진 기동·이미지 자동 pull은 이 명령의 역할이 아니다. 실행마다 새 가상 cluster/파일과 명시적 Docker 자원을 생성한다.

## 남은 위험과 다음 우선순위

1. 첫 비정상 종료의 원인은 미확정이다. 운영 자동 재시작/성공으로 덮지 않고 재현 가능한 제한 진단을 유지한다.
2. CLI/부모 경로의 운영 ACL·서명·named pipe 권한·전용 Windows 계정/SCM·이미지 승인/정의 업데이트·지속 감시/경보는 별도 구현·검증이 필요하다. 이 시험 런처는 운영 보안 어댑터가 아니다.
3. 독립 매체·키 회수/복원·보존/파기·복구 책임·현재 권한/삭제 대조·RPO/RTO가 미완료다. 같은 E의 복원 성공은 디스크 고장 대비 독립 백업이 아니다. 실제 아동 자료를 받지 않는다.
4. 원 개편안의 P0 사람 비교 관측/실물 기기·메시지/과거 열람 정책과 실제 계정/메일 복구를 완료해야 한다. 그 뒤 마지막 API/화면 연결·독립 기기 전달/재접속을 검증한다. P2는 관찰 근거가 있을 때만 추가한다.

이번 합성 결합 단계가 전체 P1이나 전체 개편 완료를 의미하지 않는다. 실제 자료를 받지 않은 상태에서 다음 안전한 구현은 운영 Windows 실행 경계/감독의 설계·제한 검증이며, 독립 백업 매체 준비와 P0 사람 관측은 별도로 필요하다.
