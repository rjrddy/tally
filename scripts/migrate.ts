import { migrate, pool } from "../src/db.js";
const admin = pool(true);
try {
  await migrate(admin);
  console.log("Isolated Tally schema and least-privilege runtime role ready.");
} finally {
  await admin.end();
}
