/**
 * webdataVcs 전용 IndexedDB 저장소 (DB 'webdataVcs')
 *
 * 어댑터 connectIndexedDB는 단일 store·버전 고정이라 다중 store/스키마 버전/다중 store 트랜잭션이 안 돼서 직접 관리한다.
 *
 *   branches : {name, dest, createdAt, updatedAt}                                 keyPath name
 *   changes  : {branch, key, SCOPE, WEB_DATA_ID, base, baseUnknown, mine, firstAt, lastAt}  keyPath [branch,key], index branch
 *   pushes   : {id, branch, target, at, via, rows:[{key, SCOPE, WEB_DATA_ID, before, after}]}  autoIncrement, index branch
 *
 * base/mine/before/after 는 DATA 원문 문자열, null = 행 없음.
 */

const DB_NAME = 'webdataVcs';
const DB_VERSION = 1;
// 체크아웃 포인터는 dest별로 따로 기억 (dest를 오가도 각자 체크아웃 유지)
const activeKey = (dest) => 'webdataVcs.activeBranch@' + (dest || '');

let _dbPromise = null;

const open = () => {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        // 스키마 변경 시 DB_VERSION을 올리고 oldVersion 기준으로 단계별 마이그레이션 추가
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (e.oldVersion < 1) {
                db.createObjectStore('branches', {keyPath: 'name'});
                db.createObjectStore('changes', {keyPath: ['branch', 'key']}).createIndex('branch', 'branch');
                db.createObjectStore('pushes', {keyPath: 'id', autoIncrement: true}).createIndex('branch', 'branch');
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => {
            _dbPromise = null;
            reject(e.target.error);
        };
    });
    return _dbPromise;
};

const done = (req) =>
    new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
const txDone = (tx) =>
    new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });

// 쓰기 트랜잭션 실행 → 커밋 완료까지 대기
const run = async (stores, mode, fn) => {
    const db = await open();
    const tx = db.transaction(stores, mode);
    fn(tx);
    await txDone(tx);
};

// getAll()은 Chrome 48+ 라 커서로 수집 (빌드 타깃 chrome40)
const getAll = (store, index, value) =>
    new Promise((resolve, reject) => {
        const out = [];
        const req = index ? store.index(index).openCursor(value) : store.openCursor();
        req.onsuccess = (e) => {
            const cur = e.target.result;
            if (!cur) return resolve(out);
            out.push(cur.value);
            cur.continue();
        };
        req.onerror = () => reject(req.error);
    });

export default {
    getActive: (dest) => {
        try {
            return localStorage.getItem(activeKey(dest)) || '';
        } catch (e) {
            return '';
        }
    },
    setActive: (name, dest) => {
        try {
            if (name) localStorage.setItem(activeKey(dest), name);
            else localStorage.removeItem(activeKey(dest));
        } catch (e) {}
    },

    branches: {
        list: async () => {
            const db = await open();
            return getAll(db.transaction('branches').objectStore('branches'));
        },
        get: async (name) => {
            const db = await open();
            return done(db.transaction('branches').objectStore('branches').get(name));
        },
        put: (branch) => run(['branches'], 'readwrite', (tx) => tx.objectStore('branches').put(branch)),
        // 브랜치 + 그 변경분을 한 트랜잭션으로 삭제 (반영 이력은 되돌리기용으로 남김)
        remove: (name) =>
            run(['branches', 'changes'], 'readwrite', (tx) => {
                tx.objectStore('branches').delete(name);
                const idx = tx.objectStore('changes').index('branch');
                idx.openKeyCursor(name).onsuccess = (e) => {
                    const cur = e.target.result;
                    if (!cur) return;
                    tx.objectStore('changes').delete(cur.primaryKey);
                    cur.continue();
                };
            })
    },

    changes: {
        list: async (branch) => {
            const db = await open();
            return getAll(db.transaction('changes').objectStore('changes'), 'branch', branch);
        },
        get: async (branch, key) => {
            const db = await open();
            return done(db.transaction('changes').objectStore('changes').get([branch, key]));
        },
        // 기존 행이 있으면 base/firstAt 유지하고 mine만 갱신 (base는 최초 기록 값 고정)
        upsert: (branch, rec, now) =>
            run(['changes', 'branches'], 'readwrite', (tx) => {
                const st = tx.objectStore('changes');
                st.get([branch, rec.key]).onsuccess = (e) => {
                    const prev = e.target.result;
                    // base를 못 읽은 첫 기록(조회 실패 등)은 baseUnknown → push 때 대상과 다르면 충돌로 처리
                    const firstBaseMissing = rec.base === undefined || !!rec.baseUnknown;
                    st.put({
                        branch: branch,
                        key: rec.key,
                        SCOPE: rec.SCOPE,
                        WEB_DATA_ID: rec.WEB_DATA_ID,
                        base: prev ? prev.base : firstBaseMissing ? null : rec.base,
                        baseUnknown: prev ? !!prev.baseUnknown : firstBaseMissing,
                        mine: rec.mine,
                        firstAt: prev ? prev.firstAt : now,
                        lastAt: now
                    });
                };
                const bs = tx.objectStore('branches');
                bs.get(branch).onsuccess = (e) => {
                    const b = e.target.result;
                    if (b) {
                        b.updatedAt = now;
                        bs.put(b);
                    }
                };
            }),
        remove: (branch, key) => run(['changes'], 'readwrite', (tx) => tx.objectStore('changes').delete([branch, key]))
    },

    pushes: {
        list: async () => {
            const db = await open();
            const all = await getAll(db.transaction('pushes').objectStore('pushes'));
            return all.sort((a, b) => b.id - a.id);
        },
        add: async (rec) => {
            const db = await open();
            const tx = db.transaction('pushes', 'readwrite');
            const id = await done(tx.objectStore('pushes').add(rec));
            await txDone(tx);
            return id;
        },
        put: (rec) => run(['pushes'], 'readwrite', (tx) => tx.objectStore('pushes').put(rec))
    }
};
