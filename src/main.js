/**
 * @namespace webdataVcs
 * @version 1.0.0
 *
 * webdata를 git처럼 관리하는 플러그인 — 설계 기준: docs/design.md
 * ============================================================================
 *   branch   : 작업 브랜치 (IndexedDB). checkout = 이후 저장을 기록할 브랜치 전환 (데이터는 안 바뀜)
 *   commit   : webdata 저장 시 자동 기록 (행별 최종값 mine)
 *   base     : 행이 브랜치에 처음 기록될 때의 개발 원래 값 (merge-base)
 *   push     : 대상 dest에 행별 3-way 판정 → 충돌 해결 → 반영 (반영 직전 대상 값을 이력에 백업)
 *   patch    : base + mine 을 파일로 내보내고, 받는 쪽에서 같은 3-way 화면으로 반영
 *   revert   : 반영 이력의 before 값으로 역적용
 *
 * 구성:
 *   capture  : 어댑터 afterWebDataWrite 훅 → 활성 브랜치에 기록 (base는 동기 selectOne)
 *   remote   : ZUNIECM_WEB_DATA 원문 조회 (dest 지정)
 *   sync     : 판정(review) / 반영(apply) / 되돌리기(revert) / patch
 *   ui       : 브랜치 팝업 · 변경 보기 · Push · 3-pane 병합 · 반영 이력
 * ============================================================================
 */
import CodeMirror from 'codemirror';
import 'codemirror/mode/javascript/javascript';
import 'codemirror/addon/merge/merge';
import 'codemirror/lib/codemirror.css';
import 'codemirror/addon/merge/merge.css';
import 'codemirror/theme/idea.css';
import merge3 from './merge3';
import store from './store';

const config = {
    version: '1.0.0',
    name: 'webdataVcs',
    description: 'unidocu webdata 브랜치/병합 (VCS) 플러그인',
    extraModules: []
};

const RFC = 'ZUNIECM_WEB_DATA';
const PATCH_TYPE = 'webdataVcs-patch';

// 판정 → 표시 (뱃지 문구/색)
const BADGE = {
    conflict: ['충돌', 'danger'],
    auto: ['자동병합', 'accent'],
    add: ['신규', 'success'],
    modify: ['변경', 'success'],
    delete: ['삭제', 'del'],
    keep: ['대상 유지', 'keep'],
    same: ['동일', 'muted']
};

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
                onClick: () => $plugin.ui.branchPopup()
            }
        ]
    },
    init: (pluginHandlers) => {
        // 어댑터가 webData 쓰기 직전에 동기로 발사하는 훅 (플러그인이 $u.webData를 직접 patch하지 않음)
        pluginHandlers.afterWebDataWrite = (fn, args) => $plugin.capture.record(fn, args);
        $plugin.capture.load();
    }
});

