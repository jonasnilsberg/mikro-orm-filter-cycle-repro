# `applyJoinedFilters` never terminates when filters form a relation cycle

## Describe the bug

`QueryBuilder.applyJoinedFilters()` iterates `this.#state.autoJoinedPaths` with `for…of`
while `CriteriaNode.process()` — called inside that same loop — pushes new paths onto it
via `qb.scheduleFilterCheck()`. Because an array iterator is live, the appended entries are
visited by the loop that appended them.

If two entity filters reference each other through relations, this never terminates: each
lap schedules the next lap's joins, and the criteria-node graph doubles every cycle. The
process grows until it dies with `JavaScript heap out of memory` — no error, no cycle
detection, no depth cap.

## Reproduction

```
npm install
node --max-old-space-size=256 repro.mjs
```

`--max-old-space-size=256` only makes it fail fast; it OOMs at any heap size.

Two entity filters that traverse relations, closing a cycle
(`ManagementObject → deviations → DeviationType → deviations → managementObject → …`):

```js
// ManagementObject
filters: {
  auth: {
    cond: ({ company }) => ({
      $or: [{ company }, { deviations: { type: { identifier: company } } }],
    }),
    default: true,
  },
}

// DeviationType
filters: {
  auth: {
    cond: ({ company }) => ({ deviations: { managementObject: { company } } }),
    default: true,
  },
}
```

```js
await em.find(ManagementObject, { deviations: { type: { identifier: "x" } } });
```

## Expected behavior

The query completes, or MikroORM throws a descriptive error about the cyclic filter graph.

## Actual behavior

`FATAL ERROR: Ineffective mark-compacts near heap limit - JavaScript heap out of memory`

Instrumenting the loop shows `autoJoinedPaths` growing in lockstep with the iteration index,
revisiting the same edges forever:

```
iter=1  len=4   ManagementObject.deviations
iter=2  len=4   ManagementObject.deviations.type
iter=5  len=8   DeviationType.deviations
iter=6  len=8   DeviationType.deviations.managementObject
iter=7  len=10  DeviationType.deviations          <- cycle
iter=25 len=28  ...
iter=75 len=78  ...
FATAL ERROR: heap out of memory
```

A heap snapshot taken at the limit shows **131,073 (2^17 + 1) `ObjectCriteriaNode`
instances**, consistent with doubling once per cycle.

## Versions

| | |
|---|---|
| Node | 22.23.1 |
| MikroORM | 7.1.12 (also 7.1.11) |
| Driver | `@mikro-orm/sqlite` (code path is in `@mikro-orm/sql`, so all SQL drivers) |

## Regression from v6

The identical script completes on **6.6.14**. v6's `applyJoinedFilters` strips nested filter
conditions and skips the join outright:

```js
// v6 @mikro-orm/knex/query/QueryBuilder.js
for (const key of Object.keys(cond)) {
  if (Utils.isPlainObject(cond[key]) && …) delete cond[key];
}
if (!Utils.hasObjectKeys(cond)) {
  continue;   // nothing left -> skip
}
```

A filter made purely of nested relation conditions is therefore discarded in v6, so no cycle
can form. v7 added, before that stripping:

```js
const criteriaNode = CriteriaNodeFactory.createNode(this.metadata, join.prop.targetMeta.class, cond);
cond = criteriaNode.process(this, { matchPopulateJoins: true, filter: true, … });
```

`ObjectCriteriaNode.process()` reaches `qb.scheduleFilterCheck(path)`, which pushes onto the
array being iterated. Resolving nested filter conditions into real joins looks like a
deliberate improvement over v6 silently dropping them — the issue is only that the new
traversal has no termination condition.

## Running the v6 control

```
cd v6-control && npm install
node --max-old-space-size=256 repro.mjs   # completes, prints "finished, got 0 rows"
```

Same entities and same query; only the MikroORM version differs.

## Notes on the minimal shape

The cycle needs **both** filters to traverse relations. While minimising, two variants did
*not* reproduce:

- `populate: ["deviations"]` instead of a relational `where` — completes (`select-in`
  strategy, so no JOIN and no scheduled filter checks).
- One relation-traversing filter plus one scalar filter — `autoJoinedPaths` grows from 2 to 4
  and then terminates.

So a single relation-traversing filter is safe; a mutual pair is required. Minimum shape is
3 entities and 2 filters.
