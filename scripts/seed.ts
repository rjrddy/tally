import { pool } from "../src/db.js";
import { seed } from "../src/seed.js";
import { Tally } from "../src/service.js";
const db = pool();
try {
  console.log(JSON.stringify(await seed(new Tally(db))));
} finally {
  await db.end();
}