$plugin = {
    // ────────────────────────────────────────────────────────────────────
    // capture : 저장 → 활성 브랜치에 기록
    // ────────────────────────────────────────────────────────────────────
    capture: {
        // 활성 브랜치의 dest와 이미 기록된 키 (훅 안에서 동기 판단용)
        known: {branch: '', dest: '', keys: {}},

        load: async () => {
            const name = $plugin.util.getActive();
            const k = {branch: '', dest: '', keys: {}};
            if (name) {
                const b = await store.branches.get(name);
                if (b) {
                    k.branch = name;
                    k.dest = b.dest || '';
                    (await store.changes.list(name)).forEach((c) => (k.keys[c.key] = true));
                } else {
                    $plugin.util.setActive(''); // 지워진 브랜치를 가리키면 해제
                }
            }
            $plugin.capture.known = k;
            return k;
        },

        // 저장 직전 원래 값 (동기). 훅 안에서 비동기로 읽으면 쓰기 요청이 먼저 나가 base에 내 값이 담길 수 있음
        readBaseSync: (scope, id) => {
            const os = $nst.is_data_os_data(RFC, {MODE: 'selectOne', SCOPE: scope, WEB_DATA_ID: id});
            return os && os.DATA ? String(os.DATA) : null;
        },

        // fn  : 'createOrModifySingle'|'createOrModify'|'createOrModifyByList'|'deleteByList'
        // args: 원본 인자 (단건: [scope, web_data_id, data, cb] / 배치: [params, list, cb])
        record: (fn, args) => {
            const active = $plugin.util.getActive();
            if (!active) return; // 활성 브랜치 없으면 기록 안 함 (= 현행유지)

            const a = Array.prototype.slice.call(args || []);
            const toRaw = (d) => (d == null ? null : typeof d === 'string' ? d : JSON.stringify(d));
            let params = {};
            let rows = [];
            if (fn === 'createOrModifySingle' || fn === 'createOrModify') {
                rows = [{SCOPE: a[0], WEB_DATA_ID: a[1], mine: JSON.stringify(a[2])}];
            } else if (fn === 'createOrModifyByList') {
                params = a[0] || {};
                rows = (a[1] || []).map((it) => ({SCOPE: it.SCOPE || params.SCOPE, WEB_DATA_ID: it.WEB_DATA_ID, mine: toRaw(it.DATA)}));
            } else if (fn === 'deleteByList') {
                params = a[0] || {};
                rows = (a[1] || []).map((it) => ({SCOPE: it.SCOPE || params.SCOPE, WEB_DATA_ID: it.WEB_DATA_ID, mine: null}));
            } else {
                return;
            }

            // 다른 dest로 쓰기(__DEST) = push/revert 되먹임 → 기록 안 함
            if (params && params.__DEST) return;

            // 스코프 allow-list: config.captureScopes 있으면 그 스코프만
            const allow = ($u.plugins.getOptions(config.name) || {}).captureScopes;
            const targets = Array.isArray(allow) && allow.length ? rows.filter((r) => allow.indexOf(r.SCOPE) !== -1) : rows;
            if (!targets.length) return;

            const known = $plugin.capture.known;
            const loaded = known.branch === active;
            // dest 바인딩: 다른 SAP dest에서 만든 브랜치면 체크아웃 해제 (이 저장은 기록 안 함)
            const cur = $plugin.util.currentDest();
            if (loaded && known.dest && cur && known.dest !== cur) {
                $plugin.util.setActive('');
                $plugin.capture.load();
                unidocuAlert(
                    '브랜치 "' +
                        active +
                        '"는 [' +
                        known.dest +
                        '] 기준이라 현재 세션 [' +
                        cur +
                        ']에서 체크아웃을 해제했습니다.\n(이 저장은 브랜치에 기록되지 않았습니다)'
                );
                return;
            }

            const now = $plugin.util.now();
            targets.forEach((r) => {
                const key = $plugin.util.rowKey(r.SCOPE, r.WEB_DATA_ID);
                const rec = {key: key, SCOPE: r.SCOPE, WEB_DATA_ID: r.WEB_DATA_ID, mine: r.mine};
                // 처음 기록되는 행만 base 조회 (이미 있는 행은 store가 기존 base 유지)
                if (!(loaded && known.keys[key])) {
                    try {
                        rec.base = $plugin.capture.readBaseSync(r.SCOPE, r.WEB_DATA_ID);
                    } catch (e) {
                        rec.baseUnknown = true;
                    }
                    if (loaded) known.keys[key] = true;
                }
                store.changes.upsert(active, rec, now).catch((e) => console.error('[webdataVcs] 기록 실패', key, e));
            });
        }
    },

    // ────────────────────────────────────────────────────────────────────
    // remote : 대상 dest 원문 조회 (실패는 "행 없음"이 아니라 오류로 처리 — 잘못된 반영 방지)
    // ────────────────────────────────────────────────────────────────────
    remote: {
        readOne: (dest, scope, id) =>
            new Promise((resolve, reject) => {
                const p = {MODE: 'selectOne', SCOPE: scope, WEB_DATA_ID: id};
                if (dest) p.__DEST = dest;
                let fin = false;
                const timer = setTimeout(() => {
                    if (fin) return;
                    fin = true;
                    reject(new Error('조회 시간 초과: ' + scope + '@' + id));
                }, 30000);
                $nst.is_data_nsReturn(
                    RFC,
                    p,
                    (ns) => {
                        if (fin) return;
                        fin = true;
                        clearTimeout(timer);
                        const os = ns.getExportMap('OS_DATA');
                        resolve(os && os.DATA ? String(os.DATA) : null);
                    },
                    (err) => {
                        if (fin) return;
                        fin = true;
                        clearTimeout(timer);
                        reject(err || new Error('조회 실패: ' + scope + '@' + id));
                    }
                );
            }),

        // rows[{key,SCOPE,WEB_DATA_ID}] → {key: 원문|null}, 동시 6건
        readMany: async (dest, rows) => {
            const out = {};
            const queue = rows.slice();
            const worker = async () => {
                while (queue.length) {
                    const r = queue.shift();
                    out[r.key] = await $plugin.remote.readOne(dest, r.SCOPE, r.WEB_DATA_ID);
                }
            };
            await Promise.all([0, 1, 2, 3, 4, 5].map(worker));
            return out;
        },

        // 콜백형 쓰기 → Promise (성공 콜백만 있는 코어 API라 시간 초과로 실패 판정)
        write: (fnName, dest, list) =>
            new Promise((resolve, reject) => {
                let fin = false;
                const timer = setTimeout(() => {
                    if (fin) return;
                    fin = true;
                    reject(new Error(fnName + ' 응답 없음'));
                }, 60000);
                $u.webData[fnName]({__DEST: dest}, list, () => {
                    if (fin) return;
                    fin = true;
                    clearTimeout(timer);
                    resolve();
                });
            })
    },

    // ────────────────────────────────────────────────────────────────────
    // sync : 판정 / 반영 / 되돌리기 / patch
    // ────────────────────────────────────────────────────────────────────
    sync: {
        // 행 → 대상 기준 판정. rows[{key,SCOPE,WEB_DATA_ID,base,mine,baseUnknown}]
        review: async (dest, rows) => {
            const theirs = await $plugin.remote.readMany(dest, rows);
            return rows.map((r) => {
                const t = theirs[r.key];
                let j;
                if (r.baseUnknown) {
                    // base를 못 읽은 행: 대상과 다르면 무조건 사람이 확인
                    j = merge3.same(r.mine, t)
                        ? {status: 'same', kind: 'modify', result: t, conflicts: []}
                        : {status: 'conflict', kind: 'modify', result: t, conflicts: ['*']};
                } else {
                    j = merge3.judge(r.base, r.mine, t);
                }
                return {key: r.key, SCOPE: r.SCOPE, WEB_DATA_ID: r.WEB_DATA_ID, base: r.base, mine: r.mine, theirs: t, j: j, resolution: null};
            });
        },

        // 최종 반영값 (충돌은 해결값)
        after: (it) => (it.resolution ? it.resolution.result : it.j.result),
        // 표시/반영용 상태: same | conflict(미해결) | auto | add | modify | delete
        state: (it) => {
            if (it.j.status === 'conflict' && !it.resolution) return 'conflict';
            const after = $plugin.sync.after(it);
            // 반영해도 대상이 그대로인 행: 값이 원래 같으면 동일, 아니면 대상 유지(브랜치에서 안 바꿈 / 충돌에서 대상 선택)
            if (merge3.same(after, it.theirs)) return merge3.same(it.mine, it.theirs) ? 'same' : 'keep';
            if (it.j.status === 'auto' && !it.resolution) return 'auto';
            return after === null ? 'delete' : it.theirs === null ? 'add' : 'modify';
        },

        // 판정 이후 대상이 바뀐 행이 있으면 중단 (남의 변경 덮어쓰기 방지)
        recheck: async (dest, items) => {
            const now = await $plugin.remote.readMany(dest, items);
            const moved = items.filter((it) => !merge3.same(now[it.key], it.theirs));
            if (moved.length) {
                const err = new Error('moved');
                err.moved = moved;
                throw err;
            }
        },

        // 반영 진입점: 테스트 모드(dryRun)면 SAP에 쓰지 않고 파일로 저장
        commit: (dest, items, meta) => ($plugin.util.dryRun() ? $plugin.sync.preview(dest, items, meta) : $plugin.sync.apply(dest, items, meta)),

        // 테스트 모드: 반영될 내용을 파일로만 저장 (이력 기록 없음)
        preview: async (dest, items, meta) => {
            await $plugin.sync.recheck(dest, items);
            const rec = {
                _type: 'webdataVcs-push-preview',
                branch: meta.branch,
                target: dest,
                via: meta.via,
                at: $plugin.util.now(),
                rows: items.map((it) => ({
                    SCOPE: it.SCOPE,
                    WEB_DATA_ID: it.WEB_DATA_ID,
                    op: it.after === null ? 'delete' : it.theirs === null ? 'add' : 'modify',
                    before: it.theirs,
                    after: it.after
                }))
            };
            $plugin.util.downloadJSON('webdataVcs_' + meta.via + '_' + meta.branch + '_' + dest + '_' + $plugin.util.ts() + '.json', rec);
            return rec;
        },

        // 반영: ① 대상이 판정 이후 바뀌었는지 재확인 ② 반영 전 값 백업(이력) ③ 쓰기 ④ 완료 표시
        //   items[{key,SCOPE,WEB_DATA_ID,theirs,after}]
        apply: async (dest, items, meta) => {
            await $plugin.sync.recheck(dest, items);
            const rec = {
                branch: meta.branch,
                target: dest,
                at: $plugin.util.now(),
                via: meta.via,
                revertOf: meta.revertOf || null,
                done: false,
                rows: items.map((it) => ({key: it.key, SCOPE: it.SCOPE, WEB_DATA_ID: it.WEB_DATA_ID, before: it.theirs, after: it.after}))
            };
            rec.id = await store.pushes.add(rec); // 백업이 먼저 성공해야 반영 진행
            const ups = items.filter((it) => it.after !== null).map((it) => ({SCOPE: it.SCOPE, WEB_DATA_ID: it.WEB_DATA_ID, DATA: it.after}));
            const dels = items.filter((it) => it.after === null && it.theirs !== null).map((it) => ({SCOPE: it.SCOPE, WEB_DATA_ID: it.WEB_DATA_ID}));
            if (ups.length) await $plugin.remote.write('createOrModifyByList', dest, ups);
            if (dels.length) await $plugin.remote.write('deleteByList', dest, dels);
            rec.done = true;
            await store.pushes.put(rec);
            return rec;
        },

        // 되돌리기: 반영 이후 대상이 또 바뀐 행은 건너뜀 (덮어쓰지 않음)
        revert: async (push) => {
            const now = await $plugin.remote.readMany(push.target, push.rows);
            const ok = push.rows.filter((r) => merge3.same(now[r.key], r.after));
            const moved = push.rows.filter((r) => !merge3.same(now[r.key], r.after));
            return {
                moved: moved,
                run: async () => {
                    const rec = await $plugin.sync.commit(
                        push.target,
                        ok.map((r) => ({key: r.key, SCOPE: r.SCOPE, WEB_DATA_ID: r.WEB_DATA_ID, theirs: now[r.key], after: r.before})),
                        {branch: push.branch, via: 'revert', revertOf: push.id}
                    );
                    if ($plugin.util.dryRun()) return rec; // 테스트 모드: 파일만 저장, 이력 안 바꿈
                    push.revertedBy = rec.id;
                    await store.pushes.put(push);
                    return rec;
                },
                count: ok.length
            };
        },

        exportPatch: async (name) => {
            const b = await store.branches.get(name);
            const changes = await store.changes.list(name);
            if (!changes.length) return unidocuAlert('내보낼 변경이 없습니다.');
            $plugin.util.downloadJSON('webdataVcs_' + name + '_' + $plugin.util.ts() + '.json', {
                _type: PATCH_TYPE,
                version: 1,
                branch: name,
                sourceDest: (b && b.dest) || '',
                exportedAt: $plugin.util.now(),
                rows: changes.map((c) => ({SCOPE: c.SCOPE, WEB_DATA_ID: c.WEB_DATA_ID, base: c.base, mine: c.mine, baseUnknown: !!c.baseUnknown}))
            });
        },

        // 파일 선택 → 검증 → Push 다이얼로그(patch 소스)
        importPatch: () => {
            const $file = $('<input type="file" accept=".json,application/json" style="display:none">').appendTo('body');
            $file.on('change', function () {
                const f = this.files && this.files[0];
                $file.remove();
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () => {
                    let p;
                    try {
                        p = JSON.parse(reader.result);
                    } catch (e) {
                        return unidocuAlert('JSON 파일이 아닙니다.');
                    }
                    if (!p || p._type !== PATCH_TYPE || !Array.isArray(p.rows)) return unidocuAlert('webdataVcs patch 파일이 아닙니다.');
                    $plugin.ui.pushDialog({source: 'patch', patch: p});
                };
                reader.readAsText(f, 'utf-8');
            });
            $file.trigger('click');
        }
    },

    // ────────────────────────────────────────────────────────────────────
    // ui
    // ────────────────────────────────────────────────────────────────────
    ui: {
        // A. 브랜치 팝업
        branchPopup: async () => {
            const u = $plugin.util;
            const esc = u.escapeHtml;
            $plugin.ui._injectStyle();

            const known = await $plugin.capture.load();
            const cur = u.currentDest();
            if (known.branch && known.dest && cur && known.dest !== cur) {
                $plugin.util.setActive('');
                await $plugin.capture.load();
                unidocuAlert('브랜치 "' + known.branch + '"는 [' + known.dest + '] 기준이라 현재 세션 [' + cur + ']에서 체크아웃을 해제했습니다.');
            }

            const $c = $('<div class="wv-pop"></div>');
            const $dlg = $plugin.ui.modal({title: 'webdata 브랜치', width: 520, $content: $c});
            let openRow = ''; // 액션 줄이 펼쳐진 브랜치

            const render = async () => {
                const active = $plugin.util.getActive();
                // 현재 세션 dest에서 만든 브랜치만 (같은 브라우저 DB를 dest끼리 공유하므로 다른 dest 것은 숨김)
                const branches = (await store.branches.list())
                    .filter((b) => !cur || (b.dest || '') === cur)
                    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
                const counts = {};
                for (const b of branches) counts[b.name] = (await store.changes.list(b.name)).length;

                const head = active
                    ? '<i class="fa fa-code-branch"></i> <b>' +
                      esc(active) +
                      '</b> <span class="wv-muted">· ' +
                      esc(known.dest || cur) +
                      ' · ' +
                      (counts[active] || 0) +
                      '건</span>'
                    : '<i class="fa fa-code-branch"></i> <span class="wv-muted">작업 안 함 — 저장이 브랜치에 기록되지 않습니다</span>';
                const act = (cls, icon, text, disabled) =>
                    '<div class="wv-row wv-act ' +
                    cls +
                    (disabled ? ' wv-disabled' : '') +
                    '"><i class="fa ' +
                    icon +
                    '" style="width:14px"></i>' +
                    text +
                    '</div>';

                let html = '<div class="wv-box">';
                html += '<div class="wv-row" style="border-top:0">' + head + '</div>';
                html += act('wv-new', 'fa-plus', '새 브랜치');
                html +=
                    '<div class="wv-newrow" style="display:none;padding:4px 10px 8px 32px"><input class="wv-newname" placeholder="브랜치 이름" style="width:220px"> <button class="unidocu-button wv-create">생성</button></div>';
                html += act('wv-push', 'fa-arrow-up', 'Push...' + (active ? '' : ' <span class="wv-muted">(체크아웃 필요)</span>'), !active);
                if (u.patchEnabled()) html += act('wv-import', 'fa-sign-in', 'Patch 반영...');
                html += act('wv-history', 'fa-history', '반영 이력');
                html += '<div class="wv-row wv-muted" style="font-size:11px">로컬 브랜치</div>';
                branches.forEach((b) => {
                    const on = b.name === active;
                    html +=
                        '<div class="wv-row wv-act wv-brow' +
                        (on ? ' wv-cur' : '') +
                        '" data-name="' +
                        esc(b.name) +
                        '"><span style="width:14px;color:#1971c2">' +
                        (on ? '<i class="fa fa-check"></i>' : '') +
                        '</span><span style="flex:1">' +
                        esc(b.name) +
                        ' <span class="wv-muted">[' +
                        esc(b.dest || '?') +
                        '] · ' +
                        counts[b.name] +
                        '건 · ' +
                        esc(u.shortDate(b.updatedAt)) +
                        '</span></span><i class="fa fa-chevron-' +
                        (openRow === b.name ? 'down' : 'right') +
                        ' wv-muted"></i></div>';
                    if (openRow === b.name) {
                        html +=
                            '<div class="wv-strip" data-name="' +
                            esc(b.name) +
                            '">' +
                            (on
                                ? '<button class="unidocu-button wv-b-uncheckout">체크아웃 해제</button>'
                                : '<button class="unidocu-button wv-b-checkout">체크아웃</button>') +
                            '<button class="unidocu-button wv-b-changes">변경 보기</button>' +
                            '<button class="unidocu-button wv-b-push">Push...</button>' +
                            (u.patchEnabled() ? '<button class="unidocu-button wv-b-patch">Patch 내보내기</button>' : '') +
                            '<button class="unidocu-button wv-b-del" style="color:#c92a2a">삭제</button>' +
                            '</div>';
                    }
                });
                if (!branches.length) html += '<div class="wv-row wv-muted">브랜치가 없습니다. [새 브랜치]로 시작하세요.</div>';
                html += '</div>';
                $c.html(html);
            };
            await render();

            const nameOf = (el) => String($(el).closest('[data-name]').attr('data-name') || '');
            const reload = async (msg) => {
                await $plugin.capture.load();
                await render();
                if (msg) $plugin.ui.toast(msg);
            };

            $c.on('click', '.wv-new', () => {
                $c.find('.wv-newrow').toggle();
                $c.find('.wv-newname').trigger('focus');
            });
            const create = async () => {
                const n = String($c.find('.wv-newname').val() || '').trim();
                if (!n) return unidocuAlert('이름을 입력하세요.');
                const dup = await store.branches.get(n);
                if (dup) return unidocuAlert('이미 있는 브랜치명입니다.' + (dup.dest && dup.dest !== cur ? ' ([' + dup.dest + ']에서 만든 브랜치)' : ''));
                const now = u.now();
                await store.branches.put({name: n, dest: cur, createdAt: now, updatedAt: now});
                $plugin.util.setActive(n);
                await reload('“' + n + '” 생성 · 체크아웃됨');
            };
            $c.on('click', '.wv-create', create);
            $c.on('keydown', '.wv-newname', (e) => {
                if (e.keyCode === 13) create();
            });
            $c.on('click', '.wv-push:not(.wv-disabled)', () => $plugin.ui.pushDialog({source: 'branch', name: $plugin.util.getActive()}));
            $c.on('click', '.wv-import', () => $plugin.sync.importPatch());
            $c.on('click', '.wv-history', () => $plugin.ui.historyDialog());
            $c.on('click', '.wv-brow', async function () {
                const n = nameOf(this);
                openRow = openRow === n ? '' : n;
                await render();
            });
            $c.on('click', '.wv-b-checkout', async function () {
                const n = nameOf(this);
                $plugin.util.setActive(n);
                await reload('“' + n + '” 체크아웃됨');
            });
            $c.on('click', '.wv-b-uncheckout', async () => {
                $plugin.util.setActive('');
                await reload('체크아웃 해제됨 — 저장이 브랜치에 기록되지 않습니다');
            });
            $c.on('click', '.wv-b-changes', function () {
                $plugin.ui.changesDialog(nameOf(this), reload);
            });
            $c.on('click', '.wv-b-push', function () {
                $plugin.ui.pushDialog({source: 'branch', name: nameOf(this)});
            });
            $c.on('click', '.wv-b-patch', function () {
                $plugin.sync.exportPatch(nameOf(this));
            });
            $c.on('click', '.wv-b-del', function () {
                const n = nameOf(this);
                unidocuConfirm('브랜치 "' + n + '"와 기록된 변경을 삭제할까요? (반영 이력은 남습니다)', async () => {
                    await store.branches.remove(n);
                    if ($plugin.util.getActive() === n) $plugin.util.setActive('');
                    openRow = '';
                    await reload('“' + n + '” 삭제됨');
                });
            });
            return $dlg;
        },

        // 변경 보기 (IntelliJ Changes): base ↔ 내 값
        changesDialog: async (name, onChanged) => {
            const u = $plugin.util;
            const esc = u.escapeHtml;
            const $c = $('<div class="wv-pop" style="min-width:640px"></div>');
            $plugin.ui.modal({title: '변경 보기 — ' + name, width: 720, $content: $c});

            const render = async () => {
                const list = (await store.changes.list(name)).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
                let html =
                    '<div class="wv-muted" style="margin-bottom:6px">이 브랜치에서 저장한 webdata (base = 처음 기록될 때의 개발 값). 행 클릭 → 비교</div><div class="wv-box wv-list">';
                list.forEach((c) => {
                    const kind = c.mine === null ? 'delete' : c.base === null && !c.baseUnknown ? 'add' : merge3.same(c.base, c.mine) ? 'same' : 'modify';
                    html +=
                        '<div class="wv-row wv-act wv-crow" data-key="' +
                        esc(c.key) +
                        '">' +
                        $plugin.ui.badge(kind) +
                        '<span class="wv-mono" style="flex:1">' +
                        esc(c.key) +
                        '</span>' +
                        (c.baseUnknown ? '<span class="wv-muted">base 미확보</span>' : '') +
                        '<span class="wv-muted">' +
                        esc(u.shortDate(c.lastAt)) +
                        '</span><button class="unidocu-button wv-c-drop" title="브랜치 기록에서만 제외 (개발 데이터는 그대로)">제외</button></div>';
                });
                if (!list.length) html += '<div class="wv-row wv-muted" style="border-top:0">기록된 변경이 없습니다.</div>';
                html += '</div>';
                $c.html(html);
                return list;
            };
            let list = await render();

            $c.on('click', '.wv-crow', function (e) {
                if ($(e.target).closest('.wv-c-drop').length) return;
                const c = list.find((x) => x.key === $(this).attr('data-key'));
                if (c)
                    $plugin.ui.compareView('내 변경 — ' + c.key, [
                        {label: '내 변경', leftLabel: 'base (처음 기록 시 개발 값)', left: c.base, rightLabel: '브랜치 (' + name + ')', right: c.mine}
                    ]);
            });
            $c.on('click', '.wv-c-drop', function () {
                const key = $(this).closest('.wv-crow').attr('data-key');
                unidocuConfirm('"' + key + '"를 브랜치 기록에서 제외할까요?\n(개발 데이터는 바뀌지 않습니다)', async () => {
                    await store.changes.remove(name, key);
                    delete $plugin.capture.known.keys[key];
                    list = await render();
                    if (onChanged) onChanged();
                });
            });
        },

        // B. Push 다이얼로그 — opts: {source:'branch', name} | {source:'patch', patch}
        pushDialog: async (opts) => {
            const u = $plugin.util;
            const esc = u.escapeHtml;
            const isPatch = opts.source === 'patch';
            const label = isPatch ? 'patch: ' + (opts.patch.branch || '?') : opts.name;
            if (!isPatch && !opts.name) return unidocuAlert('체크아웃된 브랜치가 없습니다.');

            const dry = u.dryRun();
            const rows = isPatch
                ? opts.patch.rows.map((r) => ({
                      key: u.rowKey(r.SCOPE, r.WEB_DATA_ID),
                      SCOPE: r.SCOPE,
                      WEB_DATA_ID: r.WEB_DATA_ID,
                      base: r.base === undefined ? null : r.base,
                      mine: r.mine === undefined ? null : r.mine,
                      baseUnknown: !!r.baseUnknown
                  }))
                : (await store.changes.list(opts.name)).map((c) => ({
                      key: c.key,
                      SCOPE: c.SCOPE,
                      WEB_DATA_ID: c.WEB_DATA_ID,
                      base: c.base,
                      mine: c.mine,
                      baseUnknown: !!c.baseUnknown
                  }));
            if (!rows.length) return unidocuAlert('반영할 변경이 없습니다.');

            const dests = (typeof staticProperties !== 'undefined' && staticProperties.destinationAliases) || [];
            const cur = u.currentDest();
            // patch 반영은 현재 세션 dest가 대상 (망분리: 운영 세션에서 파일을 받는 흐름)
            const destSel = isPatch
                ? '<b>' + esc(cur) + '</b> <span class="wv-muted">(현재 세션)</span>'
                : '<select class="wv-dest"><option value="">대상 선택</option>' +
                  dests.map((d) => '<option value="' + esc(d) + '">' + esc(d) + '</option>').join('') +
                  '</select>';

            const $c = $(
                '<div class="wv-pop" style="min-width:700px">' +
                    (dry
                        ? '<div class="wv-dry">테스트 모드 — SAP에 쓰지 않고, 반영될 내용을 파일로 저장합니다. (options.dryRun: false 로 실제 반영)</div>'
                        : '') +
                    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><b>' +
                    esc(label) +
                    '</b><i class="fa fa-arrow-right"></i>' +
                    destSel +
                    '<span class="wv-sum wv-muted" style="margin-left:auto"></span></div>' +
                    '<div class="wv-box wv-list wv-items"><div class="wv-row wv-muted" style="border-top:0">' +
                    (isPatch ? '대상 값을 조회하는 중…' : '대상을 선택하세요.') +
                    '</div></div>' +
                    '<div class="wv-muted" style="margin-top:6px">행 클릭 → 비교 · 충돌 행 클릭 → 병합' +
                    (dry ? '' : ' · Push 직전 대상 값을 반영 이력에 백업합니다.') +
                    '</div>' +
                    '</div>'
            );

            const pushLabel = dry ? '파일로 저장 (테스트)' : 'Push';
            let dest = isPatch ? cur : '';
            let items = [];
            const order = {conflict: 0, auto: 1, add: 2, modify: 3, delete: 4, keep: 5, same: 6};

            const render = () => {
                const st = items.map((it) => $plugin.sync.state(it));
                const cnt = {};
                st.forEach((s) => (cnt[s] = (cnt[s] || 0) + 1));
                $c.find('.wv-sum').text(
                    ['conflict', 'auto', 'add', 'modify', 'delete', 'keep', 'same']
                        .filter((s) => cnt[s])
                        .map((s) => BADGE[s][0] + ' ' + cnt[s])
                        .join(' · ')
                );
                const sorted = items.map((it, i) => ({it: it, s: st[i], i: i})).sort((a, b) => order[a.s] - order[b.s]);
                let html = '';
                sorted.forEach((x) => {
                    const it = x.it;
                    const res = it.resolution
                        ? '<span class="wv-muted">해결: ' + {mine: '내 것', theirs: '대상', merge: '병합'}[it.resolution.how] + '</span>'
                        : '';
                    const tools =
                        it.j.status === 'conflict'
                            ? '<button class="unidocu-button wv-r-mine">내 것</button><button class="unidocu-button wv-r-theirs">대상</button><button class="unidocu-button wv-r-merge">병합...</button>'
                            : '';
                    html +=
                        '<div class="wv-row wv-act wv-irow" data-i="' +
                        x.i +
                        '">' +
                        $plugin.ui.badge(x.s) +
                        '<span class="wv-mono" style="flex:1;' +
                        (x.s === 'same' || x.s === 'keep' ? 'color:#999' : '') +
                        '">' +
                        esc(it.key) +
                        '</span>' +
                        res +
                        (x.s === 'auto' ? '<span class="wv-muted">양쪽 변경 합침</span>' : '') +
                        (x.s === 'keep' && !it.resolution ? '<span class="wv-muted">브랜치에서 안 바꿈 — 대상 변경 유지</span>' : '') +
                        tools +
                        '</div>';
                });
                $c.find('.wv-items').html(html || '<div class="wv-row wv-muted" style="border-top:0">변경 없음</div>');
                const left = st.filter((s) => s === 'conflict').length;
                $btnPush.text(left ? pushLabel + ' (충돌 ' + left + '건 남음)' : pushLabel);
            };

            const runReview = async () => {
                if (!dest) return;
                $c.find('.wv-items').html('<div class="wv-row wv-muted" style="border-top:0">대상 값을 조회하는 중…</div>');
                try {
                    items = await $plugin.sync.review(dest, rows);
                    render();
                } catch (e) {
                    items = [];
                    $c.find('.wv-items').html(
                        '<div class="wv-row" style="border-top:0;color:#c92a2a">대상 조회 실패: ' + esc((e && e.message) || e) + '</div>'
                    );
                }
            };

            const doPush = async () => {
                if (!dest) return unidocuAlert('대상을 선택하세요.');
                if (!items.length) return;
                const st = items.map((it) => $plugin.sync.state(it));
                const left = st.filter((s) => s === 'conflict').length;
                if (left) return unidocuAlert('해결하지 않은 충돌이 ' + left + '건 있습니다.');
                const todo = items.filter((it, i) => st[i] !== 'same' && st[i] !== 'keep');
                if (!todo.length) return unidocuAlert('대상과 모두 같아 반영할 변경이 없습니다.');
                const n = {add: 0, modify: 0, delete: 0, auto: 0};
                todo.forEach((it) => (n[$plugin.sync.state(it)] += 1));
                const counts = '신규 ' + n.add + ' · 변경 ' + (n.modify + n.auto) + ' · 삭제 ' + n.delete;
                unidocuConfirm(
                    dry
                        ? '[테스트] [' + dest + ']에 반영될 ' + todo.length + '건을 파일로 저장합니다. (SAP에 쓰지 않음)\n' + counts
                        : '[' + dest + ']에 ' + todo.length + '건을 반영합니다.\n' + counts + '\n\n반영 직전 대상 값은 반영 이력에 백업됩니다.',
                    async () => {
                        try {
                            const rec = await $plugin.sync.commit(
                                dest,
                                todo.map((it) => ({
                                    key: it.key,
                                    SCOPE: it.SCOPE,
                                    WEB_DATA_ID: it.WEB_DATA_ID,
                                    theirs: it.theirs,
                                    after: $plugin.sync.after(it)
                                })),
                                {branch: isPatch ? opts.patch.branch || '(patch)' : opts.name, via: isPatch ? 'patch' : 'direct'}
                            );
                            $plugin.ui.toast(dry ? '[테스트] ' + rec.rows.length + '건 파일로 저장됨' : '[' + dest + '] ' + rec.rows.length + '건 반영됨');
                            $dlg.dialog('close');
                        } catch (e) {
                            if (e && e.moved) {
                                unidocuAlert('검토 이후 대상에서 바뀐 행이 있어 중단했습니다. 다시 검토합니다.\n\n' + e.moved.map((m) => m.key).join('\n'));
                                runReview();
                            } else {
                                unidocuAlert('반영 실패: ' + ((e && e.message) || e) + '\n반영 이력에서 미완료 건을 확인하세요.');
                            }
                        }
                    }
                );
            };

            const buttons = [];
            if (!isPatch && u.patchEnabled()) buttons.push({text: 'Patch로 내보내기', onClick: () => $plugin.sync.exportPatch(opts.name)});
            buttons.push({text: pushLabel, cls: 'unidocu-button blue', onClick: doPush});
            const $dlg = $plugin.ui.modal({title: isPatch ? 'Patch 반영' : 'Push', width: 780, $content: $c, buttons: buttons});
            const $btnPush = $dlg
                .closest('.ui-dialog')
                .find('.ui-dialog-buttonpane button')
                .filter(function () {
                    return $(this).text() === pushLabel;
                });

            $c.on('change', '.wv-dest', function () {
                dest = String($(this).val() || '');
                runReview();
            });
            const itemOf = (el) => items[Number($(el).closest('.wv-irow').attr('data-i'))];
            $c.on('click', '.wv-r-mine', function (e) {
                e.stopPropagation();
                const it = itemOf(this);
                it.resolution = {how: 'mine', result: it.mine};
                render();
            });
            $c.on('click', '.wv-r-theirs', function (e) {
                e.stopPropagation();
                const it = itemOf(this);
                it.resolution = {how: 'theirs', result: it.theirs};
                render();
            });
            const openMerge = (it) =>
                $plugin.ui.mergeWindow(it, (result) => {
                    it.resolution = {how: 'merge', result: result};
                    render();
                });
            $c.on('click', '.wv-r-merge', function (e) {
                e.stopPropagation();
                openMerge(itemOf(this));
            });
            $c.on('click', '.wv-irow', function () {
                const it = itemOf(this);
                // 충돌 행은 보기 전용 비교 대신 바로 병합 창 (IntelliJ Conflicts 더블클릭과 동일)
                if (it.j.status === 'conflict') return openMerge(it);
                const after = $plugin.sync.after(it);
                const views = [
                    {label: '브랜치 ↔ 대상', leftLabel: '대상 (' + dest + ' 현재)', left: it.theirs, rightLabel: '브랜치 (' + label + ')', right: it.mine}
                ];
                // 자동병합·충돌 해결로 실제 반영값이 브랜치 값과 다를 때만
                if (!merge3.same(after, it.mine))
                    views.push({label: '반영 결과 ↔ 대상', leftLabel: '대상 (' + dest + ' 현재)', left: it.theirs, rightLabel: '반영될 값', right: after});
                if (!it.baseUnknown)
                    views.push({label: '내 변경', leftLabel: 'base (고치기 전)', left: it.base, rightLabel: '브랜치 (' + label + ')', right: it.mine});
                $plugin.ui.compareView(BADGE[$plugin.sync.state(it)][0] + ' — ' + it.key, views);
            });

            if (isPatch) runReview();
        },

        // C. 3-pane 병합 (좌 내 값 / 가운데 결과 편집 / 우 대상)
        mergeWindow: (it, onApply) => {
            const u = $plugin.util;
            const W = Math.max(600, $(window).width() - 80);
            const H = Math.max(400, $(window).height() - 90);
            const conflicts = (it.j.conflicts || []).filter((p) => p !== '*');
            const $c = $(
                '<div class="wv-merge">' +
                    '<div class="wv-muted" style="margin-bottom:6px">' +
                    (conflicts.length ? '충돌 항목: <b>' + u.escapeHtml(conflicts.join(', ')) + '</b> · ' : '') +
                    '가운데가 반영될 결과입니다. 충돌 지점은 <b>고치기 전(base) 값</b>으로 시작하니, 양쪽 화살표로 고르거나 직접 수정하세요. (비우면 삭제)</div>' +
                    '<div style="display:flex;font-size:12px;font-weight:bold;margin-bottom:2px"><span style="flex:1">내 값 (Yours)</span><span style="flex:1;text-align:center">결과 (편집 가능)</span><span style="flex:1;text-align:right">대상 (Theirs)</span></div>' +
                    '<div class="wv-mv"></div>' +
                    '</div>'
            );
            let mv = null;
            const startValue = merge3.pretty($plugin.sync.after(it)); // 이미 해결했으면 그 결과에서 이어서 편집
            const apply = () => {
                const text = mv.editor().getValue();
                const doApply = (v) => {
                    onApply(v);
                    $dlg.dialog('close');
                };
                if (!text.trim()) return unidocuConfirm('결과가 비어 있습니다. 대상에서 이 행을 삭제할까요?', () => doApply(null));
                const wasJson = [it.mine, it.theirs, it.base].some((s) => merge3.parse(s).json);
                if (wasJson && !merge3.parse(text).json) return unidocuAlert('JSON 형식이 올바르지 않습니다.');
                const result = merge3.compact(text);
                // 충돌 지점이 하나라도 base 그대로면 적용 불가 (IntelliJ와 동일 — 고르거나 [취소]만 가능)
                const left = merge3.unresolved(it.base, result, it.j.paths);
                if (left.length)
                    return unidocuAlert(
                        '아직 고르지 않은 충돌이 있습니다: ' + left.join(', ') + '\n화살표로 내 값 / 대상 중 고르거나 직접 수정하세요. (그만두려면 [취소])'
                    );
                // 결과가 대상과 같으면 반영되지 않는다는 걸 알리고 확인
                if (merge3.same(result, it.theirs))
                    return unidocuConfirm('결과가 대상과 같습니다. 이 행은 반영되지 않고 대상 값이 유지됩니다.\n적용할까요?', () => doApply(result));
                doApply(result);
            };
            const $dlg = $plugin.ui.modal({
                title: '병합 — ' + it.key,
                width: W,
                height: H,
                $content: $c,
                buttons: [
                    {text: '취소', onClick: () => $dlg.dialog('close')},
                    {text: '적용', cls: 'unidocu-button blue', onClick: apply}
                ]
            });
            mv = CodeMirror.MergeView($c.find('.wv-mv')[0], {
                value: startValue,
                origLeft: merge3.pretty(it.mine),
                orig: merge3.pretty(it.theirs),
                mode: {name: 'javascript', json: true},
                theme: 'idea',
                lineNumbers: true,
                revertButtons: true,
                highlightDifferences: true,
                connect: null,
                collapseIdentical: false
            });
            const size = () => {
                const h = Math.max(300, $dlg.height() - 70);
                [mv.editor(), mv.leftOriginal(), mv.rightOriginal()].forEach((cm) => cm && cm.setSize(null, h));
                $c.find('.CodeMirror-merge').css('height', h + 'px');
            };
            size();
            $dlg.on('dialogresize', size);
        },

        // 읽기 전용 2-pane 비교. views 여러 개면 상단 버튼으로 전환
        //   views[{label, leftLabel, left, rightLabel, right}] — 좌 = 기준, 우 = 비교값 (원문, null = 없음)
        //   같은 부분은 접고(바뀐 줄 ±3줄만), 키 순서는 화면에서만 정렬해 순서 차이가 변경으로 안 보이게 함
        compareView: (title, views) => {
            const W = Math.max(600, $(window).width() - 160);
            const H = Math.max(360, $(window).height() - 160);
            const esc = $plugin.util.escapeHtml;
            const none = ' <span class="wv-muted">(없음)</span>';
            const $c = $(
                '<div class="wv-merge">' +
                    '<div class="wv-cmp-bar">' +
                    (views.length > 1
                        ? views.map((v, i) => '<button class="unidocu-button wv-cmp-view" data-i="' + i + '">' + esc(v.label) + '</button>').join('')
                        : '') +
                    '<span class="wv-cmp-info"></span>' +
                    '<button class="unidocu-button wv-cmp-prev">◀ 이전 변경</button><button class="unidocu-button wv-cmp-next">다음 변경 ▶</button>' +
                    '</div>' +
                    '<div class="wv-cmp-labels" style="display:flex;font-size:12px;font-weight:bold;margin-bottom:2px"></div>' +
                    '<div class="wv-mv"></div></div>'
            );
            const $dlg = $plugin.ui.modal({title: title, width: W, height: H, $content: $c});
            let mv = null;

            const size = () => {
                if (!mv) return;
                const h = Math.max(240, $dlg.height() - 70);
                [mv.editor(), mv.leftOriginal()].forEach((cm) => cm && cm.setSize(null, h));
                $c.find('.CodeMirror-merge').css('height', h + 'px');
            };

            const show = (i) => {
                const v = views[i];
                $c.find('.wv-cmp-view')
                    .removeClass('wv-on')
                    .filter('[data-i="' + i + '"]')
                    .addClass('wv-on');
                $c.find('.wv-cmp-labels').html(
                    '<span style="flex:1">' +
                        esc(v.leftLabel) +
                        (v.left === null ? none : '') +
                        '</span><span style="flex:1;text-align:right">' +
                        esc(v.rightLabel) +
                        (v.right === null ? none : '') +
                        '</span>'
                );
                const $mv = $c.find('.wv-mv').empty();
                mv = CodeMirror.MergeView($mv[0], {
                    value: merge3.prettySorted(v.right),
                    origLeft: merge3.prettySorted(v.left),
                    mode: {name: 'javascript', json: true},
                    theme: 'idea',
                    lineNumbers: true,
                    readOnly: true,
                    revertButtons: false,
                    highlightDifferences: true,
                    collapseIdentical: 3
                });
                const n = (mv.leftChunks() || []).length;
                const same = merge3.same(v.left, v.right);
                $c.find('.wv-cmp-info').html(
                    same
                        ? '<b style="color:#2b8a3e">두 값이 같습니다</b>'
                        : '변경 <b>' + n + '</b>곳 <span class="wv-muted">(같은 부분은 접힘 — 클릭하면 펼침)</span>'
                );
                $c.find('.wv-cmp-prev, .wv-cmp-next').toggle(!same && n > 0);
                size();
                if (n) mv.editor().scrollIntoView({line: mv.leftChunks()[0].editFrom, ch: 0}, 80);
            };

            $c.on('click', '.wv-cmp-view', function () {
                show(Number($(this).attr('data-i')));
            });
            $c.on('click', '.wv-cmp-next', () => mv && CodeMirror.commands.goNextDiff(mv.editor()));
            $c.on('click', '.wv-cmp-prev', () => mv && CodeMirror.commands.goPrevDiff(mv.editor()));
            $dlg.on('dialogresize', size);
            show(0);
        },

        // D. 반영 이력
        historyDialog: async () => {
            const u = $plugin.util;
            const esc = u.escapeHtml;
            const $c = $('<div class="wv-pop" style="min-width:640px"></div>');
            $plugin.ui.modal({title: '반영 이력', width: 720, $content: $c});
            let open = null;
            let list = [];

            const render = async () => {
                list = await store.pushes.list();
                let html =
                    '<div class="wv-muted" style="margin-bottom:6px">이 브라우저에서 반영한 기록입니다. 행 클릭 → 반영된 행 목록</div><div class="wv-box wv-list">';
                list.forEach((p) => {
                    const via = {direct: '직접', patch: 'patch', revert: '되돌리기'}[p.via] || p.via;
                    const state = !p.done
                        ? '<span style="color:#c92a2a">미완료</span>'
                        : p.revertedBy
                          ? '<span class="wv-muted">되돌림 #' + p.revertedBy + '</span>'
                          : '';
                    const canRevert = p.done && !p.revertedBy && p.via !== 'revert';
                    html +=
                        '<div class="wv-row wv-act wv-prow" data-id="' +
                        p.id +
                        '"><span class="wv-muted">#' +
                        p.id +
                        '</span><i class="fa ' +
                        (p.via === 'revert' ? 'fa-undo' : 'fa-arrow-up') +
                        '"></i><span style="flex:1">' +
                        esc(p.branch) +
                        ' → ' +
                        esc(p.target) +
                        (p.revertOf ? ' <span class="wv-muted">(#' + p.revertOf + ' 되돌림)</span>' : '') +
                        '</span>' +
                        state +
                        '<span class="wv-muted">' +
                        via +
                        ' · ' +
                        p.rows.length +
                        '건 · ' +
                        esc(u.shortDate(p.at)) +
                        '</span>' +
                        (canRevert ? '<button class="unidocu-button wv-p-revert">되돌리기</button>' : '') +
                        '</div>';
                    if (open === p.id) {
                        html += '<div class="wv-strip" style="display:block">';
                        p.rows.forEach((r) => {
                            const k = r.after === null ? 'delete' : r.before === null ? 'add' : 'modify';
                            html +=
                                '<div class="wv-row wv-act wv-prrow" data-key="' +
                                esc(r.key) +
                                '" style="border-top:0;padding:3px 0">' +
                                $plugin.ui.badge(k) +
                                '<span class="wv-mono">' +
                                esc(r.key) +
                                '</span></div>';
                        });
                        html += '</div>';
                    }
                });
                if (!list.length) html += '<div class="wv-row wv-muted" style="border-top:0">반영 이력이 없습니다.</div>';
                html += '</div>';
                $c.html(html);
            };
            await render();

            $c.on('click', '.wv-prow', async function (e) {
                if ($(e.target).closest('.wv-p-revert').length) return;
                const id = Number($(this).attr('data-id'));
                open = open === id ? null : id;
                await render();
            });
            $c.on('click', '.wv-prrow', function () {
                const p = list.find((x) => x.id === open);
                const r = p && p.rows.find((x) => x.key === $(this).attr('data-key'));
                if (r)
                    $plugin.ui.compareView('반영 내용 — ' + r.key, [
                        {label: '반영 내용', leftLabel: '반영 전 (백업)', left: r.before, rightLabel: '반영 값', right: r.after}
                    ]);
            });
            $c.on('click', '.wv-p-revert', async function () {
                const p = list.find((x) => x.id === Number($(this).closest('.wv-prow').attr('data-id')));
                if (!p) return;
                let plan;
                try {
                    plan = await $plugin.sync.revert(p);
                } catch (err) {
                    return unidocuAlert('대상 조회 실패: ' + ((err && err.message) || err));
                }
                if (!plan.count) return unidocuAlert('반영 이후 모든 행이 대상에서 다시 바뀌어 되돌릴 수 있는 행이 없습니다.');
                const warn = plan.moved.length
                    ? '\n\n반영 이후 대상에서 또 바뀐 ' + plan.moved.length + '건은 건너뜁니다:\n' + plan.moved.map((m) => m.key).join('\n')
                    : '';
                const dry = u.dryRun();
                const msg = dry
                    ? '[테스트] #' + p.id + ' 되돌리기로 [' + p.target + ']에 쓰일 ' + plan.count + '건을 파일로 저장합니다. (SAP에 쓰지 않음)'
                    : '#' + p.id + ' 반영을 되돌립니다. [' + p.target + '] ' + plan.count + '건을 반영 전 값으로 다시 씁니다.';
                unidocuConfirm(msg + warn, async () => {
                    try {
                        const rec = await plan.run();
                        $plugin.ui.toast(dry ? '[테스트] ' + rec.rows.length + '건 파일로 저장됨' : '#' + p.id + ' 되돌림 (' + rec.rows.length + '건)');
                        await render();
                    } catch (err) {
                        if (err && err.moved) unidocuAlert('조회 이후 대상이 또 바뀌어 중단했습니다. 다시 시도하세요.');
                        else unidocuAlert('되돌리기 실패: ' + ((err && err.message) || err));
                        await render();
                    }
                });
            });
        },

        badge: (s) => '<span class="wv-badge wv-b-' + BADGE[s][1] + '">' + BADGE[s][0] + '</span>',

        // jQuery UI 다이얼로그 (core baseDialog). 닫히면 DOM 정리
        modal: (opts) => {
            const buttons = (opts.buttons || []).map((b) => $u.baseDialog.getButton(b.text, () => b.onClick && b.onClick(), b.cls || 'unidocu-button'));
            const o = {title: opts.title || '', buttons: buttons, width: String(opts.width || 640), draggable: true, resizable: true};
            if (opts.height) o.height = opts.height;
            const $el = $u.baseDialog.openModalDialog(opts.$content, o);
            $el.on('dialogclose', () => {
                try {
                    $el.dialog('destroy').remove();
                } catch (e) {}
            });
            return $el;
        },

        toast: (() => {
            let timer = null;
            return (msg) => {
                let $t = $('#wv-toast');
                if (!$t.length) $t = $('<div id="wv-toast"></div>').appendTo('body');
                $t.text(msg).css('opacity', '1');
                clearTimeout(timer);
                timer = setTimeout(() => $t.css('opacity', '0'), 1800);
            };
        })(),

        _injectStyle: () => {
            if (document.getElementById('wv-style')) return;
            const css = [
                '.wv-pop{font-size:13px}',
                '.wv-box{border:1px solid #e3e3e3;border-radius:4px;background:#fff}',
                '.wv-list{max-height:420px;overflow:auto}',
                '.wv-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid #f0f0f0}',
                '.wv-act{cursor:pointer}.wv-act:hover{background:#f3f6fa}',
                '.wv-disabled{color:#aaa;cursor:default}.wv-disabled:hover{background:none}',
                '.wv-cur{background:#eaf4ff}',
                '.wv-strip{display:flex;gap:4px;flex-wrap:wrap;padding:4px 10px 8px 32px;background:#fafbfc;border-top:1px solid #f0f0f0}',
                '.wv-muted{color:#888;font-size:12px}',
                '.wv-mono{font-family:Consolas,Monaco,monospace;font-size:12px;word-break:break-all}',
                '.wv-badge{font-size:11px;padding:1px 7px;border-radius:3px;white-space:nowrap}',
                '.wv-b-danger{background:#ffe3e3;color:#c92a2a}.wv-b-accent{background:#e7f1ff;color:#1864ab}',
                '.wv-b-success{background:#e6f7ea;color:#2b8a3e}.wv-b-del{background:#fff0e6;color:#d9480f}.wv-b-muted{background:#f1f3f5;color:#868e96}',
                '.wv-merge .CodeMirror{font-family:Consolas,Monaco,monospace;font-size:12px}',
                '.wv-merge .CodeMirror-merge{border:1px solid #ddd}',
                '.wv-merge .CodeMirror-merge-scrolllock-wrap{display:none}',
                '.wv-cmp-bar{display:flex;align-items:center;gap:4px;margin-bottom:6px}.wv-cmp-info{flex:1;margin-left:8px;font-size:12px}',
                // 실환경 unidocu-button이 배경을 덮어써서 채우기 대신 테두리·굵기로 선택 표시
                '.wv-cmp-view.wv-on{border:2px solid #1971c2 !important;color:#1971c2 !important;font-weight:bold}',
                '.wv-b-keep{background:#edf2ff;color:#5c7cfa}',
                '.wv-dry{background:#fff9db;color:#8a6d00;border:1px solid #ffe066;border-radius:4px;padding:6px 10px;margin-bottom:8px;font-size:12px}',
                '#wv-toast{position:fixed;left:50%;bottom:48px;transform:translateX(-50%);background:rgba(33,37,41,.92);color:#fff;padding:8px 16px;border-radius:6px;font-size:13px;z-index:2147483647;pointer-events:none;transition:opacity .2s}'
            ].join('\n');
            $('<style id="wv-style"></style>').text(css).appendTo('head');
        }
    },

    util: {
        rowKey: (scope, webDataId) => String(scope) + '@' + String(webDataId),
        now: () => new Date().toISOString(),
        currentDest: () => (typeof staticProperties !== 'undefined' && staticProperties.destinationAlias) || '',
        // 현재 세션 dest 기준 체크아웃 포인터
        getActive: () => store.getActive($plugin.util.currentDest()),
        setActive: (name) => store.setActive(name, $plugin.util.currentDest()),
        // 망분리 현장용 patch(파일 내보내기/반영) 메뉴 — config options.patch === true 일 때만 노출 (기본 꺼짐)
        patchEnabled: () => ($u.plugins.getOptions(config.name) || {}).patch === true,
        // 테스트 모드: 기본 켜짐 — options.dryRun === false 일 때만 SAP에 실제 반영 (v2 검증 기간 안전장치)
        dryRun: () => ($u.plugins.getOptions(config.name) || {}).dryRun !== false,
        // 파일명용 타임스탬프 (yyyyMMdd_HHmmss)
        ts: () => {
            const d = new Date();
            const p = (n) => (n < 10 ? '0' : '') + n;
            return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        },
        // 목록 표시용 (MM/DD HH:mm)
        shortDate: (iso) => {
            if (!iso) return '';
            const d = new Date(iso);
            if (isNaN(d.getTime())) return '';
            const p = (n) => (n < 10 ? '0' : '') + n;
            return p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
        },
        escapeHtml: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]),
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
        }
    }
};
