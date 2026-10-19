/**
 * 행 단위 3-way 판정/병합 (순수 함수 — DOM/$u 의존 없음)
 *
 * 입력은 webdata DATA 원문 문자열. null = 행 없음(신규 전 / 삭제 후).
 *   base   : 브랜치에 처음 기록될 때의 개발 원래 값 (merge-base)
 *   mine   : 브랜치 최종 값
 *   theirs : 대상 dest 현재 값
 *
 * DATA가 JSON이면 객체는 키 단위, 배열은 요소 단위로 재귀 병합한다.
 *   배열: 요소들에 공통 ID 필드(COLUMN_ID·BUTTON_ID 등)가 있으면 ID로 짝을 맞추고,
 *         없으면 세 쪽 길이가 같을 때 같은 위치끼리, 둘 다 아니면 통째로 비교한다.
 * 원시값·비JSON은 통째로 비교한다.
 *
 * 경로(path) 요소: 문자열 = 객체 키 / 숫자 = 배열 위치 / {k, v} = 배열에서 k 필드가 v인 요소
 */

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// 키 순서 무시 정규화 (배열 순서는 유지)
const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (isObj(v))
        return Object.keys(v)
            .sort()
            .reduce((o, k) => ((o[k] = canon(v[k])), o), {});
    return v;
};
const eqVal = (a, b) => (a === undefined || b === undefined ? a === b : JSON.stringify(canon(a)) === JSON.stringify(canon(b)));

// 원문 → {absent} | {json:true, v} | {json:false, v:문자열}
const parse = (s) => {
    if (s === null || s === undefined || s === '') return {absent: true};
    try {
        return {json: true, v: JSON.parse(s)};
    } catch (e) {
        return {json: false, v: String(s)};
    }
};
const eqParsed = (a, b) => {
    if (a.absent || b.absent) return !!a.absent === !!b.absent;
    if (a.json !== b.json) return false;
    return a.json ? eqVal(a.v, b.v) : a.v === b.v;
};

// 원문 의미 비교 (키 순서·공백 무시)
const same = (a, b) => eqParsed(parse(a), parse(b));

// 값 하나 3-way 병합 (undefined = 없음). 충돌 경로는 conflicts에 쌓고 결과엔 base 값을 둔다
// (IntelliJ처럼 고치기 전 값에서 시작 → 양쪽 다 차이로 보여 사용자가 직접 고르게 함)
const mergeValue = (b, m, t, path, conflicts) => {
    if (eqVal(m, t)) return m;
    if (eqVal(b, t)) return m;
    if (eqVal(b, m)) return t;
    if (isObj(m) && isObj(t) && (b === undefined || isObj(b))) return mergeObj(b || {}, m, t, path, conflicts);
    if (Array.isArray(m) && Array.isArray(t) && (b === undefined || Array.isArray(b))) return mergeArr(b, m, t, path, conflicts);
    conflicts.push(path);
    return b;
};

// 객체 키 단위
const mergeObj = (b, m, t, path, conflicts) => {
    const out = {};
    const keys = Object.keys(t);
    Object.keys(m).forEach((k) => {
        if (keys.indexOf(k) === -1) keys.push(k);
    });
    Object.keys(b).forEach((k) => {
        if (keys.indexOf(k) === -1) keys.push(k);
    });
    keys.forEach((k) => {
        const v = mergeValue(hasOwn(b, k) ? b[k] : undefined, hasOwn(m, k) ? m[k] : undefined, hasOwn(t, k) ? t[k] : undefined, path.concat(k), conflicts);
        if (v !== undefined) out[k] = v;
    });
    return out;
};

// 배열 요소의 ID 필드 찾기: 세 배열의 모든 요소가 객체이고, 그 필드가 원시값이며 배열 안에서 겹치지 않아야 함
const ID_HINTS = ['COLUMN_ID', 'BUTTON_ID', 'FNAME', 'FIELD_ID', 'ID', 'KEY', 'CODE'];
const findIdKey = (arrays) => {
    const els = [].concat.apply([], arrays);
    if (!els.length || !els.every(isObj)) return null;
    const usable = (k) =>
        arrays.every((arr) => {
            const seen = {};
            return arr.every((el) => {
                const v = el[k];
                if (v === undefined || v === null || typeof v === 'object') return false;
                if (seen['$' + v]) return false;
                seen['$' + v] = true;
                return true;
            });
        });
    const first = Object.keys(els[0]);
    const cands = ID_HINTS.concat(first.filter((k) => /_ID$/.test(k) && ID_HINTS.indexOf(k) === -1));
    for (let i = 0; i < cands.length; i++) if (usable(cands[i])) return cands[i];
    return null;
};

