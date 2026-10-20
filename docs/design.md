# webdataVcs 설계 기준 (v2)

git의 개념을 webdata에 1:1로 대응시킨다. 용어와 흐름은 git(IntelliJ git UI)과 맞추고, 다른 점은 명시한다.

## 1. git ↔ webdataVcs 매핑

| git | webdataVcs | 동작 |
|---|---|---|
| remote | **대상 dest** (보통 운영) | push 시 선택 |
| 작업 공간 | **개발 SAP** (공유) | 평소 저장 → 그대로 반영 (현행 유지) |
| branch | **작업 브랜치** | 생성 시 개발 dest 바인딩 |
| checkout | **기록 대상 전환** | 데이터는 안 바뀜, 이후 저장이 기록될 브랜치만 바뀜 |
| commit | **저장 시 자동 기록** | 행별 최종값만 유지 (저장 단위 log는 v1 제외) |
| merge-base | **최초 기록 시점의 개발 원래 값** | 해당 행 첫 저장 시 1회 `selectOne`, 신규 행은 base 없음 |
| push | **대상에 반영** | 행별 3-way 판정 → 확인 → 반영 |
| merge conflict | **같은 항목을 양쪽이 다르게 변경** | Accept Yours / Accept Theirs / Merge (3-pane, 결과 편집 가능) |
| format-patch / am | **파일 내보내기 / 파일 업로드** (내부명 patch) | 파일에 base + 내 값 포함 → 받는 쪽에서 3-way |
| revert | **반영 되돌리기** | 반영 직전 대상 값으로 역적용, 반영 이후 대상이 또 바뀌었으면 경고 |
| pull | (범위 밖) | 운영 → 개발 동기화는 기존 compareWebData 담당 |

### git과 다른 점

- **checkout**: 개발 SAP는 여럿이 공유하는 작업 공간이라 데이터를 바꿀 수 없다. 체크아웃은 "앞으로 내 저장을 이 브랜치에 기록"한다는 뜻만 가진다. (그래서 dual-write)
- **base가 개발 기준**: base(개발, 내가 고치기 전)에는 동료의 미반영 변경이 섞여 있을 수 있다. 3-way 병합은 base 대비 **내가 바꾼 항목만** 대상에 적용하므로, 동료 변경은 대상으로 나가지 않는다. (= 스코핑)

```
base(개발)  = {k1: X(동료),  k2: 원래}
내 값       = {k1: X(동료),  k2: 내수정}
운영        = {k1: 운영값,   k2: 원래}
→ 결과      = {k1: 운영값,   k2: 내수정}
```

- **patch**: 비교 결과가 아니라 base + 내 값을 담는다. 비교 없이 내보낼 수 있고, 반영 측(대상 세션)에서 직접 push와 동일한 3-way 화면이 뜬다. 직접 반영과 patch 반영은 같은 코어를 쓴다.

## 2. 행별 3-way 판정

| 조건 | 판정 | 처리 |
|---|---|---|
| 대상 = 내 값 | ⚪ 동일 | 제외 |
| 대상 = base | 🟢 변경 / 신규 / 삭제 | 내 값 반영 |
| 셋 다 다름, 서로 다른 항목만 변경 | 🔵 자동병합 | 병합값 반영 (확인 가능) |
| 셋 다 다름, 같은 항목 충돌 | 🔴 충돌 | 해결해야 반영 가능 |
| DATA가 JSON 아님 | 줄 단위 비교 | 위와 동일 규칙 |

- JSON 비교는 키 순서 무시 (의미 비교).
- 여러 브랜치는 순차 반영으로 해결: A 반영 후 B를 반영하면 B는 A가 반영된 대상 기준으로 판정된다.

## 3. 저장소 (플러그인 자체 모듈)

어댑터 `connectIndexedDB`(단일 store, 버전 고정)로는 다중 store·스키마 버전·다중 store 트랜잭션이 불가하여 플러그인이 IndexedDB를 직접 관리한다. 어댑터 헬퍼는 범용 키-값(checkpoint 등)용으로 유지.

DB `webdataVcs@<사이트 키>` (v1) — 사이트 키 = 세션 dest 이름 + SAP 지문(`jco.client` 호스트/시스템번호/클라이언트). IndexedDB가 origin(프로토콜+도메인+포트) 단위라 같은 주소에서 여러 업체를 띄워도 업체(SAP 시스템)별로 DB를 분리

| store | 키 | 내용 |
|---|---|---|
| `branches` | 브랜치명 | dest, createdAt, updatedAt |
| `changes` | [branch, `SCOPE@WEB_DATA_ID`] | SCOPE, WEB_DATA_ID, **base**, **mine**, op, firstAt, lastAt / 인덱스: branch |
| `pushes` | 자동 id | branch, target dest, at, via(direct\|patch), rows[{key, before, after}] (before = 백업 겸 revert 원본) |

