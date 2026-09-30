/**
 * @namespace webdataVcs
 * @version 1.0.0
 *
 * webdata VCS 플러그인 — 틀(skeleton)
 * ============================================================================
 * 개념 (dual-write 모델, 격리/오버레이 없음):
 *   - 사용자는 평소대로 웹데이터를 저장한다 → dev SAP master 에 그대로 반영(현행유지).
 *   - "활성 브랜치"가 있으면, 그 저장을 브랜치(로컬 IndexedDB)에도 함께 기록한다.
 *   - 브랜치 = "이 작업에서 내가 건드린 웹데이터의 최종 상태 목록"(add/modify/delete).
 *   - 배포 시 브랜치 ↔ 대상 master(dev/운영)를 비교해 선택 행만 push 한다.
 *
 * 구성:
 *   store    : IndexedDB 브랜치 저장 + localStorage 활성 포인터
 *   capture  : $u.webData 쓰기 함수 래핑 → 활성 브랜치에 이중 기록
 *   ui       : 브랜치 위젯(FAB) — 목록/활성전환/생성/삭제/export·import
 *   merge    : 브랜치 ↔ dest 비교/선택 push (compareWebData 자산 재활용 — TODO)
 *
 * 지원: 유니다큐5/6
 * ============================================================================
 */
const config = {
    version: '1.0.0',
    name: 'webdataVcs',
    description: 'unidocu webdata 브랜치/병합 (VCS) 플러그인',
    extraModules: []
};

// IndexedDB 키 네임스페이스. 한 브랜치를 레코드 하나로 저장한다(스켈레톤: 통짜 rewrite).
//   key  = 'webdataVcs::branch::<name>'
//   data = {name, base, createdAt, updatedAt, rows: { '<SCOPE>@<WEB_DATA_ID>': {op, SCOPE, WEB_DATA_ID, DATA} }}
const KEY_PREFIX = 'webdataVcs::branch::';
// 활성 브랜치 포인터 (git HEAD 역할). 브라우저 세션/새로고침 넘어 유지.
const ACTIVE_KEY = 'webdataVcs.activeBranch';

let $plugin;

$u.plugins.addPlugin(config.name, {
    config: config,
    uiExtensions: {
        floatingActions: [
            {
                id: 'webdataVcs',
                icon: 'fa fa-code-branch',
                label: 'webdata 브랜치',
                visible: () => true,
                onClick: () => $plugin.ui.openBranchPanel()
            }
        ]
    },
    init: (pluginHandlers) => {
        // 쓰기 함수 래핑은 한 번만. (dev 저장 → 활성 브랜치 이중 기록)
        $plugin.capture.wrap();
        $plugin.hooks(pluginHandlers);
    }
});

