# E 드라이브 PostgreSQL 지속 저장·복원 검증

최신 [암호화 자격증명 기반 실제 연결](windows-database-service.md)은 네 역할 DPAPI→PG 로그인·새 프로세스 TLS/CA/IP 거부와 기존 권한/worker/전체 파일 복원을 결합해 30개·서버 625·로컬 87을 통과했다. 운영 TLS/HBA·OS/실제 worker·독립 백업·API는 아직이다. 아래 일반 E9와 역사적 숫자는 각 단계의 별도 증거다.

2026-10-07. 사용자 결정인 **로컬 E 기반의 실제 센터·보호자 베타**를 위한 비API 준비 단계다. 이번에는 가상 자료와 신규 시험 경로만 사용했다. **운영 서비스·실제 계정·실제 아동 자료 입력·외부 접속·마지막 API 연결은 활성화하지 않았다.**

사용자는 독립 백업 매체가 **아직 없다**고 답했다. 따라서 실제 자료 운영 전환은 보류하며, E 내부 사본을 독립 백업으로 대체하지 않는다. 유료 자원 생성이나 무백업 운영 승인은 아니다.

## 선택한 방식과 변경 경계

Windows용 PostgreSQL 도구를 `E:/CarebridgeBeta\private\runtime\postgresql-18.6-5`에 프로젝트 전용으로 배치했다. Docker 전체 VHDX/기존 볼륨을 E로 이동하지 않고, Linux PGDATA를 검증 없이 NTFS에 직접 마운트하지 않는다. Windows 서비스·OS 계정·방화벽·시스템 PATH·기존 브라우저 저장소·SQL 001~018·인증/API 동작은 변경하지 않았다.

