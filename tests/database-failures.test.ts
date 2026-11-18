import assert from "node:assert/strict";
import net from "node:net";
import test, { type TestContext } from "node:test";
import pg from "pg";
import { Store } from "../src/persistence/store.ts";

type Fault = "blackhole" | "disconnect" | "rollback" | "none";

// A local PostgreSQL wire peer lets the real pg client experience lost replies
// without changing a database, waiting for TCP timeouts, or using production.
async function wireDatabase(t: TestContext, fault: Fault) {
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const packet = (type: string, body: Buffer) => {
    const header = Buffer.alloc(5);
    header[0] = type.charCodeAt(0);
    header.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([header, body]);
  };
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const first = ++connections === 1;
    let startup = true;
    let buffered: Buffer = Buffer.alloc(0);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= (startup ? 4 : 5)) {
        const length = buffered.readInt32BE(startup ? 0 : 1);
        const total = length + (startup ? 0 : 1);
        if (buffered.length < total) return;
        const message = buffered.subarray(0, total);
        buffered = buffered.subarray(total);
        if (startup) {
          startup = false;
          socket.write(
            Buffer.concat([
              packet("R", Buffer.alloc(4)),
              packet("Z", Buffer.from("I")),
            ]),
          );
          continue;
        }
        if (message[0] === 88) {
          socket.end();
          continue;
        }
        if (message[0] !== 81) continue;
        const query = message.subarray(5, -1).toString();
        if (first && fault === "disconnect") {
          socket.destroy();
          return;
        }
        if (
          first &&
          (fault === "blackhole" ||
            (fault === "rollback" && query === "ROLLBACK"))
        )
          continue;
        socket.write(
          Buffer.concat([
            packet("C", Buffer.from(query + "\0")),
            packet("Z", Buffer.from(query === "BEGIN" ? "T" : "I")),
          ]),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const pool = new pg.Pool({
    host: "127.0.0.1",
    port: address.port,
    user: "fixture",
    database: "fixture",
    ssl: false,
    max: 1,
    query_timeout: 100,
    connectionTimeoutMillis: 1000,
    idleTimeoutMillis: 0,
  });
  pool.on("error", () => {});
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await pool.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    store: new Store(pool, undefined, "fixture"),
    pool,
    connections: () => connections,
  };
}

test("query and rollback timeouts discard the blackholed connection so the next transaction runs", async (t) => {
  const { store, connections } = await wireDatabase(t, "blackhole");
  await assert.rejects(store.transaction(async () => {}));
  assert.equal(await store.transaction(async () => "recovered"), "recovered");
  assert.equal(connections(), 2);
});

test("checked-out socket failure rejects the transaction without an unhandled Client error", async (t) => {
  const { store, connections } = await wireDatabase(t, "disconnect");
  await assert.rejects(
    store.transaction(async () => {}),
    {
      message: "Connection terminated unexpectedly",
    },
  );
  assert.equal(await store.transaction(async () => "recovered"), "recovered");
  assert.equal(connections(), 2);
});

test("failed rollback retains the operation error and the rollback error and discards the connection", async (t) => {
  const { store, connections } = await wireDatabase(t, "rollback");
  const original = new Error("operation_failed");
  await assert.rejects(
    store.transaction(async () => {
      throw original;
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, original);
      assert.equal(error.errors[0], original);
      assert.equal(error.errors[1].message, "Query read timeout");
      return true;
    },
  );
  assert.equal(await store.transaction(async () => "recovered"), "recovered");
  assert.equal(connections(), 2);
});

test("successful rollback preserves a business error and reuses the healthy connection", async (t) => {
  const { store, connections } = await wireDatabase(t, "none");
  const original = new Error("business_rule_rejected");
  await assert.rejects(
    store.transaction(async () => {
      throw original;
    }),
    (error) => error === original,
  );
  assert.equal(await store.transaction(async () => "healthy"), "healthy");
  assert.equal(connections(), 1);
});
