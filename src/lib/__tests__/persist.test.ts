import { describe, it, expect, vi } from "vitest";
import { syncRows, debounce, type Persistable } from "../persist";

/* Minimal Supabase query-builder stub. Records every call so the tests can
 * assert on WHAT was sent, which is the whole point: the bug being guarded
 * against is a delete that should never have been issued. */
function makeStub(opts: { insertIds?: string[]; failOn?: "update" | "insert" | "delete" } = {}) {
  const calls: Array<{ table: string; op: string; payload?: unknown; ids?: string[] }> = [];
  const err = (op: string) => (opts.failOn === op ? { message: `${op} failed` } : null);

  const sb = {
    from(table: string) {
      return {
        update(patch: unknown) {
          return {
            eq(_col: string, id: string) {
              calls.push({ table, op: "update", payload: patch, ids: [id] });
              return Promise.resolve({ error: err("update") });
            },
          };
        },
        insert(payload: unknown[]) {
          return {
            select() {
              calls.push({ table, op: "insert", payload });
              const e = err("insert");
              if (e) return Promise.resolve({ data: null, error: e });
              const ids = opts.insertIds ?? payload.map((_, i) => `new-${i}`);
              return Promise.resolve({ data: ids.map((id) => ({ id })), error: null });
            },
          };
        },
        delete() {
          return {
            in(_col: string, ids: string[]) {
              calls.push({ table, op: "delete", ids });
              return Promise.resolve({ error: err("delete") });
            },
          };
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { sb: sb as any, calls };
}

describe("syncRows — the fix for RFQ saves destroying supplier quotes", () => {
  it("updates existing rows in place and NEVER deletes them", async () => {
    const { sb, calls } = makeStub();
    const rows: Persistable[] = [
      { id: "a", position: 0, material_type: "SS 304" },
      { id: "b", position: 1, material_type: "440C" },
    ];
    const { ids, error } = await syncRows(sb, "rfq_items", rows, ["a", "b"]);

    expect(error).toBeNull();
    expect(ids).toEqual(["a", "b"]); // ids preserved → quote_items FKs survive
    expect(calls.filter((c) => c.op === "delete")).toHaveLength(0);
    expect(calls.filter((c) => c.op === "update")).toHaveLength(2);
  });

  it("does not send the id column inside an insert payload", async () => {
    const { sb, calls } = makeStub({ insertIds: ["fresh"] });
    await syncRows(sb, "rfq_items", [{ position: 0, qty: 3 }], []);
    const ins = calls.find((c) => c.op === "insert")!;
    expect((ins.payload as Array<Record<string, unknown>>)[0]).not.toHaveProperty("id");
  });

  it("deletes ONLY rows the user actually removed", async () => {
    const { sb, calls } = makeStub();
    // 'b' was removed by the user; 'a' kept.
    await syncRows(sb, "rfq_items", [{ id: "a", position: 0 }], ["a", "b"]);
    const del = calls.find((c) => c.op === "delete");
    expect(del?.ids).toEqual(["b"]);
  });

  it("issues deletes LAST, so a failed insert cannot lose existing data", async () => {
    const { sb, calls } = makeStub({ failOn: "insert" });
    const { error } = await syncRows(
      sb, "quotes",
      [{ id: "keep" }, { supplier_name: "New" }],
      ["keep", "gone"]
    );
    expect(error).not.toBeNull();
    // The delete of 'gone' must not have happened — the old code deleted first.
    expect(calls.filter((c) => c.op === "delete")).toHaveLength(0);
  });

  it("returns ids positionally so mixed new/existing rows stay aligned", async () => {
    const { sb } = makeStub({ insertIds: ["n1"] });
    const { ids } = await syncRows(
      sb, "rfq_items",
      [{ id: "x", position: 0 }, { position: 1 }, { id: "y", position: 2 }],
      ["x", "y"]
    );
    expect(ids).toEqual(["x", "n1", "y"]);
  });

  it("errors when the insert returns fewer ids than rows sent", async () => {
    const { sb } = makeStub({ insertIds: ["only-one"] });
    const { error } = await syncRows(sb, "rfq_items", [{ a: 1 }, { a: 2 }], []);
    expect(error?.message).toMatch(/expected 2 inserted rows/);
  });
});

describe("debounce — autosave scheduling", () => {
  it("collapses rapid calls into one, with the latest arguments", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 800);
    d("a"); d("b"); d("c");
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(800);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");
    vi.useRealTimers();
  });

  it("cancel() prevents a pending save (used when switching RFQs)", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 800);
    d("x");
    d.cancel();
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
