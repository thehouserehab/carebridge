# Windows 복구 키 보관 준비 — 운영 키 미발급

2026-10-07. E 드라이브 실제 자료 베타를 위한 **내부 저장 구성요소와 합성 검증**이다. Windows 계정·운영 키·실제 자료·API·외부 접속·유료 자원을 활성화하지 않았다. 사용자 답변상 독립 백업 매체는 아직 없으며 실제 자료 운영 전환은 보류한다.

## 구현과 보안 경계

- `WindowsRecoveryKeyStore`는 호출자가 제공한 32바이트 복구 키만 저장/재읽기한다. 키 생성·교체·내보내기·삭제·스케줄러·HTTP 기능은 없다. 기존 `recovery-bundle.mjs`의 키 형식을 그대로 사용한다.
- Windows DPAPI의 **CurrentUser**만 사용한다. LocalMachine으로 실패를 우회하지 않는다. 키 ID·목적·버전·생성 시각·현재 SID를 추가 entropy에 포함해 암호문을 다른 ID/시각으로 재표기한 읽기를 거부한다. 추가 entropy는 비밀 비밀번호가 아니라 메타데이터 결합값이다.
- 운영 경로는 명시적 E 기반의 `private/secrets/recovery-keys`로 고정하며 이번에 만들지 않았다. 합성 시험만 `private/checks/key-check-<UUID>`를 사용한다. 키 이름은 UUID `.dpapi`, 내용은 제한된 크기의 메타데이터와 DPAPI 암호문이다. SID는 비공개 메타데이터이며 공개 보고서에 복사하지 않는다.
- 공통 `scripts/beta-storage-policy.ps1`에서 정상 고정 NTFS E, 전체 디렉터리 체인의 링크/접합점 부재, private 소유 영수증, 현재 사용자·SYSTEM·Administrators 3개 권한과 소유자를 검사한다. private 루트는 상속 차단이어야 한다. 키 디렉터리는 전용 영수증을 확인하며 기존 무소유 경로·권한 확대를 자동 채택/수정하지 않는다. 초기화 도구도 이 정책을 재사용한다.
- 키 파일은 단일 정상 파일·크기 상한·핸들/경로의 동일성을 검사한다. 독점 신규 생성과 파일 flush를 사용하며 덮어쓰기를 거부한다. 쓰기 결과가 불확실하면 기존 ID/부분 파일을 자동 삭제·재발급하지 않는다. Windows 디렉터리 fsync/갑작스러운 정전 내구성을 보장한 것은 아니다.
- 고정 PowerShell 스크립트를 프로필/쉘 없이 실행하며 키는 길이 제한된 비공개 stdin/stdout 파이프로만 전달한다. argv·환경변수·앱 로그에 넣지 않는다. 환경은 Windows 필수 항목으로 제한하며 DB 비밀·NODE_OPTIONS·사용자 PATH/PSModulePath를 상속하지 않는다. 프레임 상한·엄격한 UTF-8/정확한 스키마·시간 제한·종료 확인·고정 오류를 사용한다.
- Node 호출자는 반환된 키 Buffer를 사용 후 `finally`에서 0으로 덮어써야 한다. 내부 바이트 버퍼도 정리하지만 JavaScript/.NET 문자열·GC·OS 덤프·같은 사용자 권한의 다른 프로그램까지 완전한 메모리 소거를 보장하지 않는다. 실행 파일/프로젝트 코드는 신뢰한 운영자 설정 경계이며 공개 요청에서 경로를 받아서는 안 된다.

DPAPI는 보통 같은 사용자 자격/기기의 보호에 연결되지만 roaming profile 등 예외가 있다. CurrentUser는 **앱별 격리나 같은 사용자 프로세스·관리자로부터의 보호가 아니다**. LocalMachine이면 같은 기기의 다른 사용자도 복호화할 수 있으므로 선택하지 않았다. [Microsoft DPAPI 설명](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)

## 재현과 이번 증거

PowerShell 7 Windows 실행 파일의 신뢰된 절대 경로를 명시한다. 일반 서버 테스트는 E에 키를 만들지 않는다.

```powershell
npm run test:recovery-keys:e-drive -- --base E:/CarebridgeBeta --powershell <pwsh.exe의_절대_경로> --confirm-synthetic-key-store
```

최신 성공 UUID `73b6bce4-74ee-4ae7-81b0-a5c07fd68b37`, UTC `2026-10-07T02:38:21.692Z`. 보고서는 Git/정적 배포 제외 `test-results/windows-recovery-key-results.json`에 성공 여부·사례명·UUID만 저장하며 키·SID·암호문·원시 오류는 넣지 않는다.

