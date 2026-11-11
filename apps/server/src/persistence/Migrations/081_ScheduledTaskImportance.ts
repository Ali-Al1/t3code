import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // NULL classifies as routine: existing tasks keep the missed-run skip they had.
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN importance TEXT`;
});
