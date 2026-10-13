/**
 * 행 단위 3-way 판정/병합 (순수 함수 — DOM/$u 의존 없음)
 *
 * 입력은 webdata DATA 원문 문자열. null = 행 없음(신규 전 / 삭제 후).
 *   base   : 브랜치에 처음 기록될 때의 개발 원래 값 (merge-base)
 *   mine   : 브랜치 최종 값
 *   theirs : 대상 dest 현재 값
 *
 * DATA가 JSON 객체면 키 단위로 재귀 병합하고, 배열·원시값·비JSON은 통째로 비교한다.
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

// 객체 키 단위 재귀 병합. 충돌 경로는 conflicts에 쌓고 결과엔 대상 값을 둔다(해결 전 자리표시).
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
        const bv = hasOwn(b, k) ? b[k] : undefined;
        const mv = hasOwn(m, k) ? m[k] : undefined;
        const tv = hasOwn(t, k) ? t[k] : undefined;
        let v;
        if (eqVal(mv, tv)) v = mv;
        else if (eqVal(bv, tv)) v = mv;
        else if (eqVal(bv, mv)) v = tv;
        else if (isObj(mv) && isObj(tv) && (bv === undefined || isObj(bv))) v = mergeObj(bv || {}, mv, tv, path.concat(k), conflicts);
        else {
            conflicts.push(path.concat(k).join('.'));
            v = tv;
        }
        if (v !== undefined) out[k] = v;
    });
    return out;
};

/**
 * 판정
 * @return {{status:string, kind:string, result:(string|null), conflicts:string[]}}
 *   status : same(동일, 제외) | clean(그대로 반영) | auto(자동병합) | conflict(충돌)
 *   kind   : add | modify | delete — 반영 시 동작 (clean/auto 기준, conflict는 해결 후 재계산)
 *   result : 반영할 원문 (null = 삭제). conflict면 자동 병합된 부분 + 충돌 지점은 대상 값
 */
const judge = (base, mine, theirs) => {
    const B = parse(base);
    const M = parse(mine);
    const T = parse(theirs);
    const kindOf = (res) => (res === null ? 'delete' : T.absent ? 'add' : 'modify');
    const done = (status, result, conflicts) => ({status, kind: kindOf(result), result, conflicts: conflicts || []});

    if (eqParsed(M, T)) return done('same', mine === undefined ? null : mine);
    if (eqParsed(B, T)) return done('clean', M.absent ? null : mine);
    if (eqParsed(B, M)) return done('same', theirs); // 내 쪽 실질 변경 없음 → 대상 유지

    // 셋 다 다름
    if (!B.absent && !M.absent && !T.absent && B.json && M.json && T.json && isObj(B.v) && isObj(M.v) && isObj(T.v)) {
        const conflicts = [];
        const merged = JSON.stringify(mergeObj(B.v, M.v, T.v, [], conflicts));
        return done(conflicts.length ? 'conflict' : 'auto', merged, conflicts);
    }
    // 신규 양쪽 추가(base 없음)도 객체면 키 병합
    if (B.absent && M.json && T.json && isObj(M.v) && isObj(T.v)) {
        const conflicts = [];
        const merged = JSON.stringify(mergeObj({}, M.v, T.v, [], conflicts));
        return done(conflicts.length ? 'conflict' : 'auto', merged, conflicts);
    }
    return done('conflict', T.absent ? null : theirs, ['*']);
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
// 화면 편집 결과 → 저장 원문 (JSON이면 압축, 비JSON은 그대로). 빈 문자열 = 삭제.
const compact = (s) => {
    const p = parse(s);
    if (p.absent) return null;
    return p.json ? JSON.stringify(p.v) : p.v;
};

export default {same, judge, pretty, prettySorted, compact, parse};
