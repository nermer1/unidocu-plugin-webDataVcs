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
        // 브랜치 위젯 (통합 모달): 체크아웃/생성 + 대상 비교(같은 창) + 행 클릭 시 JSON diff + 파일 내보내기
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
            const active = $plugin.store.getActive();
            const activeOptions = [{value: '', text: '(없음 — dev만 저장)'}].concat(
                branches.map((b) => ({value: b.name, text: b.name + ' [' + (b.dest || '?') + '] (' + Object.keys(b.rows || {}).length + '건)'}))
            );
            const dests = (typeof staticProperties !== 'undefined' && staticProperties.destinationAliases) || [];
            const defDest = curDest || dests[0] || '';
            const destOptions = dests.map((d) => ({value: d, text: d}));

            const $c = $(
                '<div style="min-width:720px">' +
                    '  <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">활성 브랜치 <span class="wv-active-holder"></span> <button class="unidocu-button wv-checkout">체크아웃</button> <button class="unidocu-button wv-delete">삭제</button>' +
                    '    &nbsp; 새 브랜치 <span class="wv-new-holder"></span> <button class="unidocu-button wv-create">생성</button></div>' +
                    '  <div style="color:#888;font-size:12px;margin-bottom:8px">현재 세션 dest: <b>' +
                    u.escapeHtml(curDest || '?') +
                    '</b> · 활성 브랜치가 있으면 저장 시 그 브랜치에도 함께 기록됩니다. (dev 저장은 평소대로)</div>' +
                    '  <hr>' +
                    '  <div style="display:flex;align-items:center;gap:6px;margin:6px 0">대상(master) <span class="wv-dest-holder"></span> <button class="unidocu-button wv-compare">비교</button> <span class="wv-info" style="color:#888;font-size:12px"></span></div>' +
                    '  <div class="wv-result" style="max-height:300px;overflow:auto;border:1px solid #ddd;padding:4px">비교를 눌러 대상과의 차이를 확인하세요. 행을 클릭하면 JSON 비교(좌 master / 우 브랜치)가 열립니다. (SAP에 쓰지 않고 파일로만 내보냅니다)</div>' +
                    '</div>'
            );

            // 활성 브랜치: Uni_Combo / 새 브랜치: Uni_InputText / 대상: Uni_Combo
            const $active = $u.createSingleInput({name: 'wvActiveBranch', type: 'Uni_Combo', options: activeOptions});
            $c.find('.wv-active-holder').append($active.$el);
            $active.setValue(active);

            const $newInput = $u.createSingleInput({name: 'wvNewBranch', type: 'Uni_InputText'});
            $c.find('.wv-new-holder').append($newInput.$el);

            const $dest = $u.createSingleInput({name: 'wvDest', type: 'Uni_Combo', options: destOptions});
            $c.find('.wv-dest-holder').append($dest.$el);
            if (defDest) $dest.setValue(defDest);

            let compareBranch = null; // 비교 중인 브랜치 객체 (JSON diff 편집 저장용)
            let destMap = {}; // key -> master DATA(string)
            let current = []; // diff 행

            const render = (rows) => {
                current = rows;
                if (!rows.length) {
                    $c.find('.wv-result').html('<div style="padding:8px">차이 없음</div>');
                    return;
                }
                const body = rows
                    .map(
                        (r, i) =>
                            '<tr class="wv-tr" data-idx="' +
                            i +
                            '" style="cursor:pointer">' +
                            '<td style="text-align:center"><input type="checkbox" class="wv-row" data-idx="' +
                            i +
                            '" checked></td>' +
                            '<td style="text-align:center">' +
                            u.escapeHtml(r.status) +
                            '</td>' +
                            '<td>' +
                            u.escapeHtml(r.SCOPE) +
                            '</td>' +
                            '<td>' +
                            u.escapeHtml(r.WEB_DATA_ID) +
                            '</td></tr>'
                    )
                    .join('');
                $c.find('.wv-result').html(
                    '<table style="width:100%;border-collapse:collapse">' +
                        '<thead><tr style="background:#f5f5f5">' +
                        '<th style="width:36px"><input type="checkbox" class="wv-all" checked></th><th style="width:64px">구분</th><th style="width:150px">SCOPE</th><th>WEB_DATA_ID</th>' +
                        '</tr></thead><tbody>' +
                        body +
                        '</tbody></table>'
                );
            };

            const doCompare = async () => {
                const bname = $active.getValue();
                if (!bname) return unidocuAlert('비교할 브랜치를 선택하세요.');
                compareBranch = await $plugin.store.get(bname);
                if (!compareBranch) return unidocuAlert('브랜치 없음: ' + bname);
                const dest = $dest.getValue();
                $u.webData.selectList({__DEST: dest}, (destRows) => {
                    destMap = {};
                    (destRows || []).forEach((r) => {
                        destMap[String(r.SCOPE) + '@' + String(r.WEB_DATA_ID)] = r.DATA;
                    });
                    render($plugin.merge.diff(compareBranch, destRows || []));
                    $c.find('.wv-info').text(bname + ' ↔ ' + (dest || 'dev') + ' : ' + current.length + '건 차이');
                });
            };

            // 행 클릭 → JSON diff (좌 master / 우 브랜치, 우측 편집=최종본 B → 브랜치에 저장)
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
                    parse(destMap[key]), // 좌 = master (A)
                    parse(r.DATA), // 우 = 브랜치 (C)
                    () => {}, // save left: master 안 고침 (no-op)
                    (edited) => {
                        // save right: 편집본을 브랜치 최종값(B)으로 저장
                        const dataStr = JSON.stringify(edited);
                        r.DATA = dataStr;
                        if (compareBranch && compareBranch.rows && compareBranch.rows[key]) {
                            compareBranch.rows[key].DATA = dataStr;
                            $plugin.store.save(compareBranch);
                        }
                    }
                );
            };

            const doExport = () => {
                const idxs = $c
                    .find('.wv-row:checked')
                    .map(function () {
                        return parseInt($(this).data('idx'), 10);
                    })
                    .get();
                if (!idxs.length) return unidocuAlert('선택된 항목이 없습니다.');
                const rows = idxs.map((i) => current[i]).map((r) => ({SCOPE: r.SCOPE, WEB_DATA_ID: r.WEB_DATA_ID, op: r.op, DATA: r.DATA}));
                const bname = $active.getValue() || 'branch';
                const payload = {_type: 'webdataVcs-merge', branch: bname, dest: $dest.getValue(), exportedAt: u.now(), rows: rows};
                u.downloadJSON('webdataVcs_' + bname + '_' + u.ts() + '.json', payload);
            };

            u.modal({
                title: 'webdata 브랜치 / 병합',
                width: 780,
                $content: $c,
                buttons: [{text: '선택 항목 파일로 내보내기', cls: 'unidocu-button blue', onClick: doExport}]
            });

            $c.on('click', '.wv-checkout', () => {
                const n = $active.getValue();
                $plugin.store.setActive(n);
                unidocuAlert('체크아웃(활성): ' + (n || '(없음)'));
            });
            $c.on('click', '.wv-delete', () => {
                const n = $active.getValue();
                if (!n) return unidocuAlert('삭제할 브랜치를 선택하세요.');
                unidocuConfirm('브랜치 "' + n + '" 를 삭제할까요? (되돌릴 수 없음)', async () => {
                    await $plugin.store.remove(n);
                    if ($plugin.store.getActive() === n) $plugin.store.setActive(''); // 활성이면 해제
                    const idx = activeOptions.findIndex((o) => o.value === n);
                    if (idx >= 0) activeOptions.splice(idx, 1);
                    $active.setOptions(activeOptions, '');
                    $active.setValue('');
                    unidocuAlert('삭제됨: ' + n);
                });
            });
            $c.on('click', '.wv-create', async () => {
                const n = String($newInput.getValue() || '').trim();
                if (!n) return unidocuAlert('이름을 입력하세요.');
                await $plugin.store.create(n);
                $plugin.store.setActive(n);
                if (!activeOptions.some((o) => o.value === n)) activeOptions.push({value: n, text: n + ' (0건)'});
                $active.setOptions(activeOptions, n);
                $active.setValue(n);
                $newInput.setValue('');
                unidocuAlert('브랜치 생성 + 체크아웃: ' + n);
            });
            $c.on('click', '.wv-compare', doCompare);
            $c.on('change', '.wv-all', function () {
                $c.find('.wv-row').prop('checked', $(this).prop('checked'));
            });
            $c.on('click', '.wv-tr', function (e) {
                if ($(e.target).is('.wv-row')) return; // 체크박스 클릭은 diff 안 염
                openRowDiff(parseInt($(this).data('idx'), 10));
            });
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
