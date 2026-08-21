import { EntitySchema, MikroORM } from "@mikro-orm/sqlite";

// Cycle:  ManagementObject 1--* Deviation *--1 DeviationType 1--* Deviation
class ManagementObject {}
class Deviation {}
class DeviationType {}

const ManagementObjectSchema = new EntitySchema({
  class: ManagementObject,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    company: { type: "string" },
    deviations: {
      kind: "1:m",
      entity: () => Deviation,
      mappedBy: "managementObject",
    },
  },
  filters: {
    auth: {
      cond: ({ company }) => ({
        $or: [{ company }, { deviations: { type: { identifier: company } } }],
      }),
      default: true,
    },
  },
});

const DeviationSchema = new EntitySchema({
  class: Deviation,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    managementObject: { kind: "m:1", entity: () => ManagementObject },
    // This M:1 is the edge that closes the cycle.
    type: { kind: "m:1", entity: () => DeviationType },
  },
});

const DeviationTypeSchema = new EntitySchema({
  class: DeviationType,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    identifier: { type: "string" },
    deviations: { kind: "1:m", entity: () => Deviation, mappedBy: "type" },
  },
  filters: {
    // Scopes types through their deviations back to ManagementObject.
    // Purely nested relation conditions - no scalar keys at the top level.
    auth: {
      cond: ({ company }) => ({
        deviations: { managementObject: { company } },
      }),
      default: true,
    },
  },
});

const orm = await MikroORM.init({
  dbName: ":memory:",
  entities: [ManagementObjectSchema, DeviationSchema, DeviationTypeSchema],
  debug: false,
});
await orm.getSchemaGenerator().createSchema();

const em = orm.em.fork();
em.setFilterParams("auth", { company: "acme" });

console.log("running find() with a cyclic filter graph ...");
const res = await em.find(ManagementObject, { deviations: { type: { identifier: "x" } } });
console.log("finished, got", res.length, "rows"); // v6: completes

await orm.close();
