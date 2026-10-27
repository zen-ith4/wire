const tableDefinitions = require('./tables');
const { runMigrations, migrateGroupsCreatedByNullable } = require('./migrations');
const { createIndexes } = require('./indexes');


function ensureSchema(db) {
  db.pragma('foreign_keys = ON');

  // Rebuilds `groups` on databases created before created_by became
  // nullable. Has to run outside the transaction below (it toggles the
  // foreign_keys pragma) — see its comment in migrations.js.
  migrateGroupsCreatedByNullable(db);

  const setup = db.transaction(() => {
    /*
     * Create all base tables first.
     */
    db.exec(
      tableDefinitions.join('\n')
    );

    /*
     * Upgrade existing databases with missing columns.
     */
    runMigrations(db);

    /*
     * Create application indexes.
     */
    createIndexes(db);
  });

  setup();
}


module.exports = {
  ensureSchema
};