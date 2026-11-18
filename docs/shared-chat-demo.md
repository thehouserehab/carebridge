# 웹 공용 대화 시연

`/chat/`는 치료사와 보호자가 서로 다른 브라우저에서 가상 메시지를 주고받는 화면이다. 기존 브라우저 저장소의 예시 대화와 별개이며, 예시 기록이나 첨부를 자동 업로드하지 않는다.

## 시연 순서

1. 운영자가 준비한 가상 치료사·보호자 계정을 사용한다. 비밀번호는 소스·보고서·URL에 넣지 않는다.
2. 일반 Chrome 창에서 치료사로, 새 시크릿 창 또는 다른 브라우저에서 보호자로 `/chat/`에 로그인한다. 같은 일반 창의 탭들은 로그인 쿠키를 공유한다.
3. 시연 아동의 대화방에서 가상 메시지를 전송하고 반대편 화면의 수신을 확인한다. 화면이 표시되는 동안 약 5초 간격으로 새 소식을 확인한다.
4. 반대 계정으로 답장하고 새로고침한다. 로그아웃 후 다시 로그인해도 권한이 유지되는 계정은 저장된 대화를 읽을 수 있다.
5. 전송 결과를 받지 못하면 입력을 유지한다. 안내된 재전송은 같은 요청 번호를 사용하여 메시지 중복 저장을 방지한다.

메시지는 공용 PostgreSQL에 저장한다. 브라우저 저장소에 비밀번호·세션 토큰·메시지 전체를 저장하지 않는다. 로그인 세션은 최대 1시간이며 로그아웃 시 서버에서도 폐기한다. 메시지 조회·쓰기마다 계정, 센터 소속, 대화 참가 권한을 확인한다. 역할을 선택하는 기존 화면만으로는 공용 대화 권한을 얻을 수 없다.

## 서버 구성

- 화면: `shared-chat.html`, `src/shared-chat*.js`, `src/shared-chat.css`
- 전용 API: `api/chat/[...path].js`, `server/web-chat-http.mjs`
- 공용 DB 연결: `server/web-chat-runtime.mjs`; 기존 `Auth`, `Conversations`, `Children` 서비스 사용
- 일회성 준비: `server/web-chat-setup.mjs`; 빈 전용 DB 확인 후 기존 23개 마이그레이션·DB 권한·가상 계정 생성

| Production 환경변수 | 용도 |
| --- | --- |
| `CAREBRIDGE_WEB_CHAT_ENABLED` | `true`일 때 공용 대화 API와 빌드된 홈의 대화 진입을 활성화 |
| `CAREBRIDGE_CHAT_DATABASE_URL` | 전용 런타임 SQL 역할의 연결 비밀값. DB 소유자 자격증명을 사용하지 않음 |
| `CAREBRIDGE_CHAT_CENTER_ID` | 서버가 허용하는 가상 센터 ID |
| `CAREBRIDGE_CHAT_DATABASE_CA` | 공급자 공식 공개 CA가 필요한 경우에만 설정. TLS 인증서 검증은 항상 유지 |
| `CAREBRIDGE_WEB_ORIGINS` | 기존 AI와 공유하는 허용 HTTPS origin 목록 |

마이그레이션이나 계정 생성은 웹 요청·서버 시작 시 자동으로 수행하지 않는다. 함수 인스턴스는 DB 연결 풀만 재사용하고 계정·세션·메시지의 원본은 DB에 둔다. 런타임 역할은 비소유자·비관리자이며 검토된 기존 권한표를 따른다. Supabase의 브라우저용 API 역할에는 Carebridge 테이블·함수 접근을 부여하지 않고 테이블 RLS를 활성화한다. 앱의 사용자 간 권한은 기존 서버 서비스에서 검증한다.

## 검증과 한계

관련 검사는 `node --test tests/web-chat-http.test.mjs tests/shared-chat-client.test.mjs`와 `node --test server/tests/web-chat-setup.test.mjs`이다. SQL 검사는 서버 개발 의존성이 필요하다. `tests/shared-chat-browser.mjs`는 독립된 두 브라우저 컨텍스트에서 송수신·새로고침·응답 유실 시 재전송·PC 및 모바일 배치를 확인한다. 가상 HTTP 응답 검사와 실제 배포 DB 검증 결과는 별도로 기록한다.

이번 연결은 **가상 자료의 텍스트 대화 시연**이다. 사진·영상 전송, 실제 기관 계정 가입·초대, 기록과 일정의 기기 간 동기화는 이 대화 화면에 연결하지 않았다. 기존 홈 AI는 별도 AI 체험 코드로 계속 이용한다. 무료 DB의 휴면·용량 제한과 운영 백업, 실제 개인정보 운영 준비는 별도 검토 대상이다.