| 실제 Windows/E 검증 | 결과 |
| --- | --- |
| CurrentUser 암호문 저장·새 Node/PowerShell 프로세스 재읽기 | 통과. 평문 키/그 base64·hex가 저장 JSON에 없는 것도 확인 |
| 동일 ID 덮어쓰기 거부·원래 암호문 불변 | 통과 |
| scope/SID/시각 변경·암호문 변조·평문 위장·다른 ID에 복사 | 모두 거부 |
| 중복 JSON 속성·hardlink 키 파일 | 복호화 전 거부 |
| 키 파일/키 루트에 Users 읽기 권한 추가 | 읽기/쓰기 거부, 자동 권한 복구 없음. 시험 도구만 자기 추가 규칙을 제거하고 정상 재읽기 확인 |
| 무소유 기존 경로·정상 저장소를 향한 junction | 채택/쓰기 거부, 대상 파일 미생성 |
| provider 직접 LocalMachine·입력 잘림/뒤에 덧붙임/중복 속성·boolean schema/배열 scope | stdout 없음·비밀 없는 고정 오류로 거부 |
| 새 프로세스의 키 재읽기 → 기존 암호화 묶음 전체 인증/내용 확인 | 통과. 내용은 **합성 표식이며 실제 PG dump/DB 복원이 아님** |

합계 13개 상위 사례다. 정책/프로토콜 단위 10개 포함 서버 회귀 564개, 로컬 회귀 87개를 실행해 통과했다. UI/브라우저/실물 기기 시험을 이번에 다시 한 것으로 집계하지 않는다. PowerShell 4개 AST·JS 구문/정적 빌드, 기존 private 영수증 불변과 PostgreSQL 도구 1,583개 해시 재검증도 통과했다. 공통 초기화 정책은 새 합성 경로 생성/재사용·영수증 불변·확인 누락/드라이브 루트 거부를 실제 실행했고 자기 영수증과 빈 시험 디렉터리만 정리했다.

최초 시험은 PowerShell 응답 헤더의 배열/비트 연산 우선순위 오류로 0개 완료 후 실패했다. 숫자 바이트별 대입으로 수정하고 12개 성공 후 junction/직접 입력을 추가한 최신 13개를 재실행했다. 실패 UUID `461d0547-592f-447f-ae68-9f48e4b32595`에는 소유 영수증만 남았으며 키 파일은 없다. 불확실 실패 자원을 자동 채택/삭제하지 않는다.

최신 성공 실행의 자기 합성 키·암호화 묶음과 시험용 junction/권한 규칙만 검증 후 정리했다. 개별 파일 삭제·빈 UUID 디렉터리 삭제만 사용했고 재귀 삭제나 기존 E 자료 변경은 없다. 폐기한 합성 키/사본은 운영 복구 수단으로 사용할 수 없다.

## 실제 자료 전환 전에 남은 사항

1. **독립 매체와 독립 키 복구**: E와 분리된 승인 매체/기기의 암호화 사본, Windows 프로필/OS/기기 상실 때 사용할 별도 키 회수·복구, 담당자와 실제 복원 시험이 필요하다. 이 키 파일을 E에 보관하는 것만으로 해당 게이트를 통과하지 않는다. 평문 키 파일/메일·메신저 전송으로 대체하지 않는다.
2. **운영 계정/권한**: 전용 Windows 서비스 계정과 최소 DB migration/runtime/bootstrap/backup 권한, 관리자의 PC 접근·로그/덤프·보호 설정. 현재 Windows 사용자로 확인한 시험을 전용 계정/다른 사용자 거부의 실제 증거로 확대하지 않는다.
3. **운영 복구**: 최신 삭제·권한·세션/초대·검사 원장의 cutover 대조, 감시/경보·RPO/RTO·사본 보관/파기 책임. 자동 재시작·실제 운영 백업 명령은 아직 없다.
4. **마지막 API·기기/사람 검증**: 실제 인증된 센터/치료사/보호자의 대화·기록·사진/영상·재접속. 외부 접속 범위도 미확정이며 공개하지 않는다.

[전체 완료표](communication-acceptance.md)·[복구 게이트 BR-01~10](recovery-readiness.md)·[E 저장](local-beta-storage.md)을 함께 따른다. 국내 디스크/DPAPI 사용만으로 전체 국내 통제·법적 적합성·실제 베타 준비 완료를 선언하지 않는다.

## 이번 변경 파일

- 내부 모듈: `server/windows-recovery-key-store.mjs`, `server/windows-recovery-key-policy.mjs`.
- Windows 보호 제공자/공통 정책: `scripts/windows-recovery-key-provider.ps1`, `scripts/beta-storage-policy.ps1`; 기존 `scripts/initialize-beta-storage.ps1`은 공통 정책을 사용하도록 변경.
- 검증: `server/windows-recovery-key-check.mjs`, `server/tests/windows-recovery-key-policy.test.mjs`, `server/tests/windows-recovery-key-fixture.ps1`; 루트 `package.json`의 명시적 합성 시험 명령 추가.
- 상태 문서: 이 문서, README, `docs/local-beta-storage.md`, `docs/communication-acceptance.md`, `docs/recovery-readiness.md`, `docs/server-foundation.md`.

의존성·SQL·인증/세션 정책·서비스 UI·기존 임상 자료/브라우저 저장소·GitHub/Vercel 배포는 변경하지 않았다. 일반 빌드는 공개 UI 자산만 만들고 서버·키/영수증·시험 결과를 포함하지 않는다.

마지막 확인에서 공개 `dist`는 허용한 UI 자산 32개뿐이며 운영 `private/secrets`는 비어 있다. 성공한 합성 시험 경로는 정리됐고 최초 실패의 영수증 전용 경로만 남았다. PostgreSQL 프로세스는 실행 중이지 않으며 기존 종료 DB를 시작하거나 변경하지 않았다.
