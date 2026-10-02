// Storage. DynamoDB in the Lambda, an in-memory twin in tests. One table, string key `pk`, JSON in `d`.
// Conditional writes (`ifStatus`, `ifAbsent`) are what make a replayed checkout buy once.
import { DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand, DeleteItemCommand } from "@aws-sdk/client-dynamodb";

export class ConditionFailed extends Error { constructor(pk) { super(`condition failed for ${pk}`); this.pk = pk; } }

export function memoryStore() {
  const m = new Map();
  return {
    kind: "memory",
    async get(pk) { const v = m.get(pk); return v ? JSON.parse(v.d) : null; },
    async put(pk, kind, obj, { status = "", ifStatus, ifAbsent } = {}) {
      const cur = m.get(pk);
      if (ifAbsent && cur) throw new ConditionFailed(pk);
      if (ifStatus !== undefined && (!cur || ![].concat(ifStatus).includes(cur.status))) throw new ConditionFailed(pk);
      m.set(pk, { kind, status, d: JSON.stringify(obj), ts: Date.now() });
    },
    async list(kind) { return [...m.values()].filter((v) => v.kind === kind).sort((a, b) => b.ts - a.ts).map((v) => JSON.parse(v.d)); },
    async del(pk) { m.delete(pk); },
  };
}

export function dynamoStore(table, region = process.env.AWS_REGION || "us-east-1", client = new DynamoDBClient({ region })) {
  return {
    kind: "dynamodb",
    async get(pk) {
      const r = await client.send(new GetItemCommand({ TableName: table, Key: { pk: { S: pk } }, ConsistentRead: true }));
      return r.Item ? JSON.parse(r.Item.d.S) : null;
    },
    async put(pk, kind, obj, { status = "", ifStatus, ifAbsent, ttlDays } = {}) {
      const item = { pk: { S: pk }, kind: { S: kind }, status: { S: status || "-" }, d: { S: JSON.stringify(obj) }, ts: { N: String(Date.now()) } };
      if (ttlDays) item.ttl = { N: String(Math.floor(Date.now() / 1000) + ttlDays * 86400) };
      const p = { TableName: table, Item: item };
      if (ifAbsent) p.ConditionExpression = "attribute_not_exists(pk)";
      else if (ifStatus !== undefined) {
        const vals = [].concat(ifStatus); p.ExpressionAttributeValues = {}; p.ExpressionAttributeNames = { "#s": "status" };
        p.ConditionExpression = "#s IN (" + vals.map((v, i) => { p.ExpressionAttributeValues[`:s${i}`] = { S: v || "-" }; return `:s${i}`; }).join(",") + ")";
      }
      try { await client.send(new PutItemCommand(p)); }
      catch (e) { if (e.name === "ConditionalCheckFailedException") throw new ConditionFailed(pk); throw e; }
    },
    async list(kind) {
      const out = []; let key;
      do {
        const r = await client.send(new ScanCommand({ TableName: table, FilterExpression: "kind = :k", ExpressionAttributeValues: { ":k": { S: kind } }, ExclusiveStartKey: key }));
        for (const i of r.Items || []) out.push({ ts: Number(i.ts.N), d: JSON.parse(i.d.S) });
        key = r.LastEvaluatedKey;
      } while (key);
      return out.sort((a, b) => b.ts - a.ts).map((x) => x.d);
    },
    async del(pk) { await client.send(new DeleteItemCommand({ TableName: table, Key: { pk: { S: pk } } })); },
  };
}
