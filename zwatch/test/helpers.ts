import Database from 'better-sqlite3';

export function createWalletFixture(path: string): Database.Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE scan_queue(block_range_start INTEGER, block_range_end INTEGER, priority INTEGER);
    INSERT INTO scan_queue VALUES(90, 101, 10);
    CREATE TABLE transactions(id_tx INTEGER PRIMARY KEY, txid BLOB UNIQUE, mined_height INTEGER);
    CREATE TABLE fixture_outputs(txid BLOB, output_pool INTEGER, output_index INTEGER, value INTEGER, memo BLOB, to_account_uuid BLOB, is_change INTEGER);
    CREATE VIEW v_tx_outputs AS SELECT * FROM fixture_outputs;
  `);
  return db;
}
