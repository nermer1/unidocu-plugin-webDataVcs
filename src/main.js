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
        // 어댑터($uPlugins)가 webData 쓰기 시 발사하는 훅으로 캡처.
        // (플러그인이 $u.webData를 직접 patch하지 않음 — 오버라이드는 어댑터 소관)
        pluginHandlers.afterWebDataWrite = (fn, args) => $plugin.capture.record(fn, args);
    }
});

$plugin = {
    // ────────────────────────────────────────────────────────────────────
    // store : 브랜치 저장(IndexedDB) + 활성 포인터(localStorage)
    // ────────────────────────────────────────────────────────────────────
    store: (() => {
        let _db = null;
        const getDB = async () => {
            // 공용 IndexedDB 헬퍼($u.plugins.tools.connectIndexedDB) 재사용.
            // API: save(key,data) / getAll()->[{key,data,savedAt}] / removeByPrefix(prefix|정확키배열) / load / remove / getByPrefix / clear
            // 기본은 expireAfter=86400000(24h) → getAll이 만료본을 거르고 connect 시 cleanup이 삭제함(임시복구용).
            // 브랜치는 장기 보존이라 반드시 expireAfter:0(무만료) + 전용 DB/스토어로 연결.
            // (전용 이름 필수: 기본 이름이면 checkpoint가 먼저 연 24h 커넥션이 캐시로 물려와 옵션이 무시됨)
            if (!_db) _db = await $u.plugins.tools.connectIndexedDB('webdataVcsDB', 'branches', {expireAfter: 0});
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
            // 현재 세션이 바라보는 SAP dest
            currentDest: () => (typeof staticProperties !== 'undefined' && staticProperties.destinationAlias) || '',
            // 활성 브랜치의 origin dest ≠ 현재 세션 dest 면 활성 해제(체크아웃 풀기). 불일치 정보 반환(없으면 false)
            //   → 다른 SAP 시스템에서 딴 브랜치에 엉뚱한 데이터가 섞이는 것 방지
            guardActiveDest: async () => {
                const active = $plugin.store.getActive();
                if (!active) return false;
                const branch = await $plugin.store.get(active);
                const cur = $plugin.store.currentDest();
                if (branch && branch.dest && cur && branch.dest !== cur) {
                    $plugin.store.setActive(''); // 없음으로 되돌림
                    return {name: active, branchDest: branch.dest, cur: cur};
                }
                return false;
            },
            create: async (name, base) => {
                const branch = {
                    name,
                    base: base || null,
                    dest: $plugin.store.currentDest(),
                    createdAt: $plugin.util.now(),
                    updatedAt: $plugin.util.now(),
                    rows: {}
                };
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
    // capture : 어댑터 afterWebDataWrite 훅 핸들러 → 활성 브랜치에 이중 기록
    //   dev 저장(원본 동작)은 어댑터가 그대로 실행하고, 우리는 "브랜치 기록"만 담당.
    //   fn  : 'createOrModifySingle'|'createOrModify'|'createOrModifyByList'|'deleteByList'
    //   args: 원본 호출 인자 (단건: [scope, web_data_id, data, cb] / 배치: [params, list, cb])
    // ────────────────────────────────────────────────────────────────────
    capture: {
        record: async (fn, args) => {
            const active = $plugin.store.getActive();
            if (!active) return; // 활성 브랜치 없으면 기록 안 함 (= 현행유지)

            const a = Array.prototype.slice.call(args || []);
            let params = {};
            let rows = [];
            if (fn === 'createOrModifySingle' || fn === 'createOrModify') {
                rows = [{op: 'upsert', SCOPE: a[0], WEB_DATA_ID: a[1], DATA: JSON.stringify(a[2])}];
            } else if (fn === 'createOrModifyByList') {
                params = a[0] || {};
                rows = (a[1] || []).map((it) => ({op: 'upsert', SCOPE: it.SCOPE || params.SCOPE, WEB_DATA_ID: it.WEB_DATA_ID, DATA: it.DATA}));
            } else if (fn === 'deleteByList') {
                params = a[0] || {};
                rows = (a[1] || []).map((it) => ({op: 'delete', SCOPE: it.SCOPE || params.SCOPE, WEB_DATA_ID: it.WEB_DATA_ID, DATA: null}));
            } else {
                return;
            }

            // 크로스-dest 쓰기(__DEST 지정)는 캡처 제외 — compare/menu/merge push 되먹임 방지
            if (params && params.__DEST) return;

            // 스코프 allow-list: config.captureScopes 있으면 그 스코프만, 없으면 전체 (편집한 것만 담기니 자연히 좁혀짐)
            const allow = ($u.plugins.getOptions(config.name) || {}).captureScopes;
            const targets = Array.isArray(allow) && allow.length > 0 ? rows.filter((r) => allow.indexOf(r.SCOPE) !== -1) : rows;
            if (!targets.length) return;

            // dest 바인딩: 활성 브랜치가 다른 SAP dest에서 만든 거면 → 체크아웃 해제 + 경고, 이 저장은 기록 안 함
            const mismatch = await $plugin.store.guardActiveDest();
            if (mismatch) {
                unidocuAlert(
                    '활성 브랜치 "' +
                        mismatch.name +
                        '"는 [' +
                        mismatch.branchDest +
                        '] 기준입니다.\n' +
                        '현재 세션 dest [' +
                        mismatch.cur +
                        ']가 달라 체크아웃을 해제했습니다.\n' +
                        '(이 저장은 브랜치에 기록되지 않았습니다 — dev 저장은 정상)'
                );
                return;
            }

            targets.forEach((r) => $plugin.store.putRow(active, r).catch(() => {}));
        }
    },

    // ────────────────────────────────────────────────────────────────────
    // merge : 브랜치 ↔ 대상 dest 비교/선택 push
    //   compareWebData(unidocu-debug)의 diffArrayData/markGridDiff/2-grid UI 재활용 예정.
    // ────────────────────────────────────────────────────────────────────
    merge: {
        // 브랜치 rows(map) → [{op, SCOPE, WEB_DATA_ID, DATA}] 배열
        branchRows: (branch) => Object.keys(branch.rows || {}).map((k) => branch.rows[k]),

        // 대상 dest에서 "브랜치가 건드린 SCOPE만" selectList 병렬 조회 → 브랜치 키에 해당하는 행만 반환
        //   (전체 4441행 selectList 대신 건드린 스코프만 → 성능. __DEST+SCOPE 필터는 compareWebData가 쓰는 검증된 경로)
        //   destRows [{SCOPE, WEB_DATA_ID, DATA}] — 대상에 존재하는 브랜치 키만
        fetchDestRows: (branch, dest) => {
            const rows = $plugin.merge.branchRows(branch);
            const scopes = Array.from(new Set(rows.map((r) => String(r.SCOPE))));
            const wantKeys = new Set(rows.map((r) => String(r.SCOPE) + '@' + String(r.WEB_DATA_ID)));
            const fetchScope = (scope) =>
                new Promise((resolve) => {
                    let done = false;
                    const finish = (arr) => {
                        if (!done) {
                            done = true;
                            resolve(arr || []);
                        }
                    };
                    try {
                        $u.webData.selectList({__DEST: dest, SCOPE: scope}, (arr) => finish(arr));
                    } catch (e) {
                        finish([]);
                    }
                    setTimeout(() => finish([]), 20000); // hang 방지
                });
            return Promise.all(scopes.map(fetchScope)).then((lists) => {
                const out = [];
                lists.forEach((list) => {
                    (list || []).forEach((r) => {
                        if (wantKeys.has(String(r.SCOPE) + '@' + String(r.WEB_DATA_ID))) out.push({SCOPE: r.SCOPE, WEB_DATA_ID: r.WEB_DATA_ID, DATA: r.DATA});
                    });
                });
                return out;
            });
        },

        // DATA 의미 비교: 객체 키 순서/공백 차이는 무시(배열 순서·값은 유지).
        //   SAP가 저장값을 재직렬화(키 순서/스페이싱 변경)해 돌려줘도 "변경" 오탐이 나지 않게.
        sameData: (a, b) => {
            if (a === b) return true;
            if (a == null || b == null) return a === b;
            const canon = (v) => {
                if (Array.isArray(v)) return v.map(canon);
                if (v && typeof v === 'object')
                    return Object.keys(v)
                        .sort()
                        .reduce((o, k) => ((o[k] = canon(v[k])), o), {});
                return v;
            };
            try {
                return JSON.stringify(canon(JSON.parse(a))) === JSON.stringify(canon(JSON.parse(b)));
            } catch (e) {
                return a === b;
            }
        },

        // 브랜치 ↔ 대상 dest 비교 → 표시할 diff 행 [{status, op, SCOPE, WEB_DATA_ID, DATA}]
        //   추가: dest에 없음 / 변경: dest와 DATA 다름(의미 기준) / 삭제: dest에 있는 걸 지움 / (동일은 스킵)
        diff: (branch, destRows) => {
            const map = {};
            (destRows || []).forEach((r) => {
                map[String(r.SCOPE) + '@' + String(r.WEB_DATA_ID)] = r.DATA;
            });
            const out = [];
            $plugin.merge.branchRows(branch).forEach((row) => {
                const key = String(row.SCOPE) + '@' + String(row.WEB_DATA_ID);
                const has = Object.prototype.hasOwnProperty.call(map, key);
                if (row.op === 'delete') {
                    if (has) out.push({status: '삭제', op: 'delete', SCOPE: row.SCOPE, WEB_DATA_ID: row.WEB_DATA_ID, DATA: null});
                    return;
                }
                if (!has) out.push({status: '추가', op: 'upsert', SCOPE: row.SCOPE, WEB_DATA_ID: row.WEB_DATA_ID, DATA: row.DATA});
                else if (!$plugin.merge.sameData(map[key], row.DATA))
                    out.push({status: '변경', op: 'upsert', SCOPE: row.SCOPE, WEB_DATA_ID: row.WEB_DATA_ID, DATA: row.DATA});
            });
            return out;
        }
    },

    // ────────────────────────────────────────────────────────────────────
    // ui : 브랜치 위젯 (FAB → 다이얼로그)
    // ────────────────────────────────────────────────────────────────────
    ui: {
        // 브랜치 위젯 (git branch 스타일): 브랜치 리스트(● 작업중, 클릭=전환) + [운영 반영] 비교·반영.
        openBranchPanel: async () => {
            const u = $plugin.util;
            // 진입 시 dest 가드: 활성 브랜치가 다른 SAP dest 것이면 체크아웃 해제 + 경고
            const mismatch = await $plugin.store.guardActiveDest();
            if (mismatch) {
                unidocuAlert(
                    '활성 브랜치 "' + mismatch.name + '"는 [' + mismatch.branchDest + '] 기준이라 현재 세션 [' + mismatch.cur + ']에서 체크아웃을 해제했습니다.'
                );
            }
            const curDest = $plugin.store.currentDest();
            const branches = await $plugin.store.list();
            const dests = (typeof staticProperties !== 'undefined' && staticProperties.destinationAliases) || [];
            const defDest = curDest || dests[0] || '';
            const destOptions = dests.map((d) => ({value: d, text: d}));

            // diff 결과 그리드 (checkpoint 패턴: customWebDataMap 헤더 등록 → unidocu-grid div → renderUIComponents → getGrid)
            const gridId = 'webdataVcs-diff-grid';
            $u.webData.customWebDataMap[gridId + '@GRIDHEADER'] = {
                OS_DATA: {IGN_GRID_PANEL: '1'}, // 체크바 없음 — 리뷰 전용 목록 (선택 개념 제거)
                OT_DATA: [
                    {FNAME: 'status', FNAME_TXT: '구분', WIDTH: '70', ALIGN: 'center'},
                    {FNAME: 'SCOPE', FNAME_TXT: 'SCOPE', WIDTH: '150'},
                    {FNAME: 'WEB_DATA_ID', FNAME_TXT: 'WEB_DATA_ID', WIDTH: '300'}
                ]
            };

            const $c = $(
                '<div style="min-width:700px">' +
                    // 브랜치 헤더 + 더보기
                    '<div style="display:flex;align-items:center;margin-bottom:4px">' +
                    '  <b style="flex:1">브랜치 <span class="wv-head" style="font-weight:normal;font-size:12px"></span></b>' +
                    '  <button class="unidocu-button wv-toggle-more">⋯</button>' +
                    '</div>' +
                    // 브랜치 리스트 (git branch 스타일)
                    '<div class="wv-branch-list" style="border:1px solid #e3e3e3;border-radius:4px;max-height:150px;overflow:auto;margin-bottom:6px"></div>' +
                    // 새 브랜치 + 세션 dest
                    '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">새 브랜치 <span class="wv-new-holder"></span> <button class="unidocu-button wv-create">생성</button>' +
                    '  <span style="flex:1;text-align:right;color:#888;font-size:12px">세션 dest: <b>' +
                    u.escapeHtml(curDest || '?') +
                    '</b></span></div>' +
                    // 더보기 패널 (숨김)
                    '<div class="wv-more-panel" style="display:none;background:#f6f6f6;border:1px solid #e3e3e3;border-radius:4px;padding:8px;margin-bottom:6px">' +
                    '  <button class="unidocu-button wv-history">배포 이력 / 복원</button> ' +
                    '  <button class="unidocu-button wv-backup-export">백업 내보내기</button> ' +
                    '  <span style="color:#aaa;font-size:12px">(준비 중)</span>' +
                    '</div>' +
                    '<hr>' +
                    // 운영 반영
                    '<div style="margin-bottom:4px"><b>운영 반영</b> &nbsp;&nbsp; 소스: ' +
                    '  <label style="margin-right:8px"><input type="radio" name="wvSrc" class="wv-src" value="branch" checked> 브랜치</label>' +
                    '  <label><input type="radio" name="wvSrc" class="wv-src" value="file"> 파일</label>' +
                    '</div>' +
                    '<div style="display:flex;align-items:center;gap:6px;margin:6px 0">대상 <span class="wv-dest-holder"></span> <button class="unidocu-button wv-compare">비교</button> <span class="wv-info" style="color:#888;font-size:12px"></span></div>' +
                    '<div class="wv-result" style="color:#888;font-size:12px;margin:4px 0">작업 브랜치 체크아웃 후 [비교]를 누르세요. (행 클릭 → 변경 내용 보기)</div>' +
                    '<div id="' +
                    gridId +
                    '" class="unidocu-grid" data-sub-group="' +
                    gridId +
                    '" data-sub-id="GRIDHEADER" style="height:260px"></div>' +
                    '</div>'
            );

            // 새 브랜치: Uni_InputText / 대상: Uni_Combo
            const $newInput = $u.createSingleInput({name: 'wvNewBranch', type: 'Uni_InputText'});
            $c.find('.wv-new-holder').append($newInput.$el);

            const $dest = $u.createSingleInput({name: 'wvDest', type: 'Uni_Combo', options: destOptions, useEmptyOption: true});
            $c.find('.wv-dest-holder').append($dest.$el);
            if (defDest) $dest.setValue(defDest);

            // 전환/삭제 피드백용 경량 토스트 (코어에 toast 없음 → 직접). "됐다"는 명시 신호.
            let _toastTimer = null;
            const showToast = (msg) => {
                let $t = $('#wv-toast');
                if (!$t.length) {
                    $t = $('<div id="wv-toast"></div>')
                        .css({
                            position: 'fixed',
                            left: '50%',
                            bottom: '48px',
                            transform: 'translateX(-50%)',
                            background: 'rgba(33,37,41,.92)',
                            color: '#fff',
                            padding: '8px 16px',
                            borderRadius: '6px',
                            fontSize: '13px',
                            zIndex: 2147483647,
                            pointerEvents: 'none',
                            boxShadow: '0 4px 14px rgba(0,0,0,.25)',
                            transition: 'opacity .2s'
                        })
                        .appendTo('body');
                }
                $t.text(msg).css('opacity', '1');
                clearTimeout(_toastTimer);
                _toastTimer = setTimeout(() => {
                    $t.css('opacity', '0');
                    setTimeout(() => $t.remove(), 250);
                }, 1600);
            };

            // 브랜치 리스트 렌더 (● = 현재/HEAD, [체크아웃] 버튼으로 명시적 전환, × 삭제. 행 전체 클릭은 액션 없음)
            const renderBranchList = () => {
                const act = $plugin.store.getActive();
                const esc = u.escapeHtml;
                // 상단 "현재 브랜치" 표시 (git status bar 느낌 — 전환하면 여기가 바로 바뀜)
                $c.find('.wv-head').html(act ? '현재: <b style="color:#1971c2">● ' + esc(act) + '</b>' : '현재: <span style="color:#888">작업 안 함</span>');
                const nameRow = (name, dest, count, date, on) =>
                    '<div class="wv-brow" style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid #f0f0f0;' +
                    (on ? 'background:#eaf4ff;' : '') +
                    '">' +
                    '<span style="width:12px;text-align:center;color:' +
                    (on ? '#1971c2' : '#bbb') +
                    '">' +
                    (on ? '●' : '○') +
                    '</span>' +
                    '<span style="flex:1;min-width:0"><b>' +
                    esc(name) +
                    '</b> ' +
                    '<span style="color:#888;font-size:12px">[' +
                    esc(dest || '?') +
                    '] · ' +
                    count +
                    '건 · ' +
                    esc(u.shortDate(date)) +
                    '</span></span>' +
                    (on
                        ? '<span style="color:#1971c2;font-size:12px;font-weight:bold;padding:0 6px">현재</span>'
                        : '<button class="unidocu-button wv-checkout" data-name="' + esc(name) + '">체크아웃</button>') +
                    '<button class="unidocu-button wv-brow-del" data-name="' +
                    esc(name) +
                    '" title="삭제" style="color:#c92a2a">×</button>' +
                    '</div>';
                const noneRow = (on) =>
                    '<div class="wv-brow" style="display:flex;align-items:center;gap:8px;padding:5px 8px;' +
                    (on ? 'background:#eaf4ff;' : '') +
                    '">' +
                    '<span style="width:12px;text-align:center;color:' +
                    (on ? '#1971c2' : '#bbb') +
                    '">' +
                    (on ? '●' : '○') +
                    '</span>' +
                    '<span style="flex:1;color:#888">작업 안 함 — dev만 저장</span>' +
                    (on
                        ? '<span style="color:#1971c2;font-size:12px;font-weight:bold;padding:0 6px">현재</span>'
                        : '<button class="unidocu-button wv-checkout" data-name="">이걸로</button>') +
                    '</div>';
                const list = branches.map((b) => nameRow(b.name, b.dest, Object.keys(b.rows || {}).length, b.updatedAt, b.name === act)).join('');
                $c.find('.wv-branch-list').html(list + noneRow(!act));
            };

            let compareBranch = null; // 비교 중인 브랜치 객체 (JSON diff 편집 저장용)
            let destMap = {}; // key -> master DATA(string)
            let current = []; // diff 행 (op/DATA 포함 — export·rowDiff용)
            let gridObj = null; // diff 결과 그리드

            const render = (rows) => {
                current = rows;
                $c.find('.wv-result').text(rows.length ? rows.length + '건 차이 (행 클릭 → 변경 내용 보기)' : '차이 없음');
                // 그리드엔 표시 컬럼만. op/DATA는 current에 보관. (체크바 없음 → 리뷰 목록)
                if (gridObj) gridObj.setJSONData(rows.map((r) => ({status: r.status, SCOPE: r.SCOPE, WEB_DATA_ID: r.WEB_DATA_ID})));
            };

            const doCompare = async () => {
                const bname = $plugin.store.getActive();
                if (!bname) return unidocuAlert('작업 브랜치를 먼저 체크아웃하세요 (리스트에서 [체크아웃]).');
                compareBranch = await $plugin.store.get(bname);
                if (!compareBranch) return unidocuAlert('브랜치 없음: ' + bname);
                const dest = $dest.getValue();
                $c.find('.wv-info').text('비교 중…');
                // 전체 selectList 대신 "브랜치 키만" 병렬 selectOne → 필요한 행만 (성능)
                const destRows = await $plugin.merge.fetchDestRows(compareBranch, dest);
                destMap = {};
                destRows.forEach((r) => {
                    destMap[String(r.SCOPE) + '@' + String(r.WEB_DATA_ID)] = r.DATA;
                });
                render($plugin.merge.diff(compareBranch, destRows));
                $c.find('.wv-info').text(bname + ' ↔ ' + (dest || 'dev') + ' : ' + current.length + '건 차이');
            };

            // 행 클릭 → JSON diff 리뷰 (좌 운영 / 우 브랜치, read-only — 빨강=운영·초록=브랜치)
            //   코어 jsonDiffDialog는 save left/right 버튼이 하드코딩이라, 저장 콜백 no-op + 버튼 숨김으로 보기전용화.
            const openRowDiff = (i) => {
                const r = current[i];
                if (!r) return;
                const key = String(r.SCOPE) + '@' + String(r.WEB_DATA_ID);
                const parse = (s) => {
                    try {
                        return s ? JSON.parse(s) : {};
                    } catch (e) {
                        return {};
                    }
                };
                $u.dialog.jsonDiffDialog.open(
                    parse(destMap[key]), // 좌 = 운영(master)
                    parse(r.DATA), // 우 = 브랜치
                    () => {}, // save left: no-op
                    () => {} // save right: no-op (편집 저장 안 함 — 리뷰 전용)
                );
                // read-only: 코어 다이얼로그의 save 버튼 숨김 (편집/저장 개념 제거)
                try {
                    const $dlg = $('#containerLeft').closest('.ui-dialog');
                    $dlg.find('.ui-dialog-buttonpane button').each(function () {
                        if (/save/i.test($(this).text())) $(this).hide();
                    });
                } catch (e) {}
            };

            // 내보내기 = 비교된 변경 내역 전체 (브랜치 통째 배포 모델 — 선택 개념 없음)
            const doExport = () => {
                if (!current.length) return unidocuAlert('내보낼 변경 내역이 없습니다. 먼저 [비교]를 실행하세요.');
                const rows = current.map((r) => ({SCOPE: r.SCOPE, WEB_DATA_ID: r.WEB_DATA_ID, op: r.op, DATA: r.DATA}));
                const bname = $plugin.store.getActive() || 'branch';
                const payload = {_type: 'webdataVcs-merge', branch: bname, dest: $dest.getValue(), exportedAt: u.now(), rows: rows};
                u.downloadJSON('webdataVcs_' + bname + '_' + u.ts() + '.json', payload);
            };

            // 운영에 직접 반영(push) — 아직 미구현 스텁 (배포 스냅샷+부분반영 예정)
            const doDeploy = () => {
                unidocuAlert(
                    '운영에 직접 반영(push)은 준비 중입니다.\n현재는 [파일로 내보내기]로 release 파일을 받아 적용하세요.\n(반영 시 운영 자동백업·부분반영 예정)'
                );
            };

            u.modal({
                title: 'webdata 브랜치',
                width: 760,
                $content: $c,
                buttons: [
                    {text: '파일로 내보내기', cls: 'unidocu-button', onClick: doExport},
                    {text: '운영에 반영', cls: 'unidocu-button blue', onClick: doDeploy}
                ]
            });

            // 모달이 DOM에 올라간 뒤 그리드 렌더 (헤더는 위에서 customWebDataMap 등록됨)
            $u.renderUIComponents($c);
            renderBranchList();
            gridObj = $u.gridWrapper.getGrid(gridId);
            if (gridObj) {
                try {
                    gridObj._rg.setCheckBar({visible: false}); // 체크바 확실히 제거 (리뷰 전용 — SELECTED_OPTIONS 제거만으론 안 사라질 수 있음)
                } catch (e) {}
                gridObj.setJSONData([]);
                gridObj.onCellClick((columnKey, rowIndex) => {
                    const key = String(gridObj.$V('SCOPE', rowIndex)) + '@' + String(gridObj.$V('WEB_DATA_ID', rowIndex));
                    const idx = current.findIndex((r) => String(r.SCOPE) + '@' + String(r.WEB_DATA_ID) === key);
                    if (idx >= 0) openRowDiff(idx);
                });
            }

            // 더보기 토글 + 스텁
            $c.on('click', '.wv-toggle-more', () => $c.find('.wv-more-panel').toggle());
            $c.on('click', '.wv-history', () => unidocuAlert('배포 이력 / 복원 — 준비 중'));
            $c.on('click', '.wv-backup-export', () => unidocuAlert('백업 내보내기 — 준비 중'));
            // 운영 반영 소스: 파일은 아직 미구현 → 브랜치로 되돌림
            $c.on('change', '.wv-src', function () {
                if ($(this).val() === 'file') {
                    unidocuAlert('파일로 반영(import)은 준비 중입니다. 지금은 브랜치 기준만 됩니다.');
                    $c.find('.wv-src[value="branch"]').prop('checked', true);
                }
            });

            // 브랜치 리스트: [체크아웃] 버튼 = 명시적 전환, × = 삭제 (행 전체 클릭은 액션 없음)
            $c.on('click', '.wv-checkout', function (e) {
                e.stopPropagation();
                const n = String($(this).attr('data-name') || '');
                $plugin.store.setActive(n); // '' 이면 작업 안 함
                renderBranchList();
                showToast(n ? '“' + n + '” 체크아웃됨' : '작업 안 함으로 전환됨');
            });
            $c.on('click', '.wv-brow-del', function (e) {
                e.stopPropagation();
                const n = String($(this).attr('data-name') || '');
                if (!n) return;
                unidocuConfirm('브랜치 "' + n + '" 를 삭제할까요? (되돌릴 수 없음)', async () => {
                    await $plugin.store.remove(n);
                    if ($plugin.store.getActive() === n) $plugin.store.setActive(''); // 활성이면 해제
                    const idx = branches.findIndex((b) => b.name === n);
                    if (idx >= 0) branches.splice(idx, 1);
                    renderBranchList();
                    showToast('“' + n + '” 삭제됨');
                });
            });
            $c.on('click', '.wv-create', async () => {
                const n = String($newInput.getValue() || '').trim();
                if (!n) return unidocuAlert('이름을 입력하세요.');
                if (branches.some((b) => b.name === n)) return unidocuAlert('이미 있는 브랜치명입니다.');
                const b = await $plugin.store.create(n);
                $plugin.store.setActive(n);
                branches.push(b);
                $newInput.setValue('');
                renderBranchList();
                showToast('“' + n + '” 생성 · 체크아웃됨');
            });
            $c.on('click', '.wv-compare', doCompare);
        }
    },

    util: {
        rowKey: (scope, webDataId) => String(scope) + '@' + String(webDataId),
        now: () => new Date().toISOString(),
        // 파일명용 타임스탬프 (yyyyMMdd_HHmmss)
        ts: () => {
            const d = new Date();
            const p = (n) => String(n).padStart(2, '0');
            return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        },
        // 리스트 표시용 짧은 날짜 (MM/DD HH:mm). 값 없거나 파싱 실패하면 ''.
        shortDate: (iso) => {
            if (!iso) return '';
            const d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            const p = (n) => String(n).padStart(2, '0');
            return p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
        },
        escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]),
        // JSON 객체를 파일로 다운로드 (브라우저)
        downloadJSON: (filename, obj) => {
            try {
                const blob = new Blob([JSON.stringify(obj, null, 2)], {type: 'application/json'});
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => {
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                }, 0);
            } catch (e) {
                unidocuAlert('파일 내보내기 실패: ' + (e && e.message));
            }
        },
        // 공용 모달 (checkpoint의 $u.baseDialog 패턴 재사용). opts:{title,width,$content,buttons:[{text,cls,onClick}]}
        modal: (opts) => {
            const buttons = (opts.buttons || []).map((b) =>
                $u.baseDialog.getButton(
                    b.text,
                    () => {
                        if (b.onClick) b.onClick();
                    },
                    b.cls || 'unidocu-button'
                )
            );
            return $u.baseDialog.openModalDialog(opts.$content, {
                title: opts.title || '',
                buttons: buttons,
                width: String(opts.width || 640),
                draggable: true,
                resizable: true
            });
        }
    }
};
