import fs from 'node:fs';
import path from 'node:path';
import { SQLITE_FILE, STATE_FILE } from './store-state.mjs';

export const MIGRATION_PENDING_MARKER = 'migration-pending.marker';
export const MIGRATION_COMPLETE_MARKER = 'migration-complete.marker';
export const MIGRATION_INCOMPLETE_MARKER = 'migration-incomplete.marker';
export const MIGRATION_SOURCE_DIR = 'migration-source';

/**
 * @param {string} dataDir
 */
export function assertNoPartialMigration(dataDir) {
  const resolved = path.resolve(dataDir);
  const pending = path.join(resolved, MIGRATION_PENDING_MARKER);
  const incomplete = path.join(resolved, MIGRATION_INCOMPLETE_MARKER);
  if (fs.existsSync(pending) || fs.existsSync(incomplete)) {
    throw new Error(
      'Thư mục dữ liệu có migration dở dang (migration-pending / migration-incomplete). ' +
        'Không mở app.sqlite cho đến khi chạy lại migrate-json-to-sqlite sang thư mục mới hoặc khôi phục thủ công.',
    );
  }

  const sqlitePath = path.join(resolved, SQLITE_FILE);
  const complete = path.join(resolved, MIGRATION_COMPLETE_MARKER);
  const migrationSource = path.join(resolved, MIGRATION_SOURCE_DIR, STATE_FILE);
  if (fs.existsSync(sqlitePath) && fs.existsSync(migrationSource) && !fs.existsSync(complete)) {
    throw new Error(
      'Phát hiện app.sqlite + migration-source nhưng thiếu migration-complete.marker — migration chưa hoàn tất. ' +
        'Không dùng thư mục này làm DATA_DIR.',
    );
  }
}