// 배열 요소 단위
const mergeArr = (b, m, t, path, conflicts) => {
    const base = b || [];
    const idKey = findIdKey([base, m, t]);
    if (idKey) {
        const ids = (arr) => arr.map((el) => String(el[idKey]));
        const byId = (arr) => arr.reduce((o, el) => ((o['$' + el[idKey]] = el), o), {});
        const bm = byId(base);
        const mm = byId(m);
        const tm = byId(t);
        // 순서: 내 쪽만 순서를 바꿨으면 내 순서, 아니면 대상 순서. 양쪽이 다르게 바꿨으면 배열 통째 충돌
        const common = (x, y) => ids(x).filter((id) => hasOwn(byId(y), '$' + id));
        const mineMoved = common(m, base).join('\u0000') !== common(base, m).join('\u0000');
        const theirsMoved = common(t, base).join('\u0000') !== common(base, t).join('\u0000');
        if (mineMoved && theirsMoved && common(m, t).join('\u0000') !== common(t, m).join('\u0000')) {
            conflicts.push(path);
            return b;
        }
        const primary = mineMoved ? m : t;
        const secondary = mineMoved ? t : m;
        const order = ids(primary);
        // 다른 쪽에만 있는 요소는 그쪽에서 바로 앞 요소 뒤에 끼워 넣음
        let prev = null;
        ids(secondary).forEach((id) => {
            if (order.indexOf(id) === -1) order.splice(prev === null ? 0 : order.indexOf(prev) + 1, 0, id);
            prev = id;
        });
        // base에만 있던(양쪽 다 지운) 요소는 mergeValue에서 undefined로 빠짐
        ids(base).forEach((id) => {
            if (order.indexOf(id) === -1) order.push(id);
        });
        const out = [];
        order.forEach((id) => {
            const v = mergeValue(bm['$' + id], mm['$' + id], tm['$' + id], path.concat({k: idKey, v: id}), conflicts);
            if (v !== undefined) out.push(v);
        });
        return out;
    }
    // ID가 없으면 세 쪽 길이가 같을 때만 같은 위치끼리
    if (base.length === m.length && m.length === t.length) return t.map((tv, i) => mergeValue(base[i], m[i], tv, path.concat(i), conflicts));
    conflicts.push(path);
    return b;
};

// 경로 → 표시 문자열 (예: OT_DATA[STBUS_NM].TEXT)
const pathText = (p) => (p.length ? p.map((s, i) => (typeof s === 'number' ? '[' + s + ']' : isObj(s) ? '[' + s.v + ']' : (i ? '.' : '') + s)).join('') : '*');

/**
 * 판정
 * @return {{status:string, kind:string, result:(string|null), conflicts:string[]}}
 *   status : same(동일, 제외) | clean(그대로 반영) | auto(자동병합) | conflict(충돌)
 *   kind   : add | modify | delete — 반영 시 동작 (clean/auto 기준, conflict는 해결 후 재계산)
 *   result : 반영할 원문 (null = 삭제). conflict면 자동 병합된 부분 + 충돌 지점은 base 값 (병합 창 시작값)
 */
const judge = (base, mine, theirs) => {
    const B = parse(base);
    const M = parse(mine);
    const T = parse(theirs);
    const kindOf = (res) => (res === null ? 'delete' : T.absent ? 'add' : 'modify');
    // conflicts: 표시용 문자열('a.b'), paths: 판정용 경로 배열 ([] = 행 전체)
    const done = (status, result, paths) => ({
        status,
        kind: kindOf(result),
        result,
        conflicts: (paths || []).map(pathText),
        paths: paths || []
    });

    if (eqParsed(M, T)) return done('same', mine === undefined ? null : mine);
    if (eqParsed(B, T)) return done('clean', M.absent ? null : mine);
    if (eqParsed(B, M)) return done('same', theirs); // 내 쪽 실질 변경 없음 → 대상 유지

    // 셋 다 다름: JSON 객체/배열이면 구조 병합 (base 없음 = 양쪽 신규도 같은 방식)
    const structured = (v) => isObj(v) || Array.isArray(v);
    if (!M.absent && !T.absent && M.json && T.json && structured(M.v) && structured(T.v) && (B.absent || (B.json && structured(B.v)))) {
        const conflicts = [];
        const merged = mergeValue(B.absent ? undefined : B.v, M.v, T.v, [], conflicts);
        // 최상위가 통째 충돌이면 행 전체 충돌과 동일
        if (conflicts.length === 1 && !conflicts[0].length) return done('conflict', B.absent ? null : base, [[]]);
        return done(conflicts.length ? 'conflict' : 'auto', merged === undefined ? null : JSON.stringify(merged), conflicts);
    }
    return done('conflict', B.absent ? null : base, [[]]);
};