[PostgreSQL 공식 Windows 다운로드 안내](https://www.postgresql.org/download/windows/)가 연결하는 [EDB 바이너리 배포](https://www.enterprisedb.com/download-postgresql-binaries)의 ZIP을 사용한다. 확인한 배포 링크 `fileid=1260609`는 `postgresql-18.6-5-windows-x64-binaries.zip`으로 연결됐다. 설치 스크립트는 확인한 최종 HTTPS URL과 다음 [배포자의 공식 저장소 검증값 답변](https://github.com/EnterpriseDB/edb-installers/issues/733#issuecomment-6012030716)을 고정한다.

```text
SHA-256: e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2
Archive bytes: 384620317
```

이는 Authenticode 서명 확인과 다르다. 바이너리가 서명되지 않았다는 한계를 남기며 Smart App Control·Defender 등 Windows 보호 정책을 해제하지 않는다. 해당 기기의 정책이 차단하면 우회 실행하지 않고 중단한다. pgAdmin/StackBuilder/설치 프로그램은 실행하지 않는다. DB 도구의 `bin/lib/share` 1,583개만 추출했고, 검증 영수증과 ZIP은 비공개 경로에 유지한다.

## 재현 도구

`scripts/prepare-beta-postgres.ps1`은 PowerShell 7/x64와 명시적 확인을 요구한다. 기존 NTFS 초기화 도구의 E/소유자/비공개 ACL 검사를 먼저 적용하며, 소유 증거 없는 경로를 채택하거나 권한을 자동 완화하지 않는다. 다운로드 길이/시간·SHA-256·ZIP 경로/링크/확장 한도·파일별 해시/ACL을 확인하고, 신규 단계 디렉터리를 덮어쓰기 없이 확정한다. 실패한 단계는 재귀 삭제·자동 재사용하지 않는다. 재실행은 ZIP과 1,583개 파일의 검증이며 `-VerifyOnly`는 미준비 경로에서 다운로드/초기화를 거부한다.

```powershell
pwsh -NoProfile -File scripts/prepare-beta-postgres.ps1 -Base E:/CarebridgeBeta -ConfirmPortableRuntime
pwsh -NoProfile -File scripts/prepare-beta-postgres.ps1 -Base E:/CarebridgeBeta -ConfirmPortableRuntime -VerifyOnly
```

`server/windows-postgres-check.mjs`는 실제 운영 시작 명령이 아니다. 준비된 도구와 새 UUID 경로만 허용하며 DB URL/기존 cluster/비밀번호/고정 포트/운영 활성화 인자를 받지 않는다. `--powershell`에는 **이 기기에 존재하는 PowerShell 7의 pwsh.exe 절대 경로**를 넣는다. 아래 `C:\Tools`는 경로 자리표시자다.

```powershell
npm run test:postgres:e-drive -- --base E:/CarebridgeBeta --powershell C:\Tools\PowerShell\pwsh.exe --confirm-synthetic-e-drive
```

생성 경로는 `private\checks\postgres-check-<UUID>`다. `source`, `restored`는 서로 새 cluster이며 별도 임의 시험 비밀번호를 사용한다. 앱 계정 대신 가상 역할을 넣고, 스키마/사본은 superuser·CREATEDB·CREATEROLE·replication·BYPASSRLS가 없는 **시험 소유자**로 다룬다. 운영 migration/runtime/backup 권한 분리 전체를 완료한 것은 아니다.

[initdb 공식 설명](https://www.postgresql.org/docs/18/app-initdb.html)에 따라 SCRAM, UTF8, checksum을 명시하고 동기화 생략 옵션을 쓰지 않는다. 이 Windows 기기에서는 libc 범주 `--locale=C`와 builtin 정렬 `--builtin-locale=C.UTF-8`을 분리했다. 서버의 실제 `data_directory`/버전/설정·직접 시작한 postmaster PID가 일치해야만 자료를 쓰며, 루프백 `127.0.0.1`만 사용한다. 외부 DB/상속 PG 환경변수·NODE_OPTIONS·임의 PATH는 사용하지 않는다. 종료는 자기 신규 cluster/PID만 확인해 [pg_ctl fast stop](https://www.postgresql.org/docs/18/app-pg-ctl.html)으로 수행한다.

## 이번 실행 결과

초기 성공 UUID `758d0d5d-55ea-4035-9b31-fbeaa4b53edb`, UTC `2026-10-06T16:13:39.116Z`. 이후 `checks` 권한을 쓰기 전 검사에 포함하고 새 UUID로 다시 9/9를 확인했다. **최종 UUID `8ffd8134-128d-4820-a031-f366c698c70d`, UTC `2026-10-06T16:20:55.061Z`**. 보고서 `test-results/windows-postgres-results.json`은 최종 실행이며 Git/정적 배포 제외 경로다. 반복 실행을 다른 종류의 18개 검사로 합산하지 않는다.

| 확인 | 실제 결과 |
| --- | --- |
| 공식 runtime·신규 경로 | ZIP 해시/파일 1,583개·NTFS 비공개 검사 후 실행, 기존 DB 채택 없음 |
| 실제 E 저장·인증/내구 설정 | PGDATA E 경로 확인, SCRAM의 잘못된 비밀번호 거부, checksum/fsync/synchronous_commit/full_page_writes on |
| 스키마 | 001~018 적용/체크섬·재실행 무변경, 기존 migration 파일 수정 없음 |
| 가상 서비스 데이터 | 한글 기록·공유 답변/철회·읽음·0/null/미완료 초안·격리된 실제 PNG 저장 |
| 원본 독립 재시작 | postmaster 종료→새 프로세스→전체 테이블 지문/원문·파일 바이트 재확인, 동일 발신 ID 재시도 무중복 |
| 암호화 묶음 | writer 종료 후 native custom dump·사진·삭제 fence 인증, 잘못된 키 거부 |
| 별도 신규 cluster 복원 | 전혀 새 DB/새 시험 자격증명에서 테이블/컬럼/trigger/migration·사진 크기/해시·fence 일치 |
| 복원 후 보호 | 보호자의 임상 원본 조회 거부, 불변 revision 수정 거부, 미완료 초안 공유 거부 |
| 복원 대상 재시작 | 대상도 종료→새 postmaster에서 자료/권한 검사 재확인, 원본 cluster 변경 없음 |

9/9 통과. 별도로 전용 확인 누락/드라이브 루트/미준비 verify-only의 실제 거부 3개, 최종 원본·대상·미디어·시험 루트 5경로의 NTFS 3주체 권한, 초기화 평문 비밀번호 임시 파일 0개·postgres 프로세스 0개를 확인했다. PowerShell AST, 신규 정책 계약 3개 포함 서버 회귀 **554/554**, 로컬 **87/87**, JS 구문·정적 빌드·diff 검사가 통과했다. 이번 UI 변경은 없으므로 과거 브라우저/실물 결과를 새 실행으로 표기하지 않는다.

`checks` 쓰기 전 권한 거부도 별도 합성 경로에서 실제 시험했다. 자기 새 빈 폴더에만 일반 Users 읽기 규칙을 추가하자 initializer가 거부했고, 소유 영수증과 추가 규칙을 자동 수정하지 않았다. 시험 경계/파일 목록·빈 디렉터리를 확인한 뒤 자기 영수증/빈 폴더만 PowerShell의 비재귀 삭제로 정리했다. 본래 E private 경로의 권한/자료는 그대로다.

최초 UUID `dcc40230-7a4d-4a3a-bc46-c4433a61f971`는 초기화 전에 실패했다. 당시에는 `--locale=C.UTF-8`을 전체 범주에 적용했다. 위처럼 Windows libc/builtin 범주를 분리한 새 실행은 성공했다. 최초 원시 오류를 저장하지 않았으므로 실패 원인을 오류 원문으로 단정하지 않는다. 초기 실패의 빈 진단 폴더를 채택/삭제하지 않고 남겼다.

최종 시험 DB/사진/사본도 **종료된 합성 진단 자료**로 남긴다. DB 평문 비밀번호·묶음 키는 기록/로그/소스에 남기지 않으며 시험 후 폐기한다(DB 내부의 시험 비밀번호 검증자는 별개). 따라서 남은 암호화 사본을 운영 백업이나 나중에 복원 가능한 사용자 사본으로 안내하지 않는다. 전용 runtime와 진단 자료는 E를 사용하지만 공개 `dist`에는 들어가지 않는다.

## 실제 자료 베타 전에 남은 필수 작업

1. 외부 보호자 접속 여부, 담당/참여자 확대·과거 열람·메시지 수정/삭제·보존/파기와 운영 책임을 확정한다.
2. 전용 서비스 OS 계정, DB migration/runtime/backup 권한, 키 보관·복구, 디스크 암호화·PC 물리 접근·전원/자동 재시작·감시를 준비한다. 현재 Windows 사용자·SYSTEM·관리자의 접근은 남아 있다.
3. **E와 분리된 독립 백업 매체**와 키 복구를 실제 검증한다. 같은 E의 새 cluster 복원은 별도 장애 도메인의 백업이 아니다. 백업 RPO(허용 손실)/RTO(복구 시간)와 담당자 승인도 필요하다.
4. 운영 DB role 복구·계정/초대/메일/복구, 최신 권한/삭제·엔진 원장 대조·격리 해제와 cutover를 확인한다. 기존 격리 모듈은 동일 cluster 대상만 지원하므로 **이번 별도 cluster 시험에 적용·검증했다고 하지 않는다**. 복원한 가상 사용자의 접근 시험은 내부 서비스 시험일 뿐 로그인/UI 인증 완료가 아니다.
5. 지속 파일 검사 엔진/정의·감독/감시·자원 한도와 실제 사진/영상 안전성 결합을 확인한다. 이번 사진은 `quarantined`이고 native AV/영상 디코딩·승인·제공을 완료하지 않았다.
6. 비API 준비 후 마지막 API·화면·실제 독립 기기의 로그인/수신/재시도/재접속과 P0 사람·실물 검증을 수행한다. 브라우저 자료는 승인된 귀속 매핑 전 자동 이동/삭제하지 않는다.

이 단계는 지속 저장·별도 cluster 복원의 **합성 실행 근거**다. 정상 종료 재시작이 전원 손실 내구성·사용자 PC의 운영 가용성·전체 국내 통제·법적 적합성 증거는 아니다. [전체 완료표](communication-acceptance.md)와 [BR-01~10 운영 게이트](recovery-readiness.md)는 여전히 진행 중이다.

2026-10-07 [v1 역할 분리](database-privilege-separation.md) 이후 최신 [v2 작업자 분리](database-worker-privileges.md)는 owner/runtime/최초 관리자/백업/worker의 opt-in 합성 검증 23개를 통과했다. 가상 준비 대역을 사용한 SQL/E 경계이며 실제 native 검사 승인 증거는 아니다. 전체 가상 파일 7개를 복원했고 일반 9개 모드도 UUID `f263cd5f-81d9-46d7-85b8-f019aa8a04df`, UTC `2026-10-07T03:28:20.246Z`로 다시 통과했다. 위 554개는 종전 기록이고 현재 서버 회귀는 585개다. 기존 DB/진단 cluster·SQL·운영 계정은 변경하지 않았으며 같은 E의 복원을 독립 백업으로 계산하지 않는다.

그다음 [실제 DB 연결 가드·작업자 조립](database-service-admission.md)은 같은 권한 v2에서 실제 연결의 반복 입장 검사와 조립된 영속 원장/가상 scanner·decoder 통신을 포함해 25개를 통과했다. 일반 9개는 UUID `a55dfa84-eda3-4a59-b81c-f7e3b9e3ba19`, UTC `2026-10-07T03:42:53.541Z`, 현재 서버 회귀는 599개다. 원인 미확정 중간 종료 경로는 PID가 현재 없음을 확인하고 별도 보존했다. 실제 native 엔진/운영 계정/서비스·독립 백업·안전한 cutover와 마지막 API는 여전히 미완료다.
