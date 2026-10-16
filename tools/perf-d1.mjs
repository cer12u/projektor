// Probe-only binding wrapper. A wave is a set of overlapping D1 calls; the
// wave count estimates the longest sequential dependency chain.
export function countD1(db, clock = () => performance.now()) {
  const raw = new WeakMap();
  const intervals = [];
  const stats = { roundTrips: 0, statements: 0, rowsRead: 0, sequentialWaves: 0 };
  let active = 0;
  async function measure(statements, run) {
    const start = clock();
    if (active === 0) stats.sequentialWaves++;
    active++;
    stats.roundTrips++;
    stats.statements += statements;
    try {
      const result = await run();
      for (const item of Array.isArray(result) ? result : [result])
        stats.rowsRead += Number(item?.meta?.rows_read ?? 0);
      return result;
    } finally {
      intervals.push([start, clock()]);
      active--;
    }
  }
  const binding = {
    prepare(sql) {
      const statement = db.prepare(sql);
      const wrapped = {
        bind(...values) {
          const bound = statement.bind(...values);
          return wrapStatement(bound);
        },
        all() {
          return measure(1, () => statement.all());
        },
        first(column) {
          return measure(1, () => statement.first(column));
        },
        run() {
          return measure(1, () => statement.run());
        },
        raw(options) {
          return measure(1, () => statement.raw(options));
        },
      };
      raw.set(wrapped, statement);
      return wrapped;
    },
    batch(statements) {
      return measure(statements.length, () => db.batch(statements.map((s) => raw.get(s))));
    },
    exec(sql) {
      return measure(1, () => db.exec(sql));
    },
    dump() {
      return db.dump();
    },
  };
  function wrapStatement(statement) {
    const wrapped = {
      bind(...values) {
        return wrapStatement(statement.bind(...values));
      },
      all() {
        return measure(1, () => statement.all());
      },
      first(column) {
        return measure(1, () => statement.first(column));
      },
      run() {
        return measure(1, () => statement.run());
      },
      raw(options) {
        return measure(1, () => statement.raw(options));
      },
    };
    raw.set(wrapped, statement);
    return wrapped;
  }
  return {
    binding,
    reset() {
      stats.roundTrips = 0;
      stats.statements = 0;
      stats.rowsRead = 0;
      stats.sequentialWaves = 0;
      intervals.length = 0;
      active = 0;
    },
    snapshot() {
      const sorted = intervals.toSorted((a, b) => a[0] - b[0]);
      let busyMs = 0,
        end = -Infinity;
      for (const [start, stop] of sorted) {
        busyMs += Math.max(0, stop - Math.max(start, end));
        end = Math.max(end, stop);
      }
      return { ...stats, d1BusyMs: busyMs };
    },
  };
}
