# webdataVcs

unidocu webdata 를 git 처럼 브랜치로 관리하고, 운영 반영 시 선택 병합하는 플러그인.

## 모델 (dual-write)

- 사용자는 **평소대로** 웹데이터를 저장한다 → dev SAP master 반영(현행유지).
- **활성 브랜치**가 있으면, 그 저장을 브랜치(로컬 IndexedDB)에도 함께 기록한다.
- 브랜치 = "이 작업에서 내가 건드린 웹데이터의 최종 상태 목록" (add/modify/delete).
- 배포 시 **브랜치 ↔ 대상 master(dev/운영)** 를 비교해 **선택 행만** push.
- 격리(read overlay) 없음 — 화면은 늘 SAP master 를 그대로 읽는다.

## 구성 (src/main.js)

| 모듈 | 역할 |
|---|---|
| `store` | IndexedDB 브랜치 저장 + localStorage 활성 포인터(HEAD) |
| `capture` | `$u.webData` 쓰기 함수 래핑 → 활성 브랜치에 이중 기록 |
| `merge` | 브랜치 ↔ dest 비교/선택 push (compareWebData 자산 재활용 — TODO) |
| `ui` | 브랜치 위젯(FAB): 목록/활성전환/생성/삭제/export·import |

## 전송 (운영 반영)

- **직접 push**: 로컬이 대상 SAP 에 붙을 때 → `createOrModifyByList` / `deleteByList` (`__DEST`)
- **파일 경유**: 안 붙을 때 → 브랜치 `.json` export → 대상 쪽에서 import 후 push

## 빌드

```bash
npm ci
npm run build   # webpack → dist/plugin.js (UMD)
```

## 배포

- Jenkins (`Jenkinsfile`) → NAS `<PLUGIN_ARTIFACT_DIR>/webdataVcs/<version>/plugin.js`
- 헬퍼 마켓(JJServer) 카탈로그 등록으로 다운로드/설치

## 상태

초기 골격(skeleton). `store`/`capture` 기본 배선 완료, `ui`/`merge` 는 TODO 스텁.