$plugin = {
    // ────────────────────────────────────────────────────────────────────
    // store : 브랜치 저장(IndexedDB) + 활성 포인터(localStorage)
    // ────────────────────────────────────────────────────────────────────
    store: (() => {
        let _db = null;
        const getDB = async () => {
            // checkpoint 플러그인이 쓰던 공용 IndexedDB 헬퍼 재사용.
            // TODO: connectIndexedDB()가 save(key,data)/getAll()/removeByPrefix(prefixes) 시그니처인지 실제 확인.
            if (!_db) _db = await $u.plugins.tools.connectIndexedDB();
            return _db;
        };

        return {
            // 활성 브랜치 이름 ('' = 없음, 평소처럼 dev 만 저장)
            getActive: () => {
                try {
                    return localStorage.getItem(ACTIVE_KEY) || '';
                } catch (e) {
                    return '';
                }
            },
            setActive: (name) => {
                try {
                    if (name) localStorage.setItem(ACTIVE_KEY, name);
                    else localStorage.removeItem(ACTIVE_KEY);
                } catch (e) {}
            },
            // 브랜치 전체 목록 (메타)
            list: async () => {
                const db = await getDB();
                const all = await db.getAll();
                return all.filter((it) => String(it.key).indexOf(KEY_PREFIX) === 0).map((it) => it.data);
            },
            get: async (name) => {
                const db = await getDB();
                const all = await db.getAll();
                const hit = all.find((it) => it.key === KEY_PREFIX + name);
                return hit ? hit.data : null;
            },
            save: async (branch) => {
                const db = await getDB();
                branch.updatedAt = $plugin.util.now();
                return db.save(KEY_PREFIX + branch.name, branch);
            },
            create: async (name, base) => {
                const branch = {name, base: base || null, createdAt: $plugin.util.now(), updatedAt: $plugin.util.now(), rows: {}};
                await $plugin.store.save(branch);
                return branch;
            },
            remove: async (name) => {
                const db = await getDB();
                // TODO: removeByPrefix 정확 시맨틱 확인 (정확 키 배열 vs 접두어)
                return db.removeByPrefix([KEY_PREFIX + name]);
            },
            // 한 행(변경분)을 활성 브랜치에 upsert 기록. op: 'upsert' | 'delete'
            putRow: async (name, row) => {
                const branch = (await $plugin.store.get(name)) || (await $plugin.store.create(name));
                const key = $plugin.util.rowKey(row.SCOPE, row.WEB_DATA_ID);
                branch.rows[key] = {op: row.op, SCOPE: row.SCOPE, WEB_DATA_ID: row.WEB_DATA_ID, DATA: row.DATA};
                return $plugin.store.save(branch);
            }
        };
    })(),

    // ────────────────────────────────────────────────────────────────────
    // capture : $u.webData 쓰기 함수 래핑 → 활성 브랜치에 이중 기록
    //   원본 동작(dev SAP 저장)은 그대로 두고, 성공 흐름에 "브랜치 기록"만 추가.
    // ────────────────────────────────────────────────────────────────────
    capture: {
        _wrapped: false,
        _orig: {},
        wrap: () => {
            if ($plugin.capture._wrapped) return;
            if (!$u.webData) return; // 아직 준비 전이면 스킵 (init 재호출 시 재시도)
            const wd = $u.webData;
            const orig = $plugin.capture._orig;
            const record = (rows) => {
                const active = $plugin.store.getActive();
                if (!active) return; // 활성 브랜치 없으면 기록 안 함 (= 현행유지)
                rows.forEach((r) => $plugin.store.putRow(active, r).catch(() => {}));
            };

            // createOrModifySingle(scope, web_data_id, data, callback)
            orig.createOrModifySingle = wd.createOrModifySingle;
            wd.createOrModifySingle = function (scope, web_data_id, data, callback) {
                record([{op: 'upsert', SCOPE: scope, WEB_DATA_ID: web_data_id, DATA: JSON.stringify(data)}]);
                return orig.createOrModifySingle.apply(wd, arguments);
            };

            // createOrModify(scope, web_data_id, data, callback)
            if (wd.createOrModify) {
                orig.createOrModify = wd.createOrModify;
                wd.createOrModify = function (scope, web_data_id, data, callback) {
                    record([{op: 'upsert', SCOPE: scope, WEB_DATA_ID: web_data_id, DATA: JSON.stringify(data)}]);
                    return orig.createOrModify.apply(wd, arguments);
                };
            }

            // createOrModifyByList(params, list, callback)  list=[{SCOPE, WEB_DATA_ID, DATA}]
            orig.createOrModifyByList = wd.createOrModifyByList;
            wd.createOrModifyByList = function (params, list, callback) {
                record((list || []).map((it) => ({op: 'upsert', SCOPE: it.SCOPE || (params && params.SCOPE), WEB_DATA_ID: it.WEB_DATA_ID, DATA: it.DATA})));
                return orig.createOrModifyByList.apply(wd, arguments);
            };

            // deleteByList(params, list, callback)
            orig.deleteByList = wd.deleteByList;
            wd.deleteByList = function (params, list, callback) {
                record((list || []).map((it) => ({op: 'delete', SCOPE: it.SCOPE || (params && params.SCOPE), WEB_DATA_ID: it.WEB_DATA_ID, DATA: null})));
                return orig.deleteByList.apply(wd, arguments);
            };

            $plugin.capture._wrapped = true;
        },
        // 원복 (테스트/비활성화용)
        unwrap: () => {
            if (!$plugin.capture._wrapped) return;
            Object.keys($plugin.capture._orig).forEach((k) => {
                $u.webData[k] = $plugin.capture._orig[k];
            });
            $plugin.capture._wrapped = false;
        }
    },

    // ────────────────────────────────────────────────────────────────────
    // merge : 브랜치 ↔ 대상 dest 비교/선택 push
    //   compareWebData(unidocu-debug)의 diffArrayData/markGridDiff/2-grid UI 재활용 예정.
    // ────────────────────────────────────────────────────────────────────
    merge: {
        // 대상 dest 전체를 읽어 브랜치와 비교할 raw rows 반환
        fetchDest: (destAlias) =>
            new Promise((resolve) => {
                // TODO: search-condition params + __DEST. 지금은 전체 selectList.
                $u.webData.selectList({__DEST: destAlias}, (rows) => resolve(rows || []));
            }),
        // 브랜치 rows(map) → [{SCOPE, WEB_DATA_ID, DATA, op}] 배열
        branchRows: (branch) => Object.keys(branch.rows || {}).map((k) => branch.rows[k]),
        // TODO: 브랜치 ↔ dest diff → 선택 UI → createOrModifyByList / deleteByList(__DEST=대상)
        open: async (branchName, destAlias) => {
            // 스켈레톤: 실제 비교 화면은 compareWebData 뼈대 이식 예정.
            const branch = await $plugin.store.get(branchName);
            if (!branch) return unidocuAlert('브랜치 없음: ' + branchName);
            unidocuAlert(`[TODO] '${branchName}' (${$plugin.merge.branchRows(branch).length}건) ↔ '${destAlias || 'dev'}' 비교 화면`);
        }
    },

    // ────────────────────────────────────────────────────────────────────
    // ui : 브랜치 위젯 (FAB → 다이얼로그)
    // ────────────────────────────────────────────────────────────────────
    ui: {
        openBranchPanel: async () => {
            const branches = await $plugin.store.list();
            const active = $plugin.store.getActive();
            // TODO: 그리드/버튼 UI 정식화 (지금은 목록·활성표시만 확인용)
            const lines = branches.length === 0 ? ['(브랜치 없음)'] : branches.map((b) => `${b.name === active ? '● ' : '○ '}${b.name} (${Object.keys(b.rows || {}).length}건)`);
            const msg = ['webdata 브랜치', '', ...lines, '', '활성: ' + (active || '(없음)')].join('\n');
            unidocuAlert(msg);
            // TODO: 생성/활성전환/삭제/export/import/병합 버튼 바인딩
        }
    },

    // 하위 어댑터 훅 (필요 시 렌더 타이밍 등에 개입)
    hooks: (pluginHandlers) => {
        // 예: afterRenderUIComponents 로 현재 활성 브랜치 배지 노출 (TODO)
        pluginHandlers.afterRenderUIComponents = () => {};
    },

    util: {
        rowKey: (scope, webDataId) => String(scope) + '@' + String(webDataId),
        now: () => new Date().toISOString()
    }
};