- 활성 브랜치(체크아웃): localStorage `webdataVcs.activeBranch@<사이트 키>`
- 기존 `webdataVcsDB` 테스트 데이터는 이관하지 않는다.

## 4. 라이브러리 (플러그인 번들)

| 라이브러리 | 용도 |
|---|---|
| CodeMirror 5 + merge 애드온 (+ diff-match-patch) | 3-pane 충돌 해결 UI (mustacheEditor와 동일 버전) |

- CodeMirror는 mustacheEditor와 중복 번들한다. 필요해지면 공용 플러그인으로 분리한다.
- 3-way 판정·병합은 자체 구현(`src/merge3.js`, 객체는 키 단위, 배열은 요소 단위(공통 ID 필드로 짝 맞춤 → 없으면 같은 길이일 때 위치별 → 아니면 통째), 원시값은 통째 비교). jsondiffpatch는 3-way 병합을 제공하지 않고 revert도 백업값 재기록으로 충분해 쓰지 않는다.

## 4-1. base 캡처 타이밍

어댑터 `afterWebDataWrite` 훅은 실제 쓰기 **직전**에 동기로 불린다. base를 비동기로 읽으면 쓰기 요청이 먼저 나가 base에 내 값이 담길 수 있으므로, 브랜치에 아직 없는 행은 훅 안에서 **동기 selectOne**(`ZUNIECM_WEB_DATA` MODE selectOne, 원문 DATA)으로 원래 값을 읽는다. 이미 기록된 행 판정은 메모리 키 집합(체크아웃 시 로드)으로 동기 처리한다.

## 5. 화면 (IntelliJ git UI 패턴)

| 화면 | IntelliJ 대응 | 내용 |
|---|---|---|
| A. 브랜치 팝업 | 우하단 브랜치 위젯 | 현재 브랜치·dest·건수 / 새 브랜치, Push..., Patch 반영..., 반영 이력 / 로컬 브랜치 서브메뉴(체크아웃·변경 보기·Push·Patch 내보내기·삭제) |
| 변경 보기 | Commit 창 Changes | 신규/변경/삭제 목록, 클릭 시 base↔내 값 읽기 전용 diff |
| B. Push 다이얼로그 | Push + Conflicts 합침 | 대상 선택 → 행별 판정(충돌/자동병합/변경/신규/삭제/대상 유지/동일), 충돌·대상 유지 행은 한 줄씩([브랜치][대상][병합...] / [브랜치로 덮어쓰기]) + 나머지는 접힌 묶음, [Push(충돌 N건 남음)]. 파일 내보내기는 브랜치 메뉴에만 (충돌은 업로드 쪽에서 해결) |
| C. 3-pane 병합 | Merge Revisions | 좌 내 값 / 가운데 결과(편집) / 우 대상, 덩어리 가져오기 |
| D. 반영 이력 | Git log | 반영 건별 행, [되돌리기] |

- Patch 반영은 B 화면을 그대로 쓴다 (소스만 브랜치 → 파일).

## 5-1. 옵션 (config extraPlugins)

```js
{ name: 'webdataVcs', options: { patch: true, captureScopes: ['approval', 'grid'] } }
```

| 키 | 기본값 | 설명 |
|---|---|---|
| `dryRun` | `true` | 테스트 모드. SAP에 쓰지 않고 반영될 내용을 파일(`webdataVcs-push-preview`)로 저장, 이력 기록 없음. `false`여야 실제 반영. **기본 켜짐 유지(확정)** — 실제 반영이 필요한 곳만 config에 `dryRun: false` 등록 |
| `patch` | `false` | 망분리 현장용. `true`면 [파일 내보내기] / [파일 업로드...] 메뉴 노출 |
| `captureScopes` | (전체) | 지정한 SCOPE만 브랜치에 기록 |

## 6. 유지 / 추가 / 교체

- **유지**: 저장 캡처(어댑터 `afterWebDataWrite` 훅), 대상 쓰기 API(`createOrModifyByList` / `deleteByList` + `__DEST`), 키 단위 `selectOne` 조회
- **추가**: base 기록, 3-way 판정, 충돌 해결, 반영 이력·백업·revert, patch 반영
- **교체**: 모달 UI → IntelliJ git UI 패턴 (2단계에서 설계)

## 범위 밖 (v1)

- 저장 단위 커밋 log
- pull (운영 → 개발)
- 다중 브랜치 동시 병합 (순차 반영으로 대체)
