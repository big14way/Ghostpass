import Database from 'better-sqlite3';
import { installPaymentTables, reconcilePayments, fetchReceivedSnapshot } from '../packages/matcher/src/index.ts';
import { FixtureBackend } from '../zwatch/src/fixture.ts';

if (process.env.NODE_ENV === 'production') throw new Error('simulated_payments_in_production');
const db = new Database(':memory:');
try {
  db.exec(`CREATE TABLE checkouts (
    claim_code TEXT PRIMARY KEY, plan TEXT NOT NULL, price_zat INTEGER NOT NULL,
    paid_zat INTEGER NOT NULL DEFAULT 0, min_conf INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT', expires_at INTEGER NOT NULL
  )`);
  const claimCode = 'A'.repeat(26);
  db.prepare('INSERT INTO checkouts(claim_code, plan, price_zat, expires_at) VALUES (?, ?, ?, ?)').run(claimCode, 'monthly', 500000, Date.now() + 3600000);
  installPaymentTables(db);
  const snapshot = process.env.ZWATCH_URL
    ? await fetchReceivedSnapshot(process.env.ZWATCH_URL, 'fixture-merchant', process.env.ZWATCH_API_TOKEN || 'ghostpass-local-demo')
    : await new FixtureBackend('fixtures/watcher.json').received('fixture-merchant', 0);
  console.log('DEV MODE: fixture payments, no real ZEC received.');
  console.log(JSON.stringify(reconcilePayments(db, snapshot, { accountId: 'fixture-merchant', allowFixture: true }), null, 2));
} finally { db.close(); }