// 사람이 읽기 좋은 들여쓰기 (병합 화면용). 비JSON은 그대로.
const pretty = (s) => {
    const p = parse(s);
    if (p.absent) return '';
    return p.json ? JSON.stringify(p.v, null, 2) : p.v;
};
// 비교 화면 전용: 키를 정렬해 들여쓰기 (순서만 다른 줄이 변경으로 보이지 않게). 저장값엔 쓰지 않음
const prettySorted = (s) => {
    const p = parse(s);
    if (p.absent) return '';
    return p.json ? JSON.stringify(canon(p.v), null, 2) : p.v;
};
// 경로 값 조회 (없으면 undefined). {k, v} 경로는 배열에서 해당 ID 요소를 찾음
const getAt = (v, path) =>
    path.reduce((o, s) => {
        if (o === null || typeof o !== 'object') return undefined;
        if (isObj(s)) return Array.isArray(o) ? o.filter((el) => isObj(el) && String(el[s.k]) === String(s.v))[0] : undefined;
        return hasOwn(o, s) ? o[s] : undefined;
    }, v);

// 경로 위치에 값 넣기 (val === undefined 면 제거). root를 직접 바꾸고 반환, 부모가 없으면 null
//   배열 ID 요소를 새로 넣을 땐 src(값을 가져온 쪽)에서 바로 앞 요소 뒤에 끼워 넣어 순서를 맞춤
const setAt = (root, path, val, src) => {
    if (!path.length) return val;
    const parent = getAt(root, path.slice(0, -1));
    const last = path[path.length - 1];
    if (parent === null || typeof parent !== 'object') return null;
    if (Array.isArray(parent)) {
        const idx = isObj(last) ? parent.findIndex((el) => isObj(el) && String(el[last.k]) === String(last.v)) : last;
        if (val === undefined) {
            if (idx >= 0 && idx < parent.length) parent.splice(idx, 1);
        } else if (idx >= 0 && idx < parent.length) parent[idx] = val;
        else if (isObj(last)) {
            const srcArr = getAt(src, path.slice(0, -1)) || [];
            const at = srcArr.findIndex((el) => isObj(el) && String(el[last.k]) === String(last.v));
            let pos = 0;
            for (let i = at - 1; i >= 0; i--) {
                const p = parent.findIndex((el) => isObj(el) && String(el[last.k]) === String(srcArr[i][last.k]));
                if (p >= 0) {
                    pos = p + 1;
                    break;
                }
            }
            parent.splice(pos, 0, val);
        } else parent.push(val);
    } else if (val === undefined) delete parent[last];
    else parent[last] = val;
    return root;
};

// 아직 고르지 않은 충돌 경로 — 결과가 그 지점에서 base 값 그대로면 미해결 (IntelliJ처럼 모두 골라야 적용)
const unresolved = (base, result, paths) => {
    const B = parse(base);
    const R = parse(result);
    if ((paths || []).some((p) => !p.length)) return eqParsed(B, R) ? ['*'] : [];
    if (R.absent || !R.json || (!B.absent && !B.json)) return [];
    const bv = B.absent ? undefined : B.v; // 양쪽 신규(base 없음)의 충돌은 "없음"이 시작값
    return (paths || []).filter((p) => eqVal(getAt(bv, p), getAt(R.v, p))).map(pathText);
};

// 화면 편집 결과 → 저장 원문 (JSON이면 압축, 비JSON은 그대로). 빈 문자열 = 삭제.
const compact = (s) => {
    const p = parse(s);
    if (p.absent) return null;
    return p.json ? JSON.stringify(p.v) : p.v;
};

export default {same, judge, unresolved, pretty, prettySorted, compact, parse, getAt, setAt, pathText, eqVal};
